import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { copySource } from '../src/files.ts';
import { assertCandidate, freezeRegression } from '../src/policy.ts';
import { defaultProfile } from '../src/profile.ts';
import type { RepositoryProfile } from '../src/profile.ts';
import { fixtureRepo, spec, tempConfig, withRegression } from './helpers.ts';

async function candidateFixture(t: { after(fn: () => Promise<void>): void }, files: Record<string, string>, profile: RepositoryProfile = defaultProfile) {
  const { root, config } = await tempConfig();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = await fixtureRepo(config.repoRoot), source = path.join(root, 'source');
  for (const [relative, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(base, relative)), { recursive: true });
    await fs.writeFile(path.join(base, relative), content);
  }
  await copySource(base, source);
  await fs.writeFile(path.join(source, spec.file), withRegression);
  const frozen = await freezeRegression(base, source, spec, profile);
  await fs.writeFile(path.join(source, spec.file), withRegression.replace('!line.starts_with("error:")', '!line.is_empty()'));
  return { base, source, check: () => assertCandidate(base, source, frozen, { explanation: 'Preserve the reported error output.', evidenceIds: [1, 2] }, profile) };
}

test('Cargo integration crate roots resolve sibling common/mod.rs and protect it', async t => {
  const fixture = await candidateFixture(t, {
    'tests/foo.rs': 'mod common;\n#[test] fn existing() { common::check(true); }\n',
    'tests/common/mod.rs': 'pub fn check(value: bool) { assert!(value); }\n',
  });
  await fixture.check();
  await fs.writeFile(path.join(fixture.source, 'tests/common/mod.rs'), 'pub fn check(_: bool) {}\n');
  await assert.rejects(fixture.check(), /External test-only|Existing test-root/);
});

test('nested non-root test modules keep their stem-relative children', async t => {
  const fixture = await candidateFixture(t, {
    'tests/foo.rs': 'mod nested;\n',
    'tests/nested/mod.rs': 'mod support;\n',
    'tests/nested/support.rs': 'mod child;\n',
    'tests/nested/support/child.rs': 'pub fn check(value: bool) { assert!(value); }\n',
  });
  await fixture.check();
});

test('a direct test file can resolve in both crate-root and imported-module contexts', async t => {
  const fixture = await candidateFixture(t, {
    'tests/foo.rs': 'mod support;\n',
    'tests/support.rs': 'mod child;\n',
    'tests/child.rs': 'pub fn root_child() {}\n',
    'tests/support/child.rs': 'pub fn module_child() {}\n',
  });
  await fixture.check();
});

test('crate-root traversal cannot hide a missing imported-module child', async t => {
  const fixture = await candidateFixture(t, {
    'tests/foo.rs': 'mod support;\n',
    'tests/support.rs': 'mod child;\n',
    'tests/child.rs': 'pub fn root_child() {}\n',
  });
  await assert.rejects(fixture.check(), /Unresolved external test-only module.*support\.rs::child/);
});

test('profile test roots outside the Cargo tests directory are not guessed as crate roots', async t => {
  const profile = { ...defaultProfile, testRoots: ['specs'], fixtureRoot: 'specs/fixtures' };
  const fixture = await candidateFixture(t, {
    'specs/support.rs': 'mod child;\n',
    'specs/support/child.rs': 'pub fn child() {}\n',
  }, profile);
  await fixture.check();
});

test('integration path attributes can reach and protect in-repository source helpers', async t => {
  const fixture = await candidateFixture(t, {
    'tests/foo.rs': '#[path = "../src/test_helper.rs"] mod common;\n',
    'src/test_helper.rs': 'pub fn check(value: bool) { assert!(value); }\n',
  });
  await fixture.check();
  await fs.writeFile(path.join(fixture.source, 'src/test_helper.rs'), 'pub fn check(_: bool) {}\n');
  await assert.rejects(fixture.check(), /External test-only/);
});

test('missing integration modules still require review', async t => {
  const fixture = await candidateFixture(t, { 'tests/foo.rs': 'mod missing;\n' });
  await assert.rejects(fixture.check(), /Unresolved external test-only module/);
});

test('external module path attributes cannot escape or masquerade as repository paths', async t => {
  for (const modulePath of ['../../escape.rs', '/escape.rs']) {
    const fixture = await candidateFixture(t, {
      'tests/foo.rs': `#[path = "${modulePath}"] mod external;\n`,
      'tests/escape.rs': 'pub fn decoy() {}\n',
    });
    await assert.rejects(fixture.check(), /outside|relative|module path/i);
  }
});

test('integration module resolution does not permit source symlinks', async t => {
  const fixture = await candidateFixture(t, {
    'tests/foo.rs': 'mod common;\n',
    'tests/common/mod.rs': 'pub fn check(value: bool) { assert!(value); }\n',
  });
  const helper = path.join(fixture.source, 'tests/common/mod.rs');
  await fs.rm(helper);
  await fs.symlink(path.join(fixture.base, 'tests/common/mod.rs'), helper);
  await assert.rejects(fixture.check(), /symlink/i);
});
