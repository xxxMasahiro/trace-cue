import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

export const BROWSER_TEST_WORKSPACE_RETENTION_ENV = 'TRACE_CUE_BROWSER_TEST_RETAIN';

export async function createBrowserTestWorkspace(prefix, { env = process.env } = {}) {
  const cwd = await mkdtemp(path.join(tmpdir(), prefix));
  const cleanups = [];
  const retain = env[BROWSER_TEST_WORKSPACE_RETENTION_ENV] === '1';
  let cleaned = false;

  function defer(cleanup) {
    if (cleaned) {
      throw new Error('Cannot register cleanup after the browser test workspace has closed.');
    }
    cleanups.push(cleanup);
  }

  function trackBrowser(browser) {
    defer(async () => {
      if (!browser || (typeof browser.isConnected === 'function' && !browser.isConnected())) {
        return;
      }
      await browser.close();
    });
    return browser;
  }

  function trackServer(server) {
    defer(async () => {
      if (!server?.listening) {
        return;
      }
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    });
    return server;
  }

  function trackSession(session, stop) {
    defer(async () => {
      const sessionId = typeof session === 'function' ? session() : session;
      if (sessionId) {
        await stop(sessionId);
      }
    });
  }

  function trackDaemon(daemon, stop) {
    defer(async () => {
      const daemonId = typeof daemon === 'function' ? daemon() : daemon;
      if (daemonId) {
        await stop(daemonId);
      }
    });
  }

  async function cleanup() {
    if (cleaned) return;
    cleaned = true;
    const errors = [];

    for (const close of cleanups.reverse()) {
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    }

    if (!retain) {
      try {
        await rm(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch (error) {
        errors.push(error);
      }
    } else {
      process.stderr.write(`Retained browser test workspace: ${cwd}\n`);
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, `Failed to clean browser test workspace: ${cwd}`);
    }
  }

  return {
    cwd,
    cleanup,
    defer,
    retain,
    trackBrowser,
    trackDaemon,
    trackServer,
    trackSession
  };
}
