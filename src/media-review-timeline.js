import { createHash } from 'node:crypto';
import { loadMediaReviewPolicy } from './media-review-policy.js';

const TIMELINE_SCHEMA_VERSION = '1.0.0';

export async function buildMediaReviewTimeline({ technicalAnalysis, transcript }, context = {}) {
  const policy = await loadMediaReviewPolicy(context);
  const segments = Array.isArray(transcript?.segments) ? transcript.segments : [];
  const semanticChangePoints = buildSemanticChangePoints(segments, policy.reviewer);
  const items = [];
  for (const shot of technicalAnalysis.shot_boundaries ?? []) {
    items.push(timelineItem('shot', shot.id, shot.start_us, shot.end_us, {
      classification: 'deterministic_measurement', cut_score: shot.cut_score
    }));
  }
  for (const segment of segments) {
    items.push(timelineItem('speech', segment.id, segment.start_us, segment.end_us, {
      classification: 'provider_measurement', timed: segment.timed,
      body_included: false, text_identity: hashText(segment.text), word_count: countWords(segment.text)
    }));
  }
  for (const subtitle of technicalAnalysis.subtitle_events ?? []) {
    items.push(timelineItem('subtitle', subtitle.id, subtitle.start_us, subtitle.end_us, {
      classification: 'deterministic_measurement', duration_sufficient: subtitle.duration_sufficient,
      body_included: false
    }));
  }
  for (const point of semanticChangePoints) {
    items.push(timelineItem('semantic_change', point.id, point.at_us, point.at_us, {
      classification: 'advisory_evaluation', method: point.method,
      similarity: point.similarity, body_included: false
    }));
  }
  const validItems = items
    .filter((item) => Number.isSafeInteger(item.start_us) && Number.isSafeInteger(item.end_us))
    .sort((a, b) => a.start_us - b.start_us || a.end_us - b.end_us || a.id.localeCompare(b.id));
  const bounded = validItems.slice(0, policy.operation.maximum_timeline_items);
  const boundedSemanticChanges = semanticChangePoints.slice(0, policy.operation.maximum_timeline_items);
  const truncated = bounded.length < validItems.length || boundedSemanticChanges.length < semanticChangePoints.length;
  return {
    schema_version: TIMELINE_SCHEMA_VERSION,
    type: 'media_review_timeline',
    timebase: 'microseconds',
    items: bounded,
    semantic_change_points: boundedSemanticChanges,
    source_item_count: validItems.length,
    item_count: bounded.length,
    semantic_change_count: semanticChangePoints.length,
    truncated,
    limitations: truncated ? ['timeline_items_truncated_to_policy_limit'] : [],
    boundary: {
      full_transcript_included: false,
      raw_media_included: false,
      raw_frames_included: false,
      absolute_paths_included: false,
      advisory_and_deterministic_separated: true
    }
  };
}

function buildSemanticChangePoints(segments, limits) {
  const points = [];
  for (let index = 1; index < segments.length; index += 1) {
    const previous = segments[index - 1];
    const current = segments[index];
    if (!previous.timed || !current.timed) continue;
    const similarity = jaccard(
      semanticTokens(previous.text, limits.maximum_semantic_text_characters),
      semanticTokens(current.text, limits.maximum_semantic_text_characters)
    );
    if (similarity <= limits.topic_change_similarity_threshold) {
      points.push({
        id: `semantic-change-${String(points.length + 1).padStart(5, '0')}`,
        at_us: current.start_us,
        previous_segment_id: previous.id,
        current_segment_id: current.id,
        similarity: round(similarity, 4),
        method: 'token_jaccard_heuristic',
        classification: 'advisory_evaluation',
        confidence: similarity === 0 ? 0.72 : 0.58,
        limitation: 'semantic_change_is_heuristic_not_ground_truth'
      });
    }
  }
  return points;
}

function timelineItem(kind, id, startUs, endUs, evidence) {
  return { id: `${kind}:${id}`, kind, start_us: startUs, end_us: endUs, evidence };
}

export function semanticTokens(text, maximumCharacters) {
  if (!Number.isSafeInteger(maximumCharacters) || maximumCharacters <= 0) {
    throw new TypeError('maximumCharacters must be a positive safe integer.');
  }
  const normalized = String(text ?? '').normalize('NFKC').toLocaleLowerCase('und').slice(0, maximumCharacters);
  const words = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length > 2) return new Set(words);
  const compact = words.join('');
  const grams = new Set(words);
  for (let index = 0; index < compact.length - 1; index += 1) grams.add(compact.slice(index, index + 2));
  return grams;
}

export function jaccard(left, right) {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / (left.size + right.size - intersection || 1);
}

function countWords(text) {
  const words = String(text ?? '').match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.length;
}

function hashText(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
