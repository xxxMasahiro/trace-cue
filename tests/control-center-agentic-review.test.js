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
  getSchema,
  readControlCenterPreferences,
  runControlCenterAgenticReviewConfirmation,
  runControlCenterAgenticReviewDecision,
  runControlCenterAgenticReviewList,
  runControlCenterAgenticReviewPrepare,
  runControlCenterAgenticReviewRecover,
  runControlCenterAgenticReviewRepeat,
  runControlCenterAgenticReviewStart,
  runControlCenterAgenticReviewStatus,
  runControlCenterSetPreferences,
  startControlCenterServer
} from '../src/api.js';
import { captureProcessIdentity, createSafeLocalStore } from '../src/safe-local-store.js';
import { createControlCenterTestAssetRoot } from './helpers/control-center-test-assets.js';

async function runConfirmedExternalReview(harness) {
  const prepared = reviewData(await runControlCenterAgenticReviewPrepare({
    url: 'https://example.jp/',
    purpose: '確認する',
    effort: 'standard',
    viewport: 'desktop',
    ai_suggestions: true
  }, harness.context));
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
  const calls = { review: 0, propose: 0, plan: 0, run: 0 };
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
    async runAgenticHumanReviewPlan() {
      calls.plan += 1;
      return {
        status: 'ok',
        data: {
          agentic_human_review_plan: {
            plan_hash: 'private-plan-hash',
            package_hash: 'private-package-hash',
            provider_capability_hash: 'private-capability-hash',
            provider: { id: 'injected-runner' },
            model: { id: 'injected-local-model' },
            surface: { id: 'private-surface' },
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
    async runAgenticHumanReviewRun() {
      calls.run += 1;
      const resultPath = '.browser-debug/advisory.json';
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
        provider: { id: 'injected-runner' },
        model: { id: 'injected-local-model' },
        transfer_permissions: { required_flags: ['allow-page-text', 'allow-url'] },
        execution: {
          id: 'test-execution',
          result_path: resultPath,
          provider_call_performed: true,
          api_call_performed: true,
          external_evidence_transfer: true
        },
        boundary: {
          provider_call_performed: true,
          api_call_performed: true,
          external_evidence_transfer: true
        }
      })}\n`, 'utf8');
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
    },
    ...overrides
  };
  return {
    context,
    calls,
    async drain() {
      while (tasks.length > 0) await tasks.shift();
    }
  };
}

function reviewData(result) {
  assert.equal(result.status, 'ok');
  return result.data.control_center_agentic_review;
}

test('Control Center executes one external review only after one-time disclosure confirmation', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-control-center-agentic-'));
  const harness = createHarness(cwd);
  const prepared = reviewData(await runControlCenterAgenticReviewPrepare({
    url: 'https://example.jp/reserve?private=query',
    purpose: '初めての利用者が迷わず予約を完了できるか知りたい',
    effort: 'deep',
    viewport: 'both',
    ai_suggestions: true
  }, harness.context));
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
  assert.equal(JSON.stringify(ready).includes('injected-local-model'), false);
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

  const decided = reviewData(await runControlCenterAgenticReviewDecision({
    operation_id: id,
    finding_id: 'finding-primary-action',
    decision: 'fix'
  }, harness.context)).operation;
  assert.equal(decided.decisions[0].value, 'fix');
  assert.equal(decided.stage, 'complete');

  const repeated = reviewData(await runControlCenterAgenticReviewRepeat({
    operation_id: id,
    mode: 'recheck'
  }, harness.context));
  assert.notEqual(repeated.operation.id, id);
  assert.equal(repeated.operation.parent_review.id, id);
  assert.equal(repeated.operation.parent_review.repeat_mode, 'recheck');
  await harness.drain();
  assert.equal(harness.calls.review, 2);
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
  const prepared = reviewData(await runControlCenterAgenticReviewPrepare({
    url: 'https://example.jp/', purpose: 'Check the next action.', effort: 'standard',
    viewport: 'desktop', ai_suggestions: true
  }, harness.context));
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
    const preparedResponse = await fetch(new URL('/api/agentic-review/prepare', started.url), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: started.url.slice(0, -1),
        'X-Trace-Cue-Action-Token': actionToken
      },
      body: JSON.stringify({
        url: 'https://example.jp/', purpose: '予約の分かりやすさを確認する', effort: 'standard', viewport: 'both', ai_suggestions: true
      })
    });
    assert.equal(preparedResponse.status, 202);
    const prepared = (await preparedResponse.json()).data.control_center_agentic_review;
    await harness.drain();
    const statusResponse = await fetch(new URL(`/api/agentic-review/status?id=${encodeURIComponent(prepared.operation.id)}`, started.url));
    assert.equal(statusResponse.status, 200);
    const status = (await statusResponse.json()).data.control_center_agentic_review.operation;
    assert.equal(status.state, 'confirmation_required');
    assert.equal(status.service.name, 'Example Review AI');
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

  let releaseRetention;
  const retentionHeld = new Promise((resolve) => { releaseRetention = resolve; });
  let signalRetention;
  const retentionAcquired = new Promise((resolve) => { signalRetention = resolve; });
  const holder = store.withLock('history-retention', async () => {
    signalRetention();
    await retentionHeld;
  });
  await retentionAcquired;
  const decisions = ids.map((id, index) => runControlCenterAgenticReviewDecision({
    operation_id: id,
    finding_id: 'finding-1',
    decision: index === 0 ? 'fix' : 'later'
  }, {
    cwd,
    now: `2026-01-01T00:01:0${index}.000Z`,
    agenticReviewHistoryEntries: 1
  }));
  let results;
  try {
    results = await settleWithin(Promise.all(decisions));
  } finally {
    releaseRetention();
    await holder;
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
  const harness = createHarness(cwd);
  const prepared = reviewData(await runControlCenterAgenticReviewPrepare({
    url: 'https://example.jp/', purpose: 'Check the next action.', effort: 'standard',
    viewport: 'desktop', ai_suggestions: true
  }, harness.context));
  await harness.drain();
  const confirmation = reviewData(await runControlCenterAgenticReviewConfirmation({
    operation_id: prepared.operation.id
  }, harness.context)).confirmation;
  const store = createSafeLocalStore({
    workspaceRoot: cwd,
    relativeRoot: '.browser-debug/control-center-agentic-reviews',
    namespace: 'control-center-agentic-review-operations',
    maxRecordBytes: 1024 * 1024,
    maxEntries: 4096
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
  try {
    const started = await settleWithin(runControlCenterAgenticReviewStart({
      operation_id: prepared.operation.id,
      nonce: confirmation.nonce,
      revision: confirmation.revision,
      execute_confirmed: true
    }, harness.context));
    assert.equal(started.status, 'ok');
    await settleWithin(harness.drain());
    assert.equal(harness.calls.run, 1);
    const completed = reviewData(await runControlCenterAgenticReviewStatus({
      id: prepared.operation.id
    }, harness.context)).operation;
    assert.equal(completed.state, 'completed');
  } finally {
    releaseRetention();
    await holder;
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
    const output = await settleWithin(collectProcess(worker), 1500);
    assert.match(output, /ok/u);
    assert.equal(worker.exitCode, 0);
  } finally {
    releaseRetention();
    await holder;
  }
});

async function settleWithin(promise, timeoutMs = 1000) {
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
