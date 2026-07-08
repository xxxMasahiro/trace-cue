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
export const PLAYWRIGHT_TEST_MODES = Object.freeze(['disabled', 'import_only', 'local_run', 'external_ci']);
export const PLAYWRIGHT_TEST_STATUSES = Object.freeze(['empty', 'passed', 'failed', 'blocked', 'evidence_missing', 'stale', 'error']);

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
