import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  artifactObject,
  artifactRelPath,
  createArtifactId,
  ensureArtifactRoot,
  resolveArtifactRoot,
  writeJsonArtifact
} from './artifacts.js';
import { AGENT_SURFACES } from './agent.js';
import {
  API_PROVIDER_CREDENTIAL_ENV,
  API_PROVIDER_ENDPOINT_ENV,
  resolveAgentExecutionProvider
} from './agent-execution-providers.js';
import { CLI_NAME, DEFAULT_ARTIFACT_ROOT, SCHEMA_VERSION } from './constants.js';
import { redact, truncateText } from './redaction.js';

const DEFAULT_EXECUTION_MAX_BYTES = 2 * 1024 * 1024;
const MAX_VISUAL_FINDINGS = 50;
const MAX_OWNER_DECISIONS = 25;
const MAX_EVIDENCE_REFS = 50;

const VISUAL_FINDING_CATEGORIES = new Set([
  'visual_hierarchy',
  'layout_integrity',
  'content_clarity',
  'interaction_affordance',
  'accessibility_basics',
  'evidence_quality',
  'owner_decision',
  'other'
]);
const SEVERITIES = new Set(['info', 'low', 'medium', 'high', 'critical']);
const CONFIDENCE_VALUES = new Set(['low', 'medium', 'high', 'inconclusive']);

export async function runVisualReviewExecutionRun(options = {}, context = {}) {
  if (!options.execute) {
    return errorResult('VISUAL_REVIEW_EXECUTION_REQUIRES_EXECUTE', 'visual review run requires explicit --execute.', {
      execute_required: true,
      command: `${CLI_NAME} visual review run --preparation ${options.preparation ?? '<preparation>'} --surface <surface> --provider <provider> --model <model> --execute --json`
    });
  }

  const cwd = context.cwd ?? process.cwd();
  const now = currentDate(context.now);
  const artifactRootInput = options['artifact-root'] ?? DEFAULT_ARTIFACT_ROOT;
  let root;
  try {
    root = await ensureArtifactRoot(cwd, artifactRootInput);
  } catch (error) {
    return errorResult('ARTIFACT_ROOT_INVALID', error.message, { artifact_root: artifactRootInput });
  }

  const maxBytes = parseMaxBytes(options['max-bytes']);
  if (!maxBytes.ok) {
    return errorResult('VISUAL_REVIEW_EXECUTION_INVALID_MAX_BYTES', maxBytes.message, { max_bytes: options['max-bytes'] });
  }

  const preparationRead = await readWorkspaceJson({
    cwd,
    inputPath: options.preparation,
    label: 'visual review preparation',
    maxBytes: maxBytes.value
  });
  if (!preparationRead.ok) {
    return errorResult(preparationRead.error.code, preparationRead.error.message, preparationRead.error.details);
  }

  const surface = findSurface(options.surface);
  if (!surface) {
    return errorResult('VISUAL_REVIEW_EXECUTION_SURFACE_NOT_FOUND', 'No agent surface matched the requested visual review execution surface.', {
      surface: options.surface,
      available_surfaces: AGENT_SURFACES.map((item) => item.id)
    });
  }

  const providerRead = resolveAgentExecutionProvider({
    providerId: options.provider,
    surface,
    modelId: options.model
  });
  if (!providerRead.ok) {
    return errorResult(providerRead.error.code, providerRead.error.message, providerRead.error.details);
  }

  const preparationValidation = validatePreparationForExecution({
    preparation: preparationRead.value,
    preparationPath: preparationRead.relativePath,
    surface,
    provider: providerRead.provider,
    model: { id: options.model }
  });
  if (!preparationValidation.ok) {
    return errorResult(preparationValidation.error.code, preparationValidation.error.message, preparationValidation.error.details);
  }

  const executionId = context.createId?.('visual-review-execution', now) ?? createArtifactId(now, 'visual-review-execution');
  const resultId = context.createId?.('visual-review-result', now) ?? `${executionId}-result`;
  const executionRel = artifactRelPath(artifactRootInput, 'visual-review-results', executionId, 'execution.json');
  const resultRel = artifactRelPath(artifactRootInput, 'visual-review-results', executionId, 'result.json');
  const receiptRel = artifactRelPath(artifactRootInput, 'receipts', `${executionId}-visual-review-run.json`);
  const promptText = buildVisualReviewPrompt(preparationRead.value);
  const providerResult = await executeVisualReviewProvider({
    provider: providerRead.provider,
    model: { id: options.model },
    surface,
    preparation: preparationRead.value,
    preparationPath: preparationRead.relativePath,
    promptText,
    execution: {
      id: executionId,
      execution_path: executionRel,
      result_path: resultRel,
      receipt_path: receiptRel
    },
    resultId,
    now,
    context
  });

  const execution = buildVisualReviewExecutionRecord({
    id: executionId,
    status: providerResult.status,
    now,
    executionPath: executionRel,
    resultPath: providerResult.ok ? resultRel : null,
    receiptPath: receiptRel,
    preparation: preparationRead.value,
    preparationPath: preparationRead.relativePath,
    preparationHash: hashText(preparationRead.text),
    surface,
    provider: providerRead.provider,
    model: { id: options.model },
    providerResult
  });
  const receipt = buildVisualReviewExecutionReceipt({
    execution,
    providerResult,
    resultPath: providerResult.ok ? resultRel : null
  });

  if (providerResult.ok) {
    await writeJsonArtifact(root, ['visual-review-results', executionId, 'result.json'], providerResult.visual_review_result);
  }
  await writeJsonArtifact(root, ['visual-review-results', executionId, 'execution.json'], execution);
  await writeJsonArtifact(root, ['receipts', `${executionId}-visual-review-run.json`], receipt);

  const artifacts = [
    artifactObject({
      type: 'visual_review_execution',
      path: executionRel,
      description: 'Local visual review execution status record.'
    }),
    artifactObject({
      type: 'visual_review_execution_receipt',
      path: receiptRel,
      description: 'Content-free receipt for the local visual review run.'
    })
  ];
  if (providerResult.ok) {
    artifacts.unshift(artifactObject({
      type: 'visual_review_result',
      path: resultRel,
      description: 'Normalized untrusted visual review result from visual review execution.'
    }));
  }

  if (!providerResult.ok) {
    return {
      status: 'error',
      data: {
        visual_review_execution: execution,
        visual_review_execution_status: execution,
        boundary: execution.boundary
      },
      warnings: providerResult.warnings,
      errors: [providerResult.error],
      artifacts
    };
  }

  return {
    status: 'ok',
    data: {
      visual_review_execution: execution,
      visual_review_execution_status: execution,
      visual_review_result: {
        id: resultId,
        path: resultRel,
        status: providerResult.visual_review_result.status,
        gate_effect: 'none',
        untrusted_model_output: true
      },
      boundary: execution.boundary
    },
    warnings: providerResult.warnings,
    errors: [],
    artifacts
  };
}

