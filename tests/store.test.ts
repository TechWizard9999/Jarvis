import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
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
test('manifest saves snapshot immediately and retain the newest durable revision despite delayed writes', async t => {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new Store(config.stateDir), run = await store.create({ repo: '/fixture', issue: 'https://github.com/rtk-ai/rtk/issues/1' });
  const rename = fs.rename; let release!: () => void, started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), firstRename = new Promise<void>(resolve => { started = resolve; });
  let first = true; const snapshots: any[] = [];
  fs.rename = async (from, to) => {
    if (String(to).endsWith('manifest.json')) {
      snapshots.push(JSON.parse(await fs.readFile(from, 'utf8')));
      if (first) { first = false; started(); await held; }
    }
    return rename(from, to);
  };
  t.after(() => { fs.rename = rename; release(); });
  run.stage = 'reproduction'; const older = store.save(run); await firstRename;
  run.stage = 'complete'; run.outcome = 'verified_patch'; const latest = store.save(run);
  await Promise.race([latest, new Promise(resolve => setTimeout(resolve, 30))]); release(); await Promise.all([older, latest]);
  const durable = await new Store(config.stateDir).get(run.id);
  assert.equal(durable.stage, 'complete'); assert.equal(durable.outcome, 'verified_patch');
  assert.equal((durable as any).revision, 3); assert.deepEqual(snapshots.map(s => s.stage), ['reproduction', 'complete']);
});
test('a save captures nested state before its first asynchronous disk operation', async t => {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new Store(config.stateDir), run = await store.create({ repo: '/fixture', issue: 'https://github.com/rtk-ai/rtk/issues/1' });
  const pending = store.save(run); run.checks.push({ id: 'later', argv: [], exitCode: 0, durationMs: 1, log: '', timedOut: false }); await pending;
  assert.deepEqual((await store.get(run.id)).checks, []);
});
test('event cursor pages and replay only parse the requested tail after indexing', async t => {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new Store(config.stateDir), run = await store.create({ repo: '/fixture', issue: 'https://github.com/rtk-ai/rtk/issues/1' });
  for (let i = 1; i <= 45; i++) await store.event(run, i % 2 ? 'agent' : 'verifier', i === 30 ? 'failed' : 'progress', `message ${i}`);
  assert.equal(typeof (store as any).eventPage, 'function', 'cursor paging must be available');
  const page = await (store as any).eventPage(run.id, { limit: 5 });
  assert.deepEqual(page.events.map((e: any) => e.seq), [41, 42, 43, 44, 45]); assert.equal(page.before, 41); assert.equal(page.hasOlder, true); assert.equal(page.latestSeq, 45);
  assert.deepEqual((await (store as any).eventPage(run.id, { before: page.before, limit: 3 })).events.map((e: any) => e.seq), [38, 39, 40]);
  assert.deepEqual((await (store as any).eventPage(run.id, { errors: true })).events.map((e: any) => e.seq), [30]);
  const parse = JSON.parse; let count = 0; JSON.parse = (...args: Parameters<typeof JSON.parse>) => { count++; return parse(...args); };
  t.after(() => { JSON.parse = parse; });
  assert.deepEqual((await store.events(run.id, 42)).map(e => e.seq), [43, 44, 45]); assert.ok(count <= 5, `tail replay parsed ${count} entries`);
});
test('restarting after a truncated event append preserves later durable events', async t => {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new Store(config.stateDir), run = await store.create({ repo: '/fixture', issue: 'https://github.com/rtk-ai/rtk/issues/1' });
  await store.event(run, 'test', 'progress', 'before interruption');
  await fs.appendFile(path.join(store.dir(run.id), 'events.jsonl'), '{"seq":2,"message":"partial');
  await new Store(config.stateDir).event(run, 'test', 'progress', 'after restart');
  const events = await new Store(config.stateDir).events(run.id);
  assert.deepEqual(events.map(event => event.seq), [1, 2]); assert.equal(events[1].message, 'after restart');
});
test('stage transitions close durable intervals and publication retry preserves execution finish time', async t => {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new Store(config.stateDir), run = await store.create({ repo: '/fixture', issue: 'https://github.com/rtk-ai/rtk/issues/1' });
  await store.stage(run, 'preflight', 'preflight'); await store.stage(run, 'verification', 'verification');
  const durable=await store.get(run.id);
  assert.deepEqual(durable.stageTimes?.map(interval=>interval.stage),['queued','preflight','verification']);
  assert.equal(durable.stageTimes?.[0].finishedAt,durable.stageTimes?.[1].startedAt); assert.equal(durable.stageTimes?.[1].finishedAt,durable.stageTimes?.[2].startedAt); assert.equal(durable.stageTimes?.[2].finishedAt,undefined);
  run.executionFinishedAt='2026-10-20T01:02:03.000Z'; await store.stage(run,'publishing','retry publication');
  assert.equal((await store.get(run.id)).executionFinishedAt,'2026-10-20T01:02:03.000Z');
});
