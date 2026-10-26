import type { Manifest, Review } from '../src/types.ts';

// Scripted fixture replies only; real reviewer behavior is exercised by the adapter/live runs separately.
export function scriptedCandidateReview(run: Manifest): Review {
  return { examples: (run.regressions || [run.regression!]).map(r => ({ example: r.spec.citation, expectedOutput: r.spec.expectedBehavior, actualOutputWithPatch: r.spec.expectedBehavior, matches: true, evidence: `${r.spec.file}:1` })), invariantEnforced: true, invariantNote: 'The scripted fixture preserves the declared behavior.', probes: [], gaps: [] };
}
export function scriptedDescription() {
  return { title: 'fix(fixture): preserve reported output', explanation: 'The original predicate discarded the reported error output. The verified implementation preserves nonempty output and retains the existing normal-output behavior.' };
}
