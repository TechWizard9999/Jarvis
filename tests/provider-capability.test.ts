import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from '../src/server.ts';
import { tempConfig } from './helpers.ts';

const ultra = 'nvidia/nemotron-3-ultra-550b-a55b';
const lightning = 'nvidia/nemotron-3.5-lightning-30b-a3b';
const unsupported = { error: { message: 'ValueError: thinking_token_budget is not yet supported by the V2 model runner. Run vLLM with VLLM_USE_V2_MODEL_RUNNER=0 to use thinking_token_budget.', type: 'Bad Request', code: 400 } };
const answered = { choices: [{ finish_reason: 'stop' }], usage: { total_tokens: 5 } };
async function gateway(t: test.TestContext, respond: (body: any, call: number) => Response, model = ultra, capabilities?: unknown) {
  const { root, config } = await tempConfig(); config.model = `nim/${model}`;
  await fs.mkdir(path.dirname(config.nvidiaSecret), {recursive:true}); await fs.writeFile(config.nvidiaSecret, 'fixture-secret');
  if(capabilities !== undefined){await fs.mkdir(config.stateDir,{recursive:true});await fs.writeFile(path.join(config.stateDir,'provider-capabilities.json'),typeof capabilities==='string'?capabilities:JSON.stringify(capabilities));}
  const sent: any[] = [];
  const providerRequest = (async (_url: any, options: any) => { const body = JSON.parse(options.body); sent.push(body); return respond(body, sent.length); }) as typeof fetch;
  const app = await createServer(config, { recover: false, providerRequest });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); await fs.rm(root, { recursive:true, force:true }); });
  const run = await app.store.create({ repo:'/repo', issue:'https://github.com/rtk-ai/rtk/issues/1' });
  const agent = { providerToken: 'gw', turnPurpose: 'reproduction' };
  app.pipeline.contexts.set(run.id, { run, agent, abort:new AbortController(), phase:'patching', queue:Promise.resolve() } as any);
  const ask = async () => { const response = await fetch(`http://127.0.0.1:${(app.server.address() as {port:number}).port}/provider/${run.id}/v1/chat/completions`, { method:'POST', headers:{authorization:'Bearer gw','content-type':'application/json'}, body:JSON.stringify({model:config.model.slice(4),messages:[]}) }); await response.text(); return response; };
  return { config, app, run, agent, sent, ask };
}
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status, headers:{'content-type':'application/json'}});

test('specific NVIDIA V2 budget rejection retries once and records effective omission and cached provenance', async t => {
  const f = await gateway(t, (_body, call) => call === 1 ? reply(unsupported,400) : reply(answered));
  assert.equal((await f.ask()).status,200);
  assert.equal(f.sent.length,2);assert.equal(f.sent[0].reasoning_budget,16384);assert.equal(f.sent[1].reasoning_budget,undefined);
  for(const body of f.sent){ assert.equal(body.max_tokens,24576);assert.equal(body.reasoning_effort,'high');assert.deepEqual(body.chat_template_kwargs,{enable_thinking:true,medium_effort:false}); }
  const record=f.run.modelRequests![0] as any;
  assert.equal(record.attempts,2);assert.equal(record.requestedSettings.reasoning_budget,16384);assert.equal(record.settings.reasoning_budget,undefined);
  assert.equal(record.settingsSha256,createHash('sha256').update(JSON.stringify(record.settings)).digest('hex'));
  assert.equal(record.requestedSettingsSha256,createHash('sha256').update(JSON.stringify(record.requestedSettings)).digest('hex'));
  assert.deepEqual(record.parameterOmissions.map((item:any)=>({parameter:item.parameter,reason:item.reason,source:item.source})),[{parameter:'reasoning_budget',reason:'nvidia_v2_model_runner_unsupported',source:'provider_rejection'}]);
  assert.equal(record.answerReserve,'unavailable');assert.notEqual(record.settings.reasoning_budget,-1);
  assert.equal((await f.ask()).status,200);assert.equal(f.sent.length,3);assert.equal(f.sent[2].reasoning_budget,undefined);
  const cached=f.run.modelRequests![1] as any;
  assert.equal(cached.attempts,1);assert.equal(cached.parameterOmissions[0].source,'cached_provider_rejection');assert.equal(cached.parameterOmissions[0].observedAt,record.parameterOmissions[0].observedAt);
  f.agent.turnPurpose='format';assert.equal((await f.ask()).status,200);
  const format=f.run.modelRequests![2] as any;assert.equal(format.parameterOmissions,undefined);assert.equal(format.answerReserve,'not_requested');
  const events=await f.app.store.events(f.run.id);assert.ok(events.some(event=>event.kind==='provider_capability_fallback'));
  assert.doesNotMatch(JSON.stringify(events),/fixture-secret|thinking_token_budget is not yet/);
});

test('capability cache is isolated by endpoint and model and keeps supported Lightning budgets', async t => {
  const f = await gateway(t, (_body, call) => call === 1 ? reply(unsupported,400) : reply(answered));
  await f.ask();f.config.model=`nim/${lightning}`;await f.ask();assert.equal(f.sent[2].reasoning_budget,16384);assert.equal(f.sent[2].reasoning_effort,undefined);
  f.config.model=`nim/${ultra}`;f.config.providerBaseUrl='https://different.example/v1/';await f.ask();assert.equal(f.sent[3].reasoning_budget,16384);
});

