import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { loadVerificationPolicy } from './verification-orchestration.mjs';

function fail(message) {
  throw new Error(`CI verification contract failed: ${message}`);
}

function parseWorkflow(source) {
  const document = parseDocument(source, {
    prettyErrors: false,
    uniqueKeys: true
  });
  if (document.errors.length) fail(`workflow YAML is invalid: ${document.errors[0].message}`);
  let workflow;
  try {
    workflow = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    fail(`workflow YAML contains unsupported aliases: ${error.message}`);
  }
  if (!isRecord(workflow) || !isRecord(workflow.jobs)) fail('workflow jobs must be a mapping');
  return workflow;
}

function parseJobs(source, workflow) {
  const lines = source.split(/\r?\n/u);
  const jobs = new Map();
  let inJobs = false;
  let current = null;
  for (const line of lines) {
    if (line === 'jobs:') {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    const jobMatch = /^  ([a-zA-Z0-9_-]+):\s*$/u.exec(line);
    if (jobMatch) {
      current = { id: jobMatch[1], lines: [], needs: [], config: workflow.jobs[jobMatch[1]] };
      jobs.set(current.id, current);
      continue;
    }
    if (!current) continue;
    current.lines.push(line);
  }
  for (const job of jobs.values()) {
    for (let index = 0; index < job.lines.length; index += 1) {
      const line = job.lines[index];
      const scalar = /^    needs:\s*([a-zA-Z0-9_-]+)\s*$/u.exec(line);
      if (scalar) job.needs.push(scalar[1]);
      const inline = /^    needs:\s*\[([^\]]+)\]\s*$/u.exec(line);
      if (inline) job.needs.push(...inline[1].split(',').map((item) => item.trim()).filter(Boolean));
      if (/^    needs:\s*$/u.test(line)) {
        for (let cursor = index + 1; cursor < job.lines.length; cursor += 1) {
          const item = /^      - ([a-zA-Z0-9_-]+)\s*$/u.exec(job.lines[cursor]);
          if (!item) break;
          job.needs.push(item[1]);
        }
      }
    }
  }
  return jobs;
}

function assertRequiredCommands(job, owner) {
  const config = job.config;
  assertExactOwnerJob(job, owner);
  if (!Array.isArray(config.steps)) fail(`required owner ${owner.job_id} must define steps`);
  const runSteps = [];
  const actionSteps = [];
  const stepOrder = [];
  for (const step of config.steps) {
    if (!isRecord(step)) fail(`required owner ${owner.job_id} has an invalid step`);
    if (step.run !== undefined) {
      stepOrder.push(`run:${runSteps.length}`);
      assertAllowedKeys(step, ['name', 'run', 'id', 'env'], `required owner ${owner.job_id} run step`);
      if (typeof step.run !== 'string' || step.uses !== undefined) fail(`required owner ${owner.job_id} has a non-string or mixed run step`);
      runSteps.push({
        run: normalizeRunScript(step.run),
        id: step.id ?? null,
        env: step.env ?? {}
      });
      continue;
    }
    if (step.uses !== undefined) {
      stepOrder.push(`action:${actionSteps.length}`);
      assertAllowedKeys(step, ['name', 'uses', 'id', 'if', 'with'], `required owner ${owner.job_id} action step`);
      actionSteps.push(normalizeActionStep(step, owner.job_id));
      continue;
    }
    fail(`required owner ${owner.job_id} has a step without an approved run command or action`);
  }
  const expectedRuns = owner.required_commands.map((run, index) => ({
    run: normalizeRunScript(run),
    id: owner.required_run_metadata[index].id ?? null,
    env: owner.required_run_metadata[index].env
  }));
  if (stableJson(runSteps) !== stableJson(expectedRuns)) {
    fail(`required owner ${owner.job_id} run steps do not exactly match the policy-owned execution sequence`);
  }
  if (stableJson(actionSteps) !== stableJson(owner.required_actions.map((step) => normalizeActionStep(step, owner.job_id)))) {
    fail(`required owner ${owner.job_id} action steps and inputs do not exactly match the policy-owned sequence`);
  }
  if (stableJson(stepOrder) !== stableJson(owner.required_step_order)) {
    fail(`required owner ${owner.job_id} full step order does not match the policy-owned sequence`);
  }
}

function assertExactOwnerJob(job, owner) {
  const config = job.config;
  assertAllowedKeys(config, ['name', 'runs-on', 'timeout-minutes', 'strategy', 'needs', 'outputs', 'steps'], `required owner ${owner.job_id}`);
  if (config.name !== owner.name) fail(`required owner ${owner.job_id} name does not match policy`);
  if (config['runs-on'] !== owner.runs_on) fail(`required owner ${owner.job_id} runner does not match policy`);
  if (config['timeout-minutes'] !== owner.timeout_minutes) fail(`required owner ${owner.job_id} timeout does not match policy`);
  const actualNeeds = normalizeNeeds(config.needs, owner.job_id);
  if (stableJson(actualNeeds) !== stableJson(owner.required_needs)) fail(`required owner ${owner.job_id} needs do not match policy`);
  if (stableJson(config.strategy ?? {}) !== stableJson(owner.required_strategy)) fail(`required owner ${owner.job_id} strategy does not match policy`);
  if (stableJson(config.outputs ?? {}) !== stableJson(owner.required_outputs)) fail(`required owner ${owner.job_id} outputs do not match policy`);
}

function normalizeActionStep(step, jobId) {
  if (!isRecord(step) || typeof step.uses !== 'string' || !step.uses) fail(`required owner ${jobId} has an unsafe action step`);
  if (step.with !== undefined && !isRecord(step.with)) fail(`required owner ${jobId} action inputs must be a mapping`);
  return {
    uses: step.uses,
    id: step.id ?? null,
    if: step.if ?? null,
    with: step.with ?? {}
  };
}

