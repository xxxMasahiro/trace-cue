import {
  agenticProviderCapabilityHash,
  resolveAgenticHumanReviewProvider,
  resolveAgenticHumanReviewProviderModel
} from './agentic-human-review-providers.js';
import {
  CODEX_SUBSCRIPTION_ADAPTER_ID,
  CODEX_SUBSCRIPTION_ADAPTER_VERSION,
  probeCodexSubscriptionCli
} from './codex-subscription-adapter.js';
import {
  CONTROL_CENTER_AGENTIC_REVIEW_PROVIDER_ENV,
  CONTROL_CENTER_AGENTIC_REVIEW_SERVICE_NAME_ENV
} from './control-center-agentic-review-config.js';
import {
  emptyControlCenterAiConnectionsProjection,
  projectControlCenterAiConnections,
  resolveControlCenterAiSelection
} from './control-center-ai-connections.js';
import {
  controlCenterAiConnectionStoreBoundary,
  readControlCenterAiConnectionRecord,
  readControlCenterAiConnectionsProjection,
  replaceControlCenterAiConnections,
  saveControlCenterAiSelection
} from './control-center-ai-connection-store.js';

export const CONTROL_CENTER_AI_REFRESH_CONFIRM = 'refresh-ai-availability';
export const CONTROL_CENTER_AI_SELECTION_CONFIRM = 'save-ai-selection';

export async function runControlCenterAiConnectionsRefresh(input = {}, context = {}) {
  if (String(input.confirm ?? '') !== CONTROL_CENTER_AI_REFRESH_CONFIRM) {
    return actionError('CONTROL_CENTER_AI_REFRESH_CONFIRM_REQUIRED', 'Updating AI availability requires an explicit action.');
  }
  const expectedRevision = normalizeRevision(input.expected_revision);
  if (expectedRevision === null) {
    return actionError('CONTROL_CENTER_AI_REFRESH_REVISION_INVALID', 'Refresh the page and try updating AI availability again.');
  }
  const discovered = await discoverControlCenterAiConnections(context);
  if (!discovered.ok) return actionError(discovered.error.code, discovered.error.message);
  const saved = await replaceControlCenterAiConnections({
    connections: discovered.connections,
    expectedRevision,
    selection: discovered.selection
  }, context);
  if (!saved.ok) return actionError(saved.error.code, saved.error.message, saved.error.details);
  return actionOk({
    ai_connections: {
      ...saved.projection,
      storage_revision: saved.record.settings_revision
    },
    boundary: refreshBoundary(discovered.boundary)
  });
}

export async function runControlCenterAiSelectionSave(input = {}, context = {}) {
  if (String(input.confirm ?? '') !== CONTROL_CENTER_AI_SELECTION_CONFIRM) {
    return actionError('CONTROL_CENTER_AI_SELECTION_CONFIRM_REQUIRED', 'Saving the AI choice requires an explicit action.');
  }
  const saved = await saveControlCenterAiSelection(input, context);
  if (!saved.ok) return actionError(saved.error.code, saved.error.message, saved.error.details);
  return actionOk({
    ai_connections: {
      ...saved.projection,
      storage_revision: saved.record.settings_revision
    },
    boundary: selectionBoundary()
  });
}

export async function readControlCenterAiConnections(context = {}) {
  const stored = await readControlCenterAiConnectionRecord(context);
  if (stored.ok && stored.record) {
    const projection = projectControlCenterAiConnections(stored.record, { now: materializeNow(context.now) });
    return { ...projection, storage_revision: stored.record.settings_revision };
  }
  if (!stored.ok) return readControlCenterAiConnectionsProjection(context);
  return { ...emptyControlCenterAiConnectionsProjection(), storage_revision: 0 };
}

export async function resolveControlCenterAiBinding(input = {}, context = {}) {
  const loaded = await loadAuthoritativeOrConfiguredRecord(context);
  if (!loaded.ok) return loaded;
  return resolveControlCenterAiSelection(loaded.record, {
    connection_option_id: input.connection_option_id,
    model_option_id: input.model_option_id,
    effort_option_id: input.effort_option_id,
    capability_revision: input.capability_revision,
    capability_token: input.capability_token
  }, { now: materializeNow(context.now) });
}

