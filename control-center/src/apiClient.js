const ACTION_TOKEN_HEADER = 'x-trace-cue-action-token';
const SESSION_TOKEN_HEADER = 'x-trace-cue-session-token';
export const CONTROL_CENTER_RESPONSE_TIMEOUTS = Object.freeze({
  defaultRequestMs: 10_000,
  localActionMs: 10_000,
  aiConnectionMs: 120_000,
  mediaUploadMs: 120_000,
  mediaReadinessMs: 60_000
});
let actionToken = null;
let sessionToken = null;
let pairingPromise = null;
const initialPairingToken = consumePairingFragment();

export function initializeControlCenterSession() {
  if (pairingPromise) return pairingPromise;
  pairingPromise = initialPairingToken ? exchangePairingToken(initialPairingToken) : Promise.resolve({ paired: false });
  return pairingPromise;
}

export async function fetchDashboard() {
  const envelope = await requestJson('/api/dashboard', {
    method: 'GET',
    cache: 'no-store'
  });
  const dashboard = envelope.data?.control_center ?? envelope.control_center ?? envelope.data ?? envelope;
  if (dashboard?.media_reviews !== undefined && !Array.isArray(dashboard.media_reviews)) throw responseContractError();
  const validatedDashboard = dashboard?.media_reviews === undefined
    ? dashboard
    : { ...dashboard, media_reviews: dashboard.media_reviews.map(requireMediaOperation) };
  const token = validatedDashboard?.action_security?.token;
  if (typeof token === 'string' && token.length >= 32) actionToken = token;
  return validatedDashboard;
}

export async function prepareAgenticReview(payload, { signal } = {}) {
  return reviewData(await requestJson('/api/agentic-review/prepare', postOptions(payload, null, { signal })));
}

export async function fetchAgenticReviewConfirmation(reviewId, { signal } = {}) {
  return reviewData(await requestJson('/api/agentic-review/confirmation', postOptions({
    review_id: reviewId,
    operation_id: reviewId,
    id: reviewId
  }, null, { signal })));
}

export async function startAgenticReview(payload, { signal } = {}) {
  const id = payload.review_id ?? payload.operation_id ?? payload.id;
  return reviewData(await requestJson('/api/agentic-review/start', postOptions({
    ...payload,
    operation_id: id,
    id,
    nonce: payload.consent_token ?? payload.nonce,
    revision: payload.consent_revision ?? payload.revision
  }, CONTROL_CENTER_RESPONSE_TIMEOUTS.localActionMs, { signal })));
}

export async function fetchAgenticReviewStatus(reviewId, { signal } = {}) {
  const query = new URLSearchParams({ id: reviewId });
  const data = reviewData(await requestJson(`/api/agentic-review/status?${query}`, {
    method: 'GET',
    cache: 'no-store',
    signal
  }));
  return data.operation ?? data;
}

export async function recoverAgenticReview(reviewId) {
  const data = reviewData(await requestJson('/api/agentic-review/recover', postOptions({ id: reviewId })));
  return data.operation ?? data;
}

export async function resumeAgenticReview(reviewId) {
  return reviewData(await requestJson('/api/agentic-review/resume', postOptions({ id: reviewId })));
}

export async function cancelAgenticReview(reviewId, { signal } = {}) {
  return reviewData(await requestJson('/api/agentic-review/cancel', postOptions(
    { id: reviewId },
    CONTROL_CENTER_RESPONSE_TIMEOUTS.localActionMs,
    { signal }
  )));
}

export async function saveAgenticReviewDecision(payload) {
  const id = payload.review_id ?? payload.operation_id ?? payload.id;
  return reviewData(await requestJson('/api/agentic-review/decision', postOptions({
    ...payload,
    operation_id: id,
    id
  })));
}

export async function repeatAgenticReview(payload, { signal } = {}) {
  const id = payload.review_id ?? payload.operation_id ?? payload.id;
  const mode = payload.repeat_kind ?? payload.mode;
  const data = reviewData(await requestJson('/api/agentic-review/repeat', postOptions({
    ...payload,
    operation_id: id,
    id,
    mode
  }, CONTROL_CENTER_RESPONSE_TIMEOUTS.localActionMs, { signal })));
  if (!reviewResponseId(data)) throw responseContractError();
  return data;
}

export async function setControlCenterPreferences(payload) {
  const envelope = await requestJson('/api/settings/control-center', postOptions(
    payload,
    CONTROL_CENTER_RESPONSE_TIMEOUTS.localActionMs
  ));
  return envelope.data?.control_center_preferences ?? envelope.data?.control_center ?? envelope.data ?? envelope;
}

