import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { exec, checked } from './process.ts';
import { safeRelative, inventory, fingerprint } from './files.ts';
import { prTitle } from './report.ts';
import type { Config, Manifest } from './types.ts';
export interface GitPerson { name: string; email: string; }
export interface GitIdentity { author: GitPerson; committer: GitPerson; }
export interface CommitProvenance extends GitIdentity { commit: string; tree: string; parents: string[]; signoff: string; }
function gitEnvironment(identity?: GitIdentity): NodeJS.ProcessEnv {
  // Git uses environment overrides before -C/config, including repository/index and injected config.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_EXTERNAL_DIFF: '', GIT_DIFF_OPTS: '',
    ...(identity ? { GIT_AUTHOR_NAME: identity.author.name, GIT_AUTHOR_EMAIL: identity.author.email, GIT_COMMITTER_NAME: identity.committer.name, GIT_COMMITTER_EMAIL: identity.committer.email } : {}) };
}

export class Repository {
  config: Config; hooks: string;
  constructor(config: Config) { this.config = config; this.hooks = path.join(config.stateDir, 'empty-hooks'); }
  async git(repo: string, args: string[], input?: string, signal?: AbortSignal, identity?: GitIdentity) {
    signal?.throwIfAborted();
    await fs.mkdir(this.hooks, { recursive: true });
    signal?.throwIfAborted();
    return exec('git', ['-c', `safe.directory=${repo}`, '-c', `core.hooksPath=${this.hooks}`, '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', '-C', repo, ...args], {
      input, env: gitEnvironment(identity), timeoutMs: 120000, signal,
    });
  }
  async preflight(run: Manifest, destination: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const git = (repo: string, args: string[]) => this.git(repo, args, undefined, signal);
    const profile = run.profile || this.config.profile;
    const root = await fs.realpath(this.config.repoRoot); signal?.throwIfAborted(); const repo = await fs.realpath(run.input.repo); signal?.throwIfAborted();
    if (repo === root || !repo.startsWith(root + path.sep)) throw new Error(`Repository must be inside the configured repository root: ${root}`);
    if (checked(await git(repo, ['rev-parse', '--is-inside-work-tree']), 'Read repository') !== 'true') throw new Error('Not a Git working tree');
    if (checked(await git(repo, ['status', '--porcelain', '--untracked-files=normal']), 'Check clean tree')) throw new Error('Commit or remove local changes before starting');
    let ref = run.input.base || 'HEAD';
    if (run.input.mode !== 'evaluation' && run.input.mode !== 'demo') {
      // Network fetch: up to 3 tries before the environment counts as blocked.
      let fetched = await git(repo, ['fetch', '--no-tags', `https://github.com/${profile.upstream}.git`, profile.baseBranch]);
      for (let attempt = 2; attempt <= 3 && (fetched.code || fetched.timedOut); attempt++) {
        signal?.throwIfAborted(); await sleep(5000 * attempt, undefined, { signal }); signal?.throwIfAborted();
        fetched = await git(repo, ['fetch', '--no-tags', `https://github.com/${profile.upstream}.git`, profile.baseBranch]);
      }
      checked(fetched, 'Fetch upstream contribution base');
      const latest = checked(await git(repo, ['rev-parse', 'FETCH_HEAD^{commit}']), 'Resolve upstream base');
      if (run.input.base && checked(await git(repo, ['rev-parse', '--verify', `${run.input.base}^{commit}`]), 'Resolve requested base') !== latest) throw new Error(`Publishing requires the current upstream ${profile.baseBranch} base; use evaluation mode for historical commits`);
      ref = latest;
    }
    if (ref.startsWith('-') || /[\x00-\x20]/.test(ref)) throw new Error('Invalid base reference');
    run.baseSha = checked(await git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]), 'Resolve base');
    run.baseTree = checked(await git(repo, ['rev-parse', `${run.baseSha}^{tree}`]), 'Resolve tree');
    const cargo = checked(await git(repo, ['show', `${run.baseSha}:${profile.manifest}`]), 'Read Cargo manifest');
    if (!new RegExp(`^name\\s*=\\s*"${profile.packageName}"\\s*$`, 'm').test(cargo)) throw new Error(`Repository package does not match profile ${profile.id}`);
    const tree = checked(await git(repo, ['ls-tree', '-rz', run.baseSha]), 'Read source tree');
    const entries = tree.split('\0').filter(Boolean).map(line => {
      const match = /^(\d+) blob ([a-f0-9]+)\t(.+)$/s.exec(line);
      if (!match || !['100644', '100755'].includes(match[1])) throw new Error('Submodules and source symlinks are unsupported in the first MVP');
      safeRelative(match[3]); return { mode: match[1], oid: match[2], name: match[3] };
    });
    run.branch = `fix/issue-${run.issue!.number}-${run.id}`;
    run.worktree = path.join(this.config.stateDir, 'worktrees', run.id);
    signal?.throwIfAborted();
    await fs.mkdir(path.dirname(run.worktree), { recursive: true });
    checked(await git(repo, ['worktree', 'add', '-b', run.branch, run.worktree, run.baseSha]), 'Create isolated worktree');
    signal?.throwIfAborted();
    await fs.mkdir(destination, { recursive: true });
    // Copy tracked files from the worktree, then compare Git object IDs. No .git or later history enters the worker.
    const algorithm = checked(await git(repo, ['rev-parse', '--show-object-format']), 'Read object format');
    for (const item of entries) {
      signal?.throwIfAborted();
      const from = path.join(run.worktree, item.name); const to = path.join(destination, item.name);
      const content = await fs.readFile(from, { signal }); signal?.throwIfAborted();
      const oid = createHash(algorithm).update(`blob ${content.length}\0`).update(content).digest('hex');
      if (oid !== item.oid) throw new Error(`Checkout filters altered ${item.name}; cannot create an exact snapshot`);
      await fs.mkdir(path.dirname(to), { recursive: true }); signal?.throwIfAborted(); await fs.writeFile(to, content, { mode: item.mode === '100755' ? 0o755 : 0o644, signal });
    }
    signal?.throwIfAborted(); const entriesHash = fingerprint(await inventory(destination)); signal?.throwIfAborted(); run.sourceHash = entriesHash; run.input.repo = repo;
  }
  async mirror(run: Manifest, source: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!run.worktree) throw new Error('Worktree missing');
    const before = await inventory(run.worktree); const after = await inventory(source);
    signal?.throwIfAborted();
    for (const relative of Object.keys(before)) { signal?.throwIfAborted(); if (!(relative in after)) await fs.rm(path.join(run.worktree, relative)); }
    for (const relative of Object.keys(after)) {
      signal?.throwIfAborted();
      if (before[relative] === after[relative]) continue;
      const from = path.join(source, relative), to = path.join(run.worktree, relative);
      await fs.mkdir(path.dirname(to), { recursive: true }); signal?.throwIfAborted(); await fs.copyFile(from, to); signal?.throwIfAborted(); const stat = await fs.stat(from); signal?.throwIfAborted(); await fs.chmod(to, stat.mode & 0o777);
    }
    signal?.throwIfAborted();
  }
  async diff(run: Manifest, source: string, signal?: AbortSignal): Promise<string> {
    await this.mirror(run, source, signal);
    const paths: string[] = [];
    const profile = run.profile || this.config.profile;
    for (const relative of [...profile.sourceRoots, ...profile.testRoots]) if (await fs.stat(path.join(run.worktree!, relative)).catch(() => null)) paths.push(relative);
    checked(await this.git(run.worktree!, ['add', '-A', '-f', '--', ...paths], undefined, signal), 'Stage candidate including new fixtures (even names the repository ignores)');
    return checked(await this.git(run.worktree!, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', run.baseSha!], undefined, signal), 'Export patch') + '\n';
  }
  async tree(run: Manifest, source: string, signal?: AbortSignal) { await this.diff(run, source, signal); return checked(await this.git(run.worktree!, ['write-tree'], undefined, signal), 'Record candidate tree'); }
  async commit(run: Manifest, source: string, bundle: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const identity: GitIdentity = (run as Manifest & { publicationIdentity?: GitIdentity }).publicationIdentity || { author: { name: this.config.gitName, email: this.config.gitEmail }, committer: { name: this.config.gitName, email: this.config.gitEmail } };
    for (const person of [identity.author, identity.committer]) if (!person.name || !person.email || /[\r\n<>]/.test(person.name + person.email)) throw new Error('Configure a valid BUGFIX_GIT_NAME and BUGFIX_GIT_EMAIL before publishing');
    const tree = await this.tree(run, source, signal);
    if (tree !== run.verifiedTree) throw new Error('Candidate differs from verified tree');
    const signoff = `Signed-off-by: ${identity.author.name} <${identity.author.email}>`;
    checked(await this.git(run.worktree!, ['-c', `user.name=${identity.committer.name}`, '-c', `user.email=${identity.committer.email}`, '-c', 'commit.gpgSign=false', 'commit', '-m', prTitle(run), '-m', `Refs ${run.issue!.url}\n\n${signoff}`], undefined, signal, identity), 'Commit verified candidate');
    const metadata = checked(await this.git(run.worktree!, ['show', '-s', '--format=%H%x00%T%x00%P%x00%an%x00%ae%x00%cn%x00%ce%x00%B', 'HEAD'], undefined, signal), 'Read committed provenance').split('\0');
    const [commit, committedTree, parentLine, authorName, authorEmail, committerName, committerEmail, body] = metadata;
    const parents = parentLine.split(' ').filter(Boolean);
    if (committedTree !== tree) throw new Error('Commit tree mismatch');
    if (parents.length !== 1 || parents[0] !== run.baseSha) throw new Error('Verified commit must have exactly the recorded base as its single parent');
    if (authorName !== identity.author.name || authorEmail !== identity.author.email || committerName !== identity.committer.name || committerEmail !== identity.committer.email) throw new Error('Commit author or committer differs from the recorded publication identity');
    if (!body.split('\n').includes(signoff)) throw new Error('Commit is missing the recorded author signoff');
    signal?.throwIfAborted();
    checked(await this.git(run.worktree!, ['bundle', 'create', bundle, run.branch!], undefined, signal), 'Prepare publisher bundle');
    signal?.throwIfAborted(); run.verifiedCommit = commit;
    (run as Manifest & { commitProvenance?: CommitProvenance }).commitProvenance = { commit, tree, parents, author: { name: authorName, email: authorEmail }, committer: { name: committerName, email: committerEmail }, signoff };
  }
}
