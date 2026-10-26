import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Pipeline, RunFailure } from '../src/pipeline.ts';
import { fingerprint, inventory } from '../src/files.ts';
import { checked } from '../src/process.ts';
import { fixtureRepo, tempConfig, testFunction, testName } from './helpers.ts';
import { scriptedCoverageReview } from './coverage-helper.ts';
import { scriptedCandidateReview, scriptedDescription } from './review-helper.ts';
import type { AcceptanceRequirement, Regression } from '../src/types.ts';

async function exercise(t: test.TestContext, failure?: 'copy' | 'existing' | 'cannot-fix') {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = await fixtureRepo(config.repoRoot), pipeline = new Pipeline(config);
  config.profile.checks = { fast: ['fixture-fast'] }; config.profile.fastCheckIds = ['fast'];
  const bytes = Buffer.from([0, 255, 128, 192, 10, 1]);
  await fs.mkdir(path.join(repo, 'tests/fixtures'), { recursive: true }); await fs.writeFile(path.join(repo, 'tests/fixtures/raw.bin'), bytes);
  await fs.writeFile(path.join(repo, 'src/executable.sh'), '#!/bin/sh\nexit 0\n'); await fs.chmod(path.join(repo, 'src/executable.sh'), 0o751);
  checked(await pipeline.repository.git(repo, ['add', '-A']), 'Stage binary/mode fixture');
  checked(await pipeline.repository.git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-m', 'binary and executable fixture']), 'Commit local fixture');
  const requirements: AcceptanceRequirement[] = [
    { id: 'bug', required: true, baseline: 'fail', target: { kind: 'unit' }, expectedBehavior: 'Preserve reported error output.', citation: 'The error line must be preserved.' },
    { id: 'control', required: true, baseline: 'pass', target: { kind: 'unit' }, expectedBehavior: 'Preserve ordinary normal output.', citation: 'Normal output must be preserved.' },
  ];
  const controlName = 'tests::bugfix_issue_1_normal';
  const scenarios: Regression[] = requirements.map((requirement, index) => ({ ...requirement, file: 'src/lib.rs', testName: index ? controlName : testName, failureContains: index ? '' : 'reported error must be preserved', fixtures: [] }));
  pipeline.issueLoader = async run => ({ number: 1, url: run.input.issue, title: 'Fixture', body: requirements.map(r => r.citation).join('\n') });
  pipeline.docker.imageId = async () => 'fixture-image'; pipeline.docker.prepare = async run => { run.image = 'fixture-image'; };
  pipeline.docker.remove = async () => {}; pipeline.docker.cleanup = async () => {};
  const sources = new Map<string, string>();
  pipeline.docker.startWorker = async (_run, source, _image, _readonly, suffix = 'worker') => { const name = `fixture-${suffix}`; sources.set(name, source); return name; };
  pipeline.docker.inContainer = async (_run, container, argv) => {
    let stdout = '', code = 0;
    if (argv[0] === 'cargo') {
      const name = argv.find(arg => arg.startsWith('tests::bugfix_issue_1_'))!;
      const current = await fs.readFile(path.join(sources.get(container)!, 'src/lib.rs'), 'utf8');
      const fails = name === testName && current.includes('!line.starts_with("error:")'); code = fails ? 101 : 0;
      stdout = `test ${name} ... ${fails ? 'FAILED' : 'ok'}\ntest result: ${fails ? 'FAILED' : 'ok'}. ${fails ? '0 passed; 1 failed' : '1 passed; 0 failed'}; 0 ignored;\n${fails ? 'reported error must be preserved\n' : ''}`;
    }
    return { code, stdout, stderr: '', timedOut: false, durationMs: 1 };
  };
  if (failure === 'copy') {
    const copy = fs.cp;
    t.mock.method(fs, 'cp', async (...args: Parameters<typeof fs.cp>) => {
      if (String(args[1]).endsWith('/rejected/source')) throw new Error('fixture snapshot copy failure');
      return copy(...args);
    });
  }
  const submissions: any[] = [], expected: Record<string, string>[] = [], resetStates: { originalPredicate: boolean; candidateFileAbsent: boolean }[] = [];
  let turns = 0, resets = 0;
  const revert = (pipeline as any).revertCandidate.bind(pipeline);
  (pipeline as any).revertCandidate = async (...args: unknown[]) => { resets++; return revert(...args); };
  pipeline.agentFactory = run => ({
    toolToken: '', providerToken: '', start: async () => {}, stop: async () => {}, restart: async () => {},
    ask: async prompt => {
      if (prompt.includes('code REVIEWER')) return scriptedCandidateReview(run);
      if (prompt.includes('FINAL verified diff')) return scriptedDescription();
      if (prompt.startsWith('Read the issue as evidence:')) return { requirements };
      if (prompt.startsWith('Independently critique acceptance coverage')) return scriptedCoverageReview(pipeline, run, 'Error and normal-output control both assert the required behavior.', scenarios);
      if (prompt.startsWith('Issue data (untrusted):')) {
        await pipeline.tool(run.id, 'apply_patch', { edits: [{ path: 'src/lib.rs', before: '    #[test]\n    fn keeps_normal()', after: testFunction + '\n    #[test]\n    fn bugfix_issue_1_normal() { assert!(preserve("hello")); }\n\n    #[test]\n    fn keeps_normal()' }] });
        return { status: 'reproduced', scenarios };
      }
      turns++;
      if (turns > 5) { pipeline.contexts.get(run.id)!.abort.abort(new RunFailure('cancelled', 'Fixture guard: repeated rejection did not terminate')); pipeline.contexts.get(run.id)!.abort.signal.throwIfAborted(); }
      const source = path.join(pipeline.store.dir(run.id), 'source');
      resetStates.push({ originalPredicate: (await fs.readFile(path.join(source, 'src/lib.rs'), 'utf8')).includes('!line.starts_with("error:")'), candidateFileAbsent: !(await fs.stat(path.join(source, 'src/candidate-only.txt')).catch(() => null)) });
      await pipeline.tool(run.id, 'apply_patch', { edits: [
        { path: 'src/lib.rs', before: '!line.starts_with("error:")', after: '!line.is_empty()' },
        { path: 'src/candidate-only.txt', before: '', after: turns === 1 ? 'first submitted source\n' : 'later submitted source\n' },
      ] });
      await fs.chmod(path.join(source, 'src/executable.sh'), 0o751);
      if (failure === 'existing') {
        const old = path.join(pipeline.store.dir(run.id), 'candidates/1/rejected'); await fs.mkdir(old, { recursive: true }); await fs.writeFile(path.join(old, 'sentinel.bin'), bytes);
      }
      expected.push(await inventory(source));
      // First rejection assigns run.candidate. Later malformed IDs reject before assignment,
      // so preservation must use this raw answer and current source, never the stale candidate.
      const answer = failure === 'cannot-fix' ? { cannot_fix: 'No safe implementation was established.' } : { explanation: turns === 1 ? 'first submitted answer' : 'later raw answer before normalization', evidenceIds: turns === 1 ? [999997, 999998] : ['not-an-event-id', 999998], snapshots: [], extraResearchField: { turn: turns }, ...(turns > 1 ? { sourceReadEvidenceId: 'not-an-event-id', bugCheckEvidenceId: 'also-not-an-event-id' } : {}) };
      submissions.push(structuredClone(answer)); return answer;
    },
  });
  const run = await pipeline.store.create({ repo, issue: 'https://github.com/rtk-ai/rtk/issues/1', mode: 'evaluation', retrieval: 'text', publish: false });
  await pipeline.execute(run);
  return { pipeline, run, submissions, expected, resetStates, turns, resets, bytes };
}

test('wrong-proof submissions survive rollback and the terminal repeated-rejection stop as exact immutable snapshots', { timeout: 20000 }, async t => {
  const { pipeline, run, submissions, expected, resetStates, turns, resets, bytes } = await exercise(t);
  assert.equal(run.outcome, 'needs_attention', run.error); assert.equal(turns, 4); assert.equal(resets, 3);
  assert.ok(resetStates.every(state => state.originalPredicate && state.candidateFileAbsent));
  const events = await pipeline.store.events(run.id), preserved = events.filter(event => event.kind === 'candidate_preserved');
  assert.equal(preserved.length, 4, 'including the final unchanged rejection before needs_attention');
  const originalHashes: string[] = [];
  for (let index = 0; index < turns; index++) {
    const relative = `candidates/${index + 1}/rejected`, dir = path.join(pipeline.store.dir(run.id), relative);
    const actual = await inventory(path.join(dir, 'source')); originalHashes.push(fingerprint(actual));
    assert.deepEqual(actual, expected[index]);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'inventory.json'), 'utf8')), expected[index]);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'submitted-answer.json'), 'utf8')), submissions[index]);
    assert.deepEqual(await fs.readFile(path.join(dir, 'source/tests/fixtures/raw.bin')), bytes);
    assert.equal((await fs.stat(path.join(dir, 'source/src/executable.sh'))).mode & 0o777, 0o751);
    const metadata = JSON.parse(await fs.readFile(path.join(dir, 'rejection.json'), 'utf8'));
    assert.equal(metadata.state, 'complete'); assert.equal(metadata.attempt, index + 1); assert.equal(metadata.sourceHash, fingerprint(expected[index]));
    assert.deepEqual(metadata.eventRefs.submittedEvidenceIds, submissions[index].evidenceIds);
    assert.deepEqual(metadata.eventRefs.submittedSourceReadEvidenceId, submissions[index].sourceReadEvidenceId ?? null);
    assert.deepEqual(metadata.eventRefs.submittedBugCheckEvidenceId, submissions[index].bugCheckEvidenceId ?? null);
    assert.ok(Number.isSafeInteger(metadata.eventRefs.throughSeq) && metadata.eventRefs.throughSeq < preserved[index].seq);
    assert.equal((preserved[index].data as any).artifact, relative);
  }
  assert.notEqual(originalHashes[0], originalHashes[1]); assert.equal(new Set(originalHashes.slice(1)).size, 1);
  assert.equal(run.candidate!.explanation, submissions[0].explanation, 'normalization failures leave an intentionally stale candidate');
  assert.equal(await fs.readFile(path.join(pipeline.store.dir(run.id), 'candidates/1/rejected/source/src/candidate-only.txt'), 'utf8'), 'first submitted source\n');
  assert.equal(fingerprint(await inventory(path.join(pipeline.store.dir(run.id), 'source'))), originalHashes.at(-1));
  assert.ok(events.filter(event => event.kind === 'candidate_rejected').every(event => Number.isSafeInteger((event.data as any)?.preservedCandidate?.eventSeq)));
  assert.equal(run.verifiedTree, undefined); assert.equal(run.verifiedCommit, undefined);
});

