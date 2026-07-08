import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DEFAULT_ARTIFACT_ROOT, SCHEMA_VERSION } from './constants.js';
import { artifactObject, createArtifactId, ensureArtifactRoot, artifactRelPath, writeJsonArtifact } from './artifacts.js';
import { redactText } from './playwright-test-artifacts.js';

export const PLAYWRIGHT_TEST_INTEGRATION_VERSION = '1.0.0';
export const PLAYWRIGHT_TEST_SETTINGS_PATH = 'ops/DASHBOARD_SETTINGS.json';
export const PLAYWRIGHT_TEST_MODE_CONFIRM = 'set-playwright-test-mode';
export const PLAYWRIGHT_TEST_IMPORT_CONFIRM = 'import-playwright-test-result';
export const PLAYWRIGHT_TEST_EXTERNAL_CI_CONFIRM = 'fetch-playwright-test-ci-artifact';
export const PLAYWRIGHT_TEST_EXTERNAL_CI_SUGGEST_SETTINGS_CONFIRM = 'suggest-playwright-test-ci-settings';
export const PLAYWRIGHT_TEST_EXTERNAL_CI_APPROVE_SETTINGS_CONFIRM = 'approve-playwright-test-ci-settings';
export const PLAYWRIGHT_TEST_EXTERNAL_CI_FETCH_APPROVED_CONFIRM = 'fetch-approved-playwright-test-ci-artifact';
export const PLAYWRIGHT_TEST_MODES = Object.freeze(['disabled', 'import_only', 'local_run', 'external_ci']);
export const PLAYWRIGHT_TEST_STATUSES = Object.freeze(['empty', 'passed', 'failed', 'blocked', 'evidence_missing', 'stale', 'error']);
export const PLAYWRIGHT_TEST_EXTERNAL_CI_APPROVED_TARGET_POLICIES = Object.freeze([
  'latest_successful_run',
  'latest_successful_branch_run',
  'specific_head_sha'
]);

export function playwrightTestBoundary(overrides = {}) {
  return {
    local_only: true,
    advisory_only: true,
    writes_artifacts: false,
    existing_review_mutated: false,
    deterministic_findings_mutated: false,
    release_gate_mutated: false,
    proof_contract_satisfied: false,
    browser_launched: false,
    process_spawned: false,
    network_used: false,
    gh_used: false,
    gh_write_used: false,
    provider_call_performed: false,
    api_call_performed: false,
    external_upload: false,
    external_evidence_transfer: false,
    raw_artifact_content_included: false,
    raw_stdout_stored: false,
    raw_stderr_stored: false,
    credential_values_recorded: false,
    mcp_execution_exposed: false,
    gate_effect: 'none',
    ...overrides
  };
}

export function normalizePlaywrightTestMode(value, fallback = 'disabled') {
  const mode = String(value ?? fallback).trim();
  if (PLAYWRIGHT_TEST_MODES.includes(mode)) {
    return { ok: true, mode };
  }
  return {
    ok: false,
    code: 'PLAYWRIGHT_TEST_MODE_UNSUPPORTED',
    message: `Unsupported Playwright Test mode: ${mode}.`,
    details: { supported_modes: [...PLAYWRIGHT_TEST_MODES] }
  };
}

export function playwrightTestModeMatrix() {
  return {
    disabled: modeContract({
      label: 'Do not use Playwright Test results',
      reads_local_artifacts: false
    }),
    import_only: modeContract({
      label: 'Import existing result files',
      reads_local_artifacts: true,
      writes_artifacts: true
    }),
    local_run: modeContract({
      label: 'Run on this computer',
      reads_local_artifacts: true,
      writes_artifacts: true,
      browser_execution: true,
      process_spawn: true,
      execute_required: true
    }),
    external_ci: modeContract({
      label: 'Fetch from CI',
      reads_local_artifacts: true,
      writes_artifacts: true,
      network: true,
      process_spawn: true,
      gh_read_only: true,
      execute_required: true
    })
  };
}

function modeContract(overrides = {}) {
  return {
    reads_local_artifacts: false,
    writes_artifacts: false,
    browser_execution: false,
    network: false,
    process_spawn: false,
    gh_read_only: false,
    gh_write: false,
    execute_required: false,
    mcp_execution_exposed: false,
    release_gate_effect: false,
    raw_artifact_content_included: false,
    ...overrides
  };
}

