import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { request } from 'node:http';
import { createControlCenterMediaReviewRuntime } from '../src/control-center-media-review.js';
import { createControlCenterMediaReviewStore } from '../src/control-center-media-review-store.js';
import { cleanupPrivateMediaOperation, createPrivateMediaOperation, updatePrivateMediaOperation } from '../src/media-private-operation.js';
import { loadMediaReviewPolicy } from '../src/media-review-policy.js';
import { startControlCenterServer } from '../src/control-center-server.js';
import { createControlCenterTestAssetRoot } from './helpers/control-center-test-assets.js';

const FIXED_NOW = '2026-07-18T00:00:00.000Z';

test('Control Center media runtime streams a one-use source into an asynchronous body-free operation', async (t) => {
  const roots = await mediaRoots(t);
  const contexts = [];
  const runtime = await createControlCenterMediaReviewRuntime({ cwd: roots.cwd, artifactRoot: '.artifacts' }, {
    ...roots.context,
    now: () => new Date(FIXED_NOW),
    inspectMediaReviewReadiness: async () => readyEnvelope(),
    planMediaReview: async (_options, context) => {
      contexts.push(context);
      return planEnvelope();
    },
    executeMediaReview: async (options, context) => {
      contexts.push(context);
      context.onMediaReviewProgress({ operation_id: options.operationId, phase: 'analyzing', percent: 40 });
      await Promise.resolve();
      context.onMediaReviewProgress({ operation_id: options.operationId, phase: 'integrating', percent: 80 });
      return completedEnvelope(options.operationId);
    }
  });
  t.after(() => runtime.dispose());

  const body = mediaBody(4096);
  const staged = await runtime.stageUpload(uploadMetadata(body), Readable.from(body));
  assert.equal(staged.status, 'ok');
  assert.match(staged.data.media_source.source_id, /^[a-f0-9]{32}$/u);
  assert.equal(staged.data.media_source.boundary.original_name_included, false);
  assert.equal(JSON.stringify(staged).includes('private-video-name'), false);

  const started = await runtime.start({
    source_id: staged.data.media_source.source_id,
    operation_id: '4'.repeat(32),
    retention: 'ephemeral',
    rights_declared: true,
    rights_confirm: 'use-owned-or-authorized-media',
    confirm: 'execute-media-review'
  });
  assert.equal(started.status, 'ok');
  assert.equal(started.data.media_review.state, 'prepared');
  assert.equal(started.data.media_review.boundary.absolute_path_included, false);

  const operationId = started.data.media_review.operation_id;
  const responseLossRetry = await runtime.start({
    source_id: staged.data.media_source.source_id,
    operation_id: operationId,
    retention: 'ephemeral',
    rights_declared: true,
    rights_confirm: 'use-owned-or-authorized-media',
    confirm: 'execute-media-review'
  });
  assert.equal(responseLossRetry.status, 'ok');
  assert.equal(responseLossRetry.data.media_review.operation_id, operationId);
  await waitForState(runtime, operationId, 'completed');
  const status = runtime.status({ operation_id: operationId });
  assert.equal(status.data.media_review.result_available, true);
  const result = runtime.result({ operation_id: operationId });
  assert.equal(result.status, 'ok');
  assert.equal(result.data.media_review_result.operation_id, operationId);
  assert.equal(result.data.media_review_result.privacy.full_transcript_in_result, false);
  assert.equal(JSON.stringify(result).includes(roots.ephemeral), false);
  assert.equal(contexts.every((context) => context.mediaInputRoot.startsWith(roots.ephemeral)), true);

  const reused = await runtime.start({
    source_id: staged.data.media_source.source_id,
    retention: 'ephemeral',
    rights_declared: true,
    rights_confirm: 'use-owned-or-authorized-media',
    confirm: 'execute-media-review'
  });
  assert.equal(reused.status, 'error');
  assert.equal(reused.errors[0].code, 'CONTROL_CENTER_MEDIA_SOURCE_UNAVAILABLE');
});

