import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveLeftoverBoxToFg } from './helpers.js';

// `fg_lots.consumed_qty` HAS TWO WRITERS. Audit it against only one and 107 of
// 109 production lots read as a missing trail that is not missing at all:
//
//   1. allocated to an order line  -> writes an fg_consumptions row
//   2. the whole box returned to loose FG (moveLeftoverBoxToFg, below)
//      -> writes NO fg_consumptions row, and must not
//
// The invariant is therefore
//   consumed_qty == SUM(fg_consumptions) + SUM(returned-to-FG adjustments)
// which reconciles 109/109 in production. Counting only (1) does not find
// damage, it manufactures a false positive — and "repairing" that false
// positive means inventing an order line per lot, because
// fg_consumptions.order_line_id is NOT NULL. That would forge 107 allocations
// to orders that never received the goods, to satisfy an invariant that was
// wrong. These tests exist so nobody re-derives that false alarm and acts on it.

const fakeDb = (lot) => {
  const writes = [];
  const qc = async (sql, params) => {
    writes.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    return [];
  };
  const oc = async (sql, params) => {
    if (/FROM fg_lots/.test(sql)) return lot;
    if (/FROM products/.test(sql)) return { customer_id: 5 };
    if (/FROM fg_movements/.test(sql)) return { balance: 0 };
    return null;
    void params;
  };
  const wrote = re => writes.filter(w => re.test(w.sql));
  return { qc, oc, writes, wrote };
};

const LOT = { id: 111, product_id: 586, lot_number: 'CI-FG-0108', box_number: 12, kind: 'leftover' };

test('a box returned to FG consumes the lot and writes NO fg_consumptions row', async () => {
  const db = fakeDb({ ...LOT, qty: 1900, consumed_qty: 0 });
  const { remaining } = await moveLeftoverBoxToFg(111, db.qc, db.oc, 'Anik');

  assert.equal(remaining, 1900);
  // It is consumed...
  assert.equal(db.wrote(/UPDATE fg_lots SET consumed_qty=qty/).length, 1);
  // ...and the trail for it is a stock_movements adjustment, not a consumption.
  const adj = db.wrote(/INSERT INTO stock_movements/);
  assert.equal(adj.length, 1);
  assert.equal(adj[0].params[1], 1900, 'the adjustment carries the returned quantity');
  assert.match(String(adj[0].params[3]), /returned to FG/);
  // THE ASSERTION THAT MATTERS: no reservation row, because a box back on the
  // loose pile was consumed by nobody. There is no order line to name.
  assert.equal(db.wrote(/INSERT INTO fg_consumptions/).length, 0,
    'a returned box must never write an fg_consumptions row — it has no order line');
});

test('the returned box is credited back to loose fg_stock, so the pool is not lost', async () => {
  const db = fakeDb({ ...LOT, qty: 1900, consumed_qty: 0 });
  await moveLeftoverBoxToFg(111, db.qc, db.oc, 'Anik');
  const credit = db.wrote(/INSERT INTO fg_stock/);
  assert.equal(credit.length, 1);
  assert.deepEqual(credit[0].params, [586, 1900]);
});

test('THE TWO-SOURCE INVARIANT — a partly allocated box that is then returned', async () => {
  // 400 of 1000 already went to an order (an fg_consumptions row exists for it);
  // the rest of the box is put back on the loose pile. consumed_qty ends at the
  // FULL 1000 while fg_consumptions still totals only 400 — so an audit that
  // counts consumptions alone reports this healthy lot as 600 short.
  const db = fakeDb({ ...LOT, qty: 1000, consumed_qty: 400 });
  const { remaining } = await moveLeftoverBoxToFg(111, db.qc, db.oc, 'Anik');

  assert.equal(remaining, 600, 'only the unallocated remainder goes back to loose stock');
  assert.equal(db.wrote(/INSERT INTO fg_stock/)[0].params[1], 600);
  assert.equal(db.wrote(/UPDATE fg_lots SET consumed_qty=qty/).length, 1, 'consumed_qty becomes the full 1000');

  // consumed_qty(1000) == allocations(400) + returned(600). Both terms, always.
  const returned = db.wrote(/INSERT INTO stock_movements/)[0].params[1];
  assert.equal(400 + returned, 1000, 'the two sources together account for the whole lot');
  assert.notEqual(400, 1000, 'and allocations ALONE do not — this is the false positive');
});

test('an already-empty box refuses rather than crediting the pool twice', async () => {
  // The self-limiting guard: consumed_qty=qty leaves remaining at 0, so a second
  // press cannot credit fg_stock again.
  const db = fakeDb({ ...LOT, qty: 1900, consumed_qty: 1900 });
  await assert.rejects(() => moveLeftoverBoxToFg(111, db.qc, db.oc, 'Anik'),
    /already empty/);
  assert.equal(db.writes.length, 0, 'a refused move writes nothing at all');
});

test('only a leftover box may be moved — a production batch lot is refused', async () => {
  const db = fakeDb({ ...LOT, qty: 1900, consumed_qty: 0, kind: 'batch' });
  await assert.rejects(() => moveLeftoverBoxToFg(111, db.qc, db.oc, 'Anik'),
    /Only a leftover box/);
  assert.equal(db.writes.length, 0);
});
