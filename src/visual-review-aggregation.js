import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { artifactRelPath, resolveArtifactRoot } from './artifacts.js';
import { DEFAULT_ARTIFACT_ROOT, SCHEMA_VERSION } from './constants.js';
import { redact, truncateText } from './redaction.js';

const DEFAULT_AGGREGATION_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_AGGREGATION_LIMIT = 50;
const MAX_AGGREGATION_FINDINGS = 100;
const MAX_OWNER_DECISIONS = 50;

export async function runVisualReviewAggregation(options = {}, context = {}) {
  const unsupported = unsupportedOptions(options);
  if (unsupported.length > 0) {
    return errorResult(
      unsupported.includes('execute') ? 'CONFLICTING_OPTIONS' : 'UNSUPPORTED_VISUAL_REVIEW_AGGREGATE_OPTION',
      'visual review aggregate only reads existing local visual review results.',
      { options: unsupported }
    );
  }

  const maxBytes = parsePositiveInteger(options['max-bytes'], DEFAULT_AGGREGATION_MAX_BYTES);
  if (!maxBytes.ok) {
    return errorResult('VISUAL_REVIEW_AGGREGATION_INVALID_MAX_BYTES', 'visual review aggregate --max-bytes must be a positive integer.', {
      max_bytes: options['max-bytes']
    });
  }
  const limit = parsePositiveInteger(options.limit, DEFAULT_AGGREGATION_LIMIT);
  if (!limit.ok) {
    return errorResult('VISUAL_REVIEW_AGGREGATION_INVALID_LIMIT', 'visual review aggregate --limit must be a positive integer.', {
      limit: options.limit
    });
  }

  const cwd = context.cwd ?? process.cwd();
  const artifactRootInput = options['artifact-root'] ?? DEFAULT_ARTIFACT_ROOT;
  const now = materializeNow(context.now ?? options.now);
  const preparationRead = await readWorkspaceJson({
    cwd,
    inputPath: options.preparation,
    label: 'visual review preparation',
    maxBytes: maxBytes.value
  });
  if (!preparationRead.ok) {
    return errorResult(preparationRead.error.code, preparationRead.error.message, preparationRead.error.details);
  }

  let root;
  try {
    root = resolveArtifactRoot(cwd, artifactRootInput);
  } catch (error) {
    return errorResult('ARTIFACT_ROOT_INVALID', error.message, { artifact_root: artifactRootInput });
  }

  const scan = await scanVisualReviewResults({
    root,
    artifactRoot: artifactRootInput,
    preparation: preparationRead.value,
    preparationPath: preparationRead.relativePath,
    maxBytes: maxBytes.value,
    limit: limit.value
  });
  const aggregation = buildAggregation({
    now,
    artifactRoot: artifactRootInput,
    preparation: preparationRead.value,
    preparationPath: preparationRead.relativePath,
    preparationHash: preparationRead.textHash,
    resultReads: scan.results,
    warnings: scan.warnings,
    query: {
      max_bytes: maxBytes.value,
      limit: limit.value
    }
  });

  return {
    status: 'ok',
    data: {
      visual_review_aggregation: aggregation,
      boundary: aggregation.boundary
    },
    warnings: scan.warnings,
    errors: [],
    artifacts: []
  };
}

export function visualReviewAggregationBoundary() {
  return {
    local_only: true,
    read_only: true,
    writes_artifacts: false,
    deletes_files: false,
    provider_call_performed: false,
    api_call_performed: false,
    external_upload: false,
    external_evidence_transfer: false,
    raw_pixels_read: false,
    raw_pixels_included: false,
    raw_pixels_transferred: false,
    binary_content_included: false,
    raw_artifact_content_included: false,
    raw_provider_response_stored: false,
    credential_values_read: false,
    credential_values_recorded: false,
    existing_review_mutated: false,
    mcp_execution_exposed: false,
    mcp_write_execute_exposed: false,
    shell_used: false,
    gate_effect: 'none'
  };
}

