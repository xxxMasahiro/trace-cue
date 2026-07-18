import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readFile,
  realpath,
  rename,
  rmdir,
  unlink
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PRODUCT_IDENTITY } from './product-identity.js';
import { loadMediaReviewPolicy } from './media-review-policy.js';
import { captureProcessIdentity } from './safe-local-store.js';

export const MEDIA_PRIVATE_OPERATION_MARKER = '.media-review-operation.json';
export const MEDIA_PRIVATE_OPERATION_SCHEMA_VERSION = '1.0.0';

const OPERATION_ID = /^[a-f0-9]{32}$/u;
const MARKER_MAX_BYTES = 16 * 1024;
const CLEANUP_TOMBSTONE_DIRECTORY = '.media-review-cleanup-receipts';
const CLEANUP_TOMBSTONE_MAX_BYTES = 16 * 1024;
const STATE_TRANSITIONS = Object.freeze({
  prepared: new Set(['running', 'cancelled', 'failed', 'interrupted']),
  running: new Set(['cancelling', 'completed', 'completed_retained', 'failed', 'interrupted', 'cleanup_required']),
  cancelling: new Set(['cancelled', 'failed', 'interrupted', 'cleanup_required']),
  cancelled: new Set(['cleanup_required']),
  completed: new Set(['cleanup_required']),
  completed_retained: new Set(['cleanup_required']),
  failed: new Set(['cleanup_required']),
  interrupted: new Set(['cleanup_required']),
  cleanup_required: new Set([])
});

export async function createPrivateMediaOperation(input = {}, context = {}) {
  const policy = await loadMediaReviewPolicy(context);
  const operationId = OPERATION_ID.test(input.operationId ?? '') ? input.operationId : randomBytes(16).toString('hex');
  const retention = policy.retention.allowed_modes.includes(input.retention)
    ? input.retention
    : policy.retention.default_mode;
  const base = await resolvePrivateBase(retention, context);
  await assertOperationIdAvailable(base, operationId);
  const root = await mkdtemp(path.join(base, `${operationId.slice(0, 12)}-`));
  await chmod(root, 0o700);
  const rootInfo = await assertPrivateDirectory(root);
  const now = materializeNow(context.now);
  const ttl = retention === 'project-retained'
    ? policy.retention.project_retained_ttl_ms
    : policy.retention.ephemeral_ttl_ms;
  const marker = {
    schema_version: MEDIA_PRIVATE_OPERATION_SCHEMA_VERSION,
    type: 'media_review_private_operation',
    operation_id: operationId,
    retention,
    state: 'prepared',
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttl).toISOString(),
    cleanup_owner: PRODUCT_IDENTITY.packageName,
    root_identity: rootIdentity(operationId, rootInfo),
    lease: null,
    provider_run_relative: null,
    limitations: [
      'same_uid_hostile_concurrency_out_of_scope',
      'mount_namespace_attacks_out_of_scope'
    ],
    body_included: false
  };
  await writePrivateMarker(root, marker);
  return {
    operationId,
    retention,
    base,
    root,
    rootIdentity: marker.root_identity,
    device: rootInfo.dev.toString(),
    inode: rootInfo.ino.toString(),
    marker
  };
}

export async function readPrivateMediaOperation(locator, context = {}) {
  validateLocator(locator);
  const baseInfo = await assertPrivateDirectory(locator.base);
  const rootInfo = await assertPrivateDirectory(locator.root);
  if (path.dirname(locator.root) !== locator.base
    || baseInfo.dev !== rootInfo.dev
    || rootInfo.dev.toString() !== locator.device
    || rootInfo.ino.toString() !== locator.inode
    || rootIdentity(locator.operationId, rootInfo) !== locator.rootIdentity) {
    throw privateOperationError('MEDIA_PRIVATE_OPERATION_IDENTITY_CHANGED', 'The private media operation identity changed.');
  }
  const marker = await readMarker(locator.root);
  validateMarker(marker, locator, context);
  return { ...locator, marker, rootInfo };
}

