import { createHash } from 'node:crypto';
import { DEFAULT_ARTIFACT_ROOT } from './constants.js';
import { validateJsonSchemaSubset } from './json-schema-subset.js';
import {
  loadMediaReviewComparisonPolicy,
  mediaReviewComparisonPolicyIdentity,
  MEDIA_REVIEW_COMPARISON_SCHEMA_VERSION
} from './media-review-comparison-policy.js';
import {
  assertPublicMediaDataBoundary,
  digestPublicJson,
  readStoredMediaReviewResult,
  stableJson,
  validatePublicMediaReviewResult
} from './media-review-public-result.js';
import { getSchema } from './schema-registry.js';

const SEVERITY_RANK = Object.freeze({ low: 0, medium: 1, high: 2, critical: 3 });
const RUN_SPECIFIC_TRANSCRIPT_FIELDS = new Set([
  'prepared_audio_identity',
  'preparation_manifest_identity',
  'registration_identity',
  'provider_receipt_identity',
  'computation_identity',
  'sample_zero_source_time_us'
]);

export async function runMediaReviewComparison(options = {}, context = {}) {
  try {
    const policy = await loadMediaReviewComparisonPolicy(context);
    const baselineId = String(options.baseline ?? '');
    const candidateId = String(options.candidate ?? '');
    if (baselineId === candidateId) {
      return failure('MEDIA_REVIEW_COMPARISON_DISTINCT_RESULTS_REQUIRED', 'Choose two different saved media reviews.');
    }
    const readOptions = {
      artifactRoot: options.artifactRoot ?? DEFAULT_ARTIFACT_ROOT,
      maximumBytes: policy.input.maximum_result_bytes
    };
    const [baseline, candidate] = await Promise.all([
      readStoredMediaReviewResult(baselineId, readOptions, context),
      readStoredMediaReviewResult(candidateId, readOptions, context)
    ]);
    if (baseline.bytes + candidate.bytes > policy.input.maximum_total_input_bytes) {
      return failure('MEDIA_REVIEW_COMPARISON_INPUT_TOO_LARGE', 'The saved media review pair exceeds the comparison input limit.');
    }
    const comparison = buildMediaReviewComparison(baseline.value, candidate.value, policy, {
      baselineDigest: baseline.digest,
      candidateDigest: candidate.digest
    });
    return { status: 'ok', data: { media_review_comparison: comparison }, warnings: [], errors: [], artifacts: [] };
  } catch (error) {
    return failure(safeCode(error), safeMessage(error));
  }
}

export async function compareMediaReviewResults(baseline, candidate, context = {}) {
  const policy = await loadMediaReviewComparisonPolicy(context);
  return buildMediaReviewComparison(baseline, candidate, policy);
}

export function inspectMediaReviewComparability(baseline, candidate, policy) {
  validatePair(baseline, candidate, policy);
  return buildCompatibility(baseline, candidate, policy);
}

