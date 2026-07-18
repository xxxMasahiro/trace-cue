import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import {
  cleanupPrivateMediaOperation,
  createPrivateMediaOperation,
  findPrivateMediaOperation,
  reconcilePrivateMediaOperations
} from './media-private-operation.js';
import { loadMediaReviewPolicy } from './media-review-policy.js';
import { inspectStableMediaFile } from './media-stable-file.js';
import { createControlCenterMediaReviewStore } from './control-center-media-review-store.js';
import {
  cleanupMediaReview,
  executeMediaReview,
  inspectMediaReviewReadiness,
  inspectMediaReviewSource,
  MEDIA_REVIEW_CLEANUP_CONFIRMATION,
  MEDIA_REVIEW_EXECUTION_CONFIRMATION,
  MEDIA_REVIEW_RIGHTS_CONFIRMATION,
  planMediaReview
} from './media-review-service.js';

const CONTROL_CENTER_MEDIA_SCHEMA_VERSION = '1.0.0';
const SOURCE_ID = /^[a-f0-9]{32}$/u;
const OPERATION_ID = /^[a-f0-9]{32}$/u;

export async function createControlCenterMediaReviewRuntime(config = {}, context = {}) {
  const cwd = path.resolve(config.cwd ?? context.cwd ?? process.cwd());
  const artifactRoot = config.artifactRoot;
  const policy = await loadMediaReviewPolicy(context);
  const cleanupPrivate = context.cleanupPrivateMediaOperation ?? cleanupPrivateMediaOperation;
  const sources = new Map();
  const operations = new Map();
  const operationStore = createControlCenterMediaReviewStore(runtimeContext());
  let disposed = false;
  let readiness = uninspectedReadiness(policy);
  let pendingUploads = 0;
  let startAdmissionTail = Promise.resolve();

  function runtimeContext(overrides = {}) {
    return {
      ...context,
      cwd,
      artifactRoot,
      ...overrides
    };
  }

  const reconciliation = await reconcilePrivateMediaOperations(runtimeContext());
  const reconciliationByOperation = new Map(
    reconciliation.records
      .filter((record) => OPERATION_ID.test(record.operation_id ?? ''))
      .map((record) => [record.operation_id, record])
  );
  for (const saved of await operationStore.load()) {
    const projection = saved.operation;
    let privatePayloadRetained = projection.private_payload_retained === true
      || (projection.private_payload_retained === undefined
        && projection.retention === 'project-retained'
        && ['completed_retained', 'failed', 'cancelled', 'interrupted', 'cleanup_required'].includes(projection.state));
    let privateCleanupRecovered = false;
    const reconciliationRecord = reconciliationByOperation.get(projection.operation_id);
    if (privatePayloadRetained && ['cleaned', 'already_cleaned'].includes(reconciliationRecord?.cleanup_receipt?.status)) {
      privatePayloadRetained = false;
      privateCleanupRecovered = true;
    } else if (privatePayloadRetained && !reconciliationRecord) {
      try {
        await findPrivateMediaOperation(projection.operation_id, projection.retention, runtimeContext());
      } catch (error) {
        if (error?.code === 'MEDIA_PRIVATE_OPERATION_NOT_FOUND') {
          // Covers a crash after private deletion but before the public
          // operation projection was durably updated.
          privatePayloadRetained = false;
          privateCleanupRecovered = true;
        }
      }
    }
    const recoveredCompletion = activeState(projection.state) && saved.result !== null;
    const missingPublishedResult = ['completed', 'completed_retained'].includes(projection.state) && saved.result === null;
    const interrupted = (activeState(projection.state) && !recoveredCompletion) || missingPublishedResult;
    const recoveredState = privateCleanupRecovered
      ? 'cleaned'
      : recoveredCompletion
      ? (projection.retention === 'project-retained' ? 'completed_retained' : 'completed')
      : interrupted ? 'interrupted' : projection.state;
    const record = {
      operationId: projection.operation_id,
      sourceId: null,
      retention: projection.retention,
      state: recoveredState,
      progress: privateCleanupRecovered
        ? { phase: 'cleaned', percent: 100 }
        : recoveredCompletion
        ? { phase: 'completed', percent: 100 }
        : interrupted ? { phase: 'interrupted', percent: projection.progress?.percent ?? null } : projection.progress,
      createdAt: projection.created_at,
      updatedAt: (interrupted || privateCleanupRecovered) ? nowIso(context.now) : projection.updated_at,
      result: saved.result,
      errors: interrupted
        ? [{ code: 'CONTROL_CENTER_MEDIA_REVIEW_INTERRUPTED', message: 'The previous local video review stopped when the Control Center closed.', details: {} }]
        : projection.errors ?? [],
      artifacts: [],
      abortController: new AbortController(),
      promise: null,
      privateOperation: null,
      privatePayloadRetained,
      persistence: Promise.resolve()
    };
    operations.set(record.operationId, record);
    if (interrupted || recoveredCompletion || privateCleanupRecovered) await operationStore.writeOperation(projectOperation(record));
  }
  await pruneHistory();

  async function inspectReadiness({ refresh = false } = {}) {
    if (refresh) {
      const inspected = await (context.inspectMediaReviewReadiness ?? inspectMediaReviewReadiness)({}, runtimeContext());
      readiness = publicReadiness(inspected, policy);
    }
    return readiness;
  }

  async function sourceDecision(input = {}) {
    return (context.inspectMediaReviewSource ?? inspectMediaReviewSource)({
      url: input.url,
      rightsDeclared: false
    }, runtimeContext());
  }

  async function stageUpload(metadata, stream) {
    if (disposed) return failure('CONTROL_CENTER_MEDIA_RUNTIME_CLOSED', 'Media review is unavailable.');
    await pruneExpiredSources();
    const declared = Number(metadata.contentLength);
    if (!Number.isSafeInteger(declared) || declared <= 0 || declared > policy.source.maximum_local_media_bytes) {
      return failure('CONTROL_CENTER_MEDIA_UPLOAD_LENGTH_INVALID', 'Choose a video within the local size limit.', { maximum_bytes: policy.source.maximum_local_media_bytes });
    }
    const extension = safeUploadExtension(metadata.originalName, policy.source.allowed_local_extensions);
    if (!extension) return failure('CONTROL_CENTER_MEDIA_UPLOAD_TYPE_INVALID', 'Choose a supported local video file.');
    const contentType = String(metadata.contentType ?? '').toLowerCase().split(';', 1)[0].trim();
    if (contentType !== 'application/octet-stream' && !contentType.startsWith('video/')) {
      return failure('CONTROL_CENTER_MEDIA_UPLOAD_CONTENT_TYPE_INVALID', 'Choose a supported local video file.');
    }
    if (String(metadata.contentEncoding ?? '').trim()) return failure('CONTROL_CENTER_MEDIA_UPLOAD_ENCODING_REJECTED', 'Compressed request bodies are not accepted.');
    if (sources.size + pendingUploads >= policy.operation.maximum_active_operations * 2) {
      return failure('CONTROL_CENTER_MEDIA_SOURCE_LIMIT', 'Too many local media files are already prepared.');
    }
    pendingUploads += 1;
    let operation;
    let handle;
    let complete = false;
    const sourceId = randomBytes(16).toString('hex');
    try {
      operation = await createPrivateMediaOperation({ operationId: sourceId, retention: 'ephemeral' }, context);
      const inputDirectory = path.join(operation.root, 'input');
      await mkdir(inputDirectory, { mode: 0o700 });
      const target = path.join(inputDirectory, `source${extension}`);
      handle = await open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
      let bytes = 0;
      const timer = setTimeout(() => stream.destroy?.(), policy.source.upload_timeout_ms);
      try {
        for await (const incoming of stream) {
          const chunk = Buffer.isBuffer(incoming) ? incoming : Buffer.from(incoming);
          bytes += chunk.length;
          if (bytes > declared || bytes > policy.source.maximum_local_media_bytes) {
            throw runtimeError('CONTROL_CENTER_MEDIA_UPLOAD_TOO_LARGE', 'The local video exceeded its declared size.');
          }
          let offset = 0;
          while (offset < chunk.length) {
            const written = await handle.write(chunk, offset, chunk.length - offset);
            if (written.bytesWritten <= 0) throw runtimeError('CONTROL_CENTER_MEDIA_UPLOAD_INCOMPLETE', 'The local video could not be stored completely.');
            offset += written.bytesWritten;
          }
        }
      } finally {
        clearTimeout(timer);
      }
      if (bytes !== declared || stream.complete === false) throw runtimeError('CONTROL_CENTER_MEDIA_UPLOAD_INCOMPLETE', 'The local video was not received completely.');
      await handle.sync();
      await handle.close();
      handle = null;
      await chmod(target, 0o600);
      const identity = await inspectStableMediaFile(target, {
        maxBytes: policy.source.maximum_local_media_bytes,
        requirePrivate: true,
        extension
      });
      const expiresAt = operation.marker.expires_at;
      const source = { sourceId, operation, path: target, identity, extension, expiresAt, state: 'staged', expiryTimer: null };
      sources.set(sourceId, source);
      scheduleSourceExpiry(source);
      complete = true;
      return success({
        media_source: {
          schema_version: CONTROL_CENTER_MEDIA_SCHEMA_VERSION,
          type: 'control_center_media_source',
          source_id: sourceId,
          state: 'staged',
          bytes: identity.bytes,
          media_identity: { sha256: identity.sha256, bytes: identity.bytes, format: identity.format },
          format: identity.format,
          expires_at: expiresAt,
          boundary: sourceBoundary()
        }
      });
    } catch (error) {
      return failure(safeErrorCode(error), 'The local video could not be prepared safely.');
    } finally {
      pendingUploads -= 1;
      try { await handle?.close(); } catch {}
      if (!complete && operation) {
        try {
          const receipt = await cleanupPrivate(operation, { reason: 'media_upload_failed', allowLive: true }, context);
          if (!['cleaned', 'already_cleaned'].includes(receipt.status)) throw runtimeError('CONTROL_CENTER_MEDIA_SOURCE_CLEANUP_FAILED', 'The failed upload cleanup was refused.');
        } catch {
          const source = {
            sourceId, operation, path: null, identity: null, extension,
            expiresAt: operation.marker.expires_at, state: 'cleanup_required', expiryTimer: null
          };
          sources.set(sourceId, source);
          scheduleSourceCleanupRetry(source);
        }
      }
    }
  }

  async function start(input = {}) {
    const previous = startAdmissionTail;
    let release;
    startAdmissionTail = new Promise((resolve) => { release = resolve; });
    await previous.catch(() => {});
    try {
      return await startUnlocked(input);
    } finally {
      release();
    }
  }

  async function startUnlocked(input = {}) {
    if (disposed) return failure('CONTROL_CENTER_MEDIA_RUNTIME_CLOSED', 'Media review is unavailable.');
    await pruneExpiredSources();
    await pruneHistory({ reserve: 1 });
    if (!SOURCE_ID.test(input.source_id ?? '')) return failure('CONTROL_CENTER_MEDIA_SOURCE_ID_INVALID', 'Choose the local video again.');
    if (input.operation_id !== undefined && !OPERATION_ID.test(input.operation_id)) {
      return failure('CONTROL_CENTER_MEDIA_OPERATION_ID_INVALID', 'The media review request id is invalid.');
    }
    if (input.rights_declared !== true || input.rights_confirm !== MEDIA_REVIEW_RIGHTS_CONFIRMATION) {
      return failure('CONTROL_CENTER_MEDIA_RIGHTS_CONFIRMATION_REQUIRED', 'Confirm that you own or are authorized to review this video.');
    }
    if (input.confirm !== MEDIA_REVIEW_EXECUTION_CONFIRMATION) return failure('CONTROL_CENTER_MEDIA_EXECUTION_CONFIRMATION_REQUIRED', 'Confirm this local media review.');
    const requestedOperationId = input.operation_id ?? randomBytes(16).toString('hex');
    const existing = operations.get(requestedOperationId);
    if (existing) {
      if (existing.sourceId !== null && existing.sourceId !== input.source_id) {
        return failure('CONTROL_CENTER_MEDIA_OPERATION_CONFLICT', 'This media review request id is already in use.');
      }
      return success({ media_review: projectOperation(existing) });
    }
    const source = sources.get(input.source_id);
    if (!source || source.state !== 'staged') return failure('CONTROL_CENTER_MEDIA_SOURCE_UNAVAILABLE', 'The prepared local video is no longer available.');
    if (input.retention !== undefined && !policy.retention.allowed_modes.includes(input.retention)) {
      return failure('CONTROL_CENTER_MEDIA_RETENTION_INVALID', 'Choose a supported private-data retention option.');
    }
    const retention = input.retention ?? policy.retention.default_mode;
    if (operations.size >= policy.operation.maximum_history_operations) {
      return failure('CONTROL_CENTER_MEDIA_HISTORY_LIMIT', 'Clean up a previous private video review before starting another one.');
    }
    if ([...operations.values()].filter((record) => activeState(record.state)).length >= policy.operation.maximum_active_operations) {
      return failure('CONTROL_CENTER_MEDIA_OPERATION_LIMIT', 'Too many media reviews are currently running.');
    }
    const stable = await inspectStableMediaFile(source.path, { maxBytes: policy.source.maximum_local_media_bytes, requirePrivate: true, extension: source.extension });
    if (stable.sha256 !== source.identity.sha256 || stable.bytes !== source.identity.bytes) {
      return failure('CONTROL_CENTER_MEDIA_SOURCE_CHANGED', 'The prepared local video changed. Choose it again.');
    }
    const serviceContext = runtimeContext({ mediaInputRoot: source.operation.root });
    const options = { input: source.path, rightsDeclared: true, retention, artifactRoot };
    const planned = await (context.planMediaReview ?? planMediaReview)(options, serviceContext);
    if (planned.status !== 'ok' || planned.data?.plan?.executable !== true) return planned;
    const operationId = requestedOperationId;
    const abortController = new AbortController();
    const record = {
      operationId,
      sourceId: source.sourceId,
      retention,
      state: 'prepared',
      progress: { phase: 'queued', percent: 0 },
      createdAt: nowIso(context.now),
      updatedAt: nowIso(context.now),
      result: null,
      errors: [],
      artifacts: [],
      abortController,
      promise: null,
      privateOperation: null,
      privatePayloadRetained: false,
      persistence: Promise.resolve()
    };
    operations.set(operationId, record);
    try {
      await operationStore.writeOperation(projectOperation(record));
    } catch (error) {
      operations.delete(operationId);
      return failure(safeErrorCode(error), 'The media review could not be recorded safely.');
    }
    source.state = 'consumed';
    const executionContext = runtimeContext({
      mediaInputRoot: source.operation.root,
      acceptedMediaReviewPlan: planned.data.plan,
      onPrivateMediaOperation: (operation) => {
        record.privateOperation = operation;
        record.privatePayloadRetained = true;
      },
      onMediaReviewProgress: (progress) => {
        record.state = progress.phase === 'cancelled' ? 'cancelled' : progress.phase === 'failed' ? 'failed' : progress.phase === 'completed' ? 'completed' : 'running';
        record.progress = { phase: progress.phase, percent: progress.percent };
        record.updatedAt = nowIso(context.now);
        queueRecordPersistence(record);
      }
    });
    record.promise = Promise.resolve().then(async () => {
      const completed = await (context.executeMediaReview ?? executeMediaReview)({
        ...options,
        operationId,
        execute: true,
        confirm: MEDIA_REVIEW_EXECUTION_CONFIRMATION,
        planHash: planned.data.plan.plan_hash,
        signal: abortController.signal
      }, executionContext);
      if (completed.status === 'ok') {
        record.privatePayloadRetained = typeof completed.data.operation?.cleanup_available === 'boolean'
          ? completed.data.operation.cleanup_available
          : retention === 'project-retained';
        await operationStore.writeResult(operationId, completed.data.result);
        record.state = completed.data.operation?.state ?? (retention === 'project-retained' ? 'completed_retained' : 'completed');
        record.progress = { phase: 'completed', percent: 100 };
        record.result = completed.data.result;
        record.artifacts = completed.artifacts;
      } else {
        record.state = abortController.signal.aborted ? 'cancelled' : 'failed';
        record.progress = { phase: record.state, percent: null };
        record.errors = completed.errors ?? [];
        const cleanupStatus = completed.errors?.[0]?.details?.cleanup_status;
        record.privatePayloadRetained = cleanupStatus !== 'cleaned'
          && (record.privateOperation !== null || (cleanupStatus === undefined && retention === 'project-retained'));
      }
      record.updatedAt = nowIso(context.now);
      await settleRecordPersistence(record);
      await operationStore.writeOperation(projectOperation(record));
      clearTimeout(source.expiryTimer);
      try {
        const receipt = await cleanupPrivate(source.operation, { reason: 'consumed_media_upload' }, context);
        if (['cleaned', 'already_cleaned'].includes(receipt.status)) sources.delete(source.sourceId);
        else { source.state = 'cleanup_required'; scheduleSourceCleanupRetry(source); }
      } catch {
        source.state = 'cleanup_required';
        scheduleSourceCleanupRetry(source);
      }
      await pruneHistory();
      return completed;
    }).catch(async (error) => {
      record.state = abortController.signal.aborted ? 'cancelled' : 'failed';
      record.progress = { phase: record.state, percent: null };
      record.errors = [{ code: safeErrorCode(error), message: 'The local media review could not be completed.', details: {} }];
      // Preserve the service's authoritative cleanup state. A successful
      // ephemeral run may already have removed its private root before a
      // later public-result persistence failure reaches this branch.
      record.privatePayloadRetained = record.privatePayloadRetained === true;
      record.updatedAt = nowIso(context.now);
      await operationStore.writeOperation(projectOperation(record)).catch(() => {});
      clearTimeout(source.expiryTimer);
      try {
        const receipt = await cleanupPrivate(source.operation, { reason: 'failed_media_upload_consumption' }, context);
        if (['cleaned', 'already_cleaned'].includes(receipt.status)) sources.delete(source.sourceId);
        else { source.state = 'cleanup_required'; scheduleSourceCleanupRetry(source); }
      } catch {
        source.state = 'cleanup_required';
        scheduleSourceCleanupRetry(source);
      }
    });
    return success({ media_review: projectOperation(record) });
  }

  function status(input = {}) {
    const record = operationRecord(input.operation_id);
    return record ? success({ media_review: projectOperation(record) }) : failure('CONTROL_CENTER_MEDIA_OPERATION_NOT_FOUND', 'The media review was not found.');
  }

  function list() {
    return success({ media_reviews: [...operations.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, policy.operation.maximum_history_operations).map(projectOperation) });
  }

  function result(input = {}) {
    const record = operationRecord(input.operation_id);
    if (!record) return failure('CONTROL_CENTER_MEDIA_OPERATION_NOT_FOUND', 'The media review was not found.');
    if (!record.result) return failure('CONTROL_CENTER_MEDIA_RESULT_NOT_READY', 'The media review result is not ready.');
    return success({ media_review_result: record.result });
  }

  function cancel(input = {}) {
    const record = operationRecord(input.operation_id);
    if (!record) return failure('CONTROL_CENTER_MEDIA_OPERATION_NOT_FOUND', 'The media review was not found.');
    if (!activeState(record.state)) return failure('CONTROL_CENTER_MEDIA_CANCEL_UNAVAILABLE', 'This media review is not running.');
    record.state = 'cancelling';
    record.progress = { phase: 'cancelling', percent: record.progress.percent };
    record.updatedAt = nowIso(context.now);
    record.abortController.abort(new Error('media review cancelled'));
    queueRecordPersistence(record);
    return success({ media_review: projectOperation(record) });
  }

  async function cleanup(input = {}) {
    const record = operationRecord(input.operation_id);
    if (!record) return failure('CONTROL_CENTER_MEDIA_OPERATION_NOT_FOUND', 'The media review was not found.');
    if (input.retention !== undefined && input.retention !== record.retention) {
      return failure('CONTROL_CENTER_MEDIA_RETENTION_MISMATCH', 'The cleanup retention does not match this media review.');
    }
    if (record.state === 'cleaned') return success({ cleanup_receipt: alreadyCleanedReceipt(record) });
    if (!cleanupCapable(record)) return failure('CONTROL_CENTER_MEDIA_CLEANUP_UNAVAILABLE', 'Private cleanup is not available for this media review.');
    const retention = record.retention;
    const cleaned = await (context.cleanupMediaReview ?? cleanupMediaReview)({
      operationId: input.operation_id,
      retention,
      execute: true,
      confirm: MEDIA_REVIEW_CLEANUP_CONFIRMATION
    }, runtimeContext());
    if (cleaned.status === 'ok') {
      record.state = 'cleaned';
      record.privatePayloadRetained = false;
      record.updatedAt = nowIso(context.now);
      await operationStore.writeOperation(projectOperation(record));
    }
    return cleaned;
  }

  async function discardSource(input = {}) {
    if (!SOURCE_ID.test(input.source_id ?? '')) return failure('CONTROL_CENTER_MEDIA_SOURCE_ID_INVALID', 'The prepared local video was not found.');
    const source = sources.get(input.source_id);
    if (!source || !['staged', 'cleanup_required'].includes(source.state)) return failure('CONTROL_CENTER_MEDIA_SOURCE_UNAVAILABLE', 'The prepared local video is no longer available.');
    source.state = 'discarding';
    clearTimeout(source.expiryTimer);
    try {
      const receipt = await cleanupPrivate(source.operation, { reason: 'discarded_media_upload', allowLive: true }, context);
      if (!['cleaned', 'already_cleaned'].includes(receipt.status)) {
        source.state = 'cleanup_required';
        scheduleSourceCleanupRetry(source);
        return failure('CONTROL_CENTER_MEDIA_SOURCE_CLEANUP_FAILED', 'The prepared local video could not be removed safely.');
      }
      sources.delete(source.sourceId);
      return success({ cleanup_receipt: receipt });
    } catch {
      source.state = 'cleanup_required';
      scheduleSourceCleanupRetry(source);
      return failure('CONTROL_CENTER_MEDIA_SOURCE_CLEANUP_FAILED', 'The prepared local video could not be removed safely.');
    }
  }

  async function dispose() {
    disposed = true;
    for (const record of operations.values()) if (activeState(record.state)) record.abortController.abort(new Error('control center closed'));
    await Promise.allSettled([...operations.values()].map((record) => record.promise).filter(Boolean));
    await Promise.allSettled([...operations.values()].map((record) => record.persistence).filter(Boolean));
    for (const source of sources.values()) clearTimeout(source.expiryTimer);
    await Promise.allSettled([...sources.values()].map((source) => cleanupPrivate(source.operation, { reason: 'control_center_closed', allowLive: true }, context)));
    sources.clear();
  }

  function operationRecord(id) {
    return OPERATION_ID.test(id ?? '') ? operations.get(id) ?? null : null;
  }

  function queueRecordPersistence(record) {
    record.persistence = Promise.resolve(record.persistence)
      .then(() => operationStore.writeOperation(projectOperation(record)))
      .catch(() => {});
  }

  async function settleRecordPersistence(record) {
    await Promise.resolve(record.persistence).catch(() => {});
  }

  async function pruneHistory({ reserve = 0 } = {}) {
    const terminal = [...operations.values()]
      .filter((record) => safelyPrunable(record))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const excess = Math.max(0, operations.size + reserve - policy.operation.maximum_history_operations);
    if (excess === 0) return;
    for (const record of terminal.slice(-excess)) {
      operations.delete(record.operationId);
      await operationStore.removeOperation(record.operationId);
    }
  }

  async function pruneExpiredSources() {
    const now = Date.parse(nowIso(context.now));
    for (const source of [...sources.values()]) {
      if (source.state !== 'cleanup_required' && (source.state !== 'staged' || Date.parse(source.expiresAt) > now)) continue;
      clearTimeout(source.expiryTimer);
      source.state = 'discarding';
      try {
        const receipt = await cleanupPrivate(source.operation, { reason: 'expired_media_upload', allowLive: true }, context);
        if (['cleaned', 'already_cleaned'].includes(receipt.status)) sources.delete(source.sourceId);
        else { source.state = 'cleanup_required'; scheduleSourceCleanupRetry(source); }
      } catch {
        source.state = 'cleanup_required';
        scheduleSourceCleanupRetry(source);
      }
    }
  }

  function scheduleSourceExpiry(source) {
    clearTimeout(source.expiryTimer);
    const delay = Math.max(0, Math.min(2_147_000_000, Date.parse(source.expiresAt) - Date.now()));
    source.expiryTimer = setTimeout(() => { pruneExpiredSources().catch(() => {}); }, delay);
    source.expiryTimer.unref?.();
  }

  function scheduleSourceCleanupRetry(source) {
    clearTimeout(source.expiryTimer);
    source.expiryTimer = setTimeout(() => { pruneExpiredSources().catch(() => {}); }, policy.operation.cleanup_retry_delay_ms);
    source.expiryTimer.unref?.();
  }

  return Object.freeze({
    inspectReadiness,
    sourceDecision,
    stageUpload,
    start,
    status,
    list,
    result,
    cancel,
    cleanup,
    discardSource,
    dispose
  });
}

