import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Pipeline } from '../src/pipeline.ts';
import { fixtureRepo, tempConfig, testFunction, testName } from './helpers.ts';
import { scriptedCoverageReview } from './coverage-helper.ts';
import { scriptedCandidateReview, scriptedDescription } from './review-helper.ts';
import type { AcceptanceRequirement, Regression } from '../src/types.ts';

type ProofMode = 'current' | 'unknown' | 'duplicate' | 'stale' | 'module' | 'named-current' | 'named-string' | 'named-swapped' | 'named-unknown' | 'named-stale' | 'named-module' | 'named-control' | 'named-duplicate' | 'named-mixed' | 'named-partial' | 'named-all-checks';
async function exercise(t: test.TestContext, mode: ProofMode) {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = await fixtureRepo(config.repoRoot), pipeline = new Pipeline(config);
  config.gitName = ''; config.gitEmail = ''; // This fixture verifies locally without creating a candidate commit.
  config.profile.checks = { fast: ['fixture-fast'] }; config.profile.fastCheckIds = ['fast'];
  const requirements: AcceptanceRequirement[] = [
    { id: 'bug', required: true, baseline: 'fail', target: { kind: 'unit' }, expectedBehavior: 'Preserve reported error output.', citation: 'The error line must be preserved.' },
    { id: 'control', required: true, baseline: 'pass', target: { kind: 'unit' }, expectedBehavior: 'Preserve ordinary normal output.', citation: 'Normal output must be preserved.' },
  ];
  const controlName = 'tests::bugfix_issue_1_normal';
  const scenarios: Regression[] = requirements.map((requirement, index) => ({ ...requirement, file: 'src/lib.rs', testName: index ? controlName : testName, failureContains: index ? '' : 'reported error must be preserved', fixtures: [] }));
  pipeline.issueLoader = async run => ({ number: 1, url: run.input.issue, title: 'Fixture', body: requirements.map(r => r.citation).join('\n') });
  pipeline.docker.imageId = async () => 'fixture-image'; pipeline.docker.prepare = async run => { run.image = 'fixture-image'; };
  pipeline.docker.remove = async () => {}; pipeline.docker.cleanup = async () => {};
  const sources = new Map<string, string>(), prompts: string[] = [], rawAnswers: any[] = [], rawAnswerCopies: any[] = [];
  const executedExamples: unknown[] = [], agentPhases: unknown[] = [];
  pipeline.docker.startWorker = async (_run, source, _image, _readonly, suffix = 'worker') => { const name = `fixture-${suffix}`; sources.set(name, source); return name; };
  pipeline.docker.inContainer = async (_run, container, argv) => {
    let stdout = '', code = 0;
    if (argv[0] === 'cargo' && argv[1] !== 'fmt') {
      const names = argv.includes('--exact') ? [argv.find(arg => arg.startsWith('tests::bugfix_issue_1_'))!] : [testName, controlName];
      const current = await fs.readFile(path.join(sources.get(container)!, 'src/lib.rs'), 'utf8');
      const fails = current.includes('!line.starts_with("error:")') && names.includes(testName); code = fails ? 101 : 0;
      stdout = names.map(name => `test ${name} ... ${fails && name === testName ? 'FAILED' : 'ok'}\n`).join('')
        + `test result: ${fails ? 'FAILED' : 'ok'}. ${names.length - (fails ? 1 : 0)} passed; ${fails ? 1 : 0} failed; 0 ignored; 0 measured; 0 filtered out;\n${fails ? 'reported error must be preserved\n' : ''}`;
    }
    return { code, stdout, stderr: '', timedOut: false, durationMs: 1 };
  };
  pipeline.agentFactory = run => ({
    toolToken: 'fixture-tools', providerToken: 'fixture-provider', start: async () => {}, stop: async () => {}, restart: async () => {},
    ask: async (prompt, _signal, _valid, phase) => {
      agentPhases.push(phase);
      if (prompt.includes('code REVIEWER')) return scriptedCandidateReview(run);
      if (prompt.includes('FINAL verified diff')) return scriptedDescription();
      if (prompt.startsWith('Read the issue as evidence:')) return { requirements };
      if (prompt.startsWith('Independently critique acceptance coverage')) return scriptedCoverageReview(pipeline, run, 'The error case and ordinary control are present.', scenarios);
      if (prompt.startsWith('Issue data (untrusted):')) {
        await pipeline.tool(run.id, 'apply_patch', { edits: [{ path: 'src/lib.rs', before: '    #[test]\n    fn keeps_normal()', after: testFunction + '\n    #[test]\n    fn bugfix_issue_1_normal() { assert!(preserve("hello")); }\n\n    #[test]\n    fn keeps_normal()' }] });
        return { status: 'reproduced', scenarios };
      }
      prompts.push(prompt);
      const staleRead = mode.endsWith('stale') ? await pipeline.tool(run.id, 'read_source', { path: 'src/lib.rs' }) : undefined;
      await pipeline.tool(run.id, 'apply_patch', { edits: [{ path: 'src/lib.rs', before: '!line.starts_with("error:")', after: '!line.is_empty()' }] });
      const read = staleRead || await pipeline.tool(run.id, 'read_source', { path: 'src/lib.rs' });
      const examples = /Exact frozen bug-scenario run_check arguments: ([^\n]+)/.exec(prompt)?.[1];
      const exactArgs = examples ? JSON.parse(examples)[0] : { check: 'test-focused', test: testName };
      executedExamples.push(exactArgs);
      const checked = await pipeline.tool(run.id, 'run_check', mode.endsWith('module') ? { check: 'test-module', test: 'tests' } : mode === 'named-control' ? { check: 'test-focused', test: controlName } : exactArgs);
      const evidenceIds = mode === 'unknown' ? [String(read.evidenceId), '99999999'] : mode === 'duplicate' ? [read.evidenceId, String(read.evidenceId)] : [String(read.evidenceId), String(checked.evidenceId)];
      const answer: any = { explanation: 'The current predicate preserves reported errors and ordinary output.', evidenceIds, snapshots: [] };
      if (mode.startsWith('named-')) {
        delete answer.evidenceIds;
        answer.sourceReadEvidenceId = mode === 'named-string' ? String(read.evidenceId) : mode === 'named-swapped' ? checked.evidenceId : read.evidenceId;
        answer.bugCheckEvidenceId = mode === 'named-string' ? String(checked.evidenceId) : mode === 'named-swapped' ? read.evidenceId : mode === 'named-unknown' ? 99999999 : mode === 'named-duplicate' ? String(read.evidenceId) : checked.evidenceId;
        if (mode === 'named-mixed') answer.evidenceIds = evidenceIds;
        if (mode === 'named-partial') delete answer.bugCheckEvidenceId;
        if (mode === 'named-all-checks') { answer.sourceReadEvidenceId = checked.evidenceId; answer.bugCheckEvidenceId = (await pipeline.tool(run.id, 'run_check', exactArgs)).evidenceId; }
      }
      rawAnswerCopies.push(structuredClone(answer));
      rawAnswers.push(answer); return answer;
    },
  });
  const run = await pipeline.store.create({ repo, issue: 'https://github.com/rtk-ai/rtk/issues/1', mode: 'evaluation', retrieval: 'text', publish: false });
  await pipeline.execute(run);
  return { run, pipeline, prompts, rawAnswers, rawAnswerCopies, executedExamples, agentPhases, events: await pipeline.store.events(run.id) };
}