export function buildMediaReviewComparison(baselineInput, candidateInput, policy, digests = {}) {
  validatePair(baselineInput, candidateInput, policy);
  const baseline = structuredClone(baselineInput);
  const candidate = structuredClone(candidateInput);
  const baselineDigest = digests.baselineDigest ?? digestPublicJson(baseline);
  const candidateDigest = digests.candidateDigest ?? digestPublicJson(candidate);
  const policyIdentity = mediaReviewComparisonPolicyIdentity(policy);
  const compatibility = buildCompatibility(baseline, candidate, policy);
  const limitations = buildComparisonLimitations(baseline, candidate, compatibility, policy);
  let metricDiffs = policy.metrics.map((metric) => compareMetric(metric, baseline, candidate, compatibility));
  const deterministicFindingDomain = findingComparisonDomain(
    compatibility.technical,
    findingCompletenessLimited(baseline, policy) || findingCompletenessLimited(candidate, policy)
  );
  const deterministic = compareFindingSet(
    baseline.deterministic_findings,
    candidate.deterministic_findings,
    'deterministic_measurement',
    deterministicFindingDomain,
    policy
  );
  const advisory = compareFindingSet(
    baseline.advisory_findings,
    candidate.advisory_findings,
    'advisory_evaluation',
    compatibility.advisory,
    policy
  );
  let deterministicChanges = deterministic.changes;
  let advisoryChanges = advisory.changes;
  limitations.push(...deterministic.limitations, ...advisory.limitations);
  const totalChanges = deterministicChanges.length + advisoryChanges.length;
  if (totalChanges > policy.output.maximum_finding_changes) {
    const deterministicLimit = Math.min(deterministicChanges.length, policy.output.maximum_finding_changes);
    deterministicChanges = deterministicChanges.slice(0, deterministicLimit);
    advisoryChanges = advisoryChanges.slice(0, Math.max(0, policy.output.maximum_finding_changes - deterministicLimit));
    limitations.push('comparison_finding_changes_truncated_to_policy_limit');
  }
  metricDiffs = metricDiffs.slice(0, policy.output.maximum_metric_diffs);
  const uniqueLimitations = [...new Set(limitations)].slice(0, policy.output.maximum_limitations);
  let status = overallCompatibilityStatus(compatibility, uniqueLimitations);
  const comparison = {
    schema_version: MEDIA_REVIEW_COMPARISON_SCHEMA_VERSION,
    type: 'media_review_comparison',
    comparison_id: createHash('sha256').update(stableJson({ baselineDigest, candidateDigest, policyIdentity })).digest('hex'),
    relationship: 'caller_selected_before_after',
    status,
    policy: { version: policy.policy_version, identity: policyIdentity },
    baseline: inputReference(baseline, baselineDigest),
    candidate: inputReference(candidate, candidateDigest),
    compatibility: {
      ...compatibility,
      exact_result_repeat: comparableContentDigest(baseline) === comparableContentDigest(candidate)
    },
    metric_diffs: metricDiffs,
    deterministic_finding_changes: deterministicChanges,
    advisory_finding_changes: advisoryChanges,
    summary: {
      deterministic: summarizeChanges(deterministicChanges),
      advisory: summarizeChanges(advisoryChanges),
      deterministic_metric_assessments: summarizeMetrics(metricDiffs.filter((metric) => metric.classification === 'deterministic_measurement')),
      provider_metric_assessments: summarizeMetrics(metricDiffs.filter((metric) => metric.classification === 'provider_measurement')),
      advisory_metric_assessments: summarizeMetrics(metricDiffs.filter((metric) => metric.classification === 'advisory_evaluation')),
      combined_quality_score_included: false
    },
    limitations: uniqueLimitations,
    privacy: {
      public_results_only: true,
      raw_media_read: false,
      raw_audio_read: false,
      raw_frames_read: false,
      full_transcript_read: false,
      private_payload_read: false,
      absolute_paths_included: false,
      external_send_performed: false
    },
    boundary: comparisonBoundary()
  };
  if (comparison.limitations.includes('comparison_finding_changes_truncated_to_policy_limit') && status === 'comparable') {
    comparison.status = 'comparable_with_limitations';
    status = comparison.status;
  }
  enforceComparisonByteBudget(comparison, policy);
  enforceComparisonOutput(comparison, policy);
  return comparison;
}

export function renderMediaReviewComparisonMarkdown(comparison) {
  const lines = [
    '# Media Review Comparison', '',
    `- Status: ${markdownLiteral(comparison.status)}`,
    `- Baseline operation: ${markdownLiteral(comparison.baseline.operation_id)}`,
    `- Candidate operation: ${markdownLiteral(comparison.candidate.operation_id)}`,
    `- Deterministic outcome: ${markdownLiteral(comparison.summary.deterministic.status)}`,
    `- Advisory outcome: ${markdownLiteral(comparison.summary.advisory.status)}`
  ];
  renderMetricDiffs(lines, 'Deterministic technical measurements', comparison.metric_diffs.filter((metric) => metric.classification === 'deterministic_measurement'));
  renderMetricDiffs(lines, 'Transcript provider measurements', comparison.metric_diffs.filter((metric) => metric.classification === 'provider_measurement'));
  renderMetricDiffs(lines, 'Advisory indicators', comparison.metric_diffs.filter((metric) => metric.classification === 'advisory_evaluation'));
  renderFindingChanges(lines, 'Deterministic finding changes', comparison.deterministic_finding_changes);
  renderFindingChanges(lines, 'Advisory finding changes', comparison.advisory_finding_changes);
  lines.push('## Limitations', '');
  for (const limitation of comparison.limitations) lines.push(`- ${markdownLiteral(limitation)}`);
  lines.push('', 'This comparison reads bounded public results only. It does not read or reprocess video, audio, frames, private payloads, or a complete transcript.', '');
  return lines.join('\n');
}

