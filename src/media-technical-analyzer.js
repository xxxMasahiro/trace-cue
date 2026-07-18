import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { runFixedProcess } from './fixed-process-runner.js';
import { loadMediaReviewPolicy } from './media-review-policy.js';
import { inspectStableMediaFile } from './media-stable-file.js';

const ANALYSIS_SCHEMA_VERSION = '1.0.0';
const TOOL_HASH_LIMIT = 512 * 1024 * 1024;

export async function inspectTechnicalMediaReadiness(context = {}) {
  try {
    const toolchain = await resolveTechnicalMediaToolchain(context);
    return {
      schema_version: ANALYSIS_SCHEMA_VERSION,
      type: 'media_technical_analyzer_readiness',
      status: 'ready',
      capabilities: ['container_probe', 'frame_timing', 'duplicate_frame_detection', 'presentation_gap_detection', 'scene_change_detection', 'subtitle_timing', 'container_pts_sync', 'first_decoded_timeline_origin'],
      method: projectToolchain(toolchain),
      limitations: ['container_pts_sync_is_not_perceptual_lip_sync'],
      boundary: analyzerBoundary()
    };
  } catch (error) {
    return {
      schema_version: ANALYSIS_SCHEMA_VERSION,
      type: 'media_technical_analyzer_readiness',
      status: 'unavailable',
      capabilities: [],
      limitations: [safeCode(error)],
      boundary: analyzerBoundary()
    };
  }
}

export async function preflightLocalMediaTechnical(request, context = {}) {
  validateAnalysisRequest(request);
  const policy = await loadMediaReviewPolicy(context);
  const inspectedMedia = await (context.inspectTechnicalMediaFile ?? inspectStableMediaFile)(request.mediaPath, {
    maxBytes: policy.source.maximum_local_media_bytes,
    requirePrivate: true,
    extension: path.extname(request.mediaPath),
    signal: request.signal
  });
  if (inspectedMedia.sha256 !== request.mediaIdentity.sha256 || inspectedMedia.bytes !== request.mediaIdentity.bytes) {
    throw analyzerError('MEDIA_ANALYZER_MEDIA_IDENTITY_MISMATCH', 'The staged media does not match the accepted media identity.');
  }
  const toolchain = await resolveTechnicalMediaToolchain({ ...context, signal: request.signal ?? context.signal });
  const runner = context.technicalProcessRunner ?? context.fixedProcessRunner ?? runFixedProcess;
  const probed = await probeTechnicalMetadata(request, policy, toolchain, runner);
  const decodedTimeline = request.includeDecodedTimeline === true
    ? await probeFirstDecodedTimeline(request, policy, toolchain, runner)
    : null;
  return {
    schema_version: ANALYSIS_SCHEMA_VERSION,
    type: 'media_technical_preflight',
    status: 'ready',
    media_identity: { sha256: inspectedMedia.sha256, bytes: inspectedMedia.bytes, format: inspectedMedia.format },
    duration_us: probed.durationUs,
    video: { width: probed.videoStream.width, height: probed.videoStream.height },
    stream_counts: probed.streamCounts,
    decoded_timeline: decodedTimeline,
    boundary: analyzerBoundary()
  };
}

