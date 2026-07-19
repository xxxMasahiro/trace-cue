import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildControlCenterAiReadiness,
  buildControlCenterAiDestinationFingerprint,
  CONTROL_CENTER_AI_REFRESH_CONFIRM,
  CONTROL_CENTER_AI_SELECTION_CONFIRM,
  createControlCenterAiConnectionRecord,
  getSchema,
  agenticProviderCapabilityHash,
  projectControlCenterAiConnections,
  readControlCenterPreferences,
  runControlCenterAiConnectionsRefresh,
  runControlCenterAiSelectionSave,
  runControlCenterAgenticReviewCancel,
  runControlCenterAgenticReviewConfirmation,
  runControlCenterAgenticReviewDecision,
  runControlCenterAgenticReviewList,
  runControlCenterAgenticReviewPrepare,
  runControlCenterAgenticReviewRecover,
  runControlCenterAgenticReviewRepeat,
  runControlCenterAgenticReviewStart,
  runControlCenterAgenticReviewStatus,
  runControlCenterSetPreferences,
  resolveAgenticHumanReviewProvider,
  startControlCenterServer
} from '../src/api.js';
import { createControlCenterAiSetupRuntime } from '../src/control-center-ai-setup-runtime.js';
import { captureProcessIdentity, createSafeLocalStore } from '../src/safe-local-store.js';
import { createControlCenterTestAssetRoot } from './helpers/control-center-test-assets.js';

function repeatIdempotencyKey(character) {
  return character.repeat(43);
}

async function runConfirmedExternalReview(harness) {
  const prepared = reviewData(await runControlCenterAgenticReviewPrepare(withHarnessAi(harness, {
    url: 'https://example.jp/',
    purpose: '確認する',
    effort: 'standard',
    viewport: 'desktop',
    ai_suggestions: true
  }), harness.context));
  await harness.drain();
  const confirmation = reviewData(await runControlCenterAgenticReviewConfirmation({
    operation_id: prepared.operation.id
  }, harness.context)).confirmation;
  reviewData(await runControlCenterAgenticReviewStart({
    operation_id: prepared.operation.id,
    nonce: confirmation.nonce,
    revision: confirmation.revision,
    execute_confirmed: true
  }, harness.context));
  await harness.drain();
  return reviewData(await runControlCenterAgenticReviewStatus({
    id: prepared.operation.id
  }, harness.context)).operation;
}

function createHarness(cwd, overrides = {}) {
  const tasks = [];
  const calls = { review: 0, propose: 0, plan: 0, run: 0, planOptions: [], runOptions: [] };
  let id = 0;
  const context = {
    cwd,
    now: () => new Date('2026-07-11T00:00:00.000Z'),
    createId: () => `control-center-agentic-review-test-${++id}`,
    agenticReviewServiceName: 'Example Review AI',
    agenticReviewProviderId: 'injected-runner',
    scheduleBackground(run) {
      tasks.push(Promise.resolve().then(run));
    },
    async runReview() {
      calls.review += 1;
      return {
        status: 'ok',
        data: { findings: [] },
        warnings: [],
        errors: [],
        artifacts: [{ type: 'review_artifact_index', path: '.browser-debug/review-index.json' }]
      };
    },
    async runAgenticHumanReviewPropose() {
      calls.propose += 1;
      return {
        status: 'ok',
        data: {},
        warnings: [],
        errors: [],
        artifacts: [{ type: 'agentic_human_review_proposal', path: '.browser-debug/proposal.json' }]
      };
    },
    async runAgenticHumanReviewPlan(options = {}) {
      calls.plan += 1;
      calls.planOptions.push(structuredClone(options));
      const providerId = context.agenticReviewProviderId ?? 'injected-runner';
      const modelId = context.agenticReviewModelId ?? 'injected-local-model';
      return {
        status: 'ok',
        data: {
          agentic_human_review_plan: {
            plan_hash: 'private-plan-hash',
            package_hash: 'private-package-hash',
            provider_capability_hash: options['connection-binding']?.provider_capability_hash ?? 'private-capability-hash',
            provider: { id: providerId },
            model: { id: modelId },
            surface: { id: 'private-surface' },
            provider_effort_binding: {
              requested_review_effort: options.effort,
              native_effort_applied_value: options['provider-effort'] ?? null
            },
            connection_binding: options['connection-binding'] ?? null,
            transfer_permissions: {
              required_flags: ['allow-page-text', 'allow-url'],
              classes: {
                page_text: { included: true, required_for_execution: true },
                url: { included: true, required_for_execution: true }
              }
            }
          }
        },
        warnings: [],
        errors: [],
        artifacts: [{ type: 'agentic_human_review_plan', path: '.browser-debug/plan.json' }]
      };
    },
    async runAgenticHumanReviewRun(options = {}) {
      calls.run += 1;
      calls.runOptions.push(structuredClone(options));
      const resultPath = '.browser-debug/advisory.json';
      const providerId = context.agenticReviewProviderId ?? 'injected-runner';
      const modelId = context.agenticReviewModelId ?? 'injected-local-model';
      const apiCallPerformed = context.agenticReviewApiCallPerformed !== false;
      await mkdir(path.join(cwd, '.browser-debug'), { recursive: true });
      await writeFile(path.join(cwd, resultPath), `${JSON.stringify({
        schema_version: '1.0.0',
        id: 'test-advisory',
        result_type: 'agentic_human_review_advisory',
        human_review_schema_version: '2.0.0',
        agentic_human_review_advisory: {
          id: 'test-advisory',
          status: 'completed',
          plan_hash: 'private-plan-hash',
          plan_path: '.browser-debug/plan.json',
          gate_effect: 'none'
        },
        non_engineer_summary: {
          main_takeaway: 'Make the next action easier to find.',
          top_concerns: ['The main action is easy to miss.']
        },
        subjective_perception: {},
        readability_comprehension: {},
        reader_experience_review: {},
        mechanical_vs_human_review: {},
        human_review_coverage: {},
        benchmark_requirement_coverage: {},
        xhigh_multi_round_review: {},
        role_opinions: [],
        consensus_summary: {},
        dissent_summary: {},
        agentic_human_review_findings: [{
          id: 'finding-primary-action',
          message: 'The main action is easy to miss.',
          impact: 'First-time visitors may stop before booking.',
          suggested_fix: 'Place the main action near the first explanation.'
        }],
        agentic_human_review_action_plan: { suggested_fixes: ['Move the main action higher.'] },
        agentic_human_review_readiness: { advisory_only: true, gate_effect: 'none' },
        owner_decision_requests: [],
        provider: { id: providerId },
        model: { id: modelId },
        transfer_permissions: { required_flags: ['allow-page-text', 'allow-url'] },
        execution: {
          id: 'test-execution',
          result_path: resultPath,
          provider_call_performed: true,
          api_call_performed: apiCallPerformed,
          external_evidence_transfer: true
        },
        boundary: {
          provider_call_performed: true,
          api_call_performed: apiCallPerformed,
          external_evidence_transfer: true
        }
      })}\n`, 'utf8');
      return {
        status: 'ok',
        data: {
          agentic_human_review_execution: {
            boundary: {
              provider_call_performed: true,
              api_call_performed: apiCallPerformed,
              external_evidence_transfer: true
            }
          }
        },
        warnings: [],
        errors: [],
        artifacts: [{ type: 'agentic_human_review_advisory', path: resultPath }]
      };
    },
    ...overrides
  };
  const ai = createHarnessAiConnection(context);
  if (ai && !context.controlCenterAiConnectionRecord) context.controlCenterAiConnectionRecord = ai.record;
  return {
    context,
    calls,
    aiSelection: ai?.selection ?? null,
    async drain() {
      while (tasks.length > 0) await tasks.shift();
    }
  };
}

function createHarnessAiConnection(context) {
  if (!context.agenticReviewServiceName || !context.agenticReviewProviderId) return null;
  const resolved = resolveAgenticHumanReviewProvider({ providerId: context.agenticReviewProviderId, context });
  if (!resolved.ok) return null;
  const provider = resolved.provider;
  const native = provider.native_effort_binding ?? provider.effort_capability?.native_effort_binding ?? {};
  const effortValues = native.supported === true
    ? [...new Set([...(native.supported_values ?? []), ...Object.values(native.effort_map ?? {})]
        .filter((value) => typeof value === 'string' && value.length > 0))]
    : ['not-applicable'];
  const efforts = effortValues.length > 0 ? effortValues : ['not-applicable'];
  const modelId = context.agenticReviewModelId
    ?? context.env?.[provider.runtime_model_env]
    ?? provider.default_model;
  const connection = {
    id: `test-${provider.id}`,
    display_name: context.agenticReviewServiceName,
    connection_type: provider.transport === 'provider_api'
      ? 'api'
      : (provider.transport === 'subscription_cli' ? 'subscription' : 'local'),
    status: 'available',
    status_message: 'Ready to use.',
    adapter_id: `test-${provider.kind}`,
    adapter_version: '1.0.0',
    provider_id: provider.id,
    transport: provider.transport,
    execution_strategy: 'one-shot',
    provider_effort_request_field: native.supported === true ? native.request_field : null,
    provider_capability_hash: agenticProviderCapabilityHash(provider),
    executable_identity_hash: provider.transport === 'subscription_cli'
      ? context.agenticReviewExecutableIdentityHash
      : null,
    models: [{
      id: modelId,
      display_name: modelId,
      native_efforts: efforts.map((id) => ({ id, display_name: id })),
      default_native_effort_id: efforts.includes(context.agenticReviewNativeEffort)
        ? context.agenticReviewNativeEffort
        : efforts[0]
    }],
    default_model_id: modelId
  };
  const record = createControlCenterAiConnectionRecord({
    connections: [connection],
    observedAt: typeof context.now === 'function' ? context.now() : new Date()
  });
  const projection = projectControlCenterAiConnections(record, {
    now: typeof context.now === 'function' ? context.now() : new Date()
  });
  return {
    record,
    selection: {
      connection_option_id: projection.selection.connection_option_id,
      model_option_id: projection.selection.model_option_id,
      effort_option_id: projection.selection.effort_option_id,
      capability_revision: projection.revision,
      capability_token: projection.capability_token
    }
  };
}

function withHarnessAi(harness, input) {
  return input.ai_suggestions === true ? { ...input, ...harness.aiSelection } : input;
}

function reviewData(result) {
  assert.equal(result.status, 'ok');
  return result.data.control_center_agentic_review;
}