function validatePair(baseline, candidate, policy) {
  if (!policy || policy.schema_version !== MEDIA_REVIEW_COMPARISON_SCHEMA_VERSION) {
    throw comparisonError('MEDIA_REVIEW_COMPARISON_POLICY_INVALID', 'The media comparison policy is invalid.');
  }
  if (baseline?.operation_id === candidate?.operation_id) {
    throw comparisonError('MEDIA_REVIEW_COMPARISON_DISTINCT_RESULTS_REQUIRED', 'Choose two different saved media reviews.');
  }
  const values = [baseline, candidate];
  let totalBytes = 0;
  for (const value of values) {
    validatePublicMediaReviewResult(value);
    if (!['completed', 'completed_with_limitations'].includes(value.status)) {
      throw comparisonError('MEDIA_REVIEW_COMPARISON_RESULT_INSUFFICIENT', 'Choose two completed media review results.');
    }
    const bytes = Buffer.byteLength(stableJson(value));
    if (bytes > policy.input.maximum_result_bytes) {
      throw comparisonError('MEDIA_REVIEW_COMPARISON_INPUT_TOO_LARGE', 'A saved media review result exceeds the comparison input limit.');
    }
    totalBytes += bytes;
    if (!policy.accepted_result_schema_versions.includes(value.schema_version)) {
      throw comparisonError('MEDIA_REVIEW_COMPARISON_RESULT_VERSION_UNSUPPORTED', 'A saved media review result uses an unsupported schema version.');
    }
    if (value.deterministic_findings.length > policy.input.maximum_findings_per_class
      || value.advisory_findings.length > policy.input.maximum_findings_per_class) {
      throw comparisonError('MEDIA_REVIEW_COMPARISON_FINDING_LIMIT', 'A saved media review result exceeds the comparison finding limit.');
    }
    for (const findings of [value.deterministic_findings, value.advisory_findings]) {
      if (new Set(findings.map((finding) => finding.id)).size !== findings.length) {
        throw comparisonError('MEDIA_REVIEW_COMPARISON_FINDING_ID_DUPLICATE', 'A saved media review result contains duplicate finding ids.');
      }
    }
  }
  if (totalBytes > policy.input.maximum_total_input_bytes) {
    throw comparisonError('MEDIA_REVIEW_COMPARISON_INPUT_TOO_LARGE', 'The saved media review pair exceeds the comparison input limit.');
  }
}

function buildCompatibility(baseline, candidate, policy) {
  const technicalBaseline = technicalBasis(baseline);
  const technicalCandidate = technicalBasis(candidate);
  const transcriptBaseline = transcriptBasis(baseline);
  const transcriptCandidate = transcriptBasis(candidate);
  const baselineTechnicalLimits = technicalCompletenessLimitations(baseline.technical_analysis);
  const candidateTechnicalLimits = technicalCompletenessLimitations(candidate.technical_analysis);
  const technical = domainCompatibility('technical', technicalBaseline, technicalCandidate, [
    ...(baseline.technical_analysis.status === 'partial' || candidate.technical_analysis.status === 'partial'
      ? [reason('partial_technical_analysis', 'At least one technical analysis is partial.')]
      : []),
    ...(baselineTechnicalLimits.length || candidateTechnicalLimits.length
      ? [reason('technical_analysis_completeness_limited', 'At least one technical analysis reached an evidence limit.')]
      : [])
  ]);
  const transcript = domainCompatibility('transcript', transcriptBaseline, transcriptCandidate, [
    ...(baseline.transcript.status !== 'available' || candidate.transcript.status !== 'available'
      ? [reason('transcript_not_fully_available', 'At least one timed transcript projection is not fully available.')]
      : []),
    ...(transcriptCompletenessLimitations(baseline.transcript).length || transcriptCompletenessLimitations(candidate.transcript).length
      ? [reason('transcript_completeness_limited', 'At least one timed transcript projection reached a completeness limit.')]
      : [])
  ], baseline.transcript.status === 'unavailable' || candidate.transcript.status === 'unavailable');
  const advisoryBaseline = advisoryBasis(baseline, technicalBaseline, transcriptBaseline);
  const advisoryCandidate = advisoryBasis(candidate, technicalCandidate, transcriptCandidate);
  const advisoryHardIncompatible = technical.status === 'incompatible' || transcript.status === 'incompatible';
  const advisory = domainCompatibility('advisory', advisoryBaseline, advisoryCandidate, [
    ...(technical.status === 'comparable_with_limitations'
      ? [reason('dependent_technical_comparison_limited', 'The dependent technical comparison has limitations.')]
      : []),
    ...(transcript.status === 'comparable_with_limitations'
      ? [reason('dependent_transcript_comparison_limited', 'The dependent transcript comparison has limitations.')]
      : []),
    ...(baseline.content_evidence.status !== 'available' || candidate.content_evidence.status !== 'available'
      ? [reason('content_evidence_insufficient', 'At least one bounded content evidence projection is insufficient.')]
      : []),
    ...(baseline.timeline.truncated || candidate.timeline.truncated
      ? [reason('timeline_truncated', 'At least one public timeline is truncated.')]
      : []),
    ...(findingCompletenessLimited(baseline, policy) || findingCompletenessLimited(candidate, policy)
      ? [reason('finding_completeness_limited', 'At least one finding set may be incomplete.')]
      : [])
  ], advisoryHardIncompatible);
  return {
    technical,
    transcript,
    advisory,
    same_media_identity: baseline.media_identity.sha256 === candidate.media_identity.sha256
  };
}

function technicalBasis(result) {
  return {
    result_schema_version: result.schema_version,
    result_status: result.status,
    analysis_status: result.technical_analysis.status,
    timebase: result.technical_analysis.timebase,
    analysis_settings: result.analysis_settings,
    method: result.technical_analysis.method
  };
}

