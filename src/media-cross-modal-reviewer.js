import { createHash } from 'node:crypto';
import { jaccard, semanticTokens } from './media-review-timeline.js';
import { loadMediaReviewPolicy } from './media-review-policy.js';

const FINDING_SCHEMA_VERSION = '1.0.0';

export async function reviewMediaTimeline({ technicalAnalysis, transcript, timeline, mediaIdentity }, context = {}) {
  const policy = await loadMediaReviewPolicy(context);
  const deterministic = [];
  const advisory = [];
  const segments = Array.isArray(transcript?.segments) ? transcript.segments : [];
  const technicalLimits = policy.technical_analyzer;
  const reviewLimits = policy.reviewer;
  const cutStarts = (technicalAnalysis.shot_boundaries ?? []).slice(1).map((shot) => shot.start_us).sort((a, b) => a - b);
  const segmentById = new Map(segments.map((segment) => [segment.id, segment]));

  if (technicalAnalysis.frame_intervals?.warning) {
    deterministic.push(finding({
      kind: 'frame_interval_jitter', severity: 'medium', startUs: 0,
      endUs: technicalAnalysis.technical_metrics.duration_us,
      evidence: [`Frame interval jitter ratio ${technicalAnalysis.frame_intervals.jitter_ratio} exceeds ${technicalLimits.interval_jitter_warning_ratio}.`],
      method: 'frame_pts_interval_variance', confidence: 1,
      classification: 'deterministic_measurement', recommendation: 'Inspect encoding cadence and animation frame scheduling.'
    }));
  }
  for (const event of aggregateEvents(technicalAnalysis.dropped_frame_intervals ?? [], 'interval_us', reviewLimits.event_aggregation_gap_us)) {
    if (deterministic.length >= policy.operation.maximum_findings) break;
    deterministic.push(finding({
      kind: 'presentation_gap', severity: event.maximumValue > (technicalAnalysis.frame_intervals?.median_us ?? 0) * 3 ? 'high' : 'medium',
      startUs: event.start_us, endUs: event.end_us,
      evidence: [`Encoded presentation timestamps contain ${event.count} interval gap(s); maximum interval ${event.maximumValue} µs.`],
      method: 'frame_pts_gap_threshold', confidence: 0.98,
      classification: 'deterministic_measurement',
      limitation: 'A timestamp gap suggests missing presentation opportunities but does not prove decoder-visible dropped frames.',
      recommendation: 'Re-encode or repair the source cadence, then compare the same time range.'
    }));
  }
  for (const event of aggregateEvents(technicalAnalysis.duplicate_frames ?? [], null, reviewLimits.event_aggregation_gap_us)) {
    if (deterministic.length >= policy.operation.maximum_findings) break;
    deterministic.push(finding({
      kind: 'duplicate_frames', severity: event.count >= 5 ? 'medium' : 'low',
      startUs: event.start_us, endUs: event.end_us,
      evidence: [`${event.count} consecutive decoded frame hash match(es) were measured.`],
      method: 'decoded_frame_md5', confidence: 1,
      classification: 'deterministic_measurement',
      recommendation: 'Confirm whether the still interval is intentional; otherwise fix the render or export cadence.'
    }));
  }
  if (technicalAnalysis.audio_video_sync?.warning) {
    deterministic.push(finding({
      kind: 'audio_video_pts_offset', severity: Math.abs(technicalAnalysis.audio_video_sync.offset_us) > technicalLimits.av_sync_warning_us * 2 ? 'high' : 'medium',
      startUs: 0, endUs: Math.min(1_000_000, technicalAnalysis.technical_metrics.duration_us),
      evidence: [`Audio/video container start PTS differs by ${technicalAnalysis.audio_video_sync.offset_us} µs.`],
      method: 'container_stream_start_pts', confidence: 1,
      classification: 'deterministic_measurement',
      limitation: 'Container PTS comparison is not a perceptual lip-sync measurement.',
      recommendation: 'Align stream timestamps, then perform a separate perceptual sync review.'
    }));
  }
  for (const subtitle of (technicalAnalysis.subtitle_events ?? []).filter((entry) => !entry.duration_sufficient)) {
    if (deterministic.length >= policy.operation.maximum_findings) break;
    deterministic.push(finding({
      kind: 'subtitle_display_too_short', severity: 'medium', startUs: subtitle.start_us, endUs: subtitle.end_us,
      evidence: [`Subtitle packet duration ${subtitle.duration_us} µs is below the configured ${technicalLimits.subtitle_minimum_us} µs minimum.`],
      method: 'subtitle_packet_duration', confidence: 0.95,
      classification: 'deterministic_measurement',
      limitation: 'Reading speed cannot be confirmed without the subtitle body.',
      recommendation: 'Extend subtitle display time and verify reading speed against the final text.'
    }));
  }

  for (const segment of segments.filter((entry) => entry.timed)) {
    if (advisory.length >= policy.operation.maximum_findings) break;
    const lower = segment.start_us + reviewLimits.speech_cut_edge_margin_us;
    const upper = segment.end_us - reviewLimits.speech_cut_edge_margin_us;
    for (let cutIndex = lowerBound(cutStarts, lower + 1); cutIndex < cutStarts.length && cutStarts[cutIndex] < upper; cutIndex += 1) {
      const cut = cutStarts[cutIndex];
      advisory.push(finding({
        kind: 'cut_during_speech', severity: 'medium', startUs: segment.start_us, endUs: segment.end_us,
        evidence: [`A scene boundary at ${formatTimecode(cut)} occurs before this timed speech segment ends.`, boundedExcerpt(segment.text, policy)],
        refs: [segment.id, shotRefAt(technicalAnalysis.shot_boundaries, cut)],
        method: 'speech_segment_and_shot_temporal_join', confidence: 0.86,
        classification: 'advisory_evaluation',
        limitation: 'The transcript segment boundary may not match a grammatical sentence boundary.',
        recommendation: 'Move the cut after the spoken thought, or make the visual transition clearly support the unfinished phrase.'
      }));
      if (advisory.length >= policy.operation.maximum_findings) break;
    }
  }

  for (const point of timeline.semantic_change_points ?? []) {
    if (advisory.length >= policy.operation.maximum_findings) break;
    const nearbyCut = hasValueInWindow(cutStarts, point.at_us, reviewLimits.topic_change_visual_window_us);
    if (!nearbyCut) {
      const current = segmentById.get(point.current_segment_id);
      advisory.push(finding({
        kind: 'topic_change_without_visual_break', severity: 'medium', startUs: point.at_us,
        endUs: current?.end_us ?? point.at_us,
        evidence: [`A low token-similarity topic transition (${point.similarity}) has no nearby detected shot boundary.`, boundedExcerpt(current?.text, policy)],
        refs: [point.id, current?.id].filter(Boolean), method: 'token_jaccard_and_shot_window',
        confidence: point.confidence, classification: 'advisory_evaluation',
        limitation: 'Topic change is a language heuristic and visual changes below the cut threshold may exist.',
        recommendation: 'Add a visual section marker, title, or purposeful composition change around the topic transition.'
      }));
    }
  }

  for (let index = 1; index < segments.length; index += 1) {
    if (advisory.length >= policy.operation.maximum_findings) break;
    const previous = segments[index - 1];
    const current = segments[index];
    if (!previous.timed || !current.timed) continue;
    const gap = current.start_us - previous.end_us;
    if (gap > reviewLimits.long_pause_warning_us) {
      advisory.push(finding({
        kind: 'long_pause', severity: gap > reviewLimits.long_pause_high_us ? 'medium' : 'low', startUs: previous.end_us, endUs: current.start_us,
        evidence: [`A ${round(gap / 1_000_000, 2)} second speech pause was measured.`],
        method: 'transcript_segment_gap', confidence: 0.9, classification: 'advisory_evaluation',
        limitation: 'The pause may be intentional for emphasis or interaction.',
        recommendation: 'Confirm that the pause carries visual meaning; shorten it if no deliberate beat is present.'
      }));
    }
    const similarity = jaccard(
      semanticTokens(previous.text, reviewLimits.maximum_semantic_text_characters),
      semanticTokens(current.text, reviewLimits.maximum_semantic_text_characters)
    );
    if (similarity >= reviewLimits.repetition_similarity_threshold && normalizeText(previous.text) !== '' && normalizeText(previous.text) !== normalizeText(current.text)) {
      advisory.push(finding({
        kind: 'repetitive_explanation', severity: 'low', startUs: previous.start_us, endUs: current.end_us,
        evidence: [`Adjacent speech segments have high lexical similarity (${round(similarity, 2)}).`, boundedExcerpt(current.text, policy)],
        refs: [previous.id, current.id], method: 'token_jaccard_repetition', confidence: 0.68,
        classification: 'advisory_evaluation',
        limitation: 'Repetition may be intentional reinforcement.',
        recommendation: 'Remove redundant wording or let the visual carry the repeated information.'
      }));
    }
  }

  for (const segment of segments.filter((entry) => entry.timed && entry.end_us > entry.start_us)) {
    if (advisory.length >= policy.operation.maximum_findings) break;
    const density = countWords(segment.text) / ((segment.end_us - segment.start_us) / 1_000_000);
    if (density > reviewLimits.speech_density_warning_words_per_second) {
      advisory.push(finding({
        kind: 'high_speech_information_density', severity: density > reviewLimits.speech_density_high_words_per_second ? 'high' : 'medium', startUs: segment.start_us, endUs: segment.end_us,
        evidence: [`Estimated speech density is ${round(density, 2)} words per second.`, boundedExcerpt(segment.text, policy)],
        refs: [segment.id], method: 'timed_transcript_word_density', confidence: 0.78,
        classification: 'advisory_evaluation',
        limitation: 'Word segmentation is approximate for languages without whitespace.',
        recommendation: 'Reduce spoken density, add a pause, or split the information across clearer visual steps.'
      }));
    }
  }

  if (segments.some((segment) => segment.timed === true) && (technicalAnalysis.subtitle_events ?? []).length === 0) {
    advisory.push(finding({
      kind: 'silent_viewing_accessibility_risk', severity: 'high', startUs: 0,
      endUs: technicalAnalysis.technical_metrics.duration_us,
      evidence: ['Timed speech is available, but no embedded subtitle timing evidence was detected.'],
      method: 'speech_presence_and_subtitle_absence', confidence: 0.88,
      classification: 'advisory_evaluation',
      limitation: 'Burned-in captions cannot be detected without OCR.',
      recommendation: 'Provide accurate captions and ensure essential spoken information is also understandable without audio.'
    }));
  }

  const boundedDeterministic = deterministic.slice(0, policy.operation.maximum_findings);
  const boundedAdvisory = advisory.slice(0, Math.max(0, policy.operation.maximum_findings - boundedDeterministic.length));
  const contentEvidence = buildMediaContentEvidence({
    mediaIdentity,
    transcript,
    timeline,
    findings: [...boundedDeterministic, ...boundedAdvisory],
    technicalAnalysis,
    policy
  });
  return {
    deterministicFindings: boundedDeterministic,
    advisoryFindings: boundedAdvisory,
    contentEvidence,
    limitations: [
      'visual_ocr_not_performed',
      'perceptual_saliency_not_measured',
      'perceptual_lip_sync_not_measured',
      'external_fact_check_not_performed',
      'advisory_findings_are_not_human_observations'
    ]
  };
}