test('Control Center executes one external review only after one-time disclosure confirmation', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-control-center-agentic-'));
  const harness = createHarness(cwd);
  const prepared = reviewData(await runControlCenterAgenticReviewPrepare(withHarnessAi(harness, {
    url: 'https://example.jp/reserve?private=query',
    purpose: '初めての利用者が迷わず予約を完了できるか知りたい',
    effort: 'deep',
    viewport: 'both',
    ai_suggestions: true
  }), harness.context));
  const id = prepared.operation.id;
  assert.equal(prepared.operation.state, 'preparing');
  assert.equal(harness.calls.run, 0);

  await harness.drain();
  const ready = reviewData(await runControlCenterAgenticReviewStatus({ id }, harness.context)).operation;
  assert.equal(ready.state, 'confirmation_required');
  assert.equal(ready.service.name, 'Example Review AI');
  assert.equal(ready.disclosure.service_name, 'Example Review AI');
  assert.equal(ready.disclosure.items.find((item) => item.id === 'page_text').sent, true);
  assert.equal(JSON.stringify(ready).includes('private-plan-hash'), false);
  assert.equal(ready.service.model_name, 'injected-local-model');
  assert.equal(ready.disclosure.model_name, 'injected-local-model');
  assert.equal(JSON.stringify(ready).includes('.browser-debug'), false);
  assert.equal(ready.target.includes('?private=query'), false);
  assert.equal(harness.calls.run, 0);

  const issued = reviewData(await runControlCenterAgenticReviewConfirmation({ operation_id: id }, harness.context));
  assert.ok(issued.confirmation.nonce);
  const operationFile = path.join(cwd, '.browser-debug', 'control-center-agentic-reviews', id, 'operation.json');
  const storedBefore = await readFile(operationFile, 'utf8');
  assert.equal(storedBefore.includes(issued.confirmation.nonce), false);
  assert.match(storedBefore, /nonce_hash/);

  const started = reviewData(await runControlCenterAgenticReviewStart({
    operation_id: id,
    nonce: issued.confirmation.nonce,
    revision: issued.confirmation.revision,
    execute_confirmed: true
  }, harness.context));
  assert.equal(started.operation.state, 'dispatching');
  const duplicate = await runControlCenterAgenticReviewStart({
    operation_id: id,
    nonce: issued.confirmation.nonce,
    revision: issued.confirmation.revision,
    execute_confirmed: true
  }, harness.context);
  assert.equal(duplicate.status, 'error');
  assert.equal(duplicate.errors[0].code, 'CONTROL_CENTER_AGENTIC_REVIEW_ALREADY_STARTED');

  await harness.drain();
  const completed = reviewData(await runControlCenterAgenticReviewStatus({ id }, harness.context)).operation;
  assert.equal(harness.calls.run, 1);
  assert.equal(completed.state, 'completed');
  assert.equal(completed.result.findings[0].id, 'finding-primary-action');
  assert.equal(completed.dispatch.provider_call_performed, true);
  assert.equal(completed.dispatch.retry_automatic, false);
  assert.equal(completed.boundary.raw_provider_response_included, false);
  assert.equal(completed.boundary.provider_credential_source, 'none');
  assert.equal(completed.boundary.provider_credentials_env_only, false);
  assert.equal(completed.boundary.internal_adapter_credentials_env_only, false);

  const decided = reviewData(await runControlCenterAgenticReviewDecision({
    operation_id: id,
    finding_id: 'finding-primary-action',
    decision: 'fix'
  }, harness.context)).operation;
  assert.equal(decided.decisions[0].value, 'fix');
  assert.equal(decided.stage, 'complete');

  const repeated = reviewData(await runControlCenterAgenticReviewRepeat({
    operation_id: id,
    mode: 'recheck',
    idempotency_key: repeatIdempotencyKey('a')
  }, harness.context));
  assert.notEqual(repeated.operation.id, id);
  assert.equal(repeated.operation.parent_review.id, id);
  assert.equal(repeated.operation.parent_review.repeat_mode, 'recheck');
  await harness.drain();
  assert.equal(harness.calls.review, 2);
});

test('Control Center repeat is exactly-once across concurrent replay, history, and bounded capacity', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-control-center-repeat-idempotency-'));
  const harness = createHarness(cwd);
  const completed = await runConfirmedExternalReview(harness);
  const key = repeatIdempotencyKey('g');
  const payload = {
    operation_id: completed.id,
    mode: 'recheck',
    idempotency_key: key
  };

  const missing = await runControlCenterAgenticReviewRepeat({
    operation_id: completed.id,
    mode: 'recheck'
  }, harness.context);
  assert.equal(missing.status, 'error');
  assert.equal(missing.errors[0].code, 'CONTROL_CENTER_AGENTIC_REVIEW_REPEAT_IDEMPOTENCY_REQUIRED');
  const invalid = await runControlCenterAgenticReviewRepeat({
    ...payload,
    idempotency_key: 'not-a-valid-key'
  }, harness.context);
  assert.equal(invalid.status, 'error');
  assert.equal(invalid.errors[0].code, 'CONTROL_CENTER_AGENTIC_REVIEW_REPEAT_IDEMPOTENCY_INVALID');

  const concurrent = await Promise.all(Array.from(
    { length: 8 },
    () => runControlCenterAgenticReviewRepeat(payload, harness.context)
  ));
  assert.equal(
    concurrent.every((result) => result.status === 'ok'),
    true,
    JSON.stringify(concurrent.filter((result) => result.status !== 'ok'))
  );
  const projections = concurrent.map((result) => result.data.control_center_agentic_review);
  assert.equal(new Set(projections.map((result) => result.operation.id)).size, 1);
  assert.equal(projections.filter((result) => result.background_work_started === true).length, 1);
  const childId = projections[0].operation.id;
  await harness.drain();
  assert.equal(harness.calls.review, 2);

  const replay = reviewData(await runControlCenterAgenticReviewRepeat(payload, harness.context));
  assert.equal(replay.operation.id, childId);
  assert.equal(replay.idempotent_replay, true);
  assert.equal(replay.background_work_started, false);

  const fallbackStore = createSafeLocalStore({
    workspaceRoot: cwd,
    relativeRoot: '.browser-debug/control-center-agentic-reviews',
    namespace: 'control-center-agentic-review-operations',
    maxRecordBytes: 1024 * 1024,
    maxEntries: 4096
  });
  let hideExistingChildOnce = true;
  let hideExistingChildHistoryOnce = true;
  let timeOutAdmissionOnce = true;
  const fallbackEvents = [];
  const fallbackStoreAdapter = {
    ...fallbackStore,
    async readJson(relativePath, options) {
      fallbackEvents.push(`read:${relativePath}`);
      if (hideExistingChildOnce && relativePath === `${childId}/operation.json`) {
        hideExistingChildOnce = false;
        const error = new Error('Simulated read race before admission.');
        error.code = 'ENOENT';
        throw error;
      }
      if (!hideExistingChildOnce
        && hideExistingChildHistoryOnce
        && relativePath.startsWith('history/')
        && relativePath.endsWith(`/${childId}.json`)) {
        hideExistingChildHistoryOnce = false;
        const error = new Error('Simulated history miss before admission.');
        error.code = 'ENOENT';
        throw error;
      }
      return fallbackStore.readJson(relativePath, options);
    },
    async withLock(name, run, options) {
      fallbackEvents.push(`lock:${name}`);
      if (timeOutAdmissionOnce && name === 'operation-admission') {
        timeOutAdmissionOnce = false;
        const error = new Error('Simulated admission lock timeout after another writer committed.');
        error.code = 'SAFE_STORE_LOCK_TIMEOUT';
        throw error;
      }
      return fallbackStore.withLock(name, run, options);
    }
  };
  const callsBeforeLockTimeoutReplay = harness.calls.review;
  const lockTimeoutResult = await runControlCenterAgenticReviewRepeat(payload, {
    ...harness.context,
    createControlCenterAgenticReviewStore: () => {
      fallbackEvents.push('factory');
      return fallbackStoreAdapter;
    }
  });
  assert.equal(lockTimeoutResult.status, 'ok', JSON.stringify({ lockTimeoutResult, fallbackEvents }));
  const lockTimeoutReplay = reviewData(lockTimeoutResult);
  assert.equal(lockTimeoutReplay.operation.id, childId);
  assert.equal(lockTimeoutReplay.idempotent_replay, true);
  assert.equal(lockTimeoutReplay.background_work_started, false);
  assert.equal(hideExistingChildOnce, false);
  assert.equal(hideExistingChildHistoryOnce, false);
  assert.equal(timeOutAdmissionOnce, false);
  assert.equal(harness.calls.review, callsBeforeLockTimeoutReplay);

  const changedMode = await runControlCenterAgenticReviewRepeat({
    ...payload,
    mode: 'deeper'
  }, harness.context);
  assert.equal(changedMode.status, 'error');
  assert.equal(changedMode.errors[0].code, 'CONTROL_CENTER_AGENTIC_REVIEW_REPEAT_IDEMPOTENCY_CONFLICT');
  const changedSelection = await runControlCenterAgenticReviewRepeat({
    ...payload,
    ...harness.aiSelection,
    effort_option_id: 'changed-effort'
  }, harness.context);
  assert.equal(changedSelection.status, 'error');
  assert.equal(changedSelection.errors[0].code, 'CONTROL_CENTER_AGENTIC_REVIEW_REPEAT_IDEMPOTENCY_CONFLICT');

  const another = reviewData(await runControlCenterAgenticReviewRepeat({
    ...payload,
    idempotency_key: repeatIdempotencyKey('h')
  }, harness.context));
  assert.notEqual(another.operation.id, childId);
  await harness.drain();

  const storedPath = path.join(
    cwd,
    '.browser-debug',
    'control-center-agentic-reviews',
    childId,
    'operation.json'
  );
  const storedText = await readFile(storedPath, 'utf8');
  assert.doesNotMatch(storedText, new RegExp(key));
  assert.doesNotMatch(JSON.stringify(projections), new RegExp(key));
  const stored = JSON.parse(storedText);
  assert.match(stored.internal.repeat_idempotency.key_hash, /^[a-f0-9]{64}$/u);
  assert.match(stored.internal.repeat_idempotency.request_hash, /^[a-f0-9]{64}$/u);

  const confirmation = reviewData(await runControlCenterAgenticReviewConfirmation({
    operation_id: childId
  }, harness.context)).confirmation;
  reviewData(await runControlCenterAgenticReviewStart({
    operation_id: childId,
    nonce: confirmation.nonce,
    revision: confirmation.revision,
    execute_confirmed: true
  }, harness.context));
  await harness.drain();
  const store = createSafeLocalStore({
    workspaceRoot: cwd,
    relativeRoot: '.browser-debug/control-center-agentic-reviews',
    namespace: 'control-center-agentic-review-operations',
    maxRecordBytes: 1024 * 1024,
    maxEntries: 4096
  });
  await store.withLock('operation-admission', () => store.withLock(childId, async () => {
    const current = await store.readJson(`${childId}/operation.json`, { maxBytes: 1024 * 1024 });
    const digest = createHash('sha256').update(childId).digest('hex');
    await store.writeJson(`history/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${childId}.json`, current, {
      maxBytes: 1024 * 1024
    });
    await store.removeDirectory(childId, { maxEntries: 8 });
  }));

  const callsBeforeArchivedReplay = harness.calls.review;
  const restartedContext = { ...harness.context, agenticReviewActiveEntries: 1 };
  const archivedReplay = reviewData(await runControlCenterAgenticReviewRepeat(payload, restartedContext));
  assert.equal(archivedReplay.operation.id, childId);
  assert.equal(archivedReplay.idempotent_replay, true);
  assert.equal(harness.calls.review, callsBeforeArchivedReplay);
});

