import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  PLAYWRIGHT_TEST_EXTERNAL_CI_APPROVE_SETTINGS_CONFIRM,
  PLAYWRIGHT_TEST_EXTERNAL_CI_CONFIRM,
  PLAYWRIGHT_TEST_EXTERNAL_CI_FETCH_APPROVED_CONFIRM,
  PLAYWRIGHT_TEST_EXTERNAL_CI_SUGGEST_SETTINGS_CONFIRM,
  PLAYWRIGHT_TEST_IMPORT_CONFIRM,
  PLAYWRIGHT_TEST_MODE_CONFIRM,
  DASHBOARD_USER_SETTINGS_PATH,
  executeCli,
  readEffectiveDashboardSettings,
  runPlaywrightTestExternalCiFetchApproved,
  runPlaywrightTestExternalCiFetch,
  runPlaywrightTestExternalCiList,
  runPlaywrightTestExternalCiResolveApproved,
  runPlaywrightTestExternalCiSuggestSettings,
  validateGhReadOnlyArgv
} from '../src/api.js';
import { parseCliArgs } from '../src/parser.js';

const fixedNow = '2026-06-18T00:00:00.000Z';

test('playwright-test mode and status are advisory and side-effect-light', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-playwright-mode-'));

  const parsed = parseCliArgs(['playwright-test', 'mode', '--mode', 'import_only', '--confirm', PLAYWRIGHT_TEST_MODE_CONFIRM, '--json']);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, 'playwright-test mode');

  const executeMode = parseCliArgs(['playwright-test', 'mode', '--mode', 'import_only', '--confirm', PLAYWRIGHT_TEST_MODE_CONFIRM, '--execute', '--json']);
  assert.equal(executeMode.ok, false);
  assert.equal(executeMode.error.code, 'CONFLICTING_OPTIONS');

  const saved = await executeCli(['playwright-test', 'mode', '--mode', 'external_ci', '--confirm', PLAYWRIGHT_TEST_MODE_CONFIRM, '--json'], { cwd, now: fixedNow });
  assert.equal(saved.exitCode, 0);
  const savedBody = JSON.parse(saved.stdout);
  assert.equal(savedBody.data.playwright_test_mode.mode, 'external_ci');
  assert.equal(savedBody.data.playwright_test_mode.safety.setting_write_does_not_execute, true);
  assert.equal(savedBody.data.playwright_test_mode.boundary.browser_launched, false);
  assert.equal(savedBody.data.playwright_test_mode.boundary.network_used, false);
  assert.equal(savedBody.data.playwright_test_mode.boundary.gh_used, false);

  const settings = JSON.parse(await readFile(path.join(cwd, DASHBOARD_USER_SETTINGS_PATH), 'utf8'));
  assert.equal(settings.playwright_test.mode, 'external_ci');
  assert.equal(settings.playwright_test.external_ci.token_storage, 'env_or_gh_auth_only');

  const status = await executeCli(['playwright-test', 'status', '--json'], { cwd, now: fixedNow });
  assert.equal(status.exitCode, 0);
  const statusBody = JSON.parse(status.stdout);
  assert.equal(statusBody.data.playwright_test.selected_mode, 'external_ci');
  assert.equal(statusBody.data.playwright_test.dashboard_refresh_side_effects.browser_launched, false);
  assert.equal(statusBody.data.playwright_test.dashboard_refresh_side_effects.process_spawned, false);
  assert.equal(statusBody.data.playwright_test.dashboard_refresh_side_effects.network_used, false);
  assert.equal(statusBody.data.playwright_test.dashboard_refresh_side_effects.gh_used, false);
});

