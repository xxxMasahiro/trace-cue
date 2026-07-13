import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildControlCenterReadModel,
  controlCenterBoundary,
  executeCli,
  getSchema,
  runControlCenterStatus,
  startControlCenterServer
} from '../src/api.js';
import {
  buildControlCenterActivity,
  buildControlCenterOperatorFlow
} from '../src/control-center-read-model.js';
import { parseCliArgs } from '../src/parser.js';
import { buildControlCenterViewModel } from '../control-center/src/controlCenterViewModel.js';
import { createTranslator } from '../control-center/src/i18n.js';
import { getNextReviewMethod, reviewMethodCopy } from '../control-center/src/reviewMethods.js';
import { parseControlCenterRoute } from '../control-center/src/useControlCenterRoute.js';

const fixedNow = '2026-06-17T00:00:00.000Z';

test('control-center UI keeps effort ids internal and routes only to approved views', () => {
  const { t } = createTranslator('ja');
  assert.equal(reviewMethodCopy(t, 'standard').title, '大切な改善点を知りたい');
  assert.equal(reviewMethodCopy(t, 'deep').title, '改善点を詳しく洗い出したい');
  assert.equal(reviewMethodCopy(t, 'xhigh').title, '重要な判断の前に念入りに確かめたい');
  assert.equal(getNextReviewMethod('standard').id, 'deep');
  assert.equal(getNextReviewMethod('deep').id, 'xhigh');
  assert.equal(getNextReviewMethod('xhigh'), null);
  assert.deepEqual(parseControlCenterRoute('?page=confirm&view=new'), { page: 'confirm', view: 'new', itemId: null });
  assert.deepEqual(parseControlCenterRoute('?page=unsupported&view=execute'), { page: 'confirm', view: 'list', itemId: null });

  const viewModel = buildControlCenterViewModel({
    settings: { display_language: { current_locale: 'ja' } },
    activity: {
      items: [
        { id: 'agent_execution:1', source: 'agent_execution', state: 'running', finding_count: 0, owner_decision_count: 0 },
        { id: 'visual_review:1', source: 'visual_review', state: 'ready', finding_count: 2, owner_decision_count: 1 }
      ]
    },
    review: {},
    evidence: {},
    findings: {},
    regression: {}
  });
  assert.equal(viewModel.runningItems.length, 1);
  assert.equal(viewModel.runningItems[0].title, '実行中の作業');
  assert.equal(viewModel.confirmationItems[1].reviewMethodId, null);
});

test('control-center status builds a read-only local read model', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-control-center-'));

  const parsed = parseCliArgs(['control-center', 'status', '--json']);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, 'control-center status');

  const executeOption = parseCliArgs(['control-center', 'status', '--execute', '--json']);
  assert.equal(executeOption.ok, false);
  assert.equal(executeOption.error.code, 'UNSUPPORTED_CONTROL_CENTER_OPTION');

  const result = await executeCli(['control-center', 'status', '--json'], { cwd, now: fixedNow });
  assert.equal(result.exitCode, 0);
  const body = JSON.parse(result.stdout);
  assert.equal(body.command, 'control-center status');
  assert.equal(body.data.control_center.schema_version, '0.1.0');
  assert.equal(body.data.control_center.control_center_read_model_version, '1.5.0');
  assert.equal(body.data.control_center.generated_at, fixedNow);
  assert.equal(body.data.control_center.status, 'empty');
  assert.equal(body.data.control_center.activity.status, 'empty');
  assert.equal(body.data.control_center.activity.empty, true);
  assert.equal(body.data.control_center.activity.items.length, 0);
  assert.equal(body.data.control_center.activity.counts.total, 0);
  assert.equal(body.data.control_center.activity.projection.paths_included, false);
  assert.equal(body.data.control_center.activity.projection.commands_included, false);
  assert.equal(body.data.control_center.activity.projection.raw_bodies_included, false);
  assert.equal(body.data.control_center.operator_flow.primary_destination, 'new');
  assert.equal(body.data.control_center.operator_flow.navigation_only, true);
  assert.equal(body.data.control_center.operator_flow.action_execution_exposed, false);
  assert.equal(body.data.control_center.review.visual_review.status, 'empty');
  assert.equal(body.data.control_center.source_intake.status, 'available');
  assert.equal(body.data.control_center.source_intake.supported_efforts.includes('xhigh'), true);
  assert.equal(body.data.control_center.source_intake.safety.provider_execution, false);
  assert.equal(body.data.control_center.regression.playwright_test.selected_mode, 'disabled');
  assert.equal(body.data.control_center.regression.playwright_test.review_projection, null);
  assert.equal(body.data.control_center.regression.playwright_test.local_run.exposed_in_control_center, false);
  assert.equal(body.data.control_center.regression.playwright_test.dashboard_refresh_side_effects.process_spawned, false);
  assert.equal(body.data.control_center.regression.playwright_test.dashboard_refresh_side_effects.network_used, false);
  assert.equal(body.data.control_center.settings.playwright_test.selected_mode, 'disabled');
  assert.equal(body.data.control_center.settings.display_language.supported_locales.length, 14);
  assert.equal(body.data.control_center.settings.display_language.translation_execution_enabled, false);
  assert.equal(body.data.control_center.review.trust_safety.read_only, true);
  assert.equal(body.data.control_center.boundary.read_only, true);
  assert.equal(body.data.control_center.boundary.writes_artifacts, false);
  assert.equal(body.data.control_center.boundary.provider_call_performed, false);
  assert.equal(body.data.control_center.boundary.process_spawned, false);
  assert.equal(body.data.control_center.boundary.network_used, false);
  assert.equal(body.data.control_center.boundary.gh_used, false);
  assert.equal(body.data.control_center.boundary.raw_pixels_read, false);
  assert.equal(body.data.control_center.boundary.mcp_write_execute_exposed, false);
  assert.equal(body.data.control_center.gate_effect, 'none');
  assert.equal(JSON.stringify(body.data).includes('raw provider response'), false);

  const direct = await runControlCenterStatus({}, { cwd, now: fixedNow });
  assert.equal(direct.status, 'ok');
  assert.equal(direct.data.boundary.browser_launched, false);
  assert.deepEqual(controlCenterBoundary().gate_effect, 'none');

  const model = await buildControlCenterReadModel({}, { cwd, now: fixedNow });
  assert.equal(model.setup_safety.language_settings.translation_execution_enabled, false);
  assert.equal(model.setup_safety.mcp.execution_tools_exposed, false);
  assert.equal(model.advanced.source_statuses.some((source) => source.source === 'playwrightTest'), true);
});

