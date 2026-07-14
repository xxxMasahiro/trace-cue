import path from 'node:path';
import { createSafeLocalStore } from './safe-local-store.js';
import {
  applyControlCenterAiSelection,
  createControlCenterAiConnectionRecord,
  emptyControlCenterAiConnectionsProjection,
  projectControlCenterAiConnections,
  validateControlCenterAiConnectionRecord
} from './control-center-ai-connections.js';

const STORE_DIRECTORY = 'control-center-ai-connections';
const STORE_STATE_DIRECTORY = 'state';
const STORE_RECORD = 'connections.json';
const STORE_LOCK = 'connections';
const MAX_RECORD_BYTES = 256 * 1024;

export async function readControlCenterAiConnectionRecord(context = {}) {
  if (context.controlCenterAiConnectionRecord) {
    return validateControlCenterAiConnectionRecord(context.controlCenterAiConnectionRecord, { now: materializeNow(context.now) });
  }
  try {
    const value = await connectionStore(context).readJson(STORE_RECORD, { maxBytes: MAX_RECORD_BYTES });
    return validateControlCenterAiConnectionRecord(value, { now: materializeNow(context.now) });
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, record: null, fresh: false, freshness: 'missing' };
    return {
      ok: false,
      error: {
        code: safeStoreErrorCode(error),
        message: 'Saved AI connection information could not be read.',
        details: {}
      }
    };
  }
}

export async function readControlCenterAiConnectionsProjection(context = {}) {
  const loaded = await readControlCenterAiConnectionRecord(context);
  if (!loaded.ok) {
    return {
      ...emptyControlCenterAiConnectionsProjection(),
      status: 'error',
      status_message: loaded.error.message,
      error_code: loaded.error.code
    };
  }
  return loaded.record
    ? projectControlCenterAiConnections(loaded.record, { now: materializeNow(context.now) })
    : emptyControlCenterAiConnectionsProjection();
}

export async function replaceControlCenterAiConnections({ connections, expectedRevision = 0, selection = null } = {}, context = {}) {
  if (context.controlCenterAiConnectionRecord) {
    return storeError('CONTROL_CENTER_AI_CONNECTION_STORE_READ_ONLY', 'Injected AI connection information cannot be changed.');
  }
  const store = connectionStore(context);
  try {
    return await store.withLock(STORE_LOCK, async () => {
      const current = await readRecordFromStore(store, context);
      if (!current.ok) return current;
      const currentRevision = current.record?.revision ?? 0;
      const currentSettingsRevision = current.record?.settings_revision ?? 0;
      if (normalizeExpectedRevision(expectedRevision) !== currentSettingsRevision) {
        return storeError('CONTROL_CENTER_AI_CONNECTION_REVISION_CONFLICT', 'AI settings were changed in another screen.', {
          expected_revision: normalizeExpectedRevision(expectedRevision),
          current_revision: currentSettingsRevision
        });
      }
      const record = createControlCenterAiConnectionRecord({
        connections,
        previousRevision: currentRevision,
        previousSettingsRevision: currentSettingsRevision,
        observedAt: materializeNow(context.now),
        ttlMs: context.controlCenterAiCapabilityTtlMs,
        selection: selection ?? current.record?.selection ?? null
      });
      await store.writeJson(STORE_RECORD, record, { maxBytes: MAX_RECORD_BYTES });
      return {
        ok: true,
        record,
        projection: projectControlCenterAiConnections(record, { now: materializeNow(context.now) })
      };
    }, { timeoutMs: 5000 });
  } catch (error) {
    return storeError(safeStoreErrorCode(error), 'AI connection information could not be saved.');
  }
}

