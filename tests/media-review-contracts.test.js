import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, chmod, copyFile, link, lstat, mkdtemp, mkdir, readFile, rename, rm, symlink, truncate, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decideMediaSource } from '../src/media-source-decision.js';
import { loadMediaReviewAdapterCatalog, loadMediaReviewPolicy, resolveMediaReviewAdapter } from '../src/media-review-policy.js';
import {
  cleanupPrivateMediaOperation,
  createPrivateMediaOperation,
  findPrivateMediaOperation,
  inspectPrivateMediaTree,
  reconcilePrivateMediaOperations,
  updatePrivateMediaOperation
} from '../src/media-private-operation.js';
import { copyStableMediaFile, inspectStableMediaFile } from '../src/media-stable-file.js';
import { inspectTranscriptProviderReadiness, runTranscriptProvider } from '../src/media-transcript-provider.js';
import { loadMediaTranscriptProviderProfile, verifyMediaTranscriptProviderTrust } from '../src/media-tool-trust.js';
import { analyzeLocalMediaTechnical, inspectTechnicalMediaReadiness, preflightLocalMediaTechnical, resolveTechnicalMediaToolchain } from '../src/media-technical-analyzer.js';
import { buildMediaReviewTimeline } from '../src/media-review-timeline.js';
import { reviewMediaTimeline } from '../src/media-cross-modal-reviewer.js';
import { cleanupMediaReview, executeMediaReview, MEDIA_REVIEW_CLEANUP_CONFIRMATION, MEDIA_REVIEW_EXECUTION_CONFIRMATION, planMediaReview, renderMediaReviewMarkdown } from '../src/media-review-service.js';
import {
  buildMediaReviewComparison,
  renderMediaReviewComparisonMarkdown,
  runMediaReviewComparison
} from '../src/media-review-comparison.js';
import { loadMediaReviewComparisonPolicy } from '../src/media-review-comparison-policy.js';
import { readStoredMediaReviewResult, validatePublicMediaReviewResult } from '../src/media-review-public-result.js';
import { parseCliArgs } from '../src/parser.js';
import { executeCli } from '../src/cli.js';
import { getSchema, schemaNames } from '../src/schema-registry.js';
import { buildOperationRegistryReport } from '../src/operation-registry.js';
import { getMcpTools } from '../src/mcp.js';
import { runFixedProcess } from '../src/fixed-process-runner.js';
import { validateJsonSchemaSubset } from '../src/json-schema-subset.js';
import { readStableBoundedFileHandle } from '../src/safe-local-store.js';

test('media policy and adapter catalog keep local-only boundaries centralized', async () => {
  const policy = await loadMediaReviewPolicy({ disableMediaReviewPolicyCache: true });
  const catalog = await loadMediaReviewAdapterCatalog(policy, { disableMediaReviewPolicyCache: true });
  const adapter = resolveMediaReviewAdapter(catalog, 'caller-owned-local-asr-cli-v1');
  assert.equal(validateJsonSchemaSubset(policy, getSchema('media_review_policy')).ok, true);
  assert.equal(policy.retention.default_mode, 'ephemeral');
  assert.equal(policy.source.url_classification_network_enabled, false);
  assert.equal(policy.source.url_acquisition_enabled, false);
  assert.equal(policy.public_boundary.full_transcript_included, false);
  assert.equal(policy.public_boundary.mcp_execution_enabled, false);
  assert.deepEqual(adapter.production_mock_engines, []);
  assert.equal(adapter.boundary.shell_used, false);
  assert.equal(adapter.boundary.external_send_supported, false);
  const missingPreparedPolicy = structuredClone(policy);
  delete missingPreparedPolicy.prepared_audio;
  assert.equal(validateJsonSchemaSubset(missingPreparedPolicy, getSchema('media_review_policy')).ok, false);
  const missingDecodedProbe = structuredClone(policy);
  delete missingDecodedProbe.technical_analyzer.decoded_timeline_probe_packets;
  assert.equal(validateJsonSchemaSubset(missingDecodedProbe, getSchema('media_review_policy')).ok, false);

  const unsafe = structuredClone(policy);
  unsafe.technical_analyzer.cut_scene_threshold = "0.3);movie=https://example.test/video";
  await assert.rejects(loadMediaReviewPolicy({ mediaReviewPolicy: unsafe }), { code: 'MEDIA_REVIEW_POLICY_LIMIT_INVALID' });
  const nonExclusive = structuredClone(policy);
  nonExclusive.technical_analyzer.dropped_interval_multiplier = 1;
  assert.equal(validateJsonSchemaSubset(nonExclusive, getSchema('media_review_policy')).ok, false);
  await assert.rejects(loadMediaReviewPolicy({ mediaReviewPolicy: nonExclusive }), { code: 'MEDIA_REVIEW_POLICY_LIMIT_INVALID' });
});

test('media source decisions are network-free and remove URL secrets', async () => {
  const official = await decideMediaSource({
    url: 'https://www.youtube.com/watch?v=abcDEF_1234&sig=SECRET#private'
  });
  assert.equal(official.status, 'ready');
  assert.deepEqual(official.capabilities, ['playback_inspection']);
  assert.match(official.source.opaque_media_id, /^[a-f0-9]{64}$/u);
  assert.equal(official.source.opaque_media_id.includes('abcDEF_1234'), false);
  assert.equal(JSON.stringify(official).includes('SECRET'), false);
  assert.equal(JSON.stringify(official).includes('abcDEF_1234'), false);
  assert.equal(official.boundary.network_performed, false);
  assert.equal(official.boundary.download_performed, false);

  const generic = await decideMediaSource({ url: 'https://media.example.test/path/video?token=SECRET' });
  assert.deepEqual(generic.capabilities, ['metadata_only']);
  assert.equal(JSON.stringify(generic).includes('SECRET'), false);

  const unlisted = await decideMediaSource({ url: 'https://vimeo.com/123456/private-path-secret?redirect=https://127.0.0.1/' });
  assert.deepEqual(unlisted.capabilities, ['playback_inspection']);
  assert.equal(unlisted.source.display_label, 'vimeo.com/video');
  assert.equal(JSON.stringify(unlisted).includes('private-path-secret'), false);
  assert.equal(JSON.stringify(unlisted).includes('127.0.0.1'), false);

  const credentialed = await decideMediaSource({ url: 'https://user:secret@example.test/video' });
  assert.equal(credentialed.status, 'invalid');
  assert.deepEqual(credentialed.capabilities, ['unsupported']);

  for (const url of [
    'file:///etc/passwd',
    'http://127.0.0.1/video',
    'https://127.0.0.1/video',
    'https://10.0.0.1/video',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/video',
    'https://metadata.google.internal/computeMetadata/v1',
    'https://service.local/video'
  ]) {
    const blocked = await decideMediaSource({ url });
    assert.equal(blocked.status, 'invalid', url);
    assert.deepEqual(blocked.capabilities, ['unsupported'], url);
    assert.equal(blocked.boundary.network_performed, false, url);
  }

  const local = await decideMediaSource({ local_file: true, local_extension: '.mp4', rights_declared: false });
  assert.equal(local.status, 'rights_confirmation_required');
  assert.deepEqual(local.capabilities, ['full_media_analysis']);
});

test('stable media staging hashes without loading a complete body into public output', async (t) => {
  const root = await privateTemp(t, 'media-stable-');
  const source = path.join(root, 'source.mp4');
  const target = path.join(root, 'target.mp4');
  const body = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(4096, 7)]);
  await writeFile(source, body, { mode: 0o600 });
  const inspected = await inspectStableMediaFile(source, { maxBytes: 8192 });
  assert.equal(inspected.bytes, body.length);
  assert.equal(inspected.format, 'iso-base-media');
  assert.match(inspected.sha256, /^[a-f0-9]{64}$/u);

  const copied = await copyStableMediaFile(source, target, { maxBytes: 8192 });
  assert.equal(copied.sha256, inspected.sha256);
  assert.equal(copied.source_sha256, inspected.sha256);
  assert.equal((await readFile(target)).equals(body), true);
});

test('private operation lifecycle is marker-owned, retention-aware, and idempotent', async (t) => {
  const base = await privateTemp(t, 'media-private-');
  const operation = await createPrivateMediaOperation({
    operationId: 'a'.repeat(32),
    retention: 'ephemeral'
  }, { ephemeralMediaRoot: base, now: () => new Date('2026-07-18T00:00:00.000Z') });
  await mkdir(path.join(operation.root, 'input'), { mode: 0o700 });
  const source = path.join(base, 'fixture.mp4');
  await writeFile(source, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(128)]), { mode: 0o600 });
  const staged = await copyStableMediaFile(source, path.join(operation.root, 'input', 'source.mp4'), { maxBytes: 1024 });
  const running = await updatePrivateMediaOperation(operation, { state: 'running', lease: { pid: process.pid, token: 'e'.repeat(32) } });
  const updated = await updatePrivateMediaOperation(running, {
    state: 'completed',
    lease: null,
    mediaIdentity: { sha256: staged.sha256, bytes: staged.bytes, format: staged.format }
  });
  const inspected = await inspectPrivateMediaTree(updated);
  assert.equal(inspected.marker.operation_id, operation.operationId);
  assert.equal(inspected.marker.body_included, false);
  assert.ok(inspected.totals.fileCount >= 2);

  const receipt = await cleanupPrivateMediaOperation(updated, { reason: 'test_complete' });
  assert.equal(receipt.status, 'cleaned');
  assert.equal(receipt.boundary.absolute_path_included, false);
  assert.equal(JSON.stringify(receipt).includes(operation.root), false);
  const repeated = await cleanupPrivateMediaOperation(updated, { reason: 'test_repeat' });
  assert.equal(repeated.status, 'already_cleaned');
});

test('retained private operation requires explicit cleanup and unsafe tree is refused', async (t) => {
  const base = await privateTemp(t, 'media-retained-');
  const retained = await createPrivateMediaOperation({ operationId: 'b'.repeat(32), retention: 'project-retained' }, { retainedMediaRoot: base });
  const refused = await cleanupPrivateMediaOperation(retained, { reason: 'implicit_cleanup' });
  assert.equal(refused.status, 'refused');
  const cleaned = await cleanupPrivateMediaOperation(retained, { reason: 'explicit_cleanup', allowRetained: true });
  assert.equal(cleaned.status, 'cleaned');

  const unsafe = await createPrivateMediaOperation({ operationId: 'c'.repeat(32), retention: 'ephemeral' }, { ephemeralMediaRoot: base });
  await symlink('/tmp', path.join(unsafe.root, 'unsafe-link'));
  await assert.rejects(cleanupPrivateMediaOperation(unsafe), { code: 'MEDIA_PRIVATE_TREE_TYPE_INVALID' });
  await rm(path.join(unsafe.root, 'unsafe-link'));
  const finalReceipt = await cleanupPrivateMediaOperation(unsafe);
  assert.equal(finalReceipt.status, 'cleaned');
});

test('private operation refuses an existing permissive caller root without changing its mode', async (t) => {
  const parent = await privateTemp(t, 'media-root-mode-');
  const permissive = path.join(parent, 'caller-owned');
  await mkdir(permissive, { mode: 0o755 });
  await assert.rejects(
    createPrivateMediaOperation({ retention: 'ephemeral' }, { ephemeralMediaRoot: permissive }),
    { code: 'MEDIA_PRIVATE_DIRECTORY_INVALID' }
  );
  assert.equal(Number((await lstat(permissive, { bigint: true })).mode & 0o777n), 0o755);
});

test('private root validation leaves no directory inside Git or through a symlink ancestor', async (t) => {
  const parent = await privateTemp(t, 'media-root-preflight-');
  const repository = path.join(parent, 'repository');
  await mkdir(repository, { mode: 0o700 });
  assert.equal((await runGitFixture(repository, ['init'])).ok, true);
  const insideGit = path.join(repository, 'uncreated', 'private-root');
  await assert.rejects(
    createPrivateMediaOperation({ retention: 'ephemeral' }, { ephemeralMediaRoot: insideGit }),
    { code: 'MEDIA_PRIVATE_ROOT_INSIDE_GIT' }
  );
  await assert.rejects(lstat(path.join(repository, 'uncreated')), { code: 'ENOENT' });

  const realParent = path.join(parent, 'real-parent');
  const linkedParent = path.join(parent, 'linked-parent');
  await mkdir(realParent, { mode: 0o700 });
  await symlink(realParent, linkedParent);
  await assert.rejects(
    createPrivateMediaOperation({ retention: 'ephemeral' }, { ephemeralMediaRoot: path.join(linkedParent, 'private-root') }),
    { code: 'MEDIA_PRIVATE_BASE_ANCESTOR_INVALID' }
  );
  await assert.rejects(lstat(path.join(realParent, 'private-root')), { code: 'ENOENT' });
});

test('private cleanup preserves its ownership marker until crash recovery can resume', async (t) => {
  const base = await privateTemp(t, 'media-cleanup-recovery-');
  const operation = await createPrivateMediaOperation({ operationId: '5'.repeat(32), retention: 'ephemeral' }, { ephemeralMediaRoot: base });
  await mkdir(path.join(operation.root, 'payload'), { mode: 0o700 });
  await writeFile(path.join(operation.root, 'payload', 'one.bin'), 'one', { mode: 0o600 });
  await writeFile(path.join(operation.root, 'payload', 'two.bin'), 'two', { mode: 0o600 });
  let interrupted = false;
  await assert.rejects(cleanupPrivateMediaOperation(operation, { reason: 'simulated_crash' }, {
    onPrivateMediaCleanupEntryRemoved: () => {
      if (!interrupted) {
        interrupted = true;
        throw new Error('simulated process loss after a partial deletion');
      }
    }
  }), { code: 'MEDIA_PRIVATE_OPERATION_CLEANUP_FAILED' });
  assert.equal((await lstat(path.join(operation.root, '.media-review-operation.json'))).isFile(), true);

  const quarantine = path.join(base, `.cleanup-${operation.operationId}-${'a'.repeat(16)}`);
  await rename(operation.root, quarantine);
  const reconciled = await reconcilePrivateMediaOperations({ ephemeralMediaRoot: base });
  const record = reconciled.records.find((entry) => entry.operation_id === operation.operationId);
  assert.equal(record.action, 'completed_crash_cleanup');
  assert.equal(record.cleanup_receipt.status, 'cleaned');
  await assert.rejects(lstat(quarantine), { code: 'ENOENT' });
});

