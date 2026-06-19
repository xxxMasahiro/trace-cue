import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_RESTRICTED_INPUT_MAX_BYTES = 1024 * 1024;

export async function resolveTextInput(value, context = {}, label = 'input') {
  if (value === undefined || value === null) {
    return { ok: false, error: inputError('MISSING_INPUT', `${label} is required.`, { label }) };
  }
  if (value === '-') {
    if (typeof context.stdinText === 'string') {
      return { ok: true, value: context.stdinText, source: 'stdin' };
    }
    return { ok: false, error: inputError('STDIN_NOT_AVAILABLE', `${label} requested stdin, but no stdin text was provided.`, { label }) };
  }
  if (typeof value === 'string' && value.startsWith('@')) {
    const filePath = value.slice(1);
    if (!filePath) {
      return { ok: false, error: inputError('INPUT_FILE_REQUIRED', `${label} file path is required after @.`, { label }) };
    }
    if (context.restrictWorkspaceInputs) {
      return resolveRestrictedFileInput(filePath, context, label);
    }
    try {
      const cwd = context.cwd ?? process.cwd();
      const resolved = path.resolve(cwd, filePath);
      return { ok: true, value: await readFile(resolved, 'utf8'), source: 'file', path: resolved };
    } catch (error) {
      return {
        ok: false,
        error: inputError('INPUT_FILE_READ_FAILED', `Could not read ${label} file.`, {
          label,
          path: filePath,
          reason: error.message
        })
      };
    }
  }
  return { ok: true, value: String(value), source: 'inline' };
}

export async function resolveJsonInput(value, context = {}, label = 'input') {
  const resolved = await resolveTextInput(value, context, label);
  if (!resolved.ok) {
    return resolved;
  }
  try {
    return {
      ok: true,
      value: JSON.parse(resolved.value),
      source: resolved.source,
      path: resolved.path
    };
  } catch {
    return { ok: false, error: inputError('INVALID_JSON_INPUT', `${label} must be valid JSON.`, { label, source: resolved.source }) };
  }
}

function inputError(code, message, details) {
  return { code, message, details };
}

async function resolveRestrictedFileInput(filePath, context, label) {
  const cwd = context.cwd ?? process.cwd();
  if (path.isAbsolute(filePath) || hasParentTraversal(filePath)) {
    return {
      ok: false,
      error: inputError('INPUT_FILE_OUTSIDE_WORKSPACE', `${label} file must stay within the workspace.`, {
        label,
        path: filePath
      })
    };
  }

  const resolved = path.resolve(cwd, filePath);
  const root = await realpath(cwd);
  if (!isPathInside(root, resolved)) {
    return {
      ok: false,
      error: inputError('INPUT_FILE_OUTSIDE_WORKSPACE', `${label} file must stay within the workspace.`, {
        label,
        path: filePath
      })
    };
  }

  let realFile;
  try {
    realFile = await realpath(resolved);
  } catch (error) {
    return {
      ok: false,
      error: inputError('INPUT_FILE_READ_FAILED', `Could not read ${label} file.`, {
        label,
        path: filePath,
        reason: error.message
      })
    };
  }

  if (!isPathInside(root, realFile)) {
    return {
      ok: false,
      error: inputError('INPUT_FILE_OUTSIDE_WORKSPACE', `${label} file must stay within the workspace.`, {
        label,
        path: filePath
      })
    };
  }

  const info = await stat(realFile);
  if (!info.isFile()) {
    return {
      ok: false,
      error: inputError('INPUT_FILE_NOT_REGULAR', `${label} file must be a regular file.`, {
        label,
        path: filePath
      })
    };
  }

  const maxBytes = context.maxWorkspaceInputBytes ?? DEFAULT_RESTRICTED_INPUT_MAX_BYTES;
  if (info.size > maxBytes) {
    return {
      ok: false,
      error: inputError('INPUT_FILE_TOO_LARGE', `${label} file is too large.`, {
        label,
        path: filePath,
        max_bytes: maxBytes,
        actual_bytes: info.size
      })
    };
  }

  try {
    return { ok: true, value: await readFile(realFile, 'utf8'), source: 'file', path: realFile };
  } catch (error) {
    return {
      ok: false,
      error: inputError('INPUT_FILE_READ_FAILED', `Could not read ${label} file.`, {
        label,
        path: filePath,
        reason: error.message
      })
    };
  }
}

function hasParentTraversal(filePath) {
  return filePath.split(/[\\/]+/u).includes('..');
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