export async function saveControlCenterAiSelection(input = {}, context = {}) {
  if (context.controlCenterAiConnectionRecord) {
    return storeError('CONTROL_CENTER_AI_CONNECTION_STORE_READ_ONLY', 'Injected AI connection information cannot be changed.');
  }
  const store = connectionStore(context);
  try {
    return await store.withLock(STORE_LOCK, async () => {
      const loaded = await readRecordFromStore(store, context);
      if (!loaded.ok) return loaded;
      if (!loaded.record) return storeError('CONTROL_CENTER_AI_CONNECTION_NOT_CHECKED', 'Update AI availability before choosing an AI service.');
      const expectedRevision = normalizeExpectedRevision(input.expected_revision ?? input.settings_revision);
      if (expectedRevision !== loaded.record.settings_revision) {
        return storeError('CONTROL_CENTER_AI_CONNECTION_REVISION_CONFLICT', 'AI settings were changed in another screen.', {
          expected_revision: expectedRevision,
          current_revision: loaded.record.settings_revision
        });
      }
      const applied = applyControlCenterAiSelection(loaded.record, {
        connection_option_id: input.connection_option_id,
        model_option_id: input.model_option_id,
        effort_option_id: input.effort_option_id,
        capability_revision: input.capability_revision,
        capability_token: input.capability_token
      }, { now: materializeNow(context.now) });
      if (!applied.ok) return applied;
      await store.writeJson(STORE_RECORD, applied.record, { maxBytes: MAX_RECORD_BYTES });
      return {
        ok: true,
        record: applied.record,
        binding: applied.binding,
        projection: projectControlCenterAiConnections(applied.record, { now: materializeNow(context.now) })
      };
    }, { timeoutMs: 5000 });
  } catch (error) {
    return storeError(safeStoreErrorCode(error), 'AI settings could not be saved.');
  }
}

export function controlCenterAiConnectionStoreBoundary() {
  return {
    local_only: true,
    private_store: true,
    repository_tracked: false,
    credential_values_stored: false,
    endpoint_values_stored: false,
    executable_paths_stored: false,
    raw_probe_output_stored: false,
    provider_response_bodies_stored: false,
    cache_authorizes_dispatch: false,
    shell_used: false,
    mcp_execution_exposed: false,
    gate_effect: 'none'
  };
}

async function readRecordFromStore(store, context) {
  try {
    const value = await store.readJson(STORE_RECORD, { maxBytes: MAX_RECORD_BYTES });
    return validateControlCenterAiConnectionRecord(value, { now: materializeNow(context.now) });
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, record: null, fresh: false, freshness: 'missing' };
    return storeError(safeStoreErrorCode(error), 'Saved AI connection information could not be read.');
  }
}

function connectionStore(context) {
  if (typeof context.createControlCenterAiConnectionStore === 'function') {
    return context.createControlCenterAiConnectionStore({
      workspaceRoot: workspaceRoot(context),
      relativeRoot: storeRelativeRoot(context),
      namespace: 'control-center-ai-connections',
      maxRecordBytes: MAX_RECORD_BYTES,
      maxEntries: 8
    });
  }
  return createSafeLocalStore({
    workspaceRoot: workspaceRoot(context),
    relativeRoot: storeRelativeRoot(context),
    namespace: 'control-center-ai-connections',
    maxRecordBytes: MAX_RECORD_BYTES,
    maxEntries: 8
  });
}

function workspaceRoot(context) {
  return path.resolve(context.cwd ?? process.cwd());
}

function storeRelativeRoot(context) {
  const cwd = workspaceRoot(context);
  const artifactRoot = String(context.artifactRoot ?? context['artifact-root'] ?? '.browser-debug').trim() || '.browser-debug';
  if (path.isAbsolute(artifactRoot)) throw new Error('AI connection storage must stay in the workspace.');
  const absolute = path.resolve(cwd, artifactRoot);
  const relative = path.relative(cwd, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('AI connection storage must stay in the workspace.');
  }
  return path.join(relative, STORE_DIRECTORY, STORE_STATE_DIRECTORY);
}

function materializeNow(value) {
  const candidate = typeof value === 'function' ? value() : value;
  const date = candidate instanceof Date ? candidate : candidate ? new Date(candidate) : new Date();
  if (Number.isNaN(date.getTime())) throw new Error('Current time is invalid.');
  return date;
}

function normalizeExpectedRevision(value) {
  const revision = Number(value ?? 0);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : -1;
}

function safeStoreErrorCode(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_]{3,160}$/u.test(error.code)
    ? error.code
    : 'CONTROL_CENTER_AI_CONNECTION_STORE_FAILED';
}

function storeError(code, message, details = {}) {
  return { ok: false, error: { code, message, details } };
}