test('private reconciliation binds a lease to process start identity, not PID alone', async (t) => {
  const base = await privateTemp(t, 'media-lease-identity-');
  const createdAt = new Date('2026-07-01T00:00:00.000Z');
  let operation = await createPrivateMediaOperation({ operationId: '6'.repeat(32), retention: 'ephemeral' }, {
    ephemeralMediaRoot: base,
    now: createdAt
  });
  operation = await updatePrivateMediaOperation(operation, {
    state: 'running',
    lease: { pid: process.pid, token: 'a'.repeat(32) }
  }, {
    ephemeralMediaRoot: base,
    now: createdAt,
    captureMediaProcessIdentity: async () => '111'
  });
  assert.equal(operation.marker.lease.process_identity, '111');
  const reconciled = await reconcilePrivateMediaOperations({
    ephemeralMediaRoot: base,
    now: new Date('2026-07-20T00:00:00.000Z'),
    captureMediaProcessIdentity: async () => '222'
  });
  const record = reconciled.records.find((entry) => entry.operation_id === operation.operationId);
  assert.equal(record.state, 'interrupted');
  assert.equal(record.action, 'cleaned_expired');
  assert.equal(record.cleanup_receipt.status, 'cleaned');
});

test('direct cleanup remains idempotent after the private locator is deleted', async (t) => {
  const retainedMediaRoot = await privateTemp(t, 'media-cleanup-tombstone-');
  const context = { retainedMediaRoot };
  const operationId = '7'.repeat(32);
  let operation = await createPrivateMediaOperation({ operationId, retention: 'project-retained' }, context);
  operation = await updatePrivateMediaOperation(operation, { state: 'running' }, context);
  operation = await updatePrivateMediaOperation(operation, { state: 'completed_retained' }, context);
  const request = {
    operationId,
    retention: 'project-retained',
    execute: true,
    confirm: MEDIA_REVIEW_CLEANUP_CONFIRMATION
  };
  const first = await cleanupMediaReview(request, context);
  assert.equal(first.status, 'ok');
  assert.equal(first.data.cleanup_receipt.status, 'cleaned');
  const repeated = await cleanupMediaReview(request, context);
  assert.equal(repeated.status, 'ok');
  assert.equal(repeated.data.cleanup_receipt.status, 'already_cleaned');
  assert.equal(repeated.data.cleanup_receipt.boundary.absolute_path_included, false);
  assert.equal(JSON.stringify(repeated).includes(retainedMediaRoot), false);
  await assert.rejects(createPrivateMediaOperation({ operationId, retention: 'project-retained' }, context), { code: 'MEDIA_PRIVATE_OPERATION_ID_CONFLICT' });
  const tombstonePath = path.join(retainedMediaRoot, '.media-review-cleanup-receipts', `${operationId}.json`);
  const tampered = JSON.parse(await readFile(tombstonePath, 'utf8'));
  tampered.receipt.raw_media = '/home/private/raw-video.mp4';
  await writeFile(tombstonePath, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });
  const refusedTamper = await cleanupMediaReview(request, context);
  assert.equal(refusedTamper.status, 'error');
  assert.equal(refusedTamper.errors[0].code, 'MEDIA_PRIVATE_CLEANUP_TOMBSTONE_INVALID');
  assert.equal(JSON.stringify(refusedTamper).includes('/home/private/raw-video.mp4'), false);
});

test('provider profile rejects arbitrary environment injection', async () => {
  await assert.rejects(loadMediaTranscriptProviderProfile({
    mediaTranscriptProviderProfile: providerProfile({ environment: { LD_PRELOAD: '/untrusted/library.so' } })
  }), { code: 'MEDIA_PROVIDER_ENVIRONMENT_INVALID' });
});

test('provider trust binds the tracked inventory and rejects hidden index drift', async (t) => {
  const root = await privateTemp(t, 'media-provider-trust-');
  await mkdir(path.join(root, 'bin'), { mode: 0o700 });
  await writeFile(path.join(root, 'package.json'), '{"name":"provider-fixture","version":"1.0.0","type":"module"}\n', { mode: 0o600 });
  await writeFile(path.join(root, 'bin', 'node-fixture'), 'trusted node fixture\n', { mode: 0o700 });
  await writeFile(path.join(root, 'bin', 'provider.mjs'), "import '../lib.mjs';\n", { mode: 0o600 });
  await writeFile(path.join(root, 'lib.mjs'), 'export const trusted = true;\n', { mode: 0o600 });
  for (const args of [
    ['init'],
    ['config', 'user.email', 'fixture@example.test'],
    ['config', 'user.name', 'Fixture'],
    ['add', '.'],
    ['commit', '-m', 'fixture']
  ]) assert.equal((await runGitFixture(root, args)).ok, true, args.join(' '));
  const revision = (await runGitFixture(root, ['rev-parse', 'HEAD'])).stdout.toString('utf8').trim();
  const profile = {
    schema_version: '1.0.0',
    adapter_contract: 'caller-owned-local-asr-cli-v1',
    runtime: {
      node_executable: path.join(root, 'bin', 'node-fixture'),
      node_sha256: await sha256File(path.join(root, 'bin', 'node-fixture')),
      entrypoint: path.join(root, 'bin', 'provider.mjs'),
      entrypoint_sha256: await sha256File(path.join(root, 'bin', 'provider.mjs')),
      package_root: root,
      git_executable: '/usr/bin/git',
      git_sha256: await sha256File('/usr/bin/git'),
      expected_revision: revision,
      require_clean_tree: true
    },
    engine: 'faster-whisper',
    environment: {}
  };
  const trusted = await verifyMediaTranscriptProviderTrust(profile);
  assert.match(trusted.trackedTreeIdentity, /^[a-f0-9]{64}$/u);
  assert.match(trusted.identity, /^[a-f0-9]{64}$/u);

  assert.equal((await runGitFixture(root, ['update-index', '--assume-unchanged', 'lib.mjs'])).ok, true);
  await writeFile(path.join(root, 'lib.mjs'), 'export const trusted = false;\n', { mode: 0o600 });
  await assert.rejects(verifyMediaTranscriptProviderTrust(profile), { code: 'MEDIA_PROVIDER_TREE_INDEX_FLAGS' });

  assert.equal((await runGitFixture(root, ['update-index', '--no-assume-unchanged', 'lib.mjs'])).ok, true);
  await writeFile(path.join(root, 'lib.mjs'), 'export const trusted = true;\n', { mode: 0o600 });
  const before = await lstat(path.join(root, 'lib.mjs'));
  for (const args of [
    ['config', 'core.trustctime', 'false'],
    ['config', 'core.checkStat', 'minimal'],
    ['config', 'core.ignoreStat', 'true']
  ]) assert.equal((await runGitFixture(root, args)).ok, true);
  await writeFile(path.join(root, 'lib.mjs'), 'export const trusted = null;\n', { mode: 0o600 });
  await utimes(path.join(root, 'lib.mjs'), before.atime, before.mtime);
  await assert.rejects(verifyMediaTranscriptProviderTrust(profile), { code: 'MEDIA_PROVIDER_TREE_DIRTY' });
});

test('fixed provider process containment terminates a detached descendant on cancellation', async (t) => {
  const root = await privateTemp(t, 'media-process-containment-');
  const pidFile = path.join(root, 'descendant.pid');
  const controller = new AbortController();
  let descendantPid = null;
  t.after(() => {
    if (Number.isInteger(descendantPid)) {
      try { process.kill(descendantPid, 'SIGKILL'); } catch {}
    }
  });
  const execution = runFixedProcess({
    executable: process.execPath,
    args: [path.join(process.cwd(), 'tests/fixtures/fixed-process-detached-child.mjs'), pidFile],
    cwd: root,
    env: { LANG: 'C.UTF-8', PATH: '/usr/bin:/bin' },
    timeoutMs: 10_000,
    maxStdoutBytes: 64 * 1024,
    maxStderrBytes: 64 * 1024,
    containDescendants: true,
    signal: controller.signal
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      descendantPid = Number((await readFile(pidFile, 'utf8')).trim());
      if (Number.isInteger(descendantPid) && descendantPid > 1) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(Number.isInteger(descendantPid), true);
  controller.abort(new Error('fixture cancellation'));
  const result = await execution;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'FIXED_PROCESS_ABORTED');
  for (let attempt = 0; attempt < 100 && processExists(descendantPid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(processExists(descendantPid), false);
});

test('transcript provider readiness fails closed for timeout, oversized output, and malformed JSON', async () => {
  const cases = [
    { ok: false, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: { code: 'PROCESS_TIMEOUT' } },
    { ok: false, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: { code: 'PROCESS_STDOUT_LIMIT' } },
    processSuccess('{"status":')
  ];
  for (const processResult of cases) {
    const readiness = await inspectTranscriptProviderReadiness({
      mediaTranscriptProviderProfile: providerProfile(),
      verifyMediaTranscriptProviderTrust: async () => providerTrust(),
      fixedProcessRunner: async () => processResult
    });
    assert.equal(readiness.status, 'unavailable');
    assert.deepEqual(readiness.capabilities, []);
    assert.equal(readiness.boundary.body_included, false);
    assert.equal(readiness.boundary.external_send_performed, false);
    assert.equal(JSON.stringify(readiness).includes('PROCESS_TIMEOUT'), false);
  }
});

test('transcript provider runs fixed stages and keeps transcript body transient', async (t) => {
  const base = await privateTemp(t, 'media-provider-');
  const operation = await createPrivateMediaOperation({ operationId: 'd'.repeat(32), retention: 'ephemeral' }, { ephemeralMediaRoot: base });
  await mkdir(path.join(operation.root, 'input'), { mode: 0o700 });
  const source = path.join(base, 'fixture.mp4');
  const body = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(256, 9)]);
  await writeFile(source, body, { mode: 0o600 });
  const staged = await copyStableMediaFile(source, path.join(operation.root, 'input', 'source.mp4'), { maxBytes: 4096 });
  const calls = [];
  let transcriptCues = [{
    schemaVersion: '1.0.0', id: 'asr-000001', startSeconds: 0.25, endSeconds: 1.5,
    text: 'Private transcript sentence.', language: 'en', needsReview: true
  }];
  const fixedProcessRunner = async ({ executable, args, env, maxStdoutBytes, maxStderrBytes, containDescendants }) => {
    calls.push({ executable, args: [...args], env: { ...env }, maxStdoutBytes, maxStderrBytes, containDescendants });
    const command = args.slice(1);
    if (command[0] === 'local-asr' && command[1] === 'setup-guide') {
      return processSuccess(JSON.stringify({
        status: 'ready', runtime: { runtimeReady: true }, model: { resolvableOffline: true },
        boundaries: { externalNetworkCallsDuringAsrEnabled: false, cloudAsrEnabled: false, externalSendingEnabled: false },
        bodyIncluded: false
      }));
    }
    const operationRoot = optionValue(command, '--external-artifact-root');
    if (command[0] === 'init') {
      const run = path.join(operationRoot, '20260718-000000-trace-cue-provider-test');
      await mkdir(run, { mode: 0o700 });
      return processSuccess(`${run}\n`);
    }
    const run = optionValue(command, '--run');
    if (command[0] === 'import-video') {
      await mkdir(path.join(run, 'source'), { mode: 0o700 });
      const imported = path.join(run, 'source', 'video.mp4');
      await copyFile(optionValue(command, '--input'), imported);
      await chmod(imported, 0o600);
      return processSuccess(`${imported}\n`);
    }
    if (command[0] === 'local-asr' && command[1] === 'run') {
      const transcriptDirectory = path.join(run, 'transcripts', 'asr');
      await mkdir(transcriptDirectory, { recursive: true, mode: 0o700 });
      await chmod(path.join(run, 'transcripts'), 0o700);
      const relativePath = 'transcripts/asr/normalized.jsonl';
      await writeFile(path.join(run, relativePath), `${transcriptCues.map((cue) => JSON.stringify(cue)).join('\n')}\n`, { mode: 0o600 });
      return processSuccess(JSON.stringify({
        schemaVersion: '1.0.0', status: 'ready', engine: { id: 'faster-whisper', networkAllowed: false, bodyIncluded: false },
        normalizedOutput: { relativePath, bodyIncluded: false }
      }));
    }
    throw new Error('unexpected fake provider command');
  };
  const context = {
    mediaTranscriptProviderProfile: providerProfile(),
    verifyMediaTranscriptProviderTrust: async () => providerTrust(),
    fixedProcessRunner
  };
  const result = await runTranscriptProvider({
    operation,
    stagedMedia: { path: path.join(operation.root, 'input', 'source.mp4') },
    mediaIdentity: staged,
    retention: 'ephemeral'
  }, context);
  assert.equal(result.transient.segments[0].text, 'Private transcript sentence.');
  assert.equal(result.transient.segments[0].start_us, 250000);
  assert.equal(result.projection.segment_count, 1);
  assert.equal(JSON.stringify(result.projection).includes('Private transcript sentence.'), false);
  assert.equal(result.projection.boundary.raw_process_output_included, false);
  assert.equal(result.projection.limitations.includes('provider_model_reference_identity_is_not_a_model_weight_hash'), true);
  assert.equal(result.projection.limitations.includes('provider_external_runtime_dependencies_are_not_cryptographically_bound'), true);
  assert.equal(calls.some((call) => call.args.includes('--execute-confirm')), true);
  assert.equal(calls.every((call) => call.executable === '/trusted/node'), true);
  assert.equal(calls.every((call) => call.maxStdoutBytes === 2 * 1024 * 1024), true);
  assert.equal(calls.every((call) => call.maxStderrBytes === 1024 * 1024), true);
  assert.equal(calls.every((call) => call.containDescendants === true), true);

  for (const [operationId, cues, expectedCode] of [
    ['3'.repeat(32), [
      { schemaVersion: '1.0.0', id: 'duplicate', startSeconds: 0, endSeconds: 0.5, text: 'First.' },
      { schemaVersion: '1.0.0', id: 'duplicate', startSeconds: 0.5, endSeconds: 1, text: 'Second.' }
    ], 'MEDIA_PROVIDER_TRANSCRIPT_DUPLICATE_ID'],
    ['4'.repeat(32), [
      { schemaVersion: '1.0.0', id: 'coercion-refused', startSeconds: '0.25', endSeconds: '1.5', text: 'String timecodes are not measurements.' }
    ], 'MEDIA_PROVIDER_TRANSCRIPT_CUE_INVALID'],
    ['a'.repeat(32), [
      { schemaVersion: '1.0.0', id: 'bidi-refused', startSeconds: 0.25, endSeconds: 1.5, text: 'Visible evidence \u202ereordered' }
    ], 'MEDIA_PROVIDER_TRANSCRIPT_CUE_INVALID']
  ]) {
    transcriptCues = cues;
    const invalidOperation = await createPrivateMediaOperation({ operationId, retention: 'ephemeral' }, { ephemeralMediaRoot: base });
    await mkdir(path.join(invalidOperation.root, 'input'), { mode: 0o700 });
    const invalidStaged = await copyStableMediaFile(source, path.join(invalidOperation.root, 'input', 'source.mp4'), { maxBytes: 4096 });
    await assert.rejects(runTranscriptProvider({
      operation: invalidOperation,
      stagedMedia: { path: path.join(invalidOperation.root, 'input', 'source.mp4') },
      mediaIdentity: invalidStaged,
      retention: 'ephemeral'
    }, context), { code: expectedCode });
    assert.equal((await cleanupPrivateMediaOperation(invalidOperation)).status, 'cleaned');
  }
  transcriptCues = [{
    schemaVersion: '1.0.0', id: 'asr-000001', startSeconds: 0.25, endSeconds: 1.5,
    text: 'Private transcript sentence.', language: 'en', needsReview: true
  }];

  const incompatibleOperation = await createPrivateMediaOperation({ operationId: 'e'.repeat(32), retention: 'ephemeral' }, { ephemeralMediaRoot: base });
  await mkdir(path.join(incompatibleOperation.root, 'input'), { mode: 0o700 });
  const incompatibleStaged = await copyStableMediaFile(source, path.join(incompatibleOperation.root, 'input', 'source.mp4'), { maxBytes: 4096 });
  const incompatibleCatalog = await loadMediaReviewAdapterCatalog(await loadMediaReviewPolicy());
  incompatibleCatalog.adapters[0].supported_normalized_schema_majors = [2];
  await assert.rejects(runTranscriptProvider({
    operation: incompatibleOperation,
    stagedMedia: { path: path.join(incompatibleOperation.root, 'input', 'source.mp4') },
    mediaIdentity: incompatibleStaged,
    retention: 'ephemeral'
  }, { ...context, mediaReviewAdapterCatalog: incompatibleCatalog }), { code: 'MEDIA_PROVIDER_TRANSCRIPT_SCHEMA_UNSUPPORTED' });
  const incompatibleReceipt = await cleanupPrivateMediaOperation(incompatibleOperation);
  assert.equal(incompatibleReceipt.status, 'cleaned');
  const receipt = await cleanupPrivateMediaOperation(result.operation);
  assert.equal(receipt.status, 'cleaned');
});

test('technical analyzer separates deterministic timing, duplicate, gap, cut, subtitle, and PTS evidence', async () => {
  const technicalProcessRunner = async ({ args }) => {
    if (args.includes('-show_streams')) {
      return processSuccess(JSON.stringify({
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'h264', start_time: '0.000000', avg_frame_rate: '25/1', width: 1920, height: 1080 },
          { index: 1, codec_type: 'audio', codec_name: 'aac', start_time: '0.100000', sample_rate: '48000', channels: 2 }
        ],
        format: { duration: '2.000000', size: '4096', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' }
      }));
    }
    if (args.includes('framemd5')) {
      return processSuccess([
        '#tb 0: 1/1000',
        `0, 0, 0, 40, 1, ${'a'.repeat(32)}`,
        `0, 40, 40, 40, 1, ${'a'.repeat(32)}`,
        `0, 80, 80, 40, 1, ${'b'.repeat(32)}`,
        `0, 200, 200, 40, 1, ${'c'.repeat(32)}`,
        ''
      ].join('\n'));
    }
    if (args.includes('-vf')) {
      return {
        ...processSuccess(''),
        stderr: Buffer.from('frame:0 pts:25 pts_time:1.000\nlavfi.scene_score=0.750000\n')
      };
    }
    if (args.includes('-show_packets')) {
      return processSuccess(JSON.stringify({ packets: [{ pts_time: '0.500000', duration_time: '0.400000' }] }));
    }
    throw new Error('unexpected fake analyzer command');
  };
  const result = await analyzeLocalMediaTechnical({
    mediaPath: '/private-operation/input/source.mp4',
    operationRoot: '/private-operation',
    mediaIdentity: { sha256: '9'.repeat(64), bytes: 4096, format: 'iso-base-media' }
  }, {
    inspectTechnicalMediaFile: async () => ({ sha256: '9'.repeat(64), bytes: 4096, format: 'iso-base-media' }),
    technicalMediaToolchain: {
      probe: { path: '/trusted/ffprobe', sha256: '6'.repeat(64), version: 'fixture' },
      analyzer: { path: '/trusted/ffmpeg', sha256: '7'.repeat(64), version: 'fixture' }
    },
    technicalProcessRunner
  });
  assert.equal(result.status, 'available');
  assert.equal(result.technical_metrics.frame_count_analyzed, 4);
  assert.equal(result.duplicate_frames.length, 1);
  assert.equal(result.dropped_frame_intervals.length, 1);
  assert.equal(result.audio_video_sync.offset_us, 100000);
  assert.equal(result.audio_video_sync.perceptual_lip_sync_measured, false);
  assert.equal(result.shot_boundaries.length, 2);
  assert.equal(result.subtitle_events[0].duration_sufficient, false);
  assert.equal(result.method.classification, 'deterministic_measurement');
  assert.equal(result.boundary.raw_frames_included, false);
});

