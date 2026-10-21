import timers from 'node:timers/promises';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Agent, type AgentPhase } from './agent.ts';
import { Docker } from './docker.ts';
import { Repository } from './git.ts';
import { Store, atomicJson } from './store.ts';
import { applyEdits, changedFiles, copySource, fingerprint, hash, inventory, safeRelative, sourcePath } from './files.ts';
import { assertCandidate, assertFrozen, assertReproductionEdits, failedAssertion, freezeRegression, regressionPassed, reproductionFailure } from './policy.ts';
import { fastChecks, focusedCheck } from './checks.ts';
import { checked } from './process.ts';
import { writeReport, prTitle } from './report.ts';
import { candidateEvidenceChecks, normalizeCandidateEvidence, validateEvidence } from './evidence.ts';
import { ProgressTracker, type VerificationVerdict, type ImmutableOffender } from './progress.ts';
import { agentProviderFailure } from './agent-recovery.ts';
import type { ProviderFailure } from './provider-health.ts';
import { rustTests } from './rust.ts';
import { coverageReviewPromptSchema, validateCoverageReview } from './coverage-review.ts';
import { fetchCompetingPullRequests } from './competing.ts';
import { inspectPublication } from './publication.ts';
import type { Candidate, CheckResult, Config, Issue, Manifest, Outcome, Regression, RunInput } from './types.ts';
import { defaultProfile } from './profile.ts';
import type { RepositoryProfile } from './profile.ts';
import { OperationAdmission, bindPublicationIdentity, captureRunConfiguration } from './lifecycle.ts';
import { fetchGitHubIssue, GitHubIssueError } from './github.ts';
import { scenarioList, freezeRegressions, assertFrozenRegressions, assertAcceptanceResults, validateScenarioCoverage } from './acceptance.ts';
import { regressionCheck, summarizeCheck, listTestsCheck, integrationTargetCheck, formatCheck, discoverTests, parseListedTests, cargoAdmissionBuild, cargoAdmissionDocs, parseCargoTestArtifacts, cargoAdmissionList, cargoAdmissionRun, artifactMatchesScenario, parseAdmissionTests, cargoAdmissionMetadata, assertAdmissionDocTargets } from './checks.ts';

