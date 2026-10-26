/** Real Docker/Git/Cargo integration. The scripted agent is explicitly NOT an LLM evaluation. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { Pipeline } from '../src/pipeline.ts';
import { loadConfig } from '../src/config.ts';
import { Store } from '../src/store.ts';
import { fixtureRepo, original, testFunction, testName, spec } from '../tests/helpers.ts';
import type { RepairAgent } from '../src/pipeline.ts';
import type { Manifest } from '../src/types.ts';
import { atomicJson } from '../src/store.ts';

const project = process.cwd();
const root = path.join(project, 'state', 'integration', randomBytes(5).toString('hex'));
const config = loadConfig({ ...process.env, BUGFIX_PROJECT_DIR: project, BUGFIX_STATE_DIR: path.join(root, 'state'), BUGFIX_REPO_ROOT: path.join(root, 'repos'), BUGFIX_MODEL: 'nvidia/scripted-test-driver', BUGFIX_GIT_NAME: 'Integration Test', BUGFIX_GIT_EMAIL: 'integration@example.invalid', BUGFIX_COMMAND_TIMEOUT_MS: '180000' });
await fs.mkdir(config.repoRoot, { recursive: true });
const repo = await fixtureRepo(config.repoRoot);
const store = new Store(config.stateDir); const engine = new Pipeline(config, store);
engine.issueLoader = async run => ({ number: 1, url: run.input.issue, title: 'Fixture: error line is dropped', body: 'The error line must be preserved.' });
class ScriptedAgent implements RepairAgent {
  toolToken = 'fixture-tools'; providerToken = 'fixture-provider'; run: Manifest; turn = 0; sourceEvidence = 0; testEvidence = 0; refuse = false;
  constructor(run: Manifest, refuse = false) { this.run = run; this.refuse = refuse; }
  async start() {} async stop() {}
  async ask(prompt = '') {
    if (this.refuse) return { status: 'cannot_reproduce', reason: 'Deliberate unsupported fixture case' };
    if (this.turn++ === 0) {
      if (this.run.input.retrieval === 'graph') {
        assert.equal(this.run.graphReady, true, 'Graphify extraction failed');
        const graph = await engine.tool(this.run.id, 'graph_explain', { symbol: 'preserve' });
        const result = graph.result as { exitCode: number; output: string };
        assert.equal(result.exitCode, 0, JSON.stringify(result));
        assert.match(result.output, /preserve/);
        const query = await engine.tool(this.run.id, 'graph_query', { question: 'preserve' });
        assert.equal((query.result as { exitCode: number }).exitCode, 0, JSON.stringify(query.result));
        const route = await engine.tool(this.run.id, 'graph_path', { source: 'keeps_normal', target: 'preserve' });
        assert.equal((route.result as { exitCode: number }).exitCode, 0, JSON.stringify(route.result));
      }
      const source = await engine.tool(this.run.id, 'read_source', { path: 'src/lib.rs' }); this.sourceEvidence = source.evidenceId;
      await engine.tool(this.run.id, 'apply_patch', { edits: [{ path: 'src/lib.rs', before: '    #[test]\n    fn keeps_normal()', after: testFunction + '\n    #[test]\n    fn keeps_normal()' }] });
      if (this.run.input.retrieval === 'graph') await assert.rejects(engine.tool(this.run.id, 'graph_explain', { symbol: 'preserve' }), /stale/);
      const search = await engine.tool(this.run.id, 'search_text', { pattern: 'preserve', path: 'src', reason: 'Graph is stale after the protected regression insertion' });
      assert.match((search.result as { output: string }).output, /src\/lib.rs/);
      const check = await engine.tool(this.run.id, 'run_check', { check: 'test-focused', test: testName }); this.testEvidence = check.evidenceId;
      return { status: 'reproduced', regression: { ...spec, examples: ['The error line must be preserved.'] } };
    }
    if (prompt.includes('code REVIEWER')) {
      assert.equal(this.run.stage, 'review'); await assert.rejects(engine.tool(this.run.id, 'apply_patch', { edits: [] }), /read-only/);
      return { examples: [{ example: 'The error line must be preserved.', expectedOutput: 'error: line kept', actualOutputWithPatch: 'error: line kept', matches: true, evidence: 'src/lib.rs:1' }], invariantEnforced: true, invariantNote: 'Every non-empty line is kept.', probes: [], gaps: [] };
    }
    if (prompt.includes('FINAL verified diff')) { assert.match(prompt, /is_empty/); return { title: 'fix(fixture): keep error lines in output', explanation: 'The predicate excluded error-prefixed lines; the verified diff keeps every non-empty line. Scripted integration fixture.' }; }
    await engine.tool(this.run.id, 'apply_patch', { edits: [{ path: 'src/lib.rs', before: '!line.starts_with("error:")', after: '!line.is_empty()' }] });
    return { explanation: 'The predicate excluded error-prefixed lines. Preserve non-empty output so the reported error and existing normal output are retained. This is a scripted integration fixture, not a model-generated RTK fix.', evidenceIds: [this.sourceEvidence, this.testEvidence], snapshots: [] };
  }
}
engine.agentFactory = run => new ScriptedAgent(run);
const success = await store.create({ repo, issue: 'https://github.com/rtk-ai/rtk/issues/1', mode: 'evaluation', publish: false, retrieval: process.env.BUGFIX_E2E_GRAPH === '1' ? 'graph' : 'text' });
console.log(`Real Docker integration run: ${success.id}`);
store.on(success.id, event => { if (['stage','outcome','error','candidate_rejected','repro_rejected'].includes(event.kind)) console.log(`[${event.stage}] ${event.message}`); });
await engine.execute(success);
assert.equal(success.outcome, 'verified_patch', success.error || 'Expected independently verified fixture patch');
assert.ok(success.verifiedCommit); assert.ok(success.verifiedTree); assert.equal(success.summary?.title, 'fix(fixture): keep error lines in output');
assert.equal(success.review?.passed, true, 'Expected the independent review to pass');
assert.deepEqual((await store.events(success.id)).filter(e => e.kind === 'stage').map(e => e.stage).filter((s, i, all) => s !== all[i - 1]), ['preflight', 'environment', 'discovery', 'reproduction', 'patching', 'review', 'verification']);
assert.equal(await fs.readFile(path.join(repo, 'src/lib.rs'), 'utf8'), original, 'Original checkout changed');
assert.equal(success.checks.filter(c => c.id.startsWith('repro-') && c.exitCode !== 0).length, 3);
assert.ok(success.checks.some(c => c.id.startsWith('independent-baseline-regression') && c.exitCode !== 0));
assert.equal(success.checks.filter(c => c.id.startsWith('final-') && c.exitCode === 0).length, 7);
engine.agentFactory = run => new ScriptedAgent(run, true);
const refusal = await store.create({ repo, issue: 'https://github.com/rtk-ai/rtk/issues/1', mode: 'evaluation', publish: false, retrieval: 'text' });
await engine.execute(refusal); assert.equal(refusal.outcome, 'cannot_reproduce'); assert.equal(refusal.verifiedCommit, undefined);
await atomicJson(path.join(project, 'state', 'integration-results.json'), { testedAt: new Date().toISOString(), driver: 'scripted (no model or GitHub writes)', retrieval: success.input.retrieval, successfulRun: success.id, refusalRun: refusal.id, stateDir: config.stateDir, checks: success.checks, verifiedCommit: success.verifiedCommit, outcome: 'passed' });
console.log('PASS: real Docker/Cargo/Git fail-to-pass, full verification, unchanged checkout, preserved evidence, and honest refusal.');
console.log(`Evidence: ${config.stateDir}`);
