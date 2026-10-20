import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fingerprint, hash, inventory } from '../src/files.ts';
import { freezeRust } from '../src/rust.ts';
import type { AcceptanceRequirement, FrozenRegression, RunEvent } from '../src/types.ts';

// A missing validator must fail as an unmet behavior, before an implementation exists.
const coverage = await import('../src/coverage-review.ts').catch(() => ({})) as typeof import('../src/coverage-review.ts');
const source = `#[cfg(test)]
mod tests {
    #[test]
    fn repair() {
        let original_executions = vec!["once"];
        assert_eq!(original_executions.len(), 1);
        let recovery = "a usable recovery command";
        assert!(recovery.contains("command"));
        assert_eq!(130, 130);
    }
    #[test]
    fn control() {
        assert_eq!("unchanged", "unchanged");
    }
}
`;
const requirements: AcceptanceRequirement[] = [
  { id: 'repair', baseline: 'fail', expectedBehavior: 'Execute the original once and offer a usable recovery command with the correct status.', citation: 'The original must run once and recovery must be usable.' },
  { id: 'control', baseline: 'pass', expectedBehavior: 'Preserve the existing successful control behavior.', citation: 'The successful existing control remains unchanged.' },
];
const witness = (startLine: number, endLine = startLine, sourceReadEvidenceId: number | string = 11) => ({ startLine, endLine, sourceReadEvidenceId });
function review() {
  return { complete: true, missing: [] as string[], explanation: 'Every required behavior was examined against its assertions.', rows: [
    { requirementId: 'repair', file: 'src/lib.rs', testName: 'tests::repair', clauses: [
      { behavior: 'The original executes exactly once.', assertion: witness(6), explanation: 'The count assertion checks the original invocation list.' },
      { behavior: 'The recovery command is usable.', assertion: witness(8), explanation: 'The recovery assertion checks the produced command.' },
      { behavior: 'The exit status is preserved.', assertion: witness(9), explanation: 'The status assertion checks the expected status.' },
    ], counterexamples: ['A second original execution or unusable recovery would violate the corresponding checks.'] },
    { requirementId: 'control', file: 'src/lib.rs', testName: 'tests::control', clauses: [
      { behavior: 'The successful control is preserved.', assertion: witness(13), explanation: 'The control has an explicit equality assertion.' },
    ], counterexamples: ['Changed successful control output would violate its equality assertion.'] },
  ] };
}
async function fixture(t: test.TestContext, text = source, integration = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coverage-review-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = integration ? 'tests/cli.rs' : 'src/lib.rs';
  const planned = requirements.map(requirement => ({ ...requirement, ...(integration ? { target: { kind: 'integration' as const, name: 'cli' } } : {}) }));
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), text);
  const frozen: FrozenRegression[] = requirements.map(requirement => {
    const testName = `tests::${requirement.id}`;
    return { spec: { ...requirement, file, testName, target: integration ? { kind: 'integration', name: 'cli' } : { kind: 'unit' }, failureContains: 'assertion failed', fixtures: [] }, ...freezeRust(text, testName, integration), fixtureHashes: {}, overlayHash: 'frozen', ...(integration ? { wholeFileHash: hash(text) } : {}) };
  });
  const events: RunEvent[] = [{ seq: 11, runId: 'fixture', time: '', stage: 'reproduction', source: 'tool', kind: 'result', message: 'read_source', data: { tool: 'read_source', call: 10, result: { path: file, start: 1, end: text.split('\n').length, contentHash: hash(text), sourceHash: fingerprint(await inventory(root)) } } }, { seq: 10, runId: 'fixture', time: '', stage: 'reproduction', source: 'tool', kind: 'called', message: 'read_source', data: { tool: 'read_source', args: { path: file } } }];
  const answer = review(); if (integration) for (const row of answer.rows) row.file = file;
  const validate = (input: unknown = answer, proof = events) => coverage.validateCoverageReview(input, planned, frozen, root, proof);
  return { root, file, frozen, events, answer, validate };
}

test('complete acceptance requires authentic assertion witnesses for all declared clauses and pass controls', async t => {
  assert.equal(typeof coverage.validateCoverageReview, 'function', 'An assertion-level coverage validator is required');
  const f = await fixture(t); const result = await f.validate();
  assert.equal(result.complete, true); assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].clauses.length, 3); assert.equal(result.rows[1].requirementId, 'control');
  await assert.rejects(f.validate({ complete: true, missing: [], explanation: 'All covered.' }), /rows/i);
  const unsupported = structuredClone(f.answer) as any;
  unsupported.rows[0].clauses[1] = { behavior: 'Count and usability are fully covered.', explanation: 'A reviewer claims this without an assertion witness.' };
  await assert.rejects(f.validate(unsupported), /assertion.*witness/i);
});

