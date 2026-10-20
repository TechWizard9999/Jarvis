import fs from 'node:fs/promises';
import { fingerprint, hash, inventory, sourcePath } from './files.ts';
import { validateScenarioCoverage } from './acceptance.ts';
import { inFileTestName } from './policy.ts';
import { extractTest } from './rust.ts';
import type { AcceptanceRequirement, FrozenRegression, RunEvent } from './types.ts';

export interface CoverageAssertionWitness { startLine: number; endLine: number; sourceReadEvidenceId: number; }
export interface CoverageClause { behavior: string; assertion: CoverageAssertionWitness | null; explanation: string; }
export interface CoverageReviewRow { requirementId: string; file: string; testName: string; clauses: CoverageClause[]; counterexamples: string[]; }
export interface CoverageReview { complete: boolean; missing: string[]; explanation: string; rows: CoverageReviewRow[]; }

/** Shared reply contract; placeholders must be replaced with actual frozen identities and read results. */
export function coverageReviewPromptSchema(): string {
  return `Decompose every frozen requirement's expectedBehavior into its individual observable clauses, including every conjunction, count, usable recovery, exit status, platform condition and passing control that applies. For every declared clause cite a complete direct assertion macro invocation in that requirement's exact frozen test, using its actual inclusive start/end source lines and a current read_source evidenceId from this review. Inspect all relevant source and fixtures before deciding whether the assertion truly establishes the behavior. Only direct assert!, assert_eq!, assert_ne! and assert_matches! invocations in the bound ordinary test are supported as witnesses; helper-only assertions, assertions in nested functions/closures/deferred bodies, and assertions inside other macro token trees are unsupported. Ordinary if/for blocks are supported, but source syntax alone cannot establish reachability. Use assertion:null and complete:false with nonempty missing when an assertion is absent, insufficient, helper-only, unsupported, or a clause is unexamined. Do not waive passing controls. Counterexamples are specific reviewer reasoning about what a deficient implementation could get wrong; they are not executed mutations. The controller validates provenance and assertion syntax, while semantic adequacy and completeness of clause decomposition remain your review judgment. Return exactly this JSON shape, with one row for every required requirement (also any optional requirement you review):
${JSON.stringify({ complete: true, missing: [], explanation: 'Explain why the examined assertions establish all required behavior.', rows: [{ requirementId: 'frozen-requirement-id', file: 'src/lib.rs', testName: 'tests::frozen_test', clauses: [{ behavior: 'One observable clause copied or precisely decomposed from expectedBehavior.', assertion: { startLine: 1, endLine: 1, sourceReadEvidenceId: 1 }, explanation: 'Explain exactly what this assertion checks and why it establishes this clause.' }], counterexamples: ['Describe a concrete deficient implementation this clause must catch.'] }] })}
Scope checks use conservative lexical recognition of supported Rust forms. The controller does not build a full Rust AST or prove runtime execution; report unsupported forms honestly.`;
}

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
};
const text = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be nonempty text`);
  return value.trim();
};
const texts = (value: unknown, label: string, nonempty = false): string[] => {
  if (!Array.isArray(value) || (nonempty && !value.length)) throw new Error(`${label} must be ${nonempty ? 'a nonempty' : 'an'} array`);
  return Array.from(value, item => text(item, label));
};
const positiveInteger = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`);
  return value;
};
function evidenceId(value: unknown): number {
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) return positiveInteger(Number(value), 'Source read evidence ID');
  return positiveInteger(value, 'Source read evidence ID');
}

