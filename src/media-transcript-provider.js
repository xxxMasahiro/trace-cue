import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { runFixedProcess } from './fixed-process-runner.js';
import { readPrivateMediaOperation, updatePrivateMediaOperation } from './media-private-operation.js';
import { loadMediaReviewAdapterCatalog, loadMediaReviewPolicy, resolveMediaReviewAdapter } from './media-review-policy.js';
import { hashStableRegularFile, inspectStableMediaFile } from './media-stable-file.js';
import {
  loadMediaTranscriptProviderProfile,
  projectMediaTranscriptProviderTrust,
  verifyMediaTranscriptProviderTrust
} from './media-tool-trust.js';
import { readStableBoundedFileHandle } from './safe-local-store.js';
import { roundRationalHalfAwayFromZero } from './media-prepared-audio.js';

const TRANSCRIPT_SCHEMA_VERSION = '1.0.0';

export async function inspectTranscriptProviderReadiness(context = {}) {
  const policy = await loadMediaReviewPolicy(context);
  try {
    const profile = await (context.loadMediaTranscriptProviderProfile ?? loadMediaTranscriptProviderProfile)(context);
    const catalog = await loadMediaReviewAdapterCatalog(policy, context);
    const adapter = resolveMediaReviewAdapter(catalog, profile.adapter_contract);
    const trust = await (context.verifyMediaTranscriptProviderTrust ?? verifyMediaTranscriptProviderTrust)(profile, context);
    const execution = await runAdapterStage(adapter.commands.readiness, { engine: profile.engine }, trust, policy.transcript_provider.readiness_timeout_ms, policy.transcript_provider, context);
    const payload = parseJsonObject(execution, 'MEDIA_PROVIDER_READINESS_INVALID');
    const ready = validateReadinessPayload(payload, adapter);
    const status = ready
      ? 'ready'
      : adapter.input_mode === 'caller_prepared_audio' && ['setup_required', 'unavailable', 'unsupported'].includes(payload?.status)
        ? payload.status
        : 'setup_required';
    return {
      schema_version: TRANSCRIPT_SCHEMA_VERSION,
      type: 'transcript_provider_readiness',
      status,
      capabilities: adapter.input_mode === 'source_media' || ready ? [
        'local_file_transcription', 'timed_segments', 'offline_execution', 'caller_owned_artifacts',
        ...(adapter.input_mode === 'caller_prepared_audio' ? ['caller_prepared_audio'] : [])
      ] : [],
      ...(adapter.input_mode === 'caller_prepared_audio' ? { input_contract: projectAdapterInputContract(adapter) } : {}),
      method: projectMediaTranscriptProviderTrust(trust),
      limitations: ready ? [] : readinessLimitations(payload, adapter),
      boundary: transcriptBoundary(false)
    };
  } catch (error) {
    return {
      schema_version: TRANSCRIPT_SCHEMA_VERSION,
      type: 'transcript_provider_readiness',
      status: error?.code === 'MEDIA_REVIEW_ADAPTER_CONTRACT_UNAVAILABLE' ? 'unsupported' : 'unavailable',
      capabilities: [],
      limitations: [safeCode(error)],
      boundary: transcriptBoundary(false)
    };
  }
}

export async function runTranscriptProvider(request, context = {}) {
  validateRequest(request);
  const policy = await loadMediaReviewPolicy(context);
  request.operation = await readPrivateMediaOperation(request.operation, context);
  assertInside(request.operation.root, request.stagedMedia.path);
  const stagedIdentity = await inspectStableMediaFile(request.stagedMedia.path, {
    maxBytes: policy.source.maximum_local_media_bytes,
    requirePrivate: true,
    extension: path.extname(request.stagedMedia.path),
    signal: request.signal
  });
  if (stagedIdentity.sha256 !== request.mediaIdentity.sha256 || stagedIdentity.bytes !== request.mediaIdentity.bytes) {
    throw providerError('MEDIA_PROVIDER_STAGED_MEDIA_MISMATCH', 'The staged media does not match the accepted media identity.');
  }
  const profileLoader = context.loadMediaTranscriptProviderProfile ?? loadMediaTranscriptProviderProfile;
  const trustVerifier = context.verifyMediaTranscriptProviderTrust ?? verifyMediaTranscriptProviderTrust;
  const profile = await profileLoader(context);
  const catalog = await loadMediaReviewAdapterCatalog(policy, context);
  const adapter = resolveMediaReviewAdapter(catalog, profile.adapter_contract);
  if (adapter.input_mode === 'caller_prepared_audio') validatePreparedAudioRequest(request.preparedAudio, adapter, request.operation);
  let trust = await trustVerifier(profile, context);
  const readinessExecution = await runAdapterStage(adapter.commands.readiness, { engine: profile.engine }, trust, policy.transcript_provider.readiness_timeout_ms, policy.transcript_provider, context, request.signal);
  const readinessPayload = parseJsonObject(readinessExecution, 'MEDIA_PROVIDER_READINESS_INVALID');
  if (!validateReadinessPayload(readinessPayload, adapter)) {
    throw providerError('MEDIA_PROVIDER_SETUP_REQUIRED', 'The local transcript provider is not ready.');
  }

  const operationName = `media-review-${request.operation.operationId.slice(0, 12)}`;
  trust = await trustVerifier(profile, context);
  const initialized = await runAdapterStage(adapter.commands.initialize, {
    operation_name: operationName,
    operation_root: request.operation.root
  }, trust, policy.transcript_provider.stage_timeout_ms, policy.transcript_provider, context, request.signal);
  const providerRun = initialized.stdout.toString('utf8').trim();
  const providerRunRelative = validateProviderRun(providerRun, request.operation.root);
  request.operation = await updatePrivateMediaOperation(request.operation, {
    state: 'running',
    providerRunRelative
  }, context);

  const adapterResult = adapter.input_mode === 'caller_prepared_audio'
    ? await runPreparedAudioAdapter({ request, profile, adapter, policy, providerRun, trustVerifier, context })
    : await runSourceMediaAdapter({ request, profile, adapter, policy, providerRun, trustVerifier, context });
  trust = adapterResult.trust;
  const parsed = adapterResult.parsed;
  const manifest = adapterResult.manifest;
  const engineConfiguration = adapterResult.engineConfiguration;
  const method = {
    ...projectMediaTranscriptProviderTrust(trust),
    engine: adapterResult.engineId,
    ...engineConfiguration,
    provider_result_schema_version: manifest.schemaVersion,
    normalized_contract: TRANSCRIPT_SCHEMA_VERSION,
    acquisition: adapter.input_mode === 'caller_prepared_audio' ? 'local_cli_offline_prepared_audio' : 'local_cli_offline',
    ...(adapterResult.preparedProvenance ?? {})
  };
  const transient = {
    schema_version: TRANSCRIPT_SCHEMA_VERSION,
    type: 'transcript_provider_transient_result',
    operation_id: request.operation.operationId,
    media_identity: publicMediaIdentity(request.mediaIdentity),
    retention: request.retention,
    language: parsed.language,
    segments: parsed.segments,
    method,
    limitations: [
      ...parsed.limitations,
      ...adapterResult.limitations,
      'provider_model_reference_identity_is_not_a_model_weight_hash',
      'provider_external_runtime_dependencies_are_not_cryptographically_bound'
    ],
    privacy: {
      transient_body_in_memory: true,
      private_payload_retained: request.retention === 'project-retained',
      public_body_included: false,
      external_send_performed: false
    }
  };
  const projection = projectTranscriptProviderResult(transient, parsed.payloadSha256);
  return { transient, projection, operation: request.operation };
}

