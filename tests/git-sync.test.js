import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkGitSync } from '../tools/check_git_sync.mjs';

const HEAD = 'a'.repeat(40);

function gitFixture({ remoteHead = HEAD, dirty = false } = {}) {
  const calls = [];
  const responses = new Map([
    ['status\0--porcelain=v1\0-z\0--untracked-files=all', dirty ? ' M tracked.txt\0' : ''],
    ['rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{u}', 'origin/main\n'],
    ['rev-list\0--left-right\0--count\0HEAD...@{u}', '0 0\n'],
    ['symbolic-ref\0--quiet\0--short\0HEAD', 'main\n'],
    ['config\0--get\0branch.main.remote', 'origin\n'],
    ['config\0--get\0branch.main.merge', 'refs/heads/main\n'],
    ['ls-remote\0--exit-code\0--refs\0origin\0refs/heads/main', `${remoteHead}\trefs/heads/main\n`],
    ['rev-parse\0--verify\0HEAD', `${HEAD}\n`]
  ]);
  return {
    calls,
    runGit(args) {
      calls.push(args);
      const key = args.join('\0');
      if (!responses.has(key)) throw new Error(`Unexpected git call: ${args.join(' ')}`);
      return { status: 0, stdout: responses.get(key), stderr: '' };
    }
  };
}

test('Git synchronization confirms the live remote branch instead of trusting a tracking ref', () => {
  const fixture = gitFixture();
  const result = checkGitSync({ cwd: '/repository', runGit: fixture.runGit });
  assert.deepEqual({ ...result, observed_at: '<time>' }, {
    status: 'pass',
    worktree: 'clean',
    upstream: 'configured',
    remote: 'checked',
    remote_ref: 'refs/heads/main',
    remote_head: HEAD,
    observed_at: '<time>',
    ahead: 0,
    behind: 0
  });
  assert.equal(Number.isFinite(Date.parse(result.observed_at)), true);
  assert.equal(fixture.calls.some((args) => args[0] === 'ls-remote'), true);
});

test('Git synchronization rejects dirty worktrees and live remote drift', () => {
  const dirty = gitFixture({ dirty: true });
  assert.throws(() => checkGitSync({ cwd: '/repository', runGit: dirty.runGit }), /clean worktree/);
  const staleTrackingRef = gitFixture({ remoteHead: 'b'.repeat(40) });
  assert.throws(() => checkGitSync({ cwd: '/repository', runGit: staleTrackingRef.runGit }), /live remote branch to equal HEAD/);
});

test('remote CI checker pins GitHub host and configured workflow path', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'trace-cue-ci-status-'));
  const fakeGh = path.join(directory, 'gh');
  const log = path.join(directory, 'gh.log');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  await writeFile(fakeGh, `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GH_CALL_LOG"
if [[ "$1" == "auth" ]]; then exit 0; fi
case "$*" in
  *actions/runs/12345/jobs*) printf 'Node 20\tcompleted\tsuccess\n' ;;
  *actions/runs/12345*) printf '%s\t%s\t%s\tcompleted\tsuccess\n' "\${FAKE_WORKFLOW_NAME}" "\${FAKE_WORKFLOW_PATH}" "\${FAKE_HEAD}" ;;
  *) exit 9 ;;
esac
`, 'utf8');
  await chmod(fakeGh, 0o700);
  const env = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH}`,
    GH_CALL_LOG: log,
    GH_HOST: 'attacker.invalid',
    FAKE_WORKFLOW_NAME: 'CI',
    FAKE_WORKFLOW_PATH: '.github/workflows/ci.yml',
    FAKE_HEAD: head,
    CI_STATUS_WORKFLOW_NAME: 'Attacker Workflow',
    CI_STATUS_WORKFLOW_PATH: '.github/workflows/attacker.yml',
    CI_STATUS_REMOTE_NAME: 'attacker',
    CI_STATUS_RETRY_COUNT: '1'
  };
  execFileSync('bash', ['./tools/check_ci_status.sh', '--required', '--commit', head, '--run-id', '12345'], { env, encoding: 'utf8' });
  const calls = (await readFile(log, 'utf8')).trim().split('\n');
  assert.equal(calls.every((call) => call.includes('--hostname github.com')), true);
  assert.throws(() => execFileSync('bash', ['./tools/check_ci_status.sh', '--workflow', 'Attacker Workflow'], {
    env,
    encoding: 'utf8',
    stdio: 'pipe'
  }), /Command failed/u);

  assert.throws(() => execFileSync('bash', ['./tools/check_ci_status.sh', '--required', '--commit', head, '--run-id', '12345'], {
    env: { ...env, FAKE_WORKFLOW_PATH: '.github/workflows/other.yml' },
    encoding: 'utf8',
    stdio: 'pipe'
  }), /Command failed/u);
});

test('remote CI checker derives renamed remote and workflow identity from policy', async () => {
  const repository = await mkdtemp(path.join(tmpdir(), 'trace-cue-ci-status-policy-'));
  await mkdir(path.join(repository, 'ops'), { recursive: true });
  await writeFile(path.join(repository, 'tracked.txt'), 'fixture\n');
  await writeFile(path.join(repository, 'ops', 'VERIFICATION_EXECUTION_POLICY.json'), `${JSON.stringify({
    evidence_policy: {
      ci_proof_workflow_path: '.github/workflows/quality.yml',
      ci_proof_repository_remote: 'upstream',
      ci_proof_repository_hosts: ['github.enterprise.example']
    },
    ci_graph: { workflow_contract: { name: 'Quality Gate' } }
  })}\n`);
  execFileSync('git', ['init', '-q'], { cwd: repository });
  execFileSync('git', ['config', 'user.name', 'CI Status Test'], { cwd: repository });
  execFileSync('git', ['config', 'user.email', 'ci-status@example.invalid'], { cwd: repository });
  execFileSync('git', ['remote', 'add', 'upstream', 'https://github.enterprise.example/example/renamed.git'], { cwd: repository });
  execFileSync('git', ['add', '.'], { cwd: repository });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repository });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
  const directory = await mkdtemp(path.join(tmpdir(), 'trace-cue-ci-status-policy-bin-'));
  const fakeGh = path.join(directory, 'gh');
  const log = path.join(directory, 'gh.log');
  await writeFile(fakeGh, `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GH_CALL_LOG"
if [[ "$1" == "auth" ]]; then exit 0; fi
case "$*" in
  *actions/runs/54321/jobs*) printf 'Contract\tcompleted\tsuccess\n' ;;
  *actions/runs/54321*) printf 'Quality Gate\t.github/workflows/quality.yml\t%s\tcompleted\tsuccess\n' "$FAKE_HEAD" ;;
  *) exit 9 ;;
esac
`, 'utf8');
  await chmod(fakeGh, 0o700);
  const env = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH}`,
    GH_CALL_LOG: log,
    GH_HOST: 'attacker.invalid',
    FAKE_HEAD: head,
    CI_STATUS_REPOSITORY_ROOT: repository,
    CI_STATUS_RETRY_COUNT: '1'
  };
  execFileSync('bash', ['./tools/check_ci_status.sh', '--required', '--commit', head, '--run-id', '54321'], { env, encoding: 'utf8' });
  const calls = await readFile(log, 'utf8');
  assert.match(calls, /--hostname github\.enterprise\.example/);
});
