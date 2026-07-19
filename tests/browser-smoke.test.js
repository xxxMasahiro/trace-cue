import test from 'node:test';
import assert from 'node:assert/strict';
import { access, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { executeCli } from '../src/cli.js';
import {
  AGENTIC_REVIEW_API_CREDENTIAL_ENV,
  AGENTIC_REVIEW_API_ENDPOINT_ENV,
  AGENTIC_REVIEW_RESPONSES_ADAPTER_MODEL_ENV,
  startControlCenterServer
} from '../src/api.js';
import {
  agenticProviderCapabilityHash,
  resolveAgenticHumanReviewProvider
} from '../src/agentic-human-review-providers.js';
import { createSafeLocalStore } from '../src/safe-local-store.js';
import { createBrowserTestWorkspace } from './helpers/browser-test-workspace.js';

const runBrowserSmoke = process.env.TRACE_CUE_BROWSER_SMOKE === '1' || process.env.BROWSER_DEBUG_BROWSER_SMOKE === '1';
const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixedNow = '2026-06-17T00:00:00.000Z';
const CONTROL_CENTER_RESPONSE_OBSERVATION_TIMEOUT_MS = 45_000;
const controlCenterMockUrl = pathToFileURL(path.join(
  repoRoot,
  'docs',
  'design-system',
  'mockups',
  'control-center',
  'index.html'
)).href;

async function measureNewReviewVisualContract(page, selectors) {
  const screen = await page.locator(selectors.screen).boundingBox();
  const sourceCards = await page.locator(selectors.sources).evaluateAll((elements) => elements.map((element) => {
    const box = element.getBoundingClientRect();
    return { x: Math.round(box.x), width: Math.round(box.width), height: Math.round(box.height) };
  }));
  return {
    screenWidth: Math.round(screen.width),
    headingSize: await page.locator(`${selectors.screen} h1`).evaluate((element) => getComputedStyle(element).fontSize),
    stepCount: await page.locator(selectors.steps).count(),
    stepMarkSize: Math.round((await page.locator(selectors.stepMark).first().boundingBox()).width),
    sourceColumns: new Set(sourceCards.map((card) => card.x)).size,
    sourceWidth: sourceCards[0]?.width ?? 0,
    sourceHeight: sourceCards[0]?.height ?? 0,
    methodHeight: Math.round((await page.locator(selectors.methods).first().boundingBox()).height),
    purposeTag: await page.locator(selectors.purpose).evaluate((element) => element.tagName),
    purposeHeight: Math.round((await page.locator(selectors.purpose).boundingBox()).height),
    footerJustify: await page.locator(selectors.footer).evaluate((element) => getComputedStyle(element).justifyContent)
  };
}

function assertCloseMetric(actual, expected, tolerance, label) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} must stay within ${tolerance}px of ${expected}`);
}

async function activateObservedPage(page) {
  await page.bringToFront();
  assert.equal(await page.evaluate(() => document.visibilityState), 'visible');
}

async function releaseGateForObservedPage(page, release) {
  await activateObservedPage(page);
  release();
}

function isExpectedRouteCleanupError(error) {
  return /Route is already handled|Target page, context or browser has been closed/u.test(String(error?.message));
}

function controlCenterReviewContext(cwd) {
  let operationId = 0;
  const providerId = 'generic-api-provider';
  const modelId = 'browser-review-model';
  const providerResolution = resolveAgenticHumanReviewProvider({ providerId, context: {} });
  if (!providerResolution.ok) throw new Error('Browser test provider is unavailable.');
  const provider = providerResolution.provider;
  const providerCapabilityHash = agenticProviderCapabilityHash(provider);
  const context = {
    cwd,
    now: () => new Date(fixedNow),
    createId: () => `control-center-agentic-review-browser-${++operationId}`,
    agenticReviewServiceName: 'Example Review AI',
    agenticReviewProviderId: providerId,
    env: {
      [AGENTIC_REVIEW_API_ENDPOINT_ENV]: 'https://review.example.test/v1/responses',
      [AGENTIC_REVIEW_API_CREDENTIAL_ENV]: 'browser-test-secret',
      [AGENTIC_REVIEW_RESPONSES_ADAPTER_MODEL_ENV]: modelId
    },
    async runReview() {
      return {
        status: 'ok', data: { findings: [] }, warnings: [], errors: [],
        artifacts: [{ type: 'review_artifact_index', path: '.browser-debug/browser-review-index.json' }]
      };
    },
    async runAgenticHumanReviewPropose() {
      return {
        status: 'ok', data: {}, warnings: [], errors: [],
        artifacts: [{ type: 'agentic_human_review_proposal', path: '.browser-debug/proposal.json' }]
      };
    },
    async runAgenticHumanReviewPlan() {
      return {
        status: 'ok',
        data: {
          agentic_human_review_plan: {
            plan_hash: 'browser-plan-hash',
            package_hash: 'browser-package-hash',
            provider_capability_hash: providerCapabilityHash,
            provider: { id: providerId },
            model: { id: modelId },
            surface: { id: 'browser-smoke' },
            transfer_permissions: {
              required_flags: ['allow-page-text', 'allow-url'],
              classes: {
                page_text: { included: true, required_for_execution: true },
                url: { included: true, required_for_execution: true }
              }
            }
          }
        },
        warnings: [], errors: [],
        artifacts: [{ type: 'agentic_human_review_plan', path: '.browser-debug/plan.json' }]
      };
    },
    async runAgenticHumanReviewRun() {
      const relativePath = `.browser-debug/browser-advisory-${operationId}.json`;
      await mkdir(path.join(cwd, '.browser-debug'), { recursive: true });
      await writeFile(path.join(cwd, relativePath), `${JSON.stringify({
        schema_version: '1.0.0',
        id: 'browser-advisory',
        result_type: 'agentic_human_review_advisory',
        human_review_schema_version: '2.0.0',
        agentic_human_review_advisory: {
          id: 'browser-advisory',
          status: 'completed',
          plan_hash: 'browser-plan-hash',
          plan_path: '.browser-debug/plan.json',
          gate_effect: 'none'
        },
        non_engineer_summary: {
          main_takeaway: 'Make the booking action easier to find.',
          top_concerns: ['The booking action is easy to miss.']
        },
        subjective_perception: {},
        readability_comprehension: {},
        reader_experience_review: {},
        mechanical_vs_human_review: {},
        human_review_coverage: {},
        benchmark_requirement_coverage: {},
        xhigh_multi_round_review: {},
        role_opinions: [],
        consensus_summary: {},
        dissent_summary: {},
        agentic_human_review_findings: [
          {
            id: 'booking-action',
            message: 'The booking action is easy to miss',
            impact: 'First-time visitors may stop before booking.',
            suggested_fix: 'Place the booking action near the first explanation.'
          },
          {
            id: 'price-explanation',
            message: 'The price explanation appears too late',
            impact: 'Visitors may hesitate before choosing a plan.',
            suggested_fix: 'Show a short price explanation beside the plan choice.'
          }
        ],
        agentic_human_review_action_plan: { suggested_fixes: ['Move the booking action higher.'] },
        agentic_human_review_readiness: { advisory_only: true, gate_effect: 'none' },
        owner_decision_requests: [],
        provider: { id: providerId },
        model: { id: modelId },
        transfer_permissions: { required_flags: ['allow-page-text', 'allow-url'] },
        execution: {
          id: 'browser-execution',
          result_path: relativePath,
          provider_call_performed: true,
          api_call_performed: true,
          external_evidence_transfer: true
        },
        boundary: {
          provider_call_performed: true,
          api_call_performed: true,
          external_evidence_transfer: true
        }
      })}\n`, 'utf8');
      return {
        status: 'ok',
        data: {
          agentic_human_review_execution: {
            boundary: {
              provider_call_performed: true,
              api_call_performed: true,
              external_evidence_transfer: true
            }
          }
        },
        warnings: [], errors: [],
        artifacts: [{ type: 'agentic_human_review_advisory', path: relativePath }]
      };
    }
  };
  context.discoverControlCenterAiConnections = async () => ({
    connections: [{
      id: 'browser-api-connection',
      display_name: 'Example Review AI',
      connection_type: 'api',
      status: 'available',
      status_message: 'BACKEND_STATUS_SENTINEL',
      adapter_id: 'browser-api-adapter',
      adapter_version: '1.0.0',
      provider_id: providerId,
      transport: provider.transport,
      execution_strategy: 'one-shot',
      provider_effort_request_field: provider.effort_capability.native_effort_binding.request_field,
      provider_capability_hash: providerCapabilityHash,
      executable_identity_hash: null,
      models: [{
        id: modelId,
        display_name: modelId,
        native_efforts: [
          { id: 'low', display_name: 'Low' },
          { id: 'medium', display_name: 'Medium' },
          { id: 'high', display_name: 'High' }
        ],
        default_native_effort_id: 'medium'
      }],
      default_model_id: modelId
    }],
    selection: null,
    boundary: { process_spawned: false, network_used: false, credential_values_read: false }
  });
  return context;
}

test('observe captures a local file page with Playwright', { skip: !runBrowserSmoke }, async (t) => {
  const testWorkspace = await createBrowserTestWorkspace('browser-debug-smoke-');
  t.after(() => testWorkspace.cleanup());
  const { cwd } = testWorkspace;
  await writeFile(path.join(cwd, '.gitignore'), '.browser-debug/\n', 'utf8');
  const fixture = path.join(cwd, 'fixture.html');
  await writeFile(fixture, [
    '<!doctype html>',
    '<html lang="en">',
    '<head><title>Observation Smoke</title></head>',
    '<body>',
    '<h1>Smoke Page</h1>',
    '<button id="primary" onclick="document.getElementById(\'result\').textContent = \'Clicked\'">Primary Action</button>',
    '<p id="result">Waiting</p>',
    '<a href="https://example.test/?token=secret-value">External Link</a>',
    '<script>console.warn("token=abc123456789")</script>',
    '</body>',
    '</html>'
  ].join('\n'), 'utf8');

  const result = await executeCli([
    'observe',
    '--url',
    `file://${fixture}`,
    '--screenshot',
    '--trace',
    '--timeout',
    '10000',
    '--json'
  ], { cwd });

  assert.equal(result.exitCode, 0);
  const body = JSON.parse(result.stdout);
  assert.equal(body.command, 'observe');
  assert.equal(body.status, 'ok');
  assert.equal(body.data.title, 'Observation Smoke');
  assert.match(body.data.page.visible_text, /Smoke Page/);
  assert.equal(body.data.browser.ephemeral_context, true);
  assert.ok(body.data.page.action_candidates.some((candidate) => candidate.selector === '#primary'));

  const observation = body.artifacts.find((artifact) => artifact.type === 'observation');
  const screenshot = body.artifacts.find((artifact) => artifact.type === 'screenshot');
  const visualEvidence = body.artifacts.find((artifact) => artifact.type === 'visual_evidence');
  const trace = body.artifacts.find((artifact) => artifact.type === 'trace');
  assert.ok(observation);
  assert.ok(screenshot);
  assert.ok(visualEvidence);
  assert.ok(trace);
  await access(path.join(cwd, observation.path));
  await access(path.join(cwd, screenshot.path));
  await access(path.join(cwd, visualEvidence.path));
  await access(path.join(cwd, trace.path));
  const visualEvidenceJson = JSON.parse(await readFile(path.join(cwd, visualEvidence.path), 'utf8'));
  assert.equal(visualEvidenceJson.boundary.raw_pixels_in_json, false);
  assert.equal(visualEvidenceJson.boundary.provider_call_performed, false);
  assert.equal(visualEvidenceJson.source.artifact_path, screenshot.path);
  assert.equal(body.warnings[0].code, 'TRACE_CONTAINS_PAGE_CONTENT');

  const observationJson = await readFile(path.join(cwd, observation.path), 'utf8');
  assert.doesNotMatch(observationJson, /secret-value/);
  assert.match(observationJson, /\[REDACTED\]/);
});

