#!/usr/bin/env node
import { checkRepositoryCi } from './lib/verification-ci.mjs';

checkRepositoryCi().then((result) => {
  process.stdout.write(`Verification CI contract passed (${result.jobs.length} jobs, final=${result.final_job}).\n`);
}).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
