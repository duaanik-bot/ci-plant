// Packets under the queue's sheet figures. The plant BUYS, STORES and HANDS OVER
// board in packets while the ledger transacts in sheets, so a station naming a
// sheet count carries its packet equivalent — the same pair, and the same
// arithmetic, the RM stock screens already show.
//
// ONE spelling: packetsOf/packetText live in lib/packets.js and are read by both
// Inventory and the station queue. A second copy is how 2.5 packets becomes 3 on
// one screen and 2.5 on the next.
//
// They are NOT in boardMath.js — that module is a verbatim twin of
// server/src/board-math.js with a parity test on its exported surface, and a
// server maths module has no business formatting an en-IN string.
import test from 'node:test';
import assert from 'node:assert/strict';
import { packetsOf, packetText } from '../../client/src/lib/packets.js';

const P100 = { sheets_per_packet: 100 };
const P250 = { sheets_per_packet: 250 };

test('a whole number of packets reads as a whole number', () => {
  assert.equal(packetText(packetsOf(P100, 400)), '4');
  assert.equal(packetText(packetsOf(P250, 5250)), '21');
});

test('PACKETS STAY FRACTIONAL — 250 sheets of a 100-sheet pack is 2.5, never 3', () => {
  // Rounding up invents stock that is not on the shelf; rounding down hides
  // sheets the floor may draw. Neither is a number anyone can act on.
  assert.equal(packetText(packetsOf(P100, 250)), '2.5');
  assert.equal(packetText(packetsOf(P100, 8959)), '89.59');
  assert.equal(packetText(packetsOf(P100, 567)), '5.67');
});

test('the fraction stops at two places — a packet count is read, not audited', () => {
  assert.equal(packetText(packetsOf(P250, 1)), '0');       // 0.004 → 0
  assert.equal(packetText(packetsOf(P250, 1000)), '4');
  assert.equal(packetText(packetsOf(P100, 12345)), '123.45');
});

test('a board with no packet size yields null, so the caller can print nothing', () => {
  // Leftover and one-off masters legitimately carry no sheets_per_packet. A
  // zero packet line under a real sheet count would read as "no board".
  assert.equal(packetsOf({}, 400), null);
  assert.equal(packetsOf({ sheets_per_packet: 0 }, 400), null);
  assert.equal(packetsOf({ sheets_per_packet: null }, 400), null);
  assert.equal(packetText(null), '—');
});

test('zero sheets is zero packets, not an em dash', () => {
  // A queued job that has drawn nothing has a REAL zero — different from a
  // board whose packet size nobody has recorded.
  assert.equal(packetsOf(P100, 0), 0);
  assert.equal(packetText(packetsOf(P100, 0)), '0');
});

test('an absent sheet count never yields NaN pkt', () => {
  // `null` coerces to 0 and lands in the real-zero arm — the shipped Inventory
  // behaviour, kept deliberately. So "unknown" is the CALLER's job to spot:
  // the queue tests `value == null` before it renders a packet line at all,
  // rather than letting a missing figure print as "0 pkt".
  assert.equal(packetsOf(P100, null), 0);
  assert.equal(packetsOf(P100, undefined), null);
  assert.equal(packetsOf(P100, 'abc'), null);
});

test('large counts group in the Indian system, matching every other figure on the row', () => {
  assert.equal(packetText(packetsOf(P100, 1234500)), '12,345');
});
