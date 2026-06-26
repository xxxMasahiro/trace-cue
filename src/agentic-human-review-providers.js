import { SCHEMA_VERSION } from './constants.js';
import { redact, truncateText } from './redaction.js';

export const AGENTIC_REVIEW_API_ENDPOINT_ENV = 'AGENTIC_HUMAN_REVIEW_API_ENDPOINT';
export const AGENTIC_REVIEW_API_CREDENTIAL_ENV = 'AGENTIC_HUMAN_REVIEW_API_TOKEN';

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_REQUEST_BYTES = 128 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;

export const AGENTIC_HUMAN_REVIEW_PROVIDERS = Object.freeze([
  Object.freeze({
    id: 'fake-agent',
    display_name: 'Deterministic fake agentic reviewer',
    kind: 'fake_provider',
    transport: 'local_function',
    implemented: true,
    credential_mode: 'none',
    default_model: 'fake-model',
    supported_modalities: Object.freeze(['metadata', 'text_summary', 'artifact_references']),
    transferable_evidence_classes: Object.freeze(['page_text', 'url', 'artifact_refs', 'accessibility_summary']),
    external_evidence_transfer: false,
    api_call_performed: false,
    raw_provider_response_stored: false,
    timeout_ms: 0,
    max_attempts: 1,
    max_request_bytes: DEFAULT_MAX_REQUEST_BYTES,
    max_response_bytes: DEFAULT_MAX_RESPONSE_BYTES,
    cost_policy: 'none'
  }),
  Object.freeze({
    id: 'injected-runner',
    display_name: 'Injected local agentic reviewer',
    kind: 'injected_runner',
    transport: 'local_callback',
    implemented: true,
    credential_mode: 'none',
    default_model: 'injected-local-model',
    supported_modalities: Object.freeze(['metadata', 'text_summary', 'artifact_references']),
    transferable_evidence_classes: Object.freeze(['page_text', 'url', 'artifact_refs', 'accessibility_summary']),
    external_evidence_transfer: false,
    api_call_performed: false,
    raw_provider_response_stored: false,
    timeout_ms: 0,
    max_attempts: 1,
    max_request_bytes: DEFAULT_MAX_REQUEST_BYTES,
    max_response_bytes: DEFAULT_MAX_RESPONSE_BYTES,
    cost_policy: 'none'
  }),
  Object.freeze({
    id: 'generic-api-provider',
    display_name: 'Generic API agentic reviewer',
    kind: 'api_provider',
    transport: 'provider_api',
    implemented: true,
    credential_mode: 'environment_variable_only',
    endpoint_env: AGENTIC_REVIEW_API_ENDPOINT_ENV,
    credential_env: AGENTIC_REVIEW_API_CREDENTIAL_ENV,
    default_model: 'generic-agentic-review-model',
    supported_modalities: Object.freeze(['metadata', 'text_summary', 'artifact_references']),
    transferable_evidence_classes: Object.freeze(['page_text', 'url', 'artifact_refs', 'accessibility_summary']),
    external_evidence_transfer: true,
    api_call_performed: true,
    raw_provider_response_stored: false,
    timeout_ms: DEFAULT_TIMEOUT_MS,
    max_attempts: 1,
    max_request_bytes: DEFAULT_MAX_REQUEST_BYTES,
    max_response_bytes: DEFAULT_MAX_RESPONSE_BYTES,
    cost_policy: 'unknown_cost_requires_owner_review'
  })
]);