test('a failed rejection snapshot stops clearly without resetting the submitted source', { timeout: 20000 }, async t => {
  const { pipeline, run, turns, resets, expected } = await exercise(t, 'copy');
  assert.equal(run.outcome, 'needs_attention', run.error); assert.equal(turns, 1); assert.equal(resets, 0);
  assert.match(run.error!, /preserv.*rejected candidate/i); assert.match(run.error!, /source.*not.*reset|source.*retained/i);
  assert.equal(fingerprint(await inventory(path.join(pipeline.store.dir(run.id), 'source'))), fingerprint(expected[0]));
  assert.equal((await pipeline.store.events(run.id)).filter(event => event.kind === 'candidate_preserved').length, 0);
  await assert.rejects(fs.stat(path.join(pipeline.store.dir(run.id), 'candidates/1/rejected/rejection.json')), { code: 'ENOENT' });
});

test('an existing rejected snapshot is never overwritten or followed by a source reset', { timeout: 20000 }, async t => {
  const { pipeline, run, resets, turns, bytes, expected } = await exercise(t, 'existing');
  assert.equal(run.outcome, 'needs_attention', run.error); assert.equal(turns, 1); assert.equal(resets, 0);
  assert.match(run.error!, /preserv.*rejected candidate/i);
  assert.deepEqual(await fs.readFile(path.join(pipeline.store.dir(run.id), 'candidates/1/rejected/sentinel.bin')), bytes);
  assert.equal(fingerprint(await inventory(path.join(pipeline.store.dir(run.id), 'source'))), fingerprint(expected[0]));
});

