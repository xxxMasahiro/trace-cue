import { createHash, randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  artifactObject,
  artifactRelPath,
  ensureArtifactRoot,
  writeJsonArtifact,
  writeTextArtifact
} from './artifacts.js';
import { DEFAULT_ARTIFACT_ROOT } from './constants.js';
import { reviewMediaTimeline } from './media-cross-modal-reviewer.js';
import {
  cleanupPrivateMediaOperation,
  createPrivateMediaOperation,
  findPrivateMediaOperation,
  inspectPrivateMediaTree,
  projectPrivateMediaOperation,
  readPrivateMediaCleanupTombstone,
  readPrivateMediaOperation,
  reconcilePrivateMediaOperations,
  updatePrivateMediaOperation,
  writePrivateMediaCleanupTombstone
} from './media-private-operation.js';
import { loadMediaReviewPolicy, mediaReviewBoundary } from './media-review-policy.js';
import { buildMediaReviewTimeline } from './media-review-timeline.js';
import { decideMediaSource } from './media-source-decision.js';
import { copyStableMediaFile, inspectStableMediaFile } from './media-stable-file.js';
import { analyzeLocalMediaTechnical, inspectTechnicalMediaReadiness, preflightLocalMediaTechnical } from './media-technical-analyzer.js';
import { inspectTranscriptProviderReadiness, runTranscriptProvider } from './media-transcript-provider.js';
import { prepareLocalMediaAudio } from './media-prepared-audio.js';
import { createResourceGuard } from './resource-guard.js';
import { getSchema } from './schema-registry.js';
import { validateJsonSchemaSubset } from './json-schema-subset.js';

export const MEDIA_REVIEW_EXECUTION_CONFIRMATION = 'execute-media-review';
export const MEDIA_REVIEW_CLEANUP_CONFIRMATION = 'cleanup-media-review';
export const MEDIA_REVIEW_RIGHTS_CONFIRMATION = 'use-owned-or-authorized-media';
const MEDIA_REVIEW_SCHEMA_VERSION = '1.0.0';

export async function inspectMediaReviewSource(options = {}, context = {}) {
  const cwd = path.resolve(context.cwd ?? process.cwd());
  const policy = await loadMediaReviewPolicy(context);
  const source = await resolveMediaSourceInput(options, cwd, policy, context);
  return {
    status: 'ok',
    data: { source_decision: source.decision },
    warnings: source.decision.status === 'ready' ? [] : [{
      code: 'MEDIA_SOURCE_LIMITED',
      message: 'The source is not ready for full local analysis.',
      details: { status: source.decision.status, capabilities: source.decision.capabilities }
    }],
    errors: [],
    artifacts: []
  };
}

export async function inspectMediaReviewReadiness(options = {}, context = {}) {
  const [transcriptProvider, technicalAnalyzer] = await Promise.all([
    (context.inspectTranscriptProviderReadiness ?? inspectTranscriptProviderReadiness)(context),
    (context.inspectTechnicalMediaReadiness ?? inspectTechnicalMediaReadiness)(context)
  ]);
  const ready = transcriptProvider.status === 'ready' && technicalAnalyzer.status === 'ready';
  return {
    status: 'ok',
    data: {
      readiness: {
        schema_version: MEDIA_REVIEW_SCHEMA_VERSION,
        type: 'media_review_readiness',
        status: ready ? 'ready' : 'unavailable',
        transcript_provider: transcriptProvider,
        technical_analyzer: technicalAnalyzer,
        boundary: {
          read_only: true,
          provider_transcription_performed: false,
          media_analysis_performed: false,
          network_performed: false,
          setup_performed: false,
          mcp_execution_performed: false
        }
      }
    },
    warnings: ready ? [] : [{ code: 'MEDIA_REVIEW_READINESS_INCOMPLETE', message: 'One or more local media review adapters are unavailable.', details: {} }],
    errors: [],
    artifacts: []
  };
}

export async function cleanupMediaReview(options = {}, context = {}) {
  if (options.execute !== true || options.confirm !== MEDIA_REVIEW_CLEANUP_CONFIRMATION) {
    return failure('MEDIA_REVIEW_CLEANUP_CONFIRMATION_REQUIRED', 'Media review cleanup requires the exact confirmation token.', {
      required_confirmation: MEDIA_REVIEW_CLEANUP_CONFIRMATION
    });
  }
  if (!/^[a-f0-9]{32}$/u.test(options.operationId ?? '') || !['ephemeral', 'project-retained'].includes(options.retention)) {
    return failure('MEDIA_REVIEW_CLEANUP_REQUEST_INVALID', 'Media review cleanup requires a valid operation id and retention mode.', {});
  }
  try {
    let tombstone = await readPrivateMediaCleanupTombstone(options.operationId, options.retention, context);
    if (tombstone?.status === 'completed') {
      return cleanupSuccess(replayedCleanupReceipt(tombstone, context.now));
    }
    let reconciledReceipt = null;
    if (tombstone?.status === 'pending') {
      const reconciled = await reconcilePrivateMediaOperations(context);
      reconciledReceipt = reconciled.records.find((record) => record.operation_id === options.operationId)?.cleanup_receipt ?? null;
    }
    let operation;
    try {
      operation = await findPrivateMediaOperation(options.operationId, options.retention, context);
    } catch (error) {
      if (error?.code !== 'MEDIA_PRIVATE_OPERATION_NOT_FOUND' || tombstone?.status !== 'pending') throw error;
      const receipt = ['cleaned', 'already_cleaned'].includes(reconciledReceipt?.status)
        ? { ...reconciledReceipt, status: 'already_cleaned', reason: 'recovered_cleanup_response' }
        : recoveredCleanupReceipt(tombstone, context.now);
      tombstone = await writePrivateMediaCleanupTombstone({
        ...tombstone,
        status: 'completed',
        updated_at: nowIso(context.now),
        receipt
      }, context);
      return cleanupSuccess(tombstone.receipt);
    }
    if (['running', 'cancelling'].includes(operation.marker.state) || operation.marker.lease !== null) {
      return failure('MEDIA_REVIEW_CLEANUP_LIVE_REFUSED', 'A live media review operation cannot be cleaned.', { operation_id: operation.operationId });
    }
    if (operation.marker.state !== 'cleanup_required') {
      operation = await updatePrivateMediaOperation(operation, { state: 'cleanup_required', lease: null }, context);
    }
    if (!tombstone) {
      tombstone = await writePrivateMediaCleanupTombstone({
        schema_version: MEDIA_REVIEW_SCHEMA_VERSION,
        type: 'media_review_cleanup_tombstone',
        operation_id: operation.operationId,
        retention: operation.retention,
        status: 'pending',
        identity: operation.rootIdentity,
        updated_at: nowIso(context.now),
        receipt: null,
        body_included: false
      }, context);
    }
    const receipt = await cleanupPrivateMediaOperation(operation, {
      reason: 'explicit_user_cleanup',
      allowRetained: options.retention === 'project-retained'
    }, context);
    if (!['cleaned', 'already_cleaned'].includes(receipt.status)) {
      return {
        status: 'error', data: { cleanup_receipt: receipt }, warnings: [],
        errors: [{ code: 'MEDIA_REVIEW_CLEANUP_REFUSED', message: 'The private operation was not cleaned.', details: { status: receipt.status } }], artifacts: []
      };
    }
    await writePrivateMediaCleanupTombstone({
      ...tombstone,
      status: 'completed',
      updated_at: nowIso(context.now),
      receipt
    }, context);
    return cleanupSuccess(receipt);
  } catch (error) {
    const code = safeErrorCode(error);
    return failure(code, publicMediaReviewErrorMessage(code), { operation_id: options.operationId });
  }
}

