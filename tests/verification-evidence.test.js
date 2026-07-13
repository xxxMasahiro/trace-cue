import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computePolicyFingerprint,
  evidenceStatus,
  rebuildDerivedEvidence,
  recordEvidence,
  snapshotRepository
} from '../tools/lib/product-gate-evidence.mjs';

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
  await writeFile(path.join(cwd, 'ops', 'VERIFICATION_EXECUTION_POLICY.json'), '{"schema_version":"1.0.0"}\n', 'utf8');
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

function evidenceRequirementRow(sourceId, requiredMode = 'required', contexts = 'all') {
  return [
    sourceId, requiredMode, contexts, 'local_tests', '#workflow', 'label', `${sourceId}.detail`, 'all',
    'Checked contract.', 'Required for current readiness.', 'Passed.', 'Failed.', 'Not run.', 'Stale.',
    'next_action', 'high', 'false', '10'
  ].join('\t');
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
