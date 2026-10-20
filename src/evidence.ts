import type { Regression, RunEvent } from './types.ts';

/** Convert exact references only; never trim, round, supply or infer an event identity. */
export function normalizeEvidenceIds(input: unknown): number[] {
  const invalid = () => new Error('Evidence must contain at least two unique positive event IDs as safe integers or canonical decimal strings');
  if (!Array.isArray(input) || input.length < 2) throw invalid();
  const ids = Array.from(input, value => {
    const id = typeof value === 'number' ? value : typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : NaN;
    if (!Number.isSafeInteger(id) || id < 1) throw invalid();
    return id;
  });
  if (new Set(ids).size !== ids.length) throw invalid();
  return ids;
}

type CandidateEvidence = { format: 'legacy'; evidenceIds: number[]; changedTypes: boolean }
  | { format: 'named'; evidenceIds: number[]; sourceReadEvidenceId: number; bugCheckEvidenceId: number; changedTypes: boolean };

/** Accept one unambiguous answer shape; event identity and tool-role validation remain separate. */
export function normalizeCandidateEvidence(input: unknown): CandidateEvidence {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Candidate evidence must be an object containing both sourceReadEvidenceId and bugCheckEvidenceId, or legacy evidenceIds');
  const answer = input as Record<string, unknown>;
  const source = Object.hasOwn(answer, 'sourceReadEvidenceId'), check = Object.hasOwn(answer, 'bugCheckEvidenceId'), legacy = Object.hasOwn(answer, 'evidenceIds');
  if (legacy && (source || check)) throw new Error('Use either both sourceReadEvidenceId and bugCheckEvidenceId or legacy evidenceIds; mixed proof fields are ambiguous');
  if (source || check) {
    if (!source || !check) throw new Error('Named proof requires both sourceReadEvidenceId and bugCheckEvidenceId');
    const raw = [answer.sourceReadEvidenceId, answer.bugCheckEvidenceId], evidenceIds = normalizeEvidenceIds(raw);
    return { format: 'named', evidenceIds, sourceReadEvidenceId: evidenceIds[0], bugCheckEvidenceId: evidenceIds[1], changedTypes: raw.some(id => typeof id === 'string') };
  }
  if (!legacy) throw new Error('Candidate evidence requires both sourceReadEvidenceId and bugCheckEvidenceId, or legacy evidenceIds');
  const evidenceIds = normalizeEvidenceIds(answer.evidenceIds);
  return { format: 'legacy', evidenceIds, changedTypes: (answer.evidenceIds as unknown[]).some(id => typeof id === 'string') };
}

/** These are executable tool arguments for frozen bugs, not evidence IDs or broad exploratory checks. */
export function candidateEvidenceChecks(specs: Regression[]) {
  return specs.filter(spec => spec.baseline !== 'pass').map(spec => spec.target?.kind === 'integration'
    ? { check: 'test-integration', target: spec.target.name, test: spec.testName }
    : { check: 'test-focused', test: spec.testName });
}

/** Evidence is a reference to an observed fact, never a substitute for final verification. */
export function validateEvidence(input: unknown, events: RunEvent[], files: Record<string, string>, changedSource: Record<string,[number,number][]>, revision: string, scenarios: string[]) {
  const proof = normalizeCandidateEvidence(Array.isArray(input) ? { evidenceIds: input } : input);
  const ids = proof.evidenceIds;
  const records = ids.map(id => {
    const event = events.find(e => e.seq === id);
    if (!event || event.source !== 'tool' || event.kind !== 'result') throw new Error(`Evidence ${id} is not a recorded tool result`);
    const record = event.data as { tool?: string; result?: any };
    if (!['read_source','run_check'].includes(record?.tool || '')) throw new Error(`Evidence ${id} has an unsupported proof type; graph/search output may guide investigation but cannot prove the candidate`);
    return record;
  });
  if (proof.format === 'named') {
    if (records[0].tool !== 'read_source') throw new Error('sourceReadEvidenceId must reference a read_source tool result');
    if (records[1].tool !== 'run_check') throw new Error('bugCheckEvidenceId must reference a run_check tool result');
  }
  const reads = records.filter(record => record.tool === 'read_source');
  if (!reads.length || reads.some(record => !changedSource[record.result?.path])) throw new Error('Evidence needs reads of changed source');
  if (reads.some(record => record.result.contentHash !== files[record.result.path])) throw new Error('Source evidence is stale; re-read the changed implementation after editing');
  if (reads.some(record => !changedSource[record.result.path].some(([start,end]) => Number.isInteger(record.result.start) && Number.isInteger(record.result.end) && record.result.start <= end && record.result.end >= start))) throw new Error('Source evidence must read the changed lines of implementation');
  const checks=records.filter(record=>record.tool==='run_check');
  if (!checks.length || checks.some(record => !(record.result?.sourceHash === revision && record.result.status === 'passed' && record.result.exitCode === 0 && record.result.matched > 0 && record.result.scenarioIds?.some((id: string) => scenarios.includes(id))))) throw new Error('Evidence needs current passing bug scenario checks; run a frozen failing-baseline regression after the last edit');
}