for(const [name,response,model,purpose] of [
  ['generic400',()=>reply({error:{message:'unsupported reasoning_budget'}},400),ultra,'reproduction'],
  ['other_error',()=>reply({error:{message:'thinking_token_budget is not yet supported'}},400),ultra,'reproduction'],
  ['auth_error',()=>reply(unsupported,403),ultra,'reproduction'],
  ['no_budget',()=>reply(unsupported,400),ultra,'format'],
  ['other_model',()=>reply(unsupported,400),'fixture-model','reproduction'],
  ['invalid_json',()=>new Response('not JSON',{status:400}),ultra,'reproduction'],
] as const) test(`capability fallback leaves ${name} responses unchanged without retry`, async t => {
  const f=await gateway(t,response,model);f.agent.turnPurpose=purpose;
  const responseValue=await f.ask();assert.equal(responseValue.status,name==='auth_error'?403:400);assert.equal(f.sent.length,1);assert.equal((f.run.modelRequests![0] as any).parameterOmissions,undefined);
});

test('a repeated specific rejection is returned after the single capability retry',async t=>{
  const f=await gateway(t,()=>reply(unsupported,400));assert.equal((await f.ask()).status,400);assert.equal(f.sent.length,2);assert.equal(f.run.modelRequests![0].attempts,2);
});

test('validated exact budget capability survives controller restart without caching provider text or credentials',async t=>{
  const f=await gateway(t,(_body,call)=>call===1?reply(unsupported,400):reply(answered));await f.ask();
  const sent:any[]=[];const second=await createServer(f.config,{recover:false,providerRequest:(async(_url:any,init:any)=>{sent.push(JSON.parse(init.body));return reply(answered);}) as typeof fetch});
  await new Promise<void>(resolve=>second.server.listen(0,'127.0.0.1',resolve));t.after(async()=>{second.server.closeAllConnections();await new Promise<void>(resolve=>second.server.close(()=>resolve()));});
  const run=await second.store.create({repo:'/repo',issue:'https://github.com/rtk-ai/rtk/issues/1'});second.pipeline.contexts.set(run.id,{run,agent:{providerToken:'gw',turnPurpose:'reproduction'},abort:new AbortController(),phase:'patching',queue:Promise.resolve()} as any);
  const response=await fetch(`http://127.0.0.1:${(second.server.address() as {port:number}).port}/provider/${run.id}/v1/chat/completions`,{method:'POST',headers:{authorization:'Bearer gw','content-type':'application/json'},body:JSON.stringify({model:ultra,messages:[]})});await response.text();
  assert.equal(sent[0].reasoning_budget,undefined,'a fresh controller keeps the validated unsupported capability');
  const cached=JSON.parse(await fs.readFile(path.join(f.config.stateDir,'provider-capabilities.json'),'utf8'));assert.equal(cached.version,1);assert.equal(cached.entries.length,1);assert.equal(cached.entries[0].reason,'nvidia_v2_model_runner_unsupported');assert.doesNotMatch(JSON.stringify(cached),/fixture-secret|thinking_token_budget|messages/);
});

for(const [name,cache] of [
  ['malformed JSON','{'],
  ['unknown schema',{version:2,entries:[]}],
  ['invalid entries',{version:1,entries:[null,{endpoint:'https://integrate.api.nvidia.com/v1/',model:ultra,observedAt:new Date().toISOString(),reason:'generic_500'},{endpoint:'https://integrate.api.nvidia.com/v1/',model:ultra,observedAt:'not a timestamp',reason:'nvidia_v2_model_runner_unsupported'},{endpoint:'https://key:secret@integrate.api.nvidia.com/v1/',model:ultra,observedAt:new Date().toISOString(),reason:'nvidia_v2_model_runner_unsupported'}]}],
  ['oversize cache',' '.repeat(64_001)],
] as const)test(`capability cache ignores ${name} without suppressing configured budgets`,async t=>{
  const f=await gateway(t,()=>reply(answered),ultra,cache);assert.equal((await f.ask()).status,200);assert.equal(f.sent[0].reasoning_budget,16384);assert.equal((f.run.modelRequests![0] as any).parameterOmissions,undefined);
});

test('only the exact endpoint and model persisted cache entry affects a request',async t=>{
  const observedAt=new Date().toISOString();const f=await gateway(t,()=>reply(answered),ultra,{version:1,entries:[
    {endpoint:'https://different.example/v1/',model:ultra,observedAt,reason:'nvidia_v2_model_runner_unsupported'},
    {endpoint:'https://integrate.api.nvidia.com/v1/',model:lightning,observedAt,reason:'nvidia_v2_model_runner_unsupported'},
  ]});await f.ask();assert.equal(f.sent[0].reasoning_budget,16384);
});

test('a capability observation requires an ISO timestamp rather than permissive Date.parse input',async t=>{
  const f=await gateway(t,()=>reply(answered),ultra,{version:1,entries:[{endpoint:'https://integrate.api.nvidia.com/v1/',model:ultra,observedAt:'1',reason:'nvidia_v2_model_runner_unsupported'}]});await f.ask();assert.equal(f.sent[0].reasoning_budget,16384);
});
