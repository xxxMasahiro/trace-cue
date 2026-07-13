import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
  stat
} from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_MAX_RECORD_BYTES = 1024 * 1024;
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const MARKER_INITIALIZATION_TIMEOUT_MS = 1000;
const LOCK_POLL_MS = 25;
const SAFE_SEGMENT = /^[a-zA-Z0-9._-]+$/u;

export function createSafeLocalStore({
  workspaceRoot,
  relativeRoot,
  namespace,
  maxRecordBytes = DEFAULT_MAX_RECORD_BYTES,
  maxEntries = 1000
} = {}) {
  const workspace = path.resolve(requireString(workspaceRoot, 'workspaceRoot'));
  const relative = validateRelativePath(relativeRoot, { allowNested: true });
  const storeNamespace = requireString(namespace, 'namespace');
  const root = path.resolve(workspace, relative);
  assertInside(workspace, root);

  async function prepare({ create = false } = {}) {
    const workspaceReal = await realpath(workspace);
    const rootCandidate = path.resolve(workspaceReal, relative);
    let created = false;
    if (create) {
      await ensureDirectoryTree(workspaceReal, path.dirname(relative));
      try {
        await mkdir(rootCandidate, { mode: 0o700 });
        created = true;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
    } else {
      await rejectSymlinkComponents(workspaceReal, relative);
    }
    const rootInfo = await lstat(rootCandidate);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw storeError('SAFE_STORE_DIRECTORY_REJECTED', 'The private store root is unsafe.');
    }
    if (!create && process.platform !== 'win32' && (rootInfo.mode & 0o077) !== 0) {
      throw storeError('SAFE_STORE_PERMISSIONS_REJECTED', 'The private store root is not private.');
    }
    const rootReal = await realpath(rootCandidate);
    assertInside(workspaceReal, rootReal);
    await ensureMarker(rootReal, storeNamespace, { allowCreate: created });
    if (create) await chmod(rootReal, 0o700);
    return { workspaceReal, rootReal };
  }

  return Object.freeze({
    async readJson(relativePath, options = {}) {
      const prepared = await prepare();
      return safeReadJson(prepared.rootReal, relativePath, options.maxBytes ?? maxRecordBytes);
    },
    async writeJson(relativePath, value, options = {}) {
      const prepared = await prepare({ create: true });
      return safeWriteJson(prepared.rootReal, relativePath, value, options.maxBytes ?? maxRecordBytes);
    },
    async listDirectories(options = {}) {
      const prepared = await prepare();
      const limit = Math.min(maxEntries, normalizePositiveInteger(options.limit, maxEntries));
      const entries = await readDirectoryEntriesBounded(prepared.rootReal, { maxEntries: maxEntries + 64 });
      const names = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !SAFE_SEGMENT.test(entry.name)) continue;
        const candidate = path.join(prepared.rootReal, entry.name);
        let info;
        try {
          info = await lstat(candidate);
        } catch (error) {
          if (error?.code === 'ENOENT') continue;
          throw error;
        }
        if (!info.isDirectory() || info.isSymbolicLink()) continue;
        names.push(entry.name);
        if (names.length > maxEntries) {
          throw storeError('SAFE_STORE_ENTRY_LIMIT_EXCEEDED', 'The private store contains too many entries to list safely.');
        }
      }
      return names.slice(0, limit);
    },
    async withLock(lockName, task, options = {}) {
      const prepared = await prepare({ create: true });
      return withFileLock(prepared.rootReal, lockName, task, options);
    },
    async resolvePrivatePath(relativePath, options = {}) {
      const prepared = await prepare({ create: options.ensureParent === true });
      const normalized = validateRelativePath(relativePath, { allowNested: true });
      const target = path.resolve(prepared.rootReal, normalized);
      assertInside(prepared.rootReal, target);
      if (options.ensureParent === true) {
        await ensureDirectoryTree(prepared.rootReal, path.dirname(normalized));
      }
      return target;
    },
    async inspectFile(relativePath, options = {}) {
      const prepared = await prepare();
      return inspectRegularFile(prepared.rootReal, relativePath, options.maxBytes ?? maxRecordBytes);
    },
    async removeFile(relativePath, options = {}) {
      const prepared = await prepare();
      const inspected = await inspectRegularFile(prepared.rootReal, relativePath, options.maxBytes ?? maxRecordBytes);
      await rm(inspected.target);
    },
    async removeDirectory(relativePath, options = {}) {
      const prepared = await prepare();
      const relative = validateRelativePath(relativePath, { allowNested: true });
      await rejectSymlinkComponents(prepared.rootReal, path.dirname(relative));
      const target = path.resolve(prepared.rootReal, relative);
      assertInside(prepared.rootReal, target);
      const info = await lstat(target);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw storeError('SAFE_STORE_DIRECTORY_REJECTED', 'The private store directory is unsafe.');
      }
      const quarantine = path.join(
        path.dirname(target),
        `.${path.basename(target)}.retired-${randomUUID()}`
      );
      await rename(target, quarantine);
      let removable = false;
      try {
        const entries = await readDirectoryEntriesBounded(quarantine, {
          maxEntries: normalizePositiveInteger(options.maxEntries, 32)
        });
        for (const entry of entries) {
          if (!entry.isFile() || entry.isSymbolicLink() || !SAFE_SEGMENT.test(entry.name)) {
            throw storeError('SAFE_STORE_DIRECTORY_REJECTED', 'The private store directory contains unsafe entries.');
          }
          const child = await lstat(path.join(quarantine, entry.name));
          if (!child.isFile() || child.isSymbolicLink() || child.nlink !== 1) {
            throw storeError('SAFE_STORE_DIRECTORY_REJECTED', 'The private store directory contains unsafe records.');
          }
        }
        await rm(quarantine, { recursive: true, force: false });
        removable = true;
        await syncDirectory(path.dirname(target));
      } finally {
        if (!removable) {
          try { await rename(quarantine, target); } catch {}
        }
      }
    }
  });
}

