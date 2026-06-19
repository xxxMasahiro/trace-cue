import { readFile, readdir } from 'node:fs/promises';
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
import { DEFAULT_ARTIFACT_ROOT, SCHEMA_VERSION } from './constants.js';
import { redact } from './redaction.js';

const DEFAULT_LOCAL_PROVIDER = 'local-runner';
const DEFAULT_MODEL = 'not_selected';

export async function runAgentExecutionPlan(options = {}, context = {}) {
  const cwd = context.cwd ?? process.cwd();
  const now = currentDate(context.now);
  const artifactRootInput = options['artifact-root'] ?? DEFAULT_ARTIFACT_ROOT;
  const root = await ensureArtifactRoot(cwd, artifactRootInput);
  const id = context.createId?.('agent-execution', now) ?? createArtifactId(now, 'agent-execution');
  const packageRead = await readAgentPackage(cwd, options.package);
  if (!packageRead.ok) {
    return errorResult(packageRead.error.code, packageRead.error.message, packageRead.error.details);
  }
  const surface = findSurface(options.surface);
  if (!surface) {
    return errorResult('AGENT_EXECUTION_SURFACE_NOT_FOUND', 'No agent surface matched the requested execution surface.', {
      surface: options.surface,
      available_surfaces: AGENT_SURFACES.map((item) => item.id)
    });
  }

  const executionRel = artifactRelPath(artifactRootInput, 'agent-executions', id, 'execution.json');
  const receiptRel = artifactRelPath(artifactRootInput, 'receipts', `${id}.json`);
  const execution = buildExecutionRecord({
    id,
    status: 'planned',
    createdAt: now.toISOString(),
    evaluatedAt: now.toISOString(),
    executionPath: executionRel,
    executionReceiptPath: receiptRel,
    agentPackage: packageRead.agentPackage,
    surface,
    provider: normalizeProvider(options.provider, surface),
    model: normalizeModel(options.model),
    executeRequested: false
  });
  const receipt = buildExecutionReceipt(execution);

  await writeJsonArtifact(root, ['agent-executions', id, 'execution.json'], execution);
  await writeJsonArtifact(root, ['receipts', `${id}.json`], receipt);

  return {
    status: 'ok',
    data: {
      agent_execution: execution,
      agent_execution_plan: execution,
      boundary: execution.boundary
    },
    warnings: planWarnings(surface),
    errors: [],
    artifacts: [
      artifactObject({
        type: 'agent_execution',
        path: executionRel,
        description: 'Local dry-run agent execution plan.'
      }),
      artifactObject({
        type: 'agent_execution_receipt',
        path: receiptRel,
        description: 'Content-free receipt for the local dry-run execution plan.'
      })
    ]
  };
}

export async function runAgentExecutionRun(options = {}, context = {}) {
  if (!options.execute) {
    return errorResult('AGENT_EXECUTION_REQUIRES_EXECUTE', 'agent execution run requires explicit --execute.', {
      execute_required: true,
      dry_run_command: `browser-debug agent execution plan --package ${options.package ?? '<agent-package>'} --surface ${options.surface ?? '<surface>'} --json`
    });
  }

  const surface = findSurface(options.surface);
  if (!surface) {
    return errorResult('AGENT_EXECUTION_SURFACE_NOT_FOUND', 'No agent surface matched the requested execution surface.', {
      surface: options.surface,
      available_surfaces: AGENT_SURFACES.map((item) => item.id)
    });
  }

  return errorResult('AGENT_EXECUTION_PROVIDER_NOT_IMPLEMENTED', 'Direct agent execution providers are not implemented in this slice.', {
    provider: options.provider,
    model: options.model,
    surface: options.surface,
    api_call_performed: false,
    external_evidence_transfer: false,
    credential_values_recorded: false,
    raw_provider_response_stored: false,
    next_step: 'Use agent execution plan first, then implement a dedicated provider adapter with explicit security coverage.'
  });
}

export async function runAgentExecutionStatus(options = {}, context = {}) {
  const cwd = context.cwd ?? process.cwd();
  const executionRead = await readExecution(cwd, options.execution);
  if (!executionRead.ok) {
    return errorResult(executionRead.error.code, executionRead.error.message, executionRead.error.details);
  }
  return {
    status: 'ok',
    data: {
      agent_execution: executionRead.execution,
      agent_execution_status: executionRead.execution,
      boundary: executionRead.execution.boundary ?? executionBoundary()
    },
    warnings: [],
    errors: [],
    artifacts: []
  };
}

