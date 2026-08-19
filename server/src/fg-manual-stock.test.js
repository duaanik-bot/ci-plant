import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adjustFgStock, boxLeftoverFromFg } from './helpers.js';

// Manually seeding and correcting finished goods from the FG Stock screen.
// Two doors, and the thing that makes them safe is the same thing in both:
//
//   THE LEDGER RECORDS WHAT ACTUALLY MOVED, NEVER WHAT WAS TYPED.
//
// A reduction beyond the book is a real event — a count correction caught late —
// but the pool must land at nil, never negative (the write-on rule the RM
// warehouse already follows). If the movement row kept the TYPED figure while
// the pool clamped, `SUM(movements) == pool` breaks and every downstream reader
// of the FG ledger — Product 360's running balance, the clawback on a reversed
// job card — reads stock that was never there.

const ledger = () => {
  const rows = [];
  let pool = 0;
  const audits = [];
  const lots = [];
  const qc = async (sql, params) => {
    if (/INSERT INTO fg_stock/.test(sql)) { pool += +params[1]; return []; }
    if (/UPDATE fg_stock SET qty = GREATEST/.test(sql)) { pool = Math.max(0, pool - +params[0]); return []; }
    if (/UPDATE fg_stock SET qty = qty - /.test(sql)) { pool -= +params[0]; return []; }
    if (/INSERT INTO stock_movements/.test(sql)) { rows.push({ qty: +params[1], note: params[3] ?? params[4] }); return []; }
    if (/INSERT INTO audit_log/.test(sql)) { audits.push(params[3]); return []; }
    if (/INSERT INTO fg_lots/.test(sql)) { lots.push({ lot_number: params[0], box_number: params[1] }); return [{ id: lots.length }]; }
    if (/INSERT INTO fg_movements/.test(sql)) { return []; }
    return [];
  };
  const oc = async sql => {
    if (/FROM fg_stock/.test(sql)) return { qty: pool };
    if (/FROM products/.test(sql)) return { customer_id: 7 };
    if (/FROM fg_lots|FROM fg_movements/.test(sql)) return null;   // no prior number, no prior balance
    return null;
  };
  return { qc, oc, rows, lots, audits, pool: () => pool, sum: () => rows.reduce((a, r) => a + r.qty, 0) };
};

const seed = async (l, n) => { await adjustFgStock({ product_id: 5, qty: n, note: 'Opening stock', user: 'anik' }, l.qc, l.oc); };

test('adding manual FG stock raises the pool and writes a matching movement', async () => {
  const l = ledger();
  const r = await adjustFgStock({ product_id: 5, qty: 400, note: 'Opening stock', user: 'anik' }, l.qc, l.oc);
  assert.equal(l.pool(), 400);
  assert.equal(l.sum(), 400, 'the movement row must equal what entered the pool');
  assert.deepEqual([r.before, r.after, r.applied, r.clamped], [0, 400, 400, false]);
});

test('reducing within the book takes exactly what was asked', async () => {
  const l = ledger();
  await seed(l, 400);
  const r = await adjustFgStock({ product_id: 5, qty: -150, note: 'Damage', user: 'anik' }, l.qc, l.oc);
  assert.equal(l.pool(), 250);
  assert.equal(l.sum(), 250, 'movements still add up to the pool');
  assert.deepEqual([r.before, r.after, r.applied, r.clamped], [400, 250, 150, false]);
});

test('THE ONE THAT MATTERS — a reduction beyond the book clamps at nil and the ledger records only what was there', async () => {
  const l = ledger();
  await seed(l, 40);
  const r = await adjustFgStock({ product_id: 5, qty: -150, note: 'Count correction', user: 'anik' }, l.qc, l.oc);
  assert.equal(l.pool(), 0, 'never negative');
  assert.equal(r.applied, 40, 'only the 40 that existed actually left');
  assert.equal(r.clamped, true, 'the caller is told the ask was cut short');
  assert.equal(l.sum(), 0, 'SUM(movements) == pool — the ledger never records the 110 that was not there');
});

test('an adjustment of zero is refused rather than writing an empty movement', async () => {
  const l = ledger();
  await seed(l, 100);
  await assert.rejects(() => adjustFgStock({ product_id: 5, qty: 0, note: '', user: 'anik' }, l.qc, l.oc));
  assert.equal(l.rows.length, 1, 'nothing new was written');
});

test('a manual leftover box does NOT carve its cartons out of loose FG', async () => {
  const l = ledger();
  await seed(l, 500);
  const box = await boxLeftoverFromFg(
    { product_id: 5, qty: 120, source: 'manual', created_by: 'anik', reduceFg: false }, l.qc, l.oc);
  assert.equal(l.pool(), 500, 'goods arriving from outside loose stock leave In Stock alone');
  assert.equal(box.qty, 120);
  assert.match(box.box_number, /^CI-BOX-/, 'the box is numbered');
});

test('a manual leftover box can carry the physical label already on the carton', async () => {
  const l = ledger();
  const box = await boxLeftoverFromFg(
    { product_id: 5, qty: 60, source: 'manual', created_by: 'anik', reduceFg: false, box_number: 'SG-2214' }, l.qc, l.oc);
  assert.equal(box.box_number, 'SG-2214', 'the typed label wins over the auto CI-BOX-####');
  assert.match(box.lot_number, /^CI-FG-/, 'the stock reference is still system-issued');
});
