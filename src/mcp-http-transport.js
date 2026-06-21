import { createServer } from 'node:http';
import { once } from 'node:events';
import { handleMcpRequest } from './mcp.js';
import { PRODUCT_IDENTITY } from './product-identity.js';
import {
  MCP_HTTP_PROTOCOL_VERSION,
  isAllowedMcpHttpHost,
  isAllowedMcpHttpOrigin,
  publicMcpTransportMetadata,
  resolveMcpTransportConfig
} from './mcp-transport-policy.js';

export async function startMcpHttpServer(options = {}, context = {}) {
  const env = context.env ?? process.env;
  const resolved = resolveMcpTransportConfig({ ...options, transport: 'http' }, env);
  if (!resolved.ok) {
    throw new Error(resolved.message);
  }
  const config = resolved.config;
  const server = createMcpHttpServer(config, context);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const urlHost = formatUrlHost(config.host);
  return {
    server,
    url: `http://${urlHost}:${port}${config.endpoint}`,
    config: { ...config, port },
    metadata: publicMcpTransportMetadata({ ...config, port })
  };
}

export async function runMcpHttp(options = {}, context = {}) {
  const started = await startMcpHttpServer(options, context);
  const stderr = context.stderr ?? process.stderr;
  stderr.write(`${JSON.stringify({
    event: 'browser_debug_mcp_http_listening',
    url: started.url,
    transport: started.metadata.transport,
    profile: started.metadata.profile,
    auth_required: started.metadata.auth_required
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
}

export function createMcpHttpServer(config, context = {}) {
  return createServer(async (request, response) => {
    try {
      await handleHttpRequest(request, response, config, context);
    } catch {
      sendJson(response, 500, { error: 'Internal MCP HTTP transport error.' });
    }
  });
}

async function handleHttpRequest(request, response, config, context) {
  const validation = validateHttpRequest(request, config);
  if (!validation.ok) {
    sendJson(response, validation.status, { error: validation.message }, validation.headers);
    return;
  }

  const body = await readLimitedBody(request, config.bodyLimitBytes);
  if (!body.ok) {
    sendJson(response, body.status, { error: body.message });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(body.text);
  } catch {
    sendJson(response, 400, { error: 'HTTP MCP request body must be valid JSON.' });
    return;
  }

  if (Array.isArray(payload)) {
    sendJson(response, 400, { error: 'HTTP MCP transport accepts one JSON-RPC message per request in this phase.' });
    return;
  }

  const result = await handleMcpRequest(payload, {
    ...context,
    env: context.env ?? process.env,
    mcpProfile: config.profile,
    mcpTransport: 'http'
  });
  sendJson(response, 200, result, { 'MCP-Protocol-Version': MCP_HTTP_PROTOCOL_VERSION });
}

function validateHttpRequest(request, config) {
  if (request.method !== 'POST') {
    return { ok: false, status: 405, message: 'HTTP MCP transport only accepts POST in this phase.' };
  }
  if (!isAllowedMcpHttpHost(request.headers.host)) {
    return { ok: false, status: 403, message: 'HTTP MCP Host header must be loopback.' };
  }
  let url;
  try {
    url = new URL(request.url ?? '/', `http://${request.headers.host}`);
  } catch {
    return { ok: false, status: 400, message: 'HTTP MCP request URL is invalid.' };
  }
  if (url.pathname !== config.endpoint) {
    return { ok: false, status: 404, message: 'Unknown HTTP MCP endpoint.' };
  }
  if (!isAllowedMcpHttpOrigin(request.headers.origin)) {
    return { ok: false, status: 403, message: 'HTTP MCP Origin header must be loopback when present.' };
  }
  const contentType = String(request.headers['content-type'] ?? '');
  if (!contentType.toLowerCase().includes('application/json')) {
    return { ok: false, status: 415, message: 'HTTP MCP transport requires application/json requests.' };
  }
  const expected = `Bearer ${config.token}`;
  if (request.headers.authorization !== expected) {
    return {
      ok: false,
      status: 401,
      message: 'HTTP MCP bearer token is missing or invalid.',
      headers: { 'WWW-Authenticate': `Bearer realm="${PRODUCT_IDENTITY.mcpServerName}"` }
    };
  }
  return { ok: true };
}

function readLimitedBody(request, limit) {
  return new Promise((resolve) => {
    let settled = false;
    let size = 0;
    let text = '';
    const finish = (result) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      if (settled) {
        return;
      }
      size += Buffer.byteLength(chunk, 'utf8');
      if (size > limit) {
        finish({ ok: false, status: 413, message: 'HTTP MCP request body is too large.' });
        return;
      }
      text += chunk;
    });
    request.on('end', () => finish({ ok: true, text }));
    request.on('error', () => finish({ ok: false, status: 400, message: 'HTTP MCP request body could not be read.' }));
  });
}

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function formatUrlHost(host) {
  return String(host).includes(':') ? `[${host}]` : host;
}
