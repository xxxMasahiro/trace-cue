import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, open, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CONTROL_CENTER_AI_REFRESH_CONFIRM,
  CONTROL_CENTER_AI_SELECTION_CONFIRM,
  createControlCenterAiConnectionRecord,
  discoverControlCenterAiConnections,
  executeAgenticHumanReviewSubscriptionProvider,
  getSchema,
  projectControlCenterAiConnections,
  readControlCenterAiConnections,
  readControlCenterAiConnectionRecord,
  resolveControlCenterAiSelection,
  runControlCenterAiConnectionsRefresh,
  runControlCenterAiSelectionSave,
  resolveAgenticHumanReviewProvider,
  startControlCenterServer,
  validateControlCenterAiConnectionRecord
} from '../src/api.js';
import {
  buildCodexSandboxInvocation,
  createCodexPrivateStagingDirectory,
  parseCodexModelCatalog,
  probeCodexSubscriptionCli
} from '../src/codex-subscription-adapter.js';
import { CODEX_SUBSCRIPTION_CLI_CONTRACT } from '../src/codex-subscription-cli-contract.js';
import { runFixedProcess } from '../src/fixed-process-runner.js';
import { createControlCenterTestAssetRoot } from './helpers/control-center-test-assets.js';

const NOW = new Date('2026-07-14T00:00:00.000Z');

function apiConnection() {
  return {
    id: 'configured-review-service',
    display_name: 'Example Review AI',
    connection_type: 'api',
    status: 'available',
    status_message: 'Ready to use.',
    adapter_id: 'configured-api-adapter',
    adapter_version: '1.0.0',
    provider_id: 'generic-api-provider',
    transport: 'provider_api',
    execution_strategy: 'one-shot',
    provider_effort_request_field: 'reasoning.effort',
    provider_capability_hash: 'a'.repeat(64),
    executable_identity_hash: null,
    models: [{
      id: 'provider/review-model@2026-07',
      display_name: 'Review Model',
      native_efforts: [
        { id: 'medium', display_name: 'Recommended' },
        { id: 'high', display_name: 'Thorough' }
      ],
      default_native_effort_id: 'medium'
    }],
    default_model_id: 'provider/review-model@2026-07'
  };
}

test('AI connection projection exposes simple opaque choices and binds the exact approved tuple', () => {
  const record = createControlCenterAiConnectionRecord({ connections: [apiConnection()], observedAt: NOW });
  const projection = projectControlCenterAiConnections(record, { now: NOW });
  assert.equal(projection.status, 'available');
  assert.equal(projection.selection.connection_name, 'Example Review AI');
  assert.equal(projection.selection.model_name, 'Review Model');
  assert.equal(projection.selection.effort_name, 'Recommended');
  assert.match(projection.selection.connection_option_id, /^connection_[a-f0-9]{20}$/u);
  assert.doesNotMatch(JSON.stringify(projection), /generic-api-provider|configured-api-adapter|provider\/review-model/u);

  const selected = resolveControlCenterAiSelection(record, {
    connection_option_id: projection.selection.connection_option_id,
    model_option_id: projection.selection.model_option_id,
    effort_option_id: projection.connections[0].models[0].efforts.find((item) => item.name === 'Thorough').option_id,
    capability_revision: projection.revision,
    capability_token: projection.capability_token
  }, { now: NOW });
  assert.equal(selected.ok, true);
  assert.equal(selected.binding.model_id, 'provider/review-model@2026-07');
  assert.equal(selected.binding.provider_effort, 'high');
  assert.equal(selected.binding.provider_effort_request_field, 'reasoning.effort');
  assert.equal(Object.hasOwn(projection, 'semantic_capability_hash'), false);
  assert.equal(Object.hasOwn(projection.selection, 'semantic_capability_hash'), false);

  const tampered = structuredClone(record);
  tampered.connections[0].models[0].id = 'changed-model';
  assert.equal(validateControlCenterAiConnectionRecord(tampered, { now: NOW }).ok, false);
  assert.equal(projectControlCenterAiConnections(record, { now: new Date('2026-07-16T00:00:00.000Z') }).status, 'stale');

  for (const omitted of ['capability_revision', 'capability_token', 'connection_option_id', 'model_option_id', 'effort_option_id']) {
    const incomplete = {
      connection_option_id: projection.selection.connection_option_id,
      model_option_id: projection.selection.model_option_id,
      effort_option_id: projection.selection.effort_option_id,
      capability_revision: projection.revision,
      capability_token: projection.capability_token
    };
    delete incomplete[omitted];
    const rejected = resolveControlCenterAiSelection(record, incomplete, { now: NOW });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, 'CONTROL_CENTER_AI_SELECTION_INCOMPLETE');
  }

  const reordered = apiConnection();
  reordered.models[0].native_efforts.reverse();
  const reorderedRecord = createControlCenterAiConnectionRecord({ connections: [reordered], observedAt: NOW });
  assert.equal(reorderedRecord.semantic_capability_hash, record.semantic_capability_hash);

  const replacement = apiConnection();
  replacement.id = 'replacement-review-service';
  const refreshedWithoutSelection = createControlCenterAiConnectionRecord({
    connections: [replacement],
    previousRevision: record.revision,
    previousSettingsRevision: record.settings_revision,
    observedAt: NOW,
    selection: record.selection
  });
  assert.equal(projectControlCenterAiConnections(refreshedWithoutSelection, { now: NOW }).selection, null);
});

