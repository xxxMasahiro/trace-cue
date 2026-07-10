import { CLI_NAME, DEFAULT_ARTIFACT_ROOT, SCHEMA_VERSION } from './constants.js';
import {
  runAgentRequestsList,
  runAgentWorkflowIndex
} from './agent.js';
import { runAgentExecutionList } from './agent-execution.js';
import { runAgenticHumanReviewDogfoodEvidencePackReviewPack } from './agentic-human-review.js';
import { runArtifactRootStatus } from './artifact-root-policy.js';
import { controlCenterActionCapabilities } from './control-center-actions.js';
import { controlCenterPreferenceSummary, readControlCenterPreferences } from './control-center-preferences.js';
import {
  CONTROL_CENTER_AGENTIC_REVIEW_ENDPOINTS,
  runControlCenterAgenticReviewList
} from './control-center-agentic-review-actions.js';
import { runLanguageSettings } from './language-settings.js';
import { buildMcpCapabilityReport } from './mcp-capabilities.js';
import { buildPlaywrightTestRegressionSummary } from './playwright-test-regression.js';
import { runResourceStatus } from './resource-status.js';
import { runVisualReviewDashboard } from './visual-review-dashboard.js';

const CONTROL_CENTER_READ_MODEL_VERSION = '1.5.0';
const DEFAULT_RESULT_LIMIT = 5;
const DEFAULT_ACTIVITY_LIMIT = 50;
const ACTIVITY_STATES = Object.freeze(['waiting', 'running', 'needs_attention', 'ready', 'blocked']);
const ACTIVITY_SOURCES = Object.freeze([
  'agent_request',
  'agent_workflow',
  'agent_execution',
  'visual_review',
  'owner_review',
  'playwright_test'
]);

export function controlCenterBoundary() {
  return {
    local_only: true,
    read_only: true,
    browser_launched: false,
    writes_artifacts: false,
    deletes_files: false,
    provider_call_performed: false,
    api_call_performed: false,
    process_spawned: false,
    network_used: false,
    gh_used: false,
    gh_write_used: false,
    automatic_upload: false,
    external_evidence_transfer: false,
    raw_pixels_read: false,
    raw_pixels_included: false,
    raw_pixels_transferred: false,
    raw_artifact_content_included: false,
    raw_provider_response_stored: false,
    credential_values_recorded: false,
    existing_review_mutated: false,
    mcp_execution_exposed: false,
    mcp_write_execute_exposed: false,
    shell_used: false,
    gate_effect: 'none'
  };
}

export async function runControlCenterStatus(options = {}, context = {}) {
  const model = await buildControlCenterReadModel(options, context);
  return {
    status: model.status === 'error' ? 'error' : 'ok',
    data: {
      control_center: model,
      boundary: model.boundary
    },
    warnings: model.warnings,
    errors: model.errors,
    artifacts: []
  };
}

