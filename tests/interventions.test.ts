import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pipeline } from '../src/pipeline.ts';
import { createServer } from '../src/server.ts';
import { tempConfig } from './helpers.ts';
import { exec } from '../src/process.ts';

async function fixture(t:any){const {root,config}=await tempConfig();t.after(()=>fs.rm(root,{recursive:true,force:true}));const pipeline=new Pipeline(config);const run=await pipeline.store.create({repo:'/fixture',issue:'https://github.com/rtk-ai/rtk/issues/1'});return {root,config,pipeline,run};}

test('active intervention notes share live run state and preserve simultaneous accepted actions',async t=>{
 const {pipeline,run}=await fixture(t);run.stage='patching';run.tokens=41;pipeline.contexts.set(run.id,{run,abort:new AbortController()} as any);
 const record=(pipeline as any).recordIntervention;assert.equal(typeof record,'function','operator intervention recording is available');
 const first=record.call(pipeline,run.id,'guidance','Clarified the expected scalar output.');run.tokens=42;await pipeline.store.save(run);
 const second=record.call(pipeline,run.id,'harness_fix','Restored the local test runner.');await Promise.all([first,second]);
 const saved=await pipeline.store.get(run.id);assert.equal(saved.tokens,42);assert.deepEqual((saved as any).interventions.map((note:any)=>note.kind),['guidance','harness_fix']);assert.equal((run as any).interventions.length,2);
 const events=await pipeline.store.events(run.id);assert.equal(events.filter(event=>event.source==='operator'&&event.kind==='intervention').length,2);
});

test('completed intervention notes cannot coalesce distinct messages or overwrite current provenance',async t=>{
 const {pipeline,run}=await fixture(t);run.stage='complete';run.outcome='verified_patch';run.verifiedCommit='a'.repeat(40);await pipeline.store.save(run);
 const record=(pipeline as any).recordIntervention;assert.equal(typeof record,'function');
 const original=pipeline.store.get.bind(pipeline.store);let release!:()=>void,entered!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});let delayed=true;
 pipeline.store.get=async id=>{if(delayed){delayed=false;entered();await wait;}return original(id);};
 const first=record.call(pipeline,run.id,'manual_fix','Corrected descriptor handling after review.');await started;
 await assert.rejects(record.call(pipeline,run.id,'review','Reviewed the corrected behavior.'),/active|busy|operation/i);
 release();await first;await record.call(pipeline,run.id,'review','Reviewed the corrected behavior.');
 const saved=await pipeline.store.get(run.id);assert.equal(saved.verifiedCommit,'a'.repeat(40));assert.deepEqual((saved as any).interventions.map((note:any)=>note.message),['Corrected descriptor handling after review.','Reviewed the corrected behavior.']);
 const report=await fs.readFile(`${pipeline.store.dir(run.id)}/report.md`,'utf8');assert.match(report,/Operator interventions: 2/);assert.match(report,/manual_fix/);assert.match(report,/Reviewed the corrected behavior/);assert.match(report,/operator assistance/i);
});

test('intervention validation rejects malformed notes and credentials before persistence',async t=>{
 const {pipeline,run}=await fixture(t);run.stage='complete';await pipeline.store.save(run);const record=(pipeline as any).recordIntervention;assert.equal(typeof record,'function');
 for(const [kind,message] of [['other','A clear summary'],['guidance',''],['review',7],['manual_fix','x'.repeat(4001)],['guidance','line\0control'],['review','ghp_abcdefghijklmnopqrstuvwxyz0123456789'],['harness_fix','password=hunter2'],['guidance','Authorization: Bearer fixture-token-value']])await assert.rejects(record.call(pipeline,run.id,kind,message));
 assert.equal((await pipeline.store.get(run.id) as any).interventions,undefined);assert.equal((await pipeline.store.events(run.id)).length,0);
});

test('authenticated intervention route and note CLI record local operator actions',async t=>{
 const {root,config}=await tempConfig();const app=await createServer(config,{recover:false});await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(async()=>{app.server.closeAllConnections();await new Promise<void>(resolve=>app.server.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true});});
 const run=await app.store.create({repo:'/fixture',issue:'https://github.com/rtk-ai/rtk/issues/1'});run.stage='complete';await app.store.save(run);const port=(app.server.address() as {port:number}).port,base=`http://127.0.0.1:${port}/api/runs/${run.id}/interventions`;
 const response=await fetch(base,{method:'POST',headers:{authorization:`Bearer ${app.uiToken}`,'content-type':'application/json'},body:JSON.stringify({kind:'guidance',message:'Confirmed that text output is required.'})});assert.equal(response.status,200);
 const cli=await exec(process.execPath,[fileURLToPath(new URL('../src/cli.ts',import.meta.url)),'note',run.id,'--kind','review','--message','Reviewed local validation logs.'],{env:{...process.env,BUGFIX_PROJECT_DIR:root,BUGFIX_STATE_DIR:config.stateDir,BUGFIX_PORT:String(port),BUGFIX_REPO_ROOT:config.repoRoot},timeoutMs:10000});assert.equal(cli.code,0,cli.stderr);
 const saved=await app.store.get(run.id);assert.equal((saved as any).interventions.length,2);assert.equal((saved as any).interventions[1].kind,'review');assert.match((saved as any).interventions[1].time,/^\d{4}-\d{2}-\d{2}T/);
});
