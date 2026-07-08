import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_ARTIFACT_ROOT, SCHEMA_VERSION } from './constants.js';
import { resolveArtifactRoot } from './artifacts.js';
import { readBoundedTextFile } from './playwright-test-artifacts.js';
import {
  PLAYWRIGHT_TEST_INTEGRATION_VERSION,
  playwrightTestBoundary,
  summarizeStatusLabel
} from './playwright-test-integration.js';

export const E2E_RESULT_REVIEW_MATERIAL_VERSION = '1.0.0';
export const E2E_RESULT_REVIEW_EFFORTS = Object.freeze(['standard', 'deep', 'xhigh']);

export function e2eResultReviewMaterialBoundary(overrides = {}) {
  return {
    ...playwrightTestBoundary(),
    read_only: true,
    normalized_result_only: true,
    source_artifact_body_read: false,
    source_attachment_body_read: false,
    review_material_written: false,
    result_paths_in_output: false,
    concrete_rerun_command_included: false,
    raw_content_included: false,
    ...overrides
  };
}

export async function runPlaywrightTestReviewMaterial(options = {}, context = {}) {
  const cwd = context.cwd ?? process.cwd();
  const current = await readNormalizedPlaywrightTestResult(cwd, options.result, options);
  if (!current.ok) {
    return resultError(current.code, current.message, current.details);
  }
  let baseline = null;
  if (options.baseline) {
    const baselineRead = await readNormalizedPlaywrightTestResult(cwd, options.baseline, options);
    if (!baselineRead.ok) {
      return resultError(baselineRead.code, baselineRead.message, {
        ...(baselineRead.details ?? {}),
        role: 'baseline'
      });
    }
    baseline = baselineRead.value;
  }
  const material = buildPlaywrightTestReviewMaterial(current.value, { baseline });
  return {
    status: 'ok',
    data: {
      e2e_result_review_material: material,
      boundary: material.boundary
    },
    warnings: [],
    errors: [],
    artifacts: []
  };
}

export async function readNormalizedPlaywrightTestResult(cwd, input, options = {}) {
  if (!input) {
    return fail('PLAYWRIGHT_TEST_RESULT_REQUIRED', 'playwright-test review-material requires --result <id|path>.', {});
  }
  const parsed = await readResultJson(cwd, input, options);
  if (!parsed.ok) {
    return parsed;
  }
  return validateNormalizedPlaywrightTestResult(parsed.value);
}

export function buildPlaywrightTestReviewMaterial(result, options = {}) {
  const baseline = options.baseline ?? null;
  const current = summarizeResult(result);
  const comparison = baseline ? compareResults(result, baseline) : unavailableComparison('baseline_not_supplied');
  const evidenceQuality = buildEvidenceQuality(result);
  const limitations = buildLimitations(result, comparison);
  const reviewCards = buildReviewCards({ result, current, evidenceQuality, limitations, comparison });
  const nextAction = nextActionForResult(result, evidenceQuality);
  const ownerSummary = buildOwnerSummary(current, evidenceQuality, comparison);
  return {
    schema_version: SCHEMA_VERSION,
    review_material_version: E2E_RESULT_REVIEW_MATERIAL_VERSION,
    kind: 'e2e_result_review_material',
    adapter: {
      kind: 'playwright_test',
      integration_version: PLAYWRIGHT_TEST_INTEGRATION_VERSION
    },
    result: current,
    owner_summary: ownerSummary,
    review_cards: reviewCards,
    evidence_quality: evidenceQuality,
    limitations,
    comparison,
    next_action: nextAction,
    review_input_by_effort: buildReviewInputs({
      current,
      ownerSummary,
      reviewCards,
      evidenceQuality,
      limitations,
      comparison,
      nextAction
    }),
    raw_content_included: false,
    boundary: e2eResultReviewMaterialBoundary()
  };
}

