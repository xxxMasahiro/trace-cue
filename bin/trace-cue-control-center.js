#!/usr/bin/env node
import { runCli } from '../src/cli.js';
import { PRODUCT_IDENTITY } from '../src/product-identity.js';

process.exitCode = await runCli(['control-center', 'launch', ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  invokedBinName: PRODUCT_IDENTITY.controlCenterBinName,
  nodeVersion: process.versions.node,
  stderr: process.stderr,
  stdout: process.stdout
});
