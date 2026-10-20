import fs from 'node:fs/promises';
import path from 'node:path';
import { changedFiles, hash, inventory, safeRelative, sourcePath } from './files.ts';
import { assertOnlyNewRegressions, freezeRust, rustCanonical, rustTests, rustTestSupport, rustExternalTestModules, rustTestConfiguration } from './rust.ts';
import { regressionCheck } from './checks.ts';
import type { AcceptanceRequirement, Candidate, FrozenRegression, Regression } from './types.ts';
import { defaultProfile, inRoots } from './profile.ts';
import type { RepositoryProfile } from './profile.ts';

// Drafts are checked against the immutable baseline, so later edits may revise a newly added test
// while the implementation and pre-existing tests/helpers stay unchanged throughout reproduction.
export async function assertReproductionEdits(base: string, source: string, paths: string[], requirements: AcceptanceRequirement[], profile: RepositoryProfile = defaultProfile): Promise<void> {
  const integrationFiles = new Set(requirements.flatMap(requirement => {
    const target = requirement.target;
    return target?.kind === 'integration' ? profile.testRoots.map(root => `${root}/${target.name}.rs`) : [];
  }));
  for (const relative of new Set(paths)) {
    const beforeFile = await sourcePath(base, relative, true), afterFile = await sourcePath(source, relative, true);
    const before = await fs.readFile(beforeFile).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    const after = await fs.readFile(afterFile).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!after) throw new Error(`Reproduction cannot delete files: ${relative}`);
    if (before?.equals(after)) continue;
    if (!before && (relative.startsWith(profile.fixtureRoot + '/') || integrationFiles.has(relative))) continue;
    if (before && relative.endsWith('.rs') && inRoots(relative, profile.sourceRoots)) {
      const oldCode = before.toString('utf8'), newCode = after.toString('utf8');
      if (rustCanonical(oldCode) === rustCanonical(newCode)) continue; // Permit formatting without semantic changes.
      const oldNames = new Set(rustTests(oldCode).map(test => test.qualified));
      const additions = rustTests(newCode).filter(test => !oldNames.has(test.qualified)).map(test => test.qualified);
      if (!additions.length) throw new Error(`Reproduction may add only new tests and new fixtures; production, imports, helpers and pre-existing tests must remain unchanged until regression freeze. No new inline test was added in ${relative}`);
      assertOnlyNewRegressions(oldCode, newCode, additions, 'draft');
      continue;
    }
    throw new Error(`Reproduction may change only new inline tests, planned new integration targets and new fixtures; existing files remain unchanged: ${relative}`);
  }
}