test('control-center activity and operator flow stay summary-only and navigation-only', () => {
  const activity = buildControlCenterActivity({
    agentRequests: {
      data: {
        agent_requests: [{
          package_id: 'request-1',
          status: 'waiting_for_agent',
          created_at: '2026-06-16T10:00:00.000Z',
          package_path: '.browser-debug/agent-packages/request-1/packet.json',
          next_step: 'run a command',
          raw_body: 'untrusted body'
        }]
      }
    },
    agentWorkflows: {
      data: {
        agent_workflows: [{
          id: 'workflow-1',
          status: 'advisory_imported',
          updated_at: '2026-06-16T11:00:00.000Z',
          advisory_findings: 2,
          owner_decision_requests: 1,
          dashboard_handoff: { report_command: 'do not expose' }
        }]
      }
    },
    agentExecutions: {
      data: {
        agent_executions: [{
          id: 'execution-1',
          status: 'running',
          evaluated_at: '2026-06-16T12:00:00.000Z',
          execution_path: '.browser-debug/agent-executions/execution-1/execution.json'
        }]
      }
    },
    visual: {
      results: [{
        id: 'visual-1',
        status: 'completed',
        finding_count: 3,
        owner_decision_requests: 0,
        summary: 'raw visual review body'
      }]
    },
    ownerReview: {
      status: 'ready_for_owner_review',
      can_owner_review_proceed: true,
      overview: { blocked_group_count: 0 },
      top_owner_actions: []
    },
    playwrightTest: {
      status: 'needs_attention',
      last_result: {
        id: 'playwright-1',
        status: 'failed',
        failed_count: 1,
        flaky_count: 0,
        imported_at: '2026-06-16T13:00:00.000Z',
        source_path: 'results/private.json'
      }
    }
  });

  assert.equal(activity.status, 'available');
  assert.equal(activity.empty, false);
  assert.equal(activity.items.length, 6);
  assert.deepEqual(activity.counts, {
    total: 6,
    discovered_total: 6,
    waiting: 1,
    running: 1,
    needs_attention: 3,
    ready: 1,
    blocked: 0,
    by_source: {
      agent_request: 1,
      agent_workflow: 1,
      agent_execution: 1,
      visual_review: 1,
      owner_review: 1,
      playwright_test: 1
    }
  });
  assert.equal(activity.items.every((item) => item.can_execute === false && item.gate_effect === 'none'), true);
  assert.equal(activity.items.every((item) => ['running', 'work'].includes(item.navigation.destination)), true);
  const serializedItems = JSON.stringify(activity.items);
  assert.equal(serializedItems.includes('.browser-debug'), false);
  assert.equal(serializedItems.includes('do not expose'), false);
  assert.equal(serializedItems.includes('untrusted body'), false);
  assert.equal(serializedItems.includes('results/private.json'), false);
  assert.equal(serializedItems.includes('report_command'), false);
  assert.equal(serializedItems.includes('raw_body'), false);

  const operatorFlow = buildControlCenterOperatorFlow(activity);
  assert.equal(operatorFlow.primary_destination, 'work');
  assert.deepEqual(operatorFlow.sections.map((section) => section.id), ['confirm', 'new', 'work', 'running', 'settings']);
  assert.equal(operatorFlow.sections.find((section) => section.id === 'running').item_count, 2);
  assert.equal(operatorFlow.navigation_only, true);
  assert.equal(operatorFlow.action_execution_exposed, false);
  assert.equal(operatorFlow.provider_execution_exposed, false);
  assert.equal(operatorFlow.browser_execution_exposed, false);
  assert.equal(operatorFlow.mcp_execution_exposed, false);
  assert.equal(operatorFlow.gate_effect, 'none');
});