test('technical preflight rejects every unsafe stream before decode or provider execution', async () => {
  const mediaIdentity = { sha256: '9'.repeat(64), bytes: 4096, format: 'iso-base-media' };
  const baseContext = {
    inspectTechnicalMediaFile: async () => mediaIdentity,
    technicalMediaToolchain: {
      probe: { path: '/trusted/ffprobe', sha256: '6'.repeat(64), version: 'fixture' },
      analyzer: { path: '/trusted/ffmpeg', sha256: '7'.repeat(64), version: 'fixture' }
    }
  };
  const safeVideo = { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 };
  const cases = [
    {
      streams: [safeVideo, { ...safeVideo, index: 1, width: 8000, height: 64 }],
      code: 'MEDIA_ANALYZER_RESOLUTION_LIMIT'
    },
    {
      streams: [safeVideo, { index: 1, codec_type: 'audio', codec_name: 'aac', sample_rate: '384000', channels: 2 }],
      code: 'MEDIA_ANALYZER_AUDIO_LIMIT'
    },
    {
      streams: Array.from({ length: 65 }, (_, index) => ({ ...safeVideo, index })),
      code: 'MEDIA_ANALYZER_STREAM_LIMIT'
    }
  ];
  for (const fixture of cases) {
    let probeCalls = 0;
    const technicalProcessRunner = async ({ args }) => {
      probeCalls += 1;
      assert.equal(args.includes('-nostdin'), false, 'ffprobe stdin is closed by the fixed runner, not an unsupported option');
      assert.equal(args.includes('-max_alloc'), true);
      return processSuccess(JSON.stringify({
        streams: fixture.streams,
        format: { duration: '2.000000', size: '4096', format_name: 'mov,mp4' }
      }));
    };
    await assert.rejects(preflightLocalMediaTechnical({
      mediaPath: '/private-operation/input/source.mp4',
      operationRoot: '/private-operation',
      mediaIdentity
    }, { ...baseContext, technicalProcessRunner }), { code: fixture.code });
    assert.equal(probeCalls, 1);
  }
});

test('technical analyzer verifies a generated cut with real local FFmpeg when available', async (t) => {
  const readiness = await inspectTechnicalMediaReadiness();
  if (readiness.status !== 'ready') {
    assert.deepEqual(readiness.capabilities, []);
    assert.equal(readiness.boundary.network_performed, false);
    return;
  }
  const root = await privateTemp(t, 'media-ffmpeg-fixture-');
  const fixture = path.join(root, 'known-cut.mp4');
  const toolchain = await resolveTechnicalMediaToolchain();
  const generated = await runFixedProcess({
    executable: toolchain.analyzer.path,
    args: [
      '-hide_banner', '-v', 'error', '-nostdin',
      '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=25:d=1',
      '-f', 'lavfi', '-i', 'color=c=white:s=64x64:r=25:d=1',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
      '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', fixture
    ],
    cwd: root,
    env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: '/usr/bin:/bin' },
    timeoutMs: 60_000,
    maxStdoutBytes: 256 * 1024,
    maxStderrBytes: 1024 * 1024
  });
  assert.equal(generated.ok, true);
  await chmod(fixture, 0o600);
  const identity = await inspectStableMediaFile(fixture, { maxBytes: 8 * 1024 * 1024 });
  const analysis = await analyzeLocalMediaTechnical({ mediaPath: fixture, operationRoot: root, mediaIdentity: identity }, { technicalMediaToolchain: toolchain });
  assert.equal(analysis.technical_metrics.frame_count_analyzed, 50);
  assert.equal(analysis.technical_metrics.effective_fps, 25);
  assert.ok(analysis.technical_metrics.cut_count >= 1);
  assert.ok(analysis.shot_boundaries.some((shot) => shot.start_us >= 900_000 && shot.start_us <= 1_100_000));
  assert.equal(analysis.audio_video_sync.status, 'unavailable');
  assert.equal(analysis.boundary.raw_frames_included, false);
});

test('timeline review joins speech and shots while separating measurements from advice', async () => {
  const technicalAnalysis = {
    technical_metrics: { duration_us: 6_000_000 },
    frame_intervals: { warning: false, median_us: 40_000 },
    duplicate_frames: [], dropped_frame_intervals: [],
    audio_video_sync: { warning: false },
    shot_boundaries: [
      { id: 'shot-0001', start_us: 0, end_us: 1_000_000, cut_score: null },
      { id: 'shot-0002', start_us: 1_000_000, end_us: 6_000_000, cut_score: 0.8 }
    ],
    subtitle_events: []
  };
  const transcript = {
    segments: [
      { id: 'speech-1', start_us: 100_000, end_us: 1_800_000, text: 'The introduction continues across this cut.', timed: true },
      { id: 'speech-2', start_us: 2_000_000, end_us: 3_000_000, text: 'Now quantum batteries change the topic completely.', timed: true },
      { id: 'speech-3', start_us: 5_500_000, end_us: 5_900_000, text: 'Dense rapid closing words arrive right now today.', timed: true }
    ]
  };
  const timeline = await buildMediaReviewTimeline({ technicalAnalysis, transcript });
  const reviewed = await reviewMediaTimeline({
    technicalAnalysis,
    transcript,
    timeline,
    mediaIdentity: { sha256: '8'.repeat(64), bytes: 4096, format: 'iso-base-media' }
  });
  assert.equal(timeline.boundary.full_transcript_included, false);
  assert.equal(timeline.items.find((item) => item.kind === 'speech').evidence.body_included, false);
  assert.equal(reviewed.advisoryFindings.some((finding) => finding.kind === 'cut_during_speech'), true);
  assert.equal(reviewed.advisoryFindings.some((finding) => finding.kind === 'topic_change_without_visual_break'), true);
  assert.equal(reviewed.advisoryFindings.some((finding) => finding.kind === 'silent_viewing_accessibility_risk'), true);
  assert.equal(reviewed.advisoryFindings.every((finding) => finding.classification === 'advisory_evaluation'), true);
  assert.equal(reviewed.contentEvidence.coverage.has_full_text, false);
  assert.equal(reviewed.contentEvidence.privacy.full_transcript_embedded_in_json, false);
  assert.equal(JSON.stringify(reviewed.contentEvidence).includes('The introduction continues across this cut. Now quantum'), false);
});

test('untimed transcript text is not presented as timed speech accessibility evidence', async () => {
  const technicalAnalysis = fixtureTechnicalAnalysis({ sha256: '8'.repeat(64), bytes: 4096, format: 'iso-base-media' });
  const transcript = {
    segments: [{
      id: 'untimed-1', start_us: null, end_us: null,
      text: 'This provider text has no usable time boundaries.', timed: false
    }]
  };
  const timeline = await buildMediaReviewTimeline({ technicalAnalysis, transcript });
  const reviewed = await reviewMediaTimeline({
    technicalAnalysis,
    transcript,
    timeline,
    mediaIdentity: technicalAnalysis.media_identity
  });
  assert.equal(timeline.items.some((item) => item.kind === 'speech'), false);
  assert.equal(reviewed.advisoryFindings.some((finding) => finding.kind === 'silent_viewing_accessibility_risk'), false);
  assert.equal(JSON.stringify(reviewed).includes('Timed speech is available'), false);
});

