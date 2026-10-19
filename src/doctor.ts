import fs from 'node:fs/promises';
import { exec } from './process.ts';
import type { Config } from './types.ts';
export interface DoctorResult { name: string; ok: boolean; detail: string; required: boolean; }
export async function doctor(config: Config): Promise<DoctorResult[]> {
  const results: DoctorResult[] = [];
  async function check(name: string, file: string, args: string[], required = true) {
    try { const r = await exec(file, args, { timeoutMs: 12000 }); results.push({ name, ok: r.code === 0, detail: (r.stdout || r.stderr).trim().slice(0, 1000) || (r.code === 0 ? 'Available' : 'Unavailable or empty; configure before publication'), required }); }
    catch (e) { results.push({ name, ok: false, detail: String(e), required }); }
  }
  await check('Docker engine', config.docker, ['version', '--format', '{{.Server.Version}}']);
  await check('Git', 'git', ['--version']);
  for (const [name, image] of [['Worker image', config.workerImage], ['OpenCode image', config.agentImage], ['Publisher image', config.publisherImage]]) await check(name, config.docker, ['image', 'inspect', '--format', '{{.Id}}', image]);
  for (const [name, file, required] of [['NVIDIA secret', config.nvidiaSecret, true]] as const) {
    const info = await fs.stat(file).catch(() => null);
    results.push({ name, ok: !!info?.isFile() && info.size > 10, detail: info?.isFile() && info.size > 10 ? 'Secret file exists (value not displayed)' : `Create ${file} with a token; do not paste it into logs/chat`, required });
  }
  await check('GitHub secret (publisher only)', config.docker, ['run', '--rm', '--network', 'none', '--cap-drop', 'ALL', '--entrypoint', '/usr/bin/test', '--mount', `type=bind,source=${config.githubSecret},target=/run/secrets/github_token,readonly`, config.publisherImage, '-s', '/run/secrets/github_token'], false);
  const modelOk = /^[^/\s]+\/[^\s]+$/.test(config.model) && !/REPLACE|YOUR_|placeholder/i.test(config.model);
  results.push({ name: 'OpenCode model', ok: modelOk, detail: modelOk ? config.model : 'Set BUGFIX_MODEL to the existing provider/model ID', required: true });
  const repos = await fs.readdir(config.repoRoot).catch(() => []);
  results.push({ name: 'Repository root', ok: repos.length > 0, detail: repos.length ? config.repoRoot : `No clone found in ${config.repoRoot}; run ./bugfix clone`, required: true });
  results.push({ name: 'Repository profile', ok: true, detail: `${config.profile.id}: ${config.profile.upstream} @ ${config.profile.baseBranch} (${config.profile.adapter})`, required: true });
  results.push({ name: 'Publish configuration', ok: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.fork) && config.fork.toLowerCase() !== config.profile.upstream.toLowerCase() && !/YOUR_|placeholder/i.test(config.fork + config.gitName + config.gitEmail) && !!config.gitName && !!config.gitEmail, detail: 'Requires personal fork, commit author and GitHub token; capabilities are checked on actual publication', required: false });
  return results;
}
