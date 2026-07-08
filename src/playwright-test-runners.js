import { spawn } from 'node:child_process';

export function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        child.kill('SIGTERM');
      }
    }, options.timeoutMs ?? 120000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code, signal) => {
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    child.on('error', (error) => {
      settled = true;
      clearTimeout(timer);
      resolve({ code: 127, signal: null, stdout, stderr: error.message });
    });
  });
}

export async function runGhReadOnly(argv, options = {}) {
  const validation = validateGhReadOnlyArgv(argv);
  if (!validation.ok) {
    return {
      ok: false,
      code: validation.code,
      message: validation.message,
      details: validation.details
    };
  }
  const runner = options.runner ?? runCommand;
  const env = {
    ...process.env,
    ...options.env,
    GH_PROMPT_DISABLED: '1',
    NO_COLOR: '1'
  };
  const result = await runner('gh', argv, {
    cwd: options.cwd,
    env,
    timeoutMs: options.timeoutMs ?? 120000
  });
  return { ok: true, result };
}

export function validateGhReadOnlyArgv(argv = []) {
  const args = argv.map(String);
  if (args[0] !== 'run') {
    return fail('PLAYWRIGHT_TEST_GH_COMMAND_REJECTED', 'Only gh run commands are allowed.');
  }
  const action = args[1];
  if (!['list', 'view', 'download'].includes(action)) {
    return fail('PLAYWRIGHT_TEST_GH_COMMAND_REJECTED', 'Only gh run list, view, and download are allowed.', { action });
  }
  const forbidden = ['--jq', '--template', '--web', '--log', '--log-failed', '--exit-status', '--pattern'];
  for (const option of forbidden) {
    if (args.includes(option)) {
      return fail('PLAYWRIGHT_TEST_GH_OPTION_REJECTED', `gh ${option} is not allowed for Playwright Test external CI.`, { option });
    }
  }
  if (action === 'list' || action === 'view') {
    if (!args.includes('--json')) {
      return fail('PLAYWRIGHT_TEST_GH_JSON_REQUIRED', 'gh run list/view must use fixed JSON output.');
    }
  }
  if (action === 'download') {
    const runId = args[2];
    if (!/^\d+$/.test(runId ?? '')) {
      return fail('PLAYWRIGHT_TEST_GH_RUN_ID_REQUIRED', 'gh run download requires a numeric run id.');
    }
    if (!args.includes('--name') || !args.includes('--dir')) {
      return fail('PLAYWRIGHT_TEST_GH_DOWNLOAD_BOUNDED_OPTIONS_REQUIRED', 'gh run download requires exact --name and --dir.');
    }
  }
  return { ok: true };
}

function fail(code, message, details = {}) {
  return { ok: false, code, message, details };
}