test('Control Center completes the same consent and repeat flow with a subscription AI connection', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-control-center-subscription-flow-'));
  const executableIdentityHash = 'c'.repeat(64);
  const harness = createHarness(cwd, {
    agenticReviewServiceName: 'Example Subscription AI',
    agenticReviewProviderId: 'codex-subscription-cli',
    agenticReviewModelId: 'provider/review-model',
    agenticReviewNativeEffort: 'ultra',
    agenticReviewExecutableIdentityHash: executableIdentityHash,
    agenticReviewApiCallPerformed: false
  });
  const prepared = reviewData(await runControlCenterAgenticReviewPrepare(withHarnessAi(harness, {
    url: 'https://example.jp/subscription',
    purpose: 'Make the next action easy to understand.',
    effort: 'deep',
    viewport: 'desktop',
    ai_suggestions: true
  }), harness.context));
  await harness.drain();

  const ready = reviewData(await runControlCenterAgenticReviewStatus({
    id: prepared.operation.id
  }, harness.context)).operation;
  assert.equal(ready.state, 'confirmation_required');
  assert.equal(ready.review_effort, 'deep');
  assert.equal(ready.service.name, 'Example Subscription AI');
  assert.equal(ready.service.model_name, 'provider/review-model');
  assert.equal(ready.service.processing_level_name, 'ultra');
  assert.equal(harness.calls.planOptions[0]['connection-binding'].connection_type, 'subscription');
  assert.equal(harness.calls.planOptions[0]['connection-binding'].executable_identity_hash, executableIdentityHash);
  assert.equal(harness.calls.planOptions[0]['provider-effort'], 'ultra');

  const confirmation = reviewData(await runControlCenterAgenticReviewConfirmation({
    operation_id: ready.id
  }, harness.context)).confirmation;
  reviewData(await runControlCenterAgenticReviewStart({
    operation_id: ready.id,
    nonce: confirmation.nonce,
    revision: confirmation.revision,
    execute_confirmed: true
  }, harness.context));
  await harness.drain();
  const completed = reviewData(await runControlCenterAgenticReviewStatus({ id: ready.id }, harness.context)).operation;
  assert.equal(completed.state, 'completed');
  assert.equal(completed.dispatch.provider_call_performed, true);
  assert.equal(completed.dispatch.api_call_performed, false);
  assert.equal(completed.dispatch.external_evidence_transfer, true);
  assert.equal(completed.boundary.provider_credential_source, 'subscription_session');
  assert.equal(completed.boundary.provider_credentials_env_only, false);
  assert.equal(completed.boundary.internal_adapter_credentials_env_only, false);

  reviewData(await runControlCenterAgenticReviewDecision({
    operation_id: ready.id,
    finding_id: 'finding-primary-action',
    decision: 'fix'
  }, harness.context));
  const repeated = reviewData(await runControlCenterAgenticReviewRepeat({
    operation_id: ready.id,
    mode: 'deeper',
    idempotency_key: repeatIdempotencyKey('b'),
    ...harness.aiSelection
  }, harness.context)).operation;
  await harness.drain();
  const repeatedReady = reviewData(await runControlCenterAgenticReviewStatus({
    id: repeated.id
  }, harness.context)).operation;
  assert.equal(repeatedReady.state, 'confirmation_required');
  assert.equal(repeatedReady.review_effort, 'xhigh');
  assert.equal(repeatedReady.service.processing_level_name, 'ultra');

  const repeatedConfirmation = reviewData(await runControlCenterAgenticReviewConfirmation({
    operation_id: repeatedReady.id
  }, harness.context)).confirmation;
  reviewData(await runControlCenterAgenticReviewStart({
    operation_id: repeatedReady.id,
    nonce: repeatedConfirmation.nonce,
    revision: repeatedConfirmation.revision,
    execute_confirmed: true
  }, harness.context));
  await harness.drain();
  const repeatedCompleted = reviewData(await runControlCenterAgenticReviewStatus({
    id: repeatedReady.id
  }, harness.context)).operation;
  assert.equal(repeatedCompleted.state, 'completed');

  const rechecked = reviewData(await runControlCenterAgenticReviewRepeat({
    operation_id: repeatedReady.id,
    mode: 'recheck',
    idempotency_key: repeatIdempotencyKey('c'),
    ...harness.aiSelection
  }, harness.context)).operation;
  await harness.drain();
  const recheckedReady = reviewData(await runControlCenterAgenticReviewStatus({
    id: rechecked.id
  }, harness.context)).operation;
  assert.equal(recheckedReady.state, 'confirmation_required');
  assert.equal(recheckedReady.review_effort, 'xhigh');
  assert.equal(recheckedReady.parent_review.repeat_mode, 'recheck');
  assert.equal(recheckedReady.service.processing_level_name, 'ultra');
  assert.equal(harness.calls.run, 2);
});

test('Control Center cancels a prepared review and releases bounded active capacity', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-control-center-cancel-capacity-'));
  const harness = createHarness(cwd, { agenticReviewActiveEntries: 1 });
  const prepared = reviewData(await runControlCenterAgenticReviewPrepare(withHarnessAi(harness, {
    url: 'https://example.jp/cancel', purpose: 'Check the next action.', effort: 'standard',
    viewport: 'desktop', ai_suggestions: true
  }), harness.context));
  await harness.drain();
  assert.equal(reviewData(await runControlCenterAgenticReviewStatus({ id: prepared.operation.id }, harness.context)).operation.state, 'confirmation_required');
  const cancelled = reviewData(await runControlCenterAgenticReviewCancel({ id: prepared.operation.id }, harness.context)).operation;
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.dispatch.provider_call_performed, false);

  const replacement = await runControlCenterAgenticReviewPrepare({
    url: 'https://example.jp/replacement', purpose: 'Check the replacement.', effort: 'standard',
    viewport: 'desktop', ai_suggestions: false
  }, harness.context);
  assert.equal(replacement.status, 'ok');
});

test('Control Center repeat accepts the current opaque AI choice after capability refresh', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-control-center-repeat-refresh-'));
  const harness = createHarness(cwd);
  const completed = await runConfirmedExternalReview(harness);
  const previousRecord = harness.context.controlCenterAiConnectionRecord;
  const refreshedRecord = createControlCenterAiConnectionRecord({
    connections: previousRecord.connections,
    previousRevision: previousRecord.revision,
    previousSettingsRevision: previousRecord.settings_revision,
    selection: previousRecord.selection,
    observedAt: new Date('2026-07-11T01:00:00.000Z')
  });
  harness.context.controlCenterAiConnectionRecord = refreshedRecord;
  const staleRepeat = await runControlCenterAgenticReviewRepeat({
    operation_id: completed.id,
    mode: 'recheck',
    idempotency_key: repeatIdempotencyKey('d')
  }, harness.context);
  assert.equal(staleRepeat.status, 'error');
  assert.equal(staleRepeat.errors[0].code, 'CONTROL_CENTER_AI_CONNECTION_REVISION_CHANGED');

  const projection = projectControlCenterAiConnections(refreshedRecord, { now: harness.context.now() });
  const repeated = reviewData(await runControlCenterAgenticReviewRepeat({
    operation_id: completed.id,
    mode: 'recheck',
    idempotency_key: repeatIdempotencyKey('e'),
    connection_option_id: projection.selection.connection_option_id,
    model_option_id: projection.selection.model_option_id,
    effort_option_id: projection.selection.effort_option_id,
    capability_revision: projection.revision,
    capability_token: projection.capability_token
  }, harness.context));
  assert.notEqual(repeated.operation.id, completed.id);
  assert.equal(repeated.operation.purpose, completed.purpose);
  assert.equal(repeated.operation.parent_review.id, completed.id);
});

test('Control Center repeats a legacy AI review with the current opaque AI choice', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-control-center-legacy-repeat-'));
  const harness = createHarness(cwd);
  const id = 'control-center-agentic-review-legacy-ai';
  const store = createSafeLocalStore({
    workspaceRoot: cwd,
    relativeRoot: '.browser-debug/control-center-agentic-reviews',
    namespace: 'control-center-agentic-review-operations',
    maxRecordBytes: 1024 * 1024,
    maxEntries: 4096
  });
  await store.writeJson(`${id}/operation.json`, {
    schema_version: '1.0.0',
    type: 'control_center_agentic_review_operation',
    id,
    state: 'completed',
    stage: 'complete',
    created_at: '2026-07-10T00:00:00.000Z',
    updated_at: '2026-07-10T00:00:00.000Z',
    started_at: '2026-07-10T00:00:00.000Z',
    completed_at: '2026-07-10T00:00:00.000Z',
    request: {
      purpose: 'Keep this legacy review repeatable.',
      effort: 'standard',
      viewport: 'desktop',
      ai_suggestions: true
    },
    service: { name: 'Example Review AI', external_ai: true },
    dispatch: { attempt: 1, provider_call_performed: true },
    decisions: [],
    result: { findings: [] },
    error: null,
    internal: { target_url: 'https://example.jp/legacy' }
  });

  const repeated = reviewData(await runControlCenterAgenticReviewRepeat({
    operation_id: id,
    mode: 'recheck',
    idempotency_key: repeatIdempotencyKey('f'),
    ...harness.aiSelection
  }, harness.context)).operation;
  assert.notEqual(repeated.id, id);
  assert.equal(repeated.parent_review.id, id);
  assert.equal(repeated.purpose, 'Keep this legacy review repeatable.');
  assert.equal(repeated.ai_suggestions, true);
  await harness.drain();
  assert.equal(reviewData(await runControlCenterAgenticReviewStatus({ id: repeated.id }, harness.context)).operation.state, 'confirmation_required');
});

test('Control Center keeps local review local and rejects browser authority fields', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-control-center-local-review-'));
  const harness = createHarness(cwd, { agenticReviewServiceName: undefined });
  const missingService = await runControlCenterAgenticReviewPrepare({
    url: 'https://example.jp/', purpose: '確認する', effort: 'standard', viewport: 'desktop', ai_suggestions: true
  }, harness.context);
  assert.equal(missingService.status, 'error');
  assert.equal(missingService.errors[0].code, 'CONTROL_CENTER_AGENTIC_REVIEW_SERVICE_NOT_CONFIGURED');

  const forbidden = await runControlCenterAgenticReviewPrepare({
    url: 'https://example.jp/', purpose: '確認する', effort: 'standard', viewport: 'desktop', ai_suggestions: false,
    provider: 'browser-selected-provider'
  }, harness.context);
  assert.equal(forbidden.status, 'error');
  assert.equal(forbidden.errors[0].code, 'CONTROL_CENTER_AGENTIC_REVIEW_BROWSER_AUTHORITY_REJECTED');

  const internalHash = await runControlCenterAgenticReviewPrepare({
    url: 'https://example.jp/', purpose: '確認する', effort: 'standard', viewport: 'desktop', ai_suggestions: false,
    semantic_capability_hash: 'a'.repeat(64)
  }, harness.context);
  assert.equal(internalHash.status, 'error');
  assert.equal(internalHash.errors[0].code, 'CONTROL_CENTER_AGENTIC_REVIEW_BROWSER_AUTHORITY_REJECTED');

  const local = reviewData(await runControlCenterAgenticReviewPrepare({
    url: 'https://example.jp/', purpose: '確認する', effort: 'standard', viewport: 'mobile', ai_suggestions: false
  }, harness.context));
  await harness.drain();
  const completed = reviewData(await runControlCenterAgenticReviewStatus({ id: local.operation.id }, harness.context)).operation;
  assert.equal(completed.state, 'completed');
  assert.equal(completed.result.kind, 'local_review');
  assert.equal(harness.calls.review, 1);
  assert.equal(harness.calls.propose, 0);
  assert.equal(harness.calls.plan, 0);
  assert.equal(harness.calls.run, 0);
  assert.equal(completed.boundary.provider_credential_source, 'none');
  assert.equal(completed.boundary.provider_credentials_env_only, false);
  assert.equal(completed.boundary.internal_adapter_credentials_env_only, false);
});

