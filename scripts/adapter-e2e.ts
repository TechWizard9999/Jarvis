/** Tests the REAL OpenCode container/custom tools against a local scripted provider; no NVIDIA calls. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';
import { Agent } from '../src/agent.ts';
import { createServer } from '../src/server.ts';
import { atomicJson } from '../src/store.ts';
import { original } from '../tests/helpers.ts';

const root=path.join(process.cwd(),'state','adapter-integration',randomBytes(5).toString('hex'));
const config=loadConfig({...process.env,BUGFIX_PROJECT_DIR:process.cwd(),BUGFIX_STATE_DIR:root,BUGFIX_REPO_ROOT:path.join(root,'repos'),BUGFIX_MODEL:'custom-nvidia/bugfix-adapter-fixture',BUGFIX_BIND:'0.0.0.0',BUGFIX_NVIDIA_SECRET:path.join(root,'fixture-provider-key')});
await fs.mkdir(root,{recursive:true});await fs.writeFile(config.nvidiaSecret,'fixture-not-a-real-nvidia-key');
let requests=0;
const fakeProvider: typeof fetch = async (_url,init)=>{
  requests++;const body=JSON.parse(String(init?.body));const names=(body.tools||[]).map((t:any)=>t.function.name);
  assert.ok(names.every((name:string)=>name.startsWith('bugfix_')),'Native tool leaked into outbound payload');
  const hasResult=body.messages.some((m:any)=>m.role==='tool');
  const canRead=names.includes('bugfix_read_source');
  const delta=canRead && !hasResult ? {role:'assistant',tool_calls:[{index:0,id:'call_read_source',type:'function',function:{name:'bugfix_read_source',arguments:JSON.stringify({path:'src/lib.rs'})}}]} : {role:'assistant',content:canRead?JSON.stringify({adapter:'ok',evidenceRead:true}):'Adapter integration'};
  const completion={id:'fixture-'+requests,object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason:null}]};
  const finish={...completion,choices:[{index:0,delta:{},finish_reason:canRead&&!hasResult?'tool_calls':'stop'}],usage:{prompt_tokens:30,completion_tokens:20,total_tokens:50}};
  return new Response(`data: ${JSON.stringify(completion)}\n\ndata: ${JSON.stringify(finish)}\n\ndata: [DONE]\n\n`,{status:200,headers:{'content-type':'text/event-stream'}});
};
const app=await createServer(config,{recover:false,providerRequest:fakeProvider});
await new Promise<void>(resolve=>app.server.listen(0,'0.0.0.0',resolve));
const port=(app.server.address() as {port:number}).port;config.controllerUrl=`http://host.docker.internal:${port}`;
const run=await app.store.create({repo:'/adapter-fixture',issue:'https://github.com/rtk-ai/rtk/issues/1',retrieval:'text',mode:'evaluation',publish:false});
run.issue={number:1,title:'Adapter test',url:run.input.issue,body:'Read the fixture source.'};run.stage='discovery';
const source=path.join(app.store.dir(run.id),'source');await fs.mkdir(path.join(source,'src'),{recursive:true});await fs.writeFile(path.join(source,'src/lib.rs'),original);
const agent=new Agent(config,app.pipeline.docker,app.store,run),abort=new AbortController();
app.pipeline.contexts.set(run.id,{run,abort,agent,source,base:source,phase:'discovery',queue:Promise.resolve()});
try{
  const exists=await app.pipeline.docker.command(['network','inspect',config.dockerNetwork]);if(exists.code)await app.pipeline.docker.command(['network','create',config.dockerNetwork]);
  await agent.start(abort.signal);
  const answer=await agent.ask('ADAPTER_INTEGRATION: Use bugfix_read_source to read src/lib.rs, then return only {"adapter":"ok","evidenceRead":true}.',AbortSignal.timeout(90000));
  assert.equal(answer.adapter,'ok');assert.equal(answer.evidenceRead,true);
  const events=await app.store.events(run.id);assert.ok(events.some(e=>e.kind==='result'&&(e.data as any)?.tool==='read_source'));
  assert.ok(events.some(e=>e.kind==='model_request'));
  await atomicJson(path.join(process.cwd(),'state','adapter-results.json'),{testedAt:new Date().toISOString(),outcome:'passed',provider:'local scripted SSE (no NVIDIA calls)',opencodeImage:await app.pipeline.docker.imageId(config.agentImage),requests,toolReadExecuted:true});
  console.log('PASS: real OpenCode server, generated config, custom tool call, controller bridge, outbound allowlist, streamed completion and final JSON.');
}finally{
  await agent.stop();await app.pipeline.docker.cleanup(run);app.pipeline.contexts.delete(run.id);app.server.closeAllConnections();await new Promise<void>(resolve=>app.server.close(()=>resolve()));
}