export async function runAgentExecutionList(options = {}, context = {}) {
  const cwd = context.cwd ?? process.cwd();
  const artifactRootInput = options['artifact-root'] ?? DEFAULT_ARTIFACT_ROOT;
  const root = resolveArtifactRoot(cwd, artifactRootInput);
  const executions = [];
  const warnings = [];

  try {
    const entries = await readdir(path.join(root, 'agent-executions'), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const executionPath = artifactRelPath(artifactRootInput, 'agent-executions', entry.name, 'execution.json');
      const executionRead = await readExecution(cwd, executionPath);
      if (executionRead.ok) {
        executions.push(executionRead.execution);
      } else {
        warnings.push({
          code: 'AGENT_EXECUTION_READ_FAILED',
          message: 'Could not read an agent execution while listing execution status.',
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
      agent_executions: executions,
      summary: summarizeExecutions(executions),
      boundary: executionBoundary()
    },
    warnings,
    errors: [],
    artifacts: []
  };
}

function buildExecutionRecord({
  id,
  status,
  createdAt,
  evaluatedAt,
  executionPath,
  executionReceiptPath,
  agentPackage,
  surface,
  provider,
  model,
  executeRequested
}) {
  const packet = agentPackage.packet;
  const disclosurePolicy = packet.disclosure_policy ?? {};
  return redact({
    schema_version: SCHEMA_VERSION,
    id,
    status,
    mode: 'dry_run_plan',
    created_at: createdAt,
    evaluated_at: evaluatedAt,
    execution_path: executionPath,
    execution_receipt_path: executionReceiptPath,
    package_id: packet.id ?? null,
    package_path: agentPackage.package_path,
    prompt_path: packet.prompt?.path ?? null,
    review_artifact_index_path: packet.source?.review_artifact_index_path ?? null,
    surface: surfaceSummary(surface),
    provider,
    model,
    steps: {
      plan: {
        status: 'completed',
        no_network: true,
        browser_launched: false
      },
      execution: {
        status: executeRequested ? 'blocked' : 'not_requested',
        requires_execute_flag: true,
        provider_adapter_required: true
      },
      ingest: {
        status: 'pending',
        command: `browser-debug agent ingest --package ${agentPackage.package_path} --input @agent-advisory-result.json --json`
      },
      report: {
        status: 'pending',
        command: `browser-debug agent report --review-index ${packet.source?.review_artifact_index_path ?? '<review-index>'} --agent-result <agent-result> --json`
      }
    },
    dashboard_handoff: {
      status_command: `browser-debug agent execution status --execution ${executionPath} --json`,
      list_command: 'browser-debug agent execution list --json',
      run_command: `browser-debug agent execution run --package ${agentPackage.package_path} --surface ${surface.id} --provider ${provider.id} --model ${model.id} --execute --json`,
      next_safe_action: 'Review the dry-run execution plan before enabling any provider adapter.'
    },
    disclosure_policy: {
      raw_artifact_content_included: Boolean(disclosurePolicy.raw_artifact_content_included),
      screenshot_binary_included: Boolean(disclosurePolicy.screenshot_binary_included),
      trace_content_included: Boolean(disclosurePolicy.trace_content_included),
      source_data_values_included: Boolean(disclosurePolicy.source_data_values_included),
      local_artifact_paths_included: Boolean(disclosurePolicy.local_artifact_paths_included),
      external_evidence_transfer: false,
      bounded_prompt_disclosure_only: true
    },
    gate_effect: 'none',
    external_evidence_transfer: false,
    api_call_performed: false,
    automatic_upload: false,
    credential_storage: 'none',
    persistent_credential_storage: false,
    credential_values_recorded: false,
    raw_response_stored: false,
    raw_provider_response_stored: false,
    existing_review_mutated: false,
    mcp_execution_exposed: false,
    boundary: executionBoundary()
  });
}

function buildExecutionReceipt(execution) {
  return redact({
    schema_version: SCHEMA_VERSION,
    type: 'agent_execution_receipt',
    id: execution.id,
    created_at: execution.created_at,
    execution_path: execution.execution_path,
    package_path: execution.package_path,
    surface_id: execution.surface?.id ?? null,
    provider_id: execution.provider?.id ?? null,
    model_id: execution.model?.id ?? null,
    api_call_performed: false,
    external_evidence_transfer: false,
    automatic_upload: false,
    credential_storage: 'none',
    persistent_credential_storage: false,
    credential_values_recorded: false,
    raw_response_stored: false,
    raw_provider_response_stored: false,
    existing_review_mutated: false,
    mcp_execution_exposed: false
  });
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

function normalizeProvider(provider, surface) {
  const id = provider ?? (surface.kind === 'api_provider' ? surface.id : DEFAULT_LOCAL_PROVIDER);
  return {
    id,
    kind: surface.kind === 'api_provider' ? 'api_provider' : 'local_runner',
    implemented: false,
    api_call_performed: false,
    credential_mode: surface.kind === 'api_provider' ? 'environment_variable_only' : 'none'
  };
}

function normalizeModel(model) {
  return {
    id: model ?? DEFAULT_MODEL,
    selected: Boolean(model),
    raw_provider_response_stored: false
  };
}

function findSurface(id) {
  return AGENT_SURFACES.find((surface) => surface.id === id) ?? null;
}

function planWarnings(surface) {
  if (surface.kind !== 'api_provider') {
    return [];
  }
  return [{
    code: 'AGENT_EXECUTION_EXTERNAL_PROVIDER_APPROVAL_REQUIRED',
    message: 'The selected surface represents an API provider boundary. Planning is local only; execution requires explicit security coverage.',
    details: {
      surface: surface.id,
      api_call_performed: false,
      external_evidence_transfer: false
    }
  }];
}

async function readAgentPackage(cwd, packagePath) {
  const input = await readWorkspaceJson(cwd, packagePath, 'agent execution package');
  if (!input.ok) {
    return input;
  }
  return {
    ok: true,
    agentPackage: {
      package_path: normalizeRelPath(packagePath),
      packet: input.value
    }
  };
}

async function readExecution(cwd, executionPath) {
  const input = await readWorkspaceJson(cwd, executionPath, 'agent execution');
  if (!input.ok) {
    return input;
  }
  return {
    ok: true,
    execution: input.value
  };
}

async function readWorkspaceJson(cwd, relativePath, label) {
  if (!relativePath) {
    return {
      ok: false,
      error: {
        code: 'AGENT_EXECUTION_MISSING_PATH',
        message: `A ${label} path is required.`,
        details: {}
      }
    };
  }
  if (path.isAbsolute(relativePath)) {
    return {
      ok: false,
      error: {
        code: 'AGENT_EXECUTION_PATH_OUTSIDE_WORKSPACE',
        message: `The ${label} path must be relative to the workspace.`,
        details: { path: relativePath }
      }
    };
  }
  const absolute = path.resolve(cwd, relativePath);
  const root = path.resolve(cwd);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    return {
      ok: false,
      error: {
        code: 'AGENT_EXECUTION_PATH_OUTSIDE_WORKSPACE',
        message: `The ${label} path must stay inside the workspace.`,
        details: { path: relativePath }
      }
    };
  }
  try {
    return {
      ok: true,
      value: JSON.parse(await readFile(absolute, 'utf8'))
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'AGENT_EXECUTION_READ_FAILED',
        message: `Could not read the ${label} JSON.`,
        details: { path: relativePath, reason: error.message }
      }
    };
  }
}

function summarizeExecutions(executions) {
  const summary = {
    total: executions.length,
    planned: 0,
    api_call_performed: false,
    external_evidence_transfer: false,
    automatic_upload: false,
    existing_review_mutated: false,
    mcp_execution_exposed: false
  };
  for (const execution of executions) {
    if (execution.status === 'planned') {
      summary.planned += 1;
    }
    summary.api_call_performed = summary.api_call_performed || Boolean(execution.api_call_performed);
    summary.external_evidence_transfer = summary.external_evidence_transfer || Boolean(execution.external_evidence_transfer);
    summary.automatic_upload = summary.automatic_upload || Boolean(execution.automatic_upload);
    summary.existing_review_mutated = summary.existing_review_mutated || Boolean(execution.existing_review_mutated);
    summary.mcp_execution_exposed = summary.mcp_execution_exposed || Boolean(execution.mcp_execution_exposed);
  }
  return summary;
}

function executionBoundary() {
  return {
    browser_launched: false,
    api_call_performed: false,
    external_evidence_transfer: false,
    automatic_upload: false,
    credential_storage: 'none',
    persistent_credential_storage: false,
    credential_values_recorded: false,
    raw_response_stored: false,
    raw_provider_response_stored: false,
    existing_review_mutated: false,
    mcp_execution_exposed: false,
    provider_adapter_implemented: false
  };
}

function normalizeRelPath(value) {
  return value.replace(/\\/g, '/');
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

function errorResult(code, message, details = {}) {
  return {
    status: 'error',
    data: {
      boundary: executionBoundary()
    },
    warnings: [],
    errors: [{ code, message, details }],
    artifacts: []
  };
}
