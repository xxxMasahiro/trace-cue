import path from 'node:path';
import {
  artifactObject,
  artifactRelPath,
  writeJsonArtifact
} from './artifacts.js';
import { redact, redactUrl, truncateText } from './redaction.js';
import { createVisualEvidenceArtifact } from './visual-evidence.js';

const DEFAULT_MAX_CONSOLE_MESSAGES = 30;
const DEFAULT_MAX_FAILED_REQUESTS = 30;

export function createPageEventBuffers() {
  return {
    consoleMessages: [],
    failedRequests: []
  };
}

export function attachPageObservers(page, buffers, limits = {}) {
  const maxConsoleMessages = limits.maxConsoleMessages ?? DEFAULT_MAX_CONSOLE_MESSAGES;
  const maxFailedRequests = limits.maxFailedRequests ?? DEFAULT_MAX_FAILED_REQUESTS;

  page.on('console', (message) => {
    if (buffers.consoleMessages.length >= maxConsoleMessages) {
      return;
    }
    buffers.consoleMessages.push({
      type: message.type(),
      text: truncateText(message.text(), 1000),
      location: redact(message.location())
    });
  });

  page.on('requestfailed', (request) => {
    if (buffers.failedRequests.length >= maxFailedRequests) {
      return;
    }
    buffers.failedRequests.push({
      url: redactUrl(request.url()),
      method: request.method(),
      failure: truncateText(request.failure()?.errorText ?? 'request failed', 500)
    });
  });
}

export async function waitForNetworkIdle(page, timeout, warnings, options = {}) {
  const timeoutMs = Math.min(3000, timeout);
  try {
    await page.waitForLoadState('networkidle', { timeout: timeoutMs });
  } catch {
    if (!options.optional) {
      warnings.push({
        code: 'NETWORK_IDLE_TIMEOUT',
        message: options.message ?? 'The page did not reach networkidle before the short observation wait ended.',
        details: { timeout_ms: timeoutMs }
      });
    }
  }
}

export async function writePageObservation({
  root,
  artifactRoot,
  id,
  now,
  page,
  inputUrl,
  response,
  browser,
  consoleMessages,
  failedRequests,
  actionResults = [],
  description = 'Structured page observation JSON.'
}) {
  const pageState = await collectPageState(page);
  const observation = redact({
    id,
    observed_at: toIsoString(now),
    input_url: redactUrl(inputUrl),
    final_url: redactUrl(page.url()),
    title: pageState.title,
    response: response
      ? {
          status: response.status(),
          ok: response.ok(),
          url: redactUrl(response.url())
        }
      : null,
    browser,
    page: pageState,
    console: { messages: consoleMessages },
    network: { failed_requests: failedRequests },
    action_results: actionResults
  });
  const observationRel = artifactRelPath(artifactRoot, 'observations', `${id}.json`);
  await writeJsonArtifact(root, ['observations', `${id}.json`], observation);
  return {
    id,
    data: observation,
    artifact: artifactObject({
      type: 'observation',
      path: observationRel,
      description
    })
  };
}

export async function writePageScreenshotEvidence({
  root,
  artifactRoot,
  id,
  now,
  page,
  description = 'Full-page screenshot captured from an ephemeral context.',
  route = null,
  viewport = null,
  sourceKind = 'browser_screenshot',
  capture = {}
}) {
  const screenshotRel = artifactRelPath(artifactRoot, 'screenshots', `${id}.png`);
  const screenshotPath = path.join(root, 'screenshots', `${id}.png`);
  const screenshotResult = await page.screenshot({ path: screenshotPath, fullPage: true });
  const buffer = Buffer.isBuffer(screenshotResult) ? screenshotResult : Buffer.alloc(0);
  const screenshotArtifact = artifactObject({
    type: 'screenshot',
    path: screenshotRel,
    description
  });
  const visualEvidence = await createVisualEvidenceArtifact({
    id,
    root,
    artifactRoot,
    sourceKind,
    sourcePath: redactUrl(route ?? page.url()),
    artifactPath: screenshotRel,
    buffer,
    purpose: 'browser_visual_evidence',
    route: redactUrl(route ?? page.url()),
    viewport,
    capture: {
      mode: 'full_page',
      tool: 'playwright',
      created_at: toIsoString(now),
      ...capture
    },
    createdAt: now
  });
  return {
    screenshotPath,
    screenshotArtifact,
    visualEvidence: visualEvidence.data,
    visualEvidenceArtifact: visualEvidence.artifact,
    artifacts: [screenshotArtifact, visualEvidence.artifact]
  };
}

