import { readFile } from 'node:fs/promises';
import path from 'node:path';

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
