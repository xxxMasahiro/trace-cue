import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { githubRepositoryIdentity } from './github-repository-identity.mjs';
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';
import { globToRegExp, normalizeChangedPath, parseNameStatusZ } from './document-sync.mjs';

const execFile = promisify(execFileCallback);
const POLICY_FILE = 'ops/VERIFICATION_EXECUTION_POLICY.json';
const POLICY_KEYS = [
  'schema_version',
  'kind',
  'activation_mode',
  'command_execution',
  'unknown_state_policy',
  'cross_run_result_reuse',
  'persistent_result_cache',
  'evidence_policy',
  'limits',
  'tasks',
  'profiles',
  'focused_selectors',
  'focused_fallback_profiles',
  'ci_graph',
  'cache_policy'
];
const TASK_KEYS = ['id', 'label', 'argv', 'kind', 'locks', 'depends_on', 'provides'];
const SELECTOR_KEYS = ['id', 'patterns', 'profiles'];
const SAFE_ID = /^[a-z0-9][a-z0-9_.-]*$/u;
const FULL_SHA = /^[a-f0-9]{40}$/u;
const SHELLS = new Set(['bash', 'sh', 'zsh', 'fish', 'pwsh', 'powershell', 'cmd', 'cmd.exe']);
const KINDS = new Set(['parallel', 'serial', 'heavy']);

export class VerificationPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VerificationPolicyError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new VerificationPolicyError(code, message);
}

function assertObject(value, code, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code, `${label} must be an object.`);
}

function assertKeys(value, allowed, code, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) fail(code, `${label} contains unsupported field(s): ${unknown.join(', ')}.`);
}

function assertStrings(value, code, label, { empty = true } = {}) {
  if (!Array.isArray(value) || (!empty && value.length === 0) || value.some((item) => typeof item !== 'string' || !item)) {
    fail(code, `${label} must be ${empty ? 'an' : 'a non-empty'} array of non-empty strings.`);
  }
  if (new Set(value).size !== value.length) fail(code, `${label} must not contain duplicates.`);
}

function digest(value) {
  return createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : stableJson(value)).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function ensureInside(root, candidate, code) {
  const resolved = path.resolve(root, candidate ?? POLICY_FILE);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail(code, 'Policy path must stay inside the repository.');
  return resolved;
}

function validateArgv(argv, label) {
  assertStrings(argv, 'UNSAFE_ARGV', label, { empty: false });
  if (argv.some((item) => item.includes('\0') || item.includes('\n') || item.includes('\r'))) fail('UNSAFE_ARGV', `${label} contains control characters.`);
  const executable = path.basename(argv[0]).toLowerCase();
  if (path.isAbsolute(argv[0])) fail('UNSAFE_ARGV', `${label} must not use an absolute executable path.`);
  if (SHELLS.has(executable) && argv.slice(1).some((item) => item === '-c' || item === '/c' || item === '-Command')) {
    fail('UNSAFE_ARGV', `${label} must not evaluate a shell command string.`);
  }
}

function validatePositive(value, code, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(code, `${label} must be a positive integer.`);
}

function detectTaskCycles(tasksById) {
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) fail('TASK_CYCLE', `Task dependency cycle includes ${id}.`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of tasksById.get(id).depends_on) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of tasksById.keys()) visit(id);
}

