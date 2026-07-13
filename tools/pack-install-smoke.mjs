#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { access, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCT_IDENTITY, packageTarballFilename } from '../src/product-identity.js';
import {
  PACKAGE_ARTIFACT_MANIFEST_NAME,
  cleanupPackageArtifactWorkspace,
  createPackageArtifactManifest,
  createPackageArtifactWorkspace,
  materializePackageSubtree,
  readPackageToolchainIdentity,
  resolvePackageRunIdentity,
  runBoundedCommandToFile,
  verifyPackageArtifact,
  writePackageArtifactManifest
} from './lib/package-artifact.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const packCommandIdentity = Object.freeze([
  'npm',
  'pack',
  '--json',
  '--pack-destination',
  '<artifact-directory>',
  '--cache',
  '<run-isolated-cache>',
  '--ignore-scripts'
]);
const MAX_NPM_PACK_OUTPUT_BYTES = 8 * 1024 * 1024;

await main(parseArgs(process.argv.slice(2)));

async function main(options) {
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  if (packageJson.name !== PRODUCT_IDENTITY.packageName || packageJson.version !== PRODUCT_IDENTITY.packageVersion) {
    throw new Error('package.json name/version does not match PRODUCT_IDENTITY.');
  }
  const run = runIdentityFromOptions(options);
  if (options.mode === 'produce') {
    const toolchain = await readPackageToolchainIdentity();
    const artifactDir = await ensureArtifactDirectory(options.artifactDir);
    const workspace = await createPackageArtifactWorkspace(`${PRODUCT_IDENTITY.packSmokeDirectoryName}-producer-`);
    try {
      const produced = await producePackageArtifact({
        artifactDir,
        cacheDir: workspace.cacheDir,
        packOutputPath: path.join(workspace.root, 'npm-pack.json'),
        run,
        toolchain
      });
      process.stdout.write(`${JSON.stringify(producerOutput(produced), null, 2)}\n`);
    } finally {
      await cleanupPackageArtifactWorkspace(workspace);
    }
    return;
  }
  if (options.mode === 'consume') {
    if (!options.manifestDigest) throw new Error('consume requires --manifest-digest from the producer output.');
    if (!options.producerToolchainDigest) throw new Error('consume requires --producer-toolchain-digest.');
    if (!options.producerJobId) throw new Error('consume requires --producer-job-id.');
    const artifactDir = await ensureArtifactDirectory(options.artifactDir);
    const manifestPath = path.resolve(options.manifestPath ?? path.join(artifactDir, PACKAGE_ARTIFACT_MANIFEST_NAME));
    const verified = await consumePackageArtifact({
      artifactDir,
      manifestPath,
      manifestDigest: options.manifestDigest,
      run,
      producerJobId: options.producerJobId,
      producerToolchainDigest: options.producerToolchainDigest
    });
    process.stdout.write(`${JSON.stringify({
      schema_version: '1.0.0',
      kind: 'package-artifact-consumer-output',
      status: 'passed',
      run_id: run.run_id,
      run_attempt: run.run_attempt,
      producer_job_id: options.producerJobId,
      manifest_digest: verified.manifest.manifest_digest
    }, null, 2)}\n`);
    return;
  }
  if (options.mode === 'materialize') {
    requireConsumerOptions(options, 'materialize');
    if (!options.archiveSubtree || !options.destination) {
      throw new Error('materialize requires --archive-subtree and --destination.');
    }
    const artifactDir = await ensureArtifactDirectory(options.artifactDir);
    const manifestPath = path.resolve(options.manifestPath ?? path.join(artifactDir, PACKAGE_ARTIFACT_MANIFEST_NAME));
    const verified = await verifyDownloadedPackageArtifact({
      artifactDir,
      manifestPath,
      manifestDigest: options.manifestDigest,
      run,
      producerJobId: options.producerJobId,
      producerToolchainDigest: options.producerToolchainDigest
    });
    const materialized = await materializePackageSubtree({
      tarballPath: verified.tarballPath,
      expectedTarballSha256: verified.manifest.artifact.sha256,
      archiveSubtree: options.archiveSubtree,
      destinationRoot: repoRoot,
      destinationPath: options.destination,
      requiredFiles: options.requiredFiles
    });
    process.stdout.write(`${JSON.stringify({
      schema_version: '1.0.0',
      kind: 'package-artifact-materialization-output',
      status: 'passed',
      run_id: run.run_id,
      run_attempt: run.run_attempt,
      producer_job_id: options.producerJobId,
      manifest_digest: verified.manifest.manifest_digest,
      file_count: materialized.file_count,
      size_bytes: materialized.size_bytes,
      subtree_digest: materialized.subtree_digest
    }, null, 2)}\n`);
    return;
  }

  const toolchain = await readPackageToolchainIdentity();
  const workspace = await createPackageArtifactWorkspace(`${PRODUCT_IDENTITY.packSmokeDirectoryName}-`);
  try {
    const produced = await producePackageArtifact({
      artifactDir: workspace.artifactDir,
      cacheDir: workspace.cacheDir,
      packOutputPath: path.join(workspace.root, 'npm-pack.json'),
      run,
      toolchain
    });
    await consumePackageArtifact({
      artifactDir: workspace.artifactDir,
      manifestPath: produced.manifestPath,
      manifestDigest: produced.manifest.manifest_digest,
      run,
      producerJobId: run.job_id,
      producerToolchainDigest: produced.manifest.producer.toolchain_digest
    });
  } finally {
    await cleanupPackageArtifactWorkspace(workspace);
  }
}

