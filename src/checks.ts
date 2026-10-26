import { defaultProfile, withSkips } from './profile.ts';
import type { RepositoryProfile } from './profile.ts';
import { safeRelative } from './files.ts';
import type { CheckSummary, Regression, RegressionTarget } from './types.ts';
export const fullChecks = defaultProfile.checks;
export function focusedCheck(name: string, test: string, profile: RepositoryProfile = defaultProfile): string[] {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*$/.test(test) || name === 'test-focused' && !test.includes('::')) throw new Error('Use a qualified Rust test/module name');
  if (name === 'test-focused') return [...profile.focusedTestPrefix, test, '--', '--exact', '--nocapture', '--test-threads=1'];
  if (name === 'test-module') return withSkips([...profile.focusedTestPrefix, `${test}::`, '--', '--test-threads=1'], Object.keys(profile.skipTests || {}));
  throw new Error('Unknown focused check');
}
export function fastChecks(test: string, profile: RepositoryProfile = defaultProfile): [string, string[]][] {
  return [ ...profile.fastCheckIds.map((id): [string, string[]] => [id, profile.checks[id]]), ['test-focused', focusedCheck('test-focused', test, profile)], ['test-module', focusedCheck('test-module', test.split('::').slice(0, -1).join('::'), profile)] ];
}

