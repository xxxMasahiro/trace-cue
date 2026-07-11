import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  evaluateDocumentSync,
  globToRegExp,
  parseNameStatusZ,
  validateDocumentSyncPolicy
} from '../tools/lib/document-sync.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const policy = validateDocumentSyncPolicy(JSON.parse(await readFile(path.join(repoRoot, 'ops/DOCUMENT_SYNC_POLICY.json'), 'utf8')));
const policySchema = JSON.parse(await readFile(path.join(repoRoot, 'schemas/document-sync-policy.schema.json'), 'utf8'));
const productCore = [
  'docs/product/REQUIREMENTS.md',
  'docs/product/SPECIFICATION.md',
  'docs/product/IMPLEMENTATION_PLAN.md',
  'docs/workflow/TASK_TRACKER.md',
  'docs/workflow/HANDOFF.md'
];
const verification = ['docs/workflow/VERIFICATION.md', 'ops/TEST_PLAN_MANIFEST.tsv'];
const security = ['docs/workflow/SECURITY.md', 'ops/SECURITY_MANIFEST.tsv'];

test('document sync policy validates and bounded glob matching stays path-aware', () => {
  assert.equal(policy.schema_version, '1.0.0');
  assert.equal(policySchema.properties.schema_version.const, policy.schema_version);
  assert.equal(policySchema.additionalProperties, false);
  assert.equal(globToRegExp('src/mcp*.js').test('src/mcp-http-transport.js'), true);
  assert.equal(globToRegExp('src/mcp*.js').test('src/nested/mcp.js'), false);
  assert.equal(globToRegExp('schemas/**').test('schemas/nested/example.json'), true);
  assert.throws(() => validateDocumentSyncPolicy({}), /Unsupported document sync policy version/);
  assert.throws(() => validateDocumentSyncPolicy({ ...policy, unsupported: true }), /unsupported field/);
});

test('sensitive runtime changes fail without the full product, verification, and security set', () => {
  const failed = evaluateDocumentSync(policy, ['src/agentic-human-review.js']);
  assert.equal(failed.status, 'fail');
  assert.equal(failed.matched_rules.some((rule) => rule.id === 'agentic-human-review-and-provider-boundaries'), true);
  assert.equal(failed.missing_all_of.includes('docs/workflow/SECURITY.md'), true);
  assert.equal(failed.missing_all_of.includes('docs/workflow/VERIFICATION.md'), true);

  const passed = evaluateDocumentSync(policy, ['src/agentic-human-review.js', ...productCore, ...verification, ...security]);
  assert.equal(passed.status, 'pass');
});

test('MCP, browser session, and evidence rules combine requirements without weakening each other', () => {
  const result = evaluateDocumentSync(policy, [
    'src/mcp.js',
    'src/browser-session-manager.js',
    'src/visual-evidence.js',
    ...productCore,
    ...verification,
    ...security
  ]);
  assert.equal(result.status, 'pass');
  assert.deepEqual(result.matched_rules.map((rule) => rule.id).filter((id) => ['mcp-authority', 'persistent-browser-session', 'evidence-evaluation-and-claim-boundaries'].includes(id)).sort(), [
    'evidence-evaluation-and-claim-boundaries',
    'mcp-authority',
    'persistent-browser-session'
  ]);
});

test('trigger all_of and none_of plus required any_of keep their distinct meanings', () => {
  const customPolicy = validateDocumentSyncPolicy({
    schema_version: '1.0.0',
    kind: 'document-sync-policy',
    excluded_paths: [],
    document_groups: {
      choice: { any_of: [['docs/first.md', 'docs/second.md']] }
    },
    rules: [{
      id: 'combined-trigger',
      description: 'Test combined trigger semantics.',
      trigger: { all_of: ['src/**', 'ops/flag.json'], none_of: ['generated/**'] },
      required_groups: ['choice']
    }]
  });
  assert.equal(evaluateDocumentSync(customPolicy, ['src/example.js', 'ops/flag.json']).status, 'fail');
  assert.equal(evaluateDocumentSync(customPolicy, ['src/example.js', 'ops/flag.json', 'docs/second.md']).status, 'pass');
  const excludedTrigger = evaluateDocumentSync(customPolicy, ['src/example.js', 'ops/flag.json', 'generated/output.json']);
  assert.equal(excludedTrigger.status, 'pass');
  assert.deepEqual(excludedTrigger.matched_rules, []);
});

