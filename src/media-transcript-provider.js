import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { runFixedProcess } from './fixed-process-runner.js';
import { readPrivateMediaOperation, updatePrivateMediaOperation } from './media-private-operation.js';
import { loadMediaReviewAdapterCatalog, loadMediaReviewPolicy, resolveMediaReviewAdapter } from './media-review-policy.js';
import { inspectStableMediaFile } from './media-stable-file.js';
import {
  loadMediaTranscriptProviderProfile,
  projectMediaTranscriptProviderTrust,
  verifyMediaTranscriptProviderTrust
} from './media-tool-trust.js';
import { readStableBoundedFileHandle } from './safe-local-store.js';

const TRANSCRIPT_SCHEMA_VERSION = '1.0.0';

export async function inspectTranscriptProviderReadiness(context = {}) {
  const policy = await loadMediaReviewPolicy(context);
  try {
    const profile = await (context.loadMediaTranscriptProviderProfile ?? loadMediaTranscriptProviderProfile)(context);
    const catalog = await loadMediaReviewAdapterCatalog(policy, context);
    const adapter = resolveMediaReviewAdapter(catalog, profile.adapter_contract);
    const trust = await (context.verifyMediaTranscriptProviderTrust ?? verifyMediaTranscriptProviderTrust)(profile, context);
    const execution = await runAdapterStage(adapter.commands.readiness, {}, trust, policy.transcript_provider.readiness_timeout_ms, policy.transcript_provider, context);
    const payload = parseJsonObject(execution, 'MEDIA_PROVIDER_READINESS_INVALID');
    const ready = validateReadinessPayload(payload, adapter.required_readiness);
    return {
      schema_version: TRANSCRIPT_SCHEMA_VERSION,
      type: 'transcript_provider_readiness',
      status: ready ? 'ready' : 'setup_required',
      capabilities: ['local_file_transcription', 'timed_segments', 'offline_execution', 'caller_owned_artifacts'],
      method: projectMediaTranscriptProviderTrust(trust),
      limitations: ready ? [] : readinessLimitations(payload),
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
  let trust = await trustVerifier(profile, context);
  const readinessExecution = await runAdapterStage(adapter.commands.readiness, {}, trust, policy.transcript_provider.readiness_timeout_ms, policy.transcript_provider, context, request.signal);
  const readinessPayload = parseJsonObject(readinessExecution, 'MEDIA_PROVIDER_READINESS_INVALID');
  if (!validateReadinessPayload(readinessPayload, adapter.required_readiness)) {
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

  trust = await trustVerifier(profile, context);
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
  const parsed = await readNormalizedTranscript(transcriptPath, policy, adapter);
  const engineConfiguration = projectEngineConfiguration(manifest.engine);
  const method = {
    ...projectMediaTranscriptProviderTrust(trust),
    engine: manifest.engine.id,
    ...engineConfiguration,
    provider_result_schema_version: manifest.schemaVersion,
    normalized_contract: TRANSCRIPT_SCHEMA_VERSION,
    acquisition: 'local_cli_offline'
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

function validateReadinessPayload(payload, required) {
  return payload?.status === required.status
    && payload?.runtime?.runtimeReady === required.runtime_ready
    && payload?.model?.resolvableOffline === required.model_resolvable_offline
    && payload?.boundaries?.externalNetworkCallsDuringAsrEnabled === required.external_network_calls_during_asr_enabled
    && payload?.boundaries?.cloudAsrEnabled === required.cloud_asr_enabled
    && payload?.boundaries?.externalSendingEnabled === required.external_sending_enabled
    && payload?.bodyIncluded === false;
}

function readinessLimitations(payload) {
  const values = [];
  if (payload?.runtime?.runtimeReady !== true) values.push('runtime_not_ready');
  if (payload?.model?.resolvableOffline !== true) values.push('model_not_resolvable_offline');
  if (payload?.boundaries?.externalNetworkCallsDuringAsrEnabled !== false) values.push('offline_boundary_not_confirmed');
  return values.length ? values : ['provider_readiness_contract_not_satisfied'];
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
  const segments = [];
  const segmentIds = new Set();
  const languages = new Map();
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
    const segment = normalizeCue(cue, segments.length);
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
  const language = [...languages.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return {
    language: language === 'unknown' ? null : language,
    segments,
    payloadSha256: createHash('sha256').update(body).digest('hex'),
    limitations: segments.some((segment) => !segment.timed) ? ['untimed_segments_present'] : []
  };
}

function normalizeCue(cue, index) {
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
  const startUs = startPresent ? secondsToMicroseconds(cue.startSeconds) : null;
  const endUs = endPresent ? secondsToMicroseconds(cue.endSeconds) : null;
  if (startPresent && (!Number.isSafeInteger(startUs) || !Number.isSafeInteger(endUs) || endUs < startUs)) {
    throw providerError('MEDIA_PROVIDER_TRANSCRIPT_CUE_INVALID', 'A transcript cue has invalid time boundaries.');
  }
  const timed = startPresent;
  return {
    id: typeof cue.id === 'string' && /^[A-Za-z0-9._-]{1,80}$/u.test(cue.id) ? cue.id : `segment-${String(index + 1).padStart(6, '0')}`,
    start_us: timed ? startUs : null,
    end_us: timed ? endUs : null,
    text,
    language: typeof cue.language === 'string' && /^[A-Za-z0-9-]{1,32}$/u.test(cue.language) ? cue.language : null,
    speaker: typeof cue.speaker === 'string' && cue.speaker.length <= 120 && !/[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(cue.speaker) ? cue.speaker.normalize('NFKC') : null,
    confidence: Number.isFinite(cue.confidence) && cue.confidence >= 0 && cue.confidence <= 1 ? cue.confidence : null,
    timed,
    needs_review: cue.needsReview !== false
  };
}

function secondsToMicroseconds(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER / 1_000_000
    ? Math.round(value * 1_000_000)
    : null;
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
