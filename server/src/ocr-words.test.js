// Repairing OCR tokens before any geometry is read off them.
//
// Every case here is taken from what the engine actually returned for the two
// scanned purchase orders on file — not invented. Each one, left unrepaired,
// changes a number the plant would then order board against.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanOcrWords, cleanOcrPages } from './ocr-words.js';

// Build a word from a string, laying its symbols out left to right. Widths are
// uniform except where a caller overrides them — real rule glyphs come back
// about a pixel wide, which is the tell.
function word(text, { x = 100, y = 200, w = 15, h = 24, conf = 90, widths = {} } = {}) {
  let cx = x;
  const symbols = [...text].map(ch => {
    const sw = widths[ch] ?? w;
    const s = { t: ch, x0: cx, y0: y, x1: cx + sw, y1: y + h };
    cx += sw + 2;
    return s;
  });
  return { text, conf, x0: x, y0: y, x1: cx - 2, y1: y + h, symbols };
}

test('a rule glued to a figure is stripped, and the figure keeps its box', () => {
  // "52800.000(" — the taxable value with the next cell's rule stuck to it.
  const [t] = cleanOcrWords([word('52800.000(', { widths: { '(': 1 } })]);
  assert.equal(t.text, '52800.000');
  assert.ok(t.x1 < word('52800.000(').x1, 'the rule must not be inside the kept box');
});

test('a token welded across a cell boundary is split back into two', () => {
  // The one that cost a quantity: "20000.000|{NOS" spans Qty and UOM. Placed by
  // its centre the whole thing lands in UOM and the 20,000 disappears — on the
  // real PO the line came back as 2,640.
  const tokens = cleanOcrWords([word('20000.000|{NOS', { widths: { '|': 1, '{': 1 } })]);
  assert.deepEqual(tokens.map(t => t.text), ['20000.000', 'NOS']);
  const [qty, uom] = tokens;
  assert.ok(qty.x1 < uom.x0, 'the two must end up in different places, not one box');
});

test('a serial welded to an item code is split', () => {
  // "1|PMC-A220" — the serial column's rule read as a character.
  assert.deepEqual(
    cleanOcrWords([word('1|PMC-A220', { widths: { '|': 1 } })]).map(t => t.text),
    ['1', 'PMC-A220'],
  );
});

test('real parentheses in a product name are left alone', () => {
  // "(SALES)-R5" and "(10X15)-R0" are part of the name. Only an UNBALANCED
  // bracket is a rule, which is what separates these from "52800.000(".
  assert.deepEqual(cleanOcrWords([word('(SALES)-R5')]).map(t => t.text), ['(SALES)-R5']);
  assert.deepEqual(cleanOcrWords([word('(10X15)-R0')]).map(t => t.text), ['(10X15)-R0']);
});

test('a vertical rule read as a character is dropped entirely', () => {
  // Tall and narrow, and nothing but punctuation: 11px wide by 64px tall on the
  // real pages. It is a line on the form, not a word.
  assert.deepEqual(cleanOcrWords([{ text: '|', conf: 69, x0: 123, y0: 1337, x1: 134, y1: 1401, symbols: [] }]), []);
  // ...but a genuinely narrow LETTER is not a rule.
  assert.equal(cleanOcrWords([word('I', { w: 8, h: 24 })]).length, 1);
});

test('a glyph read twice is dropped in favour of the token containing it', () => {
  // "y" inside "ty." — the ghost that turned the heading "Qty." into "Q ty. y",
  // which matches no heading pattern, so the quantity column vanished from the
  // model and the whole table fell back to guesswork.
  const parent = { text: 'ty.', conf: 88, x0: 1345, y0: 1272, x1: 1378, y1: 1294, symbols: [] };
  const ghost = { text: 'y', conf: 54, x0: 1355, y0: 1277, x1: 1372, y1: 1300, symbols: [] };
  assert.deepEqual(cleanOcrWords([parent, ghost]).map(t => t.text), ['ty.']);
});

test('a smaller box that is NOT a re-read survives', () => {
  // Containment alone must not condemn a token: a real word can sit inside the
  // bounding box of a longer one on a crowded line.
  const big = { text: 'Description', conf: 95, x0: 437, y0: 1272, x1: 606, y1: 1309, symbols: [] };
  const other = { text: 'Goods', conf: 96, x0: 500, y0: 1276, x1: 560, y1: 1300, symbols: [] };
  const kept = cleanOcrWords([big, other]).map(t => t.text);
  assert.ok(kept.includes('Description'));
  assert.ok(kept.includes('Goods'), 'a different word inside the box is not a ghost');
});

test('without symbol boxes only the ends are trimmed, never the middle', () => {
  // Splitting an interior weld would mean inventing an x, and a guessed
  // boundary is exactly what puts a quantity in the wrong column. Trim what is
  // safe; leave the rest for the arithmetic check to catch.
  const noSyms = { text: '|AL5ZYME', conf: 35, x0: 427, y0: 100, x1: 570, y1: 124, symbols: [] };
  assert.deepEqual(cleanOcrWords([noSyms]).map(t => t.text), ['AL5ZYME']);
  const welded = { text: '20000.000|{NOS', conf: 41, x0: 1290, y0: 100, x1: 1486, y1: 124, symbols: [] };
  assert.deepEqual(cleanOcrWords([welded]).map(t => t.text), ['20000.000|{NOS'],
    'an interior weld with no symbols must be left intact rather than guessed at');
});

test('cleanOcrPages keeps the page envelope and only rewrites the words', () => {
  const pages = cleanOcrPages([{ page: 2, scale: 3, width_px: 100, height_px: 200, words: [word('ok')] }]);
  assert.equal(pages[0].page, 2);
  assert.equal(pages[0].scale, 3);
  assert.equal(pages[0].height_px, 200);
  assert.deepEqual(pages[0].words.map(w => w.text), ['ok']);
});