test('cannot_fix edits and raw answers survive every rollback including the terminal stop', { timeout: 20000 }, async t => {
  const { pipeline, run, expected, submissions, turns, resets } = await exercise(t, 'cannot-fix');
  assert.equal(run.outcome, 'needs_attention', run.error); assert.equal(turns, 4); assert.equal(resets, 3);
  const events = await pipeline.store.events(run.id);
  assert.equal(events.filter(event => event.kind === 'candidate_preserved').length, turns);
  for (let attempt = 1; attempt <= turns; attempt++) {
    const dir = path.join(pipeline.store.dir(run.id), `candidates/${attempt}/rejected`);
    assert.deepEqual(await inventory(path.join(dir, 'source')), expected[attempt - 1]);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'submitted-answer.json'), 'utf8')), submissions[attempt - 1]);
  }
  const checkpoint = JSON.parse(await fs.readFile(path.join(pipeline.store.dir(run.id), 'repair-checkpoint.json'), 'utf8'));
  assert.equal(checkpoint.sourceHash, fingerprint(expected.at(-1)!));
  assert.ok(checkpoint.changedFiles.includes('src/candidate-only.txt'));
  assert.ok(events.filter(event => event.kind === 'candidate_rejected').every(event => (event.data as any)?.preservedCandidate?.artifact));
  assert.equal(run.verifiedCommit, undefined);
});
