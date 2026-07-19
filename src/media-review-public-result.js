import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { resolveArtifactRoot } from './artifacts.js';
import { validateJsonSchemaSubset } from './json-schema-subset.js';
import { readStableBoundedFileHandle } from './safe-local-store.js';
import { getSchema } from './schema-registry.js';

const OPERATION_ID = /^[a-f0-9]{32}$/u;
const FORBIDDEN_KEYS = new Set([
  'segments', 'raw_media', 'raw_audio', 'raw_frames', 'full_transcript',
  'process_stdout', 'process_stderr', 'stdout', 'stderr', 'base64', 'blob', 'payload'
]);

export function validatePublicMediaReviewResult(value, options = {}) {
  assertPublicMediaDataBoundary(value, options);
  const validation = validateJsonSchemaSubset(value, getSchema('media_review_result'), {
    externalSchemas: {
      'media-source-decision.schema.json': getSchema('media_source_decision'),
      'media-analysis.schema.json': getSchema('media_analysis'),
      'media-timeline.schema.json': getSchema('media_timeline'),
      'transcript-provider.schema.json': getSchema('transcript_provider')
    },
    maxNodes: options.maxNodes ?? 100_000,
    maxDepth: options.maxDepth ?? 64
  });
  if (!validation.ok) {
    throw publicResultError('MEDIA_REVIEW_COMPARISON_INPUT_SCHEMA_INVALID', 'A saved media review result does not satisfy its public schema.');
  }
  if (options.operationId && value.operation_id !== options.operationId) {
    throw publicResultError('MEDIA_REVIEW_COMPARISON_INPUT_ID_MISMATCH', 'The saved media review result does not match its operation id.');
  }
  return value;
}

export function assertPublicMediaDataBoundary(value, options = {}) {
  const maximumNodes = options.maxNodes ?? 100_000;
  const maximumDepth = options.maxDepth ?? 64;
  const maximumStringCharacters = options.maxStringCharacters ?? 1_000_000;
  const stack = [{ value, depth: 0, exit: false }];
  const active = new WeakSet();
  let nodes = 0;
  let stringCharacters = 0;
  while (stack.length) {
    const { value: current, depth, exit } = stack.pop();
    if (exit) {
      active.delete(current);
      continue;
    }
    nodes += 1;
    if (nodes > maximumNodes || depth > maximumDepth) {
      throw publicResultError('MEDIA_REVIEW_COMPARISON_INPUT_TOO_COMPLEX', 'A saved media review result is too complex.');
    }
    if (typeof current === 'string') {
      stringCharacters += current.length;
      if (stringCharacters > maximumStringCharacters) {
        throw publicResultError('MEDIA_REVIEW_COMPARISON_INPUT_TOO_COMPLEX', 'A saved media review result contains too much text.');
      }
      if (containsPrivateLocator(current)) {
        throw publicResultError('MEDIA_REVIEW_COMPARISON_INPUT_PRIVATE_PATH', 'A saved media review result contains a private path.');
      }
    } else if (Buffer.isBuffer(current) || ArrayBuffer.isView(current) || current instanceof ArrayBuffer) {
      throw publicResultError('MEDIA_REVIEW_COMPARISON_INPUT_BINARY', 'A saved media review result contains binary data.');
    } else if (Array.isArray(current)) {
      if (active.has(current)) throw publicResultError('MEDIA_REVIEW_COMPARISON_INPUT_TOO_COMPLEX', 'A saved media review result is too complex.');
      active.add(current);
      stack.push({ value: current, depth, exit: true });
      for (let index = current.length - 1; index >= 0; index -= 1) stack.push({ value: current[index], depth: depth + 1, exit: false });
    } else if (current && typeof current === 'object') {
      if (active.has(current)) throw publicResultError('MEDIA_REVIEW_COMPARISON_INPUT_TOO_COMPLEX', 'A saved media review result is too complex.');
      active.add(current);
      stack.push({ value: current, depth, exit: true });
      for (const [key, child] of Object.entries(current)) {
        if (FORBIDDEN_KEYS.has(key) || key.endsWith('_base64')) {
          throw publicResultError('MEDIA_REVIEW_COMPARISON_INPUT_PRIVATE_BODY', 'A saved media review result contains a private or raw body.');
        }
        stack.push({ value: child, depth: depth + 1, exit: false });
      }
    }
  }
}