export async function readPlaywrightTestSettings(cwd) {
  const settingsPath = path.resolve(cwd, PLAYWRIGHT_TEST_SETTINGS_PATH);
  let existing = {};
  try {
    existing = JSON.parse(await readFile(settingsPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      return fallbackSettings('disabled', 'settings_unreadable');
    }
  }
  const candidate = existing.playwright_test?.mode ?? existing.settings?.playwright_test?.mode ?? 'disabled';
  const normalized = normalizePlaywrightTestMode(candidate, 'disabled');
  return {
    schema_version: SCHEMA_VERSION,
    integration_version: PLAYWRIGHT_TEST_INTEGRATION_VERSION,
    settings_path: PLAYWRIGHT_TEST_SETTINGS_PATH,
    mode: normalized.ok ? normalized.mode : 'disabled',
    status: normalized.ok ? 'configured' : 'invalid_fallback_disabled',
    write_confirm: PLAYWRIGHT_TEST_MODE_CONFIRM,
    supported_modes: [...PLAYWRIGHT_TEST_MODES],
    mode_matrix: playwrightTestModeMatrix(),
    external_ci: summarizeExternalCiSettings(existing.playwright_test?.external_ci),
    labels: {
      disabled: '今は使わない',
      import_only: '既存結果を読む',
      local_run: 'このPCで確認する',
      external_ci: 'CI結果を見る'
    },
    safety: {
      default_mode: 'disabled',
      setting_write_does_not_execute: true,
      token_values_stored: false,
      browser_launched_by_settings: false,
      ci_contacted_by_settings: false
    },
    boundary: playwrightTestBoundary()
  };
}

function fallbackSettings(mode, status) {
  return {
    schema_version: SCHEMA_VERSION,
    integration_version: PLAYWRIGHT_TEST_INTEGRATION_VERSION,
    settings_path: PLAYWRIGHT_TEST_SETTINGS_PATH,
    mode,
    status,
    write_confirm: PLAYWRIGHT_TEST_MODE_CONFIRM,
    supported_modes: [...PLAYWRIGHT_TEST_MODES],
    mode_matrix: playwrightTestModeMatrix(),
    external_ci: summarizeExternalCiSettings(),
    labels: {},
    safety: {
      default_mode: 'disabled',
      setting_write_does_not_execute: true,
      token_values_stored: false,
      browser_launched_by_settings: false,
      ci_contacted_by_settings: false
    },
    boundary: playwrightTestBoundary()
  };
}

export async function writePlaywrightTestMode(input = {}, context = {}) {
  const validation = validateModeWriteInput(input);
  if (!validation.ok) {
    return resultError(validation.code, validation.message, validation.details);
  }
  const cwd = context.cwd ?? process.cwd();
  const settingsPath = path.resolve(cwd, PLAYWRIGHT_TEST_SETTINGS_PATH);
  let existing = {};
  try {
    existing = JSON.parse(await readFile(settingsPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      return resultError('PLAYWRIGHT_TEST_SETTINGS_UNREADABLE', 'Playwright Test settings could not be read.', {});
    }
  }
  const now = materializeNow(context.now).toISOString();
  const next = {
    ...existing,
    playwright_test: {
      ...(existing.playwright_test ?? {}),
      schema_version: SCHEMA_VERSION,
      integration_version: PLAYWRIGHT_TEST_INTEGRATION_VERSION,
      mode: validation.mode,
      selected_at: now,
      external_ci: {
        ...(existing.playwright_test?.external_ci ?? {}),
        token_storage: 'env_or_gh_auth_only'
      }
    }
  };
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return {
    status: 'ok',
    data: {
      playwright_test_mode: {
        schema_version: SCHEMA_VERSION,
        integration_version: PLAYWRIGHT_TEST_INTEGRATION_VERSION,
        status: 'applied',
        mode: validation.mode,
        settings_path: PLAYWRIGHT_TEST_SETTINGS_PATH,
        selected_at: now,
        safety: {
          setting_write_does_not_execute: true,
          browser_launched: false,
          network_used: false,
          gh_used: false,
          credential_values_recorded: false
        },
        boundary: playwrightTestBoundary()
      }
    },
    warnings: [],
    errors: [],
    artifacts: []
  };
}

export async function writePlaywrightTestExternalCiApprovedSettings(input = {}, context = {}) {
  if (input.confirm !== PLAYWRIGHT_TEST_EXTERNAL_CI_APPROVE_SETTINGS_CONFIRM) {
    return resultError('PLAYWRIGHT_TEST_EXTERNAL_CI_SETTINGS_CONFIRM_REQUIRED', 'Playwright Test external CI settings require explicit approval.', {
      confirm: PLAYWRIGHT_TEST_EXTERNAL_CI_APPROVE_SETTINGS_CONFIRM
    });
  }
  const validation = validatePlaywrightTestExternalCiApprovedFetchSettings(input);
  if (!validation.ok) {
    return resultError(validation.code, validation.message, validation.details);
  }
  const cwd = context.cwd ?? process.cwd();
  const settingsPath = path.resolve(cwd, PLAYWRIGHT_TEST_SETTINGS_PATH);
  let existing = {};
  try {
    existing = JSON.parse(await readFile(settingsPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      return resultError('PLAYWRIGHT_TEST_SETTINGS_UNREADABLE', 'Playwright Test settings could not be read.', {});
    }
  }
  const approvedAt = materializeNow(context.now).toISOString();
  const approved = {
    ...validation.value,
    status: 'approved',
    approved_at: approvedAt,
    approval_hash: buildFreshnessSignature({
      kind: 'playwright_test_external_ci_approved_fetch',
      ...validation.value
    })
  };
  const next = {
    ...existing,
    playwright_test: {
      ...(existing.playwright_test ?? {}),
      schema_version: SCHEMA_VERSION,
      integration_version: PLAYWRIGHT_TEST_INTEGRATION_VERSION,
      mode: existing.playwright_test?.mode ?? 'external_ci',
      external_ci: {
        ...(existing.playwright_test?.external_ci ?? {}),
        token_storage: 'env_or_gh_auth_only',
        approved_fetch: approved
      }
    }
  };
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return {
    status: 'ok',
    data: {
      playwright_test_external_ci_approved_settings: {
        schema_version: SCHEMA_VERSION,
        integration_version: PLAYWRIGHT_TEST_INTEGRATION_VERSION,
        status: 'approved',
        settings_path: PLAYWRIGHT_TEST_SETTINGS_PATH,
        approved_fetch: summarizeApprovedFetchSettings(approved),
        safety: {
          setting_write_does_not_execute: true,
          browser_launched: false,
          network_used: false,
          gh_used: false,
          credential_values_recorded: false
        },
        boundary: playwrightTestBoundary()
      }
    },
    warnings: [],
    errors: [],
    artifacts: []
  };
}

function validateModeWriteInput(input) {
  if (input.confirm !== PLAYWRIGHT_TEST_MODE_CONFIRM) {
    return {
      ok: false,
      code: 'PLAYWRIGHT_TEST_MODE_CONFIRM_REQUIRED',
      message: 'Playwright Test mode changes require explicit confirmation.',
      details: { confirm: PLAYWRIGHT_TEST_MODE_CONFIRM }
    };
  }
  const normalized = normalizePlaywrightTestMode(input.mode);
  if (!normalized.ok) {
    return normalized;
  }
  return { ok: true, mode: normalized.mode };
}

export function validatePlaywrightTestExternalCiApprovedFetchSettings(input = {}) {
  const secret = firstCredentialLikeField(input);
  if (secret) {
    return {
      ok: false,
      code: 'PLAYWRIGHT_TEST_EXTERNAL_CI_SETTINGS_SECRET_REJECTED',
      message: 'External CI approved settings must not include credential or token fields.',
      details: { field: secret }
    };
  }
  const repo = normalizeRepoField(input.repo);
  if (!repo.ok) {
    return repo;
  }
  const artifactName = normalizeArtifactNameField(input.artifact_name ?? input.artifactName ?? input['artifact-name']);
  if (!artifactName.ok) {
    return artifactName;
  }
  const workflowName = normalizeOptionalName(input.workflow_name ?? input.workflowName ?? input['workflow-name'] ?? input.workflow, 'workflow_name');
  if (!workflowName.ok) {
    return workflowName;
  }
  const branch = normalizeOptionalRef(input.branch ?? input.ref, 'branch');
  if (!branch.ok) {
    return branch;
  }
  const event = normalizeOptionalToken(input.event, 'event');
  if (!event.ok) {
    return event;
  }
  const headSha = normalizeOptionalHeadSha(input.head_sha ?? input.headSha ?? input['head-sha']);
  if (!headSha.ok) {
    return headSha;
  }
  const targetPolicy = normalizeTargetPolicy(input.target_policy ?? input.targetPolicy ?? input['target-policy'], headSha.value);
  if (!targetPolicy.ok) {
    return targetPolicy;
  }
  const limit = normalizeBoundedInteger(input.limit, 'limit', 20, 1, 50);
  if (!limit.ok) {
    return limit;
  }
  const maxAgeHours = normalizeBoundedInteger(input.max_age_hours ?? input.maxAgeHours ?? input['max-age-hours'], 'max_age_hours', 168, 1, 2160);
  if (!maxAgeHours.ok) {
    return maxAgeHours;
  }
  return {
    ok: true,
    value: compactObject({
      provider: 'github_actions',
      repo: repo.value,
      workflow_name: workflowName.value,
      branch: branch.value,
      event: event.value,
      conclusion: 'success',
      status_filter: 'completed',
      artifact_name: artifactName.value,
      target_policy: targetPolicy.value,
      head_sha: headSha.value,
      limit: limit.value,
      max_age_hours: maxAgeHours.value,
      token_storage: 'env_or_gh_auth_only',
      raw_output_included: false
    })
  };
}

function summarizeExternalCiSettings(externalCi = {}) {
  return {
    token_storage: 'env_or_gh_auth_only',
    approved_fetch: summarizeApprovedFetchSettings(externalCi?.approved_fetch),
    safety: {
      token_values_stored: false,
      setting_write_does_not_execute: true,
      ci_contacted_by_settings: false,
      browser_launched_by_settings: false
    }
  };
}

function summarizeApprovedFetchSettings(value = {}) {
  if (!value || typeof value !== 'object' || !value.repo || !value.artifact_name) {
    return {
      configured: false,
      status: 'not_configured',
      provider: 'github_actions',
      token_storage: 'env_or_gh_auth_only',
      raw_output_included: false
    };
  }
  return {
    configured: true,
    status: value.status ?? 'approved',
    provider: 'github_actions',
    repo: value.repo,
    workflow_name: value.workflow_name ?? null,
    branch: value.branch ?? null,
    event: value.event ?? null,
    conclusion: value.conclusion ?? 'success',
    status_filter: value.status_filter ?? 'completed',
    artifact_name: value.artifact_name,
    target_policy: value.target_policy ?? 'latest_successful_run',
    head_sha: value.head_sha ?? null,
    limit: value.limit ?? 20,
    max_age_hours: value.max_age_hours ?? 168,
    approved_at: value.approved_at ?? null,
    approval_hash: value.approval_hash ?? null,
    token_storage: 'env_or_gh_auth_only',
    raw_output_included: false,
    boundary: playwrightTestBoundary()
  };
}

function firstCredentialLikeField(value, prefix = '') {
  if (!value || typeof value !== 'object') {
    return null;
  }
  for (const [key, item] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (key === 'token_storage') {
      continue;
    }
    if (/(token|secret|password|credential|authorization|gh_token|github_token)/i.test(key)) {
      return name;
    }
    if (item && typeof item === 'object') {
      const nested = firstCredentialLikeField(item, name);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}

function normalizeRepoField(value) {
  const repo = String(value ?? '').trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    return { ok: false, code: 'PLAYWRIGHT_TEST_EXTERNAL_CI_REPO_INVALID', message: 'external CI settings require repo as owner/repo.', details: {} };
  }
  return { ok: true, value: repo };
}

function normalizeArtifactNameField(value) {
  const name = String(value ?? '').trim();
  if (!/^[A-Za-z0-9_. -]{1,120}$/.test(name)) {
    return { ok: false, code: 'PLAYWRIGHT_TEST_EXTERNAL_CI_ARTIFACT_NAME_INVALID', message: 'external CI settings require an exact artifact name.', details: {} };
  }
  return { ok: true, value: name };
}

function normalizeOptionalName(value, field) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return { ok: true, value: null };
  }
  const name = String(value).trim();
  if (!/^[A-Za-z0-9_. /:-]{1,120}$/.test(name)) {
    return { ok: false, code: 'PLAYWRIGHT_TEST_EXTERNAL_CI_SETTING_INVALID', message: `external CI ${field} is invalid.`, details: { field } };
  }
  return { ok: true, value: name };
}

function normalizeOptionalRef(value, field) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return { ok: true, value: null };
  }
  const ref = String(value).trim();
  if (!/^[A-Za-z0-9_./-]{1,160}$/.test(ref)) {
    return { ok: false, code: 'PLAYWRIGHT_TEST_EXTERNAL_CI_SETTING_INVALID', message: `external CI ${field} is invalid.`, details: { field } };
  }
  return { ok: true, value: ref };
}

