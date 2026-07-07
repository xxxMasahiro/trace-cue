import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runAgenticHumanReviewPropose } from './agentic-human-review.js';
import {
  DASHBOARD_SETTINGS_PATH,
  LANGUAGE_SETTINGS_SCHEMA_VERSION
} from './language-settings.js';
import {
  TRACE_CUE_LOCALE_CODES,
  TRACE_CUE_LOCALE_POLICY,
  getTraceCueIntlLocale,
  getTraceCueLocaleDirection,
  normalizeTraceCueLocale
} from './locale-policy.js';
import { redact } from './redaction.js';

export const CONTROL_CENTER_ACTION_SCHEMA_VERSION = '1.0.0';
export const CONTROL_CENTER_JSON_BODY_LIMIT_BYTES = 64 * 1024;
export const CONTROL_CENTER_SETTINGS_CONFIRM = 'set-control-center-display-language';
export const CONTROL_CENTER_SOURCE_INTAKE_CONFIRM = 'create-source-intake-proposal';
export const CONTROL_CENTER_REVIEW_EFFORTS = Object.freeze(['standard', 'deep', 'xhigh']);
export const CONTROL_CENTER_SOURCE_TYPES = Object.freeze([
  'video',
  'web_page',
  'pdf',
  'meeting_notes',
  'document',
  'transcript',
  'other'
]);

export function controlCenterActionBoundary(overrides = {}) {
  return {
    local_only: true,
    read_dashboard_endpoint_unchanged: true,
    dashboard_read_model_read_only: true,
    provider_call_performed: false,
    api_call_performed: false,
    shell_used: false,
    mcp_execution_exposed: false,
    external_evidence_transfer: false,
    raw_provider_response_stored: false,
    credential_values_recorded: false,
    browser_launched: false,
    gate_effect: 'none',
    ...overrides
  };
}

export function controlCenterActionCapabilities() {
  return {
    schema_version: CONTROL_CENTER_ACTION_SCHEMA_VERSION,
    source_intake: {
      endpoint: '/api/source-intake/proposal',
      method: 'POST',
      confirm: CONTROL_CENTER_SOURCE_INTAKE_CONFIRM,
      supported_efforts: [...CONTROL_CENTER_REVIEW_EFFORTS],
      supported_source_types: [...CONTROL_CENTER_SOURCE_TYPES],
      local_artifact_write: true,
      provider_execution: false,
      shell_execution: false,
      mcp_execution: false,
      external_transfer: false
    },
    display_language: {
      endpoint: '/api/settings/display-language',
      method: 'POST',
      confirm: CONTROL_CENTER_SETTINGS_CONFIRM,
      settings_path: DASHBOARD_SETTINGS_PATH,
      supported_locale_codes: [...TRACE_CUE_LOCALE_CODES],
      supported_locales: TRACE_CUE_LOCALE_POLICY.map((locale) => ({
        code: locale.code,
        native_name: locale.nativeName,
        english_name: locale.englishName,
        intl_locale: locale.intlLocale,
        direction: locale.direction
      })),
      translation_execution: false,
      artifact_output_language_write: false
    },
    boundary: controlCenterActionBoundary({
      action_endpoints_exposed: true,
      bounded_local_settings_write: true,
      bounded_local_artifact_write: true
    })
  };
}

export async function runControlCenterSourceIntakeProposal(input = {}, context = {}) {
  const validation = validateSourceIntakeInput(input);
  if (!validation.ok) {
    return actionError(validation.code, validation.message, validation.details, {
      writes_artifacts: false,
      source_intake: true
    });
  }
  const options = {
    brief: validation.value.review_brief,
    effort: validation.value.review_effort,
    'source-text': validation.value.source_text_file,
    'source-type': validation.value.source_type,
    'content-evidence': validation.value.content_evidence_file,
    'review-index': validation.value.review_index_file,
    'target-audience': validation.value.target_audience,
    'expected-impression': validation.value.expected_impression
  };
  const result = await runAgenticHumanReviewPropose(compactObject(options), context);
  if (result.status !== 'ok') {
    return {
      status: 'error',
      data: {
        source_intake: null,
        boundary: controlCenterActionBoundary({
          source_intake: true,
          writes_artifacts: false
        })
      },
      warnings: result.warnings ?? [],
      errors: result.errors ?? [],
      artifacts: []
    };
  }
  const proposal = result.data?.agentic_human_review_proposal ?? {};
  const sourceText = proposal.source_text_preview ?? {};
  const summary = {
    schema_version: CONTROL_CENTER_ACTION_SCHEMA_VERSION,
    kind: 'control-center-source-intake-proposal',
    status: 'proposal_ready',
    status_label: 'Proposal ready',
    review_effort: validation.value.review_effort,
    requested_source_type: validation.value.source_type,
    resolved_source_type: sourceText.source_type ?? validation.value.source_type,
    source_text: {
      supplied: true,
      file_name: path.basename(validation.value.source_text_file),
      full_text_stored: false,
      chunk_text_stored: false,
      char_count: sourceText.text_stats?.char_count ?? null,
      line_count: sourceText.text_stats?.line_count ?? null,
      chunk_count: sourceText.text_stats?.chunk_count ?? null
    },
    review_request: {
      brief_excerpt: proposal.source_request?.brief_excerpt ?? '',
      target_audience: proposal.structured_intent?.target_audience ?? null,
      expected_impression: proposal.structured_intent?.expected_impression ?? null
    },
    artifact_summary: {
      artifact_count: Array.isArray(result.artifacts) ? result.artifacts.length : 0,
      types: Array.isArray(result.artifacts) ? result.artifacts.map((artifact) => artifact.type) : [],
      paths_hidden_in_normal_ui: true
    },
    next_safe_action: 'Review the local proposal, then create an approved plan before any provider run.',
    safety: {
      local_artifact_write: true,
      provider_call_performed: false,
      api_call_performed: false,
      shell_used: false,
      mcp_execution_exposed: false,
      external_evidence_transfer: false,
      raw_source_text_stored: false,
      raw_provider_response_stored: false,
      gate_effect: 'none'
    },
    boundary: controlCenterActionBoundary({
      source_intake: true,
      writes_artifacts: true,
      planning_only: true
    })
  };
  return {
    status: 'ok',
    data: {
      source_intake: redact(summary),
      boundary: summary.boundary
    },
    warnings: result.warnings ?? [],
    errors: [],
    artifacts: result.artifacts ?? []
  };
}

