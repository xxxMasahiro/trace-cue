import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { runControlCenterSourceIntakeProposal } from './control-center-actions.js';
import { runImageReview } from './image-review.js';
import { runPlaywrightTestImport } from './playwright-test-import.js';
import {
  captureProcessIdentity,
  createSafeLocalStore,
  isProcessIdentityAlive,
  readDirectoryEntriesBounded,
  readStableBoundedFileHandle
} from './safe-local-store.js';
import { DEFAULT_ARTIFACT_ROOT } from './constants.js';

export const CONTROL_CENTER_INTAKE_KINDS = Object.freeze(['image', 'document_text', 'playwright_result']);
export const CONTROL_CENTER_INTAKE_TTL_MS = 24 * 60 * 60 * 1000;
export const CONTROL_CENTER_INTAKE_TOTAL_BYTES = 100 * 1024 * 1024;
export const CONTROL_CENTER_INTAKE_MAX_ENTRIES = 100;
export const CONTROL_CENTER_INTAKE_HISTORY_ENTRIES = 1000;
export const CONTROL_CENTER_INTAKE_ACTIVE_RESULT_ENTRIES = 1024;
export const CONTROL_CENTER_INTAKE_UPLOAD_ENDPOINT = '/api/review-intake/upload';
export const CONTROL_CENTER_INTAKE_COMPLETE_ENDPOINT = '/api/review-intake/complete';
export const CONTROL_CENTER_INTAKE_RESULTS_ENDPOINT = '/api/review-intake/results';
export const CONTROL_CENTER_INTAKE_RESULT_ENDPOINT = '/api/review-intake/result';

const INTAKE_DIRECTORY = 'control-center-intake';
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_COMPLETION_LOCK_TIMEOUT_MS = 30_000;
const MAX_COMPLETION_LOCK_TIMEOUT_MS = 120_000;
const RESERVATION_TTL_MS = 5 * 60 * 1000;
const MAX_RESERVATION_TTL_MS = 30 * 60 * 1000;
const RESERVATION_RENEW_INTERVAL_MS = 60 * 1000;
const MAX_RESERVATION_RENEW_INTERVAL_MS = 5 * 60 * 1000;
const ORPHAN_GRACE_MS = 60 * 60 * 1000;
const TEXT_MAX_BYTES = 2 * 1024 * 1024;
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 16384;
const MAX_IMAGE_PIXELS = 80_000_000;
const MAX_INTAKE_DIRECTORY_SCAN_ENTRIES = 4096;
const DEFAULT_HISTORY_MAINTENANCE_LOCK_TIMEOUT_MS = 100;
const MAX_HISTORY_MAINTENANCE_LOCK_TIMEOUT_MS = 1000;
const DEFAULT_RECOVERY_MAINTENANCE_LOCK_TIMEOUT_MS = 100;
const MAX_RECOVERY_MAINTENANCE_LOCK_TIMEOUT_MS = 1000;
const ID_PATTERN = /^[a-f0-9]{32}$/u;
const RECEIPT_PATTERN = /^([a-f0-9]{32})\.json$/u;
const RESERVATION_PATTERN = /^([a-f0-9]{32})\.json$/u;
const RESULT_PATTERN = /^([a-f0-9]{32})\.json$/u;
const PUBLICATION_RESERVATION_PATTERN = /^([a-f0-9]{32})\.json$/u;
const KIND_CONFIG = Object.freeze({
  image: {
    maxBytes: IMAGE_MAX_BYTES,
    extensions: ['.png', '.jpg', '.jpeg', '.gif', '.webp'],
    contentTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/octet-stream'],
    label: 'Selected image'
  },
  document_text: {
    maxBytes: TEXT_MAX_BYTES,
    extensions: ['.txt', '.md', '.markdown', '.json'],
    contentTypes: ['text/plain', 'text/markdown', 'application/json', 'application/octet-stream'],
    label: 'Selected document'
  },
  playwright_result: {
    maxBytes: TEXT_MAX_BYTES,
    extensions: ['.json', '.xml'],
    contentTypes: ['application/json', 'application/xml', 'text/xml', 'text/plain', 'application/octet-stream'],
    label: 'Selected test result'
  }
});
const INTAKE_HISTORY_RETENTION = new Map();

export async function stageControlCenterIntake(input = {}, stream, context = {}) {
  const validation = validateUploadInput(input);
  if (!validation.ok) return intakeError(validation.code, validation.message, validation.details);
  const { store, relativeRoot } = intakeStore(context);
  const limits = intakeLimits(context);
  const id = randomBytes(16).toString('hex');
  const extension = validation.value.extension === '.jpeg' ? '.jpg' : validation.value.extension;
  const temporaryRelative = `files/.${id}.${process.pid}.tmp`;
  const fileRelative = `files/${id}${extension}`;
  let reserved = false;
  let targetCreated = false;
  let committed = false;
  try {
    const reservationResult = await store.withLock('intake-quota', async () => {
      await cleanupIntakeStore(store, context, limits);
      const quota = await inspectQuota(store, context, limits);
      if (quota.count >= limits.maxEntries
        || quota.bytes + validation.value.contentLength > limits.totalBytes) {
        return false;
      }
      const now = materializeNow(context.now);
      await store.writeJson(`reservations/${id}.json`, {
        schema_version: '1.0.0',
        type: 'control_center_intake_reservation',
        id,
        requested_bytes: validation.value.contentLength,
        temporary_relative: temporaryRelative,
        owner: {
          pid: process.pid,
          process_identity: await captureProcessIdentity(process.pid)
        },
        created_at: now.toISOString(),
        expires_at: new Date(now.getTime() + RESERVATION_TTL_MS).toISOString()
      }, { maxBytes: 8 * 1024 });
      return true;
    });
    if (!reservationResult) {
      return intakeError('CONTROL_CENTER_INTAKE_QUOTA_EXCEEDED', 'Remove an older local intake before adding another file.', {});
    }
    reserved = true;
    const temporary = await store.resolvePrivatePath(temporaryRelative, { ensureParent: true });
    const target = await store.resolvePrivatePath(fileRelative, { ensureParent: true });
    const digest = createHash('sha256');
    const handle = await open(temporary, 'wx', 0o600);
    let total = 0;
    try {
      for await (const chunk of streamWithIdleTimeout(stream, context.intakeStreamTimeoutMs)) {
        total += chunk.length;
        if (total > validation.value.maxBytes || total > validation.value.contentLength) {
          throw intakeCodedError('CONTROL_CENTER_INTAKE_TOO_LARGE', 'The selected file is too large.');
        }
        digest.update(chunk);
        await handle.write(chunk);
      }
      if (total !== validation.value.contentLength || total === 0) {
        throw intakeCodedError('CONTROL_CENTER_INTAKE_LENGTH_MISMATCH', 'The selected file did not arrive completely.');
      }
      await handle.sync();
      await handle.close();
      const media = await validateStagedContent(temporary, validation.value.kind, extension, total);
      return await store.withLock('intake-quota', async () => {
        const reservation = await store.readJson(`reservations/${id}.json`, { maxBytes: 8 * 1024 });
        if (reservation?.id !== id || reservation?.requested_bytes !== validation.value.contentLength) {
          throw intakeCodedError('CONTROL_CENTER_INTAKE_RESERVATION_LOST', 'The local file reservation is no longer valid.');
        }
        await rename(temporary, target);
        targetCreated = true;
        await chmod(target, 0o600);
        const now = materializeNow(context.now);
        const receipt = {
          schema_version: '1.1.0',
          type: 'control_center_intake_receipt',
          id,
          source_kind: validation.value.kind,
          display_label: KIND_CONFIG[validation.value.kind].label,
          file_relative: fileRelative,
          workspace_relative: path.posix.join(relativeRoot.replaceAll(path.sep, '/'), fileRelative),
          extension,
          content_type: validation.value.contentType,
          bytes: total,
          sha256: digest.digest('hex'),
          media,
          state: 'staged',
          created_at: now.toISOString(),
          expires_at: new Date(now.getTime() + CONTROL_CENTER_INTAKE_TTL_MS).toISOString(),
          consumed_at: null
        };
        try {
          await store.writeJson(`receipts/${id}.json`, receipt, { maxBytes: 32 * 1024 });
          await removeStoreFile(store, `reservations/${id}.json`, 8 * 1024);
          reserved = false;
          committed = true;
          return intakeOk({ intake: projectReceipt(receipt) });
        } catch (error) {
          await removeStoreFile(store, `receipts/${id}.json`, 32 * 1024);
          await rm(target, { force: true });
          targetCreated = false;
          throw error;
        }
      });
    } finally {
      try { await handle.close(); } catch {}
      if (!committed) await rm(temporary, { force: true });
    }
  } catch (error) {
    return intakeError(error?.code ?? 'CONTROL_CENTER_INTAKE_UPLOAD_FAILED', 'The selected file could not be added safely.', {});
  } finally {
    if (!committed && targetCreated) {
      try { await rm(await store.resolvePrivatePath(fileRelative), { force: true }); } catch {}
    }
    if (reserved) {
      try {
        await store.withLock('intake-quota', async () => {
          await removeStoreFile(store, `reservations/${id}.json`, 8 * 1024);
        });
      } catch {}
    }
  }
}

