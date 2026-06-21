import { resolveMcpProfile } from './mcp-profiles.js';

export const MCP_HTTP_DEFAULT_PROFILE = 'safe';
export const MCP_HTTP_DEFAULT_HOST = '127.0.0.1';
export const MCP_HTTP_DEFAULT_PORT = 0;
export const MCP_HTTP_DEFAULT_ENDPOINT = '/mcp';
export const MCP_HTTP_DEFAULT_TOKEN_ENV = 'TRACE_CUE_MCP_HTTP_TOKEN';
export const MCP_HTTP_LEGACY_TOKEN_ENVS = Object.freeze(['BROWSER_DEBUG_MCP_HTTP_TOKEN']);
export const MCP_HTTP_DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;
export const MCP_HTTP_PROTOCOL_VERSION = '2025-06-18';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1']);
const SUPPORTED_TRANSPORTS = new Set(['stdio', 'http']);

export function resolveMcpTransportConfig(options = {}, env = {}, settings = {}) {
  const transport = String(options.transport ?? 'stdio').trim();
  if (!SUPPORTED_TRANSPORTS.has(transport)) {
    return {
      ok: false,
      code: 'INVALID_MCP_TRANSPORT',
      message: `Unsupported MCP transport: ${transport}. Expected one of: ${[...SUPPORTED_TRANSPORTS].join(', ')}.`
    };
  }

  if (transport === 'stdio') {
    const profile = resolveMcpProfile(options.profile, env);
    if (!profile.ok) {
      return { ok: false, code: 'INVALID_MCP_PROFILE', message: profile.message };
    }
    return {
      ok: true,
      config: {
        transport,
        profile: profile.profile,
        external_listener: false,
        local_only: true,
        auth_required: false
      }
    };
  }

  return resolveHttpConfig(options, env, settings);
}

export function publicMcpTransportMetadata(config) {
  if (config.transport === 'stdio') {
    return {
      transport: 'stdio',
      local_only: true,
      external_channel: false,
      auth_required: false,
      profile: config.profile
    };
  }
  return {
    transport: 'http',
    local_only: true,
    external_channel: false,
    auth_required: true,
    token_env: config.tokenEnv,
    host: config.host,
    port: config.port,
    endpoint: config.endpoint,
    profile: config.profile,
    body_limit_bytes: config.bodyLimitBytes,
    origin_validation: true,
    cors_wildcard: false,
    streamable_http_subset: 'post_json_response_only'
  };
}

export function isLoopbackHost(value) {
  return LOOPBACK_HOSTS.has(String(value ?? '').trim());
}

export function isAllowedMcpHttpOrigin(origin) {
  if (!origin) {
    return true;
  }
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

export function isAllowedMcpHttpHost(hostHeader) {
  if (!hostHeader) {
    return false;
  }
  const value = String(hostHeader).trim();
  const bracketedIpv6 = value.match(/^\[([^\]]+)\](?::\d+)?$/u);
  if (bracketedIpv6) {
    return isLoopbackHost(bracketedIpv6[1]);
  }
  const host = value.replace(/:\d+$/u, '');
  return isLoopbackHost(host);
}

function resolveHttpConfig(options, env, settings) {
  const profileName = String(options.profile ?? MCP_HTTP_DEFAULT_PROFILE).trim();
  if (profileName !== MCP_HTTP_DEFAULT_PROFILE) {
    return {
      ok: false,
      code: 'HTTP_MCP_PROFILE_REJECTED',
      message: 'HTTP MCP transport is limited to the safe profile in this phase.'
    };
  }
  const profile = resolveMcpProfile(profileName, {});
  if (!profile.ok) {
    return { ok: false, code: 'INVALID_MCP_PROFILE', message: profile.message };
  }

  const host = String(options.host ?? MCP_HTTP_DEFAULT_HOST).trim();
  if (!isLoopbackHost(host)) {
    return {
      ok: false,
      code: 'HTTP_MCP_HOST_REJECTED',
      message: 'HTTP MCP transport must bind to a loopback host only.',
      details: { host }
    };
  }

  const port = parseIntegerOption(options.port ?? MCP_HTTP_DEFAULT_PORT, 'port', { min: 0, max: 65535 });
  if (!port.ok) {
    return port;
  }

  const endpoint = normalizeEndpoint(options.endpoint ?? MCP_HTTP_DEFAULT_ENDPOINT);
  if (!endpoint.ok) {
    return endpoint;
  }

  const bodyLimit = parseIntegerOption(
    options.bodyLimitBytes ?? options.bodyLimit ?? MCP_HTTP_DEFAULT_BODY_LIMIT_BYTES,
    'body-limit',
    { min: 1, max: 10 * 1024 * 1024 }
  );
  if (!bodyLimit.ok) {
    return bodyLimit;
  }

  const tokenEnv = String(options.tokenEnv ?? MCP_HTTP_DEFAULT_TOKEN_ENV).trim();
  if (!/^[A-Z_][A-Z0-9_]*$/u.test(tokenEnv)) {
    return {
      ok: false,
      code: 'HTTP_MCP_TOKEN_ENV_INVALID',
      message: 'HTTP MCP token environment variable name is invalid.'
    };
  }

  const token = resolveHttpToken(env, tokenEnv);
  if (settings.requireToken !== false && (!token || String(token).length < 16)) {
    return {
      ok: false,
      code: 'HTTP_MCP_TOKEN_REQUIRED',
      message: `HTTP MCP transport requires a bearer token in ${tokenEnv}.`
    };
  }

  return {
    ok: true,
    config: {
      transport: 'http',
      profile: profile.profile,
      external_listener: false,
      local_only: true,
      host,
      port: port.value,
      endpoint: endpoint.value,
      tokenEnv,
      token: settings.includeToken === false ? undefined : token,
      bodyLimitBytes: bodyLimit.value,
      auth_required: true,
      origin_validation: true,
      cors_wildcard: false
    }
  };
}

function resolveHttpToken(env, tokenEnv) {
  if (env[tokenEnv]) {
    return env[tokenEnv];
  }
  if (tokenEnv === MCP_HTTP_DEFAULT_TOKEN_ENV) {
    for (const legacyEnv of MCP_HTTP_LEGACY_TOKEN_ENVS) {
      if (env[legacyEnv]) {
        return env[legacyEnv];
      }
    }
  }
  return undefined;
}

function parseIntegerOption(value, label, bounds) {
  const text = String(value).trim();
  if (!/^\d+$/u.test(text)) {
    return {
      ok: false,
      code: 'INVALID_MCP_TRANSPORT_OPTION',
      message: `MCP ${label} must be an integer.`
    };
  }
  const parsed = Number.parseInt(text, 10);
  if (parsed < bounds.min || parsed > bounds.max) {
    return {
      ok: false,
      code: 'INVALID_MCP_TRANSPORT_OPTION',
      message: `MCP ${label} must be between ${bounds.min} and ${bounds.max}.`
    };
  }
  return { ok: true, value: parsed };
}

function normalizeEndpoint(value) {
  const endpoint = String(value).trim();
  if (!endpoint.startsWith('/') || endpoint.includes('?') || endpoint.includes('#') || endpoint.includes('..')) {
    return {
      ok: false,
      code: 'HTTP_MCP_ENDPOINT_INVALID',
      message: 'HTTP MCP endpoint must be an absolute path without query, fragment, or traversal.'
    };
  }
  return { ok: true, value: endpoint };
}
