// OD is a date-boundary calculation on a plant that runs east of Greenwich, so
// the zone is pinned — in UTC several of these pass for the wrong reason. Must
// run before the first Date is built.
process.env.TZ = 'Asia/Kolkata';

import test from 'node:test';
import assert from 'node:assert/strict';
import { odDays, odTone } from '../../client/src/lib/odDays.js';

// A fixed "now" so the expected numbers are arithmetic, not a moving target.
// 14:00 IST — comfortably inside the day, so this pair isolates the PO-date side.
const AFTERNOON = new Date(2026, 7, 11, 14, 0, 0).getTime();
// 03:00 IST — before 05:30, where toISOString() still reads YESTERDAY. "Today"
// must not slide back a day for the early shift.
const NIGHT_SHIFT = new Date(2026, 7, 11, 3, 0, 0).getTime();

test('counts whole calendar days since the PO was raised', t => {
  t.mock.timers.enable({ apis: ['Date'], now: AFTERNOON });
  assert.equal(odDays('2026-08-11'), 0, 'raised today');
  assert.equal(odDays('2026-08-10'), 1, 'yesterday');
  assert.equal(odDays('2026-07-12'), 30, 'a month back');
  assert.equal(odDays('2026-05-27'), 76);
});

test('the night shift counts the same days as the afternoon', t => {
  // The whole family this session has been chasing. "Today" is read from LOCAL
  // parts; read it with toISOString() and every OD on the board would drop by
  // one between midnight and 05:30, quietly under-reporting the wait on the
  // shift least able to check.
  t.mock.timers.enable({ apis: ['Date'], now: NIGHT_SHIFT });
  assert.equal(odDays('2026-08-11'), 0, 'a PO raised today is not one day old at 03:00');
  assert.equal(odDays('2026-08-10'), 1);
  assert.equal(odDays('2026-05-27'), 76, 'same answer as the afternoon');
});

test('a PO dated in the future has kept nobody waiting', t => {
  t.mock.timers.enable({ apis: ['Date'], now: AFTERNOON });
  assert.equal(odDays('2026-08-12'), 0, 'clamped at zero, never negative');
});

test('no PO date is no answer, not zero days', t => {
  // Zero would render "0d" and read as "raised today" — the opposite of "we do
  // not know". Every caller renders a dash for null.
  t.mock.timers.enable({ apis: ['Date'], now: AFTERNOON });
  for (const empty of [null, undefined, '']) assert.equal(odDays(empty), null, String(empty));
  assert.equal(odDays('not a date'), null, 'unparseable');
});

test('a full ISO instant is read as its own calendar day', t => {
  // Should the endpoint ever send a timestamp instead of a bare date, the day
  // must not shift under it.
  t.mock.timers.enable({ apis: ['Date'], now: AFTERNOON });
  assert.equal(odDays('2026-08-10T00:00:00.000Z'), 1);
});

test('the bands colour only what is genuinely late', () => {
  // Measured on the live book: amber past a month, red past two, everything
  // else plain — about 13% of rows. A band that paints the whole board says
  // nothing, which is why AgeChip's 30/60/90 was rejected here.
  assert.equal(odTone(null), null, 'unknown is not late');
  assert.equal(odTone(0), null);
  assert.equal(odTone(30), null, 'just inside a month');
  assert.equal(odTone(31), 'text-amber-600', 'first amber day');
  assert.equal(odTone(60), 'text-amber-600', 'last amber day');
  assert.equal(odTone(61), 'text-red-600', 'first red day');
  assert.equal(odTone(400), 'text-red-600');
});
