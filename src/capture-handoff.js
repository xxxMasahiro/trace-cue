import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { SCHEMA_VERSION } from './constants.js';
import {
  DEFAULT_VISUAL_EVIDENCE_MAX_BYTES,
  readWorkspaceImageFile
} from './visual-evidence.js';

export const CAPTURE_HANDOFF_VERSION = '1.0.0';

const SOURCE_KIND_BY_SOURCE = Object.freeze({
  screen: 'screen_capture',
  window: 'window_capture',
  'desktop-app': 'desktop_app_capture'
});

export const CAPTURE_HANDOFF_SOURCE_IDS = Object.freeze(Object.keys(SOURCE_KIND_BY_SOURCE));
export const CAPTURE_HANDOFF_SOURCE_KINDS = Object.freeze(Object.values(SOURCE_KIND_BY_SOURCE));
export const CAPTURE_HANDOFF_JSON_MAX_BYTES = 2 * 1024 * 1024;

export async function runCaptureHandoff(options = {}, context = {}) {
  const sourceSelection = normalizeCaptureHandoffSource(options.source);
  if (!sourceSelection.ok) {
    return failure(sourceSelection.code, sourceSelection.message, { source: options.source });
  }
  const maxBytes = parseMaxBytes(options['max-bytes']);
  if (!maxBytes.ok) {
    return failure('CAPTURE_HANDOFF_INVALID_MAX_BYTES', maxBytes.message, { max_bytes: options['max-bytes'] });
  }
  const cwd = context.cwd ?? process.cwd();
  const now = materializeNow(context.now ?? options.now);

  let image;
  try {
    image = await readWorkspaceImageFile({
      cwd,
      inputPath: options.image,
      maxBytes: maxBytes.value
    });
  } catch (error) {
    return failure(error.code ?? 'CAPTURE_HANDOFF_IMAGE_READ_FAILED', error.message, {
      image: options.image,
      ...(error.details ?? {})
    });
  }

  const sourceKind = SOURCE_KIND_BY_SOURCE[sourceSelection.source];
  const handoff = {
    schema_version: SCHEMA_VERSION,
    handoff_version: CAPTURE_HANDOFF_VERSION,
    id: 'capture-handoff-' + image.media.sha256.slice(0, 16),
    status: 'metadata_only',
    generated_at: now.toISOString(),
    created_at: now.toISOString(),
    source: {
      selection: sourceSelection.source,
      kind: sourceKind,
      capture_status: 'existing_workspace_image',
      capture_performed_by_trace_cue: false,
      source_verified_by_trace_cue: false,
      caller_declared_provenance: true,
      surface_identity_collected: false,
      path: image.workspace_path
    },
    media: image.media,
    privacy: {
      may_contain_sensitive_content: true,
      may_contain_desktop_content: true,
      requires_owner_review_before_external_transfer: true
    },
    disclosure_policy: {
      raw_pixels_in_json: false,
      binary_content_included: false,
      external_transfer: false,
      provider_execution_authorized: false,
      owner_review_required_before_external_transfer: true
    },
    visual_evidence_contract: {
      future_schema: 'visual_evidence',
      future_source_kind: sourceKind,
      visual_evidence_created: false,
      artifact_path: null,
      compatible_review_command: 'trace-cue review --image ' + image.workspace_path + ' --capture-handoff <capture-handoff-json> --json'
    },
    handoff: {
      local_review_ready: true,
      artifact_write_required: false,
      recommended_next_command: 'trace-cue review --image ' + image.workspace_path + ' --capture-handoff <capture-handoff-json> --json',
      notes: [
        'This handoff references an existing workspace image only.',
        'TraceCue did not capture the screen, enumerate windows, or create visual evidence artifacts in this command.',
        'Use owner-approved visual provider workflows only after separate disclosure review.'
      ]
    },
    boundary: captureHandoffBoundary()
  };

  return {
    status: 'ok',
    data: {
      capture_handoff: handoff,
      boundary: handoff.boundary
    },
    warnings: [],
    errors: [],
    artifacts: []
  };
}