export async function runVisualReviewExecutionStatus(options = {}, context = {}) {
  const cwd = context.cwd ?? process.cwd();
  const executionRead = await readWorkspaceJson({
    cwd,
    inputPath: options.execution,
    label: 'visual review execution',
    maxBytes: DEFAULT_EXECUTION_MAX_BYTES
  });
  if (!executionRead.ok) {
    return errorResult(executionRead.error.code, executionRead.error.message, executionRead.error.details);
  }
  return {
    status: 'ok',
    data: {
      visual_review_execution: executionRead.value,
      visual_review_execution_status: executionRead.value,
      boundary: executionRead.value.boundary ?? visualReviewExecutionBoundary()
    },
    warnings: [],
    errors: [],
    artifacts: []
  };
}

export async function runVisualReviewExecutionList(options = {}, context = {}) {
  const cwd = context.cwd ?? process.cwd();
  const artifactRootInput = options['artifact-root'] ?? DEFAULT_ARTIFACT_ROOT;
  const executions = [];
  const warnings = [];
  let root;
  try {
    root = resolveArtifactRoot(cwd, artifactRootInput);
  } catch (error) {
    return errorResult('ARTIFACT_ROOT_INVALID', error.message, { artifact_root: artifactRootInput });
  }

  try {
    const entries = await readdir(path.join(root, 'visual-review-results'), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const executionPath = artifactRelPath(artifactRootInput, 'visual-review-results', entry.name, 'execution.json');
      const executionRead = await readWorkspaceJson({
        cwd,
        inputPath: executionPath,
        label: 'visual review execution',
        maxBytes: DEFAULT_EXECUTION_MAX_BYTES
      });
      if (executionRead.ok) {
        executions.push(executionRead.value);
      } else {
        warnings.push({
          code: 'VISUAL_REVIEW_EXECUTION_READ_FAILED',
          message: 'Could not read a visual review execution while listing execution status.',
          details: { execution_path: executionPath, reason: executionRead.error.message }
        });
      }
    }
  } catch {
    // Missing execution directory is a valid empty-list state.
  }

  return {
    status: 'ok',
    data: {
      visual_review_executions: executions,
      summary: summarizeVisualReviewExecutions(executions),
      boundary: visualReviewExecutionBoundary()
    },
    warnings,
    errors: [],
    artifacts: []
  };
}

export function visualReviewExecutionBoundary(overrides = {}) {
  return {
    local_only: true,
    browser_launched: false,
    provider_call_performed: false,
    api_call_performed: false,
    automatic_upload: false,
    external_evidence_transfer: false,
    external_upload: false,
    raw_pixels_included: false,
    raw_pixels_read: false,
    raw_pixels_transferred: false,
    binary_content_included: false,
    raw_artifact_content_included: false,
    raw_dom_included: false,
    raw_trace_included: false,
    raw_console_payloads_included: false,
    raw_network_payloads_included: false,
    raw_report_body_included: false,
    source_data_values_included: false,
    credential_storage: 'none',
    persistent_credential_storage: false,
    credential_values_recorded: false,
    raw_response_stored: false,
    raw_provider_response_stored: false,
    existing_review_mutated: false,
    mcp_execution_exposed: false,
    mcp_write_execute_exposed: false,
    gate_effect: 'none',
    shell_used: false,
    free_form_shell_input_accepted: false,
    ...overrides
  };
}

