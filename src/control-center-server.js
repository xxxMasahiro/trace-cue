import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createEnvelope } from './envelope.js';
import { runControlCenterStatus, controlCenterBoundary } from './control-center-read-model.js';
import {
  CONTROL_CENTER_JSON_BODY_LIMIT_BYTES,
  runControlCenterPlaywrightTestExternalCiApproveSettings,
  runControlCenterPlaywrightTestExternalCiFetch,
  runControlCenterPlaywrightTestExternalCiFetchApproved,
  runControlCenterPlaywrightTestExternalCiSuggestSettings,
  runControlCenterPlaywrightTestImport,
  runControlCenterSetPlaywrightTestMode,
  runControlCenterSetDisplayLanguage,
  runControlCenterSourceIntakeProposal
} from './control-center-actions.js';
import { runControlCenterSetPreferences } from './control-center-preferences.js';
import { runControlCenterSaveSettings } from './control-center-settings.js';
import { buildControlCenterAiReadiness } from './control-center-ai-readiness.js';
import {
  readControlCenterAiConnections,
  runControlCenterAiConnectionsRefresh,
  runControlCenterAiSelectionSave
} from './control-center-ai-connection-actions.js';
import {
  completeControlCenterIntake,
  getControlCenterIntakeResult,
  listControlCenterIntakeResults,
  recoverPendingControlCenterIntakePublications,
  stageControlCenterIntake
} from './control-center-intake.js';
import {
  CONTROL_CENTER_AGENTIC_REVIEW_ENDPOINTS,
  runControlCenterAgenticReviewConfirmation,
  runControlCenterAgenticReviewDecision,
  runControlCenterAgenticReviewList,
  runControlCenterAgenticReviewPrepare,
  runControlCenterAgenticReviewRecover,
  runControlCenterAgenticReviewResume,
  runControlCenterAgenticReviewCancel,
  runControlCenterAgenticReviewRepeat,
  runControlCenterAgenticReviewStart,
  runControlCenterAgenticReviewStatus
} from './control-center-agentic-review-actions.js';
import { isAllowedMcpHttpHost, isLoopbackHost } from './mcp-transport-policy.js';
import { PRODUCT_IDENTITY } from './product-identity.js';
import { readStableBoundedFileHandle } from './safe-local-store.js';

const DEFAULT_CONTROL_CENTER_HOST = '127.0.0.1';
const DEFAULT_CONTROL_CENTER_PORT = 0;
const DEFAULT_CONTROL_CENTER_ASSET_ROOT = path.join(
  fileURLToPath(new URL('..', import.meta.url)),
  PRODUCT_IDENTITY.controlCenterDistPath
);
const CONTROL_CENTER_CSRF_HEADER = 'x-trace-cue-action-token';
const MAX_STATIC_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_STATIC_ASSET_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_STATIC_ASSET_ENTRIES = 1000;
export const CONTROL_CENTER_RUNTIME_PROTOCOL_VERSION = '1.0.0';

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8'
});

export async function startControlCenterServer(options = {}, context = {}) {
  const config = resolveControlCenterServerConfig(options, context);
  if (!config.ok) {
    throw new Error(config.message);
  }
  config.config.runtimeCompatibility = await buildControlCenterRuntimeCompatibility(config.config.staticRoot);
  await recoverPendingControlCenterIntakePublications({
    ...context,
    cwd: config.config.cwd,
    artifactRoot: config.config.readModelOptions['artifact-root']
  });
  const server = createControlCenterServer(config.config, context);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.config.port, config.config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.config.port;
  const url = `http://${formatUrlHost(config.config.host)}:${port}/`;
  config.config.port = port;
  config.config.origin = url.slice(0, -1);
  return {
    server,
    url,
    config: { host: config.config.host, port },
    metadata: controlCenterServerMetadata(config.config, url)
  };
}

export async function runControlCenterServe(options = {}, context = {}) {
  const started = await startControlCenterServer(options, context);
  const stderr = context.stderr ?? process.stderr;
  stderr.write(`${JSON.stringify({
    event: 'trace_cue_control_center_listening',
    url: started.url,
    local_only: true,
    read_only_dashboard: true,
    bounded_local_action_endpoints: true,
    host: started.config.host,
    port: started.config.port
  })}\n`);
  const signal = context.signal;
  if (signal) {
    const closeServer = () => started.server.close();
    if (signal.aborted) {
      closeServer();
    } else {
      signal.addEventListener('abort', closeServer, { once: true });
    }
  }
  await once(started.server, 'close');
  return {
    status: 'ok',
    data: {
      control_center_server: {
        status: 'closed',
        url: started.url,
        metadata: started.metadata
      },
      boundary: controlCenterBoundary()
    },
    warnings: [],
    errors: [],
    artifacts: []
  };
}

