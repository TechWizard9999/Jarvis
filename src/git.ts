import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { exec, checked } from './process.ts';
import { safeRelative, inventory, fingerprint } from './files.ts';
import { prTitle } from './report.ts';
import type { Config, Manifest } from './types.ts';

export class Repository {
  config: Config; hooks: string;
  constructor(config: Config) { this.config = config; this.hooks = path.join(config.stateDir, 'empty-hooks'); }
  async git(repo: string, args: string[], input?: string) {
    await fs.mkdir(this.hooks, { recursive: true });
    return exec('git', ['-c', `safe.directory=${repo}`, '-c', `core.hooksPath=${this.hooks}`, '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', '-C', repo, ...args], {
      input, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_EXTERNAL_DIFF: '', GIT_DIFF_OPTS: '' }, timeoutMs: 120000,
    });
  }
  async preflight(run: Manifest, destination: string) {
    const profile = run.profile || this.config.profile;
    const root = await fs.realpath(this.config.repoRoot); const repo = await fs.realpath(run.input.repo);
    if (repo === root || !repo.startsWith(root + path.sep)) throw new Error(`Repository must be inside the configured repository root: ${root}`);
    if (checked(await this.git(repo, ['rev-parse', '--is-inside-work-tree']), 'Read repository') !== 'true') throw new Error('Not a Git working tree');
    if (checked(await this.git(repo, ['status', '--porcelain', '--untracked-files=normal']), 'Check clean tree')) throw new Error('Commit or remove local changes before starting');
    let ref = run.input.base || 'HEAD';
    if (run.input.mode !== 'evaluation' && run.input.mode !== 'demo') {
      // Network fetch: up to 3 tries before the environment counts as blocked.
      let fetched = await this.git(repo, ['fetch', '--no-tags', `https://github.com/${profile.upstream}.git`, profile.baseBranch]);
      for (let attempt = 2; attempt <= 3 && (fetched.code || fetched.timedOut); attempt++) { await new Promise(resolve => setTimeout(resolve, 5000 * attempt)); fetched = await this.git(repo, ['fetch', '--no-tags', `https://github.com/${profile.upstream}.git`, profile.baseBranch]); }
      checked(fetched, 'Fetch upstream contribution base');
      const latest = checked(await this.git(repo, ['rev-parse', 'FETCH_HEAD^{commit}']), 'Resolve upstream base');
      if (run.input.base && checked(await this.git(repo, ['rev-parse', '--verify', `${run.input.base}^{commit}`]), 'Resolve requested base') !== latest) throw new Error(`Publishing requires the current upstream ${profile.baseBranch} base; use evaluation mode for historical commits`);
      ref = latest;
    }
    if (ref.startsWith('-') || /[\x00-\x20]/.test(ref)) throw new Error('Invalid base reference');
    run.baseSha = checked(await this.git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]), 'Resolve base');
    run.baseTree = checked(await this.git(repo, ['rev-parse', `${run.baseSha}^{tree}`]), 'Resolve tree');
    const cargo = checked(await this.git(repo, ['show', `${run.baseSha}:${profile.manifest}`]), 'Read Cargo manifest');
    if (!new RegExp(`^name\\s*=\\s*"${profile.packageName}"\\s*$`, 'm').test(cargo)) throw new Error(`Repository package does not match profile ${profile.id}`);
    const tree = checked(await this.git(repo, ['ls-tree', '-rz', run.baseSha]), 'Read source tree');
    const entries = tree.split('\0').filter(Boolean).map(line => {
      const match = /^(\d+) blob ([a-f0-9]+)\t(.+)$/s.exec(line);
      if (!match || !['100644', '100755'].includes(match[1])) throw new Error('Submodules and source symlinks are unsupported in the first MVP');
      safeRelative(match[3]); return { mode: match[1], oid: match[2], name: match[3] };
    });
    run.branch = `fix/issue-${run.issue!.number}-${run.id}`;
    run.worktree = path.join(this.config.stateDir, 'worktrees', run.id);
    await fs.mkdir(path.dirname(run.worktree), { recursive: true });
    checked(await this.git(repo, ['worktree', 'add', '-b', run.branch, run.worktree, run.baseSha]), 'Create isolated worktree');
    await fs.mkdir(destination, { recursive: true });
    // Copy tracked files from the worktree, then compare Git object IDs. No .git or later history enters the worker.
    const algorithm = checked(await this.git(repo, ['rev-parse', '--show-object-format']), 'Read object format');
    for (const item of entries) {
      const from = path.join(run.worktree, item.name); const to = path.join(destination, item.name);
      const content = await fs.readFile(from);
      const oid = createHash(algorithm).update(`blob ${content.length}\0`).update(content).digest('hex');
      if (oid !== item.oid) throw new Error(`Checkout filters altered ${item.name}; cannot create an exact snapshot`);
      await fs.mkdir(path.dirname(to), { recursive: true }); await fs.writeFile(to, content, { mode: item.mode === '100755' ? 0o755 : 0o644 });
    }
    run.sourceHash = fingerprint(await inventory(destination)); run.input.repo = repo;
  }
  async mirror(run: Manifest, source: string) {
    if (!run.worktree) throw new Error('Worktree missing');
    const before = await inventory(run.worktree); const after = await inventory(source);
    for (const relative of Object.keys(before)) if (!(relative in after)) await fs.rm(path.join(run.worktree, relative));
    for (const relative of Object.keys(after)) {
      if (before[relative] === after[relative]) continue;
      const from = path.join(source, relative), to = path.join(run.worktree, relative);
      await fs.mkdir(path.dirname(to), { recursive: true }); await fs.copyFile(from, to); await fs.chmod(to, (await fs.stat(from)).mode & 0o777);
    }
  }
  async diff(run: Manifest, source: string): Promise<string> {
    await this.mirror(run, source);
    const paths: string[] = [];
    const profile = run.profile || this.config.profile;
    for (const relative of [...profile.sourceRoots, ...profile.testRoots]) if (await fs.stat(path.join(run.worktree!, relative)).catch(() => null)) paths.push(relative);
    checked(await this.git(run.worktree!, ['add', '-A', '-f', '--', ...paths]), 'Stage candidate including new fixtures (even names the repository ignores)');
    return checked(await this.git(run.worktree!, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', run.baseSha!]), 'Export patch') + '\n';
  }
  async tree(run: Manifest, source: string) { await this.diff(run, source); return checked(await this.git(run.worktree!, ['write-tree']), 'Record candidate tree'); }
  async commit(run: Manifest, source: string, bundle: string) {
    if (!this.config.gitName || !this.config.gitEmail) throw new Error('Configure BUGFIX_GIT_NAME and BUGFIX_GIT_EMAIL before publishing');
    const tree = await this.tree(run, source);
    if (tree !== run.verifiedTree) throw new Error('Candidate differs from verified tree');
    checked(await this.git(run.worktree!, ['-c', `user.name=${this.config.gitName}`, '-c', `user.email=${this.config.gitEmail}`, '-c', 'commit.gpgSign=false', 'commit', '-m', prTitle(run), '-m', `Refs ${run.issue!.url}`]), 'Commit verified candidate');
    run.verifiedCommit = checked(await this.git(run.worktree!, ['rev-parse', 'HEAD']), 'Read verified commit');
    if (checked(await this.git(run.worktree!, ['rev-parse', 'HEAD^{tree}']), 'Read committed tree') !== tree) throw new Error('Commit tree mismatch');
    checked(await this.git(run.worktree!, ['bundle', 'create', bundle, run.branch!]), 'Prepare publisher bundle');
  }
}