async function runSourceMediaAdapter({ request, profile, adapter, policy, providerRun, trustVerifier, context }) {
  let trust = await trustVerifier(profile, context);
  const imported = await runAdapterStage(adapter.commands.import_media, {
    run: providerRun,
    input: request.stagedMedia.path,
    operation_root: request.operation.root
  }, trust, policy.transcript_provider.stage_timeout_ms, policy.transcript_provider, context, request.signal);
  const importedPath = imported.stdout.toString('utf8').trim();
  validateContainedRegularFile(importedPath, providerRun);
  const importedIdentity = await inspectStableMediaFile(importedPath, {
    maxBytes: policy.source.maximum_local_media_bytes,
    requirePrivate: true,
    extension: path.extname(importedPath)
  });
  if (importedIdentity.sha256 !== request.mediaIdentity.sha256 || importedIdentity.bytes !== request.mediaIdentity.bytes) {
    throw providerError('MEDIA_PROVIDER_IMPORTED_MEDIA_MISMATCH', 'The provider imported a different media body.');
  }
  trust = await trustVerifier(profile, context);
  const transcribed = await runAdapterStage(adapter.commands.transcribe, {
    run: providerRun,
    engine: profile.engine,
    operation_root: request.operation.root
  }, trust, policy.transcript_provider.execution_timeout_ms, policy.transcript_provider, context, request.signal);
  const manifest = parseJsonObject(transcribed, 'MEDIA_PROVIDER_RESULT_INVALID');
  validateManifest(manifest, profile.engine, adapter);
  const normalizedRelative = validateRelativePath(manifest.normalizedOutput.relativePath);
  const transcriptPath = path.resolve(providerRun, normalizedRelative);
  assertInside(providerRun, transcriptPath);
  return {
    trust,
    manifest,
    parsed: await readNormalizedTranscript(transcriptPath, policy, adapter),
    engineId: manifest.engine.id,
    engineConfiguration: projectEngineConfiguration(manifest.engine),
    limitations: [],
    preparedProvenance: null
  };
}

async function runPreparedAudioAdapter({ request, profile, adapter, policy, providerRun, trustVerifier, context }) {
  await verifyPreparedAudioCallerFiles(request.preparedAudio, request.operation.root, policy, request.signal);
  let trust = await trustVerifier(profile, context);
  const registeredExecution = await runAdapterStage(adapter.commands.register_prepared, {
    run: providerRun,
    prepared_audio: request.preparedAudio.audio.path,
    preparation_manifest: request.preparedAudio.manifest.path,
    operation_root: request.operation.root
  }, trust, policy.transcript_provider.stage_timeout_ms, policy.transcript_provider, context, request.signal);
  const registration = parseJsonObject(registeredExecution, 'MEDIA_PROVIDER_PREPARED_REGISTRATION_INVALID');
  const registrationBinding = validatePreparedRegistration(registration, request.preparedAudio, request.mediaIdentity, adapter);
  await verifyPreparedAudioCallerFiles(request.preparedAudio, request.operation.root, policy, request.signal);
  trust = await trustVerifier(profile, context);
  const transcribed = await runAdapterStage(adapter.commands.transcribe, {
    run: providerRun,
    registration_id: registrationBinding.registrationId,
    engine: profile.engine,
    operation_root: request.operation.root
  }, trust, policy.transcript_provider.execution_timeout_ms, policy.transcript_provider, context, request.signal);
  const manifest = parseJsonObject(transcribed, 'MEDIA_PROVIDER_RESULT_INVALID');
  validatePreparedProviderResult(manifest, registration, request.preparedAudio, request.mediaIdentity, profile.engine, adapter, policy);
  const resolved = await resolvePreparedTranscriptPayload(providerRun, manifest, registration, request.preparedAudio, adapter, policy);
  const projectedLanguage = manifest.language?.detected ?? manifest.language?.requested ?? null;
  const parsed = parseNormalizedTranscriptBody(resolved.body, policy, adapter, {
    timelineOriginUs: request.preparedAudio.timeline.sampleZeroSourceTimeMicroseconds,
    language: projectedLanguage,
    negativeTimelinePolicy: 'clip_or_omit'
  });
  if (parsed.payloadSha256 !== manifest.payload.digest) {
    throw providerError('MEDIA_PROVIDER_PAYLOAD_DIGEST_MISMATCH', 'The prepared transcript payload identity changed during normalization.');
  }
  return {
    trust,
    manifest,
    parsed,
    engineId: manifest.engine.id,
    engineConfiguration: {
      model_reference: null,
      model_reference_identity: /^[a-f0-9]{64}$/u.test(manifest.engine?.modelReferenceHash ?? '') ? manifest.engine.modelReferenceHash : null,
      execution_profile: safeToken(manifest.engine?.profileId, 80),
      device: null,
      compute_type: null,
      vad: null,
      beam_size: null,
      threads: null
    },
    limitations: safeCodeArray(manifest.limitations),
    preparedProvenance: {
      prepared_audio_contract: adapter.prepared_audio_contract.schema_version,
      prepared_audio_identity: request.preparedAudio.audio.sha256,
      preparation_manifest_identity: registrationBinding.manifestDigest,
      preparation_settings_identity: request.preparedAudio.preparation.settings_identity,
      registration_identity: registrationBinding.registrationId,
      provider_receipt_identity: manifest.operationId,
      computation_identity: /^[a-f0-9]{64}$/u.test(manifest.computationIdentityDigest ?? '') ? manifest.computationIdentityDigest : null,
      sample_zero_source_time_us: request.preparedAudio.timeline.sampleZeroSourceTimeMicroseconds
    }
  };
}

