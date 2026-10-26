import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { defaultProfile, loadProfile } from '../src/profile.ts';
import { validateInput } from '../src/pipeline.ts';
import { focusedCheck, fastChecks } from '../src/checks.ts';
import { applyEdits } from '../src/files.ts';
import { tempConfig } from './helpers.ts';

test('a second Cargo profile selects its own issue scope, package, roots and check commands', async t => {
  const { root } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'another.json');
  await fs.writeFile(file, JSON.stringify({ ...defaultProfile, id: 'another', upstream: 'example/another', baseBranch: 'main', packageName: 'another', sourceRoots: ['crates/core'], testRoots: ['spec'], fixtureRoot: 'spec/data', focusedTestPrefix: ['cargo', 'test', '-p', 'another', '--lib', '--locked', '--offline'], fastCheckIds: ['lint'], checks: { lint: ['cargo', 'clippy', '-p', 'another', '--locked', '--offline'] } }));
  const profile = loadProfile(file);
  assert.equal(validateInput({ repo: '/repo', issue: 'https://github.com/example/another/issues/42' }, profile).mode, 'live');
  assert.throws(() => validateInput({ repo: '/repo', issue: 'https://github.com/rtk-ai/rtk/issues/42' }, profile));
  assert.ok(focusedCheck('test-focused', 'tests::regression', profile).includes('another'));
  assert.equal(fastChecks('tests::regression', profile)[0][0], 'lint');
  await applyEdits(root, [{ path: 'crates/core/lib.rs', before: '', after: 'fn main() {}' }], [...profile.sourceRoots, ...profile.testRoots]);
  await assert.rejects(applyEdits(root, [{ path: 'src/lib.rs', before: '', after: 'rejected' }], profile.sourceRoots));
});

test('skipTests adds explicit --skip filters to cargo test commands only and requires a reason', async t => {
  const { root } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'skips.json');
  const checks = { lint: ['cargo', 'clippy', '--locked'], unit: ['cargo', 'test', '--locked'], args: ['cargo', 'test', '--', '--test-threads=1'] };
  await fs.writeFile(file, JSON.stringify({ ...defaultProfile, fastCheckIds: ['lint'], checks, skipTests: { 'hooks::tests::writes_to_source': 'Writes into the read-only source mount' }, skipTestOwners: { 'hooks::tests::writes_to_source': ['src/hooks.rs'] } }));
  const profile = loadProfile(file);
  assert.deepEqual(profile.checks.lint, checks.lint);
  assert.deepEqual(profile.checks.unit, ['cargo', 'test', '--locked', '--', '--skip', 'hooks::tests::writes_to_source']);
  assert.deepEqual(profile.checks.args, ['cargo', 'test', '--', '--test-threads=1', '--skip', 'hooks::tests::writes_to_source']);
  assert.deepEqual(focusedCheck('test-module', 'hooks::tests', profile).slice(-2), ['--skip', 'hooks::tests::writes_to_source']);
  assert.ok(!focusedCheck('test-focused', 'hooks::tests::regression', profile).includes('--skip'));
  for (const skipTests of [{ 'hooks::tests::x': '' }, { 'not a path': 'Writes into the read-only source mount' }, { unqualified: 'Writes into the read-only source mount' }]) {
    await fs.writeFile(file, JSON.stringify({ ...defaultProfile, fastCheckIds: ['lint'], checks, skipTests })); assert.throws(() => loadProfile(file));
  }
});

test('profiles reject unsupported adapters and paths outside approved roots', async t => {
  const { root } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'invalid.json');
  for (const change of [{ adapter: 'python' }, { sourceRoots: ['../outside'] }, { fixtureRoot: 'other/fixtures' }, { fastCheckIds: ['missing'] }, { baseBranch: '--bad' }, { checks: { test: 'cargo test' } }, { agentNotes: 'not a list' }, { agentNotes: [''] }, { agentNotes: ['x'.repeat(1001)] }]) {
    await fs.writeFile(file, JSON.stringify({ ...defaultProfile, ...change })); assert.throws(() => loadProfile(file));
  }
});
