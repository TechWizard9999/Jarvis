import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Store } from '../src/store.ts';
import { tempConfig } from './helpers.ts';

const github = async () => import('../src/' + 'github.ts').catch(() => ({} as any));
async function fixture(t: { after(callback: () => Promise<unknown>): unknown }) {
  const {root,config}=await tempConfig();t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const run=await new Store(config.stateDir).create({repo:'/fixture',issue:'https://github.com/rtk-ai/rtk/issues/1'});return {run,config};
}
test('GitHub issue failures distinguish permanent authentication and permission failures from retryable transport errors', async t => {
  const module=await github();assert.equal(typeof module.fetchGitHubIssue,'function','typed GitHub issue loading is required');const {run,config}=await fixture(t);
  for (const [status,kind,retryable] of [[401,'authentication',false],[403,'permission',false],[404,'not_found',false],[410,'not_found',false],[500,'transient',true]] as const) {
    await assert.rejects(module.fetchGitHubIssue(run,config,undefined,async()=>new Response('{"message":"fixture"}',{status})),(error:any)=>error instanceof module.GitHubIssueError&&error.kind===kind&&error.status===status&&error.retryable===retryable);
  }
  await assert.rejects(module.fetchGitHubIssue(run,config,undefined,async()=>{throw new TypeError('connection reset');}),(error:any)=>error.kind==='transient'&&error.retryable===true);
});
test('GitHub rate limit retry time uses provider reset and Retry-After headers', async t => {
  const module=await github();assert.equal(typeof module.fetchGitHubIssue,'function','typed GitHub issue loading is required');const {run,config}=await fixture(t);
  const reset=Math.ceil(Date.now()/1000)+120;
  await assert.rejects(module.fetchGitHubIssue(run,config,undefined,async()=>new Response('{"message":"API rate limit exceeded"}',{status:403,headers:{'x-ratelimit-remaining':'0','x-ratelimit-reset':String(reset)}})),(error:any)=>error.kind==='rate_limit'&&error.retryable===true&&error.retryAt===reset*1000);
  const before=Date.now();
  await assert.rejects(module.fetchGitHubIssue(run,config,undefined,async()=>new Response('{}',{status:429,headers:{'retry-after':'60'}})),(error:any)=>error.kind==='rate_limit'&&error.retryAt>=before+60000&&error.retryAt<=Date.now()+60000);
});
test('GitHub cancellation reaches pending fetch and stops parsing or later work', async t => {
  const module=await github();assert.equal(typeof module.fetchGitHubIssue,'function','typed GitHub issue loading is required');const {run,config}=await fixture(t);
  const abort=new AbortController();let ready!:()=>void;const started=new Promise<void>(resolve=>{ready=resolve;});let requestSignal:AbortSignal|undefined;
  const loading=module.fetchGitHubIssue(run,config,abort.signal,async(_url:any,init:any)=>{requestSignal=init.signal;ready();return await new Promise<Response>((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}));});
  await started;abort.abort(new Error('cancel issue fetch'));await assert.rejects(loading,/cancel issue fetch/);assert.equal(requestSignal?.aborted,true);
  let requests=0;await assert.rejects(module.fetchGitHubIssue(run,config,abort.signal,async()=>{requests++;return new Response('{}');}),/cancel issue fetch/);assert.equal(requests,0);
});
test('GitHub issue success validates live state and returns bounded issue data', async t => {
  const module=await github();assert.equal(typeof module.fetchGitHubIssue,'function','typed GitHub issue loading is required');const {run,config}=await fixture(t);
  const loaded=await module.fetchGitHubIssue(run,config,undefined,async()=>new Response(JSON.stringify({state:'open',title:'Issue title',body:'x'.repeat(41000)})));
  assert.deepEqual({number:loaded.number,url:loaded.url,title:loaded.title,length:loaded.body.length},{number:1,url:run.input.issue,title:'Issue title',length:40000});
  await assert.rejects(module.fetchGitHubIssue(run,config,undefined,async()=>new Response('{"state":"closed"}')),(error:any)=>error.kind==='invalid_issue'&&error.retryable===false);
});
