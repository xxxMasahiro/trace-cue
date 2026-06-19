#!/usr/bin/env node
import { parseMcpServerArgs, runMcpStdio } from '../src/mcp.js';

const parsed = parseMcpServerArgs(process.argv.slice(2), process.env);
if (!parsed.ok) {
  process.stderr.write(`${parsed.message}\n`);
  process.exit(2);
}
if (parsed.help) {
  process.stdout.write('Usage: browser-debug-mcp [--profile safe|full|admin]\n');
  process.exit(0);
}

await runMcpStdio({
  cwd: process.cwd(),
  env: process.env,
  mcpProfile: parsed.profile,
  nodeVersion: process.versions.node,
  stdin: process.stdin,
  stdout: process.stdout
});
