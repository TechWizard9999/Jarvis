import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { copySource, applyEdits, parseEdits, sourcePath, safeRelative } from '../src/files.ts';
import { assertCandidate, assertFrozen, assertInsertOnly, freezeRegression, inFileTestName, regressionPassed, reproductionFailure } from '../src/policy.ts';
import { tempConfig, fixtureRepo, spec, withRegression, testName, original } from './helpers.ts';
import { defaultProfile } from '../src/profile.ts';

test('rejects path traversal, hidden Git metadata and symlinks', async t => {
  const { root } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const value of ['../secret', '/etc/passwd', 'src/../../secret', 'src/.git/config', 'src\\evil', 'src/x\n.rs']) assert.throws(() => safeRelative(value));
  await fs.symlink('/tmp', path.join(root, 'escape')); await assert.rejects(sourcePath(root, 'escape/file', true), /Symlinks/);
});
test('new regression freezes the whole test identity and fixture contents', async t => {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = await fixtureRepo(config.repoRoot), source = path.join(root, 'source'); await copySource(base, source);
  await fs.writeFile(path.join(source, spec.file), withRegression);
  const frozen = await freezeRegression(base, source, spec); await assertFrozen(source, frozen);
  await fs.writeFile(path.join(source, spec.file), withRegression.replace('reported error must be preserved', 'different assertion'));
  await assert.rejects(assertFrozen(source, frozen), /Frozen regression/);
});
test('a regression in a submodule file is named by its crate path and frozen by its in-file path', async t => {
  assert.equal(inFileTestName({ file: 'src/lib.rs', testName: 'tests::x' }), 'tests::x');
  assert.equal(inFileTestName({ file: 'src/hooks/hook_cmd.rs', testName: 'hooks::hook_cmd::tests::x' }), 'tests::x');
  assert.equal(inFileTestName({ file: 'src/hooks/init/mod.rs', testName: 'hooks::init::tests::x' }), 'tests::x');
  assert.equal(inFileTestName({ file: 'crates/core/src/a.rs', testName: 'a::tests::x' }), 'tests::x');
  for (const bad of [{ file: 'src/hooks/hook_cmd.rs', testName: 'tests::x' }, { file: 'src/hooks/hook_cmd.rs', testName: 'hooks::hook_cmd::x' }, { file: 'lib.rs', testName: 'tests::x' }]) assert.throws(() => inFileTestName(bad));
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = await fixtureRepo(config.repoRoot), source = path.join(root, 'source'); await copySource(base, source);
  const nested = { ...spec, file: 'src/hooks/hook_cmd.rs', testName: 'hooks::hook_cmd::' + testName };
  for (const dir of [base, source]) { await fs.mkdir(path.join(dir, 'src/hooks'), { recursive: true }); await fs.writeFile(path.join(dir, nested.file), original); }
  await fs.writeFile(path.join(source, nested.file), withRegression);
  const frozen = await freezeRegression(base, source, nested); await assertFrozen(source, frozen);
  await fs.writeFile(path.join(source, nested.file), withRegression.replace('reported error must be preserved', 'different assertion'));
  await assert.rejects(assertFrozen(source, frozen), /Frozen regression/);
});
test('zero tests, compile errors and unrelated failures never count as reproduction', () => {
  assert.equal(reproductionFailure('test result: ok. 0 passed; 0 failed;', testName, spec.failureContains), false);
  assert.equal(reproductionFailure(`error[E1234]: could not compile\ntest ${testName} ... FAILED\n${spec.failureContains}\ntest result: FAILED. 0 passed; 1 failed; 0 ignored;`, testName, spec.failureContains), false);
  const output = `test ${testName} ... FAILED\n${spec.failureContains}\ntest result: FAILED. 0 passed; 1 failed; 0 ignored;`;
  assert.equal(reproductionFailure(output, testName, spec.failureContains), true);
  assert.equal(regressionPassed(`test ${testName} ... ok\ntest result: ok. 1 passed; 0 failed; 0 ignored;`, testName), true);
});
test('minimal implementation fix is accepted while weakening existing tests is rejected', async t => {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = await fixtureRepo(config.repoRoot), source = path.join(root, 'source'); await copySource(base, source);
  await fs.writeFile(path.join(source, spec.file), withRegression); const frozen = await freezeRegression(base, source, spec);
  const fixed = withRegression.replace('!line.starts_with("error:")', '!line.is_empty()'); await fs.writeFile(path.join(source, spec.file), fixed);
  await assertCandidate(base, source, frozen, { explanation: 'Preserve errors and ordinary output.', evidenceIds: [1, 2] });
  await fs.writeFile(path.join(source, spec.file), fixed.replace('assert!(preserve("hello"))', 'assert!(true)'));
  await assert.rejects(assertCandidate(base, source, frozen, { explanation: 'bad', evidenceIds: [1, 2] }), /Existing test changed/);
});
test('exact replacement rejects ambiguous input and does not run shell text', async t => {
  const { root } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src')); await fs.writeFile(path.join(root, 'src/a.rs'), 'same same');
  await assert.rejects(applyEdits(root, [{ path: 'src/a.rs', before: 'same', after: 'new' }]), /exactly once/);
  await applyEdits(root, [{ path: 'src/new.rs', before: '', after: '$(touch /tmp/SHOULD_NOT_RUN)' }]);
  assert.equal(await fs.readFile(path.join(root, 'src/new.rs'), 'utf8'), '$(touch /tmp/SHOULD_NOT_RUN)');
});
test('reproduction edits may only insert around original text; the new test itself may change freely', () => {
  const original = 'mod tests {\n    #[test]\n    fn existing() { assert!(true); }\n}\n';
  assertInsertOnly(original, { path: 'src/a.rs', before: '    #[test]\n    fn existing()', after: '    #[test]\n    fn added() {}\n\n    #[test]\n    fn existing()' });
  assertInsertOnly(original, { path: 'src/a.rs', before: '    }\n}\n', after: '    }\n\n    #[test]\n    fn added() {}\n}\n' });
  assertInsertOnly(original, { path: 'src/a.rs', before: '    fn added() { assert!(false); }', after: '    fn added() { assert!(true); }' });
  assertInsertOnly('', { path: 'tests/fixtures/new.txt', before: '', after: 'fixture' });
  assert.throws(() => assertInsertOnly(original, { path: 'src/a.rs', before: '    #[test]\n    fn existing() { assert!(true); }\n', after: '' }), /may only ADD code/);
  assert.throws(() => assertInsertOnly(original, { path: 'src/a.rs', before: 'assert!(true)', after: 'assert!(false)' }), /may only ADD code/);
  assert.throws(() => assertInsertOnly(original, { path: 'src/a.rs', before: 'fn existing() { assert!(true); }', after: 'fn existing() { assert!(true); assert!(false); }x' }), /may only ADD code/);
});
test('string-encoded edits parse, a damaged closing tail is repaired, and other damage is explained', () => {
  const edits = [{ path: 'src/a.rs', before: 'x]\n}', after: 'y' }];
  assert.deepEqual(parseEdits(JSON.stringify(edits)), edits);
  for (const tail of [']]', ')]', '}', '', ' ] ]']) assert.deepEqual(parseEdits(JSON.stringify(edits).replace(/\}\]$/, tail)), edits);
  assert.throws(() => parseEdits('[{"path": "src/a.rs", "before": x}]'), /not valid JSON.*pass edits as an array/);
});