test('media Markdown report neutralizes HTML, links, images, headings, bidi controls, and line breaks', () => {
  const hostile = '<script>alert(1)</script> ![private](file:///tmp/raw.mp4)\n# injected \u202ereordered';
  const markdown = renderMediaReviewMarkdown({
    operation_id: '7'.repeat(32),
    media_identity: { sha256: '8'.repeat(64) },
    status: 'completed_with_limitations',
    privacy: { retention: 'ephemeral' },
    deterministic_findings: [],
    advisory_findings: [{
      timecode: { start: '00:00:00.000', end: '00:00:01.000' },
      kind: hostile,
      severity: 'medium',
      classification: 'advisory_evaluation',
      method: hostile,
      confidence: 0.5,
      evidence: [hostile],
      limitations: [hostile],
      recommendation: hostile
    }],
    limitations: [hostile]
  });
  assert.equal(markdown.includes('<script>'), false);
  assert.equal(markdown.includes('!['), false);
  assert.equal(markdown.includes(']('), false);
  assert.equal(markdown.includes('file:///tmp/raw.mp4'), true, 'the inert literal remains useful evidence without becoming a link');
  assert.equal(markdown.includes('\n# injected'), false);
  assert.equal(markdown.includes('\u202e'), false);
  assert.match(markdown, /&lt;script&gt;/u);
  assert.match(markdown, /&#33;&#91;private&#93;&#40;file:\/\/\/tmp\/raw\.mp4&#41;/u);
});

test('media review service completes an ephemeral vertical slice without leaking private payloads', async (t) => {
  const cwd = await privateTemp(t, 'media-service-');
  const input = path.join(cwd, 'source.mp4');
  await writeFile(input, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(512, 4)]), { mode: 0o600 });
  const context = {
    cwd,
    ephemeralMediaRoot: path.join(cwd, 'private-operations'),
    inspectTranscriptProviderReadiness: async () => readyTranscriptProvider(),
    inspectTechnicalMediaReadiness: async () => readyTechnicalAnalyzer(),
    collectResourceStatus: async () => healthyResourceStatus(),
    runTranscriptProvider: async (request) => ({
      operation: request.operation,
      transient: {
        schema_version: '1.0.0', type: 'transcript_provider_transient_result',
        operation_id: request.operation.operationId, media_identity: request.mediaIdentity,
        retention: request.retention, language: 'en',
        segments: [{ id: 'speech-1', start_us: 0, end_us: 900_000, text: 'Private service transcript body.', language: 'en', speaker: null, confidence: null, timed: true, needs_review: true }],
        method: providerTrustProjection(), limitations: [
          'provider_model_reference_identity_is_not_a_model_weight_hash',
          'provider_external_runtime_dependencies_are_not_cryptographically_bound'
        ], privacy: { public_body_included: false }
      },
      projection: {
        schema_version: '1.0.0', type: 'transcript_provider_projection', status: 'available',
        media_identity: request.mediaIdentity, language: 'en', segment_count: 1, timed_segment_count: 1,
        transcript_identity: 'a'.repeat(64), method: providerTrustProjection(), limitations: [],
        boundary: { body_included: false, absolute_paths_included: false }
      }
    }),
    analyzeLocalMediaTechnical: async (request) => fixtureTechnicalAnalysis(request.mediaIdentity)
  };
  const options = { input: 'source.mp4', rightsDeclared: true, retention: 'ephemeral', artifactRoot: '.artifacts-test' };
  const planned = await planMediaReview(options, context);
  assert.equal(planned.status, 'ok');
  assert.equal(planned.data.plan.executable, true);
  assert.equal(Object.hasOwn(planned.data.plan.source_decision, 'media_identity'), false);
  const completed = await executeMediaReview({
    ...options,
    execute: true,
    confirm: MEDIA_REVIEW_EXECUTION_CONFIRMATION,
    planHash: planned.data.plan.plan_hash,
    operationId: 'f'.repeat(32)
  }, context);
  assert.equal(completed.status, 'ok');
  assert.equal(completed.data.result.status, 'completed_with_limitations');
  assert.equal(completed.data.cleanup_receipt.status, 'cleaned');
  assert.equal(completed.data.result.privacy.full_transcript_in_result, false);
  assert.equal(JSON.stringify(completed.data.result).includes('Private service transcript body.'), false);
  assert.equal(JSON.stringify(completed.data.result).includes(path.join(cwd, 'private-operations')), false);
  assert.equal(completed.data.result.deterministic_findings.every((finding) => finding.classification === 'deterministic_measurement'), true);
  assert.equal(completed.data.result.advisory_findings.every((finding) => finding.classification === 'advisory_evaluation'), true);
  const externalSchemas = mediaSchemaResources();
  const schemaValidation = validateJsonSchemaSubset(completed.data.result, getSchema('media_review_result'), { externalSchemas });
  assert.deepEqual(schemaValidation, { ok: true });
  const forgedClassification = structuredClone(completed.data.result);
  assert.ok(forgedClassification.advisory_findings.length > 0);
  forgedClassification.advisory_findings[0].classification = 'deterministic_measurement';
  assert.equal(validateJsonSchemaSubset(forgedClassification, getSchema('media_review_result'), { externalSchemas }).ok, false);
  const forgedPrivacy = structuredClone(completed.data.result);
  forgedPrivacy.privacy.full_transcript_in_result = true;
  assert.equal(validateJsonSchemaSubset(forgedPrivacy, getSchema('media_review_result'), { externalSchemas }).ok, false);
  const forgedTranscriptBody = structuredClone(completed.data.result);
  forgedTranscriptBody.transcript.segments = [{ text: 'forbidden complete transcript' }];
  assert.equal(validateJsonSchemaSubset(forgedTranscriptBody, getSchema('media_review_result'), { externalSchemas }).ok, false);
  const artifactBody = await readFile(path.join(cwd, '.artifacts-test', 'media-review-results', `${'f'.repeat(32)}.json`), 'utf8');
  const artifact = JSON.parse(artifactBody);
  const policy = await loadMediaReviewPolicy();
  assert.ok(Buffer.byteLength(artifactBody) <= policy.operation.maximum_public_result_bytes);
  assert.equal(artifact.privacy.full_transcript_in_result, false);
  assert.equal(JSON.stringify(artifact).includes(path.join(cwd, 'private-operations')), false);
});

test('media review comparison keeps metric and finding evidence separated without reprocessing media', async (t) => {
  const { result: original } = await comparisonFixtureResult(t, 'a'.repeat(32));
  const baseline = comparisonResultVariant(original, {
    operationId: 'a'.repeat(32),
    mediaSha256: 'a'.repeat(64),
    duplicateFrameCount: 1,
    deterministicFindings: [comparisonFinding({ id: 'media-finding-1111111111111111', classification: 'deterministic_measurement' })],
    advisoryFindings: [comparisonFinding({
      id: 'media-finding-2222222222222222',
      classification: 'advisory_evaluation',
      kind: 'speech_cut_proximity',
      method: 'timeline_advisory_heuristic'
    })]
  });
  const candidate = comparisonResultVariant(original, {
    operationId: 'b'.repeat(32),
    mediaSha256: 'b'.repeat(64),
    duplicateFrameCount: 3,
    deterministicFindings: [comparisonFinding({
      id: 'media-finding-3333333333333333',
      classification: 'deterministic_measurement',
      startUs: 250_000,
      endUs: 650_000,
      severity: 'high'
    })],
    advisoryFindings: [comparisonFinding({
      id: 'media-finding-4444444444444444',
      classification: 'advisory_evaluation',
      kind: 'speech_cut_proximity',
      method: 'timeline_advisory_heuristic',
      startUs: 250_000,
      endUs: 650_000,
      severity: 'high'
    })]
  });
  const policy = await loadMediaReviewComparisonPolicy({ disableMediaReviewComparisonPolicyCache: true });
  const forgedPolicy = structuredClone(policy);
  forgedPolicy.metrics.find((metric) => metric.domain === 'transcript').classification = 'deterministic_measurement';
  assert.equal(validateJsonSchemaSubset(forgedPolicy, getSchema('media_review_comparison_policy')).ok, false);
  await assert.rejects(loadMediaReviewComparisonPolicy({ mediaReviewComparisonPolicy: forgedPolicy }), {
    code: 'MEDIA_REVIEW_COMPARISON_POLICY_INVALID'
  });
  const comparison = buildMediaReviewComparison(baseline, candidate, policy);
  assert.equal(comparison.status, 'comparable_with_limitations');
  assert.equal(comparison.compatibility.technical.basis_equal, true);
  assert.equal(comparison.compatibility.transcript.basis_equal, true);
  assert.equal(comparison.compatibility.same_media_identity, false);
  assert.equal(comparison.boundary.media_reprocessed, false);
  assert.equal(comparison.boundary.provider_called, false);
  assert.equal(comparison.boundary.artifact_written, false);
  assert.equal(comparison.summary.combined_quality_score_included, false);
  assert.equal(comparison.compatibility.technical.status, 'comparable', 'method disclaimers must not erase deterministic metric comparisons');
  assert.equal(comparison.limitations.includes('technical_analysis_method_limitations_remain_applicable'), true);
  assert.equal(comparison.metric_diffs.find((item) => item.id === 'duplicate_frame_count').assessment, 'regressed');
  assert.equal(comparison.metric_diffs.find((item) => item.id === 'duplicate_frame_count').classification, 'deterministic_measurement');
  assert.equal(comparison.metric_diffs.find((item) => item.id === 'timed_transcript_segment_count').classification, 'provider_measurement');
  assert.equal(comparison.metric_diffs.find((item) => item.id === 'semantic_change_count').classification, 'advisory_evaluation');
  assert.equal(Object.values(comparison.summary.deterministic_metric_assessments).reduce((sum, value) => sum + value, 0),
    comparison.metric_diffs.filter((item) => item.classification === 'deterministic_measurement').length);
  assert.equal(Object.values(comparison.summary.provider_metric_assessments).reduce((sum, value) => sum + value, 0), 1);
  assert.equal(Object.values(comparison.summary.advisory_metric_assessments).reduce((sum, value) => sum + value, 0), 1);
  assert.equal(comparison.deterministic_finding_changes[0].state, 'severity_changed');
  assert.equal(comparison.deterministic_finding_changes[0].assessment, 'inconclusive', 'heuristic matches must not become definitive quality claims');
  assert.equal(comparison.advisory_finding_changes[0].assessment, 'inconclusive');
  assert.deepEqual(validateJsonSchemaSubset(comparison, getSchema('media_review_comparison')), { ok: true });
  const forgedMetricClassification = structuredClone(comparison);
  forgedMetricClassification.metric_diffs.find((metric) => metric.domain === 'transcript').classification = 'deterministic_measurement';
  assert.equal(validateJsonSchemaSubset(forgedMetricClassification, getSchema('media_review_comparison')).ok, false);
  const markdown = renderMediaReviewComparisonMarkdown(comparison);
  assert.match(markdown, /Deterministic technical measurements/u);
  assert.match(markdown, /Transcript provider measurements/u);
  assert.match(markdown, /Advisory indicators/u);
  assert.match(markdown, /Deterministic finding changes/u);
  assert.match(markdown, /Advisory finding changes/u);
  assert.equal(markdown.includes('Private service transcript body.'), false);

  const cleanBaseline = comparisonResultVariant(original, {
    operationId: '5'.repeat(32), mediaSha256: '5'.repeat(64), deterministicFindings: [], advisoryFindings: []
  });
  const cleanCandidate = comparisonResultVariant(original, {
    operationId: '6'.repeat(32), mediaSha256: '6'.repeat(64), deterministicFindings: [], advisoryFindings: []
  });
  for (const value of [cleanBaseline, cleanCandidate]) {
    value.status = 'completed';
    value.limitations = [];
    value.technical_analysis.limitations = [];
    value.transcript.limitations = [];
    value.timeline.limitations = [];
    value.content_evidence.limitations = [];
  }
  const cleanComparison = buildMediaReviewComparison(cleanBaseline, cleanCandidate, policy);
  assert.equal(cleanComparison.status, 'comparable');
  assert.deepEqual(cleanComparison.limitations, ['comparison_reads_bounded_public_results_only']);
  assert.equal(cleanComparison.limitations.includes('not_detected_in_candidate_does_not_prove_fixed'), false);
});

test('media review comparison fails closed on basis drift and marks incomplete unmatched findings inconclusive', async (t) => {
  const { result: original } = await comparisonFixtureResult(t, 'c'.repeat(32));
  const policy = await loadMediaReviewComparisonPolicy();
  const baseline = comparisonResultVariant(original, {
    operationId: 'c'.repeat(32), mediaSha256: 'c'.repeat(64),
    deterministicFindings: [comparisonFinding({ id: 'media-finding-6666666666666666', classification: 'deterministic_measurement' })],
    advisoryFindings: [comparisonFinding({ id: 'media-finding-5555555555555555', classification: 'advisory_evaluation' })]
  });
  const drifted = comparisonResultVariant(original, {
    operationId: 'd'.repeat(32), mediaSha256: 'd'.repeat(64), advisoryFindings: []
  });
  drifted.analysis_settings.maximum_frames += 1;
  const driftComparison = buildMediaReviewComparison(baseline, drifted, policy);
  assert.equal(driftComparison.compatibility.technical.status, 'incompatible');
  assert.equal(driftComparison.compatibility.advisory.status, 'incompatible');
  assert.equal(driftComparison.metric_diffs.find((item) => item.id === 'effective_fps').assessment, 'inconclusive');
  assert.deepEqual(driftComparison.advisory_finding_changes, []);

  const completeMissing = comparisonResultVariant(original, {
    operationId: 'f'.repeat(32), mediaSha256: 'f'.repeat(64), deterministicFindings: [],
    advisoryFindings: baseline.advisory_findings
  });
  const completeMissingComparison = buildMediaReviewComparison(baseline, completeMissing, policy);
  assert.equal(completeMissingComparison.deterministic_finding_changes[0].state, 'not_detected_in_candidate');
  assert.equal(completeMissingComparison.deterministic_finding_changes[0].assessment, 'inconclusive');

  const incomplete = comparisonResultVariant(original, {
    operationId: 'e'.repeat(32), mediaSha256: 'e'.repeat(64), deterministicFindings: [], advisoryFindings: []
  });
  incomplete.timeline.truncated = true;
  const incompleteComparison = buildMediaReviewComparison(baseline, incomplete, policy);
  assert.equal(incompleteComparison.compatibility.advisory.status, 'incompatible');
  assert.deepEqual(incompleteComparison.advisory_finding_changes, []);
  assert.equal(incompleteComparison.deterministic_finding_changes[0].state, 'unmatched_inconclusive');
  assert.equal(incompleteComparison.deterministic_finding_changes[0].assessment, 'inconclusive');
  assert.throws(() => buildMediaReviewComparison(baseline, { ...incomplete, operation_id: baseline.operation_id }, policy), {
    code: 'MEDIA_REVIEW_COMPARISON_DISTINCT_RESULTS_REQUIRED'
  });

  const privateBody = structuredClone(baseline);
  privateBody.transcript.segments = [{ text: 'forbidden full transcript' }];
  assert.throws(() => validatePublicMediaReviewResult(privateBody), { code: 'MEDIA_REVIEW_COMPARISON_INPUT_PRIVATE_BODY' });
  const duplicateIds = structuredClone(baseline);
  duplicateIds.deterministic_findings.push(structuredClone(duplicateIds.deterministic_findings[0]));
  assert.throws(() => buildMediaReviewComparison(duplicateIds, incomplete, policy), {
    code: 'MEDIA_REVIEW_COMPARISON_FINDING_ID_DUPLICATE'
  });
});

