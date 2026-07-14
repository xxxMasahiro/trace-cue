import { runControlCenterAgenticReviewRepeat } from '../../src/control-center-agentic-review-actions.js';

const [cwd, operationId, idempotencyKey] = process.argv.slice(2);
const result = await runControlCenterAgenticReviewRepeat({
  operation_id: operationId,
  mode: 'recheck',
  idempotency_key: idempotencyKey
}, {
  cwd,
  now: () => new Date('2026-07-14T00:00:00.000Z'),
  scheduleBackground() {}
});

const data = result.data?.control_center_agentic_review;
process.stdout.write(`${JSON.stringify({
  status: result.status,
  operation_id: data?.operation?.id ?? null,
  background_work_started: data?.background_work_started ?? null,
  idempotent_replay: data?.idempotent_replay ?? null,
  error_code: result.errors?.[0]?.code ?? null
})}\n`);
process.exitCode = result.status === 'ok' ? 0 : 1;
