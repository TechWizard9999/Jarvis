import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { inspectPublication } from '../src/publication.ts';
import { Store } from '../src/store.ts';
import { tempConfig } from './helpers.ts';

const saved = JSON.parse(await fs.readFile(new URL('./fixtures/publication-pr-4682-skipped.json', import.meta.url), 'utf8'));
// GitHub GraphQL uses uppercase enum values; the inspector consumes the equivalent REST fields.
const skipped = saved.statusCheckRollup.map((check: any) => ({
  name: check.name, status: check.status.toLowerCase(), conclusion: check.conclusion.toLowerCase(),
}));
const completed = (conclusion: string | null) => ({ name: 'Rust tests', status: 'completed', conclusion });
const pending = { name: 'Rust tests', status: 'in_progress', conclusion: null };

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const { root, config } = await tempConfig();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const run = await new Store(config.stateDir).create({ repo: '/fixture', issue: 'https://github.com/rtk-ai/rtk/issues/3530' });
  const original = 'a'.repeat(40);
  run.verifiedCommit = original;
  run.publication = { state: 'created', fork: 'fixture/fork', head: 'fix', base: 'develop', url: 'https://github.com/rtk-ai/rtk/pull/4682', originalVerifiedCommit: original };
  const inspect = (checks: unknown[], statuses: unknown[] = [], unavailable?: 'checks' | 'statuses') => {
    const fetcher = (async (input: any, options: any) => {
      assert.equal(options.method, 'GET', 'publication inspection is read-only');
      const url = String(input);
      if ((url.includes('/check-runs') && unavailable === 'checks') || (url.includes('/status') && unavailable === 'statuses')) return new Response('{}', { status: 403 });
      const value = url.includes('/reviews') ? [] : url.includes('/check-runs') ? { check_runs: checks }
        : url.includes('/status') ? { statuses } : { head: { sha: saved.headRefOid } };
      return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    return inspectPublication(run, config, fetcher);
  };
  return { run, original, inspect };
}

test('actual PR #4682 skipped-only check is unknown and cannot promote original local verification', async t => {
  const { run, original, inspect } = await fixture(t), before = structuredClone(run);
  const result = await inspect(skipped);
  assert.equal(result.ciState, 'unknown', 'a skipped check is not a passed CI job');
  assert.equal(result.originalVerifiedCommit, original);
  assert.equal(result.currentHead, saved.headRefOid);
  assert.equal(result.changedSinceVerification, true);
  assert.deepEqual(run, before, 'a current-head observation must not rewrite the original run');
});

test('no jobs, skipped jobs and neutral jobs provide no successful CI evidence', async t => {
  const { inspect } = await fixture(t);
  for (const [name, checks] of [
    ['no jobs', []], ['skipped only', skipped], ['neutral only', [completed('neutral')]],
    ['skipped and neutral', [...skipped, completed('neutral')]],
  ] as const) assert.equal((await inspect([...checks])).ciState, 'unknown', name);
});

test('a real successful job or commit status can coexist with skipped and neutral jobs', async t => {
  const { inspect } = await fixture(t);
  assert.equal((await inspect([completed('success'), ...skipped, completed('neutral')])).ciState, 'success');
  assert.equal((await inspect(skipped, [{ context: 'build', state: 'success' }])).ciState, 'success');
});

test('pending and failed checks outrank skipped or neutral jobs and successful jobs', async t => {
  const { inspect } = await fixture(t);
  assert.equal((await inspect([...skipped, completed('neutral'), pending])).ciState, 'pending');
  assert.equal((await inspect([completed('success'), pending])).ciState, 'pending');
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'action_required']) {
    assert.equal((await inspect([completed('success'), ...skipped, pending, completed(conclusion)])).ciState, 'failure', conclusion);
  }
  assert.equal((await inspect([completed('success'), completed(null)])).ciState, 'unknown', 'an unresolved completed conclusion is incomplete evidence');
});

test('unavailable API coverage remains unknown unless a known failure is present', async t => {
  const { inspect } = await fixture(t);
  for (const [checks, statuses, unavailable] of [
    [[], [{ context: 'build', state: 'success' }], 'checks'],
    [[completed('success')], [], 'statuses'], [[pending, ...skipped], [], 'statuses'],
  ] as const) {
    const result = await inspect([...checks], [...statuses], unavailable);
    assert.equal(result.ciState, 'unknown');
    assert.ok(result.inspectionErrors?.length);
  }
  assert.equal((await inspect([completed('failure')], [], 'statuses')).ciState, 'failure');
});

test('skipped or neutral CLA checks remain unknown even when other CI succeeds', async t => {
  const { inspect } = await fixture(t);
  for (const conclusion of ['skipped', 'neutral']) {
    const result = await inspect([completed('success'), { name: 'CLA Assistant', status: 'completed', conclusion }]);
    assert.equal(result.ciState, 'success');
    assert.equal(result.claState, 'unknown');
  }
});