export async function analyzeLocalMediaTechnical(request, context = {}) {
  validateAnalysisRequest(request);
  const policy = await loadMediaReviewPolicy(context);
  const limits = policy.technical_analyzer;
  const inspectedMedia = await (context.inspectTechnicalMediaFile ?? inspectStableMediaFile)(request.mediaPath, {
    maxBytes: policy.source.maximum_local_media_bytes,
    requirePrivate: true,
    extension: path.extname(request.mediaPath),
    signal: request.signal
  });
  if (inspectedMedia.sha256 !== request.mediaIdentity.sha256 || inspectedMedia.bytes !== request.mediaIdentity.bytes) {
    throw analyzerError('MEDIA_ANALYZER_MEDIA_IDENTITY_MISMATCH', 'The staged media does not match the accepted media identity.');
  }
  const toolchain = await resolveTechnicalMediaToolchain({ ...context, signal: request.signal ?? context.signal });
  const runner = context.technicalProcessRunner ?? context.fixedProcessRunner ?? runFixedProcess;
  const { durationUs, videoStream, audioStream } = await probeTechnicalMetadata(request, policy, toolchain, runner);
  // ffprobe has no `-nostdin` option. The fixed runner closes stdin instead.
  const commonProbe = ['-v', 'error', '-max_alloc', String(limits.maximum_single_allocation_bytes), '-protocol_whitelist', 'file,pipe', '-of', 'json'];

  const frameResult = await runTool(runner, toolchain.analyzer, [
    '-v', 'error', '-nostdin', '-max_alloc', String(limits.maximum_single_allocation_bytes), '-threads', String(limits.decoder_threads), '-protocol_whitelist', 'file,pipe', '-i', request.mediaPath,
    '-map', '0:v:0', '-an', '-frames:v', String(limits.maximum_frames), '-f', 'framemd5', '-'
  ], request.operationRoot, limits, request.signal);
  const frameData = parseFrameMd5(frameResult.stdout.toString('utf8'), limits);
  if (frameData.frames.length === 0) throw analyzerError('MEDIA_ANALYZER_FRAME_DATA_UNAVAILABLE', 'No frame timing evidence was produced.');

  const cutResult = await runTool(runner, toolchain.analyzer, [
    '-hide_banner', '-v', 'info', '-nostdin', '-max_alloc', String(limits.maximum_single_allocation_bytes), '-threads', String(limits.decoder_threads), '-filter_threads', String(limits.decoder_threads), '-protocol_whitelist', 'file,pipe', '-i', request.mediaPath,
    '-map', '0:v:0', '-vf', `select='gt(scene,${limits.cut_scene_threshold})',metadata=print:key=lavfi.scene_score`,
    '-an', '-frames:v', String(limits.maximum_frames), '-f', 'null', '-'
  ], request.operationRoot, limits, request.signal, { allowStderr: true });
  const cutData = parseSceneChanges(
    cutResult.stderr.toString('utf8'),
    durationUs,
    limits,
    policy.operation.maximum_timeline_items
  );
  const cuts = cutData.events;

  const subtitleResult = await runTool(runner, toolchain.probe, [
    ...commonProbe,
    '-select_streams', 's:0', '-show_packets',
    '-show_entries', 'packet=pts_time,duration_time',
    '-read_intervals', `0%+#${limits.maximum_subtitle_events}`,
    request.mediaPath
  ], request.operationRoot, limits, request.signal);
  const subtitlePayload = parseJson(subtitleResult.stdout, 'MEDIA_ANALYZER_SUBTITLE_INVALID');
  const subtitleEvents = normalizeSubtitlePackets(subtitlePayload.packets ?? [], limits, durationUs);
  const timing = computeFrameTiming(
    frameData,
    videoStream,
    limits,
    policy.operation.maximum_timeline_items,
    durationUs + policy.transcript_provider.maximum_timeline_overrun_us
  );
  const avSync = computeAvSync(videoStream, audioStream, limits);
  const shotBoundaries = buildShotBoundaries(cuts, durationUs);
  const limitations = [
    'container_pts_sync_is_not_perceptual_lip_sync',
    'presentation_gaps_are_inferred_from_encoded_timestamps',
    'scene_changes_are_threshold_based'
  ];
  if (frameData.frames.length >= limits.maximum_frames) limitations.push('frame_scan_limit_reached');
  if (timing.timestampsTruncated) limitations.push('presentation_timestamps_truncated');
  if (timing.eventsTruncated) limitations.push('frame_event_evidence_truncated');
  if (cutData.truncated) limitations.push('scene_change_evidence_truncated');
  if ((subtitlePayload.packets ?? []).length >= limits.maximum_subtitle_events) limitations.push('subtitle_packet_limit_reached');
  if (!audioStream) limitations.push('audio_stream_unavailable');
  return {
    schema_version: ANALYSIS_SCHEMA_VERSION,
    type: 'media_technical_analysis',
    status: audioStream ? 'available' : 'partial',
    media_identity: { sha256: request.mediaIdentity.sha256, bytes: request.mediaIdentity.bytes, format: request.mediaIdentity.format },
    timebase: 'microseconds',
    technical_metrics: {
      duration_us: durationUs,
      video_codec: safeCodec(videoStream.codec_name),
      audio_codec: safeCodec(audioStream?.codec_name),
      frame_count_analyzed: frameData.frames.length,
      effective_fps: timing.effectiveFps,
      nominal_fps: parseRate(videoStream.avg_frame_rate ?? videoStream.r_frame_rate),
      median_frame_interval_us: timing.medianIntervalUs,
      frame_interval_variance_us2: timing.varianceUs2,
      frame_interval_jitter_ratio: timing.jitterRatio,
      duplicate_frame_count: timing.duplicateFrameCount,
      presentation_gap_count: timing.droppedIntervalCount,
      cut_count: cutData.totalCount,
      subtitle_event_count: subtitleEvents.length,
      presentation_timestamps_us: timing.presentationTimestampsUs,
      deterministic: true
    },
    frame_intervals: {
      minimum_us: timing.minimumIntervalUs,
      maximum_us: timing.maximumIntervalUs,
      median_us: timing.medianIntervalUs,
      variance_us2: timing.varianceUs2,
      jitter_ratio: timing.jitterRatio,
      warning: timing.jitterRatio !== null && timing.jitterRatio > limits.interval_jitter_warning_ratio
    },
    duplicate_frames: timing.duplicateFrames,
    dropped_frame_intervals: timing.droppedIntervals,
    audio_video_sync: avSync,
    shot_boundaries: shotBoundaries,
    subtitle_events: subtitleEvents,
    method: {
      classification: 'deterministic_measurement',
      analyzer_contract: 'ffmpeg-cli-local-v1',
      ...projectToolchain(toolchain),
      scene_threshold: limits.cut_scene_threshold,
      maximum_frames: limits.maximum_frames
    },
    limitations,
    boundary: analyzerBoundary()
  };
}

