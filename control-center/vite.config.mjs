import { defineConfig } from 'vite';
import { createEnvelope } from '../src/envelope.js';
import { runControlCenterStatus, controlCenterBoundary } from '../src/control-center-read-model.js';
import {
  CONTROL_CENTER_JSON_BODY_LIMIT_BYTES,
  runControlCenterPlaywrightTestExternalCiApproveSettings,
  runControlCenterPlaywrightTestExternalCiFetch,
  runControlCenterPlaywrightTestExternalCiFetchApproved,
  runControlCenterPlaywrightTestExternalCiSuggestSettings,
  runControlCenterPlaywrightTestImport,
  runControlCenterSetPlaywrightTestMode,
  runControlCenterSetDisplayLanguage,
  runControlCenterSourceIntakeProposal
} from '../src/control-center-actions.js';

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function controlCenterApiPlugin() {
  return {
    name: 'trace-cue-control-center-api',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/api/health') {
          if (request.method !== 'GET') {
            sendJson(response, 405, { error: { code: 'CONTROL_CENTER_HEALTH_GET_ONLY', message: 'control-center health only accepts GET requests.' } });
            return;
          }
          sendJson(response, 200, {
            status: 'ok',
            local_only: true,
            read_only: true,
            boundary: controlCenterBoundary()
          });
          return;
        }
        if (url.pathname === '/api/dashboard') {
          if (request.method !== 'GET') {
            sendJson(response, 405, { error: { code: 'CONTROL_CENTER_DASHBOARD_GET_ONLY', message: 'control-center dashboard only accepts GET requests.' } });
            return;
          }
          const result = await runControlCenterStatus({}, { cwd: process.cwd() });
          const envelope = createEnvelope({
            command: 'control-center status',
            status: result.status,
            data: result.data,
            warnings: result.warnings,
            errors: result.errors,
            artifacts: result.artifacts
          });
          sendJson(response, result.status === 'ok' ? 200 : 500, envelope);
          return;
        }
        if (url.pathname === '/api/source-intake/proposal') {
          if (request.method !== 'POST') {
            sendJson(response, 405, { error: { code: 'CONTROL_CENTER_SOURCE_INTAKE_POST_ONLY', message: 'control-center source intake only accepts POST requests.' } });
            return;
          }
          const body = await readJsonRequestBody(request);
          if (!body.ok) {
            sendJson(response, body.status, { error: { code: body.code, message: body.message, details: body.details ?? {} } });
            return;
          }
          const result = await runControlCenterSourceIntakeProposal(body.value, { cwd: process.cwd() });
          const envelope = createEnvelope({
            command: 'control-center source-intake proposal',
            status: result.status,
            data: result.data,
            warnings: result.warnings,
            errors: result.errors,
            artifacts: result.artifacts
          });
          sendJson(response, result.status === 'ok' ? 200 : 400, envelope);
          return;
        }
        if (url.pathname === '/api/settings/display-language') {
          if (request.method !== 'POST') {
            sendJson(response, 405, { error: { code: 'CONTROL_CENTER_DISPLAY_LANGUAGE_POST_ONLY', message: 'control-center display language settings only accept POST requests.' } });
            return;
          }
          const body = await readJsonRequestBody(request);
          if (!body.ok) {
            sendJson(response, body.status, { error: { code: body.code, message: body.message, details: body.details ?? {} } });
            return;
          }
          const result = await runControlCenterSetDisplayLanguage(body.value, { cwd: process.cwd() });
          const envelope = createEnvelope({
            command: 'control-center settings display-language',
            status: result.status,
            data: result.data,
            warnings: result.warnings,
            errors: result.errors,
            artifacts: result.artifacts
          });
          sendJson(response, result.status === 'ok' ? 200 : 400, envelope);
          return;
        }
        if (url.pathname === '/api/playwright-test/mode') {
          if (request.method !== 'POST') {
            sendJson(response, 405, { error: { code: 'CONTROL_CENTER_PLAYWRIGHT_TEST_MODE_POST_ONLY', message: 'control-center Playwright Test mode only accepts POST requests.' } });
            return;
          }
          const body = await readJsonRequestBody(request);
          if (!body.ok) {
            sendJson(response, body.status, { error: { code: body.code, message: body.message, details: body.details ?? {} } });
            return;
          }
          const result = await runControlCenterSetPlaywrightTestMode(body.value, { cwd: process.cwd() });
          const envelope = createEnvelope({
            command: 'control-center playwright-test mode',
            status: result.status,
            data: result.data,
            warnings: result.warnings,
            errors: result.errors,
            artifacts: result.artifacts
          });
          sendJson(response, result.status === 'ok' ? 200 : 400, envelope);
          return;
        }
        if (url.pathname === '/api/playwright-test/import') {
          if (request.method !== 'POST') {
            sendJson(response, 405, { error: { code: 'CONTROL_CENTER_PLAYWRIGHT_TEST_IMPORT_POST_ONLY', message: 'control-center Playwright Test import only accepts POST requests.' } });
            return;
          }
          const body = await readJsonRequestBody(request);
          if (!body.ok) {
            sendJson(response, body.status, { error: { code: body.code, message: body.message, details: body.details ?? {} } });
            return;
          }
          const result = await runControlCenterPlaywrightTestImport(body.value, { cwd: process.cwd() });
          const envelope = createEnvelope({
            command: 'control-center playwright-test import',
            status: result.status,
            data: result.data,
            warnings: result.warnings,
            errors: result.errors,
            artifacts: result.artifacts
          });
          sendJson(response, result.status === 'ok' ? 200 : 400, envelope);
          return;
        }
        if (url.pathname === '/api/playwright-test/external-ci/fetch') {
          if (request.method !== 'POST') {
            sendJson(response, 405, { error: { code: 'CONTROL_CENTER_PLAYWRIGHT_TEST_EXTERNAL_CI_FETCH_POST_ONLY', message: 'control-center Playwright Test CI fetch only accepts POST requests.' } });
            return;
          }
          const body = await readJsonRequestBody(request);
          if (!body.ok) {
            sendJson(response, body.status, { error: { code: body.code, message: body.message, details: body.details ?? {} } });
            return;
          }
          const result = await runControlCenterPlaywrightTestExternalCiFetch(body.value, { cwd: process.cwd() });
          const envelope = createEnvelope({
            command: 'control-center playwright-test external-ci fetch',
            status: result.status,
            data: result.data,
            warnings: result.warnings,
            errors: result.errors,
            artifacts: result.artifacts
          });
          sendJson(response, result.status === 'ok' ? 200 : 400, envelope);
          return;
        }
        if (url.pathname === '/api/playwright-test/external-ci/suggest-settings') {
          if (request.method !== 'POST') {
            sendJson(response, 405, { error: { code: 'CONTROL_CENTER_PLAYWRIGHT_TEST_EXTERNAL_CI_SUGGEST_SETTINGS_POST_ONLY', message: 'control-center Playwright Test CI settings suggestion only accepts POST requests.' } });
            return;
          }
          const body = await readJsonRequestBody(request);
          if (!body.ok) {
            sendJson(response, body.status, { error: { code: body.code, message: body.message, details: body.details ?? {} } });
            return;
          }
          const result = await runControlCenterPlaywrightTestExternalCiSuggestSettings(body.value, { cwd: process.cwd() });
          const envelope = createEnvelope({
            command: 'control-center playwright-test external-ci suggest-settings',
            status: result.status,
            data: result.data,
            warnings: result.warnings,
            errors: result.errors,
            artifacts: result.artifacts
          });
          sendJson(response, result.status === 'ok' ? 200 : 400, envelope);
          return;
        }
        if (url.pathname === '/api/playwright-test/external-ci/approve-settings') {
          if (request.method !== 'POST') {
            sendJson(response, 405, { error: { code: 'CONTROL_CENTER_PLAYWRIGHT_TEST_EXTERNAL_CI_APPROVE_SETTINGS_POST_ONLY', message: 'control-center Playwright Test CI settings approval only accepts POST requests.' } });
            return;
          }
          const body = await readJsonRequestBody(request);
          if (!body.ok) {
            sendJson(response, body.status, { error: { code: body.code, message: body.message, details: body.details ?? {} } });
            return;
          }
          const result = await runControlCenterPlaywrightTestExternalCiApproveSettings(body.value, { cwd: process.cwd() });
          const envelope = createEnvelope({
            command: 'control-center playwright-test external-ci approve-settings',
            status: result.status,
            data: result.data,
            warnings: result.warnings,
            errors: result.errors,
            artifacts: result.artifacts
          });
          sendJson(response, result.status === 'ok' ? 200 : 400, envelope);
          return;
        }
        if (url.pathname === '/api/playwright-test/external-ci/fetch-approved') {
          if (request.method !== 'POST') {
            sendJson(response, 405, { error: { code: 'CONTROL_CENTER_PLAYWRIGHT_TEST_EXTERNAL_CI_FETCH_APPROVED_POST_ONLY', message: 'control-center Playwright Test approved CI fetch only accepts POST requests.' } });
            return;
          }
          const body = await readJsonRequestBody(request);
          if (!body.ok) {
            sendJson(response, body.status, { error: { code: body.code, message: body.message, details: body.details ?? {} } });
            return;
          }
          const result = await runControlCenterPlaywrightTestExternalCiFetchApproved(body.value, { cwd: process.cwd() });
          const envelope = createEnvelope({
            command: 'control-center playwright-test external-ci fetch-approved',
            status: result.status,
            data: result.data,
            warnings: result.warnings,
            errors: result.errors,
            artifacts: result.artifacts
          });
          sendJson(response, result.status === 'ok' ? 200 : 400, envelope);
          return;
        }
        next();
      });
    }
  };
}