test('media comparison rejects incomplete inputs and propagates completeness without unsafe exact matches', async (t) => {
  const { result: original } = await comparisonFixtureResult(t, '7'.repeat(32));
  const policy = await loadMediaReviewComparisonPolicy();
  const baseline = comparisonResultVariant(original, {
    operationId: '7'.repeat(32), mediaSha256: '7'.repeat(64),
    deterministicFindings: [comparisonFinding({ id: 'media-finding-7777777777777777', classification: 'deterministic_measurement' })]
  });
  const candidate = comparisonResultVariant(original, {
    operationId: '8'.repeat(32), mediaSha256: '8'.repeat(64),
    deterministicFindings: [comparisonFinding({
      id: 'media-finding-7777777777777777', classification: 'deterministic_measurement', startUs: 200_000, endUs: 600_000
    })]
  });
  const movedSameId = buildMediaReviewComparison(baseline, candidate, policy);
  assert.equal(movedSameId.deterministic_finding_changes[0].match.method, 'timeline_overlap');
  assert.equal(movedSameId.deterministic_finding_changes[0].match.heuristic, true);
  assert.equal(movedSameId.deterministic_finding_changes[0].assessment, 'inconclusive');

  const insufficient = structuredClone(candidate);
  insufficient.status = 'insufficient';
  assert.throws(() => buildMediaReviewComparison(baseline, insufficient, policy), {
    code: 'MEDIA_REVIEW_COMPARISON_RESULT_INSUFFICIENT'
  });
  const forgedInsufficientProjection = structuredClone(movedSameId);
  forgedInsufficientProjection.baseline.status = 'insufficient';
  assert.equal(validateJsonSchemaSubset(forgedInsufficientProjection, getSchema('media_review_comparison')).ok, false);

  const transcriptDrift = structuredClone(candidate);
  transcriptDrift.transcript.status = 'insufficient';
  const transcriptComparison = buildMediaReviewComparison(baseline, transcriptDrift, policy);
  assert.equal(transcriptComparison.compatibility.transcript.status, 'incompatible');
  assert.equal(transcriptComparison.compatibility.advisory.status, 'incompatible');
  assert.equal(transcriptComparison.metric_diffs.find((item) => item.id === 'timed_transcript_segment_count').assessment, 'inconclusive');

  const partialBaseline = structuredClone(baseline);
  const partialCandidate = structuredClone(candidate);
  partialBaseline.technical_analysis.status = 'partial';
  partialCandidate.technical_analysis.status = 'partial';
  const partialComparison = buildMediaReviewComparison(partialBaseline, partialCandidate, policy);
  assert.equal(partialComparison.compatibility.technical.status, 'comparable_with_limitations');
  assert.equal(partialComparison.compatibility.advisory.status, 'comparable_with_limitations');
  assert.equal(partialComparison.metric_diffs.find((item) => item.id === 'effective_fps').assessment, 'inconclusive');

  const contentBaseline = structuredClone(baseline);
  const contentCandidate = structuredClone(candidate);
  contentBaseline.content_evidence.status = 'insufficient';
  contentCandidate.content_evidence.status = 'insufficient';
  const contentComparison = buildMediaReviewComparison(contentBaseline, contentCandidate, policy);
  assert.equal(contentComparison.compatibility.advisory.status, 'comparable_with_limitations');
  assert.equal(contentComparison.metric_diffs.find((item) => item.id === 'semantic_change_count').assessment, 'inconclusive');

  const cyclic = structuredClone(baseline);
  cyclic.cycle = cyclic;
  assert.throws(() => buildMediaReviewComparison(cyclic, candidate, policy), {
    code: 'MEDIA_REVIEW_COMPARISON_INPUT_TOO_COMPLEX'
  });
  const deep = structuredClone(baseline);
  let cursor = deep;
  for (let index = 0; index < 70; index += 1) cursor = cursor.nested = {};
  assert.throws(() => buildMediaReviewComparison(deep, candidate, policy), {
    code: 'MEDIA_REVIEW_COMPARISON_INPUT_TOO_COMPLEX'
  });
});

test('media comparison treats total producer limits as incomplete and truncates projection by bytes', async (t) => {
  const { result: original } = await comparisonFixtureResult(t, '9'.repeat(32));
  const policy = await loadMediaReviewComparisonPolicy();
  const mixedDeterministic = Array.from({ length: 50 }, (_, index) => comparisonFinding({
    id: `media-finding-${(index + 1).toString(16).padStart(16, '0')}`,
    classification: 'deterministic_measurement', startUs: index * 1_000, endUs: index * 1_000 + 500
  }));
  const mixedAdvisory = Array.from({ length: 150 }, (_, index) => comparisonFinding({
    id: `media-finding-${(index + 1001).toString(16).padStart(16, '0')}`,
    classification: 'advisory_evaluation', kind: 'speech_cut_proximity', method: 'timeline_advisory_heuristic',
    startUs: index * 1_000, endUs: index * 1_000 + 500
  }));
  const mixedBaseline = comparisonResultVariant(original, {
    operationId: 'c'.repeat(32), mediaSha256: 'c'.repeat(64),
    deterministicFindings: mixedDeterministic, advisoryFindings: mixedAdvisory
  });
  const mixedCandidate = comparisonResultVariant(original, {
    operationId: 'd'.repeat(32), mediaSha256: 'd'.repeat(64),
    deterministicFindings: mixedDeterministic, advisoryFindings: mixedAdvisory
  });
  const mixedComparison = buildMediaReviewComparison(mixedBaseline, mixedCandidate, policy);
  assert.equal(mixedComparison.compatibility.advisory.status, 'comparable_with_limitations');
  assert.equal(mixedComparison.deterministic_finding_changes.every((change) => change.assessment === 'inconclusive'), true);
  assert.equal(mixedComparison.advisory_finding_changes.every((change) => change.assessment === 'inconclusive'), true);

  const findings = Array.from({ length: 200 }, (_, index) => {
    const finding = comparisonFinding({
      id: `media-finding-${index.toString(16).padStart(16, '0')}`,
      classification: 'deterministic_measurement',
      startUs: index * 1_000,
      endUs: index * 1_000 + 500
    });
    finding.evidence = ['E'.repeat(1000), 'F'.repeat(1000)];
    finding.limitations = ['L'.repeat(500)];
    finding.recommendation = 'R'.repeat(1000);
    return finding;
  });
  const baseline = comparisonResultVariant(original, {
    operationId: '9'.repeat(32), mediaSha256: '9'.repeat(64), deterministicFindings: findings, advisoryFindings: []
  });
  const candidate = comparisonResultVariant(original, {
    operationId: 'a'.repeat(32), mediaSha256: 'a'.repeat(64), deterministicFindings: findings, advisoryFindings: []
  });
  const comparison = buildMediaReviewComparison(baseline, candidate, policy);
  assert.equal(comparison.compatibility.advisory.status, 'comparable_with_limitations');
  assert.equal(comparison.deterministic_finding_changes.every((change) => change.assessment === 'inconclusive'), true);
  assert.equal(comparison.limitations.includes('comparison_finding_changes_truncated_to_byte_limit'), true);
  assert.ok(comparison.deterministic_finding_changes.length < 200);
  assert.ok(Buffer.byteLength(`${JSON.stringify(comparison)}\n`) <= policy.output.maximum_result_bytes);
});

test('media comparison rejects embedded private paths and secret-bearing URLs', async (t) => {
  const { result: original } = await comparisonFixtureResult(t, 'b'.repeat(32));
  const baseline = comparisonResultVariant(original, {
    operationId: 'b'.repeat(32), mediaSha256: 'b'.repeat(64),
    deterministicFindings: [comparisonFinding({ id: 'media-finding-bbbbbbbbbbbbbbbb', classification: 'deterministic_measurement' })]
  });
  for (const text of [
    'Evidence from /home/user/private.mp4',
    'Evidence\n/home/user/private.mp4',
    'Evidence\t/home/user/private.mp4',
    'Evidence\u202e/home/user/private.mp4',
    'Evidence:/home/user/private.mp4',
    'Evidence;/home/user/private.mp4',
    'Evidence,/home/user/private.mp4',
    'Evidence-/home/user/private.mp4',
    'Evidence./home/user/private.mp4',
    'Evidence from /ho\u202eme/user/private.mp4',
    'Evidence,C:\\Users\\name\\private.mp4',
    'Evidence-C:\\Users\\name\\private.mp4',
    'Evidence,\\Users\\name\\private.mp4',
    'Evidence,\\\\server\\share\\private.mp4',
    'Evidence-\\\\server\\share\\private.mp4',
    'See file:/home/user/private.mp4',
    'See file://server/share/private.mp4',
    'See file:///home/user/private.mp4',
    '[source](//media.example/watch?token=SECRET)',
    '[source](https://media.example/watch?token=SECRET)',
    'See https://media.example/watch#signed-fragment',
    'See https://user:password@media.example/watch',
    'See https:media.example/watch?token=SECRET',
    String.raw`See https:\media.example\watch?token=SECRET`,
    'See http:media.example/watch#secret',
    'See ws:media.example/socket?token=SECRET',
    'See ftp:media.example/file#secret',
    'See (https://media.example/watch),/home/user/private.mp4',
    'See (https://media.example/watch),C:\\Users\\name\\private.mp4',
    'See https://media.example/watch;/home/user/private.mp4',
    'See https://media.example/watch:/home/user/private.mp4',
    'See https://media.example/watch=/home/user/private.mp4',
    'See https://media.example/watch-/home/user/private.mp4',
    'See https://media.example/watch]/home/user/private.mp4',
    'See https://media.example/watch%/home/user/private.mp4',
    'See https://media.example/%5CUsers%5Cname%5Cprivate.mp4',
    'See https://media.example/watch\n/home/user/private.mp4',
    'See https://public.example/watch),https://user:password@private.example/media',
    'See https://public.example/watch),//user:password@private.example/media'
  ]) {
    for (const field of ['evidence', 'evidence_refs', 'limitations', 'recommendation']) {
      const unsafe = structuredClone(baseline);
      unsafe.deterministic_findings[0][field] = field === 'recommendation' ? text : [text];
      assert.throws(() => validatePublicMediaReviewResult(unsafe), {
        code: 'MEDIA_REVIEW_COMPARISON_INPUT_PRIVATE_PATH'
      }, `${field} must reject ${text}`);
    }
  }
  for (const text of [
    'See https://media.example/watch for public context.',
    'See https://[2001:db8::1]/watch for public context.',
    'See https://例え.テスト/watch for public context.',
    'See https://example.com./watch for public context.',
    'See https://media.example/watch%20clip for public context.',
    'See https:media.example/watch for public context.',
    'See the source file: no local locator is included.'
  ]) {
    const safe = structuredClone(baseline);
    safe.deterministic_findings[0].evidence = [text];
    assert.doesNotThrow(() => validatePublicMediaReviewResult(safe), text);
  }
});