test('control-center schema is exported through the local schema registry', async () => {
  const schema = getSchema('control_center_read_model');
  const publicSchema = JSON.parse(await readFile('schemas/control-center-read-model.schema.json', 'utf8'));
  assert.equal(schema.title, 'TraceCue Control Center Read Model');
  assert.equal(schema.properties.boundary.properties.read_only.const, true);
  assert.equal(schema.properties.boundary.properties.provider_call_performed.const, false);
  assert.equal(schema.required.includes('source_intake'), true);
  assert.equal(schema.required.includes('regression'), true);
  assert.equal(schema.required.includes('settings'), true);
  assert.equal(schema.required.includes('activity'), false);
  assert.equal(schema.required.includes('operator_flow'), false);
  assert.equal(typeof schema.properties.activity, 'object');
  assert.equal(typeof schema.properties.operator_flow, 'object');
  assert.deepEqual(schema.properties.activity.properties.status, publicSchema.properties.activity.properties.status);
  assert.deepEqual(schema.properties.operator_flow.properties.primary_destination, publicSchema.properties.operator_flow.properties.primary_destination);
  assert.equal(schema.properties.activity.properties.items.items.properties.can_execute.const, false);
  assert.equal(schema.properties.operator_flow.properties.navigation_only.const, true);
});

