import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../src/store.ts';
import { tempConfig } from './helpers.ts';
const original='a'.repeat(40),current='b'.repeat(40);
async function fixture(t:any){const {root,config}=await tempConfig();t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(path.dirname(config.githubSecret),{recursive:true});await fs.writeFile(config.githubSecret,'fixture-token');const run=await new Store(config.stateDir).create({repo:'/fixture',issue:'https://github.com/rtk-ai/rtk/issues/1'});run.verifiedCommit=original;run.publication={state:'created',fork:'fixture/fork',head:'fix',base:'main',url:'https://github.com/rtk-ai/rtk/pull/123',originalVerifiedCommit:original};return {run,config};}

test('publication inspection binds original verification and current PR review/CI/explicit CLA state',async t=>{
 const {run,config}=await fixture(t);const called:string[]=[];
 const fetcher=(async(input:any,options:any)=>{const url=String(input);called.push(url);assert.equal(options.method,'GET');assert.equal(options.headers.authorization,'Bearer fixture-token');assert.ok(url.startsWith('https://api.github.com/repos/rtk-ai/rtk/'));
 const value=url.includes('/reviews')?[{id:1,user:{login:'reviewer'},state:'APPROVED',submitted_at:'2026-10-19T00:00:00Z'},{id:2,user:{login:'reviewer'},state:'CHANGES_REQUESTED',submitted_at:'2026-10-20T00:00:00Z'}]:url.includes('/check-runs')?{check_runs:[{id:1,name:'Rust tests',status:'completed',conclusion:'success'},{id:2,name:'CLA Assistant',status:'completed',conclusion:'failure'}]}:url.includes('/status')?{state:'success',statuses:[{context:'build',state:'success'}]}:{head:{sha:current},draft:true};return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});}) as typeof fetch;
 const module=await import('../src/publication.ts').catch(()=>({})) as any;assert.equal(typeof module.inspectPublication,'function','read-only publication reconciliation is available');
 const result=await module.inspectPublication(run,config,fetcher);
 assert.equal(result.originalVerifiedCommit,original);assert.equal(result.currentHead,current);assert.equal(result.changedSinceVerification,true);assert.equal(result.reviewState,'changes_requested');assert.equal(result.ciState,'failure');assert.equal(result.claState,'failure');assert.equal(called.length,4);assert.equal(run.verifiedCommit,original);assert.equal(run.publication?.currentHead,undefined,'inspection returns a separate observation');assert.doesNotMatch(JSON.stringify(result),/fixture-token/);
});

test('missing or unavailable checks and generic license jobs cannot imply CLA success',async t=>{
 const {run,config}=await fixture(t);const fetcher=(async(input:any)=>{const url=String(input);return new Response(JSON.stringify(url.includes('/reviews')?[]:url.includes('/check-runs')?{check_runs:[{name:'license policy',status:'completed',conclusion:'success'}]}:url.includes('/status')?{state:'pending',statuses:[]}:{head:{sha:original}}),{headers:{'content-type':'application/json'}});}) as typeof fetch;
 const module=await import('../src/publication.ts').catch(()=>({})) as any;assert.equal(typeof module.inspectPublication,'function');const result=await module.inspectPublication(run,config,fetcher);assert.equal(result.claState,'unknown');assert.equal(result.ciState,'success');assert.equal(result.reviewState,'pending');assert.equal(result.changedSinceVerification,false);
 const partial=(async(input:any)=>String(input).includes('/check-runs')?new Response('{}',{status:403}):fetcher(input)) as typeof fetch;const missing=await module.inspectPublication(run,config,partial);assert.equal(missing.ciState,'unknown');assert.equal(missing.claState,'unknown');assert.ok(missing.inspectionErrors.length);
});

test('publication inspection refuses a different repository or endpoint before sending credentials',async t=>{
 const {run,config}=await fixture(t);let called=false;const fetcher=(async()=>{called=true;throw new Error('not reached');}) as typeof fetch;const module=await import('../src/publication.ts').catch(()=>({})) as any;assert.equal(typeof module.inspectPublication,'function');
 for(const url of ['https://evil.example/rtk-ai/rtk/pull/1','https://github.com/another/repo/pull/1','https://github.com/rtk-ai/rtk/pull/1?token=secret']){run.publication!.url=url;await assert.rejects(module.inspectPublication(run,config,fetcher),/recorded upstream|publication URL/);}assert.equal(called,false);
});
