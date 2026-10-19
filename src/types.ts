export type Stage = 'queued' | 'preflight' | 'environment' | 'discovery' | 'reproduction' | 'patching' | 'verification' | 'publishing' | 'complete';
export type Outcome = 'draft_created' | 'verified_patch' | 'verified_unpublished' | 'cannot_reproduce' | 'environment_blocked' | 'verification_failed' | 'cancelled' | 'interrupted' | 'demo_complete';
export interface RunInput { repo: string; issue: string; base?: string; mode?: 'live' | 'evaluation' | 'demo'; retrieval?: 'graph' | 'text'; publish?: boolean; }
export interface Issue { url: string; number: number; title: string; body: string; }
export interface CheckResult { id: string; argv: string[]; exitCode: number; durationMs: number; log: string; timedOut: boolean; }
export interface RunEvent { seq: number; runId: string; time: string; stage: Stage; source: string; kind: string; message: string; data?: unknown; }
export interface Regression { file: string; testName: string; failureContains: string; expectedBehavior: string; citation: string; fixtures: string[]; citationVerified?: boolean; failureAdopted?: boolean; }
export interface FrozenRegression { spec: Regression; functionHash: string; contextHash: string; fixtureHashes: Record<string, string>; overlayHash: string; }
export interface SnapshotUpdate { path: string; reason: string; owner: string; }
export interface Candidate { explanation: string; evidenceIds: number[]; snapshots?: SnapshotUpdate[]; }
export interface Manifest {
  profile?: RepositoryProfile;
  id: string; input: RunInput; createdAt: string; updatedAt: string; stage: Stage; outcome?: Outcome;
  issue?: Issue; baseSha?: string; baseTree?: string; branch?: string; worktree?: string; sourceHash?: string;
  image?: string; imageId?: string; toolchain?: string; model?: string; graphVersion?: string;
  sessionId?: string; opencodeUrl?: string; agentContainer?: string; workerContainer?: string;
  tools: number; tokens: number; attempt: number; checks: CheckResult[]; graphReady: boolean; graphStale: boolean;
  regression?: FrozenRegression; candidate?: Candidate; verifiedTree?: string; verifiedCommit?: string;
  publication?: { state: 'pending' | 'created' | 'failed'; fork: string; head: string; base: string; url?: string; error?: string; };
  error?: string; demo: boolean;
}
export interface Config {
  profile: RepositoryProfile; profilePath: string; providerBaseUrl: string; modelContext: number; modelMaxOutput: number;
  projectDir: string; stateDir: string; repoRoot: string; port: number; bind: string; model: string;
  fork: string; gitName: string; gitEmail: string; rustToolchain: string; docker: string;
  workerImage: string; agentImage: string; publisherImage: string; dockerNetwork: string;
  controllerUrl: string; commandTimeoutMs: number;
  maxAttempts: number; memory: string; cpus: string; bridgeToken: string;
  nvidiaSecret: string; githubSecret: string;
}
import type { RepositoryProfile } from './profile.ts';
