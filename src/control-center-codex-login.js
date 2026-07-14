import { randomBytes } from 'node:crypto';
import { spawn as defaultSpawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readFile, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  probeCodexSubscriptionCli,
  resolveCodexSubscriptionExecutable,
  verifyCodexSubscriptionExecutable
} from './codex-subscription-adapter.js';
import { CODEX_SUBSCRIPTION_CLI_CONTRACT } from './codex-subscription-cli-contract.js';
import { captureProcessIdentity, isProcessIdentityAlive } from './safe-local-store.js';
import { PRODUCT_IDENTITY } from './product-identity.js';

const LOGIN_TIMEOUT_MS = 10 * 60_000;
const TERMINATION_GRACE_MS = 750;
const CANCELLATION_WAIT_MS = 3_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 2048;
const LINUX_BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';
const LINUX_BOOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const CONTROL_CENTER_CODEX_LOGIN_LOCK_FILE = `.${PRODUCT_IDENTITY.packageName}-control-center-login.lock`;

export function createControlCenterCodexLoginManager(context = {}) {
  let active = null;
  let last = idleState();
  let disposed = false;
  let startInFlight = null;
  let managerDisposalPromise = null;

  async function start({ expectedRevision } = {}) {
    if (disposed) return failure('CONTROL_CENTER_CODEX_LOGIN_UNAVAILABLE', 'Codex sign-in is unavailable.');
    if (active || startInFlight) return failure('CONTROL_CENTER_CODEX_LOGIN_BUSY', 'Finish or cancel the current Codex sign-in first.');
    let finishStart;
    startInFlight = new Promise((resolve) => { finishStart = resolve; });
    let executable = null;
    let lock = null;
    try {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        return failure('CONTROL_CENTER_CODEX_LOGIN_REVISION_INVALID', 'Refresh the screen and try again.');
      }
      const resolveExecutable = context.resolveControlCenterCodexLoginExecutable
        ?? (() => resolveCodexSubscriptionExecutable(context));
      executable = await resolveExecutable();
      if (!executable.ok) return executable;
      if (disposed) return failure('CONTROL_CENTER_CODEX_LOGIN_UNAVAILABLE', 'Codex sign-in is unavailable.');
      const resolveTarget = context.resolveControlCenterCodexLoginTarget
        ?? (() => resolveCodexLoginTarget(context));
      const target = await resolveTarget();
      if (!target.ok) return target;
      if (disposed) return failure('CONTROL_CENTER_CODEX_LOGIN_UNAVAILABLE', 'Codex sign-in is unavailable.');
      const contract = CODEX_SUBSCRIPTION_CLI_CONTRACT.versions[executable.package_version]?.device_login;
      const verifyExecutable = context.verifyControlCenterCodexLoginExecutable
        ?? verifyCodexSubscriptionExecutable;
      if (!contract || !await verifyExecutable(executable)) {
        return failure('CONTROL_CENTER_CODEX_LOGIN_CONTRACT_UNAVAILABLE', 'This Codex installation cannot be signed in safely from the Control Center.');
      }
      if (disposed) return failure('CONTROL_CENTER_CODEX_LOGIN_UNAVAILABLE', 'Codex sign-in is unavailable.');
      const acquireLock = context.acquireControlCenterCodexLoginLock
        ?? (() => acquireCodexLoginLock(target.codexHome, {
          captureBootIdentity: context.captureControlCenterBootIdentity
        }));
      lock = await acquireLock();
      if (!lock.ok) return lock;
      if (disposed) return failure('CONTROL_CENTER_CODEX_LOGIN_UNAVAILABLE', 'Codex sign-in is unavailable.');

      const operation = createLoginOperation({
        executable,
        lock,
        target,
        contract,
        context,
        onState(state) { if (!disposed) last = state; },
        onDone() { if (active === operation) active = null; }
      });
      active = operation;
      last = operation.status();
      executable = null;
      lock = null;
      operation.run();
      return { ok: true, login: last };
    } finally {
      await lock?.release?.().catch(() => {});
      await executable?.handle?.close().catch(() => {});
      finishStart();
      startInFlight = null;
    }
  }

  function status() {
    return active?.status() ?? last;
  }

  async function cancel() {
    if (!active) return failure('CONTROL_CENTER_CODEX_LOGIN_NOT_ACTIVE', 'No Codex sign-in is in progress.');
    await active.cancel();
    return { ok: true, login: status() };
  }

  function markFinalized() {
    if (last.status === 'connected') last = publicState({ ...last, status: 'complete', message: 'Codex is ready to use.' });
    return last;
  }

  function dispose() {
    if (managerDisposalPromise) return managerDisposalPromise;
    disposed = true;
    const pendingStart = startInFlight;
    managerDisposalPromise = (async () => {
      await pendingStart;
      if (active) await active.cancel({ shutdown: true });
      active = null;
      last = idleState();
    })();
    return managerDisposalPromise;
  }

  return Object.freeze({ start, status, cancel, markFinalized, dispose });
}

