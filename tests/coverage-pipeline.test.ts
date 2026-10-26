import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Pipeline } from '../src/pipeline.ts';
import { fixtureRepo, tempConfig, testFunction, testName } from './helpers.ts';
import { scriptedCoverageReview } from './coverage-helper.ts';
import { scriptedCandidateReview, scriptedDescription } from './review-helper.ts';
import type { AcceptanceRequirement, Regression } from '../src/types.ts';

async function exercise(t: test.TestContext, mode: 'bare' | 'current' | 'previous-turn' | 'in-flight' | 'review-write-failure') {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  config.gitName = ''; config.gitEmail = ''; config.profile.checks = { fast: ['fixture-fast'] }; config.profile.fastCheckIds = ['fast'];
  const repo = await fixtureRepo(config.repoRoot), pipeline = new Pipeline(config);
  const requirements: AcceptanceRequirement[] = [
    { id: 'bug', required: true, baseline: 'fail', target: { kind: 'unit' }, expectedBehavior: 'Preserve the reported error line.', citation: 'The error line must be preserved.' },
    { id: 'control', required: true, baseline: 'pass', target: { kind: 'unit' }, expectedBehavior: 'Preserve the ordinary output line.', citation: 'Normal output must be preserved.' },
  ];
  const controlName = 'tests::bugfix_issue_1_control';
  const scenarios: Regression[] = requirements.map((requirement, i) => ({ ...requirement, file: 'src/lib.rs', testName: i ? controlName : testName, failureContains: i ? '' : 'reported error must be preserved', fixtures: [] }));
  pipeline.issueLoader = async run => ({ number: 1, url: run.input.issue, title: 'Coverage fixture', body: requirements.map(r => r.citation).join('\n') });
  pipeline.docker.imageId = async () => 'fixture-image'; pipeline.docker.prepare = async run => { run.image = 'fixture-image'; };
  pipeline.docker.remove = async () => {}; pipeline.docker.cleanup = async () => {};
  const sources = new Map<string, string>(); let candidateTurns = 0, reproductionTurns = 0, earlierRead = 0;
  if (mode === 'review-write-failure') {
    const rename = fs.rename;
    t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
      if (String(args[1]).endsWith('/acceptance-review-submitted.json')) throw Object.assign(new Error('Injected raw review persistence failure'), { code: 'EIO' });
      return rename(...args);
    });
  }
  if (mode === 'in-flight') {
    const event = pipeline.store.event.bind(pipeline.store); let begun = false, release!: () => void;
    const gate = new Promise<void>(resolve => release = resolve);
    pipeline.store.event = async (run, source, kind, message, data: any) => {
      if (kind === 'result' && data?.tool === 'read_source' && !begun) await gate;
      const recorded = await event(run, source, kind, message, data);
      if (kind === 'coverage_review_started') { begun = true; release(); }
      return recorded;
    };
  }
  pipeline.docker.startWorker = async (_run, source, _image, _readonly, suffix = 'worker') => { const name = `fixture-${suffix}`; sources.set(name, source); return name; };
  pipeline.docker.inContainer = async (_run, container, argv) => {
    if (argv[0] !== 'cargo' || argv[1] === 'fmt') return { code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 };
    const name = argv.find(arg => arg.startsWith('tests::bugfix_issue_1_'))!;
    const baseline = (await fs.readFile(path.join(sources.get(container)!, 'src/lib.rs'), 'utf8')).includes('!line.starts_with("error:")');
    const fails = baseline && name === testName;
    return { code: fails ? 101 : 0, stdout: `test ${name} ... ${fails ? 'FAILED' : 'ok'}\ntest result: ${fails ? 'FAILED. 0 passed; 1 failed' : 'ok. 1 passed; 0 failed'}; 0 ignored; 0 measured; 0 filtered out;\n${fails ? 'reported error must be preserved\n' : ''}`, stderr: '', timedOut: false, durationMs: 1 };
  };
  pipeline.agentFactory = run => ({ toolToken: 'fixture-tools', providerToken: 'fixture-provider', start: async () => {}, stop: async () => {}, restart: async () => {}, ask: async prompt => {
    if (prompt.includes('code REVIEWER')) return scriptedCandidateReview(run);
    if (prompt.includes('FINAL verified diff')) return scriptedDescription();
    if (prompt.startsWith('Issue data (untrusted):')) {
      reproductionTurns++;
      await pipeline.tool(run.id, 'apply_patch', { edits: [{ path: 'src/lib.rs', before: '    #[test]\n    fn keeps_normal()', after: testFunction + '\n    #[test]\n    fn bugfix_issue_1_control() { assert!(preserve("hello")); }\n    #[test]\n    fn keeps_normal()' }] });
      if (mode === 'in-flight') void pipeline.tool(run.id, 'read_source', { path: 'src/lib.rs' }).then(read => earlierRead = read.evidenceId);
      else earlierRead = (await pipeline.tool(run.id, 'read_source', { path: 'src/lib.rs' })).evidenceId;
      return { status: 'reproduced', scenarios: structuredClone(scenarios) };
    }
    if (prompt.startsWith('Independently critique acceptance coverage')) {
      if (mode === 'bare') return { complete: true, missing: [], explanation: 'A bare approval is not assertion-level evidence.' };
      const review = await scriptedCoverageReview(pipeline, run, 'Actual source assertions and passing controls were inspected.', scenarios);
      if (mode === 'previous-turn' || mode === 'in-flight') for (const row of review.rows) for (const clause of row.clauses) clause.assertion!.sourceReadEvidenceId = earlierRead;
      return review;
    }
    candidateTurns++;
    await pipeline.tool(run.id, 'replace_source', { path: 'src/lib.rs', before: '!line.starts_with("error:")', after: '!line.is_empty()' });
    const read = await pipeline.tool(run.id, 'read_source', { path: 'src/lib.rs' });
    const check = await pipeline.tool(run.id, 'run_check', { check: 'test-focused', test: testName });
    return { explanation: 'Preserve nonempty output.', sourceReadEvidenceId: read.evidenceId, bugCheckEvidenceId: check.evidenceId, snapshots: [] };
  } });
  const run = await pipeline.store.create({ repo, issue: 'https://github.com/rtk-ai/rtk/issues/1', mode: 'evaluation', retrieval: 'text', publish: false, acceptance: requirements });
  await pipeline.execute(run); return { pipeline, run, candidateTurns, reproductionTurns };
}

