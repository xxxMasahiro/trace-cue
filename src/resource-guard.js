import { collectResourceStatus } from './resource-status.js';

const RESOURCE_GUARD_MODES = new Set(['advisory', 'fail-critical', 'off']);

export function normalizeResourceGuardMode(value) {
  if (value === undefined || value === null || value === '') {
    return 'advisory';
  }
  const mode = String(value).trim();
  if (!RESOURCE_GUARD_MODES.has(mode)) {
    throw new Error('Resource guard must be one of: advisory, fail-critical, off.');
  }
  return mode;
}

export function createResourceGuard(options = {}, context = {}, now = () => new Date()) {
  const mode = normalizeResourceGuardMode(options['resource-guard']);
  const checks = [];
  const warnings = [];
  if (mode !== 'off' && (options.screenshot || options.trace)) {
    warnings.push({
      code: 'RESOURCE_GUARD_HEAVY_ARTIFACTS',
      message: 'Screenshot or trace capture can increase local memory and artifact pressure.',
      details: {
        screenshot: Boolean(options.screenshot),
        trace: Boolean(options.trace),
        recommendation: 'Use resource guard output and artifact sizing to split heavy browser work when local headroom is limited.'
      }
    });
  }

  return {
    mode,
    checks,
    async check(stage, details = {}) {
      if (mode === 'off') {
        return null;
      }
      const collect = context.collectResourceStatus ?? collectResourceStatus;
      const resourceStatus = await collect(context);
      const check = resourceGuardCheck(resourceStatus, {
        stage,
        details,
        now
      });
      checks.push(check);
      warnings.push(...warningsForCheck(check));
      return check;
    },
    shouldStop(check) {
      return mode === 'fail-critical' && check?.status === 'critical';
    },
    summary() {
      return resourceGuardSummary({
        mode,
        checks,
        warnings,
        enabled: mode !== 'off'
      });
    }
  };
}

export function resourceGuardSummary({ mode, checks = [], warnings = [], enabled = true }) {
  const status = checks.some((check) => check.status === 'critical')
    ? 'critical'
    : checks.some((check) => check.status === 'watch')
      ? 'watch'
      : checks.length === 0
        ? (enabled ? 'not_checked' : 'off')
        : 'ok';
  return {
    mode,
    enabled,
    status,
    checks,
    warnings,
    stop_on_critical: mode === 'fail-critical',
    boundary: {
      local_only: true,
      browser_launched_by_guard: false,
      external_upload: false,
      profile_reuse: false,
      system_cache_mutated: false,
      swap_mutated: false,
      cache_deleted: false,
      privileged_helper_used: false,
      shell_used: false
    }
  };
}

function resourceGuardCheck(resourceStatus, { stage, details, now }) {
  return {
    stage,
    status: resourceStatus.status,
    observed_at: materializeNow(now).toISOString(),
    source: resourceStatus.source,
    recommended_action: resourceStatus.recommended_action,
    details,
    memory: {
      available_bytes: resourceStatus.memory.available_bytes,
      available_ratio: resourceStatus.memory.available_ratio,
      swap_used_bytes: resourceStatus.memory.swap_used_bytes,
      swap_used_ratio: resourceStatus.memory.swap_used_ratio
    },
    cgroup: {
      available: resourceStatus.cgroup.available,
      current_bytes: resourceStatus.cgroup.current_bytes,
      limit_bytes: resourceStatus.cgroup.limit_bytes,
      usage_ratio: resourceStatus.cgroup.usage_ratio
    },
    pressure: {
      available: resourceStatus.pressure.available,
      some_avg10: resourceStatus.pressure.some?.avg10 ?? null,
      full_avg10: resourceStatus.pressure.full?.avg10 ?? null
    }
  };
}

function warningsForCheck(check) {
  if (check.status === 'critical') {
    return [{
      code: 'RESOURCE_GUARD_CRITICAL',
      message: 'Local memory or swap pressure is critical for browser-heavy work.',
      details: {
        stage: check.stage,
        recommended_action: check.recommended_action
      }
    }];
  }
  if (check.status === 'watch') {
    return [{
      code: 'RESOURCE_GUARD_WATCH',
      message: 'Local memory or swap pressure is elevated for browser-heavy work.',
      details: {
        stage: check.stage,
        recommended_action: check.recommended_action
      }
    }];
  }
  return [];
}

function materializeNow(now) {
  if (!now) {
    return new Date();
  }
  const value = typeof now === 'function' ? now() : now;
  return value instanceof Date ? value : new Date(value);
}
