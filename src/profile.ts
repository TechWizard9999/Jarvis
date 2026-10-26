import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { safeRelative } from './files.ts';
export interface RepositoryProfile {
  id: string; adapter: 'cargo-rust'; upstream: string; baseBranch: string; packageName: string; manifest: string;
  sourceRoots: string[]; testRoots: string[]; fixtureRoot: string; maxChangedFiles: number; maxSourceFiles: number;
  focusedTestPrefix: string[]; fastCheckIds: string[]; checks: Record<string, string[]>;
  // Upstream tests that cannot run against the read-only source mount, each with a recorded reason; reported, never silent.
  skipTests?: Record<string, string>;
  // Repository testing conventions given to the agent (like a CLAUDE.md); trusted local configuration.
  agentNotes?: string[];
  skipTestOwners?: Record<string, string[]>;
}
const rustPath = /^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*$/;
// Appends `--skip NAME` filters (full test paths) to a `cargo test` argv, adding the `--` separator when absent.
export function withSkips(argv: string[], skips: string[]): string[] {
  if (!skips.length || argv[0] !== 'cargo' || argv[1] !== 'test') return argv;
  return [...argv, ...(argv.includes('--') ? [] : ['--']), ...skips.flatMap(name => ['--skip', name])];
}
export const defaultProfilePath = fileURLToPath(new URL('../profiles/rtk.json', import.meta.url));
export const inRoots = (relative: string, roots: string[]) => roots.some(root => relative.startsWith(root + '/'));
export function loadProfile(file = defaultProfilePath): RepositoryProfile {
  const p = JSON.parse(readFileSync(file, 'utf8')) as RepositoryProfile;
  if (!p || p.adapter !== 'cargo-rust') throw new Error('Unsupported language adapter; this release implements cargo-rust');
  if (!/^[a-z0-9-]+$/.test(p.id) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(p.upstream)) throw new Error('Invalid repository profile identity');
  if (!/^[A-Za-z0-9_./-]+$/.test(p.baseBranch) || p.baseBranch.includes('..') || p.baseBranch.startsWith('-') || !/^[A-Za-z0-9_-]+$/.test(p.packageName)) throw new Error('Invalid branch or package name');
  for (const roots of [p.sourceRoots, p.testRoots]) { if (!Array.isArray(roots) || !roots.length) throw new Error('Profile requires source/test roots'); roots.forEach(safeRelative); }
  safeRelative(p.manifest); safeRelative(p.fixtureRoot);
  if (!inRoots(p.fixtureRoot + '/fixture', p.testRoots)) throw new Error('Fixture root must be inside an approved test root');
  if (![p.maxChangedFiles, p.maxSourceFiles].every(n => Number.isSafeInteger(n) && n > 0 && n <= 100)) throw new Error('Invalid profile change limits');
  const argv = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every(v => typeof v === 'string' && !v.includes('\0'));
  if (!argv(p.focusedTestPrefix) || !p.checks || !Object.keys(p.checks).length || !Object.values(p.checks).every(argv)) throw new Error('Check commands must be nonempty argument arrays');
  if (!Object.keys(p.checks).every(id => /^[a-z][a-z0-9-]{0,60}$/.test(id))) throw new Error('Invalid check identifier');
  if (!p.fastCheckIds?.every(id => !!p.checks[id])) throw new Error('Fast checks must reference configured check IDs');
  if (p.agentNotes !== undefined && (!Array.isArray(p.agentNotes) || p.agentNotes.length > 20 || !p.agentNotes.every(n => typeof n === 'string' && n.length > 0 && n.length <= 1000))) throw new Error('agentNotes must be up to 20 non-empty strings');
  const skips = Object.entries(p.skipTests || {});
  if (!skips.every(([name, reason]) => rustPath.test(name) && name.includes('::') && typeof reason === 'string' && reason.trim().length >= 10)) throw new Error('skipTests entries must be qualified Rust test paths with a written reason');
  for (const [name, owners] of Object.entries(p.skipTestOwners || {})) { if (!p.skipTests?.[name] || !Array.isArray(owners) || !owners.length) throw new Error('Skipped test owners must reference a declared skip'); owners.forEach(safeRelative); }
  p.checks = Object.fromEntries(Object.entries(p.checks).map(([id, argv]) => [id, withSkips(argv, skips.map(([name]) => name))]));
  return p;
}
export const defaultProfile = loadProfile();