// Mask full-source comments and literals before looking for assertion syntax. Keeping offsets
// avoids interpreting a claimed line in isolation while it is actually inside a multiline literal.
function maskLiterals(source: string): string {
  let result = '', i = 0;
  const mask = (end: number) => { result += source.slice(i, end).replace(/[^\n]/g, ' '); i = end; };
  while (i < source.length) {
    if (source.startsWith('//', i)) { const end = source.indexOf('\n', i); mask(end < 0 ? source.length : end); continue; }
    if (source.startsWith('/*', i)) {
      let depth = 1, end = i + 2;
      while (end < source.length && depth) { if (source.startsWith('/*', end)) { depth++; end += 2; } else if (source.startsWith('*/', end)) { depth--; end += 2; } else end++; }
      if (depth) throw new Error('Unclosed Rust comment in coverage source');
      mask(end); continue;
    }
    const raw = /^(?:b|c)?r(#{0,255})"/.exec(source.slice(i));
    if (raw) {
      const end = source.indexOf('"' + raw[1], i + raw[0].length);
      if (end < 0) throw new Error('Unclosed Rust raw string in coverage source');
      mask(end + 1 + raw[1].length); continue;
    }
    if (source[i] === '"' || ((source[i] === 'b' || source[i] === 'c') && source[i + 1] === '"')) {
      let end = i + (source[i] === '"' ? 1 : 2), closed = false;
      while (end < source.length) { if (source[end] === '\\') end += 2; else if (source[end++] === '"') { closed = true; break; } }
      if (!closed) throw new Error('Unclosed Rust string in coverage source');
      mask(end); continue;
    }
    const char = /^(?:b)?'(?:\\(?:u\{[0-9a-fA-F_]+\}|x[0-9a-fA-F]{2}|.)|[^'\\\n])'/u.exec(source.slice(i));
    if (char) { mask(i + char[0].length); continue; }
    result += source[i++];
  }
  return result;
}