export function buildPlaywrightTestReviewProjectionFromResults(current, baseline = null) {
  const currentValidation = validateNormalizedPlaywrightTestResult(current);
  if (!currentValidation.ok) {
    return null;
  }
  let baselineValue = null;
  if (baseline) {
    const baselineValidation = validateNormalizedPlaywrightTestResult(baseline);
    baselineValue = baselineValidation.ok ? baselineValidation.value : null;
  }
  const material = buildPlaywrightTestReviewMaterial(currentValidation.value, { baseline: baselineValue });
  return compactReviewProjection(material);
}

function compactReviewProjection(material) {
  return {
    schema_version: material.schema_version,
    review_material_version: material.review_material_version,
    kind: material.kind,
    result: material.result,
    owner_summary: material.owner_summary,
    review_cards: material.review_cards,
    evidence_quality: material.evidence_quality,
    limitations: material.limitations,
    comparison: material.comparison,
    next_action: material.next_action,
    review_input_by_effort: material.review_input_by_effort,
    raw_content_included: false,
    boundary: material.boundary
  };
}

async function readResultJson(cwd, input, options = {}) {
  const value = String(input ?? '');
  if (value.includes('/') || value.includes('\\')) {
    const read = await readBoundedTextFile(cwd, value);
    if (!read.ok) {
      return read;
    }
    try {
      return { ok: true, value: JSON.parse(read.text) };
    } catch {
      return fail('PLAYWRIGHT_TEST_RESULT_JSON_INVALID', 'Playwright Test normalized result JSON could not be parsed.', {});
    }
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    return fail('PLAYWRIGHT_TEST_RESULT_ID_INVALID', 'Playwright Test result id must be a simple artifact id.', {});
  }
  let root;
  try {
    root = resolveArtifactRoot(cwd, options['artifact-root'] ?? DEFAULT_ARTIFACT_ROOT);
  } catch (error) {
    return fail('PLAYWRIGHT_TEST_ARTIFACT_ROOT_INVALID', error.message, {});
  }
  const file = path.join(root, 'playwright-test-results', value.endsWith('.json') ? value : `${value}.json`);
  try {
    return { ok: true, value: JSON.parse(await readFile(file, 'utf8')) };
  } catch {
    return fail('PLAYWRIGHT_TEST_RESULT_NOT_FOUND', 'Playwright Test result could not be read.', {});
  }
}

function validateNormalizedPlaywrightTestResult(value) {
  if (!value || typeof value !== 'object') {
    return fail('PLAYWRIGHT_TEST_RESULT_INVALID', 'Playwright Test review material requires a normalized result object.', {});
  }
  if (value.kind !== 'playwright_test_result') {
    return fail('PLAYWRIGHT_TEST_RESULT_KIND_INVALID', 'Playwright Test review material accepts only normalized playwright_test_result artifacts.', {
      kind: value.kind ?? null
    });
  }
  const boundary = value.boundary ?? {};
  const summary = value.summary ?? {};
  const source = value.source ?? {};
  if (
    value.raw_content_included === true ||
    summary.raw_content_included === true ||
    source.raw_content_included === true ||
    boundary.raw_artifact_content_included === true
  ) {
    return fail('PLAYWRIGHT_TEST_RESULT_RAW_CONTENT_REJECTED', 'Playwright Test review material cannot include raw artifact content.', {});
  }
  if (
    boundary.existing_review_mutated === true ||
    boundary.deterministic_findings_mutated === true ||
    boundary.release_gate_mutated === true ||
    boundary.gate_effect !== undefined && boundary.gate_effect !== 'none'
  ) {
    return fail('PLAYWRIGHT_TEST_RESULT_BOUNDARY_REJECTED', 'Playwright Test result boundary is not advisory and gate-neutral.', {});
  }
  return { ok: true, value };
}

