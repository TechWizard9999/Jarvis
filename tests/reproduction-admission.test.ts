import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Pipeline, RunFailure } from '../src/pipeline.ts';
import { scriptedCoverageReview } from './coverage-helper.ts';
import { copySource } from '../src/files.ts';
import { freezeRegressions } from '../src/acceptance.ts';
import { fixtureRepo, tempConfig } from './helpers.ts';
import type { AcceptanceRequirement, Regression } from '../src/types.ts';

const regressionFile = 'tests/bugfix_issue_1.rs';
const invariant = 'core::test_isolation::tests_that_spawn_rtk_isolate_their_data';
const bug = 'bugfix_issue_1_error', control = 'bugfix_issue_1_normal';
const originalDiagnostic = `---- ${invariant} stdout ----\nthread '${invariant}' panicked at src/core/test_isolation/mod.rs:12:5:\nthese files name the rtk binary themselves; use common::rtk_command():\n  ${regressionFile}: CARGO_BIN_EXE_rtk\n`;
function suite(names: string[], failed: string[] = [], detail = '') {
  return names.map(name => `test ${name} ... ${failed.includes(name) ? 'FAILED' : 'ok'}\n`).join('') + detail + `test result: ${failed.length ? 'FAILED' : 'ok'}. ${names.length - failed.length} passed; ${failed.length} failed; 0 ignored; 0 measured; 0 filtered out;\n`;
}

