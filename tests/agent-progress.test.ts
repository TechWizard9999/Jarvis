import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { Pipeline, RunFailure } from '../src/pipeline.ts';
import { ProgressTracker } from '../src/progress.ts';
import { fingerprint, hash, inventory } from '../src/files.ts';
import { original, tempConfig } from './helpers.ts';

async function fixture(t: test.TestContext) {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); await fs.mkdir(path.join(source, 'src'), { recursive: true });
  await fs.writeFile(path.join(source, 'src/lib.rs'), original);
  const pipeline = new Pipeline(config), run = await pipeline.store.create({ repo: source, issue: 'https://github.com/rtk-ai/rtk/issues/1', mode: 'evaluation', retrieval: 'text' });
  const agent = { toolToken: '', providerToken: '', start: async () => {}, stop: async () => {}, interrupt: async () => {}, restart: async () => {}, ask: async (..._args: any[]): Promise<any> => ({ done: true }) };
  const context = { run, source, base: source, phase: 'reproduction' as 'reproduction' | 'patching', abort: new AbortController(), queue: Promise.resolve(), agent };
  t.after(() => context.abort.abort(new Error('Fixture cleanup')));
  pipeline.contexts.set(run.id, context);
  let checkCount = 0;
  const response = { status: 'passed', exitCode: 0, output: '', matched: undefined as number | undefined };
  (pipeline as any).check = async (_context: unknown, _container: string, id: string, argv: string[]) => ({
    id, argv, durationMs: ++checkCount * 123, log: `different-${checkCount}.log`, timedOut: false,
    sourceHash: 'untrusted-stale-check-hash', ...response,
  });
  return { root, source, pipeline, run, agent, context, response, checkCount: () => checkCount };
}

// Agent retries use real production backoff; advance only those timers while filesystem I/O stays real.
async function advancing<T>(t: test.TestContext, action: () => Promise<T>): Promise<T> {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false; const pending = action().finally(() => { settled = true; });
  // Attach the rejection handler before advancing, so expected failures are never unhandled.
  const result = pending.then(value => ({ value }), error => ({ error }));
  const deadline = performance.now() + 5000;
  while (!settled && performance.now() < deadline) { t.mock.timers.tick(60000); await setImmediate(); }
  assert.ok(settled, 'fixture retry loop did not settle');
  const outcome = await result; if ('error' in outcome) throw outcome.error; return outcome.value;
}

for (const kind of ['tool-error', 'check-result-loop'] as const) test(`three unchanged ${kind} recovery checkpoints stop with needs_attention`, async t => {
  const f = await fixture(t); let turns = 0, restarts = 0;
  f.agent.restart = async () => { restarts++; };
  f.agent.ask = async prompt => {
    turns++; if (turns === 4) return { fixtureGuard: 'old recovery loop never stopped' };
    if (turns > 1) assert.match(prompt, /Recovery checkpoint/);
    // One identical success between error recoveries must not erase the persistent history.
    if (kind === 'tool-error') await f.pipeline.tool(f.run.id, 'run_check', { check: 'fmt' });
    for (let call = 0; call < 3; call++) {
      if (kind === 'tool-error') await assert.rejects(f.pipeline.tool(f.run.id, 'search_text', { path: '/agent', pattern: `query-${turns}-${call}`, reason: 'Locate the requested source' }), /relative path/);
      else await f.pipeline.tool(f.run.id, 'run_check', { check: 'fmt' });
    }
    throw new Error('fixture interrupted after diagnosis');
  };
  await assert.rejects(advancing(t, () => (f.pipeline as any).askAgent(f.context, 'Repair the issue', () => true)), error => error instanceof RunFailure && error.outcome === 'needs_attention' && /3.*unchanged.*recovery/i.test(error.message));
  assert.equal(turns, 3); assert.equal(restarts, 2);
  const checkpoints = (await f.pipeline.store.events(f.run.id)).filter(event => event.kind === 'recovery_checkpoint');
  assert.equal(checkpoints.length, 3);
  const revision = fingerprint(await inventory(f.source));
  assert.ok(checkpoints.every(event => (event.data as any).sourceHash === revision && (event.data as any).phase === 'reproduction' && (event.data as any).kind === kind));
  assert.equal((checkpoints.at(-1)!.data as any).stalled, true);
});

