import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, appendFile, link, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import {
  completeControlCenterIntake,
  getControlCenterIntakeResult,
  getSchema,
  listControlCenterIntakeResults,
  recoverPendingControlCenterIntakePublications,
  runControlCenterLaunch,
  startControlCenterServer,
  stageControlCenterIntake
} from '../src/api.js';
import { captureProcessIdentity, createSafeLocalStore, readStableBoundedFileHandle, withCrashSafeTransition } from '../src/safe-local-store.js';
import { createControlCenterTestAssetRoot } from './helpers/control-center-test-assets.js';

const WORKER_COORDINATION_TIMEOUT_MS = 15_000;
const WORKER_TERMINATION_GRACE_MS = 1000;
const WORKER_KILL_GRACE_MS = 1000;

test('bounded descriptor reads reject a file changed after inspection', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-bounded-read-'));
  const file = path.join(cwd, 'record.json');
  await writeFile(file, '{"ok":true}\n', 'utf8');
  const handle = await open(file, 'r');
  try {
    const expected = await handle.stat();
    await appendFile(file, 'changed', 'utf8');
    await assert.rejects(
      readStableBoundedFileHandle(handle, { expected, maxBytes: 1024 }),
      /changed while it was being read/
    );
  } finally {
    await handle.close();
  }
});

test('private store rejects hardlinked records and symlinked namespaces', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-safe-store-'));
  const store = createSafeLocalStore({
    workspaceRoot: cwd,
    relativeRoot: '.browser-debug/private-test',
    namespace: 'private-test'
  });
  await store.writeJson('records/one.json', { ok: true });
  const original = path.join(cwd, '.browser-debug', 'private-test', 'records', 'one.json');
  const linked = path.join(cwd, '.browser-debug', 'private-test', 'records', 'two.json');
  await link(original, linked);
  await assert.rejects(store.readJson('records/one.json'), /private regular file/);

  const outside = await mkdtemp(path.join(tmpdir(), 'trace-cue-safe-store-outside-'));
  const symlinkCwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-safe-store-link-'));
  await mkdir(path.join(symlinkCwd, '.browser-debug'), { recursive: true });
  await symlink(outside, path.join(symlinkCwd, '.browser-debug', 'control-center-intake'));
  const staged = await stageControlCenterIntake({
    sourceKind: 'document_text',
    originalName: 'notes.txt',
    contentType: 'text/plain',
    contentLength: 5
  }, Readable.from([Buffer.from('hello')]), { cwd: symlinkCwd });
  assert.equal(staged.status, 'error');
});

test('private store never adopts or cleans an existing markerless directory', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-safe-store-markerless-'));
  const storeRoot = path.join(cwd, '.browser-debug', 'control-center-intake');
  const filesRoot = path.join(storeRoot, 'files');
  await mkdir(filesRoot, { recursive: true, mode: 0o700 });
  await writeFile(path.join(filesRoot, 'valuable.txt'), 'keep this file', { mode: 0o600 });
  const body = Buffer.from('new intake', 'utf8');
  const staged = await stageControlCenterIntake({
    sourceKind: 'document_text', originalName: 'notes.txt', contentType: 'text/plain', contentLength: body.length
  }, Readable.from([body]), { cwd });
  assert.equal(staged.status, 'error');
  assert.equal(staged.errors[0].code, 'SAFE_STORE_MARKER_MISSING');
  assert.equal(await readFile(path.join(filesRoot, 'valuable.txt'), 'utf8'), 'keep this file');
  await assert.rejects(access(path.join(storeRoot, '.trace-cue-store')));
});

test('private store serializes separate Node processes without stealing a live lock', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-safe-store-processes-'));
  const worker = path.resolve('tests/fixtures/safe-store-lock-worker.mjs');
  const first = spawn(process.execPath, [worker, cwd, '350', '1000'], { stdio: ['ignore', 'pipe', 'pipe'] });
  await waitForOutput(first.stdout, 'acquired');
  const second = spawn(process.execPath, [worker, cwd, '0', '80'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const secondOutput = await collectProcess(second);
  assert.equal(second.exitCode, 2);
  assert.match(secondOutput, /error:SAFE_STORE_LOCK_TIMEOUT/);
  const firstOutput = await collectProcess(first);
  assert.equal(first.exitCode, 0);
  assert.match(firstOutput, /released/);
  const third = spawn(process.execPath, [worker, cwd, '0', '500'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const thirdOutput = await collectProcess(third);
  assert.equal(third.exitCode, 0);
  assert.match(thirdOutput, /acquired/);
});

test('private store releases its known lock after the transition release window is exhausted', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-safe-store-release-fallback-'));
  const store = createSafeLocalStore({
    workspaceRoot: cwd,
    relativeRoot: '.browser-debug/private-test',
    namespace: 'private-test'
  });
  const lockDirectory = path.join(cwd, '.browser-debug', 'private-test', '.locks');
  const logicalLock = path.join(lockDirectory, 'release-fallback.lock');
  let releaseTransition;
  const transitionReleased = new Promise((resolve) => { releaseTransition = resolve; });
  let signalTransition;
  const transitionAcquired = new Promise((resolve) => { signalTransition = resolve; });
  let blocker;

  await store.withLock('release-fallback', async () => {
    blocker = withCrashSafeTransition({
      directory: lockDirectory,
      prefix: 'release-fallback.lock.transition-',
      timeoutMs: 1000,
      async task() {
        signalTransition();
        await transitionReleased;
      }
    });
    await transitionAcquired;
  }, { timeoutMs: 80 });

  await assert.rejects(access(logicalLock));
  releaseTransition();
  await blocker;
  const reacquired = await store.withLock('release-fallback', async () => 'reacquired', { timeoutMs: 500 });
  assert.equal(reacquired, 'reacquired');
});

test('crash-safe transition serializes contenders that finish candidate creation together', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'trace-cue-transition-barrier-'));
  let arrivals = 0;
  let releaseBarrier;
  const barrier = new Promise((resolve) => { releaseBarrier = resolve; });
  let active = 0;
  let maximumActive = 0;
  const contender = async () => {
    let firstAttempt = true;
    while (true) {
      const result = await withCrashSafeTransition({
        directory,
        prefix: 'shared-transition-',
        onPhase: firstAttempt ? async (phase) => {
          if (phase !== 'candidate-created') return;
          arrivals += 1;
          if (arrivals === 2) releaseBarrier();
          await barrier;
        } : undefined,
        task: async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 30));
          active -= 1;
        }
      });
      firstAttempt = false;
      if (result.entered) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  await Promise.all([contender(), contender()]);
  assert.equal(maximumActive, 1);
  assert.deepEqual(await readdir(directory), []);
});

test('private store serializes concurrent recovery of one dead lock', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-safe-store-dead-lock-'));
  const store = createSafeLocalStore({
    workspaceRoot: cwd,
    relativeRoot: '.browser-debug/cross-process-lock-test',
    namespace: 'cross-process-lock-test'
  });
  await store.writeJson('seed.json', { ready: true });
  const locks = path.join(cwd, '.browser-debug', 'cross-process-lock-test', '.locks');
  await mkdir(locks, { recursive: true, mode: 0o700 });
  await writeFile(path.join(locks, 'shared.lock'), `${JSON.stringify({
    schema_version: '1.0.0',
    pid: 99999999,
    process_identity: 'dead-process',
    nonce: 'stale-owner',
    created_at: '2026-07-12T00:00:00.000Z'
  })}\n`, { mode: 0o600 });

  const worker = path.resolve('tests/fixtures/safe-store-lock-worker.mjs');
  const startedAt = Date.now();
  const workers = [
    spawn(process.execPath, [worker, cwd, '120', '1500'], { stdio: ['ignore', 'pipe', 'pipe'] }),
    spawn(process.execPath, [worker, cwd, '120', '1500'], { stdio: ['ignore', 'pipe', 'pipe'] })
  ];
  const outputs = await Promise.all(workers.map(collectProcess));
  assert.equal(workers.every((workerProcess) => workerProcess.exitCode === 0), true, outputs.join('\n'));
  assert.ok(Date.now() - startedAt >= 200, 'recovered critical sections must not overlap');
  assert.deepEqual(await readdir(locks), []);
});

test('private store recovers crashed legacy and ticketed transition owners', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-safe-store-dead-transition-'));
  const store = createSafeLocalStore({
    workspaceRoot: cwd,
    relativeRoot: '.browser-debug/transition-recovery-test',
    namespace: 'transition-recovery-test'
  });
  await store.writeJson('seed.json', { ready: true });
  const locks = path.join(cwd, '.browser-debug', 'transition-recovery-test', '.locks');
  await mkdir(locks, { recursive: true, mode: 0o700 });
  const deadOwner = {
    schema_version: '1.0.0',
    pid: 99999999,
    process_identity: 'dead-process',
    nonce: 'd'.repeat(32),
    created_at: '2026-07-12T00:00:00.000Z'
  };
  await writeFile(path.join(locks, 'shared.lock.transition'), `${JSON.stringify(deadOwner)}\n`, { mode: 0o600 });
  assert.equal(await store.withLock('shared', async () => 'legacy-recovered', { timeoutMs: 1000 }), 'legacy-recovered');

  const ticketedOwner = { ...deadOwner, nonce: 'e'.repeat(32), choosing: false, ticket: 1 };
  await writeFile(path.join(locks, `shared.lock.transition-${ticketedOwner.nonce}`), `${JSON.stringify(ticketedOwner)}\n`, { mode: 0o600 });
  assert.equal(await store.withLock('shared', async () => 'ticket-recovered', { timeoutMs: 1000 }), 'ticket-recovered');
  assert.deepEqual(await readdir(locks), []);
});

