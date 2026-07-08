import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_ARTIFACT_ROOT, SCHEMA_VERSION } from './constants.js';
import { createArtifactId, ensureArtifactRoot } from './artifacts.js';
import { scanArtifactTree } from './playwright-test-artifacts.js';
import { importPlaywrightTestFromDownloadedDirectory } from './playwright-test-import.js';
import { PLAYWRIGHT_TEST_EXTERNAL_CI_CONFIRM, materializeNow, playwrightTestBoundary, resultError } from './playwright-test-integration.js';
import { runGhReadOnly } from './playwright-test-runners.js';

export const PLAYWRIGHT_TEST_EXTERNAL_CI_VERSION = '1.0.0';
const GH_RUN_FIELDS = 'databaseId,headSha,headBranch,event,status,conclusion,workflowName,displayTitle,createdAt,updatedAt';

export async function runPlaywrightTestExternalCiReadiness(options = {}, context = {}) {
  const repo = normalizeRepo(options.repo);
  if (!repo.ok) {
    return resultError(repo.code, repo.message, repo.details);
  }
  return {
    status: 'ok',
    data: {
      playwright_test_external_ci_readiness: {
        schema_version: SCHEMA_VERSION,
        integration_version: PLAYWRIGHT_TEST_EXTERNAL_CI_VERSION,
        status: 'ready_to_query',
        provider: 'github_actions',
        repo: repo.value,
        allowed_commands: [
          'gh run list',
          'gh run view',
          'gh run download'
        ],
        denied_operations: [
          'workflow_dispatch',
          'rerun',
          'cancel',
          'pr_comment',
          'status_write'
        ],
        token_policy: {
          token_values_recorded: false,
          token_storage: 'gh_auth_or_env_only'
        },
        boundary: playwrightTestBoundary({
          network_used: false,
          gh_used: false
        })
      }
    },
    warnings: [],
    errors: [],
    artifacts: []
  };
}

export async function runPlaywrightTestExternalCiList(options = {}, context = {}) {
  const repo = normalizeRepo(options.repo);
  if (!repo.ok) {
    return resultError(repo.code, repo.message, repo.details);
  }
  const limit = Math.min(Number(options.limit) || 10, 50);
  const argv = ['run', 'list', '--repo', repo.value, '--json', GH_RUN_FIELDS, '--limit', String(limit)];
  const executed = await runGhReadOnly(argv, {
    cwd: context.cwd,
    env: context.env,
    runner: context.ghRunner,
    timeoutMs: 60000
  });
  if (!executed.ok) {
    return resultError(executed.code, executed.message, executed.details);
  }
  return externalCiCommandResult('list', repo.value, argv, executed.result);
}

export async function runPlaywrightTestExternalCiView(options = {}, context = {}) {
  const repo = normalizeRepo(options.repo);
  if (!repo.ok) {
    return resultError(repo.code, repo.message, repo.details);
  }
  const runId = normalizeRunId(options['run-id']);
  if (!runId.ok) {
    return resultError(runId.code, runId.message, runId.details);
  }
  const argv = ['run', 'view', runId.value, '--repo', repo.value, '--json', GH_RUN_FIELDS];
  const executed = await runGhReadOnly(argv, {
    cwd: context.cwd,
    env: context.env,
    runner: context.ghRunner,
    timeoutMs: 60000
  });
  if (!executed.ok) {
    return resultError(executed.code, executed.message, executed.details);
  }
  return externalCiCommandResult('view', repo.value, argv, executed.result);
}

