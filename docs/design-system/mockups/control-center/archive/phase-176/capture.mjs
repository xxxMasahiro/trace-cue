import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = path.dirname(fileURLToPath(import.meta.url));
const entry = pathToFileURL(path.join(root, 'index.html')).href;

const captures = [
  { name: 'mock-home-desktop.png', screen: 'home', viewport: { width: 1440, height: 1000 } },
  { name: 'mock-new-review-desktop.png', screen: 'new', viewport: { width: 1440, height: 1000 } },
  { name: 'mock-new-review-file-desktop.png', screen: 'new', source: 'document_text', viewport: { width: 1440, height: 1000 } },
  { name: 'mock-send-confirmation-desktop.png', screen: 'new', dialog: 'send', viewport: { width: 1440, height: 1000 } },
  { name: 'mock-progress-desktop.png', screen: 'progress', viewport: { width: 1440, height: 1000 } },
  { name: 'mock-recovery-desktop.png', screen: 'recovery', viewport: { width: 1440, height: 1000 } },
  { name: 'mock-result-desktop.png', screen: 'result', viewport: { width: 1440, height: 1000 } },
  { name: 'mock-intake-result-desktop.png', screen: 'intake-result', viewport: { width: 1440, height: 1000 } },
  { name: 'mock-settings-desktop.png', screen: 'settings', viewport: { width: 1440, height: 1000 } },
  { name: 'mock-settings-saved-desktop.png', screen: 'settings', saved: true, viewport: { width: 1440, height: 1000 } },
  { name: 'mock-new-review-mobile.png', screen: 'new', viewport: { width: 390, height: 844 } },
  { name: 'mock-home-mobile.png', screen: 'home', viewport: { width: 390, height: 844 } },
  { name: 'mock-intake-result-mobile.png', screen: 'intake-result', viewport: { width: 390, height: 844 } },
  { name: 'mock-settings-mobile.png', screen: 'settings', viewport: { width: 390, height: 844 } },
];

const browser = await chromium.launch({ headless: true });

try {
  for (const capture of captures) {
    const page = await browser.newPage({
      viewport: capture.viewport,
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
    });
    const url = new URL(entry);
    url.searchParams.set('screen', capture.screen);
    if (capture.source) url.searchParams.set('source', capture.source);
    if (capture.dialog) url.searchParams.set('dialog', capture.dialog);
    if (capture.saved) url.searchParams.set('saved', '1');
    await page.goto(url.href, { waitUntil: 'load' });
    await page.locator(`[data-mock-screen="${capture.screen}"]`).waitFor();
    if (capture.dialog) await page.locator('#send-dialog').waitFor({ state: 'visible' });
    await page.screenshot({
      path: path.join(root, 'assets', capture.name),
      fullPage: true,
    });
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(`Captured ${captures.length} Control Center mock images.`);
