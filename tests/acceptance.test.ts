import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { copySource } from '../src/files.ts';
import { assertCandidate } from '../src/policy.ts';
import { tempConfig, fixtureRepo, spec, withRegression } from './helpers.ts';
import type { AcceptanceRequirement, Regression } from '../src/types.ts';

async function acceptance() {
  const modulePath = '../src/acceptance.ts';
  const api = await import(modulePath).catch(() => null);
  assert.ok(api, 'Acceptance matrix implementation is required');
  return api;
}
const control: Regression = { ...spec, id: 'ordinary', baseline: 'pass', testName: 'tests::bugfix_control', expectedBehavior: 'Preserve ordinary output.', citation: 'Ordinary output must still be preserved.' };
const bug: Regression = { ...spec, id: 'error' };
const controlCode = '    #[test]\n    fn bugfix_control() { assert!(preserve("hello")); }\n';
const candidate = { explanation: 'Preserve reported errors and ordinary output.', evidenceIds: [1, 2] };
const output = (name: string, pass: boolean) => `test ${name} ... ${pass ? 'ok' : 'FAILED'}\n${spec.failureContains}\ntest result: ${pass ? 'ok. 1 passed; 0 failed;' : 'FAILED. 0 passed; 1 failed;'} 0 ignored;`;

test('scenario normalization preserves legacy regressions and rejects duplicate identities', async () => {
  const api = await acceptance();
  assert.deepEqual(api.scenarioList(spec).map((s: Regression) => [s.id, s.required, s.baseline, s.target]), [['regression-1', true, 'fail', { kind: 'unit' }]]);
  assert.throws(() => api.scenarioList([bug, bug]), /unique|duplicate/);
  assert.throws(() => api.scenarioList([]), /scenario/);
});

test('frozen acceptance requirements reject missing scenarios or weakened descriptions', async () => {
  const api = await acceptance();
  const requirements: AcceptanceRequirement[] = [
    { id: 'error', expectedBehavior: spec.expectedBehavior, citation: spec.citation, baseline: 'fail' },
    { id: 'ordinary', expectedBehavior: control.expectedBehavior, citation: control.citation, baseline: 'pass' },
  ];
  api.validateScenarioCoverage(requirements, [bug, control]);
  assert.throws(() => api.validateScenarioCoverage(requirements, [bug]), /ordinary|missing/);
  assert.throws(() => api.validateScenarioCoverage(requirements, [bug, { ...control, expectedBehavior: 'Anything is acceptable.' }]), /expected behavior|weaken|requirement/);
  assert.throws(() => api.validateScenarioCoverage(requirements, [bug, { ...control, baseline: 'fail' }]), /baseline|requirement/);
  assert.throws(() => api.validateScenarioCoverage(requirements, [bug, { ...control, required: false }]), /required|requirement/);
});

test('several new inline scenarios in one existing module are frozen together', async t => {
  const api = await acceptance();
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = await fixtureRepo(config.repoRoot), source = path.join(root, 'source'); await copySource(base, source);
  const code = withRegression.replace('    #[test]\n    fn keeps_normal()', controlCode + '\n    #[test]\n    fn keeps_normal()');
  await fs.writeFile(path.join(source, spec.file), code);
  const frozen = await api.freezeRegressions(base, source, [bug, control]);
  assert.equal(frozen.length, 2); await api.assertFrozenRegressions(source, frozen);
  await fs.writeFile(path.join(source, spec.file), code.replace('!line.starts_with("error:")', '!line.is_empty()'));
  await assertCandidate(base, source, frozen, candidate);
  await fs.writeFile(path.join(source, spec.file), code.replace('assert!(preserve("hello")); }', 'assert!(true); }'));
  await assert.rejects(api.assertFrozenRegressions(source, frozen), /Frozen regression/);
});

