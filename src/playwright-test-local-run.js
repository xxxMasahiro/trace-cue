import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { DEFAULT_ARTIFACT_ROOT, SCHEMA_VERSION } from './constants.js';
import {
  createPlaywrightTestResultId,
  buildFreshnessSignature,
  materializeNow,
  playwrightTestBoundary,
  resultError,
  writePlaywrightTestResultArtifacts
} from './playwright-test-integration.js';
import { normalizeWorkspacePath, readBoundedTextFile, redactText, resolveWorkspaceRegularFile } from './playwright-test-artifacts.js';
import { runCommand } from './playwright-test-runners.js';

export const PLAYWRIGHT_TEST_LOCAL_RUN_VERSION = '1.0.0';

export async function runPlaywrightTestLocalPlan(options = {}, context = {}) {
  const cwd = context.cwd ?? process.cwd();
  const config = options.config ? await resolveWorkspaceRegularFile(cwd, options.config) : { ok: true, relative_path: null };
  if (!config.ok) {
    return resultError(config.code, config.message, config.details);
  }
  const targetCwd = validateWorkspaceDir(cwd, options.cwd ?? '.');
  if (!targetCwd.ok) {
    return resultError(targetCwd.code, targetCwd.message, targetCwd.details);
  }
  const now = materializeNow(context.now);
  const plan = {
    schema_version: SCHEMA_VERSION,
    integration_version: PLAYWRIGHT_TEST_LOCAL_RUN_VERSION,
    kind: 'playwright_test_local_run_plan',
    status: 'planned',
    created_at: now.toISOString(),
    runner: {
      command: 'node',
      argv: buildPlaywrightArgv(options, config.relative_path),
      shell: false,
      stdin: false
    },
    cwd: targetCwd.relative_path,
    timeout_ms: positiveInteger(options.timeout, 120000),
    artifact_root: options['artifact-root'] ?? DEFAULT_ARTIFACT_ROOT,
    execute_required: true,
    boundary: playwrightTestBoundary({
      process_spawned: false,
      browser_launched: false,
      writes_artifacts: false
    })
  };
  const hash = planHash(plan);
  plan.plan_hash = hash;
  return {
    status: 'ok',
    data: {
      playwright_test_local_plan: plan,
      boundary: plan.boundary
    },
    warnings: [],
    errors: [],
    artifacts: []
  };
}

