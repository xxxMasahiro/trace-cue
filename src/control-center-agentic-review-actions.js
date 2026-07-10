import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  runAgenticHumanReviewPlan,
  runAgenticHumanReviewPropose,
  runAgenticHumanReviewRun
} from './agentic-human-review.js';
import { runReview } from './review.js';

export const CONTROL_CENTER_AGENTIC_REVIEW_SCHEMA_VERSION = '1.0.0';
export const CONTROL_CENTER_AGENTIC_REVIEW_ARTIFACT_DIR = 'control-center-agentic-reviews';
export const CONTROL_CENTER_AGENTIC_REVIEW_SERVICE_NAME_ENV = 'TRACE_CUE_CONTROL_CENTER_AGENTIC_REVIEW_SERVICE_NAME';
export const CONTROL_CENTER_AGENTIC_REVIEW_PROVIDER_ENV = 'TRACE_CUE_CONTROL_CENTER_AGENTIC_REVIEW_PROVIDER';
export const CONTROL_CENTER_AGENTIC_REVIEW_PURPOSE_MAX_LENGTH = 1200;
export const CONTROL_CENTER_AGENTIC_REVIEW_ENDPOINTS = Object.freeze({
  prepare: '/api/agentic-review/prepare',
  confirmation: '/api/agentic-review/confirmation',
  start: '/api/agentic-review/start',
  status: '/api/agentic-review/status',
  decision: '/api/agentic-review/decision',
  repeat: '/api/agentic-review/repeat',
  list: '/api/agentic-review/list'
});
export const CONTROL_CENTER_AGENTIC_REVIEW_EFFORTS = Object.freeze(['standard', 'deep', 'xhigh']);
export const CONTROL_CENTER_AGENTIC_REVIEW_VIEWPORTS = Object.freeze(['desktop', 'mobile', 'both']);
export const CONTROL_CENTER_AGENTIC_REVIEW_DECISIONS = Object.freeze(['fix', 'later', 'ask']);
export const CONTROL_CENTER_AGENTIC_REVIEW_REPEAT_MODES = Object.freeze(['deeper', 'recheck']);

const DEFAULT_ARTIFACT_ROOT = '.browser-debug';
const OPERATION_FILE = 'operation.json';
const MAX_OPERATION_BYTES = 1024 * 1024;
const CONFIRMATION_TTL_MS = 15 * 60 * 1000;
const MAX_LIST_LIMIT = 100;
const OPERATION_ID_PATTERN = /^control-center-agentic-review-[a-zA-Z0-9._-]{1,160}$/;
const ACTIVE_DISPATCHES = new Set();
const OPERATION_LOCKS = new Map();

const TRANSFER_LABELS = Object.freeze({
  raw_pixels: 'Visible page image',
  page_text: 'Visible page text',
  dom_summary: 'Page structure summary',
  url: 'Page address',
  artifact_refs: 'Local evidence references without file contents',
  accessibility_summary: 'Accessibility summary'
});

export async function runControlCenterAgenticReviewPrepare(input = {}, context = {}) {
  const forbidden = findBrowserAuthorityFields(input);
  if (forbidden.length > 0) {
    return actionError('CONTROL_CENTER_AGENTIC_REVIEW_BROWSER_AUTHORITY_REJECTED', 'Provider execution details are controlled by the local TraceCue service.', {
      rejected_fields: forbidden
    });
  }
  const validation = validatePrepareInput(input);
  if (!validation.ok) {
    return actionError(validation.code, validation.message, validation.details);
  }

  if (validation.value.ai_suggestions && !configuredServiceName(context)) {
    return actionError('CONTROL_CENTER_AGENTIC_REVIEW_SERVICE_NOT_CONFIGURED', 'Choose and configure the external AI review service before enabling AI suggestions.', {});
  }

  const now = materializeNow(context.now);
  const operation = createOperation({
    id: createOperationId(context, now),
    input: validation.value,
    now,
    context,
    relationship: normalizeRelationship(input.relationship)
  });

  try {
    await saveOperation(operation, context);
  } catch (error) {
    return actionError('CONTROL_CENTER_AGENTIC_REVIEW_STORE_FAILED', 'The review could not be prepared in the local workspace.', {});
  }

  scheduleBackground(operation.id, context, async () => {
    await prepareOperation(operation.id, context);
  });

  return actionOk({
    operation: projectOperation(operation),
    accepted: true,
    background_work_started: true
  });
}

export async function runControlCenterAgenticReviewConfirmation(input = {}, context = {}) {
  const id = normalizeOperationId(input.operation_id ?? input.operationId ?? input.id);
  if (!id.ok) {
    return actionError(id.code, id.message, id.details);
  }

  return withOperationLock(id.value, async () => {
    const loaded = await loadOperationResult(id.value, context);
    if (!loaded.ok) return loaded.result;
    const operation = loaded.operation;
    if (operation.state !== 'confirmation_required') {
      return actionError('CONTROL_CENTER_AGENTIC_REVIEW_CONFIRMATION_NOT_AVAILABLE', 'This review is not waiting for external AI confirmation.', {
        state: operation.state
      });
    }

    const now = materializeNow(context.now);
    const nonce = randomBytes(32).toString('base64url');
    operation.confirmation = {
      nonce_hash: sha256(nonce),
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + CONFIRMATION_TTL_MS).toISOString(),
      used_at: null,
      revision: operation.disclosure.revision,
      consent_digest: operation.internal.consent_digest
    };
    operation.updated_at = now.toISOString();
    await saveOperation(operation, context);

    return actionOk({
      operation: projectOperation(operation),
      confirmation: {
        nonce,
        revision: operation.disclosure.revision,
        expires_at: operation.confirmation.expires_at
      }
    });
  });
}