test('workflow state stays paired and canonical product edits require all five authorities', () => {
  const workflowOnly = evaluateDocumentSync(policy, ['docs/workflow/TASK_TRACKER.md']);
  assert.equal(workflowOnly.status, 'fail');
  assert.deepEqual(workflowOnly.missing_all_of, ['docs/workflow/HANDOFF.md']);

  const productOnly = evaluateDocumentSync(policy, ['docs/product/SPECIFICATION.md']);
  assert.equal(productOnly.status, 'fail');
  assert.equal(productOnly.missing_all_of.includes('docs/product/REQUIREMENTS.md'), true);
  assert.equal(evaluateDocumentSync(policy, productCore).status, 'pass');
});

test('temporary memory and local settings neither trigger nor satisfy document synchronization', () => {
  const ignored = evaluateDocumentSync(policy, ['docs/memory/SESSION_MEMORY.md', 'ops/DASHBOARD_SETTINGS.json']);
  assert.equal(ignored.status, 'pass');
  assert.deepEqual(ignored.changed_files, []);
  const sensitive = evaluateDocumentSync(policy, ['src/mcp.js', 'docs/memory/SESSION_MEMORY.md', 'ops/DASHBOARD_SETTINGS.json']);
  assert.equal(sensitive.status, 'fail');
});

test('name-status parsing retains both sides of renames and deleted paths', () => {
  const parsed = parseNameStatusZ(Buffer.from('R100\0src/old.js\0src/mcp.js\0D\0src/browser-session-worker.js\0'));
  assert.deepEqual(parsed, ['src/browser-session-worker.js', 'src/mcp.js', 'src/old.js']);
});

test('a PR-wide union may synchronize implementation and documents from separate commits', () => {
  const implementationCommit = ['src/agentic-human-review.js'];
  const documentCommit = [...productCore, ...verification, ...security];
  assert.equal(evaluateDocumentSync(policy, implementationCommit).status, 'fail');
  assert.equal(evaluateDocumentSync(policy, [...implementationCommit, ...documentCommit]).status, 'pass');
});

test('hook installer is repository-local and refuses to replace unmanaged hook configuration', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-hook-install-'));
  const fakeBin = await mkdtemp(path.join(tmpdir(), 'trace-cue-fake-git-'));
  const stateFile = path.join(cwd, 'hooks-path');
  await mkdir(path.join(cwd, '.githooks'), { recursive: true });
  await writeFile(path.join(cwd, '.githooks/pre-push'), '#!/usr/bin/env bash\n');
  await chmod(path.join(cwd, '.githooks/pre-push'), 0o755);
  const fakeGit = path.join(fakeBin, 'git');
  await writeFile(fakeGit, `#!/usr/bin/env bash
set -euo pipefail
args="$*"
if [[ "$args" == *"rev-parse --show-toplevel"* ]]; then printf '%s\\n' "$FAKE_GIT_ROOT"; exit 0; fi
if [[ "$args" == *"config --local --get core.hooksPath"* ]]; then [[ -s "$FAKE_GIT_STATE" ]] || exit 1; cat "$FAKE_GIT_STATE"; exit 0; fi
if [[ "$args" == *"config --local --unset core.hooksPath"* ]]; then : > "$FAKE_GIT_STATE"; exit 0; fi
if [[ "$args" == *"config --local core.hooksPath .githooks"* ]]; then printf '.githooks\\n' > "$FAKE_GIT_STATE"; exit 0; fi
exit 2
`);
  await chmod(fakeGit, 0o755);
  const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, FAKE_GIT_ROOT: cwd, FAKE_GIT_STATE: stateFile };
  const installer = path.join(repoRoot, 'tools/install-git-hooks');
  const installed = spawnSync(installer, ['--repo', cwd], { encoding: 'utf8', env });
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal((await readFile(stateFile, 'utf8')).trim(), '.githooks');
  const removed = spawnSync(installer, ['--repo', cwd, '--uninstall'], { encoding: 'utf8', env });
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal((await readFile(stateFile, 'utf8')), '');

  await writeFile(stateFile, 'custom-hooks\n');
  const refused = spawnSync(installer, ['--repo', cwd], { encoding: 'utf8', env });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Refusing to replace unmanaged/);
});