test('review center completes prepare, consent, review, decision, repeat, and settings flows', { skip: !runBrowserSmoke }, async (t) => {
  const testWorkspace = await createBrowserTestWorkspace('trace-cue-review-center-smoke-');
  t.after(() => testWorkspace.cleanup());
  const { cwd } = testWorkspace;
  const builtAssets = path.join(repoRoot, 'dist', 'control-center');
  await access(builtAssets);
  await cp(builtAssets, path.join(cwd, 'dist', 'control-center'), { recursive: true });
  const started = await startControlCenterServer({ port: 0 }, controlCenterReviewContext(cwd));
  testWorkspace.trackServer(started.server);
  let browser = null;
  let releaseCancelledResponse;
  try {
    browser = await chromium.launch();
    testWorkspace.trackBrowser(browser);
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const consoleErrors = [];
    const repeatEvents = [];
    let failNextRepeatReconciliationDashboard = false;
    let failedRepeatReconciliationDashboardReads = 0;
    const repeatObservationStartedAt = Date.now();
    const recordRepeatEvent = (kind, request, details = {}) => {
      if (new URL(request.url()).pathname !== '/api/agentic-review/repeat') return;
      repeatEvents.push({
        kind,
        elapsed_ms: Date.now() - repeatObservationStartedAt,
        method: request.method(),
        ...details
      });
    };
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('request', (request) => recordRepeatEvent('request', request));
    page.on('response', (response) => recordRepeatEvent('response', response.request(), {
      status: response.status()
    }));
    page.on('requestfailed', (request) => recordRepeatEvent('requestfailed', request, {
      failure: request.failure()?.errorText ?? 'unknown'
    }));
    await page.route('**/api/dashboard', async (route) => {
      if (!failNextRepeatReconciliationDashboard) {
        await route.continue();
        return;
      }
      failNextRepeatReconciliationDashboard = false;
      failedRepeatReconciliationDashboardReads += 1;
      await route.abort('failed');
    });
    await page.goto(started.url, { waitUntil: 'networkidle' });
    await page.locator('[data-testid="tc-cc-home"]').waitFor();
    await page.getByRole('button', { name: /New review/ }).click();
    await page.locator('[data-testid="tc-cc-new-review"]').waitFor();
    const setupChoice = page.locator('.ai-choice');
    assert.match(await setupChoice.innerText(), /AI suggestions need setup/);
    assert.doesNotMatch(await setupChoice.innerText(), /provider|endpoint|API token|CLI command|file path/i);
    await setupChoice.getByRole('button', { name: 'Set up AI' }).click();
    const setupDialog = page.getByRole('dialog', { name: 'Set up AI' });
    await setupDialog.waitFor();
    assert.doesNotMatch(await setupDialog.innerText(), /provider|endpoint|API token|CLI command|file path/i);
    const mockSetupPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await mockSetupPage.goto(`${controlCenterMockUrl}?screen=new&ai=setup-required&dialog=ai-setup`, { waitUntil: 'load' });
    const mockSetupDialog = mockSetupPage.locator('[data-testid="mock-ai-setup"]');
    await mockSetupDialog.waitFor();
    assert.equal(
      await setupDialog.locator('h2').evaluate((element) => getComputedStyle(element).fontSize),
      await mockSetupDialog.locator('h2').evaluate((element) => getComputedStyle(element).fontSize)
    );
    await mockSetupPage.close();
    await setupDialog.getByRole('button', { name: 'Close' }).click();
    await setupDialog.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const initialSettings = page.locator('[data-testid="tc-cc-settings"]');
    await initialSettings.waitFor();
    await initialSettings.getByRole('button', { name: 'Update availability' }).click();
    await initialSettings.getByText('Available', { exact: true }).waitFor();
    assert.match(await initialSettings.innerText(), /Example Review AI[\s\S]*browser-review-model/);
    assert.doesNotMatch(await initialSettings.innerText(), /BACKEND_STATUS_SENTINEL/);
    await page.goto(started.url, { waitUntil: 'networkidle' });
    await page.locator('[data-testid="tc-cc-home"]').waitFor();
    await page.getByRole('button', { name: /New review/ }).click();
    await page.locator('[data-testid="tc-cc-new-review"]').waitFor();
    const methodSelector = page.locator('.method-grid');
    assert.equal(await methodSelector.getByRole('radio').count(), 3);
    assert.equal(await methodSelector.getByRole('radio', { name: /improvements that matter most/i }).isChecked(), true);
    assert.equal(await page.locator('.workflow-steps li.current').getAttribute('aria-current'), 'step');
    assert.ok((await methodSelector.getByRole('radio').first().boundingBox()).width >= 24);
    assert.doesNotMatch(await methodSelector.innerText(), /\bstandard\b|\bdeep\b|\bxhigh\b/i);
    const mockPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await mockPage.goto(`${controlCenterMockUrl}?screen=new`, { waitUntil: 'load' });
    const productionVisual = await measureNewReviewVisualContract(page, {
      screen: '[data-testid="tc-cc-new-review"]',
      sources: '.source-choice',
      steps: '.workflow-steps li',
      stepMark: '.workflow-steps li > span',
      methods: '.choice-card',
      purpose: '#review-purpose',
      footer: '.form-actions'
    });
    const mockVisual = await measureNewReviewVisualContract(mockPage, {
      screen: '[data-testid="mock-new-review"]',
      sources: '.source-option',
      steps: '.stepper li',
      stepMark: '.step-number',
      methods: '.method-option',
      purpose: 'input[name="purpose"]',
      footer: '.form-footer'
    });
    assert.equal(productionVisual.headingSize, mockVisual.headingSize);
    assert.equal(productionVisual.stepCount, mockVisual.stepCount);
    assert.equal(productionVisual.sourceColumns, mockVisual.sourceColumns);
    assertCloseMetric(productionVisual.screenWidth, mockVisual.screenWidth, 2, 'new review content width');
    assertCloseMetric(productionVisual.stepMarkSize, mockVisual.stepMarkSize, 4, 'workflow step mark');
    assertCloseMetric(productionVisual.sourceWidth, mockVisual.sourceWidth, 12, 'source option width');
    assertCloseMetric(productionVisual.sourceHeight, mockVisual.sourceHeight, 12, 'source option height');
    assertCloseMetric(productionVisual.methodHeight, mockVisual.methodHeight, 12, 'review method height');
    assert.equal(productionVisual.purposeTag, mockVisual.purposeTag);
    assertCloseMetric(productionVisual.purposeHeight, mockVisual.purposeHeight, 2, 'review purpose input height');
    assert.equal(productionVisual.footerJustify, mockVisual.footerJustify);
    await mockPage.getByRole('button', { name: '変更', exact: true }).click();
    await mockPage.getByText('AIの詳細', { exact: true }).waitFor();
    await mockPage.close();
    await page.getByLabel('URL to review').fill('https://example.jp/reserve');
    await page.getByLabel('What do you want to make easier?').fill('Help first-time visitors complete a booking without getting lost.');
    await page.getByRole('button', { name: 'Prepare review', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Start this review?' });
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const cancelledOperations = await page.evaluate(async () => (
      await (await fetch('/api/agentic-review/list')).json()
    ).data.control_center_agentic_review.operations.filter((operation) => operation.state === 'cancelled'));
    assert.equal(cancelledOperations.length, 1);
    assert.equal(cancelledOperations[0].dispatch.provider_call_performed, false);

    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.locator('[data-testid="tc-cc-home"]').waitFor();
    await page.getByRole('heading', { name: 'No reviews yet', exact: true }).waitFor();
    assert.equal(await page.getByText('Not sent', { exact: true }).count(), 1);
    await page.getByRole('button', { name: 'New review', exact: true }).click();
    await page.getByLabel('URL to review').fill('https://example.jp/reserve');
    await page.getByLabel('What do you want to make easier?').fill('Help first-time visitors complete a booking without getting lost.');

    await page.getByRole('button', { name: 'Prepare review', exact: true }).click();
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /Example Review AI/);
    await dialog.getByText('AI settings', { exact: true }).click();
    assert.match(await dialog.innerText(), /browser-review-model/);
    assert.match(await dialog.innerText(), /Essential review/);
    assert.match(await dialog.innerText(), /Visible page text/);
    assert.match(await dialog.innerText(), /Saved on this computer/);
    const dialogBox = await dialog.boundingBox();
    const workspaceBox = await page.locator('.workspace').boundingBox();
    assert.ok(Math.abs((dialogBox.x + (dialogBox.width / 2)) - (workspaceBox.x + (workspaceBox.width / 2))) <= 2);
    await dialog.getByRole('button', { name: 'Start review', exact: true }).click();

    const workspace = page.locator('[data-testid="tc-cc-review-workspace"]');
    await workspace.waitFor();
    await page.getByRole('heading', { name: 'The booking action is easy to miss' }).waitFor({ timeout: 10_000 });
    assert.equal(await page.getByRole('button', { name: /Fix this/ }).getAttribute('class'), '');
    await page.getByRole('button', { name: /Fix this/ }).click();
    await page.getByRole('heading', { name: 'The price explanation appears too late' }).waitFor();
    await page.getByRole('button', { name: /Ask someone/ }).click();
    await page.getByRole('heading', { name: 'All improvements have a decision' }).waitFor();
    assert.equal(await page.getByRole('button', { name: /Ask someone/ }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByRole('button', { name: /Fix this/ }).getAttribute('aria-pressed'), 'false');
    const completedOperation = await page.evaluate(async () => {
      const id = new URLSearchParams(window.location.search).get('item');
      return (await (await fetch(`/api/agentic-review/status?id=${encodeURIComponent(id)}`)).json()).data.control_center_agentic_review.operation;
    });
    assert.equal(completedOperation.decisions.length, 2);
    assert.equal(completedOperation.stage, 'complete');

    await page.route('**/api/agentic-review/repeat', async (route) => {
      const response = await route.fetch();
      assert.equal(response.ok(), true);
      failNextRepeatReconciliationDashboard = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'ok',
          data: { control_center_agentic_review: {} }
        })
      });
    }, { times: 1 });
    await page.getByRole('button', { name: 'Review in more detail' }).click();
    await page.getByRole('heading', { name: /example\.jp/ }).waitFor();
    try {
      await page.getByRole('heading', { name: 'The review is ready to start' }).waitFor({
        timeout: CONTROL_CENTER_RESPONSE_OBSERVATION_TIMEOUT_MS
      });
    } catch (caught) {
      const safeSnapshot = await page.evaluate(async () => {
        const currentId = new URLSearchParams(window.location.search).get('item');
        let operations = [];
        try {
          const response = await fetch('/api/agentic-review/list', {
            cache: 'no-store',
            signal: AbortSignal.timeout(3_000)
          });
          const body = await response.json();
          operations = (body.data?.control_center_agentic_review?.operations ?? []).map((item) => ({
            id: item.id,
            state: item.state,
            stage: item.stage,
            parent_id: item.parent_review?.id ?? null,
            repeat_mode: item.parent_review?.repeat_mode ?? null
          }));
        } catch {}
        return {
          current_id: currentId,
          route: new URLSearchParams(window.location.search).get('page'),
          headings: [...document.querySelectorAll('h1, h2')]
            .map((element) => element.textContent?.replace(/\s+/gu, ' ').trim())
            .filter(Boolean),
          notices: [...document.querySelectorAll('.inline-notice')]
            .map((element) => element.textContent?.replace(/\s+/gu, ' ').trim())
            .filter(Boolean),
          operations
        };
      });
      throw new Error(`Repeat reconciliation did not reach confirmation: ${JSON.stringify({ repeatEvents, safeSnapshot })}`, {
        cause: caught
      });
    }
    assert.equal(
      repeatEvents.filter((event) => event.kind === 'request').length,
      1,
      `A successful repeat recovered from its read model must not be sent again: ${JSON.stringify(repeatEvents)}`
    );
    assert.equal(failedRepeatReconciliationDashboardReads, 1);
    const repeatedOperation = await page.evaluate(async () => {
      const id = new URLSearchParams(window.location.search).get('item');
      return (await (await fetch(`/api/agentic-review/status?id=${encodeURIComponent(id)}`)).json()).data.control_center_agentic_review.operation;
    });
    assert.equal(repeatedOperation.review_effort, 'deep');
    assert.equal(repeatedOperation.parent_review.repeat_mode, 'deeper');
    const repeatedChildren = await page.evaluate(async (parentId) => (
      await (await fetch('/api/agentic-review/list')).json()
    ).data.control_center_agentic_review.operations.filter((item) => item.parent_review?.id === parentId), completedOperation.id);
    assert.equal(repeatedChildren.length, 1);
    assert.equal(repeatedChildren[0].id, repeatedOperation.id);

    await page.getByRole('button', { name: 'Review and start', exact: true }).click();
    const repeatedDialog = page.getByRole('dialog', { name: 'Start this review?' });
    await repeatedDialog.waitFor();
    await page.route('**/api/agentic-review/start', async (route) => {
      const response = await route.fetch();
      assert.equal(response.ok(), true);
      await route.abort('failed');
    }, { times: 1 });
    await repeatedDialog.getByRole('button', { name: 'Start review', exact: true }).click();
    await repeatedDialog.waitFor({ state: 'hidden' });
    await page.waitForTimeout(4_000);
    const repeatedStartSnapshot = await page.evaluate(async () => {
      const id = new URLSearchParams(window.location.search).get('item');
      const body = await (await fetch(`/api/agentic-review/status?id=${encodeURIComponent(id)}`)).json();
      return {
        operation: body.data?.control_center_agentic_review?.operation,
        visibleText: document.querySelector('[data-testid="tc-cc-review-workspace"]')?.innerText
      };
    });
    assert.equal(repeatedStartSnapshot.operation?.state, 'completed', JSON.stringify(repeatedStartSnapshot));
    await workspace.locator('.finding-detail h2').waitFor({ timeout: 5_000 });
    assert.equal(await page.getByRole('heading', { name: 'The review is ready to start', exact: true }).count(), 0);
    assert.equal(await page.getByText('The latest status could not be read.', { exact: true }).count(), 0);
    const repeatedFindingCount = await workspace.locator('.finding-list button').count();
    assert.ok(repeatedFindingCount > 0);
    for (let index = 0; index < repeatedFindingCount; index += 1) {
      await workspace.locator('.finding-list button').nth(index).click();
      await workspace.getByRole('button', { name: /Fix this/ }).click();
    }
    await page.getByRole('heading', { name: 'All improvements have a decision' }).waitFor();
    await page.getByRole('button', { name: 'Review in more detail' }).click();
    await page.getByRole('heading', { name: 'The review is ready to start' }).waitFor({
      timeout: CONTROL_CENTER_RESPONSE_OBSERVATION_TIMEOUT_MS
    });
    await page.getByRole('button', { name: 'Review and start', exact: true }).click();
    await repeatedDialog.waitFor();
    const cancelledResponseGate = new Promise((resolve) => { releaseCancelledResponse = resolve; });
    await page.route('**/api/agentic-review/cancel', async (route) => {
      const response = await route.fetch();
      assert.equal(response.ok(), true);
      await cancelledResponseGate;
      try {
        await route.abort('failed');
      } catch (error) {
        if (!isExpectedRouteCleanupError(error)) throw error;
      }
    }, { times: 1 });
    await repeatedDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await repeatedDialog.waitFor({ state: 'hidden' });
    const cancelledHeading = page.getByRole('heading', { name: 'This review was not sent', exact: true });
    const cancellationError = page.getByText('The latest status could not be read.', { exact: true });
    let cancellationOutcome;
    try {
      cancellationOutcome = await Promise.race([
        cancelledHeading.waitFor({ state: 'visible', timeout: 70_000 }).then(() => 'cancelled'),
        cancellationError.waitFor({ state: 'visible', timeout: 70_000 })
          .then(() => 'status reconciliation failed')
      ]);
    } catch (caught) {
      const cancellationSnapshot = await page.evaluate(async () => {
        const id = new URLSearchParams(window.location.search).get('item');
        const body = await (await fetch(`/api/agentic-review/status?id=${encodeURIComponent(id)}`)).json();
        return {
          state: body.data?.control_center_agentic_review?.operation?.state,
          stage: body.data?.control_center_agentic_review?.operation?.stage,
          visibleText: document.querySelector('[data-testid="tc-cc-review-workspace"]')?.innerText
        };
      });
      throw new Error(`Cancellation did not reconcile: ${JSON.stringify(cancellationSnapshot)}`, { cause: caught });
    }
    assert.equal(cancellationOutcome, 'cancelled', cancellationOutcome);
    releaseCancelledResponse();
    assert.equal(await page.getByRole('dialog', { name: 'Start this review?' }).count(), 0);
    assert.equal(await page.getByText('The latest status could not be read.').count(), 0);

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settingsHub = page.locator('[data-testid="tc-cc-settings"]');
    await settingsHub.waitFor();
    const settingsBox = await settingsHub.boundingBox();
    assert.equal(Math.round(settingsBox.width), 760);
    assert.equal(await settingsHub.locator('h1').evaluate((element) => getComputedStyle(element).fontSize), '30px');
    assert.equal(await settingsHub.locator('h1').evaluate((element) => getComputedStyle(element).outlineStyle), 'none');
    assert.equal(await settingsHub.locator('.setting-row p').first().evaluate((element) => getComputedStyle(element).fontSize), '14px');
    assert.equal(Math.round((await settingsHub.locator('select').first().boundingBox()).height), 48);
    assert.equal(await settingsHub.locator('.panel').count(), 0);
    assert.equal(await settingsHub.locator('.primary-action').count(), 1);
    const aiSuggestionsToggle = page.getByLabel('Use AI suggestions');
    if (!await aiSuggestionsToggle.isChecked()) await aiSuggestionsToggle.check();
    assert.equal(
      await aiSuggestionsToggle.locator('xpath=following-sibling::span[1]').evaluate((element) => getComputedStyle(element).backgroundColor),
      'rgb(40, 125, 60)'
    );
    const mockSettingsPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await mockSettingsPage.goto(`${controlCenterMockUrl}?screen=settings`, { waitUntil: 'load' });
    const mockSettings = mockSettingsPage.locator('[data-testid="mock-settings"]');
    await mockSettings.waitFor();
    assert.equal(await settingsHub.locator('.settings-group').count(), await mockSettings.locator('.settings-group').count());
    assert.equal(await settingsHub.locator('.setting-row').count(), await mockSettings.locator('.setting-row').count());
    assert.equal(await settingsHub.locator('h1').evaluate((element) => getComputedStyle(element).fontSize), await mockSettings.locator('h1').evaluate((element) => getComputedStyle(element).fontSize));
    assertCloseMetric(Math.round(settingsBox.width), Math.round((await mockSettings.boundingBox()).width), 2, 'settings content width');
    assertCloseMetric(Math.round((await settingsHub.locator('select').first().boundingBox()).height), Math.round((await mockSettings.locator('select').first().boundingBox()).height), 2, 'settings select height');
    assert.equal(
      await settingsHub.locator('.form-actions').evaluate((element) => getComputedStyle(element).justifyContent),
      await mockSettings.locator('.settings-footer').evaluate((element) => getComputedStyle(element).justifyContent)
    );
    assertCloseMetric(
      Math.round((await settingsHub.locator('.ai-connection-setting').boundingBox()).width),
      Math.round((await mockSettings.locator('.ai-connection-setting').boundingBox()).width),
      2,
      'AI connection setting width'
    );
    assert.equal(
      await settingsHub.locator('.ai-status').evaluate((element) => getComputedStyle(element).backgroundColor),
      await mockSettings.locator('.ai-status').evaluate((element) => getComputedStyle(element).backgroundColor)
    );
    assert.equal(
      await settingsHub.locator('.ai-status').evaluate((element) => getComputedStyle(element).borderTopWidth),
      await mockSettings.locator('.ai-status').evaluate((element) => getComputedStyle(element).borderTopWidth)
    );
    await mockSettingsPage.close();
    const settingsText = await settingsHub.innerText();
    assert.doesNotMatch(settingsText, /Language state|Settings storage|Diagnostics|Target policy|Max age hours/);
    assert.doesNotMatch(settingsText, /provider|endpoint|API token|CLI command|file path/i);
    assert.equal(await page.getByRole('button', { name: /run/i }).count(), 0);

    await page.getByRole('button', { name: 'Change', exact: true }).click();
    await page.getByText('AI details', { exact: true }).click();
    await page.getByLabel('AI processing level').selectOption({ label: 'High' });
    const applyAi = page.getByRole('button', { name: 'Use this AI', exact: true });
    const applyAiBox = await applyAi.boundingBox();
    assert.ok(applyAiBox.height >= 44);
    await applyAi.click();
    await page.getByText('AI choice updated.', { exact: true }).waitFor();
    await page.getByLabel('AI processing level').selectOption({ label: 'Low' });
    assert.equal(await page.getByText('AI choice updated.', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Use this AI', exact: true }).count(), 1);
    await page.getByLabel('AI processing level').selectOption({ label: 'High' });

    await page.getByLabel('Automated checks').selectOption('local_run');
    assert.equal(await page.getByRole('button', { name: /run/i }).count(), 0);
    await page.getByLabel('Display language').selectOption('ja');
    await page.route('**/api/settings/control-center', async (route) => {
      const response = await route.fetch();
      assert.equal(response.ok(), true);
      await route.abort('failed');
    }, { times: 1 });
    await page.getByRole('button', { name: /Save settings|設定を保存/ }).click();
    const savedNotice = page.locator('.inline-notice.success').filter({ hasText: '設定を保存しました' });
    await savedNotice.waitFor();
    const savedNoticeStyle = await savedNotice.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        borderLeftWidth: style.borderLeftWidth,
        borderRightWidth: style.borderRightWidth,
        backgroundColor: style.backgroundColor,
        successSoft: getComputedStyle(element.closest('.app-shell')).getPropertyValue('--tc-color-success-soft').trim()
      };
    });
    assert.equal(savedNoticeStyle.borderLeftWidth, '1px');
    assert.equal(savedNoticeStyle.borderRightWidth, '1px');
    assert.equal(savedNoticeStyle.backgroundColor, 'rgb(234, 247, 238)');
    assert.equal(savedNoticeStyle.successSoft, '#eaf7ee');
    const savedDashboard = await page.evaluate(async () => (await (await fetch('/api/dashboard')).json()).data.control_center);
    assert.equal(savedDashboard.settings.display_language.current_locale, 'ja');
    assert.equal(savedDashboard.ai_connections.selection.effort_name, 'High');
    assert.equal(savedDashboard.settings.playwright_test.selected_mode, 'local_run');
    assert.equal(savedDashboard.settings.control_center.external_send_confirmation_required, true);
    assert.match(await settingsHub.innerText(), /いつも確認する画面[\s\S]*自動確認[\s\S]*AIの提案を使う[\s\S]*外部へ送る前に確認する/);
    await page.getByLabel('いつも確認する画面').selectOption('desktop');
    assert.equal(await page.locator('.inline-notice.success').filter({ hasText: '設定を保存しました' }).count(), 0);

    await page.setViewportSize({ width: 390, height: 844 });
    const mobileChangeBox = await page.getByRole('button', { name: '変更', exact: true }).boundingBox();
    assert.ok(mobileChangeBox.width >= 44);
    assert.ok(mobileChangeBox.height >= 44);
    await page.getByRole('button', { name: '確認', exact: true }).click();
    await page.getByRole('button', { name: /新しく確認/ }).click();
    await page.locator('[data-testid="tc-cc-new-review"]').waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.equal(overflow, 0);
    assert.deepEqual(
      consoleErrors.filter((message) => !/Failed to load resource: net::ERR_FAILED/u.test(message)),
      []
    );
  } finally {
    releaseCancelledResponse?.();
    if (browser) {
      await browser.close();
    }
    await closeServer(started.server);
  }
});

test('paired review center connects AI without terminal setup and preserves the review draft', { skip: !runBrowserSmoke }, async (t) => {
  const testWorkspace = await createBrowserTestWorkspace('trace-cue-control-center-ai-setup-browser-');
  t.after(() => testWorkspace.cleanup());
  const { cwd } = testWorkspace;
  const apiCredentialValue = ['browser', 'fixture', 'value', '123456789'].join('-');
  const replacementCredentialValue = ['browser', 'replacement', 'value', '987654321'].join('-');
  const competingCredentialValue = ['browser', 'competing', 'value', '456789123'].join('-');
  const acceptedCredentials = new Set([apiCredentialValue, replacementCredentialValue, competingCredentialValue]);
  let modelRequestCount = 0;
  let adapterStartCount = 0;
  let adapterClosed = false;
  let loginManagerDisposed = false;
  const idleLogin = Object.freeze({
    status: 'idle', operation_id: null, verification_url: null, user_code: null,
    message: 'Not connected.', can_cancel: false, raw_output_included: false,
    technical_details_included: false
  });
  await cp(path.join(repoRoot, 'dist', 'control-center'), path.join(cwd, 'dist', 'control-center'), { recursive: true });
  const started = await startControlCenterServer({ port: 0, authorizationMode: 'paired' }, {
    cwd,
    env: { PATH: '' },
    now: () => new Date(fixedNow),
    controlCenterCodexLoginManager: {
      status: () => idleLogin,
      async start() { return { ok: false }; },
      async cancel() { return { ok: false }; },
      markFinalized: () => idleLogin,
      async dispose() { loginManagerDisposed = true; }
    },
    async controlCenterAiUpstreamFetch(url, options = {}) {
      modelRequestCount += 1;
      assert.equal(String(url), 'https://api.openai.com/v1/models');
      assert.equal(options.redirect, 'error');
      assert.equal(acceptedCredentials.has(String(options.headers.authorization).replace(/^Bearer /u, '')), true);
      return new Response(JSON.stringify({
        data: [
          { id: 'gpt-5.6-sol', created: 2 },
          { id: 'gpt-5.6-terra', created: 1 },
          { id: 'embedding-browser', created: 3 }
        ]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    async startControlCenterResponsesAdapter(_options, adapterContext) {
      adapterStartCount += 1;
      for (const credential of acceptedCredentials) {
        assert.doesNotMatch(JSON.stringify(adapterContext.env), new RegExp(credential));
      }
      return {
        url: 'http://127.0.0.1:34569/agentic-human-review',
        async close() { adapterClosed = true; }
      };
    }
  });
  testWorkspace.trackServer(started.server);
  let browser = null;
  let flowCompleted = false;
  let releaseLostReplacement;
  try {
    browser = await chromium.launch();
    testWorkspace.trackBrowser(browser);
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const consoleErrors = [];
    let apiKeyRequest = null;
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/settings/ai-setup/key') {
        apiKeyRequest = { url: request.url(), headers: request.headers(), body: request.postData() };
      }
    });
    await page.route('**/api/settings/ai-setup/key', async (route) => {
      const response = await route.fetch();
      assert.equal(response.ok(), true);
      await route.abort('failed');
    }, { times: 1 });

    const paired = await issueControlCenterPairingUrl(started);
    await page.goto(paired.url, { waitUntil: 'networkidle' });
    await page.locator('[data-testid="tc-cc-home"]').waitFor();
    assert.equal(new URL(page.url()).hash, '');
    assert.doesNotMatch(page.url(), new RegExp(paired.token));

    await page.getByRole('button', { name: /New review/ }).click();
    const newReview = page.locator('[data-testid="tc-cc-new-review"]');
    await newReview.waitFor();
    const draftUrl = 'https://example.jp/preserved-ai-setup';
    const draftPurpose = 'Keep this goal while connecting AI.';
    await page.getByLabel('URL to review').fill(draftUrl);
    await page.getByLabel('What do you want to make easier?').fill(draftPurpose);
    await page.getByRole('radio', { name: 'Find improvements in more detail' }).check();
    await page.getByRole('button', { name: 'Set up AI' }).click();

    const dialog = page.getByRole('dialog', { name: 'Set up AI' });
    await dialog.waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'ai-setup-title');
    const workspaceBox = await page.locator('.workspace').boundingBox();
    const dialogBox = await dialog.boundingBox();
    assertCloseMetric(dialogBox.x + (dialogBox.width / 2), workspaceBox.x + (workspaceBox.width / 2), 2, 'AI setup dialog workspace center');
    assert.doesNotMatch(await dialog.innerText(), /terminal|command|provider|endpoint|environment|file path/i);
    const mockSetupPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await mockSetupPage.goto(`${controlCenterMockUrl}?screen=new&ai=setup-required&dialog=ai-setup`, { waitUntil: 'load' });
    const productionRecommendation = dialog.locator('.ai-service-choice .recommended');
    const mockRecommendation = mockSetupPage.locator('.ai-service-choice .recommend');
    assert.equal(
      await productionRecommendation.evaluate((element) => getComputedStyle(element).backgroundColor),
      await mockRecommendation.evaluate((element) => getComputedStyle(element).backgroundColor)
    );
    assert.equal(
      await productionRecommendation.evaluate((element) => getComputedStyle(element).paddingInlineStart),
      await mockRecommendation.evaluate((element) => getComputedStyle(element).paddingInlineStart)
    );
    await mockSetupPage.close();

    await dialog.getByText('Use another method', { exact: true }).click();
    await dialog.getByRole('button', { name: /OpenAI/ }).click();
    const keyInput = dialog.getByLabel('API key');
    assert.equal(await keyInput.getAttribute('type'), 'password');
    assert.equal(await keyInput.getAttribute('autocomplete'), 'off');
    await keyInput.fill(apiCredentialValue);
    const initialApiKeyRequestFailed = page.waitForEvent('requestfailed', {
      predicate: (request) => new URL(request.url()).pathname === '/api/settings/ai-setup/key'
        && request.method() === 'POST',
      timeout: CONTROL_CENTER_RESPONSE_OBSERVATION_TIMEOUT_MS
    });
    await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
    await initialApiKeyRequestFailed;
    await dialog.getByText('Connected', { exact: true }).waitFor({
      timeout: CONTROL_CENTER_RESPONSE_OBSERVATION_TIMEOUT_MS
    });
    assert.match(await dialog.innerText(), /Connected[\s\S]*OpenAI/);
    assert.equal(await dialog.locator('.inline-notice.danger').count(), 0);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });

    assert.equal(modelRequestCount, 1);
    assert.equal(adapterStartCount, 1);
    assert.ok(apiKeyRequest);
    assert.doesNotMatch(apiKeyRequest.url, new RegExp(apiCredentialValue));
    assert.doesNotMatch(JSON.stringify(apiKeyRequest.headers), new RegExp(apiCredentialValue));
    assert.match(apiKeyRequest.headers['content-type'], /^application\/octet-stream\b/u);
    assert.equal(apiKeyRequest.body, apiCredentialValue);
    assert.equal(await page.getByLabel('URL to review').inputValue(), draftUrl);
    assert.equal(await page.getByLabel('What do you want to make easier?').inputValue(), draftPurpose);
    assert.equal(await page.getByRole('radio', { name: 'Find improvements in more detail' }).isChecked(), true);
    assert.equal(await page.getByRole('dialog', { name: 'Start this review?' }).count(), 0);
    assert.equal(new URL(page.url()).searchParams.get('view'), 'new');
    assert.equal(await page.getByRole('button', { name: 'Prepare review', exact: true }).isEnabled(), true);

    const browserState = await page.evaluate(() => ({
      url: window.location.href,
      local: JSON.stringify(localStorage),
      session: JSON.stringify(sessionStorage),
      html: document.documentElement.innerHTML
    }));
    assert.doesNotMatch(JSON.stringify(browserState), new RegExp(apiCredentialValue));

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.locator('[data-testid="tc-cc-settings"]').waitFor();
    const setupButton = page.getByRole('button', { name: 'Change connection', exact: true });
    await setupButton.click();
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /Connected[\s\S]*OpenAI/);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await setupButton.evaluate((element) => element === document.activeElement), true);

    await setupButton.click();
    await dialog.getByRole('button', { name: 'Change API key', exact: true }).click();
    await dialog.getByLabel('API key').fill(replacementCredentialValue);
    await page.route('**/api/settings/ai-setup/intents', async (route) => {
      const response = await route.fetch();
      assert.equal(response.ok(), true);
      await route.abort('failed');
    }, { times: 1 });
    await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
    await dialog.locator('.inline-notice.danger').waitFor();
    assert.equal(await dialog.getByLabel('API key').count(), 1);
    assert.equal(modelRequestCount, 1);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });

    let observeLostReplacement;
    const lostReplacementObserved = new Promise((resolve) => { observeLostReplacement = resolve; });
    const lostReplacementGate = new Promise((resolve) => { releaseLostReplacement = resolve; });
    await setupButton.click();
    await dialog.getByRole('button', { name: 'Change API key', exact: true }).click();
    await dialog.getByLabel('API key').fill(replacementCredentialValue);
    await page.route('**/api/settings/ai-setup/key', async (route) => {
      const response = await route.fetch();
      assert.equal(response.ok(), true);
      observeLostReplacement();
      await lostReplacementGate;
      try {
        await route.abort('failed');
      } catch (error) {
        if (!isExpectedRouteCleanupError(error)) throw error;
      }
    }, { times: 1 });
    const lostReplacementRequestFailed = page.waitForEvent('requestfailed', {
      predicate: (request) => new URL(request.url()).pathname === '/api/settings/ai-setup/key'
        && request.method() === 'POST',
      timeout: CONTROL_CENTER_RESPONSE_OBSERVATION_TIMEOUT_MS
    });
    await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
    await lostReplacementObserved;

    const competingPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const competingPair = await issueControlCenterPairingUrl(started);
    await competingPage.goto(competingPair.url, { waitUntil: 'networkidle' });
    await competingPage.getByRole('button', { name: 'Settings', exact: true }).click();
    const competingDialog = competingPage.getByRole('dialog', { name: 'Set up AI' });
    await competingPage.getByRole('button', { name: 'Change connection', exact: true }).click();
    await competingDialog.getByRole('button', { name: 'Change API key', exact: true }).click();
    await competingDialog.getByLabel('API key').fill(competingCredentialValue);
    await competingDialog.getByRole('button', { name: 'Connect', exact: true }).click();
    await competingDialog.waitFor({ state: 'hidden' });
    await activateObservedPage(page);
    releaseLostReplacement();
    await lostReplacementRequestFailed;
    await dialog.getByText('Connected', { exact: true }).waitFor({
      timeout: CONTROL_CENTER_RESPONSE_OBSERVATION_TIMEOUT_MS
    });
    assert.equal(await dialog.isVisible(), true);
    assert.equal(await dialog.locator('.inline-notice.danger').count(), 0);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await competingPage.close();

    await page.setViewportSize({ width: 390, height: 844 });
    await setupButton.click();
    await dialog.waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
    const closeButton = dialog.getByRole('button', { name: 'Close' });
    const closeBox = await closeButton.boundingBox();
    assert.ok(closeBox.width >= 44 && closeBox.height >= 44);
    await closeButton.click();
    assert.deepEqual(consoleErrors.filter((message) => !/Failed to load resource: net::ERR_FAILED/u.test(message)), []);
    flowCompleted = true;
  } finally {
    releaseLostReplacement?.();
    if (browser) await browser.close();
    await started.close();
    if (flowCompleted) {
      assert.equal(loginManagerDisposed, true);
      assert.equal(adapterClosed, true);
    }
  }
});

