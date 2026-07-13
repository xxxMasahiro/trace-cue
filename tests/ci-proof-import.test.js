import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { githubApiArguments, verifyCiProofImport } from '../tools/lib/ci-proof-import.mjs';
import { buildCiProof, loadVerificationPolicy } from '../tools/lib/verification-orchestration.mjs';
import { snapshotRepository } from '../tools/lib/product-gate-evidence.mjs';
import { extractBoundedZipFiles } from '../tools/lib/safe-zip.mjs';

test('authenticated CI proof import binds repository, run, workflow, artifact, and current clean HEAD', async () => {
  const fixture = await ciFixture();
  const imported = await verifyCiProofImport({
    loadedPolicy: fixture.loaded,
    snapshot: await snapshotRepository(fixture.root),
    runId: fixture.run.id,
    api: fixture.api
  });
  assert.equal(imported.status, 'passed');
  assert.equal(imported.repository, fixture.repository);
  assert.equal(imported.head_sha, fixture.head);
  assert.equal(imported.remote_observation.artifact_id, fixture.artifact.id);
});

test('GitHub API invocation pins the validated remote hostname', () => {
  assert.deepEqual(
    githubApiArguments('repos/example/project/actions/runs/12345', 'github.com'),
    ['api', '--hostname', 'github.com', 'repos/example/project/actions/runs/12345']
  );
  assert.throws(() => githubApiArguments('repos/example/project/actions/runs/12345', 'github.com\n--hostname=other.invalid'), /hostname is invalid/);
  assert.throws(() => githubApiArguments('graphql', 'github.com'), /endpoint is invalid/);
});

test('CI proof import enforces its policy-owned API timeout', async () => {
  const fixture = await ciFixture();
  const policy = structuredClone(fixture.loaded.policy);
  policy.evidence_policy.ci_proof_api_timeout_ms = 50;
  const started = Date.now();
  await assert.rejects(verifyCiProofImport({
    loadedPolicy: { ...fixture.loaded, policy },
    snapshot: await snapshotRepository(fixture.root),
    runId: fixture.run.id,
    api: () => new Promise(() => {})
  }), /request timed out/);
  assert.ok(Date.now() - started < 500);
});

test('CI proof import rejects mismatched runs, expired artifacts, and proof tampering', async (t) => {
  const cases = [
    ['different head', (fixture) => ({ ...fixture.run, head_sha: 'f'.repeat(40) }), null],
    ['different repository', (fixture) => ({ ...fixture.run, repository: { full_name: 'other/project' } }), null],
    ['failed conclusion', (fixture) => ({ ...fixture.run, conclusion: 'failure' }), null],
    ['expired artifact', null, (fixture) => ({ ...fixture.artifact, expired: true })]
  ];
  for (const [name, mutateRun, mutateArtifact] of cases) await t.test(name, async () => {
    const fixture = await ciFixture();
    const api = fixture.apiWith({
      run: mutateRun ? mutateRun(fixture) : fixture.run,
      artifact: mutateArtifact ? mutateArtifact(fixture) : fixture.artifact
    });
    await assert.rejects(verifyCiProofImport({
      loadedPolicy: fixture.loaded,
      snapshot: await snapshotRepository(fixture.root),
      runId: fixture.run.id,
      api
    }), /CI workflow run|artifact identity/);
  });

  await t.test('tampered proof', async () => {
    const fixture = await ciFixture();
    const tampered = { ...fixture.proof, tree_sha: 'f'.repeat(40) };
    const api = fixture.apiWith({ archive: createZip([{ name: 'verification-proof.json', content: JSON.stringify(tampered) }]) });
    await assert.rejects(verifyCiProofImport({
      loadedPolicy: fixture.loaded,
      snapshot: await snapshotRepository(fixture.root),
      runId: fixture.run.id,
      api
    }), /digest is invalid/);
  });
});

test('authoritative evidence writers are not exposed as precomputed-result APIs', async () => {
  const evidence = await import('../tools/lib/product-gate-evidence.mjs');
  assert.equal('recordReleaseEvidenceBatch' in evidence, false);
  assert.equal('recordVerifiedCiProofEvidence' in evidence, false);
  assert.equal(typeof evidence.runReleaseVerificationAndRecord, 'function');
  assert.equal(typeof evidence.importVerifiedCiProofEvidence, 'function');
});

