import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  AGENTIC_HUMAN_REVIEW_RESPONSES_ADAPTER_DEFAULTS,
  startAgenticHumanReviewResponsesAdapter
} from './agentic-human-review-responses-adapter.js';
import {
  AGENTIC_REVIEW_API_CREDENTIAL_ENV,
  AGENTIC_REVIEW_API_ENDPOINT_ENV,
  AGENTIC_REVIEW_RESPONSES_ADAPTER_MODEL_ENV,
  agenticProviderCapabilityHash,
  resolveAgenticHumanReviewProvider
} from './agentic-human-review-providers.js';
import {
  CONTROL_CENTER_AGENTIC_REVIEW_PROVIDER_ENV,
  CONTROL_CENTER_AGENTIC_REVIEW_SERVICE_NAME_ENV
} from './control-center-agentic-review-config.js';
import {
  projectControlCenterAiSetupServices,
  readControlCenterAiSetupCatalog,
  resolveControlCenterAiSetupService
} from './control-center-ai-setup-catalog.js';
import { nodeHttpFetch } from './http-transport.js';
import { createControlCenterCodexLoginManager } from './control-center-codex-login.js';

export const CONTROL_CENTER_AI_SETUP_SCHEMA_VERSION = '1.0.0';
export const CONTROL_CENTER_AI_SECRET_SUBMISSION_HEADER = 'x-trace-cue-secret-submission';
export const CONTROL_CENTER_AI_SECRET_TRANSPORT_LIMITS = Object.freeze({
  minBytes: 8,
  maxBytes: 4096,
  readTimeoutMs: 5_000
});
export const CONTROL_CENTER_AI_CREDENTIAL_LIMITS = Object.freeze({
  maxGenerations: 4,
  maxTotalBytes: 16 * 1024,
  idleTtlMs: 30 * 60_000,
  absoluteTtlMs: 8 * 60 * 60_000
});

const SUBMISSION_TTL_MS = 2 * 60_000;
const MAX_SUBMISSIONS = 4;
const MAX_MODEL_RESPONSE_BYTES = 256 * 1024;
const MODEL_REQUEST_TIMEOUT_MS = 15_000;

