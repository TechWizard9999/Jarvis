import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { exec, checked } from '../src/process.ts';

export const original = `fn preserve(line: &str) -> bool {
    !line.starts_with("error:")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keeps_normal() {
        assert!(preserve("hello"));
    }
}
`;
export const testName = 'tests::bugfix_issue_1_preserves_error';
export const testFunction = `    #[test]
    fn bugfix_issue_1_preserves_error() {
        assert!(
            preserve("error: missing file"),
            "reported error must be preserved"
        );
    }
`;
export const withRegression = original.replace('    #[test]\n    fn keeps_normal()', testFunction + '\n    #[test]\n    fn keeps_normal()');
export const spec = { file: 'src/lib.rs', testName, failureContains: 'reported error must be preserved', expectedBehavior: 'Preserve the error line.', citation: 'The error line must be preserved.', fixtures: [] as string[] };
export async function tempConfig() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bugfix-test-'));
  const config = loadConfig({ BUGFIX_PROJECT_DIR: root, BUGFIX_STATE_DIR: path.join(root, 'state'), BUGFIX_REPO_ROOT: path.join(root, 'repos'), BUGFIX_MODEL: 'nvidia/fixture-model', BUGFIX_GIT_NAME: 'Test Author', BUGFIX_GIT_EMAIL: 'test@example.invalid' });
  await fs.mkdir(config.repoRoot, { recursive: true }); return { root, config };
}
export async function fixtureRepo(root: string) {
  const repo = path.join(root, 'rtk'); await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  await fs.writeFile(path.join(repo, 'Cargo.toml'), '[package]\nname = "rtk"\nversion = "0.1.0"\nedition = "2024"\n[features]\ndefault = []\n');
  await fs.writeFile(path.join(repo, 'Cargo.lock'), 'version = 4\n\n[[package]]\nname = "rtk"\nversion = "0.1.0"\n');
  await fs.writeFile(path.join(repo, 'src/lib.rs'), original);
  for (const args of [['init', '-b', 'develop'], ['add', '.'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-m', 'fixture baseline']]) checked(await exec('git', ['-C', repo, ...args]), 'Create fixture Git repository');
  return repo;
}
