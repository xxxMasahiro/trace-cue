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
import {
  importVerifiedCiProofEvidence,
  runReleaseVerificationAndRecord
} from './lib/product-gate-evidence.mjs';

const [command = 'help', ...args] = process.argv.slice(2);

const COMMAND_ARGUMENTS = Object.freeze({
  check: { values: ['--policy'], flags: [], repeatable: [] },
  plan: {
    values: ['--policy', '--profile', '--base', '--head', '--path'],
    flags: ['--worktree'],
    repeatable: ['--path']
  },
  run: {
    values: ['--policy', '--profile', '--base', '--head', '--path', '--jobs', '--context'],
    flags: ['--worktree', '--json', '--record-evidence'],
    repeatable: ['--path']
  },
  release: { values: ['--policy', '--jobs'], flags: ['--json'], repeatable: [] },
  'release-evidence': { values: ['--policy', '--jobs', '--context'], flags: ['--json'], repeatable: [] },
  'ci-proof': {
    values: ['--policy', '--results-json', '--run-id', '--run-attempt', '--head', '--source-job', '--output'],
    flags: [],
    repeatable: []
  },
  'verify-proof': { values: ['--policy', '--input'], flags: [], repeatable: [] },
  'import-ci-proof': { values: ['--policy', '--run-id', '--context'], flags: [], repeatable: [] }
});

function parseArguments(selectedCommand, rawArgs) {
  const specification = COMMAND_ARGUMENTS[selectedCommand];
  if (!specification) throw new Error(`Unknown verification command: ${selectedCommand}`);
  const valueNames = new Set(specification.values);
  const flagNames = new Set(specification.flags);
  const repeatable = new Set(specification.repeatable);
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < rawArgs.length; index += 1) {
    const token = rawArgs[index];
    if (flagNames.has(token)) {
      if (flags.has(token)) throw new Error(`${token} cannot be repeated.`);
      flags.add(token);
      continue;
    }
    if (!valueNames.has(token)) throw new Error(`Unknown or inapplicable argument for ${selectedCommand}: ${token}`);
    const value = rawArgs[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} requires a value.`);
    if (values.has(token) && !repeatable.has(token)) throw new Error(`${token} cannot be repeated.`);
    values.set(token, [...(values.get(token) ?? []), value]);
    index += 1;
  }
  return Object.freeze({
    has: (name) => flags.has(name),
    get: (name, fallback) => values.get(name)?.[0] ?? fallback,
    all: (name) => [...(values.get(name) ?? [])]
  });
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
  node tools/verification.mjs plan --profile <profile> [--worktree|--base <sha> --head <sha>|--path <path>]
  node tools/verification.mjs run --profile <profile> [selection options] [--jobs <count>] [--json]
  node tools/verification.mjs release [--jobs <count>] [--json]
  node tools/verification.mjs release-evidence [--context <context>] [--jobs <count>] [--json]
  node tools/verification.mjs ci-proof --results-json <json> --run-id <id> --run-attempt <n> --head <sha> --source-job <id> --output <file>
  node tools/verification.mjs verify-proof --input <file>
  node tools/verification.mjs import-ci-proof [--run-id <id>] [--context <context>]
`);
}

function validateSelection(parsed, profile) {
  const hasWorktree = parsed.has('--worktree');
  const paths = parsed.all('--path');
  const base = parsed.get('--base');
  const head = parsed.get('--head');
  const selectorCount = Number(hasWorktree) + Number(paths.length > 0) + Number(Boolean(base || head));
  if (selectorCount > 1) throw new Error('Choose only one changed-path selector: --worktree, --base/--head, or --path.');
  if (Boolean(base) !== Boolean(head)) throw new Error('--base and --head must be provided together.');
  if (profile !== 'focused' && selectorCount > 0) throw new Error('Changed-path selectors require the focused profile.');
}

async function resolvePlan(loadedPolicy, parsed, profileOverride) {
  const profile = profileOverride ?? parsed.get('--profile');
  if (!profile) throw new Error('--profile is required.');
  validateSelection(parsed, profile);
  let changedPaths = parsed.all('--path');
  if (profile === 'focused' && parsed.has('--worktree')) changedPaths = await collectChangedPaths({ root: loadedPolicy.root, worktree: true });
  else if (profile === 'focused' && parsed.get('--base') && parsed.get('--head')) {
    changedPaths = await collectChangedPaths({ root: loadedPolicy.root, base: parsed.get('--base'), head: parsed.get('--head') });
  }
  return planVerification({ loadedPolicy, profile, changedPaths });
}

