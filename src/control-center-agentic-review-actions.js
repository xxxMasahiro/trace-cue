import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  runAgenticHumanReviewPlan,
  runAgenticHumanReviewPropose,
  runAgenticHumanReviewRun
} from './agentic-human-review.js';
import { runReview } from './review.js';
import { getSchema } from './schema-registry.js';
import {
  buildControlCenterAiDestinationFingerprint,
  buildControlCenterAiReadiness
} from './control-center-ai-readiness.js';
import {
  CONTROL_CENTER_AGENTIC_REVIEW_PROVIDER_ENV,
  CONTROL_CENTER_AGENTIC_REVIEW_SERVICE_NAME_ENV
} from './control-center-agentic-review-config.js';
import {
  captureProcessIdentity,
  createSafeLocalStore,
  isProcessIdentityAlive,
  readStableBoundedFileHandle
} from './safe-local-store.js';

export const CONTROL_CENTER_AGENTIC_REVIEW_SCHEMA_VERSION = '1.0.0';
export const CONTROL_CENTER_AGENTIC_REVIEW_ARTIFACT_DIR = 'control-center-agentic-reviews';
export {
  CONTROL_CENTER_AGENTIC_REVIEW_PROVIDER_ENV,
  CONTROL_CENTER_AGENTIC_REVIEW_SERVICE_NAME_ENV
} from './control-center-agentic-review-config.js';
export const CONTROL_CENTER_AGENTIC_REVIEW_PURPOSE_MAX_LENGTH = 1200;
export const CONTROL_CENTER_AGENTIC_REVIEW_ENDPOINTS = Object.freeze({
  prepare: '/api/agentic-review/prepare',
  confirmation: '/api/agentic-review/confirmation',
  start: '/api/agentic-review/start',
  status: '/api/agentic-review/status',
  decision: '/api/agentic-review/decision',
  repeat: '/api/agentic-review/repeat',
  recover: '/api/agentic-review/recover',
  resume: '/api/agentic-review/resume',
  cancel: '/api/agentic-review/cancel',
  list: '/api/agentic-review/list'
});
export const CONTROL_CENTER_AGENTIC_REVIEW_EFFORTS = Object.freeze(['standard', 'deep', 'xhigh']);
export const CONTROL_CENTER_AGENTIC_REVIEW_VIEWPORTS = Object.freeze(['desktop', 'mobile', 'both']);
export const CONTROL_CENTER_AGENTIC_REVIEW_DECISIONS = Object.freeze(['fix', 'later', 'ask']);
export const CONTROL_CENTER_AGENTIC_REVIEW_REPEAT_MODES = Object.freeze(['deeper', 'recheck']);
export const CONTROL_CENTER_AGENTIC_REVIEW_HISTORY_ENTRIES = 1000;
export const CONTROL_CENTER_AGENTIC_REVIEW_ACTIVE_ENTRIES = 4032;