export async function runControlCenterAgenticReviewStart(input = {}, context = {}) {
  const forbidden = findBrowserAuthorityFields(input);
  if (forbidden.length > 0) {
    return actionError('CONTROL_CENTER_AGENTIC_REVIEW_BROWSER_AUTHORITY_REJECTED', 'Provider execution details are controlled by the local TraceCue service.', {
      rejected_fields: forbidden
    });
  }
  const id = normalizeOperationId(input.operation_id ?? input.operationId ?? input.id);
  if (!id.ok) return actionError(id.code, id.message, id.details);
  if (input.execute_confirmed !== true && input.executeConfirmed !== true) {
    return actionError('CONTROL_CENTER_AGENTIC_REVIEW_EXECUTE_CONFIRMATION_REQUIRED', 'Starting external AI review requires explicit confirmation.', {});
  }
  const nonce = boundedString(input.nonce, 1024);
  const revision = boundedString(input.revision, 128);
  if (!nonce || !revision) {
    return actionError('CONTROL_CENTER_AGENTIC_REVIEW_CONFIRMATION_REQUIRED', 'A current one-time confirmation is required.', {});
  }

  const prepared = await withOperationLock(id.value, async () => {
    const loaded = await loadOperationResult(id.value, context);
    if (!loaded.ok) return loaded.result;
    const operation = loaded.operation;
    if (operation.state !== 'confirmation_required') {
      return actionError('CONTROL_CENTER_AGENTIC_REVIEW_ALREADY_STARTED', 'This review cannot be started again.', {
        state: operation.state
      });
    }
    const confirmation = operation.confirmation;
    const now = materializeNow(context.now);
    if (!confirmation || confirmation.used_at || sha256(nonce) !== confirmation.nonce_hash) {
      return actionError('CONTROL_CENTER_AGENTIC_REVIEW_CONFIRMATION_INVALID', 'The one-time confirmation is invalid or has already been used.', {});
    }
    if (Date.parse(confirmation.expires_at) <= now.getTime()) {
      return actionError('CONTROL_CENTER_AGENTIC_REVIEW_CONFIRMATION_EXPIRED', 'The one-time confirmation has expired.', {});
    }
    if (revision !== confirmation.revision
      || confirmation.revision !== operation.disclosure.revision
      || confirmation.consent_digest !== operation.internal.consent_digest) {
      return actionError('CONTROL_CENTER_AGENTIC_REVIEW_DISCLOSURE_CHANGED', 'What would be sent has changed. Review the current disclosure before continuing.', {});
    }
    if (computeConsentDigest(operation) !== operation.internal.consent_digest) {
      return actionError('CONTROL_CENTER_AGENTIC_REVIEW_PLAN_CHANGED', 'The prepared review changed after confirmation and cannot be started.', {});
    }

    confirmation.used_at = now.toISOString();
    operation.state = 'dispatching';
    operation.stage = 'external_review';
    operation.started_at = now.toISOString();
    operation.updated_at = now.toISOString();
    operation.dispatch = {
      attempt: Number(operation.dispatch?.attempt ?? 0) + 1,
      provider_call_performed: false,
      api_call_performed: false,
      external_evidence_transfer: false,
      retry_automatic: false,
      cancel_available: false
    };
    await saveOperation(operation, context);
    return actionOk({ operation: projectOperation(operation), accepted: true });
  });

  if (prepared.status !== 'ok') return prepared;
  scheduleBackground(id.value, context, async () => {
    await dispatchOperation(id.value, context);
  });
  return prepared;
}

export async function runControlCenterAgenticReviewStatus(input = {}, context = {}) {
  const id = normalizeOperationId(input.operation_id ?? input.operationId ?? input.id);
  if (!id.ok) return actionError(id.code, id.message, id.details);
  const loaded = await loadOperationResult(id.value, context, { recoverDispatch: true });
  if (!loaded.ok) return loaded.result;
  return actionOk({ operation: projectOperation(loaded.operation) });
}

export async function runControlCenterAgenticReviewDecision(input = {}, context = {}) {
  const id = normalizeOperationId(input.operation_id ?? input.operationId ?? input.id);
  if (!id.ok) return actionError(id.code, id.message, id.details);
  const decision = normalizeChoice(input.decision, CONTROL_CENTER_AGENTIC_REVIEW_DECISIONS);
  if (!decision.ok) {
    return actionError('CONTROL_CENTER_AGENTIC_REVIEW_DECISION_INVALID', 'Choose whether to fix it, handle it later, or ask someone.', {
      allowed: [...CONTROL_CENTER_AGENTIC_REVIEW_DECISIONS]
    });
  }
  const findingId = boundedString(input.finding_id ?? input.findingId, 220);
  if (!findingId) {
    return actionError('CONTROL_CENTER_AGENTIC_REVIEW_FINDING_ID_REQUIRED', 'Choose the improvement item this decision applies to.', {});
  }

  return withOperationLock(id.value, async () => {
    const loaded = await loadOperationResult(id.value, context);
    if (!loaded.ok) return loaded.result;
    const operation = loaded.operation;
    if (!['completed', 'failed', 'dispatch_unknown'].includes(operation.state)) {
      return actionError('CONTROL_CENTER_AGENTIC_REVIEW_DECISION_NOT_AVAILABLE', 'A decision can be recorded after the review finishes.', {
        state: operation.state
      });
    }
    const findings = Array.isArray(operation.result?.findings) ? operation.result.findings : [];
    if (!findings.some((finding) => finding.id === findingId)) {
      return actionError('CONTROL_CENTER_AGENTIC_REVIEW_FINDING_NOT_FOUND', 'The selected improvement item is not part of this review.', {});
    }
    const now = materializeNow(context.now);
    const nextDecision = {
      finding_id: findingId,
      value: decision.value,
      recorded_at: now.toISOString()
    };
    operation.decisions = [
      ...(Array.isArray(operation.decisions) ? operation.decisions : [])
        .filter((item) => item.finding_id !== findingId),
      nextDecision
    ];
    operation.updated_at = now.toISOString();
    await saveOperation(operation, context);
    return actionOk({ operation: projectOperation(operation) });
  });
}

