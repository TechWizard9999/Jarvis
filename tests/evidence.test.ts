import test from 'node:test';
import assert from 'node:assert/strict';
import * as evidence from '../src/evidence.ts';
import type { RunEvent } from '../src/types.ts';

const { validateEvidence } = evidence;
const event = (seq: number, tool: string, result: unknown): RunEvent => ({ seq, runId: 'fixture-run', time: '', stage: 'patching', source: 'tool', kind: 'result', message: tool, data: { tool, result } });
const source = event(1, 'read_source', { path: 'src/a.rs', start: 2, end: 8, contentHash: 'current-file', sourceHash: 'current-tree' });
const check = event(2, 'run_check', { id: 'tool-test', status: 'passed', exitCode: 0, matched: 1, sourceHash: 'current-tree', scenarioIds: ['bug'] });
const validate = (ids: unknown = [1, 2], events = [source, check]) => validateEvidence(ids, events, { 'src/a.rs': 'current-file', 'src/b.rs': 'unrelated-file' }, { 'src/a.rs': [[4,6]] }, 'current-tree', ['bug']);

test('evidence IDs normalize only canonical positive safe integer references without mutating the answer', () => {
  const normalize = evidence.normalizeEvidenceIds;
  assert.equal(typeof normalize, 'function', 'Canonical evidence ID normalization is required');
  const raw = ['5161', 5145];
  assert.deepEqual(normalize(raw), [5161, 5145]);
  assert.deepEqual(raw, ['5161', 5145]);
  assert.deepEqual(normalize([1, '9007199254740991']), [1, Number.MAX_SAFE_INTEGER]);
  for (const invalid of [
    undefined, null, {}, '1,2', [], [1], [1, '1'], ['2', 2], [1, , 2],
    ...[0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0', '01', '+1', '-1',
      '1.0', '1e3', '0x1', ' 1', '1 ', '\t1', '1\n', '1\r', '1\u2028', '1\u2029', '１', '', '9007199254740992',
      '9007199254740993', {}, true, 1n].map(id => [id, 2]),
  ]) assert.throws(() => normalize(invalid), /Evidence.*unique.*positive|canonical|safe/i);
});

test('canonical string references resolve the same actual proofs and never weaken proof validation', () => {
  assert.doesNotThrow(() => validate(['1', '2']));
  assert.throws(() => validate([1, '1']), /unique/i);
  assert.throws(() => validate(['1', '99']), /not a recorded tool result/);
  assert.throws(() => validate(['1', '2'], [event(1, 'read_source', { path: 'src/a.rs', contentHash: 'old', start: 2, end: 8 }), check]), /stale/);
  assert.throws(() => validate(['1', '2'], [source, event(2, 'run_check', { ...((check.data as any).result), sourceHash: 'old-tree' })]), /passing.*scenario/);
  assert.throws(() => validate(['1', '2'], [source, event(2, 'run_check', { ...((check.data as any).result), scenarioIds: ['control'] })]), /passing.*scenario/);
  assert.throws(() => validate(['1', '2'], [event(1, 'read_source', { path: 'src/b.rs', contentHash: 'unrelated-file', start: 2, end: 8 }), check]), /changed source/);
  assert.throws(() => validate(['1', '2'], [source, event(2, 'graph_query', { output: 'unsupported' })]), /unsupported/);
});