function cleanupSuccess(receipt) {
  return { status: 'ok', data: { cleanup_receipt: receipt }, warnings: [], errors: [], artifacts: [] };
}

function replayedCleanupReceipt(tombstone, now) {
  return {
    schema_version: MEDIA_REVIEW_SCHEMA_VERSION,
    type: 'media_cleanup_receipt',
    operation_id: tombstone.operation_id,
    status: 'already_cleaned',
    retention: tombstone.retention,
    reason: 'idempotent_cleanup_response_replay',
    completed_at: nowIso(now),
    deleted: { file_count: 0, directory_count: 0, byte_count: 0 },
    identity: tombstone.identity,
    limitations: ['cleanup_was_completed_by_an_earlier_request'],
    boundary: {
      absolute_path_included: false,
      raw_media_included: false,
      full_transcript_included: false,
      sibling_deleted: false,
      normal_artifact_root_deleted: false
    }
  };
}

function recoveredCleanupReceipt(tombstone, now) {
  return {
    schema_version: MEDIA_REVIEW_SCHEMA_VERSION,
    type: 'media_cleanup_receipt',
    operation_id: tombstone.operation_id,
    status: 'already_cleaned',
    retention: tombstone.retention,
    reason: 'recovered_cleanup_response',
    completed_at: nowIso(now),
    deleted: { file_count: 0, directory_count: 0, byte_count: 0 },
    identity: tombstone.identity,
    limitations: ['cleanup_completed_before_response_was_recorded'],
    boundary: {
      absolute_path_included: false,
      raw_media_included: false,
      full_transcript_included: false,
      sibling_deleted: false,
      normal_artifact_root_deleted: false
    }
  };
}

export async function planMediaReview(options = {}, context = {}) {
  const cwd = path.resolve(context.cwd ?? process.cwd());
  const policy = await loadMediaReviewPolicy(context);
  const source = await resolveMediaSourceInput(options, cwd, policy, context);
  const [transcriptReadiness, technicalReadiness] = await Promise.all([
    (context.inspectTranscriptProviderReadiness ?? inspectTranscriptProviderReadiness)(context),
    (context.inspectTechnicalMediaReadiness ?? inspectTechnicalMediaReadiness)(context)
  ]);
  const executable = source.decision.status === 'ready'
    && source.decision.capabilities.includes('full_media_analysis')
    && transcriptReadiness.status === 'ready'
    && technicalReadiness.status === 'ready';
  const planBody = {
    schema_version: MEDIA_REVIEW_SCHEMA_VERSION,
    type: 'media_review_plan',
    source_decision: source.decision,
    media_identity: source.identity ? publicIdentity(source.identity) : null,
    retention: normalizeRetention(options.retention, policy),
    readiness: { transcript_provider: transcriptReadiness, technical_analyzer: technicalReadiness },
    analysis_settings: publicAnalysisSettings(policy),
    executable,
    execution_confirmation: executable ? MEDIA_REVIEW_EXECUTION_CONFIRMATION : null,
    boundary: {
      read_only: true,
      private_root_created: false,
      provider_execution_performed: false,
      technical_analysis_performed: false,
      network_performed: false,
      media_acquisition_performed: false,
      url_secrets_included: false
    }
  };
  return {
    status: 'ok',
    data: { plan: { ...planBody, plan_hash: hashPlan(planBody) } },
    warnings: executable ? [] : [{
      code: 'MEDIA_REVIEW_NOT_EXECUTABLE',
      message: 'Full local media analysis is not ready.',
      details: { source_status: source.decision.status }
    }],
    errors: [],
    artifacts: []
  };
}

