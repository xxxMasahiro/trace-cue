import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPrivateMediaOperation, cleanupPrivateMediaOperation } from '../src/media-private-operation.js';
import { copyStableMediaFile } from '../src/media-stable-file.js';
import {
  decodedTimelineOriginMicroseconds,
  prepareLocalMediaAudio,
  roundRationalHalfAwayFromZero
} from '../src/media-prepared-audio.js';
import { inspectTranscriptProviderReadiness, runTranscriptProvider } from '../src/media-transcript-provider.js';
import { preflightLocalMediaTechnical } from '../src/media-technical-analyzer.js';
import { loadMediaReviewAdapterCatalog, loadMediaReviewPolicy, resolveMediaReviewAdapter } from '../src/media-review-policy.js';
import { getSchema } from '../src/schema-registry.js';
import { validateJsonSchemaSubset } from '../src/json-schema-subset.js';

test('prepared-audio catalog is additive and keeps the legacy adapter intact', async () => {
  const policy = await loadMediaReviewPolicy({ disableMediaReviewPolicyCache: true });
  const catalog = await loadMediaReviewAdapterCatalog(policy, { disableMediaReviewPolicyCache: true });
  const legacy = resolveMediaReviewAdapter(catalog, 'caller-owned-local-asr-cli-v1');
  const prepared = resolveMediaReviewAdapter(catalog, 'caller-owned-prepared-audio-cli-v2');
  assert.equal(legacy.input_mode, 'source_media');
  assert.equal(legacy.commands.import_media[0], 'import-video');
  assert.equal(prepared.input_mode, 'caller_prepared_audio');
  assert.deepEqual(Object.keys(prepared.commands).sort(), ['initialize', 'readiness', 'register_prepared', 'transcribe']);
  assert.equal(prepared.commands.transcribe.includes('video'), false);
  assert.equal(prepared.prepared_audio_contract.schema_version, '1.0.0');
  assert.equal(prepared.prepared_audio_contract.format.header_bytes, 44);
});

test('prepared-audio rational timeline uses signed half-away-from-zero arithmetic', () => {
  assert.equal(roundRationalHalfAwayFromZero(1n, 2n), 1n);
  assert.equal(roundRationalHalfAwayFromZero(-1n, 2n), -1n);
  assert.equal(decodedTimelineOriginMicroseconds({
    basis: 'first_decoded_frame_pts',
    video_first_timestamp_seconds: '1.0000000',
    audio_first_timestamp_seconds: '1.1250005'
  }), 125001);
  assert.equal(decodedTimelineOriginMicroseconds({
    basis: 'first_decoded_frame_pts',
    video_first_timestamp_seconds: '1.1250005',
    audio_first_timestamp_seconds: '1.0000000'
  }), -125001);
});

test('technical preflight measures first decoded video and audio timestamps separately', async () => {
  const identity = { sha256: '1'.repeat(64), bytes: 4096, format: 'iso-base-media' };
  const calls = [];
  const technicalProcessRunner = async ({ args }) => {
    calls.push([...args]);
    if (args.includes('-show_streams')) {
      return success(JSON.stringify({
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'h264', width: 320, height: 180, start_time: '1.000000' },
          { index: 1, codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2, start_time: '1.125000' }
        ],
        format: { duration: '2.000000', size: '4096', format_name: 'mov,mp4' }
      }));
    }
    const selector = args[args.indexOf('-select_streams') + 1];
    return success(JSON.stringify({
      frames: [
        { media_type: selector === 'v:0' ? 'video' : 'audio', best_effort_timestamp_time: 'N/A' },
        { best_effort_timestamp_time: selector === 'v:0' ? '1.000000' : '1.125000' }
      ]
    }));
  };
  const result = await preflightLocalMediaTechnical({
    mediaPath: '/private-operation/input/source.mp4',
    operationRoot: '/private-operation',
    mediaIdentity: identity,
    includeDecodedTimeline: true
  }, {
    inspectTechnicalMediaFile: async () => identity,
    technicalMediaToolchain: toolchain(),
    technicalProcessRunner
  });
  assert.deepEqual(result.decoded_timeline, {
    basis: 'first_decoded_frame_pts',
    video_first_timestamp_seconds: '1.000000',
    audio_first_timestamp_seconds: '1.125000'
  });
  assert.equal(calls.length, 3);
  assert.equal(calls.filter((args) => args.includes('-show_frames')).length, 2);
  assert.equal(calls.filter((args) => args.includes('%+#64')).length, 2);
});