function normalizeOptionalToken(value, field) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return { ok: true, value: null };
  }
  const token = String(value).trim();
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(token)) {
    return { ok: false, code: 'PLAYWRIGHT_TEST_EXTERNAL_CI_SETTING_INVALID', message: `external CI ${field} is invalid.`, details: { field } };
  }
  return { ok: true, value: token };
}

function normalizeOptionalHeadSha(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return { ok: true, value: null };
  }
  const sha = String(value).trim();
  if (!/^[a-fA-F0-9]{40}$/.test(sha)) {
    return { ok: false, code: 'PLAYWRIGHT_TEST_EXTERNAL_CI_HEAD_SHA_INVALID', message: 'external CI head_sha must be a 40-character SHA.', details: {} };
  }
  return { ok: true, value: sha.toLowerCase() };
}

function normalizeTargetPolicy(value, headSha) {
  const policy = String(value ?? (headSha ? 'specific_head_sha' : 'latest_successful_run')).trim();
  if (!PLAYWRIGHT_TEST_EXTERNAL_CI_APPROVED_TARGET_POLICIES.includes(policy)) {
    return {
      ok: false,
      code: 'PLAYWRIGHT_TEST_EXTERNAL_CI_TARGET_POLICY_UNSUPPORTED',
      message: `Unsupported external CI target policy: ${policy}.`,
      details: { supported_policies: [...PLAYWRIGHT_TEST_EXTERNAL_CI_APPROVED_TARGET_POLICIES] }
    };
  }
  if (policy === 'specific_head_sha' && !headSha) {
    return {
      ok: false,
      code: 'PLAYWRIGHT_TEST_EXTERNAL_CI_HEAD_SHA_REQUIRED',
      message: 'specific_head_sha policy requires head_sha.',
      details: {}
    };
  }
  return { ok: true, value: policy };
}

