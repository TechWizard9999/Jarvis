export type VerificationVerdict =
  | { kind: 'profile-check'; checkId: string }
  | { kind: 'acceptance' }
  | { kind: 'frozen-regression' }
  | { kind: 'tool-error' | 'check-result-loop' | 'agent-recovery'; phase: string; signature: string };

/** This detects unchanged failures; it imposes no limit on productive tool use or tokens. */
export class ProgressTracker {
  private signature = ''; private repeats = 0;
  private recoveryScope = ''; private recoveryCounts = new Map<string, number>();
  record(revision: string, verdict: string | VerificationVerdict) {
    if (typeof verdict !== 'string' && verdict.kind === 'agent-recovery') {
      // An unrelated check/diagnosis does not resolve an earlier recurring failure on this source and phase.
      const scope = JSON.stringify([revision, verdict.phase]);
      if (scope !== this.recoveryScope) { this.recoveryScope = scope; this.recoveryCounts.clear(); }
      const repeats = (this.recoveryCounts.get(verdict.signature) || 0) + 1;
      this.recoveryCounts.set(verdict.signature, repeats); return repeats >= 3;
    }
    // Independent checks carry their stable identity; diagnostic output and round-specific paths are evidence,
    // not part of the repeat key. A different source revision or check remains a new opportunity for progress.
    const category = typeof verdict === 'string'
      ? verdict.replace(/Attempt \d+/g, 'Attempt N').replace(/candidates\/\d+\//g, 'candidates/N/').replace(/attempt-\d+-/g, 'attempt-N-')
      : verdict.kind === 'profile-check' ? [verdict.kind, verdict.checkId]
      : 'signature' in verdict ? [verdict.kind, verdict.phase, verdict.signature] : [verdict.kind];
    const signature = JSON.stringify([revision, category]);
    this.repeats = signature === this.signature ? this.repeats + 1 : 1; this.signature = signature;
    return this.repeats >= 3;
  }
}