export function createControlCenterServer(config, context = {}) {
  return createServer(async (request, response) => {
    try {
      await handleControlCenterRequest(request, response, config, context);
    } catch {
      sendJson(response, 500, {
        error: {
          code: 'CONTROL_CENTER_INTERNAL_ERROR',
          message: 'The control-center server could not complete the local read-only request.'
        }
      });
    }
  });
}

export function resolveControlCenterServerConfig(options = {}, context = {}) {
  const host = String(options.host ?? DEFAULT_CONTROL_CENTER_HOST).trim();
  if (!isLoopbackHost(host)) {
    return {
      ok: false,
      code: 'CONTROL_CENTER_HOST_REJECTED',
      message: 'control-center serve must bind to a loopback host only.'
    };
  }
  const port = parsePort(options.port ?? DEFAULT_CONTROL_CENTER_PORT);
  if (!port.ok) {
    return port;
  }
  const cwd = path.resolve(context.cwd ?? process.cwd());
  const staticRoot = options.assetRoot
    ? path.resolve(String(options.assetRoot))
    : DEFAULT_CONTROL_CENTER_ASSET_ROOT;
  return {
    ok: true,
    config: {
      host,
      port: port.value,
      cwd,
      staticRoot,
      origin: null,
      csrfToken: randomBytes(32).toString('base64url'),
      instanceId: randomBytes(24).toString('base64url'),
      readModelOptions: {
        'artifact-root': options['artifact-root'],
        limit: options.limit,
        'max-bytes': options['max-bytes'],
        'evidence-set': options['evidence-set'],
        input: options.input
      }
    }
  };
}