test('candidate evidence requires current changed source and a matching passing scenario', () => {
  assert.doesNotThrow(() => validate());
  for (const ids of [[1, 1], [1, 99], [], [2]]) assert.throws(() => validate(ids), /evidence|Evidence/);
  assert.throws(() => validate([1, 2], [event(1, 'read_source', { path: 'src/b.rs', contentHash: 'unrelated-file' }), check]), /changed source/);
  assert.throws(() => validate([1, 2], [event(1, 'read_source', { path: 'src/a.rs', contentHash: 'stale' }), check]), /stale/);
  assert.throws(() => validate([1, 2], [event(1, 'read_source', { path: 'src/a.rs', contentHash: 'current-file', start:50,end:60 }), check]), /changed lines/);
  assert.throws(() => validate([1, 2, 3], [source,check,event(3,'graph_query',{output:'inferred relation'})]), /unsupported/);
  for (const result of [
    { status: 'no_match', exitCode: 0, matched: 0, sourceHash: 'current-tree', scenarioIds: ['bug'] },
    { status: 'passed', exitCode: 0, matched: 1, sourceHash: 'old-tree', scenarioIds: ['bug'] },
    { status: 'passed', exitCode: 0, matched: 1, sourceHash: 'current-tree', scenarioIds: ['unrelated'] },
  ]) assert.throws(() => validate([1, 2], [source, event(2, 'run_check', result)]), /passing.*scenario/);
});

test('named proof references normalize exact roles without mutating raw answers or inferring missing fields', () => {
  const normalize = evidence.normalizeCandidateEvidence;
  assert.equal(typeof normalize, 'function', 'Named candidate proof normalization is required');
  const raw = { explanation: 'Preserve output.', sourceReadEvidenceId: '1', bugCheckEvidenceId: '2' };
  assert.deepEqual(normalize(raw).evidenceIds, [1, 2]);
  assert.deepEqual(raw, { explanation: 'Preserve output.', sourceReadEvidenceId: '1', bugCheckEvidenceId: '2' });
  assert.deepEqual(normalize({ evidenceIds: ['1', 2] }).evidenceIds, [1, 2]);
  for (const partial of [{ sourceReadEvidenceId: 1 }, { bugCheckEvidenceId: 2 }, { sourceReadEvidenceId: 1, bugCheckEvidenceId: undefined }]) assert.throws(() => normalize(partial), /both|positive|canonical/);
  for (const mixed of [
    { sourceReadEvidenceId: 1, bugCheckEvidenceId: 2, evidenceIds: [1, 2] },
    { sourceReadEvidenceId: 1, evidenceIds: [1, 2] },
    { sourceReadEvidenceId: 1, bugCheckEvidenceId: 2, evidenceIds: undefined },
  ]) assert.throws(() => normalize(mixed), /mixed|either|both.*legacy/i);
  assert.throws(() => normalize({ sourceReadEvidenceId: 1, bugCheckEvidenceId: '1' }), /unique/);
  for (const invalid of ['01', '1e0', ' 1', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => normalize({ sourceReadEvidenceId: invalid, bugCheckEvidenceId: 2 }), /positive|canonical|safe/);
});

test('named fields resolve their declared tool roles and retain all current source and exact bug proof gates', () => {
  const named = { sourceReadEvidenceId: '1', bugCheckEvidenceId: '2' };
  assert.doesNotThrow(() => validate(named));
  assert.throws(() => validate({ sourceReadEvidenceId: 2, bugCheckEvidenceId: 1 }), /sourceReadEvidenceId.*read_source/);
  assert.throws(() => validate({ sourceReadEvidenceId: 1, bugCheckEvidenceId: 3 }, [source, check, event(3, 'read_source', (source.data as any).result)]), /bugCheckEvidenceId.*run_check/);
  assert.throws(() => validate({ sourceReadEvidenceId: 99, bugCheckEvidenceId: 2 }), /not a recorded tool result/);
  assert.throws(() => validate(named, [event(1, 'read_source', { ...((source.data as any).result), contentHash: 'old' }), check]), /stale/);
  assert.throws(() => validate(named, [source, event(2, 'run_check', { ...((check.data as any).result), scenarioIds: ['control'] })]), /passing.*scenario/);
  assert.throws(() => validate(named, [source, event(2, 'run_check', { ...((check.data as any).result), scenarioIds: [] })]), /passing.*scenario/);
  assert.throws(() => validate(named, [event(1, 'read_source', { ...((source.data as any).result), start: 50, end: 60 }), check]), /changed lines/);
});
