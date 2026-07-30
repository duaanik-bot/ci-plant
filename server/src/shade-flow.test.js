import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SHADE_STATUSES, TRANSITIONS, transitionBlocker, labelFor,
  ageDays, isExpiredByAge, SHADE_CARD_LIFE_DAYS,
  printingEligibility, codeMatch,
  issueBlocker, returnBlocker, holderOf,
} from './shade-flow.js';

const mk = (over = {}) => ({
  id: 1, sc_number: 'CI-SC-0001', title: 'Nicostar 5 shade card',
  status: 'draft', artwork_no: null, output_no: null,
  creation_date: null, active: 1, ...over,
});
const openIssue = (over = {}) => ({
  id: 7, shade_card_id: 1, issued_to: 'Dharminder', department: 'printing',
  issued_at: '2026-07-01T04:00:00Z', returned_at: null, ...over,
});

// ── Status workflow ──────────────────────────────────────────────────────────
test('statuses: exactly four, no expiry and no internal approval among them', () => {
  assert.deepEqual(SHADE_STATUSES, ['draft', 'sent', 'approved', 'rejected']);
});

test('transitions: the happy path is create → dispatch → approve', () => {
  assert.equal(transitionBlocker(mk(), 'sent'), null);
  assert.equal(transitionBlocker(mk({ status: 'sent' }), 'approved'), null);
});

test('transitions: the customer may reject, and a corrected card goes out again', () => {
  assert.equal(transitionBlocker(mk({ status: 'sent' }), 'rejected'), null);
  assert.equal(transitionBlocker(mk({ status: 'rejected' }), 'sent'), null);
});

test('transitions: an approved card can be re-sent — this is the renewal path', () => {
  assert.equal(transitionBlocker(mk({ status: 'approved' }), 'sent'), null);
});

test('transitions: approval cannot be recorded without dispatching first', () => {
  assert.match(transitionBlocker(mk(), 'approved'), /not a valid move/);
  assert.match(transitionBlocker(mk(), 'rejected'), /not a valid move/);
  assert.match(transitionBlocker(mk({ status: 'approved' }), 'rejected'), /not a valid move/);
});

test('transitions: guards nulls, unknowns and no-ops', () => {
  assert.match(transitionBlocker(null, 'draft'), /not found/);
  assert.match(transitionBlocker(mk(), 'internal_review'), /Unknown status/);
  assert.match(transitionBlocker(mk(), 'archived'), /Unknown status/);
  assert.match(transitionBlocker(mk(), 'draft'), /Already/);
});

test('transitions: every target named in TRANSITIONS is a real status', () => {
  for (const [from, tos] of Object.entries(TRANSITIONS)) {
    assert.ok(SHADE_STATUSES.includes(from), `${from} is not a status`);
    for (const to of tos) assert.ok(SHADE_STATUSES.includes(to), `${from} → ${to} targets a non-status`);
  }
});

test('labelFor: reads as plant English', () => {
  assert.equal(labelFor('sent'), 'Sent to Customer');
  assert.equal(labelFor('approved'), 'Approved');
  assert.equal(labelFor(null), '—');
});

// ── Expiry (derived, never a status) ─────────────────────────────────────────
test('expiry: a card ages out on its 365th day, not before', () => {
  const now = Date.parse('2027-01-01T00:00:00Z');
  assert.equal(SHADE_CARD_LIFE_DAYS, 365);
  assert.equal(ageDays(mk({ creation_date: '2026-01-02' }), now), 364);
  assert.equal(isExpiredByAge(mk({ creation_date: '2026-01-02' }), now), false);
  assert.equal(ageDays(mk({ creation_date: '2026-01-01' }), now), 365);
  assert.equal(isExpiredByAge(mk({ creation_date: '2026-01-01' }), now), true);
  assert.equal(isExpiredByAge(mk({ creation_date: '2025-12-31' }), now), true);
});

test('expiry: no creation date on record means no age and no expiry claim', () => {
  assert.equal(ageDays(mk()), null);
  assert.equal(isExpiredByAge(mk()), false);
});