export async function refreshAiConnections(payload) {
  const envelope = await requestJson('/api/settings/ai-connections/refresh', postOptions(
    payload,
    CONTROL_CENTER_RESPONSE_TIMEOUTS.aiConnectionMs
  ));
  return envelope.data?.ai_connections ?? envelope.data;
}

export async function saveAiConnectionSelection(payload) {
  const envelope = await requestJson('/api/settings/ai-connections/selection', postOptions(
    payload,
    CONTROL_CENTER_RESPONSE_TIMEOUTS.localActionMs
  ));
  return envelope.data?.ai_connections ?? envelope.data;
}

export async function createAiSetupIntent(payload) {
  const envelope = await requestJson('/api/settings/ai-setup/intents', postOptions(payload));
  return envelope.data?.ai_setup_submission;
}

export async function submitAiApiKey(submissionId, key) {
  const bytes = new TextEncoder().encode(key);
  try {
    const envelope = await requestJson('/api/settings/ai-setup/key', {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Trace-Cue-Secret-Submission': submissionId
      },
      body: bytes,
      responseTimeoutMs: CONTROL_CENTER_RESPONSE_TIMEOUTS.aiConnectionMs
    });
    return envelope.data;
  } finally {
    bytes.fill(0);
  }
}

export async function disconnectAiService(payload) {
  const envelope = await requestJson('/api/settings/ai-setup/disconnect', postOptions(
    {
      ...payload,
      confirm: 'disconnect-ai-service'
    },
    CONTROL_CENTER_RESPONSE_TIMEOUTS.aiConnectionMs
  ));
  return envelope.data;
}

export async function startCodexSubscription(payload) {
  const envelope = await requestJson('/api/settings/ai-setup/subscription/start', postOptions(
    payload,
    CONTROL_CENTER_RESPONSE_TIMEOUTS.localActionMs
  ));
  return envelope.data?.subscription_login;
}

export async function fetchCodexSubscriptionStatus() {
  const envelope = await requestJson('/api/settings/ai-setup/subscription/status', {
    method: 'GET',
    cache: 'no-store'
  });
  return envelope.data?.subscription_login;
}

export async function cancelCodexSubscription() {
  const envelope = await requestJson('/api/settings/ai-setup/subscription/cancel', postOptions({
    confirm: 'cancel-ai-sign-in'
  }, CONTROL_CENTER_RESPONSE_TIMEOUTS.localActionMs));
  return envelope.data?.subscription_login;
}

export async function finishCodexSubscription(expectedRevision) {
  const envelope = await requestJson('/api/settings/ai-setup/subscription/finish', postOptions({
    confirm: 'finish-ai-sign-in',
    expected_revision: expectedRevision
  }, CONTROL_CENTER_RESPONSE_TIMEOUTS.localActionMs));
  return envelope.data;
}

export async function createSourceIntakeProposal(payload) {
  const body = await postJson('/api/source-intake/proposal', payload);
  if (!body.ok || body.envelope.status === 'error') {
    throw new Error(body.message);
  }
  return body.envelope.data.source_intake;
}

export async function uploadReviewIntake(file, sourceKind) {
  const envelope = await requestJson('/api/review-intake/upload', {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-Trace-Cue-Source-Kind': sourceKind,
      'X-Trace-Cue-File-Name': encodeURIComponent(file.name)
    },
    body: file
  });
  return envelope.data?.control_center_intake?.intake;
}

export async function completeReviewIntake(payload) {
  const envelope = await requestJson('/api/review-intake/complete', postOptions(payload));
  return envelope.data?.control_center_intake?.result;
}

export async function listReviewIntakeResults(limit = 50) {
  const envelope = await requestJson(`/api/review-intake/results?limit=${encodeURIComponent(limit)}`);
  return envelope.data?.control_center_intake?.results ?? [];
}

export async function getReviewIntakeResult(id) {
  const envelope = await requestJson(`/api/review-intake/result?id=${encodeURIComponent(id)}`);
  return envelope.data?.control_center_intake?.result;
}

export async function fetchMediaReviewReadiness({ refresh = false } = {}) {
  const envelope = await requestJson(refresh ? '/api/media-review/readiness/refresh' : '/api/media-review/readiness', refresh
    ? postOptions({}, CONTROL_CENTER_RESPONSE_TIMEOUTS.mediaReadinessMs)
    : { method: 'GET', cache: 'no-store', responseTimeoutMs: CONTROL_CENTER_RESPONSE_TIMEOUTS.mediaReadinessMs });
  return requireMediaReadiness(envelope.data?.readiness);
}

