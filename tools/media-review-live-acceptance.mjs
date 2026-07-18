import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cleanupPrivateMediaOperation, createPrivateMediaOperation } from '../src/media-private-operation.js';
import { inspectStableMediaFile } from '../src/media-stable-file.js';
import { inspectTranscriptProviderReadiness } from '../src/media-transcript-provider.js';
import { inspectTechnicalMediaReadiness, resolveTechnicalMediaToolchain } from '../src/media-technical-analyzer.js';
import { runFixedProcess } from '../src/fixed-process-runner.js';
import { executeMediaReview, MEDIA_REVIEW_EXECUTION_CONFIRMATION, planMediaReview } from '../src/media-review-service.js';
import { createControlCenterMediaReviewStore } from '../src/control-center-media-review-store.js';

await runLiveMediaAcceptance();

async function runLiveMediaAcceptance() {
  const [providerReadiness, analyzerReadiness] = await Promise.all([
    inspectTranscriptProviderReadiness(),
    inspectTechnicalMediaReadiness()
  ]);
  if (providerReadiness.status !== 'ready' || analyzerReadiness.status !== 'ready') {
    assert.equal(providerReadiness.boundary.external_send_performed, false);
    assert.equal(providerReadiness.boundary.mcp_execution_performed, false);
    assert.fail(`explicit live media gate requires ready local adapters (provider=${providerReadiness.status}:${providerReadiness.limitations.join(',')}, analyzer=${analyzerReadiness.status}:${analyzerReadiness.limitations.join(',')})`);
  }
  assert.equal(providerReadiness.input_contract.mode, 'caller_prepared_audio');
  assert.equal(providerReadiness.input_contract.prepared_audio_contract.schema_version, '1.0.0');

  const parent = path.join(os.homedir(), '.local', 'state', 'trace-cue-media-live-tests');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const base = await mkdtemp(path.join(parent, 'framecue-'));
  let operation = null;
  try {
    operation = await createPrivateMediaOperation({ retention: 'ephemeral' }, { ephemeralMediaRoot: base });
    const inputDirectory = path.join(operation.root, 'input');
    await mkdir(inputDirectory, { mode: 0o700 });
    const mediaPath = path.join(inputDirectory, 'source.mp4');
    const toolchain = await resolveTechnicalMediaToolchain();
    const generated = await runFixedProcess({
      executable: toolchain.analyzer.path,
      args: [
        '-hide_banner', '-v', 'error', '-nostdin',
        '-f', 'lavfi', '-i', 'color=c=0x102030:s=320x180:r=25:d=6',
        '-f', 'lavfi', '-i', "flite=text='Trace Cue reviews video timing and captions safely':voice=kal",
        '-map', '0:v:0', '-map', '1:a:0', '-shortest',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '16000', '-ac', '1',
        '-movflags', '+faststart', '-y', mediaPath
      ],
      cwd: operation.root,
      env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: '/usr/bin:/bin' },
      timeoutMs: 60_000,
      maxStdoutBytes: 256 * 1024,
      maxStderrBytes: 1024 * 1024
    });
    assert.equal(generated.ok, true);
    await chmod(mediaPath, 0o600);
    const sourceIdentity = await inspectStableMediaFile(mediaPath, { maxBytes: 16 * 1024 * 1024, requirePrivate: true, extension: '.mp4' });
    const workspace = path.join(base, 'workspace');
    const executionRoot = path.join(base, 'execution');
    await mkdir(workspace, { mode: 0o700 });
    const context = { cwd: workspace, mediaInputRoot: operation.root, ephemeralMediaRoot: executionRoot };
    const options = { input: mediaPath, rightsDeclared: true, retention: 'ephemeral', artifactRoot: '.artifacts' };
    const planned = await planMediaReview(options, context);
    assert.equal(planned.status, 'ok');
    assert.equal(planned.data.plan.executable, true);
    assert.equal(planned.data.plan.media_identity.sha256, sourceIdentity.sha256);
    const completed = await executeMediaReview({
      ...options,
      operationId: '5'.repeat(32),
      execute: true,
      confirm: MEDIA_REVIEW_EXECUTION_CONFIRMATION,
      planHash: planned.data.plan.plan_hash
    }, context);
    assert.equal(completed.status, 'ok', JSON.stringify({ errors: completed.errors, warnings: completed.warnings }));
    assert.equal(completed.data.cleanup_receipt.status, 'cleaned');
    assert.equal(completed.data.result.transcript.status, 'available');
    assert.ok(completed.data.result.transcript.segment_count >= 1);
    assert.ok(completed.data.result.transcript.timed_segment_count >= 1);
    assert.equal(completed.data.result.transcript.method.provider_revision, providerReadiness.method.provider_revision);
    assert.equal(completed.data.result.transcript.method.acquisition, 'local_cli_offline_prepared_audio');
    assert.match(completed.data.result.transcript.method.prepared_audio_identity, /^[a-f0-9]{64}$/u);
    assert.match(completed.data.result.transcript.method.preparation_manifest_identity, /^[a-f0-9]{64}$/u);
    assert.match(completed.data.result.transcript.method.registration_identity, /^[a-f0-9]{64}$/u);
    assert.match(completed.data.result.transcript.method.provider_receipt_identity, /^[a-f0-9]{64}$/u);
    assert.equal(Number.isSafeInteger(completed.data.result.transcript.method.sample_zero_source_time_us), true);
    assert.equal(completed.data.result.transcript.boundary.body_included, false);
    assert.equal(completed.data.result.boundary.absolute_paths_included, false);
    assert.equal(completed.data.result.privacy.external_send_performed, false);
    const serialized = JSON.stringify(completed.data.result);
    assert.equal(serialized.includes('Trace Cue reviews video timing and captions safely'), false);
    assert.equal(serialized.includes(operation.root), false);
    const store = createControlCenterMediaReviewStore({ cwd: workspace, artifactRoot: '.artifacts' });
    await store.writeResult('5'.repeat(32), completed.data.result);
    assert.equal((await store.load()).length, 0, 'a result is never published without its operation projection');
  } finally {
    if (operation) await cleanupPrivateMediaOperation(operation, { reason: 'live_provider_acceptance', allowLive: true }).catch(() => {});
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
  process.stdout.write('Real local transcript-provider media acceptance passed.\n');
}
