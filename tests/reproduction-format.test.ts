import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Pipeline } from '../src/pipeline.ts';
import { assertFrozenRegressions, freezeRegressions } from '../src/acceptance.ts';
import { copySource, fingerprint, hash, inventory } from '../src/files.ts';
import { scriptedCoverageReview } from './coverage-helper.ts';
import { fixtureRepo, tempConfig } from './helpers.ts';
import type { AcceptanceRequirement, Regression } from '../src/types.ts';

const file = 'tests/bugfix_issue_1.rs';
const unformatted = '#[test]\nfn bugfix_issue_1_error(){assert!(rtk::preserve("error: missing file"),"reported error must be preserved");}\n#[test]\nfn bugfix_issue_1_normal(){assert!(rtk::preserve("hello"));}\n';
const formatted = '#[test]\nfn bugfix_issue_1_error() {\n    assert!(\n        rtk::preserve("error: missing file"),\n        "reported error must be preserved"\n    );\n}\n\n#[test]\nfn bugfix_issue_1_normal() {\n    assert!(rtk::preserve("hello"));\n}\n';
type FormatMode = 'safe' | 'production' | 'helper' | 'failed' | 'nonconverging' | 'existing-artifact' | 'initial-inventory-failure';

async function exercise(t: test.TestContext, mode: FormatMode) {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  config.gitName = ''; config.gitEmail = ''; // This local fixture does not publish or create a candidate commit.
  config.profile.checks = { fmt: ['cargo', 'fmt', '--all', '--', '--check'] }; config.profile.fastCheckIds = ['fmt'];
  const repo = await fixtureRepo(config.repoRoot), pipeline = new Pipeline(config);
  const helper = 'pub fn helper() -> bool { true }\n';
  await fs.mkdir(path.join(repo, 'tests')); await fs.writeFile(path.join(repo, 'tests/support.rs'), helper);
  await fs.writeFile(path.join(repo, 'src/lib.rs'), (await fs.readFile(path.join(repo, 'src/lib.rs'), 'utf8')).replace('fn preserve(', 'pub fn preserve('));
  await pipeline.repository.git(repo, ['add', '.']);
  await pipeline.repository.git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-m', 'Expose test fixture API and existing helper']);
  const requirements: AcceptanceRequirement[] = [
    { id: 'error', required: true, baseline: 'fail', target: { kind: 'integration', name: 'bugfix_issue_1' }, expectedBehavior: 'Preserve the reported error line.', citation: 'The error line must be preserved.' },
    { id: 'normal', required: true, baseline: 'pass', target: { kind: 'integration', name: 'bugfix_issue_1' }, expectedBehavior: 'Preserve ordinary normal output.', citation: 'Normal output must be preserved.' },
  ];
  const scenarios: Regression[] = requirements.map((requirement, i) => ({ ...requirement, file, testName: i ? 'bugfix_issue_1_normal' : 'bugfix_issue_1_error', failureContains: i ? '' : 'reported error must be preserved', fixtures: [] }));
  pipeline.issueLoader = async run => ({ number: 1, url: run.input.issue, title: 'Formatting fixture', body: requirements.map(r => r.citation).join('\n') });
  pipeline.docker.imageId = async () => 'fixture-image'; pipeline.docker.prepare = async run => { run.image = 'fixture-image'; };
  pipeline.docker.remove = async () => {}; pipeline.docker.cleanup = async () => {};
  const sources = new Map<string, string>(), formatterSources: string[] = [], reviewSources: string[] = [];
  pipeline.docker.startWorker = async (_run, source, _image, _readonly, suffix = 'worker') => { const name = `fixture-${suffix}`; sources.set(name, source); if (suffix.startsWith('formatter-')) formatterSources.push(source); return name; };
  pipeline.docker.inContainer = async (_run, container, argv) => {
    let code = 0, stdout = ''; const source = sources.get(container)!;
    if (argv[0] === 'cargo' && argv[1] === 'fmt') {
      if (argv.includes('--check')) { code = (await fs.readFile(path.join(source, file), 'utf8')) === formatted ? 0 : 1; stdout = code ? `Diff in ${file}\n` : ''; }
      else {
        if (mode !== 'nonconverging') await fs.writeFile(path.join(source, file), formatted);
        if (mode === 'production') { const target = path.join(source, 'src/lib.rs'); await fs.writeFile(target, (await fs.readFile(target, 'utf8')).replace('!line.starts_with("error:")', '!line.is_empty()')); }
        if (mode === 'helper') await fs.writeFile(path.join(source, 'tests/support.rs'), helper.replace('true', 'false'));
        if (mode === 'failed') { code = 1; stdout = 'rustfmt could not parse the submitted draft\n'; }
      }
    } else if (argv[0] === 'cargo' && argv[1] === 'test') {
      const name = argv.find(arg => arg.startsWith('bugfix_issue_1_'))!;
      const baseline = (await fs.readFile(path.join(source, 'src/lib.rs'), 'utf8')).includes('!line.starts_with("error:")');
      const fails = baseline && name === 'bugfix_issue_1_error'; code = fails ? 101 : 0;
      stdout = `test ${name} ... ${fails ? 'FAILED' : 'ok'}\ntest result: ${fails ? 'FAILED. 0 passed; 1 failed' : 'ok. 1 passed; 0 failed'}; 0 ignored; 0 measured; 0 filtered out;\n${fails ? 'reported error must be preserved\n' : ''}`;
    }
    return { code, stdout, stderr: '', timedOut: false, durationMs: 1 };
  };
  let submittedAnswer: unknown, reproductionTurns = 0;
  pipeline.agentFactory = run => ({ toolToken: 'fixture-tools', providerToken: 'fixture-provider', start: async () => {}, stop: async () => {}, restart: async () => {}, ask: async prompt => {
    if (prompt.startsWith('Issue data (untrusted):')) {
      reproductionTurns++;
      await pipeline.tool(run.id, 'apply_patch', { edits: [{ path: file, before: '', after: unformatted }] });
      if (mode === 'existing-artifact') await fs.mkdir(path.join(pipeline.store.dir(run.id), 'reproduction/attempt-1'), { recursive: true });
      if (mode === 'initial-inventory-failure') {
        const read = fs.readFile, target = path.join(pipeline.store.dir(run.id), 'source', file);
        const injected = t.mock.method(fs, 'readFile', (...args: any[]) => {
          if (args[0] === target) { injected.mock.restore(); return Promise.reject(Object.assign(new Error('Injected initial inventory read failure'), { code: 'EIO' })); }
          return Reflect.apply(read, fs, args);
        });
      }
      submittedAnswer = { status: 'reproduced', scenarios: structuredClone(scenarios) }; return submittedAnswer;
    }
    if (prompt.startsWith('Independently critique acceptance coverage')) { reviewSources.push(await fs.readFile(path.join(pipeline.store.dir(run.id), 'source', file), 'utf8')); return scriptedCoverageReview(pipeline, run, 'Both exact error and normal control tests are present.', scenarios); }
    await pipeline.tool(run.id, 'replace_source', { path: 'src/lib.rs', before: '!line.starts_with("error:")', after: '!line.is_empty()' });
    const read = await pipeline.tool(run.id, 'read_source', { path: 'src/lib.rs' });
    const check = await pipeline.tool(run.id, 'run_check', { check: 'test-integration', target: 'bugfix_issue_1', test: 'bugfix_issue_1_error' });
    return { explanation: 'Preserve nonempty output.', sourceReadEvidenceId: read.evidenceId, bugCheckEvidenceId: check.evidenceId, snapshots: [] };
  } });
  const run = await pipeline.store.create({ repo, issue: 'https://github.com/rtk-ai/rtk/issues/1', mode: 'evaluation', retrieval: 'text', publish: false, acceptance: requirements });
  await pipeline.execute(run);
  return { root, pipeline, run, formatterSources, reviewSources, submittedAnswer, helper, reproductionTurns };
}

