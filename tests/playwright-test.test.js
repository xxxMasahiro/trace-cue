import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  PLAYWRIGHT_TEST_EXTERNAL_CI_CONFIRM,
  PLAYWRIGHT_TEST_IMPORT_CONFIRM,
  PLAYWRIGHT_TEST_MODE_CONFIRM,
  executeCli,
  runPlaywrightTestExternalCiFetch,
  runPlaywrightTestExternalCiList,
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

  const settings = JSON.parse(await readFile(path.join(cwd, 'ops', 'DASHBOARD_SETTINGS.json'), 'utf8'));
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