export async function resolveTechnicalMediaToolchain(context = {}) {
  if (context.technicalMediaToolchain) return Object.freeze(structuredClone(context.technicalMediaToolchain));
  const policy = await loadMediaReviewPolicy(context);
  const runner = context.technicalProcessRunner ?? context.fixedProcessRunner ?? runFixedProcess;
  const probe = await resolveTool(
    process.env[policy.technical_analyzer.probe_executable_environment],
    policy.technical_analyzer.probe_candidates,
    'ffprobe',
    runner,
    context.signal ?? null
  );
  const analyzer = await resolveTool(
    process.env[policy.technical_analyzer.analyzer_executable_environment],
    policy.technical_analyzer.analyzer_candidates,
    'ffmpeg',
    runner,
    context.signal ?? null
  );
  return Object.freeze({ probe, analyzer });
}

async function resolveTool(configured, candidates, expectedName, runner, signal = null) {
  const choices = configured ? [configured] : candidates;
  for (const choice of choices) {
    try {
      if (!path.isAbsolute(choice) || path.basename(choice) !== expectedName || choice.includes('\u0000')) continue;
      const canonical = await realpath(choice);
      if (canonical !== choice) continue;
      const info = await lstat(choice, { bigint: true });
      const mappedSystemOwner = info.uid === 65534n && (choice.startsWith('/usr/bin/') || choice.startsWith('/bin/'));
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size > BigInt(TOOL_HASH_LIMIT)) continue;
      if (typeof process.getuid === 'function' && info.uid !== 0n && info.uid !== BigInt(process.getuid()) && !mappedSystemOwner) continue;
      const mode = Number(info.mode & 0o777n);
      if ((mode & 0o022) !== 0 || (mode & 0o111) === 0) continue;
      const sha256 = await hashStableTool(choice, info);
      const versionResult = await runner({
        executable: choice, args: ['-version'], cwd: '/', env: { LANG: 'C.UTF-8', PATH: '/usr/bin:/bin' },
        timeoutMs: 15_000, maxStdoutBytes: 128 * 1024, maxStderrBytes: 128 * 1024, signal
      });
      if (!versionResult?.ok) continue;
      const firstLine = versionResult.stdout.toString('utf8').split(/\r?\n/u)[0] ?? '';
      const match = firstLine.match(new RegExp(`^${expectedName} version ([^\\s]+)`, 'u'));
      if (!match) continue;
      return { path: choice, sha256, version: match[1] };
    } catch {}
  }
  throw analyzerError('MEDIA_ANALYZER_TOOL_UNAVAILABLE', `The required ${expectedName} executable is unavailable.`);
}

