import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from '../src/server.ts';
import { tempConfig } from './helpers.ts';

test('model gateway bounds consecutive transient recovery to four attempts and reports only answered usage', async t => {
  const {root,config}=await tempConfig();await fs.mkdir(path.dirname(config.nvidiaSecret),{recursive:true});await fs.writeFile(config.nvidiaSecret,'test-key');
  const statuses=[429,200,429,429,429,200,500,500,500,500];let calls=0;
  const providerRequest=(async()=>{const status=statuses[calls++];return new Response(status===200?JSON.stringify({choices:[],usage:{total_tokens:42}}):JSON.stringify({status}),{status,headers:{'content-type':'application/json','retry-after':'0'}});}) as unknown as typeof fetch;
  const app=await createServer(config,{recover:false,providerRequest});await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{app.server.closeAllConnections();await new Promise<void>(resolve=>app.server.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true});});
  const run=await app.store.create({repo:'/repo',issue:'https://github.com/rtk-ai/rtk/issues/1',mode:'live',retrieval:'text'} as any);
  app.pipeline.contexts.set(run.id,{run,abort:new AbortController(),agent:{providerToken:'gw'},phase:'reproduction',queue:Promise.resolve()} as any);
  const ask=()=>fetch(`http://127.0.0.1:${(app.server.address() as {port:number}).port}/provider/${run.id}/v1/chat/completions`,{method:'POST',headers:{authorization:'Bearer gw','content-type':'application/json'},body:JSON.stringify({model:'fixture-model',messages:[{role:'user',content:'hi'}]})});
  const ok=await ask();assert.equal(ok.status,200);await ok.text();assert.equal(calls,2);assert.equal(run.tokens,42);
  const retried=await ask();assert.equal(retried.status,200);await retried.text();assert.equal(calls,6);assert.equal(run.tokens,84);
  const failed=await ask();assert.equal(failed.status,500);await failed.text();assert.equal(calls,10);assert.equal(run.tokens,84);
  assert.equal(run.modelRequests?.[2].attemptRecords?.length,4);assert.equal(run.modelRequests?.[2].providerError?.kind,'provider_error');
});

test('model gateway abandons a provider request that stays silent and retries it', async t => {
  const {root,config}=await tempConfig();await fs.mkdir(path.dirname(config.nvidiaSecret),{recursive:true});await fs.writeFile(config.nvidiaSecret,'test-key');
  let calls=0;
  const providerRequest=((_url:string,init:RequestInit)=>calls++===0?new Promise((_,reject)=>init.signal!.addEventListener('abort',()=>reject(init.signal!.reason))):Promise.resolve(new Response(JSON.stringify({choices:[],usage:{total_tokens:7}}),{status:200,headers:{'content-type':'application/json'}}))) as unknown as typeof fetch;
  const app=await createServer(config,{recover:false,providerRequest,providerSilenceMs:200});await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{app.server.closeAllConnections();await new Promise<void>(resolve=>app.server.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true});});
  const run=await app.store.create({repo:'/repo',issue:'https://github.com/rtk-ai/rtk/issues/1',mode:'live',retrieval:'text'} as any);
  app.pipeline.contexts.set(run.id,{run,abort:new AbortController(),agent:{providerToken:'gw'},phase:'reproduction',queue:Promise.resolve()} as any);
  const response=await fetch(`http://127.0.0.1:${(app.server.address() as {port:number}).port}/provider/${run.id}/v1/chat/completions`,{method:'POST',headers:{authorization:'Bearer gw','content-type':'application/json'},body:JSON.stringify({model:'fixture-model',messages:[{role:'user',content:'hi'}]})});
  assert.equal(response.status,200);await response.text();assert.equal(calls,2);assert.equal(run.tokens,7);
});

