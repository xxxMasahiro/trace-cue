#!/usr/bin/env node
import { parseMcpServerArgs, runMcpStdio } from '../src/mcp.js';
import { runMcpHttp } from '../src/mcp-http-transport.js';
import { PRODUCT_IDENTITY } from '../src/product-identity.js';

const parsed = parseMcpServerArgs(process.argv.slice(2), process.env);
if (!parsed.ok) {
  process.stderr.write(`${parsed.message}\n`);
  process.exit(2);
}
if (parsed.help) {
  process.stdout.write([
    `Usage: ${PRODUCT_IDENTITY.mcpBinName} [--profile safe|full|admin]`,
    `       ${PRODUCT_IDENTITY.mcpBinName} --transport http --profile safe --host 127.0.0.1 --port 0`,
    '',
    'HTTP transport requires a bearer token in BROWSER_DEBUG_MCP_HTTP_TOKEN.',
    'The default transport remains stdio for compatibility.'
  ].join('\n'));
  process.stdout.write('\n');
  process.exit(0);
}

const context = {
  cwd: process.cwd(),
  env: process.env,
  mcpProfile: parsed.profile,
  nodeVersion: process.versions.node,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr
};

if (parsed.transport === 'http') {
  await runMcpHttp(parsed, context);
} else {
  await runMcpStdio(context);
}