async function probeTechnicalMetadata(request, policy, toolchain, runner) {
  const limits = policy.technical_analyzer;
  const result = await runTool(runner, toolchain.probe, [
    '-v', 'error', '-max_alloc', String(limits.maximum_single_allocation_bytes),
    '-protocol_whitelist', 'file,pipe', '-of', 'json',
    '-show_streams', '-show_format',
    '-show_entries', 'stream=index,codec_type,codec_name,time_base,start_time,duration,avg_frame_rate,r_frame_rate,nb_frames,sample_rate,channels,width,height:format=duration,size,format_name',
    request.mediaPath
  ], request.operationRoot, limits, request.signal);
  const metadata = parseJson(result.stdout, 'MEDIA_ANALYZER_METADATA_INVALID');
  if (!Array.isArray(metadata.streams) || metadata.streams.length === 0 || metadata.streams.length > limits.maximum_total_streams) {
    throw analyzerError('MEDIA_ANALYZER_STREAM_LIMIT', 'The media stream count is unsupported.');
  }
  const videoStreams = metadata.streams.filter((stream) => stream?.codec_type === 'video');
  const audioStreams = metadata.streams.filter((stream) => stream?.codec_type === 'audio');
  const subtitleStreams = metadata.streams.filter((stream) => stream?.codec_type === 'subtitle');
  if (videoStreams.length === 0
    || videoStreams.length > limits.maximum_video_streams
    || audioStreams.length > limits.maximum_audio_streams
    || subtitleStreams.length > limits.maximum_subtitle_streams) {
    throw analyzerError('MEDIA_ANALYZER_STREAM_LIMIT', 'The media stream layout is unsupported.');
  }
  for (const stream of videoStreams) {
    const width = strictPositiveInteger(stream.width);
    const height = strictPositiveInteger(stream.height);
    if (width === null || height === null || width > limits.maximum_video_width || height > limits.maximum_video_height
      || width * height > limits.maximum_video_pixels) {
      throw analyzerError('MEDIA_ANALYZER_RESOLUTION_LIMIT', 'A video stream exceeds the local safety limit.');
    }
  }
  const videoStream = videoStreams[0];
  for (const stream of audioStreams) {
    const sampleRate = strictPositiveInteger(stream.sample_rate);
    const channels = strictPositiveInteger(stream.channels);
    if (sampleRate === null || channels === null || sampleRate > limits.maximum_audio_sample_rate || channels > limits.maximum_audio_channels) {
      throw analyzerError('MEDIA_ANALYZER_AUDIO_LIMIT', 'The audio stream exceeds the local safety limit.');
    }
  }
  const durationUs = secondsToUs(metadata?.format?.duration);
  if (durationUs === null || durationUs <= 0 || durationUs > policy.source.maximum_media_duration_us) {
    throw analyzerError('MEDIA_ANALYZER_DURATION_UNSUPPORTED', 'The media duration is unavailable or exceeds policy.');
  }
  return {
    durationUs,
    videoStream,
    audioStream: audioStreams[0] ?? null,
    streamCounts: { total: metadata.streams.length, video: videoStreams.length, audio: audioStreams.length, subtitle: subtitleStreams.length }
  };
}

