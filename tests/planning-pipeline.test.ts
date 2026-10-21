import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Pipeline, RunFailure } from '../src/pipeline.ts';
import { AgentReplyFormatError } from '../src/agent.ts';
import { inventory } from '../src/files.ts';
import { fixtureRepo, tempConfig } from './helpers.ts';
import type { AcceptanceRequirement } from '../src/types.ts';

const issueBody = 'Per-line, the first three lines of a filtered view:\n\n1: len=111 trailing_spaces=22\n\nExpected: close to 0% padding. Actual: 30–39%.\nNormal output must be preserved.';
const requirements: AcceptanceRequirement[] = [
  { id: 'padding', baseline: 'fail', expectedBehavior: 'Remove trailing padding from filtered lines.', citation: 'Expected: close to 0% padding. Actual: 30–39%.', required: true, target: { kind: 'unit' } },
  { id: 'normal', baseline: 'pass', expectedBehavior: 'Preserve ordinary normal output.', citation: 'Normal output must be preserved.', required: true, target: { kind: 'unit' } },
];
const invalid = structuredClone(requirements);
invalid[0].citation += " Per-line, the first three lines of a filtered view: '1: len=111 trailing_spaces=22'";
type Mode = 'corrected' | 'exhausted' | 'shape' | 'operator' | 'artifact-failure' | 'format' | 'cancelled';

async function exercise(t: test.TestContext, mode: Mode) {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = await fixtureRepo(config.repoRoot), pipeline = new Pipeline(config);
  pipeline.issueLoader = async run => ({ number: 1, url: run.input.issue, title: 'Padding fixture', body: issueBody });
  pipeline.docker.imageId = async () => 'fixture-image'; pipeline.docker.prepare = async run => { run.image = 'fixture-image'; };
  pipeline.docker.startWorker = async () => 'fixture-worker'; pipeline.docker.remove = async () => {}; pipeline.docker.cleanup = async () => {};
  const prompts: string[] = [], submitted: unknown[] = [], phases: unknown[] = [];
  let reproductionTurns = 0, restarts = 0;
  pipeline.agentFactory = run => ({ toolToken: 'fixture-tools', providerToken: 'fixture-provider', start: async () => {}, stop: async () => {}, restart: async () => { restarts++; }, ask: async (prompt, _signal, valid, phase) => {
    if (run.acceptancePlan) { reproductionTurns++; throw new RunFailure('needs_attention', 'Fixture stopped after successful planning'); }
    prompts.push(prompt); phases.push(phase);
    for (const [tool, args] of [
      ['replace_source', { path: 'src/lib.rs', before: 'true', after: 'false' }],
      ['apply_patch', { edits: [{ path: 'src/forbidden.rs', before: '', after: 'changed' }] }],
      ['run_check', { check: 'fmt' }],
    ] as const) await assert.rejects(pipeline.tool(run.id, tool, args), /unavailable|read.only|disabled/i);
    if (mode === 'format') throw new AgentReplyFormatError(['not JSON', 'still not JSON', 'bad third', 'bad fourth']);
    if (mode === 'cancelled') pipeline.contexts.get(run.id)!.abort.abort(new Error('Fixture cancellation'));
    if (mode === 'artifact-failure') {
      const write = fs.writeFile;
      const injected = t.mock.method(fs, 'writeFile', (...args: any[]) => {
        if (String(args[0]).includes('/planning/attempt-1/')) { injected.mock.restore(); return Promise.reject(new Error('Injected planning evidence write failure')); }
        return Reflect.apply(write, fs, args);
      });
    }
    const answer = mode === 'shape' && prompts.length === 1 ? null : { requirements: structuredClone(mode === 'exhausted' || prompts.length === 1 ? invalid : requirements) };
    submitted.push(structuredClone(answer));
    assert.equal(valid!(answer), true, 'Semantic invalidity must reach durable validation, not reply-only JSON retries');
    return answer;
  } });
  const run = await pipeline.store.create({ repo, issue: 'https://github.com/rtk-ai/rtk/issues/1', mode: 'evaluation', retrieval: 'text', publish: false, ...(mode === 'operator' ? { acceptance: invalid } : {}) });
  await pipeline.execute(run);
  assert.equal(run.checks.length, 0); assert.equal(run.candidate, undefined); assert.equal(run.verifiedCommit, undefined);
  assert.deepEqual(await inventory(path.join(pipeline.store.dir(run.id), 'source')), await inventory(path.join(pipeline.store.dir(run.id), 'base')));
  return { run, pipeline, prompts, submitted, phases, reproductionTurns, restarts, dir: path.join(pipeline.store.dir(run.id), 'planning') };
}

