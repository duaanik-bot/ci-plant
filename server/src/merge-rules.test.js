import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeCompat, mergeShares, membersAtRisk } from './merge-rules.js';
import { shouldSplitAtDieCut } from './helpers.js';

// The one invariant the whole feature hangs on: a gang splits at die cutting,
// a COMBINED RUN never does.
test('shouldSplitAtDieCut', async t => {
  const base = { isLastStage: true, stage: 'die_cutting', gangRunId: 7, orderLineId: null };

  await t.test('a gang parent at its last die-cutting stage splits', () => {
    assert.equal(shouldSplitAtDieCut({ ...base, runKind: 'gang' }), true);
  });
  await t.test('a COMBINED RUN never splits — the invariant', () => {
    assert.equal(shouldSplitAtDieCut({ ...base, runKind: 'merge' }), false);
  });
  await t.test('a merge whose route somehow ENDS at die cutting still does not split', () => {
    // This is why the kind is read instead of inferred from the route shape.
    assert.equal(shouldSplitAtDieCut({ ...base, runKind: 'merge', isLastStage: true }), false);
  });
  await t.test('a split child (order line set) never re-splits', () => {
    assert.equal(shouldSplitAtDieCut({ ...base, runKind: 'gang', orderLineId: 42 }), false);
  });
  await t.test('a solo card never splits', () => {
    assert.equal(shouldSplitAtDieCut({ ...base, runKind: null, gangRunId: null }), false);
  });
  await t.test('mid-route die cutting does not split — only the last stage hands over', () => {
    assert.equal(shouldSplitAtDieCut({ ...base, runKind: 'gang', isLastStage: false }), false);
  });
});

// MEMBER_VIEW-shaped row, minimally.
const row = (over = {}) => ({
  id: 1, product_id: 10, product_code: 'SW-287', product_name: 'GLYCOMET TRIO 2',
  po_number: 'PMP/01659', customer_name: 'Swiss Garnier', delivery_date: '2026-08-05',
  status: 'planned', gang_run_id: null, job_card_id: null, jc_number: null,
  board_material_id: 363, board_name: 'Duplex WB · 296 GSM · 23x38',
  ups: 3, child_l: 18, child_w: 25, qty: 6100, fg_consumed_qty: 0,
  ...over,
});

test('mergeCompat', async t => {
  await t.test('two orders of one carton, same board, both planned — ok, no noise', () => {
    const v = mergeCompat([row(), row({ id: 2, po_number: 'PMP/01767', qty: 24000 })]);
    assert.equal(v.ok, true);
    assert.deepEqual(v.conflicts, []);
    assert.deepEqual(v.warnings, []);
  });

  await t.test('different products conflict, and the message points at Gang printing', () => {
    const v = mergeCompat([row(), row({ id: 2, product_id: 11, product_code: 'SW-999' })]);
    assert.equal(v.ok, false);
    const c = v.conflicts.find(x => x.field === 'product');
    assert.match(c.message, /Gang printing/);
  });

  await t.test('one line only cannot combine', () => {
    assert.equal(mergeCompat([row()]).ok, false);
  });

  await t.test('a line already in production conflicts, named by product and PO', () => {
    const v = mergeCompat([row(), row({ id: 2, status: 'in_production' })]);
    assert.equal(v.ok, false);
    assert.match(v.conflicts.find(x => x.field === 'status').message, /GLYCOMET TRIO 2 \(PMP\/01659\)/);
  });

  await t.test('a line already in a run conflicts', () => {
    assert.equal(mergeCompat([row(), row({ id: 2, gang_run_id: 7 })]).ok, false);
  });

  await t.test('a line with a job card conflicts and names the card', () => {
    const v = mergeCompat([row(), row({ id: 2, job_card_id: 5, jc_number: 'CI-JC-0005' })]);
    assert.equal(v.ok, false);
    assert.match(v.conflicts.find(x => x.field === 'job_card').message, /CI-JC-0005/);
  });

  await t.test('an override that forks the board is a CONFLICT, not a warning', () => {
    const v = mergeCompat([row(), row({ id: 2, board_material_id: 329, board_name: 'Duplex WB · 300 GSM · 23x38' })]);
    assert.equal(v.ok, false);
    assert.equal(v.conflicts.some(x => x.field === 'board'), true);
  });

  await t.test('an override that forks the cut layout is a CONFLICT', () => {
    assert.equal(mergeCompat([row(), row({ id: 2, ups: 4 })]).ok, false);
    assert.equal(mergeCompat([row(), row({ id: 2, child_l: 20 })]).ok, false);
  });

  await t.test('delivery spread beyond 7 days warns but still combines — parity with gangCompat', () => {
    const v = mergeCompat([row(), row({ id: 2, delivery_date: '2026-08-20' })]);
    assert.equal(v.ok, true);
    assert.equal(v.warnings.some(w => w.field === 'delivery dates'), true);
  });

  await t.test('two customers warn but still combine', () => {
    const v = mergeCompat([row(), row({ id: 2, customer_name: 'Galpha' })]);
    assert.equal(v.ok, true);
    assert.equal(v.warnings.some(w => w.field === 'customers'), true);
  });
});

