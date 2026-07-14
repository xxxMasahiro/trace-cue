import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const CONTROL_CENTER_AUTHORIZATION_MODES = Object.freeze(['legacy', 'paired', 'read-only']);
export const CONTROL_CENTER_SESSION_HEADER = 'x-trace-cue-session-token';
export const CONTROL_CENTER_MANAGEMENT_HEADER = 'x-trace-cue-management-token';
export const CONTROL_CENTER_CSRF_HEADER = 'x-trace-cue-action-token';

const TOKEN_BYTES = 32;
const PAIRING_TTL_MS = 60_000;
const SESSION_IDLE_TTL_MS = 30 * 60_000;
const SESSION_ABSOLUTE_TTL_MS = 8 * 60 * 60_000;
const ISSUE_WINDOW_MS = 60_000;
const MAX_ISSUES_PER_WINDOW = 8;
const MAX_PENDING = 8;
const MAX_SESSIONS = 8;

export function createControlCenterPairingAuthority({
  mode = 'legacy',
  instanceId,
  now,
  pairingTtlMs = PAIRING_TTL_MS,
  sessionIdleTtlMs = SESSION_IDLE_TTL_MS,
  sessionAbsoluteTtlMs = SESSION_ABSOLUTE_TTL_MS
} = {}) {
  if (!CONTROL_CENTER_AUTHORIZATION_MODES.includes(mode)) {
    throw new Error('Control Center authorization mode is invalid.');
  }
  if (typeof instanceId !== 'string' || instanceId.length < 16) {
    throw new Error('Control Center runtime instance is invalid.');
  }

  const clock = () => materializeNow(now).getTime();
  let managementCapability = mode === 'paired' ? randomToken() : null;
  const managementDigest = managementCapability ? digest(managementCapability) : null;
  const pending = [];
  const sessions = [];
  const issueTimes = [];
  let disposed = false;

  function issue(suppliedCapability) {
    if (disposed || mode !== 'paired') return denied('CONTROL_CENTER_PAIRING_DISABLED');
    if (!matchesDigest(suppliedCapability, managementDigest)) {
      return denied('CONTROL_CENTER_MANAGEMENT_TOKEN_REJECTED');
    }
    const current = clock();
    prune(current);
    while (issueTimes.length > 0 && issueTimes[0] <= current - ISSUE_WINDOW_MS) issueTimes.shift();
    if (issueTimes.length >= MAX_ISSUES_PER_WINDOW || pending.length >= MAX_PENDING) {
      return denied('CONTROL_CENTER_PAIRING_RATE_LIMITED');
    }
    const token = randomToken();
    pending.push({
      digest: digest(token),
      instanceId,
      issuedAt: current,
      expiresAt: current + pairingTtlMs
    });
    issueTimes.push(current);
    return {
      ok: true,
      token,
      instanceId,
      expiresAt: new Date(current + pairingTtlMs).toISOString()
    };
  }

  function exchange(token) {
    if (disposed || mode !== 'paired') return denied('CONTROL_CENTER_PAIRING_DISABLED');
    const current = clock();
    prune(current);
    const tokenDigest = safeDigest(token);
    if (!tokenDigest) return denied('CONTROL_CENTER_PAIRING_TOKEN_REJECTED');
    const index = pending.findIndex((candidate) => safeEqual(candidate.digest, tokenDigest));
    tokenDigest.fill(0);
    if (index < 0) return denied('CONTROL_CENTER_PAIRING_TOKEN_REJECTED');

    // Delete before issuing authority so a concurrent or re-entrant exchange
    // cannot consume the same token twice.
    const [candidate] = pending.splice(index, 1);
    candidate.digest.fill(0);
    if (candidate.instanceId !== instanceId || candidate.expiresAt <= current) {
      return denied('CONTROL_CENTER_PAIRING_TOKEN_EXPIRED');
    }
    prune(current);
    if (sessions.length >= MAX_SESSIONS) return denied('CONTROL_CENTER_SESSION_CAPACITY_REACHED');

    const bearer = randomToken();
    const csrf = randomToken();
    const absoluteExpiresAt = current + sessionAbsoluteTtlMs;
    sessions.push({
      bearerDigest: digest(bearer),
      csrfDigest: digest(csrf),
      instanceId,
      issuedAt: current,
      lastSeenAt: current,
      idleExpiresAt: current + sessionIdleTtlMs,
      absoluteExpiresAt
    });
    return {
      ok: true,
      bearer,
      csrf,
      instanceId,
      expiresAt: new Date(absoluteExpiresAt).toISOString()
    };
  }

  function authorize({ bearer, csrf = null, mutation = false } = {}) {
    if (disposed) return denied('CONTROL_CENTER_SESSION_REJECTED');
    if (mode === 'legacy') return { ok: true, mode };
    if (mode === 'read-only') {
      return mutation
        ? denied('CONTROL_CENTER_READ_ONLY')
        : { ok: true, mode };
    }
    const current = clock();
    prune(current);
    const bearerDigest = safeDigest(bearer);
    if (!bearerDigest) return denied('CONTROL_CENTER_SESSION_REQUIRED');
    const session = sessions.find((candidate) => safeEqual(candidate.bearerDigest, bearerDigest));
    bearerDigest.fill(0);
    if (!session || session.instanceId !== instanceId) return denied('CONTROL_CENTER_SESSION_REJECTED');
    if (mutation && !matchesDigest(csrf, session.csrfDigest)) {
      return denied('CONTROL_CENTER_ACTION_TOKEN_REJECTED');
    }
    session.lastSeenAt = current;
    session.idleExpiresAt = Math.min(current + sessionIdleTtlMs, session.absoluteExpiresAt);
    return { ok: true, mode, instanceId };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    managementDigest?.fill(0);
    for (const item of pending) item.digest.fill(0);
    for (const session of sessions) {
      session.bearerDigest.fill(0);
      session.csrfDigest.fill(0);
    }
    pending.length = 0;
    sessions.length = 0;
    issueTimes.length = 0;
  }

  function prune(current) {
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      if (pending[index].expiresAt <= current) {
        pending[index].digest.fill(0);
        pending.splice(index, 1);
      }
    }
    for (let index = sessions.length - 1; index >= 0; index -= 1) {
      const session = sessions[index];
      if (session.idleExpiresAt <= current || session.absoluteExpiresAt <= current) {
        session.bearerDigest.fill(0);
        session.csrfDigest.fill(0);
        sessions.splice(index, 1);
      }
    }
  }

  return Object.freeze({
    mode,
    instanceId,
    issue,
    exchange,
    authorize,
    dispose,
    managementCapability: () => {
      const capability = managementCapability;
      managementCapability = null;
      return capability;
    }
  });
}

function randomToken() {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

function safeDigest(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(value)) return null;
  return digest(value);
}

function matchesDigest(value, expected) {
  const actual = safeDigest(value);
  if (!actual || !expected) {
    actual?.fill(0);
    return false;
  }
  const matches = safeEqual(actual, expected);
  actual.fill(0);
  return matches;
}

function safeEqual(left, right) {
  return Buffer.isBuffer(left)
    && Buffer.isBuffer(right)
    && left.length === right.length
    && timingSafeEqual(left, right);
}

function materializeNow(value) {
  const candidate = typeof value === 'function' ? value() : value;
  const date = candidate instanceof Date ? candidate : candidate ? new Date(candidate) : new Date();
  if (Number.isNaN(date.getTime())) throw new Error('Current time is invalid.');
  return date;
}

function denied(code) {
  return { ok: false, code };
}