test('control-center appearance is controlled by the product design-system files', async () => {
  const designSystem = await readFile('control-center/src/designSystem.js', 'utf8');
  const styles = await readFile('control-center/src/styles.css', 'utf8');
  const tokenFile = await readFile('docs/design-system/tokens.json', 'utf8');
  const componentFile = await readFile('docs/design-system/components.json', 'utf8');
  const tokenData = JSON.parse(tokenFile);
  const componentData = JSON.parse(componentFile);

  assert.match(designSystem, /docs\/design-system\/tokens\.json/);
  assert.match(designSystem, /docs\/design-system\/components\.json/);
  for (const id of [
    'control-center-shell',
    'control-center-success-feedback',
    'source-intake-form',
    'source-validation-message',
    'source-safety-strip',
    'artifact-generation-result',
    'settings-language-form',
    'settings-persistence-status',
    'playwright-test-regression-page',
    'playwright-test-review-material',
    'playwright-test-mode-form',
    'playwright-test-ci-fetch-form',
    'playwright-test-ci-approved-settings'
  ]) {
    assert.ok(componentData.components.some((component) => component.id === id), `${id} should be present`);
  }

  for (const tokenName of Object.keys(tokenData.tokens.color)) {
    assert.match(designSystem, new RegExp(`--tc-color-${tokenName.replaceAll('_', '-')}`));
  }
  for (const tokenName of Object.keys(tokenData.tokens.font)) {
    assert.match(designSystem, new RegExp(`--tc-font-${tokenName.replaceAll('_', '-')}`));
  }
  for (const tokenName of Object.keys(tokenData.tokens.layout)) {
    assert.match(designSystem, new RegExp(`--tc-layout-${tokenName.replaceAll('_', '-')}`));
  }
  assert.match(styles, /var\(--tc-color-surface\)/);
  assert.match(styles, /var\(--tc-color-success\)/);
  assert.match(styles, /\.app-shell[\s\S]*font-family: var\(--tc-font-ui\)/);
  assert.match(styles, /\.screen\.narrow[\s\S]*var\(--tc-layout-narrow-content-width\)/);
  assert.match(styles, /\.page-header h1[\s\S]*var\(--tc-font-page-title\)/);
  assert.match(styles, /\.settings-group > h2[\s\S]*var\(--tc-font-section-title\)/);
  assert.match(styles, /\.inline-notice\.success[\s\S]*border-inline-start-width: 1px;[\s\S]*background: var\(--tc-color-success-soft\)/);
  assert.doesNotMatch(styles, /#[0-9a-fA-F]{3,8}\b/);
});

test('control-center server keeps dashboard GET-only while exposing bounded local actions', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-control-center-server-'));
  await mkdir(path.join(cwd, 'fixtures'), { recursive: true });
  await writeFile(path.join(cwd, 'fixtures', 'transcript.txt'), 'Unique source phrase for the GUI intake test.\nSecond line for chunk stats.\n', 'utf8');
  const started = await startControlCenterServer({ port: 0 }, { cwd, now: fixedNow });
  try {
    assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal(started.metadata.local_only, true);
    assert.equal(started.metadata.read_only_dashboard, true);
    assert.equal(started.metadata.dashboard_get_only, true);
    assert.equal(started.metadata.bounded_local_action_endpoints, true);
    assert.equal(started.metadata.action_api_exposed, true);
    assert.deepEqual(started.metadata.action_endpoints, [
      '/api/source-intake/proposal',
      '/api/settings/display-language',
      '/api/playwright-test/mode',
      '/api/playwright-test/import',
      '/api/playwright-test/external-ci/fetch',
      '/api/playwright-test/external-ci/suggest-settings',
      '/api/playwright-test/external-ci/approve-settings',
      '/api/playwright-test/external-ci/fetch-approved'
    ]);
    assert.deepEqual(started.metadata.source_intake_endpoints, [
      '/api/review-intake/upload',
      '/api/review-intake/complete',
      '/api/review-intake/results',
      '/api/review-intake/result'
    ]);

    const health = await fetch(new URL('/api/health', started.url));
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('cache-control'), 'no-store');
    const healthBody = await health.json();
    assert.equal(healthBody.read_only, true);
    assert.equal(healthBody.protocol_version, '1.0.0');
    assert.equal(typeof healthBody.package_version, 'string');
    assert.match(healthBody.asset_fingerprint, /^sha256:[a-f0-9]{64}$/);

    const dashboard = await fetch(new URL('/api/dashboard', started.url));
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.headers.get('cache-control'), 'no-store');
    assert.equal(dashboard.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(dashboard.headers.get('x-frame-options'), 'DENY');
    assert.match(dashboard.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    const dashboardBody = await dashboard.json();
    assert.equal(dashboardBody.command, 'control-center status');
    assert.equal(dashboardBody.data.control_center.boundary.read_only, true);
    assert.equal(dashboardBody.data.control_center.source_intake.confirm, 'create-source-intake-proposal');
    assert.equal(dashboardBody.data.control_center.settings.display_language.write_confirm, 'set-control-center-display-language');
    assert.equal(dashboardBody.data.control_center.regression.playwright_test.confirmations.import_result, 'import-playwright-test-result');
    assert.equal(dashboardBody.data.control_center.regression.playwright_test.confirmations.external_ci_fetch, 'fetch-playwright-test-ci-artifact');
    assert.equal(dashboardBody.data.control_center.regression.playwright_test.confirmations.external_ci_suggest_settings, 'suggest-playwright-test-ci-settings');
    assert.equal(dashboardBody.data.control_center.regression.playwright_test.confirmations.external_ci_approve_settings, 'approve-playwright-test-ci-settings');
    assert.equal(dashboardBody.data.control_center.regression.playwright_test.confirmations.external_ci_fetch_approved, 'fetch-approved-playwright-test-ci-artifact');
    assert.equal(typeof dashboardBody.data.control_center.action_security.token, 'string');

    const primitiveBody = await fetch(new URL('/api/settings/control-center', started.url), {
      method: 'POST',
      headers: { ...await actionHeaders(started), 'Content-Type': 'application/json' },
      body: 'null'
    });
    assert.equal(primitiveBody.status, 400);
    assert.match(await primitiveBody.text(), /CONTROL_CENTER_JSON_OBJECT_REQUIRED/);

    const missingOrigin = await fetch(new URL('/api/settings/control-center', started.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.equal(missingOrigin.status, 403);
    assert.match(await missingOrigin.text(), /CONTROL_CENTER_ORIGIN_REQUIRED/);

    const missingToken = await fetch(new URL('/api/settings/control-center', started.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: started.url.slice(0, -1) },
      body: '{}'
    });
    assert.equal(missingToken.status, 403);
    assert.match(await missingToken.text(), /CONTROL_CENTER_ACTION_TOKEN_REJECTED/);

    const staleToken = await fetch(new URL('/api/settings/control-center', started.url), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: started.url.slice(0, -1),
        'X-Trace-Cue-Action-Token': 'stale-action-token'
      },
      body: '{}'
    });
    assert.equal(staleToken.status, 403);

    const post = await fetch(new URL('/api/dashboard', started.url), {
      method: 'POST',
      headers: await actionHeaders(started)
    });
    assert.equal(post.status, 405);

    const combinedSettings = await postJson(started, '/api/settings/control-center', {
      locale: 'ja',
      playwright_mode: 'import_only',
      default_viewport: 'mobile',
      ai_suggestions_enabled: false,
      confirm: 'save-control-center-settings'
    });
    assert.equal(combinedSettings.statusCode, 200);
    const combinedSettingsBody = JSON.parse(combinedSettings.body);
    assert.equal(combinedSettingsBody.command, 'control-center settings save');
    assert.equal(combinedSettingsBody.data.control_center_settings.boundary.atomic_settings_write, true);
    const persistedCombinedSettings = JSON.parse(await readFile(path.join(cwd, 'ops', 'DASHBOARD_SETTINGS.local.json'), 'utf8'));
    assert.equal(persistedCombinedSettings.ui_locale, 'ja');
    assert.equal(persistedCombinedSettings.playwright_test.mode, 'import_only');
    assert.equal(persistedCombinedSettings.profiles.control_center.default_viewport, 'mobile');

    const settings = await postJson(started, '/api/settings/display-language', {
      locale: 'ja',
      confirm: 'set-control-center-display-language'
    });
    assert.equal(settings.statusCode, 200);
    const settingsBody = JSON.parse(settings.body);
    assert.equal(settingsBody.command, 'control-center settings display-language');
    assert.equal(settingsBody.data.display_language.locale, 'ja');
    assert.equal(settingsBody.data.display_language.translation_execution_enabled, false);

    const refreshed = await fetch(new URL('/api/dashboard', started.url));
    const refreshedBody = await refreshed.json();
    assert.equal(refreshedBody.data.control_center.settings.display_language.current_locale, 'ja');
    assert.equal(refreshedBody.data.control_center.settings.display_language.text_direction, 'ltr');

    const approveCiSettings = await postJson(started, '/api/playwright-test/external-ci/approve-settings', {
      repo: 'owner/repo',
      workflow_name: 'CI',
      branch: 'main',
      artifact_name: 'playwright-report',
      confirm: 'approve-playwright-test-ci-settings'
    });
    assert.equal(approveCiSettings.statusCode, 200);
    const approveCiSettingsBody = JSON.parse(approveCiSettings.body);
    assert.equal(approveCiSettingsBody.command, 'control-center playwright-test external-ci approve-settings');
    assert.equal(approveCiSettingsBody.data.playwright_test_external_ci_approved_settings.safety.setting_write_does_not_execute, true);
    const afterCiSettings = await fetch(new URL('/api/dashboard', started.url));
    const afterCiSettingsBody = await afterCiSettings.json();
    assert.equal(afterCiSettingsBody.data.control_center.settings.display_language.current_locale, 'ja');
    assert.equal(afterCiSettingsBody.data.control_center.regression.playwright_test.external_ci.approved_fetch.configured, true);
    assert.equal(afterCiSettingsBody.data.control_center.regression.playwright_test.external_ci.approved_fetch.artifact_name, 'playwright-report');
    assert.equal(afterCiSettingsBody.data.control_center.regression.playwright_test.dashboard_refresh_side_effects.gh_used, false);

    const playwrightMode = await postJson(started, '/api/playwright-test/mode', {
      mode: 'import_only',
      confirm: 'set-playwright-test-mode'
    });
    assert.equal(playwrightMode.statusCode, 200);
    const playwrightModeBody = JSON.parse(playwrightMode.body);
    assert.equal(playwrightModeBody.command, 'control-center playwright-test mode');
    assert.equal(playwrightModeBody.data.playwright_test_mode.mode, 'import_only');
    assert.equal(playwrightModeBody.data.playwright_test_mode.safety.setting_write_does_not_execute, true);

    await mkdir(path.join(cwd, 'results'), { recursive: true });
    await writeFile(path.join(cwd, 'results', 'playwright.json'), JSON.stringify({
      suites: [{
        specs: [{
          title: 'settings',
          tests: [{
            title: 'loads',
            projectName: 'chromium',
            results: [{ status: 'passed', attachments: [] }]
          }]
        }]
      }]
    }), 'utf8');
    const playwrightImport = await postJson(started, '/api/playwright-test/import', {
      input: 'results/playwright.json',
      confirm: 'import-playwright-test-result'
    });
    assert.equal(playwrightImport.statusCode, 200);
    const playwrightImportBody = JSON.parse(playwrightImport.body);
    assert.equal(playwrightImportBody.command, 'control-center playwright-test import');
    assert.equal(playwrightImportBody.data.playwright_test_import.status, 'passed');
    assert.equal(playwrightImportBody.data.playwright_test_import.boundary.raw_artifact_content_included, false);
    const afterImport = await fetch(new URL('/api/dashboard', started.url));
    const afterImportBody = await afterImport.json();
    const reviewProjection = afterImportBody.data.control_center.regression.playwright_test.review_projection;
    assert.equal(reviewProjection.kind, 'e2e_result_review_material');
    assert.equal(reviewProjection.result.status, 'passed');
    assert.equal(reviewProjection.raw_content_included, false);
    assert.equal(reviewProjection.boundary.read_only, true);
    assert.equal(afterImportBody.data.control_center.regression.playwright_test.dashboard_refresh_side_effects.network_used, false);

    const playwrightFetchMissingExecute = await postJson(started, '/api/playwright-test/external-ci/fetch', {
      repo: 'owner/repo',
      run_id: '123',
      artifact_name: 'results',
      confirm: 'fetch-playwright-test-ci-artifact'
    });
    assert.equal(playwrightFetchMissingExecute.statusCode, 400);
    assert.match(playwrightFetchMissingExecute.body, /CONTROL_CENTER_PLAYWRIGHT_TEST_EXTERNAL_CI_EXECUTE_REQUIRED/);

    const playwrightFetchApprovedMissingExecute = await postJson(started, '/api/playwright-test/external-ci/fetch-approved', {
      confirm: 'fetch-approved-playwright-test-ci-artifact'
    });
    assert.equal(playwrightFetchApprovedMissingExecute.statusCode, 400);
    assert.match(playwrightFetchApprovedMissingExecute.body, /CONTROL_CENTER_PLAYWRIGHT_TEST_EXTERNAL_CI_FETCH_APPROVED_EXECUTE_REQUIRED/);

    const unsupportedLocale = await postJson(started, '/api/settings/display-language', {
      locale: 'zz',
      confirm: 'set-control-center-display-language'
    });
    assert.equal(unsupportedLocale.statusCode, 400);
    assert.match(unsupportedLocale.body, /CONTROL_CENTER_DISPLAY_LANGUAGE_UNSUPPORTED/);

    const missingConfirm = await postJson(started, '/api/settings/display-language', {
      locale: 'en'
    });
    assert.equal(missingConfirm.statusCode, 400);
    assert.match(missingConfirm.body, /CONTROL_CENTER_DISPLAY_LANGUAGE_CONFIRM_REQUIRED/);

    const intake = await postJson(started, '/api/source-intake/proposal', {
      source_text_file: 'fixtures/transcript.txt',
      source_type: 'transcript',
      review_brief: 'Explain the transcript for a non-engineer owner review.',
      review_effort: 'xhigh',
      target_audience: 'non-engineer owner',
      expected_impression: 'clear next-step proposal',
      confirm: 'create-source-intake-proposal'
    });
    assert.equal(intake.statusCode, 200);
    const intakeBody = JSON.parse(intake.body);
    assert.equal(intakeBody.command, 'control-center source-intake proposal');
    assert.equal(intakeBody.data.source_intake.status, 'proposal_ready');
    assert.equal(intakeBody.data.source_intake.review_effort, 'xhigh');
    assert.equal(intakeBody.data.source_intake.resolved_source_type, 'transcript');
    assert.equal(intakeBody.data.source_intake.source_text.full_text_stored, false);
    assert.equal(intakeBody.data.source_intake.safety.provider_call_performed, false);
    assert.equal(intakeBody.data.source_intake.safety.shell_used, false);
    assert.equal(intakeBody.data.source_intake.safety.mcp_execution_exposed, false);
    assert.equal(intakeBody.data.source_intake.safety.external_evidence_transfer, false);
    assert.equal(intakeBody.artifacts.length, 2);
    assert.equal(intake.body.includes('Unique source phrase for the GUI intake test'), false);
    const proposalDirs = await readdir(path.join(cwd, '.browser-debug', 'agentic-human-review-proposals'));
    assert.equal(proposalDirs.length, 1);

    const intakeGet = await fetch(new URL('/api/source-intake/proposal', started.url));
    assert.equal(intakeGet.status, 405);

    const protectedHeaders = await actionHeaders(started);
    const wrongType = await httpRequest({
      hostname: '127.0.0.1',
      port: started.config.port,
      path: '/api/source-intake/proposal',
      method: 'POST',
      headers: { Host: `127.0.0.1:${started.config.port}`, 'Content-Type': 'text/plain', ...protectedHeaders }
    }, 'not-json');
    assert.equal(wrongType.statusCode, 415);

    const tooLarge = await httpRequest({
      hostname: '127.0.0.1',
      port: started.config.port,
      path: '/api/source-intake/proposal',
      method: 'POST',
      headers: { Host: `127.0.0.1:${started.config.port}`, 'Content-Type': 'application/json', ...protectedHeaders }
    }, JSON.stringify({ review_brief: 'x'.repeat(70_000) }));
    assert.equal(tooLarge.statusCode, 413);

    const invalidJson = await httpRequest({
      hostname: '127.0.0.1',
      port: started.config.port,
      path: '/api/source-intake/proposal',
      method: 'POST',
      headers: { Host: `127.0.0.1:${started.config.port}`, 'Content-Type': 'application/json', ...protectedHeaders }
    }, '{bad');
    assert.equal(invalidJson.statusCode, 400);

    const outsidePath = await postJson(started, '/api/source-intake/proposal', {
      source_text_file: '../outside.txt',
      source_type: 'transcript',
      review_brief: 'Reject traversal',
      review_effort: 'standard',
      confirm: 'create-source-intake-proposal'
    });
    assert.equal(outsidePath.statusCode, 400);
    assert.match(outsidePath.body, /CONTROL_CENTER_SOURCE_PATH_REJECTED/);

    const invalidOrigin = await fetch(new URL('/api/health', started.url), {
      headers: { Origin: 'https://example.invalid' }
    });
    assert.equal(invalidOrigin.status, 403);

    const root = await fetch(started.url);
    assert.equal(root.status, 200);
    assert.match(root.headers.get('content-type'), /text\/html/);
  } finally {
    await closeServer(started.server);
  }
});

