import { once } from 'node:events';
import { spawn as defaultSpawn } from 'node:child_process';
import path from 'node:path';
import {
  buildControlCenterRuntimeCompatibility,
  startControlCenterServer
} from './control-center-server.js';
import { captureProcessIdentity, createSafeLocalStore } from './safe-local-store.js';

const RUNTIME_DIRECTORY = 'control-center-runtime';
const RUNTIME_RECEIPT = 'server.json';
const HEALTH_TIMEOUT_MS = 2000;

export async function runControlCenterLaunch(options = {}, context = {}) {
  const cwd = path.resolve(context.cwd ?? process.cwd());
  const store = runtimeStore(cwd, options['artifact-root']);
  const expectedCompatibility = await buildControlCenterRuntimeCompatibility(context.controlCenterAssetRoot);
  const existing = await readHealthyRuntime(store, context, expectedCompatibility);
  if (existing) {
    const opened = await openControlCenterUrl(existing.url, context);
    return launchResult({ url: existing.url, reused: true, opened, closed: false });
  }

  try {
    return await store.withLock('server', async () => {
      const raced = await readHealthyRuntime(store, context, expectedCompatibility);
      if (raced) {
        const opened = await openControlCenterUrl(raced.url, context);
        return launchResult({ url: raced.url, reused: true, opened, closed: false });
      }
      const serverStarter = context.startControlCenterServer ?? startControlCenterServer;
      const started = await serverStarter({
        host: options.host,
        port: options.port,
        'artifact-root': options['artifact-root'],
        assetRoot: context.controlCenterAssetRoot
      }, context);
      const health = await readHealthRuntime(started.url, context);
      if (!health || !sameCompatibility(health, expectedCompatibility)) {
        await closeServer(started.server);
        throw launcherError('CONTROL_CENTER_LAUNCH_HEALTH_FAILED', 'The local Control Center did not become ready.');
      }
      const asset = await fetchWithTimeout(started.url, context);
      if (!asset?.ok) {
        await closeServer(started.server);
        throw launcherError('CONTROL_CENTER_LAUNCH_ASSETS_UNAVAILABLE', 'The installed Control Center screen is unavailable.');
      }
      const receipt = {
        schema_version: '1.0.0',
        type: 'control_center_runtime',
        url: started.url,
        instance_id: health.instance_id,
        protocol_version: health.protocol_version,
        package_version: health.package_version,
        asset_fingerprint: health.asset_fingerprint,
        owner: {
          pid: process.pid,
          process_identity: await captureProcessIdentity(process.pid)
        },
        started_at: new Date().toISOString()
      };
      await store.writeJson(RUNTIME_RECEIPT, receipt, { maxBytes: 16 * 1024 });
      const opened = await openControlCenterUrl(started.url, context);
      writeLaunchNotice(started.url, opened, context);
      const removeSignalHandlers = attachCloseSignals(started.server, context.signal);
      try {
        await once(started.server, 'close');
      } finally {
        removeSignalHandlers();
        await removeOwnedRuntime(store, health.instance_id);
      }
      return launchResult({ url: started.url, reused: false, opened, closed: true });
    }, { timeoutMs: 1500 });
  } catch (error) {
    if (error?.code === 'SAFE_STORE_LOCK_TIMEOUT') {
      const winner = await waitForHealthyRuntime(store, context, expectedCompatibility);
      if (winner) {
        const opened = await openControlCenterUrl(winner.url, context);
        return launchResult({ url: winner.url, reused: true, opened, closed: false });
      }
      if (await hasIncompatibleLiveRuntime(store, context, expectedCompatibility)) {
        throw launcherError(
          'CONTROL_CENTER_LAUNCH_INCOMPATIBLE_RUNTIME',
          'Close the previous local Control Center before opening this version.'
        );
      }
    }
    throw error;
  }
}

async function hasIncompatibleLiveRuntime(store, context, expectedCompatibility) {
  try {
    const receipt = await store.readJson(RUNTIME_RECEIPT, { maxBytes: 16 * 1024 });
    validateLoopbackUrl(receipt.url);
    const health = await readHealthRuntime(receipt.url, context);
    return health?.instance_id === receipt.instance_id
      && !sameCompatibility(health, expectedCompatibility);
  } catch {
    return false;
  }
}

export async function openControlCenterUrl(url, context = {}) {
  validateLoopbackUrl(url);
  if (typeof context.openUrl === 'function') {
    try { await context.openUrl(url); return true; } catch { return false; }
  }
  for (const candidate of openerCandidates(context.platform ?? process.platform, context.env ?? process.env)) {
    try {
      await spawnDetached(candidate.command, [...candidate.args, url], context);
      return true;
    } catch {}
  }
  return false;
}

async function readHealthyRuntime(store, context, expectedCompatibility) {
  try {
    const receipt = await store.readJson(RUNTIME_RECEIPT, { maxBytes: 16 * 1024 });
    if (receipt?.type !== 'control_center_runtime' || typeof receipt.instance_id !== 'string') return null;
    validateLoopbackUrl(receipt.url);
    if (!sameCompatibility(receipt, expectedCompatibility)) return null;
    const health = await readHealthRuntime(receipt.url, context);
    return health?.instance_id === receipt.instance_id
      && sameCompatibility(health, expectedCompatibility)
      ? receipt
      : null;
  } catch {
    return null;
  }
}