export async function inspectMediaReviewUrl(url) {
  const envelope = await requestJson('/api/media-review/source-decision', postOptions({ url }));
  return requireMediaSourceDecision(envelope.data?.source_decision);
}

export async function uploadMediaReviewSource(file, { signal } = {}) {
  const envelope = await requestJson('/api/media-review/upload', {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-Trace-Cue-File-Name': encodeURIComponent(file.name)
    },
    body: file,
    signal,
    responseTimeoutMs: CONTROL_CENTER_RESPONSE_TIMEOUTS.mediaUploadMs
  });
  return requireMediaSource(envelope.data?.media_source);
}

export async function discardMediaReviewSource(sourceId) {
  const envelope = await requestJson('/api/media-review/source/discard', postOptions({ source_id: sourceId }));
  return requireMediaCleanupReceipt(envelope.data?.cleanup_receipt);
}

export async function startMediaReview(payload, { signal } = {}) {
  const envelope = await requestJson('/api/media-review/start', postOptions(payload, CONTROL_CENTER_RESPONSE_TIMEOUTS.mediaReadinessMs, { signal }));
  return requireMediaOperation(envelope.data?.media_review);
}

export async function fetchMediaReviewStatus(operationId, { signal } = {}) {
  const query = new URLSearchParams({ id: operationId });
  const envelope = await requestJson(`/api/media-review/status?${query}`, { method: 'GET', cache: 'no-store', signal });
  return requireMediaOperation(envelope.data?.media_review);
}

export async function listMediaReviews() {
  const envelope = await requestJson('/api/media-review/list', { method: 'GET', cache: 'no-store' });
  const values = envelope.data?.media_reviews;
  if (!Array.isArray(values)) throw responseContractError();
  return values.map(requireMediaOperation);
}

export async function getMediaReviewResult(operationId) {
  const query = new URLSearchParams({ id: operationId });
  const envelope = await requestJson(`/api/media-review/result?${query}`, { method: 'GET', cache: 'no-store' });
  return requireMediaResult(envelope.data?.media_review_result);
}

export async function cancelMediaReview(operationId) {
  const envelope = await requestJson('/api/media-review/cancel', postOptions({ operation_id: operationId }));
  return requireMediaOperation(envelope.data?.media_review);
}

export async function cleanupMediaReviewOperation(operationId, retention) {
  const envelope = await requestJson('/api/media-review/cleanup', postOptions({ operation_id: operationId, retention }));
  return requireMediaCleanupReceipt(envelope.data?.cleanup_receipt);
}

export async function setDisplayLanguage(payload) {
  const body = await postJson('/api/settings/display-language', payload);
  if (!body.ok || body.envelope.status === 'error') {
    throw new Error(body.message);
  }
  return body.envelope.data.display_language;
}

export async function setPlaywrightTestMode(payload) {
  const body = await postJson('/api/playwright-test/mode', payload);
  if (!body.ok || body.envelope.status === 'error') {
    throw new Error(body.message);
  }
  return body.envelope.data.playwright_test_mode;
}

export async function importPlaywrightTestResult(payload) {
  const body = await postJson('/api/playwright-test/import', payload);
  if (!body.ok || body.envelope.status === 'error') {
    throw new Error(body.message);
  }
  return body.envelope.data.playwright_test_import;
}

export async function fetchPlaywrightTestCiArtifact(payload) {
  const body = await postJson('/api/playwright-test/external-ci/fetch', payload);
  if (!body.ok || body.envelope.status === 'error') {
    throw new Error(body.message);
  }
  return body.envelope.data.playwright_test_import ?? body.envelope.data.playwright_test_external_ci_fetch;
}

export async function suggestPlaywrightTestCiSettings(payload) {
  const body = await postJson('/api/playwright-test/external-ci/suggest-settings', payload);
  if (!body.ok || body.envelope.status === 'error') {
    throw new Error(body.message);
  }
  return body.envelope.data.playwright_test_external_ci_settings_suggestion;
}

export async function approvePlaywrightTestCiSettings(payload) {
  const body = await postJson('/api/playwright-test/external-ci/approve-settings', payload);
  if (!body.ok || body.envelope.status === 'error') {
    throw new Error(body.message);
  }
  return body.envelope.data.playwright_test_external_ci_approved_settings;
}

