import { defineConfig } from 'vite';
import { createEnvelope } from '../src/envelope.js';
import { runControlCenterStatus, controlCenterBoundary } from '../src/control-center-read-model.js';

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
        if (request.method !== 'GET') {
          next();
          return;
        }
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/api/health') {
          sendJson(response, 200, {
            status: 'ok',
            local_only: true,
            read_only: true,
            boundary: controlCenterBoundary()
          });
          return;
        }
        if (url.pathname === '/api/dashboard') {
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
        next();
      });
    }
  };
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
