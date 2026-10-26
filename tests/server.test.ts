import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from '../src/server.ts';
import { tempConfig } from './helpers.ts';

test('model gateway retries 429s until answered, retries 5xx five times, and reports only answered usage', async t => {
  const {root,config}=await tempConfig();await fs.mkdir(path.dirname(config.nvidiaSecret),{recursive:true});await fs.writeFile(config.nvidiaSecret,'test-key');
  const statuses=[429,200,429,429,429,429,429,200,500,500,500,500,500,500];let calls=0;
  const providerRequest=(async()=>{const status=statuses[calls++];return new Response(status===200?JSON.stringify({choices:[],usage:{total_tokens:42}}):JSON.stringify({status}),{status,headers:{'content-type':'application/json','retry-after':'0'}});}) as unknown as typeof fetch;
  const app=await createServer(config,{recover:false,providerRequest});await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{app.server.closeAllConnections();await new Promise<void>(resolve=>app.server.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true});});
  const run=await app.store.create({repo:'/repo',issue:'https://github.com/rtk-ai/rtk/issues/1',mode:'live',retrieval:'text'} as any);
  app.pipeline.contexts.set(run.id,{run,abort:new AbortController(),agent:{providerToken:'gw'},phase:'reproduction',queue:Promise.resolve()} as any);
  const ask=()=>fetch(`http://127.0.0.1:${(app.server.address() as {port:number}).port}/provider/${run.id}/v1/chat/completions`,{method:'POST',headers:{authorization:'Bearer gw','content-type':'application/json'},body:JSON.stringify({model:'fixture-model',messages:[{role:'user',content:'hi'}]})});
  const ok=await ask();assert.equal(ok.status,200);await ok.text();assert.equal(calls,2);assert.equal(run.tokens,42);
  const retried=await ask();assert.equal(retried.status,200);await retried.text();assert.equal(calls,8);assert.equal(run.tokens,84);
  const failed=await ask();assert.equal(failed.status,500);await failed.text();assert.equal(calls,14);assert.equal(run.tokens,84);
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
    ()=>new Response(sse({choices:[{delta:{content:'<think>inline</think>\nDone.'},finish_reason:'stop'}]}),{status:200}),()=>new Response('{"detail":"model not found"}',{status:404})];
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
  const missing=await post({prompt:'x'});assert.equal(missing.status,502);assert.equal((await missing.json()).providerStatus,404);
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