export async function runControlCenterAgenticReviewRepeat(input = {}, context = {}) {
  const id = normalizeOperationId(input.operation_id ?? input.operationId ?? input.id);
  if (!id.ok) return actionError(id.code, id.message, id.details);
  const mode = normalizeChoice(input.mode, CONTROL_CENTER_AGENTIC_REVIEW_REPEAT_MODES);
  if (!mode.ok) {
    return actionError('CONTROL_CENTER_AGENTIC_REVIEW_REPEAT_MODE_INVALID', 'Choose a deeper review or a review after changes.', {
      allowed: [...CONTROL_CENTER_AGENTIC_REVIEW_REPEAT_MODES]
    });
  }
  const loaded = await loadOperationResult(id.value, context, { recoverDispatch: true });
  if (!loaded.ok) return loaded.result;
  const previous = loaded.operation;
  if (!['completed', 'failed', 'dispatch_unknown'].includes(previous.state)) {
    return actionError('CONTROL_CENTER_AGENTIC_REVIEW_REPEAT_NOT_AVAILABLE', 'A new review can be prepared after the current review finishes.', {
      state: previous.state
    });
  }
  const effort = mode.value === 'deeper' ? nextEffort(previous.request.effort) : previous.request.effort;
  if (!effort) {
    return actionError('CONTROL_CENTER_AGENTIC_REVIEW_ALREADY_DEEPEST', 'This review already uses the most thorough review method.', {});
  }

  return runControlCenterAgenticReviewPrepare({
    url: previous.internal.target_url,
    purpose: previous.request.purpose,
    effort,
    viewport: previous.request.viewport,
    ai_suggestions: previous.request.ai_suggestions,
    relationship: {
      kind: mode.value,
      previous_operation_id: previous.id
    }
  }, context);
}

export async function runControlCenterAgenticReviewList(input = {}, context = {}) {
  const limit = normalizeLimit(input.limit);
  if (!limit.ok) return actionError(limit.code, limit.message, limit.details);
  const root = operationsRoot(context);
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return actionOk({ operations: [], count: 0 });
    return actionError('CONTROL_CENTER_AGENTIC_REVIEW_LIST_FAILED', 'The local review list could not be read.', {});
  }

  const operations = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !OPERATION_ID_PATTERN.test(entry.name)) continue;
    const loaded = await loadOperationResult(entry.name, context, { recoverDispatch: true, suppressNotFound: true });
    if (loaded.ok) operations.push(loaded.operation);
  }
  operations.sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
  return actionOk({
    operations: operations.slice(0, limit.value).map(projectOperation),
    count: Math.min(operations.length, limit.value),
    total: operations.length
  });
}

async function prepareOperation(id, context) {
  await withOperationLock(id, async () => {
    const operation = await loadOperation(id, context);
    if (operation.state !== 'preparing') return;
    operation.stage = 'browser_review';
    operation.updated_at = materializeNow(context.now).toISOString();
    await saveOperation(operation, context);
  });

  try {
    const operation = await loadOperation(id, context);
    const reviewRunner = context.runReview ?? runReview;
    const review = await reviewRunner({
      input: JSON.stringify(buildTargetManifest(operation)),
      screenshot: true,
      report: false,
      'artifact-root': artifactRoot(context)
    }, executionContext(context));
    if (review?.status !== 'ok') {
      throw resultFailure('CONTROL_CENTER_AGENTIC_REVIEW_BROWSER_REVIEW_FAILED', review);
    }
    const reviewIndexPath = artifactPath(review, 'review_artifact_index');
    if (!reviewIndexPath) {
      throw codedError('CONTROL_CENTER_AGENTIC_REVIEW_INDEX_MISSING', 'The local browser review did not produce a review index.');
    }

    if (!operation.request.ai_suggestions) {
      await withOperationLock(id, async () => {
        const current = await loadOperation(id, context);
        const now = materializeNow(context.now).toISOString();
        current.state = 'completed';
        current.stage = 'complete';
        current.completed_at = now;
        current.updated_at = now;
        current.result = projectLocalReview(review);
        current.internal.review_index_path = reviewIndexPath;
        await saveOperation(current, context);
      });
      return;
    }

    await withOperationLock(id, async () => {
      const current = await loadOperation(id, context);
      current.stage = 'review_plan';
      current.updated_at = materializeNow(context.now).toISOString();
      current.internal.review_index_path = reviewIndexPath;
      await saveOperation(current, context);
    });

    const proposeRunner = context.runAgenticHumanReviewPropose ?? runAgenticHumanReviewPropose;
    const proposal = await proposeRunner({
      brief: operation.request.purpose,
      effort: operation.request.effort,
      'review-index': reviewIndexPath,
      provider: operation.internal.provider_id,
      'artifact-root': artifactRoot(context)
    }, executionContext(context));
    if (proposal?.status !== 'ok') {
      throw resultFailure('CONTROL_CENTER_AGENTIC_REVIEW_PROPOSAL_FAILED', proposal);
    }
    const proposalPath = artifactPath(proposal, 'agentic_human_review_proposal');
    if (!proposalPath) {
      throw codedError('CONTROL_CENTER_AGENTIC_REVIEW_PROPOSAL_MISSING', 'The local review proposal was not created.');
    }

    const planRunner = context.runAgenticHumanReviewPlan ?? runAgenticHumanReviewPlan;
    const planResult = await planRunner({
      proposal: proposalPath,
      provider: operation.internal.provider_id,
      effort: operation.request.effort,
      'artifact-root': artifactRoot(context)
    }, executionContext(context));
    if (planResult?.status !== 'ok') {
      throw resultFailure('CONTROL_CENTER_AGENTIC_REVIEW_PLAN_FAILED', planResult);
    }
    const plan = planResult.data?.agentic_human_review_plan;
    const planPath = artifactPath(planResult, 'agentic_human_review_plan');
    if (!plan || !planPath || !plan.plan_hash) {
      throw codedError('CONTROL_CENTER_AGENTIC_REVIEW_PLAN_MISSING', 'The external AI review plan was not created.');
    }

    await withOperationLock(id, async () => {
      const current = await loadOperation(id, context);
      const now = materializeNow(context.now).toISOString();
      current.state = 'confirmation_required';
      current.stage = 'confirmation';
      current.updated_at = now;
      current.internal.proposal_path = proposalPath;
      current.internal.plan_path = planPath;
      current.internal.plan_hash = plan.plan_hash;
      current.internal.package_hash = plan.package_hash ?? null;
      current.internal.provider_capability_hash = plan.provider_capability_hash ?? null;
      current.internal.provider_id = plan.provider?.id ?? current.internal.provider_id;
      current.internal.model_id = plan.model?.id ?? null;
      current.internal.surface_id = plan.surface?.id ?? null;
      current.internal.required_transfer_flags = normalizeStrings(plan.transfer_permissions?.required_flags);
      current.internal.transfer_classes = normalizeTransferClasses(plan.transfer_permissions?.classes);
      current.disclosure = buildDisclosure(current);
      current.internal.consent_digest = computeConsentDigest(current);
      await saveOperation(current, context);
    });
  } catch (error) {
    await markFailed(id, context, 'failed', error);
  }
}

