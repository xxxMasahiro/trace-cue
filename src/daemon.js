import { spawn as defaultSpawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ARTIFACT_ROOT, SCHEMA_VERSION } from './constants.js';
import {
  artifactObject,
  artifactRelPath,
  createArtifactId,
  ensureArtifactRoot,
  readJsonArtifact,
  writeJsonArtifact
} from './artifacts.js';
import { normalizeTimeout, validateUrl } from './observe.js';
import { redact, truncateText } from './redaction.js';

const DAEMON_READY_TIMEOUT_MS = 10000;
const DAEMON_STOP_TIMEOUT_MS = 5000;
const DAEMON_POLL_INTERVAL_MS = 100;

export async function startDaemon(options = {}, context = {}) {
  const cwd = context.cwd ?? process.cwd();
  const artifactRoot = options['artifact-root'] ?? DEFAULT_ARTIFACT_ROOT;
  const now = materializeNow(context.now);
  const id = context.createId?.('daemon', now) ?? createArtifactId(now, 'daemon');
  let timeout;
  try {
    timeout = normalizeTimeout(options.timeout);
  } catch (error) {
    return daemonError('INVALID_TIMEOUT', error.message, { timeout: options.timeout });
  }

  const urlError = validateUrl(options.url);
  if (urlError) {
    return daemonError(urlError.code, urlError.message, urlError.details);
  }

  let root;
  try {
    root = await ensureArtifactRoot(cwd, artifactRoot);
  } catch (error) {
    return daemonError('ARTIFACT_ROOT_INVALID', error.message, { artifact_root: artifactRoot });
  }

  const workerPath = fileURLToPath(new URL('./daemon-worker.js', import.meta.url));
  const args = [
    workerPath,
    '--id',
    id,
    '--cwd',
    cwd,
    '--artifact-root',
    artifactRoot,
    '--url',
    options.url,
    '--timeout',
    String(timeout)
  ];
  if (options.headed) {
    args.push('--headed');
  }
  if (options.devtools) {
    args.push('--devtools');
  }

  const metadata = daemonMetadata({
    id,
    status: 'starting',
    cwd,
    artifactRoot,
    url: options.url,
    now,
    pid: null,
    headless: !options.headed && !options.devtools,
    devtools: Boolean(options.devtools)
  });
  await writeDaemonMetadata(root, metadata);

  const spawn = context.spawn ?? defaultSpawn;
  const child = spawn(process.execPath, args, {
    cwd,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      BROWSER_DEBUG_DAEMON_WORKER: '1'
    }
  });
  child.unref?.();

  metadata.pid = child.pid ?? null;
  metadata.updated_at = materializeNow(context.now).toISOString();
  await writeDaemonMetadata(root, metadata);

  const ready = await waitForDaemonState(root, id, ['running', 'error'], DAEMON_READY_TIMEOUT_MS);
  if (!ready || ready.status !== 'running') {
    const errorMetadata = ready ?? await readDaemonMetadata(root, id).catch(() => metadata);
    return daemonError('DAEMON_START_FAILED', 'The background browser daemon did not become ready.', {
      daemon: id,
      status: errorMetadata.status,
      pid: errorMetadata.pid,
      error: errorMetadata.error ?? null
    }, [daemonArtifact(artifactRoot, id)]);
  }

  return {
    status: 'ok',
    data: { daemon: redact(ready) },
    warnings: [],
    errors: [],
    artifacts: [daemonArtifact(artifactRoot, id)]
  };
}

export async function daemonStatus(options = {}, context = {}) {
  const loaded = await loadDaemonSafely(options, context);
  if (!loaded.ok) {
    return loaded.error;
  }
  const { root, artifactRoot, id, metadata } = loaded;
  const alive = isProcessAlive(metadata.pid);
  const status = metadata.status === 'running' && !alive ? 'exited' : metadata.status;
  const updated = {
    ...metadata,
    status,
    process_status: alive ? 'alive' : 'not_alive',
    updated_at: materializeNow(context.now).toISOString()
  };
  if (updated.status !== metadata.status || updated.process_status !== metadata.process_status) {
    await writeDaemonMetadata(root, updated);
  }
  return {
    status: 'ok',
    data: { daemon: redact(updated) },
    warnings: [],
    errors: [],
    artifacts: [daemonArtifact(artifactRoot, id)]
  };
}