export async function executeMediaReview(options = {}, context = {}) {
  const trustedPlan = context.acceptedMediaReviewPlan;
  const planResult = trustedPlan
    ? trustedPlanResult(trustedPlan)
    : await planMediaReview(options, { ...context, signal: options.signal ?? context.signal });
  const plan = planResult.data.plan;
  if (!plan.executable) return planResult;
  if (options.execute !== true || options.confirm !== MEDIA_REVIEW_EXECUTION_CONFIRMATION) {
    return failure('MEDIA_REVIEW_CONFIRMATION_REQUIRED', 'Media review execution requires the exact confirmation token.', {
      required_confirmation: MEDIA_REVIEW_EXECUTION_CONFIRMATION,
      plan_hash: plan.plan_hash
    });
  }
  if (typeof options.planHash !== 'string' || options.planHash !== plan.plan_hash) {
    return failure('MEDIA_REVIEW_PLAN_HASH_MISMATCH', 'The media review plan must be accepted without drift.', {
      expected_plan_hash: plan.plan_hash
    });
  }
  const policy = await loadMediaReviewPolicy(context);
  const cwd = path.resolve(context.cwd ?? process.cwd());
  const acceptedSource = await resolveMediaSourceInput(options, cwd, policy, context);
  const sourcePath = acceptedSource.path;
  const sourceIdentity = acceptedSource.identity;
  if (!sourcePath || !sourceIdentity
    || sourceIdentity.sha256 !== plan.media_identity?.sha256
    || sourceIdentity.bytes !== plan.media_identity?.bytes) {
    return failure('MEDIA_REVIEW_SOURCE_CHANGED', 'The media source changed after the accepted plan.', {});
  }
  const retention = plan.retention;
  const resourceGuard = createResourceGuard({ 'resource-guard': options.resourceGuard ?? 'advisory' }, context, context.now);
  const preflight = await resourceGuard.check('media_review_preflight', { maximum_media_bytes: policy.source.maximum_local_media_bytes });
  if (resourceGuard.shouldStop(preflight)) return failure('MEDIA_REVIEW_RESOURCE_GUARD_STOP', 'The resource guard refused to start media analysis.', {});
  try {
    await (context.reconcilePrivateMediaOperations ?? reconcilePrivateMediaOperations)(context);
  } catch (error) {
    return failure('MEDIA_REVIEW_RECONCILIATION_FAILED', 'Private media retention could not be reconciled safely.', {
      reason: safeErrorCode(error)
    });
  }

  let operation;
  let cleanupReceipt = null;
  try {
    operation = await createPrivateMediaOperation({ retention, operationId: options.operationId }, context);
    context.onPrivateMediaOperation?.(operation);
    context.onMediaReviewProgress?.({ operation_id: operation.operationId, phase: 'staging', percent: 10 });
    operation = await updatePrivateMediaOperation(operation, {
      state: 'running',
      lease: { pid: process.pid, token: randomBytes(16).toString('hex') },
      mediaIdentity: sourceIdentity
    }, context);
    const inputDirectory = path.join(operation.root, 'input');
    await mkdir(inputDirectory, { mode: 0o700 });
    const extension = safeExtension(sourcePath);
    const stagedPath = path.join(inputDirectory, `source${extension}`);
    const staged = await copyStableMediaFile(sourcePath, stagedPath, {
      maxBytes: policy.source.maximum_local_media_bytes,
      signal: options.signal ?? null
    });
    if (staged.sha256 !== sourceIdentity.sha256 || staged.bytes !== sourceIdentity.bytes) {
      throw mediaReviewError('MEDIA_REVIEW_SOURCE_CHANGED', 'The media source changed after the accepted plan.');
    }
    context.onMediaReviewProgress?.({ operation_id: operation.operationId, phase: 'analyzing', percent: 25 });
    const providerRunner = context.runTranscriptProvider ?? runTranscriptProvider;
    const technicalRunner = context.analyzeLocalMediaTechnical ?? analyzeLocalMediaTechnical;
    const providerInputContract = plan.readiness?.transcript_provider?.input_contract ?? { mode: 'source_media' };
    const preparedMode = providerInputContract.mode === 'caller_prepared_audio';
    let technicalPreflight = null;
    if (!context.analyzeLocalMediaTechnical || preparedMode) {
      technicalPreflight = await (context.preflightLocalMediaTechnical ?? preflightLocalMediaTechnical)({
        mediaPath: stagedPath,
        operationRoot: operation.root,
        mediaIdentity: staged,
        includeDecodedTimeline: preparedMode,
        signal: options.signal ?? null
      }, context);
    }
    const preparedAudio = preparedMode
      ? await (context.prepareLocalMediaAudio ?? prepareLocalMediaAudio)({
        operation,
        mediaPath: stagedPath,
        mediaIdentity: staged,
        decodedTimeline: technicalPreflight?.decoded_timeline,
        contract: providerInputContract.prepared_audio_contract,
        signal: options.signal ?? null
      }, context)
      : null;
    context.onMediaReviewProgress?.({ operation_id: operation.operationId, phase: 'analyzing', percent: preparedMode ? 40 : 25 });
    const [providerResult, technicalAnalysis] = await runConcurrentMediaAnalyses([
      (analysisSignal) => providerRunner({
        operation,
        stagedMedia: { path: stagedPath },
        mediaIdentity: staged,
        preparedAudio,
        retention,
        signal: analysisSignal
      }, context),
      (analysisSignal) => technicalRunner({
        mediaPath: stagedPath,
        operationRoot: operation.root,
        mediaIdentity: staged,
        signal: analysisSignal
      }, context)
    ], options.signal ?? null);
    validateTranscriptTimeline(providerResult.transient, technicalAnalysis, policy);
    context.onMediaReviewProgress?.({ operation_id: operation.operationId, phase: 'integrating', percent: 80 });
    operation = providerResult.operation ?? operation;
    operation = await inspectPrivateMediaTree(operation, context);
    const timeline = await buildMediaReviewTimeline({
      technicalAnalysis,
      transcript: providerResult.transient
    }, context);
    const reviewed = await reviewMediaTimeline({
      technicalAnalysis,
      transcript: providerResult.transient,
      timeline,
      mediaIdentity: staged
    }, context);
    const publicTechnicalAnalysis = structuredClone(technicalAnalysis);
    publicTechnicalAnalysis.media_identity = publicIdentity(staged);
    const publicTranscriptProjection = normalizeTranscriptProjection(providerResult.projection, staged);
    const postflight = await resourceGuard.check('media_review_post_analysis', {
      frame_count: technicalAnalysis.technical_metrics.frame_count_analyzed,
      finding_count: reviewed.deterministicFindings.length + reviewed.advisoryFindings.length
    });
    if (resourceGuard.shouldStop(postflight)) {
      throw mediaReviewError('MEDIA_REVIEW_RESOURCE_GUARD_STOP', 'The resource guard refused to publish the completed media analysis.');
    }
    const result = buildPublicResult({
      operation,
      plan,
      staged,
      technicalAnalysis: publicTechnicalAnalysis,
      transcriptProjection: publicTranscriptProjection,
      timeline,
      reviewed,
      resourceGuard: resourceGuard.summary(),
      postflight,
      policy
    });
    enforcePublicResultLimit(result, policy);
    assertPublicResultBoundary(result, [operation.root, operation.base, sourcePath, stagedPath, preparedAudio?.audio?.path, preparedAudio?.manifest?.path]);
    assertPublicResultSchema(result);
    operation = await updatePrivateMediaOperation(operation, {
      state: retention === 'project-retained' ? 'completed_retained' : 'completed',
      lease: null
    }, context);
    if (retention === 'ephemeral') {
      try {
        cleanupReceipt = await cleanupPrivateMediaOperation(operation, { reason: 'ephemeral_review_completed' }, context);
      } catch (cleanupError) {
        cleanupReceipt = failedCleanupReceipt(operation, cleanupError, context.now);
      }
      if (cleanupReceipt.status !== 'cleaned') {
        operation = await updatePrivateMediaOperation(operation, { state: 'cleanup_required', lease: null }, context);
        result.status = 'completed_with_limitations';
        result.privacy.private_payload_retained = true;
        result.limitations = [...new Set([...result.limitations, 'ephemeral_cleanup_not_completed'])];
      }
    }
    // Cleanup outcome can change status/privacy/limitations. Revalidate the
    // exact final bytes immediately before normal artifact publication.
    enforcePublicResultLimit(result, policy);
    assertPublicResultBoundary(result, [operation.root, operation.base, sourcePath, stagedPath, preparedAudio?.audio?.path, preparedAudio?.manifest?.path]);
    assertPublicResultSchema(result);
    const artifacts = await persistMediaReviewResult(result, options, context);
    context.onMediaReviewProgress?.({ operation_id: operation.operationId, phase: 'completed', percent: 100 });
    return {
      status: 'ok',
      data: {
        result,
        operation: publicOperation(operation, {
          state: cleanupReceipt?.status === 'cleaned' ? 'completed' : operation.marker.state,
          resultAvailable: true,
          cleanupAvailable: retention === 'project-retained' || operation.marker.state === 'cleanup_required'
        }),
        cleanup_receipt: cleanupReceipt
      },
      warnings: [
        ...resourceGuard.summary().warnings,
        ...(cleanupReceipt && cleanupReceipt.status !== 'cleaned'
          ? [{ code: 'MEDIA_REVIEW_CLEANUP_REQUIRED', message: 'Private media cleanup must be retried explicitly.', details: {} }]
          : [])
      ],
      errors: [],
      artifacts
    };
  } catch (error) {
    let cleanupError = null;
    const containmentUnconfirmed = ['MEDIA_PROVIDER_CONTAINMENT_UNCONFIRMED', 'MEDIA_REVIEW_CONTAINMENT_UNCONFIRMED'].includes(error?.code);
    if (operation) {
      try {
        const current = await readPrivateMediaOperation(operation, context);
        if (containmentUnconfirmed) {
          if (['running', 'cancelling'].includes(current.marker.state)) {
            operation = await updatePrivateMediaOperation(current, {
              state: 'cleanup_required',
              lease: { ...current.marker.lease, containment_unconfirmed: true }
            }, context);
          } else {
            operation = current;
          }
          cleanupError = 'MEDIA_PROVIDER_CONTAINMENT_UNCONFIRMED';
        } else if (options.signal?.aborted) {
          if (current.marker.state === 'running') {
            operation = await updatePrivateMediaOperation(current, { state: 'cancelling' }, context);
            operation = await updatePrivateMediaOperation(operation, { state: 'cancelled', lease: null }, context);
          } else if (current.marker.state === 'cancelling' || current.marker.state === 'prepared') {
            operation = await updatePrivateMediaOperation(current, { state: 'cancelled', lease: null }, context);
          }
        } else if (['prepared', 'running', 'cancelling'].includes(current.marker.state)) {
          operation = await updatePrivateMediaOperation(current, { state: 'failed', lease: null }, context);
        }
        if (operation.retention === 'ephemeral' && !containmentUnconfirmed) {
          try {
            cleanupReceipt = await cleanupPrivateMediaOperation(operation, { reason: 'ephemeral_review_failed', allowLive: true }, context);
          } catch (cleanupFailure) {
            cleanupError = safeErrorCode(cleanupFailure);
            const latest = await readPrivateMediaOperation(operation, context);
            if (latest.marker.state !== 'cleanup_required') {
              operation = await updatePrivateMediaOperation(latest, { state: 'cleanup_required', lease: null }, context);
            }
          }
        }
      } catch (cleanupFailure) {
        if (cleanupReceipt?.status !== 'cleaned') cleanupError = safeErrorCode(cleanupFailure);
      }
    }
    context.onMediaReviewProgress?.({ operation_id: operation?.operationId ?? null, phase: options.signal?.aborted ? 'cancelled' : 'failed', percent: null });
    const code = safeErrorCode(error);
    return failure(code, publicMediaReviewErrorMessage(code), {
      operation_id: operation?.operationId ?? null,
      cleanup_status: cleanupReceipt?.status ?? (containmentUnconfirmed ? 'deferred_containment_unconfirmed' : cleanupError ? 'failed' : 'not_required'),
      cleanup_error: cleanupError
    });
  }
}

