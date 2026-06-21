import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { CLI_NAME, SCHEMA_VERSION } from './constants.js';
import {
  CAPTURE_HANDOFF_SOURCE_KINDS,
  normalizeCaptureHandoffContract
} from './capture-handoff.js';

export const DESKTOP_REVIEW_PROVIDER_PREPARATION_PLAN_VERSION = '1.0.0';

const MAX_CAPTURE_HANDOFF_BYTES = 2 * 1024 * 1024;

export async function buildDesktopReviewProviderPreparationPlan(options = {}, context = {}) {
  if (options.execute) {
    return failure('DESKTOP_REVIEW_PLAN_EXECUTE_NOT_SUPPORTED', 'visual review plan does not execute providers. Omit --execute.');
  }

  const maxBytes = parseMaxBytes(options['max-bytes']);
  if (!maxBytes.ok) {
    return failure('DESKTOP_REVIEW_PLAN_INVALID_MAX_BYTES', maxBytes.message, { max_bytes: options['max-bytes'] });
  }

  const input = await readCaptureHandoffInput({
    cwd: context.cwd ?? process.cwd(),
    input: options['capture-handoff'],
    stdinText: context.stdinText,
    maxBytes: maxBytes.value
  });
  if (!input.ok) {
    return failure(input.error.code, input.error.message, input.error.details);
  }

  const normalized = normalizeCaptureHandoffForDesktopReview(input.value);
  if (!normalized.ok) {
    return failure(normalized.error.code, normalized.error.message, normalized.error.details);
  }

  const now = materializeNow(context.now ?? options.now);
  const handoff = normalized.captureHandoff;
  const source = handoff.source ?? {};
  const media = handoff.media ?? {};
  const workspaceImagePath = source.path;
  const id = 'desktop-review-plan-' + hashText([
    handoff.id,
    workspaceImagePath,
    media.sha256,
    options.surface,
    options.provider,
    options.model
  ].join('|')).slice(0, 16);

  const plan = {
    schema_version: SCHEMA_VERSION,
    plan_version: DESKTOP_REVIEW_PROVIDER_PREPARATION_PLAN_VERSION,
    id,
    status: 'planned',
    generated_at: now.toISOString(),
    source: {
      capture_handoff_id: stringOrNull(handoff.id),
      capture_handoff_input_path: input.relativePath,
      capture_handoff_input_hash: hashText(input.text),
      source_kind: source.kind,
      workspace_image_path: workspaceImagePath,
      caller_declared_provenance: source.caller_declared_provenance === true,
      source_verified_by_trace_cue: false,
      surface_identity_collected: false,
      capture_performed_by_trace_cue: false
    },
    media: {
      bytes: numberOrNull(media.bytes),
      sha256: stringOrNull(media.sha256),
      format: stringOrNull(media.format),
      media_type: stringOrNull(media.media_type),
      width: numberOrNull(media.width),
      height: numberOrNull(media.height),
      dimensions_available: Boolean(media.dimensions_available)
    },
    readiness: {
      capture_handoff_valid: true,
      local_image_review_required: true,
      review_artifact_index_required: true,
      visual_evidence_metadata_required: true,
      owner_review_required_before_provider_execution: true,
      provider_preparation_artifact_created: false,
      provider_execution_ready: false,
      mcp_execution_ready: false
    },
    provider_preparation: {
      planning_only: true,
      selected_surface: optionSelection(options.surface),
      selected_provider: optionSelection(options.provider),
      selected_model: optionSelection(options.model),
      future_review_command: `${CLI_NAME} review --image ${workspaceImagePath} --capture-handoff ${input.relativePath ?? '<capture-handoff-json>'} --json`,
      future_prepare_command: futurePrepareCommand(options),
      provider_call_planned: false,
      provider_call_performed: false,
      provider_execution_authorized: false,
      preparation_artifact_created: false,
      execution_phase_required: true
    },
    disclosure_policy: {
      metadata_only: true,
      raw_pixels_in_json: false,
      binary_content_included: false,
      image_bytes_read: false,
      raw_pixels_transferred: false,
      external_evidence_transfer: false,
      external_evidence_transfer_authorized: false,
      provider_execution_authorized: false,
      requires_owner_review_before_external_transfer: true,
      requires_owner_review_before_provider_execution: true
    },
    handoff_contract: {
      accepted_capture_handoff_status: 'metadata_only',
      accepted_source_kinds: CAPTURE_HANDOFF_SOURCE_KINDS,
      capture_handoff_input_source: input.source,
      full_envelope_accepted: normalized.fullEnvelopeAccepted,
      inner_capture_handoff_accepted: true
    },
    boundary: desktopReviewProviderPreparationPlanBoundary()
  };

  return {
    status: 'ok',
    data: {
      desktop_review_provider_preparation_plan: plan,
      boundary: plan.boundary
    },
    warnings: [],
    errors: [],
    artifacts: []
  };
}