test('private store recovers old partial transition publications', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-safe-store-partial-transition-'));
  const store = createSafeLocalStore({
    workspaceRoot: cwd,
    relativeRoot: '.browser-debug/partial-transition-test',
    namespace: 'partial-transition-test'
  });
  await store.writeJson('seed.json', { ready: true });
  const locks = path.join(cwd, '.browser-debug', 'partial-transition-test', '.locks');
  await mkdir(locks, { recursive: true, mode: 0o700 });
  const old = new Date(Date.now() - 5000);
  const legacyPartial = path.join(locks, 'shared.lock.transition');
  await writeFile(legacyPartial, '{"partial":', { mode: 0o600 });
  await utimes(legacyPartial, old, old);
  assert.equal(await store.withLock('shared', async () => 'legacy-partial-recovered', { timeoutMs: 1000 }), 'legacy-partial-recovered');

  const partial = path.join(locks, `shared.lock.transition-${'f'.repeat(32)}`);
  await writeFile(partial, '{"partial":', { mode: 0o600 });
  await utimes(partial, old, old);
  assert.equal(await store.withLock('shared', async () => 'partial-recovered', { timeoutMs: 1000 }), 'partial-recovered');

  const pending = path.join(locks, `.transition-pending-99999999-${'a'.repeat(16)}-${'g'.repeat(32)}`);
  await writeFile(pending, '', { mode: 0o600 });
  assert.equal(await store.withLock('shared', async () => 'pending-recovered', { timeoutMs: 1000 }), 'pending-recovered');
  assert.deepEqual(await readdir(locks), []);
});

test('opaque intake stages UTF-8 text and exposes only a purpose-specific result', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-intake-text-'));
  const text = Buffer.from('# Notes\nThe primary action is difficult to find.\n', 'utf8');
  const staged = await stageControlCenterIntake({
    sourceKind: 'document_text',
    originalName: 'private-notes.md',
    contentType: 'text/markdown',
    contentLength: text.length
  }, Readable.from([text.subarray(0, 8), text.subarray(8)]), { cwd });
  assert.equal(staged.status, 'ok');
  const intake = staged.data.control_center_intake.intake;
  assert.match(intake.id, /^[a-f0-9]{32}$/);
  assert.equal(intake.source_kind, 'document_text');
  assert.equal(intake.original_file_name_included, false);
  assert.equal(JSON.stringify(staged).includes('private-notes.md'), false);
  assert.equal(JSON.stringify(staged).includes('.browser-debug'), false);
  const receiptBody = await readFile(path.join(cwd, '.browser-debug', 'control-center-intake', 'receipts', `${intake.id}.json`), 'utf8');
  assert.equal(receiptBody.includes('private-notes.md'), false);

  const completed = await completeControlCenterIntake({
    intake_id: intake.id,
    purpose: 'Help a non-engineer understand the next improvement.',
    effort: 'standard'
  }, { cwd, now: '2026-07-13T00:00:00.000Z' });
  assert.equal(completed.status, 'ok');
  const result = completed.data.control_center_intake.result;
  assert.equal(result.outcome, 'review_proposal_ready');
  assert.equal(result.external_ai_review_completed, false);
  assert.equal(JSON.stringify(result).includes('.browser-debug'), false);
  assert.equal(result.review_method, 'standard');
  const listed = await listControlCenterIntakeResults({}, { cwd });
  assert.equal(listed.status, 'ok');
  assert.deepEqual(listed.data.control_center_intake.results, [result]);
  const opened = await getControlCenterIntakeResult({ id: intake.id }, { cwd });
  assert.deepEqual(opened.data.control_center_intake.result, result);
  const duplicate = await completeControlCenterIntake({
    intake_id: intake.id,
    purpose: 'Try to run it twice.',
    effort: 'xhigh'
  }, { cwd });
  assert.equal(duplicate.status, 'ok');
  const publicSchema = JSON.parse(await readFile('schemas/control-center-intake.schema.json', 'utf8'));
  assert.deepEqual(getSchema('control_center_intake'), publicSchema);
});

test('intake history archives the oldest completed result without deleting direct access', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-intake-history-'));
  const ids = [];
  for (let index = 0; index < 3; index += 1) {
    const text = Buffer.from(`Review notes ${index}`, 'utf8');
    const staged = await stageControlCenterIntake({
      sourceKind: 'document_text', originalName: 'notes.md', contentType: 'text/markdown', contentLength: text.length
    }, Readable.from([text]), { cwd, now: `2026-07-13T00:00:0${index}.000Z`, intakeHistoryEntries: 2 });
    assert.equal(staged.status, 'ok');
    const id = staged.data.control_center_intake.intake.id;
    ids.push(id);
    const completed = await completeControlCenterIntake({
      intake_id: id,
      purpose: `Make step ${index} clearer.`,
      effort: 'standard'
    }, { cwd, now: `2026-07-13T00:00:0${index}.500Z`, intakeHistoryEntries: 2 });
    assert.equal(completed.status, 'ok');
  }
  let listed;
  await waitUntil(async () => {
    listed = await listControlCenterIntakeResults({}, { cwd });
    return listed.data.control_center_intake.results.length === 2;
  }, WORKER_COORDINATION_TIMEOUT_MS);
  assert.equal(listed.status, 'ok');
  assert.equal(listed.data.control_center_intake.results.length, 2);
  assert.equal(listed.data.control_center_intake.results.some((result) => result.id === ids[0]), false);
  const archived = await getControlCenterIntakeResult({ id: ids[0] }, { cwd });
  assert.equal(archived.status, 'ok');
  assert.equal(archived.data.control_center_intake.result.id, ids[0]);
  const duplicate = await completeControlCenterIntake({
    intake_id: ids[0], purpose: 'Do not execute twice.', effort: 'standard'
  }, { cwd });
  assert.equal(duplicate.status, 'ok');
});

test('intake history waits for in-flight publication and preserves its completed result', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-intake-history-race-'));
  const stagedIds = [];
  for (const label of ['older', 'newer']) {
    const body = Buffer.from(`${label} review notes`, 'utf8');
    const staged = await stageControlCenterIntake({
      sourceKind: 'document_text', originalName: `${label}.md`, contentType: 'text/markdown', contentLength: body.length
    }, Readable.from([body]), { cwd, intakeHistoryEntries: 1 });
    stagedIds.push(staged.data.control_center_intake.intake.id);
  }
  const [olderId, newerId] = stagedIds;
  const store = createSafeLocalStore({
    workspaceRoot: cwd,
    relativeRoot: '.browser-debug/control-center-intake',
    namespace: 'control-center-intake',
    maxRecordBytes: 32 * 1024,
    maxEntries: 100
  });
  let releasePublication;
  const publicationReleased = new Promise((resolve) => { releasePublication = resolve; });
  let signalPublished;
  const published = new Promise((resolve) => { signalPublished = resolve; });
  const olderPublication = store.withLock(`intake-complete-${olderId}`, async () => {
    const receipt = await store.readJson(`receipts/${olderId}.json`, { maxBytes: 32 * 1024 });
    const completedAt = '2026-07-13T00:00:00.000Z';
    const result = {
      schema_version: '1.0.0', type: 'control_center_intake_result', id: olderId,
      label: 'Selected document', source_kind: 'document_text', outcome: 'review_proposal_ready',
      completed_at: completedAt, external_ai_review_completed: false,
      review_goal: 'Keep the older result.', review_method: 'standard',
      summary: { characters: 18, sections: 1 }
    };
    receipt.state = 'processing';
    receipt.pending_completed_at = completedAt;
    receipt.pending_result_sha256 = canonicalDigest(result);
    await store.writeJson(`receipts/${olderId}.json`, receipt, { maxBytes: 32 * 1024 });
    await store.writeJson(`results/${olderId}.json`, result, { maxBytes: 32 * 1024 });
    signalPublished();
    await publicationReleased;
    await store.removeFile(receipt.file_relative, { maxBytes: 2 * 1024 * 1024 });
    receipt.state = 'completed';
    receipt.consumed_at = completedAt;
    receipt.finished_at = receipt.consumed_at;
    receipt.source_released_at = completedAt;
    receipt.result_sha256 = receipt.pending_result_sha256;
    delete receipt.pending_result_sha256;
    delete receipt.pending_completed_at;
    await store.writeJson(`receipts/${olderId}.json`, receipt, { maxBytes: 32 * 1024 });
  }, { timeoutMs: 30_000 });
  await published;
  const newerCompletion = completeControlCenterIntake({
    intake_id: newerId, purpose: 'Keep the newer result.', effort: 'standard'
  }, { cwd, now: '2026-07-13T00:00:01.000Z', intakeHistoryEntries: 1 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  releasePublication();
  await olderPublication;
  assert.equal((await newerCompletion).status, 'ok');
  const older = await getControlCenterIntakeResult({ id: olderId }, { cwd });
  assert.equal(older.status, 'ok');
  assert.equal(older.data.control_center_intake.result.summary.characters, 18);
  const duplicate = await completeControlCenterIntake({
    intake_id: olderId, purpose: 'Do not execute again.', effort: 'standard'
  }, { cwd });
  assert.equal(duplicate.status, 'ok');
});

test('intake completion is not changed to an error by deferred history maintenance', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-intake-history-deferred-'));
  const body = Buffer.from('Review notes', 'utf8');
  const staged = await stageControlCenterIntake({
    sourceKind: 'document_text', originalName: 'notes.md', contentType: 'text/markdown', contentLength: body.length
  }, Readable.from([body]), { cwd });
  const id = staged.data.control_center_intake.intake.id;
  const store = createSafeLocalStore({
    workspaceRoot: cwd,
    relativeRoot: '.browser-debug/control-center-intake',
    namespace: 'control-center-intake',
    maxRecordBytes: 32 * 1024,
    maxEntries: 100
  });
  let releaseRetention;
  const retentionReleased = new Promise((resolve) => { releaseRetention = resolve; });
  let signalRetention;
  const retentionAcquired = new Promise((resolve) => { signalRetention = resolve; });
  const holder = store.withLock('intake-history', async () => {
    signalRetention();
    await retentionReleased;
  });
  await retentionAcquired;
  try {
    const completed = await settleWithin(completeControlCenterIntake({
      intake_id: id, purpose: 'Make the next step clearer.', effort: 'standard'
    }, { cwd }));
    assert.equal(completed.status, 'ok');
    const opened = await getControlCenterIntakeResult({ id }, { cwd });
    assert.equal(opened.status, 'ok');
    assert.equal(opened.data.control_center_intake.result.outcome, 'review_proposal_ready');
  } finally {
    releaseRetention();
    await holder;
  }
});

