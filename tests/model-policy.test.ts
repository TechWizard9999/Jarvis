import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { loadConfig } from '../src/config.ts';
import { providerBody, type ModelTurnPurpose } from '../src/provider.ts';
import { agentConfig } from '../src/agent.ts';
import { Store } from '../src/store.ts';
import { captureRunConfiguration } from '../src/lifecycle.ts';
import { tempConfig } from './helpers.ts';

const ultra = 'nvidia/nemotron-3-ultra-550b-a55b';
const lightning = 'nvidia/nemotron-3.5-lightning-30b-a3b';
const config = () => loadConfig({ BUGFIX_MODEL: `nim/${ultra}` });
const request = { model: ultra, messages: [] };
const outbound = (body: Record<string, unknown>, cfg = config(), purpose: ModelTurnPurpose = 'reproduction') => providerBody(body, cfg, purpose);

test('critical Ultra calls enforce high reasoning and leave final-answer space', () => {
  const body = outbound({ ...request, max_tokens: 99999, reasoning_effort: 'none', reasoning_budget: -1, thinking: { type: 'disabled' }, reasoning: { effort: 'none' }, chat_template_kwargs: { enable_thinking: false, medium_effort: true, custom: 'preserved' } });
  assert.equal(body.max_tokens, 24576);
  assert.equal(body.reasoning_budget, 16384);
  assert.equal(body.reasoning_effort, 'high');
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: true, medium_effort: false, custom: 'preserved' });
  assert.equal(body.thinking, undefined); assert.equal(body.reasoning, undefined);
  assert.equal(body.temperature, 1); assert.equal(body.top_p, 0.95);
});

test('discovery and reply-only calls use trusted purpose despite supplied policy fields', () => {
  const discovery = outbound({ ...request, purpose: 'format', turnPurpose: 'format', max_tokens: 30000 }, config(), 'discovery');
  assert.equal(discovery.purpose, undefined); assert.equal(discovery.turnPurpose, undefined);
  assert.equal(discovery.max_tokens, 8192); assert.equal(discovery.reasoning_budget, 4096); assert.equal(discovery.reasoning_effort, 'medium');
  assert.deepEqual(discovery.chat_template_kwargs, { enable_thinking: true, medium_effort: true });
  for (const purpose of ['format', 'locked'] as const) {
    const body = outbound({ ...request, reasoning_effort: 'high', reasoning_budget: 16384 }, config(), purpose);
    assert.equal(body.max_tokens, 2048); assert.equal(body.reasoning_effort, 'none'); assert.equal(body.reasoning_budget, undefined);
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false, medium_effort: false });
  }
});

test('smaller SDK outputs clamp reasoning and disable it when answer reserve consumes output', () => {
  const constrained = outbound({ ...request, max_tokens: 4096 });
  assert.equal(constrained.max_tokens, 4096); assert.equal(constrained.reasoning_budget, 2048);
  for (const max_tokens of [1, 1024, 2048]) {
    const body = outbound({ ...request, max_tokens });
    assert.equal(body.max_tokens, max_tokens); assert.equal(body.reasoning_budget, undefined); assert.equal(body.reasoning_effort, 'none');
    assert.equal(body.chat_template_kwargs.enable_thinking, false);
  }
  for (const max_tokens of [0, -1, 1.5, NaN, Infinity, '4096']) assert.throws(() => outbound({ ...request, max_tokens }), /max_tokens/);
});

test('Lightning receives supported budget and template controls without Ultra effort fields', () => {
  const body = outbound({ model: lightning, messages: [], reasoning_effort: 'high', chat_template_kwargs: { medium_effort: true, enable_thinking: false, custom: true } }, config(), 'discovery');
  assert.equal(body.max_tokens, 8192); assert.equal(body.reasoning_budget, 4096); assert.equal(body.reasoning_effort, undefined);
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: true, custom: true });
});

test('research unlimited reasoning requires explicit opt-in and never leaks into reply-only turns', () => {
  assert.throws(() => loadConfig({ BUGFIX_REASONING_BUDGET: '-1' }), /ALLOW_UNBOUNDED_REASONING/);
  const cfg = loadConfig({ BUGFIX_MODEL: `nim/${ultra}`, BUGFIX_REASONING_BUDGET: '-1', BUGFIX_ALLOW_UNBOUNDED_REASONING: 'true' });
  assert.equal(outbound(request, cfg).reasoning_budget, -1);
  assert.equal(outbound(request, cfg, 'format').reasoning_budget, undefined);
  assert.throws(() => loadConfig({ BUGFIX_REASONING_BUDGET: '-2', BUGFIX_ALLOW_UNBOUNDED_REASONING: 'true' }), /REASONING_BUDGET/);
});

