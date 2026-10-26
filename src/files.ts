import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function safeRelative(value: string): string {
  if (!value || value.length > 500 || value.includes('\\') || /[\x00-\x1f]/.test(value) || path.posix.isAbsolute(value)) throw new Error('Invalid relative path: use a repository-relative path such as src/lib.rs. Use a dot only for search_text directory listing. Absolute paths including /agent and /workspace are not source paths.');
  const parts = value.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || p === '.git') || parts[0] === 'target') throw new Error('Path is outside source policy');
  return value;
}
export async function sourcePath(root: string, relative: string, allowMissing = false): Promise<string> {
  safeRelative(relative); const destination = path.join(root, relative);
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch(e => { if (allowMissing && e.code === 'ENOENT') return null; throw e; });
    if (stat?.isSymbolicLink()) throw new Error(`Symlinks are not permitted: ${relative}`);
  }
  return destination;
}
export async function inventory(root: string, signal?: AbortSignal): Promise<Record<string, string>> {
  const output: Record<string, string> = {};
  async function visit(dir: string, prefix: string) {
    signal?.throwIfAborted();
    for (const ent of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      signal?.throwIfAborted();
      if (ent.name === '.git' || ent.name === 'target' || ent.name === 'graphify-out') continue;
      const rel = prefix + ent.name; safeRelative(rel);
      if (ent.isSymbolicLink()) throw new Error(`Source symlink is unsupported: ${rel}`);
      if (ent.isDirectory()) await visit(path.join(dir, ent.name), rel + '/');
      else if (ent.isFile()) { const file = path.join(dir, ent.name); const stat = await fs.stat(file); output[rel] = `${stat.mode & 0o111 ? '100755' : '100644'}:${hash(await fs.readFile(file))}`; }
      else throw new Error(`Unsupported source entry: ${rel}`);
    }
  }
  await visit(root, ''); return output;
}
export const fingerprint = (entries: Record<string, string>) => hash(JSON.stringify(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))));
export async function copySource(from: string, to: string, signal?: AbortSignal) {
  await inventory(from, signal); signal?.throwIfAborted(); await fs.mkdir(to, { recursive: true });
  await fs.cp(from, to, { recursive: true, filter: source => { signal?.throwIfAborted(); return !['.git', 'target', 'graphify-out'].includes(path.basename(source)); } }); signal?.throwIfAborted();
}
export function changedFiles(before: Record<string, string>, after: Record<string, string>) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(p => before[p] !== after[p]).sort();
}
export interface Edit { path: string; before: string; after: string; }
// Parses an edits array a model sent JSON-encoded as a string. Models sometimes close the last object with ']' or ')'
// instead of '}', or drop the closers. Only what follows the final string value can follow it in a valid array, so that
// tail is replaced with '}]'; every edit is still applied as an exact unique replacement.
export function parseEdits(text: string): unknown {
  const raw = text.trim(); let first: unknown;
  for (const candidate of [raw, raw.replace(/"[^"]*$/, '"}]')]) {
    try { return JSON.parse(candidate); } catch (e) { first ??= e; }
  }
  throw new Error(`edits was sent as a string that is not valid JSON (${first instanceof Error ? first.message : String(first)}); pass edits as an array of {path, before, after} objects`);
}
export async function applyEdits(root: string, edits: Edit[], allowedRoots = ['src', 'tests']) {
  if (!Array.isArray(edits) || edits.length < 1 || edits.length > 8) throw new Error('Supply 1–8 exact replacements');
  const staged = new Map<string, string>();
  for (const edit of edits) {
    if (typeof edit.before !== 'string' || typeof edit.after !== 'string' || edit.after.length > 1_000_000) throw new Error('Invalid replacement');
    if (!allowedRoots.some(root => safeRelative(edit.path).startsWith(root + '/'))) throw new Error('Edit is outside the configured source/test roots');
    const file = await sourcePath(root, edit.path, true);
    let content = staged.get(edit.path) ?? await fs.readFile(file, 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (content === null) { if (edit.before !== '') throw new Error('New files require empty before'); content = edit.after; }
    else {
      if (!edit.before || content.split(edit.before).length !== 2) throw new Error(`Replacement must match exactly once: ${edit.path}`);
      content = content.replace(edit.before, () => edit.after);
    }
    staged.set(edit.path, content);
  }
  for (const [relative, content] of staged) { const file = await sourcePath(root, relative, true); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); }
}
