import { access, writeFile } from 'node:fs/promises';
import { completeControlCenterIntake } from '../../src/control-center-intake.js';

const [cwd, id, mode, readyPath, releasePath, unexpectedPath] = process.argv.slice(2);

const result = await completeControlCenterIntake({
  intake_id: id,
  purpose: 'Confirm the next improvement.',
  effort: 'standard'
}, {
  cwd,
  intakeActiveResultEntries: 1,
  intakeCompletionLockTimeoutMs: 5000,
  intakePublicationLeaseTtlMs: 200,
  intakePublicationLeaseRenewIntervalMs: 50,
  async executeIntake() {
    if (mode !== 'owner') {
      await writeFile(unexpectedPath, 'duplicate execution\n', 'utf8');
    }
    await writeFile(readyPath, `${mode}\n`, 'utf8');
    if (mode === 'owner') {
      while (true) {
        try {
          await access(releasePath);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
    }
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
  }
});

process.stdout.write(`${result.status}:${result.errors?.[0]?.code ?? 'ok'}\n`);
process.exitCode = result.status === 'ok' ? 0 : 3;
