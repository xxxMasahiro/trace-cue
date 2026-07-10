import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DASHBOARD_SETTINGS_PATH } from './language-settings.js';
import { redact } from './redaction.js';

export const CONTROL_CENTER_PREFERENCES_CONFIRM = 'save-control-center-preferences';
export const CONTROL_CENTER_REVIEW_VIEWPORTS = Object.freeze(['both', 'desktop', 'mobile']);

const DEFAULT_PREFERENCES = Object.freeze({
  default_viewport: 'both',
  ai_suggestions_enabled: true,
  external_send_confirmation_required: true
});

export async function readControlCenterPreferences(context = {}) {
  const cwd = path.resolve(context.cwd ?? process.cwd());
  const settingsPath = path.resolve(cwd, DASHBOARD_SETTINGS_PATH);
  let settings = {};
  try {
    settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const stored = settings?.profiles?.control_center ?? {};
  return Object.freeze({
    default_viewport: CONTROL_CENTER_REVIEW_VIEWPORTS.includes(stored.default_viewport)
      ? stored.default_viewport
      : DEFAULT_PREFERENCES.default_viewport,
    ai_suggestions_enabled: stored.ai_suggestions_enabled !== false,
    external_send_confirmation_required: true
  });
}

export async function runControlCenterSetPreferences(input = {}, context = {}) {
  if (String(input.confirm ?? '') !== CONTROL_CENTER_PREFERENCES_CONFIRM) {
    return preferenceError('CONTROL_CENTER_PREFERENCES_CONFIRM_REQUIRED', 'Control Center settings require explicit save confirmation.');
  }
  const defaultViewport = String(input.default_viewport ?? input.defaultViewport ?? '').trim();
  if (!CONTROL_CENTER_REVIEW_VIEWPORTS.includes(defaultViewport)) {
    return preferenceError('CONTROL_CENTER_PREFERENCES_VIEWPORT_UNSUPPORTED', 'The usual review screen setting is not supported.');
  }
  if (typeof input.ai_suggestions_enabled !== 'boolean' && typeof input.aiSuggestionsEnabled !== 'boolean') {
    return preferenceError('CONTROL_CENTER_PREFERENCES_AI_SETTING_REQUIRED', 'The AI suggestions setting must be true or false.');
  }

  const cwd = path.resolve(context.cwd ?? process.cwd());
  const settingsPath = path.resolve(cwd, DASHBOARD_SETTINGS_PATH);
  let existing = {};
  try {
    existing = JSON.parse(await readFile(settingsPath, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return preferenceError('CONTROL_CENTER_PREFERENCES_SETTINGS_UNREADABLE', 'Control Center settings could not be read.');
    }
  }
  const preferences = {
    default_viewport: defaultViewport,
    ai_suggestions_enabled: input.ai_suggestions_enabled ?? input.aiSuggestionsEnabled,
    external_send_confirmation_required: true
  };
  const next = {
    ...existing,
    profiles: {
      ...(existing.profiles ?? {}),
      control_center: preferences
    }
  };
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');

  return {
    status: 'ok',
    data: {
      control_center_preferences: redact({
        ...preferences,
        write_confirm: CONTROL_CENTER_PREFERENCES_CONFIRM,
        boundary: preferenceBoundary({ settings_write: true })
      })
    },
    warnings: [],
    errors: [],
    artifacts: []
  };
}

export function controlCenterPreferenceSummary(preferences = DEFAULT_PREFERENCES) {
  return {
    default_viewport: preferences.default_viewport ?? DEFAULT_PREFERENCES.default_viewport,
    supported_viewports: [...CONTROL_CENTER_REVIEW_VIEWPORTS],
    ai_suggestions_enabled: preferences.ai_suggestions_enabled !== false,
    external_send_confirmation_required: true,
    external_send_confirmation_mutable: false,
    write_confirm: CONTROL_CENTER_PREFERENCES_CONFIRM,
    boundary: preferenceBoundary()
  };
}

function preferenceError(code, message) {
  return {
    status: 'error',
    data: {
      control_center_preferences: null,
      boundary: preferenceBoundary()
    },
    warnings: [],
    errors: [{ code, message, details: {} }],
    artifacts: []
  };
}

function preferenceBoundary(overrides = {}) {
  return {
    local_only: true,
    settings_write: false,
    provider_call_performed: false,
    external_evidence_transfer: false,
    credential_values_read: false,
    credential_values_recorded: false,
    external_send_confirmation_required: true,
    external_send_confirmation_mutable: false,
    shell_used: false,
    mcp_execution_exposed: false,
    gate_effect: 'none',
    ...overrides
  };
}
