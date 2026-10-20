import test from 'node:test';
import assert from 'node:assert/strict';
import { ProgressTracker } from '../src/progress.ts';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Pipeline, RunFailure } from '../src/pipeline.ts';
import { fixtureRepo, tempConfig, testFunction, testName } from './helpers.ts';
import type { AcceptanceRequirement, Regression } from '../src/types.ts';

test('repeated unchanged verdicts request attention while changed work resets diagnosis', () => {
  const tracker = new ProgressTracker();
  assert.equal(tracker.record('same-tree', 'cannot fix'), false);
  assert.equal(tracker.record('same-tree', 'cannot fix'), false);
  assert.equal(tracker.record('changed-tree', 'cannot fix'), false);
  assert.equal(tracker.record('changed-tree', 'cannot fix'), false);
  assert.equal(tracker.record('changed-tree', 'cannot fix'), true);
});
test('changing artifact paths do not hide an identical failed formatting loop', () => {
  const tracker=new ProgressTracker();
  const results=[1,2,3].map(n=>tracker.record('same-tree',`Error: fmt failed; see event/log evidence candidates/${n}/attempt-${n}-fmt.log\nDiff in /workspace/src/lib.rs:3`));
  assert.deepEqual(results,[false,false,true]);
});

test('independent verdict categories use the stable check identity and reset for a different check or source', () => {
  const tracker = new ProgressTracker(); const observed: boolean[] = [];
  assert.doesNotThrow(() => {
    for (const [revision, checkId] of [['source-a', 'test-workspace'], ['source-a', 'test-workspace'], ['source-a', 'test-oss'], ['source-a', 'test-oss'], ['source-b', 'test-oss'], ['source-b', 'test-oss'], ['source-b', 'test-oss']]) {
      observed.push(tracker.record(revision, { kind: 'profile-check', checkId }));
    }
  });
  assert.deepEqual(observed, [false, false, false, false, false, false, true]);
  for (let revision = 0; revision < 10; revision++) assert.equal(tracker.record(`productive-source-${revision}`, { kind: 'profile-check', checkId: 'test-oss' }), false);
});