test('paired review center completes repeated subscription polling with accessible responsive setup states', { skip: !runBrowserSmoke }, async (t) => {
  const testWorkspace = await createBrowserTestWorkspace('trace-cue-control-center-subscription-setup-browser-');
  t.after(() => testWorkspace.cleanup());
  const { cwd } = testWorkspace;
  const providerResolution = resolveAgenticHumanReviewProvider({ providerId: 'codex-subscription-cli', context: {} });
  assert.equal(providerResolution.ok, true);
  const provider = providerResolution.provider;
  let startedLogin = false;
  let finalized = false;
  let loginReady = false;
  let statusReads = 0;
  let loginAttempt = 0;
  let loginPhase = 'idle';
  let cancelAttempts = 0;
  const loginState = (status, values = {}) => Object.freeze({
    status,
    operation_id: startedLogin ? 'browser-subscription-login' : null,
    verification_url: null,
    user_code: null,
    message: 'Subscription sign-in test state.',
    can_cancel: ['starting', 'waiting', 'checking'].includes(status),
    raw_output_included: false,
    technical_details_included: false,
    ...values
  });
  const idleLogin = loginState('idle');
  const loginManager = {
    status() {
      if (finalized) return loginState('complete');
      if (!startedLogin) return idleLogin;
      if (loginPhase === 'cancelled') return loginState('cancelled', { can_cancel: false });
      statusReads += 1;
      if (loginAttempt === 1) {
        return loginState('waiting', {
          verification_url: 'https://auth.openai.com/codex/device',
          user_code: 'BROW-SER1'
        });
      }
      if (statusReads <= 2) {
        return loginState('waiting', {
          verification_url: 'https://auth.openai.com/codex/device',
          user_code: 'BROW-SER1'
        });
      }
      if (statusReads === 3) return loginState('checking');
      loginReady = true;
      return loginState('connected', { can_cancel: false });
    },
    async start() {
      startedLogin = true;
      loginAttempt += 1;
      loginPhase = 'active';
      statusReads = 0;
      return { ok: true, login: loginState('starting') };
    },
    async cancel() {
      cancelAttempts += 1;
      if (cancelAttempts === 1) {
        loginPhase = 'cancelled';
        return { ok: true, login: loginState('cancelled', { can_cancel: false }) };
      }
      return {
        ok: false,
        error: {
          code: 'CONTROL_CENTER_CODEX_LOGIN_CANCEL_FAILED',
          message: 'The deterministic browser cancellation failed.'
        }
      };
    },
    markFinalized() { finalized = true; return loginState('complete', { can_cancel: false }); },
    async dispose() {}
  };
  const connection = {
    id: 'codex-subscription',
    display_name: 'Codex',
    connection_type: 'subscription',
    status: 'available',
    status_message: 'Ready to use with your signed-in Codex account.',
    adapter_id: 'codex-subscription-cli',
    adapter_version: '1.0.0',
    provider_id: provider.id,
    transport: provider.transport,
    execution_strategy: 'one-shot',
    provider_effort_request_field: provider.effort_capability.native_effort_binding.request_field,
    provider_capability_hash: agenticProviderCapabilityHash(provider),
    executable_identity_hash: 'c'.repeat(64),
    models: [{
      id: 'gpt-5.6-sol',
      display_name: 'GPT-5.6 Sol',
      native_efforts: [
        { id: 'low', display_name: 'Low' },
        { id: 'medium', display_name: 'Medium' },
        { id: 'high', display_name: 'High' },
        { id: 'xhigh', display_name: 'Xhigh' },
        { id: 'max', display_name: 'Max' }
      ],
      default_native_effort_id: 'medium'
    }],
    default_model_id: 'gpt-5.6-sol'
  };
  await cp(path.join(repoRoot, 'dist', 'control-center'), path.join(cwd, 'dist', 'control-center'), { recursive: true });
  const started = await startControlCenterServer({ port: 0, authorizationMode: 'paired' }, {
    cwd,
    now: () => new Date(fixedNow),
    controlCenterCodexLoginManager: loginManager,
    async discoverControlCenterAiConnections() {
      return {
        connections: loginReady ? [connection] : [],
        selection: null,
        boundary: { process_spawned: false, network_used: false, credential_values_read: false }
      };
    }
  });
  testWorkspace.trackServer(started.server);
  let browser = null;
  let releaseOldStatus;
  let releaseFirstFinish;
  let releaseSecondFinish;
  try {
    browser = await chromium.launch();
    testWorkspace.trackBrowser(browser);
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    let observeOldStatus;
    const oldStatusObserved = new Promise((resolve) => { observeOldStatus = resolve; });
    const oldStatusGate = new Promise((resolve) => { releaseOldStatus = resolve; });
    await page.route('**/api/settings/ai-setup/subscription/status', async (route) => {
      observeOldStatus();
      await oldStatusGate;
      try {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok', data: { subscription_login: idleLogin } })
        });
      } catch (error) {
        if (!isExpectedRouteCleanupError(error)) throw error;
      }
    }, { times: 1 });
    await page.route('**/api/settings/ai-setup/subscription/start', async (route) => {
      const response = await route.fetch();
      assert.equal(response.ok(), true);
      await route.abort('failed');
    }, { times: 1 });
    const paired = await issueControlCenterPairingUrl(started);
    await page.goto(paired.url, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'New review' }).click();
    await page.getByRole('button', { name: 'Set up AI' }).click();
    const dialog = page.getByRole('dialog', { name: 'Set up AI' });
    await oldStatusObserved;
    await dialog.getByRole('button', { name: /Codex/ }).click();
    releaseOldStatus();

    const signInLink = dialog.getByRole('link', { name: /Open sign-in page/ });
    await signInLink.waitFor({ timeout: 10_000 });
    assert.equal(await signInLink.evaluate((element) => {
      element.focus();
      return element === document.activeElement;
    }), true);
    await page.route('**/api/settings/ai-setup/subscription/cancel', async (route) => {
      const response = await route.fetch();
      assert.equal(response.ok(), true);
      await route.abort('failed');
    }, { times: 1 });
    await dialog.getByRole('button', { name: 'Stop sign-in', exact: true }).click();
    await dialog.getByText('Sign-in was cancelled', { exact: true }).waitFor();
    assert.equal(await dialog.locator('.inline-notice.danger').count(), 0);

    await dialog.getByRole('button', { name: 'Try again', exact: true }).click();
    await dialog.getByRole('link', { name: /Open sign-in page/ }).waitFor({ timeout: 10_000 });
    let observeFirstFinish;
    let observeSecondFinish;
    const firstFinishObserved = new Promise((resolve) => { observeFirstFinish = resolve; });
    const firstFinishGate = new Promise((resolve) => { releaseFirstFinish = resolve; });
    const secondFinishObserved = new Promise((resolve) => { observeSecondFinish = resolve; });
    const secondFinishGate = new Promise((resolve) => { releaseSecondFinish = resolve; });
    await page.route('**/api/settings/ai-setup/subscription/finish', async (route) => {
      observeFirstFinish();
      await firstFinishGate;
      try {
        const response = await route.fetch();
        assert.equal(response.ok(), true);
        await route.fulfill({ response });
      } catch (error) {
        if (!isExpectedRouteCleanupError(error)) throw error;
      }
    }, { times: 1 });
    await dialog.getByRole('button', { name: 'Stop sign-in', exact: true }).click();
    await dialog.getByText('Checking sign-in...', { exact: true }).waitFor({ timeout: 10_000 });
    const progressMark = dialog.locator('.ai-setup-progress span');
    assert.equal(await progressMark.evaluate((element) => getComputedStyle(element).animationName), 'none');
    await page.waitForFunction(() => document.activeElement?.id === 'ai-setup-title');

    const secondPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const secondPair = await issueControlCenterPairingUrl(started);
    await secondPage.route('**/api/settings/ai-setup/subscription/finish', async (route) => {
      observeSecondFinish();
      await secondFinishGate;
      try {
        const response = await route.fetch();
        assert.equal(response.status(), 409);
        assert.match(JSON.stringify(await response.json()), /CONTROL_CENTER_CODEX_LOGIN_NOT_READY/u);
        await route.fulfill({ response });
      } catch (error) {
        if (!isExpectedRouteCleanupError(error)) throw error;
      }
    }, { times: 1 });
    await secondPage.goto(secondPair.url, { waitUntil: 'networkidle' });
    await secondPage.getByRole('button', { name: 'New review' }).click();
    await secondPage.getByRole('button', { name: 'Set up AI' }).click();
    const secondDialog = secondPage.getByRole('dialog', { name: 'Set up AI' });
    await Promise.all([firstFinishObserved, secondFinishObserved]);
    await releaseGateForObservedPage(page, releaseFirstFinish);
    await dialog.waitFor({
      state: 'hidden',
      timeout: CONTROL_CENTER_RESPONSE_OBSERVATION_TIMEOUT_MS
    });
    await releaseGateForObservedPage(secondPage, releaseSecondFinish);
    try {
      await secondDialog.waitFor({
        state: 'hidden',
        timeout: CONTROL_CENTER_RESPONSE_OBSERVATION_TIMEOUT_MS
      });
    } catch (caught) {
      const safeDialogText = await secondDialog.isVisible()
        ? (await secondDialog.innerText({ timeout: 1_000 })).replace(/\s+/gu, ' ').trim()
        : '[dialog is no longer visible]';
      throw new Error(`The competing sign-in dialog stayed open: ${safeDialogText}`, { cause: caught });
    }
    assert.equal(await secondPage.locator('.inline-notice.danger:visible').count(), 0);
    await secondPage.close();
    assert.ok(statusReads >= 4);
    assert.equal(cancelAttempts, 2);

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const changeConnection = page.getByRole('button', { name: 'Change connection', exact: true });
    await changeConnection.click();
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /Connected[\s\S]*Codex/);
    assert.equal(await dialog.getByRole('button', { name: 'Disconnect', exact: true }).count(), 0);
    assert.equal(await dialog.getByRole('button', { name: /Codex/ }).count(), 0);
    assert.doesNotMatch(await dialog.innerText(), /AI setup is not available right now/);

    await page.setViewportSize({ width: 320, height: 700 });
    const narrowOverflow = await page.evaluate(() => ({
      amount: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      elements: [...document.querySelectorAll('body *')].map((element) => {
        const box = element.getBoundingClientRect();
        return { tag: element.tagName, className: element.className, left: box.left, right: box.right, width: box.width };
      }).filter((item) => item.left < -1 || item.right > window.innerWidth + 1).slice(0, 12)
    }));
    assert.equal(narrowOverflow.amount, 0, JSON.stringify(narrowOverflow));
    await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
    await page.setViewportSize({ width: 640, height: 900 });
    await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1);
  } finally {
    releaseOldStatus?.();
    releaseFirstFinish?.();
    releaseSecondFinish?.();
    if (browser) await browser.close();
    await started.close();
  }
});