async function scanVisualReviewResults({ root, artifactRoot, preparation, preparationPath, maxBytes, limit }) {
  const results = [];
  const warnings = [];
  const resultsRoot = path.join(root, 'visual-review-results');
  const preparationId = stringOrNull(preparation.id);
  let entries;
  try {
    entries = await readdir(resultsRoot, { withFileTypes: true });
  } catch {
    return { results, warnings };
  }

  const sortedEntries = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const entryName of sortedEntries) {
    if (results.length >= limit) {
      break;
    }
    const relPath = artifactRelPath(artifactRoot, 'visual-review-results', entryName, 'result.json');
    const absolutePath = path.join(resultsRoot, entryName, 'result.json');
    const read = await readArtifactJson({
      root,
      absolutePath,
      relativePath: relPath,
      label: 'visual review result',
      maxBytes
    });
    if (!read.ok) {
      warnings.push(read.warning);
      continue;
    }
    if (!resultMatchesPreparation(read.value, { preparationId, preparationPath })) {
      continue;
    }
    const executionPath = artifactRelPath(artifactRoot, 'visual-review-results', entryName, 'execution.json');
    const executionRead = await readArtifactJson({
      root,
      absolutePath: path.join(resultsRoot, entryName, 'execution.json'),
      relativePath: executionPath,
      label: 'visual review execution',
      maxBytes
    });
    if (!executionRead.ok && executionRead.warning.code !== 'VISUAL_REVIEW_AGGREGATION_ARTIFACT_MISSING') {
      warnings.push(executionRead.warning);
    }
    results.push({
      result: read.value,
      result_path: relPath,
      result_hash: read.textHash,
      execution: executionRead.ok ? executionRead.value : null,
      execution_path: executionRead.ok ? executionPath : null
    });
  }
  return { results, warnings };
}

function buildAggregation({ now, artifactRoot, preparation, preparationPath, preparationHash, resultReads, warnings, query }) {
  const agents = reviewAgents(resultReads);
  const findings = aggregateFindings(resultReads);
  const conflicts = aggregateConflicts(findings);
  const ownerDecisionRequests = aggregateOwnerDecisionRequests(resultReads);
  const sourceEffects = aggregateSourceEffects(resultReads);
  return redact({
    schema_version: SCHEMA_VERSION,
    generated_at: now.toISOString(),
    status: resultReads.length > 0 ? 'completed' : 'no_results',
    source: {
      artifact_root: artifactRoot,
      preparation_id: stringOrNull(preparation.id),
      preparation_path: preparationPath,
      preparation_hash: preparationHash,
      result_paths: resultReads.map((item) => item.result_path)
    },
    summary: {
      result_count: resultReads.length,
      review_agent_count: agents.length,
      aggregation_finding_count: findings.length,
      corroborated_finding_count: findings.filter((item) => item.status === 'corroborated').length,
      conflict_count: conflicts.length,
      owner_decision_request_count: ownerDecisionRequests.length,
      warning_count: warnings.length
    },
    source_effects: sourceEffects,
    review_agents: agents,
    aggregation_findings: findings,
    conflicts,
    owner_decision_requests: ownerDecisionRequests,
    query: {
      preparation_path: preparationPath,
      preparation_id: stringOrNull(preparation.id),
      max_bytes: query.max_bytes,
      limit: query.limit
    },
    gate_effect: 'none',
    boundary: visualReviewAggregationBoundary()
  });
}

function aggregateFindings(resultReads) {
  const groups = new Map();
  for (const read of resultReads) {
    const agent = agentFromResult(read.result);
    for (const finding of normalizeFindings(read.result)) {
      const key = findingKey(finding);
      const current = groups.get(key) ?? {
        key,
        category: finding.category,
        severity: finding.severity,
        message: finding.message,
        recommendation: finding.recommendation,
        sources: [],
        severities: new Set(),
        agents: new Set()
      };
      current.severities.add(finding.severity);
      current.agents.add(agent.id);
      current.sources.push({
        result_id: stringOrNull(read.result.id),
        result_path: read.result_path,
        finding_id: finding.id,
        provider_id: agent.provider_id,
        model_id: agent.model_id,
        execution_id: stringOrNull(read.result.execution_id)
      });
      groups.set(key, current);
    }
  }
  return [...groups.values()]
    .sort(compareFindingGroups)
    .slice(0, MAX_AGGREGATION_FINDINGS)
    .map((group, index) => ({
      id: `visual-aggregation-finding-${String(index + 1).padStart(3, '0')}`,
      status: group.agents.size > 1 ? 'corroborated' : 'single_source',
      category: group.category,
      severity: highestSeverity([...group.severities]),
      message: group.message,
      recommendation: group.recommendation,
      source_count: group.sources.length,
      review_agent_count: group.agents.size,
      source_severities: [...group.severities].sort(compareSeverity),
      sources: group.sources,
      gate_effect: 'none',
      untrusted_text: true
    }));
}

