import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  artifactObject,
  artifactRelPath,
  writeJsonArtifact
} from './artifacts.js';
import { SCHEMA_VERSION } from './constants.js';

export const VISUAL_EVIDENCE_SOURCE_KINDS = Object.freeze([
  'browser_screenshot',
  'image_file',
  'mock_image',
  'screen_capture',
  'window_capture',
  'desktop_app_capture'
]);

export const DEFAULT_VISUAL_EVIDENCE_MAX_BYTES = 20 * 1024 * 1024;

const SOURCE_KIND_SET = new Set(VISUAL_EVIDENCE_SOURCE_KINDS);

export function createVisualEvidenceRecord({
  id,
  createdAt = new Date(),
  sourceKind,
  sourcePath = null,
  artifactPath = null,
  buffer,
  purpose = 'visual_review',
  route = null,
  viewport = null,
  capture = null,
  masks = [],
  regions = [],
  labels = []
}) {
  if (!id) {
    throw new Error('Visual evidence id is required.');
  }
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('Visual evidence buffer is required.');
  }
  const kind = normalizeVisualEvidenceSourceKind(sourceKind);
  return {
    schema_version: SCHEMA_VERSION,
    id,
    created_at: createdAt instanceof Date ? createdAt.toISOString() : String(createdAt),
    purpose,
    source: {
      kind,
      path: sourcePath,
      artifact_path: artifactPath
    },
    media: imageMetadata(buffer, { path: artifactPath ?? sourcePath }),
    route,
    viewport,
    capture,
    masks: normalizeArray(masks),
    regions: normalizeArray(regions),
    labels: normalizeArray(labels),
    privacy: {
      may_contain_sensitive_content: true,
      may_contain_page_content: kind === 'browser_screenshot',
      may_contain_desktop_content: kind === 'screen_capture' || kind === 'window_capture' || kind === 'desktop_app_capture',
      requires_owner_review_before_external_transfer: true
    },
    boundary: visualEvidenceBoundary()
  };
}

export async function writeVisualEvidenceRecord({
  id,
  root,
  artifactRoot,
  record
}) {
  if (!id) {
    throw new Error('Visual evidence id is required.');
  }
  const rel = artifactRelPath(artifactRoot, 'visual-evidence', `${id}.json`);
  const data = {
    ...record,
    boundary: {
      ...(record.boundary ?? {}),
      ...visualEvidenceBoundary()
    }
  };
  await writeJsonArtifact(root, ['visual-evidence', `${id}.json`], data);
  return {
    data,
    artifact: artifactObject({
      type: 'visual_evidence',
      path: rel,
      description: 'Local visual evidence metadata without embedded image bytes.'
    })
  };
}

export async function createVisualEvidenceArtifact({
  id,
  root,
  artifactRoot,
  sourceKind,
  sourcePath = null,
  artifactPath = null,
  buffer,
  purpose,
  route,
  viewport,
  capture,
  masks,
  regions,
  labels,
  createdAt
}) {
  const record = createVisualEvidenceRecord({
    id,
    createdAt,
    sourceKind,
    sourcePath,
    artifactPath,
    buffer,
    purpose,
    route,
    viewport,
    capture,
    masks,
    regions,
    labels
  });
  return writeVisualEvidenceRecord({ id, root, artifactRoot, record });
}

export async function readWorkspaceImageFile({
  cwd,
  inputPath,
  maxBytes = DEFAULT_VISUAL_EVIDENCE_MAX_BYTES
}) {
  const resolved = await resolveWorkspaceFilePath(cwd, inputPath);
  const stat = await lstat(resolved.real_path);
  if (!stat.isFile()) {
    const error = new Error('Visual evidence input must be a regular file.');
    error.code = 'VISUAL_EVIDENCE_INPUT_NOT_FILE';
    throw error;
  }
  if (stat.size > maxBytes) {
    const error = new Error('Visual evidence input exceeds the configured byte limit.');
    error.code = 'VISUAL_EVIDENCE_INPUT_TOO_LARGE';
    error.details = { bytes: stat.size, max_bytes: maxBytes };
    throw error;
  }
  const buffer = await readFile(resolved.real_path);
  return {
    ...resolved,
    buffer,
    media: imageMetadata(buffer, { path: resolved.workspace_path })
  };
}

export async function resolveWorkspaceFilePath(cwd, inputPath) {
  if (!inputPath) {
    const error = new Error('Visual evidence input path is required.');
    error.code = 'VISUAL_EVIDENCE_INPUT_REQUIRED';
    throw error;
  }
  const workspaceRoot = path.resolve(cwd ?? process.cwd());
  const absolutePath = path.resolve(workspaceRoot, String(inputPath));
  if (!isPathInside(absolutePath, workspaceRoot)) {
    const error = new Error('Visual evidence input path must stay inside the current workspace.');
    error.code = 'VISUAL_EVIDENCE_PATH_OUTSIDE_WORKSPACE';
    throw error;
  }
  const realWorkspaceRoot = await realpath(workspaceRoot);
  const realInputPath = await realpath(absolutePath);
  if (!isPathInside(realInputPath, realWorkspaceRoot)) {
    const error = new Error('Visual evidence input real path must stay inside the current workspace.');
    error.code = 'VISUAL_EVIDENCE_REALPATH_OUTSIDE_WORKSPACE';
    throw error;
  }
  return {
    absolute_path: absolutePath,
    real_path: realInputPath,
    workspace_path: path.relative(realWorkspaceRoot, realInputPath).split(path.sep).join('/')
  };
}