function buildPublicResult({ operation, plan, staged, technicalAnalysis, transcriptProjection, timeline, reviewed, resourceGuard, policy }) {
  const limitations = [...new Set([
    ...(technicalAnalysis.limitations ?? []),
    ...(transcriptProjection.limitations ?? []),
    ...(timeline.limitations ?? []),
    ...(reviewed.limitations ?? [])
  ])];
  return {
    schema_version: MEDIA_REVIEW_SCHEMA_VERSION,
    type: 'media_review_result',
    operation_id: operation.operationId,
    status: limitations.length ? 'completed_with_limitations' : 'completed',
    media_identity: publicIdentity(staged),
    source_decision: plan.source_decision,
    analysis_settings: plan.analysis_settings,
    toolchain: {
      transcript_provider: transcriptProjection.method,
      technical_analyzer: technicalAnalysis.method,
      comparable_configuration_identity: createHash('sha256').update(stableJson({
        media_identity: staged.sha256,
        analysis_settings: plan.analysis_settings,
        transcript_configuration: transcriptProjection.method,
        technical_toolchain: [technicalAnalysis.method.probe_identity, technicalAnalysis.method.analyzer_identity]
      })).digest('hex')
    },
    technical_analysis: technicalAnalysis,
    transcript: transcriptProjection,
    timeline,
    deterministic_findings: reviewed.deterministicFindings,
    advisory_findings: reviewed.advisoryFindings,
    content_evidence: reviewed.contentEvidence,
    limitations,
    resource_guard: resourceGuard,
    privacy: {
      retention: operation.retention,
      private_payload_retained: operation.retention === 'project-retained',
      raw_media_persisted_outside_private_root: false,
      full_transcript_persisted_outside_private_root: false,
      full_transcript_in_result: false,
      raw_audio_in_result: false,
      raw_frames_in_result: false,
      external_send_performed: false
    },
    boundary: {
      ...mediaReviewBoundary(policy),
      absolute_paths_included: false,
      url_query_or_fragment_included: false,
      deterministic_and_advisory_separated: true,
      failure_treated_as_success: false
    }
  };
}