test('an inline snapshot expectation requires a review flag and cannot change the tested expression', async t => {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = await fixtureRepo(config.repoRoot), source = path.join(root, 'source');
  const old = withRegression.replace('assert!(preserve("hello"));', 'insta::assert_snapshot!("actual", @"before");');
  // The baseline has the existing snapshot test, while only the new regression is inserted for reproduction.
  await fs.writeFile(path.join(base, spec.file), original.replace('assert!(preserve("hello"));', 'insta::assert_snapshot!("actual", @"before");'));
  await copySource(base, source); await fs.writeFile(path.join(source, spec.file), old);
  const frozen = await freezeRegression(base, source, spec);
  const fixed = old.replace('!line.starts_with("error:")', '!line.is_empty()').replace('@"before"', '@"after"');
  await fs.writeFile(path.join(source, spec.file), fixed);
  const candidate = { explanation: 'Preserve errors with the issue-required output change.', evidenceIds: [1, 2] };
  await assert.rejects(assertCandidate(base, source, frozen, candidate), /snapshot policy/);
  const flagged = { ...candidate, snapshots: [{ path: spec.file, owner: spec.file, reason: 'Expected output changes to preserve the reported error line.' }] };
  await assertCandidate(base, source, frozen, flagged);
  await fs.writeFile(path.join(source, spec.file), fixed.replace('!("actual",', '!("different expression",'));
  await assert.rejects(assertCandidate(base, source, frozen, flagged), /snapshot policy/);
});