test('bounded ZIP reader rejects traversal, duplicates, links, encryption, corruption, and expansion', () => {
  assert.throws(() => extractBoundedZipFiles(createZip([{ name: '../proof.json', content: '{}' }])), /path is unsafe/);
  assert.throws(() => extractBoundedZipFiles(createZip([
    { name: 'proof.json', content: '{}' },
    { name: 'proof.json', content: '{}' }
  ])), /duplicate entries/);
  assert.throws(() => extractBoundedZipFiles(createZip([
    { name: 'proof.json', content: '{}', unixMode: 0o120777 }
  ])), /regular files/);
  assert.throws(() => extractBoundedZipFiles(createZip([
    { name: 'proof.json', content: '{}', unixMode: 0o010600 }
  ])), /regular files/);
  assert.throws(() => extractBoundedZipFiles(createZip([
    { name: 'proof.json', content: '{}', dosAttributes: 0x10 }
  ])), /regular files/);

  const encrypted = createZip([{ name: 'proof.json', content: '{}' }]);
  const encryptedCentral = centralOffset(encrypted);
  encrypted.writeUInt16LE(encrypted.readUInt16LE(6) | 0x1, 6);
  encrypted.writeUInt16LE(encrypted.readUInt16LE(encryptedCentral + 8) | 0x1, encryptedCentral + 8);
  assert.throws(() => extractBoundedZipFiles(encrypted), /unsafe or unsupported/);

  const badCrc = createZip([{ name: 'proof.json', content: '{}' }]);
  const crcCentral = centralOffset(badCrc);
  badCrc.writeUInt32LE((badCrc.readUInt32LE(crcCentral + 16) ^ 0xffffffff) >>> 0, crcCentral + 16);
  assert.throws(() => extractBoundedZipFiles(badCrc), /checksum is invalid/);

  const malformedLocalHeader = createZip([{ name: 'proof.json', content: '{}' }]);
  malformedLocalHeader.writeUInt32LE(0, 0);
  assert.throws(() => extractBoundedZipFiles(malformedLocalHeader), /local header is invalid/);

  const expanded = createZip(Array.from({ length: 3 }, (_, index) => ({
    name: `proof-${index}.json`,
    content: 'x'.repeat(800 * 1024)
  })));
  assert.throws(() => extractBoundedZipFiles(expanded), /expanded size exceeds/);
});

test('CI proof import rejects an unexpected archive file set', async () => {
  const fixture = await ciFixture();
  const api = fixture.apiWith({ archive: createZip([{ name: 'other.json', content: JSON.stringify(fixture.proof) }]) });
  await assert.rejects(verifyCiProofImport({
    loadedPolicy: fixture.loaded,
    snapshot: await snapshotRepository(fixture.root),
    runId: fixture.run.id,
    api
  }), /unexpected file set/);
});

async function ciFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'ci-proof-import-'));
  await mkdir(path.join(root, 'ops'), { recursive: true });
  await writeFile(path.join(root, 'tracked.txt'), 'fixture\n', 'utf8');
  const policy = minimalPolicy();
  await writeFile(path.join(root, 'ops', 'VERIFICATION_EXECUTION_POLICY.json'), `${JSON.stringify(policy, null, 2)}\n`, 'utf8');
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Fixture');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  git(root, 'remote', 'add', 'origin', 'https://github.com/example/project.git');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture');
  const loaded = await loadVerificationPolicy({ root });
  const head = git(root, 'rev-parse', 'HEAD');
  const repository = 'example/project';
  const proof = buildCiProof({
    loadedPolicy: loaded,
    ownerResults: { owner: 'success' },
    runId: '12345',
    runAttempt: 2,
    headSha: head,
    sourceJob: 'final'
  });
  const run = {
    id: 12345,
    run_attempt: 2,
    status: 'completed',
    conclusion: 'success',
    head_sha: head,
    path: '.github/workflows/ci.yml',
    repository: { full_name: repository }
  };
  const artifact = {
    id: 67890,
    name: 'verification-proof-12345-2',
    expired: false,
    size_in_bytes: 1024,
    workflow_run: { id: 12345 }
  };
  const archive = createZip([{ name: 'verification-proof.json', content: JSON.stringify(proof) }]);
  const apiWith = ({ run: selectedRun = run, artifact: selectedArtifact = artifact, archive: selectedArchive = archive } = {}) => async (endpoint, options = {}) => {
    assert.equal(options.hostname, 'github.com');
    if (endpoint === `repos/${repository}/actions/runs/${run.id}`) return JSON.stringify(selectedRun);
    if (endpoint === `repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`) return JSON.stringify({ artifacts: [selectedArtifact] });
    if (endpoint === `repos/${repository}/actions/artifacts/${artifact.id}/zip` && options.binary) return selectedArchive;
    throw new Error(`Unexpected mock endpoint: ${endpoint}`);
  };
  return { root, loaded, head, repository, proof, run, artifact, archive, apiWith, api: apiWith() };
}

function minimalPolicy() {
  const task = { id: 'check', label: 'Check', argv: ['node', '-e', 'process.exit(0)'], kind: 'parallel', locks: [], depends_on: [], provides: ['product.gates.tests'] };
  return {
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
    tasks: [task],
    profiles: { release: ['check'], focused: [] },
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
}

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function createZip(entries) {
  const localRecords = [];
  const centralRecords = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const content = Buffer.from(entry.content, 'utf8');
    const crc = crc32(content);
    const local = Buffer.alloc(30 + name.length + content.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    content.copy(local, 30 + name.length);
    localRecords.push(local);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((((entry.unixMode ?? 0o100600) * 0x10000) >>> 0) | (entry.dosAttributes ?? 0)) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralRecords.push(central);
    offset += local.length;
  }
  const central = Buffer.concat(centralRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localRecords, central, end]);
}

function centralOffset(archive) {
  const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  const offset = archive.indexOf(signature);
  if (offset < 0) throw new Error('Fixture central directory is missing.');
  return offset;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
