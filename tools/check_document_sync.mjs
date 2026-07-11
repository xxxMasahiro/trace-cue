#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { evaluateDocumentSync, parseNameStatusZ, validateDocumentSyncPolicy } from './lib/document-sync.mjs';

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let repoRoot = defaultRepoRoot;

function parseArgs(argv) {
  const options = { changedFiles: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--validate-policy') options.validatePolicy = true;
    else if (arg === '--worktree') options.worktree = true;
    else if (['--base', '--head', '--base-ref', '--repo', '--changed-file'].includes(arg)) {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a value.`);
      if (arg === '--changed-file') options.changedFiles.push(value);
      else options[arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = value;
    } else {
      throw new Error(`Unsupported argument: ${arg}`);
    }
  }
  return options;
}

function git(args, encoding = 'utf8') {
  return execFileSync('git', ['-C', repoRoot, ...args], { encoding, stdio: ['ignore', 'pipe', 'pipe'] });
}

function verifyCommit(value, label) {
  try {
    return git(['rev-parse', '--verify', `${value}^{commit}`]).trim();
  } catch {
    throw new Error(`${label} is not an available commit: ${value}`);
  }
}

function rangeChangedFiles(base, head) {
  const baseSha = verifyCommit(base, 'base');
  const headSha = verifyCommit(head, 'head');
  const mergeBase = git(['merge-base', baseSha, headSha]).trim();
  const output = git(['diff', '--name-status', '-z', '--find-renames', `${mergeBase}..${headSha}`], 'buffer');
  return { changedFiles: parseNameStatusZ(output), baseSha, headSha, mergeBase };
}

function worktreeChangedFiles() {
  const outputs = [
    git(['diff', '--name-status', '-z', '--find-renames', 'HEAD'], 'buffer'),
    git(['diff', '--cached', '--name-status', '-z', '--find-renames', 'HEAD'], 'buffer')
  ];
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'], 'buffer').toString('utf8').split('\0').filter(Boolean);
  return [...new Set([...outputs.flatMap(parseNameStatusZ), ...untracked])].sort();
}

function printResult(result, metadata, json) {
  const output = { schema_version: '1.0.0', kind: 'document-sync-check', ...metadata, ...result };
  if (json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }
  if (result.status === 'pass') {
    process.stdout.write(`Document sync check passed (${result.changed_files.length} classified file(s), ${result.matched_rules.length} rule(s)).\n`);
    return;
  }
  process.stderr.write(`Document sync check failed for rule(s): ${result.matched_rules.map((rule) => rule.id).join(', ')}\n`);
  for (const missing of result.missing_all_of) process.stderr.write(`  missing required change: ${missing}\n`);
  for (const group of result.missing_any_of) process.stderr.write(`  change at least one for ${group.group_id}: ${group.alternatives.join(', ')}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  repoRoot = path.resolve(options.repo ?? defaultRepoRoot);
  const policyPath = path.resolve(repoRoot, 'ops/DOCUMENT_SYNC_POLICY.json');
  const policy = validateDocumentSyncPolicy(JSON.parse(await readFile(policyPath, 'utf8')));
  if (options.validatePolicy) {
    process.stdout.write('Document sync policy is valid.\n');
    return;
  }

  let metadata = { mode: 'explicit-files' };
  let changedFiles = options.changedFiles;
  if (options.worktree) {
    if (options.base || options.head || options.baseRef || changedFiles.length) throw new Error('--worktree cannot be combined with range or explicit-file arguments.');
    changedFiles = worktreeChangedFiles();
    metadata = { mode: 'worktree' };
  } else if (options.base || options.head || options.baseRef) {
    if (!options.head) throw new Error('--head is required for range checks.');
    const base = options.base ?? options.baseRef;
    if (!base) throw new Error('--base or --base-ref is required for range checks.');
    const range = rangeChangedFiles(base, options.head);
    changedFiles = range.changedFiles;
    metadata = { mode: 'range', base: range.baseSha, head: range.headSha, merge_base: range.mergeBase };
  }
  if (!options.worktree && metadata.mode !== 'range' && changedFiles.length === 0) {
    throw new Error('Provide --worktree, a base/head range, or at least one --changed-file.');
  }
  const result = evaluateDocumentSync(policy, changedFiles);
  printResult(result, metadata, options.json);
  if (result.status !== 'pass') process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`Document sync check error: ${error.message}\n`);
  process.exitCode = 2;
});