export async function readDirectoryEntriesBounded(directory, { maxEntries } = {}) {
  const limit = normalizePositiveInteger(maxEntries, 1000);
  const entries = [];
  const handle = await opendir(directory);
  try {
    for await (const entry of handle) {
      if (entries.length >= limit) {
        throw storeError('SAFE_STORE_ENTRY_LIMIT_EXCEEDED', 'The private directory contains too many entries to scan safely.');
      }
      entries.push(entry);
    }
  } finally {
    try { await handle.close(); } catch {}
  }
  return entries;
}

async function ensureDirectoryTree(root, relativePath) {
  const relative = relativePath === '.' ? '' : validateRelativePath(relativePath, { allowNested: true, allowEmpty: true });
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw storeError('SAFE_STORE_DIRECTORY_REJECTED', 'The private store contains an unsafe directory component.');
    }
  }
}

async function ensureMarker(root, namespace, { allowCreate = false } = {}) {
  const markerPath = path.join(root, '.trace-cue-store');
  const expected = `${JSON.stringify({ schema_version: '1.0.0', namespace })}\n`;
  if (allowCreate) {
    let handle;
    let complete = false;
    try {
      handle = await open(markerPath, 'wx', 0o600);
      await handle.writeFile(expected, 'utf8');
      await handle.sync();
      complete = true;
      return;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    } finally {
      try { await handle?.close(); } catch {}
      if (handle && !complete) await rm(markerPath, { force: true });
    }
  }
  const deadline = Date.now() + MARKER_INITIALIZATION_TIMEOUT_MS;
  while (true) {
    try {
      const current = await safeReadFile(root, '.trace-cue-store', 4096);
      let parsed;
      try {
        parsed = JSON.parse(current.toString('utf8'));
      } catch {
        if (Date.now() < deadline) {
          await delay(LOCK_POLL_MS);
          continue;
        }
        throw storeError('SAFE_STORE_MARKER_INVALID', 'The private store ownership marker is invalid.');
      }
      if (parsed?.schema_version !== '1.0.0' || parsed?.namespace !== namespace) {
        throw storeError('SAFE_STORE_MARKER_MISMATCH', 'The private store belongs to a different namespace.');
      }
      return;
    } catch (readError) {
      if (readError?.code === 'SAFE_STORE_MARKER_MISMATCH') throw readError;
      if (Date.now() >= deadline) {
        throw storeError(
          readError?.code === 'ENOENT' ? 'SAFE_STORE_MARKER_MISSING' : 'SAFE_STORE_MARKER_INVALID',
          'The existing private store has no valid ownership marker.'
        );
      }
      if (['EACCES', 'EPERM'].includes(readError?.code)) throw readError;
      await delay(LOCK_POLL_MS);
    }
  }
}