export async function buildControlCenterReadModel(options = {}, context = {}) {
  const now = materializeNow(context.now);
  const artifactRoot = options['artifact-root'] ?? DEFAULT_ARTIFACT_ROOT;
  const visualOptions = compactObject({
    'artifact-root': artifactRoot,
    limit: options.limit,
    'max-bytes': options['max-bytes']
  });
  const sharedContext = { ...context, now };
  const [
    visual,
    agentRequests,
    agentWorkflows,
    agentExecutions,
    resources,
    language,
    artifactRootStatus,
    playwrightTest,
    ownerReview,
    preferences,
    agenticReview
  ] = await Promise.all([
    safeRead('visual_review_dashboard', () => runVisualReviewDashboard(visualOptions, sharedContext)),
    safeRead('agent_requests', () => runAgentRequestsList({ 'artifact-root': artifactRoot }, sharedContext)),
    safeRead('agent_workflows', () => runAgentWorkflowIndex({ 'artifact-root': artifactRoot }, sharedContext)),
    safeRead('agent_executions', () => runAgentExecutionList({ 'artifact-root': artifactRoot }, sharedContext)),
    safeRead('resource_status', () => runResourceStatus({}, sharedContext)),
    safeRead('language_settings', () => runLanguageSettings({}, sharedContext)),
    safeRead('artifact_root_status', () => runArtifactRootStatus({}, sharedContext)),
    safeRead('playwright_test', () => runPlaywrightTestReadModel(artifactRoot, sharedContext)),
    readOwnerReview(options, sharedContext),
    safeRead('control_center_preferences', async () => ({
      status: 'ok',
      data: { control_center_preferences: await readControlCenterPreferences(sharedContext) },
      warnings: [],
      errors: [],
      artifacts: []
    })),
    safeRead('control_center_agentic_review', () => runControlCenterAgenticReviewList(
      { limit: DEFAULT_ACTIVITY_LIMIT },
      { ...sharedContext, artifactRoot }
    ))
  ]);

  const sources = {
    visual,
    agentRequests,
    agentWorkflows,
    agentExecutions,
    resources,
    language,
    artifactRootStatus,
    playwrightTest,
    ownerReview,
    preferences,
    agenticReview
  };
  const warnings = collectMessages(sources, 'warnings');
  const errors = collectMessages(sources, 'errors');
  const visualSummary = summarizeVisualReview(visual);
  const ownerSummary = summarizeOwnerReview(ownerReview);
  const languageSummary = summarizeLanguage(language);
  const actionCapabilities = controlCenterActionCapabilities();
  const playwrightSummary = summarizePlaywrightTest(playwrightTest, actionCapabilities);
  const status = overallStatus({ visual: visualSummary, ownerReview: ownerSummary, errors });
  const nextActions = buildNextActions({ status, visual: visualSummary, ownerReview: ownerSummary, resources });
  const activity = buildControlCenterActivity({
    agentRequests,
    agentWorkflows,
    agentExecutions,
    visual: visualSummary,
    ownerReview: ownerSummary,
    playwrightTest: playwrightSummary
  });
  const operatorFlow = buildControlCenterOperatorFlow(activity);

  return {
    schema_version: SCHEMA_VERSION,
    control_center_read_model_version: CONTROL_CENTER_READ_MODEL_VERSION,
    generated_at: now.toISOString(),
    status,
    status_label: statusLabel(status),
    read_model_freshness: {
      generated_at: now.toISOString(),
      stale: false
    },
    activity,
    operator_flow: operatorFlow,
    agentic_review: summarizeControlCenterAgenticReview(agenticReview),
    review: {
      can_owner_review_proceed: ownerSummary.can_owner_review_proceed,
      next_action: nextActions[0] ?? fallbackAction(status),
      top_owner_actions: nextActions.slice(0, 3),
      owner_review: ownerSummary,
      visual_review: visualSummary,
      trust_safety: trustSafetySummary()
    },
    evidence: {
      owner_review_matrix: ownerSummary.matrix,
      visual_review_results: visualSummary.results,
      playwright_test: playwrightSummary
    },
    findings: {
      visual_review: visualSummary.findings,
      owner_decision_requests: visualSummary.owner_decision_requests,
      blockers: ownerSummary.blockers
    },
    source_intake: summarizeSourceIntake(actionCapabilities),
    regression: {
      playwright_test: playwrightSummary,
      boundary: controlCenterBoundary()
    },
    settings: {
      display_language: summarizeDisplayLanguage(languageSummary, actionCapabilities),
      playwright_test: summarizePlaywrightTestSettings(playwrightSummary, actionCapabilities),
      control_center: controlCenterPreferenceSummary(preferences.data?.control_center_preferences),
      boundary: controlCenterBoundary()
    },
    setup_safety: {
      artifact_root: summarizeArtifactRoot(artifactRootStatus),
      resource_status: summarizeResourceStatus(resources),
      language_settings: languageSummary,
      mcp: summarizeMcpCapabilities(),
      boundary: controlCenterBoundary()
    },
    advanced: {
      commands: {
        dashboard: `${CLI_NAME} control-center status --json`,
      visual_review_dashboard: `${CLI_NAME} visual review dashboard --json`,
        settings_language: `${CLI_NAME} settings language --json`,
        playwright_test_status: `${CLI_NAME} playwright-test status --json`
      },
      source_statuses: sourceStatuses(sources),
      action_capabilities: actionCapabilities,
      warnings,
      errors,
      boundary: controlCenterBoundary()
    },
    query: {
      artifact_root: artifactRoot,
      limit: options.limit ?? null,
      max_bytes: options['max-bytes'] ?? null,
      owner_review_input_supplied: Boolean(options['evidence-set'] || options.input)
    },
    warnings,
    errors,
    boundary: controlCenterBoundary(),
    gate_effect: 'none'
  };
}

