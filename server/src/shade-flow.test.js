import test from 'node:test';
import assert from 'node:assert/strict';
import {
  transitionBlocker, approvalClass, effectiveRequirement, productionEligibility,
  dockIssueBlocker, dockReturnBlocker, ageDays, isExpiredByAge, SHADE_CARD_LIFE_DAYS,
} from './shade-flow.js';

const mk = (over = {}) => ({
  id: 1, sc_number: 'CI-SC-0001', title: 'Nicostar 5 shade card',
  status: 'draft', revision_no: 0, approval_requirement: 'customer',
  dock_zone: 'triage', customer_stamp: 0, customer_signature: 0,
  internal_qc_stamp: 0, creation_date: null, active: 1, ...over,
});

// ── Status workflow ──────────────────────────────────────────────────────────
test('transitions: the happy path draft → customer_approved is open', () => {
  assert.equal(transitionBlocker(mk(), 'internal_review'), null);
  assert.equal(transitionBlocker(mk({ status: 'internal_review' }), 'internal_approved'), null);
  assert.equal(transitionBlocker(mk({ status: 'internal_approved' }), 'sent_to_customer'), null);
  assert.equal(transitionBlocker(mk({ status: 'sent_to_customer' }), 'customer_reviewing'), null);
  assert.equal(transitionBlocker(mk({ status: 'customer_reviewing' }), 'customer_approved'), null);
});

test('transitions: skipping the internal gate is blocked', () => {
  assert.match(transitionBlocker(mk(), 'sent_to_customer'), /not a valid move/);
  assert.match(transitionBlocker(mk(), 'customer_approved'), /not a valid move/);
});

test('transitions: revision loop — requested → revised → back through review', () => {
  assert.equal(transitionBlocker(mk({ status: 'customer_approved' }), 'revision_requested'), null);
  assert.equal(transitionBlocker(mk({ status: 'revision_requested' }), 'revised'), null);
  assert.equal(transitionBlocker(mk({ status: 'revised' }), 'internal_review'), null);
  assert.equal(transitionBlocker(mk({ status: 'revised' }), 'sent_to_customer'), null);
});

test('transitions: anything may be archived; terminal states stay put', () => {
  assert.equal(transitionBlocker(mk(), 'archived'), null);
  assert.equal(transitionBlocker(mk({ status: 'customer_approved' }), 'archived'), null);
  assert.match(transitionBlocker(mk({ status: 'archived' }), 'internal_review'), /not a valid move/);
  assert.match(transitionBlocker(mk({ status: 'superseded' }), 'customer_approved'), /not a valid move/);
});

test('transitions: guards nulls, unknowns and no-ops', () => {
  assert.match(transitionBlocker(null, 'draft'), /not found/);
  assert.match(transitionBlocker(mk(), 'launched'), /Unknown status/);
  assert.match(transitionBlocker(mk(), 'draft'), /Already/);
});

// ── Approval classification ──────────────────────────────────────────────────
test('approvalClass: distinguishes the five approval shapes', () => {
  assert.equal(approvalClass(mk({ status: 'internal_approved' })), 'internal_only');
  assert.equal(approvalClass(mk({ status: 'customer_approved', approval_method: 'email' })),
    'customer_no_stamp_digital');
  assert.equal(approvalClass(mk({ status: 'customer_approved', approval_method: 'physical_signed_copy', customer_stamp: 1 })),
    'customer_stamped_physical');
  assert.equal(approvalClass(mk({ status: 'customer_approved', approval_method: 'digital_signature', customer_stamp: 1 })),
    'customer_stamped_digital');
  assert.equal(approvalClass(mk({ status: 'draft' })), 'none');
});

// ── Expiry ───────────────────────────────────────────────────────────────────
test('expiry: a card ages out 365 days after its creation date', () => {
  const now = Date.parse('2026-07-15');
  assert.equal(isExpiredByAge(mk({ creation_date: '2026-01-01' }), now), false);
  assert.equal(isExpiredByAge(mk({ creation_date: '2025-01-01' }), now), true);
  assert.equal(ageDays(mk(), now), null); // no creation date on record
  assert.equal(SHADE_CARD_LIFE_DAYS, 365);
});

// ── Production control ───────────────────────────────────────────────────────
test('effectiveRequirement: product overrides customer overrides card, default customer', () => {
  assert.equal(effectiveRequirement(mk(), {}, {}), 'customer');
  assert.equal(effectiveRequirement(mk({ approval_requirement: 'internal' }), {}, {}), 'internal');
  assert.equal(effectiveRequirement(mk(), {}, { shade_approval_requirement: 'internal' }), 'internal');
  assert.equal(effectiveRequirement(mk(), { shade_approval_requirement: 'customer' },
    { shade_approval_requirement: 'internal' }), 'customer');
  assert.equal(effectiveRequirement(null, null, null), 'customer');
});

test('eligibility: customer-approved and in date → production may start', () => {
  const v = productionEligibility(mk({ status: 'customer_approved', creation_date: '2026-06-01' }), 'customer');
  assert.equal(v.eligible, true);
});

test('eligibility: customer mandatory + not approved → hard block', () => {
  const v = productionEligibility(mk({ status: 'sent_to_customer' }), 'customer');
  assert.equal(v.eligible, false);
  assert.equal(v.hard, true);
  assert.match(v.reason, /Customer approval is mandatory/);
});

test('eligibility: internal sufficient → internal approval unlocks production', () => {
  assert.equal(productionEligibility(mk({ status: 'internal_approved' }), 'internal').eligible, true);
  assert.equal(productionEligibility(mk({ status: 'sent_to_customer' }), 'internal').eligible, true);
  const v = productionEligibility(mk({ status: 'draft' }), 'internal');
  assert.equal(v.eligible, false);
  assert.equal(v.hard, false); // soft alarm — ack to proceed
});

test('eligibility: rejected / revision-requested cards are always hard-blocked', () => {
  for (const status of ['rejected', 'revision_requested', 'superseded']) {
    const v = productionEligibility(mk({ status }), 'internal');
    assert.equal(v.eligible, false);
    assert.equal(v.hard, true);
  }
});

test('eligibility: an expired approval no longer clears production', () => {
  const now = Date.parse('2026-07-15');
  const v = productionEligibility(mk({ status: 'customer_approved', creation_date: '2024-01-01' }), 'customer', now);
  assert.equal(v.eligible, false);
  assert.match(v.reason, /expired/);
});

test('eligibility: no card registered → nothing to enforce', () => {
  assert.equal(productionEligibility(null, 'customer').eligible, true);
});

// ── Dock loop ────────────────────────────────────────────────────────────────
test('dock: issue allowed from triage or vault, never twice, never rejected cards', () => {
  assert.equal(dockIssueBlocker(mk()), null);
  assert.equal(dockIssueBlocker(mk({ dock_zone: 'vault' })), null);
  assert.match(dockIssueBlocker(mk({ dock_zone: 'on_press' })), /Already on press/);
  assert.match(dockIssueBlocker(mk({ status: 'rejected' })), /cannot go to press/);
  assert.match(dockIssueBlocker(mk({ active: 0 })), /deleted/);
  assert.match(dockIssueBlocker(null), /not found/);
});

test('dock: only an on-press card returns to the vault', () => {
  assert.equal(dockReturnBlocker(mk({ dock_zone: 'on_press' })), null);
  assert.match(dockReturnBlocker(mk()), /on-press/);
  assert.match(dockReturnBlocker(null), /not found/);
});