test('control-center server completes Playwright Test external CI success paths through read-only gh', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-control-center-ci-'));
  await mkdir(path.join(cwd, '.github', 'workflows'), { recursive: true });
  await writeFile(path.join(cwd, '.github', 'workflows', 'ci.yml'), [
    'name: CI',
    'jobs:',
    '  test:',
    '    steps:',
    '      - uses: actions/upload-artifact@v4',
    '        with:',
    '          name: playwright-report'
  ].join('\n'), 'utf8');

  const ghCalls = [];
  const started = await startControlCenterServer({ port: 0 }, {
    cwd,
    now: fixedNow,
    ghRunner: async (command, args) => {
      assert.equal(command, 'gh');
      ghCalls.push(args);
      if (args[0] === 'run' && args[1] === 'list') {
        return {
          code: 0,
          signal: null,
          stdout: JSON.stringify([{
            databaseId: 222,
            headSha: 'c'.repeat(40),
            headBranch: 'main',
            event: 'push',
            status: 'completed',
            conclusion: 'success',
            workflowName: 'CI',
            updatedAt: fixedNow,
            createdAt: fixedNow
          }]),
          stderr: ''
        };
      }
      if (args[0] === 'run' && args[1] === 'download') {
        assert.equal(args[3], '--repo');
        assert.equal(args[4], 'owner/repo');
        assert.equal(args[5], '--name');
        assert.equal(args[6], 'playwright-report');
        const dir = args[args.indexOf('--dir') + 1];
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, 'results.json'), JSON.stringify({
          suites: [{
            specs: [{
              title: 'checkout',
              tests: [{
                title: 'loads',
                projectName: 'chromium',
                results: [{ status: 'passed', attachments: [] }]
              }]
            }]
          }]
        }), 'utf8');
        return { code: 0, signal: null, stdout: 'downloaded', stderr: '' };
      }
      return { code: 1, signal: null, stdout: '', stderr: 'unexpected gh command' };
    }
  });
  try {
    const suggestion = await postJson(started, '/api/playwright-test/external-ci/suggest-settings', {
      repo: 'owner/repo',
      confirm: 'suggest-playwright-test-ci-settings'
    });
    assert.equal(suggestion.statusCode, 200);
    const suggestionBody = JSON.parse(suggestion.body);
    const suggested = suggestionBody.data.playwright_test_external_ci_settings_suggestion;
    assert.equal(suggested.status, 'suggested');
    assert.equal(suggested.persisted, false);
    assert.equal(suggested.candidate.repo, 'owner/repo');
    assert.equal(suggested.candidate.workflow_name, 'CI');
    assert.equal(suggested.candidate.artifact_name, 'playwright-report');
    assert.equal(suggested.candidate.limit, 10);
    assert.equal(suggested.boundary.gh_write_used, false);

    const approveCiSettings = await postJson(started, '/api/playwright-test/external-ci/approve-settings', {
      repo: 'owner/repo',
      workflow_name: 'CI',
      branch: 'main',
      event: 'push',
      artifact_name: 'playwright-report',
      target_policy: 'latest_successful_branch_run',
      max_age_hours: 24,
      limit: 5,
      confirm: 'approve-playwright-test-ci-settings'
    });
    assert.equal(approveCiSettings.statusCode, 200);
    const approveCiSettingsBody = JSON.parse(approveCiSettings.body);
    const approved = approveCiSettingsBody.data.playwright_test_external_ci_approved_settings.approved_fetch;
    assert.equal(approved.target_policy, 'latest_successful_branch_run');
    assert.equal(approved.max_age_hours, 24);
    assert.equal(approved.limit, 5);
    assert.equal(approved.head_sha, null);
    assert.equal(approveCiSettingsBody.data.playwright_test_external_ci_approved_settings.safety.gh_used, false);

    const manualFetch = await postJson(started, '/api/playwright-test/external-ci/fetch', {
      repo: 'owner/repo',
      run_id: '222',
      artifact_name: 'playwright-report',
      execute_confirmed: true,
      confirm: 'fetch-playwright-test-ci-artifact'
    });
    assert.equal(manualFetch.statusCode, 200);
    const manualFetchBody = JSON.parse(manualFetch.body);
    assert.equal(manualFetchBody.command, 'control-center playwright-test external-ci fetch');
    assert.equal(manualFetchBody.data.playwright_test_import.status, 'passed');
    assert.equal(manualFetchBody.data.playwright_test_external_ci_fetch.boundary.gh_write_used, false);
    assert.equal(manualFetchBody.data.playwright_test_external_ci_fetch.raw_content_included, false);

    const approvedFetch = await postJson(started, '/api/playwright-test/external-ci/fetch-approved', {
      execute_confirmed: true,
      confirm: 'fetch-approved-playwright-test-ci-artifact'
    });
    assert.equal(approvedFetch.statusCode, 200);
    const approvedFetchBody = JSON.parse(approvedFetch.body);
    assert.equal(approvedFetchBody.command, 'control-center playwright-test external-ci fetch-approved');
    assert.equal(approvedFetchBody.data.playwright_test_import.status, 'passed');
    assert.equal(approvedFetchBody.data.playwright_test_import.source.approved_fetch.mode, 'approved_settings');
    assert.equal(approvedFetchBody.data.playwright_test_external_ci_fetch_approved.status, 'downloaded');
    assert.equal(approvedFetchBody.data.playwright_test_external_ci_fetch_approved.boundary.gh_write_used, false);

    const afterFetch = await fetch(new URL('/api/dashboard', started.url));
    const afterFetchBody = await afterFetch.json();
    const regression = afterFetchBody.data.control_center.regression.playwright_test;
    assert.equal(regression.review_projection.raw_content_included, false);
    assert.equal(regression.external_ci.approved_fetch.limit, 5);
    assert.equal(regression.external_ci.approved_fetch.max_age_hours, 24);
    assert.equal(regression.dashboard_refresh_side_effects.gh_used, false);
    assert.equal(regression.dashboard_refresh_side_effects.network_used, false);

    assert.equal(ghCalls.some((args) => args.includes('workflow_dispatch') || args.includes('rerun') || args.includes('cancel')), false);
    assert.equal(ghCalls.filter((args) => args[0] === 'run' && args[1] === 'download').length, 2);
  } finally {
    await closeServer(started.server);
  }
});

