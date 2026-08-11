// The rule under test is a timezone rule, so the zone has to be pinned — in UTC
// the night-shift fixtures resolve identically either way and the file would
// pass while proving nothing. Must run before the first Date is built.
process.env.TZ = 'Asia/Kolkata';

import test from 'node:test';
import assert from 'node:assert/strict';
import { REQUEST_KPI, terminal } from '../../client/src/lib/toolingQueue.js';

// 03:00 IST — inside the 00:00–05:30 window where new Date().toISOString()
// still reads YESTERDAY, which is the whole defect.
const NIGHT_SHIFT = new Date(2026, 7, 11, 3, 0, 0).getTime();
// 14:00 IST the same day, after the ISO date has rolled over.
const AFTERNOON = new Date(2026, 7, 11, 14, 0, 0).getTime();

test('night shift: a requirement that ran late yesterday is still flagged', t => {
  // The bug. `attention` is not just a number — it is the filter behind the red
  // Attention card, so between midnight and 05:30 the count drops by however
  // many requirements came due yesterday AND the rows vanish from the queue a
  // buyer clicked that card to see. They reappear at 05:30 with no cause.
  t.mock.timers.enable({ apis: ['Date'], now: NIGHT_SHIFT });
  const overdue = { status: 'pending', needed_by: '2026-08-10' };
  assert.equal(REQUEST_KPI.attention(overdue), true);
});

test('a requirement due today is not overdue, on either shift', t => {
  // Guards the opposite ditch: the fix must move the boundary to local
  // midnight, not shift everything a day earlier and call today late.
  t.mock.timers.enable({ apis: ['Date'], now: NIGHT_SHIFT });
  const dueToday = { status: 'pending', needed_by: '2026-08-11' };
  assert.equal(REQUEST_KPI.attention(dueToday), false, 'night shift');

  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ['Date'], now: AFTERNOON });
  assert.equal(REQUEST_KPI.attention(dueToday), false, 'afternoon');
});

test('the afternoon answer is unchanged — this only ever moved the boundary', t => {
  t.mock.timers.enable({ apis: ['Date'], now: AFTERNOON });
  assert.equal(REQUEST_KPI.attention({ status: 'pending', needed_by: '2026-08-10' }), true);
});

test('lost or damaged is attention whatever the date says', t => {
  t.mock.timers.enable({ apis: ['Date'], now: NIGHT_SHIFT });
  assert.equal(REQUEST_KPI.attention({ status: 'lost_damaged' }), true, 'no needed_by at all');
  assert.equal(REQUEST_KPI.attention({ status: 'lost_damaged', needed_by: '2099-01-01' }), true, 'due far ahead');
});

test('a finished requirement is never overdue, however long it sat', t => {
  t.mock.timers.enable({ apis: ['Date'], now: NIGHT_SHIFT });
  for (const status of ['ready', 'issued_to_floor', 'returned_to_rack', 'cancelled', 'replaced']) {
    assert.equal(terminal(status), true, `${status} is terminal`);
    assert.equal(REQUEST_KPI.attention({ status, needed_by: '2026-01-01' }), false, status);
  }
});

test('a requirement with no needed_by is never overdue', t => {
  // Falsy, not `false`: the && chain short-circuits on needed_by and hands back
  // undefined or ''. Every caller either filters on it or negates it, so that is
  // the real contract — asserting a strict false here would be pinning an
  // implementation detail and would force a change nothing needs.
  t.mock.timers.enable({ apis: ['Date'], now: NIGHT_SHIFT });
  assert.ok(!REQUEST_KPI.attention({ status: 'pending' }), 'undefined');
  assert.ok(!REQUEST_KPI.attention({ status: 'pending', needed_by: '' }), 'blank');
});
