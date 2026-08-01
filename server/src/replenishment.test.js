import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestedQty, enrichStockRow, normalisePurpose, stockSplit, PR_PURPOSES } from './replenishment.js';
import * as twin from '../../client/src/lib/replenishment.js';

// Real plant fixture: Duplex GB · 340 GSM · 20x38, bought 144 sheets to a packet.
const board = { available: 4200, reserved: 6000, incoming: 2000, reorder_level: 1500,
  max_stock: 0, sheets_per_packet: 144 };

// The core rule: buy enough to cover committed jobs AND put the reorder buffer
// back on the shelf, net of what is already on the water.
// 6000 + 1500 - 4200 - 2000 = 1300 → rounded up to 10 packets = 1440.
test('suggestedQty: demand + reorder buffer, net of stock and incoming, rounded to packets', () => {
  assert.equal(suggestedQty(board), 1440);
});

// Stock already covers demand and the buffer → buy nothing. Never negative.
test('suggestedQty: covered position suggests zero', () => {
  assert.equal(suggestedQty({ ...board, available: 99000 }), 0);
});

// Incoming stock counts. An open PO for the full shortfall means no new PR.
test('suggestedQty: open PO quantity removes the need', () => {
  assert.equal(suggestedQty({ ...board, incoming: 3300 }), 0);
});

// max_stock caps the resulting POSITION (available + incoming + suggested),
// not the order size. 5000 - 4200 - 2000 = 0 headroom → nothing to buy.
test('suggestedQty: max_stock caps the resulting position', () => {
  assert.equal(suggestedQty({ ...board, max_stock: 5000 }), 0);
});

// Headroom of 800 caps the 1300 need, then the packet round-up lifts it to 864.
// Overshooting max by less than one packet is correct: you cannot buy 5.5 packets.
test('suggestedQty: cap applies before the packet round-up, which may overshoot max', () => {
  assert.equal(suggestedQty({ ...board, max_stock: 7000 }), 864);
});

// A material with no packet size returns the raw figure, not a rounded guess.
test('suggestedQty: no sheets_per_packet → raw quantity', () => {
  assert.equal(suggestedQty({ ...board, sheets_per_packet: null }), 1300);
});

// A count corrected below zero is real in this plant. It is NOT clamped to 0
// before the formula, so the suggestion grows to refill the hole.
test('suggestedQty: negative available increases the suggestion', () => {
  assert.equal(suggestedQty({ ...board, available: -300, incoming: 0, reorder_level: 0 }), 6336);
});

// A master with nothing set suggests nothing rather than throwing.
test('suggestedQty: empty master → 0', () => {
  assert.equal(suggestedQty({}), 0);
  assert.equal(suggestedQty(null), 0);
});

// available/reserved/reorder_level/incoming are all DOUBLE PRECISION columns
// (see stock_batches.qty, po_lines.received_qty, materials.reorder_level in
// db.js), so a position that is arithmetically balanced can land a hair off
// zero: 0.1 + 0.2 - 0.3 is 5.551115123125783e-17 in IEEE754, not 0. That
// epsilon must not be read as a real shortfall and rounded up to a phantom
// whole packet.
test('suggestedQty: position balanced within float noise suggests zero', () => {
  assert.equal(suggestedQty({ reserved: 0.1, reorder_level: 0.2, available: 0.3,
    incoming: 0, sheets_per_packet: 144, max_stock: 0 }), 0);
});

// need is a difference of four float columns, so a position that is
// conceptually an exact multiple of the packet size can arrive a hair above
// it (1440.0000000001, not 1440) and must still resolve to 10 packets, not
// 11 — the `- EPS` inside the ceil is what nudges it back down. A need that
// lands exactly on the multiple, with no noise at all, must stay put too.
test('suggestedQty: float noise just above an exact multiple does not overshoot by a packet', () => {
  assert.equal(suggestedQty({ reserved: 1440.0000000001, reorder_level: 0, available: 0,
    incoming: 0, sheets_per_packet: 144, max_stock: 0 }), 1440);
  assert.equal(suggestedQty({ reserved: 1440, reorder_level: 0, available: 0,
    incoming: 0, sheets_per_packet: 144, max_stock: 0 }), 1440);
});

