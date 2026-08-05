import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTypeError, SET_TYPES } from './set-type.js';

const pending = (id, gang = null) => ({ id, status: 'pending', gang_run_id: gang });

// ── value + reason ────────────────────────────────────────────────────
test('set-type: only the three tags exist', () => {
  for (const t of SET_TYPES)
    assert.equal(setTypeError({ line: pending(1), members: [pending(1)], set_type: t, reason: 'r' }), null);
  for (const bad of ['mix', '', 'HOLD', null, undefined])
    assert.match(setTypeError({ line: pending(1), members: [pending(1)], set_type: bad, reason: 'r' }) || '', /single, gang or hold/);
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
test('set-type: a ganged line can never be tagged single — the sheet is shared', () => {
  const line = pending(1, 7);
  assert.match(setTypeError({ line, members: [line, pending(2, 7)], set_type: 'single', reason: '' }), /cannot print alone/);
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
