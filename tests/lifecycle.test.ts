import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Store } from '../src/store.ts';
import { tempConfig } from './helpers.ts';

const lifecycle = async () => import('../src/' + 'lifecycle.ts').catch(() => ({} as any));
test('operation admission shares an in-flight result and reserves before asynchronous loading', async () => {
  const module = await lifecycle(); assert.equal(typeof module.OperationAdmission, 'function', 'operation admission is required');
  const admission = new module.OperationAdmission(); let release!: () => void, calls = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const first = admission.run('publish:run-1', async () => { calls++; await held; return 42; });
  assert.equal(admission.busy, true); assert.equal(admission.activeKey, 'publish:run-1');
  const duplicate = admission.run('publish:run-1', async () => { calls++; return 99; });
  assert.equal(first, duplicate); await assert.rejects(admission.run('repair', async () => 1), /active|busy/i);
  release(); assert.deepEqual(await Promise.all([first, duplicate]), [42, 42]); assert.equal(calls, 1); assert.equal(admission.busy, false);
});
test('failed operation loading releases admission for the next request', async () => {
  const module = await lifecycle(); assert.equal(typeof module.OperationAdmission, 'function', 'operation admission is required');
  const admission = new module.OperationAdmission(); await assert.rejects(admission.run('publish:missing', async () => { throw new Error('missing manifest'); }), /missing manifest/);
  assert.equal(await admission.run('repair', async () => 'started'), 'started');
});
test('publication identity remains bound to original destination and author after configuration changes', async t => {
  const module = await lifecycle(); assert.equal(typeof module.bindPublicationIdentity, 'function', 'publication identity binding is required');
  const {root,config}=await tempConfig();t.after(()=>fs.rm(root,{recursive:true,force:true}));config.fork='original/rtk';
  const run=await new Store(config.stateDir).create({repo:'/fixture',issue:'https://github.com/rtk-ai/rtk/issues/1'});run.branch='fix/fixture';
  const first=module.bindPublicationIdentity(run,config);config.fork='changed/rtk';config.gitEmail='changed@example.invalid';
  const second=module.bindPublicationIdentity(run,config);assert.deepEqual(second,first);assert.equal(second.fork,'original/rtk');assert.equal(second.author.email,'test@example.invalid');
  assert.equal(Object.isFrozen(second),true);assert.equal(Object.isFrozen(second.author),true);
});
test('effective configuration snapshot copies operational settings without credentials or secret locations', async t => {
  const module = await lifecycle(); assert.equal(typeof module.captureRunConfiguration, 'function', 'run configuration snapshot is required');
  const {root,config}=await tempConfig();t.after(()=>fs.rm(root,{recursive:true,force:true}));config.bridgeToken='private-bridge-token';config.githubSecret='/private/github-credential';config.nvidiaSecret='/private/model-credential';
  const captured=module.captureRunConfiguration(config);config.profile.upstream='changed/repository';
  assert.equal(captured.profile.upstream,'rtk-ai/rtk');assert.equal(captured.model,config.model);
  assert.doesNotMatch(JSON.stringify(captured),/private-bridge-token|private\/github-credential|private\/model-credential|githubSecret|nvidiaSecret|bridgeToken/);
});
