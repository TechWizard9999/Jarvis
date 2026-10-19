import fs from 'node:fs/promises';
import path from 'node:path';
import { changedFiles, hash, inventory, sourcePath } from './files.ts';
import { assertOnlyNewRegression, extractTest, freezeRust, rustTests } from './rust.ts';
import type { Candidate, FrozenRegression, Regression } from './types.ts';
import { defaultProfile, inRoots } from './profile.ts';
import type { RepositoryProfile } from './profile.ts';

// `testName` is the crate path cargo filters on (hooks::hook_cmd::tests::x); the source parser sees only the path
// inside `file` (tests::x). Cargo layout maps one to the other: the module path is the file path after the last
// `src/`, where lib.rs/main.rs are the crate root and mod.rs names its directory.
export function inFileTestName(spec: Pick<Regression, 'file' | 'testName'>): string {
  const segments = spec.file.replace(/\.rs$/, '').split('/'); const src = segments.lastIndexOf('src');
  if (src < 0) throw new Error(`Cannot derive the module path of ${spec.file}; regression files must live under a Cargo src/ directory`);
  const modules = segments.slice(src + 1);
  if (modules.at(-1) === 'mod' || (modules.length === 1 && ['lib', 'main'].includes(modules[0]))) modules.pop();
  const prefix = modules.length ? modules.join('::') + '::' : '';
  if (!spec.testName.startsWith(prefix) || !spec.testName.slice(prefix.length).includes('::')) throw new Error(`testName must be the crate path of a test inside a module of ${spec.file}, e.g. ${prefix}tests::name`);
  return spec.testName.slice(prefix.length);
}
export async function freezeRegression(base: string, source: string, spec: Regression, profile: RepositoryProfile = defaultProfile): Promise<FrozenRegression> {
  if (!spec || !inRoots(spec.file, profile.sourceRoots) || !spec.file.endsWith('.rs') || !/^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)+$/.test(spec.testName)) throw new Error('Use a fully qualified new inline Rust test in a configured source root');
  // failureContains and citation are advisory: the controller adopts the observed assertion message and flags an unverified citation.
  if (!spec.expectedBehavior) throw new Error('Reproduction needs the expected behavior');
  if (!Array.isArray(spec.fixtures) || spec.fixtures.length > 5) throw new Error('Invalid fixture list');
  const local = inFileTestName(spec);
  const before = await fs.readFile(await sourcePath(base, spec.file), 'utf8');
  const after = await fs.readFile(await sourcePath(source, spec.file), 'utf8');
  assertOnlyNewRegression(before, after, local);
  const oldFiles = await inventory(base), newFiles = await inventory(source);
  const fixtureHashes: Record<string, string> = {};
  for (const fixture of spec.fixtures) {
    if (!fixture.startsWith(profile.fixtureRoot + '/') || fixture in oldFiles) throw new Error('Regression fixtures must be new files under the configured fixture root');
    fixtureHashes[fixture] = hash(await fs.readFile(await sourcePath(source, fixture)));
  }
  const allowed = new Set([spec.file, ...spec.fixtures]);
  if (changedFiles(oldFiles, newFiles).some(p => !allowed.has(p))) throw new Error('Reproduction modified implementation, existing fixtures, or unrelated files');
  return { spec, ...freezeRust(after, local), fixtureHashes, overlayHash: hash(JSON.stringify(changedFiles(oldFiles, newFiles).map(p => [p, newFiles[p]]))) };
}
export async function assertFrozen(root: string, frozen: FrozenRegression) {
  const source = await fs.readFile(await sourcePath(root, frozen.spec.file), 'utf8');
  const actual = freezeRust(source, inFileTestName(frozen.spec));
  if (actual.functionHash !== frozen.functionHash || actual.contextHash !== frozen.contextHash) throw new Error('Frozen regression or enclosing test configuration changed');
  for (const [relative, expected] of Object.entries(frozen.fixtureHashes)) if (hash(await fs.readFile(await sourcePath(root, relative))) !== expected) throw new Error(`Frozen fixture changed: ${relative}`);
}
export function reproductionFailure(output: string, testName: string, failureContains: string): boolean {
  return output.includes(`test ${testName} ... FAILED`) && /test result: FAILED\. 0 passed; 1 failed; 0 ignored;/.test(output)
    && output.includes(failureContains) && !/could not compile|error\[E\d+\]|failed to (?:download|resolve|get)|No such file or directory/i.test(output);
}
// The message of the assertion that failed the named test, or null for compile/setup failures and zero-test matches.
export function failedAssertion(output: string, testName: string): string | null {
  if (!output.includes(`test ${testName} ... FAILED`) || !/test result: FAILED\. 0 passed; 1 failed; 0 ignored;/.test(output) || /could not compile|error\[E\d+\]|failed to (?:download|resolve|get)|No such file or directory/i.test(output)) return null;
  return /panicked at [^\n]*:\n([^\n]+)/.exec(output)?.[1].trim() || null;
}
export function regressionPassed(output: string, testName: string): boolean {
  return output.includes(`test ${testName} ... ok`) && /test result: ok\. 1 passed; 0 failed; 0 ignored;/.test(output);
}
export async function assertCandidate(base: string, source: string, frozen: FrozenRegression, candidate: Candidate, profile: RepositoryProfile = defaultProfile) {
  await assertFrozen(source, frozen);
  const before = await inventory(base), after = await inventory(source); const changed = changedFiles(before, after);
  if (!changed.length || changed.length > profile.maxChangedFiles) throw new Error(`Candidate must change 1–${profile.maxChangedFiles} approved files including the regression`);
  const production = changed.filter(p => inRoots(p, profile.sourceRoots));
  if (production.length > profile.maxSourceFiles) throw new Error(`Candidate exceeds the ${profile.maxSourceFiles} source-file scope`);
  const updates = candidate.snapshots || [];
  for (const update of updates) {
    if (!changed.includes(update.path) || !production.includes(update.owner) || update.reason.trim().length < 15) throw new Error('Snapshot updates need a changed owning source module and a substantive explanation');
  }
  for (const relative of changed) {
    if (!inRoots(relative, [...profile.sourceRoots, ...profile.testRoots]) || !after[relative]) throw new Error(`Disallowed change or deletion: ${relative}`);
    if (relative.endsWith('.rs') && before[relative]) {
      const oldCode = await fs.readFile(path.join(base, relative), 'utf8'), newCode = await fs.readFile(path.join(source, relative), 'utf8');
      const oldTests = rustTests(oldCode), newTests = rustTests(newCode);
      for (const oldTest of oldTests) {
        const replacement = newTests.find(t => t.qualified === oldTest.qualified);
        if (!replacement || replacement.attributes !== oldTest.attributes || replacement.context !== oldTest.context) throw new Error(`Existing test deleted or disabled: ${oldTest.qualified}`);
        // Existing inline snapshots may only change their expected string literal, with an explicit review flag.
        if (oldTest.canonical !== replacement.canonical) {
          const flagged = updates.some(u => u.path === relative && u.owner === relative);
          const oldTokens = JSON.parse(oldTest.canonical) as string[], newTokens = JSON.parse(replacement.canonical) as string[];
          const differences = oldTokens.map((t, i) => t !== newTokens[i] ? i : -1).filter(i => i >= 0);
          if (!flagged || oldTokens.length !== newTokens.length || differences.length !== 1 || !oldTokens.includes('assert_snapshot')
            || oldTokens[differences[0] - 1] !== '@' || !/^r?#*"/.test(oldTokens[differences[0]]) || !/^r?#*"/.test(newTokens[differences[0]])) throw new Error(`Existing test changed outside the supported inline snapshot policy: ${oldTest.qualified}`);
        }
      }
    } else if (before[relative] && /\.(snap|snap\.json)$/.test(relative)) {
      if (!updates.some(u => u.path === relative)) throw new Error(`Snapshot requires review explanation: ${relative}`);
    } else if (before[relative] && inRoots(relative, profile.testRoots) && !relative.endsWith('.rs')) throw new Error(`Existing fixture changes are outside the first MVP: ${relative}`);
  }
  if (!candidate.explanation || !Array.isArray(candidate.evidenceIds) || candidate.evidenceIds.length < 2) throw new Error('Candidate requires a source/test evidence explanation');
  return changed;
}