test('mergeShares', async t => {
  const m = (id, qty, due, consumed = 0) => row({ id, qty, delivery_date: due, fg_consumed_qty: consumed });

  await t.test('an exact pile fills every order exactly', () => {
    const parts = mergeShares([m(1, 50000, '2026-08-05'), m(2, 50000, '2026-08-12'), m(3, 50000, '2026-08-20')], 150000);
    assert.deepEqual(parts.map(p => p.qty), [50000, 50000, 50000]);
  });

  await t.test('overs sum exactly, and land on the earliest delivery', () => {
    const parts = mergeShares([m(1, 50000, '2026-08-12'), m(2, 50000, '2026-08-05')], 102000);
    assert.equal(parts.reduce((s, p) => s + p.qty, 0), 102000);
    assert.equal(parts.find(p => p.order_line_id === 2).qty, 52000); // earliest carries the overflow
    assert.equal(parts.find(p => p.order_line_id === 1).qty, 50000);
  });

  await t.test('a short pile fills the earliest orders first', () => {
    const parts = mergeShares([m(1, 6100, '2026-08-05'), m(2, 24000, '2026-08-12')], 20000);
    assert.equal(parts.reduce((s, p) => s + p.qty, 0), 20000);
    assert.equal(parts.find(p => p.order_line_id === 1).qty, 6100); // earliest made whole
  });

  await t.test('produced 0 → all zero, no divide-by-zero', () => {
    assert.deepEqual(mergeShares([m(1, 100, '2026-08-05'), m(2, 200, '2026-08-06')], 0).map(p => p.qty), [0, 0]);
  });

  await t.test('empty members → []', () => {
    assert.deepEqual(mergeShares([], 500), []);
  });

  await t.test('fg-consumed quantity nets off the weight', () => {
    const parts = mergeShares([m(1, 1000, '2026-08-05', 1000), m(2, 1000, '2026-08-06')], 1000);
    assert.equal(parts.find(p => p.order_line_id === 2).qty, 1000);
  });
});

test('membersAtRisk', async t => {
  const m = (id, qty, due, po) => row({ id, qty, delivery_date: due, po_number: po });

  await t.test('a short pile names exactly who is short, and by how much', () => {
    const risk = membersAtRisk([m(1, 6100, '2026-08-05', 'PMP/01659'), m(2, 24000, '2026-08-12', 'PMP/01767')], 20000);
    assert.equal(risk.length, 1);
    assert.equal(risk[0].po_number, 'PMP/01767');
    assert.equal(risk[0].short, 10100);
  });

  await t.test('a full pile has nobody at risk', () => {
    assert.deepEqual(membersAtRisk([m(1, 100, '2026-08-05', 'A'), m(2, 200, '2026-08-06', 'B')], 300), []);
  });
});
