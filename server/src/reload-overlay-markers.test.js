// The build watch may reload a VISIBLE screen once it has sat idle — but never
// while a dialog, sheet or popover is open over it. It finds those by ONE
// mechanism: the `data-ci-overlay` attribute, set by the shared Modal, the
// Select phone sheet and every other portal or fixed-position layer that only
// exists while something is open.
//
// That only holds if the marker is never forgotten, and forgetting it is
// silent: the new popover works, and the first anyone learns of it is an
// operator watching the page reload out from under an open sheet. So every
// createPortal root and every element positioned `fixed` must DECLARE itself:
//
//   data-ci-overlay — exists only while something is open; its presence makes
//                     the page busy.
//   data-ci-chrome  — permanent furniture (nav bar, side rail, toast stack, the
//                     update bar itself). Mounted all the time, so it must never
//                     count as busy or no screen would ever reload.
//
// A layer that says neither fails here, naming its file and line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../client/src/', import.meta.url));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(jsx?|css)$/.test(name)) out.push(p);
  }
  return out;
}
const files = walk(ROOT);
const lineOf = (src, i) => src.slice(0, i).split('\n').length;

// Read one JSX opening tag from its `<` to its closing `>`, stepping over
// attribute strings, `{…}` expressions and template literals, so a `>` inside
// `onClick={() => …}` or a `${…}` is not taken for the end of the tag.
function openingTag(src, lt) {
  const stack = ['tag'];
  for (let i = lt + 1; i < src.length && i < lt + 4000; i++) {
    const c = src[i];
    const top = stack[stack.length - 1];
    if (top === '"' || top === "'") {
      if (c === top) stack.pop();
      continue;
    }
    if (top === '`') {
      if (c === '\\') { i++; continue; }
      if (c === '`') stack.pop();
      else if (c === '$' && src[i + 1] === '{') { stack.push('{'); i++; }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { stack.push(c); continue; }
    if (c === '{') { stack.push('{'); continue; }
    if (c === '}') { if (top === '{') stack.pop(); continue; }
    if (c === '>' && top === 'tag') return { start: lt, end: i + 1, text: src.slice(lt, i + 1) };
  }
  return null;
}

// The opening tag that encloses position `at` (an attribute inside it).
function tagAround(src, at) {
  let from = at;
  for (let tries = 0; tries < 20; tries++) {
    const lt = src.lastIndexOf('<', from - 1);
    if (lt < 0) return null;
    if (/[A-Za-z]/.test(src[lt + 1] || '')) {
      const tag = openingTag(src, lt);
      if (tag && tag.end > at) return tag;
    }
    from = lt;
  }
  return null;
}

// The value of the `className=` attribute starting at `i`: a quoted string or a
// balanced `{…}` expression.
function attrValue(src, i) {
  const open = src[i];
  if (open === '"' || open === "'") return src.slice(i, src.indexOf(open, i + 1) + 1);
  if (open !== '{') return '';
  const tag = openingTag(`<x ${src.slice(i, i + 4000)}`, 0);
  // openingTag stops at the first top-level `>` after the braces close; the
  // value is everything up to the matching `}`.
  let depth = 0;
  const body = tag ? tag.text.slice(3) : src.slice(i, i + 4000);
  for (let k = 0, q = null; k < body.length; k++) {
    const c = body[k];
    if (q) { if (c === '\\') { k++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) return body.slice(0, k + 1);
  }
  return body;
}

const FIXED_TOKEN = /(^|[\s"'`{])(?:[a-z0-9-]+:)*fixed(?=[\s"'`}]|$)/;
const declares = text => /\bdata-ci-(overlay|chrome)\b/.test(text);

function fixedLayers() {
  const found = [];
  for (const file of files.filter(f => /\.jsx?$/.test(f))) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/className=/g)) {
      const valueAt = m.index + 'className='.length;
      if (!FIXED_TOKEN.test(attrValue(src, valueAt))) continue;
      found.push({ file, src, at: m.index });
    }
    for (const m of src.matchAll(/position:\s*['"]fixed['"]/g)) found.push({ file, src, at: m.index });
  }
  return found;
}

test('every fixed-position element declares itself overlay or chrome', () => {
  const layers = fixedLayers();
  // The scan has to be finding the layers at all, or it passes by seeing none.
  assert.ok(layers.length >= 25, `expected the known fixed layers, found ${layers.length}`);
  const missing = [];
  for (const { file, src, at } of layers) {
    const tag = tagAround(src, at);
    if (!tag || !declares(tag.text)) missing.push(`${relative(ROOT, file)}:${lineOf(src, at)}`);
  }
  assert.deepEqual(missing, [],
    'a fixed layer must carry data-ci-overlay (only exists while open) or data-ci-chrome (always mounted)');
});

test('every createPortal root carries data-ci-overlay', () => {
  const missing = [];
  let portals = 0;
  for (const file of files.filter(f => /\.jsx?$/.test(f))) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/createPortal\(/g)) {
      portals++;
      // The first element inside the call, stepping over a bare fragment `<>`.
      const first = src.slice(m.index).search(/<[A-Za-z]/);
      const tag = first >= 0 ? openingTag(src, m.index + first) : null;
      if (!tag || !/\bdata-ci-overlay\b/.test(tag.text)) missing.push(`${relative(ROOT, file)}:${lineOf(src, m.index)}`);
    }
  }
  assert.ok(portals >= 15, `expected the known portals, found ${portals}`);
  assert.deepEqual(missing, [], 'a portal is something opened over the page — it must say so');
});

test('no stylesheet positions anything fixed behind the markers\' back', () => {
  // A `position: fixed` rule in CSS makes a layer the scan above cannot see.
  const hits = [];
  for (const file of files.filter(f => f.endsWith('.css'))) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/position:\s*fixed|@apply[^;]*\bfixed\b/g)) hits.push(`${relative(ROOT, file)}:${lineOf(src, m.index)}`);
  }
  assert.deepEqual(hits, [], 'position the layer with the `fixed` class on the element and mark it');
});

test('the overlay marker is what the reload check actually looks for', () => {
  const rs = readFileSync(join(ROOT, 'lib/reloadSafety.js'), 'utf8');
  assert.match(rs, /\[data-ci-overlay\]/);
  assert.doesNotMatch(rs, /data-ci-chrome/, 'chrome is a declaration for this test, never a busy signal');
});

test('the shared Modal marks both of its branches, and the Select sheet marks itself', () => {
  const ui = readFileSync(join(ROOT, 'components/ui.jsx'), 'utf8');
  const modal = ui.slice(ui.indexOf('export function Modal('), ui.indexOf('export function ConfirmDialog('));
  assert.equal((modal.match(/data-ci-overlay/g) || []).length, 2, 'phone sheet and desktop dialog');
  const select = ui.slice(ui.indexOf("if (tier === 'phone') {"), ui.indexOf('export function Select('));
  assert.match(select, /createPortal\(\(\s*<div data-ci-overlay className="fixed inset-0/, 'the phone Select sheet');
});