// ── Printing gate ────────────────────────────────────────────────────────────
test('printing: an approved, in-date card clears', () => {
  const v = printingEligibility(mk({ status: 'approved', creation_date: '2026-06-01' }),
    Date.parse('2026-07-15'));
  assert.equal(v.eligible, true);
  assert.equal(v.reason, null);
});

test('printing: anything short of customer approval is blocked — one rule', () => {
  for (const status of ['draft', 'sent', 'rejected']) {
    const v = printingEligibility(mk({ status }));
    assert.equal(v.eligible, false, `${status} should block`);
    assert.match(v.reason, /CI-SC-0001/);
  }
});

test('printing: an expired approval no longer clears', () => {
  const v = printingEligibility(mk({ status: 'approved', creation_date: '2024-01-01' }),
    Date.parse('2026-07-15'));
  assert.equal(v.eligible, false);
  assert.match(v.reason, /past its 365-day life/);
});

test('printing: no card registered → nothing to enforce', () => {
  assert.equal(printingEligibility(null).eligible, true);
});

// ── AW / Output code match ───────────────────────────────────────────────────
test('codeMatch: equal codes pass, and comparison ignores case and padding', () => {
  assert.equal(codeMatch(mk({ artwork_no: 'AW-42', output_no: 'OP-7' }),
    { party_artwork_code: ' aw-42 ', output_number: 'OP-7' }).ok, true);
});

test('codeMatch: a differing code is reported per field', () => {
  const v = codeMatch(mk({ artwork_no: 'AW-42', output_no: 'OP-7' }),
    { party_artwork_code: 'AW-99', output_number: 'OP-7' });
  assert.equal(v.ok, false);
  assert.equal(v.mismatches.length, 1);
  assert.equal(v.mismatches[0].field, 'Artwork code');
  assert.equal(v.mismatches[0].card, 'AW-42');
  assert.equal(v.mismatches[0].order, 'AW-99');
});

test('codeMatch: a blank on either side passes — this is what keeps the plant running', () => {
  // Only 5 of 1594 products carry an output code. Blocking on absence would
  // refuse virtually every job, so absence is silence, not a mismatch.
  assert.equal(codeMatch(mk({ artwork_no: 'AW-42' }), { party_artwork_code: 'AW-42' }).ok, true);
  assert.equal(codeMatch(mk({ output_no: null }), { output_number: 'OP-7' }).ok, true);
  assert.equal(codeMatch(mk({ output_no: 'OP-7' }), { output_number: '' }).ok, true);
  assert.equal(codeMatch(mk(), {}).ok, true);
  assert.equal(codeMatch(null, null).ok, true);
});

test('codeMatch: both fields differing reports both', () => {
  const v = codeMatch(mk({ artwork_no: 'AW-42', output_no: 'OP-7' }),
    { party_artwork_code: 'AW-99', output_number: 'OP-9' });
  assert.equal(v.mismatches.length, 2);
});

// ── Custody loop ─────────────────────────────────────────────────────────────
test('issue: only an approved card may go out', () => {
  assert.equal(issueBlocker(mk({ status: 'approved' }), null), null);
  for (const status of ['draft', 'sent', 'rejected']) {
    assert.match(issueBlocker(mk({ status }), null), /Only an approved shade card/);
  }
});

test('issue: a card already out names who has it', () => {
  const blk = issueBlocker(mk({ status: 'approved' }), openIssue());
  assert.match(blk, /Dharminder/);
  assert.match(blk, /printing/);
});

test('issue: guards deleted cards and nulls', () => {
  assert.match(issueBlocker(mk({ status: 'approved', active: 0 }), null), /deleted/);
  assert.match(issueBlocker(null, null), /not found/);
});

test('return: only an issued card can come back', () => {
  assert.equal(returnBlocker(openIssue()), null);
  assert.match(returnBlocker(null), /not issued to anyone/);
});

test('holderOf: the open issue row IS the current holder', () => {
  assert.deepEqual(holderOf(openIssue()),
    { issued_to: 'Dharminder', department: 'printing', since: '2026-07-01T04:00:00Z' });
  assert.equal(holderOf(null), null);
});
