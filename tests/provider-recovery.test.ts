import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { Pipeline, RunFailure } from '../src/pipeline.ts';
import { original, tempConfig } from './helpers.ts';

async function fixture(t: test.TestContext) {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); await fs.mkdir(path.join(source, 'src'), { recursive: true });
  await fs.writeFile(path.join(source, 'src/lib.rs'), original);
  const pipeline = new Pipeline(config), run = await pipeline.store.create({ repo: source, issue: 'https://github.com/rtk-ai/rtk/issues/1', mode: 'evaluation', retrieval: 'text' });
  let turns = 0, restarts = 0;
  const agent = { toolToken: '', providerToken: '', start: async () => {}, stop: async () => {}, interrupt: async () => {}, restart: async () => { restarts++; }, ask: async (..._args: any[]): Promise<any> => { turns++; if (turns > 4) return { fixtureGuard: 'provider recovery did not stop' }; throw new Error('OpenCode/model error: {"name":"UnknownError","data":{"message":"{\\"message\\":\\"Internal server error\\",\\"type\\":\\"internal_server_error\\",\\"code\\":500}"}}'); } };
  const context: any = { run, source, base: source, phase: 'reproduction', abort: new AbortController(), queue: Promise.resolve(), agent };
  t.after(() => context.abort.abort(new Error('Fixture cleanup'))); pipeline.contexts.set(run.id, context);
  return { pipeline, run, source, context, agent, turns: () => turns, restarts: () => restarts };
}

async function advancing<T>(t: test.TestContext, action: () => Promise<T>): Promise<T> {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false; const pending = action().finally(() => { settled = true; });
  const result = pending.then(value => ({ value }), error => ({ error }));
  const deadline = performance.now() + 5000;
  while (!settled && performance.now() < deadline) { t.mock.timers.tick(60000); await setImmediate(); }
  assert.ok(settled, 'provider recovery did not settle');
  const outcome = await result; if ('error' in outcome) throw outcome.error; return outcome.value;
}

test('three provider failures without usable output stop before another whole-turn retry or restart', async t => {
  const f = await fixture(t);
  await assert.rejects(advancing(t, () => (f.pipeline as any).askAgent(f.context, 'Repair the issue', () => true)), error => error instanceof RunFailure && error.outcome === 'environment_blocked');
  assert.equal(f.turns(), 3); assert.equal(f.restarts(), 0);
  const events = await f.pipeline.store.events(f.run.id), checkpoints = events.filter(event => event.kind === 'provider_checkpoint');
  assert.equal(checkpoints.length, 3); assert.equal((checkpoints.at(-1)!.data as any).stalled, true);
  assert.equal(events.filter(event => event.kind === 'agent_retry').length, 2);
  assert.equal(await fs.readFile(path.join(f.source, 'src/lib.rs'), 'utf8'), original);
});

for (const failure of [
  { kind: 'provider_error', retryable: true, consecutiveFailures: 3, circuitOpen: true, meaningfulOutput: false, usableOutput: false },
  { kind: 'authentication', retryable: false, consecutiveFailures: 1, circuitOpen: false, meaningfulOutput: false, usableOutput: false },
  { kind: 'invalid_request', retryable: false, consecutiveFailures: 1, circuitOpen: false, meaningfulOutput: false, usableOutput: false },
]) test(`${failure.kind} gateway stop is terminal without restarting the model session`, async t => {
  const f = await fixture(t);
  f.context.providerFailure = { requestId: 'failed-request', at: '2026-10-21T05:10:00Z', message: 'Provider generation failed', ...failure };
  await assert.rejects(advancing(t, () => (f.pipeline as any).askAgent(f.context, 'Repair the issue', () => true)), error => error instanceof RunFailure && error.outcome === 'environment_blocked');
  assert.equal(f.turns(), 1); assert.equal(f.restarts(), 0);
  const events = await f.pipeline.store.events(f.run.id);
  assert.equal(events.filter(event => event.kind === 'agent_retry').length, 0);
  assert.equal((events.find(event => event.kind === 'provider_checkpoint')!.data as any).requestId, 'failed-request');
});

test('a stream failure after delivered output requires inspection instead of replaying partial work', async t => {
  const f = await fixture(t);
  f.context.providerFailure = { requestId: 'partial-request', at: '2026-10-21T05:10:00Z', kind: 'stream_interrupted', message: 'Stream disconnected', retryable: true, consecutiveFailures: 1, circuitOpen: true, meaningfulOutput: true, usableOutput: true };
  await assert.rejects(advancing(t, () => (f.pipeline as any).askAgent(f.context, 'Repair the issue', () => true)), error => error instanceof RunFailure && error.outcome === 'needs_attention');
  assert.equal(f.turns(), 1); assert.equal(f.restarts(), 0);
});

