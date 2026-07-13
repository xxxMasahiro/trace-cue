#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function git(args, { cwd, allowFailure = false } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    maxBuffer: 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) throw new Error(String(result.stderr).trim() || `git ${args.join(' ')} failed`);
  return result;
}

export function checkGitSync({ cwd = process.cwd(), runGit = git } = {}) {
  const execute = (args, options = {}) => runGit(args, { cwd, ...options });
  const status = execute(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (status.stdout.length !== 0) throw new Error('Git synchronization check requires a clean worktree.');
  const upstream = execute(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { allowFailure: true });
  if (upstream.status !== 0 || !upstream.stdout.trim()) throw new Error('Git synchronization check requires an upstream branch.');
  const counts = execute(['rev-list', '--left-right', '--count', 'HEAD...@{u}']).stdout.trim().split(/\s+/u).map(Number);
  if (counts.length !== 2 || counts.some((value) => !Number.isSafeInteger(value)) || counts[0] !== 0 || counts[1] !== 0) {
    throw new Error('Git synchronization check requires zero ahead and behind commits.');
  }
  const branch = execute(['symbolic-ref', '--quiet', '--short', 'HEAD']).stdout.trim();
  if (!branch || /[\0\r\n]/u.test(branch)) throw new Error('Git synchronization check requires a local branch.');
  const remote = execute(['config', '--get', `branch.${branch}.remote`]).stdout.trim();
  const mergeRef = execute(['config', '--get', `branch.${branch}.merge`]).stdout.trim();
  if (!/^[A-Za-z0-9._-]+$/u.test(remote) || remote === '.'
    || !/^refs\/heads\/[A-Za-z0-9._/-]+$/u.test(mergeRef)
    || mergeRef.includes('..') || mergeRef.includes('//') || mergeRef.endsWith('/')) {
    throw new Error('Git synchronization check requires a safe remote branch upstream.');
  }
  const remoteResult = execute(['ls-remote', '--exit-code', '--refs', remote, mergeRef]);
  const remoteLines = remoteResult.stdout.trim().split('\n').filter(Boolean);
  if (remoteLines.length !== 1) throw new Error('Git synchronization check requires exactly one live remote branch result.');
  const remoteFields = remoteLines[0].split(/\s+/u);
  const head = execute(['rev-parse', '--verify', 'HEAD']).stdout.trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(head)
    || remoteFields.length !== 2 || remoteFields[1] !== mergeRef || remoteFields[0] !== head) {
    throw new Error('Git synchronization check requires the live remote branch to equal HEAD.');
  }
  return {
    status: 'pass',
    worktree: 'clean',
    upstream: 'configured',
    remote: 'checked',
    remote_ref: mergeRef,
    remote_head: head,
    observed_at: new Date().toISOString(),
    ahead: 0,
    behind: 0
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${JSON.stringify(checkGitSync())}\n`);
}