function transcriptBasis(result) {
  const method = {};
  for (const [key, value] of Object.entries(result.transcript.method ?? {})) {
    if (!RUN_SPECIFIC_TRANSCRIPT_FIELDS.has(key)) method[key] = value;
  }
  return {
    result_schema_version: result.schema_version,
    provider_projection_schema_version: result.transcript.schema_version,
    projection_type: result.transcript.type,
    projection_status: result.transcript.status,
    language: result.transcript.language,
    method
  };
}

function advisoryBasis(result, technical, transcript) {
  return {
    result_status: result.status,
    technical_basis_identity: digestPublicJson(technical),
    transcript_basis_identity: digestPublicJson(transcript),
    semantic_change_method: result.analysis_settings.semantic_change_method,
    timeline_schema_version: result.timeline.schema_version,
    timeline_truncated: result.timeline.truncated,
    content_evidence: {
      schema_version: result.content_evidence.schema_version,
      status: result.content_evidence.status,
      understanding_level: result.content_evidence.coverage.content_understanding_level,
      has_bounded_units: result.content_evidence.coverage.has_bounded_units,
      original_text_coverage_score: result.content_evidence.coverage.original_text_coverage_score,
      location_reference_coverage_score: result.content_evidence.coverage.location_reference_coverage_score,
      limitations: [...result.content_evidence.limitations].sort()
    },
    reviewer_settings: {
      speech_cut_edge_margin_us: result.analysis_settings.speech_cut_edge_margin_us,
      topic_change_visual_window_us: result.analysis_settings.topic_change_visual_window_us,
      long_pause_warning_us: result.analysis_settings.long_pause_warning_us,
      speech_density_warning_words_per_second: result.analysis_settings.speech_density_warning_words_per_second,
      speech_density_high_words_per_second: result.analysis_settings.speech_density_high_words_per_second,
      repetition_similarity_threshold: result.analysis_settings.repetition_similarity_threshold
    }
  };
}

function domainCompatibility(domain, baselineBasis, candidateBasis, softReasons, hardIncompatible = false) {
  const baselineIdentity = digestPublicJson(baselineBasis);
  const candidateIdentity = digestPublicJson(candidateBasis);
  const basisEqual = baselineIdentity === candidateIdentity;
  const reasons = [...softReasons];
  if (!basisEqual) reasons.unshift(reason(`${domain}_comparison_basis_changed`, `The ${domain} comparison basis changed.`));
  let status = 'comparable';
  if (!basisEqual || hardIncompatible) status = 'incompatible';
  else if (reasons.length) status = 'comparable_with_limitations';
  return {
    status,
    baseline_basis_identity: baselineIdentity,
    candidate_basis_identity: candidateIdentity,
    basis_equal: basisEqual,
    reasons
  };
}

function technicalCompletenessLimitations(analysis) {
  return (analysis.limitations ?? []).filter((value) => /(?:limit_reached|truncated|evidence_limit|stream_unavailable)/iu.test(value));
}

function transcriptCompletenessLimitations(transcript) {
  return (transcript.limitations ?? []).filter((value) => /(?:untimed_segments_present|_cue_.*(?:omitted|clipped)|truncat|limit_reached|unavailable|insufficient)/iu.test(value));
}

function findingComparisonDomain(domain, completenessLimited) {
  if (!completenessLimited || domain.status === 'incompatible') return domain;
  return {
    ...domain,
    status: 'comparable_with_limitations',
    reasons: [...domain.reasons, reason('finding_completeness_limited', 'At least one public finding set may be incomplete.')]
  };
}

function compareMetric(metric, baseline, candidate, compatibility) {
  const domain = compatibility[metric.domain];
  const baselineValue = finiteNumber(readSelector(baseline, metric.selector));
  const candidateValue = finiteNumber(readSelector(candidate, metric.selector));
  const durationBaseline = finiteNumber(baseline.technical_analysis.technical_metrics.duration_us);
  const durationCandidate = finiteNumber(candidate.technical_analysis.technical_metrics.duration_us);
  const normalized = metric.normalize_per_minute
    ? {
        applied: true,
        baseline: perMinute(baselineValue, durationBaseline),
        candidate: perMinute(candidateValue, durationCandidate),
        delta: delta(perMinute(candidateValue, durationCandidate), perMinute(baselineValue, durationBaseline))
      }
    : { applied: false, baseline: null, candidate: null, delta: null };
  const available = baselineValue !== null && candidateValue !== null;
  const status = !available ? 'unavailable' : domain.status;
  const comparedBaseline = normalized.applied ? normalized.baseline : baselineValue;
  const comparedCandidate = normalized.applied ? normalized.candidate : candidateValue;
  const assessment = metricAssessment(metric, comparedBaseline, comparedCandidate, status);
  return {
    id: metric.id,
    domain: metric.domain,
    unit: metric.unit,
    baseline: baselineValue,
    candidate: candidateValue,
    delta: delta(candidateValue, baselineValue),
    normalized_per_minute: normalized,
    status,
    assessment,
    classification: metric.classification,
    limitations: domain.reasons.map((entry) => entry.code).slice(0, 8)
  };
}