async function exercise(t: test.TestContext, mode: 'direct' | 'helper' | 'late-offender' | 'changing-failure' | 'compile' | 'no-match' | 'truncated' | 'give-up') {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  config.gitName = ''; config.gitEmail = '';
  config.profile.checks = { fmt: ['fixture-fmt'], 'test-workspace': ['cargo', 'test', '--workspace', '--locked', '--offline'], 'test-oss': ['cargo', 'test', '--no-default-features', '--locked', '--offline'] };
  config.profile.fastCheckIds = ['fmt'];
  const repo = await fixtureRepo(config.repoRoot), pipeline = new Pipeline(config);
  await fs.mkdir(path.join(repo, 'src/core/test_isolation'), { recursive: true });
  await fs.writeFile(path.join(repo, 'src/core/test_isolation/mod.rs'), '#[test]\nfn tests_that_spawn_rtk_isolate_their_data() { assert!(true); }\n');
  const fixtureLibrary = path.join(repo, 'src/lib.rs'); await fs.writeFile(fixtureLibrary, (await fs.readFile(fixtureLibrary, 'utf8')).replace('fn preserve(', 'pub fn preserve('));
  await fs.writeFile(path.join(repo, 'src/main.rs'), 'fn main() {}\n');
  await fs.mkdir(path.join(repo, 'tests/common'), { recursive: true }); await fs.writeFile(path.join(repo, 'tests/common/mod.rs'), 'pub fn rtk_command() -> std::process::Command { std::process::Command::new("rtk") }\n');
  await pipeline.repository.git(repo, ['add', '.']); await pipeline.repository.git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-m', 'Existing invariant fixture']);
  const requirements: AcceptanceRequirement[] = [
    { id: 'error', required: true, baseline: 'fail', target: { kind: 'integration', name: 'bugfix_issue_1' }, expectedBehavior: 'Preserve the reported error line.', citation: 'The error line must be preserved.' },
    { id: 'normal', required: true, baseline: 'pass', target: { kind: 'integration', name: 'bugfix_issue_1' }, expectedBehavior: 'Preserve the existing normal output.', citation: 'Normal output must be preserved.' },
  ];
  const scenarios: Regression[] = requirements.map((row, i) => ({ ...row, file: regressionFile, testName: i ? control : bug, failureContains: i ? '' : 'reported error must be preserved', fixtures: [] }));
  const draft = `${mode === 'helper' || mode === 'changing-failure' ? 'mod common;\nfn command() -> std::process::Command { common::rtk_command() }' : 'fn command() -> std::process::Command { std::process::Command::new(env!("CARGO_BIN_EXE_rtk")) }'}\n#[test]\nfn ${bug}() { let _cmd = command(); assert!(rtk::preserve("error: missing file"), "reported error must be preserved"); }\n#[test]\nfn ${control}() { assert!(rtk::preserve("hello")); }\n`;
  pipeline.issueLoader = async run => ({ number: 1, url: run.input.issue, title: 'Admission fixture', body: requirements.map(row => row.citation).join('\n') });
  pipeline.docker.imageId = async () => 'fixture-image'; pipeline.docker.prepare = async run => { run.image = 'fixture-image'; };
  pipeline.docker.remove = async () => {}; pipeline.docker.cleanup = async () => {};
  const sources = new Map<string, string>(); const admissionChecks: { argv: string[]; names: string[] }[] = []; let candidateTurns = 0, reviews = 0, finalFailures = 0;
  pipeline.docker.startWorker = async (_run, source, _image, _readonly, suffix = 'worker') => { const name = `fixture-${suffix}`; sources.set(name, source); return name; };
  pipeline.docker.inContainer = async (run, container, argv) => {
    let code = 0, stdout = ''; const source = sources.get(container)!;
    if (argv[0] === 'cargo' && argv[1] === 'metadata') stdout = JSON.stringify({ workspace_members: ['path+file:///workspace#rtk@0.1.0'], packages: [{ id: 'path+file:///workspace#rtk@0.1.0', targets: [{ kind: ['lib'], name: 'rtk', test: true, doctest: true }] }] });
    else if (argv[0] === 'cargo' && argv[1] === 'test') {
      const isAdmission = run.stage === 'reproduction' && (argv.includes('--list') || argv.includes('--no-run') || !argv.some(arg => [bug, control].includes(arg)) || argv.includes('--lib'));
      if (argv.includes('--no-run')) {
        if (mode === 'compile') { code = 101; stdout = 'error[E0425]: cannot find function setup\ncould not compile rtk\n'; }
        else stdout = [['lib', 'rtk', 'src/lib.rs'], ['test', 'bugfix_issue_1', regressionFile]].map(([kind, name, file]) => JSON.stringify({ reason: 'compiler-artifact', package_id: 'path+file:///workspace#rtk@0.1.0', target: { kind: [kind], name, src_path: `/workspace/${file}`, doctest: kind === 'lib' }, profile: { test: true }, executable: `/build/target/${name}` })).join('\n') + '\n';
      } else {
        const target = argv.includes('--test') ? 'integration' : argv.includes('--lib') ? 'library' : 'all';
        const catalog = target === 'integration' ? [bug, control] : target === 'library' ? [invariant, bug, `${bug}_collision`, 'tests::keeps_normal'] : [invariant, bug, `${bug}_collision`, 'tests::keeps_normal', control];
        if (argv.includes('--list')) stdout = mode === 'no-match' ? '0 tests, 0 benchmarks\n' : catalog.map(name => `${name}: test\n`).join('') + (mode === 'truncated' ? '' : `${catalog.length} tests, 0 benchmarks\n`);
        else if (argv.includes('--doc')) stdout = 'test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out;\n';
        else {
          const harnessArgs = argv.includes('--') ? argv.slice(argv.indexOf('--') + 1) : [], filters = harnessArgs.filter(arg => !arg.startsWith('-'));
          // The old controller puts the single Cargo filter before --; the admission projection puts exact filters after it.
          const beforeFilter = argv.slice(2, argv.indexOf('--')).filter(arg => [bug, control].includes(arg));
          const selected = filters.length ? catalog.filter(name => filters.includes(name)) : beforeFilter.length ? beforeFilter : catalog;
          const baseline = (await fs.readFile(path.join(source, 'src/lib.rs'), 'utf8')).includes('!line.starts_with("error:")');
          const failed: string[] = [];
          if (baseline && target !== 'library' && selected.includes(bug)) failed.push(bug);
          const directSpawn = (await fs.readFile(path.join(source, regressionFile), 'utf8')).includes('env!("CARGO_BIN_EXE_rtk")');
          if (selected.includes(invariant) && directSpawn && (mode === 'direct' || mode === 'late-offender' && run.stage === 'verification')) failed.push(invariant);
          stdout = suite(selected, failed, failed.includes(invariant) ? originalDiagnostic : failed.includes(bug) ? 'reported error must be preserved\n' : ''); code = failed.length ? 101 : 0;
          if (isAdmission) admissionChecks.push({ argv, names: selected });
          if (run.stage === 'verification' && !baseline && failed.includes(invariant)) finalFailures++;
          if (mode === 'changing-failure' && run.stage === 'verification' && !baseline && !argv.some(arg => [bug, control].includes(arg))) { finalFailures++; code = 101; stdout = suite(['tests::ordinary_production'], ['tests::ordinary_production'], `backtrace mentions ${regressionFile}:12\n`); }
        }
      }
    }
    return { code, stdout, stderr: '', timedOut: false, durationMs: 1 };
  };
  pipeline.agentFactory = run => ({ toolToken: 'fixture-tools', providerToken: 'fixture-provider', start: async () => {}, stop: async () => {}, restart: async () => {}, ask: async prompt => {
    if (prompt.startsWith('Issue data (untrusted):')) { await pipeline.tool(run.id, 'apply_patch', { edits: [{ path: regressionFile, before: '', after: draft }] }); return mode === 'give-up' ? { status: 'cannot_reproduce', reason: 'Fixture unsupported case after drafting tests' } : { status: 'reproduced', scenarios }; }
    if (prompt.startsWith('Independently critique acceptance coverage')) { reviews++; return scriptedCoverageReview(pipeline, run, 'Error and ordinary output are covered.', scenarios); }
    candidateTurns++;
    if (candidateTurns > (mode === 'changing-failure' ? 4 : mode === 'late-offender' ? 5 : 3)) throw new RunFailure('cancelled', 'Fixture guard: controller did not stop repeated invalid work');
    const currentFile = path.join(pipeline.store.dir(run.id), 'source/src/lib.rs');
    const current = await fs.readFile(currentFile, 'utf8');
    await pipeline.tool(run.id, 'apply_patch', { edits: [{ path: 'src/lib.rs', before: current, after: current.replace('!line.starts_with("error:")', '!line.is_empty()') + `\n// production variation ${candidateTurns}\n` }] });
    const read = await pipeline.tool(run.id, 'read_source', { path: 'src/lib.rs' });
    const check = await pipeline.tool(run.id, 'run_check', { check: 'test-integration', target: 'bugfix_issue_1', test: bug });
    return { explanation: 'Preserve reported error output.', sourceReadEvidenceId: mode === 'late-offender' && candidateTurns === 2 ? 99999 : read.evidenceId, bugCheckEvidenceId: check.evidenceId, snapshots: [] };
  } });
  const run = await pipeline.store.create({ repo, issue: 'https://github.com/rtk-ai/rtk/issues/1', mode: 'evaluation', retrieval: 'text', publish: false, acceptance: requirements });
  await pipeline.execute(run); return { pipeline, run, draft, candidateTurns, reviews, admissionChecks, finalFailures };
}