test('TraceCue prepares one exact private 44-byte PCM WAV and strict manifest', async (t) => {
  const fixture = await preparedFixture(t, { rawBytes: Buffer.alloc(32_000, 3) });
  assert.equal(fixture.processCalls.length, 1);
  const wave = await readFile(fixture.prepared.audio.path);
  assert.equal(wave.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wave.toString('ascii', 12, 16), 'fmt ');
  assert.equal(wave.toString('ascii', 36, 40), 'data');
  assert.equal(wave.readUInt32LE(40), 32_000);
  assert.equal(wave.length, 32_044);
  assert.equal(fixture.prepared.audio.sample_count, 16_000);
  assert.equal(fixture.prepared.timeline.sampleZeroSourceTimeMicroseconds, 125_000);
  assert.equal(fixture.prepared.timeline.durationMilliseconds, 1000);
  const manifest = JSON.parse(await readFile(fixture.prepared.manifest.path, 'utf8'));
  assert.equal(manifest.kind, 'framecue-prepared-audio-input');
  assert.equal(manifest.preparedAudio.digest, sha256(wave));
  assert.equal(manifest.sourceMedia.digest, fixture.staged.sha256);
  assert.deepEqual(manifest.preparation.tools.map((tool) => tool.id), ['ffprobe', 'ffmpeg']);
  assert.deepEqual(manifest.privacy, {
    sourceMediaPathIncluded: false,
    sourceUrlIncluded: false,
    transcriptBodyIncluded: false,
    externalSendRequired: false,
    networkRequired: false
  });
  assert.equal(JSON.stringify(manifest).includes(fixture.operation.root), false);
  assert.equal(fixture.processCalls[0].args.includes(fixture.staged.path), true);
  assert.equal(fixture.processCalls[0].args.includes('-nostdin'), true);
  assert.equal(fixture.processCalls[0].args.includes('file,pipe'), true);
  assert.equal(option(fixture.processCalls[0].args, '-t'), '600.000000');
  assert.equal(option(fixture.processCalls[0].args, '-fs'), String(33_554_432 - 44));
});

test('prepared-audio creation refuses partial PCM and leaves cleanup to the owned operation', async (t) => {
  const base = await privateTemp(t, 'prepared-invalid-');
  const operation = await createPrivateMediaOperation({ operationId: '2'.repeat(32), retention: 'ephemeral' }, { ephemeralMediaRoot: base });
  await mkdir(path.join(operation.root, 'input'), { mode: 0o700 });
  const source = path.join(base, 'source.mp4');
  await writeFile(source, videoBytes(), { mode: 0o600 });
  const staged = await copyStableMediaFile(source, path.join(operation.root, 'input', 'source.mp4'), { maxBytes: 4096 });
  const adapter = await preparedAdapter();
  await assert.rejects(prepareLocalMediaAudio({
    operation,
    mediaPath: staged.path,
    mediaIdentity: staged,
    decodedTimeline: decodedTimeline(),
    contract: adapter.prepared_audio_contract
  }, {
    ephemeralMediaRoot: base,
    technicalMediaToolchain: toolchain(),
    preparedAudioProcessRunner: async ({ args }) => {
      await writeFile(args.at(-1), Buffer.alloc(3), { mode: 0o600 });
      return success('');
    }
  }), { code: 'MEDIA_PREPARED_AUDIO_PCM_INVALID' });
  assert.equal((await cleanupPrivateMediaOperation(operation)).status, 'cleaned');
});

test('prepared-audio extraction applies in-flight caps and refuses a cap-sized output', async (t) => {
  const base = await privateTemp(t, 'prepared-output-cap-');
  const operation = await createPrivateMediaOperation({ operationId: '9'.repeat(32), retention: 'ephemeral' }, { ephemeralMediaRoot: base });
  await mkdir(path.join(operation.root, 'input'), { mode: 0o700 });
  const source = path.join(base, 'source.mp4');
  await writeFile(source, videoBytes(), { mode: 0o600 });
  const staged = await copyStableMediaFile(source, path.join(operation.root, 'input', 'source.mp4'), { maxBytes: 4096 });
  const adapter = await preparedAdapter();
  const policy = await loadMediaReviewPolicy();
  policy.prepared_audio.maximum_prepared_audio_bytes = 1024;
  policy.prepared_audio.copy_chunk_bytes = 128;
  let argv;
  await assert.rejects(prepareLocalMediaAudio({
    operation, mediaPath: staged.path, mediaIdentity: staged,
    decodedTimeline: decodedTimeline(), contract: adapter.prepared_audio_contract
  }, {
    ephemeralMediaRoot: base,
    mediaReviewPolicy: policy,
    technicalMediaToolchain: toolchain(),
    preparedAudioProcessRunner: async (request) => {
      argv = request.args;
      await writeFile(request.args.at(-1), Buffer.alloc(1024 - 44), { mode: 0o600 });
      return success('');
    }
  }), { code: 'MEDIA_PREPARED_AUDIO_OUTPUT_LIMIT_REACHED' });
  assert.equal(option(argv, '-fs'), String(1024 - 44));
  assert.equal(option(argv, '-t'), '600.000000');
  assert.equal((await cleanupPrivateMediaOperation(operation)).status, 'cleaned');
});