function summarizeControlCenterAgenticReview(source) {
  const value = source.data?.control_center_agentic_review ?? {};
  const items = Array.isArray(value.operations) ? value.operations : [];
  const runningStates = new Set(['preparing', 'dispatching', 'validating']);
  return {
    status: source.status === 'error' ? 'error' : items.length > 0 ? 'available' : 'empty',
    items,
    counts: {
      total: items.length,
      running: items.filter((item) => runningStates.has(item.state)).length,
      confirmation_required: items.filter((item) => item.state === 'confirmation_required').length,
      completed: items.filter((item) => item.state === 'completed').length,
      needs_attention: items.filter((item) => ['failed', 'dispatch_unknown'].includes(item.state)).length
    },
    endpoints: CONTROL_CENTER_AGENTIC_REVIEW_ENDPOINTS,
    projection: {
      paths_included: false,
      hashes_included: false,
      commands_included: false,
      raw_bodies_included: false,
      credential_values_included: false
    },
    boundary: controlCenterBoundary()
  };
}

export function buildControlCenterActivity({
  agentRequests = {},
  agentWorkflows = {},
  agentExecutions = {},
  visual = {},
  ownerReview = {},
  playwrightTest = {}
} = {}) {
  const discoveredItems = [
    ...activityItemsFromAgentRequests(agentRequests),
    ...activityItemsFromAgentWorkflows(agentWorkflows),
    ...activityItemsFromAgentExecutions(agentExecutions),
    ...activityItemsFromVisualReview(visual),
    ...activityItemsFromOwnerReview(ownerReview),
    ...activityItemsFromPlaywrightTest(playwrightTest)
  ].sort(compareActivityItems);
  const items = discoveredItems.slice(0, DEFAULT_ACTIVITY_LIMIT);
  const counts = activityCounts(items, discoveredItems.length);
  return {
    status: items.length > 0 ? 'available' : 'empty',
    items,
    counts,
    empty: items.length === 0,
    limit: DEFAULT_ACTIVITY_LIMIT,
    truncated: discoveredItems.length > items.length,
    projection: {
      summary_only: true,
      paths_included: false,
      commands_included: false,
      raw_bodies_included: false,
      navigation_only: true
    },
    boundary: controlCenterBoundary()
  };
}

export function buildControlCenterOperatorFlow(activity = {}) {
  const counts = activity.counts ?? activityCounts([]);
  const runningCount = numberOrZero(counts.running) + numberOrZero(counts.waiting);
  const workCount = numberOrZero(counts.needs_attention) + numberOrZero(counts.ready) + numberOrZero(counts.blocked);
  const primaryDestination = numberOrZero(counts.needs_attention) + numberOrZero(counts.blocked) > 0
    ? 'work'
    : runningCount > 0
      ? 'running'
      : numberOrZero(counts.total) > 0
        ? 'confirm'
        : 'new';
  return {
    status: 'available',
    primary_destination: primaryDestination,
    sections: [
      operatorSection('confirm', 'operator.confirm', 'operator.confirm.purpose', numberOrZero(counts.total), true),
      operatorSection('new', 'operator.new', 'operator.new.purpose', 0, false),
      operatorSection('work', 'operator.work', 'operator.work.purpose', workCount, false),
      operatorSection('running', 'operator.running', 'operator.running.purpose', runningCount, true),
      operatorSection('settings', 'operator.settings', 'operator.settings.purpose', 0, true)
    ],
    navigation_only: true,
    action_execution_exposed: false,
    provider_execution_exposed: false,
    browser_execution_exposed: false,
    mcp_execution_exposed: false,
    gate_effect: 'none',
    boundary: controlCenterBoundary()
  };
}

function activityItemsFromAgentRequests(source) {
  const requests = source.data?.agent_requests ?? source.agent_requests ?? [];
  return arrayOf(requests).map((request, index) => {
    const state = activityStateForAdvisory(request.status, request);
    return activityItem({
      source: 'agent_request',
      sourceId: request.package_id,
      index,
      state,
      title: 'Agent review request',
      updatedAt: request.created_at,
      findingCount: request.advisory_findings,
      ownerDecisionCount: request.owner_decision_requests
    });
  });
}

function activityItemsFromAgentWorkflows(source) {
  const workflows = source.data?.agent_workflows ?? source.agent_workflows ?? [];
  return arrayOf(workflows).map((workflow, index) => {
    const state = activityStateForAdvisory(workflow.status, workflow);
    return activityItem({
      source: 'agent_workflow',
      sourceId: workflow.id,
      index,
      state,
      title: 'Agent review workflow',
      updatedAt: workflow.updated_at ?? workflow.created_at,
      findingCount: workflow.advisory_findings,
      ownerDecisionCount: workflow.owner_decision_requests
    });
  });
}

