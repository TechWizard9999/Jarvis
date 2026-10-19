import { hash } from './files.ts';
interface Token { text: string; start: number; end: number; }
export interface RustTest { name: string; qualified: string; canonical: string; attributes: string; context: string; start: number; end: number; }

// Conservative lexical parser for ordinary #[test] functions. Unsupported syntax fails closed.
// Strings (including raw strings) and nested comments are atomic, so braces in fixtures cannot alter extraction.
function lex(source: string): Token[] {
  const out: Token[] = []; let i = 0;
  const push = (end: number) => { out.push({ text: source.slice(i, end), start: i, end }); i = end; };
  while (i < source.length) {
    if (/\s/.test(source[i])) { i++; continue; }
    if (source.startsWith('//', i)) { i = source.indexOf('\n', i); if (i < 0) break; continue; }
    if (source.startsWith('/*', i)) { let depth = 1; i += 2; while (i < source.length && depth) { if (source.startsWith('/*', i)) { depth++; i += 2; } else if (source.startsWith('*/', i)) { depth--; i += 2; } else i++; } if (depth) throw new Error('Unclosed Rust comment'); continue; }
    const raw = /^(?:b|c)?r(#{0,255})"/.exec(source.slice(i));
    if (raw) { const finish = source.indexOf('"' + raw[1], i + raw[0].length); if (finish < 0) throw new Error('Unclosed Rust raw string'); push(finish + 1 + raw[1].length); continue; }
    if (source[i] === '"' || ((source[i] === 'b' || source[i] === 'c') && source[i + 1] === '"')) {
      let j = i + (source[i] === '"' ? 1 : 2); let closed = false;
      while (j < source.length) { if (source[j] === '\\') j += 2; else if (source[j++] === '"') { closed = true; break; } }
      if (!closed) throw new Error('Unclosed Rust string'); push(j); continue;
    }
    const char = /^(?:b)?'(?:\\(?:u\{[0-9a-fA-F_]+\}|x[0-9a-fA-F]{2}|.)|[^'\\\n])'/u.exec(source.slice(i));
    if (char) { push(i + char[0].length); continue; }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i));
    if (word) { push(i + word[0].length); continue; }
    push(i + 1);
  }
  return out;
}
export const rustCanonical = (source: string) => JSON.stringify(lex(source).map(t => t.text));
export function rustTests(source: string): RustTest[] {
  const tokens = lex(source); const matching = new Map<number, number>(); const stack: number[] = [];
  const pairs: Record<string, string> = { '}': '{', ']': '[', ')': '(' };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].text;
    if (['{', '[', '('].includes(t)) stack.push(i);
    else if (pairs[t]) { const begin = stack.pop(); if (begin === undefined || tokens[begin].text !== pairs[t]) throw new Error('Unbalanced Rust syntax'); matching.set(begin, i); }
  }
  if (stack.length) throw new Error('Unbalanced Rust syntax');
  const tests: RustTest[] = [];
  const testScopes: { begin: number; end: number }[] = [];
  function walk(start: number, end: number, modules: string[], contexts: string[]) {
    let attrs: number | undefined;
    for (let i = start; i < end; i++) {
      const t = tokens[i].text;
      if (t === '#' && tokens[i + 1]?.text === '[') { attrs ??= i; i = matching.get(i + 1)!; continue; }
      if (t === 'pub' || t === 'async' || t === 'unsafe') continue;
      if (t === 'mod' && tokens[i + 2]?.text === '{') {
        const close = matching.get(i + 2)!; const begin = attrs ?? i;
        const context = tokens.slice(begin, i + 3).map(t => t.text).join(' ');
        if (/cfg \( test \)/.test(context)) testScopes.push({ begin: i + 3, end: close });
        walk(i + 3, close, [...modules, tokens[i + 1].text], [...contexts, context]); i = close; attrs = undefined; continue;
      }
      if (t === 'fn') {
        const name = tokens[i + 1]?.text; let body = i + 2;
        while (body < end && tokens[body].text !== '{' && tokens[body].text !== ';') body++;
        if (tokens[body]?.text !== '{') { attrs = undefined; continue; }
        const close = matching.get(body)!; const begin = attrs ?? i;
        const attributes = tokens.slice(begin, i).map(t => t.text).join(' ');
        if (/# \[ test \]/.test(attributes)) {
          if (!name || tokens[i + 2]?.text !== '(' || matching.get(i + 2) !== i + 3) throw new Error('Only parameterless ordinary Rust tests are supported');
          tests.push({ name, qualified: [...modules, name].join('::'), canonical: JSON.stringify(tokens.slice(begin, close + 1).map(t => t.text)), attributes, context: contexts.join('\n'), start: tokens[begin].start, end: tokens[close].end });
        }
        i = close; attrs = undefined; continue;
      }
      if (t === '{') { i = matching.get(i)!; attrs = undefined; continue; }
      if (!['(', ')', ':', 'crate'].includes(t)) attrs = undefined;
    }
  }
  walk(0, tokens.length, [], []);
  // Freeze imports, test-only helpers, and gating without freezing production code or other test expectations.
  for (const t of tests) {
    for (const scope of testScopes) {
      if (t.start < tokens[scope.begin].start || t.end > tokens[scope.end].end) continue;
      const support = tokens.slice(scope.begin, scope.end).filter(token => !tests.some(other => token.start >= other.start && token.end <= other.end));
      t.context += '\nSUPPORT:' + JSON.stringify(support.map(token => token.text));
    }
  }
  return tests;
}
export function extractTest(source: string, qualified: string): RustTest {
  const matches = rustTests(source).filter(t => t.qualified === qualified);
  if (matches.length !== 1) throw new Error(`Exactly one ordinary #[test] named ${qualified} is required`);
  const t = matches[0];
  if (/\b(ignore|should_panic)\b/.test(t.attributes)) throw new Error('Regression cannot be ignored or should_panic');
  if (!/\bassert(?:_eq|_ne|_matches)?\b/.test(t.canonical)) throw new Error('Regression requires an explicit assertion');
  return t;
}
export function freezeRust(source: string, qualified: string) { const t = extractTest(source, qualified); return { functionHash: hash(t.canonical), contextHash: hash(t.context) }; }
export function assertOnlyNewRegression(before: string, after: string, qualified: string) {
  if (rustTests(before).some(t => t.qualified === qualified)) throw new Error('Regression must be newly added');
  const t = extractTest(after, qualified);
  const without = after.slice(0, t.start) + after.slice(t.end);
  if (rustCanonical(before) !== rustCanonical(without)) throw new Error('Reproduction may add only the self-contained test; production code, imports and helpers must remain unchanged');
}