async function safeReadJson(root, relativePath, maxBytes) {
  const body = await safeReadFile(root, relativePath, maxBytes);
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw storeError('SAFE_STORE_JSON_INVALID', 'The private store record is not valid JSON.');
  }
}

async function safeReadFile(root, relativePath, maxBytes) {
  const inspected = await inspectRegularFile(root, relativePath, maxBytes);
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(inspected.target, flags);
  try {
    return await readStableBoundedFileHandle(handle, {
      expected: inspected.info,
      maxBytes,
      changedError: () => storeError(
        'SAFE_STORE_FILE_CHANGED',
        'The private store record changed while it was being read.'
      )
    });
  } finally {
    await handle.close();
  }
}

export async function readStableBoundedFileHandle(handle, {
  expected,
  maxBytes,
  changedError
} = {}) {
  const fail = typeof changedError === 'function'
    ? changedError
    : () => storeError('SAFE_STORE_FILE_CHANGED', 'The private store record changed while it was being read.');
  const limit = normalizePositiveInteger(maxBytes, DEFAULT_MAX_RECORD_BYTES);
  const opened = await handle.stat();
  if (!isStableRegularFile(opened, expected, limit)) throw fail();

  const body = Buffer.alloc(opened.size);
  let offset = 0;
  while (offset < body.length) {
    const { bytesRead } = await handle.read(body, offset, body.length - offset, offset);
    if (bytesRead <= 0) throw fail();
    offset += bytesRead;
  }
  const probe = Buffer.alloc(1);
  const { bytesRead: extraBytes } = await handle.read(probe, 0, 1, opened.size);
  if (extraBytes !== 0) throw fail();

  const completed = await handle.stat();
  if (!isStableRegularFile(completed, opened, limit)) throw fail();
  return body;
}

function isStableRegularFile(current, expected, maxBytes) {
  return current.isFile()
    && current.nlink === 1
    && current.size <= maxBytes
    && (!expected || (
      current.dev === expected.dev
      && current.ino === expected.ino
      && current.size === expected.size
      && current.mtimeMs === expected.mtimeMs
      && current.ctimeMs === expected.ctimeMs
    ));
}

async function inspectRegularFile(root, relativePath, maxBytes) {
  const relative = validateRelativePath(relativePath, { allowNested: true });
  await rejectSymlinkComponents(root, path.dirname(relative));
  const target = path.resolve(root, relative);
  assertInside(root, target);
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw storeError('SAFE_STORE_FILE_REJECTED', 'The private store record is not a private regular file.');
  }
  if (info.size > maxBytes) {
    throw storeError('SAFE_STORE_FILE_TOO_LARGE', 'The private store record is too large.');
  }
  const targetReal = await realpath(target);
  assertInside(root, targetReal);
  return { target, targetReal, info };
}