function activityItemsFromAgentExecutions(source) {
  const executions = source.data?.agent_executions ?? source.agent_executions ?? [];
  return arrayOf(executions).map((execution, index) => activityItem({
    source: 'agent_execution',
    sourceId: execution.id,
    index,
    state: activityStateForExecution(execution.status),
    title: 'Agent execution',
    updatedAt: execution.evaluated_at ?? execution.completed_at ?? execution.created_at
  }));
}

function activityItemsFromVisualReview(visual) {
  return arrayOf(visual.results).map((result, index) => activityItem({
    source: 'visual_review',
    sourceId: result.id,
    index,
    state: activityStateForReviewResult(result),
    title: 'Visual review result',
    updatedAt: result.updated_at ?? result.completed_at ?? result.created_at,
    findingCount: result.finding_count,
    ownerDecisionCount: result.owner_decision_requests
  }));
}

function activityItemsFromOwnerReview(ownerReview) {
  if (!ownerReview || ['disabled', undefined, null].includes(ownerReview.status)) {
    return [];
  }
  return [activityItem({
    source: 'owner_review',
    sourceId: 'owner-review',
    index: 0,
    state: activityStateForOwnerReview(ownerReview),
    title: 'Owner review',
    findingCount: ownerReview.overview?.blocked_group_count,
    ownerDecisionCount: arrayOf(ownerReview.top_owner_actions).length
  })];
}

function activityItemsFromPlaywrightTest(playwrightTest) {
  const result = playwrightTest.last_result;
  const projection = playwrightTest.review_projection;
  if (!result && !projection) {
    return [];
  }
  const summary = projection?.result ?? result ?? {};
  return [activityItem({
    source: 'playwright_test',
    sourceId: summary.id ?? 'latest',
    index: 0,
    state: activityStateForPlaywright(playwrightTest, summary),
    title: 'Playwright Test result',
    updatedAt: summary.completed_at ?? summary.imported_at ?? summary.created_at ?? summary.generated_at,
    findingCount: summary.failed_count,
    ownerDecisionCount: projection?.owner_summary?.owner_decision_count
  })];
}

function activityItem({
  source,
  sourceId,
  index,
  state,
  title,
  updatedAt,
  findingCount = 0,
  ownerDecisionCount = 0
}) {
  const normalizedState = ACTIVITY_STATES.includes(state) ? state : 'needs_attention';
  return {
    id: `${source}:${safeActivityIdentifier(sourceId, index)}`,
    source,
    state: normalizedState,
    status_label: activityStatusLabel(normalizedState),
    title,
    updated_at: safeTimestamp(updatedAt),
    finding_count: numberOrZero(findingCount),
    owner_decision_count: numberOrZero(ownerDecisionCount),
    navigation: {
      destination: ['waiting', 'running'].includes(normalizedState) ? 'running' : 'work',
      intent: ['waiting', 'running'].includes(normalizedState) ? 'inspect_progress' : 'inspect_result'
    },
    can_execute: false,
    gate_effect: 'none'
  };
}

function activityStateForAdvisory(status, item = {}) {
  if (status === 'package_missing') {
    return 'blocked';
  }
  if (status === 'waiting_for_agent') {
    return 'waiting';
  }
  if (status === 'advisory_imported') {
    return numberOrZero(item.advisory_findings) + numberOrZero(item.owner_decision_requests) > 0
      ? 'needs_attention'
      : 'ready';
  }
  return activityStateForExecution(status);
}

function activityStateForExecution(status) {
  const normalized = String(status ?? '').toLowerCase();
  if (['running', 'in_progress', 'executing', 'started'].includes(normalized)) {
    return 'running';
  }
  if (['waiting', 'pending', 'prepared', 'planned', 'queued', 'waiting_for_agent'].includes(normalized)) {
    return 'waiting';
  }
  if (['completed', 'complete', 'ok', 'passed', 'succeeded', 'success'].includes(normalized)) {
    return 'ready';
  }
  if (['blocked', 'error', 'failed', 'failure', 'package_missing'].includes(normalized)) {
    return 'blocked';
  }
  return 'needs_attention';
}

function activityStateForReviewResult(result) {
  if (['blocked', 'error', 'failed'].includes(result.status)) {
    return 'blocked';
  }
  if (numberOrZero(result.finding_count) + numberOrZero(result.owner_decision_requests) > 0) {
    return 'needs_attention';
  }
  return 'ready';
}

function activityStateForOwnerReview(ownerReview) {
  if (['blocked', 'incomplete', 'error'].includes(ownerReview.status)) {
    return 'blocked';
  }
  if (ownerReview.status === 'ready_for_owner_review' && ownerReview.can_owner_review_proceed === true) {
    return 'ready';
  }
  return 'needs_attention';
}

