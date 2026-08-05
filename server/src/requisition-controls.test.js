import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRetireRequisitions, prControls } from '../../client/src/lib/requisitionControls.js';

// The client has no test runner of its own, so a pure client-side rule is tested
// from here — the same arrangement as opening-counter.test.js. These cases moved
// out of shortage-panel.test.js when the rule stopped being the panel's alone:
// pages/Procurement.jsx gates its PR row menu on canRetireRequisitions too, so a
// break here is a break on both screens.

// ── canRetireRequisitions ───────────────────────────────────────────────────
// Exactly the roles that pass procurement.js's `canBuy` (routes/procurement.js:63),
// which guards approve, reject, unapprove, close, convert, PUT and DELETE.

test('planner and admin are the roles that may retire a requisition', () => {
  assert.equal(canRetireRequisitions('planner'), true);
  // Not a role listed on canBuy — requireRole (auth.js:125) lets admin through
  // every gate, so leaving it out here would hide working actions from an admin.
  assert.equal(canRetireRequisitions('admin'), true);
});

test('production and qc may raise a requisition but never retire one', () => {
  // canRaisePr (procurement.js:69) is deliberately wider than canBuy: asking for
  // board is not committing spend. These two are the whole reason the gates differ.
  assert.equal(canRetireRequisitions('production'), false);
  assert.equal(canRetireRequisitions('qc'), false);
});

test('no role at all is a refusal, not a pass-through', () => {
  assert.equal(canRetireRequisitions(undefined), false);
  assert.equal(canRetireRequisitions(null), false);
  assert.equal(canRetireRequisitions(''), false);
  // Both call sites read `auth.user?.role`, which is undefined before the
  // session loads — that must read as "not yet allowed", never as "allow".
  assert.equal(canRetireRequisitions(), false);
});

test('an unknown role gets nothing rather than falling through', () => {
  assert.equal(canRetireRequisitions('viewer'), false);
  assert.equal(canRetireRequisitions('storekeeper'), false);
  // Casing is not normalised anywhere in the chain, and the server compares the
  // stored role exactly, so neither should this.
  assert.equal(canRetireRequisitions('Planner'), false);
});

// ── prControls ──────────────────────────────────────────────────────────────
// Two gates, both pre-existing. Role: raising is canRaisePr (planner, production,
// qc) but retiring is canBuy (planner) — procurement.js:66. State: DELETE refuses
// a PR on a PO, and close accepts only pending or approved.

test('a planner may undo and cancel a pending PR', () => {
  const c = prControls({ pr: { status: 'pending' }, role: 'planner' });
  assert.equal(c.undo, true);
  assert.equal(c.cancel, true);
  assert.equal(c.blockedReason, null);
});

test('admin passes every role gate, as requireRole does', () => {
  const c = prControls({ pr: { status: 'pending' }, role: 'admin' });
  assert.equal(c.undo, true);
  assert.equal(c.cancel, true);
});

test('production may raise a PR but never retire one', () => {
  const c = prControls({ pr: { status: 'pending' }, role: 'production' });
  assert.equal(c.undo, false);
  assert.equal(c.cancel, false);
});

test('qc may not retire a PR either', () => {
  const c = prControls({ pr: { status: 'pending' }, role: 'qc' });
  assert.equal(c.undo, false);
  assert.equal(c.cancel, false);
});

test('a missing role is unauthorized, not a wildcard', () => {
  const c = prControls({ pr: { status: 'pending' } });
  assert.equal(c.undo, false);
  assert.equal(c.cancel, false);
});

test('an approved PR can be cancelled but not undone — undo would unapprove silently', () => {
  const c = prControls({ pr: { status: 'approved' }, role: 'planner' });
  assert.equal(c.undo, false);
  assert.equal(c.cancel, true);
});

test('a converted PR offers neither, and says why', () => {
  const c = prControls({ pr: { status: 'converted', po_number: 'PO-0117', pr_number: 'PR-0412' }, role: 'planner' });
  assert.equal(c.undo, false);
  assert.equal(c.cancel, false);
  assert.match(c.blockedReason, /PO-0117/);
});

test('converted alone — with no po_number or purchase_order_id — still blocks', () => {
  const c = prControls({ pr: { status: 'converted' }, role: 'planner' });
  assert.equal(c.undo, false);
  assert.equal(c.cancel, false);
  assert.ok(c.blockedReason);
});

test('an onPo block without a pr_number falls back to a generic label', () => {
  const c = prControls({ pr: { status: 'converted', po_number: 'PO-0117' }, role: 'planner' });
  assert.match(c.blockedReason, /^This requisition is on PO-0117/);
});

test('a PR carrying a purchase_order_id is blocked even while its status lags', () => {
  const c = prControls({ pr: { status: 'approved', purchase_order_id: 9, pr_number: 'PR-0412' }, role: 'planner' });
  assert.equal(c.undo, false);
  assert.equal(c.cancel, false);
  assert.match(c.blockedReason, /purchase order/);
});

test('a rejected or closed PR is already retired — no controls, no alarm', () => {
  for (const status of ['rejected', 'closed']) {
    const c = prControls({ pr: { status }, role: 'planner' });
    assert.equal(c.undo, false, status);
    assert.equal(c.cancel, false, status);
    assert.equal(c.blockedReason, null, status);
  }
});

test('no PR means no controls rather than a crash', () => {
  const c = prControls({ pr: null, role: 'admin' });
  assert.equal(c.undo, false);
  assert.equal(c.cancel, false);
});

// prControls guards its single object argument with a default `= {}`. Without it,
// calling it with no argument at all throws inside the destructure instead of
// answering "nothing to show" the way an empty object would — the same defensive
// shape as opening-counter.test.js's 'junk and missing arguments never produce a
// junk counter' test. panelMode's half of this lives in shortage-panel.test.js.
test('calling prControls with no arguments at all does not throw', () => {
  const c = prControls();
  assert.equal(c.undo, false);
  assert.equal(c.cancel, false);
});