function targetPrefix(target: RegressionTarget = { kind: 'unit' }, profile: RepositoryProfile): string[] {
  if (target.kind !== 'unit' && target.kind !== 'integration') throw new Error('Use a unit or integration Cargo target');
  if (target.kind === 'unit') return [...profile.focusedTestPrefix];
  if (typeof target.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(target.name)) throw new Error('Use a canonical integration target name');
  // Preserve trusted profile flags while replacing the library selector with one named integration target.
  const prefix = profile.focusedTestPrefix.filter(arg => arg !== '--lib');
  if (prefix[0] !== 'cargo' || prefix[1] !== 'test' || prefix.includes('--') || prefix.some(arg => ['--test', '--tests', '--bin', '--bins', '--all-targets', '--example', '--examples', '--bench', '--benches'].includes(arg))) throw new Error('Profile focused prefix must select only the library Cargo target');
  if (!prefix.includes('--locked') || !prefix.includes('--offline')) throw new Error('Cargo regressions require locked offline execution');
  return [...prefix, '--test', target.name];
}
export function regressionCheck(spec: Regression, profile: RepositoryProfile = defaultProfile): string[] {
  const target = spec.target || { kind: 'unit' };
  if (target.kind === 'unit') return focusedCheck('test-focused', spec.testName, profile);
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*$/.test(spec.testName)) throw new Error('Use a canonical integration test name');
  const file = safeRelative(spec.file);
  if (!profile.testRoots.some(root => file === `${root}/${target.name}.rs`)) throw new Error('Integration target name must match its test-root file');
  return [...targetPrefix(target, profile), spec.testName, '--', '--exact', '--nocapture', '--test-threads=1'];
}
export function listTestsCheck(target: RegressionTarget = { kind: 'unit' }, profile: RepositoryProfile = defaultProfile): string[] {
  return [...targetPrefix(target, profile), '--', '--list', '--format=terse'];
}
export function integrationTargetCheck(name: string, profile: RepositoryProfile = defaultProfile): string[] {
  return [...targetPrefix({ kind: 'integration', name }, profile), '--', '--nocapture', '--test-threads=1'];
}
export function parseListedTests(output: string): string[] {
  return [...new Set(output.split(/\r?\n/).flatMap(line => /^([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*): test$/.exec(line)?.[1] || []))];
}
export function discoverTests(output: string, query = '') {
  if (typeof query !== 'string' || query.length > 200) throw new Error('Use a test-name substring of at most 200 characters');
  const all=parseListedTests(output), matching=all.filter(name=>name.includes(query));
  return {listedTests:matching.slice(0,200),totalListed:all.length,matchedListed:matching.length,truncated:matching.length>200};
}
export function formatCheck(profile: RepositoryProfile = defaultProfile): string[] {
  return ['cargo', 'fmt', '--manifest-path', safeRelative(profile.manifest), '--all'];
}
export function summarizeCheck(output: string, exitCode: number, timedOut: boolean, argv: string[] = []): CheckSummary {
  const summaries = [...output.matchAll(/test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;/g)];
  const isTest = !argv.includes('--list') && (argv[0] === 'cargo' && argv[1] === 'test' || summaries.length > 0);
  const counts = isTest ? { matched: 0, passed: 0, failed: 0, ignored: 0 } : undefined;
  for (const summary of summaries) {
    counts!.passed += Number(summary[1]); counts!.failed += Number(summary[2]); counts!.ignored += Number(summary[3]);
  }
  if (counts) counts.matched = counts.passed + counts.failed + counts.ignored;
  const status = timedOut ? 'timed_out' : exitCode !== 0 || (counts?.failed || 0) > 0 ? 'failed' : counts && counts.passed + counts.failed === 0 ? 'no_match' : 'passed';
  return { status, ...counts };
}

/** Cargo's artifact identity keeps equal libtest names in different targets separate. */
export interface CargoTestArtifact { packageId: string; name: string; kind: 'lib' | 'bin' | 'test' | 'example' | 'bench'; source: string; doctest: boolean; }
interface AdmissionCargo { options: string[]; filters: string[]; harness: string[]; docs: boolean; }
const cargoValues = new Set(['-p', '--package', '--exclude', '--test', '--bin', '--example', '--bench', '--manifest-path', '--target', '--target-dir', '--features', '-F', '--profile', '--jobs', '-j', '--color', '--config']);
const targetValues = new Set(['-p', '--package', '--exclude', '--test', '--bin', '--example', '--bench']);
const targetFlags = new Set(['--workspace', '--all', '--lib', '--bins', '--tests', '--examples', '--benches', '--all-targets', '--doc']);
function admissionCargo(argv: string[]): AdmissionCargo {
  if (argv[0] !== 'cargo' || argv[1] !== 'test') throw new Error('Admission projection requires cargo test');
  const separator = argv.indexOf('--'), cargo = argv.slice(2, separator < 0 ? undefined : separator), harness = separator < 0 ? [] : argv.slice(separator + 1);
  const options: string[] = [], filters: string[] = []; let selected = false;
  for (let i = 0; i < cargo.length; i++) {
    const arg = cargo[i], flag = arg.split('=')[0];
    if (['--no-run', '--message-format', '--list'].includes(flag)) throw new Error(`Unsupported admission Cargo option: ${flag}`);
    if (cargoValues.has(flag)) { options.push(arg); if (!arg.includes('=')) { if (!cargo[i + 1] || cargo[i + 1].startsWith('-')) throw new Error(`Missing Cargo option value: ${arg}`); options.push(cargo[++i]); } }
    else if (arg.startsWith('-')) options.push(arg);
    else filters.push(arg);
    if (targetFlags.has(flag) && !['--workspace', '--all'].includes(flag) || ['--test', '--bin', '--example', '--bench'].includes(flag)) selected = true;
  }
  return { options, filters, harness, docs: !selected || cargo.includes('--doc') };
}
export function cargoAdmissionBuild(argv: string[]): string[] { const p = admissionCargo(argv); return ['cargo', 'test', ...p.options.filter(arg => arg !== '--doc'), '--no-run', '--message-format=json']; }
export function cargoAdmissionDocs(argv: string[], target: CargoTestArtifact): string[] | undefined {
  const p = admissionCargo(argv);
  if (p.options.includes('--doc')) return [...argv]; // Preserve an explicitly requested trusted check.
  if (!p.docs || target.kind !== 'lib' || !target.doctest) return;
  // Explicit --doc overrides Cargo.toml doctest=false. Reconstruct only the library packages whose
  // artifact metadata says ordinary cargo test would actually run doctests.
  return [...admissionTarget(argv, target).filter(arg => arg !== '--lib'), '--doc', ...p.filters, ...(p.harness.length ? ['--', ...p.harness] : [])];
}
export function parseCargoTestArtifacts(output: string): CargoTestArtifact[] {
  const found = new Map<string, CargoTestArtifact>();
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    let message: any; try { message = JSON.parse(line); } catch { throw new Error('Malformed Cargo artifact discovery output'); }
    if (message.reason !== 'compiler-artifact' || !message.executable || !message.profile?.test) continue;
    const { package_id: packageId, target } = message;
    const kind = target?.kind?.find((kind: string) => ['lib', 'bin', 'test', 'example', 'bench'].includes(kind));
    if (kind === 'lib' && typeof target.doctest !== 'boolean') throw new Error('Cargo library artifact lacks doctest selection metadata');
    if (typeof packageId !== 'string' || !packageId || !kind || typeof target.name !== 'string' || !target.name || typeof target.src_path !== 'string' || !target.src_path.startsWith('/workspace/')) throw new Error('Cargo test artifact lacks a canonical workspace package/target identity');
    const artifact: CargoTestArtifact = { packageId, name: target.name, kind, source: safeRelative(target.src_path.slice('/workspace/'.length)), doctest: target.doctest === true };
    found.set(JSON.stringify(artifact), artifact);
  }
  if (!found.size) throw new Error('Cargo discovery produced no test artifacts; compile/setup failures and no matches cannot admit reproduction');
  return [...found.values()];
}
function admissionTarget(argv: string[], target: CargoTestArtifact): string[] {
  const p = admissionCargo(argv), options: string[] = [];
  for (let i = 0; i < p.options.length; i++) {
    const arg = p.options[i], flag = arg.split('=')[0];
    if (targetValues.has(flag)) { if (!arg.includes('=')) i++; continue; }
    if (!targetFlags.has(flag)) options.push(arg);
  }
  return ['cargo', 'test', ...options, '--package', target.packageId, ...(target.kind === 'lib' ? ['--lib'] : [`--${target.kind}`, target.name])];
}
export function cargoAdmissionList(argv: string[], target: CargoTestArtifact): string[] {
  const p = admissionCargo(argv), harness: string[] = [];
  for (let i = 0; i < p.harness.length; i++) {
    const arg = p.harness[i];
    if (arg === '--format') { i++; continue; }
    if (!arg.startsWith('--format=') && !['--list', '--quiet', '-q'].includes(arg)) harness.push(arg);
  }
  // Pretty discovery includes an explicit total, allowing admission to reject truncated or non-libtest output.
  return [...admissionTarget(argv, target), '--', ...p.filters, ...harness, '--list', '--format=pretty'];
}
export function parseAdmissionTests(output: string): string[] {
  const names = output.split(/\r?\n/).flatMap(line => /^([^\r\n]+): (?:test|benchmark)$/.exec(line)?.[1] || []);
  const summaries = [...output.matchAll(/^(\d+) tests?, (\d+) benchmarks?\s*$/gm)];
  if (summaries.length !== 1 || Number(summaries[0][1]) + Number(summaries[0][2]) !== names.length || new Set(names).size !== names.length) throw new Error('Incomplete or unsupported Cargo test catalog; a full named libtest listing with its total is required');
  return names;
}
export function cargoAdmissionRun(argv: string[], target: CargoTestArtifact, names: string[]): string[] {
  if (!names.length || new Set(names).size !== names.length || names.some(name => !name || name.startsWith('-') || /[\x00-\x1f\x7f]/.test(name))) throw new Error('Admission requires a nonempty canonical exact test allowlist');
  const { harness } = admissionCargo(argv), retained: string[] = [];
  // Original inclusion/skip filters have already been applied by libtest listing. Project the resulting names,
  // so adding --exact cannot broaden an existing substring filter or skip a neighbouring control.
  const valueFlags = new Set(['--skip', '--format', '--color', '--test-threads', '--logfile']);
  for (let i = 0; i < harness.length; i++) {
    const arg = harness[i], flag = arg.split('=')[0];
    if (valueFlags.has(flag)) { const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : harness[++i]; if (!['--skip', '--format'].includes(flag)) retained.push(`${flag}=${value}`); }
    else if (arg.startsWith('-') && !['--exact', '--list', '--quiet', '-q'].includes(arg)) retained.push(arg);
  }
  return [...admissionTarget(argv, target), '--', ...retained, '--exact', ...names];
}
export function artifactMatchesScenario(target: CargoTestArtifact, spec: Regression, profile: RepositoryProfile): boolean {
  if (spec.target?.kind === 'integration') return target.kind === 'test' && target.name === spec.target.name && target.source === spec.file;
  const packageName = /#([^#@/]+)(?:@[^#]+)?$/.exec(target.packageId)?.[1] || target.packageId.split(' ')[0];
  return target.kind === 'lib' && packageName === profile.packageName;
}