test('the pipeline accepts actual current string IDs, persists numeric candidates, and preserves raw answers', { timeout: 20000 }, async t => {
  const { run, pipeline, prompts, rawAnswers, executedExamples, agentPhases, events } = await exercise(t, 'current');
  assert.equal(run.outcome, 'verified_patch', run.error);
  assert.deepEqual(agentPhases, ['review', 'reproduction', 'review', 'patching', 'candidate-review', 'describe']);
  assert.ok(run.candidate!.evidenceIds.every(id => typeof id === 'number'));
  assert.ok((await pipeline.store.get(run.id)).candidate!.evidenceIds.every(id => typeof id === 'number'));
  assert.ok(rawAnswers.every(answer => answer.evidenceIds.every((id: unknown) => typeof id === 'string')));
  const normalized = events.filter(event => event.kind === 'evidence_normalized'); assert.equal(normalized.length, 1);
  assert.deepEqual((normalized[0].data as any).evidenceIds, run.candidate!.evidenceIds);
  const proof = events.find(event => event.seq === run.candidate!.evidenceIds[1])!;
  assert.deepEqual((proof.data as any).result.scenarioIds, ['bug']); assert.equal((proof.data as any).result.matched, 1);
  assert.deepEqual(executedExamples, [{ check: 'test-focused', test: testName }]);
  assert.match(prompts[0], /"sourceReadEvidenceId":123,"bugCheckEvidenceId":456/);
  assert.match(prompts[0], /JSON numbers/); assert.match(prompts[0], /actual.*evidenceId/);
  assert.match(prompts[0], /module.*whole.target|whole.target.*module/i);
});

