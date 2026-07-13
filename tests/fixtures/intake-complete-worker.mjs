import { completeControlCenterIntake } from '../../src/control-center-intake.js';

const [cwd, id] = process.argv.slice(2);
const result = await completeControlCenterIntake({
  intake_id: id,
  purpose: 'Confirm the next improvement.',
  effort: 'standard'
}, { cwd });

if (result.status === 'ok') {
  process.stdout.write('ok\n');
  process.exitCode = 0;
} else {
  process.stdout.write(`${result.errors?.[0]?.code ?? 'error'}\n`);
  process.exitCode = 3;
}
