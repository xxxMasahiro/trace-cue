import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

export const PACKAGE_ARTIFACT_SCHEMA_VERSION = '1.0.0';
export const PACKAGE_ARTIFACT_MANIFEST_NAME = 'package-artifact-manifest.json';
export const PACKAGE_ARTIFACT_POLICY = Object.freeze({
  schema_version: PACKAGE_ARTIFACT_SCHEMA_VERSION,
  kind: 'package-artifact-policy',
  digest_algorithm: 'sha256',
  archive_root: 'package',
  allowed_tar_entry_types: Object.freeze(['file', 'directory']),
  symlinks_allowed: false,
  hardlinks_allowed: false,
  shell_execution_allowed: false
});

const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const GIT_OBJECT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const WORKSPACE_MARKER_NAME = '.package-artifact-workspace';
const WORKSPACE_MARKER = 'package-artifact-workspace-v1\n';
let toolchainIdentityPromise;

export async function createPackageArtifactWorkspace(prefix = 'package-artifact-') {
  if (typeof prefix !== 'string' || !/^[A-Za-z0-9._-]+$/u.test(prefix)) {
    throw new Error('Package artifact workspace prefix is invalid.');
  }
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const artifactDir = path.join(root, 'artifacts');
  const cacheDir = path.join(root, 'npm-cache');
  try {
    await writeFile(path.join(root, WORKSPACE_MARKER_NAME), WORKSPACE_MARKER, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await Promise.all([
      mkdir(artifactDir, { recursive: false }),
      mkdir(cacheDir, { recursive: false })
    ]);
    return Object.freeze({ root, artifactDir, cacheDir });
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function cleanupPackageArtifactWorkspace(workspace) {
  if (!workspace || typeof workspace.root !== 'string') {
    throw new Error('Package artifact workspace root is required.');
  }
  const root = path.resolve(workspace.root);
  const temporaryRoot = path.resolve(tmpdir());
  if (root === temporaryRoot || !isPathInside(temporaryRoot, root)) {
    throw new Error('Refusing to remove a package artifact workspace outside the temporary directory.');
  }
  const rootStats = await lstat(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error('Package artifact workspace must be a non-symlink directory.');
  }
  const markerPath = path.join(root, WORKSPACE_MARKER_NAME);
  let markerStats;
  try {
    markerStats = await lstat(markerPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!markerStats || markerStats.isSymbolicLink() || !markerStats.isFile()
    || await readFile(markerPath, 'utf8') !== WORKSPACE_MARKER) {
    throw new Error('Refusing to remove an unmarked package artifact workspace.');
  }
  await rm(root, { recursive: true, force: true });
}

export function resolvePackageRunIdentity(env = process.env) {
  const runId = firstNonEmpty(env.PACKAGE_ARTIFACT_RUN_ID, env.GITHUB_RUN_ID, `local-${process.pid}`);
  const attemptText = firstNonEmpty(env.PACKAGE_ARTIFACT_RUN_ATTEMPT, env.GITHUB_RUN_ATTEMPT, '1');
  const jobId = firstNonEmpty(env.PACKAGE_ARTIFACT_JOB_ID, env.GITHUB_JOB, 'local');
  const runAttempt = Number.parseInt(attemptText, 10);
  assertBoundedIdentifier(runId, 'Package run id');
  assertBoundedIdentifier(jobId, 'Package job id');
  if (!Number.isSafeInteger(runAttempt) || runAttempt < 1 || String(runAttempt) !== String(attemptText).replace(/^0+(?=\d)/u, '')) {
    throw new Error('Package run attempt must be a positive integer.');
  }
  return Object.freeze({ run_id: runId, run_attempt: runAttempt, job_id: jobId });
}

export function packageArtifactPolicyDigest() {
  return digestCanonical(PACKAGE_ARTIFACT_POLICY);
}

export function packageCommandDigest(commandIdentity) {
  assertCommandIdentity(commandIdentity);
  return digestCanonical(commandIdentity);
}

export async function readPackageToolchainIdentity() {
  if (!toolchainIdentityPromise) {
    toolchainIdentityPromise = loadPackageToolchainIdentity().catch((error) => {
      toolchainIdentityPromise = undefined;
      throw error;
    });
  }
  return toolchainIdentityPromise;
}

async function loadPackageToolchainIdentity() {
  const npmVersion = await readInstalledNpmVersion();
  const nodeVersion = process.version;
  return createPackageToolchainIdentity({ nodeVersion, npmVersion });
}

async function readInstalledNpmVersion(env = process.env) {
  const executableName = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  for (const directory of String(env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    let executable;
    try {
      executable = await realpath(path.join(directory, executableName));
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
      throw error;
    }
    const candidates = [
      path.resolve(path.dirname(executable), '..', 'package.json'),
      path.resolve(path.dirname(executable), '..', 'lib', 'node_modules', 'npm', 'package.json')
    ];
    for (const candidate of candidates) {
      try {
        const packageJson = JSON.parse(await readFile(candidate, 'utf8'));
        if (packageJson.name === 'npm' && typeof packageJson.version === 'string') return packageJson.version;
      } catch (error) {
        if (error.code === 'ENOENT' || error instanceof SyntaxError) continue;
        throw error;
      }
    }
  }
  throw new Error('Package npm identity could not be resolved from PATH.');
}

export function createPackageToolchainIdentity({ nodeVersion, npmVersion }) {
  if (typeof nodeVersion !== 'string' || !/^v\d+\.\d+\.\d+/u.test(nodeVersion)
    || typeof npmVersion !== 'string' || !/^\d+\.\d+\.\d+/u.test(npmVersion)) {
    throw new Error('Package toolchain identity is invalid.');
  }
  return Object.freeze({
    node_version: nodeVersion,
    npm_version: npmVersion,
    toolchain_digest: digestCanonical({ node_version: nodeVersion, npm_version: npmVersion })
  });
}

export function packageArtifactManifestDigest(manifest) {
  assertPlainObject(manifest, 'Package artifact manifest');
  const unsigned = { ...manifest };
  delete unsigned.manifest_digest;
  return digestCanonical(unsigned);
}

export async function readPackageRepositoryState(repoRoot) {
  const resolvedRoot = await secureDirectory(repoRoot, 'Package repository root');
  const [head, tree, status, unstaged, staged] = await Promise.all([
    runCapture('git', ['-C', resolvedRoot, 'rev-parse', '--verify', 'HEAD']),
    runCapture('git', ['-C', resolvedRoot, 'rev-parse', '--verify', 'HEAD^{tree}']),
    runCapture('git', ['-C', resolvedRoot, 'status', '--porcelain=v1', '--untracked-files=all', '-z']),
    runCapture('git', ['-C', resolvedRoot, 'diff', '--binary', '--no-ext-diff']),
    runCapture('git', ['-C', resolvedRoot, 'diff', '--cached', '--binary', '--no-ext-diff'])
  ]);
  const headSha = head.toString('utf8').trim();
  const treeSha = tree.toString('utf8').trim();
  if (!GIT_OBJECT_PATTERN.test(headSha) || !GIT_OBJECT_PATTERN.test(treeSha)) {
    throw new Error('Package repository HEAD or tree is not a full Git object id.');
  }
  const inputDigest = digestBuffers([
    Buffer.from(`head\0${headSha}\0tree\0${treeSha}\0`, 'utf8'),
    Buffer.from('status\0', 'utf8'), status,
    Buffer.from('\0unstaged\0', 'utf8'), unstaged,
    Buffer.from('\0staged\0', 'utf8'), staged
  ]);
  return Object.freeze({ head_sha: headSha, tree_sha: treeSha, input_digest: inputDigest });
}

export async function inspectPackageTarball(tarballPath) {
  const file = await secureRegularFile(tarballPath, 'Package tarball');
  const compressed = await readFile(file);
  let archive;
  try {
    archive = gunzipSync(compressed);
  } catch {
    throw new Error('Package tarball is not a valid gzip archive.');
  }
  const entries = parseTarEntries(archive);
  return Object.freeze({
    sha256: digestBuffers([compressed]),
    size_bytes: compressed.length,
    file_list_digest: digestCanonical(entries),
    file_count: entries.filter((entry) => entry.type === 'file').length
  });
}

export async function createPackageArtifactManifest(options) {
  assertPlainObject(options, 'Package artifact options');
  const { repoRoot, tarballPath, run, commandIdentity } = options;
  validateRunIdentity(run);
  assertCommandIdentity(commandIdentity);
  assertPackageIdentity(options.packageName, options.packageVersion);
  const toolchain = options.toolchain ?? await readPackageToolchainIdentity();
  validateToolchainIdentity(toolchain);
  const filename = path.basename(String(tarballPath ?? ''));
  if (!filename || filename !== String(options.filename ?? filename) || !isSafeBasename(filename)) {
    throw new Error('Package artifact filename is invalid.');
  }
  const [repository, artifact] = await Promise.all([
    readPackageRepositoryState(repoRoot),
    inspectPackageTarball(tarballPath)
  ]);
  const unsigned = {
    schema_version: PACKAGE_ARTIFACT_SCHEMA_VERSION,
    kind: 'package-artifact-manifest',
    producer: {
      run_id: run.run_id,
      run_attempt: run.run_attempt,
      job_id: run.job_id,
      head_sha: repository.head_sha,
      tree_sha: repository.tree_sha,
      input_digest: repository.input_digest,
      policy_digest: packageArtifactPolicyDigest(),
      command_digest: packageCommandDigest(commandIdentity),
      node_version: toolchain.node_version,
      npm_version: toolchain.npm_version,
      toolchain_digest: toolchain.toolchain_digest
    },
    artifact: {
      filename,
      package_name: options.packageName,
      package_version: options.packageVersion,
      sha256: artifact.sha256,
      size_bytes: artifact.size_bytes,
      file_list_digest: artifact.file_list_digest,
      file_count: artifact.file_count
    }
  };
  return Object.freeze({ ...unsigned, manifest_digest: digestCanonical(unsigned) });
}

export async function writePackageArtifactManifest(options) {
  assertPlainObject(options, 'Package manifest write options');
  const artifactRoot = await secureDirectory(options.artifactRoot, 'Package artifact root');
  validatePackageArtifactManifest(options.manifest);
  const manifestPath = path.resolve(options.manifestPath);
  if (!isPathInside(artifactRoot, manifestPath) || path.dirname(manifestPath) !== artifactRoot) {
    throw new Error('Package artifact manifest path must stay directly inside the artifact root.');
  }
  await rejectExistingSymlink(manifestPath, 'Package artifact manifest');
  const temporaryPath = path.join(artifactRoot, `.${path.basename(manifestPath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(options.manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporaryPath, manifestPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return manifestPath;
}

export async function verifyPackageArtifact(options) {
  assertPlainObject(options, 'Package artifact verification options');
  const artifactRoot = await secureDirectory(options.artifactRoot, 'Package artifact root');
  const manifestPath = await secureContainedRegularFile(
    artifactRoot,
    options.manifestPath,
    'Package artifact manifest'
  );
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    throw new Error('Package artifact manifest is not valid JSON.');
  }
  validatePackageArtifactManifest(manifest);
  if (options.expectedManifestDigest && manifest.manifest_digest !== options.expectedManifestDigest) {
    throw new Error('Package artifact manifest digest does not match the producer output.');
  }
  const expectedDigest = packageArtifactManifestDigest(manifest);
  if (manifest.manifest_digest !== expectedDigest) {
    throw new Error('Package artifact manifest was modified after production.');
  }
  validateExpectedRun(manifest.producer, options.expectedRun, options.expectedProducerJobId);
  const expectedPolicyDigest = options.expectedPolicyDigest ?? packageArtifactPolicyDigest();
  if (manifest.producer.policy_digest !== expectedPolicyDigest) {
    throw new Error('Package artifact policy digest does not match.');
  }
  if (options.expectedCommandIdentity
    && manifest.producer.command_digest !== packageCommandDigest(options.expectedCommandIdentity)) {
    throw new Error('Package artifact command digest does not match.');
  }
  if (options.expectedPackage) {
    assertPackageIdentity(options.expectedPackage.name, options.expectedPackage.version);
    if (manifest.artifact.package_name !== options.expectedPackage.name
      || manifest.artifact.package_version !== options.expectedPackage.version) {
      throw new Error('Package artifact package identity does not match.');
    }
  }
  if (options.expectedProducerToolchainDigest
    && manifest.producer.toolchain_digest !== options.expectedProducerToolchainDigest) {
    throw new Error('Package artifact producer toolchain digest does not match the producer output.');
  }
  if (!isSafeBasename(manifest.artifact.filename)) {
    throw new Error('Package artifact manifest contains an unsafe filename.');
  }
  const tarballPath = await secureContainedRegularFile(
    artifactRoot,
    path.join(artifactRoot, manifest.artifact.filename),
    'Package tarball'
  );
  const actualArtifact = await inspectPackageTarball(tarballPath);
  for (const key of ['sha256', 'size_bytes', 'file_list_digest', 'file_count']) {
    if (manifest.artifact[key] !== actualArtifact[key]) {
      throw new Error(`Package artifact ${key} does not match the manifest.`);
    }
  }
  if (options.repoRoot) {
    const repository = await readPackageRepositoryState(options.repoRoot);
    for (const key of ['head_sha', 'tree_sha', 'input_digest']) {
      if (manifest.producer[key] !== repository[key]) {
        throw new Error(`Package artifact producer ${key} does not match the consumer repository state.`);
      }
    }
  }
  return Object.freeze({ manifest, tarballPath });
}

export function validatePackageArtifactManifest(manifest) {
  assertPlainObject(manifest, 'Package artifact manifest');
  assertExactKeys(manifest, ['schema_version', 'kind', 'producer', 'artifact', 'manifest_digest'], 'Package artifact manifest');
  if (manifest.schema_version !== PACKAGE_ARTIFACT_SCHEMA_VERSION || manifest.kind !== 'package-artifact-manifest') {
    throw new Error('Package artifact manifest version or kind is unsupported.');
  }
  assertPlainObject(manifest.producer, 'Package artifact producer');
  assertExactKeys(manifest.producer, [
    'run_id', 'run_attempt', 'job_id', 'head_sha', 'tree_sha', 'input_digest', 'policy_digest', 'command_digest',
    'node_version', 'npm_version', 'toolchain_digest'
  ], 'Package artifact producer');
  validateRunIdentity(manifest.producer);
  if (!GIT_OBJECT_PATTERN.test(manifest.producer.head_sha) || !GIT_OBJECT_PATTERN.test(manifest.producer.tree_sha)) {
    throw new Error('Package artifact producer Git object ids are invalid.');
  }
  for (const key of ['input_digest', 'policy_digest', 'command_digest', 'toolchain_digest']) {
    if (!DIGEST_PATTERN.test(manifest.producer[key])) {
      throw new Error(`Package artifact producer ${key} is invalid.`);
    }
  }
  validateToolchainIdentity(manifest.producer);
  assertPlainObject(manifest.artifact, 'Package artifact');
  assertExactKeys(manifest.artifact, [
    'filename', 'package_name', 'package_version', 'sha256', 'size_bytes', 'file_list_digest', 'file_count'
  ], 'Package artifact');
  if (!isSafeBasename(manifest.artifact.filename)) throw new Error('Package artifact filename is invalid.');
  assertPackageIdentity(manifest.artifact.package_name, manifest.artifact.package_version);
  if (!DIGEST_PATTERN.test(manifest.artifact.sha256) || !DIGEST_PATTERN.test(manifest.artifact.file_list_digest)) {
    throw new Error('Package artifact digest is invalid.');
  }
  if (!Number.isSafeInteger(manifest.artifact.size_bytes) || manifest.artifact.size_bytes <= 0) {
    throw new Error('Package artifact size is invalid.');
  }
  if (!Number.isSafeInteger(manifest.artifact.file_count) || manifest.artifact.file_count < 1) {
    throw new Error('Package artifact file count is invalid.');
  }
  if (!DIGEST_PATTERN.test(manifest.manifest_digest)) throw new Error('Package artifact manifest digest is invalid.');
  return manifest;
}

function parseTarEntries(archive) {
  const entries = [];
  const names = new Set();
  let offset = 0;
  let zeroBlocks = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      zeroBlocks += 1;
      if (zeroBlocks === 2) break;
      continue;
    }
    zeroBlocks = 0;
    validateTarChecksum(header);
    const namePart = tarText(header, 0, 100);
    const prefix = tarText(header, 345, 155);
    const archivePath = prefix ? `${prefix}/${namePart}` : namePart;
    const typeFlag = String.fromCharCode(header[156] || 48);
    const type = typeFlag === '5' ? 'directory' : typeFlag === '0' || typeFlag === '\0' ? 'file' : null;
    if (!type) throw new Error(`Package tarball contains unsupported entry type ${JSON.stringify(typeFlag)}.`);
    const normalizedPath = validateTarPath(archivePath, type);
    if (names.has(normalizedPath)) throw new Error(`Package tarball contains duplicate entry ${normalizedPath}.`);
    names.add(normalizedPath);
    const size = tarOctal(header, 124, 12, 'size');
    const mode = tarOctal(header, 100, 8, 'mode');
    if (type === 'directory' && size !== 0) throw new Error('Package tarball directory entry has content.');
    if (offset + size > archive.length) throw new Error('Package tarball entry exceeds the archive boundary.');
    const content = archive.subarray(offset, offset + size);
    entries.push({
      path: normalizedPath,
      type,
      size,
      mode,
      sha256: type === 'file' ? digestBuffers([content]) : null
    });
    offset += Math.ceil(size / 512) * 512;
  }
  if (zeroBlocks < 2 || entries.length === 0 || archive.subarray(offset).some((byte) => byte !== 0)) {
    throw new Error('Package tarball has an invalid end marker or trailing content.');
  }
  return entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function validateTarPath(value, type) {
  if (!value || value.includes('\\') || value.includes('\0') || value.startsWith('/')) {
    throw new Error('Package tarball contains an unsafe entry path.');
  }
  const normalized = path.posix.normalize(value.replace(/\/$/u, ''));
  const parts = normalized.split('/');
  if (normalized !== value.replace(/\/$/u, '') || parts[0] !== PACKAGE_ARTIFACT_POLICY.archive_root
    || parts.includes('..') || (type === 'file' && parts.length < 2)) {
    throw new Error(`Package tarball entry escapes the package root: ${value}`);
  }
  return normalized;
}

function validateTarChecksum(header) {
  const expected = tarOctal(header, 148, 8, 'checksum');
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : header[index];
  }
  if (actual !== expected) throw new Error('Package tarball header checksum is invalid.');
}

function tarText(buffer, offset, length) {
  const field = buffer.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? field.length : end).toString('utf8');
}

function tarOctal(buffer, offset, length, label) {
  const text = tarText(buffer, offset, length).trim();
  if (!/^[0-7]+$/u.test(text)) throw new Error(`Package tarball ${label} field is invalid.`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Package tarball ${label} is out of range.`);
  return value;
}

async function secureContainedRegularFile(root, target, label) {
  const resolved = path.resolve(String(target ?? ''));
  if (!isPathInside(root, resolved)) throw new Error(`${label} escapes the artifact root.`);
  const file = await secureRegularFile(resolved, label);
  const actual = await realpath(file);
  if (!isPathInside(root, actual)) throw new Error(`${label} resolves outside the artifact root.`);
  return file;
}

async function secureRegularFile(target, label) {
  const resolved = path.resolve(String(target ?? ''));
  const stats = await lstat(resolved);
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error(`${label} must be a regular non-symlink file.`);
  return resolved;
}

async function secureDirectory(target, label) {
  const resolved = path.resolve(String(target ?? ''));
  const stats = await lstat(resolved);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`${label} must be a non-symlink directory.`);
  return realpath(resolved);
}

async function rejectExistingSymlink(target, label) {
  try {
    const stats = await lstat(target);
    if (stats.isSymbolicLink()) throw new Error(`${label} must not be a symlink.`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function validateExpectedRun(producer, expectedRun, expectedProducerJobId) {
  if (expectedRun) {
    validateRunIdentity(expectedRun);
    if (producer.run_id !== expectedRun.run_id || producer.run_attempt !== expectedRun.run_attempt) {
      throw new Error('Package artifact was not produced by the expected workflow run.');
    }
  }
  if (expectedProducerJobId !== undefined && producer.job_id !== expectedProducerJobId) {
    throw new Error('Package artifact was not produced by the expected job.');
  }
}

function validateRunIdentity(run) {
  assertPlainObject(run, 'Package run identity');
  assertBoundedIdentifier(run.run_id, 'Package run id');
  assertBoundedIdentifier(run.job_id, 'Package job id');
  if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) {
    throw new Error('Package run attempt must be a positive integer.');
  }
}

function validateToolchainIdentity(toolchain) {
  assertPlainObject(toolchain, 'Package toolchain identity');
  if (typeof toolchain.node_version !== 'string' || !/^v\d+\.\d+\.\d+/u.test(toolchain.node_version)
    || typeof toolchain.npm_version !== 'string' || !/^\d+\.\d+\.\d+/u.test(toolchain.npm_version)
    || !DIGEST_PATTERN.test(toolchain.toolchain_digest)) {
    throw new Error('Package toolchain identity is invalid.');
  }
  const expectedDigest = digestCanonical({
    node_version: toolchain.node_version,
    npm_version: toolchain.npm_version
  });
  if (toolchain.toolchain_digest !== expectedDigest) {
    throw new Error('Package toolchain digest is invalid.');
  }
}

function assertPackageIdentity(name, version) {
  if (typeof name !== 'string' || name.length < 1 || name.length > 214 || /[\0\r\n]/u.test(name)
    || typeof version !== 'string' || version.length < 1 || version.length > 200 || /[\0\r\n]/u.test(version)) {
    throw new Error('Package name and version are invalid.');
  }
}

function assertBoundedIdentifier(value, label) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 200 || /[\0\r\n]/u.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
}

function assertCommandIdentity(value) {
  if (!Array.isArray(value) || value.length === 0
    || value.some((item) => typeof item !== 'string' || item.length === 0 || /[\0\r\n]/u.test(item))) {
    throw new Error('Package command identity must be a non-empty argv array.');
  }
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} fields are invalid.`);
  }
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be an object.`);
  }
}

function isSafeBasename(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 255
    && value === path.basename(value) && !value.includes('\\') && !value.includes('\0') && value !== '.' && value !== '..';
}

function isPathInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function digestCanonical(value) {
  return digestBuffers([Buffer.from(JSON.stringify(canonicalize(value)), 'utf8')]);
}

function digestBuffers(buffers) {
  const hash = createHash('sha256');
  for (const buffer of buffers) hash.update(buffer);
  return hash.digest('hex');
}

async function runCapture(command, args) {
  return (await runCaptureResult(command, args)).stdout;
}

function runCaptureResult(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    const collect = (target) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_GIT_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.on('error', reject);
    child.on('close', (code) => {
      if (outputBytes > MAX_GIT_OUTPUT_BYTES) {
        reject(new Error(`${command} output exceeded the package verification limit.`));
      } else if (code !== 0) {
        reject(new Error(`${command} exited with code ${code}: ${Buffer.concat(stderr).toString('utf8').trim()}`));
      } else {
        resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      }
    });
  });
}
