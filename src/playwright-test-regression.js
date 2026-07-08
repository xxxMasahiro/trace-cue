import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_ARTIFACT_ROOT, SCHEMA_VERSION } from './constants.js';
import { resolveArtifactRoot } from './artifacts.js';
import { readBoundedTextFile } from './playwright-test-artifacts.js';
import {
  PLAYWRIGHT_TEST_INTEGRATION_VERSION,
  classifyPlaywrightTestSummary,
  playwrightTestBoundary,
  readPlaywrightTestSettings,
  summarizeStatusLabel
} from './playwright-test-integration.js';
import {
  buildPlaywrightTestReviewProjectionFromResults,
  runPlaywrightTestReviewMaterial
} from './e2e-result-review-material.js';

export async function runPlaywrightTestStatus(options = {}, context = {}) {
  const cwd = context.cwd ?? process.cwd();
  const summary = await buildPlaywrightTestRegressionSummary(cwd, options, context);
  return {
    status: 'ok',
    data: {
      playwright_test: summary,
      boundary: summary.boundary
    },
    warnings: summary.warnings,
    errors: [],
    artifacts: []
  };
}

export async function runPlaywrightTestList(options = {}, context = {}) {
  const cwd = context.cwd ?? process.cwd();
  const results = await readResultIndex(cwd, options);
  const limit = Math.min(Number(options.limit) || 20, 100);
  return {
    status: 'ok',
    data: {
      playwright_test_results: {
        schema_version: SCHEMA_VERSION,
        integration_version: PLAYWRIGHT_TEST_INTEGRATION_VERSION,
        count: results.length,
        results: results.slice(0, limit).map((result) => ({
          id: result.id,
          status: result.status,
          status_label: result.status_label,
          source_kind: result.source?.kind ?? 'unknown',
          total_count: result.summary?.total_count ?? 0,
          failed_count: result.summary?.failed_count ?? 0,
          stale: result.freshness?.stale === true,
          raw_content_included: false
        })),
        boundary: playwrightTestBoundary()
      }
    },
    warnings: [],
    errors: [],
    artifacts: []
  };
}

export async function runPlaywrightTestReport(options = {}, context = {}) {
  const cwd = context.cwd ?? process.cwd();
  const result = await readResultByInput(cwd, options);
  if (!result.ok) {
    return {
      status: 'error',
      data: { boundary: playwrightTestBoundary() },
      warnings: [],
      errors: [{ code: result.code, message: result.message, details: result.details }],
      artifacts: []
    };
  }
  return {
    status: 'ok',
    data: {
      playwright_test_report: {
        schema_version: SCHEMA_VERSION,
        integration_version: PLAYWRIGHT_TEST_INTEGRATION_VERSION,
        id: result.value.id,
        status: result.value.status,
        status_label: result.value.status_label,
        source: result.value.source,
        summary: result.value.summary,
        freshness: result.value.freshness,
        next_actions: result.value.next_actions ?? [],
        raw_content_included: false,
        boundary: playwrightTestBoundary()
      }
    },
    warnings: [],
    errors: [],
    artifacts: []
  };
}

export { runPlaywrightTestReviewMaterial };

export async function buildPlaywrightTestRegressionSummary(cwd, options = {}, context = {}) {
  const settings = await readPlaywrightTestSettings(cwd);
  const results = await readResultIndex(cwd, options);
  const latest = results[0] ?? null;
  const previous = results.slice(1).find((result) => result?.kind === 'playwright_test_result') ?? null;
  const status = latest ? classifyPlaywrightTestSummary(latest.summary ?? {}) : 'empty';
  const summary = {
    schema_version: SCHEMA_VERSION,
    integration_version: PLAYWRIGHT_TEST_INTEGRATION_VERSION,
    status,
    status_label: latest?.status_label ?? summarizeStatusLabel(status),
    selected_mode: settings.mode,
    supported_modes: settings.supported_modes,
    labels: settings.labels,
    mode_matrix: settings.mode_matrix,
    external_ci: settings.external_ci,
    last_result: latest ? {
      id: latest.id,
      status: latest.status,
      source_kind: latest.source?.kind ?? 'unknown',
      total_count: latest.summary?.total_count ?? 0,
      failed_count: latest.summary?.failed_count ?? 0,
      skipped_count: latest.summary?.skipped_count ?? 0,
      flaky_count: latest.summary?.flaky_count ?? 0,
      stale: latest.freshness?.stale === true,
      generated_at: latest.freshness?.generated_at ?? null,
      raw_content_included: false
    } : null,
    review_projection: latest
      ? buildPlaywrightTestReviewProjectionFromResults(latest, previous)
      : null,
    next_action: nextActionForMode(settings.mode, latest),
    dashboard_refresh_side_effects: {
      browser_launched: false,
      process_spawned: false,
      network_used: false,
      gh_used: false,
      heavy_artifact_scan_performed: false
    },
    warnings: [],
    boundary: playwrightTestBoundary()
  };
  return summary;
}

async function readResultIndex(cwd, options = {}) {
  const artifactRoot = options['artifact-root'] ?? DEFAULT_ARTIFACT_ROOT;
  const root = resolveArtifactRoot(cwd, artifactRoot);
  const dir = path.join(root, 'playwright-test-results');
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const results = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const value = JSON.parse(await readFile(path.join(dir, entry.name), 'utf8'));
      results.push(value);
    } catch {
      // Ignore unreadable local result artifacts in the summary; report command handles explicit reads.
    }
  }
  return results.sort((a, b) => String(b.freshness?.generated_at ?? '').localeCompare(String(a.freshness?.generated_at ?? '')));
}

async function readResultByInput(cwd, options = {}) {
  if (!options.result) {
    const [latest] = await readResultIndex(cwd, options);
    if (!latest) {
      return { ok: false, code: 'PLAYWRIGHT_TEST_RESULT_NOT_FOUND', message: 'No Playwright Test result is available.', details: {} };
    }
    return { ok: true, value: latest };
  }
  const artifactRoot = options['artifact-root'] ?? DEFAULT_ARTIFACT_ROOT;
  const root = resolveArtifactRoot(cwd, artifactRoot);
  const input = String(options.result);
  if (input.includes('/') || input.includes('\\')) {
    const read = await readBoundedTextFile(cwd, input);
    if (!read.ok) {
      return read;
    }
    try {
      return { ok: true, value: JSON.parse(read.text) };
    } catch {
      return { ok: false, code: 'PLAYWRIGHT_TEST_RESULT_NOT_FOUND', message: 'Playwright Test result could not be read.', details: {} };
    }
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(input)) {
    return { ok: false, code: 'PLAYWRIGHT_TEST_RESULT_ID_INVALID', message: 'Playwright Test result id must be a simple artifact id.', details: {} };
  }
  const file = path.join(root, 'playwright-test-results', input.endsWith('.json') ? input : `${input}.json`);
  try {
    return { ok: true, value: JSON.parse(await readFile(file, 'utf8')) };
  } catch {
    return { ok: false, code: 'PLAYWRIGHT_TEST_RESULT_NOT_FOUND', message: 'Playwright Test result could not be read.', details: {} };
  }
}

function nextActionForMode(mode, latest) {
  if (mode === 'disabled') {
    return 'Playwright Test integration is disabled.';
  }
  if (!latest) {
    return mode === 'external_ci' ? 'Fetch a CI artifact or import an existing result.' : 'Import a Playwright Test result.';
  }
  if (latest.status === 'failed') {
    return 'Review failed scenarios and pass the evidence summary to the developer.';
  }
  return 'Use this result as advisory local regression evidence.';
}
