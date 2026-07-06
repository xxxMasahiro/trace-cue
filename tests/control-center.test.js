import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { request } from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildControlCenterReadModel,
  controlCenterBoundary,
  executeCli,
  getSchema,
  runControlCenterStatus,
  startControlCenterServer
} from '../src/api.js';
import { parseCliArgs } from '../src/parser.js';

const fixedNow = '2026-06-17T00:00:00.000Z';

test('control-center status builds a read-only local read model', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-control-center-'));

  const parsed = parseCliArgs(['control-center', 'status', '--json']);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, 'control-center status');

  const executeOption = parseCliArgs(['control-center', 'status', '--execute', '--json']);
  assert.equal(executeOption.ok, false);
  assert.equal(executeOption.error.code, 'UNSUPPORTED_CONTROL_CENTER_OPTION');

  const result = await executeCli(['control-center', 'status', '--json'], { cwd, now: fixedNow });
  assert.equal(result.exitCode, 0);
  const body = JSON.parse(result.stdout);
  assert.equal(body.command, 'control-center status');
  assert.equal(body.data.control_center.schema_version, '0.1.0');
  assert.equal(body.data.control_center.generated_at, fixedNow);
  assert.equal(body.data.control_center.status, 'empty');
  assert.equal(body.data.control_center.review.visual_review.status, 'empty');
  assert.equal(body.data.control_center.review.trust_safety.read_only, true);
  assert.equal(body.data.control_center.boundary.read_only, true);
  assert.equal(body.data.control_center.boundary.writes_artifacts, false);
  assert.equal(body.data.control_center.boundary.provider_call_performed, false);
  assert.equal(body.data.control_center.boundary.raw_pixels_read, false);
  assert.equal(body.data.control_center.boundary.mcp_write_execute_exposed, false);
  assert.equal(body.data.control_center.gate_effect, 'none');
  assert.equal(JSON.stringify(body.data).includes('raw provider response'), false);

  const direct = await runControlCenterStatus({}, { cwd, now: fixedNow });
  assert.equal(direct.status, 'ok');
  assert.equal(direct.data.boundary.browser_launched, false);
  assert.deepEqual(controlCenterBoundary().gate_effect, 'none');

  const model = await buildControlCenterReadModel({}, { cwd, now: fixedNow });
  assert.equal(model.setup_safety.language_settings.translation_execution_enabled, false);
  assert.equal(model.setup_safety.mcp.execution_tools_exposed, false);
});

test('control-center schema is exported through the local schema registry', () => {
  const schema = getSchema('control_center_read_model');
  assert.equal(schema.title, 'TraceCue Control Center Read Model');
  assert.equal(schema.properties.boundary.properties.read_only.const, true);
  assert.equal(schema.properties.boundary.properties.provider_call_performed.const, false);
});

test('control-center appearance is controlled by the product design-system files', async () => {
  const designSystem = await readFile('control-center/src/designSystem.js', 'utf8');
  const styles = await readFile('control-center/src/styles.css', 'utf8');
  const tokenFile = await readFile('docs/design-system/tokens.json', 'utf8');
  const componentFile = await readFile('docs/design-system/components.json', 'utf8');
  const tokenData = JSON.parse(tokenFile);
  const componentData = JSON.parse(componentFile);

  assert.match(designSystem, /docs\/design-system\/tokens\.json/);
  assert.match(designSystem, /docs\/design-system\/components\.json/);
  assert.ok(componentData.components.some((component) => component.id === 'control-center-shell'));

  for (const tokenName of Object.keys(tokenData.tokens.color)) {
    assert.match(designSystem, new RegExp(`--tc-color-${tokenName}`));
  }
  assert.match(designSystem, /--tc-font-ui/);
  assert.match(designSystem, /--tc-font-mono/);
  assert.match(styles, /var\(--tc-color-surface\)/);
  assert.match(styles, /var\(--tc-color-success\)/);
  assert.match(styles, /\.app-shell[\s\S]*font-family: var\(--tc-font-ui\)/);
  assert.doesNotMatch(styles, /#[0-9a-fA-F]{3,8}\b/);
});

test('control-center server is loopback GET-only and no-store', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-control-center-server-'));
  const started = await startControlCenterServer({ port: 0 }, { cwd, now: fixedNow });
  try {
    assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal(started.metadata.local_only, true);
    assert.equal(started.metadata.action_api_exposed, false);

    const health = await fetch(new URL('/api/health', started.url));
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('cache-control'), 'no-store');
    const healthBody = await health.json();
    assert.equal(healthBody.read_only, true);

    const dashboard = await fetch(new URL('/api/dashboard', started.url));
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.headers.get('cache-control'), 'no-store');
    const dashboardBody = await dashboard.json();
    assert.equal(dashboardBody.command, 'control-center status');
    assert.equal(dashboardBody.data.control_center.boundary.read_only, true);

    const post = await fetch(new URL('/api/dashboard', started.url), { method: 'POST' });
    assert.equal(post.status, 405);

    const invalidOrigin = await fetch(new URL('/api/health', started.url), {
      headers: { Origin: 'https://example.invalid' }
    });
    assert.equal(invalidOrigin.status, 403);

    const root = await fetch(started.url);
    assert.equal(root.status, 503);
  } finally {
    await closeServer(started.server);
  }
});

test('control-center server rejects non-loopback hosts before listening', async () => {
  await assert.rejects(
    startControlCenterServer({ host: '0.0.0.0', port: 0 }, { now: fixedNow }),
    /loopback host/
  );
});

test('control-center server rejects non-loopback Host headers', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-control-center-host-'));
  const started = await startControlCenterServer({ port: 0 }, { cwd, now: fixedNow });
  try {
    const response = await httpRequest({
      hostname: '127.0.0.1',
      port: started.config.port,
      path: '/api/health',
      method: 'GET',
      headers: { Host: 'example.invalid' }
    });
    assert.equal(response.statusCode, 403);
    assert.match(response.body, /Host header/);
  } finally {
    await closeServer(started.server);
  }
});

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function httpRequest(options) {
  return new Promise((resolve, reject) => {
    const req = request(options, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, headers: res.headers, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}