async function runConcurrentMediaAnalyses(runners, parentSignal) {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(parentSignal?.reason ?? new Error('media review cancelled'));
  if (parentSignal?.aborted) forwardAbort();
  else parentSignal?.addEventListener?.('abort', forwardAbort, { once: true });
  try {
    const tasks = runners.map((runner) => Promise.resolve()
      .then(() => runner(controller.signal))
      .catch((error) => {
        if (!controller.signal.aborted) controller.abort(error);
        throw error;
      }));
    const settled = await Promise.allSettled(tasks);
    const rejected = settled.find((entry) => entry.status === 'rejected');
    if (rejected) throw rejected.reason;
    return settled.map((entry) => entry.value);
  } finally {
    parentSignal?.removeEventListener?.('abort', forwardAbort);
  }
}

function validateTranscriptTimeline(transcript, technicalAnalysis, policy) {
  const durationUs = technicalAnalysis?.technical_metrics?.duration_us;
  if (!Number.isSafeInteger(durationUs) || durationUs <= 0) {
    throw mediaReviewError('MEDIA_REVIEW_DURATION_INVALID', 'The technical media duration is invalid.');
  }
  const maximumEndUs = durationUs + policy.transcript_provider.maximum_timeline_overrun_us;
  for (const segment of transcript?.segments ?? []) {
    if (segment.timed === true
      && (!Number.isSafeInteger(segment.start_us)
        || !Number.isSafeInteger(segment.end_us)
        || segment.start_us < 0
        || segment.end_us < segment.start_us
        || segment.start_us > maximumEndUs
        || segment.end_us > maximumEndUs)) {
      throw mediaReviewError('MEDIA_REVIEW_TRANSCRIPT_DURATION_MISMATCH', 'The transcript timeline exceeds the measured media duration.');
    }
  }
}

async function persistMediaReviewResult(result, options, context) {
  const cwd = path.resolve(context.cwd ?? process.cwd());
  const artifactRootInput = options.artifactRoot ?? DEFAULT_ARTIFACT_ROOT;
  const root = await ensureArtifactRoot(cwd, artifactRootInput);
  const jsonName = `${result.operation_id}.json`;
  const markdownName = `${result.operation_id}.md`;
  await writeJsonArtifact(root, ['media-review-results', jsonName], result);
  await writeTextArtifact(root, ['media-review-results', markdownName], renderMediaReviewMarkdown(result));
  return [
    artifactObject({
      type: 'media_review_result',
      path: artifactRelPath(artifactRootInput, 'media-review-results', jsonName),
      description: 'Bounded media review evidence without raw media or a full transcript.'
    }),
    artifactObject({
      type: 'media_review_report',
      path: artifactRelPath(artifactRootInput, 'media-review-results', markdownName),
      description: 'Timecoded media review report with deterministic and advisory findings separated.'
    })
  ];
}

export function renderMediaReviewMarkdown(result) {
  const lines = [
    '# Media Review', '',
    `- Operation: ${markdownLiteral(result.operation_id)}`,
    `- Media SHA-256: ${markdownLiteral(result.media_identity.sha256)}`,
    `- Status: ${markdownLiteral(result.status)}`,
    `- Retention: ${markdownLiteral(result.privacy.retention)}`,
    '', '## Deterministic findings', ''
  ];
  renderFindings(lines, result.deterministic_findings);
  lines.push('', '## Advisory findings', '');
  renderFindings(lines, result.advisory_findings);
  lines.push('', '## Limitations', '');
  for (const limitation of result.limitations) lines.push(`- ${markdownLiteral(limitation)}`);
  lines.push('', 'Raw media, raw audio, frames, absolute paths, and the full transcript are not embedded in this report.', '');
  return lines.join('\n');
}

function renderFindings(lines, findings) {
  if (!findings.length) {
    lines.push('No findings in this classification.');
    return;
  }
  for (const finding of findings) {
    lines.push(`### ${markdownLiteral(finding.timecode.start)}–${markdownLiteral(finding.timecode.end)} · ${markdownLiteral(finding.kind)}`);
    lines.push('');
    lines.push(`- Severity: ${markdownLiteral(finding.severity)}`);
    lines.push(`- Classification: ${markdownLiteral(finding.classification)}`);
    lines.push(`- Method: ${markdownLiteral(finding.method)}`);
    lines.push(`- Confidence: ${markdownLiteral(finding.confidence)}`);
    lines.push(`- Evidence: ${finding.evidence.map(markdownLiteral).join(' ')}`);
    if (finding.limitations.length) lines.push(`- Limitations: ${finding.limitations.map(markdownLiteral).join('; ')}`);
    lines.push(`- Recommended fix: ${markdownLiteral(finding.recommendation)}`);
    lines.push('');
  }
}

function markdownLiteral(value) {
  return String(value ?? '')
    .replace(/[\r\n]+/gu, ' ')
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, '\ufffd')
    .replace(/[&<>!\[\]()`*_#\\]/gu, (character) => {
      if (character === '&') return '&amp;';
      if (character === '<') return '&lt;';
      if (character === '>') return '&gt;';
      return `&#${character.codePointAt(0)};`;
    });
}