for (const change of ['source', 'phase'] as const) test(`${change} progress permits fresh recovery checkpoints`, async t => {
  const f = await fixture(t); let turns = 0;
  f.agent.ask = async () => {
    turns++; if (turns === 7) return { done: true };
    if (turns === 3 || turns === 5) {
      if (change === 'source') await fs.appendFile(path.join(f.source, 'src/lib.rs'), `\n// revision ${turns}\n`);
      if (change === 'phase') f.context.phase = turns === 3 ? 'patching' : 'reproduction';
    }
    for (let call = 0; call < 3; call++) await assert.rejects(f.pipeline.tool(f.run.id, 'search_text', { path: '/agent', pattern: 'same query', reason: 'Locate the requested source' }), /relative path/);
    throw new Error('fixture interrupted after diagnosis');
  };
  assert.deepEqual(await advancing(t, () => (f.pipeline as any).askAgent(f.context, 'Repair the issue', () => true)), { done: true });
  assert.equal(turns, 7);
  const checkpoints = (await f.pipeline.store.events(f.run.id)).filter(event => event.kind === 'recovery_checkpoint');
  assert.equal(checkpoints.length, 6); assert.ok(checkpoints.every(event => !(event.data as any).stalled));
});

test('the retained medium checkpoint sequence stops at the third recurring path error', async () => {
  const retained = JSON.parse(await fs.readFile(new URL('./fixtures/recovery-20261020105823.json', import.meta.url), 'utf8'));
  assert.deepEqual(retained.checkpoints.map((checkpoint: any) => checkpoint.seq), [2246, 2407, 3597, 3828, 4114]);
  const tracker = new ProgressTracker();
  const observed = retained.checkpoints.map((checkpoint: any) => tracker.record(checkpoint.sourceHash, {
    kind: 'agent-recovery', phase: checkpoint.phase, signature: JSON.stringify([checkpoint.kind, checkpoint.signature]),
  }));
  assert.deepEqual(observed, [false, false, false, false, true]);
});

test('alternating A/B/A/B/A diagnoses retain separate counts despite changing catalog results', async t => {
  const f = await fixture(t); let turns = 0;
  f.agent.ask = async () => {
    turns++; if (turns === 6) return { fixtureGuard: 'alternating recovery never stopped' };
    // Different selectors, output and volatile metadata are fresh check identities, not repairs of A or B.
    f.response.output = `tests::catalog_${turns}: test\n`;
    await f.pipeline.tool(f.run.id, 'run_check', { check: 'list-tests', test: `catalog_${turns}` });
    f.response.output = '';
    for (let call = 0; call < 3; call++) {
      if (turns % 2) await f.pipeline.tool(f.run.id, 'run_check', { check: 'fmt' });
      else await assert.rejects(f.pipeline.tool(f.run.id, 'search_text', { path: '/agent', pattern: `query-${turns}-${call}`, reason: 'Locate the requested source' }), /relative path/);
    }
    throw new Error('fixture interrupted after diagnosis');
  };
  await assert.rejects(advancing(t, () => (f.pipeline as any).askAgent(f.context, 'Repair the issue', () => true)), error => error instanceof RunFailure && error.outcome === 'needs_attention');
  assert.equal(turns, 5);
  const checkpoints = (await f.pipeline.store.events(f.run.id)).filter(event => event.kind === 'recovery_checkpoint');
  assert.deepEqual(checkpoints.map(event => (event.data as any).kind), ['check-result-loop', 'tool-error', 'check-result-loop', 'tool-error', 'check-result-loop']);
  assert.deepEqual(checkpoints.map(event => (event.data as any).stalled), [false, false, false, false, true]);
});

test('new check results do not erase an unresolved recurring tool-error diagnosis', async t => {
  const f = await fixture(t); let turns = 0;
  f.agent.ask = async () => {
    turns++; if (turns === 4) return { fixtureGuard: 'unrelated checks erased the error history' };
    f.response.output = `new diagnostic ${turns}`;
    await f.pipeline.tool(f.run.id, 'run_check', { check: 'clippy-default' });
    for (let call = 0; call < 3; call++) await assert.rejects(f.pipeline.tool(f.run.id, 'search_text', { path: '/agent', pattern: `query-${turns}`, reason: 'Locate the requested source' }), /relative path/);
    throw new Error('fixture interrupted after diagnosis');
  };
  await assert.rejects(advancing(t, () => (f.pipeline as any).askAgent(f.context, 'Repair the issue', () => true)), error => error instanceof RunFailure && error.outcome === 'needs_attention');
  assert.equal(turns, 3);
});

