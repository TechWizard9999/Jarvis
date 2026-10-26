/** Production publisher + real local Git push; GitHub CLI responses are explicitly mocked. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { exec, checked } from '../src/process.ts';
import { atomicJson } from '../src/store.ts';
import { loadConfig } from '../src/config.ts';

const project = process.cwd(), config = loadConfig();
const results = JSON.parse(await fs.readFile(path.join(project, 'state/integration-results.json'), 'utf8'));
const evidence = path.join(results.stateDir, 'runs', results.successfulRun);
const manifest = JSON.parse(await fs.readFile(path.join(evidence, 'manifest.json'), 'utf8'));
const root = path.join(project, 'state/publisher-integration', randomBytes(5).toString('hex'));
const artifacts = path.join(root, 'artifacts'), bin = path.join(root, 'bin'), remote = path.join(root, 'remote.git');
for (const directory of [artifacts, bin]) await fs.mkdir(directory, { recursive: true });
checked(await exec('git', ['init', '--bare', remote]), 'Create local publication test remote');
await fs.copyFile(path.join(evidence, 'verified.bundle'), path.join(artifacts, 'verified.bundle'));
await fs.writeFile(path.join(artifacts, 'report-pr.md'), 'Scripted publisher integration fixture. No real GitHub PR.\n');
const sameRepository = process.env.BUGFIX_PUBLISHER_CASE === 'same';
const input = { runId: manifest.id, upstream: 'example/another', fork: sameRepository ? 'example/another' : 'test-user/another', branch: manifest.branch, commit: manifest.verifiedCommit, tree: manifest.verifiedTree, issue: 42, base: 'main', title: 'fix(fixture): keep error lines in output' };
await atomicJson(path.join(artifacts, 'publication-input.json'), input);
await fs.writeFile(path.join(root, 'fixture-token'), 'fixture-not-a-real-github-token', { mode: 0o600 });
// This executable can only exist in the explicitly mounted test bin; production has the real gh.
await fs.writeFile(path.join(bin, 'gh'), `#!/usr/local/bin/node
const fs=require('node:fs');const a=process.argv.slice(2),p='/artifacts/mock-pr.json';
const input=JSON.parse(fs.readFileSync('/artifacts/publication-input.json','utf8'));
if(a.includes('--slurp'))process.exit(3); // production gh (Debian 2.23) has no --slurp
if(a[0]==='api'){
  const endpoint=a.find(v=>v.startsWith('repos/'));
  if(a[1]==='user')console.log(JSON.stringify({login:'test-user'}));
  else if(endpoint?.includes('/timeline?')){if(!a.includes('--jq'))process.exit(4);console.log('https://github.com/example/another/pull/99\\tsomeone-else\\nhttps://github.com/example/another/pull/77\\ttest-user');}
  else if(endpoint?.includes('/pulls?')){let prior='';try{prior=fs.readFileSync(p,'utf8')}catch(e){if(e.code!=='ENOENT')throw e}console.log(prior?'['+prior+']':'[]');}
  else if(endpoint?.includes('/pulls/'))console.log(fs.readFileSync(p,'utf8'));
  else process.exit(2);
}else if(a[0]==='pr'&&a[1]==='create'){
  const value=n=>a.find(v=>v.startsWith(n+'='))?.slice(n.length+1) ?? a[a.indexOf(n)+1];
  if(value('--title')!==input.title)throw Error('Issue-specific title was ignored');
  if(value('--repo')!==input.upstream||value('--base')!==input.base||!a.includes('--draft'))throw Error('Profile was ignored');
  const expectedHead=input.fork.toLowerCase()===input.upstream.toLowerCase()?input.branch:input.fork.split('/')[0]+':'+input.branch;
  if(value('--head')!==expectedHead)throw Error('Incorrect PR head identity');
  fs.copyFileSync(value('--body-file'),'/artifacts/mock-body.md');fs.writeFileSync('/artifacts/mock-title',value('--title'));
  const count='/artifacts/mock-create-count';let previous=0;try{previous=Number(fs.readFileSync(count,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e}fs.writeFileSync(count,String(previous+1));
  fs.writeFileSync(p,JSON.stringify({state:'open',draft:true,html_url:'https://github.com/example/another/pull/123',base:{ref:input.base},head:{sha:input.commit,ref:input.branch,repo:{full_name:input.fork}}}));
  if(fs.existsSync('/artifacts/mock-timeout')){console.error('Simulated network timeout after PR creation');process.exit(1);}
  console.log('https://github.com/example/another/pull/123');
}else process.exit(2);
`, { mode: 0o755 });
async function publish() {
  return exec(config.docker, ['run', '--rm', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--mount', `type=bind,source=${artifacts},target=/artifacts`, '--mount', `type=bind,source=${bin},target=/mockbin,readonly`,
    '--mount', `type=bind,source=${remote},target=/remote`, '--mount', `type=bind,source=${path.join(root, 'fixture-token')},target=/run/secrets/github_token,readonly`,
    '--env', 'PATH=/mockbin:/usr/local/bin:/usr/bin:/bin', '--env', 'GIT_CONFIG_COUNT=2',
    '--env', 'GIT_CONFIG_KEY_0=url.file:///remote/.insteadOf', '--env', `GIT_CONFIG_VALUE_0=https://github.com/${input.fork}.git`,
    '--env', 'GIT_CONFIG_KEY_1=safe.directory', '--env', 'GIT_CONFIG_VALUE_1=/remote', config.publisherImage], { timeoutMs: 120000 });
}
// Mutate fixture state inside the VM, matching the production controller's filesystem namespace.
// Host atomic renames of existing 9p-shared files can otherwise expose stale/incomplete mock state.
async function fixtureState(operation: string, name: string, value?: unknown) {
  const script = 'const fs=require("node:fs");const [op,name,value]=process.argv.slice(1);const p="/artifacts/"+name;if(op==="remove")fs.rmSync(p,{force:true});else fs.writeFileSync(p,value);';
  checked(await exec(config.docker, ['run','--rm','--network','none','--entrypoint','node','--mount',`type=bind,source=${artifacts},target=/artifacts`,config.publisherImage,'-e',script,operation,name,typeof value==='string'?value:JSON.stringify(value)]), 'Update publication fixture state');
}
const happy = await publish(); assert.equal(happy.code, 0, happy.stderr);
const created = JSON.parse(await fs.readFile(path.join(artifacts, 'publication-result.json'), 'utf8'));
assert.equal(created.commit, input.commit); assert.equal(created.draft, true); assert.equal(created.reused, undefined);
assert.equal(created.url, 'https://github.com/example/another/pull/123');
if (sameRepository) {
  assert.equal(JSON.parse(await fs.readFile(path.join(artifacts, 'mock-pr.json'), 'utf8')).head.repo.full_name, input.upstream);
  assert.equal(checked(await exec('git', ['--git-dir', remote, 'rev-parse', `refs/heads/${input.branch}`]), 'Inspect pushed branch'), input.commit);
  await atomicJson(path.join(project, 'state/publisher-same-repo-results.json'), { testedAt: new Date().toISOString(), outcome: 'passed', verifiedCommit: input.commit, draft: true, headRepository: input.upstream, github: 'mock CLI only; no real PR', evidence: root });
  console.log('PASS: same-repository verified bundle, local branch push, draft PR creation and readback with mocked GitHub.');
  process.exit(0);
}
// A competing open PR linked to the issue is disclosed in the draft description, never a blocker; the fork owner's own PRs are ignored.
const body = await fs.readFile(path.join(artifacts, 'mock-body.md'), 'utf8');
assert.equal(await fs.readFile(path.join(artifacts, 'mock-title'), 'utf8'), input.title);
assert.match(body, /Other open PRs reference this issue: https:\/\/github\.com\/example\/another\/pull\/99\./); assert.doesNotMatch(body, /pull\/77/);
// Reset only the mock API fixtures to exercise a separate uncertain-creation scenario.
await fixtureState('remove','mock-pr.json');
await fixtureState('remove','mock-create-count');
await sleep(1000); // Let the host-to-VM bind mount observe removals before the next container starts.
await fixtureState('write','mock-timeout','simulate uncertain outcome');
const first = await publish(); assert.equal(first.code, 1, first.stderr);
assert.match(JSON.parse(await fs.readFile(path.join(artifacts, 'publication-result.json'), 'utf8')).error, /Simulated network timeout/);
const pushed = checked(await exec('git', ['--git-dir', remote, 'rev-parse', `refs/heads/${input.branch}`]), 'Inspect real local pushed branch');
assert.equal(pushed, input.commit);
const retry = await publish(); assert.equal(retry.code, 0, retry.stderr);
const reconciled = JSON.parse(await fs.readFile(path.join(artifacts, 'publication-result.json'), 'utf8'));
assert.equal(reconciled.reused, true); assert.equal(reconciled.commit, input.commit);
assert.equal(await fs.readFile(path.join(artifacts, 'mock-create-count'), 'utf8'), '1', 'Duplicate PR creation');
const prFile = path.join(artifacts, 'mock-pr.json'), pr = JSON.parse(await fs.readFile(prFile, 'utf8'));
pr.head.sha = '0'.repeat(40); await fixtureState('write','mock-pr.json',pr);
const mismatch = await publish(); assert.equal(mismatch.code, 1, mismatch.stderr);
assert.match(JSON.parse(await fs.readFile(path.join(artifacts, 'publication-result.json'), 'utf8')).error, /different head/);
await fixtureState('remove','mock-pr.json');
await fixtureState('write','publication-input.json',{ ...input, tree: '0'.repeat(40) });
const wrongBundle = await publish(); assert.equal(wrongBundle.code, 1, wrongBundle.stderr);
assert.match(JSON.parse(await fs.readFile(path.join(artifacts, 'publication-result.json'), 'utf8')).error, /Bundle does not match/);
assert.equal(await fs.readFile(path.join(artifacts, 'mock-create-count'), 'utf8'), '1', 'Unverified bundle reached PR creation');
assert.equal(checked(await exec('git', ['--git-dir', remote, 'rev-parse', `refs/heads/${input.branch}`]), 'Check remote after rejection'), input.commit);
await atomicJson(path.join(project, 'state/publisher-results.json'), { testedAt: new Date().toISOString(), outcome: 'passed', git: 'real bundle verification and push to local bare remote', github: 'mock CLI only, network disabled; no real PR', normalCreationReadbackPassed: true, competingLinkedPrDisclosedNotBlocking: true, uncertainCreationReconciled: true, duplicateCreateCount: 1, mismatchedHeadRejected: true, mismatchedBundleRejected: true, alternateProfile: input.upstream, evidence: root });
console.log('PASS: verified bundle, local push, cross-repository draft, creation readback, competing PR disclosure, uncertain-creation reconciliation, and mismatched head/bundle rejection. GitHub responses were mocked.');