test('while the PR description is written the agent keeps model access but no tools; once locked it has neither', async t => {
  const {root,config}=await tempConfig();await fs.mkdir(path.dirname(config.nvidiaSecret),{recursive:true});await fs.writeFile(config.nvidiaSecret,'test-key');
  const providerRequest=(async()=>new Response(JSON.stringify({choices:[],usage:{total_tokens:5}}),{status:200,headers:{'content-type':'application/json'}})) as unknown as typeof fetch;
  const app=await createServer(config,{recover:false,providerRequest});await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{app.server.closeAllConnections();await new Promise<void>(resolve=>app.server.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true});});
  const run=await app.store.create({repo:'/repo',issue:'https://github.com/rtk-ai/rtk/issues/1',mode:'live',retrieval:'text'} as any);
  const context={run,abort:new AbortController(),agent:{providerToken:'gw',toolToken:'tt'},phase:'describe',queue:Promise.resolve()} as any;app.pipeline.contexts.set(run.id,context);
  const ask=()=>fetch(`http://127.0.0.1:${(app.server.address() as {port:number}).port}/provider/${run.id}/v1/chat/completions`,{method:'POST',headers:{authorization:'Bearer gw','content-type':'application/json'},body:JSON.stringify({model:'fixture-model',messages:[{role:'user',content:'describe'}]})});
  const allowed=await ask();assert.equal(allowed.status,200);await allowed.text();
  await assert.rejects(app.pipeline.tool(run.id,'read_source',{path:'src/lib.rs'}),/locked/);
  context.phase='review';await assert.rejects(app.pipeline.tool(run.id,'apply_patch',{edits:[]}),/read-only/);
  context.phase='locked';const refused=await ask();assert.equal(refused.status,409);await refused.text();
});

