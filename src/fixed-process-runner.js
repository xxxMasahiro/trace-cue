import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const TERMINATION_GRACE_MS = 750;
const DESCENDANT_CAPTURE_LIMIT = 4096;
const THREAD_CAPTURE_LIMIT = 1024;

export async function runFixedProcess({
  executable,
  args = [],
  cwd,
  env = {},
  stdin = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxStdoutBytes = DEFAULT_MAX_OUTPUT_BYTES,
  maxStderrBytes = DEFAULT_MAX_OUTPUT_BYTES,
  signal = null,
  inheritedFds = [],
  containDescendants = false,
  spawnImpl = nodeSpawn,
  platform = process.platform
} = {}) {
  const validated = validateInput({ executable, args, cwd, env, stdin, timeoutMs, maxStdoutBytes, maxStderrBytes, inheritedFds, containDescendants, platform });
  if (!validated.ok) return validated;
  if (signal?.aborted) return failure('FIXED_PROCESS_ABORTED', 'The operation was cancelled before it started.', false);

  return new Promise((resolve) => {
    let child;
    let spawned = false;
    let closed = false;
    let settled = false;
    let stopReason = null;
    let terminationStarted = false;
    let descendantSnapshot = [];
    let containmentConfirmed = true;
    let stopTimer = null;
    let containmentRefreshTimer = null;
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(stopTimer);
      clearTimeout(containmentRefreshTimer);
      signal?.removeEventListener?.('abort', onAbort);
      resolve(result);
    };
    const terminate = (reason) => {
      if (!stopReason) stopReason = reason;
      if (!spawned || closed || terminationStarted) return;
      terminationStarted = true;
      if (validated.containDescendants) {
        const captured = captureOwnedLinuxDescendants(child.pid);
        descendantSnapshot = captured.processes;
        containmentConfirmed = captured.ok;
        signalCapturedProcesses(descendantSnapshot, 'SIGTERM');
        containmentRefreshTimer = setTimeout(() => {
          const refreshed = captureOwnedLinuxDescendants(child.pid);
          descendantSnapshot = mergeCapturedProcesses(descendantSnapshot, refreshed.processes);
          containmentConfirmed = containmentConfirmed && refreshed.ok;
          signalCapturedProcesses(descendantSnapshot, 'SIGTERM');
        }, 25);
        containmentRefreshTimer.unref?.();
      }
      killProcessGroup(child, 'SIGTERM', platform);
      stopTimer = setTimeout(() => {
        if (validated.containDescendants) {
          const refreshed = captureOwnedLinuxDescendants(child.pid);
          descendantSnapshot = mergeCapturedProcesses(descendantSnapshot, refreshed.processes);
          containmentConfirmed = containmentConfirmed && refreshed.ok;
        }
        signalCapturedProcesses(descendantSnapshot, 'SIGKILL');
        if (!closed) killProcessGroup(child, 'SIGKILL', platform);
      }, TERMINATION_GRACE_MS);
      stopTimer.unref?.();
    };
    const collect = (target, chunk, kind) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (kind === 'stdout') stdoutBytes += buffer.length;
      else stderrBytes += buffer.length;
      const limit = kind === 'stdout' ? validated.maxStdoutBytes : validated.maxStderrBytes;
      const total = kind === 'stdout' ? stdoutBytes : stderrBytes;
      if (total > limit) {
        terminate(kind === 'stdout' ? 'stdout_limit' : 'stderr_limit');
        return;
      }
      target.push(buffer);
    };
    const onAbort = () => terminate('aborted');
    signal?.addEventListener?.('abort', onAbort, { once: true });

    let timeout = setTimeout(() => terminate('timeout'), validated.timeoutMs);
    timeout.unref?.();
    try {
      child = spawnImpl(validated.executable, validated.args, {
        cwd: validated.cwd,
        env: validated.env,
        shell: false,
        detached: platform !== 'win32',
        windowsHide: true,
        stdio: [validated.stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe', ...validated.inheritedFds]
      });
    } catch (error) {
      finish(failure('FIXED_PROCESS_SPAWN_FAILED', 'The fixed process could not be started.', false, safeErrorKind(error)));
      return;
    }
    child.once('spawn', () => {
      spawned = true;
      if (validated.stdin !== null) {
        child.stdin.once('error', () => {});
        child.stdin.end(validated.stdin);
      }
      if (stopReason) terminate(stopReason);
    });
    child.stdout?.on('data', (chunk) => collect(stdout, chunk, 'stdout'));
    child.stderr?.on('data', (chunk) => collect(stderr, chunk, 'stderr'));
    child.once('error', (error) => {
      if (!spawned) finish(failure('FIXED_PROCESS_SPAWN_FAILED', 'The fixed process could not be started.', false, safeErrorKind(error)));
      else terminate('process_error');
    });
    child.once('close', (code, closeSignal) => {
      closed = true;
      if (terminationStarted && validated.containDescendants) {
        signalCapturedProcesses(descendantSnapshot, 'SIGKILL');
      }
      if (stopReason && !containmentConfirmed) {
        finish(failure('FIXED_PROCESS_CONTAINMENT_UNCONFIRMED', 'The fixed process stopped without confirmed descendant containment.', spawned));
        return;
      }
      if (stopReason === 'timeout') {
        finish(failure('FIXED_PROCESS_TIMEOUT', 'The fixed process timed out.', spawned));
        return;
      }
      if (stopReason === 'aborted') {
        finish(failure('FIXED_PROCESS_ABORTED', 'The fixed process was cancelled.', spawned));
        return;
      }
      if (stopReason === 'stdout_limit' || stopReason === 'stderr_limit') {
        finish(failure('FIXED_PROCESS_OUTPUT_LIMIT', 'The fixed process returned too much data.', spawned, stopReason));
        return;
      }
      if (stopReason === 'process_error') {
        finish(failure('FIXED_PROCESS_FAILED', 'The fixed process failed.', spawned));
        return;
      }
      const stdoutBuffer = Buffer.concat(stdout, stdoutBytes);
      const stderrBuffer = Buffer.concat(stderr, stderrBytes);
      if (code !== 0 || closeSignal) {
        finish({
          ...failure('FIXED_PROCESS_EXIT_FAILED', 'The fixed process did not complete successfully.', spawned),
          exit_code: Number.isInteger(code) ? code : null,
          exit_signal: typeof closeSignal === 'string' ? closeSignal : null,
          stdout_bytes: stdoutBytes,
          stderr_bytes: stderrBytes
        });
        return;
      }
      finish({
        ok: true,
        stdout: stdoutBuffer,
        stderr: stderrBuffer,
        stdout_bytes: stdoutBytes,
        stderr_bytes: stderrBytes,
        process_started: spawned,
        shell_used: false
      });
    });
  });
}

