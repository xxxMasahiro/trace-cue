import { SCHEMA_VERSION } from './constants.js';
import { MCP_PROFILE_NAMES } from './mcp-profiles.js';
import { PRODUCT_IDENTITY } from './product-identity.js';

export const MCP_EXECUTION_GATE_POLICY_VERSION = '1.0.0';

const CURRENT_MCP_EXPOSURE = Object.freeze({
  safe: false,
  full: false,
  admin: false
});

const OPERATIONS = Object.freeze([
  operation({
    id: 'visual_review_prepare',
    command: 'visual review prepare',
    category: 'visual_review_preparation',
    cli_available: true,
    current_status: 'not_exposed',
    proposed_stage: 'planning_gate_required',
    gates: [
      gate('admin_profile_only', 'MCP exposure would require an explicit admin-only write profile decision.'),
      gate('artifact_root_confined', 'Preparation writes must stay under the configured local artifact root.'),
      gate('receipt_required', 'Preparation writes need content-free local receipts with operation ids.'),
      gate('no_provider_call', 'Preparation must remain no-provider and no-API.'),
      gate('no_raw_pixels', 'Preparation must continue reading visual evidence metadata only.'),
      gate('idempotent_request_key', 'MCP callers need a request key so retries do not duplicate artifacts unexpectedly.')
    ]
  }),
  operation({
    id: 'desktop_review_provider_preparation_plan',
    command: 'visual review plan --capture-handoff',
    category: 'desktop_review_provider_preparation',
    cli_available: true,
    current_status: 'not_exposed',
    proposed_stage: 'read_exposure_gate_required',
    gates: [
      gate('safe_profile_review', 'MCP exposure would require explicit approval because capture handoff metadata can reference sensitive desktop content.'),
      gate('no_artifact_write', 'Planning must remain read-only and must not create preparation artifacts.'),
      gate('no_provider_call', 'Planning must not call providers or API adapters.'),
      gate('no_raw_pixels', 'Planning must read capture handoff JSON only and must not read or transfer image bytes.'),
      gate('owner_review_required', 'Provider preparation and external evidence transfer must remain owner-reviewed future actions.')
    ]
  }),
  operation({
    id: 'visual_review_run',
    command: 'visual review run --execute',
    category: 'visual_provider_execution',
    cli_available: true,
    current_status: 'not_exposed',
    proposed_stage: 'execution_gate_required',
    gates: [
      gate('admin_profile_only', 'Provider execution through MCP would require an explicit admin-only execution profile decision.'),
      gate('preparation_required', 'Execution must reference a valid metadata-only preparation artifact.'),
      gate('explicit_execute_intent', 'MCP execution must carry an explicit execute intent separate from planning.'),
      gate('provider_policy_match', 'Surface, provider, model, and disclosure policy must match the preparation contract.'),
      gate('credential_boundary', 'Credentials must remain environment-only and must never be passed as tool arguments.'),
      gate('no_raw_pixel_transfer', 'Raw-pixel transfer remains disabled unless a separate raw-image transfer design is approved.'),
      gate('receipt_required', 'Execution must write local receipts that omit raw provider responses and credential values.'),
      gate('gate_neutrality', 'Execution must not mutate deterministic findings, release gates, or existing reviews.')
    ]
  }),
  operation({
    id: 'visual_review_aggregation',
    command: 'visual review aggregate',
    category: 'visual_review_aggregation',
    cli_available: true,
    current_status: 'not_exposed',
    proposed_stage: 'read_exposure_gate_required',
    gates: [
      gate('no_artifact_write', 'Aggregation must remain read-only and must not write artifacts.'),
      gate('no_provider_call', 'Aggregation must not call providers or API adapters.'),
      gate('no_raw_pixels', 'Aggregation must read local result metadata only and must not read raw image bytes.'),
      gate('untrusted_output_bounded', 'Aggregated advisory text must stay bounded, deterministic, and marked as untrusted.'),
      gate('source_attribution_required', 'Every aggregated finding must keep source result, provider, model, and finding attribution.')
    ]
  }),
  operation({
    id: 'agent_execution_plan',
    command: 'agent execution plan',
    category: 'agent_execution_planning',
    cli_available: true,
    current_status: 'not_exposed',
    proposed_stage: 'planning_gate_required',
    gates: [
      gate('admin_profile_only', 'Planning exposure would require an explicit admin-only write profile decision.'),
      gate('package_confined', 'Planning must read only workspace-confined local agent packages.'),
      gate('receipt_required', 'Planning writes need content-free local receipts.'),
      gate('no_provider_call', 'Planning must not call local runners or provider APIs.'),
      gate('idempotent_request_key', 'MCP callers need a request key so retries do not duplicate plans unexpectedly.')
    ]
  }),
  operation({
    id: 'agent_execution_run',
    command: 'agent execution run --execute',
    category: 'provider_execution',
    cli_available: true,
    current_status: 'not_exposed',
    proposed_stage: 'execution_gate_required',
    gates: [
      gate('admin_profile_only', 'Provider execution through MCP would require an explicit admin-only execution profile decision.'),
      gate('plan_required', 'Execution must reference a matching dry-run plan.'),
      gate('explicit_execute_intent', 'MCP execution must carry an explicit execute intent separate from planning.'),
      gate('credential_boundary', 'Credentials must remain environment-only and must never be passed as tool arguments.'),
      gate('bounded_disclosure', 'Package and prompt disclosure must stay bounded by the existing disclosure policy.'),
      gate('receipt_required', 'Execution must write local receipts that omit raw provider responses and credential values.'),
      gate('gate_neutrality', 'Execution must not mutate deterministic findings, release gates, or existing reviews.')
    ]
  }),
  operation({
    id: 'screen_window_capture_execute',
    command: 'capture run --source <screen|window|desktop-app> --execute',
    category: 'desktop_capture_execution',
    cli_available: false,
    current_status: 'not_available',
    proposed_stage: 'capture_gate_required',
    gates: [
      gate('admin_profile_only', 'Capture execution through MCP would require an explicit admin-only execution profile decision.'),
      gate('owner_initiated_capture', 'Capture must be initiated by the local workspace owner.'),
      gate('selected_surface_required', 'Execution must target an explicit screen, region, window, or desktop app surface.'),
      gate('artifact_root_confined', 'Captured files must stay under the configured local artifact root.'),
      gate('no_raw_pixel_json', 'JSON output must reference local artifacts and metadata instead of embedding pixels.'),
      gate('receipt_required', 'Execution must write local receipts that identify capture scope without storing credentials.'),
      gate('external_transfer_review', 'Any external transfer requires separate owner review after capture.')
    ]
  }),
  operation({
    id: 'resource_artifacts_cleanup_execute',
    command: 'resource artifacts cleanup --execute',
    category: 'cleanup',
    cli_available: true,
    current_status: 'not_exposed',
    proposed_stage: 'destructive_gate_required',
    gates: [
      gate('admin_profile_only', 'Cleanup execution through MCP would require an explicit admin-only destructive-operation decision.'),
      gate('dry_run_parity', 'Cleanup execution must match a prior dry-run candidate set.'),
      gate('artifact_root_confined', 'Cleanup must delete only selected regular files under the configured artifact root.'),
      gate('receipt_required', 'Cleanup must write a local deletion receipt.'),
      gate('no_system_cleanup', 'Cleanup must not mutate host cache, swap, privileged helpers, or arbitrary processes.')
    ]
  })
]);