test('coverage binds each required row to its canonical frozen file and named test without waiving controls', async t => {
  const f = await fixture(t);
  for (const change of [
    (a: any) => a.rows.pop(),
    (a: any) => a.rows.push(structuredClone(a.rows[0])),
    (a: any) => a.rows[0].requirementId = 'foreign',
    (a: any) => a.rows[0].file = 'src/other.rs',
    (a: any) => a.rows[0].testName = 'tests::control',
    (a: any) => a.rows[1].clauses = [],
    (a: any) => a.rows[0].counterexamples = [],
  ]) {
    const answer = structuredClone(f.answer); change(answer);
    await assert.rejects(f.validate(answer), /required|duplicate|unknown|frozen|clauses|counterexample/i);
  }
  f.frozen[1].spec.required = false;
  await assert.rejects(f.validate(), /required|frozen/i);
});

test('source witnesses resolve unique real current read results and normalize canonical evidence IDs', async t => {
  const f = await fixture(t); const answer = structuredClone(f.answer) as any;
  answer.rows[0].clauses[0].assertion.sourceReadEvidenceId = '11';
  const result = await f.validate(answer);
  assert.equal(result.rows[0].clauses[0].assertion?.sourceReadEvidenceId, 11);
  assert.equal(answer.rows[0].clauses[0].assertion.sourceReadEvidenceId, '11');
  for (const id of [12, 0, -1, 1.5, '011', ' 11', '1e1', Number.MAX_SAFE_INTEGER + 1]) {
    answer.rows[0].clauses[0].assertion.sourceReadEvidenceId = id;
    await assert.rejects(f.validate(answer), /evidence|read_source/i);
  }
  for (const change of [
    (e: any) => e.source = 'model',
    (e: any) => e.kind = 'rejected',
    (e: any) => e.data.tool = 'search_text',
    (e: any) => e.data.result.path = 'src/other.rs',
    (e: any) => e.data.result.contentHash = 'stale',
    (e: any) => e.data.result.sourceHash = 'stale-tree',
    (e: any) => e.data.result.start = 7,
    (e: any) => e.data.result.end = 5,
  ]) {
    const event = structuredClone(f.events[0]); change(event);
    await assert.rejects(f.validate(f.answer, [event]), /read_source|current|stale|range|read|path/i);
  }
  await assert.rejects(f.validate(f.answer, [...f.events, ...f.events]), /unique|duplicate|ambiguous/i);
});

test('assertion witnesses must name complete assertion lines in the bound test and observed source range', async t => {
  const f = await fixture(t);
  for (const range of [witness(5), witness(13), witness(6, 7), witness(0), witness(6, 5), witness(6.1), witness(6, Number.MAX_SAFE_INTEGER + 1)]) {
    const answer = structuredClone(f.answer); answer.rows[0].clauses[0].assertion = range;
    await assert.rejects(f.validate(answer), /assertion|range|line/i);
  }
  const multiline = source.replace('assert_eq!(original_executions.len(), 1);', 'assert_eq!(\n            original_executions.len(),\n            1\n        );');
  const m = await fixture(t, multiline); m.answer.rows[0].clauses[0].assertion = witness(6, 9);
  m.answer.rows[0].clauses[1].assertion = witness(11); m.answer.rows[0].clauses[2].assertion = witness(12); m.answer.rows[1].clauses[0].assertion = witness(16);
  assert.equal((await m.validate()).complete, true);
  m.answer.rows[0].clauses[0].assertion = witness(6);
  await assert.rejects(m.validate(), /complete.*assertion|assertion.*range/i);
});

test('comments, string fixtures and opaque macro token trees cannot fabricate assertion witnesses', async t => {
  for (const fake of [
    '// assert_eq!(original_executions.len(), 1);',
    '/* assert_eq!(original_executions.len(), 1); */',
    'let fixture = "assert_eq!(original_executions.len(), 1);";',
    'let fixture = r###"assert_eq!(original_executions.len(), 1);"###;',
    'let fixture = stringify!(assert_eq!(original_executions.len(), 1));',
    'macro_rules! unused { () => { assert_eq!(original_executions.len(), 1); }; }',
    '/* nested /* comment */ assert_eq!(original_executions.len(), 1); */',
  ]) {
    const f = await fixture(t, source.replace('assert_eq!(original_executions.len(), 1);', fake));
    await assert.rejects(f.validate(), /assertion/i);
  }
});

test('assertions inside uncalled local functions and unused closures are not direct test witnesses', async t => {
  for (const fake of [
    'fn unused() { assert_eq!(original_executions.len(), 1); }',
    'let _unused = || { assert_eq!(original_executions.len(), 1); };',
    'let _unused = move |n: usize| { assert_eq!(n, 1); };',
    'let _unused = || assert_eq!(original_executions.len(), 1);',
    'let _unused = || -> Result<(), Error<A, B>> { assert_eq!(original_executions.len(), 1); Ok(()) };',
    'let _unused = async { assert_eq!(original_executions.len(), 1); };',
    'const UNUSED: () = { assert_eq!(1, 1); };',
    "let _unused = 'block: { break 'block || { assert_eq!(1, 2); }; };",
    "let _unused = 'mé: { break 'mé || { assert_eq!(1, 2); }; };",
  ]) {
    const f = await fixture(t, source.replace('assert_eq!(original_executions.len(), 1);', fake));
    await assert.rejects(f.validate(), /direct assertion|assertion.*range/i, fake);
  }
});