test('Control Center compares two completed public media results without replaying either review', async (t) => {
  const roots = await mediaRoots(t);
  let executions = 0;
  let comparisons = 0;
  const runtime = await createControlCenterMediaReviewRuntime({ cwd: roots.cwd, artifactRoot: '.artifacts' }, {
    ...roots.context,
    now: () => new Date(FIXED_NOW),
    planMediaReview: async () => planEnvelope(),
    executeMediaReview: async (options) => {
      executions += 1;
      return completedEnvelope(options.operationId);
    },
    buildMediaReviewComparison: (baseline, candidate, policy) => {
      comparisons += 1;
      assert.equal(policy.boundary.public_results_only, true);
      return comparisonFixture(baseline.operation_id, candidate.operation_id);
    }
  });
  t.after(() => runtime.dispose());
  for (const operationId of ['1'.repeat(32), '2'.repeat(32)]) {
    const body = mediaBody(1024);
    const staged = await runtime.stageUpload(uploadMetadata(body), Readable.from(body));
    const started = await runtime.start({
      source_id: staged.data.media_source.source_id,
      operation_id: operationId,
      retention: 'ephemeral',
      rights_declared: true,
      rights_confirm: 'use-owned-or-authorized-media',
      confirm: 'execute-media-review'
    });
    assert.equal(started.status, 'ok');
    await waitForState(runtime, operationId, 'completed');
  }
  const options = runtime.comparisonOptions();
  assert.equal(options.status, 'ok');
  assert.equal(options.data.media_review_comparison_options.options.length, 2);
  assert.equal(options.data.media_review_comparison_options.boundary.source_names_included, false);
  const compared = await runtime.compare({ baseline_operation_id: '1'.repeat(32), candidate_operation_id: '2'.repeat(32) });
  assert.equal(compared.status, 'ok');
  assert.equal(compared.data.media_review_comparison.boundary.media_reprocessed, false);
  assert.equal(executions, 2);
  assert.equal(comparisons, 1);
  const duplicate = await runtime.compare({ baseline_operation_id: '1'.repeat(32), candidate_operation_id: '1'.repeat(32) });
  assert.equal(duplicate.status, 'error');
  assert.equal(duplicate.errors[0].code, 'MEDIA_REVIEW_COMPARISON_DISTINCT_RESULTS_REQUIRED');
});

test('Control Center keeps ordinary media review available when comparison policy is unusable', async (t) => {
  const roots = await mediaRoots(t);
  const runtime = await createControlCenterMediaReviewRuntime({ cwd: roots.cwd, artifactRoot: '.artifacts' }, {
    ...roots.context,
    now: () => new Date(FIXED_NOW),
    mediaReviewComparisonPolicy: {},
    planMediaReview: async () => planEnvelope(),
    executeMediaReview: async (options) => {
      const envelope = completedEnvelope(options.operationId);
      if (options.operationId === '2'.repeat(32)) envelope.data.result.status = 'insufficient';
      return envelope;
    }
  });
  t.after(() => runtime.dispose());
  for (const operationId of ['1'.repeat(32), '2'.repeat(32), '3'.repeat(32)]) {
    const body = mediaBody(512);
    const staged = await runtime.stageUpload(uploadMetadata(body), Readable.from(body));
    await runtime.start({
      source_id: staged.data.media_source.source_id,
      operation_id: operationId,
      retention: 'ephemeral',
      rights_declared: true,
      rights_confirm: 'use-owned-or-authorized-media',
      confirm: 'execute-media-review'
    });
    await waitForState(runtime, operationId, 'completed');
  }
  assert.equal(runtime.list().data.media_reviews.length, 3);
  assert.equal(runtime.result({ operation_id: '1'.repeat(32) }).status, 'ok');
  const options = runtime.comparisonOptions().data.media_review_comparison_options.options;
  assert.deepEqual(options.map((option) => option.operation_id).sort(), ['1'.repeat(32), '3'.repeat(32)]);
  const comparison = await runtime.compare({ baseline_operation_id: '1'.repeat(32), candidate_operation_id: '3'.repeat(32) });
  assert.equal(comparison.status, 'error');
  assert.equal(comparison.errors[0].code, 'MEDIA_REVIEW_COMPARISON_POLICY_INVALID');
  assert.equal(runtime.result({ operation_id: '3'.repeat(32) }).status, 'ok');
});

