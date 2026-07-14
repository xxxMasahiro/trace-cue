import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readFile,
  realpath,
  stat,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import {
  buildOpenAiResponsesRequest,
  validateAndNormalizeTraceCueAdvisory
} from './agentic-human-review-responses-adapter.js';
import { CODEX_SUBSCRIPTION_CLI_CONTRACT } from './codex-subscription-cli-contract.js';
import { runFixedProcess } from './fixed-process-runner.js';
import { createSafeLocalStore } from './safe-local-store.js';

export const CODEX_SUBSCRIPTION_ADAPTER_ID = 'codex-subscription-cli';
export const CODEX_SUBSCRIPTION_ADAPTER_VERSION = '1.0.0';

const MAX_DISCOVERY_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_DISCOVERY_STDERR_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const MAX_SANDBOX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SANDBOX_TMPFS_BYTES = 16 * 1024 * 1024;
const MAX_ACTIVE_STAGING_DIRECTORIES = 32;
const MAX_STAGING_SCAN_DIRECTORIES = 64;
const STALE_STAGING_AGE_MS = 60 * 60 * 1000;
const STAGING_ADMISSION_LOCK = 'staging-admission';
const SAFE_MODEL_ID = /^[a-zA-Z0-9._:/@+-]{1,160}$/u;
const BUBBLEWRAP_EXECUTABLE = '/usr/bin/bwrap';
const PRLIMIT_EXECUTABLE = '/usr/bin/prlimit';
const SANDBOX_CODEX_EXECUTABLE = '/tracecue/bin/codex';
const SANDBOX_WORKSPACE = '/tracecue/work';
const REQUIRED_HELP_MARKERS = Object.freeze([
  '--config',
  '--model',
  '--sandbox',
  '--ephemeral',
  '--ignore-user-config',
  '--ignore-rules',
  '--strict-config',
  '--skip-git-repo-check',
  '--output-schema',
  '--output-last-message',
  '--color',
  '--cd',
  '--disable'
]);

export async function probeCodexSubscriptionCli(context = {}) {
  const executable = await resolveCodexExecutable(context);
  if (!executable.ok) return executable;
  let staging = null;
  let auth = null;
  const boundary = {
    processStarted: false,
    dispatchMayHaveOccurred: false,
    rawOutputTemporarilyStaged: false,
    credentialValuesRead: false
  };
  try {
    staging = await createPrivateStagingDirectory(context);
    auth = await openCodexAuthFile(context);
    const common = async (args, { authRequired = false } = {}) => {
      const result = await runSandboxedCodex({
        executable,
        auth: authRequired ? auth : null,
        staging,
        args,
        isolateNetwork: true,
        timeoutMs: normalizeTimeout(context.codexDiscoveryTimeoutMs, 15_000),
        maxStdoutBytes: MAX_DISCOVERY_STDOUT_BYTES,
        maxStderrBytes: MAX_DISCOVERY_STDERR_BYTES,
        context
      });
      boundary.processStarted ||= result.process_started === true;
      boundary.credentialValuesRead ||= result.credential_values_read === true;
      return result;
    };
    const fail = (code, message, details = {}) => probeFailure(code, message, { ...boundary, details });
    const versionResult = await common(['--version']);
    if (!versionResult.ok) return fail('CONTROL_CENTER_CODEX_VERSION_UNAVAILABLE', 'Codex could not be checked on this computer.');
    const version = decodeUtf8(versionResult.stdout)?.trim();
    if (version !== `codex-cli ${executable.package_version}`) {
      return fail('CONTROL_CENTER_CODEX_VERSION_INVALID', 'This Codex installation does not match its verified package version.');
    }
    const versionContract = CODEX_SUBSCRIPTION_CLI_CONTRACT.versions[executable.package_version];
    if (!versionContract) {
      return fail('CONTROL_CENTER_CODEX_VERSION_UNSUPPORTED', 'This Codex version has not been approved for private Control Center execution.');
    }

    const helpResult = await common(['exec', '--help']);
    const help = helpResult.ok ? decodeUtf8(helpResult.stdout) : null;
    if (!help || REQUIRED_HELP_MARKERS.some((marker) => !help.includes(marker))) {
      return fail('CONTROL_CENTER_CODEX_EXECUTION_CONTRACT_UNAVAILABLE', 'This Codex version cannot be used safely from the Control Center.');
    }

    const featuresResult = await common(['features', 'list']);
    const features = featuresResult.ok ? parseFeatureCatalog(decodeUtf8(featuresResult.stdout)) : null;
    if (!features || !sameStringList(features.catalog, versionContract.feature_catalog)) {
      return fail('CONTROL_CENTER_CODEX_FEATURES_UNAVAILABLE', 'This Codex version cannot confirm its approved execution controls.');
    }

    const loginResult = auth.ok ? await common(['login', 'status'], { authRequired: true }) : null;
    const loginText = loginResult?.ok
      ? `${decodeUtf8(loginResult.stdout) ?? ''}\n${decodeUtf8(loginResult.stderr) ?? ''}`
      : '';
    const loggedIn = typeof loginText === 'string' && /logged in using/iu.test(loginText);

    const modelsResult = await common(['debug', 'models', '--bundled']);
    if (!modelsResult.ok) return fail('CONTROL_CENTER_CODEX_MODELS_UNAVAILABLE', 'Codex could not provide a safe model list.');
    const models = parseCodexModelCatalog(modelsResult.stdout);
    if (!models.ok) return fail(models.error.code, models.error.message, models.error.details);
    return {
      ok: true,
      adapter_id: CODEX_SUBSCRIPTION_ADAPTER_ID,
      adapter_version: CODEX_SUBSCRIPTION_ADAPTER_VERSION,
      cli_version: version,
      executable_identity_hash: executable.identity_hash,
      login_ready: loggedIn,
      execution_contract_hash: hashJson({
        adapter_version: CODEX_SUBSCRIPTION_ADAPTER_VERSION,
        cli_version: version,
        package_version: executable.package_version,
        required_help_markers: REQUIRED_HELP_MARKERS,
        feature_catalog: features.catalog
      }),
      disabled_features: features.disable,
      models: models.models,
      default_model_id: models.default_model_id,
      process_started: boundary.processStarted,
      dispatch_may_have_occurred: false,
      raw_output_temporarily_staged: false,
      raw_output_stored: false,
      credential_values_read: boundary.credentialValuesRead,
      credential_values_recorded: false,
      network_used_for_discovery: false,
      network_isolation_verified: true,
      filesystem_read_scope: 'private_sandbox_only',
      shell_used: false
    };
  } catch {
    return probeFailure(
      'CONTROL_CENTER_CODEX_STAGING_UNAVAILABLE',
      'The private Codex work area is unavailable.',
      boundary
    );
  } finally {
    await auth?.handle?.close().catch(() => {});
    await executable.handle?.close().catch(() => {});
    await staging?.cleanup().catch(() => {});
  }
}

