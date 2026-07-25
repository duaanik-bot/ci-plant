import test from 'node:test';
import assert from 'node:assert/strict';
import { plantDay, plantMonth, plantDateStr } from './plant-calendar.js';

// 2026-07-24 20:30 UTC is 2026-07-25 02:00 IST — the night shift. The old
// UTC-based `closed_at::date = current_date` counted this as the 24th.
const nightShift = new Date('2026-07-24T20:30:00Z');

test('night-shift work belongs to the plant day that has already started', () => {
  const { start, end } = plantDay(nightShift);
  // The IST day of the 25th runs 2026-07-24T18:30Z → 2026-07-25T18:30Z.
  assert.equal(start.toISOString(), '2026-07-24T18:30:00.000Z');
  assert.equal(end.toISOString(), '2026-07-25T18:30:00.000Z');
  assert.ok(nightShift >= start && nightShift < end);
});

test('day range is half-open — midnight IST belongs to the new day only', () => {
  const { end } = plantDay(nightShift);
  const nextDay = plantDay(end); // the instant the previous day ends
  assert.equal(nextDay.start.getTime(), end.getTime());
});

test('afternoon work lands in the same plant day', () => {
  const afternoon = new Date('2026-07-25T09:00:00Z'); // 14:30 IST
  const { start, end } = plantDay(afternoon);
  assert.ok(afternoon >= start && afternoon < end);
  assert.equal(start.toISOString(), '2026-07-24T18:30:00.000Z');
});

test('month range covers IST month boundaries, not UTC', () => {
  // 2026-06-30 20:00 UTC is 2026-07-01 01:30 IST — already July for the plant.
  const { start, end } = plantMonth(new Date('2026-06-30T20:00:00Z'));
  assert.equal(start.toISOString(), '2026-06-30T18:30:00.000Z');
  assert.equal(end.toISOString(), '2026-07-31T18:30:00.000Z');
});

test('month range rolls over the year correctly', () => {
  const { start, end } = plantMonth(new Date('2026-12-20T10:00:00Z'));
  assert.equal(start.toISOString(), '2026-11-30T18:30:00.000Z');
  assert.equal(end.toISOString(), '2026-12-31T18:30:00.000Z');
});

test('plantDateStr reports the plant date and shifts by whole days', () => {
  assert.equal(plantDateStr(nightShift), '2026-07-25');
  assert.equal(plantDateStr(nightShift, 3), '2026-07-28');
  // Month rollover
  assert.equal(plantDateStr(new Date('2026-07-30T20:00:00Z'), 3), '2026-08-03');
});
