import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kgPerSheet, packetWeight, ratePerSheet, packetRate, totalWeight, packets, resolveRatePerKg, stockValueOf } from './board-math.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !== ${b}`);

// ── kgPerSheet ────────────────────────────────────────────────────────
// gsm × (L×0.0254) × (W×0.0254) / 1000 — the spreadsheet's column J formula.
test('kgPerSheet: golden values from the plant spreadsheet', () => {
  near(kgPerSheet({ gsm: 330, sheet_l: 24.6, sheet_w: 31.2 }), 0.16340715705599998);
  near(kgPerSheet({ gsm: 290, sheet_l: 20, sheet_w: 38 }), 0.14219326399999999);
  near(kgPerSheet({ gsm: 300, sheet_l: 23, sheet_w: 36 }), 0.160257744);
  near(kgPerSheet({ gsm: 205, sheet_l: 22, sheet_w: 28 }), 0.08147080479999998);
});
test('kgPerSheet: missing or zero inputs return null, never 0', () => {
  assert.equal(kgPerSheet({ gsm: null, sheet_l: 20, sheet_w: 30 }), null);
  assert.equal(kgPerSheet({ gsm: 300, sheet_l: 0, sheet_w: 30 }), null);
  assert.equal(kgPerSheet({ gsm: 300, sheet_w: 30 }), null);
  assert.equal(kgPerSheet(null), null);
  assert.equal(kgPerSheet(undefined), null);
});

// ── packetWeight ──────────────────────────────────────────────────────
test('packetWeight: rounds to the spreadsheet 3dp display value', () => {
  assert.equal(+packetWeight({ gsm: 330, sheet_l: 24.6, sheet_w: 31.2, sheets_per_packet: 144 }).toFixed(3), 23.531);
  assert.equal(+packetWeight({ gsm: 290, sheet_l: 20, sheet_w: 38, sheets_per_packet: 100 }).toFixed(3), 14.219);
  assert.equal(+packetWeight({ gsm: 205, sheet_l: 22, sheet_w: 28, sheets_per_packet: 150 }).toFixed(3), 12.221);
});
test('packetWeight: null when sheets_per_packet is unknown', () => {
  assert.equal(packetWeight({ gsm: 300, sheet_l: 23, sheet_w: 36 }), null);
  assert.equal(packetWeight({ gsm: 300, sheet_l: 23, sheet_w: 36, sheets_per_packet: 0 }), null);
});

// ── ratePerSheet / packetRate ─────────────────────────────────────────
test('ratePerSheet: kg/sheet × ₹/kg', () => {
  near(ratePerSheet({ gsm: 300, sheet_l: 23, sheet_w: 36 }, 81), 12.980877264);
  near(ratePerSheet({ gsm: 290, sheet_l: 20, sheet_w: 38 }, 79), 11.233267856);
});
test('packetRate: matches the spreadsheet column K to 2dp', () => {
  const saffire = { gsm: 300, sheet_l: 23, sheet_w: 36, sheets_per_packet: 100 };
  assert.equal(+packetRate(saffire, 81).toFixed(2), 1298.09);
  const duplexGb = { gsm: 330, sheet_l: 24.6, sheet_w: 31.2, sheets_per_packet: 144 };
  assert.equal(+packetRate(duplexGb, 45).toFixed(2), 1058.88);
});
test('rates: a null/zero ₹/kg yields null, not 0 — "no rate" must be visible', () => {
  assert.equal(ratePerSheet({ gsm: 300, sheet_l: 23, sheet_w: 36 }, null), null);
  assert.equal(ratePerSheet({ gsm: 300, sheet_l: 23, sheet_w: 36 }, 0), null);
  assert.equal(packetRate({ gsm: 300, sheet_l: 23, sheet_w: 36, sheets_per_packet: 100 }, null), null);
});

// ── totalWeight / packets ─────────────────────────────────────────────
test('totalWeight: sheets × kg/sheet, and 0 sheets is a real 0', () => {
  near(totalWeight({ gsm: 300, sheet_l: 23, sheet_w: 36 }, 1000), 160.257744);
  assert.equal(totalWeight({ gsm: 300, sheet_l: 23, sheet_w: 36 }, 0), 0);
  assert.equal(totalWeight({ gsm: null, sheet_l: 23, sheet_w: 36 }, 1000), null);
});
test('packets: fractional packets are preserved, never rounded', () => {
  assert.equal(packets({ sheets_per_packet: 100 }, 250), 2.5);
  assert.equal(packets({ sheets_per_packet: 144 }, 144), 1);
  assert.equal(packets({ sheets_per_packet: null }, 250), null);
});