function activityStateForPlaywright(playwrightTest, result) {
  if (playwrightTest.status === 'error') {
    return 'blocked';
  }
  if (numberOrZero(result.failed_count) + numberOrZero(result.flaky_count) > 0 || result.status === 'failed') {
    return 'needs_attention';
  }
  return 'ready';
}

function activityCounts(items, discoveredTotal = items.length) {
  const counts = {
    total: items.length,
    discovered_total: discoveredTotal,
    waiting: 0,
    running: 0,
    needs_attention: 0,
    ready: 0,
    blocked: 0,
    by_source: Object.fromEntries(ACTIVITY_SOURCES.map((source) => [source, 0]))
  };
  for (const item of items) {
    if (ACTIVITY_STATES.includes(item.state)) {
      counts[item.state] += 1;
    }
    if (ACTIVITY_SOURCES.includes(item.source)) {
      counts.by_source[item.source] += 1;
    }
  }
  return counts;
}

function compareActivityItems(left, right) {
  const priority = {
    needs_attention: 0,
    blocked: 1,
    running: 2,
    waiting: 3,
    ready: 4
  };
  const stateDelta = (priority[left.state] ?? 9) - (priority[right.state] ?? 9);
  if (stateDelta !== 0) {
    return stateDelta;
  }
  return timestampNumber(right.updated_at) - timestampNumber(left.updated_at)
    || left.id.localeCompare(right.id);
}

function operatorSection(id, labelKey, purposeKey, itemCount, primaryNavigation) {
  return {
    id,
    label_key: labelKey,
    purpose_key: purposeKey,
    item_count: itemCount,
    primary_navigation: primaryNavigation,
    navigation_only: true
  };
}

function activityStatusLabel(state) {
  return {
    waiting: 'Waiting',
    running: 'In progress',
    needs_attention: 'Needs attention',
    ready: 'Ready',
    blocked: 'Blocked'
  }[state] ?? 'Needs attention';
}

function safeActivityIdentifier(value, index) {
  const text = String(value ?? '').trim();
  if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/u.test(text)) {
    return text;
  }
  return `item-${index + 1}`;
}

function safeTimestamp(value) {
  if (!value || !Number.isFinite(Date.parse(value))) {
    return null;
  }
  return new Date(value).toISOString();
}

function timestampNumber(value) {
  return value ? Date.parse(value) || 0 : 0;
}

function arrayOf(value) {
  return Array.isArray(value) ? value : [];
}

async function runPlaywrightTestReadModel(artifactRoot, context) {
  const summary = await buildPlaywrightTestRegressionSummary(context.cwd ?? process.cwd(), { 'artifact-root': artifactRoot }, context);
  return {
    status: 'ok',
    data: { playwright_test: summary },
    warnings: summary.warnings ?? [],
    errors: [],
    artifacts: []
  };
}

async function readOwnerReview(options, context) {
  if (!options['evidence-set'] && !options.input) {
    return {
      status: 'ok',
      data: {
        owner_review: {
          status: 'disabled',
          status_label: 'No owner review evidence set supplied.',
          overview: {
            owner_review_can_proceed: false,
            primary_next_action: 'Run an owner review evidence-pack projection when owner-review evidence is available.'
          },
          matrix: null,
          blockers: { groups: [] },
          top_owner_actions: []
        },
        boundary: controlCenterBoundary()
      },
      warnings: [],
      errors: [],
      artifacts: []
    };
  }
  const result = await safeRead('owner_review', () => runAgenticHumanReviewDogfoodEvidencePackReviewPack(options, context));
  return result;
}

async function safeRead(name, reader) {
  try {
    const result = await reader();
    return {
      name,
      status: result.status ?? 'ok',
      data: result.data ?? {},
      warnings: result.warnings ?? [],
      errors: result.errors ?? [],
      artifacts: result.artifacts ?? []
    };
  } catch (error) {
    return {
      name,
      status: 'error',
      data: {},
      warnings: [],
      errors: [{
        code: 'CONTROL_CENTER_SOURCE_READ_FAILED',
        message: 'A control-center read model source failed.',
        details: {
          source: name,
          reason: error?.message ?? String(error)
        }
      }],
      artifacts: []
    };
  }
}