test('expired cleanup retains a completed receipt until explicit history cleanup', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-intake-completed-retention-'));
  const body = Buffer.from('Review notes', 'utf8');
  const staged = await stageControlCenterIntake({
    sourceKind: 'document_text', originalName: 'notes.md', contentType: 'text/markdown', contentLength: body.length
  }, Readable.from([body]), { cwd, now: '2026-07-13T00:00:00.000Z' });
  const id = staged.data.control_center_intake.intake.id;
  const completed = await completeControlCenterIntake({
    intake_id: id, purpose: 'Keep the completion record.', effort: 'standard'
  }, { cwd, now: '2026-07-13T00:00:01.000Z' });
  assert.equal(completed.status, 'ok');

  const laterBody = Buffer.from('Later notes', 'utf8');
  const later = await stageControlCenterIntake({
    sourceKind: 'document_text', originalName: 'later.md', contentType: 'text/markdown', contentLength: laterBody.length
  }, Readable.from([laterBody]), { cwd, now: '2026-07-14T01:00:00.000Z' });
  assert.equal(later.status, 'ok');
  const opened = await getControlCenterIntakeResult({ id }, { cwd });
  assert.equal(opened.status, 'ok');
  const duplicate = await completeControlCenterIntake({
    intake_id: id, purpose: 'Do not execute twice.', effort: 'standard'
  }, { cwd, now: '2026-07-14T01:00:01.000Z' });
  assert.equal(duplicate.status, 'ok');
});

test('Playwright intake keeps timeout and skipped counts in the saved Control Center result', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-intake-playwright-summary-'));
  const payload = Buffer.from(JSON.stringify({
    suites: [{
      specs: [{
        title: 'booking',
        tests: [
          { title: 'times out', projectName: 'chromium', results: [{ status: 'timedOut', attachments: [] }] },
          { title: 'is skipped', projectName: 'chromium', results: [{ status: 'skipped', attachments: [] }] }
        ]
      }]
    }]
  }), 'utf8');
  const staged = await stageControlCenterIntake({
    sourceKind: 'playwright_result',
    originalName: 'private-results.json',
    contentType: 'application/json',
    contentLength: payload.length
  }, Readable.from([payload]), { cwd });
  assert.equal(staged.status, 'ok');
  const completed = await completeControlCenterIntake({
    intake_id: staged.data.control_center_intake.intake.id
  }, { cwd, now: '2026-07-13T00:00:00.000Z' });
  assert.equal(completed.status, 'ok');
  assert.deepEqual(completed.data.control_center_intake.result.summary, {
    status: 'failed',
    total: 2,
    failed: 0,
    passed: 0,
    timed_out: 1,
    skipped: 1
  });
});

test('Playwright intake never treats all-skipped or interrupted results as successful evidence', async () => {
  for (const [reportedStatus, expected] of [
    ['skipped', { status: 'empty', failed: 0, skipped: 1 }],
    ['interrupted', { status: 'failed', failed: 1, skipped: 0 }]
  ]) {
    const cwd = await mkdtemp(path.join(tmpdir(), `trace-cue-intake-playwright-${reportedStatus}-`));
    const payload = Buffer.from(JSON.stringify({
      suites: [{ specs: [{ title: 'booking', tests: [{
        title: reportedStatus,
        projectName: 'chromium',
        results: [{ status: reportedStatus, attachments: [] }]
      }] }] }]
    }), 'utf8');
    const staged = await stageControlCenterIntake({
      sourceKind: 'playwright_result',
      originalName: 'private-results.json',
      contentType: 'application/json',
      contentLength: payload.length
    }, Readable.from([payload]), { cwd });
    const completed = await completeControlCenterIntake({
      intake_id: staged.data.control_center_intake.intake.id
    }, { cwd, now: '2026-07-13T00:00:00.000Z' });
    assert.equal(completed.status, 'ok');
    assert.deepEqual(completed.data.control_center_intake.result.summary, {
      status: expected.status,
      total: 1,
      failed: expected.failed,
      passed: 0,
      timed_out: 0,
      skipped: expected.skipped
    });
  }
});

test('intake honors the selected artifact root, bounds stalled uploads, and accepts WebP variants', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-intake-boundaries-'));
  const text = Buffer.from('Private review notes', 'utf8');
  const custom = await stageControlCenterIntake({
    sourceKind: 'document_text', originalName: 'notes.txt', contentType: 'text/plain', contentLength: text.length
  }, Readable.from([text]), { cwd, artifactRoot: '.local-evidence' });
  assert.equal(custom.status, 'ok');
  assert.equal((await readdir(path.join(cwd, '.local-evidence', 'control-center-intake', 'receipts'))).length, 1);

  const stalled = new PassThrough();
  const timedOut = await stageControlCenterIntake({
    sourceKind: 'document_text', originalName: 'slow.txt', contentType: 'text/plain', contentLength: 5
  }, stalled, { cwd, intakeStreamTimeoutMs: 20 });
  assert.equal(timedOut.status, 'error');
  assert.equal(timedOut.errors[0].code, 'CONTROL_CENTER_INTAKE_STREAM_TIMEOUT');

  let lastImage;
  for (const body of [makeWebpLossy(320, 180), makeWebpLossless(640, 360)]) {
    const webp = await stageControlCenterIntake({
      sourceKind: 'image', originalName: 'screen.webp', contentType: 'image/webp', contentLength: body.length
    }, Readable.from([body]), { cwd });
    assert.equal(webp.status, 'ok');
    lastImage = webp.data.control_center_intake.intake;
  }
  const completedImage = await completeControlCenterIntake({ intake_id: lastImage.id }, { cwd });
  assert.equal(completedImage.status, 'ok');
  assert.equal(completedImage.data.control_center_intake.result.source_kind, 'image');
  assert.equal(Object.hasOwn(completedImage.data.control_center_intake.result, 'review_method'), false);
});

test('intake reservations enforce a shared quota across separate processes', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-intake-quota-processes-'));
  const worker = path.resolve('tests/fixtures/intake-stage-worker.mjs');
  const workers = [
    spawn(process.execPath, [worker, cwd, '700', '1000']),
    spawn(process.execPath, [worker, cwd, '700', '1000'])
  ];
  const outputs = await Promise.all(workers.map(collectProcess));
  assert.equal(workers.filter((workerProcess) => workerProcess.exitCode === 0).length, 1);
  assert.equal(workers.filter((workerProcess) => workerProcess.exitCode === 3).length, 1);
  assert.equal(outputs.some((output) => output.includes('CONTROL_CENTER_INTAKE_QUOTA_EXCEEDED')), true);
});

test('intake quota includes a live processing receipt', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-intake-processing-quota-'));
  const firstBody = Buffer.from('first', 'utf8');
  const first = await stageControlCenterIntake({
    sourceKind: 'document_text', originalName: 'first.txt', contentType: 'text/plain', contentLength: firstBody.length
  }, Readable.from([firstBody]), { cwd, intakeMaxEntries: 1 });
  assert.equal(first.status, 'ok');
  const id = first.data.control_center_intake.intake.id;
  const receiptPath = path.join(cwd, '.browser-debug', 'control-center-intake', 'receipts', `${id}.json`);
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  receipt.state = 'processing';
  receipt.processing_owner = {
    pid: process.pid,
    process_identity: await captureProcessIdentity(process.pid)
  };
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });

  const secondBody = Buffer.from('second', 'utf8');
  const second = await stageControlCenterIntake({
    sourceKind: 'document_text', originalName: 'second.txt', contentType: 'text/plain', contentLength: secondBody.length
  }, Readable.from([secondBody]), { cwd, intakeMaxEntries: 1 });
  assert.equal(second.status, 'error');
  assert.equal(second.errors[0].code, 'CONTROL_CENTER_INTAKE_QUOTA_EXCEEDED');
});