test('context capabilities reject invalid relationships and require large-context opt-in', () => {
  for (const env of [
    { BUGFIX_MODEL_INPUT: '250000' }, { BUGFIX_MODEL_MAX_OUTPUT: '40000', BUGFIX_MODEL: `nim/${ultra}` },
    { BUGFIX_MODEL_CONTEXT: '20000' }, { BUGFIX_COMPACTION_RESERVED: '196608' },
    { BUGFIX_MODEL_CONTEXT: '1048576' }, { BUGFIX_MODEL_CONTEXT: '1048577', BUGFIX_ALLOW_UNVERIFIED_CONTEXT: 'true' },
    { BUGFIX_ALLOW_UNVERIFIED_CONTEXT: 'yes' }, { BUGFIX_ALLOW_UNBOUNDED_REASONING: 'yes' },
  ]) assert.throws(() => loadConfig(env), /context|input|output|reserve|Invalid|UNVERIFIED|UNBOUNDED/i);
  assert.equal((loadConfig({ BUGFIX_MODEL_CONTEXT: '1048576', BUGFIX_ALLOW_UNVERIFIED_CONTEXT: 'true' }) as any).modelContext, 1048576);
});

test('an existing smaller context gets a safe input default without rewriting an explicit input limit', () => {
  const cfg = loadConfig({ BUGFIX_MODEL_CONTEXT: '131072', BUGFIX_MODEL_MAX_OUTPUT: '16384' });
  assert.equal(cfg.modelContext, 131072); assert.equal(cfg.modelInput, 114688);
  assert.equal(config().modelContext, 262144); assert.equal(config().modelInput, 196608);
  assert.throws(() => loadConfig({ BUGFIX_MODEL_CONTEXT: '131072', BUGFIX_MODEL_MAX_OUTPUT: '16384', BUGFIX_MODEL_INPUT: '120000' }), /input plus output/);
});

test('OpenCode applies the working input and compaction reserve and records them without claiming endpoint support', async t => {
  const { root, config: cfg } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const run = await new Store(cfg.stateDir).create({ repo: '/fixture', issue: 'https://github.com/rtk-ai/rtk/issues/1' });
  const active = agentConfig(run, cfg, 'internal-token') as any;
  assert.deepEqual(active.provider.nvidia.models['fixture-model'].limit, { context: 262144, input: 196608, output: 24576 });
  assert.deepEqual(active.compaction, { auto: true, prune: true, reserved: 8192 });
  const captured = captureRunConfiguration(cfg) as any;
  assert.equal(captured.modelInput, 196608); assert.equal(captured.compactionReserved, 8192); assert.equal(captured.allowUnverifiedContext, false);
  assert.deepEqual(captured.compaction, { auto: true, prune: true, reserved: 8192 });
});

test('other models preserve compatible request fields and sampling behavior', () => {
  const body = outbound({ model: 'fixture-model', messages: [], max_tokens: 1000, reasoning_effort: 'custom', chat_template_kwargs: { custom: true } }, config(), 'format');
  assert.equal(body.max_tokens, 1000); assert.equal(body.reasoning_effort, 'custom'); assert.deepEqual(body.chat_template_kwargs, { custom: true });
});

test('Compose leaves an absent working-input override for the controller to derive on legacy contexts', async () => {
  const compose = await fs.readFile(new URL('../compose.yaml',import.meta.url),'utf8');
  const template = /^\s+BUGFIX_MODEL_INPUT:\s*(.+)$/m.exec(compose)?.[1];
  assert.ok(template, 'Compose must forward the working-input override');
  const legacyEnv: Record<string,string> = { BUGFIX_MODEL_CONTEXT:'131072', BUGFIX_MODEL_MAX_OUTPUT:'16384' };
  const expanded = template.replace(/\$\{([A-Z_]+):-([^}]*)\}/g, (_whole,key,fallback) => legacyEnv[key] || fallback);
  const legacy = loadConfig({...legacyEnv,BUGFIX_MODEL_INPUT:expanded});
  assert.equal(legacy.modelInput,114688);assert.equal(legacy.modelContext,131072);assert.equal(legacy.modelMaxOutput,16384);
  const fresh = loadConfig({BUGFIX_MODEL_INPUT:expanded});assert.equal(fresh.modelInput,196608);
  const explicit = loadConfig({...legacyEnv,BUGFIX_MODEL_INPUT:'100000'});assert.equal(explicit.modelInput,100000);
});
