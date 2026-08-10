import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fgReceipt, clawBackFgReceipt } from './helpers.js';

// THE INVARIANT everything here rests on:
//   fg_stock for a card == SUM(its fg_receipt movement rows)
// Adjusting a closed job posts a SIGNED delta through fgReceipt() so the sum
// still equals the pool, which is what clawBackFgReceipt() reads. Break that and
// a reverse either under- or over-claws — the failure that doubled prod stock.

const ledger = () => {
  const rows = [];
  let pool = 0;
  const qc = async (sql, params) => {
    if (/INSERT INTO fg_stock/.test(sql)) { pool += params[1]; return []; }
    if (/INSERT INTO stock_movements/.test(sql)) { rows.push(params[1]); return []; }
    if (/UPDATE fg_stock SET qty = GREATEST/.test(sql)) { pool = Math.max(0, pool - params[0]); return []; }
    if (/DELETE FROM stock_movements/.test(sql)) { rows.length = 0; return []; }
    return [];
  };
  const oc = async () => ({ n: rows.reduce((a, b) => a + b, 0) });
  return { qc, oc, sum: () => rows.reduce((a, b) => a + b, 0), pool: () => pool };
};

test('close then adjust DOWN — the pool follows the stage, sum still equals pool', async () => {
  const l = ledger();
  await fgReceipt(586, 10200, 'job_card', 10, l.qc);   // close
  await fgReceipt(586, -200, 'job_card', 10, l.qc);    // adjust 10,200 -> 10,000
  assert.equal(l.pool(), 10000);
  assert.equal(l.sum(), 10000, 'the movement rows must still add up to the pool');
});

test('close then adjust UP', async () => {
  const l = ledger();
  await fgReceipt(586, 10200, 'job_card', 10, l.qc);
  await fgReceipt(586, 300, 'job_card', 10, l.qc);
  assert.equal(l.pool(), 10500);
  assert.equal(l.sum(), 10500);
});

test('THE ONE THAT MATTERS — adjust then REVERSE claws back the adjusted total, not the original', async () => {
  const l = ledger();
  await fgReceipt(586, 10200, 'job_card', 10, l.qc);
  await fgReceipt(586, -200, 'job_card', 10, l.qc);
  const back = await clawBackFgReceipt({ id: 10, product_id: 586 }, l.qc, l.oc);
  assert.equal(back, 10000, 'claws back what is actually there');
  assert.equal(l.pool(), 0, 'nothing of this card is left in the pool');
});

test('reverse then re-close does NOT double — the whole point', async () => {
  const l = ledger();
  await fgReceipt(586, 10200, 'job_card', 10, l.qc);
  await clawBackFgReceipt({ id: 10, product_id: 586 }, l.qc, l.oc);  // reverse
  await fgReceipt(586, 10200, 'job_card', 10, l.qc);                 // re-close
  assert.equal(l.pool(), 10200, 'once, not 20,400');
  assert.equal(l.sum(), 10200);
});