export async function fetchApprovedPlaywrightTestCiArtifact(payload) {
  const body = await postJson('/api/playwright-test/external-ci/fetch-approved', payload);
  if (!body.ok || body.envelope.status === 'error') {
    throw new Error(body.message);
  }
  return body.envelope.data.playwright_test_import ?? body.envelope.data.playwright_test_external_ci_fetch_approved;
}

async function postJson(url, payload) {
  try {
    const envelope = await requestJson(url, postOptions(payload));
    return { ok: true, envelope, message: '' };
  } catch (error) {
    const envelope = error.envelope ?? {};
    const message = error.message ?? 'The local action could not be completed.';
    return { ok: false, envelope, message };
  }
}

function postOptions(payload, responseTimeoutMs = null, requestOverrides = {}) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(payload),
    ...(Number.isSafeInteger(responseTimeoutMs) && responseTimeoutMs > 0 ? { responseTimeoutMs } : {}),
    ...requestOverrides
  };
}

async function requestJson(url, options = {}) {
  const { responseTimeoutMs, ...fetchOptions } = options;
  const timeoutMs = Number.isSafeInteger(responseTimeoutMs) && responseTimeoutMs > 0
    ? responseTimeoutMs
    : CONTROL_CENTER_RESPONSE_TIMEOUTS.defaultRequestMs;
  const deadlineAt = Date.now() + timeoutMs;
  await settleBeforeDeadline(initializeControlCenterSession(), deadlineAt);
  const mutation = !['GET', 'HEAD'].includes(String(fetchOptions.method ?? 'GET').toUpperCase());
  if (mutation && !actionToken) await bootstrapActionToken(deadlineAt);
  const { response, envelope } = await fetchJsonBeforeDeadline(
    url,
    requestOptions(fetchOptions, mutation),
    deadlineAt
  );
  if (!response.ok || envelope.status === 'error') {
    if (!isDeclaredErrorEnvelope(envelope)) throw responseContractError();
    const message = envelope.errors?.[0]?.message
      ?? envelope.error?.message
      ?? 'The local action could not be completed.';
    const error = new Error(message);
    error.envelope = envelope;
    throw error;
  }
  if (!isCompleteSuccessEnvelope(envelope)) throw responseContractError();
  return envelope;
}

async function bootstrapActionToken(deadlineAt) {
  const { response, envelope } = await fetchJsonBeforeDeadline('/api/dashboard', {
    method: 'GET',
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      ...(sessionToken ? { [SESSION_TOKEN_HEADER]: sessionToken } : {})
    }
  }, deadlineAt);
  const token = envelope?.data?.control_center?.action_security?.token;
  if (!response.ok || typeof token !== 'string' || token.length < 32) {
    throw new Error('Refresh the Control Center before making this change.');
  }
  actionToken = token;
}

function requestOptions(options, mutation) {
  return {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.headers ?? {}),
      ...(sessionToken ? { [SESSION_TOKEN_HEADER]: sessionToken } : {}),
      ...(mutation ? { [ACTION_TOKEN_HEADER]: actionToken } : {})
    }
  };
}

async function exchangePairingToken(token) {
  try {
    return await exchangePairingTokenOnce(token);
  } catch (error) {
    error.controlCenterReopenRequired = true;
    throw error;
  }
}

async function exchangePairingTokenOnce(token) {
  const { response, envelope: body } = await fetchJsonBeforeDeadline('/api/pairing/exchange', {
    method: 'POST',
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/octet-stream'
    },
    body: token
  }, Date.now() + CONTROL_CENTER_RESPONSE_TIMEOUTS.defaultRequestMs);
  if (!response.ok
    || typeof body.session_token !== 'string'
    || typeof body.action_token !== 'string') {
    const error = new Error(body?.errors?.[0]?.message ?? body?.error?.message ?? 'Open the Control Center again to continue.');
    error.envelope = body;
    throw error;
  }
  sessionToken = body.session_token;
  actionToken = body.action_token;
  return { paired: true, expires_at: body.expires_at ?? null };
}

async function fetchJsonBeforeDeadline(url, options, deadlineAt) {
  const controller = new AbortController();
  const callerSignal = options.signal;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  const request = fetch(url, {
    ...options,
    signal: controller.signal
  }).then(async (response) => {
    let envelope;
    try {
      envelope = await response.json();
    } catch {
      const error = new Error('The local action response could not be read.');
      error.name = 'ResponseParseError';
      throw error;
    }
    return { response, envelope };
  });
  try {
    return await settleBeforeDeadline(request, deadlineAt, () => controller.abort());
  } finally {
    callerSignal?.removeEventListener('abort', abortFromCaller);
  }
}

