// Pure rules for the Shade Card Management lifecycle. DB-free so it unit-tests
// like tooling-gate.js — routes import these and throw on a non-null blocker.
//
// Two independent axes live on one card:
//   status     the APPROVAL lifecycle (draft → … → customer_approved / …)
//   dock_zone  the PHYSICAL loop (triage → vault ⇄ on_press), ported from the
//              old Tooling Hub Control Dock.
// Production eligibility reads the approval axis + expiry, never the dock.

export const SHADE_STATUSES = [
  'draft', 'internal_review', 'internal_approved', 'sent_to_customer',
  'customer_reviewing', 'revision_requested', 'revised', 'customer_approved',
  'rejected', 'expired', 'superseded', 'archived',
];

// Allowed forward moves. Every status may additionally move to 'archived', and
// any live status may be marked 'superseded' by a revision or 'expired' by age
// (see TERMINAL / alwaysAllowed below).
export const TRANSITIONS = {
  draft:              ['internal_review'],
  internal_review:    ['internal_approved', 'draft'],
  internal_approved:  ['sent_to_customer'],
  sent_to_customer:   ['customer_reviewing', 'customer_approved', 'revision_requested', 'rejected'],
  customer_reviewing: ['customer_approved', 'revision_requested', 'rejected'],
  revision_requested: ['revised'],
  revised:            ['internal_review', 'sent_to_customer'],
  customer_approved:  ['revision_requested'],
  rejected:           ['revised'],
  expired:            ['revised'],
  superseded:         [],
  archived:           [],
};

const TERMINAL = ['superseded', 'archived'];
const LIVE = SHADE_STATUSES.filter(s => !TERMINAL.includes(s));

// Returns a human blocker string, or null when the move is allowed.
export function transitionBlocker(card, to) {
  if (!card) return 'Shade card not found';
  if (!SHADE_STATUSES.includes(to)) return `Unknown status "${to}"`;
  if (card.status === to) return `Already ${labelFor(to)}`;
  if (to === 'archived') return null;                       // anything can be shelved
  if (to === 'superseded' || to === 'expired')
    return LIVE.includes(card.status) ? null : `A ${labelFor(card.status)} card cannot become ${labelFor(to)}`;
  if (!(TRANSITIONS[card.status] || []).includes(to))
    return `${labelFor(card.status)} → ${labelFor(to)} is not a valid move`;
  return null;
}

export function labelFor(status) {
  return String(status || '').split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// ── Expiry ───────────────────────────────────────────────────────────────────
// Colour standards fade and drift: a card is obsolete 365 days after its
// creation date (same rule the Planning/Invoicing warnings always used).
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

// ── Approval classification ──────────────────────────────────────────────────
// The system distinguishes: only internally approved / customer approved
// without stamp / with stamp / digitally / physically.
const DIGITAL_METHODS = ['email', 'whatsapp', 'digital_signature', 'customer_portal'];
const PHYSICAL_METHODS = ['physical_signed_copy'];
export const APPROVAL_METHODS = [
  { key: 'physical_signed_copy', label: 'Physical signed copy' },
  { key: 'email',                label: 'Email approval' },
  { key: 'whatsapp',             label: 'WhatsApp approval' },
  { key: 'digital_signature',    label: 'Digital signature' },
  { key: 'customer_portal',      label: 'Customer portal' },
  { key: 'verbal',               label: 'Verbal (remarks mandatory)' },
];

export function approvalClass(card) {
  if (!card) return 'none';
  if (card.status === 'customer_approved') {
    const channel = DIGITAL_METHODS.includes(card.approval_method) ? 'digital'
      : PHYSICAL_METHODS.includes(card.approval_method) ? 'physical' : 'other';
    if (card.customer_stamp) return `customer_stamped_${channel}`;
    return `customer_no_stamp_${channel}`;
  }
  if (['internal_approved', 'sent_to_customer', 'customer_reviewing'].includes(card.status))
    return 'internal_only';
  return 'none';
}

// ── Production control ───────────────────────────────────────────────────────
// requirement: 'customer' → printing blocked until customer approval;
//              'internal' → internal approval (or later) suffices.
// Effective requirement falls through product → customer → card → 'customer'.
export function effectiveRequirement(card, product, customer) {
  return product?.shade_approval_requirement
    || customer?.shade_approval_requirement
    || card?.approval_requirement
    || 'customer';
}

const INTERNALLY_OK = ['internal_approved', 'sent_to_customer', 'customer_reviewing', 'customer_approved'];

// Returns { eligible, hard, reason }.
//   eligible  production may start
//   hard      when not eligible: true = block outright (customer approval is
//             mandatory and missing), false = soft alarm (structured-409 ack)
export function productionEligibility(card, requirement, now = Date.now()) {
  if (!card) return { eligible: true, hard: false, reason: null }; // nothing registered — nothing to enforce
  if (card.status === 'customer_approved' && !isExpiredByAge(card, now))
    return { eligible: true, hard: false, reason: null };
  if (['expired'].includes(card.status) || isExpiredByAge(card, now))
    return { eligible: false, hard: requirement === 'customer',
             reason: `Shade card ${card.sc_number} has expired (${SHADE_CARD_LIFE_DAYS}-day life) — re-approve before production` };
  if (['rejected', 'revision_requested', 'superseded', 'archived'].includes(card.status))
    return { eligible: false, hard: true,
             reason: `Shade card ${card.sc_number} is ${labelFor(card.status)} — production must not use it` };
  if (requirement === 'internal' && INTERNALLY_OK.includes(card.status))
    return { eligible: true, hard: false, reason: null };
  if (requirement === 'customer')
    return { eligible: false, hard: true,
             reason: `Customer approval is mandatory — shade card ${card.sc_number} is ${labelFor(card.status)}` };
  return { eligible: false, hard: false,
           reason: `Shade card ${card.sc_number} is ${labelFor(card.status)} — internal approval pending` };
}

// ── Dock (physical loop) ─────────────────────────────────────────────────────
export const DOCK_ZONES = ['triage', 'vault', 'on_press'];

export function dockIssueBlocker(card) {
  if (!card) return 'Shade card not found';
  if (!card.active) return 'A deleted shade card cannot be issued';
  if (['rejected', 'superseded', 'archived'].includes(card.status))
    return `A ${labelFor(card.status)} shade card cannot go to press`;
  if (card.dock_zone === 'on_press') return 'Already on press';
  return null;
}

export function dockReturnBlocker(card) {
  if (!card) return 'Shade card not found';
  if (card.dock_zone !== 'on_press') return 'Only an on-press shade card can return to the vault';
  return null;
}