export function validateVerificationPolicy(policy) {
  assertObject(policy, 'POLICY_TYPE', 'policy');
  assertKeys(policy, POLICY_KEYS, 'POLICY_FIELDS', 'policy');
  if (policy.schema_version !== '1.0.0') fail('POLICY_VERSION', 'Unsupported verification policy version.');
  if (policy.kind !== 'verification-execution-policy') fail('POLICY_KIND', 'Unexpected verification policy kind.');
  if (!['shadow', 'enforce'].includes(policy.activation_mode)) fail('POLICY_ACTIVATION', 'activation_mode must be shadow or enforce.');
  if (policy.command_execution !== 'argv') fail('POLICY_COMMAND', 'Commands must use argv execution.');
  if (policy.unknown_state_policy !== 'fail-closed') fail('POLICY_UNKNOWN', 'Unknown states must fail closed.');
  if (policy.cross_run_result_reuse !== 'disabled') fail('POLICY_REUSE', 'Cross-run result reuse must remain disabled.');
  if (policy.persistent_result_cache !== 'disabled') fail('POLICY_CACHE', 'Persistent result caching must remain disabled.');
  assertObject(policy.evidence_policy, 'EVIDENCE_POLICY_TYPE', 'evidence_policy');
  assertKeys(policy.evidence_policy, [
    'release_batch_required', 'release_profile', 'default_context', 'release_artifact_paths', 'ci_proof_source_id',
    'ci_proof_workflow_path', 'ci_proof_artifact_prefix', 'ci_proof_filename', 'ci_proof_repository_remote', 'ci_proof_repository_hosts', 'ci_proof_default_context',
    'remote_ci_replaces_local_release', 'max_future_observation_skew_ms', 'ci_proof_api_timeout_ms', 'store_limits'
  ], 'EVIDENCE_POLICY_FIELDS', 'evidence_policy');
  assertObject(policy.evidence_policy.store_limits, 'EVIDENCE_STORE_LIMITS_TYPE', 'evidence_policy.store_limits');
  assertKeys(policy.evidence_policy.store_limits, [
    'lock_timeout_ms', 'stale_lock_ms', 'receipt_retention_count', 'receipt_retention_bytes',
    'release_batch_retention_count', 'release_batch_retention_bytes', 'ingress_overflow_count', 'ingress_overflow_bytes'
  ], 'EVIDENCE_STORE_LIMITS_FIELDS', 'evidence_policy.store_limits');
  for (const field of [
    'lock_timeout_ms', 'stale_lock_ms', 'receipt_retention_count', 'receipt_retention_bytes',
    'release_batch_retention_count', 'release_batch_retention_bytes', 'ingress_overflow_count', 'ingress_overflow_bytes'
  ]) validatePositive(policy.evidence_policy.store_limits[field], 'EVIDENCE_STORE_LIMIT', `evidence_policy.store_limits.${field}`);
  if (policy.evidence_policy.release_batch_required !== true
    || typeof policy.evidence_policy.release_profile !== 'string'
    || !SAFE_ID.test(policy.evidence_policy.release_profile)
    || !['all', 'free-development', 'product-improvement', 'external-integration', 'lesson-maintenance', 'custom'].includes(policy.evidence_policy.default_context)
    || !Array.isArray(policy.evidence_policy.release_artifact_paths)
    || policy.evidence_policy.release_artifact_paths.length === 0
    || new Set(policy.evidence_policy.release_artifact_paths).size !== policy.evidence_policy.release_artifact_paths.length
    || policy.evidence_policy.release_artifact_paths.some((entry) => typeof entry !== 'string' || !entry
      || path.isAbsolute(entry) || entry.split(/[\\/]+/u).includes('..'))
    || policy.evidence_policy.ci_proof_source_id !== 'product.ci.final_proof'
    || typeof policy.evidence_policy.ci_proof_workflow_path !== 'string'
    || path.isAbsolute(policy.evidence_policy.ci_proof_workflow_path)
    || policy.evidence_policy.ci_proof_workflow_path.split(/[\\/]+/u).includes('..')
    || !/\.ya?ml$/u.test(policy.evidence_policy.ci_proof_workflow_path)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(policy.evidence_policy.ci_proof_artifact_prefix ?? '')
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/u.test(policy.evidence_policy.ci_proof_filename ?? '')
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(policy.evidence_policy.ci_proof_repository_remote ?? '')
    || !Array.isArray(policy.evidence_policy.ci_proof_repository_hosts)
    || policy.evidence_policy.ci_proof_repository_hosts.length === 0
    || policy.evidence_policy.ci_proof_repository_hosts.length > 16
    || policy.evidence_policy.ci_proof_repository_hosts.some((host) => typeof host !== 'string')
    || new Set(policy.evidence_policy.ci_proof_repository_hosts.map((host) => host.toLowerCase())).size !== policy.evidence_policy.ci_proof_repository_hosts.length
    || policy.evidence_policy.ci_proof_repository_hosts.some((host) => !/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u.test(host))
    || !['all', 'free-development', 'product-improvement', 'external-integration', 'lesson-maintenance', 'custom'].includes(policy.evidence_policy.ci_proof_default_context)
    || policy.evidence_policy.remote_ci_replaces_local_release !== false
    || !Number.isSafeInteger(policy.evidence_policy.max_future_observation_skew_ms)
    || policy.evidence_policy.max_future_observation_skew_ms < 0
    || !Number.isSafeInteger(policy.evidence_policy.ci_proof_api_timeout_ms)
    || policy.evidence_policy.ci_proof_api_timeout_ms < 1
    || policy.evidence_policy.store_limits.stale_lock_ms < policy.evidence_policy.store_limits.lock_timeout_ms) {
    fail('EVIDENCE_POLICY_BOUNDARY', 'Release evidence must be one local batch and remain separate from CI proof.');
  }

  assertObject(policy.limits, 'LIMITS_TYPE', 'limits');
  assertKeys(policy.limits, ['default_timeout_ms', 'cancellation_grace_ms', 'max_log_bytes', 'parallel_jobs', 'max_parallel_jobs'], 'LIMITS_FIELDS', 'limits');
  validatePositive(policy.limits.default_timeout_ms, 'LIMIT_TIMEOUT', 'default_timeout_ms');
  validatePositive(policy.limits.cancellation_grace_ms, 'LIMIT_GRACE', 'cancellation_grace_ms');
  validatePositive(policy.limits.max_log_bytes, 'LIMIT_LOG', 'max_log_bytes');
  validatePositive(policy.limits.max_parallel_jobs, 'LIMIT_JOBS', 'max_parallel_jobs');
  if (policy.limits.parallel_jobs !== 'auto') validatePositive(policy.limits.parallel_jobs, 'LIMIT_JOBS', 'parallel_jobs');

  if (!Array.isArray(policy.tasks) || policy.tasks.length === 0) fail('TASKS_EMPTY', 'tasks must be non-empty.');
  const tasksById = new Map();
  for (const [index, task] of policy.tasks.entries()) {
    assertObject(task, 'TASK_TYPE', `tasks[${index}]`);
    assertKeys(task, TASK_KEYS, 'TASK_FIELDS', `tasks[${index}]`);
    if (typeof task.id !== 'string' || !SAFE_ID.test(task.id)) fail('TASK_ID', `Invalid task id at tasks[${index}].`);
    if (tasksById.has(task.id)) fail('TASK_DUPLICATE', `Duplicate task id: ${task.id}.`);
    if (typeof task.label !== 'string' || !task.label) fail('TASK_LABEL', `Task ${task.id} needs a label.`);
    validateArgv(task.argv, `tasks.${task.id}.argv`);
    if (!KINDS.has(task.kind)) fail('TASK_KIND', `Task ${task.id} has an invalid kind.`);
    assertStrings(task.locks, 'TASK_LOCKS', `tasks.${task.id}.locks`);
    assertStrings(task.depends_on, 'TASK_DEPENDENCIES', `tasks.${task.id}.depends_on`);
    assertStrings(task.provides, 'TASK_PROVIDES', `tasks.${task.id}.provides`, { empty: false });
    tasksById.set(task.id, task);
  }
  for (const task of tasksById.values()) {
    for (const dependency of task.depends_on) if (!tasksById.has(dependency)) fail('TASK_DEPENDENCY', `Task ${task.id} references unknown dependency ${dependency}.`);
  }
  detectTaskCycles(tasksById);

  assertObject(policy.profiles, 'PROFILES_TYPE', 'profiles');
  if (!Object.keys(policy.profiles).length) fail('PROFILES_EMPTY', 'profiles must be non-empty.');
  for (const [profile, ids] of Object.entries(policy.profiles)) {
    if (!SAFE_ID.test(profile)) fail('PROFILE_ID', `Invalid profile id: ${profile}.`);
    assertStrings(ids, 'PROFILE_TASKS', `profiles.${profile}`);
    if (profile !== 'focused' && ids.length === 0) fail('PROFILE_EMPTY', `Profile ${profile} must not be empty.`);
    for (const id of ids) if (!tasksById.has(id)) fail('PROFILE_TASK', `Profile ${profile} references unknown task ${id}.`);
  }
  if (policy.evidence_policy.release_profile === 'focused'
    || !Object.hasOwn(policy.profiles, policy.evidence_policy.release_profile)
    || policy.profiles[policy.evidence_policy.release_profile].length === 0) {
    fail('EVIDENCE_PROFILE', 'The configured release evidence profile must be a complete non-empty profile.');
  }

  if (!Array.isArray(policy.focused_selectors) || !policy.focused_selectors.length) fail('SELECTORS_EMPTY', 'focused_selectors must be non-empty.');
  const selectorIds = new Set();
  for (const [index, selector] of policy.focused_selectors.entries()) {
    assertObject(selector, 'SELECTOR_TYPE', `focused_selectors[${index}]`);
    assertKeys(selector, SELECTOR_KEYS, 'SELECTOR_FIELDS', `focused_selectors[${index}]`);
    if (!SAFE_ID.test(selector.id) || selectorIds.has(selector.id)) fail('SELECTOR_ID', `Invalid or duplicate selector id: ${selector.id}.`);
    selectorIds.add(selector.id);
    assertStrings(selector.patterns, 'SELECTOR_PATTERNS', `focused_selectors.${selector.id}.patterns`, { empty: false });
    assertStrings(selector.profiles, 'SELECTOR_PROFILES', `focused_selectors.${selector.id}.profiles`);
    for (const profile of selector.profiles) if (!Object.hasOwn(policy.profiles, profile) || profile === 'focused') fail('SELECTOR_PROFILE', `Selector ${selector.id} references invalid profile ${profile}.`);
  }
  assertStrings(policy.focused_fallback_profiles, 'FOCUSED_FALLBACK', 'focused_fallback_profiles', { empty: false });
  for (const profile of policy.focused_fallback_profiles) if (!Object.hasOwn(policy.profiles, profile) || profile === 'focused') fail('FOCUSED_FALLBACK', `Unknown focused fallback profile ${profile}.`);

  validateCiGraph(policy.ci_graph);
  assertObject(policy.cache_policy, 'CACHE_TYPE', 'cache_policy');
  assertKeys(policy.cache_policy, ['playwright_binary_only', 'exact_key_required', 'restore_prefix_allowed', 'test_results_allowed', 'receipts_allowed'], 'CACHE_FIELDS', 'cache_policy');
  if (
    policy.cache_policy.playwright_binary_only !== true ||
    policy.cache_policy.exact_key_required !== true ||
    policy.cache_policy.restore_prefix_allowed !== false ||
    policy.cache_policy.test_results_allowed !== false ||
    policy.cache_policy.receipts_allowed !== false
  ) fail('CACHE_BOUNDARY', 'Cache policy must allow only exact-key Playwright binaries.');

  return policy;
}