test('preexisting Rust integration helpers cannot be weakened without changing a test body', async t => {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = await fixtureRepo(config.repoRoot), source = path.join(root, 'source');
  await fs.mkdir(path.join(base, 'tests/support'), { recursive: true });
  await fs.writeFile(path.join(base, 'tests/support/mod.rs'), 'pub fn success(status: i32) { assert_eq!(status, 0); }\n');
  await copySource(base, source); await fs.writeFile(path.join(source, spec.file), withRegression);
  const frozen = await freezeRegression(base, source, spec);
  await fs.writeFile(path.join(source, spec.file), withRegression.replace('!line.starts_with("error:")', '!line.is_empty()'));
  await fs.writeFile(path.join(source, 'tests/support/mod.rs'), 'pub fn success(_: i32) {}\n');
  await assert.rejects(assertCandidate(base, source, frozen, { explanation: 'Preserve reported errors.', evidenceIds: [1, 2] }), /Existing test-root file/);
});

test('standalone test-only helpers and macro tests retain their assertions', async t => {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = await fixtureRepo(config.repoRoot), source = path.join(root, 'source');
  const support = '#[cfg(test)] fn expected() -> bool { true }\n#[tokio::test] async fn macro_test() { assert!(expected()); }\n';
  await fs.writeFile(path.join(base, spec.file), original + support);
  await copySource(base, source); await fs.writeFile(path.join(source, spec.file), withRegression + support);
  const frozen = await freezeRegression(base, source, spec);
  const fixed = (withRegression + support).replace('!line.starts_with("error:")', '!line.is_empty()');
  for (const weakened of [fixed.replace('-> bool { true }', '-> bool { false }'), fixed.replace('assert!(expected())', 'assert!(true)')]) {
    await fs.writeFile(path.join(source, spec.file), weakened);
    await assert.rejects(assertCandidate(base, source, frozen, { explanation: 'Preserve reported errors.', evidenceIds: [1, 2] }), /Existing test|test-only support/);
  }
});

test('reproduction requires a substantive expected behavior and issue citation', async t => {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = await fixtureRepo(config.repoRoot), source = path.join(root, 'source'); await copySource(base, source);
  await fs.writeFile(path.join(source, spec.file), withRegression);
  await assert.rejects(freezeRegression(base, source, { ...spec, citation: '' }), /citation/);
  await assert.rejects(freezeRegression(base, source, { ...spec, expectedBehavior: ' ' }), /expected behavior/);
});

