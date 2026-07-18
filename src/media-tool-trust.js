import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { runFixedProcess } from './fixed-process-runner.js';
import {
  loadMediaReviewAdapterCatalog,
  loadMediaReviewPolicy,
  resolveMediaReviewAdapter
} from './media-review-policy.js';

const PROFILE_SCHEMA_VERSION = '1.0.0';
const MAX_PROFILE_BYTES = 64 * 1024;
const MAX_HASHED_TOOL_BYTES = 512 * 1024 * 1024;
const MAX_TRACKED_FILES = 20_000;
const MAX_TRACKED_TREE_BYTES = 1024 * 1024 * 1024;
const MAX_GIT_INVENTORY_BYTES = 8 * 1024 * 1024;
const GIT_TRUST_CONFIG = Object.freeze([
  '-c', 'core.fsmonitor=false',
  '-c', 'core.untrackedCache=false',
  '-c', 'core.trustctime=true',
  '-c', 'core.checkStat=default',
  '-c', 'core.ignoreStat=false'
]);
export async function loadMediaTranscriptProviderProfile(context = {}) {
  if (context.mediaTranscriptProviderProfile) {
    return validateProfileForAdapter(structuredClone(context.mediaTranscriptProviderProfile), context);
  }
  const policy = await loadMediaReviewPolicy(context);
  const configured = process.env[policy.transcript_provider.local_profile_environment];
  const profilePath = path.resolve(configured || path.join(context.packageRoot ?? process.cwd(), policy.transcript_provider.local_profile_relative));
  let info;
  try { info = await lstat(profilePath, { bigint: true }); } catch (error) {
    throw trustError('MEDIA_PROVIDER_PROFILE_UNAVAILABLE', 'The local transcript provider profile is unavailable.', error?.code);
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size > BigInt(MAX_PROFILE_BYTES)) {
    throw trustError('MEDIA_PROVIDER_PROFILE_INVALID', 'The local transcript provider profile is unsafe.');
  }
  if (typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid())) {
    throw trustError('MEDIA_PROVIDER_PROFILE_OWNER_INVALID', 'The local transcript provider profile has an unexpected owner.');
  }
  if (process.platform !== 'win32' && Number(info.mode & 0o777n) !== 0o600) {
    throw trustError('MEDIA_PROVIDER_PROFILE_PERMISSIONS_INVALID', 'The local transcript provider profile must use private permissions.');
  }
  let profile;
  try { profile = JSON.parse(await readFile(profilePath, 'utf8')); } catch {
    throw trustError('MEDIA_PROVIDER_PROFILE_INVALID', 'The local transcript provider profile is invalid.');
  }
  return validateProfileForAdapter(profile, context);
}

export async function verifyMediaTranscriptProviderTrust(profile, context = {}) {
  const validatedProfile = await validateProfileForAdapter(structuredClone(profile), context);
  const adapter = await resolveProfileAdapter(validatedProfile, context);
  if (adapter.runtime_kind !== 'node_git_checkout_cli') {
    throw trustError('MEDIA_PROVIDER_RUNTIME_UNSUPPORTED', 'The transcript provider runtime strategy is unsupported.');
  }
  const processRunner = context.fixedProcessRunner ?? runFixedProcess;
  const runtime = validatedProfile.runtime;
  const [nodeTool, entrypointTool, gitTool] = await Promise.all([
    inspectTrustedTool(runtime.node_executable, { expectedSha256: runtime.node_sha256, executable: true }),
    inspectTrustedTool(runtime.entrypoint, { expectedSha256: runtime.entrypoint_sha256, executable: false }),
    inspectTrustedTool(runtime.git_executable, {
      expectedSha256: runtime.git_sha256,
      executable: true,
      allowMappedSystemOwner: true
    })
  ]);
  const packageRoot = await inspectTrustedPackageRoot(runtime.package_root);
  const allowedEnvironmentKeys = await resolveAllowedEnvironmentKeys(validatedProfile, context);
  const env = buildProviderEnvironment(validatedProfile.environment, allowedEnvironmentKeys);
  const revision = await runGit(processRunner, gitTool.path, packageRoot.path, ['rev-parse', '--verify', 'HEAD'], env);
  if (!/^[a-f0-9]{40}$/u.test(revision) || revision !== runtime.expected_revision) {
    throw trustError('MEDIA_PROVIDER_REVISION_MISMATCH', 'The transcript provider revision does not match the trusted profile.');
  }
  if (runtime.require_clean_tree) {
    const dirty = await runGit(processRunner, gitTool.path, packageRoot.path, ['status', '--porcelain=v1', '--untracked-files=no'], env);
    if (dirty !== '') throw trustError('MEDIA_PROVIDER_TREE_DIRTY', 'The transcript provider working tree is not clean.');
  }
  const trackedTreeIdentity = await inspectTrackedCheckout(
    processRunner,
    gitTool.path,
    packageRoot.path,
    revision,
    env
  );
  const packageVersion = await readPackageVersion(packageRoot.path);
  const configurationIdentity = createHash('sha256')
    .update(JSON.stringify(Object.fromEntries(Object.entries({ engine: validatedProfile.engine, ...env }).sort(([left], [right]) => left.localeCompare(right)))))
    .digest('hex');
  const identity = createHash('sha256')
    .update([validatedProfile.adapter_contract, nodeTool.sha256, entrypointTool.sha256, revision, trackedTreeIdentity, packageVersion, configurationIdentity].join('\n'))
    .digest('hex');
  return Object.freeze({
    adapterContract: validatedProfile.adapter_contract,
    runtimeKind: adapter.runtime_kind,
    nodeExecutable: nodeTool.path,
    entrypoint: entrypointTool.path,
    packageRoot: packageRoot.path,
    gitExecutable: gitTool.path,
    revision,
    packageVersion,
    engine: validatedProfile.engine,
    env,
    configurationIdentity,
    trackedTreeIdentity,
    identity
  });
}