export const MCP_EXECUTION_GATE_OPERATION_IDS = Object.freeze(OPERATIONS.map((item) => item.id));

export function buildMcpExecutionGateReport(options = {}, context = {}) {
  const operationSelection = normalizeOperation(options.operation);
  if (!operationSelection.ok) {
    return operationSelection;
  }
  const profileSelection = normalizeProfile(options.profile);
  if (!profileSelection.ok) {
    return profileSelection;
  }
  const now = currentDate(context.now ?? options.now);
  const operations = OPERATIONS
    .filter((item) => operationSelection.operation === 'all' || item.id === operationSelection.operation)
    .map((item) => operationReport(item, profileSelection.profile));

  return {
    ok: true,
    report: {
      schema_version: SCHEMA_VERSION,
      policy_version: MCP_EXECUTION_GATE_POLICY_VERSION,
      generated_at: now.toISOString(),
      server_name: PRODUCT_IDENTITY.mcpServerName,
      profile_selection: profileSelection.profile,
      operation_selection: operationSelection.operation,
      summary: {
        operation_count: operations.length,
        write_execute_tools_exposed: false,
        execution_ready_for_mcp: false,
        planning_write_ready_for_mcp: false,
        read_only_report_only: true
      },
      operations,
      boundary: mcpExecutionGateBoundary(),
      next_steps: [
        'Use this report to review required gates before adding any MCP write or execute tool.',
        'Keep current MCP execution exposure disabled until one operation has tests for every listed gate.',
        'Prefer read-only dashboard/status tools until write receipts, idempotency, and credential boundaries are proven.'
      ]
    }
  };
}

