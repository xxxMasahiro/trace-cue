import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = path.dirname(fileURLToPath(import.meta.url));
const entry = pathToFileURL(path.join(root, 'index.html')).href;
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`${entry}?screen=new`);

  await assert.doesNotReject(() => page.getByRole('heading', { name: '新しく確認' }).waitFor());
  assert.equal(await page.getByRole('textbox', { name: 'WebサイトのURL' }).count(), 1);
  assert.equal(await page.getByRole('textbox', { name: '特に何を確かめますか' }).count(), 1);
  assert.equal(await page.locator('input[name="source"]').count(), 4);
  assert.equal(await page.locator('input[name="source"]:checked').getAttribute('value'), 'website');
  assert.equal(await page.locator('input[name="method"]').count(), 3);
  assert.equal(await page.locator('input[name="method"]:checked').getAttribute('value'), 'standard');

  await page.locator('input[name="source"][value="document_text"]').check();
  assert.equal(await page.locator('input[name="source"]:checked').getAttribute('value'), 'document_text');
  assert.equal(await page.getByRole('textbox', { name: 'WebサイトのURL' }).count(), 0);
  assert.equal(await page.getByLabel('確認するファイル').count(), 1);
  assert.equal(await page.getByRole('textbox', { name: '特に何を確かめますか' }).count(), 1);
  assert.equal(await page.locator('input[name="method"]').count(), 3);
  await page.locator('input[name="source"][value="image"]').check();
  assert.equal(await page.getByRole('textbox', { name: '特に何を確かめますか' }).count(), 0);
  assert.equal(await page.locator('input[name="method"]').count(), 0);
  await page.locator('input[name="source"][value="playwright_result"]').check();
  assert.equal(await page.getByRole('textbox', { name: '特に何を確かめますか' }).count(), 0);
  assert.equal(await page.locator('input[name="method"]').count(), 0);
  await page.locator('input[name="source"][value="website"]').check();
  assert.equal(await page.locator('input[name="source"]:checked').getAttribute('value'), 'website');

  await page.getByText('改善点を詳しく洗い出したい', { exact: true }).click();
  assert.equal(await page.locator('input[name="method"]:checked').getAttribute('value'), 'deep');
  await page.getByRole('button', { name: '確認を始める' }).click();

  const dialog = page.getByTestId('mock-send-confirmation');
  await dialog.waitFor({ state: 'visible' });
  assert.equal(await dialog.getByText('送る内容', { exact: true }).count(), 1);
  assert.equal(await dialog.getByText('送信先', { exact: true }).count(), 1);
  assert.equal(await dialog.getByText('保存', { exact: true }).count(), 1);

  const mainBox = await page.locator('#main-content').boundingBox();
  const dialogBox = await dialog.boundingBox();
  assert(mainBox && dialogBox);
  const mainCenter = mainBox.x + mainBox.width / 2;
  const dialogCenter = dialogBox.x + dialogBox.width / 2;
  assert(Math.abs(mainCenter - dialogCenter) <= 2, 'The confirmation dialog must be centered in the work area.');

  await page.getByRole('button', { name: '同意して始める' }).click();
  await page.getByTestId('mock-progress').waitFor();

  await page.getByRole('button', { name: '設定', exact: true }).first().click();
  await page.getByTestId('mock-settings').waitFor();
  await page.getByText('AIの提案を使う', { exact: true }).waitFor();
  await page.getByText('外部へ送る前に確認する', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '設定を保存' }).count(), 1);
  await page.getByRole('button', { name: '設定を保存' }).click();
  const savedNotice = page.getByRole('status').filter({ hasText: '設定を保存しました' });
  await savedNotice.waitFor();
  const savedNoticeStyle = await savedNotice.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      borderLeftWidth: style.borderLeftWidth,
      borderRightWidth: style.borderRightWidth,
      backgroundColor: style.backgroundColor,
      successSoft: getComputedStyle(document.documentElement).getPropertyValue('--green-soft').trim(),
    };
  });
  assert.equal(savedNoticeStyle.borderLeftWidth, '1px');
  assert.equal(savedNoticeStyle.borderRightWidth, '1px');
  assert.equal(savedNoticeStyle.backgroundColor, 'rgb(234, 247, 238)');
  assert.equal(savedNoticeStyle.successSoft, '#eaf7ee');

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await mobile.goto(`${entry}?screen=settings`);
  await mobile.getByTestId('mock-settings').waitFor();
  const hasHorizontalOverflow = await mobile.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  assert.equal(hasHorizontalOverflow, false);
  assert.equal(await mobile.locator('.mobile-nav').isVisible(), true);
  await mobile.close();

  const recovery = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await recovery.goto(`${entry}?screen=recovery`);
  await recovery.getByTestId('mock-recovery').waitFor();
  assert.equal(await recovery.getByRole('heading', { name: '確認の準備が中断しました' }).count(), 1);
  assert.equal(await recovery.getByRole('button', { name: '準備を再開' }).count(), 1);
  await recovery.close();

  console.log('Control Center mock interaction and responsive checks passed.');
} finally {
  await browser.close();
}