test('completed intake history cannot hide a live receipt from quota accounting', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-intake-completed-history-quota-'));
  for (let index = 0; index < 3; index += 1) {
    const body = Buffer.from(`completed-${index}`, 'utf8');
    const staged = await stageControlCenterIntake({
      sourceKind: 'document_text', originalName: `completed-${index}.txt`, contentType: 'text/plain', contentLength: body.length
    }, Readable.from([body]), { cwd, intakeMaxEntries: 1 });
    assert.equal(staged.status, 'ok');
    const completed = await completeControlCenterIntake({
      intake_id: staged.data.control_center_intake.intake.id,
      purpose: 'Check the completed document.',
      effort: 'standard'
    }, { cwd, intakeMaxEntries: 1 });
    assert.equal(completed.status, 'ok');
  }

  const firstBody = Buffer.from('active-first', 'utf8');
  const first = await stageControlCenterIntake({
    sourceKind: 'document_text', originalName: 'active-first.txt', contentType: 'text/plain', contentLength: firstBody.length
  }, Readable.from([firstBody]), { cwd, intakeMaxEntries: 1 });
  assert.equal(first.status, 'ok');
  const secondBody = Buffer.from('active-second', 'utf8');
  const second = await stageControlCenterIntake({
    sourceKind: 'document_text', originalName: 'active-second.txt', contentType: 'text/plain', contentLength: secondBody.length
  }, Readable.from([secondBody]), { cwd, intakeMaxEntries: 1 });
  assert.equal(second.status, 'error');
  assert.equal(second.errors[0].code, 'CONTROL_CENTER_INTAKE_QUOTA_EXCEEDED');
});

test('intake completion runs only once across separate processes', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-intake-complete-processes-'));
  const body = Buffer.from('Review this private document once.', 'utf8');
  const staged = await stageControlCenterIntake({
    sourceKind: 'document_text',
    originalName: 'notes.txt',
    contentType: 'text/plain',
    contentLength: body.length
  }, Readable.from([body]), { cwd });
  const id = staged.data.control_center_intake.intake.id;
  const executionMarker = path.join(cwd, 'engine-executed');
  const { owner, waiter, outputs } = await runCoordinatedIntakePair({ cwd, id, executionMarker });
  assert.equal(owner.exitCode, 0, outputs[0]);
  assert.equal(waiter.exitCode, 0, outputs[1]);
  assert.equal(outputs[0].trim(), `ok:${id}:owner`);
  assert.equal(outputs[1].trim(), `ok:${id}:existing`);
  assert.equal(await readFile(executionMarker, 'utf8'), 'pause-before-completion\n');
  const results = await listControlCenterIntakeResults({}, { cwd });
  assert.equal(results.data.control_center_intake.results.length, 1);
});

test('intake waiter stops when its reserved owner rejects before processing', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-intake-owner-rejected-'));
  const body = Buffer.from('Keep the staged source retryable.', 'utf8');
  const staged = await stageControlCenterIntake({
    sourceKind: 'document_text', originalName: 'notes.txt', contentType: 'text/plain', contentLength: body.length
  }, Readable.from([body]), { cwd });
  const id = staged.data.control_center_intake.intake.id;
  const executionMarker = path.join(cwd, 'engine-executed');
  const { owner, waiter, outputs } = await runCoordinatedIntakePair({
    cwd,
    id,
    ownerMode: 'pause-before-invalid-completion',
    executionMarker
  });
  assert.equal(owner.exitCode, 3, outputs[0]);
  assert.equal(waiter.exitCode, 3, outputs[1]);
  assert.match(outputs[0], /CONTROL_CENTER_INTAKE_REQUEST_INVALID/u);
  assert.equal(
    outputs[1].trim(),
    'CONTROL_CENTER_INTAKE_PUBLICATION_OWNER_LOST:retryable'
  );
  await assert.rejects(access(executionMarker));
  const retried = await completeControlCenterIntake({
    intake_id: id,
    purpose: 'Confirm the next improvement.',
    effort: 'standard'
  }, { cwd });
  assert.equal(retried.status, 'ok');
});

test('intake waiter rejects a replacement reservation owned by a different live token', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-intake-owner-replaced-'));
  const body = Buffer.from('Bind a waiter to the exact reservation it observed.', 'utf8');
  const staged = await stageControlCenterIntake({
    sourceKind: 'document_text', originalName: 'notes.txt', contentType: 'text/plain', contentLength: body.length
  }, Readable.from([body]), { cwd });
  const id = staged.data.control_center_intake.intake.id;
  const executionMarker = path.join(cwd, 'engine-executed');
  const store = createSafeLocalStore({
    workspaceRoot: cwd,
    relativeRoot: path.join('.browser-debug', 'control-center-intake'),
    namespace: 'control-center-intake',
    maxRecordBytes: 32 * 1024,
    maxEntries: 100
  });
  const { owner, waiter, outputs } = await runCoordinatedIntakePair({
    cwd,
    id,
    waiterMode: 'pause-at-completion-entry',
    executionMarker,
    completionTimeoutMs: 750,
    async onWaiterReady() {
      const reservationPath = `publication-reservations/${id}.json`;
      const reservation = await store.readJson(reservationPath, { maxBytes: 8 * 1024 });
      reservation.token = reservation.token === 'f'.repeat(32) ? 'e'.repeat(32) : 'f'.repeat(32);
      reservation.owner = {
        pid: process.pid,
        process_identity: await captureProcessIdentity(process.pid)
      };
      reservation.expires_at = new Date(Date.now() + 60_000).toISOString();
      await store.writeJson(reservationPath, reservation, { maxBytes: 8 * 1024 });
    }
  });
  assert.equal(owner.exitCode, 3, outputs[0]);
  assert.equal(waiter.exitCode, 3, outputs[1]);
  assert.equal(
    outputs[1].trim(),
    'CONTROL_CENTER_INTAKE_PUBLICATION_OWNER_LOST:retryable'
  );
  await assert.rejects(access(executionMarker));
});

test('intake waiter stops when its reserved owner exits before processing', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-intake-owner-exited-'));
  const body = Buffer.from('Recover after the reservation owner exits.', 'utf8');
  const staged = await stageControlCenterIntake({
    sourceKind: 'document_text', originalName: 'notes.txt', contentType: 'text/plain', contentLength: body.length
  }, Readable.from([body]), { cwd });
  const id = staged.data.control_center_intake.intake.id;
  const executionMarker = path.join(cwd, 'engine-executed');
  const { owner, waiter, outputs } = await runCoordinatedIntakePair({
    cwd,
    id,
    executionMarker,
    terminateOwner: true
  });
  assert.equal(owner.signalCode, 'SIGTERM', outputs[0]);
  assert.equal(waiter.exitCode, 3, outputs[1]);
  assert.equal(
    outputs[1].trim(),
    'CONTROL_CENTER_INTAKE_PUBLICATION_OWNER_LOST:retryable'
  );
  await assert.rejects(access(executionMarker));
  const retried = await completeControlCenterIntake({
    intake_id: id,
    purpose: 'Confirm the next improvement.',
    effort: 'standard'
  }, { cwd });
  assert.equal(retried.status, 'ok');
});

test('intake publication lease keeps one cross-process owner and blocks another result at capacity', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-intake-publication-owner-'));
  const ids = [];
  for (const label of ['owner', 'blocked']) {
    const body = Buffer.from(`${label} private document`, 'utf8');
    const staged = await stageControlCenterIntake({
      sourceKind: 'document_text',
      originalName: `${label}.txt`,
      contentType: 'text/plain',
      contentLength: body.length
    }, Readable.from([body]), { cwd });
    assert.equal(staged.status, 'ok');
    ids.push(staged.data.control_center_intake.intake.id);
  }
  const [ownerId, blockedId] = ids;
  const worker = path.resolve('tests/fixtures/intake-publication-worker.mjs');
  const ready = path.join(cwd, 'owner-ready');
  const retryReady = path.join(cwd, 'retry-ready');
  const release = path.join(cwd, 'owner-release');
  const unexpected = path.join(cwd, 'duplicate-execution');
  const owner = spawn(process.execPath, [worker, cwd, ownerId, 'owner', ready, release, unexpected]);
  let retry = null;
  try {
    await waitUntil(async () => {
      try { await access(ready); return true; } catch { return false; }
    }, 5000);
    const reservationPath = path.join(
      cwd,
      '.browser-debug',
      'control-center-intake',
      'publication-reservations',
      `${ownerId}.json`
    );
    const firstLease = JSON.parse(await readFile(reservationPath, 'utf8'));
    retry = spawn(process.execPath, [worker, cwd, ownerId, 'retry', retryReady, release, unexpected]);
    let renewedLease;
    await waitUntil(async () => {
      try {
        renewedLease = JSON.parse(await readFile(reservationPath, 'utf8'));
        return Date.parse(renewedLease.expires_at) > Date.parse(firstLease.expires_at);
      } catch {
        return false;
      }
    }, 5000, 'Publication lease was not renewed while its owner remained active.');
    assert.equal(Date.parse(renewedLease.expires_at) > Date.parse(firstLease.expires_at), true);
    assert.equal(renewedLease.token, firstLease.token);
    assert.deepEqual(renewedLease.owner, firstLease.owner);

    const blocked = await settleWithin(completeControlCenterIntake({
      intake_id: blockedId,
      purpose: 'Check the other document.',
      effort: 'standard'
    }, { cwd, intakeActiveResultEntries: 1, intakeHistoryEntries: 1 }), 5000);
    assert.equal(blocked.status, 'error');
    assert.equal(blocked.errors[0].code, 'CONTROL_CENTER_INTAKE_RESULT_CAPACITY_REACHED');
  } finally {
    await writeFile(release, 'release\n', 'utf8');
  }
  const [ownerOutput, retryOutput] = await Promise.all([collectProcess(owner), collectProcess(retry)]);
  assert.equal(owner.exitCode, 0, ownerOutput);
  assert.equal(retry.exitCode, 0, retryOutput);
  assert.match(ownerOutput, /ok:ok/u);
  assert.match(retryOutput, /ok:ok/u);
  await assert.rejects(access(unexpected));
  await assert.rejects(access(retryReady));
});

