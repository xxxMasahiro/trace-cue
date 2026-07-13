import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { gunzipSync } from 'node:zlib';

export const PACKAGE_ARTIFACT_SCHEMA_VERSION = '1.0.0';
export const PACKAGE_ARTIFACT_MANIFEST_NAME = 'package-artifact-manifest.json';
const MAX_PACKAGE_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_PACKAGE_TARBALL_BYTES = 64 * 1024 * 1024;
const MAX_MATERIALIZED_FILE_BYTES = 16 * 1024 * 1024;
const MAX_MATERIALIZED_FILES = 2000;
const MAX_PACKAGE_COMMAND_DURATION_MS = 5 * 60 * 1000;
const MAX_PACKAGE_UNTRACKED_FILES = 2000;
const MAX_PACKAGE_UNTRACKED_FILE_BYTES = 16 * 1024 * 1024;
const MAX_PACKAGE_UNTRACKED_BYTES = 64 * 1024 * 1024;
export const PACKAGE_ARTIFACT_POLICY = Object.freeze({
  schema_version: PACKAGE_ARTIFACT_SCHEMA_VERSION,
  kind: 'package-artifact-policy',
  digest_algorithm: 'sha256',
  archive_root: 'package',
  allowed_tar_entry_types: Object.freeze(['file', 'directory']),
  symlinks_allowed: false,
  hardlinks_allowed: false,
  shell_execution_allowed: false,
  verified_subtree_materialization: true,
  max_tarball_bytes: MAX_PACKAGE_TARBALL_BYTES,
  max_expanded_bytes: MAX_PACKAGE_ARCHIVE_BYTES,
  max_materialized_file_bytes: MAX_MATERIALIZED_FILE_BYTES,
  max_materialized_files: MAX_MATERIALIZED_FILES,
  command_timeout_ms: MAX_PACKAGE_COMMAND_DURATION_MS,
  max_untracked_files: MAX_PACKAGE_UNTRACKED_FILES,
  max_untracked_file_bytes: MAX_PACKAGE_UNTRACKED_FILE_BYTES,
  max_untracked_bytes: MAX_PACKAGE_UNTRACKED_BYTES
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

export async function runBoundedCommandToFile({
  command,
  args,
  cwd,
  outputPath,
  maxBytes,
  timeoutMs = PACKAGE_ARTIFACT_POLICY.command_timeout_ms,
  signal
}) {
  if (typeof command !== 'string' || !command
    || !Array.isArray(args) || args.some((argument) => typeof argument !== 'string')
    || typeof cwd !== 'string' || typeof outputPath !== 'string'
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1
    || (signal !== undefined && (typeof signal !== 'object' || typeof signal.addEventListener !== 'function'))) {
    throw new Error('Bounded command output options are invalid.');
  }
  if (signal?.aborted) throw new Error(`${command} was cancelled before it started.`);
  const output = await open(outputPath, 'wx+', 0o600);
  let child;
  let timer;
  let terminationError = null;
  const signalHandlers = new Map();
  const terminate = (error) => {
    terminationError ??= error;
    terminateCommandTree(child);
  };
  const abortHandler = () => terminate(new Error(`${command} was cancelled.`));
  try {
    let observedBytes = 0;
    let limitError = null;
    child = spawn(command, args, {
      cwd,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    signal?.addEventListener('abort', abortHandler, { once: true });
    for (const processSignal of ['SIGINT', 'SIGTERM']) {
      const handler = () => terminate(new Error(`${command} was interrupted by ${processSignal}.`));
      signalHandlers.set(processSignal, handler);
      process.once(processSignal, handler);
    }
    timer = setTimeout(() => terminate(new Error(`${command} timed out after ${timeoutMs} ms.`)), timeoutMs);
    timer.unref?.();
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        if (observedBytes + chunk.length > maxBytes) {
          limitError = new Error(`${command} returned oversized output.`);
          terminateCommandTree(child);
          callback(limitError);
          return;
        }
        observedBytes += chunk.length;
        writeComplete(output, chunk).then(() => callback(), callback);
      }
    });
    const errorSink = new Writable({
      write(chunk, _encoding, callback) {
        if (observedBytes + chunk.length > maxBytes) {
          limitError = new Error(`${command} returned oversized output.`);
          terminateCommandTree(child);
          callback(limitError);
          return;
        }
        observedBytes += chunk.length;
        callback();
      }
    });
    const piping = pipeline(child.stdout, sink).catch((error) => {
      terminateCommandTree(child);
      throw error;
    });
    const errorPiping = pipeline(child.stderr, errorSink).catch((error) => {
      terminateCommandTree(child);
      throw error;
    });
    const closed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`${command} exited with code ${code ?? `signal ${signal ?? 'unknown'}`}`));
      });
    });
    const [pipeResult, errorPipeResult, closeResult] = await Promise.allSettled([piping, errorPiping, closed]);
    if (terminationError) throw terminationError;
    if (limitError) throw limitError;
    if (pipeResult.status === 'rejected') throw pipeResult.reason;
    if (errorPipeResult.status === 'rejected') throw errorPipeResult.reason;
    if (closeResult.status === 'rejected') throw closeResult.reason;
    const before = await output.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maxBytes) {
      throw new Error(`${command} returned empty, unsafe, or oversized output.`);
    }
    const body = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < body.length) {
      const { bytesRead } = await output.read(body, offset, body.length - offset, offset);
      if (bytesRead <= 0) throw new Error(`${command} output could not be read completely.`);
      offset += bytesRead;
    }
    const probe = Buffer.alloc(1);
    if ((await output.read(probe, 0, 1, before.size)).bytesRead !== 0) {
      throw new Error(`${command} output exceeded its inspected size.`);
    }
    const after = await output.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`${command} output changed while it was being read.`);
    }
    return body.toString('utf8');
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener?.('abort', abortHandler);
    for (const [processSignal, handler] of signalHandlers) process.removeListener(processSignal, handler);
    terminateCommandTree(child);
    await output.close();
  }
}