test('Control Center retries private cleanup after an upload fails before source publication', async (t) => {
  const roots = await mediaRoots(t);
  const policy = structuredClone(await loadMediaReviewPolicy());
  policy.operation.cleanup_retry_delay_ms = 5;
  let cleanupCalls = 0;
  const runtime = await createControlCenterMediaReviewRuntime({ cwd: roots.cwd }, {
    ...roots.context,
    mediaReviewPolicy: policy,
    cleanupPrivateMediaOperation: async (operation, options, context) => {
      cleanupCalls += 1;
      if (cleanupCalls === 1) {
        const error = new Error('simulated transient cleanup failure');
        error.code = 'MEDIA_PRIVATE_OPERATION_CLEANUP_FAILED';
        throw error;
      }
      return cleanupPrivateMediaOperation(operation, options, context);
    }
  });
  t.after(() => runtime.dispose());
  const body = mediaBody(512);
  async function* brokenUpload() {
    yield body.subarray(0, 128);
    throw new Error('simulated upload transport loss');
  }
  const staged = await runtime.stageUpload(uploadMetadata(body), Readable.from(brokenUpload()));
  assert.equal(staged.status, 'error');
  for (let attempt = 0; attempt < 100 && cleanupCalls < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(cleanupCalls >= 2);
});

test('Control Center media runtime explains URL capability without network or URL secrets', async (t) => {
  const roots = await mediaRoots(t);
  const runtime = await createControlCenterMediaReviewRuntime({ cwd: roots.cwd }, roots.context);
  t.after(() => runtime.dispose());
  const decision = await runtime.sourceDecision({ url: 'https://www.youtube.com/watch?v=abcDEF_1234&token=SECRET#fragment' });
  assert.equal(decision.status, 'ok');
  assert.deepEqual(decision.data.source_decision.capabilities, ['playback_inspection']);
  assert.equal(decision.data.source_decision.boundary.network_performed, false);
  assert.equal(decision.data.source_decision.boundary.download_performed, false);
  assert.equal(JSON.stringify(decision).includes('SECRET'), false);
});

test('Control Center media readiness stays passive until an explicit local setup check', async (t) => {
  const roots = await mediaRoots(t);
  let inspections = 0;
  let providerStatus = 'ready';
  const runtime = await createControlCenterMediaReviewRuntime({ cwd: roots.cwd }, {
    ...roots.context,
    inspectMediaReviewReadiness: async () => {
      inspections += 1;
      return {
        status: 'ok',
        data: {
          readiness: {
            status: providerStatus === 'ready' ? 'ready' : 'unavailable',
            transcript_provider: { status: providerStatus, limitations: [], method: { executable: '/private/provider' } },
            technical_analyzer: { status: 'ready', limitations: [], method: { revision: 'private-revision' } }
          }
        }
      };
    }
  });
  t.after(() => runtime.dispose());
  const passive = await runtime.inspectReadiness();
  assert.equal(passive.data.readiness.status, 'uninspected');
  assert.equal(inspections, 0);
  const refreshed = await runtime.inspectReadiness({ refresh: true });
  assert.equal(refreshed.data.readiness.status, 'ready');
  assert.equal(inspections, 1);
  assert.equal(JSON.stringify(refreshed).includes('/private/provider'), false);
  assert.equal(JSON.stringify(refreshed).includes('private-revision'), false);
  providerStatus = 'unsupported';
  const unsupported = await runtime.inspectReadiness({ refresh: true });
  assert.equal(unsupported.data.readiness.status, 'unsupported');
  assert.equal(unsupported.data.readiness.transcript_provider.status, 'unsupported');
});

test('Control Center serializes competing starts so a staged source is consumed once', async (t) => {
  const roots = await mediaRoots(t);
  let plans = 0;
  const runtime = await createControlCenterMediaReviewRuntime({ cwd: roots.cwd }, {
    ...roots.context,
    inspectMediaReviewReadiness: async () => readyEnvelope(),
    planMediaReview: async () => { plans += 1; return planEnvelope(); },
    executeMediaReview: async (options) => completedEnvelope(options.operationId)
  });
  t.after(() => runtime.dispose());
  const body = mediaBody(512);
  const staged = await runtime.stageUpload(uploadMetadata(body), Readable.from(body));
  const request = {
    source_id: staged.data.media_source.source_id,
    retention: 'ephemeral',
    rights_declared: true,
    rights_confirm: 'use-owned-or-authorized-media',
    confirm: 'execute-media-review'
  };
  const [left, right] = await Promise.all([
    runtime.start({ ...request, operation_id: '1'.repeat(32) }),
    runtime.start({ ...request, operation_id: '2'.repeat(32) })
  ]);
  assert.equal([left.status, right.status].filter((status) => status === 'ok').length, 1);
  assert.equal([left, right].find((value) => value.status === 'error').errors[0].code, 'CONTROL_CENTER_MEDIA_SOURCE_UNAVAILABLE');
  assert.equal(plans, 1);
});

test('Control Center media runtime enforces upload, rights, cancellation, and explicit retained cleanup', async (t) => {
  const roots = await mediaRoots(t);
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const runtime = await createControlCenterMediaReviewRuntime({ cwd: roots.cwd }, {
    ...roots.context,
    inspectMediaReviewReadiness: async () => readyEnvelope(),
    planMediaReview: async () => planEnvelope(),
    executeMediaReview: async (options, context) => {
      context.onMediaReviewProgress({ operation_id: options.operationId, phase: 'analyzing', percent: 25 });
      await Promise.race([
        pending,
        new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }))
      ]);
      return options.signal.aborted ? failedEnvelope('MEDIA_REVIEW_CANCELLED') : completedEnvelope(options.operationId, 'project-retained');
    },
    cleanupMediaReview: async (input) => ({
      status: input.confirm === 'cleanup-media-review' ? 'ok' : 'error',
      data: { cleanup_receipt: { schema_version: '1.0.0', type: 'media_cleanup_receipt', operation_id: input.operationId, status: 'cleaned', body_included: false } },
      warnings: [], errors: [], artifacts: []
    })
  });
  t.after(async () => { release(); await runtime.dispose(); });

  const body = mediaBody(512);
  const unsupported = await runtime.stageUpload({ ...uploadMetadata(body), originalName: 'video.exe' }, Readable.from(body));
  assert.equal(unsupported.errors[0].code, 'CONTROL_CENTER_MEDIA_UPLOAD_TYPE_INVALID');

  const staged = await runtime.stageUpload(uploadMetadata(body), Readable.from(body));
  const denied = await runtime.start({ source_id: staged.data.media_source.source_id, retention: 'project-retained' });
  assert.equal(denied.errors[0].code, 'CONTROL_CENTER_MEDIA_RIGHTS_CONFIRMATION_REQUIRED');

  const started = await runtime.start({
    source_id: staged.data.media_source.source_id,
    retention: 'project-retained',
    rights_declared: true,
    rights_confirm: 'use-owned-or-authorized-media',
    confirm: 'execute-media-review'
  });
  const operationId = started.data.media_review.operation_id;
  await waitForState(runtime, operationId, 'running');
  const cancelling = runtime.cancel({ operation_id: operationId });
  assert.equal(cancelling.status, 'ok');
  assert.equal(cancelling.data.media_review.state, 'cancelling');
  await waitForState(runtime, operationId, 'cancelled');
  const wrongRetention = await runtime.cleanup({ operation_id: operationId, retention: 'ephemeral' });
  assert.equal(wrongRetention.errors[0].code, 'CONTROL_CENTER_MEDIA_RETENTION_MISMATCH');
  const cleaned = await runtime.cleanup({ operation_id: operationId, retention: 'project-retained' });
  assert.equal(cleaned.status, 'ok');
  assert.equal(runtime.status({ operation_id: operationId }).data.media_review.state, 'cleaned');
});