export function projectTranscriptProviderResult(transient, transcriptIdentity = null) {
  const timedCount = transient.segments.filter((segment) => segment.timed).length;
  return {
    schema_version: TRANSCRIPT_SCHEMA_VERSION,
    type: 'transcript_provider_projection',
    status: timedCount > 0 ? 'available' : 'insufficient',
    media_identity: transient.media_identity,
    language: transient.language,
    segment_count: transient.segments.length,
    timed_segment_count: timedCount,
    transcript_identity: transcriptIdentity,
    method: transient.method,
    limitations: transient.limitations,
    boundary: transcriptBoundary(false)
  };
}

async function runAdapterStage(template, substitutions, trust, timeoutMs, limits, context, signal = null) {
  const args = template.map((value) => substituteArg(value, substitutions));
  const runner = context.fixedProcessRunner ?? runFixedProcess;
  const result = await runner({
    executable: trust.nodeExecutable,
    args: [trust.entrypoint, ...args],
    cwd: trust.packageRoot,
    env: trust.env,
    timeoutMs,
    maxStdoutBytes: limits.maximum_stdout_bytes,
    maxStderrBytes: limits.maximum_stderr_bytes,
    containDescendants: true,
    signal
  });
  if (!result?.ok) {
    if (result?.error?.code === 'FIXED_PROCESS_CONTAINMENT_UNCONFIRMED') {
      throw providerError(
        'MEDIA_PROVIDER_CONTAINMENT_UNCONFIRMED',
        'The local transcript provider stopped without confirmed descendant containment.',
        result.error.code
      );
    }
    throw providerError('MEDIA_PROVIDER_STAGE_FAILED', 'The local transcript provider stage failed.', result?.error?.code);
  }
  return result;
}

function substituteArg(value, substitutions) {
  return value.replace(/\{([a-z_]+)\}/gu, (match, key) => {
    const replacement = substitutions[key];
    if (typeof replacement !== 'string' || replacement.length === 0 || replacement.includes('\u0000')) {
      throw providerError('MEDIA_PROVIDER_ARGUMENT_INVALID', 'A local transcript provider argument is unavailable.');
    }
    return replacement;
  });
}

function validateReadinessPayload(payload, adapter) {
  const required = adapter.required_readiness;
  if (adapter.input_mode === 'source_media') {
    return payload?.status === required.status
      && payload?.runtime?.runtimeReady === required.runtime_ready
      && payload?.model?.resolvableOffline === required.model_resolvable_offline
      && payload?.boundaries?.externalNetworkCallsDuringAsrEnabled === required.external_network_calls_during_asr_enabled
      && payload?.boundaries?.cloudAsrEnabled === required.cloud_asr_enabled
      && payload?.boundaries?.externalSendingEnabled === required.external_sending_enabled
      && payload?.bodyIncluded === false;
  }
  const capability = payload?.capability;
  const format = capability?.format;
  const selected = payload?.selectedEngine;
  return payload?.schemaVersion === adapter.prepared_audio_contract.schema_version
    && payload?.kind === required.kind
    && payload?.contractVersion === adapter.prepared_audio_contract.schema_version
    && payload?.status === required.status
    && payload?.bodyIncluded === required.body_included
    && payload?.absolutePathsIncluded === required.absolute_paths_included
    && selected?.status === 'ready'
    && capability?.inputKind === required.input_kind
    && capability?.supported === required.capability_supported
    && capability?.externalArtifactRootSupported === required.external_artifact_root_supported
    && capability?.sourceMediaReadRequired === required.source_media_read_required
    && capability?.sourceMediaReprocessingEnabled === required.source_media_reprocessing_enabled
    && capability?.ffmpegConversionRequired === required.ffmpeg_conversion_required
    && capability?.urlAcquisitionEnabled === required.url_acquisition_enabled
    && capability?.ytDlpEnabled === required.yt_dlp_enabled
    && capability?.cloudAsrEnabled === required.cloud_asr_enabled
    && capability?.externalSendEnabled === required.external_sending_enabled
    && capability?.modelAutoDownloadEnabled === required.model_auto_download_enabled
    && capability?.runtimeSetupExecutionEnabled === required.runtime_setup_execution_enabled
    && capability?.providerFallbackEnabled === required.provider_fallback_enabled
    && capability?.shellExecutionEnabled === required.shell_execution_enabled
    && format?.container === adapter.prepared_audio_contract.format.container
    && format?.codec === adapter.prepared_audio_contract.format.codec
    && format?.sampleRateHz === adapter.prepared_audio_contract.format.sample_rate_hz
    && format?.channelCount === adapter.prepared_audio_contract.format.channel_count
    && format?.bitsPerSample === adapter.prepared_audio_contract.format.bits_per_sample
    && format?.headerBytes === adapter.prepared_audio_contract.format.header_bytes;
}

function readinessLimitations(payload, adapter) {
  if (adapter.input_mode === 'caller_prepared_audio') {
    const reasons = safeCodeArray(payload?.reasonCodes);
    return reasons.length ? reasons : ['prepared_provider_readiness_contract_not_satisfied'];
  }
  const values = [];
  if (payload?.runtime?.runtimeReady !== true) values.push('runtime_not_ready');
  if (payload?.model?.resolvableOffline !== true) values.push('model_not_resolvable_offline');
  if (payload?.boundaries?.externalNetworkCallsDuringAsrEnabled !== false) values.push('offline_boundary_not_confirmed');
  return values.length ? values : ['provider_readiness_contract_not_satisfied'];
}