async function readJsonRequestBody(request) {
  const contentType = String(request.headers['content-type'] ?? '').toLowerCase();
  if (!contentType.includes('application/json')) {
    return {
      ok: false,
      status: 415,
      code: 'CONTROL_CENTER_JSON_REQUIRED',
      message: 'control-center action requests require application/json.'
    };
  }
  let total = 0;
  const chunks = [];
  for await (const chunk of request) {
    total += chunk.length;
    if (total > CONTROL_CENTER_JSON_BODY_LIMIT_BYTES) {
      return {
        ok: false,
        status: 413,
        code: 'CONTROL_CENTER_BODY_TOO_LARGE',
        message: 'control-center action request body is too large.',
        details: { max_bytes: CONTROL_CENTER_JSON_BODY_LIMIT_BYTES }
      };
    }
    chunks.push(chunk);
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') };
  } catch (error) {
    return {
      ok: false,
      status: 400,
      code: 'CONTROL_CENTER_INVALID_JSON',
      message: 'control-center action request body must be valid JSON.',
      details: { reason: error.message }
    };
  }
}

export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  plugins: [controlCenterApiPlugin()],
  server: {
    host: '127.0.0.1'
  },
  preview: {
    host: '127.0.0.1'
  },
  build: {
    outDir: '../dist/control-center',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalized = id.replace(/\\/g, '/');
          if (
            normalized.includes('/node_modules/react/')
            || normalized.includes('/node_modules/react-dom/')
            || normalized.includes('/node_modules/scheduler/')
          ) {
            return 'vendor-react';
          }
          if (normalized.includes('/control-center/src/designSystem.js')) {
            return 'design-system';
          }
          return undefined;
        }
      }
    }
  }
});