function validateCiGraph(graph) {
  assertObject(graph, 'CI_GRAPH_TYPE', 'ci_graph');
  assertKeys(graph, ['workflow_contract', 'owners', 'final_job_id', 'final_name', 'final_if', 'final_runs_on', 'final_timeout_minutes', 'final_required_actions', 'final_required_run', 'final_required_step_order', 'required_jobs'], 'CI_GRAPH_FIELDS', 'ci_graph');
  validateCiWorkflowContract(graph.workflow_contract);
  if (!Array.isArray(graph.owners) || !graph.owners.length) fail('CI_OWNERS', 'ci_graph.owners must be non-empty.');
  const jobs = new Set();
  const instances = new Set();
  for (const [index, owner] of graph.owners.entries()) {
    assertObject(owner, 'CI_OWNER_TYPE', `ci_graph.owners[${index}]`);
    assertKeys(owner, ['job_id', 'name', 'execution_instance_ids', 'runs_on', 'timeout_minutes', 'required_needs', 'required_strategy', 'required_outputs', 'required_actions', 'required_run_metadata', 'required_step_order', 'required_commands'], 'CI_OWNER_FIELDS', `ci_graph.owners[${index}]`);
    if (typeof owner.job_id !== 'string' || !owner.job_id || jobs.has(owner.job_id)) fail('CI_OWNER_DUPLICATE', `Invalid or duplicate CI owner ${owner.job_id}.`);
    if (typeof owner.name !== 'string' || !owner.name) fail('CI_OWNER', `CI owner ${owner.job_id} needs a name.`);
    jobs.add(owner.job_id);
    assertStrings(owner.execution_instance_ids, 'CI_INSTANCES', `ci_graph.owners.${owner.job_id}.execution_instance_ids`, { empty: false });
    if (typeof owner.runs_on !== 'string' || !owner.runs_on) fail('CI_RUNNER', `CI owner ${owner.job_id} needs a runner label.`);
    validatePositive(owner.timeout_minutes, 'CI_TIMEOUT', `ci_graph.owners.${owner.job_id}.timeout_minutes`);
    assertStrings(owner.required_needs, 'CI_NEEDS', `ci_graph.owners.${owner.job_id}.required_needs`);
    assertObject(owner.required_strategy, 'CI_STRATEGY', `ci_graph.owners.${owner.job_id}.required_strategy`);
    assertObject(owner.required_outputs, 'CI_OUTPUTS', `ci_graph.owners.${owner.job_id}.required_outputs`);
    if (Object.values(owner.required_outputs).some((value) => typeof value !== 'string' || !value)) fail('CI_OUTPUTS', `CI owner ${owner.job_id} outputs must be non-empty strings.`);
    validateCiActions(owner.required_actions, `ci_graph.owners.${owner.job_id}.required_actions`);
    assertStrings(owner.required_commands, 'CI_COMMANDS', `ci_graph.owners.${owner.job_id}.required_commands`, { empty: false });
    validateCiRunMetadata(owner.required_run_metadata, `ci_graph.owners.${owner.job_id}.required_run_metadata`);
    if (owner.required_run_metadata.length !== owner.required_commands.length) fail('CI_RUNS', `CI owner ${owner.job_id} command metadata count must match commands.`);
    validateCiStepOrder(owner.required_step_order, owner.required_actions.length, owner.required_commands.length, `ci_graph.owners.${owner.job_id}.required_step_order`);
    validateCiExecutionInstances(owner);
    for (const id of owner.execution_instance_ids) {
      if (instances.has(id)) fail('CI_INSTANCE_DUPLICATE', `Execution instance ${id} has multiple owners.`);
      instances.add(id);
    }
  }
  if (typeof graph.final_job_id !== 'string' || !graph.final_job_id || jobs.has(graph.final_job_id)) fail('CI_FINAL', 'ci_graph.final_job_id must be a distinct job.');
  if (typeof graph.final_name !== 'string' || !graph.final_name || typeof graph.final_if !== 'string' || !graph.final_if) fail('CI_FINAL', 'ci_graph final name and condition must be non-empty.');
  if (typeof graph.final_runs_on !== 'string' || !graph.final_runs_on) fail('CI_RUNNER', 'ci_graph.final_runs_on must be a runner label.');
  validatePositive(graph.final_timeout_minutes, 'CI_TIMEOUT', 'ci_graph.final_timeout_minutes');
  validateCiActions(graph.final_required_actions, 'ci_graph.final_required_actions');
  assertObject(graph.final_required_run, 'CI_RUN', 'ci_graph.final_required_run');
  assertKeys(graph.final_required_run, ['run', 'id', 'env'], 'CI_RUN_FIELDS', 'ci_graph.final_required_run');
  if (typeof graph.final_required_run.run !== 'string' || !graph.final_required_run.run) fail('CI_RUN', 'ci_graph.final_required_run.run must be non-empty.');
  validateCiRunMetadata([graph.final_required_run], 'ci_graph.final_required_run');
  validateCiStepOrder(graph.final_required_step_order, graph.final_required_actions.length, 1, 'ci_graph.final_required_step_order');
  assertStrings(graph.required_jobs, 'CI_REQUIRED', 'ci_graph.required_jobs', { empty: false });
  if (graph.required_jobs.some((job) => !jobs.has(job)) || graph.required_jobs.some((job) => job === graph.final_job_id)) fail('CI_REQUIRED', 'ci_graph.required_jobs must reference every owner job only.');
  if (graph.required_jobs.length !== jobs.size) fail('CI_REQUIRED', 'Every CI owner must be required by the final job.');
}

