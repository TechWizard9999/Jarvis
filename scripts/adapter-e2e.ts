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
const config=loadConfig({...process.env,BUGFIX_PROJECT_DIR:process.cwd(),BUGFIX_STATE_DIR:root,BUGFIX_REPO_ROOT:path.join(root,'repos'),BUGFIX_MODEL:'nim/nvidia/nemotron-3-ultra-550b-a55b',BUGFIX_BIND:'0.0.0.0',BUGFIX_NVIDIA_SECRET:path.join(root,'fixture-provider-key')});
await fs.mkdir(root,{recursive:true});await fs.writeFile(config.nvidiaSecret,'fixture-not-a-real-nvidia-key');
let requests=0, activeCase='discovery', streamErrorAttempts=0;
const observed: {case:string;phase:string;tools:string[];schemaArrayOnly?:boolean;maxTokens:number;reasoningBudget?:number;reasoningEffort?:string;thinking:boolean}[]=[];
const fakeProvider: typeof fetch = async (_url,init)=>{
  requests++;const body=JSON.parse(String(init?.body));const names=(body.tools||[]).map((t:any)=>t.function.name);
  assert.ok(names.every((name:string)=>name.startsWith('bugfix_')),'Native tool leaked into outbound payload');
  if(activeCase==='stream-error'){
    streamErrorAttempts++;
    return new Response('data: {"error":{"code":500,"type":"server_error","message":"Internal server error"}}\n\ndata: [DONE]\n\n',{status:200,headers:{'content-type':'text/event-stream'}});
  }
  const system=body.messages.filter((message:any)=>message.role==='system').map((message:any)=>typeof message.content==='string'?message.content:JSON.stringify(message.content)).join('\n');
  const phase=/Current phase: (discovery|review|candidate-review|reproduction|patching|describe|format|locked)/.exec(system)?.[1];
  if(phase){
    const readOnly=phase==='review'||phase==='discovery',replyOnly=phase==='format'||phase==='describe'||phase==='locked';
    assert.deepEqual([...names].sort(),replyOnly?[]:readOnly?['bugfix_read_source','bugfix_search_text']:phase==='candidate-review'?['bugfix_read_source','bugfix_run_check','bugfix_search_text']:['bugfix_apply_patch','bugfix_read_source','bugfix_replace_source','bugfix_run_check','bugfix_search_text']);
    if(readOnly)assert.doesNotMatch(system,/Add multiple|Run the trusted|confirm the intended assertion failure|Allowed editable roots|Allowed run_check IDs/);
    if(replyOnly)assert.doesNotMatch(system,/intended assertion|Allowed editable roots|Allowed run_check IDs|format-source/);
    const apply=(body.tools||[]).find((tool:any)=>tool.function.name==='bugfix_apply_patch');
    if(apply){
      assert.equal(apply.function.parameters.properties.edits.type,'array','OpenCode changed the edits schema');
      assert.ok(apply.function.parameters.required.includes('edits'));
      assert.doesNotMatch(JSON.stringify(apply.function.parameters.properties.edits),/"(?:anyOf|oneOf)"/);
    }
    const expected=replyOnly
      ? {output:2048,thinking:false,budget:undefined,effort:'none'}
      : phase==='discovery'
        ? {output:8192,thinking:true,budget:4096,effort:'medium'}
        : {output:24576,thinking:true,budget:16384,effort:'high'};
    assert.equal(body.model,'nvidia/nemotron-3-ultra-550b-a55b');
    assert.equal(body.max_tokens,expected.output,'Actual OpenCode request must use the trusted phase output cap');
    assert.equal(body.chat_template_kwargs?.enable_thinking,expected.thinking);
    assert.equal(body.reasoning_budget,expected.budget);
    assert.equal(body.reasoning_effort,expected.effort);
    observed.push({case:activeCase,phase,tools:names,schemaArrayOnly:apply?true:undefined,maxTokens:body.max_tokens,reasoningBudget:body.reasoning_budget,reasoningEffort:body.reasoning_effort,thinking:body.chat_template_kwargs.enable_thinking});
  }
  const lastUser=body.messages.findLastIndex((message:any)=>message.role==='user');
  const hasResult=body.messages.some((message:any,index:number)=>index>lastUser&&message.role==='tool');
  const canRead=names.includes('bugfix_read_source');
  const formatProse=activeCase==='format-retry'&&phase==='reproduction';
  const wantsRead=!!phase&&canRead&&!hasResult&&!formatProse;
  const delta=wantsRead?{role:'assistant',tool_calls:[{index:0,id:'call_read_source_'+requests,type:'function',function:{name:'bugfix_read_source',arguments:JSON.stringify({path:'src/lib.rs'})}}]}:{role:'assistant',content:phase?formatProse?'Prose requires a JSON-only retry.':JSON.stringify({adapter:'ok',phase,evidenceRead:canRead}):'Adapter integration'};
  const completion={id:'fixture-'+requests,object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason:null}]};
  const finish={...completion,choices:[{index:0,delta:{},finish_reason:wantsRead?'tool_calls':'stop'}],usage:{prompt_tokens:30,completion_tokens:20,total_tokens:50}};
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
  const activeConfig=await agent.request('/config');
  assert.deepEqual(activeConfig.provider.nim.models['nvidia/nemotron-3-ultra-550b-a55b'].limit,{context:262144,input:196608,output:24576});
  assert.equal(activeConfig.compaction.auto,true);assert.equal(activeConfig.compaction.prune,true);assert.equal(activeConfig.compaction.reserved,8192);
  for(const phase of ['discovery','review','reproduction','patching','candidate-review','describe'] as const){
    activeCase=phase;app.pipeline.contexts.get(run.id)!.phase=phase;
    const canRead=phase!=='describe';
    const answer=await agent.ask(`ADAPTER_INTEGRATION ${phase}: ${canRead?'Use bugfix_read_source to read src/lib.rs, then':'Use the verified evidence already in this conversation without tools.'} Return exactly {"adapter":"ok","phase":"${phase}","evidenceRead":${canRead}}.`,AbortSignal.timeout(90000),answer=>answer.adapter==='ok'&&answer.phase===phase,phase);
    assert.equal(answer.evidenceRead,canRead);assert.ok(observed.some(record=>record.case===phase&&record.phase===phase));
  }
  activeCase='format-retry';app.pipeline.contexts.get(run.id)!.phase='reproduction';
  const answer=await agent.ask('ADAPTER_INTEGRATION format retry: Return exactly {"adapter":"ok","phase":"format","evidenceRead":false}.',AbortSignal.timeout(90000),answer=>answer.adapter==='ok'&&answer.phase==='format','reproduction');
  assert.equal(answer.evidenceRead,false);assert.ok(observed.some(record=>record.case==='format-retry'&&record.phase==='format'&&record.tools.length===0));
  for(const phase of ['review','candidate-review'] as const){
    app.pipeline.contexts.get(run.id)!.phase=phase;
    await assert.rejects(app.pipeline.tool(run.id,'run_check',{check:'format-source'}),/disabled/i);
    await assert.rejects(app.pipeline.tool(run.id,'replace_source',{path:'src/lib.rs',before:original,after:'must not write'}),/read.only|edits are unavailable/i);
  }
  app.pipeline.contexts.get(run.id)!.phase='describe';
  await assert.rejects(app.pipeline.tool(run.id,'read_source',{path:'src/lib.rs'}),/locked/i);
  assert.equal(await fs.readFile(path.join(source,'src/lib.rs'),'utf8'),original);
  // Exercise the actual SDK retry path: an embedded error must never become a
  // successful generation, and the SDK must not keep sending upstream attempts.
  activeCase='stream-error';app.pipeline.contexts.get(run.id)!.phase='reproduction';
  const beforeErrors=run.modelRequests?.length||0;
  await assert.rejects(agent.ask('STREAM_ERROR_REGRESSION: Return exactly {"adapter":"ok"}.',AbortSignal.timeout(90000),answer=>answer.adapter==='ok','reproduction'),/OpenCode\/model error|provider|HTTP 409/i);
  assert.equal(streamErrorAttempts,3,'Repeated provider failures must open the circuit after three actual attempts');
  const failed=run.modelRequests!.slice(beforeErrors) as any[];
  assert.equal(failed.filter(record=>record.attempts>0).length,3);
  assert.ok(failed.filter(record=>record.attempts>0).every(record=>record.status==='failed'&&record.httpStatus===200&&record.providerError?.code===500&&record.semanticComplete===false),'HTTP 200 error streams must be recorded as semantic failures');
  assert.equal((app.pipeline.contexts.get(run.id) as any).providerFailure?.circuitOpen,true);
  const events=await app.store.events(run.id);assert.ok(events.some(e=>e.kind==='result'&&(e.data as any)?.tool==='read_source'));
  assert.ok(events.some(e=>e.kind==='model_request'));
  assert.equal(events.filter(event=>event.kind==='format_retry').length,1);
  assert.ok(!events.some(event=>event.kind==='model_finished'&&failed.some(record=>record.id===(event.data as any)?.requestId)),'Failed error streams must not emit model_finished');
  await atomicJson(path.join(process.cwd(),'state','adapter-results.json'),{testedAt:new Date().toISOString(),outcome:'passed',provider:'local scripted SSE (no NVIDIA calls)',opencodeImage:await app.pipeline.docker.imageId(config.agentImage),requests,toolReadExecuted:true,phaseContracts:observed,backendReviewGuards:true,embeddedStreamErrors:{attempts:streamErrorAttempts,circuitOpen:true,allFailed:true}});
  console.log('PASS: real OpenCode phase-specific tools, read bridge, disabled format retry, backend review guards, and embedded-stream-error circuit breaker.');
}finally{
  await agent.stop();await app.pipeline.docker.cleanup(run);app.pipeline.contexts.delete(run.id);app.server.closeAllConnections();await new Promise<void>(resolve=>app.server.close(()=>resolve()));
}