test('a valid phase completion clears earlier diagnosis recurrence history', async t => {
  const f = await fixture(t); let turns = 0;
  f.agent.ask = async () => {
    turns++;
    if (turns === 3 || turns === 6) return { done: true };
    for (let call = 0; call < 3; call++) await assert.rejects(f.pipeline.tool(f.run.id, 'search_text', { path: '/agent', pattern: 'same query', reason: 'Locate the requested source' }), /relative path/);
    throw new Error('fixture interrupted after diagnosis');
  };
  await advancing(t, async () => {
    assert.deepEqual(await (f.pipeline as any).askAgent(f.context, 'Finish phase one', () => true), { done: true });
    assert.deepEqual(await (f.pipeline as any).askAgent(f.context, 'Finish phase two', () => true), { done: true });
  });
  assert.equal(turns, 6);
  const checkpoints = (await f.pipeline.store.events(f.run.id)).filter(event => event.kind === 'recovery_checkpoint');
  assert.equal(checkpoints.length, 4); assert.ok(checkpoints.every(event => !(event.data as any).stalled));
});

test('unchanged successful checks diagnose with exact arguments, result and actual source identity', async t => {
  const f = await fixture(t); const args = { check: 'fmt' };
  for (let call = 0; call < 3; call++) await f.pipeline.tool(f.run.id, 'run_check', args);
  const events = await f.pipeline.store.events(f.run.id), diagnoses = events.filter(event => event.kind === 'diagnosis');
  assert.equal(diagnoses.length, 1); const diagnosis = diagnoses[0].data as any;
  assert.equal(diagnosis.kind, 'check-result-loop'); assert.equal(diagnosis.tool, 'run_check'); assert.deepEqual(diagnosis.args, args);
  assert.equal(diagnosis.sourceHash, fingerprint(await inventory(f.source))); assert.equal(diagnosis.phase, 'reproduction');
  assert.deepEqual(diagnosis.check, { name: 'fmt', argv: f.pipeline.config.profile.checks.fmt, status: 'passed', exitCode: 0, timedOut: false, outputHash: hash('') });
  assert.equal(events.filter(event => event.source === 'tool' && event.kind === 'result').length, 3);
});

test('a valid phase answer after a third identical check proceeds to controller validation', async t => {
  const f = await fixture(t); let turns = 0, restarts = 0;
  f.agent.restart = async () => { restarts++; };
  f.agent.ask = async () => {
    turns++;
    for (let repeat = 0; repeat < 3; repeat++) await f.pipeline.tool(f.run.id, 'run_check', { check: 'fmt' });
    return { status: 'phase-complete', turn: turns };
  };
  assert.deepEqual(await advancing(t, () => (f.pipeline as any).askAgent(f.context, 'Finish this phase', () => true)), { status: 'phase-complete', turn: 1 });
  assert.equal(turns, 1); assert.equal(restarts, 0);
  assert.equal((f.context as any).recoveryReason, undefined);
  assert.equal((await f.pipeline.store.events(f.run.id)).filter(event => event.kind === 'recovery_checkpoint').length, 0);
});

test('new check selectors, statuses, output, source and phase do not count as unchanged results', async t => {
  const f = await fixture(t);
  for (let version = 0; version < 7; version++) {
    if (version === 1) f.response.status = 'failed';
    if (version === 2) f.response.output = 'new failure detail';
    if (version === 3) await fs.appendFile(path.join(f.source, 'src/lib.rs'), '\n// changed source\n');
    if (version === 4) f.context.phase = 'patching';
    const args = version < 5 ? { check: 'fmt' } : { check: 'list-tests', test: `selector-${version}` };
    for (let repeat = 0; repeat < 2; repeat++) {
      await f.pipeline.tool(f.run.id, 'run_check', args);
      for (let read = 0; read < 4; read++) await f.pipeline.tool(f.run.id, 'read_source', { path: 'src/lib.rs' });
    }
  }
  assert.equal((await f.pipeline.store.events(f.run.id)).filter(event => event.kind === 'diagnosis').length, 0);
});