export function projectMediaTranscriptProviderTrust(trust) {
  return {
    adapter_contract: trust.adapterContract,
    runtime_kind: trust.runtimeKind,
    provider_version: trust.packageVersion,
    provider_revision: trust.revision,
    toolchain_identity: trust.identity,
    provider_configuration_identity: trust.configurationIdentity ?? trust.identity,
    engine: trust.engine,
    absolute_paths_included: false,
    environment_values_included: false
  };
}

async function inspectTrustedTool(filePath, { expectedSha256 = null, executable = false, allowMappedSystemOwner = false } = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.includes('\u0000')) {
    throw trustError('MEDIA_PROVIDER_TOOL_INVALID', 'A trusted transcript provider tool path is invalid.');
  }
  const resolved = await realpath(filePath);
  if (resolved !== filePath) throw trustError('MEDIA_PROVIDER_TOOL_REALPATH_MISMATCH', 'A trusted transcript provider tool path is not canonical.');
  const info = await lstat(filePath, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size > BigInt(MAX_HASHED_TOOL_BYTES)) {
    throw trustError('MEDIA_PROVIDER_TOOL_INVALID', 'A trusted transcript provider tool is unsafe.');
  }
  const mappedSystemOwner = allowMappedSystemOwner
    && info.uid === 65534n
    && (filePath.startsWith('/usr/bin/') || filePath.startsWith('/bin/'))
    && typeof expectedSha256 === 'string';
  if (typeof process.getuid === 'function' && info.uid !== 0n && info.uid !== BigInt(process.getuid()) && !mappedSystemOwner) {
    throw trustError('MEDIA_PROVIDER_TOOL_OWNER_INVALID', 'A trusted transcript provider tool has an unexpected owner.');
  }
  const mode = Number(info.mode & 0o777n);
  if ((mode & 0o022) !== 0 || (executable && (mode & 0o111) === 0)) {
    throw trustError('MEDIA_PROVIDER_TOOL_PERMISSIONS_INVALID', 'A trusted transcript provider tool has unsafe permissions.');
  }
  const handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  const hash = createHash('sha256');
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size || opened.mtimeNs !== info.mtimeNs) {
      throw trustError('MEDIA_PROVIDER_TOOL_CHANGED', 'A trusted transcript provider tool changed while it was inspected.');
    }
    const buffer = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const completed = await handle.stat({ bigint: true });
    if (completed.dev !== opened.dev || completed.ino !== opened.ino || completed.size !== opened.size || completed.mtimeNs !== opened.mtimeNs) {
      throw trustError('MEDIA_PROVIDER_TOOL_CHANGED', 'A trusted transcript provider tool changed while it was inspected.');
    }
  } finally {
    await handle.close();
  }
  const sha256 = hash.digest('hex');
  if (expectedSha256 && sha256 !== expectedSha256) {
    throw trustError('MEDIA_PROVIDER_TOOL_HASH_MISMATCH', 'A trusted transcript provider tool hash does not match the profile.');
  }
  return { path: filePath, sha256 };
}