test('existing binary isolation invariant rejects a direct-spawn draft before freeze, critic or production work', { timeout: 20000 }, async t => {
  const f = await exercise(t, 'direct');
  assert.equal(f.run.outcome, 'cannot_reproduce', f.run.error);
  assert.equal(f.candidateTurns, 0); assert.equal(f.reviews, 0); assert.equal(f.run.regressions, undefined);
  const dir = path.join(f.pipeline.store.dir(f.run.id), 'reproduction/attempt-1');
  assert.equal(await fs.readFile(path.join(dir, 'submitted-source', regressionFile), 'utf8'), f.draft);
  const admission = JSON.parse(await fs.readFile(path.join(dir, 'admission.json'), 'utf8'));
  assert.equal(admission.status, 'rejected'); assert.match(admission.reason, /tests_that_spawn_rtk_isolate_their_data/);
});

test('compatible isolated helper is admitted with controls, prefix collisions and same names in other targets', { timeout: 20000 }, async t => {
  const f = await exercise(t, 'helper');
  assert.equal(f.run.outcome, 'verified_patch', JSON.stringify((await f.pipeline.store.events(f.run.id)).filter(event => /rejected|error/.test(event.kind)))); assert.equal(f.candidateTurns, 1); assert.equal(f.reviews, 1);
  const admission = JSON.parse(await fs.readFile(path.join(f.pipeline.store.dir(f.run.id), 'reproduction/attempt-1/admission.json'), 'utf8'));
  assert.equal(admission.status, 'admitted');
  assert.deepEqual(admission.excluded.map((row: any) => [row.checkId, row.target.kind, row.testName]), [['test-workspace', 'test', bug], ['test-oss', 'test', bug]]);
  for (const checkId of ['test-workspace', 'test-oss']) {
    const testChecks = f.run.checks.filter(check => check.id.startsWith(`repro-1-admission-${checkId}-`) && check.id.includes('-tests-'));
    assert.equal(testChecks.length, 2);
    const lib = testChecks.find(check => check.argv.includes('--lib'))!;
    const integration = testChecks.find(check => check.argv.includes('--test'))!;
    assert.ok(lib.argv.includes(bug)); assert.ok(lib.argv.includes(`${bug}_collision`)); assert.ok(lib.argv.includes(invariant));
    assert.ok(integration.argv.includes(control)); assert.ok(!integration.argv.includes(bug)); assert.ok(!integration.argv.includes('--skip'));
    if (checkId === 'test-oss') assert.ok(testChecks.every(check => check.argv.includes('--no-default-features')));
  }
});