test('stored media review comparison accepts only stable owner-controlled public result files', async (t) => {
  const { cwd, result: original } = await comparisonFixtureResult(t, '1'.repeat(32));
  const store = path.join(cwd, '.comparison-artifacts', 'media-review-results');
  await mkdir(store, { recursive: true, mode: 0o700 });
  const baseline = comparisonResultVariant(original, { operationId: '1'.repeat(32), mediaSha256: '1'.repeat(64) });
  const candidate = comparisonResultVariant(original, { operationId: '2'.repeat(32), mediaSha256: '2'.repeat(64) });
  await writeFile(path.join(store, `${baseline.operation_id}.json`), `${JSON.stringify(baseline)}\n`, { mode: 0o600 });
  await writeFile(path.join(store, `${candidate.operation_id}.json`), `${JSON.stringify(candidate)}\n`, { mode: 0o600 });
  const loaded = await readStoredMediaReviewResult(baseline.operation_id, { artifactRoot: '.comparison-artifacts' }, { cwd });
  assert.equal(loaded.value.operation_id, baseline.operation_id);
  const completed = await runMediaReviewComparison({
    baseline: baseline.operation_id,
    candidate: candidate.operation_id,
    artifactRoot: '.comparison-artifacts'
  }, { cwd });
  assert.equal(completed.status, 'ok');
  assert.equal(completed.data.media_review_comparison.boundary.artifact_written, false);
  const cli = await executeCli([
    'media', 'review', 'compare', '--baseline', baseline.operation_id, '--candidate', candidate.operation_id,
    '--artifact-root', '.comparison-artifacts'
  ], { cwd });
  assert.equal(cli.exitCode, 0);
  assert.match(cli.stdout, /^# Media Review Comparison/mu);
  assert.equal(cli.stdout.includes(cwd), false);

  const symlinkId = '3'.repeat(32);
  await symlink(`${baseline.operation_id}.json`, path.join(store, `${symlinkId}.json`));
  await assert.rejects(readStoredMediaReviewResult(symlinkId, { artifactRoot: '.comparison-artifacts' }, { cwd }), {
    code: 'MEDIA_REVIEW_COMPARISON_RESULT_NOT_FOUND'
  });
  const hardlinkId = '4'.repeat(32);
  await link(path.join(store, `${baseline.operation_id}.json`), path.join(store, `${hardlinkId}.json`));
  await assert.rejects(readStoredMediaReviewResult(hardlinkId, { artifactRoot: '.comparison-artifacts' }, { cwd }), {
    code: 'MEDIA_REVIEW_COMPARISON_RESULT_FILE_INVALID'
  });

  const growId = '5'.repeat(32);
  const growFile = path.join(store, `${growId}.json`);
  await writeFile(growFile, `${JSON.stringify({ ...baseline, operation_id: growId })}\n`, { mode: 0o600 });
  await assert.rejects(readStoredMediaReviewResult(growId, { artifactRoot: '.comparison-artifacts' }, {
    cwd,
    readStableBoundedFileHandle: async (handle, options) => {
      await appendFile(growFile, 'x');
      return readStableBoundedFileHandle(handle, options);
    }
  }), { code: 'MEDIA_REVIEW_COMPARISON_RESULT_CHANGED' });

  const shrinkId = '6'.repeat(32);
  const shrinkFile = path.join(store, `${shrinkId}.json`);
  await writeFile(shrinkFile, `${JSON.stringify({ ...baseline, operation_id: shrinkId })}\n`, { mode: 0o600 });
  await assert.rejects(readStoredMediaReviewResult(shrinkId, { artifactRoot: '.comparison-artifacts' }, {
    cwd,
    readStableBoundedFileHandle: async (handle, options) => {
      await truncate(shrinkFile, 2);
      return readStableBoundedFileHandle(handle, options);
    }
  }), { code: 'MEDIA_REVIEW_COMPARISON_RESULT_CHANGED' });

  const shortId = '7'.repeat(32);
  const shortFile = path.join(store, `${shortId}.json`);
  await writeFile(shortFile, `${JSON.stringify({ ...baseline, operation_id: shortId })}\n`, { mode: 0o600 });
  await assert.rejects(readStoredMediaReviewResult(shortId, { artifactRoot: '.comparison-artifacts' }, {
    cwd,
    readStableBoundedFileHandle: async () => Buffer.from('{')
  }), { code: 'MEDIA_REVIEW_COMPARISON_RESULT_CHANGED' });

  const replacementId = '8'.repeat(32);
  const replacementFile = path.join(store, `${replacementId}.json`);
  await writeFile(replacementFile, `${JSON.stringify({ ...baseline, operation_id: replacementId })}\n`, { mode: 0o600 });
  await assert.rejects(readStoredMediaReviewResult(replacementId, { artifactRoot: '.comparison-artifacts' }, {
    cwd,
    readStableBoundedFileHandle: async (handle, options) => {
      await rename(replacementFile, `${replacementFile}.replaced`);
      await writeFile(replacementFile, '{"forged":true}\n', { mode: 0o600 });
      return readStableBoundedFileHandle(handle, options);
    }
  }), { code: 'MEDIA_REVIEW_COMPARISON_RESULT_CHANGED' });
});

test('prepared-audio service path prepares once and shares only the prepared contract with transcription', async (t) => {
  const cwd = await privateTemp(t, 'media-service-prepared-audio-');
  const input = path.join(cwd, 'source.mp4');
  await writeFile(input, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(512, 8)]), { mode: 0o600 });
  const calls = { preflight: 0, prepare: 0, provider: 0, technical: 0 };
  const context = {
    cwd,
    ephemeralMediaRoot: path.join(cwd, 'private-operations'),
    inspectTranscriptProviderReadiness: async () => readyPreparedTranscriptProvider(),
    inspectTechnicalMediaReadiness: async () => readyTechnicalAnalyzer(),
    collectResourceStatus: async () => healthyResourceStatus(),
    preflightLocalMediaTechnical: async (request) => {
      calls.preflight += 1;
      assert.equal(request.includeDecodedTimeline, true);
      return {
        decoded_timeline: {
          basis: 'first_decoded_frame_pts',
          video_first_timestamp_seconds: '0.000000',
          audio_first_timestamp_seconds: '0.125000'
        }
      };
    },
    prepareLocalMediaAudio: async (request) => {
      calls.prepare += 1;
      assert.equal(request.contract.schema_version, '1.0.0');
      const directory = path.join(request.operation.root, 'prepared-audio');
      await mkdir(directory, { mode: 0o700 });
      const audioPath = path.join(directory, 'audio.wav');
      const manifestPath = path.join(directory, 'manifest.json');
      await writeFile(audioPath, Buffer.alloc(76, 1), { mode: 0o600 });
      await writeFile(manifestPath, '{}\n', { mode: 0o600 });
      return {
        audio: { path: audioPath, sha256: 'a'.repeat(64), bytes: 76, sample_count: 16 },
        manifest: { path: manifestPath, sha256: 'b'.repeat(64), bytes: 3 },
        timeline: { sampleZeroSourceTimeMicroseconds: 125_000 },
        preparation: { settings_identity: 'c'.repeat(64) }
      };
    },
    runTranscriptProvider: async (request) => {
      calls.provider += 1;
      assert.equal(request.preparedAudio.audio.sha256, 'a'.repeat(64));
      assert.equal(request.preparedAudio.timeline.sampleZeroSourceTimeMicroseconds, 125_000);
      const method = preparedProviderTrustProjection();
      return {
        operation: request.operation,
        transient: {
          schema_version: '1.0.0', type: 'transcript_provider_transient_result',
          operation_id: request.operation.operationId, media_identity: request.mediaIdentity,
          retention: request.retention, language: 'en',
          segments: [{ id: 'speech-1', start_us: 125_000, end_us: 625_000, text: 'Private prepared service transcript.', language: 'en', speaker: null, confidence: null, timed: true, needs_review: true }],
          method, limitations: [],
          privacy: { public_body_included: false }
        },
        projection: {
          schema_version: '1.0.0', type: 'transcript_provider_projection', status: 'available',
          media_identity: request.mediaIdentity, language: 'en', segment_count: 1, timed_segment_count: 1,
          transcript_identity: 'd'.repeat(64), method,
          limitations: [],
          boundary: { body_included: false, absolute_paths_included: false }
        }
      };
    },
    analyzeLocalMediaTechnical: async (request) => {
      calls.technical += 1;
      return fixtureTechnicalAnalysis(request.mediaIdentity);
    }
  };
  const options = { input: 'source.mp4', rightsDeclared: true, retention: 'ephemeral', artifactRoot: '.artifacts-test' };
  const planned = await planMediaReview(options, context);
  assert.equal(planned.data.plan.readiness.transcript_provider.input_contract.mode, 'caller_prepared_audio');
  const completed = await executeMediaReview({
    ...options,
    execute: true,
    confirm: MEDIA_REVIEW_EXECUTION_CONFIRMATION,
    planHash: planned.data.plan.plan_hash,
    operationId: 'e'.repeat(32)
  }, context);
  assert.equal(completed.status, 'ok');
  assert.deepEqual(calls, { preflight: 1, prepare: 1, provider: 1, technical: 1 });
  assert.equal(completed.data.cleanup_receipt.status, 'cleaned');
  assert.equal(completed.data.result.transcript.method.acquisition, 'local_cli_offline_prepared_audio');
  assert.equal(JSON.stringify(completed.data.result).includes('Private prepared service transcript.'), false);
  assert.equal(completed.data.result.privacy.raw_audio_in_result, false);
});

test('prepared-audio containment uncertainty defers private cleanup until a restart boundary', async (t) => {
  const cwd = await privateTemp(t, 'media-service-prepared-containment-');
  await writeFile(path.join(cwd, 'source.mp4'), Buffer.concat([
    Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(512, 11)
  ]), { mode: 0o600 });
  const context = {
    cwd,
    ephemeralMediaRoot: path.join(cwd, 'private-operations'),
    inspectTranscriptProviderReadiness: async () => readyPreparedTranscriptProvider(),
    inspectTechnicalMediaReadiness: async () => readyTechnicalAnalyzer(),
    collectResourceStatus: async () => healthyResourceStatus(),
    preflightLocalMediaTechnical: async () => ({
      decoded_timeline: {
        basis: 'first_decoded_frame_pts', video_first_timestamp_seconds: '0.000000', audio_first_timestamp_seconds: '0.000000'
      }
    }),
    prepareLocalMediaAudio: async () => {
      const error = new Error('fixture containment uncertainty');
      error.code = 'MEDIA_REVIEW_CONTAINMENT_UNCONFIRMED';
      throw error;
    }
  };
  const options = { input: 'source.mp4', rightsDeclared: true, retention: 'ephemeral', artifactRoot: '.artifacts-test' };
  const planned = await planMediaReview(options, context);
  const operationId = '1'.repeat(32);
  const completed = await executeMediaReview({
    ...options, execute: true, confirm: MEDIA_REVIEW_EXECUTION_CONFIRMATION,
    planHash: planned.data.plan.plan_hash, operationId
  }, context);
  assert.equal(completed.status, 'error');
  assert.equal(completed.errors[0].code, 'MEDIA_REVIEW_CONTAINMENT_UNCONFIRMED');
  assert.equal(completed.errors[0].details.cleanup_status, 'deferred_containment_unconfirmed');
  let retained = await findPrivateMediaOperation(operationId, 'ephemeral', context);
  assert.equal(retained.marker.state, 'cleanup_required');
  assert.equal(retained.marker.lease.containment_unconfirmed, true);
  retained = await updatePrivateMediaOperation(retained, { state: 'cleanup_required', lease: null }, context);
  assert.equal((await cleanupPrivateMediaOperation(retained, { reason: 'simulated_restart_boundary' }, context)).status, 'cleaned');
});

test('prepared-audio failures project a bounded nontechnical message', async (t) => {
  const cwd = await privateTemp(t, 'media-service-prepared-message-');
  const privateDetail = path.join(cwd, 'private-provider-model');
  await writeFile(path.join(cwd, 'source.mp4'), Buffer.concat([
    Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(512, 13)
  ]), { mode: 0o600 });
  const context = {
    cwd,
    ephemeralMediaRoot: path.join(cwd, 'private-operations'),
    inspectTranscriptProviderReadiness: async () => readyPreparedTranscriptProvider(),
    inspectTechnicalMediaReadiness: async () => readyTechnicalAnalyzer(),
    collectResourceStatus: async () => healthyResourceStatus(),
    preflightLocalMediaTechnical: async () => ({
      decoded_timeline: {
        basis: 'first_decoded_frame_pts', video_first_timestamp_seconds: '0.000000', audio_first_timestamp_seconds: '0.000000'
      }
    }),
    prepareLocalMediaAudio: async () => {
      const error = new Error(`private provider setup at ${privateDetail}`);
      error.code = 'MEDIA_PROVIDER_SETUP_REQUIRED';
      throw error;
    }
  };
  const options = { input: 'source.mp4', rightsDeclared: true, retention: 'ephemeral', artifactRoot: '.artifacts-test' };
  const planned = await planMediaReview(options, context);
  const completed = await executeMediaReview({
    ...options, execute: true, confirm: MEDIA_REVIEW_EXECUTION_CONFIRMATION,
    planHash: planned.data.plan.plan_hash, operationId: '7'.repeat(32)
  }, context);
  assert.equal(completed.status, 'error');
  assert.equal(completed.errors[0].code, 'MEDIA_PROVIDER_SETUP_REQUIRED');
  assert.match(completed.errors[0].message, /Local transcription is not ready/u);
  assert.equal(JSON.stringify(completed).includes(privateDetail), false);
  assert.equal(completed.errors[0].details.cleanup_status, 'cleaned');
});

test('media review preserves a successful ephemeral cleanup when public artifact publication fails', async (t) => {
  const cwd = await privateTemp(t, 'media-service-publication-failure-');
  const input = path.join(cwd, 'source.mp4');
  await writeFile(input, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(256, 4)]), { mode: 0o600 });
  const context = {
    cwd,
    ephemeralMediaRoot: path.join(cwd, 'private-operations'),
    inspectTranscriptProviderReadiness: async () => readyTranscriptProvider(),
    inspectTechnicalMediaReadiness: async () => readyTechnicalAnalyzer(),
    collectResourceStatus: async () => healthyResourceStatus(),
    runTranscriptProvider: async (request) => ({
      operation: request.operation,
      transient: {
        schema_version: '1.0.0', type: 'transcript_provider_transient_result', operation_id: request.operation.operationId,
        media_identity: request.mediaIdentity, retention: request.retention, language: null, segments: [],
        method: providerTrustProjection(), limitations: ['transcript_unavailable'], privacy: { public_body_included: false }
      },
      projection: {
        schema_version: '1.0.0', type: 'transcript_provider_projection', status: 'insufficient', media_identity: request.mediaIdentity,
        language: null, segment_count: 0, timed_segment_count: 0, transcript_identity: 'b'.repeat(64),
        method: providerTrustProjection(), limitations: ['transcript_unavailable'], boundary: { body_included: false, absolute_paths_included: false }
      }
    }),
    analyzeLocalMediaTechnical: async (request) => fixtureTechnicalAnalysis(request.mediaIdentity)
  };
  const options = { input: 'source.mp4', rightsDeclared: true, retention: 'ephemeral', artifactRoot: '../outside-workspace' };
  const planned = await planMediaReview(options, context);
  const completed = await executeMediaReview({
    ...options,
    execute: true,
    confirm: MEDIA_REVIEW_EXECUTION_CONFIRMATION,
    planHash: planned.data.plan.plan_hash,
    operationId: '0'.repeat(32)
  }, context);
  assert.equal(completed.status, 'error');
  assert.equal(completed.errors[0].details.cleanup_status, 'cleaned');
  assert.equal(completed.errors[0].details.cleanup_error, null);
});