async function producePackageArtifact({ artifactDir, cacheDir, packOutputPath, run, toolchain }) {
  const expectedTarballPath = path.join(artifactDir, packageTarballFilename());
  const manifestPath = path.join(artifactDir, PACKAGE_ARTIFACT_MANIFEST_NAME);
  await Promise.all([
    assertPathAbsent(expectedTarballPath, 'Package tarball'),
    assertPathAbsent(manifestPath, 'Package artifact manifest'),
    assertPathAbsent(packOutputPath, 'npm pack output')
  ]);
  const packOutput = await runBoundedCommandToFile({
    command: 'npm',
    args: [
      'pack',
      '--json',
      '--pack-destination',
      artifactDir,
      '--cache',
      cacheDir,
      '--ignore-scripts'
    ],
    cwd: repoRoot,
    outputPath: packOutputPath,
    maxBytes: MAX_NPM_PACK_OUTPUT_BYTES
  });
  const tarballPath = resolvePackedTarball(packOutput, expectedTarballPath);
  await access(tarballPath);
  const manifest = await createPackageArtifactManifest({
    repoRoot,
    tarballPath,
    filename: packageTarballFilename(),
    packageName: PRODUCT_IDENTITY.packageName,
    packageVersion: PRODUCT_IDENTITY.packageVersion,
    run,
    commandIdentity: packCommandIdentity,
    toolchain
  });
  await writePackageArtifactManifest({ artifactRoot: artifactDir, manifestPath, manifest });
  return { manifest, manifestPath, tarballPath };
}

async function consumePackageArtifact({
  artifactDir,
  manifestPath,
  manifestDigest,
  run,
  producerJobId,
  producerToolchainDigest
}) {
  const verified = await verifyDownloadedPackageArtifact({
    artifactDir,
    manifestPath,
    manifestDigest,
    run,
    producerJobId,
    producerToolchainDigest
  });
  await runInherit(process.execPath, [
    'tests/pack-install-smoke.test.js',
    verified.tarballPath,
    verified.manifest.artifact.sha256
  ]);
  return verified;
}

async function verifyDownloadedPackageArtifact({
  artifactDir,
  manifestPath,
  manifestDigest,
  run,
  producerJobId,
  producerToolchainDigest
}) {
  return verifyPackageArtifact({
    artifactRoot: artifactDir,
    manifestPath,
    repoRoot,
    expectedRun: run,
    expectedProducerJobId: producerJobId,
    expectedCommandIdentity: packCommandIdentity,
    expectedPackage: {
      name: PRODUCT_IDENTITY.packageName,
      version: PRODUCT_IDENTITY.packageVersion
    },
    expectedProducerToolchainDigest: producerToolchainDigest,
    expectedManifestDigest: manifestDigest
  });
}

