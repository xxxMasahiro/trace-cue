import { createSafeLocalStore } from '../../src/safe-local-store.js';

const [workspaceRoot, holdInput, timeoutInput] = process.argv.slice(2);
const holdMs = Number(holdInput);
const timeoutMs = Number(timeoutInput);
const store = createSafeLocalStore({
  workspaceRoot,
  relativeRoot: '.browser-debug/cross-process-lock-test',
  namespace: 'cross-process-lock-test'
});

try {
  await store.withLock('shared', async () => {
    process.stdout.write('acquired\n');
    await new Promise((resolve) => setTimeout(resolve, holdMs));
  }, { timeoutMs });
  process.stdout.write('released\n');
} catch (error) {
  process.stdout.write(`error:${error?.code ?? 'UNKNOWN'}\n`);
  process.exitCode = 2;
}