async function dispatchOperation(id, context) {
  try {
    const operation = await loadOperation(id, context);
    if (operation.state !== 'dispatching') return;
    const runOptions = {
      plan: operation.internal.plan_path,
      'plan-hash': operation.internal.plan_hash,
      execute: true,
      'artifact-root': artifactRoot(context)
    };
    for (const flag of operation.internal.required_transfer_flags) {
      runOptions[flag] = true;
    }

    const runner = context.runAgenticHumanReviewRun ?? runAgenticHumanReviewRun;
    const result = await runner(runOptions, executionContext(context));
    const execution = result?.data?.agentic_human_review_execution
      ?? result?.data?.agentic_human_review_status
      ?? {};
    const boundary = result?.data?.boundary ?? execution.boundary ?? {};
    const resultPath = artifactPath(result, 'agentic_human_review_advisory')
      ?? execution.result_path
      ?? null;
    if (result?.status === 'ok') {
      await withOperationLock(id, async () => {
        const current = await loadOperation(id, context);
        if (current.state !== 'dispatching') return;
        current.state = 'validating';
        current.updated_at = materializeNow(context.now).toISOString();
        await saveOperation(current, context);
      });
    }
    const safeResult = resultPath
      ? await readSafeAdvisoryProjection(resultPath, context)
      : null;

    await withOperationLock(id, async () => {
      const current = await loadOperation(id, context);
      if (!['dispatching', 'validating'].includes(current.state)) return;
      const now = materializeNow(context.now).toISOString();
      const completed = result?.status === 'ok' && safeResult !== null;
      current.state = completed ? 'completed' : 'failed';
      current.stage = completed ? 'complete' : 'attention';
      current.completed_at = now;
      current.updated_at = now;
      current.dispatch = {
        ...current.dispatch,
        provider_call_performed: boundary.provider_call_performed === true,
        api_call_performed: boundary.api_call_performed === true,
        external_evidence_transfer: boundary.external_evidence_transfer === true,
        retry_automatic: false,
        cancel_available: false
      };
      current.result = safeResult;
      current.error = completed ? null : safeResultError(result, safeResult === null
        ? 'CONTROL_CENTER_AGENTIC_REVIEW_RESULT_UNREADABLE'
        : 'CONTROL_CENTER_AGENTIC_REVIEW_PROVIDER_FAILED');
      current.internal.execution_path = execution.execution_path ?? null;
      current.internal.result_path = resultPath;
      await saveOperation(current, context);
    });
  } catch (error) {
    await markFailed(id, context, 'failed', error);
  }
}

function createOperation({ id, input, now, context, relationship }) {
  const providerId = configuredProvider(context);
  const serviceName = input.ai_suggestions
    ? configuredServiceName(context)
    : 'TraceCue local review';
  return {
    schema_version: CONTROL_CENTER_AGENTIC_REVIEW_SCHEMA_VERSION,
    type: 'control_center_agentic_review_operation',
    id,
    state: 'preparing',
    stage: 'prepare',
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    started_at: null,
    completed_at: null,
    request: {
      purpose: input.purpose,
      effort: input.effort,
      viewport: input.viewport,
      ai_suggestions: input.ai_suggestions
    },
    service: {
      name: serviceName,
      external_ai: input.ai_suggestions
    },
    relationship,
    disclosure: null,
    confirmation: null,
    dispatch: {
      attempt: 0,
      provider_call_performed: false,
      api_call_performed: false,
      external_evidence_transfer: false,
      retry_automatic: false,
      cancel_available: false
    },
    decisions: [],
    result: null,
    error: null,
    internal: {
      target_url: input.url,
      provider_id: providerId,
      model_id: null,
      surface_id: null,
      review_index_path: null,
      proposal_path: null,
      plan_path: null,
      plan_hash: null,
      package_hash: null,
      provider_capability_hash: null,
      required_transfer_flags: [],
      transfer_classes: {},
      consent_digest: null,
      execution_path: null,
      result_path: null,
      credentials_stored: false,
      browser_authority_fields_accepted: false
    },
    boundary: {
      local_control_center: true,
      advisory_only: true,
      gate_effect: 'none',
      credential_values_recorded: false,
      raw_provider_response_stored: false,
      automatic_retry: false,
      cancellation_supported: false
    }
  };
}

