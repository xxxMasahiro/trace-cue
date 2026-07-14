import { createHash } from 'node:crypto';

export const CONTROL_CENTER_AI_CONNECTION_SCHEMA_VERSION = '1.0.0';
export const CONTROL_CENTER_AI_CAPABILITY_TTL_MS = 24 * 60 * 60 * 1000;
export const CONTROL_CENTER_AI_CONNECTION_TYPES = Object.freeze(['subscription', 'api', 'local']);

const SAFE_ID = /^[a-zA-Z0-9._:/@+-]{1,160}$/u;
const MAX_CONNECTIONS = 16;
const MAX_MODELS = 128;
const MAX_EFFORTS = 24;

export function createControlCenterAiConnectionRecord({
  connections,
  previousRevision = 0,
  previousSettingsRevision = previousRevision,
  observedAt = new Date(),
  ttlMs = CONTROL_CENTER_AI_CAPABILITY_TTL_MS,
  selection = null
} = {}) {
  const observed = materializeDate(observedAt);
  const normalizedConnections = normalizeConnections(connections);
  const revision = normalizeRevision(previousRevision) + 1;
  const settingsRevision = normalizeRevision(previousSettingsRevision) + 1;
  const expiresAt = new Date(observed.getTime() + normalizeTtl(ttlMs));
  const semanticCapabilityHash = hashJson({
    schema_version: CONTROL_CENTER_AI_CONNECTION_SCHEMA_VERSION,
    connections: normalizedConnections.map(semanticConnection)
  });
  const normalizedSelection = normalizeStoredSelection(selection, normalizedConnections, semanticCapabilityHash, {
    selectDefaultWhenMissing: normalizeRevision(previousRevision) === 0
  });
  const base = {
    schema_version: CONTROL_CENTER_AI_CONNECTION_SCHEMA_VERSION,
    type: 'control_center_ai_connections',
    revision,
    settings_revision: settingsRevision,
    observed_at: observed.toISOString(),
    expires_at: expiresAt.toISOString(),
    semantic_capability_hash: semanticCapabilityHash,
    connections: normalizedConnections,
    selection: normalizedSelection
  };
  return {
    ...base,
    record_integrity_hash: hashJson(base)
  };
}

export function validateControlCenterAiConnectionRecord(value, { now = new Date() } = {}) {
  if (!isRecord(value)
    || value.schema_version !== CONTROL_CENTER_AI_CONNECTION_SCHEMA_VERSION
    || value.type !== 'control_center_ai_connections') {
    return invalid('CONTROL_CENTER_AI_CONNECTION_RECORD_INVALID', 'Saved AI connection information is invalid.');
  }
  let normalized;
  try {
    normalized = createControlCenterAiConnectionRecord({
      connections: value.connections,
      previousRevision: normalizeRevision(value.revision) - 1,
      previousSettingsRevision: normalizeRevision(value.settings_revision) - 1,
      observedAt: value.observed_at,
      ttlMs: Date.parse(value.expires_at) - Date.parse(value.observed_at),
      selection: value.selection
    });
  } catch {
    return invalid('CONTROL_CENTER_AI_CONNECTION_RECORD_INVALID', 'Saved AI connection information is invalid.');
  }
  if (normalized.semantic_capability_hash !== value.semantic_capability_hash
    || normalized.record_integrity_hash !== value.record_integrity_hash) {
    return invalid('CONTROL_CENTER_AI_CONNECTION_RECORD_CHANGED', 'Saved AI connection information changed unexpectedly.');
  }
  const current = materializeDate(now);
  return {
    ok: true,
    record: normalized,
    fresh: Date.parse(normalized.expires_at) > current.getTime(),
    freshness: Date.parse(normalized.expires_at) > current.getTime() ? 'fresh' : 'stale'
  };
}

