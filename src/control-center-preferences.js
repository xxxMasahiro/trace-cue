import { redact } from './redaction.js';
import {
  readEffectiveDashboardSettings,
  updateLocalDashboardSettings
} from './dashboard-settings-store.js';

export const CONTROL_CENTER_PREFERENCES_CONFIRM = 'save-control-center-preferences';
export const CONTROL_CENTER_REVIEW_VIEWPORTS = Object.freeze(['both', 'desktop', 'mobile']);

const DEFAULT_PREFERENCES = Object.freeze({
  default_viewport: 'both',
  ai_suggestions_enabled: true,
  external_send_confirmation_required: true
});

export async function readControlCenterPreferences(context = {}) {
  const cwd = context.cwd ?? process.cwd();
  const settings = await readEffectiveDashboardSettings(cwd);
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
  const validation = validateControlCenterPreferencesInput(input);
  if (!validation.ok) return preferenceError(validation.code, validation.message);

  const cwd = context.cwd ?? process.cwd();
  const preferences = validation.preferences;
  try {
    await updateLocalDashboardSettings(cwd, (existing) => applyControlCenterPreferences(existing, preferences));
  } catch (error) {
    return preferenceError('CONTROL_CENTER_PREFERENCES_SETTINGS_UNREADABLE', 'Control Center settings could not be read.');
  }
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

export function validateControlCenterPreferencesInput(input = {}) {
  if (String(input.confirm ?? '') !== CONTROL_CENTER_PREFERENCES_CONFIRM) {
    return { ok: false, code: 'CONTROL_CENTER_PREFERENCES_CONFIRM_REQUIRED', message: 'Control Center settings require explicit save confirmation.' };
  }
  const defaultViewport = String(input.default_viewport ?? input.defaultViewport ?? '').trim();
  if (!CONTROL_CENTER_REVIEW_VIEWPORTS.includes(defaultViewport)) {
    return { ok: false, code: 'CONTROL_CENTER_PREFERENCES_VIEWPORT_UNSUPPORTED', message: 'The usual review screen setting is not supported.' };
  }
  if (typeof input.ai_suggestions_enabled !== 'boolean' && typeof input.aiSuggestionsEnabled !== 'boolean') {
    return { ok: false, code: 'CONTROL_CENTER_PREFERENCES_AI_SETTING_REQUIRED', message: 'The AI suggestions setting must be true or false.' };
  }
  return {
    ok: true,
    preferences: {
      default_viewport: defaultViewport,
      ai_suggestions_enabled: input.ai_suggestions_enabled ?? input.aiSuggestionsEnabled,
      external_send_confirmation_required: true
    }
  };
}

export function applyControlCenterPreferences(existing, preferences) {
  return {
    ...existing,
    profiles: {
      ...(existing.profiles ?? {}),
      control_center: { ...preferences, external_send_confirmation_required: true }
    }
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
