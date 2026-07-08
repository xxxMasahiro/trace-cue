import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_ARTIFACT_ROOT, SCHEMA_VERSION } from './constants.js';
import {
  PLAYWRIGHT_TEST_IMPORT_CONFIRM,
  buildFreshnessSignature,
  classifyPlaywrightTestSummary,
  createPlaywrightTestResultId,
  materializeNow,
  playwrightTestBoundary,
  resultError,
  summarizeStatusLabel,
  writePlaywrightTestResultArtifacts
} from './playwright-test-integration.js';
import { readBoundedTextFile, redactText, resolveWorkspaceRegularFile, scanArtifactTree } from './playwright-test-artifacts.js';

export const PLAYWRIGHT_TEST_IMPORT_VERSION = '1.0.0';

export async function runPlaywrightTestImport(options = {}, context = {}) {
  if (options.confirm !== PLAYWRIGHT_TEST_IMPORT_CONFIRM) {
    return resultError('PLAYWRIGHT_TEST_IMPORT_CONFIRM_REQUIRED', 'Playwright Test import requires explicit confirmation.', {
      confirm: PLAYWRIGHT_TEST_IMPORT_CONFIRM
    });
  }
  const cwd = context.cwd ?? process.cwd();
  const now = materializeNow(context.now);
  const input = options.input ?? options.result ?? options.file;
  const read = await readPlaywrightTestInput(cwd, input);
  if (!read.ok) {
    return resultError(read.code, read.message, read.details);
  }
  return writeImportedPlaywrightTestResult({
    cwd,
    read,
    artifactRootInput: options['artifact-root'] ?? DEFAULT_ARTIFACT_ROOT,
    now,
    source: {
      kind: 'local_import',
      input_kind: read.kind,
      file_name: read.file_name,
      workspace_relative_path: read.relative_path,
      raw_content_included: false
    },
    receiptKind: 'playwright_test_import_receipt',
    receiptSourceKind: 'local_import',
    dataKey: 'playwright_test_import',
    warnings: read.warnings,
    boundaryOverrides: {
      writes_artifacts: true,
      raw_artifact_content_included: false
    }
  });
}

async function writeImportedPlaywrightTestResult({
  cwd,
  read,
  artifactRootInput,
  now,
  source,
  receiptKind,
  receiptSourceKind,
  dataKey,
  warnings,
  boundaryOverrides
}) {
  const id = createPlaywrightTestResultId(now);
  const summary = summarizeImportedContent(read);
  const status = classifyPlaywrightTestSummary(summary);
  const freshnessSignature = buildFreshnessSignature({
    source_kind: source.kind,
    repo: source.repo ?? null,
    run_id: source.run_id ?? null,
    artifact_name: source.artifact_name ?? null,
    input_kind: read.kind,
    input_name: read.file_name,
    total_count: summary.total_count,
    failed_count: summary.failed_count,
    generated_at: summary.generated_at ?? null
  });
  const result = {
    schema_version: SCHEMA_VERSION,
    integration_version: PLAYWRIGHT_TEST_IMPORT_VERSION,
    kind: 'playwright_test_result',
    id,
    status,
    status_label: summarizeStatusLabel(status),
    source,
    summary,
    freshness: {
      stale: false,
      signature: freshnessSignature,
      generated_at: now.toISOString()
    },
    artifacts: read.attachments,
    next_actions: nextActions(status),
    boundary: playwrightTestBoundary(boundaryOverrides)
  };
  const receipt = {
    schema_version: SCHEMA_VERSION,
    kind: receiptKind,
    id,
    created_at: now.toISOString(),
    source_kind: receiptSourceKind,
    input_file_name: read.file_name,
    raw_content_stored: false,
    credential_values_recorded: false,
    boundary: result.boundary
  };
  const artifacts = await writePlaywrightTestResultArtifacts({
    cwd,
    artifactRootInput,
    id,
    result,
    receipt,
    now
  });
  return {
    status: 'ok',
    data: {
      [dataKey]: result,
      boundary: result.boundary
    },
    warnings,
    errors: [],
    artifacts
  };
}