test('AI connection public schema is available through the schema registry', async () => {
  const schema = getSchema('control_center_ai_connections');
  const source = JSON.parse(await readFile(new URL('../schemas/control-center-ai-connections.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(schema, source);
  assert.equal(schema.title, 'TraceCue Control Center AI Connections Projection');
  assert.equal(schema.properties.technical_details_included.const, false);
  assert.equal(schema.properties.can_continue_without_ai.const, true);
});

test('AI availability refresh and selection use explicit actions, private storage, and revision checks', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-ai-connections-'));
  await mkdir(path.join(cwd, '.browser-debug', 'control-center-ai-connections', 'staging'), {
    recursive: true,
    mode: 0o700
  });
  const context = {
    cwd,
    now: () => NOW,
    async discoverControlCenterAiConnections() {
      return {
        connections: [apiConnection()],
        boundary: { process_spawned: false, network_used: false, credential_values_read: true }
      };
    }
  };
  const denied = await runControlCenterAiConnectionsRefresh({ expected_revision: 0 }, context);
  assert.equal(denied.status, 'error');
  assert.equal(denied.errors[0].code, 'CONTROL_CENTER_AI_REFRESH_CONFIRM_REQUIRED');

  const refreshed = await runControlCenterAiConnectionsRefresh({
    confirm: CONTROL_CENTER_AI_REFRESH_CONFIRM,
    expected_revision: 0
  }, context);
  assert.equal(refreshed.status, 'ok');
  assert.equal(refreshed.data.ai_connections.storage_revision, 1);
  assert.equal(refreshed.data.boundary.credential_values_recorded, false);
  const choices = refreshed.data.ai_connections;
  const saved = await runControlCenterAiSelectionSave({
    confirm: CONTROL_CENTER_AI_SELECTION_CONFIRM,
    expected_revision: choices.storage_revision,
    connection_option_id: choices.selection.connection_option_id,
    model_option_id: choices.selection.model_option_id,
    effort_option_id: choices.connections[0].models[0].efforts.find((item) => item.name === 'Thorough').option_id,
    capability_revision: choices.revision,
    capability_token: choices.capability_token
  }, context);
  assert.equal(saved.status, 'ok');
  assert.equal(saved.data.ai_connections.selection.effort_name, 'Thorough');
  assert.equal(saved.data.ai_connections.storage_revision, 2);

  const conflict = await runControlCenterAiSelectionSave({
    confirm: CONTROL_CENTER_AI_SELECTION_CONFIRM,
    expected_revision: 1,
    connection_option_id: choices.selection.connection_option_id,
    model_option_id: choices.selection.model_option_id,
    effort_option_id: choices.selection.effort_option_id,
    capability_revision: choices.revision,
    capability_token: choices.capability_token
  }, context);
  assert.equal(conflict.status, 'error');
  assert.equal(conflict.errors[0].code, 'CONTROL_CENTER_AI_CONNECTION_REVISION_CONFLICT');

  const stored = await readControlCenterAiConnectionRecord(context);
  assert.equal(stored.ok, true);
  assert.equal(stored.record.settings_revision, 2);
  const storePath = path.join(cwd, '.browser-debug', 'control-center-ai-connections', 'state', 'connections.json');
  const body = await readFile(storePath, 'utf8');
  assert.doesNotMatch(body, /credential|api[_-]?key|secret-value|https:\/\//iu);
  assert.equal((await stat(storePath)).mode & 0o077, 0);
});

test('Control Center dashboard stays passive and refreshes AI availability only after an explicit protected action', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-ai-server-'));
  const assetRoot = await createControlCenterTestAssetRoot(cwd);
  let discoveries = 0;
  const started = await startControlCenterServer({ port: 0, assetRoot }, {
    cwd,
    now: () => NOW,
    async discoverControlCenterAiConnections() {
      discoveries += 1;
      return { connections: [apiConnection()], boundary: { process_spawned: false, network_used: false } };
    }
  });
  try {
    const dashboardResponse = await fetch(new URL('/api/dashboard', started.url));
    const dashboard = await dashboardResponse.json();
    assert.equal(dashboardResponse.status, 200);
    assert.equal(discoveries, 0);
    assert.equal(dashboard.data.control_center.ai_connections.status, 'not_checked');
    const token = dashboard.data.control_center.action_security.token;
    const refreshResponse = await fetch(new URL('/api/settings/ai-connections/refresh', started.url), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: started.url.slice(0, -1),
        'X-Trace-Cue-Action-Token': token
      },
      body: JSON.stringify({ confirm: CONTROL_CENTER_AI_REFRESH_CONFIRM, expected_revision: 0 })
    });
    const refreshed = await refreshResponse.json();
    assert.equal(refreshResponse.status, 200);
    assert.equal(discoveries, 1);
    assert.equal(refreshed.data.ai_connections.status, 'available');
    assert.equal(started.metadata.control_center_preference_endpoints.includes('/api/settings/ai-connections/refresh'), true);
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
  }
});