function projectAdapterInputContract(adapter) {
  if (adapter.input_mode === 'source_media') {
    return { adapter_contract: adapter.adapter_contract, mode: 'source_media' };
  }
  return {
    adapter_contract: adapter.adapter_contract,
    mode: 'caller_prepared_audio',
    prepared_audio_contract: structuredClone(adapter.prepared_audio_contract)
  };
}

function validateManifest(manifest, engine, adapter) {
  const major = Number(String(manifest?.schemaVersion ?? '').split('.')[0]);
  if (!adapter.supported_result_schema_majors.includes(major)
    || manifest?.status !== 'ready'
    || manifest?.engine?.id !== engine
    || manifest?.engine?.networkAllowed !== false
    || manifest?.engine?.bodyIncluded !== false
    || adapter.production_mock_engines.includes(manifest?.engine?.id)
    || /mock/iu.test(manifest?.engine?.id ?? '')
    || manifest?.normalizedOutput?.bodyIncluded !== false
    || typeof manifest?.normalizedOutput?.relativePath !== 'string') {
    throw providerError('MEDIA_PROVIDER_RESULT_INVALID', 'The local transcript provider result contract is invalid.');
  }
}

function projectEngineConfiguration(engine) {
  const model = engine?.model;
  const reference = model?.referenceStored === true
    && typeof model.reference === 'string'
    && /^[A-Za-z0-9._:+@/-]{1,120}$/u.test(model.reference)
    && !model.reference.startsWith('/')
    ? model.reference
    : null;
  return {
    model_reference: reference,
    model_reference_identity: /^[a-f0-9]{64}$/u.test(model?.referenceHash ?? '') ? model.referenceHash : null,
    execution_profile: typeof engine?.selectedProfile?.id === 'string' && /^[a-z0-9-]{1,80}$/u.test(engine.selectedProfile.id)
      ? engine.selectedProfile.id
      : null,
    device: typeof engine?.device === 'string' && /^[A-Za-z0-9._-]{1,40}$/u.test(engine.device) ? engine.device : null,
    compute_type: typeof engine?.computeType === 'string' && /^[A-Za-z0-9._-]{1,40}$/u.test(engine.computeType) ? engine.computeType : null,
    vad: typeof engine?.vad === 'boolean' ? engine.vad : null,
    beam_size: Number.isSafeInteger(engine?.beamSize) ? engine.beamSize : null,
    threads: Number.isSafeInteger(engine?.threads) ? engine.threads : null
  };
}

function validatePreparedAudioRequest(prepared, adapter, operation) {
  if (prepared?.type !== 'media_prepared_audio'
    || prepared?.schema_version !== TRANSCRIPT_SCHEMA_VERSION
    || prepared?.contract?.schema_version !== adapter.prepared_audio_contract.schema_version
    || prepared?.contract?.manifest_kind !== adapter.prepared_audio_contract.manifest_kind
    || stableJson(prepared.contract.format) !== stableJson(adapter.prepared_audio_contract.format)
    || prepared?.contract?.rounding_rule !== adapter.prepared_audio_contract.rounding_rule
    || !path.isAbsolute(prepared?.audio?.path ?? '')
    || !path.isAbsolute(prepared?.manifest?.path ?? '')
    || !/^[a-f0-9]{64}$/u.test(prepared?.audio?.sha256 ?? '')
    || !/^[a-f0-9]{64}$/u.test(prepared?.manifest?.sha256 ?? '')
    || !Number.isSafeInteger(prepared?.audio?.bytes)
    || !Number.isSafeInteger(prepared?.audio?.sample_count)
    || !Number.isSafeInteger(prepared?.manifest?.bytes)
    || !/^[a-f0-9]{64}$/u.test(prepared?.preparation?.settings_identity ?? '')) {
    throw providerError('MEDIA_PROVIDER_PREPARED_AUDIO_INVALID', 'The prepared audio input is invalid.');
  }
  assertInside(operation.root, prepared.audio.path);
  assertInside(operation.root, prepared.manifest.path);
}

async function verifyPreparedAudioCallerFiles(prepared, operationRoot, policy, signal) {
  assertInside(operationRoot, prepared.audio.path);
  const audio = await hashStableRegularFile(prepared.audio.path, {
    maxBytes: policy.prepared_audio.maximum_prepared_audio_bytes,
    requireOwner: true,
    requirePrivate: true,
    signal
  });
  if (audio.bytes !== prepared.audio.bytes || audio.sha256 !== prepared.audio.sha256) {
    throw providerError('MEDIA_PROVIDER_PREPARED_AUDIO_CHANGED', 'The prepared audio changed before provider registration.');
  }
  const manifest = await readPrivateProviderFile(prepared.manifest.path, operationRoot, {
    maximumBytes: policy.prepared_audio.maximum_manifest_bytes,
    expectedBytes: prepared.manifest.bytes,
    expectedSha256: prepared.manifest.sha256,
    code: 'MEDIA_PROVIDER_PREPARATION_MANIFEST'
  });
  let parsed;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifest.body)); } catch {
    throw providerError('MEDIA_PROVIDER_PREPARATION_MANIFEST_INVALID', 'The preparation manifest is invalid.');
  }
  if (stableJson(parsed) !== stableJson(prepared.manifest.value)) {
    throw providerError('MEDIA_PROVIDER_PREPARATION_MANIFEST_CHANGED', 'The preparation manifest changed before provider registration.');
  }
}