test('Control Center media runtime restores bounded results and marks uncertain work interrupted without replay', async (t) => {
  const roots = await mediaRoots(t);
  const storeContext = { ...roots.context, cwd: roots.cwd, artifactRoot: '.artifacts', now: () => new Date(FIXED_NOW) };
  const operationId = '9'.repeat(32);
  const store = createControlCenterMediaReviewStore(storeContext);
  await store.writeOperation(savedOperation(operationId, 'running'));
  let executions = 0;
  const runtime = await createControlCenterMediaReviewRuntime({ cwd: roots.cwd, artifactRoot: '.artifacts' }, {
    ...storeContext,
    executeMediaReview: async () => { executions += 1; return failedEnvelope('UNEXPECTED_REPLAY'); }
  });
  t.after(() => runtime.dispose());
  const recovered = runtime.status({ operation_id: operationId });
  assert.equal(recovered.status, 'ok');
  assert.equal(recovered.data.media_review.state, 'interrupted');
  assert.equal(recovered.data.media_review.errors[0].code, 'CONTROL_CENTER_MEDIA_REVIEW_INTERRUPTED');
  assert.equal(executions, 0);
  const persisted = (await store.load()).find((entry) => entry.operation.operation_id === operationId);
  assert.equal(persisted.operation.state, 'interrupted');
});

test('Control Center startup binds private reconciliation to saved cleanup state', async (t) => {
  const roots = await mediaRoots(t);
  const oldContext = { ...roots.context, now: new Date('2026-06-01T00:00:00.000Z') };
  const store = createControlCenterMediaReviewStore({ ...roots.context, cwd: roots.cwd, artifactRoot: '.artifacts' });
  const fixtures = [
    { id: 'b'.repeat(32), state: 'completed_retained', mode: 'expired' },
    { id: 'c'.repeat(32), state: 'cleanup_required', mode: 'expired' },
    { id: 'd'.repeat(32), state: 'completed_retained', mode: 'quarantine' },
    { id: 'e'.repeat(32), state: 'completed_retained', mode: 'already_deleted' }
  ];
  for (const fixture of fixtures) {
    let operation = await createPrivateMediaOperation({ operationId: fixture.id, retention: 'project-retained' }, oldContext);
    operation = await updatePrivateMediaOperation(operation, { state: 'running' }, oldContext);
    if (fixture.state === 'cleanup_required') {
      operation = await updatePrivateMediaOperation(operation, { state: 'failed' }, oldContext);
      operation = await updatePrivateMediaOperation(operation, { state: 'cleanup_required' }, oldContext);
    } else {
      operation = await updatePrivateMediaOperation(operation, { state: 'completed_retained' }, oldContext);
    }
    if (fixture.mode === 'quarantine') {
      await rename(operation.root, path.join(operation.base, `.cleanup-${fixture.id}-${'b'.repeat(16)}`));
    } else if (fixture.mode === 'already_deleted') {
      assert.equal((await cleanupPrivateMediaOperation(operation, { allowRetained: true }, oldContext)).status, 'cleaned');
    }
    const projection = savedOperation(fixture.id, fixture.state);
    projection.retention = 'project-retained';
    projection.private_payload_retained = true;
    projection.cleanup_available = true;
    projection.capabilities.cleanup = true;
    await store.writeOperation(projection);
  }
  await store.writeResult(fixtures[0].id, completedEnvelope(fixtures[0].id, 'project-retained').data.result);

  const runtime = await createControlCenterMediaReviewRuntime({ cwd: roots.cwd, artifactRoot: '.artifacts' }, {
    ...roots.context,
    now: () => new Date('2026-09-01T00:00:00.000Z')
  });
  t.after(() => runtime.dispose());
  for (const fixture of fixtures) {
    const recovered = runtime.status({ operation_id: fixture.id }).data.media_review;
    assert.equal(recovered.state, 'cleaned', fixture.mode);
    assert.equal(recovered.private_payload_retained, false, fixture.mode);
    assert.equal(recovered.cleanup_available, false, fixture.mode);
  }
  assert.equal(runtime.result({ operation_id: fixtures[0].id }).status, 'ok');
});