test('controller formats a new integration regression before whole-file freeze and baseline/final checks', { timeout: 20000 }, async t => {
  const { root, pipeline, run, reviewSources, submittedAnswer } = await exercise(t, 'safe');
  assert.equal(run.outcome, 'verified_patch', run.error);
  assert.deepEqual(reviewSources, [formatted]);
  assert.ok(run.regressions!.every(r => r.wholeFileHash === hash(formatted)));
  const frozenRoot = path.join(pipeline.store.dir(run.id), 'regression-source');
  const formattedRevision = fingerprint(await inventory(frozenRoot));
  const baselineChecks = run.checks.filter(c => /^repro-1-[123]-/.test(c.id));
  assert.equal(baselineChecks.length, 6); assert.ok(baselineChecks.every(c => c.sourceHash === formattedRevision));
  const formattingCheck = run.checks.find(c => c.id === 'repro-1-fmt'); assert.equal(formattingCheck?.sourceHash, formattedRevision); assert.equal(formattingCheck?.status, 'passed');
  assert.ok(run.checks.some(c => c.id.startsWith('final-fmt-') && c.status === 'passed' && c.sourceHash === run.candidate!.candidateRevision));
  const submitted = path.join(pipeline.store.dir(run.id), 'reproduction/attempt-1');
  assert.equal(await fs.readFile(path.join(submitted, 'submitted-source', file), 'utf8'), unformatted);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(submitted, 'submitted-answer.json'), 'utf8')), submittedAnswer);
  const receipt = JSON.parse(await fs.readFile(path.join(submitted, 'formatting.json'), 'utf8'));
  assert.notEqual(receipt.submittedSourceHash, formattedRevision); assert.equal(receipt.formattedSourceHash, formattedRevision);
  const changed = path.join(root, 'changed-frozen-copy'); await copySource(frozenRoot, changed); await fs.appendFile(path.join(changed, file), '// a postfreeze edit is still forbidden\n');
  await assert.rejects(assertFrozenRegressions(changed, run.regressions!), /Frozen integration regression file changed/);
});

