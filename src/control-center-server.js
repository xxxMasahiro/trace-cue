import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createEnvelope } from './envelope.js';
import { runControlCenterStatus, controlCenterBoundary } from './control-center-read-model.js';
import {
  CONTROL_CENTER_JSON_BODY_LIMIT_BYTES,
  runControlCenterSetDisplayLanguage,
  runControlCenterSourceIntakeProposal
} from './control-center-actions.js';
import { isAllowedMcpHttpHost, isAllowedMcpHttpOrigin, isLoopbackHost } from './mcp-transport-policy.js';

const DEFAULT_CONTROL_CENTER_HOST = '127.0.0.1';
const DEFAULT_CONTROL_CENTER_PORT = 0;

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
  return {
    server,
    url,
    config: { ...config.config, port },
    metadata: controlCenterServerMetadata({ ...config.config, port }, url)
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
  return {
    ok: true,
    config: {
      host,
      port: port.value,
      cwd,
      staticRoot: path.resolve(cwd, 'dist', 'control-center'),
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

async function handleControlCenterRequest(request, response, config, context) {
  const validation = validateCommonRequest(request);
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
    const envelope = createEnvelope({
      command: 'control-center status',
      status: result.status,
      data: result.data,
      warnings: result.warnings,
      errors: result.errors,
      artifacts: result.artifacts,
      now: context.now
    });
    sendJson(response, result.status === 'ok' ? 200 : 500, envelope);
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
  if (request.method !== 'GET') {
    sendMethodNotAllowed(response, 'CONTROL_CENTER_ASSET_GET_ONLY', 'control-center assets only accept GET requests.');
    return;
  }
  await serveBuiltAsset(request, response, config);
}

function validateCommonRequest(request) {
  if (!isAllowedMcpHttpHost(request.headers.host)) {
    return {
      ok: false,
      status: 403,
      code: 'CONTROL_CENTER_HOST_REJECTED',
      message: 'control-center Host header must be loopback.'
    };
  }
  if (!isAllowedMcpHttpOrigin(request.headers.origin)) {
    return {
      ok: false,
      status: 403,
      code: 'CONTROL_CENTER_ORIGIN_REJECTED',
      message: 'control-center Origin header must be loopback when present.'
    };
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
    return {
      ok: true,
      value: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
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
  const pathname = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
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
    const body = await readFile(target);
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(target)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    response.end(body);
  } catch {
    sendJson(response, 503, {
      error: {
        code: 'CONTROL_CENTER_ASSETS_NOT_BUILT',
        message: 'Run npm run control-center:build before using control-center serve, or use npm run control-center:dev for Vite development.'
      }
    });
  }
}

function controlCenterServerMetadata(config, url) {
  return {
    url,
    host: config.host,
    port: config.port,
    local_only: true,
    read_only_dashboard: true,
    dashboard_get_only: true,
    bounded_local_action_endpoints: true,
    action_api_exposed: true,
    action_endpoints: ['/api/source-intake/proposal', '/api/settings/display-language'],
    mcp_json_rpc_exposed: false,
    cors_wildcard: false,
    cache_policy: 'no-store',
    static_root: config.staticRoot,
    boundary: controlCenterBoundary()
  };
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(`${JSON.stringify(body)}\n`);
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
