import { getReviewMethod } from './reviewMethods.js';

const RUNNING_STATUSES = new Set(['running', 'in_progress', 'pending', 'queued', 'preparing', 'executing', 'fetching']);
const PAUSED_STATUSES = new Set(['paused', 'stopped']);
const ATTENTION_STATUSES = new Set(['needs_attention']);
const FAILED_STATUSES = new Set(['failed', 'error', 'blocked', 'unavailable']);
const COMPLETE_STATUSES = new Set(['complete', 'completed', 'ok', 'passed', 'ready', 'success', 'proposal_ready']);

export function buildControlCenterViewModel(dashboard, options = {}) {
  const source = asObject(dashboard);
  const locale = source.settings?.display_language?.current_locale ?? 'en';
  const confirmationItems = buildConfirmationItems(source, locale);
  const runningItems = buildRunningItems(source, confirmationItems, locale);
  const selectedItem = selectConfirmationItem(confirmationItems, options.itemId);
  return {
    confirmationItems,
    runningItems,
    workSummary: buildWorkSummary(source, selectedItem, runningItems),
    sections: Object.freeze({
      sourceIntake: asObject(source.source_intake),
      review: asObject(source.review),
      regression: asObject(source.regression),
      evidence: asObject(source.evidence),
      findings: asObject(source.findings),
      settings: asObject(source.settings),
      advanced: asObject(source.advanced),
      setupSafety: asObject(source.setup_safety)
    })
  };
}

export function buildConfirmationItems(dashboard, locale = dashboard?.settings?.display_language?.current_locale ?? 'en') {
  const source = asObject(dashboard);
  const visualResults = firstArray(
    source.activity?.items,
    source.evidence?.visual_review_results,
    source.review?.visual_review?.results,
    source.findings?.visual_review?.top_results,
    source.confirmation_items
  );
  const matrixRows = asArray(source.evidence?.owner_review_matrix?.rows);
  const items = [];
  const seen = new Set();

  visualResults.forEach((result, index) => {
    const item = confirmationItemFromResult(result, index, source.generated_at, locale);
    if (!seen.has(item.id)) {
      seen.add(item.id);
      items.push(item);
    }
  });

  matrixRows.forEach((row, index) => {
    const value = asObject(row);
    const id = stableId(value.case_id ?? value.id, `matrix-${index + 1}`);
    if (seen.has(id)) return;
    seen.add(id);
    const status = normalizeStatus(value.status ?? matrixRowStatus(value));
    items.push(Object.freeze({
      id,
      title: displayText(value.label ?? value.title) || fallbackItemTitle(locale),
      description: displayText(value.summary),
      summary: displayText(value.summary),
      status,
      statusLabel: localizedStatusLabel(status, locale),
      statusKey: `status.${status}`,
      tone: statusTone(status),
      findingCount: numberOrZero(value.finding_count),
      decisionCount: numberOrZero(value.owner_decision_requests),
      updatedAt: value.updated_at ?? source.generated_at ?? null,
      reviewMethodId: normalizeReviewMethodId(value.review_effort ?? value.effort),
      route: Object.freeze({ page: 'confirm', view: 'work', itemId: id })
    }));
  });

  return Object.freeze(items);
}

export function buildRunningItems(dashboard, confirmationItems = buildConfirmationItems(dashboard), locale = dashboard?.settings?.display_language?.current_locale ?? 'en') {
  const source = asObject(dashboard);
  const candidates = firstArray(
    source.activity?.items,
    source.running_items,
    source.jobs,
    source.executions,
    source.review?.running_items,
    source.review?.visual_review?.executions,
    source.review?.visual_review?.handoff?.jobs
  );
  const items = [];
  const seen = new Set();

  candidates.forEach((candidate, index) => {
    const item = runningItemFromCandidate(candidate, index, locale);
    if (!RUNNING_STATUSES.has(item.status) && !PAUSED_STATUSES.has(item.status)) return;
    if (seen.has(item.id)) return;
    seen.add(item.id);
    items.push(item);
  });

  confirmationItems.forEach((item) => {
    if (!RUNNING_STATUSES.has(item.status) && !PAUSED_STATUSES.has(item.status)) return;
    if (seen.has(item.id)) return;
    seen.add(item.id);
    items.push(Object.freeze({
      id: item.id,
      title: item.title || fallbackItemTitle(locale),
      description: item.summary,
      detail: item.summary,
      status: item.status,
      statusLabel: localizedStatusLabel(item.status, locale),
      statusKey: `status.${item.status}`,
      tone: statusTone(item.status),
      progress: null,
      reviewMethodId: item.reviewMethodId,
      canCancel: false,
      canResume: PAUSED_STATUSES.has(item.status),
      route: Object.freeze({ page: 'running', view: 'work', itemId: item.id })
    }));
  });

  return Object.freeze(items);
}