test('prepared adapter catalog refuses any drift from the fixed FrameCue argv', async () => {
  const policy = await loadMediaReviewPolicy();
  const baseline = await loadMediaReviewAdapterCatalog(policy);
  const mutations = [
    (adapter) => { adapter.commands.transcribe = ['local-asr', 'setup']; },
    (adapter) => { adapter.commands.transcribe = adapter.commands.transcribe.filter((value) => value !== 'execute-local-asr'); },
    (adapter) => { adapter.commands.register_prepared = ['ingest', '--url', 'https://example.test/media']; },
    (adapter) => { adapter.commands.readiness = adapter.commands.readiness.filter((value) => value !== '--json'); },
    (adapter) => { adapter.commands.initialize = adapter.commands.initialize.filter((value) => value !== '{operation_root}'); }
  ];
  for (const mutate of mutations) {
    const catalog = structuredClone(baseline);
    mutate(catalog.adapters.find((adapter) => adapter.input_mode === 'caller_prepared_audio'));
    await assert.rejects(loadMediaReviewAdapterCatalog(policy, {
      mediaReviewAdapterCatalog: catalog,
      disableMediaReviewPolicyCache: true
    }), { code: 'MEDIA_REVIEW_ADAPTER_CATALOG_INVALID' });
  }
});

test('legacy policy and adapter catalog receive safe defaults without changing v1 output mode', async () => {
  const legacyPolicy = await loadMediaReviewPolicy();
  legacyPolicy.policy_version = '1.0.0';
  delete legacyPolicy.prepared_audio;
  delete legacyPolicy.technical_analyzer.decoded_timeline_probe_packets;
  const normalizedPolicy = await loadMediaReviewPolicy({ mediaReviewPolicy: legacyPolicy });
  assert.equal(normalizedPolicy.prepared_audio.maximum_prepared_audio_bytes, 33_554_432);
  assert.equal(normalizedPolicy.technical_analyzer.decoded_timeline_probe_packets, 64);
  const catalog = await loadMediaReviewAdapterCatalog(normalizedPolicy);
  catalog.catalog_version = '1.0.0';
  catalog.adapters = catalog.adapters.filter((adapter) => adapter.input_mode === 'source_media');
  delete catalog.adapters[0].input_mode;
  const normalizedCatalog = await loadMediaReviewAdapterCatalog(normalizedPolicy, { mediaReviewAdapterCatalog: catalog });
  assert.equal(normalizedCatalog.adapters[0].input_mode, 'source_media');

  const readiness = await inspectTranscriptProviderReadiness({
    mediaTranscriptProviderProfile: {
      ...providerProfile(), adapter_contract: 'caller-owned-local-asr-cli-v1'
    },
    verifyMediaTranscriptProviderTrust: async () => ({
      ...providerTrust(), adapterContract: 'caller-owned-local-asr-cli-v1'
    }),
    fixedProcessRunner: async () => success(JSON.stringify({
      status: 'ready', runtime: { runtimeReady: true }, model: { resolvableOffline: true },
      boundaries: {
        externalNetworkCallsDuringAsrEnabled: false,
        cloudAsrEnabled: false,
        externalSendingEnabled: false
      },
      bodyIncluded: false
    }))
  });
  assert.equal(readiness.status, 'ready');
  assert.equal(Object.hasOwn(readiness, 'input_contract'), false);
  assert.deepEqual(readiness.capabilities, [
    'local_file_transcription', 'timed_segments', 'offline_execution', 'caller_owned_artifacts'
  ]);
});

test('current media policy and adapter catalog fail closed when prepared contract fields are absent', async () => {
  for (const field of ['prepared_audio', 'decoded_timeline_probe_packets']) {
    const currentPolicy = await loadMediaReviewPolicy();
    if (field === 'prepared_audio') delete currentPolicy.prepared_audio;
    else delete currentPolicy.technical_analyzer.decoded_timeline_probe_packets;
    await assert.rejects(
      loadMediaReviewPolicy({ mediaReviewPolicy: currentPolicy }),
      (error) => ['MEDIA_REVIEW_POLICY_INVALID', 'MEDIA_REVIEW_POLICY_LIMIT_INVALID'].includes(error?.code)
    );
  }
  const policy = await loadMediaReviewPolicy();
  const currentCatalog = await loadMediaReviewAdapterCatalog(policy);
  delete currentCatalog.adapters[0].input_mode;
  await assert.rejects(loadMediaReviewAdapterCatalog(policy, {
    mediaReviewAdapterCatalog: currentCatalog
  }), { code: 'MEDIA_REVIEW_ADAPTER_CATALOG_INVALID' });
});