export async function completeControlCenterIntake(input = {}, context = {}) {
  const id = typeof input.intake_id === 'string' && ID_PATTERN.test(input.intake_id) ? input.intake_id : null;
  if (!id) return intakeError('CONTROL_CENTER_INTAKE_REQUEST_INVALID', 'Choose a current file.', {});
  const { store } = intakeStore(context);
  let publicationReservation = null;
  let stopPublicationLease = async () => {};
  try {
    const existingCompletion = await resolveExistingIntakeCompletion(store, id, context);
    if (existingCompletion) return existingCompletion;
    publicationReservation = await reserveIntakeResultPublication(store, id, context);
    if (!publicationReservation.ok) {
      return intakeError(
        'CONTROL_CENTER_INTAKE_RESULT_CAPACITY_REACHED',
        'Finish or remove an older saved result before checking another file.',
        { same_intake_retry_available: true }
      );
    }
    if (!publicationReservation.owned) {
      return await waitForExistingIntakeCompletion(store, id, context);
    }
    stopPublicationLease = startIntakePublicationLease(
      store,
      id,
      publicationReservation.token,
      context
    );
    const completion = await store.withLock(`intake-complete-${id}`, async () => {
      const receipt = await readIntakeReceipt(store, id);
      if (receipt?.state === 'completed') {
        const result = await readIntakeResult(store, id);
        if (!isCommittedIntakeResult(receipt, result)) {
          throw intakeCodedError('CONTROL_CENTER_INTAKE_RESULT_NOT_COMMITTED', 'The saved result is not complete.');
        }
        return intakeOk({ result, already_completed: true });
      }
      if (receipt?.state === 'processing' && receipt?.pending_result_sha256) {
        const pendingResult = await readIntakeResult(store, id);
        if (!isPendingIntakeResult(receipt, pendingResult)) {
          throw intakeCodedError('CONTROL_CENTER_INTAKE_PUBLICATION_INVALID', 'The saved result could not be completed safely.');
        }
        try {
          const finalized = await finalizePendingIntakePublication(store, id, context);
          return intakeOk({ result: finalized.result });
        } catch (error) {
          if (await hasCurrentValidPendingIntakeResult(store, id)) throw pendingPublicationError();
          throw error;
        }
      }
      if (receipt?.state !== 'staged' || receipt?.consumed_at) {
        return intakeError(
          'CONTROL_CENTER_INTAKE_NOT_REUSABLE',
          'Choose the file again before retrying.',
          {}
        );
      }
      await assertOwnedIntakePublicationReservation(store, id, publicationReservation.token);
      const purpose = cleanText(input.purpose, 1200);
      const effort = ['standard', 'deep', 'xhigh'].includes(input.effort) ? input.effort : null;
      if (receipt.source_kind === 'document_text' && (!purpose || !effort)) {
        return intakeError('CONTROL_CENTER_INTAKE_REQUEST_INVALID', 'Choose a goal and a review method for this document.', {});
      }
      await verifyReceipt(receipt, store, context);
      receipt.state = 'processing';
      receipt.processing_started_at = materializeNow(context.now).toISOString();
      receipt.processing_owner = {
        pid: process.pid,
        process_identity: await captureProcessIdentity(process.pid)
      };
      receipt.publication_reservation_token = publicationReservation.token;
      await store.writeJson(`receipts/${id}.json`, receipt, { maxBytes: 32 * 1024 });

      let publicationPrepared = false;
      let resultWritten = false;
      try {
        const executor = typeof context.executeIntake === 'function' ? context.executeIntake : executeIntake;
        const result = await executor(receipt, { purpose, effort }, context);
        if (result?.status !== 'ok') {
          const engineError = result?.errors?.[0];
          receipt.state = 'failed';
          receipt.failure_code = engineError?.code ?? 'CONTROL_CENTER_INTAKE_PROCESS_FAILED';
          receipt.finished_at = materializeNow(context.now).toISOString();
          delete receipt.processing_owner;
          delete receipt.publication_reservation_token;
          await store.writeJson(`receipts/${id}.json`, receipt, { maxBytes: 32 * 1024 });
          return intakeError(receipt.failure_code, 'The selected file could not be checked.', {});
        }
        const completedAt = materializeNow(context.now).toISOString();
        const projection = projectEngineResult(receipt, result, {
          id,
          completedAt,
          purpose: receipt.source_kind === 'document_text' ? purpose : null,
          effort: receipt.source_kind === 'document_text' ? effort : null
        });
        receipt.pending_result_sha256 = intakeResultDigest(projection);
        receipt.pending_completed_at = completedAt;
        await store.writeJson(`receipts/${id}.json`, receipt, { maxBytes: 32 * 1024 });
        publicationPrepared = true;
        await store.writeJson(`results/${id}.json`, projection, { maxBytes: 32 * 1024 });
        resultWritten = true;
        const finalized = await finalizePendingIntakePublication(store, id, context);
        return intakeOk({ result: finalized.result });
      } catch (error) {
        if (publicationPrepared && resultWritten) {
          if (await hasCurrentValidPendingIntakeResult(store, id)) throw pendingPublicationError();
          throw error;
        }
        receipt.state = 'failed';
        receipt.failure_code = error?.code ?? 'CONTROL_CENTER_INTAKE_PROCESS_FAILED';
        receipt.finished_at = materializeNow(context.now).toISOString();
        delete receipt.processing_owner;
        delete receipt.publication_reservation_token;
        delete receipt.pending_result_sha256;
        delete receipt.pending_completed_at;
        try { await store.writeJson(`receipts/${id}.json`, receipt, { maxBytes: 32 * 1024 }); } catch {}
        throw error;
      }
    }, { timeoutMs: intakeLimits(context).completionLockTimeoutMs });
    if (completion.status === 'ok') {
      scheduleIntakeHistoryRetention(store, context);
    }
    return completion;
  } catch (error) {
    const pending = error?.code === 'CONTROL_CENTER_INTAKE_PUBLICATION_PENDING';
    return intakeError(
      error?.code ?? 'CONTROL_CENTER_INTAKE_NOT_AVAILABLE',
      pending ? error.message : 'Choose the file again and retry.',
      { same_intake_retry_available: pending }
    );
  } finally {
    await stopPublicationLease();
    if (publicationReservation?.owned) {
      await releaseIntakeResultPublication(store, id, publicationReservation.token, context);
    }
  }
}