export async function revalidateControlCenterAiBinding(binding, context = {}) {
  if (!binding || typeof binding !== 'object') {
    return actionValidationError('CONTROL_CENTER_AI_BINDING_MISSING', 'The approved AI choice is missing.');
  }
  const loaded = await loadAuthoritativeOrConfiguredRecord(context);
  if (!loaded.ok) return loaded;
  const resolved = resolveControlCenterAiSelection(loaded.record, {
    connection_option_id: binding.connection_option_id,
    model_option_id: binding.model_option_id,
    effort_option_id: binding.effort_option_id,
    capability_revision: binding.capability_revision,
    capability_token: binding.capability_token
  }, { now: materializeNow(context.now) });
  if (!resolved.ok) return resolved;
  const expected = binding.execution_binding;
  if (!expected || canonicalTuple(expected) !== canonicalTuple(resolved.binding)) {
    return actionValidationError('CONTROL_CENTER_AI_BINDING_CHANGED', 'AI availability changed. Review the send details again.');
  }
  const provider = resolveAgenticHumanReviewProvider({ providerId: resolved.binding.provider_id, context });
  if (!provider.ok || agenticProviderCapabilityHash(provider.provider) !== resolved.binding.provider_capability_hash) {
    return actionValidationError('CONTROL_CENTER_AI_PROVIDER_CHANGED', 'The AI service changed. Update availability and review the send details again.');
  }
  return resolved;
}

export async function discoverControlCenterAiConnections(context = {}) {
  if (typeof context.discoverControlCenterAiConnections === 'function') {
    const value = await context.discoverControlCenterAiConnections();
    return {
      ok: true,
      connections: Array.isArray(value?.connections) ? value.connections : [],
      selection: value?.selection ?? null,
      boundary: {
        process_spawned: value?.boundary?.process_spawned === true,
        network_used: value?.boundary?.network_used === true,
        credential_values_read: value?.boundary?.credential_values_read === true
      }
    };
  }
  const configured = await discoverConfiguredConnections(context);
  if (!configured.ok) return configured;
  const connections = [...configured.connections];
  const codex = await probeCodexSubscriptionCli(context);
  if (codex.ok) {
    const provider = resolveAgenticHumanReviewProvider({ providerId: CODEX_SUBSCRIPTION_ADAPTER_ID, context });
    if (provider.ok) {
      connections.push({
        id: 'codex-subscription',
        display_name: 'Codex',
        connection_type: 'subscription',
        status: codex.login_ready ? 'available' : 'setup_required',
        status_message: codex.login_ready ? 'Ready to use with your signed-in Codex account.' : 'Sign in to Codex, then update availability.',
        adapter_id: CODEX_SUBSCRIPTION_ADAPTER_ID,
        adapter_version: CODEX_SUBSCRIPTION_ADAPTER_VERSION,
        provider_id: provider.provider.id,
        transport: provider.provider.transport,
        execution_strategy: 'one-shot',
        provider_effort_request_field: 'model_reasoning_effort',
        provider_capability_hash: agenticProviderCapabilityHash(provider.provider),
        executable_identity_hash: codex.executable_identity_hash,
        models: codex.models,
        default_model_id: codex.default_model_id
      });
    }
  }
  return {
    ok: true,
    connections: uniqueConnections(connections),
    selection: null,
    boundary: {
      process_spawned: configured.boundary.process_spawned || codex.process_started === true,
      network_used: false,
      credential_values_read: configured.boundary.credential_values_read || codex.credential_values_read === true,
      raw_probe_output_stored: false
    }
  };
}

