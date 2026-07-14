import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createControlCenterPairingAuthority } from '../src/control-center-pairing.js';
import {
  CONTROL_CENTER_CODEX_LOGIN_LOCK_FILE,
  createControlCenterCodexLoginManager
} from '../src/control-center-codex-login.js';
import { createControlCenterAiSetupRuntime } from '../src/control-center-ai-setup-runtime.js';
import { readControlCenterAiSetupCatalog } from '../src/control-center-ai-setup-catalog.js';
import { createControlCenterAiConnectionRecord } from '../src/control-center-ai-connections.js';
import {
  CONTROL_CENTER_AI_REFRESH_CONFIRM,
  CONTROL_CENTER_AI_SELECTION_CONFIRM,
  runControlCenterAiConnectionsRefresh,
  runControlCenterAiSelectionSave
} from '../src/control-center-ai-connection-actions.js';
import { startControlCenterServer } from '../src/control-center-server.js';
import { getSchema } from '../src/schema-registry.js';
import { TRACE_CUE_LOCALE_CODES } from '../src/locale-policy.js';
import { captureProcessIdentity } from '../src/safe-local-store.js';
import { hasCompleteAiSetupTranslations } from '../control-center/src/i18n.js';

const INSTANCE_ID = 'runtime_instance_for_test_1234567890';
const CREDENTIAL_FIXTURE = ['fixture', 'value', '123456789'].join('-');
const RAW_LOGIN_SENTINEL = 'raw-login-output-must-not-escape';
const CURRENT_BOOT_ID = '12345678-1234-4abc-8abc-1234567890ab';
const PRIOR_BOOT_ID = '87654321-4321-4cba-9cba-ba0987654321';

test('pairing tokens are one-use and sessions require a separate CSRF value', () => {
  let now = new Date('2026-07-14T00:00:00.000Z');
  const authority = createControlCenterPairingAuthority({
    mode: 'paired',
    instanceId: INSTANCE_ID,
    now: () => now,
    pairingTtlMs: 1000,
    sessionIdleTtlMs: 2000,
    sessionAbsoluteTtlMs: 5000
  });
  const managementCapability = authority.managementCapability();
  assert.equal(typeof managementCapability, 'string');
  assert.equal(authority.managementCapability(), null);
  const issued = authority.issue(managementCapability);
  assert.equal(issued.ok, true);
  const exchanged = authority.exchange(issued.token);
  assert.equal(exchanged.ok, true);
  assert.equal(authority.exchange(issued.token).ok, false);
  assert.equal(authority.authorize({ bearer: exchanged.bearer, mutation: false }).ok, true);
  assert.equal(authority.authorize({ bearer: exchanged.bearer, csrf: 'wrong', mutation: true }).ok, false);
  assert.equal(authority.authorize({ bearer: exchanged.bearer, csrf: exchanged.csrf, mutation: true }).ok, true);
  now = new Date('2026-07-14T00:00:06.000Z');
  assert.equal(authority.authorize({ bearer: exchanged.bearer, mutation: false }).ok, false);
  authority.dispose();
});

