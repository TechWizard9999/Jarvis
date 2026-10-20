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
  const thinking=env.BUGFIX_MODEL_THINKING || 'true'; if (!['true','false'].includes(thinking)) throw new Error('BUGFIX_MODEL_THINKING must be true or false');
  return {
    modelTemperature:bounded('BUGFIX_MODEL_TEMPERATURE',1,0,2),modelTopP:bounded('BUGFIX_MODEL_TOP_P',0.95,0.0001,1),modelThinking:thinking==='true',reasoningBudget:positive('BUGFIX_REASONING_BUDGET',16384),
    profile: loadProfile(profilePath), profilePath,
    providerBaseUrl: env.BUGFIX_PROVIDER_BASE_URL || env.BUGFIX_NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1/',
    modelContext: positive('BUGFIX_MODEL_CONTEXT', 131072), modelMaxOutput: positive('BUGFIX_MODEL_MAX_OUTPUT', 16384),
    projectDir, stateDir: path.resolve(env.BUGFIX_STATE_DIR || path.join(projectDir, 'state')),
    repoRoot: path.resolve(env.BUGFIX_REPO_ROOT || path.join(projectDir, 'repos')),
    port: positive('BUGFIX_PORT', 3210), bind: env.BUGFIX_BIND || '127.0.0.1',
    model: env.BUGFIX_MODEL || '', fork: env.BUGFIX_FORK || '',
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
