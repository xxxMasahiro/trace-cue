import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DASHBOARD_DEFAULT_SETTINGS_PATH = 'ops/DASHBOARD_SETTINGS.json';
export const DASHBOARD_USER_SETTINGS_PATH = 'ops/DASHBOARD_SETTINGS.local.json';
export const DASHBOARD_SETTINGS_PATH = DASHBOARD_DEFAULT_SETTINGS_PATH;

const MAX_SETTINGS_BYTES = 256 * 1024;
const writeQueues = new Map();

export async function readEffectiveDashboardSettings(cwd = process.cwd()) {
  const layers = await readDashboardSettingsLayers(cwd);
  return layers.settings;
}

export async function readDashboardSettingsLayers(cwd = process.cwd()) {
  const root = path.resolve(cwd);
  const shared = await readSettingsFile(root, path.resolve(root, DASHBOARD_DEFAULT_SETTINGS_PATH), { missing: {} });
  const local = await readSettingsFile(root, path.resolve(root, DASHBOARD_USER_SETTINGS_PATH), { missing: {} });
  return {
    shared,
    local,
    settings: enforceSafety(deepMerge(shared, sanitizeLocalSettings(local))),
    storage_status: Object.keys(local).length > 0 ? 'local-settings' : Object.keys(shared).length > 0 ? 'shared-defaults' : 'defaults',
    shared_defaults_path: DASHBOARD_DEFAULT_SETTINGS_PATH,
    local_settings_path: DASHBOARD_USER_SETTINGS_PATH
  };
}

export async function readLocalDashboardSettings(cwd = process.cwd()) {
  const root = path.resolve(cwd);
  return readSettingsFile(root, path.resolve(root, DASHBOARD_USER_SETTINGS_PATH), { missing: {} });
}

export async function writeLocalDashboardSettings(cwd = process.cwd(), settings = {}) {
  const root = path.resolve(cwd);
  return queueSettingsWrite(root, () => writeLocalDashboardSettingsNow(root, settings));
}

export async function updateLocalDashboardSettings(cwd = process.cwd(), update) {
  const root = path.resolve(cwd);
  return queueSettingsWrite(root, async () => {
    const current = await readLocalDashboardSettings(root);
    const next = await update(current);
    return writeLocalDashboardSettingsNow(root, next);
  });
}

