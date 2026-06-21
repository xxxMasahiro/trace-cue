import { SCHEMA_VERSION } from './constants.js';

export const CAPTURE_PLAN_VERSION = '1.0.0';

const SOURCE_PLANS = Object.freeze([
  sourcePlan({
    id: 'screen',
    source_kind: 'screen_capture',
    label: 'Screen capture',
    scope: 'entire_display_or_selected_region',
    current_status: 'planning_only',
    future_command: 'capture run --source screen --execute',
    gates: [
      gate('owner_initiated_capture', 'Capture must be initiated by the local workspace owner.'),
      gate('visible_consent_boundary', 'The user must know the full display can contain unrelated private content.'),
      gate('region_or_display_selection', 'Implementation must record which display or region was selected without collecting process lists.'),
      gate('local_artifact_root_confined', 'Captured files must be written only under the configured local artifact root.'),
      gate('no_raw_pixel_json', 'JSON output must reference local artifacts and metadata instead of embedding pixels.'),
      gate('external_transfer_review', 'Any external transfer requires separate owner review after capture.'),
      gate('mcp_execution_gate', 'MCP exposure requires a separate write/execute gate and must not be implied by planning output.')
    ]
  }),
  sourcePlan({
    id: 'window',
    source_kind: 'window_capture',
    label: 'Window capture',
    scope: 'selected_window_or_selected_region',
    current_status: 'planning_only',
    future_command: 'capture run --source window --execute',
    gates: [
      gate('owner_initiated_capture', 'Capture must be initiated by the local workspace owner.'),
      gate('explicit_window_selection', 'Implementation must require explicit window selection and avoid background enumeration disclosure.'),
      gate('sensitive_neighbor_content_review', 'Window edges, overlays, notifications, and adjacent desktop content require review.'),
      gate('local_artifact_root_confined', 'Captured files must be written only under the configured local artifact root.'),
      gate('no_raw_pixel_json', 'JSON output must reference local artifacts and metadata instead of embedding pixels.'),
      gate('external_transfer_review', 'Any external transfer requires separate owner review after capture.'),
      gate('mcp_execution_gate', 'MCP exposure requires a separate write/execute gate and must not be implied by planning output.')
    ]
  }),
  sourcePlan({
    id: 'desktop-app',
    source_kind: 'desktop_app_capture',
    label: 'Desktop app capture',
    scope: 'selected_desktop_application_surface',
    current_status: 'planning_only',
    future_command: 'capture run --source desktop-app --execute',
    gates: [
      gate('owner_initiated_capture', 'Capture must be initiated by the local workspace owner.'),
      gate('application_surface_selection', 'Implementation must select a user-approved app surface without automating private app state.'),
      gate('no_process_control', 'Capture planning must not control arbitrary processes or automate desktop applications.'),
      gate('local_artifact_root_confined', 'Captured files must be written only under the configured local artifact root.'),
      gate('no_raw_pixel_json', 'JSON output must reference local artifacts and metadata instead of embedding pixels.'),
      gate('external_transfer_review', 'Any external transfer requires separate owner review after capture.'),
      gate('mcp_execution_gate', 'MCP exposure requires a separate write/execute gate and must not be implied by planning output.')
    ]
  })
]);

export const CAPTURE_PLAN_SOURCE_IDS = Object.freeze(SOURCE_PLANS.map((item) => item.id));

export function buildCapturePlan(options = {}, context = {}) {
  const sourceSelection = normalizeCapturePlanSource(options.source);
  if (!sourceSelection.ok) {
    return sourceSelection;
  }
  const now = materializeNow(context.now ?? options.now);
  const sources = SOURCE_PLANS
    .filter((item) => sourceSelection.source === 'all' || item.id === sourceSelection.source)
    .map((item) => captureSourceReport(item));

  return {
    ok: true,
    report: {
      schema_version: SCHEMA_VERSION,
      plan_version: CAPTURE_PLAN_VERSION,
      generated_at: now.toISOString(),
      source_selection: sourceSelection.source,
      summary: {
        source_count: sources.length,
        implementation_stage: 'planning_only',
        capture_performed: false,
        raw_pixels_read: false,
        raw_pixels_written: false,
        raw_pixels_in_json: false,
        writes_artifacts: false,
        provider_call_performed: false,
        mcp_execution_exposed: false,
        native_capture_dependency_loaded: false,
        owner_review_required_before_capture: true
      },
      sources,
      boundary: capturePlanBoundary(),
      next_steps: [
        'Use this plan to review capture safety before implementing any OS screen, window, or desktop app capture.',
        'Until capture execution is implemented, use owner-created local screenshots with review --image for existing image files.',
        'Keep MCP exposure read-only until capture write receipts, artifact confinement, and owner-review gates are implemented.'
      ]
    }
  };
}

export function capturePlanBoundary() {
  return {
    local_only: true,
    read_only: true,
    planning_only: true,
    capture_performed: false,
    screen_capture_performed: false,
    window_capture_performed: false,
    desktop_app_capture_performed: false,
    browser_launched: false,
    writes_artifacts: false,
    deletes_files: false,
    provider_call_performed: false,
    api_call_performed: false,
    external_upload: false,
    raw_pixels_read: false,
    raw_pixels_written: false,
    raw_pixels_in_json: false,
    raw_pixels_transferred: false,
    binary_content_included: false,
    credential_values_read: false,
    credential_values_recorded: false,
    raw_provider_response_stored: false,
    mcp_permissions_changed: false,
    mcp_execution_exposed: false,
    mcp_write_execute_exposed: false,
    shell_used: false,
    os_capture_api_used: false,
    native_capture_dependency_loaded: false,
    window_enumeration_performed: false,
    process_enumeration_performed: false,
    requires_owner_review_before_capture: true,
    requires_owner_review_before_external_transfer: true,
    gate_effect: 'none'
  };
}

function captureSourceReport(item) {
  return {
    id: item.id,
    source_kind: item.source_kind,
    label: item.label,
    scope: item.scope,
    current_status: item.current_status,
    future_command: item.future_command,
    visual_evidence_source_kind_supported: true,
    cli_capture_available: false,
    mcp_capture_available: false,
    review_existing_file_command: 'trace-cue review --image <workspace-image> --json',
    required_gate_count: item.gates.length,
    required_gates: item.gates,
    boundary: capturePlanBoundary()
  };
}

function sourcePlan({
  id,
  source_kind,
  label,
  scope,
  current_status,
  future_command,
  gates
}) {
  return Object.freeze({
    id,
    source_kind,
    label,
    scope,
    current_status,
    future_command,
    gates: Object.freeze(gates)
  });
}

function gate(id, description) {
  return Object.freeze({
    id,
    required: true,
    status: 'required_before_capture_execution',
    enforcement: 'not_implemented_for_capture_execution',
    description
  });
}

function normalizeCapturePlanSource(value) {
  const source = String(value ?? 'all').trim() || 'all';
  if (source === 'all' || CAPTURE_PLAN_SOURCE_IDS.includes(source)) {
    return { ok: true, source };
  }
  return {
    ok: false,
    code: 'INVALID_CAPTURE_PLAN_SOURCE',
    message: `Unsupported capture plan source: ${source}. Expected one of: all, ${CAPTURE_PLAN_SOURCE_IDS.join(', ')}.`
  };
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