function validateCiExecutionInstances(owner) {
  const strategy = owner.required_strategy;
  assertKeys(strategy, ['fail-fast', 'max-parallel', 'matrix'], 'CI_STRATEGY_FIELDS', `ci_graph.owners.${owner.job_id}.required_strategy`);
  if (strategy['fail-fast'] !== undefined && typeof strategy['fail-fast'] !== 'boolean') fail('CI_STRATEGY', `CI owner ${owner.job_id} fail-fast must be boolean.`);
  if (strategy['max-parallel'] !== undefined) validatePositive(strategy['max-parallel'], 'CI_STRATEGY', `${owner.job_id}.max-parallel`);
  if (strategy.matrix === undefined) {
    if (owner.execution_instance_ids.length !== 1) fail('CI_INSTANCES', `CI owner ${owner.job_id} without a matrix must have one execution instance.`);
    return;
  }
  assertObject(strategy.matrix, 'CI_MATRIX', `ci_graph.owners.${owner.job_id}.required_strategy.matrix`);
  const dimensions = Object.entries(strategy.matrix);
  if (dimensions.length === 0 || dimensions.some(([key]) => !SAFE_ID.test(key) || ['include', 'exclude'].includes(key))) {
    fail('CI_MATRIX', `CI owner ${owner.job_id} matrix dimensions are invalid.`);
  }
  let count = 1;
  const binding = stableJson({ name: owner.name, actions: owner.required_actions, commands: owner.required_commands, outputs: owner.required_outputs });
  for (const [key, values] of dimensions) {
    if (!Array.isArray(values) || values.length === 0 || values.some((value) => !['string', 'number', 'boolean'].includes(typeof value))) {
      fail('CI_MATRIX', `CI owner ${owner.job_id} matrix ${key} must contain scalar values.`);
    }
    count *= values.length;
    if (!binding.includes(`matrix.${key}`)) fail('CI_MATRIX', `CI owner ${owner.job_id} matrix ${key} is not bound by its configured steps.`);
  }
  if (!Number.isSafeInteger(count) || count !== owner.execution_instance_ids.length) {
    fail('CI_INSTANCES', `CI owner ${owner.job_id} matrix cardinality does not match execution instances.`);
  }
}