function assertionRanges(source: string, start: number, end: number): [number, number][] {
  const code = maskLiterals(source), ranges: [number, number][] = [];
  // Tokenize whole Unicode/raw identifiers: matching only an ASCII suffix can expose the
  // interior of an opaque macro such as mé!(assert!(...)) or macro_rules! r#mé { ... }.
  const tokens = Array.from(code.slice(start, end).matchAll(/(?:r#)?[_\p{ID_Start}][_\p{ID_Continue}]*|::|->|=>|\|\||\S/gu), match => ({ text: match[0], start: start + match.index, end: start + match.index + match[0].length }));
  const identifier = (value: string) => /^(?:r#)?[_\p{ID_Start}][_\p{ID_Continue}]*$/u.test(value);
  const closeFor: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const matching = new Map<number, number>(), stack: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (closeFor[tokens[i].text]) stack.push(i);
    else if ([')', '}', ']'].includes(tokens[i].text)) {
      const open = stack.pop();
      if (open === undefined || closeFor[tokens[open].text] !== tokens[i].text) throw new Error('Unbalanced coverage source');
      matching.set(open, i);
    }
  }
  if (stack.length) throw new Error('Incomplete coverage source');
  const word = (i: number) => tokens[i]?.text ?? '';
  // Local function signatures can contain type groups and const generics. Only the body
  // outside those groups belongs to the item; none of its assertions are direct witnesses.
  function itemBody(begin: number, limit: number): number {
    let angles = 0;
    for (let i = begin; i < limit; i++) {
      const token = word(i);
      if (token === '<') angles++;
      else if (token === '>') angles = Math.max(0, angles - 1);
      else if (token === '{' && !angles) return i;
      else if (matching.has(i)) i = matching.get(i)!;
      else if (token === ';' && !angles) return -1;
    }
    return -1;
  }
  const outerFn = tokens.findIndex(token => token.text === 'fn'), body = itemBody(outerFn + 2, tokens.length);
  if (outerFn < 0 || body < 0) throw new Error('Coverage requires an ordinary test body');
  const bodyEnd = matching.get(body)!;
  const closurePrefixes = new Set(['=', '(', '[', '{', ',', ':', '=>', ';', 'return', 'break', 'yield', 'move', 'async', '&', 'mut']);
  const isClosure = (i: number, expressionStart = -1) => (word(i) === '|' || word(i) === '||') && (i === expressionStart || closurePrefixes.has(word(i - 1)) || (word(i - 3) === 'break' && word(i - 2) === "'" && identifier(word(i - 1))));
  function closureEnd(begin: number): number {
    let expression = begin + 1;
    if (word(begin) === '|') {
      // Parameter patterns/types may contain grouped commas. They end at the closing pipe.
      for (; expression < bodyEnd && word(expression) !== '|'; expression++) if (matching.has(expression)) expression = matching.get(expression)!;
      if (expression === bodyEnd) throw new Error('Unsupported closure parameter syntax in coverage source');
      expression++;
    }
    if (word(expression) === '->') {
      const open = itemBody(expression + 1, bodyEnd);
      if (open < 0) throw new Error('Unsupported typed closure body in coverage source');
      return matching.get(open)! + 1;
    }
    return expressionEnd(expression);
  }
  function expressionEnd(begin: number): number {
    let angles = 0;
    for (let i = begin; i < bodyEnd; i++) {
      if (isClosure(i, begin)) i = closureEnd(i) - 1;
      else if (matching.has(i)) i = matching.get(i)!;
      else if (word(i) === '<' && (angles > 0 || word(i - 1) === '::' || i === begin)) angles++;
      else if (word(i) === '>' && angles > 0) angles--;
      else if (!angles && [',', ';', ')', ']', '}'].includes(word(i))) return i;
    }
    return bodyEnd;
  }
  for (let i = body + 1; i < bodyEnd; i++) {
    const token = word(i);
    if (identifier(token) && word(i + 1) === '!') {
      const open = token === 'macro_rules' && identifier(word(i + 2)) ? i + 3 : i + 2;
      if (!matching.has(open)) throw new Error('Unsupported coverage macro syntax');
      const close = matching.get(open)!;
      if (/^assert(?:_eq|_ne|_matches)?$/.test(token.replace(/^r#/, ''))) {
        let begin = i;
        while (begin >= 2 && word(begin - 1) === '::' && identifier(word(begin - 2))) begin -= 2;
        ranges.push([source.slice(0, tokens[begin].start).split('\n').length, source.slice(0, tokens[close].start).split('\n').length]);
      }
      i = close; // All other macro token trees are opaque, including Unicode/raw macro names.
    } else if (token === 'fn' && identifier(word(i + 1))) {
      const open = itemBody(i + 2, bodyEnd);
      if (open < 0) { i = expressionEnd(i + 2); continue; }
      i = matching.get(open)!;
    } else if (isClosure(i)) {
      i = closureEnd(i) - 1;
    } else if (token === 'async' && (word(i + 1) === '{' || (word(i + 1) === 'move' && word(i + 2) === '{'))) {
      i = matching.get(word(i + 1) === '{' ? i + 1 : i + 2)!;
    } else if (['const', 'static'].includes(token)) {
      // const fn is a local function item, not an initializer extending to the next semicolon.
      let next = i + 1;
      while (['unsafe', 'extern'].includes(word(next))) next++;
      if (token === 'const' && word(next) === 'fn' && identifier(word(next + 1))) continue;
      i = expressionEnd(i + 1) - 1;
    }
  }
  return ranges;
}

/**
 * Validates declared clause coverage, frozen identities and current source provenance. Scope
 * recognition is conservative lexical analysis of supported forms, not a full Rust AST. It cannot
 * infer natural-language clauses, prove execution, or establish the reviewer's semantic claim.
 * The caller must pass only events recorded after its trusted fresh-review boundary: existing
 * read_source result records have no phase/session identity from which to infer that boundary.
 */
export async function validateCoverageReview(review: unknown, requirements: AcceptanceRequirement[], regressions: FrozenRegression[], sourceRoot: string, events: RunEvent[], signal?: AbortSignal): Promise<CoverageReview> {
  signal?.throwIfAborted();
  validateScenarioCoverage(requirements, regressions.map(regression => regression.spec));
  const answer = object(review, 'Coverage review');
  if (typeof answer.complete !== 'boolean') throw new Error('Coverage review complete must be a boolean');
  const missing = texts(answer.missing, 'Coverage review missing'), explanation = text(answer.explanation, 'Coverage review explanation');
  if (answer.complete ? missing.length > 0 : missing.length === 0) throw new Error('Coverage review complete and missing must agree');
  if (!Array.isArray(answer.rows) || !answer.rows.length) throw new Error('Coverage review rows must enumerate the frozen requirements');
  const initialFiles = await inventory(sourceRoot, signal), revision = fingerprint(initialFiles);
  const sources = new Map<string, string>(), ids = new Set<string>();
  const rows: CoverageReviewRow[] = [];
  for (const rawRow of answer.rows) {
    signal?.throwIfAborted();
    const row = object(rawRow, 'Coverage review row'), requirementId = text(row.requirementId, 'Coverage requirement ID');
    if (ids.has(requirementId)) throw new Error(`Duplicate coverage requirement: ${requirementId}`);
    ids.add(requirementId);
    if (!requirements.some(requirement => requirement.id === requirementId)) throw new Error(`Unknown coverage requirement: ${requirementId}`);
    const matches = regressions.filter(regression => regression.spec.id === requirementId);
    if (matches.length !== 1) throw new Error(`Coverage requirement ${requirementId} needs exactly one frozen scenario`);
    const frozen = matches[0], spec = frozen.spec;
    if (row.file !== spec.file || row.testName !== spec.testName) throw new Error(`Coverage row ${requirementId} changed its frozen file or testName`);
    let source = sources.get(spec.file);
    if (source === undefined) { source = await fs.readFile(await sourcePath(sourceRoot, spec.file), { encoding: 'utf8', signal }); sources.set(spec.file, source); }
    const contentHash = hash(source);
    if (!initialFiles[spec.file]?.endsWith(':' + contentHash)) throw new Error('Coverage source changed during review validation');
    const integration = spec.target?.kind === 'integration';
    if (integration && !frozen.wholeFileHash) throw new Error('Frozen integration coverage requires a whole file hash');
    if (frozen.wholeFileHash && frozen.wholeFileHash !== contentHash) throw new Error(`Frozen integration file hash changed: ${spec.file}`);
    const test = extractTest(source, inFileTestName(spec), integration);
    if (hash(test.canonical) !== frozen.functionHash || hash(test.context) !== frozen.contextHash) throw new Error(`Frozen test hash changed: ${spec.testName}`);
    const assertions = assertionRanges(source, test.start, test.end);
    if (!Array.isArray(row.clauses) || !row.clauses.length) throw new Error(`Coverage row ${requirementId} needs examined clauses`);
    const clauses: CoverageClause[] = [], behaviors = new Set<string>();
    for (const rawClause of row.clauses) {
      const clause = object(rawClause, 'Coverage clause'), behavior = text(clause.behavior, 'Clause behavior'), clauseExplanation = text(clause.explanation, 'Clause explanation');
      const key = behavior.replace(/\s+/g, ' ');
      if (behaviors.has(key)) throw new Error(`Duplicate coverage clause: ${behavior}`);
      behaviors.add(key);
      if (clause.assertion === null && !answer.complete) { clauses.push({ behavior, assertion: null, explanation: clauseExplanation }); continue; }
      const asserted = object(clause.assertion, 'Clause assertion witness');
      const startLine = positiveInteger(asserted.startLine, 'Assertion start line'), endLine = positiveInteger(asserted.endLine, 'Assertion end line'), sourceReadEvidenceId = evidenceId(asserted.sourceReadEvidenceId);
      if (endLine < startLine || !assertions.some(([start, end]) => start === startLine && end === endLine)) throw new Error(`Clause assertion range must name a complete direct assertion in frozen test ${spec.testName}`);
      const found = events.filter(event => event.seq === sourceReadEvidenceId);
      if (found.length !== 1) throw new Error(`Source read evidence ${sourceReadEvidenceId} must resolve to one unique recorded result`);
      const event = found[0], record = object(event.data, 'Source read evidence record');
      if (event.source !== 'tool' || event.kind !== 'result' || record.tool !== 'read_source') throw new Error(`Source read evidence ${sourceReadEvidenceId} must be a read_source tool result`);
      const callId = positiveInteger(record.call, 'Source read invocation ID');
      const calls = events.filter(candidate => candidate.seq === callId);
      if (calls.length !== 1 || callId >= event.seq || calls[0].source !== 'tool' || calls[0].kind !== 'called') throw new Error('Source read invocation must begin during the current review');
      const call = object(calls[0].data, 'Source read invocation');
      if (call.tool !== 'read_source' || object(call.args, 'Source read invocation arguments').path !== spec.file) throw new Error('Source read invocation must match the frozen test file');
      const read = object(record.result, 'Source read result');
      if (read.path !== spec.file) throw new Error('Source read evidence path must match the frozen test file');
      if (read.contentHash !== contentHash || read.sourceHash !== revision) throw new Error('Source read evidence is stale; read current source during this review');
      const readStart = positiveInteger(read.start, 'Source read range start'), readEnd = positiveInteger(read.end, 'Source read range end');
      if (readStart > startLine || readEnd < endLine || readEnd < readStart) throw new Error('Source read evidence range must contain the complete assertion');
      clauses.push({ behavior, assertion: { startLine, endLine, sourceReadEvidenceId }, explanation: clauseExplanation });
    }
    rows.push({ requirementId, file: spec.file, testName: spec.testName, clauses, counterexamples: texts(row.counterexamples, 'Coverage counterexamples', true) });
  }
  for (const requirement of requirements) if (requirement.required !== false && !ids.has(requirement.id)) throw new Error(`Missing required coverage row: ${requirement.id}`);
  if (fingerprint(await inventory(sourceRoot, signal)) !== revision) throw new Error('Coverage source changed during review validation');
  signal?.throwIfAborted();
  return { complete: answer.complete, missing, explanation, rows };
}