function normalizeBoundedInteger(value, field, fallback, min, max) {
  const number = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    return { ok: false, code: 'PLAYWRIGHT_TEST_EXTERNAL_CI_SETTING_INVALID', message: `external CI ${field} must be an integer from ${min} to ${max}.`, details: { field, min, max } };
  }
  return { ok: true, value: number };
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

export async function writePlaywrightTestResultArtifacts({ cwd, artifactRootInput = DEFAULT_ARTIFACT_ROOT, id, result, receipt, now }) {
  const root = await ensureArtifactRoot(cwd, artifactRootInput);
  const resultRelParts = ['playwright-test-results', `${id}.json`];
  const receiptRelParts = ['receipts', `${id}.json`];
  await writeJsonArtifact(root, resultRelParts, result);
  await writeJsonArtifact(root, receiptRelParts, receipt);
  return [
    artifactObject({
      type: 'playwright_test_result',
      path: artifactRelPath(artifactRootInput, ...resultRelParts),
      description: 'Normalized Playwright Test regression result metadata.'
    }),
    artifactObject({
      type: 'playwright_test_receipt',
      path: artifactRelPath(artifactRootInput, ...receiptRelParts),
      description: 'Content-free receipt for Playwright Test integration work.'
    })
  ];
}

export function createPlaywrightTestResultId(now = new Date(), prefix = 'playwright-test') {
  return createArtifactId(now, prefix);
}

