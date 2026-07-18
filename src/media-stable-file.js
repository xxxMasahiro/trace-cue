import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

const HEADER_BYTES = 4096;

export async function inspectStableMediaFile(file, options = {}) {
  const inspected = await openStableRegularFile(file, options);
  try {
    const digest = createHash('sha256');
    const header = [];
    let headerBytes = 0;
    let bytes = 0;
    for await (const chunk of inspected.handle.createReadStream({ start: 0, autoClose: false })) {
      if (options.signal?.aborted) throw mediaFileError('MEDIA_FILE_ABORTED', 'Media inspection was cancelled.');
      bytes += chunk.length;
      if (bytes > inspected.maxBytes) throw mediaFileError('MEDIA_FILE_TOO_LARGE', 'The media file exceeds the configured size limit.');
      digest.update(chunk);
      if (headerBytes < HEADER_BYTES) {
        const take = Math.min(chunk.length, HEADER_BYTES - headerBytes);
        header.push(chunk.subarray(0, take));
        headerBytes += take;
      }
    }
    if (bytes === 0 || bytes !== Number(inspected.before.size)) throw mediaFileError('MEDIA_FILE_CHANGED', 'The media file changed while it was inspected.');
    const after = await inspected.handle.stat({ bigint: true });
    assertSameIdentity(inspected.before, after);
    return {
      path: inspected.path,
      bytes,
      sha256: digest.digest('hex'),
      format: validateMediaSignature(Buffer.concat(header), options.extension ?? path.extname(file)),
      identity: fileIdentity(inspected.before)
    };
  } finally {
    await inspected.handle.close();
  }
}

export async function copyStableMediaFile(source, destination, options = {}) {
  const inspected = await openStableRegularFile(source, options);
  const target = path.resolve(destination);
  if (!path.isAbsolute(target) || target === inspected.path) {
    await inspected.handle.close();
    throw mediaFileError('MEDIA_STAGE_PATH_INVALID', 'The private staging path is invalid.');
  }
  let output;
  try {
    output = await open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
  } catch (error) {
    await inspected.handle.close();
    throw mediaFileError('MEDIA_STAGE_CREATE_FAILED', 'The private media copy could not be created.', error?.code);
  }
  const digest = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of inspected.handle.createReadStream({ start: 0, autoClose: false })) {
      if (options.signal?.aborted) throw mediaFileError('MEDIA_FILE_ABORTED', 'Media staging was cancelled.');
      bytes += chunk.length;
      if (bytes > inspected.maxBytes) throw mediaFileError('MEDIA_FILE_TOO_LARGE', 'The media file exceeds the configured size limit.');
      digest.update(chunk);
      await output.write(chunk);
    }
    if (bytes === 0 || bytes !== Number(inspected.before.size)) throw mediaFileError('MEDIA_FILE_CHANGED', 'The media file changed while it was staged.');
    const sourceAfter = await inspected.handle.stat({ bigint: true });
    assertSameIdentity(inspected.before, sourceAfter);
    await output.sync();
    const targetInfo = await output.stat({ bigint: true });
    if (!targetInfo.isFile() || targetInfo.nlink !== 1n || Number(targetInfo.size) !== bytes) {
      throw mediaFileError('MEDIA_STAGE_IDENTITY_INVALID', 'The private media copy is invalid.');
    }
    await output.close();
    output = null;
    await chmod(target, 0o600);
    const result = await inspectStableMediaFile(target, {
      maxBytes: inspected.maxBytes,
      requireOwner: true,
      requirePrivate: true,
      extension: options.extension ?? path.extname(source),
      signal: options.signal
    });
    const sourceSha256 = digest.digest('hex');
    if (result.sha256 !== sourceSha256) throw mediaFileError('MEDIA_STAGE_DIGEST_MISMATCH', 'The private media copy does not match the selected source.');
    return { ...result, source_sha256: sourceSha256 };
  } finally {
    await inspected.handle.close();
    if (output) await output.close().catch(() => {});
  }
}