test('passive reads never inspect API credentials and an explicit refresh persists only safe choices', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-ai-transient-'));
  const context = {
    cwd,
    now: () => NOW,
    agenticReviewProviderId: 'generic-api-provider',
    agenticReviewServiceName: 'Example Review AI',
    env: {
      AGENTIC_HUMAN_REVIEW_API_ENDPOINT: 'https://review.example.test/v1/responses',
      AGENTIC_HUMAN_REVIEW_API_TOKEN: 'z7',
      AGENTIC_HUMAN_REVIEW_OPENAI_MODEL: 'review-model'
    }
  };
  const passive = await readControlCenterAiConnections(context);
  assert.equal(passive.status, 'not_checked');
  assert.equal(passive.connections.length, 0);
  assert.equal(passive.storage_revision, 0);
  const refreshed = await runControlCenterAiConnectionsRefresh({
    confirm: CONTROL_CENTER_AI_REFRESH_CONFIRM,
    expected_revision: 0
  }, context);
  assert.equal(refreshed.status, 'ok');
  assert.equal(refreshed.data.boundary.credential_values_read, true);
  const choices = refreshed.data.ai_connections;
  const high = choices.connections[0].models[0].efforts.find((item) => item.name === 'High');
  const saved = await runControlCenterAiSelectionSave({
    confirm: CONTROL_CENTER_AI_SELECTION_CONFIRM,
    expected_revision: choices.storage_revision,
    connection_option_id: choices.selection.connection_option_id,
    model_option_id: choices.selection.model_option_id,
    effort_option_id: high.option_id,
    capability_revision: choices.revision,
    capability_token: choices.capability_token
  }, context);
  assert.equal(saved.status, 'ok');
  assert.equal(saved.data.ai_connections.selection.effort_name, 'High');
  assert.equal(saved.data.boundary.credential_values_read, false);
  assert.equal(saved.data.boundary.credential_values_recorded, false);
});