async function writeComplete(handle, chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
    if (bytesWritten <= 0) throw new Error('Bounded command output could not be written completely.');
    offset += bytesWritten;
  }
}

function terminateCommandTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      try { child.kill('SIGKILL'); } catch {}
    }
  }
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
  const [head, tree, status, unstaged, staged, untracked] = await Promise.all([
    runCapture('git', ['-C', resolvedRoot, 'rev-parse', '--verify', 'HEAD']),
    runCapture('git', ['-C', resolvedRoot, 'rev-parse', '--verify', 'HEAD^{tree}']),
    runCapture('git', ['-C', resolvedRoot, 'status', '--porcelain=v1', '--untracked-files=all', '-z']),
    runCapture('git', ['-C', resolvedRoot, 'diff', '--binary', '--no-ext-diff']),
    runCapture('git', ['-C', resolvedRoot, 'diff', '--cached', '--binary', '--no-ext-diff']),
    runCapture('git', ['-C', resolvedRoot, 'ls-files', '--others', '--exclude-standard', '-z'])
  ]);
  const headSha = head.toString('utf8').trim();
  const treeSha = tree.toString('utf8').trim();
  if (!GIT_OBJECT_PATTERN.test(headSha) || !GIT_OBJECT_PATTERN.test(treeSha)) {
    throw new Error('Package repository HEAD or tree is not a full Git object id.');
  }
  const untrackedRecords = await hashPackageUntrackedInputs(resolvedRoot, untracked);
  const inputDigest = digestBuffers([
    Buffer.from(`head\0${headSha}\0tree\0${treeSha}\0`, 'utf8'),
    Buffer.from('status\0', 'utf8'), status,
    Buffer.from('\0unstaged\0', 'utf8'), unstaged,
    Buffer.from('\0staged\0', 'utf8'), staged,
    Buffer.from('\0untracked-content\0', 'utf8'), Buffer.from(JSON.stringify(untrackedRecords), 'utf8')
  ]);
  return Object.freeze({ head_sha: headSha, tree_sha: treeSha, input_digest: inputDigest });
}