test('direct chat API sends a prompt to the configured model, waits out 429s and returns answer, reasoning and usage', async t => {
  const {root,config}=await tempConfig();await fs.mkdir(path.dirname(config.nvidiaSecret),{recursive:true});await fs.writeFile(config.nvidiaSecret,'test-key');
  const sent:any[]=[];const sse=(...events:unknown[])=>events.map(e=>`data: ${JSON.stringify(e)}\n\n`).join('')+'data: [DONE]\n\n';
  const replies=[()=>new Response('{}',{status:429,headers:{'retry-after':'0'}}),()=>new Response(sse({choices:[{delta:{reasoning_content:'Add the numbers.'}}]},{choices:[{delta:{content:'2 + 2 '}}]},{choices:[{delta:{content:'= 4'},finish_reason:'stop'}]},{choices:[],usage:{total_tokens:31}}),{status:200,headers:{'content-type':'text/event-stream'}}),
    ()=>new Response(sse({choices:[{delta:{content:'<think>inline</think>\nDone.'},finish_reason:'stop'}]}),{status:200}),()=>new Response('{"detail":"private-provider-response"}',{status:404})];
  const providerRequest=((_url:string,init:RequestInit)=>{sent.push(JSON.parse(String(init.body)));return Promise.resolve(replies[sent.length-1]());}) as unknown as typeof fetch;
  const app=await createServer(config,{recover:false,providerRequest});await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{app.server.closeAllConnections();await new Promise<void>(resolve=>app.server.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${(app.server.address() as {port:number}).port}/api/chat`,headers={authorization:`Bearer ${app.uiToken}`,'content-type':'application/json'};
  const post=(body:unknown,h:Record<string,string>=headers)=>fetch(base,{method:'POST',headers:h,body:JSON.stringify(body)});
  assert.equal((await post({prompt:'hi'},{'content-type':'application/json'})).status,401);
  assert.equal((await post({prompt:'  '})).status,400);assert.equal((await post({messages:[{role:'tool',content:'x'}]})).status,400);assert.equal(sent.length,0);
  const ok=await post({prompt:'What is 2 + 2?',system:'Be brief.'});assert.equal(ok.status,200);
  assert.deepEqual(await ok.json(),{model:'fixture-model',answer:'2 + 2 = 4',reasoning:'Add the numbers.',finishReason:'stop',usage:{total_tokens:31}});
  assert.equal(sent.length,2);assert.equal(sent[1].model,'fixture-model');assert.equal(sent[1].stream,true);
  assert.deepEqual(sent[1].messages,[{role:'system',content:'Be brief.'},{role:'user',content:'What is 2 + 2?'}]);
  const inline=await (await post({prompt:'x',model:'nvidia/other-model'})).json();assert.equal(inline.answer,'Done.');assert.equal(inline.reasoning,'inline');assert.equal(sent[2].model,'nvidia/other-model');
  const missing=await post({prompt:'x'});assert.equal(missing.status,502);const failure=await missing.json();assert.equal(failure.providerStatus,404);assert.doesNotMatch(JSON.stringify(failure),/private-provider-response/);
});

test('dashboard requires authentication, blocks cross-origin writes and serves a labelled demo', async t => {
  const {root,config}=await tempConfig();const app=await createServer(config,{recover:false});await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const address=app.server.address() as {port:number};const base=`http://127.0.0.1:${address.port}`;
  t.after(async()=>{app.server.closeAllConnections();await new Promise<void>(resolve=>app.server.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true});});
  assert.equal((await fetch(base+'/api/runs')).status,401);
  const headers={authorization:`Bearer ${app.uiToken}`,'content-type':'application/json'};
  assert.equal((await fetch(base+'/api/demo',{method:'POST',headers:{...headers,origin:'https://evil.example'}})).status,403);
  assert.match(await(await fetch(base+'/',{headers})).text(),/From reported bug/);
  const response=await fetch(base+'/api/demo',{method:'POST',headers});assert.equal(response.status,202);const run=await response.json() as any;
  await new Promise(resolve=>setTimeout(resolve,2400));const result=await(await fetch(base+`/api/runs/${run.id}`,{headers})).json() as any;
  assert.equal(result.outcome,'demo_complete');assert.equal(result.demo,true);
  assert.equal((await fetch(base+`/api/runs/${run.id}/artifact?path=agent-secrets/server_password`,{headers})).status,400);
});

test('disconnect during delayed SSE replay releases its listener before history resolves', async t => {
  const {root,config}=await tempConfig();const app=await createServer(config,{recover:false});await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{app.server.closeAllConnections();await new Promise<void>(resolve=>app.server.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true});});
  const run=await app.store.create({repo:'/repo',issue:'https://github.com/rtk-ai/rtk/issues/1'});
  let release!: () => void; const delayed = new Promise<void>(resolve => {release=resolve;});
  const original=app.store.streamEvents.bind(app.store);app.store.streamEvents=async function*(id,after,signal){await delayed;yield* original(id,after,signal);};
  const http=await import('node:http');
  const req=http.get(`http://127.0.0.1:${(app.server.address() as {port:number}).port}/api/runs/${run.id}/events`,{headers:{authorization:`Bearer ${app.uiToken}`}});
  req.on('error',()=>{});
  while(app.store.listenerCount(run.id)===0) await new Promise(resolve=>setTimeout(resolve,5));
  req.destroy(); await new Promise(resolve=>setTimeout(resolve,30));
  const listeners=app.store.listenerCount(run.id); release();
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(listeners,0,'close removes listener even when replay is pending');
  assert.equal(app.store.listenerCount(run.id),0,'replay completion cannot reinstall a disconnected listener');
});