async function resolveMediaSourceInput(options, cwd, policy, context = {}) {
  if (options.url) {
    return { path: null, identity: null, decision: await decideMediaSource({ url: options.url }, { mediaReviewPolicy: policy }) };
  }
  if (typeof options.input !== 'string' || options.input.length === 0 || options.input.includes('\u0000')) {
    return { path: null, identity: null, decision: await decideMediaSource({ local_file: true, rights_declared: false }, { mediaReviewPolicy: policy }) };
  }
  const input = path.resolve(cwd, options.input);
  const relative = path.relative(cwd, input);
  const privateInputRoot = context.mediaInputRoot ? path.resolve(context.mediaInputRoot) : null;
  const privateRelative = privateInputRoot ? path.relative(privateInputRoot, input) : null;
  const insideWorkspace = Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
  const insideApprovedPrivateRoot = Boolean(privateRelative) && !privateRelative.startsWith('..') && !path.isAbsolute(privateRelative);
  if (!insideWorkspace && !insideApprovedPrivateRoot) {
    throw mediaReviewError('MEDIA_REVIEW_INPUT_OUTSIDE_WORKSPACE', 'The local media input must stay inside the current workspace.');
  }
  const extension = safeExtension(input);
  const rightsDeclared = options.rightsDeclared === true;
  const decision = await decideMediaSource({ local_file: true, local_extension: extension, rights_declared: rightsDeclared }, { mediaReviewPolicy: policy });
  if (!rightsDeclared || decision.status !== 'ready') return { path: input, identity: null, decision };
  const identity = await inspectStableMediaFile(input, { maxBytes: policy.source.maximum_local_media_bytes });
  return { path: input, identity, decision };
}

function publicOperation(operation, { state, resultAvailable, cleanupAvailable }) {
  return {
    schema_version: MEDIA_REVIEW_SCHEMA_VERSION,
    type: 'media_review_operation',
    ...projectPrivateMediaOperation(operation, operation.marker),
    state,
    progress: { phase: resultAvailable ? 'completed' : state, percent: resultAvailable ? 100 : null },
    capabilities: { status: true, cancel: false, cleanup: cleanupAvailable, result: resultAvailable },
    result_available: resultAvailable,
    cleanup_available: cleanupAvailable,
    errors: [],
    boundary: {
      absolute_path_included: false,
      private_locator_included: false,
      raw_media_included: false,
      full_transcript_included: false
    }
  };
}

function publicAnalysisSettings(policy) {
  return {
    schema_version: MEDIA_REVIEW_SCHEMA_VERSION,
    policy_version: policy.policy_version,
    maximum_media_bytes: policy.source.maximum_local_media_bytes,
    maximum_duration_us: policy.source.maximum_media_duration_us,
    maximum_frames: policy.technical_analyzer.maximum_frames,
    cut_scene_threshold: policy.technical_analyzer.cut_scene_threshold,
    av_sync_warning_us: policy.technical_analyzer.av_sync_warning_us,
    subtitle_minimum_us: policy.technical_analyzer.subtitle_minimum_us,
    duplicate_hash_window: policy.technical_analyzer.duplicate_hash_window,
    maximum_subtitle_events: policy.technical_analyzer.maximum_subtitle_events,
    maximum_total_streams: policy.technical_analyzer.maximum_total_streams,
    maximum_video_streams: policy.technical_analyzer.maximum_video_streams,
    maximum_audio_streams: policy.technical_analyzer.maximum_audio_streams,
    maximum_subtitle_streams: policy.technical_analyzer.maximum_subtitle_streams,
    maximum_video_width: policy.technical_analyzer.maximum_video_width,
    maximum_video_height: policy.technical_analyzer.maximum_video_height,
    maximum_video_pixels: policy.technical_analyzer.maximum_video_pixels,
    maximum_audio_sample_rate: policy.technical_analyzer.maximum_audio_sample_rate,
    maximum_audio_channels: policy.technical_analyzer.maximum_audio_channels,
    decoder_threads: policy.technical_analyzer.decoder_threads,
    maximum_single_allocation_bytes: policy.technical_analyzer.maximum_single_allocation_bytes,
    speech_cut_edge_margin_us: policy.reviewer.speech_cut_edge_margin_us,
    topic_change_visual_window_us: policy.reviewer.topic_change_visual_window_us,
    long_pause_warning_us: policy.reviewer.long_pause_warning_us,
    speech_density_warning_words_per_second: policy.reviewer.speech_density_warning_words_per_second,
    speech_density_high_words_per_second: policy.reviewer.speech_density_high_words_per_second,
    repetition_similarity_threshold: policy.reviewer.repetition_similarity_threshold,
    policy_identity: createHash('sha256').update(stableJson(policy)).digest('hex'),
    semantic_change_method: 'token_jaccard_heuristic',
    deterministic_and_advisory_separated: true
  };
}

function enforcePublicResultLimit(result, policy) {
  let bytes = persistedJsonBytes(result);
  if (bytes <= policy.operation.maximum_public_result_bytes) return;
  const reducible = [
    result.technical_analysis.technical_metrics.presentation_timestamps_us,
    result.technical_analysis.duplicate_frames,
    result.technical_analysis.dropped_frame_intervals,
    result.technical_analysis.shot_boundaries,
    result.technical_analysis.subtitle_events,
    result.timeline.items,
    result.timeline.semantic_change_points,
    result.deterministic_findings,
    result.advisory_findings
  ].filter(Array.isArray);
  while (bytes > policy.operation.maximum_public_result_bytes) {
    const candidate = reducible
      .filter((value) => value.length > 0)
      .sort((left, right) => Buffer.byteLength(JSON.stringify(right)) - Buffer.byteLength(JSON.stringify(left)))[0];
    if (!candidate) break;
    candidate.length = Math.floor(candidate.length / 2);
    bytes = persistedJsonBytes(result);
  }
  result.timeline.item_count = result.timeline.items.length;
  result.timeline.semantic_change_count = result.timeline.semantic_change_points.length;
  result.timeline.truncated = true;
  result.timeline.limitations = [...new Set([...(result.timeline.limitations ?? []), 'timeline_items_truncated_to_public_result_limit'])];
  result.limitations.push('public_result_truncated_to_policy_limit');
  const findingIds = new Set([...result.deterministic_findings, ...result.advisory_findings].map((finding) => finding.id));
  if (Array.isArray(result.content_evidence?.content_units)) {
    result.content_evidence.content_units = result.content_evidence.content_units.filter((unit) =>
      Array.isArray(unit.source_refs) && unit.source_refs.some((reference) => findingIds.has(reference)));
  }
  if (Array.isArray(result.content_evidence?.summaries?.content_summary)) {
    result.content_evidence.summaries.content_summary = [`${findingIds.size} evidence-linked media review finding(s) were retained in the bounded result.`];
  }
  bytes = persistedJsonBytes(result);
  if (bytes > policy.operation.maximum_public_result_bytes) throw mediaReviewError('MEDIA_REVIEW_PUBLIC_RESULT_LIMIT', 'The bounded media review result exceeds policy.');
}