/** Inspect manifest-declared targets that cargo test --no-run can omit entirely. */
export function cargoAdmissionMetadata(argv: string[]): string[] | undefined {
  const p = admissionCargo(argv); if (!p.docs || p.options.includes('--doc')) return;
  const values = new Set(['--manifest-path', '--config', '--features', '-F']), flags = new Set(['--all-features', '--no-default-features', '--locked', '--offline', '--frozen']);
  const options: string[] = [];
  for (let i = 0; i < p.options.length; i++) {
    const arg = p.options[i], flag = arg.split('=')[0];
    if (cargoValues.has(flag)) {
      const value = arg.includes('=') ? undefined : p.options[++i];
      if (values.has(flag)) options.push(arg, ...(value === undefined ? [] : [value]));
    } else if (flags.has(flag)) options.push(arg);
  }
  if (!options.includes('--locked') && !options.includes('--frozen')) options.push('--locked');
  if (!options.includes('--offline') && !options.includes('--frozen')) options.push('--offline');
  return ['cargo', 'metadata', ...options, '--no-deps', '--format-version=1'];
}
export function assertAdmissionDocTargets(output: string, artifacts: CargoTestArtifact[]): void {
  let metadata: any;
  try { metadata = JSON.parse(output.split(/\r?\n/).find(line => line.startsWith('{')) || ''); } catch { throw new Error('Admission requires complete Cargo workspace target metadata for default doctest selection'); }
  if (!Array.isArray(metadata.workspace_members) || !metadata.workspace_members.every((id: unknown) => typeof id === 'string') || !Array.isArray(metadata.packages)) throw new Error('Admission Cargo metadata lacks workspace member/target selection');
  const members = new Set(metadata.workspace_members);
  for (const pkg of metadata.packages) {
    if (!members.has(pkg.id)) continue;
    if (!Array.isArray(pkg.targets)) throw new Error('Admission Cargo workspace package lacks target metadata');
    for (const target of pkg.targets) {
      if (!Array.isArray(target.kind)) throw new Error('Admission Cargo target lacks its canonical kind');
      if (!target.kind.some((kind: string) => ['lib', 'rlib', 'dylib', 'staticlib', 'cdylib', 'proc-macro'].includes(kind))) continue;
      if (typeof target.doctest !== 'boolean' || typeof target.test !== 'boolean') throw new Error('Admission Cargo library target lacks test/doctest selection metadata');
      if (target.doctest && !target.test && !artifacts.some(artifact => artifact.packageId === pkg.id && artifact.kind === 'lib' && artifact.name === target.name)) throw new Error(`Admission default doctest-only library ${target.name} has test=false and doctest=true without a harness artifact; this workspace projection is unsupported. Verify this target through a supported explicit trusted Cargo selection before retrying.`);
    }
  }
}