test('AI discovery reports no spawned process when the local subscription CLI is unsupported', async () => {
  const discovered = await discoverControlCenterAiConnections({
    platform: 'win32',
    env: {},
    controlCenterAiConnections: []
  });
  assert.equal(discovered.ok, true);
  assert.equal(discovered.boundary.process_spawned, false);
  assert.equal(discovered.boundary.network_used, false);
  assert.equal(discovered.boundary.credential_values_read, false);
});

test('fixed process runner never uses a shell and bounds timeout and output', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-fixed-process-'));
  const success = await runFixedProcess({
    executable: '/usr/bin/printf',
    args: ['hello'],
    cwd,
    env: { PATH: '/usr/bin:/bin' }
  });
  assert.equal(success.ok, true);
  assert.equal(success.stdout.toString('utf8'), 'hello');
  assert.equal(success.shell_used, false);

  const invalid = await runFixedProcess({ executable: 'printf', args: [], cwd, env: {} });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'FIXED_PROCESS_EXECUTABLE_INVALID');

  const tooMuch = await runFixedProcess({
    executable: '/usr/bin/printf',
    args: ['x'.repeat(2048)],
    cwd,
    env: {},
    maxStdoutBytes: 1024
  });
  assert.equal(tooMuch.ok, false);
  assert.equal(tooMuch.error.code, 'FIXED_PROCESS_OUTPUT_LIMIT');

  const tooMuchStderr = await runFixedProcess({
    executable: process.execPath,
    args: ['-e', "process.stderr.write('x'.repeat(2048))"],
    cwd,
    env: {},
    maxStderrBytes: 1024
  });
  assert.equal(tooMuchStderr.ok, false);
  assert.equal(tooMuchStderr.error.code, 'FIXED_PROCESS_OUTPUT_LIMIT');

  const tooMuchInput = await runFixedProcess({
    executable: '/usr/bin/printf',
    args: [],
    cwd,
    env: {},
    stdin: Buffer.alloc(4 * 1024 * 1024 + 1)
  });
  assert.equal(tooMuchInput.ok, false);
  assert.equal(tooMuchInput.error.code, 'FIXED_PROCESS_INPUT_LIMIT');

  const timedOut = await runFixedProcess({
    executable: '/usr/bin/sleep',
    args: ['2'],
    cwd,
    env: {},
    timeoutMs: 100
  });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.error.code, 'FIXED_PROCESS_TIMEOUT');

  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), 25);
  const aborted = await runFixedProcess({
    executable: '/usr/bin/sleep',
    args: ['2'],
    cwd,
    env: {},
    timeoutMs: 2000,
    signal: controller.signal
  });
  clearTimeout(abortTimer);
  assert.equal(aborted.ok, false);
  assert.equal(aborted.error.code, 'FIXED_PROCESS_ABORTED');

  const inheritedPath = path.join(cwd, 'inherited.txt');
  await writeFile(inheritedPath, 'inherited-only\n', { mode: 0o600 });
  const inheritedHandle = await open(inheritedPath, 'r');
  try {
    const inherited = await runFixedProcess({
      executable: process.execPath,
      args: ['-e', "process.stdout.write(require('node:fs').readFileSync(3, 'utf8'))"],
      cwd,
      env: {},
      inheritedFds: [inheritedHandle.fd]
    });
    assert.equal(inherited.ok, true);
    assert.equal(inherited.stdout.toString('utf8'), 'inherited-only\n');
  } finally {
    await inheritedHandle.close();
  }

  const descendantPidPath = path.join(cwd, 'descendant.pid');
  const parentProgram = [
    "const { spawn } = require('node:child_process')",
    "const { writeFileSync } = require('node:fs')",
    `const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' })`,
    `writeFileSync(${JSON.stringify(descendantPidPath)}, String(child.pid))`,
    "process.on('SIGTERM', () => {})",
    "setInterval(() => {}, 1000)"
  ].join(';');
  const groupedController = new AbortController();
  const groupedPromise = runFixedProcess({
    executable: process.execPath,
    args: ['-e', parentProgram],
    cwd,
    env: {},
    timeoutMs: 5000,
    signal: groupedController.signal
  });
  let descendantPidText;
  let readinessError = null;
  try {
    descendantPidText = await waitForFileText(descendantPidPath, 3000);
  } catch (error) {
    readinessError = error;
  }
  groupedController.abort();
  const grouped = await groupedPromise;
  if (readinessError) throw readinessError;
  assert.equal(grouped.ok, false);
  assert.equal(grouped.error.code, 'FIXED_PROCESS_ABORTED');
  const descendantPid = Number(descendantPidText);
  for (let attempt = 0; attempt < 20 && processExists(descendantPid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(processExists(descendantPid), false);
});