function aggregateConflicts(findings) {
  const groups = new Map();
  for (const finding of findings) {
    const key = `${finding.category}\n${normalizeTextKey(finding.message)}`;
    const current = groups.get(key) ?? { key, severities: new Set(), finding_ids: [] };
    for (const severity of finding.source_severities ?? [finding.severity]) {
      current.severities.add(severity);
    }
    current.finding_ids.push(finding.id);
    groups.set(key, current);
  }
  return [...groups.values()]
    .filter((group) => group.severities.size > 1)
    .map((group, index) => ({
      id: `visual-aggregation-conflict-${String(index + 1).padStart(3, '0')}`,
      type: 'severity_disagreement',
      finding_ids: group.finding_ids,
      severities: [...group.severities].sort(compareSeverity),
      owner_decision_required: true,
      gate_effect: 'none'
    }));
}

function aggregateOwnerDecisionRequests(resultReads) {
  const values = [];
  for (const read of resultReads) {
    const requests = Array.isArray(read.result.owner_decision_requests) ? read.result.owner_decision_requests : [];
    for (const request of requests) {
      values.push({
        id: truncateText(request?.id ?? `owner-decision-${values.length + 1}`, 120),
        question: truncateText(request?.question ?? request?.message ?? 'Owner decision required.', 500),
        reason: truncateText(request?.reason ?? '', 700),
        related_finding_id: stringOrNull(request?.related_finding_id),
        result_id: stringOrNull(read.result.id),
        result_path: read.result_path,
        gate_effect: 'none',
        untrusted_text: true
      });
    }
  }
  return values
    .sort((a, b) => `${a.question}\n${a.result_path}`.localeCompare(`${b.question}\n${b.result_path}`))
    .slice(0, MAX_OWNER_DECISIONS);
}

