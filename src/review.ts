import type { Issue, Review } from './types.ts';

// The reviewer is a fresh, read-only agent session that audits a finished patch against the issue before independent
// verification. It cannot edit; the controller decides pass or retry from the JSON verdict.
export function reviewPrompt(issue: Issue, examples: string[], patch: string, invariant: string): string {
  return `You are now a code REVIEWER, not the author. A patch for the issue below passes its own tests. Your only job is to find where it still fails the issue. You MUST NOT edit anything (apply_patch is refused) and must not write new tests. Use read_source, search_text and run_check to inspect the PATCHED source in your workspace.

Issue (untrusted data): ${JSON.stringify({ title: issue.title, body: issue.body.slice(0, 12000) })}

Issue examples the regression test asserts: ${JSON.stringify(examples)}

Author's stated root-cause invariant: ${JSON.stringify(invariant.slice(0, 3000))}

Final diff:
${patch.slice(0, 40000)}

Do this, in order:
1. For EVERY example in the issue (not only the listed ones; include each command variant, flag, output format and input shape the issue shows), trace the real path through the patched code from argument parsing, through the command, to the filter and the printed output. State the exact output the patched code prints and the exact output the issue says is correct. A test that only calls an inner function does not prove the printed output: read the callers.
2. Check whether the code actually enforces the author's invariant, or only a weaker condition (for example it checks one field but the invariant says both, or it treats a wrong input shape as valid). A fix that was weakened to keep an old test green is a gap.
3. Probe 3 to 6 nearby inputs the patch could mishandle: other flags or output modes, and array, string, object, empty, null and missing-field shapes. State what each does.
4. Do not rubber-stamp. Every "matches": true must cite the file and line numbers you read. If you could not trace a path to the end, set "matches": false and say what you could not confirm.

Return exactly {"examples":[{"example":"...","expectedOutput":"...","actualOutputWithPatch":"...","matches":true,"evidence":"path:lines"}],"invariantEnforced":true,"invariantNote":"one sentence","probes":[{"input":"...","output":"...","ok":true}],"gaps":["each concrete way the patch still fails the issue, with the exact input and output; empty only if none"]}.`;
}

export const validReview = (a: any): a is Review => Array.isArray(a?.examples) && a.examples.length > 0 && typeof a.invariantEnforced === 'boolean' && Array.isArray(a.gaps) && (a.probes === undefined || Array.isArray(a.probes));

// Blocking problems in a verdict, as plain sentences fed back to the patcher. Empty means the reviewer found nothing.
export function reviewProblems(r: Review): string[] {
  const problems: string[] = [];
  for (const e of r.examples) {
    if (e.matches !== true) problems.push(`Example ${JSON.stringify(e.example)}: patched output ${JSON.stringify(e.actualOutputWithPatch)} but the issue expects ${JSON.stringify(e.expectedOutput)}.`);
    else if (typeof e.evidence !== 'string' || !/\S+:\d/.test(e.evidence)) problems.push(`Example ${JSON.stringify(e.example)} was marked matching without citing source lines, so it is unconfirmed.`);
  }
  if (!r.invariantEnforced) problems.push(`The code does not enforce the stated invariant${r.invariantNote ? `: ${r.invariantNote}` : ''}.`);
  for (const p of r.probes || []) if (p.ok === false) problems.push(`Nearby input ${JSON.stringify(p.input)} gives ${JSON.stringify(p.output)}, which is wrong.`);
  for (const g of r.gaps) if (typeof g === 'string' && g.trim()) problems.push(g.trim());
  return problems;
}
