import { defaultProfile, withSkips } from './profile.ts';
import type { RepositoryProfile } from './profile.ts';
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
