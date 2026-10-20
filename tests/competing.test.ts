import test from 'node:test';
import assert from 'node:assert/strict';
import { competingPullRequests } from '../src/competing.ts';
test('preflight follows paged issue cross references and discloses only open PRs', async () => {
  const calls: string[] = [];
  const links = await competingPullRequests('rtk-ai/rtk', 1, async url => {
    calls.push(url);
    if (calls.length === 1) return { values: [{ event: 'cross-referenced', source: { issue: { state: 'open', html_url: 'https://github.com/rtk-ai/rtk/pull/2', pull_request: {} } } }], next: 'page2' };
    return { values: [{event:'cross-referenced',source:{issue:{state:'closed',html_url:'closed',pull_request:{}}}}, {event:'commented'}] };
  });
  assert.deepEqual(links, ['https://github.com/rtk-ai/rtk/pull/2']); assert.equal(calls.length,2);
});