test('model usage preserves absent counts, request latency, splits and retry completeness', async t => {
  const {root,config}=await tempConfig();await fs.mkdir(path.dirname(config.nvidiaSecret),{recursive:true});await fs.writeFile(config.nvidiaSecret,'fixture-key');
  let count=0;const providerRequest=(async()=>new Response(JSON.stringify(++count===1?{choices:[]}:{choices:[],usage:{prompt_tokens:12,completion_tokens:3,total_tokens:15}}),{headers:{'content-type':'application/json'}})) as typeof fetch;
  const app=await createServer(config,{recover:false,providerRequest});await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{app.server.closeAllConnections();await new Promise<void>(resolve=>app.server.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true});});
  const run=await app.store.create({repo:'/repo',issue:'https://github.com/rtk-ai/rtk/issues/1'});
  app.pipeline.contexts.set(run.id,{run,abort:new AbortController(),agent:{providerToken:'gw'},phase:'reproduction',queue:Promise.resolve()} as any);
  const ask=()=>fetch(`http://127.0.0.1:${(app.server.address() as {port:number}).port}/provider/${run.id}/v1/chat/completions`,{method:'POST',headers:{authorization:'Bearer gw','content-type':'application/json'},body:JSON.stringify({model:'fixture-model',messages:[]})});
  await (await ask()).text();await(await ask()).text();
  const requests=(run as any).modelRequests;
  assert.equal(requests?.length,2,'each outbound request has a durable record');
  assert.equal(requests[0].usage,'unknown');assert.equal(requests[0].totalTokens,undefined);
  assert.equal(requests[1].usage,'complete');assert.equal(requests[1].inputTokens,12);assert.equal(requests[1].outputTokens,3);assert.equal(requests[1].totalTokens,15);
  assert.ok(requests.every((request:any)=>request.finishedAt&&request.latencyMs>=0&&request.attempts===1));assert.equal(run.tokens,15);
});

test('interrupted model responses retain partial usage rather than reporting an answered zero', async t => {
  const {root,config}=await tempConfig();await fs.mkdir(path.dirname(config.nvidiaSecret),{recursive:true});await fs.writeFile(config.nvidiaSecret,'fixture-key');
  const providerRequest=(async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('data: {"usage":{"prompt_tokens":12,"completion_tokens":2,"total_tokens":14}}\n\n'));setTimeout(()=>controller.error(new Error('lost provider connection')),20);}}),{headers:{'content-type':'text/event-stream'}})) as typeof fetch;
  const app=await createServer(config,{recover:false,providerRequest});await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{app.server.closeAllConnections();await new Promise<void>(resolve=>app.server.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true});});
  const run=await app.store.create({repo:'/repo',issue:'https://github.com/rtk-ai/rtk/issues/1'});app.pipeline.contexts.set(run.id,{run,abort:new AbortController(),agent:{providerToken:'gw'},phase:'reproduction',queue:Promise.resolve()} as any);
  await assert.rejects(async()=>{const response=await fetch(`http://127.0.0.1:${(app.server.address() as {port:number}).port}/provider/${run.id}/v1/chat/completions`,{method:'POST',headers:{authorization:'Bearer gw','content-type':'application/json'},body:JSON.stringify({model:'fixture-model',messages:[]})});await response.text();});await new Promise(resolve=>setTimeout(resolve,30));
  const record=run.modelRequests?.[0];assert.equal(record?.usage,'partial');assert.equal(record?.totalTokens,14);assert.equal(record?.status,'interrupted');assert.equal(run.tokens,14);
});

test('history uses exclusive cursors and permits only safe evidence artifacts', async t => {
  const {root,config}=await tempConfig();const app=await createServer(config,{recover:false});await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{app.server.closeAllConnections();await new Promise<void>(resolve=>app.server.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true});});
  const run=await app.store.create({repo:'/repo',issue:'https://github.com/rtk-ai/rtk/issues/1'});for(let i=1;i<=5;i++)await app.store.event(run,'controller',i===2?'tool_rejected':'output',`event ${i}`);
  const base=`http://127.0.0.1:${(app.server.address() as {port:number}).port}/api/runs/${run.id}`,headers={authorization:`Bearer ${app.uiToken}`};
  const page=await(await fetch(base+'/history?limit=2&before=5',{headers})).json() as any;assert.deepEqual(page.events.map((event:any)=>event.seq),[3,4]);assert.equal(page.hasOlder,true);assert.equal(page.latestSeq,5);
  assert.equal((await fetch(base+'/history?before=bad',{headers})).status,400);
  await fs.writeFile(path.join(app.store.dir(run.id),'run-config.json'),JSON.stringify({model:'fixture',secrets:'redacted'}));
  assert.equal((await fetch(base+'/artifact?path=run-config.json',{headers})).status,200);
  for(const file of ['agent/opencode.json','agent-secrets/bridge_token','../../.env'])assert.equal((await fetch(base+'/artifact?path='+encodeURIComponent(file),{headers})).status,400);
});

