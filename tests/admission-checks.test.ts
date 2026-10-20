import test from 'node:test';
import assert from 'node:assert/strict';
import { cargoAdmissionBuild, cargoAdmissionDocs, cargoAdmissionList, cargoAdmissionRun, parseCargoTestArtifacts, cargoAdmissionMetadata, assertAdmissionDocTargets } from '../src/checks.ts';

const target = { packageId: 'path+file:///workspace#rtk@0.1.0', name: 'rtk', kind: 'lib' as const, source: 'src/lib.rs', doctest: true };
const profile = ['cargo', 'test', '--workspace', '--exclude', 'other', '--no-default-features', '--features', 'ci', '--locked', '--offline', 'tests::bug', '--', '--skip', 'tests::unrelated', '--test-threads=1'];

test('admission preserves trusted feature flags and original filters when discovering a selected Cargo target', () => {
  assert.deepEqual(cargoAdmissionBuild(profile), ['cargo', 'test', '--workspace', '--exclude', 'other', '--no-default-features', '--features', 'ci', '--locked', '--offline', '--no-run', '--message-format=json']);
  const listing = cargoAdmissionList(profile, target);
  assert.deepEqual(listing, ['cargo', 'test', '--no-default-features', '--features', 'ci', '--locked', '--offline', '--package', target.packageId, '--lib', '--', 'tests::bug', '--skip', 'tests::unrelated', '--test-threads=1', '--list', '--format=pretty']);
  const run = cargoAdmissionRun(profile, target, ['tests::bug_control', 'tests::bug_failure_collision']);
  assert.deepEqual(run, ['cargo', 'test', '--no-default-features', '--features', 'ci', '--locked', '--offline', '--package', target.packageId, '--lib', '--', '--test-threads=1', '--exact', 'tests::bug_control', 'tests::bug_failure_collision']);
  assert.ok(cargoAdmissionDocs(profile, target)?.includes('--doc'));
  assert.equal(cargoAdmissionDocs(['cargo', 'test', '--test', 'integration', '--locked', '--offline'], target), undefined);
});

test('artifact discovery requires successful canonical Cargo test artifacts rather than guessed executable names', () => {
  assert.throws(() => parseCargoTestArtifacts('Finished test profile\n'), /no test artifacts/);
  assert.throws(() => parseCargoTestArtifacts('{bad json}\n'), /Malformed/);
  const artifact = { reason: 'compiler-artifact', package_id: target.packageId, executable: '/build/target/debug/rtk-123', profile: { test: true }, target: { name: target.name, kind: ['lib'], src_path: '/workspace/src/lib.rs', doctest: true } };
  assert.deepEqual(parseCargoTestArtifacts(JSON.stringify(artifact)), [target]);
  artifact.target.src_path = '/outside/source.rs';
  assert.throws(() => parseCargoTestArtifacts(JSON.stringify(artifact)), /canonical workspace/);
});

test('default admission does not enable a library whose manifest disables doctests', () => {
  assert.equal(cargoAdmissionDocs(['cargo', 'test', '--workspace', '--locked', '--offline'], { ...target, doctest: false }), undefined);
  assert.deepEqual(cargoAdmissionDocs(['cargo', 'test', '--workspace', '--no-default-features', '--locked', '--offline'], { ...target, doctest: true }), ['cargo', 'test', '--no-default-features', '--locked', '--offline', '--package', target.packageId, '--doc']);
});

test('explicit trusted doctest selection keeps its original command even when the manifest opts out by default', () => {
  const argv = ['cargo', 'test', '--workspace', '--doc', '--locked', '--offline'];
  assert.deepEqual(cargoAdmissionDocs(argv, { ...target, doctest: false }), argv);
});

test('a mixed workspace cannot silently omit an enabled doctest-only library', () => {
  for (const kind of ['lib', 'rlib', 'dylib', 'staticlib', 'cdylib', 'proc-macro']) {
  const metadata = JSON.stringify({ workspace_members: [target.packageId, 'path+file:///workspace/doc-only#doc-only@1.0.0'], packages: [
    { id: target.packageId, targets: [{ kind: ['lib'], name: target.name, doctest: true, test: true }] },
    { id: 'path+file:///workspace/doc-only#doc-only@1.0.0', targets: [{ kind: [kind], name: 'doc_only', doctest: true, test: false }] },
  ] });
  assert.throws(() => assertAdmissionDocTargets(metadata, [target]), /doctest-only library.*doc_only.*unsupported/i, `Library crate kind ${kind} must not bypass admission`);
  }
});


test('metadata projection keeps trusted manifest/config/features and avoids Cargo build-only selectors', () => {
  const argv = ['cargo', 'test', '--workspace', '--manifest-path', 'nested/Cargo.toml', '--config', 'build.jobs=1', '--features=ci', '--no-default-features', '--target', 'x86_64-unknown-linux-gnu', '--locked', '--offline'];
  assert.deepEqual(cargoAdmissionMetadata(argv), ['cargo', 'metadata', '--manifest-path', 'nested/Cargo.toml', '--config', 'build.jobs=1', '--features=ci', '--no-default-features', '--locked', '--offline', '--no-deps', '--format-version=1']);
  assert.equal(cargoAdmissionMetadata(['cargo', 'test', '--lib', '--locked', '--offline']), undefined);
  assert.equal(cargoAdmissionMetadata(['cargo', 'test', '--doc', '--locked', '--offline']), undefined);
  assert.doesNotThrow(() => assertAdmissionDocTargets(JSON.stringify({ workspace_members: [target.packageId], packages: [{ id: target.packageId, targets: [{ kind: ['lib'], name: target.name, test: true, doctest: true }] }] }), [target]));
  assert.throws(() => assertAdmissionDocTargets('{}', [target]), /workspace member/);
});