export function buildWorkSummary(dashboard, selectedItem = null, runningItems = buildRunningItems(dashboard)) {
  const source = asObject(dashboard);
  const review = asObject(source.review);
  const visual = asObject(review.visual_review);
  const findings = asObject(source.findings);
  const evidence = asObject(source.evidence);
  const regression = asObject(source.regression?.playwright_test ?? source.regression);
  const activeRun = runningItems.find((item) => item.id === selectedItem?.id) ?? runningItems[0] ?? null;
  const findingCount = selectedItem?.findingCount ?? numberOrZero(findings.visual_review?.advisory_findings ?? visual.summary?.advisory_findings);
  const decisionCount = selectedItem?.decisionCount ?? numberOrZero(findings.owner_decision_requests ?? visual.summary?.owner_decision_requests);
  const reviewMethodId = normalizeReviewMethodId(
    selectedItem?.reviewMethodId
      ?? source.review_effort
      ?? review.review_effort
      ?? review.owner_review?.review_effort
  );
  const status = activeRun?.status ?? selectedItem?.status ?? normalizeStatus(source.status);

  return Object.freeze({
    itemId: selectedItem?.id ?? activeRun?.id ?? null,
    title: selectedItem?.title ?? activeRun?.title ?? '',
    summary: selectedItem?.summary ?? activeRun?.detail ?? displayText(review.next_action),
    status,
    stage: deriveStage({ source, status, findingCount, decisionCount, regression }),
    reviewMethodId,
    nextReviewMethodId: reviewMethodId ? getReviewMethod(reviewMethodId).nextId : null,
    nextAction: displayText(review.next_action),
    canReviewProceed: review.can_owner_review_proceed === true,
    findingCount,
    decisionCount,
    progress: activeRun?.progress ?? null,
    findings: Object.freeze({
      results: Object.freeze(asArray(findings.visual_review?.top_results)),
      blockers: Object.freeze(asArray(findings.blockers?.groups)),
      findingCount,
      decisionCount
    }),
    evidence: Object.freeze({
      matrix: evidence.owner_review_matrix ?? null,
      visualResults: Object.freeze(asArray(evidence.visual_review_results)),
      playwrightTest: asObject(evidence.playwright_test)
    }),
    regression,
    preparation: asObject(source.source_intake),
    completion: Object.freeze({
      hasResults: confirmationHasResults(selectedItem, visual),
      hasUnresolvedItems: findingCount > 0 || decisionCount > 0,
      canFinish: COMPLETE_STATUSES.has(status) || confirmationHasResults(selectedItem, visual)
    })
  });
}

function confirmationItemFromResult(result, index, generatedAt, locale) {
  const value = asObject(result);
  const id = stableId(value.id ?? value.result_id, `review-${index + 1}`);
  const status = normalizeStatus(value.status ?? value.state);
  const findingCount = numberOrZero(value.finding_count ?? value.advisory?.finding_count);
  const decisionCount = numberOrZero(value.owner_decision_count ?? value.owner_decision_requests ?? value.advisory?.owner_decision_requests);
  const summary = displayText(value.summary) || activityDescription({ findingCount, decisionCount, locale });
  return Object.freeze({
    id,
    title: value.source ? activityTitle(value.source, locale) : displayText(value.target_label ?? value.title ?? value.name) || fallbackItemTitle(locale),
    description: summary,
    summary,
    status,
    statusLabel: localizedStatusLabel(status, locale),
    statusKey: `status.${status}`,
    tone: statusTone(status),
    findingCount,
    decisionCount,
    updatedAt: value.updated_at ?? value.completed_at ?? value.generated_at ?? generatedAt ?? null,
    reviewMethodId: normalizeReviewMethodId(value.review_effort ?? value.effort),
    route: Object.freeze({ page: 'confirm', view: 'work', itemId: id })
  });
}

function runningItemFromCandidate(candidate, index, locale) {
  const value = asObject(candidate);
  const id = stableId(value.id ?? value.execution_id ?? value.job_id, `running-${index + 1}`);
  const status = normalizeStatus(value.status ?? value.state);
  const detail = displayText(value.detail ?? value.summary ?? value.current_step) || localizedStatusLabel(status, locale);
  return Object.freeze({
    id,
    title: value.source ? activityTitle(value.source, locale) : displayText(value.target_label ?? value.title ?? value.name) || fallbackItemTitle(locale),
    description: detail,
    detail,
    status,
    statusLabel: localizedStatusLabel(status, locale),
    statusKey: `status.${status}`,
    tone: statusTone(status),
    progress: normalizeProgress(value.progress ?? value.progress_percent ?? value.percent),
    reviewMethodId: normalizeReviewMethodId(value.review_effort ?? value.effort),
    canCancel: value.can_cancel === true,
    canResume: value.can_resume === true || PAUSED_STATUSES.has(status),
    route: Object.freeze({ page: 'running', view: 'work', itemId: id })
  });
}

