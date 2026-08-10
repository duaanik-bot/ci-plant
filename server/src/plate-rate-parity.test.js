import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlateRate as serverRate } from './plates.js';
import { resolvePlateRate as clientRate } from '../../client/src/lib/plateRates.js';

// The client cannot import server code, so client/src/lib/plateRates.js is a
// deliberate TWIN. A twin is only safe while something checks it still agrees —
// otherwise the two quietly price the same plate differently, and the one the
// buyer SEES is not the one the PO is written with.
//
// The fixtures matter as much as the assertions here. All three of these were
// chosen because the obvious fixture passes on broken code:
//
//   - a DATE, not a string. The original rate test used '2026-01-01' and stayed
//     green while production, which gets a JS Date, could not price a single PO.
//   - the row as it crosses the WIRE. JSON.stringify turns a Date into an ISO
//     instant, and IST midnight is the previous day in UTC — the client sees
//     "2026-08-07T18:30:00.000Z" for the 8th.
//   - a lookup ON the boundary day, in the night-shift window. Away from the
//     boundary both sides agree even when both are wrong, so a fixture a week
//     either side proves nothing.

const wire = rows => JSON.parse(JSON.stringify(rows));
const rateOf = hit => (hit ? String(hit.rate_per_plate) : null);

test('server and client price a plate identically, from the same row', () => {
  const rows = [
    { id: 1, plate_master_id: 2, vendor_id: null, rate_per_plate: '200.00', effective_from: new Date(2026, 7, 8), active: 1 },
    { id: 2, plate_master_id: 2, vendor_id: 23, rate_per_plate: '225.00', effective_from: new Date(2026, 6, 1), active: 1 },
  ];
  for (const at of [new Date(2026, 7, 11, 14, 0), new Date(2026, 7, 11, 1, 55)]) {
    assert.equal(rateOf(clientRate(wire(rows), 2, 23, at)), rateOf(serverRate(rows, 2, 23, at)), `vendor rate at ${at}`);
    assert.equal(rateOf(clientRate(wire(rows), 2, 99, at)), rateOf(serverRate(rows, 2, 99, at)), `base rate at ${at}`);
  }
});

test('a rate effective TODAY applies on the night shift, on both sides', () => {
  // 01:55 IST on the 8th, for a rate effective the 8th. toISOString() would call
  // that the 7th and report no rate at all — a blank rate and a Rs 0 total in
  // front of a buyer about to click Create PO.
  const rows = [{ id: 1, plate_master_id: 2, vendor_id: null, rate_per_plate: '200.00', effective_from: new Date(2026, 7, 8), active: 1 }];
  const nightShift = new Date(2026, 7, 8, 1, 55);
  assert.equal(rateOf(serverRate(rows, 2, 23, nightShift)), '200.00', 'server');
  assert.equal(rateOf(clientRate(wire(rows), 2, 23, nightShift)), '200.00', 'client');
});

test('neither side lets a rate apply the day before it starts', () => {
  const rows = [{ id: 1, plate_master_id: 2, vendor_id: null, rate_per_plate: '200.00', effective_from: new Date(2026, 7, 8), active: 1 }];
  const dayBefore = new Date(2026, 7, 7, 23, 30);
  assert.equal(serverRate(rows, 2, 23, dayBefore), null, 'server');
  assert.equal(clientRate(wire(rows), 2, 23, dayBefore), null, 'client');
});

test('the twin does not lean on the server twin being wrong', () => {
  // The two used to cancel: effective_from arrived a day early over the wire, and
  // the client read "today" a day early too. Feeding the client a PLAIN calendar
  // day removes one half — if it still leaned on the other, this would disagree.
  const plain = [{ id: 1, plate_master_id: 2, vendor_id: null, rate_per_plate: '200.00', effective_from: '2026-08-08', active: 1 }];
  const rows = [{ id: 1, plate_master_id: 2, vendor_id: null, rate_per_plate: '200.00', effective_from: new Date(2026, 7, 8), active: 1 }];
  const at = new Date(2026, 7, 8, 1, 55);
  assert.equal(rateOf(clientRate(plain, 2, 23, at)), '200.00', 'a plain YYYY-MM-DD must resolve too');
  assert.equal(rateOf(clientRate(plain, 2, 23, at)), rateOf(serverRate(rows, 2, 23, at)));
});
