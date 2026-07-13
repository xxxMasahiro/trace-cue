import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  PACKAGE_ARTIFACT_MANIFEST_NAME,
  cleanupPackageArtifactWorkspace,
  createPackageArtifactManifest,
  createPackageToolchainIdentity,
  createPackageArtifactWorkspace,
  inspectPackageTarball,
  materializePackageSubtree,
  packageArtifactManifestDigest,
  readPackageRepositoryState,
  resolvePackageRunIdentity,
  runBoundedCommandToFile,
  validatePackageArtifactManifest,
  verifyPackageArtifact,
  writePackageArtifactManifest
} from '../tools/lib/package-artifact.mjs';

const commandIdentity = Object.freeze([
  'npm', 'pack', '--json', '--pack-destination', '<artifact-directory>', '--cache', '<run-isolated-cache>', '--ignore-scripts'
]);
const run = Object.freeze({ run_id: 'fixture-run', run_attempt: 2, job_id: 'package-producer' });
const producerToolchain = createPackageToolchainIdentity({ nodeVersion: 'v20.19.0', npmVersion: '10.8.2' });
const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

test('package tools use isolated workspaces, finally cleanup, and direct argv spawning', async () => {
  const [dryRun, installSmoke, library] = await Promise.all([
    readFile(path.join(repoRoot, 'tools', 'pack-dry-run.mjs'), 'utf8'),
    readFile(path.join(repoRoot, 'tools', 'pack-install-smoke.mjs'), 'utf8'),
    readFile(path.join(repoRoot, 'tools', 'lib', 'package-artifact.mjs'), 'utf8')
  ]);
  for (const source of [dryRun, installSmoke]) {
    assert.match(source, /createPackageArtifactWorkspace/u);
    assert.match(source, /finally\s*\{/u);
    assert.match(source, /cleanupPackageArtifactWorkspace/u);
    assert.match(source, /runBoundedCommandToFile/u);
  }
  assert.match(library, /spawn\(command, args, \{/u);
  assert.match(library, /shell:\s*false/u);
  assert.match(installSmoke, /mode === 'produce'/u);
  assert.match(installSmoke, /mode === 'consume'/u);
  assert.match(installSmoke, /--artifact-dir/u);
  assert.match(installSmoke, /--manifest-digest/u);
  assert.match(installSmoke, /--producer-toolchain-digest/u);
  const consumerSource = installSmoke.slice(
    installSmoke.indexOf('async function consumePackageArtifact'),
    installSmoke.indexOf('function producerOutput')
  );
  assert.doesNotMatch(consumerSource, /npm[^\n]*pack|runCapture\('npm'/u);
  assert.doesNotMatch(`${dryRun}\n${installSmoke}\n${library}`, /shell:\s*true|execSync|spawnSync|execFileSync/u);
});

test('package artifact workspace is unique and cleanup stays run-isolated', async () => {
  const first = await createPackageArtifactWorkspace('package-artifact-test-');
  const second = await createPackageArtifactWorkspace('package-artifact-test-');
  assert.notEqual(first.root, second.root);
  assert.notEqual(first.cacheDir, second.cacheDir);
  await Promise.all([
    writeFile(path.join(first.artifactDir, 'first.txt'), 'first'),
    writeFile(path.join(second.artifactDir, 'second.txt'), 'second')
  ]);
  await cleanupPackageArtifactWorkspace(first);
  await assert.rejects(access(first.root));
  await access(second.root);
  await cleanupPackageArtifactWorkspace(second);
  await assert.rejects(access(second.root));

  const unmarked = await mkdtemp(path.join(tmpdir(), 'package-artifact-unmarked-'));
  await assert.rejects(
    cleanupPackageArtifactWorkspace({ root: unmarked }),
    /unmarked/u
  );
  await rm(unmarked, { recursive: true, force: true });
});

test('bounded command output stops the producer as soon as the file limit is exceeded', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'package-bounded-command-'));
  try {
    const accepted = path.join(directory, 'accepted.json');
    const body = await runBoundedCommandToFile({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("ok")'],
      cwd: repoRoot,
      outputPath: accepted,
      maxBytes: 8
    });
    assert.equal(body, 'ok');

    const rejected = path.join(directory, 'rejected.json');
    await assert.rejects(
      runBoundedCommandToFile({
        command: process.execPath,
        args: ['-e', 'process.stdout.write("x".repeat(4096))'],
        cwd: repoRoot,
        outputPath: rejected,
        maxBytes: 128
      }),
      /oversized output/u
    );
    assert.ok((await readFile(rejected)).length <= 128);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('bounded command output applies one limit to stdout and stderr', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'package-bounded-stderr-'));
  try {
    await assert.rejects(runBoundedCommandToFile({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("ok"); process.stderr.write("x".repeat(4096));'],
      cwd: repoRoot,
      outputPath: path.join(directory, 'stderr.json'),
      maxBytes: 128
    }), /oversized output/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('bounded command cancellation terminates its isolated process group', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'package-bounded-cancel-'));
  try {
    const pidFile = path.join(directory, 'child.pid');
    const outputPath = path.join(directory, 'cancelled.json');
    const controller = new AbortController();
    const running = runBoundedCommandToFile({
      command: process.execPath,
      args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`],
      cwd: repoRoot,
      outputPath,
      maxBytes: 128,
      timeoutMs: 5_000,
      signal: controller.signal
    });
    let childPid;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        childPid = Number.parseInt(await readFile(pidFile, 'utf8'), 10);
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert.ok(Number.isSafeInteger(childPid) && childPid > 0);
    controller.abort();
    await assert.rejects(running, /cancelled/u);
    assert.throws(() => process.kill(childPid, 0), (error) => error?.code === 'ESRCH');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('bounded command timeout terminates the producer', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'package-bounded-timeout-'));
  try {
    await assert.rejects(runBoundedCommandToFile({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: repoRoot,
      outputPath: path.join(directory, 'timeout.json'),
      maxBytes: 128,
      timeoutMs: 50
    }), /timed out/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('run identity uses explicit same-run metadata and rejects malformed attempts', () => {
  assert.deepEqual(resolvePackageRunIdentity({
    PACKAGE_ARTIFACT_RUN_ID: 'run-42',
    PACKAGE_ARTIFACT_RUN_ATTEMPT: '3',
    PACKAGE_ARTIFACT_JOB_ID: 'pack-owner'
  }), { run_id: 'run-42', run_attempt: 3, job_id: 'pack-owner' });
  assert.throws(() => resolvePackageRunIdentity({ PACKAGE_ARTIFACT_RUN_ATTEMPT: '0' }), /positive integer/u);
  assert.throws(() => resolvePackageRunIdentity({ PACKAGE_ARTIFACT_RUN_ATTEMPT: '1x' }), /positive integer/u);
});

test('package repository state binds untracked file content, not only its name', async () => {
  const repository = await createGitRepository();
  try {
    const extra = path.join(repository, 'extra.txt');
    await writeFile(extra, 'one\n');
    const first = await readPackageRepositoryState(repository);
    await writeFile(extra, 'two\n');
    const second = await readPackageRepositoryState(repository);
    assert.notEqual(second.input_digest, first.input_digest);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test('package repository state hashes an untracked symlink target without following it', async () => {
  const repository = await createGitRepository();
  try {
    const link = path.join(repository, 'untracked-link');
    await symlink('first-local-target', link);
    const first = await readPackageRepositoryState(repository);
    await rm(link);
    await symlink('second-local-target', link);
    const second = await readPackageRepositoryState(repository);
    assert.notEqual(first.input_digest, second.input_digest);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test('producer manifest binds repository, run, policy, command, tarball, and file list', async () => {
  const fixture = await createFixture();
  try {
    const verified = await verifyPackageArtifact({
      artifactRoot: fixture.workspace.artifactDir,
      manifestPath: fixture.manifestPath,
      repoRoot: fixture.repoRoot,
      expectedRun: { ...run, job_id: 'package-consumer' },
      expectedProducerJobId: run.job_id,
      expectedCommandIdentity: commandIdentity,
      expectedPackage: { name: 'fixture-package', version: '1.2.3' },
      expectedProducerToolchainDigest: producerToolchain.toolchain_digest,
      expectedManifestDigest: fixture.manifest.manifest_digest
    });
    assert.equal(verified.tarballPath, fixture.tarballPath);
    assert.match(verified.manifest.producer.head_sha, /^[a-f0-9]{40,64}$/u);
    assert.match(verified.manifest.producer.tree_sha, /^[a-f0-9]{40,64}$/u);
    assert.match(verified.manifest.producer.input_digest, /^[a-f0-9]{64}$/u);
    assert.match(verified.manifest.producer.policy_digest, /^[a-f0-9]{64}$/u);
    assert.match(verified.manifest.producer.command_digest, /^[a-f0-9]{64}$/u);
    assert.equal(verified.manifest.producer.node_version, producerToolchain.node_version);
    assert.equal(verified.manifest.producer.npm_version, producerToolchain.npm_version);
    assert.match(verified.manifest.producer.toolchain_digest, /^[a-f0-9]{64}$/u);
    assert.equal(verified.manifest.artifact.package_name, 'fixture-package');
    assert.equal(verified.manifest.artifact.package_version, '1.2.3');
    assert.match(verified.manifest.artifact.sha256, /^[a-f0-9]{64}$/u);
    assert.match(verified.manifest.artifact.file_list_digest, /^[a-f0-9]{64}$/u);
    assert.equal(verified.manifest.artifact.file_count, 1);
    assert.equal(verified.manifest.artifact.size_bytes > 0, true);
  } finally {
    await fixture.cleanup();
  }
});

test('consumer rejects any file outside the exact package transport set', async () => {
  const fixture = await createFixture();
  try {
    await writeFile(path.join(fixture.workspace.artifactDir, 'unexpected.txt'), 'not part of the transport\n');
    await assert.rejects(verifyPackageArtifact({
      artifactRoot: fixture.workspace.artifactDir,
      manifestPath: fixture.manifestPath
    }), /unexpected file set/u);
  } finally {
    await fixture.cleanup();
  }
});

test('verified package subtree materialization writes only bounded regular files and refuses replacement', async () => {
  const workspace = await createPackageArtifactWorkspace('package-materialize-');
  const destinationRoot = await mkdtemp(path.join(tmpdir(), 'package-materialize-output-'));
  try {
    const tarballPath = path.join(workspace.artifactDir, 'ui.tgz');
    await writeFile(tarballPath, createTarball([
      { name: 'package/dist/control-center/index.html', type: '0', content: '<!doctype html>\n' },
      { name: 'package/dist/control-center/assets/app.js', type: '0', content: 'export default true;\n' },
      { name: 'package/dist/control-center/assets/app.css', type: '0', content: 'body {}\n' },
      { name: 'package/src/private.js', type: '0', content: 'not materialized\n' }
    ]));
    const expectedTarballSha256 = (await inspectPackageTarball(tarballPath)).sha256;
    const result = await materializePackageSubtree({
      tarballPath,
      expectedTarballSha256,
      archiveSubtree: 'dist/control-center',
      destinationRoot,
      destinationPath: 'dist/control-center',
      requiredFiles: ['index.html']
    });
    assert.equal(result.file_count, 3);
    assert.match(await readFile(path.join(destinationRoot, 'dist', 'control-center', 'index.html'), 'utf8'), /doctype/u);
    assert.equal(await readFile(path.join(destinationRoot, 'dist', 'control-center', 'assets', 'app.js'), 'utf8'), 'export default true;\n');
    await assert.rejects(access(path.join(destinationRoot, 'src', 'private.js')));
    await assert.rejects(materializePackageSubtree({
      tarballPath,
      expectedTarballSha256,
      archiveSubtree: 'dist/control-center',
      destinationRoot,
      destinationPath: 'dist/control-center',
      requiredFiles: ['index.html']
    }), /already exists/);

    await writeFile(tarballPath, createTarball([
      { name: 'package/dist/control-center/index.html', type: '0', content: '<!doctype html><p>replaced</p>\n' }
    ]));
    await assert.rejects(materializePackageSubtree({
      tarballPath,
      expectedTarballSha256,
      archiveSubtree: 'dist/control-center',
      destinationRoot,
      destinationPath: 'dist/replaced-control-center',
      requiredFiles: ['index.html']
    }), /changed after verification/);
  } finally {
    await cleanupPackageArtifactWorkspace(workspace);
    await rm(destinationRoot, { recursive: true, force: true });
  }
});

test('consumer rejects manifest tampering, wrong run, wrong command, and unknown fields', async () => {
  const fixture = await createFixture();
  try {
    const tampered = structuredClone(fixture.manifest);
    tampered.producer.job_id = 'different-job';
    await writeFile(fixture.manifestPath, JSON.stringify(tampered));
    await assert.rejects(
      verifyPackageArtifact({
        artifactRoot: fixture.workspace.artifactDir,
        manifestPath: fixture.manifestPath,
        expectedManifestDigest: fixture.manifest.manifest_digest
      }),
      /digest|modified/u
    );

    await writeFile(fixture.manifestPath, JSON.stringify(fixture.manifest));
    await assert.rejects(
      verifyPackageArtifact({
        artifactRoot: fixture.workspace.artifactDir,
        manifestPath: fixture.manifestPath,
        expectedRun: { ...run, run_id: 'other-run' }
      }),
      /expected workflow run/u
    );
    await assert.rejects(
      verifyPackageArtifact({
        artifactRoot: fixture.workspace.artifactDir,
        manifestPath: fixture.manifestPath,
        expectedCommandIdentity: ['npm', 'pack', '--different']
      }),
      /command digest/u
    );
    await assert.rejects(
      verifyPackageArtifact({
        artifactRoot: fixture.workspace.artifactDir,
        manifestPath: fixture.manifestPath,
        expectedProducerToolchainDigest: '0'.repeat(64)
      }),
      /toolchain digest/u
    );
    await assert.rejects(
      verifyPackageArtifact({
        artifactRoot: fixture.workspace.artifactDir,
        manifestPath: fixture.manifestPath,
        expectedPackage: { name: 'different-package', version: '1.2.3' }
      }),
      /package identity/u
    );
    const invalidToolchain = structuredClone(fixture.manifest);
    invalidToolchain.producer.npm_version = '99.0.0';
    invalidToolchain.manifest_digest = packageArtifactManifestDigest(invalidToolchain);
    assert.throws(() => validatePackageArtifactManifest(invalidToolchain), /toolchain digest/u);
    assert.throws(
      () => validatePackageArtifactManifest({ ...fixture.manifest, unexpected: true }),
      /fields are invalid/u
    );
  } finally {
    await fixture.cleanup();
  }
});

test('consumer rejects traversal and filesystem symlinks even with valid manifest JSON', async () => {
  const fixture = await createFixture();
  try {
    const traversal = structuredClone(fixture.manifest);
    traversal.artifact.filename = '../outside.tgz';
    traversal.manifest_digest = packageArtifactManifestDigest(traversal);
    await writeFile(fixture.manifestPath, JSON.stringify(traversal));
    await assert.rejects(
      verifyPackageArtifact({ artifactRoot: fixture.workspace.artifactDir, manifestPath: fixture.manifestPath }),
      /filename|unsafe|escapes/u
    );

    await writeFile(fixture.manifestPath, JSON.stringify(fixture.manifest));
    const manifestLink = path.join(fixture.workspace.artifactDir, 'manifest-link.json');
    await symlink(fixture.manifestPath, manifestLink);
    await assert.rejects(
      verifyPackageArtifact({ artifactRoot: fixture.workspace.artifactDir, manifestPath: manifestLink }),
      /non-symlink/u
    );

    const outsideTarball = path.join(fixture.workspace.root, 'outside.tgz');
    await rename(fixture.tarballPath, outsideTarball);
    await symlink(outsideTarball, fixture.tarballPath);
    await assert.rejects(
      verifyPackageArtifact({ artifactRoot: fixture.workspace.artifactDir, manifestPath: fixture.manifestPath }),
      /non-symlink/u
    );
  } finally {
    await fixture.cleanup();
  }
});

test('producer rejects traversal and symlink entries inside package tarballs', async () => {
  const repoRoot = await createGitRepository();
  const workspace = await createPackageArtifactWorkspace('package-artifact-unsafe-');
  try {
    const traversalTarball = path.join(workspace.artifactDir, 'traversal.tgz');
    await writeFile(traversalTarball, createTarball([{ name: 'package/../escape.js', type: '0', content: 'escape' }]));
    await assert.rejects(
      createPackageArtifactManifest({
        repoRoot, tarballPath: traversalTarball, run, commandIdentity,
        packageName: 'fixture-package', packageVersion: '1.2.3', toolchain: producerToolchain
      }),
      /escapes|unsafe/u
    );

    const symlinkTarball = path.join(workspace.artifactDir, 'symlink.tgz');
    await writeFile(symlinkTarball, createTarball([{ name: 'package/link.js', type: '2', linkName: 'target.js' }]));
    await assert.rejects(
      createPackageArtifactManifest({
        repoRoot, tarballPath: symlinkTarball, run, commandIdentity,
        packageName: 'fixture-package', packageVersion: '1.2.3', toolchain: producerToolchain
      }),
      /unsupported entry type/u
    );
  } finally {
    await cleanupPackageArtifactWorkspace(workspace);
    await rm(repoRoot, { recursive: true, force: true });
  }
});

async function createFixture() {
  const repoRoot = await createGitRepository();
  const workspace = await createPackageArtifactWorkspace('package-artifact-fixture-');
  try {
    const tarballPath = path.join(workspace.artifactDir, 'fixture.tgz');
    await writeFile(tarballPath, createTarball([{ name: 'package/index.js', type: '0', content: 'export default true;\n' }]));
    const manifest = await createPackageArtifactManifest({
      repoRoot,
      tarballPath,
      run,
      commandIdentity,
      packageName: 'fixture-package',
      packageVersion: '1.2.3',
      toolchain: producerToolchain
    });
    const manifestPath = path.join(workspace.artifactDir, PACKAGE_ARTIFACT_MANIFEST_NAME);
    await writePackageArtifactManifest({ artifactRoot: workspace.artifactDir, manifestPath, manifest });
    return {
      repoRoot,
      workspace,
      tarballPath,
      manifest,
      manifestPath,
      async cleanup() {
        await cleanupPackageArtifactWorkspace(workspace);
        await rm(repoRoot, { recursive: true, force: true });
      }
    };
  } catch (error) {
    await cleanupPackageArtifactWorkspace(workspace);
    await rm(repoRoot, { recursive: true, force: true });
    throw error;
  }
}

async function createGitRepository() {
  const root = await mkdtemp(path.join(tmpdir(), 'package-artifact-repo-'));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
  await writeFile(path.join(root, 'src', 'index.js'), 'export default true;\n');
  runGit(root, ['init', '-q']);
  runGit(root, ['config', 'user.name', 'Package Artifact Test']);
  runGit(root, ['config', 'user.email', 'package-artifact@example.invalid']);
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '-q', '-m', 'fixture']);
  return root;
}

function runGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, shell: false, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function createTarball(entries) {
  const blocks = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? '', 'utf8');
    const header = Buffer.alloc(512);
    writeTarText(header, 0, 100, entry.name);
    writeTarOctal(header, 100, 8, entry.type === '5' ? 0o755 : 0o644);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, content.length);
    writeTarOctal(header, 136, 12, 0);
    header.fill(32, 148, 156);
    header[156] = (entry.type ?? '0').charCodeAt(0);
    if (entry.linkName) writeTarText(header, 157, 100, entry.linkName);
    writeTarText(header, 257, 6, 'ustar');
    writeTarText(header, 263, 2, '00');
    let checksum = 0;
    for (const byte of header) checksum += byte;
    const checksumText = `${checksum.toString(8).padStart(6, '0')}\0 `;
    header.write(checksumText, 148, 8, 'ascii');
    blocks.push(header);
    if (content.length) {
      blocks.push(content, Buffer.alloc((512 - (content.length % 512)) % 512));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function writeTarText(header, offset, length, value) {
  const bytes = Buffer.from(value, 'utf8');
  assert.ok(bytes.length <= length);
  bytes.copy(header, offset);
}

function writeTarOctal(header, offset, length, value) {
  const text = `${value.toString(8).padStart(length - 1, '0')}\0`;
  header.write(text, offset, length, 'ascii');
}