test('Control Center media runtime reconciles result-first publication and refuses success without a result', async (t) => {
  const roots = await mediaRoots(t);
  const storeContext = { ...roots.context, cwd: roots.cwd, artifactRoot: '.artifacts', now: () => new Date(FIXED_NOW) };
  const publishedId = '8'.repeat(32);
  const missingId = '6'.repeat(32);
  const store = createControlCenterMediaReviewStore(storeContext);
  await store.writeOperation(savedOperation(publishedId, 'running'));
  await store.writeResult(publishedId, completedEnvelope(publishedId).data.result);
  await store.writeOperation(savedOperation(missingId, 'completed'));
  let executions = 0;
  const runtime = await createControlCenterMediaReviewRuntime({ cwd: roots.cwd, artifactRoot: '.artifacts' }, {
    ...storeContext,
    executeMediaReview: async () => { executions += 1; return failedEnvelope('UNEXPECTED_REPLAY'); }
  });
  t.after(() => runtime.dispose());

  assert.equal(runtime.status({ operation_id: publishedId }).data.media_review.state, 'completed');
  assert.equal(runtime.result({ operation_id: publishedId }).status, 'ok');
  assert.equal(runtime.status({ operation_id: missingId }).data.media_review.state, 'interrupted');
  assert.equal(runtime.result({ operation_id: missingId }).errors[0].code, 'CONTROL_CENTER_MEDIA_RESULT_NOT_READY');
  assert.equal(executions, 0);
});

test('Control Center retains cleanup authority after a failed retained review', async (t) => {
  const roots = await mediaRoots(t);
  const runtime = await createControlCenterMediaReviewRuntime({ cwd: roots.cwd }, {
    ...roots.context,
    inspectMediaReviewReadiness: async () => readyEnvelope(),
    planMediaReview: async () => planEnvelope(),
    executeMediaReview: async (options, context) => {
      context.onPrivateMediaOperation({ operationId: options.operationId });
      return {
        status: 'error', data: {}, warnings: [], artifacts: [],
        errors: [{ code: 'MEDIA_PROVIDER_FAILED', message: 'Review stopped.', details: { cleanup_status: 'not_required' } }]
      };
    },
    cleanupMediaReview: async (input) => ({
      status: 'ok',
      data: { cleanup_receipt: { schema_version: '1.0.0', type: 'media_cleanup_receipt', operation_id: input.operationId, status: 'cleaned', body_included: false } },
      warnings: [], errors: [], artifacts: []
    })
  });
  t.after(() => runtime.dispose());
  const body = mediaBody(512);
  const staged = await runtime.stageUpload(uploadMetadata(body), Readable.from(body));
  const started = await runtime.start({
    source_id: staged.data.media_source.source_id,
    operation_id: '3'.repeat(32),
    retention: 'project-retained',
    rights_declared: true,
    rights_confirm: 'use-owned-or-authorized-media',
    confirm: 'execute-media-review'
  });
  await waitForState(runtime, started.data.media_review.operation_id, 'failed');
  const failed = runtime.status({ operation_id: started.data.media_review.operation_id }).data.media_review;
  assert.equal(failed.private_payload_retained, true);
  assert.equal(failed.cleanup_available, true);
  const cleaned = await runtime.cleanup({ operation_id: failed.operation_id, retention: 'project-retained' });
  assert.equal(cleaned.status, 'ok');
  assert.equal(runtime.status({ operation_id: failed.operation_id }).data.media_review.private_payload_retained, false);
});