function validateCiWorkflowContract(contract) {
  assertObject(contract, 'CI_WORKFLOW', 'ci_graph.workflow_contract');
  assertKeys(contract, ['name', 'triggers', 'permissions', 'concurrency'], 'CI_WORKFLOW_FIELDS', 'ci_graph.workflow_contract');
  if (typeof contract.name !== 'string' || !contract.name) fail('CI_WORKFLOW', 'CI workflow name must be non-empty.');
  assertObject(contract.triggers, 'CI_TRIGGERS', 'ci_graph.workflow_contract.triggers');
  assertKeys(contract.triggers, ['pull_request', 'push', 'workflow_dispatch'], 'CI_TRIGGER_FIELDS', 'ci_graph.workflow_contract.triggers');
  if (contract.triggers.pull_request !== null) fail('CI_TRIGGERS', 'CI pull_request trigger must remain enabled without filters.');
  assertObject(contract.triggers.push, 'CI_TRIGGERS', 'ci_graph.workflow_contract.triggers.push');
  assertKeys(contract.triggers.push, ['branches'], 'CI_TRIGGER_FIELDS', 'ci_graph.workflow_contract.triggers.push');
  assertStrings(contract.triggers.push.branches, 'CI_TRIGGERS', 'ci_graph.workflow_contract.triggers.push.branches', { empty: false });
  assertObject(contract.triggers.workflow_dispatch, 'CI_TRIGGERS', 'ci_graph.workflow_contract.triggers.workflow_dispatch');
  assertKeys(contract.triggers.workflow_dispatch, ['inputs'], 'CI_TRIGGER_FIELDS', 'ci_graph.workflow_contract.triggers.workflow_dispatch');
  const inputs = contract.triggers.workflow_dispatch.inputs;
  assertObject(inputs, 'CI_TRIGGERS', 'ci_graph.workflow_contract.triggers.workflow_dispatch.inputs');
  assertKeys(inputs, ['base_sha'], 'CI_TRIGGER_FIELDS', 'ci_graph.workflow_contract.triggers.workflow_dispatch.inputs');
  assertObject(inputs.base_sha, 'CI_TRIGGERS', 'ci_graph.workflow_contract.triggers.workflow_dispatch.inputs.base_sha');
  assertKeys(inputs.base_sha, ['description', 'required', 'type'], 'CI_TRIGGER_FIELDS', 'ci_graph.workflow_contract.triggers.workflow_dispatch.inputs.base_sha');
  if (typeof inputs.base_sha.description !== 'string' || !inputs.base_sha.description
    || inputs.base_sha.required !== false || inputs.base_sha.type !== 'string') {
    fail('CI_TRIGGERS', 'CI manual base SHA input is invalid.');
  }
  if (stableJson(contract.permissions) !== stableJson({ contents: 'read' })) fail('CI_PERMISSIONS', 'CI permissions must remain read-only.');
  assertObject(contract.concurrency, 'CI_CONCURRENCY', 'ci_graph.workflow_contract.concurrency');
  assertKeys(contract.concurrency, ['group', 'cancel-in-progress'], 'CI_CONCURRENCY', 'ci_graph.workflow_contract.concurrency');
  if (typeof contract.concurrency.group !== 'string' || !contract.concurrency.group || contract.concurrency['cancel-in-progress'] !== true) {
    fail('CI_CONCURRENCY', 'CI concurrency must cancel superseded runs in a configured group.');
  }
}

function validateCiActions(actions, label) {
  if (!Array.isArray(actions) || actions.length === 0) fail('CI_ACTIONS', `${label} must be a non-empty action array.`);
  for (const [index, action] of actions.entries()) {
    assertObject(action, 'CI_ACTION', `${label}[${index}]`);
    assertKeys(action, ['uses', 'id', 'if', 'with'], 'CI_ACTION_FIELDS', `${label}[${index}]`);
    if (typeof action.uses !== 'string' || !action.uses) fail('CI_ACTION', `${label}[${index}].uses must be non-empty.`);
    if (action.id !== undefined && (typeof action.id !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(action.id))) fail('CI_ACTION', `${label}[${index}].id is invalid.`);
    if (action.if !== undefined && (typeof action.if !== 'string' || !action.if)) fail('CI_ACTION', `${label}[${index}].if is invalid.`);
    assertObject(action.with, 'CI_ACTION', `${label}[${index}].with`);
    for (const value of Object.values(action.with)) {
      if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) {
        fail('CI_ACTION', `${label}[${index}].with contains an invalid value.`);
      }
    }
  }
}