async function inspectTrustedPackageRoot(packageRoot) {
  if (typeof packageRoot !== 'string' || !path.isAbsolute(packageRoot) || packageRoot.includes('\u0000')) {
    throw trustError('MEDIA_PROVIDER_PACKAGE_ROOT_INVALID', 'The transcript provider package root is invalid.');
  }
  const resolved = await realpath(packageRoot);
  if (resolved !== packageRoot) throw trustError('MEDIA_PROVIDER_PACKAGE_ROOT_REALPATH_MISMATCH', 'The transcript provider package root is not canonical.');
  const info = await lstat(packageRoot, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) throw trustError('MEDIA_PROVIDER_PACKAGE_ROOT_INVALID', 'The transcript provider package root is invalid.');
  if (typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid())) {
    throw trustError('MEDIA_PROVIDER_PACKAGE_ROOT_OWNER_INVALID', 'The transcript provider package root has an unexpected owner.');
  }
  if ((Number(info.mode & 0o777n) & 0o022) !== 0) throw trustError('MEDIA_PROVIDER_PACKAGE_ROOT_PERMISSIONS_INVALID', 'The transcript provider package root is writable by an unexpected principal.');
  return { path: packageRoot };
}

async function runGit(processRunner, gitExecutable, packageRoot, args, env) {
  const body = await runGitBuffer(processRunner, gitExecutable, packageRoot, args, env, 64 * 1024);
  return body.toString('utf8').trim();
}

async function runGitBuffer(processRunner, gitExecutable, packageRoot, args, env, maximumStdoutBytes) {
  const result = await processRunner({
    executable: gitExecutable,
    args: ['-C', packageRoot, ...GIT_TRUST_CONFIG, ...args],
    cwd: packageRoot,
    env,
    timeoutMs: 15_000,
    maxStdoutBytes: maximumStdoutBytes,
    maxStderrBytes: 64 * 1024
  });
  if (!result?.ok) throw trustError('MEDIA_PROVIDER_GIT_INSPECTION_FAILED', 'The transcript provider Git identity could not be verified.', result?.error?.code);
  return result.stdout;
}

async function inspectTrackedCheckout(processRunner, gitExecutable, packageRoot, revision, env) {
  const [flagBody, treeBody] = await Promise.all([
    runGitBuffer(processRunner, gitExecutable, packageRoot, ['ls-files', '-v', '-z'], env, MAX_GIT_INVENTORY_BYTES),
    runGitBuffer(processRunner, gitExecutable, packageRoot, ['ls-tree', '-r', '-z', '--full-tree', revision], env, MAX_GIT_INVENTORY_BYTES)
  ]);
  const indexPaths = parseNormalIndexInventory(flagBody);
  const treeEntries = parseCommitTreeInventory(treeBody);
  if (indexPaths.size !== treeEntries.length || treeEntries.some((entry) => !indexPaths.has(entry.path))) {
    throw trustError('MEDIA_PROVIDER_TREE_INDEX_MISMATCH', 'The transcript provider index does not match the trusted revision.');
  }
  await Promise.all([
    runGitCleanCheck(processRunner, gitExecutable, packageRoot, ['diff-index', '--cached', '--quiet', revision, '--'], env),
    runGitCleanCheck(processRunner, gitExecutable, packageRoot, ['diff-files', '--quiet', '--'], env)
  ]);
  let totalBytes = 0;
  const identity = createHash('sha256');
  for (const entry of treeEntries) {
    const filePath = path.resolve(packageRoot, entry.path);
    const relative = path.relative(packageRoot, filePath);
    if (relative !== entry.path || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw trustError('MEDIA_PROVIDER_TREE_PATH_INVALID', 'The transcript provider tree contains an unsafe path.');
    }
    const inspected = await inspectTrackedFileMetadata(filePath, entry.mode);
    totalBytes += inspected.bytes;
    if (totalBytes > MAX_TRACKED_TREE_BYTES) {
      throw trustError('MEDIA_PROVIDER_TREE_BYTE_LIMIT', 'The transcript provider tracked tree exceeds the trust inspection limit.');
    }
    identity.update(`${entry.mode} ${entry.objectId}\t${entry.path}\n`);
  }
  return identity.digest('hex');
}