test('Codex subscription contract pins official binaries and rejects a self-declared package layout', async (t) => {
  const testRoot = path.join(process.cwd(), '.browser-debug', 'control-center-ai-connections', 'tests');
  await mkdir(testRoot, { recursive: true, mode: 0o700 });
  await chmod(testRoot, 0o700);
  const cwd = await mkdtemp(path.join(testRoot, 'codex-adapter-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const installation = await createSelfDeclaredCodexInstallation(cwd);
  const platform = CODEX_SUBSCRIPTION_CLI_CONTRACT.versions['0.144.1'].platforms[installation.architecture];
  assert.match(platform.executable_sha256, /^[a-f0-9]{64}$/u);
  assert.match(platform.npm_integrity_sha512, /^[a-f0-9]{128}$/u);
  assert.ok(platform.executable_bytes > 200 * 1024 * 1024);
  const env = {
    HOME: cwd,
    PATH: installation.bin
  };
  let spawned = false;
  const probe = await probeCodexSubscriptionCli({
    cwd,
    env,
    codexStagingRoot: path.join(cwd, 'private-staging'),
    spawn() {
      spawned = true;
      throw new Error('untrusted executable must not run');
    }
  });
  assert.equal(probe.ok, false);
  assert.equal(probe.error.code, 'CONTROL_CENTER_CODEX_NOT_FOUND');
  assert.equal(spawned, false);
});

test('Codex model discovery accepts dynamic native efforts and rejects malformed catalogs without fallback', () => {
  const valid = {
    models: [{
      slug: 'provider/review-model',
      display_name: 'Review Model',
      visibility: 'list',
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }],
      default_reasoning_level: 'ultra',
      priority: 1
    }]
  };
  const parsed = parseCodexModelCatalog(Buffer.from(JSON.stringify(valid)));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.models[0].default_native_effort_id, 'ultra');
  assert.deepEqual(parsed.models[0].native_efforts.map((item) => item.id), ['low', 'ultra']);

  const equalPriority = structuredClone(valid);
  equalPriority.models.push({ ...structuredClone(valid.models[0]), slug: 'provider/Review-model' });
  const deterministicallyOrdered = parseCodexModelCatalog(Buffer.from(JSON.stringify(equalPriority)));
  assert.equal(deterministicallyOrdered.ok, true);
  assert.deepEqual(deterministicallyOrdered.models.map((item) => item.id), [
    'provider/Review-model',
    'provider/review-model'
  ]);

  for (const mutate of [
    (value) => { delete value.models[0].default_reasoning_level; },
    (value) => { value.models[0].default_reasoning_level = 'unsupported'; },
    (value) => { value.models[0].priority = '1'; },
    (value) => { value.models[0].visibility = 'unexpected'; },
    (value) => { value.models[0].supported_reasoning_levels.push({ effort: 'low' }); },
    (value) => { value.models.push(structuredClone(value.models[0])); }
  ]) {
    const malformed = structuredClone(valid);
    mutate(malformed);
    const rejected = parseCodexModelCatalog(Buffer.from(JSON.stringify(malformed)));
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, 'CONTROL_CENTER_CODEX_MODELS_INVALID');
  }
});