function createLoginOperation({ executable, lock, target, contract, context, onState, onDone }) {
  const operationId = randomBytes(18).toString('base64url');
  const codePattern = new RegExp(contract.user_code_pattern, 'u');
  let state = publicState({
    status: 'starting',
    operation_id: operationId,
    verification_url: null,
    user_code: null,
    message: 'Preparing Codex sign-in...',
    can_cancel: true
  });
  let child = null;
  let spawned = false;
  let closed = false;
  let stopReason = null;
  let totalBytes = 0;
  let verificationUrl = null;
  let userCode = null;
  let timeout = null;
  let killTimer = null;
  let detached = false;
  let doneResolve;
  const done = new Promise((resolve) => { doneResolve = resolve; });
  const outputStreams = [createOutputStream(), createOutputStream()];

  const update = (next) => {
    state = publicState({ ...state, ...next });
    onState(state);
  };

  const terminate = (reason) => {
    stopReason ??= reason;
    if (!spawned || closed) return;
    killProcessGroup(child, 'SIGTERM', context.platform ?? process.platform);
    killTimer ??= setTimeout(() => {
      if (!closed) killProcessGroup(child, 'SIGKILL', context.platform ?? process.platform);
    }, normalizeTerminationGrace(context.controlCenterCodexLoginTerminationGraceMs));
    killTimer.unref?.();
  };

  const collect = (output, chunk) => {
    if (stopReason) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_OUTPUT_BYTES) {
      terminate('output_limit');
      return;
    }
    let text;
    try { text = output.decoder.decode(buffer, { stream: true }); } catch {
      terminate('invalid_output');
      return;
    }
    inspectDecoded(output, text);
  };

  const inspectDecoded = (output, text) => {
    output.pendingLine += text;
    const lines = output.pendingLine.split(/\r?\n/u);
    output.pendingLine = lines.pop() ?? '';
    for (const line of lines) {
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
        terminate('line_limit');
        return;
      }
      inspectLine(line);
      if (stopReason) return;
    }
    if (Buffer.byteLength(output.pendingLine, 'utf8') > MAX_LINE_BYTES) terminate('line_limit');
  };

  const inspectLine = (rawLine) => {
    const line = stripTerminalControls(rawLine).trim();
    if (!line) return;
    if (line.includes(contract.verification_url)) verificationUrl = contract.verification_url;
    for (const candidate of line.split(/\s+/u)) {
      const clean = candidate.replace(/^[^A-Z0-9]+|[^A-Z0-9-]+$/gu, '');
      if (!codePattern.test(clean)) continue;
      if (userCode && userCode !== clean) {
        terminate('conflicting_code');
        return;
      }
      userCode = clean;
    }
    if (verificationUrl && userCode && state.status === 'starting') {
      update({
        status: 'waiting',
        verification_url: verificationUrl,
        user_code: userCode,
        message: 'Open the sign-in page and enter the code.',
        can_cancel: true
      });
    }
  };

  const reconcile = async (exitCode, exitSignal) => {
    update({ status: 'checking', message: 'Checking the Codex sign-in...', can_cancel: false });
    const reconcileImpl = context.reconcileControlCenterCodexLogin
      ?? (async () => probeCodexSubscriptionCli(context));
    let result;
    try { result = await reconcileImpl(); } catch { result = null; }
    if (result?.ok && result.login_ready === true) {
      update({
        status: 'connected',
        verification_url: null,
        user_code: null,
        message: 'Codex is connected.',
        can_cancel: false
      });
    } else if (stopReason === 'cancelled' || stopReason === 'shutdown') {
      update({ status: 'cancelled', verification_url: null, user_code: null, message: 'Codex sign-in was cancelled.', can_cancel: false });
    } else if (stopReason === 'timeout') {
      update({ status: 'error', verification_url: null, user_code: null, message: 'Codex sign-in took too long. Try again.', can_cancel: false });
    } else {
      update({
        status: 'error',
        verification_url: null,
        user_code: null,
        message: exitCode === 0 && !exitSignal
          ? 'Codex sign-in could not be confirmed. Try again.'
          : 'Codex sign-in did not finish. Try again.',
        can_cancel: false
      });
    }
  };

  async function run() {
    try {
      if (typeof lock.beginChildBinding === 'function' && !await lock.beginChildBinding()) {
        throw new Error('Codex sign-in reservation could not be prepared.');
      }
      if (stopReason) throw new Error('Codex sign-in stopped before launch.');
      const spawnImpl = context.spawnCodexLogin ?? context.spawn ?? defaultSpawn;
      const verifiedSpawn = verifiedExecutableSpawn(executable, context, spawnImpl);
      child = spawnImpl(verifiedSpawn.command, [...contract.argv], {
        cwd: target.codexHome,
        env: {
          HOME: target.codexHome,
          CODEX_HOME: target.codexHome,
          PATH: '/usr/bin:/bin',
          LANG: 'C.UTF-8',
          NO_COLOR: '1',
          SSL_CERT_FILE: '/etc/ssl/certs/ca-certificates.crt'
        },
        shell: false,
        detached: (context.platform ?? process.platform) !== 'win32',
        windowsHide: true,
        stdio: verifiedSpawn.stdio
      });
    } catch {
      update({ status: 'error', message: 'Codex sign-in could not be started.', can_cancel: false });
      await executable.handle?.close().catch(() => {});
      await lock.release().catch(() => {});
      onDone();
      doneResolve();
      return;
    }
    timeout = setTimeout(() => terminate('timeout'), normalizeTimeout(context.codexDeviceLoginTimeoutMs));
    timeout.unref?.();
    child.once('spawn', () => { spawned = true; if (stopReason) terminate(stopReason); });
    child.stdout?.on('data', (chunk) => collect(outputStreams[0], chunk));
    child.stderr?.on('data', (chunk) => collect(outputStreams[1], chunk));
    child.once('error', () => { if (!spawned) stopReason = 'spawn_error'; else terminate('process_error'); });
    child.once('close', async (code, signal) => {
      closed = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      try {
        for (const output of outputStreams) {
          let finalText = '';
          try { finalText = output.decoder.decode(); } catch { stopReason ??= 'invalid_output'; }
          if (finalText && !stopReason) inspectDecoded(output, finalText);
          if (output.pendingLine && !stopReason) inspectLine(output.pendingLine);
          output.pendingLine = '';
        }
        await reconcile(Number.isInteger(code) ? code : null, typeof signal === 'string' ? signal : null);
      } finally {
        await executable.handle?.close().catch(() => {});
        await lock.release().catch(() => {});
        onDone();
        doneResolve();
      }
    });
    if (typeof lock.bindChild === 'function' && Number.isInteger(child.pid) && child.pid > 0) {
      try {
        const childIdentity = await captureProcessIdentity(child.pid);
        const bound = await lock.bindChild({ pid: child.pid, process_identity: childIdentity });
        if (!bound && !closed) terminate('lock_binding_failed');
      } catch {
        if (!closed) terminate('lock_binding_failed');
      }
    }
  }

  async function cancel({ shutdown = false } = {}) {
    terminate(shutdown ? 'shutdown' : 'cancelled');
    const completed = await Promise.race([
      done.then(() => true),
      delay(normalizeCancellationWait(context.controlCenterCodexLoginCancellationWaitMs)).then(() => false)
    ]);
    if (!completed && !detached) {
      detached = true;
      update({
        status: 'error',
        verification_url: null,
        user_code: null,
        message: 'Codex sign-in could not be stopped safely. Close the Control Center before trying again.',
        can_cancel: false
      });
      onDone();
    }
  }

  return Object.freeze({ run, status: () => state, cancel, done });
}