test('intake history maintenance does not keep a completed child process alive', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-intake-history-exit-'));
  const body = Buffer.from('Finish while history maintenance is busy.', 'utf8');
  const staged = await stageControlCenterIntake({
    sourceKind: 'document_text', originalName: 'notes.txt', contentType: 'text/plain', contentLength: body.length
  }, Readable.from([body]), { cwd });
  const id = staged.data.control_center_intake.intake.id;
  const store = createSafeLocalStore({
    workspaceRoot: cwd,
    relativeRoot: '.browser-debug/control-center-intake',
    namespace: 'control-center-intake',
    maxRecordBytes: 32 * 1024,
    maxEntries: 100
  });
  let releaseHistory;
  const historyReleased = new Promise((resolve) => { releaseHistory = resolve; });
  let signalHistory;
  const historyAcquired = new Promise((resolve) => { signalHistory = resolve; });
  const holder = store.withLock('intake-history', async () => {
    signalHistory();
    await historyReleased;
  });
  await historyAcquired;
  const worker = spawn(process.execPath, [path.resolve('tests/fixtures/intake-complete-worker.mjs'), cwd, id]);
  try {
    const output = await settleWithin(collectProcess(worker), 5000);
    assert.match(output, /ok/u);
    assert.equal(worker.exitCode, 0);
  } finally {
    releaseHistory();
    await holder;
  }
});

test('intake result admission recovers after deferred history maintenance was unavailable', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-intake-result-admission-'));
  const store = createSafeLocalStore({
    workspaceRoot: cwd,
    relativeRoot: '.browser-debug/control-center-intake',
    namespace: 'control-center-intake',
    maxRecordBytes: 32 * 1024,
    maxEntries: 100
  });
  let releaseHistory;
  const historyReleased = new Promise((resolve) => { releaseHistory = resolve; });
  let signalHistory;
  const historyAcquired = new Promise((resolve) => { signalHistory = resolve; });
  const holder = store.withLock('intake-history', async () => {
    signalHistory();
    await historyReleased;
  });
  await historyAcquired;
  const ids = [];
  for (let index = 0; index < 2; index += 1) {
    const body = Buffer.from(`completed-${index}`, 'utf8');
    const staged = await stageControlCenterIntake({
      sourceKind: 'document_text', originalName: `${index}.txt`, contentType: 'text/plain', contentLength: body.length
    }, Readable.from([body]), { cwd });
    ids.push(staged.data.control_center_intake.intake.id);
    const completed = await completeControlCenterIntake({
      intake_id: ids[index], purpose: 'Check the document.', effort: 'standard'
    }, { cwd, intakeActiveResultEntries: 2, intakeHistoryEntries: 1 });
    assert.equal(completed.status, 'ok');
  }
  const thirdBody = Buffer.from('completed-third', 'utf8');
  const third = await stageControlCenterIntake({
    sourceKind: 'document_text', originalName: 'third.txt', contentType: 'text/plain', contentLength: thirdBody.length
  }, Readable.from([thirdBody]), { cwd });
  const thirdId = third.data.control_center_intake.intake.id;
  const blocked = await completeControlCenterIntake({
    intake_id: thirdId, purpose: 'Check the document.', effort: 'standard'
  }, {
    cwd,
    intakeActiveResultEntries: 2,
    intakeHistoryEntries: 1,
    intakeHistoryMaintenanceLockTimeoutMs: 50
  });
  assert.equal(blocked.status, 'error');
  assert.equal(blocked.errors[0].code, 'CONTROL_CENTER_INTAKE_RESULT_CAPACITY_REACHED');
  releaseHistory();
  await holder;

  const recovered = await completeControlCenterIntake({
    intake_id: thirdId, purpose: 'Check the document.', effort: 'standard'
  }, { cwd, intakeActiveResultEntries: 2, intakeHistoryEntries: 1 });
  assert.equal(recovered.status, 'ok');
  for (const id of [...ids, thirdId]) {
    const saved = await getControlCenterIntakeResult({ id }, { cwd });
    assert.equal(saved.status, 'ok', `${id}: ${saved.errors?.[0]?.code ?? 'unknown error'}`);
  }
});

test('completed intake retry stays available when other active results fill publication capacity', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-intake-completed-capacity-'));
  const ids = [];
  const completeDocument = async (index) => {
    const body = Buffer.from(`completed capacity ${index}`, 'utf8');
    const staged = await stageControlCenterIntake({
      sourceKind: 'document_text',
      originalName: `${index}.txt`,
      contentType: 'text/plain',
      contentLength: body.length
    }, Readable.from([body]), { cwd });
    assert.equal(staged.status, 'ok');
    const id = staged.data.control_center_intake.intake.id;
    ids.push(id);
    const completed = await completeControlCenterIntake({
      intake_id: id,
      purpose: `Check completed document ${index}.`,
      effort: 'standard'
    }, { cwd, intakeActiveResultEntries: 2, intakeHistoryEntries: 1 });
    assert.equal(completed.status, 'ok');
  };
  await completeDocument(0);
  await completeDocument(1);
  await waitUntil(async () => {
    const listed = await listControlCenterIntakeResults({}, { cwd });
    return listed.status === 'ok' && listed.data.control_center_intake.results.length === 1;
  });

  const store = createSafeLocalStore({
    workspaceRoot: cwd,
    relativeRoot: '.browser-debug/control-center-intake',
    namespace: 'control-center-intake',
    maxRecordBytes: 32 * 1024,
    maxEntries: 100
  });
  let releaseHistory;
  const historyReleased = new Promise((resolve) => { releaseHistory = resolve; });
  let signalHistory;
  const historyAcquired = new Promise((resolve) => { signalHistory = resolve; });
  const holder = store.withLock('intake-history', async () => {
    signalHistory();
    await historyReleased;
  });
  await historyAcquired;
  try {
    await completeDocument(2);
    const activeWhileHeld = await listControlCenterIntakeResults({}, { cwd });
    assert.equal(activeWhileHeld.status, 'ok');
    assert.equal(activeWhileHeld.data.control_center_intake.results.length, 2);
    const retried = await settleWithin(completeControlCenterIntake({
      intake_id: ids[0],
      purpose: 'Do not execute the archived result again.',
      effort: 'standard'
    }, { cwd, intakeActiveResultEntries: 2, intakeHistoryEntries: 1 }), 1000);
    assert.equal(retried.status, 'ok');
    assert.equal(retried.data.control_center_intake.result.id, ids[0]);
    assert.equal(retried.data.control_center_intake.already_completed, true);
  } finally {
    releaseHistory();
    await holder;
  }
});

test('single-slot intake result admission archives the prior result and admits the next one', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-intake-single-result-slot-'));
  const ids = [];
  for (let index = 0; index < 2; index += 1) {
    const body = Buffer.from(`single result slot ${index}`, 'utf8');
    const staged = await stageControlCenterIntake({
      sourceKind: 'document_text', originalName: `${index}.txt`, contentType: 'text/plain', contentLength: body.length
    }, Readable.from([body]), { cwd });
    const id = staged.data.control_center_intake.intake.id;
    ids.push(id);
    const completed = await completeControlCenterIntake({
      intake_id: id, purpose: `Check single-slot document ${index}.`, effort: 'standard'
    }, { cwd, intakeActiveResultEntries: 1, intakeHistoryEntries: 1 });
    assert.equal(completed.status, 'ok');
    await waitUntil(async () => {
      const listed = await listControlCenterIntakeResults({}, { cwd });
      return listed.status === 'ok'
        && listed.data.control_center_intake.results.length === 1
        && listed.data.control_center_intake.results[0].id === id;
    });
  }
  for (const id of ids) {
    const saved = await getControlCenterIntakeResult({ id }, { cwd });
    assert.equal(saved.status, 'ok');
    assert.equal(saved.data.control_center_intake.result.id, id);
  }
});