export async function updatePrivateMediaOperation(locator, changes = {}, context = {}) {
  const current = await readPrivateMediaOperation(locator, context);
  const allowedStates = new Set(['prepared', 'running', 'cancelling', 'cancelled', 'completed', 'completed_retained', 'failed', 'interrupted', 'cleanup_required']);
  const state = changes.state ?? current.marker.state;
  if (!allowedStates.has(state)) throw privateOperationError('MEDIA_PRIVATE_OPERATION_STATE_INVALID', 'The private media operation state is invalid.');
  if (state !== current.marker.state && !STATE_TRANSITIONS[current.marker.state]?.has(state)) {
    throw privateOperationError('MEDIA_PRIVATE_OPERATION_TRANSITION_INVALID', 'The private media operation state transition is invalid.');
  }
  const marker = {
    ...current.marker,
    state,
    updated_at: materializeNow(context.now).toISOString(),
    lease: changes.lease === undefined ? current.marker.lease : await sanitizeLease(changes.lease, context),
    provider_run_relative: changes.providerRunRelative === undefined
      ? current.marker.provider_run_relative
      : sanitizeRelativeChild(changes.providerRunRelative),
    media_identity: changes.mediaIdentity === undefined
      ? current.marker.media_identity
      : sanitizeMediaIdentity(changes.mediaIdentity)
  };
  await writePrivateMarker(current.root, marker, { replace: true });
  return { ...current, marker };
}

export async function inspectPrivateMediaTree(locator, context = {}) {
  const policy = await loadMediaReviewPolicy(context);
  const current = await readPrivateMediaOperation(locator, context);
  const totals = { fileCount: 0, directoryCount: 1, byteCount: 0 };
  await inspectDirectory(current.root, 0, totals, policy.operation);
  return { ...current, totals };
}

export async function cleanupPrivateMediaOperation(locator, options = {}, context = {}) {
  validateLocator(locator);
  const now = materializeNow(context.now);
  let current;
  try {
    current = await inspectPrivateMediaTree(locator, context);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'MEDIA_PRIVATE_OPERATION_UNAVAILABLE') {
      return cleanupReceipt(locator, 'already_cleaned', options.reason ?? 'explicit_cleanup', now, { fileCount: 0, directoryCount: 0, byteCount: 0 });
    }
    throw error;
  }
  if (current.marker.retention === 'project-retained' && options.allowRetained !== true) {
    return cleanupReceipt(locator, 'refused', options.reason ?? 'retained_operation_requires_explicit_cleanup', now, current.totals);
  }
  if (current.marker.lease !== null && options.allowLive !== true) {
    return cleanupReceipt(locator, 'refused', 'live_operation_cleanup_refused', now, current.totals);
  }
  const quarantine = path.join(locator.base, `.cleanup-${locator.operationId}-${randomBytes(8).toString('hex')}`);
  await rename(locator.root, quarantine);
  const quarantineLocator = { ...locator, root: quarantine };
  try {
    const revalidated = await inspectPrivateMediaTree(quarantineLocator, context);
    if (revalidated.marker.root_identity !== locator.rootIdentity) throw privateOperationError('MEDIA_PRIVATE_OPERATION_IDENTITY_CHANGED', 'The private media operation identity changed during cleanup.');
    await removeOwnedPrivateTree(quarantine, context);
    return cleanupReceipt(locator, 'cleaned', options.reason ?? 'explicit_cleanup', now, revalidated.totals);
  } catch (error) {
    try { await rename(quarantine, locator.root); } catch {}
    throw privateOperationError('MEDIA_PRIVATE_OPERATION_CLEANUP_FAILED', 'The private media operation could not be cleaned safely.', error?.code);
  }
}

export function projectPrivateMediaOperation(locator, marker) {
  return {
    operation_id: locator.operationId,
    retention: marker.retention,
    state: marker.state,
    created_at: marker.created_at,
    updated_at: marker.updated_at,
    expires_at: marker.expires_at,
    identity: marker.root_identity,
    boundary: {
      absolute_path_included: false,
      raw_media_included: false,
      full_transcript_included: false,
      private_locator_included: false
    }
  };
}