async function probeFirstDecodedTimeline(request, policy, toolchain, runner) {
  const [video, audio] = await Promise.all([
    probeFirstDecodedTimestamp('v:0', request, policy, toolchain, runner),
    probeFirstDecodedTimestamp('a:0', request, policy, toolchain, runner)
  ]);
  if (video === null) throw analyzerError('MEDIA_ANALYZER_VIDEO_TIMELINE_UNAVAILABLE', 'The first decoded video timestamp is unavailable.');
  if (audio === null) throw analyzerError('MEDIA_ANALYZER_AUDIO_TIMELINE_UNAVAILABLE', 'The selected media has no usable decoded audio timeline.');
  return {
    basis: 'first_decoded_frame_pts',
    video_first_timestamp_seconds: video,
    audio_first_timestamp_seconds: audio
  };
}

async function probeFirstDecodedTimestamp(selector, request, policy, toolchain, runner) {
  const limits = policy.technical_analyzer;
  const result = await runTool(runner, toolchain.probe, [
    '-v', 'error', '-max_alloc', String(limits.maximum_single_allocation_bytes),
    '-protocol_whitelist', 'file,pipe', '-of', 'json',
    '-select_streams', selector, '-show_frames',
    '-show_entries', 'frame=best_effort_timestamp_time,pts_time',
    '-read_intervals', `%+#${limits.decoded_timeline_probe_packets}`, request.mediaPath
  ], request.operationRoot, limits, request.signal);
  const payload = parseJson(result.stdout, 'MEDIA_ANALYZER_DECODED_TIMELINE_INVALID');
  if (!Array.isArray(payload.frames)) return null;
  for (const frame of payload.frames) {
    for (const candidate of [frame?.best_effort_timestamp_time, frame?.pts_time]) {
      if (typeof candidate === 'string' && /^-?\d{1,12}(?:\.\d{1,18})?$/u.test(candidate)) return candidate;
    }
  }
  return null;
}

function strictPositiveInteger(value) {
  const normalized = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : null;
}

async function hashStableTool(file, expected) {
  const handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  const hash = createHash('sha256');
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== expected.dev || opened.ino !== expected.ino || opened.size !== expected.size || opened.mtimeNs !== expected.mtimeNs) {
      throw analyzerError('MEDIA_ANALYZER_TOOL_CHANGED', 'An analyzer tool changed while it was inspected.');
    }
    const buffer = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const completed = await handle.stat({ bigint: true });
    if (completed.dev !== opened.dev || completed.ino !== opened.ino || completed.size !== opened.size || completed.mtimeNs !== opened.mtimeNs) {
      throw analyzerError('MEDIA_ANALYZER_TOOL_CHANGED', 'An analyzer tool changed while it was inspected.');
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function runTool(runner, tool, args, cwd, limits, signal, options = {}) {
  const result = await runner({
    executable: tool.path,
    args,
    cwd,
    env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: '/usr/bin:/bin' },
    timeoutMs: limits.timeout_ms,
    maxStdoutBytes: limits.maximum_stdout_bytes,
    maxStderrBytes: limits.maximum_stderr_bytes,
    signal
  });
  if (!result?.ok) throw analyzerError('MEDIA_ANALYZER_EXECUTION_FAILED', 'The local technical analyzer failed.', result?.error?.code);
  if (!options.allowStderr && result.stderr?.length > 0) {
    const text = result.stderr.toString('utf8');
    if (/\b(?:error|invalid|failed)\b/iu.test(text)) throw analyzerError('MEDIA_ANALYZER_EXECUTION_WARNING', 'The local technical analyzer reported an error.');
  }
  return result;
}

