import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  getSchema,
  readControlCenterPreferences,
  runControlCenterAgenticReviewConfirmation,
  runControlCenterAgenticReviewDecision,
  runControlCenterAgenticReviewList,
  runControlCenterAgenticReviewPrepare,
  runControlCenterAgenticReviewRepeat,
  runControlCenterAgenticReviewStart,
  runControlCenterAgenticReviewStatus,
  runControlCenterSetPreferences,
  startControlCenterServer
} from '../src/api.js';

function createHarness(cwd, overrides = {}) {
  const tasks = [];
  const calls = { review: 0, propose: 0, plan: 0, run: 0 };
  let id = 0;
  const context = {
    cwd,
    now: () => new Date('2026-07-11T00:00:00.000Z'),
    createId: () => `control-center-agentic-review-test-${++id}`,
    agenticReviewServiceName: 'Example Review AI',
    agenticReviewProviderId: 'test-provider',
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
            provider: { id: 'test-provider' },
            model: { id: 'private-model' },
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
        agentic_human_review_advisory: { status: 'completed' },
        non_engineer_summary: {
          main_takeaway: 'Make the next action easier to find.',
          top_concerns: ['The main action is easy to miss.']
        },
        agentic_human_review_findings: [{
          id: 'finding-primary-action',
          message: 'The main action is easy to miss.',
          impact: 'First-time visitors may stop before booking.',
          suggested_fix: 'Place the main action near the first explanation.'
        }],
        agentic_human_review_action_plan: { suggested_fixes: ['Move the main action higher.'] },
        owner_decision_requests: []
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
  assert.equal(JSON.stringify(ready).includes('private-model'), false);
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
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'operation.json'), `${JSON.stringify({
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
  }, null, 2)}\n`, 'utf8');
  const result = reviewData(await runControlCenterAgenticReviewStatus({ id }, { cwd })).operation;
  assert.equal(result.state, 'dispatch_unknown');
  assert.equal(result.dispatch.retry_automatic, false);
  assert.equal(result.dispatch.cancel_available, false);
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
  const harness = createHarness(cwd);
  const started = await startControlCenterServer({ port: 0 }, harness.context);
  try {
    assert.equal(started.metadata.action_endpoints.length, 8);
    assert.equal(started.metadata.action_endpoints.includes('/api/agentic-review/start'), false);
    assert.equal(started.metadata.agentic_review_endpoints.includes('/api/agentic-review/start'), true);
    const preparedResponse = await fetch(new URL('/api/agentic-review/prepare', started.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