test('external test-only source modules and their nested helpers are preserved', async t => {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = await fixtureRepo(config.repoRoot), source = path.join(root, 'source');
  const declaration = '\n#[cfg(test)] mod support;\n';
  await fs.writeFile(path.join(base, spec.file), original + declaration);
  await fs.mkdir(path.join(base, 'src/support'), { recursive: true });
  await fs.writeFile(path.join(base, 'src/support.rs'), 'mod nested; pub fn check(value: bool) { nested::check(value); }\n');
  await fs.writeFile(path.join(base, 'src/support/nested.rs'), 'pub fn check(value: bool) { assert!(value); }\n');
  await copySource(base, source); await fs.writeFile(path.join(source, spec.file), withRegression + declaration);
  const frozen = await freezeRegression(base, source, spec);
  await fs.writeFile(path.join(source, spec.file), (withRegression + declaration).replace('!line.starts_with("error:")', '!line.is_empty()'));
  await fs.writeFile(path.join(source, 'src/support/nested.rs'), 'pub fn check(_: bool) {}\n');
  await assert.rejects(assertCandidate(base, source, frozen, { explanation: 'Preserve reported errors.', evidenceIds: [1, 2] }), /External test-only|test-only support/);
});

test('production fixes cannot add test-only shortcuts or weaken opaque test macros', async t => {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = await fixtureRepo(config.repoRoot), source = path.join(root, 'source');
  const macro = '\n#[cfg(unix)] mod generated { proptest! { #[test] fn generated(value in 1..10) { assert!(value > 0); } }\nmacro_rules! generated_tests { () => { #[test] fn generated() { assert!(1 > 0); } } } }\n';
  await fs.writeFile(path.join(base, spec.file), original + macro);
  await copySource(base, source); await fs.writeFile(path.join(source, spec.file), withRegression + macro);
  const frozen = await freezeRegression(base, source, spec);
  for (const invalid of [(withRegression + macro).replace('!line.starts_with("error:")', 'cfg!(test) || !line.starts_with("error:")'), (withRegression + macro).replace('assert!(value > 0)', 'assert!(true)'), (withRegression + macro).replace('assert!(1 > 0)', 'assert!(true)'), (withRegression + macro).replace('#[cfg(unix)]', '#[cfg(windows)]')]) {
    await fs.writeFile(path.join(source, spec.file), invalid);
    await assert.rejects(assertCandidate(base, source, frozen, { explanation: 'Preserve reported errors.', evidenceIds: [1, 2] }), /test-only|unsupported test syntax/);
  }
  await fs.writeFile(path.join(source, spec.file), (withRegression + macro).replace('!line.starts_with("error:")', '!line.is_empty()'));
  await fs.writeFile(path.join(source, 'src/shortcut.rs'), 'pub fn preserve(_: &str) -> bool { cfg!(test) }\n');
  await assert.rejects(assertCandidate(base, source, frozen, { explanation: 'Preserve reported errors.', evidenceIds: [1, 2] }), /test-only|unsupported test syntax/);
});

test('a relevant skipped check blocks a complete candidate verdict', async t => {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = await fixtureRepo(config.repoRoot), source = path.join(root, 'source'); await copySource(base, source);
  await fs.writeFile(path.join(source, spec.file), withRegression); const frozen = await freezeRegression(base, source, spec);
  await fs.writeFile(path.join(source, spec.file), withRegression.replace('!line.starts_with("error:")', '!line.is_empty()'));
  const profile = { ...defaultProfile, skipTests: { 'tests::read_only_case': 'Requires a writable source mount.' }, skipTestOwners: { 'tests::read_only_case': ['src/lib.rs'] } };
  await assert.rejects(assertCandidate(base, source, frozen, { explanation: 'Preserve reported errors.', evidenceIds: [1, 2] }, profile), /skipped.*tests::read_only_case|tests::read_only_case.*skipped/i);
  await assertCandidate(base, source, frozen, { explanation: 'Preserve reported errors.', evidenceIds: [1, 2] }, { ...profile, skipTestOwners: { 'tests::read_only_case': ['src/unrelated.rs'] } });
});