export async function hashStableRegularFile(file, options = {}) {
  const inspected = await openStableRegularFile(file, { ...options, allowAnyExtension: true });
  try {
    const digest = createHash('sha256');
    let bytes = 0;
    for await (const chunk of inspected.handle.createReadStream({ start: 0, autoClose: false })) {
      if (options.signal?.aborted) throw mediaFileError('MEDIA_FILE_ABORTED', 'File inspection was cancelled.');
      bytes += chunk.length;
      if (bytes > inspected.maxBytes) throw mediaFileError('MEDIA_FILE_TOO_LARGE', 'The file exceeds the configured size limit.');
      digest.update(chunk);
    }
    const after = await inspected.handle.stat({ bigint: true });
    assertSameIdentity(inspected.before, after);
    return { bytes, sha256: digest.digest('hex'), identity: fileIdentity(inspected.before), path: inspected.path };
  } finally {
    await inspected.handle.close();
  }
}

async function openStableRegularFile(file, options) {
  const absolute = path.resolve(String(file ?? ''));
  if (!path.isAbsolute(absolute) || absolute.includes('\u0000')) throw mediaFileError('MEDIA_FILE_PATH_INVALID', 'The media file path is invalid.');
  let info;
  try { info = await lstat(absolute, { bigint: true }); } catch (error) { throw mediaFileError('MEDIA_FILE_UNAVAILABLE', 'The media file is unavailable.', error?.code); }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) throw mediaFileError('MEDIA_FILE_TYPE_INVALID', 'The media source must be a single regular file.');
  if (await realpath(absolute) !== absolute) throw mediaFileError('MEDIA_FILE_REALPATH_INVALID', 'The media source path is not stable.');
  if (options.requireOwner !== false && typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid())) {
    throw mediaFileError('MEDIA_FILE_OWNER_INVALID', 'The media source owner is invalid.');
  }
  const mode = Number(info.mode & 0o777n);
  if (options.requirePrivate === true && mode !== 0o600) throw mediaFileError('MEDIA_FILE_MODE_INVALID', 'The private media file mode is invalid.');
  if ((mode & 0o022) !== 0) throw mediaFileError('MEDIA_FILE_MODE_UNSAFE', 'The media source is writable by another principal.');
  const maxBytes = normalizeLimit(options.maxBytes, 1, 1024 * 1024 * 1024, 100 * 1024 * 1024);
  if (info.size <= 0n || info.size > BigInt(maxBytes)) throw mediaFileError('MEDIA_FILE_TOO_LARGE', 'The media file size is not supported.');
  const handle = await open(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  const before = await handle.stat({ bigint: true });
  assertSameIdentity(info, before);
  return { handle, before, path: absolute, maxBytes };
}

function validateMediaSignature(header, extensionValue) {
  const extension = String(extensionValue ?? '').toLowerCase();
  if (header.length >= 12 && header.subarray(4, 8).toString('ascii') === 'ftyp') {
    if (!['.mp4', '.mov', '.m4v'].includes(extension)) throw mediaFileError('MEDIA_FILE_SIGNATURE_MISMATCH', 'The media signature does not match the selected file type.');
    return extension === '.mov' ? 'quicktime' : 'iso-base-media';
  }
  if (header.length >= 4 && header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    if (!['.mkv', '.webm'].includes(extension)) throw mediaFileError('MEDIA_FILE_SIGNATURE_MISMATCH', 'The media signature does not match the selected file type.');
    return extension === '.webm' ? 'webm' : 'matroska';
  }
  throw mediaFileError('MEDIA_FILE_SIGNATURE_UNSUPPORTED', 'The selected media container is not supported.');
}

function assertSameIdentity(left, right) {
  if (left.dev !== right.dev || left.ino !== right.ino || left.size !== right.size || left.mtimeNs !== right.mtimeNs || left.nlink !== right.nlink || !right.isFile()) {
    throw mediaFileError('MEDIA_FILE_CHANGED', 'The media file changed while it was inspected.');
  }
}

function fileIdentity(info) {
  return {
    device: info.dev.toString(),
    inode: info.ino.toString(),
    size: Number(info.size),
    modified_ns: info.mtimeNs.toString()
  };
}

function normalizeLimit(value, min, max, fallback) {
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}

export function mediaFileError(code, message, reason = null) {
  const error = new Error(message);
  error.code = code;
  error.details = reason ? { reason } : {};
  return error;
}
