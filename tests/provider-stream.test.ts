import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from '../src/server.ts';
import { tempConfig } from './helpers.ts';

const model = 'nvidia/nemotron-3-ultra-550b-a55b';
const unsupported = 'ValueError: thinking_token_budget is not yet supported by the V2 model runner. Run vLLM with VLLM_USE_V2_MODEL_RUNNER=0 to use thinking_token_budget.';
const error = { error: { code: 500, type: 'server_error', message: 'Internal server error; fixture-secret; PRIVATE PROMPT' } };
function stream(text: string, split = 1) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({start(controller) { for(let n=0;n<bytes.length;n+=split)controller.enqueue(bytes.slice(n,n+split));controller.close(); }}), {headers:{'content-type':'text/event-stream'}});
}
async function gateway(t: test.TestContext, respond: (body:any, call:number)=>Response) {
  const {root,config}=await tempConfig();config.model=`nim/${model}`;
  await fs.mkdir(path.dirname(config.nvidiaSecret),{recursive:true});await fs.writeFile(config.nvidiaSecret,'fixture-secret');
  const sent:any[]=[];const providerRequest=(async(_url:any,init:any)=>{const body=JSON.parse(init.body);sent.push(body);return respond(body,sent.length);}) as typeof fetch;
  const app=await createServer(config,{recover:false,providerRequest});await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{app.server.closeAllConnections();await new Promise<void>(resolve=>app.server.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true});});
  const run=await app.store.create({repo:'/repo',issue:'https://github.com/rtk-ai/rtk/issues/1'});
  const context:any={run,abort:new AbortController(),agent:{providerToken:'gw'},phase:'reproduction',queue:Promise.resolve()};app.pipeline.contexts.set(run.id,context);
  const ask=async(signal?:AbortSignal)=>{const response=await fetch(`http://127.0.0.1:${(app.server.address() as {port:number}).port}/provider/${run.id}/v1/chat/completions`,{method:'POST',signal,headers:{authorization:'Bearer gw','content-type':'application/json'},body:JSON.stringify({model,messages:[{role:'user',content:'PRIVATE PROMPT'}],stream:true})});const text=await response.text();return {status:response.status,text};};
  return {app,run,context,sent,ask};
}
const successful = () => stream('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[{"finish_reason":"stop"}],"usage":{"total_tokens":5}}\n\ndata: [DONE]\n\n');

test('HTTP 200 JSON error is a failed semantic generation with safe metadata, not completed usage',async t=>{
  const f=await gateway(t,()=>new Response(JSON.stringify({...error,usage:{total_tokens:9}}),{headers:{'content-type':'application/json'}}));
  assert.equal((await f.ask()).status,502);
  const record=f.run.modelRequests![0] as any;
  assert.equal(record.status,'failed');assert.equal(record.httpStatus,200);assert.equal(record.transportComplete,true);assert.equal(record.semanticComplete,false);assert.equal(record.usage,'partial');assert.equal(record.totalTokens,9);
  assert.equal(record.providerError.code,500);assert.equal(record.providerError.type,'server_error');assert.equal(record.providerError.message,'Model provider returned an internal error.');
  assert.equal(f.sent.length,1);assert.equal(f.context.providerFailure.kind,'provider_error');
  const events=await f.app.store.events(f.run.id);assert.equal(events.filter(e=>e.kind==='model_finished').length,0);assert.doesNotMatch(JSON.stringify(events),/fixture-secret|PRIVATE PROMPT/);
});

test('chunked CRLF multiline SSE error uses exact budget fallback only before meaningful output',async t=>{
  const f=await gateway(t,(_body,call)=>call===1?stream(`: keepalive\r\ndata: {"choices":[{"delta":{"role":"assistant"}}]}\r\n\r\nevent: error\r\ndata: {"error":\r\ndata: {"code":400,"message":${JSON.stringify(unsupported)}}}\r\n\r\n`):successful());
  const result=await f.ask();assert.equal(result.status,200);assert.match(result.text,/ok/);assert.doesNotMatch(result.text,/thinking_token_budget/);
  assert.equal(f.sent.length,2);assert.equal(f.sent[0].reasoning_budget,16384);assert.equal(f.sent[1].reasoning_budget,undefined);
  const record=f.run.modelRequests![0] as any;assert.equal(record.status,'completed');assert.equal(record.parameterOmissions[0].source,'provider_rejection');assert.equal(record.answerReserve,'unavailable');
  await f.ask();assert.equal(f.sent[2].reasoning_budget,undefined,'only this endpoint/model controller cache omits the unsupported budget');
});