async function safeWriteJson(root, relativePath, value, maxBytes) {
  const relative = validateRelativePath(relativePath, { allowNested: true });
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw storeError('SAFE_STORE_FILE_TOO_LARGE', 'The private store record is too large.');
  }
  const parentRelative = path.dirname(relative);
  await ensureDirectoryTree(root, parentRelative);
  await rejectSymlinkComponents(root, parentRelative);
  const parent = path.resolve(root, parentRelative);
  const parentRealBefore = await realpath(parent);
  assertInside(root, parentRealBefore);
  const target = path.resolve(root, relative);
  assertInside(root, target);
  try {
    const existing = await lstat(target);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) {
      throw storeError('SAFE_STORE_FILE_REJECTED', 'The private store target is unsafe.');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const temporary = path.join(parent, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  let committed = false;
  try {
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
    await handle.close();
    const parentRealAfter = await realpath(parent);
    if (parentRealAfter !== parentRealBefore) {
      throw storeError('SAFE_STORE_DIRECTORY_CHANGED', 'The private store directory changed during the write.');
    }
    await rename(temporary, target);
    committed = true;
    await chmod(target, 0o600);
    await syncDirectory(parent);
    await inspectRegularFile(root, relative, maxBytes);
  } finally {
    try { await handle.close(); } catch {}
    if (!committed) await rm(temporary, { force: true });
  }
  return target;
}

async function withFileLock(root, lockName, task, options) {
  const name = validateLockName(lockName);
  const timeoutMs = normalizePositiveInteger(options.timeoutMs, DEFAULT_LOCK_TIMEOUT_MS);
  const locksRelative = '.locks';
  await ensureDirectoryTree(root, locksRelative);
  const lockPath = path.join(root, locksRelative, `${name}.lock`);
  const deadline = Date.now() + timeoutMs;
  const nonce = randomBytes(32).toString('base64url');
  const owner = {
    schema_version: '1.0.0',
    pid: process.pid,
    process_identity: await captureProcessIdentity(process.pid),
    nonce,
    created_at: new Date().toISOString()
  };

  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw storeError('SAFE_STORE_LOCK_TIMEOUT', 'The private store is busy.');
    }
    const attempt = await withLockTransition(lockPath, async () => {
      try {
        await createOwnedLockFile(lockPath, owner);
        return true;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
      if (!await recoverDeadLock(root, path.relative(root, lockPath))) return false;
      await createOwnedLockFile(lockPath, owner);
      return true;
    }, remainingMs);
    if (attempt.entered && attempt.value === true) break;
    await delay(Math.min(LOCK_POLL_MS, Math.max(1, deadline - Date.now())));
  }

  try {
    return await task();
  } finally {
    const releaseDeadline = Date.now() + timeoutMs;
    let released = false;
    while (true) {
      const remainingMs = releaseDeadline - Date.now();
      if (remainingMs <= 0) break;
      const release = await withLockTransition(lockPath, async () => {
        try {
          const current = await safeReadJson(root, path.relative(root, lockPath), 4096);
          if (current?.nonce === nonce && current?.pid === process.pid) await rm(lockPath);
        } catch {
          // A changed or absent lock is not removed.
        }
        return true;
      }, remainingMs);
      if (release.entered) {
        released = true;
        break;
      }
      await delay(Math.min(LOCK_POLL_MS, Math.max(1, releaseDeadline - Date.now())));
    }
    if (!released) await releaseKnownOwnedLock(root, lockPath, owner);
  }
}