async function executeVisualReviewProvider({
  provider,
  model,
  surface,
  preparation,
  preparationPath,
  promptText,
  execution,
  resultId,
  now,
  context
}) {
  if (provider.id === 'fake-agent') {
    return fakeVisualReviewResult({ provider, model, surface, preparation, preparationPath, execution, resultId, now });
  }
  if (provider.id === 'local-runner') {
    return localRunnerVisualReviewResult({ provider, model, surface, preparation, preparationPath, promptText, execution, resultId, now, context });
  }
  if (provider.id === 'generic-api-provider') {
    return apiVisualReviewResult({ provider, model, surface, preparation, preparationPath, promptText, execution, resultId, now, context });
  }
  return providerFailure({
    status: 'blocked',
    code: 'VISUAL_REVIEW_PROVIDER_UNKNOWN',
    message: 'No implemented provider adapter is available for the requested visual review provider.',
    details: { provider: provider.id },
    provider
  });
}

function fakeVisualReviewResult({ provider, model, surface, preparation, preparationPath, execution, resultId, now }) {
  const boundary = providerBoundary({
    provider,
    providerCallPerformed: true,
    apiCallPerformed: false,
    externalEvidenceTransfer: false
  });
  return {
    ok: true,
    status: 'completed',
    provider_adapter: providerAdapterRecord(provider, boundary),
    visual_review_result: normalizeVisualReviewResult({
      id: resultId,
      now,
      preparation,
      preparationPath,
      input: {
        summary: 'Deterministic fake visual review completed using metadata and local artifact references only.',
        advisory_findings: [],
        owner_decision_requests: []
      },
      surface,
      provider,
      model,
      execution,
      boundary
    }),
    boundary,
    warnings: []
  };
}

async function localRunnerVisualReviewResult({ provider, model, surface, preparation, preparationPath, promptText, execution, resultId, now, context }) {
  const runner = localRunnerForContext(context, provider.id, model.id);
  if (!runner) {
    return providerFailure({
      status: 'blocked',
      code: 'VISUAL_REVIEW_LOCAL_RUNNER_NOT_CONFIGURED',
      message: 'The requested local runner is not configured in the execution context.',
      details: {
        provider: provider.id,
        model: model.id,
        shell_used: false,
        free_form_shell_input_accepted: false,
        next_step: 'Configure a visual review local runner callback in the package API context, or use visual review prepare for manual handoff.'
      },
      provider
    });
  }

  let input;
  try {
    input = await runner({
      schema_version: SCHEMA_VERSION,
      preparation: redact(preparation),
      preparation_path: preparationPath,
      prompt_text: promptText,
      surface,
      provider,
      model,
      execution
    });
  } catch (error) {
    return providerFailure({
      status: 'failed',
      code: 'VISUAL_REVIEW_LOCAL_RUNNER_FAILED',
      message: 'The configured local runner failed before returning visual review JSON.',
      details: {
        provider: provider.id,
        model: model.id,
        reason: error.message,
        shell_used: false,
        raw_provider_response_stored: false
      },
      provider
    });
  }

  const boundary = providerBoundary({
    provider,
    providerCallPerformed: true,
    apiCallPerformed: false,
    externalEvidenceTransfer: false
  });
  return {
    ok: true,
    status: 'completed',
    provider_adapter: providerAdapterRecord(provider, boundary),
    visual_review_result: normalizeVisualReviewResult({
      id: resultId,
      now,
      preparation,
      preparationPath,
      input: input?.visual_review_result ?? input ?? {},
      surface,
      provider,
      model,
      execution,
      boundary
    }),
    boundary,
    warnings: []
  };
}