for (const mode of ['compile', 'no-match', 'truncated'] as const) test(`${mode} discovery rejects reproduction before freeze`, { timeout: 20000 }, async t => {
  const f = await exercise(t, mode);
  assert.equal(f.run.outcome, 'cannot_reproduce', f.run.error); assert.equal(f.candidateTurns, 0); assert.equal(f.reviews, 0); assert.equal(f.run.regressions, undefined);
});

test('a later invariant failure attributed to frozen bytes stops across production changes and interleaved rejection', { timeout: 20000 }, async t => {
  const f = await exercise(t, 'late-offender');
  assert.equal(f.run.outcome, 'needs_attention', f.run.error); assert.equal(f.finalFailures, 3); assert.equal(f.candidateTurns, 4);
  assert.match(f.run.error!, /frozen.*tests\/bugfix_issue_1.rs|tests\/bugfix_issue_1.rs.*frozen/i);
  const events = await f.pipeline.store.events(f.run.id), verdicts = events.filter(event => event.kind === 'verification_rejected');
  assert.equal(verdicts.length, 3); assert.equal(new Set(verdicts.map(event => (event.data as any).sourceHash)).size, 3);
  assert.ok(verdicts.every(event => (event.data as any).immutableOffenders?.[0]?.path === regressionFile));
  const checkpoint = JSON.parse(await fs.readFile(path.join(f.pipeline.store.dir(f.run.id), 'repair-checkpoint.json'), 'utf8'));
  assert.equal(checkpoint.verificationProgress.immutableFailures[0][1], 3);
  assert.ok(checkpoint.changedFiles.includes('src/lib.rs')); assert.equal(checkpoint.validProof?.sourceHash, checkpoint.sourceHash);
  assert.ok(events.filter(event => event.kind === 'candidate_preserved').length >= 4);
});

test('changing production failures with a frozen path only in a stack trace keep repairing', { timeout: 20000 }, async t => {
  const f = await exercise(t, 'changing-failure');
  assert.equal(f.run.outcome, 'cancelled', f.run.error); assert.equal(f.finalFailures, 4);
  const events = (await f.pipeline.store.events(f.run.id)).filter(event => event.kind === 'verification_rejected');
  assert.equal(events.length, 4); assert.ok(events.every(event => !(event.data as any).immutableOffenders?.length));
});


test('a draft submitted with cannot_reproduce remains available before the next attempt resets it', { timeout: 20000 }, async t => {
  const f = await exercise(t, 'give-up'); assert.equal(f.run.outcome, 'cannot_reproduce');
  const dir = path.join(f.pipeline.store.dir(f.run.id), 'reproduction/attempt-1');
  assert.equal(await fs.readFile(path.join(dir, 'submitted-source', regressionFile), 'utf8'), f.draft);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'submitted-answer.json'), 'utf8')).status, 'cannot_reproduce');
});

test('a repairable production assertion naming a frozen fixture is not an immutable source invariant', async t => {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pipeline = new Pipeline(config), base = await fixtureRepo(config.repoRoot), source = path.join(root, 'attribution-source');
  await copySource(base, source); await fs.mkdir(path.join(source, 'tests'), { recursive: true });
  const file = 'tests/bugfix_issue_1.rs';
  await fs.writeFile(path.join(source, file), '#[test]\nfn bugfix_issue_1_fixture() { assert_eq!(1, 1, "expected output"); }\n');
  const run = await pipeline.store.create({ repo: base, issue: 'https://github.com/rtk-ai/rtk/issues/1' });
  run.regressions = await freezeRegressions(base, source, { file, testName: 'bugfix_issue_1_fixture', target: { kind: 'integration', name: 'bugfix_issue_1' }, failureContains: 'expected output', expectedBehavior: 'format ordinary output', citation: 'ordinary output', fixtures: [] });
  const output = `test tests::keeps_normal ... FAILED\n---- tests::keeps_normal stdout ----\nthread 'tests::keeps_normal' panicked at src/lib.rs:12:5:\n  ${file}: expected output\nfailures:\n`;
  const offenders = await (pipeline as any).immutableOffenders({ run, base }, 'test-workspace', output, source);
  assert.deepEqual(offenders, [], 'A fixture diagnostic cannot prove that production changes are unable to repair a failure');
});