async function resolveExistingIntakeCompletion(store, id, context) {
  let receipt;
  try {
    receipt = await readIntakeReceipt(store, id);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return intakeError('CONTROL_CENTER_INTAKE_NOT_AVAILABLE', 'Choose the file again and retry.', {});
    }
    throw error;
  }
  if (receipt?.state === 'staged') return null;
  if (receipt?.state === 'completed') {
    const result = await readIntakeResult(store, id);
    if (!isCommittedIntakeResult(receipt, result)) {
      throw intakeCodedError('CONTROL_CENTER_INTAKE_RESULT_NOT_COMMITTED', 'The saved result is not complete.');
    }
    return intakeOk({ result, already_completed: true });
  }
  if (receipt?.state === 'processing') {
    return waitForExistingIntakeCompletion(store, id, context);
  }
  if (receipt?.state === 'failed') {
    return intakeError(
      receipt.failure_code ?? 'CONTROL_CENTER_INTAKE_PROCESS_FAILED',
      'Choose the file again before retrying.',
      {}
    );
  }
  return intakeError('CONTROL_CENTER_INTAKE_NOT_REUSABLE', 'Choose the file again before retrying.', {});
}

export async function listControlCenterIntakeResults(input = {}, context = {}) {
  const limit = Math.min(CONTROL_CENTER_INTAKE_MAX_ENTRIES, normalizePositiveInteger(input.limit, 50));
  const { store } = intakeStore(context);
  let entries;
  try {
    const directory = path.dirname(await store.resolvePrivatePath('results/.scan'));
    entries = await boundedDirectoryNames(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') return intakeOk({ results: [] });
    return intakeError(error?.code ?? 'CONTROL_CENTER_INTAKE_RESULTS_UNAVAILABLE', 'Saved confirmation results could not be opened.', {});
  }
  try {
    const results = [];
    for (const entry of boundedMatchingEntries(entries, RESULT_PATTERN)) {
      const id = entry.slice(0, -5);
      results.push(await readCommittedIntakeResult(store, id, context));
    }
    results.sort((left, right) => right.completed_at.localeCompare(left.completed_at));
    return intakeOk({ results: results.slice(0, limit) });
  } catch (error) {
    return intakeError(error?.code ?? 'CONTROL_CENTER_INTAKE_RESULTS_UNAVAILABLE', 'Saved confirmation results could not be opened.', {});
  }
}

export async function getControlCenterIntakeResult(input = {}, context = {}) {
  const id = typeof input.id === 'string' && ID_PATTERN.test(input.id) ? input.id : null;
  if (!id) return intakeError('CONTROL_CENTER_INTAKE_RESULT_ID_INVALID', 'Choose a saved result.', {});
  const { store } = intakeStore(context);
  try {
    const result = await readCommittedIntakeResult(store, id, context);
    return intakeOk({ result });
  } catch (error) {
    return intakeError(error?.code ?? 'CONTROL_CENTER_INTAKE_RESULT_NOT_FOUND', 'The saved result is no longer available.', {});
  }
}

export async function recoverPendingControlCenterIntakePublications(context = {}) {
  const { store } = intakeStore(context);
  let entries;
  try {
    const directory = path.dirname(await store.resolvePrivatePath('receipts/.scan'));
    entries = await boundedDirectoryNames(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') return { recovered: 0 };
    throw error;
  }
  let recovered = 0;
  for (const entry of boundedMatchingEntries(entries, RECEIPT_PATTERN)) {
    const id = entry.slice(0, -5);
    try {
      const candidate = await store.readJson(`receipts/${id}.json`, { maxBytes: 32 * 1024 });
      if (candidate?.state !== 'processing' || typeof candidate?.pending_result_sha256 !== 'string') continue;
      const changed = await store.withLock(`intake-complete-${id}`, async () => {
        const receipt = await store.readJson(`receipts/${id}.json`, { maxBytes: 32 * 1024 });
        const result = await store.readJson(`results/${id}.json`, { maxBytes: 32 * 1024 });
        if (isCommittedIntakeResult(receipt, result)) return false;
        if (!isPendingIntakeResult(receipt, result)) return false;
        await finalizePendingIntakePublication(store, id, context, {
          lockTimeoutMs: intakeLimits(context).recoveryLockTimeoutMs
        });
        return true;
      }, { timeoutMs: intakeLimits(context).recoveryLockTimeoutMs });
      if (changed) recovered += 1;
    } catch {
      // Startup recovery is best effort; read endpoints still fail closed for incomplete results.
    }
  }
  return { recovered };
}

async function executeIntake(receipt, { purpose, effort }, context) {
  if (receipt.source_kind === 'image') {
    return runImageReview({
      image: receipt.workspace_relative,
      report: false,
      'artifact-root': context.artifactRoot
    }, executionContext(context));
  }
  if (receipt.source_kind === 'document_text') {
    return runControlCenterSourceIntakeProposal({
      source_text_file: receipt.workspace_relative,
      source_type: 'document',
      review_brief: purpose,
      review_effort: effort,
      artifact_root: context.artifactRoot,
      confirm: 'create-source-intake-proposal'
    }, executionContext(context));
  }
  return runPlaywrightTestImport({
    input: receipt.workspace_relative,
    'artifact-root': context.artifactRoot,
    confirm: 'import-playwright-test-result'
  }, executionContext(context));
}

async function verifyReceipt(receipt, store, context) {
  if (receipt?.schema_version !== '1.1.0') {
    throw intakeCodedError('CONTROL_CENTER_INTAKE_RECEIPT_VERSION_UNSUPPORTED', 'Choose the file again before continuing.');
  }
  if (receipt?.type !== 'control_center_intake_receipt' || !ID_PATTERN.test(receipt?.id)
    || !CONTROL_CENTER_INTAKE_KINDS.includes(receipt?.source_kind)
    || Date.parse(receipt.expires_at) <= materializeNow(context.now).getTime()) {
    throw intakeCodedError('CONTROL_CENTER_INTAKE_EXPIRED', 'The selected file is no longer available.');
  }
  const inspected = await store.inspectFile(receipt.file_relative, { maxBytes: KIND_CONFIG[receipt.source_kind].maxBytes });
  if (inspected.info.size !== receipt.bytes) throw intakeCodedError('CONTROL_CENTER_INTAKE_CHANGED', 'The selected file changed.');
  const handle = await open(inspected.target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let body;
  try {
    body = await readStableBoundedFileHandle(handle, {
      expected: inspected.info,
      maxBytes: KIND_CONFIG[receipt.source_kind].maxBytes,
      changedError: () => intakeCodedError('CONTROL_CENTER_INTAKE_CHANGED', 'The selected file changed.')
    });
  } finally {
    await handle.close();
  }
  const digest = createHash('sha256').update(body).digest('hex');
  if (digest !== receipt.sha256) throw intakeCodedError('CONTROL_CENTER_INTAKE_CHANGED', 'The selected file changed.');
}

async function validateStagedContent(file, kind, extension, bytes) {
  const body = await readFile(file);
  if (body.length !== bytes) throw intakeCodedError('CONTROL_CENTER_INTAKE_CHANGED', 'The selected file changed.');
  if (kind === 'image') return validateImage(body, extension);
  const text = decodeUtf8(body);
  if (text.includes('\0')) throw intakeCodedError('CONTROL_CENTER_INTAKE_BINARY_TEXT', 'Choose a plain text file.');
  if (extension === '.json') {
    try { JSON.parse(text); } catch { throw intakeCodedError('CONTROL_CENTER_INTAKE_JSON_INVALID', 'Choose a valid JSON file.'); }
  }
  if (kind === 'playwright_result' && extension === '.xml') {
    if (/<!DOCTYPE|<!ENTITY/iu.test(text) || !/<testsuites?\b/iu.test(text)) {
      throw intakeCodedError('CONTROL_CENTER_INTAKE_JUNIT_INVALID', 'Choose a valid JUnit test result.');
    }
  }
  return { format: extension.slice(1), text: true };
}

function validateImage(body, extension) {
  let format = null;
  let width = null;
  let height = null;
  if (body.length >= 24 && body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    format = '.png'; width = body.readUInt32BE(16); height = body.readUInt32BE(20);
  } else if (body.length >= 10 && ['GIF87a', 'GIF89a'].includes(body.subarray(0, 6).toString('ascii'))) {
    format = '.gif'; width = body.readUInt16LE(6); height = body.readUInt16LE(8);
  } else if (body.length >= 12 && body[0] === 0xff && body[1] === 0xd8) {
    format = '.jpg'; ({ width, height } = jpegDimensions(body));
  } else if (body.length >= 30 && body.subarray(0, 4).toString('ascii') === 'RIFF'
    && body.subarray(8, 12).toString('ascii') === 'WEBP') {
    format = '.webp'; ({ width, height } = webpDimensions(body));
  }
  const expected = extension === '.jpeg' ? '.jpg' : extension;
  if (!format || format !== expected || !width || !height) {
    throw intakeCodedError('CONTROL_CENTER_INTAKE_IMAGE_SIGNATURE_MISMATCH', 'The image type does not match its contents.');
  }
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || width * height > MAX_IMAGE_PIXELS) {
    throw intakeCodedError('CONTROL_CENTER_INTAKE_IMAGE_DIMENSIONS_EXCEEDED', 'The image dimensions are too large.');
  }
  return { format: format.slice(1), width, height };
}

function jpegDimensions(body) {
  let offset = 2;
  while (offset + 9 < body.length) {
    if (body[offset] !== 0xff) { offset += 1; continue; }
    const marker = body[offset + 1];
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { height: body.readUInt16BE(offset + 5), width: body.readUInt16BE(offset + 7) };
    }
    if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
    const length = body.readUInt16BE(offset + 2);
    if (length < 2) break;
    offset += 2 + length;
  }
  return { width: null, height: null };
}

function webpDimensions(body) {
  const kind = body.subarray(12, 16).toString('ascii');
  if (kind === 'VP8X' && body.length >= 30) {
    return {
      width: 1 + body.readUIntLE(24, 3),
      height: 1 + body.readUIntLE(27, 3)
    };
  }
  if (kind === 'VP8 ' && body.length >= 30
    && body[23] === 0x9d && body[24] === 0x01 && body[25] === 0x2a) {
    return {
      width: body.readUInt16LE(26) & 0x3fff,
      height: body.readUInt16LE(28) & 0x3fff
    };
  }
  if (kind === 'VP8L' && body.length >= 25 && body[20] === 0x2f) {
    return {
      width: 1 + (body[21] | ((body[22] & 0x3f) << 8)),
      height: 1 + ((body[22] >> 6) | (body[23] << 2) | ((body[24] & 0x0f) << 10))
    };
  }
  return { width: null, height: null };
}

async function inspectQuota(store, context, limits = intakeLimits(context)) {
  const receiptsPath = path.dirname(await store.resolvePrivatePath('receipts/.scan', { ensureParent: true }));
  let entries = [];
  try { entries = await boundedDirectoryNames(receiptsPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  let count = 0;
  let bytes = 0;
  for (const entry of boundedMatchingEntries(entries, RECEIPT_PATTERN)) {
    const receipt = await store.readJson(`receipts/${entry}`, { maxBytes: 32 * 1024 });
    if (receipt?.type !== 'control_center_intake_receipt' || receipt?.id !== entry.slice(0, -5)
      || !['staged', 'processing', 'completed', 'failed'].includes(receipt?.state)) {
      throw intakeCodedError('CONTROL_CENTER_INTAKE_RECEIPT_INVALID', 'The local intake receipt is invalid.');
    }
    if (await intakeSourceExists(store, receipt)) {
      count += 1;
      bytes += Number(receipt.bytes ?? 0);
    }
  }
  const reservationsPath = path.dirname(await store.resolvePrivatePath('reservations/.scan', { ensureParent: true }));
  let reservations = [];
  try { reservations = await boundedDirectoryNames(reservationsPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  for (const entry of boundedMatchingEntries(reservations, RESERVATION_PATTERN)) {
    const reservation = await store.readJson(`reservations/${entry}`, { maxBytes: 8 * 1024 });
    if (reservation?.type !== 'control_center_intake_reservation' || reservation?.id !== entry.slice(0, -5)) {
      throw intakeCodedError('CONTROL_CENTER_INTAKE_RESERVATION_INVALID', 'The local intake reservation is invalid.');
    }
    if (Date.parse(reservation.expires_at) > materializeNow(context.now).getTime()) {
      count += 1;
      bytes += Number(reservation.requested_bytes ?? 0);
    }
  }
  return { count, bytes };
}

async function cleanupIntakeStore(store, context, limits = intakeLimits(context)) {
  const now = materializeNow(context.now).getTime();
  const receiptsPath = path.dirname(await store.resolvePrivatePath('receipts/.scan', { ensureParent: true }));
  let entries = [];
  try { entries = await boundedDirectoryNames(receiptsPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const referencedFiles = new Set();
  for (const entry of boundedMatchingEntries(entries, RECEIPT_PATTERN)) {
    try {
      const receipt = await store.readJson(`receipts/${entry}`, { maxBytes: 32 * 1024 });
      if (typeof receipt.file_relative === 'string') {
        const stagedAndCurrent = receipt.state === 'staged' && Date.parse(receipt.expires_at) > now;
        const processingAndAlive = receipt.state === 'processing'
          && await isProcessIdentityAlive(receipt.processing_owner ?? {});
        const pendingPublication = receipt.state === 'processing'
          && await hasValidPendingIntakeResult(store, receipt);
        if (stagedAndCurrent || processingAndAlive || pendingPublication) {
          referencedFiles.add(path.basename(receipt.file_relative));
          continue;
        }
      }
      if (typeof receipt.file_relative === 'string') {
        await removeStoreFile(
          store,
          receipt.file_relative,
          KIND_CONFIG[receipt.source_kind]?.maxBytes ?? IMAGE_MAX_BYTES
        );
      }
      if (receipt.state !== 'completed') {
        await removeStoreFile(store, `results/${entry}`, 32 * 1024);
        await removeStoreFile(store, `receipts/${entry}`, 32 * 1024);
      }
    } catch {}
  }
  const reservationsPath = path.dirname(await store.resolvePrivatePath('reservations/.scan', { ensureParent: true }));
  let reservations = [];
  try { reservations = await boundedDirectoryNames(reservationsPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  for (const entry of boundedMatchingEntries(reservations, RESERVATION_PATTERN)) {
    try {
      const reservation = await store.readJson(`reservations/${entry}`, { maxBytes: 8 * 1024 });
      const alive = await isProcessIdentityAlive(reservation.owner ?? {});
      if (Date.parse(reservation.expires_at) > now && alive) continue;
      if (typeof reservation.temporary_relative === 'string') {
        await removeStoreFile(store, reservation.temporary_relative, IMAGE_MAX_BYTES);
      }
      await removeStoreFile(store, `reservations/${entry}`, 8 * 1024);
    } catch {}
  }
  const filesPath = path.dirname(await store.resolvePrivatePath('files/.scan', { ensureParent: true }));
  let files = [];
  try { files = await boundedDirectoryNames(filesPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  for (const entry of boundedDirectoryEntries(files)) {
    if (referencedFiles.has(entry)) continue;
    try {
      const target = await store.resolvePrivatePath(`files/${entry}`);
      const info = await lstat(target);
      if (info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && now - info.mtimeMs > ORPHAN_GRACE_MS) {
        await rm(target);
      }
    } catch {}
  }
}

async function pruneIntakeHistory(store, context, options = {}) {
  const limits = intakeLimits(context);
  const reservedSlots = options.reservePublicationSlot === true ? 1 : 0;
  const limit = Math.min(limits.historyEntries, Math.max(0, limits.activeResultEntries - reservedSlots));
  const directory = path.dirname(await store.resolvePrivatePath('results/.scan', { ensureParent: true }));
  const entries = await boundedDirectoryNames(directory);
  const stored = [];
  for (const entry of boundedMatchingEntries(entries, RESULT_PATTERN)) {
    try {
      const result = await store.readJson(`results/${entry}`, { maxBytes: 32 * 1024 });
      const receipt = await store.readJson(`receipts/${result.id}.json`, { maxBytes: 32 * 1024 });
      if (isCommittedIntakeResult(receipt, result)) stored.push({ entry, result });
    } catch {}
  }
  stored.sort((left, right) => right.result.completed_at.localeCompare(left.result.completed_at)
    || right.result.id.localeCompare(left.result.id));
  for (const retired of stored.slice(limit)) {
    const id = retired.result.id;
    await store.withLock(`intake-complete-${id}`, async () => {
      let current;
      try {
        current = await store.readJson(`results/${id}.json`, { maxBytes: 32 * 1024 });
      } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
      }
      if (!isStoredResult(current) || current.id !== id || current.completed_at !== retired.result.completed_at) return;
      let receipt = null;
      try {
        receipt = await store.readJson(`receipts/${id}.json`, { maxBytes: 32 * 1024 });
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      if (!receipt || !isCommittedIntakeResult(receipt, current)) return;
      await store.writeJson(intakeHistoryFile('results', id), current, { maxBytes: 32 * 1024 });
      await store.writeJson(intakeHistoryFile('receipts', id), receipt, { maxBytes: 32 * 1024 });
      await removeStoreFile(store, `results/${id}.json`, 32 * 1024);
      await removeStoreFile(store, `receipts/${id}.json`, 32 * 1024);
    }, { timeoutMs: limits.historyLockTimeoutMs });
  }
}

async function reserveIntakeResultPublication(store, id, context) {
  const limits = intakeLimits(context);
  return store.withLock('intake-publication-admission', async () => {
    await cleanupIntakePublicationReservations(store, context);
    const existing = await readOptionalStoreJson(store, `publication-reservations/${id}.json`, 8 * 1024);
    if (isIntakePublicationReservation(existing, id)
      && await isProcessIdentityAlive(existing.owner)) {
      return { ok: true, owned: false, token: null };
    }
    let usage = await inspectIntakePublicationUsage(store);
    if (!usage.has(id) && usage.size >= limits.activeResultEntries) {
      try {
        await store.withLock(
          'intake-history',
          async () => pruneIntakeHistory(store, context, { reservePublicationSlot: true }),
          { timeoutMs: limits.historyLockTimeoutMs }
        );
      } catch {
        // Capacity remains closed until a safe history pass succeeds.
      }
      usage = await inspectIntakePublicationUsage(store);
    }
    if (!usage.has(id) && usage.size >= limits.activeResultEntries) {
      return { ok: false, owned: false, token: null };
    }
    const token = randomBytes(16).toString('hex');
    const now = materializeNow(context.now);
    await store.writeJson(`publication-reservations/${id}.json`, {
      schema_version: '1.0.0',
      type: 'control_center_intake_publication_reservation',
      id,
      token,
      owner: {
        pid: process.pid,
        process_identity: await captureProcessIdentity(process.pid)
      },
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + limits.publicationLeaseTtlMs).toISOString()
    }, { maxBytes: 8 * 1024 });
    return { ok: true, owned: true, token };
  }, { timeoutMs: limits.completionLockTimeoutMs });
}

async function releaseIntakeResultPublication(store, id, token, context) {
  try {
    await store.withLock('intake-publication-admission', async () => {
      const reservation = await readOptionalStoreJson(store, `publication-reservations/${id}.json`, 8 * 1024);
      if (reservation?.id === id && reservation?.token === token) {
        await removeStoreFile(store, `publication-reservations/${id}.json`, 8 * 1024);
      }
    }, { timeoutMs: intakeLimits(context).completionLockTimeoutMs });
  } catch {
    // A stale reservation is owner-bound and cleaned during the next admission pass.
  }
}

async function assertOwnedIntakePublicationReservation(store, id, token) {
  const reservation = await store.readJson(`publication-reservations/${id}.json`, { maxBytes: 8 * 1024 });
  if (!isIntakePublicationReservation(reservation, id)
    || reservation.token !== token
    || !await isProcessIdentityAlive(reservation.owner)) {
    throw intakeCodedError(
      'CONTROL_CENTER_INTAKE_PUBLICATION_RESERVATION_LOST',
      'The saved result reservation is no longer available.'
    );
  }
}

function startIntakePublicationLease(store, id, token, context) {
  const limits = intakeLimits(context);
  let active = true;
  let timer = null;
  let pending = Promise.resolve();
  const schedule = () => {
    if (!active) return;
    timer = setTimeout(() => {
      if (!active) return;
      pending = renewIntakePublicationLease(store, id, token, context)
        .catch(() => {})
        .finally(schedule);
    }, limits.publicationLeaseRenewIntervalMs);
    timer.unref?.();
  };
  schedule();
  return async () => {
    active = false;
    if (timer) clearTimeout(timer);
    await pending;
  };
}

async function renewIntakePublicationLease(store, id, token, context) {
  const limits = intakeLimits(context);
  await store.withLock('intake-publication-admission', async () => {
    const reservation = await readOptionalStoreJson(store, `publication-reservations/${id}.json`, 8 * 1024);
    if (!isIntakePublicationReservation(reservation, id) || reservation.token !== token) return;
    const now = materializeNow(context.now);
    await store.writeJson(`publication-reservations/${id}.json`, {
      ...reservation,
      renewed_at: now.toISOString(),
      expires_at: new Date(now.getTime() + limits.publicationLeaseTtlMs).toISOString()
    }, { maxBytes: 8 * 1024 });
  }, { timeoutMs: limits.completionLockTimeoutMs });
}

async function waitForExistingIntakeCompletion(store, id, context) {
  let abandonedReservationToken = null;
  try {
    const completion = await store.withLock(`intake-complete-${id}`, async () => {
      const receipt = await readIntakeReceipt(store, id);
      if (receipt?.state === 'completed') {
        const result = await readIntakeResult(store, id);
        if (!isCommittedIntakeResult(receipt, result)) {
          throw intakeCodedError('CONTROL_CENTER_INTAKE_RESULT_NOT_COMMITTED', 'The saved result is not complete.');
        }
        return intakeOk({ result, already_completed: true });
      }
      if (receipt?.state === 'processing' && receipt?.pending_result_sha256) {
        let pendingResult = null;
        try {
          pendingResult = await readIntakeResult(store, id);
        } catch (error) {
          if (!['ENOENT', 'SAFE_STORE_JSON_INVALID'].includes(error?.code)) throw error;
        }
        if (!pendingResult || !isPendingIntakeResult(receipt, pendingResult)) {
          abandonedReservationToken = typeof receipt.publication_reservation_token === 'string'
            ? receipt.publication_reservation_token
            : null;
          await removeStoreFile(store, `results/${id}.json`, 32 * 1024);
          receipt.state = 'failed';
          receipt.failure_code = 'CONTROL_CENTER_INTAKE_PUBLICATION_INVALID';
          receipt.finished_at = materializeNow(context.now).toISOString();
          delete receipt.processing_owner;
          delete receipt.publication_reservation_token;
          delete receipt.pending_result_sha256;
          delete receipt.pending_completed_at;
          await store.writeJson(`receipts/${id}.json`, receipt, { maxBytes: 32 * 1024 });
          return intakeError(
            receipt.failure_code,
            'Choose the file again before retrying.',
            { same_intake_retry_available: false }
          );
        }
        try {
          const finalized = await finalizePendingIntakePublication(store, id, context);
          return intakeOk({ result: finalized.result });
        } catch (error) {
          if (await hasCurrentValidPendingIntakeResult(store, id)) throw pendingPublicationError();
          throw error;
        }
      }
      if (receipt?.state === 'processing') {
        abandonedReservationToken = typeof receipt.publication_reservation_token === 'string'
          ? receipt.publication_reservation_token
          : null;
        receipt.state = 'failed';
        receipt.failure_code = 'CONTROL_CENTER_INTAKE_PROCESS_INTERRUPTED';
        receipt.finished_at = materializeNow(context.now).toISOString();
        delete receipt.processing_owner;
        delete receipt.publication_reservation_token;
        await store.writeJson(`receipts/${id}.json`, receipt, { maxBytes: 32 * 1024 });
        return intakeError(
          receipt.failure_code,
          'Choose the file again before retrying.',
          { same_intake_retry_available: false }
        );
      }
      if (receipt?.state === 'failed') {
        return intakeError(
          receipt.failure_code ?? 'CONTROL_CENTER_INTAKE_PROCESS_FAILED',
          'Choose the file again before retrying.',
          {}
        );
      }
      throw pendingPublicationError();
    }, { timeoutMs: intakeLimits(context).completionLockTimeoutMs });
    if (abandonedReservationToken) {
      await releaseIntakeResultPublication(store, id, abandonedReservationToken, context);
    }
    if (completion.status === 'ok') scheduleIntakeHistoryRetention(store, context);
    return completion;
  } catch (error) {
    const pending = error?.code === 'CONTROL_CENTER_INTAKE_PUBLICATION_PENDING'
      || error?.code === 'SAFE_STORE_LOCK_TIMEOUT';
    return intakeError(
      pending ? 'CONTROL_CENTER_INTAKE_PUBLICATION_PENDING' : (error?.code ?? 'CONTROL_CENTER_INTAKE_NOT_AVAILABLE'),
      pending ? 'The saved result is still being completed. Check it again shortly.' : 'Choose the file again and retry.',
      { same_intake_retry_available: pending }
    );
  }
}

async function cleanupIntakePublicationReservations(store, context) {
  let entries;
  try {
    const directory = path.dirname(await store.resolvePrivatePath('publication-reservations/.scan', { ensureParent: true }));
    entries = await boundedDirectoryNames(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  const now = materializeNow(context.now).getTime();
  for (const entry of boundedMatchingEntries(entries, PUBLICATION_RESERVATION_PATTERN)) {
    const reservation = await readOptionalStoreJson(store, `publication-reservations/${entry}`, 8 * 1024);
    const id = entry.slice(0, -5);
    const valid = isIntakePublicationReservation(reservation, id);
    const ownerAlive = valid && await isProcessIdentityAlive(reservation.owner);
    let processing = false;
    if (ownerAlive && Date.parse(reservation.expires_at) <= now) {
      const receipt = await readOptionalStoreJson(store, `receipts/${id}.json`, 32 * 1024);
      processing = receipt?.state === 'processing'
        && receipt?.publication_reservation_token === reservation.token;
    }
    if (!valid || !ownerAlive || (Date.parse(reservation.expires_at) <= now && !processing)) {
      await removeStoreFile(store, `publication-reservations/${entry}`, 8 * 1024);
    }
  }
}

async function inspectIntakePublicationUsage(store) {
  let results = [];
  let reservations = [];
  try {
    results = await boundedDirectoryNames(path.dirname(await store.resolvePrivatePath('results/.scan')));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    reservations = await boundedDirectoryNames(path.dirname(await store.resolvePrivatePath('publication-reservations/.scan')));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return new Set([
    ...boundedMatchingEntries(results, RESULT_PATTERN).map((entry) => entry.slice(0, -5)),
    ...boundedMatchingEntries(reservations, PUBLICATION_RESERVATION_PATTERN).map((entry) => entry.slice(0, -5))
  ]);
}

function isIntakePublicationReservation(value, id) {
  return value?.schema_version === '1.0.0'
    && value?.type === 'control_center_intake_publication_reservation'
    && value?.id === id
    && typeof value?.token === 'string'
    && /^[a-f0-9]{32}$/u.test(value.token)
    && Number.isFinite(Date.parse(value.created_at))
    && Number.isFinite(Date.parse(value.expires_at));
}

async function readOptionalStoreJson(store, relativePath, maxBytes) {
  try {
    return await store.readJson(relativePath, { maxBytes });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function scheduleIntakeHistoryRetention(store, context) {
  const cwd = path.resolve(context.cwd ?? process.cwd());
  const key = path.join(cwd, resolveRelativeArtifactRoot(cwd, context.artifactRoot), INTAKE_DIRECTORY);
  const existing = INTAKE_HISTORY_RETENTION.get(key);
  if (existing) {
    existing.requested = true;
    existing.store = store;
    existing.context = context;
    return;
  }
  const state = { requested: true, store, context };
  INTAKE_HISTORY_RETENTION.set(key, state);
  scheduleUnrefImmediate(() => { void runScheduledIntakeHistoryRetention(key, state); });
}

async function runScheduledIntakeHistoryRetention(key, state) {
  state.requested = false;
  try {
    await state.store.withLock(
      'intake-history',
      async () => pruneIntakeHistory(state.store, state.context),
      { timeoutMs: intakeLimits(state.context).historyLockTimeoutMs }
    );
  } catch {
    // Retention is maintenance; it must never change an already committed intake result.
  }
  if (state.requested) {
    scheduleUnrefImmediate(() => { void runScheduledIntakeHistoryRetention(key, state); });
    return;
  }
  if (INTAKE_HISTORY_RETENTION.get(key) === state) INTAKE_HISTORY_RETENTION.delete(key);
}

function scheduleUnrefImmediate(task) {
  const immediate = setImmediate(task);
  immediate.unref?.();
}

async function finalizePendingIntakePublication(store, id, context, options = {}) {
  const limits = intakeLimits(context);
  return store.withLock('intake-quota', async () => {
    const receipt = await store.readJson(`receipts/${id}.json`, { maxBytes: 32 * 1024 });
    const result = await store.readJson(`results/${id}.json`, { maxBytes: 32 * 1024 });
    if (isCommittedIntakeResult(receipt, result)) return { receipt, result };
    if (!isPendingIntakeResult(receipt, result)) {
      throw intakeCodedError('CONTROL_CENTER_INTAKE_PUBLICATION_INVALID', 'The saved result could not be completed safely.');
    }
    await removeStoreFile(store, receipt.file_relative, KIND_CONFIG[receipt.source_kind].maxBytes);
    receipt.state = 'completed';
    receipt.consumed_at = receipt.pending_completed_at;
    receipt.finished_at = receipt.pending_completed_at;
    receipt.source_released_at = materializeNow(context.now).toISOString();
    receipt.result_sha256 = receipt.pending_result_sha256;
    delete receipt.pending_result_sha256;
    delete receipt.pending_completed_at;
    delete receipt.processing_owner;
    delete receipt.publication_reservation_token;
    delete receipt.failure_code;
    await store.writeJson(`receipts/${id}.json`, receipt, { maxBytes: 32 * 1024 });
    return { receipt, result };
  }, { timeoutMs: options.lockTimeoutMs ?? limits.completionLockTimeoutMs });
}

async function readCommittedIntakeResult(store, id, context) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const result = await readIntakeResult(store, id);
      const receipt = await readIntakeReceipt(store, id);
      if (isCommittedIntakeResult(receipt, result)) return result;
    } catch (error) {
      if (!['ENOENT', 'SAFE_STORE_FILE_CHANGED'].includes(error?.code) || attempt === 3) throw error;
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw intakeCodedError('CONTROL_CENTER_INTAKE_RESULT_NOT_COMMITTED', 'The saved result is not complete.');
}

async function hasValidPendingIntakeResult(store, receipt) {
  try {
    const result = await store.readJson(`results/${receipt.id}.json`, { maxBytes: 32 * 1024 });
    return isPendingIntakeResult(receipt, result);
  } catch {
    return false;
  }
}

async function hasCurrentValidPendingIntakeResult(store, id) {
  try {
    const receipt = await store.readJson(`receipts/${id}.json`, { maxBytes: 32 * 1024 });
    const result = await store.readJson(`results/${id}.json`, { maxBytes: 32 * 1024 });
    return isPendingIntakeResult(receipt, result);
  } catch {
    return false;
  }
}

async function intakeSourceExists(store, receipt) {
  if (typeof receipt.file_relative !== 'string' || !KIND_CONFIG[receipt.source_kind]) return false;
  try {
    await store.inspectFile(receipt.file_relative, { maxBytes: KIND_CONFIG[receipt.source_kind].maxBytes });
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function readIntakeReceipt(store, id) {
  try {
    return await store.readJson(`receipts/${id}.json`, { maxBytes: 32 * 1024 });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return store.readJson(intakeHistoryFile('receipts', id), { maxBytes: 32 * 1024 });
  }
}

async function readIntakeResult(store, id) {
  try {
    return await store.readJson(`results/${id}.json`, { maxBytes: 32 * 1024 });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return store.readJson(intakeHistoryFile('results', id), { maxBytes: 32 * 1024 });
  }
}

function intakeHistoryFile(kind, id) {
  return path.join('history', kind, id.slice(0, 2), id.slice(2, 4), `${id}.json`);
}

function boundedMatchingEntries(entries, pattern) {
  return boundedDirectoryEntries(entries.filter((entry) => pattern.test(entry)));
}

function boundedDirectoryEntries(entries) {
  if (entries.length > MAX_INTAKE_DIRECTORY_SCAN_ENTRIES) {
    throw intakeCodedError('CONTROL_CENTER_INTAKE_STORE_LIMIT_EXCEEDED', 'The local intake store is too large to inspect safely.');
  }
  return entries;
}

async function boundedDirectoryNames(directory) {
  return (await readDirectoryEntriesBounded(directory, {
    maxEntries: MAX_INTAKE_DIRECTORY_SCAN_ENTRIES
  })).map((entry) => entry.name);
}

function validateUploadInput(input) {
  const kind = CONTROL_CENTER_INTAKE_KINDS.includes(input.sourceKind) ? input.sourceKind : null;
  if (!kind) return invalid('CONTROL_CENTER_INTAKE_KIND_INVALID', 'Choose an image, document, or test result.');
  const originalName = typeof input.originalName === 'string' ? input.originalName : '';
  if (!originalName || originalName.length > 240 || /[\u0000-\u001f\u007f]/u.test(originalName)) {
    return invalid('CONTROL_CENTER_INTAKE_NAME_INVALID', 'Choose a file with a valid name.');
  }
  const extension = path.extname(originalName).toLowerCase();
  if (!KIND_CONFIG[kind].extensions.includes(extension)) {
    return invalid('CONTROL_CENTER_INTAKE_EXTENSION_REJECTED', 'This file type is not supported.');
  }
  const contentLength = Number(input.contentLength);
  if (!Number.isInteger(contentLength) || contentLength <= 0 || contentLength > KIND_CONFIG[kind].maxBytes) {
    return invalid('CONTROL_CENTER_INTAKE_LENGTH_INVALID', 'The selected file size is not supported.');
  }
  const contentType = (cleanText(input.contentType, 160) ?? 'application/octet-stream').split(';')[0].trim().toLowerCase();
  if (!KIND_CONFIG[kind].contentTypes.includes(contentType)) {
    return invalid('CONTROL_CENTER_INTAKE_CONTENT_TYPE_REJECTED', 'The file type does not match the selected source.');
  }
  return { ok: true, value: { kind, extension, contentLength, contentType, maxBytes: KIND_CONFIG[kind].maxBytes } };
}

function projectReceipt(receipt) {
  return {
    schema_version: '1.0.0',
    type: 'control_center_intake_receipt',
    id: receipt.id,
    source_kind: receipt.source_kind,
    label: receipt.display_label,
    bytes: receipt.bytes,
    expires_at: receipt.expires_at,
    storage_path_included: false,
    original_file_name_included: false
  };
}

function projectEngineResult(receipt, result, metadata) {
  const common = {
    schema_version: '1.0.0',
    type: 'control_center_intake_result',
    id: metadata.id,
    label: receipt.display_label,
    completed_at: metadata.completedAt,
    external_ai_review_completed: false
  };
  if (receipt.source_kind === 'image') {
    const review = result.data ?? {};
    return {
      ...common, source_kind: 'image', outcome: 'image_evidence_ready',
      summary: {
        status: review.status ?? 'ready', format: receipt.media?.format ?? null,
        width: receipt.media?.width ?? null, height: receipt.media?.height ?? null,
        finding_count: Number(review.metrics?.finding_count ?? review.findings?.length ?? 0)
      }
    };
  }
  if (receipt.source_kind === 'document_text') {
    const proposal = result.data?.source_intake ?? {};
    return {
      ...common, source_kind: 'document_text', outcome: 'review_proposal_ready',
      review_goal: metadata.purpose,
      review_method: metadata.effort,
      summary: {
        status: proposal.status ?? 'proposal_ready', characters: proposal.source_text?.char_count ?? null,
        sections: proposal.source_text?.chunk_count ?? null
      }
    };
  }
  const imported = result.data?.playwright_test_import ?? {};
  return {
    ...common, source_kind: 'playwright_result', outcome: 'test_evidence_ready',
    summary: {
      status: imported.status ?? 'evidence_ready', total: imported.summary?.total_count ?? 0,
      failed: imported.summary?.failed_count ?? 0, passed: imported.summary?.passed_count ?? 0,
      timed_out: imported.summary?.timed_out_count ?? 0,
      skipped: imported.summary?.skipped_count ?? 0
    }
  };
}

function isStoredResult(value) {
  return value?.schema_version === '1.0.0'
    && value?.type === 'control_center_intake_result'
    && ID_PATTERN.test(value?.id)
    && CONTROL_CENTER_INTAKE_KINDS.includes(value?.source_kind)
    && typeof value?.label === 'string'
    && typeof value?.completed_at === 'string'
    && Number.isFinite(Date.parse(value.completed_at))
    && value?.external_ai_review_completed === false
    && value?.summary && typeof value.summary === 'object' && !Array.isArray(value.summary);
}

function isPendingIntakeResult(receipt, result) {
  return receipt?.schema_version === '1.1.0'
    && receipt?.type === 'control_center_intake_receipt'
    && receipt?.state === 'processing'
    && receipt?.id === result?.id
    && receipt?.source_kind === result?.source_kind
    && typeof receipt?.pending_result_sha256 === 'string'
    && /^[a-f0-9]{64}$/u.test(receipt.pending_result_sha256)
    && receipt?.pending_completed_at === result?.completed_at
    && isStoredResult(result)
    && intakeResultDigest(result) === receipt.pending_result_sha256;
}

function isCommittedIntakeResult(receipt, result) {
  if (receipt?.schema_version !== '1.1.0'
    || receipt?.type !== 'control_center_intake_receipt'
    || receipt?.state !== 'completed'
    || receipt?.id !== result?.id
    || receipt?.source_kind !== result?.source_kind
    || !isStoredResult(result)
    || receipt?.consumed_at !== result?.completed_at
    || receipt?.finished_at !== result?.completed_at) return false;
  return typeof receipt.result_sha256 === 'string'
    && /^[a-f0-9]{64}$/u.test(receipt.result_sha256)
    && Number.isFinite(Date.parse(receipt.source_released_at))
    && receipt.pending_result_sha256 == null
    && intakeResultDigest(result) === receipt.result_sha256;
}

function intakeResultDigest(result) {
  return createHash('sha256').update(canonicalStringify(result)).digest('hex');
}

function canonicalStringify(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function removeStoreFile(store, relativePath, maxBytes) {
  try {
    await store.removeFile(relativePath, { maxBytes });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function intakeStore(context) {
  const cwd = path.resolve(context.cwd ?? process.cwd());
  const artifactRoot = resolveRelativeArtifactRoot(cwd, context.artifactRoot);
  const relativeRoot = path.join(artifactRoot, INTAKE_DIRECTORY);
  return { store: createSafeLocalStore({
    workspaceRoot: cwd,
    relativeRoot,
    namespace: 'control-center-intake',
    maxRecordBytes: 32 * 1024,
    maxEntries: CONTROL_CENTER_INTAKE_MAX_ENTRIES
  }), relativeRoot };
}

function intakeLimits(context) {
  return {
    totalBytes: normalizeBoundedPositiveInteger(
      context.intakeTotalBytes,
      CONTROL_CENTER_INTAKE_TOTAL_BYTES,
      CONTROL_CENTER_INTAKE_TOTAL_BYTES
    ),
    maxEntries: normalizeBoundedPositiveInteger(
      context.intakeMaxEntries,
      CONTROL_CENTER_INTAKE_MAX_ENTRIES,
      CONTROL_CENTER_INTAKE_MAX_ENTRIES
    ),
    historyEntries: normalizeBoundedPositiveInteger(
      context.intakeHistoryEntries,
      CONTROL_CENTER_INTAKE_HISTORY_ENTRIES,
      MAX_INTAKE_DIRECTORY_SCAN_ENTRIES - 64
    ),
    activeResultEntries: normalizeBoundedPositiveInteger(
      context.intakeActiveResultEntries,
      CONTROL_CENTER_INTAKE_ACTIVE_RESULT_ENTRIES,
      MAX_INTAKE_DIRECTORY_SCAN_ENTRIES - 64
    ),
    historyLockTimeoutMs: normalizeBoundedPositiveInteger(
      context.intakeHistoryMaintenanceLockTimeoutMs,
      DEFAULT_HISTORY_MAINTENANCE_LOCK_TIMEOUT_MS,
      MAX_HISTORY_MAINTENANCE_LOCK_TIMEOUT_MS
    ),
    completionLockTimeoutMs: normalizeBoundedPositiveInteger(
      context.intakeCompletionLockTimeoutMs,
      DEFAULT_COMPLETION_LOCK_TIMEOUT_MS,
      MAX_COMPLETION_LOCK_TIMEOUT_MS
    ),
    recoveryLockTimeoutMs: normalizeBoundedPositiveInteger(
      context.intakeRecoveryMaintenanceLockTimeoutMs,
      DEFAULT_RECOVERY_MAINTENANCE_LOCK_TIMEOUT_MS,
      MAX_RECOVERY_MAINTENANCE_LOCK_TIMEOUT_MS
    ),
    publicationLeaseTtlMs: normalizeBoundedPositiveInteger(
      context.intakePublicationLeaseTtlMs,
      RESERVATION_TTL_MS,
      MAX_RESERVATION_TTL_MS
    ),
    publicationLeaseRenewIntervalMs: normalizeBoundedPositiveInteger(
      context.intakePublicationLeaseRenewIntervalMs,
      RESERVATION_RENEW_INTERVAL_MS,
      MAX_RESERVATION_RENEW_INTERVAL_MS
    )
  };
}

function resolveRelativeArtifactRoot(cwd, value) {
  const input = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_ARTIFACT_ROOT;
  if (path.isAbsolute(input)) throw intakeCodedError('CONTROL_CENTER_INTAKE_ROOT_REJECTED', 'The local intake location must stay in this workspace.');
  const absolute = path.resolve(cwd, input);
  const relative = path.relative(cwd, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw intakeCodedError('CONTROL_CENTER_INTAKE_ROOT_REJECTED', 'The local intake location must stay in this workspace.');
  }
  return relative;
}

async function* streamWithIdleTimeout(stream, value) {
  const requested = Number(value);
  const timeoutMs = Number.isInteger(requested) && requested > 0
    ? Math.min(requested, 120_000)
    : DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  const iterator = stream[Symbol.asyncIterator]();
  let timedOut = false;
  try {
    while (true) {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(intakeCodedError(
          'CONTROL_CENTER_INTAKE_STREAM_TIMEOUT',
          'The selected file took too long to arrive.'
        )), timeoutMs);
        timer.unref?.();
      });
      let item;
      try {
        item = await Promise.race([iterator.next(), timeout]);
      } finally {
        clearTimeout(timer);
      }
      if (item.done) return;
      yield item.value;
    }
  } catch (error) {
    if (error?.code === 'CONTROL_CENTER_INTAKE_STREAM_TIMEOUT') {
      timedOut = true;
      stream.destroy?.();
    }
    throw error;
  } finally {
    if (!timedOut) await iterator.return?.();
  }
}

function executionContext(context) {
  return { ...context, cwd: path.resolve(context.cwd ?? process.cwd()) };
}

function decodeUtf8(buffer) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { throw intakeCodedError('CONTROL_CENTER_INTAKE_UTF8_INVALID', 'Choose a valid UTF-8 text file.'); }
}

function materializeNow(value) {
  if (typeof value === 'function') return materializeNow(value());
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value ?? fallback);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function normalizeBoundedPositiveInteger(value, fallback, maximum) {
  return Math.min(normalizePositiveInteger(value, fallback), maximum);
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function invalid(code, message, details = {}) { return { ok: false, code, message, details }; }
function intakeCodedError(code, message) { const error = new Error(message); error.code = code; return error; }

function pendingPublicationError() {
  return intakeCodedError(
    'CONTROL_CENTER_INTAKE_PUBLICATION_PENDING',
    'The completed result is saved locally and can be finished without checking the file again.'
  );
}
function intakeOk(data) { return { status: 'ok', data: { control_center_intake: data }, warnings: [], errors: [], artifacts: [] }; }
function intakeError(code, message, details = {}) { return { status: 'error', data: { control_center_intake: null }, warnings: [], errors: [{ code, message, details }], artifacts: [] }; }