function metricAssessment(metric, baseline, candidate, status) {
  if (status === 'unavailable') return 'unavailable';
  if (status !== 'comparable' || baseline === null || candidate === null) return 'inconclusive';
  const difference = candidate - baseline;
  if (Math.abs(difference) <= metric.tolerance) return 'unchanged';
  if (metric.quality_direction === 'informational') return 'changed';
  if (metric.quality_direction === 'lower_is_better') return difference < 0 ? 'improved' : 'regressed';
  return difference > 0 ? 'improved' : 'regressed';
}

function compareFindingSet(baselineValues, candidateValues, classification, domain, policy) {
  if (domain.status === 'incompatible') {
    return { changes: [], limitations: [`${classification}_finding_comparison_incompatible`] };
  }
  const baseline = [...baselineValues].sort(compareFindingOrder);
  const candidate = [...candidateValues].sort(compareFindingOrder);
  const available = new Set(candidate.map((finding) => finding.id));
  const ambiguousCandidateIds = new Set();
  const records = [];
  for (const before of baseline) {
    const match = selectFindingMatch(before, candidate.filter((finding) => available.has(finding.id)), policy);
    if (match.ambiguous) {
      for (const item of match.ambiguous) ambiguousCandidateIds.add(item.id);
      records.push(findingChange(before, null, classification, domain, policy, { ambiguous: true }));
      continue;
    }
    if (!match.finding) {
      records.push(findingChange(before, null, classification, domain, policy));
      continue;
    }
    available.delete(match.finding.id);
    records.push(findingChange(before, match.finding, classification, domain, policy, match));
  }
  for (const after of candidate.filter((finding) => available.has(finding.id))) {
    records.push(findingChange(null, after, classification, domain, policy, {
      ambiguous: ambiguousCandidateIds.has(after.id)
    }));
  }
  const limitations = [];
  if (records.some((record) => record.match.heuristic)) limitations.push('finding_matching_uses_versioned_timeline_heuristics');
  if (records.some((record) => record.baseline === null || record.candidate === null)) {
    limitations.push('not_detected_in_candidate_does_not_prove_fixed');
  }
  return { changes: records.sort(compareFindingChangeOrder), limitations };
}

function selectFindingMatch(before, candidates, policy) {
  const exact = candidates.find((candidate) => candidate.id === before.id
    && candidate.classification === before.classification
    && candidate.kind === before.kind
    && candidate.method === before.method
    && candidate.start_us === before.start_us
    && candidate.end_us === before.end_us);
  if (exact) {
    return { finding: exact, method: 'exact_finding_id', overlapRatio: 1, midpointDistanceUs: 0, heuristic: false };
  }
  const eligible = candidates
    .filter((candidate) => candidate.classification === before.classification
      && candidate.kind === before.kind
      && candidate.method === before.method)
    .map((candidate) => {
      const overlapRatio = intervalOverlapRatio(before, candidate);
      const midpointDistanceUs = Math.round(Math.abs(midpoint(before) - midpoint(candidate)));
      return { finding: candidate, overlapRatio, midpointDistanceUs };
    })
    .filter((match) => match.overlapRatio >= policy.matching.minimum_overlap_ratio
      || match.midpointDistanceUs <= policy.matching.maximum_moved_timing_distance_us)
    .sort((left, right) => right.overlapRatio - left.overlapRatio
      || left.midpointDistanceUs - right.midpointDistanceUs
      || left.finding.id.localeCompare(right.finding.id));
  if (!eligible.length) return { finding: null, method: 'unmatched', overlapRatio: null, midpointDistanceUs: null, heuristic: false };
  if (eligible.length > 1
    && eligible[0].overlapRatio === eligible[1].overlapRatio
    && eligible[0].midpointDistanceUs === eligible[1].midpointDistanceUs) {
    return { finding: null, ambiguous: eligible.filter((item) => item.overlapRatio === eligible[0].overlapRatio && item.midpointDistanceUs === eligible[0].midpointDistanceUs).map((item) => item.finding) };
  }
  const selected = eligible[0];
  return {
    ...selected,
    method: selected.overlapRatio >= policy.matching.minimum_overlap_ratio ? 'timeline_overlap' : 'nearest_timeline',
    heuristic: true
  };
}