test('playwright-test import normalizes JSON results without raw content', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-playwright-import-'));
  await mkdir(path.join(cwd, 'results'), { recursive: true });
  const secretText = `Bearer ${'a'.repeat(20)}`;
  await writeFile(path.join(cwd, 'results', 'playwright.json'), JSON.stringify({
    stats: { startTime: '2026-06-18T00:00:00.000Z' },
    suites: [{
      title: 'root',
      specs: [{
        title: 'checkout flow',
        tests: [{
          title: 'shows confirmation',
          projectName: 'chromium',
          results: [{
            status: 'failed',
            error: { message: `unexpected text ${secretText}` },
            attachments: [{ name: 'screenshot', path: 'hidden.png' }]
          }]
        }]
      }]
    }]
  }), 'utf8');

  const result = await executeCli([
    'playwright-test',
    'import',
    '--input',
    'results/playwright.json',
    '--confirm',
    PLAYWRIGHT_TEST_IMPORT_CONFIRM,
    '--json'
  ], { cwd, now: fixedNow });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.includes(secretText), false);
  const body = JSON.parse(result.stdout);
  const imported = body.data.playwright_test_import;
  assert.equal(imported.status, 'failed');
  assert.equal(imported.summary.total_count, 1);
  assert.equal(imported.summary.failed_count, 1);
  assert.equal(imported.summary.attachment_count, 1);
  assert.equal(imported.summary.top_failures[0].error_excerpt.includes('[REDACTED]'), true);
  assert.equal(imported.source.kind, 'local_import');
  assert.equal(imported.boundary.raw_artifact_content_included, false);
  assert.equal(imported.boundary.existing_review_mutated, false);
  assert.equal(body.artifacts.some((artifact) => artifact.type === 'playwright_test_result'), true);

  const status = await executeCli(['playwright-test', 'status', '--json'], { cwd, now: fixedNow });
  const statusBody = JSON.parse(status.stdout);
  assert.equal(statusBody.data.playwright_test.status, 'failed');
  assert.equal(statusBody.data.playwright_test.last_result.failed_count, 1);
});

test('playwright-test review-material projects normalized results only', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-playwright-review-material-'));
  await mkdir(path.join(cwd, 'results'), { recursive: true });
  await writeFile(path.join(cwd, 'results', 'baseline.json'), JSON.stringify({
    stats: { startTime: '2026-06-17T00:00:00.000Z' },
    suites: [{
      specs: [{
        title: 'checkout flow',
        tests: [{
          title: 'shows confirmation',
          projectName: 'chromium',
          results: [{ status: 'passed', attachments: [] }]
        }]
      }]
    }]
  }), 'utf8');
  await writeFile(path.join(cwd, 'results', 'current.json'), JSON.stringify({
    stats: { startTime: '2026-06-18T00:00:00.000Z' },
    suites: [{
      specs: [{
        title: 'checkout flow',
        tests: [{
          title: 'shows confirmation',
          projectName: 'chromium',
          results: [{
            status: 'failed',
            error: { message: `unexpected text Bearer ${'b'.repeat(20)}` },
            attachments: [{ name: 'screenshot', path: 'hidden.png' }]
          }]
        }]
      }]
    }]
  }), 'utf8');

  const baselineImport = await executeCli([
    'playwright-test',
    'import',
    '--input',
    'results/baseline.json',
    '--confirm',
    PLAYWRIGHT_TEST_IMPORT_CONFIRM,
    '--json'
  ], { cwd, now: '2026-06-17T00:00:00.000Z' });
  const currentImport = await executeCli([
    'playwright-test',
    'import',
    '--input',
    'results/current.json',
    '--confirm',
    PLAYWRIGHT_TEST_IMPORT_CONFIRM,
    '--json'
  ], { cwd, now: fixedNow });
  const baselineId = JSON.parse(baselineImport.stdout).data.playwright_test_import.id;
  const currentId = JSON.parse(currentImport.stdout).data.playwright_test_import.id;

  const parsed = parseCliArgs(['playwright-test', 'review-material', '--result', currentId, '--baseline', baselineId, '--json']);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, 'playwright-test review-material');

  const executeRejected = parseCliArgs(['playwright-test', 'review-material', '--result', currentId, '--execute', '--json']);
  assert.equal(executeRejected.ok, false);
  assert.equal(executeRejected.error.code, 'CONFLICTING_OPTIONS');

  const providerRejected = parseCliArgs(['playwright-test', 'review-material', '--result', currentId, '--provider', 'openai', '--json']);
  assert.equal(providerRejected.ok, false);
  assert.equal(providerRejected.error.code, 'UNSUPPORTED_PLAYWRIGHT_TEST_REVIEW_MATERIAL_OPTION');

  const materialResult = await executeCli([
    'playwright-test',
    'review-material',
    '--result',
    currentId,
    '--baseline',
    baselineId,
    '--json'
  ], { cwd, now: fixedNow });
  assert.equal(materialResult.exitCode, 0);
  assert.equal(materialResult.stdout.includes('Bearer'), false);
  const material = JSON.parse(materialResult.stdout).data.e2e_result_review_material;
  assert.equal(material.kind, 'e2e_result_review_material');
  assert.equal(material.result.status, 'failed');
  assert.equal(material.result.failed_count, 1);
  assert.equal(material.comparison.status, 'comparable');
  assert.equal(material.comparison.direction, 'regressed');
  assert.equal(material.review_cards.some((card) => card.type === 'failed_scenario'), true);
  assert.equal(material.review_input_by_effort.xhigh.provider_call_performed, false);
  assert.equal(material.review_input_by_effort.xhigh.prompt_context.includes('Review stance'), true);
  assert.equal(material.boundary.read_only, true);
  assert.equal(material.boundary.writes_artifacts, false);
  assert.equal(material.boundary.network_used, false);
  assert.equal(material.boundary.gh_used, false);
  assert.equal(material.raw_content_included, false);

  const rawArtifactRejected = await executeCli([
    'playwright-test',
    'review-material',
    '--result',
    'results/current.json',
    '--json'
  ], { cwd, now: fixedNow });
  assert.notEqual(rawArtifactRejected.exitCode, 0);
  const rawBody = JSON.parse(rawArtifactRejected.stdout);
  assert.equal(rawBody.errors[0].code, 'PLAYWRIGHT_TEST_RESULT_KIND_INVALID');
});