function summarizeResult(result) {
  const summary = result.summary ?? {};
  return {
    id: safeToken(result.id),
    status: safeToken(result.status) || 'empty',
    status_label: safeText(result.status_label || summarizeStatusLabel(result.status)),
    source_kind: safeToken(result.source?.kind) || 'unknown',
    format: safeToken(summary.format) || 'unknown',
    total_count: toCount(summary.total_count),
    passed_count: toCount(summary.passed_count),
    failed_count: toCount(summary.failed_count),
    skipped_count: toCount(summary.skipped_count),
    flaky_count: toCount(summary.flaky_count),
    timed_out_count: toCount(summary.timed_out_count),
    attachment_count: toCount(summary.attachment_count),
    project_names: safeList(summary.project_names, 20),
    generated_at: safeText(result.freshness?.generated_at ?? summary.generated_at ?? null),
    stale: result.freshness?.stale === true,
    evidence_missing: summary.evidence_missing === true || result.status === 'evidence_missing',
    raw_content_included: false
  };
}

function buildEvidenceQuality(result) {
  const summary = result.summary ?? {};
  const signals = [];
  let status = 'usable';
  if (summary.evidence_missing === true || result.status === 'evidence_missing') {
    status = 'missing';
    signals.push('No machine-readable JSON or JUnit result was found in the imported artifact.');
  }
  if (result.freshness?.stale === true) {
    status = status === 'missing' ? 'missing' : 'stale';
    signals.push('The imported result is marked stale.');
  }
  if ((summary.format ?? '') === 'html_report_reference' && status !== 'missing') {
    status = 'limited';
    signals.push('The HTML report was recorded as a reference only; report contents were not embedded.');
  }
  if ((summary.top_failures ?? []).length === 0 && toCount(summary.failed_count) > 0) {
    status = status === 'usable' ? 'limited' : status;
    signals.push('Failure counts are available, but detailed failed scenario summaries are not present.');
  }
  if (signals.length === 0) {
    signals.push('Normalized counts and bounded failure summaries are available.');
  }
  return {
    status,
    signals,
    top_failure_count: Math.min((summary.top_failures ?? []).length, 5),
    raw_content_included: false,
    source_artifact_body_read: false
  };
}

function buildLimitations(result, comparison) {
  const summary = result.summary ?? {};
  const limitations = [
    'This is advisory regression material, not a release gate or proof result.',
    'Raw Playwright artifacts, logs, traces, screenshots, and attachment bodies are not included.'
  ];
  if ((summary.top_failures ?? []).length === 0 && toCount(summary.failed_count) > 0) {
    limitations.push('Detailed failure names are unavailable for this imported format.');
  }
  if (summary.evidence_missing === true || result.status === 'evidence_missing') {
    limitations.push('The imported artifact did not contain machine-readable test result data.');
  }
  if (comparison.status === 'unavailable') {
    limitations.push('No comparable baseline was supplied for trend analysis.');
  }
  if (comparison.status === 'incompatible') {
    limitations.push('The supplied baseline was not comparable to the current result.');
  }
  return limitations.slice(0, 6);
}