test('paired review center hard reload gives a clear reopen path instead of a futile retry', { skip: !runBrowserSmoke }, async (t) => {
  const testWorkspace = await createBrowserTestWorkspace('trace-cue-control-center-session-reopen-browser-');
  t.after(() => testWorkspace.cleanup());
  const { cwd } = testWorkspace;
  await cp(path.join(repoRoot, 'dist', 'control-center'), path.join(cwd, 'dist', 'control-center'), { recursive: true });
  const started = await startControlCenterServer({ port: 0, authorizationMode: 'paired' }, { cwd });
  testWorkspace.trackServer(started.server);
  let browser = null;
  let releaseStalledPairing;
  try {
    browser = await chromium.launch();
    testWorkspace.trackBrowser(browser);
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const paired = await issueControlCenterPairingUrl(started);
    await page.goto(paired.url, { waitUntil: 'networkidle' });
    await page.locator('[data-testid="tc-cc-home"]').waitFor();
    await page.reload({ waitUntil: 'networkidle' });
    const reopenHeading = ['Open the', 'Control', 'Center again'].join(' ');
    await page.getByRole('heading', { name: reopenHeading, exact: true }).waitFor();
    assert.match(await page.locator('.workspace').innerText(), /private browser session has ended/i);
    assert.equal(await page.getByRole('button', { name: 'Try again', exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
    await page.close();

    const stalledPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await activateObservedPage(stalledPage);
    const stalledPair = await issueControlCenterPairingUrl(started);
    let observeStalledPairing;
    const stalledPairingObserved = new Promise((resolve) => { observeStalledPairing = resolve; });
    const stalledPairingGate = new Promise((resolve) => { releaseStalledPairing = resolve; });
    await stalledPage.route('**/api/pairing/exchange', async (route) => {
      const response = await route.fetch();
      assert.equal(response.ok(), true);
      observeStalledPairing();
      await stalledPairingGate;
      try {
        await route.abort('failed');
      } catch (error) {
        if (!isExpectedRouteCleanupError(error)) throw error;
      }
    }, { times: 1 });
    await stalledPage.goto(stalledPair.url, { waitUntil: 'domcontentloaded' });
    await stalledPairingObserved;
    await activateObservedPage(stalledPage);
    try {
      await stalledPage.getByRole('heading', { name: reopenHeading, exact: true }).waitFor({
        timeout: CONTROL_CENTER_RESPONSE_OBSERVATION_TIMEOUT_MS
      });
    } catch (caught) {
      const safeSnapshot = await stalledPage.evaluate(() => ({
        visibility: document.visibilityState,
        headings: [...document.querySelectorAll('h1, h2')]
          .map((element) => element.textContent?.replace(/\s+/gu, ' ').trim())
          .filter(Boolean),
        workspace: document.querySelector('.workspace')?.textContent?.replace(/\s+/gu, ' ').trim() ?? ''
      }));
      throw new Error(`Stalled pairing did not reach the reopen state: ${JSON.stringify(safeSnapshot)}`, {
        cause: caught
      });
    }
    assert.equal(await stalledPage.getByRole('button', { name: 'Try again', exact: true }).count(), 0);
    assert.equal(await stalledPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
    releaseStalledPairing();
  } finally {
    releaseStalledPairing?.();
    if (browser) await browser.close();
    await started.close();
  }
});

test('review workspace ignores a late status response from the previous route', { skip: !runBrowserSmoke }, async (t) => {
  const testWorkspace = await createBrowserTestWorkspace('trace-cue-review-status-ordering-');
  t.after(() => testWorkspace.cleanup());
  const { cwd } = testWorkspace;
  await cp(path.join(repoRoot, 'dist', 'control-center'), path.join(cwd, 'dist', 'control-center'), { recursive: true });
  const started = await startControlCenterServer({ port: 0 }, controlCenterReviewContext(cwd));
  testWorkspace.trackServer(started.server);
  let browser = null;
  let releaseOldResponse;
  let observeOldRequest;
  const oldResponseGate = new Promise((resolve) => { releaseOldResponse = resolve; });
  const oldRequestObserved = new Promise((resolve) => { observeOldRequest = resolve; });
  const oldId = 'control-center-agentic-review-browser-old';
  const newId = 'control-center-agentic-review-browser-new';
  const operation = (id, target) => ({
    schema_version: '2.0.0',
    type: 'control_center_agentic_review',
    id,
    state: 'completed',
    stage: 'complete',
    created_at: fixedNow,
    updated_at: fixedNow,
    completed_at: fixedNow,
    target,
    purpose: `Review ${target}`,
    review_effort: 'standard',
    ai_suggestions: false,
    service: { name: 'Local review', external_ai: false },
    decisions: [],
    result: { findings: [] }
  });
  try {
    browser = await chromium.launch();
    testWorkspace.trackBrowser(browser);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const consoleErrors = [];
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await page.route('**/api/agentic-review/status?*', async (route) => {
      const id = new URL(route.request().url()).searchParams.get('id');
      if (id === oldId) {
        observeOldRequest();
        await oldResponseGate;
      }
      const selected = id === oldId ? operation(oldId, 'OLD REVIEW') : operation(newId, 'NEW REVIEW');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'ok',
          data: { control_center_agentic_review: { operation: selected } },
          warnings: [],
          errors: [],
          artifacts: []
        })
      });
    });

    await page.goto(`${started.url}?view=work&item=${oldId}`, { waitUntil: 'domcontentloaded' });
    await oldRequestObserved;
    await page.evaluate((id) => {
      window.history.pushState(null, '', `/?view=work&item=${encodeURIComponent(id)}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, newId);
    await page.getByRole('heading', { name: 'NEW REVIEW', exact: true }).waitFor();
    releaseOldResponse();
    await page.waitForTimeout(100);
    assert.equal(await page.locator('[data-page-heading]').innerText(), 'NEW REVIEW');
    assert.equal(new URL(page.url()).searchParams.get('item'), newId);
    const unexpectedConsoleErrors = consoleErrors.filter((message) => !/Failed to load resource: net::ERR_FAILED/u.test(message));
    assert.equal(unexpectedConsoleErrors.length, 0, JSON.stringify(unexpectedConsoleErrors));
  } finally {
    releaseOldResponse?.();
    if (browser) await browser.close();
    await closeServer(started.server);
  }
});

test('review center bounds a stalled local read without relying on browser abort behavior', { skip: !runBrowserSmoke }, async (t) => {
  const testWorkspace = await createBrowserTestWorkspace('trace-cue-control-center-response-bound-');
  t.after(() => testWorkspace.cleanup());
  const { cwd } = testWorkspace;
  await cp(path.join(repoRoot, 'dist', 'control-center'), path.join(cwd, 'dist', 'control-center'), { recursive: true });
  const started = await startControlCenterServer({ port: 0 }, controlCenterReviewContext(cwd));
  testWorkspace.trackServer(started.server);
  let browser = null;
  let releaseDashboard;
  let observeDashboard;
  const dashboardGate = new Promise((resolve) => { releaseDashboard = resolve; });
  const dashboardObserved = new Promise((resolve) => { observeDashboard = resolve; });
  try {
    browser = await chromium.launch();
    testWorkspace.trackBrowser(browser);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.route('**/api/dashboard', async (route) => {
      observeDashboard();
      await dashboardGate;
      try {
        await route.abort('failed');
      } catch (error) {
        if (!isExpectedRouteCleanupError(error)) throw error;
      }
    }, { times: 1 });

    await page.goto(started.url, { waitUntil: 'domcontentloaded' });
    await dashboardObserved;
    await activateObservedPage(page);
    await page.getByRole('heading', { name: 'Your reviews could not be loaded', exact: true }).waitFor({
      timeout: CONTROL_CENTER_RESPONSE_OBSERVATION_TIMEOUT_MS
    });
    assert.equal(await page.getByRole('button', { name: 'Try again', exact: true }).isEnabled(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
    releaseDashboard();
  } finally {
    releaseDashboard?.();
    if (browser) await browser.close();
    await closeServer(started.server);
  }
});

test('review center keeps the chosen page when prepare and repeat responses finish late', { skip: !runBrowserSmoke }, async (t) => {
  const testWorkspace = await createBrowserTestWorkspace('trace-cue-control-center-late-navigation-');
  t.after(() => testWorkspace.cleanup());
  const { cwd } = testWorkspace;
  await cp(path.join(repoRoot, 'dist', 'control-center'), path.join(cwd, 'dist', 'control-center'), { recursive: true });
  const started = await startControlCenterServer({ port: 0 }, controlCenterReviewContext(cwd));
  testWorkspace.trackServer(started.server);
  let browser = null;
  let releasePrepare;
  let releaseRepeat;
  try {
    browser = await chromium.launch();
    testWorkspace.trackBrowser(browser);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`${started.url}?view=new`, { waitUntil: 'networkidle' });

    let observePrepare;
    const prepareObserved = new Promise((resolve) => { observePrepare = resolve; });
    const prepareGate = new Promise((resolve) => { releasePrepare = resolve; });
    await page.route('**/api/agentic-review/prepare', async (route) => {
      const response = await route.fetch();
      assert.equal(response.ok(), true);
      observePrepare();
      await prepareGate;
      try {
        await route.fulfill({ response });
      } catch (error) {
        if (!isExpectedRouteCleanupError(error)) throw error;
      }
    }, { times: 1 });
    await page.getByLabel('URL to review').fill('https://example.jp/late-prepare');
    await page.getByLabel('What do you want to make easier?').fill('Stay on the page I choose while preparation finishes.');
    const continueWithoutAi = page.getByLabel('Continue without AI');
    if (await continueWithoutAi.count()) await continueWithoutAi.check();
    await page.getByRole('button', { name: 'Prepare review', exact: true }).click();
    await prepareObserved;
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
    releasePrepare();
    await page.waitForTimeout(250);
    assert.equal(new URL(page.url()).searchParams.get('page'), 'settings');
    assert.equal(await page.getByRole('heading', { name: 'Settings', exact: true }).count(), 1);

    const parentId = 'control-center-agentic-review-late-repeat-parent';
    const childId = 'control-center-agentic-review-late-repeat-child';
    const operation = (id, state = 'completed') => ({
      schema_version: '2.0.0',
      type: 'control_center_agentic_review',
      id,
      state,
      stage: state === 'completed' ? 'complete' : 'prepare',
      created_at: fixedNow,
      updated_at: fixedNow,
      completed_at: state === 'completed' ? fixedNow : null,
      target: 'LATE RESPONSE REVIEW',
      purpose: 'Keep explicit navigation authoritative.',
      review_effort: 'standard',
      ai_suggestions: false,
      service: { name: 'Local review', external_ai: false },
      decisions: [],
      result: state === 'completed' ? { findings: [] } : null
    });
    await page.route('**/api/agentic-review/status?*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'ok',
          data: { control_center_agentic_review: { operation: operation(parentId) } },
          warnings: [],
          errors: [],
          artifacts: []
        })
      });
    });
    let observeRepeat;
    const repeatObserved = new Promise((resolve) => { observeRepeat = resolve; });
    const repeatGate = new Promise((resolve) => { releaseRepeat = resolve; });
    await page.route('**/api/agentic-review/repeat', async (route) => {
      observeRepeat();
      await repeatGate;
      try {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'ok',
            data: { control_center_agentic_review: { operation: operation(childId, 'preparing') } },
            warnings: [],
            errors: [],
            artifacts: []
          })
        });
      } catch (error) {
        if (!isExpectedRouteCleanupError(error)) throw error;
      }
    }, { times: 1 });

    await page.goto(`${started.url}?view=work&item=${parentId}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'LATE RESPONSE REVIEW', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Review in more detail', exact: true }).click();
    await repeatObserved;
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
    releaseRepeat();
    await page.waitForTimeout(250);
    assert.equal(new URL(page.url()).searchParams.get('page'), 'settings');
    assert.equal(new URL(page.url()).searchParams.get('item'), null);
    assert.equal(await page.getByRole('heading', { name: 'Settings', exact: true }).count(), 1);
  } finally {
    releasePrepare?.();
    releaseRepeat?.();
    if (browser) await browser.close();
    await closeServer(started.server);
  }
});

test('review center preserves an AI choice draft when another settings page wins the revision', { skip: !runBrowserSmoke }, async (t) => {
  const testWorkspace = await createBrowserTestWorkspace('trace-cue-ai-settings-conflict-');
  t.after(() => testWorkspace.cleanup());
  const { cwd } = testWorkspace;
  await cp(path.join(repoRoot, 'dist', 'control-center'), path.join(cwd, 'dist', 'control-center'), { recursive: true });
  const reviewContext = controlCenterReviewContext(cwd);
  const discoverAiConnections = reviewContext.discoverControlCenterAiConnections;
  let useAlternateAiCatalog = false;
  reviewContext.discoverControlCenterAiConnections = async () => {
    const discovered = await discoverAiConnections();
    return useAlternateAiCatalog ? {
      ...discovered,
      connections: discovered.connections.map((connection) => ({
        ...connection,
        id: `${connection.id}-alternate`
      }))
    } : discovered;
  };
  const started = await startControlCenterServer({ port: 0 }, reviewContext);
  testWorkspace.trackServer(started.server);
  let browser = null;
  let releaseLostSelection;
  try {
    browser = await chromium.launch();
    testWorkspace.trackBrowser(browser);
    const first = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const second = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const consoleErrors = [];
    first.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    second.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });

    await first.goto(started.url, { waitUntil: 'networkidle' });
    await first.getByRole('button', { name: 'Settings', exact: true }).click();
    await first.getByRole('button', { name: 'Update availability', exact: true }).click();
    await first.getByText('Available', { exact: true }).waitFor();

    await second.goto(started.url, { waitUntil: 'networkidle' });
    await second.getByRole('button', { name: 'Settings', exact: true }).click();
    await second.locator('[data-testid="tc-cc-settings"]').waitFor();

    await first.getByRole('button', { name: 'Change', exact: true }).click();
    await first.getByText('AI details', { exact: true }).click();
    await first.getByLabel('AI processing level').selectOption({ label: 'High' });

    await second.getByRole('button', { name: 'Change', exact: true }).click();
    await second.getByText('AI details', { exact: true }).click();
    await second.getByLabel('AI processing level').selectOption({ label: 'Low' });
    await second.getByRole('button', { name: 'Use this AI', exact: true }).click();
    await second.getByText('AI choice updated.', { exact: true }).waitFor();

    await first.getByRole('button', { name: 'Save settings', exact: true }).click();
    const conflict = first.locator('.inline-notice.warning').filter({ hasText: 'AI settings could not be updated' });
    await conflict.waitFor();
    assert.equal(await first.getByLabel('AI processing level').locator('option:checked').innerText(), 'High');
    assert.equal(await conflict.getByRole('button', { name: 'Load latest choices', exact: true }).count(), 1);
    assert.equal(await first.getByRole('button', { name: 'Use this AI', exact: true }).isDisabled(), true);
    assert.doesNotMatch(await first.locator('[data-testid="tc-cc-settings"]').innerText(), /browser-test-secret|review\.example\.test|generic-api-provider|browser-api-adapter/i);

    await conflict.getByRole('button', { name: 'Load latest choices', exact: true }).click();
    await conflict.waitFor({ state: 'detached' });
    assert.equal(await first.getByLabel('AI processing level').locator('option:checked').innerText(), 'Low');
    let savedDashboard = await first.evaluate(async () => (await (await fetch('/api/dashboard')).json()).data.control_center);
    assert.equal(savedDashboard.ai_connections.selection.effort_name, 'Low');

    await first.getByLabel('AI processing level').selectOption({ label: 'High' });
    await first.route('**/api/settings/ai-connections/selection', async (route) => {
      const response = await route.fetch();
      assert.equal(response.ok(), true);
      await route.abort('failed');
    }, { times: 1 });
    await first.getByRole('button', { name: 'Use this AI', exact: true }).click();
    await first.getByText('AI choice updated.', { exact: true }).waitFor();
    assert.equal(await first.locator('.inline-notice.warning').filter({ hasText: 'AI settings could not be updated' }).count(), 0);
    assert.equal(await first.getByLabel('AI processing level').locator('option:checked').innerText(), 'High');
    savedDashboard = await first.evaluate(async () => (await (await fetch('/api/dashboard')).json()).data.control_center);
    assert.equal(savedDashboard.ai_connections.selection.effort_name, 'High');

    await first.getByLabel('AI processing level').selectOption({ label: 'Low' });
    await second.reload({ waitUntil: 'networkidle' });
    await second.locator('[data-testid="tc-cc-settings"]').waitFor();
    await second.getByRole('button', { name: 'Change', exact: true }).click();
    await second.getByText('AI details', { exact: true }).click();
    await second.getByLabel('AI processing level').selectOption({ label: 'Medium · Recommended' });

    let observeLostSelection;
    const lostSelectionGate = new Promise((resolve) => { releaseLostSelection = resolve; });
    const lostSelectionObserved = new Promise((resolve) => { observeLostSelection = resolve; });
    const lostSelectionRequestFailed = first.waitForEvent('requestfailed', {
      predicate: (request) => new URL(request.url()).pathname === '/api/settings/ai-connections/selection'
        && request.method() === 'POST',
      timeout: CONTROL_CENTER_RESPONSE_OBSERVATION_TIMEOUT_MS
    });
    await first.route('**/api/settings/ai-connections/selection', async (route) => {
      observeLostSelection();
      await lostSelectionGate;
      try {
        await route.abort('failed');
      } catch (error) {
        if (!isExpectedRouteCleanupError(error)) throw error;
      }
    }, { times: 1 });
    await first.getByRole('button', { name: 'Use this AI', exact: true }).click();
    await lostSelectionObserved;

    await second.getByRole('button', { name: 'Use this AI', exact: true }).click();
    await second.getByText('AI choice updated.', { exact: true }).waitFor();
    await activateObservedPage(first);
    await first.route('**/api/dashboard', async (route) => {
      await route.abort('failed');
    }, { times: 2 });
    releaseLostSelection();
    await lostSelectionRequestFailed;

    const lostSelectionWarning = first.locator('.inline-notice.warning').filter({ hasText: 'AI settings could not be updated' });
    try {
      await lostSelectionWarning.waitFor({ timeout: CONTROL_CENTER_RESPONSE_OBSERVATION_TIMEOUT_MS });
    } catch (caught) {
      const safeUiState = await first.evaluate(() => ({
        route: `${window.location.pathname}${window.location.search}`,
        test_ids: [...document.querySelectorAll('[data-testid]')]
          .map((element) => element.getAttribute('data-testid'))
          .filter(Boolean)
          .slice(0, 20)
      }));
      throw new Error(`The stale AI choice did not reconcile visibly: ${JSON.stringify(safeUiState)}`, { cause: caught });
    }
    assert.equal(await first.getByText('AI choice updated.', { exact: true }).count(), 0);
    assert.equal(await first.getByLabel('AI processing level').locator('option:checked').innerText(), 'Low');
    savedDashboard = await second.evaluate(async () => (await (await fetch('/api/dashboard')).json()).data.control_center);
    assert.equal(savedDashboard.ai_connections.selection.effort_name, 'Medium');

    const loadLatestChoices = lostSelectionWarning.getByRole('button', { name: 'Load latest choices', exact: true });
    const lostLatestRead = first.waitForEvent('requestfailed', {
      predicate: (request) => new URL(request.url()).pathname === '/api/dashboard'
        && request.method() === 'GET',
      timeout: CONTROL_CENTER_RESPONSE_OBSERVATION_TIMEOUT_MS
    });
    await loadLatestChoices.click();
    await lostLatestRead;
    await first.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => (
      button.textContent?.trim() === 'Load latest choices' && !button.disabled
    )));
    assert.equal(await first.getByRole('button', { name: 'Use this AI', exact: true }).isDisabled(), true);
    await loadLatestChoices.click();
    await lostSelectionWarning.waitFor({ state: 'detached' });
    assert.match(await first.getByLabel('AI processing level').locator('option:checked').innerText(), /^Medium/u);

    const refreshRevision = savedDashboard.ai_connections.revision;
    let observeLostRefresh;
    const lostRefreshObserved = new Promise((resolve) => { observeLostRefresh = resolve; });
    await first.route('**/api/settings/ai-connections/refresh', async (route) => {
      const response = await route.fetch();
      assert.equal(response.ok(), true);
      observeLostRefresh();
      await route.abort('failed');
    }, { times: 1 });
    await first.getByRole('button', { name: 'Update availability', exact: true }).click();
    await lostRefreshObserved;
    await first.waitForFunction(() => document.querySelector('.ai-connection-setting')?.getAttribute('aria-busy') === 'false');
    assert.equal(await first.locator('.ai-connection-setting > .inline-notice.warning').count(), 0);
    savedDashboard = await first.evaluate(async () => (await (await fetch('/api/dashboard')).json()).data.control_center);
    assert.ok(savedDashboard.ai_connections.revision > refreshRevision);

    useAlternateAiCatalog = true;
    await first.getByRole('button', { name: 'Update availability', exact: true }).click();
    const firstChoiceButton = first.getByRole('button', { name: 'Use this AI', exact: true });
    await firstChoiceButton.waitFor();
    const lostInitialSelection = first.waitForEvent('requestfailed', {
      predicate: (request) => new URL(request.url()).pathname === '/api/settings/ai-connections/selection'
        && request.method() === 'POST',
      timeout: CONTROL_CENTER_RESPONSE_OBSERVATION_TIMEOUT_MS
    });
    await first.route('**/api/settings/ai-connections/selection', async (route) => {
      await route.abort('failed');
    }, { times: 1 });
    await first.route('**/api/dashboard', async (route) => {
      await route.abort('failed');
    }, { times: 1 });
    await firstChoiceButton.click();
    await lostInitialSelection;
    const initialChoiceWarning = first.locator('.inline-notice.warning').filter({ hasText: 'AI settings could not be updated' });
    await initialChoiceWarning.waitFor({ timeout: CONTROL_CENTER_RESPONSE_OBSERVATION_TIMEOUT_MS });
    assert.equal(await firstChoiceButton.isDisabled(), true);
    assert.equal(await initialChoiceWarning.getByRole('button', { name: 'Load latest choices', exact: true }).count(), 1);
    await initialChoiceWarning.getByRole('button', { name: 'Load latest choices', exact: true }).click();
    await initialChoiceWarning.waitFor({ state: 'detached' });
    assert.equal(await firstChoiceButton.isEnabled(), true);

    await first.setViewportSize({ width: 390, height: 844 });
    assert.equal(await first.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
    const compactHeights = await first.locator('.primary-action.compact, .secondary-action.compact').evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
    assert.equal(compactHeights.every((height) => height >= 44), true);
    const unexpectedConsoleErrors = consoleErrors.filter((message) => !/Failed to load resource: net::ERR_FAILED/u.test(message));
    assert.equal(unexpectedConsoleErrors.length, 0, JSON.stringify(unexpectedConsoleErrors));
  } finally {
    releaseLostSelection?.();
    if (browser) await browser.close();
    await closeServer(started.server);
  }
});

test('review center preserves a new-review draft when another page refreshes AI availability', { skip: !runBrowserSmoke }, async (t) => {
  const testWorkspace = await createBrowserTestWorkspace('trace-cue-ai-prepare-refresh-');
  t.after(() => testWorkspace.cleanup());
  const { cwd } = testWorkspace;
  await cp(path.join(repoRoot, 'dist', 'control-center'), path.join(cwd, 'dist', 'control-center'), { recursive: true });
  const started = await startControlCenterServer({ port: 0 }, controlCenterReviewContext(cwd));
  testWorkspace.trackServer(started.server);
  let browser = null;
  try {
    browser = await chromium.launch();
    testWorkspace.trackBrowser(browser);
    const reviewPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const settingsPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });

    await settingsPage.goto(`${started.url}?page=settings`, { waitUntil: 'networkidle' });
    const firstRefresh = settingsPage.waitForResponse((response) => response.url().endsWith('/api/settings/ai-connections/refresh') && response.request().method() === 'POST');
    await settingsPage.getByRole('button', { name: 'Update availability', exact: true }).click();
    await firstRefresh;
    await settingsPage.getByText('Available', { exact: true }).waitFor();

    await reviewPage.goto(`${started.url}?view=new`, { waitUntil: 'networkidle' });
    await reviewPage.getByLabel('URL to review').fill('https://example.jp/preserved');
    await reviewPage.getByLabel('What do you want to make easier?').fill('Keep this review goal while AI availability changes.');

    const secondRefresh = settingsPage.waitForResponse((response) => response.url().endsWith('/api/settings/ai-connections/refresh') && response.request().method() === 'POST');
    await settingsPage.getByRole('button', { name: 'Update availability', exact: true }).click();
    const secondRefreshResponse = await secondRefresh;
    assert.equal(secondRefreshResponse.ok(), true);
    await reviewPage.getByRole('button', { name: 'Prepare review', exact: true }).click();
    await reviewPage.getByText('AI availability changed. Your review details are still here; check the current choice and prepare again.', { exact: true }).waitFor();
    assert.equal(await reviewPage.getByLabel('URL to review').inputValue(), 'https://example.jp/preserved');
    assert.equal(await reviewPage.getByLabel('What do you want to make easier?').inputValue(), 'Keep this review goal while AI availability changes.');

    await reviewPage.getByRole('button', { name: 'Prepare review', exact: true }).click();
    const dialog = reviewPage.getByRole('dialog', { name: 'Start this review?' });
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
  } finally {
    if (browser) await browser.close();
    await closeServer(started.server);
  }
});

test('review center ignores an older dashboard response that finishes after a newer save', { skip: !runBrowserSmoke }, async (t) => {
  const testWorkspace = await createBrowserTestWorkspace('trace-cue-dashboard-order-');
  t.after(() => testWorkspace.cleanup());
  const { cwd } = testWorkspace;
  await cp(path.join(repoRoot, 'dist', 'control-center'), path.join(cwd, 'dist', 'control-center'), { recursive: true });
  const started = await startControlCenterServer({ port: 0 }, controlCenterReviewContext(cwd));
  testWorkspace.trackServer(started.server);
  let browser = null;
  try {
    browser = await chromium.launch();
    testWorkspace.trackBrowser(browser);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`${started.url}?page=settings`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Update availability', exact: true }).click();
    await page.getByText('Available', { exact: true }).waitFor();

    let releaseOlder;
    let olderCaptured;
    const releaseOlderPromise = new Promise((resolve) => { releaseOlder = resolve; });
    const olderCapturedPromise = new Promise((resolve) => { olderCaptured = resolve; });
    let dashboardReads = 0;
    await page.route('**/api/dashboard', async (route) => {
      dashboardReads += 1;
      if (dashboardReads !== 1) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      olderCaptured();
      await releaseOlderPromise;
      await route.fulfill({ response });
    });

    await page.getByRole('button', { name: 'Update availability', exact: true }).click();
    await olderCapturedPromise;
    await page.getByLabel('Display language').selectOption('ja');
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await page.getByText('設定を保存しました', { exact: true }).waitFor();
    releaseOlder();
    await page.getByRole('button', { name: '利用状況を更新', exact: true }).waitFor();
    await page.waitForTimeout(100);
    assert.equal(await page.getByRole('heading', { name: '設定', exact: true }).count(), 1);
    const dashboard = await page.evaluate(async () => (await (await fetch('/api/dashboard')).json()).data.control_center);
    assert.equal(dashboard.settings.display_language.current_locale, 'ja');
  } finally {
    if (browser) await browser.close();
    await closeServer(started.server);
  }
});