export class RunFailure extends Error { outcome: Outcome; constructor(outcome: Outcome, message: string) { super(message); this.outcome = outcome; } }
// A Docker/harness fault (daemon, exec or container failure): retried without blaming the reproduction or the candidate.
class HarnessFailure extends Error {}
// A verification verdict about the candidate (a failing test or check): returned to the agent as repair feedback.
class VerdictFailure extends Error {
  category: VerificationVerdict; immutableOffenders: ImmutableOffender[];
  constructor(category: VerificationVerdict, message: string, immutableOffenders: ImmutableOffender[] = []) { super(message); this.category = category; this.immutableOffenders = immutableOffenders; }
}
const harnessError = /Cannot connect to the Docker daemon|Error response from daemon|OCI runtime (?:exec|create|start) failed/;
export interface RepairAgent { readonly turnPurpose?: AgentPhase | 'format'; toolToken: string; providerToken: string; preflight?(signal?: AbortSignal): Promise<void>; start(signal: AbortSignal): Promise<void>; ask(prompt: string, signal: AbortSignal, valid?: (answer: any) => boolean, phase?: AgentPhase): Promise<any>; stop(): Promise<void>; interrupt?(): Promise<void>; restart?(signal: AbortSignal): Promise<void>; touch?(): void; }
interface RecoveryDiagnosis {
  kind: 'tool-error' | 'check-result-loop'; tool: string; args: unknown; phase: AgentPhase; sourceHash: string; signature: string;
  error?: string; check?: { name: string; argv: string[]; status?: CheckResult['status']; exitCode: number; timedOut: boolean; outputHash: string; progressOutputHash?: string };
}
interface Context { run: Manifest; abort: AbortController; agent: RepairAgent; source: string; base: string; phase: AgentPhase; queue: Promise<unknown>; providerRejected?: string; providerFailure?: ProviderFailure; providerRecovery?: ProgressTracker; usableToolResults?: number; toolFailures?: ProgressTracker; checkProgress?: ProgressTracker; lastCheckSignature?: string; recoveryProgress?: ProgressTracker; recoveryReason?: RecoveryDiagnosis; checkedRevisions?: Map<string,string>; verificationProgress?: ProgressTracker; guardFailures?: Record<string, { category: VerificationVerdict; sourceHash: string; reason: string; immutableOffenders: ImmutableOffender[] }>; validProof?: { sourceHash: string; evidenceIds: number[] }; }
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
  private admission = new OperationAdmission(); private executions = new Map<string, Promise<Manifest>>();
  agentFactory: (run: Manifest) => RepairAgent;
  issueLoader: (run: Manifest, signal?: AbortSignal) => Promise<Issue>;
  publicationInspector = inspectPublication;
  competingLoader = (run: Manifest, signal?: AbortSignal) => fetchCompetingPullRequests(run, this.config, signal);
  constructor(config: Config, store = new Store(config.stateDir)) {
    this.config = config; this.store = store; this.docker = new Docker(config, store); this.repository = new Repository(config);
    this.agentFactory = run => new Agent(config, this.docker, store, run);
    this.issueLoader = (run, signal) => fetchGitHubIssue(run, this.config, signal);
  }
  async recover() {
    for (const run of await this.store.list()) if (run.stage !== 'complete') {
      await this.docker.stopOrphans(run).catch(() => {});
      run.outcome = run.verifiedCommit ? 'verified_unpublished' : 'interrupted'; run.error = 'Controller restarted. Evidence preserved; start a new repair or retry publication for a verified commit.';
      run.executionFinishedAt ||= new Date().toISOString(); if (run.stageTimes?.at(-1) && !run.stageTimes.at(-1)!.finishedAt) run.stageTimes.at(-1)!.finishedAt = run.executionFinishedAt;
      run.stage = 'complete'; await this.store.save(run); await writeReport(this.store, run);
      await this.store.event(run, 'controller', 'outcome', run.outcome);
    }
  }
  async start(input: RunInput) {
    if (this.active || this.admission.activeKey) throw new Error(`One active operation is supported; ${this.active || this.admission.activeKey} is still running`);
    this.active = 'starting';
    let run: Manifest; try { run = await this.store.create(validateInput(input, this.config.profile)); } catch (e) { this.active = undefined; throw e; }
    run.profile = structuredClone(this.config.profile); this.active = run.id;
    void this.execute(run).catch(error => { console.error(`Run ${run.id} could not finalize:`, error instanceof Error ? error.message : String(error)); }).finally(() => { this.active = undefined; }); return run;
  }
  execute(run: Manifest): Promise<Manifest> {
    const existing = this.executions.get(run.id); if (existing) return existing;
    const task = this.executeRun(run); this.executions.set(run.id, task);
    void task.finally(() => this.executions.delete(run.id)).catch(() => {}); return task;
  }
  private async executeRun(run: Manifest): Promise<Manifest> {
    run.profile ||= structuredClone(this.config.profile); const profile = run.profile;
    if (this.contexts.size) throw new Error('A run is already active');
    const abort = new AbortController();
    const source = path.join(this.store.dir(run.id), 'source'), base = path.join(this.store.dir(run.id), 'base');
    const agent = this.agentFactory(run); const context: Context = { run, abort, agent, source, base, phase: 'discovery', queue: Promise.resolve() };
    this.contexts.set(run.id, context);
    try {
      run.executionStartedAt ||= new Date().toISOString();
      await this.store.stage(run, 'preflight', 'Checking repository, issue and configuration');
      if (!/^[^/\s]+\/[^\s]+$/.test(this.config.model) || /REPLACE|YOUR_|placeholder/i.test(this.config.model)) throw new Error('Set BUGFIX_MODEL to your existing OpenCode provider/model ID');
      if (run.input.publish && (!this.config.fork || !this.config.gitName || !this.config.gitEmail || /YOUR_|Your Name|you@example/i.test(this.config.fork + this.config.gitName + this.config.gitEmail))) throw new Error('Publishing requires your configured fork, Git author name and email');
      await agent.preflight?.(abort.signal); this.ensureActive(context);
      if (run.input.publish) { await this.requirePublishSecret(abort.signal); this.ensureActive(context); await this.docker.imageId(this.config.publisherImage, abort.signal); }
      run.issue = await this.persist(context, 'Fetch the GitHub issue', () => this.issueLoader(run, abort.signal), e => e instanceof GitHubIssueError && !e.retryable || /pull request|open issue|HTTP 404|HTTP 410/.test(String(e)));
      if (run.input.mode === 'live') {
        run.competingPullRequests = await this.competingLoader(run, abort.signal); this.ensureActive(context);
        if (run.competingPullRequests.length) {
          await this.store.event(run, 'controller', 'competing_prs', 'Open PRs already reference this issue', {urls:run.competingPullRequests});
          if (!run.input.allowCompeting) throw new RunFailure('needs_attention', `Open PRs reference this issue: ${run.competingPullRequests.join(', ')}. Inspect them; start with --allow-competing to explicitly run an alternative.`);
        }
      }
      run.model = this.config.model;
      await atomicJson(path.join(this.store.dir(run.id), 'issue.json'), run.issue);
      run.agentImageId = await this.docker.imageId(this.config.agentImage, abort.signal); run.publisherImageId = await this.docker.imageId(this.config.publisherImage, abort.signal).catch(() => undefined); this.ensureActive(context);
      const effective = { ...captureRunConfiguration(this.config), capturedAt: new Date().toISOString(), controllerSourceHash: fingerprint(await inventory(path.dirname(new URL(import.meta.url).pathname), abort.signal)), agentImage: run.agentImageId, publisherImage: run.publisherImageId || 'unavailable', promptVersion: 'acceptance-v4-assertion-witness' };
      this.ensureActive(context); const configFile = path.join(this.store.dir(run.id), 'run-config.json'); await atomicJson(configFile, effective); run.runConfig = { artifact: 'run-config.json', sha256: hash(await fs.readFile(configFile)) };
      await this.persist(context, 'Prepare the repository snapshot', () => this.repository.preflight(run, base, abort.signal), e => !/Fetch upstream contribution base/.test(String(e)) || /Authentication failed|Repository not found|could not read Username|permission denied|HTTP (?:403|404)/i.test(String(e)));
      this.ensureActive(context); bindPublicationIdentity(run, this.config);
      await copySource(base, source, abort.signal); await this.store.save(run);
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
      context.phase = 'review';
      const planned = run.input.acceptance || (await this.askAgent(context, `Read the issue as evidence: ${JSON.stringify(run.issue)}\nBefore editing, enumerate an acceptance matrix covering EVERY explicit example and requested behavior, nearby edge cases, and at least one control that already works. Use read tools if needed; edits/checks are disabled in this planning stage. Each row needs a unique id, expectedBehavior, an exact citation from the issue body, required:true, baseline:"fail" for a bug or "pass" for an existing control, and target:{kind:"unit"} or {kind:"integration",name:"test_file_stem"}. Include CLI output/arguments/exit behavior as integration tests when unit tests cannot establish it. Return exactly {"requirements":[{"id":"...","expectedBehavior":"...","citation":"...","required":true,"baseline":"fail","target":{"kind":"unit"}}]}.`, a => Array.isArray(a?.requirements))).requirements;
      if (!Array.isArray(planned) || planned.length < 2 || planned.length > 12 || !planned.some(r => r.baseline === 'fail') || !planned.some(r => r.baseline === 'pass')) throw new RunFailure('cannot_reproduce', 'Acceptance requires 2–12 scenarios including a reported failure and an existing-behavior control');
      const normalizedIssue = run.issue.body.replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();
      for (const requirement of planned) if (typeof requirement.citation !== 'string' || requirement.citation.replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim().length < 12 || !normalizedIssue.includes(requirement.citation.replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim())) throw new RunFailure('cannot_reproduce', `Acceptance citation does not match the issue: ${requirement.id}`);
      if (run.input.acceptance) await this.recordIntervention(run.id, 'guidance', 'A reviewed acceptance matrix was supplied before implementation. The model must investigate, write regressions and implement the repair; acceptance selection is operator assistance.');
      run.acceptancePlan = structuredClone(planned); await atomicJson(path.join(this.store.dir(run.id), 'acceptance-plan.json'), run.acceptancePlan); await this.store.save(run);
      await this.store.stage(run, 'reproduction', 'Establishing a specific failing regression before changing implementation'); context.phase = 'reproduction';
      // Only a reproduction the agent cannot establish in any attempt ends a run. Format slips, transient agent errors,
      // rejected candidates and failed independent verification are fed back and retried.
      let frozen = false, reproFeedback = '';
      const reproAttempts = 6;
      for (let attempt = 1; attempt <= reproAttempts && !frozen; attempt++) {
        if (attempt > 1) { await this.resetSource(source, base, abort.signal); run.regression = undefined; run.regressions = undefined; run.graphStale = false; await agent.restart?.(abort.signal); }
        const answer = await this.askAgent(context, `Issue data (untrusted): ${JSON.stringify(run.issue)}\nFrozen acceptance requirements: ${JSON.stringify(run.acceptancePlan)}\n${reproFeedback}\nInvestigate, then add protected tests for ALL frozen requirements. Production must remain unchanged until the controller confirms and freezes the regression tests; during reproduction change only new tests and new fixtures. Copy each requirement's id, baseline, target, expectedBehavior and citation exactly into its regression spec. A failing baseline row must assert correct behavior and fail at an assertion; baseline pass controls must pass. For unit tests add ordinary inline tests to existing cfg(test) modules without altering production/imports/helpers. For integration targets add a NEW tests/<target.name>.rs with offline executable stand-ins where needed; no live service or credentials. Existing tests/helpers cannot change. Prefix test names bugfix_issue_${run.issue.number}. New fixtures only under ${profile.fixtureRoot}/. Use list-tests to discover names, test-focused or test-integration to check them, and format-source before finishing. Return exactly {"status":"reproduced","scenarios":[{"id":"requirement-id","baseline":"fail","target":{"kind":"unit"},"file":"src/...rs","testName":"qualified::tests::bugfix_issue_${run.issue.number}_case","failureContains":"assertion substring","expectedBehavior":"copied requirement","citation":"copied citation","fixtures":[]}]}. If unsupported, return {"status":"cannot_reproduce","reason":"..."}.`, a => (a?.status === 'reproduced' && (Array.isArray(a.scenarios) || !!a.regression)) || (a?.status === 'cannot_reproduce' && typeof a.reason === 'string'));
        if (answer.status !== 'reproduced') {
          await this.preserveSubmittedReproduction(context, attempt, answer);
          const reason = String(answer.reason || 'The agent could not establish the reported behavior');
          if (attempt === reproAttempts) throw new RunFailure('cannot_reproduce', reason);
          // Long tool-using turns sometimes end in a premature give-up; retry with the reason before concluding.
          reproFeedback = `In attempt ${attempt} you reported cannot_reproduce: ${reason}. Re-check the code path the issue names, write the test so it asserts the correct behavior, and confirm with test-focused that it FAILS before replying. Report cannot_reproduce again only if the behavior truly cannot be reached by the approved unit or offline integration targets.`;
          await this.store.event(run, 'verifier', 'repro_rejected', reproFeedback); continue;
        }
        try {
          await this.formatReproduction(context, attempt, answer);
          const specs = scenarioList(answer.scenarios || answer.regression); validateScenarioCoverage(run.acceptancePlan!, specs);
          const draft = await freezeRegressions(base, source, specs, profile);
          await this.admitReproduction(context, attempt, specs);
          await this.retryHarness(context, async () => {
            for (let repeat = 1; repeat <= 3; repeat++) {
              const results = [];
              for (const scenario of draft) {
                const spec = scenario.spec;
                const result = await this.check(context, run.workerContainer!, `repro-${attempt}-${repeat}-${spec.id}`, regressionCheck(spec, profile), [spec.id!]);
                if (spec.baseline !== 'pass' && (!spec.failureContains || !reproductionFailure(result.output, spec.testName, spec.failureContains))) {
                  const actual = failedAssertion(result.output, spec.testName);
                  if (!actual || repeat > 1) throw new Error(`Scenario ${spec.id} must fail deterministically at its intended assertion`);
                  spec.failureContains = actual; spec.failureAdopted = true;
                }
                results.push({ ...result, scenarioId: spec.id! });
              }
              assertAcceptanceResults(draft, results, 'baseline'); await assertFrozenRegressions(source, draft);
            }
          });
          context.phase = 'review'; await agent.restart?.(abort.signal);
          const boundary = await this.store.event(run, 'controller', 'coverage_review_started', 'Fresh acceptance review requires current assertion witnesses', { attempt, sourceHash: fingerprint(await inventory(source, abort.signal)) });
          const submittedReview = await this.askAgent(context, `Independently critique acceptance coverage before implementation. Issue: ${JSON.stringify(run.issue)}\nFrozen requirements: ${JSON.stringify(run.acceptancePlan)}\nTests: ${JSON.stringify(specs)}\nInspect the actual tests with read tools during THIS review; earlier source-read evidence is not eligible. Check every explicit issue example, CLI formatting/status when applicable, edge forms, and controls. Edits/checks are disabled. ${coverageReviewPromptSchema()}`, a => typeof a?.complete === 'boolean' && Array.isArray(a?.missing) && typeof a?.explanation === 'string');
          await this.preserveReproductionArtifact(context, attempt, 'submitted acceptance review', () => atomicJson(path.join(this.store.dir(run.id), `reproduction/attempt-${attempt}/acceptance-review-submitted.json`), submittedReview));
          const review = await validateCoverageReview(submittedReview, run.acceptancePlan!, draft, source, await this.store.events(run.id, boundary.seq), abort.signal);
          await this.preserveReproductionArtifact(context, attempt, 'validated acceptance review', async () => {
            await atomicJson(path.join(this.store.dir(run.id), `reproduction/attempt-${attempt}/acceptance-review.json`), review);
            await atomicJson(path.join(this.store.dir(run.id), 'acceptance-review.json'), review);
          });
          run.acceptanceReview = review;
          context.phase = 'reproduction'; if (!review.complete || review.missing.length) throw new Error(`Acceptance review found gaps: ${JSON.stringify(review)}`);
          await this.preserveReproductionArtifact(context, attempt, 'frozen regression snapshot and receipts', async () => {
            await fs.rm(path.join(this.store.dir(run.id), 'regression-source'), { recursive: true, force: true });
            await copySource(source, path.join(this.store.dir(run.id), 'regression-source'), abort.signal);
            await atomicJson(path.join(this.store.dir(run.id), 'reproduction/frozen.json'), draft);
            await fs.writeFile(path.join(this.store.dir(run.id), 'reproduction/regression.patch'), await this.repository.diff(run, source, abort.signal));
          });
          run.regressions = draft; run.regression = draft.find(r => r.spec.baseline !== 'pass') || draft[0];
          frozen = true;
        } catch (e) { if (abort.signal.aborted || e instanceof RunFailure) throw e; await atomicJson(path.join(this.store.dir(run.id), `reproduction/attempt-${attempt}/rejection.json`), { status: 'rejected', sourceHash: fingerprint(await inventory(source, abort.signal)), reason: e instanceof Error ? e.message : String(e), publicationEligible: false }); context.phase = 'reproduction'; reproFeedback = `The controller rejected reproduction attempt ${attempt}: ${String(e)}. Source is reset to the original snapshot for the next attempt.`; await this.store.event(run, 'verifier', 'repro_rejected', reproFeedback); }
      }
      if (!frozen || !run.regression) throw new RunFailure('cannot_reproduce', reproFeedback);
      await this.store.stage(run, 'patching', 'Regression frozen; trying a bounded minimal implementation change'); context.phase = 'patching';
      await agent.restart?.(abort.signal);
      // Patching continues round after round (a fresh agent session each round) until a candidate passes independent
      // verification or the run is cancelled.
      // A harness fault during verification re-runs verification (5 in a row is a real environment problem).
      let feedback = '', verified = '', n = 0, workerRunning = true, reverify = false, harnessFaults = 0;
      const frozenSource = path.join(this.store.dir(run.id), 'regression-source'); const progress = context.verificationProgress = new ProgressTracker();
      for (let round = 1; !verified; round++) {
        if (round > 1 && !reverify) {
          if (!workerRunning) { await this.restartWorker(context); workerRunning = true; }
          await this.persist(context, 'Restart OpenCode', () => agent.restart ? agent.restart(abort.signal) : Promise.resolve());
          await this.store.stage(run, 'patching', `Repairing again with a fresh agent session (round ${round})`); context.phase = 'patching';
        }
        let ready = reverify; reverify = false;
        if (!ready) for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
          n++; run.attempt = n; await this.store.save(run);
          const checkpoint = await this.repairCheckpoint(context);
          const answer = await this.askAgent(context, `The controller confirmed and froze ${run.regression.spec.testName}. Issue evidence: ${JSON.stringify(run.issue)}\nAcceptance checkpoint: ${JSON.stringify(run.acceptancePlan)}\nFrozen scenario tests: ${JSON.stringify((run.regressions || [run.regression]).map(r=>r.spec))}\nFix implementation only, preserving frozen test/fixtures, all existing tests, manifests and CI. Write the explanation as a concise technical root-cause, evidence and behavior summary for maintainers; omit references to models or automation. ${feedback}\nRepair checkpoint (current file changes, valid proof and unresolved guard failures): ${JSON.stringify(checkpoint)}\nUse replace_source/apply_patch and run_check as needed. After your final edit, re-read changed implementation and execute an exact frozen failing-baseline bug-scenario check; cite those current result evidence IDs. Module checks and whole-target checks are exploratory and cannot supply candidate proof, even when they pass.\nExact frozen bug-scenario run_check arguments: ${JSON.stringify(candidateEvidenceChecks((run.regressions || [run.regression]).map(r=>r.spec)))}\nExecute the applicable arguments above after your final edit. Do not cite stale, unrelated, zero-match or invented evidence. Return exactly {"explanation":"root cause, evidence, and resulting behavior","sourceReadEvidenceId":123,"bugCheckEvidenceId":456,"snapshots":[]}. Replace sourceReadEvidenceId 123 with the actual evidenceId from your current read_source result covering changed implementation lines. Replace bugCheckEvidenceId 456 with the actual evidenceId from your current passing exact frozen bug-scenario run_check result. These fields identify different tool roles: two run_check IDs cannot substitute for a source read. Emit JSON numbers, not quoted strings; do not include an evidenceIds array with the named fields. A justified snapshot update must list {"path":"...","owner":"changed source path","reason":"issue-grounded explanation"}; it will require human review. Stop honestly with {"cannot_fix":"reason"} if needed.`, a => typeof a?.explanation === 'string' || typeof a?.cannot_fix === 'string');
          if (answer.cannot_fix) {
            const preservedCandidate = await this.preserveRejectedCandidate(context, n, answer, new Error(`cannot_fix: ${String(answer.cannot_fix)}`));
            const repeated = progress.record(preservedCandidate.sourceHash, String(answer.cannot_fix));
            await this.repairCheckpoint(context);
            if (repeated) throw new RunFailure('needs_attention', `Three unchanged cannot_fix verdicts: ${String(answer.cannot_fix)}. Evidence is preserved for diagnosis at ${preservedCandidate.artifact}.`);
            feedback = `In attempt ${n} you reported cannot_fix: ${String(answer.cannot_fix)}. The frozen test defines the required behavior; make the smallest implementation change that makes it pass without breaking other tests.`;
            await this.store.event(run, 'verifier', 'candidate_rejected', feedback, { preservedCandidate }); await this.revertCandidate(context, frozenSource); continue;
          }
          try {
            const proof = normalizeCandidateEvidence(answer), { evidenceIds } = proof;
            const { sourceReadEvidenceId: _sourceRead, bugCheckEvidenceId: _bugCheck, ...candidate } = answer;
            run.candidate = { ...candidate, evidenceIds } as Candidate;
            if (proof.format === 'named' || proof.changedTypes) await this.store.event(run, 'controller', 'evidence_normalized', 'Explicit proof references normalized to numeric candidate event IDs', { format: proof.format, evidenceIds, ...(proof.format === 'named' ? { sourceReadEvidenceId: proof.sourceReadEvidenceId, bugCheckEvidenceId: proof.bugCheckEvidenceId } : {}) });
            const current = await inventory(source, abort.signal), original = await inventory(frozenSource, abort.signal);
            const revision = fingerprint(current); run.candidate.candidateRevision = revision;
            const changedSource: Record<string,[number,number][]> = {};
            for (const file of changedFiles(original, current).filter(file => profile.sourceRoots.some(root => file.startsWith(root + '/')))) {
              const diff = await this.repository.git(run.worktree!, ['diff','--no-index','--no-ext-diff','--no-textconv','--unified=0','--',original[file] ? path.join(frozenSource,file) : '/dev/null',current[file] ? path.join(source,file) : '/dev/null'], undefined, abort.signal);
              if (diff.code > 1 || diff.timedOut) throw new Error(`Could not establish evidence ranges for ${file}`);
              changedSource[file] = [...diff.stdout.matchAll(/^@@ .*?\+(\d+)(?:,(\d+))? @@/gm)].map(match=>[Math.max(1,Number(match[1])),Math.max(1,Number(match[1]))+Math.max(1,Number(match[2]??1))-1]);
            }
            validateEvidence(answer, await this.store.events(run.id), Object.fromEntries(Object.entries(current).map(([file, value]) => [file, value.split(':').slice(1).join(':')])), changedSource, revision, (run.regressions || [run.regression]).filter(r=>r.spec.baseline!=='pass').map(r => r.spec.id || 'regression-1'));
            await assertCandidate(base, source, run.regressions || run.regression, run.candidate, profile);
            context.validProof = { sourceHash: revision, evidenceIds };
            await this.retryHarness(context, async () => { for (const name of profile.fastCheckIds) {
              const argv = profile.checks[name];
              const check = await this.check(context, run.workerContainer!, `attempt-${n}-${name}`, argv);
              if (check.exitCode || check.timedOut || check.status === 'no_match') throw new VerdictFailure({ kind: 'profile-check', checkId: name }, `${name} failed; see event/log evidence ${check.log}\n${check.output.slice(-12000)}`);
            }
              await this.acceptanceChecks(context, run.workerContainer!, `attempt-${n}`, 'candidate');
            });
            await assertCandidate(base, source, run.regressions || run.regression, run.candidate, profile);
            await fs.mkdir(path.join(this.store.dir(run.id), 'candidates', String(n)), { recursive: true });
            await fs.writeFile(path.join(this.store.dir(run.id), 'candidates', String(n), 'candidate.patch'), await this.repository.diff(run, source, abort.signal));
            ready = true; break;
          } catch (e) {
            if (abort.signal.aborted || e instanceof RunFailure) throw e;
            const preservedCandidate = await this.preserveRejectedCandidate(context, n, answer, e);
            if (e instanceof VerdictFailure) (context.guardFailures ||= {})[e.category.kind === 'profile-check' ? e.category.checkId : e.category.kind] = { category: e.category, sourceHash: preservedCandidate.sourceHash, reason: e.message.slice(-4000), immutableOffenders: e.immutableOffenders };
            const repeated = progress.record(preservedCandidate.sourceHash, String(e));
            await this.repairCheckpoint(context);
            if (repeated) throw new RunFailure('needs_attention', `Three unchanged rejected candidates: ${String(e)}. Evidence is preserved for diagnosis at ${preservedCandidate.artifact}.`);
            // A rejected candidate is rolled back to the frozen reproduction so the next attempt starts clean.
            feedback = `Attempt ${n} rejected: ${String(e)}. Your edits were rolled back to the frozen reproduction state.`; await this.store.event(run, 'verifier', 'candidate_rejected', feedback, { preservedCandidate }); await this.revertCandidate(context, frozenSource);
          }
        }
        if (!ready) continue;
        context.phase = 'locked'; await this.docker.remove(run.workerContainer!); workerRunning = false;
        await this.store.stage(run, 'verification', 'Verifying baseline failure and candidate success in independent containers');
        const target = path.join(this.store.dir(run.id), 'verified-source'); const started: string[] = [];
        try {
          await assertCandidate(base, source, run.regressions || run.regression, run.candidate!, profile);
          await fs.rm(target, { recursive: true, force: true }); await copySource(source, target, abort.signal);
          const contentHash = fingerprint(await inventory(target, abort.signal)); run.verifiedTree = await this.repository.tree(run, target, abort.signal);
          const harness = async <T>(step: Promise<T>) => { try { return await step; } catch (e) { throw e instanceof HarnessFailure ? e : new HarnessFailure(String(e instanceof Error ? e.message : e)); } };
          const baseline = await harness(this.docker.startWorker(run, frozenSource, run.image!, true, `repro-verifier-${round}`, abort.signal)); started.push(baseline);
          await harness(this.docker.inContainer(run, baseline, ['python3', '/opt/bugfix/prepare.py', 'invalidate-workspace'], abort.signal).then(r => checked(r, 'Invalidate cached workspace outputs')));
          await this.acceptanceChecks(context, baseline, `independent-baseline-regression-${round}`, 'baseline', frozenSource).catch(e => { throw new HarnessFailure(String(e)); });
          const verifier = await harness(this.docker.startWorker(run, target, run.image!, true, `verifier-${round}`, abort.signal)); started.push(verifier);
          await harness(this.docker.inContainer(run, verifier, ['python3', '/opt/bugfix/prepare.py', 'invalidate-workspace'], abort.signal).then(r => checked(r, 'Force rebuild of workspace code/tests')));
          await this.acceptanceChecks(context, verifier, `final-regression-${round}`, 'candidate', target).catch(e => { throw new VerdictFailure({ kind: 'acceptance' }, String(e)); });
          if (context.guardFailures) delete context.guardFailures.acceptance;
          for (const [name, argv] of Object.entries(profile.checks)) {
            const result = await this.check(context, verifier, `final-${name}-${round}`, argv);
            if (result.exitCode || result.timedOut || result.status === 'no_match') throw new VerdictFailure({ kind: 'profile-check', checkId: name }, `Final ${name} failed\n${result.output.slice(-12000)}`, await this.immutableOffenders(context, name, result.output, target));
            progress.resolveCheck(name); if (context.guardFailures) delete context.guardFailures[name];
          }
          await assertFrozenRegressions(target, run.regressions || [run.regression]).catch(e => { throw new VerdictFailure({ kind: 'frozen-regression' }, String(e instanceof Error ? e.message : e)); });
          if (fingerprint(await inventory(target, abort.signal)) !== contentHash || await this.repository.tree(run, target, abort.signal) !== run.verifiedTree) throw new Error('Verified source changed during execution');
          verified = target;
        } catch (e) {
          if (abort.signal.aborted) throw e;
          const message = String(e instanceof Error ? e.message : e);
          if (e instanceof VerdictFailure) {
            harnessFaults = 0;
            const sourceHash = fingerprint(await inventory(target, abort.signal));
            const preservedCandidate = await this.preserveRejectedCandidate(context, n, run.candidate, e);
            (context.guardFailures ||= {})[e.category.kind === 'profile-check' ? e.category.checkId : e.category.kind] = { category: e.category, sourceHash, reason: message.slice(-4000), immutableOffenders: e.immutableOffenders };
            const repeatedOffenders = e.immutableOffenders.filter(offender => progress.record(sourceHash, offender));
            const repeated = progress.record(sourceHash, e.category);
            await this.repairCheckpoint(context);
            feedback = `Independent verification of your change failed: ${message}. Fix the implementation so this passes while the frozen test keeps passing.`;
            await this.store.event(run, 'verifier', 'verification_rejected', feedback.slice(0, 20000), { sourceHash, category: e.category, immutableOffenders: e.immutableOffenders, preservedCandidate });
            if (repeatedOffenders.length) throw new RunFailure('needs_attention', `Repeated repository invariant ${repeatedOffenders[0].invariant} in ${repeatedOffenders[0].checkId} identifies unchanged frozen bytes in ${repeatedOffenders[0].path} (${repeatedOffenders[0].frozenHash}). Production changes cannot repair this frozen reproduction. Candidate and verification evidence are preserved at ${preservedCandidate.artifact}; revise reproduction admission before retrying. Frozen bytes remain protected.`);
            if (repeated) throw new RunFailure('needs_attention', `Three unchanged independent verification verdicts (${e.category.kind}${e.category.kind === 'profile-check' ? `: ${e.category.checkId}` : ''}): ${message}. Evidence is preserved for diagnosis.`);
          } else {
            if (++harnessFaults >= 5) throw new RunFailure('environment_blocked', `Independent verification could not run 5 times in a row: ${message}`);
            reverify = true; await this.store.event(run, 'verifier', 'verification_retry', `Verification harness fault (${message.slice(0, 500)}); re-running verification`);
            await timers.setTimeout(15_000, undefined, { signal: abort.signal });
          }
        } finally { for (const name of started) await this.docker.remove(name).catch(() => {}); }
      }
      await fs.writeFile(path.join(this.store.dir(run.id), 'candidate.patch'), await this.repository.diff(run, verified, abort.signal));
      run.outcome = 'verified_patch'; await this.store.save(run); await writeReport(this.store, run);
      if (this.config.gitName && this.config.gitEmail) { await this.repository.commit(run, verified, path.join(this.store.dir(run.id), 'verified.bundle'), abort.signal); await this.store.save(run); }
      // Publication is idempotent (the publisher reconciles an existing PR first), so transient failures are retried.
      if (run.input.publish) for (let attempt = 1; attempt <= 5; attempt++) { await this.publish(run, abort.signal); if ((run.outcome as string) === 'draft_created' || abort.signal.aborted) break; if (attempt < 5) await timers.setTimeout(Math.min(300, 30 * 2 ** (attempt - 1)) * 1000, undefined, { signal: abort.signal }); }
    } catch (error) {
      if (abort.signal.aborted) { const reason = abort.signal.reason; run.outcome = reason instanceof RunFailure ? reason.outcome : 'cancelled'; }
      else if (error instanceof RunFailure) run.outcome = error.outcome;
      else run.outcome = ['verified_patch', 'verified_unpublished', 'draft_created'].includes(run.outcome || '') ? 'verified_unpublished' : run.stage === 'verification' || run.stage === 'patching' ? 'verification_failed' : 'environment_blocked';
      run.error = String(error instanceof Error ? error.message : error);
      run.failureStage = run.stage;
      await this.store.event(run, 'controller', 'error', run.error);
    } finally {
      try {
        context.phase = 'locked'; await agent.stop().catch(() => {}); await this.docker.cleanup(run);
        run.executionFinishedAt ||= new Date().toISOString(); if (run.stageTimes?.at(-1) && !run.stageTimes.at(-1)!.finishedAt) run.stageTimes.at(-1)!.finishedAt = run.executionFinishedAt;
        run.stage = 'complete'; await this.store.save(run); await writeReport(this.store, run);
        await this.store.event(run, 'controller', 'outcome', run.outcome || 'interrupted');
      } finally { this.contexts.delete(run.id); }
    }
    return run;
  }
  private async repairCheckpoint(context: Context) {
    const current = await inventory(context.source, context.abort.signal), baseline = await inventory(context.base, context.abort.signal), sourceHash = fingerprint(current);
    const checkpoint = { schemaVersion: 1, sourceHash, changedFiles: changedFiles(baseline, current), verificationProgress: context.verificationProgress?.snapshot(), unresolvedGuards: context.guardFailures || {}, validProof: context.validProof?.sourceHash === sourceHash ? context.validProof : null, frozenScenarios: (context.run.regressions || []).map(regression => ({ id: regression.spec.id, file: regression.spec.file, functionHash: regression.functionHash, wholeFileHash: regression.wholeFileHash })), publicationEligible: false };
    await atomicJson(path.join(this.store.dir(context.run.id), 'repair-checkpoint.json'), checkpoint); return checkpoint;
  }
  private async immutableOffenders(context: Context, checkId: string, output: string, root: string): Promise<ImmutableOffender[]> {
    const frozen = context.run.regressions || [], offenders: ImmutableOffender[] = [];
    // This hard stop recognizes only RTK's audited source-only binary-isolation scanner. A generic
    // production assertion can print a frozen fixture path while remaining repairable in production.
    const markers = new Set(['CARGO_BIN_EXE_rtk', 'Command::new("rtk")', 'join("debug")', '"target/debug']);
    for (const match of output.matchAll(/^---- ([^\n]+) stdout ----\r?\n([\s\S]*?)(?=^---- |^failures:|^test result:|(?![\s\S]))/gm)) {
      const invariant = match[1], block = match[2];
      if ((context.run.profile || this.config.profile).upstream !== 'rtk-ai/rtk' || invariant !== 'core::test_isolation::tests_that_spawn_rtk_isolate_their_data' || !block.includes('these files name the rtk binary themselves') || !block.includes('common::rtk_command()')) continue;
      if (!output.includes(`test ${invariant} ... FAILED`) || frozen.some(regression => regression.spec.testName === invariant)) continue;
      const origin = /panicked at ([A-Za-z0-9_./-]+\.rs):\d+:\d+:/.exec(block)?.[1]; if (origin !== 'src/core/test_isolation/mod.rs') continue;
      let baseline: string; try { baseline = await fs.readFile(await sourcePath(context.base, origin), 'utf8'); } catch { continue; }
      if (!rustTests(baseline).some(test => invariant === test.qualified || invariant.endsWith(`::${test.qualified}`))) continue;
      for (const row of block.matchAll(/^ {2,}([A-Za-z0-9_./-]+): ([^\r\n]+)$/gm)) {
        const relative = row[1], marker = row[2].trim(), related = frozen.filter(regression => regression.spec.file === relative || relative in regression.fixtureHashes);
        if (!related.length || !markers.has(marker)) continue;
        try { safeRelative(relative); await assertFrozenRegressions(root, related); } catch { continue; }
        const bytes = await fs.readFile(await sourcePath(root, relative), 'utf8');
        const immutable = related[0];
        // For inline regressions, prove the reported marker occurs in the frozen test itself, rather than in
        // adjacent production code that the agent can legitimately repair.
        const markerInFrozen = immutable.wholeFileHash || immutable.fixtureHashes[relative]
          ? bytes.includes(marker) : rustTests(bytes).some(test => related.some(regression => test.canonical && test.canonical.includes(marker) && regression.functionHash === hash(test.canonical)));
        if (!markerInFrozen) continue;
        const frozenHash = immutable.fixtureHashes[relative] || immutable.wholeFileHash || immutable.functionHash;
        const offender: ImmutableOffender = { kind: 'immutable-offender', checkId, invariant, path: relative, frozenHash };
        if (!offenders.some(value => JSON.stringify(value) === JSON.stringify(offender))) offenders.push(offender);
      }
    }
    return offenders;
  }
  private async admitReproduction(context: Context, attempt: number, specs: Regression[]) {
    const { run, source, abort } = context, profile = run.profile || this.config.profile;
    const dir = path.join(this.store.dir(run.id), `reproduction/attempt-${attempt}`), sourceHash = fingerprint(await inventory(source, abort.signal));
    const checks: unknown[] = [], excluded: unknown[] = [];
    let status = 'rejected', reason = '';
    try {
      const perform = async (id: string, argv: string[], discovery = false, expectedCount?: number) => {
        const result = await this.check(context, run.workerContainer!, `repro-${attempt}-admission-${id}`, argv);
        checks.push({ id: result.id, argv, log: result.log, status: result.status, sourceHash: result.sourceHash });
        if (result.sourceHash !== sourceHash || result.exitCode || result.timedOut || !discovery && result.status === 'no_match') throw new Error(`Reproduction admission ${id} failed; see ${result.log}\n${result.output.slice(-12000)}`);
        if (expectedCount !== undefined) {
          const matched = [...result.output.matchAll(/test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured;/g)].reduce((sum, match) => sum + match.slice(1).reduce((n, value) => n + Number(value), 0), 0);
          if (matched !== expectedCount) throw new Error(`Reproduction admission ${id} ran ${matched} tests but selected ${expectedCount}; no-match or incomplete execution cannot admit reproduction`);
        }
        return result;
      };
      await this.retryHarness(context, async () => {
        for (const [id, argv] of Object.entries(profile.checks)) {
          if (argv[0] !== 'cargo' || argv[1] !== 'test') { await perform(id, argv); continue; }
          if (argv.includes('--doc')) { await perform(id, argv, true); continue; }
          const built = await perform(`${id}-build`, cargoAdmissionBuild(argv), true);
          const targets = parseCargoTestArtifacts(built.output); let listedCount = 0;
          const metadata = cargoAdmissionMetadata(argv); if (metadata) assertAdmissionDocTargets((await perform(`${id}-metadata`, metadata, true)).output, targets);
          for (const [index, target] of targets.entries()) {
            const listing = await perform(`${id}-${index}-list`, cargoAdmissionList(argv, target), true);
            const names = parseAdmissionTests(listing.output);
            const failures = specs.filter(spec => spec.baseline === 'fail' && artifactMatchesScenario(target, spec, profile));
            for (const scenario of specs.filter(spec => artifactMatchesScenario(target, spec, profile))) {
              if (!names.includes(scenario.testName)) throw new Error(`Reproduction admission ${id} did not discover declared scenario ${scenario.id} in its canonical Cargo target`);
            }
            const omit = new Set(failures.map(spec => spec.testName)), allowed = names.filter(name => !omit.has(name));
            excluded.push(...failures.map(spec => ({ checkId: id, target, scenarioId: spec.id, testName: spec.testName })));
            listedCount += allowed.length;
            // Chunk only to respect operating-system argv size; this is not a tool or work budget.
            for (let start = 0; start < allowed.length; start += 512) {
              const batch = allowed.slice(start, start + 512);
              await perform(`${id}-${index}-tests-${start / 512}`, cargoAdmissionRun(argv, target, batch), false, batch.length);
            }
          }
          if (!listedCount) throw new Error(`Reproduction admission ${id} discovered no runnable existing tests or controls`);
          // Explicit target selectors may intentionally omit acceptance targets; their exact baseline checks still run below.
          for (const [index, target] of targets.entries()) { const docs = cargoAdmissionDocs(argv, target); if (docs) await perform(`${id}-${index}-docs`, docs, true); }
        }
      });
      if (fingerprint(await inventory(source, abort.signal)) !== sourceHash) throw new Error('Reproduction source changed during admission');
      status = 'admitted';
    } catch (error) { reason = error instanceof Error ? error.message : String(error); throw error; }
    finally {
      await atomicJson(path.join(dir, 'admission.json'), { schemaVersion: 1, status, sourceHash, checks, excluded, reason, publicationEligible: false });
      await this.store.event(run, 'verifier', status === 'admitted' ? 'reproduction_admitted' : 'reproduction_admission_rejected', status === 'admitted' ? 'Existing repository checks and controls passed before regression freeze' : reason.slice(0, 20000), { artifact: `reproduction/attempt-${attempt}/admission.json`, sourceHash });
    }
  }
  private async acceptanceChecks(context: Context, container: string, prefix: string, stage: 'baseline' | 'candidate', root = context.source) {
    const scenarios = context.run.regressions || [context.run.regression!]; const results = [];
    for (const scenario of scenarios) {
      const result = await this.check(context, container, `${prefix}-${scenario.spec.id || 'regression-1'}`, regressionCheck(scenario.spec, context.run.profile || this.config.profile), [scenario.spec.id || 'regression-1'], root);
      results.push({ ...result, scenarioId: scenario.spec.id || 'regression-1' });
    }
    assertAcceptanceResults(scenarios, results, stage); return results;
  }
  async check(context: Context, container: string, id: string, argv: string[], scenarioIds: string[] = [], root = context.source) {
    const { run } = context; this.ensureActive(context); context.agent.touch?.();
    const revision = fingerprint(await inventory(root, context.abort.signal));
    context.checkedRevisions ||= new Map();
    if (argv[0] === 'cargo' && argv[1] !== 'fmt' && context.checkedRevisions.get(container) !== revision) {
      checked(await this.docker.inContainer(run, container, ['python3', '/opt/bugfix/prepare.py', 'invalidate-workspace'], context.abort.signal), 'Invalidate workspace outputs after source revision change');
      context.checkedRevisions.set(container, revision);
      await this.store.event(run, 'cache', 'workspace_invalidated', 'Rebuilding workspace outputs for current source revision', {container,sourceHash:revision});
    }
    const started = await this.store.event(run, 'check', 'started', argv.join(' '), { id });
    const result = await this.docker.inContainer(run, container, argv, context.abort.signal);
    if (result.code && !context.abort.signal.aborted && harnessError.test(result.stderr)) throw new HarnessFailure(`Docker could not run ${id}: ${result.stderr.slice(0, 500)}`);
    let relative = `${run.stage === 'verification' ? 'verification' : run.stage === 'reproduction' ? 'reproduction' : `candidates/${run.attempt}`}/${id}.log`;
    await fs.mkdir(path.dirname(path.join(this.store.dir(run.id), relative)), { recursive: true });
    const output = result.stdout + result.stderr;
    try { await fs.writeFile(path.join(this.store.dir(run.id), relative), output, { flag: 'wx' }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      relative = relative.replace(/\.log$/, `-event-${started.seq}.log`);
      await fs.writeFile(path.join(this.store.dir(run.id), relative), output, { flag: 'wx' });
    }
    const check: CheckResult = { id, argv, exitCode: result.code, durationMs: result.durationMs, log: relative, timedOut: result.timedOut, ...summarizeCheck(output, result.code, result.timedOut, argv), scenarioIds, sourceHash: revision, candidateRevision: revision, stage: run.stage, attempt: run.attempt };
    run.checks.push(check); await this.store.save(run); await this.store.event(run, 'check', 'finished', `${id}: exit ${result.code}`, check);
    return { ...check, output };
  }
  // Retries an infrastructure step (network, Docker, OpenCode start) with capped backoff until it succeeds or the run is
  // cancelled; `permanent` marks answers no retry can change (a closed issue, a dirty checkout).
  private async persist<T>(context: Context, label: string, step: () => Promise<T>, permanent: (e: unknown) => boolean = () => false): Promise<T> {
    for (let failure = 1; ; failure++) {
      this.ensureActive(context);
      try { const value = await step(); this.ensureActive(context); return value; } catch (e) {
        if (context.abort.signal.aborted || e instanceof RunFailure || permanent(e)) throw e;
        const wait = e instanceof GitHubIssueError && e.retryAt ? Math.max(1, Math.ceil((e.retryAt - Date.now()) / 1000)) : Math.min(120, 5 * 2 ** Math.min(failure - 1, 5));
        await this.store.event(context.run, 'controller', 'infra_retry', `${label} failed (${String(e instanceof Error ? e.message : e).slice(0, 300)}); retrying in ${wait}s`);
        await timers.setTimeout(wait * 1000, undefined, { signal: context.abort.signal });
      }
    }
  }
  // (Re)starts the editable repository container, replacing a dead or leftover one.
  private async restartWorker(context: Context) {
    const { run } = context;
    run.workerContainer = await this.persist(context, 'Start the repository container', async () => { await this.docker.remove(`bugfix-${run.id}-worker`); this.ensureActive(context); return this.docker.startWorker(run, context.source, undefined, true, 'worker', context.abort.signal); });
  }
  // Runs checks; a Docker/harness fault restarts the worker and re-runs them instead of rejecting the work under test.
  private async retryHarness(context: Context, checks: () => Promise<void>) {
    for (let fault = 1; ; fault++) {
      try { return await checks(); } catch (e) {
        if (!(e instanceof HarnessFailure) || context.abort.signal.aborted) throw e;
        if (fault >= 5) throw new RunFailure('environment_blocked', `Docker could not run checks 5 times in a row: ${e.message}`);
        await this.store.event(context.run, 'controller', 'infra_retry', `${e.message.slice(0, 300)}; restarting the repository container`);
        await timers.setTimeout(10_000 * fault, undefined, { signal: context.abort.signal }); await this.restartWorker(context);
      }
    }
  }
  private async preserveRejectedCandidate(context: Context, attempt: number, answer: unknown, error: unknown) {
    const { run, source, abort } = context;
    const artifact = safeRelative(`candidates/${attempt}/rejected`), dir = path.join(this.store.dir(run.id), artifact);
    try {
      this.ensureActive(context);
      const submitted = structuredClone(answer) as { evidenceIds?: unknown; sourceReadEvidenceId?: unknown; bugCheckEvidenceId?: unknown };
      const before = await inventory(source, abort.signal), sourceHash = fingerprint(before);
      const throughSeq = (await this.store.eventPage(run.id, { limit: 1 })).latestSeq;
      await fs.mkdir(path.dirname(dir), { recursive: true });
      await fs.mkdir(dir, { mode: 0o700 }); // Exclusive reservation: an older snapshot is never replaced.
      await copySource(source, path.join(dir, 'source'), abort.signal);
      if (fingerprint(await inventory(path.join(dir, 'source'), abort.signal)) !== sourceHash || fingerprint(await inventory(source, abort.signal)) !== sourceHash) throw new Error('Source changed or snapshot copy differs from the rejected submission');
      await atomicJson(path.join(dir, 'inventory.json'), before);
      await atomicJson(path.join(dir, 'submitted-answer.json'), submitted);
      await atomicJson(path.join(dir, 'rejection.json'), {
        state: 'complete', schemaVersion: 1, runId: run.id, attempt, stage: run.stage, capturedAt: new Date().toISOString(), sourceHash,
        source: 'source', inventory: 'inventory.json', submittedAnswer: 'submitted-answer.json', publicationEligible: false,
        rejection: { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) },
        eventRefs: { throughSeq, submittedEvidenceIds: submitted?.evidenceIds ?? null, submittedSourceReadEvidenceId: submitted?.sourceReadEvidenceId ?? null, submittedBugCheckEvidenceId: submitted?.bugCheckEvidenceId ?? null },
      });
      const event = await this.store.event(run, 'verifier', 'candidate_preserved', `Rejected candidate ${attempt} preserved before rollback or stop`, { artifact, sourceHash, throughSeq });
      return { artifact, sourceHash, eventSeq: event.seq };
    } catch (failure) {
      if (abort.signal.aborted) throw failure;
      throw new RunFailure('needs_attention', `Unable to preserve rejected candidate ${attempt} at ${artifact}: ${failure instanceof Error ? failure.message : String(failure)}. Submitted source has not been reset; partial artifacts are retained.`);
    }
  }
  private async revertCandidate(context: Context, frozenSource: string) { await this.resetSource(context.source, frozenSource, context.abort.signal); await this.repository.mirror(context.run, context.source, context.abort.signal); }
  // Productive work has no total turn budget. Repeated provider failures without usable output stop separately
  // from repository diagnoses; restarting OpenCode cannot repair provider credentials or a failed generation stream.
  private async askAgent(context: Context, prompt: string, valid: (answer: any) => boolean): Promise<any> {
    for (let failure = 1; ; failure++) {
      try {
        const answer = await context.agent.ask(prompt, context.abort.signal, valid, context.phase);
        // A valid phase answer proceeds to controller validation, even if a diagnosis was just scheduled.
        // Clearing the pending diagnosis also prevents its deferred interrupt from affecting the next phase.
        context.recoveryReason = undefined; context.toolFailures = undefined; context.checkProgress = undefined; context.recoveryProgress = undefined; context.providerRecovery = undefined;
        return answer;
      } catch (e) {
        if (context.abort.signal.aborted) throw e;
        if (e instanceof RunFailure) throw e;
        if (context.providerRejected) throw new RunFailure('environment_blocked', `The model provider rejected the request (${context.providerRejected}): check .secrets/nvidia_api_key and BUGFIX_MODEL`);
        const providerFailure = context.providerFailure, fallback = agentProviderFailure(e);
        if (providerFailure || fallback) {
          const sourceHash = fingerprint(await inventory(context.source, context.abort.signal));
          const signature = providerFailure ? JSON.stringify([providerFailure.kind, providerFailure.code, providerFailure.type]) : fallback!.signature;
          const repeated = (context.providerRecovery ||= new ProgressTracker()).record(sourceHash, { kind: 'agent-recovery', phase: context.phase, signature: JSON.stringify([signature, context.usableToolResults || 0]) });
          const partial = providerFailure?.meaningfulOutput === true;
          const stalled = partial || providerFailure?.circuitOpen === true || providerFailure?.retryable === false || repeated;
          await this.store.event(context.run, 'controller', 'provider_checkpoint', 'Checking provider recovery before another agent turn', { phase: context.phase, sourceHash, stalled, ...(providerFailure ? providerFailure : { kind: 'provider_error', message: fallback!.message }), usableToolResults: context.usableToolResults || 0 });
          if (stalled) throw new RunFailure(partial ? 'needs_attention' : 'environment_blocked', partial
            ? 'The model stream failed after delivering partial output. Evidence and repository work are preserved; inspect the provider checkpoint before starting another turn.'
            : `The model provider cannot complete a generation${providerFailure ? ` (${providerFailure.kind}; ${providerFailure.consecutiveFailures} consecutive failures)` : ' after 3 unchanged failures without usable tool progress'}. Evidence and repository work are preserved; check the provider checkpoint before retrying.`);
        }
        const diagnosis = context.recoveryReason; context.recoveryReason = undefined;
        if (diagnosis) {
          const sourceHash = fingerprint(await inventory(context.source, context.abort.signal));
          const stalled = (context.recoveryProgress ||= new ProgressTracker()).record(sourceHash, { kind: 'agent-recovery', phase: context.phase, signature: JSON.stringify([diagnosis.kind, diagnosis.signature]) });
          const repair = context.verificationProgress ? await this.repairCheckpoint(context) : undefined;
          await this.store.event(context.run, 'controller', 'recovery_checkpoint', 'Checking progress across agent recovery', { ...diagnosis, phase: context.phase, sourceHash, stalled, ...(repair ? { repair } : {}) });
          if (stalled) throw new RunFailure('needs_attention', `3 identical unchanged agent recovery checkpoints in ${context.phase}: ${diagnosis.kind} for ${diagnosis.tool}; source ${sourceHash}. Inspect diagnosis and tool evidence before retrying.`);
          prompt += `\nRecovery checkpoint: ${JSON.stringify(diagnosis)}. ${repair ? `Current repair checkpoint: ${JSON.stringify(repair)}.` : ''} Re-read current source and use a smaller valid operation. Do not repeat the unchanged operation.`;
          context.toolFailures = undefined; context.checkProgress = undefined;
        }
        const message = String(e instanceof Error ? e.message : e).slice(0, 300), wait = Math.min(60, 5 * failure);
        await this.store.event(context.run, 'controller', 'agent_retry', `Agent turn failed (${message}); retrying in ${wait}s`);
        if ((diagnosis || failure % 3 === 0) && context.agent.restart) await context.agent.restart(context.abort.signal).catch(error => this.store.event(context.run, 'controller', 'agent_retry', `OpenCode restart failed: ${String(error).slice(0, 300)}`));
        else await context.agent.interrupt?.();
        await timers.setTimeout(wait * 1000, undefined, { signal: context.abort.signal });
      }
    }
  }
  private async diagnose(context: Context, diagnosis: RecoveryDiagnosis) {
    if (context.recoveryReason) return;
    context.recoveryReason = diagnosis;
    await this.store.event(context.run, 'controller', 'diagnosis', `${diagnosis.kind}: repeated ${diagnosis.tool} on unchanged source`, diagnosis);
    setTimeout(() => {
      if (context.recoveryReason === diagnosis && !context.abort.signal.aborted && context.phase !== 'locked') void context.agent.interrupt?.();
    }, 0);
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
    const requestedArgs = structuredClone(args);
    const called = await this.store.event(run, 'tool', 'called', name, { tool: name, args }); let result: unknown, diagnosis: RecoveryDiagnosis | undefined;
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
        result = { path: args.path, start, end, contentHash: hash(lines.join('\n')), sourceHash: fingerprint(await inventory(source)), totalLines: lines.length, text: lines.slice(start - 1, end).map((s, i) => `${start + i}: ${s}`).join('\n') };
      } else if (name === 'search_text') {
        if (typeof args.reason !== 'string' || args.reason.length < 8 || typeof args.pattern !== 'string' || args.pattern.length > 300) throw new Error('Scoped search needs a pattern and substantive fallback reason');
        const relative = args.path === '.' ? '.' : safeRelative(args.path); if (relative !== '.') await sourcePath(source, relative);
        const argv = args.pattern ? ['rg', '--fixed-strings', '--line-number', '--max-count', '30', '--', args.pattern, relative] : ['rg', '--files', '--', relative];
        let search = await this.docker.inContainer(run, run.workerContainer!, argv, context.abort.signal);
        if (search.code === 126 || search.code === 127) search = await this.docker.inContainer(run, run.workerContainer!, ['grep', '-RFn', '--', args.pattern, relative], context.abort.signal);
        result = { output: (search.stdout + search.stderr).slice(0, 18000), exitCode: search.code, fallbackReason: args.reason };
      } else if (name === 'apply_patch' || name === 'replace_source') {
        if (!['reproduction', 'patching'].includes(context.phase)) throw new Error('Edits are unavailable in this stage');
        const backups = new Map<string, Buffer | null>();
        if (name === 'replace_source') args = { edits: [args] };
        // Some models send the edits array JSON-encoded as a string; accept both shapes.
        if (typeof args.edits === 'string') { try { args.edits = JSON.parse(args.edits); } catch (e) { throw new Error(`Invalid edits JSON: ${String(e)}. Use structured edits:[{path:"src/file.rs",before:"exact old text",after:"new text"}] or replace_source for one edit; do not JSON-encode the array.`); } }
        if (!Array.isArray(args.edits)) throw new Error('edits must be an array of {path, before, after} objects');
        for (const edit of args.edits) {
          if (!edit || typeof edit.path !== 'string' || typeof edit.before !== 'string' || typeof edit.after !== 'string') throw new Error('Each edit needs string path, before and after fields');
          const file = await sourcePath(source, edit.path, true);
          if (!backups.has(edit.path)) backups.set(edit.path, await fs.readFile(file).catch(e => { if (e.code === 'ENOENT') return null; throw e; }));
          if (edit.contentHash && hash(backups.get(edit.path)?.toString('utf8') || '') !== edit.contentHash) throw new Error(`Source revision changed: re-read ${edit.path} before editing`);
        }
        try {
          const profile = run.profile || this.config.profile;
          await applyEdits(source, args.edits, [...profile.sourceRoots, ...profile.testRoots]);
          if (context.phase === 'reproduction') await assertReproductionEdits(context.base, source, [...backups.keys()], run.acceptancePlan || [], profile);
          if (run.regression && context.phase === 'patching') await assertFrozenRegressions(source, run.regressions || [run.regression]);
        } catch (error) {
          for (const [relative, content] of backups) { const file = await sourcePath(source, relative, true); if (content === null) await fs.rm(file, { force: true }); else await fs.writeFile(file, content); }
          throw error;
        }
        run.graphStale = true;
        context.toolFailures = undefined;
        await this.repository.mirror(run, source, context.abort.signal); result = { changed: args.edits.map((e: any) => e.path), graphStale: true };
      } else if (name === 'run_check') {
        if (['test-focused','test-module'].includes(args.check) && !args.test) throw new Error(`${args.check} requires test: a qualified Rust test/module name. target is only for an integration test file stem; for example use {check:"test-module",test:"module::tests"}.`);
        if (args.check === 'test-integration' && !args.target) throw new Error('test-integration requires target: the new Cargo integration test file stem');
        if (args.check === 'test-integration' && args.test !== undefined && typeof args.test !== 'string') throw new Error('Use a canonical integration test name');
        if (context.phase === 'review') throw new Error('Checks are disabled during acceptance review; inspect source only');
        if (run.regression && context.phase === 'patching') await assertFrozenRegressions(source, run.regressions || [run.regression]);
        const profile = run.profile || this.config.profile;
        const target = args.target ? { kind: 'integration' as const, name: args.target } : { kind: 'unit' as const };
        const exploratoryIntegration = args.check === 'test-integration' && args.test === undefined;
        const argv = args.check === 'list-tests' ? listTestsCheck(target, profile) : args.check === 'format-source' ? formatCheck(profile) : args.check === 'test-integration' ? exploratoryIntegration ? integrationTargetCheck(args.target, profile) : regressionCheck({ target, file: `${profile.testRoots[0]}/${args.target}.rs`, testName: args.test } as Regression, profile) : ['test-focused', 'test-module'].includes(args.check) ? focusedCheck(args.check, args.test || '', profile) : profile.fastCheckIds.includes(args.check) ? profile.checks[args.check] : null;
        if (!argv) throw new Error(`Unknown approved check. Available: ${[...profile.fastCheckIds, 'list-tests', 'format-source', 'test-focused', 'test-module', 'test-integration'].join(', ')}`);
        const check = args.check === 'format-source' ? await this.formatSource(context, argv) : await this.check(context, run.workerContainer!, `tool-${run.tools}-${args.check}`, argv, (run.regressions || []).filter(r => JSON.stringify(regressionCheck(r.spec, profile)) === JSON.stringify(argv)).map(r => r.spec.id!)); const checked: typeof check & { note?: string } = { ...check, output: check.output.slice(-24000) }; result = checked;
        if (exploratoryIntegration) checked.note = check.status === 'no_match' ? 'No tests executed in this integration target; zero matches are not a pass. Use list-tests to inspect its test names.' : 'Exploratory whole integration target; candidate evidence requires a passing exact frozen bug-scenario test.';
        if (args.check === 'list-tests') {
          const catalog = discoverTests(check.output,args.test || '');
          Object.assign(checked,catalog,{output:catalog.listedTests.join('\n'),note:catalog.truncated?'More names exist; call list-tests with test:"substring" to narrow the catalog.':'Canonical Cargo test names; listing does not execute tests.'});
        } else if (check.status === 'no_match') {
          const listing=await this.check(context,run.workerContainer!,`tool-${run.tools}-discover-tests`,listTestsCheck(target,profile));
          const needle=String(args.test || '').split('::').filter(part=>part && part!=='tests').at(-1) || '';
          Object.assign(checked,{suggestedTests:discoverTests(listing.output,needle).listedTests});
        }
        // A filter that matches nothing exits 0; say so, or the model reads it as a pass.
        if (!exploratoryIntegration && args.check.startsWith('test-') && !check.exitCode && /test result: ok\. 0 passed; 0 failed;/.test(check.output) && !/test result: ok\. [1-9]/.test(check.output)) checked.note = `No test matched "${args.test}". Focused/module checks use ${profile.focusedTestPrefix.join(' ')} with a crate-qualified test name under ${profile.sourceRoots.join(', ')}. For an integration target use test-integration with its target file stem and exact test name.`;
        // Read actual source after format-source copies its result back. Check IDs, logs and timings vary per call.
        const sourceHash = fingerprint(await inventory(source, context.abort.signal));
        const outputHash = hash(check.output);
        // Successful catalogs have stable names even when Cargo prints a different elapsed build time.
        // Keep the raw hash as provenance, and parse the full catalog before the response's 200-name limit.
        const progressOutputHash = args.check === 'list-tests' && !check.exitCode && !check.timedOut ? hash(JSON.stringify(parseListedTests(check.output))) : outputHash;
        const summary = { name: args.check, argv, status: check.status, exitCode: check.exitCode, timedOut: check.timedOut, outputHash, ...(args.check === 'list-tests' ? { progressOutputHash } : {}) };
        const selector = args.check === 'list-tests' ? args.test || '' : args.test ?? null;
        const signature = JSON.stringify([{ ...summary, outputHash: progressOutputHash }, selector, args.target ?? null, check.matched, check.passed, check.failed, check.ignored]);
        const current = JSON.stringify([sourceHash, context.phase, signature]);
        if (context.lastCheckSignature !== current) context.toolFailures = undefined;
        context.lastCheckSignature = current;
        if ((context.checkProgress ||= new ProgressTracker()).record(sourceHash, { kind: 'check-result-loop', phase: context.phase, signature })) diagnosis = { kind: 'check-result-loop', tool: name, args: requestedArgs, phase: context.phase, sourceHash, signature, check: summary };
      } else throw new Error('Unknown controller tool');
      const event = await this.store.event(run, 'tool', 'result', name, { tool: name, call: called.seq, result });
      context.usableToolResults = (context.usableToolResults || 0) + 1;
      if (diagnosis) await this.diagnose(context, diagnosis);
      return { evidenceId: event.seq, result };
    } catch (error) {
      const sourceHash = fingerprint(await inventory(source, context.abort.signal));
      const signature = JSON.stringify([name, String(error)]);
      await this.store.event(run, 'tool', 'rejected', String(error), { tool: name, call: called.seq });
      if ((context.toolFailures ||= new ProgressTracker()).record(sourceHash, { kind: 'tool-error', phase: context.phase, signature })) await this.diagnose(context, { kind: 'tool-error', tool: name, args: requestedArgs, phase: context.phase, sourceHash, signature, error: String(error) });
      throw error;
    }
  }
  private async preserveReproductionArtifact(context: Context, attempt: number, label: string, write: () => Promise<unknown>) {
    try { await write(); this.ensureActive(context); }
    catch (error) {
      if (context.abort.signal.aborted || error instanceof RunFailure) throw error;
      throw new RunFailure('needs_attention', `Unable to preserve reproduction artifact (${label}) for attempt ${attempt}: ${String(error)}. Submitted source has not been reset; partial artifacts are retained.`);
    }
  }
  private async preserveSubmittedReproduction(context: Context, attempt: number, answer: unknown) {
    const { run, source, abort } = context;
    const dir = path.join(this.store.dir(run.id), 'reproduction', `attempt-${attempt}`);
    let submitted: Record<string, string>, submittedSourceHash: string;
    try {
      submitted = await inventory(source, abort.signal); submittedSourceHash = fingerprint(submitted);
      await fs.mkdir(path.dirname(dir), { recursive: true }); await fs.mkdir(dir);
      await atomicJson(path.join(dir, 'submitted-answer.json'), structuredClone(answer));
      await atomicJson(path.join(dir, 'submitted-inventory.json'), submitted);
      await copySource(source, path.join(dir, 'submitted-source'), abort.signal);
      if (fingerprint(await inventory(path.join(dir, 'submitted-source'), abort.signal)) !== submittedSourceHash || fingerprint(await inventory(source, abort.signal)) !== submittedSourceHash) throw new Error('Source changed while preserving preformat evidence');
    } catch (error) {
      if (abort.signal.aborted) throw error;
      throw new RunFailure('needs_attention', `Unable to preserve submitted reproduction before formatting: ${String(error)}. Source has not been reset; partial artifacts are retained at reproduction/attempt-${attempt}.`);
    }
    return { dir, submitted, submittedSourceHash };
  }
  private async formatReproduction(context: Context, attempt: number, answer: unknown) {
    const { run, source, abort } = context, profile = run.profile || this.config.profile;
    const { dir, submitted, submittedSourceHash } = await this.preserveSubmittedReproduction(context, attempt, answer);
    // Freeze only after trusted normalization. A later formatter must never waive frozen bytes.
    await this.retryHarness(context, async () => {
      const normalized = await this.formatSource(context, formatCheck(profile), `repro-${attempt}-format-source`);
      if (normalized.exitCode || normalized.timedOut) throw new Error(`Trusted reproduction formatting failed; see ${normalized.log}`);
      const check = await this.check(context, run.workerContainer!, `repro-${attempt}-fmt`, [...formatCheck(profile), '--', '--check']);
      if (check.exitCode || check.timedOut) throw new Error(`Trusted reproduction formatting check failed; see ${check.log}`);
    });
    const formatted = await inventory(source, abort.signal);
    const receipt = { submittedSourceHash, formattedSourceHash: fingerprint(formatted), changedFiles: changedFiles(submitted, formatted), formatterCheck: `repro-${attempt}-format-source`, formattingCheck: `repro-${attempt}-fmt` };
    await atomicJson(path.join(dir, 'formatting.json'), receipt);
    await this.store.event(run, 'controller', 'regression_formatted', 'Trusted formatting completed before regression freeze', receipt);
  }
  private async formatSource(context: Context, argv: string[], id = `tool-${context.run.tools}-format-source`) {
    const { run, source } = context; const profile = run.profile || this.config.profile;
    const temporary = path.join(this.store.dir(run.id), 'formatting', id);
    await copySource(source, temporary, context.abort.signal); const before = await inventory(temporary, context.abort.signal);
    let container: string | undefined;
    try {
      container = await this.docker.startWorker(run, temporary, run.image!, false, `formatter-${id}`, context.abort.signal);
      const check = await this.check(context, container, id, argv, [], temporary);
      if (check.exitCode || check.timedOut) return check;
      const after = await inventory(temporary, context.abort.signal);
      for (const relative of changedFiles(before, after)) if (!after[relative] || ![...profile.sourceRoots, ...profile.testRoots].some(root => relative.startsWith(root + '/'))) throw new Error(`Formatter changed a disallowed file: ${relative}`);
      if (context.phase === 'reproduction') await assertReproductionEdits(context.base, temporary, changedFiles(before, after), run.acceptancePlan || [], profile);
      if (run.regression && context.phase === 'patching') await assertFrozenRegressions(temporary, run.regressions || [run.regression]);
      this.ensureActive(context); await this.resetSource(source, temporary, context.abort.signal); await this.repository.mirror(run, source, context.abort.signal); run.graphStale = true; return check;
    } finally { if (container) await this.docker.remove(container); await fs.rm(temporary, { recursive: true, force: true }); }
  }
  async recordIntervention(id: string, kind: unknown, message: unknown): Promise<Manifest> {
    if (typeof kind !== 'string' || !['guidance','manual_fix','harness_fix','review'].includes(kind)) throw new Error('Intervention kind must be guidance, manual_fix, harness_fix, or review');
    if (typeof message !== 'string' || !message.trim() || message.length > 4000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(message)) throw new Error('Intervention message must be a nonempty summary of at most 4000 characters without control characters');
    if (/(?:\b(?:gh[pousr]_|github_pat_|nvapi-|sk-(?:proj-|svcacct-)?)[A-Za-z0-9_-]{10,}|\b(?:authorization\s*:\s*)?bearer\s+\S+|\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|password|secret|credential)\s*(?::|=)\s*\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i.test(message)) throw new Error('Intervention notes must contain action summaries without credentials');
    const append = async (run: Manifest) => {
      const note: NonNullable<Manifest['interventions']>[number] = {time:new Date().toISOString(),kind:kind as NonNullable<Manifest['interventions']>[number]['kind'],message:message.trim()};
      (run.interventions ||= []).push(note);
      await this.store.save(run);
      await this.store.event(run,'operator','intervention',`${note.kind}: ${note.message}`,note);
      if (run.stage === 'complete') await writeReport(this.store,run);
      return run;
    };
    const active = this.contexts.get(id);
    if (active) return append(active.run);
    // Different notes must never share publication-style idempotency and silently drop a message.
    return this.admission.run(`intervention:${id}:${randomBytes(8).toString('hex')}`,async () => {
      if (this.active || this.contexts.size) throw new Error('Record completed-run interventions when execution/publication is idle');
      const run = await this.store.get(id);
      if (run.stage !== 'complete') throw new Error('Run has no active execution; wait for recovery before recording a note');
      return append(run);
    });
  }
  async cancel(id: string) { const context = this.contexts.get(id); if (!context) throw new Error('Run is not active'); context.abort.abort(new RunFailure('cancelled', 'Cancelled by user')); await context.agent.stop(); await this.docker.cleanup(context.run); await this.executions.get(id)?.catch(() => {}); }
  private async resetSource(source: string, base: string, signal?: AbortSignal) {
    // Keep mounted directory identities stable for Docker Desktop's file-sharing cache.
    const before = await inventory(source, signal), after = await inventory(base, signal);
    for (const relative of changedFiles(before, after)) {
      signal?.throwIfAborted(); const destination = await sourcePath(source, relative, true);
      if (!after[relative]) { await fs.rm(destination, {force:true}); continue; }
      const original = await sourcePath(base, relative); await fs.mkdir(path.dirname(destination), {recursive:true});
      const bytes = await fs.readFile(original, {signal}); signal?.throwIfAborted();
      await fs.writeFile(destination, bytes, {signal}); await fs.chmod(destination, (await fs.stat(original)).mode & 0o777);
    }
    signal?.throwIfAborted();
  }
  async publish(run: Manifest, signal = AbortSignal.timeout(this.config.commandTimeoutMs)) {
    if (run.demo || run.input.mode === 'evaluation' || !run.verifiedTree || !run.verifiedCommit) throw new Error('Only a verified live commit can be published');
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]+$/.test(this.config.fork)) throw new Error('Configure a personal OWNER/REPOSITORY fork');
    const profile = run.profile || this.config.profile;
    const identity = bindPublicationIdentity(run, this.config);
    if (identity.fork !== this.config.fork) throw new Error(`Publication destination is recorded as ${identity.fork}; current configuration ${this.config.fork} differs. Restore the recorded destination before retrying.`);
    signal.throwIfAborted(); await this.requirePublishSecret(signal); run.publisherImageId ||= await this.docker.imageId(this.config.publisherImage, signal); await this.docker.imageId(run.publisherImageId, signal);
    await this.store.stage(run, 'publishing', 'Pushing the exact verified commit and reconciling draft PR creation');
    run.publication = { ...run.publication, state: 'pending', fork: identity.fork, head: identity.branch, base: identity.base, originalVerifiedCommit: run.verifiedCommit }; await this.store.save(run); await writeReport(this.store, run);
    await atomicJson(path.join(this.store.dir(run.id), 'publication-input.json'), { runId: run.id, upstream: identity.upstream, fork: identity.fork, branch: identity.branch, commit: run.verifiedCommit, tree: run.verifiedTree, issue: run.issue!.number, base: identity.base, title: prTitle(run) });
    const container = `bugfix-${run.id}-publisher`;
    try {
      const result = await this.docker.command(['run', '--name', container, '--label', `bugfix.run=${run.id}`, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--mount', `type=bind,source=${this.store.dir(run.id)},target=/artifacts`, '--mount', `type=bind,source=${this.config.githubSecret},target=/run/secrets/github_token,readonly`, run.publisherImageId], run, signal);
      const outcome = JSON.parse(await fs.readFile(path.join(this.store.dir(run.id), 'publication-result.json'), 'utf8').catch(() => '{}'));
      if (result.code || !outcome.url || outcome.commit !== run.verifiedCommit) throw new Error(outcome.error || result.stderr || 'Publisher failed or result is uncertain; retry reconciles GitHub before creating another PR');
      run.publication.state = 'created'; run.publication.url = outcome.url; run.publication.currentHead = outcome.commit; run.publication.changedSinceVerification = false; run.outcome = 'draft_created';
      await this.store.event(run, 'publisher', 'draft_created', outcome.url);
    } catch (e) { run.publication.state = 'failed'; run.publication.error = String(e); run.outcome = 'verified_unpublished'; await this.store.event(run, 'publisher', 'failed', String(e)); }
    finally { await this.docker.remove(container); await this.store.save(run); await writeReport(this.store, run); }
  }
  refreshPublication(id: string): Promise<Manifest> {
    return this.admission.run(`inspect:${id}`, async () => {
    if (this.active || this.contexts.size) throw new Error('Inspect PR state when execution/publication is idle');
    const run = await this.store.get(id);
    if (run.stage !== 'complete') throw new Error('Inspect PR state after the execution completes');
    const observation = await this.publicationInspector(run, this.config);
    run.publication = { ...run.publication!, ...observation };
    await this.store.save(run); await writeReport(this.store, run);
    await this.store.event(run, 'publisher', 'remote_observation', 'Refreshed PR head, review and CI observations', observation);
    return run;
    });
  }
  retryPublication(id: string): Promise<Manifest> {
    return this.admission.run(`publish:${id}`, async () => {
      if (this.active || this.contexts.size) throw new Error('Another run is active');
      this.active = id;
      try { const run = await this.store.get(id); if (run.outcome === 'draft_created' && run.publication?.state === 'created') return run; if (!['verified_unpublished', 'verified_patch'].includes(run.outcome || '') || !run.verifiedCommit) throw new Error('No verified committed result is available to publish'); await this.publish(run); run.stage = 'complete'; await this.store.save(run); return run; }
      finally { this.active = undefined; }
    });
  }
  private async requirePublishSecret(signal?: AbortSignal) {
    signal?.throwIfAborted(); const result = await this.docker.command(['run', '--rm', '--network', 'none', '--cap-drop', 'ALL', '--entrypoint', '/usr/bin/test', '--mount', `type=bind,source=${this.config.githubSecret},target=/run/secrets/github_token,readonly`, this.config.publisherImage, '-s', '/run/secrets/github_token'], undefined, signal);
    checked(result, 'Publisher credential file is missing or empty');
  }
}
