import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_ARTIFACT_ROOT, SCHEMA_VERSION } from './constants.js';
import { createArtifactId, ensureArtifactRoot } from './artifacts.js';
import { scanArtifactTree } from './playwright-test-artifacts.js';
import { importPlaywrightTestFromDownloadedDirectory } from './playwright-test-import.js';
import {
  PLAYWRIGHT_TEST_EXTERNAL_CI_APPROVE_SETTINGS_CONFIRM,
  PLAYWRIGHT_TEST_EXTERNAL_CI_CONFIRM,
  PLAYWRIGHT_TEST_EXTERNAL_CI_FETCH_APPROVED_CONFIRM,
  PLAYWRIGHT_TEST_EXTERNAL_CI_SUGGEST_SETTINGS_CONFIRM,
  buildFreshnessSignature,
  materializeNow,
  playwrightTestBoundary,
  readPlaywrightTestSettings,
  resultError,
  validatePlaywrightTestExternalCiApprovedFetchSettings,
  writePlaywrightTestExternalCiApprovedSettings
} from './playwright-test-integration.js';
import { runGhReadOnly } from './playwright-test-runners.js';

export const PLAYWRIGHT_TEST_EXTERNAL_CI_VERSION = '1.0.0';
const GH_RUN_FIELDS = 'databaseId,headSha,headBranch,event,status,conclusion,workflowName,displayTitle,createdAt,updatedAt';
const COMMON_ARTIFACT_NAMES = Object.freeze(['playwright-report', 'test-results', 'playwright-results']);

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
  const limit = Math.max(1, Math.min(Number(options.limit) || 10, 50));
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

export async function runPlaywrightTestExternalCiApprovedSettings(options = {}, context = {}) {
  const settings = await readPlaywrightTestSettings(context.cwd ?? process.cwd());
  return {
    status: 'ok',
    data: {
      playwright_test_external_ci_approved_settings: {
        schema_version: SCHEMA_VERSION,
        integration_version: PLAYWRIGHT_TEST_EXTERNAL_CI_VERSION,
        status: settings.external_ci?.approved_fetch?.status ?? 'not_configured',
        approved_fetch: settings.external_ci?.approved_fetch ?? null,
        settings_path: settings.settings_path,
        raw_output_included: false,
        boundary: playwrightTestBoundary()
      }
    },
    warnings: [],
    errors: [],
    artifacts: []
  };
}

export async function runPlaywrightTestExternalCiSuggestSettings(options = {}, context = {}) {
  if (options.confirm !== PLAYWRIGHT_TEST_EXTERNAL_CI_SUGGEST_SETTINGS_CONFIRM) {
    return resultError('PLAYWRIGHT_TEST_EXTERNAL_CI_SUGGEST_SETTINGS_CONFIRM_REQUIRED', 'external-ci suggest-settings requires explicit confirmation.', {
      confirm: PLAYWRIGHT_TEST_EXTERNAL_CI_SUGGEST_SETTINGS_CONFIRM
    });
  }
  const cwd = context.cwd ?? process.cwd();
  const local = await discoverLocalCiMetadata(cwd);
  const repoInput = options.repo ?? local.repo;
  const repo = normalizeRepo(repoInput);
  if (!repo.ok) {
    return resultError(repo.code, repo.message, repo.details);
  }
  const limit = Math.min(Number(options.limit) || 10, 50);
  const warnings = [...local.warnings];
  let latestRun = null;
  let ghUsed = false;
  const argv = ['run', 'list', '--repo', repo.value, '--json', GH_RUN_FIELDS, '--limit', String(limit)];
  const executed = await runGhReadOnly(argv, {
    cwd,
    env: context.env,
    runner: context.ghRunner,
    timeoutMs: 60000
  });
  ghUsed = true;
  if (executed.ok && executed.result.code === 0) {
    const parsed = parseGhJsonArray(executed.result.stdout);
    if (parsed.ok) {
      latestRun = selectLatestCompletedSuccessRun(parsed.value, options);
    } else {
      warnings.push(parsed.message);
    }
  } else if (executed.ok) {
    warnings.push('gh run list did not return successful run metadata; local defaults were used.');
  } else {
    warnings.push(executed.message);
  }
  const artifactCandidates = unique([
    options.artifact_name ?? options.artifactName ?? options['artifact-name'],
    ...local.artifact_names,
    ...COMMON_ARTIFACT_NAMES
  ].filter(Boolean));
  const workflowName = stringOrNull(options.workflow_name ?? options.workflowName ?? options['workflow-name'] ?? options.workflow)
    ?? latestRun?.workflowName
    ?? local.workflow_names[0]
    ?? null;
  const branch = stringOrNull(options.branch ?? options.ref)
    ?? latestRun?.headBranch
    ?? local.default_branch
    ?? null;
  const event = stringOrNull(options.event) ?? latestRun?.event ?? null;
  const artifactName = artifactCandidates[0] ?? null;
  const candidate = {
    provider: 'github_actions',
    repo: repo.value,
    workflow_name: workflowName,
    branch,
    event,
    conclusion: 'success',
    status_filter: 'completed',
    artifact_name: artifactName,
    artifact_candidates: artifactCandidates,
    target_policy: options.head_sha || options.headSha || options['head-sha'] ? 'specific_head_sha' : branch ? 'latest_successful_branch_run' : 'latest_successful_run',
    head_sha: stringOrNull(options.head_sha ?? options.headSha ?? options['head-sha']),
    limit,
    max_age_hours: Number(options.max_age_hours ?? options.maxAgeHours ?? options['max-age-hours'] ?? 168),
    token_storage: 'env_or_gh_auth_only',
    raw_output_included: false
  };
  return {
    status: 'ok',
    data: {
      playwright_test_external_ci_settings_suggestion: {
        schema_version: SCHEMA_VERSION,
        integration_version: PLAYWRIGHT_TEST_EXTERNAL_CI_VERSION,
        status: artifactName ? 'suggested' : 'needs_artifact_name',
        candidate,
        latest_run: latestRun ? sanitizeRun(latestRun) : null,
        save_confirm: PLAYWRIGHT_TEST_EXTERNAL_CI_APPROVE_SETTINGS_CONFIRM,
        suggestion_hash: buildFreshnessSignature(candidate),
        persisted: false,
        boundary: playwrightTestBoundary({
          network_used: ghUsed,
          gh_used: ghUsed,
          process_spawned: ghUsed
        })
      }
    },
    warnings,
    errors: [],
    artifacts: []
  };
}