function validateCiRunMetadata(entries, label) {
  if (!Array.isArray(entries) || entries.length === 0) fail('CI_RUNS', `${label} must be a non-empty array.`);
  for (const [index, entry] of entries.entries()) {
    assertObject(entry, 'CI_RUN', `${label}[${index}]`);
    assertKeys(entry, ['run', 'id', 'env'], 'CI_RUN_FIELDS', `${label}[${index}]`);
    if (entry.id !== undefined && (typeof entry.id !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(entry.id))) fail('CI_RUN', `${label}[${index}].id is invalid.`);
    assertObject(entry.env, 'CI_RUN', `${label}[${index}].env`);
    for (const value of Object.values(entry.env)) {
      if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) {
        fail('CI_RUN', `${label}[${index}].env contains an invalid value.`);
      }
    }
  }
}

function validateCiStepOrder(order, actionCount, runCount, label) {
  assertStrings(order, 'CI_STEP_ORDER', label, { empty: false });
  const expected = [
    ...Array.from({ length: actionCount }, (_, index) => `action:${index}`),
    ...Array.from({ length: runCount }, (_, index) => `run:${index}`)
  ].sort();
  if (stableJson([...order].sort()) !== stableJson(expected)) fail('CI_STEP_ORDER', `${label} must reference every configured step exactly once.`);
}

export async function loadVerificationPolicy({ root = process.cwd(), policyPath } = {}) {
  const resolvedRoot = path.resolve(root);
  const file = ensureInside(resolvedRoot, policyPath ?? POLICY_FILE, 'POLICY_PATH');
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) fail('POLICY_AUTHORITY', 'Verification policy authority is unsafe.');
  const source = await readFile(file, 'utf8');
  let policy;
  try {
    policy = JSON.parse(source);
  } catch {
    fail('POLICY_JSON', 'Verification policy must contain valid JSON.');
  }
  validateVerificationPolicy(policy);
  return Object.freeze({ root: resolvedRoot, file, policy, fingerprint: digest(source) });
}

function selectedFocusedProfiles(policy, changedPaths) {
  const profiles = new Set();
  const reasons = [];
  const ignored = [];
  for (const rawPath of [...new Set(changedPaths)]) {
    const changedPath = normalizeChangedPath(rawPath);
    const matching = policy.focused_selectors.filter((selector) => selector.patterns.some((pattern) => globToRegExp(pattern).test(changedPath)));
    if (matching.some((selector) => selector.profiles.length === 0)) {
      ignored.push(changedPath);
      continue;
    }
    const selected = matching.flatMap((selector) => selector.profiles);
    if (!matching.length) {
      for (const profile of policy.focused_fallback_profiles) profiles.add(profile);
      reasons.push({ path: changedPath, selector: 'fallback', profiles: [...policy.focused_fallback_profiles] });
    } else {
      for (const profile of selected) profiles.add(profile);
      reasons.push({ path: changedPath, selector: matching.map((item) => item.id).join(','), profiles: [...new Set(selected)].sort() });
    }
  }
  return { profiles: [...profiles].sort(), reasons, ignored: ignored.sort() };
}

function expandTaskIds(policy, profileNames) {
  const ids = new Set();
  const tasksById = new Map(policy.tasks.map((task) => [task.id, task]));
  function include(id) {
    if (ids.has(id)) return;
    const task = tasksById.get(id);
    if (!task) fail('PLAN_TASK', `Unknown task ${id}.`);
    for (const dependency of task.depends_on) include(dependency);
    ids.add(id);
  }
  for (const profile of profileNames) {
    if (!Object.hasOwn(policy.profiles, profile) || profile === 'focused') fail('PLAN_PROFILE', `Unknown runnable profile ${profile}.`);
    for (const id of policy.profiles[profile]) include(id);
  }
  return policy.tasks.filter((task) => ids.has(task.id));
}

export function planVerification({ loadedPolicy, profile, changedPaths = [] }) {
  const { policy, fingerprint } = loadedPolicy;
  let profiles = [profile];
  let selection = { reasons: [], ignored: [] };
  if (profile === 'focused') {
    selection = selectedFocusedProfiles(policy, changedPaths);
    profiles = selection.profiles;
  }
  const tasks = profiles.length ? expandTaskIds(policy, profiles) : [];
  const providers = new Map();
  for (const task of tasks) {
    for (const provided of task.provides) {
      if (providers.has(provided)) fail('PLAN_DUPLICATE_PROVIDER', `${provided} is provided by both ${providers.get(provided)} and ${task.id}.`);
      providers.set(provided, task.id);
    }
  }
  return Object.freeze({
    schema_version: '1.0.0',
    type: 'verification-plan',
    profile,
    scope: profile === 'focused' ? 'partial' : 'complete',
    policy_fingerprint: fingerprint,
    selected_profiles: profiles,
    changed_paths: [...new Set(changedPaths.map(normalizeChangedPath))].sort(),
    selection_reasons: selection.reasons,
    ignored_paths: selection.ignored,
    tasks: tasks.map((task) => structuredClone(task)),
    release_ready_claim_allowed: profile === policy.evidence_policy.release_profile
  });
}