test('a valid phase answer resets earlier provider failures without imposing a total turn budget', async t => {
  const f = await fixture(t); let turn = 0;
  f.agent.ask = async () => { if (++turn % 3 === 0) return { done: true }; throw new Error('OpenCode/model error: {"name":"UnknownError","data":{"message":"Internal server error"}}'); };
  await advancing(t, async () => {
    assert.deepEqual(await (f.pipeline as any).askAgent(f.context, 'Phase one', () => true), { done: true });
    assert.deepEqual(await (f.pipeline as any).askAgent(f.context, 'Phase two', () => true), { done: true });
  });
  assert.equal(turn, 6);
});

test('unrelated tool rejections do not reset a recurring provider failure', async t => {
  const f = await fixture(t); let turns = 0;
  f.agent.ask = async () => {
    if (++turns > 4) return { fixtureGuard: 'failed tools erased provider history' };
    await assert.rejects(f.pipeline.tool(f.run.id, 'read_source', { path: '../outside' }), /outside source policy/);
    throw new Error('OpenCode/model error: {"name":"UnknownError","data":{"message":"Internal server error"}}');
  };
  await assert.rejects(advancing(t, () => (f.pipeline as any).askAgent(f.context, 'Repair', () => true)), error => error instanceof RunFailure && error.outcome === 'environment_blocked');
  assert.equal(turns, 3);
});

test('changing SDK request IDs do not disguise the same provider generation failure', async t => {
  const f = await fixture(t); let turns = 0;
  f.agent.ask = async () => {
    if (++turns > 4) return { fixtureGuard: 'request IDs erased provider history' };
    throw new Error('OpenCode/model error: ' + JSON.stringify({ name: 'UnknownError', data: { requestID: `request-${turns}`, message: JSON.stringify({ message: 'Internal server error', type: 'internal_server_error', code: 500 }) } }));
  };
  await assert.rejects(advancing(t, () => (f.pipeline as any).askAgent(f.context, 'Repair', () => true)), error => error instanceof RunFailure && error.outcome === 'environment_blocked');
  assert.equal(turns, 3);
});

test('provider checkpoint stores a safe summary instead of an arbitrary SDK error body', async t => {
  const f = await fixture(t); let turns = 0;
  f.agent.ask = async () => {
    if (++turns > 4) return { fixtureGuard: 'provider recovery did not stop' };
    throw new Error('OpenCode/model error: ' + JSON.stringify({ name: 'UnknownError', data: { message: JSON.stringify({ message: 'Internal server error; PRIVATE_PROVIDER_ECHO', type: 'internal_server_error', code: 500 }) } }));
  };
  await assert.rejects(advancing(t, () => (f.pipeline as any).askAgent(f.context, 'Repair', () => true)), error => error instanceof RunFailure && error.outcome === 'environment_blocked');
  const checkpoints = (await f.pipeline.store.events(f.run.id)).filter(event => event.kind === 'provider_checkpoint');
  assert.equal(checkpoints.length, 3); assert.doesNotMatch(JSON.stringify(checkpoints), /PRIVATE_PROVIDER_ECHO/);
});

test('varying echoed request IDs and private input do not evade the provider failure breaker', async t => {
  const f = await fixture(t); let turns = 0;
  f.agent.ask = async () => {
    if (++turns > 4) return { fixtureGuard: 'echoed messages erased provider history' };
    throw new Error('OpenCode/model error: ' + JSON.stringify({ name: 'UnknownError', data: { message: JSON.stringify({ message: `Internal server error; request-${turns}; PRIVATE_PROMPT; nvapi-FAKE_SECRET`, type: 'internal_server_error', code: 500 }) } }));
  };
  await assert.rejects(advancing(t, () => (f.pipeline as any).askAgent(f.context, 'Repair', () => true)), error => error instanceof RunFailure && error.outcome === 'environment_blocked');
  assert.equal(turns, 3);
  const checkpoints = (await f.pipeline.store.events(f.run.id)).filter(event => event.kind === 'provider_checkpoint');
  assert.doesNotMatch(JSON.stringify(checkpoints), /PRIVATE_PROMPT|nvapi-FAKE_SECRET|request-/);
});

for (const progress of ['source', 'tool'] as const) test(`${progress} progress permits further model recovery without a total turn limit`, async t => {
  const f = await fixture(t); let turns = 0;
  f.agent.ask = async () => {
    if (++turns === 7) return { done: true };
    if (turns === 3 || turns === 5) {
      if (progress === 'source') await fs.appendFile(path.join(f.source, 'src/lib.rs'), `\n// source revision ${turns}\n`);
      else await f.pipeline.tool(f.run.id, 'read_source', { path: 'src/lib.rs' });
    }
    throw new Error('OpenCode/model error: {"name":"UnknownError","data":{"message":"Internal server error"}}');
  };
  assert.deepEqual(await advancing(t, () => (f.pipeline as any).askAgent(f.context, 'Repair', () => true)), { done: true });
  assert.equal(turns, 7);
});
