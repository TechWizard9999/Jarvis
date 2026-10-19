import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Store } from '../src/store.ts';
import { tempConfig } from './helpers.ts';
test('concurrent events have durable monotonically increasing sequence IDs and replay after reconnect', async t => {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new Store(config.stateDir), run = await store.create({ repo: '/fixture', issue: 'https://github.com/rtk-ai/rtk/issues/1' });
  await Promise.all(Array.from({ length: 30 }, (_, i) => store.event(run, 'test', 'progress', `message ${i}`)));
  assert.deepEqual((await store.events(run.id)).map(e => e.seq), Array.from({ length: 30 }, (_, i) => i + 1));
  const restarted = new Store(config.stateDir); await restarted.event(run, 'test', 'resumed', 'after restart');
  assert.deepEqual((await restarted.events(run.id, 29)).map(e => e.seq), [30, 31]);
  assert.equal((await restarted.list()).length, 1);
});