test('review center handles every intake type, no-AI continuation, recovery, keyboard use, and responsive layouts', { skip: !runBrowserSmoke }, async (t) => {
  const testWorkspace = await createBrowserTestWorkspace('trace-cue-control-center-goal-smoke-');
  t.after(() => testWorkspace.cleanup());
  const { cwd } = testWorkspace;
  const builtAssets = path.join(repoRoot, 'dist', 'control-center');
  await cp(builtAssets, path.join(cwd, 'dist', 'control-center'), { recursive: true });

  const recoveryId = 'control-center-agentic-review-browser-recovery';
  const recoveryStore = createSafeLocalStore({
    workspaceRoot: cwd,
    relativeRoot: '.browser-debug/control-center-agentic-reviews',
    namespace: 'control-center-agentic-review-operations'
  });
  await recoveryStore.writeJson(`${recoveryId}/operation.json`, {
    schema_version: '1.0.0', type: 'control_center_agentic_review_operation', id: recoveryId,
    state: 'dispatching', stage: 'external_review', created_at: fixedNow, updated_at: fixedNow,
    started_at: fixedNow, completed_at: null,
    request: { purpose: 'Check the booking flow', effort: 'standard', viewport: 'both', ai_suggestions: true },
    service: { name: 'Example Review AI', external_ai: true }, relationship: null, disclosure: null,
    confirmation: null, dispatch: { attempt: 1 }, decisions: [], result: null, error: null,
    internal: { target_url: 'https://example.jp/' }
  });
  const preparingRecoveryId = 'control-center-agentic-review-browser-preparing';
  await recoveryStore.writeJson(`${preparingRecoveryId}/operation.json`, {
    schema_version: '1.0.0', type: 'control_center_agentic_review_operation', id: preparingRecoveryId,
    state: 'preparing', stage: 'browser_review', created_at: fixedNow, updated_at: fixedNow,
    started_at: null, completed_at: null,
    request: { purpose: 'Check the booking flow', effort: 'standard', viewport: 'both', ai_suggestions: false },
    service: { name: 'Local review', external_ai: false }, relationship: null, disclosure: null,
    confirmation: null, dispatch: { attempt: 0 }, preparation: {
      interrupted: false,
      owner: { pid: 999999, process_identity: 'not-running' }
    }, decisions: [], result: null, error: null,
    internal: { target_url: 'https://example.jp/' }
  });

  const context = { ...controlCenterReviewContext(cwd), agenticReviewServiceName: undefined };
  const started = await startControlCenterServer({ port: 0 }, context);
  testWorkspace.trackServer(started.server);
  let browser = null;
  try {
    browser = await chromium.launch();
    testWorkspace.trackBrowser(browser);
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const consoleErrors = [];
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await page.goto(started.url, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /New review/ }).click();
    const newReview = page.locator('[data-testid="tc-cc-new-review"]');
    await newReview.waitFor();
    assert.equal(await newReview.locator('input[name="source-kind"]').count(), 5);
    assert.deepEqual(await newReview.locator('.page-header .eyebrow').allTextContents(), []);
    assert.equal(await page.locator('[data-page-heading]').evaluate((element) => document.activeElement === element), true);

    const purpose = page.getByLabel('What do you want to make easier?');
    await purpose.fill('Help a first-time visitor understand the next action.');
    const fileInput = page.locator('#review-file');
    await page.getByRole('radio', { name: /^Image/ }).check();
    assert.equal(await newReview.locator('#review-purpose').count(), 0);
    assert.equal(await newReview.locator('.method-grid').count(), 0);
    await fileInput.focus();
    assert.notEqual(await newReview.locator('.file-drop').evaluate((element) => getComputedStyle(element).outlineStyle), 'none');
    await newReview.locator('.file-drop').evaluate((element, encoded) => {
      const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], 'private-screen.png', { type: 'image/png' }));
      element.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
    }, 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=');
    await page.getByText('File selected').waitFor();
    assert.equal(await fileInput.evaluate((element) => element.files.length), 0);
    await page.route('**/api/review-intake/upload', async (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'error',
        errors: [{ code: 'TEST_SAFE_MESSAGE', message: 'Choose a valid image and try again.', details: {} }]
      })
    }), { times: 1 });
    await page.getByRole('button', { name: 'Prepare image evidence' }).click();
    await page.getByText('Choose a valid image and try again.').waitFor();
    await page.getByRole('button', { name: 'Prepare image evidence' }).click();
    await page.getByText('Image evidence is ready').waitFor();
    assert.equal((await newReview.innerText()).includes('private-screen.png'), false);

    await page.getByRole('radio', { name: /^Document/ }).check();
    assert.equal(await newReview.locator('#review-purpose').count(), 1);
    assert.equal(await newReview.locator('.method-grid input[type="radio"]').count(), 3);
    await fileInput.setInputFiles({ name: 'private-notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notes\nMake the next step clearer.\n') });
    await page.getByRole('button', { name: 'Prepare review proposal' }).click();
    await page.getByText('The review proposal is ready').waitFor();
    assert.equal((await newReview.innerText()).includes('private-notes.md'), false);

    await page.getByRole('radio', { name: /^Test result/ }).check();
    assert.equal(await newReview.locator('#review-purpose').count(), 0);
    assert.equal(await newReview.locator('.method-grid').count(), 0);
    await fileInput.setInputFiles({
      name: 'private-results.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ suites: [{ specs: [{ title: 'booking', tests: [
        { title: 'works', projectName: 'chromium', results: [{ status: 'passed', attachments: [] }] },
        { title: 'shows a problem', projectName: 'chromium', results: [{ status: 'failed', attachments: [] }] }
      ] }] }] }))
    });
    await page.getByRole('button', { name: 'Organize test result' }).click();
    await page.getByText('Some automated checks need attention').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Organize test result' }).count(), 0);
    await page.getByRole('button', { name: 'Prepare another' }).waitFor();
    assert.equal((await newReview.innerText()).includes('private-results.json'), false);
    await page.getByRole('button', { name: 'Open result', exact: true }).click();
    const savedResult = page.locator('[data-testid="tc-cc-intake-result"]');
    await savedResult.waitFor();
    await page.getByText('Some automated checks need attention').waitFor();
    assert.match(await savedResult.innerText(), /1 of 2 checks did not pass\. 1 passed\./);
    assert.equal(await savedResult.locator('.inline-notice.danger').count(), 1);
    assert.match(await savedResult.locator('.result-facts').innerText(), /Checks\s*2[\s\S]*Passed\s*1[\s\S]*Failed\s*1[\s\S]*Timed out\s*0[\s\S]*Not run\s*0/);
    const savedResultId = await page.evaluate(() => new URLSearchParams(window.location.search).get('item'));
    await page.reload({ waitUntil: 'networkidle' });
    await savedResult.waitFor();
    await page.getByRole('button', { name: 'Back', exact: true }).click();

    await page.getByRole('button', { name: /New review/ }).click();
    await page.getByRole('radio', { name: /^Test result/ }).check();
    await fileInput.setInputFiles({
      name: 'private-timeout-results.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ suites: [{ specs: [{ title: 'booking', tests: [
        { title: 'times out', projectName: 'chromium', results: [{ status: 'timedOut', attachments: [] }] }
      ] }] }] }))
    });
    await page.getByRole('button', { name: 'Organize test result' }).click();
    await page.getByText('Some automated checks need attention').waitFor();
    assert.match(await newReview.innerText(), /0 failed and 1 timed out among 1 checks/);
    await page.getByRole('button', { name: 'Prepare another' }).click();
    assert.equal(await fileInput.evaluate((element) => element.files.length), 0);
    await fileInput.setInputFiles({
      name: 'private-skipped-results.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ suites: [{ specs: [{ title: 'booking', tests: [
        { title: 'not run', projectName: 'chromium', results: [{ status: 'skipped', attachments: [] }] }
      ] }] }] }))
    });
    await page.getByRole('button', { name: 'Organize test result' }).click();
    await page.getByText('No usable automated-check result was found').waitFor();
    assert.equal(await newReview.locator('.inline-notice.success').count(), 0);
    await page.getByRole('button', { name: 'Prepare another' }).click();
    await fileInput.setInputFiles({
      name: 'private-interrupted-results.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ suites: [{ specs: [{ title: 'booking', tests: [
        { title: 'interrupted', projectName: 'chromium', results: [{ status: 'interrupted', attachments: [] }] }
      ] }] }] }))
    });
    await page.getByRole('button', { name: 'Organize test result' }).click();
    await page.getByText('Some automated checks need attention').waitFor();
    assert.equal(await newReview.locator('.inline-notice.danger').count(), 1);
    await page.getByRole('button', { name: 'Prepare another' }).click();
    await fileInput.setInputFiles({ name: 'private-empty-results.json', mimeType: 'application/json', buffer: Buffer.from('{"suites":[]}') });
    await page.getByRole('button', { name: 'Organize test result' }).click();
    await page.getByText('No usable automated-check result was found').waitFor();
    assert.equal(await newReview.locator('.inline-notice.warning').filter({ hasText: 'No usable automated-check result was found' }).count(), 1);
    await page.getByRole('button', { name: 'Open result', exact: true }).click();
    await page.getByText('No usable automated-check result was found').waitFor();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.route('**/api/review-intake/results*', async (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'error', errors: [{ code: 'TEST_RESULTS_UNAVAILABLE', message: 'Saved results are temporarily unavailable.', details: {} }] })
    }), { times: 1 });
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    const retainedResultsNotice = page.locator('.inline-notice.warning');
    await retainedResultsNotice.getByText('Some saved results could not be loaded').waitFor();
    assert.match(await page.locator('.review-list').innerText(), /Test result/);
    await retainedResultsNotice.getByRole('button', { name: 'Try again' }).click();
    await retainedResultsNotice.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: /New review/ }).click();
    await newReview.waitFor();

    const websiteChoice = page.getByRole('radio', { name: /^Website/ });
    await page.getByRole('radio', { name: /^Image/ }).check();
    assert.equal(await websiteChoice.isChecked(), false);
    await websiteChoice.focus();
    await websiteChoice.press('Space');
    assert.equal(await websiteChoice.isChecked(), true);
    assert.equal(await websiteChoice.evaluate((element) => element === document.activeElement), true);
    const sourceState = await newReview.locator('input[name="source-kind"]').evaluateAll((elements) => elements.map((element) => ({
      value: element.value,
      checked: element.checked,
      selected: element.closest('.source-choice')?.classList.contains('selected') ?? false
    })));
    assert.equal(await newReview.locator('#review-url').count(), 1, JSON.stringify(sourceState));
    await page.getByLabel('URL to review').fill('https://example.jp/reserve');
    await page.getByLabel('What do you want to make easier?').fill('Help a first-time visitor understand the next action.');
    const aiChoice = page.locator('.ai-choice');
    await aiChoice.waitFor();
    const aiCopy = await aiChoice.innerText();
    assert.match(aiCopy, /continue without AI/i);
    assert.doesNotMatch(aiCopy, /provider|model|endpoint|API key|environment variable|token/i);
    const continueWithoutAi = page.getByLabel('Continue without AI');
    const continueWithoutAiBox = await continueWithoutAi.boundingBox();
    assert.ok(continueWithoutAiBox.width >= 44);
    assert.ok(continueWithoutAiBox.height >= 44);
    const prepareButton = page.getByRole('button', { name: 'Prepare review' });
    assert.equal(await prepareButton.isDisabled(), true);
    await continueWithoutAi.check();
    assert.equal(await prepareButton.isEnabled(), true);
    await prepareButton.click();
    await page.getByRole('heading', { name: 'No major improvements were found' }).waitFor({ timeout: 10_000 });

    await page.goto(`${started.url}?view=work&item=${encodeURIComponent(recoveryId)}`, { waitUntil: 'networkidle' });
    const recoveryCheck = page.getByRole('button', { name: 'Check status' });
    await recoveryCheck.waitFor({ timeout: 10_000 });
    await recoveryCheck.click();
    const unknownDispatchHeading = page.getByRole('heading', { name: 'We are checking whether the review started' });
    await unknownDispatchHeading.waitFor({ timeout: 10_000 });
    assert.equal(await page.getByRole('button', { name: 'Check status' }).count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Try again' }).count(), 0);

    await page.goto(`${started.url}?view=work&item=${encodeURIComponent(preparingRecoveryId)}`, { waitUntil: 'networkidle' });
    const preparingCheck = page.getByRole('button', { name: 'Check status' });
    await preparingCheck.waitFor({ timeout: 10_000 });
    await preparingCheck.click();
    await page.getByRole('heading', { name: 'Preparation was interrupted' }).waitFor({ timeout: 10_000 });
    assert.equal(await page.getByRole('button', { name: 'Resume preparation' }).count(), 1);

    for (const viewport of [{ width: 768, height: 1024 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.goto(started.url, { waitUntil: 'networkidle' });
      const mobileStatus = page.locator('.review-list .status-badge').first();
      await mobileStatus.waitFor();
      assert.equal(await mobileStatus.isVisible(), true);
      await page.goto(`${started.url}?view=new`, { waitUntil: 'networkidle' });
      await page.locator('[data-testid="tc-cc-new-review"]').waitFor();
      const layout = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        sourceWidths: [...document.querySelectorAll('.source-choice')].map((element) => element.getBoundingClientRect().width),
        workspaceWidth: document.querySelector('.workspace').getBoundingClientRect().width,
        navColumnCount: getComputedStyle(document.querySelector('.nav-list')).gridTemplateColumns.split(/\s+/u).length,
        navItemHeights: [...document.querySelectorAll('.nav-item')].map((element) => element.getBoundingClientRect().height)
      }));
      assert.equal(layout.overflow, 0);
      assert.equal(layout.sourceWidths.every((width) => width > 0 && width <= layout.workspaceWidth), true);
      assert.equal(layout.navColumnCount, viewport.width === 768 ? 1 : 3);
      assert.equal(layout.navItemHeights.every((height) => height <= 68), true);
    }

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Display language').selectOption('ar');
    await page.getByRole('button', { name: /Save settings/ }).click();
    await page.locator('html[dir="rtl"]').waitFor();
    const rtlText = await page.locator('[data-testid="tc-cc-settings"]').innerText();
    assert.doesNotMatch(rtlText, /Settings|Everyday use|Display language|Default screen size|Automated checks|AI suggestions|Confirm before sending|Save settings/);
    assert.match(rtlText, /الإعدادات/);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
    await page.getByRole('button', { name: 'تحديث التوفر', exact: true }).click();
    await page.getByText('متاحة', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'تغيير', exact: true }).click();
    await page.getByText('تفاصيل الذكاء الاصطناعي', { exact: true }).click();
    const rtlAiText = await page.locator('[data-testid="tc-cc-settings"]').innerText();
    assert.doesNotMatch(rtlAiText, /Use this AI|AI choice updated|AI processing level|Load latest choices/);
    await page.goto(`${started.url}?view=new`, { waitUntil: 'networkidle' });
    await page.locator('#review-url').fill('https://example.jp/rtl');
    await page.locator('#review-purpose').fill('توضيح الخطوة التالية للزائر');
    await page.locator('[data-testid="tc-cc-new-review"] button[type="submit"]').click();
    const rtlDialog = page.locator('dialog[aria-labelledby="send-dialog-title"]');
    const rtlPreparationError = page.locator('[data-testid="tc-cc-new-review"] .inline-notice.danger');
    const preparationOutcome = await Promise.race([
      rtlDialog.waitFor({ state: 'visible', timeout: 70_000 }).then(() => 'dialog'),
      rtlPreparationError.waitFor({ state: 'visible', timeout: 70_000 })
        .then(async () => `error: ${await rtlPreparationError.innerText()}`)
    ]);
    assert.equal(preparationOutcome, 'dialog', preparationOutcome);
    const rtlDialogText = await rtlDialog.innerText();
    assert.match(rtlDialogText, /النص الظاهر في الصفحة/);
    assert.match(rtlDialogText, /تحفظ النتيجة في مساحة العمل المحلية/);
    assert.doesNotMatch(rtlDialogText, /Visible page text|Page address|Saved on this computer|AI settings/);
    const zoomLayout = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      viewport: window.innerWidth
    }));
    assert.equal(zoomLayout.overflow, 0);
    assert.ok((await rtlDialog.boundingBox()).width <= zoomLayout.viewport);
    await rtlDialog.locator('.secondary-action').click();
    await rtlDialog.waitFor({ state: 'hidden' });
    await page.evaluate(() => { document.documentElement.style.zoom = '1'; });
    await page.goto(`${started.url}?view=work&item=${encodeURIComponent(savedResultId)}`, { waitUntil: 'networkidle' });
    const rtlResult = page.locator('[data-testid="tc-cc-intake-result"]');
    await rtlResult.waitFor();
    const rtlResultText = await rtlResult.innerText();
    assert.doesNotMatch(rtlResultText, /Saved result|Reviewed item|Saved|Checks|Passed|Failed|Timed out|Not run/);
    assert.match(rtlResultText, /نتيجة محفوظة/);
    assert.notEqual(await rtlResult.locator('.back-action .directional-symbol').evaluate((element) => getComputedStyle(element).transform), 'none');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
    assert.equal(consoleErrors.length, 0);
  } finally {
    if (browser) await browser.close();
    await closeServer(started.server);
  }
});

test('review center keeps one intake and redirects to truthful status after response loss', { skip: !runBrowserSmoke }, async (t) => {
  const testWorkspace = await createBrowserTestWorkspace('trace-cue-control-center-response-loss-');
  t.after(() => testWorkspace.cleanup());
  const { cwd } = testWorkspace;
  await cp(path.join(repoRoot, 'dist', 'control-center'), path.join(cwd, 'dist', 'control-center'), { recursive: true });
  const started = await startControlCenterServer({ port: 0 }, controlCenterReviewContext(cwd));
  testWorkspace.trackServer(started.server);
  let browser = null;
  try {
    browser = await chromium.launch();
    testWorkspace.trackBrowser(browser);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    let uploadCount = 0;
    let completeCount = 0;
    await page.route('**/api/review-intake/upload', async (route) => {
      uploadCount += 1;
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'ok',
          data: { control_center_intake: { intake: { id: String(uploadCount).padStart(32, '0') } } },
          warnings: [], errors: [], artifacts: []
        })
      });
    });
    await page.route('**/api/review-intake/complete', async (route) => {
      completeCount += 1;
      if (completeCount === 1) {
        await route.abort('failed');
        return;
      }
      if (completeCount === 3) {
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'error', data: { control_center_intake: null }, warnings: [], artifacts: [],
            errors: [{ code: 'TEST_ENGINE_FAILED', message: 'The selected image could not be checked.', details: { same_intake_retry_available: false } }]
          })
        });
        return;
      }
      const intakeId = route.request().postDataJSON().intake_id;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'ok',
          data: { control_center_intake: { result: {
            schema_version: '1.0.0', type: 'control_center_intake_result', id: intakeId,
            source_kind: 'image', label: 'Selected image', outcome: 'image_evidence_ready',
            completed_at: fixedNow, external_ai_review_completed: false,
            summary: { status: 'ready', format: 'png', width: 1, height: 1, finding_count: 0 }
          } } },
          warnings: [], errors: [], artifacts: []
        })
      });
    });

    await page.goto(started.url, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Update availability', exact: true }).click();
    await page.getByText('Available', { exact: true }).waitFor();
    await page.goto(`${started.url}?view=new`, { waitUntil: 'networkidle' });
    await page.getByRole('radio', { name: /^Image/ }).check();
    const fileInput = page.locator('#review-file');
    await fileInput.setInputFiles({ name: 'screen.png', mimeType: 'image/png', buffer: Buffer.from('image') });
    const prepareImage = page.getByRole('button', { name: 'Prepare image evidence' });
    await prepareImage.click();
    await page.getByText(/Failed to fetch|The review could not be prepared/).first().waitFor();
    await prepareImage.click();
    await page.getByText('Image evidence is ready').waitFor();
    assert.equal(uploadCount, 1);
    assert.equal(completeCount, 2);

    await page.getByRole('button', { name: 'Prepare another' }).click();
    await fileInput.setInputFiles({ name: 'second.png', mimeType: 'image/png', buffer: Buffer.from('image-two') });
    await prepareImage.click();
    await page.getByText('The selected image could not be checked.').waitFor();
    await prepareImage.click();
    await page.getByText('Image evidence is ready').waitFor();
    assert.equal(uploadCount, 3);
    assert.equal(completeCount, 4);

    await page.unroute('**/api/review-intake/upload');
    await page.unroute('**/api/review-intake/complete');
    await page.goto(`${started.url}?view=new`, { waitUntil: 'networkidle' });
    await page.getByLabel('URL to review').fill('https://example.jp/booking');
    await page.getByLabel('What do you want to make easier?').fill('Help visitors find the booking action.');
    await page.getByRole('button', { name: 'Prepare review' }).click();
    const dialog = page.getByRole('dialog', { name: 'Start this review?' });
    await dialog.waitFor({ timeout: 10_000 });
    let acceptedOperationId = null;
    await page.route('**/api/agentic-review/start', async (route) => {
      acceptedOperationId = route.request().postDataJSON().id;
      const response = await route.fetch();
      assert.equal(response.ok(), true);
      await route.abort('failed');
    }, { times: 1 });
    await dialog.getByRole('button', { name: 'Start review', exact: true }).click();
    await page.locator('[data-testid="tc-cc-review-workspace"]').waitFor({ timeout: 10_000 });
    assert.equal(new URL(page.url()).searchParams.get('item'), acceptedOperationId);
    assert.equal(await page.locator('[data-testid="tc-cc-new-review"]').count(), 0);

    const freshPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const dashboardResponseAfterLoss = freshPage.waitForResponse((response) => (
      new URL(response.url()).pathname === '/api/dashboard'
      && response.request().method() === 'GET'
    ));
    await freshPage.goto(`${started.url}?view=new`, { waitUntil: 'networkidle' });
    const dashboardResponse = await dashboardResponseAfterLoss;
    assert.equal(
      dashboardResponse.status(),
      200,
      `Dashboard reload after response loss failed: ${await dashboardResponse.text()}`
    );
    await freshPage.locator('[data-testid="tc-cc-new-review"]').waitFor({ timeout: 10_000 });
    await freshPage.getByLabel('URL to review').fill('https://example.jp/changed-destination');
    await freshPage.getByLabel('What do you want to make easier?').fill('Check a changed AI destination safely.');
    await freshPage.getByRole('button', { name: 'Prepare review' }).click();
    const rejectedDialog = freshPage.getByRole('dialog', { name: 'Start this review?' });
    await rejectedDialog.waitFor({ timeout: 10_000 });
    const pendingOperationId = await freshPage.evaluate(async () => {
      const response = await (await fetch('/api/agentic-review/list')).json();
      return response.data.control_center_agentic_review.operations.find((operation) => operation.state === 'confirmation_required')?.id;
    });
    assert.ok(pendingOperationId);
    const driftPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await driftPage.goto(`${started.url}?page=settings`, { waitUntil: 'networkidle' });
    await driftPage.getByRole('button', { name: 'Update availability', exact: true }).click();
    await driftPage.getByText('Available', { exact: true }).waitFor();
    await driftPage.close();
    await activateObservedPage(freshPage);
    await rejectedDialog.getByRole('button', { name: 'Start review', exact: true }).click();
    await freshPage.getByText('The AI choice changed before anything was sent. Update availability, then prepare this review again.').waitFor();
    assert.equal(await freshPage.getByRole('button', { name: 'Open AI settings', exact: true }).count(), 1);
    assert.equal(await freshPage.locator('[data-testid="tc-cc-new-review"]').count(), 1);
    assert.equal(new URL(freshPage.url()).searchParams.get('view'), 'new');
    const attention = await freshPage.evaluate(async (id) => (
      await (await fetch(`/api/agentic-review/status?id=${encodeURIComponent(id)}`)).json()
    ).data.control_center_agentic_review.operation, pendingOperationId);
    assert.equal(attention.state, 'needs_attention');
    assert.equal(attention.dispatch.provider_call_performed, false);
    await freshPage.getByRole('button', { name: 'Open AI settings', exact: true }).click();
    await freshPage.locator('[data-testid="tc-cc-settings"]').waitFor();
    await freshPage.getByRole('button', { name: 'Update availability', exact: true }).click();
    await freshPage.getByText('Available', { exact: true }).waitFor();
    await freshPage.goto(`${started.url}?view=work&item=${encodeURIComponent(pendingOperationId)}`, { waitUntil: 'networkidle' });
    await freshPage.getByRole('heading', { name: 'The AI choice changed', exact: true }).waitFor();
    await activateObservedPage(freshPage);
    await freshPage.getByRole('button', { name: 'Prepare again', exact: true }).click();
    await freshPage.getByRole('heading', { name: 'The review is ready to start', exact: true }).waitFor({
      timeout: CONTROL_CENTER_RESPONSE_OBSERVATION_TIMEOUT_MS
    });
    const preparedAgainId = new URL(freshPage.url()).searchParams.get('item');
    assert.notEqual(preparedAgainId, pendingOperationId);
    const preparedAgain = await freshPage.evaluate(async (id) => (
      await (await fetch(`/api/agentic-review/status?id=${encodeURIComponent(id)}`)).json()
    ).data.control_center_agentic_review.operation, preparedAgainId);
    assert.equal(preparedAgain.state, 'confirmation_required');
    assert.equal(preparedAgain.parent_review.id, pendingOperationId);
    assert.equal(preparedAgain.parent_review.repeat_mode, 'recheck');
  } finally {
    if (browser) await browser.close();
    await closeServer(started.server);
  }
});