function finding({ kind, severity, startUs, endUs, evidence, refs = [], method, confidence, classification, limitation = null, recommendation }) {
  const idSeed = `${kind}\n${startUs}\n${endUs}\n${method}`;
  return {
    schema_version: FINDING_SCHEMA_VERSION,
    id: `media-finding-${createHash('sha256').update(idSeed).digest('hex').slice(0, 16)}`,
    kind,
    start_us: Math.max(0, Math.round(startUs ?? 0)),
    end_us: Math.max(Math.round(startUs ?? 0), Math.round(endUs ?? startUs ?? 0)),
    timecode: { start: formatTimecode(startUs ?? 0), end: formatTimecode(endUs ?? startUs ?? 0) },
    severity,
    evidence: evidence.filter(Boolean).slice(0, 6),
    evidence_refs: refs.slice(0, 8),
    method,
    confidence: round(Math.max(0, Math.min(1, confidence)), 3),
    classification,
    limitations: limitation ? [limitation] : [],
    recommendation,
    recommendation_classification: 'advisory_evaluation',
    scene_reference: { start_us: Math.max(0, Math.round(startUs ?? 0)), end_us: Math.max(Math.round(startUs ?? 0), Math.round(endUs ?? startUs ?? 0)) }
  };
}

function aggregateEvents(events, maximumField, maximumGapUs) {
  if (!events.length) return [];
  const sorted = [...events].sort((a, b) => a.start_us - b.start_us);
  const groups = [];
  for (const event of sorted) {
    const previous = groups.at(-1);
    if (previous && event.start_us - previous.end_us <= maximumGapUs) {
      previous.end_us = Math.max(previous.end_us, event.end_us);
      previous.count += 1;
      if (maximumField) previous.maximumValue = Math.max(previous.maximumValue, Number(event[maximumField]) || 0);
    } else {
      groups.push({ start_us: event.start_us, end_us: event.end_us, count: 1, maximumValue: maximumField ? Number(event[maximumField]) || 0 : 0 });
    }
  }
  return groups;
}

