import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const CATALOG_URL = new URL('../ops/CONTROL_CENTER_AI_SETUP_CATALOG.json', import.meta.url);
const SAFE_ID = /^[a-z0-9][a-z0-9-]{1,79}$/u;
const SAFE_EFFORT = /^[a-z][a-z0-9_-]{0,39}$/u;
const SAFE_MODEL_ID = /^[a-zA-Z0-9._:-]{1,160}$/u;
const SAFE_REVISION = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/u;
const AUDITED_ADAPTERS = Object.freeze({
  'codex-device-login': Object.freeze({ connectionType: 'subscription', retention: 'service_owned' }),
  'openai-responses': Object.freeze({
    connectionType: 'api',
    retention: 'control_center_session',
    modelsEndpoint: 'https://api.openai.com/v1/models',
    responsesEndpoint: 'https://api.openai.com/v1/responses'
  })
});
let installedCatalogPromise = null;

export async function readControlCenterAiSetupCatalog(context = {}) {
  const source = context.controlCenterAiSetupCatalog;
  if (source) return normalizeCatalog(source);
  installedCatalogPromise ??= readFile(CATALOG_URL, 'utf8').then((text) => normalizeCatalog(JSON.parse(text)));
  return installedCatalogPromise;
}

export function projectControlCenterAiSetupServices(catalog) {
  return catalog.services.map((service) => Object.freeze({
    option_id: serviceOptionId(catalog.catalog_revision, service.id),
    name: service.display_name,
    kind: service.connection_type,
    recommended: service.recommended
  }));
}

export function resolveControlCenterAiSetupService(catalog, optionId, expectedType = null) {
  const service = catalog.services.find((candidate) => (
    serviceOptionId(catalog.catalog_revision, candidate.id) === optionId
    && (!expectedType || candidate.connection_type === expectedType)
  ));
  return service ?? null;
}

function normalizeCatalog(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schema_version !== '1.0.0'
    || value.type !== 'control_center_ai_setup_catalog'
    || typeof value.catalog_revision !== 'string'
    || !SAFE_REVISION.test(value.catalog_revision)
    || !Array.isArray(value.services)
    || value.services.length < 1
    || value.services.length > 8) {
    throw new Error('Control Center AI setup catalog is invalid.');
  }
  const seen = new Set();
  const services = value.services.map((service) => {
    if (!service || typeof service !== 'object' || Array.isArray(service) || !SAFE_ID.test(service.id)) {
      throw new Error('Control Center AI setup service is invalid.');
    }
    if (seen.has(service.id)) throw new Error('Control Center AI setup service is duplicated.');
    seen.add(service.id);
    const connectionType = ['subscription', 'api'].includes(service.connection_type) ? service.connection_type : null;
    const displayName = boundedLabel(service.display_name);
    const adapterContract = AUDITED_ADAPTERS[service.adapter];
    if (!connectionType || !displayName || !adapterContract
      || adapterContract.connectionType !== connectionType
      || service.retention !== adapterContract.retention) {
      throw new Error('Control Center AI setup service contract is invalid.');
    }
    const normalized = {
      id: service.id,
      display_name: displayName,
      connection_type: connectionType,
      adapter: service.adapter,
      retention: service.retention,
      recommended: service.recommended === true
    };
    if (connectionType === 'api') {
      const modelsEndpoint = exactHttpsUrl(service.models_endpoint);
      const responsesEndpoint = exactHttpsUrl(service.responses_endpoint);
      const models = normalizeModels(service.models);
      const defaultModelId = typeof service.default_model_id === 'string' ? service.default_model_id : '';
      if (modelsEndpoint !== adapterContract.modelsEndpoint
        || responsesEndpoint !== adapterContract.responsesEndpoint
        || !models.some((model) => model.id === defaultModelId)) {
        throw new Error('Control Center API service contract is invalid.');
      }
      Object.assign(normalized, {
        models_endpoint: modelsEndpoint,
        responses_endpoint: responsesEndpoint,
        models,
        default_model_id: defaultModelId
      });
    }
    return Object.freeze(normalized);
  });
  return Object.freeze({
    schema_version: '1.0.0',
    type: 'control_center_ai_setup_catalog',
    catalog_revision: value.catalog_revision,
    services: Object.freeze(services)
  });
}

function normalizeModels(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) {
    throw new Error('Control Center API model catalog is invalid.');
  }
  const seen = new Set();
  return Object.freeze(value.map((model) => {
    if (!model || typeof model !== 'object' || Array.isArray(model)
      || typeof model.id !== 'string' || !SAFE_MODEL_ID.test(model.id)
      || seen.has(model.id)) {
      throw new Error('Control Center API model is invalid.');
    }
    seen.add(model.id);
    const displayName = boundedLabel(model.display_name);
    const efforts = Array.isArray(model.native_efforts) ? model.native_efforts : [];
    const effortSet = new Set(efforts);
    const defaultEffort = typeof model.default_native_effort === 'string' ? model.default_native_effort : '';
    if (!displayName
      || efforts.length < 1
      || efforts.length > 24
      || effortSet.size !== efforts.length
      || efforts.some((item) => typeof item !== 'string' || !SAFE_EFFORT.test(item))
      || !efforts.includes(defaultEffort)) {
      throw new Error('Control Center API model contract is invalid.');
    }
    return Object.freeze({
      id: model.id,
      display_name: displayName,
      native_efforts: Object.freeze(efforts),
      default_native_effort: defaultEffort
    });
  }));
}

function serviceOptionId(revision, id) {
  return `service_${createHash('sha256').update(`${revision}\u0000${id}`).digest('hex').slice(0, 20)}`;
}

function exactHttpsUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function boundedLabel(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= 80 && !/[\u0000-\u001f\u007f]/u.test(text) ? text : null;
}