function projectOperation(operation) {
  return {
    schema_version: operation.schema_version,
    type: 'control_center_agentic_review',
    id: operation.id,
    state: operation.state,
    stage: publicStage(operation),
    created_at: operation.created_at,
    updated_at: operation.updated_at,
    started_at: operation.started_at,
    completed_at: operation.completed_at,
    target: safeTargetLabel(operation.internal?.target_url),
    purpose: operation.request?.purpose ?? null,
    review_effort: operation.request?.effort ?? null,
    viewport: operation.request?.viewport ?? null,
    ai_suggestions: operation.request?.ai_suggestions === true,
    service: {
      name: operation.service?.name ?? 'Local TraceCue review',
      external_ai: operation.service?.external_ai === true
    },
    parent_review: operation.relationship ? {
      id: operation.relationship.previous_operation_id,
      repeat_mode: operation.relationship.kind
    } : null,
    disclosure: operation.disclosure ? {
      revision: operation.disclosure.revision,
      external_transfer: operation.disclosure.external_transfer === true,
      service_name: operation.disclosure.service_name,
      items: operation.disclosure.items.map((item) => ({
        id: item.id,
        label: item.label,
        sent: item.sent === true
      })),
      raw_provider_response_stored: false,
      credential_values_stored: false
    } : null,
    confirmation: operation.confirmation ? {
      issued: true,
      expires_at: operation.confirmation.expires_at,
      used: Boolean(operation.confirmation.used_at),
      revision: operation.confirmation.revision
    } : null,
    dispatch: {
      attempt: Number(operation.dispatch?.attempt ?? 0),
      provider_call_performed: operation.dispatch?.provider_call_performed === true,
      api_call_performed: operation.dispatch?.api_call_performed === true,
      external_evidence_transfer: operation.dispatch?.external_evidence_transfer === true,
      retry_automatic: false,
      cancel_available: false
    },
    decisions: Array.isArray(operation.decisions) ? operation.decisions : [],
    result: operation.result ?? null,
    error: operation.error ?? null,
    boundary: {
      local_only: true,
      credentials_env_only: true,
      advisory_only: true,
      gate_effect: 'none',
      paths_included: false,
      hashes_included: false,
      commands_included: false,
      raw_bodies_included: false,
      credential_values_included: false,
      raw_provider_response_included: false,
      mcp_execution_exposed: false,
      deterministic_findings_mutated: false,
      release_gate_mutated: false,
      automatic_retry: false,
      cancellation_supported: false
    },
    provider_execution_exposed: operation.request?.ai_suggestions === true,
    external_send_confirmation_required: true
  };
}

function buildTargetManifest(operation) {
  return {
    baseUrl: operation.internal.target_url,
    seeds: [operation.internal.target_url],
    expectedRoutes: [],
    pages: [],
    viewportMatrix: operation.request.viewport === 'both' ? ['desktop', 'mobile'] : [operation.request.viewport],
    scope: { sameOrigin: true },
    actionPolicy: { allow: ['navigation', 'state_revealing'] },
    budgets: { maxRoutes: 1 },
    artifacts: { screenshots: true }
  };
}

function buildDisclosure(operation) {
  const classes = operation.internal.transfer_classes ?? {};
  const items = Object.entries(TRANSFER_LABELS).map(([id, label]) => ({
    id,
    label,
    sent: transferClassEnabled(classes[id], operation.internal.required_transfer_flags, id)
  }));
  const body = {
    version: '1.0.0',
    external_transfer: true,
    service_name: operation.service.name,
    items,
    raw_provider_response_stored: false,
    credential_values_stored: false
  };
  return {
    ...body,
    revision: sha256(canonicalStringify(body)).slice(0, 24)
  };
}

function computeConsentDigest(operation) {
  return sha256(canonicalStringify({
    plan_hash: operation.internal.plan_hash,
    package_hash: operation.internal.package_hash,
    provider_capability_hash: operation.internal.provider_capability_hash,
    provider_id: operation.internal.provider_id,
    model_id: operation.internal.model_id,
    surface_id: operation.internal.surface_id,
    required_transfer_flags: [...operation.internal.required_transfer_flags].sort(),
    transfer_classes: operation.internal.transfer_classes,
    disclosure: operation.disclosure
  }));
}

