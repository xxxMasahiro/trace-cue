import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadVerificationPolicy } from '../tools/lib/verification-orchestration.mjs';
import { validateCiWorkflow } from '../tools/lib/verification-ci.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function moveNodeSetupAfterTests(source) {
  const start = source.indexOf('\n  node:');
  const end = source.indexOf('\n  package-producer:', start);
  const block = source.slice(start, end);
  const setup = /\n      - name: Set up Node\.js\n        uses: actions\/setup-node@v5\n        with:\n          node-version: \$\{\{ matrix\.node-version \}\}\n          cache: npm\n/u.exec(block)?.[0];
  assert.ok(setup, 'Node setup fixture must exist');
  const moved = block.replace(setup, '').replace('        run: npm test', `        run: npm test${setup}`);
  return `${source.slice(0, start)}${moved}${source.slice(end)}`;
}

test('repository CI matches exact owners, cache boundaries, and proof-only final gate', async () => {
  const loaded = await loadVerificationPolicy({ root });
  const source = await readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  const result = validateCiWorkflow({ source, policy: loaded.policy });
  assert.equal(result.final_job, 'final-gate');
  assert.deepEqual(result.required_jobs, [...loaded.policy.ci_graph.required_jobs].sort());
});

test('CI contract rejects missing owners, matrices, artifact bindings, stale caches, duplicate builds, and final reruns', async (t) => {
  const loaded = await loadVerificationPolicy({ root });
  const source = await readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  const cases = [
    ['missing owner', source.replace(/^  package-producer:/mu, '  package-producer-missing:')],
    ['missing Node matrix instance', source.replace(/(  node:[\s\S]*?node-version:\n          - 20)\n          - 22/u, '$1')],
    ['missing package matrix instance', source.replace(/(  package-consumer:[\s\S]*?node-version:\n          - 20)\n          - 22/u, '$1')],
    ['fixed matrix runtime', source.replace('node-version: ${{ matrix.node-version }}', 'node-version: 20')],
    ['setup after compatibility tests', moveNodeSetupAfterTests(source)],
    ['checkout old revision', source.replace('fetch-depth: 0\n          persist-credentials: false', `fetch-depth: 0\n          persist-credentials: false\n          ref: ${'a'.repeat(40)}`)],
    ['checkout credentials retained', source.replace('persist-credentials: false', 'persist-credentials: true')],
    ['owner write permission', source.replace('  node:\n', '  node:\n    permissions:\n      contents: write\n')],
    ['unregistered job', source.replace('  final-gate:\n', '  unregistered:\n    runs-on: ubuntu-latest\n    steps:\n      - run: git push\n\n  final-gate:\n')],
    ['self-hosted runner', source.replace('runs-on: ubuntu-latest', 'runs-on: self-hosted')],
    ['workflow environment override', source.replace('permissions:\n', 'env:\n  PATH: /tmp/fake-bin\n\npermissions:\n')],
    ['workflow defaults override', source.replace('permissions:\n', 'defaults:\n  run:\n    working-directory: ./fixtures\n\npermissions:\n')],
    ['missing pull request trigger', source.replace('  pull_request:\n', '')],
    ['producer output remap', source.replace('manifest-digest: ${{ steps.package.outputs.manifest-digest }}', 'manifest-digest: unbound')],
    ['removed no-browser command', source.replace('run: npm test', 'run: node --version')],
    ['masked no-browser command', source.replace('run: npm test', 'run: npm test || :')],
    ['exit before no-browser command', source.replace('run: npm test', 'run: |\n          exit 0\n          npm test')],
    ['false branch no-browser command', source.replace('run: npm test', 'run: |\n          if false; then\n            npm test\n          fi')],
    ['fake npm function', source.replace('run: npm test', 'run: |\n          npm() { return 0; }\n          npm test')],
    ['owner PATH override', source.replace('  node:\n', '  node:\n    env:\n      PATH: /tmp/fake-bin\n')],
    ['missing repository install', source.replace('      - name: Install contract dependencies\n        run: npm ci\n\n', '')],
    ['conditional no-browser command', source.replace('      - name: Run no-browser compatibility tests', '      - name: Run no-browser compatibility tests\n        if: ${{ false }}')],
    ['ignored no-browser failure', source.replace('        run: npm test', '        continue-on-error: true\n        run: npm test')],
    ['spaced ignored no-browser failure', source.replace('        run: npm test', '        continue-on-error : true\n        run: npm test')],
    ['ignored owner job failure', source.replace('  node:\n', '  node:\n    continue-on-error: true\n')],
    ['excluded Node matrix instance', source.replace(
      /(  node:[\s\S]*?node-version:\n          - 20\n          - 22)/u,
      '$1\n        exclude:\n          - node-version: 22'
    )],
    ['wrong artifact name', source.replace('name: package-${{ github.run_id }}-${{ github.run_attempt }}', 'name: package-unbound')],
    ['prefix cache', source.replace(/(\n\s+key:[^\n]+)/u, '$1\n          restore-keys: playwright-')],
    ['duplicate build', source.replace('run: npm run test:browser:run', 'run: npm run control-center:build\n      - name: Duplicate\n        run: npm run test:browser:run')],
    ['missing package materialization', source.replace('node ./tools/pack-install-smoke.mjs materialize', 'node ./tools/pack-install-smoke.mjs consume')],
    ['missing required package file', source.replace('--required-file index.html', '--required-file other.html')],
    ['missing final owner result', source.replace('"browser-smoke":"${{ needs.browser-smoke.result }}"', '"browser-smoke":"success"')],
    ['final rerun', source.replace('node ./tools/verification.mjs ci-proof', 'npm test && node ./tools/verification.mjs ci-proof')]
  ];
  for (const [name, mutated] of cases) await t.test(name, () => assert.throws(() => validateCiWorkflow({ source: mutated, policy: loaded.policy }), /CI verification contract failed/u));
});