test('Control Center does not advertise stale cleanup after ephemeral result persistence fails', async (t) => {
  const roots = await mediaRoots(t);
  const safeStore = memorySafeStore({ failResultWrite: true });
  const runtime = await createControlCenterMediaReviewRuntime({ cwd: roots.cwd }, {
    ...roots.context,
    createControlCenterMediaReviewStore: () => safeStore,
    inspectMediaReviewReadiness: async () => readyEnvelope(),
    planMediaReview: async () => planEnvelope(),
    executeMediaReview: async (options, context) => {
      context.onPrivateMediaOperation({ operationId: options.operationId });
      const completed = completedEnvelope(options.operationId);
      completed.data.operation.cleanup_available = false;
      return completed;
    }
  });
  t.after(() => runtime.dispose());
  const body = mediaBody(512);
  const staged = await runtime.stageUpload(uploadMetadata(body), Readable.from(body));
  const started = await runtime.start({
    source_id: staged.data.media_source.source_id,
    operation_id: 'a'.repeat(32),
    retention: 'ephemeral',
    rights_declared: true,
    rights_confirm: 'use-owned-or-authorized-media',
    confirm: 'execute-media-review'
  });
  await waitForState(runtime, started.data.media_review.operation_id, 'failed');
  const failed = runtime.status({ operation_id: started.data.media_review.operation_id }).data.media_review;
  assert.equal(failed.private_payload_retained, false);
  assert.equal(failed.cleanup_available, false);
  assert.equal(failed.capabilities.cleanup, false);
});

test('Control Center media store refuses transcript bodies and private paths even when boundary flags are forged', async (t) => {
  const roots = await mediaRoots(t);
  const store = createControlCenterMediaReviewStore({ ...roots.context, cwd: roots.cwd, artifactRoot: '.artifacts' });
  const operationId = '5'.repeat(32);
  const valid = completedEnvelope(operationId).data.result;
  const transcriptBody = structuredClone(valid);
  transcriptBody.transcript.segments = [{ text: 'forged full transcript' }];
  await assert.rejects(store.writeResult(operationId, transcriptBody), { code: 'CONTROL_CENTER_MEDIA_RESULT_RECORD_INVALID' });
  const privatePath = structuredClone(valid);
  privatePath.advisory_findings.push({ classification: 'advisory_evaluation', evidence: ['/home/private/video.mp4'] });
  await assert.rejects(store.writeResult(operationId, privatePath), { code: 'CONTROL_CENTER_MEDIA_RESULT_RECORD_INVALID' });
});

test('Control Center media HTTP surface keeps passive reads separate from protected execution', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'trace-cue-media-http-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const assetRoot = await createControlCenterTestAssetRoot(cwd);
  const calls = [];
  const operationId = '7'.repeat(32);
  const fakeRuntime = {
    inspectReadiness: async ({ refresh = false } = {}) => { calls.push(`readiness:${refresh}`); return readyEnvelope(); },
    sourceDecision: async () => ({ status: 'ok', data: { source_decision: { capabilities: ['metadata_only'], boundary: { network_performed: false } } }, warnings: [], errors: [], artifacts: [] }),
    stageUpload: async (metadata, stream) => {
      let bytes = 0;
      for await (const chunk of stream) bytes += chunk.length;
      calls.push(`upload:${bytes}`);
      return { status: 'ok', data: { media_source: { source_id: '6'.repeat(32), boundary: { raw_media_included: false } } }, warnings: [], errors: [], artifacts: [] };
    },
    start: async () => { calls.push('start'); return { status: 'ok', data: { media_review: savedOperation(operationId, 'prepared') }, warnings: [], errors: [], artifacts: [] }; },
    list: () => {
      calls.push('list');
      return { status: 'ok', data: { media_reviews: [savedOperation(operationId, 'completed')] }, warnings: [], errors: [], artifacts: [] };
    },
    status: () => ({ status: 'ok', data: { media_review: savedOperation(operationId, 'completed') }, warnings: [], errors: [], artifacts: [] }),
    result: () => completedEnvelope(operationId),
    comparisonOptions: () => {
      calls.push('comparison-options');
      return { status: 'ok', data: { media_review_comparison_options: comparisonOptionsFixture(operationId) }, warnings: [], errors: [], artifacts: [] };
    },
    compare: () => {
      calls.push('comparison');
      return { status: 'ok', data: { media_review_comparison: comparisonFixture('8'.repeat(32), operationId) }, warnings: [], errors: [], artifacts: [] };
    },
    cancel: () => ({ status: 'ok', data: { media_review: savedOperation(operationId, 'cancelling') }, warnings: [], errors: [], artifacts: [] }),
    cleanup: async () => ({ status: 'ok', data: { cleanup_receipt: { status: 'cleaned', body_included: false } }, warnings: [], errors: [], artifacts: [] }),
    dispose: async () => {}
  };
  const started = await startControlCenterServer({ port: 0, assetRoot }, { cwd, now: FIXED_NOW, controlCenterMediaReviewRuntime: fakeRuntime });
  t.after(() => closeServer(started.server));
  assert.equal(started.metadata.media_review_endpoints.includes('/api/media-review/start'), true);
  assert.equal(started.metadata.media_review_endpoints.includes('/api/media-review/comparison'), true);

  const readiness = await fetch(new URL('/api/media-review/readiness', started.url));
  assert.equal(readiness.status, 200);
  assert.equal((await readiness.json()).data.readiness.status, 'ready');
  const list = await fetch(new URL('/api/media-review/list', started.url));
  assert.equal(list.status, 200);
  assert.equal(calls.includes('start'), false);
  const options = await fetch(new URL('/api/media-review/comparison-options', started.url));
  assert.equal(options.status, 200);
  assert.equal((await options.json()).data.media_review_comparison_options.options.length, 1);
  const comparison = await fetch(new URL(`/api/media-review/comparison?baseline=${'8'.repeat(32)}&candidate=${operationId}`, started.url));
  assert.equal(comparison.status, 200);
  assert.equal((await comparison.json()).data.media_review_comparison.boundary.media_reprocessed, false);

  const dashboard = await fetch(new URL('/api/dashboard', started.url));
  assert.equal(dashboard.status, 200);
  const dashboardBody = await dashboard.json();
  assert.equal(dashboardBody.data.control_center.media_reviews[0].operation_id, operationId);
  assert.equal(calls.filter((call) => call === 'list').length, 2);

  const unprotected = await fetch(new URL('/api/media-review/start', started.url), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  });
  assert.equal(unprotected.status, 403);
  const headers = await actionHeaders(started);
  const body = mediaBody(128);
  const uploaded = await httpRequest({
    hostname: '127.0.0.1', port: started.config.port, path: '/api/media-review/upload', method: 'POST',
    headers: { Host: `127.0.0.1:${started.config.port}`, ...headers, 'Content-Type': 'video/mp4', 'Content-Length': String(body.length), 'X-Trace-Cue-File-Name': encodeURIComponent('private.mp4') }
  }, body);
  assert.equal(uploaded.statusCode, 201);
  assert.equal(calls.includes(`upload:${body.length}`), true);

  const startedReview = await httpRequest({
    hostname: '127.0.0.1', port: started.config.port, path: '/api/media-review/start', method: 'POST',
    headers: { Host: `127.0.0.1:${started.config.port}`, ...headers, 'Content-Type': 'application/json' }
  }, Buffer.from(JSON.stringify({ source_id: '6'.repeat(32) })));
  assert.equal(startedReview.statusCode, 202);
  assert.equal(calls.includes('start'), true);
});