function lowerBound(sorted, value) {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (sorted[middle] < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

function hasValueInWindow(sorted, center, radius) {
  const index = lowerBound(sorted, center - radius);
  return index < sorted.length && sorted[index] <= center + radius;
}

function buildMediaContentEvidence({ mediaIdentity, transcript, timeline, findings, technicalAnalysis, policy }) {
  const contentUnits = [];
  let excerptBudget = policy.reviewer.maximum_content_excerpt_characters;
  for (const findingValue of findings) {
    if (contentUnits.length >= policy.reviewer.maximum_content_units || excerptBudget <= 0) break;
    const excerpt = findingValue.evidence.find((value) => value.startsWith('Excerpt:')) ?? '';
    const bounded = excerpt.slice(0, Math.min(excerptBudget, policy.operation.maximum_public_excerpt_characters + 9));
    excerptBudget -= bounded.length;
    contentUnits.push({
      id: `content-${findingValue.id}`,
      unit_type: 'media_review_finding',
      locator: `${findingValue.timecode.start}-${findingValue.timecode.end}`,
      text: bounded,
      summary: `${findingValue.kind}: ${findingValue.evidence[0]}`.slice(0, 700),
      source_refs: [findingValue.id],
      confidence: findingValue.confidence >= 0.85 ? 'high' : findingValue.confidence >= 0.6 ? 'medium' : 'low'
    });
  }
  return {
    schema_version: '1.0.0',
    evidence_version: '1.0.0',
    evidence_kind: 'content_evidence',
    id: `media-content-${mediaIdentity.sha256.slice(0, 16)}`,
    status: contentUnits.length ? 'available' : 'insufficient',
    source_type: 'video',
    source: {
      kind: 'local_media_review', title: null, locator: null,
      media_id: mediaIdentity.sha256, duration_seconds: technicalAnalysis.technical_metrics.duration_us / 1_000_000,
      page_count: null
    },
    provider: {
      id: 'trace-cue-media-review', kind: 'local_cross_modal_review', version: FINDING_SCHEMA_VERSION,
      local_execution_declared: true, api_call_declared: false
    },
    summaries: {
      content_summary: [`${findings.length} evidence-linked media review finding(s) were generated.`],
      transcript_summary: [`${transcript.segments.length} transcript segment(s) were joined by integer microsecond timecode.`],
      visible_text_summary: [],
      section_summary: (timeline.semantic_change_points ?? []).slice(0, 12).map((point) => `Potential topic transition at ${formatTimecode(point.at_us)}.`)
    },
    content_units: contentUnits,
    claims_observed: [],
    limitations: ['bounded_finding_excerpts_only', 'external_fact_check_not_performed'],
    coverage: {
      source_type: 'video', content_understanding_level: contentUnits.length ? 'multimodal' : 'metadata',
      has_summary: true, has_bounded_units: contentUnits.length > 0,
      has_original_text: contentUnits.some((unit) => unit.text), has_full_text: false, has_location_refs: true,
      original_text_coverage_score: contentUnits.some((unit) => unit.text) ? 0.2 : 0,
      location_reference_coverage_score: 1,
      advisory_only: true, gate_effect: 'none'
    },
    provenance: {
      input_path: null, input_hash: mediaIdentity.sha256, input_type: 'local_media', generated_at: null,
      source_tool: 'trace-cue-media-review'
    },
    privacy: {
      raw_media_embedded_in_json: false, raw_binary_embedded_in_json: false, raw_html_embedded_in_json: false,
      raw_pdf_embedded_in_json: false, full_transcript_embedded_in_json: false,
      full_document_embedded_in_json: false, bounded_text_units_only: true
    },
    boundary: {
      raw_media_included: false, raw_binary_included: false, full_transcript_included: false,
      external_send_performed: false, bounded_text_only: true
    },
    advisory_only: true,
    gate_effect: 'none'
  };
}

function boundedExcerpt(text, policy) {
  const normalized = normalizeText(text);
  if (!normalized) return '';
  if (normalized.length <= policy.reviewer.minimum_excerpt_characters) {
    return `Excerpt identity: ${createHash('sha256').update(normalized).digest('hex')}`;
  }
  const limit = Math.min(
    policy.operation.maximum_public_excerpt_characters,
    policy.reviewer.maximum_single_excerpt_characters,
    Math.max(policy.reviewer.minimum_excerpt_characters, Math.floor(normalized.length * policy.reviewer.excerpt_fraction_limit))
  );
  return `Excerpt: ${normalized.slice(0, limit)}…`;
}

function normalizeText(text) {
  return String(text ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

function countWords(text) {
  const words = normalizeText(text).match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.length;
}

function shotRefAt(shots, atUs) {
  return shots.find((shot) => shot.start_us === atUs)?.id ?? `shot-at-${atUs}`;
}

export function formatTimecode(value) {
  const milliseconds = Math.max(0, Math.round(Number(value) / 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1000);
  const millis = milliseconds % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
