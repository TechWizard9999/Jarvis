import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Pipeline, RunFailure } from '../src/pipeline.ts';
import { fingerprint, inventory } from '../src/files.ts';
import { scriptedCoverageReview } from './coverage-helper.ts';
import { fixtureRepo, tempConfig } from './helpers.ts';
import type { AcceptanceRequirement, Regression } from '../src/types.ts';

const file = 'tests/bugfix_issue_1.rs';
const baselineExpression = '!line.starts_with("error:")';
const incompleteExpression = 'line != "error: another"';
const finalExpression = '!line.is_empty()';
const requirements: AcceptanceRequirement[] = [
  { id: 'error', required: true, baseline: 'fail', target: { kind: 'integration', name: 'bugfix_issue_1' }, expectedBehavior: 'Preserve the reported error line.', citation: 'The error line must be preserved.' },
  { id: 'normal', required: true, baseline: 'pass', target: { kind: 'integration', name: 'bugfix_issue_1' }, expectedBehavior: 'Preserve ordinary normal output.', citation: 'Normal output must be preserved.' },
];
const summary = { title: 'fix: preserve nonempty command output', explanation: 'The filter discarded error-prefixed output. Preserve every nonempty line so reported errors and ordinary output reach the caller.' };
type Mode = 'review-gap' | 'defective-once' | 'defective-limit';