export async function runPlaywrightTestExternalCiApproveSettings(options = {}, context = {}) {
  return writePlaywrightTestExternalCiApprovedSettings(options, context);
}

export async function runPlaywrightTestExternalCiResolveApproved(options = {}, context = {}) {
  const cwd = context.cwd ?? process.cwd();
  const settings = await readPlaywrightTestSettings(cwd);
  const approved = settings.external_ci?.approved_fetch;
  if (!approved?.configured) {
    return resultError('PLAYWRIGHT_TEST_EXTERNAL_CI_APPROVED_SETTINGS_REQUIRED', 'No approved external CI fetch settings are configured.', {});
  }
  const validation = validatePlaywrightTestExternalCiApprovedFetchSettings({
    repo: approved.repo,
    workflow_name: approved.workflow_name,
    branch: approved.branch,
    event: approved.event,
    artifact_name: approved.artifact_name,
    target_policy: approved.target_policy,
    head_sha: approved.head_sha,
    limit: approved.limit,
    max_age_hours: approved.max_age_hours
  });
  if (!validation.ok) {
    return resultError(validation.code, validation.message, validation.details);
  }
  const normalized = validation.value;
  const argv = ['run', 'list', '--repo', normalized.repo, '--json', GH_RUN_FIELDS, '--limit', String(normalized.limit)];
  const executed = await runGhReadOnly(argv, {
    cwd,
    env: context.env,
    runner: context.ghRunner,
    timeoutMs: 60000
  });
  if (!executed.ok) {
    return resultError(executed.code, executed.message, executed.details);
  }
  if (executed.result.code !== 0) {
    return resultError('PLAYWRIGHT_TEST_EXTERNAL_CI_GH_FAILED', 'gh read-only command failed.', { exit_code: executed.result.code });
  }
  const parsed = parseGhJsonArray(executed.result.stdout);
  if (!parsed.ok) {
    return resultError(parsed.code, parsed.message, parsed.details);
  }
  const selected = selectApprovedRun(parsed.value, normalized, materializeNow(context.now));
  if (!selected.ok) {
    return resultError(selected.code, selected.message, selected.details);
  }
  const resolution = {
    schema_version: SCHEMA_VERSION,
    integration_version: PLAYWRIGHT_TEST_EXTERNAL_CI_VERSION,
    status: 'resolved',
    provider: 'github_actions',
    repo: normalized.repo,
    run_id: String(selected.run.databaseId),
    artifact_name: normalized.artifact_name,
    workflow_name: selected.run.workflowName ?? null,
    branch: selected.run.headBranch ?? null,
    event: selected.run.event ?? null,
    head_sha: selected.run.headSha ?? null,
    target_policy: normalized.target_policy,
    candidate_count: selected.candidateCount,
    selected_at: materializeNow(context.now).toISOString(),
    approved_settings_hash: approved.approval_hash ?? buildFreshnessSignature(normalized),
    resolution_hash: buildFreshnessSignature({
      repo: normalized.repo,
      run_id: String(selected.run.databaseId),
      artifact_name: normalized.artifact_name,
      approved_settings_hash: approved.approval_hash ?? null
    }),
    raw_output_included: false,
    boundary: playwrightTestBoundary({
      network_used: true,
      gh_used: true,
      process_spawned: true
    })
  };
  return {
    status: 'ok',
    data: {
      playwright_test_external_ci_resolved: resolution
    },
    warnings: [],
    errors: [],
    artifacts: []
  };
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
      approved_fetch: options.approved_fetch ?? null,
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

export async function runPlaywrightTestExternalCiFetchApproved(options = {}, context = {}) {
  if (options.confirm !== PLAYWRIGHT_TEST_EXTERNAL_CI_FETCH_APPROVED_CONFIRM) {
    return resultError('PLAYWRIGHT_TEST_EXTERNAL_CI_FETCH_APPROVED_CONFIRM_REQUIRED', 'external-ci fetch-approved requires explicit confirmation.', {
      confirm: PLAYWRIGHT_TEST_EXTERNAL_CI_FETCH_APPROVED_CONFIRM
    });
  }
  if (!options.execute) {
    return resultError('PLAYWRIGHT_TEST_EXTERNAL_CI_FETCH_APPROVED_EXECUTE_REQUIRED', 'external-ci fetch-approved requires --execute.', {});
  }
  const resolved = await runPlaywrightTestExternalCiResolveApproved(options, context);
  if (resolved.status !== 'ok') {
    return resolved;
  }
  const resolution = resolved.data.playwright_test_external_ci_resolved;
  const fetched = await runPlaywrightTestExternalCiFetch({
    repo: resolution.repo,
    'run-id': resolution.run_id,
    'artifact-name': resolution.artifact_name,
    confirm: PLAYWRIGHT_TEST_EXTERNAL_CI_CONFIRM,
    execute: true,
    'artifact-root': options['artifact-root'],
    approved_fetch: {
      mode: 'approved_settings',
      resolution_hash: resolution.resolution_hash,
      approved_settings_hash: resolution.approved_settings_hash,
      target_policy: resolution.target_policy,
      raw_output_included: false
    }
  }, context);
  if (fetched.status === 'ok') {
    fetched.data.playwright_test_external_ci_fetch_approved = {
      schema_version: SCHEMA_VERSION,
      integration_version: PLAYWRIGHT_TEST_EXTERNAL_CI_VERSION,
      status: 'downloaded',
      repo: resolution.repo,
      run_id: resolution.run_id,
      artifact_name: resolution.artifact_name,
      resolution_hash: resolution.resolution_hash,
      approved_settings_hash: resolution.approved_settings_hash,
      raw_output_included: false,
      boundary: playwrightTestBoundary({
        network_used: true,
        gh_used: true,
        process_spawned: true,
        writes_artifacts: true
      })
    };
  }
  return fetched;
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

function parseGhJsonArray(stdout) {
  try {
    const parsed = JSON.parse(String(stdout ?? ''));
    if (!Array.isArray(parsed)) {
      return { ok: false, code: 'PLAYWRIGHT_TEST_EXTERNAL_CI_JSON_INVALID', message: 'gh run output must be a JSON array.', details: {} };
    }
    return { ok: true, value: parsed };
  } catch (error) {
    return { ok: false, code: 'PLAYWRIGHT_TEST_EXTERNAL_CI_JSON_INVALID', message: 'gh run JSON output could not be parsed.', details: { reason: error.message } };
  }
}

function selectLatestCompletedSuccessRun(runs, options = {}) {
  const branch = stringOrNull(options.branch ?? options.ref);
  const workflowName = stringOrNull(options.workflow_name ?? options.workflowName ?? options['workflow-name'] ?? options.workflow);
  const event = stringOrNull(options.event);
  return sortRuns(runs.filter((run) => {
    if (String(run.status ?? '').toLowerCase() !== 'completed') {
      return false;
    }
    if (String(run.conclusion ?? '').toLowerCase() !== 'success') {
      return false;
    }
    if (branch && run.headBranch !== branch) {
      return false;
    }
    if (workflowName && run.workflowName !== workflowName) {
      return false;
    }
    if (event && run.event !== event) {
      return false;
    }
    return /^\d+$/.test(String(run.databaseId ?? ''));
  }))[0] ?? null;
}

function selectApprovedRun(runs, approved, now) {
  const matches = runs.filter((run) => approvedRunMatches(run, approved, now));
  const sorted = sortRuns(matches);
  const run = sorted[0];
  if (!run) {
    return {
      ok: false,
      code: 'PLAYWRIGHT_TEST_EXTERNAL_CI_APPROVED_RUN_NOT_FOUND',
      message: 'No completed successful GitHub Actions run matched the approved external CI settings.',
      details: {
        repo: approved.repo,
        workflow_name: approved.workflow_name ?? null,
        branch: approved.branch ?? null,
        event: approved.event ?? null,
        target_policy: approved.target_policy,
        candidate_count: runs.length
      }
    };
  }
  return { ok: true, run, candidateCount: sorted.length };
}

function approvedRunMatches(run, approved, now) {
  if (!/^\d+$/.test(String(run.databaseId ?? ''))) {
    return false;
  }
  if (String(run.status ?? '').toLowerCase() !== approved.status_filter) {
    return false;
  }
  if (String(run.conclusion ?? '').toLowerCase() !== approved.conclusion) {
    return false;
  }
  if (approved.workflow_name && run.workflowName !== approved.workflow_name) {
    return false;
  }
  if (approved.branch && run.headBranch !== approved.branch) {
    return false;
  }
  if (approved.event && run.event !== approved.event) {
    return false;
  }
  if (approved.head_sha && String(run.headSha ?? '').toLowerCase() !== approved.head_sha) {
    return false;
  }
  const timestamp = Date.parse(run.updatedAt ?? run.createdAt ?? '');
  if (!Number.isFinite(timestamp)) {
    return false;
  }
  const ageHours = (now.getTime() - timestamp) / (60 * 60 * 1000);
  return ageHours >= 0 && ageHours <= approved.max_age_hours;
}

function sortRuns(runs) {
  return [...runs].sort((a, b) => {
    const bTime = Date.parse(b.updatedAt ?? b.createdAt ?? '') || 0;
    const aTime = Date.parse(a.updatedAt ?? a.createdAt ?? '') || 0;
    if (bTime !== aTime) {
      return bTime - aTime;
    }
    return Number(b.databaseId ?? 0) - Number(a.databaseId ?? 0);
  });
}

function sanitizeRun(run = {}) {
  return {
    run_id: /^\d+$/.test(String(run.databaseId ?? '')) ? String(run.databaseId) : null,
    workflow_name: stringOrNull(run.workflowName),
    branch: stringOrNull(run.headBranch),
    event: stringOrNull(run.event),
    status: stringOrNull(run.status),
    conclusion: stringOrNull(run.conclusion),
    head_sha: stringOrNull(run.headSha),
    updated_at: stringOrNull(run.updatedAt),
    raw_output_included: false
  };
}

async function discoverLocalCiMetadata(cwd) {
  const repo = await inferGitHubRepo(cwd);
  const workflows = await readWorkflowHints(cwd);
  return {
    repo: repo.value,
    default_branch: repo.defaultBranch,
    workflow_names: workflows.workflowNames,
    artifact_names: workflows.artifactNames,
    warnings: [...repo.warnings, ...workflows.warnings]
  };
}

async function inferGitHubRepo(cwd) {
  const warnings = [];
  try {
    const config = await readFile(path.join(cwd, '.git', 'config'), 'utf8');
    const match = config.match(/url\s*=\s*(?:git@github\.com:|https:\/\/github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\.git)?/i);
    if (match) {
      const repo = match[1].replace(/\.git$/i, '');
      return { value: repo, defaultBranch: null, warnings };
    }
  } catch {
    warnings.push('Local git remote metadata was not available.');
  }
  return { value: null, defaultBranch: null, warnings };
}

async function readWorkflowHints(cwd) {
  const workflowDir = path.join(cwd, '.github', 'workflows');
  const workflowNames = [];
  const artifactNames = [];
  const warnings = [];
  let entries = [];
  try {
    entries = await readdir(workflowDir, { withFileTypes: true });
  } catch {
    return { workflowNames, artifactNames, warnings };
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) {
      continue;
    }
    try {
      const text = await readFile(path.join(workflowDir, entry.name), 'utf8');
      const workflowName = text.match(/^name:\s*["']?([^"'\n#]+)["']?\s*$/m)?.[1]?.trim();
      if (workflowName) {
        workflowNames.push(workflowName);
      }
      for (const match of text.matchAll(/uses:\s*actions\/upload-artifact@[\s\S]{0,500}?name:\s*["']?([^"'\n#]+)["']?/gi)) {
        artifactNames.push(match[1].trim());
      }
    } catch (error) {
      warnings.push(`Workflow hint read failed for ${entry.name}: ${error.message}`);
    }
  }
  return { workflowNames: unique(workflowNames), artifactNames: unique(artifactNames), warnings };
}

function stringOrNull(value) {
  const text = String(value ?? '').trim();
  return text ? text : null;
}

function unique(values) {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}