async function waitForHealthyRuntime(store, context, expectedCompatibility) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const runtime = await readHealthyRuntime(store, context, expectedCompatibility);
    if (runtime) return runtime;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

async function readHealthRuntime(baseUrl, context) {
  try {
    const response = await fetchWithTimeout(new URL('/api/health', baseUrl), context);
    if (!response?.ok) return null;
    const body = await response.json();
    return body?.status === 'ok'
      && typeof body.instance_id === 'string'
      && typeof body.protocol_version === 'string'
      && typeof body.package_version === 'string'
      && typeof body.asset_fingerprint === 'string'
      ? body
      : null;
  } catch {
    return null;
  }
}

function sameCompatibility(value, expected) {
  return value?.protocol_version === expected.protocol_version
    && value?.package_version === expected.package_version
    && value?.asset_fingerprint === expected.asset_fingerprint;
}

function fetchWithTimeout(url, context) {
  const fetchImpl = context.fetch ?? globalThis.fetch;
  return fetchImpl(url, { method: 'GET', cache: 'no-store', signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
}

function runtimeStore(cwd, artifactRootInput) {
  const relativeRoot = resolveArtifactRoot(cwd, artifactRootInput);
  return createSafeLocalStore({
    workspaceRoot: cwd,
    relativeRoot: path.join(relativeRoot, RUNTIME_DIRECTORY),
    namespace: 'control-center-runtime',
    maxRecordBytes: 16 * 1024,
    maxEntries: 4
  });
}

function resolveArtifactRoot(cwd, value) {
  const input = typeof value === 'string' && value.trim() ? value.trim() : '.browser-debug';
  if (path.isAbsolute(input)) throw launcherError('CONTROL_CENTER_LAUNCH_ARTIFACT_ROOT_REJECTED', 'The local data location must stay in this workspace.');
  const absolute = path.resolve(cwd, input);
  const relative = path.relative(cwd, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw launcherError('CONTROL_CENTER_LAUNCH_ARTIFACT_ROOT_REJECTED', 'The local data location must stay in this workspace.');
  }
  return relative;
}

function openerCandidates(platform, env) {
  if (platform === 'darwin') return [{ command: 'open', args: [] }];
  if (platform === 'win32') return [{ command: 'rundll32', args: ['url.dll,FileProtocolHandler'] }];
  if (platform === 'linux' && (env.WSL_DISTRO_NAME || env.WSL_INTEROP)) {
    return [
      { command: 'wslview', args: [] },
      { command: '/mnt/c/Windows/explorer.exe', args: [] },
      { command: 'xdg-open', args: [] }
    ];
  }
  if (platform === 'linux') return [{ command: 'xdg-open', args: [] }];
  return [];
}

function spawnDetached(command, args, context) {
  const spawnImpl = context.spawn ?? defaultSpawn;
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      shell: false,
      detached: true,
      stdio: 'ignore',
      env: safeOpenerEnvironment(context.env ?? process.env)
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref?.();
      resolve();
    });
  });
}

function safeOpenerEnvironment(env) {
  const allowed = ['PATH', 'HOME', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'WSL_DISTRO_NAME', 'WSL_INTEROP', 'SystemRoot', 'WINDIR'];
  return Object.fromEntries(allowed.filter((key) => typeof env[key] === 'string').map((key) => [key, env[key]]));
}

function attachCloseSignals(server, signal) {
  const close = () => { if (server.listening) server.close(); };
  const signals = ['SIGINT', 'SIGTERM'];
  for (const name of signals) process.once(name, close);
  if (signal) {
    if (signal.aborted) close();
    else signal.addEventListener('abort', close, { once: true });
  }
  return () => {
    for (const name of signals) process.off(name, close);
    signal?.removeEventListener?.('abort', close);
  };
}

async function removeOwnedRuntime(store, instanceId) {
  try {
    const current = await store.readJson(RUNTIME_RECEIPT, { maxBytes: 16 * 1024 });
    if (current?.instance_id === instanceId) await store.removeFile(RUNTIME_RECEIPT, { maxBytes: 16 * 1024 });
  } catch {}
}

function writeLaunchNotice(url, opened, context) {
  const stderr = context.stderr ?? process.stderr;
  stderr.write(`${JSON.stringify({ event: 'control_center_ready', url, browser_opened: opened })}\n`);
}

function validateLoopbackUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/') {
    throw launcherError('CONTROL_CENTER_LAUNCH_URL_REJECTED', 'The Control Center URL is not a safe local address.');
  }
  return url;
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function launchResult({ url, reused, opened, closed }) {
  return {
    status: 'ok',
    data: {
      control_center_launch: {
        status: closed ? 'closed' : 'ready',
        url,
        reused_existing_server: reused,
        browser_opened: opened,
        command_input_accepted: false,
        shell_used: false
      }
    },
    warnings: opened ? [] : [{ code: 'CONTROL_CENTER_BROWSER_NOT_OPENED', message: `Open ${url} in a browser.` }],
    errors: [],
    artifacts: []
  };
}

function launcherError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