function parseFrameMd5(body, limits) {
  let timebase = null;
  const frames = [];
  for (const line of body.split(/\r?\n/u)) {
    if (line.startsWith('#tb ')) {
      const match = line.match(/^#tb\s+\d+:\s*(\d+)\/(\d+)$/u);
      if (match) timebase = { numerator: Number(match[1]), denominator: Number(match[2]) };
      continue;
    }
    if (!line || line.startsWith('#')) continue;
    const fields = line.split(',').map((value) => value.trim());
    if (fields.length < 6 || frames.length >= limits.maximum_frames) continue;
    const pts = Number(fields[2]);
    const duration = Number(fields[3]);
    const hash = fields[5];
    if (!Number.isSafeInteger(pts) || pts < 0 || !Number.isSafeInteger(duration) || duration < 0 || !/^[a-f0-9]{16,128}$/iu.test(hash)) continue;
    frames.push({ pts, duration, hash: hash.toLowerCase() });
  }
  if (!timebase || !Number.isSafeInteger(timebase.numerator) || timebase.numerator <= 0 || !Number.isSafeInteger(timebase.denominator) || timebase.denominator <= 0) {
    throw analyzerError('MEDIA_ANALYZER_FRAME_TIMEBASE_INVALID', 'The analyzer frame timebase is invalid.');
  }
  return { timebase, frames };
}

function computeFrameTiming(frameData, videoStream, limits, maximumTimelineItems, maximumTimestampUs) {
  const timestamps = frameData.frames.map((frame) => ticksToMicroseconds(frame.pts, frameData.timebase));
  if (timestamps.some((value) => value === null || value < 0 || value > maximumTimestampUs)) {
    throw analyzerError('MEDIA_ANALYZER_FRAME_TIMELINE_INVALID', 'The analyzer frame timeline is outside the measured media duration.');
  }
  const intervals = [];
  for (let index = 1; index < timestamps.length; index += 1) {
    const interval = timestamps[index] - timestamps[index - 1];
    if (interval < 0) throw analyzerError('MEDIA_ANALYZER_FRAME_TIMELINE_INVALID', 'The analyzer frame timeline is not monotonic.');
    intervals.push(interval);
  }
  const sorted = [...intervals].sort((a, b) => a - b);
  const median = sorted.length ? percentile(sorted, 0.5) : rateToInterval(videoStream.avg_frame_rate ?? videoStream.r_frame_rate);
  const mean = intervals.length ? intervals.reduce((sum, value) => sum + value, 0) / intervals.length : null;
  const variance = mean === null ? null : intervals.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / intervals.length;
  const jitter = median && variance !== null ? Math.sqrt(variance) / median : null;
  const duplicateFrames = [];
  const droppedIntervals = [];
  for (let index = 1; index < frameData.frames.length; index += 1) {
    const firstCandidate = Math.max(0, index - limits.duplicate_hash_window);
    let duplicateOf = null;
    for (let prior = index - 1; prior >= firstCandidate; prior -= 1) {
      if (frameData.frames[index].hash === frameData.frames[prior].hash) {
        duplicateOf = prior;
        break;
      }
    }
    if (duplicateOf !== null) {
      duplicateFrames.push({
        start_us: timestamps[duplicateOf], end_us: timestamps[index],
        frame_index: index, matched_frame_index: duplicateOf, classification: 'deterministic_measurement'
      });
    }
    const interval = timestamps[index] - timestamps[index - 1];
    if (median && interval > median * limits.dropped_interval_multiplier) {
      droppedIntervals.push({
        start_us: timestamps[index - 1], end_us: timestamps[index], interval_us: interval,
        expected_interval_us: median, estimated_missing_frames: Math.max(1, Math.round(interval / median) - 1),
        classification: 'deterministic_measurement'
      });
    }
  }
  const span = timestamps.length > 1 ? timestamps.at(-1) - timestamps[0] : 0;
  return {
    effectiveFps: span > 0 ? round((timestamps.length - 1) * 1_000_000 / span, 6) : null,
    medianIntervalUs: median === null ? null : Math.round(median),
    minimumIntervalUs: sorted.length ? sorted[0] : null,
    maximumIntervalUs: sorted.length ? sorted.at(-1) : null,
    varianceUs2: variance === null ? null : Math.round(variance),
    jitterRatio: jitter === null ? null : round(jitter, 6),
    duplicateFrames: duplicateFrames.slice(0, maximumTimelineItems),
    droppedIntervals: droppedIntervals.slice(0, maximumTimelineItems),
    duplicateFrameCount: duplicateFrames.length,
    droppedIntervalCount: droppedIntervals.length,
    eventsTruncated: duplicateFrames.length > maximumTimelineItems || droppedIntervals.length > maximumTimelineItems,
    presentationTimestampsUs: timestamps.slice(0, maximumTimelineItems),
    timestampsTruncated: timestamps.length > maximumTimelineItems
  };
}

function parseSceneChanges(stderr, durationUs, limits, maximumEvents) {
  const events = [];
  const lines = stderr.split(/\r?\n/u);
  let pendingTime = null;
  for (const line of lines) {
    const frame = line.match(/frame:\d+\s+pts:\d+\s+pts_time:([0-9.]+)/u);
    if (frame) pendingTime = secondsToUs(frame[1]);
    const score = line.match(/lavfi\.scene_score=([0-9.]+)/u);
    if (score && pendingTime !== null && pendingTime > 0 && pendingTime < durationUs) {
      events.push({ at_us: pendingTime, score: round(Number(score[1]), 6), threshold: limits.cut_scene_threshold, classification: 'deterministic_measurement' });
      pendingTime = null;
    }
  }
  const deduplicated = deduplicateTimes(events);
  return {
    events: deduplicated.slice(0, maximumEvents),
    totalCount: deduplicated.length,
    truncated: deduplicated.length > maximumEvents
  };
}

function buildShotBoundaries(cuts, durationUs) {
  const boundaries = [0, ...cuts.map((cut) => cut.at_us), durationUs];
  const shots = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    shots.push({
      id: `shot-${String(index + 1).padStart(4, '0')}`,
      start_us: boundaries[index], end_us: boundaries[index + 1],
      cut_score: index === 0 ? null : cuts[index - 1]?.score ?? null,
      classification: 'deterministic_measurement'
    });
  }
  return shots;
}

