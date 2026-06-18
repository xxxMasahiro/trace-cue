import path from 'node:path';
import { chromium } from 'playwright';
import { SCHEMA_VERSION } from './constants.js';
import { ensureArtifactRoot, artifactRelPath, writeJsonArtifact } from './artifacts.js';
import { parseDurationMs } from './durations.js';
import { normalizeTimeout } from './observe.js';
import {
  attachPageObservers,
  createPageEventBuffers,
  waitForNetworkIdle,
  writePageObservation
} from './page-evidence.js';
import { redact, redactUrl, truncateText } from './redaction.js';

const MAX_DAEMON_CONSOLE_MESSAGES = 60;
const MAX_DAEMON_FAILED_REQUESTS = 60;

const options = parseWorkerArgs(process.argv.slice(2));
const startedAt = new Date();
let root;
let browser;
let browserContext;
let page;
let stopping = false;
let latestMetadata = null;

try {
  await main();
} catch (error) {
  await writeError(error).catch(() => {});
  process.exitCode = 1;
}

async function main() {
  process.chdir(options.cwd);
  const timeout = normalizeTimeout(options.timeout);
  root = await ensureArtifactRoot(options.cwd, options.artifactRoot);
  const now = startedAt;
  const headless = !options.headed && !options.devtools;
  const warnings = [];
  const pageEvents = createPageEventBuffers();

  await writeMetadata({
    status: 'starting',
    process_status: 'alive',
    pid: process.pid,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    current_url: options.url,
    observations: []
  });

  browser = await chromium.launch({
    headless,
    devtools: Boolean(options.devtools)
  });
  browserContext = await browser.newContext({
    viewport: { width: 1280, height: 720 }
  });
  page = await browserContext.newPage();
  attachPageObservers(page, pageEvents, {
    maxConsoleMessages: MAX_DAEMON_CONSOLE_MESSAGES,
    maxFailedRequests: MAX_DAEMON_FAILED_REQUESTS
  });
  const response = await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout });
  await waitForNetworkIdle(page, timeout, warnings, {
    message: 'The page did not reach networkidle before the short daemon wait ended.'
  });
  const observation = await writePageObservation({
    root,
    artifactRoot: options.artifactRoot,
    id: `${options.id}-initial`,
    now,
    page,
    inputUrl: options.url,
    response,
    browser: {
      engine: 'chromium',
      headless,
      devtools: Boolean(options.devtools),
      ephemeral_context: true,
      existing_profile_reused: false,
      persistent_storage: false
    },
    consoleMessages: pageEvents.consoleMessages,
    failedRequests: pageEvents.failedRequests,
    actionResults: [],
    description: 'Structured daemon startup page observation JSON.'
  });
  await writeMetadata({
    status: 'running',
    process_status: 'alive',
    pid: process.pid,
    created_at: now.toISOString(),
    updated_at: new Date().toISOString(),
    current_url: page.url(),
    title: observation.data.title,
    warnings,
    lifecycle: {
      last_activity_at: new Date().toISOString()
    },
    observations: [{
      id: observation.id,
      path: observation.artifact.path
    }]
  });

  scheduleLifecycleStops();

  process.once('SIGTERM', () => {
    void stop('stopped', 'signal');
  });
  process.once('SIGINT', () => {
    void stop('stopped', 'signal');
  });

  await new Promise(() => {});
}

async function stop(status, reason = 'unknown') {
  if (stopping) {
    return;
  }
  stopping = true;
  await browserContext?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await writeMetadata({
    status,
    process_status: 'not_alive',
    pid: process.pid,
    updated_at: new Date().toISOString(),
    current_url: page?.url?.() ?? options.url,
    lifecycle: {
      stop_reason: reason
    }
  }).catch(() => {});
  process.exit(0);
}

function scheduleLifecycleStops() {
  if (options.idleTimeout !== null) {
    setTimeout(() => {
      void stop('stopped', 'idle_timeout');
    }, options.idleTimeout);
  }
  if (options.maxLifetime !== null) {
    setTimeout(() => {
      void stop('stopped', 'max_lifetime');
    }, options.maxLifetime);
  }
}

async function writeError(error) {
  if (!root) {
    root = await ensureArtifactRoot(options.cwd, options.artifactRoot);
  }
  await writeMetadata({
    status: 'error',
    process_status: 'not_alive',
    pid: process.pid,
    updated_at: new Date().toISOString(),
    current_url: options.url,
    error: {
      code: 'DAEMON_WORKER_ERROR',
      message: truncateText(error.message, 1000)
    }
  });
}

async function writeMetadata(partial) {
  const now = new Date();
  const metadata = redact({
    schema_version: SCHEMA_VERSION,
    id: options.id,
    status: partial.status,
    process_status: partial.process_status,
    pid: partial.pid,
    created_at: partial.created_at ?? latestMetadata?.created_at ?? startedAt.toISOString(),
    updated_at: partial.updated_at ?? now.toISOString(),
    artifact_root: options.artifactRoot,
    current_url: redactUrl(partial.current_url ?? options.url),
    title: partial.title ?? latestMetadata?.title ?? null,
    mode: 'background_ephemeral_context',
    browser: {
      engine: 'chromium',
      headless: !options.headed && !options.devtools,
      devtools: Boolean(options.devtools),
      ephemeral_context: true,
      existing_profile_reused: false,
      persistent_storage: false
    },
    control: {
      type: 'local_process_signal',
      external_channel: false
    },
    lifecycle: daemonLifecycle(partial),
    warnings: partial.warnings ?? latestMetadata?.warnings ?? [],
    observations: partial.observations ?? latestMetadata?.observations ?? [],
    error: partial.error ?? null,
    artifact: artifactRelPath(options.artifactRoot, 'daemons', `${options.id}.json`)
  });
  latestMetadata = metadata;
  await writeJsonArtifact(root, ['daemons', `${options.id}.json`], metadata);
}

function daemonLifecycle(partial) {
  const previous = latestMetadata?.lifecycle ?? {};
  return {
    idle_timeout_ms: options.idleTimeout,
    max_lifetime_ms: options.maxLifetime,
    started_at: previous.started_at ?? startedAt.toISOString(),
    last_activity_at: partial.lifecycle?.last_activity_at ?? previous.last_activity_at ?? startedAt.toISOString(),
    expires_at: options.maxLifetime === null ? null : new Date(startedAt.getTime() + options.maxLifetime).toISOString(),
    stop_reason: partial.lifecycle?.stop_reason ?? previous.stop_reason ?? null
  };
}

function parseWorkerArgs(argv) {
  const parsed = {
    headed: false,
    devtools: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--headed') {
      parsed.headed = true;
      continue;
    }
    if (token === '--devtools') {
      parsed.devtools = true;
      continue;
    }
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected daemon worker argument: ${token}`);
    }
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Daemon worker option requires a value: ${token}`);
    }
    parsed[key] = value;
    index += 1;
  }
  for (const key of ['id', 'cwd', 'artifactRoot', 'url', 'timeout']) {
    if (!parsed[key]) {
      throw new Error(`Daemon worker missing required option: ${key}`);
    }
  }
  parsed.id = path.basename(parsed.id);
  parsed.idleTimeout = parseDurationMs(parsed.idleTimeout, {
    name: 'idle-timeout',
    defaultMs: null,
    minMs: 1000,
    maxMs: 7 * 24 * 60 * 60 * 1000
  });
  parsed.maxLifetime = parseDurationMs(parsed.maxLifetime, {
    name: 'max-lifetime',
    defaultMs: null,
    minMs: 1000,
    maxMs: 7 * 24 * 60 * 60 * 1000
  });
  return parsed;
}