async function resolvePrivateBase(retention, context) {
  const candidate = privateBaseCandidate(retention, context);
  if (!path.isAbsolute(candidate) || candidate.includes('\u0000')) throw privateOperationError('MEDIA_PRIVATE_BASE_INVALID', 'The private media root is invalid.');
  // Validate the intended location before creating anything. This prevents a
  // rejected Git-contained or symlink-ancestor path from leaving directories
  // behind as a validation side effect.
  await assertOutsideGit(candidate);
  const missing = [];
  let existing = candidate;
  while (true) {
    try {
      const info = await lstat(existing, { bigint: true });
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(existing) !== existing) {
        throw privateOperationError('MEDIA_PRIVATE_BASE_ANCESTOR_INVALID', 'The private media root has an unsafe ancestor.');
      }
      break;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw privateOperationError('MEDIA_PRIVATE_BASE_INVALID', 'The private media root is unavailable.');
      missing.push(path.basename(existing));
      existing = parent;
    }
  }
  await assertNoSymlinkAncestors(existing);
  let current = existing;
  for (const segment of missing.reverse()) {
    current = path.join(current, segment);
    let created = false;
    try {
      await mkdir(current, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    if (created) await chmod(current, 0o700);
    await assertPrivateDirectory(current);
    await assertOutsideGit(current);
  }
  await assertPrivateDirectory(candidate);
  await assertOutsideGit(candidate);
  return candidate;
}

async function assertNoSymlinkAncestors(directory) {
  const parts = path.resolve(directory).split(path.sep).filter(Boolean);
  let current = path.parse(directory).root;
  for (const part of parts) {
    current = path.join(current, part);
    const info = await lstat(current, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(current) !== current) {
      throw privateOperationError('MEDIA_PRIVATE_BASE_ANCESTOR_INVALID', 'The private media root has an unsafe ancestor.');
    }
  }
}

export async function findPrivateMediaOperation(operationId, retention, context = {}) {
  if (!OPERATION_ID.test(operationId ?? '') || !['ephemeral', 'project-retained'].includes(retention)) {
    throw privateOperationError('MEDIA_PRIVATE_OPERATION_LOOKUP_INVALID', 'The private media operation lookup is invalid.');
  }
  const base = privateBaseCandidate(retention, context);
  await assertPrivateDirectory(base);
  await assertOutsideGit(base);
  const entries = await readBoundedEntries(base, 1000);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith(`${operationId.slice(0, 12)}-`)) continue;
    const root = path.join(base, entry.name);
    try {
      const info = await assertPrivateDirectory(root);
      const marker = await readMarker(root);
      if (marker.operation_id !== operationId || marker.retention !== retention) continue;
      const locator = {
        operationId,
        retention,
        base,
        root,
        rootIdentity: marker.root_identity,
        device: info.dev.toString(),
        inode: info.ino.toString(),
        marker
      };
      return await readPrivateMediaOperation(locator, context);
    } catch (error) {
      if (error?.code === 'MEDIA_PRIVATE_OPERATION_MARKER_MISMATCH') continue;
      throw error;
    }
  }
  throw privateOperationError('MEDIA_PRIVATE_OPERATION_NOT_FOUND', 'The private media operation was not found.');
}

export async function readPrivateMediaCleanupTombstone(operationId, retention, context = {}) {
  validateCleanupLookup(operationId, retention);
  const base = privateBaseCandidate(retention, context);
  const directory = path.join(base, CLEANUP_TOMBSTONE_DIRECTORY);
  const file = path.join(directory, `${operationId}.json`);
  let info;
  try {
    await assertPrivateDirectory(base);
    await assertPrivateDirectory(directory);
    info = await lstat(file, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'MEDIA_PRIVATE_OPERATION_UNAVAILABLE') return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || Number(info.mode & 0o777n) !== 0o600 || info.size > BigInt(CLEANUP_TOMBSTONE_MAX_BYTES)) {
    throw privateOperationError('MEDIA_PRIVATE_CLEANUP_TOMBSTONE_INVALID', 'The private cleanup receipt record is invalid.');
  }
  if (typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid())) {
    throw privateOperationError('MEDIA_PRIVATE_CLEANUP_TOMBSTONE_INVALID', 'The private cleanup receipt record has an unexpected owner.');
  }
  let value;
  try { value = JSON.parse(await readFile(file, 'utf8')); } catch {
    throw privateOperationError('MEDIA_PRIVATE_CLEANUP_TOMBSTONE_INVALID', 'The private cleanup receipt record is invalid.');
  }
  if (!validCleanupTombstone(value, operationId, retention)) {
    throw privateOperationError('MEDIA_PRIVATE_CLEANUP_TOMBSTONE_INVALID', 'The private cleanup receipt record is invalid.');
  }
  return value;
}

