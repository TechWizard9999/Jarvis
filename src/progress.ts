import { createHash } from 'node:crypto';
export interface ProgressCheckpoint { signature: string; repeats: number; recoveryScope: string; recoveryCounts: [string, number][]; immutableFailures: [string, number][]; }
export type ImmutableOffender = { kind: 'immutable-offender'; checkId: string; invariant: string; path: string; frozenHash: string };
export type VerificationVerdict =
  | ImmutableOffender
  | { kind: 'profile-check'; checkId: string }
  | { kind: 'acceptance' }
  | { kind: 'frozen-regression' }
  | { kind: 'tool-error' | 'check-result-loop' | 'agent-recovery'; phase: string; signature: string };

/** This detects unchanged failures; it imposes no limit on productive tool use or tokens. */
export class ProgressTracker {
  private signature = ''; private repeats = 0;
  private recoveryScope = ''; private recoveryCounts = new Map<string, number>();
  private immutableFailures = new Map<string, number>();
  constructor(checkpoint?: ProgressCheckpoint) {
    if (checkpoint) {
      this.signature = checkpoint.signature; this.repeats = checkpoint.repeats; this.recoveryScope = checkpoint.recoveryScope;
      this.recoveryCounts = new Map(checkpoint.recoveryCounts); this.immutableFailures = new Map(checkpoint.immutableFailures);
    }
  }
  snapshot(): ProgressCheckpoint { return { signature: this.signature, repeats: this.repeats, recoveryScope: this.recoveryScope, recoveryCounts: [...this.recoveryCounts], immutableFailures: [...this.immutableFailures] }; }
  resolveCheck(checkId: string) { for (const key of this.immutableFailures.keys()) if (JSON.parse(key)[0] === checkId) this.immutableFailures.delete(key); }
  record(revision: string, verdict: string | VerificationVerdict) {
    if (typeof verdict !== 'string' && verdict.kind === 'immutable-offender') {
      // A production edit cannot repair bytes the controller prohibits changing. Independent rejections and
      // session recovery must not clear this unresolved check + invariant + frozen-file identity.
      const key = JSON.stringify([verdict.checkId, verdict.invariant, verdict.path, verdict.frozenHash]);
      const repeats = (this.immutableFailures.get(key) || 0) + 1; this.immutableFailures.set(key, repeats); return repeats >= 3;
    }
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
    const signature = createHash('sha256').update(JSON.stringify([revision, category])).digest('hex');
    this.repeats = signature === this.signature ? this.repeats + 1 : 1; this.signature = signature;
    return this.repeats >= 3;
  }
}