async function writeLocalDashboardSettingsNow(root, settings) {
  const settingsPath = path.resolve(root, DASHBOARD_USER_SETTINGS_PATH);
  const safeSettings = enforceSafety(sanitizeLocalSettings(settings));
  const serialized = `${JSON.stringify(safeSettings, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SETTINGS_BYTES) {
    throw settingsError('DASHBOARD_LOCAL_SETTINGS_TOO_LARGE', 'Local dashboard settings exceed the supported size limit.');
  }
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await assertSafeWritePath(root, settingsPath);
  const temporaryPath = `${settingsPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporaryPath, settingsPath);
    await chmod(settingsPath, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  return {
    settings_path: DASHBOARD_USER_SETTINGS_PATH,
    shared_defaults_path: DASHBOARD_DEFAULT_SETTINGS_PATH
  };
}

async function queueSettingsWrite(root, operation) {
  const previous = writeQueues.get(root) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  writeQueues.set(root, current);
  try {
    return await current;
  } finally {
    if (writeQueues.get(root) === current) writeQueues.delete(root);
  }
}

async function readSettingsFile(root, settingsPath, { missing }) {
  try {
    await assertSafeReadPath(root, settingsPath);
    const text = await readFile(settingsPath, 'utf8');
    if (Buffer.byteLength(text, 'utf8') > MAX_SETTINGS_BYTES) {
      throw settingsError('DASHBOARD_SETTINGS_TOO_LARGE', 'Dashboard settings exceed the supported size limit.');
    }
    const parsed = JSON.parse(text);
    if (!isRecord(parsed)) {
      throw settingsError('DASHBOARD_SETTINGS_INVALID', 'Dashboard settings must be a JSON object.');
    }
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return missing;
    throw error;
  }
}

async function assertSafeReadPath(root, settingsPath) {
  const stat = await lstat(settingsPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw settingsError('DASHBOARD_SETTINGS_UNSAFE_PATH', 'Dashboard settings must be a regular workspace file.');
  }
  const [realRoot, realSettings] = await Promise.all([realpath(root), realpath(settingsPath)]);
  if (!isInside(realRoot, realSettings)) {
    throw settingsError('DASHBOARD_SETTINGS_UNSAFE_PATH', 'Dashboard settings must stay inside the workspace.');
  }
}

async function assertSafeWritePath(root, settingsPath) {
  const [realRoot, realParent] = await Promise.all([realpath(root), realpath(path.dirname(settingsPath))]);
  if (!isInside(realRoot, realParent)) {
    throw settingsError('DASHBOARD_SETTINGS_UNSAFE_PATH', 'Local dashboard settings must stay inside the workspace.');
  }
  try {
    const stat = await lstat(settingsPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw settingsError('DASHBOARD_SETTINGS_UNSAFE_PATH', 'Local dashboard settings must be a regular workspace file.');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function isInside(root, target) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

function sanitizeLocalSettings(value) {
  if (!isRecord(value)) return {};
  const result = pick(value, [
    'schema_version', 'kind', 'source_language', 'workflow_language', 'display_locale',
    'ui_locale', 'ui_direction', 'intl_locale', 'selected_at'
  ]);
  if (isRecord(value.profiles)) {
    result.profiles = pick(value.profiles, ['schema_version']);
    if (isRecord(value.profiles.reports)) {
      result.profiles.reports = {};
      if (isRecord(value.profiles.reports.language)) {
        result.profiles.reports.language = pick(value.profiles.reports.language, [
          'schema_version', 'source_language', 'source_language_status', 'output_language_mode',
          'output_language', 'output_language_status', 'explicit_output_language', 'intl_locale',
          'text_direction', 'translation_mode', 'translation_execution_enabled',
          'provider_dispatch_enabled', 'external_sending_enabled', 'body_included', 'diagnostics'
        ]);
      }
    }
    if (isRecord(value.profiles.control_center)) {
      result.profiles.control_center = pick(value.profiles.control_center, [
        'default_viewport', 'ai_suggestions_enabled', 'external_send_confirmation_required'
      ]);
    }
  }
  if (isRecord(value.playwright_test)) {
    result.playwright_test = pick(value.playwright_test, [
      'schema_version', 'integration_version', 'mode', 'selected_at'
    ]);
    if (isRecord(value.playwright_test.external_ci)) {
      result.playwright_test.external_ci = pick(value.playwright_test.external_ci, ['token_storage']);
      if (isRecord(value.playwright_test.external_ci.approved_fetch)) {
        result.playwright_test.external_ci.approved_fetch = pick(value.playwright_test.external_ci.approved_fetch, [
          'provider', 'repo', 'workflow_name', 'branch', 'event', 'conclusion', 'status_filter',
          'artifact_name', 'target_policy', 'head_sha', 'limit', 'max_age_hours', 'token_storage',
          'raw_output_included', 'status', 'approved_at', 'approval_hash'
        ]);
      }
    }
  }
  return result;
}

function enforceSafety(settings) {
  const profiles = isRecord(settings.profiles) ? settings.profiles : {};
  return {
    ...settings,
    profiles: {
      ...profiles,
      safety: {
        provider_execution_allowed_by_settings: false,
        external_send_allowed_by_settings: false,
        mcp_write_execute_allowed_by_settings: false,
        shell_execution_allowed_by_settings: false,
        browser_execution_allowed_by_settings: false,
        translation_execution_allowed_by_settings: false
      },
      ...(isRecord(profiles.control_center) ? {
        control_center: {
          ...profiles.control_center,
          external_send_confirmation_required: true
        }
      } : {})
    },
    persistence: {
      schema_version: settings.persistence?.schema_version ?? '1.0.0',
      active_store: 'local-settings',
      storage: DASHBOARD_USER_SETTINGS_PATH,
      shared_defaults: DASHBOARD_DEFAULT_SETTINGS_PATH,
      repository_persistence_available: true,
      repository_read_available: true,
      repository_write_available: false,
      local_settings_write_available: true,
      settings_write_authority_expanded: false,
      shell_execution_enabled: false,
      provider_dispatch_enabled: false,
      external_sending_enabled: false,
      destructive_execution_enabled: false
    },
    external_send_allowed: false,
    arbitrary_command_entry_allowed: false
  };
}

function deepMerge(base, overlay) {
  const result = isRecord(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(isRecord(overlay) ? overlay : {})) {
    result[key] = isRecord(value) && isRecord(result[key]) ? deepMerge(result[key], value) : value;
  }
  return result;
}

function pick(value, keys) {
  const result = {};
  for (const key of keys) {
    if (Object.hasOwn(value, key)) result[key] = value[key];
  }
  return result;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function settingsError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