test('Control Center operations honor a workspace-confined configured artifact root', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-control-center-custom-root-'));
  const harness = createHarness(cwd, { artifactRoot: '.trace-cue-custom' });
  const prepared = reviewData(await runControlCenterAgenticReviewPrepare({
    url: 'https://example.jp/', purpose: '確認する', effort: 'standard', viewport: 'desktop', ai_suggestions: false
  }, harness.context));
  await harness.drain();
  const operationPath = path.join(cwd, '.trace-cue-custom', 'control-center-agentic-reviews', prepared.operation.id, 'operation.json');
  assert.equal(JSON.parse(await readFile(operationPath, 'utf8')).id, prepared.operation.id);
});

test('Control Center reports interrupted dispatch as unknown without retrying', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-control-center-unknown-'));
  const id = 'control-center-agentic-review-restarted-test';
  const directory = path.join(cwd, '.browser-debug', 'control-center-agentic-reviews', id);
  const store = createSafeLocalStore({
    workspaceRoot: cwd,
    relativeRoot: '.browser-debug/control-center-agentic-reviews',
    namespace: 'control-center-agentic-review-operations'
  });
  await store.writeJson(`${id}/operation.json`, {
    schema_version: '1.0.0',
    type: 'control_center_agentic_review_operation',
    id,
    state: 'dispatching',
    stage: 'external_review',
    created_at: '2026-07-11T00:00:00.000Z',
    updated_at: '2026-07-11T00:00:00.000Z',
    started_at: '2026-07-11T00:00:00.000Z',
    completed_at: null,
    request: { purpose: '確認する', effort: 'standard', viewport: 'both', ai_suggestions: true },
    service: { name: 'Example Review AI', external_ai: true },
    relationship: null,
    disclosure: null,
    confirmation: null,
    dispatch: { attempt: 1 },
    decisions: [],
    result: null,
    error: null,
    internal: { target_url: 'https://example.jp/' }
  });
  const before = await readFile(path.join(directory, 'operation.json'), 'utf8');
  const viewed = reviewData(await runControlCenterAgenticReviewStatus({ id }, { cwd })).operation;
  assert.equal(viewed.state, 'dispatching');
  assert.equal(await readFile(path.join(directory, 'operation.json'), 'utf8'), before);
  const result = reviewData(await runControlCenterAgenticReviewRecover({ id }, { cwd })).operation;
  assert.equal(result.state, 'dispatch_unknown');
  assert.equal(result.dispatch.retry_automatic, false);
  assert.equal(result.dispatch.cancel_available, false);
});

test('Control Center recovers locally owned work after its background task has ended', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-control-center-local-owner-recovery-'));
  const store = createSafeLocalStore({
    workspaceRoot: cwd,
    relativeRoot: '.browser-debug/control-center-agentic-reviews',
    namespace: 'control-center-agentic-review-operations'
  });
  const owner = {
    pid: process.pid,
    process_identity: await captureProcessIdentity(process.pid)
  };
  const base = {
    schema_version: '1.0.0',
    type: 'control_center_agentic_review_operation',
    stage: 'external_review',
    created_at: '2026-07-11T00:00:00.000Z',
    updated_at: '2026-07-11T00:00:00.000Z',
    started_at: null,
    completed_at: null,
    request: { purpose: 'Confirm recovery.', effort: 'standard', viewport: 'desktop', ai_suggestions: false },
    service: { name: 'Local review', external_ai: false },
    relationship: null,
    disclosure: null,
    confirmation: null,
    decisions: [],
    result: null,
    error: null,
    internal: { target_url: 'https://example.test/' }
  };
  const dispatchId = 'control-center-agentic-review-local-dispatch';
  await store.writeJson(`${dispatchId}/operation.json`, {
    ...base,
    id: dispatchId,
    state: 'dispatching',
    started_at: '2026-07-11T00:00:00.000Z',
    dispatch: { attempt: 1, owner }
  });
  const dispatch = reviewData(await runControlCenterAgenticReviewRecover({ id: dispatchId }, { cwd })).operation;
  assert.equal(dispatch.state, 'dispatch_unknown');

  const preparationId = 'control-center-agentic-review-local-preparation';
  await store.writeJson(`${preparationId}/operation.json`, {
    ...base,
    id: preparationId,
    state: 'preparing',
    stage: 'browser_review',
    preparation: { attempt: 1, owner },
    dispatch: { attempt: 0 }
  });
  const preparation = reviewData(await runControlCenterAgenticReviewRecover({ id: preparationId }, { cwd })).operation;
  assert.equal(preparation.state, 'preparing');
  assert.equal(preparation.recovery.available, true);
  assert.equal(preparation.recovery.action, 'resume_preparation');
  const storedPreparation = await store.readJson(`${preparationId}/operation.json`);
  assert.equal(storedPreparation.preparation.interrupted, true);
  assert.equal(storedPreparation.preparation.owner, null);
});

test('Control Center rejects an incomplete saved advisory instead of reporting completion', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-control-center-forged-result-'));
  const resultPath = '.browser-debug/incomplete-advisory.json';
  const harness = createHarness(cwd, {
    async runAgenticHumanReviewRun() {
      await mkdir(path.join(cwd, '.browser-debug'), { recursive: true });
      await writeFile(path.join(cwd, resultPath), '{}\n', 'utf8');
      return {
        status: 'ok',
        data: {
          agentic_human_review_execution: {
            boundary: {
              provider_call_performed: true,
              api_call_performed: true,
              external_evidence_transfer: true
            }
          }
        },
        warnings: [],
        errors: [],
        artifacts: [{ type: 'agentic_human_review_advisory', path: resultPath }]
      };
    }
  });
  const operation = await runConfirmedExternalReview(harness);
  assert.equal(operation.state, 'dispatch_unknown');
  assert.equal(operation.result, null);
  assert.equal(operation.dispatch.retry_automatic, false);
  assert.equal(operation.dispatch.provider_call_performed, true);
  assert.equal(operation.dispatch.api_call_performed, true);
  assert.equal(operation.dispatch.external_evidence_transfer, true);
});

test('Control Center reports a known pre-send provider failure as failed', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-control-center-pre-send-failure-'));
  const harness = createHarness(cwd, {
    async runAgenticHumanReviewRun() {
      return {
        status: 'error',
        data: {
          agentic_human_review_execution: {
            boundary: {
              provider_call_performed: false,
              api_call_performed: false,
              external_evidence_transfer: false
            }
          }
        },
        warnings: [],
        errors: [{ code: 'TEST_PROVIDER_NOT_SENT', message: 'The request was not sent.', details: {} }],
        artifacts: []
      };
    }
  });
  const operation = await runConfirmedExternalReview(harness);
  assert.equal(operation.state, 'failed');
  assert.equal(operation.dispatch.provider_call_performed, false);
  assert.equal(operation.dispatch.external_evidence_transfer, false);
  assert.equal(operation.error.code, 'TEST_PROVIDER_NOT_SENT');
});

test('Control Center treats a runner exception as an unknown dispatch state', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-control-center-runner-throw-'));
  const harness = createHarness(cwd, {
    async runAgenticHumanReviewRun() {
      throw new Error('The runner stopped after dispatch may have started.');
    }
  });
  const operation = await runConfirmedExternalReview(harness);
  assert.equal(operation.state, 'dispatch_unknown');
  assert.equal(operation.dispatch.retry_automatic, false);
  assert.equal(operation.dispatch.cancel_available, false);
});

test('Control Center requires an explicit no-transfer boundary before allowing retry', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-control-center-missing-boundary-'));
  const harness = createHarness(cwd, {
    async runAgenticHumanReviewRun() {
      return {
        status: 'error',
        data: { agentic_human_review_execution: {} },
        warnings: [],
        errors: [{ code: 'TEST_UNATTESTED_FAILURE', message: 'The execution state is unavailable.', details: {} }],
        artifacts: []
      };
    }
  });
  const operation = await runConfirmedExternalReview(harness);
  assert.equal(operation.state, 'dispatch_unknown');
  assert.equal(operation.error.code, 'TEST_UNATTESTED_FAILURE');
  assert.equal(operation.dispatch.retry_automatic, false);
});

test('Control Center keeps a verified validating checkpoint recoverable across restart and lock contention', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-control-center-validation-recovery-'));
  const harness = createHarness(cwd);
  const completed = await runConfirmedExternalReview(harness);
  const id = completed.id;
  const store = createSafeLocalStore({
    workspaceRoot: cwd,
    relativeRoot: '.browser-debug/control-center-agentic-reviews',
    namespace: 'control-center-agentic-review-operations',
    maxRecordBytes: 1024 * 1024,
    maxEntries: 4096
  });
  const stored = await store.readJson(`${id}/operation.json`);
  stored.state = 'validating';
  stored.stage = 'external_review';
  stored.completed_at = null;
  stored.result = null;
  await store.writeJson(`${id}/operation.json`, stored);

  let releaseLock;
  const lockReleased = new Promise((resolve) => { releaseLock = resolve; });
  let signalLock;
  const lockAcquired = new Promise((resolve) => { signalLock = resolve; });
  const holder = store.withLock(id, async () => {
    signalLock();
    await lockReleased;
  });
  await lockAcquired;
  const blocked = await runControlCenterAgenticReviewRecover({ id }, {
    ...harness.context,
    agenticReviewOperationLockTimeoutMs: 50
  });
  assert.equal(blocked.status, 'error');
  assert.equal((await store.readJson(`${id}/operation.json`)).state, 'validating');
  releaseLock();
  await holder;

  const recovered = reviewData(await runControlCenterAgenticReviewRecover({ id }, harness.context)).operation;
  assert.equal(recovered.state, 'completed');
  assert.equal(recovered.dispatch.provider_call_performed, true);
  assert.equal(recovered.dispatch.api_call_performed, true);
  assert.equal(recovered.dispatch.external_evidence_transfer, true);
  assert.equal(recovered.result.findings.length, 1);
});

test('Control Center list fails closed when a matching operation record is unreadable', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-control-center-list-corrupt-'));
  const store = createSafeLocalStore({
    workspaceRoot: cwd,
    relativeRoot: '.browser-debug/control-center-agentic-reviews',
    namespace: 'control-center-agentic-review-operations',
    maxRecordBytes: 1024 * 1024,
    maxEntries: 4096
  });
  const id = 'control-center-agentic-review-corrupt-list-entry';
  await store.writeJson(`${id}/operation.json`, { id, state: 'completed' });
  const listed = await runControlCenterAgenticReviewList({}, { cwd });
  assert.equal(listed.status, 'error');
  assert.equal(listed.errors[0].code, 'CONTROL_CENTER_AGENTIC_REVIEW_LIST_FAILED');
});

