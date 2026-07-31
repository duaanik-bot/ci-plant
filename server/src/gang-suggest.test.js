import test from 'node:test';
import assert from 'node:assert/strict';
import { sizeKey, sizeLabel, gangSuggestions } from './gang-suggest.js';

// ── sizeKey — one carton, however it was typed ───────────────────────────────
test('sizeKey: punctuation and case never split one carton', () => {
  const k = '100x48x48';
  assert.equal(sizeKey('100 x 48 x 48'), k);
  assert.equal(sizeKey('100X48X48'), k);
  assert.equal(sizeKey('100 X 48 x 48'), k);
  assert.equal(sizeKey('  100x48x48  '), k);
  assert.equal(sizeKey('100.0 x 48 x 48'), k);   // trailing zeros are noise
});

test('sizeKey: decimals survive', () => {
  assert.equal(sizeKey('5.5 x 3.5 x 2'), '5.5x3.5x2');
});

test('sizeKey: anything that is not three dimensions gets no key', () => {
  assert.equal(sizeKey(''), null);
  assert.equal(sizeKey(null), null);
  assert.equal(sizeKey(undefined), null);
  assert.equal(sizeKey('PLAIN'), null);
  assert.equal(sizeKey('100x48'), null);            // two dims is not a carton
  assert.equal(sizeKey('2 Ply 100x48x48'), null);   // a typo, not a grouping
});

test('sizeLabel: one spelling everywhere', () => {
  assert.equal(sizeLabel('43x35x65'), '43 × 35 × 65');
  assert.equal(sizeLabel(null), null);
});

// ── Fixtures ─────────────────────────────────────────────────────────────────
let seq = 0;
const line = (o = {}) => ({
  id: ++seq, product_name: `P${seq}`, product_code: `C${seq}`, po_number: 'PO1',
  qty: 100, delivery_date: '2026-08-10',
  board_material_id: 182, board_name: 'Saffire · 300 GSM · 20x38', coating: 'Aqueous Varnish',
  carton_size: '43 x 35 x 65', ...o,
});
const kinds = (s, kind) => s.filter(x => x.kind === kind);

// ── Board axis — unchanged behaviour ─────────────────────────────────────────
test('board: two jobs on one board + coating are suggested; a lone job is not', () => {
  const s = gangSuggestions([
    line(), line(),
    line({ board_material_id: 97, board_name: 'Ivory · 300 GSM · 23x36', carton_size: '35x35x76' }),
  ]);
  const board = kinds(s, 'board');
  assert.equal(board.length, 1);
  assert.equal(board[0].lines.length, 2);
  assert.equal(board[0].board_material_id, 182);
  assert.equal(board[0].coating, 'Aqueous Varnish');
});

test('board: the same board with a different coating is a different press run', () => {
  const s = kinds(gangSuggestions([
    line(), line(),
    line({ coating: 'Full UV' }), line({ coating: 'Full UV' }),
  ]), 'board');
  assert.equal(s.length, 2);
  assert.deepEqual(s.map(x => x.coating).sort(), ['Aqueous Varnish', 'Full UV']);
});

test('board: a group that is also one carton carries the size on the chip', () => {
  const [b] = kinds(gangSuggestions([line({ carton_size: '100X48X48' }), line({ carton_size: '100 x 48 x 48' })]), 'board');
  assert.equal(b.size_key, '100x48x48');
  assert.equal(b.size_label, '100 × 48 × 48');
});

test('board: a mixed-carton group claims no size', () => {
  const [b] = kinds(gangSuggestions([line({ carton_size: '100x48x48' }), line({ carton_size: '43x35x65' })]), 'board');
  assert.equal(b.size_key, null);
});

test('board: one blank master is enough to drop the size claim', () => {
  const [b] = kinds(gangSuggestions([line({ carton_size: '100x48x48' }), line({ carton_size: '' })]), 'board');
  assert.equal(b.size_key, null);
});

// ── Carton axis — the new suggestion ─────────────────────────────────────────
test('size: the same carton across different boards is surfaced', () => {
  const s = kinds(gangSuggestions([
    line({ carton_size: '100 x 48 x 48' }),
    line({ carton_size: '100X48X48', board_material_id: 192, board_name: 'Ivory · 300 GSM · 23x36' }),
    line({ carton_size: '100x48x48', board_material_id: 97, board_name: 'FBB · 250 GSM · 22x28' }),
  ]), 'size');
  assert.equal(s.length, 1);
  assert.equal(s[0].lines.length, 3);
  assert.equal(s[0].size_label, '100 × 48 × 48');
  assert.equal(s[0].board_count, 3);
  assert.equal(s[0].board_name, null);        // no single board to name
  assert.equal(s[0].coating, 'Aqueous Varnish');
  assert.equal(s[0].coating_count, 1);
});

