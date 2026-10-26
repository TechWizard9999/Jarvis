import test from 'node:test';
import assert from 'node:assert/strict';
import { providerBody, providerRetrySeconds } from '../src/provider.ts';
import { loadConfig } from '../src/config.ts';
test('NVIDIA requests explicitly use the supplied sampling and thinking configuration', () => {
  const config=loadConfig({BUGFIX_MODEL:'nim/nvidia/nemotron-3-ultra-550b-a55b'});
  const ultra=providerBody({model:'nvidia/nemotron-3-ultra-550b-a55b',messages:[],max_tokens:99999},config);
  assert.equal(ultra.max_tokens,24576);assert.equal(ultra.temperature,1);assert.equal(ultra.top_p,0.95);assert.deepEqual(ultra.chat_template_kwargs,{enable_thinking:true,medium_effort:false});assert.equal(ultra.reasoning_budget,16384);assert.equal(ultra.reasoning_effort,'high');
  const lightning=providerBody({model:'nvidia/nemotron-3.5-lightning-30b-a3b',messages:[]},config);
  assert.equal(lightning.reasoning_budget,16384);
  const fixture=providerBody({model:'fixture',messages:[]},config);assert.equal(fixture.chat_template_kwargs,undefined);assert.equal(fixture.reasoning_budget,undefined);
});
test('provider Retry-After is honored even when longer than the fallback backoff', () => {
  assert.equal(providerRetrySeconds(new Headers({'retry-after':'120'}),1),120);
  const now=Date.parse('2026-10-20T00:00:00Z');
  assert.equal(providerRetrySeconds(new Headers({'retry-after':'Tue, 20 Oct 2026 00:02:00 GMT'}),1,now),120);
  assert.equal(providerRetrySeconds(new Headers(),20),30);
});