function normalizeSubtitlePackets(packets, limits, mediaDurationUs) {
  return packets.slice(0, limits.maximum_subtitle_events).flatMap((packet, index) => {
    const startUs = secondsToUs(packet.pts_time);
    const durationUs = secondsToUs(packet.duration_time);
    if (startUs === null || durationUs === null) return [];
    const endUs = startUs + durationUs;
    if (!Number.isSafeInteger(endUs) || endUs < startUs || endUs > mediaDurationUs) {
      throw analyzerError('MEDIA_ANALYZER_SUBTITLE_TIMELINE_INVALID', 'A subtitle packet is outside the measured media duration.');
    }
    return [{
      id: `subtitle-${String(index + 1).padStart(5, '0')}`,
      start_us: startUs, end_us: endUs, duration_us: durationUs,
      duration_sufficient: durationUs >= limits.subtitle_minimum_us,
      classification: 'deterministic_measurement', body_included: false
    }];
  });
}

function computeAvSync(videoStream, audioStream, limits) {
  if (!audioStream) {
    return { status: 'unavailable', method: 'container_stream_start_pts', offset_us: null, warning: false, classification: 'deterministic_measurement' };
  }
  const videoStart = secondsToSignedUs(videoStream.start_time) ?? 0;
  const audioStart = secondsToSignedUs(audioStream.start_time) ?? 0;
  const offset = audioStart - videoStart;
  return {
    status: 'available', method: 'container_stream_start_pts', offset_us: offset,
    absolute_offset_us: Math.abs(offset), warning: Math.abs(offset) > limits.av_sync_warning_us,
    interpretation: offset > 0 ? 'audio_starts_after_video' : offset < 0 ? 'audio_starts_before_video' : 'aligned_container_start',
    classification: 'deterministic_measurement', perceptual_lip_sync_measured: false
  };
}