test('prepared provider readiness preserves setup-required without executing setup', async () => {
  const readiness = await inspectTranscriptProviderReadiness({
    mediaTranscriptProviderProfile: providerProfile(),
    verifyMediaTranscriptProviderTrust: async () => providerTrust(),
    fixedProcessRunner: async () => success(JSON.stringify(preparedReadiness('setup_required', 'local_asr_model_setup_required')))
  });
  assert.equal(readiness.status, 'setup_required');
  assert.deepEqual(readiness.capabilities, []);
  assert.equal(readiness.limitations.includes('local_asr_model_setup_required'), true);
  assert.equal(readiness.boundary.runtime_setup_performed, false);
  assert.equal(validateJsonSchemaSubset(readiness, getSchema('transcript_provider')).ok, true);
  const missingInputContract = structuredClone(readiness);
  delete missingInputContract.input_contract;
  assert.equal(validateJsonSchemaSubset(missingInputContract, getSchema('transcript_provider')).ok, false);
});

test('prepared provider uses fixed argv, resolves receipt-bound payload, and shifts cues to source time', async (t) => {
  const fixture = await preparedFixture(t, { rawBytes: Buffer.alloc(32_000, 5), operationId: '3'.repeat(32) });
  const calls = [];
  const providerRunner = fakePreparedProvider(fixture, calls);
  const context = {
    ephemeralMediaRoot: fixture.base,
    mediaTranscriptProviderProfile: providerProfile(),
    verifyMediaTranscriptProviderTrust: async () => providerTrust(),
    fixedProcessRunner: providerRunner
  };
  const result = await runTranscriptProvider({
    operation: fixture.operation,
    stagedMedia: { path: fixture.staged.path },
    mediaIdentity: fixture.staged,
    preparedAudio: fixture.prepared,
    retention: 'ephemeral'
  }, context);
  assert.equal(result.transient.segments.length, 1);
  assert.equal(result.transient.segments[0].start_us, 375_000);
  assert.equal(result.transient.segments[0].end_us, 875_000);
  assert.equal(result.transient.language, 'en');
  assert.equal(result.projection.status, 'available');
  assert.equal(result.projection.method.acquisition, 'local_cli_offline_prepared_audio');
  assert.equal(result.projection.method.prepared_audio_identity, fixture.prepared.audio.sha256);
  assert.equal(validateJsonSchemaSubset(result.projection, getSchema('transcript_provider')).ok, true);
  const missingPreparedIdentity = structuredClone(result.projection);
  delete missingPreparedIdentity.method.prepared_audio_identity;
  assert.equal(validateJsonSchemaSubset(missingPreparedIdentity, getSchema('transcript_provider')).ok, false);
  const nullPreparedIdentity = structuredClone(result.projection);
  nullPreparedIdentity.method.prepared_audio_identity = null;
  assert.equal(validateJsonSchemaSubset(nullPreparedIdentity, getSchema('transcript_provider')).ok, false);
  const missingPreparedProvenance = structuredClone(result.projection);
  delete missingPreparedProvenance.method.acquisition;
  for (const field of [
    'prepared_audio_contract', 'prepared_audio_identity', 'preparation_manifest_identity',
    'preparation_settings_identity', 'registration_identity', 'provider_receipt_identity',
    'computation_identity', 'sample_zero_source_time_us'
  ]) delete missingPreparedProvenance.method[field];
  assert.equal(validateJsonSchemaSubset(missingPreparedProvenance, getSchema('transcript_provider')).ok, false);
  assert.equal(JSON.stringify(result.projection).includes('Private prepared transcript.'), false);
  const providerArgv = calls.map((call) => call.args.slice(1));
  assert.equal(providerArgv.some((args) => args[0] === 'import-video'), false);
  assert.equal(providerArgv.some((args) => args.includes(fixture.staged.path)), false);
  assert.equal(providerArgv.some((args) => args[0] === 'audio' && args[1] === 'import-prepared'), true);
  assert.equal(providerArgv.some((args) => args.includes('--prepared-registration-id')), true);
  assert.equal(calls.every((call) => call.executable === '/trusted/node'), true);
  assert.equal((await cleanupPrivateMediaOperation(result.operation)).status, 'cleaned');
});

test('prepared provider rejects a receipt that is not bound to the captured result', async (t) => {
  const fixture = await preparedFixture(t, { rawBytes: Buffer.alloc(32_000, 7), operationId: '4'.repeat(32) });
  const context = {
    ephemeralMediaRoot: fixture.base,
    mediaTranscriptProviderProfile: providerProfile(),
    verifyMediaTranscriptProviderTrust: async () => providerTrust(),
    fixedProcessRunner: fakePreparedProvider(fixture, [], { tamperReceiptSource: true })
  };
  await assert.rejects(runTranscriptProvider({
    operation: fixture.operation,
    stagedMedia: { path: fixture.staged.path },
    mediaIdentity: fixture.staged,
    preparedAudio: fixture.prepared,
    retention: 'ephemeral'
  }, context), { code: 'MEDIA_PROVIDER_PREPARED_RECEIPT_BINDING_INVALID' });
  assert.equal((await cleanupPrivateMediaOperation(fixture.operation, { allowLive: true })).status, 'cleaned');
});