export async function runCodexSubscriptionReview({
  traceCueRequest,
  model,
  providerEffort,
  executableIdentityHash,
  maxRequestBytes = 128 * 1024,
  maxResponseBytes = 256 * 1024,
  context = {}
} = {}) {
  const probe = await probeCodexSubscriptionCli(context);
  if (!probe.ok) return { ...probe, dispatch_may_have_occurred: false };
  const probeBoundary = {
    processStarted: probe.process_started === true,
    dispatchMayHaveOccurred: false,
    rawOutputTemporarilyStaged: false,
    credentialValuesRead: probe.credential_values_read === true
  };
  const reviewBoundary = { ...probeBoundary };
  if (!probe.login_ready) return probeFailure('CONTROL_CENTER_CODEX_LOGIN_REQUIRED', 'Sign in to Codex, then update availability.', probeBoundary);
  if (probe.executable_identity_hash !== executableIdentityHash) {
    return probeFailure('CONTROL_CENTER_CODEX_EXECUTABLE_CHANGED', 'Codex changed after it was selected. Update availability again.', probeBoundary);
  }
  const selectedModel = probe.models.find((item) => item.id === model);
  if (!selectedModel || !selectedModel.native_efforts.some((item) => item.id === providerEffort)) {
    return probeFailure('CONTROL_CENTER_CODEX_SELECTION_CHANGED', 'The selected Codex model or processing level is no longer available.', probeBoundary);
  }

  const generatedAt = materializeNow(context.now).toISOString();
  const providerRequest = buildOpenAiResponsesRequest({
    traceCueRequest,
    model,
    generatedAt
  });
  const prompt = `${providerRequest.instructions}\n\nReturn only JSON that matches the supplied schema.\n\n${providerRequest.input}`;
  const requestBytes = Buffer.byteLength(prompt, 'utf8');
  if (requestBytes > maxRequestBytes) {
    return probeFailure('CONTROL_CENTER_CODEX_REQUEST_TOO_LARGE', 'The approved review package is too large for this AI service.', probeBoundary);
  }
  let staging = null;
  let executable = null;
  let auth = null;
  try {
    staging = await createPrivateStagingDirectory(context);
    const schemaPath = path.join(staging.path, 'response.schema.json');
    const resultPath = path.join(staging.path, 'response.json');
    await writeFile(schemaPath, `${JSON.stringify(providerRequest.text.format.schema)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await writeFile(resultPath, '', { mode: 0o600, flag: 'wx' });
    executable = await resolveCodexExecutable(context);
    if (!executable.ok || executable.identity_hash !== executableIdentityHash) {
      return probeFailure('CONTROL_CENTER_CODEX_EXECUTABLE_CHANGED', 'Codex changed before the review started. Update availability again.', probeBoundary);
    }
    auth = await openCodexAuthFile(context);
    if (!auth.ok) return probeFailure('CONTROL_CENTER_CODEX_LOGIN_REQUIRED', 'Sign in to Codex, then update availability.', probeBoundary);
    const args = [
      'exec',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--strict-config',
      '--skip-git-repo-check',
      '--sandbox', 'read-only',
      '--model', model,
      '--output-schema', `${SANDBOX_WORKSPACE}/response.schema.json`,
      '--output-last-message', `${SANDBOX_WORKSPACE}/response.json`,
      '--color', 'never',
      '--config', 'approval_policy="never"',
      '--config', 'mcp_servers={}',
      '--config', 'web_search="disabled"',
      '--config', 'shell_environment_policy.inherit="none"',
      '--config', `model_reasoning_effort=${JSON.stringify(providerEffort)}`,
      '--cd', SANDBOX_WORKSPACE
    ];
    for (const feature of probe.disabled_features) args.push('--disable', feature);
    args.push('-');
    const execution = await runSandboxedCodex({
      executable,
      auth,
      staging,
      args,
      isolateNetwork: false,
      stdin: prompt,
      timeoutMs: normalizeTimeout(context.codexExecutionTimeoutMs, 5 * 60 * 1000),
      maxStdoutBytes: MAX_RESULT_BYTES,
      maxStderrBytes: MAX_DISCOVERY_STDERR_BYTES,
      signal: context.signal,
      schemaPath,
      resultPath,
      context
    });
    mergeExecutionBoundary(reviewBoundary, execution);
    if (!execution.ok) {
      return {
        ...execution,
        error: {
          code: 'CONTROL_CENTER_CODEX_EXECUTION_FAILED',
          message: 'Codex did not return a verified review result.',
          details: {}
        },
        request_bytes: requestBytes,
        process_started: reviewBoundary.processStarted,
        dispatch_may_have_occurred: reviewBoundary.dispatchMayHaveOccurred,
        raw_output_temporarily_staged: reviewBoundary.rawOutputTemporarilyStaged,
        raw_output_stored: false,
        credential_values_read: reviewBoundary.credentialValuesRead,
        credential_values_recorded: false
      };
    }
    const result = await readBoundedJsonResult(resultPath, Math.min(maxResponseBytes, MAX_RESULT_BYTES));
    if (!result.ok) {
      return {
        ...result,
        process_started: reviewBoundary.processStarted,
        dispatch_may_have_occurred: reviewBoundary.dispatchMayHaveOccurred,
        request_bytes: requestBytes,
        raw_output_temporarily_staged: reviewBoundary.rawOutputTemporarilyStaged,
        credential_values_read: reviewBoundary.credentialValuesRead,
        credential_values_recorded: false
      };
    }
    const verified = validateAndNormalizeTraceCueAdvisory(result.value, traceCueRequest);
    if (!verified.ok) {
      return probeFailure(
        'CONTROL_CENTER_CODEX_RESULT_CONTRACT_MISMATCH',
        'Codex returned a result that did not satisfy the approved TraceCue review contract.',
        {
          ...reviewBoundary,
          details: { contract_code: verified.code, path: verified.details?.path ?? null, keyword: verified.details?.keyword ?? null }
        }
      );
    }
    return {
      ok: true,
      input: verified.value,
      request_bytes: requestBytes,
      response_bytes: result.bytes,
      process_started: reviewBoundary.processStarted,
      dispatch_may_have_occurred: reviewBoundary.dispatchMayHaveOccurred,
      raw_output_temporarily_staged: reviewBoundary.rawOutputTemporarilyStaged,
      raw_output_stored: false,
      credential_values_read: reviewBoundary.credentialValuesRead,
      credential_values_recorded: false,
      filesystem_read_scope: 'private_sandbox_only',
      network_scope: 'provider_connection_with_cli_features_disabled',
      shell_used: false
    };
  } catch {
    const postDispatch = reviewBoundary.dispatchMayHaveOccurred;
    return probeFailure(
      postDispatch ? 'CONTROL_CENTER_CODEX_EXECUTION_FAILED' : 'CONTROL_CENTER_CODEX_STAGING_UNAVAILABLE',
      postDispatch ? 'Codex did not return a verified review result.' : 'The private Codex work area is unavailable.',
      reviewBoundary
    );
  } finally {
    await auth?.handle?.close().catch(() => {});
    await executable?.handle?.close().catch(() => {});
    await staging?.cleanup().catch(() => {});
  }
}

function mergeExecutionBoundary(boundary, observed) {
  boundary.processStarted ||= observed?.process_started === true;
  boundary.dispatchMayHaveOccurred ||= observed?.dispatch_may_have_occurred === true;
  boundary.rawOutputTemporarilyStaged ||= observed?.raw_output_temporarily_staged === true;
  boundary.credentialValuesRead ||= observed?.credential_values_read === true;
}

async function resolveCodexExecutable(context) {
  if ((context.platform ?? process.platform) !== 'linux') {
    return probeFailure('CONTROL_CENTER_CODEX_PLATFORM_UNSUPPORTED', 'The subscription connection requires a native Linux Codex installation.');
  }
  const candidates = executableCandidates(context.env ?? process.env);
  for (const candidate of candidates) {
    const resolved = await resolveCandidate(candidate, context);
    if (resolved.ok) return resolved;
  }
  return probeFailure('CONTROL_CENTER_CODEX_NOT_FOUND', 'Codex was not found in a safe local installation.');
}

export async function resolveCodexSubscriptionExecutable(context = {}) {
  return resolveCodexExecutable(context);
}

async function resolveCandidate(candidate, context) {
  let handle = null;
  let keepHandle = false;
  try {
    const info = await lstat(candidate);
    if (!info.isFile() && !info.isSymbolicLink()) return { ok: false };
    if (!await trustedDirectoryChain(path.dirname(candidate))) return { ok: false };
    const entrypoint = await realpath(candidate);
    if (!/\/@openai\/codex\/bin\/codex\.js$/u.test(entrypoint)
      || /(?:^|\/)(?:mnt\/[a-z]|windows)(?:\/|$)/iu.test(entrypoint)
      || !await trustedRegularFile(entrypoint)) return { ok: false };
    const prefix = await readPrefix(entrypoint, 256);
    if (!prefix.startsWith('#!/usr/bin/env node')) return { ok: false };
    const official = await resolveOfficialNativeCodex(entrypoint, context);
    if (!official.ok) return { ok: false };
    const executable = official.path;
    if (!await trustedDirectoryChain(path.dirname(executable)) || !await trustedRegularFile(executable, { executable: true })) return { ok: false };
    handle = await open(executable, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const executableStat = await handle.stat();
    const pathStat = await stat(executable);
    if (!sameFileIdentity(executableStat, pathStat)
      || !executableStat.isFile()
      || executableStat.nlink !== 1
      || executableStat.size < 1
      || executableStat.size > MAX_EXECUTABLE_BYTES
      || (executableStat.mode & 0o111) === 0) return { ok: false };
    const magic = await readPrefixFromHandle(handle, 4);
    if (magic.length !== 4 || magic[0] !== 0x7f || magic.subarray(1).toString('ascii') !== 'ELF') return { ok: false };
    const digest = await hashFileHandle(handle, executableStat.size, MAX_EXECUTABLE_BYTES);
    const completedStat = await handle.stat();
    const completedPathStat = await stat(executable);
    if (!sameFileIdentity(executableStat, completedStat)
      || !sameFileIdentity(completedStat, completedPathStat)
      || executableStat.size !== official.platform_contract.executable_bytes
      || digest !== official.platform_contract.executable_sha256) return { ok: false };
    keepHandle = true;
    return {
      ok: true,
      path: executable,
      handle,
      package_version: official.package_version,
      executable_digest: digest,
      executable_stat: executableStat,
      identity_hash: hashJson({
        digest,
        size: executableStat.size,
        mode: executableStat.mode & 0o777,
        device: executableStat.dev,
        inode: executableStat.ino,
        package_version: official.package_version,
        adapter: CODEX_SUBSCRIPTION_ADAPTER_VERSION
      })
    };
  } catch {
    return { ok: false };
  } finally {
    if (handle && !keepHandle) await handle.close().catch(() => {});
  }
}

async function resolveOfficialNativeCodex(entrypoint, context) {
  const packageRoot = path.resolve(path.dirname(entrypoint), '..');
  if (!await trustedDirectoryChain(packageRoot)) return { ok: false };
  const packageJsonPath = path.join(packageRoot, 'package.json');
  if (!await trustedRegularFile(packageJsonPath)) return { ok: false };
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  const packageVersion = typeof packageJson?.version === 'string' ? packageJson.version.trim() : '';
  if (packageJson?.name !== CODEX_SUBSCRIPTION_CLI_CONTRACT.package_name
    || !CODEX_SUBSCRIPTION_CLI_CONTRACT.versions[packageVersion]) return { ok: false };
  const architecture = context.arch ?? process.arch;
  const versionContract = CODEX_SUBSCRIPTION_CLI_CONTRACT.versions[packageVersion];
  const platformContract = versionContract.platforms?.[architecture];
  if (!platformContract) return { ok: false };
  const platformRoot = path.join(packageRoot, 'node_modules', '@openai', platformContract.package_name);
  const platformPackagePath = path.join(platformRoot, 'package.json');
  if (!await trustedRegularFile(platformPackagePath)) return { ok: false };
  const platformPackageJson = JSON.parse(await readFile(platformPackagePath, 'utf8'));
  if (platformPackageJson?.name !== CODEX_SUBSCRIPTION_CLI_CONTRACT.package_name
    || platformPackageJson?.version !== platformContract.package_version
    || !Array.isArray(platformPackageJson?.os)
    || !platformPackageJson.os.includes('linux')
    || !Array.isArray(platformPackageJson?.cpu)
    || !platformPackageJson.cpu.includes(architecture)) return { ok: false };
  const executable = await realpath(path.join(platformRoot, 'vendor', platformContract.target, 'bin', 'codex'));
  const relative = path.relative(packageRoot, executable);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return { ok: false };
  return {
    ok: true,
    path: executable,
    package_version: packageVersion,
    platform_contract: platformContract
  };
}

function executableCandidates(env) {
  const values = [];
  for (const segment of String(env.PATH ?? '').split(path.delimiter)) {
    if (!segment || !path.isAbsolute(segment)) continue;
    const candidate = path.join(segment, 'codex');
    if (!values.includes(candidate)) values.push(candidate);
  }
  return values.slice(0, 64);
}

async function openCodexAuthFile(context) {
  let handle = null;
  try {
    const env = context.env ?? process.env;
    const home = typeof env.HOME === 'string' && path.isAbsolute(env.HOME) ? env.HOME : null;
    const codexHome = typeof env.CODEX_HOME === 'string' && path.isAbsolute(env.CODEX_HOME)
      ? env.CODEX_HOME
      : home ? path.join(home, '.codex') : null;
    if (!codexHome || !await trustedDirectoryChain(codexHome)) return { ok: false };
    const authPath = path.join(codexHome, 'auth.json');
    handle = await open(authPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size < 2 || info.size > 512 * 1024 || (info.mode & 0o077) !== 0 || !trustedOwner(info.uid)) {
      await handle.close();
      return { ok: false };
    }
    return { ok: true, handle };
  } catch {
    await handle?.close().catch(() => {});
    return { ok: false };
  }
}

async function runSandboxedCodex({
  executable,
  auth,
  staging,
  args,
  isolateNetwork,
  stdin = null,
  timeoutMs,
  maxStdoutBytes,
  maxStderrBytes,
  signal = null,
  schemaPath = null,
  resultPath = null,
  context
}) {
  if (!await trustedSystemExecutable(BUBBLEWRAP_EXECUTABLE)
    || !await trustedSystemExecutable(PRLIMIT_EXECUTABLE)) {
    return probeFailure('CONTROL_CENTER_CODEX_SANDBOX_UNAVAILABLE', 'The private Codex execution sandbox is unavailable.');
  }
  if (!await verifyPinnedExecutable(executable)) {
    return probeFailure('CONTROL_CENTER_CODEX_EXECUTABLE_CHANGED', 'Codex changed before the private execution started.');
  }
  const inheritedFds = [executable.handle.fd];
  if (schemaPath !== null || resultPath !== null) {
    if (!schemaPath || !resultPath
      || path.dirname(schemaPath) !== staging.path
      || path.dirname(resultPath) !== staging.path
      || !await trustedPrivateRegularFile(schemaPath, { maxBytes: MAX_RESULT_BYTES, allowEmpty: false })
      || !await trustedPrivateRegularFile(resultPath, { maxBytes: MAX_RESULT_BYTES, allowEmpty: true })) {
      return probeFailure('CONTROL_CENTER_CODEX_STAGING_INVALID', 'The private Codex result area is unavailable.');
    }
  }
  if (auth?.ok) {
    inheritedFds.push(auth.handle.fd);
  }
  const sslFiles = [];
  if (!isolateNetwork) {
    for (const file of ['/etc/ssl/certs/ca-certificates.crt', '/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf']) {
      if (await trustedSystemReadableFile(file)) sslFiles.push(file);
    }
  }
  const invocation = buildCodexSandboxInvocation({
    isolateNetwork,
    hasAuth: auth?.ok === true,
    schemaPath,
    resultPath,
    sslFiles,
    cliArgs: args
  });
  const result = await runFixedProcess({
    executable: invocation.executable,
    args: invocation.args,
    cwd: staging.path,
    env: { PATH: '/usr/bin:/bin', HOME: staging.path, LANG: 'C.UTF-8', NO_COLOR: '1' },
    stdin,
    timeoutMs,
    maxStdoutBytes,
    maxStderrBytes,
    signal,
    inheritedFds,
    spawnImpl: context.spawn,
    platform: context.platform ?? process.platform
  });
  const processStarted = result.process_started === true;
  return {
    ...result,
    process_started: processStarted,
    dispatch_may_have_occurred: processStarted && !isolateNetwork,
    raw_output_temporarily_staged: processStarted && Boolean(schemaPath && resultPath),
    raw_output_stored: false,
    credential_values_read: processStarted && auth?.ok === true,
    credential_values_recorded: false,
    shell_used: false
  };
}

export function buildCodexSandboxInvocation({
  isolateNetwork,
  hasAuth = false,
  schemaPath = null,
  resultPath = null,
  sslFiles = [],
  cliArgs = []
} = {}) {
  const sandboxArgs = [
    '--die-with-parent',
    '--new-session',
    '--unshare-all',
    ...(isolateNetwork ? [] : ['--share-net']),
    '--cap-drop', 'ALL',
    '--proc', '/proc',
    '--dev', '/dev',
    '--size', String(MAX_SANDBOX_TMPFS_BYTES),
    '--tmpfs', '/tmp',
    '--dir', '/tracecue',
    '--size', String(MAX_SANDBOX_TMPFS_BYTES),
    '--tmpfs', '/tracecue',
    '--dir', '/tracecue/bin',
    '--dir', '/tracecue/home',
    '--dir', '/tracecue/codex-home',
    '--dir', '/tracecue/xdg-config',
    '--dir', '/tracecue/xdg-cache',
    '--dir', SANDBOX_WORKSPACE,
    '--ro-bind-fd', '3', SANDBOX_CODEX_EXECUTABLE
  ];
  if (schemaPath && resultPath) {
    sandboxArgs.push(
      '--ro-bind', schemaPath, `${SANDBOX_WORKSPACE}/response.schema.json`,
      '--bind', resultPath, `${SANDBOX_WORKSPACE}/response.json`
    );
  }
  if (hasAuth) sandboxArgs.push('--file', '4', '/tracecue/codex-home/auth.json');
  if (!isolateNetwork) {
    sandboxArgs.push('--dir', '/etc', '--dir', '/etc/ssl', '--dir', '/etc/ssl/certs');
    for (const file of sslFiles) sandboxArgs.push('--ro-bind', file, file);
  }
  sandboxArgs.push(
    '--clearenv',
    '--setenv', 'HOME', '/tracecue/home',
    '--setenv', 'CODEX_HOME', '/tracecue/codex-home',
    '--setenv', 'XDG_CONFIG_HOME', '/tracecue/xdg-config',
    '--setenv', 'XDG_CACHE_HOME', '/tracecue/xdg-cache',
    '--setenv', 'TMPDIR', '/tmp',
    '--setenv', 'PATH', '/nonexistent',
    '--setenv', 'LANG', 'C.UTF-8',
    '--setenv', 'NO_COLOR', '1',
    '--setenv', 'SSL_CERT_FILE', '/etc/ssl/certs/ca-certificates.crt',
    '--chdir', SANDBOX_WORKSPACE,
    SANDBOX_CODEX_EXECUTABLE,
    ...cliArgs
  );
  return Object.freeze({
    executable: PRLIMIT_EXECUTABLE,
    args: Object.freeze([`--fsize=${MAX_SANDBOX_FILE_BYTES}`, '--', BUBBLEWRAP_EXECUTABLE, ...sandboxArgs])
  });
}

async function verifyPinnedExecutable(executable) {
  try {
    const current = await executable.handle.stat();
    const pathInfo = await stat(executable.path);
    return typeof executable.executable_digest === 'string'
      && sameFileIdentity(current, executable.executable_stat)
      && sameFileIdentity(current, pathInfo);
  } catch {
    return false;
  }
}

export async function verifyCodexSubscriptionExecutable(executable) {
  return verifyPinnedExecutable(executable);
}

async function trustedSystemExecutable(file) {
  try {
    const target = await realpath(file);
    const info = await stat(target);
    return target === file
      && info.isFile()
      && info.uid === 0
      && (info.mode & 0o022) === 0
      && (info.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

async function trustedSystemReadableFile(file) {
  try {
    const info = await stat(file);
    return info.isFile() && info.uid === 0 && (info.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

async function trustedPrivateRegularFile(file, { maxBytes, allowEmpty }) {
  try {
    const info = await lstat(file);
    return info.isFile()
      && !info.isSymbolicLink()
      && info.nlink === 1
      && info.uid === currentUid()
      && (info.mode & 0o077) === 0
      && info.size <= maxBytes
      && (allowEmpty || info.size > 0);
  } catch {
    return false;
  }
}

export function parseCodexModelCatalog(buffer) {
  const text = decodeUtf8(buffer);
  if (!text) return probeFailure('CONTROL_CENTER_CODEX_MODELS_INVALID', 'Codex returned invalid model information.');
  let parsed;
  try { parsed = JSON.parse(text); } catch { return probeFailure('CONTROL_CENTER_CODEX_MODELS_INVALID', 'Codex returned invalid model information.'); }
  const source = Array.isArray(parsed?.models) ? parsed.models : null;
  if (!source || source.length < 1 || source.length > 128) {
    return probeFailure('CONTROL_CENTER_CODEX_MODELS_INVALID', 'Codex returned invalid model information.');
  }
  const models = [];
  const slugs = new Set();
  for (const item of source) {
    const slug = String(item?.slug ?? '').trim();
    if (!item
      || !SAFE_MODEL_ID.test(slug)
      || slugs.has(slug)
      || !['list', 'hide'].includes(item.visibility)) {
      return probeFailure('CONTROL_CENTER_CODEX_MODELS_INVALID', 'Codex returned invalid model information.');
    }
    slugs.add(slug);
    if (item.visibility === 'hide') continue;
    if (!Number.isSafeInteger(item.priority) || item.priority < 0
      || !Array.isArray(item.supported_reasoning_levels)
      || item.supported_reasoning_levels.length < 1
      || item.supported_reasoning_levels.length > 32) {
      return probeFailure('CONTROL_CENTER_CODEX_MODELS_INVALID', 'Codex returned invalid model information.');
    }
    const efforts = [];
    for (const level of item.supported_reasoning_levels) {
      const id = String(level?.effort ?? '').trim();
      if (!SAFE_MODEL_ID.test(id) || efforts.some((existing) => existing.id === id)) {
        return probeFailure('CONTROL_CENTER_CODEX_MODELS_INVALID', 'Codex returned invalid model information.');
      }
      efforts.push({ id, display_name: humanizeEffort(id) });
    }
    if (!SAFE_MODEL_ID.test(String(item.default_reasoning_level ?? ''))
      || !efforts.some((level) => level.id === item.default_reasoning_level)) {
      return probeFailure('CONTROL_CENTER_CODEX_MODELS_INVALID', 'Codex returned invalid model information.');
    }
    models.push({
      id: slug,
      display_name: safeDisplayName(item.display_name, slug),
      native_efforts: efforts,
      default_native_effort_id: item.default_reasoning_level,
      priority: item.priority
    });
  }
  if (models.length === 0) {
    return probeFailure('CONTROL_CENTER_CODEX_MODELS_EMPTY', 'Codex did not return a deterministic model catalog.');
  }
  models.sort((left, right) => left.priority - right.priority || compareCodeUnits(left.id, right.id));
  return {
    ok: true,
    models: models.map(({ priority: _priority, ...model }) => model),
    default_model_id: models[0].id
  };
}

function parseFeatureCatalog(text) {
  if (typeof text !== 'string') return null;
  const entries = [];
  const seen = new Set();
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const match = /^([a-z][a-z0-9_]{1,80})\s+(removed|stable|experimental|deprecated|under development)\s+(?:true|false)$/u.exec(line.trim());
    if (!match || seen.has(match[1])) return null;
    seen.add(match[1]);
    entries.push({ name: match[1], stage: match[2] });
  }
  if (entries.length === 0) return null;
  entries.sort((left, right) => compareCodeUnits(left.name, right.name));
  return {
    catalog: entries.map((entry) => `${entry.name}:${entry.stage}`),
    disable: entries.filter((entry) => entry.stage !== 'removed').map((entry) => entry.name)
  };
}

async function readBoundedJsonResult(resultPath, maxBytes) {
  let handle;
  try {
    handle = await open(resultPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 2 || before.size > maxBytes) {
      return probeFailure('CONTROL_CENTER_CODEX_RESULT_INVALID', 'Codex returned an invalid review result.');
    }
    const body = await handle.readFile();
    const after = await handle.stat();
    if (body.length !== before.size
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs) {
      return probeFailure('CONTROL_CENTER_CODEX_RESULT_INVALID', 'Codex returned an invalid review result.');
    }
    const text = decodeUtf8(body);
    if (!text) return probeFailure('CONTROL_CENTER_CODEX_RESULT_INVALID', 'Codex returned an invalid review result.');
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
    return { ok: true, value, bytes: body.length };
  } catch {
    return probeFailure('CONTROL_CENTER_CODEX_RESULT_INVALID', 'Codex returned an invalid review result.');
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function createCodexPrivateStagingDirectory(context = {}) {
  return createPrivateStagingDirectory(context);
}

async function createPrivateStagingDirectory(context) {
  const cwd = await realpath(path.resolve(context.cwd ?? process.cwd()));
  const base = path.resolve(
    typeof context.codexStagingRoot === 'string'
      ? context.codexStagingRoot
      : typeof context.tmpdir === 'string'
        ? path.join(context.tmpdir, 'trace-cue-ai-staging')
        : path.join(cwd, '.browser-debug', 'control-center-ai-connections', 'sandbox-staging')
  );
  if (!isPathInside(cwd, base)) throw new Error('Codex staging must stay in the workspace.');
  const relativeRoot = path.relative(cwd, base);
  if (!relativeRoot || relativeRoot.startsWith('..') || path.isAbsolute(relativeRoot)) {
    throw new Error('Codex staging root must be a private child of the workspace.');
  }
  const store = createSafeLocalStore({
    workspaceRoot: cwd,
    relativeRoot,
    namespace: 'trace-cue-codex-subscription-staging-v1',
    maxRecordBytes: MAX_RESULT_BYTES,
    maxEntries: MAX_STAGING_SCAN_DIRECTORIES
  });
  const placeholder = await store.resolvePrivatePath('pending', { ensureParent: true });
  const privateBase = path.dirname(placeholder);
  const capacity = normalizeStagingCapacity(context.codexMaxActiveStagingDirectories);
  const directory = await store.withLock(STAGING_ADMISSION_LOCK, async () => {
    await removeStaleStagingDirectories(store, privateBase, materializeNow(context.now));
    const entries = await store.listDirectories({ limit: MAX_STAGING_SCAN_DIRECTORIES });
    const active = entries.filter(isStagingDirectoryName);
    if (active.length >= capacity) {
      const error = new Error('The private Codex work area is at capacity.');
      error.code = 'CONTROL_CENTER_CODEX_STAGING_LIMIT';
      throw error;
    }
    const created = await mkdtemp(path.join(privateBase, 'run-'));
    try {
      await chmod(created, 0o700);
      return created;
    } catch (error) {
      await store.removeDirectory(path.basename(created), { maxEntries: 8 }).catch(() => {});
      throw error;
    }
  });
  const name = path.basename(directory);
  return Object.freeze({
    path: directory,
    async cleanup() {
      await store.withLock(STAGING_ADMISSION_LOCK, () => store.removeDirectory(name, { maxEntries: 8 }));
    }
  });
}

async function readPrefix(file, bytes) {
  const handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    return (await readPrefixFromHandle(handle, bytes)).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function readPrefixFromHandle(handle, bytes) {
  const body = Buffer.alloc(bytes);
  const { bytesRead } = await handle.read(body, 0, bytes, 0);
  return body.subarray(0, bytesRead);
}

async function hashFileHandle(handle, size, maxBytes) {
  if (!Number.isSafeInteger(size) || size < 1 || size > maxBytes) throw new Error('Executable is too large.');
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(1024 * 1024);
  let position = 0;
  while (position < size) {
    const length = Math.min(buffer.length, size - position);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead < 1) throw new Error('Executable changed while it was being verified.');
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  if (position !== size) throw new Error('Executable changed while it was being verified.');
  return hash.digest('hex');
}

async function trustedDirectoryChain(directory) {
  try {
    let current = path.resolve(directory);
    if (await realpath(current) !== current) return false;
    while (true) {
      const info = await stat(current);
      if (!info.isDirectory() || !trustedOwner(info.uid) || (info.mode & 0o022) !== 0) return false;
      const parent = path.dirname(current);
      if (parent === current) return true;
      current = parent;
    }
  } catch {
    return false;
  }
}

async function trustedRegularFile(file, { executable = false } = {}) {
  try {
    const absolute = path.resolve(file);
    if (await realpath(absolute) !== absolute || !await trustedDirectoryChain(path.dirname(absolute))) return false;
    const info = await stat(absolute);
    return info.isFile()
      && info.nlink === 1
      && trustedOwner(info.uid)
      && (info.mode & 0o022) === 0
      && (!executable || (info.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

function trustedOwner(uid) {
  return uid === 0 || uid === currentUid();
}

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : -1;
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.mode === right.mode;
}

async function removeStaleStagingDirectories(store, base, now) {
  const entries = await store.listDirectories({ limit: MAX_STAGING_SCAN_DIRECTORIES });
  const candidates = entries
    .filter(isStagingDirectoryName)
    .slice(0, MAX_STAGING_SCAN_DIRECTORIES);
  for (const entry of candidates) {
    const target = path.join(base, entry);
    try {
      const info = await lstat(target);
      if (!info.isDirectory()
        || info.isSymbolicLink()
        || info.uid !== currentUid()
        || (info.mode & 0o077) !== 0
        || now.getTime() - info.mtimeMs < STALE_STAGING_AGE_MS) continue;
      await store.removeDirectory(entry, { maxEntries: 8 });
    } catch {}
  }
}

function isStagingDirectoryName(value) {
  return /^run-[a-zA-Z0-9_-]{1,120}$/u.test(value);
}

function isPathInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sameStringList(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function decodeUtf8(buffer) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { return null; }
}

function humanizeEffort(value) {
  return value.slice(0, 1).toUpperCase() + value.slice(1).replaceAll('_', ' ');
}

function safeDisplayName(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text.length <= 160 && !/[\u0000-\u001f\u007f]/u.test(text) ? text : fallback;
}

function normalizeTimeout(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 100 && number <= 10 * 60 * 1000 ? number : fallback;
}

function normalizeStagingCapacity(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1 && number <= MAX_ACTIVE_STAGING_DIRECTORIES
    ? number
    : MAX_ACTIVE_STAGING_DIRECTORIES;
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function materializeNow(value) {
  const candidate = typeof value === 'function' ? value() : value;
  const date = candidate instanceof Date ? candidate : candidate ? new Date(candidate) : new Date();
  if (Number.isNaN(date.getTime())) throw new Error('Current time is invalid.');
  return date;
}

function hashJson(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function probeFailure(code, message, {
  processStarted = false,
  dispatchMayHaveOccurred = false,
  rawOutputTemporarilyStaged = false,
  credentialValuesRead = false,
  details = {}
} = {}) {
  return {
    ok: false,
    error: { code, message, details },
    process_started: processStarted === true,
    dispatch_may_have_occurred: dispatchMayHaveOccurred === true,
    raw_output_temporarily_staged: rawOutputTemporarilyStaged === true,
    raw_output_stored: false,
    credential_values_read: credentialValuesRead === true,
    credential_values_recorded: false,
    shell_used: false
  };
}
