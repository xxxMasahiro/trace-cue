import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const pidFile = process.argv[2];
if (!pidFile) process.exit(2);

const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  detached: true,
  stdio: 'ignore'
});
await writeFile(pidFile, `${child.pid}\n`, { mode: 0o600 });
setInterval(() => {}, 1000);
