import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { CLI_NAME, PACKAGE_VERSION } from './constants.js';
import { runFixedProcess } from './fixed-process-runner.js';
import { readPrivateMediaOperation } from './media-private-operation.js';
import { loadMediaReviewPolicy } from './media-review-policy.js';
import { hashStableRegularFile, inspectStableMediaFile } from './media-stable-file.js';
import { resolveTechnicalMediaToolchain } from './media-technical-analyzer.js';

const PREPARED_AUDIO_RECORD_VERSION = '1.0.0';

export async function prepareLocalMediaAudio(request, context = {}) {
  validatePreparationRequest(request);
  const policy = await loadMediaReviewPolicy(context);
  const contract = request.contract;
  const operation = await readPrivateMediaOperation(request.operation, context);
  assertInside(operation.root, request.mediaPath);
  const source = await inspectStableMediaFile(request.mediaPath, {
    maxBytes: policy.source.maximum_local_media_bytes,
    requirePrivate: true,
    extension: path.extname(request.mediaPath),
    signal: request.signal
  });
  if (source.sha256 !== request.mediaIdentity.sha256 || source.bytes !== request.mediaIdentity.bytes) {
    throw preparedAudioError('MEDIA_PREPARED_AUDIO_SOURCE_MISMATCH', 'The staged source changed before audio preparation.');
  }
  const toolchain = await resolveTechnicalMediaToolchain({ ...context, signal: request.signal ?? context.signal });
  const preparationDirectory = path.join(operation.root, 'prepared-audio');
  await mkdir(preparationDirectory, { mode: 0o700 });
  await chmod(preparationDirectory, 0o700);
  await assertPrivateDirectory(preparationDirectory);
  const nonce = randomBytes(12).toString('hex');
  const rawPath = path.join(preparationDirectory, `.audio-${nonce}.pcm`);
  const audioPath = path.join(preparationDirectory, 'audio.wav');
  const manifestPath = path.join(preparationDirectory, 'manifest.json');
  try {
    await extractCanonicalPcm({
      sourcePath: request.mediaPath,
      rawPath,
      operationRoot: operation.root,
      contract,
      policy,
      toolchain,
      signal: request.signal,
      runner: context.preparedAudioProcessRunner ?? context.technicalProcessRunner ?? context.fixedProcessRunner ?? runFixedProcess
    });
    await chmod(rawPath, 0o600);
    const maximumPcmBytes = policy.prepared_audio.maximum_prepared_audio_bytes - contract.format.header_bytes;
    const rawInfo = await lstat(rawPath, { bigint: true }).catch(() => null);
    if (rawInfo?.size >= BigInt(maximumPcmBytes)) {
      throw preparedAudioError('MEDIA_PREPARED_AUDIO_OUTPUT_LIMIT_REACHED', 'The prepared audio reached its configured private output limit.');
    }
    const raw = await hashStableRegularFile(rawPath, {
      maxBytes: maximumPcmBytes,
      requirePrivate: true,
      signal: request.signal
    });
    const bytesPerSample = contract.format.channel_count * (contract.format.bits_per_sample / 8);
    if (raw.bytes <= 0 || raw.bytes % bytesPerSample !== 0) {
      throw preparedAudioError('MEDIA_PREPARED_AUDIO_PCM_INVALID', 'The prepared PCM body has an invalid sample boundary.');
    }
    const sampleCount = raw.bytes / bytesPerSample;
    if (!Number.isSafeInteger(sampleCount) || sampleCount <= 0) {
      throw preparedAudioError('MEDIA_PREPARED_AUDIO_SAMPLE_COUNT_INVALID', 'The prepared audio sample count is invalid.');
    }
    const maximumWaveBytes = policy.prepared_audio.maximum_prepared_audio_bytes;
    if (raw.bytes + contract.format.header_bytes > maximumWaveBytes) {
      throw preparedAudioError('MEDIA_PREPARED_AUDIO_SIZE_LIMIT', 'The prepared audio exceeds the configured private size limit.');
    }
    await publishCanonicalWave(rawPath, audioPath, raw, contract, policy, request.signal);
    const audio = await inspectCanonicalWave(audioPath, contract, policy, request.signal);
    if (audio.sample_count !== sampleCount) {
      throw preparedAudioError('MEDIA_PREPARED_AUDIO_SAMPLE_COUNT_MISMATCH', 'The canonical WAV does not match the extracted PCM sample count.');
    }
    const sampleZeroSourceTimeMicroseconds = decodedTimelineOriginMicroseconds(request.decodedTimeline);
    const durationMilliseconds = Number(roundRationalHalfAwayFromZero(
      BigInt(sampleCount) * 1000n,
      BigInt(contract.format.sample_rate_hz)
    ));
    const settings = {
      schema_version: PREPARED_AUDIO_RECORD_VERSION,
      contract_schema_version: contract.schema_version,
      format: contract.format,
      preparation_method: policy.prepared_audio.preparation_method,
      source_stream: 'a:0',
      timeline_basis: request.decodedTimeline.basis,
      decoded_timeline_probe_packets: policy.technical_analyzer.decoded_timeline_probe_packets,
      protocol_allowlist: ['file', 'pipe'],
      decoder_threads: policy.technical_analyzer.decoder_threads,
      probe_identity: toolchain.probe.sha256,
      probe_version: toolchain.probe.version,
      analyzer_identity: toolchain.analyzer.sha256,
      analyzer_version: toolchain.analyzer.version
    };
    const settingsDigest = sha256Text(stableJson(settings));
    const manifest = {
      schemaVersion: contract.schema_version,
      kind: contract.manifest_kind,
      sourceMedia: {
        hashAlgorithm: 'sha256',
        digest: request.mediaIdentity.sha256,
        byteSize: request.mediaIdentity.bytes
      },
      preparedAudio: {
        hashAlgorithm: 'sha256',
        digest: audio.sha256,
        byteSize: audio.bytes,
        format: {
          container: contract.format.container,
          codec: contract.format.codec,
          sampleRateHz: contract.format.sample_rate_hz,
          channelCount: contract.format.channel_count,
          bitsPerSample: contract.format.bits_per_sample
        }
      },
      timeline: {
        sampleRateHz: contract.format.sample_rate_hz,
        sourceAudioSampleCount: sampleCount,
        preparedSampleCount: sampleCount,
        sourceAudioSampleZeroSourceTimeMicroseconds: sampleZeroSourceTimeMicroseconds,
        sampleZeroSourceTimeMicroseconds,
        trimmedLeadingSamples: 0,
        trimmedTrailingSamples: 0,
        paddedLeadingSamples: 0,
        paddedTrailingSamples: 0,
        durationMilliseconds,
        roundingRule: contract.rounding_rule
      },
      preparation: {
        producer: { id: CLI_NAME, version: PACKAGE_VERSION },
        method: policy.prepared_audio.preparation_method,
        settings: { hashAlgorithm: 'sha256', digest: settingsDigest },
        tools: [
          { id: path.basename(toolchain.probe.path), version: toolchain.probe.version },
          { id: path.basename(toolchain.analyzer.path), version: toolchain.analyzer.version }
        ]
      },
      limitations: [
        'caller_declared_source_identity',
        'first_decoded_pts_timeline',
        'resampler_delay_not_independently_measured'
      ],
      privacy: {
        sourceMediaPathIncluded: false,
        sourceUrlIncluded: false,
        transcriptBodyIncluded: false,
        externalSendRequired: false,
        networkRequired: false
      }
    };
    const manifestFile = await publishPrivateJson(manifestPath, manifest, policy.prepared_audio.maximum_manifest_bytes);
    await rm(rawPath, { force: true });
    return Object.freeze({
      schema_version: PREPARED_AUDIO_RECORD_VERSION,
      type: 'media_prepared_audio',
      contract: {
        schema_version: contract.schema_version,
        manifest_kind: contract.manifest_kind,
        format: structuredClone(contract.format),
        rounding_rule: contract.rounding_rule
      },
      source_media: { sha256: request.mediaIdentity.sha256, bytes: request.mediaIdentity.bytes },
      audio: { path: audioPath, sha256: audio.sha256, bytes: audio.bytes, sample_count: audio.sample_count },
      manifest: { path: manifestPath, sha256: manifestFile.sha256, bytes: manifestFile.bytes, value: manifest },
      timeline: structuredClone(manifest.timeline),
      preparation: {
        producer_id: CLI_NAME,
        producer_version: PACKAGE_VERSION,
        method: policy.prepared_audio.preparation_method,
        settings_identity: settingsDigest,
        analyzer_identity: toolchain.analyzer.sha256,
        analyzer_version: toolchain.analyzer.version
      },
      boundary: {
        private_root_only: true,
        raw_audio_publicly_included: false,
        manifest_publicly_included: false,
        source_path_included: false,
        network_performed: false,
        shell_used: false
      }
    });
  } catch (error) {
    await rm(rawPath, { force: true }).catch(() => {});
    throw error;
  }
}

