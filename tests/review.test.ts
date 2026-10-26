import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewProblems, reviewPrompt, validReview } from '../src/review.ts';

const ok = { examples: [{ example: 'a', expectedOutput: 'x', actualOutputWithPatch: 'x', matches: true, evidence: 'src/a.rs:10-20' }], invariantEnforced: true, probes: [{ input: 'i', output: 'o', ok: true }], gaps: [] };

test('a clean verdict has no blocking problems', () => { assert.ok(validReview(ok)); assert.deepEqual(reviewProblems(ok), []); });
test('mismatch, weak invariant, bad probe, gap and uncited match each block', () => {
  const bad = { ...ok, examples: [{ ...ok.examples[0], matches: false, actualOutputWithPatch: 'y' }, { ...ok.examples[0], evidence: 'trust me' }], invariantEnforced: false, probes: [{ input: 'i', output: 'o', ok: false }], gaps: ['text output still JSON'] };
  assert.equal(reviewProblems(bad).length, 5);
});
test('malformed verdicts are rejected and the prompt forbids edits', () => {
  assert.equal(validReview({ examples: [], invariantEnforced: true, gaps: [] }), false);
  assert.match(reviewPrompt({ url: 'u', number: 1, title: 't', body: 'b' }, ['e'], 'diff', 'inv'), /MUST NOT edit/);
});