async function executePlan({ loadedPolicy, plan, parsed, recordEvidence }) {
  if (recordEvidence && plan.profile !== loadedPolicy.policy.evidence_policy.release_profile) {
    throw new Error('Evidence recording requires the complete configured release profile.');
  }
  if (parsed.get('--context') && !recordEvidence) throw new Error('--context requires evidence recording.');
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const execution = recordEvidence
      ? await runReleaseVerificationAndRecord({
          loadedPolicy,
          plan,
          context: parsed.get('--context', loadedPolicy.policy.evidence_policy.default_context),
          jobs: parsed.get('--jobs') ? positiveInteger(parsed.get('--jobs'), '--jobs') : undefined,
          signal: controller.signal
        })
      : {
          result: await runVerificationPlan({
            loadedPolicy,
            plan,
            jobs: parsed.get('--jobs') ? positiveInteger(parsed.get('--jobs'), '--jobs') : undefined,
            signal: controller.signal
          }),
          evidenceBatch: null
        };
    const { result, evidenceBatch } = execution;
    if (parsed.has('--json')) print({ ...result, evidence_batch: evidenceBatch ? {
      batch_id: evidenceBatch.batch.batch_id,
      batch_digest: evidenceBatch.batch.batch_digest,
      receipt_count: evidenceBatch.recorded.length
    } : null });
    else {
      for (const task of result.results) {
        process.stdout.write(`[${task.id}] ${task.status}\n`);
        if (task.status !== 'passed' && task.output) process.stdout.write(task.output);
      }
      process.stdout.write(`Verification ${result.profile} ${result.status} (${result.results.length} task(s)).\n`);
      if (evidenceBatch) process.stdout.write(`Recorded release evidence batch ${evidenceBatch.batch.batch_id} (${evidenceBatch.recorded.length} receipt(s)).\n`);
    }
    if (result.status !== 'passed') process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

async function main() {
  if (command === 'help' || command === '--help' || command === '-h') {
    if (args.length) throw new Error('Help does not accept additional arguments.');
    usage();
    return;
  }
  const parsed = parseArguments(command, args);
  const loadedPolicy = await loadVerificationPolicy({ root: process.cwd(), policyPath: parsed.get('--policy') });
  if (command === 'check') {
    print({ status: 'pass', policy: path.relative(loadedPolicy.root, loadedPolicy.file), fingerprint: loadedPolicy.fingerprint, activation_mode: loadedPolicy.policy.activation_mode });
    return;
  }
  if (command === 'plan') {
    print(await resolvePlan(loadedPolicy, parsed));
    return;
  }
  if (command === 'run' || command === 'release' || command === 'release-evidence') {
    const configuredRelease = loadedPolicy.policy.evidence_policy.release_profile;
    const plan = await resolvePlan(loadedPolicy, parsed, command === 'run' ? undefined : configuredRelease);
    await executePlan({
      loadedPolicy,
      plan,
      parsed,
      recordEvidence: command === 'release-evidence' || (command === 'run' && parsed.has('--record-evidence'))
    });
    return;
  }
  if (command === 'ci-proof') {
    const resultsRaw = parsed.get('--results-json') ?? process.env.CI_OWNER_RESULTS_JSON;
    if (!resultsRaw) throw new Error('--results-json is required.');
    const proof = buildCiProof({
      loadedPolicy,
      ownerResults: JSON.parse(resultsRaw),
      runId: parsed.get('--run-id') ?? process.env.GITHUB_RUN_ID,
      runAttempt: parsed.get('--run-attempt') ?? process.env.GITHUB_RUN_ATTEMPT,
      headSha: parsed.get('--head') ?? process.env.GITHUB_SHA,
      sourceJob: parsed.get('--source-job')
    });
    const output = parsed.get('--output');
    if (output) await atomicJson(output, proof);
    print(proof);
    return;
  }
  if (command === 'verify-proof') {
    const input = parsed.get('--input');
    if (!input) throw new Error('--input is required.');
    const proof = JSON.parse(await readFile(input, 'utf8'));
    print(validateCiProof({ loadedPolicy, proof }));
    return;
  }
  if (command === 'import-ci-proof') {
    print(await importVerifiedCiProofEvidence({
      repoRoot: loadedPolicy.root,
      runId: parsed.get('--run-id'),
      context: parsed.get('--context')
    }));
    return;
  }
}

main().catch((error) => {
  process.stderr.write(`Verification failed: ${error.code ? `${error.code}: ` : ''}${error.message}\n`);
  process.exitCode = 1;
});
