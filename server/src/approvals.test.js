import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canApproveExtraSheets, canDecideManagement, mgtDecisionError, notificationRecipients, plateReplacementRecipients,
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
// ── plateReplacementRecipients ────────────────────────────────────────
// The CTP login is not a role: it is a `production` account with every section,
// which is exactly why the printing filter has to accept sections == null.
const PLANT = [
  { id: 1, active: 1, is_management: 1, role: 'admin' },                              // MD
  { id: 4, active: 1, is_management: 0, role: 'production', sections: null },          // CTP
  { id: 23, active: 1, is_management: 0, role: 'planner' },                            // Planning
  { id: 31, active: 1, is_management: 0, role: 'production', sections: ['printing'] }, // Press
  { id: 32, active: 1, is_management: 0, role: 'production', sections: ['cutting'] },  // Cutting only
  { id: 33, active: 1, is_management: 0, role: 'dispatch' },                           // Dispatch
  { id: 34, active: 0, is_management: 1, role: 'planner' },                            // deactivated
];
test('plate replacement reaches management, planning, the press and CTP', () => {
  assert.deepEqual(plateReplacementRecipients(PLANT), [1, 4, 23, 31]);
});
test('plate replacement skips other stations, dispatch and deactivated logins', () => {
  const targeted = plateReplacementRecipients(PLANT);
  for (const id of [32, 33, 34]) assert.ok(!targeted.includes(id), `${id} should not be notified`);
});
test('plate replacement never rings the raiser own bell', () => {
  assert.deepEqual(plateReplacementRecipients(PLANT, 31), [1, 4, 23]);
});

test('recipients: empty or missing input targets nobody', () => {
  assert.deepEqual(notificationRecipients([], 'xs_approver'), []);
  assert.deepEqual(notificationRecipients(null, 'xs_approver'), []);
});