test('gateway uses trusted turn purpose, records effective settings and preserves unknown internal metadata', async t => {
  const {root,config}=await tempConfig();config.model='nim/nvidia/nemotron-3-ultra-550b-a55b';await fs.mkdir(path.dirname(config.nvidiaSecret),{recursive:true});await fs.writeFile(config.nvidiaSecret,'fixture-key');
  const outbound:any[]=[];let response=0;
  const providerRequest=(async(_url:any,init:any)=>{outbound.push(JSON.parse(init.body));return new Response(JSON.stringify(++response===1?{choices:[{finish_reason:'length'}],usage:{prompt_tokens:20,completion_tokens:12,total_tokens:32,completion_tokens_details:{reasoning_tokens:9}}}:{choices:[]}),{headers:{'content-type':'application/json'}});}) as typeof fetch;
  const app=await createServer(config,{recover:false,providerRequest});await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{app.server.closeAllConnections();await new Promise<void>(resolve=>app.server.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true});});
  const run=await app.store.create({repo:'/repo',issue:'https://github.com/rtk-ai/rtk/issues/1'});
  const agent={providerToken:'gw',turnPurpose:'format' as string|undefined};
  app.pipeline.contexts.set(run.id,{run,abort:new AbortController(),agent,phase:'patching',queue:Promise.resolve()} as any);
  const ask=()=>fetch(`http://127.0.0.1:${(app.server.address() as {port:number}).port}/provider/${run.id}/v1/chat/completions`,{method:'POST',headers:{authorization:'Bearer gw','content-type':'application/json'},body:JSON.stringify({model:'nvidia/nemotron-3-ultra-550b-a55b',messages:[],turnPurpose:'discovery',reasoning_budget:-1,reasoning_effort:'high'})});
  await(await ask()).text();agent.turnPurpose=undefined;await(await ask()).text();
  assert.equal(outbound[0].max_tokens,2048);assert.equal(outbound[0].reasoning_effort,'none');assert.equal(outbound[0].reasoning_budget,undefined);
  assert.equal(outbound[1].max_tokens,24576);assert.equal(outbound[1].reasoning_effort,'high');assert.equal(outbound[1].reasoning_budget,16384);
  const records=run.modelRequests as any[];
  assert.equal(records[0].turnPurpose,'format');assert.equal(records[0].turnPurposeSource,'active_turn');assert.equal(records[0].internalPurpose,'unknown');
  assert.equal(records[1].turnPurpose,'patching');assert.equal(records[1].turnPurposeSource,'stage_fallback');assert.equal(records[1].internalPurpose,'unknown');
  assert.equal(records[0].reasoningTokens,9);assert.equal(records[0].finishReason,'length');assert.equal(records[1].reasoningTokens,undefined);assert.equal(records[1].finishReason,undefined);
  assert.equal(records[0].settings.chat_template_kwargs.medium_effort,false);
  assert.deepEqual(records[0].contextLimits,{context:262144,input:196608,compactionReserved:8192});
  for(const key of ['model_context','model_input','compaction_reserved']) {
    assert.equal(records[0].settings[key],undefined,'Configured context metadata must not masquerade as an outbound generation control');
    assert.equal(outbound[0][key],undefined);
  }
});