function validatePrepareInput(input) {
  const url = normalizeReviewUrl(input.url ?? input.target_url ?? input.targetUrl);
  if (!url.ok) return url;
  const purpose = boundedString(input.purpose, CONTROL_CENTER_AGENTIC_REVIEW_PURPOSE_MAX_LENGTH);
  if (!purpose) {
    return validationFailure('CONTROL_CENTER_AGENTIC_REVIEW_PURPOSE_INVALID', `Describe what you want to learn in ${CONTROL_CENTER_AGENTIC_REVIEW_PURPOSE_MAX_LENGTH} characters or fewer.`, {
      max_length: CONTROL_CENTER_AGENTIC_REVIEW_PURPOSE_MAX_LENGTH
    });
  }
  const effort = normalizeChoice(input.effort ?? input.review_effort ?? input.reviewEffort, CONTROL_CENTER_AGENTIC_REVIEW_EFFORTS);
  if (!effort.ok) {
    return validationFailure('CONTROL_CENTER_AGENTIC_REVIEW_EFFORT_INVALID', 'Choose an available review method.', {
      allowed: [...CONTROL_CENTER_AGENTIC_REVIEW_EFFORTS]
    });
  }
  const viewport = normalizeChoice(input.viewport, CONTROL_CENTER_AGENTIC_REVIEW_VIEWPORTS);
  if (!viewport.ok) {
    return validationFailure('CONTROL_CENTER_AGENTIC_REVIEW_VIEWPORT_INVALID', 'Choose desktop or mobile.', {
      allowed: [...CONTROL_CENTER_AGENTIC_REVIEW_VIEWPORTS]
    });
  }
  if ((input.ai_suggestions !== undefined && typeof input.ai_suggestions !== 'boolean')
    || (input.aiSuggestions !== undefined && typeof input.aiSuggestions !== 'boolean')) {
    return validationFailure('CONTROL_CENTER_AGENTIC_REVIEW_AI_SUGGESTIONS_INVALID', 'AI suggestions must be enabled or disabled.', {});
  }
  const aiSuggestions = input.ai_suggestions ?? input.aiSuggestions ?? true;
  return {
    ok: true,
    value: {
      url: url.value,
      purpose,
      effort: effort.value,
      viewport: viewport.value,
      ai_suggestions: aiSuggestions === true
    }
  };
}

function normalizeReviewUrl(value) {
  const raw = boundedString(value, 4096);
  if (!raw) return validationFailure('CONTROL_CENTER_AGENTIC_REVIEW_URL_REQUIRED', 'Enter the page address to review.', {});
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return validationFailure('CONTROL_CENTER_AGENTIC_REVIEW_URL_PROTOCOL_REJECTED', 'The page address must use HTTP or HTTPS.', {});
    }
    if (url.username || url.password) {
      return validationFailure('CONTROL_CENTER_AGENTIC_REVIEW_URL_CREDENTIALS_REJECTED', 'The page address must not contain credentials.', {});
    }
    return { ok: true, value: url.toString() };
  } catch {
    return validationFailure('CONTROL_CENTER_AGENTIC_REVIEW_URL_INVALID', 'Enter a valid absolute page address.', {});
  }
}

async function readSafeAdvisoryProjection(relativePath, context) {
  try {
    const file = workspaceFile(relativePath, context);
    const raw = await readFile(file, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > MAX_OPERATION_BYTES * 4) return null;
    const value = JSON.parse(raw);
    const summary = value.non_engineer_summary ?? {};
    const findings = Array.isArray(value.agentic_human_review_findings)
      ? value.agentic_human_review_findings
      : [];
    const decisions = Array.isArray(value.owner_decision_requests)
      ? value.owner_decision_requests
      : [];
    const fixes = value.agentic_human_review_action_plan?.suggested_fixes
      ?? value.agentic_human_review_action_plan?.next_actions
      ?? [];
    return {
      kind: 'external_ai_review',
      status: value.agentic_human_review_advisory?.status ?? 'completed',
      main_takeaway: safeText(summary.main_takeaway, 1200),
      likely_first_impression: safeText(summary.likely_first_impression, 900),
      top_concerns: safeStringList(summary.top_concerns, 8, 500),
      top_strengths: safeStringList(summary.top_strengths, 8, 500),
      suggested_fixes: safeStringList(fixes, 12, 500),
      owner_decisions_needed: safeStringList(summary.owner_decisions_needed, 8, 500),
      findings: findings.slice(0, 100).map(projectFinding).filter(Boolean),
      finding_count: findings.length,
      owner_decision_count: decisions.length,
      advisory_only: true,
      gate_effect: 'none'
    };
  } catch {
    return null;
  }
}

function projectLocalReview(review) {
  const findings = Array.isArray(review?.data?.findings) ? review.data.findings : [];
  return {
    kind: 'local_review',
    status: 'completed',
    finding_count: findings.length,
    owner_decision_count: 0,
    findings: findings.slice(0, 100).map(projectFinding).filter(Boolean),
    top_concerns: findings.slice(0, 8).map((finding) => safeText(
      finding.title ?? finding.message ?? finding.summary ?? finding.type,
      500
    )).filter(Boolean),
    advisory_only: true,
    gate_effect: 'none'
  };
}

async function markFailed(id, context, state, error) {
  try {
    await withOperationLock(id, async () => {
      const operation = await loadOperation(id, context);
      const now = materializeNow(context.now).toISOString();
      operation.state = state;
      operation.stage = 'attention';
      operation.completed_at = now;
      operation.updated_at = now;
      operation.error = {
        code: error?.code ?? 'CONTROL_CENTER_AGENTIC_REVIEW_FAILED',
        message: publicFailureMessage(error?.code)
      };
      await saveOperation(operation, context);
    });
  } catch {
    // The original failure remains authoritative when the local state cannot be updated.
  }
}

async function loadOperationResult(id, context, options = {}) {
  try {
    const operation = await loadOperation(id, context);
    if (options.recoverDispatch && operation.state === 'dispatching' && !ACTIVE_DISPATCHES.has(id)) {
      operation.state = 'dispatch_unknown';
      operation.stage = 'attention';
      operation.updated_at = materializeNow(context.now).toISOString();
      operation.error = {
        code: 'CONTROL_CENTER_AGENTIC_REVIEW_DISPATCH_UNKNOWN',
        message: 'TraceCue cannot confirm whether the external AI review finished. It will not retry automatically.'
      };
      await saveOperation(operation, context);
    }
    return { ok: true, operation };
  } catch (error) {
    if (options.suppressNotFound && error?.code === 'ENOENT') return { ok: false, suppressed: true };
    return {
      ok: false,
      result: actionError(
        error?.code === 'ENOENT'
          ? 'CONTROL_CENTER_AGENTIC_REVIEW_NOT_FOUND'
          : 'CONTROL_CENTER_AGENTIC_REVIEW_READ_FAILED',
        error?.code === 'ENOENT'
          ? 'The requested review was not found.'
          : 'The local review state could not be read.',
        {}
      )
    };
  }
}

