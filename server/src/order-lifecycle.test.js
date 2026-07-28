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

// ── seed / constraint parity ──────────────────────────────────────────
// db.js creates `orders` with the LEGACY check (…'open'…) and then immediately
// ALTERs it to the real lifecycle set. A seeder writing 'open' therefore passes
// the CREATE TABLE definition and fails the live constraint — which aborted
// seedIfEmpty() on every FRESH database while leaving existing plants working,
// so nothing caught it. Read both files and assert they still agree.
test('seed: every order status it writes is allowed by the live constraint', async () => {
  const { readFile } = await import('node:fs/promises');
  const dir = new URL('.', import.meta.url);
  const db = await readFile(new URL('db.js', dir), 'utf8');
  const seed = await readFile(new URL('seed.js', dir), 'utf8');

  const allowed = db.match(/ADD CONSTRAINT orders_status_check\s*\n?\s*CHECK \(status IN \(([^)]*)\)\)/);
  assert.ok(allowed, 'orders_status_check must still be defined in db.js');
  const valid = new Set([...allowed[1].matchAll(/'([a-z_]+)'/g)].map(m => m[1]));
  assert.ok(valid.has('pending'), 'lifecycle set must contain pending');

  // The seeder's order rows: ord(po, customer, po_date, delivery_date, STATUS, off).
  // Anchored on the call's TAIL — the earlier arguments carry their own
  // parentheses (d(-2), d(12)), so a [^)] scan stops at the first one.
  const written = [...seed.matchAll(/await ord\(.*?,\s*'([a-z_]+)',\s*\d+\);/g)].map(m => m[1]);
  assert.ok(written.length >= 5, `expected several seeded orders, found ${written.length}`);
  for (const s of written)
    assert.ok(valid.has(s), `seed.js writes orders.status='${s}', not in ${[...valid].join('/')}`);
});