test('intake result listing sorts every bounded stored result before limiting output', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-intake-result-order-'));
  const store = createSafeLocalStore({
    workspaceRoot: cwd,
    relativeRoot: '.browser-debug/control-center-intake',
    namespace: 'control-center-intake',
    maxRecordBytes: 32 * 1024,
    maxEntries: 100
  });
  for (let index = 0; index < 201; index += 1) {
    const id = index.toString(16).padStart(32, '0');
    const completedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
    const result = {
      schema_version: '1.0.0',
      type: 'control_center_intake_result',
      id,
      source_kind: 'document_text',
      label: `Saved result ${index}`,
      completed_at: completedAt,
      external_ai_review_completed: false,
      summary: { status: 'proposal_ready' }
    };
    await store.writeJson(`results/${id}.json`, result);
    await store.writeJson(`receipts/${id}.json`, {
      schema_version: '1.1.0',
      type: 'control_center_intake_receipt',
      id,
      source_kind: 'document_text',
      state: 'completed',
      consumed_at: completedAt,
      finished_at: completedAt,
      source_released_at: completedAt,
      result_sha256: canonicalDigest(result)
    });
  }
  const listed = await listControlCenterIntakeResults({ limit: 100 }, { cwd });
  assert.equal(listed.status, 'ok');
  assert.equal(listed.data.control_center_intake.results.length, 100);
  assert.equal(listed.data.control_center_intake.results[0].id, (200).toString(16).padStart(32, '0'));
});

test('intake result publication stays private until startup recovery commits its receipt', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-intake-publication-recovery-'));
  const artifactRoot = '.custom-intake-artifacts';
  const body = Buffer.from('Review this private document safely.', 'utf8');
  const staged = await stageControlCenterIntake({
    sourceKind: 'document_text', originalName: 'notes.txt', contentType: 'text/plain', contentLength: body.length
  }, Readable.from([body]), { cwd, artifactRoot });
  assert.equal(staged.status, 'ok');
  const id = staged.data.control_center_intake.intake.id;
  const store = createSafeLocalStore({
    workspaceRoot: cwd,
    relativeRoot: `${artifactRoot}/control-center-intake`,
    namespace: 'control-center-intake',
    maxRecordBytes: 32 * 1024,
    maxEntries: 100
  });
  const receipt = await store.readJson(`receipts/${id}.json`);
  const completedAt = '2026-07-13T00:00:00.000Z';
  const result = {
    schema_version: '1.0.0', type: 'control_center_intake_result', id,
    source_kind: 'document_text', label: receipt.display_label,
    completed_at: completedAt, external_ai_review_completed: false,
    outcome: 'review_proposal_ready', review_goal: 'Check the document.', review_method: 'standard',
    summary: { status: 'proposal_ready' }
  };
  receipt.state = 'processing';
  receipt.processing_started_at = completedAt;
  receipt.processing_owner = { pid: 999999, process_identity: 'not-running' };
  receipt.pending_completed_at = completedAt;
  receipt.pending_result_sha256 = canonicalDigest(result);
  await store.writeJson(`receipts/${id}.json`, receipt);
  await store.writeJson(`results/${id}.json`, result);

  const unpublishedList = await listControlCenterIntakeResults({}, { cwd, artifactRoot });
  assert.equal(unpublishedList.status, 'error');
  const unpublishedGet = await getControlCenterIntakeResult({ id }, { cwd, artifactRoot });
  assert.equal(unpublishedGet.status, 'error');
  await access(path.join(cwd, artifactRoot, 'control-center-intake', receipt.file_relative));

  const secondBody = Buffer.from('second document', 'utf8');
  const beforeRelease = await stageControlCenterIntake({
    sourceKind: 'document_text', originalName: 'second.txt', contentType: 'text/plain', contentLength: secondBody.length
  }, Readable.from([secondBody]), { cwd, artifactRoot, intakeMaxEntries: 1 });
  assert.equal(beforeRelease.status, 'error');
  assert.equal(beforeRelease.errors[0].code, 'CONTROL_CENTER_INTAKE_QUOTA_EXCEEDED');

  const assetRoot = await createControlCenterTestAssetRoot(cwd);
  const started = await startControlCenterServer({ port: 0, assetRoot, 'artifact-root': artifactRoot }, { cwd });
  await new Promise((resolve) => started.server.close(resolve));
  const recovered = await getControlCenterIntakeResult({ id }, { cwd, artifactRoot });
  assert.equal(recovered.status, 'ok');
  await assert.rejects(access(path.join(cwd, artifactRoot, 'control-center-intake', receipt.file_relative)));
  const committedReceipt = await store.readJson(`receipts/${id}.json`);
  assert.equal(committedReceipt.state, 'completed');
  assert.equal(committedReceipt.result_sha256, canonicalDigest(result));

  const afterRelease = await stageControlCenterIntake({
    sourceKind: 'document_text', originalName: 'second.txt', contentType: 'text/plain', contentLength: secondBody.length
  }, Readable.from([secondBody]), { cwd, artifactRoot, intakeMaxEntries: 1 });
  assert.equal(afterRelease.status, 'ok');
});

test('intake completion retry commits the same pending result without publishing a source-release failure', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-intake-publication-retry-'));
  const body = Buffer.from('Review this document once.', 'utf8');
  const staged = await stageControlCenterIntake({
    sourceKind: 'document_text', originalName: 'notes.txt', contentType: 'text/plain', contentLength: body.length
  }, Readable.from([body]), { cwd });
  const id = staged.data.control_center_intake.intake.id;
  const store = createSafeLocalStore({
    workspaceRoot: cwd,
    relativeRoot: '.browser-debug/control-center-intake',
    namespace: 'control-center-intake',
    maxRecordBytes: 32 * 1024,
    maxEntries: 100
  });
  const receipt = await store.readJson(`receipts/${id}.json`);
  const completedAt = '2026-07-13T00:00:00.000Z';
  const result = {
    schema_version: '1.0.0', type: 'control_center_intake_result', id,
    source_kind: 'document_text', label: receipt.display_label,
    completed_at: completedAt, external_ai_review_completed: false,
    outcome: 'review_proposal_ready', review_goal: 'Check the document.', review_method: 'standard',
    summary: { status: 'proposal_ready' }
  };
  receipt.state = 'processing';
  receipt.pending_completed_at = completedAt;
  receipt.pending_result_sha256 = canonicalDigest(result);
  await store.writeJson(`receipts/${id}.json`, receipt);
  await store.writeJson(`results/${id}.json`, result);
  const source = path.join(cwd, '.browser-debug', 'control-center-intake', receipt.file_relative);
  const hardlink = `${source}.linked`;
  await link(source, hardlink);
  const failed = await completeControlCenterIntake({
    intake_id: id, purpose: 'Check the document.', effort: 'standard'
  }, { cwd });
  assert.equal(failed.status, 'error');
  assert.equal(failed.errors[0].code, 'CONTROL_CENTER_INTAKE_PUBLICATION_PENDING');
  assert.equal(failed.errors[0].details.same_intake_retry_available, true);
  assert.equal((await listControlCenterIntakeResults({}, { cwd })).status, 'error');
  assert.equal((await store.readJson(`receipts/${id}.json`)).state, 'processing');

  await rm(hardlink);
  const retried = await completeControlCenterIntake({
    intake_id: id, purpose: 'Check the document.', effort: 'standard'
  }, { cwd });
  assert.equal(retried.status, 'ok');
  const listed = await listControlCenterIntakeResults({}, { cwd });
  assert.equal(listed.status, 'ok');
  assert.equal(listed.data.control_center_intake.results.length, 1);
});

test('intake retry closes interrupted processing owned by a dead or locally idle process', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-intake-interrupted-processing-'));
  const processIdentity = await captureProcessIdentity(process.pid);
  let executions = 0;
  for (const [index, owner] of [
    [0, { pid: 99_999_999, process_identity: 'stopped-process' }],
    [1, { pid: process.pid, process_identity: processIdentity }]
  ]) {
    const body = Buffer.from(`interrupted processing ${index}`, 'utf8');
    const staged = await stageControlCenterIntake({
      sourceKind: 'document_text', originalName: `${index}.txt`, contentType: 'text/plain', contentLength: body.length
    }, Readable.from([body]), { cwd });
    const id = staged.data.control_center_intake.intake.id;
    const store = createSafeLocalStore({
      workspaceRoot: cwd,
      relativeRoot: '.browser-debug/control-center-intake',
      namespace: 'control-center-intake',
      maxRecordBytes: 32 * 1024,
      maxEntries: 100
    });
    const token = `${index + 1}`.repeat(32);
    const receipt = await store.readJson(`receipts/${id}.json`);
    receipt.state = 'processing';
    receipt.processing_owner = owner;
    receipt.publication_reservation_token = token;
    await store.writeJson(`receipts/${id}.json`, receipt);
    await store.writeJson(`publication-reservations/${id}.json`, {
      schema_version: '1.0.0',
      type: 'control_center_intake_publication_reservation',
      id,
      token,
      owner,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString()
    }, { maxBytes: 8 * 1024 });

    const retried = await completeControlCenterIntake({
      intake_id: id, purpose: 'Do not execute an interrupted intake.', effort: 'standard'
    }, {
      cwd,
      async executeIntake() {
        executions += 1;
        throw new Error('Interrupted work must not execute again.');
      }
    });
    assert.equal(retried.status, 'error');
    assert.equal(retried.errors[0].code, 'CONTROL_CENTER_INTAKE_PROCESS_INTERRUPTED');
    assert.equal(retried.errors[0].details.same_intake_retry_available, false);
    const failedReceipt = await store.readJson(`receipts/${id}.json`);
    assert.equal(failedReceipt.state, 'failed');
    assert.equal(failedReceipt.processing_owner, undefined);
    assert.equal(failedReceipt.publication_reservation_token, undefined);
    await assert.rejects(store.readJson(`publication-reservations/${id}.json`), { code: 'ENOENT' });
  }
  assert.equal(executions, 0);
});

