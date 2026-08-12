import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTypeError, SET_TYPES } from './set-type.js';

// `gang` here is the run id; run_kind defaults to a real gang so every
// pre-existing two-arg call keeps meaning exactly what it meant. A COMBINED
// run reuses the same column, which is why the kind has to travel with it.
const pending = (id, gang = null, run_kind = gang ? 'gang' : null) => ({ id, status: 'pending', gang_run_id: gang, run_kind });
const merged = (id, gang = 7) => ({ id, status: 'pending', gang_run_id: gang, run_kind: 'merge' });

// ── value + reason ────────────────────────────────────────────────────
test('set-type: only the three tags exist', () => {
  for (const t of SET_TYPES)
    assert.equal(setTypeError({ line: pending(1), members: [pending(1)], set_type: t, reason: 'r' }), null);
  for (const bad of ['mix', '', 'HOLD', 'newoutput', null, undefined])
    assert.match(setTypeError({ line: pending(1), members: [pending(1)], set_type: bad, reason: 'r' }) || '', /must be one of/);
});
test('set-type: hold demands a reason — blank and whitespace both refuse', () => {
  for (const reason of ['', '   ', null, undefined])
    assert.match(setTypeError({ line: pending(1), members: [pending(1)], set_type: 'hold', reason }), /why this job is on hold/);
  assert.equal(setTypeError({ line: pending(1), members: [pending(1)], set_type: 'hold', reason: 'waiting artwork' }), null);
});
test('set-type: single and gang never demand a reason', () => {
  assert.equal(setTypeError({ line: pending(1), members: [pending(1)], set_type: 'single', reason: '' }), null);
  assert.equal(setTypeError({ line: pending(1), members: [pending(1)], set_type: 'gang', reason: '' }), null);
});

// ── the gang rule ─────────────────────────────────────────────────────
test('set-type: a ganged line can never be tagged single or new output — the sheet is shared', () => {
  const line = pending(1, 7);
  for (const solo of ['single', 'new_output'])
    assert.match(setTypeError({ line, members: [line, pending(2, 7)], set_type: solo, reason: '' }), /cannot print on its own/);
});
test('set-type: new output is a normal tag on a line that is NOT ganged', () => {
  assert.equal(setTypeError({ line: pending(1), members: [pending(1)], set_type: 'new_output', reason: '' }), null);
});
test('set-type: gang and hold are allowed ON a ganged line (they fan out)', () => {
  const line = pending(1, 7);
  const members = [line, pending(2, 7), pending(3, 7)];
  assert.equal(setTypeError({ line, members, set_type: 'gang', reason: '' }), null);
  assert.equal(setTypeError({ line, members, set_type: 'hold', reason: 'customer confirming qty' }), null);
});

// ── locked plans stay history ─────────────────────────────────────────
test('set-type: any non-pending line in the write refuses the whole retag', () => {
  for (const status of ['planned', 'ready', 'in_production']) {
    // the clicked line itself
    assert.match(setTypeError({ line: { id: 1, status, gang_run_id: null }, members: [{ id: 1, status, gang_run_id: null }], set_type: 'gang', reason: '' }), /locked plan/);
    // one member of a gang — half a gang must never retag alone
    const line = pending(1, 7);
    assert.match(setTypeError({ line, members: [line, { id: 2, status, gang_run_id: 7 }], set_type: 'hold', reason: 'r' }), /locked plan/);
  }
});

// ── the combined-run rule ─────────────────────────────────────────────
// A merge reuses gang_run_id by design, so "is there a run?" cannot decide
// what may be tagged — only "what KIND of run?" can. The refusals are
// symmetric because the reason is: a tag the run's own kind would mask is a
// lie, not a preference.
test('set-type: a combined run CAN be tagged single — it is one product on one plate', () => {
  const line = merged(1);
  assert.equal(setTypeError({ line, members: [line, merged(2)], set_type: 'single', reason: '' }), null);
});

test('set-type: a combined run CAN be tagged new output — combining does not make plates appear', () => {
  const line = merged(1);
  assert.equal(setTypeError({ line, members: [line, merged(2)], set_type: 'new_output', reason: '' }), null);
});

test('set-type: a combined run can NEVER be tagged gang — its own kind would mask it', () => {
  const line = merged(1);
  assert.match(setTypeError({ line, members: [line, merged(2)], set_type: 'gang', reason: '' }),
    /combined run/);
});

test('set-type: hold still lands on a combined run, and still demands its reason', () => {
  const line = merged(1);
  assert.equal(setTypeError({ line, members: [line, merged(2)], set_type: 'hold', reason: 'shade card pending' }), null);
  assert.match(setTypeError({ line, members: [line, merged(2)], set_type: 'hold', reason: '  ' }), /why this job is on hold/);
});

test('set-type: a locked plan still refuses on a combined run', () => {
  const line = merged(1);
  assert.match(setTypeError({
    line, members: [line, { id: 2, status: 'planned', gang_run_id: 7, run_kind: 'merge' }],
    set_type: 'single', reason: '',
  }), /locked plan/);
});