function validateInput({ executable, args, cwd, env, stdin, timeoutMs, maxStdoutBytes, maxStderrBytes, inheritedFds, containDescendants, platform }) {
  if (platform === 'win32') return failure('FIXED_PROCESS_PLATFORM_UNSUPPORTED', 'This fixed process adapter requires a native POSIX runtime.', false);
  if (typeof executable !== 'string' || !executable.startsWith('/') || /\.(?:exe|cmd|bat)$/iu.test(executable)) {
    return failure('FIXED_PROCESS_EXECUTABLE_INVALID', 'The fixed executable is invalid.', false);
  }
  if (!Array.isArray(args) || args.length > 512 || args.some((item) => typeof item !== 'string' || item.length > 4096 || item.includes('\u0000'))) {
    return failure('FIXED_PROCESS_ARGUMENTS_INVALID', 'The fixed process arguments are invalid.', false);
  }
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) return failure('FIXED_PROCESS_CWD_INVALID', 'The fixed process working directory is invalid.', false);
  if (!env || typeof env !== 'object' || Array.isArray(env)
    || Object.entries(env).some(([key, value]) => !/^[A-Z_][A-Z0-9_]*$/u.test(key) || typeof value !== 'string' || value.includes('\u0000'))) {
    return failure('FIXED_PROCESS_ENV_INVALID', 'The fixed process environment is invalid.', false);
  }
  if (!Array.isArray(inheritedFds)
    || inheritedFds.length > 8
    || inheritedFds.some((fd) => !Number.isSafeInteger(fd) || fd < 0)
    || new Set(inheritedFds).size !== inheritedFds.length) {
    return failure('FIXED_PROCESS_FILE_DESCRIPTORS_INVALID', 'The inherited file descriptors are invalid.', false);
  }
  if (typeof containDescendants !== 'boolean' || (containDescendants && platform !== 'linux')) {
    return failure('FIXED_PROCESS_CONTAINMENT_UNSUPPORTED', 'Descendant containment requires the supported Linux runtime.', false);
  }
  const input = stdin === null ? null : Buffer.isBuffer(stdin) ? stdin : Buffer.from(String(stdin), 'utf8');
  if (input && input.length > MAX_INPUT_BYTES) return failure('FIXED_PROCESS_INPUT_LIMIT', 'The fixed process input is too large.', false);
  const normalizedTimeout = boundedInteger(timeoutMs, 100, 10 * 60 * 1000, DEFAULT_TIMEOUT_MS);
  const normalizedStdout = boundedInteger(maxStdoutBytes, 1024, 32 * 1024 * 1024, DEFAULT_MAX_OUTPUT_BYTES);
  const normalizedStderr = boundedInteger(maxStderrBytes, 1024, 4 * 1024 * 1024, DEFAULT_MAX_OUTPUT_BYTES);
  return {
    ok: true,
    executable,
    args: [...args],
    cwd,
    env: { ...env },
    inheritedFds: [...inheritedFds],
    containDescendants,
    stdin: input,
    timeoutMs: normalizedTimeout,
    maxStdoutBytes: normalizedStdout,
    maxStderrBytes: normalizedStderr
  };
}