function summarizeVisualReview(source) {
  const dashboard = source.data?.visual_review_dashboard ?? {};
  const summary = dashboard.summary ?? {};
  const results = Array.isArray(dashboard.results) ? dashboard.results.slice(0, DEFAULT_RESULT_LIMIT).map((result) => ({
    id: result.id ?? null,
    status: result.status ?? null,
    finding_count: numberOrZero(result.advisory?.finding_count),
    owner_decision_requests: numberOrZero(result.advisory?.owner_decision_requests),
    summary: result.advisory?.summary ?? '',
    gate_effect: result.advisory?.gate_effect ?? 'none'
  })) : [];
  return {
    status: dashboard.status ?? (source.status === 'error' ? 'error' : 'empty'),
    status_label: visualStatusLabel(dashboard.status),
    summary: {
      set_count: numberOrZero(summary.set_count),
      preparation_count: numberOrZero(summary.preparation_count),
      execution_count: numberOrZero(summary.execution_count),
      result_count: numberOrZero(summary.result_count),
      advisory_findings: numberOrZero(summary.advisory_findings),
      owner_decision_requests: numberOrZero(summary.owner_decision_requests)
    },
    latest: {
      result_status: dashboard.latest?.result_status ?? null,
      result_path: dashboard.latest?.result_path ?? null,
      preparation_path: dashboard.latest?.preparation_path ?? null,
      execution_path: dashboard.latest?.execution_path ?? null
    },
    findings: {
      advisory_findings: numberOrZero(summary.advisory_findings),
      owner_decision_requests: numberOrZero(summary.owner_decision_requests),
      top_results: results
    },
    owner_decision_requests: numberOrZero(summary.owner_decision_requests),
    results,
    handoff: dashboard.control_center_handoff ?? {},
    boundary: dashboard.boundary ?? controlCenterBoundary()
  };
}

function summarizeOwnerReview(source) {
  const reviewPack = source.data?.agentic_human_review_dogfood_review_pack
    ?? source.data?.owner_review
    ?? {};
  const overview = reviewPack.overview ?? {};
  return {
    status: reviewPack.status ?? (source.status === 'error' ? 'error' : 'disabled'),
    status_label: reviewPack.status_label ?? ownerReviewStatusLabel(reviewPack.status),
    can_owner_review_proceed: overview.owner_review_can_proceed === true,
    overview: {
      primary_next_action: overview.primary_next_action ?? null,
      result_count: numberOrZero(overview.result_count),
      blocked_group_count: numberOrZero(overview.blocked_group_count),
      warning_count: numberOrZero(overview.warning_count),
      advisory_only: overview.advisory_only !== false,
      gate_effect: overview.gate_effect ?? 'none'
    },
    matrix: reviewPack.matrix ?? null,
    blockers: reviewPack.blockers ?? { groups: [] },
    top_owner_actions: Array.isArray(reviewPack.top_owner_actions)
      ? reviewPack.top_owner_actions.slice(0, 3)
      : [],
    trust_safety: reviewPack.trust_safety ?? trustSafetySummary(),
    boundary: reviewPack.boundary ?? controlCenterBoundary()
  };
}

function summarizeResourceStatus(source) {
  const status = source.data?.resource_status ?? {};
  return {
    status: status.status ?? (source.status === 'error' ? 'error' : 'unknown'),
    recommended_action: status.recommended_action ?? null,
    recommendations: Array.isArray(status.recommendations) ? status.recommendations.slice(0, 3) : [],
    cache_policy: status.cache_policy ?? {},
    boundary: status.boundary ?? null
  };
}

function summarizeLanguage(source) {
  const settings = source.data?.language_settings ?? {};
  return {
    ui_locale: settings.dashboard_ui?.locale ?? null,
    intl_locale: settings.dashboard_ui?.intl_locale ?? null,
    text_direction: settings.dashboard_ui?.text_direction ?? 'ltr',
    settings_path: settings.settings_path ?? null,
    storage_status: settings.storage?.status ?? null,
    artifact_output_language: settings.artifact_output?.language ?? null,
    artifact_output_language_mode: settings.artifact_output?.language_mode ?? null,
    translation_execution_enabled: settings.artifact_output?.translation_execution_enabled === true,
    diagnostics: Array.isArray(settings.diagnostics) ? settings.diagnostics : [],
    boundary: settings.boundary ?? null
  };
}

function summarizeDisplayLanguage(language, actionCapabilities) {
  const display = actionCapabilities.display_language;
  return {
    status: language.ui_locale ? 'configured' : 'defaults',
    current_locale: language.ui_locale ?? 'en',
    intl_locale: language.intl_locale ?? 'en-US',
    text_direction: language.text_direction ?? 'ltr',
    settings_path: language.settings_path ?? display.settings_path,
    storage_status: language.storage_status ?? 'defaults',
    supported_locales: display.supported_locales,
    supported_locale_codes: display.supported_locale_codes,
    write_endpoint: display.endpoint,
    write_confirm: display.confirm,
    translation_execution_enabled: false,
    artifact_output_language_changed_by_display_locale: false,
    diagnostics: language.diagnostics,
    boundary: controlCenterBoundary()
  };
}

