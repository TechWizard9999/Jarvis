import fs from 'node:fs/promises';
import path from 'node:path';
import type { Manifest } from './types.ts';
import type { Store } from './store.ts';

const clean = (text: string) => text.replace(/[\r\n\x00-\x1f\x7f]+/g, ' ').trim();
export function prTitle(run: Manifest) {
  if (run.summary?.title) return clean(run.summary.title).slice(0, 120);
  const title = clean(run.issue?.title || `Resolve issue ${run.issue?.number || run.input.issue.split('/').at(-1)}`).replace(/^(?:bug|fix|feature)\s*:\s*/i, '');
  return `fix: ${title.charAt(0).toLowerCase()}${title.slice(1)}`.slice(0, 120);
}
export async function writeReport(store: Store, run: Manifest) {
  const explanation = run.summary?.explanation || run.candidate?.explanation;
  const flags = run.candidate?.snapshots || [];
  const artifact = (file: string, label: string = file) => `[${label}](/api/runs/${run.id}/artifact?path=${encodeURIComponent(file)})`;
  const evidence = (seq: number) => `[#${seq}](/?run=${run.id}&event=${seq}#event-${seq})`;
  const requests = run.modelRequests || [];
  const usage = run.demo ? '0 (simulated demo)' : requests.length ? `${run.tokens} reported${requests.some(r => r.usage !== 'complete') ? '; includes requests with unknown or partial usage' : ''}` : run.tokens ? `${run.tokens} (legacy total; per-request completeness unknown)` : 'unknown (no provider usage recorded)';
  const original = run.publication?.originalVerifiedCommit || run.verifiedCommit;
  const changed = run.publication?.changedSinceVerification || !!(run.publication?.currentHead && original && run.publication.currentHead !== original);
  const regressions = run.regressions || (run.regression ? [run.regression] : []);
  const baselineFailures=regressions.filter(r=>r.spec.baseline!=='pass'),controls=regressions.filter(r=>r.spec.baseline==='pass');
  const examples = regressions.flatMap(frozen => (frozen.spec.examples || []).map(example => `- \`${frozen.spec.testName}\`: \`${clean(example).slice(0, 300)}\``));
  const reviewerGaps = run.review?.unresolved.map(gap => `- ${clean(gap).slice(0, 500)}`) || [];
  const verified = !!(run.verifiedCommit && run.verifiedTree);
  const checkStatus=(check: Manifest['checks'][number])=>check.status==='no_match' || check.matched===0?'no tests matched':check.timedOut?'timed out':check.exitCode===0?'passed':'failed';
  const lines = [
    `# ${run.profile?.id || 'Repository'} issue ${run.issue?.number || ''} — ${run.outcome || run.stage}`,
    '', `Issue: ${run.issue?.url || run.input.issue}`, '',
    run.demo ? '**SIMULATED DEMO: no repository repair or verification was performed.**' : `Base commit: \`${run.baseSha || 'unresolved'}\``,
    `Model: \`${run.model || 'not contacted'}\``, `Environment image: \`${run.imageId || 'not prepared'}\``,
    `Retrieval: ${run.input.retrieval || 'graph'}; tools: ${run.tools}; reported model tokens: ${usage}`,
    `Execution: ${run.executionStartedAt || run.createdAt} → ${run.executionFinishedAt || (run.outcome ? 'finish time unavailable for this historical run' : 'running')}${run.failureStage ? `; stopped during ${run.failureStage}` : ''}`,
    ...(run.runConfig ? [`Configuration: ${artifact(run.runConfig.artifact)}; SHA-256 \`${run.runConfig.sha256}\``] : ['Configuration provenance: unavailable for this historical run.']),
    '', '## Cause and change', '', explanation || 'No accepted candidate was produced.',
    ...(run.candidate?.evidenceIds.length ? ['', `Source evidence: ${[...new Set(run.candidate.evidenceIds)].map(evidence).join(', ')}. Event citations must be checked against the candidate revision.`] : []),
    '', '## Regression evidence', '',
    ...(regressions.length ? regressions.map(frozen => `Test: \`${frozen.spec.testName}\` in \`${frozen.spec.file}\`\n\nExpected behavior: ${frozen.spec.expectedBehavior}\n\nIssue excerpt${frozen.spec.citationVerified === false ? ' (**not a verbatim excerpt; human review required**)' : ''}: ${frozen.spec.citation || '(none given)'}\n\nBaseline expectation: ${frozen.spec.baseline==='pass'?'passing control':'assertion failure'}.\n\nFrozen test hash: \`${frozen.functionHash}\``) : ['A valid failing regression was not established.']),
    ...(run.acceptanceReview ? [`Model coverage assessment: ${run.acceptanceReview.complete ? 'complete' : `incomplete; missing: ${run.acceptanceReview.missing.join(', ')}`}. ${run.acceptanceReview.explanation}`, 'This assessment records the coverage reviewer’s conclusion; independent behavior review may identify gaps.', artifact('acceptance-plan.json', 'Frozen acceptance plan'),artifact('acceptance-review.json','Model coverage assessment')] : []),
    ...(examples.length ? ['', '## Issue examples asserted by the regression tests (agent-declared; review that none is missing)', '', ...examples] : []),
    ...(run.review ? ['', '## Independent review', '', run.review.passed ? `Reviewer (${run.review.rounds} round${run.review.rounds > 1 ? 's' : ''}) traced the issue examples and found no gaps.` : `**Reviewer gaps still open after ${run.review.rounds} rounds; human review required:**`, ...reviewerGaps] : []),
    '', '## Checks', '',
    ...run.checks.map(c => `- ${c.id}: ${checkStatus(c)}; exit ${c.exitCode}${c.timedOut ? ' (timeout)' : ''}; ${Math.round(c.durationMs / 1000)}s; \`${c.argv.join(' ')}\`; ${artifact(c.log,'check log')}`),
    ...(Object.keys(run.profile?.skipTests || {}).length ? ['', '## Skipped upstream tests', '', ...Object.entries(run.profile!.skipTests!).map(([name, reason]) => `- \`${name}\`: ${reason}`)] : []),
    '', '## Snapshot review', '', ...(flags.length ? flags.map(s => `- **Human review required:** \`${s.path}\` (owner \`${s.owner}\`): ${s.reason}`) : ['No snapshot changes declared.']),
    '', '## Operator interventions', '',
    `Operator interventions: ${run.interventions?.length || 0}${run.interventions?.length ? '; operator assistance is recorded separately from model actions.' : '; no records are available, which does not establish an unassisted historical run.'}`,
    ...(run.interventions || []).map(note=>`- ${note.time} · ${note.kind}: ${note.message}`),
    '', '## Request usage', '',
    ...(requests.length ? ['| Request | Status | Attempts | Latency | Input | Output | Total | Usage |', '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |', ...requests.map(r => `| ${r.id} | ${r.status} | ${r.attempts} | ${r.latencyMs === undefined ? 'unknown' : `${r.latencyMs}ms`} | ${r.inputTokens ?? 'unknown'} | ${r.outputTokens ?? 'unknown'} | ${r.totalTokens ?? 'unknown'} | ${r.usage} |`), '', 'Retries may incur provider usage that was not returned. Reported totals are cumulative request usage, not unique generated text or a billing estimate.'] : ['Per-request usage was not recorded.']),
    '', '## Publication', '',
    run.publication?.url || `State: ${run.publication?.state || 'not requested'}`,
    `Original verified commit: \`${original || 'none'}\`. Current PR head: \`${run.publication?.currentHead || 'not inspected'}\`.`,
    ...(changed ? ['**PR changed since verification.** Local verification applies to the original verified commit; later changes need separate evidence.'] : []),
    ...(run.publication?.reviewState || run.publication?.ciState || run.publication?.claState ? [`Review: ${run.publication.reviewState || 'unknown'}; CI: ${run.publication.ciState || 'unknown'}; CLA: ${run.publication.claState || 'unknown'}.`] : []),
    ...(run.publication?.error ? [run.publication.error] : []),
    '', '## Limits', '',
    'Verification covers the recorded Linux checks and feature configurations. Upstream CI, multiplatform behavior, review, and CLA state require their own evidence. Source stream recovery reconstructs message state; missing intermediate status/tool events remain a coverage gap.',
    ...(run.error ? ['', '## Stopping reason', '', run.error] : []),
    '', `Verified Git tree: \`${run.verifiedTree || 'none'}\``, `Verified commit: \`${run.verifiedCommit || 'none'}\``, '',
  ];
  await fs.writeFile(path.join(store.dir(run.id), 'report.md'), lines.join('\n'));
  const pr = [
    run.summary?.explanation || (explanation || prTitle(run).replace(/^fix: /, '')).split(/\n\s*\n/)[0].slice(0, 900), '', `Refs ${run.issue?.url || run.input.issue}`, '',
    '### Reproduction and validation', '',
    ...(baselineFailures.length ? [`Baseline failures: ${baselineFailures.map(r=>`\`${r.spec.testName}\``).join(', ')}${verified ? '; passed with the change.' : '; candidate verification is not complete.'}`] : []),
    ...(controls.length ? [`Passing controls: ${controls.map(r=>`\`${r.spec.testName}\``).join(', ')}${verified ? '; passed on both the baseline and the candidate.' : '; candidate verification is not complete.'}`] : []),
    ...(examples.length ? ['', 'Issue examples asserted by the tests (agent-declared):', ...examples] : []),
    ...(run.review && !run.review.passed ? ['', 'Open reviewer findings (human review required):', ...reviewerGaps] : []),
    ...run.checks.filter(c => c.id.startsWith('final-')).map(c => `- \`${c.argv.join(' ')}\`: ${checkStatus(c)}`),
    ...Object.entries(run.profile?.skipTests || {}).map(([name, reason]) => `Not run locally: \`${name}\` — ${reason}`),
    ...flags.map(s => `Snapshot review required: \`${s.path}\` — ${s.reason}`), '',
    `Verified tree: \`${run.verifiedTree || 'none'}\`.`, '',
    'Local Linux verification is recorded separately from upstream CI, maintainer review, and any required CLA action.', '',
  ];
  await fs.writeFile(path.join(store.dir(run.id), 'report-pr.md'), pr.join('\n'));
}