function findingChange(before, after, classification, domain, policy, match = {}) {
  const ambiguous = match.ambiguous === true;
  const complete = domain.status === 'comparable' && !ambiguous;
  let state;
  const changeTypes = [];
  if (!before || !after) {
    if (!complete) state = 'unmatched_inconclusive';
    else state = before ? 'not_detected_in_candidate' : 'new';
    changeTypes.push(state);
  } else {
    const startDelta = after.start_us - before.start_us;
    const endDelta = after.end_us - before.end_us;
    const severityDelta = SEVERITY_RANK[after.severity] - SEVERITY_RANK[before.severity];
    const confidenceDelta = round(after.confidence - before.confidence, 6);
    if (Math.abs(startDelta) > policy.matching.stable_timing_tolerance_us
      || Math.abs(endDelta) > policy.matching.stable_timing_tolerance_us) changeTypes.push('timing_moved');
    if (severityDelta !== 0) changeTypes.push('severity_changed');
    if (Math.abs(confidenceDelta) >= policy.matching.confidence_change_threshold) changeTypes.push('confidence_changed');
    if (!changeTypes.length) changeTypes.push('persistent');
    state = changeTypes.includes('severity_changed') ? 'severity_changed'
      : changeTypes.includes('timing_moved') ? 'moved'
        : 'persistent';
  }
  const severityDelta = before && after ? SEVERITY_RANK[after.severity] - SEVERITY_RANK[before.severity] : null;
  const confidenceDelta = before && after ? round(after.confidence - before.confidence, 6) : null;
  const timingDeltaUs = before && after ? Math.round(midpoint(after) - midpoint(before)) : null;
  const assessment = findingAssessment({ before, after, classification, domain, state, severityDelta, heuristic: match.heuristic === true });
  const seed = stableJson({ before: before?.id ?? null, after: after?.id ?? null, state, classification });
  return {
    id: `media-comparison-finding-${createHash('sha256').update(seed).digest('hex').slice(0, 16)}`,
    classification,
    state,
    change_types: changeTypes,
    kind: before?.kind ?? after.kind,
    method: before?.method ?? after.method,
    baseline: before ? projectFinding(before) : null,
    candidate: after ? projectFinding(after) : null,
    timing_delta_us: timingDeltaUs,
    severity_delta: severityDelta,
    confidence_delta: confidenceDelta,
    match: {
      method: ambiguous ? 'unmatched' : (match.method ?? 'unmatched'),
      overlap_ratio: match.overlapRatio ?? null,
      midpoint_distance_us: match.midpointDistanceUs ?? null,
      heuristic: match.heuristic === true || ambiguous
    },
    assessment,
    limitations: [
      ...(match.heuristic === true || ambiguous ? ['finding_match_is_timeline_heuristic'] : []),
      ...(!before || !after ? ['absence_in_one_result_does_not_prove_issue_fixed_or_created'] : []),
      ...(domain.status !== 'comparable' ? ['comparison_domain_has_limitations'] : [])
    ]
  };
}

function findingAssessment({ before, after, classification, domain, state, severityDelta, heuristic }) {
  if (domain.status !== 'comparable' || state === 'unmatched_inconclusive' || heuristic) return 'inconclusive';
  if (!before || !after) return 'inconclusive';
  if (classification === 'advisory_evaluation') {
    return state === 'persistent' ? 'unchanged' : 'changed';
  }
  if (severityDelta > 0) return 'regressed';
  if (severityDelta < 0) return 'improved';
  return state === 'persistent' ? 'unchanged' : 'changed';
}

function projectFinding(finding) {
  return {
    id: finding.id,
    kind: finding.kind,
    start_us: finding.start_us,
    end_us: finding.end_us,
    timecode: structuredClone(finding.timecode),
    severity: finding.severity,
    evidence: finding.evidence.map(safePublicText),
    evidence_refs: finding.evidence_refs.map(safePublicText),
    method: finding.method,
    confidence: finding.confidence,
    classification: finding.classification,
    limitations: finding.limitations.map(safePublicText),
    recommendation: safePublicText(finding.recommendation)
  };
}

function inputReference(result, digest) {
  return {
    operation_id: result.operation_id,
    result_digest: digest,
    result_schema_version: result.schema_version,
    status: result.status,
    media_identity: structuredClone(result.media_identity),
    duration_us: result.technical_analysis.technical_metrics.duration_us,
    finding_counts: {
      deterministic: result.deterministic_findings.length,
      advisory: result.advisory_findings.length
    }
  };
}

function buildComparisonLimitations(baseline, candidate, compatibility, policy) {
  const values = ['comparison_reads_bounded_public_results_only'];
  if (compatibility.same_media_identity) values.push('same_media_identity_is_a_repeat_comparison_not_proof_of_before_after_editing');
  if (baseline.technical_analysis.limitations.length || candidate.technical_analysis.limitations.length) {
    values.push('technical_analysis_method_limitations_remain_applicable');
  }
  if (baseline.transcript.limitations.length || candidate.transcript.limitations.length) {
    values.push('transcript_method_limitations_remain_applicable');
  }
  for (const [domain, value] of Object.entries({
    technical: compatibility.technical,
    transcript: compatibility.transcript,
    advisory: compatibility.advisory
  })) {
    for (const item of value.reasons) values.push(`${domain}:${item.code}`);
  }
  if (findingCompletenessLimited(baseline, policy) || findingCompletenessLimited(candidate, policy)) {
    values.push('unmatched_findings_are_inconclusive_when_public_results_may_be_truncated');
  }
  return values;
}