export async function runControlCenterSetDisplayLanguage(input = {}, context = {}) {
  const validation = validateDisplayLanguageInput(input);
  if (!validation.ok) {
    return actionError(validation.code, validation.message, validation.details, {
      settings_write: false,
      display_language: true
    });
  }
  const cwd = context.cwd ?? process.cwd();
  const settingsPath = path.resolve(cwd, DASHBOARD_SETTINGS_PATH);
  const existing = await readDashboardSettings(settingsPath);
  const now = materializeNow(context.now).toISOString();
  const locale = validation.locale;
  const next = normalizeDashboardSettingsForDisplayLanguage(existing, locale, now);
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  const summary = {
    schema_version: CONTROL_CENTER_ACTION_SCHEMA_VERSION,
    kind: 'control-center-display-language-settings',
    status: 'applied',
    locale,
    intl_locale: getTraceCueIntlLocale(locale),
    text_direction: getTraceCueLocaleDirection(locale),
    settings_path: DASHBOARD_SETTINGS_PATH,
    selected_at: now,
    translation_execution_enabled: false,
    artifact_output_language_changed: false,
    source_evidence_language_changed: false,
    boundary: controlCenterActionBoundary({
      display_language: true,
      settings_write: true,
      settings_path_fixed: true,
      translation_execution_enabled: false
    })
  };
  return {
    status: 'ok',
    data: {
      display_language: summary,
      boundary: summary.boundary
    },
    warnings: [],
    errors: [],
    artifacts: []
  };
}

function validateSourceIntakeInput(input) {
  const confirm = String(input.confirm ?? '').trim();
  if (confirm !== CONTROL_CENTER_SOURCE_INTAKE_CONFIRM) {
    return validationFailure('CONTROL_CENTER_SOURCE_INTAKE_CONFIRM_REQUIRED', 'Source intake requires explicit local proposal confirmation.', {
      confirm_required: CONTROL_CENTER_SOURCE_INTAKE_CONFIRM
    });
  }
  const sourceTextFile = normalizePathField(input.source_text_file ?? input.sourceTextFile);
  if (!sourceTextFile.ok) {
    return sourceTextFile;
  }
  const brief = boundedText(input.review_brief ?? input.brief, 1200);
  if (!brief) {
    return validationFailure('CONTROL_CENTER_SOURCE_INTAKE_BRIEF_REQUIRED', 'Source intake requires a review brief.', {});
  }
  const effort = normalizeChoice(input.review_effort ?? input.effort, CONTROL_CENTER_REVIEW_EFFORTS, 'standard');
  if (!effort.ok) {
    return effort;
  }
  const sourceType = normalizeChoice(input.source_type ?? input.sourceType, CONTROL_CENTER_SOURCE_TYPES, 'other');
  if (!sourceType.ok) {
    return sourceType;
  }
  const contentEvidenceFile = optionalPathField(input.content_evidence_file ?? input.contentEvidenceFile);
  if (!contentEvidenceFile.ok) {
    return contentEvidenceFile;
  }
  const reviewIndexFile = optionalPathField(input.review_index_file ?? input.reviewIndexFile);
  if (!reviewIndexFile.ok) {
    return reviewIndexFile;
  }
  return {
    ok: true,
    value: {
      source_text_file: sourceTextFile.value,
      source_type: sourceType.value,
      review_brief: brief,
      review_effort: effort.value,
      content_evidence_file: contentEvidenceFile.value,
      review_index_file: reviewIndexFile.value,
      target_audience: boundedText(input.target_audience ?? input.targetAudience, 300),
      expected_impression: boundedText(input.expected_impression ?? input.expectedImpression, 300)
    }
  };
}