export async function writePrivateMediaCleanupTombstone(value, context = {}) {
  if (!validCleanupTombstone(value, value?.operation_id, value?.retention)) {
    throw privateOperationError('MEDIA_PRIVATE_CLEANUP_TOMBSTONE_INVALID', 'The private cleanup receipt record is invalid.');
  }
  const base = await resolvePrivateBase(value.retention, context);
  const directory = path.join(base, CLEANUP_TOMBSTONE_DIRECTORY);
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  await assertPrivateDirectory(directory);
  const finalPath = path.join(directory, `${value.operation_id}.json`);
  const body = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(body) > CLEANUP_TOMBSTONE_MAX_BYTES) {
    throw privateOperationError('MEDIA_PRIVATE_CLEANUP_TOMBSTONE_INVALID', 'The private cleanup receipt record is too large.');
  }
  const temporary = path.join(directory, `.${value.operation_id}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
  try { await handle.writeFile(body, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, finalPath);
  await chmod(finalPath, 0o600);
  return value;
}

export async function reconcilePrivateMediaOperations(context = {}) {
  const policy = await loadMediaReviewPolicy(context);
  const now = materializeNow(context.now);
  const records = [];
  for (const retention of policy.retention.allowed_modes) {
    const base = privateBaseCandidate(retention, context);
    let entries;
    try {
      await assertPrivateDirectory(base);
      await assertOutsideGit(base);
      entries = await readBoundedEntries(base, 1000);
    } catch (error) {
      if (error?.code === 'MEDIA_PRIVATE_OPERATION_UNAVAILABLE') continue;
      throw error;
    }
    for (const entry of entries) {
      const normalEntry = /^[a-f0-9]{12}-/u.test(entry.name);
      const quarantineMatch = /^\.cleanup-([a-f0-9]{32})-[a-f0-9]{16}$/u.exec(entry.name);
      if (!entry.isDirectory() || entry.isSymbolicLink() || (!normalEntry && !quarantineMatch)) continue;
      const root = path.join(base, entry.name);
      try {
        const info = await assertPrivateDirectory(root);
        const marker = await readMarker(root);
        if (!OPERATION_ID.test(marker.operation_id ?? '')
          || marker.retention !== retention
          || (quarantineMatch && quarantineMatch[1] !== marker.operation_id)) continue;
        let locator = {
          operationId: marker.operation_id,
          retention,
          base,
          root,
          rootIdentity: marker.root_identity,
          device: info.dev.toString(),
          inode: info.ino.toString(),
          marker
        };
        locator = await readPrivateMediaOperation(locator, context);
        let action = quarantineMatch ? 'cleanup_recovery_detected' : 'none';
        if (locator.marker.state === 'prepared' && context.reconcilePreparedMediaOperations === true) {
          locator = await updatePrivateMediaOperation(locator, { state: 'interrupted', lease: null }, context);
          action = 'marked_interrupted';
        } else if (['running', 'cancelling', 'cleanup_required'].includes(locator.marker.state)
          && locator.marker.lease !== null
          && !await mediaLeaseIsAlive(locator.marker.lease, context)) {
          if (locator.marker.state === 'cleanup_required') {
            locator = await updatePrivateMediaOperation(locator, { lease: null }, context);
            action = 'released_stale_cleanup_lease';
          } else {
            locator = await updatePrivateMediaOperation(locator, { state: 'interrupted', lease: null }, context);
            action = 'marked_interrupted';
          }
        }
        const expired = Date.parse(locator.marker.expires_at) <= now.getTime();
        let receipt = null;
        const cleanupInterrupted = context.cleanupInterruptedEphemeral === true && locator.marker.state === 'interrupted';
        const recoverQuarantine = Boolean(quarantineMatch) && locator.marker.lease === null;
        if ((expired || cleanupInterrupted || recoverQuarantine) && locator.marker.lease === null) {
          receipt = await cleanupPrivateMediaOperation(locator, {
            reason: recoverQuarantine
              ? 'crash_cleanup_reconciliation'
              : cleanupInterrupted
                ? 'interrupted_ephemeral_reconciliation'
                : 'expired_private_operation_reconciliation',
            allowRetained: retention === 'project-retained'
          }, context);
          action = receipt.status === 'cleaned'
            ? (recoverQuarantine ? 'completed_crash_cleanup' : cleanupInterrupted ? 'cleaned_interrupted' : 'cleaned_expired')
            : action;
        }
        records.push({
          operation_id: locator.operationId,
          retention,
          state: locator.marker.state,
          expired,
          action,
          cleanup_receipt: receipt,
          boundary: { absolute_path_included: false, private_locator_included: false }
        });
      } catch (error) {
        records.push({
          operation_id: null,
          retention,
          state: 'invalid',
          expired: false,
          action: 'refused_invalid_entry',
          error: error?.code ?? 'MEDIA_PRIVATE_OPERATION_RECONCILIATION_FAILED',
          boundary: { absolute_path_included: false, private_locator_included: false }
        });
      }
    }
  }
  return {
    schema_version: MEDIA_PRIVATE_OPERATION_SCHEMA_VERSION,
    type: 'media_review_reconciliation',
    reconciled_at: now.toISOString(),
    records,
    boundary: { absolute_paths_included: false, private_locators_included: false, unrelated_files_deleted: false }
  };
}

async function assertOperationIdAvailable(base, operationId) {
  try {
    await lstat(path.join(base, CLEANUP_TOMBSTONE_DIRECTORY, `${operationId}.json`));
    throw privateOperationError('MEDIA_PRIVATE_OPERATION_ID_CONFLICT', 'The private media operation identifier is already in use.');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const entries = await readBoundedEntries(base, 1000);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (!entry.name.startsWith(`${operationId.slice(0, 12)}-`) && !entry.name.startsWith(`.cleanup-${operationId}-`)) continue;
    try {
      const marker = await readMarker(path.join(base, entry.name));
      if (marker.operation_id === operationId) {
        throw privateOperationError('MEDIA_PRIVATE_OPERATION_ID_CONFLICT', 'The private media operation identifier is already in use.');
      }
    } catch (error) {
      if (error?.code === 'MEDIA_PRIVATE_OPERATION_ID_CONFLICT') throw error;
      if (error?.code !== 'ENOENT' && error?.code !== 'MEDIA_PRIVATE_OPERATION_MARKER_INVALID') throw error;
    }
  }
}

function validateCleanupLookup(operationId, retention) {
  if (!OPERATION_ID.test(operationId ?? '') || !['ephemeral', 'project-retained'].includes(retention)) {
    throw privateOperationError('MEDIA_PRIVATE_OPERATION_LOOKUP_INVALID', 'The private cleanup receipt lookup is invalid.');
  }
}

function validCleanupTombstone(value, operationId, retention) {
  const tombstoneKeys = ['schema_version', 'type', 'operation_id', 'retention', 'status', 'identity', 'updated_at', 'receipt', 'body_included'];
  if (!value || value.schema_version !== '1.0.0' || value.type !== 'media_review_cleanup_tombstone'
    || !OPERATION_ID.test(operationId ?? '') || value.operation_id !== operationId
    || !['ephemeral', 'project-retained'].includes(retention) || value.retention !== retention
    || !['pending', 'completed'].includes(value.status)
    || !/^[a-f0-9]{64}$/u.test(value.identity ?? '')
    || !Number.isFinite(Date.parse(value.updated_at))
    || Object.keys(value).length !== tombstoneKeys.length
    || !Object.keys(value).every((key) => tombstoneKeys.includes(key))
    || value.body_included !== false) return false;
  if (value.status === 'pending') return value.receipt === null;
  return validStoredCleanupReceipt(value.receipt, operationId, retention, value.identity);
}

function validStoredCleanupReceipt(receipt, operationId, retention, identity) {
  const receiptKeys = ['schema_version', 'type', 'operation_id', 'status', 'retention', 'reason', 'completed_at', 'deleted', 'identity', 'limitations', 'boundary'];
  const deletedKeys = ['file_count', 'directory_count', 'byte_count'];
  const boundaryKeys = ['absolute_path_included', 'raw_media_included', 'full_transcript_included', 'sibling_deleted', 'normal_artifact_root_deleted'];
  return Boolean(receipt)
    && receipt.type === 'media_cleanup_receipt'
    && receipt.schema_version === '1.0.0'
    && receipt.operation_id === operationId
    && ['cleaned', 'already_cleaned'].includes(receipt.status)
    && receipt.retention === retention
    && receipt.identity === identity
    && typeof receipt.reason === 'string'
    && safeTombstoneText(receipt.reason, 200)
    && Number.isFinite(Date.parse(receipt.completed_at))
    && receipt.deleted && Object.keys(receipt.deleted).length === deletedKeys.length
    && Object.keys(receipt.deleted).every((key) => deletedKeys.includes(key))
    && deletedKeys.every((key) => Number.isSafeInteger(receipt.deleted[key]) && receipt.deleted[key] >= 0)
    && Array.isArray(receipt.limitations)
    && receipt.limitations.length <= 32
    && receipt.limitations.every((item) => safeTombstoneText(item, 200))
    && receipt.boundary && Object.keys(receipt.boundary).length === boundaryKeys.length
    && Object.keys(receipt.boundary).every((key) => boundaryKeys.includes(key))
    && boundaryKeys.every((key) => receipt.boundary[key] === false)
    && Object.keys(receipt).length === receiptKeys.length
    && Object.keys(receipt).every((key) => receiptKeys.includes(key));
}

function safeTombstoneText(value, maximum) {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && !value.startsWith('/')
    && !/^[A-Za-z]:[\\/]/u.test(value)
    && !/^file:/iu.test(value);
}

function privateBaseCandidate(retention, context) {
  const explicit = retention === 'project-retained' ? context.retainedMediaRoot : context.ephemeralMediaRoot;
  if (explicit) return path.resolve(explicit);
  if (retention === 'project-retained') {
    const dataHome = process.env.XDG_DATA_HOME
      ? path.resolve(process.env.XDG_DATA_HOME)
      : path.join(os.homedir(), '.local', 'share');
    return path.join(dataHome, PRODUCT_IDENTITY.packageName, 'private-media-review');
  }
  const stateHome = process.env.XDG_STATE_HOME
    ? path.resolve(process.env.XDG_STATE_HOME)
    : path.join(os.homedir(), '.local', 'state');
  return path.join(stateHome, PRODUCT_IDENTITY.packageName, 'private-media-review-ephemeral');
}

function pidIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function mediaLeaseIsAlive(lease, context) {
  if (!validStoredLease(lease) || lease === null) return false;
  if (lease.containment_unconfirmed === true) {
    const captureBoot = context.captureMediaBootIdentity ?? captureLinuxBootIdentity;
    const currentBoot = await Promise.resolve().then(() => captureBoot()).catch(() => null);
    // Unknown detached descendants cannot be proven dead by a Control Center
    // process restart. Only a different Linux/WSL boot identity releases this
    // conservative lease automatically.
    if (typeof lease.boot_identity !== 'string' || typeof currentBoot !== 'string') return true;
    return lease.boot_identity === currentBoot;
  }
  const capture = context.captureMediaProcessIdentity ?? captureProcessIdentity;
  const current = await Promise.resolve()
    .then(() => capture(lease.pid))
    .catch(() => null);
  if (typeof lease.process_identity === 'string' && typeof current === 'string') {
    return lease.process_identity === current;
  }
  // Old markers and platforms without a process start identity retain the
  // previous conservative liveness fallback for backward compatibility.
  return pidIsAlive(lease.pid);
}

async function assertPrivateDirectory(directory) {
  let info;
  try { info = await lstat(directory, { bigint: true }); } catch (error) { throw privateOperationError('MEDIA_PRIVATE_OPERATION_UNAVAILABLE', 'The private media operation is unavailable.', error?.code); }
  if (!info.isDirectory() || info.isSymbolicLink() || Number(info.mode & 0o777n) !== 0o700) {
    throw privateOperationError('MEDIA_PRIVATE_DIRECTORY_INVALID', 'The private media directory is invalid.');
  }
  if (typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid())) {
    throw privateOperationError('MEDIA_PRIVATE_DIRECTORY_OWNER_INVALID', 'The private media directory owner is invalid.');
  }
  if (await realpath(directory) !== directory) throw privateOperationError('MEDIA_PRIVATE_DIRECTORY_REALPATH_INVALID', 'The private media directory path is not stable.');
  return info;
}

async function assertOutsideGit(directory) {
  let current = directory;
  while (true) {
    try {
      const git = await lstat(path.join(current, '.git'));
      if (git.isFile() || git.isSymbolicLink()) {
        throw privateOperationError('MEDIA_PRIVATE_ROOT_INSIDE_GIT', 'The private media root must be outside Git worktrees.');
      }
      if (git.isDirectory()) {
        try {
          const head = await lstat(path.join(current, '.git', 'HEAD'));
          if (head.isFile() || head.isSymbolicLink()) {
            throw privateOperationError('MEDIA_PRIVATE_ROOT_INSIDE_GIT', 'The private media root must be outside Git worktrees.');
          }
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function inspectDirectory(directory, depth, totals, limits) {
  if (depth > limits.maximum_private_tree_depth) throw privateOperationError('MEDIA_PRIVATE_TREE_DEPTH_EXCEEDED', 'The private media operation tree is too deep.');
  const handle = await opendir(directory);
  for await (const entry of handle) {
    totals.fileCount += entry.isFile() ? 1 : 0;
    totals.directoryCount += entry.isDirectory() ? 1 : 0;
    if (totals.fileCount + totals.directoryCount > limits.maximum_private_tree_entries) {
      throw privateOperationError('MEDIA_PRIVATE_TREE_ENTRY_LIMIT', 'The private media operation tree contains too many entries.');
    }
    const target = path.join(directory, entry.name);
    const info = await lstat(target, { bigint: true });
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
      throw privateOperationError('MEDIA_PRIVATE_TREE_TYPE_INVALID', 'The private media operation tree contains an unsupported entry.');
    }
    if (typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid())) {
      throw privateOperationError('MEDIA_PRIVATE_TREE_OWNER_INVALID', 'The private media operation tree contains an unexpected owner.');
    }
    if (info.isFile()) {
      if (info.nlink !== 1n || Number(info.mode & 0o777n) !== 0o600) throw privateOperationError('MEDIA_PRIVATE_TREE_FILE_INVALID', 'The private media operation tree contains an unsafe file.');
      totals.byteCount += Number(info.size);
      if (totals.byteCount > limits.maximum_private_tree_bytes) throw privateOperationError('MEDIA_PRIVATE_TREE_BYTE_LIMIT', 'The private media operation tree is too large.');
    } else {
      if (Number(info.mode & 0o777n) !== 0o700) throw privateOperationError('MEDIA_PRIVATE_TREE_DIRECTORY_INVALID', 'The private media operation tree contains an unsafe directory.');
      await inspectDirectory(target, depth + 1, totals, limits);
    }
  }
}

async function removeOwnedPrivateTree(root, context = {}) {
  async function removeDirectoryContents(directory, isRoot) {
    const handle = await opendir(directory);
    const entries = [];
    for await (const entry of handle) entries.push(entry);
    // The ownership marker is deliberately removed last. If the process
    // crashes mid-cleanup, reconciliation can still authenticate and resume
    // the quarantined tree instead of orphaning private payloads.
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (isRoot && entry.name === MEDIA_PRIVATE_OPERATION_MARKER) continue;
      const target = path.join(directory, entry.name);
      const info = await lstat(target, { bigint: true });
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
        throw privateOperationError('MEDIA_PRIVATE_TREE_TYPE_INVALID', 'The private media operation tree changed during cleanup.');
      }
      if (typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid())) {
        throw privateOperationError('MEDIA_PRIVATE_TREE_OWNER_INVALID', 'The private media operation tree changed owner during cleanup.');
      }
      if (info.isDirectory()) {
        await removeDirectoryContents(target, false);
        await rmdir(target);
      } else {
        await unlink(target);
      }
      await context.onPrivateMediaCleanupEntryRemoved?.({ is_root: isRoot, entry_type: info.isDirectory() ? 'directory' : 'file' });
    }
  }
  await removeDirectoryContents(root, true);
  const markerPath = path.join(root, MEDIA_PRIVATE_OPERATION_MARKER);
  const markerInfo = await lstat(markerPath, { bigint: true });
  if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.nlink !== 1n || Number(markerInfo.mode & 0o777n) !== 0o600) {
    throw privateOperationError('MEDIA_PRIVATE_OPERATION_MARKER_INVALID', 'The private operation marker changed during cleanup.');
  }
  await unlink(markerPath);
  await rmdir(root);
}

async function readBoundedEntries(directory, maximum) {
  const entries = [];
  const handle = await opendir(directory);
  for await (const entry of handle) {
    entries.push(entry);
    if (entries.length > maximum) {
      throw privateOperationError('MEDIA_PRIVATE_OPERATION_LOOKUP_LIMIT', 'The private media operation root contains too many entries.');
    }
  }
  return entries;
}

async function readMarker(root) {
  const markerPath = path.join(root, MEDIA_PRIVATE_OPERATION_MARKER);
  const info = await lstat(markerPath, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || Number(info.mode & 0o777n) !== 0o600 || info.size > BigInt(MARKER_MAX_BYTES)) {
    throw privateOperationError('MEDIA_PRIVATE_OPERATION_MARKER_INVALID', 'The private media operation marker is invalid.');
  }
  let marker;
  try { marker = JSON.parse(await readFile(markerPath, 'utf8')); } catch { throw privateOperationError('MEDIA_PRIVATE_OPERATION_MARKER_INVALID', 'The private media operation marker is invalid.'); }
  return marker;
}

async function writePrivateMarker(root, marker, options = {}) {
  const finalPath = path.join(root, MEDIA_PRIVATE_OPERATION_MARKER);
  const body = `${JSON.stringify(marker, null, 2)}\n`;
  if (Buffer.byteLength(body) > MARKER_MAX_BYTES) throw privateOperationError('MEDIA_PRIVATE_OPERATION_MARKER_TOO_LARGE', 'The private media operation marker is too large.');
  if (!options.replace) {
    const handle = await open(finalPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    try { await handle.writeFile(body, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    return;
  }
  const temporary = path.join(root, `.${MEDIA_PRIVATE_OPERATION_MARKER}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
  try { await handle.writeFile(body, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, finalPath);
  await chmod(finalPath, 0o600);
}

function validateMarker(marker, locator) {
  if (marker?.schema_version !== MEDIA_PRIVATE_OPERATION_SCHEMA_VERSION
    || marker?.type !== 'media_review_private_operation'
    || marker?.operation_id !== locator.operationId
    || marker?.root_identity !== locator.rootIdentity
    || marker?.cleanup_owner !== PRODUCT_IDENTITY.packageName
    || !['ephemeral', 'project-retained'].includes(marker?.retention)
    || !validStoredLease(marker?.lease)
    || marker?.body_included !== false) {
    throw privateOperationError('MEDIA_PRIVATE_OPERATION_MARKER_MISMATCH', 'The private media operation marker does not match the requested operation.');
  }
}

function cleanupReceipt(locator, status, reason, now, totals) {
  return {
    schema_version: '1.0.0',
    type: 'media_cleanup_receipt',
    operation_id: locator.operationId,
    status,
    retention: locator.retention,
    reason,
    completed_at: now.toISOString(),
    deleted: {
      file_count: status === 'cleaned' ? totals.fileCount : 0,
      directory_count: status === 'cleaned' ? totals.directoryCount : 0,
      byte_count: status === 'cleaned' ? totals.byteCount : 0
    },
    identity: locator.rootIdentity,
    limitations: ['same_uid_hostile_concurrency_out_of_scope', 'mount_namespace_attacks_out_of_scope'],
    boundary: {
      absolute_path_included: false,
      raw_media_included: false,
      full_transcript_included: false,
      sibling_deleted: false,
      normal_artifact_root_deleted: false
    }
  };
}

function rootIdentity(operationId, info) {
  return createHash('sha256').update(`${operationId}:${info.dev}:${info.ino}:${info.uid}`).digest('hex');
}

function validateLocator(locator) {
  if (!locator || !OPERATION_ID.test(locator.operationId ?? '')
    || !['ephemeral', 'project-retained'].includes(locator.retention)
    || !path.isAbsolute(locator.base ?? '')
    || !path.isAbsolute(locator.root ?? '')
    || path.dirname(locator.root) !== locator.base
    || !/^[a-f0-9]{64}$/u.test(locator.rootIdentity ?? '')
    || !/^[0-9]+$/u.test(locator.device ?? '')
    || !/^[0-9]+$/u.test(locator.inode ?? '')) {
    throw privateOperationError('MEDIA_PRIVATE_OPERATION_LOCATOR_INVALID', 'The private media operation locator is invalid.');
  }
}

async function sanitizeLease(value, context = {}) {
  if (value === null) return null;
  if (!value || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.token !== 'string' || !/^[a-f0-9]{32,64}$/u.test(value.token)) {
    throw privateOperationError('MEDIA_PRIVATE_OPERATION_LEASE_INVALID', 'The private media operation lease is invalid.');
  }
  const capture = context.captureMediaProcessIdentity ?? captureProcessIdentity;
  const processIdentity = await Promise.resolve()
    .then(() => capture(value.pid))
    .catch(() => null);
  const captureBoot = context.captureMediaBootIdentity ?? captureLinuxBootIdentity;
  const bootIdentity = await Promise.resolve()
    .then(() => captureBoot())
    .catch(() => null);
  return {
    pid: value.pid,
    token: value.token,
    process_identity: typeof processIdentity === 'string' && /^[0-9]{1,40}$/u.test(processIdentity)
      ? processIdentity
      : null,
    boot_identity: typeof bootIdentity === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(bootIdentity)
      ? bootIdentity
      : null,
    containment_unconfirmed: value.containment_unconfirmed === true
  };
}

function validStoredLease(value) {
  if (value === null) return true;
  return Boolean(value)
    && Number.isSafeInteger(value.pid)
    && value.pid > 0
    && typeof value.token === 'string'
    && /^[a-f0-9]{32,64}$/u.test(value.token)
    && (value.process_identity === undefined
      || value.process_identity === null
      || (typeof value.process_identity === 'string' && /^[0-9]{1,40}$/u.test(value.process_identity)))
    && (value.boot_identity === undefined
      || value.boot_identity === null
      || (typeof value.boot_identity === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(value.boot_identity)))
    && (value.containment_unconfirmed === undefined || typeof value.containment_unconfirmed === 'boolean')
    && Object.keys(value).every((key) => ['pid', 'token', 'process_identity', 'boot_identity', 'containment_unconfirmed'].includes(key));
}

async function captureLinuxBootIdentity() {
  if (process.platform !== 'linux') return null;
  try {
    const value = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim().toLowerCase();
    return /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(value) ? value : null;
  } catch {
    return null;
  }
}

function sanitizeRelativeChild(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || path.isAbsolute(value) || value.split(/[\\/]/u).includes('..') || value.includes('\u0000')) {
    throw privateOperationError('MEDIA_PRIVATE_OPERATION_CHILD_INVALID', 'The provider run reference is invalid.');
  }
  return value;
}

function sanitizeMediaIdentity(value) {
  if (!value || !/^[a-f0-9]{64}$/u.test(value.sha256 ?? '') || !Number.isSafeInteger(value.bytes) || value.bytes <= 0) {
    throw privateOperationError('MEDIA_PRIVATE_OPERATION_MEDIA_IDENTITY_INVALID', 'The media identity is invalid.');
  }
  return { sha256: value.sha256, bytes: value.bytes, format: String(value.format ?? 'unknown').slice(0, 80) };
}

function materializeNow(now) {
  const value = typeof now === 'function' ? now() : now;
  return value instanceof Date && Number.isFinite(value.getTime()) ? value : new Date();
}

export function privateOperationError(code, message, reason = null) {
  const error = new Error(message);
  error.code = code;
  error.details = reason ? { reason } : {};
  return error;
}
