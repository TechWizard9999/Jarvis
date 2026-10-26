import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as checks from '../src/checks.ts';
import { Pipeline } from '../src/pipeline.ts';
import { freezeRegression } from '../src/policy.ts';
import * as evidence from '../src/evidence.ts';
import { copySource, fingerprint, hash, inventory } from '../src/files.ts';
import { original, spec, tempConfig } from './helpers.ts';
import type { CheckResult, Regression } from '../src/types.ts';

const { validateEvidence } = evidence;
const target = 'bugfix_issue_1', bugTest = 'bugfix_issue_1_error', controlTest = 'bugfix_issue_1_control';
const regression: Regression = { ...spec, id: 'bug', required: true, baseline: 'fail', target: { kind: 'integration', name: target }, file: `tests/${target}.rs`, testName: bugTest };
const targetCheck = (name: unknown) => checks.integrationTargetCheck(name as string);
async function fixture(t: test.TestContext) {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pipeline = new Pipeline(config), run = await pipeline.store.create({ repo: '/fixture', issue: 'https://github.com/rtk-ai/rtk/issues/1', mode: 'evaluation', retrieval: 'text' });
  const base = path.join(root, 'base'), source = path.join(root, 'source');
  await fs.mkdir(path.join(base, 'src'), { recursive: true }); await fs.writeFile(path.join(base, 'src/lib.rs'), original); await copySource(base, source);
  await fs.mkdir(path.join(source, 'tests')); await fs.writeFile(path.join(source, regression.file), `#[test]\nfn ${bugTest}() { assert!(true); }\n#[test]\nfn ${controlTest}() { assert!(true); }\n`);
  const frozen = await freezeRegression(base, source, regression); run.regression = frozen; run.regressions = [frozen]; run.stage = 'patching'; run.workerContainer = 'fixture-worker';
  const context = { run, base, source, phase: 'patching' as const, abort: new AbortController(), queue: Promise.resolve(), agent: { toolToken: '', providerToken: '', start: async () => {}, ask: async () => ({}), stop: async () => {} } };
  pipeline.contexts.set(run.id, context); const commands: string[][] = []; let empty = false;
  pipeline.docker.inContainer = async (_run, _container, argv) => {
    commands.push(argv); let stdout = '';
    if (argv.includes('--list')) stdout = `${bugTest}: test\n${controlTest}: test\n`;
    else if (argv[0] === 'cargo') {
      const names = empty ? [] : argv.includes(bugTest) ? [bugTest] : [bugTest, controlTest];
      stdout = names.map(name => `test ${name} ... ok\n`).join('') + `test result: ok. ${names.length} passed; 0 failed; 0 ignored; 0 measured; 0 filtered out;\n`;
    }
    return { code: 0, stdout, stderr: '', durationMs: 1, timedOut: false };
  };
  return { pipeline, run, context, source, commands, setEmpty: () => { empty = true; } };
}

test('exploratory integration commands select one canonical offline target without an exact test selector', () => {
  assert.deepEqual(targetCheck(target), ['cargo', 'test', '-p', 'rtk', '--locked', '--offline', '--test', target, '--', '--nocapture', '--test-threads=1']);
  for (const name of ['', '../escape', '--all-targets', 'cli/other', 'cli;touch /tmp/no', true, null, 42]) assert.throws(() => targetCheck(name), /canonical integration target/);
});

test('whole integration target runs are exploratory and cannot replace exact bug-scenario evidence', async t => {
  const { pipeline, run, source } = await fixture(t);
  const read = await pipeline.tool(run.id, 'read_source', { path: 'src/lib.rs', start: 1, end: 3 });
  const broad = await pipeline.tool(run.id, 'run_check', { check: 'test-integration', target }) as any;
  assert.equal(broad.result.status, 'passed'); assert.equal(broad.result.matched, 2); assert.deepEqual(broad.result.scenarioIds, []);
  assert.equal(broad.result.argv.includes('--exact'), false); assert.match(broad.result.note, /exploratory|exact.*scenario/i);
  const events = await pipeline.store.events(run.id), revision = fingerprint(await inventory(source));
  assert.throws(() => validateEvidence([read.evidenceId, broad.evidenceId], events, { 'src/lib.rs': hash(original) }, { 'src/lib.rs': [[1, 3]] }, revision, ['bug']), /passing.*scenario/);
  const exact = await pipeline.tool(run.id, 'run_check', { check: 'test-integration', target, test: bugTest }) as any;
  assert.deepEqual(exact.result.argv, checks.regressionCheck(regression)); assert.deepEqual(exact.result.scenarioIds, ['bug']); assert.equal(exact.result.matched, 1);
  const currentEvents = await pipeline.store.events(run.id);
  assert.doesNotThrow(() => validateEvidence([read.evidenceId, exact.evidenceId], currentEvents, { 'src/lib.rs': hash(original) }, { 'src/lib.rs': [[1, 3]] }, revision, ['bug']));
});

test('generated integration proof arguments execute the exact frozen bug test rather than the whole target', async t => {
  const { pipeline, run } = await fixture(t);
  const examples = evidence.candidateEvidenceChecks;
  assert.equal(typeof examples, 'function', 'Frozen scenario proof examples are required');
  const args = examples([regression, { ...regression, id: 'control', baseline: 'pass', testName: controlTest }]);
  assert.deepEqual(args, [{ check: 'test-integration', target, test: bugTest }]);
  const result = await pipeline.tool(run.id, 'run_check', args[0]) as { result: CheckResult };
  assert.deepEqual(result.result.argv, checks.regressionCheck(regression));
  assert.deepEqual(result.result.scenarioIds, ['bug']); assert.equal(result.result.matched, 1);
});

test('a whole integration target with zero executed tests remains no_match and exposes discovery names', async t => {
  const { pipeline, run, setEmpty } = await fixture(t); setEmpty();
  const broad = await pipeline.tool(run.id, 'run_check', { check: 'test-integration', target }) as any;
  assert.equal(broad.result.status, 'no_match'); assert.equal(broad.result.matched, 0); assert.deepEqual(broad.result.scenarioIds, []);
  assert.deepEqual(broad.result.suggestedTests, [bugTest, controlTest]); assert.match(broad.result.note, /no.*test|zero/i);
});

test('invalid exploratory targets and invalid supplied test names are rejected before container execution', async t => {
  const { pipeline, run, commands } = await fixture(t);
  for (const invalid of ['', '../escape', '--all-targets', 'cli/other', true, null]) await assert.rejects(pipeline.tool(run.id, 'run_check', { check: 'test-integration', target: invalid }));
  for (const invalid of ['', 'name with spaces', '--all', null, true, 42]) await assert.rejects(pipeline.tool(run.id, 'run_check', { check: 'test-integration', target, test: invalid }));
  assert.deepEqual(commands, []);
});

test('independent frozen acceptance still executes the exact named integration regression', async t => {
  const { pipeline, context, commands } = await fixture(t);
  const results = await (pipeline as any).acceptanceChecks(context, 'fixture-worker', 'final-regression', 'candidate');
  assert.deepEqual(commands.filter(argv => argv[0] === 'cargo'), [checks.regressionCheck(regression)]);
  assert.equal(results.length, 1); assert.equal(results[0].matched, 1); assert.deepEqual(results[0].scenarioIds, ['bug']);
});