// enrichStockRow is what the route maps over: it attaches the three derived
// fields and preserves the existing `demand` key and `short` rule verbatim.
test('enrichStockRow: attaches reserved/incoming/suggested and keeps demand + short', () => {
  const row = enrichStockRow(
    { id: 7, name: 'Duplex GB 340 20x38', available: 4200, reorder_level: 1500, sheets_per_packet: 144 },
    { reserved: 6000, incoming: 2000 });
  assert.equal(row.reserved, 6000);
  assert.equal(row.demand, 6000);      // legacy key preserved for existing callers
  assert.equal(row.incoming, 2000);
  assert.equal(row.suggested, 1440);
  assert.equal(row.short, true);       // reorder_level > available
  assert.equal(row.name, 'Duplex GB 340 20x38');
});

test('enrichStockRow: healthy row is not short', () => {
  const row = enrichStockRow({ id: 8, available: 9000, reorder_level: 1500 }, { reserved: 100, incoming: 0 });
  assert.equal(row.short, false);
  assert.equal(row.suggested, 0);
});

// Missing aggregates default to 0 rather than undefined leaking into the UI.
test('enrichStockRow: absent aggregates default to zero', () => {
  const row = enrichStockRow({ id: 9, available: 10 }, {});
  assert.equal(row.reserved, 0);
  assert.equal(row.incoming, 0);
  assert.equal(row.suggested, 0);
});

// purpose is a closed vocabulary; anything unknown falls back to 'production'
// so a bad client can never write a value the register cannot render.
test('normalisePurpose: known values pass, unknown falls back to production', () => {
  assert.equal(normalisePurpose('stock_replenishment'), 'stock_replenishment');
  assert.equal(normalisePurpose('reorder_level'), 'reorder_level');
  assert.equal(normalisePurpose('general_inventory'), 'general_inventory');
  assert.equal(normalisePurpose('production'), 'production');
  assert.equal(normalisePurpose('nonsense'), 'production');
  assert.equal(normalisePurpose(''), 'production');
  assert.equal(normalisePurpose(null), 'production');
  assert.equal(normalisePurpose(undefined), 'production');
});

test('PR_PURPOSES is the closed vocabulary', () => {
  assert.deepEqual(PR_PURPOSES,
    ['production', 'stock_replenishment', 'reorder_level', 'general_inventory']);
});

// The client twin must agree with the server on every case, or the PR form will
// show a number the server would not have produced.
test('client twin produces identical output', () => {
  const cases = [
    board,
    { ...board, available: 99000 },
    { ...board, incoming: 3300 },
    { ...board, max_stock: 5000 },
    { ...board, max_stock: 7000 },
    { ...board, sheets_per_packet: null },
    { ...board, available: -300, incoming: 0, reorder_level: 0 },
    { ...board, available: '4200' },  // numeric string, e.g. straight off a form field
    { ...board, available: NaN },     // junk input
    { ...board, max_stock: '0' },     // string zero must coerce like numeric zero, not "set"
    { ...board, reserved: '6000' },
    {},
  ];
  for (const c of cases) assert.equal(twin.suggestedQty(c), suggestedQty(c));
  for (const c of cases) assert.deepEqual(twin.stockSplit(c), stockSplit(c));
  assert.deepEqual(twin.PR_PURPOSES, PR_PURPOSES);
  assert.equal(twin.normalisePurpose('nonsense'), normalisePurpose('nonsense'));
});


// ── stockSplit: the warehouse position the KPI strip reports ────────────────
// Committed is what the PLANNING ENGINE has locked (board_allocations), never a
// requirement inferred from an order line's status. The plant reads these to
// decide what it can still promise, so the split must stay exact when summed.

test('stockSplit: a locked plan is subtracted from the shelf', () => {
  assert.deepEqual(stockSplit({ available: 1000, committed_qty: 300 }),
    { committed: 300, net: 700, over_committed: 0 });
});

