import { createHash } from 'node:crypto';
import {
  resolveAgenticHumanReviewProvider,
  resolveAgenticHumanReviewProviderModel
} from './agentic-human-review-providers.js';
import {
  CONTROL_CENTER_AGENTIC_REVIEW_PROVIDER_ENV,
  CONTROL_CENTER_AGENTIC_REVIEW_SERVICE_NAME_ENV
} from './control-center-agentic-review-config.js';

export function buildControlCenterAiReadiness(context = {}) {
  const env = context.env ?? process.env;
  const providerId = configuredProviderId(context, env);
  const serviceName = configuredServiceName(context, env);
  if (!serviceName) {
    return publicReadiness('setup_required', null, 'Choose the AI review service once, then return here.');
  }
  const resolved = resolveAgenticHumanReviewProvider({ providerId, context });
  if (!resolved.ok || resolved.provider?.implemented !== true) {
    return publicReadiness('unavailable', serviceName, 'Continue without AI or ask the person who set up TraceCue.');
  }
  const provider = resolved.provider;
  const endpoint = provider.endpoint_env ? configuredEnvValue(env, provider.endpoint_env) : null;
  const endpointUrl = provider.endpoint_env ? safeProviderEndpoint(endpoint) : null;
  const credentialReady = !provider.credential_env || Boolean(configuredEnvValue(env, provider.credential_env));
  const modelReady = resolveAgenticHumanReviewProviderModel({
    provider,
    model: { id: provider.default_model },
    context: { ...context, env },
    endpointUrl
  }).ok;
  return (!provider.endpoint_env || endpointUrl) && credentialReady && modelReady
    ? publicReadiness('available', serviceName, 'AI suggestions can be used after you review what will be sent.')
    : publicReadiness('setup_required', serviceName, 'Finish the private AI connection setup, or continue without AI.');
}

export function buildControlCenterAiDestinationFingerprint(context = {}, overrides = {}) {
  const env = context.env ?? process.env;
  const providerId = overrides.providerId ?? configuredProviderId(context, env);
  const serviceName = overrides.serviceName ?? configuredServiceName(context, env) ?? 'local-review';
  const resolved = resolveAgenticHumanReviewProvider({ providerId, context });
  const provider = resolved.ok ? resolved.provider : null;
  const endpointValue = provider?.endpoint_env && hasOwnEnv(env, provider.endpoint_env)
    ? String(env[provider.endpoint_env])
    : '';
  const endpointUrl = safeProviderEndpoint(endpointValue);
  const requestedModelId = cleanString(overrides.modelId) ?? provider?.default_model ?? null;
  const modelResolution = provider
    ? resolveAgenticHumanReviewProviderModel({
      provider,
      model: { id: requestedModelId },
      context: { ...context, env },
      endpointUrl
    })
    : null;
  const binding = {
    provider_id: providerId,
    service_name: serviceName,
    transport: provider?.transport ?? 'configured-runner',
    endpoint: normalizeEndpointForBinding(endpointValue),
    requested_model_id: requestedModelId,
    effective_model_id: modelResolution?.ok === true
      ? modelResolution.model?.id ?? null
      : 'unresolved'
  };
  if (Object.hasOwn(overrides, 'providerEffort')
    || Object.hasOwn(overrides, 'adapterId')
    || Object.hasOwn(overrides, 'capabilityHash')) {
    binding.provider_effort = cleanString(overrides.providerEffort);
    binding.adapter_id = cleanString(overrides.adapterId);
    binding.semantic_capability_hash = cleanString(overrides.capabilityHash);
  }
  return createHash('sha256').update(canonicalStringify(binding)).digest('hex');
}

function publicReadiness(status, serviceName, nextAction) {
  return {
    status,
    service_name: serviceName,
    next_action: nextAction,
    network_checked: false,
    can_continue_without_ai: true,
    technical_details_included: false
  };
}

function configuredProviderId(context, env) {
  return cleanString(
    context.agenticReviewProviderId
      ?? context.controlCenterAgenticReviewProvider
      ?? env[CONTROL_CENTER_AGENTIC_REVIEW_PROVIDER_ENV]
      ?? 'generic-api-provider'
  ) ?? 'generic-api-provider';
}

function configuredServiceName(context, env) {
  return cleanString(
    context.agenticReviewServiceName
      ?? context.controlCenterAgenticReviewServiceName
      ?? env[CONTROL_CENTER_AGENTIC_REVIEW_SERVICE_NAME_ENV]
  );
}

function hasOwnEnv(env, key) {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(env, key);
}

function configuredEnvValue(env, key) {
  if (!hasOwnEnv(env, key)) return null;
  const value = String(env[key] ?? '').trim();
  return value || null;
}

function safeProviderEndpoint(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
    if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) return null;
    for (const key of url.searchParams.keys()) {
      if (/(?:token|secret|password|passwd|api[_-]?key|credential|authorization)/iu.test(key)) return null;
    }
    return url;
  } catch {
    return null;
  }
}

function normalizeEndpointForBinding(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}${url.search}`;
  } catch {
    return `invalid:${value}`;
  }
}

function cleanString(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= 240 ? normalized : null;
}

function canonicalStringify(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
