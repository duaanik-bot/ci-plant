import test from 'node:test';
import assert from 'node:assert/strict';
import { cascadePrQtyToPo } from './routes/procurement.js';

// Editing a converted requisition's quantity reaches into a LIVE purchase
// order, so the guards there matter as much as the arithmetic: never below what
// has already arrived, never on a closed order, and never a set where a delta
// was meant — the PO line may be shared with other requisitions.
//
// Driven with stub qc/oc, so no pool is connected: an escape to the
// module-level q/one would throw rather than pass quietly.

function stub({ poStatus = 'open', poLine = { id: 90, qty: 50, received_qty: 0 }, grnQty = 0, noPoLine = false, po = { id: 500, po_number: 'CI-VPO-0007' }, prLines = [] } = {}) {
  const poUpdates = [], statusUpdates = [], audits = [];
  const qc = async (sql, params = []) => {
    if (/FROM requisition_lines/.test(sql)) return prLines;
    if (/^\s*UPDATE po_lines SET qty/.test(sql)) { poUpdates.push({ qty: params[0], id: params[1] }); return []; }
    if (/SELECT qty, received_qty FROM po_lines/.test(sql)) return [{ qty: poUpdates.length ? poUpdates[0].qty : poLine.qty, received_qty: poLine.received_qty }];
    if (/^\s*UPDATE purchase_orders SET status/.test(sql)) { statusUpdates.push(params[0]); return []; }
    if (/INSERT INTO audit_log/.test(sql)) { audits.push(params[3]); return []; }
    throw new Error(`stub qc got an unexpected statement: ${sql}`);
  };
  const oc = async (sql, params = []) => {
    if (/FROM purchase_orders WHERE id/.test(sql)) return po ? { ...po, status: poStatus } : null;
    if (/FROM po_lines WHERE purchase_order_id/.test(sql)) return noPoLine ? null : poLine;
    if (/FROM materials WHERE id/.test(sql)) return { name: 'FBB 300 GSM 20x38' };
    if (/FROM grns WHERE po_line_id/.test(sql)) return { q: grnQty };
    throw new Error(`stub oc got an unexpected statement: ${sql}`);
  };
  return { qc, oc, poUpdates, statusUpdates, audits };
}

const PR = { id: 11, pr_number: 'CI-PR-0041', purchase_order_id: 500 };

test('raising a requisition adds the DIFFERENCE to the order line, not the new total', () => {
  // The PO line carries 50 because two requisitions fed it. This one asked for
  // 20 and now wants 30, so the line must reach 60 — never 30.
  const { qc, oc, poUpdates } = stub({ poLine: { id: 90, qty: 50, received_qty: 0 }, prLines: [{ material_id: 7, qty: 20 }] });
  return cascadePrQtyToPo(qc, oc, PR, [{ material_id: 7, qty: 30 }]).then(() => {
    assert.deepEqual(poUpdates, [{ qty: 60, id: 90 }]);
  });
});

test('lowering a requisition takes the difference back off', async () => {
  const { qc, oc, poUpdates } = stub({ poLine: { id: 90, qty: 50, received_qty: 0 }, prLines: [{ material_id: 7, qty: 20 }] });
  await cascadePrQtyToPo(qc, oc, PR, [{ material_id: 7, qty: 12 }]);
  assert.deepEqual(poUpdates, [{ qty: 42, id: 90 }]);
});

test('an unchanged quantity touches nothing at all', async () => {
  const { qc, oc, poUpdates, statusUpdates, audits } = stub({ prLines: [{ material_id: 7, qty: 20 }] });
  await cascadePrQtyToPo(qc, oc, PR, [{ material_id: 7, qty: 20 }]);
  assert.deepEqual(poUpdates, [], 'no write');
  assert.deepEqual(statusUpdates, [], 'no status churn');
  assert.deepEqual(audits, [], 'and nothing to say about it');
});