export async function createControlCenterAiSetupRuntime({ instanceId } = {}, context = {}) {
  if (typeof instanceId !== 'string' || instanceId.length < 16) {
    throw new Error('Control Center AI setup runtime instance is invalid.');
  }
  const catalog = await readControlCenterAiSetupCatalog(context);
  const codexLogin = context.controlCenterCodexLoginManager
    ?? createControlCenterCodexLoginManager(context);
  const clock = () => materializeNow(context.now).getTime();
  const credentialLimits = resolveCredentialLimits(context);
  const submissions = [];
  const generations = new Map();
  const preparations = new Set();
  const pendingDisposals = new Set();
  let generationCounter = 0;
  let credentialBytes = 0;
  let reservedGenerationCount = 0;
  let reservedCredentialBytes = 0;
  let profileRevision = 0;
  let currentGeneration = null;
  let activeMutation = false;
  let disposed = false;
  let runtimeDisposalPromise = null;

  function projection({ canConnect = true } = {}) {
    pruneExpiredGenerations();
    const current = currentGeneration?.enabled === true ? currentGeneration : null;
    return {
      schema_version: CONTROL_CENTER_AI_SETUP_SCHEMA_VERSION,
      status: current ? 'connected' : canConnect ? 'not_connected' : 'read_only',
      retention: current ? 'control_center_session' : 'none',
      services: projectControlCenterAiSetupServices(catalog),
      connection: current ? {
        name: current.service.display_name,
        kind: 'api',
        retention: 'control_center_session',
        session_managed: true,
        can_replace: true,
        can_disconnect: true
      } : null,
      subscription_login: codexLogin.status(),
      can_connect: canConnect,
      technical_details_included: false
    };
  }

  async function startSubscription({ service_option_id: optionId, expected_revision: expectedRevision } = {}) {
    if (disposed) return failure('CONTROL_CENTER_AI_SETUP_UNAVAILABLE', 'AI setup is unavailable.');
    const service = resolveControlCenterAiSetupService(catalog, optionId, 'subscription');
    if (!service) return failure('CONTROL_CENTER_AI_SETUP_SERVICE_REJECTED', 'Choose an available AI service.');
    const revision = normalizeRevision(expectedRevision);
    if (revision === null) return failure('CONTROL_CENTER_CODEX_LOGIN_REVISION_INVALID', 'Refresh the screen and try again.');
    return codexLogin.start({ expectedRevision: revision });
  }

  function subscriptionStatus() {
    return codexLogin.status();
  }

  async function cancelSubscription() {
    if (disposed) return failure('CONTROL_CENTER_AI_SETUP_UNAVAILABLE', 'AI setup is unavailable.');
    return codexLogin.cancel();
  }

  function subscriptionCompletionReady() {
    return codexLogin.status().status === 'connected';
  }

  function markSubscriptionFinalized() {
    return codexLogin.markFinalized();
  }

  function createApiSubmission({ service_option_id: optionId, expected_revision: expectedRevision } = {}) {
    if (disposed) return failure('CONTROL_CENTER_AI_SETUP_UNAVAILABLE', 'AI setup is unavailable.');
    const service = resolveControlCenterAiSetupService(catalog, optionId, 'api');
    if (!service) return failure('CONTROL_CENTER_AI_SETUP_SERVICE_REJECTED', 'Choose an available AI service.');
    const revision = normalizeRevision(expectedRevision);
    if (revision === null) return failure('CONTROL_CENTER_AI_SETUP_REVISION_INVALID', 'Refresh the screen and try again.');
    const current = clock();
    pruneSubmissions(current);
    if (submissions.length >= MAX_SUBMISSIONS) {
      return failure('CONTROL_CENTER_AI_SETUP_BUSY', 'Finish or cancel the current AI setup first.');
    }
    const token = randomToken();
    submissions.push({
      digest: digest(token),
      service,
      expectedRevision: revision,
      issuedAt: current,
      expiresAt: current + SUBMISSION_TTL_MS
    });
    return {
      ok: true,
      submission_id: token,
      expires_at: new Date(current + SUBMISSION_TTL_MS).toISOString(),
      retention: 'control_center_session'
    };
  }

  async function prepareApiConnection(submissionId, keyBuffer) {
    if (disposed) return failure('CONTROL_CENTER_AI_SETUP_UNAVAILABLE', 'AI setup is unavailable.');
    pruneExpiredGenerations();
    const submission = consumeSubmission(submissionId);
    if (!submission) return failure('CONTROL_CENTER_AI_SUBMISSION_REJECTED', 'This AI setup request is no longer valid. Start again.');
    const keyValidation = validateKeyBuffer(keyBuffer);
    if (!keyValidation.ok) return keyValidation;
    if (generations.size + reservedGenerationCount >= credentialLimits.maxGenerations
      || credentialBytes + reservedCredentialBytes + keyBuffer.length > credentialLimits.maxTotalBytes) {
      return failure('CONTROL_CENTER_AI_SETUP_BUSY', 'Wait for the current AI check to finish, then try again.');
    }
    reservedGenerationCount += 1;
    reservedCredentialBytes += keyBuffer.length;

    const credential = Buffer.from(keyBuffer);
    const preparationController = new AbortController();
    let finishPreparation;
    const preparation = {
      controller: preparationController,
      finished: new Promise((resolve) => { finishPreparation = resolve; })
    };
    preparations.add(preparation);
    let generation = null;
    let prepared = false;
    try {
      const modelResult = await discoverApiModels(
        submission.service,
        credential,
        context,
        preparationController.signal
      );
      if (disposed || preparationController.signal.aborted) {
        credential.fill(0);
        return failure('CONTROL_CENTER_AI_SETUP_UNAVAILABLE', 'AI setup is unavailable.');
      }
      if (!modelResult.ok) {
        credential.fill(0);
        return modelResult;
      }
      generationCounter += 1;
      const generationId = String(generationCounter);
      const adapterToken = randomToken();
      const adapterEnv = Object.freeze({
        [AGENTIC_HUMAN_REVIEW_RESPONSES_ADAPTER_DEFAULTS.adapterTokenEnv]: adapterToken,
        [AGENTIC_HUMAN_REVIEW_RESPONSES_ADAPTER_DEFAULTS.providerApiKeyEnv]: 'managed-by-control-center'
      });
      generation = {
        id: generationId,
        service: submission.service,
        credential,
        models: modelResult.models,
        defaultModelId: modelResult.defaultModelId,
        adapterToken,
        abortController: preparationController,
        adapter: null,
        enabled: false,
        retired: false,
        refCount: 0,
        credentialBytes: credential.length,
        credentialAccounted: false,
        createdAt: clock(),
        idleExpiresAt: 0,
        absoluteExpiresAt: 0,
        expiryTimer: null,
        disposalPromise: null,
        profileRevision: profileRevision + 1,
        runtimeInstanceId: instanceId,
        configurationIdentityHash: null
      };
      generation.absoluteExpiresAt = generation.createdAt + credentialLimits.absoluteTtlMs;
      generation.idleExpiresAt = Math.min(
        generation.createdAt + credentialLimits.idleTtlMs,
        generation.absoluteExpiresAt
      );
      const startAdapter = context.startControlCenterResponsesAdapter ?? startAgenticHumanReviewResponsesAdapter;
      const adapter = await startAdapter({
        host: '127.0.0.1',
        port: 0,
        providerEndpoint: submission.service.responses_endpoint
      }, {
        env: adapterEnv,
        now: context.now,
        fetch: managedProviderFetch(generation, context, {
          clock,
          hardExpire: () => hardExpireGeneration(generation)
        })
      });
      generation.adapter = adapter;
      if (disposed || preparationController.signal.aborted) {
        await disposeGeneration(generation);
        return failure('CONTROL_CENTER_AI_SETUP_UNAVAILABLE', 'AI setup is unavailable.');
      }
      generation.configurationIdentityHash = hashJson({
        catalog_revision: catalog.catalog_revision,
        service_id: submission.service.id,
        runtime_instance_id: instanceId,
        credential_generation: generationId,
        adapter_url: adapter.url,
        models: modelResult.models.map((model) => model.id)
      });
      generation.connection = buildConnection(generation, context);
      credentialBytes += generation.credentialBytes;
      generation.credentialAccounted = true;
      generations.set(generationId, generation);
      scheduleGenerationExpiry(generation);
      prepared = true;
      return {
        ok: true,
        pending: generation,
        expectedRevision: submission.expectedRevision,
        connection: generation.connection,
        models: modelResult.models.map((model) => ({ name: model.display_name }))
      };
    } catch {
      if (generation) await disposeGeneration(generation);
      else credential.fill(0);
      return disposed || preparationController.signal.aborted
        ? failure('CONTROL_CENTER_AI_SETUP_UNAVAILABLE', 'AI setup is unavailable.')
        : failure('CONTROL_CENTER_AI_CONNECTION_FAILED', 'The AI service could not be connected. Check the key and try again.');
    } finally {
      if (!prepared) preparationController.abort();
      reservedGenerationCount = Math.max(0, reservedGenerationCount - 1);
      reservedCredentialBytes = Math.max(0, reservedCredentialBytes - keyBuffer.length);
      preparations.delete(preparation);
      finishPreparation();
    }
  }

  function beginPromotion(pending) {
    pruneExpiredGenerations();
    if (activeMutation) {
      return failure('CONTROL_CENTER_AI_SETUP_BUSY', 'Finish the current AI setup first.');
    }
    if (disposed || !pending || generations.get(pending.id) !== pending || pending.enabled || pending.retired) {
      return failure('CONTROL_CENTER_AI_SETUP_CHANGED', 'AI setup changed. Start again.');
    }
    activeMutation = true;
    const previous = currentGeneration;
    let settled = false;
    return {
      ok: true,
      connectionSnapshot: Object.freeze([pending.connection]),
      async commit() {
        if (settled) return failure('CONTROL_CENTER_AI_SETUP_CHANGED', 'AI setup changed. Start again.');
        settled = true;
        activeMutation = false;
        if (disposed || pending.disposed || pending.retired || generations.get(pending.id) !== pending) {
          await disposeGeneration(pending);
          return failure('CONTROL_CENTER_AI_SETUP_CHANGED', 'AI setup changed. Start again.');
        }
        if (!touchGeneration(pending)) {
          await disposeGeneration(pending);
          return failure('CONTROL_CENTER_AI_SETUP_CHANGED', 'AI setup changed. Start again.');
        }
        pending.enabled = true;
        currentGeneration = pending;
        profileRevision = pending.profileRevision;
        if (previous && previous !== pending) retireGeneration(previous);
        return { ok: true };
      },
      async rollback() {
        if (settled) return;
        settled = true;
        activeMutation = false;
        await disposeGeneration(pending);
      }
    };
  }

  async function discardPending(pending) {
    if (!pending || pending.enabled || currentGeneration === pending) return;
    if (generations.get(pending.id) === pending) await disposeGeneration(pending);
  }

  function beginDisconnect() {
    pruneExpiredGenerations();
    if (activeMutation) return failure('CONTROL_CENTER_AI_SETUP_BUSY', 'Finish the current AI setup first.');
    const previous = currentGeneration;
    if (!previous || !previous.enabled) return failure('CONTROL_CENTER_AI_NOT_CONNECTED', 'No API service is connected.');
    activeMutation = true;
    let settled = false;
    return {
      ok: true,
      connectionSnapshot: Object.freeze([]),
      async commit() {
        if (settled) return;
        settled = true;
        activeMutation = false;
        previous.enabled = false;
        if (currentGeneration === previous) currentGeneration = null;
        profileRevision += 1;
        retireGeneration(previous);
      },
      async rollback() {
        if (settled) return;
        settled = true;
        activeMutation = false;
      }
    };
  }

  function connections() {
    pruneExpiredGenerations();
    return currentGeneration?.enabled === true ? [currentGeneration.connection] : [];
  }

  function validateBinding(binding) {
    pruneExpiredGenerations();
    const generation = currentGeneration;
    return Boolean(generation?.enabled
      && binding?.runtime_instance_id === instanceId
      && binding?.credential_generation === generation.id
      && binding?.profile_revision === generation.profileRevision
      && binding?.configuration_identity_hash === generation.configurationIdentityHash
      && generationSupportsBinding(generation, binding));
  }

  function isConnectionAvailable(connection) {
    if (!connection?.runtime_instance_id) return true;
    pruneExpiredGenerations();
    const generation = currentGeneration;
    return Boolean(generation?.enabled
      && connection.runtime_instance_id === instanceId
      && connection.credential_generation === generation.id
      && connection.profile_revision === generation.profileRevision
      && connection.configuration_identity_hash === generation.configurationIdentityHash);
  }

  function acquireExecutionContext(baseContext, binding) {
    pruneExpiredGenerations();
    const generation = generations.get(String(binding?.credential_generation ?? ''));
    if (!generation || !generation.enabled || currentGeneration !== generation || !validateBinding(binding)) {
      return failure('CONTROL_CENTER_AI_BINDING_CHANGED', 'AI availability changed. Review the send details again.');
    }
    if (!touchGeneration(generation)) {
      return failure('CONTROL_CENTER_AI_BINDING_CHANGED', 'AI availability changed. Review the send details again.');
    }
    generation.refCount += 1;
    let released = false;
    return {
      ok: true,
      context: contextForGeneration(baseContext, generation),
      async release() {
        if (released) return;
        released = true;
        generation.refCount = Math.max(0, generation.refCount - 1);
        if (generation.retired && generation.refCount === 0) await disposeGeneration(generation);
      }
    };
  }

  function dispose() {
    if (runtimeDisposalPromise) return runtimeDisposalPromise;
    disposed = true;
    runtimeDisposalPromise = (async () => {
      for (const submission of submissions) submission.digest.fill(0);
      submissions.length = 0;
      currentGeneration = null;
      const activePreparations = [...preparations];
      for (const preparation of activePreparations) preparation.controller.abort();
      await codexLogin.dispose();
      await Promise.all(activePreparations.map((preparation) => preparation.finished));
      await Promise.all([...generations.values()].map((generation) => disposeGeneration(generation)));
      await Promise.all([...pendingDisposals]);
    })();
    return runtimeDisposalPromise;
  }

  function consumeSubmission(token) {
    const current = clock();
    pruneSubmissions(current);
    const tokenDigest = safeDigest(token);
    if (!tokenDigest) return null;
    const index = submissions.findIndex((submission) => safeEqual(submission.digest, tokenDigest));
    tokenDigest.fill(0);
    if (index < 0) return null;
    const [submission] = submissions.splice(index, 1);
    submission.digest.fill(0);
    return submission.expiresAt > current ? submission : null;
  }

  function pruneSubmissions(current) {
    for (let index = submissions.length - 1; index >= 0; index -= 1) {
      if (submissions[index].expiresAt <= current) {
        submissions[index].digest.fill(0);
        submissions.splice(index, 1);
      }
    }
  }

  function pruneExpiredGenerations(current = clock()) {
    for (const generation of [...generations.values()]) {
      if (generation.absoluteExpiresAt <= current) hardExpireGeneration(generation);
      else if (!generation.retired && generation.idleExpiresAt <= current) expireGeneration(generation);
    }
  }

  function touchGeneration(generation) {
    const current = clock();
    if (generation.absoluteExpiresAt <= current) {
      hardExpireGeneration(generation);
      return false;
    }
    if (generation.idleExpiresAt <= current) {
      expireGeneration(generation);
      return false;
    }
    generation.idleExpiresAt = Math.min(current + credentialLimits.idleTtlMs, generation.absoluteExpiresAt);
    scheduleGenerationExpiry(generation);
    return true;
  }

  function scheduleGenerationExpiry(generation) {
    clearTimeout(generation.expiryTimer);
    if (generation.disposed) return;
    const expiresAt = generation.retired
      ? generation.absoluteExpiresAt
      : Math.min(generation.idleExpiresAt, generation.absoluteExpiresAt);
    const delayMs = Math.max(1, expiresAt - clock());
    generation.expiryTimer = setTimeout(() => {
      generation.expiryTimer = null;
      const current = clock();
      if (generation.absoluteExpiresAt <= current) hardExpireGeneration(generation);
      else if (!generation.retired && generation.idleExpiresAt <= current) expireGeneration(generation);
      else scheduleGenerationExpiry(generation);
    }, delayMs);
    generation.expiryTimer.unref?.();
  }

  function expireGeneration(generation) {
    if (!generation || generation.disposed || generation.retired) return;
    if (currentGeneration === generation) {
      currentGeneration = null;
      profileRevision += 1;
    }
    retireGeneration(generation);
  }

  function hardExpireGeneration(generation) {
    if (!generation || generation.disposed) return;
    if (currentGeneration === generation) {
      currentGeneration = null;
      profileRevision += 1;
    }
    generation.enabled = false;
    generation.retired = true;
    void disposeGeneration(generation);
  }

  function retireGeneration(generation) {
    if (!generation || generation.disposed) return;
    generation.enabled = false;
    generation.retired = true;
    clearTimeout(generation.expiryTimer);
    generation.expiryTimer = null;
    if (generation.refCount === 0) void disposeGeneration(generation);
    else scheduleGenerationExpiry(generation);
  }

  function disposeGeneration(generation) {
    if (!generation) return Promise.resolve();
    if (generation.disposalPromise) return generation.disposalPromise;
    generation.disposed = true;
    generations.delete(generation.id);
    clearTimeout(generation.expiryTimer);
    generation.expiryTimer = null;
    generation.abortController?.abort();
    if (generation.credential) {
      generation.credential.fill(0);
      if (generation.credentialAccounted) {
        credentialBytes = Math.max(0, credentialBytes - Number(generation.credentialBytes ?? 0));
        generation.credentialAccounted = false;
      }
      generation.credentialBytes = 0;
    }
    let disposalPromise;
    disposalPromise = Promise.resolve()
      .then(() => generation.adapter?.close?.())
      .catch(() => {})
      .finally(() => {
        generation.adapterToken = null;
        pendingDisposals.delete(disposalPromise);
      });
    generation.disposalPromise = disposalPromise;
    pendingDisposals.add(disposalPromise);
    return disposalPromise;
  }

  return Object.freeze({
    instanceId,
    projection,
    startSubscription,
    subscriptionStatus,
    cancelSubscription,
    subscriptionCompletionReady,
    markSubscriptionFinalized,
    createApiSubmission,
    prepareApiConnection,
    beginPromotion,
    discardPending,
    beginDisconnect,
    connections,
    validateBinding,
    isConnectionAvailable,
    acquireExecutionContext,
    dispose
  });
}