export async function runPlaywrightTestLocalRun(options = {}, context = {}) {
  if (!options.execute) {
    return resultError('PLAYWRIGHT_TEST_LOCAL_RUN_EXECUTE_REQUIRED', 'playwright-test local run requires --execute.', {});
  }
  const cwd = context.cwd ?? process.cwd();
  const planRead = await readBoundedTextFile(cwd, options.plan);
  if (!planRead.ok) {
    return resultError(planRead.code, planRead.message, planRead.details);
  }
  let plan;
  try {
    plan = JSON.parse(planRead.text).data?.playwright_test_local_plan ?? JSON.parse(planRead.text).playwright_test_local_plan ?? JSON.parse(planRead.text);
  } catch (error) {
    return resultError('PLAYWRIGHT_TEST_LOCAL_PLAN_INVALID', 'Playwright Test local run plan could not be parsed.', { reason: error.message });
  }
  const expectedHash = options['plan-hash'];
  if (!expectedHash || planHash({ ...plan, plan_hash: undefined }) !== expectedHash) {
    return resultError('PLAYWRIGHT_TEST_LOCAL_PLAN_HASH_MISMATCH', 'Playwright Test local run requires the matching plan hash.', {});
  }
  const targetCwd = path.resolve(cwd, plan.cwd ?? '.');
  const playwrightCli = await resolvePlaywrightCli(cwd, targetCwd);
  if (!playwrightCli.ok) {
    return resultError(playwrightCli.code, playwrightCli.message, playwrightCli.details);
  }
  const runner = context.playwrightTestCommandRunner ?? runCommand;
  const output = await runner(process.execPath, [playwrightCli.absolute_path, ...plan.runner.argv], {
    cwd: targetCwd,
    env: { ...context.env },
    timeoutMs: plan.timeout_ms
  });
  const now = materializeNow(context.now);
  const id = createPlaywrightTestResultId(now, 'playwright-test-local');
  const result = {
    schema_version: SCHEMA_VERSION,
    integration_version: PLAYWRIGHT_TEST_LOCAL_RUN_VERSION,
    kind: 'playwright_test_result',
    id,
    status: output.code === 0 ? 'passed' : 'failed',
    status_label: output.code === 0 ? 'Playwright Test local run completed successfully.' : 'Playwright Test local run failed.',
    source: {
      kind: 'local_run',
      cwd: plan.cwd,
      raw_stdout_included: false,
      raw_stderr_included: false
    },
    summary: {
      total_count: 0,
      passed_count: output.code === 0 ? 1 : 0,
      failed_count: output.code === 0 ? 0 : 1,
      skipped_count: 0,
      flaky_count: 0,
      timed_out_count: output.signal ? 1 : 0,
      stdout_excerpt: redactText(output.stdout).slice(0, 500),
      stderr_excerpt: redactText(output.stderr).slice(0, 500),
      raw_content_included: false
    },
    freshness: {
      stale: false,
      signature: buildFreshnessSignature({
        source_kind: 'local_run',
        cwd: plan.cwd,
        plan_hash: expectedHash,
        exit_code: output.code,
        signal: output.signal ?? null
      }),
      generated_at: now.toISOString()
    },
    boundary: playwrightTestBoundary({
      process_spawned: true,
      browser_launched: true,
      writes_artifacts: true,
      raw_stdout_stored: false,
      raw_stderr_stored: false
    })
  };
  const receipt = {
    schema_version: SCHEMA_VERSION,
    kind: 'playwright_test_local_run_receipt',
    id,
    created_at: now.toISOString(),
    plan_hash: expectedHash,
    exit_code: output.code,
    signal: output.signal,
    raw_stdout_stored: false,
    raw_stderr_stored: false,
    credential_values_recorded: false,
    boundary: result.boundary
  };
  const artifacts = await writePlaywrightTestResultArtifacts({
    cwd,
    artifactRootInput: options['artifact-root'] ?? plan.artifact_root ?? DEFAULT_ARTIFACT_ROOT,
    id,
    result,
    receipt,
    now
  });
  return {
    status: 'ok',
    data: {
      playwright_test_local_run: result,
      boundary: result.boundary
    },
    warnings: [],
    errors: [],
    artifacts
  };
}

function buildPlaywrightArgv(options, configPath) {
  const args = ['test'];
  if (configPath) {
    args.push('--config', configPath);
  }
  if (options.project) {
    args.push('--project', String(options.project));
  }
  if (options.reporter) {
    args.push('--reporter', String(options.reporter));
  }
  return args;
}

function validateWorkspaceDir(cwd, value) {
  const normalized = normalizeWorkspacePath(value);
  if (!normalized.ok) return normalized;
  const absolute = path.resolve(cwd, normalized.value);
  const relative = path.relative(path.resolve(cwd), absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, code: 'PLAYWRIGHT_TEST_CWD_OUTSIDE_WORKSPACE', message: 'Playwright Test cwd must stay inside the workspace.', details: {} };
  }
  return { ok: true, absolute_path: absolute, relative_path: normalized.value };
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function planHash(plan) {
  const clean = { ...plan };
  delete clean.plan_hash;
  return createHash('sha256').update(JSON.stringify(clean)).digest('hex');
}

async function resolvePlaywrightCli(cwd, targetCwd) {
  const candidates = [
    path.join(targetCwd, 'node_modules', 'playwright', 'cli.js'),
    path.join(cwd, 'node_modules', 'playwright', 'cli.js')
  ];
  for (const candidate of candidates) {
    try {
      const info = await lstat(candidate);
      if (info.isFile() && !info.isSymbolicLink()) {
        return { ok: true, absolute_path: candidate };
      }
    } catch {
      // Try the next fixed candidate.
    }
  }
  return {
    ok: false,
    code: 'PLAYWRIGHT_TEST_LOCAL_CLI_NOT_FOUND',
    message: 'Playwright Test local run requires node_modules/playwright/cli.js in the workspace or TraceCue checkout.',
    details: {
      checked_locations: ['<target>/node_modules/playwright/cli.js', '<trace-cue>/node_modules/playwright/cli.js']
    }
  };
}