test('Codex sandbox invocation isolates discovery and bounds the single writable review result', () => {
  const discovery = buildCodexSandboxInvocation({
    isolateNetwork: true,
    cliArgs: ['debug', 'models', '--bundled']
  });
  assert.equal(discovery.executable, '/usr/bin/prlimit');
  assert.equal(discovery.args.includes('--unshare-all'), true);
  assert.equal(discovery.args.includes('--share-net'), false);
  assert.equal(discovery.args.includes('--clearenv'), true);
  assert.equal(discovery.args.includes('--ro-bind-fd'), true);
  assert.equal(discovery.args.includes('--file'), false);
  assert.equal(discovery.args.filter((item) => item === '--tmpfs').length, 2);

  const schemaPath = '/private/run/response.schema.json';
  const resultPath = '/private/run/response.json';
  const execution = buildCodexSandboxInvocation({
    isolateNetwork: false,
    hasAuth: true,
    schemaPath,
    resultPath,
    sslFiles: ['/etc/ssl/certs/ca-certificates.crt'],
    cliArgs: ['exec', '--model', 'provider/review-model', '--config', 'model_reasoning_effort="ultra"', '-']
  });
  assert.equal(execution.args[0], '--fsize=2097152');
  assert.equal(execution.args.includes('--share-net'), true);
  assert.deepEqual(execution.args.slice(execution.args.indexOf('--file'), execution.args.indexOf('--file') + 3), [
    '--file', '4', '/tracecue/codex-home/auth.json'
  ]);
  assert.deepEqual(execution.args.slice(execution.args.indexOf('--ro-bind', execution.args.indexOf(schemaPath) - 1), execution.args.indexOf('--ro-bind', execution.args.indexOf(schemaPath) - 1) + 6), [
    '--ro-bind', schemaPath, '/tracecue/work/response.schema.json',
    '--bind', resultPath, '/tracecue/work/response.json'
  ]);
  assert.equal(execution.args.includes('provider/review-model'), true);
  assert.equal(execution.args.includes('model_reasoning_effort="ultra"'), true);
  assert.equal(execution.args.filter((item) => item === '--bind').length, 1);
});

test('Codex bubblewrap boundary executes an inherited static binary when user namespaces are available', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('The audited subscription sandbox is Linux-only.');
    return;
  }
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-codex-bwrap-'));
  const preflight = await runFixedProcess({
    executable: '/usr/bin/bwrap',
    args: ['--die-with-parent', '--unshare-user', '--uid', '0', '--gid', '0', '--ro-bind', '/', '/', '--', '/usr/bin/true'],
    cwd,
    env: { PATH: '/usr/bin:/bin', HOME: cwd, LANG: 'C.UTF-8', NO_COLOR: '1' },
    timeoutMs: 10_000
  });
  if (!preflight.ok) {
    t.skip(`Bubblewrap user namespaces are unavailable in this runner (${preflight.error.code}).`);
    return;
  }
  let executableHandle;
  try {
    executableHandle = await open('/usr/bin/gh', 'r');
  } catch {
    t.skip('No local static probe executable is available.');
    return;
  }
  try {
    const invocation = buildCodexSandboxInvocation({ isolateNetwork: true, cliArgs: ['--version'] });
    const result = await runFixedProcess({
      executable: invocation.executable,
      args: invocation.args,
      cwd,
      env: { PATH: '/usr/bin:/bin', HOME: cwd, LANG: 'C.UTF-8', NO_COLOR: '1' },
      inheritedFds: [executableHandle.fd],
      timeoutMs: 10_000
    });
    assert.equal(result.ok, true, result.error?.code ?? 'The production sandbox invocation failed.');
    assert.match(result.stdout.toString('utf8'), /^gh version /u);
    assert.equal(result.stderr.length, 0);
  } finally {
    await executableHandle.close();
  }
});

test('Codex private staging serializes concurrent admission and fails closed at its bounded capacity', async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-codex-staging-capacity-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const context = {
    cwd,
    codexStagingRoot: path.join(cwd, 'private-staging'),
    codexMaxActiveStagingDirectories: 2,
    now: () => NOW
  };
  const attempts = await Promise.allSettled(
    Array.from({ length: 8 }, () => createCodexPrivateStagingDirectory(context))
  );
  const admitted = attempts.filter((attempt) => attempt.status === 'fulfilled').map((attempt) => attempt.value);
  const rejected = attempts.filter((attempt) => attempt.status === 'rejected');
  assert.equal(admitted.length, 2);
  assert.equal(rejected.length, 6);
  assert.equal(rejected.every((attempt) => new Set([
    'CONTROL_CENTER_CODEX_STAGING_LIMIT',
    'SAFE_STORE_LOCK_TIMEOUT'
  ]).has(attempt.reason?.code)), true);
  try {
    await assert.rejects(
      createCodexPrivateStagingDirectory(context),
      (error) => error?.code === 'CONTROL_CENTER_CODEX_STAGING_LIMIT'
    );
  } finally {
    await Promise.all(admitted.map((entry) => entry.cleanup()));
  }
  const admittedAfterCleanup = await createCodexPrivateStagingDirectory(context);
  await admittedAfterCleanup.cleanup();
});

