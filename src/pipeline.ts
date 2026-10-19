import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Agent } from './agent.ts';
import { Docker } from './docker.ts';
import { Repository } from './git.ts';
import { Store, atomicJson } from './store.ts';
import { applyEdits, copySource, fingerprint, hash, inventory, safeRelative, sourcePath } from './files.ts';
import { assertCandidate, assertFrozen, failedAssertion, freezeRegression, regressionPassed, reproductionFailure } from './policy.ts';
import { fastChecks, focusedCheck } from './checks.ts';
import { checked } from './process.ts';
import { writeReport } from './report.ts';
import type { Candidate, CheckResult, Config, Issue, Manifest, Outcome, Regression, RunInput } from './types.ts';
import { defaultProfile } from './profile.ts';
import type { RepositoryProfile } from './profile.ts';

export class RunFailure extends Error { outcome: Outcome; constructor(outcome: Outcome, message: string) { super(message); this.outcome = outcome; } }
// A Docker/harness fault (daemon, exec or container failure): retried without blaming the reproduction or the candidate.
class HarnessFailure extends Error {}
// A verification verdict about the candidate (a failing test or check): returned to the agent as repair feedback.
class VerdictFailure extends Error {}
const harnessError = /Cannot connect to the Docker daemon|Error response from daemon|OCI runtime (?:exec|create|start) failed/;
export interface RepairAgent { toolToken: string; providerToken: string; preflight?(): Promise<void>; start(signal: AbortSignal): Promise<void>; ask(prompt: string, signal: AbortSignal, valid?: (answer: any) => boolean): Promise<any>; stop(): Promise<void>; interrupt?(): Promise<void>; restart?(signal: AbortSignal): Promise<void>; touch?(): void; }
interface Context { run: Manifest; abort: AbortController; agent: RepairAgent; source: string; base: string; phase: 'discovery' | 'reproduction' | 'patching' | 'locked'; queue: Promise<unknown>; providerRejected?: string; }
export function validateInput(input: RunInput, profile: RepositoryProfile = defaultProfile): RunInput {
  if (!input || typeof input.repo !== 'string' || !path.isAbsolute(input.repo)) throw new Error('Provide an absolute repository path');
  const issue = new URL(input.issue);
  const prefix = `/${profile.upstream}/issues/`;
  if (issue.protocol !== 'https:' || issue.hostname !== 'github.com' || !issue.pathname.startsWith(prefix) || !/^[1-9][0-9]*\/?$/.test(issue.pathname.slice(prefix.length)) || issue.search || issue.hash) throw new Error(`Provide a github.com/${profile.upstream}/issues/NUMBER URL`);
  if (input.mode && !['live', 'evaluation', 'demo'].includes(input.mode)) throw new Error('Invalid run mode');
  if (input.retrieval && !['graph', 'text'].includes(input.retrieval)) throw new Error('Invalid retrieval mode');
  if (input.base && (typeof input.base !== 'string' || input.base.startsWith('-') || /[\x00-\x20]/.test(input.base))) throw new Error('Invalid base ref');
  if (input.mode === 'evaluation' && input.publish) throw new Error('Historical evaluation cannot publish');
  return { ...input, mode: input.mode || 'live', retrieval: input.retrieval || 'graph', publish: input.mode === 'evaluation' ? false : !!input.publish };
}
export class Pipeline {
  config: Config; store: Store; docker: Docker; repository: Repository;
  contexts = new Map<string, Context>(); private active?: string;
  agentFactory: (run: Manifest) => RepairAgent;
  issueLoader: (run: Manifest) => Promise<Issue>;
  constructor(config: Config, store = new Store(config.stateDir)) {
    this.config = config; this.store = store; this.docker = new Docker(config, store); this.repository = new Repository(config);
    this.agentFactory = run => new Agent(config, this.docker, store, run);
    this.issueLoader = async run => {
      const number = Number(new URL(run.input.issue).pathname.split('/').filter(Boolean).at(-1));
      const response = await fetch(`https://api.github.com/repos/${(run.profile || this.config.profile).upstream}/issues/${number}`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'bugfix-agent/0.1' }, signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`GitHub issue fetch: HTTP ${response.status}; check network/API rate limits`);
      const issue = await response.json() as any;
      if (issue.pull_request) throw new Error('Input must be an issue, not a pull request');
      if (run.input.mode !== 'evaluation' && issue.state === 'closed') throw new Error('Live repairs require an open issue; use evaluation mode for historical cases');
      return { number, url: run.input.issue, title: String(issue.title || ''), body: String(issue.body || '').slice(0, 40000) };
    };
  }
  async recover() {
    for (const run of await this.store.list()) if (run.stage !== 'complete') {
      await this.docker.stopOrphans(run).catch(() => {});
      run.outcome = run.verifiedCommit ? 'verified_unpublished' : 'interrupted'; run.error = 'Controller restarted. Evidence preserved; start a new repair or retry publication for a verified commit.';
      run.stage = 'complete'; await this.store.save(run); await writeReport(this.store, run);
      await this.store.event(run, 'controller', 'outcome', run.outcome);
    }
  }
  async start(input: RunInput) {
    if (this.active) throw new Error(`One active run is supported; ${this.active} is still running`);
    this.active = 'starting';
    let run: Manifest; try { run = await this.store.create(validateInput(input, this.config.profile)); } catch (e) { this.active = undefined; throw e; }
    run.profile = structuredClone(this.config.profile); this.active = run.id;
    void this.execute(run).catch(error => { console.error(`Run ${run.id} could not finalize:`, error instanceof Error ? error.message : String(error)); }).finally(() => { this.active = undefined; }); return run;
  }
  async execute(run: Manifest): Promise<Manifest> {
    run.profile ||= structuredClone(this.config.profile); const profile = run.profile;
    if (this.contexts.size) throw new Error('A run is already active');
    const abort = new AbortController();
    const source = path.join(this.store.dir(run.id), 'source'), base = path.join(this.store.dir(run.id), 'base');
    const agent = this.agentFactory(run); const context: Context = { run, abort, agent, source, base, phase: 'discovery', queue: Promise.resolve() };
    this.contexts.set(run.id, context);
    try {
      await this.store.stage(run, 'preflight', 'Checking repository, issue and configuration');
      if (!/^[^/\s]+\/[^\s]+$/.test(this.config.model) || /REPLACE|YOUR_|placeholder/i.test(this.config.model)) throw new Error('Set BUGFIX_MODEL to your existing OpenCode provider/model ID');
      if (run.input.publish && (!this.config.fork || !this.config.gitName || !this.config.gitEmail || /YOUR_|Your Name|you@example/i.test(this.config.fork + this.config.gitName + this.config.gitEmail))) throw new Error('Publishing requires your configured fork, Git author name and email');
      await agent.preflight?.();
      if (run.input.publish) { await this.requirePublishSecret(); await this.docker.imageId(this.config.publisherImage); }
      run.issue = await this.persist(context, 'Fetch the GitHub issue', () => this.issueLoader(run), e => /pull request|open issue|HTTP 404|HTTP 410/.test(String(e)));
      run.model = this.config.model;
      await atomicJson(path.join(this.store.dir(run.id), 'issue.json'), run.issue);
      await this.persist(context, 'Prepare the repository snapshot', () => this.repository.preflight(run, base), e => !/Fetch upstream contribution base/.test(String(e)));
      await copySource(base, source); await this.store.save(run);
      await this.store.stage(run, 'environment', 'Preparing locked dependencies and trusted baseline cache');
      await this.docker.prepare(run, base, abort.signal); await this.store.save(run);
      await this.restartWorker(context);
      await this.store.stage(run, 'discovery', 'Building original-snapshot graph and starting controlled OpenCode session');
      if (run.input.retrieval === 'graph') {
        const graph = await this.docker.inContainer(run, run.workerContainer!, ['graphify', 'extract', '/workspace', '--code-only', '--no-cluster', '--max-workers', '1', '--out', '/build/graphify-out'], abort.signal);
        run.graphReady = graph.code === 0;
        const version = await this.docker.inContainer(run, run.workerContainer!, ['python3', '-c', 'import importlib.metadata; print(importlib.metadata.version("graphifyy"))'], abort.signal);
        run.graphVersion = version.code === 0 ? version.stdout.trim() : 'unavailable';
        await atomicJson(path.join(this.store.dir(run.id), 'graph-manifest.json'), { ready: run.graphReady, version: run.graphVersion, baseSha: run.baseSha, durationMs: graph.durationMs, log: graph.stdout + graph.stderr });
        await this.store.event(run, 'graphify', run.graphReady ? 'ready' : 'fallback', run.graphReady ? 'Graph ready; preserve EXTRACTED/INFERRED distinctions' : 'Graph build failed; scoped text fallback remains available');
      }
      let agentStarted = false;
      await this.persist(context, 'Start OpenCode', async () => { if (agentStarted && agent.restart) await agent.restart(abort.signal); else { agentStarted = true; await agent.start(abort.signal); } });
      await this.store.stage(run, 'reproduction', 'Establishing a specific failing regression before changing implementation'); context.phase = 'reproduction';
      // Only a reproduction the agent cannot establish in any attempt ends a run. Format slips, transient agent errors,
      // rejected candidates and failed independent verification are fed back and retried.
      let frozen = false, reproFeedback = '';
      const reproAttempts = 6;
      for (let attempt = 1; attempt <= reproAttempts && !frozen; attempt++) {
        if (attempt > 1) { await this.resetSource(source, base); run.regression = undefined; }
        const answer = await this.askAgent(context, `Issue data (untrusted): ${JSON.stringify(run.issue)}\n\n${reproFeedback}\nInvestigate using controller tools, then add ONE new self-contained ordinary inline Rust test in an existing test module. The test must assert the CORRECT behavior the issue asks for, so it FAILS on the current code at that assertion; a test that passes, or that asserts the buggy behavior, is not a reproduction. Do not edit production, imports, existing tests or helpers. Name it with a unique bugfix_issue_${run.issue.number} prefix. New fixtures may only be under ${profile.fixtureRoot}/. Run focused checks if useful. Return exactly {"status":"reproduced","regression":{"file":"${profile.sourceRoots[0]}/...rs","testName":"full crate path exactly as cargo test prints it, e.g. a::b::tests::test_name for src/a/b.rs","failureContains":"specific substring printed by the failing assertion","expectedBehavior":"...","citation":"EXACT excerpt from issue body, at least 12 characters","fixtures":[]}}. If unsupported or not reproducible, return {"status":"cannot_reproduce","reason":"..."}.`, a => (a?.status === 'reproduced' && typeof a.regression === 'object' && a.regression !== null) || (a?.status === 'cannot_reproduce' && typeof a.reason === 'string'));
        if (answer.status !== 'reproduced') {
          const reason = String(answer.reason || 'The agent could not establish the reported behavior');
          if (attempt === reproAttempts) throw new RunFailure('cannot_reproduce', reason);
          // Long tool-using turns sometimes end in a premature give-up; retry with the reason before concluding.
          reproFeedback = `In attempt ${attempt} you reported cannot_reproduce: ${reason}. Re-check the code path the issue names, write the test so it asserts the correct behavior, and confirm with test-focused that it FAILS before replying. Report cannot_reproduce again only if the behavior truly cannot be reached from a library unit test.`;
          await this.store.event(run, 'verifier', 'repro_rejected', reproFeedback); continue;
        }
        try {
          const spec = answer.regression as Regression;
          // The citation is advisory: compared ignoring whitespace and Markdown marks, and flagged for review when it is not a verbatim excerpt.
          const plain = (text: string) => text.replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();
          spec.citation = typeof spec.citation === 'string' ? spec.citation : '';
          spec.citationVerified = plain(spec.citation).length >= 12 && plain(run.issue.body).includes(plain(spec.citation));
          if (!spec.citationVerified) await this.store.event(run, 'verifier', 'citation_unverified', `Citation is not a verbatim issue excerpt; flagged for human review: ${spec.citation.slice(0, 300)}`);
          spec.failureContains = typeof spec.failureContains === 'string' ? spec.failureContains : '';
          run.regression = await freezeRegression(base, source, spec, profile);
          await this.retryHarness(context, async () => { for (let repeat = 1; repeat <= 3; repeat++) {
            const result = await this.check(context, run.workerContainer!, `repro-${attempt}-${repeat}`, focusedCheck('test-focused', spec.testName, profile));
            if (result.exitCode === 0 || result.timedOut) throw new Error('The named test passed or timed out on the current code; it must assert the correct behavior and FAIL');
            if (!spec.failureContains || !reproductionFailure(result.output, spec.testName, spec.failureContains)) {
              const actual = failedAssertion(result.output, spec.testName);
              if (!actual) throw new Error('The named test did not fail at an assertion; compile/setup failures and zero-test matches are not reproduction');
              if (repeat > 1) throw new Error(`The test failed differently on repeat ${repeat} (${actual}); the reproduction must be deterministic`);
              await this.store.event(run, 'verifier', 'failure_adopted', `Using the observed assertion message as the failure signature: ${actual}`);
              spec.failureContains = actual; spec.failureAdopted = true;
            }
            await assertFrozen(source, run.regression!);
          } });
          run.regression = await freezeRegression(base, source, spec, profile);
          await fs.rm(path.join(this.store.dir(run.id), 'regression-source'), { recursive: true, force: true });
          await copySource(source, path.join(this.store.dir(run.id), 'regression-source'));
          await atomicJson(path.join(this.store.dir(run.id), 'reproduction/frozen.json'), run.regression);
          await fs.writeFile(path.join(this.store.dir(run.id), 'reproduction/regression.patch'), await this.repository.diff(run, source));
          frozen = true;
        } catch (e) { reproFeedback = `The controller rejected reproduction attempt ${attempt}: ${String(e)}. Source is reset to the original snapshot for the next attempt.`; await this.store.event(run, 'verifier', 'repro_rejected', reproFeedback); }
      }
      if (!frozen || !run.regression) throw new RunFailure('cannot_reproduce', reproFeedback);
      await this.store.stage(run, 'patching', 'Regression frozen; trying a bounded minimal implementation change'); context.phase = 'patching';
      // Patching continues round after round (a fresh agent session each round) until a candidate passes independent
      // verification or the run is cancelled.
      // A harness fault during verification re-runs verification (5 in a row is a real environment problem).
      let feedback = '', verified = '', n = 0, workerRunning = true, reverify = false, harnessFaults = 0;
      const frozenSource = path.join(this.store.dir(run.id), 'regression-source');
      for (let round = 1; !verified; round++) {
        if (round > 1 && !reverify) {
          if (!workerRunning) { await this.restartWorker(context); workerRunning = true; }
          await this.persist(context, 'Restart OpenCode', () => agent.restart ? agent.restart(abort.signal) : Promise.resolve());
          await this.store.stage(run, 'patching', `Repairing again with a fresh agent session (round ${round})`); context.phase = 'patching';
        }
        let ready = reverify; reverify = false;
        if (!ready) for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
          n++; run.attempt = n; await this.store.save(run);
          const answer = await this.askAgent(context, `The controller confirmed and froze ${run.regression.spec.testName}. Fix implementation only, preserving frozen test/fixtures, all existing tests, manifests and CI. ${feedback}\nUse apply_patch and run_check as needed. Return exactly {"explanation":"root cause, evidence, and resulting behavior","evidenceIds":[SOURCE_READ_EVENT_ID,TEST_CHECK_EVENT_ID],"snapshots":[]}. A justified snapshot update must list {"path":"...","owner":"changed source path","reason":"issue-grounded explanation"}; it will require human review. Stop honestly with {"cannot_fix":"reason"} if needed.`, a => typeof a?.explanation === 'string' || typeof a?.cannot_fix === 'string');
          if (answer.cannot_fix) {
            feedback = `In attempt ${n} you reported cannot_fix: ${String(answer.cannot_fix)}. The frozen test defines the required behavior; make the smallest implementation change that makes it pass without breaking other tests.`;
            await this.store.event(run, 'verifier', 'candidate_rejected', feedback); await this.revertCandidate(run, source, frozenSource); continue;
          }
          try {
            run.candidate = answer as Candidate;
            if (!Array.isArray(run.candidate.evidenceIds)) run.candidate.evidenceIds = [];
            // Evidence IDs are bookkeeping: fill in the latest real source read and check result when the agent omits them.
            const evidence = await this.store.events(run.id);
            const cited = evidence.filter(e => run.candidate!.evidenceIds.includes(e.seq) && e.kind === 'result');
            for (const tool of ['read_source', 'run_check']) if (!cited.some(e => (e.data as any)?.tool === tool)) {
              const latest = evidence.findLast(e => e.source === 'tool' && e.kind === 'result' && (e.data as any)?.tool === tool);
              if (latest) run.candidate.evidenceIds.push(latest.seq);
            }
            await assertCandidate(base, source, run.regression, run.candidate, profile);
            const testName = run.regression.spec.testName;
            await this.retryHarness(context, async () => { for (const [name, argv] of fastChecks(testName, profile)) {
              const check = await this.check(context, run.workerContainer!, `attempt-${n}-${name}`, argv);
              if (check.exitCode || check.timedOut || (name === 'test-focused' && !regressionPassed(check.output, testName))) throw new Error(`${name} failed; see event/log evidence ${check.log}\n${check.output.slice(-12000)}`);
            } });
            await assertCandidate(base, source, run.regression, run.candidate, profile);
            await fs.mkdir(path.join(this.store.dir(run.id), 'candidates', String(n)), { recursive: true });
            await fs.writeFile(path.join(this.store.dir(run.id), 'candidates', String(n), 'candidate.patch'), await this.repository.diff(run, source));
            ready = true; break;
          } catch (e) {
            if (abort.signal.aborted) throw e;
            // A rejected candidate is rolled back to the frozen reproduction so the next attempt starts clean.
            feedback = `Attempt ${n} rejected: ${String(e)}. Your edits were rolled back to the frozen reproduction state.`; await this.store.event(run, 'verifier', 'candidate_rejected', feedback); await this.revertCandidate(run, source, frozenSource);
          }
        }
        if (!ready) continue;
        context.phase = 'locked'; await this.docker.remove(run.workerContainer!); workerRunning = false;
        await this.store.stage(run, 'verification', 'Verifying baseline failure and candidate success in independent containers');
        const target = path.join(this.store.dir(run.id), 'verified-source'); const started: string[] = [];
        try {
          await assertCandidate(base, source, run.regression, run.candidate!, profile);
          await fs.rm(target, { recursive: true, force: true }); await copySource(source, target);
          const contentHash = fingerprint(await inventory(target)); run.verifiedTree = await this.repository.tree(run, target);
          const harness = async <T>(step: Promise<T>) => { try { return await step; } catch (e) { throw e instanceof HarnessFailure ? e : new HarnessFailure(String(e instanceof Error ? e.message : e)); } };
          const baseline = await harness(this.docker.startWorker(run, frozenSource, run.image!, true, `repro-verifier-${round}`)); started.push(baseline);
          await harness(this.docker.inContainer(run, baseline, ['python3', '/opt/bugfix/prepare.py', 'invalidate-workspace'], abort.signal).then(r => checked(r, 'Invalidate cached workspace outputs')));
          const fail = await this.check(context, baseline, `independent-baseline-regression-${round}`, focusedCheck('test-focused', run.regression.spec.testName, profile));
          if (fail.exitCode === 0 || fail.timedOut || !reproductionFailure(fail.output, run.regression.spec.testName, run.regression.spec.failureContains)) throw new HarnessFailure('Fresh baseline did not reproduce the protected failure');
          const verifier = await harness(this.docker.startWorker(run, target, run.image!, true, `verifier-${round}`)); started.push(verifier);
          await harness(this.docker.inContainer(run, verifier, ['python3', '/opt/bugfix/prepare.py', 'invalidate-workspace'], abort.signal).then(r => checked(r, 'Force rebuild of workspace code/tests')));
          const pass = await this.check(context, verifier, `final-regression-${round}`, focusedCheck('test-focused', run.regression.spec.testName, profile));
          if (pass.exitCode || !regressionPassed(pass.output, run.regression.spec.testName)) throw new VerdictFailure(`Fresh candidate did not pass the protected regression\n${pass.output.slice(-6000)}`);
          for (const [name, argv] of Object.entries(profile.checks)) {
            const result = await this.check(context, verifier, `final-${name}-${round}`, argv);
            if (result.exitCode || result.timedOut) throw new VerdictFailure(`Final ${name} failed\n${result.output.slice(-12000)}`);
          }
          await assertFrozen(target, run.regression).catch(e => { throw new VerdictFailure(String(e instanceof Error ? e.message : e)); });
          if (fingerprint(await inventory(target)) !== contentHash || await this.repository.tree(run, target) !== run.verifiedTree) throw new Error('Verified source changed during execution');
          verified = target;
        } catch (e) {
          if (abort.signal.aborted) throw e;
          const message = String(e instanceof Error ? e.message : e);
          if (e instanceof VerdictFailure) {
            harnessFaults = 0;
            feedback = `Independent verification of your change failed: ${message}. Fix the implementation so this passes while the frozen test keeps passing.`;
            await this.store.event(run, 'verifier', 'verification_rejected', feedback.slice(0, 20000));
          } else {
            if (++harnessFaults >= 5) throw new RunFailure('environment_blocked', `Independent verification could not run 5 times in a row: ${message}`);
            reverify = true; await this.store.event(run, 'verifier', 'verification_retry', `Verification harness fault (${message.slice(0, 500)}); re-running verification`);
            await sleep(15_000, undefined, { signal: abort.signal });
          }
        } finally { for (const name of started) await this.docker.remove(name).catch(() => {}); }
      }
      await fs.writeFile(path.join(this.store.dir(run.id), 'candidate.patch'), await this.repository.diff(run, verified));
      run.outcome = 'verified_patch'; await this.store.save(run); await writeReport(this.store, run);
      if (this.config.gitName && this.config.gitEmail) { await this.repository.commit(run, verified, path.join(this.store.dir(run.id), 'verified.bundle')); await this.store.save(run); }
      // Publication is idempotent (the publisher reconciles an existing PR first), so transient failures are retried.
      if (run.input.publish) for (let attempt = 1; attempt <= 5; attempt++) { await this.publish(run, abort.signal); if ((run.outcome as string) === 'draft_created' || abort.signal.aborted) break; if (attempt < 5) await sleep(Math.min(300, 30 * 2 ** (attempt - 1)) * 1000, undefined, { signal: abort.signal }); }
    } catch (error) {
      if (abort.signal.aborted) { const reason = abort.signal.reason; run.outcome = reason instanceof RunFailure ? reason.outcome : 'cancelled'; }
      else if (error instanceof RunFailure) run.outcome = error.outcome;
      else run.outcome = ['verified_patch', 'verified_unpublished', 'draft_created'].includes(run.outcome || '') ? 'verified_unpublished' : run.stage === 'verification' || run.stage === 'patching' ? 'verification_failed' : 'environment_blocked';
      run.error = String(error instanceof Error ? error.message : error);
      await this.store.event(run, 'controller', 'error', run.error);
    } finally {
      try {
        context.phase = 'locked'; await agent.stop().catch(() => {}); await this.docker.cleanup(run);
        run.stage = 'complete'; await this.store.save(run); await writeReport(this.store, run);
        await this.store.event(run, 'controller', 'outcome', run.outcome || 'interrupted');
      } finally { this.contexts.delete(run.id); }
    }
    return run;
  }
  async check(context: Context, container: string, id: string, argv: string[]) {
    const { run } = context; this.ensureActive(context); context.agent.touch?.();
    await this.store.event(run, 'check', 'started', argv.join(' '), { id });
    const result = await this.docker.inContainer(run, container, argv, context.abort.signal);
    if (result.code && !context.abort.signal.aborted && harnessError.test(result.stderr)) throw new HarnessFailure(`Docker could not run ${id}: ${result.stderr.slice(0, 500)}`);
    const relative = `${run.stage === 'verification' ? 'verification' : run.stage === 'reproduction' ? 'reproduction' : `candidates/${run.attempt}`}/${id}.log`;
    await fs.mkdir(path.dirname(path.join(this.store.dir(run.id), relative)), { recursive: true });
    const output = result.stdout + result.stderr; await fs.writeFile(path.join(this.store.dir(run.id), relative), output);
    const check: CheckResult = { id, argv, exitCode: result.code, durationMs: result.durationMs, log: relative, timedOut: result.timedOut };
    run.checks.push(check); await this.store.save(run); await this.store.event(run, 'check', 'finished', `${id}: exit ${result.code}`, check);
    return { ...check, output };
  }
  // Retries an infrastructure step (network, Docker, OpenCode start) with capped backoff until it succeeds or the run is
  // cancelled; `permanent` marks answers no retry can change (a closed issue, a dirty checkout).
  private async persist<T>(context: Context, label: string, step: () => Promise<T>, permanent: (e: unknown) => boolean = () => false): Promise<T> {
    for (let failure = 1; ; failure++) {
      try { return await step(); } catch (e) {
        if (context.abort.signal.aborted || e instanceof RunFailure || permanent(e)) throw e;
        const wait = Math.min(120, 5 * 2 ** Math.min(failure - 1, 5));
        await this.store.event(context.run, 'controller', 'infra_retry', `${label} failed (${String(e instanceof Error ? e.message : e).slice(0, 300)}); retrying in ${wait}s`);
        await sleep(wait * 1000, undefined, { signal: context.abort.signal });
      }
    }
  }
  // (Re)starts the editable repository container, replacing a dead or leftover one.
  private async restartWorker(context: Context) {
    const { run } = context;
    run.workerContainer = await this.persist(context, 'Start the repository container', async () => { await this.docker.remove(`bugfix-${run.id}-worker`); return this.docker.startWorker(run, context.source); });
  }
  // Runs checks; a Docker/harness fault restarts the worker and re-runs them instead of rejecting the work under test.
  private async retryHarness(context: Context, checks: () => Promise<void>) {
    for (let fault = 1; ; fault++) {
      try { return await checks(); } catch (e) {
        if (!(e instanceof HarnessFailure) || context.abort.signal.aborted) throw e;
        if (fault >= 5) throw new RunFailure('environment_blocked', `Docker could not run checks 5 times in a row: ${e.message}`);
        await this.store.event(context.run, 'controller', 'infra_retry', `${e.message.slice(0, 300)}; restarting the repository container`);
        await sleep(10_000 * fault, undefined, { signal: context.abort.signal }); await this.restartWorker(context);
      }
    }
  }
  private async revertCandidate(run: Manifest, source: string, frozenSource: string) { await this.resetSource(source, frozenSource); await this.repository.mirror(run, source); }
  // Retries an agent turn until it yields an answer or the run is cancelled. Each failure (network, OpenCode or provider
  // error, stall, unparsable reply) interrupts the turn; every third consecutive failure restarts OpenCode with a fresh
  // session. Only a credential the provider rejected (HTTP 401/403) stops the run, since no retry can fix it.
  private async askAgent(context: Context, prompt: string, valid: (answer: any) => boolean): Promise<any> {
    for (let failure = 1; ; failure++) {
      try { return await context.agent.ask(prompt, context.abort.signal, valid); } catch (e) {
        if (context.abort.signal.aborted) throw e;
        if (context.providerRejected) throw new RunFailure('environment_blocked', `The model provider rejected the request (${context.providerRejected}): check .secrets/nvidia_api_key and BUGFIX_MODEL`);
        const message = String(e instanceof Error ? e.message : e).slice(0, 300), wait = Math.min(60, 5 * failure);
        await this.store.event(context.run, 'controller', 'agent_retry', `Agent turn failed (${message}); retrying in ${wait}s`);
        if (failure % 3 === 0 && context.agent.restart) await context.agent.restart(context.abort.signal).catch(error => this.store.event(context.run, 'controller', 'agent_retry', `OpenCode restart failed: ${String(error).slice(0, 300)}`));
        else await context.agent.interrupt?.();
        await sleep(wait * 1000, undefined, { signal: context.abort.signal });
      }
    }
  }
  // A cancelled run accepts no further tool calls, checks or model requests. There is no token, tool or time cap.
  ensureActive(context: Context) { if (context.abort.signal.aborted) throw context.abort.signal.reason; }
  async tool(id: string, name: string, args: any) {
    const context = this.contexts.get(id); if (!context) throw new Error('Run is not active');
    const pending = context.queue.catch(() => {}).then(() => this.performTool(context, name, args)); context.queue = pending; return pending;
  }
  private async performTool(context: Context, name: string, args: any) {
    this.ensureActive(context); context.agent.touch?.(); const { run, source } = context;
    if (context.phase === 'locked') throw new Error('Agent tools are locked during independent verification/publication');
    run.tools++; await this.store.save(run);
    const called = await this.store.event(run, 'tool', 'called', name, { tool: name, args }); let result: unknown;
    try {
      if (name.startsWith('graph_')) {
        if (run.input.retrieval === 'text') throw new Error('Graph tools are absent in text control mode');
        if (run.graphStale || !run.graphReady) throw new Error('Graph is stale or unavailable; use read_source/search_text with a reason');
        const clean = (v: unknown) => { if (typeof v !== 'string' || !v || v.length > 1000 || v.startsWith('-')) throw new Error('Invalid graph query'); return v; };
        const argv = name === 'graph_query' ? ['query', clean(args.question)] : name === 'graph_explain' ? ['explain', clean(args.symbol)] : name === 'graph_path' ? ['path', clean(args.source), clean(args.target)] : [];
        if (!argv.length) throw new Error('Unknown graph operation');
        const graph = await this.docker.inContainer(run, run.workerContainer!, ['graphify', ...argv, '--graph', '/build/graphify-out/graph.json'], context.abort.signal);
        result = { exitCode: graph.code, output: (graph.stdout + graph.stderr).slice(0, 20000) };
      } else if (name === 'read_source') {
        const file = await sourcePath(source, args.path); const stat = await fs.stat(file);
        if (stat.size > 2_000_000) throw new Error('File is too large; choose a smaller source/fixture');
        const lines = (await fs.readFile(file, 'utf8')).split('\n'); const start = Number(args.start || 1), end = Number(args.end || Math.min(lines.length, start + 249));
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start > 399) throw new Error('Read 1–400 lines');
        result = { path: args.path, totalLines: lines.length, text: lines.slice(start - 1, end).map((s, i) => `${start + i}: ${s}`).join('\n') };
      } else if (name === 'search_text') {
        if (typeof args.reason !== 'string' || args.reason.length < 8 || typeof args.pattern !== 'string' || args.pattern.length > 300) throw new Error('Scoped search needs a pattern and substantive fallback reason');
        const relative = args.path === '.' ? '.' : safeRelative(args.path); if (relative !== '.') await sourcePath(source, relative);
        const argv = args.pattern ? ['rg', '--fixed-strings', '--line-number', '--max-count', '30', '--', args.pattern, relative] : ['rg', '--files', '--', relative];
        let search = await this.docker.inContainer(run, run.workerContainer!, argv, context.abort.signal);
        if (search.code === 126 || search.code === 127) search = await this.docker.inContainer(run, run.workerContainer!, ['grep', '-RFn', '--', args.pattern, relative], context.abort.signal);
        result = { output: (search.stdout + search.stderr).slice(0, 18000), exitCode: search.code, fallbackReason: args.reason };
      } else if (name === 'apply_patch') {
        if (!['reproduction', 'patching'].includes(context.phase)) throw new Error('Edits are unavailable in this stage');
        const backups = new Map<string, string | null>();
        // Some models send the edits array JSON-encoded as a string; accept both shapes.
        if (typeof args.edits === 'string') { try { args.edits = JSON.parse(args.edits); } catch { throw new Error('edits must be an array of {path, before, after} objects'); } }
        if (!Array.isArray(args.edits)) throw new Error('edits must be an array of {path, before, after} objects');
        for (const edit of args.edits) {
          const file = await sourcePath(source, edit.path, true);
          if (!backups.has(edit.path)) backups.set(edit.path, await fs.readFile(file, 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e; }));
        }
        try {
          const profile = run.profile || this.config.profile;
          await applyEdits(source, args.edits, [...profile.sourceRoots, ...profile.testRoots]);
          if (run.regression && context.phase === 'patching') await assertFrozen(source, run.regression);
        } catch (error) {
          for (const [relative, content] of backups) { const file = await sourcePath(source, relative, true); if (content === null) await fs.rm(file, { force: true }); else await fs.writeFile(file, content); }
          throw error;
        }
        run.graphStale = true;
        await this.repository.mirror(run, source); result = { changed: args.edits.map((e: any) => e.path), graphStale: true };
      } else if (name === 'run_check') {
        if (run.regression && context.phase === 'patching') await assertFrozen(source, run.regression);
        const profile = run.profile || this.config.profile;
        const argv = ['test-focused', 'test-module'].includes(args.check) ? focusedCheck(args.check, args.test || '', profile) : profile.fastCheckIds.includes(args.check) ? profile.checks[args.check] : null;
        if (!argv) throw new Error('Unknown approved check');
        const check = await this.check(context, run.workerContainer!, `tool-${run.tools}-${args.check}`, argv); const checked: typeof check & { note?: string } = { ...check, output: check.output.slice(-24000) }; result = checked;
        // A filter that matches nothing exits 0; say so, or the model reads it as a pass.
        if (args.check.startsWith('test-') && !check.exitCode && /test result: ok\. 0 passed; 0 failed;/.test(check.output) && !/test result: ok\. [1-9]/.test(check.output)) checked.note = `No library unit test matched "${args.test}". Focused/module checks run only inline #[cfg(test)] tests under ${profile.sourceRoots.join(', ')} (cargo test --lib), named by crate path as cargo prints it, e.g. hooks::hook_cmd::tests::name. Integration tests in ${profile.testRoots.join(', ')}/*.rs cannot be run or used as the regression.`;
      } else throw new Error('Unknown controller tool');
      const event = await this.store.event(run, 'tool', 'result', name, { tool: name, call: called.seq, result });
      return { evidenceId: event.seq, result };
    } catch (error) { await this.store.event(run, 'tool', 'rejected', String(error), { tool: name, call: called.seq }); throw error; }
  }
  async cancel(id: string) { const context = this.contexts.get(id); if (!context) throw new Error('Run is not active'); context.abort.abort(new RunFailure('cancelled', 'Cancelled by user')); await context.agent.stop(); await this.docker.cleanup(context.run); }
  private async resetSource(source: string, base: string) { for (const entry of await fs.readdir(source)) await fs.rm(path.join(source, entry), { recursive: true, force: true }); await copySource(base, source); }
  async publish(run: Manifest, signal = AbortSignal.timeout(this.config.commandTimeoutMs)) {
    if (run.demo || run.input.mode === 'evaluation' || !run.verifiedTree || !run.verifiedCommit) throw new Error('Only a verified live commit can be published');
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]+$/.test(this.config.fork)) throw new Error('Configure a personal OWNER/REPOSITORY fork');
    const profile = run.profile || this.config.profile;
    await this.requirePublishSecret(); await this.docker.imageId(this.config.publisherImage);
    await this.store.stage(run, 'publishing', 'Pushing the exact verified commit and reconciling draft PR creation');
    run.publication = { ...run.publication, state: 'pending', fork: this.config.fork, head: run.branch!, base: profile.baseBranch }; await this.store.save(run); await writeReport(this.store, run);
    await atomicJson(path.join(this.store.dir(run.id), 'publication-input.json'), { runId: run.id, upstream: profile.upstream, fork: this.config.fork, branch: run.branch, commit: run.verifiedCommit, tree: run.verifiedTree, issue: run.issue!.number, base: profile.baseBranch });
    const container = `bugfix-${run.id}-publisher`;
    try {
      const result = await this.docker.command(['run', '--name', container, '--label', `bugfix.run=${run.id}`, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--mount', `type=bind,source=${this.store.dir(run.id)},target=/artifacts`, '--mount', `type=bind,source=${this.config.githubSecret},target=/run/secrets/github_token,readonly`, this.config.publisherImage], run, signal);
      const outcome = JSON.parse(await fs.readFile(path.join(this.store.dir(run.id), 'publication-result.json'), 'utf8').catch(() => '{}'));
      if (result.code || !outcome.url || outcome.commit !== run.verifiedCommit) throw new Error(outcome.error || result.stderr || 'Publisher failed or result is uncertain; retry reconciles GitHub before creating another PR');
      run.publication.state = 'created'; run.publication.url = outcome.url; run.outcome = 'draft_created';
      await this.store.event(run, 'publisher', 'draft_created', outcome.url);
    } catch (e) { run.publication.state = 'failed'; run.publication.error = String(e); run.outcome = 'verified_unpublished'; await this.store.event(run, 'publisher', 'failed', String(e)); }
    finally { await this.docker.remove(container); await this.store.save(run); await writeReport(this.store, run); }
  }
  async retryPublication(id: string) {
    if (this.active || this.contexts.size) throw new Error('Another run is active');
    const run = await this.store.get(id);
    if (!['verified_unpublished', 'verified_patch'].includes(run.outcome || '') || !run.verifiedCommit) throw new Error('No verified committed result is available to publish');
    this.active = id; try { await this.publish(run); run.stage = 'complete'; await this.store.save(run); } finally { this.active = undefined; } return run;
  }
  private async requirePublishSecret() {
    const result = await this.docker.command(['run', '--rm', '--network', 'none', '--cap-drop', 'ALL', '--entrypoint', '/usr/bin/test', '--mount', `type=bind,source=${this.config.githubSecret},target=/run/secrets/github_token,readonly`, this.config.publisherImage, '-s', '/run/secrets/github_token']);
    checked(result, 'Publisher credential file is missing or empty');
  }
}
