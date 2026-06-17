#!/usr/bin/env node
import { runMcpStdio } from '../src/mcp.js';

await runMcpStdio({
  cwd: process.cwd(),
  env: process.env,
  nodeVersion: process.versions.node,
  stdin: process.stdin,
  stdout: process.stdout
});
