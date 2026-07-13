import { access, writeFile } from 'node:fs/promises';
import { completeControlCenterIntake } from '../../src/control-center-intake.js';
import { createSafeLocalStore } from '../../src/safe-local-store.js';

const DEFAULT_BARRIER_TIMEOUT_MS = 15_000;
const [
  cwd,
  id,
  mode,
  readyPath,
  releasePath,
  executionMarker,
  barrierTimeoutInput,
  completionTimeoutInput
] = process.argv.slice(2);
const requestedBarrierTimeoutMs = Number(barrierTimeoutInput);
const barrierTimeoutMs = Number.isInteger(requestedBarrierTimeoutMs) && requestedBarrierTimeoutMs > 0
  ? requestedBarrierTimeoutMs
  : DEFAULT_BARRIER_TIMEOUT_MS;
const requestedCompletionTimeoutMs = Number(completionTimeoutInput);
let firstCompletionLock = true;
const context = { cwd };
if (Number.isInteger(requestedCompletionTimeoutMs) && requestedCompletionTimeoutMs > 0) {
  context.intakeCompletionLockTimeoutMs = requestedCompletionTimeoutMs;
}
if (mode) {
  context.createControlCenterIntakeStore = (options) => {
    const store = createSafeLocalStore(options);
    return {
      ...store,
      async withLock(lockName, task, lockOptions) {
        if (lockName !== `intake-complete-${id}` || !firstCompletionLock) {
          return store.withLock(lockName, task, lockOptions);
        }
        firstCompletionLock = false;
        if (mode === 'pause-before-completion' || mode === 'pause-before-invalid-completion') {
          await writeFile(readyPath, 'ready\n', 'utf8');
          await waitForFile(releasePath, barrierTimeoutMs);
          return store.withLock(lockName, task, lockOptions);
        }
        if (mode === 'signal-completion-entry') {
          return store.withLock(lockName, async () => {
            await writeFile(readyPath, 'ready\n', 'utf8');
            return task();
          }, lockOptions);
        }
        if (mode === 'pause-at-completion-entry') {
          return store.withLock(lockName, async () => {
            await writeFile(readyPath, 'ready\n', 'utf8');
            await waitForFile(releasePath, barrierTimeoutMs);
            return task();
          }, lockOptions);
        }
        return store.withLock(lockName, task, lockOptions);
      }
    };
  };
}
if (executionMarker) {
  context.executeIntake = async () => {
    await writeFile(executionMarker, `${mode || 'uncoordinated'}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    });
    return {
      status: 'ok',
      data: {
        source_intake: {
          status: 'proposal_ready',
          source_text: { char_count: 29, chunk_count: 1 }
        }
      },
      warnings: [],
      errors: [],
      artifacts: []
    };
  };
}

const result = await completeControlCenterIntake({
  intake_id: id,
  purpose: mode === 'pause-before-invalid-completion' ? '' : 'Confirm the next improvement.',
  effort: 'standard'
}, context);

if (result.status === 'ok') {
  const completion = result.data.control_center_intake;
  const role = completion.already_completed === true ? 'existing' : 'owner';
  process.stdout.write(`ok:${completion.result.id}:${role}\n`);
  process.exitCode = 0;
} else {
  const error = result.errors?.[0];
  const retryState = error?.details?.same_intake_retry_available === true
    ? 'retryable'
    : 'not-retryable';
  process.stdout.write(`${error?.code ?? 'error'}:${retryState}\n`);
  process.exitCode = 3;
}

async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(file);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error('Timed out waiting for the test coordination barrier.');
}