test('media review rejects forbidden analyzer payloads before any public artifact is written', async (t) => {
  const cwd = await privateTemp(t, 'media-service-boundary-gate-');
  const input = path.join(cwd, 'source.mp4');
  await writeFile(input, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(256, 4)]), { mode: 0o600 });
  let forbidden = null;
  const context = {
    cwd,
    ephemeralMediaRoot: path.join(cwd, 'private-operations'),
    inspectTranscriptProviderReadiness: async () => readyTranscriptProvider(),
    inspectTechnicalMediaReadiness: async () => readyTechnicalAnalyzer(),
    collectResourceStatus: async () => healthyResourceStatus(),
    runTranscriptProvider: async (request) => ({
      operation: request.operation,
      transient: {
        schema_version: '1.0.0', type: 'transcript_provider_transient_result', operation_id: request.operation.operationId,
        media_identity: request.mediaIdentity, retention: request.retention, language: null, segments: [],
        method: providerTrustProjection(), limitations: [], privacy: { public_body_included: false }
      },
      projection: {
        schema_version: '1.0.0', type: 'transcript_provider_projection', status: 'insufficient', media_identity: request.mediaIdentity,
        language: null, segment_count: 0, timed_segment_count: 0, transcript_identity: 'c'.repeat(64),
        method: providerTrustProjection(), limitations: [], boundary: { body_included: false, absolute_paths_included: false }
      }
    }),
    analyzeLocalMediaTechnical: async (request) => ({ ...fixtureTechnicalAnalysis(request.mediaIdentity), ...forbidden })
  };
  const options = { input: 'source.mp4', rightsDeclared: true, retention: 'ephemeral', artifactRoot: '.artifacts-test' };
  const planned = await planMediaReview(options, context);
  const payloads = [
    { operationId: 'b'.repeat(32), value: { raw_frames: ['forbidden-frame'] } },
    { operationId: 'c'.repeat(32), value: { base64: 'Zm9yYmlkZGVu' } },
    { operationId: 'd'.repeat(32), value: { full_transcript: 'forbidden transcript body' } }
  ];
  for (const fixture of payloads) {
    forbidden = fixture.value;
    const completed = await executeMediaReview({
      ...options,
      execute: true,
      confirm: MEDIA_REVIEW_EXECUTION_CONFIRMATION,
      planHash: planned.data.plan.plan_hash,
      operationId: fixture.operationId
    }, context);
    assert.equal(completed.status, 'error');
    assert.equal(completed.errors[0].code, 'MEDIA_REVIEW_PUBLIC_BOUNDARY_VIOLATION');
    assert.equal(completed.errors[0].details.cleanup_status, 'cleaned');
    await assert.rejects(lstat(path.join(cwd, '.artifacts-test', 'media-review-results', `${fixture.operationId}.json`)), { code: 'ENOENT' });
  }
});

test('an authorized media execution reconciles expired retained CLI payloads', async (t) => {
  const cwd = await privateTemp(t, 'media-service-retention-reconcile-');
  const retainedRoot = path.join(cwd, 'retained-private');
  const ephemeralRoot = path.join(cwd, 'ephemeral-private');
  const oldContext = {
    retainedMediaRoot: retainedRoot,
    ephemeralMediaRoot: ephemeralRoot,
    now: new Date('2026-05-01T00:00:00.000Z')
  };
  let expired = await createPrivateMediaOperation({ operationId: '9'.repeat(32), retention: 'project-retained' }, oldContext);
  expired = await updatePrivateMediaOperation(expired, { state: 'running' }, oldContext);
  expired = await updatePrivateMediaOperation(expired, { state: 'completed_retained' }, oldContext);

  const input = path.join(cwd, 'source.mp4');
  await writeFile(input, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(256, 4)]), { mode: 0o600 });
  const context = {
    cwd,
    retainedMediaRoot: retainedRoot,
    ephemeralMediaRoot: ephemeralRoot,
    now: () => new Date('2026-07-18T00:00:00.000Z'),
    inspectTranscriptProviderReadiness: async () => readyTranscriptProvider(),
    inspectTechnicalMediaReadiness: async () => readyTechnicalAnalyzer(),
    collectResourceStatus: async () => healthyResourceStatus(),
    runTranscriptProvider: async (request) => ({
      operation: request.operation,
      transient: {
        schema_version: '1.0.0', type: 'transcript_provider_transient_result', operation_id: request.operation.operationId,
        media_identity: request.mediaIdentity, retention: request.retention, language: null, segments: [],
        method: providerTrustProjection(), limitations: [], privacy: { public_body_included: false }
      },
      projection: {
        schema_version: '1.0.0', type: 'transcript_provider_projection', status: 'insufficient', media_identity: request.mediaIdentity,
        language: null, segment_count: 0, timed_segment_count: 0, transcript_identity: 'd'.repeat(64),
        method: providerTrustProjection(), limitations: [], boundary: { body_included: false, absolute_paths_included: false }
      }
    }),
    analyzeLocalMediaTechnical: async (request) => fixtureTechnicalAnalysis(request.mediaIdentity)
  };
  const options = { input: 'source.mp4', rightsDeclared: true, retention: 'ephemeral', artifactRoot: '.artifacts-test' };
  const planned = await planMediaReview(options, context);
  const completed = await executeMediaReview({
    ...options,
    execute: true,
    confirm: MEDIA_REVIEW_EXECUTION_CONFIRMATION,
    planHash: planned.data.plan.plan_hash,
    operationId: '8'.repeat(32)
  }, context);
  assert.equal(completed.status, 'ok');
  await assert.rejects(lstat(expired.root), { code: 'ENOENT' });
});

test('media review aborts and awaits a sibling analyzer before private cleanup', async (t) => {
  const cwd = await privateTemp(t, 'media-service-sibling-');
  const input = path.join(cwd, 'source.mp4');
  await writeFile(input, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(256, 4)]), { mode: 0o600 });
  let siblingSawAbort = false;
  let siblingSettled = false;
  const context = {
    cwd,
    ephemeralMediaRoot: path.join(cwd, 'private-operations'),
    inspectTranscriptProviderReadiness: async () => readyTranscriptProvider(),
    inspectTechnicalMediaReadiness: async () => readyTechnicalAnalyzer(),
    collectResourceStatus: async () => healthyResourceStatus(),
    runTranscriptProvider: async () => {
      const error = new Error('provider fixture failed');
      error.code = 'MEDIA_PROVIDER_FIXTURE_FAILED';
      throw error;
    },
    analyzeLocalMediaTechnical: async (request) => new Promise((resolve, reject) => {
      const stop = () => {
        siblingSawAbort = true;
        setTimeout(() => {
          siblingSettled = true;
          const error = new Error('technical fixture cancelled');
          error.code = 'MEDIA_ANALYZER_FIXTURE_CANCELLED';
          reject(error);
        }, 25);
      };
      if (request.signal.aborted) stop();
      else request.signal.addEventListener('abort', stop, { once: true });
    })
  };
  const options = { input: 'source.mp4', rightsDeclared: true, retention: 'ephemeral', artifactRoot: '.artifacts-test' };
  const planned = await planMediaReview(options, context);
  const completed = await executeMediaReview({
    ...options,
    execute: true,
    confirm: MEDIA_REVIEW_EXECUTION_CONFIRMATION,
    planHash: planned.data.plan.plan_hash,
    operationId: '1'.repeat(32)
  }, context);
  assert.equal(completed.status, 'error');
  assert.equal(completed.errors[0].code, 'MEDIA_PROVIDER_FIXTURE_FAILED');
  assert.equal(siblingSawAbort, true);
  assert.equal(siblingSettled, true);
  assert.equal(completed.errors[0].details.cleanup_status, 'cleaned');
});

test('unconfirmed provider containment retains the private root until a restart boundary', async (t) => {
  const cwd = await privateTemp(t, 'media-containment-unconfirmed-');
  const input = path.join(cwd, 'source.mp4');
  await writeFile(input, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(256, 4)]), { mode: 0o600 });
  const operationId = 'e'.repeat(32);
  const firstBoot = '11111111-1111-1111-1111-111111111111';
  const context = {
    cwd,
    ephemeralMediaRoot: path.join(cwd, 'private-operations'),
    inspectTranscriptProviderReadiness: async () => readyTranscriptProvider(),
    inspectTechnicalMediaReadiness: async () => readyTechnicalAnalyzer(),
    collectResourceStatus: async () => healthyResourceStatus(),
    captureMediaBootIdentity: async () => firstBoot,
    runTranscriptProvider: async () => {
      const error = new Error('fixture containment uncertainty');
      error.code = 'MEDIA_PROVIDER_CONTAINMENT_UNCONFIRMED';
      throw error;
    },
    analyzeLocalMediaTechnical: async (request) => fixtureTechnicalAnalysis(request.mediaIdentity)
  };
  const options = { input: 'source.mp4', rightsDeclared: true, retention: 'ephemeral', artifactRoot: '.artifacts-test' };
  const planned = await planMediaReview(options, context);
  const completed = await executeMediaReview({
    ...options,
    execute: true,
    confirm: MEDIA_REVIEW_EXECUTION_CONFIRMATION,
    planHash: planned.data.plan.plan_hash,
    operationId
  }, context);
  assert.equal(completed.status, 'error');
  assert.equal(completed.errors[0].code, 'MEDIA_PROVIDER_CONTAINMENT_UNCONFIRMED');
  assert.equal(completed.errors[0].details.cleanup_status, 'deferred_containment_unconfirmed');
  const explicitCleanup = await cleanupMediaReview({
    operationId,
    retention: 'ephemeral',
    execute: true,
    confirm: MEDIA_REVIEW_CLEANUP_CONFIRMATION
  }, context);
  assert.equal(explicitCleanup.status, 'error');
  assert.equal(explicitCleanup.errors[0].code, 'MEDIA_REVIEW_CLEANUP_LIVE_REFUSED');
  const retained = await findPrivateMediaOperation(operationId, 'ephemeral', context);
  assert.equal(retained.marker.state, 'cleanup_required');
  assert.notEqual(retained.marker.lease, null);
  assert.equal(retained.marker.lease.containment_unconfirmed, true);
  const sameBoot = await reconcilePrivateMediaOperations({
    ...context,
    captureMediaProcessIdentity: async () => '999999',
    captureMediaBootIdentity: async () => firstBoot
  });
  assert.equal(sameBoot.records.find((record) => record.operation_id === operationId).action, 'none');
  const cleanupAfterProcessRestart = await cleanupMediaReview({
    operationId,
    retention: 'ephemeral',
    execute: true,
    confirm: MEDIA_REVIEW_CLEANUP_CONFIRMATION
  }, context);
  assert.equal(cleanupAfterProcessRestart.status, 'error');
  assert.equal(cleanupAfterProcessRestart.errors[0].code, 'MEDIA_REVIEW_CLEANUP_LIVE_REFUSED');
  const restarted = await reconcilePrivateMediaOperations({
    ...context,
    captureMediaProcessIdentity: async () => '999999',
    captureMediaBootIdentity: async () => '22222222-2222-2222-2222-222222222222'
  });
  assert.equal(restarted.records.find((record) => record.operation_id === operationId).action, 'released_stale_cleanup_lease');
  const cleanupAfterRestart = await cleanupMediaReview({
    operationId,
    retention: 'ephemeral',
    execute: true,
    confirm: MEDIA_REVIEW_CLEANUP_CONFIRMATION
  }, context);
  assert.equal(cleanupAfterRestart.status, 'ok');
  assert.equal(cleanupAfterRestart.data.cleanup_receipt.status, 'cleaned');
});

test('media review rejects transcript timecodes beyond the measured duration', async (t) => {
  const cwd = await privateTemp(t, 'media-service-duration-');
  const input = path.join(cwd, 'source.mp4');
  await writeFile(input, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(256, 4)]), { mode: 0o600 });
  const context = {
    cwd,
    ephemeralMediaRoot: path.join(cwd, 'private-operations'),
    inspectTranscriptProviderReadiness: async () => readyTranscriptProvider(),
    inspectTechnicalMediaReadiness: async () => readyTechnicalAnalyzer(),
    collectResourceStatus: async () => healthyResourceStatus(),
    runTranscriptProvider: async (request) => ({
      operation: request.operation,
      transient: {
        schema_version: '1.0.0', type: 'transcript_provider_transient_result', operation_id: request.operation.operationId,
        media_identity: request.mediaIdentity, retention: request.retention, language: 'en',
        segments: [{ id: 'outside-duration', start_us: 0, end_us: 2_000_000, text: 'Private out-of-range cue.', language: 'en', speaker: null, confidence: null, timed: true, needs_review: true }],
        method: providerTrustProjection(), limitations: [], privacy: { public_body_included: false }
      },
      projection: {
        schema_version: '1.0.0', type: 'transcript_provider_projection', status: 'available', media_identity: request.mediaIdentity,
        language: 'en', segment_count: 1, timed_segment_count: 1, transcript_identity: 'b'.repeat(64),
        method: providerTrustProjection(), limitations: [], boundary: { body_included: false, absolute_paths_included: false }
      }
    }),
    analyzeLocalMediaTechnical: async (request) => fixtureTechnicalAnalysis(request.mediaIdentity)
  };
  const options = { input: 'source.mp4', rightsDeclared: true, retention: 'ephemeral', artifactRoot: '.artifacts-test' };
  const planned = await planMediaReview(options, context);
  const completed = await executeMediaReview({
    ...options,
    execute: true,
    confirm: MEDIA_REVIEW_EXECUTION_CONFIRMATION,
    planHash: planned.data.plan.plan_hash,
    operationId: '2'.repeat(32)
  }, context);
  assert.equal(completed.status, 'error');
  assert.equal(completed.errors[0].code, 'MEDIA_REVIEW_TRANSCRIPT_DURATION_MISMATCH');
  assert.equal(completed.errors[0].details.cleanup_status, 'cleaned');
});