test('intake retry quarantines an invalid pending publication and releases its quotas', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-intake-invalid-pending-'));
  const body = Buffer.from('invalid pending publication', 'utf8');
  const staged = await stageControlCenterIntake({
    sourceKind: 'document_text', originalName: 'invalid.txt', contentType: 'text/plain', contentLength: body.length
  }, Readable.from([body]), { cwd, intakeMaxEntries: 1 });
  const id = staged.data.control_center_intake.intake.id;
  const store = createSafeLocalStore({
    workspaceRoot: cwd,
    relativeRoot: '.browser-debug/control-center-intake',
    namespace: 'control-center-intake',
    maxRecordBytes: 32 * 1024,
    maxEntries: 100
  });
  const owner = { pid: process.pid, process_identity: await captureProcessIdentity(process.pid) };
  const token = 'a'.repeat(32);
  const receipt = await store.readJson(`receipts/${id}.json`);
  receipt.state = 'processing';
  receipt.processing_owner = owner;
  receipt.publication_reservation_token = token;
  receipt.pending_result_sha256 = 'b'.repeat(64);
  receipt.pending_completed_at = new Date().toISOString();
  await store.writeJson(`receipts/${id}.json`, receipt);
  await store.writeJson(`publication-reservations/${id}.json`, {
    schema_version: '1.0.0', type: 'control_center_intake_publication_reservation', id, token, owner,
    created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString()
  }, { maxBytes: 8 * 1024 });

  const failed = await completeControlCenterIntake({
    intake_id: id, purpose: 'Reject the invalid pending result.', effort: 'standard'
  }, { cwd, intakeActiveResultEntries: 1 });
  assert.equal(failed.status, 'error');
  assert.equal(failed.errors[0].code, 'CONTROL_CENTER_INTAKE_PUBLICATION_INVALID');
  assert.equal(failed.errors[0].details.same_intake_retry_available, false);
  assert.equal((await store.readJson(`receipts/${id}.json`)).state, 'failed');
  await assert.rejects(store.readJson(`publication-reservations/${id}.json`), { code: 'ENOENT' });

  const replacementBody = Buffer.from('replacement publication', 'utf8');
  const replacement = await stageControlCenterIntake({
    sourceKind: 'document_text',
    originalName: 'replacement.txt',
    contentType: 'text/plain',
    contentLength: replacementBody.length
  }, Readable.from([replacementBody]), { cwd, intakeMaxEntries: 1 });
  assert.equal(replacement.status, 'ok');
  const completed = await completeControlCenterIntake({
    intake_id: replacement.data.control_center_intake.intake.id,
    purpose: 'Check the replacement publication.',
    effort: 'standard'
  }, { cwd, intakeActiveResultEntries: 1 });
  assert.equal(completed.status, 'ok');
});

test('intake result listing fails closed for a matching result without its completed receipt', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-intake-result-corrupt-'));
  const store = createSafeLocalStore({
    workspaceRoot: cwd,
    relativeRoot: '.browser-debug/control-center-intake',
    namespace: 'control-center-intake',
    maxRecordBytes: 32 * 1024,
    maxEntries: 100
  });
  const id = 'f'.repeat(32);
  await store.writeJson(`results/${id}.json`, {
    schema_version: '1.0.0', type: 'control_center_intake_result', id,
    source_kind: 'document_text', label: 'Incomplete result',
    completed_at: '2026-07-13T00:00:00.000Z', external_ai_review_completed: false,
    summary: { status: 'proposal_ready' }
  });
  const listed = await listControlCenterIntakeResults({}, { cwd });
  assert.equal(listed.status, 'error');
  assert.equal(listed.errors[0].code, 'ENOENT');
});

test('intake result listing rejects a completed receipt with a missing digest', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-intake-result-digest-'));
  const body = Buffer.from('Review the digest contract.', 'utf8');
  const staged = await stageControlCenterIntake({
    sourceKind: 'document_text', originalName: 'digest.txt', contentType: 'text/plain', contentLength: body.length
  }, Readable.from([body]), { cwd });
  const id = staged.data.control_center_intake.intake.id;
  assert.equal((await completeControlCenterIntake({
    intake_id: id, purpose: 'Check the digest.', effort: 'standard'
  }, { cwd })).status, 'ok');
  const store = createSafeLocalStore({
    workspaceRoot: cwd,
    relativeRoot: '.browser-debug/control-center-intake',
    namespace: 'control-center-intake',
    maxRecordBytes: 32 * 1024,
    maxEntries: 100
  });
  const receipt = await store.readJson(`receipts/${id}.json`);
  delete receipt.result_sha256;
  await store.writeJson(`receipts/${id}.json`, receipt);
  const listed = await listControlCenterIntakeResults({}, { cwd });
  assert.equal(listed.status, 'error');
  assert.equal(listed.errors[0].code, 'CONTROL_CENTER_INTAKE_RESULT_NOT_COMMITTED');
});

test('intake rejects an old private receipt before executing and leaves no partial result', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-intake-old-receipt-'));
  const body = Buffer.from('Old private receipt.', 'utf8');
  const staged = await stageControlCenterIntake({
    sourceKind: 'document_text', originalName: 'old.txt', contentType: 'text/plain', contentLength: body.length
  }, Readable.from([body]), { cwd });
  const id = staged.data.control_center_intake.intake.id;
  const store = createSafeLocalStore({
    workspaceRoot: cwd,
    relativeRoot: '.browser-debug/control-center-intake',
    namespace: 'control-center-intake',
    maxRecordBytes: 32 * 1024,
    maxEntries: 100
  });
  const receipt = await store.readJson(`receipts/${id}.json`);
  receipt.schema_version = '1.0.0';
  await store.writeJson(`receipts/${id}.json`, receipt);
  const completed = await completeControlCenterIntake({
    intake_id: id, purpose: 'Do not execute.', effort: 'standard'
  }, { cwd });
  assert.equal(completed.status, 'error');
  assert.equal(completed.errors[0].code, 'CONTROL_CENTER_INTAKE_RECEIPT_VERSION_UNSUPPORTED');
  assert.equal((await store.readJson(`receipts/${id}.json`)).state, 'staged');
  await assert.rejects(store.readJson(`results/${id}.json`));
});

test('intake cleanup removes an old unreferenced regular file', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-intake-orphan-'));
  const first = Buffer.from('first', 'utf8');
  await stageControlCenterIntake({
    sourceKind: 'document_text', originalName: 'first.txt', contentType: 'text/plain', contentLength: first.length
  }, Readable.from([first]), { cwd });
  const orphan = path.join(cwd, '.browser-debug', 'control-center-intake', 'files', 'unreferenced.txt');
  await writeFile(orphan, 'orphan', { mode: 0o600 });
  await utimes(orphan, new Date('2026-07-12T00:00:00.000Z'), new Date('2026-07-12T00:00:00.000Z'));
  const second = Buffer.from('second', 'utf8');
  const staged = await stageControlCenterIntake({
    sourceKind: 'document_text', originalName: 'second.txt', contentType: 'text/plain', contentLength: second.length
  }, Readable.from([second]), { cwd, now: '2026-07-13T02:00:00.000Z' });
  assert.equal(staged.status, 'ok');
  await assert.rejects(access(orphan));
});

test('intake rejects invalid UTF-8, MIME mismatch, and image signature spoofing', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-intake-reject-'));
  const invalidUtf8 = Buffer.from([0xc3, 0x28]);
  const utf8Result = await stageControlCenterIntake({
    sourceKind: 'document_text', originalName: 'notes.txt', contentType: 'text/plain', contentLength: invalidUtf8.length
  }, Readable.from([invalidUtf8]), { cwd });
  assert.equal(utf8Result.status, 'error');
  assert.equal(utf8Result.errors[0].code, 'CONTROL_CENTER_INTAKE_UTF8_INVALID');

  const wrongMime = Buffer.from('{}');
  const mimeResult = await stageControlCenterIntake({
    sourceKind: 'playwright_result', originalName: 'result.json', contentType: 'image/png', contentLength: wrongMime.length
  }, Readable.from([wrongMime]), { cwd });
  assert.equal(mimeResult.status, 'error');
  assert.equal(mimeResult.errors[0].code, 'CONTROL_CENTER_INTAKE_CONTENT_TYPE_REJECTED');

  const fakeImage = Buffer.from('not a png');
  const imageResult = await stageControlCenterIntake({
    sourceKind: 'image', originalName: 'screen.png', contentType: 'image/png', contentLength: fakeImage.length
  }, Readable.from([fakeImage]), { cwd });
  assert.equal(imageResult.status, 'error');
  assert.equal(imageResult.errors[0].code, 'CONTROL_CENTER_INTAKE_IMAGE_SIGNATURE_MISMATCH');
});