test('prepared provider clips a partially leading cue onto the video timeline with a limitation', async (t) => {
  const fixture = await preparedFixture(t, {
    rawBytes: Buffer.alloc(32_000, 9), operationId: '5'.repeat(32),
    decodedTimeline: {
      basis: 'first_decoded_frame_pts',
      video_first_timestamp_seconds: '0.500000',
      audio_first_timestamp_seconds: '0.000000'
    }
  });
  const result = await runTranscriptProvider({
    operation: fixture.operation,
    stagedMedia: { path: fixture.staged.path },
    mediaIdentity: fixture.staged,
    preparedAudio: fixture.prepared,
    retention: 'ephemeral'
  }, {
    ephemeralMediaRoot: fixture.base,
    mediaTranscriptProviderProfile: providerProfile(),
    verifyMediaTranscriptProviderTrust: async () => providerTrust(),
    fixedProcessRunner: fakePreparedProvider(fixture, [])
  });
  assert.equal(result.transient.segments[0].start_us, 0);
  assert.equal(result.transient.segments[0].end_us, 250_000);
  assert.equal(result.transient.limitations.includes('prepared_timeline_leading_cue_clipped_to_video_start'), true);
  assert.equal((await cleanupPrivateMediaOperation(result.operation)).status, 'cleaned');
});

test('prepared provider omits a cue wholly before the video timeline with a limitation', async (t) => {
  const fixture = await preparedFixture(t, {
    rawBytes: Buffer.alloc(32_000, 12), operationId: '8'.repeat(32),
    decodedTimeline: {
      basis: 'first_decoded_frame_pts',
      video_first_timestamp_seconds: '1.000000',
      audio_first_timestamp_seconds: '0.000000'
    }
  });
  const result = await runTranscriptProvider({
    operation: fixture.operation,
    stagedMedia: { path: fixture.staged.path },
    mediaIdentity: fixture.staged,
    preparedAudio: fixture.prepared,
    retention: 'ephemeral'
  }, {
    ephemeralMediaRoot: fixture.base,
    mediaTranscriptProviderProfile: providerProfile(),
    verifyMediaTranscriptProviderTrust: async () => providerTrust(),
    fixedProcessRunner: fakePreparedProvider(fixture, [])
  });
  assert.equal(result.transient.segments.length, 0);
  assert.equal(result.projection.status, 'insufficient');
  assert.equal(result.transient.limitations.includes('prepared_timeline_cue_before_video_start_omitted'), true);
  assert.equal((await cleanupPrivateMediaOperation(result.operation)).status, 'cleaned');
});

test('prepared provider omits a leading cue that ends exactly at video start', async (t) => {
  const fixture = await preparedFixture(t, {
    rawBytes: Buffer.alloc(32_000, 13), operationId: '9'.repeat(32),
    decodedTimeline: {
      basis: 'first_decoded_frame_pts',
      video_first_timestamp_seconds: '0.750000',
      audio_first_timestamp_seconds: '0.000000'
    }
  });
  const result = await runTranscriptProvider({
    operation: fixture.operation,
    stagedMedia: { path: fixture.staged.path },
    mediaIdentity: fixture.staged,
    preparedAudio: fixture.prepared,
    retention: 'ephemeral'
  }, {
    ephemeralMediaRoot: fixture.base,
    mediaTranscriptProviderProfile: providerProfile(),
    verifyMediaTranscriptProviderTrust: async () => providerTrust(),
    fixedProcessRunner: fakePreparedProvider(fixture, [])
  });
  assert.equal(result.transient.segments.length, 0);
  assert.equal(result.transient.limitations.includes('prepared_timeline_cue_before_video_start_omitted'), true);
  assert.equal((await cleanupPrivateMediaOperation(result.operation)).status, 'cleaned');
});

test('prepared provider rejects language and computation receipt drift', async (t) => {
  for (const [index, [label, mutation]] of [
    ['language', { tamperReceiptLanguage: true }],
    ['computation', { tamperComputationDigest: true }],
    ['computation receipt provenance', { tamperComputationReceiptBinding: true }]
  ].entries()) {
    const fixture = await preparedFixture(t, {
      rawBytes: Buffer.alloc(32_000, 10 + index), operationId: `${6 + index}`.repeat(32)
    });
    await assert.rejects(runTranscriptProvider({
      operation: fixture.operation,
      stagedMedia: { path: fixture.staged.path },
      mediaIdentity: fixture.staged,
      preparedAudio: fixture.prepared,
      retention: 'ephemeral'
    }, {
      ephemeralMediaRoot: fixture.base,
      mediaTranscriptProviderProfile: providerProfile(),
      verifyMediaTranscriptProviderTrust: async () => providerTrust(),
      fixedProcessRunner: fakePreparedProvider(fixture, [], mutation)
    }), { code: 'MEDIA_PROVIDER_PREPARED_RECEIPT_BINDING_INVALID' }, label);
    assert.equal((await cleanupPrivateMediaOperation(fixture.operation, { allowLive: true })).status, 'cleaned');
  }
});

