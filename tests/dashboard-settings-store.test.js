import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  CONTROL_CENTER_SAVE_SETTINGS_CONFIRM,
  DASHBOARD_DEFAULT_SETTINGS_PATH,
  DASHBOARD_USER_SETTINGS_PATH,
  readDashboardSettingsLayers,
  readEffectiveDashboardSettings,
  runControlCenterSaveSettings,
  updateLocalDashboardSettings
} from '../src/api.js';

const fixedNow = '2026-07-12T00:00:00.000Z';

test('local dashboard settings overlay shared defaults without changing the tracked file', async () => {
  const cwd = await workspace();
  const sharedPath = path.join(cwd, DASHBOARD_DEFAULT_SETTINGS_PATH);
  const before = await readFile(sharedPath, 'utf8');
  const saved = await runControlCenterSaveSettings({
    locale: 'ja',
    playwright_mode: 'import_only',
    default_viewport: 'mobile',
    ai_suggestions_enabled: false,
    confirm: CONTROL_CENTER_SAVE_SETTINGS_CONFIRM
  }, { cwd, now: fixedNow });
  assert.equal(saved.status, 'ok');
  assert.equal(saved.data.control_center_settings.settings_path, DASHBOARD_USER_SETTINGS_PATH);
  assert.equal(await readFile(sharedPath, 'utf8'), before);

  const settings = await readEffectiveDashboardSettings(cwd);
  assert.equal(settings.ui_locale, 'ja');
  assert.equal(settings.playwright_test.mode, 'import_only');
  assert.equal(settings.profiles.control_center.default_viewport, 'mobile');
  assert.equal(settings.profiles.control_center.ai_suggestions_enabled, false);
  assert.equal(settings.profiles.control_center.external_send_confirmation_required, true);
  assert.equal(settings.persistence.repository_write_available, false);
  assert.equal(settings.persistence.storage, DASHBOARD_USER_SETTINGS_PATH);
  assert.equal((await stat(path.join(cwd, DASHBOARD_USER_SETTINGS_PATH))).mode & 0o777, 0o600);
});

test('local settings cannot enable execution or disable external-send confirmation', async () => {
  const cwd = await workspace();
  await writeFile(path.join(cwd, DASHBOARD_USER_SETTINGS_PATH), JSON.stringify({
    profiles: {
      safety: {
        provider_execution_allowed_by_settings: true,
        shell_execution_allowed_by_settings: true
      },
      control_center: {
        default_viewport: 'desktop',
        ai_suggestions_enabled: true,
        external_send_confirmation_required: false
      }
    },
    persistence: { repository_write_available: true },
    external_send_allowed: true,
    arbitrary_command_entry_allowed: true
  }), 'utf8');
  const settings = await readEffectiveDashboardSettings(cwd);
  assert.equal(settings.profiles.safety.provider_execution_allowed_by_settings, false);
  assert.equal(settings.profiles.safety.shell_execution_allowed_by_settings, false);
  assert.equal(settings.profiles.control_center.external_send_confirmation_required, true);
  assert.equal(settings.persistence.repository_write_available, false);
  assert.equal(settings.external_send_allowed, false);
  assert.equal(settings.arbitrary_command_entry_allowed, false);
});

test('malformed or symlinked local settings fail closed and are not overwritten', async () => {
  const malformedCwd = await workspace();
  const localPath = path.join(malformedCwd, DASHBOARD_USER_SETTINGS_PATH);
  await writeFile(localPath, '{invalid', 'utf8');
  const result = await runControlCenterSaveSettings({
    locale: 'en',
    playwright_mode: 'disabled',
    default_viewport: 'both',
    ai_suggestions_enabled: true,
    confirm: CONTROL_CENTER_SAVE_SETTINGS_CONFIRM
  }, { cwd: malformedCwd, now: fixedNow });
  assert.equal(result.status, 'error');
  assert.equal(await readFile(localPath, 'utf8'), '{invalid');

  const symlinkCwd = await workspace();
  const external = path.join(await mkdtemp(path.join(tmpdir(), 'trace-cue-settings-external-')), 'settings.json');
  await writeFile(external, '{}\n', 'utf8');
  await symlink(external, path.join(symlinkCwd, DASHBOARD_USER_SETTINGS_PATH));
  await assert.rejects(() => readDashboardSettingsLayers(symlinkCwd), /regular workspace file/);
});

test('serialized local updates preserve independent settings branches', async () => {
  const cwd = await workspace();
  await Promise.all([
    updateLocalDashboardSettings(cwd, async (current) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { ...current, ui_locale: 'ja', display_locale: 'ja' };
    }),
    updateLocalDashboardSettings(cwd, (current) => ({
      ...current,
      profiles: {
        ...(current.profiles ?? {}),
        control_center: {
          default_viewport: 'mobile',
          ai_suggestions_enabled: false,
          external_send_confirmation_required: true
        }
      }
    }))
  ]);
  const settings = await readEffectiveDashboardSettings(cwd);
  assert.equal(settings.ui_locale, 'ja');
  assert.equal(settings.profiles.control_center.default_viewport, 'mobile');
});

async function workspace() {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-dashboard-settings-'));
  await mkdir(path.join(cwd, 'ops'), { recursive: true });
  await writeFile(path.join(cwd, DASHBOARD_DEFAULT_SETTINGS_PATH), `${JSON.stringify({
    schema_version: '1.0.0',
    kind: 'dashboard-settings',
    display_locale: 'en',
    ui_locale: 'en',
    profiles: {
      reports: { language: { source_language: 'auto', output_language_mode: 'source' } },
      control_center: {
        default_viewport: 'both',
        ai_suggestions_enabled: true,
        external_send_confirmation_required: true
      }
    }
  }, null, 2)}\n`, 'utf8');
  return cwd;
}