test('AI setup schema is registered and setup copy is complete in every supported locale', async () => {
  const registered = getSchema('control_center_ai_setup');
  const source = JSON.parse(await readFile(new URL('../schemas/control-center-ai-setup.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(registered, source);
  assert.equal(registered.properties.technical_details_included.const, false);
  assert.equal(registered.properties.subscription_login.properties.raw_output_included.const, false);
  assert.equal(TRACE_CUE_LOCALE_CODES.length, 14);
  for (const locale of TRACE_CUE_LOCALE_CODES) assert.equal(hasCompleteAiSetupTranslations(locale), true, locale);
});

test('AI setup catalog rejects unsafe revisions, retention drift, and invalid effort entries', async () => {
  const source = JSON.parse(await readFile(new URL('../ops/CONTROL_CENTER_AI_SETUP_CATALOG.json', import.meta.url), 'utf8'));
  const mutations = [
    (catalog) => { catalog.catalog_revision = 'bad\nrevision'; },
    (catalog) => { catalog.services[0].retention = 'control_center_session'; },
    (catalog) => { catalog.services[1].retention = 'service_owned'; },
    (catalog) => { catalog.services[1].models[0].native_efforts.push('medium'); },
    (catalog) => { catalog.services[1].models[0].native_efforts[0] = 'not valid'; }
  ];
  for (const mutate of mutations) {
    const catalog = structuredClone(source);
    mutate(catalog);
    await assert.rejects(readControlCenterAiSetupCatalog({ controlCenterAiSetupCatalog: catalog }));
  }
});

test('Codex device sign-in exposes only the fixed page and one-time code', async () => {
  let child;
  let invocation;
  let executableClosed = false;
  const manager = createControlCenterCodexLoginManager({
    platform: 'linux',
    async resolveControlCenterCodexLoginExecutable() {
      return {
        ok: true,
        path: '/verified/codex',
        package_version: '0.144.1',
        handle: { async close() { executableClosed = true; } }
      };
    },
    async verifyControlCenterCodexLoginExecutable() { return true; },
    async resolveControlCenterCodexLoginTarget() { return { ok: true, codexHome: '/private/codex-home' }; },
    async acquireControlCenterCodexLoginLock() { return { ok: true, async release() {} }; },
    spawnCodexLogin(executable, args, options) {
      invocation = { executable, args, options };
      child = fakeLoginChild();
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
    async reconcileControlCenterCodexLogin() { return { ok: true, login_ready: true }; }
  });
  const started = await manager.start({ expectedRevision: 7 });
  assert.equal(started.ok, true);
  assert.equal((await manager.start({ expectedRevision: 7 })).error.code, 'CONTROL_CENTER_CODEX_LOGIN_BUSY');
  assert.deepEqual(invocation.args, ['login', '--device-auth']);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.env.CODEX_HOME, '/private/codex-home');
  assert.equal(invocation.options.env.PATH, '/usr/bin:/bin');
  child.stdout.write(`Open this page: https://auth.openai.com/codex/device\n${RAW_LOGIN_SENTINEL}\n`);
  child.stderr.write('Enter code: ABCD-EFGH\n');
  await waitFor(() => manager.status().status === 'waiting');
  const waiting = manager.status();
  assert.equal(waiting.verification_url, 'https://auth.openai.com/codex/device');
  assert.equal(waiting.user_code, 'ABCD-EFGH');
  assert.doesNotMatch(JSON.stringify(waiting), new RegExp(RAW_LOGIN_SENTINEL));
  child.stdout.end();
  child.stderr.end();
  child.emit('close', 0, null);
  await waitFor(() => manager.status().status === 'connected');
  assert.equal(executableClosed, true);
  manager.markFinalized();
  assert.equal(manager.status().status, 'complete');
  await manager.dispose();
});

test('Codex device sign-in decodes interleaved stdout and stderr independently', async () => {
  let child;
  const manager = createControlCenterCodexLoginManager({
    platform: 'linux',
    async resolveControlCenterCodexLoginExecutable() {
      return { ok: true, path: '/verified/codex', package_version: '0.144.1', handle: { async close() {} } };
    },
    async verifyControlCenterCodexLoginExecutable() { return true; },
    async resolveControlCenterCodexLoginTarget() { return { ok: true, codexHome: '/private/codex-home' }; },
    async acquireControlCenterCodexLoginLock() { return { ok: true, async release() {} }; },
    spawnCodexLogin() {
      child = fakeLoginChild();
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
    async reconcileControlCenterCodexLogin() { return { ok: true, login_ready: true }; }
  });
  try {
    assert.equal((await manager.start({ expectedRevision: 0 })).ok, true);
    const stdout = Buffer.from('Preparing\nOpen this page: https://auth.openai.com/codex/device\n', 'utf8');
    const multibyte = Buffer.from([0xe6, 0xba, 0x96, 0xe5, 0x82, 0x99, 0x0a]);
    child.stdout.write(multibyte.subarray(0, 1));
    child.stderr.write('Enter code: WXYZ-1234\n');
    child.stdout.write(Buffer.concat([multibyte.subarray(1), stdout]));
    await waitFor(() => manager.status().status === 'waiting');
    assert.equal(manager.status().verification_url, 'https://auth.openai.com/codex/device');
    assert.equal(manager.status().user_code, 'WXYZ-1234');
    child.emit('close', 0, null);
    await waitFor(() => manager.status().status === 'connected');
  } finally {
    await manager.dispose();
  }
});

test('Codex device sign-in cancellation terminates the fixed process and reconciles status', async () => {
  let child;
  const manager = createControlCenterCodexLoginManager({
    platform: 'linux',
    async resolveControlCenterCodexLoginExecutable() {
      return { ok: true, path: '/verified/codex', package_version: '0.144.1', handle: { async close() {} } };
    },
    async verifyControlCenterCodexLoginExecutable() { return true; },
    async resolveControlCenterCodexLoginTarget() { return { ok: true, codexHome: '/private/codex-home' }; },
    async acquireControlCenterCodexLoginLock() { return { ok: true, async release() {} }; },
    spawnCodexLogin() {
      child = fakeLoginChild({ closeOnKill: true });
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
    async reconcileControlCenterCodexLogin() { return { ok: true, login_ready: false }; }
  });
  assert.equal((await manager.start({ expectedRevision: 1 })).ok, true);
  await waitFor(() => child.spawned === true);
  const cancelled = await manager.cancel();
  assert.equal(cancelled.ok, true);
  assert.equal(manager.status().status, 'cancelled');
  assert.deepEqual(child.killSignals, ['SIGTERM']);
  await manager.dispose();
});

test('Codex device sign-in stops the child when lock binding throws', async () => {
  let child;
  const manager = createControlCenterCodexLoginManager({
    platform: 'linux',
    controlCenterCodexLoginTerminationGraceMs: 100,
    async resolveControlCenterCodexLoginExecutable() {
      return { ok: true, path: '/verified/codex', package_version: '0.144.1', handle: { async close() {} } };
    },
    async verifyControlCenterCodexLoginExecutable() { return true; },
    async resolveControlCenterCodexLoginTarget() { return { ok: true, codexHome: '/private/codex-home' }; },
    async acquireControlCenterCodexLoginLock() {
      return {
        ok: true,
        async beginChildBinding() { return true; },
        async bindChild() { throw new Error('injected lock failure'); },
        async release() {}
      };
    },
    spawnCodexLogin() {
      child = fakeLoginChild({ closeOnKill: true });
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
    async reconcileControlCenterCodexLogin() { return { ok: true, login_ready: false }; }
  });
  try {
    assert.equal((await manager.start({ expectedRevision: 0 })).ok, true);
    await waitFor(() => manager.status().status === 'error');
    assert.deepEqual(child.killSignals, ['SIGTERM']);
  } finally {
    await manager.dispose();
  }
});

test('Codex device sign-in shutdown waits for pending startup and never spawns afterward', async () => {
  let releaseLock;
  let lockRequested = false;
  let executableClosed = false;
  let lockReleased = false;
  let spawnCount = 0;
  const lockGate = new Promise((resolve) => { releaseLock = resolve; });
  const manager = createControlCenterCodexLoginManager({
    platform: 'linux',
    async resolveControlCenterCodexLoginExecutable() {
      return {
        ok: true,
        path: '/verified/codex',
        package_version: '0.144.1',
        handle: { async close() { executableClosed = true; } }
      };
    },
    async verifyControlCenterCodexLoginExecutable() { return true; },
    async resolveControlCenterCodexLoginTarget() { return { ok: true, codexHome: '/private/codex-home' }; },
    async acquireControlCenterCodexLoginLock() {
      lockRequested = true;
      await lockGate;
      return { ok: true, async release() { lockReleased = true; } };
    },
    spawnCodexLogin() {
      spawnCount += 1;
      return fakeLoginChild();
    }
  });
  const starting = manager.start({ expectedRevision: 0 });
  await waitFor(() => lockRequested);
  let shutdownFinished = false;
  const shutdown = manager.dispose().then(() => { shutdownFinished = true; });
  await Promise.resolve();
  assert.equal(shutdownFinished, false);
  releaseLock();
  const result = await starting;
  await shutdown;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CONTROL_CENTER_CODEX_LOGIN_UNAVAILABLE');
  assert.equal(spawnCount, 0);
  assert.equal(executableClosed, true);
  assert.equal(lockReleased, true);
});

test('Codex device sign-in never spawns after shutdown while child binding is pending', async () => {
  let releaseBinding;
  let bindingStarted = false;
  let executableClosed = false;
  let lockReleased = false;
  let spawnCount = 0;
  const bindingGate = new Promise((resolve) => { releaseBinding = resolve; });
  const manager = createControlCenterCodexLoginManager({
    platform: 'linux',
    controlCenterCodexLoginCancellationWaitMs: 60,
    async resolveControlCenterCodexLoginExecutable() {
      return {
        ok: true,
        path: '/verified/codex',
        package_version: '0.144.1',
        handle: { async close() { executableClosed = true; } }
      };
    },
    async verifyControlCenterCodexLoginExecutable() { return true; },
    async resolveControlCenterCodexLoginTarget() { return { ok: true, codexHome: '/private/codex-home' }; },
    async acquireControlCenterCodexLoginLock() {
      return {
        ok: true,
        async beginChildBinding() {
          bindingStarted = true;
          await bindingGate;
          return true;
        },
        async release() { lockReleased = true; }
      };
    },
    spawnCodexLogin() {
      spawnCount += 1;
      return fakeLoginChild();
    }
  });
  assert.equal((await manager.start({ expectedRevision: 0 })).ok, true);
  await waitFor(() => bindingStarted);
  await manager.dispose();
  releaseBinding();
  await waitFor(() => executableClosed && lockReleased);
  assert.equal(spawnCount, 0);
});

test('Codex device sign-in cancellation is bounded when a child never reports close', async () => {
  let child;
  let lockReleased = false;
  const manager = createControlCenterCodexLoginManager({
    platform: 'linux',
    controlCenterCodexLoginTerminationGraceMs: 10,
    controlCenterCodexLoginCancellationWaitMs: 60,
    async resolveControlCenterCodexLoginExecutable() {
      return { ok: true, path: '/verified/codex', package_version: '0.144.1', handle: { async close() {} } };
    },
    async verifyControlCenterCodexLoginExecutable() { return true; },
    async resolveControlCenterCodexLoginTarget() { return { ok: true, codexHome: '/private/codex-home' }; },
    async acquireControlCenterCodexLoginLock() {
      return { ok: true, async release() { lockReleased = true; } };
    },
    spawnCodexLogin() {
      child = fakeLoginChild();
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
    async reconcileControlCenterCodexLogin() { return { ok: true, login_ready: false }; }
  });
  assert.equal((await manager.start({ expectedRevision: 1 })).ok, true);
  await waitFor(() => child.spawned === true);
  const startedAt = Date.now();
  const cancelled = await manager.cancel();
  assert.equal(cancelled.ok, true);
  assert.equal(manager.status().status, 'error');
  assert.ok(Date.now() - startedAt < 1_000);
  assert.deepEqual(child.killSignals, ['SIGTERM', 'SIGKILL']);
  assert.equal(lockReleased, false);
  await manager.dispose();
});

test('Codex device sign-in uses an owner-only user lock across Control Center instances', async () => {
  const codexHome = await mkdtemp(path.join(tmpdir(), 'trace-cue-codex-login-lock-'));
  const children = [];
  const context = {
    platform: 'linux',
    env: { HOME: codexHome, CODEX_HOME: codexHome },
    async captureControlCenterBootIdentity() { return CURRENT_BOOT_ID; },
    async resolveControlCenterCodexLoginExecutable() {
      return { ok: true, path: '/verified/codex', package_version: '0.144.1', handle: { async close() {} } };
    },
    async verifyControlCenterCodexLoginExecutable() { return true; },
    spawnCodexLogin() {
      const child = fakeLoginChild({ closeOnKill: true });
      children.push(child);
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
    async reconcileControlCenterCodexLogin() { return { ok: true, login_ready: false }; }
  };
  const first = createControlCenterCodexLoginManager(context);
  const second = createControlCenterCodexLoginManager(context);
  try {
    assert.equal((await first.start({ expectedRevision: 0 })).ok, true);
    await waitFor(() => children[0]?.spawned === true);
    const blocked = await second.start({ expectedRevision: 0 });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, 'CONTROL_CENTER_CODEX_LOGIN_BUSY');
    const lockInfo = await stat(path.join(codexHome, CONTROL_CENTER_CODEX_LOGIN_LOCK_FILE));
    assert.equal(lockInfo.mode & 0o777, 0o600);
    const lockRecord = JSON.parse(await readFile(path.join(codexHome, CONTROL_CENTER_CODEX_LOGIN_LOCK_FILE), 'utf8'));
    assert.equal(lockRecord.schema_version, '1.1.0');
    assert.equal(lockRecord.boot_identity, CURRENT_BOOT_ID);

    await first.dispose();
    await assert.rejects(access(path.join(codexHome, CONTROL_CENTER_CODEX_LOGIN_LOCK_FILE)));
    assert.equal((await second.start({ expectedRevision: 1 })).ok, true);
    await waitFor(() => children[1]?.spawned === true);
    await second.dispose();
  } finally {
    await first.dispose();
    await second.dispose();
    await rm(codexHome, { recursive: true, force: true });
  }
});

test('Codex device sign-in preserves a lock while an orphaned login child is still alive', async () => {
  const codexHome = await mkdtemp(path.join(tmpdir(), 'trace-cue-codex-login-orphan-'));
  const lockPath = path.join(codexHome, CONTROL_CENTER_CODEX_LOGIN_LOCK_FILE);
  const childIdentity = await captureProcessIdentity(process.pid);
  await writeFile(lockPath, `${JSON.stringify({
    schema_version: '1.0.0',
    type: 'trace_cue_codex_login_lock',
    owner: { pid: 99_999_999, process_identity: 'stopped-owner' },
    boot_identity: PRIOR_BOOT_ID,
    child: { pid: process.pid, process_identity: childIdentity },
    created_at: '2026-07-14T00:00:00.000Z'
  })}\n`, { encoding: 'utf8', mode: 0o600 });
  let spawnCount = 0;
  const manager = createControlCenterCodexLoginManager({
    platform: 'linux',
    env: { HOME: codexHome, CODEX_HOME: codexHome },
    async captureControlCenterBootIdentity() { return CURRENT_BOOT_ID; },
    async resolveControlCenterCodexLoginExecutable() {
      return { ok: true, path: '/verified/codex', package_version: '0.144.1', handle: { async close() {} } };
    },
    async verifyControlCenterCodexLoginExecutable() { return true; },
    spawnCodexLogin() { spawnCount += 1; return fakeLoginChild(); }
  });
  try {
    const blocked = await manager.start({ expectedRevision: 0 });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, 'CONTROL_CENTER_CODEX_LOGIN_BUSY');
    assert.equal(spawnCount, 0);
    assert.equal((await stat(lockPath)).mode & 0o777, 0o600);
  } finally {
    await manager.dispose();
    await rm(codexHome, { recursive: true, force: true });
  }
});

test('Codex device sign-in fails closed if its owner dies while child binding is pending', async () => {
  const codexHome = await mkdtemp(path.join(tmpdir(), 'trace-cue-codex-login-binding-pending-'));
  const lockPath = path.join(codexHome, CONTROL_CENTER_CODEX_LOGIN_LOCK_FILE);
  await writeFile(lockPath, `${JSON.stringify({
    schema_version: '1.0.0',
    type: 'trace_cue_codex_login_lock',
    owner: { pid: 99_999_999, process_identity: 'stopped-owner' },
    child: null,
    child_binding: 'pending',
    created_at: '2026-07-14T00:00:00.000Z'
  })}\n`, { encoding: 'utf8', mode: 0o600 });
  let spawnCount = 0;
  const manager = createControlCenterCodexLoginManager({
    platform: 'linux',
    env: { HOME: codexHome, CODEX_HOME: codexHome },
    async resolveControlCenterCodexLoginExecutable() {
      return { ok: true, path: '/verified/codex', package_version: '0.144.1', handle: { async close() {} } };
    },
    async verifyControlCenterCodexLoginExecutable() { return true; },
    spawnCodexLogin() { spawnCount += 1; return fakeLoginChild(); }
  });
  try {
    const blocked = await manager.start({ expectedRevision: 0 });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, 'CONTROL_CENTER_CODEX_LOGIN_LOCK_UNAVAILABLE');
    assert.equal(spawnCount, 0);
    assert.equal((await stat(lockPath)).mode & 0o777, 0o600);
  } finally {
    await manager.dispose();
    await rm(codexHome, { recursive: true, force: true });
  }
});

test('Codex device sign-in keeps a same-boot pending child binding fail closed', async () => {
  const codexHome = await mkdtemp(path.join(tmpdir(), 'trace-cue-codex-login-same-boot-pending-'));
  const lockPath = path.join(codexHome, CONTROL_CENTER_CODEX_LOGIN_LOCK_FILE);
  await writeFile(lockPath, `${JSON.stringify({
    schema_version: '1.1.0',
    type: 'trace_cue_codex_login_lock',
    owner: { pid: 99_999_999, process_identity: 'stopped-owner' },
    boot_identity: CURRENT_BOOT_ID,
    child: null,
    child_binding: 'pending',
    created_at: '2026-07-14T00:00:00.000Z'
  })}\n`, { encoding: 'utf8', mode: 0o600 });
  let spawnCount = 0;
  const manager = createControlCenterCodexLoginManager({
    platform: 'linux',
    env: { HOME: codexHome, CODEX_HOME: codexHome },
    async captureControlCenterBootIdentity() { return CURRENT_BOOT_ID; },
    async resolveControlCenterCodexLoginExecutable() {
      return { ok: true, path: '/verified/codex', package_version: '0.144.1', handle: { async close() {} } };
    },
    async verifyControlCenterCodexLoginExecutable() { return true; },
    spawnCodexLogin() { spawnCount += 1; return fakeLoginChild(); }
  });
  try {
    const blocked = await manager.start({ expectedRevision: 0 });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, 'CONTROL_CENTER_CODEX_LOGIN_RESTART_REQUIRED');
    assert.equal(spawnCount, 0);
    assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).boot_identity, CURRENT_BOOT_ID);
  } finally {
    await manager.dispose();
    await rm(codexHome, { recursive: true, force: true });
  }
});

test('Codex device sign-in recovers a same-boot stale lock before child creation', async () => {
  const codexHome = await mkdtemp(path.join(tmpdir(), 'trace-cue-codex-login-same-boot-not-started-'));
  const lockPath = path.join(codexHome, CONTROL_CENTER_CODEX_LOGIN_LOCK_FILE);
  await writeFile(lockPath, `${JSON.stringify({
    schema_version: '1.1.0',
    type: 'trace_cue_codex_login_lock',
    owner: { pid: 99_999_999, process_identity: 'stopped-owner' },
    boot_identity: CURRENT_BOOT_ID,
    child: null,
    child_binding: 'not_started',
    created_at: '2026-07-14T00:00:00.000Z'
  })}\n`, { encoding: 'utf8', mode: 0o600 });
  let child;
  let spawnCount = 0;
  const manager = createControlCenterCodexLoginManager({
    platform: 'linux',
    env: { HOME: codexHome, CODEX_HOME: codexHome },
    async captureControlCenterBootIdentity() { return CURRENT_BOOT_ID; },
    async resolveControlCenterCodexLoginExecutable() {
      return { ok: true, path: '/verified/codex', package_version: '0.144.1', handle: { async close() {} } };
    },
    async verifyControlCenterCodexLoginExecutable() { return true; },
    spawnCodexLogin() {
      spawnCount += 1;
      child = fakeLoginChild({ closeOnKill: true });
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
    async reconcileControlCenterCodexLogin() { return { ok: true, login_ready: false }; }
  });
  try {
    const started = await manager.start({ expectedRevision: 0 });
    assert.equal(started.ok, true);
    await waitFor(() => child?.spawned === true);
    assert.equal(spawnCount, 1);
    const replacement = await waitForJson(lockPath, (record) => record.child_binding === 'bound');
    assert.equal(replacement.boot_identity, CURRENT_BOOT_ID);
    assert.equal(replacement.owner.pid, process.pid);
    assert.equal(replacement.child_binding, 'bound');
  } finally {
    await manager.dispose();
    await rm(codexHome, { recursive: true, force: true });
  }
});

test('Codex device sign-in safely replaces a pending lock from an earlier boot', async () => {
  const codexHome = await mkdtemp(path.join(tmpdir(), 'trace-cue-codex-login-prior-boot-pending-'));
  const lockPath = path.join(codexHome, CONTROL_CENTER_CODEX_LOGIN_LOCK_FILE);
  const collidingProcessIdentity = await captureProcessIdentity(process.pid);
  await writeFile(lockPath, `${JSON.stringify({
    schema_version: '1.1.0',
    type: 'trace_cue_codex_login_lock',
    owner: { pid: process.pid, process_identity: collidingProcessIdentity },
    boot_identity: PRIOR_BOOT_ID,
    child: null,
    child_binding: 'pending',
    created_at: '2026-07-14T00:00:00.000Z'
  })}\n`, { encoding: 'utf8', mode: 0o600 });
  let child;
  let spawnCount = 0;
  const manager = createControlCenterCodexLoginManager({
    platform: 'linux',
    env: { HOME: codexHome, CODEX_HOME: codexHome },
    async captureControlCenterBootIdentity() { return CURRENT_BOOT_ID; },
    async resolveControlCenterCodexLoginExecutable() {
      return { ok: true, path: '/verified/codex', package_version: '0.144.1', handle: { async close() {} } };
    },
    async verifyControlCenterCodexLoginExecutable() { return true; },
    spawnCodexLogin() {
      spawnCount += 1;
      child = fakeLoginChild({ closeOnKill: true });
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
    async reconcileControlCenterCodexLogin() { return { ok: true, login_ready: false }; }
  });
  try {
    const started = await manager.start({ expectedRevision: 0 });
    assert.equal(started.ok, true);
    await waitFor(() => child?.spawned === true);
    assert.equal(spawnCount, 1);
    const replacement = await waitForJson(lockPath, (record) => record.child_binding === 'bound');
    assert.equal(replacement.schema_version, '1.1.0');
    assert.equal(replacement.boot_identity, CURRENT_BOOT_ID);
    assert.equal(replacement.owner.pid, process.pid);
  } finally {
    await manager.dispose();
    await rm(codexHome, { recursive: true, force: true });
  }
});

test('Codex device sign-in preserves inconsistent version 1.1 lock states', async () => {
  const codexHome = await mkdtemp(path.join(tmpdir(), 'trace-cue-codex-login-invalid-state-'));
  const lockPath = path.join(codexHome, CONTROL_CENTER_CODEX_LOGIN_LOCK_FILE);
  const states = [
    { child_binding: 'bound', child: null },
    { child_binding: 'pending', child: { pid: 99_999_998, process_identity: 'stopped-child' } },
    { child_binding: 'unknown', child: null },
    { child: null }
  ];
  let spawnCount = 0;
  try {
    for (const state of states) {
      await writeFile(lockPath, `${JSON.stringify({
        schema_version: '1.1.0',
        type: 'trace_cue_codex_login_lock',
        owner: { pid: 99_999_999, process_identity: 'stopped-owner' },
        boot_identity: PRIOR_BOOT_ID,
        created_at: '2026-07-14T00:00:00.000Z',
        ...state
      })}\n`, { encoding: 'utf8', mode: 0o600 });
      const manager = createControlCenterCodexLoginManager({
        platform: 'linux',
        env: { HOME: codexHome, CODEX_HOME: codexHome },
        async captureControlCenterBootIdentity() { return CURRENT_BOOT_ID; },
        async resolveControlCenterCodexLoginExecutable() {
          return { ok: true, path: '/verified/codex', package_version: '0.144.1', handle: { async close() {} } };
        },
        async verifyControlCenterCodexLoginExecutable() { return true; },
        spawnCodexLogin() { spawnCount += 1; return fakeLoginChild(); }
      });
      try {
        const blocked = await manager.start({ expectedRevision: 0 });
        assert.equal(blocked.ok, false);
        assert.equal(blocked.error.code, 'CONTROL_CENTER_CODEX_LOGIN_LOCK_UNAVAILABLE');
        assert.deepEqual(JSON.parse(await readFile(lockPath, 'utf8')).child_binding, state.child_binding);
      } finally {
        await manager.dispose();
      }
    }
    assert.equal(spawnCount, 0);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test('session API setup keeps the upstream key out of projections and execution env', async () => {
  let closed = false;
  const runtime = await createControlCenterAiSetupRuntime({ instanceId: INSTANCE_ID }, {
    env: { PATH: '' },
    controlCenterAiUpstreamFetch: fakeModelFetch,
    async startControlCenterResponsesAdapter(options, adapterContext) {
      assert.equal(options.providerModel, undefined);
      assert.equal(adapterContext.env.AGENTIC_HUMAN_REVIEW_OPENAI_API_KEY, 'managed-by-control-center');
      assert.equal(adapterContext.env.AGENTIC_HUMAN_REVIEW_OPENAI_MODEL, undefined);
      assert.doesNotMatch(JSON.stringify(adapterContext.env), new RegExp(CREDENTIAL_FIXTURE));
      return { url: 'http://127.0.0.1:34567/agentic-human-review', close: async () => { closed = true; } };
    }
  });
  const service = runtime.projection().services.find((item) => item.kind === 'api');
  const intent = runtime.createApiSubmission({ service_option_id: service.option_id, expected_revision: 0 });
  const key = Buffer.from(CREDENTIAL_FIXTURE);
  const prepared = await runtime.prepareApiConnection(intent.submission_id, key);
  key.fill(0);
  assert.equal(prepared.ok, true);
  const transaction = runtime.beginPromotion(prepared.pending);
  await transaction.commit();
  const projectionText = JSON.stringify(runtime.projection());
  const connectionText = JSON.stringify(runtime.connections());
  assert.doesNotMatch(projectionText, new RegExp(CREDENTIAL_FIXTURE));
  assert.doesNotMatch(connectionText, new RegExp(CREDENTIAL_FIXTURE));
  const binding = runtimeBinding(prepared.connection);
  assert.equal(runtime.validateBinding(binding), true);
  const lease = runtime.acquireExecutionContext({ env: { PATH: '/usr/bin' } }, binding);
  assert.equal(lease.ok, true);
  assert.doesNotMatch(JSON.stringify(lease.context.env), new RegExp(CREDENTIAL_FIXTURE));
  await lease.release();
  const disconnect = runtime.beginDisconnect();
  await disconnect.commit();
  await runtime.dispose();
  assert.equal(closed, true);
});

test('API setup serializes promotions and keeps a leased generation alive until release', async () => {
  const closed = [];
  let adapterId = 0;
  const runtime = await createControlCenterAiSetupRuntime({ instanceId: INSTANCE_ID }, {
    env: { PATH: '' },
    async controlCenterAiUpstreamFetch(url, options = {}) {
      assert.equal(String(url), 'https://api.openai.com/v1/models');
      assert.match(options.headers.authorization, /^Bearer replacement-key-/u);
      return new Response(JSON.stringify({ data: [{ id: 'gpt-5.6-sol', created: 1 }, { id: 'gpt-5.6-terra', created: 2 }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    },
    async startControlCenterResponsesAdapter(_options, adapterContext) {
      adapterId += 1;
      const id = adapterId;
      assert.doesNotMatch(JSON.stringify(adapterContext.env), /replacement-key-/u);
      return {
        url: `http://127.0.0.1:${35000 + id}/agentic-human-review`,
        async close() { closed.push(id); }
      };
    }
  });
  try {
    const first = await prepareRuntimeConnection(runtime, 'replacement-key-one', 0);
    const second = await prepareRuntimeConnection(runtime, 'replacement-key-two', 0);
    const firstPromotion = runtime.beginPromotion(first.pending);
    assert.equal(firstPromotion.ok, true);
    assert.equal(runtime.beginPromotion(second.pending).error.code, 'CONTROL_CENTER_AI_SETUP_BUSY');
    await firstPromotion.commit();

    const firstBinding = runtimeBinding(first.connection);
    const lease = runtime.acquireExecutionContext({ env: { PATH: '/usr/bin' } }, firstBinding);
    assert.equal(lease.ok, true);
    const secondPromotion = runtime.beginPromotion(second.pending);
    assert.equal(secondPromotion.ok, true);
    await secondPromotion.commit();
    assert.deepEqual(closed, []);
    assert.equal(runtime.validateBinding(firstBinding), false);
    assert.equal(runtime.validateBinding(runtimeBinding(second.connection)), true);

    await lease.release();
    assert.deepEqual(closed, [1]);
    const disconnect = runtime.beginDisconnect();
    assert.equal(disconnect.ok, true);
    await disconnect.commit();
    await waitFor(() => closed.includes(2));
  } finally {
    await runtime.dispose();
  }
});

test('API setup shutdown waits for a retired adapter that is already closing', async () => {
  let adapterId = 0;
  let releaseRetiredClose;
  let retiredCloseStarted = false;
  const retiredCloseGate = new Promise((resolve) => { releaseRetiredClose = resolve; });
  const runtime = await createControlCenterAiSetupRuntime({ instanceId: INSTANCE_ID }, {
    async controlCenterAiUpstreamFetch() {
      return new Response(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    },
    async startControlCenterResponsesAdapter() {
      adapterId += 1;
      const id = adapterId;
      return {
        url: `http://127.0.0.1:${35500 + id}/agentic-human-review`,
        async close() {
          if (id === 1) {
            retiredCloseStarted = true;
            await retiredCloseGate;
          }
        }
      };
    }
  });
  const first = await prepareRuntimeConnection(runtime, 'retired-close-value-one', 0);
  assert.equal((await runtime.beginPromotion(first.pending).commit()).ok, true);
  const second = await prepareRuntimeConnection(runtime, 'retired-close-value-two', 1);
  assert.equal((await runtime.beginPromotion(second.pending).commit()).ok, true);
  await waitFor(() => retiredCloseStarted);
  let shutdownFinished = false;
  const shutdown = runtime.dispose().then(() => { shutdownFinished = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutdownFinished, false);
  releaseRetiredClose();
  await shutdown;
  assert.equal(shutdownFinished, true);
});

test('API setup intersects remote models with the installed catalog and preserves an exact choice', async () => {
  let adapterOptions;
  let adapterEnvironment;
  const runtime = await createControlCenterAiSetupRuntime({ instanceId: INSTANCE_ID }, {
    env: { AGENTIC_HUMAN_REVIEW_OPENAI_MODEL: 'gpt-5.6-luna' },
    async controlCenterAiUpstreamFetch() {
      return new Response(JSON.stringify({
        data: [
          { id: 'gpt-5.7-unsupported', created: 99 },
          { id: 'gpt-5.6-terra', created: 2 },
          { id: 'gpt-5.6-sol', created: 1 }
        ]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    async startControlCenterResponsesAdapter(options, adapterContext) {
      adapterOptions = options;
      adapterEnvironment = adapterContext.env;
      return { url: 'http://127.0.0.1:35601/agentic-human-review', async close() {} };
    }
  });
  try {
    const prepared = await prepareRuntimeConnection(runtime, 'model-choice-value-123', 0);
    assert.deepEqual(prepared.pending.models.map((model) => model.id), ['gpt-5.6-sol', 'gpt-5.6-terra']);
    assert.equal(adapterOptions.providerModel, undefined);
    assert.equal(adapterEnvironment.AGENTIC_HUMAN_REVIEW_OPENAI_MODEL, undefined);
    const promotion = runtime.beginPromotion(prepared.pending);
    assert.equal((await promotion.commit()).ok, true);
    const terra = runtimeBinding(prepared.connection, 'gpt-5.6-terra', 'max');
    assert.equal(runtime.validateBinding(terra), true);
    assert.equal(runtime.validateBinding({ ...terra, model_id: 'gpt-5.7-unsupported' }), false);
    const lease = runtime.acquireExecutionContext({ env: { AGENTIC_HUMAN_REVIEW_OPENAI_MODEL: 'wrong-model' } }, terra);
    assert.equal(lease.ok, true);
    assert.equal(lease.context.env.AGENTIC_HUMAN_REVIEW_OPENAI_MODEL, undefined);
    await lease.release();
  } finally {
    await runtime.dispose();
  }
});

test('API setup reserves credential capacity before asynchronous discovery', async () => {
  let releaseDiscovery;
  let modelCalls = 0;
  const discoveryGate = new Promise((resolve) => { releaseDiscovery = resolve; });
  const runtime = await createControlCenterAiSetupRuntime({ instanceId: INSTANCE_ID }, {
    controlCenterAiCredentialMaxGenerations: 1,
    async controlCenterAiUpstreamFetch() {
      modelCalls += 1;
      await discoveryGate;
      return new Response(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    },
    async startControlCenterResponsesAdapter() {
      return { url: 'http://127.0.0.1:35602/agentic-human-review', async close() {} };
    }
  });
  try {
    const service = runtime.projection().services.find((item) => item.kind === 'api');
    const firstIntent = runtime.createApiSubmission({ service_option_id: service.option_id, expected_revision: 0 });
    const secondIntent = runtime.createApiSubmission({ service_option_id: service.option_id, expected_revision: 0 });
    const firstKey = Buffer.from('capacity-value-one-123');
    const secondKey = Buffer.from('capacity-value-two-123');
    const firstPending = runtime.prepareApiConnection(firstIntent.submission_id, firstKey);
    await waitFor(() => modelCalls === 1);
    const refused = await runtime.prepareApiConnection(secondIntent.submission_id, secondKey);
    firstKey.fill(0);
    secondKey.fill(0);
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, 'CONTROL_CENTER_AI_SETUP_BUSY');
    assert.equal(modelCalls, 1);
    releaseDiscovery();
    const prepared = await firstPending;
    assert.equal(prepared.ok, true);
    await runtime.discardPending(prepared.pending);
  } finally {
    releaseDiscovery();
    await runtime.dispose();
  }
});

test('API setup reserves the total credential byte budget before asynchronous discovery', async () => {
  let releaseDiscovery;
  let modelCalls = 0;
  const discoveryGate = new Promise((resolve) => { releaseDiscovery = resolve; });
  const runtime = await createControlCenterAiSetupRuntime({ instanceId: INSTANCE_ID }, {
    controlCenterAiCredentialMaxTotalBytes: 4096,
    async controlCenterAiUpstreamFetch() {
      modelCalls += 1;
      await discoveryGate;
      return new Response(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    },
    async startControlCenterResponsesAdapter() {
      return { url: 'http://127.0.0.1:35603/agentic-human-review', async close() {} };
    }
  });
  try {
    const service = runtime.projection().services.find((item) => item.kind === 'api');
    const firstIntent = runtime.createApiSubmission({ service_option_id: service.option_id, expected_revision: 0 });
    const secondIntent = runtime.createApiSubmission({ service_option_id: service.option_id, expected_revision: 0 });
    const firstKey = Buffer.alloc(3000, 0x61);
    const secondKey = Buffer.alloc(2000, 0x62);
    const firstPending = runtime.prepareApiConnection(firstIntent.submission_id, firstKey);
    await waitFor(() => modelCalls === 1);
    const refused = await runtime.prepareApiConnection(secondIntent.submission_id, secondKey);
    firstKey.fill(0);
    secondKey.fill(0);
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, 'CONTROL_CENTER_AI_SETUP_BUSY');
    assert.equal(modelCalls, 1);
    releaseDiscovery();
    const prepared = await firstPending;
    assert.equal(prepared.ok, true);
    await runtime.discardPending(prepared.pending);
  } finally {
    releaseDiscovery();
    await runtime.dispose();
  }
});

test('API setup keeps a staged replacement private until persistent refresh commits', async () => {
  let adapterId = 0;
  const runtime = await createControlCenterAiSetupRuntime({ instanceId: INSTANCE_ID }, {
    controlCenterAiUpstreamFetch: fakeModelFetch,
    async startControlCenterResponsesAdapter() {
      adapterId += 1;
      return { url: `http://127.0.0.1:${35610 + adapterId}/agentic-human-review`, async close() {} };
    }
  });
  try {
    const first = await prepareRuntimeConnection(runtime, CREDENTIAL_FIXTURE, 0);
    const firstPromotion = runtime.beginPromotion(first.pending);
    assert.equal((await firstPromotion.commit()).ok, true);
    const second = await prepareRuntimeConnection(runtime, CREDENTIAL_FIXTURE, 1);
    const staged = runtime.beginPromotion(second.pending);
    assert.equal(staged.ok, true);
    assert.equal(staged.connectionSnapshot[0].credential_generation, second.connection.credential_generation);
    assert.equal(runtime.connections()[0].credential_generation, first.connection.credential_generation);
    assert.equal(runtime.acquireExecutionContext({}, runtimeBinding(second.connection)).ok, false);
    assert.equal(runtime.validateBinding(runtimeBinding(first.connection)), true);
    await staged.rollback();
    assert.equal(runtime.validateBinding(runtimeBinding(first.connection)), true);
  } finally {
    await runtime.dispose();
  }
});

test('choosing another AI disconnects a session key only after the selection save commits', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-ai-setup-selection-switch-'));
  const runtime = await createControlCenterAiSetupRuntime({ instanceId: INSTANCE_ID }, {
    controlCenterAiUpstreamFetch: fakeModelFetch,
    async startControlCenterResponsesAdapter() {
      return { url: 'http://127.0.0.1:35618/agentic-human-review', async close() {} };
    }
  });
  const subscription = {
    id: 'configured-subscription',
    display_name: 'Codex',
    connection_type: 'subscription',
    status: 'available',
    status_message: 'Ready to use.',
    adapter_id: 'codex-subscription-cli',
    adapter_version: '1.0.0',
    provider_id: 'codex-subscription-cli',
    transport: 'subscription_cli',
    execution_strategy: 'one-shot',
    provider_effort_request_field: 'model_reasoning_effort',
    provider_capability_hash: 'a'.repeat(64),
    executable_identity_hash: 'b'.repeat(64),
    models: [{
      id: 'gpt-5.6-sol',
      display_name: 'GPT-5.6 Sol',
      native_efforts: [{ id: 'medium', display_name: 'Medium' }],
      default_native_effort_id: 'medium'
    }],
    default_model_id: 'gpt-5.6-sol'
  };
  const context = {
    cwd,
    controlCenterAiSetupRuntime: runtime,
    async discoverControlCenterAiConnections() {
      return {
        connections: [...runtime.connections(), subscription],
        selection: null,
        boundary: { process_spawned: false, network_used: false, credential_values_read: false }
      };
    }
  };
  try {
    const prepared = await prepareRuntimeConnection(runtime, CREDENTIAL_FIXTURE, 0);
    assert.equal((await runtime.beginPromotion(prepared.pending).commit()).ok, true);
    const refreshed = await runControlCenterAiConnectionsRefresh({
      confirm: CONTROL_CENTER_AI_REFRESH_CONFIRM,
      expected_revision: 0
    }, context);
    assert.equal(refreshed.status, 'ok');
    const choice = refreshed.data.ai_connections.connections.find((connection) => connection.name === 'Codex');
    const input = {
      connection_option_id: choice.option_id,
      model_option_id: choice.models[0].option_id,
      effort_option_id: choice.models[0].efforts[0].option_id,
      capability_revision: refreshed.data.ai_connections.revision,
      capability_token: refreshed.data.ai_connections.capability_token,
      expected_revision: refreshed.data.ai_connections.storage_revision,
      confirm: CONTROL_CENTER_AI_SELECTION_CONFIRM
    };
    const conflict = await runControlCenterAiSelectionSave({ ...input, expected_revision: 99 }, context);
    assert.equal(conflict.status, 'error');
    assert.equal(runtime.projection().status, 'connected');

    const selected = await runControlCenterAiSelectionSave(input, context);
    assert.equal(selected.status, 'ok');
    assert.equal(selected.data.ai_connections.selection.connection_name, 'Codex');
    assert.equal(runtime.projection().status, 'not_connected');
    assert.deepEqual(runtime.connections(), []);
  } finally {
    await runtime.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('API setup refuses a staged credential that expires before persistent refresh commits', async () => {
  let now = new Date('2026-07-14T00:00:00.000Z');
  const runtime = await createControlCenterAiSetupRuntime({ instanceId: INSTANCE_ID }, {
    now: () => now,
    controlCenterAiCredentialIdleTtlMs: 100,
    controlCenterAiCredentialAbsoluteTtlMs: 1_000,
    controlCenterAiUpstreamFetch: fakeModelFetch,
    async startControlCenterResponsesAdapter() {
      return { url: 'http://127.0.0.1:35619/agentic-human-review', async close() {} };
    }
  });
  try {
    const prepared = await prepareRuntimeConnection(runtime, CREDENTIAL_FIXTURE, 0);
    const staged = runtime.beginPromotion(prepared.pending);
    now = new Date(now.getTime() + 101);
    const committed = await staged.commit();
    assert.equal(committed.ok, false);
    assert.equal(committed.error.code, 'CONTROL_CENTER_AI_SETUP_CHANGED');
    assert.deepEqual(runtime.connections(), []);
  } finally {
    await runtime.dispose();
  }
});

test('expired API credentials reject new work but retain an acquired immutable lease', async () => {
  let now = new Date('2026-07-14T00:00:00.000Z');
  let closed = false;
  const runtime = await createControlCenterAiSetupRuntime({ instanceId: INSTANCE_ID }, {
    now: () => now,
    controlCenterAiCredentialIdleTtlMs: 100,
    controlCenterAiCredentialAbsoluteTtlMs: 1_000,
    controlCenterAiUpstreamFetch: fakeModelFetch,
    async startControlCenterResponsesAdapter() {
      return { url: 'http://127.0.0.1:35620/agentic-human-review', async close() { closed = true; } };
    }
  });
  try {
    const prepared = await prepareRuntimeConnection(runtime, CREDENTIAL_FIXTURE, 0);
    const promotion = runtime.beginPromotion(prepared.pending);
    assert.equal((await promotion.commit()).ok, true);
    const binding = runtimeBinding(prepared.connection);
    const lease = runtime.acquireExecutionContext({}, binding);
    assert.equal(lease.ok, true);
    now = new Date(now.getTime() + 101);
    assert.equal(runtime.projection().status, 'not_connected');
    assert.equal(runtime.validateBinding(binding), false);
    assert.equal(closed, false);
    await lease.release();
    await waitFor(() => closed);
  } finally {
    await runtime.dispose();
  }
});

test('AI setup shutdown aborts and waits for model discovery without starting an adapter', async () => {
  let releaseDiscovery;
  let discoverySignal;
  let adapterStarts = 0;
  const discoveryGate = new Promise((resolve) => { releaseDiscovery = resolve; });
  const runtime = await createControlCenterAiSetupRuntime({ instanceId: INSTANCE_ID }, {
    env: { PATH: '' },
    async controlCenterAiUpstreamFetch(_url, options = {}) {
      discoverySignal = options.signal;
      await discoveryGate;
      return new Response(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    },
    async startControlCenterResponsesAdapter() {
      adapterStarts += 1;
      return { url: 'http://127.0.0.1:35621/agentic-human-review', async close() {} };
    }
  });
  const service = runtime.projection().services.find((item) => item.kind === 'api');
  const intent = runtime.createApiSubmission({ service_option_id: service.option_id, expected_revision: 0 });
  const key = Buffer.from(CREDENTIAL_FIXTURE);
  const preparing = runtime.prepareApiConnection(intent.submission_id, key);
  key.fill(0);
  await waitFor(() => Boolean(discoverySignal));
  let shutdownFinished = false;
  const shutdown = runtime.dispose().then(() => { shutdownFinished = true; });
  await waitFor(() => discoverySignal.aborted);
  assert.equal(shutdownFinished, false);
  releaseDiscovery();
  const result = await preparing;
  await shutdown;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CONTROL_CENTER_AI_SETUP_UNAVAILABLE');
  assert.equal(adapterStarts, 0);
  assert.deepEqual(runtime.connections(), []);
});

test('AI setup shutdown waits for adapter startup and closes the late adapter', async () => {
  let releaseAdapter;
  let adapterStarting = false;
  let adapterCloses = 0;
  const adapterGate = new Promise((resolve) => { releaseAdapter = resolve; });
  const runtime = await createControlCenterAiSetupRuntime({ instanceId: INSTANCE_ID }, {
    env: { PATH: '' },
    controlCenterAiUpstreamFetch: fakeModelFetch,
    async startControlCenterResponsesAdapter() {
      adapterStarting = true;
      await adapterGate;
      return {
        url: 'http://127.0.0.1:35622/agentic-human-review',
        async close() { adapterCloses += 1; }
      };
    }
  });
  const service = runtime.projection().services.find((item) => item.kind === 'api');
  const intent = runtime.createApiSubmission({ service_option_id: service.option_id, expected_revision: 0 });
  const key = Buffer.from(CREDENTIAL_FIXTURE);
  const preparing = runtime.prepareApiConnection(intent.submission_id, key);
  key.fill(0);
  await waitFor(() => adapterStarting);
  let shutdownFinished = false;
  const firstShutdown = runtime.dispose();
  const secondShutdown = runtime.dispose();
  assert.equal(secondShutdown, firstShutdown);
  const shutdown = firstShutdown.then(() => { shutdownFinished = true; });
  await Promise.resolve();
  assert.equal(shutdownFinished, false);
  releaseAdapter();
  const result = await preparing;
  await shutdown;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CONTROL_CENTER_AI_SETUP_UNAVAILABLE');
  assert.equal(adapterCloses, 1);
  assert.deepEqual(runtime.connections(), []);
});

test('absolute API credential expiry aborts a lease after earlier idle retirement', async () => {
  let now = new Date('2026-07-14T00:00:00.000Z');
  let managedFetch;
  let responseSignal;
  let adapterClosed = false;
  let responseCalls = 0;
  const runtime = await createControlCenterAiSetupRuntime({ instanceId: INSTANCE_ID }, {
    env: { PATH: '' },
    now: () => now,
    controlCenterAiCredentialIdleTtlMs: 100,
    controlCenterAiCredentialAbsoluteTtlMs: 1_000,
    async controlCenterAiUpstreamFetch(url, options = {}) {
      if (String(url).endsWith('/models')) return fakeModelFetch(url, options);
      responseCalls += 1;
      responseSignal = options.signal;
      return new Promise((_resolve, reject) => {
        const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (responseSignal.aborted) abort();
        else responseSignal.addEventListener('abort', abort, { once: true });
      });
    },
    async startControlCenterResponsesAdapter(_options, adapterContext) {
      managedFetch = adapterContext.fetch;
      return {
        url: 'http://127.0.0.1:35623/agentic-human-review',
        async close() { adapterClosed = true; }
      };
    }
  });
  try {
    const prepared = await prepareRuntimeConnection(runtime, CREDENTIAL_FIXTURE, 0);
    assert.equal((await runtime.beginPromotion(prepared.pending).commit()).ok, true);
    const lease = runtime.acquireExecutionContext({}, runtimeBinding(prepared.connection));
    assert.equal(lease.ok, true);
    const pending = managedFetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { authorization: 'Bearer local-adapter-token' },
      body: '{}'
    });
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await waitFor(() => Boolean(responseSignal));
    now = new Date(now.getTime() + 101);
    assert.equal(runtime.projection().status, 'not_connected');
    assert.equal(responseSignal.aborted, false);
    assert.equal(adapterClosed, false);
    now = new Date(now.getTime() + 900);
    await assert.rejects(managedFetch('https://api.openai.com/v1/responses', { method: 'POST' }), /destination changed/u);
    await rejected;
    await waitFor(() => adapterClosed);
    assert.equal(runtime.projection().status, 'not_connected');
    assert.equal(responseSignal.aborted, true);
    assert.equal(responseCalls, 1);
    await lease.release();
  } finally {
    await runtime.dispose();
  }
});

test('absolute API credential expiry closes a leased generation after replace or disconnect', async () => {
  for (const retirement of ['replace', 'disconnect']) {
    let now = new Date('2026-07-14T00:00:00.000Z');
    const managedFetches = [];
    const closed = [];
    let responseCalls = 0;
    const runtime = await createControlCenterAiSetupRuntime({ instanceId: INSTANCE_ID }, {
      env: { PATH: '' },
      now: () => now,
      controlCenterAiCredentialIdleTtlMs: 100,
      controlCenterAiCredentialAbsoluteTtlMs: 1_000,
      async controlCenterAiUpstreamFetch(url, options = {}) {
        if (String(url).endsWith('/models')) return fakeModelFetch(url, options);
        responseCalls += 1;
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
      async startControlCenterResponsesAdapter(_options, adapterContext) {
        const id = managedFetches.length + 1;
        managedFetches.push(adapterContext.fetch);
        return {
          url: `http://127.0.0.1:${35630 + id}/agentic-human-review`,
          async close() { closed.push(id); }
        };
      }
    });
    try {
      const first = await prepareRuntimeConnection(runtime, CREDENTIAL_FIXTURE, 0);
      assert.equal((await runtime.beginPromotion(first.pending).commit()).ok, true);
      const lease = runtime.acquireExecutionContext({}, runtimeBinding(first.connection));
      assert.equal(lease.ok, true);

      if (retirement === 'replace') {
        const second = await prepareRuntimeConnection(runtime, CREDENTIAL_FIXTURE, 1);
        assert.equal((await runtime.beginPromotion(second.pending).commit()).ok, true);
      } else {
        const disconnect = runtime.beginDisconnect();
        assert.equal(disconnect.ok, true);
        await disconnect.commit();
      }
      assert.equal(closed.includes(1), false);

      now = new Date(now.getTime() + 1_001);
      await assert.rejects(
        managedFetches[0]('https://api.openai.com/v1/responses', { method: 'POST' }),
        /destination changed/u
      );
      await waitFor(() => closed.includes(1));
      assert.equal(responseCalls, 0);
      await lease.release();
    } finally {
      await runtime.dispose();
    }
  }
});

test('API setup aborts an active upstream request before closing its adapter', async () => {
  let managedFetch;
  let responseSignal;
  let adapterClosed = false;
  const runtime = await createControlCenterAiSetupRuntime({ instanceId: INSTANCE_ID }, {
    env: { PATH: '' },
    controlCenterAiUpstreamFetch(url, options = {}) {
      if (String(url).endsWith('/models')) {
        return Promise.resolve(new Response(JSON.stringify({ data: [{ id: 'gpt-5.6-sol', created: 1 }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }));
      }
      responseSignal = options.signal;
      return new Promise((_resolve, reject) => {
        const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (responseSignal.aborted) abort();
        else responseSignal.addEventListener('abort', abort, { once: true });
      });
    },
    async startControlCenterResponsesAdapter(_options, adapterContext) {
      managedFetch = adapterContext.fetch;
      return {
        url: 'http://127.0.0.1:35555/agentic-human-review',
        async close() {
          assert.equal(responseSignal.aborted, true);
          adapterClosed = true;
        }
      };
    }
  });
  const prepared = await prepareRuntimeConnection(runtime, 'replacement-key-abort', 0);
  const promotion = runtime.beginPromotion(prepared.pending);
  await promotion.commit();
  const pending = managedFetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { authorization: 'Bearer local-adapter-token' },
    body: '{}'
  });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await waitFor(() => Boolean(responseSignal));
  await runtime.dispose();
  await rejected;
  assert.equal(adapterClosed, true);
});

test('API model discovery never retries provider refusal and rejects non-JSON model data', async () => {
  for (const scenario of [
    { status: 401, contentType: 'application/json', code: 'CONTROL_CENTER_AI_KEY_REJECTED' },
    { status: 429, contentType: 'application/json', code: 'CONTROL_CENTER_AI_CONNECTION_UNAVAILABLE' },
    { status: 200, contentType: 'text/html', code: 'CONTROL_CENTER_AI_MODEL_LIST_INVALID' }
  ]) {
    let calls = 0;
    const runtime = await createControlCenterAiSetupRuntime({ instanceId: INSTANCE_ID }, {
      env: { PATH: '' },
      async controlCenterAiUpstreamFetch() {
        calls += 1;
        return new Response(scenario.status === 200 ? '<html>not models</html>' : '{}', {
          status: scenario.status,
          headers: { 'content-type': scenario.contentType }
        });
      },
      async startControlCenterResponsesAdapter() {
        assert.fail('An adapter must not start after model discovery rejection.');
      }
    });
    try {
      const service = runtime.projection().services.find((item) => item.kind === 'api');
      const intent = runtime.createApiSubmission({ service_option_id: service.option_id, expected_revision: 0 });
      const key = Buffer.from(CREDENTIAL_FIXTURE);
      const prepared = await runtime.prepareApiConnection(intent.submission_id, key);
      key.fill(0);
      assert.equal(prepared.ok, false);
      assert.equal(prepared.error.code, scenario.code);
      assert.equal(calls, 1);
    } finally {
      await runtime.dispose();
    }
  }
});

test('paired server accepts bounded API setup and retires its key only after a subscription switch commits', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-ai-setup-'));
  const assets = path.join(cwd, 'assets');
  let modelRequestCount = 0;
  let adapterCloseCount = 0;
  let loginStatus = 'idle';
  const availableConnections = [subscriptionConnection()];
  await mkdir(assets, { recursive: true });
  await writeFile(path.join(assets, 'index.html'), '<!doctype html><title>Control Center</title>', 'utf8');
  const started = await startControlCenterServer({ port: 0, assetRoot: assets, authorizationMode: 'paired' }, {
    cwd,
    env: { PATH: '' },
    controlCenterAiConnections: availableConnections,
    controlCenterCodexLoginManager: {
      status() {
        return {
          status: loginStatus,
          operation_id: loginStatus === 'idle' ? null : 'login-operation',
          verification_url: null,
          user_code: null,
          message: loginStatus === 'complete' ? 'Codex is ready to use.' : 'Codex is connected.',
          can_cancel: false,
          raw_output_included: false,
          technical_details_included: false
        };
      },
      async start() {
        loginStatus = 'connected';
        return { ok: true, login: this.status() };
      },
      async cancel() { return { ok: false, error: { code: 'NOT_ACTIVE', message: 'Not active.' } }; },
      markFinalized() { loginStatus = 'complete'; return this.status(); },
      async dispose() {}
    },
    async controlCenterAiUpstreamFetch(url, options) {
      modelRequestCount += 1;
      return fakeModelFetch(url, options);
    },
    async startControlCenterResponsesAdapter() {
      return {
        url: 'http://127.0.0.1:34568/agentic-human-review',
        async close() { adapterCloseCount += 1; }
      };
    }
  });
  try {
    assert.equal((await fetch(new URL('/api/dashboard', started.url))).status, 403);
    const origin = started.url.slice(0, -1);
    assert.doesNotMatch(JSON.stringify(started.metadata), new RegExp(started.managementCapability));
    const wrongOrigin = await fetch(new URL('/api/pairing/issue', started.url), {
      method: 'POST',
      headers: { Origin: 'https://example.invalid', 'X-Trace-Cue-Management-Token': started.managementCapability }
    });
    assert.equal(wrongOrigin.status, 403);
    const issue = await fetch(new URL('/api/pairing/issue', started.url), {
      method: 'POST',
      headers: { Origin: origin, 'X-Trace-Cue-Management-Token': started.managementCapability }
    });
    assert.equal(issue.status, 201);
    const pairing = await issue.json();
    const exchange = await fetch(new URL('/api/pairing/exchange', started.url), {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/octet-stream' },
      body: pairing.pairing_token
    });
    assert.equal(exchange.status, 200);
    const session = await exchange.json();
    const replayExchange = await fetch(new URL('/api/pairing/exchange', started.url), {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/octet-stream' },
      body: pairing.pairing_token
    });
    assert.equal(replayExchange.status, 403);
    const getHeaders = { 'X-Trace-Cue-Session-Token': session.session_token };
    const actionHeaders = {
      ...getHeaders,
      Origin: origin,
      'X-Trace-Cue-Action-Token': session.action_token
    };
    const dashboardResponse = await fetch(new URL('/api/dashboard', started.url), { headers: getHeaders });
    assert.equal(dashboardResponse.status, 200);
    const dashboard = await dashboardResponse.json();
    assert.equal(dashboard.data.control_center.action_security.token, undefined);
    const service = dashboard.data.control_center.ai_setup.services.find((item) => item.kind === 'api');
    const intentResponse = await fetch(new URL('/api/settings/ai-setup/intents', started.url), {
      method: 'POST',
      headers: { ...actionHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ service_option_id: service.option_id, expected_revision: 0 })
    });
    assert.equal(intentResponse.status, 201);
    const intent = await intentResponse.json();
    const encodedResponse = await fetch(new URL('/api/settings/ai-setup/key', started.url), {
      method: 'POST',
      headers: {
        ...actionHeaders,
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'gzip',
        'X-Trace-Cue-Secret-Submission': intent.data.ai_setup_submission.submission_id
      },
      body: Buffer.from(CREDENTIAL_FIXTURE)
    });
    assert.equal(encodedResponse.status, 415);
    const jsonSecretResponse = await fetch(new URL('/api/settings/ai-setup/key', started.url), {
      method: 'POST',
      headers: {
        ...actionHeaders,
        'Content-Type': 'application/json',
        'X-Trace-Cue-Secret-Submission': intent.data.ai_setup_submission.submission_id
      },
      body: JSON.stringify({ key: CREDENTIAL_FIXTURE })
    });
    assert.equal(jsonSecretResponse.status, 415);
    const keyResponse = await fetch(new URL('/api/settings/ai-setup/key', started.url), {
      method: 'POST',
      headers: {
        ...actionHeaders,
        'Content-Type': 'application/octet-stream',
        'X-Trace-Cue-Secret-Submission': intent.data.ai_setup_submission.submission_id
      },
      body: Buffer.from(CREDENTIAL_FIXTURE)
    });
    assert.equal(keyResponse.status, 200, await keyResponse.text());
    assert.equal(modelRequestCount, 1);
    const replayKeyResponse = await fetch(new URL('/api/settings/ai-setup/key', started.url), {
      method: 'POST',
      headers: {
        ...actionHeaders,
        'Content-Type': 'application/octet-stream',
        'X-Trace-Cue-Secret-Submission': intent.data.ai_setup_submission.submission_id
      },
      body: Buffer.from(CREDENTIAL_FIXTURE)
    });
    assert.equal(replayKeyResponse.status, 400);
    assert.doesNotMatch(await replayKeyResponse.text(), new RegExp(CREDENTIAL_FIXTURE));
    assert.equal(modelRequestCount, 1);

    const oversizedIntentResponse = await fetch(new URL('/api/settings/ai-setup/intents', started.url), {
      method: 'POST',
      headers: { ...actionHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ service_option_id: service.option_id, expected_revision: 0 })
    });
    const oversizedIntent = await oversizedIntentResponse.json();
    const oversizedSecretResponse = await fetch(new URL('/api/settings/ai-setup/key', started.url), {
      method: 'POST',
      headers: {
        ...actionHeaders,
        'Content-Type': 'application/octet-stream',
        'X-Trace-Cue-Secret-Submission': oversizedIntent.data.ai_setup_submission.submission_id
      },
      body: Buffer.alloc(4097, 0x61)
    });
    assert.equal(oversizedSecretResponse.status, 413);

    const invalidIntentResponse = await fetch(new URL('/api/settings/ai-setup/intents', started.url), {
      method: 'POST',
      headers: { ...actionHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ service_option_id: service.option_id, expected_revision: 0 })
    });
    const invalidIntent = await invalidIntentResponse.json();
    const invalidSecretResponse = await fetch(new URL('/api/settings/ai-setup/key', started.url), {
      method: 'POST',
      headers: {
        ...actionHeaders,
        'Content-Type': 'application/octet-stream',
        'X-Trace-Cue-Secret-Submission': invalidIntent.data.ai_setup_submission.submission_id
      },
      body: Buffer.from([0xc3, 0x28, 0x61, 0x61, 0x61, 0x61, 0x61, 0x61])
    });
    assert.equal(invalidSecretResponse.status, 400);
    const invalidReplayResponse = await fetch(new URL('/api/settings/ai-setup/key', started.url), {
      method: 'POST',
      headers: {
        ...actionHeaders,
        'Content-Type': 'application/octet-stream',
        'X-Trace-Cue-Secret-Submission': invalidIntent.data.ai_setup_submission.submission_id
      },
      body: Buffer.from(CREDENTIAL_FIXTURE)
    });
    assert.equal(invalidReplayResponse.status, 400);
    assert.equal(modelRequestCount, 1);
    const connectedResponse = await fetch(new URL('/api/dashboard', started.url), { headers: getHeaders });
    const connected = await connectedResponse.json();
    const connectedText = JSON.stringify(connected);
    assert.match(connectedText, /"status":"connected"/u);
    assert.doesNotMatch(connectedText, new RegExp(CREDENTIAL_FIXTURE));

    const subscription = connected.data.control_center.ai_setup.services.find((item) => item.kind === 'subscription');
    const expectedRevision = connected.data.control_center.ai_connections.storage_revision;
    const loginResponse = await fetch(new URL('/api/settings/ai-setup/subscription/start', started.url), {
      method: 'POST',
      headers: { ...actionHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ service_option_id: subscription.option_id, expected_revision: expectedRevision })
    });
    assert.equal(loginResponse.status, 202, await loginResponse.text());
    assert.equal(adapterCloseCount, 0);

    availableConnections.length = 0;
    const unavailableFinishResponse = await fetch(new URL('/api/settings/ai-setup/subscription/finish', started.url), {
      method: 'POST',
      headers: { ...actionHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'finish-ai-sign-in', expected_revision: expectedRevision })
    });
    assert.equal(unavailableFinishResponse.status, 400, await unavailableFinishResponse.text());
    assert.equal(adapterCloseCount, 0);
    const unchanged = await (await fetch(new URL('/api/dashboard', started.url), { headers: getHeaders })).json();
    assert.equal(unchanged.data.control_center.ai_setup.status, 'connected');
    assert.equal(unchanged.data.control_center.ai_connections.storage_revision, expectedRevision);

    availableConnections.push(subscriptionConnection());
    const finishResponse = await fetch(new URL('/api/settings/ai-setup/subscription/finish', started.url), {
      method: 'POST',
      headers: { ...actionHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'finish-ai-sign-in', expected_revision: expectedRevision })
    });
    assert.equal(finishResponse.status, 200, await finishResponse.text());
    assert.equal(adapterCloseCount, 1);
    const switched = await (await fetch(new URL('/api/dashboard', started.url), { headers: getHeaders })).json();
    assert.equal(switched.data.control_center.ai_setup.connection, null);
    const selectedConnection = switched.data.control_center.ai_connections.connections.find(
      (item) => item.option_id === switched.data.control_center.ai_connections.selection.connection_option_id
    );
    assert.equal(selectedConnection.kind, 'subscription');
    assert.doesNotMatch(JSON.stringify(switched), new RegExp(CREDENTIAL_FIXTURE));
  } finally {
    await started.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('paired server restores its connection record when API promotion expires after storage', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-ai-setup-expiry-'));
  const assets = path.join(cwd, 'assets');
  let now = new Date('2026-07-14T00:00:00.000Z');
  let storedRecord = null;
  let writes = 0;
  let adapterCloses = 0;
  await mkdir(assets, { recursive: true });
  await writeFile(path.join(assets, 'index.html'), '<!doctype html><title>Control Center</title>', 'utf8');
  const started = await startControlCenterServer({ port: 0, assetRoot: assets, authorizationMode: 'paired' }, {
    cwd,
    env: { PATH: '' },
    now: () => now,
    controlCenterAiConnections: [],
    controlCenterAiCredentialIdleTtlMs: 100,
    controlCenterAiCredentialAbsoluteTtlMs: 1_000,
    createControlCenterAiConnectionStore() {
      return {
        async withLock(_name, task) { return task(); },
        async readJson() {
          if (storedRecord) return structuredClone(storedRecord);
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        },
        async writeJson(_name, value) {
          storedRecord = structuredClone(value);
          writes += 1;
          if (writes === 1) now = new Date(now.getTime() + 101);
        },
        async removeFile() { storedRecord = null; }
      };
    },
    controlCenterAiUpstreamFetch: fakeModelFetch,
    async startControlCenterResponsesAdapter() {
      return {
        url: 'http://127.0.0.1:35624/agentic-human-review',
        async close() { adapterCloses += 1; }
      };
    }
  });
  try {
    const session = await pairWithControlCenter(started);
    const dashboard = await (await fetch(new URL('/api/dashboard', started.url), { headers: session.getHeaders })).json();
    const service = dashboard.data.control_center.ai_setup.services.find((item) => item.kind === 'api');
    const intentResponse = await fetch(new URL('/api/settings/ai-setup/intents', started.url), {
      method: 'POST',
      headers: { ...session.actionHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ service_option_id: service.option_id, expected_revision: 0 })
    });
    const intent = await intentResponse.json();
    const response = await fetch(new URL('/api/settings/ai-setup/key', started.url), {
      method: 'POST',
      headers: {
        ...session.actionHeaders,
        'Content-Type': 'application/octet-stream',
        'X-Trace-Cue-Secret-Submission': intent.data.ai_setup_submission.submission_id
      },
      body: Buffer.from(CREDENTIAL_FIXTURE)
    });
    assert.equal(response.status, 409, await response.text());
    assert.equal(storedRecord, null);
    assert.equal(adapterCloses, 1);
    const current = await (await fetch(new URL('/api/dashboard', started.url), { headers: session.getHeaders })).json();
    assert.equal(current.data.control_center.ai_setup.status, 'not_connected');
    assert.equal(current.data.control_center.ai_connections.storage_revision, 0);
  } finally {
    await started.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('paired server restores the previous selected connection when API promotion expires after storage', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-ai-setup-previous-restore-'));
  const assets = path.join(cwd, 'assets');
  let now = new Date('2026-07-14T00:00:00.000Z');
  const previousRecord = createControlCenterAiConnectionRecord({
    connections: [subscriptionConnection()],
    observedAt: now
  });
  let storedRecord = structuredClone(previousRecord);
  let writes = 0;
  let adapterCloses = 0;
  await mkdir(assets, { recursive: true });
  await writeFile(path.join(assets, 'index.html'), '<!doctype html><title>Control Center</title>', 'utf8');
  const started = await startControlCenterServer({ port: 0, assetRoot: assets, authorizationMode: 'paired' }, {
    cwd,
    env: { PATH: '' },
    now: () => now,
    controlCenterAiConnections: [],
    controlCenterAiCredentialIdleTtlMs: 100,
    controlCenterAiCredentialAbsoluteTtlMs: 1_000,
    createControlCenterAiConnectionStore() {
      return {
        async withLock(_name, task) { return task(); },
        async readJson() { return structuredClone(storedRecord); },
        async writeJson(_name, value) {
          storedRecord = structuredClone(value);
          writes += 1;
          if (writes === 1) now = new Date(now.getTime() + 101);
        },
        async removeFile() { storedRecord = null; }
      };
    },
    controlCenterAiUpstreamFetch: fakeModelFetch,
    async startControlCenterResponsesAdapter() {
      return {
        url: 'http://127.0.0.1:35625/agentic-human-review',
        async close() { adapterCloses += 1; }
      };
    }
  });
  try {
    const session = await pairWithControlCenter(started);
    const dashboard = await (await fetch(new URL('/api/dashboard', started.url), { headers: session.getHeaders })).json();
    const service = dashboard.data.control_center.ai_setup.services.find((item) => item.kind === 'api');
    const intentResponse = await fetch(new URL('/api/settings/ai-setup/intents', started.url), {
      method: 'POST',
      headers: { ...session.actionHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_option_id: service.option_id,
        expected_revision: previousRecord.settings_revision
      })
    });
    const intent = await intentResponse.json();
    const response = await fetch(new URL('/api/settings/ai-setup/key', started.url), {
      method: 'POST',
      headers: {
        ...session.actionHeaders,
        'Content-Type': 'application/octet-stream',
        'X-Trace-Cue-Secret-Submission': intent.data.ai_setup_submission.submission_id
      },
      body: Buffer.from(CREDENTIAL_FIXTURE)
    });
    assert.equal(response.status, 409, await response.text());
    assert.deepEqual(storedRecord, previousRecord);
    assert.equal(writes, 2);
    assert.equal(adapterCloses, 1);
    const current = await (await fetch(new URL('/api/dashboard', started.url), { headers: session.getHeaders })).json();
    assert.equal(current.data.control_center.ai_setup.status, 'not_connected');
    assert.equal(current.data.control_center.ai_connections.storage_revision, previousRecord.settings_revision);
    const selected = current.data.control_center.ai_connections.connections.find(
      (item) => item.option_id === current.data.control_center.ai_connections.selection.connection_option_id
    );
    assert.equal(selected.kind, 'subscription');
    assert.equal(current.data.control_center.ai_connections.connections.some((item) => item.kind === 'api'), false);
  } finally {
    await started.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

async function prepareRuntimeConnection(runtime, keyText, expectedRevision) {
  const service = runtime.projection().services.find((item) => item.kind === 'api');
  const intent = runtime.createApiSubmission({ service_option_id: service.option_id, expected_revision: expectedRevision });
  const key = Buffer.from(keyText);
  try {
    const prepared = await runtime.prepareApiConnection(intent.submission_id, key);
    assert.equal(prepared.ok, true);
    return prepared;
  } finally {
    key.fill(0);
  }
}

async function pairWithControlCenter(started) {
  const origin = started.url.slice(0, -1);
  const issue = await fetch(new URL('/api/pairing/issue', started.url), {
    method: 'POST',
    headers: { Origin: origin, 'X-Trace-Cue-Management-Token': started.managementCapability }
  });
  assert.equal(issue.status, 201);
  const pairing = await issue.json();
  const exchange = await fetch(new URL('/api/pairing/exchange', started.url), {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/octet-stream' },
    body: pairing.pairing_token
  });
  assert.equal(exchange.status, 200);
  const session = await exchange.json();
  return {
    getHeaders: { 'X-Trace-Cue-Session-Token': session.session_token },
    actionHeaders: {
      Origin: origin,
      'X-Trace-Cue-Session-Token': session.session_token,
      'X-Trace-Cue-Action-Token': session.action_token
    }
  };
}

function runtimeBinding(connection, modelId = connection.default_model_id, effortId = null) {
  const model = connection.models.find((candidate) => candidate.id === modelId)
    ?? connection.models[0];
  const effort = model.native_efforts.find((candidate) => candidate.id === (effortId ?? model.default_native_effort_id))
    ?? model.native_efforts[0];
  return {
    runtime_instance_id: connection.runtime_instance_id,
    credential_generation: connection.credential_generation,
    profile_revision: connection.profile_revision,
    configuration_identity_hash: connection.configuration_identity_hash,
    model_id: model.id,
    provider_effort: effort.id
  };
}

async function fakeModelFetch(url, options = {}) {
  assert.equal(String(url), 'https://api.openai.com/v1/models');
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers.authorization, `Bearer ${CREDENTIAL_FIXTURE}`);
  return new Response(JSON.stringify({
    data: [
      { id: 'gpt-5.6-terra', created: 2 },
      { id: 'gpt-5.6-sol', created: 1 },
      { id: 'embedding-test', created: 3 }
    ]
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function subscriptionConnection() {
  return {
    id: 'codex-subscription',
    display_name: 'Codex',
    connection_type: 'subscription',
    status: 'available',
    status_message: 'Ready to use.',
    adapter_id: 'codex-subscription-cli',
    adapter_version: '1.0.0',
    provider_id: 'codex-subscription-cli',
    transport: 'subscription_cli',
    execution_strategy: 'one-shot',
    provider_effort_request_field: 'model_reasoning_effort',
    provider_capability_hash: 'b'.repeat(64),
    executable_identity_hash: 'c'.repeat(64),
    models: [{
      id: 'provider/review-model',
      display_name: 'Review Model',
      native_efforts: [{ id: 'medium', display_name: 'Recommended' }],
      default_native_effort_id: 'medium'
    }],
    default_model_id: 'provider/review-model'
  };
}

function fakeLoginChild({ closeOnKill = false } = {}) {
  const child = new EventEmitter();
  child.pid = 987654321;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killSignals = [];
  child.spawned = false;
  child.on('spawn', () => { child.spawned = true; });
  child.kill = (signal) => {
    child.killSignals.push(signal);
    if (closeOnKill) queueMicrotask(() => child.emit('close', null, signal));
    return true;
  };
  return child;
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for test state.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForJson(file, predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const value = JSON.parse(await readFile(file, 'utf8'));
      if (predicate(value)) return value;
    } catch {}
    if (Date.now() >= deadline) throw new Error('Timed out waiting for stable JSON test state.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