test('review center gives a non-engineer URL-first and private local video review flow', { skip: !runBrowserSmoke }, async (t) => {
  const testWorkspace = await createBrowserTestWorkspace('trace-cue-control-center-media-browser-');
  t.after(() => testWorkspace.cleanup());
  const { cwd } = testWorkspace;
  await cp(path.join(repoRoot, 'dist', 'control-center'), path.join(cwd, 'dist', 'control-center'), { recursive: true });
  const operationId = '4'.repeat(32);
  const previousOperationId = '5'.repeat(32);
  let currentState = 'prepared';
  let statusReads = 0;
  let uploadBytes = 0;
  let readinessChecks = 0;
  let comparisonReads = 0;
  let comparisonOptionReads = 0;
  const operation = (id = operationId) => {
    const state = id === operationId ? currentState : 'completed';
    return {
    schema_version: '1.0.0', type: 'media_review_operation', operation_id: id,
    state, retention: 'ephemeral', created_at: fixedNow, updated_at: fixedNow,
    progress: { phase: state === 'completed' ? 'completed' : 'analyzing', percent: state === 'completed' ? 100 : 45 },
    capabilities: { status: true, cancel: state !== 'completed', cleanup: false, result: state === 'completed' },
    result_available: state === 'completed', cleanup_available: false, private_payload_retained: false, errors: [],
    boundary: { absolute_path_included: false, private_locator_included: false, source_name_included: false, raw_media_included: false, full_transcript_included: false }
  };
  };
  const finding = (classification, kind, severity) => ({
    schema_version: '1.0.0', id: `media-finding-${kind}`, kind, start_us: 900000, end_us: 1200000,
    timecode: { start: '00:00.900', end: '00:01.200' }, severity,
    evidence: ['The measured frame interval exceeded the expected cadence.'], evidence_refs: ['frame-gap-1'],
    method: 'frame_presentation_timestamps', confidence: 0.96, classification,
    limitations: classification === 'advisory_evaluation' ? ['Viewer response was not directly measured.'] : [],
    recommendation: 'Adjust the edit timing and verify the updated scene.', recommendation_classification: 'advisory_evaluation',
    scene_reference: { start_us: 900000, end_us: 1200000 }
  });
  const result = {
    schema_version: '1.0.0', type: 'media_review_result', operation_id: operationId, status: 'completed_with_limitations',
    media_identity: { sha256: '8'.repeat(64), bytes: 1024, format: 'iso-base-media' }, source_decision: {}, analysis_settings: {}, toolchain: {},
    technical_analysis: { boundary: { raw_media_included: false, raw_audio_included: false, raw_frames_included: false, absolute_paths_included: false } },
    transcript: { status: 'available', segment_count: 2, timed_segment_count: 2, boundary: { body_included: false, absolute_paths_included: false } },
    timeline: { boundary: { full_transcript_included: false } },
    deterministic_findings: [finding('deterministic_measurement', 'presentation_gap', 'medium')],
    advisory_findings: [finding('advisory_evaluation', 'cut_during_speech', 'high')],
    content_evidence: {}, resource_guard: {}, limitations: ['perceptual_lip_sync_not_measured'],
    privacy: { retention: 'ephemeral', full_transcript_in_result: false, raw_audio_in_result: false, raw_frames_in_result: false, raw_media_persisted_outside_private_root: false, full_transcript_persisted_outside_private_root: false, external_send_performed: false },
    boundary: { absolute_paths_included: false, raw_media_included: false, raw_audio_included: false, raw_frames_included: false, full_transcript_included: false, external_send_enabled: false, deterministic_and_advisory_separated: true }
  };
  const mediaRuntime = {
    inspectReadiness: async ({ refresh = false } = {}) => {
      if (refresh) readinessChecks += 1;
      const status = refresh ? (readinessChecks === 1 ? 'unsupported' : 'ready') : 'uninspected';
      return { status: 'ok', data: { readiness: {
        schema_version: '1.0.0', type: 'media_review_readiness', status,
        transcript_provider: { status, limitations: refresh ? [] : ['explicit_readiness_check_required'] },
        technical_analyzer: { status: refresh ? 'ready' : 'uninspected', limitations: refresh ? [] : ['explicit_readiness_check_required'] },
        local_input: { accepted_extensions: ['.mp4', '.mov', '.m4v', '.mkv', '.webm'], maximum_bytes: 104857600 },
        boundary: { read_only: true, provider_transcription_performed: false, media_analysis_performed: false, network_performed: false, setup_performed: false, mcp_execution_performed: false, secrets_included: false, executable_paths_included: false, provider_revision_included: false, configuration_hashes_included: false }
      } }, warnings: [], errors: [], artifacts: [] };
    },
    sourceDecision: async () => ({ status: 'ok', data: { source_decision: {
      schema_version: '1.0.0', type: 'media_source_decision', source_kind: 'url', status: 'ready', capabilities: ['playback_inspection'],
      rights: { declaration_required: false, declared: false, platform_policy_separate: true },
      source: { display_label: 'www.youtube.com/watch', service_kind: 'official_video_player', opaque_media_id: '9'.repeat(64), identity_available: true, query_or_fragment_included: false },
      limitations: ['official_player_state_only'], boundary: { network_performed: false, media_acquired: false, download_performed: false, redirect_followed: false, dns_resolution_performed: false, url_query_or_fragment_included: false, credentials_included: false, absolute_path_included: false, rights_declaration_treated_as_legal_proof: false }
    } }, warnings: [], errors: [], artifacts: [] }),
    stageUpload: async (_metadata, stream) => {
      for await (const chunk of stream) uploadBytes += chunk.length;
      return { status: 'ok', data: { media_source: {
        schema_version: '1.0.0', type: 'control_center_media_source', source_id: '3'.repeat(32), state: 'staged', bytes: uploadBytes,
        media_identity: { sha256: '7'.repeat(64), bytes: uploadBytes, format: 'iso-base-media' }, format: 'iso-base-media', expires_at: '2026-07-19T00:00:00.000Z',
        boundary: { absolute_path_included: false, original_name_included: false, raw_media_included: false, private_locator_included: false, external_send_performed: false, network_performed: false }
      } }, warnings: [], errors: [], artifacts: [] };
    },
    start: async () => ({ status: 'ok', data: { media_review: operation() }, warnings: [], errors: [], artifacts: [] }),
    list: () => ({ status: 'ok', data: { media_reviews: uploadBytes ? [operation(), operation(previousOperationId)] : [] }, warnings: [], errors: [], artifacts: [] }),
    status: async ({ operation_id: requestedOperationId }) => {
      if (requestedOperationId === previousOperationId) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return { status: 'ok', data: { media_review: operation(previousOperationId) }, warnings: [], errors: [], artifacts: [] };
      }
      statusReads += 1;
      if (statusReads >= 2) currentState = 'completed';
      return { status: 'ok', data: { media_review: operation() }, warnings: [], errors: [], artifacts: [] };
    },
    result: ({ operation_id: requestedOperationId }) => ({
      status: 'ok',
      data: { media_review_result: { ...result, operation_id: requestedOperationId } },
      warnings: [], errors: [], artifacts: []
    }),
    comparisonOptions: async () => {
      comparisonOptionReads += 1;
      if (comparisonOptionReads === 1) {
        return { status: 'error', data: {}, warnings: [], errors: [{ code: 'FIXTURE_RETRY', message: 'Saved reviews are temporarily unavailable.', details: {} }], artifacts: [] };
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { status: 'ok', data: { media_review_comparison_options: {
        schema_version: '1.0.0', type: 'media_review_comparison_options',
        options: [
          { operation_id: operationId, created_at: '2026-07-19T00:00:00.000Z', duration_us: 2_000_000, finding_counts: { deterministic: 1, advisory: 1 } },
          { operation_id: previousOperationId, created_at: '2026-07-18T00:00:00.000Z', duration_us: 1_000_000, finding_counts: { deterministic: 2, advisory: 1 } }
        ],
        boundary: { public_results_only: true, absolute_paths_included: false, source_names_included: false, raw_media_included: false, full_transcript_included: false, network_performed: false }
      } }, warnings: [], errors: [], artifacts: [] };
    },
    compare: async ({ baseline_operation_id: baseline, candidate_operation_id: candidate }) => {
      comparisonReads += 1;
      assert.equal(baseline, previousOperationId);
      assert.equal(candidate, operationId);
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { status: 'ok', data: { media_review_comparison: browserMediaComparison(previousOperationId, operationId) }, warnings: [], errors: [], artifacts: [] };
    },
    cancel: () => ({ status: 'ok', data: { media_review: operation() }, warnings: [], errors: [], artifacts: [] }),
    cleanup: async () => ({ status: 'ok', data: { cleanup_receipt: { schema_version: '1.0.0', type: 'media_cleanup_receipt', operation_id: operationId, status: 'cleaned', retention: 'ephemeral', reason: 'fixture', completed_at: fixedNow, deleted: { file_count: 1, directory_count: 1, byte_count: 1 }, identity: '6'.repeat(64), limitations: [], boundary: { absolute_path_included: false, raw_media_included: false, full_transcript_included: false, sibling_deleted: false, normal_artifact_root_deleted: false } } }, warnings: [], errors: [], artifacts: [] }),
    dispose: async () => {}
  };
  const started = await startControlCenterServer({ port: 0 }, {
    ...controlCenterReviewContext(cwd),
    controlCenterMediaReviewRuntime: mediaRuntime
  });
  testWorkspace.trackServer(started.server);
  let browser = null;
  try {
    browser = await chromium.launch();
    testWorkspace.trackBrowser(browser);
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(started.url, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /New review/ }).click();
    await page.getByRole('radio', { name: /Video/ }).check();
    await page.getByRole('textbox', { name: 'Video URL' }).fill('https://www.youtube.com/watch?v=public123&token=SECRET');
    await page.getByRole('button', { name: 'Check URL capabilities' }).click();
    const decision = page.locator('[data-testid="tc-media-source-decision"]');
    await decision.getByText('Official-player inspection is permitted', { exact: true }).waitFor();
    assert.match(await decision.innerText(), /None during this capability check/);
    assert.doesNotMatch(await decision.innerText(), /SECRET/);

    await page.getByRole('radio', { name: /Local video/ }).check();
    await page.getByRole('button', { name: 'Check local setup', exact: true }).click();
    await page.locator('.media-review-input .status-pill').getByText('Unsupported', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Check local setup', exact: true }).click();
    await page.getByText('Ready', { exact: true }).waitFor();
    await page.locator('#review-file').setInputFiles({ name: 'private-source.mp4', mimeType: 'video/mp4', buffer: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(256)]) });
    await page.getByRole('checkbox', { name: 'I own this video or have permission to review it.' }).check();
    await page.getByRole('button', { name: /Start video review/ }).click();
    const mediaPage = page.locator('[data-testid="tc-cc-media-review"]');
    await mediaPage.getByText('Your time-coded review is ready', { exact: true }).waitFor({ timeout: 10_000 });
    assert.match(await mediaPage.innerText(), /00:00\.900–00:01\.200/);
    assert.match(await mediaPage.innerText(), /Technical measurements/);
    assert.match(await mediaPage.innerText(), /Advisory evaluations/);
    assert.match(await mediaPage.innerText(), /Nothing was sent outside this computer/);
    const comparisonPanel = mediaPage.locator('[data-testid="tc-cc-media-comparison"]');
    await comparisonPanel.getByText('See what changed', { exact: true }).waitFor();
    await comparisonPanel.getByText('Saved reviews could not be loaded', { exact: true }).waitFor();
    assert.doesNotMatch(await comparisonPanel.innerText(), /One more review is needed/);
    const optionsRetry = comparisonPanel.getByRole('button', { name: 'Try again', exact: true });
    await optionsRetry.focus();
    await optionsRetry.press('Enter');
    await comparisonPanel.getByText('Loading saved reviews', { exact: true }).waitFor();
    await comparisonPanel.getByRole('combobox', { name: 'Before', exact: true }).waitFor();
    assert.match(await comparisonPanel.innerText(), /Current review/);
    assert.doesNotMatch(await comparisonPanel.innerText(), new RegExp(operationId));
    const beforeSelect = comparisonPanel.getByRole('combobox', { name: 'Before', exact: true });
    const afterSelect = comparisonPanel.getByRole('combobox', { name: 'After', exact: true });
    const swap = comparisonPanel.getByRole('button', { name: 'Swap before and after', exact: true });
    const originalBefore = await beforeSelect.inputValue();
    const originalAfter = await afterSelect.inputValue();
    await swap.focus();
    await swap.press('Enter');
    assert.equal(await beforeSelect.inputValue(), originalAfter);
    assert.equal(await afterSelect.inputValue(), originalBefore);
    await swap.press('Enter');
    const compareButton = comparisonPanel.getByRole('button', { name: 'Compare these reviews', exact: true });
    await compareButton.focus();
    await compareButton.press('Enter');
    assert.equal(await beforeSelect.isDisabled(), true);
    assert.equal(await afterSelect.isDisabled(), true);
    assert.equal(await swap.isDisabled(), true);
    const comparisonResult = comparisonPanel.locator('[data-testid="tc-cc-media-comparison-result"]');
    await comparisonResult.getByRole('heading', { name: 'Compared with cautions', exact: true }).waitFor();
    assert.match(await comparisonResult.innerText(), /Measurements improved/);
    assert.match(await comparisonResult.innerText(), /Measured changes/);
    assert.match(await comparisonResult.innerText(), /Review suggestions that changed/);
    assert.match(await comparisonResult.innerText(), /Timed speech indicators/);
    assert.match(await comparisonResult.innerText(), /Timed speech segments per minute/);
    assert.match(await comparisonResult.innerText(), /60 → 30 per minute/);
    assert.match(await comparisonResult.innerText(), /Repeated frames per minute/);
    assert.match(await comparisonResult.innerText(), /300 → 180 per minute/);
    assert.match(await comparisonResult.innerText(), /Total in video: 10 → 12/);
    assert.equal(await comparisonResult.evaluate((element) => document.activeElement === element), true);
    const comparisonTouchHeights = await comparisonPanel.locator('button, select').evaluateAll((elements) => elements.map((element) => Math.round(element.getBoundingClientRect().height)));
    assert.equal(comparisonTouchHeights.every((height) => height >= 44), true);
    assert.doesNotMatch(await mediaPage.innerText(), /private-source\.mp4|SECRET|\/home\//);
    assert.ok(uploadBytes > 0);
    assert.equal(readinessChecks, 2);
    assert.ok(statusReads >= 2);
    assert.equal(comparisonReads, 1);
    assert.equal(comparisonOptionReads, 2);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1);
    await comparisonResult.getByRole('button', { name: 'Open before review', exact: true }).click();
    await mediaPage.getByText('Loading reviews', { exact: true }).waitFor();
    assert.equal(await mediaPage.getByText('Your time-coded review is ready', { exact: true }).isVisible(), false);
    await mediaPage.getByText('Your time-coded review is ready', { exact: true }).waitFor();
    assert.match(page.url(), new RegExp(previousOperationId));
  } finally {
    if (browser) await browser.close();
    await started.close();
  }
});

function browserMediaComparison(baseline, candidate) {
  const finding = {
    id: 'media-finding-1111111111111111', kind: 'presentation_gap', start_us: 900_000, end_us: 1_200_000,
    timecode: { start: '00:00.900', end: '00:01.200' }, severity: 'medium',
    evidence: ['The measured frame interval exceeded the expected cadence.'], evidence_refs: ['frame-gap-1'],
    method: 'frame_presentation_timestamps', confidence: 0.96, classification: 'deterministic_measurement',
    limitations: [], recommendation: 'Verify the updated scene timing.'
  };
  const advisory = { ...finding, id: 'media-finding-2222222222222222', kind: 'cut_during_speech', classification: 'advisory_evaluation', method: 'timeline_advisory_heuristic' };
  return {
    schema_version: '1.0.0', type: 'media_review_comparison', status: 'comparable_with_limitations',
    baseline: { operation_id: baseline, status: 'completed' }, candidate: { operation_id: candidate, status: 'completed_with_limitations' },
    compatibility: {
      technical: { status: 'comparable' }, transcript: { status: 'comparable' },
      advisory: { status: 'comparable_with_limitations' }
    },
    metric_diffs: [
      {
        id: 'duplicate_frame_count', domain: 'technical', unit: 'count', baseline: 10, candidate: 12,
        delta: 2, normalized_per_minute: { applied: true, baseline: 300, candidate: 180, delta: -120 },
        status: 'comparable', assessment: 'improved', classification: 'deterministic_measurement', limitations: []
      },
      {
        id: 'timed_transcript_segment_count', domain: 'transcript', unit: 'count', baseline: 2, candidate: 1,
        delta: -1, normalized_per_minute: { applied: true, baseline: 60, candidate: 30, delta: -30 },
        status: 'comparable', assessment: 'changed', classification: 'provider_measurement', limitations: []
      }
    ],
    deterministic_finding_changes: [{
      id: 'media-comparison-finding-1111111111111111', classification: 'deterministic_measurement',
      state: 'not_detected_in_candidate', change_types: ['not_detected_in_candidate'], kind: finding.kind,
      method: finding.method, baseline: finding, candidate: null, timing_delta_us: null, severity_delta: null,
      confidence_delta: null, match: { method: 'unmatched', overlap_ratio: null, midpoint_distance_us: null, heuristic: false },
      assessment: 'inconclusive', limitations: ['absence_in_one_result_does_not_prove_issue_fixed_or_created']
    }],
    advisory_finding_changes: [{
      id: 'media-comparison-finding-2222222222222222', classification: 'advisory_evaluation', state: 'persistent',
      change_types: ['persistent'], kind: advisory.kind, method: advisory.method, baseline: advisory, candidate: advisory,
      timing_delta_us: 0, severity_delta: 0, confidence_delta: 0,
      match: { method: 'exact_finding_id', overlap_ratio: 1, midpoint_distance_us: 0, heuristic: false },
      assessment: 'unchanged', limitations: []
    }],
    summary: {
      deterministic: { status: 'improved', inconclusive: 0 }, advisory: { status: 'unchanged', inconclusive: 0 },
      deterministic_metric_assessments: { improved: 1, regressed: 0, unchanged: 0, changed: 0, inconclusive: 0, unavailable: 0 },
      provider_metric_assessments: { improved: 0, regressed: 0, unchanged: 0, changed: 1, inconclusive: 0, unavailable: 0 },
      advisory_metric_assessments: { improved: 0, regressed: 0, unchanged: 0, changed: 0, inconclusive: 0, unavailable: 0 },
      combined_quality_score_included: false
    },
    limitations: ['comparison_reads_bounded_public_results_only', 'not_detected_in_candidate_does_not_prove_fixed'],
    privacy: { public_results_only: true, raw_media_read: false, raw_audio_read: false, raw_frames_read: false, full_transcript_read: false, private_payload_read: false, absolute_paths_included: false, external_send_performed: false },
    boundary: { read_only: true, media_reprocessed: false, provider_called: false, technical_analyzer_called: false, browser_launched: false, network_performed: false, artifact_written: false, mcp_execution_exposed: false, deterministic_and_advisory_separated: true, combined_quality_score_included: false, gate_effect: 'none' }
  };
}

