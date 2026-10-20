import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Pipeline } from '../src/pipeline.ts';
import { tempConfig } from './helpers.ts';

test('duplicate publication requests share one admitted operation', async t => {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pipeline = new Pipeline(config);
  const run = await pipeline.store.create({ repo: '/repo', issue: 'https://github.com/rtk-ai/rtk/issues/1' });
  run.outcome = 'verified_unpublished'; run.verifiedCommit = 'a'.repeat(40); await pipeline.store.save(run);
  let publishes = 0, release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  pipeline.publish = async () => { publishes++; await pending; };
  const a = pipeline.retryPublication(run.id), b = pipeline.retryPublication(run.id);
  await new Promise(resolve => setTimeout(resolve, 25)); release();
  await Promise.all([a, b]);
  assert.equal(publishes, 1);
});

test('cancellation during issue loading prevents later repository preparation', async t => {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pipeline = new Pipeline(config);
  let release!: () => void, started!: () => void, preflights = 0;
  const loading = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  pipeline.agentFactory = () => ({ toolToken: '', providerToken: '', preflight: async () => {}, start: async () => {}, stop: async () => {}, ask: async () => ({}) });
  pipeline.issueLoader = async () => { started(); await loading; return { number: 1, url: 'https://github.com/rtk-ai/rtk/issues/1', title: 'Fixture', body: 'Fixture expected behavior.' }; };
  pipeline.repository.preflight = async () => { preflights++; throw new Error('Preparation must not start'); };
  pipeline.docker.cleanup = async () => {};
  const run = await pipeline.store.create({ repo: '/repo', issue: 'https://github.com/rtk-ai/rtk/issues/1', mode: 'evaluation' });
  const execution = pipeline.execute(run); await entered;
  const cancellation = pipeline.cancel(run.id); release();
  await Promise.all([execution, cancellation]);
  assert.equal(preflights, 0);
  assert.equal(run.outcome, 'cancelled');
});

test('simultaneous PR inspections share one observation instead of overwriting newer state', async t => {
  const {root,config}=await tempConfig();t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const pipeline=new Pipeline(config),run=await pipeline.store.create({repo:'/repo',issue:'https://github.com/rtk-ai/rtk/issues/1'});
  run.stage='complete';run.publication={state:'created',fork:'test/rtk',head:'fixture',base:'develop',url:'https://github.com/rtk-ai/rtk/pull/2'};await pipeline.store.save(run);
  let calls=0,release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});
  pipeline.publicationInspector=async()=>{calls++;await pending;return {currentHead:'b'.repeat(40),changedSinceVerification:true,reviewState:'pending',ciState:'pending',claState:'unknown',inspectedAt:new Date().toISOString()};};
  const a=pipeline.refreshPublication(run.id),b=pipeline.refreshPublication(run.id);
  await new Promise(resolve=>setTimeout(resolve,20));release();await Promise.all([a,b]);
  assert.equal(calls,1);assert.equal((await pipeline.store.get(run.id)).publication?.changedSinceVerification,true);
});