function summarizePlaywrightTest(source, actionCapabilities) {
  const summary = source.data?.playwright_test ?? {};
  const actions = actionCapabilities.playwright_test;
  return {
    status: summary.status ?? (source.status === 'error' ? 'error' : 'empty'),
    status_label: summary.status_label ?? 'No Playwright Test result imported.',
    selected_mode: summary.selected_mode ?? 'disabled',
    supported_modes: summary.supported_modes ?? ['disabled', 'import_only', 'local_run', 'external_ci'],
    labels: summary.labels ?? {},
    mode_matrix: summary.mode_matrix ?? {},
    last_result: summary.last_result ?? null,
    review_projection: summary.review_projection ?? null,
    next_action: summary.next_action ?? 'Choose how Control Center should use Playwright Test evidence.',
    endpoints: {
      mode: actions.mode.endpoint,
      import_result: actions.import_result.endpoint,
      external_ci_fetch: actions.external_ci_fetch.endpoint,
      external_ci_suggest_settings: actions.external_ci_suggest_settings.endpoint,
      external_ci_approve_settings: actions.external_ci_approve_settings.endpoint,
      external_ci_fetch_approved: actions.external_ci_fetch_approved.endpoint
    },
    confirmations: {
      mode: actions.mode.confirm,
      import_result: actions.import_result.confirm,
      external_ci_fetch: actions.external_ci_fetch.confirm,
      external_ci_suggest_settings: actions.external_ci_suggest_settings.confirm,
      external_ci_approve_settings: actions.external_ci_approve_settings.confirm,
      external_ci_fetch_approved: actions.external_ci_fetch_approved.confirm
    },
    external_ci: summary.external_ci ?? {
      token_storage: 'env_or_gh_auth_only',
      approved_fetch: { configured: false, status: 'not_configured' }
    },
    local_run: {
      available_in_cli: true,
      exposed_in_control_center: false,
      explicit_execute_required: true
    },
    dashboard_refresh_side_effects: summary.dashboard_refresh_side_effects ?? {
      browser_launched: false,
      process_spawned: false,
      network_used: false,
      gh_used: false,
      heavy_artifact_scan_performed: false
    },
    boundary: summary.boundary ?? controlCenterBoundary()
  };
}

function summarizePlaywrightTestSettings(playwrightTest, actionCapabilities) {
  return {
    status: playwrightTest.selected_mode ? 'configured' : 'defaults',
    selected_mode: playwrightTest.selected_mode ?? 'disabled',
    supported_modes: playwrightTest.supported_modes,
    labels: playwrightTest.labels,
    write_endpoint: actionCapabilities.playwright_test.mode.endpoint,
    write_confirm: actionCapabilities.playwright_test.mode.confirm,
    external_ci: playwrightTest.external_ci,
    setting_write_does_not_execute: true,
    browser_launched_by_settings: false,
    ci_contacted_by_settings: false,
    boundary: controlCenterBoundary()
  };
}

function summarizeSourceIntake(actionCapabilities) {
  const intake = actionCapabilities.source_intake;
  return {
    status: 'available',
    status_label: 'Ready to create a local proposal',
    endpoint: intake.endpoint,
    confirm: intake.confirm,
    supported_efforts: intake.supported_efforts,
    supported_source_types: intake.supported_source_types,
    required_fields: ['source_text_file', 'source_type', 'review_brief', 'review_effort', 'local_write_confirmed'],
    optional_fields: ['content_evidence_file', 'review_index_file', 'target_audience', 'expected_impression'],
    next_safe_action: 'Choose a workspace source text file and create a proposal before planning or running review.',
    safety: {
      local_artifact_write: true,
      provider_execution: false,
      shell_execution: false,
      mcp_execution: false,
      external_transfer: false,
      raw_source_text_persisted: false
    },
    boundary: controlCenterBoundary()
  };
}

function summarizeArtifactRoot(source) {
  const status = source.data?.artifact_root_status ?? {};
  return {
    mode: status.mode ?? null,
    effective_write_root: status.current_behavior?.effective_write_root ?? DEFAULT_ARTIFACT_ROOT,
    legacy_compatibility_required: status.policy?.legacy_compatibility_required ?? true,
    migration_execution_enabled: status.policy?.migration_execution_enabled === true,
    boundary: status.boundary ?? null
  };
}

