import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Pipeline } from '../src/pipeline.ts';
import { fixtureRepo, tempConfig } from './helpers.ts';

test('repeating a trusted check ID preserves each raw result without replacing earlier logs', async t => {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pipeline = new Pipeline(config), source = await fixtureRepo(config.repoRoot);
  const run = await pipeline.store.create({ repo: source, issue: 'https://github.com/rtk-ai/rtk/issues/1' }); run.stage = 'reproduction';
  const context = { run, source, base: source, phase: 'reproduction' as const, abort: new AbortController(), queue: Promise.resolve(), agent: { toolToken: '', providerToken: '', start: async () => {}, stop: async () => {}, ask: async () => ({}) } };
  let calls = 0;
  pipeline.docker.inContainer = async () => ({ code: 0, stdout: `raw check attempt ${++calls}\n`, stderr: '', timedOut: false, durationMs: 1 });
  const first = await pipeline.check(context, 'fixture', 'admission-fmt', ['fixture-check']);
  const second = await pipeline.check(context, 'fixture', 'admission-fmt', ['fixture-check']);
  assert.notEqual(first.log, second.log);
  assert.equal(await fs.readFile(path.join(pipeline.store.dir(run.id), first.log), 'utf8'), 'raw check attempt 1\n');
  assert.equal(await fs.readFile(path.join(pipeline.store.dir(run.id), second.log), 'utf8'), 'raw check attempt 2\n');
  assert.equal(new Set(run.checks.map(check => check.log)).size, 2);
});
