import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  validateCiProof
} from './verification-orchestration.mjs';
import { extractBoundedZipFiles } from './safe-zip.mjs';
import { githubRepositoryIdentity } from './github-repository-identity.mjs';

const execFileAsync = promisify(execFile);
const MAX_API_BYTES = 8 * 1024 * 1024;

export async function verifyCiProofImport({
  loadedPolicy,
  snapshot,
  runId,
  api = githubApi
} = {}) {
  if (!loadedPolicy?.root || !loadedPolicy?.policy || !snapshot?.head_sha || !snapshot?.tree_sha) {
    throw new Error('CI proof verification requires a loaded policy and repository snapshot.');
  }
  const policy = loadedPolicy.policy.evidence_policy;
  if (snapshot.worktree_state !== 'clean') throw new Error('CI proof import requires a clean worktree.');
  const { repository, hostname } = githubRepositoryIdentity(
    loadedPolicy.root,
    policy.ci_proof_repository_remote,
    policy.ci_proof_repository_hosts
  );
  const authenticatedApi = (endpoint, options = {}) => callBoundedGithubApi({
    api,
    endpoint,
    options: { ...options, hostname },
    timeoutMs: policy.ci_proof_api_timeout_ms
  });
  const selectedRunId = runId ?? await findLatestRun({ api: authenticatedApi, repository, snapshot, workflowPath: policy.ci_proof_workflow_path });
  if (!/^[1-9][0-9]*$/u.test(String(selectedRunId ?? ''))) throw new Error('CI proof run id is invalid.');

  const run = parseJson(await authenticatedApi(`repos/${repository}/actions/runs/${selectedRunId}`), 'CI workflow run');
  validateRun(run, { repository, snapshot, workflowPath: policy.ci_proof_workflow_path, runId: selectedRunId });
  const expectedArtifactName = `${policy.ci_proof_artifact_prefix}-${run.id}-${run.run_attempt}`;
  const artifactList = parseJson(await authenticatedApi(`repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`), 'CI artifact list');
  const artifacts = Array.isArray(artifactList.artifacts)
    ? artifactList.artifacts.filter((artifact) => artifact?.name === expectedArtifactName)
    : [];
  if (artifacts.length !== 1) throw new Error('CI proof import requires exactly one matching artifact.');
  const artifact = artifacts[0];
  if (!Number.isSafeInteger(Number(artifact.id)) || Number(artifact.id) <= 0 || artifact.expired !== false
    || (artifact.workflow_run?.id !== undefined && Number(artifact.workflow_run.id) !== Number(run.id))) {
    throw new Error('CI proof artifact identity or retention state is invalid.');
  }
  if (Number.isFinite(Number(artifact.size_in_bytes)) && Number(artifact.size_in_bytes) > MAX_API_BYTES) {
    throw new Error('CI proof artifact exceeds its size limit.');
  }
  const archive = await authenticatedApi(`repos/${repository}/actions/artifacts/${artifact.id}/zip`, { binary: true });
  const files = extractBoundedZipFiles(archive);
  if (files.size !== 1 || !files.has(policy.ci_proof_filename)) {
    throw new Error('CI proof artifact contains an unexpected file set.');
  }
  const proof = parseJson(files.get(policy.ci_proof_filename), 'CI proof');
  const validated = validateCiProof({ loadedPolicy, proof });
  if (validated.repository !== repository
    || String(validated.run_id) !== String(run.id)
    || validated.run_attempt !== Number(run.run_attempt)
    || validated.workflow_path !== policy.ci_proof_workflow_path
    || validated.artifact_name !== expectedArtifactName) {
    throw new Error('CI proof does not match the authenticated workflow run and artifact.');
  }

  const remoteObservation = {
    repository,
    run_id: String(run.id),
    run_attempt: Number(run.run_attempt),
    workflow_path: policy.ci_proof_workflow_path,
    artifact_id: Number(artifact.id),
    artifact_name: expectedArtifactName
  };
  return {
    schema_version: '1.0.0',
    kind: 'verified-ci-proof-import',
    status: 'passed',
    repository,
    run_id: String(run.id),
    run_attempt: Number(run.run_attempt),
    head_sha: validated.head_sha,
    workflow_path: validated.workflow_path,
    artifact_name: validated.artifact_name,
    proof_digest: validated.proof_digest,
    proof: validated,
    remote_observation: remoteObservation
  };
}

async function callBoundedGithubApi({ api, endpoint, options, timeoutMs }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('CI proof API timeout policy is invalid.');
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('CI proof GitHub API request timed out.'));
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => api(endpoint, { ...options, timeoutMs, signal: controller.signal })),
      timeout
    ]);
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
      throw new Error('CI proof GitHub API request timed out.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function findLatestRun({ api, repository, snapshot, workflowPath }) {
  const response = parseJson(await api(
    `repos/${repository}/actions/runs?head_sha=${snapshot.head_sha}&status=completed&per_page=50`
  ), 'CI workflow run list');
  const candidates = Array.isArray(response.workflow_runs) ? response.workflow_runs.filter((run) => (
    run?.head_sha === snapshot.head_sha
    && run.path === workflowPath
    && run.status === 'completed'
    && run.conclusion === 'success'
    && run.repository?.full_name === repository
  )) : [];
  candidates.sort((a, b) => Number(b.id) - Number(a.id));
  if (!candidates.length) throw new Error('No successful CI proof run matches the current revision.');
  return candidates[0].id;
}

function validateRun(run, expected) {
  if (!run || typeof run !== 'object' || Array.isArray(run)
    || String(run.id) !== String(expected.runId)
    || !Number.isSafeInteger(Number(run.run_attempt)) || Number(run.run_attempt) <= 0
    || run.status !== 'completed' || run.conclusion !== 'success'
    || run.head_sha !== expected.snapshot.head_sha
    || run.path !== expected.workflowPath
    || run.repository?.full_name !== expected.repository) {
    throw new Error('CI workflow run does not match the current repository, revision, workflow, and successful attempt.');
  }
}

function parseJson(value, label) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  if (buffer.length === 0 || buffer.length > MAX_API_BYTES) throw new Error(`${label} response size is invalid.`);
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new Error(`${label} response is not valid JSON.`);
  }
}

export function githubApiArguments(endpoint, hostname) {
  if (typeof endpoint !== 'string' || !endpoint.startsWith('repos/') || /[\0\r\n]/u.test(endpoint)) {
    throw new Error('CI proof GitHub API endpoint is invalid.');
  }
  if (typeof hostname !== 'string' || !/^[A-Za-z0-9.-]+$/u.test(hostname)) {
    throw new Error('CI proof GitHub API hostname is invalid.');
  }
  return Object.freeze(['api', '--hostname', hostname, endpoint]);
}

async function githubApi(endpoint, { binary = false, hostname, timeoutMs, signal } = {}) {
  const args = githubApiArguments(endpoint, hostname);
  try {
    const { stdout } = await execFileAsync('gh', args, {
      encoding: binary ? null : 'utf8',
      maxBuffer: MAX_API_BYTES,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      signal,
      windowsHide: true,
      env: { ...process.env, GH_HOST: hostname }
    });
    return stdout;
  } catch (error) {
    if (signal?.aborted || error?.killed || error?.code === 'ABORT_ERR') {
      throw new Error('CI proof GitHub API request timed out.');
    }
    throw new Error('CI proof GitHub API request failed.');
  }
}