test('prepared provider refuses linked private payload artifacts', async (t) => {
  for (const [index, mode] of ['hardlink', 'symlink'].entries()) {
    const fixture = await preparedFixture(t, {
      rawBytes: Buffer.alloc(32_000, 20 + index), operationId: `${index + 1}`.repeat(32)
    });
    const cleanupPaths = [];
    await assert.rejects(runTranscriptProvider({
      operation: fixture.operation,
      stagedMedia: { path: fixture.staged.path },
      mediaIdentity: fixture.staged,
      preparedAudio: fixture.prepared,
      retention: 'ephemeral'
    }, {
      ephemeralMediaRoot: fixture.base,
      mediaTranscriptProviderProfile: providerProfile(),
      verifyMediaTranscriptProviderTrust: async () => providerTrust(),
      fixedProcessRunner: fakePreparedProvider(fixture, [], {
        [`tamperPayload${mode === 'hardlink' ? 'Hardlink' : 'Symlink'}`]: true,
        cleanupPaths
      })
    }), (error) => error?.code?.startsWith('MEDIA_PROVIDER_PREPARED_PAYLOAD_'), mode);
    for (const target of cleanupPaths) await rm(target, { force: true });
    assert.equal((await cleanupPrivateMediaOperation(fixture.operation, { allowLive: true })).status, 'cleaned');
  }
});

async function preparedFixture(t, options = {}) {
  const base = await privateTemp(t, 'prepared-audio-');
  const operation = await createPrivateMediaOperation({
    operationId: options.operationId ?? '1'.repeat(32),
    retention: 'ephemeral'
  }, { ephemeralMediaRoot: base });
  await mkdir(path.join(operation.root, 'input'), { mode: 0o700 });
  const source = path.join(base, 'source.mp4');
  await writeFile(source, videoBytes(), { mode: 0o600 });
  const staged = await copyStableMediaFile(source, path.join(operation.root, 'input', 'source.mp4'), { maxBytes: 4096 });
  const adapter = await preparedAdapter();
  const processCalls = [];
  const prepared = await prepareLocalMediaAudio({
    operation,
    mediaPath: staged.path,
    mediaIdentity: staged,
    decodedTimeline: options.decodedTimeline ?? decodedTimeline(),
    contract: adapter.prepared_audio_contract
  }, {
    ephemeralMediaRoot: base,
    technicalMediaToolchain: toolchain(),
    preparedAudioProcessRunner: async (request) => {
      processCalls.push(request);
      await writeFile(request.args.at(-1), options.rawBytes, { mode: 0o600 });
      return success('');
    }
  });
  return { base, operation, staged, prepared, adapter, processCalls };
}