function persistedJsonBytes(value) {
  return Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`);
}

function failedCleanupReceipt(operation, error, now) {
  const timestamp = typeof now === 'function' ? now() : now;
  const completedAt = timestamp instanceof Date && Number.isFinite(timestamp.getTime())
    ? timestamp.toISOString()
    : new Date().toISOString();
  return {
    schema_version: MEDIA_REVIEW_SCHEMA_VERSION,
    type: 'media_cleanup_receipt',
    operation_id: operation.operationId,
    status: 'failed',
    retention: operation.retention,
    reason: safeErrorCode(error),
    completed_at: completedAt,
    deleted: { file_count: 0, directory_count: 0, byte_count: 0 },
    identity: operation.rootIdentity,
    limitations: ['cleanup_must_be_retried'],
    boundary: {
      absolute_path_included: false,
      raw_media_included: false,
      full_transcript_included: false,
      sibling_deleted: false,
      normal_artifact_root_deleted: false
    }
  };
}

function publicMediaReviewErrorMessage(code) {
  const messages = {
    MEDIA_REVIEW_SOURCE_CHANGED: 'The media source changed after the accepted plan.',
    MEDIA_REVIEW_RESOURCE_GUARD_STOP: 'Local resource limits stopped the media review safely.',
    MEDIA_REVIEW_TRANSCRIPT_DURATION_MISMATCH: 'The transcript timing did not match the measured video duration.',
    MEDIA_REVIEW_DURATION_INVALID: 'The measured video duration was invalid.',
    MEDIA_REVIEW_PUBLIC_RESULT_LIMIT: 'The bounded media review result exceeded its safe output limit.',
    MEDIA_ANALYZER_AUDIO_TIMELINE_UNAVAILABLE: 'The video does not contain a usable local audio timeline for transcription.',
    MEDIA_PREPARED_AUDIO_EXTRACTION_FAILED: 'The video audio could not be prepared for local transcription.',
    MEDIA_PREPARED_AUDIO_PCM_INVALID: 'The prepared local audio did not match the required transcription format.',
    MEDIA_PREPARED_AUDIO_OUTPUT_LIMIT_REACHED: 'The prepared local audio reached the configured private size limit.',
    MEDIA_PREPARED_AUDIO_SIZE_LIMIT: 'The prepared local audio exceeded the configured private size limit.',
    MEDIA_PROVIDER_SETUP_REQUIRED: 'Local transcription is not ready. Check the configured provider and model without installing or downloading automatically.',
    MEDIA_REVIEW_ADAPTER_CONTRACT_UNAVAILABLE: 'The configured local transcription contract is not supported by this TraceCue version.',
    MEDIA_PROVIDER_RESULT_INVALID: 'The local transcription provider returned an incompatible result contract.',
    MEDIA_PROVIDER_PREPARED_REGISTRATION_INVALID: 'The local transcription provider could not verify the prepared audio contract.',
    MEDIA_PROVIDER_PREPARED_RECEIPT_BINDING_INVALID: 'The local transcription receipt did not match the verified prepared audio result.',
    MEDIA_PROVIDER_CONTAINMENT_UNCONFIRMED: 'The local transcript provider stopped without confirmed child-process containment; restart Linux/WSL before retrying cleanup.',
    MEDIA_REVIEW_CONTAINMENT_UNCONFIRMED: 'A local media process stopped without confirmed child-process containment; restart Linux/WSL before retrying cleanup.',
    MEDIA_PRIVATE_OPERATION_NOT_FOUND: 'The private media review operation was not found.',
    FIXED_PROCESS_ABORTED: 'The local media review was cancelled.'
  };
  return messages[code] ?? 'The local media review could not be completed safely.';
}

function normalizeTranscriptProjection(value, mediaIdentity) {
  return {
    schema_version: value.schema_version,
    type: value.type,
    status: value.status,
    media_identity: publicIdentity(mediaIdentity),
    language: value.language ?? null,
    segment_count: Number.isSafeInteger(value.segment_count) ? value.segment_count : 0,
    timed_segment_count: Number.isSafeInteger(value.timed_segment_count) ? value.timed_segment_count : 0,
    transcript_identity: /^[a-f0-9]{64}$/u.test(value.transcript_identity ?? '') ? value.transcript_identity : null,
    method: {
      adapter_contract: String(value.method?.adapter_contract ?? '').slice(0, 120),
      runtime_kind: String(value.method?.runtime_kind ?? '').slice(0, 80),
      provider_version: String(value.method?.provider_version ?? '').slice(0, 80),
      provider_revision: /^[a-f0-9]{40}$/u.test(value.method?.provider_revision ?? '') ? value.method.provider_revision : null,
      toolchain_identity: /^[a-f0-9]{64}$/u.test(value.method?.toolchain_identity ?? '') ? value.method.toolchain_identity : null,
      provider_configuration_identity: /^[a-f0-9]{64}$/u.test(value.method?.provider_configuration_identity ?? '') ? value.method.provider_configuration_identity : null,
      engine: value.method?.engine ? String(value.method.engine).slice(0, 80) : null,
      model_reference: value.method?.model_reference ? String(value.method.model_reference).slice(0, 120) : null,
      model_reference_identity: /^[a-f0-9]{64}$/u.test(value.method?.model_reference_identity ?? '') ? value.method.model_reference_identity : null,
      execution_profile: value.method?.execution_profile ? String(value.method.execution_profile).slice(0, 80) : null,
      device: value.method?.device ? String(value.method.device).slice(0, 40) : null,
      compute_type: value.method?.compute_type ? String(value.method.compute_type).slice(0, 40) : null,
      vad: typeof value.method?.vad === 'boolean' ? value.method.vad : null,
      beam_size: Number.isSafeInteger(value.method?.beam_size) ? value.method.beam_size : null,
      threads: Number.isSafeInteger(value.method?.threads) ? value.method.threads : null,
      provider_result_schema_version: value.method?.provider_result_schema_version ? String(value.method.provider_result_schema_version).slice(0, 40) : null,
      normalized_contract: value.method?.normalized_contract ? String(value.method.normalized_contract).slice(0, 40) : null,
      acquisition: value.method?.acquisition ? String(value.method.acquisition).slice(0, 80) : null,
      ...(value.method?.acquisition === 'local_cli_offline_prepared_audio' ? {
        prepared_audio_contract: value.method?.prepared_audio_contract ? String(value.method.prepared_audio_contract).slice(0, 40) : null,
        prepared_audio_identity: /^[a-f0-9]{64}$/u.test(value.method?.prepared_audio_identity ?? '') ? value.method.prepared_audio_identity : null,
        preparation_manifest_identity: /^[a-f0-9]{64}$/u.test(value.method?.preparation_manifest_identity ?? '') ? value.method.preparation_manifest_identity : null,
        preparation_settings_identity: /^[a-f0-9]{64}$/u.test(value.method?.preparation_settings_identity ?? '') ? value.method.preparation_settings_identity : null,
        registration_identity: /^[a-f0-9]{64}$/u.test(value.method?.registration_identity ?? '') ? value.method.registration_identity : null,
        provider_receipt_identity: /^[a-f0-9]{64}$/u.test(value.method?.provider_receipt_identity ?? '') ? value.method.provider_receipt_identity : null,
        computation_identity: /^[a-f0-9]{64}$/u.test(value.method?.computation_identity ?? '') ? value.method.computation_identity : null,
        sample_zero_source_time_us: Number.isSafeInteger(value.method?.sample_zero_source_time_us) ? value.method.sample_zero_source_time_us : null
      } : {}),
      absolute_paths_included: false,
      environment_values_included: false
    },
    limitations: Array.isArray(value.limitations) ? value.limitations.map((item) => String(item).slice(0, 160)).slice(0, 100) : [],
    boundary: {
      body_included: false,
      absolute_paths_included: false,
      raw_process_output_included: false,
      external_send_performed: false,
      network_performed: false,
      runtime_setup_performed: false,
      model_download_performed: false,
      mcp_execution_performed: false,
      shell_used: false
    }
  };
}

function assertPublicResultBoundary(value, forbiddenValues) {
  const forbidden = forbiddenValues.filter(Boolean);
  const forbiddenPayloadKeys = new Set([
    'segments', 'raw_media', 'raw_audio', 'raw_frames', 'full_transcript',
    'process_stdout', 'process_stderr', 'base64', 'blob', 'payload'
  ]);
  const stack = [value];
  let inspectedNodes = 0;
  while (stack.length) {
    const current = stack.pop();
    inspectedNodes += 1;
    if (inspectedNodes > 100_000) {
      throw mediaReviewError('MEDIA_REVIEW_PUBLIC_BOUNDARY_VIOLATION', 'The public media review result is too complex to inspect safely.');
    }
    if (typeof current === 'string') {
      if (forbidden.some((secret) => current.includes(secret)) || current.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(current)) {
        throw mediaReviewError('MEDIA_REVIEW_PUBLIC_BOUNDARY_VIOLATION', 'The public media review result contains a private path.');
      }
    } else if (Buffer.isBuffer(current) || ArrayBuffer.isView(current) || current instanceof ArrayBuffer) {
      throw mediaReviewError('MEDIA_REVIEW_PUBLIC_BOUNDARY_VIOLATION', 'The public media review result contains a binary payload.');
    } else if (Array.isArray(current)) {
      stack.push(...current);
    } else if (current && typeof current === 'object') {
      for (const [key, child] of Object.entries(current)) {
        if (forbiddenPayloadKeys.has(key) || key.endsWith('_base64')) {
          throw mediaReviewError('MEDIA_REVIEW_PUBLIC_BOUNDARY_VIOLATION', 'The public media review result contains a forbidden payload field.');
        }
        stack.push(child);
      }
    }
  }
}

function assertPublicResultSchema(result) {
  const validation = validateJsonSchemaSubset(result, getSchema('media_review_result'), {
    externalSchemas: {
      'media-source-decision.schema.json': getSchema('media_source_decision'),
      'media-analysis.schema.json': getSchema('media_analysis'),
      'media-timeline.schema.json': getSchema('media_timeline'),
      'transcript-provider.schema.json': getSchema('transcript_provider')
    }
  });
  if (!validation.ok) {
    throw mediaReviewError('MEDIA_REVIEW_PUBLIC_SCHEMA_INVALID', 'The public media review result does not satisfy its versioned contract.');
  }
}

function normalizeRetention(value, policy) {
  if (value === undefined || value === null) return policy.retention.default_mode;
  if (policy.retention.allowed_modes.includes(value)) return value;
  throw mediaReviewError('MEDIA_REVIEW_RETENTION_INVALID', 'The media review retention mode is invalid.');
}

function hashPlan(plan) {
  return createHash('sha256').update(stableJson(plan)).digest('hex');
}

function trustedPlanResult(value) {
  const plan = structuredClone(value);
  const planHash = plan?.plan_hash;
  if (typeof planHash !== 'string' || !/^[a-f0-9]{64}$/u.test(planHash)) {
    throw mediaReviewError('MEDIA_REVIEW_ACCEPTED_PLAN_INVALID', 'The accepted media review plan is invalid.');
  }
  delete plan.plan_hash;
  if (hashPlan(plan) !== planHash || plan.executable !== true || plan.boundary?.read_only !== true) {
    throw mediaReviewError('MEDIA_REVIEW_ACCEPTED_PLAN_INVALID', 'The accepted media review plan is invalid.');
  }
  return { status: 'ok', data: { plan: { ...plan, plan_hash: planHash } }, warnings: [], errors: [], artifacts: [] };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function safeExtension(file) {
  const extension = path.extname(file).toLowerCase();
  if (!/^\.[a-z0-9]{1,8}$/u.test(extension)) throw mediaReviewError('MEDIA_REVIEW_EXTENSION_INVALID', 'The media file extension is invalid.');
  return extension;
}

function publicIdentity(identity) {
  return { sha256: identity.sha256, bytes: identity.bytes, format: identity.format };
}

function nowIso(now) {
  const value = typeof now === 'function' ? now() : now;
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : new Date().toISOString();
}

function failure(code, message, details) {
  return { status: 'error', data: { media_review: { completed: false, boundary: { failure_treated_as_success: false } } }, warnings: [], errors: [{ code, message, details }], artifacts: [] };
}

function safeErrorCode(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_]{2,100}$/u.test(error.code) ? error.code : 'MEDIA_REVIEW_FAILED';
}

function mediaReviewError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