export async function handleControlCenterRequest(request, response, config, context = {}) {
  const validation = validateCommonRequest(request, config);
  if (!validation.ok) {
    sendJson(response, validation.status, { error: { code: validation.code, message: validation.message } });
    return;
  }
  const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
  if (url.pathname === '/api/health') {
    if (request.method !== 'GET') {
      sendMethodNotAllowed(response, 'CONTROL_CENTER_HEALTH_GET_ONLY', 'control-center health only accepts GET requests.');
      return;
    }
    sendJson(response, 200, {
      status: 'ok',
      instance_id: config.instanceId,
      protocol_version: config.runtimeCompatibility?.protocol_version ?? null,
      package_version: config.runtimeCompatibility?.package_version ?? null,
      asset_fingerprint: config.runtimeCompatibility?.asset_fingerprint ?? null,
      local_only: true,
      read_only: true,
      boundary: controlCenterBoundary()
    });
    return;
  }
  if (url.pathname === '/api/dashboard') {
    if (request.method !== 'GET') {
      sendMethodNotAllowed(response, 'CONTROL_CENTER_DASHBOARD_GET_ONLY', 'control-center dashboard only accepts GET requests.');
      return;
    }
    const result = await runControlCenterStatus(config.readModelOptions, { ...context, cwd: config.cwd });
    const aiConnections = await readControlCenterAiConnections({
      ...context,
      cwd: config.cwd,
      artifactRoot: config.readModelOptions['artifact-root']
    });
    const dashboardData = {
      ...result.data,
      control_center: {
        ...(result.data?.control_center ?? {}),
        action_security: {
          token: config.csrfToken,
          header: CONTROL_CENTER_CSRF_HEADER,
          expires_on_restart: true
        },
        ai_readiness: compatibilityAiReadiness(aiConnections, context),
        ai_connections: aiConnections
      }
    };
    const envelope = createEnvelope({
      command: 'control-center status',
      status: result.status,
      data: dashboardData,
      warnings: result.warnings,
      errors: result.errors,
      artifacts: result.artifacts,
      now: context.now
    });
    sendJson(response, result.status === 'ok' ? 200 : 500, envelope);
    return;
  }
  if (url.pathname === '/api/agentic-review/status' || url.pathname === '/api/agentic-review/list') {
    if (request.method !== 'GET') {
      sendMethodNotAllowed(response, 'CONTROL_CENTER_AGENTIC_REVIEW_GET_ONLY', 'Review status only accepts GET requests.');
      return;
    }
    const isList = url.pathname.endsWith('/list');
    const agenticReviewContext = {
      ...context,
      cwd: config.cwd,
      artifactRoot: config.readModelOptions['artifact-root']
    };
    const result = isList
      ? await runControlCenterAgenticReviewList({ limit: url.searchParams.get('limit') }, agenticReviewContext)
      : await runControlCenterAgenticReviewStatus({ id: url.searchParams.get('id') }, agenticReviewContext);
    const envelope = createEnvelope({
      command: isList ? 'control-center agentic-review list' : 'control-center agentic-review status',
      status: result.status,
      data: result.data,
      warnings: result.warnings,
      errors: result.errors,
      artifacts: result.artifacts,
      now: context.now
    });
    sendJson(response, result.status === 'ok' ? 200 : 400, envelope);
    return;
  }
  if (url.pathname === '/api/review-intake/upload') {
    if (request.method !== 'POST') {
      sendMethodNotAllowed(response, 'CONTROL_CENTER_INTAKE_UPLOAD_POST_ONLY', 'File intake only accepts POST requests.');
      return;
    }
    const result = await stageControlCenterIntake({
      sourceKind: String(request.headers['x-trace-cue-source-kind'] ?? ''),
      originalName: decodeHeaderValue(request.headers['x-trace-cue-file-name']),
      contentType: String(request.headers['content-type'] ?? ''),
      contentLength: request.headers['content-length']
    }, request, {
      ...context,
      cwd: config.cwd,
      artifactRoot: config.readModelOptions['artifact-root']
    });
    sendActionEnvelope(response, 'control-center review-intake upload', result, context, 201);
    return;
  }
  if (url.pathname === '/api/review-intake/results' || url.pathname === '/api/review-intake/result') {
    if (request.method !== 'GET') {
      sendMethodNotAllowed(response, 'CONTROL_CENTER_INTAKE_RESULTS_GET_ONLY', 'Saved confirmation results only accept GET requests.');
      return;
    }
    const isList = url.pathname.endsWith('/results');
    const result = isList
      ? await listControlCenterIntakeResults({ limit: url.searchParams.get('limit') }, {
        ...context,
        cwd: config.cwd,
        artifactRoot: config.readModelOptions['artifact-root']
      })
      : await getControlCenterIntakeResult({ id: url.searchParams.get('id') }, {
        ...context,
        cwd: config.cwd,
        artifactRoot: config.readModelOptions['artifact-root']
      });
    const envelope = createEnvelope({
      command: isList ? 'control-center review-intake results' : 'control-center review-intake result',
      status: result.status,
      data: result.data,
      warnings: result.warnings,
      errors: result.errors,
      artifacts: result.artifacts,
      now: context.now
    });
    sendJson(response, result.status === 'ok' ? 200 : 404, envelope);
    return;
  }
  if (url.pathname === '/api/review-intake/complete') {
    if (request.method !== 'POST') {
      sendMethodNotAllowed(response, 'CONTROL_CENTER_INTAKE_COMPLETE_POST_ONLY', 'File review preparation only accepts POST requests.');
      return;
    }
    const body = await readJsonRequestBody(request);
    if (!body.ok) {
      sendJson(response, body.status, { error: { code: body.code, message: body.message, details: body.details ?? {} } });
      return;
    }
    const result = await completeControlCenterIntake(body.value, {
      ...context,
      cwd: config.cwd,
      artifactRoot: config.readModelOptions['artifact-root']
    });
    sendActionEnvelope(response, 'control-center review-intake complete', result, context, 200);
    return;
  }
  const agenticReviewPostActions = {
    '/api/agentic-review/prepare': ['prepare', runControlCenterAgenticReviewPrepare, 202],
    '/api/agentic-review/confirmation': ['confirmation', runControlCenterAgenticReviewConfirmation, 200],
    '/api/agentic-review/start': ['start', runControlCenterAgenticReviewStart, 202],
    '/api/agentic-review/decision': ['decision', runControlCenterAgenticReviewDecision, 200],
    '/api/agentic-review/repeat': ['repeat', runControlCenterAgenticReviewRepeat, 202],
    '/api/agentic-review/recover': ['recover', runControlCenterAgenticReviewRecover, 200],
    '/api/agentic-review/resume': ['resume', runControlCenterAgenticReviewResume, 202],
    '/api/agentic-review/cancel': ['cancel', runControlCenterAgenticReviewCancel, 200]
  };
  const agenticReviewAction = agenticReviewPostActions[url.pathname];
  if (agenticReviewAction) {
    if (request.method !== 'POST') {
      sendMethodNotAllowed(response, 'CONTROL_CENTER_AGENTIC_REVIEW_POST_ONLY', 'Review actions only accept POST requests.');
      return;
    }
    const body = await readJsonRequestBody(request);
    if (!body.ok) {
      sendJson(response, body.status, { error: { code: body.code, message: body.message, details: body.details ?? {} } });
      return;
    }
    const [actionName, actionRunner, acceptedStatus] = agenticReviewAction;
    const result = await actionRunner(body.value, {
      ...context,
      cwd: config.cwd,
      artifactRoot: config.readModelOptions['artifact-root']
    });
    const envelope = createEnvelope({
      command: `control-center agentic-review ${actionName}`,
      status: result.status,
      data: result.data,
      warnings: result.warnings,
      errors: result.errors,
      artifacts: result.artifacts,
      now: context.now
    });
    sendJson(response, result.status === 'ok' ? acceptedStatus : 400, envelope);
    return;
  }
  if (url.pathname === '/api/source-intake/proposal') {
    if (request.method !== 'POST') {
      sendMethodNotAllowed(response, 'CONTROL_CENTER_SOURCE_INTAKE_POST_ONLY', 'control-center source intake only accepts POST requests.');
      return;
    }
    const body = await readJsonRequestBody(request);
    if (!body.ok) {
      sendJson(response, body.status, { error: { code: body.code, message: body.message, details: body.details ?? {} } });
      return;
    }
    const result = await runControlCenterSourceIntakeProposal(body.value, { ...context, cwd: config.cwd });
    const envelope = createEnvelope({
      command: 'control-center source-intake proposal',
      status: result.status,
      data: result.data,
      warnings: result.warnings,
      errors: result.errors,
      artifacts: result.artifacts,
      now: context.now
    });
    sendJson(response, result.status === 'ok' ? 200 : 400, envelope);
    return;
  }
  if (url.pathname === '/api/settings/display-language') {
    if (request.method !== 'POST') {
      sendMethodNotAllowed(response, 'CONTROL_CENTER_DISPLAY_LANGUAGE_POST_ONLY', 'control-center display language settings only accept POST requests.');
      return;
    }
    const body = await readJsonRequestBody(request);
    if (!body.ok) {
      sendJson(response, body.status, { error: { code: body.code, message: body.message, details: body.details ?? {} } });
      return;
    }
    const result = await runControlCenterSetDisplayLanguage(body.value, { ...context, cwd: config.cwd });
    const envelope = createEnvelope({
      command: 'control-center settings display-language',
      status: result.status,
      data: result.data,
      warnings: result.warnings,
      errors: result.errors,
      artifacts: result.artifacts,
      now: context.now
    });
    sendJson(response, result.status === 'ok' ? 200 : 400, envelope);
    return;
  }
  if (url.pathname === '/api/settings/control-center') {
    if (request.method !== 'POST') {
      sendMethodNotAllowed(response, 'CONTROL_CENTER_PREFERENCES_POST_ONLY', 'Control Center preferences only accept POST requests.');
      return;
    }
    const body = await readJsonRequestBody(request);
    if (!body.ok) {
      sendJson(response, body.status, { error: { code: body.code, message: body.message, details: body.details ?? {} } });
      return;
    }
    const combinedSave = Object.hasOwn(body.value, 'locale') || Object.hasOwn(body.value, 'playwright_mode');
    const result = combinedSave
      ? await runControlCenterSaveSettings(body.value, { ...context, cwd: config.cwd })
      : await runControlCenterSetPreferences(body.value, { ...context, cwd: config.cwd });
    const envelope = createEnvelope({
      command: combinedSave ? 'control-center settings save' : 'control-center settings preferences',
      status: result.status,
      data: result.data,
      warnings: result.warnings,
      errors: result.errors,
      artifacts: result.artifacts,
      now: context.now
    });
    sendJson(response, result.status === 'ok' ? 200 : 400, envelope);
    return;
  }
  if (url.pathname === '/api/settings/ai-connections/refresh' || url.pathname === '/api/settings/ai-connections/selection') {
    if (request.method !== 'POST') {
      sendMethodNotAllowed(response, 'CONTROL_CENTER_AI_CONNECTIONS_POST_ONLY', 'AI settings only accept POST requests.');
      return;
    }
    const body = await readJsonRequestBody(request);
    if (!body.ok) {
      sendJson(response, body.status, { error: { code: body.code, message: body.message, details: body.details ?? {} } });
      return;
    }
    const refresh = url.pathname.endsWith('/refresh');
    const result = await (refresh ? runControlCenterAiConnectionsRefresh : runControlCenterAiSelectionSave)(body.value, {
      ...context,
      cwd: config.cwd,
      artifactRoot: config.readModelOptions['artifact-root']
    });
    const envelope = createEnvelope({
      command: refresh ? 'control-center settings ai-connections refresh' : 'control-center settings ai-connections selection',
      status: result.status,
      data: result.data,
      warnings: result.warnings,
      errors: result.errors,
      artifacts: result.artifacts,
      now: context.now
    });
    const conflict = result.errors?.[0]?.code === 'CONTROL_CENTER_AI_CONNECTION_REVISION_CONFLICT';
    sendJson(response, result.status === 'ok' ? 200 : conflict ? 409 : 400, envelope);
    return;
  }
  if (url.pathname === '/api/playwright-test/mode') {
    if (request.method !== 'POST') {
      sendMethodNotAllowed(response, 'CONTROL_CENTER_PLAYWRIGHT_TEST_MODE_POST_ONLY', 'control-center Playwright Test mode only accepts POST requests.');
      return;
    }
    const body = await readJsonRequestBody(request);
    if (!body.ok) {
      sendJson(response, body.status, { error: { code: body.code, message: body.message, details: body.details ?? {} } });
      return;
    }
    const result = await runControlCenterSetPlaywrightTestMode(body.value, { ...context, cwd: config.cwd });
    const envelope = createEnvelope({
      command: 'control-center playwright-test mode',
      status: result.status,
      data: result.data,
      warnings: result.warnings,
      errors: result.errors,
      artifacts: result.artifacts,
      now: context.now
    });
    sendJson(response, result.status === 'ok' ? 200 : 400, envelope);
    return;
  }
  if (url.pathname === '/api/playwright-test/import') {
    if (request.method !== 'POST') {
      sendMethodNotAllowed(response, 'CONTROL_CENTER_PLAYWRIGHT_TEST_IMPORT_POST_ONLY', 'control-center Playwright Test import only accepts POST requests.');
      return;
    }
    const body = await readJsonRequestBody(request);
    if (!body.ok) {
      sendJson(response, body.status, { error: { code: body.code, message: body.message, details: body.details ?? {} } });
      return;
    }
    const result = await runControlCenterPlaywrightTestImport(body.value, { ...context, cwd: config.cwd });
    const envelope = createEnvelope({
      command: 'control-center playwright-test import',
      status: result.status,
      data: result.data,
      warnings: result.warnings,
      errors: result.errors,
      artifacts: result.artifacts,
      now: context.now
    });
    sendJson(response, result.status === 'ok' ? 200 : 400, envelope);
    return;
  }
  if (url.pathname === '/api/playwright-test/external-ci/fetch') {
    if (request.method !== 'POST') {
      sendMethodNotAllowed(response, 'CONTROL_CENTER_PLAYWRIGHT_TEST_EXTERNAL_CI_FETCH_POST_ONLY', 'control-center Playwright Test CI fetch only accepts POST requests.');
      return;
    }
    const body = await readJsonRequestBody(request);
    if (!body.ok) {
      sendJson(response, body.status, { error: { code: body.code, message: body.message, details: body.details ?? {} } });
      return;
    }
    const result = await runControlCenterPlaywrightTestExternalCiFetch(body.value, { ...context, cwd: config.cwd });
    const envelope = createEnvelope({
      command: 'control-center playwright-test external-ci fetch',
      status: result.status,
      data: result.data,
      warnings: result.warnings,
      errors: result.errors,
      artifacts: result.artifacts,
      now: context.now
    });
    sendJson(response, result.status === 'ok' ? 200 : 400, envelope);
    return;
  }
  if (url.pathname === '/api/playwright-test/external-ci/suggest-settings') {
    if (request.method !== 'POST') {
      sendMethodNotAllowed(response, 'CONTROL_CENTER_PLAYWRIGHT_TEST_EXTERNAL_CI_SUGGEST_SETTINGS_POST_ONLY', 'control-center Playwright Test CI settings suggestion only accepts POST requests.');
      return;
    }
    const body = await readJsonRequestBody(request);
    if (!body.ok) {
      sendJson(response, body.status, { error: { code: body.code, message: body.message, details: body.details ?? {} } });
      return;
    }
    const result = await runControlCenterPlaywrightTestExternalCiSuggestSettings(body.value, { ...context, cwd: config.cwd });
    const envelope = createEnvelope({
      command: 'control-center playwright-test external-ci suggest-settings',
      status: result.status,
      data: result.data,
      warnings: result.warnings,
      errors: result.errors,
      artifacts: result.artifacts,
      now: context.now
    });
    sendJson(response, result.status === 'ok' ? 200 : 400, envelope);
    return;
  }
  if (url.pathname === '/api/playwright-test/external-ci/approve-settings') {
    if (request.method !== 'POST') {
      sendMethodNotAllowed(response, 'CONTROL_CENTER_PLAYWRIGHT_TEST_EXTERNAL_CI_APPROVE_SETTINGS_POST_ONLY', 'control-center Playwright Test CI settings approval only accepts POST requests.');
      return;
    }
    const body = await readJsonRequestBody(request);
    if (!body.ok) {
      sendJson(response, body.status, { error: { code: body.code, message: body.message, details: body.details ?? {} } });
      return;
    }
    const result = await runControlCenterPlaywrightTestExternalCiApproveSettings(body.value, { ...context, cwd: config.cwd });
    const envelope = createEnvelope({
      command: 'control-center playwright-test external-ci approve-settings',
      status: result.status,
      data: result.data,
      warnings: result.warnings,
      errors: result.errors,
      artifacts: result.artifacts,
      now: context.now
    });
    sendJson(response, result.status === 'ok' ? 200 : 400, envelope);
    return;
  }
  if (url.pathname === '/api/playwright-test/external-ci/fetch-approved') {
    if (request.method !== 'POST') {
      sendMethodNotAllowed(response, 'CONTROL_CENTER_PLAYWRIGHT_TEST_EXTERNAL_CI_FETCH_APPROVED_POST_ONLY', 'control-center Playwright Test approved CI fetch only accepts POST requests.');
      return;
    }
    const body = await readJsonRequestBody(request);
    if (!body.ok) {
      sendJson(response, body.status, { error: { code: body.code, message: body.message, details: body.details ?? {} } });
      return;
    }
    const result = await runControlCenterPlaywrightTestExternalCiFetchApproved(body.value, { ...context, cwd: config.cwd });
    const envelope = createEnvelope({
      command: 'control-center playwright-test external-ci fetch-approved',
      status: result.status,
      data: result.data,
      warnings: result.warnings,
      errors: result.errors,
      artifacts: result.artifacts,
      now: context.now
    });
    sendJson(response, result.status === 'ok' ? 200 : 400, envelope);
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    sendJson(response, 404, {
      error: {
        code: 'CONTROL_CENTER_API_NOT_FOUND',
        message: 'The requested Control Center action does not exist.'
      }
    });
    return;
  }
  if (request.method !== 'GET') {
    sendMethodNotAllowed(response, 'CONTROL_CENTER_ASSET_GET_ONLY', 'control-center assets only accept GET requests.');
    return;
  }
  await serveBuiltAsset(request, response, config);
}

