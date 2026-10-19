import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tempConfig } from './helpers.ts';
import { Pipeline } from '../src/pipeline.ts';
import { Store } from '../src/store.ts';

test('restart recovery distinguishes an unverified tree from a completed verified commit', async t => {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new Store(config.stateDir), engine = new Pipeline(config, store), cleaned: string[] = [];
  engine.docker.stopOrphans = async run => { cleaned.push(run.id); };
  const pending = await store.create({ repo: '/repo', issue: 'https://github.com/rtk-ai/rtk/issues/1' });
  pending.stage = 'verification'; pending.verifiedTree = 'a'.repeat(40); await store.save(pending);
  const committed = await store.create({ repo: '/repo', issue: 'https://github.com/rtk-ai/rtk/issues/2' });
  committed.stage = 'publishing'; committed.verifiedCommit = 'b'.repeat(40); committed.outcome = 'verified_patch'; await store.save(committed);
  await engine.recover();
  assert.equal((await store.get(pending.id)).outcome, 'interrupted');
  assert.equal((await store.get(committed.id)).outcome, 'verified_unpublished');
  assert.equal(cleaned.length, 2); assert.equal((await store.get(committed.id)).stage, 'complete');
});

test('an unconfigured provider stops before issue fetching, worktree creation or Docker builds', async t => {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new Store(config.stateDir), engine = new Pipeline(config, store);
  engine.issueLoader = async () => { throw new Error('ISSUE_FETCH_MUST_NOT_RUN'); };
  const run = await store.create({ repo: '/not-needed', issue: 'https://github.com/rtk-ai/rtk/issues/1', mode: 'evaluation' });
  await engine.execute(run);
  assert.equal(run.outcome, 'environment_blocked'); assert.match(run.error || '', /provider credential/);
  assert.equal(run.baseSha, undefined); assert.equal(run.workerContainer, undefined);
});