export function projectControlCenterAiConnections(value, options = {}) {
  const validation = validateControlCenterAiConnectionRecord(value, options);
  if (!validation.ok) {
    return emptyProjection('error', validation.error.message, {
      error_code: validation.error.code
    });
  }
  const { record, fresh } = validation;
  const connections = record.connections
    .filter((connection) => connection.status !== 'hidden')
    .map((connection) => ({
      option_id: connection.option_id,
      name: connection.display_name,
      kind: connection.connection_type,
      status: fresh ? connection.status : 'stale',
      status_message: fresh ? connection.status_message : 'Update availability before using this AI service.',
      models: connection.models.map((model) => ({
        option_id: model.option_id,
        name: model.display_name,
        efforts: model.native_efforts.map((effort) => ({
          option_id: effort.option_id,
          name: effort.display_name,
          recommended: effort.id === model.default_native_effort_id
        })),
        default_effort_option_id: model.native_efforts.find((item) => item.id === model.default_native_effort_id)?.option_id ?? null
      })),
      default_model_option_id: connection.models.find((item) => item.id === connection.default_model_id)?.option_id ?? null
    }));
  const selection = projectSelection(record, connections);
  const usableCount = connections.filter((item) => item.status === 'available').length;
  return {
    schema_version: CONTROL_CENTER_AI_CONNECTION_SCHEMA_VERSION,
    status: fresh ? (usableCount > 0 ? 'available' : 'setup_required') : 'stale',
    status_message: fresh
      ? (usableCount > 0 ? 'AI suggestions are ready.' : 'Set up an AI service or continue without AI.')
      : 'Update availability before using AI suggestions.',
    revision: record.revision,
    settings_revision: record.settings_revision,
    capability_token: capabilityToken(record),
    observed_at: record.observed_at,
    expires_at: record.expires_at,
    fresh,
    connections,
    selection,
    can_continue_without_ai: true,
    technical_details_included: false
  };
}

export function resolveControlCenterAiSelection(recordValue, selection = {}, options = {}) {
  const validation = validateControlCenterAiConnectionRecord(recordValue, options);
  if (!validation.ok) return validation;
  if (!validation.fresh) {
    return invalid('CONTROL_CENTER_AI_CONNECTION_STALE', 'Update AI availability before starting a review.');
  }
  const record = validation.record;
  const requestedRevision = Number(selection.capability_revision ?? selection.revision);
  const requestedToken = cleanString(selection.capability_token);
  const connectionOptionId = cleanString(selection.connection_option_id);
  const modelOptionId = cleanString(selection.model_option_id);
  const effortOptionId = cleanString(selection.effort_option_id);
  if (!Number.isSafeInteger(requestedRevision)
    || requestedRevision < 1
    || !requestedToken
    || !connectionOptionId
    || !modelOptionId
    || !effortOptionId) {
    return invalid('CONTROL_CENTER_AI_SELECTION_INCOMPLETE', 'Choose the current AI service, model, and processing level again.');
  }
  if (requestedRevision !== record.revision || requestedToken !== capabilityToken(record)) {
    return invalid('CONTROL_CENTER_AI_CONNECTION_REVISION_CHANGED', 'AI availability changed. Review the current choices again.');
  }
  const connection = record.connections.find((item) => item.option_id === connectionOptionId);
  if (!connection || connection.status !== 'available') {
    return invalid('CONTROL_CENTER_AI_CONNECTION_UNAVAILABLE', 'Choose an available AI service.');
  }
  const model = connection.models.find((item) => item.option_id === modelOptionId);
  if (!model) return invalid('CONTROL_CENTER_AI_MODEL_UNAVAILABLE', 'Choose an available AI model.');
  const effort = model.native_efforts.find((item) => item.option_id === effortOptionId);
  if (!effort) return invalid('CONTROL_CENTER_AI_EFFORT_UNAVAILABLE', 'Choose an available AI processing level.');
  return {
    ok: true,
    selection: {
      connection_option_id: connection.option_id,
      model_option_id: model.option_id,
      effort_option_id: effort.option_id,
      capability_revision: record.revision,
      capability_token: capabilityToken(record)
    },
    binding: {
      schema_version: CONTROL_CENTER_AI_CONNECTION_SCHEMA_VERSION,
      connection_id: connection.id,
      connection_type: connection.connection_type,
      connection_display_name: connection.display_name,
      adapter_id: connection.adapter_id,
      adapter_version: connection.adapter_version,
      provider_id: connection.provider_id,
      transport: connection.transport,
      execution_strategy: connection.execution_strategy,
      model_id: model.id,
      model_display_name: model.display_name,
      provider_effort: connection.provider_effort_request_field ? effort.id : null,
      provider_effort_display_name: effort.display_name,
      provider_effort_request_field: connection.provider_effort_request_field,
      provider_capability_hash: connection.provider_capability_hash,
      executable_identity_hash: connection.executable_identity_hash,
      semantic_capability_hash: record.semantic_capability_hash,
      capability_revision: record.revision,
      observed_at: record.observed_at,
      expires_at: record.expires_at
    }
  };
}

