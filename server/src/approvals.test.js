import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canApproveExtraSheets, canDecideManagement, mgtDecisionError, notificationRecipients,
} from './approvals.js';

// ── canApproveExtraSheets ─────────────────────────────────────────────
test('xs: the flag alone grants approval', () => {
  assert.equal(canApproveExtraSheets({ xs_approver: 1 }), true);
  assert.equal(canApproveExtraSheets({ xs_approver: '1' }), true);
});
test('xs: no flag means no approval — even for role admin', () => {
  // The whole point of the flag: several plant logins are role=admin and must
  // NOT inherit the plant head's decision.
  assert.equal(canApproveExtraSheets({ role: 'admin', xs_approver: 0 }), false);
  assert.equal(canApproveExtraSheets({ role: 'admin' }), false);
});
test('xs: missing user is never an approver', () => {
  assert.equal(canApproveExtraSheets(null), false);
  assert.equal(canApproveExtraSheets(undefined), false);
});

// ── canDecideManagement ───────────────────────────────────────────────
test('mgt: the flag alone grants the decision', () => {
  assert.equal(canDecideManagement({ is_management: 1 }), true);
  assert.equal(canDecideManagement({ is_management: 0 }), false);
  assert.equal(canDecideManagement({ role: 'admin' }), false);
  assert.equal(canDecideManagement(null), false);
});

// ── mgtDecisionError ──────────────────────────────────────────────────
test('mgt transitions: pending can be approved, rejected or withdrawn', () => {
  for (const action of ['approve', 'reject', 'cancel'])
    assert.equal(mgtDecisionError('pending', action), null);
});
test('mgt transitions: a decided request is final', () => {
  for (const status of ['approved', 'rejected', 'cancelled'])
    for (const action of ['approve', 'reject', 'cancel'])
      assert.match(mgtDecisionError(status, action), /Only a pending request/);
});
test('mgt transitions: unknown action is refused, not silently allowed', () => {
  assert.match(mgtDecisionError('pending', 'delete'), /Unknown action/);
});

// ── notificationRecipients ────────────────────────────────────────────
const USERS = [
  { id: 1, active: 1, xs_approver: 0, is_management: 1 },  // MD
  { id: 27, active: 1, xs_approver: 1, is_management: 1 }, // Plant (Dharminder)
  { id: 23, active: 1, xs_approver: 0, is_management: 0 }, // Planning
  { id: 30, active: 0, xs_approver: 1, is_management: 0 }, // deactivated approver
];
test('recipients: only active flag-holders are targeted', () => {
  assert.deepEqual(notificationRecipients(USERS, 'xs_approver'), [27]);
  assert.deepEqual(notificationRecipients(USERS, 'is_management'), [1, 27]);
});
test('recipients: the actor never rings their own bell', () => {
  assert.deepEqual(notificationRecipients(USERS, 'is_management', 1), [27]);
});
test('recipients: empty or missing input targets nobody', () => {
  assert.deepEqual(notificationRecipients([], 'xs_approver'), []);
  assert.deepEqual(notificationRecipients(null, 'xs_approver'), []);
});