function validatePreparedRegistration(registration, prepared, mediaIdentity, adapter) {
  const normalizedManifest = normalizePreparedManifestForProvider(prepared.manifest.value);
  const manifestDigest = sha256Stable(normalizedManifest);
  const registrationId = sha256Stable({
    schemaVersion: adapter.prepared_audio_contract.schema_version,
    preparedAudioSha256: prepared.audio.sha256,
    preparationManifestDigest: manifestDigest
  });
  const sourceMedia = normalizedManifest.sourceMedia;
  const expectedPrepared = {
    hashAlgorithm: 'sha256',
    digest: prepared.audio.sha256,
    byteSize: prepared.audio.bytes,
    sampleCount: prepared.audio.sample_count,
    format: normalizedManifest.preparedAudio.format,
    verifiedByFrameCue: true
  };
  if (!hasExactKeys(registration, [
    'schemaVersion', 'kind', 'status', 'reasonCodes', 'registrationId', 'preparedAudioArtifactId',
    'contractVersion', 'preparedAudio', 'sourceMedia', 'timeline', 'preparationManifestDigest',
    'boundaries', 'bodyIncluded', 'absolutePathsIncluded'
  ])
    || registration?.schemaVersion !== adapter.prepared_audio_contract.schema_version
    || registration?.kind !== adapter.prepared_audio_contract.registration_result_kind
    || registration?.contractVersion !== adapter.prepared_audio_contract.schema_version
    || registration?.status !== 'ready'
    || registration?.bodyIncluded !== false
    || registration?.absolutePathsIncluded !== false
    || registration?.registrationId !== registrationId
    || registration?.preparedAudioArtifactId !== `prepared-audio:${registrationId}`
    || registration?.preparationManifestDigest !== manifestDigest
    || sourceMedia.digest !== mediaIdentity.sha256
    || sourceMedia.byteSize !== mediaIdentity.bytes
    || stableJson(registration?.sourceMedia) !== stableJson(sourceMedia)
    || stableJson(registration?.preparedAudio) !== stableJson(expectedPrepared)
    || stableJson(registration?.timeline) !== stableJson(prepared.timeline)
    || registration?.boundaries?.sourceMediaOpened !== false
    || registration?.boundaries?.audioDecodedOrTransformed !== false
    || registration?.boundaries?.ffmpegInvoked !== false
    || registration?.boundaries?.networkInvoked !== false
    || registration?.boundaries?.cleanupOwner !== 'caller') {
    throw providerError('MEDIA_PROVIDER_PREPARED_REGISTRATION_INVALID', 'The provider prepared-audio registration is not bound to the accepted input.');
  }
  return { registrationId, manifestDigest, sourceMedia, preparedAudio: expectedPrepared };
}

function validatePreparedProviderResult(result, registration, prepared, mediaIdentity, configuredEngine, adapter, policy) {
  const major = Number(String(result?.schemaVersion ?? '').split('.')[0]);
  const explicitEngineMismatch = configuredEngine !== 'auto' && result?.engine?.id !== configuredEngine;
  if (!hasExactKeys(result, [
    'schemaVersion', 'kind', 'contractVersion', 'operationId', 'registrationId', 'status', 'reasonCodes',
    'sourceMedia', 'preparedAudio', 'timeline', 'language', 'producer', 'preparationProducer', 'adapter',
    'engine', 'method', 'analysisConfigurationDigest', 'preparationManifestDigest',
    'computationIdentityDigest', 'payload', 'terminal', 'warnings', 'limitations', 'bodyIncluded',
    'absolutePathsIncluded'
  ])
    || !hasExactKeys(result?.language, ['requested', 'detected'])
    || !hasExactKeys(result?.payload, ['id', 'hashAlgorithm', 'digest', 'byteSize', 'mediaType'])
    || !hasExactKeys(result?.terminal, ['status', 'reasonCodes', 'cancellationRequested', 'timedOut', 'bodyIncluded'])
    || !validPreparedLanguage(result?.language?.requested)
    || !validPreparedLanguage(result?.language?.detected)
    || result?.payload?.hashAlgorithm !== 'sha256'
    || !adapter.supported_result_schema_majors.includes(major)
    || result?.kind !== adapter.prepared_audio_contract.provider_result_kind
    || result?.contractVersion !== adapter.prepared_audio_contract.schema_version
    || result?.status !== 'ready'
    || result?.terminal?.status !== 'ready'
    || result?.terminal?.bodyIncluded !== false
    || result?.registrationId !== registration.registrationId
    || result?.preparationManifestDigest !== registration.preparationManifestDigest
    || result?.sourceMedia?.digest !== mediaIdentity.sha256
    || result?.sourceMedia?.byteSize !== mediaIdentity.bytes
    || stableJson(result?.sourceMedia) !== stableJson(registration.sourceMedia)
    || result?.preparedAudio?.digest !== prepared.audio.sha256
    || result?.preparedAudio?.byteSize !== prepared.audio.bytes
    || stableJson(result?.preparedAudio) !== stableJson(registration.preparedAudio)
    || stableJson(result?.timeline) !== stableJson(prepared.timeline)
    || explicitEngineMismatch
    || adapter.production_mock_engines.includes(result?.engine?.id)
    || /mock/iu.test(result?.engine?.id ?? '')
    || !/^[a-f0-9]{64}$/u.test(result?.operationId ?? '')
    || !/^[a-f0-9]{64}$/u.test(result?.payload?.digest ?? '')
    || result?.payload?.id !== `${adapter.result_resolution.payload_namespace}:${result.payload.digest}`
    || !Number.isSafeInteger(result?.payload?.byteSize)
    || result.payload.byteSize <= 0
    || result.payload.byteSize > policy.transcript_provider.maximum_transcript_bytes
    || result?.payload?.mediaType !== adapter.result_resolution.payload_media_type
    || result?.bodyIncluded !== false
    || result?.absolutePathsIncluded !== false) {
    throw providerError('MEDIA_PROVIDER_RESULT_INVALID', 'The prepared transcript provider result contract is invalid.');
  }
}