test('playwright-test review-material explains missing HTML-only evidence', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-playwright-review-material-html-'));
  await mkdir(path.join(cwd, 'reports'), { recursive: true });
  await writeFile(path.join(cwd, 'reports', 'index.html'), '<html><body>Playwright report</body></html>', 'utf8');
  const imported = await executeCli([
    'playwright-test',
    'import',
    '--input',
    'reports/index.html',
    '--confirm',
    PLAYWRIGHT_TEST_IMPORT_CONFIRM,
    '--json'
  ], { cwd, now: fixedNow });
  assert.equal(imported.exitCode, 0);
  const resultId = JSON.parse(imported.stdout).data.playwright_test_import.id;
  const materialResult = await executeCli([
    'playwright-test',
    'review-material',
    '--result',
    resultId,
    '--json'
  ], { cwd, now: fixedNow });
  assert.equal(materialResult.exitCode, 0);
  const material = JSON.parse(materialResult.stdout).data.e2e_result_review_material;
  assert.equal(material.result.evidence_missing, true);
  assert.equal(material.evidence_quality.status, 'missing');
  assert.equal(material.boundary.raw_artifact_content_included, false);
});

test('playwright-test local run requires execute and fixed plan hash', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-playwright-local-'));
  await mkdir(path.join(cwd, 'node_modules', 'playwright'), { recursive: true });
  await writeFile(path.join(cwd, 'node_modules', 'playwright', 'cli.js'), 'console.log("fake");\n', 'utf8');

  const planResult = await executeCli(['playwright-test', 'local', 'plan', '--json'], { cwd, now: fixedNow });
  assert.equal(planResult.exitCode, 0);
  const planFile = path.join(cwd, 'plan.json');
  await writeFile(planFile, planResult.stdout, 'utf8');
  const planBody = JSON.parse(planResult.stdout);
  const hash = planBody.data.playwright_test_local_plan.plan_hash;
  assert.equal(planBody.data.playwright_test_local_plan.execute_required, true);
  assert.equal(planBody.data.playwright_test_local_plan.runner.command, 'node');

  const noExecute = parseCliArgs(['playwright-test', 'local', 'run', '--plan', 'plan.json', '--plan-hash', hash, '--json']);
  assert.equal(noExecute.ok, false);
  assert.equal(noExecute.error.code, 'MISSING_REQUIRED_OPTION');

  const runResult = await executeCli([
    'playwright-test',
    'local',
    'run',
    '--plan',
    'plan.json',
    '--plan-hash',
    hash,
    '--execute',
    '--json'
  ], {
    cwd,
    now: fixedNow,
    playwrightTestCommandRunner: async (command, args, options) => {
      assert.equal(command, process.execPath);
      assert.match(args[0], /node_modules\/playwright\/cli\.js$/);
      assert.equal(args[1], 'test');
      assert.equal(options.cwd, cwd);
      return { code: 0, signal: null, stdout: 'ok', stderr: '' };
    }
  });
  assert.equal(runResult.exitCode, 0);
  const runBody = JSON.parse(runResult.stdout);
  assert.equal(runBody.data.playwright_test_local_run.status, 'passed');
  assert.equal(runBody.data.playwright_test_local_run.boundary.process_spawned, true);
  assert.equal(runBody.data.playwright_test_local_run.boundary.raw_stdout_stored, false);
});