export async function buildControlCenterRuntimeCompatibility(assetRoot = DEFAULT_CONTROL_CENTER_ASSET_ROOT) {
  return Object.freeze({
    protocol_version: CONTROL_CENTER_RUNTIME_PROTOCOL_VERSION,
    package_version: PRODUCT_IDENTITY.packageVersion,
    asset_fingerprint: await fingerprintControlCenterAssets(path.resolve(assetRoot))
  });
}

async function fingerprintControlCenterAssets(root) {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw unsafeAssetError();
  const rootReal = await realpath(root);
  const pending = [''];
  const files = [];
  let entryCount = 0;
  while (pending.length > 0) {
    const relativeDirectory = pending.pop();
    const directory = path.join(rootReal, relativeDirectory);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      entryCount += 1;
      if (entryCount > MAX_STATIC_ASSET_ENTRIES || entry.isSymbolicLink()) throw unsafeAssetError();
      const relative = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) pending.push(relative);
      else if (entry.isFile()) files.push(relative);
      else throw unsafeAssetError();
    }
  }
  files.sort();
  const digest = createHash('sha256');
  let totalBytes = 0;
  for (const relative of files) {
    const target = path.join(rootReal, relative);
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_STATIC_ASSET_BYTES) {
      throw unsafeAssetError();
    }
    totalBytes += info.size;
    if (totalBytes > MAX_STATIC_ASSET_TOTAL_BYTES) throw unsafeAssetError();
    const handle = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const body = await readStableBoundedFileHandle(handle, {
        expected: info,
        maxBytes: MAX_STATIC_ASSET_BYTES,
        changedError: unsafeAssetError
      });
      const normalized = relative.split(path.sep).join('/');
      digest.update(`${Buffer.byteLength(normalized, 'utf8')}:${normalized}:${body.length}:`);
      digest.update(body);
    } finally {
      await handle.close();
    }
  }
  if (files.length === 0) throw unsafeAssetError();
  return `sha256:${digest.digest('hex')}`;
}