export function buildFreshnessSignature(parts = {}) {
  const canonical = JSON.stringify(sortObject(redactSignature(parts)));
  return createHash('sha256').update(canonical).digest('hex');
}

function redactSignature(value) {
  if (Array.isArray(value)) {
    return value.map(redactSignature);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactSignature(item)]));
  }
  if (typeof value === 'string') {
    return redactText(value);
  }
  return value ?? null;
}

function sortObject(value) {
  if (Array.isArray(value)) {
    return value.map(sortObject);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObject(value[key])]));
  }
  return value;
}

export function classifyPlaywrightTestSummary(summary = {}) {
  if (summary.prerequisite_blocked) {
    return 'blocked';
  }
  if (summary.evidence_missing) {
    return 'evidence_missing';
  }
  if (summary.stale) {
    return 'stale';
  }
  if ((summary.failed_count ?? 0) > 0 || (summary.timed_out_count ?? 0) > 0) {
    return 'failed';
  }
  if ((summary.total_count ?? 0) > 0) {
    return 'passed';
  }
  return 'empty';
}

export function summarizeStatusLabel(status) {
  return {
    empty: 'No Playwright Test result imported.',
    passed: 'Playwright Test regression checks passed.',
    failed: 'Playwright Test regression checks failed.',
    blocked: 'Playwright Test checks are blocked by missing prerequisites.',
    evidence_missing: 'Playwright Test result evidence is incomplete.',
    stale: 'Playwright Test result is stale.',
    error: 'Playwright Test result could not be read.'
  }[status] ?? 'Playwright Test status unavailable.';
}

export function resultError(code, message, details = {}) {
  return {
    status: 'error',
    data: {
      boundary: playwrightTestBoundary()
    },
    warnings: [],
    errors: [{ code, message, details }],
    artifacts: []
  };
}

export function materializeNow(now = new Date()) {
  if (typeof now === 'function') {
    return materializeNow(now());
  }
  return now instanceof Date ? now : new Date(now);
}
