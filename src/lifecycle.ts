import type { Config, Manifest } from './types.ts';

/** A single controller operation; identical concurrent requests share its result. */
export class OperationAdmission {
  private current?: { key: string; promise: Promise<unknown> };
  get activeKey(): string | undefined { return this.current?.key; }
  get busy(): boolean { return !!this.current; }
  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    if (this.current) {
      if (this.current.key === key) return this.current.promise as Promise<T>;
      return Promise.reject(new Error(`Another operation is active: ${this.current.key}`));
    }
    // The reservation is synchronous, including while operation() is awaiting its first load.
    const promise = Promise.resolve().then(operation).finally(() => {
      if (this.current?.promise === promise) this.current = undefined;
    });
    this.current = { key, promise }; return promise;
  }
}

export function bindPublicationIdentity(run: Manifest, config: Config): NonNullable<Manifest['publicationIdentity']> {
  const recorded = run.publicationIdentity;
  const profile = run.profile || config.profile;
  const identity = structuredClone(recorded || {
    fork: run.publication?.fork || config.fork,
    upstream: profile.upstream,
    base: run.publication?.base || profile.baseBranch,
    branch: run.branch || run.publication?.head || `fix/issue-${run.issue?.number || new URL(run.input.issue).pathname.split('/').filter(Boolean).at(-1)}-${run.id}`,
    author: { name: config.gitName, email: config.gitEmail },
    committer: { name: config.gitName, email: config.gitEmail },
  });
  Object.freeze(identity.author); Object.freeze(identity.committer); Object.freeze(identity);
  run.publicationIdentity = identity; return identity;
}

function publicEndpoint(value: string): string {
  try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.href; }
  catch { return 'invalid endpoint'; }
}
/** Allowlisted effective inputs only: credentials and credential paths never enter this artifact. */
export function captureRunConfiguration(config: Config) {
  return structuredClone({
    profile: config.profile, model: config.model, providerBaseUrl: publicEndpoint(config.providerBaseUrl),
    modelTemperature:config.modelTemperature,modelTopP:config.modelTopP,modelThinking:config.modelThinking,reasoningBudget:config.reasoningBudget,
    modelContext: config.modelContext, modelInput: config.modelInput, modelMaxOutput: config.modelMaxOutput,
    compactionReserved: config.compactionReserved, compaction: { auto: true, prune: true, reserved: config.compactionReserved },
    allowUnverifiedContext: config.allowUnverifiedContext, allowUnboundedReasoning: config.allowUnboundedReasoning,
    reasoningBudgetPolicy: { support: 'endpoint_dependent', unsupportedFallback: 'exact_nvidia_v2_error_once', capabilityCache: 'durable_exact_endpoint_model_until_revalidation', answerReserve: 'conditional_on_supported_reasoning_budget' },
    rustToolchain: config.rustToolchain,
    workerImage: config.workerImage, agentImage: config.agentImage, publisherImage: config.publisherImage,
    commandTimeoutMs: config.commandTimeoutMs, maxAttempts: config.maxAttempts, memory: config.memory, cpus: config.cpus,
    dockerNetwork: config.dockerNetwork, fork: config.fork, gitName: config.gitName, gitEmail: config.gitEmail,
  });
}
