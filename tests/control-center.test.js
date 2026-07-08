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
import { parseCliArgs } from '../src/parser.js';

const fixedNow = '2026-06-17T00:00:00.000Z';

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
  assert.equal(body.data.control_center.control_center_read_model_version, '1.2.0');
  assert.equal(body.data.control_center.generated_at, fixedNow);
  assert.equal(body.data.control_center.status, 'empty');
  assert.equal(body.data.control_center.review.visual_review.status, 'empty');
  assert.equal(body.data.control_center.source_intake.status, 'available');
  assert.equal(body.data.control_center.source_intake.supported_efforts.includes('xhigh'), true);
  assert.equal(body.data.control_center.source_intake.safety.provider_execution, false);
  assert.equal(body.data.control_center.regression.playwright_test.selected_mode, 'disabled');
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

test('control-center schema is exported through the local schema registry', () => {
  const schema = getSchema('control_center_read_model');
  assert.equal(schema.title, 'TraceCue Control Center Read Model');
  assert.equal(schema.properties.boundary.properties.read_only.const, true);
  assert.equal(schema.properties.boundary.properties.provider_call_performed.const, false);
  assert.equal(schema.required.includes('source_intake'), true);
  assert.equal(schema.required.includes('regression'), true);
  assert.equal(schema.required.includes('settings'), true);
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
    'source-intake-form',
    'source-validation-message',
    'source-safety-strip',
    'artifact-generation-result',
    'settings-language-form',
    'settings-persistence-status',
    'playwright-test-regression-page',
    'playwright-test-mode-form',
    'playwright-test-ci-fetch-form'
  ]) {
    assert.ok(componentData.components.some((component) => component.id === id), `${id} should be present`);
  }

  for (const tokenName of Object.keys(tokenData.tokens.color)) {
    assert.match(designSystem, new RegExp(`--tc-color-${tokenName}`));
  }
  assert.match(designSystem, /--tc-font-ui/);
  assert.match(designSystem, /--tc-font-mono/);
  assert.match(styles, /var\(--tc-color-surface\)/);
  assert.match(styles, /var\(--tc-color-success\)/);
  assert.match(styles, /\.app-shell[\s\S]*font-family: var\(--tc-font-ui\)/);
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
      '/api/playwright-test/external-ci/fetch'
    ]);

    const health = await fetch(new URL('/api/health', started.url));
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('cache-control'), 'no-store');
    const healthBody = await health.json();
    assert.equal(healthBody.read_only, true);

    const dashboard = await fetch(new URL('/api/dashboard', started.url));
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.headers.get('cache-control'), 'no-store');
    const dashboardBody = await dashboard.json();
    assert.equal(dashboardBody.command, 'control-center status');
    assert.equal(dashboardBody.data.control_center.boundary.read_only, true);
    assert.equal(dashboardBody.data.control_center.source_intake.confirm, 'create-source-intake-proposal');
    assert.equal(dashboardBody.data.control_center.settings.display_language.write_confirm, 'set-control-center-display-language');
    assert.equal(dashboardBody.data.control_center.regression.playwright_test.confirmations.import_result, 'import-playwright-test-result');
    assert.equal(dashboardBody.data.control_center.regression.playwright_test.confirmations.external_ci_fetch, 'fetch-playwright-test-ci-artifact');

    const post = await fetch(new URL('/api/dashboard', started.url), { method: 'POST' });
    assert.equal(post.status, 405);

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

    const playwrightFetchMissingExecute = await postJson(started, '/api/playwright-test/external-ci/fetch', {
      repo: 'owner/repo',
      run_id: '123',
      artifact_name: 'results',
      confirm: 'fetch-playwright-test-ci-artifact'
    });
    assert.equal(playwrightFetchMissingExecute.statusCode, 400);
    assert.match(playwrightFetchMissingExecute.body, /CONTROL_CENTER_PLAYWRIGHT_TEST_EXTERNAL_CI_EXECUTE_REQUIRED/);

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

    const wrongType = await httpRequest({
      hostname: '127.0.0.1',
      port: started.config.port,
      path: '/api/source-intake/proposal',
      method: 'POST',
      headers: { Host: `127.0.0.1:${started.config.port}`, 'Content-Type': 'text/plain' }
    }, 'not-json');
    assert.equal(wrongType.statusCode, 415);

    const tooLarge = await httpRequest({
      hostname: '127.0.0.1',
      port: started.config.port,
      path: '/api/source-intake/proposal',
      method: 'POST',
      headers: { Host: `127.0.0.1:${started.config.port}`, 'Content-Type': 'application/json' }
    }, JSON.stringify({ review_brief: 'x'.repeat(70_000) }));
    assert.equal(tooLarge.statusCode, 413);

    const invalidJson = await httpRequest({
      hostname: '127.0.0.1',
      port: started.config.port,
      path: '/api/source-intake/proposal',
      method: 'POST',
      headers: { Host: `127.0.0.1:${started.config.port}`, 'Content-Type': 'application/json' }
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
    assert.equal(root.status, 503);
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

function postJson(started, requestPath, payload) {
  return httpRequest({
    hostname: '127.0.0.1',
    port: started.config.port,
    path: requestPath,
    method: 'POST',
    headers: {
      Host: `127.0.0.1:${started.config.port}`,
      'Content-Type': 'application/json'
    }
  }, JSON.stringify(payload));
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