test('playwright-test external CI allows only read-only gh run shapes', async () => {
  assert.equal(validateGhReadOnlyArgv(['run', 'list', '--repo', 'owner/repo', '--json', 'databaseId']).ok, true);
  assert.equal(validateGhReadOnlyArgv(['run', 'view', '123', '--repo', 'owner/repo', '--json', 'databaseId']).ok, true);
  assert.equal(validateGhReadOnlyArgv(['run', 'download', '123', '--repo', 'owner/repo', '--name', 'results', '--dir', 'out']).ok, true);
  assert.equal(validateGhReadOnlyArgv(['workflow', 'run', 'ci.yml']).ok, false);
  assert.equal(validateGhReadOnlyArgv(['run', 'rerun', '123']).ok, false);
  assert.equal(validateGhReadOnlyArgv(['run', 'list', '--repo', 'owner/repo', '--jq', '.']).ok, false);

  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-playwright-ci-list-'));
  const list = await runPlaywrightTestExternalCiList({ repo: 'owner/repo', limit: 2 }, {
    cwd,
    now: fixedNow,
    ghRunner: async (command, args, options) => {
      assert.equal(command, 'gh');
      assert.deepEqual(args, ['run', 'list', '--repo', 'owner/repo', '--json', 'databaseId,headSha,headBranch,event,status,conclusion,workflowName,displayTitle,createdAt,updatedAt', '--limit', '2']);
      assert.equal(options.env.GH_PROMPT_DISABLED, '1');
      return { code: 0, signal: null, stdout: '[{"databaseId":123}]', stderr: '' };
    }
  });
  assert.equal(list.status, 'ok');
  assert.equal(list.data.playwright_test_external_ci.raw_output_included, false);
  assert.equal(list.data.playwright_test_external_ci.boundary.gh_write_used, false);
});