export function desktopReviewProviderPreparationPlanBoundary() {
  return {
    local_only: true,
    read_only: true,
    workspace_confined_input: true,
    input_realpath_inside_workspace: true,
    regular_file_required: true,
    symlink_escape_allowed: false,
    capture_handoff_json_read: true,
    image_bytes_read: false,
    raw_pixels_read: false,
    raw_pixels_in_json: false,
    binary_content_included: false,
    raw_pixels_transferred: false,
    artifact_created: false,
    writes_artifacts: false,
    deletes_files: false,
    capture_performed: false,
    os_capture_api_used: false,
    window_enumeration_performed: false,
    process_enumeration_performed: false,
    browser_launched: false,
    provider_call_performed: false,
    provider_execution_authorized: false,
    api_call_performed: false,
    external_upload: false,
    external_evidence_transfer: false,
    credential_values_read: false,
    credential_values_recorded: false,
    raw_provider_response_stored: false,
    visual_review_preparation_artifact_created: false,
    mcp_permissions_changed: false,
    mcp_execution_exposed: false,
    mcp_write_execute_exposed: false,
    shell_used: false,
    existing_review_mutated: false,
    gate_effect: 'none',
    requires_owner_review_before_external_transfer: true
  };
}

export function normalizeCaptureHandoffForDesktopReview(value) {
  return normalizeCaptureHandoffContract(value, {
    codePrefix: 'DESKTOP_REVIEW_PLAN_CAPTURE_HANDOFF'
  });
}

async function readCaptureHandoffInput({ cwd, input, stdinText, maxBytes }) {
  if (!input || typeof input !== 'string') {
    return {
      ok: false,
      error: {
        code: 'DESKTOP_REVIEW_PLAN_CAPTURE_HANDOFF_REQUIRED',
        message: 'visual review plan requires --capture-handoff <workspace-json|->.',
        details: { option: 'capture-handoff' }
      }
    };
  }
  const trimmed = input.trim();
  if (trimmed === '-') {
    if (typeof stdinText !== 'string') {
      return {
        ok: false,
        error: {
          code: 'DESKTOP_REVIEW_PLAN_STDIN_NOT_AVAILABLE',
          message: 'visual review plan requested stdin, but no stdin text was provided.',
          details: { option: 'capture-handoff' }
        }
      };
    }
    return parseJsonText(stdinText, { source: 'stdin', relativePath: null, maxBytes });
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return parseJsonText(trimmed, { source: 'inline', relativePath: null, maxBytes });
  }
  const filePath = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
  if (!filePath || filePath.startsWith('@')) {
    return {
      ok: false,
      error: {
        code: 'DESKTOP_REVIEW_PLAN_CAPTURE_HANDOFF_PATH_INVALID',
        message: 'capture handoff JSON path is required.',
        details: { path: input }
      }
    };
  }
  return readWorkspaceJsonFile({ cwd, filePath, maxBytes });
}