test('format-source diagnoses against the copied-back source rather than its pre-format check hash', async t => {
  const f = await fixture(t);
  (f.pipeline as any).formatSource = async (_context: unknown, argv: string[]) => {
    await fs.writeFile(path.join(f.source, 'src/lib.rs'), original + '\n// formatted\n');
    return { id: `format-${f.run.tools}`, argv, status: 'passed', exitCode: 0, timedOut: false, durationMs: f.run.tools, log: 'format.log', sourceHash: 'pre-format-source-hash', output: '' };
  };
  for (let call = 0; call < 3; call++) await f.pipeline.tool(f.run.id, 'run_check', { check: 'format-source' });
  const diagnosis = (await f.pipeline.store.events(f.run.id)).find(event => event.kind === 'diagnosis');
  assert.ok(diagnosis); assert.equal((diagnosis.data as any).sourceHash, fingerprint(await inventory(f.source)));
});

test('changed output before the truncated tool-response tail remains fresh check evidence', async t => {
  const f = await fixture(t), commonTail = 'same diagnostic tail\n'.repeat(1400);
  for (const prefix of ['first failure\n', 'different early failure\n']) {
    f.response.output = prefix + commonTail;
    for (let repeat = 0; repeat < 2; repeat++) {
      const reply = await f.pipeline.tool(f.run.id, 'run_check', { check: 'fmt' });
      assert.equal((reply.result as any).output, f.response.output.slice(-24000));
    }
  }
  assert.equal((await f.pipeline.store.events(f.run.id)).filter(event => event.kind === 'diagnosis').length, 0);
});

test('list-tests ignores Cargo duration changes for progress while preserving the full raw output hash', async t => {
  const f = await fixture(t), catalog = 'tests::first: test\ntests::second: test\n';
  for (let call = 1; call <= 3; call++) {
    f.response.output = `Finished test profile in 0.0${call}s\n${catalog}2 tests, 0 benchmarks\n`;
    await f.pipeline.tool(f.run.id, 'run_check', call === 2 ? { check: 'list-tests', test: '' } : { check: 'list-tests' });
  }
  const diagnoses = (await f.pipeline.store.events(f.run.id)).filter(event => event.kind === 'diagnosis');
  assert.equal(diagnoses.length, 1);
  const diagnosis = diagnoses[0].data as any;
  assert.equal(diagnosis.check.outputHash, hash(f.response.output));
  assert.equal(diagnosis.check.progressOutputHash, hash(JSON.stringify(['tests::first', 'tests::second'])));
  assert.notEqual(diagnosis.check.outputHash, diagnosis.check.progressOutputHash);
});

test('catalog changes beyond the 200-name response limit remain fresh list-tests progress', async t => {
  const f = await fixture(t), prefix = Array.from({ length: 200 }, (_, index) => `tests::name_${index}: test\n`).join('');
  let displayed: string[] | undefined;
  for (const tail of ['old_tail', 'new_tail']) for (let repeat = 0; repeat < 2; repeat++) {
    f.response.output = prefix + `tests::${tail}: test\n`;
    const reply = await f.pipeline.tool(f.run.id, 'run_check', { check: 'list-tests' });
    assert.equal((reply.result as any).truncated, true);
    if (displayed) assert.deepEqual((reply.result as any).listedTests, displayed);
    displayed = (reply.result as any).listedTests;
  }
  assert.equal((await f.pipeline.store.events(f.run.id)).filter(event => event.kind === 'diagnosis').length, 0);
});

test('failed list-tests with changed errors retains the full diagnostic output identity', async t => {
  const f = await fixture(t); f.response.exitCode = 101; f.response.status = 'failed';
  for (const failure of ['first compile error', 'different compile error']) for (let repeat = 0; repeat < 2; repeat++) {
    f.response.output = failure;
    await f.pipeline.tool(f.run.id, 'run_check', { check: 'list-tests' });
  }
  assert.equal((await f.pipeline.store.events(f.run.id)).filter(event => event.kind === 'diagnosis').length, 0);
});
