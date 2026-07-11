import {
  CONTROL_CENTER_SETTINGS_CONFIRM,
  controlCenterActionBoundary,
  normalizeDashboardSettingsForDisplayLanguage,
  validateDisplayLanguageInput
} from './control-center-actions.js';
import {
  CONTROL_CENTER_PREFERENCES_CONFIRM,
  applyControlCenterPreferences,
  validateControlCenterPreferencesInput
} from './control-center-preferences.js';
import {
  applyPlaywrightTestModeSettings,
  materializeNow,
  normalizePlaywrightTestMode
} from './playwright-test-integration.js';
import {
  DASHBOARD_DEFAULT_SETTINGS_PATH,
  DASHBOARD_USER_SETTINGS_PATH,
  updateLocalDashboardSettings
} from './dashboard-settings-store.js';

export const CONTROL_CENTER_SAVE_SETTINGS_CONFIRM = 'save-control-center-settings';

export async function runControlCenterSaveSettings(input = {}, context = {}) {
  if (String(input.confirm ?? '') !== CONTROL_CENTER_SAVE_SETTINGS_CONFIRM) {
    return settingsError('CONTROL_CENTER_SETTINGS_SAVE_CONFIRM_REQUIRED', 'Control Center settings require explicit save confirmation.');
  }
  const display = validateDisplayLanguageInput({
    locale: input.locale ?? input.display_locale,
    confirm: CONTROL_CENTER_SETTINGS_CONFIRM
  });
  if (!display.ok) return settingsError(display.code, display.message, display.details);
  const playwright = normalizePlaywrightTestMode(input.playwright_mode ?? input.playwrightMode);
  if (!playwright.ok) return settingsError(playwright.code, playwright.message, playwright.details);
  const preferences = validateControlCenterPreferencesInput({
    default_viewport: input.default_viewport ?? input.defaultViewport,
    ai_suggestions_enabled: input.ai_suggestions_enabled ?? input.aiSuggestionsEnabled,
    confirm: CONTROL_CENTER_PREFERENCES_CONFIRM
  });
  if (!preferences.ok) return settingsError(preferences.code, preferences.message, preferences.details);

  const cwd = context.cwd ?? process.cwd();
  try {
    const now = materializeNow(context.now).toISOString();
    await updateLocalDashboardSettings(cwd, (existing) => {
      const withLanguage = normalizeDashboardSettingsForDisplayLanguage(existing, display.locale, now);
      const withPlaywright = applyPlaywrightTestModeSettings(withLanguage, playwright.mode, now);
      return applyControlCenterPreferences(withPlaywright, preferences.preferences);
    });
    return settingsResult({ display, playwright, preferences, now });
  } catch (error) {
    return settingsError('CONTROL_CENTER_SETTINGS_LOCAL_WRITE_FAILED', 'Local Control Center settings could not be saved.', {
      reason: error.message
    });
  }
}

function settingsResult({ display, playwright, preferences, now }) {
  const summary = {
    schema_version: '1.0.0',
    kind: 'control-center-settings-save',
    status: 'applied',
    locale: display.locale,
    playwright_test_mode: playwright.mode,
    default_viewport: preferences.preferences.default_viewport,
    ai_suggestions_enabled: preferences.preferences.ai_suggestions_enabled,
    external_send_confirmation_required: true,
    settings_path: DASHBOARD_USER_SETTINGS_PATH,
    shared_defaults_path: DASHBOARD_DEFAULT_SETTINGS_PATH,
    selected_at: now,
    boundary: controlCenterActionBoundary({
      settings_write: true,
      settings_path_fixed: true,
      atomic_settings_write: true
    })
  };
  return {
    status: 'ok',
    data: { control_center_settings: summary, boundary: summary.boundary },
    warnings: [],
    errors: [],
    artifacts: []
  };
}

function settingsError(code, message, details = {}) {
  return {
    status: 'error',
    data: { control_center_settings: null, boundary: controlCenterActionBoundary() },
    warnings: [],
    errors: [{ code, message, details }],
    artifacts: []
  };
}