test('Control Center AI readiness validates endpoint, credential, and concrete model values', () => {
  const base = {
    agenticReviewServiceName: 'Example Review AI',
    agenticReviewProviderId: 'generic-api-provider'
  };
  const missingValues = buildControlCenterAiReadiness({
    ...base,
    env: {
      AGENTIC_HUMAN_REVIEW_API_ENDPOINT: '',
      AGENTIC_HUMAN_REVIEW_API_TOKEN: '',
      AGENTIC_HUMAN_REVIEW_OPENAI_MODEL: ''
    }
  });
  assert.equal(missingValues.status, 'setup_required');
  const unsafeEndpoint = buildControlCenterAiReadiness({
    ...base,
    env: {
      AGENTIC_HUMAN_REVIEW_API_ENDPOINT: 'http://review.example/api',
      AGENTIC_HUMAN_REVIEW_API_TOKEN: 'set',
      AGENTIC_HUMAN_REVIEW_OPENAI_MODEL: 'review-model'
    }
  });
  assert.equal(unsafeEndpoint.status, 'setup_required');
  const unresolvedModel = buildControlCenterAiReadiness({
    ...base,
    env: {
      AGENTIC_HUMAN_REVIEW_API_ENDPOINT: 'https://review.example/api',
      AGENTIC_HUMAN_REVIEW_API_TOKEN: 'set'
    }
  });
  assert.equal(unresolvedModel.status, 'setup_required');
  const available = buildControlCenterAiReadiness({
    ...base,
    env: {
      AGENTIC_HUMAN_REVIEW_API_ENDPOINT: 'https://review.example/api',
      AGENTIC_HUMAN_REVIEW_API_TOKEN: 'set',
      AGENTIC_HUMAN_REVIEW_OPENAI_MODEL: 'review-model'
    }
  });
  assert.equal(available.status, 'available');
});

test('Control Center destination confirmation binds the effective runtime model without binding credentials', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-control-center-model-binding-'));
  const env = {
    AGENTIC_HUMAN_REVIEW_API_ENDPOINT: 'https://review.example/api',
    AGENTIC_HUMAN_REVIEW_OPENAI_MODEL: 'review-model-a'
  };
  const credentialKey = ['AGENTIC_HUMAN_REVIEW_API', 'TOKEN'].join('_');
  env[credentialKey] = ['first', 'secret'].join('-');
  const bindingContext = {
    agenticReviewServiceName: 'Example Review AI',
    agenticReviewProviderId: 'generic-api-provider',
    env
  };
  const first = buildControlCenterAiDestinationFingerprint(bindingContext, {
    modelId: 'generic-agentic-review-model'
  });
  env[credentialKey] = ['rotated', 'secret'].join('-');
  assert.equal(buildControlCenterAiDestinationFingerprint(bindingContext, {
    modelId: 'generic-agentic-review-model'
  }), first);
  env.AGENTIC_HUMAN_REVIEW_OPENAI_MODEL = 'review-model-b';
  assert.notEqual(buildControlCenterAiDestinationFingerprint(bindingContext, {
    modelId: 'generic-agentic-review-model'
  }), first);

  env.AGENTIC_HUMAN_REVIEW_OPENAI_MODEL = 'review-model-a';
  const harness = createHarness(cwd, {
    agenticReviewProviderId: 'generic-api-provider',
    agenticReviewActiveEntries: 1,
    env,
    async runAgenticHumanReviewPlan() {
      return {
        status: 'ok',
        data: {
          agentic_human_review_plan: {
            plan_hash: 'private-plan-hash',
            package_hash: 'private-package-hash',
            provider_capability_hash: 'private-capability-hash',
            provider: { id: 'generic-api-provider' },
            model: { id: 'generic-agentic-review-model' },
            surface: { id: 'private-surface' },
            transfer_permissions: { required_flags: [], classes: {} }
          }
        },
        warnings: [], errors: [],
        artifacts: [{ type: 'agentic_human_review_plan', path: '.browser-debug/plan.json' }]
      };
    }
  });
  const prepared = reviewData(await runControlCenterAgenticReviewPrepare(withHarnessAi(harness, {
    url: 'https://example.jp/', purpose: 'Check the next action.', effort: 'standard',
    viewport: 'desktop', ai_suggestions: true
  }), harness.context));
  assert.equal(prepared.operation.boundary.provider_credential_source, 'environment');
  assert.equal(prepared.operation.boundary.provider_credentials_env_only, true);
  assert.equal(prepared.operation.boundary.internal_adapter_credentials_env_only, false);
  await harness.drain();
  const confirmation = reviewData(await runControlCenterAgenticReviewConfirmation({
    operation_id: prepared.operation.id
  }, harness.context)).confirmation;
  env.AGENTIC_HUMAN_REVIEW_OPENAI_MODEL = 'review-model-b';
  const started = await runControlCenterAgenticReviewStart({
    operation_id: prepared.operation.id,
    nonce: confirmation.nonce,
    revision: confirmation.revision,
    execute_confirmed: true
  }, harness.context);
  assert.equal(started.status, 'error');
  assert.equal(started.errors[0].code, 'CONTROL_CENTER_AGENTIC_REVIEW_DESTINATION_CHANGED');
  assert.equal(harness.calls.run, 0);
  const attention = reviewData(await runControlCenterAgenticReviewStatus({
    id: prepared.operation.id
  }, harness.context)).operation;
  assert.equal(attention.state, 'needs_attention');
  assert.equal(attention.dispatch.provider_call_performed, false);
  const replacement = await runControlCenterAgenticReviewPrepare({
    url: 'https://example.jp/replacement', purpose: 'Check the replacement.', effort: 'standard',
    viewport: 'desktop', ai_suggestions: false
  }, harness.context);
  assert.equal(replacement.status, 'ok');
});