async function apiVisualReviewResult({ provider, model, surface, preparation, preparationPath, promptText, execution, resultId, now, context }) {
  const env = context.env ?? process.env;
  const endpoint = env[API_PROVIDER_ENDPOINT_ENV];
  const credential = env[API_PROVIDER_CREDENTIAL_ENV];
  if (!endpoint || !credential) {
    return providerFailure({
      status: 'blocked',
      code: 'VISUAL_REVIEW_API_CONFIGURATION_MISSING',
      message: 'Visual review API provider execution requires endpoint and credential environment variables.',
      details: {
        provider: provider.id,
        model: model.id,
        endpoint_env: API_PROVIDER_ENDPOINT_ENV,
        credential_env: API_PROVIDER_CREDENTIAL_ENV,
        endpoint_configured: Boolean(endpoint),
        credential_configured: Boolean(credential),
        credential_values_recorded: false,
        api_call_performed: false
      },
      provider
    });
  }

  let endpointUrl;
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    return providerFailure({
      status: 'blocked',
      code: 'VISUAL_REVIEW_API_ENDPOINT_INVALID',
      message: 'The visual review API provider endpoint environment variable must contain an absolute URL.',
      details: {
        provider: provider.id,
        endpoint_env: API_PROVIDER_ENDPOINT_ENV,
        credential_values_recorded: false,
        api_call_performed: false
      },
      provider
    });
  }
  if (endpointUrl.protocol !== 'https:' && endpointUrl.protocol !== 'http:') {
    return providerFailure({
      status: 'blocked',
      code: 'VISUAL_REVIEW_API_ENDPOINT_UNSUPPORTED_PROTOCOL',
      message: 'The visual review API provider endpoint must use http or https.',
      details: {
        provider: provider.id,
        endpoint_env: API_PROVIDER_ENDPOINT_ENV,
        endpoint_protocol: endpointUrl.protocol,
        credential_values_recorded: false,
        api_call_performed: false
      },
      provider
    });
  }

  const fetchImpl = context.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return providerFailure({
      status: 'blocked',
      code: 'VISUAL_REVIEW_API_FETCH_UNAVAILABLE',
      message: 'No fetch implementation is available for visual review API provider execution.',
      details: {
        provider: provider.id,
        api_call_performed: false,
        credential_values_recorded: false
      },
      provider
    });
  }

  const payload = buildApiPayload({
    preparation,
    preparationPath,
    promptText,
    surface,
    provider,
    model,
    execution
  });

  let response;
  try {
    response = await fetchImpl(endpointUrl.toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${credential}`
      },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    return providerFailure({
      status: 'failed',
      code: 'VISUAL_REVIEW_API_REQUEST_FAILED',
      message: 'The visual review API provider request failed.',
      details: {
        provider: provider.id,
        endpoint_origin: endpointUrl.origin,
        reason: error.message,
        api_call_performed: true,
        credential_values_recorded: false,
        raw_provider_response_stored: false
      },
      provider,
      providerCallPerformed: true,
      apiCallPerformed: true,
      externalEvidenceTransfer: true
    });
  }

  if (!response.ok) {
    return providerFailure({
      status: 'failed',
      code: 'VISUAL_REVIEW_API_RESPONSE_NOT_OK',
      message: 'The visual review API provider returned a non-success status.',
      details: {
        provider: provider.id,
        endpoint_origin: endpointUrl.origin,
        response_status: response.status,
        api_call_performed: true,
        credential_values_recorded: false,
        raw_provider_response_stored: false
      },
      provider,
      providerCallPerformed: true,
      apiCallPerformed: true,
      externalEvidenceTransfer: true
    });
  }

  let input;
  try {
    input = await response.json();
  } catch {
    return providerFailure({
      status: 'failed',
      code: 'VISUAL_REVIEW_API_RESPONSE_INVALID_JSON',
      message: 'The visual review API provider response was not valid visual review JSON.',
      details: {
        provider: provider.id,
        endpoint_origin: endpointUrl.origin,
        api_call_performed: true,
        credential_values_recorded: false,
        raw_provider_response_stored: false
      },
      provider,
      providerCallPerformed: true,
      apiCallPerformed: true,
      externalEvidenceTransfer: true
    });
  }

  const boundary = providerBoundary({
    provider,
    providerCallPerformed: true,
    apiCallPerformed: true,
    externalEvidenceTransfer: true
  });
  return {
    ok: true,
    status: 'completed',
    provider_adapter: providerAdapterRecord(provider, boundary),
    visual_review_result: normalizeVisualReviewResult({
      id: resultId,
      now,
      preparation,
      preparationPath,
      input: input?.visual_review_result ?? input ?? {},
      surface,
      provider,
      model,
      execution,
      boundary
    }),
    boundary,
    warnings: [{
      code: 'VISUAL_REVIEW_METADATA_EXTERNAL_TRANSFER_PERFORMED',
      message: 'API provider execution sent visual review metadata, local artifact references, and a bounded prompt to the configured endpoint.',
      details: {
        provider: provider.id,
        endpoint_origin: endpointUrl.origin,
        raw_pixels_included: false,
        raw_artifact_content_included: false,
        raw_provider_response_stored: false,
        credential_values_recorded: false
      }
    }]
  };
}

function buildApiPayload({ preparation, preparationPath, promptText, surface, provider, model, execution }) {
  return redact({
    schema_version: SCHEMA_VERSION,
    type: 'visual_review_request',
    execution_id: execution.id,
    execution_path: execution.execution_path,
    preparation_id: preparation.id ?? null,
    preparation_path: preparationPath,
    prompt_text: truncateText(promptText, 20000),
    surface: surfaceSummary(surface),
    provider: {
      id: provider.id,
      kind: provider.kind
    },
    model: {
      id: model.id
    },
    disclosure_policy: {
      scope: 'visual_review_execution',
      visual_evidence_metadata_included: true,
      local_artifact_paths_included: true,
      raw_artifact_content_included: false,
      raw_pixels_included: false,
      binary_content_included: false,
      screenshot_binary_included: false,
      raw_dom_included: false,
      trace_content_included: false,
      raw_console_payloads_included: false,
      raw_network_payloads_included: false,
      raw_report_body_included: false,
      source_data_values_included: false,
      external_evidence_transfer: true,
      redaction_applied: true
    },
    visual_evidence: {
      metadata_only: true,
      references: normalizeEvidenceRefs(preparation.visual_evidence?.references)
    },
    result_contract: preparation.result_contract ?? {},
    required_output_schema: 'visual_review_result'
  });
}

function normalizeVisualReviewResult({ id, now, preparation, preparationPath, input, surface, provider, model, execution, boundary }) {
  const inputFindings = Array.isArray(input?.advisory_findings)
    ? input.advisory_findings
    : Array.isArray(input?.visual_review_findings)
      ? input.visual_review_findings
      : Array.isArray(input?.findings)
        ? input.findings
        : [];
  const findings = inputFindings.slice(0, MAX_VISUAL_FINDINGS).map((finding, index) => normalizeVisualFinding(finding, index + 1, id));
  const ownerDecisionRequests = normalizeOwnerDecisionRequests(input?.owner_decision_requests);
  const evidenceRefs = normalizeEvidenceRefs(input?.evidence_refs).length > 0
    ? normalizeEvidenceRefs(input?.evidence_refs)
    : normalizeEvidenceRefs(preparation.visual_evidence?.references);
  const status = findings.length > 0 || ownerDecisionRequests.length > 0 ? 'needs_owner_review' : 'completed';
  const warnings = [];
  if (inputFindings.length > MAX_VISUAL_FINDINGS) {
    warnings.push({
      code: 'VISUAL_REVIEW_FINDINGS_TRUNCATED',
      message: 'Visual review findings were truncated to keep output bounded.',
      details: { limit: MAX_VISUAL_FINDINGS, received: inputFindings.length }
    });
  }
  return redact({
    schema_version: SCHEMA_VERSION,
    id,
    status,
    preparation_id: stringOrNull(preparation.id),
    preparation_path: preparationPath,
    imported_at: now.toISOString(),
    execution_id: execution.id,
    execution_path: execution.execution_path,
    provider: {
      id: provider.id,
      kind: provider.kind,
      transport: provider.transport
    },
    model: {
      id: model.id
    },
    visual_review_result: {
      schema_version: SCHEMA_VERSION,
      id,
      status,
      source: 'visual_review_execution',
      summary: truncateText(input?.summary ?? 'Visual review execution completed with metadata and local artifact references only.', 1000),
      preparation_id: stringOrNull(preparation.id),
      surface: surfaceSummary(surface),
      provider_id: provider.id,
      model_id: model.id,
      advisory_findings: findings,
      owner_decision_requests: ownerDecisionRequests,
      evidence_refs: evidenceRefs,
      gate_effect: 'none',
      untrusted_model_output: true,
      external_evidence_transfer: boundary.external_evidence_transfer,
      api_call_performed_by_cli: boundary.api_call_performed,
      raw_provider_response_stored: false,
      limitations: [
        'Visual review output is untrusted advisory data and is not deterministic proof.',
        'Visual review output does not change review findings, metrics, action plans, or release readiness.',
        'This execution used visual evidence metadata and local artifact references only; raw pixels were not read or transferred.'
      ]
    },
    advisory_findings: findings,
    owner_decision_requests: ownerDecisionRequests,
    evidence_refs: evidenceRefs,
    visual_review_readiness: {
      schema_version: SCHEMA_VERSION,
      status,
      gate_effect: 'none',
      blocking_release_gate: false,
      deterministic_findings_unchanged: true,
      existing_review_mutated: false,
      external_evidence_transfer: boundary.external_evidence_transfer,
      raw_pixels_included: false,
      advisory_findings: findings.length,
      owner_decision_requests: ownerDecisionRequests.length
    },
    warnings,
    gate_effect: 'none',
    boundary
  });
}

function normalizeVisualFinding(finding, index, resultId) {
  const category = VISUAL_FINDING_CATEGORIES.has(finding?.category) ? finding.category : 'other';
  const severity = SEVERITIES.has(finding?.severity) ? finding.severity : 'info';
  return {
    id: truncateText(finding?.id ?? `${resultId}-finding-${index}`, 120),
    category,
    severity,
    confidence: normalizeConfidence(finding?.confidence),
    evidence_refs: normalizeEvidenceRefs(finding?.evidence_refs ?? finding?.artifacts),
    route: optionalString(finding?.route, 500),
    viewport: finding?.viewport && typeof finding.viewport === 'object' ? redact(finding.viewport) : null,
    message: truncateText(finding?.message ?? finding?.summary ?? 'Visual review advisory finding.', 600),
    recommendation: truncateText(finding?.recommendation ?? 'Review this visual advisory item with the product owner before implementation.', 900),
    owner_decision_required: finding?.owner_decision_required !== false,
    source: 'visual_review_advisory',
    untrusted_text: true,
    gate_effect: 'none'
  };
}

function normalizeOwnerDecisionRequests(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return values.slice(0, MAX_OWNER_DECISIONS).map((value, index) => ({
    id: truncateText(value?.id ?? `visual-owner-decision-${index + 1}`, 120),
    question: truncateText(value?.question ?? value?.message ?? 'Owner decision required.', 500),
    reason: truncateText(value?.reason ?? '', 700),
    related_finding_id: optionalString(value?.related_finding_id, 180),
    gate_effect: 'none',
    untrusted_text: true
  }));
}

function normalizeEvidenceRefs(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return values.slice(0, MAX_EVIDENCE_REFS).map((value) => {
    if (typeof value === 'string') {
      return { path: truncateText(value, 500), local_reference: true, content_included: false };
    }
    return {
      id: optionalString(value?.id, 180),
      type: optionalString(value?.type ?? value?.source?.kind, 100),
      path: optionalString(value?.path ?? value?.source?.artifact_path ?? value?.source?.path, 500),
      local_reference: value?.local_reference !== false,
      content_included: false,
      media: value?.media && typeof value.media === 'object' ? redact(value.media) : undefined
    };
  });
}

function normalizeConfidence(value) {
  if (typeof value === 'string') {
    const normalized = CONFIDENCE_VALUES.has(value) ? value : 'inconclusive';
    return {
      evidence: normalized,
      judgment: normalized,
      implementation: 'inconclusive'
    };
  }
  return {
    evidence: CONFIDENCE_VALUES.has(value?.evidence) ? value.evidence : 'inconclusive',
    judgment: CONFIDENCE_VALUES.has(value?.judgment) ? value.judgment : 'inconclusive',
    implementation: CONFIDENCE_VALUES.has(value?.implementation) ? value.implementation : 'inconclusive'
  };
}

function validatePreparationForExecution({ preparation, preparationPath, surface, provider, model }) {
  if (preparation.status !== 'prepared') {
    return {
      ok: false,
      error: {
        code: 'VISUAL_REVIEW_PREPARATION_NOT_RUNNABLE',
        message: 'visual review run requires a preparation artifact with status prepared.',
        details: { preparation: preparationPath, status: preparation.status ?? null }
      }
    };
  }
  if (preparation.result_contract?.required_output_schema !== 'visual_review_result') {
    return {
      ok: false,
      error: {
        code: 'VISUAL_REVIEW_PREPARATION_CONTRACT_MISMATCH',
        message: 'visual review run requires a preparation artifact for visual_review_result output.',
        details: { preparation: preparationPath, required_output_schema: preparation.result_contract?.required_output_schema ?? null }
      }
    };
  }
  if (Number(preparation.visual_evidence?.readable_count ?? 0) <= 0) {
    return {
      ok: false,
      error: {
        code: 'VISUAL_REVIEW_PREPARATION_MISSING_VISUAL_EVIDENCE',
        message: 'visual review run requires readable visual evidence metadata in the preparation artifact.',
        details: { preparation: preparationPath }
      }
    };
  }
  const disclosure = preparation.disclosure_policy ?? {};
  const unsafeFlags = [
    'raw_artifact_content_included',
    'raw_pixels_included',
    'binary_content_included',
    'screenshot_binary_included',
    'raw_dom_included',
    'trace_content_included',
    'raw_console_payloads_included',
    'raw_network_payloads_included',
    'raw_report_body_included',
    'source_data_values_included'
  ].filter((key) => disclosure[key] === true || preparation[key] === true);
  if (unsafeFlags.length > 0) {
    return {
      ok: false,
      error: {
        code: 'VISUAL_REVIEW_PREPARATION_UNSUPPORTED_DISCLOSURE',
        message: 'visual review run supports only metadata and local artifact references in this phase.',
        details: { preparation: preparationPath, unsafe_flags: unsafeFlags }
      }
    };
  }
  const expected = [
    ['surface', preparation.provider_policy?.surface?.id, surface.id],
    ['provider', preparation.provider_policy?.provider?.id, provider.id],
    ['model', preparation.provider_policy?.model?.id, model.id]
  ];
  for (const [key, pinned, actual] of expected) {
    if (pinned && pinned !== actual) {
      return {
        ok: false,
        error: {
          code: 'VISUAL_REVIEW_PREPARATION_EXECUTION_MISMATCH',
          message: 'The visual review preparation provider, model, or surface does not match the requested run.',
          details: { preparation: preparationPath, mismatch: key, expected: pinned, actual }
        }
      };
    }
  }
  return { ok: true };
}

function buildVisualReviewExecutionRecord({
  id,
  status,
  now,
  executionPath,
  resultPath,
  receiptPath,
  preparation,
  preparationPath,
  preparationHash,
  surface,
  provider,
  model,
  providerResult
}) {
  const boundary = visualReviewExecutionBoundary({
    ...providerResult.boundary,
    provider_adapter_implemented: provider.implemented === true
  });
  const completed = status === 'completed';
  return redact({
    schema_version: SCHEMA_VERSION,
    id,
    status,
    mode: 'visual_review_run',
    created_at: now.toISOString(),
    evaluated_at: now.toISOString(),
    completed_at: completed ? now.toISOString() : null,
    execution_path: executionPath,
    execution_receipt_path: receiptPath,
    preparation_id: stringOrNull(preparation.id),
    preparation_path: preparationPath,
    preparation_hash: preparationHash,
    result_path: resultPath,
    latest_result_path: resultPath,
    surface: surfaceSummary(surface),
    provider,
    model,
    provider_adapter: providerResult.provider_adapter,
    steps: {
      preparation: {
        status: 'completed',
        preparation_path: preparationPath,
        raw_pixels_included: false
      },
      execution: {
        status,
        requires_execute_flag: true,
        provider_id: provider.id,
        model_id: model.id,
        provider_call_performed: boundary.provider_call_performed,
        api_call_performed: boundary.api_call_performed,
        external_evidence_transfer: boundary.external_evidence_transfer,
        raw_provider_response_stored: false
      },
      normalize: {
        status: completed ? 'completed' : 'blocked',
        expected_schema: 'visual_review_result',
        result_path: resultPath,
        raw_provider_response_stored: false
      }
    },
    dashboard_handoff: {
      status_command: `${CLI_NAME} visual review status --execution ${executionPath} --json`,
      list_command: `${CLI_NAME} visual review list --json`,
      run_command: `${CLI_NAME} visual review run --preparation ${preparationPath} --surface ${surface.id} --provider ${provider.id} --model ${model.id} --execute --json`,
      visual_review_result_path: resultPath,
      next_safe_action: completed
        ? 'Review the normalized visual review result with the product owner before acting on advisory findings.'
        : 'Inspect the visual review execution error and rerun after the provider boundary is configured.'
    },
    disclosure_policy: {
      scope: 'visual_review_execution',
      visual_evidence_metadata_included: true,
      local_artifact_paths_included: true,
      raw_artifact_content_included: false,
      raw_pixels_included: false,
      raw_pixels_read: false,
      raw_pixels_transferred: false,
      binary_content_included: false,
      screenshot_binary_included: false,
      raw_dom_included: false,
      trace_content_included: false,
      raw_console_payloads_included: false,
      raw_network_payloads_included: false,
      raw_report_body_included: false,
      source_data_values_included: false,
      external_evidence_transfer: boundary.external_evidence_transfer,
      redaction_applied: true
    },
    gate_effect: 'none',
    external_evidence_transfer: boundary.external_evidence_transfer,
    api_call_performed: boundary.api_call_performed,
    provider_call_performed: boundary.provider_call_performed,
    automatic_upload: false,
    credential_storage: 'none',
    persistent_credential_storage: false,
    credential_values_recorded: false,
    raw_response_stored: false,
    raw_provider_response_stored: false,
    existing_review_mutated: false,
    mcp_execution_exposed: false,
    raw_pixels_included: false,
    raw_pixels_read: false,
    raw_pixels_transferred: false,
    boundary
  });
}

function buildVisualReviewExecutionReceipt({ execution, providerResult, resultPath }) {
  return redact({
    schema_version: SCHEMA_VERSION,
    type: 'visual_review_execution_receipt',
    id: execution.id,
    created_at: execution.completed_at ?? execution.created_at,
    status: execution.status,
    execution_path: execution.execution_path,
    preparation_path: execution.preparation_path,
    preparation_hash: execution.preparation_hash,
    surface_id: execution.surface?.id ?? null,
    provider_id: execution.provider?.id ?? null,
    model_id: execution.model?.id ?? null,
    result_path: resultPath,
    provider_call_performed: Boolean(execution.provider_call_performed),
    api_call_performed: Boolean(execution.api_call_performed),
    external_evidence_transfer: Boolean(execution.external_evidence_transfer),
    automatic_upload: false,
    credential_storage: 'none',
    persistent_credential_storage: false,
    credential_values_recorded: false,
    raw_pixels_included: false,
    raw_pixels_read: false,
    raw_pixels_transferred: false,
    raw_response_stored: false,
    raw_provider_response_stored: false,
    existing_review_mutated: false,
    mcp_execution_exposed: false,
    provider_error_code: providerResult.error?.code ?? null
  });
}

function providerFailure({
  status,
  code,
  message,
  details,
  provider,
  providerCallPerformed = false,
  apiCallPerformed = false,
  externalEvidenceTransfer = false
}) {
  const boundary = providerBoundary({ provider, providerCallPerformed, apiCallPerformed, externalEvidenceTransfer });
  return {
    ok: false,
    status,
    error: { code, message, details: redact(details ?? {}) },
    provider_adapter: providerAdapterRecord(provider, boundary),
    boundary,
    warnings: []
  };
}

function providerBoundary({ provider, providerCallPerformed, apiCallPerformed, externalEvidenceTransfer }) {
  return visualReviewExecutionBoundary({
    provider_call_performed: Boolean(providerCallPerformed),
    api_call_performed: Boolean(apiCallPerformed),
    external_evidence_transfer: Boolean(externalEvidenceTransfer),
    provider_adapter_implemented: provider.implemented === true
  });
}

function providerAdapterRecord(provider, boundary) {
  return {
    id: provider.id,
    kind: provider.kind,
    transport: provider.transport,
    implemented: provider.implemented === true,
    endpoint_env: provider.endpoint_env ?? null,
    credential_env: provider.credential_env ?? null,
    credential_mode: provider.credential_mode,
    provider_call_performed: boundary.provider_call_performed,
    api_call_performed: boundary.api_call_performed,
    external_evidence_transfer: boundary.external_evidence_transfer,
    credential_values_recorded: false,
    raw_provider_response_stored: false,
    raw_pixels_included: false,
    raw_pixels_transferred: false,
    shell_used: false,
    free_form_shell_input_accepted: false
  };
}

function localRunnerForContext(context, providerId, modelId) {
  if (typeof context.visualReviewLocalRunner === 'function') {
    return context.visualReviewLocalRunner;
  }
  const runners = context.visualReviewLocalRunners;
  if (!runners || typeof runners !== 'object') {
    return null;
  }
  if (typeof runners[modelId] === 'function') {
    return runners[modelId];
  }
  if (typeof runners[providerId] === 'function') {
    return runners[providerId];
  }
  return null;
}

function summarizeVisualReviewExecutions(executions) {
  const summary = {
    total: executions.length,
    completed: 0,
    failed: 0,
    blocked: 0,
    visual_review_results: 0,
    provider_call_performed: false,
    api_call_performed: false,
    external_evidence_transfer: false,
    automatic_upload: false,
    credential_values_recorded: false,
    raw_pixels_included: false,
    raw_provider_response_stored: false,
    existing_review_mutated: false,
    mcp_execution_exposed: false
  };
  for (const execution of executions) {
    if (Object.hasOwn(summary, execution.status)) {
      summary[execution.status] += 1;
    }
    if (execution.result_path || execution.latest_result_path) {
      summary.visual_review_results += 1;
    }
    summary.provider_call_performed = summary.provider_call_performed || Boolean(execution.provider_call_performed);
    summary.api_call_performed = summary.api_call_performed || Boolean(execution.api_call_performed);
    summary.external_evidence_transfer = summary.external_evidence_transfer || Boolean(execution.external_evidence_transfer);
    summary.automatic_upload = summary.automatic_upload || Boolean(execution.automatic_upload);
    summary.credential_values_recorded = summary.credential_values_recorded || Boolean(execution.credential_values_recorded);
    summary.raw_pixels_included = summary.raw_pixels_included || Boolean(execution.raw_pixels_included);
    summary.raw_provider_response_stored = summary.raw_provider_response_stored || Boolean(execution.raw_provider_response_stored);
    summary.existing_review_mutated = summary.existing_review_mutated || Boolean(execution.existing_review_mutated);
    summary.mcp_execution_exposed = summary.mcp_execution_exposed || Boolean(execution.mcp_execution_exposed);
  }
  return summary;
}

function buildVisualReviewPrompt(preparation) {
  const references = Array.isArray(preparation.visual_evidence?.references)
    ? preparation.visual_evidence.references
    : [];
  return [
    'Review the visual evidence metadata and local artifact references as advisory UI evidence.',
    'Do not claim raw pixel inspection unless a later workflow explicitly authorizes image transfer.',
    'Return JSON matching visual_review_result with advisory_findings, owner_decision_requests, and evidence_refs.',
    `Preparation: ${preparation.id ?? 'unknown'}`,
    `Visual evidence references: ${references.length}`
  ].join('\n');
}

function findSurface(id) {
  return AGENT_SURFACES.find((surface) => surface.id === id) ?? null;
}

async function readWorkspaceJson({ cwd, inputPath, label, maxBytes }) {
  if (!inputPath || typeof inputPath !== 'string') {
    return {
      ok: false,
      error: {
        code: 'VISUAL_REVIEW_EXECUTION_INPUT_REQUIRED',
        message: label + ' path is required.',
        details: { label }
      }
    };
  }
  if (path.isAbsolute(inputPath) || inputPath.includes('\0') || inputPath.split(/[\\/]+/).includes('..')) {
    return {
      ok: false,
      error: {
        code: 'VISUAL_REVIEW_EXECUTION_PATH_OUTSIDE_WORKSPACE',
        message: label + ' path must be a workspace-relative path without parent traversal.',
        details: { label, path: inputPath }
      }
    };
  }
  const workspaceRoot = path.resolve(cwd ?? process.cwd());
  const absolutePath = path.resolve(workspaceRoot, inputPath);
  if (!isPathInside(absolutePath, workspaceRoot)) {
    return {
      ok: false,
      error: {
        code: 'VISUAL_REVIEW_EXECUTION_PATH_OUTSIDE_WORKSPACE',
        message: label + ' path must stay inside the workspace.',
        details: { label, path: inputPath }
      }
    };
  }
  try {
    const realWorkspaceRoot = await realpath(workspaceRoot);
    const realInputPath = await realpath(absolutePath);
    if (!isPathInside(realInputPath, realWorkspaceRoot)) {
      return {
        ok: false,
        error: {
          code: 'VISUAL_REVIEW_EXECUTION_REALPATH_OUTSIDE_WORKSPACE',
          message: label + ' real path must stay inside the workspace.',
          details: { label, path: inputPath }
        }
      };
    }
    const stat = await lstat(realInputPath);
    if (!stat.isFile()) {
      return {
        ok: false,
        error: {
          code: 'VISUAL_REVIEW_EXECUTION_INPUT_NOT_FILE',
          message: label + ' must be a regular JSON file.',
          details: { label, path: inputPath }
        }
      };
    }
    if (stat.size > maxBytes) {
      return {
        ok: false,
        error: {
          code: 'VISUAL_REVIEW_EXECUTION_INPUT_TOO_LARGE',
          message: label + ' exceeds the configured byte limit.',
          details: { label, path: inputPath, bytes: stat.size, max_bytes: maxBytes }
        }
      };
    }
    const text = await readFile(realInputPath, 'utf8');
    return {
      ok: true,
      value: JSON.parse(text),
      text,
      relativePath: path.relative(realWorkspaceRoot, realInputPath).split(path.sep).join('/')
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'VISUAL_REVIEW_EXECUTION_READ_FAILED',
        message: 'Could not read ' + label + ' JSON.',
        details: { label, path: inputPath, reason: error.message }
      }
    };
  }
}

function isPathInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function surfaceSummary(surface) {
  return {
    id: surface.id,
    kind: surface.kind,
    transport: surface.transport,
    status: surface.status,
    implemented: surface.implemented,
    external_evidence_transfer: surface.external_evidence_transfer,
    credential_mode: surface.credential_mode
  };
}

function parseMaxBytes(value) {
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: DEFAULT_EXECUTION_MAX_BYTES };
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { ok: false, message: 'visual review run --max-bytes must be a positive integer.' };
  }
  return { ok: true, value: parsed };
}

function currentDate(now) {
  const value = typeof now === 'function' ? now() : now;
  if (value instanceof Date) {
    return value;
  }
  if (value) {
    return new Date(value);
  }
  return new Date();
}

function hashText(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function optionalString(value, maxLength) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  return truncateText(value, maxLength);
}

function stringOrNull(value) {
  return typeof value === 'string' && value ? value : null;
}

function errorResult(code, message, details = {}) {
  return {
    status: 'error',
    data: {
      boundary: visualReviewExecutionBoundary()
    },
    warnings: [],
    errors: [{ code, message, details }],
    artifacts: []
  };
}