test('session action can click and observe the changed page', { skip: !runBrowserSmoke }, async (t) => {
  const testWorkspace = await createBrowserTestWorkspace('browser-debug-session-smoke-');
  t.after(() => testWorkspace.cleanup());
  const { cwd } = testWorkspace;
  await writeFile(path.join(cwd, '.gitignore'), '.browser-debug/\n', 'utf8');
  const fixture = path.join(cwd, 'fixture.html');
  await writeFile(fixture, [
    '<!doctype html>',
    '<html lang="en">',
    '<head><title>Session Smoke</title></head>',
    '<body>',
    '<h1>Session Smoke Page</h1>',
    '<button id="primary" onclick="document.getElementById(\'result\').textContent = \'Clicked\'">Primary Action</button>',
    '<p id="result">Waiting</p>',
    '</body>',
    '</html>'
  ].join('\n'), 'utf8');

  const started = await executeCli([
    'session',
    'start',
    '--url',
    `file://${fixture}`,
    '--json'
  ], { cwd });
  assert.equal(started.exitCode, 0);
  const sessionId = JSON.parse(started.stdout).data.session.id;
  testWorkspace.trackSession(sessionId, (id) => stopBrowserSession(cwd, id));

  const acted = await executeCli([
    'act',
    '--session',
    sessionId,
    '--action',
    '{"type":"click","selector":"#primary"}',
    '--json'
  ], { cwd });
  assert.equal(acted.exitCode, 0);
  const body = JSON.parse(acted.stdout);
  assert.equal(body.data.action_result.type, 'click');
  assert.match(body.data.session.current_url, /^file:/);
  assert.match(body.data.session.action_history[0].action.selector, /#primary/);
  assert.match(body.data.action_result.final_url, /^file:/);
  const observation = body.artifacts.find((artifact) => artifact.type === 'observation');
  assert.ok(observation);
  const observed = JSON.parse(await readFile(path.join(cwd, observation.path), 'utf8'));
  assert.match(observed.page.visible_text, /Clicked/);
});

test('persistent session keeps one browser context across act observe checkpoint review and stop', { skip: !runBrowserSmoke }, async (t) => {
  const testWorkspace = await createBrowserTestWorkspace('trace-cue-persistent-session-smoke-');
  t.after(() => testWorkspace.cleanup());
  const { cwd } = testWorkspace;
  await writeFile(path.join(cwd, '.gitignore'), '.browser-debug/\n', 'utf8');
  const fixture = path.join(cwd, 'fixture.html');
  await writeFile(fixture, [
    '<!doctype html>',
    '<html lang="en">',
    '<head><title>Persistent Session Smoke</title></head>',
    '<body>',
    '<h1>Persistent Session Page</h1>',
    '<button id="primary" onclick="document.getElementById(\'result\').textContent = \'Persistent Clicked\'">Primary Action</button>',
    '<p id="result">Waiting</p>',
    '</body>',
    '</html>'
  ].join('\n'), 'utf8');

  let sessionId = null;
  try {
    const started = await executeCli([
      'session',
      'start',
      '--url',
      `file://${fixture}`,
      '--ttl',
      '1m',
      '--idle-timeout',
      '30s',
      '--timeout',
      '10000',
      '--json'
    ], { cwd });
    assert.equal(started.exitCode, 0);
    const startedBody = JSON.parse(started.stdout);
    sessionId = startedBody.data.session.id;
    testWorkspace.trackSession(() => sessionId, (id) => stopBrowserSession(cwd, id));
    assert.equal(startedBody.command, 'session start');
    assert.equal(startedBody.data.session.mode, 'persistent_browser_session');
    assert.equal(startedBody.data.session.browser.retained_context, true);
    assert.equal(startedBody.data.session.browser.existing_profile_reused, false);
    assert.equal(startedBody.data.session.security.external_upload, false);

    const status = await executeCli(['session', 'status', '--session', sessionId, '--json'], { cwd });
    assert.equal(status.exitCode, 0);
    assert.equal(JSON.parse(status.stdout).data.session.process_status, 'alive');

    const acted = await executeCli([
      'session',
      'act',
      '--session',
      sessionId,
      '--action',
      '{"type":"click","selector":"#primary"}',
      '--timeout',
      '10000',
      '--json'
    ], { cwd });
    assert.equal(acted.exitCode, 0);
    const actedBody = JSON.parse(acted.stdout);
    assert.equal(actedBody.data.action_result.type, 'click');
    assert.equal(actedBody.data.session.action_history[0].action.value_recorded, false);
    const actionObservation = actedBody.artifacts.find((artifact) => artifact.type === 'observation');
    assert.ok(actionObservation);
    const actionObservationJson = JSON.parse(await readFile(path.join(cwd, actionObservation.path), 'utf8'));
    assert.match(actionObservationJson.page.visible_text, /Persistent Clicked/);

    const observed = await executeCli([
      'session',
      'observe',
      '--session',
      sessionId,
      '--screenshot',
      '--timeout',
      '10000',
      '--json'
    ], { cwd });
    assert.equal(observed.exitCode, 0);
    const observedBody = JSON.parse(observed.stdout);
    assert.equal(observedBody.data.session.id, sessionId);
    assert.ok(observedBody.artifacts.find((artifact) => artifact.type === 'screenshot'));

    const checkpointed = await executeCli([
      'session',
      'checkpoint',
      '--session',
      sessionId,
      '--name',
      'clicked',
      '--until-selector',
      '#result',
      '--timeout',
      '10000',
      '--json'
    ], { cwd });
    assert.equal(checkpointed.exitCode, 0);
    const checkpointedBody = JSON.parse(checkpointed.stdout);
    assert.equal(checkpointedBody.data.checkpoint.session, sessionId);
    assert.equal(checkpointedBody.data.storage_state.exported, false);
    const checkpointArtifact = checkpointedBody.artifacts.find((artifact) => artifact.type === 'session_checkpoint');
    assert.ok(checkpointArtifact);
    await access(path.join(cwd, checkpointArtifact.path));

    const reviewed = await executeCli([
      'session',
      'review',
      '--session',
      sessionId,
      '--screenshot',
      '--report',
      '--timeout',
      '10000',
      '--json'
    ], { cwd });
    assert.equal(reviewed.exitCode, 0);
    const reviewedBody = JSON.parse(reviewed.stdout);
    assert.equal(reviewedBody.data.review_artifact_index.session, sessionId);
    assert.equal(reviewedBody.data.review_artifact_index.boundaries.agentic_human_review_input_compatible, true);
    assert.ok(reviewedBody.artifacts.find((artifact) => artifact.type === 'review_artifact_index'));

    const stopped = await executeCli(['session', 'stop', '--session', sessionId, '--timeout', '10000', '--json'], { cwd });
    assert.equal(stopped.exitCode, 0);
    assert.match(JSON.parse(stopped.stdout).data.session.status, /^(stopped|exited)$/);
    sessionId = null;
  } finally {
    if (sessionId) {
      await executeCli(['session', 'stop', '--session', sessionId, '--timeout', '10000', '--json'], { cwd }).catch(() => {});
      sessionId = null;
    }
  }
});

test('session actions cover form controls and exported evidence', { skip: !runBrowserSmoke }, async (t) => {
  const testWorkspace = await createBrowserTestWorkspace('browser-debug-actions-smoke-');
  t.after(() => testWorkspace.cleanup());
  const { cwd } = testWorkspace;
  await writeFile(path.join(cwd, '.gitignore'), '.browser-debug/\n', 'utf8');
  const fixture = path.join(cwd, 'fixture.html');
  await writeFile(fixture, [
    '<!doctype html>',
    '<html lang="en">',
    '<head><title>Action Smoke</title></head>',
    '<body style="min-height: 2200px">',
    '<h1>Action Smoke Page</h1>',
    '<label>Name <input id="name" oninput="document.getElementById(\'name-result\').textContent = `Filled ${this.value}`"></label>',
    '<p id="name-result">Name pending</p>',
    '<label>Mode <select id="mode" onchange="document.getElementById(\'mode-result\').textContent = `Mode ${this.value}`"><option value="alpha">Alpha</option><option value="beta">Beta</option></select></label>',
    '<p id="mode-result">Mode pending</p>',
    '<label>Shortcut <input id="shortcut" onkeydown="document.getElementById(\'key-result\').textContent = `Key ${event.key}`"></label>',
    '<p id="key-result">Key pending</p>',
    '<p id="scroll-result">Scroll pending</p>',
    '<script>window.addEventListener("scroll", () => { document.getElementById("scroll-result").textContent = `Scrolled ${window.scrollY > 0}`; });</script>',
    '</body>',
    '</html>'
  ].join('\n'), 'utf8');

  const started = await executeCli([
    'session',
    'start',
    '--url',
    `file://${fixture}`,
    '--json'
  ], { cwd });
  assert.equal(started.exitCode, 0);
  const sessionId = JSON.parse(started.stdout).data.session.id;
  testWorkspace.trackSession(sessionId, (id) => stopBrowserSession(cwd, id));

  const filled = await runAction(cwd, sessionId, { type: 'fill', selector: '#name', value: 'Example User' });
  assert.match(await observationText(cwd, filled), /Filled Example User/);

  const selected = await runAction(cwd, sessionId, { type: 'select', selector: '#mode', value: 'beta' });
  assert.match(await observationText(cwd, selected), /Mode beta/);

  const pressed = await runAction(cwd, sessionId, { type: 'press', selector: '#shortcut', key: 'Enter' });
  assert.match(await observationText(cwd, pressed), /Key Enter/);

  const scrolled = await runAction(cwd, sessionId, { type: 'scroll', deltaY: 900 });
  assert.match(await observationText(cwd, scrolled), /Scrolled true/);

  const waited = await runAction(cwd, sessionId, { type: 'wait', ms: 25 });
  assert.equal(JSON.parse(waited.stdout).data.action_result.type, 'wait');

  const screenshot = await runAction(cwd, sessionId, { type: 'screenshot' });
  const screenshotBody = JSON.parse(screenshot.stdout);
  const screenshotArtifact = screenshotBody.artifacts.find((artifact) => artifact.type === 'screenshot');
  assert.ok(screenshotArtifact);
  await access(path.join(cwd, screenshotArtifact.path));

  const reported = await executeCli(['report', '--session', sessionId, '--json'], { cwd });
  assert.equal(reported.exitCode, 0);
  const reportArtifact = JSON.parse(reported.stdout).artifacts.find((artifact) => artifact.type === 'report');
  assert.ok(reportArtifact);
  const report = await readFile(path.join(cwd, reportArtifact.path), 'utf8');
  assert.match(report, /"type":"fill"/);
  assert.match(report, /"type":"screenshot"/);

  const exported = await executeCli(['spec', 'export', '--session', sessionId, '--json'], { cwd });
  assert.equal(exported.exitCode, 0);
  const specBody = JSON.parse(exported.stdout);
  assert.deepEqual(
    specBody.data.spec.steps.map((step) => step.action.type),
    ['fill', 'select', 'press', 'scroll', 'wait', 'screenshot']
  );
  const specArtifact = specBody.artifacts.find((artifact) => artifact.type === 'spec');
  assert.ok(specArtifact);
  await access(path.join(cwd, specArtifact.path));
});

test('supervise keeps one ephemeral context for ordered actions', { skip: !runBrowserSmoke }, async (t) => {
  const testWorkspace = await createBrowserTestWorkspace('browser-debug-supervise-smoke-');
  t.after(() => testWorkspace.cleanup());
  const { cwd } = testWorkspace;
  await writeFile(path.join(cwd, '.gitignore'), '.browser-debug/\n', 'utf8');
  const fixture = path.join(cwd, 'fixture.html');
  await writeFile(fixture, [
    '<!doctype html>',
    '<html lang="en">',
    '<head><title>Supervision Smoke</title></head>',
    '<body>',
    '<h1>Supervise Smoke Page</h1>',
    '<label>Name <input id="name" oninput="document.getElementById(\'result\').textContent = `Name ${this.value}`"></label>',
    '<button id="primary" onclick="document.getElementById(\'clicked\').textContent = document.getElementById(\'name\').value">Apply</button>',
    '<p id="result">Name pending</p>',
    '<p id="clicked">Click pending</p>',
    '</body>',
    '</html>'
  ].join('\n'), 'utf8');

  const result = await executeCli([
    'supervise',
    '--url',
    `file://${fixture}`,
    '--actions',
    JSON.stringify([
      { type: 'fill', selector: '#name', value: 'Example User' },
      { type: 'click', selector: '#primary' },
      { type: 'observe' }
    ]),
    '--screenshot',
    '--trace',
    '--timeout',
    '10000',
    '--json'
  ], { cwd });

  assert.equal(result.exitCode, 0);
  const body = JSON.parse(result.stdout);
  assert.equal(body.command, 'supervise');
  assert.equal(body.status, 'ok');
  assert.equal(body.data.supervision.mode, 'supervised_ephemeral_context');
  assert.equal(body.data.supervision.browser.existing_profile_reused, false);
  assert.equal(body.data.supervision.action_history.length, 3);
  assert.match(body.data.final_observation.page.visible_text, /Name Example User/);
  assert.match(body.data.final_observation.page.visible_text, /Example User/);

  const observations = body.artifacts.filter((artifact) => artifact.type === 'observation');
  const screenshot = body.artifacts.find((artifact) => artifact.type === 'screenshot');
  const trace = body.artifacts.find((artifact) => artifact.type === 'trace');
  const supervision = body.artifacts.find((artifact) => artifact.type === 'supervision');
  assert.equal(observations.length, 4);
  assert.ok(screenshot);
  assert.ok(trace);
  assert.ok(supervision);
  await access(path.join(cwd, observations.at(-1).path));
  await access(path.join(cwd, screenshot.path));
  await access(path.join(cwd, trace.path));
  await access(path.join(cwd, supervision.path));
});

test('daemon start status and stop keep a local ephemeral browser process', { skip: !runBrowserSmoke }, async (t) => {
  const testWorkspace = await createBrowserTestWorkspace('browser-debug-daemon-smoke-');
  t.after(() => testWorkspace.cleanup());
  const { cwd } = testWorkspace;
  await writeFile(path.join(cwd, '.gitignore'), '.browser-debug/\n', 'utf8');
  const fixture = path.join(cwd, 'fixture.html');
  await writeFile(fixture, [
    '<!doctype html>',
    '<html lang="en">',
    '<head><title>Daemon Smoke</title></head>',
    '<body>',
    '<h1>Daemon Smoke Page</h1>',
    '</body>',
    '</html>'
  ].join('\n'), 'utf8');

  let daemonId = null;
  try {
    const started = await executeCli([
      'daemon',
      'start',
      '--url',
      `file://${fixture}`,
      '--timeout',
      '10000',
      '--json'
    ], { cwd });
    assert.equal(started.exitCode, 0);
    const startedBody = JSON.parse(started.stdout);
    daemonId = startedBody.data.daemon.id;
    testWorkspace.trackDaemon(() => daemonId, (id) => stopBrowserDaemon(cwd, id));
    assert.equal(startedBody.command, 'daemon start');
    assert.equal(startedBody.data.daemon.status, 'running');
    assert.equal(startedBody.data.daemon.browser.ephemeral_context, true);
    assert.equal(startedBody.data.daemon.browser.existing_profile_reused, false);
    assert.equal(startedBody.data.daemon.browser.persistent_storage, false);
    assert.equal(startedBody.data.daemon.control.external_channel, false);
    assert.match(startedBody.data.daemon.current_url, /^file:/);

    const daemonArtifact = startedBody.artifacts.find((artifact) => artifact.type === 'daemon');
    assert.ok(daemonArtifact);
    await access(path.join(cwd, daemonArtifact.path));

    const status = await executeCli(['daemon', 'status', '--daemon', daemonId, '--json'], { cwd });
    assert.equal(status.exitCode, 0);
    const statusBody = JSON.parse(status.stdout);
    assert.equal(statusBody.data.daemon.status, 'running');
    assert.equal(statusBody.data.daemon.process_status, 'alive');

    const stopped = await executeCli(['daemon', 'stop', '--daemon', daemonId, '--json'], { cwd });
    assert.equal(stopped.exitCode, 0);
    const stoppedBody = JSON.parse(stopped.stdout);
    assert.match(stoppedBody.data.daemon.status, /^(stopped|exited)$/);
    assert.equal(stoppedBody.data.daemon.process_status, 'not_alive');
    daemonId = null;
  } finally {
    if (daemonId) {
      await executeCli(['daemon', 'stop', '--daemon', daemonId, '--json'], { cwd }).catch(() => {});
      daemonId = null;
    }
  }
});

test('review reports deterministic layout and browser-health findings', { skip: !runBrowserSmoke }, async (t) => {
  const testWorkspace = await createBrowserTestWorkspace('browser-debug-review-smoke-');
  t.after(() => testWorkspace.cleanup());
  const { cwd } = testWorkspace;
  await writeFile(path.join(cwd, '.gitignore'), '.browser-debug/\n', 'utf8');
  const fixture = path.join(cwd, 'review.html');
  const mock = path.join(cwd, 'mock.png');
  await writeFile(mock, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l9V2JwAAAABJRU5ErkJggg==', 'base64'));
  await writeFile(fixture, [
    '<!doctype html>',
    '<html lang="en">',
    '<head><title>Review Smoke</title></head>',
    '<body>',
    '<h1>Review Smoke Page</h1>',
    '<div id="wide" style="width:2000px;height:20px;background:#ccc">Wide content</div>',
    '<div id="clip" style="width:20px;height:18px;overflow:hidden;white-space:nowrap">Clipped content should be detected</div>',
    '<button id="nameless" style="width:32px;height:32px"></button>',
    '<img id="missing-alt" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" style="width:32px;height:32px">',
    '<p id="low-contrast" style="color:rgb(120,120,120);background:rgb(120,120,120)">Low contrast text</p>',
    '<div style="position:relative;width:160px;height:70px">',
    '<p id="overlap-a" style="position:absolute;left:0;top:0;width:90px;height:36px;background:#eee">Alpha panel</p>',
    '<p id="overlap-b" style="position:absolute;left:10px;top:6px;width:90px;height:36px;background:#ddd">Beta panel</p>',
    '</div>',
    '<script>console.error("Review smoke console failure")</script>',
    '</body>',
    '</html>'
  ].join('\n'), 'utf8');

  const result = await executeCli([
    'review',
    '--url',
    `file://${fixture}`,
    '--viewport',
    '390x844',
    '--screenshot',
    '--mock',
    'mock.png',
    '--report',
    '--timeout',
    '10000',
    '--json'
  ], { cwd });

  assert.equal(result.exitCode, 0);
  const body = JSON.parse(result.stdout);
  assert.equal(body.command, 'review');
  assert.equal(body.status, 'ok');
  assert.equal(body.data.review.mode, 'single_url');
  assert.equal(body.data.action_plan.release_gate.status, 'blocked');
  assert.equal(body.data.review_advisory.status, 'needs_attention');
  assert.equal(body.data.quality_signals.reviewer, 'local_quality_signals');
  assert.equal(body.data.quality_signals.model_review_boundary.external_evidence_transfer, false);
  assert.equal(body.data.quality_signals.accessibility_structure.missing_image_alt_count >= 1, true);
  assert.equal(body.data.quality_signals.accessibility_structure.low_contrast_text_count >= 1, true);
  assert.equal(body.data.quality_signals.responsive_layout.overlap_pair_count >= 1, true);
  assert.ok(body.data.findings.some((finding) => finding.category === 'browser_health'));
  assert.ok(body.data.findings.some((finding) => finding.category === 'layout_integrity'));
  assert.ok(body.data.findings.some((finding) => finding.category === 'accessibility_basics'));
  assert.ok(body.data.findings.some((finding) => finding.category === 'mock_fidelity'));
  assert.ok(body.data.findings.some((finding) => /alt text/.test(finding.message)));
  assert.ok(body.data.findings.some((finding) => /contrast/.test(finding.message)));
  assert.ok(body.data.findings.some((finding) => /overlap/.test(finding.message)));
  assert.ok(body.data.findings.every((finding) => finding.priority));
  assert.ok(body.data.findings.some((finding) => finding.recommendation));

  for (const type of ['review', 'layout', 'screenshot', 'visual_evidence', 'report', 'mock_metrics']) {
    const artifact = body.artifacts.find((candidate) => candidate.type === type);
    assert.ok(artifact, `missing ${type} artifact`);
    await access(path.join(cwd, artifact.path));
  }
  const report = body.artifacts.find((artifact) => artifact.type === 'report');
  const reportText = await readFile(path.join(cwd, report.path), 'utf8');
  assert.match(reportText, /Quality Signals/);
  assert.match(reportText, /Local release gate/);
  assert.equal(body.data.visual_evidence.length, 1);
  assert.equal(body.data.visual_evidence[0].boundary.raw_pixels_in_json, false);
});

test('review reports rendered-state evidence for media loading and empty data UI', { skip: !runBrowserSmoke }, async (t) => {
  const testWorkspace = await createBrowserTestWorkspace('browser-debug-rendered-state-smoke-');
  t.after(() => testWorkspace.cleanup());
  const { cwd } = testWorkspace;
  await writeFile(path.join(cwd, '.gitignore'), '.browser-debug/\n', 'utf8');
  const fixture = path.join(cwd, 'rendered-state.html');
  await writeFile(fixture, [
    '<!doctype html>',
    '<html lang="en">',
    '<head><title>Rendered State Smoke</title></head>',
    '<body>',
    '<main>',
    '<h1>Rendered State</h1>',
    '<img id="broken-image" src="./missing-chart.png" alt="Revenue chart" style="width:80px;height:48px">',
    '<div id="loading-panel" aria-busy="true">Loading reports</div>',
    '<table id="orders"><thead><tr><th>Order</th></tr></thead><tbody></tbody></table>',
    '</main>',
    '</body>',
    '</html>'
  ].join('\n'), 'utf8');

  const result = await executeCli([
    'review',
    '--url',
    `file://${fixture}`,
    '--screenshot',
    '--report',
    '--timeout',
    '10000',
    '--json'
  ], { cwd });

  assert.equal(result.exitCode, 0);
  const body = JSON.parse(result.stdout);
  assert.equal(body.data.quality_signals.rendered_state.status, 'needs_attention');
  assert.equal(body.data.quality_signals.rendered_state.broken_image_count >= 1, true);
  assert.equal(body.data.quality_signals.rendered_state.loading_indicator_count >= 1, true);
  assert.equal(body.data.quality_signals.rendered_state.empty_container_warning_count >= 1, true);
  assert.ok(body.data.findings.some((finding) => /appears broken or unfinished/.test(finding.message)));
  assert.ok(body.data.findings.some((finding) => /loading indicator/.test(finding.message)));
  assert.ok(body.data.findings.some((finding) => /empty without a visible empty-state/.test(finding.message)));
  assert.equal(body.data.evidence_summary.loading_indicators.length >= 1, true);
  assert.equal(body.data.evidence_summary.empty_containers.length >= 1, true);

  const report = body.artifacts.find((artifact) => artifact.type === 'report');
  assert.ok(report);
  const reportText = await readFile(path.join(cwd, report.path), 'utf8');
  assert.match(reportText, /Developer Triage/);
  assert.match(reportText, /Rendered state: needs_attention/);
});

test('review does not treat ready and progress business text as lingering loading UI', { skip: !runBrowserSmoke }, async (t) => {
  const testWorkspace = await createBrowserTestWorkspace('browser-debug-ready-state-smoke-');
  t.after(() => testWorkspace.cleanup());
  const { cwd } = testWorkspace;
  await writeFile(path.join(cwd, '.gitignore'), '.browser-debug/\n', 'utf8');
  const fixture = path.join(cwd, 'ready-state.html');
  await writeFile(fixture, [
    '<!doctype html>',
    '<html lang="en">',
    '<head><title>Ready State Smoke</title></head>',
    '<body>',
    '<div id="root">',
    '<main>',
    '<h1>Run Status</h1>',
    '<section aria-labelledby="run-title">',
    '<h2 id="run-title">Current Run</h2>',
    '<p>Status ready</p>',
    '<p>Progress 3 / 3</p>',
    '<p>adapter-ready</p>',
    '<div role="status" aria-label="Progress 3 / 3">Ready for review</div>',
    '<p>Review state is ready for developer handoff.</p>',
    '</section>',
    '</main>',
    '</div>',
    '</body>',
    '</html>'
  ].join('\n'), 'utf8');

  const result = await executeCli([
    'review',
    '--url',
    `file://${fixture}`,
    '--timeout',
    '10000',
    '--json'
  ], { cwd });

  assert.equal(result.exitCode, 0);
  const body = JSON.parse(result.stdout);
  assert.equal(body.data.quality_signals.rendered_state.loading_indicator_count, 0);
  assert.equal(body.data.evidence_summary.loading_indicators.length, 0);
  assert.equal(body.data.findings.some((finding) => /loading indicator/.test(finding.message)), false);
});

test('target review discovers same-origin routes and records coverage', { skip: !runBrowserSmoke }, async (t) => {
  const testWorkspace = await createBrowserTestWorkspace('browser-debug-target-review-smoke-');
  t.after(() => testWorkspace.cleanup());
  const { cwd } = testWorkspace;
  await writeFile(path.join(cwd, '.gitignore'), '.browser-debug/\n', 'utf8');
  const first = path.join(cwd, 'first.html');
  const second = path.join(cwd, 'second.html');
  const expected = path.join(cwd, 'expected.html');
  const manifest = path.join(cwd, 'target.json');
  await writeFile(first, [
    '<!doctype html>',
    '<html lang="en">',
    '<head><title>First Review Route</title></head>',
    '<body>',
    '<h1>First Route</h1>',
    `<a id="next" href="file://${second}">Second Route</a>`,
    '</body>',
    '</html>'
  ].join('\n'), 'utf8');
  await writeFile(second, [
    '<!doctype html>',
    '<html lang="en">',
    '<head><title>Second Review Route</title></head>',
    '<body>',
    '<h1>Second Route</h1>',
    '</body>',
    '</html>'
  ].join('\n'), 'utf8');
  await writeFile(expected, [
    '<!doctype html>',
    '<html lang="en">',
    '<head><title>Expected Review Route</title></head>',
    '<body>',
    '<h1>Expected Route</h1>',
    '</body>',
    '</html>'
  ].join('\n'), 'utf8');
  await writeFile(manifest, JSON.stringify({
    baseUrl: `file://${first}`,
    seeds: [`file://${first}`],
    expectedRoutes: [`file://${expected}`],
    viewportMatrix: ['mobile'],
    budgets: { maxRoutes: 3 },
    artifacts: { screenshots: true }
  }), 'utf8');

  const result = await executeCli([
    'review',
    '--target',
    '@target.json',
    '--report',
    '--timeout',
    '10000',
    '--json'
  ], { cwd });

  assert.equal(result.exitCode, 0);
  const body = JSON.parse(result.stdout);
  assert.equal(body.command, 'review');
  assert.equal(body.status, 'ok');
  assert.equal(body.data.review.mode, 'target_manifest');
  assert.ok(body.data.coverage.routes.discovered.length >= 3);
  assert.ok(body.data.coverage.routes.visited.length >= 3);
  assert.equal(body.data.coverage.routes.expected.length, 1);
  assert.ok(body.data.coverage.routes.visited.some((route) => route.url === `file://${expected}`));
  const coverage = body.artifacts.find((artifact) => artifact.type === 'coverage');
  assert.ok(coverage);
  await access(path.join(cwd, coverage.path));
  assert.equal(body.data.action_plan.coverage.discovered_routes >= 3, true);
  assert.equal(body.data.review_advisory.reviewer, 'local_heuristic');
  assert.equal(body.data.quality_signals.route_coverage.status, 'passed');
  assert.equal(body.data.quality_signals.route_coverage.expected_manifest_routes, 1);
  assert.equal(body.data.quality_signals.model_review_boundary.external_evidence_transfer, false);
  assert.ok(body.data.manifest_suggestions.some((suggestion) => suggestion.type === 'add_page_expectations'));
  const report = body.artifacts.find((artifact) => artifact.type === 'report');
  assert.ok(report);
  await access(path.join(cwd, report.path));
  const reportText = await readFile(path.join(cwd, report.path), 'utf8');
  assert.match(reportText, /Quality Signals/);
  assert.match(reportText, /Manifest Suggestions/);
});

test('target review records route budget skips for unvisited discovered routes', { skip: !runBrowserSmoke }, async (t) => {
  const testWorkspace = await createBrowserTestWorkspace('browser-debug-target-budget-smoke-');
  t.after(() => testWorkspace.cleanup());
  const { cwd } = testWorkspace;
  await writeFile(path.join(cwd, '.gitignore'), '.browser-debug/\n', 'utf8');
  const first = path.join(cwd, 'first.html');
  const expected = path.join(cwd, 'expected.html');
  const manifest = path.join(cwd, 'target.json');
  await writeFile(first, [
    '<!doctype html>',
    '<html lang="en">',
    '<head><title>Budget First Route</title></head>',
    '<body>',
    '<h1>Budget First Route</h1>',
    '</body>',
    '</html>'
  ].join('\n'), 'utf8');
  await writeFile(expected, [
    '<!doctype html>',
    '<html lang="en">',
    '<head><title>Budget Expected Route</title></head>',
    '<body>',
    '<h1>Budget Expected Route</h1>',
    '</body>',
    '</html>'
  ].join('\n'), 'utf8');
  await writeFile(manifest, JSON.stringify({
    baseUrl: `file://${first}`,
    seeds: [`file://${first}`],
    expectedRoutes: [`file://${expected}`],
    viewportMatrix: ['mobile'],
    budgets: { maxRoutes: 1 },
    artifacts: { screenshots: false }
  }), 'utf8');

  const result = await executeCli([
    'review',
    '--target',
    '@target.json',
    '--timeout',
    '10000',
    '--json'
  ], { cwd });

  assert.equal(result.exitCode, 0);
  const body = JSON.parse(result.stdout);
  assert.equal(body.command, 'review');
  assert.equal(body.status, 'ok');
  assert.equal(body.data.coverage.routes.expected.length, 1);
  assert.equal(body.data.coverage.routes.visited.length, 1);
  assert.ok(body.data.coverage.routes.skipped.some((route) => route.reason === 'route_budget_exceeded'));
  assert.equal(body.data.quality_signals.route_coverage.status, 'needs_attention');
  assert.equal(body.data.quality_signals.route_coverage.route_budget_exceeded_routes, 1);
});

test('target review checks manifest page expectations and writes an artifact index', { skip: !runBrowserSmoke }, async (t) => {
  const testWorkspace = await createBrowserTestWorkspace('browser-debug-page-expectation-smoke-');
  t.after(() => testWorkspace.cleanup());
  const { cwd } = testWorkspace;
  await writeFile(path.join(cwd, '.gitignore'), '.browser-debug/\n', 'utf8');
  const page = path.join(cwd, 'state.html');
  const mock = path.join(cwd, 'mock.png');
  const manifest = path.join(cwd, 'target.json');
  await writeFile(mock, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l9V2JwAAAABJRU5ErkJggg==', 'base64'));
  await writeFile(page, [
    '<!doctype html>',
    '<html lang="en">',
    '<head><title>State Route</title></head>',
    '<body>',
    '<main>',
    '<h1>Expected State</h1>',
    '<button id="primary">Primary Action</button>',
    '</main>',
    '</body>',
    '</html>'
  ].join('\n'), 'utf8');
  await writeFile(manifest, JSON.stringify({
    baseUrl: `file://${page}`,
    seeds: [`file://${page}`],
    pages: [{
      name: 'Expected State Page',
      url: `file://${page}`,
      priority: 'high',
      viewports: ['mobile'],
      expectations: {
        text: ['Expected State'],
        selectors: ['#primary', '#secondary']
      },
      mock: 'mock.png',
      threshold: 0
    }],
    viewportMatrix: ['desktop'],
    budgets: { maxRoutes: 2 },
    artifacts: { screenshots: true }
  }), 'utf8');

  const result = await executeCli([
    'review',
    '--target',
    '@target.json',
    '--report',
    '--timeout',
    '10000',
    '--json'
  ], { cwd });

  assert.equal(result.exitCode, 0);
  const body = JSON.parse(result.stdout);
  assert.equal(body.command, 'review');
  assert.equal(body.status, 'ok');
  assert.equal(body.data.coverage.pages.expected.length, 1);
  assert.equal(body.data.coverage.pages.checked.length, 1);
  assert.equal(body.data.coverage.pages.failed.length, 1);
  assert.equal(body.data.coverage.pages.checked[0].viewport.name, 'mobile');
  assert.equal(body.data.quality_signals.page_expectations.status, 'needs_attention');
  assert.equal(body.data.quality_signals.page_expectations.failed_pages, 1);
  assert.equal(body.data.quality_signals.page_expectations.missing_selector_expectations, 1);
  assert.equal(body.data.artifact_index.local_only, true);
  assert.equal(body.data.artifact_index.external_upload, false);
  assert.ok(body.data.findings.some((finding) => /Expected selector #secondary/.test(finding.message)));
  assert.ok(body.artifacts.some((artifact) => artifact.type === 'mock_metrics'));

  const indexes = body.artifacts.filter((artifact) => artifact.type === 'review_artifact_index');
  assert.ok(indexes.length >= 1);
  const targetIndex = indexes[indexes.length - 1];
  const indexJson = JSON.parse(await readFile(path.join(cwd, targetIndex.path), 'utf8'));
  assert.equal(indexJson.triage.page_expectations, 'needs_attention');
  assert.equal(indexJson.coverage_summary.expected_pages, 1);
  assert.equal(indexJson.boundaries.profile_reuse, false);
  assert.equal(indexJson.boundaries.credential_storage, false);
  assert.ok(indexJson.evidence_classes.includes('screenshot'));

  const report = body.artifacts.find((artifact) => artifact.type === 'report');
  assert.ok(report);
  const reportText = await readFile(path.join(cwd, report.path), 'utf8');
  assert.match(reportText, /Page expectations/);
});

test('target content UX advisory is opt-in and does not alter review gates', { skip: !runBrowserSmoke }, async (t) => {
  const testWorkspace = await createBrowserTestWorkspace('browser-debug-content-ux-smoke-');
  t.after(() => testWorkspace.cleanup());
  const { cwd } = testWorkspace;
  await writeFile(path.join(cwd, '.gitignore'), '.browser-debug/\n', 'utf8');
  const page = path.join(cwd, 'overview.html');
  const disabledManifest = path.join(cwd, 'disabled.json');
  const enabledManifest = path.join(cwd, 'enabled.json');
  await writeFile(page, [
    '<!doctype html>',
    '<html lang="en">',
    '<head><title>Overview Route</title></head>',
    '<body>',
    '<main>',
    '<h1>Overview</h1>',
    '<p id="summary" data-state="ready">Operations summary ready</p>',
    '<p id="checks" data-status="passed">Health checks passed</p>',
    '<p id="risk" data-risk="low">Low risk</p>',
    '<button id="primary">Open Details</button>',
    '</main>',
    '</body>',
    '</html>'
  ].join('\n'), 'utf8');
  const baseManifest = {
    baseUrl: `file://${page}`,
    seeds: [`file://${page}`],
    pages: [{
      name: 'Overview Page',
      url: `file://${page}`,
      role: 'status_overview',
      expectations: {
        dataBindings: [{
          id: 'summary-copy',
          sourceId: 'service',
          pointer: '/status/summary',
          selector: '#summary',
          target: 'text'
        }, {
          id: 'summary-state',
          sourceId: 'service',
          pointer: '/status/state',
          selector: '#summary',
          target: 'data-state',
          match: 'exact'
        }, {
          id: 'check-status',
          sourceId: 'service',
          pointer: '/checks/status',
          selector: '#checks',
          target: 'attribute',
          attribute: 'data-status',
          match: 'exact'
        }, {
          id: 'risk-level',
          sourceId: 'service',
          pointer: '/risk/level',
          selector: '#risk',
          target: 'data-risk',
          match: 'exact'
        }],
        userQuestions: [{
          id: 'risk-awareness',
          question: 'Can the user tell whether the status needs attention?',
          expectedEvidence: ['Low risk'],
          selector: '#risk'
        }]
      }
    }],
    viewportMatrix: ['desktop'],
    budgets: { maxRoutes: 1 },
    artifacts: { screenshots: true }
  };
  await writeFile(disabledManifest, JSON.stringify(baseManifest), 'utf8');
  await writeFile(enabledManifest, JSON.stringify({
    ...baseManifest,
    sourceData: [{
      id: 'service',
      data: {
        status: { summary: 'Operations summary ready', state: 'ready' },
        checks: { status: 'passed' },
        risk: { level: 'low' }
      }
    }],
    localContentUxAdvisory: {
      enabled: true,
      audience: ['operators'],
      goal: 'Explain the current service status at a glance.',
      requiredUserQuestions: [{
        id: 'summary-awareness',
        pageId: 'overview-page',
        question: 'Can the user understand the current summary?',
        expectedEvidence: ['Operations summary']
      }],
      reviewBrief: {
        summary: 'The overview page should let operators understand status, risk, and next actions.',
        userRoles: ['operator'],
        decisionNeeds: [{
          id: 'state-decision',
          pageId: 'overview-page',
          question: 'Can operators decide whether the status needs intervention?',
          expectedEvidence: ['Low risk']
        }]
      },
      rubric: [{
        id: 'state-clarity',
        category: 'status_clarity',
        pageId: 'overview-page',
        criterion: 'The page communicates status and risk.',
        expectedEvidence: ['Low risk'],
        severity: 'medium'
      }]
    }
  }), 'utf8');

  const disabled = await executeCli([
    'review',
    '--target',
    '@disabled.json',
    '--report',
    '--timeout',
    '10000',
    '--json'
  ], { cwd });
  const enabled = await executeCli([
    'review',
    '--target',
    '@enabled.json',
    '--report',
    '--timeout',
    '10000',
    '--json'
  ], { cwd });

  assert.equal(disabled.exitCode, 0);
  assert.equal(enabled.exitCode, 0);
  const disabledBody = JSON.parse(disabled.stdout);
  const enabledBody = JSON.parse(enabled.stdout);
  assert.equal(disabledBody.data.local_content_ux_advisory, undefined);
  assert.equal(disabledBody.data.content_ux_findings, undefined);
  assert.equal(disabledBody.data.content_ux_action_plan, undefined);
  assert.equal(disabledBody.data.content_ux_readiness, undefined);
  assert.equal(disabledBody.data.content_ux_page_handoff, undefined);
  assert.equal(disabledBody.data.content_ux_manifest_authoring, undefined);
  assert.equal(disabledBody.data.content_ux_review_brief, undefined);
  assert.equal(disabledBody.data.content_ux_rubric_evaluation, undefined);
  assert.equal(disabledBody.data.quality_signals.content_ux, undefined);
  assert.equal(enabledBody.data.local_content_ux_advisory.status, 'passed');
  assert.deepEqual(enabledBody.data.content_ux_findings, []);
  assert.equal(enabledBody.data.content_ux_action_plan.status, 'passed');
  assert.equal(enabledBody.data.content_ux_action_plan.gate_effect, 'none');
  assert.equal(enabledBody.data.content_ux_action_plan.legacy_action_plan_unchanged, true);
  assert.equal(enabledBody.data.content_ux_readiness.status, 'passed');
  assert.equal(enabledBody.data.content_ux_readiness.gate_effect, 'none');
  assert.equal(enabledBody.data.content_ux_readiness.legacy_release_readiness_unchanged, true);
  assert.equal(enabledBody.data.content_ux_page_handoff.status, 'passed');
  assert.equal(enabledBody.data.content_ux_page_handoff.summary.pages, 1);
  assert.equal(enabledBody.data.content_ux_page_handoff.summary.pages_with_findings, 0);
  assert.equal(enabledBody.data.content_ux_manifest_authoring.gate_effect, 'none');
  assert.equal(enabledBody.data.content_ux_review_brief.status, 'passed');
  assert.equal(enabledBody.data.content_ux_review_brief.summary.decision_needs_met, 1);
  assert.equal(enabledBody.data.content_ux_rubric_evaluation.status, 'passed');
  assert.equal(enabledBody.data.content_ux_rubric_evaluation.summary.criteria_passed, 1);
  assert.equal(enabledBody.data.quality_signals.content_ux.status, 'passed');
  assert.equal(enabledBody.data.quality_signals.content_ux.rubric_criteria, 1);
  assert.equal(enabledBody.data.local_content_ux_advisory.counts.data_binding_checks, 4);
  assert.equal(enabledBody.data.local_content_ux_advisory.counts.selector_scoped_binding_checks, 4);
  assert.equal(enabledBody.data.local_content_ux_advisory.counts.attribute_binding_checks, 1);
  assert.equal(enabledBody.data.local_content_ux_advisory.counts.state_binding_checks, 1);
  assert.equal(enabledBody.data.local_content_ux_advisory.counts.risk_binding_checks, 1);
  assert.equal(enabledBody.data.local_content_ux_advisory.counts.required_user_questions, 2);
  assert.equal(enabledBody.data.local_content_ux_advisory.counts.user_questions_answered, 2);
  assert.equal(enabledBody.data.local_content_ux_advisory.gate_effect, 'none');
  assert.equal(enabledBody.data.local_content_ux_advisory.external_evidence_transfer, false);
  assert.equal(enabledBody.data.metrics.finding_count, disabledBody.data.metrics.finding_count);
  assert.deepEqual(
    enabledBody.data.findings.map((finding) => [finding.category, finding.severity, finding.message]),
    disabledBody.data.findings.map((finding) => [finding.category, finding.severity, finding.message])
  );
  assert.deepEqual(enabledBody.data.action_plan.release_gate, disabledBody.data.action_plan.release_gate);
  assert.deepEqual(enabledBody.data.quality_signals.release_readiness, disabledBody.data.quality_signals.release_readiness);

  const report = enabledBody.artifacts.find((artifact) => artifact.type === 'report');
  assert.ok(report);
  const reportText = await readFile(path.join(cwd, report.path), 'utf8');
  assert.match(reportText, /Content UX Advisory/);
  assert.match(reportText, /Content UX Developer Handoff/);
  assert.match(reportText, /Content UX Review Brief/);
  assert.match(reportText, /Manifest authoring suggestions/);
  assert.doesNotMatch(reportText, /Operations summary ready/);
});

async function runAction(cwd, sessionId, action) {
  const result = await executeCli([
    'act',
    '--session',
    sessionId,
    '--action',
    JSON.stringify(action),
    '--json'
  ], { cwd });
  assert.equal(result.exitCode, 0);
  return result;
}

async function observationText(cwd, result) {
  const body = JSON.parse(result.stdout);
  const observation = body.artifacts.find((artifact) => artifact.type === 'observation');
  assert.ok(observation);
  const observed = JSON.parse(await readFile(path.join(cwd, observation.path), 'utf8'));
  return observed.page.visible_text;
}

async function stopBrowserSession(cwd, sessionId) {
  await executeCli(['session', 'stop', '--session', sessionId, '--timeout', '10000', '--json'], { cwd });
}

async function stopBrowserDaemon(cwd, daemonId) {
  await executeCli(['daemon', 'stop', '--daemon', daemonId, '--json'], { cwd });
}

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

async function issueControlCenterPairingUrl(started) {
  const origin = started.url.slice(0, -1);
  const response = await fetch(new URL('/api/pairing/issue', started.url), {
    method: 'POST',
    headers: {
      Origin: origin,
      'X-Trace-Cue-Management-Token': started.managementCapability
    }
  });
  if (response.status !== 201) assert.fail(`Pairing issuance failed: ${response.status} ${await response.text()}`);
  const body = await response.json();
  return {
    token: body.pairing_token,
    url: `${started.url}#pair=${encodeURIComponent(body.pairing_token)}`
  };
}