test('Control Center carries one session credential generation from GUI setup through exact review dispatch', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-control-center-session-runtime-dispatch-'));
  const credentialValue = ['runtime', 'fixture', 'value', '123456789'].join('-');
  let managedFetch = null;
  let adapterToken = null;
  let adapterId = 0;
  let responseCalls = 0;
  const runtime = await createControlCenterAiSetupRuntime({
    instanceId: 'agentic_review_session_runtime_1234567890'
  }, {
    async controlCenterAiUpstreamFetch(url, options = {}) {
      if (String(url) === 'https://api.openai.com/v1/models') {
        assert.equal(options.headers.authorization, `Bearer ${credentialValue}`);
        return new Response(JSON.stringify({ data: [
          { id: 'gpt-5.6-sol' },
          { id: 'gpt-5.6-terra' }
        ] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      assert.equal(String(url), 'https://api.openai.com/v1/responses');
      assert.equal(options.headers.authorization, `Bearer ${credentialValue}`);
      const request = JSON.parse(options.body);
      assert.equal(request.model, 'gpt-5.6-terra');
      assert.equal(request.reasoning.effort, 'max');
      responseCalls += 1;
      return new Response(JSON.stringify({ id: 'response-fixture', output: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    },
    async startControlCenterResponsesAdapter(_options, adapterContext) {
      adapterId += 1;
      managedFetch = adapterContext.fetch;
      adapterToken = adapterContext.env.AGENTIC_HUMAN_REVIEW_API_TOKEN;
      return {
        url: `http://127.0.0.1:${35700 + adapterId}/agentic-human-review`,
        async close() {}
      };
    }
  });
  try {
    const service = runtime.projection().services.find((item) => item.kind === 'api');
    const intent = runtime.createApiSubmission({ service_option_id: service.option_id, expected_revision: 0 });
    const credential = Buffer.from(credentialValue);
    const preparedConnection = await runtime.prepareApiConnection(intent.submission_id, credential);
    credential.fill(0);
    assert.equal(preparedConnection.ok, true);
    assert.equal((await runtime.beginPromotion(preparedConnection.pending).commit()).ok, true);

    const harness = createHarness(cwd, {
      agenticReviewServiceName: 'OpenAI',
      agenticReviewProviderId: 'generic-api-provider',
      agenticReviewModelId: 'gpt-5.6-terra',
      controlCenterAiConnections: [],
      async discoverControlCenterAiConnections() {
        return {
          connections: runtime.connections(),
          selection: null,
          boundary: { process_spawned: false, network_used: false, credential_values_read: false }
        };
      },
      controlCenterAiSetupRuntime: runtime
    });
    delete harness.context.controlCenterAiConnectionRecord;
    const originalRun = harness.context.runAgenticHumanReviewRun;
    harness.context.runAgenticHumanReviewRun = async (options, executionContext) => {
      assert.equal(executionContext.controlCenterAiExecutionGeneration, preparedConnection.connection.credential_generation);
      assert.equal(executionContext.env.AGENTIC_HUMAN_REVIEW_API_ENDPOINT, preparedConnection.pending.adapter.url);
      assert.equal(executionContext.env.AGENTIC_HUMAN_REVIEW_API_TOKEN, adapterToken);
      assert.notEqual(adapterToken, credentialValue);
      const planOptions = harness.calls.planOptions.at(-1);
      await managedFetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { authorization: `Bearer ${adapterToken}` },
        body: JSON.stringify({
          model: planOptions.model,
          reasoning: { effort: planOptions['provider-effort'] }
        })
      });
      return originalRun(options, executionContext);
    };

    const refreshed = await runControlCenterAiConnectionsRefresh({
      confirm: CONTROL_CENTER_AI_REFRESH_CONFIRM,
      expected_revision: 0
    }, harness.context);
    assert.equal(refreshed.status, 'ok', JSON.stringify(refreshed.errors));
    const runtimeConnection = refreshed.data.ai_connections.connections.find((connection) => connection.name === 'OpenAI');
    const terra = runtimeConnection.models.find((model) => model.name === 'GPT-5.6 Terra');
    assert.ok(terra, JSON.stringify(refreshed.data.ai_connections.connections));
    const max = terra.efforts.find((effort) => effort.name === 'Max');
    const selectionInput = {
      connection_option_id: runtimeConnection.option_id,
      model_option_id: terra.option_id,
      effort_option_id: max.option_id,
      capability_revision: refreshed.data.ai_connections.revision,
      capability_token: refreshed.data.ai_connections.capability_token,
      expected_revision: refreshed.data.ai_connections.storage_revision,
      confirm: CONTROL_CENTER_AI_SELECTION_CONFIRM
    };
    const selected = await runControlCenterAiSelectionSave(selectionInput, harness.context);
    assert.equal(selected.status, 'ok');
    const currentSelection = {
      ...selectionInput,
      capability_revision: selected.data.ai_connections.revision,
      capability_token: selected.data.ai_connections.capability_token
    };

    const first = reviewData(await runControlCenterAgenticReviewPrepare({
      url: 'https://example.jp/runtime-dispatch',
      purpose: 'Keep the selected AI model and processing level exact.',
      effort: 'deep',
      viewport: 'desktop',
      ai_suggestions: true,
      ...currentSelection
    }, harness.context));
    assert.equal(first.operation.boundary.credentials_env_only, false);
    assert.equal(first.operation.boundary.provider_credential_source, 'control_center_session');
    assert.equal(first.operation.boundary.provider_credentials_env_only, false);
    assert.equal(first.operation.boundary.internal_adapter_credentials_env_only, true);
    await harness.drain();
    const firstConfirmation = reviewData(await runControlCenterAgenticReviewConfirmation({
      operation_id: first.operation.id
    }, harness.context)).confirmation;
    assert.equal(harness.calls.planOptions[0].model, 'gpt-5.6-terra');
    assert.equal(harness.calls.planOptions[0]['provider-effort'], 'max');
    assert.equal(harness.calls.planOptions[0]['connection-binding'].credential_generation, preparedConnection.connection.credential_generation);
    const firstStarted = await runControlCenterAgenticReviewStart({
      operation_id: first.operation.id,
      nonce: firstConfirmation.nonce,
      revision: firstConfirmation.revision,
      execute_confirmed: true
    }, harness.context);
    assert.equal(firstStarted.status, 'ok');
    await harness.drain();
    assert.equal(responseCalls, 1);

    const stale = reviewData(await runControlCenterAgenticReviewPrepare({
      url: 'https://example.jp/runtime-stale',
      purpose: 'Reject an old confirmation after the session connection changes.',
      effort: 'standard',
      viewport: 'desktop',
      ai_suggestions: true,
      ...currentSelection
    }, harness.context));
    await harness.drain();
    const staleConfirmation = reviewData(await runControlCenterAgenticReviewConfirmation({
      operation_id: stale.operation.id
    }, harness.context)).confirmation;

    const replacementIntent = runtime.createApiSubmission({ service_option_id: service.option_id, expected_revision: 2 });
    const replacementCredential = Buffer.from(credentialValue);
    const replacement = await runtime.prepareApiConnection(replacementIntent.submission_id, replacementCredential);
    replacementCredential.fill(0);
    assert.equal(replacement.ok, true);
    const replacementTransaction = runtime.beginPromotion(replacement.pending);
    const replaced = await runControlCenterAiConnectionsRefresh({
      confirm: CONTROL_CENTER_AI_REFRESH_CONFIRM,
      expected_revision: selected.data.ai_connections.storage_revision
    }, {
      ...harness.context,
      controlCenterAiConnectionSnapshot: replacementTransaction.connectionSnapshot
    });
    assert.equal(replaced.status, 'ok');
    assert.equal((await replacementTransaction.commit()).ok, true);

    const refused = await runControlCenterAgenticReviewStart({
      operation_id: stale.operation.id,
      nonce: staleConfirmation.nonce,
      revision: staleConfirmation.revision,
      execute_confirmed: true
    }, harness.context);
    assert.equal(refused.status, 'error');
    assert.match(refused.errors[0].code, /^CONTROL_CENTER_(?:AI_BINDING_CHANGED|AGENTIC_REVIEW_DESTINATION_CHANGED)$/u);
    assert.equal(responseCalls, 1);
  } finally {
    await runtime.dispose();
  }
});

test('Control Center bounds active review admission and preserves an archived id collision', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-control-center-admission-'));
  const harness = createHarness(cwd, {
    agenticReviewActiveEntries: 2,
    scheduleBackground() {}
  });
  for (let index = 0; index < 2; index += 1) {
    const prepared = await runControlCenterAgenticReviewPrepare({
      url: `https://example.jp/${index}`, purpose: 'Check the next action.', effort: 'standard',
      viewport: 'desktop', ai_suggestions: false
    }, harness.context);
    assert.equal(prepared.status, 'ok');
  }
  const rejected = await runControlCenterAgenticReviewPrepare({
    url: 'https://example.jp/full', purpose: 'Check the next action.', effort: 'standard',
    viewport: 'desktop', ai_suggestions: false
  }, harness.context);
  assert.equal(rejected.status, 'error');
  assert.equal(rejected.errors[0].code, 'CONTROL_CENTER_AGENTIC_REVIEW_CAPACITY_REACHED');
  assert.equal(reviewData(await runControlCenterAgenticReviewList({}, { cwd })).total, 2);

  const recoverableCwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-control-center-admission-recovery-'));
  const recoverableStore = createSafeLocalStore({
    workspaceRoot: recoverableCwd,
    relativeRoot: '.browser-debug/control-center-agentic-reviews',
    namespace: 'control-center-agentic-review-operations',
    maxRecordBytes: 1024 * 1024,
    maxEntries: 4096
  });
  for (let index = 0; index < 2; index += 1) {
    const id = `control-center-agentic-review-capacity-terminal-${index}`;
    const timestamp = `2026-01-01T00:00:0${index}.000Z`;
    await recoverableStore.writeJson(`${id}/operation.json`, {
      schema_version: '1.0.0', type: 'control_center_agentic_review_operation', id,
      state: 'completed', stage: 'complete', created_at: timestamp, updated_at: timestamp,
      started_at: timestamp, completed_at: timestamp,
      request: { purpose: 'Completed review', effort: 'standard', viewport: 'desktop', ai_suggestions: false },
      service: { name: 'Local review', external_ai: false }, dispatch: { attempt: 0 }, decisions: [],
      result: null, error: null, internal: { target_url: `https://example.test/${index}` }
    });
  }
  const recoveredAdmission = await runControlCenterAgenticReviewPrepare({
    url: 'https://example.jp/recovered', purpose: 'Check the next action.', effort: 'standard',
    viewport: 'desktop', ai_suggestions: false
  }, {
    cwd: recoverableCwd,
    createId: () => 'control-center-agentic-review-capacity-new',
    agenticReviewActiveEntries: 2,
    scheduleBackground() {}
  });
  assert.equal(recoveredAdmission.status, 'ok');
  assert.equal(reviewData(await runControlCenterAgenticReviewList({}, { cwd: recoverableCwd })).total, 2);
  assert.equal((await runControlCenterAgenticReviewStatus({
    id: 'control-center-agentic-review-capacity-terminal-0'
  }, { cwd: recoverableCwd })).status, 'ok');

  const collisionCwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-control-center-history-collision-'));
  const collisionId = 'control-center-agentic-review-archived-collision';
  const digest = createHash('sha256').update(collisionId).digest('hex');
  const store = createSafeLocalStore({
    workspaceRoot: collisionCwd,
    relativeRoot: '.browser-debug/control-center-agentic-reviews',
    namespace: 'control-center-agentic-review-operations',
    maxRecordBytes: 1024 * 1024,
    maxEntries: 4096
  });
  const archived = {
    schema_version: '1.0.0', type: 'control_center_agentic_review_operation', id: collisionId,
    state: 'completed', stage: 'complete', created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z', started_at: null, completed_at: '2026-01-01T00:00:00.000Z',
    request: { purpose: 'Archived review', effort: 'standard', viewport: 'desktop', ai_suggestions: false },
    service: { name: 'Local review', external_ai: false }, dispatch: { attempt: 0 }, decisions: [],
    result: { findings: [{ id: 'finding-1', title: 'Archived finding' }] },
    error: null, internal: { target_url: 'https://example.test/archive' }
  };
  const archivedPath = `history/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${collisionId}.json`;
  await store.writeJson(archivedPath, archived);
  const collision = await runControlCenterAgenticReviewPrepare({
    url: 'https://example.jp/new', purpose: 'Check the next action.', effort: 'standard',
    viewport: 'desktop', ai_suggestions: false
  }, {
    cwd: collisionCwd,
    createId: () => collisionId,
    scheduleBackground() {}
  });
  assert.equal(collision.status, 'error');
  assert.deepEqual(await store.readJson(archivedPath), archived);

  const decided = await runControlCenterAgenticReviewDecision({
    operation_id: collisionId,
    finding_id: 'finding-1',
    decision: 'later'
  }, { cwd: collisionCwd });
  assert.equal(decided.status, 'ok');
  await access(path.join(
    collisionCwd,
    '.browser-debug/control-center-agentic-reviews',
    collisionId,
    'operation.json'
  ));
  await assert.rejects(store.readJson(archivedPath));
  const listedAfterDecision = reviewData(await runControlCenterAgenticReviewList({}, { cwd: collisionCwd }));
  assert.equal(listedAfterDecision.operations.some((operation) => operation.id === collisionId), true);
});

test('Control Center preferences persist only the simple safe choices', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-control-center-preferences-'));
  const rejected = await runControlCenterSetPreferences({
    default_viewport: 'both', ai_suggestions_enabled: true
  }, { cwd });
  assert.equal(rejected.status, 'error');
  const saved = await runControlCenterSetPreferences({
    default_viewport: 'mobile',
    ai_suggestions_enabled: false,
    external_send_confirmation_required: false,
    confirm: 'save-control-center-preferences'
  }, { cwd });
  assert.equal(saved.status, 'ok');
  const preferences = await readControlCenterPreferences({ cwd });
  assert.deepEqual(preferences, {
    default_viewport: 'mobile',
    ai_suggestions_enabled: false,
    external_send_confirmation_required: true
  });
});

test('Control Center agentic review schema is exported', () => {
  const schema = getSchema('control_center_agentic_review');
  assert.equal(schema.properties.type.const, 'control_center_agentic_review');
  assert.deepEqual(schema.properties.target.type, ['string', 'null']);
  assert.equal(schema.properties.external_send_confirmation_required.const, true);
  assert.deepEqual(schema.properties.boundary.properties.provider_credential_source.enum, [
    'none', 'environment', 'control_center_session', 'subscription_session'
  ]);
  assert.equal(schema.properties.boundary.required.includes('provider_credentials_env_only'), true);
  assert.equal(schema.properties.boundary.required.includes('internal_adapter_credentials_env_only'), true);
});

test('Control Center server exposes agentic review separately from the original action allowlist', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-control-center-agentic-server-'));
  const assetRoot = await createControlCenterTestAssetRoot(cwd);
  const harness = createHarness(cwd);
  const started = await startControlCenterServer({ port: 0, assetRoot }, harness.context);
  try {
    assert.equal(started.metadata.action_endpoints.length, 8);
    assert.deepEqual(started.metadata.source_intake_endpoints, [
      '/api/review-intake/upload',
      '/api/review-intake/complete',
      '/api/review-intake/results',
      '/api/review-intake/result'
    ]);
    assert.equal(started.metadata.action_endpoints.includes('/api/agentic-review/start'), false);
    assert.equal(started.metadata.agentic_review_endpoints.includes('/api/agentic-review/start'), true);
    assert.equal(started.metadata.agentic_review_endpoints.includes('/api/agentic-review/recover'), true);
    const dashboard = await fetch(new URL('/api/dashboard', started.url));
    const actionToken = (await dashboard.json()).data.control_center.action_security.token;
    const actionHeaders = {
      'Content-Type': 'application/json',
      Origin: started.url.slice(0, -1),
      'X-Trace-Cue-Action-Token': actionToken
    };
    const preparedResponse = await fetch(new URL('/api/agentic-review/prepare', started.url), {
      method: 'POST',
      headers: actionHeaders,
      body: JSON.stringify(withHarnessAi(harness, {
        url: 'https://example.jp/', purpose: '予約の分かりやすさを確認する', effort: 'standard', viewport: 'both', ai_suggestions: true
      }))
    });
    assert.equal(preparedResponse.status, 202);
    const prepared = (await preparedResponse.json()).data.control_center_agentic_review;
    await harness.drain();
    const statusResponse = await fetch(new URL(`/api/agentic-review/status?id=${encodeURIComponent(prepared.operation.id)}`, started.url));
    assert.equal(statusResponse.status, 200);
    const status = (await statusResponse.json()).data.control_center_agentic_review.operation;
    assert.equal(status.state, 'confirmation_required');
    assert.equal(status.service.name, 'Example Review AI');
    const confirmation = reviewData(await runControlCenterAgenticReviewConfirmation({
      operation_id: prepared.operation.id
    }, harness.context)).confirmation;
    reviewData(await runControlCenterAgenticReviewStart({
      operation_id: prepared.operation.id,
      nonce: confirmation.nonce,
      revision: confirmation.revision,
      execute_confirmed: true
    }, harness.context));
    await harness.drain();
    const repeatKey = repeatIdempotencyKey('k');
    const repeatedResponse = await fetch(new URL('/api/agentic-review/repeat', started.url), {
      method: 'POST',
      headers: actionHeaders,
      body: JSON.stringify({
        operation_id: prepared.operation.id,
        mode: 'recheck',
        idempotency_key: repeatKey
      })
    });
    assert.equal(repeatedResponse.status, 202);
    const repeated = (await repeatedResponse.json()).data.control_center_agentic_review;
    assert.equal(repeated.operation.parent_review.id, prepared.operation.id);
    const conflictResponse = await fetch(new URL('/api/agentic-review/repeat', started.url), {
      method: 'POST',
      headers: actionHeaders,
      body: JSON.stringify({
        operation_id: prepared.operation.id,
        mode: 'deeper',
        idempotency_key: repeatKey
      })
    });
    assert.equal(conflictResponse.status, 409);
    assert.equal(
      (await conflictResponse.json()).errors[0].code,
      'CONTROL_CENTER_AGENTIC_REVIEW_REPEAT_IDEMPOTENCY_CONFLICT'
    );
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
  }
});

test('Control Center read endpoints do not create local artifact storage', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-control-center-read-only-'));
  const assetRoot = await createControlCenterTestAssetRoot(cwd);
  const started = await startControlCenterServer({ port: 0, assetRoot }, createHarness(cwd).context);
  try {
    const dashboard = await fetch(new URL('/api/dashboard', started.url));
    assert.equal(dashboard.status, 200);
    const reviews = await fetch(new URL('/api/agentic-review/list', started.url));
    assert.equal(reviews.status, 200);
    const results = await fetch(new URL('/api/review-intake/results', started.url));
    assert.equal(results.status, 200);
    await assert.rejects(access(path.join(cwd, '.browser-debug')));
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
  }
});