test('Unicode and raw macro identifiers preserve opaque token trees around apparent assertions', async t => {
  for (const fake of [
    'mé!(assert_eq!(original_executions.len(), 1));',
    '宏!(assert_eq!(original_executions.len(), 1));',
    'me\u0301!(assert_eq!(original_executions.len(), 1));',
    'r#mé!(assert_eq!(original_executions.len(), 1));',
    'macro_rules! mé { () => { assert_eq!(original_executions.len(), 1); }; }',
    'macro_rules! r#mé { () => { assert_eq!(original_executions.len(), 1); }; }',
  ]) {
    const f = await fixture(t, source.replace('assert_eq!(original_executions.len(), 1);', fake));
    await assert.rejects(f.validate(), /direct assertion|assertion.*range/i, fake);
  }
});

test('ordinary branches and loops retain direct assertion witnesses outside deferred bodies', async t => {
  for (const direct of [
    'for _ in [()] { if true { assert_eq!(original_executions.len(), 1); } }',
    'let _unused = || false; assert_eq!(original_executions.len(), 1);',
    'fn unused() {} assert_eq!(original_executions.len(), 1);',
    'let bits = 1 | 2; if bits > 0 || true { assert_eq!(original_executions.len(), 1); }',
    'r#assert_eq!(original_executions.len(), 1);',
  ]) {
    const f = await fixture(t, source.replace('assert_eq!(original_executions.len(), 1);', direct));
    assert.equal((await f.validate()).complete, true, direct);
  }
});

test('local const functions and closure arguments do not hide subsequent eager assertion witnesses', async t => {
  for (const direct of [
    'const fn unused() {} assert_eq!(original_executions.len(), 1);',
    'const unsafe fn unused() {} assert_eq!(original_executions.len(), 1);',
    'fn use_fn(_: impl FnOnce() -> bool, _: usize) {} use_fn(|| false, { assert_eq!(original_executions.len(), 1); 0 });',
    'fn use_fn(_: impl FnOnce() -> bool, _: usize) {} use_fn(|| 1 < 2, { assert_eq!(original_executions.len(), 1); 0 });',
  ]) {
    const f = await fixture(t, source.replace('assert_eq!(original_executions.len(), 1);', direct));
    assert.equal((await f.validate()).complete, true, direct);
  }
});

test('frozen test hashes and whole integration file hashes are rechecked before accepting current reads', async t => {
  const unit = await fixture(t); unit.frozen[0].functionHash = 'different';
  await assert.rejects(unit.validate(), /frozen|hash/i);
  const integration = await fixture(t, source, true);
  assert.equal((await integration.validate()).complete, true);
  integration.frozen[0].wholeFileHash = 'different';
  await assert.rejects(integration.validate(), /integration|frozen|hash/i);
  delete integration.frozen[0].wholeFileHash;
  await assert.rejects(integration.validate(), /integration|whole.*file/i);
});

test('incomplete reviews can expose unsupported clauses honestly but cannot claim complete or omit missing behavior', async t => {
  const f = await fixture(t); const answer = structuredClone(f.answer) as any;
  answer.complete = false; answer.missing = ['No usable recovery assertion exists.']; answer.rows[0].clauses[1].assertion = null;
  assert.equal((await f.validate(answer)).complete, false);
  answer.complete = true;
  await assert.rejects(f.validate(answer), /complete|missing|witness/i);
  answer.complete = false; answer.missing = [];
  await assert.rejects(f.validate(answer), /missing/i);
});

test('review cancellation interrupts source validation and the shared prompt exposes the supported evidence contract', async t => {
  const f = await fixture(t); const abort = new AbortController(); abort.abort(new Error('stop review'));
  await assert.rejects(coverage.validateCoverageReview(f.answer, requirements, f.frozen, f.root, f.events, abort.signal), /stop review/);
  const prompt = coverage.coverageReviewPromptSchema();
  assert.equal(typeof prompt, 'string');
  const example = JSON.parse(prompt.slice(prompt.indexOf('{'), prompt.lastIndexOf('}') + 1));
  assert.equal(typeof example.rows[0].clauses[0].assertion.sourceReadEvidenceId, 'number');
  assert.ok(Array.isArray(example.rows[0].counterexamples));
});

test('cancellation during the final source inventory cannot return an accepted review', async t => {
  const f = await fixture(t), abort = new AbortController();
  const originalReadFile = fs.readFile; let sourceReads = 0;
  fs.readFile = (async (...args: any[]) => {
    const result = await (originalReadFile as (...args: any[]) => Promise<any>)(...args);
    if (args[0] === path.join(f.root, f.file) && ++sourceReads === 3) abort.abort(new Error('stop final source inventory'));
    return result;
  }) as typeof fs.readFile;
  try {
    await assert.rejects(coverage.validateCoverageReview(f.answer, requirements, f.frozen, f.root, f.events, abort.signal), /stop final source inventory/);
  } finally { fs.readFile = originalReadFile; }
});