function projectOperation(record) {
  return {
    schema_version: CONTROL_CENTER_MEDIA_SCHEMA_VERSION,
    type: 'media_review_operation',
    operation_id: record.operationId,
    state: record.state,
    retention: record.retention,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    progress: record.progress,
    capabilities: {
      status: true,
      cancel: activeState(record.state),
      cleanup: cleanupCapable(record),
      result: Boolean(record.result)
    },
    result_available: Boolean(record.result),
    cleanup_available: cleanupCapable(record),
    private_payload_retained: record.privatePayloadRetained === true,
    errors: record.errors.map((error) => ({ code: error.code ?? 'MEDIA_REVIEW_FAILED', message: error.message ?? 'Media review failed.', details: {} })),
    boundary: {
      absolute_path_included: false,
      private_locator_included: false,
      source_name_included: false,
      raw_media_included: false,
      full_transcript_included: false
    }
  };
}

function safeUploadExtension(originalName, allowed) {
  let decoded;
  try { decoded = decodeURIComponent(String(originalName ?? '')); } catch { return null; }
  const extension = path.extname(decoded).toLowerCase();
  return allowed.includes(extension) ? extension : null;
}

function sourceBoundary() {
  return {
    absolute_path_included: false,
    original_name_included: false,
    raw_media_included: false,
    private_locator_included: false,
    external_send_performed: false,
    network_performed: false
  };
}