async function acquireCodexLoginLock(codexHome, context = {}) {
  const lockPath = path.join(codexHome, CONTROL_CENTER_CODEX_LOGIN_LOCK_FILE);
  const captureBootIdentity = context.captureBootIdentity ?? captureLinuxBootIdentity;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle = null;
    try {
      handle = await open(lockPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      const identity = await handle.stat();
      const record = {
        schema_version: '1.1.0',
        type: 'trace_cue_codex_login_lock',
        owner: {
          pid: process.pid,
          process_identity: await captureProcessIdentity(process.pid)
        },
        boot_identity: normalizeBootIdentity(await Promise.resolve()
          .then(() => captureBootIdentity())
          .catch(() => null)),
        child: null,
        child_binding: 'not_started',
        created_at: new Date().toISOString()
      };
      await writeLockRecord(handle, record);
      let released = false;
      return {
        ok: true,
        async beginChildBinding() {
          if (released || record.child || record.child_binding !== 'not_started') return false;
          try {
            const current = await lstat(lockPath);
            if (!sameFile(identity, current)) return false;
            record.child_binding = 'pending';
            await writeLockRecord(handle, record);
            const completed = await lstat(lockPath);
            return sameFile(identity, completed);
          } catch {
            return false;
          }
        },
        async bindChild(child) {
          if (released || record.child_binding !== 'pending' || !Number.isInteger(child?.pid) || child.pid <= 0) return false;
          try {
            const current = await lstat(lockPath);
            if (!sameFile(identity, current)) return false;
            record.child = {
              pid: child.pid,
              process_identity: typeof child.process_identity === 'string' ? child.process_identity : null
            };
            record.child_binding = 'bound';
            await writeLockRecord(handle, record);
            const completed = await lstat(lockPath);
            return sameFile(identity, completed);
          } catch {
            return false;
          }
        },
        async release() {
          if (released) return;
          released = true;
          await handle.close().catch(() => {});
          try {
            const current = await lstat(lockPath);
            if (sameFile(identity, current)) await unlink(lockPath);
          } catch {}
        }
      };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error?.code !== 'EEXIST') {
        return failure('CONTROL_CENTER_CODEX_LOGIN_LOCK_UNAVAILABLE', 'Codex sign-in cannot be reserved safely right now.');
      }
      const stale = await readStaleCodexLoginLock(lockPath, { captureBootIdentity });
      if (!stale.ok) return stale;
      if (!stale.stale && stale.recovery_required) {
        return failure(
          'CONTROL_CENTER_CODEX_LOGIN_RESTART_REQUIRED',
          'Codex sign-in stopped before it could be reserved safely. Restart this computer before trying again.'
        );
      }
      if (!stale.stale && stale.ambiguous_pending_binding) {
        return failure(
          'CONTROL_CENTER_CODEX_LOGIN_LOCK_UNAVAILABLE',
          'The interrupted Codex sign-in reservation needs trusted local repair.'
        );
      }
      if (!stale.stale || !await removeUnchangedLock(lockPath, stale.identity)) {
        return failure('CONTROL_CENTER_CODEX_LOGIN_BUSY', 'Codex sign-in is already open in another Control Center.');
      }
    }
  }
  return failure('CONTROL_CENTER_CODEX_LOGIN_BUSY', 'Codex sign-in is already open in another Control Center.');
}

