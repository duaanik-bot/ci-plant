import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clawBackFgReceipt } from './helpers.js';

// fgReceipt() is unconditional — `qty = fg_stock.qty + EXCLUDED.qty` plus a new
// movement row, no idempotency guard. Anything that can re-run a close must
// claw the previous credit back first. It did not, and 2 of 2 production
// reverses doubled the pool (BIODOXI LB 20,400 against 10,200 actually made).

const db = (creditRows) => {
  const w = [];
  const oc = async () => ({ n: creditRows.reduce((a, b) => a + b, 0) });
  const qc = async (sql, params) => { w.push({ sql: sql.replace(/\s+/g, ' ').trim(), params }); return []; };
  return { qc, oc, w };
};

test('claws back exactly what was credited, and drops the receipt rows', async () => {
  const { qc, oc, w } = db([10200]);
  const n = await clawBackFgReceipt({ id: 7, product_id: 586 }, qc, oc);
  assert.equal(n, 10200);
  assert.match(w[0].sql, /UPDATE fg_stock SET qty = GREATEST\(0, qty - \$1\)/);
  assert.deepEqual(w[0].params, [10200, 586]);
  assert.match(w[1].sql, /DELETE FROM stock_movements/);
});

test('an ALREADY-DOUBLED pool is fully un-credited — it sums the rows, not a stage figure', async () => {
  // The exact prod shape: two fg_receipt rows, same ref_id, same qty.
  const { qc, oc, w } = db([10200, 10200]);
  assert.equal(await clawBackFgReceipt({ id: 7, product_id: 586 }, qc, oc), 20400);
  assert.deepEqual(w[0].params, [20400, 586]);
});

test('nothing credited — no write at all, so it is safe to call unconditionally', async () => {
  const { qc, oc, w } = db([]);
  assert.equal(await clawBackFgReceipt({ id: 7, product_id: 586 }, qc, oc), 0);
  assert.equal(w.length, 0);
});

test('never drives the pool negative', async () => {
  const { qc, oc, w } = db([10200]);
  await clawBackFgReceipt({ id: 7, product_id: 586 }, qc, oc);
  assert.match(w[0].sql, /GREATEST\(0,/, 'a partial dispatch must not leave fg_stock below zero');
});