function buildConnection(generation, context) {
  const provider = resolveAgenticHumanReviewProvider({ providerId: 'generic-api-provider', context });
  if (!provider.ok) throw new Error('Configured API provider is unavailable.');
  const service = generation.service;
  return {
    id: `control-center-${service.id}`,
    display_name: service.display_name,
    connection_type: 'api',
    status: 'available',
    status_message: 'Ready to use for this Control Center session.',
    adapter_id: 'control-center-openai-responses',
    adapter_version: '1.0.0',
    provider_id: provider.provider.id,
    transport: provider.provider.transport,
    execution_strategy: 'one-shot',
    provider_effort_request_field: 'reasoning.effort',
    provider_capability_hash: agenticProviderCapabilityHash(provider.provider),
    executable_identity_hash: null,
    profile_revision: generation.profileRevision,
    configuration_identity_hash: generation.configurationIdentityHash,
    credential_generation: generation.id,
    runtime_instance_id: generation.runtimeInstanceId,
    models: generation.models,
    default_model_id: generation.defaultModelId
  };
}

function contextForGeneration(baseContext, generation) {
  const sourceEnv = baseContext.env ?? process.env;
  const {
    [AGENTIC_REVIEW_RESPONSES_ADAPTER_MODEL_ENV]: _configuredModel,
    ...modelNeutralEnv
  } = sourceEnv;
  const env = Object.freeze({
    ...modelNeutralEnv,
    [CONTROL_CENTER_AGENTIC_REVIEW_PROVIDER_ENV]: 'generic-api-provider',
    [CONTROL_CENTER_AGENTIC_REVIEW_SERVICE_NAME_ENV]: generation.service.display_name,
    [AGENTIC_REVIEW_API_ENDPOINT_ENV]: generation.adapter.url,
    [AGENTIC_REVIEW_API_CREDENTIAL_ENV]: generation.adapterToken
  });
  return { ...baseContext, env, controlCenterAiExecutionGeneration: generation.id };
}