test('Control Center review listing sorts the bounded store before applying the UI limit', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-control-center-list-order-'));
  const store = createSafeLocalStore({
    workspaceRoot: cwd,
    relativeRoot: '.browser-debug/control-center-agentic-reviews',
    namespace: 'control-center-agentic-review-operations',
    maxRecordBytes: 1024 * 1024,
    maxEntries: 4096
  });
  for (let index = 0; index < 101; index += 1) {
    const id = `control-center-agentic-review-list-${String(index).padStart(3, '0')}`;
    const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
    await store.writeJson(`${id}/operation.json`, {
      schema_version: '1.0.0',
      type: 'control_center_agentic_review_operation',
      id,
      state: 'completed',
      stage: 'complete',
      created_at: timestamp,
      updated_at: timestamp,
      started_at: timestamp,
      completed_at: timestamp,
      request: { purpose: `Review ${index}`, effort: 'standard', viewport: 'desktop', ai_suggestions: false },
      service: { name: 'Local review', external_ai: false },
      dispatch: { attempt: 0 },
      decisions: [],
      result: { findings: [{ id: 'finding-1', title: 'Finding' }] },
      error: null,
      internal: { target_url: `https://example.test/${index}` }
    });
  }
  const listed = runControlCenterAgenticReviewList({ limit: 100 }, { cwd });
  const result = reviewData(await listed);
  assert.equal(result.total, 101);
  assert.equal(result.operations.length, 100);
  assert.equal(result.operations[0].id, 'control-center-agentic-review-list-100');
  const decided = await runControlCenterAgenticReviewDecision({
    operation_id: 'control-center-agentic-review-list-000',
    finding_id: 'finding-1',
    decision: 'later'
  }, { cwd, now: '2026-01-02T00:00:00.000Z' });
  assert.equal(decided.status, 'ok');
  const refreshed = reviewData(await runControlCenterAgenticReviewList({ limit: 100 }, { cwd }));
  assert.equal(refreshed.operations[0].id, 'control-center-agentic-review-list-000');
});

test('Control Center passive reads retry only classified transient operation changes', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-control-center-list-retry-'));
  const id = 'control-center-agentic-review-list-retry';
  const store = createSafeLocalStore({
    workspaceRoot: cwd,
    relativeRoot: '.browser-debug/control-center-agentic-reviews',
    namespace: 'control-center-agentic-review-operations',
    maxRecordBytes: 1024 * 1024,
    maxEntries: 4096
  });
  await store.writeJson(`${id}/operation.json`, {
    schema_version: '1.0.0', type: 'control_center_agentic_review_operation', id,
    state: 'completed', stage: 'complete', created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z', started_at: '2026-01-01T00:00:00.000Z',
    completed_at: '2026-01-01T00:00:00.000Z',
    request: { purpose: 'Retry a safe list read', effort: 'standard', viewport: 'desktop', ai_suggestions: false },
    service: { name: 'Local review', external_ai: false }, dispatch: { attempt: 0 },
    decisions: [], result: { findings: [] }, error: null,
    internal: { target_url: 'https://example.test/list-retry' }
  });

  function injectedContext(code, failureCount) {
    let attempts = 0;
    return {
      context: {
        cwd,
        createControlCenterAgenticReviewStore: () => ({
          ...store,
          async readJson(relativePath, options) {
            if (relativePath === `${id}/operation.json`) {
              attempts += 1;
              if (attempts <= failureCount) {
                const error = new Error('Injected safe-store read failure.');
                error.code = code;
                throw error;
              }
            }
            return store.readJson(relativePath, options);
          }
        })
      },
      attempts: () => attempts
    };
  }

  const recovered = injectedContext('SAFE_STORE_FILE_CHANGED', 1);
  const recoveredResult = await runControlCenterAgenticReviewList({}, recovered.context);
  assert.equal(recoveredResult.status, 'ok');
  assert.equal(recovered.attempts(), 2);

  const exhausted = injectedContext('SAFE_STORE_FILE_CHANGED', 4);
  const exhaustedResult = await runControlCenterAgenticReviewList({}, exhausted.context);
  assert.equal(exhaustedResult.status, 'error');
  assert.equal(exhaustedResult.errors[0].code, 'CONTROL_CENTER_AGENTIC_REVIEW_LIST_FAILED');
  assert.equal(exhausted.attempts(), 4);

  const unclassified = injectedContext('SAFE_STORE_JSON_INVALID', 4);
  const unclassifiedResult = await runControlCenterAgenticReviewList({}, unclassified.context);
  assert.equal(unclassifiedResult.status, 'error');
  assert.equal(unclassified.attempts(), 1);

  const recoveredStatus = injectedContext('SAFE_STORE_FILE_CHANGED', 1);
  const recoveredStatusResult = await runControlCenterAgenticReviewStatus({ id }, recoveredStatus.context);
  assert.equal(recoveredStatusResult.status, 'ok');
  assert.equal(recoveredStatus.attempts(), 2);

  const recoveredMissingStatus = injectedContext('ENOENT', 1);
  const recoveredMissingStatusResult = await runControlCenterAgenticReviewStatus({ id }, recoveredMissingStatus.context);
  assert.equal(recoveredMissingStatusResult.status, 'ok');
  assert.equal(recoveredMissingStatus.attempts(), 2);

  const exhaustedStatus = injectedContext('SAFE_STORE_FILE_CHANGED', 4);
  const exhaustedStatusResult = await runControlCenterAgenticReviewStatus({ id }, exhaustedStatus.context);
  assert.equal(exhaustedStatusResult.status, 'error');
  assert.equal(exhaustedStatusResult.errors[0].code, 'CONTROL_CENTER_AGENTIC_REVIEW_READ_FAILED');
  assert.equal(exhaustedStatus.attempts(), 4);

  const exhaustedMissingStatus = injectedContext('ENOENT', 4);
  const exhaustedMissingStatusResult = await runControlCenterAgenticReviewStatus({ id }, exhaustedMissingStatus.context);
  assert.equal(exhaustedMissingStatusResult.status, 'error');
  assert.equal(exhaustedMissingStatusResult.errors[0].code, 'CONTROL_CENTER_AGENTIC_REVIEW_NOT_FOUND');
  assert.equal(exhaustedMissingStatus.attempts(), 4);

  const unclassifiedStatus = injectedContext('SAFE_STORE_JSON_INVALID', 4);
  const unclassifiedStatusResult = await runControlCenterAgenticReviewStatus({ id }, unclassifiedStatus.context);
  assert.equal(unclassifiedStatusResult.status, 'error');
  assert.equal(unclassifiedStatusResult.errors[0].code, 'CONTROL_CENTER_AGENTIC_REVIEW_READ_FAILED');
  assert.equal(unclassifiedStatus.attempts(), 1);

  let revalidationAttempts = 0;
  const revalidationResult = await runControlCenterAgenticReviewStatus({ id }, {
    cwd,
    createControlCenterAgenticReviewStore: () => ({
      ...store,
      async readJson(relativePath, options) {
        if (relativePath === `${id}/operation.json`) {
          revalidationAttempts += 1;
          if (revalidationAttempts === 1) {
            const error = new Error('Injected safe-store replacement.');
            error.code = 'SAFE_STORE_FILE_CHANGED';
            throw error;
          }
          const record = await store.readJson(relativePath, options);
          return { ...record, id: `${id}-replacement` };
        }
        return store.readJson(relativePath, options);
      }
    })
  });
  assert.equal(revalidationResult.status, 'error');
  assert.equal(revalidationResult.errors[0].code, 'CONTROL_CENTER_AGENTIC_REVIEW_READ_FAILED');
  assert.equal(revalidationAttempts, 2);
});