async function discoverConfiguredConnections(context) {
  if (Array.isArray(context.controlCenterAiConnections)) {
    return {
      ok: true,
      connections: context.controlCenterAiConnections,
      boundary: { process_spawned: false, network_used: false, credential_values_read: false }
    };
  }
  const env = context.env ?? process.env;
  const providerId = cleanString(
    context.agenticReviewProviderId
      ?? context.controlCenterAgenticReviewProvider
      ?? env[CONTROL_CENTER_AGENTIC_REVIEW_PROVIDER_ENV]
      ?? 'generic-api-provider'
  );
  const serviceName = cleanString(
    context.agenticReviewServiceName
      ?? context.controlCenterAgenticReviewServiceName
      ?? env[CONTROL_CENTER_AGENTIC_REVIEW_SERVICE_NAME_ENV]
  );
  if (!providerId || !serviceName || providerId === CODEX_SUBSCRIPTION_ADAPTER_ID) {
    return { ok: true, connections: [], boundary: { process_spawned: false, network_used: false, credential_values_read: false } };
  }
  const resolved = resolveAgenticHumanReviewProvider({ providerId, context });
  if (!resolved.ok || resolved.provider.implemented !== true) {
    return { ok: true, connections: [], boundary: { process_spawned: false, network_used: false, credential_values_read: false } };
  }
  const provider = resolved.provider;
  const endpointReady = !provider.endpoint_env || hasConfiguredValue(env, provider.endpoint_env);
  const credentialReady = !provider.credential_env || hasConfiguredValue(env, provider.credential_env);
  const requestedModel = cleanString(context.agenticReviewModelId)
    ?? (provider.runtime_model_env && hasConfiguredValue(env, provider.runtime_model_env) ? String(env[provider.runtime_model_env]).trim() : null)
    ?? provider.default_model;
  const modelResolution = resolveAgenticHumanReviewProviderModel({ provider, model: { id: requestedModel }, context });
  const modelId = modelResolution.ok ? modelResolution.model.id : requestedModel;
  const nativeBinding = provider.effort_capability?.native_effort_binding ?? {};
  const supportedValues = Array.isArray(nativeBinding.supported_values) ? nativeBinding.supported_values : [];
  const efforts = nativeBinding.supported === true && supportedValues.length > 0
    ? supportedValues.map((id) => ({ id, display_name: humanize(id) }))
    : [{ id: 'not-applicable', display_name: 'Recommended' }];
  const recommendedEffort = cleanString(nativeBinding.effort_map?.standard);
  const defaultEffortId = efforts.some((item) => item.id === recommendedEffort)
    ? recommendedEffort
    : efforts[0].id;
  const available = endpointReady && credentialReady && modelResolution.ok;
  return {
    ok: true,
    connections: [{
      id: `configured-${provider.id}`,
      display_name: serviceName,
      connection_type: provider.transport === 'provider_api' ? 'api' : 'local',
      status: available ? 'available' : 'setup_required',
      status_message: available ? 'Ready to use.' : 'Finish the private AI setup, then update availability.',
      adapter_id: `configured-${provider.kind}`,
      adapter_version: '1.0.0',
      provider_id: provider.id,
      transport: provider.transport,
      execution_strategy: 'one-shot',
      provider_effort_request_field: nativeBinding.supported === true ? nativeBinding.request_field : null,
      provider_capability_hash: agenticProviderCapabilityHash(provider),
      executable_identity_hash: null,
      models: [{
        id: modelId,
        display_name: modelId,
        native_efforts: efforts,
        default_native_effort_id: defaultEffortId
      }],
      default_model_id: modelId
    }],
    boundary: {
      process_spawned: false,
      network_used: false,
      credential_values_read: Boolean(provider.credential_env)
    }
  };
}

async function loadAuthoritativeOrConfiguredRecord(context) {
  const stored = await readControlCenterAiConnectionRecord(context);
  if (stored.ok && stored.record) return stored;
  if (!stored.ok) return stored;
  return actionValidationError('CONTROL_CENTER_AI_CONNECTION_NOT_CHECKED', 'Update AI availability before starting a review.');
}

function canonicalTuple(value) {
  return JSON.stringify({
    connection_id: value.connection_id,
    connection_type: value.connection_type,
    adapter_id: value.adapter_id,
    adapter_version: value.adapter_version,
    provider_id: value.provider_id,
    transport: value.transport,
    execution_strategy: value.execution_strategy,
    model_id: value.model_id,
    provider_effort: value.provider_effort,
    provider_effort_request_field: value.provider_effort_request_field,
    provider_capability_hash: value.provider_capability_hash,
    executable_identity_hash: value.executable_identity_hash,
    semantic_capability_hash: value.semantic_capability_hash,
    capability_revision: value.capability_revision
  });
}

function uniqueConnections(connections) {
  const seen = new Set();
  return connections.filter((item) => {
    const key = `${item.adapter_id}\u0000${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function refreshBoundary(observed = {}) {
  return {
    ...controlCenterAiConnectionStoreBoundary(),
    explicit_user_action: true,
    process_spawned: observed.process_spawned === true,
    network_used: observed.network_used === true,
    credential_values_read: observed.credential_values_read === true,
    credential_values_recorded: false,
    raw_probe_output_stored: false,
    provider_execution_performed: false,
    external_evidence_transfer: false
  };
}

function selectionBoundary(observed = {}) {
  return {
    ...controlCenterAiConnectionStoreBoundary(),
    settings_write: true,
    credential_values_read: observed?.credential_values_read === true,
    credential_values_recorded: false,
    provider_execution_performed: false,
    external_evidence_transfer: false
  };
}

function actionOk(data) {
  return { status: 'ok', data, warnings: [], errors: [], artifacts: [] };
}

function actionError(code, message, details = {}) {
  return { status: 'error', data: null, warnings: [], errors: [{ code, message, details }], artifacts: [] };
}

function actionValidationError(code, message, details = {}) {
  return { ok: false, error: { code, message, details } };
}

function normalizeRevision(value) {
  const revision = Number(value ?? 0);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}

function hasConfiguredValue(env, key) {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(env, key) && String(env[key] ?? '').trim().length > 0;
}

function cleanString(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text || null;
}

function humanize(value) {
  const text = String(value);
  return text.slice(0, 1).toUpperCase() + text.slice(1).replaceAll('_', ' ');
}

function materializeNow(value) {
  const candidate = typeof value === 'function' ? value() : value;
  const date = candidate instanceof Date ? candidate : candidate ? new Date(candidate) : new Date();
  if (Number.isNaN(date.getTime())) throw new Error('Current time is invalid.');
  return date;
}