async function readStaleCodexLoginLock(lockPath, context = {}) {
  let handle = null;
  try {
    handle = await open(lockPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat();
    const uid = typeof process.getuid === 'function' ? process.getuid() : before.uid;
    if (!before.isFile() || before.isSymbolicLink?.() || before.nlink !== 1 || before.uid !== uid
      || (before.mode & 0o077) !== 0 || before.size < 2 || before.size > 4096) {
      return failure('CONTROL_CENTER_CODEX_LOGIN_LOCK_UNAVAILABLE', 'The Codex sign-in reservation is not safe to use.');
    }
    const body = await handle.readFile({ encoding: 'utf8' });
    const after = await handle.stat();
    if (!sameFile(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      return failure('CONTROL_CENTER_CODEX_LOGIN_BUSY', 'Codex sign-in is already open in another Control Center.');
    }
    const record = JSON.parse(body);
    if (record?.type !== 'trace_cue_codex_login_lock') {
      return failure('CONTROL_CENTER_CODEX_LOGIN_LOCK_UNAVAILABLE', 'The Codex sign-in reservation is not safe to use.');
    }
    if (!validCodexLoginLockState(record)) {
      return failure('CONTROL_CENTER_CODEX_LOGIN_LOCK_UNAVAILABLE', 'The Codex sign-in reservation is not safe to use.');
    }
    const captureBootIdentity = context.captureBootIdentity ?? captureLinuxBootIdentity;
    const storedBootIdentity = record.schema_version === '1.1.0'
      ? normalizeBootIdentity(record.boot_identity)
      : null;
    const currentBootIdentity = storedBootIdentity
      ? normalizeBootIdentity(await Promise.resolve()
        .then(() => captureBootIdentity())
        .catch(() => null))
      : null;
    const priorBoot = Boolean(storedBootIdentity && currentBootIdentity && storedBootIdentity !== currentBootIdentity);
    const ownerAlive = priorBoot ? false : await isProcessIdentityAlive(record.owner);
    const childAlive = priorBoot ? false : record.child ? await isProcessIdentityAlive(record.child) : false;
    const bindingPending = record.child_binding === 'pending' && !record.child;
    const sameBoot = Boolean(storedBootIdentity && currentBootIdentity && storedBootIdentity === currentBootIdentity);
    const ambiguousPendingBinding = bindingPending && !priorBoot && !sameBoot;
    return {
      ok: true,
      stale: !ownerAlive && !childAlive && (!bindingPending || priorBoot),
      recovery_required: !ownerAlive && !childAlive && bindingPending && sameBoot,
      ambiguous_pending_binding: !ownerAlive && !childAlive && bindingPending && ambiguousPendingBinding,
      identity: before
    };
  } catch {
    return failure('CONTROL_CENTER_CODEX_LOGIN_BUSY', 'Codex sign-in is already open in another Control Center.');
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function captureLinuxBootIdentity() {
  if (process.platform !== 'linux') return null;
  return normalizeBootIdentity(await readFile(LINUX_BOOT_ID_PATH, 'utf8'));
}

function normalizeBootIdentity(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return LINUX_BOOT_ID_PATTERN.test(normalized) ? normalized : null;
}

function validCodexLoginLockState(record) {
  if (!['1.0.0', '1.1.0'].includes(record?.schema_version) || !validLockProcessIdentity(record.owner)) return false;
  if (record.schema_version === '1.0.0') {
    return record.child === null || record.child === undefined || validLockProcessIdentity(record.child);
  }
  if (record.child_binding === 'not_started' || record.child_binding === 'pending') return record.child === null;
  if (record.child_binding === 'bound') return validLockProcessIdentity(record.child);
  return false;
}

function validLockProcessIdentity(value) {
  if (!value || typeof value !== 'object' || !Number.isInteger(value.pid) || value.pid <= 0) return false;
  return value.process_identity === null
    || (typeof value.process_identity === 'string'
      && value.process_identity.length >= 1
      && value.process_identity.length <= 256
      && !/[\u0000-\u001f\u007f]/u.test(value.process_identity));
}

async function writeLockRecord(handle, record) {
  const body = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
  if (body.length > 4096) throw new Error('Codex sign-in reservation is too large.');
  await handle.truncate(0);
  await handle.write(body, 0, body.length, 0);
  await handle.sync();
}

function verifiedExecutableSpawn(executable, context, spawnImpl) {
  if (spawnImpl !== defaultSpawn || typeof context.spawnCodexLogin === 'function' || typeof context.spawn === 'function') {
    return { command: executable.path, stdio: ['ignore', 'pipe', 'pipe'] };
  }
  if ((context.platform ?? process.platform) !== 'linux'
    || !Number.isInteger(executable.handle?.fd)
    || executable.handle.fd < 0) {
    throw new Error('Verified Codex executable is unavailable.');
  }
  return {
    command: '/proc/self/fd/3',
    stdio: ['ignore', 'pipe', 'pipe', executable.handle.fd]
  };
}

async function removeUnchangedLock(lockPath, identity) {
  try {
    const current = await lstat(lockPath);
    if (!sameFile(identity, current)) return false;
    await unlink(lockPath);
    return true;
  } catch {
    return false;
  }
}

function sameFile(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

async function resolveCodexLoginTarget(context) {
  try {
    const env = context.env ?? process.env;
    const home = typeof env.HOME === 'string' && path.isAbsolute(env.HOME) ? env.HOME : null;
    const configured = typeof env.CODEX_HOME === 'string' && path.isAbsolute(env.CODEX_HOME)
      ? env.CODEX_HOME
      : home ? path.join(home, '.codex') : null;
    if (!configured) throw new Error('missing');
    const resolved = await realpath(configured);
    const info = await lstat(resolved);
    const uid = typeof process.getuid === 'function' ? process.getuid() : info.uid;
    if (resolved !== path.resolve(configured)
      || !info.isDirectory()
      || info.isSymbolicLink()
      || info.uid !== uid
      || (info.mode & 0o022) !== 0) throw new Error('unsafe');
    return { ok: true, codexHome: resolved };
  } catch {
    return failure('CONTROL_CENTER_CODEX_LOGIN_HOME_UNAVAILABLE', 'The private Codex sign-in area is unavailable.');
  }
}

function idleState() {
  return publicState({
    status: 'idle',
    operation_id: null,
    verification_url: null,
    user_code: null,
    message: 'Codex is not connected yet.',
    can_cancel: false
  });
}

function createOutputStream() {
  return {
    decoder: new TextDecoder('utf-8', { fatal: true }),
    pendingLine: ''
  };
}

function publicState(value) {
  return Object.freeze({
    status: value.status,
    operation_id: value.operation_id ?? null,
    verification_url: value.verification_url ?? null,
    user_code: value.user_code ?? null,
    message: value.message,
    can_cancel: value.can_cancel === true,
    raw_output_included: false,
    technical_details_included: false
  });
}

function stripTerminalControls(value) {
  return String(value).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');
}

function killProcessGroup(child, signal, platform) {
  try {
    if (platform !== 'win32' && Number.isInteger(child?.pid) && child.pid > 0) {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {}
  try { child?.kill?.(signal); } catch {}
}

function normalizeTimeout(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 10_000 && number <= 15 * 60_000 ? number : LOGIN_TIMEOUT_MS;
}

function normalizeTerminationGrace(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 10 && number <= 5_000 ? number : TERMINATION_GRACE_MS;
}

function normalizeCancellationWait(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 50 && number <= 15_000 ? number : CANCELLATION_WAIT_MS;
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

function failure(code, message) {
  return { ok: false, error: { code, message, details: {} } };
}