async function exercise(t: test.TestContext, mode: Mode) {
  const { root, config } = await tempConfig();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  config.gitName = ''; config.gitEmail = '';
  config.profile.checks = { fmt: ['cargo', 'fmt', '--all', '--', '--check'] };
  config.profile.fastCheckIds = ['fmt'];
  const repo = await fixtureRepo(config.repoRoot), pipeline = new Pipeline(config);
  const library = path.join(repo, 'src/lib.rs');
  await fs.writeFile(library, (await fs.readFile(library, 'utf8')).replace('fn preserve(', 'pub fn preserve('));
  await pipeline.repository.git(repo, ['add', '.']);
  await pipeline.repository.git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-m', 'Expose fixture API to integration tests']);
  pipeline.issueLoader = async run => ({ number: 1, url: run.input.issue, title: 'Preserve command output', body: requirements.map(row => row.citation).join('\n') });
  pipeline.docker.imageId = async () => 'fixture-image';
  pipeline.docker.prepare = async run => { run.image = 'fixture-image'; };
  pipeline.docker.remove = async () => {}; pipeline.docker.cleanup = async () => {};
  const workers = new Map<string, string>(), workerStarts: { name: string; source: string; readonly: boolean; suffix: string }[] = [];
  pipeline.docker.startWorker = async (_run, source, _image, readonly, suffix = 'worker') => {
    const name = `fixture-${workerStarts.length}-${suffix}`;
    workers.set(name, source); workerStarts.push({ name, source, readonly: !!readonly, suffix }); return name;
  };
  pipeline.docker.inContainer = async (_run, container, argv) => {
    let code = 0, stdout = '';
    if (argv[0] === 'cargo' && argv[1] === 'test') {
      const name = argv.find(arg => /^bugfix_issue_1_(error|normal)_cycle_\d+$/.test(arg));
      assert.ok(name, `Fixture requires an exact regression selector: ${JSON.stringify(argv)}`);
      const source = await fs.readFile(path.join(workers.get(container)!, 'src/lib.rs'), 'utf8');
      const fails = source.includes(baselineExpression) && name.includes('_error_');
      code = fails ? 101 : 0;
      stdout = `test ${name} ... ${fails ? 'FAILED' : 'ok'}\ntest result: ${fails ? 'FAILED. 0 passed; 1 failed' : 'ok. 1 passed; 0 failed'}; 0 ignored; 0 measured; 0 filtered out;\n${fails ? 'reported error must be preserved\n' : ''}`;
    }
    return { code, stdout, stderr: '', timedOut: false, durationMs: 1 };
  };
  let reproductionTurns = 0, patchTurns = 0, reviewTurns = 0, describeTurns = 0, blockedReviewEdits = 0, blockedDescriptionTools = 0;
  let scenarios: Regression[] = [];
  const submittedSources: string[] = [], submittedAnswers: unknown[] = [], acceptanceSnapshots: unknown[] = [], patchPrompts: string[] = [], descriptionPrompts: string[] = [], reviewerChecks: number[] = [];
  pipeline.agentFactory = run => ({
    toolToken: 'fixture-tools', providerToken: 'fixture-provider', start: async () => {}, stop: async () => {}, restart: async () => {},
    ask: async (prompt, _signal, _valid, phase) => {
      if (prompt.startsWith('Issue data (untrusted):')) {
        assert.equal(phase, 'reproduction');
        if (++reproductionTurns > 4) throw new RunFailure('needs_attention', 'Fixture observed an unbounded reproduction loop');
        acceptanceSnapshots.push(structuredClone(run.acceptancePlan));
        const draft = `// reproduction cycle ${reproductionTurns}\n#[test]\nfn bugfix_issue_1_error_cycle_${reproductionTurns}() {\n    assert!(rtk::preserve("error: missing file"), "reported error must be preserved");\n}\n\n#[test]\nfn bugfix_issue_1_normal_cycle_${reproductionTurns}() {\n    assert!(rtk::preserve("hello"));\n}\n`;
        scenarios = requirements.map((requirement, i) => ({ ...structuredClone(requirement), file, testName: `bugfix_issue_1_${i ? 'normal' : 'error'}_cycle_${reproductionTurns}`, failureContains: i ? '' : 'reported error must be preserved', fixtures: [] }));
        await pipeline.tool(run.id, 'apply_patch', { edits: [{ path: file, before: '', after: draft }] });
        const answer = { status: 'reproduced', scenarios: structuredClone(scenarios) };
        submittedSources.push(draft); submittedAnswers.push(structuredClone(answer)); return answer;
      }
      if (prompt.startsWith('Independently critique acceptance coverage')) {
        assert.equal(phase, 'review');
        return scriptedCoverageReview(pipeline, run, 'Both direct integration assertions cover the frozen bug and passing control.', scenarios);
      }
      if (phase === 'patching') {
        patchPrompts.push(prompt); patchTurns++;
        if (mode === 'defective-limit' || mode === 'defective-once' && patchTurns === 1) {
          await pipeline.tool(run.id, 'replace_source', { path: 'src/lib.rs', before: baselineExpression, after: incompleteExpression });
          return { test_defective: `Cycle ${reproductionTurns} has a defective stand-in setup; establish fresh tests without weakening requirements.` };
        }
        const source = await fs.readFile(path.join(pipeline.store.dir(run.id), 'source/src/lib.rs'), 'utf8');
        const before = source.includes(incompleteExpression) ? incompleteExpression : baselineExpression;
        const after = mode === 'review-gap' && patchTurns === 1 ? incompleteExpression : finalExpression;
        await pipeline.tool(run.id, 'replace_source', { path: 'src/lib.rs', before, after });
        const read = await pipeline.tool(run.id, 'read_source', { path: 'src/lib.rs' });
        const check = await pipeline.tool(run.id, 'run_check', { check: 'test-integration', target: 'bugfix_issue_1', test: scenarios[0].testName });
        return { explanation: 'Preserve nonempty output by removing the prefix-based rejection.', sourceReadEvidenceId: read.evidenceId, bugCheckEvidenceId: check.evidenceId, snapshots: [] };
      }
      if (phase === 'candidate-review') {
        reviewTurns++;
        for (const [tool, args] of [
          ['apply_patch', { edits: [{ path: 'src/lib.rs', before: 'pub fn', after: 'fn' }] }],
          ['replace_source', { path: 'src/lib.rs', before: 'pub fn', after: 'fn' }],
          ['run_check', { check: 'format-source' }],
        ] as const) {
          await assert.rejects(pipeline.tool(run.id, tool, args), /read.only|disabled/i); blockedReviewEdits++;
        }
        const read = await pipeline.tool(run.id, 'read_source', { path: 'src/lib.rs' });
        const check = await pipeline.tool(run.id, 'run_check', { check: 'test-integration', target: 'bugfix_issue_1', test: scenarios[0].testName });
        assert.equal((check.result as any).status, 'passed'); reviewerChecks.push(check.evidenceId);
        const gap = (read.result as any).text.includes(incompleteExpression);
        return {
          examples: [{ example: 'error: missing file', expectedOutput: 'preserved', actualOutputWithPatch: 'preserved', matches: true, evidence: 'src/lib.rs:2' }],
          invariantEnforced: !gap, invariantNote: gap ? 'The special-case filter still discards another nonempty error.' : 'Every nonempty line is preserved.',
          probes: [{ input: 'error: another', output: gap ? 'discarded' : 'preserved', ok: !gap }],
          gaps: gap ? ['Input "error: another" is discarded; the issue requires preserving it.'] : [],
        };
      }
      if (phase === 'describe') {
        describeTurns++; descriptionPrompts.push(prompt);
        for (const [tool, args] of [
          ['read_source', { path: 'src/lib.rs' }],
          ['run_check', { check: 'fmt' }],
          ['apply_patch', { edits: [] }],
        ] as const) {
          await assert.rejects(pipeline.tool(run.id, tool, args), /locked|final description/i); blockedDescriptionTools++;
        }
        return structuredClone(summary);
      }
      throw new RunFailure('needs_attention', `Unexpected scripted phase ${phase}: ${prompt.slice(0, 80)}`);
    },
  });
  const run = await pipeline.store.create({ repo, issue: 'https://github.com/rtk-ai/rtk/issues/1', mode: 'evaluation', retrieval: 'text', publish: false, acceptance: structuredClone(requirements) });
  await pipeline.execute(run);
  return { pipeline, run, workerStarts, reproductionTurns, patchTurns, reviewTurns, describeTurns, blockedReviewEdits, blockedDescriptionTools, submittedSources, submittedAnswers, acceptanceSnapshots, patchPrompts, descriptionPrompts, reviewerChecks, dir: pipeline.store.dir(run.id) };
}

