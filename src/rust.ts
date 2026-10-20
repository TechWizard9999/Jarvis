import { hash } from './files.ts';
interface Token { text: string; start: number; end: number; }
export interface RustTest { name: string; qualified: string; canonical: string; attributes: string; context: string; start: number; end: number; }

// Conservative lexical parser. Item macros and unfamiliar function attributes are opaque protected
// support, so changing test-generating syntax that we cannot interpret requires explicit review.
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
export interface RustTestModule { modules: string[]; name: string; path?: string; }
function parseRust(source: string, inheritedTestScope = false) {
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
  const support: string[] = [], externalModules: RustTestModule[] = [];
  const canonical = (begin: number, end: number) => JSON.stringify(tokens.slice(begin, end).map(t => t.text));
  const testGated = (attributes: string) => /\b(?:cfg|cfg_attr)\b/.test(attributes) && /\btest\b/.test(attributes);
  const attributesFor = (begin: number, end: number) => tokens.slice(begin, end).map(t => t.text).join(' ');
  const attributeNames = (attributes: string) => [...attributes.matchAll(/#\s*!?\s*\[\s*([A-Za-z_][A-Za-z0-9_]*(?:\s*:\s*:\s*[A-Za-z_][A-Za-z0-9_]*)*)/g)].map(m => m[1].replace(/\s/g, '').split('::').at(-1)!);
  const ordinaryAttributes = new Set(['test', 'cfg', 'cfg_attr', 'allow', 'warn', 'deny', 'forbid', 'expect', 'inline', 'cold', 'no_mangle', 'export_name', 'link_section', 'must_use', 'deprecated', 'doc', 'target_feature', 'track_caller', 'ignore', 'should_panic']);
  const isTest = (attributes: string) => attributeNames(attributes).some(name => name === 'test' || name === 'rstest' || name.startsWith('test_'));
  function walk(start: number, end: number, modules: string[], contexts: string[], inTestScope = false) {
    let attrs: number | undefined;
    const inner: string[] = [];
    for (let i = start; i < end && tokens[i].text === '#' && tokens[i + 1]?.text === '!';) {
      if (tokens[i + 2]?.text !== '[') throw new Error('Unsupported Rust inner attribute');
      const close = matching.get(i + 2)!; inner.push(canonical(i, close + 1)); i = close + 1;
    }
    const scopeContexts = [...contexts, ...inner];
    if (inner.length) support.push(JSON.stringify([modules, inner]));
    if (inner.some(testGated)) { inTestScope = true; testScopes.push({ begin: start, end }); }
    for (let i = start; i < end; i++) {
      const t = tokens[i].text;
      if (t === '#' && tokens[i + 1]?.text === '!' && tokens[i + 2]?.text === '[') { i = matching.get(i + 2)!; attrs = undefined; continue; }
      if (t === '#' && tokens[i + 1]?.text === '[') { attrs ??= i; i = matching.get(i + 1)!; continue; }
      if (t === 'pub') { if (tokens[i + 1]?.text === '(') i = matching.get(i + 1)!; continue; }
      if (['async', 'unsafe', 'const', 'extern'].includes(t) && (t !== 'const' || tokens[i + 1]?.text === 'fn')) continue;
      if (t === 'mod' && tokens[i + 2]?.text === '{') {
        const close = matching.get(i + 2)!; const begin = attrs ?? i;
        const context = attributesFor(begin, i + 3), gated = inTestScope || testGated(context);
        if (gated) testScopes.push({ begin: i + 3, end: close });
        walk(i + 3, close, [...modules, tokens[i + 1].text], [...scopeContexts, context], gated); i = close; attrs = undefined; continue;
      }
      if (t === 'mod' && tokens[i + 2]?.text === ';') {
        const begin = attrs ?? i, attributes = attributesFor(begin, i);
        if (inTestScope || testGated(attributes)) {
          support.push(JSON.stringify([modules, scopeContexts, canonical(begin, i + 3)]));
          const rawPath = /\bpath\s*=\s*("(?:[^"\\]|\\.)*"|r#*".*"#*)/.exec(attributes)?.[1];
          let relative: string | undefined;
          if (rawPath) { try { relative = rawPath.startsWith('"') ? JSON.parse(rawPath) as string : rawPath.replace(/^r#*"|"#*$/g, ''); } catch { throw new Error('Unsupported test module path attribute'); } }
          externalModules.push({ modules, name: tokens[i + 1].text, ...(relative ? { path: relative } : {}) });
        }
        i += 2; attrs = undefined; continue;
      }
      if (t === 'fn') {
        const name = tokens[i + 1]?.text; let body = i + 2;
        while (body < end && tokens[body].text !== '{' && tokens[body].text !== ';') body++;
        if (tokens[body]?.text !== '{') { attrs = undefined; continue; }
        const close = matching.get(body)!; const begin = attrs ?? i;
        const attributes = attributesFor(begin, i);
        if (isTest(attributes)) tests.push({ name, qualified: [...modules, name].join('::'), canonical: canonical(begin, close + 1), attributes, context: scopeContexts.join('\n'), start: tokens[begin].start, end: tokens[close].end });
        else if (!inTestScope && (testGated(attributes) || attributeNames(attributes).some(a => a === 'cfg_attr' || !ordinaryAttributes.has(a)))) support.push(JSON.stringify([modules, scopeContexts, canonical(begin, close + 1)]));
        i = close; attrs = undefined; continue;
      }
      // Attribute macros and item macros can generate tests. Preserve opaque invocations in full.
      if (t === 'macro_rules' && tokens[i + 1]?.text === '!' && tokens[i + 3]?.text === '{') {
        const close = matching.get(i + 3)!;
        if (!inTestScope) support.push(JSON.stringify([modules, scopeContexts, canonical(attrs ?? i, close + 1)]));
        i = close; attrs = undefined; continue;
      }
      if (t === '!' && ['{', '(', '['].includes(tokens[i + 1]?.text)) {
        const close = matching.get(i + 1)!;
        let begin = i - 1;
        while (begin >= start + 3 && tokens[begin - 1].text === ':' && tokens[begin - 2].text === ':' && /^[A-Za-z_]/.test(tokens[begin - 3].text)) begin -= 3;
        begin = attrs ?? begin;
        if (!inTestScope) support.push(JSON.stringify([modules, scopeContexts, canonical(begin, close + 1)]));
        i = close; attrs = undefined; continue;
      }
      if (attrs !== undefined && testGated(attributesFor(attrs, i))) {
        // Freeze standalone cfg(test) imports, constants and other support items as complete items.
        let close = i;
        while (close < end && tokens[close].text !== ';' && tokens[close].text !== '{') close++;
        if (tokens[close]?.text === '{') close = matching.get(close)!;
        if (close < end && !inTestScope) support.push(JSON.stringify([modules, scopeContexts, canonical(attrs, close + 1)]));
        i = close; attrs = undefined; continue;
      }
      if (t === '{') { i = matching.get(i)!; attrs = undefined; continue; }
      if (!['(', ')', ':', 'crate'].includes(t)) attrs = undefined;
    }
  }
  walk(0, tokens.length, [], [], inheritedTestScope);
  // Freeze imports, test-only helpers, and gating without freezing production code or other test expectations.
  for (const t of tests) {
    for (const scope of testScopes) {
      if (!tokens[scope.begin] || t.start < tokens[scope.begin].start || t.end > (tokens[scope.end]?.end ?? source.length)) continue;
      const support = tokens.slice(scope.begin, scope.end).filter(token => !tests.some(other => token.start >= other.start && token.end <= other.end));
      t.context += '\nSUPPORT:' + JSON.stringify(support.map(token => token.text));
    }
  }
  for (const scope of testScopes) support.push(JSON.stringify(tokens.slice(scope.begin, scope.end).filter(token => !tests.some(t => token.start >= t.start && token.end <= t.end)).map(token => token.text)));
  return { tests, support: JSON.stringify(support), externalModules };
}
export const rustTests = (source: string): RustTest[] => parseRust(source).tests;
export const rustTestSupport = (source: string): string => parseRust(source).support;
export const rustExternalTestModules = (source: string, inheritedTestScope = false): RustTestModule[] => parseRust(source, inheritedTestScope).externalModules;
// Catch test-only implementation branches even inside production function bodies skipped by the item parser.
export function rustTestConfiguration(source: string): string {
  const tokens = lex(source), configurations: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const name = tokens[i].text;
    if (name !== 'cfg' && name !== 'cfg_attr') continue;
    let open = i + 1;
    if (tokens[open]?.text === '!') open++;
    if (tokens[open]?.text !== '(') continue;
    let depth = 1, close = open + 1;
    for (; close < tokens.length && depth; close++) { if (tokens[close].text === '(') depth++; else if (tokens[close].text === ')') depth--; }
    const expression = tokens.slice(i, close).map(t => t.text);
    if (expression.includes('test')) configurations.push(JSON.stringify(expression));
  }
  return JSON.stringify(configurations);
}
function ordinaryTest(source: string, qualified: string): RustTest {
  const matches = rustTests(source).filter(t => t.qualified === qualified);
  if (matches.length !== 1) throw new Error(`Exactly one ordinary #[test] named ${qualified} is required`);
  const t = matches[0];
  if (!/# \[ test \]/.test(t.attributes)) throw new Error('Regression requires an ordinary #[test] function; macro test syntax is protected but unsupported for new regressions');
  const functionTokens = JSON.parse(t.canonical) as string[]; const fn = functionTokens.indexOf('fn');
  if (functionTokens[fn + 2] !== '(' || functionTokens[fn + 3] !== ')') throw new Error('Regression requires a parameterless ordinary Rust test');
  if (/\b(ignore|should_panic)\b/.test(t.attributes)) throw new Error('Regression cannot be ignored or should_panic');
  return t;
}
export function extractTest(source: string, qualified: string, allowHelperAssertions = false): RustTest {
  const t = ordinaryTest(source, qualified);
  if (!/\bassert(?:_eq|_ne|_matches)?\b/.test(allowHelperAssertions ? rustCanonical(source) : t.canonical)) throw new Error('Regression requires an explicit assertion');
  return t;
}
export function freezeRust(source: string, qualified: string, allowHelperAssertions = false) { const t = extractTest(source, qualified, allowHelperAssertions); return { functionHash: hash(t.canonical), contextHash: hash(t.context) }; }
export function assertOnlyNewRegression(before: string, after: string, qualified: string) {
  assertOnlyNewRegressions(before, after, [qualified]);
}
export function assertOnlyNewRegressions(before: string, after: string, qualified: string[], validation: 'complete' | 'draft' = 'complete') {
  if (!qualified.length || new Set(qualified).size !== qualified.length) throw new Error('Regression names must be nonempty and unique');
  if (rustTests(before).some(t => qualified.includes(t.qualified))) throw new Error('Regression must be newly added');
  const added = qualified.map(name => validation === 'draft' ? ordinaryTest(after, name) : extractTest(after, name)).sort((a, b) => b.start - a.start);
  let without = after;
  for (const t of added) without = without.slice(0, t.start) + without.slice(t.end);
  if (rustCanonical(before) !== rustCanonical(without)) throw new Error('Reproduction may add only the self-contained test; production code, imports and helpers must remain unchanged');
}