function validateCommonRequest(request, config) {
  if (!isAllowedMcpHttpHost(request.headers.host)) {
    return {
      ok: false,
      status: 403,
      code: 'CONTROL_CENTER_HOST_REJECTED',
      message: 'control-center Host header must be loopback.'
    };
  }
  const expectedOrigin = config.origin ?? `http://${request.headers.host}`;
  const suppliedOrigin = String(request.headers.origin ?? '');
  if (suppliedOrigin && suppliedOrigin !== expectedOrigin) {
    return {
      ok: false,
      status: 403,
      code: 'CONTROL_CENTER_ORIGIN_REJECTED',
      message: 'control-center Origin must match the active local Control Center.'
    };
  }
  if (!['GET', 'HEAD'].includes(String(request.method ?? '').toUpperCase())) {
    if (!suppliedOrigin || suppliedOrigin !== expectedOrigin) {
      return {
        ok: false,
        status: 403,
        code: 'CONTROL_CENTER_ORIGIN_REQUIRED',
        message: 'Control Center changes require the active local Origin.'
      };
    }
    const suppliedToken = String(request.headers[CONTROL_CENTER_CSRF_HEADER] ?? '');
    if (!constantTimeEqual(suppliedToken, config.csrfToken)) {
      return {
        ok: false,
        status: 403,
        code: 'CONTROL_CENTER_ACTION_TOKEN_REJECTED',
        message: 'Refresh the Control Center before making this change.'
      };
    }
  }
  return { ok: true };
}