function captureOwnedLinuxDescendants(rootPid) {
  if (!Number.isInteger(rootPid) || rootPid <= 0 || typeof process.getuid !== 'function') return { ok: false, processes: [] };
  const expectedUid = process.getuid();
  const processes = [];
  const seen = new Set([rootPid]);
  const pending = [rootPid];
  while (pending.length) {
    const parent = pending.pop();
    let children = [];
    try {
      const tasks = readdirSync(`/proc/${parent}/task`, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name));
      if (tasks.length > THREAD_CAPTURE_LIMIT) return { ok: false, processes };
      for (const task of tasks) {
        const taskChildren = readFileSync(`/proc/${parent}/task/${task.name}/children`, 'utf8')
          .trim().split(/\s+/u).filter(Boolean).map(Number);
        children.push(...taskChildren);
        if (children.length > DESCENDANT_CAPTURE_LIMIT) return { ok: false, processes };
      }
    } catch {
      if (!existsSync(`/proc/${parent}`)) continue;
      return { ok: false, processes };
    }
      for (const pid of children) {
        if (!Number.isInteger(pid) || pid <= 1 || seen.has(pid)) continue;
        seen.add(pid);
        if (seen.size > DESCENDANT_CAPTURE_LIMIT + 1) return { ok: false, processes };
        const identity = readLinuxProcessIdentity(pid);
        if (!identity) {
          if (!existsSync(`/proc/${pid}`)) continue;
          return { ok: false, processes };
        }
        if (identity.uid !== expectedUid) return { ok: false, processes };
        processes.push(identity);
        pending.push(pid);
      }
  }
  return { ok: true, processes };
}

function mergeCapturedProcesses(left, right) {
  const merged = new Map();
  for (const identity of [...left, ...right]) merged.set(`${identity.pid}:${identity.startTime}`, identity);
  return [...merged.values()].slice(0, DESCENDANT_CAPTURE_LIMIT);
}

function readLinuxProcessIdentity(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const uidMatch = status.match(/^Uid:\s+(\d+)/mu);
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const suffix = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
    const processGroup = Number(suffix[2]);
    const startTime = suffix[19];
    if (!uidMatch || !Number.isInteger(processGroup) || processGroup <= 1 || !/^\d+$/u.test(startTime ?? '')) return null;
    return { pid, uid: Number(uidMatch[1]), processGroup, startTime };
  } catch {
    return null;
  }
}

function signalCapturedProcesses(processes, signal) {
  const signalledGroups = new Set();
  for (const captured of [...processes].reverse()) {
    const current = readLinuxProcessIdentity(captured.pid);
    if (!current || current.uid !== captured.uid || current.startTime !== captured.startTime) continue;
    try {
      if (current.processGroup === captured.processGroup && !signalledGroups.has(current.processGroup)) {
        process.kill(-current.processGroup, signal);
        signalledGroups.add(current.processGroup);
      } else {
        process.kill(current.pid, signal);
      }
    } catch {}
  }
}

function killProcessGroup(child, signal, platform) {
  try {
    if (platform !== 'win32' && Number.isInteger(child?.pid) && child.pid > 0) {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {}
  try { child?.kill?.(signal); } catch {}
}

function boundedInteger(value, min, max, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : fallback;
}

function failure(code, message, processStarted, reason = null) {
  return {
    ok: false,
    error: { code, message, details: reason ? { reason } : {} },
    process_started: processStarted === true,
    dispatch_may_have_occurred: processStarted === true,
    shell_used: false,
    raw_output_stored: false
  };
}

function safeErrorKind(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_]{2,80}$/u.test(error.code) ? error.code : 'process_error';
}
