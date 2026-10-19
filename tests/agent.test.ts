import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { filterProviderTools, agentConfig, parseAgentJson } from '../src/agent.ts';
import { Store } from '../src/store.ts';
import { validateInput } from '../src/pipeline.ts';
import { tempConfig } from './helpers.ts';
test('actual outbound provider payload drops native tools and retains only controller tools', async t => {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const run = await new Store(config.stateDir).create({ repo: '/fixture', issue: 'https://github.com/rtk-ai/rtk/issues/1', retrieval: 'graph' });
  const tools = ['bash','read','webfetch','bugfix_read_source','bugfix_apply_patch'].map(name=>({type:'function',function:{name,parameters:{}}}));
  const filtered = filterProviderTools(run, { tools, model: 'fixture' }); assert.deepEqual(filtered.names, ['bugfix_read_source','bugfix_apply_patch']); assert.equal(filtered.removed,3);
  assert.throws(()=>filterProviderTools(run,{tools:tools.slice(0,3)}),/No approved/);
  const generated = agentConfig(run, config, 'INTERNAL_GATEWAY_TOKEN');
  assert.equal(generated.permission['*'], 'deny'); assert.equal(generated.tools.bash, false); assert.equal(generated.provider.nvidia.options.apiKey, 'INTERNAL_GATEWAY_TOKEN');
});
test('text control mode cannot expose graph tools', async t => {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const run = await new Store(config.stateDir).create({ repo: '/fixture', issue: 'https://github.com/rtk-ai/rtk/issues/1', retrieval: 'text' });
  const out = filterProviderTools(run,{tools:['bugfix_graph_query','bugfix_search_text'].map(name=>({type:'function',function:{name}}))});
  assert.deepEqual(out.names,['bugfix_search_text']);
});
test('historical evaluation cannot publish and issue URLs are constrained', () => {
  assert.throws(()=>validateInput({repo:'/repo',issue:'https://github.com/rtk-ai/rtk/issues/1',mode:'evaluation',publish:true}),/cannot publish/);
  for(const issue of ['https://example.com/rtk-ai/rtk/issues/1','https://github.com/another/repo/issues/1','https://github.com/rtk-ai/rtk/issues/1?x=y']) assert.throws(()=>validateInput({repo:'/repo',issue}));
  assert.equal(validateInput({repo:'/repo',issue:'https://github.com/rtk-ai/rtk/issues/1',mode:'evaluation'}).publish,false);
});
test('agent output must be valid final JSON, never a success-looking prose claim', () => {
  assert.deepEqual(parseAgentJson('```json\n{"status":"cannot_reproduce"}\n```'), {status:'cannot_reproduce'});
  assert.throws(()=>parseAgentJson('Everything passed, trust me.'),/JSON/);
});