function summarizeMcpCapabilities() {
  const built = buildMcpCapabilityReport({ profile: 'safe', scope: 'profiles' });
  if (!built.ok) {
    return {
      status: 'error',
      default_profile: null,
      safe_profile_tool_count: 0,
      execution_tools_exposed: false,
      warning: built.message
    };
  }
  const safeProfile = built.report.profiles.find((profile) => profile.name === 'safe');
  return {
    status: 'ready',
    default_profile: built.report.default_profile,
    safe_profile_tool_count: Array.isArray(safeProfile?.tools) ? safeProfile.tools.length : 0,
    execution_tools_exposed: false,
    http_profile: 'safe',
    boundary: built.report.boundaries
  };
}

function overallStatus({ visual, ownerReview, errors }) {
  if (errors.length > 0) {
    return 'error';
  }
  if (ownerReview.status === 'blocked' || ownerReview.status === 'incomplete') {
    return 'blocked';
  }
  if (ownerReview.status === 'needs_attention' || visual.status === 'owner_review_recommended') {
    return 'needs_attention';
  }
  if (ownerReview.status === 'ready_for_owner_review' || visual.status === 'ready' || visual.status === 'prepared') {
    return 'ready';
  }
  return 'empty';
}

function buildNextActions({ status, visual, ownerReview, resources }) {
  const actions = [];
  if (ownerReview.top_owner_actions.length > 0) {
    actions.push(...ownerReview.top_owner_actions.map((item) => item.action ?? item.message ?? String(item)));
  }
  if (ownerReview.overview.primary_next_action) {
    actions.push(ownerReview.overview.primary_next_action);
  }
  if (visual.handoff?.next_safe_action) {
    actions.push(visual.handoff.next_safe_action);
  }
  const resourceAction = resources.data?.resource_status?.recommended_action;
  if (resourceAction && !['proceed', 'proceed_with_normal_local_review'].includes(resourceAction)) {
    actions.push(resourceAction);
  }
  if (actions.length === 0) {
    actions.push(fallbackAction(status));
  }
  return [...new Set(actions)].slice(0, 3);
}

function sourceStatuses(sources) {
  return Object.entries(sources).map(([name, source]) => ({
    source: name,
    status: source.status,
    warning_count: source.warnings.length,
    error_count: source.errors.length
  }));
}

function collectMessages(sources, field) {
  return Object.values(sources).flatMap((source) => (source[field] ?? []).map((item) => ({
    ...item,
    source: source.name
  })));
}

function trustSafetySummary() {
  return {
    read_only: true,
    local_only: true,
    external_evidence_transfer: false,
    automatic_upload: false,
    provider_execution_performed: false,
    artifact_write_performed: false,
    browser_launched: false,
    mcp_execution_exposed: false,
    release_gate_mutated: false,
    advisory_only: true,
    gate_effect: 'none'
  };
}

function statusLabel(status) {
  return {
    ready: 'Ready for review',
    needs_attention: 'Needs attention',
    blocked: 'Blocked',
    empty: 'No local review evidence yet',
    error: 'Read model error'
  }[status] ?? 'Unknown';
}

function visualStatusLabel(status) {
  return {
    empty: 'No visual review results yet',
    prepared: 'Visual review prepared',
    ready: 'Visual review ready',
    owner_review_recommended: 'Owner review recommended',
    error: 'Visual review read error'
  }[status] ?? 'No visual review results yet';
}

function ownerReviewStatusLabel(status) {
  return {
    ready_for_owner_review: 'Owner review can proceed',
    needs_attention: 'Owner review needs attention',
    blocked: 'Owner review blocked',
    incomplete: 'Owner review incomplete',
    disabled: 'No owner review evidence set supplied',
    error: 'Owner review read error'
  }[status] ?? 'No owner review evidence set supplied';
}

function fallbackAction(status) {
  if (status === 'empty') {
    return 'Create or inspect local review evidence, then refresh this read-only status.';
  }
  if (status === 'blocked') {
    return 'Resolve the top blocker before treating the review as ready.';
  }
  if (status === 'needs_attention') {
    return 'Review the highlighted findings and owner decision requests.';
  }
  if (status === 'error') {
    return 'Open the advanced source status and fix the failed local read.';
  }
  return 'Review the available local evidence before acting on advisory findings.';
}

function materializeNow(now) {
  const value = typeof now === 'function' ? now() : now;
  if (value instanceof Date) {
    return value;
  }
  if (value) {
    return new Date(value);
  }
  return new Date();
}

function numberOrZero(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}