export function captureHandoffBoundary() {
  return {
    local_only: true,
    workspace_confined_input: true,
    input_realpath_inside_workspace: true,
    regular_file_required: true,
    symlink_escape_allowed: false,
    read_only: true,
    artifact_created: false,
    writes_artifacts: false,
    deletes_files: false,
    existing_workspace_image_read: true,
    image_bytes_read_for_metadata: true,
    capture_performed: false,
    screen_capture_performed: false,
    window_capture_performed: false,
    desktop_app_capture_performed: false,
    os_capture_api_used: false,
    native_capture_dependency_loaded: false,
    window_enumeration_performed: false,
    process_enumeration_performed: false,
    browser_launched: false,
    provider_call_performed: false,
    api_call_performed: false,
    external_upload: false,
    external_evidence_transfer: false,
    raw_pixels_in_json: false,
    binary_content_included: false,
    raw_pixels_transferred: false,
    credential_values_read: false,
    credential_values_recorded: false,
    raw_provider_response_stored: false,
    mcp_permissions_changed: false,
    mcp_execution_exposed: false,
    mcp_write_execute_exposed: false,
    shell_used: false,
    existing_review_mutated: false,
    gate_effect: 'none'
  };
}

export function normalizeCaptureHandoffSource(value) {
  const source = String(value ?? '').trim();
  if (CAPTURE_HANDOFF_SOURCE_IDS.includes(source)) {
    return { ok: true, source };
  }
  return {
    ok: false,
    code: 'INVALID_CAPTURE_HANDOFF_SOURCE',
    message: `Unsupported capture handoff source: ${source || '<empty>'}. Expected one of: ${CAPTURE_HANDOFF_SOURCE_IDS.join(', ')}.`
  };
}

export function normalizeCaptureHandoffContract(value, options = {}) {
  const codePrefix = options.codePrefix ?? 'CAPTURE_HANDOFF';
  const fromEnvelope = value?.data?.capture_handoff;
  const fromNamed = value?.capture_handoff;
  const captureHandoff = fromEnvelope ?? fromNamed ?? value;
  if (!captureHandoff || typeof captureHandoff !== 'object') {
    return invalidHandoff(codePrefix, 'MISSING', 'capture handoff input must contain a capture_handoff object.');
  }
  if (captureHandoff.status !== 'metadata_only') {
    return invalidHandoff(codePrefix, 'STATUS_UNSUPPORTED', 'capture handoff status must be metadata_only.', {
      status: captureHandoff.status
    });
  }
  const source = captureHandoff.source ?? {};
  if (!CAPTURE_HANDOFF_SOURCE_KINDS.includes(source.kind)) {
    return invalidHandoff(codePrefix, 'SOURCE_UNSUPPORTED', 'capture handoff source kind must be screen_capture, window_capture, or desktop_app_capture.', {
      source_kind: source.kind
    });
  }
  const pathError = validateWorkspaceImagePath(source.path);
  if (pathError) {
    return invalidHandoff(codePrefix, pathError.suffix, pathError.message, pathError.details);
  }
  const disclosure = captureHandoff.disclosure_policy ?? {};
  const boundary = captureHandoff.boundary ?? {};
  if (disclosure.raw_pixels_in_json !== false || disclosure.provider_execution_authorized !== false) {
    return invalidHandoff(codePrefix, 'DISCLOSURE_UNSAFE', 'capture handoff disclosure must disable raw-pixel JSON and provider execution.', {
      raw_pixels_in_json: disclosure.raw_pixels_in_json,
      provider_execution_authorized: disclosure.provider_execution_authorized
    });
  }
  if (boundary.capture_performed !== false || boundary.raw_pixels_in_json !== false || boundary.external_evidence_transfer === true) {
    return invalidHandoff(codePrefix, 'BOUNDARY_UNSAFE', 'capture handoff boundary must stay metadata-only, local, and non-capturing.', {
      capture_performed: boundary.capture_performed,
      raw_pixels_in_json: boundary.raw_pixels_in_json,
      external_evidence_transfer: boundary.external_evidence_transfer
    });
  }
  return {
    ok: true,
    captureHandoff,
    fullEnvelopeAccepted: Boolean(fromEnvelope)
  };
}

