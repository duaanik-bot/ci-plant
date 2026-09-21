import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeCompat, mergeShares, membersAtRisk, batchOf, sameCarton, runKindFor, repeatsAProduct } from './merge-rules.js';
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

// ── Batch identity ──────────────────────────────────────────────────────────
// Swiss Garnier books one PO as several lines, one per PHARMA BATCH, and the
// batch number is printed at press — so two lines of one product code are only
// the same carton when they carry the same batch. Real rows off PO 01718.
test('batchOf', async t => {
  await t.test('reads the batch out of the remark the PO import writes', () => {
    assert.equal(batchOf({ line_remark: 'BATCH NO 54TCR008' }), '54TCR008');
  });
  await t.test('the plant writes the prefix inconsistently — both forms read the same way', () => {
    assert.equal(batchOf({ line_remark: 'BATCH NO TBT064' }), 'TBT064');
    assert.equal(batchOf({ line_remark: 'BATCH 54TBT065' }), '54TBT065');
    assert.equal(batchOf({ line_remark: 'B.NO TCL031' }), 'TCL031');
  });
  await t.test('case and stray whitespace do not make two batches out of one', () => {
    assert.equal(batchOf({ line_remark: '  batch no  54tcr008 ' }), '54TCR008');
  });
  await t.test('a remark that is not a batch is not a batch — it must never force a gang', () => {
    assert.equal(batchOf({ line_remark: 'handle with care' }), null);
    assert.equal(batchOf({ line_remark: '' }), null);
    assert.equal(batchOf({ line_remark: null }), null);
    assert.equal(batchOf({}), null);
  });
});

test('sameCarton', async t => {
  const b = (id, remark) => row({ id, line_remark: remark });

  await t.test('two orders of one carton with no batch named — one carton, as today', () => {
    assert.equal(sameCarton([row(), row({ id: 2 })]), true);
  });
  await t.test('one carton, one batch, booked twice — still one carton', () => {
    assert.equal(sameCarton([b(1, 'BATCH NO 54TCR008'), b(2, 'BATCH NO 54TCR008')]), true);
  });
  await t.test('THE BUG: one product code, two batch numbers — NOT one carton', () => {
    assert.equal(sameCarton([b(1, 'BATCH NO 54TCR008'), b(2, 'BATCH NO 54TCR014')]), false);
  });
  await t.test('different products are never one carton, batch or no batch', () => {
    assert.equal(sameCarton([row(), row({ id: 2, product_id: 11 })]), false);
  });
  await t.test('a single named batch beside unmarked lines does not fork the run', () => {
    // Absent data must not change the routing — only a genuine second batch does.
    assert.equal(sameCarton([b(1, 'BATCH NO 54TCR008'), b(2, null)]), true);
  });
});

test('runKindFor — the ONE rule both the queue and POST /gang-runs read', async t => {
  const b = (id, remark) => row({ id, line_remark: remark });

  await t.test('repeat orders of one carton combine', () => {
    assert.equal(runKindFor([row(), row({ id: 2 })]), 'merge');
  });
  await t.test('THE FIX: same carton, different batches → GANG, not combine', () => {
    assert.equal(runKindFor([b(1, 'BATCH NO 54TCR008'), b(2, 'BATCH NO 54TCR014')]), 'gang');
  });
  await t.test('different products gang, as always', () => {
    assert.equal(runKindFor([row(), row({ id: 2, product_id: 11 })]), 'gang');
  });
  await t.test("Anik's five SW-114 batches gang", () => {
    const five = ['54TCR008', '54TCR014', '54TCR015', '54TCR016', '54TCR018']
      .map((n, i) => b(i + 1, `BATCH NO ${n}`));
    assert.equal(runKindFor(five), 'gang');
  });
});

test('mergeCompat names the batches it is about to merge', async t => {
  const b = (id, remark) => row({ id, line_remark: remark });

  await t.test('combining two batches into one pile WARNS — allowed, never silent', () => {
    const v = mergeCompat([b(1, 'BATCH NO 54TCR008'), b(2, 'BATCH NO 54TCR014')]);
    assert.equal(v.ok, true, 'the planner may still combine — warn, never refuse');
    const w = v.warnings.find(x => x.field === 'batches');
    assert.ok(w, 'a merge across two batch numbers must say so');
    assert.deepEqual(w.values, ['54TCR008', '54TCR014']);
  });
  await t.test('one batch across two orders is not noise', () => {
    const v = mergeCompat([b(1, 'BATCH NO 54TCR008'), b(2, 'BATCH NO 54TCR008')]);
    assert.equal(v.warnings.some(x => x.field === 'batches'), false);
  });
});

// ── Die memory addressability ───────────────────────────────────────────────
test('repeatsAProduct — can the die memory address this run?', async t => {
  const b = (id, pid, remark) => row({ id, product_id: pid, line_remark: remark });

  await t.test('a normal gang gives each product one slot — addressable', () => {
    assert.equal(repeatsAProduct([b(1, 10), b(2, 11), b(3, 12)]), false);
  });
  await t.test('a BATCH gang gives ONE product five slots — the die key cannot hold it', () => {
    const five = ['54TCR008', '54TCR014', '54TCR015', '54TCR016', '54TCR018']
      .map((n, i) => b(i + 1, 612, `BATCH NO ${n}`));
    assert.equal(repeatsAProduct(five), true);
  });
  await t.test('a mixed gang that happens to repeat one product is also unaddressable', () => {
    assert.equal(repeatsAProduct([b(1, 10), b(2, 10), b(3, 11)]), true);
  });
});
