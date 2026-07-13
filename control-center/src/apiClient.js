const ACTION_TOKEN_HEADER = 'x-trace-cue-action-token';
let actionToken = null;

export async function fetchDashboard() {
  const envelope = await requestJson('/api/dashboard', {
    method: 'GET',
    cache: 'no-store'
  });
  const dashboard = envelope.data?.control_center ?? envelope.control_center ?? envelope.data ?? envelope;
  const token = dashboard?.action_security?.token;
  if (typeof token === 'string' && token.length >= 32) actionToken = token;
  return dashboard;
}

export async function prepareAgenticReview(payload) {
  return reviewData(await requestJson('/api/agentic-review/prepare', postOptions(payload)));
}

export async function fetchAgenticReviewConfirmation(reviewId) {
  return reviewData(await requestJson('/api/agentic-review/confirmation', postOptions({
    review_id: reviewId,
    operation_id: reviewId,
    id: reviewId
  })));
}

export async function startAgenticReview(payload) {
  const id = payload.review_id ?? payload.operation_id ?? payload.id;
  return reviewData(await requestJson('/api/agentic-review/start', postOptions({
    ...payload,
    operation_id: id,
    id,
    nonce: payload.consent_token ?? payload.nonce,
    revision: payload.consent_revision ?? payload.revision
  })));
}

export async function fetchAgenticReviewStatus(reviewId) {
  const query = new URLSearchParams({ id: reviewId });
  const data = reviewData(await requestJson(`/api/agentic-review/status?${query}`, {
    method: 'GET',
    cache: 'no-store'
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

export async function cancelAgenticReview(reviewId) {
  return reviewData(await requestJson('/api/agentic-review/cancel', postOptions({ id: reviewId })));
}

export async function saveAgenticReviewDecision(payload) {
  const id = payload.review_id ?? payload.operation_id ?? payload.id;
  return reviewData(await requestJson('/api/agentic-review/decision', postOptions({
    ...payload,
    operation_id: id,
    id
  })));
}

export async function repeatAgenticReview(payload) {
  const id = payload.review_id ?? payload.operation_id ?? payload.id;
  const mode = payload.repeat_kind ?? payload.mode;
  return reviewData(await requestJson('/api/agentic-review/repeat', postOptions({
    ...payload,
    operation_id: id,
    id,
    mode
  })));
}

export async function setControlCenterPreferences(payload) {
  const envelope = await requestJson('/api/settings/control-center', postOptions(payload));
  return envelope.data?.control_center_preferences ?? envelope.data?.control_center ?? envelope.data ?? envelope;
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

function postOptions(payload) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(payload)
  };
}

async function requestJson(url, options = {}) {
  const mutation = !['GET', 'HEAD'].includes(String(options.method ?? 'GET').toUpperCase());
  if (mutation && !actionToken) await bootstrapActionToken();
  const response = await fetch(url, requestOptions(options, mutation));
  let envelope;
  try {
    envelope = await response.json();
  } catch {
    envelope = {};
  }
  if (!response.ok || envelope.status === 'error') {
    const message = envelope.errors?.[0]?.message
      ?? envelope.error?.message
      ?? 'The local action could not be completed.';
    const error = new Error(message);
    error.envelope = envelope;
    throw error;
  }
  return envelope;
}

async function bootstrapActionToken() {
  const response = await fetch('/api/dashboard', {
    method: 'GET',
    cache: 'no-store',
    headers: { Accept: 'application/json' }
  });
  const envelope = await response.json();
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
      ...(mutation ? { [ACTION_TOKEN_HEADER]: actionToken } : {})
    }
  };
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