test('new integration regression permits imports and helpers and freezes its entire file', async t => {
  const api = await acceptance();
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = await fixtureRepo(config.repoRoot), source = path.join(root, 'source'); await copySource(base, source);
  await fs.mkdir(path.join(source, 'tests'), { recursive: true });
  const integration: Regression = { ...bug, file: 'tests/cli_behavior.rs', testName: 'scalar_text', target: { kind: 'integration', name: 'cli_behavior' } };
  const code = 'use std::process::Command;\nfn assert_output(actual: &str) { assert_eq!(actual, "42\\n"); }\n#[test] fn scalar_text() { assert_output("42\\n"); assert_eq!(Command::new("echo").arg("42").output().unwrap().status.code(), Some(0)); }\n';
  await fs.writeFile(path.join(source, integration.file), code);
  const frozen = await api.freezeRegressions(base, source, [integration]);
  assert.ok(frozen[0].wholeFileHash); await api.assertFrozenRegressions(source, frozen);
  await fs.writeFile(path.join(source, spec.file), (await fs.readFile(path.join(source, spec.file), 'utf8')).replace('!line.starts_with("error:")', '!line.is_empty()'));
  await assertCandidate(base, source, frozen, candidate);
  await fs.writeFile(path.join(source, integration.file), code.replace('assert_eq!(actual, "42\\n")', 'let _ = actual'));
  await assert.rejects(api.assertFrozenRegressions(source, frozen), /Frozen integration|Frozen regression/);
});

test('integration assertions may live in a frozen helper reached by the named test', async t => {
  const api = await acceptance();
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = await fixtureRepo(config.repoRoot), source = path.join(root, 'source'); await copySource(base, source);
  await fs.mkdir(path.join(source, 'tests'), { recursive: true });
  const integration: Regression = { ...bug, file: 'tests/cli_behavior.rs', testName: 'scalar_text', target: { kind: 'integration', name: 'cli_behavior' } };
  await fs.writeFile(path.join(source, integration.file), 'fn verify_output() { assert_eq!("42\\n", "42\\n"); }\n#[test] fn scalar_text() { verify_output(); }\n');
  const frozen = await api.freezeRegressions(base, source, [integration]);
  await api.assertFrozenRegressions(source, frozen);
});

test('required baseline failures, passing controls and every candidate scenario are checked', async () => {
  const api = await acceptance();
  const frozen = api.scenarioList([bug, control]).map((s: Regression) => ({ spec: s }));
  const results = [
    { scenarioId: 'error', output: output(spec.testName, false), exitCode: 101, timedOut: false },
    { scenarioId: 'ordinary', output: output(control.testName, true), exitCode: 0, timedOut: false },
  ];
  api.assertAcceptanceResults(frozen, results, 'baseline');
  const passed = results.map(r => ({ ...r, output: output(r.scenarioId === 'error' ? spec.testName : control.testName, true), exitCode: 0 }));
  api.assertAcceptanceResults(frozen, passed, 'candidate');
  for (const invalid of [passed.slice(0, 1), [...passed, passed[0]], [...passed, { ...passed[0], scenarioId: 'unrelated' }], [{ ...passed[0], output: 'test result: ok. 0 passed; 0 failed; 0 ignored;' }, passed[1]]]) assert.throws(() => api.assertAcceptanceResults(frozen, invalid, 'candidate'), /scenario|duplicate|match|required/);
  assert.throws(() => api.assertAcceptanceResults(frozen, results, 'candidate'), /scenario|required/);
});

test('incomplete historical scenario results cannot pass the #3980 and #4662 matrices', async () => {
  const api = await acceptance();
  // Deterministic gate fixtures name the behaviors absent from the original candidates. They exercise
  // controller acceptance of independently supplied outcomes, without pretending to execute upstream code.
  for (const [issue, names, missed] of [
    [3980, ['spaced', 'attached', 'strip_tabs', 'descriptor_prefix', 'real_dev_null'], 'descriptor_prefix'],
    [4662, ['array_text', 'scalar', 'attached_options', 'explicit_output', 'ordinary_summary', 'error_status'], 'scalar'],
  ] as const) {
    const scenarios = names.map(name => ({ ...spec, id: `issue_${issue}_${name}`, testName: `tests::${name}` }));
    const frozen = scenarios.map(s => ({ spec: s }));
    const corrected = scenarios.map(s => ({ scenarioId: s.id, output: output(s.testName, true), exitCode: 0, timedOut: false }));
    const incomplete = corrected.map(r => r.scenarioId.endsWith(missed) ? { ...r, output: output(`tests::${missed}`, false), exitCode: 101 } : r);
    assert.throws(() => api.assertAcceptanceResults(frozen, incomplete, 'candidate'), new RegExp(missed));
    api.assertAcceptanceResults(frozen, corrected, 'candidate');
  }
});