function findingCompletenessLimited(result, policy) {
  const producerLimit = policy.input.producer_finding_limits.find((entry) => entry.policy_identity === result.analysis_settings.policy_identity);
  const totalFindings = result.deterministic_findings.length + result.advisory_findings.length;
  return result.timeline.truncated === true
    || !producerLimit
    || totalFindings >= producerLimit.maximum_total_findings
    || result.limitations.some((value) => /truncat|public_result_limit/iu.test(value));
}

function overallCompatibilityStatus(compatibility, limitations) {
  const domains = [compatibility.technical, compatibility.transcript, compatibility.advisory];
  if (domains.every((domain) => domain.status === 'incompatible')) return 'incompatible';
  if (domains.some((domain) => domain.status !== 'comparable') || limitations.length > 1 || compatibility.same_media_identity) {
    return 'comparable_with_limitations';
  }
  return 'comparable';
}

function summarizeChanges(changes) {
  const summary = {
    status: 'unchanged',
    new: 0,
    not_detected_in_candidate: 0,
    unmatched_inconclusive: 0,
    persistent: 0,
    moved: 0,
    severity_changed: 0,
    improved: 0,
    regressed: 0,
    inconclusive: 0
  };
  for (const change of changes) {
    summary[change.state] += 1;
    if (change.assessment === 'improved') summary.improved += 1;
    if (change.assessment === 'regressed') summary.regressed += 1;
    if (change.assessment === 'inconclusive') summary.inconclusive += 1;
  }
  if (summary.improved && summary.regressed) summary.status = 'mixed';
  else if (summary.regressed) summary.status = 'regressed';
  else if (summary.improved) summary.status = 'improved';
  else if (summary.inconclusive) summary.status = 'inconclusive';
  else if (changes.some((change) => change.assessment === 'changed')) summary.status = 'changed';
  return summary;
}

function summarizeMetrics(metrics) {
  const summary = { improved: 0, regressed: 0, unchanged: 0, changed: 0, inconclusive: 0, unavailable: 0 };
  for (const metric of metrics) summary[metric.assessment] += 1;
  return summary;
}

function comparableContentDigest(result) {
  return digestPublicJson({
    media_identity: result.media_identity,
    analysis_settings: result.analysis_settings,
    toolchain: result.toolchain,
    technical_analysis: result.technical_analysis,
    transcript: result.transcript,
    timeline: result.timeline,
    deterministic_findings: result.deterministic_findings,
    advisory_findings: result.advisory_findings,
    limitations: result.limitations
  });
}

function enforceComparisonOutput(comparison, policy) {
  assertPublicMediaDataBoundary(comparison);
  const validation = validateJsonSchemaSubset(comparison, getSchema('media_review_comparison'));
  if (!validation.ok) {
    throw comparisonError('MEDIA_REVIEW_COMPARISON_SCHEMA_INVALID', 'The media review comparison does not satisfy its public schema.');
  }
  if (Buffer.byteLength(`${JSON.stringify(comparison)}\n`) > policy.output.maximum_result_bytes) {
    throw comparisonError('MEDIA_REVIEW_COMPARISON_OUTPUT_TOO_LARGE', 'The bounded media review comparison exceeds its output limit.');
  }
}

function enforceComparisonByteBudget(comparison, policy) {
  if (comparisonBytes(comparison) <= policy.output.maximum_result_bytes) return;
  addBoundedLimitation(comparison, 'comparison_finding_changes_truncated_to_byte_limit', policy.output.maximum_limitations);
  let removed = false;
  while (comparisonBytes(comparison) > policy.output.maximum_result_bytes
    && (comparison.advisory_finding_changes.length || comparison.deterministic_finding_changes.length)) {
    if (comparison.advisory_finding_changes.length) comparison.advisory_finding_changes.pop();
    else comparison.deterministic_finding_changes.pop();
    removed = true;
  }
  if (removed) {
    comparison.summary.deterministic = summarizeChanges(comparison.deterministic_finding_changes);
    comparison.summary.advisory = summarizeChanges(comparison.advisory_finding_changes);
    if (comparison.status === 'comparable') comparison.status = 'comparable_with_limitations';
  }
}

function addBoundedLimitation(comparison, limitation, maximum) {
  if (comparison.limitations.includes(limitation)) return;
  if (comparison.limitations.length >= maximum) comparison.limitations.pop();
  comparison.limitations.push(limitation);
}

function comparisonBytes(comparison) {
  return Buffer.byteLength(`${JSON.stringify(comparison)}\n`);
}

function comparisonBoundary() {
  return {
    read_only: true,
    media_reprocessed: false,
    provider_called: false,
    technical_analyzer_called: false,
    browser_launched: false,
    network_performed: false,
    artifact_written: false,
    mcp_execution_exposed: false,
    deterministic_and_advisory_separated: true,
    combined_quality_score_included: false,
    gate_effect: 'none'
  };
}