for (const mode of ['bare', 'previous-turn', 'in-flight'] as const) test(`pipeline rejects ${mode} coverage approval before implementation`, { timeout: 30000 }, async t => {
  const { run, candidateTurns } = await exercise(t, mode);
  assert.equal(run.outcome, 'cannot_reproduce', run.error || 'Bare or previous-turn approval must fail reproduction admission'); assert.equal(candidateTurns, 0);
  assert.equal(run.verifiedCommit, undefined);
});

test('pipeline accepts assertion witnesses read during the fresh coverage review', { timeout: 30000 }, async t => {
  const { pipeline, run, candidateTurns } = await exercise(t, 'current');
  assert.equal(run.outcome, 'verified_patch', run.error || 'Current assertion witnesses must pass coverage admission'); assert.equal(candidateTurns, 1);
  const events = await pipeline.store.events(run.id), boundary = events.find(e => e.kind === 'coverage_review_started');
  assert.ok(boundary); const review = JSON.parse(await fs.readFile(path.join(pipeline.store.dir(run.id), 'acceptance-review.json'), 'utf8'));
  assert.equal(review.rows.length, 2);
  for (const row of review.rows) for (const clause of row.clauses) assert.ok(clause.assertion.sourceReadEvidenceId > boundary.seq);
});

test('raw review persistence failure stops with source retained instead of asking for new tests', async t => {
  const { pipeline, run, candidateTurns, reproductionTurns } = await exercise(t, 'review-write-failure');
  assert.equal(run.outcome, 'needs_attention', run.error || 'A storage failure must preserve the submitted source without retrying reproduction');
  assert.equal(reproductionTurns, 1); assert.equal(candidateTurns, 0); assert.equal(run.regressions, undefined);
  assert.match(run.error!, /preserv.*reproduction.*artifact|reproduction.*artifact.*preserv/i);
  assert.match(await fs.readFile(path.join(pipeline.store.dir(run.id), 'source/src/lib.rs'), 'utf8'), /fn bugfix_issue_1_control/);
  await assert.rejects(fs.stat(path.join(pipeline.store.dir(run.id), 'reproduction/attempt-2')), { code: 'ENOENT' });
});