function buildReviewCards({ result, current, evidenceQuality, limitations, comparison }) {
  const summary = result.summary ?? {};
  const cards = [{
    id: 'status',
    type: 'result_status',
    status: current.status,
    title: current.status_label,
    body: `${current.failed_count} failed, ${current.passed_count} passed, ${current.skipped_count} skipped out of ${current.total_count} tests.`,
    owner_action: current.failed_count > 0 ? 'Ask the developer to inspect the failed scenarios first.' : 'Use this as advisory regression evidence for the current review.',
    evidence_refs: [{ kind: 'playwright_test_result', id: current.id }]
  }];
  const failures = Array.isArray(summary.top_failures) ? summary.top_failures.slice(0, 5) : [];
  for (const [index, failure] of failures.entries()) {
    cards.push({
      id: `failure-${index + 1}`,
      type: 'failed_scenario',
      status: safeToken(failure.status) || 'failed',
      title: safeText(failure.title || `Failed scenario ${index + 1}`).slice(0, 160),
      body: safeText(failure.error_excerpt || 'No bounded error excerpt was available.').slice(0, 500),
      owner_action: 'Use this scenario as the first reproduction target.',
      project_name: safeText(failure.project_name || '').slice(0, 120),
      evidence_refs: [{ kind: 'playwright_test_result', id: current.id, card: `failure-${index + 1}` }]
    });
  }
  cards.push({
    id: 'evidence-quality',
    type: 'evidence_quality',
    status: evidenceQuality.status,
    title: 'Evidence quality',
    body: evidenceQuality.signals.join(' '),
    owner_action: evidenceQuality.status === 'missing' ? 'Import JSON or JUnit output before relying on this result.' : 'Use the available bounded summary without opening raw artifacts.',
    evidence_refs: [{ kind: 'playwright_test_result', id: current.id }]
  });
  cards.push({
    id: 'comparison',
    type: 'baseline_comparison',
    status: comparison.status,
    title: 'Baseline comparison',
    body: comparison.summary,
    owner_action: comparison.status === 'comparable' && comparison.direction === 'regressed'
      ? 'Treat the current run as a regression candidate.'
      : 'Use comparison only as supporting context.',
    evidence_refs: comparison.baseline_id ? [
      { kind: 'playwright_test_result', id: current.id },
      { kind: 'playwright_test_result', id: comparison.baseline_id }
    ] : [{ kind: 'playwright_test_result', id: current.id }]
  });
  cards.push({
    id: 'limitations',
    type: 'limitations',
    status: 'advisory',
    title: 'What this does not prove',
    body: limitations.join(' '),
    owner_action: 'Do not treat this as Agentic Human Review proof or release approval.',
    evidence_refs: []
  });
  return cards;
}

function compareResults(current, baseline) {
  const now = summarizeResult(current);
  const before = summarizeResult(baseline);
  const compatibility = comparableReasons(now, before);
  if (compatibility.length > 0) {
    return {
      status: 'incompatible',
      direction: 'unavailable',
      summary: 'Current and baseline results are not comparable.',
      reasons: compatibility,
      baseline_id: before.id,
      raw_content_included: false
    };
  }
  const failedDelta = now.failed_count - before.failed_count;
  const passedDelta = now.passed_count - before.passed_count;
  const totalDelta = now.total_count - before.total_count;
  const direction = failedDelta > 0
    ? 'regressed'
    : failedDelta < 0
      ? 'improved'
      : 'unchanged';
  return {
    status: 'comparable',
    direction,
    summary: comparisonSummary(direction, failedDelta, totalDelta),
    baseline_id: before.id,
    baseline_status: before.status,
    current_status: now.status,
    deltas: {
      total_count: totalDelta,
      passed_count: passedDelta,
      failed_count: failedDelta,
      skipped_count: now.skipped_count - before.skipped_count,
      flaky_count: now.flaky_count - before.flaky_count,
      timed_out_count: now.timed_out_count - before.timed_out_count
    },
    raw_content_included: false
  };
}

function unavailableComparison(reason) {
  return {
    status: 'unavailable',
    direction: 'unavailable',
    summary: 'No comparable baseline is available.',
    reasons: [reason],
    raw_content_included: false
  };
}

function comparableReasons(current, baseline) {
  const reasons = [];
  if (current.source_kind !== baseline.source_kind) {
    reasons.push('source_kind_changed');
  }
  if (current.format !== baseline.format) {
    reasons.push('format_changed');
  }
  if (current.project_names.length > 0 || baseline.project_names.length > 0) {
    const currentProjects = [...current.project_names].sort().join('|');
    const baselineProjects = [...baseline.project_names].sort().join('|');
    if (currentProjects !== baselineProjects) {
      reasons.push('project_set_changed');
    }
  }
  if (current.evidence_missing || baseline.evidence_missing) {
    reasons.push('evidence_missing');
  }
  return reasons;
}

