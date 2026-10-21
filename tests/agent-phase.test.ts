import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { Agent, AgentReplyFormatError } from '../src/agent.ts';
import { Store } from '../src/store.ts';
import { tempConfig } from './helpers.ts';

async function fixture(t: test.TestContext, replies = ['{"complete":true}']) {
  const { root, config } = await tempConfig();
  const store = new Store(config.stateDir);
  const run = await store.create({ repo: '/fixture', issue: 'https://github.com/rtk-ai/rtk/issues/1', retrieval: 'graph' });
  run.sessionId = 'fixture-session';
  const bodies: any[] = [];
  const server = http.createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    bodies.push(JSON.parse(text));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ info: { id: `fixture-${bodies.length}` }, parts: [{ type: 'text', text: replies[bodies.length - 1] || replies.at(-1) }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }); });
  const agent = new Agent(config, {} as any, store, run);
  agent.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { agent, bodies, run };
}
const enabled = (body: any) => Object.keys(body.tools).filter(name => body.tools[name]).sort();
const readTools = ['bugfix_graph_query', 'bugfix_graph_explain', 'bugfix_graph_path', 'bugfix_read_source', 'bugfix_search_text'].sort();

for (const phase of ['discovery', 'review'] as const) test(`${phase} turn advertises only reads and has no reproduction work instructions`, async t => {
  const { agent, bodies } = await fixture(t);
  await agent.ask('Inspect existing tests. Return exactly {"complete":true}.', AbortSignal.timeout(5000), answer => answer.complete === true, phase);
  assert.deepEqual(enabled(bodies[0]), readTools);
  assert.equal(bodies[0].tools.bugfix_apply_patch, false);
  assert.equal(bodies[0].tools.bugfix_replace_source, false);
  assert.equal(bodies[0].tools.bugfix_run_check, false);
  assert.match(bodies[0].system, new RegExp(`phase: ${phase}`, 'i'));
  assert.match(bodies[0].system, /read.only/i);
  assert.doesNotMatch(bodies[0].system, /Add multiple|Run the trusted|confirm the intended assertion failure|Allowed editable roots|Allowed run_check IDs/);
});

test('an unspecified phase defaults to read-only discovery', async t => {
  const { agent, bodies } = await fixture(t);
  await agent.ask('Return exactly {"complete":true}.', AbortSignal.timeout(5000));
  assert.deepEqual(enabled(bodies[0]), readTools);
  assert.match(bodies[0].system, /phase: discovery/i);
});

for (const phase of ['reproduction', 'patching'] as const) test(`${phase} exposes approved editing/check tools with phase-specific constraints`, async t => {
  const { agent, bodies } = await fixture(t);
  await agent.ask('Return exactly {"complete":true}.', AbortSignal.timeout(5000), undefined, phase);
  assert.deepEqual(enabled(bodies[0]), [...readTools, 'bugfix_apply_patch', 'bugfix_replace_source', 'bugfix_run_check'].sort());
  assert.match(bodies[0].system, new RegExp(`phase: ${phase}`, 'i'));
  if (phase === 'reproduction') {
    assert.match(bodies[0].system, /production.*unchanged/i);
    assert.match(bodies[0].system, /format-source/);
    assert.match(bodies[0].system, /intended assertion/);
  } else {
    assert.match(bodies[0].system, /preserv.*frozen/i);
    assert.match(bodies[0].system, /after.*final edit/i);
    assert.doesNotMatch(bodies[0].system, /Add multiple|confirm the intended assertion failure|before freezing regression/);
  }
  assert.equal(bodies[0].tools.bash, false);
  assert.equal(bodies[0].tools.task, false);
});

for (const phase of ['review', 'reproduction'] as const) test(`format-only retry from ${phase} disables every tool and removes work directives`, async t => {
  const { agent, bodies } = await fixture(t, ['not JSON', '{"complete":true}']);
  const answer = await agent.ask('Return exactly {"complete":true}.', AbortSignal.timeout(5000), answer => answer.complete === true, phase);
  assert.equal(answer.complete, true); assert.equal(bodies.length, 2);
  assert.deepEqual(enabled(bodies[1]), []);
  assert.ok(Object.keys(bodies[1].tools).includes('bugfix_run_check'), 'disabled custom tools must be explicit, not inherited defaults');
  assert.match(bodies[1].system, /reply.only|format.only/i);
  assert.doesNotMatch(bodies[1].system, /Add multiple|Run the trusted|intended assertion|Allowed editable roots|Allowed run_check IDs|format-source/);
});