test('provider request capacity accepts a supported-context body beyond old limit and rejects finite overflow', async t => {
  const {root,config}=await tempConfig();await fs.mkdir(path.dirname(config.nvidiaSecret),{recursive:true});await fs.writeFile(config.nvidiaSecret,'fixture-key');
  let calls=0;const providerRequest=(async()=>{calls++;return new Response('{"choices":[]}',{headers:{'content-type':'application/json'}});}) as typeof fetch;
  const app=await createServer(config,{recover:false,providerRequest});await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{app.server.closeAllConnections();await new Promise<void>(resolve=>app.server.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true});});
  const run=await app.store.create({repo:'/repo',issue:'https://github.com/rtk-ai/rtk/issues/1'});app.pipeline.contexts.set(run.id,{run,abort:new AbortController(),agent:{providerToken:'gw'},phase:'discovery',queue:Promise.resolve()} as any);
  const ask=(length:number)=>fetch(`http://127.0.0.1:${(app.server.address() as {port:number}).port}/provider/${run.id}/v1/chat/completions`,{method:'POST',headers:{authorization:'Bearer gw','content-type':'application/json'},body:JSON.stringify({model:'fixture-model',messages:[{role:'user',content:'x'.repeat(length)}]})});
  const accepted=await ask(4_100_000);assert.equal(accepted.status,200);await accepted.text();
  const rejected=await ask(10_000_000);assert.equal(rejected.status,400);assert.match(await rejected.text(),/too large.*limit/i);assert.equal(calls,1);
});


test('SSE replays histories beyond the socket buffer in order and includes live events during replay', async t => {
  const { root, config } = await tempConfig();
  const app = await createServer(config, { recover: false }); await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const stop = new AbortController();
  t.after(async () => { stop.abort(); app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }); });
  const run = await app.store.create({ repo: '/repo', issue: 'https://github.com/rtk-ai/rtk/issues/1' });
  await Promise.all(Array.from({ length: 30 }, (_, i) => app.store.event(run, 'test', 'progress', `${i} ${'x'.repeat(100_000)}`)));
  const response = await fetch(`http://127.0.0.1:${(app.server.address() as { port: number }).port}/api/runs/${run.id}/events`, { headers: { authorization: `Bearer ${app.uiToken}` }, signal: stop.signal });
  assert.equal(response.status, 200);
  await app.store.event(run, 'test', 'progress', 'live after replay started');
  const reader = response.body!.getReader(), decoder = new TextDecoder(); const ids: number[] = []; let buffered = '', bytes = 0;
  while (ids.length < 31) {
    const next = await reader.read(); assert.equal(next.done, false, 'the replay must stay connected');
    bytes += next.value!.length; buffered += decoder.decode(next.value, { stream: true }); let end: number;
    while ((end = buffered.indexOf('\n\n')) >= 0) {
      const frame = buffered.slice(0, end); buffered = buffered.slice(end + 2);
      const id = /^id: (\d+)$/m.exec(frame); if (id) ids.push(Number(id[1]));
    }
  }
  stop.abort(); await reader.cancel().catch(() => {});
  assert.ok(bytes > 2_000_000); assert.deepEqual(ids, Array.from({ length: 31 }, (_, i) => i + 1));
});

test('direct chat rejects a truncated provider stream without returning partial answer or raw errors', async t => {
  const { root, config } = await tempConfig(); await fs.mkdir(path.dirname(config.nvidiaSecret), { recursive: true }); await fs.writeFile(config.nvidiaSecret, 'fixture-key');
  const providerRequest = (async () => new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch;
  const app = await createServer(config, { recover: false, providerRequest }); await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }); });
  const response = await fetch(`http://127.0.0.1:${(app.server.address() as { port: number }).port}/api/chat`, { method: 'POST', headers: { authorization: `Bearer ${app.uiToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'hello' }) });
  assert.equal(response.status, 502); const body = await response.json(); assert.match(body.error, /without a complete generation/); assert.equal(body.answer, undefined);
});