function fakePreparedProvider(fixture, calls, options = {}) {
  let registration;
  return async (request) => {
    calls.push(request);
    const args = request.args.slice(1);
    if (args[0] === 'local-asr' && args[1] === 'readiness') return success(JSON.stringify(preparedReadiness()));
    const root = option(args, '--external-artifact-root');
    if (args[0] === 'init') {
      const run = path.join(root, '20260719-000000-prepared-provider-test');
      await mkdir(run, { mode: 0o700 });
      return success(`${run}\n`);
    }
    const run = option(args, '--run');
    if (args[0] === 'audio' && args[1] === 'import-prepared') {
      registration = buildRegistration(fixture.prepared);
      return success(JSON.stringify(registration));
    }
    if (args[0] === 'local-asr' && args[1] === 'run') {
      const payload = `${JSON.stringify({
        schemaVersion: '1.0.0', id: 'local-asr-prepared-000001', sourceType: 'asr', sourceKind: 'local-asr',
        inputKind: 'prepared', sourceFile: 'audio/prepared/audio.wav', startSeconds: 0.25, endSeconds: 0.75,
        startTimestamp: '00:00:00.250', endTimestamp: '00:00:00.750', text: 'Private prepared transcript.',
        timed: true, needsReview: true
      })}\n`;
      const payloadDigest = sha256(Buffer.from(payload));
      const payloadRelative = `transcripts/asr/prepared-payloads/${payloadDigest}/payload.jsonl`;
      const payloadPath = path.join(run, ...payloadRelative.split('/'));
      await mkdir(path.dirname(payloadPath), { recursive: true, mode: 0o700 });
      await writeFile(payloadPath, payload, { mode: 0o600 });
      await chmod(payloadPath, 0o600);
      if (options.tamperPayloadHardlink) {
        const alias = `${payloadPath}.hardlink`;
        await link(payloadPath, alias);
        options.cleanupPaths?.push(alias);
      }
      if (options.tamperPayloadSymlink) {
        const target = `${payloadPath}.target`;
        await rename(payloadPath, target);
        await symlink(target, payloadPath);
        options.cleanupPaths?.push(payloadPath);
      }
      const language = options.tamperReceiptLanguage ? { requested: 'ja', detected: null } : { requested: 'en', detected: null };
      const engine = { id: 'faster-whisper', family: 'whisper', profileId: 'accurate-local', modelReferenceHash: 'a'.repeat(64), modelProvided: true };
      const computationBody = {
        schemaVersion: '1.0.0', inputSha256: fixture.prepared.audio.sha256,
        engineId: options.tamperComputationReceiptBinding ? 'different-engine' : engine.id,
        engineFamily: engine.family, profileId: engine.profileId,
        modelReferenceHash: engine.modelReferenceHash,
        requestedLanguage: language.requested, detectedLanguage: language.detected,
        executionIdentityDigest: null, runtimeIdentityDigest: null, modelIdentityDigest: null,
        reuseIdentityVerified: false, settingsIdentityDigest: 'b'.repeat(64),
        payloadSha256: payloadDigest, payloadByteSize: Buffer.byteLength(payload)
      };
      const computationDigest = options.tamperComputationDigest ? 'f'.repeat(64) : sha256(Buffer.from(stableJson(computationBody)));
      const receiptBody = {
        schemaVersion: '1.0.0', kind: 'framecue-transcript-provider-receipt',
        registrationId: registration.registrationId,
        preparationManifestDigest: registration.preparationManifestDigest,
        sourceMedia: options.tamperReceiptSource ? { ...registration.sourceMedia, digest: 'f'.repeat(64) } : registration.sourceMedia,
        preparedAudio: registration.preparedAudio,
        timeline: registration.timeline,
        language,
        producer: { name: 'frame-cue', version: '0.1.0' },
        preparationProducer: fixture.prepared.manifest.value.preparation.producer,
        preparationMethod: fixture.prepared.manifest.value.preparation.method,
        preparationSettingsDigest: fixture.prepared.preparation.settings_identity,
        adapter: { id: 'framecue-local-asr', version: '1.0.0' },
        engine,
        analysisConfigurationDigest: 'b'.repeat(64),
        computationIdentity: { ...computationBody, digest: computationDigest, bodyIncluded: false },
        payload: {
          id: `transcript-payload:${payloadDigest}`, relativePath: payloadRelative, sha256: payloadDigest,
          byteSize: Buffer.byteLength(payload), mediaType: 'application/x-ndjson',
          preparedAudioDigest: fixture.prepared.audio.sha256, bodyIncluded: false
        },
        terminal: { status: 'ready', reasonCodes: ['local_asr_completed'], cancellationRequested: false, timedOut: false, bodyIncluded: false },
        privacy: { transcriptBodyIncluded: false, absolutePathsIncluded: false, sourceMediaPathIncluded: false, sourceUrlIncluded: false },
        bodyIncluded: false
      };
      const operationId = sha256(Buffer.from(stableJson(receiptBody)));
      const receipt = { ...receiptBody, providerReceiptId: operationId };
      const receiptPath = path.join(run, 'transcripts', 'asr', 'prepared-provider-receipts', operationId, 'receipt.json');
      await mkdir(path.dirname(receiptPath), { recursive: true, mode: 0o700 });
      await writeFile(receiptPath, `${stableJson(receipt)}\n`, { mode: 0o600 });
      await chmod(receiptPath, 0o600);
      return success(JSON.stringify({
        schemaVersion: '1.0.0', kind: 'framecue-transcript-provider-result', contractVersion: '1.0.0',
        operationId, registrationId: registration.registrationId, status: 'ready', reasonCodes: ['local_asr_completed'],
        sourceMedia: registration.sourceMedia, preparedAudio: registration.preparedAudio, timeline: registration.timeline,
        language: { requested: 'en', detected: null }, producer: receiptBody.producer,
        preparationProducer: receiptBody.preparationProducer, adapter: receiptBody.adapter, engine: receiptBody.engine,
        method: receiptBody.preparationMethod, analysisConfigurationDigest: receiptBody.analysisConfigurationDigest,
        preparationManifestDigest: registration.preparationManifestDigest, computationIdentityDigest: computationDigest,
        payload: { id: receiptBody.payload.id, hashAlgorithm: 'sha256', digest: payloadDigest, byteSize: Buffer.byteLength(payload), mediaType: 'application/x-ndjson' },
        terminal: receiptBody.terminal, warnings: [], limitations: ['caller_owned_cleanup'], bodyIncluded: false, absolutePathsIncluded: false
      }));
    }
    throw new Error(`unexpected prepared provider command: ${args.join(' ')}`);
  };
}