async function loadOperation(id, context) {
  const raw = await readFile(operationFile(id, context), 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > MAX_OPERATION_BYTES) {
    throw codedError('CONTROL_CENTER_AGENTIC_REVIEW_OPERATION_TOO_LARGE', 'The local review state is too large.');
  }
  const operation = JSON.parse(raw);
  if (operation?.type !== 'control_center_agentic_review_operation' || operation?.id !== id) {
    throw codedError('CONTROL_CENTER_AGENTIC_REVIEW_OPERATION_INVALID', 'The local review state is invalid.');
  }
  return operation;
}

async function saveOperation(operation, context) {
  const directory = path.dirname(operationFile(operation.id, context));
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, OPERATION_FILE);
  const temporary = path.join(directory, `.${OPERATION_FILE}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(operation, null, 2)}\n`, 'utf8');
  await rename(temporary, target);
}

function operationFile(id, context) {
  return path.join(operationsRoot(context), id, OPERATION_FILE);
}

function operationsRoot(context) {
  return path.join(path.resolve(context.cwd ?? process.cwd()), artifactRoot(context), CONTROL_CENTER_AGENTIC_REVIEW_ARTIFACT_DIR);
}

function workspaceFile(relativePath, context) {
  if (!relativePath || path.isAbsolute(relativePath)) throw codedError('CONTROL_CENTER_AGENTIC_REVIEW_PATH_INVALID', 'Internal artifact path is invalid.');
  const cwd = path.resolve(context.cwd ?? process.cwd());
  const target = path.resolve(cwd, relativePath);
  if (target !== cwd && !target.startsWith(`${cwd}${path.sep}`)) {
    throw codedError('CONTROL_CENTER_AGENTIC_REVIEW_PATH_INVALID', 'Internal artifact path escaped the workspace.');
  }
  return target;
}

function artifactRoot(context) {
  const configured = boundedString(context.artifactRoot, 1024);
  if (!configured) return DEFAULT_ARTIFACT_ROOT;
  const cwd = path.resolve(context.cwd ?? process.cwd());
  const absolute = path.resolve(cwd, configured);
  const relative = path.relative(cwd, absolute);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative
    : DEFAULT_ARTIFACT_ROOT;
}

function executionContext(context) {
  return {
    ...context,
    cwd: path.resolve(context.cwd ?? process.cwd())
  };
}

function scheduleBackground(id, context, task) {
  ACTIVE_DISPATCHES.add(id);
  const run = async () => {
    try {
      await task();
    } finally {
      ACTIVE_DISPATCHES.delete(id);
    }
  };
  try {
    if (typeof context.scheduleBackground === 'function') {
      context.scheduleBackground(run);
    } else {
      setImmediate(() => { void run(); });
    }
  } catch {
    setImmediate(() => { void run(); });
  }
}

async function withOperationLock(id, task) {
  const previous = OPERATION_LOCKS.get(id) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  OPERATION_LOCKS.set(id, current);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (OPERATION_LOCKS.get(id) === current) OPERATION_LOCKS.delete(id);
  }
}

function configuredProvider(context) {
  const env = context.env ?? process.env;
  return boundedString(
    context.agenticReviewProviderId
      ?? context.controlCenterAgenticReviewProvider
      ?? env[CONTROL_CENTER_AGENTIC_REVIEW_PROVIDER_ENV]
      ?? 'generic-api-provider',
    160
  ) ?? 'generic-api-provider';
}

function configuredServiceName(context) {
  const env = context.env ?? process.env;
  return boundedString(
    context.agenticReviewServiceName
      ?? context.controlCenterAgenticReviewServiceName
      ?? env[CONTROL_CENTER_AGENTIC_REVIEW_SERVICE_NAME_ENV],
    160
  );
}

function findBrowserAuthorityFields(input) {
  const forbidden = new Set([
    'provider', 'provider_id', 'providerId', 'model', 'model_id', 'modelId',
    'plan', 'plan_path', 'planPath', 'plan_hash', 'planHash', 'package_hash', 'packageHash',
    'surface', 'surface_id', 'surfaceId', 'transfer_flags', 'transferFlags', 'flags',
    'endpoint', 'credential', 'token', 'api_key', 'apiKey', 'artifact_root', 'artifactRoot',
    'execute', 'execution_mode', 'executionMode'
  ]);
  return Object.keys(input).filter((key) => forbidden.has(key) || key.startsWith('allow-')).sort();
}

function normalizeOperationId(value) {
  const id = boundedString(value, 220);
  if (!id || !OPERATION_ID_PATTERN.test(id)) {
    return validationFailure('CONTROL_CENTER_AGENTIC_REVIEW_ID_INVALID', 'A valid review id is required.', {});
  }
  return { ok: true, value: id };
}

function normalizeChoice(value, allowed) {
  const normalized = boundedString(value, 160);
  return normalized && allowed.includes(normalized)
    ? { ok: true, value: normalized }
    : { ok: false };
}

function normalizeLimit(value) {
  if (value === undefined || value === null || value === '') return { ok: true, value: 20 };
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > MAX_LIST_LIMIT) {
    return validationFailure('CONTROL_CENTER_AGENTIC_REVIEW_LIMIT_INVALID', `List limit must be between 1 and ${MAX_LIST_LIMIT}.`, {
      min: 1,
      max: MAX_LIST_LIMIT
    });
  }
  return { ok: true, value: number };
}