async function resolvePreparedTranscriptPayload(providerRun, result, registration, prepared, adapter, policy) {
  const resolution = adapter.result_resolution;
  const receiptPath = path.resolve(
    providerRun,
    resolution.provider_receipt_directory,
    result.operationId,
    resolution.provider_receipt_file_name
  );
  assertInside(providerRun, receiptPath);
  const receiptFile = await readPrivateProviderFile(receiptPath, providerRun, {
    maximumBytes: policy.prepared_audio.maximum_manifest_bytes,
    code: 'MEDIA_PROVIDER_PREPARED_RECEIPT'
  });
  let receipt;
  try { receipt = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(receiptFile.body)); } catch {
    throw providerError('MEDIA_PROVIDER_PREPARED_RECEIPT_INVALID', 'The prepared transcript receipt is invalid.');
  }
  const { providerReceiptId, ...receiptBody } = receipt ?? {};
  const expectedPayloadRelative = path.posix.join(
    resolution.payload_directory,
    result.payload.digest,
    resolution.payload_file_name
  );
  const registrationSource = registration.sourceMedia;
  const computation = receipt?.computationIdentity;
  const computationBody = hasExactKeys(computation, [
    'schemaVersion', 'inputSha256', 'engineId', 'engineFamily', 'profileId', 'modelReferenceHash',
    'requestedLanguage', 'detectedLanguage', 'executionIdentityDigest', 'runtimeIdentityDigest',
    'modelIdentityDigest', 'reuseIdentityVerified', 'settingsIdentityDigest', 'payloadSha256',
    'payloadByteSize', 'digest', 'bodyIncluded'
  ]) ? Object.fromEntries(Object.entries(computation).filter(([key]) => !['digest', 'bodyIncluded'].includes(key))) : null;
  if (!hasExactKeys(receipt, [
    'schemaVersion', 'kind', 'registrationId', 'preparationManifestDigest', 'sourceMedia', 'preparedAudio',
    'timeline', 'language', 'producer', 'preparationProducer', 'preparationMethod',
    'preparationSettingsDigest', 'adapter', 'engine', 'analysisConfigurationDigest',
    'computationIdentity', 'payload', 'terminal', 'privacy', 'bodyIncluded', 'providerReceiptId'
  ])
    || !hasExactKeys(receipt?.language, ['requested', 'detected'])
    || !hasExactKeys(receipt?.payload, ['id', 'relativePath', 'sha256', 'byteSize', 'mediaType', 'preparedAudioDigest', 'bodyIncluded'])
    || !hasExactKeys(receipt?.terminal, ['status', 'reasonCodes', 'cancellationRequested', 'timedOut', 'bodyIncluded'])
    || !hasExactKeys(receipt?.privacy, ['transcriptBodyIncluded', 'absolutePathsIncluded', 'sourceMediaPathIncluded', 'sourceUrlIncluded'])
    || computationBody === null
    || receipt?.schemaVersion !== resolution.contract_version
    || receipt?.kind !== resolution.provider_receipt_kind
    || providerReceiptId !== result.operationId
    || sha256Stable(receiptBody) !== result.operationId
    || receipt?.registrationId !== result.registrationId
    || receipt?.preparationManifestDigest !== result.preparationManifestDigest
    || stableJson(receipt?.sourceMedia) !== stableJson(registrationSource)
    || stableJson(receipt?.preparedAudio) !== stableJson(registration.preparedAudio)
    || stableJson(receipt?.timeline) !== stableJson(prepared.timeline)
    || stableJson(receipt?.language) !== stableJson(result.language)
    || stableJson(receipt?.producer) !== stableJson(result.producer)
    || stableJson(receipt?.preparationProducer) !== stableJson(result.preparationProducer)
    || receipt?.preparationMethod !== result.method
    || receipt?.preparationMethod !== prepared.manifest.value.preparation.method
    || stableJson(receipt?.preparationProducer) !== stableJson(prepared.manifest.value.preparation.producer)
    || receipt?.preparationSettingsDigest !== prepared.preparation.settings_identity
    || stableJson(receipt?.adapter) !== stableJson(result.adapter)
    || stableJson(receipt?.engine) !== stableJson(result.engine)
    || receipt?.analysisConfigurationDigest !== result.analysisConfigurationDigest
    || computation?.digest !== result.computationIdentityDigest
    || computation?.bodyIncluded !== false
    || sha256Stable(computationBody) !== computation?.digest
    || computation?.schemaVersion !== receipt?.adapter?.version
    || computation?.inputSha256 !== prepared.audio.sha256
    || computation?.engineId !== receipt?.engine?.id
    || computation?.engineFamily !== receipt?.engine?.family
    || computation?.profileId !== receipt?.engine?.profileId
    || computation?.modelReferenceHash !== receipt?.engine?.modelReferenceHash
    || computation?.settingsIdentityDigest !== receipt?.analysisConfigurationDigest
    || computation?.requestedLanguage !== receipt?.language?.requested
    || computation?.detectedLanguage !== receipt?.language?.detected
    || computation?.payloadSha256 !== result.payload.digest
    || computation?.payloadByteSize !== result.payload.byteSize
    || !validPreparedLanguage(receipt?.language?.requested)
    || !validPreparedLanguage(receipt?.language?.detected)
    || receipt?.terminal?.status !== 'ready'
    || stableJson(receipt?.terminal) !== stableJson(result.terminal)
    || receipt?.terminal?.bodyIncluded !== false
    || receipt?.payload?.id !== result.payload.id
    || receipt?.payload?.relativePath !== expectedPayloadRelative
    || receipt?.payload?.sha256 !== result.payload.digest
    || receipt?.payload?.byteSize !== result.payload.byteSize
    || receipt?.payload?.mediaType !== resolution.payload_media_type
    || receipt?.payload?.preparedAudioDigest !== prepared.audio.sha256
    || receipt?.payload?.bodyIncluded !== false
    || receipt?.bodyIncluded !== false
    || receipt?.privacy?.transcriptBodyIncluded !== false
    || receipt?.privacy?.absolutePathsIncluded !== false
    || receipt?.privacy?.sourceMediaPathIncluded !== false
    || receipt?.privacy?.sourceUrlIncluded !== false) {
    throw providerError('MEDIA_PROVIDER_PREPARED_RECEIPT_BINDING_INVALID', 'The prepared transcript receipt is not bound to the provider result.');
  }
  const payloadPath = path.resolve(providerRun, ...expectedPayloadRelative.split('/'));
  assertInside(providerRun, payloadPath);
  return readPrivateProviderFile(payloadPath, providerRun, {
    maximumBytes: policy.transcript_provider.maximum_transcript_bytes,
    expectedBytes: result.payload.byteSize,
    expectedSha256: result.payload.digest,
    code: 'MEDIA_PROVIDER_PREPARED_PAYLOAD'
  });
}