async function readJsonRequestBody(request) {
  const contentType = String(request.headers['content-type'] ?? '').toLowerCase();
  if (!contentType.includes('application/json')) {
    return {
      ok: false,
      status: 415,
      code: 'CONTROL_CENTER_JSON_REQUIRED',
      message: 'control-center action requests require application/json.'
    };
  }
  let total = 0;
  const chunks = [];
  for await (const chunk of request) {
    total += chunk.length;
    if (total > CONTROL_CENTER_JSON_BODY_LIMIT_BYTES) {
      return {
        ok: false,
        status: 413,
        code: 'CONTROL_CENTER_BODY_TOO_LARGE',
        message: 'control-center action request body is too large.',
        details: { max_bytes: CONTROL_CENTER_JSON_BODY_LIMIT_BYTES }
      };
    }
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {
        ok: false,
        status: 400,
        code: 'CONTROL_CENTER_JSON_OBJECT_REQUIRED',
        message: 'control-center action request body must be a JSON object.'
      };
    }
    return {
      ok: true,
      value
    };
  } catch (error) {
    return {
      ok: false,
      status: 400,
      code: 'CONTROL_CENTER_INVALID_JSON',
      message: 'control-center action request body must be valid JSON.',
      details: { reason: error.message }
    };
  }
}