function renderMetricDiffs(lines, title, metrics) {
  lines.push('', `## ${title}`, '');
  if (!metrics.length) {
    lines.push('No comparable metric changes are available.');
    return;
  }
  for (const metric of metrics) {
    lines.push(`### ${markdownLiteral(metric.id)}`);
    lines.push(`- Baseline: ${markdownLiteral(metric.baseline)}`);
    lines.push(`- Candidate: ${markdownLiteral(metric.candidate)}`);
    lines.push(`- Delta: ${markdownLiteral(metric.delta)}`);
    lines.push(`- Assessment: ${markdownLiteral(metric.assessment)}`, '');
  }
}

function renderFindingChanges(lines, title, changes) {
  lines.push('', `## ${title}`, '');
  if (!changes.length) {
    lines.push('No comparable finding changes are available.');
    return;
  }
  for (const change of changes) {
    const finding = change.candidate ?? change.baseline;
    lines.push(`### ${markdownLiteral(change.state)} · ${markdownLiteral(change.kind)}`);
    lines.push(`- Time: ${markdownLiteral(finding.timecode.start)}–${markdownLiteral(finding.timecode.end)}`);
    lines.push(`- Severity: ${markdownLiteral(finding.severity)}`);
    lines.push(`- Method: ${markdownLiteral(change.method)}`);
    lines.push(`- Assessment: ${markdownLiteral(change.assessment)}`);
    for (const evidence of finding.evidence) lines.push(`- Evidence: ${markdownLiteral(evidence)}`);
    lines.push(`- Recommended fix: ${markdownLiteral(finding.recommendation)}`, '');
  }
}

function markdownLiteral(value) {
  return safePublicText(value)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/([\\`*_{}\[\]()#+.!|~-])/gu, '&#$1;');
}

function safePublicText(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function readSelector(value, selector) {
  let current = value;
  for (const key of selector.split('.')) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, key)) return null;
    current = current[key];
  }
  return current;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function delta(candidate, baseline) {
  return candidate === null || baseline === null ? null : round(candidate - baseline, 9);
}

function perMinute(value, durationUs) {
  return value === null || durationUs === null || durationUs <= 0 ? null : round(value * 60_000_000 / durationUs, 9);
}

function intervalOverlapRatio(left, right) {
  const leftDuration = Math.max(1, left.end_us - left.start_us);
  const rightDuration = Math.max(1, right.end_us - right.start_us);
  const overlap = Math.max(0, Math.min(left.end_us, right.end_us) - Math.max(left.start_us, right.start_us));
  if (overlap > 0) return round(overlap / Math.min(leftDuration, rightDuration), 6);
  return left.start_us === right.start_us && left.end_us === right.end_us ? 1 : 0;
}

function midpoint(value) {
  return (value.start_us + value.end_us) / 2;
}

function compareFindingOrder(left, right) {
  return left.start_us - right.start_us || left.end_us - right.end_us || left.kind.localeCompare(right.kind) || left.method.localeCompare(right.method) || left.id.localeCompare(right.id);
}

function compareFindingChangeOrder(left, right) {
  const leftFinding = left.candidate ?? left.baseline;
  const rightFinding = right.candidate ?? right.baseline;
  return leftFinding.start_us - rightFinding.start_us || left.state.localeCompare(right.state) || left.id.localeCompare(right.id);
}

function reason(code, message) {
  return { code, message };
}

function round(value, precision) {
  const scale = 10 ** precision;
  return Math.round(value * scale) / scale;
}

function failure(code, message) {
  return {
    status: 'error',
    data: { media_review_comparison: { available: false, boundary: comparisonBoundary() } },
    warnings: [],
    errors: [{ code, message, details: {} }],
    artifacts: []
  };
}

function safeCode(error) {
  return typeof error?.code === 'string' && /^MEDIA_REVIEW_COMPARISON_[A-Z0-9_]+$/u.test(error.code)
    ? error.code
    : 'MEDIA_REVIEW_COMPARISON_FAILED';
}

function safeMessage(error) {
  const messages = {
    MEDIA_REVIEW_COMPARISON_RESULT_NOT_FOUND: 'A saved media review result could not be read.',
    MEDIA_REVIEW_COMPARISON_RESULT_FILE_INVALID: 'A saved media review result is not a safe bounded file.',
    MEDIA_REVIEW_COMPARISON_RESULT_CHANGED: 'A saved media review result changed while it was read.',
    MEDIA_REVIEW_COMPARISON_INPUT_SCHEMA_INVALID: 'A saved media review result is incompatible with this comparison contract.',
    MEDIA_REVIEW_COMPARISON_INPUT_PRIVATE_PATH: 'A saved media review result contains private path data and was rejected.',
    MEDIA_REVIEW_COMPARISON_INPUT_PRIVATE_BODY: 'A saved media review result contains private body data and was rejected.',
    MEDIA_REVIEW_COMPARISON_DISTINCT_RESULTS_REQUIRED: 'Choose two different saved media reviews.'
  };
  return messages[error?.code] ?? 'The saved media reviews could not be compared safely.';
}

function comparisonError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.details = {};
  return error;
}