async function mediaRoots(t) {
  const parent = path.join(os.homedir(), '.local', 'state', 'trace-cue-control-center-media-tests');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(path.join(parent, 'runtime-'));
  const cwd = path.join(root, 'workspace');
  const ephemeral = path.join(root, 'ephemeral');
  const retained = path.join(root, 'retained');
  await mkdir(cwd, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  return { cwd, ephemeral, retained, context: { ephemeralMediaRoot: ephemeral, retainedMediaRoot: retained } };
}

function mediaBody(size) {
  return Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(size, 3)]);
}

function uploadMetadata(body) {
  return {
    originalName: encodeURIComponent('private-video-name.mp4'),
    contentType: 'video/mp4',
    contentLength: String(body.length),
    contentEncoding: ''
  };
}

function readyEnvelope() {
  return { status: 'ok', data: { readiness: { schema_version: '1.0.0', type: 'media_review_readiness', status: 'ready' } }, warnings: [], errors: [], artifacts: [] };
}

function planEnvelope() {
  return { status: 'ok', data: { plan: { executable: true, plan_hash: 'a'.repeat(64) } }, warnings: [], errors: [], artifacts: [] };
}

function completedEnvelope(operationId, retention = 'ephemeral') {
  return {
    status: 'ok',
    data: {
      operation: { state: retention === 'project-retained' ? 'completed_retained' : 'completed' },
      result: {
        schema_version: '1.0.0', type: 'media_review_result', operation_id: operationId,
        status: 'completed', media_identity: { sha256: '1'.repeat(64), bytes: 4096, format: 'iso-base-media' },
        source_decision: {}, analysis_settings: {}, toolchain: {},
        technical_analysis: { boundary: { raw_media_included: false, raw_audio_included: false, raw_frames_included: false, absolute_paths_included: false } },
        transcript: {
          segment_count: 0,
          boundary: { body_included: false, absolute_paths_included: false, raw_process_output_included: false, external_send_performed: false }
        },
        timeline: { boundary: { full_transcript_included: false, raw_media_included: false } },
        deterministic_findings: [], advisory_findings: [],
        content_evidence: {}, resource_guard: {}, limitations: [],
        privacy: {
          retention,
          full_transcript_in_result: false,
          raw_media_persisted_outside_private_root: false,
          full_transcript_persisted_outside_private_root: false,
          external_send_performed: false
        },
        boundary: {
          absolute_paths_included: false,
          raw_media_included: false,
          raw_audio_included: false,
          raw_frames_included: false,
          full_transcript_included: false,
          raw_process_output_included: false,
          external_send_enabled: false,
          deterministic_and_advisory_separated: true
        }
      }
    },
    warnings: [], errors: [], artifacts: []
  };
}