test('media CLI exposes read-only inspection and keeps execution confirmation-bound', async () => {
  const source = await executeCli([
    'media', 'source', 'inspect', '--url', 'https://www.youtube.com/watch?v=public-id&token=SECRET', '--json'
  ]);
  assert.equal(source.exitCode, 0);
  assert.equal(source.envelope.data.source_decision.capabilities[0], 'playback_inspection');
  assert.equal(source.stdout.includes('SECRET'), false);

  const missingExecute = parseCliArgs([
    'media', 'review', 'run', '--input', 'video.mp4',
    '--rights-confirm', 'use-owned-or-authorized-media', '--plan-hash', 'a'.repeat(64),
    '--confirm', 'execute-media-review'
  ]);
  assert.equal(missingExecute.ok, false);
  assert.equal(missingExecute.error.code, 'MISSING_REQUIRED_OPTION');

  const readiness = await executeCli(['media', 'review', 'readiness', '--json'], {
    mediaReviewReadinessRunner: async () => ({ status: 'ok', data: { readiness: { status: 'ready' } }, warnings: [], errors: [], artifacts: [] })
  });
  assert.equal(readiness.exitCode, 0);
  assert.equal(readiness.envelope.data.readiness.status, 'ready');

  const comparison = await executeCli([
    'media', 'review', 'compare', '--baseline', '1'.repeat(32), '--candidate', '2'.repeat(32), '--json'
  ], {
    mediaReviewComparisonRunner: async (options) => {
      assert.equal(options.baseline, '1'.repeat(32));
      assert.equal(options.candidate, '2'.repeat(32));
      assert.equal(options.execute, false);
      return { status: 'ok', data: { media_review_comparison: { type: 'media_review_comparison' } }, warnings: [], errors: [], artifacts: [] };
    }
  });
  assert.equal(comparison.exitCode, 0);
  assert.equal(comparison.envelope.command, 'media review compare');
  const unsafeComparison = parseCliArgs([
    'media', 'review', 'compare', '--baseline', '1'.repeat(32), '--candidate', '2'.repeat(32), '--execute'
  ]);
  assert.equal(unsafeComparison.ok, false);
  assert.equal(unsafeComparison.error.code, 'CONFLICTING_OPTIONS');
});

test('media schemas and operations are registered without expanding MCP profiles', async () => {
  for (const name of [
    'media_review_policy', 'media_source_decision', 'media_transcript_provider_profile',
    'transcript_provider', 'media_analysis', 'media_timeline', 'media_review_operation',
    'media_review_result', 'media_review_comparison_policy', 'media_review_comparison',
    'media_cleanup_receipt', 'control_center_media_review'
  ]) {
    assert.equal(schemaNames().includes(name), true, `${name} must be registered`);
    assert.equal(getSchema(name)?.$schema, 'https://json-schema.org/draft/2020-12/schema');
  }
  const registry = buildOperationRegistryReport({ group: 'media_review' }, { now: new Date('2026-07-18T00:00:00.000Z') });
  assert.equal(registry.ok, true);
  assert.deepEqual(registry.report.operations.map((operation) => operation.id), [
    'media_source_inspect', 'media_review_readiness_plan', 'media_review_run', 'media_review_cancel', 'media_review_compare', 'media_review_cleanup'
  ]);
  assert.equal(registry.report.operations.every((operation) => Object.values(operation.current_mcp_exposure).every((enabled) => enabled === false)), true);
  for (const profile of ['safe', 'full', 'admin']) {
    assert.equal(getMcpTools(profile).some((tool) => tool.name.includes('media_review') || tool.name.includes('transcript_provider')), false);
  }
  const api = await import('../src/api.js');
  assert.equal(typeof api.executeMediaReview, 'function');
  assert.equal(typeof api.runMediaReviewComparison, 'function');
  assert.equal(typeof api.buildMediaReviewComparison, 'function');
  assert.equal(typeof api.createControlCenterMediaReviewRuntime, 'function');
});

async function privateTemp(t, prefix) {
  const parent = path.join(os.homedir(), '.local', 'state', 'trace-cue-media-review-tests');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(path.join(parent, prefix));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return root;
}

function providerProfile(overrides = {}) {
  return {
    schema_version: '1.0.0',
    adapter_contract: 'caller-owned-local-asr-cli-v1',
    runtime: {
      node_executable: '/trusted/node', node_sha256: '1'.repeat(64),
      entrypoint: '/trusted/provider.mjs', entrypoint_sha256: '2'.repeat(64),
      package_root: '/trusted/provider', git_executable: '/trusted/git', git_sha256: '5'.repeat(64),
      expected_revision: '3'.repeat(40), require_clean_tree: true
    },
    engine: 'faster-whisper',
    environment: {},
    ...overrides
  };
}

function providerTrust() {
  return {
    adapterContract: 'caller-owned-local-asr-cli-v1', runtimeKind: 'node_git_checkout_cli', nodeExecutable: '/trusted/node',
    entrypoint: '/trusted/provider.mjs', packageRoot: '/trusted/provider', gitExecutable: '/trusted/git',
    revision: '3'.repeat(40), packageVersion: '1.0.0', engine: 'faster-whisper', env: { NO_COLOR: '1' },
    identity: '4'.repeat(64)
  };
}

function processSuccess(stdout) {
  return { ok: true, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), shell_used: false };
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function optionValue(args, option) {
  return args[args.indexOf(option) + 1];
}

function readyTranscriptProvider() {
  return { schema_version: '1.0.0', type: 'transcript_provider_readiness', status: 'ready', capabilities: ['local_file_transcription'], limitations: [], boundary: { network_performed: false } };
}

function readyPreparedTranscriptProvider() {
  return {
    ...readyTranscriptProvider(),
    capabilities: ['local_file_transcription', 'caller_prepared_audio'],
    input_contract: {
      adapter_contract: 'caller-owned-prepared-audio-cli-v2',
      mode: 'caller_prepared_audio',
      prepared_audio_contract: {
        schema_version: '1.0.0', manifest_kind: 'framecue-prepared-audio-input',
        registration_result_kind: 'framecue-prepared-audio-registration-result', provider_result_kind: 'framecue-transcript-provider-result',
        format: { container: 'wav', codec: 'pcm_s16le', sample_rate_hz: 16_000, channel_count: 1, bits_per_sample: 16, header_bytes: 44 },
        rounding_rule: 'nearest-half-away-from-zero'
      }
    }
  };
}

function preparedProviderTrustProjection() {
  return {
    ...providerTrustProjection(),
    adapter_contract: 'caller-owned-prepared-audio-cli-v2',
    acquisition: 'local_cli_offline_prepared_audio',
    prepared_audio_contract: '1.0.0', prepared_audio_identity: 'a'.repeat(64),
    preparation_manifest_identity: 'b'.repeat(64), preparation_settings_identity: 'c'.repeat(64),
    registration_identity: 'd'.repeat(64), provider_receipt_identity: 'e'.repeat(64),
    computation_identity: 'f'.repeat(64), sample_zero_source_time_us: 125_000
  };
}

function readyTechnicalAnalyzer() {
  return { schema_version: '1.0.0', type: 'media_technical_analyzer_readiness', status: 'ready', capabilities: ['frame_timing'], limitations: [], boundary: { network_performed: false } };
}

function providerTrustProjection() {
  return { adapter_contract: 'fixture-local-cli-v1', runtime_kind: 'node_git_checkout_cli', provider_version: '1.0.0', provider_revision: '1'.repeat(40), toolchain_identity: '2'.repeat(64), absolute_paths_included: false, environment_values_included: false };
}

function healthyResourceStatus() {
  return {
    status: 'ok', source: 'fixture', recommended_action: 'continue',
    memory: { available_bytes: 1_000_000_000, available_ratio: 0.8, swap_used_bytes: 0, swap_used_ratio: 0 },
    cgroup: { available: false, current_bytes: null, limit_bytes: null, usage_ratio: null },
    pressure: { available: false, some: null, full: null }
  };
}

async function comparisonFixtureResult(t, operationId) {
  const cwd = await privateTemp(t, 'media-comparison-');
  const input = path.join(cwd, 'source.mp4');
  await writeFile(input, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(512, 6)]), { mode: 0o600 });
  const context = {
    cwd,
    ephemeralMediaRoot: path.join(cwd, 'private-operations'),
    inspectTranscriptProviderReadiness: async () => readyTranscriptProvider(),
    inspectTechnicalMediaReadiness: async () => readyTechnicalAnalyzer(),
    collectResourceStatus: async () => healthyResourceStatus(),
    runTranscriptProvider: async (request) => ({
      operation: request.operation,
      transient: {
        schema_version: '1.0.0', type: 'transcript_provider_transient_result',
        operation_id: request.operation.operationId, media_identity: request.mediaIdentity,
        retention: request.retention, language: 'en',
        segments: [{
          id: 'speech-1', start_us: 0, end_us: 900_000,
          text: 'Private comparison fixture body.', language: 'en', speaker: null,
          confidence: null, timed: true, needs_review: true
        }],
        method: providerTrustProjection(), limitations: [], privacy: { public_body_included: false }
      },
      projection: {
        schema_version: '1.0.0', type: 'transcript_provider_projection', status: 'available',
        media_identity: request.mediaIdentity, language: 'en', segment_count: 1, timed_segment_count: 1,
        transcript_identity: '9'.repeat(64), method: providerTrustProjection(), limitations: [
          'provider_model_reference_identity_is_not_a_model_weight_hash',
          'provider_external_runtime_dependencies_are_not_cryptographically_bound'
        ],
        boundary: { body_included: false, absolute_paths_included: false }
      }
    }),
    analyzeLocalMediaTechnical: async (request) => fixtureTechnicalAnalysis(request.mediaIdentity)
  };
  const options = { input: 'source.mp4', rightsDeclared: true, retention: 'ephemeral', artifactRoot: '.fixture-artifacts' };
  const planned = await planMediaReview(options, context);
  assert.equal(planned.status, 'ok');
  const completed = await executeMediaReview({
    ...options,
    execute: true,
    confirm: MEDIA_REVIEW_EXECUTION_CONFIRMATION,
    planHash: planned.data.plan.plan_hash,
    operationId
  }, context);
  assert.equal(completed.status, 'ok');
  return { cwd, result: completed.data.result };
}

function comparisonResultVariant(original, options = {}) {
  const result = structuredClone(original);
  result.operation_id = options.operationId ?? result.operation_id;
  const mediaSha256 = options.mediaSha256 ?? result.media_identity.sha256;
  result.media_identity.sha256 = mediaSha256;
  result.technical_analysis.media_identity.sha256 = mediaSha256;
  result.transcript.media_identity.sha256 = mediaSha256;
  result.content_evidence.source.media_id = mediaSha256;
  result.content_evidence.provenance.input_hash = mediaSha256;
  if (Number.isSafeInteger(options.duplicateFrameCount)) {
    result.technical_analysis.technical_metrics.duplicate_frame_count = options.duplicateFrameCount;
  }
  if (options.deterministicFindings) result.deterministic_findings = structuredClone(options.deterministicFindings);
  if (options.advisoryFindings) result.advisory_findings = structuredClone(options.advisoryFindings);
  return result;
}

function comparisonFinding({
  id,
  classification,
  kind = 'duplicate_frame_run',
  method = 'frame_hash_measurement',
  startUs = 100_000,
  endUs = 500_000,
  severity = 'medium'
}) {
  return {
    schema_version: '1.0.0', id, kind, start_us: startUs, end_us: endUs,
    timecode: { start: comparisonTimecode(startUs), end: comparisonTimecode(endUs) },
    severity, evidence: ['Bounded comparison fixture evidence.'], evidence_refs: [`time:${startUs}-${endUs}`],
    method, confidence: 0.8, classification, limitations: [],
    recommendation: 'Review this bounded time range.', recommendation_classification: 'advisory_evaluation',
    scene_reference: { start_us: startUs, end_us: endUs }
  };
}

function comparisonTimecode(valueUs) {
  const milliseconds = Math.floor(valueUs / 1000);
  const seconds = Math.floor(milliseconds / 1000);
  return `00:00:${String(seconds).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`;
}

function fixtureTechnicalAnalysis(mediaIdentity) {
  return {
    schema_version: '1.0.0', type: 'media_technical_analysis', status: 'available',
    media_identity: mediaIdentity, timebase: 'microseconds',
    technical_metrics: {
      duration_us: 1_000_000, frame_count_analyzed: 25, effective_fps: 25, nominal_fps: 25,
      video_codec: 'h264', audio_codec: 'aac',
      median_frame_interval_us: 40_000, frame_interval_variance_us2: 0, frame_interval_jitter_ratio: 0,
      duplicate_frame_count: 0, presentation_gap_count: 0, cut_count: 0, subtitle_event_count: 0,
      presentation_timestamps_us: [0, 40_000], deterministic: true
    },
    frame_intervals: { minimum_us: 40_000, maximum_us: 40_000, warning: false, median_us: 40_000, variance_us2: 0, jitter_ratio: 0 }, duplicate_frames: [], dropped_frame_intervals: [],
    audio_video_sync: { status: 'available', method: 'container_stream_start_pts', offset_us: 0, absolute_offset_us: 0, warning: false, interpretation: 'aligned_container_start', classification: 'deterministic_measurement', perceptual_lip_sync_measured: false },
    shot_boundaries: [{ id: 'shot-0001', start_us: 0, end_us: 1_000_000, cut_score: null, classification: 'deterministic_measurement' }], subtitle_events: [],
    method: { classification: 'deterministic_measurement', analyzer_contract: 'ffmpeg-cli-local-v1', probe_identity: '3'.repeat(64), analyzer_identity: '4'.repeat(64), probe_version: 'fixture', analyzer_version: 'fixture', absolute_paths_included: false, scene_threshold: 0.3, maximum_frames: 36000 },
    limitations: ['container_pts_sync_is_not_perceptual_lip_sync'],
    boundary: { local_only: true, raw_media_included: false, raw_audio_included: false, raw_frames_included: false, base64_included: false, absolute_paths_included: false, external_send_performed: false, network_performed: false, shell_used: false }
  };
}

function mediaSchemaResources() {
  return {
    'media-source-decision.schema.json': getSchema('media_source_decision'),
    'media-analysis.schema.json': getSchema('media_analysis'),
    'media-timeline.schema.json': getSchema('media_timeline'),
    'transcript-provider.schema.json': getSchema('transcript_provider')
  };
}

async function sha256File(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

function runGitFixture(root, args) {
  return runFixedProcess({
    executable: '/usr/bin/git',
    args: ['-C', root, ...args],
    cwd: root,
    env: { HOME: root, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: '/usr/bin:/bin' },
    timeoutMs: 15_000,
    maxStdoutBytes: 1024 * 1024,
    maxStderrBytes: 1024 * 1024
  });
}