export async function collectPageState(page) {
  const state = await page.evaluate(() => {
    const trim = (value, max = 500) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const cssEscape = (value) => {
      if (window.CSS?.escape) {
        return window.CSS.escape(value);
      }
      return String(value).replace(/["\\]/g, '\\$&');
    };
    const selectorFor = (element) => {
      if (element.id) {
        return `#${cssEscape(element.id)}`;
      }
      const testId = element.getAttribute('data-testid');
      if (testId) {
        return `[data-testid="${cssEscape(testId)}"]`;
      }
      const dataTest = element.getAttribute('data-test');
      if (dataTest) {
        return `[data-test="${cssEscape(dataTest)}"]`;
      }
      const aria = element.getAttribute('aria-label');
      if (aria) {
        return `${element.tagName.toLowerCase()}[aria-label="${cssEscape(aria)}"]`;
      }
      const name = element.getAttribute('name');
      if (name) {
        return `${element.tagName.toLowerCase()}[name="${cssEscape(name)}"]`;
      }
      const segments = [];
      let current = element;
      while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
        let segment = current.tagName.toLowerCase();
        if (current.id) {
          segment += `#${cssEscape(current.id)}`;
          segments.unshift(segment);
          break;
        }
        const parent = current.parentElement;
        if (!parent) {
          segments.unshift(segment);
          break;
        }
        const siblings = [...parent.children].filter((child) => child.tagName === current.tagName);
        if (siblings.length > 1) {
          segment += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        }
        segments.unshift(segment);
        current = parent;
      }
      return segments.join(' > ');
    };
    const candidates = [...document.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="link"]')]
      .filter(isVisible)
      .slice(0, 60)
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role') || null,
        text: trim(element.innerText || element.textContent || element.getAttribute('aria-label') || element.getAttribute('placeholder') || ''),
        selector: selectorFor(element),
        href: element instanceof HTMLAnchorElement ? element.href : null,
        input_type: element instanceof HTMLInputElement ? element.type : null,
        disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true')
      }));
    const headings = [...document.querySelectorAll('h1, h2, h3')]
      .filter(isVisible)
      .slice(0, 30)
      .map((element) => ({
        level: Number(element.tagName.slice(1)),
        text: trim(element.innerText || element.textContent || '', 300),
        selector: selectorFor(element)
      }));
    const forms = [...document.querySelectorAll('form')]
      .slice(0, 20)
      .map((form) => ({
        selector: selectorFor(form),
        controls: [...form.querySelectorAll('input, select, textarea, button')]
          .filter(isVisible)
          .slice(0, 40)
          .map((element) => ({
            tag: element.tagName.toLowerCase(),
            selector: selectorFor(element),
            name: element.getAttribute('name') || null,
            type: element instanceof HTMLInputElement ? element.type : null,
            label: trim(element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.innerText || '', 300)
          }))
      }));
    return {
      url: window.location.href,
      title: document.title,
      ready_state: document.readyState,
      language: document.documentElement.lang || null,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      },
      visible_text: trim(document.body?.innerText || '', 4000),
      headings,
      action_candidates: candidates,
      forms
    };
  });

  return redact({
    ...state,
    url: redactUrl(state.url),
    visible_text: truncateText(state.visible_text, 4000)
  });
}

function toIsoString(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