export function roundRationalHalfAwayFromZero(numeratorValue, denominatorValue) {
  const numerator = BigInt(numeratorValue);
  const denominator = BigInt(denominatorValue);
  if (denominator <= 0n) throw preparedAudioError('MEDIA_PREPARED_AUDIO_RATIONAL_INVALID', 'A positive rational denominator is required.');
  const sign = numerator < 0n ? -1n : 1n;
  const magnitude = numerator < 0n ? -numerator : numerator;
  const quotient = magnitude / denominator;
  const remainder = magnitude % denominator;
  return sign * (quotient + (remainder * 2n >= denominator ? 1n : 0n));
}

export function decodedTimelineOriginMicroseconds(value) {
  if (value?.basis !== 'first_decoded_frame_pts') {
    throw preparedAudioError('MEDIA_PREPARED_AUDIO_TIMELINE_INVALID', 'A first-decoded-frame timeline is required.');
  }
  const video = decimalRational(value.video_first_timestamp_seconds);
  const audio = decimalRational(value.audio_first_timestamp_seconds);
  const numerator = (audio.numerator * video.denominator) - (video.numerator * audio.denominator);
  const denominator = audio.denominator * video.denominator;
  const microseconds = roundRationalHalfAwayFromZero(numerator * 1_000_000n, denominator);
  if (microseconds < BigInt(Number.MIN_SAFE_INTEGER) || microseconds > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw preparedAudioError('MEDIA_PREPARED_AUDIO_TIMELINE_INVALID', 'The prepared audio timeline origin is outside the supported range.');
  }
  return Number(microseconds);
}

