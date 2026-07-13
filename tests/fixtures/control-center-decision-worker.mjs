import { runControlCenterAgenticReviewDecision } from '../../src/control-center-agentic-review-actions.js';

const [cwd, id] = process.argv.slice(2);
const result = await runControlCenterAgenticReviewDecision({
  operation_id: id,
  finding_id: 'finding-1',
  decision: 'later'
}, { cwd });

if (result.status === 'ok') {
  process.stdout.write('ok\n');
  process.exitCode = 0;
} else {
  process.stdout.write(`${result.errors?.[0]?.code ?? 'error'}\n`);
  process.exitCode = 3;
}