function sendMethodNotAllowed(response, code, message) {
  sendJson(response, 405, { error: { code, message } });
}

async function serveBuiltAsset(request, response, config) {
  const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
  let pathname;
  try {
    pathname = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  } catch {
    sendJson(response, 400, { error: { code: 'CONTROL_CENTER_ASSET_PATH_INVALID', message: 'The asset path is invalid.' } });
    return;
  }
  const target = path.resolve(config.staticRoot, `.${pathname}`);
  if (!isInside(config.staticRoot, target)) {
    sendJson(response, 403, {
      error: {
        code: 'CONTROL_CENTER_ASSET_OUTSIDE_ROOT',
        message: 'control-center asset request escaped the built asset root.'
      }
    });
    return;
  }
  try {
    const rootInfo = await lstat(config.staticRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw unsafeAssetError();
    const rootReal = await realpath(config.staticRoot);
    await rejectAssetSymlinkComponents(config.staticRoot, target);
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_STATIC_ASSET_BYTES) {
      throw unsafeAssetError();
    }
    const targetReal = await realpath(target);
    if (!isInside(rootReal, targetReal)) throw unsafeAssetError();
    const handle = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    let body;
    try {
      body = await readStableBoundedFileHandle(handle, {
        expected: info,
        maxBytes: MAX_STATIC_ASSET_BYTES,
        changedError: unsafeAssetError
      });
    } finally {
      await handle.close();
    }
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(target)] ?? 'application/octet-stream',
      ...securityHeaders()
    });
    response.end(body);
  } catch (error) {
    if (error?.code === 'CONTROL_CENTER_ASSET_UNSAFE') {
      sendJson(response, 403, {
        error: {
          code: error.code,
          message: 'The requested Control Center asset is unsafe.'
        }
      });
      return;
    }
    sendJson(response, 503, {
      error: {
        code: 'CONTROL_CENTER_ASSETS_NOT_BUILT',
        message: 'The installed Control Center assets are unavailable.'
      }
    });
  }
}