function buildOwnerSummary(current, evidenceQuality, comparison) {
  const headline = current.failed_count > 0
    ? `${current.failed_count} of ${current.total_count} Playwright tests need attention.`
    : current.evidence_missing
      ? 'Playwright Test result evidence is missing.'
      : `${current.total_count} Playwright tests are available as advisory regression evidence.`;
  return {
    headline,
    status: current.status,
    plain_language_summary: [
      headline,
      evidenceQuality.signals[0],
      comparison.status === 'comparable' ? comparison.summary : ''
    ].filter(Boolean).join(' '),
    raw_content_included: false
  };
}

function buildReviewInputs({ current, ownerSummary, reviewCards, evidenceQuality, limitations, comparison, nextAction }) {
  const failureLines = reviewCards
    .filter((card) => card.type === 'failed_scenario')
    .map((card) => `- ${card.title}: ${card.body}`)
    .slice(0, 5);
  const shared = [
    `Status: ${current.status_label}`,
    `Counts: total ${current.total_count}, passed ${current.passed_count}, failed ${current.failed_count}, skipped ${current.skipped_count}, flaky ${current.flaky_count}, timed out ${current.timed_out_count}.`,
    `Evidence quality: ${evidenceQuality.status}. ${evidenceQuality.signals.join(' ')}`,
    `Comparison: ${comparison.summary}`,
    `Next action: ${nextAction}`
  ];
  return {
    standard: reviewInput('standard', [
      ownerSummary.plain_language_summary,
      ...shared,
      ...failureLines
    ]),
    deep: reviewInput('deep', [
      ownerSummary.plain_language_summary,
      ...shared,
      'Failure scenario summaries:',
      ...(failureLines.length > 0 ? failureLines : ['- No bounded failed scenario summaries are available.']),
      `Limitations: ${limitations.join(' ')}`
    ]),
    xhigh: reviewInput('xhigh', [
      ownerSummary.plain_language_summary,
      ...shared,
      'Failure scenario summaries:',
      ...(failureLines.length > 0 ? failureLines : ['- No bounded failed scenario summaries are available.']),
      `Limitations: ${limitations.join(' ')}`,
      'Review stance: verify whether the regression evidence is sufficient, identify missing evidence, and separate confirmed test failures from advisory limitations.'
    ])
  };
}

function reviewInput(effort, lines) {
  return {
    effort,
    source_kind: 'playwright_test_result',
    prompt_context: lines.filter(Boolean).join('\n').slice(0, effort === 'xhigh' ? 4500 : effort === 'deep' ? 3000 : 1800),
    raw_content_included: false,
    provider_call_performed: false,
    boundary: e2eResultReviewMaterialBoundary()
  };
}

function nextActionForResult(result, evidenceQuality) {
  if (evidenceQuality.status === 'missing') {
    return 'Import JSON or JUnit Playwright Test output so TraceCue can summarize actual results.';
  }
  if (result.status === 'failed') {
    return 'Review the failed scenario cards and hand the bounded evidence summary to the developer.';
  }
  if (result.status === 'passed') {
    return 'Use this as advisory regression evidence and continue the owner review flow.';
  }
  return 'Use the review cards as advisory regression context.';
}

function comparisonSummary(direction, failedDelta, totalDelta) {
  if (direction === 'regressed') {
    return `Failed tests increased by ${failedDelta}. Total test count changed by ${totalDelta}.`;
  }
  if (direction === 'improved') {
    return `Failed tests decreased by ${Math.abs(failedDelta)}. Total test count changed by ${totalDelta}.`;
  }
  return `Failed test count is unchanged. Total test count changed by ${totalDelta}.`;
}

function safeText(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
}

function safeToken(value) {
  return safeText(value).replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 160);
}

function safeList(values, limit) {
  if (!Array.isArray(values)) return [];
  return values.map((value) => safeText(value).slice(0, 120)).filter(Boolean).slice(0, limit);
}

function toCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.floor(number);
}

function resultError(code, message, details = {}) {
  return {
    status: 'error',
    data: { boundary: e2eResultReviewMaterialBoundary() },
    warnings: [],
    errors: [{ code, message, details }],
    artifacts: []
  };
}

function fail(code, message, details = {}) {
  return { ok: false, code, message, details };
}