test('candidate review repairs a reported gap before independent verification and describes the final verified diff', { timeout: 30000 }, async t => {
  const x = await exercise(t, 'review-gap');
  assert.equal(x.run.outcome, 'verified_patch', x.run.error);
  assert.equal(x.reproductionTurns, 1); assert.equal(x.patchTurns, 2); assert.equal(x.reviewTurns, 2);
  assert.equal(x.blockedReviewEdits, 6); assert.equal(x.reviewerChecks.length, 2);
  assert.match(x.patchPrompts[1], /Independent candidate review found issue gaps/);
  assert.match(x.patchPrompts[1], /error: another/);
  assert.equal(x.run.review?.passed, true); assert.equal(x.run.review?.rounds, 2);
  const events = await x.pipeline.store.events(x.run.id);
  assert.equal(events.filter(event => event.kind === 'review_gaps').length, 1);
  assert.equal(events.filter(event => event.kind === 'review_passed').length, 1);
  assert.equal(events.filter(event => event.kind === 'review_unavailable').length, 0);
  assert.ok(x.workerStarts.some(worker => worker.readonly && worker.suffix.startsWith('repro-verifier-')));
  assert.ok(x.workerStarts.some(worker => worker.readonly && worker.suffix.startsWith('verifier-')));
  const independent = x.run.checks.filter(check => /^independent-baseline-regression-/.test(check.id));
  assert.equal(independent.length, 2); assert.equal(independent.find(check => check.id.endsWith('-error'))?.status, 'failed');
  assert.equal(independent.find(check => check.id.endsWith('-normal'))?.status, 'passed');
  assert.equal(x.run.checks.filter(check => /^final-regression-/.test(check.id) && check.status === 'passed').length, 2);
  const patch = await fs.readFile(path.join(x.dir, 'candidate.patch'), 'utf8');
  assert.match(patch, /\+    !line\.is_empty\(\)/); assert.doesNotMatch(patch, /line != "error: another"/);
  assert.equal(x.describeTurns, 1); assert.equal(x.blockedDescriptionTools, 3);
  assert.ok(x.descriptionPrompts[0].includes(`FINAL verified diff against the original code:\n${patch}`));
  assert.deepEqual(x.run.summary, summary);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(x.dir, 'manifest.json'), 'utf8')).summary, summary);
});