async function releaseKnownOwnedLock(root, lockPath, owner) {
  try {
    const current = await safeReadJson(root, path.relative(root, lockPath), 4096);
    if (current?.nonce !== owner.nonce
      || current?.pid !== owner.pid
      || current?.process_identity !== owner.process_identity) {
      throw storeError('SAFE_STORE_LOCK_RELEASE_REJECTED', 'The private store lock owner changed before release.');
    }
    await rm(lockPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function createOwnedLockFile(lockPath, owner) {
  let handle;
  let complete = false;
  try {
    handle = await open(lockPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
    await handle.sync();
    complete = true;
  } finally {
    try { await handle?.close(); } catch {}
    if (handle && !complete) await rm(lockPath, { force: true });
  }
}

async function withLockTransition(lockPath, task, timeoutMs) {
  if (!await clearLegacyDeadTransition(`${lockPath}.transition`)) return { entered: false, value: null };
  return withCrashSafeTransition({
    directory: path.dirname(lockPath),
    prefix: `${path.basename(lockPath)}.transition-`,
    task,
    timeoutMs
  });
}

export async function withCrashSafeTransition({
  directory,
  prefix,
  task,
  maxEntries = 4096,
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  onPhase
} = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)
    || typeof prefix !== 'string' || !prefix || prefix.includes(path.sep)
    || typeof task !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1
    || (onPhase !== undefined && typeof onPhase !== 'function')) {
    throw new TypeError('Crash-safe transition options are invalid.');
  }
  const deadline = Date.now() + timeoutMs;
  const nonce = randomBytes(32).toString('base64url');
  const transitionPath = path.join(directory, `${prefix}${nonce}`);
  const selecting = {
    schema_version: '1.0.0',
    pid: process.pid,
    process_identity: await captureProcessIdentity(process.pid),
    nonce,
    choosing: true,
    ticket: 0,
    created_at: new Date().toISOString()
  };
  let published = false;
  try {
    await publishTransitionCandidate(directory, transitionPath, selecting);
    published = true;
    await onPhase?.('candidate-created', { nonce });
    const selection = await transitionCandidates(directory, prefix, maxEntries);
    if (selection.blocked) return { entered: false, value: null };
    const highestTicket = selection.records.reduce((maximum, entry) => Math.max(maximum, entry.record.ticket), 0);
    if (!Number.isSafeInteger(highestTicket + 1)) return { entered: false, value: null };
    await replaceTransitionCandidate(transitionPath, {
      ...selecting,
      choosing: false,
      ticket: highestTicket + 1
    });
    while (true) {
      const current = await transitionCandidates(directory, prefix, maxEntries);
      if (current.blocked) return { entered: false, value: null };
      const choosing = current.records
        .filter((entry) => entry.record.nonce !== nonce && entry.record.choosing);
      let liveChoosing = false;
      let recoveredChoosing = false;
      for (const entry of choosing) {
        if (await isProcessIdentityAlive(entry.record)) {
          liveChoosing = true;
          continue;
        }
        recoveredChoosing = await quarantineTransitionCandidate(entry.path, entry.record.nonce, { requireDead: true })
          || recoveredChoosing;
      }
      if (recoveredChoosing) continue;
      const winner = liveChoosing ? null : current.records
        .filter((entry) => !entry.record.choosing)
        .sort((left, right) => left.record.ticket - right.record.ticket
          || left.record.nonce.localeCompare(right.record.nonce))[0];
      if (Date.now() >= deadline) return { entered: false, value: null };
      if (winner?.record.nonce === nonce) return { entered: true, value: await task() };
      if (winner) {
        if (await isProcessIdentityAlive(winner.record)) return { entered: false, value: null };
        if (await quarantineTransitionCandidate(winner.path, winner.record.nonce, { requireDead: true })) continue;
        return { entered: false, value: null };
      }
      await delay(Math.min(LOCK_POLL_MS, Math.max(1, deadline - Date.now())));
    }
  } finally {
    if (published) await quarantineTransitionCandidate(transitionPath, nonce, { requireDead: false });
  }
}

async function publishTransitionCandidate(directory, transitionPath, record) {
  const identityDigest = createHash('sha256').update(record.process_identity ?? 'unavailable').digest('hex').slice(0, 16);
  const pendingPath = path.join(directory, `.transition-pending-${record.pid}-${identityDigest}-${record.nonce}`);
  let handle;
  let published = false;
  try {
    handle = await open(pendingPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(pendingPath, transitionPath);
    published = true;
    await syncDirectory(directory);
  } finally {
    try { await handle?.close(); } catch {}
    if (!published) await rm(pendingPath, { force: true });
  }
}

async function replaceTransitionCandidate(candidatePath, record) {
  const temporary = path.join(path.dirname(candidatePath), `.${path.basename(candidatePath)}.update-${randomUUID()}`);
  let handle;
  let committed = false;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, candidatePath);
    committed = true;
  } finally {
    try { await handle?.close(); } catch {}
    if (!committed) await rm(temporary, { force: true });
  }
}

async function clearLegacyDeadTransition(transitionPath) {
  let inspected;
  try {
    inspected = await inspectTransitionCandidate(transitionPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    return quarantineMalformedTransitionCandidate(transitionPath);
  }
  if (!validTransitionOwner(inspected.record, { requireTicket: false })) {
    return quarantineMalformedTransitionCandidate(transitionPath);
  }
  if (await isProcessIdentityAlive(inspected.record)) return false;
  return quarantineTransitionCandidate(transitionPath, inspected.record.nonce, { requireDead: true });
}

async function transitionCandidates(parent, prefix, maxEntries) {
  let entries;
  try {
    entries = await readDirectoryEntriesBounded(parent, { maxEntries });
  } catch {
    return { blocked: true, records: [] };
  }
  const records = [];
  for (const entry of entries) {
    const pending = /^\.transition-pending-(\d+)-([a-f0-9]{16})-([A-Za-z0-9_-]{32,128})$/u.exec(entry.name);
    if (pending) {
      if (!entry.isFile() || entry.isSymbolicLink()) return { blocked: true, records: [] };
      const pid = Number(pending[1]);
      const identity = Number.isSafeInteger(pid) && pid > 0 ? await captureProcessIdentity(pid) : null;
      const identityDigest = identity === null
        ? null
        : createHash('sha256').update(identity).digest('hex').slice(0, 16);
      if (identityDigest === pending[2] || (identity === null && isProcessAlive(pid))) {
        return { blocked: true, records: [] };
      }
      const pendingPath = path.join(parent, entry.name);
      const before = await lstat(pendingPath);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) return { blocked: true, records: [] };
      await rm(pendingPath);
      continue;
    }
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.startsWith(prefix)) continue;
    const nonce = entry.name.slice(prefix.length);
    if (!/^[A-Za-z0-9_-]{32,128}$/u.test(nonce)) return { blocked: true, records: [] };
    const candidatePath = path.join(parent, entry.name);
    let inspected;
    try {
      inspected = await inspectTransitionCandidate(candidatePath);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      if (await quarantineMalformedTransitionCandidate(candidatePath)) continue;
      return { blocked: true, records: [] };
    }
    if (!validTransitionOwner(inspected.record, { requireTicket: true }) || inspected.record.nonce !== nonce) {
      return { blocked: true, records: [] };
    }
    records.push({ path: candidatePath, record: inspected.record });
  }
  return { blocked: false, records };
}