async function runGitCleanCheck(processRunner, gitExecutable, packageRoot, args, env) {
  const result = await processRunner({
    executable: gitExecutable,
    args: ['-C', packageRoot, ...GIT_TRUST_CONFIG, '--no-pager', ...args],
    cwd: packageRoot,
    env,
    timeoutMs: 15_000,
    maxStdoutBytes: 64 * 1024,
    maxStderrBytes: 64 * 1024
  });
  if (result?.ok) return;
  if (result?.exit_code === 1) {
    throw trustError('MEDIA_PROVIDER_TREE_DIRTY', 'The transcript provider tracked checkout differs from the trusted revision.');
  }
  throw trustError('MEDIA_PROVIDER_GIT_INSPECTION_FAILED', 'The transcript provider Git identity could not be verified.', result?.error?.code);
}

function parseNormalIndexInventory(body) {
  const decoded = decodeGitInventory(body);
  const records = decoded.split('\0').filter(Boolean);
  if (records.length === 0 || records.length > MAX_TRACKED_FILES) {
    throw trustError('MEDIA_PROVIDER_TREE_FILE_LIMIT', 'The transcript provider index inventory is unsupported.');
  }
  const paths = new Set();
  for (const record of records) {
    if (!record.startsWith('H ')) {
      throw trustError('MEDIA_PROVIDER_TREE_INDEX_FLAGS', 'The transcript provider index contains non-normal tracked-file flags.');
    }
    const file = validateTrackedPath(record.slice(2));
    if (paths.has(file)) throw trustError('MEDIA_PROVIDER_TREE_INDEX_MISMATCH', 'The transcript provider index contains duplicate paths.');
    paths.add(file);
  }
  return paths;
}

function parseCommitTreeInventory(body) {
  const decoded = decodeGitInventory(body);
  const records = decoded.split('\0').filter(Boolean);
  if (records.length === 0 || records.length > MAX_TRACKED_FILES) {
    throw trustError('MEDIA_PROVIDER_TREE_FILE_LIMIT', 'The transcript provider commit tree inventory is unsupported.');
  }
  const entries = [];
  const paths = new Set();
  for (const record of records) {
    const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]+)$/u.exec(record);
    if (!match) throw trustError('MEDIA_PROVIDER_TREE_ENTRY_UNSUPPORTED', 'The transcript provider commit contains an unsupported tracked entry.');
    const file = validateTrackedPath(match[3]);
    if (paths.has(file)) throw trustError('MEDIA_PROVIDER_TREE_INDEX_MISMATCH', 'The transcript provider commit contains duplicate paths.');
    paths.add(file);
    entries.push({ mode: match[1], objectId: match[2], path: file });
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function decodeGitInventory(body) {
  if (!Buffer.isBuffer(body) || body.length === 0 || body.length > MAX_GIT_INVENTORY_BYTES) {
    throw trustError('MEDIA_PROVIDER_TREE_INVENTORY_INVALID', 'The transcript provider tree inventory is invalid.');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw trustError('MEDIA_PROVIDER_TREE_INVENTORY_INVALID', 'The transcript provider tree inventory is not valid UTF-8.');
  }
}

function validateTrackedPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value.includes('\0') || path.isAbsolute(value)) {
    throw trustError('MEDIA_PROVIDER_TREE_PATH_INVALID', 'The transcript provider tree contains an unsafe path.');
  }
  const normalized = path.normalize(value);
  if (normalized !== value || normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw trustError('MEDIA_PROVIDER_TREE_PATH_INVALID', 'The transcript provider tree contains an unsafe path.');
  }
  return value;
}

async function inspectTrackedFileMetadata(filePath, expectedMode) {
  const info = await lstat(filePath, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size > BigInt(MAX_HASHED_TOOL_BYTES)) {
    throw trustError('MEDIA_PROVIDER_TREE_FILE_INVALID', 'A tracked transcript provider file is unsafe.');
  }
  if (typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid())) {
    throw trustError('MEDIA_PROVIDER_TREE_FILE_OWNER_INVALID', 'A tracked transcript provider file has an unexpected owner.');
  }
  const mode = Number(info.mode & 0o777n);
  if ((mode & 0o022) !== 0 || ((mode & 0o111) !== 0) !== (expectedMode === '100755')) {
    throw trustError('MEDIA_PROVIDER_TREE_FILE_MODE_MISMATCH', 'A tracked transcript provider file mode differs from the trusted revision.');
  }
  return { bytes: Number(info.size) };
}

