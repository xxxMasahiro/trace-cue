import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadVerificationPolicy } from '../tools/lib/verification-orchestration.mjs';
import { validateCiWorkflow } from '../tools/lib/verification-ci.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

test('repository CI matches exact owners, cache boundaries, and proof-only final gate', async () => {
  const loaded = await loadVerificationPolicy({ root });
  const source = await readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  const result = validateCiWorkflow({ source, policy: loaded.policy });
  assert.equal(result.final_job, 'final-gate');
  assert.deepEqual(result.required_jobs, [...loaded.policy.ci_graph.required_jobs].sort());
});

test('CI contract rejects missing owners, stale cache prefixes, duplicate builds, and final reruns', async (t) => {
  const loaded = await loadVerificationPolicy({ root });
  const source = await readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  const cases = [
    ['missing owner', source.replace(/^  package-producer:/mu, '  package-producer-missing:')],
    ['prefix cache', source.replace(/(\n\s+key:[^\n]+)/u, '$1\n          restore-keys: playwright-')],
    ['duplicate build', source.replace('run: npm run test:browser:run', 'run: npm run control-center:build\n      - name: Duplicate\n        run: npm run test:browser:run')],
    ['final rerun', source.replace('node ./tools/verification.mjs ci-proof', 'npm test && node ./tools/verification.mjs ci-proof')]
  ];
  for (const [name, mutated] of cases) await t.test(name, () => assert.throws(() => validateCiWorkflow({ source: mutated, policy: loaded.policy }), /CI verification contract failed/u));
});
