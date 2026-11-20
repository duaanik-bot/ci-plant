// Source scanning for guard tests: reads JavaScript as code, not as text.
// Strings, template literals, comments and regex literals are blanked so a brace
// or a word inside SQL never counts. Used by no-pool-escape-in-tx.test.js.

// Strings, template literals (with ${…} nesting), comments and regex literals are
// blanked to spaces so their braces and words never count. Positions are kept.
export function blankNoise(src) {
  const out = src.split('');
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0;
  const n = src.length;
  const stack = []; // template nesting: brace depth at each ${
  let depth = 0;
  // A regex can follow the `)` that closes an if/while/for/with head
  // (`if (a) /x/.test(b)`), where any other `)` means division.
  const parens = []; // for each open (, whether it opened a keyword head
  let keywordParenEnd = -1;
  const regexAllowedAfter = /[(,=:[!&|?{};+\-*%<>~^]$|\b(return|typeof|case|in|of|await|yield)$/;
  const prevSignificant = k => {
    let j = k - 1;
    while (j >= 0 && /\s/.test(src[j])) j--;
    return src.slice(Math.max(0, j - 10), j + 1);
  };
  const skipTemplate = start => {
    // start at the char after the backtick; returns index after the closing backtick,
    // or the index of a ${ (pushing state) when one opens.
    let k = start;
    while (k < n) {
      if (src[k] === '\\') { k += 2; continue; }
      if (src[k] === '`') return { end: k + 1 };
      if (src[k] === '$' && src[k + 1] === '{') return { open: k };
      k++;
    }
    return { end: n };
  };
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); const end = e < 0 ? n : e; blank(i, end); i = end; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? n : e + 2; blank(i, end); i = end; continue; }
    if (c === "'" || c === '"') {
      let k = i + 1;
      while (k < n && src[k] !== c && src[k] !== '\n') k += src[k] === '\\' ? 2 : 1;
      blank(i, k + 1); i = k + 1; continue;
    }
    if (c === '`') {
      const r = skipTemplate(i + 1);
      if (r.open != null) { blank(i, r.open + 2); stack.push(depth); depth++; i = r.open + 2; continue; }
      blank(i, r.end); i = r.end; continue;
    }
    if (c === '}' && stack.length && depth - 1 === stack[stack.length - 1]) {
      // closes a ${ … } — resume the template
      stack.pop(); depth--;
      const r = skipTemplate(i + 1);
      if (r.open != null) { blank(i, r.open + 2); stack.push(depth); depth++; i = r.open + 2; continue; }
      blank(i, r.end); i = r.end; continue;
    }
    if (c === '(') {
      parens.push(/\b(if|while|for|with)\s*$/.test(src.slice(Math.max(0, i - 12), i)));
    } else if (c === ')') {
      if (parens.pop()) keywordParenEnd = i;
    }
    const prevAt = c !== '/' ? -1 : (() => { let j = i - 1; while (j >= 0 && /\s/.test(src[j])) j--; return j; })();
    if (c === '/' && src[i + 1] !== '/' && src[i + 1] !== '*'
        && (regexAllowedAfter.test(prevSignificant(i)) || (src[prevAt] === ')' && prevAt === keywordParenEnd))) {
      let k = i + 1; let cls = false;
      while (k < n && src[k] !== '\n') {
        if (src[k] === '\\') { k += 2; continue; }
        if (src[k] === '[') cls = true; else if (src[k] === ']') cls = false;
        else if (src[k] === '/' && !cls) break;
        k++;
      }
      if (src[k] === '/') { blank(i, k + 1); i = k + 1; continue; }
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  return out.join('');
}

// Every function whose parameter list names qc, oc or client, with its body —
// in every shape one is written: `function f(qc) {}`, `async (qc, oc) => {}`,
// `qc => {}`, `(qc) => expr`, method shorthand `async run(qc) {}`, and heads whose
// default parameters nest parentheses. Heads are found by MATCHING parentheses,
// not by one regex, so nesting cannot hide a function.
const HEAD_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'typeof', 'await', 'new', 'in', 'of', 'do', 'else', 'void', 'delete', 'yield']);
const NAMES_CLIENT = /(^|[\s,{(\[])(qc|oc|client)(\s*[,=})\]]|\s*$)/;

function closeOf(text, open, o, c) {
  let d = 0;
  for (let k = open; k < text.length; k++) {
    if (text[k] === o) d++;
    else if (text[k] === c) { d--; if (d === 0) return k; }
  }
  return text.length;
}

// The body after `=>` or a head: a { block } or, for an arrow, one expression.
function bodyFrom(text, k) {
  while (/\s/.test(text[k] || '')) k++;
  if (text[k] === '{') return [k + 1, closeOf(text, k, '{', '}')];
  let d = 0; let e = k;
  for (; e < text.length; e++) {
    const ch = text[e];
    if ('([{'.includes(ch)) d++;
    else if (')]}'.includes(ch)) { if (d === 0) break; d--; }
    else if ((ch === ',' || ch === ';') && d === 0) break;
  }
  return [k, e];
}

export function txFunctions(src) {
  const clean = blankNoise(src);
  const found = [];
  // Every ( paired with its ) in ONE pass — per-paren scanning is quadratic.
  const closeAt = new Map();
  const opens = [];
  for (let k = 0; k < clean.length; k++) {
    if (clean[k] === '(') opens.push(k);
    else if (clean[k] === ')' && opens.length) closeAt.set(opens.pop(), k);
  }
  const nameBefore = at => {
    const before = clean.slice(Math.max(0, at - 200), at);
    return (before.match(/([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?(?:function\b[^(]*)?$/) || [])[1];
  };
  const push = (at, body, name) => found.push({
    name: name || nameBefore(at) || '(anonymous)',
    line: src.slice(0, at).split('\n').length,
    body: clean.slice(body[0], body[1]),
  });
  // Parenthesised heads.
  for (const [i, close] of closeAt) {
    const params = clean.slice(i + 1, close);
    if (!NAMES_CLIENT.test(params)) continue;
    let k = close + 1;
    while (/\s/.test(clean[k] || '')) k++;
    const word = (clean.slice(Math.max(0, i - 80), i).match(/([A-Za-z_$][\w$]*)\s*\*?\s*$/) || [])[1];
    if (clean.startsWith('=>', k)) { push(i, bodyFrom(clean, k + 2)); continue; }
    if (clean[k] !== '{' || !word || HEAD_KEYWORDS.has(word)) continue;
    // `function name(…) {`, `function (…) {`, or method shorthand `name(…) {` —
    // a call is never followed by a block, so any other word here is a head.
    push(i, bodyFrom(clean, k), word === 'function' ? null : word);
  }
  // A single bare parameter: `qc => …`, `async oc => …`.
  for (const m of clean.matchAll(/(?<![\w$.])(qc|oc|client)\s*=>/g)) {
    push(m.index, bodyFrom(clean, m.index + m[0].length));
  }
  return found;
}

export function escapes(body) {
  return [...body.matchAll(/(?<![.\w$])(q|one)\s*\(/g)].map(x => x[1]);
}