export async function importPlaywrightTestFromDownloadedDirectory({ cwd, directory, artifactRootInput, source, now }) {
  const scan = await scanArtifactTree(directory);
  const candidates = await findResultCandidates(directory);
  if (candidates.length === 0) {
    const id = createPlaywrightTestResultId(now, 'playwright-test-ci');
    const summary = {
      total_count: 0,
      passed_count: 0,
      failed_count: 0,
      skipped_count: 0,
      flaky_count: 0,
      timed_out_count: 0,
      evidence_missing: true,
      attachment_count: scan.summary.attachments.length
    };
    const result = {
      schema_version: SCHEMA_VERSION,
      integration_version: PLAYWRIGHT_TEST_IMPORT_VERSION,
      kind: 'playwright_test_result',
      id,
      status: 'evidence_missing',
      status_label: summarizeStatusLabel('evidence_missing'),
      source: {
        ...source,
        raw_content_included: false
      },
      summary,
      freshness: {
        stale: false,
        signature: buildFreshnessSignature(source),
        generated_at: materializeNow(now).toISOString()
      },
      artifacts: scan.summary.attachments,
      next_actions: nextActions('evidence_missing'),
      boundary: playwrightTestBoundary({
        writes_artifacts: true,
        network_used: true,
        gh_used: true
      })
    };
    const receipt = {
      schema_version: SCHEMA_VERSION,
      kind: 'playwright_test_external_ci_receipt',
      id,
      created_at: materializeNow(now).toISOString(),
      source_kind: 'external_ci',
      raw_content_stored: false,
      credential_values_recorded: false,
      boundary: result.boundary
    };
    const artifacts = await writePlaywrightTestResultArtifacts({ cwd, artifactRootInput, id, result, receipt, now });
    return {
      status: 'ok',
      data: {
        playwright_test_import: result,
        boundary: result.boundary
      },
      warnings: scan.summary.rejected.concat(scan.summary.suspicious),
      errors: [],
      artifacts
    };
  }
  if (source?.approved_fetch && candidates.length > 1) {
    return resultError('PLAYWRIGHT_TEST_EXTERNAL_CI_ARTIFACT_AMBIGUOUS', 'Approved external CI artifact contained multiple Playwright Test result candidates.', {
      candidate_count: candidates.length
    });
  }
  const first = candidates[0];
  const relativeInput = path.relative(cwd, first).replaceAll(path.sep, '/');
  const read = await readPlaywrightTestInput(cwd, relativeInput);
  if (!read.ok) {
    return resultError(read.code, read.message, read.details);
  }
  return writeImportedPlaywrightTestResult({
    cwd,
    read,
    artifactRootInput,
    now: materializeNow(now),
    source: {
      ...source,
      input_kind: read.kind,
      file_name: read.file_name,
      workspace_relative_path: read.relative_path,
      raw_content_included: false
    },
    receiptKind: 'playwright_test_external_ci_receipt',
    receiptSourceKind: 'external_ci',
    dataKey: 'playwright_test_import',
    warnings: scan.summary.rejected.concat(scan.summary.suspicious, read.warnings ?? []),
    boundaryOverrides: {
      writes_artifacts: true,
      network_used: true,
      gh_used: true,
      raw_artifact_content_included: false
    }
  });
}

async function readPlaywrightTestInput(cwd, input) {
  const resolved = await resolveWorkspaceRegularFile(cwd, input);
  if (!resolved.ok) {
    return resolved;
  }
  const ext = path.extname(resolved.absolute_path).toLowerCase();
  const textRead = await readBoundedTextFile(cwd, resolved.relative_path);
  if (!textRead.ok) {
    return textRead;
  }
  if (ext === '.json') {
    try {
      return {
        ok: true,
        kind: 'json',
        file_name: path.basename(resolved.relative_path),
        relative_path: resolved.relative_path,
        data: JSON.parse(textRead.text),
        attachments: [],
        warnings: []
      };
    } catch (error) {
      return {
        ok: false,
        code: 'PLAYWRIGHT_TEST_JSON_INVALID',
        message: 'Playwright Test JSON result could not be parsed.',
        details: { reason: error.message }
      };
    }
  }
  if (ext === '.xml') {
    return {
      ok: true,
      kind: 'junit',
      file_name: path.basename(resolved.relative_path),
      relative_path: resolved.relative_path,
      text: textRead.text,
      attachments: [],
      warnings: []
    };
  }
  if (ext === '.html' || ext === '.htm') {
    return {
      ok: true,
      kind: 'html_report_reference',
      file_name: path.basename(resolved.relative_path),
      relative_path: resolved.relative_path,
      text: '',
      attachments: [{
        path: resolved.relative_path,
        file_name: path.basename(resolved.relative_path),
        size_bytes: resolved.size_bytes,
        raw_content_included: false
      }],
      warnings: [{
        code: 'PLAYWRIGHT_TEST_HTML_REFERENCE_ONLY',
        message: 'HTML report content was not embedded in TraceCue output.'
      }]
    };
  }
  return {
    ok: false,
    code: 'PLAYWRIGHT_TEST_INPUT_UNSUPPORTED',
    message: 'Playwright Test import supports JSON, JUnit XML, and HTML report references.',
    details: { extension: ext }
  };
}

