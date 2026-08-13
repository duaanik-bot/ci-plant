import test from 'node:test';
import assert from 'node:assert/strict';
import { consolidate } from './po-consolidate.js';

// The requirement, in one fixture: three requisition lines, two of them the same
// board, become two PO lines with the quantities added up.
test('the same material on two lines becomes one line with the quantities summed', () => {
  const out = consolidate([
    { material_id: 7, qty: 20, rate: 45 },
    { material_id: 9, qty: 10, rate: 30 },
    { material_id: 7, qty: 10, rate: 45 },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].material_id, 7);
  assert.equal(out[0].qty, 30);
  assert.equal(out[1].material_id, 9);
  assert.equal(out[1].qty, 10);
});

test('lines come back in first-appearance order, not material order', () => {
  const out = consolidate([
    { material_id: 9, qty: 10 },
    { material_id: 7, qty: 20 },
    { material_id: 9, qty: 5 },
  ]);
  assert.deepEqual(out.map(l => l.material_id), [9, 7]);
});

// The narrow rate rule: consolidation only speaks when it actually merges.
test('a material appearing once keeps its incoming rate untouched', () => {
  const out = consolidate(
    [{ material_id: 7, qty: 20, rate: 45 }],
    { mergedRate: () => 99 });
  assert.equal(out[0].rate, 45, 'mergedRate must not be consulted for a lone line');
});

test('a deliberate zero rate on a lone line survives', () => {
  const out = consolidate([{ material_id: 7, qty: 20, rate: 0 }]);
  assert.equal(out[0].rate, 0);
});

test('a merged material takes the resolved rate, not either input rate', () => {
  const out = consolidate(
    [{ material_id: 7, qty: 20, rate: 45 }, { material_id: 7, qty: 10, rate: 47 }],
    { mergedRate: () => 46.5 });
  assert.equal(out[0].rate, 46.5);
});

test('a merged material falls back to the first line rate when nothing resolves', () => {
  // The direct-PO path passes no resolver: the top-most line wins, and the form
  // tells the buyer which number that was.
  const out = consolidate([
    { material_id: 7, qty: 20, rate: 45 },
    { material_id: 7, qty: 10, rate: 47 },
  ]);
  assert.equal(out[0].rate, 45);
});

test('mergedRate returning null falls back to the first line rate', () => {
  // An unrated board resolves to null — that must not blank the line.
  const out = consolidate(
    [{ material_id: 7, qty: 20, rate: 45 }, { material_id: 7, qty: 10, rate: 47 }],
    { mergedRate: () => null });
  assert.equal(out[0].rate, 45);
});

test('mergedRate sees the whole group so it can resolve on the material', () => {
  const seen = [];
  consolidate(
    [{ material_id: 7, qty: 20, rate: 45 }, { material_id: 7, qty: 10, rate: 47 }],
    { mergedRate: g => { seen.push(g); return 50; } });
  assert.equal(seen.length, 1, 'called once per merged material');
  assert.equal(seen[0].length, 2);
  assert.equal(seen[0][0].material_id, 7);
});

// Traceability: the merged line must be able to name what fed it.
test('sources record every contributing line and sum back to the merged qty', () => {
  const out = consolidate([
    { material_id: 7, qty: 20, rate: 45 },
    { material_id: 9, qty: 10, rate: 30 },
    { material_id: 7, qty: 10, rate: 47 },
  ]);
  const a = out[0];
  assert.equal(a.sources.length, 2);
  assert.equal(a.sources.reduce((s, x) => s + x.qty, 0), a.qty);
  assert.deepEqual(a.sources.map(s => s.index), [0, 2], 'position in the form, for "line 1 / line 3"');
  assert.deepEqual(a.sources.map(s => s.rate), [45, 47], 'what each line asked for, so a conflict can be named');
});

test('a merged line is flagged, a lone line is not', () => {
  const out = consolidate([
    { material_id: 7, qty: 20 },
    { material_id: 7, qty: 10 },
    { material_id: 9, qty: 10 },
  ]);
  assert.equal(out[0].merged, true);
  assert.equal(out[1].merged, false);
});

// Quantities arrive from a form as strings. '20' + '10' must be 30, not '2010'.
test('string quantities add up numerically', () => {
  const out = consolidate([
    { material_id: '7', qty: '20' },
    { material_id: '7', qty: '10' },
  ]);
  assert.equal(out[0].qty, 30);
});

test('material_id comes back as it went in, so each side keeps its own convention', () => {
  assert.equal(consolidate([{ material_id: '7', qty: '20' }])[0].material_id, '7');
  assert.equal(consolidate([{ material_id: 7, qty: 20 }])[0].material_id, 7);
});

test('the document fields ride along from the first line of the group', () => {
  const out = consolidate([
    { material_id: 7, qty: 20, unit: 'packets', hsn_code: '4810', gst_rate: 18, discount_pct: 0 },
    { material_id: 7, qty: 10, unit: 'packets', hsn_code: '4810', gst_rate: 18, discount_pct: 0 },
  ]);
  assert.equal(out[0].unit, 'packets');
  assert.equal(out[0].hsn_code, '4810');
  assert.equal(out[0].gst_rate, 18);
});

// Blank rows in a half-filled form share a falsy material_id. Grouping on that
// would fuse every empty row into one — they must stay apart.
test('lines without a material are never merged into each other', () => {
  const out = consolidate([
    { material_id: '', qty: 0 },
    { material_id: '', qty: 0 },
    { material_id: 7, qty: 20 },
  ]);
  assert.equal(out.length, 3);
  assert.equal(out[2].material_id, 7);
});

test('an empty list stays empty', () => {
  assert.deepEqual(consolidate([]), []);
});

test('a missing list is not a crash', () => {
  assert.deepEqual(consolidate(undefined), []);
});
