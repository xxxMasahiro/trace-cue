import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildCiProof,
  digest,
  loadVerificationPolicy,
  planVerification,
  runVerificationPlan,
  validateCiProof,
  validateVerificationPolicy,
  VerificationPolicyError
} from '../tools/lib/verification-orchestration.mjs';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const verificationCli = path.join(repoRoot, 'tools', 'verification.mjs');

test('verification CLI rejects unknown, missing, duplicate, conflicting, and inapplicable arguments', () => {
  const cases = [
    [['check', '--bogus', 'ignored'], /Unknown or inapplicable argument/],
    [['check', '--policy'], /requires a value/],
    [['plan', '--profile', 'focused', '--profile', 'core'], /cannot be repeated/],
    [['run', '--profile', 'focused', '--worktree', '--path', 'src/api.js'], /Choose only one changed-path selector/],
    [['plan', '--profile', 'core', '--path', 'src/api.js'], /require the focused profile/],
    [['import-ci-proof', '--json'], /Unknown or inapplicable argument/]
  ];
  for (const [args, expected] of cases) {
    const result = spawnSync(process.execPath, [verificationCli, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    assert.notEqual(result.status, 0, `${args.join(' ')} unexpectedly succeeded`);
    assert.match(result.stderr, expected);
  }
});

test('verification release entrypoint resolves a renamed profile from policy', async () => {
  const root = await makeRepository();
  const policy = minimalPolicy([task('configured-release-task', 0, [])]);
  policy.profiles.production = policy.profiles.release;
  delete policy.profiles.release;
  policy.evidence_policy.release_profile = 'production';
  await writeFile(path.join(root, 'ops', 'VERIFICATION_EXECUTION_POLICY.json'), `${JSON.stringify(policy, null, 2)}\n`);
  const result = spawnSync(process.execPath, [verificationCli, 'release', '--json'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).profile, 'production');
});

test('repository verification policy is strict and cache-safe', async () => {
  const loaded = await loadVerificationPolicy({ root: repoRoot });
  assert.equal(loaded.policy.activation_mode, 'enforce');
  assert.equal(loaded.policy.command_execution, 'argv');
  assert.equal(loaded.policy.persistent_result_cache, 'disabled');
  assert.equal(loaded.policy.cross_run_result_reuse, 'disabled');
  assert.equal(loaded.policy.cache_policy.playwright_binary_only, true);
  assert.equal(loaded.policy.cache_policy.test_results_allowed, false);
  const renamed = structuredClone(loaded.policy);
  renamed.profiles.production = renamed.profiles.release;
  renamed.evidence_policy.release_profile = 'production';
  validateVerificationPolicy(renamed);
  const plan = planVerification({ loadedPolicy: { ...loaded, policy: renamed }, profile: 'production' });
  assert.equal(plan.release_ready_claim_allowed, true);
});

test('verification policy rejects unsafe commands, cycles, duplicate owners, and persistent pass cache', async (t) => {
  const loaded = await loadVerificationPolicy({ root: repoRoot });
  const cases = [
    ['persistent cache', (policy) => { policy.persistent_result_cache = 'enabled'; }, 'POLICY_CACHE'],
    ['shell command', (policy) => { policy.tasks[0].argv = ['bash', '-c', 'true']; }, 'UNSAFE_ARGV'],
    ['dependency cycle', (policy) => {
      policy.tasks[0].depends_on = [policy.tasks[1].id];
      policy.tasks[1].depends_on = [policy.tasks[0].id];
    }, 'TASK_CYCLE'],
    ['duplicate CI owner', (policy) => {
      policy.ci_graph.owners[1].execution_instance_ids = [
        policy.ci_graph.owners[0].execution_instance_ids[0],
        policy.ci_graph.owners[1].execution_instance_ids[1]
      ];
    }, 'CI_INSTANCE_DUPLICATE']
  ];
  for (const [name, mutate, code] of cases) {
    await t.test(name, () => {
      const policy = structuredClone(loaded.policy);
      mutate(policy);
      assert.throws(() => validateVerificationPolicy(policy), (error) => error instanceof VerificationPolicyError && error.code === code);
    });
  }
});

test('focused planning unions known surfaces and falls back safely for unknown paths', async () => {
  const loaded = await loadVerificationPolicy({ root: repoRoot });
  const browserPlan = planVerification({ loadedPolicy: loaded, profile: 'focused', changedPaths: ['control-center/src/App.jsx'] });
  assert.equal(browserPlan.scope, 'partial');
  assert.equal(browserPlan.release_ready_claim_allowed, false);
  assert.ok(browserPlan.tasks.some((task) => task.id === 'browser_smoke'));
  assert.ok(browserPlan.tasks.some((task) => task.id === 'test_no_browser'));

  const browserTestPlan = planVerification({ loadedPolicy: loaded, profile: 'focused', changedPaths: ['tests/helpers/browser-test-workspace.js'] });
  assert.ok(browserTestPlan.tasks.some((task) => task.id === 'browser_smoke'));

  const packagePlan = planVerification({ loadedPolicy: loaded, profile: 'focused', changedPaths: ['tools/lib/package-artifact.mjs'] });
  assert.ok(packagePlan.tasks.some((task) => task.id === 'package_install'));
  assert.ok(packagePlan.tasks.some((task) => task.id === 'test_no_browser'));

  const unknownPlan = planVerification({ loadedPolicy: loaded, profile: 'focused', changedPaths: ['future-surface/value.dat'] });
  assert.ok(unknownPlan.tasks.some((task) => task.id === 'test_no_browser'));

  const memoryPlan = planVerification({ loadedPolicy: loaded, profile: 'focused', changedPaths: ['docs/memory/SESSION_MEMORY.md'] });
  assert.equal(memoryPlan.tasks.length, 0);
  assert.deepEqual(memoryPlan.ignored_paths, ['docs/memory/SESSION_MEMORY.md']);
});

test('runner bounds parallel work, serializes locks, and preserves repository state', async () => {
  const root = await makeRepository();
  const policy = minimalPolicy([
    task('first', 140, ['shared']),
    task('second', 140, ['shared']),
    task('unrelated', 140, [])
  ]);
  const loadedPolicy = { root, policy, fingerprint: 'f'.repeat(64) };
  const plan = planVerification({ loadedPolicy, profile: 'core' });
  const started = Date.now();
  const result = await runVerificationPlan({ loadedPolicy, plan, jobs: 3 });
  const elapsed = Date.now() - started;
  assert.equal(result.status, 'passed');
  assert.equal(result.worktree_preserved, true);
  assert.ok(elapsed >= 240, `locked tasks unexpectedly overlapped: ${elapsed}ms`);
  assert.ok(elapsed < 700, `unrelated task did not overlap: ${elapsed}ms`);
});

test('runner starts a later dependency before an earlier serial consumer', async () => {
  const root = await makeRepository();
  const consumer = {
    ...task('consumer', 0, []),
    kind: 'serial',
    depends_on: ['producer']
  };
  const producer = {
    ...task('producer', 0, []),
    kind: 'heavy'
  };
  const policy = minimalPolicy([consumer, producer]);
  const loadedPolicy = { root, policy, fingerprint: 'a'.repeat(64) };
  const result = await runVerificationPlan({
    loadedPolicy,
    plan: planVerification({ loadedPolicy, profile: 'core' }),
    jobs: 2
  });
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.results.map(({ id, status }) => ({ id, status })), [
    { id: 'consumer', status: 'passed' },
    { id: 'producer', status: 'passed' }
  ]);
});

test('runner stops pending work after the first failure', async () => {
  const root = await makeRepository();
  const policy = minimalPolicy([
    { ...task('fail', 0, []), argv: ['node', '-e', 'process.exit(7)'] },
    task('pending', 10, [])
  ]);
  const loadedPolicy = { root, policy, fingerprint: 'e'.repeat(64) };
  const result = await runVerificationPlan({ loadedPolicy, plan: planVerification({ loadedPolicy, profile: 'core' }), jobs: 1 });
  assert.equal(result.status, 'failed');
  assert.equal(result.results[0].exit_code, 7);
  assert.equal(result.results[1].status, 'not_started');
});

test('runner never starts a task when cancellation already happened', async () => {
  const root = await makeRepository();
  const marker = path.join(tmpdir(), `verification-pre-abort-${process.pid}-${Date.now()}`);
  const cancelledTask = {
    ...task('cancelled-before-start', 0, []),
    argv: ['node', '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'must-not-run')`]
  };
  const policy = minimalPolicy([cancelledTask]);
  const loadedPolicy = { root, policy, fingerprint: '9'.repeat(64) };
  const controller = new AbortController();
  controller.abort();
  try {
    const result = await runVerificationPlan({
      loadedPolicy,
      plan: planVerification({ loadedPolicy, profile: 'core' }),
      jobs: 1,
      signal: controller.signal
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.results[0].status, 'cancelled');
    await assert.rejects(access(marker));
  } finally {
    await rm(marker, { force: true });
  }
});

test('runner does not forward credentials or live-provider opt-ins', async () => {
  const root = await makeRepository();
  const secretName = 'VERIFICATION_TEST_API_KEY';
  const liveName = 'VERIFICATION_TEST_LIVE_DOGFOOD';
  const previousSecret = process.env[secretName];
  const previousLive = process.env[liveName];
  process.env[secretName] = 'not-for-child-processes';
  process.env[liveName] = '1';
  try {
    const cleanEnvironment = {
      ...task('clean-environment', 0, []),
      argv: ['node', '-e', `process.exit(process.env.${secretName} || process.env.${liveName} ? 9 : 0)`]
    };
    const policy = minimalPolicy([cleanEnvironment]);
    const loadedPolicy = { root, policy, fingerprint: 'b'.repeat(64) };
    const result = await runVerificationPlan({ loadedPolicy, plan: planVerification({ loadedPolicy, profile: 'core' }), jobs: 1 });
    assert.equal(result.results[0].status, 'passed');
  } finally {
    if (previousSecret === undefined) delete process.env[secretName];
    else process.env[secretName] = previousSecret;
    if (previousLive === undefined) delete process.env[liveName];
    else process.env[liveName] = previousLive;
  }
});

test('runner fails closed on output limits, timeouts, and descendant processes', async (t) => {
  await t.test('output limit', async () => {
    const root = await makeRepository();
    const noisy = { ...task('noisy', 0, []), argv: ['node', '-e', "process.stdout.write('x'.repeat(4096))"] };
    const policy = minimalPolicy([noisy]);
    policy.limits.max_log_bytes = 1024;
    const loadedPolicy = { root, policy, fingerprint: 'd'.repeat(64) };
    const result = await runVerificationPlan({ loadedPolicy, plan: planVerification({ loadedPolicy, profile: 'core' }) });
    assert.equal(result.results[0].status, 'output_limited');
    assert.ok(Buffer.byteLength(result.results[0].output, 'utf8') <= policy.limits.max_log_bytes);
  });

  await t.test('timeout kills descendants', async () => {
    const root = await makeRepository();
    const marker = path.join(tmpdir(), `verification-descendant-${process.pid}-${Date.now()}`);
    const script = `const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', ${JSON.stringify(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 250)`) }], { stdio: 'ignore' }); setTimeout(() => {}, 1000);`;
    const slow = { ...task('slow', 0, []), argv: ['node', '-e', script] };
    const policy = minimalPolicy([slow]);
    policy.limits.default_timeout_ms = 50;
    const loadedPolicy = { root, policy, fingerprint: 'c'.repeat(64) };
    const result = await runVerificationPlan({ loadedPolicy, plan: planVerification({ loadedPolicy, profile: 'core' }) });
    assert.equal(result.results[0].status, 'timed_out');
    await new Promise((resolve) => setTimeout(resolve, 350));
    await assert.rejects(access(marker));
  });
});

test('CI proof binds every owner to one run, checkout, policy, and graph', async () => {
  const loaded = await loadVerificationPolicy({ root: repoRoot });
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const ownerResults = Object.fromEntries(loaded.policy.ci_graph.required_jobs.map((job) => [job, 'success']));
  const proof = buildCiProof({ loadedPolicy: loaded, ownerResults, runId: '123', runAttempt: 1, headSha, sourceJob: 'final-gate' });
  assert.equal(validateCiProof({ loadedPolicy: loaded, proof }).proof_digest, proof.proof_digest);
  assert.throws(() => validateCiProof({ loadedPolicy: loaded, proof: { ...proof, run_id: 'other' } }), /digest is invalid/u);
  const alteredTreeBody = { ...proof, tree_sha: 'f'.repeat(40) };
  delete alteredTreeBody.proof_digest;
  const alteredTree = { ...alteredTreeBody, proof_digest: digest(alteredTreeBody) };
  assert.throws(() => validateCiProof({ loadedPolicy: loaded, proof: alteredTree }), /does not match the current checkout/u);
  assert.throws(() => buildCiProof({ loadedPolicy: loaded, ownerResults: { ...ownerResults, 'browser-smoke': 'failure' }, runId: '123', runAttempt: 1, headSha, sourceJob: 'final-gate' }), /did not succeed/u);
});

function task(id, delayMs, locks) {
  return {
    id,
    label: id,
    argv: ['node', '-e', `setTimeout(() => process.exit(0), ${delayMs})`],
    kind: 'parallel',
    locks,
    depends_on: [],
    provides: [`check.${id}`]
  };
}

function minimalPolicy(tasks) {
  const policy = {
    schema_version: '1.0.0',
    kind: 'verification-execution-policy',
    activation_mode: 'enforce',
    command_execution: 'argv',
    unknown_state_policy: 'fail-closed',
    cross_run_result_reuse: 'disabled',
    persistent_result_cache: 'disabled',
    evidence_policy: {
      release_batch_required: true,
      release_profile: 'release',
      default_context: 'free-development',
      release_artifact_paths: ['dist/control-center'],
      ci_proof_source_id: 'product.ci.final_proof',
      ci_proof_workflow_path: '.github/workflows/ci.yml',
      ci_proof_artifact_prefix: 'verification-proof',
      ci_proof_filename: 'verification-proof.json',
      ci_proof_repository_remote: 'origin',
      ci_proof_repository_hosts: ['github.com'],
      ci_proof_default_context: 'external-integration',
      remote_ci_replaces_local_release: false,
      max_future_observation_skew_ms: 300000,
      ci_proof_api_timeout_ms: 30000,
      store_limits: {
        lock_timeout_ms: 15000, stale_lock_ms: 60000,
        receipt_retention_count: 2048, receipt_retention_bytes: 16777216,
        release_batch_retention_count: 64, release_batch_retention_bytes: 33554432,
        ingress_overflow_count: 128, ingress_overflow_bytes: 8388608
      }
    },
    limits: { default_timeout_ms: 2000, cancellation_grace_ms: 50, max_log_bytes: 65536, parallel_jobs: 'auto', max_parallel_jobs: 4 },
    tasks,
    profiles: { core: tasks.map((item) => item.id), release: tasks.map((item) => item.id), focused: [] },
    focused_selectors: [{ id: 'all', patterns: ['**'], profiles: ['core'] }],
    focused_fallback_profiles: ['core'],
    ci_graph: {
      workflow_contract: {
        name: 'CI',
        triggers: { pull_request: null, push: { branches: ['main'] }, workflow_dispatch: { inputs: { base_sha: { description: 'Base SHA', required: false, type: 'string' } } } },
        permissions: { contents: 'read' },
        concurrency: { group: 'ci-test', 'cancel-in-progress': true }
      },
      owners: [{
        job_id: 'owner',
        name: 'Owner',
        execution_instance_ids: ['owner-1'],
        runs_on: 'ubuntu-latest',
        timeout_minutes: 10,
        required_needs: [],
        required_strategy: {},
        required_outputs: {},
        required_actions: [{ uses: 'actions/checkout@v5', with: { 'persist-credentials': false } }],
        required_run_metadata: [{ env: {} }],
        required_step_order: ['action:0', 'run:0'],
        required_commands: ['node --test']
      }],
      final_job_id: 'final',
      final_name: 'Final',
      final_if: '${{ always() }}',
      final_runs_on: 'ubuntu-latest',
      final_timeout_minutes: 5,
      final_required_actions: [{ uses: 'actions/checkout@v5', with: { 'persist-credentials': false } }],
      final_required_run: { run: 'node proof', env: {} },
      final_required_step_order: ['action:0', 'run:0'],
      required_jobs: ['owner']
    },
    cache_policy: { playwright_binary_only: true, exact_key_required: true, restore_prefix_allowed: false, test_results_allowed: false, receipts_allowed: false }
  };
  validateVerificationPolicy(policy);
  return policy;
}

async function makeRepository() {
  const root = await mkdtemp(path.join(tmpdir(), 'verification-runner-'));
  await mkdir(path.join(root, 'ops'));
  await writeFile(path.join(root, 'tracked.txt'), 'fixture\n', 'utf8');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', 'tracked.txt'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root });
  return root;
}