async function hashPackageUntrackedInputs(repoRoot, rawPaths) {
  const paths = rawPaths.toString('utf8').split('\0').filter(Boolean).sort();
  if (paths.length > PACKAGE_ARTIFACT_POLICY.max_untracked_files) {
    throw new Error('Package repository has too many untracked inputs.');
  }
  let totalBytes = 0;
  const records = [];
  for (const relativePath of paths) {
    if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]+/u).includes('..')) {
      throw new Error('Package repository has an unsafe untracked input path.');
    }
    const target = path.resolve(repoRoot, relativePath);
    if (!isPathInside(repoRoot, target)) throw new Error('Package untracked input escapes the repository.');
    const before = await lstat(target);
    if (before.isSymbolicLink()) {
      const linkTarget = await readlink(target);
      const after = await lstat(target);
      if (!after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        throw new Error('Package repository untracked input changed during inspection.');
      }
      records.push([relativePath, 'symlink', digestBuffers([Buffer.from(linkTarget, 'utf8')])]);
      continue;
    }
    if (!before.isFile() || before.nlink !== 1 || before.size > PACKAGE_ARTIFACT_POLICY.max_untracked_file_bytes) {
      throw new Error('Package repository has an unsafe or oversized untracked input.');
    }
    totalBytes += before.size;
    if (totalBytes > PACKAGE_ARTIFACT_POLICY.max_untracked_bytes) {
      throw new Error('Package repository untracked inputs exceed their total byte limit.');
    }
    const handle = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    let body;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || before.dev !== opened.dev || before.ino !== opened.ino
        || before.size !== opened.size || before.mtimeMs !== opened.mtimeMs || before.ctimeMs !== opened.ctimeMs) {
        throw new Error('Package repository untracked input changed during inspection.');
      }
      body = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < body.length) {
        const { bytesRead } = await handle.read(body, offset, body.length - offset, offset);
        if (bytesRead <= 0) throw new Error('Package repository untracked input could not be read completely.');
        offset += bytesRead;
      }
      const probe = Buffer.alloc(1);
      if ((await handle.read(probe, 0, 1, opened.size)).bytesRead !== 0) {
        throw new Error('Package repository untracked input exceeded its inspected size.');
      }
      const [completed, pathAfter] = await Promise.all([handle.stat(), lstat(target)]);
      for (const current of [completed, pathAfter]) {
        if (!current.isFile() || current.nlink !== 1 || opened.dev !== current.dev || opened.ino !== current.ino
          || opened.size !== current.size || opened.mtimeMs !== current.mtimeMs || opened.ctimeMs !== current.ctimeMs) {
          throw new Error('Package repository untracked input changed during inspection.');
        }
      }
    } finally {
      await handle.close();
    }
    records.push([relativePath, 'file', before.size, digestBuffers([body])]);
  }
  return records;
}

export async function inspectPackageTarball(tarballPath) {
  const { compressed, archive } = await readPackageTarball(tarballPath);
  const entries = parseTarEntries(archive);
  const projectedEntries = entries.map(({ content, ...entry }) => entry);
  return Object.freeze({
    sha256: digestBuffers([compressed]),
    size_bytes: compressed.length,
    file_list_digest: digestCanonical(projectedEntries),
    file_count: entries.filter((entry) => entry.type === 'file').length
  });
}