test('stockSplit: nothing locked — the whole shelf is free', () => {
  assert.deepEqual(stockSplit({ available: 250, committed_qty: 0 }),
    { committed: 0, net: 250, over_committed: 0 });
});

// An order line's requirement is NOT a lock. A board with demand but no plan
// locked against it stays fully available — that is the definition the plant
// asked for, and the reason `reserved`/`demand` are ignored here.
test('stockSplit: unplanned requirement does not touch the shelf', () => {
  assert.deepEqual(stockSplit({ available: 800, reserved: 5000, demand: 5000 }),
    { committed: 0, net: 800, over_committed: 0 });
});

// Locks beyond the shelf are a fault to reconcile, not negative free stock.
test('stockSplit: locked beyond stock caps at the shelf and reports the excess', () => {
  assert.deepEqual(stockSplit({ available: 100, committed_qty: 500 }),
    { committed: 100, net: 0, over_committed: 400 });
});

test('stockSplit: negative stock never becomes negative net or negative committed', () => {
  assert.deepEqual(stockSplit({ available: -300, committed_qty: 200 }),
    { committed: 0, net: 0, over_committed: 200 });
});

test('stockSplit: survives junk and numeric strings', () => {
  assert.deepEqual(stockSplit({}), { committed: 0, net: 0, over_committed: 0 });
  assert.deepEqual(stockSplit({ available: NaN, committed_qty: NaN }),
    { committed: 0, net: 0, over_committed: 0 });
  assert.deepEqual(stockSplit({ available: '1000', committed_qty: '250' }),
    { committed: 250, net: 750, over_committed: 0 });
});

// Float dust off a SUM() must not manufacture an over-commitment.
test('stockSplit: float dust does not manufacture an over-commitment', () => {
  const s = stockSplit({ available: 1000, committed_qty: 1000.0000001 });
  assert.equal(s.over_committed, 0);
  assert.equal(s.net, 0);
  assert.equal(s.committed, 1000);
});

// THE INVARIANT the strip rests on. Gross must equal Committed + Net for any
// mix of boards — including the mix that tempts cross-board netting: one board
// in surplus, one over-locked. Summing raw (available − locked) would report
// 1,640 net here; the plant actually has 2,340 free and 400 to reconcile.
test('stockSplit: committed + net === gross, per row and summed', () => {
  const rows = [
    { available: 1000, committed_qty: 300 },   // partly locked
    { available: 100, committed_qty: 500 },    // locked beyond the shelf
    { available: 0, committed_qty: 900 },      // nothing on the shelf
    { available: 640, committed_qty: 0 },      // untouched
    { available: -50, committed_qty: 25 },     // negative correction
    { available: 1234.5, committed_qty: 234.5 },
  ];
  let gross = 0, committed = 0, net = 0, over = 0;
  for (const r of rows) {
    const s = stockSplit(r);
    const shelf = Math.max(0, r.available);
    assert.equal(s.committed + s.net, shelf, `row ${JSON.stringify(r)}`);
    gross += shelf; committed += s.committed; net += s.net; over += s.over_committed;
  }
  assert.equal(committed + net, gross);
  assert.equal(net, 700 + 0 + 0 + 640 + 0 + 1000);
  assert.equal(committed, 300 + 100 + 0 + 0 + 0 + 234.5);
  assert.equal(over, 400 + 900 + 25);
});

// enrichStockRow carries the planning locks and the open-PR figure through, so
// the strip, the board list and the exports all read the same numbers.
test('enrichStockRow exposes the locks and the open PR figure', () => {
  const row = enrichStockRow({ available: 1000, reorder_level: 0 },
    { reserved: 4000, committed_qty: 300, committed_lines: 2, pr_qty: 1500, pr_count: 1 });
  assert.equal(row.demand, 4000);        // legacy requirement key untouched
  assert.equal(row.committed_qty, 300);  // what planning locked
  assert.equal(row.committed, 300);
  assert.equal(row.net, 700);
  assert.equal(row.committed_lines, 2);
  assert.equal(row.pr_qty, 1500);
  assert.equal(row.pr_count, 1);
});