test('invalid issue quotation receives field-specific feedback and an exact replacement reaches reproduction', async t => {
  const x = await exercise(t, 'corrected');
  assert.equal(x.prompts.length, 2); assert.equal(x.reproductionTurns, 1); assert.equal(x.restarts, 0);
  assert.deepEqual(x.phases, ['review', 'review']); assert.deepEqual(x.run.acceptancePlan, requirements);
  assert.match(x.prompts[1], /requirements\[0\]\.citation/); assert.match(x.prompts[1], /full replacement|complete replacement/i);
  for (let n = 1; n <= 2; n++) assert.deepEqual(JSON.parse(await fs.readFile(path.join(x.dir, `attempt-${n}/submitted-answer.json`), 'utf8')), x.submitted[n - 1]);
  const rejected = JSON.parse(await fs.readFile(path.join(x.dir, 'attempt-1/validation.json'), 'utf8'));
  assert.equal(rejected.accepted, false); assert.ok(rejected.errors.some((e: any) => e.path === 'requirements[0].citation'));
  assert.equal(JSON.parse(await fs.readFile(path.join(x.dir, 'attempt-2/validation.json'), 'utf8')).accepted, true);
});

test('three invalid submitted plans stop as needs_attention before reproduction without changing submitted behavior', async t => {
  const x = await exercise(t, 'exhausted');
  assert.equal(x.prompts.length, 3); assert.equal(x.reproductionTurns, 0); assert.equal(x.run.outcome, 'needs_attention');
  assert.match(x.run.error!, /planning|acceptance/i); assert.equal(x.run.acceptancePlan, undefined);
  for (let n = 1; n <= 3; n++) assert.deepEqual(JSON.parse(await fs.readFile(path.join(x.dir, `attempt-${n}/submitted-answer.json`), 'utf8')), { requirements: invalid });
  await assert.rejects(fs.stat(path.join(x.pipeline.store.dir(x.run.id), 'acceptance-plan.json')), { code: 'ENOENT' });
});

test('parsed null is preserved and receives semantic planning feedback', async t => {
  const x = await exercise(t, 'shape'); assert.equal(x.prompts.length, 2); assert.equal(x.reproductionTurns, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(x.dir, 'attempt-1/submitted-answer.json'), 'utf8')), null);
});

test('an invalid supplied operator plan stops without a model correction or rewritten requirements', async t => {
  const x = await exercise(t, 'operator'); assert.equal(x.prompts.length, 0); assert.equal(x.reproductionTurns, 0);
  assert.equal(x.run.outcome, 'needs_attention'); assert.equal(x.run.acceptancePlan, undefined);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(x.dir, 'attempt-1/submitted-answer.json'), 'utf8')), { requirements: invalid });
});

test('a planning artifact write failure stops before another model turn', async t => {
  const x = await exercise(t, 'artifact-failure'); assert.equal(x.prompts.length, 1); assert.equal(x.reproductionTurns, 0);
  assert.equal(x.run.outcome, 'needs_attention'); assert.match(x.run.error!, /preserve.*planning.*Injected planning evidence write failure/i);
});

test('exhausted JSON formatting preserves raw final replies and avoids generic whole-turn retry', async t => {
  const x = await exercise(t, 'format'); assert.equal(x.prompts.length, 1); assert.equal(x.restarts, 0); assert.equal(x.reproductionTurns, 0);
  assert.equal(x.run.outcome, 'needs_attention'); assert.match(x.run.error!, /format|JSON/i);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(x.dir, 'attempt-1/raw-replies.json'), 'utf8')), ['not JSON', 'still not JSON', 'bad third', 'bad fourth']);
  assert.ok(!(await x.pipeline.store.events(x.run.id)).some(e => e.kind === 'agent_retry'));
});

test('cancellation after an invalid reply prevents a follow-up model turn', async t => {
  const x = await exercise(t, 'cancelled'); assert.equal(x.prompts.length, 1); assert.equal(x.reproductionTurns, 0); assert.equal(x.run.outcome, 'cancelled');
});
