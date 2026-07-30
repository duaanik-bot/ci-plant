// Pure rules for the Shade Card lifecycle. DB-free so it unit-tests like
// tooling-gate.js — routes import these and throw on a non-null blocker.
//
// ONE approval lifecycle and ONE repeating custody loop:
//   status    draft → sent → approved, with rejected as the customer's no.
//             approved → sent is the RENEWAL edge: a card past its 365-day life
//             must be re-approvable, so recording a fresh approval resets
//             creation_date and restarts the age clock.
//   custody   lives in shade_card_issues, NOT on the card. A card out on press
//             is still 'approved'; the open issue row IS the current holder.
//             This is why a card can be issued and returned many times over its
//             life without its approval state ever moving.
//
// Expiry is DERIVED from creation_date and is never a status. It used to be
// both, which meant one fact with two sources that could disagree.

export const SHADE_STATUSES = ['draft', 'sent', 'approved', 'rejected'];

export const STATUS_LABEL = {
  draft: 'Draft',
  sent: 'Sent to Customer',
  approved: 'Approved',
  rejected: 'Rejected',
};

// Allowed moves. Deletion is a soft active=0 on any status and is not modelled
// here — it is reversible and says nothing about the approval state.
export const TRANSITIONS = {
  draft:    ['sent'],
  sent:     ['approved', 'rejected'],
  approved: ['sent'],       // renewal after expiry, or a re-confirmation
  rejected: ['sent'],       // corrected and sent out again
};

export function labelFor(status) {
  return STATUS_LABEL[status] || (status ? String(status) : '—');
}

// Returns a human blocker string, or null when the move is allowed.
export function transitionBlocker(card, to) {
  if (!card) return 'Shade card not found';
  if (!SHADE_STATUSES.includes(to)) return `Unknown status "${to}"`;
  if (card.status === to) return `Already ${labelFor(to)}`;
  if (!(TRANSITIONS[card.status] || []).includes(to))
    return `${labelFor(card.status)} → ${labelFor(to)} is not a valid move`;
  return null;
}

// ── Expiry ───────────────────────────────────────────────────────────────────
// Colour standards fade and drift: a card is obsolete 365 days after the date
// it was made. Planning, printing and invoicing all warn from this one rule.
export const SHADE_CARD_LIFE_DAYS = 365;

export function ageDays(card, now = Date.now()) {
  const created = Date.parse(card?.creation_date || '');
  if (!Number.isFinite(created)) return null;
  return Math.floor((now - created) / 86400000);
}

export function isExpiredByAge(card, now = Date.now()) {
  const age = ageDays(card, now);
  return age != null && age >= SHADE_CARD_LIFE_DAYS;
}

// ── Printing gate ────────────────────────────────────────────────────────────
// One rule: the customer has approved, and the approval is still in date.
// There is no per-customer or per-product configuration and no acknowledge
// path — every block here is hard. A product with NO card registered is not
// gated at all, which is the behaviour the plant has always had.
export function printingEligibility(card, now = Date.now()) {
  if (!card) return { eligible: true, reason: null };
  // `=== 0`, not `!card.active`: several callers select only the columns they
  // need and omit `active`, and a falsy check would read `undefined` as deleted
  // and block every card. An explicit 0 is the only value that means deleted.
  if (card.active === 0)
    return { eligible: false, reason: `Shade card ${card.sc_number} has been deleted` };
  if (card.status !== 'approved')
    return { eligible: false,
             reason: `Shade card ${card.sc_number} is ${labelFor(card.status)} — the customer must approve it before printing` };
  if (isExpiredByAge(card, now))
    return { eligible: false,
             reason: `Shade card ${card.sc_number} is ${ageDays(card, now)} days old — past its ${SHADE_CARD_LIFE_DAYS}-day life. Re-approve it before printing` };
  return { eligible: true, reason: null };
}

// ── Artwork / Output code match ──────────────────────────────────────────────
// The card inherits both codes from its sales order line at creation, so a
// mismatch means a master moved AFTER the customer signed — the real-world
// error of a stale card reaching the press.
//
// A blank on either side passes deliberately. Only 5 of 1594 products carry an
// output code, so treating absence as a mismatch would refuse virtually every
// job in the plant. Absence is silence, not disagreement.
const norm = v => String(v ?? '').trim().toUpperCase();

export function codeMatch(card, line) {
  const pairs = [
    { field: 'Artwork code', card: card?.artwork_no, order: line?.party_artwork_code },
    { field: 'Output code',  card: card?.output_no,  order: line?.output_number },
  ];
  const mismatches = pairs
    .filter(p => norm(p.card) && norm(p.order) && norm(p.card) !== norm(p.order))
    .map(p => ({ field: p.field, card: p.card, order: p.order }));
  return { ok: mismatches.length === 0, mismatches };
}

// ── Custody loop ─────────────────────────────────────────────────────────────
// Where the physical card is, as a repeating issue → return cycle. The DB holds
// at most one open row per card (partial unique index), so "is it out?" is a
// row, not a flag anybody has to remember to clear.
export const DEPARTMENTS = [
  { key: 'printing', label: 'Printing' },
  { key: 'quality',  label: 'Quality' },
  { key: 'planning', label: 'Planning' },
  { key: 'sales',    label: 'Sales' },
  { key: 'customer', label: 'Customer' },
  { key: 'store',    label: 'Store' },
];

export const RETURN_CONDITIONS = [
  { key: 'good',    label: 'Good — fit for reuse' },
  { key: 'soiled',  label: 'Soiled — usable, mark it' },
  { key: 'damaged', label: 'Damaged — needs replacing' },
  { key: 'lost',    label: 'Not returned / lost' },
];

export function issueBlocker(card, openIssue) {
  if (!card) return 'Shade card not found';
  if (!card.active) return 'A deleted shade card cannot be issued';
  if (card.status !== 'approved')
    return `Only an approved shade card can be issued — ${card.sc_number} is ${labelFor(card.status)}`;
  if (openIssue)
    return `Already issued to ${openIssue.issued_to} (${openIssue.department})`;
  return null;
}

export function returnBlocker(openIssue) {
  if (!openIssue) return 'This shade card is not issued to anyone';
  return null;
}

export function holderOf(openIssue) {
  if (!openIssue) return null;
  return {
    issued_to: openIssue.issued_to,
    department: openIssue.department,
    since: openIssue.issued_at,
  };
}

// ── How the customer's approval arrived ──────────────────────────────────────
// Recorded as a plain fact. The old digital/physical/stamped classification is
// gone: it produced eight label permutations nobody acted on differently.
export const APPROVAL_METHODS = [
  { key: 'physical_signed_copy', label: 'Physical signed copy' },
  { key: 'email',                label: 'Email approval' },
  { key: 'whatsapp',             label: 'WhatsApp approval' },
  { key: 'digital_signature',    label: 'Digital signature' },
  { key: 'customer_portal',      label: 'Customer portal' },
  { key: 'verbal',               label: 'Verbal (remarks mandatory)' },
];