export async function readStoredMediaReviewResult(operationId, options = {}, context = {}) {
  if (!OPERATION_ID.test(operationId ?? '')) {
    throw publicResultError('MEDIA_REVIEW_COMPARISON_OPERATION_ID_INVALID', 'Media review comparison requires an opaque operation id.');
  }
  const maximumBytes = options.maximumBytes ?? 1024 * 1024;
  const cwd = path.resolve(context.cwd ?? process.cwd());
  let workspaceReal;
  let rootReal;
  let directoryReal;
  try {
    workspaceReal = await realpath(cwd);
    const root = resolveArtifactRoot(cwd, options.artifactRoot);
    rootReal = await realpath(root);
    directoryReal = await realpath(path.join(rootReal, 'media-review-results'));
  } catch {
    throw publicResultError('MEDIA_REVIEW_COMPARISON_RESULT_NOT_FOUND', 'A saved media review result could not be read.');
  }
  if (!inside(workspaceReal, rootReal) || !inside(rootReal, directoryReal)) {
    throw publicResultError('MEDIA_REVIEW_COMPARISON_ARTIFACT_ROOT_INVALID', 'The media review result store is outside the workspace.');
  }
  const file = path.join(directoryReal, `${operationId}.json`);
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = await handle.stat({ bigint: true });
    assertStablePublicFile(before, maximumBytes);
    const boundedReader = context.readStableBoundedFileHandle ?? readStableBoundedFileHandle;
    const bytes = await boundedReader(handle, {
      maxBytes: maximumBytes,
      changedError: () => publicResultError(
        'MEDIA_REVIEW_COMPARISON_RESULT_CHANGED',
        'A saved media review result changed while it was read.'
      )
    });
    const after = await handle.stat({ bigint: true });
    assertStablePublicFile(after, maximumBytes);
    if (!sameSnapshot(before, after) || BigInt(bytes.length) !== before.size) {
      throw publicResultError('MEDIA_REVIEW_COMPARISON_RESULT_CHANGED', 'A saved media review result changed while it was read.');
    }
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw publicResultError('MEDIA_REVIEW_COMPARISON_RESULT_UTF8_INVALID', 'A saved media review result is not valid UTF-8.');
    }
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw publicResultError('MEDIA_REVIEW_COMPARISON_RESULT_JSON_INVALID', 'A saved media review result is not valid JSON.');
    }
    validatePublicMediaReviewResult(value, { operationId });
    return {
      value: structuredClone(value),
      digest: digestPublicJson(value),
      bytes: bytes.length
    };
  } catch (error) {
    if (error?.code?.startsWith?.('MEDIA_REVIEW_COMPARISON_')) throw error;
    throw publicResultError('MEDIA_REVIEW_COMPARISON_RESULT_NOT_FOUND', 'A saved media review result could not be read.');
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function digestPublicJson(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertStablePublicFile(info, maximumBytes) {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size <= 0n || info.size > BigInt(maximumBytes)) {
    throw publicResultError('MEDIA_REVIEW_COMPARISON_RESULT_FILE_INVALID', 'A saved media review result is not a safe bounded regular file.');
  }
  if (typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid())) {
    throw publicResultError('MEDIA_REVIEW_COMPARISON_RESULT_OWNER_INVALID', 'A saved media review result has an unexpected owner.');
  }
}

function sameSnapshot(before, after) {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs
    && before.nlink === after.nlink;
}

function containsPrivateLocator(value) {
  const inspected = String(value).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ');
  if (/\bfile:(?=\S)/iu.test(inspected)
    || /\bfile\s*:\s*(?=[\\/]|[A-Za-z]:[\\/])/iu.test(inspected)) return true;
  let unsafeUrl = false;
  const withoutAbsoluteUrls = inspected.replace(/\b(?:https?|wss?|ftp):[^\s<>"'`]+/giu, (candidate) => {
    const resolved = parseSpecialUrlCandidate(candidate);
    if (!resolved) {
      unsafeUrl = true;
      return ' '.repeat(candidate.length);
    }
    if (resolved.parsed.username || resolved.parsed.password || resolved.parsed.search || resolved.parsed.hash
      || containsNestedLocatorInUrlCandidate(candidate.slice(0, resolved.consumed), resolved.parsed)) unsafeUrl = true;
    return `${' '.repeat(resolved.consumed)}${candidate.slice(resolved.consumed)}`;
  });
  if (unsafeUrl) return true;
  return containsAbsoluteLocatorText(withoutAbsoluteUrls);
}

function parseSpecialUrlCandidate(candidate) {
  let consumed = candidate.length;
  while (consumed > 0) {
    try {
      return { parsed: new URL(candidate.slice(0, consumed)), consumed };
    } catch {
      if (!/[),.;!?}]/u.test(candidate[consumed - 1])) return null;
      consumed -= 1;
    }
  }
  return null;
}

function containsNestedLocatorInUrlCandidate(candidate, parsed) {
  if (candidate.includes('\\')
    || ((candidate.match(/\b(?:https?|wss?|ftp|file):/giu) ?? []).length > 1)
    || /\bfile:/iu.test(candidate)) return true;
  const pathname = parsed.pathname.replace(/^\//u, '');
  if (pathname.includes('//') || containsAbsoluteLocatorText(pathname)) return true;
  try {
    const decodedPathname = decodeURIComponent(pathname);
    return decodedPathname !== pathname && containsAbsoluteLocatorText(decodedPathname);
  } catch {
    return true;
  }
}

function containsAbsoluteLocatorText(value) {
  return /\/\/(?!\s)/u.test(value)
    || /(?:^|[^A-Za-z0-9])\/(?![\/\s])[^\s<>{}"'`]*/u.test(value)
    || /(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/](?!\s)[^\s<>{}"'`]*/u.test(value)
    || /(?:^|[^A-Za-z0-9])\\(?!\s)[^\s<>{}"'`]*/u.test(value);
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function publicResultError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.details = {};
  return error;
}