test('the order cannot be cut below what has already been received', async () => {
  const { qc, oc, poUpdates } = stub({
    poLine: { id: 90, qty: 50, received_qty: 45 }, prLines: [{ material_id: 7, qty: 20 }],
  });
  await assert.rejects(
    () => cascadePrQtyToPo(qc, oc, PR, [{ material_id: 7, qty: 2 }]),
    /below the 45 already received/);
  assert.deepEqual(poUpdates, [], 'refused before writing');
});

test('goods still in quarantine count as arrived', async () => {
  // received_qty is 0 — the GRN has not cleared QC. It still pins the floor.
  const { qc, oc } = stub({
    poLine: { id: 90, qty: 50, received_qty: 0 }, grnQty: 40, prLines: [{ material_id: 7, qty: 20 }],
  });
  await assert.rejects(
    () => cascadePrQtyToPo(qc, oc, PR, [{ material_id: 7, qty: 5 }]),
    /below the 40 already received\/in-QC/);
});

test('a closed order refuses the change', async () => {
  const { qc, oc, poUpdates } = stub({ poStatus: 'closed', prLines: [{ material_id: 7, qty: 20 }] });
  await assert.rejects(
    () => cascadePrQtyToPo(qc, oc, PR, [{ material_id: 7, qty: 30 }]),
    /is closed/);
  assert.deepEqual(poUpdates, []);
});

test('a board no longer on the order says so instead of writing nothing', async () => {
  const { qc, oc } = stub({ noPoLine: true, prLines: [{ material_id: 7, qty: 20 }] });
  await assert.rejects(
    () => cascadePrQtyToPo(qc, oc, PR, [{ material_id: 7, qty: 30 }]),
    /no longer on CI-VPO-0007/);
});

test('a converted requisition whose order was deleted refuses rather than silently doing nothing', async () => {
  const { qc, oc } = stub({ po: null, prLines: [{ material_id: 7, qty: 20 }] });
  await assert.rejects(
    () => cascadePrQtyToPo(qc, oc, { ...PR, purchase_order_id: null }, [{ material_id: 7, qty: 30 }]),
    /purchase order is gone/);
});

// The weak point of applying a delta: if the order was edited DOWN on its own
// afterwards, the requisition's own reduction can subtract more than the line
// still has. 20 → 1 is a drop of 19 against a line the buyer already cut to 5.
test('a delta that would drive the order line negative is refused', async () => {
  const { qc, oc, poUpdates } = stub({ poLine: { id: 90, qty: 5, received_qty: 0 }, prLines: [{ material_id: 7, qty: 20 }] });
  await assert.rejects(
    () => cascadePrQtyToPo(qc, oc, PR, [{ material_id: 7, qty: 1 }]),
    /would leave nothing on CI-VPO-0007/);
  assert.deepEqual(poUpdates, [], 'refused before writing');
});

test('adding a board to a converted requisition is refused before any write', async () => {
  const { qc, oc, poUpdates } = stub({ prLines: [{ material_id: 7, qty: 20 }] });
  await assert.rejects(
    () => cascadePrQtyToPo(qc, oc, PR, [{ material_id: 7, qty: 20 }, { material_id: 9, qty: 5 }]),
    /raise a new requisition/);
  assert.deepEqual(poUpdates, []);
});

test('the order status is re-derived and the change is audited against the PO', async () => {
  const { qc, oc, statusUpdates, audits } = stub({ poLine: { id: 90, qty: 50, received_qty: 0 }, prLines: [{ material_id: 7, qty: 20 }] });
  await cascadePrQtyToPo(qc, oc, PR, [{ material_id: 7, qty: 30 }], 'Anik');
  assert.deepEqual(statusUpdates, ['open'], 'a raised order is short again');
  assert.match(audits[0], /CI-PR-0041/, 'the order records which requisition moved it');
  assert.match(audits[0], /20→30/);
});
