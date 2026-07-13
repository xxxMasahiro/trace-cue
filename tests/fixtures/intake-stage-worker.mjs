import { Readable } from 'node:stream';
import { stageControlCenterIntake } from '../../src/control-center-intake.js';

const [cwd, requestedBytes, totalBytes] = process.argv.slice(2);
const bytes = Number(requestedBytes);
const result = await stageControlCenterIntake({
  sourceKind: 'document_text',
  originalName: 'notes.txt',
  contentType: 'text/plain',
  contentLength: bytes
}, Readable.from([Buffer.alloc(bytes, 0x61)]), {
  cwd,
  intakeTotalBytes: Number(totalBytes),
  intakeMaxEntries: 10
});

if (result.status === 'ok') {
  process.stdout.write('ok\n');
  process.exitCode = 0;
} else {
  process.stdout.write(`${result.errors?.[0]?.code ?? 'error'}\n`);
  process.exitCode = 3;
}