function managedProviderFetch(generation, context, { clock, hardExpire }) {
  const upstreamFetch = context.controlCenterAiUpstreamFetch ?? nodeHttpFetch;
  return async (url, options = {}) => {
    if (!generation.disposed && clock() >= generation.absoluteExpiresAt) hardExpire();
    if (String(url) !== generation.service.responses_endpoint || generation.disposed) {
      throw new Error('Managed AI destination changed.');
    }
    const credential = generation.credential.toString('utf8');
    const headers = Object.fromEntries(new Headers(options.headers ?? {}).entries());
    headers.authorization = `Bearer ${credential}`;
    const signal = combineAbortSignals(options.signal, generation.abortController.signal);
    return upstreamFetch(url, { ...options, headers, signal, redirect: 'error' });
  };
}

async function discoverApiModels(service, credential, context, cancellationSignal) {
  const fetchImpl = context.controlCenterAiUpstreamFetch ?? nodeHttpFetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(service.models_endpoint, {
      method: 'GET',
      headers: { authorization: `Bearer ${credential.toString('utf8')}`, accept: 'application/json' },
      redirect: 'error',
      signal: combineAbortSignals(controller.signal, cancellationSignal),
      timeoutMs: MODEL_REQUEST_TIMEOUT_MS,
      maxResponseBytes: MAX_MODEL_RESPONSE_BYTES
    });
  } catch {
    return failure('CONTROL_CENTER_AI_CONNECTION_UNREACHABLE', 'The AI service could not be reached. Try again later.');
  } finally {
    clearTimeout(timer);
  }
  if (!response?.ok) {
    return failure(
      response?.status === 401 || response?.status === 403
        ? 'CONTROL_CENTER_AI_KEY_REJECTED'
        : 'CONTROL_CENTER_AI_CONNECTION_UNAVAILABLE',
      response?.status === 401 || response?.status === 403
        ? 'The API key was not accepted.'
        : 'The AI service could not confirm the connection. Try again later.'
    );
  }
  const contentType = String(response.headers?.get?.('content-type') ?? '').toLowerCase();
  if (!contentType.includes('application/json')) {
    return failure('CONTROL_CENTER_AI_MODEL_LIST_INVALID', 'Available AI models could not be read.');
  }
  let text;
  try { text = await response.text(); } catch { return failure('CONTROL_CENTER_AI_MODEL_LIST_INVALID', 'Available AI models could not be read.'); }
  if (Buffer.byteLength(text, 'utf8') > MAX_MODEL_RESPONSE_BYTES) {
    return failure('CONTROL_CENTER_AI_MODEL_LIST_TOO_LARGE', 'The AI service returned too much model information.');
  }
  let body;
  try { body = JSON.parse(text); } catch { return failure('CONTROL_CENTER_AI_MODEL_LIST_INVALID', 'Available AI models could not be read.'); }
  const candidates = Array.isArray(body?.data) ? body.data : [];
  const remoteIds = new Set(candidates
    .filter((item) => item && typeof item.id === 'string' && /^[a-zA-Z0-9._:-]{1,160}$/u.test(item.id))
    .map((item) => item.id));
  const models = service.models
    .filter((model) => remoteIds.has(model.id))
    .map((model) => ({
      id: model.id,
      display_name: model.display_name,
      native_efforts: model.native_efforts.map((effort) => ({ id: effort, display_name: humanizeEffort(effort) })),
      default_native_effort_id: model.default_native_effort
    }));
  if (models.length < 1) return failure('CONTROL_CENTER_AI_MODEL_LIST_EMPTY', 'No supported AI model is available for this key.');
  const defaultModelId = models.some((model) => model.id === service.default_model_id)
    ? service.default_model_id
    : models[0].id;
  return { ok: true, models, defaultModelId };
}