export async function materializePackageSubtree({
  tarballPath,
  expectedTarballSha256,
  archiveSubtree,
  destinationRoot,
  destinationPath,
  requiredFiles = []
}) {
  if (!DIGEST_PATTERN.test(expectedTarballSha256 ?? '')) {
    throw new Error('Package materialization requires the verified tarball digest.');
  }
  const root = await secureDirectory(destinationRoot, 'Package materialization root');
  const normalizedSubtree = validateRelativeSubtree(archiveSubtree, 'Package archive subtree');
  const normalizedDestination = validateRelativeSubtree(destinationPath, 'Package destination path');
  const destination = path.resolve(root, normalizedDestination);
  if (!isPathInside(root, destination)) throw new Error('Package destination escapes its root.');
  const parent = await ensureSafeRelativeDirectory(root, path.dirname(normalizedDestination));
  await assertPathDoesNotExist(destination, 'Package destination');
  const { compressed, archive } = await readPackageTarball(tarballPath);
  if (digestBuffers([compressed]) !== expectedTarballSha256) {
    throw new Error('Package tarball changed after verification.');
  }
  const prefix = `${PACKAGE_ARTIFACT_POLICY.archive_root}/${normalizedSubtree}/`;
  const selected = parseTarEntries(archive).filter((entry) => entry.type === 'file' && entry.path.startsWith(prefix));
  let totalBytes = 0;
  if (!selected.length || selected.length > MAX_MATERIALIZED_FILES) throw new Error('Package subtree file set is empty or exceeds its limit.');
  const relativeFiles = new Set();
  for (const entry of selected) {
    const relative = entry.path.slice(prefix.length);
    validateRelativeSubtree(relative, 'Package subtree entry');
    if (!relative || relativeFiles.has(relative) || entry.size > MAX_MATERIALIZED_FILE_BYTES) {
      throw new Error('Package subtree contains an invalid or oversized file.');
    }
    relativeFiles.add(relative);
    totalBytes += entry.size;
    if (totalBytes > MAX_PACKAGE_ARCHIVE_BYTES) throw new Error('Package subtree expanded size exceeds its limit.');
  }
  for (const required of requiredFiles) {
    const normalized = validateRelativeSubtree(required, 'Required package subtree file');
    if (!relativeFiles.has(normalized)) throw new Error(`Package subtree is missing required file: ${normalized}`);
  }

  const temporary = path.join(parent, `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(temporary, { mode: 0o700 });
  try {
    for (const entry of selected.sort((a, b) => a.path.localeCompare(b.path))) {
      const relative = entry.path.slice(prefix.length);
      const target = path.join(temporary, ...relative.split('/'));
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const actualParent = await realpath(path.dirname(target));
      if (!isPathInside(temporary, actualParent) && actualParent !== temporary) throw new Error('Package subtree output escaped its temporary root.');
      await writeFile(target, entry.content, { flag: 'wx', mode: 0o600 });
    }
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  return Object.freeze({
    destination,
    file_count: selected.length,
    size_bytes: totalBytes,
    subtree_digest: digestCanonical(selected.map((entry) => ({
      path: entry.path.slice(prefix.length),
      size: entry.size,
      sha256: entry.sha256
    })))
  });
}

async function readPackageTarball(tarballPath) {
  const file = await secureRegularFile(tarballPath, 'Package tarball');
  const info = await lstat(file);
  if (info.nlink !== 1 || info.size <= 0 || info.size > MAX_PACKAGE_TARBALL_BYTES) {
    throw new Error('Package tarball size or link count is unsafe.');
  }
  const compressed = await readFile(file);
  let archive;
  try {
    archive = gunzipSync(compressed, { maxOutputLength: MAX_PACKAGE_ARCHIVE_BYTES });
  } catch {
    throw new Error('Package tarball is not a valid bounded gzip archive.');
  }
  return { compressed, archive };
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
  await assertExactArtifactFileSet(artifactRoot, [path.basename(manifestPath), manifest.artifact.filename]);
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

async function assertExactArtifactFileSet(artifactRoot, expectedNames) {
  const names = [];
  const directory = await opendir(artifactRoot);
  try {
    for await (const entry of directory) {
      if (names.length >= expectedNames.length + 1 || !entry.isFile() || entry.isSymbolicLink()) {
        throw new Error('Package artifact directory contains an unexpected file set.');
      }
      names.push(entry.name);
    }
  } finally {
    try { await directory.close(); } catch {}
  }
  if (JSON.stringify(names.sort()) !== JSON.stringify([...new Set(expectedNames)].sort())) {
    throw new Error('Package artifact directory contains an unexpected file set.');
  }
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
      sha256: type === 'file' ? digestBuffers([content]) : null,
      content: type === 'file' ? Buffer.from(content) : null
    });
    if (entries.length > 20000) throw new Error('Package tarball contains too many entries.');
    offset += Math.ceil(size / 512) * 512;
  }
  if (zeroBlocks < 2 || entries.length === 0 || archive.subarray(offset).some((byte) => byte !== 0)) {
    throw new Error('Package tarball has an invalid end marker or trailing content.');
  }
  return entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function validateRelativeSubtree(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || path.isAbsolute(value)) {
    throw new Error(`${label} is unsafe.`);
  }
  const normalized = path.posix.normalize(value.replace(/^\.\//u, '').replace(/\/$/u, ''));
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')
    || normalized !== value.replace(/^\.\//u, '').replace(/\/$/u, '')) {
    throw new Error(`${label} is unsafe.`);
  }
  return normalized;
}

async function ensureSafeRelativeDirectory(root, relative) {
  if (relative === '.') return root;
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Package destination parent is unsafe.');
  }
  return realpath(current);
}

async function assertPathDoesNotExist(target, label) {
  try {
    await lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`${label} already exists.`);
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