function reviewAgents(resultReads) {
  const agents = new Map();
  for (const read of resultReads) {
    const agent = agentFromResult(read.result);
    const current = agents.get(agent.id) ?? {
      id: agent.id,
      provider_id: agent.provider_id,
      provider_kind: agent.provider_kind,
      model_id: agent.model_id,
      result_count: 0,
      result_paths: []
    };
    current.result_count += 1;
    current.result_paths.push(read.result_path);
    agents.set(agent.id, current);
  }
  return [...agents.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function aggregateSourceEffects(resultReads) {
  return resultReads.reduce((effects, read) => {
    const boundary = read.result.boundary ?? {};
    effects.provider_call_performed ||= Boolean(boundary.provider_call_performed);
    effects.api_call_performed ||= Boolean(boundary.api_call_performed);
    effects.external_evidence_transfer ||= Boolean(boundary.external_evidence_transfer);
    effects.raw_pixels_included ||= Boolean(boundary.raw_pixels_included);
    effects.raw_provider_response_stored ||= Boolean(boundary.raw_provider_response_stored);
    return effects;
  }, {
    provider_call_performed: false,
    api_call_performed: false,
    external_evidence_transfer: false,
    raw_pixels_included: false,
    raw_provider_response_stored: false
  });
}

function normalizeFindings(result) {
  const findings = Array.isArray(result.advisory_findings)
    ? result.advisory_findings
    : Array.isArray(result.visual_review_result?.advisory_findings)
      ? result.visual_review_result.advisory_findings
      : [];
  return findings.map((finding, index) => ({
    id: truncateText(finding?.id ?? `finding-${index + 1}`, 120),
    category: truncateText(finding?.category ?? 'other', 120),
    severity: normalizeSeverity(finding?.severity),
    message: truncateText(finding?.message ?? finding?.summary ?? 'Visual review advisory finding.', 600),
    recommendation: truncateText(finding?.recommendation ?? '', 900),
    route: stringOrNull(finding?.route),
    viewport: typeof finding?.viewport === 'string' ? finding.viewport : JSON.stringify(finding?.viewport ?? null)
  }));
}

function resultMatchesPreparation(result, { preparationId, preparationPath }) {
  if (preparationId && result.preparation_id === preparationId) {
    return true;
  }
  return Boolean(preparationPath && result.preparation_path === preparationPath);
}

async function readArtifactJson({ root, absolutePath, relativePath, label, maxBytes }) {
  try {
    const stat = await lstat(absolutePath);
    if (!stat.isFile()) {
      return artifactWarning('VISUAL_REVIEW_AGGREGATION_ARTIFACT_NOT_FILE', `${label} must be a regular file.`, { path: relativePath });
    }
    if (stat.size > maxBytes) {
      return artifactWarning('VISUAL_REVIEW_AGGREGATION_ARTIFACT_TOO_LARGE', `${label} exceeds the configured byte limit.`, {
        path: relativePath,
        bytes: stat.size,
        max_bytes: maxBytes
      });
    }
    const realRoot = await realpath(root);
    const realInput = await realpath(absolutePath);
    if (!isPathInside(realInput, realRoot)) {
      return artifactWarning('VISUAL_REVIEW_AGGREGATION_ARTIFACT_REALPATH_OUTSIDE_ROOT', `${label} real path must stay under the artifact root.`, {
        path: relativePath
      });
    }
    const text = await readFile(realInput, 'utf8');
    try {
      return {
        ok: true,
        value: JSON.parse(text),
        textHash: hashText(text)
      };
    } catch {
      return artifactWarning('VISUAL_REVIEW_AGGREGATION_ARTIFACT_INVALID_JSON', `${label} must contain valid JSON.`, {
        path: relativePath
      });
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      return artifactWarning('VISUAL_REVIEW_AGGREGATION_ARTIFACT_MISSING', `${label} does not exist.`, { path: relativePath });
    }
    return artifactWarning('VISUAL_REVIEW_AGGREGATION_ARTIFACT_READ_FAILED', `Could not read ${label}.`, {
      path: relativePath,
      reason: error.message
    });
  }
}

async function readWorkspaceJson({ cwd, inputPath, label, maxBytes }) {
  const workspaceRoot = path.resolve(cwd ?? process.cwd());
  const normalizedInput = String(inputPath ?? '').trim();
  if (!normalizedInput || normalizedInput === '-' || normalizedInput.startsWith('@')) {
    return {
      ok: false,
      error: {
        code: 'VISUAL_REVIEW_AGGREGATION_PREPARATION_PATH_INVALID',
        message: `${label} path must be a workspace-relative JSON path.`,
        details: { path: inputPath }
      }
    };
  }
  if (path.isAbsolute(normalizedInput) || normalizedInput.includes('\0') || normalizedInput.split(/[\\/]+/).includes('..')) {
    return {
      ok: false,
      error: {
        code: 'VISUAL_REVIEW_AGGREGATION_PREPARATION_PATH_OUTSIDE_WORKSPACE',
        message: `${label} path must stay inside the workspace.`,
        details: { path: inputPath }
      }
    };
  }
  const absolutePath = path.resolve(workspaceRoot, normalizedInput);
  if (!isPathInside(absolutePath, workspaceRoot)) {
    return {
      ok: false,
      error: {
        code: 'VISUAL_REVIEW_AGGREGATION_PREPARATION_PATH_OUTSIDE_WORKSPACE',
        message: `${label} path must stay inside the workspace.`,
        details: { path: inputPath }
      }
    };
  }
  try {
    const realWorkspaceRoot = await realpath(workspaceRoot);
    const realInput = await realpath(absolutePath);
    if (!isPathInside(realInput, realWorkspaceRoot)) {
      return {
        ok: false,
        error: {
          code: 'VISUAL_REVIEW_AGGREGATION_PREPARATION_REALPATH_OUTSIDE_WORKSPACE',
          message: `${label} real path must stay inside the workspace.`,
          details: { path: inputPath }
        }
      };
    }
    const stat = await lstat(realInput);
    if (!stat.isFile()) {
      return {
        ok: false,
        error: {
          code: 'VISUAL_REVIEW_AGGREGATION_PREPARATION_NOT_FILE',
          message: `${label} must be a regular file.`,
          details: { path: inputPath }
        }
      };
    }
    if (stat.size > maxBytes) {
      return {
        ok: false,
        error: {
          code: 'VISUAL_REVIEW_AGGREGATION_PREPARATION_TOO_LARGE',
          message: `${label} exceeds the configured byte limit.`,
          details: { path: inputPath, bytes: stat.size, max_bytes: maxBytes }
        }
      };
    }
    const text = await readFile(realInput, 'utf8');
    try {
      return {
        ok: true,
        value: JSON.parse(text),
        text,
        textHash: hashText(text),
        relativePath: path.relative(realWorkspaceRoot, realInput).split(path.sep).join('/')
      };
    } catch {
      return {
        ok: false,
        error: {
          code: 'VISUAL_REVIEW_AGGREGATION_PREPARATION_INVALID_JSON',
          message: `${label} must contain valid JSON.`,
          details: { path: inputPath }
        }
      };
    }
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'VISUAL_REVIEW_AGGREGATION_PREPARATION_READ_FAILED',
        message: `Could not read ${label}.`,
        details: { path: inputPath, reason: error.message }
      }
    };
  }
}