test('generic HTTP 200 streamed 500 is failed and never deletes parameters or replays',async t=>{
  const f=await gateway(t,()=>stream(`data: ${JSON.stringify(error)}\n\ndata: [DONE]\n\n`));
  const result=await f.ask();assert.equal(result.status,502);assert.equal(f.sent.length,1);assert.equal(f.sent[0].reasoning_budget,16384);
  const record=f.run.modelRequests![0] as any;assert.equal(record.status,'failed');assert.equal(record.parameterOmissions,undefined);assert.equal(record.outputDelivered,false);assert.equal(record.semanticComplete,false);assert.equal(record.transportComplete,false,'gateway stops reading after a structured stream error');assert.doesNotMatch(result.text,/fixture-secret|PRIVATE PROMPT/);
});

for(const [name,delta] of [['reasoning',{reasoning_content:'private thought'}],['content',{content:'partly answered'}],['tool_call',{tool_calls:[{index:0,id:'x',type:'function',function:{name:'read_source',arguments:'{'}}]}]] as const) test(`an exact budget error after ${name} is never transparently replayed`,async t=>{
  const f=await gateway(t,()=>stream(`data: ${JSON.stringify({choices:[{delta}]})}\n\ndata: ${JSON.stringify({error:{code:400,message:unsupported}})}\n\n`));
  const result=await f.ask();assert.equal(result.status,200);assert.equal(f.sent.length,1);assert.equal(f.sent[0].reasoning_budget,16384);
  const record=f.run.modelRequests![0] as any;assert.equal(record.status,'failed');assert.equal(record.outputDelivered,true);assert.equal(record.semanticComplete,false);assert.equal(record.parameterOmissions,undefined);assert.equal(record.providerError.meaningfulOutput,true);assert.doesNotMatch(result.text,/thinking_token_budget/);
});

test('SSE UTF8 CRLF multiline parsing preserves content and observes finish and usage',async t=>{
  const f=await gateway(t,()=>stream('data: {"choices":[{"delta":{"content":"café"}}]}\r\n\r\ndata: {"choices":[{"finish_reason":"stop"}],\r\ndata: "usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15}}\r\n\r\ndata: [DONE]\r\n\r\n'));
  const result=await f.ask();assert.match(result.text,/café/);
  const record=f.run.modelRequests![0] as any;assert.equal(record.status,'completed');assert.equal(record.transportComplete,false,'protocol DONE cancels the reader before physical EOF');assert.equal(record.semanticComplete,true);assert.equal(record.usage,'complete');assert.equal(record.totalTokens,15);assert.equal(record.finishReason,'stop');
});

test('clean transport EOF without a terminal SSE frame is interrupted rather than a completed answer',async t=>{
  const f=await gateway(t,()=>stream('data: {"choices":[{"delta":{"content":"incomplete answer"}}]}\n\n'));
  await assert.rejects(f.ask());
  const record=f.run.modelRequests![0] as any;assert.equal(record.status,'interrupted');assert.equal(record.transportComplete,true);assert.equal(record.semanticComplete,false);assert.equal(record.providerError.kind,'stream_interrupted');assert.equal(f.sent.length,1);
});

test('repeated same provider failures block OpenCode internal retries before another outbound request',async t=>{
  const f=await gateway(t,()=>stream(`data: ${JSON.stringify(error)}\n\n`));
  for(let n=0;n<3;n++)assert.equal((await f.ask()).status,502);
  assert.equal(f.context.providerFailure.circuitOpen,true);assert.equal(f.context.providerFailure.consecutiveFailures,3);
  const blocked=await f.ask();assert.equal(blocked.status,409);assert.equal(f.sent.length,3);assert.match(blocked.text,/provider.*paused/i);
});

