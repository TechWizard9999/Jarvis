import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Repository } from '../src/git.ts';
import { Store } from '../src/store.ts';
import { copySource } from '../src/files.ts';
import { tempConfig, fixtureRepo, withRegression, original } from './helpers.ts';
test('worktree preserves original checkout, hides Git metadata from source and exports added files', async t => {
  const { root, config } = await tempConfig(); t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const repo = await fixtureRepo(config.repoRoot), store = new Store(config.stateDir), git = new Repository(config);
  const run = await store.create({repo,issue:'https://github.com/rtk-ai/rtk/issues/1',mode:'evaluation',publish:false});run.issue={number:1,url:run.input.issue,title:'fixture',body:'fixture'};
  const source=path.join(store.dir(run.id),'source');await git.preflight(run,source);
  await assert.rejects(fs.stat(path.join(source,'.git')));
  await fs.writeFile(path.join(source,'src/lib.rs'),withRegression);await fs.mkdir(path.join(source,'tests/fixtures'),{recursive:true});await fs.writeFile(path.join(source,'tests/fixtures/new.txt'),'error: fixture\n');
  const diff=await git.diff(run,source);assert.match(diff,/tests\/fixtures\/new.txt/);assert.match(diff,/bugfix_issue_1/);
  assert.equal(await fs.readFile(path.join(repo,'src/lib.rs'),'utf8'),original);
  run.summary = { title: 'fix: verified fixture repair', explanation: 'Preserve the verified regression behavior.' };
  run.verifiedTree=await git.tree(run,source);await git.commit(run,source,path.join(store.dir(run.id),'verified.bundle'));assert.ok(run.verifiedCommit);
  const commit = await git.git(run.worktree!, ['log', '-1', '--format=%B']);
  assert.equal(commit.code, 0);
  assert.match(commit.stdout, /^fix: verified fixture repair\n/m);
  assert.match(commit.stdout, /Refs https:\/\/github\.com\/rtk-ai\/rtk\/issues\/1/);
  assert.match(commit.stdout, /Signed-off-by: Test Author <test@example\.invalid>/);
});
test('dirty trees are rejected before creating a worktree', async t => {
  const {root,config}=await tempConfig();t.after(()=>fs.rm(root,{recursive:true,force:true}));const repo=await fixtureRepo(config.repoRoot);
  await fs.writeFile(path.join(repo,'uncommitted.txt'),'do not touch');const store=new Store(config.stateDir),run=await store.create({repo,issue:'https://github.com/rtk-ai/rtk/issues/1'});
  await assert.rejects(new Repository(config).preflight(run,path.join(root,'src')),/local changes/);
});
test('source-only changes export correctly when the repository has no tests directory', async t => {
  const {root,config}=await tempConfig();t.after(()=>fs.rm(root,{recursive:true,force:true}));const repo=await fixtureRepo(config.repoRoot),store=new Store(config.stateDir),git=new Repository(config);
  const run=await store.create({repo,issue:'https://github.com/rtk-ai/rtk/issues/1',mode:'evaluation'});run.issue={number:1,url:run.input.issue,title:'fixture',body:'fixture'};
  const source=path.join(store.dir(run.id),'source');await git.preflight(run,source);await fs.writeFile(path.join(source,'src/lib.rs'),withRegression);
  assert.match(await git.diff(run,source),/bugfix_issue_1/);
});
test('inherited Git overrides cannot redirect the repository or replace the recorded commit identity', async t => {
  const {root,config}=await tempConfig();t.after(()=>fs.rm(root,{recursive:true,force:true}));const repo=await fixtureRepo(config.repoRoot),store=new Store(config.stateDir),git=new Repository(config);
  const run=await store.create({repo,issue:'https://github.com/rtk-ai/rtk/issues/1',mode:'evaluation'});run.issue={number:1,url:run.input.issue,title:'fixture',body:'fixture'};
  const source=path.join(store.dir(run.id),'source'); await git.preflight(run,source); await fs.writeFile(path.join(source,'src/lib.rs'),withRegression);
  (run as any).publicationIdentity = { fork:'personal/rtk',upstream:'rtk-ai/rtk',base:'develop',branch:run.branch,author:{name:'Recorded Author',email:'recorded@example.invalid'},committer:{name:'Recorded Committer',email:'committer@example.invalid'} };
  const overrides = { GIT_DIR: '/missing/repository', GIT_WORK_TREE: '/missing/tree', GIT_INDEX_FILE: path.join(root, 'wrong-index'), GIT_AUTHOR_NAME: 'Injected', GIT_AUTHOR_EMAIL: 'injected@example.invalid', GIT_COMMITTER_NAME: 'Injected', GIT_COMMITTER_EMAIL: 'injected@example.invalid', GIT_CONFIG_COUNT:'1', GIT_CONFIG_KEY_0:'user.email', GIT_CONFIG_VALUE_0:'other@example.invalid' };
  const originalEnv = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]])); Object.assign(process.env, overrides);
  t.after(() => { for (const [key,value] of Object.entries(originalEnv)) if (value === undefined) delete process.env[key]; else process.env[key]=value; });
  run.verifiedTree=await git.tree(run,source); const bundle=path.join(store.dir(run.id),'verified.bundle'); await git.commit(run,source,bundle);
  const metadata=await git.git(run.worktree!,['show','-s','--format=%an%n%ae%n%cn%n%ce%n%P%n%B','HEAD']);
  assert.deepEqual(metadata.stdout.split('\n').slice(0,4),['Recorded Author','recorded@example.invalid','Recorded Committer','committer@example.invalid']);
  assert.equal(metadata.stdout.split('\n')[4],run.baseSha); assert.match(metadata.stdout,/Signed-off-by: Recorded Author <recorded@example.invalid>/);
  assert.equal((run as any).commitProvenance.tree,run.verifiedTree); assert.deepEqual((run as any).commitProvenance.parents,[run.baseSha]);
});
test('cancelled preflight performs no Git command and creates no worktree', async t => {
  const {root,config}=await tempConfig();t.after(()=>fs.rm(root,{recursive:true,force:true}));const repo=await fixtureRepo(config.repoRoot),store=new Store(config.stateDir),git=new Repository(config);
  const run=await store.create({repo,issue:'https://github.com/rtk-ai/rtk/issues/1',mode:'evaluation'});run.issue={number:1,url:run.input.issue,title:'fixture',body:'fixture'};
  const abort=new AbortController();abort.abort(new Error('cancel preflight'));const source=path.join(store.dir(run.id),'source');
  await assert.rejects((git.preflight as any)(run,source,abort.signal),/cancel preflight/);assert.equal(run.worktree,undefined);await assert.rejects(fs.stat(source),{code:'ENOENT'});
});