test('Control Center review history retires the oldest completed operations at its configured bound', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-control-center-history-'));
  const store = createSafeLocalStore({
    workspaceRoot: cwd,
    relativeRoot: '.browser-debug/control-center-agentic-reviews',
    namespace: 'control-center-agentic-review-operations',
    maxRecordBytes: 1024 * 1024,
    maxEntries: 4096
  });
  for (let index = 0; index < 3; index += 1) {
    const id = `control-center-agentic-review-history-${index}`;
    const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
    await store.writeJson(`${id}/operation.json`, {
      schema_version: '1.0.0', type: 'control_center_agentic_review_operation', id,
      state: 'completed', stage: 'complete', created_at: timestamp, updated_at: timestamp,
      started_at: timestamp, completed_at: timestamp,
      request: { purpose: `Review ${index}`, effort: 'standard', viewport: 'desktop', ai_suggestions: false },
      service: { name: 'Local review', external_ai: false }, dispatch: { attempt: 0 }, decisions: [],
      result: { findings: [{ id: 'finding-1', title: 'Finding' }] }, error: null,
      internal: { target_url: `https://example.test/${index}` }
    });
  }
  const decided = await runControlCenterAgenticReviewDecision({
    operation_id: 'control-center-agentic-review-history-2',
    finding_id: 'finding-1',
    decision: 'later'
  }, { cwd, now: '2026-01-01T00:01:00.000Z', agenticReviewHistoryEntries: 2 });
  assert.equal(decided.status, 'ok');
  const concurrentLists = await Promise.all(Array.from(
    { length: 16 },
    () => runControlCenterAgenticReviewList({}, { cwd })
  ));
  assert.equal(concurrentLists.every((result) => result.status === 'ok'), true);
  let listed;
  await waitUntil(async () => {
    listed = reviewData(await runControlCenterAgenticReviewList({}, { cwd }));
    return listed.total === 2;
  });
  assert.equal(listed.total, 2);
  assert.equal(listed.operations.some((operation) => operation.id === 'control-center-agentic-review-history-0'), false);
  const archived = reviewData(await runControlCenterAgenticReviewStatus({
    id: 'control-center-agentic-review-history-0'
  }, { cwd })).operation;
  assert.equal(archived.id, 'control-center-agentic-review-history-0');
  assert.equal(archived.state, 'completed');
});

test('Control Center history coordination preserves concurrent successful decisions', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-control-center-history-race-'));
  const store = createSafeLocalStore({
    workspaceRoot: cwd,
    relativeRoot: '.browser-debug/control-center-agentic-reviews',
    namespace: 'control-center-agentic-review-operations',
    maxRecordBytes: 1024 * 1024,
    maxEntries: 4096
  });
  const ids = ['control-center-agentic-review-history-race-a', 'control-center-agentic-review-history-race-b'];
  for (const [index, id] of ids.entries()) {
    const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
    await store.writeJson(`${id}/operation.json`, {
      schema_version: '1.0.0', type: 'control_center_agentic_review_operation', id,
      state: 'completed', stage: 'complete', created_at: timestamp, updated_at: timestamp,
      started_at: timestamp, completed_at: timestamp,
      request: { purpose: `Review ${index}`, effort: 'standard', viewport: 'desktop', ai_suggestions: false },
      service: { name: 'Local review', external_ai: false }, dispatch: { attempt: 0 }, decisions: [],
      result: { findings: [{ id: 'finding-1', title: 'Finding' }] }, error: null,
      internal: { target_url: `https://example.test/race-${index}` }
    });
  }
  const deferredRetention = deferStoreLock(store, 'history-retention');
  const decisions = ids.map((id, index) => runControlCenterAgenticReviewDecision({
    operation_id: id,
    finding_id: 'finding-1',
    decision: index === 0 ? 'fix' : 'later'
  }, {
    cwd,
    now: `2026-01-01T00:01:0${index}.000Z`,
    agenticReviewHistoryEntries: 1,
    createControlCenterAgenticReviewStore: () => deferredRetention.store
  }));
  let results;
  try {
    results = await settleWithin(Promise.all(decisions), 5000);
    await settleWithin(deferredRetention.entered, 5000);
  } finally {
    deferredRetention.release();
    await deferredRetention.settle();
  }
  assert.equal(results.every((result) => result.status === 'ok'), true);
  for (const id of ids) {
    const status = await runControlCenterAgenticReviewStatus({ id }, { cwd });
    assert.equal(status.status, 'ok');
    assert.equal(reviewData(status).operation.decisions.length, 1);
  }
});

test('Control Center history maintenance cannot block a confirmed external review dispatch', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-control-center-history-dispatch-'));
  const store = createSafeLocalStore({
    workspaceRoot: cwd,
    relativeRoot: '.browser-debug/control-center-agentic-reviews',
    namespace: 'control-center-agentic-review-operations',
    maxRecordBytes: 1024 * 1024,
    maxEntries: 4096
  });
  const deferredRetention = deferStoreLock(store, 'history-retention');
  const harness = createHarness(cwd, {
    createControlCenterAgenticReviewStore: () => deferredRetention.store
  });
  const prepared = reviewData(await runControlCenterAgenticReviewPrepare(withHarnessAi(harness, {
    url: 'https://example.jp/', purpose: 'Check the next action.', effort: 'standard',
    viewport: 'desktop', ai_suggestions: true
  }), harness.context));
  await harness.drain();
  const confirmation = reviewData(await runControlCenterAgenticReviewConfirmation({
    operation_id: prepared.operation.id
  }, harness.context)).confirmation;
  await settleWithin(deferredRetention.entered, 5000);
  try {
    const started = await settleWithin(runControlCenterAgenticReviewStart({
      operation_id: prepared.operation.id,
      nonce: confirmation.nonce,
      revision: confirmation.revision,
      execute_confirmed: true
    }, harness.context), 5000);
    assert.equal(started.status, 'ok');
    await settleWithin(harness.drain(), 5000);
    assert.equal(harness.calls.run, 1);
    const completed = reviewData(await runControlCenterAgenticReviewStatus({
      id: prepared.operation.id
    }, harness.context)).operation;
    assert.equal(completed.state, 'completed');
  } finally {
    deferredRetention.release();
    await deferredRetention.settle();
  }
});

test('Control Center history maintenance does not keep a completed child process alive', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-control-center-history-exit-'));
  const id = 'control-center-agentic-review-history-exit';
  const store = createSafeLocalStore({
    workspaceRoot: cwd,
    relativeRoot: '.browser-debug/control-center-agentic-reviews',
    namespace: 'control-center-agentic-review-operations',
    maxRecordBytes: 1024 * 1024,
    maxEntries: 4096
  });
  await store.writeJson(`${id}/operation.json`, {
    schema_version: '1.0.0', type: 'control_center_agentic_review_operation', id,
    state: 'completed', stage: 'complete', created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z', started_at: null, completed_at: '2026-01-01T00:00:00.000Z',
    request: { purpose: 'Review', effort: 'standard', viewport: 'desktop', ai_suggestions: false },
    service: { name: 'Local review', external_ai: false }, dispatch: { attempt: 0 }, decisions: [],
    result: { findings: [{ id: 'finding-1', title: 'Finding' }] }, error: null,
    internal: { target_url: 'https://example.test/' }
  });
  let releaseRetention;
  const retentionReleased = new Promise((resolve) => { releaseRetention = resolve; });
  let signalRetention;
  const retentionAcquired = new Promise((resolve) => { signalRetention = resolve; });
  const holder = store.withLock('history-retention', async () => {
    signalRetention();
    await retentionReleased;
  });
  await retentionAcquired;
  const worker = spawn(process.execPath, [path.resolve('tests/fixtures/control-center-decision-worker.mjs'), cwd, id]);
  try {
    const output = await settleWithin(collectProcess(worker), 5000);
    assert.match(output, /ok/u);
    assert.equal(worker.exitCode, 0);
  } finally {
    releaseRetention();
    await holder;
  }
});

test('Control Center repeat admission stays exactly-once across Node processes', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-control-center-repeat-process-'));
  const id = 'control-center-agentic-review-repeat-process-parent';
  const key = repeatIdempotencyKey('j');
  const store = createSafeLocalStore({
    workspaceRoot: cwd,
    relativeRoot: '.browser-debug/control-center-agentic-reviews',
    namespace: 'control-center-agentic-review-operations',
    maxRecordBytes: 1024 * 1024,
    maxEntries: 4096
  });
  await store.writeJson(`${id}/operation.json`, {
    schema_version: '2.0.0', type: 'control_center_agentic_review_operation', id,
    state: 'completed', stage: 'complete', created_at: '2026-07-14T00:00:00.000Z',
    updated_at: '2026-07-14T00:00:00.000Z', started_at: null,
    completed_at: '2026-07-14T00:00:00.000Z', relationship: null,
    request: { purpose: 'Repeat once', effort: 'standard', viewport: 'desktop', ai_suggestions: false },
    service: { name: 'Local review', external_ai: false }, dispatch: { attempt: 0 },
    decisions: [], result: { findings: [] }, error: null,
    internal: { target_url: 'https://example.test/repeat-process', connection_selection: null }
  });

  const workerPath = path.resolve('tests/fixtures/control-center-repeat-worker.mjs');
  const workers = Array.from({ length: 4 }, () => spawn(process.execPath, [workerPath, cwd, id, key]));
  const outputs = await Promise.all(workers.map((worker) => settleWithin(collectProcess(worker), 10_000)));
  assert.equal(workers.every((worker) => worker.exitCode === 0), true, outputs.join('\n'));
  const results = outputs.map((output) => JSON.parse(output.trim()));
  assert.equal(new Set(results.map((result) => result.operation_id)).size, 1);
  assert.equal(results.filter((result) => result.background_work_started === true).length, 1);
  assert.equal(results.filter((result) => result.idempotent_replay === true).length, 3);
  const listed = reviewData(await runControlCenterAgenticReviewList({}, { cwd }));
  assert.equal(listed.operations.filter((operation) => operation.parent_review?.id === id).length, 1);
  const childId = results[0].operation_id;
  const childText = await readFile(path.join(
    cwd,
    '.browser-debug',
    'control-center-agentic-reviews',
    childId,
    'operation.json'
  ), 'utf8');
  assert.doesNotMatch(childText, new RegExp(key));
});

async function settleWithin(promise, timeoutMs = 5000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Operation waited for history maintenance.')), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitUntil(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for deferred history maintenance.');
}

async function collectProcess(child) {
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });
  if (child.exitCode === null) await once(child, 'close');
  return output;
}

function deferStoreLock(store, lockName) {
  const quietWindowMs = 150;
  let signalEntered;
  const entered = new Promise((resolve) => { signalEntered = resolve; });
  let releaseLock;
  const released = new Promise((resolve) => { releaseLock = resolve; });
  let signaled = false;
  let releasedOnce = false;
  let active = 0;
  let invocations = 0;
  return {
    entered,
    release() {
      if (releasedOnce) return;
      releasedOnce = true;
      releaseLock();
    },
    async settle(timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      let quietSince = null;
      let quietInvocationCount = -1;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
        if (active === 0 && invocations === quietInvocationCount) {
          if (quietSince !== null && Date.now() - quietSince >= quietWindowMs) return;
        } else if (active === 0) {
          quietInvocationCount = invocations;
          quietSince = Date.now();
        } else {
          quietInvocationCount = -1;
          quietSince = null;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('Deferred store maintenance did not settle within the bounded test window.');
    },
    store: {
      ...store,
      async withLock(name, task, options) {
        if (name !== lockName) return store.withLock(name, task, options);
        if (!signaled) {
          signaled = true;
          signalEntered();
        }
        invocations += 1;
        active += 1;
        try {
          await released;
          return await store.withLock(name, task, options);
        } finally {
          active -= 1;
        }
      }
    }
  };
}