export async function collectChangedPaths({ root, base, head, worktree = false }) {
  const options = { cwd: root, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 };
  if (worktree) {
    const tracked = await execFile('git', ['diff', '--name-status', '-z', 'HEAD'], options);
    const untracked = await execFile('git', ['ls-files', '--others', '--exclude-standard', '-z'], options);
    const paths = parseNameStatusZ(tracked.stdout);
    const extra = untracked.stdout.toString('utf8').split('\0').filter(Boolean).map(normalizeChangedPath);
    return [...new Set([...paths, ...extra])].sort();
  }
  if (!base || !head) fail('CHANGED_RANGE', 'Both base and head are required for a changed-file range.');
  const result = await execFile('git', ['diff', '--name-status', '-z', `${base}...${head}`], options);
  return parseNameStatusZ(result.stdout);
}

function gitStatus(root) {
  const result = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root, encoding: null });
  if (result.status !== 0) fail('GIT_STATUS', 'Unable to inspect repository status.');
  return result.stdout;
}

function stopChild(child, graceMs) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') child.kill('SIGTERM');
    else process.kill(-child.pid, 'SIGTERM');
  } catch {}
  const timer = setTimeout(() => {
    if (child.exitCode !== null) return;
    try {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else process.kill(-child.pid, 'SIGKILL');
    } catch {}
  }, graceMs);
  timer.unref?.();
}

function runTask({ task, root, limits, signal }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    if (signal?.aborted) {
      resolve({ id: task.id, status: 'cancelled', exit_code: null, duration_ms: 0, output: '', reason: 'cancelled' });
      return;
    }
    const child = spawn(task.argv[0], task.argv.slice(1), {
      cwd: root,
      env: taskEnvironment(process.env),
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const chunks = [];
    let bytes = 0;
    let limited = false;
    let timedOut = false;
    let aborted = false;
    const append = (stream, chunk) => {
      const buffer = Buffer.from(chunk);
      const framed = Buffer.concat([Buffer.from(`[${stream}] `), buffer]);
      if (bytes + framed.length <= limits.max_log_bytes) {
        chunks.push(framed);
        bytes += framed.length;
      } else if (!limited) {
        limited = true;
        stopChild(child, limits.cancellation_grace_ms);
      }
    };
    child.stdout.on('data', (chunk) => append('stdout', chunk));
    child.stderr.on('data', (chunk) => append('stderr', chunk));
    const timeout = setTimeout(() => {
      timedOut = true;
      stopChild(child, limits.cancellation_grace_ms);
    }, limits.default_timeout_ms);
    timeout.unref?.();
    const abort = () => {
      aborted = true;
      stopChild(child, limits.cancellation_grace_ms);
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.on('error', (error) => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      resolve({ id: task.id, status: 'failed', exit_code: null, duration_ms: Date.now() - startedAt, output: `${error.message}\n`, reason: 'spawn_error' });
    });
    child.on('close', (code, childSignal) => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      const status = aborted ? 'cancelled' : timedOut ? 'timed_out' : limited ? 'output_limited' : code === 0 ? 'passed' : 'failed';
      resolve({ id: task.id, status, exit_code: code, signal: childSignal, duration_ms: Date.now() - startedAt, output: Buffer.concat(chunks).toString('utf8'), reason: status });
    });
  });
}

function taskEnvironment(source) {
  const environment = { ...source };
  for (const key of ['npm_lifecycle_event', 'npm_lifecycle_script', 'npm_command', 'npm_package_json']) delete environment[key];
  for (const key of Object.keys(environment)) {
    if (/(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL|AUTHORIZATION|COOKIE)/iu.test(key)) delete environment[key];
    if (/(?:LIVE_DOGFOOD|LIVE_PROVIDER_ENABLED)/iu.test(key)) delete environment[key];
  }
  return environment;
}

function resolveJobCount(policy, requested) {
  const configured = requested ?? policy.limits.parallel_jobs;
  if (configured !== 'auto') {
    validatePositive(configured, 'RUN_JOBS', 'jobs');
    return Math.min(configured, policy.limits.max_parallel_jobs);
  }
  const available = typeof availableParallelism === 'function' ? availableParallelism() : 1;
  return Math.max(1, Math.min(available, policy.limits.max_parallel_jobs));
}