export function agenticProviderSummary(provider) {
  const normalized = normalizeProviderDescriptor(provider);
  return {
    id: normalized.id,
    display_name: normalized.display_name,
    kind: normalized.kind,
    transport: normalized.transport,
    implemented: normalized.implemented === true,
    credential_mode: normalized.credential_mode,
    endpoint_env: normalized.endpoint_env ?? null,
    credential_env: normalized.credential_env ?? null,
    default_model: normalized.default_model,
    supported_modalities: [...(normalized.supported_modalities ?? [])],
    transferable_evidence_classes: [...(normalized.transferable_evidence_classes ?? [])],
    external_evidence_transfer: normalized.external_evidence_transfer === true,
    api_call_performed: false,
    raw_provider_response_stored: false,
    timeout_ms: normalized.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    max_attempts: normalized.max_attempts ?? 1,
    max_request_bytes: normalized.max_request_bytes ?? DEFAULT_MAX_REQUEST_BYTES,
    max_response_bytes: normalized.max_response_bytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    cost_policy: normalized.cost_policy ?? 'unknown_cost_requires_owner_review'
  };
}

export function resolveAgenticHumanReviewProvider({ providerId, context = {} } = {}) {
  const providers = [
    ...normalizeProviderDescriptors(context.agenticReviewProviders),
    ...AGENTIC_HUMAN_REVIEW_PROVIDERS
  ].map(normalizeProviderDescriptor);
  const id = providerId ?? 'fake-agent';
  const provider = providers.find((candidate) => candidate.id === id);
  if (!provider) {
    return {
      ok: false,
      error: {
        code: 'AGENTIC_REVIEW_PROVIDER_UNKNOWN',
        message: 'No agentic human review provider matched the requested provider.',
        details: {
          provider: id,
          available_providers: providers.map((candidate) => candidate.id)
        }
      }
    };
  }
  return { ok: true, provider: agenticProviderSummary(provider) };
}

export function buildAgenticProviderReadiness({
  providerId = 'all',
  surface = null,
  model = null,
  proposal = null,
  plan = null,
  context = {},
  now = new Date()
} = {}) {
  const providers = [
    ...normalizeProviderDescriptors(context.agenticReviewProviders),
    ...AGENTIC_HUMAN_REVIEW_PROVIDERS
  ].map((provider) => readinessProviderRecord(provider, { surface, model }));
  const selected = providerId && providerId !== 'all'
    ? providers.filter((provider) => provider.id === providerId)
    : providers;
  if (providerId && providerId !== 'all' && selected.length === 0) {
    return {
      ok: false,
      error: {
        code: 'AGENTIC_REVIEW_PROVIDER_UNKNOWN',
        message: 'No agentic human review provider matched the requested provider.',
        details: { provider: providerId, available_providers: providers.map((provider) => provider.id) }
      }
    };
  }
  return {
    ok: true,
    readiness: redact({
      schema_version: SCHEMA_VERSION,
      type: 'agentic_human_review_provider_readiness',
      generated_at: now.toISOString(),
      status: selected.some((provider) => provider.implemented) ? 'ready_for_approved_plan_execution' : 'not_available',
      selected_provider: providerId ?? 'all',
      providers: selected,
      input_context: {
        proposal_id: proposal?.id ?? null,
        proposal_hash: proposal?.proposal_hash ?? null,
        plan_id: plan?.id ?? null,
        plan_hash: plan?.plan_hash ?? null,
        surface_id: surface?.id ?? surface ?? null,
        model_id: model?.id ?? model ?? null
      },
      policy: {
        provider_execution_requires_approved_plan: true,
        execute_flag_required: true,
        exact_transfer_flags_required: true,
        credentials_env_only: true,
        credential_values_read_by_readiness: false,
        credential_values_recorded: false,
        raw_provider_response_stored: false,
        mcp_execution_exposed: false,
        advisory_only: true,
        gate_effect: 'none'
      },
      boundary: {
        local_only: true,
        read_only: true,
        provider_call_performed: false,
        api_call_performed: false,
        credential_values_read: false,
        credential_values_recorded: false,
        external_evidence_transfer: false,
        raw_provider_response_stored: false,
        mcp_execution_exposed: false,
        deterministic_findings_mutated: false,
        existing_review_mutated: false,
        gate_effect: 'none'
      }
    })
  };
}