function normalizeNeeds(value, jobId) {
  if (value === undefined) return [];
  if (typeof value === 'string' && value) return [value];
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry)) return [...value];
  fail(`job ${jobId} has invalid needs`);
}

function assertAllowedKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) fail(`${label} contains unsupported field(s): ${unknown.join(', ')}`);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function normalizeRunScript(script) {
  const normalized = String(script).replace(/\r\n/gu, '\n').trim();
  if (!normalized || normalized.includes('\0')) fail('run step command is empty or invalid');
  return normalized;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function validateCiWorkflow({ source, policy }) {
  if (typeof source !== 'string' || !source) fail('workflow source is empty');
  const workflow = parseWorkflow(source);
  const jobs = parseJobs(source, workflow);
  const graph = policy.ci_graph;
  assertExactWorkflowContract(workflow, graph.workflow_contract);
  const expectedJobIds = [...graph.owners.map((owner) => owner.job_id), graph.final_job_id].sort();
  const actualJobIds = Object.keys(workflow.jobs).sort();
  if (stableJson(actualJobIds) !== stableJson(expectedJobIds)) fail(`workflow job set mismatch: ${actualJobIds.join(',')}`);
  if (stableJson([...jobs.keys()].sort()) !== stableJson(expectedJobIds)) fail('workflow job source structure does not match parsed jobs');
  for (const owner of graph.owners) if (!jobs.has(owner.job_id)) fail(`missing owner job ${owner.job_id}`);
  for (const owner of graph.owners) assertRequiredCommands(jobs.get(owner.job_id), owner);
  if (!jobs.has(graph.final_job_id) || !isRecord(jobs.get(graph.final_job_id).config)) fail(`missing final job ${graph.final_job_id}`);
  const finalJob = jobs.get(graph.final_job_id);
  assertFinalGate(finalJob, graph);
  const actualNeeds = [...new Set(normalizeNeeds(finalJob.config.needs, finalJob.id))].sort();
  const requiredNeeds = [...graph.required_jobs].sort();
  if (JSON.stringify(actualNeeds) !== JSON.stringify(requiredNeeds)) fail(`final job needs mismatch: ${actualNeeds.join(',')}`);
  if (/npm publish|curl\s|wget\s|secrets\./iu.test(source)) fail('workflow contains forbidden publishing, external transfer, or secret usage');

  return { jobs: [...jobs.keys()], final_job: graph.final_job_id, required_jobs: requiredNeeds };
}

function assertExactWorkflowContract(workflow, contract) {
  assertAllowedKeys(workflow, ['name', 'on', 'permissions', 'concurrency', 'jobs'], 'workflow');
  if (workflow.name !== contract.name) fail('workflow name does not match policy');
  if (stableJson(workflow.on) !== stableJson(contract.triggers)) fail('workflow triggers do not exactly match policy');
  if (stableJson(workflow.permissions) !== stableJson(contract.permissions)) fail('workflow permissions do not exactly match policy');
  if (stableJson(workflow.concurrency) !== stableJson(contract.concurrency)) fail('workflow concurrency does not exactly match policy');
}

function assertFinalGate(finalJob, graph) {
  assertAllowedKeys(finalJob.config, ['name', 'if', 'needs', 'runs-on', 'timeout-minutes', 'steps'], 'final job');
  if (finalJob.config.name !== graph.final_name) fail('final job name does not match policy');
  if (finalJob.config.if !== graph.final_if) fail('final job condition does not match policy');
  if (finalJob.config['runs-on'] !== graph.final_runs_on) fail('final job runner does not match policy');
  if (finalJob.config['timeout-minutes'] !== graph.final_timeout_minutes) fail('final job timeout does not match policy');
  const steps = finalJob.config.steps;
  if (!Array.isArray(steps)) fail('final job must define steps');
  const runSteps = steps.filter((step) => step?.run !== undefined);
  const requiredRun = graph.final_required_run;
  if (runSteps.length !== 1 || normalizeRunScript(runSteps[0].run) !== normalizeRunScript(requiredRun.run)
    || Object.keys(runSteps[0]).some((key) => !['name', 'run', 'env'].includes(key))
    || stableJson(runSteps[0].env ?? {}) !== stableJson(requiredRun.env)) {
    fail('final job proof step must exactly match the policy-bound proof command and owner results');
  }
  const actionSteps = steps.filter((step) => step?.uses !== undefined).map((step) => {
    assertAllowedKeys(step, ['name', 'uses', 'id', 'if', 'with'], 'final job action step');
    return normalizeActionStep(step, graph.final_job_id);
  });
  if (runSteps.length + actionSteps.length !== steps.length) fail('final job contains an unsupported step');
  const expectedActions = graph.final_required_actions.map((step) => normalizeActionStep(step, graph.final_job_id));
  if (stableJson(actionSteps) !== stableJson(expectedActions)) fail('final job action steps and inputs do not match the policy-owned sequence');
  let actionIndex = 0;
  let runIndex = 0;
  const stepOrder = steps.map((step) => step.run !== undefined ? `run:${runIndex++}` : `action:${actionIndex++}`);
  if (stableJson(stepOrder) !== stableJson(graph.final_required_step_order)) fail('final job full step order does not match the policy-owned sequence');
}

export async function checkRepositoryCi({ root = process.cwd() } = {}) {
  const loadedPolicy = await loadVerificationPolicy({ root });
  const workflowPath = path.join(loadedPolicy.root, loadedPolicy.policy.evidence_policy.ci_proof_workflow_path);
  const source = await readFile(workflowPath, 'utf8');
  return validateCiWorkflow({ source, policy: loadedPolicy.policy });
}
