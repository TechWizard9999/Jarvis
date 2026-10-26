/** Scripted release fixtures supply actual assertion/read witnesses; this is not a semantic reviewer. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { rustTests } from '../src/rust.ts';
import type { Pipeline } from '../src/pipeline.ts';
import type { Manifest, Regression } from '../src/types.ts';
import type { CoverageReview } from '../src/coverage-review.ts';

export async function scriptedCoverageReview(pipeline: Pipeline, run: Manifest, explanation: string, scenarios: Regression[] = (run.regressions || []).map(regression => regression.spec)): Promise<CoverageReview> {
  const rows: CoverageReview['rows'] = [];
  for (const spec of scenarios) {
    const source = await fs.readFile(path.join(pipeline.store.dir(run.id), 'source', spec.file), 'utf8');
    const test = rustTests(source).find(test => test.qualified === spec.testName);
    if (!test) throw new Error(`Scripted fixture is missing ${spec.testName}`);
    const body = source.slice(test.start, test.end);
    const assertion = /\bassert(?:_eq|_ne|_matches)?!\s*\(/.exec(body);
    if (!assertion) throw new Error(`Scripted fixture has no direct assertion in ${spec.testName}`);
    const start = test.start + assertion.index;
    let position = source.indexOf('(', start), depth = 0, quoted = false;
    for (; position < test.end; position++) {
      const character = source[position];
      if (quoted) { if (character === '\\') position++; else if (character === '"') quoted = false; continue; }
      if (character === '"') { quoted = true; continue; }
      if (character === '(') depth++;
      if (character === ')' && --depth === 0) break;
    }
    if (position >= test.end) throw new Error('Scripted assertion is unbalanced');
    const startLine = source.slice(0, start).split('\n').length;
    const endLine = source.slice(0, position + 1).split('\n').length;
    const read = await pipeline.tool(run.id, 'read_source', { path: spec.file, start: startLine, end: endLine });
    rows.push({
      requirementId: spec.id!, file: spec.file, testName: spec.testName,
      clauses: [{ behavior: spec.expectedBehavior, assertion: { startLine, endLine, sourceReadEvidenceId: read.evidenceId }, explanation: 'The cited direct assertion is the scripted fixture witness.' }],
      counterexamples: ['An implementation violating this asserted behavior must not satisfy the fixture.'],
    });
  }
  return { complete: true, missing: [], explanation, rows };
}
