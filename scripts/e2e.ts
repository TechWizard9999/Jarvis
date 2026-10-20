/** Real Docker/Git/Cargo integration. The scripted agent is explicitly NOT an LLM evaluation. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { Pipeline } from '../src/pipeline.ts';
import { loadConfig } from '../src/config.ts';
import { Store, atomicJson } from '../src/store.ts';
import { fixtureRepo, original, testFunction, testName } from '../tests/helpers.ts';
import { checked } from '../src/process.ts';
import type { RepairAgent } from '../src/pipeline.ts';
import type { AcceptanceRequirement, CheckResult, Manifest, Regression } from '../src/types.ts';

const project = process.cwd();
const root = path.join(project, 'state', 'integration', randomBytes(5).toString('hex'));
const config = loadConfig({ ...process.env, BUGFIX_PROJECT_DIR: project, BUGFIX_STATE_DIR: path.join(root, 'state'), BUGFIX_REPO_ROOT: path.join(root, 'repos'), BUGFIX_MODEL: 'nvidia/scripted-test-driver', BUGFIX_GIT_NAME: 'Integration Test', BUGFIX_GIT_EMAIL: 'integration@example.invalid', BUGFIX_COMMAND_TIMEOUT_MS: '180000' });
await fs.mkdir(config.repoRoot, { recursive: true });
const repo = await fixtureRepo(config.repoRoot);
const store = new Store(config.stateDir), engine = new Pipeline(config, store);
// Set up and commit the local CLI before the run; reproduction still cannot change production code.
const baselineSource = original.replace('fn preserve(', 'pub fn preserve(');
const baselineMain = `fn main() {
    let line = std::env::args().nth(1).expect("provide one line");
    if rtk::preserve(&line) {
        println!("{line}");
    }
}
`;
await fs.writeFile(path.join(repo, 'src/lib.rs'), baselineSource);
await fs.writeFile(path.join(repo, 'src/main.rs'), baselineMain);
checked(await engine.repository.git(repo, ['add', 'src/lib.rs', 'src/main.rs']), 'Stage local CLI fixture');
checked(await engine.repository.git(repo, ['-c', 'user.name=Integration Test', '-c', 'user.email=integration@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-m', 'Add offline CLI acceptance fixture']), 'Commit local CLI fixture baseline');

const requirements: AcceptanceRequirement[] = [
  { id: 'unit-error', required: true, baseline: 'fail', target: { kind: 'unit' }, expectedBehavior: 'Preserve a non-empty error-prefixed line.', citation: 'The error line must be preserved.' },
  { id: 'unit-control', required: true, baseline: 'pass', target: { kind: 'unit' }, expectedBehavior: 'Preserve ordinary non-empty output.', citation: 'Normal output must be preserved.' },
  { id: 'cli-error', required: true, baseline: 'fail', target: { kind: 'integration', name: 'cli_acceptance' }, expectedBehavior: 'The CLI prints the error line and newline, exits successfully, and writes no stderr.', citation: 'The CLI must print the error line followed by a newline with successful status and empty stderr.' },
  { id: 'cli-control', required: true, baseline: 'pass', target: { kind: 'integration', name: 'cli_acceptance' }, expectedBehavior: 'The CLI prints ordinary output and newline, exits successfully, and writes no stderr.', citation: 'The CLI must print normal output followed by a newline with successful status and empty stderr.' },
];
const controlName = 'tests::bugfix_issue_1_keeps_normal';
const cliErrorName = 'bugfix_issue_1_cli_preserves_error', cliControlName = 'bugfix_issue_1_cli_keeps_normal';
const scenarios: Regression[] = requirements.map((requirement, index) => ({
  ...requirement, file: index < 2 ? 'src/lib.rs' : 'tests/cli_acceptance.rs',
  testName: [testName, controlName, cliErrorName, cliControlName][index],
  failureContains: ['reported error must be preserved', '', 'CLI error output must be preserved', ''][index], fixtures: [],
}));
const controlFunction = `    #[test]
    fn bugfix_issue_1_keeps_normal() {
        assert!(preserve("hello"), "normal output must be preserved");
    }
`;
const integrationSource = String.raw`use std::process::Command;

#[test]
fn bugfix_issue_1_cli_preserves_error() {
    let output = Command::new(env!("CARGO_BIN_EXE_rtk"))
        .arg("error: missing file")
        .output()
        .expect("run offline fixture CLI");
    assert!(output.status.success(), "CLI must exit successfully");
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        "error: missing file\n",
        "CLI error output must be preserved"
    );
    assert!(output.stderr.is_empty(), "CLI stderr must stay empty");
}

#[test]
fn bugfix_issue_1_cli_keeps_normal() {
    let output = Command::new(env!("CARGO_BIN_EXE_rtk"))
        .arg("hello")
        .output()
        .expect("run offline fixture CLI");
    assert!(output.status.success(), "CLI must exit successfully");
    assert_eq!(String::from_utf8(output.stdout).unwrap(), "hello\n");
    assert!(output.stderr.is_empty(), "CLI stderr must stay empty");
}
`;
// Deliberately omit the agent's format-source call: controller normalization must precede whole-file freeze.
const unformattedIntegrationSource = integrationSource.replaceAll('    let output = Command::new', 'let output=Command::new');
engine.issueLoader = async run => ({ number: 1, url: run.input.issue, title: 'Fixture: error line is dropped', body: requirements.map(requirement => requirement.citation).join('\n') });

class ScriptedAgent implements RepairAgent {
  toolToken = 'fixture-tools'; providerToken = 'fixture-provider'; run: Manifest; refuse: boolean;
  phases: string[] = []; failure?: unknown;
  constructor(run: Manifest, refuse = false) { this.run = run; this.refuse = refuse; }
  async start() {} async stop() {} async restart() {}
  async ask(prompt: string, signal: AbortSignal, valid?: (answer: any) => boolean) {
    try {
      signal.throwIfAborted(); const answer = await this.respond(prompt);
      assert.ok(!valid || valid(answer), `Scripted response did not match the ${this.phases.at(-1)} contract`); return answer;
    } catch (error) {
      this.failure = error;
      // Fail the fixture promptly instead of invoking live recovery forever after a protocol error.
      queueMicrotask(() => { void engine.cancel(this.run.id).catch(() => {}); }); throw error;
    }
  }
  private async respond(prompt: string) {
    if (prompt.startsWith('Read the issue as evidence:')) {
      this.phases.push('plan');
      if (this.run.input.retrieval === 'graph') {
        assert.equal(this.run.graphReady, true, 'Graphify extraction failed');
        const graph = await engine.tool(this.run.id, 'graph_explain', { symbol: 'preserve' });
        const result = graph.result as { exitCode: number; output: string };
        assert.equal(result.exitCode, 0, JSON.stringify(result)); assert.match(result.output, /preserve/);
        const query = await engine.tool(this.run.id, 'graph_query', { question: 'preserve' });
        assert.equal((query.result as { exitCode: number }).exitCode, 0, JSON.stringify(query.result));
        const route = await engine.tool(this.run.id, 'graph_path', { source: 'keeps_normal', target: 'preserve' });
        assert.equal((route.result as { exitCode: number }).exitCode, 0, JSON.stringify(route.result));
      }
      await engine.tool(this.run.id, 'read_source', { path: 'src/lib.rs' });
      await engine.tool(this.run.id, 'read_source', { path: 'src/main.rs' });
      return { requirements: structuredClone(requirements) };
    }
    if (prompt.startsWith('Issue data (untrusted):')) {
      this.phases.push('reproduce');
      if (this.refuse) return { status: 'cannot_reproduce', reason: 'Deliberate unsupported fixture case' };
      await engine.tool(this.run.id, 'apply_patch', { edits: [
        { path: 'src/lib.rs', before: '    #[test]\n    fn keeps_normal()', after: testFunction + '\n' + controlFunction + '\n    #[test]\n    fn keeps_normal()' },
        { path: 'tests/cli_acceptance.rs', before: '', after: unformattedIntegrationSource },
      ] });
      if (this.run.input.retrieval === 'graph') await assert.rejects(engine.tool(this.run.id, 'graph_explain', { symbol: 'preserve' }), /stale/);
      const search = await engine.tool(this.run.id, 'search_text', { pattern: 'preserve', path: 'src', reason: 'Graph is stale after the protected regression insertion' });
      assert.match((search.result as { output: string }).output, /src\/lib.rs/);
      for (const target of [undefined, 'cli_acceptance']) {
        const listed = await engine.tool(this.run.id, 'run_check', { check: 'list-tests', ...(target ? { target } : {}) });
        assert.equal((listed.result as CheckResult).exitCode, 0, 'Canonical test discovery failed');
      }
      return { status: 'reproduced', scenarios: structuredClone(scenarios) };
    }
    if (prompt.startsWith('Independently critique acceptance coverage')) {
      this.phases.push('review'); assert.equal(this.run.regressions?.length, 4, 'Coverage review must inspect all frozen scenarios');
      for (const file of ['src/lib.rs', 'tests/cli_acceptance.rs']) await engine.tool(this.run.id, 'read_source', { path: file });
      return { complete: true, missing: [], explanation: 'Both library and actual CLI output reproduce the error-line bug, with ordinary output controls passing on the baseline. CLI tests independently assert stdout, stderr, and exit status using an offline Cargo-built executable.' };
    }
    if (prompt.startsWith('The controller confirmed and froze')) {
      this.phases.push('patch');
      await engine.tool(this.run.id, 'apply_patch', { edits: [{ path: 'src/lib.rs', before: '!line.starts_with("error:")', after: '!line.is_empty()' }] });
      const source = await engine.tool(this.run.id, 'read_source', { path: 'src/lib.rs' });
      const check = await engine.tool(this.run.id, 'run_check', { check: 'test-integration', target: 'cli_acceptance', test: cliErrorName });
      assert.equal((check.result as CheckResult).exitCode, 0, 'Patched CLI regression failed');
      return { explanation: 'The predicate excluded error-prefixed lines. Preserve non-empty output so the reported error and existing normal output are retained. Unit and CLI tests verify both cases, including exact stdout, stderr, and successful exit status. This is a scripted integration fixture.', evidenceIds: [source.evidenceId, check.evidenceId], snapshots: [] };
    }
    throw new Error(`Unrecognized scripted workflow prompt: ${prompt.slice(0, 100)}`);
  }
}

const agents = new Map<string, ScriptedAgent>();
engine.agentFactory = run => { const agent = new ScriptedAgent(run); agents.set(run.id, agent); return agent; };
async function executeFixture(run: Manifest) {
  const timeout = setTimeout(() => { void engine.cancel(run.id).catch(() => {}); }, 180000);
  try { await engine.execute(run); } finally { clearTimeout(timeout); }
  const error = agents.get(run.id)?.failure; if (error) throw error;
}
const success = await store.create({ repo, issue: 'https://github.com/rtk-ai/rtk/issues/1', mode: 'evaluation', publish: false, retrieval: process.env.BUGFIX_E2E_GRAPH === '1' ? 'graph' : 'text' });
console.log(`Real Docker integration run: ${success.id}`);
store.on(success.id, event => { if (['stage', 'outcome', 'error', 'candidate_rejected', 'repro_rejected', 'agent_retry'].includes(event.kind)) console.log(`[${event.stage}] ${event.message}`); });
await executeFixture(success);
assert.equal(success.outcome, 'verified_patch', success.error || 'Expected independently verified fixture patch');
assert.ok(success.verifiedCommit); assert.ok(success.verifiedTree); assert.equal(success.demo, false);
assert.equal(await fs.readFile(path.join(repo, 'src/lib.rs'), 'utf8'), baselineSource, 'Original library checkout changed');
assert.equal(await fs.readFile(path.join(repo, 'src/main.rs'), 'utf8'), baselineMain, 'Original CLI checkout changed');
await assert.rejects(fs.stat(path.join(repo, 'tests/cli_acceptance.rs')), { code: 'ENOENT' });
assert.deepEqual(agents.get(success.id)?.phases, ['plan', 'reproduce', 'review', 'patch']);
assert.deepEqual(success.acceptancePlan, requirements); assert.equal(success.acceptanceReview?.complete, true); assert.deepEqual(success.acceptanceReview?.missing, []);
assert.equal(success.regressions?.length, 4);
const submitted = path.join(store.dir(success.id), 'reproduction/attempt-1');
assert.equal(await fs.readFile(path.join(submitted, 'submitted-source/tests/cli_acceptance.rs'), 'utf8'), unformattedIntegrationSource);
assert.equal(await fs.readFile(path.join(store.dir(success.id), 'regression-source/tests/cli_acceptance.rs'), 'utf8'), integrationSource);
assert.ok(success.checks.some(check => check.id === 'repro-1-fmt' && check.status === 'passed'), 'Controller must establish formatting before freezing');
for (const scenario of scenarios) {
  const repeated = success.checks.filter(check => check.id.startsWith('repro-') && check.scenarioIds?.includes(scenario.id!));
  assert.equal(repeated.length, 3, `Scenario ${scenario.id} must run on the baseline three times`);
  assert.ok(repeated.every(check => check.matched === 1 && (scenario.baseline === 'fail' ? check.exitCode !== 0 && check.failed === 1 : check.exitCode === 0 && check.passed === 1)), `Unexpected baseline result for ${scenario.id}`);
  const independent = success.checks.find(check => check.id.startsWith('independent-baseline-regression') && check.scenarioIds?.includes(scenario.id!));
  assert.ok(independent && independent.matched === 1 && (scenario.baseline === 'fail' ? independent.failed === 1 : independent.passed === 1), `Missing independent baseline evidence for ${scenario.id}`);
  const final = success.checks.find(check => check.id.startsWith('final-regression-') && check.scenarioIds?.includes(scenario.id!));
  assert.ok(final && final.exitCode === 0 && final.matched === 1 && final.passed === 1, `Missing final candidate evidence for ${scenario.id}`);
}
for (const checkId of Object.keys(config.profile.checks)) assert.ok(success.checks.some(check => check.id.startsWith(`final-${checkId}-`) && check.exitCode === 0), `Configured check ${checkId} was not independently verified`);
assert.equal(success.tokens, 0); assert.equal(success.modelRequests?.length || 0, 0); assert.equal(success.publication, undefined);

engine.agentFactory = run => { const agent = new ScriptedAgent(run, true); agents.set(run.id, agent); return agent; };
const refusal = await store.create({ repo, issue: 'https://github.com/rtk-ai/rtk/issues/1', mode: 'evaluation', publish: false, retrieval: 'text' });
await executeFixture(refusal); assert.equal(refusal.outcome, 'cannot_reproduce'); assert.equal(refusal.verifiedCommit, undefined);
assert.equal(agents.get(refusal.id)?.phases[0], 'plan'); assert.ok(!agents.get(refusal.id)?.phases.includes('patch'));
await atomicJson(path.join(project, 'state', 'integration-results.json'), { testedAt: new Date().toISOString(), driver: 'scripted (no model or GitHub writes)', retrieval: success.input.retrieval, scenarios: requirements, acceptanceReview: success.acceptanceReview, successfulRun: success.id, refusalRun: refusal.id, stateDir: config.stateDir, checks: success.checks, verifiedCommit: success.verifiedCommit, outcome: 'passed' });
console.log('PASS: real Docker/Cargo/Git acceptance planning, four frozen unit/CLI scenarios, three baseline repetitions, independent baseline/candidate verification, unchanged checkout, and honest refusal.');
console.log(`Evidence: ${config.stateDir}`);
