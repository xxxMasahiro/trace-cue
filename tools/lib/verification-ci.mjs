import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadVerificationPolicy } from './verification-orchestration.mjs';

function fail(message) {
  throw new Error(`CI verification contract failed: ${message}`);
}

function parseJobs(source) {
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
      current = { id: jobMatch[1], lines: [], needs: [] };
      jobs.set(current.id, current);
      continue;
    }
    if (!current) continue;
    current.lines.push(line);
  }
  for (const job of jobs.values()) {
    for (let index = 0; index < job.lines.length; index += 1) {
      const line = job.lines[index];
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

function count(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

export function validateCiWorkflow({ source, policy }) {
  if (typeof source !== 'string' || !source) fail('workflow source is empty');
  const jobs = parseJobs(source);
  const graph = policy.ci_graph;
  for (const owner of graph.owners) if (!jobs.has(owner.job_id)) fail(`missing owner job ${owner.job_id}`);
  if (!jobs.has(graph.final_job_id)) fail(`missing final job ${graph.final_job_id}`);
  const finalJob = jobs.get(graph.final_job_id);
  const actualNeeds = [...new Set(finalJob.needs)].sort();
  const requiredNeeds = [...graph.required_jobs].sort();
  if (JSON.stringify(actualNeeds) !== JSON.stringify(requiredNeeds)) fail(`final job needs mismatch: ${actualNeeds.join(',')}`);
  const finalSource = finalJob.lines.join('\n');
  if (!/^    if:\s*\$\{\{\s*always\(\)\s*\}\}\s*$/mu.test(finalSource)) fail('final job must run with if: always()');
  if (!/verification\.mjs ci-proof/u.test(finalSource)) fail('final job must produce a policy-bound proof');
  if (/npm test|test:browser|test:pack|product-gate|release:check/u.test(finalSource)) fail('final job must not rerun provider suites');

  if (!/^concurrency:\s*$/mu.test(source) || !/^  cancel-in-progress:\s*true\s*$/mu.test(source)) fail('superseded workflow runs must be cancelled');
  if (!/^permissions:\s*\n  contents:\s*read\s*$/mu.test(source)) fail('workflow permissions must remain read-only');
  for (const job of jobs.values()) if (!/^    timeout-minutes:\s*[1-9][0-9]*\s*$/mu.test(job.lines.join('\n'))) fail(`job ${job.id} needs a timeout`);

  if (count(source, /run:\s*npm run control-center:build\s*$/gmu) !== 1) fail('Control Center build must have exactly one CI owner');
  if (count(source, /run:\s*npm run test:browser:run\s*$/gmu) !== 1) fail('browser execution must have exactly one CI owner');
  if (/run:\s*npm run test:browser\s*$/mu.test(source)) fail('CI must use the build-free browser command');
  if (!/uses:\s*actions\/cache@v5(?:\.0\.5)?\s*$/mu.test(source)) fail('Playwright binary cache action is missing');
  if (/restore-keys:/u.test(source)) fail('prefix cache restore keys are forbidden');
  if (!/path:\s*~\/\.cache\/ms-playwright\s*$/mu.test(source)) fail('cache must be limited to Playwright browser binaries');
  if (!/runner\.os.*runner\.arch.*hashFiles\('package-lock\.json', 'node_modules\/playwright-core\/browsers\.json'\)/u.test(source)) fail('Playwright cache key must bind OS, architecture, lockfile, and browser revision metadata');
  if (!/playwright install-deps chromium/u.test(source) || !/playwright install --force chromium/u.test(source)) fail('browser cache must retain dependency setup and fail-safe reinstall');

  if (count(source, /pack-install-smoke\.mjs produce/gu) !== 1) fail('package artifact must have exactly one producer');
  if (!/pack-install-smoke\.mjs consume/gu.test(source)) fail('package artifact needs a verified consumer');
  if (!/producer-toolchain-digest/gu.test(source) || !/--producer-toolchain-digest/gu.test(source)) fail('package consumers must bind the producer toolchain digest');
  if (!/actions\/upload-artifact@v7(?:\.0\.1)?/u.test(source) || !/actions\/download-artifact@v8(?:\.0\.1)?/u.test(source)) fail('same-run package artifact transport is incomplete');
  if (!/retention-days:\s*1\s*$/mu.test(source)) fail('package artifact retention must be bounded');
  if (/npm publish|curl\s|wget\s|secrets\./iu.test(source)) fail('workflow contains forbidden publishing, external transfer, or secret usage');

  return { jobs: [...jobs.keys()], final_job: graph.final_job_id, required_jobs: requiredNeeds };
}

export async function checkRepositoryCi({ root = process.cwd() } = {}) {
  const loadedPolicy = await loadVerificationPolicy({ root });
  const workflowPath = path.join(loadedPolicy.root, '.github/workflows/ci.yml');
  const source = await readFile(workflowPath, 'utf8');
  return validateCiWorkflow({ source, policy: loadedPolicy.policy });
}