function activeState(value) {
  return ['prepared', 'running', 'cancelling'].includes(value);
}

function cleanupCapable(record) {
  return record.privatePayloadRetained === true
    && ['completed', 'completed_retained', 'failed', 'cancelled', 'interrupted', 'cleanup_required'].includes(record.state);
}

function safelyPrunable(record) {
  return record.state === 'cleaned' || (!activeState(record.state) && record.privatePayloadRetained !== true);
}

function alreadyCleanedReceipt(record) {
  return {
    schema_version: CONTROL_CENTER_MEDIA_SCHEMA_VERSION,
    type: 'media_cleanup_receipt',
    operation_id: record.operationId,
    status: 'already_cleaned',
    retention: record.retention,
    reason: 'idempotent_control_center_cleanup',
    completed_at: record.updatedAt,
    deleted: { file_count: 0, directory_count: 0, byte_count: 0 },
    identity: null,
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

function uninspectedReadiness(policy) {
  return success({
    readiness: {
      schema_version: CONTROL_CENTER_MEDIA_SCHEMA_VERSION,
      type: 'media_review_readiness',
      status: 'uninspected',
      transcript_provider: { status: 'uninspected', limitations: ['explicit_readiness_check_required'] },
      technical_analyzer: { status: 'uninspected', limitations: ['explicit_readiness_check_required'] },
      local_input: publicLocalInput(policy),
      boundary: readinessBoundary()
    }
  });
}

function publicReadiness(result, policy) {
  const value = result?.data?.readiness ?? {};
  const projectComponent = (component) => ({
    status: ['ready', 'setup_required', 'unavailable', 'unsupported'].includes(component?.status) ? component.status : 'unavailable',
    limitations: Array.isArray(component?.limitations)
      ? component.limitations.filter((item) => typeof item === 'string').slice(0, 20).map((item) => item.slice(0, 160))
      : []
  });
  return success({
    readiness: {
      schema_version: CONTROL_CENTER_MEDIA_SCHEMA_VERSION,
      type: 'media_review_readiness',
      status: value.status === 'ready'
        ? 'ready'
        : [value.transcript_provider, value.technical_analyzer].some((component) => component?.status === 'unsupported')
          ? 'unsupported'
          : 'unavailable',
      transcript_provider: projectComponent(value.transcript_provider),
      technical_analyzer: projectComponent(value.technical_analyzer),
      local_input: publicLocalInput(policy),
      boundary: readinessBoundary()
    }
  });
}

function publicLocalInput(policy) {
  return {
    accepted_extensions: [...policy.source.allowed_local_extensions],
    maximum_bytes: policy.source.maximum_local_media_bytes
  };
}

function readinessBoundary() {
  return {
    read_only: true,
    provider_transcription_performed: false,
    media_analysis_performed: false,
    network_performed: false,
    setup_performed: false,
    mcp_execution_performed: false,
    secrets_included: false,
    executable_paths_included: false,
    provider_revision_included: false,
    configuration_hashes_included: false
  };
}

function nowIso(now) {
  const value = typeof now === 'function' ? now() : now;
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : new Date().toISOString();
}

function success(data) {
  return { status: 'ok', data, warnings: [], errors: [], artifacts: [] };
}

function failure(code, message, details = {}) {
  return { status: 'error', data: { media_review: { available: false } }, warnings: [], errors: [{ code, message, details }], artifacts: [] };
}

function safeErrorCode(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_]{2,100}$/u.test(error.code) ? error.code : 'CONTROL_CENTER_MEDIA_REVIEW_FAILED';
}

function runtimeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
