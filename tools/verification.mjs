#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buildCiProof,
  collectChangedPaths,
  loadVerificationPolicy,
  planVerification,
  runVerificationPlan,
  validateCiProof
} from './lib/verification-orchestration.mjs';

const [command = 'help', ...args] = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function options(name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) if (args[index] === name) values.push(args[index + 1]);
  return values;
}

function flag(name) {
  return args.includes(name);
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

async function atomicJson(file, value) {
  const resolved = path.resolve(file);
  await mkdir(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  await rename(temporary, resolved);
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage() {
  process.stdout.write(`Usage:
  node tools/verification.mjs check
  node tools/verification.mjs plan --profile <focused|contracts|core|browser|package|release> [--worktree|--base <sha> --head <sha>|--path <path>]
  node tools/verification.mjs run --profile <profile> [selection options] [--jobs <count>] [--json]
  node tools/verification.mjs ci-proof --results-json <json> --run-id <id> --run-attempt <n> --head <sha> --source-job <id> --output <file>
  node tools/verification.mjs verify-proof --input <file>
`);
}

async function resolvePlan(loadedPolicy) {
  const profile = option('--profile');
  if (!profile) throw new Error('--profile is required.');
  let changedPaths = options('--path');
  if (profile === 'focused' && flag('--worktree')) changedPaths = await collectChangedPaths({ root: loadedPolicy.root, worktree: true });
  else if (profile === 'focused' && option('--base') && option('--head')) {
    changedPaths = await collectChangedPaths({ root: loadedPolicy.root, base: option('--base'), head: option('--head') });
  }
  return planVerification({ loadedPolicy, profile, changedPaths });
}

async function main() {
  if (command === 'help' || command === '--help' || command === '-h') {
    usage();
    return;
  }
  const loadedPolicy = await loadVerificationPolicy({ root: process.cwd(), policyPath: option('--policy') });
  if (command === 'check') {
    print({ status: 'pass', policy: path.relative(loadedPolicy.root, loadedPolicy.file), fingerprint: loadedPolicy.fingerprint, activation_mode: loadedPolicy.policy.activation_mode });
    return;
  }
  if (command === 'plan') {
    print(await resolvePlan(loadedPolicy));
    return;
  }
  if (command === 'run') {
    const plan = await resolvePlan(loadedPolicy);
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      const result = await runVerificationPlan({
        loadedPolicy,
        plan,
        jobs: option('--jobs') ? positiveInteger(option('--jobs'), '--jobs') : undefined,
        signal: controller.signal
      });
      if (flag('--json')) print(result);
      else {
        for (const task of result.results) {
          process.stdout.write(`[${task.id}] ${task.status}\n`);
          if (task.status !== 'passed' && task.output) process.stdout.write(task.output);
        }
        process.stdout.write(`Verification ${result.profile} ${result.status} (${result.results.length} task(s)).\n`);
      }
      if (result.status !== 'passed') process.exitCode = 1;
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
    return;
  }
  if (command === 'ci-proof') {
    const resultsRaw = option('--results-json') ?? process.env.CI_OWNER_RESULTS_JSON;
    if (!resultsRaw) throw new Error('--results-json is required.');
    const proof = buildCiProof({
      loadedPolicy,
      ownerResults: JSON.parse(resultsRaw),
      runId: option('--run-id') ?? process.env.GITHUB_RUN_ID,
      runAttempt: option('--run-attempt') ?? process.env.GITHUB_RUN_ATTEMPT,
      headSha: option('--head') ?? process.env.GITHUB_SHA,
      sourceJob: option('--source-job')
    });
    const output = option('--output');
    if (output) await atomicJson(output, proof);
    print(proof);
    return;
  }
  if (command === 'verify-proof') {
    const input = option('--input');
    if (!input) throw new Error('--input is required.');
    const proof = JSON.parse(await readFile(input, 'utf8'));
    print(validateCiProof({ loadedPolicy, proof }));
    return;
  }
  throw new Error(`Unknown verification command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`Verification failed: ${error.code ? `${error.code}: ` : ''}${error.message}\n`);
  process.exitCode = 1;
});
