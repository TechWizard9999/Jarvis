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