export function normalizeVisualEvidenceSourceKind(value) {
  const kind = String(value ?? '').trim();
  if (!SOURCE_KIND_SET.has(kind)) {
    const error = new Error(`Unsupported visual evidence source kind: ${kind || '<empty>'}.`);
    error.code = 'VISUAL_EVIDENCE_SOURCE_KIND_UNSUPPORTED';
    error.details = { source_kind: kind, supported: VISUAL_EVIDENCE_SOURCE_KINDS };
    throw error;
  }
  return kind;
}

export function visualEvidenceBoundary() {
  return {
    local_only: true,
    external_upload: false,
    provider_call_performed: false,
    automatic_upload: false,
    raw_pixels_in_json: false,
    binary_content_included: false,
    raw_provider_response_stored: false,
    credential_values_recorded: false,
    mcp_execution_exposed: false,
    existing_review_mutated: false
  };
}

export function imageMetadata(buffer, options = {}) {
  const format = sniffImageFormat(buffer, options.path);
  return {
    bytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    format: format.format,
    media_type: format.media_type,
    width: format.width,
    height: format.height,
    dimensions_available: Number.isInteger(format.width) && Number.isInteger(format.height)
  };
}

export function sniffImageFormat(buffer, inputPath = '') {
  return pngInfo(buffer)
    ?? jpegInfo(buffer)
    ?? gifInfo(buffer)
    ?? webpInfo(buffer)
    ?? extensionInfo(inputPath);
}

function pngInfo(buffer) {
  if (buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    return null;
  }
  return {
    format: 'png',
    media_type: 'image/png',
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

function jpegInfo(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      return {
        format: 'jpeg',
        media_type: 'image/jpeg',
        width: null,
        height: null
      };
    }
    const marker = buffer[offset + 1];
    offset += 2;
    if (marker === 0xd9 || marker === 0xda) {
      break;
    }
    if (offset + 2 > buffer.length) {
      break;
    }
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) {
      break;
    }
    if (isJpegStartOfFrame(marker) && segmentLength >= 7) {
      return {
        format: 'jpeg',
        media_type: 'image/jpeg',
        width: buffer.readUInt16BE(offset + 5),
        height: buffer.readUInt16BE(offset + 3)
      };
    }
    offset += segmentLength;
  }
  return {
    format: 'jpeg',
    media_type: 'image/jpeg',
    width: null,
    height: null
  };
}

function gifInfo(buffer) {
  const signature = buffer.subarray(0, 6).toString('ascii');
  if (buffer.length < 10 || (signature !== 'GIF87a' && signature !== 'GIF89a')) {
    return null;
  }
  return {
    format: 'gif',
    media_type: 'image/gif',
    width: buffer.readUInt16LE(6),
    height: buffer.readUInt16LE(8)
  };
}

function webpInfo(buffer) {
  if (buffer.length < 30 || buffer.subarray(0, 4).toString('ascii') !== 'RIFF' || buffer.subarray(8, 12).toString('ascii') !== 'WEBP') {
    return null;
  }
  const chunk = buffer.subarray(12, 16).toString('ascii');
  if (chunk === 'VP8X' && buffer.length >= 30) {
    return {
      format: 'webp',
      media_type: 'image/webp',
      width: 1 + readUInt24LE(buffer, 24),
      height: 1 + readUInt24LE(buffer, 27)
    };
  }
  return {
    format: 'webp',
    media_type: 'image/webp',
    width: null,
    height: null
  };
}

function extensionInfo(inputPath) {
  const ext = path.extname(String(inputPath ?? '')).toLowerCase();
  if (ext === '.png') {
    return { format: 'png', media_type: 'image/png', width: null, height: null };
  }
  if (ext === '.jpg' || ext === '.jpeg') {
    return { format: 'jpeg', media_type: 'image/jpeg', width: null, height: null };
  }
  if (ext === '.gif') {
    return { format: 'gif', media_type: 'image/gif', width: null, height: null };
  }
  if (ext === '.webp') {
    return { format: 'webp', media_type: 'image/webp', width: null, height: null };
  }
  return { format: 'unknown', media_type: 'application/octet-stream', width: null, height: null };
}

function isJpegStartOfFrame(marker) {
  return [
    0xc0,
    0xc1,
    0xc2,
    0xc3,
    0xc5,
    0xc6,
    0xc7,
    0xc9,
    0xca,
    0xcb,
    0xcd,
    0xce,
    0xcf
  ].includes(marker);
}

function readUInt24LE(buffer, offset) {
  return buffer[offset] + (buffer[offset + 1] << 8) + (buffer[offset + 2] << 16);
}

function isPathInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}