// `testName` is the crate path cargo filters on (hooks::hook_cmd::tests::x); the source parser sees only the path
// inside `file` (tests::x). Cargo layout maps one to the other: the module path is the file path after the last
// `src/`, where lib.rs/main.rs are the crate root and mod.rs names its directory.
export function inFileTestName(spec: Pick<Regression, 'file' | 'testName' | 'target'>): string {
  if (spec.target?.kind === 'integration') return spec.testName;
  const segments = spec.file.replace(/\.rs$/, '').split('/'); const src = segments.lastIndexOf('src');
  if (src < 0) throw new Error(`Cannot derive the module path of ${spec.file}; regression files must live under a Cargo src/ directory`);
  const modules = segments.slice(src + 1);
  if (modules.at(-1) === 'mod' || (modules.length === 1 && ['lib', 'main'].includes(modules[0]))) modules.pop();
  const prefix = modules.length ? modules.join('::') + '::' : '';
  if (!spec.testName.startsWith(prefix) || !spec.testName.slice(prefix.length).includes('::')) throw new Error(`testName must be the crate path of a test inside a module of ${spec.file}, e.g. ${prefix}tests::name`);
  return spec.testName.slice(prefix.length);
}
export function scenarioList(input: Regression | Regression[]): Regression[] {
  const specs = Array.isArray(input) ? input : [input];
  if (!specs.length) throw new Error('At least one acceptance scenario is required');
  const ids = new Set<string>();
  return specs.map((spec, index) => {
    if (!spec || typeof spec !== 'object') throw new Error('Each scenario must be a regression object');
    const id = spec.id ?? `regression-${index + 1}`;
    if (typeof id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(id) || ids.has(id)) throw new Error('Scenario IDs must be valid and unique; duplicate or invalid ID');
    ids.add(id);
    if (typeof spec.expectedBehavior !== 'string' || spec.expectedBehavior.trim().length < 12) throw new Error('Reproduction needs a substantive expected behavior');
    if (typeof spec.citation !== 'string' || spec.citation.trim().length < 12) throw new Error('Reproduction needs an issue citation of at least 12 characters');
    if (spec.required !== undefined && typeof spec.required !== 'boolean') throw new Error('Scenario required must be a boolean');
    if (spec.baseline !== undefined && !['fail', 'pass'].includes(spec.baseline)) throw new Error('Scenario baseline must be fail or pass');
    if (!Array.isArray(spec.fixtures) || spec.fixtures.length > 5 || spec.fixtures.some(f => typeof f !== 'string') || new Set(spec.fixtures).size !== spec.fixtures.length) throw new Error('Invalid fixture list');
    const target = spec.target || { kind: 'unit' as const };
    if (target.kind !== 'unit' && target.kind !== 'integration') throw new Error('Scenario target must be unit or integration');
    return { ...spec, id, required: spec.required ?? true, baseline: spec.baseline || 'fail', target };
  });
}
export async function freezeRegressions(base: string, source: string, input: Regression | Regression[], profile: RepositoryProfile = defaultProfile): Promise<FrozenRegression[]> {
  const specs = scenarioList(input);
  const oldFiles = await inventory(base), newFiles = await inventory(source), changed = changedFiles(oldFiles, newFiles);
  const sources = new Map<string, string>(), groups = new Map<string, Regression[]>();
  for (const spec of specs) {
    if (!spec.file?.endsWith('.rs')) throw new Error('Regressions must use Rust source files');
    regressionCheck(spec, profile); // The same canonical target/file rules are used by execution and freezing.
    if (spec.target!.kind === 'unit' && !inRoots(spec.file, profile.sourceRoots)) throw new Error('Use a fully qualified new inline Rust test in a configured source root');
    if (spec.target!.kind === 'integration' && oldFiles[spec.file]) throw new Error('Integration regressions require a newly added test-root file; existing integration tests are frozen');
    const group = groups.get(spec.file) || []; group.push(spec); groups.set(spec.file, group);
  }
  for (const [file, group] of groups) {
    const after = await fs.readFile(await sourcePath(source, file), 'utf8'); sources.set(file, after);
    if (group.some(s => s.target!.kind !== group[0].target!.kind)) throw new Error('A regression file cannot mix Cargo target kinds');
    const names = group.map(inFileTestName);
    if (new Set(names).size !== names.length) throw new Error('Each scenario needs a distinct target test');
    if (group[0].target!.kind === 'unit') {
      const before = await fs.readFile(await sourcePath(base, file), 'utf8');
      assertOnlyNewRegressions(before, after, names);
    } else {
      // Imports and CLI assertion helpers are permitted inside a new integration file and frozen in full.
      for (const name of names) freezeRust(after, name, true);
    }
  }
  const allowed = new Set(specs.flatMap(spec => [spec.file, ...spec.fixtures]));
  if (changed.some(p => !allowed.has(p))) throw new Error('Reproduction modified implementation, existing fixtures, or unrelated files');
  const overlayHash = hash(JSON.stringify(changed.map(p => [p, newFiles[p]])));
  return Promise.all(specs.map(async spec => {
    const fixtureHashes: Record<string, string> = {}, fixtureInventory: Record<string, string> = {};
    for (const fixture of spec.fixtures) {
      if (!fixture.startsWith(profile.fixtureRoot + '/') || fixture in oldFiles) throw new Error('Regression fixtures must be new files under the configured fixture root');
      fixtureHashes[fixture] = hash(await fs.readFile(await sourcePath(source, fixture)));
      fixtureInventory[fixture] = newFiles[fixture];
    }
    const after = sources.get(spec.file)!;
    return { spec, ...freezeRust(after, inFileTestName(spec), spec.target!.kind === 'integration'), fixtureHashes, fixtureInventory, overlayHash, ...(spec.target!.kind === 'integration' ? { wholeFileHash: hash(after) } : {}) };
  }));
}
export async function freezeRegression(base: string, source: string, spec: Regression, profile: RepositoryProfile = defaultProfile): Promise<FrozenRegression> {
  return (await freezeRegressions(base, source, spec, profile))[0];
}
export async function assertFrozen(root: string, frozen: FrozenRegression) {
  const source = await fs.readFile(await sourcePath(root, frozen.spec.file), 'utf8');
  if (frozen.wholeFileHash && hash(source) !== frozen.wholeFileHash) throw new Error(`Frozen integration regression file changed: ${frozen.spec.file}`);
  const actual = freezeRust(source, inFileTestName(frozen.spec), !!frozen.wholeFileHash);
  if (actual.functionHash !== frozen.functionHash || actual.contextHash !== frozen.contextHash) throw new Error('Frozen regression or enclosing test configuration changed');
  for (const [relative, expected] of Object.entries(frozen.fixtureHashes)) {
    const file = await sourcePath(root, relative), actual = hash(await fs.readFile(file));
    if (actual !== expected) throw new Error(`Frozen fixture changed: ${relative}`);
    if (frozen.fixtureInventory?.[relative]) {
      const mode = (await fs.stat(file)).mode & 0o111 ? '100755' : '100644';
      if (`${mode}:${actual}` !== frozen.fixtureInventory[relative]) throw new Error(`Frozen fixture metadata changed: ${relative}`);
    }
  }
}
export async function assertFrozenRegressions(root: string, frozen: FrozenRegression[]) {
  if (!frozen.length) throw new Error('At least one frozen scenario is required');
  for (const regression of frozen) await assertFrozen(root, regression);
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
async function externalTestFiles(root: string, files: Record<string, string>, profile: RepositoryProfile): Promise<Set<string>> {
  const protectedFiles = new Set<string>(), inspected = new Set<string>();
  const integrationDirectory = path.posix.join(path.posix.dirname(profile.manifest), 'tests');
  const queue = Object.keys(files).filter(file => file.endsWith('.rs') && inRoots(file, [...profile.sourceRoots, ...profile.testRoots])).map(file => ({
    file, inherited: inRoots(file, profile.testRoots),
    // Both shipped Cargo profiles use automatic tests/<target>.rs crate roots.
    crateRoot: inRoots(file, profile.testRoots) && path.posix.dirname(file) === integrationDirectory,
  }));
  while (queue.length) {
    const { file, inherited, crateRoot } = queue.shift()!;
    // A direct test file may also be loaded as an ordinary module by another target.
    const key = `${inherited}:${crateRoot}:${file}`; if (inspected.has(key)) continue; inspected.add(key);
    const code = await fs.readFile(await sourcePath(root, file), 'utf8');
    for (const declaration of rustExternalTestModules(code, inherited)) {
      const directory = path.posix.dirname(file), stem = path.posix.basename(file, '.rs');
      const moduleDirectory = crateRoot || ['lib', 'main', 'mod'].includes(stem) ? directory : `${directory}/${stem}`;
      const parent = declaration.modules.join('/');
      if (declaration.path && path.posix.isAbsolute(declaration.path)) throw new Error(`External test module path must remain repository-relative: ${file}`);
      const candidates = declaration.path
        ? [path.posix.join(directory, parent, declaration.path), path.posix.join(moduleDirectory, parent, declaration.path)]
        : [path.posix.join(moduleDirectory, parent, `${declaration.name}.rs`), path.posix.join(moduleDirectory, parent, declaration.name, 'mod.rs')];
      const matches = [...new Set(candidates)].filter(candidate => { safeRelative(candidate); return !!files[candidate]; });
      if (!matches.length) throw new Error(`Unresolved external test-only module requires review: ${file}::${[...declaration.modules, declaration.name].join('::')}`);
      for (const candidate of matches) { protectedFiles.add(candidate); queue.push({ file: candidate, inherited: true, crateRoot: false }); }
    }
  }
  return protectedFiles;
}
export async function assertCandidate(base: string, source: string, frozen: FrozenRegression | FrozenRegression[], candidate: Candidate, profile: RepositoryProfile = defaultProfile) {
  await assertFrozenRegressions(source, Array.isArray(frozen) ? frozen : [frozen]);
  const before = await inventory(base), after = await inventory(source); const changed = changedFiles(before, after);
  if (!changed.length || changed.length > profile.maxChangedFiles) throw new Error(`Candidate must change 1–${profile.maxChangedFiles} approved files including the regression`);
  const production = changed.filter(p => inRoots(p, profile.sourceRoots));
  if (production.length > profile.maxSourceFiles) throw new Error(`Candidate exceeds the ${profile.maxSourceFiles} source-file scope`);
  const skipOwners = (profile as RepositoryProfile & { skipTestOwners?: Record<string, string[]> }).skipTestOwners || {};
  for (const name of Object.keys(profile.skipTests || {})) {
    const owners = skipOwners[name] || [];
    if (owners.some(owner => production.some(file => file === owner || file.startsWith(owner + '/')))) throw new Error(`Relevant check remains skipped: ${name}; changed owning source requires a validated alternative before a complete verdict`);
  }
  const supportFiles = await externalTestFiles(base, before, profile);
  const updates = candidate.snapshots || [];
  for (const update of updates) {
    if (!changed.includes(update.path) || !production.includes(update.owner) || update.reason.trim().length < 15) throw new Error('Snapshot updates need a changed owning source module and a substantive explanation');
  }
  for (const relative of changed) {
    if (!inRoots(relative, [...profile.sourceRoots, ...profile.testRoots]) || !after[relative]) throw new Error(`Disallowed change or deletion: ${relative}`);
    if (supportFiles.has(relative)) throw new Error(`External test-only support file cannot change: ${relative}`);
    if (before[relative] && inRoots(relative, profile.testRoots) && !/\.(snap|snap\.json)$/.test(relative)) throw new Error(`Existing test-root file cannot change: ${relative}`);
    if (relative.endsWith('.rs') && before[relative]) {
      const oldCode = await fs.readFile(path.join(base, relative), 'utf8'), newCode = await fs.readFile(path.join(source, relative), 'utf8');
      if (rustTestConfiguration(oldCode) !== rustTestConfiguration(newCode)) throw new Error(`Existing test-only configuration changed or a test-only implementation shortcut was added: ${relative}`);
      if (rustTestSupport(oldCode) !== rustTestSupport(newCode)) throw new Error(`Existing test-only support or unsupported test syntax changed: ${relative}`);
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
    } else if (!before[relative] && relative.endsWith('.rs') && inRoots(relative, profile.sourceRoots)) {
      const code = await fs.readFile(await sourcePath(source, relative), 'utf8');
      if (rustTestConfiguration(code) !== '[]' || rustTestSupport(code) !== '[]') throw new Error(`New source contains test-only configuration or unsupported test syntax: ${relative}`);
    } else if (before[relative] && /\.(snap|snap\.json)$/.test(relative)) {
      if (!updates.some(u => u.path === relative)) throw new Error(`Snapshot requires review explanation: ${relative}`);
    } else if (before[relative] && inRoots(relative, profile.testRoots) && !relative.endsWith('.rs')) throw new Error(`Existing fixture changes are outside the first MVP: ${relative}`);
  }
  if (!candidate.explanation || !Array.isArray(candidate.evidenceIds) || candidate.evidenceIds.length < 2) throw new Error('Candidate requires a source/test evidence explanation');
  return changed;
}