function parseJsonText(text, { source, relativePath, maxBytes }) {
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    return {
      ok: false,
      error: {
        code: 'DESKTOP_REVIEW_PLAN_CAPTURE_HANDOFF_TOO_LARGE',
        message: 'capture handoff JSON exceeds the configured byte limit.',
        details: { source, max_bytes: maxBytes }
      }
    };
  }
  try {
    return {
      ok: true,
      value: JSON.parse(text),
      text,
      source,
      relativePath
    };
  } catch {
    return {
      ok: false,
      error: {
        code: 'DESKTOP_REVIEW_PLAN_CAPTURE_HANDOFF_INVALID_JSON',
        message: 'capture handoff input must be valid JSON.',
        details: { source }
      }
    };
  }
}

async function readWorkspaceJsonFile({ cwd, filePath, maxBytes }) {
  if (path.isAbsolute(filePath) || filePath.includes('\0') || filePath.split(/[\\/]+/).includes('..')) {
    return {
      ok: false,
      error: {
        code: 'DESKTOP_REVIEW_PLAN_CAPTURE_HANDOFF_PATH_OUTSIDE_WORKSPACE',
        message: 'capture handoff JSON path must be workspace-relative and must not contain parent traversal.',
        details: { path: filePath }
      }
    };
  }
  const workspaceRoot = path.resolve(cwd ?? process.cwd());
  const absolutePath = path.resolve(workspaceRoot, filePath);
  if (!isPathInside(absolutePath, workspaceRoot)) {
    return {
      ok: false,
      error: {
        code: 'DESKTOP_REVIEW_PLAN_CAPTURE_HANDOFF_PATH_OUTSIDE_WORKSPACE',
        message: 'capture handoff JSON path must stay inside the workspace.',
        details: { path: filePath }
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
          code: 'DESKTOP_REVIEW_PLAN_CAPTURE_HANDOFF_REALPATH_OUTSIDE_WORKSPACE',
          message: 'capture handoff JSON real path must stay inside the workspace.',
          details: { path: filePath }
        }
      };
    }
    const stat = await lstat(realInputPath);
    if (!stat.isFile()) {
      return {
        ok: false,
        error: {
          code: 'DESKTOP_REVIEW_PLAN_CAPTURE_HANDOFF_NOT_FILE',
          message: 'capture handoff JSON must be a regular file.',
          details: { path: filePath }
        }
      };
    }
    if (stat.size > maxBytes) {
      return {
        ok: false,
        error: {
          code: 'DESKTOP_REVIEW_PLAN_CAPTURE_HANDOFF_TOO_LARGE',
          message: 'capture handoff JSON exceeds the configured byte limit.',
          details: { path: filePath, bytes: stat.size, max_bytes: maxBytes }
        }
      };
    }
    const text = await readFile(realInputPath, 'utf8');
    return {
      ok: true,
      value: JSON.parse(text),
      text,
      source: 'file',
      relativePath: path.relative(realWorkspaceRoot, realInputPath).split(path.sep).join('/')
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'DESKTOP_REVIEW_PLAN_CAPTURE_HANDOFF_READ_FAILED',
        message: 'Could not read capture handoff JSON.',
        details: { path: filePath, reason: error.message }
      }
    };
  }
}

function futurePrepareCommand(options) {
  const surface = options.surface ?? '<surface-id>';
  const provider = options.provider ?? '<provider-id>';
  const model = options.model ?? '<model-id>';
  return `${CLI_NAME} visual review prepare --review-index <review-artifact-index> --surface ${surface} --provider ${provider} --model ${model} --json`;
}

function optionSelection(value) {
  const id = stringOrNull(value);
  return {
    id,
    selected: Boolean(id),
    execution_authorized: false
  };
}

function parseMaxBytes(value) {
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: MAX_CAPTURE_HANDOFF_BYTES };
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { ok: false, message: 'visual review plan --max-bytes must be a positive integer.' };
  }
  return { ok: true, value: parsed };
}

function failure(code, message, details = {}) {
  return {
    status: 'error',
    data: {
      desktop_review_provider_preparation_plan: null,
      boundary: desktopReviewProviderPreparationPlanBoundary()
    },
    warnings: [],
    errors: [{ code, message, details }],
    artifacts: []
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

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
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
