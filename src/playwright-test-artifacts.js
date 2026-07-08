import { lstat, mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export const PLAYWRIGHT_TEST_MAX_INPUT_BYTES = 2 * 1024 * 1024;
export const PLAYWRIGHT_TEST_MAX_TREE_BYTES = 32 * 1024 * 1024;
export const PLAYWRIGHT_TEST_MAX_TREE_FILES = 200;
export const PLAYWRIGHT_TEST_MAX_TREE_DEPTH = 8;

const SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
  /\bAuthorization:\s*[^\s,;]+/gi,
  /\b(?:token|access_token|id_token|password|secret|api_key)=([^&\s]+)/gi,
  /\bCookie:\s*[^\n\r]+/gi
];

export async function resolveWorkspaceRegularFile(cwd, inputPath, options = {}) {
  const relative = normalizeWorkspacePath(inputPath);
  if (!relative.ok) {
    return relative;
  }
  const absolute = path.resolve(cwd, relative.value);
  const containment = await assertContainedRegularPath(cwd, absolute, {
    maxBytes: options.maxBytes ?? PLAYWRIGHT_TEST_MAX_INPUT_BYTES
  });
  if (!containment.ok) {
    return containment;
  }
  return {
    ok: true,
    absolute_path: containment.absolute_path,
    relative_path: path.relative(path.resolve(cwd), containment.absolute_path).replaceAll(path.sep, '/'),
    size_bytes: containment.size_bytes
  };
}

export async function assertContainedRegularPath(cwd, absolutePath, options = {}) {
  const root = path.resolve(cwd);
  let link;
  try {
    link = await lstat(absolutePath);
  } catch {
    return fail('PLAYWRIGHT_TEST_INPUT_NOT_FOUND', 'Playwright Test input file was not found.');
  }
  if (link.isSymbolicLink()) {
    return fail('PLAYWRIGHT_TEST_INPUT_SYMLINK_REJECTED', 'Playwright Test input must not be a symlink.');
  }
  if (!link.isFile()) {
    return fail('PLAYWRIGHT_TEST_INPUT_NOT_REGULAR_FILE', 'Playwright Test input must be a regular file.');
  }
  const resolved = await realpath(absolutePath);
  if (!isInside(root, resolved)) {
    return fail('PLAYWRIGHT_TEST_INPUT_OUTSIDE_WORKSPACE', 'Playwright Test input must stay inside the workspace.');
  }
  const info = await stat(resolved);
  const maxBytes = options.maxBytes ?? PLAYWRIGHT_TEST_MAX_INPUT_BYTES;
  if (info.size > maxBytes) {
    return fail('PLAYWRIGHT_TEST_INPUT_TOO_LARGE', 'Playwright Test input is too large.', { max_bytes: maxBytes, size_bytes: info.size });
  }
  return { ok: true, absolute_path: resolved, size_bytes: info.size };
}

export async function readBoundedTextFile(cwd, inputPath, options = {}) {
  const resolved = await resolveWorkspaceRegularFile(cwd, inputPath, options);
  if (!resolved.ok) {
    return resolved;
  }
  const text = await readFile(resolved.absolute_path, 'utf8');
  return { ok: true, ...resolved, text };
}

export function normalizeWorkspacePath(inputPath) {
  const value = String(inputPath ?? '').trim();
  if (!value) {
    return fail('PLAYWRIGHT_TEST_INPUT_REQUIRED', 'A workspace-relative Playwright Test input path is required.');
  }
  if (path.isAbsolute(value)) {
    return fail('PLAYWRIGHT_TEST_INPUT_ABSOLUTE_REJECTED', 'Playwright Test input paths must be workspace-relative.');
  }
  const normalized = path.normalize(value);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    return fail('PLAYWRIGHT_TEST_INPUT_TRAVERSAL_REJECTED', 'Playwright Test input paths must not traverse outside the workspace.');
  }
  return { ok: true, value: normalized };
}

export async function scanArtifactTree(rootDir, options = {}) {
  const root = path.resolve(rootDir);
  await mkdir(root, { recursive: true });
  const state = {
    file_count: 0,
    total_bytes: 0,
    rejected: [],
    suspicious: [],
    attachments: []
  };
  await scanDir(root, root, state, 0, options);
  return {
    ok: state.rejected.length === 0,
    summary: {
      file_count: state.file_count,
      total_bytes: state.total_bytes,
      rejected: state.rejected,
      suspicious: state.suspicious,
      attachments: state.attachments.slice(0, 100)
    }
  };
}

async function scanDir(root, current, state, depth, options) {
  const maxDepth = options.maxDepth ?? PLAYWRIGHT_TEST_MAX_TREE_DEPTH;
  if (depth > maxDepth) {
    state.rejected.push({ code: 'PLAYWRIGHT_TEST_ARTIFACT_TREE_TOO_DEEP', path: safeRel(root, current) });
    return;
  }
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const rel = safeRel(root, absolute);
    if (entry.isSymbolicLink()) {
      state.rejected.push({ code: 'PLAYWRIGHT_TEST_ARTIFACT_SYMLINK_REJECTED', path: rel });
      continue;
    }
    if (entry.isDirectory()) {
      await scanDir(root, absolute, state, depth + 1, options);
      continue;
    }
    if (!entry.isFile()) {
      state.rejected.push({ code: 'PLAYWRIGHT_TEST_ARTIFACT_NOT_REGULAR_FILE', path: rel });
      continue;
    }
    state.file_count += 1;
    if (state.file_count > (options.maxFiles ?? PLAYWRIGHT_TEST_MAX_TREE_FILES)) {
      state.rejected.push({ code: 'PLAYWRIGHT_TEST_ARTIFACT_TOO_MANY_FILES', path: rel });
      continue;
    }
    const info = await stat(absolute);
    state.total_bytes += info.size;
    if (state.total_bytes > (options.maxBytes ?? PLAYWRIGHT_TEST_MAX_TREE_BYTES)) {
      state.rejected.push({ code: 'PLAYWRIGHT_TEST_ARTIFACT_TREE_TOO_LARGE', path: rel });
    }
    if (/\.(zip|tar|gz|tgz)$/i.test(entry.name)) {
      state.rejected.push({ code: 'PLAYWRIGHT_TEST_ARTIFACT_NESTED_ARCHIVE_REJECTED', path: rel });
    }
    if (/\.(html?|log|txt|json|xml)$/i.test(entry.name)) {
      const text = await readSmallText(absolute);
      if (text && containsSecretLikeText(text)) {
        state.suspicious.push({ code: 'PLAYWRIGHT_TEST_ARTIFACT_SECRET_LIKE_TEXT_REDACTED', path: rel });
      }
    }
    state.attachments.push({
      path: rel,
      file_name: path.basename(rel),
      size_bytes: info.size,
      raw_content_included: false
    });
  }
}

async function readSmallText(file) {
  try {
    const info = await stat(file);
    if (info.size > 256 * 1024) {
      return '';
    }
    return await readFile(file, 'utf8');
  } catch {
    return '';
  }
}

export function redactText(value) {
  let text = String(value ?? '');
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (match) => match.includes('=') ? match.replace(/=.*/, '=[REDACTED]') : '[REDACTED]');
  }
  return text;
}

export function containsSecretLikeText(value) {
  const text = String(value ?? '');
  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

function safeRel(root, target) {
  return path.relative(root, target).replaceAll(path.sep, '/') || '.';
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function fail(code, message, details = {}) {
  return { ok: false, code, message, details };
}