test('a locked turn exposes no tools', async t => {
  const { agent, bodies } = await fixture(t);
  await agent.ask('Return exactly {"complete":true}.', AbortSignal.timeout(5000), undefined, 'locked');
  assert.deepEqual(enabled(bodies[0]), []);
});

test('trusted purpose covers format retry and is cleared after successful and failed turns', async t => {
  const { agent } = await fixture(t);
  const purposes: unknown[] = [];
  let calls = 0;
  (agent as any).longRequest = async () => {
    purposes.push((agent as any).turnPurpose);
    return { info: {}, parts: [{ type: 'text', text: ++calls === 1 ? 'not JSON' : '{"complete":true}' }] };
  };
  await agent.ask('Return exactly {"complete":true}.', AbortSignal.timeout(5000), undefined, 'review');
  assert.deepEqual(purposes, ['review', 'format']); assert.equal((agent as any).turnPurpose, undefined);
  (agent as any).longRequest = async () => { assert.equal((agent as any).turnPurpose, 'patching'); throw new Error('fixture transport failure'); };
  await assert.rejects(agent.ask('Return exactly {}.', AbortSignal.timeout(5000), undefined, 'patching'), /fixture transport failure/);
  assert.equal((agent as any).turnPurpose, undefined);
});

test('overlapping turns cannot overwrite the trusted purpose of a running turn', async t => {
  const { agent } = await fixture(t);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  (agent as any).longRequest = async () => { if (++calls === 1) await held; return { info: {}, parts: [{ type: 'text', text: '{}' }] }; };
  const running = agent.ask('Return exactly {}.', AbortSignal.timeout(5000), undefined, 'reproduction');
  try {
    await assert.rejects(agent.ask('Return exactly {}.', AbortSignal.timeout(5000), undefined, 'discovery'), /Another agent turn is active/);
    assert.equal(agent.turnPurpose, 'reproduction');
  } finally { release(); await running; }
  assert.equal(agent.turnPurpose, undefined);
});

test('initial high-effort review plans acceptance from issue evidence without assuming frozen tests exist', async t => {
  const { agent, bodies } = await fixture(t);
  await agent.ask('Read the issue as evidence. Return exactly {"complete":true}.', AbortSignal.timeout(5000), undefined, 'review');
  assert.deepEqual(enabled(bodies[0]), readTools);
  assert.match(bodies[0].system, /acceptance planning/i);
  assert.match(bodies[0].system, /issue body/i);
  assert.match(bodies[0].system, /exact.*contiguous|contiguous.*exact/i);
  assert.match(bodies[0].system, /source.*not.*citation|citation.*not.*source/i);
  assert.doesNotMatch(bodies[0].system, /existing tests and evidence against every explicit issue behavior, frozen requirement/);
});

test('review after plan freeze retains independent coverage review instead of replanning acceptance', async t => {
  const { agent, bodies, run } = await fixture(t);
  run.acceptancePlan = [{ id: 'reported', expectedBehavior: 'Preserve ordinary output.', citation: 'Ordinary output must be preserved.', baseline: 'fail' }];
  await agent.ask('Independently critique acceptance coverage. Return exactly {"complete":true}.', AbortSignal.timeout(5000), undefined, 'review');
  assert.deepEqual(enabled(bodies[0]), readTools);
  assert.match(bodies[0].system, /read.only acceptance review/i);
  assert.match(bodies[0].system, /frozen requirement/i);
  assert.doesNotMatch(bodies[0].system, /acceptance planning/i);
});

test('format exhaustion is typed, bounded and carries every unchanged raw reply privately', async t => {
  const replies = ['initial invalid secret body', 'first malformed secret body', '{"wrong":"second secret body"}', 'third invalid secret body'];
  const { agent, bodies } = await fixture(t, replies);
  let thrown: any;
  try { await agent.ask('Return exactly {"complete":true}.', AbortSignal.timeout(5000), answer => answer?.complete === true, 'review'); }
  catch (error) { thrown = error; }
  assert.ok(thrown instanceof AgentReplyFormatError);
  assert.equal(thrown.constructor.name, 'AgentReplyFormatError');
  assert.deepEqual(thrown.replies, replies);
  assert.equal(bodies.length, 4);
  assert.ok(bodies.slice(1).every(body => enabled(body).length === 0));
  assert.doesNotMatch(thrown.message, /secret body|wrong/);
  assert.equal(agent.turnPurpose, undefined);
});