async function quarantineMalformedTransitionCandidate(candidatePath) {
  let before;
  try {
    before = await lstat(candidatePath);
  } catch (error) {
    return error?.code === 'ENOENT';
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || Date.now() - before.mtimeMs <= MARKER_INITIALIZATION_TIMEOUT_MS) return false;
  const quarantine = path.join(path.dirname(candidatePath), `.malformed-transition-${randomUUID()}`);
  try {
    await rename(candidatePath, quarantine);
    const moved = await lstat(quarantine);
    if (moved.dev !== before.dev || moved.ino !== before.ino) {
      try { await rename(quarantine, candidatePath); } catch {}
      return false;
    }
    await rm(quarantine);
    return true;
  } catch {
    try { await rename(quarantine, candidatePath); } catch {}
    return false;
  }
}

function validTransitionOwner(record, { requireTicket }) {
  return record?.schema_version === '1.0.0'
    && Number.isInteger(Number(record.pid))
    && Number(record.pid) > 0
    && typeof record.nonce === 'string'
    && (!requireTicket || (
      typeof record.choosing === 'boolean'
      && Number.isSafeInteger(record.ticket)
      && (record.choosing ? record.ticket === 0 : record.ticket > 0)
    ));
}

async function inspectTransitionCandidate(candidatePath) {
  const before = await lstat(candidatePath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > 4096) {
    throw storeError('SAFE_STORE_LOCK_REJECTED', 'A private store transition record is unsafe.');
  }
  let record;
  try {
    record = JSON.parse(await readFile(candidatePath, 'utf8'));
  } catch {
    throw storeError('SAFE_STORE_LOCK_REJECTED', 'A private store transition record is invalid.');
  }
  const after = await lstat(candidatePath);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw storeError('SAFE_STORE_LOCK_REJECTED', 'A private store transition record changed during inspection.');
  }
  return { record, info: before };
}

async function quarantineTransitionCandidate(candidatePath, expectedNonce, { requireDead }) {
  const quarantinePath = `${candidatePath}.quarantine-${randomUUID()}`;
  let quarantined = false;
  try {
    const before = await inspectTransitionCandidate(candidatePath);
    if (before.record?.nonce !== expectedNonce) return false;
    await rename(candidatePath, quarantinePath);
    quarantined = true;
    const moved = await inspectTransitionCandidate(quarantinePath);
    if (moved.info.dev !== before.info.dev || moved.info.ino !== before.info.ino
      || moved.record?.nonce !== expectedNonce || (requireDead && await isProcessIdentityAlive(moved.record))) {
      await restoreQuarantinedLock(quarantinePath, candidatePath);
      return false;
    }
    await rm(quarantinePath);
    quarantined = false;
    return true;
  } catch (error) {
    if (quarantined) await restoreQuarantinedLock(quarantinePath, candidatePath);
    return error?.code === 'ENOENT';
  }
}

