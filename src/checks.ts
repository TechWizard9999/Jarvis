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