test('Agentic Human Review keeps TraceCue effort independent while dispatching the exact subscription model effort', async () => {
  const resolved = resolveAgenticHumanReviewProvider({ providerId: 'codex-subscription-cli' });
  assert.equal(resolved.ok, true);
  const calls = [];
  const result = await executeAgenticHumanReviewSubscriptionProvider({
    provider: resolved.provider,
    model: { id: 'provider/review-model' },
    surface: { id: 'general-purpose-agent' },
    plan: {
      id: 'plan-subscription-integration',
      review_effort: { mode: 'standard' },
      provider_effort_binding: {
        requested_review_effort: 'standard',
        native_effort_applied_value: 'high'
      },
      connection_binding: {
        connection_type: 'subscription',
        adapter_id: 'codex-subscription-cli',
        provider_id: 'codex-subscription-cli',
        model_id: 'provider/review-model',
        provider_effort: 'high',
        executable_identity_hash: 'b'.repeat(64)
      }
    },
    planPath: '.browser-debug/agentic-human-review-plans/example/plan.json',
    reviewPackage: { type: 'agentic_human_review_package', task: { intent: 'Review this page.' } },
    transferFlags: { supplied_flags: [] },
    execution: { id: 'execution-subscription-integration' },
    context: {
      agenticReviewSubscriptionRunners: {
        'codex-subscription-cli': async (request) => {
          calls.push(request);
          return {
            ok: true,
            input: { summary: 'Subscription review completed.' },
            request_bytes: 128,
            response_bytes: 64
          };
        }
      }
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.input.summary, 'Subscription review completed.');
  assert.equal(result.boundary.provider_call_performed, true);
  assert.equal(result.boundary.api_call_performed, false);
  assert.equal(result.boundary.external_evidence_transfer, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'provider/review-model');
  assert.equal(calls[0].providerEffort, 'high');
  assert.equal(calls[0].executableIdentityHash, 'b'.repeat(64));
  assert.equal(calls[0].traceCueRequest.plan.review_effort.mode, 'standard');
});

async function createSelfDeclaredCodexInstallation(cwd) {
  const bin = path.join(cwd, 'bin');
  const packageRoot = path.join(cwd, 'node_modules', '@openai', 'codex');
  const entrypoint = path.join(packageRoot, 'bin', 'codex.js');
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';
  const platform = CODEX_SUBSCRIPTION_CLI_CONTRACT.versions['0.144.1'].platforms[architecture];
  const platformRoot = path.join(packageRoot, 'node_modules', '@openai', platform.package_name);
  const executable = path.join(platformRoot, 'vendor', platform.target, 'bin', 'codex');
  await mkdir(bin, { recursive: true });
  await mkdir(path.dirname(entrypoint), { recursive: true });
  await mkdir(path.dirname(executable), { recursive: true });
  await mkdir(path.join(cwd, '.codex'), { recursive: true });
  await writeFile(path.join(packageRoot, 'package.json'), `${JSON.stringify({ name: '@openai/codex', version: '0.144.1' })}\n`, { mode: 0o644 });
  await writeFile(path.join(platformRoot, 'package.json'), `${JSON.stringify({
    name: '@openai/codex',
    version: platform.package_version,
    os: ['linux'],
    cpu: [architecture]
  })}\n`, { mode: 0o644 });
  await writeFile(entrypoint, '#!/usr/bin/env node\n', { mode: 0o644 });
  await writeFile(executable, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x01]), { mode: 0o755 });
  await writeFile(path.join(cwd, '.codex', 'auth.json'), '{"tokens":{}}\n', { mode: 0o600 });
  await symlink(entrypoint, path.join(bin, 'codex'));
  return { bin, entrypoint, executable, architecture };
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function waitForFileText(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${path.basename(file)}.`);
}
