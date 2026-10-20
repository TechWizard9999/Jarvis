export type Stage = 'queued' | 'preflight' | 'environment' | 'discovery' | 'reproduction' | 'patching' | 'verification' | 'publishing' | 'complete';
export type Outcome = 'draft_created' | 'verified_patch' | 'verified_unpublished' | 'cannot_reproduce' | 'environment_blocked' | 'verification_failed' | 'cancelled' | 'interrupted' | 'demo_complete' | 'needs_attention';
export interface RunInput { repo: string; issue: string; base?: string; mode?: 'live' | 'evaluation' | 'demo'; retrieval?: 'graph' | 'text'; publish?: boolean; acceptance?: AcceptanceRequirement[]; allowCompeting?: boolean; }
export interface Issue { url: string; number: number; title: string; body: string; }
export interface CheckSummary { status: 'passed' | 'failed' | 'no_match' | 'timed_out'; matched?: number; passed?: number; failed?: number; ignored?: number; }
export interface CheckResult { id: string; argv: string[]; exitCode: number; durationMs: number; log: string; timedOut: boolean; status?: CheckSummary['status']; matched?: number; passed?: number; failed?: number; ignored?: number; scenarioIds?: string[]; candidateRevision?: string; sourceHash?: string; stage?: Stage; attempt?: number; }
export interface RunEvent { seq: number; runId: string; time: string; stage: Stage; source: string; kind: string; message: string; data?: unknown; }
export type RegressionTarget = { kind: 'unit' } | { kind: 'integration'; name: string };
export interface AcceptanceRequirement { id: string; expectedBehavior: string; citation: string; baseline: 'fail' | 'pass'; required?: boolean; target?: RegressionTarget; }
export interface Regression { id?: string; required?: boolean; baseline?: 'fail' | 'pass'; target?: RegressionTarget; file: string; testName: string; failureContains: string; expectedBehavior: string; citation: string; fixtures: string[]; citationVerified?: boolean; failureAdopted?: boolean; }
export interface FrozenRegression { spec: Regression; functionHash: string; contextHash: string; fixtureHashes: Record<string, string>; overlayHash: string; wholeFileHash?: string; fixtureInventory?: Record<string, string>; }
export interface SnapshotUpdate { path: string; reason: string; owner: string; }
export interface Candidate { explanation: string; evidenceIds: number[]; snapshots?: SnapshotUpdate[]; candidateRevision?: string; }
export type InterventionKind = 'guidance' | 'manual_fix' | 'harness_fix' | 'review';
export interface Intervention { time: string; kind: InterventionKind; message: string; }
export interface Manifest {
  interventions?: Intervention[];
  revision?: number; competingPullRequests?: string[];
  publicationIdentity?: { fork: string; upstream: string; base: string; branch: string; author: { name: string; email: string }; committer: { name: string; email: string } };
  commitProvenance?: { commit: string; tree: string; parents: string[]; author: { name: string; email: string }; committer: { name: string; email: string }; signoff: string };
  regressions?: FrozenRegression[];
  acceptancePlan?: AcceptanceRequirement[];
  acceptanceReview?: { complete: boolean; missing: string[]; explanation: string };
  executionStartedAt?: string; executionFinishedAt?: string; failureStage?: Stage;
  stageTimes?: { stage: Stage; startedAt: string; finishedAt?: string }[];
  agentImageId?: string; publisherImageId?: string; workerBaseImageId?: string;
  runConfig?: { artifact: string; sha256: string };
  modelRequests?: { id: string; startedAt: string; finishedAt?: string; latencyMs?: number; attempts: number; model: string; inputTokens?: number; outputTokens?: number; totalTokens?: number; usage: 'unknown' | 'partial' | 'complete'; status: 'pending' | 'completed' | 'failed' | 'interrupted'; httpStatus?: number; settings?: Record<string, unknown>; settingsSha256?: string; promptSha256?: string }[];
  profile?: RepositoryProfile;
  id: string; input: RunInput; createdAt: string; updatedAt: string; stage: Stage; outcome?: Outcome;
  issue?: Issue; baseSha?: string; baseTree?: string; branch?: string; worktree?: string; sourceHash?: string;
  image?: string; imageId?: string; toolchain?: string; model?: string; graphVersion?: string;
  sessionId?: string; opencodeUrl?: string; agentContainer?: string; workerContainer?: string;
  tools: number; tokens: number; attempt: number; checks: CheckResult[]; graphReady: boolean; graphStale: boolean;
  regression?: FrozenRegression; candidate?: Candidate; verifiedTree?: string; verifiedCommit?: string;
  publication?: { state: 'pending' | 'created' | 'failed'; fork: string; head: string; base: string; url?: string; error?: string; originalVerifiedCommit?: string; currentHead?: string; changedSinceVerification?: boolean; reviewState?: string; ciState?: string; claState?: string; inspectedAt?: string; inspectionErrors?: string[]; };
  error?: string; demo: boolean;
}
export interface Config {
  modelTemperature: number; modelTopP: number; modelThinking: boolean; reasoningBudget: number;
  profile: RepositoryProfile; profilePath: string; providerBaseUrl: string; modelContext: number; modelMaxOutput: number;
  projectDir: string; stateDir: string; repoRoot: string; port: number; bind: string; model: string;
  fork: string; gitName: string; gitEmail: string; rustToolchain: string; docker: string;
  workerImage: string; agentImage: string; publisherImage: string; dockerNetwork: string;
  controllerUrl: string; commandTimeoutMs: number;
  maxAttempts: number; memory: string; cpus: string; bridgeToken: string;
  nvidiaSecret: string; githubSecret: string;
}
import type { RepositoryProfile } from './profile.ts';
