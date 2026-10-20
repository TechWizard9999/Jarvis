/** Isolated browser regression for the live Activity viewport. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const { chromium } = await import(process.env.BUGFIX_PLAYWRIGHT_MODULE || 'playwright');
const root = process.cwd();
const now = new Date().toISOString();
const run = {
  id: 'scroll-regression', input: { issue: 'https://github.com/rtk-ai/rtk/issues/3980', mode: 'live' },
  issue: { title: 'Scroll regression' }, createdAt: now, updatedAt: now, stage: 'verification',
  attempt: 1, tools: 1, tokens: 1, checks: [], graphReady: false, graphStale: false,
};
const events = [];
const subscribers = new Set();
function send(message) {
  const event = { seq: events.length + 1, runId: run.id, time: new Date().toISOString(), stage: run.stage, source: 'controller', kind: 'output', message };
  events.push(event);
  for (const response of subscribers) response.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
}
for (let i = 1; i <= 80; i++) send(`event ${i}`);
const json = (response, value) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/api/status') return json(response, { repoRoot: '/tmp', profile: { upstream: 'rtk-ai/rtk' } });
  if (url.pathname === '/api/runs') return json(response, [run]);
  if (url.pathname === `/api/runs/${run.id}`) return json(response, run);
  if (url.pathname === `/api/runs/${run.id}/diff`) return json(response, { diff: '' });
  if (url.pathname === `/api/runs/${run.id}/events`) {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    subscribers.add(response);
    for (const event of events) response.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
    request.on('close', () => subscribers.delete(response));
    return;
  }
  const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
  if (!files[url.pathname]) { response.writeHead(404); return response.end(); }
  const [file, mime] = files[url.pathname];
  response.writeHead(200, { 'content-type': mime }); response.end(await fs.readFile(path.join(root, 'public', file)));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ channel: process.env.BUGFIX_BROWSER_CHANNEL || 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const position = () => page.locator('.log').evaluate(node => ({ top: node.scrollTop, remaining: node.scrollHeight - node.scrollTop - node.clientHeight, rows: node.children.length }));
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.getByRole('button', { name: /Scroll regression/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('.logrow').length === 80);
  assert.ok((await position()).remaining < 40, 'initial replay should follow the latest event');

  send('event 81');
  await page.getByText('event 81', { exact: true }).waitFor();
  assert.ok((await position()).remaining < 40, 'live events should follow while at the end');

  await page.locator('.log').evaluate(node => { node.scrollTop = 120; });
  await page.waitForFunction(() => document.querySelector('.log').scrollTop >= 119);
  const paused = await position();
  await page.locator('#refresh').click();
  assert.ok(Math.abs((await position()).top - paused.top) <= 2, 'refresh should preserve the reading position');

  send('event 82');
  await page.getByText('event 82', { exact: true }).waitFor();
  assert.ok(Math.abs((await position()).top - paused.top) <= 2, 'new events should not move a scrolled-up viewport');

  await page.getByRole('button', { name: 'Diff', exact: true }).click();
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  assert.ok(Math.abs((await position()).top - paused.top) <= 2, 'switching tabs should preserve the reading position');

  for (let i = 83; i <= 1530; i++) send(`event ${i}`);
  await page.waitForFunction(() => document.querySelectorAll('.logrow').length === 1530);
  assert.ok(Math.abs((await position()).top - paused.top) <= 2, 'older rows should remain while reading the stream');

  await page.locator('.log').evaluate(node => { node.scrollTop = node.scrollHeight; });
  await page.waitForFunction(() => document.querySelectorAll('.logrow').length === 1500);
  send('event 1531');
  await page.getByText('event 1531', { exact: true }).waitFor();
  assert.ok((await position()).remaining < 40, 'scrolling to the end should resume following the stream');
  assert.deepEqual(errors, []);
  console.log('PASS: Activity follows at the end, holds a scrolled-up position through refresh/tab changes and live events, then resumes at the end.');
} finally {
  await browser.close();
  for (const response of subscribers) response.end();
  await new Promise(resolve => server.close(resolve));
}
