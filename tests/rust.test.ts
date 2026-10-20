import test from 'node:test';
import assert from 'node:assert/strict';
import { assertOnlyNewRegression, extractTest, freezeRust, rustTests } from '../src/rust.ts';
import { original, withRegression, testName } from './helpers.ts';

test('extracts an ordinary inline regression without freezing implementation', () => {
  assertOnlyNewRegression(original, withRegression, testName);
  const before = freezeRust(withRegression, testName);
  assert.deepEqual(freezeRust(withRegression.replace('!line.starts_with("error:")', '!line.is_empty()'), testName), before);
});
test('raw strings, escaped strings, nested comments and braces cannot confuse the test boundary', () => {
  const code = '#[cfg(test)] mod tests { /* { /* } */ } */ #[test] fn example() { let s = r###" { } \" #[ignore] "###; assert_eq!(s.len(), 24); } }';
  assert.equal(rustTests(code).length, 1); assert.equal(extractTest(code, 'tests::example').qualified, 'tests::example');
});
test('test attributes and module gating are part of the frozen identity', () => {
  const frozen = freezeRust(withRegression, testName);
  assert.notEqual(freezeRust(withRegression.replace('#[cfg(test)]', '#[cfg(any(test, unix))]'), testName).contextHash, frozen.contextHash);
  assert.throws(() => extractTest(withRegression.replace('    fn bugfix', '    #[ignore]\n    fn bugfix'), testName), /ignored/);
  assert.notEqual(freezeRust(withRegression.replace('use super::*;', 'use super::*; fn preserve(_: &str) -> bool { true }'), testName).contextHash, frozen.contextHash);
});
test('rejects production edits disguised as reproduction', () => {
  assert.throws(() => assertOnlyNewRegression(original, withRegression.replace('!line.starts_with("error:")', 'true'), testName), /production/);
});
test('rejects a regression which already existed and duplicate tests', () => {
  assert.throws(() => assertOnlyNewRegression(withRegression, withRegression, testName), /newly added/);
  assert.throws(() => extractTest(withRegression + '\n' + withRegression, testName), /Exactly one/);
});

test('inventories async and parameterized macro tests with their full attributes', () => {
  const code = '#[tokio::test(flavor = "current_thread")] async fn asynchronous() { assert!(true); }\n#[test_case(1; "one")] fn parameterized(value: i32) { assert_eq!(value, 1); }';
  assert.deepEqual(rustTests(code).map(t => t.qualified), ['asynchronous', 'parameterized']);
  assert.ok(rustTests(code)[0].attributes.includes('tokio'));
});

test('file attributes and nontrivial test module gating remain in frozen context', () => {
  const code = '#![cfg(unix)]\n' + withRegression.replace('#[cfg(test)]', '#[cfg(all(test, unix))]');
  const frozen = freezeRust(code, testName);
  assert.notEqual(freezeRust(code.replace('#![cfg(unix)]', '#![cfg(windows)]'), testName).contextHash, frozen.contextHash);
  assert.notEqual(freezeRust(code.replace('use super::*;', 'use super::*; fn expected() -> bool { false }'), testName).contextHash, frozen.contextHash);
});