async function readPrivateProviderFile(target, root, options) {
  assertInside(root, target);
  const canonical = await realpath(target).catch(() => null);
  if (canonical !== target) throw providerError(`${options.code}_REALPATH_INVALID`, 'A private provider artifact path is not stable.');
  const info = await lstat(target, { bigint: true }).catch(() => null);
  if (!info?.isFile()
    || info.isSymbolicLink()
    || info.nlink !== 1n
    || Number(info.mode & 0o777n) !== 0o600
    || (typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid()))
    || info.size <= 0n
    || info.size > BigInt(options.maximumBytes)
    || (options.expectedBytes !== undefined && info.size !== BigInt(options.expectedBytes))) {
    throw providerError(`${options.code}_INVALID`, 'A private provider artifact is unsafe.');
  }
  const handle = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const openedBig = await handle.stat({ bigint: true });
    if (openedBig.dev !== info.dev || openedBig.ino !== info.ino || openedBig.size !== info.size || openedBig.mtimeNs !== info.mtimeNs || openedBig.nlink !== 1n) {
      throw providerError(`${options.code}_CHANGED`, 'A private provider artifact changed before it was read.');
    }
    const opened = await handle.stat();
    const body = await readStableBoundedFileHandle(handle, {
      expected: opened,
      maxBytes: options.maximumBytes,
      changedError: () => providerError(`${options.code}_CHANGED`, 'A private provider artifact changed while it was read.')
    });
    const digest = createHash('sha256').update(body).digest('hex');
    if (options.expectedSha256 !== undefined && digest !== options.expectedSha256) {
      throw providerError(`${options.code}_DIGEST_MISMATCH`, 'A private provider artifact failed identity validation.');
    }
    return { path: target, body, bytes: body.length, sha256: digest };
  } finally {
    await handle.close();
  }
}

function normalizePreparedManifestForProvider(manifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    kind: manifest.kind,
    sourceMedia: {
      ...manifest.sourceMedia,
      callerDeclared: true,
      derivationVerifiedByFrameCue: false
    },
    preparedAudio: structuredClone(manifest.preparedAudio),
    timeline: structuredClone(manifest.timeline),
    preparation: structuredClone(manifest.preparation),
    limitations: [...manifest.limitations],
    privacy: structuredClone(manifest.privacy)
  };
}

function sha256Stable(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function hasExactKeys(value, keys) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function validPreparedLanguage(value) {
  return value === null || (typeof value === 'string' && /^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3}$/u.test(value));
}

function safeToken(value, maximum) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]+$/u.test(value) ? value.slice(0, maximum) : null;
}

function safeCodeArray(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter((entry) => typeof entry === 'string' && /^[a-z0-9][a-z0-9._-]{0,159}$/u.test(entry)))].slice(0, 64)
    : [];
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function readNormalizedTranscript(transcriptPath, policy, adapter) {
  const canonical = await realpath(transcriptPath);
  if (canonical !== transcriptPath) throw providerError('MEDIA_PROVIDER_TRANSCRIPT_REALPATH_INVALID', 'The provider transcript path is not stable.');
  const info = await lstat(transcriptPath, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || Number(info.mode & 0o777n) !== 0o600 || info.size > BigInt(policy.transcript_provider.maximum_transcript_bytes)) {
    throw providerError('MEDIA_PROVIDER_TRANSCRIPT_INVALID', 'The provider transcript payload is unsafe.');
  }
  const handle = await open(transcriptPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let body;
  try {
    const opened = await handle.stat();
    body = await readStableBoundedFileHandle(handle, {
      expected: opened,
      maxBytes: policy.transcript_provider.maximum_transcript_bytes,
      changedError: () => providerError('MEDIA_PROVIDER_TRANSCRIPT_CHANGED', 'The provider transcript changed while it was read.')
    });
  } finally {
    await handle.close();
  }
  return parseNormalizedTranscriptBody(body, policy, adapter);
}

function parseNormalizedTranscriptBody(body, policy, adapter, options = {}) {
  const segments = [];
  const segmentIds = new Set();
  const languages = new Map();
  const timelineLimitations = new Set();
  let decoded;
  try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(body); } catch {
    throw providerError('MEDIA_PROVIDER_TRANSCRIPT_ENCODING_INVALID', 'The provider transcript is not valid UTF-8.');
  }
  const lines = decoded.split(/\r?\n/u);
  let previousTimedStartUs = -1;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > policy.transcript_provider.maximum_line_bytes) throw providerError('MEDIA_PROVIDER_TRANSCRIPT_LINE_LIMIT', 'A provider transcript segment is too large.');
    if (segments.length >= policy.transcript_provider.maximum_segments) throw providerError('MEDIA_PROVIDER_TRANSCRIPT_SEGMENT_LIMIT', 'The provider transcript contains too many segments.');
    let cue;
    try { cue = JSON.parse(line); } catch { throw providerError('MEDIA_PROVIDER_TRANSCRIPT_JSON_INVALID', 'The provider transcript is not valid JSON Lines.'); }
    const normalizedMajor = Number(String(cue?.schemaVersion ?? '').split('.')[0]);
    if (!adapter.supported_normalized_schema_majors.includes(normalizedMajor)) {
      throw providerError('MEDIA_PROVIDER_TRANSCRIPT_SCHEMA_UNSUPPORTED', 'The provider transcript schema is not supported.');
    }
    const normalized = normalizeCue(
      cue,
      segments.length,
      options.timelineOriginUs ?? 0,
      options.language ?? null,
      options.negativeTimelinePolicy ?? 'reject'
    );
    if (normalized.limitation) timelineLimitations.add(normalized.limitation);
    if (!normalized.segment) continue;
    const segment = normalized.segment;
    if (segmentIds.has(segment.id)) {
      throw providerError('MEDIA_PROVIDER_TRANSCRIPT_DUPLICATE_ID', 'The provider transcript contains duplicate segment identifiers.');
    }
    segmentIds.add(segment.id);
    if (segment.timed && (segment.end_us > policy.source.maximum_media_duration_us || segment.start_us < previousTimedStartUs)) {
      throw providerError('MEDIA_PROVIDER_TRANSCRIPT_TIMELINE_INVALID', 'The provider transcript timeline is invalid.');
    }
    if (segment.timed) previousTimedStartUs = segment.start_us;
    segments.push(segment);
    if (segment.language) languages.set(segment.language, (languages.get(segment.language) ?? 0) + 1);
  }
  const language = options.language ?? [...languages.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return {
    language: language === 'unknown' ? null : language,
    segments,
    payloadSha256: createHash('sha256').update(body).digest('hex'),
    limitations: [
      ...(segments.some((segment) => !segment.timed) ? ['untimed_segments_present'] : []),
      ...timelineLimitations
    ]
  };
}