function selectConfirmationItem(items, itemId) {
  if (itemId) {
    const selected = items.find((item) => item.id === itemId);
    if (selected) return selected;
  }
  return items.find((item) => !COMPLETE_STATUSES.has(item.status)) ?? items[0] ?? null;
}

function deriveStage({ source, status, findingCount, decisionCount, regression }) {
  const explicit = String(source.workflow_stage ?? source.stage ?? '').trim();
  if (['prepare', 'review', 'decide', 'recheck', 'complete'].includes(explicit)) return explicit;
  if (FAILED_STATUSES.has(status)) return 'review';
  if (RUNNING_STATUSES.has(status) || PAUSED_STATUSES.has(status)) return 'review';
  if (hasRegressionResult(regression)) return COMPLETE_STATUSES.has(status) ? 'complete' : 'recheck';
  if (findingCount > 0 || decisionCount > 0 || source.review?.can_owner_review_proceed === true) return 'decide';
  if (COMPLETE_STATUSES.has(status) && confirmationHasResults(null, source.review?.visual_review)) return 'complete';
  return 'prepare';
}

function hasRegressionResult(regression) {
  const value = asObject(regression);
  return Boolean(value.latest_result ?? value.latest?.result ?? value.result ?? value.review_material);
}

function confirmationHasResults(selectedItem, visual) {
  if (selectedItem) return true;
  const value = asObject(visual);
  return numberOrZero(value.summary?.result_count) > 0 || asArray(value.results).length > 0;
}

function matrixRowStatus(row) {
  const values = ['standard', 'deep', 'xhigh'].map((key) => normalizeStatus(row[key]?.status ?? row[key]));
  if (values.some((status) => FAILED_STATUSES.has(status))) return 'failed';
  if (values.some((status) => RUNNING_STATUSES.has(status))) return 'running';
  if (values.some((status) => COMPLETE_STATUSES.has(status))) return 'complete';
  return 'empty';
}

function normalizeReviewMethodId(value) {
  return ['standard', 'deep', 'xhigh'].includes(value) ? value : null;
}

function normalizeStatus(value) {
  const normalized = String(value ?? 'empty').trim().toLowerCase().replaceAll('-', '_').replaceAll(' ', '_');
  if (RUNNING_STATUSES.has(normalized)) return normalized;
  if (PAUSED_STATUSES.has(normalized)) return normalized;
  if (FAILED_STATUSES.has(normalized)) return normalized;
  if (COMPLETE_STATUSES.has(normalized)) return normalized;
  return normalized || 'empty';
}

function normalizeProgress(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : null;
}

function localizedStatusLabel(status, locale) {
  const japanese = String(locale).toLowerCase() === 'ja';
  if (RUNNING_STATUSES.has(status)) return japanese ? '進行中' : 'In progress';
  if (PAUSED_STATUSES.has(status)) return japanese ? '停止中' : 'Paused';
  if (ATTENTION_STATUSES.has(status)) return japanese ? '確認が必要' : 'Needs attention';
  if (FAILED_STATUSES.has(status)) return japanese ? '確認が必要' : 'Needs attention';
  if (COMPLETE_STATUSES.has(status)) return japanese ? '完了' : 'Complete';
  return japanese ? '準備前' : 'Not started';
}

function statusTone(status) {
  if (RUNNING_STATUSES.has(status)) return 'blue';
  if (PAUSED_STATUSES.has(status)) return 'amber';
  if (ATTENTION_STATUSES.has(status)) return 'amber';
  if (FAILED_STATUSES.has(status)) return 'red';
  if (COMPLETE_STATUSES.has(status)) return 'green';
  return 'neutral';
}

function fallbackItemTitle(locale) {
  return String(locale).toLowerCase() === 'ja' ? '現在の確認' : 'Current review';
}

function activityTitle(source, locale) {
  const japanese = String(locale).toLowerCase() === 'ja';
  const labels = {
    agent_request: japanese ? '確認の依頼' : 'Review request',
    agent_workflow: japanese ? '確認作業' : 'Review workflow',
    agent_execution: japanese ? '実行中の作業' : 'Running work',
    visual_review: japanese ? '画面の確認結果' : 'Visual review result',
    owner_review: japanese ? '判断待ちの確認' : 'Owner review',
    playwright_test: japanese ? '自動テスト結果' : 'Automated test result'
  };
  return labels[source] ?? fallbackItemTitle(locale);
}

function activityDescription({ findingCount, decisionCount, locale }) {
  const japanese = String(locale).toLowerCase() === 'ja';
  if (japanese) return `改善点 ${findingCount}件・判断 ${decisionCount}件`;
  return `${findingCount} improvements, ${decisionCount} decisions`;
}

function stableId(value, fallback) {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function displayText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function firstArray(...values) {
  return values.find((value) => Array.isArray(value) && value.length > 0) ?? [];
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
