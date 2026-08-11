// The client's dayOf and the dates stamped through it. Pinned to the plant's
// zone: in UTC every fixture below reads the same either way and the file would
// pass while proving nothing. Must run before the first Date is built.
process.env.TZ = 'Asia/Kolkata';

import test from 'node:test';
import assert from 'node:assert/strict';
import { dayOf } from '../../client/src/lib/dayOf.js';
import { today } from '../../client/src/pages/shade-cards/lifecycle.js';

// 03:00 IST — inside the 00:00–05:30 window where toISOString() reads YESTERDAY.
const NIGHT_SHIFT = new Date(2026, 7, 11, 3, 0, 0).getTime();

test('dayOf reads a Date by its LOCAL parts, not its UTC instant', () => {
  // Local midnight is the previous day in UTC east of Greenwich; that is the
  // whole family. toISOString() on this value gives '2026-08-10'.
  assert.equal(dayOf(new Date(2026, 7, 11, 0, 0, 0)), '2026-08-11', 'local midnight');
  assert.equal(dayOf(new Date(2026, 7, 11, 3, 0, 0)), '2026-08-11', 'night shift');
  assert.equal(dayOf(new Date(2026, 7, 11, 23, 59, 0)), '2026-08-11', 'late evening');
});

test('dayOf pads single-digit months and days', () => {
  assert.equal(dayOf(new Date(2026, 0, 5)), '2026-01-05');
});

test('dayOf passes a bare calendar day straight through', () => {
  // What an endpoint sends when it formats the column server-side (to_char).
  // There is no instant here to shift, so it must not be reinterpreted.
  assert.equal(dayOf('2026-08-11'), '2026-08-11');
});

test('dayOf reads an ISO instant back as its LOCAL day', () => {
  // IST midnight expressed in UTC. Slicing the first ten characters would call
  // this the 10th; it is the 11th on the wall clock the plant works to.
  assert.equal(dayOf('2026-08-10T18:30:00.000Z'), '2026-08-11');
});

test('dayOf treats empty and missing values as no day at all', () => {
  for (const empty of [null, undefined, '', 0]) assert.equal(dayOf(empty), null, String(empty));
});

test('night shift: a shade card is created with TODAY as its creation date', t => {
  // today() is the default for creation_date on a new card, and creation_date is
  // the ONLY field ageDays() measures from (server/src/shade-flow.js) against a
  // 365-day life. Stamped a day early, the card is born a day old and expires a
  // day early — a wrong stored fact, not a display quirk.
  t.mock.timers.enable({ apis: ['Date'], now: NIGHT_SHIFT });
  assert.equal(today(), '2026-08-11');
});
