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
  run.verifiedTree=await git.tree(run,source);await git.commit(run,source,path.join(store.dir(run.id),'verified.bundle'));assert.ok(run.verifiedCommit);
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