test('control-center server rejects non-loopback hosts before listening', async () => {
  await assert.rejects(
    startControlCenterServer({ host: '0.0.0.0', port: 0 }, { now: fixedNow }),
    /loopback host/
  );
});

test('control-center server rejects non-loopback Host headers', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-control-center-host-'));
  const started = await startControlCenterServer({ port: 0 }, { cwd, now: fixedNow });
  try {
    const response = await httpRequest({
      hostname: '127.0.0.1',
      port: started.config.port,
      path: '/api/health',
      method: 'GET',
      headers: { Host: 'example.invalid' }
    });
    assert.equal(response.statusCode, 403);
    assert.match(response.body, /Host header/);
  } finally {
    await closeServer(started.server);
  }
});

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function postJson(started, requestPath, payload) {
  return httpRequest({
    hostname: '127.0.0.1',
    port: started.config.port,
    path: requestPath,
    method: 'POST',
    headers: {
      Host: `127.0.0.1:${started.config.port}`,
      'Content-Type': 'application/json',
      ...await actionHeaders(started)
    }
  }, JSON.stringify(payload));
}

async function actionHeaders(started) {
  const response = await fetch(new URL('/api/dashboard', started.url));
  const body = await response.json();
  return {
    Origin: started.url.slice(0, -1),
    'X-Trace-Cue-Action-Token': body.data.control_center.action_security.token
  };
}

function httpRequest(options, body = '') {
  return new Promise((resolve, reject) => {
    const req = request(options, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, headers: res.headers, body });
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}