function comparisonOptionsFixture(operationId) {
  return {
    schema_version: '1.0.0', type: 'media_review_comparison_options',
    options: [{ operation_id: operationId, created_at: FIXED_NOW, duration_us: 1_000_000, finding_counts: { deterministic: 1, advisory: 2 } }],
    boundary: {
      public_results_only: true, absolute_paths_included: false, source_names_included: false,
      raw_media_included: false, full_transcript_included: false, network_performed: false
    }
  };
}

function comparisonFixture(baselineOperationId, candidateOperationId) {
  return {
    schema_version: '1.0.0', type: 'media_review_comparison', status: 'comparable',
    baseline: { operation_id: baselineOperationId, status: 'completed' }, candidate: { operation_id: candidateOperationId, status: 'completed_with_limitations' },
    metric_diffs: [], deterministic_finding_changes: [], advisory_finding_changes: [],
    summary: {
      deterministic: { status: 'unchanged' }, advisory: { status: 'unchanged' },
      deterministic_metric_assessments: { improved: 0, regressed: 0, unchanged: 0, changed: 0, inconclusive: 0, unavailable: 0 },
      provider_metric_assessments: { improved: 0, regressed: 0, unchanged: 0, changed: 0, inconclusive: 0, unavailable: 0 },
      advisory_metric_assessments: { improved: 0, regressed: 0, unchanged: 0, changed: 0, inconclusive: 0, unavailable: 0 },
      combined_quality_score_included: false
    },
    limitations: ['comparison_reads_bounded_public_results_only'],
    privacy: {
      public_results_only: true, raw_media_read: false, raw_audio_read: false, raw_frames_read: false,
      full_transcript_read: false, private_payload_read: false, absolute_paths_included: false,
      external_send_performed: false
    },
    boundary: {
      read_only: true, media_reprocessed: false, provider_called: false, technical_analyzer_called: false,
      browser_launched: false, network_performed: false, artifact_written: false, mcp_execution_exposed: false,
      deterministic_and_advisory_separated: true, combined_quality_score_included: false, gate_effect: 'none'
    }
  };
}

function failedEnvelope(code) {
  return { status: 'error', data: {}, warnings: [], errors: [{ code, message: 'Review stopped.', details: {} }], artifacts: [] };
}

function savedOperation(operationId, state) {
  return {
    schema_version: '1.0.0',
    type: 'media_review_operation',
    operation_id: operationId,
    state,
    retention: 'ephemeral',
    created_at: FIXED_NOW,
    updated_at: FIXED_NOW,
    progress: { phase: state, percent: 25 },
    capabilities: { status: true, cancel: true, cleanup: false, result: false },
    result_available: false,
    cleanup_available: false,
    errors: [],
    boundary: {
      absolute_path_included: false,
      private_locator_included: false,
      source_name_included: false,
      raw_media_included: false,
      full_transcript_included: false
    }
  };
}

async function waitForState(runtime, operationId, expected) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = runtime.status({ operation_id: operationId });
    if (status.data?.media_review?.state === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`media operation did not reach ${expected}`);
}

async function actionHeaders(started) {
  const response = await fetch(new URL('/api/dashboard', started.url));
  const body = await response.json();
  return {
    Origin: started.url.slice(0, -1),
    'X-Trace-Cue-Action-Token': body.data.control_center.action_security.token
  };
}

function httpRequest(options, body = Buffer.alloc(0)) {
  return new Promise((resolve, reject) => {
    const outgoing = request(options, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({ statusCode: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    outgoing.on('error', reject);
    if (body.length) outgoing.write(body);
    outgoing.end();
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function memorySafeStore({ failResultWrite = false } = {}) {
  const records = new Map();
  return {
    async listDirectories() {
      return [...new Set([...records.keys()].map((key) => key.split('/')[0]))];
    },
    async readJson(relative) {
      if (!records.has(relative)) {
        const error = new Error('missing fixture record');
        error.code = 'ENOENT';
        throw error;
      }
      return structuredClone(records.get(relative));
    },
    async writeJson(relative, value) {
      if (failResultWrite && relative.endsWith('/result.json')) {
        const error = new Error('simulated result persistence failure');
        error.code = 'CONTROL_CENTER_MEDIA_RESULT_PERSISTENCE_FAILED';
        throw error;
      }
      records.set(relative, structuredClone(value));
    },
    async removeDirectory(relative) {
      for (const key of [...records.keys()]) if (key.startsWith(`${relative}/`)) records.delete(key);
    }
  };
}