for (const mode of ['named-current', 'named-string'] as const) test(`the real pipeline accepts ${mode} proof, preserves raw fields and persists canonical numeric IDs`, { timeout: 20000 }, async t => {
  const { run, pipeline, rawAnswers, rawAnswerCopies, events } = await exercise(t, mode);
  assert.equal(run.outcome, 'verified_patch', run.error);
  assert.deepEqual(rawAnswers, rawAnswerCopies);
  assert.ok(rawAnswers.every(answer => !Object.hasOwn(answer, 'evidenceIds')));
  if (mode === 'named-string') assert.ok(rawAnswers.every(answer => typeof answer.sourceReadEvidenceId === 'string' && typeof answer.bugCheckEvidenceId === 'string'));
  assert.ok(run.candidate!.evidenceIds.every(id => typeof id === 'number'));
  assert.deepEqual((await pipeline.store.get(run.id)).candidate!.evidenceIds, run.candidate!.evidenceIds);
  const proofs = run.candidate!.evidenceIds.map(id => events.find(event => event.seq === id)!);
  assert.deepEqual(proofs.map(event => (event.data as any).tool), ['read_source', 'run_check']);
  assert.deepEqual((proofs[1].data as any).result.scenarioIds, ['bug']);
  const normalized = events.filter(event => event.kind === 'evidence_normalized'); assert.equal(normalized.length, 1);
  assert.deepEqual((normalized[0].data as any).evidenceIds, run.candidate!.evidenceIds);
});

for (const mode of ['named-swapped', 'named-unknown', 'named-stale', 'named-module', 'named-control', 'named-duplicate', 'named-mixed', 'named-partial', 'named-all-checks'] as const) test(`named proof contract rejects ${mode} in the real pipeline`, { timeout: 20000 }, async t => {
  const { run, rawAnswers, rawAnswerCopies } = await exercise(t, mode);
  assert.equal(run.outcome, 'needs_attention', run.error); assert.equal(run.verifiedTree, undefined);
  assert.deepEqual(rawAnswers, rawAnswerCopies);
  const reason = mode === 'named-swapped' || mode === 'named-all-checks' ? /sourceReadEvidenceId.*read_source/ : mode === 'named-unknown' ? /not a recorded tool result/ : mode === 'named-stale' ? /stale/ : mode === 'named-duplicate' ? /unique/ : mode === 'named-mixed' ? /mixed|either|both.*legacy/i : mode === 'named-partial' ? /both.*sourceReadEvidenceId.*bugCheckEvidenceId/ : /passing.*scenario/;
  assert.match(run.error!, reason);
});

for (const mode of ['unknown', 'duplicate', 'stale', 'module'] as const) test(`canonical evidence strings do not admit ${mode} proof in the real pipeline`, { timeout: 20000 }, async t => {
  const { run, events } = await exercise(t, mode);
  assert.equal(run.outcome, 'needs_attention', run.error); assert.equal(run.verifiedTree, undefined);
  const rejected = events.filter(event => event.kind === 'candidate_rejected'); assert.equal(rejected.length, 2);
  const reason = mode === 'unknown' ? /not a recorded tool result/ : mode === 'duplicate' ? /unique/ : mode === 'stale' ? /stale/ : /passing.*scenario/;
  assert.match(run.error!, reason);
  if (mode === 'module') {
    const result = events.find(event => event.source === 'tool' && event.kind === 'result' && (event.data as any).result?.matched === 2)!;
    assert.deepEqual((result.data as any).result.scenarioIds, []);
  }
});