async function settleBeforeDeadline(promise, deadlineAt, onTimeout = null) {
  const remainingMs = Math.max(0, deadlineAt - Date.now());
  if (remainingMs === 0) {
    onTimeout?.();
    throw timeoutError();
  }
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(timeoutError());
    }, remainingMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function timeoutError() {
  const error = new Error('The local action response timed out.');
  error.name = 'TimeoutError';
  return error;
}

function responseContractError() {
  const error = new Error('The local action response could not be read.');
  error.name = 'ResponseContractError';
  return error;
}

function requireMediaReadiness(value) {
  if (!isTypedObject(value, 'media_review_readiness')
    || !['uninspected', 'ready', 'unavailable'].includes(value.status)
    || !Array.isArray(value.local_input?.accepted_extensions)
    || value.local_input.accepted_extensions.length === 0
    || new Set(value.local_input.accepted_extensions).size !== value.local_input.accepted_extensions.length
    || value.local_input.accepted_extensions.some((extension) => !/^\.[a-z0-9]{1,8}$/u.test(extension))
    || !Number.isSafeInteger(value.local_input?.maximum_bytes)
    || value.local_input.maximum_bytes <= 0
    || !validReadinessComponent(value.transcript_provider)
    || !validReadinessComponent(value.technical_analyzer)
    || value.boundary?.read_only !== true
    || value.boundary?.provider_transcription_performed !== false
    || value.boundary?.media_analysis_performed !== false
    || value.boundary?.network_performed !== false
    || value.boundary?.setup_performed !== false
    || value.boundary?.mcp_execution_performed !== false
    || value.boundary?.secrets_included !== false
    || value.boundary?.executable_paths_included !== false
    || value.boundary?.provider_revision_included !== false
    || value.boundary?.configuration_hashes_included !== false) throw responseContractError();
  return value;
}

function requireMediaSourceDecision(value) {
  const capabilities = new Set(['playback_inspection', 'full_media_analysis', 'metadata_only', 'unsupported']);
  if (!isTypedObject(value, 'media_source_decision')
    || !Array.isArray(value.capabilities)
    || value.capabilities.some((item) => !capabilities.has(item))
    || value.boundary?.network_performed !== false
    || value.boundary?.media_acquired !== false
    || value.boundary?.download_performed !== false
    || value.boundary?.redirect_followed !== false
    || value.boundary?.dns_resolution_performed !== false
    || value.boundary?.url_query_or_fragment_included !== false
    || value.boundary?.credentials_included !== false
    || value.boundary?.rights_declaration_treated_as_legal_proof !== false) throw responseContractError();
  return value;
}

function requireMediaSource(value) {
  const formats = new Set(['iso-base-media', 'quicktime', 'matroska', 'webm']);
  if (!isTypedObject(value, 'control_center_media_source')
    || !/^[a-f0-9]{32}$/u.test(value.source_id ?? '')
    || value.state !== 'staged'
    || !Number.isSafeInteger(value.bytes)
    || value.bytes <= 0
    || !/^[a-f0-9]{64}$/u.test(value.media_identity?.sha256 ?? '')
    || value.media_identity?.bytes !== value.bytes
    || !formats.has(value.media_identity?.format)
    || value.format !== value.media_identity.format
    || !Number.isFinite(Date.parse(value.expires_at))
    || value.boundary?.absolute_path_included !== false
    || value.boundary?.original_name_included !== false
    || value.boundary?.raw_media_included !== false
    || value.boundary?.private_locator_included !== false
    || value.boundary?.external_send_performed !== false
    || value.boundary?.network_performed !== false) throw responseContractError();
  return value;
}

function requireMediaOperation(value) {
  if (!isTypedObject(value, 'media_review_operation')
    || !/^[a-f0-9]{32}$/u.test(value.operation_id ?? '')
    || !['prepared', 'running', 'cancelling', 'cancelled', 'completed', 'completed_retained', 'failed', 'interrupted', 'cleanup_required', 'cleaned'].includes(value.state)
    || !['ephemeral', 'project-retained'].includes(value.retention)
    || !value.capabilities || typeof value.capabilities !== 'object'
    || !['status', 'cancel', 'cleanup', 'result'].every((key) => typeof value.capabilities[key] === 'boolean')
    || typeof value.result_available !== 'boolean'
    || typeof value.cleanup_available !== 'boolean'
    || typeof value.private_payload_retained !== 'boolean'
    || value.cleanup_available !== value.capabilities.cleanup
    || value.result_available !== value.capabilities.result
    || (value.cleanup_available && !value.private_payload_retained)
    || !Array.isArray(value.errors)
    || value.boundary?.absolute_path_included !== false
    || value.boundary?.private_locator_included !== false
    || value.boundary?.source_name_included !== false
    || value.boundary?.raw_media_included !== false
    || value.boundary?.full_transcript_included !== false) throw responseContractError();
  return value;
}