async function extractCanonicalPcm({ sourcePath, rawPath, operationRoot, contract, policy, toolchain, signal, runner }) {
  const maximumPcmBytes = policy.prepared_audio.maximum_prepared_audio_bytes - contract.format.header_bytes;
  const result = await runner({
    executable: toolchain.analyzer.path,
    args: [
      '-hide_banner', '-v', 'error', '-nostdin',
      '-max_alloc', String(policy.technical_analyzer.maximum_single_allocation_bytes),
      '-threads', String(policy.technical_analyzer.decoder_threads),
      '-protocol_whitelist', 'file,pipe', '-i', sourcePath,
      '-map', '0:a:0', '-vn', '-sn', '-dn',
      '-map_metadata', '-1', '-map_chapters', '-1', '-flags:a', '+bitexact',
      '-t', microsecondsAsSeconds(policy.source.maximum_media_duration_us),
      '-ac', String(contract.format.channel_count),
      '-ar', String(contract.format.sample_rate_hz),
      '-c:a', contract.format.codec,
      '-f', 's16le', '-fs', String(maximumPcmBytes), '-y', rawPath
    ],
    cwd: operationRoot,
    env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: '/usr/bin:/bin' },
    timeoutMs: policy.technical_analyzer.timeout_ms,
    maxStdoutBytes: Math.min(policy.technical_analyzer.maximum_stdout_bytes, 256 * 1024),
    maxStderrBytes: policy.technical_analyzer.maximum_stderr_bytes,
    containDescendants: true,
    signal
  });
  if (!result?.ok) {
    if (result?.error?.code === 'FIXED_PROCESS_CONTAINMENT_UNCONFIRMED') {
      throw preparedAudioError('MEDIA_REVIEW_CONTAINMENT_UNCONFIRMED', 'The local audio preparation process stopped without confirmed descendant containment.');
    }
    throw preparedAudioError('MEDIA_PREPARED_AUDIO_EXTRACTION_FAILED', 'The local audio preparation process failed.', result?.error?.code);
  }
}

