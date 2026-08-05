import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repeatSources } from '../../client/src/lib/discrepancyGroups.js';

// The register exists to answer ONE question: is this a plant problem or a
// counting problem? A flat log cannot answer it — the same operator or the same
// carton showing up again and again is the signal, so the grouping is the point
// of the screen, not decoration.

const rows = [
  { operator: 'Shankar', product_name: 'COLEN SYRUP', delta_qty: 300, delta_pct: 2.2 },
  { operator: 'Shankar', product_name: 'COLEN SYRUP', delta_qty: 200, delta_pct: 1.4 },
  { operator: 'Shankar', product_name: 'CLARIT 500', delta_qty: 100, delta_pct: 9.9 },
  { operator: 'Jieut Pasting', product_name: 'CLARIT 500', delta_qty: 50, delta_pct: 0.4 },
];

test('groups by a key, most frequent first', () => {
  const g = repeatSources(rows, 'operator');
  assert.equal(g.length, 2);
  assert.deepEqual(g[0], { name: 'Shankar', count: 3, net: 600, worstPct: 9.9 });
  assert.deepEqual(g[1], { name: 'Jieut Pasting', count: 1, net: 50, worstPct: 0.4 });
});

test('a different key regroups the same rows', () => {
  // Both cartons appear twice, so the tie falls to net pieces: COLEN moved 500,
  // CLARIT 150 — the costlier one leads.
  const g = repeatSources(rows, 'product_name');
  assert.deepEqual(g.map(x => [x.name, x.count]), [['COLEN SYRUP', 2], ['CLARIT 500', 2]]);
});

test('ties break on the bigger net, so the worse offender leads', () => {
  // Both cartons appear twice; COLEN moved 500 pieces and CLARIT only 150.
  const g = repeatSources(rows, 'product_name');
  const colen = g.find(x => x.name === 'COLEN SYRUP');
  assert.equal(colen.net, 500);
  assert.equal(g.filter(x => x.count === 2).length, 2);
});

test('rows with no value for the key are skipped, never bucketed as blank', () => {
  // An unattributed discrepancy is real, but it names nobody — inventing an
  // empty row would put a phantom at the top of the table.
  const g = repeatSources([...rows, { operator: null, delta_qty: 9 }, { operator: '  ', delta_qty: 9 }], 'operator');
  assert.deepEqual(g.map(x => x.name), ['Shankar', 'Jieut Pasting']);
});

test('a missing percentage does not become zero', () => {
  const g = repeatSources([{ operator: 'A', delta_qty: 10, delta_pct: null }], 'operator');
  assert.equal(g[0].worstPct, null);
});

test('empty in, empty out', () => {
  assert.deepEqual(repeatSources([], 'operator'), []);
  assert.deepEqual(repeatSources(null, 'operator'), []);
});

test('the limit keeps the panel short', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ operator: `op${i}`, delta_qty: 1 }));
  assert.equal(repeatSources(many, 'operator', 5).length, 5);
});