function producerOutput(produced) {
  return {
    schema_version: '1.0.0',
    kind: 'package-artifact-producer-output',
    manifest_filename: path.basename(produced.manifestPath),
    artifact_filename: path.basename(produced.tarballPath),
    manifest_digest: produced.manifest.manifest_digest,
    run_id: produced.manifest.producer.run_id,
    run_attempt: produced.manifest.producer.run_attempt,
    producer_job_id: produced.manifest.producer.job_id,
    package_name: produced.manifest.artifact.package_name,
    package_version: produced.manifest.artifact.package_version,
    tarball_sha256: produced.manifest.artifact.sha256,
    producer_toolchain_digest: produced.manifest.producer.toolchain_digest
  };
}

function parseArgs(argv) {
  if (argv.length === 0) return { mode: 'local' };
  const mode = argv[0];
  if (!['produce', 'consume', 'materialize'].includes(mode)) throw new Error(`Unsupported package artifact mode: ${mode}`);
  const options = { mode, requiredFiles: [] };
  const fields = new Map([
    ['--artifact-dir', 'artifactDir'],
    ['--manifest', 'manifestPath'],
    ['--manifest-digest', 'manifestDigest'],
    ['--run-id', 'runId'],
    ['--run-attempt', 'runAttempt'],
    ['--job-id', 'jobId'],
    ['--producer-job-id', 'producerJobId'],
    ['--producer-toolchain-digest', 'producerToolchainDigest'],
    ['--archive-subtree', 'archiveSubtree'],
    ['--destination', 'destination']
  ]);
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === '--required-file') {
      const value = argv[++index];
      if (!value) throw new Error('--required-file requires a value.');
      options.requiredFiles.push(value);
      continue;
    }
    const field = fields.get(argv[index]);
    if (!field) throw new Error(`Unsupported package artifact option: ${argv[index]}`);
    const value = argv[++index];
    if (!value) throw new Error(`${argv[index - 1]} requires a value.`);
    options[field] = value;
  }
  if (!options.artifactDir) throw new Error(`${mode} requires --artifact-dir.`);
  return options;
}

function requireConsumerOptions(options, mode) {
  if (!options.manifestDigest) throw new Error(`${mode} requires --manifest-digest from the producer output.`);
  if (!options.producerToolchainDigest) throw new Error(`${mode} requires --producer-toolchain-digest.`);
  if (!options.producerJobId) throw new Error(`${mode} requires --producer-job-id.`);
}

function runIdentityFromOptions(options) {
  return resolvePackageRunIdentity({
    ...process.env,
    ...(options.runId ? { PACKAGE_ARTIFACT_RUN_ID: options.runId } : {}),
    ...(options.runAttempt ? { PACKAGE_ARTIFACT_RUN_ATTEMPT: options.runAttempt } : {}),
    ...(options.jobId ? { PACKAGE_ARTIFACT_JOB_ID: options.jobId } : {})
  });
}

async function ensureArtifactDirectory(value) {
  const resolved = path.resolve(String(value ?? ''));
  await mkdir(resolved, { recursive: true });
  const stats = await lstat(resolved);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error('Package artifact directory must be a non-symlink directory.');
  }
  return realpath(resolved);
}

async function assertPathAbsent(target, label) {
  try {
    await lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`${label} already exists in the producer artifact directory.`);
}

function resolvePackedTarball(packOutput, expectedTarballPath) {
  let filename = path.basename(expectedTarballPath);
  if (packOutput.trim()) {
    const packed = JSON.parse(packOutput)[0];
    if (!packed?.filename) {
      throw new Error('npm pack did not return a packed filename.');
    }
    filename = packed.filename;
  }
  if (filename !== path.basename(expectedTarballPath)) {
    throw new Error(`Unexpected packed filename: ${filename}`);
  }
  return path.join(path.dirname(expectedTarballPath), filename);
}

function runInherit(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, shell: false, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}
