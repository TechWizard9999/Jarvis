/** Optional developer test: requires Playwright and an installed Chrome channel. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.BUGFIX_PLAYWRIGHT_MODULE || 'playwright');
const project = process.cwd(), settings = {};
for (const line of (await fs.readFile(path.join(project, '.env'), 'utf8')).split('\n')) {
  if (line && !line.startsWith('#') && line.includes('=')) { const i = line.indexOf('='); settings[line.slice(0, i)] = line.slice(i + 1); }
}
const state = process.env.BUGFIX_STATE_DIR || settings.BUGFIX_STATE_DIR || path.join(project, 'state');
const port = process.env.BUGFIX_PORT || settings.BUGFIX_PORT || '3210';
const token = (await fs.readFile(path.join(state, 'ui-token'), 'utf8')).trim();
const browser = await chromium.launch({ channel: process.env.BUGFIX_BROWSER_CHANNEL || 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }), errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(`http://localhost:${port}/?token=${encodeURIComponent(token)}`);
  await page.getByRole('button', { name: 'Play labelled demo' }).click();
  await page.getByText('SIMULATED DEMO — no real model, repair, verification or PR.').waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('.metric strong')].some(e => e.textContent === 'demo complete'));
  assert.equal(await page.getByRole('button', { name: 'Cancel', exact: true }).count(), 0);
  assert.ok((await page.locator('.logrow').count()) >= 6, 'Live activity did not arrive');
  assert.equal(await page.locator('.step.done').count(), 6, 'Demo must not claim publication');
  await page.getByRole('button', { name: 'Diff', exact: true }).click();
  await page.getByText('No source diff yet.').waitFor();
  await page.getByRole('button', { name: 'Report', exact: true }).click();
  await page.locator('.tab-content pre').filter({ hasText: 'SIMULATED DEMO' }).waitFor();
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await page.reload(); await page.getByRole('button', { name: /Simulated demo/ }).first().click();
  await page.waitForFunction(() => document.querySelectorAll('.logrow').length >= 6);
  await fs.mkdir(path.join(project, '.cache'), { recursive: true });
  await page.screenshot({ path: path.join(project, '.cache/dashboard-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Mobile layout overflows');
  await page.locator('#detail').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(project, '.cache/dashboard-mobile.png') });
  await page.getByRole('button', { name: 'Check setup' }).click();
  await page.locator('.setup-row').filter({ hasText: 'Repository profile' }).waitFor({ timeout: 30000 });
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(state, 'browser-results.json'), JSON.stringify({ testedAt: new Date().toISOString(), outcome: 'passed', tests: ['authentication redirect', 'labelled simulation', 'SSE live activity and replay', 'accurate stage completion', 'diff and report views', 'desktop/mobile layout', 'setup checks'], javascriptErrors: errors, screenshots: ['.cache/dashboard-desktop.png', '.cache/dashboard-mobile.png'] }, null, 2) + '\n');
  console.log('PASS: authenticated dashboard, live/replayed events, accurate simulation labels, diff/report tabs, setup checks, mobile layout; no JavaScript errors.');
} finally { await browser.close(); }