for (const mode of ['production', 'helper', 'failed', 'nonconverging'] as const) test(`mandatory formatting rejects ${mode} changes before freezing or baseline checks`, { timeout: 20000 }, async t => {
  const { pipeline, run, formatterSources, helper } = await exercise(t, mode);
  assert.equal(run.outcome, 'cannot_reproduce', run.error); assert.equal(run.regression, undefined); assert.equal(run.regressions, undefined);
  assert.equal(run.checks.filter(c => /^repro-\d-[123]-/.test(c.id)).length, 0);
  const source = path.join(pipeline.store.dir(run.id), 'source');
  assert.match(await fs.readFile(path.join(source, 'src/lib.rs'), 'utf8'), /!line\.starts_with/);
  assert.equal(await fs.readFile(path.join(source, 'tests/support.rs'), 'utf8'), helper);
  if (mode !== 'nonconverging') assert.equal(await fs.readFile(path.join(source, file), 'utf8'), unformatted);
  for (const scratch of formatterSources) await assert.rejects(fs.stat(scratch), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(pipeline.store.dir(run.id), 'reproduction/frozen.json')), { code: 'ENOENT' });
});

test('failure to preserve original submitted evidence stops without resetting or freezing the draft', { timeout: 20000 }, async t => {
  const { pipeline, run, formatterSources } = await exercise(t, 'existing-artifact');
  assert.equal(run.outcome, 'needs_attention'); assert.match(run.error!, /Unable to preserve submitted reproduction/);
  assert.equal(await fs.readFile(path.join(pipeline.store.dir(run.id), 'source', file), 'utf8'), unformatted);
  assert.equal(formatterSources.length, 0); assert.equal(run.regressions, undefined);
  assert.equal(run.checks.filter(c => /^repro-\d-[123]-/.test(c.id)).length, 0);
});

test('an initial submitted inventory read failure stops before reset, formatter or baseline admission', { timeout: 20000 }, async t => {
  const { pipeline, run, formatterSources, reproductionTurns } = await exercise(t, 'initial-inventory-failure');
  assert.equal(run.outcome, 'needs_attention'); assert.match(run.error!, /Unable to preserve submitted reproduction.*Injected initial inventory read failure/);
  assert.equal(reproductionTurns, 1); assert.equal(formatterSources.length, 0); assert.equal(run.regressions, undefined);
  assert.equal(await fs.readFile(path.join(pipeline.store.dir(run.id), 'source', file), 'utf8'), unformatted);
  assert.equal(run.checks.filter(c => /^repro-\d-[123]-/.test(c.id)).length, 0);
  assert.equal((await pipeline.store.events(run.id)).filter(e => e.kind === 'repro_rejected').length, 0);
});

test('postfreeze formatting still rejects a whole-file integration change and leaves source bytes untouched', async t => {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pipeline = new Pipeline(config), base = await fixtureRepo(config.repoRoot), source = path.join(root, 'source'); await copySource(base, source);
  await fs.mkdir(path.join(source, 'tests')); await fs.writeFile(path.join(source, file), unformatted);
  const run = await pipeline.store.create({ repo: base, issue: 'https://github.com/rtk-ai/rtk/issues/1', mode: 'evaluation', retrieval: 'text', publish: false });
  run.regressions = await freezeRegressions(base, source, { id: 'error', file, target: { kind: 'integration', name: 'bugfix_issue_1' }, testName: 'bugfix_issue_1_error', baseline: 'fail', failureContains: 'reported error must be preserved', expectedBehavior: 'Preserve the reported error line.', citation: 'The error line must be preserved.', fixtures: [] }); run.regression = run.regressions[0];
  const before = await inventory(source); let scratch = '', removed = false, mirrors = 0;
  pipeline.contexts.set(run.id, { run, source, base, phase: 'patching', abort: new AbortController(), queue: Promise.resolve(), agent: { toolToken: '', providerToken: '', start: async () => {}, stop: async () => {}, ask: async () => ({}) } });
  pipeline.repository.mirror = async () => { mirrors++; };
  pipeline.docker.startWorker = async (_run, source) => { scratch = source; return 'fixture-formatter'; };
  pipeline.docker.remove = async () => { removed = true; };
  pipeline.docker.inContainer = async () => { await fs.writeFile(path.join(scratch, file), formatted); return { code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 }; };
  await assert.rejects(pipeline.tool(run.id, 'run_check', { check: 'format-source' }), /Frozen integration regression file changed/);
  assert.deepEqual(await inventory(source), before); assert.equal(mirrors, 0); assert.equal(removed, true);
  await assert.rejects(fs.stat(scratch), { code: 'ENOENT' });
});