test('a usable successful generation resets consecutive failure health',async t=>{
  const f=await gateway(t,(_body,call)=>call===3?successful():stream(`data: ${JSON.stringify(error)}\n\n`));
  await f.ask();await f.ask();await f.ask();assert.equal(f.context.providerFailure,undefined);
  await f.ask();assert.equal(f.context.providerFailure.consecutiveFailures,1);assert.equal(f.context.providerFailure.circuitOpen,false);
});

test('a provider finish_reason error cannot masquerade as semantic success',async t=>{
  const f=await gateway(t,()=>stream('data: {"choices":[{"finish_reason":"error"}]}\n\ndata: [DONE]\n\n'));
  assert.equal((await f.ask()).status,502);assert.equal(f.run.modelRequests![0].status,'failed');assert.equal(f.context.providerFailure.kind,'provider_error');
});

test('HTTP error status remains invalid_request even when its body is not JSON',async t=>{
  const f=await gateway(t,()=>new Response('invalid parameters; fixture-secret; PRIVATE PROMPT',{status:400,headers:{'content-type':'text/plain'}}));
  assert.equal((await f.ask()).status,400);assert.equal(f.context.providerFailure.kind,'invalid_request');assert.equal(f.context.providerFailure.retryable,false);assert.equal(f.context.providerFailure.circuitOpen,true);
});

test('an SSE error event without a data payload is still a semantic failure',async t=>{
  const f=await gateway(t,()=>stream('event: error\n\ndata: [DONE]\n\n'));
  assert.equal((await f.ask()).status,502);assert.equal(f.run.modelRequests![0].status,'failed');
});

for(const format of ['json','sse'] as const)test(`top-level known ${format} provider error cannot be a completed generation`,async t=>{
  const value={message:'Internal server error; fixture-secret; PRIVATE PROMPT',type:'internal_server_error',code:500};
  const f=await gateway(t,()=>format==='sse'?stream(`data: ${JSON.stringify(value)}\n\ndata: [DONE]\n\n`):new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}}));
  const result=await f.ask();assert.equal(result.status,502);const record=f.run.modelRequests![0] as any;assert.equal(record.status,'failed');assert.equal(record.semanticComplete,false);assert.equal(record.providerError.code,500);assert.doesNotMatch(JSON.stringify(await f.app.store.events(f.run.id)),/fixture-secret|PRIVATE PROMPT/);assert.doesNotMatch(result.text,/fixture-secret|PRIVATE PROMPT/);
});

test('ordinary assistant text containing error-shaped JSON is not a provider failure',async t=>{
  const value={message:'Internal server error',type:'internal_server_error',code:500};
  const f=await gateway(t,()=>stream(`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify(value)}}]})}\n\ndata: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`));
  assert.equal((await f.ask()).status,200);assert.equal(f.run.modelRequests![0].status,'completed');assert.equal(f.context.providerFailure,undefined);
});

for(const mode of ['open','error-after-done'] as const)test(`valid DONE finishes and cancels ${mode} upstream without awaiting EOF`,async t=>{
  let cancelled=false;let timer:ReturnType<typeof setTimeout>|undefined;
  const bytes=new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[{"finish_reason":"stop"}],"usage":{"total_tokens":5}}\n\ndata: [DONE]\n\n');
  const f=await gateway(t,()=>new Response(new ReadableStream({start(controller){controller.enqueue(bytes);if(mode==='error-after-done')timer=setTimeout(()=>controller.error(new Error('failure after terminal frame')),30);},cancel(){cancelled=true;if(timer)clearTimeout(timer);}}),{headers:{'content-type':'text/event-stream'}}));
  await assert.doesNotReject(async()=>{const result=await f.ask(AbortSignal.timeout(500));assert.equal(result.status,200);assert.match(result.text,/ok/);});
  const record=f.run.modelRequests![0] as any;assert.equal(record.status,'completed');assert.equal(record.semanticComplete,true);assert.equal(record.transportComplete,false);assert.equal(record.providerError,undefined);assert.equal(cancelled,true);
});

test('DONE without a generation frame cannot masquerade as a usable completed generation',async t=>{
  const f=await gateway(t,()=>stream('data: [DONE]\n\n'));
  assert.equal((await f.ask()).status,502);assert.equal(f.run.modelRequests![0].status,'failed');assert.equal((f.run.modelRequests![0] as any).semanticComplete,false);
});