function normalizeRelationship(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const kind = CONTROL_CENTER_AGENTIC_REVIEW_REPEAT_MODES.includes(value.kind) ? value.kind : null;
  const previous = normalizeOperationId(value.previous_operation_id ?? value.previousOperationId);
  return kind && previous.ok ? { kind, previous_operation_id: previous.value } : null;
}

function createOperationId(context, now) {
  const supplied = context.createId?.('control-center-agentic-review', now);
  if (typeof supplied === 'string' && OPERATION_ID_PATTERN.test(supplied)) return supplied;
  return `control-center-agentic-review-${now.toISOString().replace(/[:.]/gu, '-')}-${randomUUID().slice(0, 8)}`;
}

function nextEffort(current) {
  const index = CONTROL_CENTER_AGENTIC_REVIEW_EFFORTS.indexOf(current);
  return index >= 0 && index < CONTROL_CENTER_AGENTIC_REVIEW_EFFORTS.length - 1
    ? CONTROL_CENTER_AGENTIC_REVIEW_EFFORTS[index + 1]
    : null;
}

function normalizeTransferClasses(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.keys(TRANSFER_LABELS).map((key) => [key, {
    included: value[key]?.included === true,
    required_for_execution: value[key]?.required_for_execution === true
  }]));
}

function transferClassEnabled(value, requiredFlags, id) {
  if (value?.included === true || value?.required_for_execution === true) return true;
  return requiredFlags.includes(`allow-${id.replaceAll('_', '-')}`);
}

function artifactPath(result, type) {
  const artifact = Array.isArray(result?.artifacts)
    ? result.artifacts.find((candidate) => candidate?.type === type)
    : null;
  return typeof artifact?.path === 'string' ? artifact.path : null;
}

function safeResultError(result, fallbackCode) {
  const error = Array.isArray(result?.errors) ? result.errors[0] : null;
  const code = boundedString(error?.code, 160) ?? fallbackCode;
  return {
    code,
    message: publicFailureMessage(code)
  };
}

function publicFailureMessage(code) {
  const value = String(code ?? '');
  if (/BROWSER|REVIEW_INDEX|TARGET|URL/u.test(value)) {
    return 'TraceCue could not finish checking the page. Confirm that the page is available and try a new review.';
  }
  if (/PLAN|PROPOSAL|DISCLOSURE|TRANSFER|CAPABILITY/u.test(value)) {
    return 'The prepared review changed or could not be verified. Prepare a new review before sending anything.';
  }
  if (/TIMEOUT/u.test(value)) {
    return 'The AI service did not answer in time. Check the operation status before deciding what to do next.';
  }
  if (/CREDENTIAL|ENDPOINT|PROVIDER|API|MODEL/u.test(value)) {
    return 'TraceCue could not connect to the configured AI service. Check the service setup and prepare a new review.';
  }
  return 'The review did not complete. TraceCue will not retry or send it again automatically.';
}

function publicStage(operation) {
  if (operation.state === 'completed') {
    const findingIds = new Set(
      (Array.isArray(operation.result?.findings) ? operation.result.findings : [])
        .map((finding) => finding.id)
        .filter(Boolean)
    );
    if (findingIds.size === 0) return 'complete';
    const decidedIds = new Set(
      (Array.isArray(operation.decisions) ? operation.decisions : [])
        .map((decision) => decision.finding_id)
        .filter((id) => findingIds.has(id))
    );
    return decidedIds.size >= findingIds.size ? 'complete' : 'decide';
  }
  if (operation.relationship?.kind === 'recheck') return 'recheck';
  if (operation.state === 'preparing') return 'prepare';
  return 'review';
}

function projectFinding(finding) {
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) return null;
  const message = safeText(
    finding.message ?? finding.title ?? finding.summary ?? finding.description,
    800
  );
  if (!message) return null;
  const suppliedId = boundedString(finding.id, 220);
  const id = suppliedId ?? `finding-${sha256(canonicalStringify({
    message,
    severity: finding.severity ?? null,
    recommendation: finding.recommendation ?? finding.suggested_fix ?? null
  })).slice(0, 20)}`;
  return {
    id,
    message,
    recommendation: safeText(
      finding.recommendation
        ?? finding.suggested_fix
        ?? finding.remediation
        ?? finding.action,
      800
    ),
    severity: safeText(finding.severity, 80),
    impact: safeText(finding.impact, 800),
    reason: safeText(finding.reason, 800)
  };
}

function resultFailure(code, result) {
  const error = Array.isArray(result?.errors) ? result.errors[0] : null;
  return codedError(error?.code ?? code, error?.message ?? 'The review step did not complete.');
}

function safeTargetLabel(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

function safeStringList(value, limit, maxLength) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, limit).map((item) => safeText(item, maxLength)).filter(Boolean);
}

function safeText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function boundedString(value, maxLength) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

function normalizeStrings(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === 'string' && item.length <= 160))].sort();
}

function canonicalStringify(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function materializeNow(value) {
  if (typeof value === 'function') return materializeNow(value());
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validationFailure(code, message, details) {
  return { ok: false, code, message, details };
}

function actionOk(data) {
  return {
    status: 'ok',
    data: {
      control_center_agentic_review: data,
      boundary: {
        advisory_only: true,
        gate_effect: 'none',
        credential_values_recorded: false,
        raw_provider_response_stored: false
      }
    },
    warnings: [],
    errors: [],
    artifacts: []
  };
}

function actionError(code, message, details = {}) {
  return {
    status: 'error',
    data: {
      control_center_agentic_review: null,
      boundary: {
        advisory_only: true,
        gate_effect: 'none',
        credential_values_recorded: false,
        raw_provider_response_stored: false
      }
    },
    warnings: [],
    errors: [{ code, message, details }],
    artifacts: []
  };
}