async function readPackageVersion(packageRoot) {
  const packagePath = path.join(packageRoot, 'package.json');
  const info = await lstat(packagePath, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size > 1024n * 1024n) {
    throw trustError('MEDIA_PROVIDER_PACKAGE_INVALID', 'The transcript provider package metadata is invalid.');
  }
  let parsed;
  try { parsed = JSON.parse(await readFile(packagePath, 'utf8')); } catch {
    throw trustError('MEDIA_PROVIDER_PACKAGE_INVALID', 'The transcript provider package metadata is invalid.');
  }
  if (typeof parsed.version !== 'string' || !/^[0-9A-Za-z.+-]{1,80}$/u.test(parsed.version)) {
    throw trustError('MEDIA_PROVIDER_PACKAGE_INVALID', 'The transcript provider package version is invalid.');
  }
  return parsed.version;
}

function buildProviderEnvironment(configured, allowedEnvironmentKeys) {
  const env = {};
  for (const [key, value] of Object.entries(configured ?? {})) {
    if (!allowedEnvironmentKeys.has(key) || typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw trustError('MEDIA_PROVIDER_ENVIRONMENT_INVALID', 'The transcript provider environment contains an unsupported entry.');
    }
    env[key] = value;
  }
  env.NO_COLOR = '1';
  return env;
}

async function validateProfileForAdapter(profile, context) {
  const allowedEnvironmentKeys = await resolveAllowedEnvironmentKeys(profile, context);
  return validateProfile(profile, allowedEnvironmentKeys);
}

async function resolveAllowedEnvironmentKeys(profile, context) {
  const adapter = await resolveProfileAdapter(profile, context);
  return new Set(adapter.allowed_environment_keys);
}

async function resolveProfileAdapter(profile, context) {
  const policy = await loadMediaReviewPolicy(context);
  const catalog = await loadMediaReviewAdapterCatalog(policy, context);
  return resolveMediaReviewAdapter(catalog, profile?.adapter_contract);
}

function validateProfile(profile, allowedEnvironmentKeys) {
  const topKeys = ['adapter_contract', 'engine', 'environment', 'runtime', 'schema_version'];
  if (!plainObject(profile) || extraKeys(profile, topKeys)
    || profile.schema_version !== PROFILE_SCHEMA_VERSION
    || !/^[a-z0-9][a-z0-9-]{2,80}$/u.test(profile.adapter_contract ?? '')
    || !/^[a-z0-9][a-z0-9-]{0,79}$/u.test(profile.engine ?? '')
    || !plainObject(profile.runtime)
    || !plainObject(profile.environment ?? {})) {
    throw trustError('MEDIA_PROVIDER_PROFILE_INVALID', 'The local transcript provider profile is invalid.');
  }
  const runtimeKeys = ['entrypoint', 'entrypoint_sha256', 'expected_revision', 'git_executable', 'git_sha256', 'node_executable', 'node_sha256', 'package_root', 'require_clean_tree'];
  if (extraKeys(profile.runtime, runtimeKeys)
    || !runtimeKeys.every((key) => Object.hasOwn(profile.runtime, key))
    || !/^[a-f0-9]{64}$/u.test(profile.runtime.node_sha256)
    || !/^[a-f0-9]{64}$/u.test(profile.runtime.entrypoint_sha256)
    || !/^[a-f0-9]{64}$/u.test(profile.runtime.git_sha256)
    || !/^[a-f0-9]{40}$/u.test(profile.runtime.expected_revision)
    || profile.runtime.require_clean_tree !== true) {
    throw trustError('MEDIA_PROVIDER_PROFILE_INVALID', 'The local transcript provider profile is invalid.');
  }
  buildProviderEnvironment(profile.environment ?? {}, allowedEnvironmentKeys);
  return Object.freeze({ ...profile, environment: { ...(profile.environment ?? {}) }, runtime: { ...profile.runtime } });
}

function extraKeys(value, allowed) {
  return Object.keys(value).some((key) => !allowed.includes(key));
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function trustError(code, message, reason = null) {
  const error = new Error(message);
  error.code = code;
  error.details = reason ? { reason } : {};
  return error;
}