test('three unchanged independent full-suite failures stop the pipeline despite varying output durations', { timeout: 20000 }, async t => {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = await fixtureRepo(config.repoRoot), pipeline = new Pipeline(config);
  config.profile.checks = { fast: ['fixture-fast'], 'test-workspace': ['fixture-full-suite'] }; config.profile.fastCheckIds = ['fast'];
  const requirements: AcceptanceRequirement[] = [
    { id: 'error', required: true, baseline: 'fail', target: { kind: 'unit' }, expectedBehavior: 'Preserve reported error output.', citation: 'The error line must be preserved.' },
    { id: 'control', required: true, baseline: 'pass', target: { kind: 'unit' }, expectedBehavior: 'Preserve ordinary normal output.', citation: 'Normal output must be preserved.' },
  ];
  const controlName = 'tests::bugfix_issue_1_normal';
  const scenarios: Regression[] = requirements.map((requirement, index) => ({ ...requirement, file: 'src/lib.rs', testName: index ? controlName : testName, failureContains: index ? '' : 'reported error must be preserved', fixtures: [] }));
  pipeline.issueLoader = async run => ({ number: 1, url: run.input.issue, title: 'Fixture', body: requirements.map(requirement => requirement.citation).join('\n') });
  pipeline.docker.imageId = async () => 'fixture-image'; pipeline.docker.prepare = async run => { run.image = 'fixture-image'; };
  pipeline.docker.remove = async () => {}; pipeline.docker.cleanup = async () => {};
  const sources = new Map<string, string>(); let finalFailures = 0, candidateTurns = 0;
  pipeline.docker.startWorker = async (_run, source, _image, _readonly, suffix = 'worker') => { const name = `fixture-${suffix}`; sources.set(name, source); return name; };
  pipeline.docker.inContainer = async (run, container, argv) => {
    let stdout = '', code = 0;
    if (argv[0] === 'fixture-full-suite') {
      finalFailures++;
      // Bound the broken implementation without invoking Docker, a model, or a long retry loop.
      if (finalFailures === 4) {
        const context = pipeline.contexts.get(run.id)!; context.abort.abort(new RunFailure('cancelled', 'Fixture guard: repeated independent verdict was never counted')); context.abort.signal.throwIfAborted();
      }
      stdout = `running 1 test\ntest tests::full_suite ... FAILED\ntest result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.${finalFailures}23s\n`; code = 101;
    } else if (argv[0] === 'cargo') {
      const name = argv.find(arg => arg.startsWith('tests::bugfix_issue_1_'))!;
      const current = await fs.readFile(path.join(sources.get(container)!, 'src/lib.rs'), 'utf8');
      const fails = name === testName && current.includes('!line.starts_with("error:")'); code = fails ? 101 : 0;
      stdout = `running 1 test\ntest ${name} ... ${fails ? 'FAILED' : 'ok'}\ntest result: ${fails ? 'FAILED' : 'ok'}. ${fails ? '0 passed; 1 failed' : '1 passed; 0 failed'}; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n${fails ? 'reported error must be preserved\n' : ''}`;
    }
    return { code, stdout, stderr: '', timedOut: false, durationMs: finalFailures * 100 + 1 };
  };
  pipeline.agentFactory = run => ({
    toolToken: 'fixture-tools', providerToken: 'fixture-provider', start: async () => {}, stop: async () => {}, restart: async () => {},
    ask: async prompt => {
      if (prompt.startsWith('Read the issue as evidence:')) return { requirements };
      if (prompt.startsWith('Independently critique acceptance coverage')) return { complete: true, missing: [], explanation: 'The fixture covers error output and an ordinary-output control.' };
      if (prompt.startsWith('Issue data (untrusted):')) {
        await pipeline.tool(run.id, 'apply_patch', { edits: [{ path: 'src/lib.rs', before: '    #[test]\n    fn keeps_normal()', after: testFunction + '\n    #[test]\n    fn bugfix_issue_1_normal() { assert!(preserve("hello")); }\n\n    #[test]\n    fn keeps_normal()' }] });
        return { status: 'reproduced', scenarios };
      }
      candidateTurns++;
      const sourceFile = path.join(pipeline.store.dir(run.id), 'source/src/lib.rs');
      if ((await fs.readFile(sourceFile, 'utf8')).includes('!line.starts_with("error:")')) await pipeline.tool(run.id, 'apply_patch', { edits: [{ path: 'src/lib.rs', before: '!line.starts_with("error:")', after: '!line.is_empty()' }] });
      const read = await pipeline.tool(run.id, 'read_source', { path: 'src/lib.rs' });
      const check = await pipeline.tool(run.id, 'run_check', { check: 'test-focused', test: testName });
      return { explanation: 'The fixture changes the predicate but still fails the independent complete suite.', evidenceIds: [read.evidenceId, check.evidenceId], snapshots: [] };
    },
  });
  const run = await pipeline.store.create({ repo, issue: 'https://github.com/rtk-ai/rtk/issues/1', mode: 'evaluation', retrieval: 'text', publish: false });
  await pipeline.execute(run);
  assert.equal(run.outcome, 'needs_attention', run.error); assert.equal(finalFailures, 3); assert.equal(candidateTurns, 3);
  assert.equal(run.verifiedCommit, undefined); assert.equal((await pipeline.store.get(run.id)).outcome, 'needs_attention');
  const verdicts = (await pipeline.store.events(run.id)).filter(event => event.kind === 'verification_rejected');
  assert.equal(verdicts.length, 3);
  assert.ok(verdicts.every(event => (event.data as any)?.category?.kind === 'profile-check' && (event.data as any)?.category?.checkId === 'test-workspace'));
  assert.ok(verdicts.every(event => (event.data as any)?.sourceHash === run.candidate?.candidateRevision && typeof (event.data as any)?.sourceHash === 'string'));
  assert.equal(new Set(verdicts.map(event => (event.data as any).sourceHash)).size, 1);
});