function normalizeCue(cue, index, timelineOriginUs = 0, defaultLanguage = null, negativeTimelinePolicy = 'reject') {
  if (typeof cue?.text !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(cue.text)) {
    throw providerError('MEDIA_PROVIDER_TRANSCRIPT_CUE_INVALID', 'A provider transcript cue is invalid.');
  }
  const text = cue.text.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!text || text.length > 32_768) throw providerError('MEDIA_PROVIDER_TRANSCRIPT_CUE_INVALID', 'A provider transcript cue is invalid.');
  const startPresent = cue.startSeconds !== undefined && cue.startSeconds !== null;
  const endPresent = cue.endSeconds !== undefined && cue.endSeconds !== null;
  if (startPresent !== endPresent) {
    throw providerError('MEDIA_PROVIDER_TRANSCRIPT_CUE_INVALID', 'A transcript cue must provide both time boundaries or neither.');
  }
  const relativeStartUs = startPresent ? secondsToMicroseconds(cue.startSeconds) : null;
  const relativeEndUs = endPresent ? secondsToMicroseconds(cue.endSeconds) : null;
  let startUs = relativeStartUs === null ? null : relativeStartUs + timelineOriginUs;
  const endUs = relativeEndUs === null ? null : relativeEndUs + timelineOriginUs;
  let limitation = null;
  if (startPresent && Number.isSafeInteger(startUs) && Number.isSafeInteger(endUs) && negativeTimelinePolicy === 'clip_or_omit') {
    if (endUs <= 0) {
      return { segment: null, limitation: 'prepared_timeline_cue_before_video_start_omitted' };
    }
    if (startUs < 0) {
      startUs = 0;
      limitation = 'prepared_timeline_leading_cue_clipped_to_video_start';
    }
  }
  if (startPresent && (!Number.isSafeInteger(startUs) || !Number.isSafeInteger(endUs) || startUs < 0 || endUs < startUs)) {
    throw providerError('MEDIA_PROVIDER_TRANSCRIPT_CUE_INVALID', 'A transcript cue has invalid time boundaries.');
  }
  const timed = startPresent;
  return {
    segment: {
      id: typeof cue.id === 'string' && /^[A-Za-z0-9._-]{1,80}$/u.test(cue.id) ? cue.id : `segment-${String(index + 1).padStart(6, '0')}`,
      start_us: timed ? startUs : null,
      end_us: timed ? endUs : null,
      text,
      language: typeof cue.language === 'string' && /^[A-Za-z0-9-]{1,32}$/u.test(cue.language)
        ? cue.language
        : typeof defaultLanguage === 'string' && /^[A-Za-z0-9-]{1,32}$/u.test(defaultLanguage) ? defaultLanguage : null,
      speaker: typeof cue.speaker === 'string' && cue.speaker.length <= 120 && !/[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(cue.speaker) ? cue.speaker.normalize('NFKC') : null,
      confidence: Number.isFinite(cue.confidence) && cue.confidence >= 0 && cue.confidence <= 1 ? cue.confidence : null,
      timed,
      needs_review: cue.needsReview !== false
    },
    limitation
  };
}

function secondsToMicroseconds(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const match = /^(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/iu.exec(String(value));
  if (!match) return null;
  const fraction = match[2] ?? '';
  const exponent = Number(match[3] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) return null;
  let numerator = BigInt(`${match[1]}${fraction}`);
  let denominator = 10n ** BigInt(fraction.length);
  if (exponent >= 0) numerator *= 10n ** BigInt(exponent);
  else denominator *= 10n ** BigInt(-exponent);
  const rounded = roundRationalHalfAwayFromZero(numerator * 1_000_000n, denominator);
  return rounded >= 0n && rounded <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(rounded) : null;
}

function validateProviderRun(providerRun, operationRoot) {
  if (!path.isAbsolute(providerRun) || path.dirname(providerRun) !== operationRoot || !/^[0-9A-Za-z._-]{1,160}$/u.test(path.basename(providerRun))) {
    throw providerError('MEDIA_PROVIDER_RUN_INVALID', 'The provider returned an invalid run reference.');
  }
  return path.basename(providerRun);
}

function validateContainedRegularFile(filePath, root) {
  if (!path.isAbsolute(filePath)) throw providerError('MEDIA_PROVIDER_FILE_INVALID', 'The provider returned an invalid file reference.');
  assertInside(root, filePath);
}

function validateRelativePath(value) {
  if (typeof value !== 'string' || value.length > 1024 || path.isAbsolute(value) || value.includes('\u0000')) {
    throw providerError('MEDIA_PROVIDER_PATH_INVALID', 'The provider returned an invalid relative path.');
  }
  const normalized = path.normalize(value);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) throw providerError('MEDIA_PROVIDER_PATH_INVALID', 'The provider returned an invalid relative path.');
  return normalized;
}

function assertInside(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw providerError('MEDIA_PROVIDER_PATH_ESCAPE', 'The provider returned a path outside its run.');
}

function parseJsonObject(result, code) {
  let payload;
  try { payload = JSON.parse(result.stdout.toString('utf8')); } catch { throw providerError(code, 'The local transcript provider returned invalid JSON.'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw providerError(code, 'The local transcript provider returned invalid JSON.');
  return payload;
}

function validateRequest(request) {
  if (!request?.operation?.operationId || !request?.operation?.root || !request?.stagedMedia?.path
    || !/^[a-f0-9]{64}$/u.test(request?.mediaIdentity?.sha256 ?? '')
    || !Number.isSafeInteger(request?.mediaIdentity?.bytes)
    || request.mediaIdentity.bytes <= 0
    || !['ephemeral', 'project-retained'].includes(request?.retention)
    || request.retention !== request.operation.retention) {
    throw providerError('MEDIA_PROVIDER_REQUEST_INVALID', 'The transcript provider request is invalid.');
  }
}

function publicMediaIdentity(identity) {
  return { sha256: identity.sha256, bytes: identity.bytes, format: identity.format };
}

function transcriptBoundary(bodyIncluded) {
  return {
    body_included: bodyIncluded,
    absolute_paths_included: false,
    raw_process_output_included: false,
    external_send_performed: false,
    network_performed: false,
    runtime_setup_performed: false,
    model_download_performed: false,
    mcp_execution_performed: false,
    shell_used: false
  };
}

function safeCode(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_]{2,100}$/u.test(error.code) ? error.code.toLowerCase() : 'provider_unavailable';
}

function providerError(code, message, reason = null) {
  const error = new Error(message);
  error.code = code;
  error.details = reason ? { reason } : {};
  return error;
}
