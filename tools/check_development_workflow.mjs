#!/usr/bin/env node
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  evaluateDevelopmentWorkflowContract,
  parseManifestIds,
  validateDevelopmentWorkflowPolicy
} from './lib/development-workflow.mjs';

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--validate-policy') options.validatePolicy = true;
    else if (arg === '--repo') {
      const value = argv[++index];
      if (!value) throw new Error('--repo requires a value.');
      options.repo = value;
    } else throw new Error(`Unsupported argument: ${arg}`);
  }
  return options;
}

async function collectExistingFiles(repoRoot, relativePaths) {
  const rootReal = await realpath(repoRoot);
  const existing = new Set();
  for (const relativePath of relativePaths) {
    const target = path.resolve(repoRoot, relativePath);
    const relative = path.relative(repoRoot, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Required repository path escapes the repository: ${relativePath}`);
    }
    let stats;
    try {
      stats = await lstat(target);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (!stats.isFile() || stats.isSymbolicLink()) continue;
    const targetReal = await realpath(target);
    const realRelative = path.relative(rootReal, targetReal);
    if (!realRelative.startsWith('..') && !path.isAbsolute(realRelative)) existing.add(relativePath);
  }
  return existing;
}

function printResult(result, json) {
  const output = { schema_version: '1.0.0', kind: 'development-workflow-check', ...result };
  if (json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }
  if (result.status === 'pass') {
    process.stdout.write(`Development workflow contract passed (${result.rule_count} rule(s)).\n`);
    return;
  }
  process.stderr.write('Development workflow contract failed.\n');
  for (const [label, values] of [
    ['missing instruction anchor', result.missing_instruction_anchors],
    ['unregistered instruction anchor', result.unregistered_instruction_anchors],
    ['duplicate instruction anchor', result.duplicate_instruction_anchors],
    ['missing test id', result.missing_test_ids],
    ['missing package script', result.missing_package_scripts],
    ['missing repository file', result.missing_repository_files],
    ['missing policy reference', result.missing_policy_references]
  ]) {
    for (const value of values) process.stderr.write(`  ${label}: ${value}\n`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(options.repo ?? defaultRepoRoot);
  const policy = validateDevelopmentWorkflowPolicy(JSON.parse(
    await readFile(path.join(repoRoot, 'ops/DEVELOPMENT_WORKFLOW_POLICY.json'), 'utf8')
  ));
  if (options.validatePolicy) {
    process.stdout.write('Development workflow policy is valid.\n');
    return;
  }
  const [instructionText, testPlanText, packageJson, existingRepositoryFiles] = await Promise.all([
    readFile(path.join(repoRoot, policy.instruction_authority), 'utf8'),
    readFile(path.join(repoRoot, 'ops/TEST_PLAN_MANIFEST.tsv'), 'utf8'),
    readFile(path.join(repoRoot, 'package.json'), 'utf8').then(JSON.parse),
    collectExistingFiles(repoRoot, policy.required_repository_files)
  ]);
  const result = evaluateDevelopmentWorkflowContract(policy, {
    instructionText,
    registeredTestIds: parseManifestIds(testPlanText),
    packageScripts: packageJson.scripts,
    existingRepositoryFiles
  });
  printResult(result, options.json);
  if (result.status !== 'pass') process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`Development workflow check error: ${error.message}\n`);
  process.exitCode = 2;
});