async function publishCanonicalWave(rawPath, audioPath, expectedRaw, contract, policy, signal) {
  const rawBytes = expectedRaw.bytes;
  const temporary = `${audioPath}.pending-${randomBytes(8).toString('hex')}`;
  const header = buildWaveHeader(rawBytes, contract.format);
  const input = await open(rawPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let output;
  try {
    const before = await input.stat({ bigint: true });
    if (!before.isFile()
      || before.nlink !== 1n
      || Number(before.mode & 0o777n) !== 0o600
      || (typeof process.getuid === 'function' && before.uid !== BigInt(process.getuid()))
      || Number(before.size) !== rawBytes
      || before.dev.toString() !== expectedRaw.identity.device
      || before.ino.toString() !== expectedRaw.identity.inode
      || before.mtimeNs.toString() !== expectedRaw.identity.modified_ns) {
      throw preparedAudioError('MEDIA_PREPARED_AUDIO_PCM_CHANGED', 'The PCM body changed before the WAV was built.');
    }
    output = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    await output.write(header);
    let copied = 0;
    const digest = createHash('sha256');
    const buffer = Buffer.alloc(Math.min(policy.prepared_audio.copy_chunk_bytes, rawBytes));
    while (copied < rawBytes) {
      if (signal?.aborted) throw preparedAudioError('MEDIA_PREPARED_AUDIO_ABORTED', 'Audio preparation was cancelled.');
      const length = Math.min(buffer.length, rawBytes - copied);
      const { bytesRead } = await input.read(buffer, 0, length, copied);
      if (bytesRead <= 0) throw preparedAudioError('MEDIA_PREPARED_AUDIO_PCM_CHANGED', 'The PCM body changed while the WAV was built.');
      digest.update(buffer.subarray(0, bytesRead));
      await output.write(buffer, 0, bytesRead);
      copied += bytesRead;
    }
    const after = await input.stat({ bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.nlink !== 1n) {
      throw preparedAudioError('MEDIA_PREPARED_AUDIO_PCM_CHANGED', 'The PCM body changed while the WAV was built.');
    }
    if (digest.digest('hex') !== expectedRaw.sha256) {
      throw preparedAudioError('MEDIA_PREPARED_AUDIO_PCM_CHANGED', 'The PCM body identity changed while the WAV was built.');
    }
    await output.sync();
    const written = await output.stat({ bigint: true });
    if (!written.isFile() || written.nlink !== 1n || Number(written.size) !== rawBytes + header.length) {
      throw preparedAudioError('MEDIA_PREPARED_AUDIO_WAVE_WRITE_INVALID', 'The canonical WAV publication is incomplete.');
    }
    await output.close();
    output = null;
    await rename(temporary, audioPath);
    await chmod(audioPath, 0o600);
  } finally {
    await input.close().catch(() => {});
    await output?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function inspectCanonicalWave(audioPath, contract, policy, signal) {
  const headerBytes = contract.format.header_bytes;
  const canonical = await realpath(audioPath).catch(() => null);
  const info = await lstat(audioPath, { bigint: true }).catch(() => null);
  if (canonical !== audioPath
    || !info?.isFile()
    || info.isSymbolicLink()
    || info.nlink !== 1n
    || Number(info.mode & 0o777n) !== 0o600
    || (typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid()))
    || info.size < BigInt(headerBytes)
    || info.size > BigInt(policy.prepared_audio.maximum_prepared_audio_bytes)) {
    throw preparedAudioError('MEDIA_PREPARED_AUDIO_WAVE_INVALID', 'The canonical WAV file is unsafe.');
  }
  const handle = await open(audioPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!sameFileSnapshot(info, before)) {
      throw preparedAudioError('MEDIA_PREPARED_AUDIO_WAVE_CHANGED', 'The canonical WAV changed before validation.');
    }
    const header = Buffer.alloc(headerBytes);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const bytes = Number(before.size);
    const dataBytes = bytes - headerBytes;
    const bytesPerSample = contract.format.channel_count * contract.format.bits_per_sample / 8;
    if (bytesRead !== header.length
      || header.toString('ascii', 0, 4) !== 'RIFF'
      || header.readUInt32LE(4) !== bytes - 8
      || header.toString('ascii', 8, 12) !== 'WAVE'
      || header.toString('ascii', 12, 16) !== 'fmt '
      || header.readUInt32LE(16) !== 16
      || header.readUInt16LE(20) !== 1
      || header.readUInt16LE(22) !== contract.format.channel_count
      || header.readUInt32LE(24) !== contract.format.sample_rate_hz
      || header.readUInt32LE(28) !== contract.format.sample_rate_hz * bytesPerSample
      || header.readUInt16LE(32) !== bytesPerSample
      || header.readUInt16LE(34) !== contract.format.bits_per_sample
      || header.toString('ascii', 36, 40) !== 'data'
      || header.readUInt32LE(40) !== dataBytes
      || dataBytes <= 0
      || dataBytes % bytesPerSample !== 0) {
      throw preparedAudioError('MEDIA_PREPARED_AUDIO_WAVE_INVALID', 'The canonical WAV does not match the versioned prepared-audio format.');
    }
    const digest = createHash('sha256');
    let inspectedBytes = 0;
    for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) {
      if (signal?.aborted) throw preparedAudioError('MEDIA_PREPARED_AUDIO_ABORTED', 'Audio preparation was cancelled.');
      inspectedBytes += chunk.length;
      if (inspectedBytes > policy.prepared_audio.maximum_prepared_audio_bytes) {
        throw preparedAudioError('MEDIA_PREPARED_AUDIO_SIZE_LIMIT', 'The prepared audio exceeds the configured private size limit.');
      }
      digest.update(chunk);
    }
    const after = await handle.stat({ bigint: true });
    if (inspectedBytes !== bytes || !sameFileSnapshot(before, after)) {
      throw preparedAudioError('MEDIA_PREPARED_AUDIO_WAVE_CHANGED', 'The canonical WAV changed during validation.');
    }
    return {
      path: audioPath,
      bytes,
      sha256: digest.digest('hex'),
      identity: {
        device: before.dev.toString(), inode: before.ino.toString(), size: bytes,
        modified_ns: before.mtimeNs.toString()
      },
      sample_count: dataBytes / bytesPerSample
    };
  } finally {
    await handle.close();
  }
}

function sameFileSnapshot(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.mode === right.mode
    && left.uid === right.uid
    && left.nlink === right.nlink
    && right.isFile();
}

function buildWaveHeader(dataBytes, format) {
  if (!Number.isSafeInteger(dataBytes) || dataBytes <= 0 || dataBytes > 0xffffffff - format.header_bytes) {
    throw preparedAudioError('MEDIA_PREPARED_AUDIO_SIZE_LIMIT', 'The PCM body cannot be represented by the canonical WAV contract.');
  }
  const bytesPerSample = format.channel_count * format.bits_per_sample / 8;
  const header = Buffer.alloc(format.header_bytes);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(dataBytes + format.header_bytes - 8, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(format.channel_count, 22);
  header.writeUInt32LE(format.sample_rate_hz, 24);
  header.writeUInt32LE(format.sample_rate_hz * bytesPerSample, 28);
  header.writeUInt16LE(bytesPerSample, 32);
  header.writeUInt16LE(format.bits_per_sample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

async function publishPrivateJson(target, value, maximumBytes) {
  const payload = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  if (payload.length <= 0 || payload.length > maximumBytes) {
    throw preparedAudioError('MEDIA_PREPARED_AUDIO_MANIFEST_LIMIT', 'The preparation manifest exceeds its configured size limit.');
  }
  const temporary = `${target}.pending-${randomBytes(8).toString('hex')}`;
  let handle;
  try {
    handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    await handle.writeFile(payload);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, target);
    await chmod(target, 0o600);
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
  return hashStableRegularFile(target, { maxBytes: maximumBytes, requirePrivate: true });
}

function decimalRational(value) {
  const match = /^(-?)(\d{1,12})(?:\.(\d{1,18}))?$/u.exec(String(value ?? ''));
  if (!match) throw preparedAudioError('MEDIA_PREPARED_AUDIO_TIMELINE_INVALID', 'A decoded timeline timestamp is invalid.');
  const fraction = match[3] ?? '';
  let numerator = BigInt(`${match[2]}${fraction}`);
  if (match[1] === '-') numerator = -numerator;
  return { numerator, denominator: 10n ** BigInt(fraction.length) };
}

function microsecondsAsSeconds(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw preparedAudioError('MEDIA_PREPARED_AUDIO_DURATION_LIMIT_INVALID', 'The prepared audio duration limit is invalid.');
  }
  const whole = Math.floor(value / 1_000_000);
  const fraction = String(value % 1_000_000).padStart(6, '0');
  return `${whole}.${fraction}`;
}

function validatePreparationRequest(request) {
  if (!request?.operation
    || !path.isAbsolute(request.mediaPath ?? '')
    || !/^[a-f0-9]{64}$/u.test(request.mediaIdentity?.sha256 ?? '')
    || !Number.isSafeInteger(request.mediaIdentity?.bytes)
    || request.mediaIdentity.bytes <= 0
    || !request.contract
    || request.contract.rounding_rule !== 'nearest-half-away-from-zero'
    || request.contract.format?.container !== 'wav'
    || request.contract.format?.codec !== 'pcm_s16le'
    || request.contract.format?.sample_rate_hz !== 16_000
    || request.contract.format?.channel_count !== 1
    || request.contract.format?.bits_per_sample !== 16
    || request.contract.format?.header_bytes !== 44) {
    throw preparedAudioError('MEDIA_PREPARED_AUDIO_REQUEST_INVALID', 'The prepared audio request does not match a supported versioned contract.');
  }
}

async function assertPrivateDirectory(directory) {
  const canonical = await realpath(directory);
  const info = await lstat(directory, { bigint: true });
  if (canonical !== directory
    || !info.isDirectory()
    || info.isSymbolicLink()
    || Number(info.mode & 0o777n) !== 0o700
    || (typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid()))) {
    throw preparedAudioError('MEDIA_PREPARED_AUDIO_DIRECTORY_INVALID', 'The prepared audio directory is not private.');
  }
}

function assertInside(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw preparedAudioError('MEDIA_PREPARED_AUDIO_PATH_ESCAPE', 'A prepared audio path escaped the private operation root.');
  }
}

function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function preparedAudioError(code, message, reason = null) {
  const error = new Error(message);
  error.code = code;
  error.details = reason ? { reason } : {};
  return error;
}