// ── resolveRatePerKg ──────────────────────────────────────────────────
const RATES = [
  { grade: 'Saffire', vendor_id: null, rate_per_kg: 81, active: 1 },
  { grade: 'Saffire', vendor_id: 7, rate_per_kg: 84, active: 1 },
  { grade: 'FBB', vendor_id: null, rate_per_kg: 79, active: 1 },
  { grade: 'Duplex GB', vendor_id: null, rate_per_kg: 45, active: 0 }, // inactive
];

test('resolveRatePerKg: vendor row wins over base', () => {
  assert.deepEqual(resolveRatePerKg(RATES, 'Saffire', 7), { rate_per_kg: 84, source: 'vendor' });
});
test('resolveRatePerKg: falls back to base when the vendor has no row', () => {
  assert.deepEqual(resolveRatePerKg(RATES, 'Saffire', 9), { rate_per_kg: 81, source: 'base' });
  assert.deepEqual(resolveRatePerKg(RATES, 'Saffire', null), { rate_per_kg: 81, source: 'base' });
});
test('resolveRatePerKg: unrated grade returns null — never falls through to a historical price', () => {
  assert.equal(resolveRatePerKg(RATES, 'Paper', 7), null);
  assert.equal(resolveRatePerKg(RATES, 'Duplex GB', 7), null); // inactive row ignored
  assert.equal(resolveRatePerKg(RATES, null, 7), null);
  assert.equal(resolveRatePerKg([], 'Saffire', 7), null);
});
test('resolveRatePerKg: grade match is case- and whitespace-insensitive', () => {
  assert.equal(resolveRatePerKg(RATES, '  saffire ', null).rate_per_kg, 81);
});
test('resolveRatePerKg: vendor_id compares across string/number forms', () => {
  assert.equal(resolveRatePerKg(RATES, 'Saffire', '7').rate_per_kg, 84);
});

// ── fail-closed edge cases ────────────────────────────────────────────
// A rate row only counts as live on a strict numeric 1. Anything else — false,
// "0", or an `active` column omitted from the SELECT — must be ignored rather
// than silently priced, since this feeds purchase orders.
test('resolveRatePerKg: only active === 1 resolves; false/"0"/absent all fail closed', () => {
  const grade = 'Kappa';
  assert.equal(resolveRatePerKg([{ grade, vendor_id: null, rate_per_kg: 50, active: 1 }], grade, null).rate_per_kg, 50);
  assert.equal(resolveRatePerKg([{ grade, vendor_id: null, rate_per_kg: 50, active: '1' }], grade, null).rate_per_kg, 50);
  for (const active of [0, false, '0', null, undefined]) {
    assert.equal(resolveRatePerKg([{ grade, vendor_id: null, rate_per_kg: 50, active }], grade, null), null,
      `active: ${JSON.stringify(active)} must not resolve`);
  }
  // `active` missing from the row entirely (e.g. trimmed out of a SELECT).
  assert.equal(resolveRatePerKg([{ grade, vendor_id: null, rate_per_kg: 50 }], grade, null), null);
});
test('resolveRatePerKg: a resolved row carrying rate_per_kg 0 is treated as unrated', () => {
  const rows = [{ grade: 'Kappa', vendor_id: null, rate_per_kg: 0, active: 1 }];
  assert.equal(resolveRatePerKg(rows, 'Kappa', null), null);
  // …and a zero-rate vendor row does not fall back to a valid base row: the
  // vendor row won the match, so "no usable rate" is the honest answer.
  const withBase = [{ grade: 'Kappa', vendor_id: null, rate_per_kg: 60, active: 1 },
                    { grade: 'Kappa', vendor_id: 3, rate_per_kg: 0, active: 1 }];
  assert.equal(resolveRatePerKg(withBase, 'Kappa', 3), null);
});
test('kgPerSheet: non-numeric and NaN inputs return null', () => {
  assert.equal(kgPerSheet({ gsm: 'abc', sheet_l: 20, sheet_w: 30 }), null);
  assert.equal(kgPerSheet({ gsm: NaN, sheet_l: 20, sheet_w: 30 }), null);
  assert.equal(kgPerSheet({ gsm: 300, sheet_l: 'wide', sheet_w: 30 }), null);
  assert.equal(kgPerSheet({ gsm: 300, sheet_l: 20, sheet_w: '' }), null);
});
// Negatives pass through deliberately: the cutting-variance ledger can legitimately
// go negative (an over-cut refunds board), so a negative sheet count must produce a
// signed result, not null. Locked in so the choice stays deliberate.
test('totalWeight / packets: a negative sheet count yields a signed result, not null', () => {
  near(totalWeight({ gsm: 300, sheet_l: 23, sheet_w: 36 }, -1000), -160.257744);
  assert.equal(packets({ sheets_per_packet: 100 }, -250), -2.5);
});