function buildRegistration(prepared) {
  const manifest = prepared.manifest.value;
  const normalized = {
    ...manifest,
    sourceMedia: { ...manifest.sourceMedia, callerDeclared: true, derivationVerifiedByFrameCue: false }
  };
  const manifestDigest = sha256(Buffer.from(stableJson(normalized)));
  const registrationId = sha256(Buffer.from(stableJson({
    schemaVersion: '1.0.0',
    preparedAudioSha256: prepared.audio.sha256,
    preparationManifestDigest: manifestDigest
  })));
  return {
    schemaVersion: '1.0.0', kind: 'framecue-prepared-audio-registration-result', status: 'ready',
    reasonCodes: ['prepared_audio_registered'], registrationId, preparedAudioArtifactId: `prepared-audio:${registrationId}`,
    contractVersion: '1.0.0',
    preparedAudio: { ...manifest.preparedAudio, sampleCount: prepared.audio.sample_count, verifiedByFrameCue: true },
    sourceMedia: normalized.sourceMedia, timeline: prepared.timeline, preparationManifestDigest: manifestDigest,
    boundaries: { sourceMediaOpened: false, audioDecodedOrTransformed: false, ffmpegInvoked: false, networkInvoked: false, cleanupOwner: 'caller' },
    bodyIncluded: false, absolutePathsIncluded: false
  };
}

function preparedReadiness(status = 'ready', reason = 'prepared_audio_contract_ready') {
  return {
    schemaVersion: '1.0.0', kind: 'framecue-prepared-audio-readiness', contractVersion: '1.0.0',
    status, reasonCodes: [reason],
    capability: {
      inputKind: 'prepared', supported: true, externalArtifactRootSupported: true,
      sourceMediaReadRequired: false, sourceMediaReprocessingEnabled: false, ffmpegConversionRequired: false,
      urlAcquisitionEnabled: false, ytDlpEnabled: false, cloudAsrEnabled: false, externalSendEnabled: false,
      modelAutoDownloadEnabled: false, runtimeSetupExecutionEnabled: false, providerFallbackEnabled: false,
      shellExecutionEnabled: false,
      format: { container: 'wav', codec: 'pcm_s16le', sampleRateHz: 16000, channelCount: 1, bitsPerSample: 16, headerBytes: 44 }
    },
    selectedEngine: { id: 'faster-whisper', status, reasonCodes: [reason] },
    bodyIncluded: false, absolutePathsIncluded: false
  };
}

async function preparedAdapter() {
  const policy = await loadMediaReviewPolicy();
  return resolveMediaReviewAdapter(await loadMediaReviewAdapterCatalog(policy), 'caller-owned-prepared-audio-cli-v2');
}

function providerProfile() {
  return {
    schema_version: '1.0.0', adapter_contract: 'caller-owned-prepared-audio-cli-v2',
    runtime: {
      node_executable: '/trusted/node', node_sha256: '1'.repeat(64), entrypoint: '/trusted/provider.mjs',
      entrypoint_sha256: '2'.repeat(64), package_root: '/trusted/provider', git_executable: '/trusted/git',
      git_sha256: '3'.repeat(64), expected_revision: '4'.repeat(40), require_clean_tree: true
    },
    engine: 'faster-whisper', environment: {}
  };
}

function providerTrust() {
  return {
    adapterContract: 'caller-owned-prepared-audio-cli-v2', runtimeKind: 'node_git_checkout_cli',
    nodeExecutable: '/trusted/node', entrypoint: '/trusted/provider.mjs', packageRoot: '/trusted/provider',
    gitExecutable: '/trusted/git', revision: '4'.repeat(40), packageVersion: '0.1.0', engine: 'faster-whisper',
    env: { NO_COLOR: '1' }, identity: '5'.repeat(64)
  };
}

function toolchain() {
  return {
    probe: { path: '/trusted/ffprobe', sha256: '6'.repeat(64), version: 'fixture-1.0.0' },
    analyzer: { path: '/trusted/ffmpeg', sha256: '7'.repeat(64), version: 'fixture-1.0.0' }
  };
}

function decodedTimeline() {
  return {
    basis: 'first_decoded_frame_pts',
    video_first_timestamp_seconds: '0.000000',
    audio_first_timestamp_seconds: '0.125000'
  };
}

function success(stdout) {
  return { ok: true, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), shell_used: false };
}

function option(args, name) {
  return args[args.indexOf(name) + 1];
}

function videoBytes() {
  return Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(512, 1)]);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

async function privateTemp(t, prefix) {
  const parent = path.join(os.homedir(), '.local', 'state', 'trace-cue-media-review-tests');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(path.join(parent, prefix));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return root;
}