test('size: one board across the carton group is named on the chip', () => {
  const [s] = kinds(gangSuggestions([
    line({ carton_size: '80x54x89' }),
    line({ carton_size: '80 X 54 X 89', coating: 'Full UV' }),
  ]), 'size');
  assert.equal(s.board_count, 1);
  assert.equal(s.board_name, 'Saffire · 300 GSM · 20x38');
  assert.equal(s.coating_count, 2);
  assert.equal(s.coating, null);              // no single coating to name
});

test('size: a carton group identical to a board group is not repeated', () => {
  // Same two jobs, same board, same coating, same carton — the board chip
  // already says "· 43 × 35 × 65", so no second chip for the same pair.
  const s = gangSuggestions([line(), line()]);
  assert.equal(kinds(s, 'board').length, 1);
  assert.equal(kinds(s, 'size').length, 0);
  assert.equal(kinds(s, 'board')[0].size_label, '43 × 35 × 65');
});

test('size: a carton group WIDER than its board group is still shown', () => {
  const s = gangSuggestions([
    line(), line(),                                                   // board 182
    line({ board_material_id: 63, board_name: 'Ivory · 300 GSM · 23x36' }),
  ]);
  assert.equal(kinds(s, 'board').length, 1);          // the two on board 182
  const [size] = kinds(s, 'size');
  assert.equal(size.lines.length, 3);                 // all three are one carton
  assert.equal(size.board_count, 2);
});

test('size: an unreadable carton never groups', () => {
  assert.equal(kinds(gangSuggestions([
    line({ carton_size: 'PLAIN', board_material_id: 1, board_name: 'A' }),
    line({ carton_size: '', board_material_id: 2, board_name: 'B' }),
  ]), 'size').length, 0);
});

// ── Shape and ordering ───────────────────────────────────────────────────────
test('ordering: board suggestions first, each family biggest first', () => {
  const s = gangSuggestions([
    line({ carton_size: '1x1x1' }), line({ carton_size: '1x1x1' }),
    line({ carton_size: '2x2x2', board_material_id: 9, board_name: 'B9' }),
    line({ carton_size: '2x2x2', board_material_id: 8, board_name: 'B8' }),
    line({ carton_size: '2x2x2', board_material_id: 7, board_name: 'B7' }),
  ]);
  assert.deepEqual(s.map(x => x.kind), ['board', 'size']);
  assert.equal(s[1].lines.length, 3);
});

test('ordering: a carton group that can go to press today leads a bigger one that cannot', () => {
  const big = ['A', 'B', 'C', 'D'].map((n, i) =>
    line({ carton_size: '9x9x9', board_material_id: 100 + i, board_name: n }));
  // A third job on the same board keeps the carton group narrower than the
  // board group, so it is a suggestion in its own right rather than a repeat.
  const ready = [line({ carton_size: '4x4x4' }), line({ carton_size: '4x4x4' }), line({ carton_size: '7x7x7' })];
  // The two-job group is smaller but needs no board decision, so it leads.
  const s = gangSuggestions([...big, ...ready]).filter(x => x.kind === 'size');
  assert.deepEqual(s.map(x => x.size_key), ['4x4x4', '9x9x9']);
  assert.equal(s[0].board_count, 1);
  assert.equal(s[0].coating_count, 1);
});

test('ordering: one settled coating is not enough — a split board still queues behind', () => {
  const split = [
    line({ carton_size: '9x9x9' }),
    line({ carton_size: '9x9x9', board_material_id: 77, board_name: 'Other' }),
    line({ carton_size: '9x9x9', board_material_id: 77, board_name: 'Other' }),
  ];
  const ready = [line({ carton_size: '4x4x4' }), line({ carton_size: '4x4x4' })];
  const s = gangSuggestions([...split, ...ready]).filter(x => x.kind === 'size');
  assert.deepEqual(s.map(x => x.size_key), ['4x4x4', '9x9x9']);
});

test('shape: the board payload the client already reads is unchanged', () => {
  const [b] = kinds(gangSuggestions([line({ qty: 500 }), line({ qty: 700 })],
    { parentSheets: m => m.qty / 100 }), 'board');
  assert.deepEqual(Object.keys(b).sort(), [
    'board_material_id', 'board_name', 'coating', 'key', 'kind',
    'line_ids', 'lines', 'size_key', 'size_label', 'total_parent_sheets',
  ]);
  assert.equal(b.total_parent_sheets, 12);
  assert.deepEqual(b.line_ids, b.lines.map(l => l.id));
});

test('minJobs: a single job is never a gang', () => {
  assert.deepEqual(gangSuggestions([line()]), []);
  assert.deepEqual(gangSuggestions([]), []);
});