export async function executeAgenticHumanReviewApiProvider({
  provider,
  model,
  surface,
  plan,
  planPath,
  reviewPackage,
  transferFlags,
  execution,
  context = {}
}) {
  const env = context.env ?? process.env;
  const endpoint = env[provider.endpoint_env];
  const credential = env[provider.credential_env];
  if (!endpoint || !credential) {
    return providerFailure({
      status: 'blocked',
      code: 'AGENTIC_REVIEW_API_CONFIGURATION_MISSING',
      message: 'Agentic human review API execution requires endpoint and credential environment variables.',
      details: {
        provider: provider.id,
        model: model.id,
        endpoint_env: provider.endpoint_env,
        credential_env: provider.credential_env,
        endpoint_configured: Boolean(endpoint),
        credential_configured: Boolean(credential),
        credential_values_recorded: false,
        api_call_performed: false
      },
      provider,
      providerCallPerformed: false,
      apiCallPerformed: false
    });
  }

  let endpointUrl;
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    return providerFailure({
      status: 'blocked',
      code: 'AGENTIC_REVIEW_API_ENDPOINT_INVALID',
      message: 'The agentic review API endpoint environment variable must contain an absolute URL.',
      details: {
        provider: provider.id,
        endpoint_env: provider.endpoint_env,
        credential_values_recorded: false,
        api_call_performed: false
      },
      provider
    });
  }
  if (!['https:', 'http:'].includes(endpointUrl.protocol)) {
    return providerFailure({
      status: 'blocked',
      code: 'AGENTIC_REVIEW_API_ENDPOINT_UNSUPPORTED_PROTOCOL',
      message: 'The agentic review API endpoint must use http or https.',
      details: {
        provider: provider.id,
        endpoint_env: provider.endpoint_env,
        endpoint_protocol: endpointUrl.protocol,
        credential_values_recorded: false,
        api_call_performed: false
      },
      provider
    });
  }

  const fetchImpl = context.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return providerFailure({
      status: 'blocked',
      code: 'AGENTIC_REVIEW_API_FETCH_UNAVAILABLE',
      message: 'No fetch implementation is available for agentic human review API execution.',
      details: {
        provider: provider.id,
        api_call_performed: false,
        credential_values_recorded: false
      },
      provider
    });
  }

  const payload = buildAgenticApiPayload({
    plan,
    planPath,
    reviewPackage,
    transferFlags,
    provider,
    model,
    surface,
    execution
  });
  const payloadText = JSON.stringify(payload);
  if (Buffer.byteLength(payloadText, 'utf8') > provider.max_request_bytes) {
    return providerFailure({
      status: 'blocked',
      code: 'AGENTIC_REVIEW_API_REQUEST_TOO_LARGE',
      message: 'The agentic review API request exceeds the provider request-size limit.',
      details: {
        provider: provider.id,
        request_bytes: Buffer.byteLength(payloadText, 'utf8'),
        max_request_bytes: provider.max_request_bytes,
        credential_values_recorded: false
      },
      provider
    });
  }

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeout = controller && provider.timeout_ms > 0
    ? setTimeout(() => controller.abort(), provider.timeout_ms)
    : null;
  let response;
  const started = Date.now();
  try {
    response = await fetchImpl(endpointUrl.toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${credential}`
      },
      body: payloadText,
      signal: controller?.signal
    });
  } catch (error) {
    if (timeout) {
      clearTimeout(timeout);
    }
    return providerFailure({
      status: 'failed',
      code: error?.name === 'AbortError' ? 'AGENTIC_REVIEW_API_REQUEST_TIMEOUT' : 'AGENTIC_REVIEW_API_REQUEST_FAILED',
      message: error?.name === 'AbortError'
        ? 'The agentic review API request timed out.'
        : 'The agentic review API request failed.',
      details: {
        provider: provider.id,
        failure_class: error?.name ?? 'Error',
        duration_ms: Date.now() - started,
        timeout_ms: provider.timeout_ms,
        credential_values_recorded: false,
        raw_provider_response_stored: false
      },
      provider,
      providerCallPerformed: true,
      apiCallPerformed: true,
      externalEvidenceTransfer: true
    });
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }

  const responseMeta = {
    status_code: response.status ?? null,
    ok: response.ok === true,
    duration_ms: Date.now() - started
  };
  if (!response.ok) {
    await discardResponseBody(response, provider.max_response_bytes);
    return providerFailure({
      status: 'failed',
      code: 'AGENTIC_REVIEW_API_RESPONSE_NOT_OK',
      message: 'The agentic review API response was not successful.',
      details: {
        provider: provider.id,
        ...responseMeta,
        credential_values_recorded: false,
        raw_provider_response_stored: false
      },
      provider,
      providerCallPerformed: true,
      apiCallPerformed: true,
      externalEvidenceTransfer: true
    });
  }

  const parsed = await parseBoundedResponse(response, provider.max_response_bytes);
  if (!parsed.ok) {
    return providerFailure({
      status: 'failed',
      code: parsed.code,
      message: parsed.message,
      details: {
        provider: provider.id,
        ...responseMeta,
        response_bytes: parsed.response_bytes ?? null,
        credential_values_recorded: false,
        raw_provider_response_stored: false
      },
      provider,
      providerCallPerformed: true,
      apiCallPerformed: true,
      externalEvidenceTransfer: true
    });
  }

  return {
    ok: true,
    status: 'completed',
    input: redactExactSecrets(parsed.value?.agentic_human_review_advisory ?? parsed.value ?? {}, [credential, endpoint]),
    boundary: providerBoundary({
      provider,
      providerCallPerformed: true,
      apiCallPerformed: true,
      externalEvidenceTransfer: true,
      responseBytes: parsed.response_bytes ?? null,
      requestBytes: Buffer.byteLength(payloadText, 'utf8'),
      statusCode: response.status ?? null,
      rawPixelsTransferred: false,
      pageTextTransferred: transferFlags.supplied_flags?.includes('allow-page-text') === true,
      domSummaryTransferred: transferFlags.supplied_flags?.includes('allow-dom-summary') === true,
      urlMetadataTransferred: transferFlags.supplied_flags?.includes('allow-url') === true,
      artifactRefsTransferred: transferFlags.supplied_flags?.includes('allow-artifact-refs') === true,
      accessibilitySummaryTransferred: transferFlags.supplied_flags?.includes('allow-accessibility-summary') === true
    }),
    warnings: []
  };
}

export function providerBoundary({
  provider,
  providerCallPerformed,
  apiCallPerformed,
  externalEvidenceTransfer,
  requestBytes = null,
  responseBytes = null,
  statusCode = null,
  rawPixelsTransferred = false,
  pageTextTransferred = false,
  domSummaryTransferred = false,
  urlMetadataTransferred = false,
  artifactRefsTransferred = false,
  accessibilitySummaryTransferred = false
}) {
  return {
    provider_adapter_implemented: provider.implemented === true,
    provider_call_performed: Boolean(providerCallPerformed),
    api_call_performed: Boolean(apiCallPerformed),
    external_evidence_transfer: Boolean(externalEvidenceTransfer),
    request_bytes: requestBytes,
    response_bytes: responseBytes,
    provider_status_code: statusCode,
    raw_pixels_transferred: Boolean(rawPixelsTransferred),
    page_text_transferred: Boolean(pageTextTransferred),
    dom_summary_transferred: Boolean(domSummaryTransferred),
    url_metadata_transferred: Boolean(urlMetadataTransferred),
    artifact_refs_transferred: Boolean(artifactRefsTransferred),
    accessibility_summary_transferred: Boolean(accessibilitySummaryTransferred),
    credential_values_recorded: false,
    raw_provider_response_stored: false
  };
}

function readinessProviderRecord(provider, { surface, model }) {
  const summary = agenticProviderSummary(provider);
  return {
    ...summary,
    requested_surface_id: surface?.id ?? surface ?? null,
    requested_model_id: model?.id ?? model ?? summary.default_model,
    credential_values_read_by_readiness: false,
    credential_values_recorded: false,
    raw_provider_response_stored: false,
    provider_call_performed: false,
    api_call_performed: false,
    external_evidence_transfer_performed: false,
    transfer_policy: {
      requires_approved_plan_hash: true,
      requires_exact_transfer_flags: true,
      mcp_execution_allowed: false,
      default_external_transfer: false,
      transferable_evidence_classes: summary.transferable_evidence_classes
    }
  };
}

function normalizeProviderDescriptors(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];
}

function normalizeProviderDescriptor(provider) {
  return {
    id: provider.id,
    display_name: provider.display_name ?? provider.id,
    kind: provider.kind ?? 'provider',
    transport: provider.transport ?? 'unknown',
    implemented: provider.implemented === true,
    credential_mode: provider.credential_mode ?? 'none',
    endpoint_env: provider.endpoint_env ?? null,
    credential_env: provider.credential_env ?? null,
    default_model: provider.default_model ?? 'fake-model',
    supported_modalities: Array.isArray(provider.supported_modalities) ? provider.supported_modalities : ['metadata'],
    transferable_evidence_classes: Array.isArray(provider.transferable_evidence_classes)
      ? provider.transferable_evidence_classes
      : ['page_text', 'url', 'artifact_refs', 'accessibility_summary'],
    external_evidence_transfer: provider.external_evidence_transfer === true,
    api_call_performed: provider.api_call_performed === true,
    raw_provider_response_stored: false,
    timeout_ms: Number.isFinite(Number(provider.timeout_ms)) ? Number(provider.timeout_ms) : DEFAULT_TIMEOUT_MS,
    max_attempts: Number.isFinite(Number(provider.max_attempts)) ? Number(provider.max_attempts) : 1,
    max_request_bytes: Number.isFinite(Number(provider.max_request_bytes)) ? Number(provider.max_request_bytes) : DEFAULT_MAX_REQUEST_BYTES,
    max_response_bytes: Number.isFinite(Number(provider.max_response_bytes)) ? Number(provider.max_response_bytes) : DEFAULT_MAX_RESPONSE_BYTES,
    cost_policy: provider.cost_policy ?? 'unknown_cost_requires_owner_review'
  };
}

function buildAgenticApiPayload({ plan, planPath, reviewPackage, transferFlags, provider, model, surface, execution }) {
  return redact({
    schema_version: SCHEMA_VERSION,
    type: 'agentic_human_review_request',
    plan: {
      id: plan.id,
      plan_path: planPath,
      plan_hash: plan.plan_hash,
      intent: plan.intent,
      review_scope: plan.review_scope,
      review_effort: plan.review_effort,
      sub_agents: plan.sub_agents,
      rounds: plan.rounds,
      rubric: plan.rubric,
      dogfood_metadata: plan.dogfood_metadata ?? null
    },
    package: filterReviewPackageForTransfer(reviewPackage, transferFlags),
    provider: {
      id: provider.id,
      kind: provider.kind,
      transport: provider.transport,
      raw_provider_response_stored: false
    },
    model: { id: model.id },
    surface: {
      id: surface.id,
      kind: surface.kind ?? null
    },
    execution: {
      id: execution.id,
      execution_path: execution.execution_path
    },
    disclosure_policy: {
      approved_transfer_flags: transferFlags.supplied_flags,
      raw_pixels_included: false,
      raw_artifact_content_included: false,
      page_text_summary_included: transferFlags.supplied_flags?.includes('allow-page-text') === true,
      dom_summary_included: transferFlags.supplied_flags?.includes('allow-dom-summary') === true,
      url_metadata_included: transferFlags.supplied_flags?.includes('allow-url') === true,
      artifact_references_included: transferFlags.supplied_flags?.includes('allow-artifact-refs') === true,
      accessibility_summary_included: transferFlags.supplied_flags?.includes('allow-accessibility-summary') === true,
      external_evidence_transfer: true,
      mcp_execution_allowed: false
    }
  });
}

function filterReviewPackageForTransfer(reviewPackage, transferFlags) {
  const flags = new Set(transferFlags.supplied_flags ?? []);
  return {
    id: reviewPackage?.id ?? null,
    package_kind: reviewPackage?.package_kind ?? null,
    source: {
      review_id: reviewPackage?.source?.review_id ?? null,
      review_mode: reviewPackage?.source?.review_mode ?? null,
      route: flags.has('allow-url') ? reviewPackage?.source?.route ?? null : null,
      viewport: reviewPackage?.source?.viewport ?? null,
      evidence_classes: reviewPackage?.source?.evidence_classes ?? []
    },
    task: reviewPackage?.task ?? null,
    visual_evidence: flags.has('allow-raw-pixels')
      ? {
          reference_count: reviewPackage?.visual_evidence?.reference_count ?? 0,
          references: reviewPackage?.visual_evidence?.references ?? [],
          raw_pixels_embedded_in_json: false
        }
      : { reference_count: 0, references: [], raw_pixels_embedded_in_json: false },
    content_evidence: flags.has('allow-page-text')
      ? reviewPackage?.content_evidence ?? null
      : { text_snippet_count: 0, text_snippets: [], page_text_included_as_bounded_summary: false },
    semantic_evidence: flags.has('allow-accessibility-summary') ? reviewPackage?.semantic_evidence ?? null : null,
    artifact_references: flags.has('allow-artifact-refs') ? reviewPackage?.artifact_references ?? [] : [],
    existing_review_state: reviewPackage?.existing_review_state ?? null,
    disclosure: {
      raw_pixels_embedded_in_json: false,
      raw_artifact_content_included: false
    }
  };
}

async function parseBoundedResponse(response, maxResponseBytes) {
  if (typeof response.text === 'function') {
    const text = await response.text();
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > maxResponseBytes) {
      return {
        ok: false,
        code: 'AGENTIC_REVIEW_API_RESPONSE_TOO_LARGE',
        message: 'The agentic review API response exceeds the provider response-size limit.',
        response_bytes: bytes
      };
    }
    try {
      return { ok: true, value: JSON.parse(text), response_bytes: bytes };
    } catch {
      return {
        ok: false,
        code: 'AGENTIC_REVIEW_API_RESPONSE_INVALID_JSON',
        message: 'The agentic review API response was not valid JSON.',
        response_bytes: bytes
      };
    }
  }
  if (typeof response.json === 'function') {
    const value = await response.json();
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
    if (bytes > maxResponseBytes) {
      return {
        ok: false,
        code: 'AGENTIC_REVIEW_API_RESPONSE_TOO_LARGE',
        message: 'The agentic review API response exceeds the provider response-size limit.',
        response_bytes: bytes
      };
    }
    return { ok: true, value, response_bytes: bytes };
  }
  return {
    ok: false,
    code: 'AGENTIC_REVIEW_API_RESPONSE_UNREADABLE',
    message: 'The agentic review API response body could not be read.'
  };
}

async function discardResponseBody(response, maxResponseBytes) {
  try {
    await parseBoundedResponse(response, maxResponseBytes);
  } catch {
    // Discard failures are intentionally ignored; raw responses are never stored.
  }
}

function providerFailure({
  status,
  code,
  message,
  details,
  provider,
  providerCallPerformed = false,
  apiCallPerformed = false,
  externalEvidenceTransfer = false
}) {
  return {
    ok: false,
    status,
    error: { code, message, details: redact(details ?? {}) },
    boundary: providerBoundary({
      provider,
      providerCallPerformed,
      apiCallPerformed,
      externalEvidenceTransfer
    }),
    warnings: []
  };
}

function redactExactSecrets(value, secrets) {
  const filtered = secrets.filter(Boolean).map(String);
  if (typeof value === 'string') {
    return filtered.reduce((text, secret) => text.split(secret).join('[REDACTED]'), truncateText(value, 2000));
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactExactSecrets(item, filtered));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactExactSecrets(item, filtered)]));
  }
  return value;
}