export async function stopDaemon(options = {}, context = {}) {
  const loaded = await loadDaemonSafely(options, context);
  if (!loaded.ok) {
    return loaded.error;
  }
  const { root, artifactRoot, id, metadata } = loaded;
  const alive = isProcessAlive(metadata.pid);
  if (!alive) {
    const stopped = {
      ...metadata,
      status: metadata.status === 'running' ? 'exited' : metadata.status,
      process_status: 'not_alive',
      updated_at: materializeNow(context.now).toISOString()
    };
    await writeDaemonMetadata(root, stopped);
    return {
      status: 'ok',
      data: { daemon: redact(stopped) },
      warnings: [],
      errors: [],
      artifacts: [daemonArtifact(artifactRoot, id)]
    };
  }

  try {
    process.kill(Number(metadata.pid), 'SIGTERM');
  } catch (error) {
    return daemonError('DAEMON_STOP_FAILED', truncateText(error.message, 1000), {
      daemon: id,
      pid: metadata.pid
    }, [daemonArtifact(artifactRoot, id)]);
  }

  const stopped = await waitForDaemonStop(root, id, metadata.pid, DAEMON_STOP_TIMEOUT_MS);
  const finalMetadata = stopped ?? {
    ...metadata,
    status: 'stop_requested',
    process_status: isProcessAlive(metadata.pid) ? 'alive' : 'not_alive',
    updated_at: materializeNow(context.now).toISOString()
  };
  await writeDaemonMetadata(root, finalMetadata);

  return {
    status: finalMetadata.process_status === 'alive' ? 'error' : 'ok',
    data: { daemon: redact(finalMetadata) },
    warnings: finalMetadata.process_status === 'alive'
      ? [{
          code: 'DAEMON_STOP_PENDING',
          message: 'The background daemon did not exit before the stop timeout.',
          details: { daemon: id, pid: metadata.pid }
        }]
      : [],
    errors: finalMetadata.process_status === 'alive'
      ? [{
          code: 'DAEMON_STOP_PENDING',
          message: 'The background daemon did not exit before the stop timeout.',
          details: { daemon: id, pid: metadata.pid }
        }]
      : [],
    artifacts: [daemonArtifact(artifactRoot, id)]
  };
}

async function loadDaemonFromOptions(options, context) {
  const cwd = context.cwd ?? process.cwd();
  const artifactRoot = options['artifact-root'] ?? DEFAULT_ARTIFACT_ROOT;
  const root = await ensureArtifactRoot(cwd, artifactRoot);
  const id = path.basename(options.daemon);
  const metadata = await readDaemonMetadata(root, id);
  return { root, artifactRoot, id, metadata };
}

async function loadDaemonSafely(options, context) {
  try {
    return {
      ok: true,
      ...(await loadDaemonFromOptions(options, context))
    };
  } catch {
    return {
      ok: false,
      error: daemonError('DAEMON_NOT_FOUND', 'Daemon metadata was not found.', {
        daemon: options.daemon
      })
    };
  }
}

function daemonMetadata({ id, status, cwd, artifactRoot, url, now, pid, headless, devtools }) {
  return redact({
    schema_version: SCHEMA_VERSION,
    id,
    status,
    process_status: pid ? 'alive' : 'starting',
    pid,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    artifact_root: artifactRoot,
    current_url: url,
    cwd,
    mode: 'background_ephemeral_context',
    browser: {
      engine: 'chromium',
      headless,
      devtools,
      ephemeral_context: true,
      existing_profile_reused: false,
      persistent_storage: false
    },
    control: {
      type: 'local_process_signal',
      external_channel: false
    },
    observations: []
  });
}

async function waitForDaemonState(root, id, states, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const metadata = await readDaemonMetadata(root, id).catch(() => null);
    if (metadata && states.includes(metadata.status)) {
      return metadata;
    }
    await delay(DAEMON_POLL_INTERVAL_MS);
  }
  return null;
}

async function waitForDaemonStop(root, id, pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const metadata = await readDaemonMetadata(root, id).catch(() => null);
    const alive = isProcessAlive(pid);
    if (!alive) {
      return {
        ...(metadata ?? {}),
        id,
        status: metadata?.status === 'stopped' ? 'stopped' : 'exited',
        process_status: 'not_alive',
        updated_at: new Date().toISOString()
      };
    }
    if (metadata?.status === 'stopped') {
      return {
        ...metadata,
        process_status: 'not_alive'
      };
    }
    await delay(DAEMON_POLL_INTERVAL_MS);
  }
  return null;
}

function isProcessAlive(pid) {
  if (!pid || !Number.isInteger(Number(pid))) {
    return false;
  }
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function writeDaemonMetadata(root, metadata) {
  return writeJsonArtifact(root, ['daemons', `${metadata.id}.json`], redact(metadata));
}

function readDaemonMetadata(root, id) {
  return readJsonArtifact(root, ['daemons', `${path.basename(id)}.json`]);
}

function daemonArtifact(artifactRoot, id) {
  return artifactObject({
    type: 'daemon',
    path: artifactRelPath(artifactRoot, 'daemons', `${id}.json`),
    description: 'Local background browser daemon metadata.'
  });
}

function daemonError(code, message, details, artifacts = []) {
  return {
    status: 'error',
    data: {},
    warnings: [],
    errors: [{ code, message: truncateText(message, 1000), details: redact(details ?? {}) }],
    artifacts
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function materializeNow(now) {
  if (!now) {
    return new Date();
  }
  const value = typeof now === 'function' ? now() : now;
  return value instanceof Date ? value : new Date(value);
}