export function mcpExecutionGateBoundary() {
  return {
    local_only: true,
    read_only: true,
    writes_artifacts: false,
    deletes_files: false,
    provider_call_performed: false,
    api_call_performed: false,
    external_upload: false,
    raw_pixels_read: false,
    raw_pixels_transferred: false,
    credential_values_read: false,
    credential_values_recorded: false,
    raw_provider_response_stored: false,
    mcp_permissions_changed: false,
    mcp_write_execute_exposed: false,
    shell_used: false,
    gate_effect: 'none'
  };
}

function operation({
  id,
  command,
  category,
  cli_available,
  current_status,
  proposed_stage,
  gates
}) {
  return Object.freeze({
    id,
    command,
    category,
    cli_available,
    current_status,
    proposed_stage,
    current_mcp_exposure: CURRENT_MCP_EXPOSURE,
    gates: Object.freeze(gates)
  });
}

function operationReport(item, profileSelection) {
  return {
    id: item.id,
    command: item.command,
    category: item.category,
    cli_available: item.cli_available,
    current_status: item.current_status,
    proposed_stage: item.proposed_stage,
    profile_selection: profileSelection,
    current_mcp_exposure: item.current_mcp_exposure,
    required_gate_count: item.gates.length,
    required_gates: item.gates,
    boundary: mcpExecutionGateBoundary()
  };
}

function gate(id, description) {
  return Object.freeze({
    id,
    required: true,
    status: 'required_before_exposure',
    enforcement: 'not_implemented_for_mcp_execution',
    description
  });
}

function normalizeOperation(value) {
  const operation = String(value ?? 'all').trim() || 'all';
  if (operation === 'all' || MCP_EXECUTION_GATE_OPERATION_IDS.includes(operation)) {
    return { ok: true, operation };
  }
  return {
    ok: false,
    code: 'INVALID_MCP_EXECUTION_GATE_OPERATION',
    message: `Unsupported MCP execution gate operation: ${operation}. Expected one of: all, ${MCP_EXECUTION_GATE_OPERATION_IDS.join(', ')}.`
  };
}

function normalizeProfile(value) {
  const profile = String(value ?? 'all').trim() || 'all';
  if (profile === 'all' || MCP_PROFILE_NAMES.includes(profile)) {
    return { ok: true, profile };
  }
  return {
    ok: false,
    code: 'INVALID_MCP_EXECUTION_GATE_PROFILE',
    message: `Unsupported MCP execution gate profile: ${profile}. Expected one of: all, ${MCP_PROFILE_NAMES.join(', ')}.`
  };
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