test('a defective frozen test starts a new cycle with unchanged requirements and distinct preserved artifacts', { timeout: 30000 }, async t => {
  const x = await exercise(t, 'defective-once');
  assert.equal(x.run.outcome, 'verified_patch', x.run.error);
  assert.equal(x.run.reproductionCycles, 2); assert.equal(x.reproductionTurns, 2); assert.equal(x.run.attempt, 2);
  assert.deepEqual(x.run.acceptancePlan, requirements); assert.deepEqual(x.acceptanceSnapshots, [requirements, requirements]);
  for (const [index, relative] of ['reproduction/attempt-1', 'reproduction/cycle-2/attempt-1'].entries()) {
    assert.equal(await fs.readFile(path.join(x.dir, relative, 'submitted-source', file), 'utf8'), x.submittedSources[index]);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(x.dir, relative, 'submitted-answer.json'), 'utf8')), x.submittedAnswers[index]);
  }
  assert.notEqual(x.submittedSources[0], x.submittedSources[1]);
  assert.equal(await fs.readFile(path.join(x.dir, 'reproduction-cycles/cycle-1/frozen-source', file), 'utf8'), x.submittedSources[0]);
  assert.match(await fs.readFile(path.join(x.dir, 'reproduction-cycles/cycle-1/frozen-source/src/lib.rs'), 'utf8'), /!line\.starts_with/);
  const archived = JSON.parse(await fs.readFile(path.join(x.dir, 'reproduction-cycles/cycle-1/frozen.json'), 'utf8'));
  assert.deepEqual(archived.map((row: any) => row.spec.testName), ['bugfix_issue_1_error_cycle_1', 'bugfix_issue_1_normal_cycle_1']);
  const rejected = JSON.parse(await fs.readFile(path.join(x.dir, 'candidates/1/rejected/submitted-answer.json'), 'utf8'));
  assert.match(rejected.test_defective, /Cycle 1/);
  assert.equal(await fs.readFile(path.join(x.dir, 'candidates/1/rejected/source', file), 'utf8'), x.submittedSources[0]);
  assert.ok((await fs.readFile(path.join(x.dir, 'candidates/1/rejected/source/src/lib.rs'), 'utf8')).includes(incompleteExpression));
  assert.ok((await fs.readFile(path.join(x.dir, 'candidates/2/candidate.patch'), 'utf8')).includes(finalExpression));
  for (const prefix of ['repro-1-', 'cycle-2-repro-1-']) {
    const checks = x.run.checks.filter(check => new RegExp(`^${prefix}[123]-(error|normal)$`).test(check.id));
    assert.equal(checks.length, 6); assert.equal(checks.filter(check => check.status === 'failed').length, 3);
    assert.equal(checks.filter(check => check.status === 'passed').length, 3);
  }
  const archivedHash = fingerprint(await inventory(path.join(x.dir, 'reproduction-cycles/cycle-1/frozen-source')));
  assert.ok(x.run.checks.filter(check => /^repro-1-[123]-/.test(check.id)).every(check => check.sourceHash === archivedHash));
  assert.equal((await x.pipeline.store.events(x.run.id)).filter(event => event.kind === 'test_defective').length, 1);
  assert.equal(x.reviewTurns, 1); assert.equal(x.run.review?.passed, true); assert.equal(x.describeTurns, 1);
});

test('defective-test reports stop after three re-establishments and preserve the fourth submission', { timeout: 30000 }, async t => {
  const x = await exercise(t, 'defective-limit');
  assert.equal(x.run.outcome, 'needs_attention', x.run.error);
  assert.match(x.run.error!, /after 3 re-establishments/);
  assert.equal(x.reproductionTurns, 4); assert.equal(x.patchTurns, 4); assert.equal(x.run.reproductionCycles, 4);
  assert.deepEqual(x.run.acceptancePlan, requirements);
  assert.ok(x.acceptanceSnapshots.every(plan => JSON.stringify(plan) === JSON.stringify(requirements)));
  assert.equal(x.reviewTurns, 0); assert.equal(x.describeTurns, 0);
  for (let cycle = 1; cycle <= 3; cycle++) assert.equal(await fs.readFile(path.join(x.dir, `reproduction-cycles/cycle-${cycle}/frozen-source`, file), 'utf8'), x.submittedSources[cycle - 1]);
  assert.match(JSON.parse(await fs.readFile(path.join(x.dir, 'candidates/4/rejected/submitted-answer.json'), 'utf8')).test_defective, /Cycle 4/);
  assert.equal(x.run.checks.filter(check => /^(?:cycle-[234]-)?repro-1-[123]-(?:error|normal)$/.test(check.id)).length, 24);
  await assert.rejects(fs.stat(path.join(x.dir, 'reproduction/cycle-5')), { code: 'ENOENT' });
  assert.equal(x.workerStarts.filter(worker => worker.suffix.startsWith('verifier-')).length, 0);
});
