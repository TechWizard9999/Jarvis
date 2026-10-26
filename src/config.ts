import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Config } from './types.ts';
import { defaultProfilePath, loadProfile } from './profile.ts';

export function loadConfig(env = process.env): Config {
  const projectDir = path.resolve(env.BUGFIX_PROJECT_DIR || process.cwd());
  const profilePath = path.resolve(env.BUGFIX_PROFILE || defaultProfilePath);
  const positive = (key: string, fallback: number) => {
    const value = Number(env[key] || fallback);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${key}`);
    return value;
  };
  const bounded = (key: string, fallback: number, min: number, max: number) => { const value=Number(env[key] || fallback); if (!Number.isFinite(value) || value<min || value>max) throw new Error(`Invalid ${key}`); return value; };
  const boolean = (key: string, fallback: boolean) => {
    const value = env[key] || String(fallback);
    if (!['true', 'false'].includes(value)) throw new Error(`${key} must be true or false`);
    return value === 'true';
  };
  const model = env.BUGFIX_MODEL || '';
  const modelContext = positive('BUGFIX_MODEL_CONTEXT', 262144);
  const modelMaxOutput = positive('BUGFIX_MODEL_MAX_OUTPUT', 24576);
  if (modelMaxOutput >= modelContext) throw new Error('Model output must be smaller than context');
  const modelInput = positive('BUGFIX_MODEL_INPUT', Math.min(196608, modelContext - modelMaxOutput));
  const compactionReserved = positive('BUGFIX_COMPACTION_RESERVED', 8192);
  const allowUnverifiedContext = boolean('BUGFIX_ALLOW_UNVERIFIED_CONTEXT', false);
  const allowUnboundedReasoning = boolean('BUGFIX_ALLOW_UNBOUNDED_REASONING', false);
  const reasoningBudget = Number(env.BUGFIX_REASONING_BUDGET || 16384);
  if (!Number.isSafeInteger(reasoningBudget) || (reasoningBudget <= 0 && reasoningBudget !== -1)) throw new Error('Invalid BUGFIX_REASONING_BUDGET');
  if (reasoningBudget === -1 && !allowUnboundedReasoning) throw new Error('BUGFIX_REASONING_BUDGET=-1 requires BUGFIX_ALLOW_UNBOUNDED_REASONING=true for research');
  if (modelContext > 1048576) throw new Error('Model context exceeds the finite 1048576-token configuration bound');
  if (modelContext > 262144 && !allowUnverifiedContext) throw new Error('Context above 262144 requires BUGFIX_ALLOW_UNVERIFIED_CONTEXT=true; endpoint support is unverified');
  if (modelInput + modelMaxOutput > modelContext) throw new Error('Model input plus output must fit within context');
  if (compactionReserved >= modelInput) throw new Error('Compaction reserve must be smaller than model input');
  if (/^(?:[^/]+\/)?nvidia\/nemotron-/.test(model) && modelMaxOutput > 32768) throw new Error('NVIDIA Nemotron output exceeds the documented per-request 32768-token cap');
  return {
    modelTemperature:bounded('BUGFIX_MODEL_TEMPERATURE',1,0,2),modelTopP:bounded('BUGFIX_MODEL_TOP_P',0.95,0.0001,1),modelThinking:boolean('BUGFIX_MODEL_THINKING',true),reasoningBudget,
    profile: loadProfile(profilePath), profilePath,
    providerBaseUrl: env.BUGFIX_PROVIDER_BASE_URL || env.BUGFIX_NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1/',
    modelContext, modelInput, modelMaxOutput, compactionReserved, allowUnverifiedContext, allowUnboundedReasoning,
    projectDir, stateDir: path.resolve(env.BUGFIX_STATE_DIR || path.join(projectDir, 'state')),
    repoRoot: path.resolve(env.BUGFIX_REPO_ROOT || path.join(projectDir, 'repos')),
    port: positive('BUGFIX_PORT', 3210), bind: env.BUGFIX_BIND || '127.0.0.1',
    model, fork: env.BUGFIX_FORK || '',
    gitName: env.BUGFIX_GIT_NAME || '', gitEmail: env.BUGFIX_GIT_EMAIL || '',
    rustToolchain: env.BUGFIX_RUST_TOOLCHAIN || '1.99.1', docker: env.BUGFIX_DOCKER || 'docker',
    workerImage: env.BUGFIX_WORKER_IMAGE || 'bugfix-worker:0.1', agentImage: env.BUGFIX_AGENT_IMAGE || 'bugfix-opencode:0.1',
    publisherImage: env.BUGFIX_PUBLISHER_IMAGE || 'bugfix-publisher:0.1',
    dockerNetwork: env.BUGFIX_NETWORK || 'bugfix-control', controllerUrl: env.BUGFIX_CONTROLLER_URL || 'http://controller:3210',
    commandTimeoutMs: positive('BUGFIX_COMMAND_TIMEOUT_MS', 900000),
    maxAttempts: positive('BUGFIX_MAX_ATTEMPTS', 6), memory: env.BUGFIX_MEMORY || '4g', cpus: env.BUGFIX_CPUS || '2',
    bridgeToken: env.BUGFIX_BRIDGE_TOKEN || randomBytes(32).toString('hex'),
    nvidiaSecret: path.resolve(env.BUGFIX_NVIDIA_SECRET || path.join(projectDir, '.secrets/nvidia_api_key')),
    githubSecret: path.resolve(env.BUGFIX_GITHUB_SECRET || path.join(projectDir, '.secrets/github_token')),
  };
}