function controlCenterServerMetadata(config, url) {
  return {
    url,
    host: config.host,
    port: config.port,
    runtime_compatibility: config.runtimeCompatibility,
    local_only: true,
    read_only_dashboard: true,
    dashboard_get_only: true,
    bounded_local_action_endpoints: true,
    action_api_exposed: true,
    action_endpoints: [
      '/api/source-intake/proposal',
      '/api/settings/display-language',
      '/api/playwright-test/mode',
      '/api/playwright-test/import',
      '/api/playwright-test/external-ci/fetch',
      '/api/playwright-test/external-ci/suggest-settings',
      '/api/playwright-test/external-ci/approve-settings',
      '/api/playwright-test/external-ci/fetch-approved'
    ],
    source_intake_endpoints: [
      '/api/review-intake/upload',
      '/api/review-intake/complete',
      '/api/review-intake/results',
      '/api/review-intake/result'
    ],
    control_center_preference_endpoints: [
      '/api/settings/control-center',
      '/api/settings/ai-connections/refresh',
      '/api/settings/ai-connections/selection'
    ],
    agentic_review_endpoints: Object.values(CONTROL_CENTER_AGENTIC_REVIEW_ENDPOINTS),
    agentic_review_execution_requires_explicit_external_send_confirmation: true,
    mcp_json_rpc_exposed: false,
    cors_wildcard: false,
    cache_policy: 'no-store',
    boundary: controlCenterBoundary()
  };
}

function compatibilityAiReadiness(aiConnections, context) {
  if (!aiConnections || typeof aiConnections !== 'object') return buildControlCenterAiReadiness(context);
  const selected = aiConnections.selection;
  const status = aiConnections.status === 'available'
    ? 'available'
    : aiConnections.status === 'error'
      ? 'unavailable'
      : 'setup_required';
  return {
    status,
    service_name: selected?.connection_name ?? null,
    next_action: status === 'available'
      ? 'AI suggestions can be used after you review what will be sent.'
      : aiConnections.status_message,
    network_checked: false,
    can_continue_without_ai: true,
    technical_details_included: false
  };
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...securityHeaders()
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function sendActionEnvelope(response, command, result, context, acceptedStatus) {
  const envelope = createEnvelope({
    command,
    status: result.status,
    data: result.data,
    warnings: result.warnings,
    errors: result.errors,
    artifacts: result.artifacts,
    now: context.now
  });
  sendJson(response, result.status === 'ok' ? acceptedStatus : 400, envelope);
}

function decodeHeaderValue(value) {
  try {
    return decodeURIComponent(String(value ?? ''));
  } catch {
    return '';
  }
}

function securityHeaders() {
  return {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
  };
}

async function rejectAssetSymlinkComponents(root, target) {
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw unsafeAssetError();
  let current = root;
  for (const segment of relative.split(path.sep)) {
    if (!segment) continue;
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw unsafeAssetError();
  }
}

function unsafeAssetError() {
  const error = new Error('Unsafe Control Center asset.');
  error.code = 'CONTROL_CENTER_ASSET_UNSAFE';
  return error;
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return {
      ok: false,
      code: 'CONTROL_CENTER_INVALID_PORT',
      message: 'control-center serve --port must be an integer between 0 and 65535.'
    };
  }
  return { ok: true, value: port };
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function formatUrlHost(host) {
  return String(host).includes(':') ? `[${host}]` : host;
}