test('launcher uses packaged-style assets, injected opener, and reuses one healthy server', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-launcher-'));
  const assets = path.join(cwd, 'installed-assets');
  await mkdir(assets, { recursive: true });
  await writeFile(path.join(assets, 'index.html'), '<!doctype html><title>Control Center</title>', 'utf8');
  const controller = new AbortController();
  let firstUrl;
  let ready;
  const opened = new Promise((resolve) => { ready = resolve; });
  const first = runControlCenterLaunch({}, {
    cwd,
    controlCenterAssetRoot: assets,
    signal: controller.signal,
    stderr: { write() {} },
    async openUrl(url) { firstUrl = url; ready(); }
  });
  await opened;
  const secondUrls = [];
  const second = await runControlCenterLaunch({}, {
    cwd,
    controlCenterAssetRoot: assets,
    async openUrl(url) { secondUrls.push(url); }
  });
  assert.equal(second.status, 'ok');
  assert.equal(second.data.control_center_launch.reused_existing_server, true);
  assert.equal(secondUrls.length, 1);
  const firstBrowserUrl = new URL(firstUrl);
  const secondBrowserUrl = new URL(secondUrls[0]);
  assert.equal(firstBrowserUrl.origin, secondBrowserUrl.origin);
  assert.equal(firstBrowserUrl.pathname, secondBrowserUrl.pathname);
  assert.match(firstBrowserUrl.hash, /^#pair=[A-Za-z0-9_-]{43}$/u);
  assert.match(secondBrowserUrl.hash, /^#pair=[A-Za-z0-9_-]{43}$/u);
  assert.notEqual(firstBrowserUrl.hash, secondBrowserUrl.hash);
  const publicReceipt = await readFile(path.join(cwd, '.browser-debug', 'control-center-runtime', 'server.json'), 'utf8');
  assert.doesNotMatch(publicReceipt, /pair=|management|capability/iu);
  controller.abort();
  const firstResult = await first;
  assert.doesNotMatch(firstResult.data.control_center_launch.url, /#/u);
  assert.equal(firstResult.data.control_center_launch.shell_used, false);
  assert.equal(firstResult.data.control_center_launch.command_input_accepted, false);
  await assert.rejects(readFile(path.join(cwd, '.browser-debug', 'control-center-runtime', 'server.json')));
  await assert.rejects(readFile(path.join(cwd, '.browser-debug', 'control-center-runtime', 'management.json')));
});

test('launcher refuses to reuse a live server with different screen assets', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-launcher-version-'));
  const assets = path.join(cwd, 'installed-assets');
  await mkdir(assets, { recursive: true });
  await writeFile(path.join(assets, 'index.html'), '<!doctype html><title>First</title>', 'utf8');
  const controller = new AbortController();
  let ready;
  const opened = new Promise((resolve) => { ready = resolve; });
  const first = runControlCenterLaunch({}, {
    cwd,
    controlCenterAssetRoot: assets,
    signal: controller.signal,
    stderr: { write() {} },
    async openUrl() { ready(); }
  });
  await opened;
  await writeFile(path.join(assets, 'index.html'), '<!doctype html><title>Second</title>', 'utf8');
  await assert.rejects(
    runControlCenterLaunch({}, {
      cwd,
      controlCenterAssetRoot: assets,
      async openUrl() { throw new Error('must not open incompatible server'); }
    }),
    (error) => error?.code === 'CONTROL_CENTER_LAUNCH_INCOMPATIBLE_RUNTIME'
  );
  controller.abort();
  await first;
});

function makeWebpLossy(width, height) {
  const body = Buffer.alloc(30);
  body.write('RIFF', 0, 'ascii');
  body.write('WEBP', 8, 'ascii');
  body.write('VP8 ', 12, 'ascii');
  body.set([0x9d, 0x01, 0x2a], 23);
  body.writeUInt16LE(width, 26);
  body.writeUInt16LE(height, 28);
  return body;
}

function canonicalDigest(value) {
  return createHash('sha256').update(canonicalStringify(value)).digest('hex');
}

function canonicalStringify(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function makeWebpLossless(width, height) {
  const body = Buffer.alloc(30);
  body.write('RIFF', 0, 'ascii');
  body.write('WEBP', 8, 'ascii');
  body.write('VP8L', 12, 'ascii');
  body[20] = 0x2f;
  const widthBits = width - 1;
  const heightBits = height - 1;
  body[21] = widthBits & 0xff;
  body[22] = ((widthBits >> 8) & 0x3f) | ((heightBits & 0x03) << 6);
  body[23] = (heightBits >> 2) & 0xff;
  body[24] = (heightBits >> 10) & 0x0f;
  return body;
}

async function runCoordinatedIntakePair({
  cwd,
  id,
  ownerMode = 'pause-before-completion',
  waiterMode = 'signal-completion-entry',
  executionMarker,
  terminateOwner = false,
  completionTimeoutMs = null,
  onWaiterReady = null
}) {
  const worker = path.resolve('tests/fixtures/intake-complete-worker.mjs');
  const ownerReady = path.join(cwd, 'owner-reserved');
  const waiterReady = path.join(cwd, 'waiter-entered');
  const releaseOwner = path.join(cwd, 'release-owner');
  const releaseWaiter = path.join(cwd, 'release-waiter');
  const workers = [];
  const outputPromises = [];
  const track = (child) => {
    workers.push(child);
    outputPromises.push(collectProcess(child));
    return child;
  };
  const sharedArgs = [
    executionMarker ?? '',
    String(WORKER_COORDINATION_TIMEOUT_MS),
    Number.isInteger(completionTimeoutMs) ? String(completionTimeoutMs) : ''
  ];
  const owner = track(spawn(process.execPath, [
    worker, cwd, id, ownerMode, ownerReady, releaseOwner, ...sharedArgs
  ]));
  let waiter = null;
  let coordinationError = null;
  try {
    await waitUntil(async () => {
      try { await access(ownerReady); return true; } catch { return false; }
    }, WORKER_COORDINATION_TIMEOUT_MS, 'Owner did not reserve the intake before the completion lock.');
    waiter = track(spawn(process.execPath, [
      worker, cwd, id, waiterMode, waiterReady, releaseWaiter, ...sharedArgs
    ]));
    await waitUntil(async () => {
      try { await access(waiterReady); return true; } catch { return false; }
    }, WORKER_COORDINATION_TIMEOUT_MS, 'Waiter did not observe the reserved intake before owner admission.');
    if (typeof onWaiterReady === 'function') await onWaiterReady();
    await writeFile(releaseWaiter, 'release\n', 'utf8');
    if (terminateOwner) {
      await terminateWorkersWithin([owner], [outputPromises[0]]);
    }
  } catch (error) {
    coordinationError = error;
  } finally {
    for (const barrier of [releaseWaiter, releaseOwner]) {
      try {
        await writeFile(barrier, 'release\n', 'utf8');
      } catch (error) {
        coordinationError ??= error;
      }
    }
  }
  const outputs = await collectWorkersWithin(workers, outputPromises, WORKER_COORDINATION_TIMEOUT_MS);
  if (coordinationError) {
    throw new Error(
      `${coordinationError.message}\n${outputs.filter(Boolean).join('\n')}`,
      { cause: coordinationError }
    );
  }
  return { owner, waiter, outputs };
}

async function collectWorkersWithin(workers, outputPromises, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.all(outputPromises),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Worker processes did not exit within the bounded test window.')), timeoutMs);
      })
    ]);
  } catch (error) {
    await terminateWorkersWithin(workers, outputPromises);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function terminateWorkersWithin(workers, outputPromises) {
  for (const worker of workers) {
    if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGTERM');
  }
  if (await outputsSettleWithin(outputPromises, WORKER_TERMINATION_GRACE_MS)) return;
  for (const worker of workers) {
    if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
  }
  if (await outputsSettleWithin(outputPromises, WORKER_KILL_GRACE_MS)) return;
  for (const worker of workers) {
    worker.stdin?.destroy();
    worker.stdout?.destroy();
    worker.stderr?.destroy();
    worker.unref();
  }
}

async function outputsSettleWithin(outputPromises, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.allSettled(outputPromises).then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForOutput(stream, expected) {
  return new Promise((resolve, reject) => {
    let output = '';
    const onData = (chunk) => {
      output += chunk.toString('utf8');
      if (!output.includes(expected)) return;
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`Worker exited before emitting ${expected}.`));
    };
    const cleanup = () => {
      stream.off('data', onData);
      stream.off('close', onClose);
    };
    stream.on('data', onData);
    stream.once('close', onClose);
  });
}

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

async function waitUntil(predicate, timeoutMs = 5000, timeoutMessage = 'Timed out waiting for the expected state transition.') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(timeoutMessage);
}

async function collectProcess(child) {
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });
  if (child.exitCode === null) await once(child, 'close');
  return output;
}