function validateKeyBuffer(value) {
  if (!Buffer.isBuffer(value)
    || value.length < CONTROL_CENTER_AI_SECRET_TRANSPORT_LIMITS.minBytes
    || value.length > CONTROL_CENTER_AI_SECRET_TRANSPORT_LIMITS.maxBytes) {
    return failure('CONTROL_CENTER_AI_KEY_INVALID', 'Enter a valid API key.');
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(value); } catch {
    return failure('CONTROL_CENTER_AI_KEY_INVALID', 'Enter a valid API key.');
  }
  if (!text || text.trim() !== text || /[\u0000-\u001f\u007f]/u.test(text)) {
    return failure('CONTROL_CENTER_AI_KEY_INVALID', 'Enter a valid API key.');
  }
  return { ok: true };
}

function generationSupportsBinding(generation, binding) {
  const model = generation.models.find((candidate) => candidate.id === binding?.model_id);
  return Boolean(model?.native_efforts.some((effort) => effort.id === binding?.provider_effort));
}

function resolveCredentialLimits(context) {
  const limits = {
    maxGenerations: boundedLimit(
      context.controlCenterAiCredentialMaxGenerations,
      CONTROL_CENTER_AI_CREDENTIAL_LIMITS.maxGenerations,
      1,
      64,
      'credential generation limit'
    ),
    maxTotalBytes: boundedLimit(
      context.controlCenterAiCredentialMaxTotalBytes,
      CONTROL_CENTER_AI_CREDENTIAL_LIMITS.maxTotalBytes,
      CONTROL_CENTER_AI_SECRET_TRANSPORT_LIMITS.maxBytes,
      1024 * 1024,
      'credential byte limit'
    ),
    idleTtlMs: boundedLimit(
      context.controlCenterAiCredentialIdleTtlMs,
      CONTROL_CENTER_AI_CREDENTIAL_LIMITS.idleTtlMs,
      100,
      24 * 60 * 60_000,
      'credential idle limit'
    ),
    absoluteTtlMs: boundedLimit(
      context.controlCenterAiCredentialAbsoluteTtlMs,
      CONTROL_CENTER_AI_CREDENTIAL_LIMITS.absoluteTtlMs,
      100,
      7 * 24 * 60 * 60_000,
      'credential lifetime limit'
    )
  };
  if (limits.absoluteTtlMs < limits.idleTtlMs) {
    throw new Error('Control Center AI credential lifetime is invalid.');
  }
  return Object.freeze(limits);
}

function boundedLimit(value, fallback, minimum, maximum, label) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`Control Center AI ${label} is invalid.`);
  }
  return number;
}

function combineAbortSignals(first, second) {
  if (!first) return second;
  if (!second) return first;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([first, second]);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (first.aborted || second.aborted) controller.abort();
  else {
    first.addEventListener('abort', abort, { once: true });
    second.addEventListener('abort', abort, { once: true });
  }
  return controller.signal;
}

function randomToken() {
  return randomBytes(32).toString('base64url');
}

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

function safeDigest(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(value) ? digest(value) : null;
}

function safeEqual(left, right) {
  return Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.length === right.length && timingSafeEqual(left, right);
}

function hashJson(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizeRevision(value) {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}

function humanizeEffort(value) {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function materializeNow(value) {
  const candidate = typeof value === 'function' ? value() : value;
  const date = candidate instanceof Date ? candidate : candidate ? new Date(candidate) : new Date();
  if (Number.isNaN(date.getTime())) throw new Error('Current time is invalid.');
  return date;
}

function failure(code, message) {
  return { ok: false, error: { code, message, details: {} } };
}
