import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computePolicyFingerprint,
  evidenceStatus,
  rebuildDerivedEvidence,
  recordEvidence,
  runReleaseVerificationAndRecord,
  snapshotRepository
} from '../tools/lib/product-gate-evidence.mjs';
import {
  loadVerificationPolicy,
  planVerification
} from '../tools/lib/verification-orchestration.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const evidenceCli = path.join(repoRoot, 'tools', 'product-gate-evidence');

async function git(cwd, ...args) {
  return execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

async function fixture() {
  const cwd = await mkdtemp(path.join(tmpdir(), 'product-gate-verification-evidence-'));
  await mkdir(path.join(cwd, 'ops'), { recursive: true });
  await mkdir(path.join(cwd, 'schemas'), { recursive: true });
  await writeFile(path.join(cwd, 'ops', 'EVIDENCE_DETAIL_MANIFEST.tsv'), '# evidence fixture\n', 'utf8');
  await writeFile(path.join(cwd, 'ops', 'TEST_PLAN_MANIFEST.tsv'), '# tests fixture\n', 'utf8');
  await writeFile(path.join(cwd, 'ops', 'VERIFICATION_EXECUTION_POLICY.json'), `${JSON.stringify({
    schema_version: '1.0.0',
    evidence_policy: {
      release_batch_required: true,
      release_profile: 'release',
      max_future_observation_skew_ms: 300000,
      ci_proof_api_timeout_ms: 30000,
      store_limits: {
        lock_timeout_ms: 15000, stale_lock_ms: 60000,
        receipt_retention_count: 2048, receipt_retention_bytes: 16777216,
        release_batch_retention_count: 64, release_batch_retention_bytes: 33554432,
        ingress_overflow_count: 128, ingress_overflow_bytes: 8388608
      }
    }
  })}\n`, 'utf8');
  await writeFile(path.join(cwd, 'schemas', 'verification-execution-policy.schema.json'), '{"type":"object"}\n', 'utf8');
  await writeFile(path.join(cwd, 'README.md'), 'fixture\n', 'utf8');
  await git(cwd, 'init', '-q');
  await git(cwd, 'config', 'user.name', 'Verification Test');
  await git(cwd, 'config', 'user.email', 'verification@example.invalid');
  await git(cwd, 'add', '.');
  await git(cwd, 'commit', '-qm', 'fixture');
  return cwd;
}

function receiptFiles(cwd) {
  return path.join(cwd, '.git', 'product-gate-evidence', 'receipts-v2');
}

async function cli(cwd, args) {
  return execFileAsync(evidenceCli, args, {
    cwd,
    env: { ...process.env, PRODUCT_REPO_ROOT: cwd },
    encoding: 'utf8'
  });
}

async function updateEvidencePolicy(cwd, update, message = 'update evidence policy') {
  const file = path.join(cwd, 'ops', 'VERIFICATION_EXECUTION_POLICY.json');
  const policy = JSON.parse(await readFile(file, 'utf8'));
  update(policy);
  await writeFile(file, `${JSON.stringify(policy, null, 2)}\n`, 'utf8');
  await git(cwd, 'add', file);
  await git(cwd, 'commit', '-qm', message);
  return policy;
}

function evidenceRequirementRow(sourceId, requiredMode = 'required', contexts = 'all') {
  return [
    sourceId, requiredMode, contexts, 'local_tests', '#workflow', 'label', `${sourceId}.detail`, 'all',
    'Checked contract.', 'Required for current readiness.', 'Passed.', 'Failed.', 'Not run.', 'Stale.',
    'next_action', 'high', 'false', '10'
  ].join('\t');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function framedDigest(value) {
  const buffer = Buffer.from(JSON.stringify(stableValue(value)));
  return createHash('sha256').update(String(buffer.length)).update('\0').update(buffer).update('\0').digest('hex');
}

async function releaseFixture() {
  const cwd = await fixture();
  const tasks = [
    {
      id: 'first', label: 'First', argv: ['node', '-e', 'process.exit(0)'], kind: 'parallel', locks: [], depends_on: [],
      provides: ['product.gates.tests']
    },
    {
      id: 'second', label: 'Second', argv: ['node', '-e', 'process.exit(0)'], kind: 'parallel', locks: [], depends_on: ['first'],
      provides: ['product.gates.structure']
    }
  ];
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
    limits: { default_timeout_ms: 1000, cancellation_grace_ms: 50, max_log_bytes: 65536, parallel_jobs: 'auto', max_parallel_jobs: 2 },
    tasks,
    profiles: { release: ['first', 'second'], focused: [] },
    focused_selectors: [{ id: 'all', patterns: ['**'], profiles: ['release'] }],
    focused_fallback_profiles: ['release'],
    ci_graph: {
      workflow_contract: { name: 'CI', triggers: { pull_request: null, push: { branches: ['main'] }, workflow_dispatch: { inputs: { base_sha: { description: 'Base SHA', required: false, type: 'string' } } } }, permissions: { contents: 'read' }, concurrency: { group: 'ci-test', 'cancel-in-progress': true } },
      owners: [{ job_id: 'owner', name: 'Owner', execution_instance_ids: ['owner-1'], runs_on: 'ubuntu-latest', timeout_minutes: 10, required_needs: [], required_strategy: {}, required_outputs: {}, required_actions: [{ uses: 'actions/checkout@v5', with: { 'persist-credentials': false } }], required_run_metadata: [{ env: {} }], required_step_order: ['action:0', 'run:0'], required_commands: ['node --test'] }],
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
  await mkdir(path.join(cwd, 'dist', 'control-center'), { recursive: true });
  await writeFile(path.join(cwd, 'dist', 'control-center', 'index.html'), '<!doctype html>\n', 'utf8');
  await writeFile(path.join(cwd, 'ops', 'EVIDENCE_DETAIL_MANIFEST.tsv'), `${[
    evidenceRequirementRow('product.gates.tests'),
    evidenceRequirementRow('product.gates.structure')
  ].join('\n')}\n`, 'utf8');
  await writeFile(path.join(cwd, 'ops', 'VERIFICATION_EXECUTION_POLICY.json'), `${JSON.stringify(policy, null, 2)}\n`, 'utf8');
  await git(cwd, 'add', '.');
  await git(cwd, 'commit', '-qm', 'release fixture');
  const loaded = await loadVerificationPolicy({ root: cwd });
  const plan = planVerification({ loadedPolicy: loaded, profile: 'release' });
  return { cwd, loaded, plan };
}

async function recordFixtureBatch(fixtureValue) {
  const execution = await runReleaseVerificationAndRecord({
    loadedPolicy: fixtureValue.loaded,
    context: 'free-development',
    plan: fixtureValue.plan
  });
  return execution.evidenceBatch;
}

test('manual passed evidence is current but never authoritative', async () => {
  const cwd = await fixture();
  const recorded = await recordEvidence({
    repoRoot: cwd,
    sourceId: 'product.gates.manual',
    context: 'free-development',
    status: 'passed',
    authority: 'authoritative',
    sourceArtifacts: 'manual inspection',
    nextCommand: 'true',
    executionMode: 'manual'
  });
  assert.equal(recorded.receipt.authority, 'manual_required');
  assert.equal(recorded.receipt.head_sha.length, 40);
  assert.equal(recorded.receipt.tree_sha.length, 40);
  assert.equal(recorded.receipt.input_fingerprint.length, 64);
  assert.equal(recorded.receipt.policy_fingerprint.length, 64);
  assert.equal(recorded.receipt.command_fingerprint.length, 64);
  assert.equal((await evidenceStatus(cwd)).status, 'blocked');
  const serialized = await readFile(recorded.path, 'utf8');
  assert.doesNotMatch(serialized, /stdout|stderr|process\.env|authorization|cookie|password|api_key|access_token/iu);
});

test('manual not-applicable evidence cannot bypass a required gate', async () => {
  const cwd = await fixture();
  const recorded = await recordEvidence({
    repoRoot: cwd,
    sourceId: 'product.ci.manual-waiver',
    context: 'free-development',
    status: 'not_applicable',
    requiredInContext: true,
    authority: 'authoritative',
    sourceArtifacts: 'manual waiver',
    executionMode: 'manual'
  });
  assert.equal(recorded.receipt.authority, 'manual_required');
  assert.equal((await evidenceStatus(cwd)).status, 'blocked');
});

test('executed clean success is authoritative and command failure propagates', async () => {
  const cwd = await fixture();
  await cli(cwd, [
    'run', 'product.gates.executed', 'free-development', 'focused verification', 'node check', '3600',
    '--', process.execPath, '-e', 'process.exit(0)'
  ]);
  const ready = await evidenceStatus(cwd);
  const success = ready.rows.find((row) => row.source_id === 'product.gates.executed');
  assert.equal(success.authority, 'authoritative');
  assert.equal(success.freshness_state, 'current');

  await assert.rejects(
    cli(cwd, [
      'run', 'product.gates.failed', 'free-development', 'focused verification', 'node check', '3600',
      '--', process.execPath, '-e', 'process.exit(7)'
    ]),
    (error) => error.code === 7
  );
  const failed = (await evidenceStatus(cwd)).rows.find((row) => row.source_id === 'product.gates.failed');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.authority, 'authoritative');
});

test('dirty successful execution is advisory and cannot satisfy readiness', async () => {
  const cwd = await fixture();
  await writeFile(path.join(cwd, 'README.md'), 'dirty\n', 'utf8');
  await cli(cwd, [
    'run', 'product.gates.dirty', 'free-development', 'dirty verification', 'node check', '3600',
    '--', process.execPath, '-e', 'process.exit(0)'
  ]);
  const result = await evidenceStatus(cwd);
  const row = result.rows.find((item) => item.source_id === 'product.gates.dirty');
  assert.equal(row.authority, 'advisory');
  assert.equal(row.freshness_state, 'current');
  assert.equal(result.status, 'blocked');
});

test('evidence rejects raw secrets environment dumps URLs and absolute paths', async () => {
  const cwd = await fixture();
  const base = {
    repoRoot: cwd,
    sourceId: 'product.gates.safe-metadata',
    context: 'free-development',
    status: 'passed',
    executionMode: 'manual'
  };
  for (const sourceArtifacts of [
    'password=hunter2',
    'AUTH_TOKEN=value',
    'https://example.invalid/report',
    '/home/example/private/report.json',
    'C:\\Users\\example\\report.json'
  ]) {
    await assert.rejects(recordEvidence({ ...base, sourceArtifacts }), /forbidden path, environment, URL, or secret-bearing data/);
  }
});

test('HEAD input policy and age changes make evidence stale', async () => {
  const cwd = await fixture();
  await recordEvidence({
    repoRoot: cwd,
    sourceId: 'product.gates.freshness',
    context: 'free-development',
    status: 'passed',
    authority: 'authoritative',
    sourceArtifacts: 'executed check',
    nextCommand: 'true',
    executionMode: 'executed',
    argv: ['true'],
    now: new Date('2026-07-13T00:00:00.000Z'),
    maxAgeSeconds: 60
  });
  assert.equal((await evidenceStatus(cwd, { now: Date.parse('2026-07-13T00:00:30.000Z') })).status, 'ready');
  assert.equal((await evidenceStatus(cwd, { now: Date.parse('2026-07-13T00:02:00.000Z') })).status, 'stale');

  await writeFile(path.join(cwd, 'README.md'), 'changed input\n', 'utf8');
  assert.equal((await evidenceStatus(cwd, { now: Date.parse('2026-07-13T00:00:30.000Z') })).status, 'stale');
});

test('evidence rejects observations beyond the configured future clock skew', async () => {
  const cwd = await fixture();
  await assert.rejects(recordEvidence({
    repoRoot: cwd,
    sourceId: 'product.gates.future-observation',
    context: 'free-development',
    status: 'passed',
    authority: 'authoritative',
    executionMode: 'executed',
    sourceArtifacts: 'future observation check',
    argv: ['true'],
    now: new Date(Date.now() + 600000)
  }), /too far in the future/);
});

test('derived index uses the parent-compatible 13-column whole-second timestamp contract', async () => {
  const cwd = await fixture();
  await recordEvidence({
    repoRoot: cwd,
    sourceId: 'product.gates.parent-contract',
    context: 'free-development',
    status: 'passed',
    authority: 'authoritative',
    sourceArtifacts: 'contract check',
    nextCommand: 'true',
    executionMode: 'executed',
    argv: ['true'],
    now: new Date('2026-07-13T00:00:00.987Z')
  });
  const index = await readFile(path.join(cwd, '.git', 'product-gate-evidence', 'index.tsv'), 'utf8');
  const row = index.split('\n').find((line) => line.startsWith('product.gates.parent-contract\t'));
  assert.ok(row);
  const fields = row.split('\t');
  assert.equal(fields.length, 13);
  assert.equal(fields[6], '2026-07-13T00:00:00Z');
  assert.match(fields[9], /^[0-9a-f]{40}$/u);
  const detail = JSON.parse(await readFile(path.join(
    cwd, '.git', 'product-gate-evidence', 'details', 'product.gates.parent-contract', 'current-v2.json'
  ), 'utf8'));
  assert.equal(detail.event_id, (await evidenceStatus(cwd)).rows.find((item) => item.source_id === 'product.gates.parent-contract').event_id);
  assert.equal(detail.observed_at, '2026-07-13T00:00:00Z');
  assert.equal(detail.product_head, fields[9]);
  assert.equal(detail.safe_summary, 'product.gates.parent-contract passed');
});

test('legacy short-HEAD rows are archived once and never re-enter the active index', async () => {
  const cwd = await fixture();
  const root = path.join(cwd, '.git', 'product-gate-evidence');
  await mkdir(root, { recursive: true });
  const legacyRow = [
    'product.gates.legacy', 'free-development', 'passed', 'current', 'true', 'authoritative',
    '2026-07-12T00:00:00Z', '3600', '[external-product-repository]/fixture', 'abc123def456',
    'legacy check', '', 'true'
  ].join('\t');
  const legacyIndex = `# source_id\tcontext\tstatus\tfreshness_state\trequired_in_context\tauthority\tobserved_at\tmax_age_seconds\tproduct_root\tproduct_head\tsource_artifacts\tblocked_by\tnext_command\n${legacyRow}\n`;
  await writeFile(path.join(root, 'index.tsv'), legacyIndex, 'utf8');

  await rebuildDerivedEvidence(cwd);
  const active = await readFile(path.join(root, 'index.tsv'), 'utf8');
  assert.doesNotMatch(active, /product\.gates\.legacy/u);
  const archiveDirectory = path.join(root, 'legacy');
  const firstEntries = (await readdir(archiveDirectory)).sort();
  assert.equal(firstEntries.filter((entry) => entry.endsWith('.tsv')).length, 1);
  const archive = firstEntries.find((entry) => entry.endsWith('.tsv'));
  assert.equal(await readFile(path.join(archiveDirectory, archive), 'utf8'), legacyIndex);
  assert.equal(JSON.parse(await readFile(path.join(archiveDirectory, 'migration-v2.json'), 'utf8')).row_count, 1);

  await rebuildDerivedEvidence(cwd);
  assert.deepEqual((await readdir(archiveDirectory)).sort(), firstEntries);
  assert.doesNotMatch(await readFile(path.join(root, 'index.tsv'), 'utf8'), /product\.gates\.legacy/u);
});

test('stale optional evidence remains history without blocking current required evidence', async () => {
  const cwd = await fixture();
  await recordEvidence({
    repoRoot: cwd,
    sourceId: 'product.gates.optional-history',
    context: 'free-development',
    status: 'passed',
    requiredInContext: false,
    authority: 'authoritative',
    sourceArtifacts: 'optional check',
    executionMode: 'executed',
    argv: ['true'],
    now: new Date('2026-07-13T00:00:00.000Z'),
    maxAgeSeconds: 1
  });
  await recordEvidence({
    repoRoot: cwd,
    sourceId: 'product.gates.required-current',
    context: 'free-development',
    status: 'passed',
    authority: 'authoritative',
    sourceArtifacts: 'required check',
    executionMode: 'executed',
    argv: ['true'],
    now: new Date('2026-07-13T00:00:30.000Z'),
    maxAgeSeconds: 3600
  });
  const result = await evidenceStatus(cwd, { now: Date.parse('2026-07-13T00:00:31.000Z') });
  assert.equal(result.rows.find((row) => row.source_id === 'product.gates.optional-history').freshness_state, 'stale');
  assert.equal(result.status, 'ready');
});

test('declared required evidence is synthesized as not-run when only optional evidence exists', async () => {
  const cwd = await fixture();
  await writeFile(path.join(cwd, 'ops', 'EVIDENCE_DETAIL_MANIFEST.tsv'), `${evidenceRequirementRow('product.gates.required-missing')}\n`, 'utf8');
  await recordEvidence({
    repoRoot: cwd,
    sourceId: 'product.gates.optional-only',
    context: 'free-development',
    status: 'passed',
    requiredInContext: false,
    authority: 'authoritative',
    sourceArtifacts: 'optional check',
    executionMode: 'executed',
    argv: ['true']
  });
  const result = await evidenceStatus(cwd);
  const missing = result.rows.find((row) => row.source_id === 'product.gates.required-missing');
  assert.equal(missing.status, 'not_run');
  assert.equal(missing.required_in_context, true);
  assert.equal(result.status, 'blocked');
  const detail = JSON.parse(await readFile(path.join(
    cwd, '.git', 'product-gate-evidence', 'details', 'product.gates.required-missing', 'current-v2.json'
  ), 'utf8'));
  assert.equal(detail.event_id, '');
  assert.equal(detail.status, 'not_run');
  assert.match(detail.reason, /has not been collected/u);
});

test('an empty receipt store still exposes manifest-required evidence as not-run', async () => {
  const cwd = await fixture();
  await writeFile(path.join(cwd, 'ops', 'EVIDENCE_DETAIL_MANIFEST.tsv'), `${evidenceRequirementRow('product.gates.empty-required')}\n`, 'utf8');
  const result = await evidenceStatus(cwd);
  const missing = result.rows.find((row) => row.source_id === 'product.gates.empty-required');
  assert.equal(missing.context, 'all');
  assert.equal(missing.status, 'not_run');
  assert.equal(missing.required_in_context, true);
  assert.equal(result.status, 'blocked');
});

test('cached required evidence cannot satisfy readiness', async () => {
  const cwd = await fixture();
  await recordEvidence({
    repoRoot: cwd,
    sourceId: 'product.gates.cached',
    context: 'free-development',
    status: 'cached',
    requiredInContext: true,
    authority: 'authoritative',
    sourceArtifacts: 'cached check',
    executionMode: 'executed',
    argv: ['true']
  });
  assert.equal((await evidenceStatus(cwd)).status, 'blocked');
});

test('manifest-known contextual evidence is non-required outside its declared contexts', async () => {
  const cwd = await fixture();
  await writeFile(path.join(cwd, 'ops', 'EVIDENCE_DETAIL_MANIFEST.tsv'), `${evidenceRequirementRow(
    'product.ci.contextual', 'contextual', 'product-improvement|external-integration'
  )}\n`, 'utf8');
  await recordEvidence({
    repoRoot: cwd,
    sourceId: 'product.ci.contextual',
    context: 'free-development',
    status: 'passed',
    requiredInContext: true,
    authority: 'authoritative',
    sourceArtifacts: 'contextual check',
    executionMode: 'executed',
    argv: ['true']
  });
  const result = await evidenceStatus(cwd);
  assert.equal(result.rows.find((row) => row.source_id === 'product.ci.contextual').required_in_context, false);
  assert.equal(result.status, 'ready');
});

test('verification execution policy and schema participate in the policy fingerprint', async () => {
  const cwd = await fixture();
  const before = await computePolicyFingerprint(cwd);
  await writeFile(path.join(cwd, 'ops', 'VERIFICATION_EXECUTION_POLICY.json'), '{"schema_version":"2.0.0"}\n', 'utf8');
  const policyChanged = await computePolicyFingerprint(cwd);
  assert.notEqual(policyChanged, before);
  await git(cwd, 'checkout', '--', 'ops/VERIFICATION_EXECUTION_POLICY.json');
  await writeFile(path.join(cwd, 'schemas', 'verification-execution-policy.schema.json'), '{"type":"string"}\n', 'utf8');
  assert.notEqual(await computePolicyFingerprint(cwd), before);
});

test('one committed release batch makes every required source ready without changing the 13-column index', async () => {
  const value = await releaseFixture();
  const recorded = await recordFixtureBatch(value);
  assert.equal(recorded.recorded.length, 2);
  const status = await evidenceStatus(value.cwd, { now: Date.parse(recorded.batch.created_at) + 10_000 });
  assert.equal(status.status, 'ready');
  assert.equal(status.rows.filter((row) => row.required_in_context).every((row) => (
    row.evidence_batch_id === recorded.batch.batch_id && row.evidence_batch_valid
  )), true);
  const index = await readFile(path.join(value.cwd, '.git', 'product-gate-evidence', 'index.tsv'), 'utf8');
  assert.equal(index.trim().split('\n').slice(1).every((row) => row.split('\t').length === 13), true);
  const commit = JSON.parse(await readFile(path.join(
    value.cwd, '.git', 'product-gate-evidence', 'release-batches-v1', recorded.batch.batch_id, 'committed.json'
  ), 'utf8'));
  assert.equal(commit.receipt_count, 2);
  assert.deepEqual(commit.receipts.map((receipt) => receipt.source_id), ['product.gates.structure', 'product.gates.tests']);
});

test('renaming the configured release profile makes old batches stale and permits fresh recovery', async () => {
  const value = await releaseFixture();
  const oldBatch = await recordFixtureBatch(value);
  await updateEvidencePolicy(value.cwd, (policy) => {
    policy.evidence_policy.release_profile = 'production';
    policy.profiles.production = [...policy.profiles.release];
  }, 'rename release profile');
  const stale = await evidenceStatus(value.cwd);
  assert.equal(stale.status, 'stale');
  assert.equal(stale.batches.some((batch) => batch.batch_id === oldBatch.batch.batch_id && batch.artifact_current === false), true);

  const loaded = await loadVerificationPolicy({ root: value.cwd });
  const plan = planVerification({ loadedPolicy: loaded, profile: 'production' });
  const recovered = await runReleaseVerificationAndRecord({ loadedPolicy: loaded, plan, context: 'free-development' });
  assert.equal(recovered.evidenceBatch.batch.profile, 'production');
  assert.equal((await evidenceStatus(value.cwd)).status, 'ready');
});

test('release evidence becomes stale when the ignored release artifact changes', async () => {
  const value = await releaseFixture();
  const recorded = await recordFixtureBatch(value);
  await writeFile(path.join(value.cwd, 'dist', 'control-center', 'index.html'), '<!doctype html><p>changed</p>\n', 'utf8');
  const status = await evidenceStatus(value.cwd, { now: Date.parse(recorded.batch.created_at) + 10_000 });
  assert.equal(status.status, 'stale');
  assert.equal(status.rows.filter((row) => row.required_in_context).every((row) => row.evidence_batch_valid === false), true);
});

test('optional evidence in another context does not synthesize a second required release set', async () => {
  const value = await releaseFixture();
  const recorded = await recordFixtureBatch(value);
  await recordEvidence({
    repoRoot: value.cwd,
    sourceId: 'product.ci.final_proof',
    context: 'external-integration',
    status: 'passed',
    requiredInContext: false,
    authority: 'advisory',
    sourceArtifacts: 'separate optional CI observation',
    executionMode: 'manual',
    now: new Date(Date.parse(recorded.batch.created_at) + 1000)
  });
  const status = await evidenceStatus(value.cwd, { now: Date.parse(recorded.batch.created_at) + 10_000 });
  assert.equal(status.status, 'ready');
  assert.equal(status.rows.some((row) => row.context === 'external-integration' && row.required_in_context), false);
});

test('standalone evidence cannot impersonate an authoritative CI proof pass', async () => {
  const value = await releaseFixture();
  await assert.rejects(recordEvidence({
    repoRoot: value.cwd,
    sourceId: 'product.ci.final_proof',
    context: 'free-development',
    status: 'passed',
    requiredInContext: false,
    authority: 'authoritative',
    sourceArtifacts: 'forged CI result',
    executionMode: 'executed',
    argv: ['true']
  }), /authenticated proof importer/);
});

test('release evidence rejects dirty repositories and incomplete release plans', async () => {
  const dirty = await releaseFixture();
  await writeFile(path.join(dirty.cwd, 'README.md'), 'dirty\n', 'utf8');
  await assert.rejects(recordFixtureBatch(dirty), /clean worktree/);

  const incomplete = await releaseFixture();
  await assert.rejects(runReleaseVerificationAndRecord({
    loadedPolicy: incomplete.loaded,
    plan: { ...incomplete.plan, tasks: incomplete.plan.tasks.slice(0, 1) }
  }), /complete current release profile/);
});

test('uncommitted or receipt-mismatched release batches are stale and never authority-ready', async () => {
  const uncommitted = await releaseFixture();
  const first = await recordFixtureBatch(uncommitted);
  const batchDirectory = path.join(uncommitted.cwd, '.git', 'product-gate-evidence', 'release-batches-v1', first.batch.batch_id);
  await rm(path.join(batchDirectory, 'committed.json'));
  assert.equal((await evidenceStatus(uncommitted.cwd, { now: Date.parse(first.batch.created_at) + 10_000 })).status, 'stale');

  const mismatched = await releaseFixture();
  const second = await recordFixtureBatch(mismatched);
  const commitFile = path.join(mismatched.cwd, '.git', 'product-gate-evidence', 'release-batches-v1', second.batch.batch_id, 'committed.json');
  const commit = JSON.parse(await readFile(commitFile, 'utf8'));
  commit.receipts[0].event_id = `${commit.receipts[0].event_id}-missing`;
  const fields = { ...commit };
  delete fields.commit_digest;
  commit.commit_digest = framedDigest(fields);
  await writeFile(commitFile, `${JSON.stringify(commit)}\n`, 'utf8');
  assert.equal((await evidenceStatus(mismatched.cwd, { now: Date.parse(second.batch.created_at) + 10_000 })).status, 'stale');
});

test('a later standalone success cannot replace a complete batch but a later authoritative failure remains visible', async () => {
  const value = await releaseFixture();
  const batch = await recordFixtureBatch(value);
  const batchTime = Date.parse(batch.batch.created_at);
  await recordEvidence({
    repoRoot: value.cwd,
    sourceId: 'product.gates.tests',
    context: 'free-development',
    status: 'passed',
    executionMode: 'executed',
    authority: 'authoritative',
    sourceArtifacts: 'later standalone success',
    argv: ['true'],
    now: new Date(batchTime + 1000)
  });
  let status = await evidenceStatus(value.cwd, { now: batchTime + 10_000 });
  assert.equal(status.status, 'ready');
  assert.equal(status.rows.find((row) => row.source_id === 'product.gates.tests').evidence_batch_id, batch.batch.batch_id);

  await recordEvidence({
    repoRoot: value.cwd,
    sourceId: 'product.gates.tests',
    context: 'free-development',
    status: 'failed',
    executionMode: 'executed',
    authority: 'authoritative',
    sourceArtifacts: 'later standalone failure',
    argv: ['false'],
    now: new Date(batchTime + 2000)
  });
  status = await evidenceStatus(value.cwd, { now: batchTime + 10_000 });
  assert.equal(status.status, 'failed');
  assert.equal(status.rows.find((row) => row.source_id === 'product.gates.tests').status, 'failed');
});

test('a newer complete release batch clears an older authoritative failure', async () => {
  const value = await releaseFixture();
  await recordFixtureBatch(value);
  await recordEvidence({
    repoRoot: value.cwd,
    sourceId: 'product.gates.tests',
    context: 'free-development',
    status: 'failed',
    executionMode: 'executed',
    authority: 'authoritative',
    sourceArtifacts: 'recoverable failed run',
    argv: ['false']
  });
  assert.equal((await evidenceStatus(value.cwd)).status, 'failed');

  await new Promise((resolve) => setTimeout(resolve, 25));
  const recovered = await recordFixtureBatch(value);
  const status = await evidenceStatus(value.cwd);
  assert.equal(status.status, 'ready');
  const row = status.rows.find((candidate) => candidate.source_id === 'product.gates.tests');
  assert.equal(row.status, 'passed');
  assert.equal(row.evidence_batch_id, recovered.batch.batch_id);
});

test('standalone writers cannot forge batch bindings and artifact symlinks are rejected', async () => {
  const value = await releaseFixture();
  await assert.rejects(recordEvidence({
    repoRoot: value.cwd,
    sourceId: 'product.gates.tests',
    context: 'free-development',
    status: 'passed',
    executionMode: 'manual',
    sourceArtifacts: 'forged receipt reservation',
    receiptAdmissionReservation: { count: 1000, bytes: 1024 * 1024 }
  }), /reservations are internal/);
  await assert.rejects(recordEvidence({
    repoRoot: value.cwd,
    sourceId: 'product.gates.tests',
    context: 'free-development',
    status: 'passed',
    executionMode: 'executed',
    authority: 'authoritative',
    sourceArtifacts: 'forged batch',
    argv: ['true'],
    evidenceBatchId: `release-${'a'.repeat(32)}`,
    evidenceBatchDigest: 'b'.repeat(64),
    verificationTaskId: 'first'
  }), /only be recorded by the complete release recorder/);

  const outside = path.join(value.cwd, 'outside.html');
  await writeFile(outside, 'outside\n', 'utf8');
  await rm(path.join(value.cwd, 'dist', 'control-center', 'index.html'));
  await symlink(outside, path.join(value.cwd, 'dist', 'control-center', 'index.html'));
  await git(value.cwd, 'add', '-A');
  await git(value.cwd, 'commit', '-qm', 'symlink artifact');
  const loaded = await loadVerificationPolicy({ root: value.cwd });
  const plan = planVerification({ loadedPolicy: loaded, profile: 'release' });
  await assert.rejects(runReleaseVerificationAndRecord({
    loadedPolicy: loaded,
    plan,
  }), /artifact is symlinked/);
});

test('concurrent writers preserve every receipt and derived index row', async () => {
  const cwd = await fixture();
  const count = 12;
  await Promise.all(Array.from({ length: count }, (_, index) => cli(cwd, [
    'record',
    `product.gates.concurrent-${index}`,
    'free-development',
    'passed',
    `concurrent check ${index}`,
    'true',
    '3600'
  ])));
  const rebuilt = await rebuildDerivedEvidence(cwd);
  const concurrentRows = rebuilt.rows.filter((row) => row.source_id.startsWith('product.gates.concurrent-'));
  assert.equal(concurrentRows.length, count);
  assert.equal(rebuilt.receipts.filter(({ receipt }) => receipt.source_id.startsWith('product.gates.concurrent-')).length, count);
  assert.equal(concurrentRows.every((row) => row.authority === 'manual_required'), true);
  const index = await readFile(path.join(cwd, '.git', 'product-gate-evidence', 'index.tsv'), 'utf8');
  assert.equal(index.split('\n').filter((line) => line.includes('product.gates.concurrent-')).length, count);
  const ledger = (await readFile(path.join(cwd, '.git', 'product-gate-evidence', 'ledger.jsonl'), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(ledger.filter((row) => row.source_id.startsWith('product.gates.concurrent-')).length, count);
  assert.equal(ledger.every((row) => typeof row.freshness_state === 'string' && typeof row.detail_artifact_path === 'string'), true);
});

test('receipt history is pruned to policy-owned count limits without losing the latest state', async () => {
  const cwd = await fixture();
  await updateEvidencePolicy(cwd, (policy) => {
    policy.evidence_policy.store_limits.receipt_retention_count = 2;
    policy.evidence_policy.store_limits.ingress_overflow_count = 4;
  });
  for (let index = 0; index < 3; index += 1) {
    await recordEvidence({
      repoRoot: cwd,
      sourceId: 'product.gates.retained-history',
      context: 'free-development',
      status: index === 2 ? 'failed' : 'passed',
      executionMode: 'manual',
      sourceArtifacts: `retention check ${index}`
    });
  }
  const result = await evidenceStatus(cwd);
  assert.equal(result.receipts.length, 2);
  assert.equal(result.rows.find((row) => row.source_id === 'product.gates.retained-history').status, 'failed');
  assert.equal((await readdir(receiptFiles(cwd))).filter((entry) => entry !== '.product-gate-evidence-v2').length, 2);
  assert.equal((await readdir(path.join(cwd, '.git', 'product-gate-evidence', 'inactive-archive-v1', 'receipts'))).length, 1);
});

test('bounded retention preserves the same authoritative failure selected before pruning', async () => {
  const cwd = await fixture();
  await updateEvidencePolicy(cwd, (policy) => {
    policy.evidence_policy.store_limits.receipt_retention_count = 2;
    policy.evidence_policy.store_limits.ingress_overflow_count = 4;
  });
  await recordEvidence({
    repoRoot: cwd,
    sourceId: 'product.gates.semantic-retention',
    context: 'free-development',
    status: 'failed',
    authority: 'authoritative',
    executionMode: 'executed',
    sourceArtifacts: 'authoritative failed check',
    argv: ['true']
  });
  await recordEvidence({
    repoRoot: cwd,
    sourceId: 'product.gates.semantic-retention',
    context: 'free-development',
    status: 'passed',
    executionMode: 'manual',
    sourceArtifacts: 'later ordinary pass'
  });
  const before = (await evidenceStatus(cwd)).rows.find((row) => row.source_id === 'product.gates.semantic-retention');
  await recordEvidence({
    repoRoot: cwd,
    sourceId: 'product.gates.retention-trigger',
    context: 'free-development',
    status: 'passed',
    executionMode: 'manual',
    sourceArtifacts: 'retention trigger'
  });
  const after = (await evidenceStatus(cwd)).rows.find((row) => row.source_id === 'product.gates.semantic-retention');
  assert.equal(before.status, 'failed');
  assert.equal(after.status, 'failed');
  assert.equal(after.event_id, before.event_id);
});

test('bounded batch retention keeps the semantic winner and archives older complete runs', async () => {
  const value = await releaseFixture();
  await updateEvidencePolicy(value.cwd, (policy) => {
    policy.evidence_policy.store_limits.release_batch_retention_count = 2;
    policy.evidence_policy.store_limits.ingress_overflow_count = 4;
  });
  for (let index = 0; index < 3; index += 1) {
    const loaded = await loadVerificationPolicy({ root: value.cwd });
    const plan = planVerification({ loadedPolicy: loaded, profile: 'release' });
    await runReleaseVerificationAndRecord({ loadedPolicy: loaded, plan, context: 'free-development' });
  }
  const status = await evidenceStatus(value.cwd);
  assert.equal(status.status, 'ready');
  assert.equal(status.batches.length, 2);
  assert.equal((await readdir(path.join(value.cwd, '.git', 'product-gate-evidence', 'release-batches-v1'))).length, 2);
  assert.equal((await readdir(path.join(value.cwd, '.git', 'product-gate-evidence', 'inactive-archive-v1', 'release-batches'))).length, 1);
});

test('release evidence recovers receipt capacity without reacquiring its held index lock', async () => {
  const value = await releaseFixture();
  await updateEvidencePolicy(value.cwd, (policy) => {
    policy.evidence_policy.store_limits.lock_timeout_ms = 1000;
    policy.evidence_policy.store_limits.stale_lock_ms = 2000;
    policy.evidence_policy.store_limits.receipt_retention_count = 2;
    policy.evidence_policy.store_limits.ingress_overflow_count = 1;
  });
  await recordEvidence({
    repoRoot: value.cwd,
    sourceId: 'product.gates.structure',
    context: 'free-development',
    status: 'failed',
    authority: 'authoritative',
    executionMode: 'executed',
    argv: ['false'],
    sourceArtifacts: 'capacity prefill authoritative failure'
  });
  await recordEvidence({
    repoRoot: value.cwd,
    sourceId: 'product.gates.tests',
    context: 'free-development',
    status: 'passed',
    executionMode: 'manual',
    sourceArtifacts: 'capacity prefill ordinary result'
  });
  assert.equal((await evidenceStatus(value.cwd)).status, 'failed');
  const loaded = await loadVerificationPolicy({ root: value.cwd });
  const plan = planVerification({ loadedPolicy: loaded, profile: loaded.policy.evidence_policy.release_profile });
  const started = Date.now();
  const execution = await runReleaseVerificationAndRecord({ loadedPolicy: loaded, plan, context: 'free-development' });
  assert.ok(Date.now() - started < 5000);
  const commit = JSON.parse(await readFile(path.join(
    value.cwd,
    '.git',
    'product-gate-evidence',
    'release-batches-v1',
    execution.evidenceBatch.batch.batch_id,
    'committed.json'
  ), 'utf8'));
  assert.equal(commit.receipt_count, 2);
  assert.equal(execution.evidenceBatch.recorded.every(({ receipt }) => receipt.next_command === 'npm run verification:release:evidence'), true);
  const status = await evidenceStatus(value.cwd);
  assert.equal(status.status, 'ready');
  assert.equal(status.rows.find((row) => row.source_id === 'product.gates.structure').evidence_batch_id, execution.evidenceBatch.batch.batch_id);
});

test('a crashed archive initializer cannot wedge later evidence retirement', async () => {
  const cwd = await fixture();
  await updateEvidencePolicy(cwd, (policy) => {
    policy.evidence_policy.store_limits.receipt_retention_count = 1;
    policy.evidence_policy.store_limits.ingress_overflow_count = 2;
  });
  const evidenceDirectory = path.join(cwd, '.git', 'product-gate-evidence');
  await mkdir(path.join(evidenceDirectory, `.inactive-archive-v1.initializing-99999999-${'a'.repeat(36)}`), { recursive: true });
  await recordEvidence({
    repoRoot: cwd, sourceId: 'product.gates.archive-init', context: 'free-development',
    status: 'passed', executionMode: 'manual', sourceArtifacts: 'first record'
  });
  await recordEvidence({
    repoRoot: cwd, sourceId: 'product.gates.archive-init', context: 'free-development',
    status: 'failed', executionMode: 'manual', sourceArtifacts: 'second record'
  });
  assert.equal((await evidenceStatus(cwd)).rows.find((row) => row.source_id === 'product.gates.archive-init').status, 'failed');
  assert.equal((await readdir(path.join(evidenceDirectory, 'inactive-archive-v1', 'receipts'))).length, 1);
});

test('expired empty and pending release batch directories are safely retired', async () => {
  const cwd = await fixture();
  const root = path.join(cwd, '.git', 'product-gate-evidence', 'release-batches-v1');
  await mkdir(root, { recursive: true });
  const empty = path.join(root, `release-${'a'.repeat(32)}`);
  const pending = path.join(root, `release-${'b'.repeat(32)}`);
  await mkdir(empty);
  await mkdir(pending);
  await writeFile(path.join(pending, '.batch.json.99999999.00000000-0000-4000-8000-000000000000.tmp'), '{}\n');
  const old = new Date(Date.now() - 120000);
  await utimes(empty, old, old);
  await utimes(pending, old, old);
  await rebuildDerivedEvidence(cwd);
  assert.deepEqual(await readdir(root), []);
  assert.equal((await readdir(path.join(cwd, '.git', 'product-gate-evidence', 'inactive-archive-v1', 'release-batches'))).length, 2);
});

test('retention refuses a pathname replacement and preserves the replacement directory', async () => {
  const cwd = await fixture();
  await updateEvidencePolicy(cwd, (policy) => {
    policy.evidence_policy.store_limits.receipt_retention_count = 1;
    policy.evidence_policy.store_limits.ingress_overflow_count = 2;
  });
  await recordEvidence({
    repoRoot: cwd, sourceId: 'product.gates.retirement-race', context: 'free-development',
    status: 'passed', executionMode: 'manual', sourceArtifacts: 'old record'
  });
  await recordEvidence({
    repoRoot: cwd, sourceId: 'product.gates.retirement-race', context: 'free-development',
    status: 'failed', executionMode: 'manual', sourceArtifacts: 'new record', rebuild: false
  });
  let replacedDirectory;
  let backupDirectory;
  await assert.rejects(rebuildDerivedEvidence(cwd, {
    onEvidenceRetirementPhase: async (phase, { directory }) => {
      if (phase !== 'validated' || replacedDirectory) return;
      replacedDirectory = directory;
      backupDirectory = path.join(cwd, '.git', 'product-gate-evidence', 'retirement-race-backup');
      await rename(directory, backupDirectory);
      await mkdir(directory);
      await writeFile(path.join(directory, 'valuable.txt'), 'must remain\n');
    }
  }), /changed during archival/);
  assert.equal(await readFile(path.join(replacedDirectory, 'valuable.txt'), 'utf8'), 'must remain\n');
  await rm(replacedDirectory, { recursive: true, force: true });
  await rename(backupDirectory, replacedDirectory);
  await rebuildDerivedEvidence(cwd);
});

test('receipt directories are bound to event identity and duplicate copies are rejected', async () => {
  const cwd = await fixture();
  const recorded = await recordEvidence({
    repoRoot: cwd, sourceId: 'product.gates.receipt-identity', context: 'free-development',
    status: 'passed', executionMode: 'manual', sourceArtifacts: 'identity check'
  });
  const copied = path.join(receiptFiles(cwd), 'copied-valid-receipt');
  await mkdir(copied);
  await writeFile(path.join(copied, 'receipt.json'), await readFile(recorded.path));
  await assert.rejects(evidenceStatus(cwd), /directory identity is inconsistent/);
});

test('the evidence lock timeout is owned by verification policy', async () => {
  const cwd = await fixture();
  await updateEvidencePolicy(cwd, (policy) => {
    policy.evidence_policy.store_limits.lock_timeout_ms = 80;
    policy.evidence_policy.store_limits.stale_lock_ms = 160;
  });
  const lock = path.join(cwd, '.git', 'product-gate-evidence', '.index.lock');
  await mkdir(lock, { recursive: true });
  await writeFile(path.join(lock, 'owner.json'), `${JSON.stringify({
    pid: process.pid,
    nonce: 'policy-timeout-live-owner',
    created_at: new Date().toISOString()
  })}\n`);
  const started = Date.now();
  await assert.rejects(rebuildDerivedEvidence(cwd), /Timed out waiting for product gate evidence index lock/);
  assert.ok(Date.now() - started < 500);
  await rm(lock, { recursive: true, force: true });
});

test('an old lock owned by a live process is never broken by age alone', async () => {
  const cwd = await fixture();
  const lock = path.join(cwd, '.git', 'product-gate-evidence', '.index.lock');
  await mkdir(lock, { recursive: true });
  await writeFile(path.join(lock, 'owner.json'), `${JSON.stringify({
    pid: process.pid,
    nonce: 'live-owner',
    created_at: '2000-01-01T00:00:00.000Z'
  })}\n`, 'utf8');
  await assert.rejects(
    rebuildDerivedEvidence(cwd, { timeoutMs: 100, staleMs: 1 }),
    /Timed out waiting for product gate evidence index lock/
  );
  assert.equal(JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8')).nonce, 'live-owner');
  await rm(lock, { recursive: true, force: true });
});

test('orphan temporary files are ignored and a corrupt derived index is rebuilt from receipts', async () => {
  const cwd = await fixture();
  await recordEvidence({
    repoRoot: cwd,
    sourceId: 'product.gates.rebuild',
    context: 'free-development',
    status: 'passed',
    executionMode: 'manual',
    sourceArtifacts: 'rebuild check'
  });
  await writeFile(path.join(receiptFiles(cwd), 'orphan.tmp'), '{broken', 'utf8');
  await writeFile(path.join(cwd, '.git', 'product-gate-evidence', 'index.tsv'), 'corrupt\n', 'utf8');
  await rebuildDerivedEvidence(cwd);
  const index = await readFile(path.join(cwd, '.git', 'product-gate-evidence', 'index.tsv'), 'utf8');
  assert.match(index, /product\.gates\.rebuild/);
  assert.equal((await evidenceStatus(cwd)).rows.some((row) => row.source_id === 'product.gates.rebuild'), true);
});

test('receipt readers reject forbidden raw output fields instead of trusting a derived index', async () => {
  const cwd = await fixture();
  const recorded = await recordEvidence({
    repoRoot: cwd,
    sourceId: 'product.gates.tampered',
    context: 'free-development',
    status: 'passed',
    executionMode: 'manual',
    sourceArtifacts: 'tamper check'
  });
  const receipt = JSON.parse(await readFile(recorded.path, 'utf8'));
  receipt.stdout = 'raw output must never be evidence';
  await writeFile(recorded.path, `${JSON.stringify(receipt)}\n`, 'utf8');
  await assert.rejects(evidenceStatus(cwd), /forbidden or unknown fields: stdout/);

  const receiptDirectories = (await readdir(receiptFiles(cwd), { withFileTypes: true })).filter((entry) => entry.isDirectory());
  assert.equal(receiptDirectories.length, 1);
});

test('receipt readers reject every modified authority or projection field', async () => {
  const mutations = [
    (receipt) => { receipt.required_in_context = false; },
    (receipt) => { receipt.max_age_seconds = 999999; },
    (receipt) => { receipt.worktree_state = 'dirty'; },
    (receipt) => { receipt.execution_mode = 'git-observation'; },
    (receipt) => { receipt.safe_summary = 'altered summary'; },
    (receipt) => { receipt.blocked_by = 'product.gates.integrity'; }
  ];
  for (const [index, mutate] of mutations.entries()) {
    const cwd = await fixture();
    const recorded = await recordEvidence({
      repoRoot: cwd,
      sourceId: `product.gates.integrity-${index}`,
      context: 'free-development',
      status: 'passed',
      authority: 'authoritative',
      executionMode: 'executed',
      argv: ['true'],
      sourceArtifacts: 'integrity check'
    });
    const receipt = JSON.parse(await readFile(recorded.path, 'utf8'));
    mutate(receipt);
    await writeFile(recorded.path, `${JSON.stringify(receipt)}\n`, 'utf8');
    await assert.rejects(evidenceStatus(cwd), /result_digest integrity check failed/);
  }
});

test('evidence writes reject a symlinked evidence root before creating receipt data', async () => {
  const cwd = await fixture();
  const outside = await mkdtemp(path.join(tmpdir(), 'product-gate-evidence-outside-'));
  await symlink(outside, path.join(cwd, '.git', 'product-gate-evidence'));
  await assert.rejects(recordEvidence({
    repoRoot: cwd,
    sourceId: 'product.gates.symlink',
    context: 'free-development',
    status: 'passed',
    executionMode: 'manual',
    sourceArtifacts: 'symlink check'
  }), /directory is unsafe/);
  assert.deepEqual(await readdir(outside), []);
  await rm(outside, { recursive: true, force: true });
});

test('derived detail projection rejects a symlinked details directory', async () => {
  const cwd = await fixture();
  const outside = await mkdtemp(path.join(tmpdir(), 'product-gate-details-outside-'));
  const root = path.join(cwd, '.git', 'product-gate-evidence');
  await mkdir(root, { recursive: true });
  await symlink(outside, path.join(root, 'details'));
  await assert.rejects(recordEvidence({
    repoRoot: cwd,
    sourceId: 'product.gates.detail-symlink',
    context: 'free-development',
    status: 'passed',
    executionMode: 'manual',
    sourceArtifacts: 'detail symlink check'
  }), /directory is unsafe/);
  assert.deepEqual(await readdir(outside), []);
  await rm(outside, { recursive: true, force: true });
});

test('evidence status rejects a detail store replaced by a symlink', async () => {
  const cwd = await fixture();
  await recordEvidence({
    repoRoot: cwd,
    sourceId: 'product.gates.detail-read-symlink',
    context: 'free-development',
    status: 'passed',
    executionMode: 'manual',
    sourceArtifacts: 'detail read symlink check'
  });
  const root = path.join(cwd, '.git', 'product-gate-evidence');
  await rm(path.join(root, 'details'), { recursive: true, force: true });
  const outside = await mkdtemp(path.join(tmpdir(), 'product-gate-detail-read-outside-'));
  await symlink(outside, path.join(root, 'details'));
  await assert.rejects(evidenceStatus(cwd), /detail store is unsafe/);
  assert.deepEqual(await readdir(outside), []);
  await rm(outside, { recursive: true, force: true });
});

test('evidence reads reject symlinked receipt and legacy stores', async () => {
  for (const child of ['receipts-v2', 'legacy']) {
    const cwd = await fixture();
    const outside = await mkdtemp(path.join(tmpdir(), `product-gate-${child}-outside-`));
    const root = path.join(cwd, '.git', 'product-gate-evidence');
    await mkdir(root, { recursive: true });
    await symlink(outside, path.join(root, child));
    await assert.rejects(evidenceStatus(cwd), /unsafe/);
    assert.deepEqual(await readdir(outside), []);
    await rm(outside, { recursive: true, force: true });
  }
});

test('multi-context sources use a context-neutral active detail', async () => {
  const cwd = await fixture();
  for (const context of ['free-development', 'product-improvement']) {
    await recordEvidence({
      repoRoot: cwd,
      sourceId: 'product.gates.multi-context',
      context,
      status: 'passed',
      authority: 'authoritative',
      sourceArtifacts: `${context} check`,
      executionMode: 'executed',
      argv: ['true']
    });
  }
  const result = await evidenceStatus(cwd);
  assert.equal(result.rows.filter((row) => row.source_id === 'product.gates.multi-context').length, 2);
  const detail = JSON.parse(await readFile(path.join(
    cwd, '.git', 'product-gate-evidence', 'details', 'product.gates.multi-context', 'current-v2.json'
  ), 'utf8'));
  assert.equal(detail.context, 'multiple');
  assert.equal(detail.event_id, '');
  assert.doesNotMatch(detail.reason, /free-development|product-improvement/u);
});

test('git-status compatibility records worktree upstream and synchronization evidence', async () => {
  const cwd = await fixture();
  await cli(cwd, ['git-status', 'free-development', '300']);
  const result = await evidenceStatus(cwd);
  assert.equal(result.rows.some((row) => row.source_id === 'product.git.worktree' && row.status === 'passed'), true);
  assert.equal(result.rows.some((row) => row.source_id === 'product.git.upstream' && row.status === 'not_run'), true);
  assert.equal(result.rows.some((row) => row.source_id === 'product.git.local_remote_sync' && row.status === 'not_run'), true);
  assert.equal(result.rows.some((row) => row.source_id === 'product.git.sync' && row.status === 'blocked'), true);
});

test('repository snapshot binds full HEAD tree and untracked content', async () => {
  const cwd = await fixture();
  const clean = await snapshotRepository(cwd);
  assert.match(clean.head_sha, /^[0-9a-f]{40}$/u);
  assert.match(clean.tree_sha, /^[0-9a-f]{40}$/u);
  assert.equal(clean.worktree_state, 'clean');
  await writeFile(path.join(cwd, 'untracked.txt'), 'one\n', 'utf8');
  const first = await snapshotRepository(cwd);
  await writeFile(path.join(cwd, 'untracked.txt'), 'two\n', 'utf8');
  const second = await snapshotRepository(cwd);
  assert.equal(first.worktree_state, 'dirty');
  assert.notEqual(first.input_fingerprint, second.input_fingerprint);
});