function projectToolchain(toolchain) {
  return {
    probe_version: toolchain.probe.version,
    analyzer_version: toolchain.analyzer.version,
    probe_identity: toolchain.probe.sha256,
    analyzer_identity: toolchain.analyzer.sha256,
    absolute_paths_included: false
  };
}

function analyzerBoundary() {
  return {
    local_only: true, raw_media_included: false, raw_audio_included: false, raw_frames_included: false,
    base64_included: false, absolute_paths_included: false, external_send_performed: false,
    network_performed: false, shell_used: false
  };
}

function parseJson(buffer, code) {
  try {
    const value = JSON.parse(buffer.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape');
    return value;
  } catch { throw analyzerError(code, 'The analyzer returned invalid JSON.'); }
}

function secondsToUs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER / 1_000_000 ? Math.round(number * 1_000_000) : null;
}

function secondsToSignedUs(value) {
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= Number.MAX_SAFE_INTEGER / 1_000_000
    ? Math.round(number * 1_000_000)
    : null;
}

function ticksToMicroseconds(ticks, timebase) {
  try {
    const numerator = BigInt(ticks) * BigInt(timebase.numerator) * 1_000_000n;
    const denominator = BigInt(timebase.denominator);
    const rounded = (numerator + (denominator / 2n)) / denominator;
    return rounded <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(rounded) : null;
  } catch {
    return null;
  }
}

function parseRate(value) {
  const match = String(value ?? '').match(/^(\d{1,18})\/(\d{1,18})$/u);
  if (!match) return null;
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (!Number.isSafeInteger(numerator) || numerator <= 0 || !Number.isSafeInteger(denominator) || denominator <= 0) return null;
  const valueNumber = numerator / denominator;
  return Number.isFinite(valueNumber) && valueNumber > 0 ? round(valueNumber, 6) : null;
}

function rateToInterval(value) {
  const rate = parseRate(value);
  return rate ? 1_000_000 / rate : null;
}

function percentile(sorted, fraction) {
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + ((sorted[upper] - sorted[lower]) * (position - lower));
}

function deduplicateTimes(events) {
  const result = [];
  for (const event of events.sort((a, b) => a.at_us - b.at_us)) {
    if (!result.length || Math.abs(result.at(-1).at_us - event.at_us) > 1000) result.push(event);
  }
  return result;
}

function safeCodec(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,80}$/u.test(value) ? value : null;
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function safeCode(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_]{2,100}$/u.test(error.code) ? error.code.toLowerCase() : 'technical_analyzer_unavailable';
}

function validateAnalysisRequest(request) {
  if (!path.isAbsolute(request?.mediaPath ?? '')
    || !path.isAbsolute(request?.operationRoot ?? '')
    || !/^[a-f0-9]{64}$/u.test(request?.mediaIdentity?.sha256 ?? '')
    || !Number.isSafeInteger(request?.mediaIdentity?.bytes)
    || request.mediaIdentity.bytes <= 0
    || typeof request.mediaIdentity.format !== 'string'
    || !/^[a-z0-9._-]{1,80}$/u.test(request.mediaIdentity.format)) {
    throw analyzerError('MEDIA_ANALYZER_REQUEST_INVALID', 'The technical analyzer request is invalid.');
  }
  const relative = path.relative(request.operationRoot, request.mediaPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw analyzerError('MEDIA_ANALYZER_MEDIA_OUTSIDE_OPERATION', 'The technical analyzer input must be staged in the private operation.');
}

function analyzerError(code, message, reason = null) {
  const error = new Error(message);
  error.code = code;
  error.details = reason ? { reason } : {};
  return error;
}