function summarizeImportedContent(read) {
  if (read.kind === 'json') {
    const tests = collectJsonTests(read.data);
    const counts = countTests(tests);
    return {
      format: 'json',
      total_count: tests.length,
      ...counts,
      generated_at: read.data?.stats?.startTime ?? read.data?.metadata?.generated_at ?? null,
      project_names: unique(tests.map((test) => test.project_name).filter(Boolean)).slice(0, 20),
      top_failures: tests.filter((test) => test.status === 'failed' || test.status === 'timedOut').slice(0, 5).map((test) => ({
        title: redactText(test.title),
        project_name: redactText(test.project_name),
        status: test.status,
        error_excerpt: redactText(test.error_excerpt).slice(0, 500)
      })),
      attachment_count: tests.reduce((sum, test) => sum + test.attachment_count, 0),
      raw_content_included: false
    };
  }
  if (read.kind === 'junit') {
    const total = countXml(read.text, /<testcase\b/g);
    const failures = countXml(read.text, /<(failure|error)\b/g);
    const skipped = countXml(read.text, /<skipped\b/g);
    return {
      format: 'junit',
      total_count: total,
      passed_count: Math.max(0, total - failures - skipped),
      failed_count: failures,
      skipped_count: skipped,
      flaky_count: 0,
      timed_out_count: 0,
      top_failures: [],
      attachment_count: 0,
      raw_content_included: false
    };
  }
  return {
    format: read.kind,
    total_count: 0,
    passed_count: 0,
    failed_count: 0,
    skipped_count: 0,
    flaky_count: 0,
    timed_out_count: 0,
    evidence_missing: true,
    top_failures: [],
    attachment_count: read.attachments.length,
    raw_content_included: false
  };
}

function collectJsonTests(data) {
  const tests = [];
  walkSuite(data, [], tests);
  return tests;
}

function walkSuite(node, titles, tests) {
  if (!node || typeof node !== 'object') return;
  const nextTitles = node.title ? [...titles, node.title] : titles;
  if (Array.isArray(node.specs)) {
    for (const spec of node.specs) {
      const specTitle = spec.title ? [...nextTitles, spec.title] : nextTitles;
      for (const test of spec.tests ?? []) {
        const results = Array.isArray(test.results) ? test.results : [];
        const finalResult = results.at(-1) ?? {};
        tests.push({
          title: [...specTitle, test.title].filter(Boolean).join(' > '),
          project_name: test.projectName ?? test.project_name ?? '',
          status: normalizeStatus(finalResult.status ?? test.status),
          error_excerpt: finalResult.error?.message ?? finalResult.errors?.[0]?.message ?? '',
          attachment_count: Array.isArray(finalResult.attachments) ? finalResult.attachments.length : 0,
          retry_count: Math.max(0, results.length - 1)
        });
      }
    }
  }
  for (const child of node.suites ?? []) {
    walkSuite(child, nextTitles, tests);
  }
}

function normalizeStatus(status) {
  const value = String(status ?? '').trim();
  if (value === 'passed' || value === 'expected') return 'passed';
  if (value === 'skipped') return 'skipped';
  if (value === 'timedOut' || value === 'timed_out' || value === 'timeout') return 'timedOut';
  if (value === 'failed' || value === 'unexpected') return 'failed';
  return value || 'unknown';
}

function countTests(tests) {
  return {
    passed_count: tests.filter((test) => test.status === 'passed').length,
    failed_count: tests.filter((test) => test.status === 'failed').length,
    skipped_count: tests.filter((test) => test.status === 'skipped').length,
    flaky_count: tests.filter((test) => test.retry_count > 0 && test.status === 'passed').length,
    timed_out_count: tests.filter((test) => test.status === 'timedOut').length
  };
}

function countXml(text, pattern) {
  return [...String(text ?? '').matchAll(pattern)].length;
}

function unique(values) {
  return [...new Set(values)];
}

async function findResultCandidates(directory) {
  const found = [];
  await findFiles(directory, found, { depth: 0, maxDepth: 8, maxFiles: 200 });
  return found.filter((file) => /\.(json|xml)$/i.test(file));
}

async function findFiles(current, found, state) {
  if (found.length >= state.maxFiles || state.depth > state.maxDepth) {
    return;
  }
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (found.length >= state.maxFiles) {
      return;
    }
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await findFiles(absolute, found, { ...state, depth: state.depth + 1 });
    } else if (entry.isFile()) {
      found.push(absolute);
    }
  }
}

function nextActions(status) {
  if (status === 'passed') {
    return ['Keep the result as local regression evidence.'];
  }
  if (status === 'failed') {
    return ['Review the failed scenario summary and hand the evidence references to the developer.'];
  }
  if (status === 'evidence_missing') {
    return ['Update the Playwright CI artifact configuration so JSON or JUnit output is available.'];
  }
  if (status === 'stale') {
    return ['Import a fresh Playwright Test result for the current target/ref.'];
  }
  return ['Import a Playwright Test JSON or JUnit result.'];
}
