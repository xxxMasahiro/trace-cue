import path from 'node:path';
import { createSafeLocalStore } from './safe-local-store.js';

const STORE_DIRECTORY = 'control-center-media-review/state';
const STORE_NAMESPACE = 'control-center-media-review';
const OPERATION_ID = /^[a-f0-9]{32}$/u;
const MAX_OPERATION_BYTES = 128 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_OPERATIONS = 100;

export function createControlCenterMediaReviewStore(context = {}) {
  const store = typeof context.createControlCenterMediaReviewStore === 'function'
    ? context.createControlCenterMediaReviewStore(storeConfig(context))
    : createSafeLocalStore(storeConfig(context));

  async function load() {
    let directories;
    try {
      directories = await store.listDirectories({ limit: MAX_OPERATIONS + 1 });
    } catch (error) {
      if (['ENOENT', 'SAFE_STORE_MARKER_MISSING'].includes(error?.code)) return [];
      throw error;
    }
    if (directories.length > MAX_OPERATIONS) throw mediaStoreError('CONTROL_CENTER_MEDIA_HISTORY_LIMIT', 'Too many saved media review records exist.');
    const records = [];
    for (const directory of directories.sort()) {
      if (!OPERATION_ID.test(directory)) continue;
      let operation;
      try {
        operation = validateOperation(await store.readJson(`${directory}/operation.json`, { maxBytes: MAX_OPERATION_BYTES }));
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      let result = null;
      try {
        result = validateResult(await store.readJson(`${directory}/result.json`, { maxBytes: MAX_RESULT_BYTES }), directory);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      records.push({ operation, result });
    }
    return records;
  }

  async function writeOperation(operation) {
    const projection = validateOperation(structuredClone(operation));
    await store.writeJson(`${projection.operation_id}/operation.json`, projection, { maxBytes: MAX_OPERATION_BYTES });
    return projection;
  }

  async function writeResult(operationId, result) {
    if (!OPERATION_ID.test(operationId ?? '')) throw mediaStoreError('CONTROL_CENTER_MEDIA_OPERATION_ID_INVALID', 'The media review id is invalid.');
    const projection = validateResult(structuredClone(result), operationId);
    await store.writeJson(`${operationId}/result.json`, projection, { maxBytes: MAX_RESULT_BYTES });
    return projection;
  }

  async function removeOperation(operationId) {
    if (!OPERATION_ID.test(operationId ?? '')) throw mediaStoreError('CONTROL_CENTER_MEDIA_OPERATION_ID_INVALID', 'The media review id is invalid.');
    try {
      await store.removeDirectory(operationId, { maxEntries: 4 });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  return Object.freeze({ load, writeOperation, writeResult, removeOperation });
}

export function controlCenterMediaReviewStoreBoundary() {
  return {
    local_only: true,
    private_store: true,
    repository_tracked: false,
    raw_media_stored: false,
    raw_audio_stored: false,
    raw_frames_stored: false,
    full_transcript_stored: false,
    absolute_paths_stored: false,
    executable_paths_stored: false,
    provider_output_stored: false,
    automatic_replay_enabled: false,
    mcp_execution_exposed: false
  };
}

function validateOperation(value) {
  if (value?.schema_version !== '1.0.0'
    || value?.type !== 'media_review_operation'
    || !OPERATION_ID.test(value?.operation_id ?? '')
    || !['prepared', 'running', 'cancelling', 'cancelled', 'completed', 'completed_retained', 'failed', 'interrupted', 'cleanup_required', 'cleaned'].includes(value?.state)
    || !['ephemeral', 'project-retained'].includes(value?.retention)
    || value?.boundary?.absolute_path_included !== false
    || value?.boundary?.private_locator_included !== false
    || value?.boundary?.raw_media_included !== false
    || value?.boundary?.full_transcript_included !== false
    || !exactKeys(value, ['schema_version', 'type', 'operation_id', 'state', 'retention', 'created_at', 'updated_at', 'progress', 'capabilities', 'result_available', 'cleanup_available', 'private_payload_retained', 'errors', 'boundary'])
    || !validDateTime(value.created_at)
    || !validDateTime(value.updated_at)
    || !plainObject(value.progress)
    || typeof value.progress.phase !== 'string'
    || value.progress.phase.length > 80
    || !(value.progress.percent === null || (Number.isFinite(value.progress.percent) && value.progress.percent >= 0 && value.progress.percent <= 100))
    || !plainObject(value.capabilities)
    || !['status', 'cancel', 'cleanup', 'result'].every((key) => typeof value.capabilities[key] === 'boolean')
    || typeof value.result_available !== 'boolean'
    || typeof value.cleanup_available !== 'boolean'
    || (value.private_payload_retained !== undefined && typeof value.private_payload_retained !== 'boolean')
    || !Array.isArray(value.errors)
    || value.errors.length > 16
    || value.errors.some((error) => !validPublicError(error))
    || containsPrivatePath(value)) {
    throw mediaStoreError('CONTROL_CENTER_MEDIA_OPERATION_RECORD_INVALID', 'A saved media review record is invalid.');
  }
  return value;
}

function validateResult(value, operationId) {
  if (value?.schema_version !== '1.0.0'
    || value?.type !== 'media_review_result'
    || value?.operation_id !== operationId
    || !['completed', 'completed_with_limitations', 'insufficient'].includes(value?.status)
    || !/^[a-f0-9]{64}$/u.test(value?.media_identity?.sha256 ?? '')
    || !Number.isSafeInteger(value?.media_identity?.bytes)
    || value.media_identity.bytes <= 0
    || !plainObject(value?.transcript)
    || Object.hasOwn(value.transcript, 'segments')
    || value.transcript?.boundary?.body_included !== false
    || value.transcript?.boundary?.absolute_paths_included !== false
    || value.transcript?.boundary?.raw_process_output_included !== false
    || value.transcript?.boundary?.external_send_performed !== false
    || value?.technical_analysis?.boundary?.raw_media_included !== false
    || value?.technical_analysis?.boundary?.raw_audio_included !== false
    || value?.technical_analysis?.boundary?.raw_frames_included !== false
    || value?.technical_analysis?.boundary?.absolute_paths_included !== false
    || value?.timeline?.boundary?.full_transcript_included !== false
    || value?.timeline?.boundary?.raw_media_included !== false
    || !Array.isArray(value?.deterministic_findings)
    || !Array.isArray(value?.advisory_findings)
    || value.deterministic_findings.length > 200
    || value.advisory_findings.length > 200
    || value.deterministic_findings.some((finding) => finding?.classification !== 'deterministic_measurement')
    || value.advisory_findings.some((finding) => finding?.classification !== 'advisory_evaluation')
    || value?.privacy?.full_transcript_in_result !== false
    || value?.privacy?.raw_media_persisted_outside_private_root !== false
    || value?.privacy?.full_transcript_persisted_outside_private_root !== false
    || value?.privacy?.external_send_performed !== false
    || value?.boundary?.absolute_paths_included !== false
    || value?.boundary?.raw_media_included !== false
    || value?.boundary?.raw_audio_included !== false
    || value?.boundary?.raw_frames_included !== false
    || value?.boundary?.full_transcript_included !== false
    || value?.boundary?.raw_process_output_included !== false
    || value?.boundary?.external_send_enabled !== false
    || value?.boundary?.deterministic_and_advisory_separated !== true
    || containsForbiddenPayloadKey(value)
    || containsPrivatePath(value)) {
    throw mediaStoreError('CONTROL_CENTER_MEDIA_RESULT_RECORD_INVALID', 'A saved media review result is invalid.');
  }
  return value;
}

function validPublicError(value) {
  return plainObject(value)
    && typeof value.code === 'string'
    && /^[A-Z0-9_]{2,100}$/u.test(value.code)
    && typeof value.message === 'string'
    && value.message.length <= 500
    && !/[\u0000-\u001f\u007f]/u.test(value.message)
    && plainObject(value.details)
    && Object.keys(value.details).length === 0;
}

function containsForbiddenPayloadKey(value) {
  const forbidden = new Set(['segments', 'raw_media', 'raw_audio', 'raw_frames', 'full_transcript', 'process_stdout', 'process_stderr', 'base64', 'blob', 'payload']);
  const stack = [value];
  while (stack.length) {
    const current = stack.pop();
    if (Array.isArray(current)) stack.push(...current);
    else if (plainObject(current)) {
      for (const [key, child] of Object.entries(current)) {
        if (forbidden.has(key)) return true;
        stack.push(child);
      }
    }
  }
  return false;
}

function containsPrivatePath(value) {
  const stack = [value];
  while (stack.length) {
    const current = stack.pop();
    if (typeof current === 'string') {
      if (current.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(current) || /^\\\\/u.test(current) || /^file:/iu.test(current)) return true;
    } else if (Array.isArray(current)) stack.push(...current);
    else if (plainObject(current)) stack.push(...Object.values(current));
  }
  return false;
}

function validDateTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function exactKeys(value, allowed) {
  return plainObject(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function storeConfig(context) {
  const cwd = path.resolve(context.cwd ?? process.cwd());
  const artifactRoot = String(context.artifactRoot ?? context['artifact-root'] ?? '.browser-debug').trim() || '.browser-debug';
  if (path.isAbsolute(artifactRoot)) throw mediaStoreError('CONTROL_CENTER_MEDIA_STORE_ROOT_INVALID', 'Media review operation storage must stay in the workspace.');
  const relativeArtifactRoot = path.relative(cwd, path.resolve(cwd, artifactRoot));
  if (!relativeArtifactRoot || relativeArtifactRoot.startsWith('..') || path.isAbsolute(relativeArtifactRoot)) {
    throw mediaStoreError('CONTROL_CENTER_MEDIA_STORE_ROOT_INVALID', 'Media review operation storage must stay in the workspace.');
  }
  return {
    workspaceRoot: cwd,
    relativeRoot: path.join(relativeArtifactRoot, STORE_DIRECTORY),
    namespace: STORE_NAMESPACE,
    maxRecordBytes: MAX_RESULT_BYTES,
    maxEntries: MAX_OPERATIONS + 16
  };
}

function mediaStoreError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