// ── stockValueOf ──────────────────────────────────────────────────────
// Stock value is a PER-BATCH sum, not a blended rate: each batch is worth
// what was actually paid for it, and only quantity whose cost was never
// recorded falls back to the board master rate.
test('stock value: fully costed stock ignores the master rate entirely', () => {
  assert.equal(stockValueOf({ available: 100, costed_qty: 100, costed_value: 640 }, 99), 640);
});

test('stock value: mixes actual cost with the master rate for uncosted qty', () => {
  // 60 sheets cost 400 in reality; the other 40 have no recorded cost and
  // fall back to the master ₹6/sheet.
  assert.equal(stockValueOf({ available: 100, costed_qty: 60, costed_value: 400 }, 6), 640);
});

test('stock value: pre-migration stock with no costs reads exactly as before', () => {
  assert.equal(stockValueOf({ available: 100, costed_qty: 0, costed_value: 0 }, 6), 600);
});

test('stock value: unknown when uncosted qty has no master rate to fall back on', () => {
  assert.equal(stockValueOf({ available: 100, costed_qty: 0, costed_value: 0 }, null), null);
  assert.equal(stockValueOf({ available: 100, costed_qty: 60, costed_value: 400 }, null), null);
});

test('stock value: no stock is worth zero, not unknown', () => {
  assert.equal(stockValueOf({ available: 0, costed_qty: 0, costed_value: 0 }, null), 0);
});

test('stock value: costed qty above available is clamped, never negative', () => {
  assert.equal(stockValueOf({ available: 50, costed_qty: 80, costed_value: 500 }, 6), 500);
});

test('stock value: a missing row is worth zero, not a crash', () => {
  assert.equal(stockValueOf(undefined, 6), 0);
});

// ── client twin parity ────────────────────────────────────────────────
// The client recomputes these figures locally for live form previews, so the two
// implementations must never diverge. Same precedent as helpers.childFit /
// WarehousePicker.clientFit.
import * as client from '../../client/src/lib/boardMath.js';
import * as server from './board-math.js';

test('client twin: exported surface matches the server module', () => {
  assert.deepEqual(Object.keys(client).sort(), Object.keys(server).sort());
});

test('client twin: identical output across a spread of real boards', () => {
  const boards = [
    { gsm: 330, sheet_l: 24.6, sheet_w: 31.2, sheets_per_packet: 144 },
    { gsm: 290, sheet_l: 20, sheet_w: 38, sheets_per_packet: 100 },
    { gsm: 300, sheet_l: 23, sheet_w: 36, sheets_per_packet: 100 },
    { gsm: 230, sheet_l: 20, sheet_w: 37, sheets_per_packet: 144 },
    { gsm: 205, sheet_l: 22, sheet_w: 28, sheets_per_packet: 150 },
    { gsm: null, sheet_l: 20, sheet_w: 30, sheets_per_packet: 100 }, // incomplete master
    { gsm: 'abc', sheet_l: 20, sheet_w: 30, sheets_per_packet: 100 }, // junk input
    { gsm: NaN, sheet_l: 20, sheet_w: 30, sheets_per_packet: 100 },
  ];
  for (const b of boards) {
    assert.equal(client.kgPerSheet(b), server.kgPerSheet(b));
    assert.equal(client.packetWeight(b), server.packetWeight(b));
    assert.equal(client.ratePerSheet(b, 81), server.ratePerSheet(b, 81));
    assert.equal(client.packetRate(b, 81), server.packetRate(b, 81));
    assert.equal(client.totalWeight(b, 1234), server.totalWeight(b, 1234));
    assert.equal(client.totalWeight(b, -1234), server.totalWeight(b, -1234));
    assert.equal(client.packets(b, 250), server.packets(b, 250));
  }
});

test('client twin: identical rate resolution, including the active variants', () => {
  for (const [g, v] of [['Saffire', 7], ['Saffire', 9], ['Paper', 7], ['FBB', null]]) {
    assert.deepEqual(client.resolveRatePerKg(RATES, g, v), server.resolveRatePerKg(RATES, g, v));
  }
  // The fail-closed `active` guard must be identical on both sides — a client
  // preview showing a price the server refuses to honour is the worst outcome.
  for (const active of [1, '1', 0, false, '0', null, undefined]) {
    const rows = [{ grade: 'Kappa', vendor_id: null, rate_per_kg: 50, active }];
    assert.deepEqual(client.resolveRatePerKg(rows, 'Kappa', null), server.resolveRatePerKg(rows, 'Kappa', null),
      `active: ${JSON.stringify(active)} must agree across twins`);
  }
});