const DEFAULT_ARTIFACT_ROOT = '.browser-debug';
const OPERATION_FILE = 'operation.json';
const MAX_OPERATION_BYTES = 1024 * 1024;
const CONFIRMATION_TTL_MS = 15 * 60 * 1000;
const MAX_LIST_LIMIT = 100;
const MAX_OPERATION_STORE_ENTRIES = 4096;
const DEFAULT_HISTORY_MAINTENANCE_LOCK_TIMEOUT_MS = 100;
const MAX_HISTORY_MAINTENANCE_LOCK_TIMEOUT_MS = 1000;
const HISTORY_MAINTENANCE_RETRY_LIMIT = 4;
const HISTORY_MAINTENANCE_RETRY_DELAY_MS = 25;
const LIST_READ_RETRY_LIMIT = 4;
const LIST_READ_RETRY_DELAY_MS = 10;
const DEFAULT_OPERATION_LOCK_TIMEOUT_MS = 10_000;
const MAX_OPERATION_LOCK_TIMEOUT_MS = 120_000;
const HISTORY_ELIGIBLE_STATES = new Set(['completed', 'failed', 'cancelled']);
const OPERATION_ID_PATTERN = /^control-center-agentic-review-[a-zA-Z0-9._-]{1,160}$/;
const ACTIVE_DISPATCHES = new Set();
const OPERATION_HISTORY_RETENTION = new Map();

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
  if (validation.value.ai_suggestions && buildControlCenterAiReadiness(context).status !== 'available') {
    return actionError('CONTROL_CENTER_AGENTIC_REVIEW_SETUP_NOT_READY', 'Finish the private AI connection setup, or continue without AI.', {});
  }

  const now = materializeNow(context.now);
  const operation = await createOperation({
    id: createOperationId(context, now),
    input: validation.value,
    now,
    context,
    relationship: normalizeRelationship(input.relationship)
  });

  try {
    await saveNewOperation(operation, context);
  } catch (error) {
    if (error?.code === 'CONTROL_CENTER_AGENTIC_REVIEW_CAPACITY_REACHED') {
      return actionError(error.code, 'Finish or remove an older review before starting another one.', {});
    }
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

  return withOperationLock(id.value, context, async () => {
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

  const prepared = await withOperationLock(id.value, context, async () => {
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
    if (buildControlCenterAiDestinationFingerprint(context, {
      providerId: operation.internal.provider_id,
      serviceName: operation.service.name,
      modelId: operation.internal.model_id
    }) !== operation.internal.destination_fingerprint) {
      return actionError('CONTROL_CENTER_AGENTIC_REVIEW_DESTINATION_CHANGED', 'The AI review connection changed. Review the current send details again.', {});
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
      cancel_available: false,
      owner: {
        pid: process.pid,
        process_identity: await captureProcessIdentity(process.pid)
      }
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
  const loaded = await loadOperationResult(id.value, context);
  if (!loaded.ok) return loaded.result;
  return actionOk({ operation: projectOperation(loaded.operation) });
}

export async function runControlCenterAgenticReviewRecover(input = {}, context = {}) {
  const id = normalizeOperationId(input.operation_id ?? input.operationId ?? input.id);
  if (!id.ok) return actionError(id.code, id.message, id.details);
  const loaded = await loadOperationResult(id.value, context, { recoverDispatch: true });
  if (!loaded.ok) return loaded.result;
  return actionOk({ operation: projectOperation(loaded.operation) });
}

export async function runControlCenterAgenticReviewResume(input = {}, context = {}) {
  const id = normalizeOperationId(input.operation_id ?? input.operationId ?? input.id);
  if (!id.ok) return actionError(id.code, id.message, id.details);
  const prepared = await withOperationLock(id.value, context, async () => {
    const loaded = await loadOperationResult(id.value, context);
    if (!loaded.ok) return loaded.result;
    const operation = loaded.operation;
    if (operation.state !== 'preparing' || await isProcessIdentityAlive(operation.preparation?.owner)) {
      return actionError('CONTROL_CENTER_AGENTIC_REVIEW_RESUME_NOT_AVAILABLE', 'This review preparation is not waiting to be resumed.', {
        state: operation.state
      });
    }
    operation.preparation = {
      attempt: Number(operation.preparation?.attempt ?? 0) + 1,
      owner: await currentProcessOwner()
    };
    operation.updated_at = materializeNow(context.now).toISOString();
    await saveOperation(operation, context);
    return actionOk({ operation: projectOperation(operation), accepted: true });
  });
  if (prepared.status !== 'ok') return prepared;
  scheduleBackground(id.value, context, async () => prepareOperation(id.value, context));
  return prepared;
}

export async function runControlCenterAgenticReviewCancel(input = {}, context = {}) {
  const id = normalizeOperationId(input.operation_id ?? input.operationId ?? input.id);
  if (!id.ok) return actionError(id.code, id.message, id.details);
  return withOperationLock(id.value, context, async () => {
    const loaded = await loadOperationResult(id.value, context);
    if (!loaded.ok) return loaded.result;
    const operation = loaded.operation;
    if (operation.state !== 'confirmation_required') {
      return actionError('CONTROL_CENTER_AGENTIC_REVIEW_CANCEL_NOT_AVAILABLE', 'This review can no longer be safely cancelled.', {
        state: operation.state
      });
    }
    const now = materializeNow(context.now).toISOString();
    operation.state = 'cancelled';
    operation.stage = 'attention';
    operation.updated_at = now;
    operation.completed_at = now;
    operation.confirmation = null;
    operation.error = null;
    await saveOperation(operation, context);
    return actionOk({ operation: projectOperation(operation) });
  });
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

  return withOperationLock(id.value, context, async () => {
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
  let entries = [];
  try {
    entries = await operationStore(context).listDirectories({ limit: MAX_OPERATION_STORE_ENTRIES });
  } catch (error) {
    if (error?.code === 'ENOENT') return actionOk({ operations: [], count: 0 });
    return actionError('CONTROL_CENTER_AGENTIC_REVIEW_LIST_FAILED', 'The local review list could not be read.', {});
  }

  const operations = [];
  for (const entry of entries) {
    if (!OPERATION_ID_PATTERN.test(entry)) continue;
    const loaded = await loadListedOperationResult(entry, context);
    if (!loaded.ok) {
      return actionError('CONTROL_CENTER_AGENTIC_REVIEW_LIST_FAILED', 'The local review list could not be read completely.', {});
    }
    operations.push(loaded.operation);
  }
  operations.sort((left, right) => String(right.updated_at ?? right.created_at).localeCompare(
    String(left.updated_at ?? left.created_at)
  ) || String(right.id).localeCompare(String(left.id)));
  return actionOk({
    operations: operations.slice(0, limit.value).map(projectOperation),
    count: Math.min(operations.length, limit.value),
    total: operations.length
  });
}

async function loadListedOperationResult(id, context) {
  let loaded;
  for (let attempt = 0; attempt < LIST_READ_RETRY_LIMIT; attempt += 1) {
    loaded = await loadOperationResult(id, context, { suppressTransientRead: true });
    if (loaded.ok || !loaded.suppressed) return loaded;
    if (attempt + 1 < LIST_READ_RETRY_LIMIT) {
      await new Promise((resolve) => setTimeout(resolve, LIST_READ_RETRY_DELAY_MS));
    }
  }
  return loaded;
}

async function prepareOperation(id, context) {
  await withOperationLock(id, context, async () => {
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
      await withOperationLock(id, context, async () => {
        const current = await loadOperation(id, context);
        if (current.state !== 'preparing') return;
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

    await withOperationLock(id, context, async () => {
      const current = await loadOperation(id, context);
      if (current.state !== 'preparing') return;
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

    await withOperationLock(id, context, async () => {
      const current = await loadOperation(id, context);
      if (current.state !== 'preparing') return;
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
      current.internal.destination_fingerprint = buildControlCenterAiDestinationFingerprint(context, {
        providerId: current.internal.provider_id,
        serviceName: current.service.name,
        modelId: current.internal.model_id
      });
      current.disclosure = buildDisclosure(current);
      current.internal.consent_digest = computeConsentDigest(current);
      await saveOperation(current, context);
    });
  } catch (error) {
    await markFailed(id, context, 'failed', error);
  }
}

async function dispatchOperation(id, context) {
  let transferMayHaveOccurred = false;
  let runnerStarted = false;
  let observedBoundary = null;
  let observedExecution = null;
  let observedResultPath = null;
  let validationCheckpointSaved = false;
  try {
    const operation = await loadOperation(id, context);
    if (operation.state !== 'dispatching') return;
    if (buildControlCenterAiDestinationFingerprint(context, {
      providerId: operation.internal.provider_id,
      serviceName: operation.service.name,
      modelId: operation.internal.model_id
    }) !== operation.internal.destination_fingerprint) {
      throw codedError('CONTROL_CENTER_AGENTIC_REVIEW_DESTINATION_CHANGED', 'The AI review connection changed before dispatch.');
    }
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
    runnerStarted = true;
    const result = await runner(runOptions, executionContext(context));
    const execution = result?.data?.agentic_human_review_execution
      ?? result?.data?.agentic_human_review_status
      ?? {};
    const boundary = result?.data?.boundary ?? execution.boundary ?? {};
    observedBoundary = normalizeObservedDispatchBoundary(boundary);
    observedExecution = execution;
    transferMayHaveOccurred = boundary.provider_call_performed === true
      || boundary.api_call_performed === true
      || boundary.external_evidence_transfer === true;
    const noTransferAttested = boundary.provider_call_performed === false
      && boundary.api_call_performed === false
      && boundary.external_evidence_transfer === false;
    const resultPath = artifactPath(result, 'agentic_human_review_advisory')
      ?? execution.result_path
      ?? null;
    observedResultPath = resultPath;
    if (result?.status !== 'ok') {
      await withOperationLock(id, context, async () => {
        const current = await loadOperation(id, context);
        if (current.state !== 'dispatching') return;
        const now = materializeNow(context.now).toISOString();
        const dispatchStateUnknown = transferMayHaveOccurred || !noTransferAttested;
        current.state = dispatchStateUnknown ? 'dispatch_unknown' : 'failed';
        current.stage = 'attention';
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
        current.internal.execution_path = execution.execution_path ?? null;
        current.internal.result_path = resultPath;
        current.error = safeResultError(result, dispatchStateUnknown
          ? 'CONTROL_CENTER_AGENTIC_REVIEW_PROVIDER_STATE_UNKNOWN'
          : 'CONTROL_CENTER_AGENTIC_REVIEW_NOT_SENT');
        await saveOperation(current, context);
      });
      return;
    }

    if (!resultPath) {
      throw codedError('CONTROL_CENTER_AGENTIC_REVIEW_RESULT_UNREADABLE', 'The saved AI result could not be found.');
    }
    const verified = await readVerifiedAdvisoryProjection(resultPath, operation, boundary, context);
    await withOperationLock(id, context, async () => {
      const current = await loadOperation(id, context);
      if (current.state !== 'dispatching') return;
      current.state = 'validating';
      current.updated_at = materializeNow(context.now).toISOString();
      current.internal.execution_path = execution.execution_path ?? null;
      current.internal.result_path = resultPath;
      current.internal.result_sha256 = verified.digest;
      current.dispatch = mergeObservedDispatchBoundary(current.dispatch, observedBoundary);
      await saveOperation(current, context);
    });
    validationCheckpointSaved = true;

    await withOperationLock(id, context, async () => {
      const current = await loadOperation(id, context);
      if (current.state !== 'validating' || current.internal.result_sha256 !== verified.digest) return;
      const now = materializeNow(context.now).toISOString();
      current.state = 'completed';
      current.stage = 'complete';
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
      current.result = verified.projection;
      current.error = null;
      current.internal.execution_path = execution.execution_path ?? null;
      current.internal.result_path = resultPath;
      await saveOperation(current, context);
    });
  } catch (error) {
    if (validationCheckpointSaved) return;
    await markFailed(
      id,
      context,
      runnerStarted || transferMayHaveOccurred ? 'dispatch_unknown' : 'failed',
      error,
      {
        boundary: observedBoundary,
        execution: observedExecution,
        resultPath: observedResultPath
      }
    );
  }
}

async function createOperation({ id, input, now, context, relationship }) {
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
    preparation: {
      attempt: 1,
      owner: await currentProcessOwner()
    },
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
      destination_fingerprint: input.ai_suggestions
        ? buildControlCenterAiDestinationFingerprint(context, { providerId, serviceName })
        : null,
      execution_path: null,
      result_path: null,
      result_sha256: null,
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
    recovery: recoveryProjection(operation),
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
    destination_fingerprint: operation.internal.destination_fingerprint,
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

async function readVerifiedAdvisoryProjection(relativePath, operation, executionBoundary, context, expectedDigest = null) {
  try {
    const body = await readSafeResultFile(relativePath, context);
    const digest = createHash('sha256').update(body).digest('hex');
    if (expectedDigest && digest !== expectedDigest) {
      throw codedError('CONTROL_CENTER_AGENTIC_REVIEW_VALIDATION_EVIDENCE_INVALID', 'The saved AI result changed after dispatch.');
    }
    const raw = body.toString('utf8');
    const value = JSON.parse(raw);
    validateAdvisoryIdentity(value, relativePath, operation, executionBoundary);
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
    return { digest, projection: {
      kind: 'external_ai_review',
      status: value.agentic_human_review_advisory.status,
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
    } };
  } catch (error) {
    if (error?.code) throw error;
    throw codedError('CONTROL_CENTER_AGENTIC_REVIEW_RESULT_INVALID', 'The saved AI result did not match the approved review contract.');
  }
}

function validateAdvisoryIdentity(value, relativePath, operation, executionBoundary) {
  const schema = getSchema('agentic_human_review_advisory');
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || schema.required.some((field) => !Object.prototype.hasOwnProperty.call(value, field))
    || value.result_type !== schema.properties.result_type.const) {
    throw codedError('CONTROL_CENTER_AGENTIC_REVIEW_RESULT_SCHEMA_INVALID', 'The saved AI result is not a complete TraceCue advisory.');
  }
  for (const field of schema.required) {
    const expectedType = schema.properties[field]?.type;
    if (expectedType === 'object' && (!value[field] || typeof value[field] !== 'object' || Array.isArray(value[field]))) {
      throw codedError('CONTROL_CENTER_AGENTIC_REVIEW_RESULT_SCHEMA_INVALID', 'The saved AI result has an invalid required section.');
    }
    if (expectedType === 'array' && !Array.isArray(value[field])) {
      throw codedError('CONTROL_CENTER_AGENTIC_REVIEW_RESULT_SCHEMA_INVALID', 'The saved AI result has an invalid required list.');
    }
    if (expectedType === 'string' && typeof value[field] !== 'string') {
      throw codedError('CONTROL_CENTER_AGENTIC_REVIEW_RESULT_SCHEMA_INVALID', 'The saved AI result has an invalid required identity.');
    }
  }
  const advisory = value.agentic_human_review_advisory;
  const readiness = value.agentic_human_review_readiness;
  const requiredFlags = new Set(normalizeStrings(value.transfer_permissions?.required_flags));
  const validStatus = ['completed', 'owner_review_recommended'].includes(advisory.status);
  const boundaryMatches = value.execution?.provider_call_performed === (executionBoundary.provider_call_performed === true)
    && value.execution?.api_call_performed === (executionBoundary.api_call_performed === true)
    && value.execution?.external_evidence_transfer === (executionBoundary.external_evidence_transfer === true);
  if (!validStatus
    || value.id !== advisory.id
    || advisory.plan_hash !== operation.internal.plan_hash
    || advisory.plan_path !== operation.internal.plan_path
    || value.provider?.id !== operation.internal.provider_id
    || (operation.internal.model_id && value.model?.id !== operation.internal.model_id)
    || value.execution?.result_path !== relativePath
    || operation.internal.required_transfer_flags.some((flag) => !requiredFlags.has(flag))
    || readiness?.advisory_only !== true
    || readiness?.gate_effect !== 'none'
    || advisory.gate_effect !== 'none'
    || !boundaryMatches) {
    throw codedError('CONTROL_CENTER_AGENTIC_REVIEW_RESULT_IDENTITY_MISMATCH', 'The saved AI result does not match the approved plan and execution.');
  }
}

async function readSafeResultFile(relativePath, context) {
  const cwd = path.resolve(context.cwd ?? process.cwd());
  const root = path.resolve(cwd, artifactRoot(context));
  const target = workspaceFile(relativePath, context);
  if (!isPathInside(root, target)) {
    throw codedError('CONTROL_CENTER_AGENTIC_REVIEW_RESULT_PATH_REJECTED', 'The saved AI result is outside the private artifact location.');
  }
  await rejectResultSymlinkComponents(cwd, path.dirname(path.relative(cwd, target)));
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw codedError('CONTROL_CENTER_AGENTIC_REVIEW_RESULT_ROOT_REJECTED', 'The private artifact location is unsafe.');
  }
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw codedError('CONTROL_CENTER_AGENTIC_REVIEW_RESULT_FILE_REJECTED', 'The saved AI result is not a private regular file.');
  }
  if (info.size > MAX_OPERATION_BYTES * 4) {
    throw codedError('CONTROL_CENTER_AGENTIC_REVIEW_RESULT_TOO_LARGE', 'The local AI review result is too large.');
  }
  const [rootReal, targetReal] = await Promise.all([realpath(root), realpath(target)]);
  if (!isPathInside(rootReal, targetReal)) {
    throw codedError('CONTROL_CENTER_AGENTIC_REVIEW_RESULT_PATH_REJECTED', 'The saved AI result escaped the private artifact location.');
  }
  const handle = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    return await readStableBoundedFileHandle(handle, {
      expected: info,
      maxBytes: MAX_OPERATION_BYTES * 4,
      changedError: () => codedError(
        'CONTROL_CENTER_AGENTIC_REVIEW_RESULT_CHANGED',
        'The saved AI result changed while it was read.'
      )
    });
  } finally {
    await handle.close();
  }
}

async function rejectResultSymlinkComponents(root, relativeDirectory) {
  let current = root;
  for (const segment of relativeDirectory.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw codedError('CONTROL_CENTER_AGENTIC_REVIEW_RESULT_PATH_REJECTED', 'The saved AI result path is unsafe.');
    }
  }
}

function isPathInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
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

async function markFailed(id, context, state, error, observation = {}) {
  try {
    await withOperationLock(id, context, async () => {
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
      if (observation.boundary) {
        operation.dispatch = {
          ...operation.dispatch,
          provider_call_performed: operation.dispatch?.provider_call_performed === true
            || observation.boundary.provider_call_performed === true,
          api_call_performed: operation.dispatch?.api_call_performed === true
            || observation.boundary.api_call_performed === true,
          external_evidence_transfer: operation.dispatch?.external_evidence_transfer === true
            || observation.boundary.external_evidence_transfer === true,
          retry_automatic: false,
          cancel_available: false
        };
      }
      if (observation.execution && typeof observation.execution === 'object') {
        operation.internal.execution_path = observation.execution.execution_path ?? operation.internal.execution_path ?? null;
      }
      if (observation.resultPath) operation.internal.result_path = observation.resultPath;
      await saveOperation(operation, context);
    });
  } catch {
    // The original failure remains authoritative when the local state cannot be updated.
  }
}

async function loadOperationResult(id, context, options = {}) {
  try {
    const operation = await loadOperation(id, context);
    const ownerAlive = await isProcessIdentityAlive(operation.dispatch?.owner);
    const dispatchOwnerIsCurrentProcess = await isCurrentProcessOwner(operation.dispatch?.owner);
    if (options.recoverDispatch && operation.state === 'dispatching'
      && !ACTIVE_DISPATCHES.has(id) && (!ownerAlive || dispatchOwnerIsCurrentProcess)) {
      return {
        ok: true,
        operation: await withOperationLock(id, context, async () => {
          const current = await loadOperation(id, context);
          if (current.state !== 'dispatching') return current;
          current.state = 'dispatch_unknown';
          current.stage = 'attention';
          current.updated_at = materializeNow(context.now).toISOString();
          current.error = {
            code: 'CONTROL_CENTER_AGENTIC_REVIEW_DISPATCH_UNKNOWN',
            message: 'TraceCue cannot confirm whether the external AI review finished. It will not retry automatically.'
          };
          await saveOperation(current, context);
          return current;
        })
      };
    }
    if (options.recoverDispatch && operation.state === 'validating') {
      return { ok: true, operation: await recoverValidation(id, operation, context) };
    }
    const preparationOwnerAlive = await isProcessIdentityAlive(operation.preparation?.owner);
    const preparationOwnerIsCurrentProcess = await isCurrentProcessOwner(operation.preparation?.owner);
    if (options.recoverDispatch && operation.state === 'preparing'
      && !ACTIVE_DISPATCHES.has(id)
      && (!preparationOwnerAlive || preparationOwnerIsCurrentProcess)) {
      return {
        ok: true,
        operation: await withOperationLock(id, context, async () => {
          const current = await loadOperation(id, context);
          if (current.state !== 'preparing') return current;
          current.preparation = { ...current.preparation, interrupted: true, owner: null };
          current.updated_at = materializeNow(context.now).toISOString();
          await saveOperation(current, context);
          return current;
        })
      };
    }
    return { ok: true, operation };
  } catch (error) {
    if (options.suppressTransientRead
      && ['ENOENT', 'SAFE_STORE_FILE_CHANGED'].includes(error?.code)) {
      return { ok: false, suppressed: true };
    }
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

async function isCurrentProcessOwner(owner) {
  if (Number(owner?.pid) !== process.pid) return false;
  const expected = typeof owner?.process_identity === 'string' ? owner.process_identity : null;
  const current = await captureProcessIdentity(process.pid);
  return expected === null || current === null || expected === current;
}

async function recoverValidation(id, operation, context) {
  const resultPath = operation.internal?.result_path;
  const expectedDigest = operation.internal?.result_sha256;
  let verified;
  try {
    if (!resultPath || !expectedDigest) {
      throw codedError('CONTROL_CENTER_AGENTIC_REVIEW_VALIDATION_EVIDENCE_INVALID', 'The saved review result could not be verified.');
    }
    verified = await readVerifiedAdvisoryProjection(resultPath, operation, operation.dispatch ?? {}, context, expectedDigest);
  } catch {
    return withOperationLock(id, context, async () => {
      const current = await loadOperation(id, context);
      if (current.state !== 'validating') return current;
      current.state = 'dispatch_unknown';
      current.stage = 'attention';
      current.updated_at = materializeNow(context.now).toISOString();
      current.error = {
        code: 'CONTROL_CENTER_AGENTIC_REVIEW_VALIDATION_EVIDENCE_INVALID',
        message: 'TraceCue cannot verify the saved AI result and will not send the review again automatically.'
      };
      await saveOperation(current, context);
      return current;
    });
  }
  return withOperationLock(id, context, async () => {
    const current = await loadOperation(id, context);
    if (current.state !== 'validating' || current.internal?.result_sha256 !== expectedDigest) return current;
    const now = materializeNow(context.now).toISOString();
    current.state = 'completed';
    current.stage = 'complete';
    current.updated_at = now;
    current.completed_at = now;
    current.result = verified.projection;
    current.error = null;
    await saveOperation(current, context);
    return current;
  });
}

async function loadOperation(id, context) {
  const store = operationStore(context);
  let operation;
  try {
    operation = await store.readJson(`${id}/${OPERATION_FILE}`, { maxBytes: MAX_OPERATION_BYTES });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    operation = await store.readJson(operationHistoryFile(id), { maxBytes: MAX_OPERATION_BYTES });
  }
  if (operation?.type !== 'control_center_agentic_review_operation' || operation?.id !== id) {
    throw codedError('CONTROL_CENTER_AGENTIC_REVIEW_OPERATION_INVALID', 'The local review state is invalid.');
  }
  return operation;
}

async function saveOperation(operation, context) {
  const store = operationStore(context);
  let target = `${operation.id}/${OPERATION_FILE}`;
  let archived = false;
  try {
    await store.readJson(target, { maxBytes: MAX_OPERATION_BYTES });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await store.readJson(operationHistoryFile(operation.id), { maxBytes: MAX_OPERATION_BYTES });
    archived = true;
    await ensureOperationActivationCapacity(store, operation.id, context);
  }
  operation.store_revision = Number(operation.store_revision ?? 0) + 1;
  await store.writeJson(target, operation, {
    maxBytes: MAX_OPERATION_BYTES
  });
  try {
    await store.removeFile(operationHistoryFile(operation.id), { maxBytes: MAX_OPERATION_BYTES });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (archived) {
    const activated = await store.readJson(target, { maxBytes: MAX_OPERATION_BYTES });
    if (activated?.id !== operation.id || activated?.store_revision !== operation.store_revision) {
      throw codedError('CONTROL_CENTER_AGENTIC_REVIEW_ACTIVATION_FAILED', 'The archived review could not be restored safely.');
    }
  }
}

async function ensureOperationActivationCapacity(store, activatingId, context) {
  const entries = await store.listDirectories({ limit: MAX_OPERATION_STORE_ENTRIES });
  const activeIds = entries.filter((entry) => OPERATION_ID_PATTERN.test(entry));
  if (activeIds.length < activeOperationLimit(context)) return;
  const candidates = [];
  for (const id of activeIds) {
    if (id === activatingId) continue;
    const candidate = await store.readJson(`${id}/${OPERATION_FILE}`, { maxBytes: MAX_OPERATION_BYTES });
    if (candidate?.id === id && HISTORY_ELIGIBLE_STATES.has(candidate.state)) candidates.push(candidate);
  }
  candidates.sort((left, right) => String(left.updated_at).localeCompare(String(right.updated_at))
    || String(left.id).localeCompare(String(right.id)));
  for (const candidate of candidates) {
    const retired = await store.withLock(candidate.id, async () => {
      let current;
      try {
        current = await store.readJson(`${candidate.id}/${OPERATION_FILE}`, { maxBytes: MAX_OPERATION_BYTES });
      } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
      }
      if (current?.id !== candidate.id || !HISTORY_ELIGIBLE_STATES.has(current.state)) return false;
      try {
        await store.readJson(operationHistoryFile(candidate.id), { maxBytes: MAX_OPERATION_BYTES });
        throw codedError('CONTROL_CENTER_AGENTIC_REVIEW_HISTORY_CONFLICT', 'The review history contains a duplicate record.');
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      await store.writeJson(operationHistoryFile(candidate.id), current, { maxBytes: MAX_OPERATION_BYTES });
      await store.removeDirectory(candidate.id, { maxEntries: 8 });
      return true;
    }, { timeoutMs: operationLockTimeout(context) });
    if (retired) return;
  }
  throw codedError('CONTROL_CENTER_AGENTIC_REVIEW_CAPACITY_REACHED', 'No completed review can be moved to history safely.');
}

async function saveNewOperation(operation, context) {
  const store = operationStore(context);
  const limit = activeOperationLimit(context);
  const result = await store.withLock('operation-admission', async () => {
    const entries = await store.listDirectories({ limit: MAX_OPERATION_STORE_ENTRIES });
    let activeEntries = entries.filter((entry) => OPERATION_ID_PATTERN.test(entry));
    if (activeEntries.length >= limit) {
      await ensureOperationActivationCapacity(store, operation.id, context);
      activeEntries = (await store.listDirectories({ limit: MAX_OPERATION_STORE_ENTRIES }))
        .filter((entry) => OPERATION_ID_PATTERN.test(entry));
      if (activeEntries.length >= limit) {
        throw codedError('CONTROL_CENTER_AGENTIC_REVIEW_CAPACITY_REACHED', 'The active review store is full.');
      }
    }
    if (activeEntries.includes(operation.id)) {
      throw codedError('CONTROL_CENTER_AGENTIC_REVIEW_ID_CONFLICT', 'The generated review id is already in use.');
    }
    try {
      await store.readJson(operationHistoryFile(operation.id), { maxBytes: MAX_OPERATION_BYTES });
      throw codedError('CONTROL_CENTER_AGENTIC_REVIEW_ID_CONFLICT', 'The generated review id is already in use.');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return store.withLock(operation.id, async () => {
      operation.store_revision = Number(operation.store_revision ?? 0) + 1;
      await store.writeJson(`${operation.id}/${OPERATION_FILE}`, operation, {
        maxBytes: MAX_OPERATION_BYTES
      });
    }, { timeoutMs: operationLockTimeout(context) });
  }, { timeoutMs: operationLockTimeout(context) });
  scheduleOperationHistoryRetention(store, context);
  return result;
}

async function pruneOperationHistory(store, context) {
  const requested = Number(context.agenticReviewHistoryEntries);
  const limit = Number.isInteger(requested) && requested > 0
    ? Math.min(requested, MAX_OPERATION_STORE_ENTRIES - 64)
    : CONTROL_CENTER_AGENTIC_REVIEW_HISTORY_ENTRIES;
  const entries = await store.listDirectories({ limit: MAX_OPERATION_STORE_ENTRIES });
  const completed = [];
  for (const id of entries) {
    if (!OPERATION_ID_PATTERN.test(id)) continue;
    try {
      const operation = await store.readJson(`${id}/${OPERATION_FILE}`, { maxBytes: MAX_OPERATION_BYTES });
      if (operation?.id === id && HISTORY_ELIGIBLE_STATES.has(operation.state)) completed.push(operation);
    } catch {}
  }
  completed.sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at))
    || String(right.id).localeCompare(String(left.id)));
  for (const retired of completed.slice(limit)) {
    await store.withLock(retired.id, async () => {
      let current;
      try {
        current = await store.readJson(`${retired.id}/${OPERATION_FILE}`, { maxBytes: MAX_OPERATION_BYTES });
      } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
      }
      if (current?.id !== retired.id
        || !HISTORY_ELIGIBLE_STATES.has(current.state)
        || current.store_revision !== retired.store_revision
        || current.updated_at !== retired.updated_at) return;
      await store.writeJson(operationHistoryFile(retired.id), current, { maxBytes: MAX_OPERATION_BYTES });
      await store.removeDirectory(retired.id, { maxEntries: 8 });
    }, { timeoutMs: historyMaintenanceLockTimeout(context) });
  }
}

function operationHistoryFile(id) {
  const digest = sha256(id);
  return path.join('history', digest.slice(0, 2), digest.slice(2, 4), `${id}.json`);
}

function operationFile(id, context) {
  return path.join(operationsRoot(context), id, OPERATION_FILE);
}

function operationsRoot(context) {
  return path.join(path.resolve(context.cwd ?? process.cwd()), artifactRoot(context), CONTROL_CENTER_AGENTIC_REVIEW_ARTIFACT_DIR);
}

function operationStore(context) {
  const options = {
    workspaceRoot: path.resolve(context.cwd ?? process.cwd()),
    relativeRoot: path.join(artifactRoot(context), CONTROL_CENTER_AGENTIC_REVIEW_ARTIFACT_DIR),
    namespace: 'control-center-agentic-review-operations',
    maxRecordBytes: MAX_OPERATION_BYTES,
    maxEntries: MAX_OPERATION_STORE_ENTRIES
  };
  const factory = typeof context.createControlCenterAgenticReviewStore === 'function'
    ? context.createControlCenterAgenticReviewStore
    : createSafeLocalStore;
  return factory(options);
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

async function withOperationLock(id, context, task) {
  const store = operationStore(context);
  const result = await store.withLock('operation-admission', async () => (
    store.withLock(id, task, { timeoutMs: operationLockTimeout(context) })
  ), { timeoutMs: operationLockTimeout(context) });
  scheduleOperationHistoryRetention(store, context);
  return result;
}

function scheduleOperationHistoryRetention(store, context) {
  const key = operationsRoot(context);
  const existing = OPERATION_HISTORY_RETENTION.get(key);
  if (existing) {
    existing.requested = true;
    existing.store = store;
    existing.context = context;
    existing.failures = 0;
    return;
  }
  const state = { requested: true, store, context, failures: 0 };
  OPERATION_HISTORY_RETENTION.set(key, state);
  scheduleUnrefImmediate(() => { void runScheduledOperationHistoryRetention(key, state); });
}

async function runScheduledOperationHistoryRetention(key, state) {
  state.requested = false;
  let completed = false;
  try {
    await state.store.withLock(
      'history-retention',
      async () => pruneOperationHistory(state.store, state.context),
      { timeoutMs: historyMaintenanceLockTimeout(state.context) }
    );
    completed = true;
    state.failures = 0;
  } catch {
    state.failures += 1;
    // Retention is maintenance; it must never change an already committed action result.
  }
  if (state.requested || (!completed && state.failures <= HISTORY_MAINTENANCE_RETRY_LIMIT)) {
    const retry = () => { void runScheduledOperationHistoryRetention(key, state); };
    if (completed) scheduleUnrefImmediate(retry);
    else scheduleUnrefTimeout(retry, HISTORY_MAINTENANCE_RETRY_DELAY_MS * state.failures);
    return;
  }
  if (OPERATION_HISTORY_RETENTION.get(key) === state) OPERATION_HISTORY_RETENTION.delete(key);
}

function scheduleUnrefImmediate(task) {
  const immediate = setImmediate(task);
  immediate.unref?.();
}

function scheduleUnrefTimeout(task, delayMs) {
  const timer = setTimeout(task, delayMs);
  timer.unref?.();
}

function historyMaintenanceLockTimeout(context) {
  return normalizeBoundedPositiveInteger(
    context.agenticReviewHistoryMaintenanceLockTimeoutMs,
    DEFAULT_HISTORY_MAINTENANCE_LOCK_TIMEOUT_MS,
    MAX_HISTORY_MAINTENANCE_LOCK_TIMEOUT_MS
  );
}

function activeOperationLimit(context) {
  return normalizeBoundedPositiveInteger(
    context.agenticReviewActiveEntries,
    CONTROL_CENTER_AGENTIC_REVIEW_ACTIVE_ENTRIES,
    MAX_OPERATION_STORE_ENTRIES - 64
  );
}

function operationLockTimeout(context) {
  return normalizeBoundedPositiveInteger(
    context.agenticReviewOperationLockTimeoutMs,
    DEFAULT_OPERATION_LOCK_TIMEOUT_MS,
    MAX_OPERATION_LOCK_TIMEOUT_MS
  );
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

function recoveryProjection(operation) {
  if (operation.state === 'preparing') {
    return {
      action: 'resume_preparation',
      available: operation.preparation?.interrupted === true,
      external_retry: false,
      label: operation.preparation?.interrupted === true ? 'Resume preparation' : 'Preparing'
    };
  }
  if (operation.state === 'confirmation_required') {
    return {
      action: 'review_confirmation',
      available: true,
      external_retry: false,
      safe_cancel_available: true,
      label: 'Review what will be sent'
    };
  }
  if (operation.state === 'validating') {
    return {
      action: 'finish_validation',
      available: Boolean(operation.internal?.result_sha256),
      external_retry: false,
      label: 'Finish checking the result'
    };
  }
  if (operation.state === 'dispatching' || operation.state === 'dispatch_unknown') {
    return {
      action: 'check_status',
      available: true,
      external_retry: false,
      label: 'Check status'
    };
  }
  if (operation.state === 'failed') {
    return {
      action: 'new_attempt',
      available: true,
      external_retry: false,
      label: 'Start a new attempt'
    };
  }
  if (operation.state === 'completed') {
    return { action: 'open_result', available: true, external_retry: false, label: 'Open result' };
  }
  return { action: null, available: false, external_retry: false, label: null };
}

async function currentProcessOwner() {
  return {
    pid: process.pid,
    process_identity: await captureProcessIdentity(process.pid)
  };
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

function normalizeObservedDispatchBoundary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = ['provider_call_performed', 'api_call_performed', 'external_evidence_transfer'];
  if (!keys.some((key) => typeof value[key] === 'boolean')) return null;
  return Object.fromEntries(keys.map((key) => [key, value[key] === true]));
}

function mergeObservedDispatchBoundary(current = {}, observed = null) {
  if (!observed) return current;
  return {
    ...current,
    provider_call_performed: current.provider_call_performed === true
      || observed.provider_call_performed === true,
    api_call_performed: current.api_call_performed === true
      || observed.api_call_performed === true,
    external_evidence_transfer: current.external_evidence_transfer === true
      || observed.external_evidence_transfer === true,
    retry_automatic: false,
    cancel_available: false
  };
}

function normalizeBoundedPositiveInteger(value, fallback, maximum) {
  const requested = Number(value);
  return Number.isInteger(requested) && requested > 0
    ? Math.min(requested, maximum)
    : fallback;
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
