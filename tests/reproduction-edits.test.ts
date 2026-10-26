import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertReproductionEdits as guard, freezeRegression } from '../src/policy.ts';
import { Pipeline } from '../src/pipeline.ts';
import { copySource, hash, inventory } from '../src/files.ts';
import { original, spec, tempConfig, testName, withRegression } from './helpers.ts';
import type { AcceptanceRequirement } from '../src/types.ts';

const requirements: AcceptanceRequirement[] = [{ id: 'cli', required: true, baseline: 'fail', target: { kind: 'integration', name: 'bugfix_issue_1' }, expectedBehavior: 'Preserve the reported error line.', citation: 'The error line must be preserved.' }];
async function fixture(t: test.TestContext) {
  const { root, config } = await tempConfig(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = path.join(root, 'base'), source = path.join(root, 'source');
  await fs.mkdir(path.join(base, 'src'), { recursive: true }); await fs.mkdir(path.join(base, 'tests/fixtures'), { recursive: true });
  await fs.writeFile(path.join(base, 'src/lib.rs'), original);
  await fs.writeFile(path.join(base, 'tests/support.rs'), 'pub fn fixture() -> bool { true }\n');
  await fs.writeFile(path.join(base, 'tests/fixtures/existing.txt'), 'existing fixture\n');
  await copySource(base, source);
  const write = async (relative: string, content: string) => { const file = path.join(source, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); };
  return { root, config, base, source, write };
}
async function toolFixture(t: test.TestContext) {
  const fixtureData = await fixture(t); const pipeline = new Pipeline(fixtureData.config);
  const run = await pipeline.store.create({ repo: fixtureData.base, issue: 'https://github.com/rtk-ai/rtk/issues/1', mode: 'evaluation', retrieval: 'text', publish: false });
  run.acceptancePlan = requirements;
  const context = { run, base: fixtureData.base, source: fixtureData.source, phase: 'reproduction' as const, abort: new AbortController(), queue: Promise.resolve(), agent: { toolToken: '', providerToken: '', start: async () => {}, ask: async () => ({}), stop: async () => {} } };
  pipeline.contexts.set(run.id, context); let mirrors = 0;
  pipeline.repository.mirror = async () => { mirrors++; };
  return { ...fixtureData, pipeline, run, context, mirrors: () => mirrors };
}

test('reproduction permits cumulative new inline tests, planned integration drafts and new fixtures', async t => {
  const { base, source, write } = await fixture(t);
  await write('src/lib.rs', withRegression);
  await guard(base, source, ['src/lib.rs'], requirements);
  await write('src/lib.rs', withRegression.replace('reported error must be preserved', 'reported errors must stay visible'));
  await write('tests/bugfix_issue_1.rs', 'use std::process::Command;\nfn executable_fixture() {}\n// scenario is still being drafted\n');
  await write('tests/fixtures/new/fake-command.sh', '#!/bin/sh\nprintf "fixture output\\n"\n');
  await guard(base, source, ['src/lib.rs', 'tests/bugfix_issue_1.rs', 'tests/fixtures/new/fake-command.sh'], requirements);
});

test('inline reproduction drafts can add setup before adding the required assertion', async t => {
  const { base, source, pipeline, run, mirrors } = await toolFixture(t);
  const setup = 'let actual = preserve("error: missing file");';
  const draft = original.replace('    #[test]\n    fn keeps_normal()', `    #[test]\n    fn ${testName.split('::').at(-1)}() { ${setup} }\n\n    #[test]\n    fn keeps_normal()`);
  await pipeline.tool(run.id, 'replace_source', { path: 'src/lib.rs', before: original, after: draft });
  assert.equal(await fs.readFile(path.join(source, 'src/lib.rs'), 'utf8'), draft);
  await assert.rejects(freezeRegression(base, source, spec), /explicit assertion/);
  await pipeline.tool(run.id, 'replace_source', { path: 'src/lib.rs', before: setup, after: setup + ' assert!(actual, "reported error must be preserved");' });
  await freezeRegression(base, source, spec); assert.equal(mirrors(), 2);
});

test('final freeze rejects a setup-only inline regression even when its draft structure is allowed', async t => {
  const { base, source, write } = await fixture(t);
  const draft = withRegression.replace('assert!(\n            preserve("error: missing file"),\n            "reported error must be preserved"\n        );', 'let actual = preserve("error: missing file");');
  await write('src/lib.rs', draft);
  await assert.rejects(freezeRegression(base, source, spec), /explicit assertion/);
});

test('reproduction rejects production, helper, old-test and gating edits even alongside a new test', async t => {
  const { base, source, write } = await fixture(t);
  const invalid = [
    withRegression.replace('!line.starts_with("error:")', '!line.is_empty()'),
    withRegression.replace('    use super::*;', '    use super::*;\n    fn hidden_fix() -> bool { true }'),
    withRegression.replace('assert!(preserve("hello"));', 'assert!(true);'),
    withRegression.replace('#[cfg(test)]', '#[cfg(any(test, feature = "shortcut"))]'),
    withRegression.replace('    fn keeps_normal()', '    #[ignore]\n    fn keeps_normal()'),
  ];
  for (const content of invalid) { await write('src/lib.rs', content); await assert.rejects(guard(base, source, ['src/lib.rs'], requirements), /reproduction|unchanged|ordinary/i); }
});

test('a production-only reproduction edit explains the test-only contract and restores the source', async t => {
  const { source, pipeline, run, mirrors } = await toolFixture(t); const before = await inventory(source);
  await assert.rejects(pipeline.tool(run.id, 'replace_source', {
    path: 'src/lib.rs', before: '!line.starts_with("error:")', after: '!line.is_empty()',
  }), /reproduction.*only.*tests.*fixtures.*production.*unchanged/i);
  assert.deepEqual(await inventory(source), before); assert.equal(mirrors(), 0);
});

test('reproduction rejects existing test support and fixtures, new production and undeclared integration targets', async t => {
  const { base, source, write } = await fixture(t);
  for (const [relative, content] of [
    ['tests/support.rs', 'pub fn fixture() -> bool { false }\n'],
    ['tests/fixtures/existing.txt', 'changed fixture\n'],
    ['src/new.rs', '#[test]\nfn injected() { assert!(true); }\n'],
    ['tests/undeclared.rs', '#[test]\nfn injected() { assert!(true); }\n'],
  ]) {
    await write(relative, content);
    await assert.rejects(guard(base, source, [relative], requirements), /reproduction|existing|planned|unchanged/i);
  }
});

test('a mixed reproduction tool batch rolls back every file before mirroring', async t => {
  const { source, pipeline, run, mirrors } = await toolFixture(t); const before = await inventory(source);
  await assert.rejects(pipeline.tool(run.id, 'apply_patch', { edits: [
    { path: 'tests/bugfix_issue_1.rs', before: '', after: '#[test]\nfn bugfix_issue_1_cli() { assert!(true); }\n' },
    { path: 'tests/fixtures/new.txt', before: '', after: 'new fixture\n' },
    { path: 'src/lib.rs', before: original, after: withRegression.replace('!line.starts_with("error:")', '!line.is_empty()') },
  ] }), /reproduction|unchanged/i);
  assert.deepEqual(await inventory(source), before); assert.equal(mirrors(), 0); assert.equal(run.graphStale, false);
});

test('rejected edit batches preserve binary fixture bytes on replacement mismatch and policy rejection', async t => {
  for (const mismatch of [true, false]) await t.test(mismatch ? 'exact replacement mismatch' : 'reproduction policy rejection', async t => {
    const { base, source, pipeline, run, mirrors } = await toolFixture(t);
    const relative = 'tests/fixtures/binary.dat', bytes = Buffer.from([0x00, 0xff, 0x80, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0xc0, 0x0a]);
    await fs.writeFile(path.join(base, relative), bytes); await fs.writeFile(path.join(source, relative), bytes);
    const before = await inventory(source);
    await assert.rejects(pipeline.tool(run.id, 'apply_patch', { edits: [
      { path: 'src/lib.rs', before: original, after: withRegression },
      { path: relative, before: mismatch ? 'not present in fixture' : 'needle', after: 'updated', contentHash: hash(bytes.toString('utf8')) },
    ] }), mismatch ? /Replacement must match exactly once/ : /reproduction|unchanged/i);
    assert.deepEqual(await fs.readFile(path.join(source, relative)), bytes);
    assert.deepEqual(await inventory(source), before); assert.equal(mirrors(), 0); assert.equal(run.graphStale, false);
  });
});

test('valid reproduction tool edits remain revisable and production edits work in the patching phase', async t => {
  const { source, pipeline, run, context, mirrors } = await toolFixture(t);
  await pipeline.tool(run.id, 'replace_source', { path: 'src/lib.rs', before: original, after: withRegression });
  await pipeline.tool(run.id, 'replace_source', { path: 'src/lib.rs', before: 'reported error must be preserved', after: 'reported error output must be preserved' });
  await assert.rejects(pipeline.tool(run.id, 'replace_source', { path: 'src/lib.rs', before: '!line.starts_with("error:")', after: '!line.is_empty()' }), /reproduction|unchanged/i);
  assert.ok((await fs.readFile(path.join(source, 'src/lib.rs'), 'utf8')).includes('!line.starts_with("error:")')); assert.equal(mirrors(), 2);
  pipeline.contexts.set(run.id, { ...context, phase: 'patching' });
  await pipeline.tool(run.id, 'replace_source', { path: 'src/lib.rs', before: '!line.starts_with("error:")', after: '!line.is_empty()' });
  assert.equal(mirrors(), 3);
});

test('formatter cannot copy a production change back during reproduction', async t => {
  const { source, pipeline, run, mirrors } = await toolFixture(t); const before = await inventory(source);
  let scratch = '', removed = false;
  pipeline.docker.startWorker = async (_run, source) => { scratch = source; return 'fixture-formatter'; };
  pipeline.docker.remove = async () => { removed = true; };
  (pipeline as any).check = async () => {
    await fs.writeFile(path.join(scratch, 'src/lib.rs'), withRegression.replace('!line.starts_with("error:")', '!line.is_empty()'));
    return { id: 'fixture-format', argv: ['cargo', 'fmt'], exitCode: 0, timedOut: false, durationMs: 1, log: 'fixture', output: '' };
  };
  await assert.rejects(pipeline.tool(run.id, 'run_check', { check: 'format-source' }), /reproduction|unchanged/i);
  assert.deepEqual(await inventory(source), before); assert.equal(mirrors(), 0); assert.equal(removed, true);
  await assert.rejects(fs.stat(scratch), { code: 'ENOENT' });
});