export function applyControlCenterAiSelection(recordValue, selection, options = {}) {
  const resolved = resolveControlCenterAiSelection(recordValue, selection, options);
  if (!resolved.ok) return resolved;
  const record = validateControlCenterAiConnectionRecord(recordValue, options).record;
  const base = {
    ...record,
    settings_revision: record.settings_revision + 1,
    selection: {
      connection_option_id: resolved.selection.connection_option_id,
      model_option_id: resolved.selection.model_option_id,
      effort_option_id: resolved.selection.effort_option_id,
      semantic_capability_hash: record.semantic_capability_hash
    }
  };
  delete base.record_integrity_hash;
  return {
    ok: true,
    record: {
      ...base,
      record_integrity_hash: hashJson(base)
    },
    selection: resolved.selection,
    binding: resolved.binding
  };
}

export function emptyControlCenterAiConnectionsProjection() {
  return emptyProjection('not_checked', 'Update availability to find AI services on this computer.');
}

function normalizeConnections(value) {
  if (!Array.isArray(value) || value.length > MAX_CONNECTIONS) {
    throw new Error('AI connection list is invalid.');
  }
  const seen = new Set();
  return value.map((item) => normalizeConnection(item, seen))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeConnection(value, seen) {
  if (!isRecord(value)) throw new Error('AI connection is invalid.');
  const id = safeId(value.id, 'connection id');
  const adapterId = safeId(value.adapter_id, 'adapter id');
  const adapterVersion = safeId(value.adapter_version, 'adapter version');
  const providerId = safeId(value.provider_id, 'provider id');
  const connectionType = CONTROL_CENTER_AI_CONNECTION_TYPES.includes(value.connection_type)
    ? value.connection_type
    : null;
  if (!connectionType) throw new Error('AI connection type is invalid.');
  const optionId = opaqueId('connection', adapterId, id);
  if (seen.has(optionId)) throw new Error('AI connection is duplicated.');
  seen.add(optionId);
  const models = normalizeModels(value.models, optionId);
  const defaultModelId = cleanString(value.default_model_id);
  if (!models.some((item) => item.id === defaultModelId)) throw new Error('Default AI model is invalid.');
  return {
    id,
    option_id: optionId,
    display_name: boundedLabel(value.display_name, 'AI service'),
    connection_type: connectionType,
    status: ['available', 'setup_required', 'unavailable', 'hidden'].includes(value.status) ? value.status : 'unavailable',
    status_message: boundedLabel(value.status_message, 'This AI service is unavailable.'),
    adapter_id: adapterId,
    adapter_version: adapterVersion,
    provider_id: providerId,
    transport: safeId(value.transport, 'transport'),
    execution_strategy: safeId(value.execution_strategy ?? 'one-shot', 'execution strategy'),
    provider_effort_request_field: cleanString(value.provider_effort_request_field),
    provider_capability_hash: safeHash(value.provider_capability_hash),
    executable_identity_hash: value.executable_identity_hash ? safeHash(value.executable_identity_hash) : null,
    default_model_id: defaultModelId,
    models
  };
}

function normalizeModels(value, connectionOptionId) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_MODELS) {
    throw new Error('AI model list is invalid.');
  }
  const seen = new Set();
  return value.map((item) => {
    if (!isRecord(item)) throw new Error('AI model is invalid.');
    const id = safeId(item.id, 'model id');
    const optionId = opaqueId('model', connectionOptionId, id);
    if (seen.has(optionId)) throw new Error('AI model is duplicated.');
    seen.add(optionId);
    const efforts = normalizeEfforts(item.native_efforts, optionId);
    const defaultEffortId = cleanString(item.default_native_effort_id);
    if (!efforts.some((effort) => effort.id === defaultEffortId)) throw new Error('Default AI processing level is invalid.');
    return {
      id,
      option_id: optionId,
      display_name: boundedLabel(item.display_name, id),
      default_native_effort_id: defaultEffortId,
      native_efforts: efforts
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeEfforts(value, modelOptionId) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_EFFORTS) {
    throw new Error('AI processing level list is invalid.');
  }
  const seen = new Set();
  return value.map((item) => {
    if (!isRecord(item)) throw new Error('AI processing level is invalid.');
    const id = safeId(item.id, 'processing level id');
    const optionId = opaqueId('effort', modelOptionId, id);
    if (seen.has(optionId)) throw new Error('AI processing level is duplicated.');
    seen.add(optionId);
    return { id, option_id: optionId, display_name: boundedLabel(item.display_name, id) };
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeStoredSelection(value, connections, semanticCapabilityHash, { selectDefaultWhenMissing = false } = {}) {
  if (!isRecord(value)) {
    return selectDefaultWhenMissing ? defaultSelection(connections, semanticCapabilityHash) : null;
  }
  const connection = connections.find((item) => item.option_id === value.connection_option_id && item.status === 'available');
  if (!connection) return null;
  const model = connection.models.find((item) => item.option_id === value.model_option_id);
  const effort = model?.native_efforts.find((item) => item.option_id === value.effort_option_id);
  return model && effort ? {
    connection_option_id: connection.option_id,
    model_option_id: model.option_id,
    effort_option_id: effort.option_id,
    semantic_capability_hash: semanticCapabilityHash
  } : null;
}

function defaultSelection(connections, semanticCapabilityHash) {
  const connection = connections.find((item) => item.status === 'available');
  const model = connection?.models.find((item) => item.id === connection.default_model_id) ?? connection?.models[0];
  const effort = model?.native_efforts.find((item) => item.id === model.default_native_effort_id) ?? model?.native_efforts[0];
  return connection && model && effort ? {
    connection_option_id: connection.option_id,
    model_option_id: model.option_id,
    effort_option_id: effort.option_id,
    semantic_capability_hash: semanticCapabilityHash
  } : null;
}

function projectSelection(record, publicConnections) {
  const selected = record.selection;
  const connection = publicConnections.find((item) => item.option_id === selected?.connection_option_id);
  const model = connection?.models.find((item) => item.option_id === selected?.model_option_id);
  const effort = model?.efforts.find((item) => item.option_id === selected?.effort_option_id);
  return connection && model && effort ? {
    connection_option_id: connection.option_id,
    connection_name: connection.name,
    model_option_id: model.option_id,
    model_name: model.name,
    effort_option_id: effort.option_id,
    effort_name: effort.name,
    effort_is_recommended: effort.recommended,
    capability_revision: record.revision,
    capability_token: capabilityToken(record)
  } : null;
}

function semanticConnection(connection) {
  return {
    id: connection.id,
    adapter_id: connection.adapter_id,
    adapter_version: connection.adapter_version,
    provider_id: connection.provider_id,
    connection_type: connection.connection_type,
    transport: connection.transport,
    execution_strategy: connection.execution_strategy,
    provider_effort_request_field: connection.provider_effort_request_field,
    provider_capability_hash: connection.provider_capability_hash,
    executable_identity_hash: connection.executable_identity_hash,
    default_model_id: connection.default_model_id,
    models: connection.models.map((model) => ({
      id: model.id,
      default_native_effort_id: model.default_native_effort_id,
      native_efforts: model.native_efforts.map((effort) => effort.id)
    }))
  };
}

function emptyProjection(status, message, extra = {}) {
  return {
    schema_version: CONTROL_CENTER_AI_CONNECTION_SCHEMA_VERSION,
    status,
    status_message: message,
    revision: 0,
    settings_revision: 0,
    capability_token: null,
    observed_at: null,
    expires_at: null,
    fresh: false,
    connections: [],
    selection: null,
    can_continue_without_ai: true,
    technical_details_included: false,
    ...extra
  };
}

function opaqueId(kind, ...parts) {
  return `${kind}_${createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 20)}`;
}

function capabilityToken(record) {
  return opaqueId('capability', String(record.revision), record.semantic_capability_hash);
}

function hashJson(value) {
  return createHash('sha256').update(canonicalStringify(value)).digest('hex');
}

function canonicalStringify(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function safeId(value, label) {
  const normalized = cleanString(value);
  if (!normalized || !SAFE_ID.test(normalized)) throw new Error(`${label} is invalid.`);
  return normalized;
}

function safeHash(value) {
  const normalized = cleanString(value);
  if (!normalized || !/^[a-f0-9]{64}$/u.test(normalized)) throw new Error('Capability hash is invalid.');
  return normalized;
}

function boundedLabel(value, fallback) {
  const normalized = cleanString(value) ?? fallback;
  if (normalized.length > 160 || /[\u0000-\u001f\u007f]/u.test(normalized)) throw new Error('Display label is invalid.');
  return normalized;
}

function cleanString(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function normalizeRevision(value) {
  const revision = Number(value ?? 0);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

function normalizeTtl(value) {
  const ttl = Number(value);
  return Number.isSafeInteger(ttl) && ttl >= 60_000 && ttl <= 7 * 24 * 60 * 60 * 1000
    ? ttl
    : CONTROL_CENTER_AI_CAPABILITY_TTL_MS;
}

function materializeDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Timestamp is invalid.');
  return date;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalid(code, message) {
  return { ok: false, error: { code, message, details: {} } };
}