function requireMediaResult(value) {
  if (!isTypedObject(value, 'media_review_result')
    || !/^[a-f0-9]{32}$/u.test(value.operation_id ?? '')
    || !Array.isArray(value.deterministic_findings)
    || !Array.isArray(value.advisory_findings)
    || value.deterministic_findings.some((finding) => finding?.classification !== 'deterministic_measurement')
    || value.advisory_findings.some((finding) => finding?.classification !== 'advisory_evaluation')
    || value.privacy?.full_transcript_in_result !== false
    || value.privacy?.raw_audio_in_result !== false
    || value.privacy?.raw_frames_in_result !== false
    || value.privacy?.external_send_performed !== false
    || value.transcript?.boundary?.body_included !== false
    || value.transcript?.boundary?.absolute_paths_included !== false
    || Object.hasOwn(value.transcript ?? {}, 'segments')
    || value.technical_analysis?.boundary?.raw_media_included !== false
    || value.technical_analysis?.boundary?.raw_audio_included !== false
    || value.technical_analysis?.boundary?.raw_frames_included !== false
    || value.timeline?.boundary?.full_transcript_included !== false
    || value.boundary?.absolute_paths_included !== false
    || value.boundary?.raw_media_included !== false
    || value.boundary?.raw_audio_included !== false
    || value.boundary?.raw_frames_included !== false
    || value.boundary?.full_transcript_included !== false
    || value.boundary?.external_send_enabled !== false
    || value.boundary?.deterministic_and_advisory_separated !== true) throw responseContractError();
  return value;
}

function requireMediaCleanupReceipt(value) {
  if (!isTypedObject(value, 'media_cleanup_receipt')
    || !/^[a-f0-9]{32}$/u.test(value.operation_id ?? '')
    || !['cleaned', 'already_cleaned'].includes(value.status)
    || (value.status === 'cleaned' && !/^[a-f0-9]{64}$/u.test(value.identity ?? ''))
    || (value.status === 'already_cleaned' && !(value.identity === null || /^[a-f0-9]{64}$/u.test(value.identity ?? '')))
    || value.boundary?.absolute_path_included !== false
    || value.boundary?.raw_media_included !== false
    || value.boundary?.full_transcript_included !== false
    || value.boundary?.sibling_deleted !== false
    || value.boundary?.normal_artifact_root_deleted !== false) throw responseContractError();
  return value;
}

function validReadinessComponent(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && ['uninspected', 'ready', 'setup_required', 'unavailable'].includes(value.status)
    && Array.isArray(value.limitations)
    && value.limitations.every((item) => typeof item === 'string' && item.length <= 160);
}

function isTypedObject(value, type) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && value.schema_version === '1.0.0' && value.type === type;
}

function isCompleteSuccessEnvelope(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.status === 'ok'
    && Boolean(value.data)
    && typeof value.data === 'object'
    && !Array.isArray(value.data)
    && Object.keys(value.data).length > 0;
}

function isDeclaredErrorEnvelope(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value.status === 'error'
      || Boolean(value.error && typeof value.error === 'object')
      || (Array.isArray(value.errors) && value.errors.length > 0));
}

function reviewResponseId(value) {
  return value?.review_id ?? value?.id ?? value?.operation?.review_id ?? value?.operation?.id ?? null;
}

function consumePairingFragment() {
  if (typeof window === 'undefined' || typeof window.location?.hash !== 'string') return null;
  const hash = window.location.hash;
  let token = null;
  if (hash.startsWith('#pair=')) {
    try { token = decodeURIComponent(hash.slice('#pair='.length)); } catch { token = null; }
  }
  if (hash) {
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
  }
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(token) ? token : null;
}

function reviewData(envelope) {
  return envelope.data?.agentic_review
    ?? envelope.data?.control_center_agentic_review
    ?? envelope.data?.review
    ?? envelope.data
    ?? envelope.agentic_review
    ?? envelope.review
    ?? envelope;
}