export async function runPlaywrightTestExternalCiFetch(options = {}, context = {}) {
  if (options.confirm !== PLAYWRIGHT_TEST_EXTERNAL_CI_CONFIRM) {
    return resultError('PLAYWRIGHT_TEST_EXTERNAL_CI_CONFIRM_REQUIRED', 'playwright-test external-ci fetch requires explicit confirmation.', {
      confirm: PLAYWRIGHT_TEST_EXTERNAL_CI_CONFIRM
    });
  }
  if (!options.execute) {
    return resultError('PLAYWRIGHT_TEST_EXTERNAL_CI_EXECUTE_REQUIRED', 'playwright-test external-ci fetch requires --execute.', {});
  }
  const repo = normalizeRepo(options.repo);
  if (!repo.ok) {
    return resultError(repo.code, repo.message, repo.details);
  }
  const runId = normalizeRunId(options['run-id']);
  if (!runId.ok) {
    return resultError(runId.code, runId.message, runId.details);
  }
  const artifactName = normalizeArtifactName(options['artifact-name'] ?? options.name);
  if (!artifactName.ok) {
    return resultError(artifactName.code, artifactName.message, artifactName.details);
  }
  const cwd = context.cwd ?? process.cwd();
  const artifactRootInput = options['artifact-root'] ?? DEFAULT_ARTIFACT_ROOT;
  const root = await ensureArtifactRoot(cwd, artifactRootInput);
  const id = createArtifactId(materializeNow(context.now), 'playwright-test-ci');
  const dest = path.join(root, 'playwright-test-ci', id);
  await mkdir(dest, { recursive: true });
  const argv = ['run', 'download', runId.value, '--repo', repo.value, '--name', artifactName.value, '--dir', dest];
  const executed = await runGhReadOnly(argv, {
    cwd,
    env: context.env,
    runner: context.ghRunner,
    timeoutMs: 120000
  });
  if (!executed.ok) {
    return resultError(executed.code, executed.message, executed.details);
  }
  const scan = await scanArtifactTree(dest);
  if (!scan.ok) {
    return resultError('PLAYWRIGHT_TEST_EXTERNAL_CI_ARTIFACT_REJECTED', 'Downloaded CI artifact failed safety checks.', scan.summary);
  }
  const imported = await importPlaywrightTestFromDownloadedDirectory({
    cwd,
    directory: dest,
    artifactRootInput,
    now: context.now,
    source: {
      kind: 'external_ci',
      provider: 'github_actions',
      repo: repo.value,
      run_id: runId.value,
      artifact_name: artifactName.value,
      gh_command: 'gh run download',
      raw_content_included: false
    }
  });
  if (imported.status === 'ok') {
    imported.data.playwright_test_external_ci_fetch = {
      schema_version: SCHEMA_VERSION,
      integration_version: PLAYWRIGHT_TEST_EXTERNAL_CI_VERSION,
      status: 'downloaded',
      repo: repo.value,
      run_id: runId.value,
      artifact_name: artifactName.value,
      downloaded_file_count: scan.summary.file_count,
      downloaded_total_bytes: scan.summary.total_bytes,
      raw_content_included: false,
      boundary: playwrightTestBoundary({
        network_used: true,
        gh_used: true,
        writes_artifacts: true
      })
    };
  }
  return imported;
}

function externalCiCommandResult(kind, repo, argv, result) {
  return {
    status: result.code === 0 ? 'ok' : 'error',
    data: {
      playwright_test_external_ci: {
        schema_version: SCHEMA_VERSION,
        integration_version: PLAYWRIGHT_TEST_EXTERNAL_CI_VERSION,
        kind,
        repo,
        argv_shape: argv.map((value, index) => index <= 2 ? value : value.startsWith('--') ? value : '<value>'),
        exit_code: result.code,
        stdout_excerpt: result.stdout ? '[redacted-json-output]' : '',
        stderr_excerpt: result.stderr ? '[redacted-stderr]' : '',
        raw_output_included: false,
        boundary: playwrightTestBoundary({
          network_used: true,
          gh_used: true,
          process_spawned: true
        })
      }
    },
    warnings: [],
    errors: result.code === 0 ? [] : [{
      code: 'PLAYWRIGHT_TEST_EXTERNAL_CI_GH_FAILED',
      message: 'gh read-only command failed.',
      details: { exit_code: result.code }
    }],
    artifacts: []
  };
}

function normalizeRepo(value) {
  const repo = String(value ?? '').trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    return { ok: false, code: 'PLAYWRIGHT_TEST_EXTERNAL_CI_REPO_INVALID', message: 'external-ci requires --repo owner/repo.', details: {} };
  }
  return { ok: true, value: repo };
}

function normalizeRunId(value) {
  const runId = String(value ?? '').trim();
  if (!/^\d+$/.test(runId)) {
    return { ok: false, code: 'PLAYWRIGHT_TEST_EXTERNAL_CI_RUN_ID_INVALID', message: 'external-ci requires a numeric --run-id.', details: {} };
  }
  return { ok: true, value: runId };
}

function normalizeArtifactName(value) {
  const name = String(value ?? '').trim();
  if (!/^[A-Za-z0-9_. -]{1,120}$/.test(name)) {
    return { ok: false, code: 'PLAYWRIGHT_TEST_EXTERNAL_CI_ARTIFACT_NAME_INVALID', message: 'external-ci requires an exact artifact name.', details: {} };
  }
  return { ok: true, value: name };
}
