import test from 'node:test';
import assert from 'node:assert/strict';
import { fastChecks, focusedCheck } from '../src/checks.ts';
import * as checks from '../src/checks.ts';
import { spec } from './helpers.ts';
test('top-level test modules are accepted while exact tests require their qualified name', () => {
  assert.ok(focusedCheck('test-module', 'tests').includes('tests::'));
  assert.throws(() => focusedCheck('test-focused', 'tests'), /qualified/);
  const checks = fastChecks('tests::regression');
  assert.equal(checks.at(-1)?.[0], 'test-module');
  assert.ok(checks.every(([, args]) => args[1] === 'fmt' || args.includes('--locked') && args.includes('--offline')));
});

test('canonical regression and discovery commands select integration targets offline', () => {
  const api = checks as any;
  assert.equal(typeof api.regressionCheck, 'function', 'regression command helper is required');
  const integration = { ...spec, file: 'tests/cli_behavior.rs', testName: 'scalar_text', target: { kind: 'integration', name: 'cli_behavior' } };
  const argv = api.regressionCheck(integration);
  assert.deepEqual(argv, ['cargo', 'test', '-p', 'rtk', '--locked', '--offline', '--test', 'cli_behavior', 'scalar_text', '--', '--exact', '--nocapture', '--test-threads=1']);
  assert.deepEqual(api.listTestsCheck(integration.target), ['cargo', 'test', '-p', 'rtk', '--locked', '--offline', '--test', 'cli_behavior', '--', '--list', '--format=terse']);
  assert.ok(api.listTestsCheck().includes('--lib'));
  for (const name of ['../escape', '--all-targets', 'cli;touch /tmp/no', 'cli/other']) assert.throws(() => api.listTestsCheck({ kind: 'integration', name }));
  assert.throws(() => api.regressionCheck({ ...integration, file: 'tests/different.rs' }), /target.*file|file.*target/);
});

test('trusted formatting has an argument-only command and test discovery returns names', () => {
  const api = checks as any;
  assert.equal(typeof api.formatCheck, 'function', 'trusted formatting helper is required');
  assert.deepEqual(api.formatCheck(), ['cargo', 'fmt', '--manifest-path', 'Cargo.toml', '--all']);
  assert.deepEqual(api.parseListedTests('tests::one: test\ntests::nested::two: test\nbench_one: benchmark\n2 tests, 1 benchmark\n'), ['tests::one', 'tests::nested::two']);
});

test('zero executed tests have a structured no_match outcome despite process success', () => {
  const api = checks as any;
  assert.equal(typeof api.summarizeCheck, 'function', 'structured result summary is required');
  assert.deepEqual(api.summarizeCheck('test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 12 filtered out;', 0, false, ['cargo', 'test']), { status: 'no_match', matched: 0, passed: 0, failed: 0, ignored: 0 });
  assert.deepEqual(api.summarizeCheck('test result: ok. 0 passed; 0 failed; 1 ignored;', 0, false, ['cargo', 'test']), { status: 'no_match', matched: 1, passed: 0, failed: 0, ignored: 1 });
  assert.equal(api.summarizeCheck('test result: ok. 1 passed; 0 failed; 0 ignored;', 0, false).status, 'passed');
  assert.equal(api.summarizeCheck('error[E1234]: compile error', 101, false, ['cargo', 'test']).status, 'failed');
  assert.equal(api.summarizeCheck('', 0, false, ['cargo', 'test']).status, 'no_match');
  assert.equal(api.summarizeCheck('', 0, true).status, 'timed_out');
  assert.deepEqual(api.summarizeCheck('', 0, false, ['cargo', 'fmt']), { status: 'passed' });
});

test('large test catalogs return filtered canonical names instead of a truncated tail', () => {
  const api=checks as any;assert.equal(typeof api.discoverTests,'function');
  const output=Array.from({length:6000},(_,i)=>`module_${i}::tests::case: test`).join('\n')+'\ncmds::python::sqlfluff_cmd::tests::json_output: test\n';
  const filtered=api.discoverTests(output,'sqlfluff');assert.deepEqual(filtered.listedTests,['cmds::python::sqlfluff_cmd::tests::json_output']);assert.equal(filtered.totalListed,6001);assert.equal(filtered.matchedListed,1);assert.equal(filtered.truncated,false);
  const all=api.discoverTests(output);assert.equal(all.listedTests.length,200);assert.equal(all.matchedListed,6001);assert.equal(all.truncated,true);
  assert.deepEqual(api.discoverTests(output,'no_such_case').listedTests,[]);
});
