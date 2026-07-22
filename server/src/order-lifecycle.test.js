import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderTransitionError, rollbackBlockers, forceDeleteBlockers } from './helpers.js';

// ── orderTransitionError ──────────────────────────────────────────────
test('order: pending → hold is allowed', () => {
  assert.equal(orderTransitionError('pending', 'hold', false), null);
});
test('order: pending → completed/closed/cancelled allowed', () => {
  for (const to of ['completed', 'closed', 'cancelled'])
    assert.equal(orderTransitionError('pending', to, false), null);
});
test('order: hold → pending allowed (resume)', () => {
  assert.equal(orderTransitionError('hold', 'pending', false), null);
});
test('order: closed → pending blocked for non-admin', () => {
  assert.match(orderTransitionError('closed', 'pending', false), /admin/i);
});
test('order: closed → pending allowed for admin (reopen)', () => {
  assert.equal(orderTransitionError('closed', 'pending', true), null);
});
test('order: cancelled → completed is never allowed', () => {
  assert.match(orderTransitionError('cancelled', 'completed', true), /cannot/i);
});
test('order: same-status is a no-op error', () => {
  assert.match(orderTransitionError('pending', 'pending', false), /already/i);
});

// ── rollbackBlockers ──────────────────────────────────────────────────
test('rollback: clean line has no blockers', () => {
  assert.deepEqual(rollbackBlockers({}), []);
});
test('rollback: a started stage blocks', () => {
  const out = rollbackBlockers({ stages: [{ stage: 'printing', status: 'in_progress' }] });
  assert.equal(out.length, 1);
  assert.match(out[0], /Printing stage is in progress/);
});
test('rollback: pending stages do NOT block', () => {
  assert.deepEqual(rollbackBlockers({ stages: [{ stage: 'cutting', status: 'pending' }] }), []);
});
test('rollback: a converted PR blocks', () => {
  assert.match(rollbackBlockers({ prLinkedToPo: true })[0], /requisition/i);
});
test('rollback: produced FG blocks', () => {
  assert.match(rollbackBlockers({ fgProduced: true })[0], /Finished goods/i);
});
test('rollback: dispatched qty blocks with the number', () => {
  assert.match(rollbackBlockers({ dispatchedQty: 12000 })[0], /12000 pcs already dispatched/);
});
test('rollback: multiple blockers are all reported', () => {
  const out = rollbackBlockers({
    stages: [{ stage: 'foiling', status: 'hold' }], fgProduced: true, dispatchedQty: 5,
  });
  assert.equal(out.length, 3);
});

// ── forceDeleteBlockers ───────────────────────────────────────────────
test('force delete: started stages / produced FG / ordered PRs do NOT block', () => {
  assert.deepEqual(forceDeleteBlockers({}), []);
});
test('force delete: dispatched qty still blocks', () => {
  assert.match(forceDeleteBlockers({ dispatchedQty: 300 })[0], /300 pcs already dispatched/);
});
test('force delete: FG reserved by another order blocks', () => {
  assert.match(forceDeleteBlockers({ fgReservedElsewhere: true })[0], /another order/i);
});
test('force delete: gang shared outside the delete scope blocks', () => {
  assert.match(forceDeleteBlockers({ gangOutsideScope: true })[0], /ganged/i);
});