test('playwright-test external CI fetch downloads then imports a bounded artifact', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-playwright-ci-fetch-'));

  const missingExecute = await runPlaywrightTestExternalCiFetch({
    repo: 'owner/repo',
    'run-id': '123',
    'artifact-name': 'results',
    confirm: PLAYWRIGHT_TEST_EXTERNAL_CI_CONFIRM
  }, { cwd, now: fixedNow });
  assert.equal(missingExecute.status, 'error');
  assert.equal(missingExecute.errors[0].code, 'PLAYWRIGHT_TEST_EXTERNAL_CI_EXECUTE_REQUIRED');

  const fetched = await runPlaywrightTestExternalCiFetch({
    repo: 'owner/repo',
    'run-id': '123',
    'artifact-name': 'results',
    confirm: PLAYWRIGHT_TEST_EXTERNAL_CI_CONFIRM,
    execute: true
  }, {
    cwd,
    now: fixedNow,
    ghRunner: async (command, args) => {
      assert.equal(command, 'gh');
      assert.equal(args[0], 'run');
      assert.equal(args[1], 'download');
      const dir = args[args.indexOf('--dir') + 1];
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'results.json'), JSON.stringify({
        suites: [{
          specs: [{
            title: 'home',
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
  });

  assert.equal(fetched.status, 'ok');
  assert.equal(fetched.data.playwright_test_import.status, 'passed');
  assert.equal(fetched.data.playwright_test_import.source.kind, 'external_ci');
  assert.equal(fetched.data.playwright_test_import.source.repo, 'owner/repo');
  assert.equal(fetched.data.playwright_test_external_ci_fetch.status, 'downloaded');
  assert.equal(fetched.data.playwright_test_external_ci_fetch.boundary.gh_write_used, false);
  assert.equal(fetched.data.playwright_test_external_ci_fetch.raw_content_included, false);
});

test('playwright-test external CI approved settings resolve latest successful run without changing exact fetch', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-playwright-ci-approved-'));
  await mkdir(path.join(cwd, 'ops'), { recursive: true });
  await writeFile(path.join(cwd, 'ops', 'DASHBOARD_SETTINGS.json'), JSON.stringify({
    schema_version: '1.0.0',
    kind: 'dashboard-settings',
    ui_locale: 'ja',
    playwright_test: {
      mode: 'external_ci'
    }
  }, null, 2), 'utf8');

  const approve = await executeCli([
    'playwright-test',
    'external-ci',
    'approve-settings',
    '--repo',
    'owner/repo',
    '--workflow-name',
    'CI',
    '--branch',
    'main',
    '--artifact-name',
    'playwright-report',
    '--confirm',
    PLAYWRIGHT_TEST_EXTERNAL_CI_APPROVE_SETTINGS_CONFIRM,
    '--json'
  ], { cwd, now: fixedNow });
  assert.equal(approve.exitCode, 0);
  const localSettings = JSON.parse(await readFile(path.join(cwd, DASHBOARD_USER_SETTINGS_PATH), 'utf8'));
  const settings = await readEffectiveDashboardSettings(cwd);
  assert.equal(settings.ui_locale, 'ja');
  assert.equal(localSettings.playwright_test.external_ci.approved_fetch.repo, 'owner/repo');
  assert.equal(localSettings.playwright_test.external_ci.approved_fetch.artifact_name, 'playwright-report');
  assert.equal(localSettings.playwright_test.external_ci.approved_fetch.token_storage, 'env_or_gh_auth_only');

  const parsedResolve = parseCliArgs(['playwright-test', 'external-ci', 'resolve-approved', '--json']);
  assert.equal(parsedResolve.ok, true);
  assert.equal(parsedResolve.command, 'playwright-test external-ci resolve-approved');

  const resolved = await runPlaywrightTestExternalCiResolveApproved({}, {
    cwd,
    now: fixedNow,
    ghRunner: async (command, args) => {
      assert.equal(command, 'gh');
      assert.deepEqual(args, ['run', 'list', '--repo', 'owner/repo', '--json', 'databaseId,headSha,headBranch,event,status,conclusion,workflowName,displayTitle,createdAt,updatedAt', '--limit', '20']);
      return {
        code: 0,
        signal: null,
        stdout: JSON.stringify([
          {
            databaseId: 100,
            headSha: 'a'.repeat(40),
            headBranch: 'main',
            event: 'push',
            status: 'completed',
            conclusion: 'success',
            workflowName: 'CI',
            updatedAt: '2026-06-17T00:00:00.000Z',
            createdAt: '2026-06-17T00:00:00.000Z'
          },
          {
            databaseId: 101,
            headSha: 'b'.repeat(40),
            headBranch: 'main',
            event: 'push',
            status: 'completed',
            conclusion: 'success',
            workflowName: 'CI',
            updatedAt: '2026-06-18T00:00:00.000Z',
            createdAt: '2026-06-18T00:00:00.000Z'
          }
        ]),
        stderr: ''
      };
    }
  });
  assert.equal(resolved.status, 'ok');
  assert.equal(resolved.data.playwright_test_external_ci_resolved.run_id, '101');
  assert.equal(resolved.data.playwright_test_external_ci_resolved.artifact_name, 'playwright-report');
  assert.equal(resolved.data.playwright_test_external_ci_resolved.raw_output_included, false);

  const noExecute = parseCliArgs(['playwright-test', 'external-ci', 'fetch-approved', '--confirm', PLAYWRIGHT_TEST_EXTERNAL_CI_FETCH_APPROVED_CONFIRM, '--json']);
  assert.equal(noExecute.ok, false);
  assert.equal(noExecute.error.code, 'MISSING_REQUIRED_OPTION');
});

test('playwright-test external CI suggest-settings proposes non-persisted approved settings from local and gh metadata', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-playwright-ci-suggest-'));
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

  const parsed = parseCliArgs(['playwright-test', 'external-ci', 'suggest-settings', '--repo', 'owner/repo', '--confirm', PLAYWRIGHT_TEST_EXTERNAL_CI_SUGGEST_SETTINGS_CONFIRM, '--json']);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, 'playwright-test external-ci suggest-settings');

  const suggestion = await runPlaywrightTestExternalCiSuggestSettings({
    repo: 'owner/repo',
    confirm: PLAYWRIGHT_TEST_EXTERNAL_CI_SUGGEST_SETTINGS_CONFIRM
  }, {
    cwd,
    now: fixedNow,
    ghRunner: async (command, args) => {
      assert.equal(command, 'gh');
      assert.deepEqual(args, ['run', 'list', '--repo', 'owner/repo', '--json', 'databaseId,headSha,headBranch,event,status,conclusion,workflowName,displayTitle,createdAt,updatedAt', '--limit', '10']);
      return {
        code: 0,
        signal: null,
        stdout: JSON.stringify([{
          databaseId: 432,
          headSha: 'e'.repeat(40),
          headBranch: 'main',
          event: 'push',
          status: 'completed',
          conclusion: 'success',
          workflowName: 'CI',
          updatedAt: '2026-06-18T00:00:00.000Z',
          createdAt: '2026-06-18T00:00:00.000Z'
        }]),
        stderr: ''
      };
    }
  });
  assert.equal(suggestion.status, 'ok');
  const data = suggestion.data.playwright_test_external_ci_settings_suggestion;
  assert.equal(data.status, 'suggested');
  assert.equal(data.persisted, false);
  assert.equal(data.candidate.repo, 'owner/repo');
  assert.equal(data.candidate.workflow_name, 'CI');
  assert.equal(data.candidate.branch, 'main');
  assert.equal(data.candidate.artifact_name, 'playwright-report');
  assert.equal(data.latest_run.run_id, '432');
  assert.equal(data.latest_run.raw_output_included, false);
  assert.equal(data.boundary.gh_write_used, false);
});

test('playwright-test external CI fetch-approved delegates to exact download and fails closed on ambiguous artifacts', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-playwright-ci-fetch-approved-'));
  await executeCli([
    'playwright-test',
    'external-ci',
    'approve-settings',
    '--repo',
    'owner/repo',
    '--workflow-name',
    'CI',
    '--branch',
    'main',
    '--artifact-name',
    'playwright-report',
    '--confirm',
    PLAYWRIGHT_TEST_EXTERNAL_CI_APPROVE_SETTINGS_CONFIRM,
    '--json'
  ], { cwd, now: fixedNow });

  let call = 0;
  const fetched = await runPlaywrightTestExternalCiFetchApproved({
    confirm: PLAYWRIGHT_TEST_EXTERNAL_CI_FETCH_APPROVED_CONFIRM,
    execute: true
  }, {
    cwd,
    now: fixedNow,
    ghRunner: async (command, args) => {
      call += 1;
      assert.equal(command, 'gh');
      if (call === 1) {
        assert.equal(args[1], 'list');
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
            updatedAt: '2026-06-18T00:00:00.000Z',
            createdAt: '2026-06-18T00:00:00.000Z'
          }]),
          stderr: ''
        };
      }
      assert.deepEqual(args.slice(0, 7), ['run', 'download', '222', '--repo', 'owner/repo', '--name', 'playwright-report']);
      const dir = args[args.indexOf('--dir') + 1];
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'results.json'), JSON.stringify({
        suites: [{
          specs: [{
            title: 'home',
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
  });
  assert.equal(fetched.status, 'ok');
  assert.equal(fetched.data.playwright_test_external_ci_fetch_approved.status, 'downloaded');
  assert.equal(fetched.data.playwright_test_import.source.approved_fetch.mode, 'approved_settings');
  assert.equal(call, 2);

  let ambiguousCall = 0;
  const ambiguous = await runPlaywrightTestExternalCiFetchApproved({
    confirm: PLAYWRIGHT_TEST_EXTERNAL_CI_FETCH_APPROVED_CONFIRM,
    execute: true
  }, {
    cwd,
    now: fixedNow,
    ghRunner: async (command, args) => {
      ambiguousCall += 1;
      if (ambiguousCall === 1) {
        return {
          code: 0,
          signal: null,
          stdout: JSON.stringify([{
            databaseId: 333,
            headSha: 'd'.repeat(40),
            headBranch: 'main',
            event: 'push',
            status: 'completed',
            conclusion: 'success',
            workflowName: 'CI',
            updatedAt: '2026-06-18T00:00:00.000Z',
            createdAt: '2026-06-18T00:00:00.000Z'
          }]),
          stderr: ''
        };
      }
      const dir = args[args.indexOf('--dir') + 1];
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'one.json'), '{}', 'utf8');
      await writeFile(path.join(dir, 'two.json'), '{}', 'utf8');
      return { code: 0, signal: null, stdout: 'downloaded', stderr: '' };
    }
  });
  assert.equal(ambiguous.status, 'error');
  assert.equal(ambiguous.errors[0].code, 'PLAYWRIGHT_TEST_EXTERNAL_CI_ARTIFACT_AMBIGUOUS');
});

test('playwright-test external CI approved settings reject credential fields', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-playwright-ci-secret-'));
  const result = await executeCli([
    'playwright-test',
    'external-ci',
    'approve-settings',
    '--repo',
    'owner/repo',
    '--artifact-name',
    'playwright-report',
    '--token-env',
    'GH_TOKEN',
    '--confirm',
    PLAYWRIGHT_TEST_EXTERNAL_CI_APPROVE_SETTINGS_CONFIRM,
    '--json'
  ], { cwd, now: fixedNow });
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /PLAYWRIGHT_TEST_EXTERNAL_CI_SETTINGS_SECRET_REJECTED/);
});