function unsupportedOptions(options) {
  return ['execute', 'provider', 'model', 'surface', 'image', 'capture-handoff', 'review-index', 'url', 'target', 'input', 'report', 'screenshot', 'trace', 'mock', 'threshold']
    .filter((option) => options[option] !== undefined);
}

function agentFromResult(result) {
  const provider = result.provider ?? {};
  const model = result.model ?? {};
  const providerId = stringOrNull(provider.id) ?? 'unknown-provider';
  const modelId = stringOrNull(model.id) ?? 'unknown-model';
  return {
    id: `${providerId}/${modelId}`,
    provider_id: providerId,
    provider_kind: stringOrNull(provider.kind),
    model_id: modelId
  };
}

function findingKey(finding) {
  return [
    normalizeTextKey(finding.category),
    normalizeTextKey(finding.message),
    normalizeTextKey(finding.route),
    normalizeTextKey(finding.viewport)
  ].join('\n');
}

function compareFindingGroups(a, b) {
  return compareSeverity(highestSeverity([...b.severities]), highestSeverity([...a.severities]))
    || a.key.localeCompare(b.key);
}

const SEVERITY_ORDER = Object.freeze(['info', 'low', 'medium', 'high', 'critical']);

function normalizeSeverity(value) {
  const severity = String(value ?? 'info').trim();
  return SEVERITY_ORDER.includes(severity) ? severity : 'info';
}

function compareSeverity(a, b) {
  return SEVERITY_ORDER.indexOf(a) - SEVERITY_ORDER.indexOf(b);
}

function highestSeverity(values) {
  return values.map(normalizeSeverity).sort(compareSeverity).at(-1) ?? 'info';
}

function normalizeTextKey(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function parsePositiveInteger(value, defaultValue) {
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: defaultValue };
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { ok: false };
  }
  return { ok: true, value: parsed };
}

function artifactWarning(code, message, details) {
  return {
    ok: false,
    warning: { code, message, details }
  };
}

function hashText(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function stringOrNull(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const text = String(value);
  return text.length > 0 ? text : null;
}

function isPathInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function materializeNow(value) {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'function') {
    return materializeNow(value());
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }
  return new Date();
}

function errorResult(code, message, details = {}) {
  return {
    status: 'error',
    data: {
      visual_review_aggregation: null,
      boundary: visualReviewAggregationBoundary()
    },
    warnings: [],
    errors: [{ code, message, details }],
    artifacts: []
  };
}
