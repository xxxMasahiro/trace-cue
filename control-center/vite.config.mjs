import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  handleControlCenterRequest,
  resolveControlCenterServerConfig
} from '../src/control-center-server.js';
import { PRODUCT_IDENTITY } from '../src/product-identity.js';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

function controlCenterApiPlugin() {
  const resolved = resolveControlCenterServerConfig({ port: 0 }, { cwd: process.cwd() });
  if (!resolved.ok) throw new Error(resolved.message);
  const apiConfig = resolved.config;
  return {
    name: `${PRODUCT_IDENTITY.packageName}-control-center-api`,
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const pathname = String(request.url ?? '').split('?')[0];
        if (!pathname.startsWith('/api/')) {
          next();
          return;
        }
        try {
          await handleControlCenterRequest(request, response, apiConfig, { cwd: process.cwd() });
        } catch {
          response.writeHead(500, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff'
          });
          response.end(`${JSON.stringify({
            error: {
              code: 'CONTROL_CENTER_INTERNAL_ERROR',
              message: 'The Control Center could not complete the local request.'
            }
          })}\n`);
        }
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
    outDir: path.join(repositoryRoot, PRODUCT_IDENTITY.controlCenterDistPath),
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