async function recoverDeadLock(root, relativeLockPath) {
  let record;
  try {
    record = await safeReadJson(root, relativeLockPath, 4096);
  } catch {
    return false;
  }
  const pid = Number(record?.pid);
  if (!Number.isInteger(pid) || pid <= 0 || typeof record?.nonce !== 'string') return false;
  const identity = await captureProcessIdentity(pid);
  if (identity !== null && identity === record.process_identity) return false;
  if (identity === null && isProcessAlive(pid)) return false;
  const lockPath = path.resolve(root, validateRelativePath(relativeLockPath, { allowNested: true }));
  const quarantinePath = `${lockPath}.stale-${randomUUID()}`;
  let quarantined = false;
  try {
    const before = await lstat(lockPath);
    const current = await safeReadJson(root, relativeLockPath, 4096);
    const after = await lstat(lockPath);
    if (before.dev !== after.dev || before.ino !== after.ino || current?.nonce !== record.nonce) return false;
    await rename(lockPath, quarantinePath);
    quarantined = true;
    const moved = await lstat(quarantinePath);
    const movedRelative = path.relative(root, quarantinePath);
    const movedRecord = await safeReadJson(root, movedRelative, 4096);
    if (moved.dev !== before.dev || moved.ino !== before.ino || movedRecord?.nonce !== record.nonce
      || await isProcessIdentityAlive(movedRecord)) {
      await restoreQuarantinedLock(quarantinePath, lockPath);
      return false;
    }
    await rm(quarantinePath);
    quarantined = false;
    return true;
  } catch {
    if (quarantined) await restoreQuarantinedLock(quarantinePath, lockPath);
    return false;
  }
}

async function restoreQuarantinedLock(quarantinePath, lockPath) {
  try {
    await link(quarantinePath, lockPath);
    await rm(quarantinePath);
  } catch {
    // Never replace a lock that appeared while a quarantined inode was checked.
  }
}

export async function captureProcessIdentity(pid = process.pid) {
  if (process.platform !== 'linux') return null;
  try {
    const body = await readFile(`/proc/${pid}/stat`, 'utf8');
    const closing = body.lastIndexOf(')');
    if (closing < 0) return null;
    return body.slice(closing + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

export async function isProcessIdentityAlive(record) {
  const pid = Number(record?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const expected = typeof record?.process_identity === 'string' ? record.process_identity : null;
  const current = await captureProcessIdentity(pid);
  if (expected !== null && current !== null) return expected === current;
  return isProcessAlive(pid);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function rejectSymlinkComponents(root, relativePath) {
  const relative = relativePath === '.' ? '' : validateRelativePath(relativePath, { allowNested: true, allowEmpty: true });
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw storeError('SAFE_STORE_DIRECTORY_REJECTED', 'The private store path contains an unsafe component.');
    }
  }
}

async function syncDirectory(directory) {
  try {
    const handle = await open(directory, fsConstants.O_RDONLY);
    try { await handle.sync(); } finally { await handle.close(); }
  } catch {
    // Some supported platforms do not permit directory fsync.
  }
}

function validateRelativePath(value, { allowNested, allowEmpty = false } = {}) {
  const string = String(value ?? '');
  if (!string && allowEmpty) return '';
  if (!string || path.isAbsolute(string) || string.includes('\0')) {
    throw storeError('SAFE_STORE_PATH_REJECTED', 'The private store path is invalid.');
  }
  const normalized = path.normalize(string);
  const segments = normalized.split(path.sep);
  if (normalized === '.' || segments.some((segment) => !SAFE_SEGMENT.test(segment) || segment === '..')
    || (!allowNested && segments.length !== 1)) {
    throw storeError('SAFE_STORE_PATH_REJECTED', 'The private store path is invalid.');
  }
  return normalized;
}

function validateLockName(value) {
  const name = requireString(value, 'lockName');
  if (!SAFE_SEGMENT.test(name) || name.length > 180) {
    throw storeError('SAFE_STORE_LOCK_REJECTED', 'The private store lock name is invalid.');
  }
  return name;
}

function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required.`);
  return value.trim();
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value ?? fallback);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function assertInside(root, target) {
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw storeError('SAFE_STORE_PATH_REJECTED', 'The private store path escaped its workspace.');
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function storeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