export async function readCaptureHandoffJsonInput({
  cwd,
  input,
  stdinText,
  maxBytes = CAPTURE_HANDOFF_JSON_MAX_BYTES,
  codePrefix = 'CAPTURE_HANDOFF_INPUT',
  stdinErrorCode = `${codePrefix}_STDIN_NOT_AVAILABLE`,
  requiredMessage = 'capture handoff JSON input is required.'
} = {}) {
  if (!input || typeof input !== 'string') {
    return {
      ok: false,
      error: {
        code: `${codePrefix}_REQUIRED`,
        message: requiredMessage,
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
          code: stdinErrorCode,
          message: 'capture handoff JSON was requested from stdin, but no stdin text was provided.',
          details: { option: 'capture-handoff' }
        }
      };
    }
    return parseCaptureHandoffJsonText(stdinText, { source: 'stdin', relativePath: null, maxBytes, codePrefix });
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return parseCaptureHandoffJsonText(trimmed, { source: 'inline', relativePath: null, maxBytes, codePrefix });
  }
  const filePath = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
  if (!filePath || filePath.startsWith('@')) {
    return {
      ok: false,
      error: {
        code: `${codePrefix}_PATH_INVALID`,
        message: 'capture handoff JSON path is required.',
        details: { path: input }
      }
    };
  }
  return readWorkspaceCaptureHandoffJsonFile({ cwd, filePath, maxBytes, codePrefix });
}

export function hashCaptureHandoffText(text) {
  return createHash('sha256').update(String(text ?? '')).digest('hex');
}

function parseCaptureHandoffJsonText(text, { source, relativePath, maxBytes, codePrefix }) {
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    return {
      ok: false,
      error: {
        code: `${codePrefix}_TOO_LARGE`,
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
      relativePath,
      textHash: hashCaptureHandoffText(text)
    };
  } catch {
    return {
      ok: false,
      error: {
        code: `${codePrefix}_INVALID_JSON`,
        message: 'capture handoff input must be valid JSON.',
        details: { source }
      }
    };
  }
}

async function readWorkspaceCaptureHandoffJsonFile({ cwd, filePath, maxBytes, codePrefix }) {
  if (path.isAbsolute(filePath) || filePath.includes('\0') || filePath.split(/[\\/]+/).includes('..')) {
    return {
      ok: false,
      error: {
        code: `${codePrefix}_PATH_OUTSIDE_WORKSPACE`,
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
        code: `${codePrefix}_PATH_OUTSIDE_WORKSPACE`,
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
          code: `${codePrefix}_REALPATH_OUTSIDE_WORKSPACE`,
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
          code: `${codePrefix}_NOT_FILE`,
          message: 'capture handoff JSON must be a regular file.',
          details: { path: filePath }
        }
      };
    }
    if (stat.size > maxBytes) {
      return {
        ok: false,
        error: {
          code: `${codePrefix}_TOO_LARGE`,
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
      relativePath: path.relative(realWorkspaceRoot, realInputPath).split(path.sep).join('/'),
      textHash: hashCaptureHandoffText(text)
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: `${codePrefix}_READ_FAILED`,
        message: 'Could not read capture handoff JSON.',
        details: { path: filePath, reason: error.message }
      }
    };
  }
}

function validateWorkspaceImagePath(value) {
  const imagePath = String(value ?? '').trim();
  if (!imagePath || imagePath === '-' || imagePath.startsWith('@')) {
    return {
      suffix: 'IMAGE_PATH_INVALID',
      message: 'capture handoff source.path must be a workspace-relative image path.',
      details: { path: value }
    };
  }
  if (/^(?:[a-z][a-z0-9+.-]*:|\/|[A-Za-z]:[\\/])/i.test(imagePath) || imagePath.includes('\0')) {
    return {
      suffix: 'IMAGE_PATH_INVALID',
      message: 'capture handoff source.path must not be a URL, data URI, absolute path, or raw input stream.',
      details: { path: value }
    };
  }
  if (imagePath.split(/[\\/]+/).includes('..')) {
    return {
      suffix: 'IMAGE_PATH_INVALID',
      message: 'capture handoff source.path must not contain parent directory traversal.',
      details: { path: value }
    };
  }
  return null;
}

function invalidHandoff(prefix, suffix, message, details = {}) {
  return {
    ok: false,
    error: {
      code: `${prefix}_${suffix}`,
      message,
      details
    }
  };
}

function isPathInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function parseMaxBytes(value) {
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: DEFAULT_VISUAL_EVIDENCE_MAX_BYTES };
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { ok: false, message: '--max-bytes must be a positive integer.' };
  }
  return { ok: true, value: parsed };
}

function failure(code, message, details = {}) {
  return {
    status: 'error',
    data: {
      capture_handoff: null,
      boundary: {
        ...captureHandoffBoundary(),
        existing_workspace_image_read: false,
        image_bytes_read_for_metadata: false
      }
    },
    warnings: [],
    errors: [{ code, message, details }],
    artifacts: []
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