function validateDisplayLanguageInput(input) {
  const confirm = String(input.confirm ?? '').trim();
  if (confirm !== CONTROL_CENTER_SETTINGS_CONFIRM) {
    return validationFailure('CONTROL_CENTER_DISPLAY_LANGUAGE_CONFIRM_REQUIRED', 'Display language changes require explicit confirmation.', {
      confirm_required: CONTROL_CENTER_SETTINGS_CONFIRM
    });
  }
  const raw = String(input.locale ?? input.ui_locale ?? input.display_locale ?? '').trim();
  const locale = normalizeTraceCueLocale(raw, '');
  if (!raw || !locale || !TRACE_CUE_LOCALE_CODES.includes(locale)) {
    return validationFailure('CONTROL_CENTER_DISPLAY_LANGUAGE_UNSUPPORTED', 'Display language must be one of the supported control-center locales.', {
      requested_locale: raw,
      supported_locale_codes: [...TRACE_CUE_LOCALE_CODES]
    });
  }
  return { ok: true, locale };
}

function normalizeDashboardSettingsForDisplayLanguage(existing, locale, selectedAt) {
  const reportsLanguage = existing.profiles?.reports?.language ?? {};
  return {
    ...existing,
    schema_version: existing.schema_version ?? LANGUAGE_SETTINGS_SCHEMA_VERSION,
    kind: existing.kind ?? 'dashboard-settings',
    source_language: existing.source_language ?? 'en',
    workflow_language: locale,
    display_locale: locale,
    ui_locale: locale,
    ui_direction: getTraceCueLocaleDirection(locale),
    intl_locale: getTraceCueIntlLocale(locale),
    selected_at: selectedAt,
    profiles: {
      ...(existing.profiles ?? {}),
      schema_version: existing.profiles?.schema_version ?? LANGUAGE_SETTINGS_SCHEMA_VERSION,
      reports: {
        ...(existing.profiles?.reports ?? {}),
        language: {
          ...reportsLanguage,
          schema_version: reportsLanguage.schema_version ?? LANGUAGE_SETTINGS_SCHEMA_VERSION
        }
      },
      safety: {
        ...(existing.profiles?.safety ?? {}),
        provider_execution_allowed_by_settings: false,
        external_send_allowed_by_settings: false,
        mcp_write_execute_allowed_by_settings: false,
        shell_execution_allowed_by_settings: false,
        browser_execution_allowed_by_settings: false,
        translation_execution_allowed_by_settings: false
      }
    },
    persistence: {
      ...(existing.persistence ?? {}),
      schema_version: existing.persistence?.schema_version ?? LANGUAGE_SETTINGS_SCHEMA_VERSION,
      active_store: 'repository-settings',
      storage: DASHBOARD_SETTINGS_PATH,
      repository_persistence_available: true,
      repository_read_available: true,
      repository_write_available: true,
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

async function readDashboardSettings(settingsPath) {
  try {
    return JSON.parse(await readFile(settingsPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    return {
      schema_version: LANGUAGE_SETTINGS_SCHEMA_VERSION,
      kind: 'dashboard-settings',
      source_language: 'en',
      ui_locale: 'en',
      display_locale: 'en',
      profiles: {
        reports: {
          language: {
            source_language: 'auto',
            output_language_mode: 'source',
            output_language: null,
            translation_mode: 'none'
          }
        }
      }
    };
  }
}

function normalizePathField(value) {
  const text = String(value ?? '').trim();
  if (!text) {
    return validationFailure('CONTROL_CENTER_SOURCE_PATH_REQUIRED', 'Choose a workspace-relative source text file.', {});
  }
  if (text === '-' || text.startsWith('@') || path.isAbsolute(text) || text.includes('\0') || text.split(/[\\/]+/u).includes('..')) {
    return validationFailure('CONTROL_CENTER_SOURCE_PATH_REJECTED', 'Source paths must stay inside the workspace and must not use indirection.', {
      path: text
    });
  }
  return { ok: true, value: text.replace(/\\/gu, '/') };
}

function optionalPathField(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return { ok: true, value: undefined };
  }
  return normalizePathField(value);
}

function normalizeChoice(value, allowed, fallback) {
  const normalized = String(value ?? fallback).trim() || fallback;
  if (!allowed.includes(normalized)) {
    return validationFailure('CONTROL_CENTER_UNSUPPORTED_CHOICE', 'Unsupported control-center choice.', {
      value: normalized,
      supported_values: allowed
    });
  }
  return { ok: true, value: normalized };
}

function boundedText(value, maxLength) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, maxLength);
}

function validationFailure(code, message, details) {
  return { ok: false, code, message, details };
}

function actionError(code, message, details, boundaryOverrides = {}) {
  return {
    status: 'error',
    data: {
      boundary: controlCenterActionBoundary(boundaryOverrides)
    },
    warnings: [],
    errors: [{ code, message, details: details ?? {} }],
    artifacts: []
  };
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

function materializeNow(now) {
  const value = typeof now === 'function' ? now() : now;
  if (value instanceof Date) {
    return value;
  }
  if (value) {
    return new Date(value);
  }
  return new Date();
}