export async function runVerificationPlan({ loadedPolicy, plan, jobs, signal }) {
  const { root, policy } = loadedPolicy;
  const maxJobs = resolveJobCount(policy, jobs);
  const before = gitStatus(root);
  const pending = new Map(plan.tasks.map((task) => [task.id, task]));
  const active = new Map();
  const results = new Map();
  const heldLocks = new Set();
  const abortController = new AbortController();
  let failed = false;
  let externallyCancelled = false;
  const externalAbort = () => {
    externallyCancelled = true;
    failed = true;
    abortController.abort();
  };
  signal?.addEventListener('abort', externalAbort, { once: true });
  if (signal?.aborted) externalAbort();

  const canStart = (task) => {
    if (task.depends_on.some((id) => results.get(id)?.status !== 'passed')) return false;
    if (task.locks.some((lock) => heldLocks.has(lock))) return false;
    const exclusive = task.kind !== 'parallel';
    if (exclusive && active.size) return false;
    if (!exclusive && [...active.values()].some((entry) => entry.task.kind !== 'parallel')) return false;
    return true;
  };
  const launch = (task) => {
    pending.delete(task.id);
    for (const lock of task.locks) heldLocks.add(lock);
    const promise = runTask({ task, root, limits: policy.limits, signal: abortController.signal }).then((result) => ({ task, result }));
    active.set(task.id, { task, promise });
  };

  try {
    while (pending.size || active.size) {
      if (!failed) {
        for (const task of plan.tasks) {
          if (active.size >= maxJobs) break;
          if (!pending.has(task.id)) continue;
          if (task.kind !== 'parallel') {
            if (task.depends_on.some((id) => results.get(id)?.status !== 'passed')) continue;
            if (canStart(task)) launch(task);
            break;
          }
          if (!canStart(task)) continue;
          launch(task);
        }
      }
      if (!active.size) {
        for (const task of pending.values()) {
          const status = externallyCancelled ? 'cancelled' : failed ? 'not_started' : 'blocked';
          results.set(task.id, {
            id: task.id,
            status,
            exit_code: null,
            duration_ms: 0,
            output: '',
            reason: externallyCancelled ? 'cancelled' : failed ? 'earlier_failure' : 'dependency_blocked'
          });
        }
        pending.clear();
        break;
      }
      const { task, result } = await Promise.race([...active.values()].map((entry) => entry.promise));
      active.delete(task.id);
      for (const lock of task.locks) heldLocks.delete(lock);
      results.set(task.id, result);
      if (result.status !== 'passed' && !failed) {
        failed = true;
        abortController.abort();
      }
    }
  } finally {
    signal?.removeEventListener('abort', externalAbort);
  }

  const after = gitStatus(root);
  const worktreePreserved = before.equals(after);
  if (!worktreePreserved) failed = true;
  const ordered = plan.tasks.map((task) => results.get(task.id) ?? { id: task.id, status: 'not_started', exit_code: null, duration_ms: 0, output: '', reason: 'not_started' });
  return {
    schema_version: '1.0.0',
    type: 'verification-run-result',
    profile: plan.profile,
    scope: plan.scope,
    status: !failed && ordered.every((result) => result.status === 'passed') ? 'passed' : 'failed',
    release_ready_claim_allowed: plan.release_ready_claim_allowed && !failed,
    worktree_preserved: worktreePreserved,
    policy_fingerprint: plan.policy_fingerprint,
    max_parallel_jobs: maxJobs,
    results: ordered
  };
}

function gitObject(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) fail('GIT_OBJECT', `Unable to resolve git ${args.join(' ')}.`);
  return result.stdout.trim();
}

export function buildCiProof({ loadedPolicy, ownerResults, runId, runAttempt, headSha, sourceJob }) {
  const graph = loadedPolicy.policy.ci_graph;
  const evidencePolicy = loadedPolicy.policy.evidence_policy;
  assertObject(ownerResults, 'PROOF_RESULTS', 'ownerResults');
  const resultKeys = Object.keys(ownerResults).sort();
  const required = [...graph.required_jobs].sort();
  if (stableJson(resultKeys) !== stableJson(required)) fail('PROOF_RESULTS', 'CI proof owner result set does not match the required graph.');
  for (const job of required) if (ownerResults[job] !== 'success') fail('PROOF_OWNER', `Required CI owner ${job} did not succeed.`);
  if (!FULL_SHA.test(headSha)) fail('PROOF_HEAD', 'CI proof requires a full HEAD SHA.');
  if (!runId || !Number.isSafeInteger(Number(runAttempt)) || Number(runAttempt) <= 0) fail('PROOF_RUN', 'CI proof requires a run id and positive attempt.');
  if (sourceJob !== graph.final_job_id) fail('PROOF_JOB', 'CI proof must be produced by the configured final job.');
  const currentHead = gitObject(loadedPolicy.root, ['rev-parse', 'HEAD']);
  if (currentHead !== headSha) fail('PROOF_HEAD', 'CI proof HEAD does not match the checkout.');
  const body = {
    schema_version: '1.0.0',
    marker: 'verification-ci-proof-v1',
    run_id: String(runId),
    run_attempt: Number(runAttempt),
    repository: githubRepositoryIdentity(
      loadedPolicy.root,
      evidencePolicy.ci_proof_repository_remote,
      evidencePolicy.ci_proof_repository_hosts
    ).repository,
    head_sha: headSha,
    tree_sha: gitObject(loadedPolicy.root, ['rev-parse', 'HEAD^{tree}']),
    workflow_path: evidencePolicy.ci_proof_workflow_path,
    artifact_name: `${evidencePolicy.ci_proof_artifact_prefix}-${String(runId)}-${Number(runAttempt)}`,
    source_job: sourceJob,
    owner_results: Object.fromEntries(required.map((job) => [job, ownerResults[job]])),
    policy_fingerprint: loadedPolicy.fingerprint,
    graph_fingerprint: digest(graph),
    cross_run_result_reuse: false,
    persistent_result_cache: false
  };
  return { ...body, proof_digest: digest(body) };
}

export function validateCiProof({ loadedPolicy, proof }) {
  assertObject(proof, 'PROOF_TYPE', 'proof');
  const supplied = proof.proof_digest;
  const body = { ...proof };
  delete body.proof_digest;
  if (!/^[a-f0-9]{64}$/u.test(supplied ?? '') || digest(body) !== supplied) fail('PROOF_DIGEST', 'CI proof digest is invalid.');
  const expected = buildCiProof({
    loadedPolicy,
    ownerResults: body.owner_results,
    runId: body.run_id,
    runAttempt: body.run_attempt,
    headSha: body.head_sha,
    sourceJob: body.source_job
  });
  if (stableJson(expected) !== stableJson(proof)) {
    fail('PROOF_CONTENT', 'CI proof content does not match the current checkout, policy, and graph.');
  }
  return expected;
}

export { digest, stableJson };
