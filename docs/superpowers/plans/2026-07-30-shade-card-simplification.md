# Shade Card Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Shade Card module around the seven steps the plant actually follows — create, dispatch, approve, receive back, issue to printing, run, return — collapsing 12 statuses and 3 dock zones into 4 statuses and one repeating custody loop, with every field auto-populated from the Sales Order.

**Architecture:** One approval lifecycle on `shade_cards.status`, one repeating custody loop in a new `shade_card_issues` table (the open row *is* the current holder), and expiry derived from `creation_date` rather than stored as a status. Pure rules live in `server/src/shade-flow.js` and are unit-tested without a database, exactly as `tooling-gate.js` is. No column is dropped: retired columns stay in place, marked deprecated, written by nothing.

**Tech Stack:** Node 22 + Express + Postgres (`pg`) on the server, React 18 + Vite + Tailwind on the client. Tests are `node:test` + `node:assert/strict`, run with `npm test -w server`.

**Spec:** [2026-07-30-shade-card-simplification-design.md](../specs/2026-07-30-shade-card-simplification-design.md)

---

## Before You Start

This repository is the live Colour Impressions plant ERP behind `motionci.in`. Read `CLAUDE.md` at the repo root first.

- **Never push to `main` in this plan.** Pushing `main` auto-deploys production. Every task commits locally only; deployment is a separate decision the user makes at the end.
- Local Postgres is embedded at `postgresql://postgres:postgres@localhost:5439/cierp`. There is no `psql` on this machine — query it with a throwaway `.mjs` script run from inside `server/` so it can resolve the `pg` package.
- Several Claude sessions may edit this one tree. Run `git status --short --branch` before staging, and stage only the files your task names.
- The dev server is started via the Browser pane preview tools, never `npm run dev` in Bash.

## File Structure

**Created:**

| file | responsibility |
|---|---|
| `supabase/migrations/0013_shade_card_simplification.sql` | the production migration: new tables, two new columns, status remap, dock→issue conversion, back-fills |
| `client/src/pages/shade-cards/ShadeCardDrawer.jsx` | the detail drawer: progress rail, one primary action, issue/return log, docs, audit |
| `client/src/pages/shade-cards/ShadeCardForm.jsx` | the create/edit form: one Sales-Order picker plus the five fields that are genuinely new |
| `client/src/pages/shade-cards/RetireZone.jsx` | the legacy free-text number zone: retire, restore, promote |

`ShadeCards.jsx` is split into a directory because it is 998 lines today and the rebuild adds a retire zone. Three focused files (register, drawer, form) plus the zone each hold one responsibility and stay small enough to reason about. This follows the split already used for `client/src/components/`.

**Rewritten:**

| file | responsibility |
|---|---|
| `server/src/shade-flow.js` | pure lifecycle, expiry, printing gate, code match, custody blockers |
| `server/src/shade-flow.test.js` | unit tests for all of the above |
| `server/src/routes/shadecards.js` | the module API |
| `client/src/pages/ShadeCards.jsx` | the register: 8 dashboard tiles that filter one table |

**Modified:**

| file | change |
|---|---|
| `server/src/db.js` | new tables, `order_line_id` + `output_no`, deprecation comments |
| `server/src/readiness-light.js` | `shadeState` drops `hard`; batch query drops both requirement joins |
| `server/src/readiness-light.test.js` | shade fixtures updated to the new shape |
| `server/src/routes/production.js` | one approval rule; code-mismatch 409; printing-complete closes the open issue |
| `server/src/helpers.js` | `shadeCardsFor` status list |
| `client/src/pages/Planning.jsx` | shade inputs read-only + click-through; one-click Issue to Printing |
| `client/src/pages/Artwork.jsx` | shade inputs read-only |
| `client/src/pages/Production.jsx` | shade inputs read-only |
| `client/src/pages/Masters.jsx` | shade card read-only; `shade_approval_requirement` removed from both field lists |
| `client/src/pages/Section.jsx` | acknowledge dialog text → code mismatch |
| `client/src/pages/JobCardPrint.jsx` | status labels |
| `client/src/pages/Invoices.jsx` | status labels |

---

## Task 1: Pure lifecycle rules

The heart of the change. Everything else consumes these functions, so it goes first and is fully tested before any route exists.

**Files:**
- Rewrite: `server/src/shade-flow.js`
- Rewrite: `server/src/shade-flow.test.js`

- [ ] **Step 1: Write the failing test**

Replace the entire contents of `server/src/shade-flow.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && npm test -w server -- --test-name-pattern="statuses|codeMatch|holderOf"
```

Expected: FAIL. The import of `printingEligibility`, `codeMatch`, `issueBlocker`, `returnBlocker` and `holderOf` resolves to `undefined`, so the first test that calls one throws `TypeError: ... is not a function`. The `SHADE_STATUSES` assertion fails first with the 12-value array.

- [ ] **Step 3: Write the implementation**

Replace the entire contents of `server/src/shade-flow.js`:

```js
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
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && node --test server/src/shade-flow.test.js
```

Expected: PASS, 22 tests, 0 failures.

- [ ] **Step 5: Confirm what this breaks, so later tasks are not a surprise**

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && npm test -w server 2>&1 | tail -30
```

Expected: FAIL in `readiness-light.test.js` and any other suite importing the deleted `productionEligibility` / `effectiveRequirement`. This is the expected red state — Tasks 8 and 9 clear it. Write down the failing suite names before moving on.

- [ ] **Step 6: Commit**

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && git add server/src/shade-flow.js server/src/shade-flow.test.js && git commit -m "refactor(shade): four statuses and a custody loop, not twelve statuses and three zones

Expiry stops being a status and stays purely derived from creation_date — it
used to be both, so one fact had two sources that could disagree.

Internal approval is removed as a concept: the printing gate is now one rule,
the customer has approved and the approval is in date.

codeMatch treats a blank code as silence rather than a mismatch. Only 5 of
1594 products carry an output code, so the strict reading would refuse
virtually every job in the plant."
```

---

## Task 2: Schema — new tables, two columns, nothing dropped

**Files:**
- Modify: `server/src/db.js` (the Shade Card block, currently lines 1270–1441)
- Create: `supabase/migrations/0013_shade_card_simplification.sql`

- [ ] **Step 1: Add the two new tables and two new columns to `db.js`**

In `server/src/db.js`, immediately after the `CREATE INDEX IF NOT EXISTS idx_sc_events_card ON shade_card_events(shade_card_id, id);` line, insert:

```sql
-- ── 2026-07-30 Shade Card simplification ─────────────────────────────────────
-- The card's Sales Order link and Output Code. order_line_id (not order_id) is
-- the anchor because every field the form auto-populates — order quantity,
-- product, board, print specs, artwork code, output code — is line-level. The
-- order is reached by join, so navigation works in both directions.
-- Nullable: the 599 cards bulk-imported in July 2026 predate any SO link.
ALTER TABLE shade_cards ADD COLUMN IF NOT EXISTS order_line_id INTEGER REFERENCES order_lines(id);
ALTER TABLE shade_cards ADD COLUMN IF NOT EXISTS output_no TEXT;
CREATE INDEX IF NOT EXISTS idx_fk_shade_cards_order_line_id ON shade_cards (order_line_id);

-- The custody register: who physically holds the card, and every hand-off it
-- has ever been through. Deliberately NOT a column on shade_cards — a card is
-- issued and returned many times over its 365-day life while its approval
-- state never moves, so custody is a log, not a flag.
CREATE TABLE IF NOT EXISTS shade_card_issues (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shade_card_id INTEGER NOT NULL REFERENCES shade_cards(id) ON DELETE CASCADE,
  issued_to     TEXT NOT NULL,
  department    TEXT NOT NULL DEFAULT 'printing',
  issued_by     TEXT,
  issued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  job_card_id   INTEGER REFERENCES job_cards(id),
  machine_id    INTEGER REFERENCES machines(id),
  returned_by   TEXT,
  received_by   TEXT,
  returned_at   TIMESTAMPTZ,
  condition     TEXT CHECK (condition IN ('good','soiled','damaged','lost')),
  remarks       TEXT
);
-- One open issue per card, enforced by the database rather than by a code check
-- somebody can forget. This is what makes "where is this card?" a single row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sc_issues_open
  ON shade_card_issues (shade_card_id) WHERE returned_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sc_issues_card ON shade_card_issues (shade_card_id, id);
CREATE INDEX IF NOT EXISTS idx_fk_sc_issues_job_card_id ON shade_card_issues (job_card_id);
CREATE INDEX IF NOT EXISTS idx_fk_sc_issues_machine_id ON shade_card_issues (machine_id);

-- The retire zone for the free-text shade card numbers that used to be typed
-- onto the product master. Retiring moves the value here and clears the product
-- columns; restoring puts it back. Nothing is ever deleted, and an orphan
-- number can be promoted into a real card (promoted_to).
CREATE TABLE IF NOT EXISTS shade_card_legacy_numbers (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id  INTEGER NOT NULL REFERENCES products(id),
  sc_number   TEXT,
  sc_date     TEXT,
  promoted_to INTEGER REFERENCES shade_cards(id),
  retired_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_by  TEXT,
  restored_at TIMESTAMPTZ,
  restored_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_fk_sc_legacy_product_id ON shade_card_legacy_numbers (product_id);
CREATE INDEX IF NOT EXISTS idx_fk_sc_legacy_promoted_to ON shade_card_legacy_numbers (promoted_to);
```

- [ ] **Step 2: Widen the status CHECK constraint in `db.js` so both old and new values are legal**

`CREATE TABLE IF NOT EXISTS shade_cards` does not re-run on an existing database, so the inline `CHECK` on line 1298 only governs a freshly-created one. Both must accept the new four values. In `server/src/db.js`, replace the status column definition inside `CREATE TABLE IF NOT EXISTS shade_cards`:

```sql
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
    ('draft','sent','approved','rejected')),
```

Then, immediately after the `ALTER TABLE shade_cards ADD COLUMN IF NOT EXISTS output_no TEXT;` line added in Step 1, add the constraint swap for databases that already exist:

```sql
-- Existing databases carry the twelve-value constraint. Remap the rows, then
-- swap the constraint — in this statement order so the new constraint never
-- sees an old value.
--
-- The goal is to PRESERVE today's gate behaviour while never inventing an
-- approval that was never asserted. Those are two different requirements, and
-- an earlier draft of this migration satisfied the second while violating the
-- first, in a plant-stopping way.
--
-- Three old statuses ARE the plant's record of a customer verdict, so they
-- carry across directly. This is not "trusting a name": 'customer_approved'
-- means the customer approved, and such a card clears the printing gate TODAY.
-- Sending it anywhere else would change behaviour, not preserve it.
--   Every one of the 599 live cards on production is 'customer_approved' with
--   a NULL approval_received_date — the bulk import never populated the dates.
--   A purely date-derived remap therefore sent all 599 to 'draft', which under
--   the new one-rule gate hard-blocks printing on every shade-carded product
--   in the plant. Verified against prod, not assumed.
--
-- 'expired' is the mapping that genuinely needs care, because it asserts a
-- LAPSED approval rather than a live one. Carrying it to 'approved' is safe
-- only when creation_date exists, because isExpiredByAge() then blocks it
-- independently — the gate tests status AND age. With no date there is nothing
-- to expire against, so it would clear for ever; fall back to 'draft'.
--
-- Everything else (draft, internal_review, internal_approved, revised) asserts
-- no customer approval at all, so it falls through to the dates and defaults
-- to 'draft'. Nothing gains an approval it never had. internal_approved
-- tightening is intended: internal approval is being removed as a concept.
ALTER TABLE shade_cards DROP CONSTRAINT IF EXISTS shade_cards_status_check;
UPDATE shade_cards SET active = 0 WHERE status IN ('superseded','archived');
UPDATE shade_cards SET status = CASE
    WHEN status = 'customer_approved'                            THEN 'approved'
    WHEN status IN ('rejected','revision_requested')             THEN 'rejected'
    WHEN status IN ('sent_to_customer','customer_reviewing')     THEN 'sent'
    WHEN status = 'expired' AND COALESCE(creation_date,'') <> '' THEN 'approved'
    WHEN COALESCE(approval_received_date,'') <> ''               THEN 'approved'
    WHEN COALESCE(sent_to_customer_date,'')  <> ''               THEN 'sent'
    ELSE 'draft'
  END
  WHERE status NOT IN ('draft','sent','approved','rejected');
ALTER TABLE shade_cards ADD CONSTRAINT shade_cards_status_check
  CHECK (status IN ('draft','sent','approved','rejected'));

-- Any card physically out on press becomes an OPEN issue row so custody
-- survives the change. issued_operator is nullable and issued_to is NOT NULL,
-- so the COALESCE is load-bearing: a null would abort this statement.
INSERT INTO shade_card_issues (shade_card_id, issued_to, department, issued_by,
                               issued_at, job_card_id, machine_id)
SELECT sc.id, COALESCE(NULLIF(TRIM(sc.issued_operator), ''), 'unknown (migrated)'),
       'printing', 'migration', COALESCE(sc.issued_at, sc.dock_since, now()),
       sc.issued_job_card_id, sc.issued_machine_id
FROM shade_cards sc
WHERE sc.dock_zone = 'on_press'
  AND NOT EXISTS (SELECT 1 FROM shade_card_issues i
                  WHERE i.shade_card_id = sc.id AND i.returned_at IS NULL);

-- products.shade_card_number/date become a DERIVED cache of the module, never a
-- source. Back-filling from the newest active card fixes the 12 products whose
-- hand-typed date disagreed with the card's.
UPDATE products p SET shade_card_number = s.sc_number,
                      shade_card_date   = COALESCE(s.creation_date, p.shade_card_date)
FROM (SELECT DISTINCT ON (product_id) product_id, sc_number, creation_date
      FROM shade_cards WHERE active = 1 ORDER BY product_id, id DESC) s
WHERE s.product_id = p.id
  AND (COALESCE(p.shade_card_number,'') <> COALESCE(s.sc_number,'')
    OR COALESCE(p.shade_card_date,'')   <> COALESCE(s.creation_date, p.shade_card_date, ''));

-- Seed the card's own Output Code from the product master where it is blank.
UPDATE shade_cards sc SET output_no = p.output_number
FROM products p
WHERE p.id = sc.product_id
  AND COALESCE(sc.output_no,'') = '' AND COALESCE(p.output_number,'') <> '';
```

- [ ] **Step 3: Mark the retired columns deprecated in `db.js`**

Directly above the `CREATE TABLE IF NOT EXISTS shade_cards` statement, replace the existing block comment's `dock_zone` and `approval_requirement` bullets with:

```
  //  • DEPRECATED 2026-07-30, kept for reversibility, written by nothing:
  //    internal_qc_stamp, internal_signatory, internal_approval_date,
  //    approval_requirement, superseded_by, dock_zone, dock_since,
  //    issued_machine_id, issued_operator, issued_job_card_id, issued_at,
  //    verified, verified_at — and the shade_card_revisions table, plus
  //    customers/products.shade_approval_requirement.
  //    Internal approval and the triage/vault/on_press dock were removed when
  //    the module collapsed to four statuses and a custody log. These columns
  //    are NOT dropped: dropping on the live plant DB is irreversible, and the
  //    gain would be tidiness rather than function. Leaving them keeps db.js
  //    and prod in agreement and makes the whole change revertible in code
  //    alone. Every one is nullable or NOT NULL with a default, so inserts
  //    that ignore them succeed. Drop them in a later cleanup once the new
  //    module has run in the plant.
```

- [ ] **Step 4: Write the standalone production migration**

Create `supabase/migrations/0013_shade_card_simplification.sql` containing, in order: the two `ALTER TABLE shade_cards ADD COLUMN` statements from Step 1, both `CREATE TABLE` statements with all their indexes, then the whole constraint-swap / dock-conversion / back-fill block from Step 2, wrapped:

```sql
-- 0013 Shade Card simplification.
-- Safe to re-run: every statement is IF NOT EXISTS or idempotent by predicate.
-- Run `npm run db:backup` before applying this to production.
BEGIN;
-- … the statements from Steps 1 and 2, in that order …
COMMIT;
```

The status remap and the constraint swap **must** be inside one transaction: the new constraint rejects the old values, so a failure between them would leave the table unconstrained with mixed values.

- [ ] **Step 5: Apply to the local database and verify**

Restart the local server so `db.js` runs its DDL, then check with a throwaway script:

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp/server" && cat > _check.mjs <<'EOF'
import pg from 'pg';
const c = new pg.Client({ connectionString: 'postgresql://postgres:postgres@localhost:5439/cierp' });
await c.connect();
const r = async s => (await c.query(s)).rows;
console.log('new tables:', await r(`SELECT table_name FROM information_schema.tables
  WHERE table_name IN ('shade_card_issues','shade_card_legacy_numbers') ORDER BY 1`));
console.log('new columns:', await r(`SELECT column_name FROM information_schema.columns
  WHERE table_name='shade_cards' AND column_name IN ('order_line_id','output_no') ORDER BY 1`));
console.log('status constraint:', await r(`SELECT pg_get_constraintdef(oid) def FROM pg_constraint
  WHERE conname='shade_cards_status_check'`));
console.log('open-issue index:', await r(`SELECT indexdef FROM pg_indexes WHERE indexname='idx_sc_issues_open'`));
console.log('statuses in use:', await r(`SELECT status, COUNT(*)::int n FROM shade_cards GROUP BY 1`));
await c.end();
EOF
node _check.mjs; rm -f _check.mjs
```

Expected: both tables listed, both columns listed, the constraint reading `CHECK (status = ANY (ARRAY['draft','sent','approved','rejected']))`, the partial index present with `WHERE (returned_at IS NULL)`, and every `status` value in the four-value set.

- [ ] **Step 6: Prove the open-issue guarantee is enforced by the database**

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp/server" && cat > _check2.mjs <<'EOF'
import pg from 'pg';
const c = new pg.Client({ connectionString: 'postgresql://postgres:postgres@localhost:5439/cierp' });
await c.connect();
await c.query('BEGIN');
const [card] = (await c.query(`INSERT INTO shade_cards (sc_number, title, status)
  VALUES ('CI-SC-TEST', 'index probe', 'approved') RETURNING id`)).rows;
await c.query(`INSERT INTO shade_card_issues (shade_card_id, issued_to) VALUES ($1,'A')`, [card.id]);
try {
  await c.query(`INSERT INTO shade_card_issues (shade_card_id, issued_to) VALUES ($1,'B')`, [card.id]);
  console.log('FAIL — a second open issue was accepted');
} catch (e) { console.log('PASS — second open issue refused:', e.code); }
await c.query(`UPDATE shade_card_issues SET returned_at = now() WHERE shade_card_id=$1`, [card.id]);
await c.query(`INSERT INTO shade_card_issues (shade_card_id, issued_to) VALUES ($1,'B')`, [card.id]);
console.log('PASS — re-issue after return accepted');
await c.query('ROLLBACK');
await c.end();
EOF
node _check2.mjs; rm -f _check2.mjs
```

Expected: `PASS — second open issue refused: 23505`, then `PASS — re-issue after return accepted`. The transaction rolls back, so no test data survives.

- [ ] **Step 7: Commit**

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && git add server/src/db.js supabase/migrations/0013_shade_card_simplification.sql && git commit -m "feat(shade): custody register, SO link and a reversible retire zone

Statuses are remapped from the dates on each row rather than from a lookup of
old status names, so the migration can only tighten a printing gate, never
loosen one.

No column is dropped. The thirteen columns internal approval and the dock loop
used to need stay in place, marked deprecated, so this whole change is
revertible in code alone."
```

---

## Task 3: Read API — list, detail, meta, and the Sales-Order prefill

**Files:**
- Modify: `server/src/routes/shadecards.js` (replace lines 1–299: imports, `CARD_VIEW`, `decorate`, `/meta`, list, `/print-stations`, and the detail route)

- [ ] **Step 1: Replace the imports and constants**

At the top of `server/src/routes/shadecards.js`, replace the `shade-flow.js` import with:

```js
import {
  SHADE_STATUSES, APPROVAL_METHODS, DEPARTMENTS, RETURN_CONDITIONS,
  transitionBlocker, labelFor, printingEligibility, codeMatch,
  issueBlocker, returnBlocker, holderOf, ageDays, isExpiredByAge,
  SHADE_CARD_LIFE_DAYS,
} from '../shade-flow.js';
```

Replace `EDIT_COLS` (line 47) with the reduced set — `approval_requirement` is gone because internal approval is gone, and `output_no` joins:

```js
const EDIT_COLS = ['title', 'colour_system', 'num_colours', 'print_process',
  'artwork_no', 'artwork_rev', 'output_no', 'print_reference', 'colour_details',
  'expected_approval_date', 'creation_date', 'location', 'remarks'];
```

`product_id`, `customer_id` and `order_line_id` are deliberately **not** editable: they are the card's identity and the thing every auto-populated field resolves through. Changing them would silently re-point a customer-approved card at different work.

- [ ] **Step 2: Replace `CARD_VIEW`**

The joins for `machines`, `job_cards` and `superseded_by` go; the open issue row and the sales order line arrive:

```js
// One SELECT for the list and the detail. Every joined fact the dashboard needs,
// plus the order line the card inherits from and the open custody row.
const CARD_VIEW = `
  SELECT sc.*, p.name AS product_name, p.code AS product_code,
         p.party_artwork_code AS product_artwork_code,
         p.output_number AS product_output_number,
         p.board_name, p.gsm, p.colors AS product_colours,
         p.colour_type AS product_colour_system, p.coating,
         c.name AS customer_name, c.id AS customer_ref,
         ol.qty AS order_qty, ol.status AS line_status,
         o.id AS order_id, o.po_number, o.po_date,
         COALESCE(sco.orders, '[]'::json) AS orders,
         COALESCE(docs.n, 0) AS docs_count,
         COALESCE(iss.n, 0)  AS issue_count,
         open_i.id AS open_issue_id, open_i.issued_to, open_i.department,
         open_i.issued_at, open_i.issued_by,
         open_i.job_card_id AS issued_job_card_id_live,
         im.name AS issued_machine_name,
         ijc.jc_number AS issued_jc_number,
         last_r.returned_at AS last_returned_at, last_r.condition AS last_condition,
         jcs.jc_number AS latest_jc_number, jcs.status AS latest_jc_status
  FROM shade_cards sc
  LEFT JOIN products p ON p.id = sc.product_id
  LEFT JOIN customers c ON c.id = sc.customer_id
  LEFT JOIN order_lines ol ON ol.id = sc.order_line_id
  LEFT JOIN orders o ON o.id = ol.order_id
  LEFT JOIN LATERAL (
    SELECT * FROM shade_card_issues i
    WHERE i.shade_card_id = sc.id AND i.returned_at IS NULL LIMIT 1) open_i ON true
  LEFT JOIN machines im ON im.id = open_i.machine_id
  LEFT JOIN job_cards ijc ON ijc.id = open_i.job_card_id
  LEFT JOIN LATERAL (
    SELECT returned_at, condition FROM shade_card_issues i
    WHERE i.shade_card_id = sc.id AND i.returned_at IS NOT NULL
    ORDER BY i.returned_at DESC LIMIT 1) last_r ON true
  LEFT JOIN LATERAL (
    SELECT json_agg(json_build_object('id', o2.id, 'po_number', o2.po_number,
                                      'status', o2.status, 'order_date', o2.po_date)
                    ORDER BY o2.id) AS orders
    FROM shade_card_orders l JOIN orders o2 ON o2.id = l.order_id
    WHERE l.shade_card_id = sc.id) sco ON true
  LEFT JOIN LATERAL (SELECT COUNT(*)::int AS n FROM shade_card_docs d
                     WHERE d.shade_card_id = sc.id) docs ON true
  LEFT JOIN LATERAL (SELECT COUNT(*)::int AS n FROM shade_card_issues i
                     WHERE i.shade_card_id = sc.id) iss ON true
  LEFT JOIN LATERAL (SELECT jc.jc_number, jc.status FROM job_cards jc
                     WHERE jc.product_id = sc.product_id
                     ORDER BY jc.id DESC LIMIT 1) jcs ON true`;
```

Note `open_i` is joined `LIMIT 1` even though the partial unique index already guarantees at most one row — the planner needs the bound, and it documents the invariant at the read site.

- [ ] **Step 3: Replace `decorate`**

```js
// Age, printing verdict and code match, in one place for every response.
// `line` carries the effective order-line spec the card is compared against;
// the product master is the fallback when the card has no order line (the 599
// bulk-imported cards).
function decorate(card) {
  const gate = printingEligibility(card);
  const match = codeMatch(card, {
    party_artwork_code: card.product_artwork_code,
    output_number: card.product_output_number,
  });
  const open = card.open_issue_id
    ? { issued_to: card.issued_to, department: card.department, issued_at: card.issued_at }
    : null;
  return {
    ...card,
    age_days: ageDays(card),
    expired_by_age: isExpiredByAge(card),
    printing_eligible: gate.eligible,
    printing_block_reason: gate.reason,
    code_ok: match.ok,
    code_mismatches: match.mismatches,
    holder: holderOf(open),
    with_printing: !!card.open_issue_id,
  };
}
```

- [ ] **Step 4: Replace `/meta`, and delete `/print-stations`**

```js
r.get('/shade-cards/meta', async (_req, res, next) => {
  try {
    res.json({
      statuses: SHADE_STATUSES,
      approval_methods: APPROVAL_METHODS,
      departments: DEPARTMENTS,
      return_conditions: RETURN_CONDITIONS,
      life_days: SHADE_CARD_LIFE_DAYS,
    });
  } catch (e) { next(e); }
});
```

Delete the whole `r.get('/shade-cards/print-stations', …)` handler. The issue form now picks a department and a person, not a press and an operator; presses and employees come from the existing `/machines` and `/employees` endpoints when a press is optionally attached.

- [ ] **Step 5: Add the prefill endpoint**

This is what makes the form one picker. Insert after `/meta`:

```js
// ── Sales-Order prefill ──────────────────────────────────────────────────────
// Everything the create form shows read-only, resolved from ONE order line.
// effectiveProduct applies the line's job-only spec_override exactly the way
// Planning, Production and the Job Card do, so a card created against an
// overridden line inherits the override and not the stale master.
r.get('/shade-cards/prefill/:lineId(\\d+)', async (req, res, next) => {
  try {
    const line = await one(`
      SELECT ol.id AS order_line_id, ol.qty, ol.spec_override, ol.product_id,
             o.id AS order_id, o.po_number, o.po_date,
             cu.id AS customer_id, cu.name AS customer_name
      FROM order_lines ol
      JOIN orders o ON o.id = ol.order_id
      LEFT JOIN customers cu ON cu.id = o.customer_id
      WHERE ol.id = $1`, [req.params.lineId]);
    if (!line) return res.status(404).json({ error: 'Sales order line not found' });
    const product = await one('SELECT * FROM products WHERE id=$1', [line.product_id]);
    const p = effectiveProduct(product, line);
    res.json({
      order_line_id: line.order_line_id,
      order_id: line.order_id,
      po_number: line.po_number,
      po_date: line.po_date,
      customer_id: line.customer_id,
      customer_name: line.customer_name,
      product_id: line.product_id,
      product_name: p?.name || null,
      product_code: p?.code || null,
      description: [p?.name, p?.party_item_code].filter(Boolean).join(' · ') || null,
      order_qty: line.qty,
      // NOTE: there is deliberately no `revision` here. The ERP has no artwork
      // revision column anywhere — the only artwork_rev in the schema is the
      // free-text one on shade_cards itself. So Revision cannot be inherited;
      // it stays a typed field on the form. Returning null would render an
      // always-blank read-only row that looks like a bug.
      artwork_no: p?.party_artwork_code || null,
      output_no: p?.output_number || null,
      board: [p?.board_name, p?.gsm ? `${p.gsm} GSM` : null].filter(Boolean).join(' · ') || null,
      print_specs: [p?.colour_type, p?.colors ? `${p.colors} colours` : null, p?.coating]
        .filter(Boolean).join(' · ') || null,
      colour_system: p?.colour_type || null,
      num_colours: p?.colors ?? null,
      suggested_title: p?.name ? `${p.name} shade card` : '',
    });
  } catch (e) { next(e); }
});
```

Add `effectiveProduct` to the `helpers.js` import at the top of the file:

```js
import { audit, effectiveProduct } from '../helpers.js';
```

- [ ] **Step 6: Update the detail route to return issues instead of revisions**

Replace the three-way `Promise.all` in `r.get('/shade-cards/:id(\\d+)')`:

```js
    const [issues, events, docs] = await Promise.all([
      q(`SELECT i.*, m.name AS machine_name, jc.jc_number
         FROM shade_card_issues i
         LEFT JOIN machines m ON m.id = i.machine_id
         LEFT JOIN job_cards jc ON jc.id = i.job_card_id
         WHERE i.shade_card_id=$1 ORDER BY i.id DESC`, [card.id]),
      q('SELECT * FROM shade_card_events WHERE shade_card_id=$1 ORDER BY id DESC', [card.id]),
      q(`SELECT id, revision_no, doc_type, title, file_name, mime, size_bytes, note, uploaded_by, created_at
         FROM shade_card_docs WHERE shade_card_id=$1 ORDER BY id DESC`, [card.id]),
    ]);
    res.json({ ...decorate(card), issues, events, docs });
```

- [ ] **Step 7: Verify the read API against the running server**

Start the dev server via the Browser pane preview tools, then:

Every `/api` route requires a bearer token, so log in first and reuse the token:

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && TOKEN=$(curl -s localhost:4000/api/login -H 'Content-Type: application/json' -d '{"email":"admin@motionci.com","password":"admin123"}' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).token))") && curl -s localhost:4000/api/shade-cards/meta -H "Authorization: Bearer $TOKEN" | head -c 400 && echo && curl -s "localhost:4000/api/shade-cards?all=1" -H "Authorization: Bearer $TOKEN" | head -c 600
```

Expected: `/meta` returns the four statuses, six departments and four return conditions. The list returns `[]` on a local database with no cards, or decorated rows carrying `age_days`, `printing_eligible`, `code_ok`, `holder` and `with_printing`. If login fails, see the launch-config note in `CLAUDE.md` — a hardcoded `DATABASE_URL` in the launch config presents as "DB loading failure".

- [ ] **Step 8: Commit**

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && git add server/src/routes/shadecards.js && git commit -m "feat(shade): one Sales Order line prefills the whole card

/prefill resolves customer, product, description, order qty, revision, artwork
code, output code, board and print specs from a single order line, through
effectiveProduct so a job-only spec override is honoured the way Planning and
the Job Card honour it.

The read view now carries the open custody row, so 'who has this card' is a
join rather than a dock_zone enum plus three nullable issued_* columns."
```

---

## Task 4: Write API — create, edit, and the four-status lifecycle

**Files:**
- Modify: `server/src/routes/shadecards.js` (the create, edit and `/status` handlers; delete `/revise` and both `/orders` handlers)

- [ ] **Step 1: Replace the create handler**

```js
// ── Create ───────────────────────────────────────────────────────────────────
// A card is created FROM a sales order line: everything on it is inherited, so
// the caller sends the line and only the handful of facts that exist nowhere
// else. order_line_id is nullable in the schema for the 599 bulk-imported
// legacy cards, but it is required here — every new card belongs to an order.
r.post('/shade-cards', canManage, async (req, res, next) => {
  try {
    const lineId = +req.body.order_line_id || null;
    if (!lineId) return res.status(400).json({ error: 'Pick the sales order this shade card is for' });
    const out = await tx(async (qc, oc) => {
      const line = await oc(`
        SELECT ol.*, o.id AS order_id, o.customer_id
        FROM order_lines ol JOIN orders o ON o.id = ol.order_id WHERE ol.id=$1`, [lineId]);
      if (!line) throw Object.assign(new Error('Sales order line not found'), { status: 404 });
      const product = await oc('SELECT * FROM products WHERE id=$1', [line.product_id]);
      const p = effectiveProduct(product, line);
      const sc_number = await nextScNumber(oc);
      const [card] = await qc(`
        INSERT INTO shade_cards (sc_number, title, product_id, customer_id, order_line_id,
          print_process, colour_system, num_colours, artwork_no, artwork_rev, output_no,
          print_reference, colour_details, expected_approval_date, creation_date,
          location, remarks, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
        [sc_number,
         req.body.title?.trim() || `${p?.name || 'Product'} shade card`,
         line.product_id, line.customer_id, lineId,
         req.body.print_process || null,
         req.body.colour_system || p?.colour_type || null,
         req.body.num_colours || p?.colors || null,
         p?.party_artwork_code || null,      // inherited, never typed
         req.body.artwork_rev || null,       // typed: the ERP has no source for it
         p?.output_number || null,           // inherited, never typed
         req.body.print_reference || null, req.body.colour_details || null,
         req.body.expected_approval_date || null,
         req.body.creation_date || new Date().toISOString().slice(0, 10),
         req.body.location || null, req.body.remarks || null, req.user.name]);
      // The originating order also joins the reuse list, so a card that later
      // serves repeat orders reads consistently from one place.
      await qc(`INSERT INTO shade_card_orders (shade_card_id, order_id) VALUES ($1,$2)
                ON CONFLICT DO NOTHING`, [card.id, line.order_id]);
      await logEvent(card.id, 'created', null, 'draft', `for order line #${lineId}`, req.user.name, qc);
      await audit('shade_card', card.id, 'create', `${sc_number} — ${card.title}`, qc, req.user.name);
      return card;
    });
    res.json(out);
  } catch (e) { next(e); }
});
```

Artwork and output codes are inherited and **not** taken from the request body. That is the point: if the form could send them, the code-match check would compare a typed value against itself and never catch a stale card.

- [ ] **Step 2: Replace the `/status` handler**

```js
// ── Status transitions ───────────────────────────────────────────────────────
// Three moves, guarded by the pure transition map:
//   sent      dispatched to the customer
//   approved  the signed, stamped card came back
//   rejected  the customer said no
// Recording an approval RESETS creation_date, which restarts the 365-day age
// clock — that is how an expired card is renewed rather than replaced.
r.post('/shade-cards/:id(\\d+)/status', canManage, async (req, res, next) => {
  try {
    const { to } = req.body;
    const out = await tx(async (qc, oc) => {
      const card = await oc('SELECT * FROM shade_cards WHERE id=$1 FOR UPDATE', [req.params.id]);
      const blk = transitionBlocker(card, to);
      if (blk) throw Object.assign(new Error(blk), { status: card ? 409 : 404 });

      const today = new Date().toISOString().slice(0, 10);
      const sets = ['status=$1', 'updated_at=now()'];
      const vals = [to];
      const set = (col, val) => { vals.push(val); sets.push(`${col}=$${vals.length}`); };

      if (to === 'sent') {
        set('sent_to_customer_date', req.body.sent_to_customer_date || today);
        if (req.body.expected_approval_date !== undefined)
          set('expected_approval_date', req.body.expected_approval_date || null);
        // Re-sending clears the previous verdict so the register never shows an
        // approval that is no longer the live answer.
        for (const col of ['approval_received_date', 'approval_received_by', 'approval_method',
                           'approval_remarks', 'customer_contact_name', 'customer_designation',
                           'customer_company']) set(col, null);
        set('customer_stamp', 0);
        set('customer_signature', 0);
      }
      if (to === 'approved') {
        const method = req.body.approval_method;
        if (!APPROVAL_METHODS.some(m => m.key === method))
          throw Object.assign(new Error('Pick how the approval was received'), { status: 400 });
        if (method === 'verbal' && !req.body.note?.trim())
          throw Object.assign(new Error('A verbal approval needs mandatory remarks'), { status: 400 });
        const received = req.body.approval_received_date || today;
        set('approval_method', method);
        set('approval_received_date', received);
        set('approval_received_by', req.body.approval_received_by?.trim() || req.user.name);
        set('customer_stamp', req.body.customer_stamp ? 1 : 0);
        set('customer_signature', req.body.customer_signature ? 1 : 0);
        set('customer_contact_name', req.body.customer_contact_name || null);
        set('customer_designation', req.body.customer_designation || null);
        set('customer_company', req.body.customer_company || null);
        if (req.body.note !== undefined) set('approval_remarks', req.body.note || null);
        // The renewal: the card's life runs from the day this approval landed.
        set('creation_date', received);
      }
      if (to === 'rejected') {
        if (!req.body.note?.trim())
          throw Object.assign(new Error('Record why the customer rejected the card'), { status: 400 });
        set('approval_remarks', req.body.note.trim());
        set('approval_received_date', null);
        set('approval_method', null);
      }

      vals.push(card.id);
      const [fresh] = await qc(`UPDATE shade_cards SET ${sets.join(', ')}
                                WHERE id=$${vals.length} RETURNING *`, vals);
      await logEvent(card.id, 'status', card.status, to, req.body.note, req.user.name, qc);
      await audit('shade_card', card.id, to,
        `${card.sc_number}: ${labelFor(card.status)} → ${labelFor(to)}${req.body.note ? ` — ${req.body.note}` : ''}`,
        qc, req.user.name);
      // products.shade_card_number/date is a derived cache — keep it true, but
      // never against a product whose number the user RETIRED. The same guard
      // the boot-time back-fill carries has to be here too: without it,
      // approving a card silently un-retires the product's free-text number,
      // which is exactly the bug the retire zone exists to prevent.
      // promoted_to IS NULL because a promotion row is provenance, not a retire.
      if (card.product_id) {
        await qc(`UPDATE products SET shade_card_number=$2, shade_card_date=$3
                  WHERE id=$1 AND NOT EXISTS (
                    SELECT 1 FROM shade_card_legacy_numbers l
                    WHERE l.product_id = $1 AND l.restored_at IS NULL
                      AND l.promoted_to IS NULL)`,
          [card.product_id, fresh.sc_number, fresh.creation_date]);
      }
      return fresh;
    });
    res.json(out);
  } catch (e) { next(e); }
});
```

- [ ] **Step 3: Delete the three dead handlers**

Delete outright:
- `r.post('/shade-cards/:id(\\d+)/revise', …)` — revisions are gone; a rejected card is corrected and re-sent
- `r.post('/shade-cards/:id(\\d+)/orders', …)` and `r.delete('/shade-cards/:id(\\d+)/orders/:orderId', …)` — the originating order is linked at creation; reuse links are written by the issue flow

- [ ] **Step 4: Run the server tests and start the app**

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && node --test server/src/shade-flow.test.js && node -e "import('./server/src/routes/shadecards.js').then(()=>console.log('routes module loads')).catch(e=>{console.error(e);process.exit(1)})"
```

Expected: shade-flow tests pass, and `routes module loads` — proving no import references a function deleted in Task 1.

- [ ] **Step 5: Exercise the lifecycle end to end against the running server**

With the dev server up and `$TOKEN` set as in Task 3 Step 7:

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && LINE=$(curl -s localhost:4000/api/orders -H "Authorization: Bearer $TOKEN" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log(o[0]?.lines?.[0]?.id||'')})") && echo "line=$LINE" && ID=$(curl -s localhost:4000/api/shade-cards -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{\"order_line_id\":$LINE}" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).id))") && echo "card=$ID" && curl -s localhost:4000/api/shade-cards/$ID/status -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"to":"approved"}' && echo " ← must refuse: draft cannot jump to approved" && curl -s localhost:4000/api/shade-cards/$ID/status -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"to":"sent"}' >/dev/null && curl -s localhost:4000/api/shade-cards/$ID/status -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"to":"approved","approval_method":"email","customer_stamp":1}' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const c=JSON.parse(s);console.log({status:c.status,creation_date:c.creation_date,artwork_no:c.artwork_no,output_no:c.output_no})})"
```

Expected: the first status call returns `{"error":"Draft → Approved is not a valid move"}`; the last prints `status: 'approved'` with `creation_date` set to today (the age clock reset) and `artwork_no` / `output_no` inherited from the product, not sent by the caller.

If the local database has no orders, seed one first with `npm run seed -w server`.

- [ ] **Step 6: Commit**

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && git add server/src/routes/shadecards.js && git commit -m "feat(shade): three lifecycle moves replace eleven

Recording an approval resets creation_date, so renewing an expired card is one
action instead of raising a revision. Re-sending clears the previous verdict —
the register must never show an approval that is no longer the live answer.

Artwork and output codes are inherited from the order line and cannot be sent
by the caller: if the form could type them, the code-match check would compare
a value against itself and never catch a stale card."
```

---

## Task 5: Custody API — issue and return

**Files:**
- Modify: `server/src/routes/shadecards.js` (replace the three dock handlers with two)

- [ ] **Step 1: Add a shared open-issue lookup next to `logEvent`**

```js
const openIssueFor = (id, oc = one) =>
  oc('SELECT * FROM shade_card_issues WHERE shade_card_id=$1 AND returned_at IS NULL', [id]);
```

- [ ] **Step 2: Replace `/issue`**

```js
// ── Custody: issue ───────────────────────────────────────────────────────────
// Step 5 of the process. Planning issues an APPROVED card to a department and a
// named person. A press and job card are optional: attaching the job card is
// what lets printing-complete auto-return the card, which is how the plant has
// always worked.
r.post('/shade-cards/:id(\\d+)/issue', canMove, async (req, res, next) => {
  try {
    const issued_to = req.body.issued_to?.trim();
    if (!issued_to) return res.status(400).json({ error: 'Who is the card being issued to?' });
    const department = req.body.department || 'printing';
    if (!DEPARTMENTS.some(d => d.key === department))
      return res.status(400).json({ error: `Unknown department "${department}"` });
    const out = await tx(async (qc, oc) => {
      const card = await oc('SELECT * FROM shade_cards WHERE id=$1 FOR UPDATE', [req.params.id]);
      const open = card ? await openIssueFor(card.id, oc) : null;
      const blk = issueBlocker(card, open);
      if (blk) throw Object.assign(new Error(blk), { status: card ? 409 : 404 });
      const [issue] = await qc(`
        INSERT INTO shade_card_issues (shade_card_id, issued_to, department, issued_by,
                                       job_card_id, machine_id, remarks)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [card.id, issued_to, department, req.user.name,
         req.body.job_card_id ? +req.body.job_card_id : null,
         req.body.machine_id ? +req.body.machine_id : null,
         req.body.remarks || null]);
      // A card issued for work on another order joins that order's reuse list.
      if (issue.job_card_id) {
        await qc(`INSERT INTO shade_card_orders (shade_card_id, order_id)
                  SELECT $1, ol.order_id FROM job_cards jc
                  JOIN order_lines ol ON ol.id = jc.order_line_id
                  WHERE jc.id = $2 ON CONFLICT DO NOTHING`, [card.id, issue.job_card_id]);
      }
      await logEvent(card.id, 'issued', null, null,
        `${issued_to} · ${department}`, req.user.name, qc);
      await audit('shade_card', card.id, 'issued',
        `${card.sc_number} → ${issued_to} (${department})`, qc, req.user.name);
      await qc('UPDATE shade_cards SET updated_at=now() WHERE id=$1', [card.id]);
      return issue;
    });
    res.json(out);
  } catch (e) { next(e); }
});
```

- [ ] **Step 3: Replace `/return-to-vault` and `/to-vault` with `/return`**

```js
// ── Custody: return ──────────────────────────────────────────────────────────
// Step 7. Closing the open row IS the return — there is no zone to write back.
r.post('/shade-cards/:id(\\d+)/return', canMove, async (req, res, next) => {
  try {
    const condition = req.body.condition || 'good';
    if (!RETURN_CONDITIONS.some(c => c.key === condition))
      return res.status(400).json({ error: `Unknown condition "${condition}"` });
    const out = await tx(async (qc, oc) => {
      const card = await oc('SELECT * FROM shade_cards WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!card) throw Object.assign(new Error('Shade card not found'), { status: 404 });
      const open = await openIssueFor(card.id, oc);
      const blk = returnBlocker(open);
      if (blk) throw Object.assign(new Error(blk), { status: 409 });
      const [issue] = await qc(`
        UPDATE shade_card_issues SET returned_at=now(), returned_by=$2, received_by=$3,
               condition=$4, remarks=COALESCE($5, remarks)
        WHERE id=$1 RETURNING *`,
        [open.id, req.body.returned_by?.trim() || open.issued_to,
         req.body.received_by?.trim() || req.user.name, condition, req.body.remarks || null]);
      await logEvent(card.id, 'returned', null, null,
        `from ${open.issued_to} · ${condition}`, req.user.name, qc);
      await audit('shade_card', card.id, 'returned',
        `${card.sc_number} back from ${open.issued_to} — ${condition}`, qc, req.user.name);
      await qc('UPDATE shade_cards SET updated_at=now() WHERE id=$1', [card.id]);
      return issue;
    });
    res.json(out);
  } catch (e) { next(e); }
});
```

Delete `r.post('/shade-cards/:id(\\d+)/return-to-vault', …)` and `r.post('/shade-cards/:id(\\d+)/to-vault', …)`.

A `lost` condition still closes the row. That is deliberate: the card is not with printing any more, and pretending it is out on press would leave the custody register permanently wrong. The condition is what records that it never came back.

- [ ] **Step 4: Verify the loop, including the double-issue refusal**

With `$TOKEN` and the `$ID` of the approved card from Task 4:

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && A="Authorization: Bearer $TOKEN" && J='Content-Type: application/json' && curl -s localhost:4000/api/shade-cards/$ID/issue -X POST -H "$A" -H "$J" -d '{"issued_to":"Dharminder","department":"printing"}' >/dev/null && echo "issued" && curl -s localhost:4000/api/shade-cards/$ID/issue -X POST -H "$A" -H "$J" -d '{"issued_to":"Someone else"}' && echo " ← must refuse, naming Dharminder" && curl -s localhost:4000/api/shade-cards/$ID -H "$A" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const c=JSON.parse(s);console.log({with_printing:c.with_printing,holder:c.holder,issues:c.issues.length})})" && curl -s localhost:4000/api/shade-cards/$ID/return -X POST -H "$A" -H "$J" -d '{"condition":"good","returned_by":"Dharminder"}' >/dev/null && echo "returned" && curl -s localhost:4000/api/shade-cards/$ID/return -X POST -H "$A" -H "$J" -d '{"condition":"good"}' && echo " ← must refuse: not issued to anyone"
```

Expected: `issued`, then `{"error":"Already issued to Dharminder (printing)"}`, then `with_printing: true` with `holder` naming Dharminder and one issue row, then `returned`, then `{"error":"This shade card is not issued to anyone"}`.

- [ ] **Step 5: Commit**

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && git add server/src/routes/shadecards.js && git commit -m "feat(shade): issue and return as a log, not a zone

Custody is a row per hand-off carrying issued_to, department, issued_by,
returned_by, received_by, condition and remarks. The open row is the current
holder, and the partial unique index — not a code check — is what guarantees a
card is in exactly one place.

A 'lost' return still closes the row: leaving it open would say the card is on
press, which is the one thing we know is false."
```

---

## Task 6: The retire zone for the duplicate free-text numbers

On production, 896 products carry a hand-typed `shade_card_number`. 599 duplicate a real card exactly; 297 are orphans with no card behind them. This task gives them a reversible home.

**Files:**
- Modify: `server/src/routes/shadecards.js` (add four handlers before the soft-delete route)

- [ ] **Step 1: Add the zone listing**

```js
// ── Retire zone: the legacy free-text shade card numbers ─────────────────────
// products.shade_card_number/date used to be typed by hand in four places. It
// is now a DERIVED cache of this module, and these routes are how the old
// values are cleared away without ever destroying one.
//
//   candidates  a product carrying a free-text number with NO card behind it —
//               a number nobody can approve, issue or track
//   duplicates  a product whose free-text number matches its real card, so the
//               column is pure redundancy
//   retired     values already moved out, restorable at any time
r.get('/shade-cards/legacy', canManage, async (_req, res, next) => {
  try {
    const [candidates, duplicates, retired] = await Promise.all([
      q(`SELECT p.id AS product_id, p.code AS product_code, p.name AS product_name,
                c.name AS customer_name, p.shade_card_number, p.shade_card_date
         FROM products p LEFT JOIN customers c ON c.id = p.customer_id
         WHERE COALESCE(p.shade_card_number,'') <> ''
           AND NOT EXISTS (SELECT 1 FROM shade_cards s
                           WHERE s.product_id = p.id AND s.active = 1)
         ORDER BY p.code`),
      q(`SELECT p.id AS product_id, p.code AS product_code, p.name AS product_name,
                p.shade_card_number, s.sc_number, s.id AS shade_card_id
         FROM products p
         JOIN LATERAL (SELECT id, sc_number FROM shade_cards sc
                       WHERE sc.product_id = p.id AND sc.active = 1
                       ORDER BY sc.id DESC LIMIT 1) s ON true
         WHERE COALESCE(p.shade_card_number,'') <> ''
         ORDER BY p.code`),
      q(`SELECT l.*, p.code AS product_code, p.name AS product_name,
                sc.sc_number AS promoted_number
         FROM shade_card_legacy_numbers l
         JOIN products p ON p.id = l.product_id
         LEFT JOIN shade_cards sc ON sc.id = l.promoted_to
         WHERE l.restored_at IS NULL ORDER BY l.id DESC`),
    ]);
    res.json({ candidates, duplicates, retired });
  } catch (e) { next(e); }
});
```

- [ ] **Step 2: Add retire, promote and restore**

```js
// Move a product's free-text value into the zone and clear the columns.
r.post('/shade-cards/legacy/retire', canManage, async (req, res, next) => {
  try {
    const ids = [...new Set((req.body.product_ids || []).map(Number).filter(Boolean))];
    if (!ids.length) return res.status(400).json({ error: 'Pick at least one product' });
    const out = await tx(async (qc) => {
      const rows = await qc(`
        INSERT INTO shade_card_legacy_numbers (product_id, sc_number, sc_date, retired_by)
        SELECT id, shade_card_number, shade_card_date, $2 FROM products
        WHERE id = ANY($1) AND COALESCE(shade_card_number,'') <> ''
        RETURNING id, product_id`, [ids, req.user.name]);
      await qc(`UPDATE products SET shade_card_number=NULL, shade_card_date=NULL
                WHERE id = ANY($1)`, [rows.map(x => x.product_id)]);
      for (const row of rows) {
        await audit('product', row.product_id, 'shade_number_retired',
          'Legacy free-text shade card number retired — restorable from the retire zone',
          qc, req.user.name);
      }
      return { retired: rows.length };
    });
    res.json(out);
  } catch (e) { next(e); }
});

// Turn an orphan number into a real card, then retire the free text behind it.
// One action, because asking a user to retire and then separately create would
// leave the number in limbo if they stopped halfway.
r.post('/shade-cards/legacy/promote', canManage, async (req, res, next) => {
  try {
    const ids = [...new Set((req.body.product_ids || []).map(Number).filter(Boolean))];
    if (!ids.length) return res.status(400).json({ error: 'Pick at least one product' });
    const out = await tx(async (qc, oc) => {
      const made = [];
      for (const pid of ids) {
        const p = await oc(`SELECT * FROM products WHERE id=$1
                            AND COALESCE(shade_card_number,'') <> ''`, [pid]);
        if (!p) continue;
        // The free-text number is preferred so nothing printed or remembered in
        // the plant breaks — but sc_number is UNIQUE, and a free-text value may
        // already belong to another product's card. Fall back to a fresh number
        // and keep the original in remarks rather than failing the whole batch.
        const taken = await oc('SELECT id FROM shade_cards WHERE sc_number=$1', [p.shade_card_number]);
        const number = taken ? await nextScNumber(oc) : p.shade_card_number;
        const [card] = await qc(`
          INSERT INTO shade_cards (sc_number, title, product_id, customer_id, status,
            creation_date, approval_received_date, approval_method, artwork_no, output_no,
            colour_system, num_colours, remarks, created_by)
          VALUES ($1,$2,$3,$4,'approved',$5,$5,'physical_signed_copy',$6,$7,$8,$9,$10,$11)
          RETURNING *`,
          [number, `${p.name} shade card`, p.id, p.customer_id,
           p.shade_card_date || null, p.party_artwork_code || null, p.output_number || null,
           p.colour_type || null, p.colors || null,
           taken ? `Promoted from legacy number ${p.shade_card_number} (already in use, renumbered)` : 'Promoted from the legacy product-master number',
           req.user.name]);
        await qc(`INSERT INTO shade_card_legacy_numbers
                   (product_id, sc_number, sc_date, promoted_to, retired_by)
                  VALUES ($1,$2,$3,$4,$5)`,
          [p.id, p.shade_card_number, p.shade_card_date, card.id, req.user.name]);
        await qc(`UPDATE products SET shade_card_number=$2, shade_card_date=$3 WHERE id=$1`,
          [p.id, card.sc_number, card.creation_date]);
        await logEvent(card.id, 'created', null, 'approved',
          `promoted from the legacy number ${p.shade_card_number}`, req.user.name, qc);
        await audit('shade_card', card.id, 'create',
          `${card.sc_number} promoted from the product master`, qc, req.user.name);
        made.push({ product_id: p.id, shade_card_id: card.id, sc_number: card.sc_number });
      }
      return { promoted: made.length, cards: made };
    });
    res.json(out);
  } catch (e) { next(e); }
});

// Put a retired value back on the product. Nothing was ever destroyed.
r.post('/shade-cards/legacy/:id(\\d+)/restore', canManage, async (req, res, next) => {
  try {
    const out = await tx(async (qc, oc) => {
      const row = await oc(`SELECT * FROM shade_card_legacy_numbers WHERE id=$1`, [req.params.id]);
      if (!row) throw Object.assign(new Error('Retired number not found'), { status: 404 });
      if (row.restored_at) throw Object.assign(new Error('Already restored'), { status: 409 });
      await qc(`UPDATE products SET shade_card_number=$2, shade_card_date=$3 WHERE id=$1`,
        [row.product_id, row.sc_number, row.sc_date]);
      await qc(`UPDATE shade_card_legacy_numbers SET restored_at=now(), restored_by=$2
                WHERE id=$1`, [row.id, req.user.name]);
      await audit('product', row.product_id, 'shade_number_restored',
        `Legacy shade card number ${row.sc_number} restored to the product master`,
        qc, req.user.name);
      return { ok: true };
    });
    res.json(out);
  } catch (e) { next(e); }
});
```

`promote` deliberately reuses the free-text number as the card number where it is free, so nothing printed or remembered in the plant stops matching. The uniqueness fallback keeps one bad value from failing a batch of 297.

- [ ] **Step 3: Verify against the local database**

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && A="Authorization: Bearer $TOKEN" && curl -s localhost:4000/api/shade-cards/legacy -H "$A" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const z=JSON.parse(s);console.log({candidates:z.candidates.length,duplicates:z.duplicates.length,retired:z.retired.length});console.log('first candidate:',z.candidates[0])})"
```

Expected: counts printed, with `candidates` listing products carrying a free-text number and no card. On the local database this may be 0 if products were never imported — in that case create one to exercise the round trip:

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp/server" && cat > _probe.mjs <<'EOF'
import pg from 'pg';
const c = new pg.Client({ connectionString: 'postgresql://postgres:postgres@localhost:5439/cierp' });
await c.connect();
const [p] = (await c.query(`UPDATE products SET shade_card_number='LEGACY-TEST', shade_card_date='2024-05-01'
  WHERE id = (SELECT id FROM products WHERE NOT EXISTS
    (SELECT 1 FROM shade_cards s WHERE s.product_id = products.id AND s.active=1) LIMIT 1)
  RETURNING id, code`)).rows;
console.log('seeded legacy number on product', p);
await c.end();
EOF
node _probe.mjs; rm -f _probe.mjs
```

Then promote it, confirm a real card appeared, and restore to prove reversibility:

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && A="Authorization: Bearer $TOKEN" && J='Content-Type: application/json' && PID=$(curl -s localhost:4000/api/shade-cards/legacy -H "$A" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).candidates[0].product_id))") && curl -s localhost:4000/api/shade-cards/legacy/promote -X POST -H "$A" -H "$J" -d "{\"product_ids\":[$PID]}" && echo && LID=$(curl -s localhost:4000/api/shade-cards/legacy -H "$A" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).retired[0].id))") && curl -s localhost:4000/api/shade-cards/legacy/$LID/restore -X POST -H "$A" && echo " ← restored"
```

Expected: `{"promoted":1,"cards":[{…"sc_number":"LEGACY-TEST"}]}`, then `{"ok":true}`. The promoted card is `approved` and carries `creation_date: '2024-05-01'`, so it reads as 800+ days old and immediately trips the expiry alarm — which is correct and is exactly what the plant needs to see about a 2024 shade card.

- [ ] **Step 4: Commit**

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && git add server/src/routes/shadecards.js && git commit -m "feat(shade): retire zone for the 896 hand-typed duplicate numbers

Retiring moves a value out and clears the column; restoring puts it back.
Promote turns an orphan number into a real approved card in one action, because
retire-then-create would leave the number in limbo if someone stopped halfway.

The free-text value is reused as the card number where it is free so nothing
printed in the plant stops matching, with a renumber fallback so one collision
cannot fail a batch of 297."
```

---

## Task 7: Alerts and reports on the new statuses

**Files:**
- Modify: `server/src/routes/shadecards.js` (the `/alerts` and `/reports` handlers)

- [ ] **Step 1: Remap the alerts feed**

Replace the per-card loop inside `r.get('/shade-cards/alerts')`:

```js
    for (const sc of rows) {
      const ref = { id: sc.id, sc_number: sc.sc_number, title: sc.title, customer_name: sc.customer_name };
      if (sc.status === 'draft')
        alerts.push({ ...ref, kind: 'not_sent', severity: 'info',
          message: `${sc.sc_number} is still a draft — not yet sent to the customer` });
      if (sc.status === 'sent') {
        const overdue = sc.expected_approval_date && sc.expected_approval_date < today;
        alerts.push({ ...ref, kind: overdue ? 'approval_overdue' : 'pending_customer',
          severity: overdue ? 'critical' : 'warn',
          message: overdue
            ? `${sc.sc_number} customer approval OVERDUE (expected ${sc.expected_approval_date})`
            : `${sc.sc_number} awaiting customer approval` });
      }
      if (sc.status === 'rejected')
        alerts.push({ ...ref, kind: 'rejected', severity: 'critical',
          message: `${sc.sc_number} was rejected by the customer — correct it and send again` });
      if (sc.expired_by_age)
        alerts.push({ ...ref, kind: 'expired', severity: 'critical',
          message: `${sc.sc_number} is ${sc.age_days} days old — past the ${SHADE_CARD_LIFE_DAYS}-day life` });
      else if (sc.age_days != null && sc.age_days >= SHADE_CARD_LIFE_DAYS - 30)
        alerts.push({ ...ref, kind: 'expiring', severity: 'warn',
          message: `${sc.sc_number} expires in ${SHADE_CARD_LIFE_DAYS - sc.age_days} days` });
      // Long-pending return: the card has been out of the store for over a week.
      if (sc.open_issue_id && sc.issued_at) {
        const outDays = Math.floor((Date.now() - Date.parse(sc.issued_at)) / 86400000);
        if (outDays >= 7)
          alerts.push({ ...ref, kind: 'return_overdue', severity: outDays >= 21 ? 'critical' : 'warn',
            message: `${sc.sc_number} has been with ${sc.issued_to} (${sc.department}) for ${outDays} days — chase the return` });
      }
      // Code drift: the card was approved against codes the master no longer
      // carries. This is the warn-not-block check.
      for (const m of sc.code_mismatches || [])
        alerts.push({ ...ref, kind: 'code_mismatch', severity: 'warn',
          message: `${sc.sc_number}: ${m.field} on the card is ${m.card}, the product master now carries ${m.order}` });
    }
```

Then delete the separate `drift` query and its loop below — `code_mismatches` from `decorate` replaces the artwork half of it. Keep the `master_touched_at` half by folding it into the same query as before, or drop it: the code comparison is the actionable version of the same signal. **Keep it**, unchanged, so no existing alarm disappears.

- [ ] **Step 2: Remap the reports handler**

In `r.get('/shade-cards/reports')`, replace the bucket definitions:

```js
    const pendingCustomer = rows.filter(x => x.status === 'sent');
    const overdue = pendingCustomer.filter(x => x.expected_approval_date && x.expected_approval_date < today);
    const approved = rows.filter(x => x.status === 'approved' && !x.expired_by_age);
    const expired = rows.filter(x => x.expired_by_age);
    const withPrinting = rows.filter(x => x.with_printing);
```

Delete the `pendingInternal` bucket and the `revisions` query entirely, and remove `pending_internal` and `revision_history` from the response. Add `with_printing: withPrinting` and `with_printing: withPrinting.length` to the KPI block. Keep `tat_by_customer` and `awaiting_production` — those are the two reports worth keeping.

**`awaiting_production` needs its data source restored first.** Task 3 replaced `CARD_VIEW` and, in doing so, dropped the LATERAL join that supplied `planning_status`. The bucket still filters on `x.planning_status`, so as of Task 3 it matches nothing and that report is silently, permanently empty — no error, just a table that always says "Nothing approved is waiting on production". Add the join back to `CARD_VIEW`:

```sql
  LEFT JOIN LATERAL (SELECT ol2.status FROM order_lines ol2
                     WHERE ol2.product_id = sc.product_id
                     ORDER BY ol2.id DESC LIMIT 1) pl ON true
```

and add `pl.status AS planning_status` to the select list. It is aliased `ol2` because `ol` is now taken by the card's own `order_line_id` join.

Deliberately NOT reusing the card's own `line_status`: that is NULL for all 599 legacy cards, which have no `order_line_id`. The old join answered "the newest order line for this product", which is what the report means by "waiting on production", and those legacy cards are exactly the ones a plant would want listed.

- [ ] **Step 3: Verify no handler still references a deleted field**

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && grep -n "internal_approved\|internal_review\|customer_reviewing\|revision_requested\|customer_approved\|dock_zone\|superseded\|approval_requirement\|productionEligibility\|effectiveRequirement\|approvalClass\|shade_card_revisions" server/src/routes/shadecards.js
```

Expected: **no output**. The only permitted hits are `sent_to_customer_date` and `approval_received_date`, which are column names that survive. If anything else matches, that code path is still on the old model.

- [ ] **Step 4: Commit**

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && git add server/src/routes/shadecards.js && git commit -m "feat(shade): every alarm kept, plus the long-pending return the plant asked for

Alerts now fire on the four statuses. Code drift becomes a per-field mismatch
message naming both values, which is the warn-not-block check: with only 5 of
1594 products carrying an output code, a hard gate here would refuse nearly
every job.

Reports keeps turnaround-by-customer and awaiting-production. Revision history
goes with revisions."
```

---

## Task 8: The readiness traffic light

**Files:**
- Modify: `server/src/readiness-light.js`
- Modify: `server/src/readiness-light.test.js`

- [ ] **Step 1: Update the failing test first**

In `server/src/readiness-light.test.js`, every shade fixture currently looks like `{ eligible: false, hard: true, reason: '…' }`. The `hard` flag is gone. Replace each with `{ eligible: false, reason: '…' }` and confirm the expectations still read: an ineligible shade is `blocked`, an eligible one is `ok`, and `shade: null` is `na`.

Add one test that pins the intent:

```js
test('shade: an unapproved card still paints the light red, not amber', () => {
  const v = readinessLight({
    gates: { artwork: 1, material: true, tooling_detail: [] },
    cuttingStatus: 'completed', machineId: 3, finalisedAt: '2026-07-01',
    shade: { eligible: false, reason: 'Shade card CI-SC-0001 is Sent to Customer — the customer must approve it before printing' },
  });
  assert.equal(v.light, 'red');
  assert.ok(v.blockers.some(b => /must approve it before printing/.test(b)));
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && node --test server/src/readiness-light.test.js 2>&1 | tail -20
```

Expected: FAIL — the import of `effectiveRequirement` / `productionEligibility` from `shade-flow.js` is now `undefined`.

- [ ] **Step 3: Update the implementation**

In `server/src/readiness-light.js`, change the import:

```js
import { printingEligibility } from './shade-flow.js';
```

Replace `shadeState`:

```js
// Shade is one of the three checks the ERP genuinely refuses on, so an
// unapproved or expired card is 'blocked' and the dot goes red. There is no
// soft shade state any more: internal approval is gone, so every shade block
// is a real refusal.
function shadeState(shade) {
  if (!shade) return ['na', 'no shade card registered'];
  if (shade.eligible) return ['ok', null];
  return ['blocked', shade.reason || 'shade card not approved'];
}
```

In `lightForJobCards`, replace the shade query and the map that follows it:

```js
  // The newest live card per product. No requirement columns to join any more —
  // the gate is one rule, so the verdict needs nothing but the card.
  const shade = productIds.length ? await oc(`
    SELECT COALESCE(json_agg(sc), '[]'::json) AS list FROM (
      SELECT DISTINCT ON (s.product_id) s.product_id, s.sc_number, s.status,
             s.creation_date, s.active
      FROM shade_cards s
      WHERE s.product_id = ANY($1) AND s.active = 1
      ORDER BY s.product_id, s.id DESC
    ) sc`, [productIds]) : null;
```

`s.active` is selected even though the WHERE clause already guarantees it is 1.
`printingEligibility` checks it, and a row that omits the column would make the
verdict depend on a field that isn't there. Selecting it keeps the function's
input complete rather than relying on the filter to imply the value.

```js
  const shadeByProduct = new Map();
  for (const card of shade?.list ?? []) {
    shadeByProduct.set(+card.product_id, printingEligibility(card));
  }
```

The old query filtered `status NOT IN ('superseded','archived')`. Those statuses no longer exist, and cards that held them were set `active = 0` by the migration, so `active = 1` covers the same ground.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && node --test server/src/readiness-light.test.js
```

Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && git add server/src/readiness-light.js server/src/readiness-light.test.js && git commit -m "refactor(readiness): the shade row has no soft state left

With internal approval removed, every shade block is a real refusal, so the
verdict no longer carries a hard flag and the batch query no longer joins two
requirement columns to decide what the block means."
```

---

## Task 9: The printing gate and auto-return

**Files:**
- Modify: `server/src/routes/production.js` (the shade gate around line 510, and the auto-return around line 1265)

- [ ] **Step 1: Replace the printing gate**

Replace the whole `if (st.stage === 'printing') { … }` shade block:

```js
      // Shade-card control. ONE rule: the customer has approved and the
      // approval is in date. A product with no card registered is not gated.
      //
      // Separately, an artwork/output code MISMATCH is a soft alarm the
      // supervisor acknowledges — not a block. Only 5 of 1594 products carry an
      // output code, so a hard gate here would refuse nearly every job; what it
      // catches is a master edited after the customer signed.
      if (st.stage === 'printing') {
        const card = await oc(`
          SELECT sc.*, p.party_artwork_code AS product_artwork_code,
                 p.output_number AS product_output_number
          FROM shade_cards sc
          JOIN products p ON p.id = sc.product_id
          WHERE sc.product_id=$1 AND sc.active=1
          ORDER BY sc.id DESC LIMIT 1`, [jc.product_id]);
        if (card) {
          const gate = printingEligibility(card);
          if (!gate.eligible) throw Object.assign(new Error(gate.reason), { status: 409 });
          const match = codeMatch(card, {
            party_artwork_code: card.product_artwork_code,
            output_number: card.product_output_number,
          });
          if (!match.ok) {
            if (!req.body.ack_shade) {
              const detail = match.mismatches
                .map(m => `${m.field}: card ${m.card} vs master ${m.order}`).join('; ');
              const e = new Error(`Shade card ${card.sc_number} does not match the product master — ${detail}`);
              e.status = 409;
              e.body = {
                code: 'SHADE_CARD_NOT_ELIGIBLE',
                shade: { id: card.id, sc_number: card.sc_number, status: card.status,
                         mismatches: match.mismatches, reason: e.message },
              };
              throw e;
            }
            await audit('shade_card', card.id, 'ack_code_mismatch',
              `${card.sc_number}: printing started on ${jc.jc_number} with a code mismatch — acknowledged`,
              qc, req.user.name);
          }
        }
      }
```

Update the import at the top of `production.js`:

```js
import { printingEligibility, codeMatch } from '../shade-flow.js';
```

The structured-409 keeps its `SHADE_CARD_NOT_ELIGIBLE` code so `Section.jsx` needs no wiring change — only new message text, in Task 15.

- [ ] **Step 2: Replace the auto-return on printing complete**

Replace the shade block inside the printing-complete handler:

```js
      // Auto-return: close any OPEN custody row raised against this job card.
      // Printing finishing IS step 7 — the card comes back without anyone
      // remembering to mark it.
      const returned = await qc(`
        UPDATE shade_card_issues SET returned_at=now(), returned_by=$2,
               received_by=$2, condition='good',
               remarks=COALESCE(remarks, 'Auto-returned when printing completed')
        WHERE job_card_id=$1 AND returned_at IS NULL
        RETURNING id, shade_card_id, issued_to`, [jc.id, req.user.name]);
      for (const row of returned) {
        await qc(`INSERT INTO shade_card_events (shade_card_id, action, note, user_name)
                  VALUES ($1,'returned',$2,$3)`,
          [row.shade_card_id, `auto-returned from ${row.issued_to} — ${jc.jc_number} printing complete`, req.user.name]);
        await qc('UPDATE shade_cards SET updated_at=now() WHERE id=$1', [row.shade_card_id]);
        await audit('shade_card', row.shade_card_id, 'returned',
          `Auto-returned when ${jc.jc_number} finished printing`, qc, req.user.name);
      }
```

- [ ] **Step 3: Confirm no old shade logic survives in production.js**

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && grep -n "dock_zone\|effectiveRequirement\|productionEligibility\|shade_approval_requirement\|return-to-vault" server/src/routes/production.js
```

Expected: no output.

- [ ] **Step 4: Run the whole server suite — it must be green again**

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && npm test -w server 2>&1 | tail -20
```

Expected: PASS across all suites. This is the point where the red state from Task 1 Step 5 clears. If anything still fails, it is a consumer not yet updated — note it and finish it here rather than carrying red into the client work.

- [ ] **Step 5: Commit**

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && git add server/src/routes/production.js && git commit -m "feat(production): one shade rule to start printing, and a code mismatch to acknowledge

The gate is now: the customer approved, and the approval is in date. The
structured-409 the floor already knows how to acknowledge is repurposed from
'internal approval pending' to 'this card does not match the product master',
which is the failure that actually reaches a press.

Printing complete closes the open custody row, so step 7 needs nobody to
remember it."
```

---

## Task 10: The expiry engine helper

**Files:**
- Modify: `server/src/helpers.js` (`shadeCardsFor`, lines 537–567)

- [ ] **Step 1: Update the status filter and keep the master fallback**

```js
  const rows = await qf(`
    SELECT DISTINCT ON (product_id) product_id, sc_number AS code, title,
           creation_date, approval_received_date AS approval_date,
           status, approval_method, id AS shade_card_id
    FROM shade_cards
    WHERE active=1 AND product_id = ANY($1)
    ORDER BY product_id, id DESC`, [ids]);
```

`revision_no` leaves the select list because nothing consumes it any more, and the `status NOT IN ('superseded','archived')` filter goes because those statuses no longer exist — the migration set `active = 0` on the rows that held them.

The `masters` fallback query stays exactly as it is. `products.shade_card_number/date` is now a derived cache rather than a rival source, so the fallback only ever fires for a product whose card was retired — and returning the retired number there is the honest answer, not a stale one.

- [ ] **Step 2: Confirm nothing else in helpers.js is on the old model**

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && grep -n "revision_requested\|'expired'\|dock_zone\|superseded" server/src/helpers.js
```

Expected: one hit at the `readiness()` shade entry, which is Step 3.

- [ ] **Step 3: Update the `readiness()` shade entry**

Replace the `shadeBad` computation and the entry that follows it:

```js
  const shadeBad = shade && (shade.status !== 'approved' || isExpiredByAge(shade));
  detail.push({
    family: 'shade_card', label: 'Shade Card', hard: false,
    status: !shade ? 'missing' : shadeBad ? 'not_ready' : 'ready',
    tool_id: null, code: shade?.sc_number ?? null, zone: shade?.status ?? null,
    condition: null,
  });
```

Add `isExpiredByAge` to the `shade-flow.js` import in `helpers.js`, and update the inline query a few lines above it to drop `revision_no`:

```js
    SELECT sc_number, status, creation_date FROM shade_cards
```

`condition` was `Rev ${shade.revision_no}` and now has nothing to say, so it is null rather than a string reading "Rev 0" on every card.

`hard: false` is unchanged and deliberate: the tooling *gate* decides whether planning nags, while the readiness *light* decides whether an operator is told to stop. Task 8 is where shade is hard.

- [ ] **Step 4: Run the suite and commit**

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && npm test -w server && git add server/src/helpers.js && git commit -m "refactor(helpers): shade lookups drop the statuses that no longer exist

products.shade_card_number is now a derived cache, so the master fallback only
fires for a product whose card was retired — where returning the retired number
is the honest answer rather than a rival source of truth."
```

---

## Task 11: The register — eight tiles that filter one table

**Files:**
- Create: `client/src/pages/shade-cards/lifecycle.js`
- Rewrite: `client/src/pages/ShadeCards.jsx`

- [ ] **Step 1: Create the shared presentation module**

`client/src/pages/shade-cards/lifecycle.js` — one place the drawer, form and register all read status presentation from, so a label can never drift between them:

```js
// Client mirror of server/src/shade-flow.js presentation. The transition map is
// duplicated deliberately: the server is the authority and refuses bad moves,
// but the UI needs to know which button to light before asking.
export const STATUS_META = {
  draft:    { label: 'Draft',            cls: 'bg-slate-100 text-slate-600' },
  sent:     { label: 'Sent to Customer', cls: 'bg-violet-50 text-violet-700' },
  approved: { label: 'Approved',         cls: 'bg-emerald-50 text-emerald-700' },
  rejected: { label: 'Rejected',         cls: 'bg-red-50 text-red-700' },
};

export const scLabel = s => STATUS_META[s]?.label ?? '—';

// The seven steps of the real process, as the drawer's progress rail. Steps 5-7
// repeat per job, which is why they read from the custody log rather than status.
export const STEPS = [
  { key: 'created',  label: 'Created' },
  { key: 'sent',     label: 'Sent to customer' },
  { key: 'approved', label: 'Customer approved' },
  { key: 'recorded', label: 'Received back' },
  { key: 'issued',   label: 'Issued to printing' },
  { key: 'running',  label: 'In use at press' },
  { key: 'returned', label: 'Returned' },
];

// Which step the card is standing on right now.
export function stepIndex(card) {
  if (!card) return 0;
  if (card.with_printing) return 5;
  if (card.status === 'approved') return card.issue_count > 0 ? 6 : 4;
  if (card.status === 'sent') return 1;
  if (card.status === 'rejected') return 1;
  return 0;
}

// The ONE action available now. Never a row of six buttons to choose between.
export function nextAction(card) {
  if (!card || card.active !== 1) return null;
  if (card.with_printing) return { key: 'return', label: 'Record Return', variant: 'success' };
  if (card.status === 'draft') return { key: 'sent', label: 'Dispatch to Customer', variant: 'primary' };
  if (card.status === 'sent') return { key: 'approved', label: 'Record Approval', variant: 'success' };
  if (card.status === 'rejected') return { key: 'sent', label: 'Send Corrected Card', variant: 'primary' };
  if (card.status === 'approved')
    return card.expired_by_age
      ? { key: 'sent', label: 'Renew — Send Again', variant: 'primary' }
      : { key: 'issue', label: 'Issue to Printing', variant: 'primary' };
  return null;
}

export const today = () => new Date().toISOString().slice(0, 10);
```

`nextAction` is the single most important function in the client. Every "which button do I press" question the module used to raise is answered here, once.

- [ ] **Step 2: Rewrite `ShadeCards.jsx` as the register**

Replace the entire file:

```jsx
// Shade Cards — the register. Eight dashboard tiles, each of which IS a filter,
// over one table. The 6 tabs and the separate Alerts sub-view are gone: an
// alarm is now one click from the rows causing it.
import { useEffect, useMemo, useState } from 'react';
import { api, fmt, auth } from '../api.js';
import {
  Button, KpiCard, PageHeader, rowMatches, DataTable, SubTabs, useToast,
} from '../components/ui.jsx';
import { threadColumn, unreadRowClass } from '../components/ThreadCell.jsx';
import {
  Plus, SwatchBook, Send, BadgeCheck, AlertTriangle, Printer, FileClock,
  Clock4, PackageCheck, Archive, ArrowRight,
} from 'lucide-react';
import { STATUS_META, scLabel, today } from './shade-cards/lifecycle.js';
import ShadeCardDrawer from './shade-cards/ShadeCardDrawer.jsx';
import ShadeCardForm from './shade-cards/ShadeCardForm.jsx';
import RetireZone from './shade-cards/RetireZone.jsx';

const THREAD_CHUNK = 200;
const threadSummary = (entity, ids) => {
  const calls = [];
  for (let i = 0; i < ids.length; i += THREAD_CHUNK) {
    calls.push(api.get(`/threads/summary?entity=${entity}&ids=${ids.slice(i, i + THREAD_CHUNK).join(',')}`));
  }
  return Promise.all(calls).then(parts => Object.assign({}, ...parts));
};

const canManage = () => ['admin', 'planner', 'qc'].includes(auth.user?.role);

function ScStatus({ status }) {
  const m = STATUS_META[status] || { label: '—', cls: 'bg-slate-100 text-slate-600' };
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${m.cls}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />{m.label}
    </span>
  );
}

// The eight tiles, in the order the plant reads them. `filter` is what makes a
// tile a control rather than a decoration; a null filter is a pure counter.
const TILES = [
  { key: 'all',       label: 'Total',            icon: SwatchBook,   filter: () => true },
  { key: 'pending',   label: 'Pending Approval',  icon: Send,         chip: 'bg-violet-50 text-violet-600',
    filter: r => r.status === 'sent' },
  { key: 'approved',  label: 'Approved',          icon: BadgeCheck,   chip: 'bg-emerald-50 text-emerald-600',
    filter: r => r.status === 'approved' && !r.expired_by_age },
  { key: 'issues',    label: 'Issued to Printing', icon: Printer,     chip: 'bg-blue-50 text-blue-600',
    filter: null },
  { key: 'with',      label: 'With Printing',     icon: Printer,      chip: 'bg-blue-50 text-blue-600',
    filter: r => r.with_printing },
  { key: 'returned',  label: 'Returned',          icon: PackageCheck, chip: 'bg-teal-50 text-teal-600',
    filter: r => !r.with_printing && r.issue_count > 0 },
  { key: 'overdue',   label: 'Overdue',           icon: Clock4,       chip: 'bg-red-50 text-red-600',
    filter: r => r.status === 'sent' && r.expected_approval_date && r.expected_approval_date < today() },
  { key: 'aged',      label: 'Age Alerts',        icon: FileClock,    chip: 'bg-orange-50 text-orange-600',
    filter: r => r.expired_by_age || (r.age_days != null && r.age_days >= 335) },
];

export default function ShadeCards() {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [loadError, setLoadError] = useState(false);
  const [meta, setMeta] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [reports, setReports] = useState(null);
  const [view, setView] = useState('register');
  const [tile, setTile] = useState('all');
  const [creating, setCreating] = useState(false);
  const [detailId, setDetailId] = useState(null);
  const [threads, setThreads] = useState({});

  // A dead backend must never read as "no shade cards" — the page owns showing
  // the outage, and last-good rows survive a transient blip.
  const load = () => Promise.all([
    api.get('/shade-cards?all=1').then(rs => {
      setRows(rs);
      threadSummary('shade_card', rs.map(r => r.id)).then(setThreads).catch(() => {});
    }),
    api.get('/shade-cards/alerts').then(setAlerts),
  ]).then(() => setLoadError(false)).catch(() => setLoadError(true));

  useEffect(() => {
    load();
    api.get('/shade-cards/meta').then(setMeta).catch(() => {});
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (view === 'reports') api.get('/shade-cards/reports').then(setReports).catch(() => {});
  }, [view, rows]);

  const active = useMemo(() => rows.filter(r => r.active), [rows]);
  const counts = useMemo(() => {
    const out = {};
    for (const t of TILES) {
      out[t.key] = t.key === 'issues'
        ? active.reduce((n, r) => n + (r.issue_count || 0), 0)
        : active.filter(t.filter).length;
    }
    return out;
  }, [active]);

  const tileDef = TILES.find(t => t.key === tile) || TILES[0];
  const visible = useMemo(
    () => active.filter(tileDef.filter || (() => true)),
    [active, tileDef]);

  const critical = alerts.filter(a => a.severity === 'critical');

  const columns = [
    { key: 'sc_number', label: 'Card No', render: r => (
        <span className="font-semibold text-slate-900">{r.sc_number}</span>),
      searchValue: r => r.sc_number },
    { key: 'po_number', label: 'Sales Order', render: r => r.po_number
        ? <span className="font-medium text-brand-600">{r.po_number}</span>
        : <span className="text-slate-300">—</span>,
      searchValue: r => `${r.po_number || ''} ${(r.orders || []).map(o => o.po_number).join(' ')}` },
    { key: 'customer_name', label: 'Customer', render: r => r.customer_name || '—' },
    { key: 'product_name', label: 'Product', render: r => (
        <span>{r.product_name || '—'}{r.product_code && <span className="ml-1 text-slate-400">{r.product_code}</span>}</span>),
      export: r => `${r.product_name || ''} ${r.product_code || ''}`.trim() || '—' },
    { key: 'artwork_no', label: 'AW / Output', render: r => (
        <span className={`whitespace-nowrap text-xs ${r.code_ok ? '' : 'font-bold text-red-600'}`}>
          {r.artwork_no || '—'}<span className="text-slate-300"> / </span>{r.output_no || '—'}
          {!r.code_ok && <AlertTriangle size={11} className="ml-1 inline" />}
        </span>),
      export: r => `${r.artwork_no || '—'} / ${r.output_no || '—'}`,
      searchValue: r => `${r.artwork_no || ''} ${r.output_no || ''}` },
    { key: 'status', label: 'Status', render: r => <ScStatus status={r.status} />,
      export: r => scLabel(r.status), sortValue: r => r.status },
    { key: 'holder', label: 'Held by', sortValue: r => r.issued_to || '',
      render: r => r.with_printing
        ? <span className="whitespace-nowrap text-xs font-semibold text-blue-700">
            {r.issued_to} <span className="font-normal text-slate-400">· {fmt.title(r.department)}</span></span>
        : <span className="text-xs text-slate-400">In store</span>,
      export: r => r.with_printing ? `${r.issued_to} (${r.department})` : 'In store',
      searchValue: r => r.with_printing ? `${r.issued_to} ${r.department}` : 'in store' },
    { key: 'sent_to_customer_date', label: 'Sent → Approved',
      sortValue: r => r.sent_to_customer_date || '',
      render: r => (
        <span className="whitespace-nowrap text-xs">
          {r.sent_to_customer_date ? fmt.date(r.sent_to_customer_date) : '—'}
          <ArrowRight size={11} className="mx-1 inline text-slate-300" />
          {r.approval_received_date
            ? <span className="font-semibold text-emerald-700">{fmt.date(r.approval_received_date)}</span>
            : r.expected_approval_date
              ? <span className={r.expected_approval_date < today() ? 'font-semibold text-red-600' : 'text-slate-500'}>
                  exp. {fmt.date(r.expected_approval_date)}</span>
              : '—'}
        </span>),
      export: r => `${r.sent_to_customer_date || '—'} → ${r.approval_received_date || '—'}` },
    { key: 'age_days', label: 'Age', align: 'right', sortValue: r => r.age_days ?? -1,
      render: r => r.age_days == null ? '—'
        : <span className={`font-semibold tabular-nums ${r.expired_by_age ? 'text-red-600' : r.age_days >= 335 ? 'text-amber-600' : 'text-slate-600'}`}>{r.age_days}d</span>,
      export: r => r.age_days != null ? `${r.age_days}d` : '—' },
    { key: 'updated_at', label: 'Updated', render: r => fmt.dt(r.updated_at) },
  ];

  return (
    <div className="space-y-5">
      <PageHeader title="Shade Cards"
        subtitle="Create · send to the customer · approve · issue to printing · return"
        actions={canManage() && (
          <Button onClick={() => setCreating(true)}><Plus size={14} /> New Shade Card</Button>)} />

      {loadError && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          <AlertTriangle size={16} className="shrink-0" />
          Couldn't reach the server — {rows.length ? 'showing the last data loaded' : 'the shade cards can’t load'}. Retrying every 20 seconds…
        </div>
      )}

      {/* The dashboard. Each tile filters the table below it. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
        {TILES.map(t => (
          <button key={t.key} onClick={() => { setTile(t.key); setView('register'); }}
            disabled={!t.filter}
            className={`text-left transition ${t.filter ? 'cursor-pointer' : 'cursor-default'} ${
              tile === t.key && t.filter ? 'ring-2 ring-brand-400 ring-offset-2 rounded-[22px]' : ''}`}>
            <KpiCard label={t.label} value={fmt.num(counts[t.key])} icon={t.icon}
              chip={t.chip} accent={counts[t.key] ? undefined : 'text-slate-400'} />
          </button>))}
      </div>

      {critical.length > 0 && (
        <div className="glass rounded-[22px] border border-red-200/60 bg-red-50/60 p-4">
          <p className="mb-1.5 flex items-center gap-2 text-sm font-extrabold text-red-700">
            <AlertTriangle size={15} /> {critical.length} shade card{critical.length > 1 ? 's' : ''} need attention now
          </p>
          <ul className="space-y-1">
            {critical.slice(0, 5).map((a, i) => (
              <li key={i} className="text-xs font-medium text-red-700/90">
                <button className="underline decoration-red-300 underline-offset-2"
                  onClick={() => setDetailId(a.id)}>{a.message}</button>
              </li>))}
            {critical.length > 5 && <li className="text-xs text-red-500">…and {critical.length - 5} more</li>}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <SubTabs active={view} onChange={setView} views={[
          { key: 'register', label: 'Register', icon: SwatchBook },
          { key: 'reports', label: 'Reports', icon: FileClock },
          { key: 'retired', label: 'Retired Numbers', icon: Archive },
        ]} />
        {view === 'register' && tile !== 'all' && (
          <button className="text-xs font-semibold text-brand-600 underline underline-offset-2"
            onClick={() => setTile('all')}>Showing {tileDef.label} — clear filter</button>)}
      </div>

      {view === 'register' && (
        <DataTable
          exportName="shade-cards" exportSubtitle="Shade Card register"
          exportMeta={() => [`Filter: ${tileDef.label}`]}
          rows={visible}
          columns={[...columns, threadColumn({ entity: 'shade_card', threads, idOf: r => r.id })]}
          rowClass={unreadRowClass(threads, r => r.id)}
          getRowId={r => r.id}
          searchable
          onRowClick={r => setDetailId(r.id)}
          defaultSort={{ key: 'updated_at', dir: 'desc' }}
          empty="No shade cards here — create one or clear the filter"
        />
      )}

      {view === 'reports' && <Reports reports={reports} />}
      {view === 'retired' && <RetireZone onChange={load} toast={toast} />}

      {creating && (
        <ShadeCardForm meta={meta} onClose={() => setCreating(false)} toast={toast}
          onCreated={async id => { setCreating(false); await load(); setDetailId(id); }} />)}

      {detailId && (
        <ShadeCardDrawer id={detailId} meta={meta} toast={toast}
          onClose={() => setDetailId(null)} onChange={load} />)}
    </div>
  );
}

function Reports({ reports }) {
  if (!reports) return <p className="text-sm text-slate-400">Loading reports…</p>;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard label="Avg approval turnaround"
          value={reports.kpis.avg_tat_days != null ? `${reports.kpis.avg_tat_days}d` : '—'} icon={Clock4} />
        <KpiCard label="Overdue approvals" value={fmt.num(reports.kpis.overdue)} icon={AlertTriangle}
          chip="bg-red-50 text-red-600" accent={reports.kpis.overdue ? 'text-red-600' : undefined} />
        <KpiCard label="With printing" value={fmt.num(reports.kpis.with_printing)} icon={Printer}
          chip="bg-blue-50 text-blue-600" />
        <KpiCard label="Expired" value={fmt.num(reports.kpis.expired)} icon={FileClock}
          chip="bg-orange-50 text-orange-600" accent={reports.kpis.expired ? 'text-orange-600' : undefined} />
      </div>
      <DataTable exportName="shade-card-tat-by-customer"
        exportSubtitle="Customer-wise approval performance"
        rows={reports.tat_by_customer} serialNumber
        columns={[
          { key: 'customer', label: 'Customer' },
          { key: 'approvals', label: 'Approvals', align: 'right' },
          { key: 'avg_days', label: 'Avg turnaround (days)', align: 'right',
            render: r => <span className={`font-bold ${r.avg_days > 14 ? 'text-red-600' : r.avg_days > 7 ? 'text-amber-600' : 'text-emerald-700'}`}>{r.avg_days}</span> },
        ]}
        empty="No completed approval cycles yet" />
      <DataTable exportName="shade-cards-awaiting-production"
        exportSubtitle="Approved cards whose jobs have not reached the floor"
        rows={reports.awaiting_production}
        columns={[
          { key: 'sc_number', label: 'Shade Card' },
          { key: 'customer_name', label: 'Customer', render: r => r.customer_name || '—' },
          { key: 'product_name', label: 'Product', render: r => r.product_name || '—' },
          { key: 'approval_received_date', label: 'Approved on', render: r => fmt.date(r.approval_received_date) },
        ]}
        empty="Nothing approved is waiting on production" />
    </div>
  );
}
```

- [ ] **Step 3: Verify in the real running app**

Start the dev server through the Browser pane preview tools, log in, resize to a desktop breakpoint, and navigate to `/shade-cards`. Read the page and take a screenshot.

Check: eight tiles render in one row at desktop width; clicking a tile rings it and filters the table; clicking it again via "clear filter" restores all rows; the three sub-tabs switch; no console errors.

- [ ] **Step 4: Commit**

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && git add client/src/pages/ShadeCards.jsx client/src/pages/shade-cards/lifecycle.js && git commit -m "feat(shade): eight tiles that filter one table, no tabs

The 6 register tabs and the Alerts sub-view are gone. A tile is a control, so an
alarm is one click from the rows causing it rather than a separate screen.

nextAction() in lifecycle.js answers 'which button do I press' once, for the
whole module — the question the old six-button drawer asked on every card."
```

---

## Task 12: The create form — one picker

**Files:**
- Create: `client/src/pages/shade-cards/ShadeCardForm.jsx`

- [ ] **Step 1: Write the component**

```jsx
// Creating a shade card is picking a sales order line. Everything the ERP
// already knows arrives read-only from /prefill; the operator types only the
// five things that exist nowhere else.
import { useEffect, useState } from 'react';
import { api, fmt } from '../../api.js';
import { Button, Field, Input, Modal, Select, Textarea, searchText } from '../../components/ui.jsx';
import { Plus, AlertTriangle } from 'lucide-react';
import { today } from './lifecycle.js';

const EMPTY = {
  title: '', colour_system: '', num_colours: '', print_process: '', artwork_rev: '',
  print_reference: '', colour_details: '', expected_approval_date: '',
  creation_date: today(), location: '', remarks: '',
};

export default function ShadeCardForm({ meta, onClose, onCreated, toast }) {
  const [lines, setLines] = useState([]);
  const [lineId, setLineId] = useState('');
  const [pre, setPre] = useState(null);
  const [form, setForm] = useState({ ...EMPTY });
  const [busy, setBusy] = useState(false);

  // Every open order line, flattened, so one Select covers "which job is this
  // card for". Cancelled and dispatched lines are excluded — a shade card for
  // work that has shipped is not a thing anyone needs.
  useEffect(() => {
    api.get('/orders').then(os => {
      const out = [];
      for (const o of os) {
        for (const l of o.lines || []) {
          if (['cancelled', 'dispatched'].includes(l.status)) continue;
          out.push({ id: l.id, po_number: o.po_number, customer_name: o.customer_name,
                     product_name: l.product_name, product_code: l.product_code, qty: l.qty });
        }
      }
      setLines(out);
    }).catch(() => toast.error('Could not load sales orders'));
  }, []);

  useEffect(() => {
    if (!lineId) { setPre(null); return; }
    api.get(`/shade-cards/prefill/${lineId}`).then(p => {
      setPre(p);
      setForm(f => ({ ...f,
        title: f.title || p.suggested_title,
        colour_system: f.colour_system || p.colour_system || '',
        num_colours: f.num_colours || (p.num_colours ?? ''),
      }));
    }).catch(() => toast.error('Could not read that sales order line'));
  }, [lineId]);

  const create = async () => {
    setBusy(true);
    try {
      const card = await api.post('/shade-cards', {
        order_line_id: +lineId, ...form,
        num_colours: form.num_colours ? +form.num_colours : null,
      });
      toast.success(`${card.sc_number} created`);
      await onCreated(card.id);
    } catch (e) {
      toast.error(e.message || 'Could not create the shade card');
    } finally { setBusy(false); }
  };

  const Row = ({ label, value }) => (
    <div className="flex justify-between gap-3 py-1">
      <dt className="shrink-0 text-slate-400">{label}</dt>
      <dd className="text-right font-semibold text-slate-800">{value || '—'}</dd>
    </div>
  );

  return (
    <Modal open onClose={onClose} title="New Shade Card" wide
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button disabled={!lineId || !form.title.trim() || busy} onClick={create}>
          <Plus size={14} /> Create
        </Button>
      </>}>
      <div className="space-y-3">
        <section className="ci-form-panel">
          <div className="ci-form-panel-title">Which order is this card for?</div>
          <Field label="Sales order line" required>
            <Select value={lineId} onChange={e => setLineId(e.target.value)}>
              <option value="">Select a sales order…</option>
              {lines.map(l => (
                <option key={l.id} value={l.id} data-search={searchText(l)}>
                  {l.po_number} — {l.customer_name} · {l.product_name} ({fmt.num(l.qty)})
                </option>))}
            </Select>
          </Field>
        </section>

        {pre && (
          <section className="ci-summary-panel p-4">
            <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-500">
              From the sales order — nothing to type
            </div>
            <dl className="grid gap-x-6 text-sm sm:grid-cols-2">
              <Row label="Sales order" value={pre.po_number} />
              <Row label="Customer" value={pre.customer_name} />
              <Row label="Product" value={pre.product_name && `${pre.product_name} · ${pre.product_code}`} />
              <Row label="Order quantity" value={pre.order_qty != null && fmt.num(pre.order_qty)} />
              <Row label="Artwork code (AW)" value={pre.artwork_no} />
              <Row label="Output code" value={pre.output_no} />
              <Row label="Board" value={pre.board} />
              <Row label="Printing specs" value={pre.print_specs} />
            </dl>
            {!pre.output_no && (
              <p className="mt-2 flex items-start gap-1.5 text-xs font-medium text-amber-700">
                <AlertTriangle size={13} className="mt-px shrink-0" />
                This product has no Output Code in the master, so the card cannot be
                checked against one. Add it on the Product Master when you know it.
              </p>)}
          </section>
        )}

        <section className="ci-form-panel">
          <div className="ci-form-panel-title">What only you know</div>
          <div className="ci-form-grid">
            <Field label="Shade card name" required className="sm:col-span-2">
              <Input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} />
            </Field>
            <Field label="Colour system">
              <Select value={form.colour_system} onChange={e => setForm({ ...form, colour_system: e.target.value })}>
                <option value="">Select…</option>
                <option value="CMYK">CMYK</option>
                <option value="Pantone">Pantone</option>
                <option value="CMYK + Pantone">Hybrid (CMYK + Pantone)</option>
              </Select>
            </Field>
            <Field label="Number of colours">
              <Input type="number" min="1" value={form.num_colours}
                onChange={e => setForm({ ...form, num_colours: e.target.value })} />
            </Field>
            <Field label="Print process">
              <Select value={form.print_process} onChange={e => setForm({ ...form, print_process: e.target.value })}>
                <option value="">Select…</option>
                {['Offset', 'UV Offset', 'Digital', 'Flexo', 'Gravure', 'Screen'].map(x =>
                  <option key={x} value={x}>{x}</option>)}
              </Select>
            </Field>
            {/* Typed, not inherited: the ERP has no artwork revision column
                anywhere, so there is nothing to auto-populate this from. */}
            <Field label="Artwork revision" hint="No source in the ERP yet — type it if the customer quoted one">
              <Input value={form.artwork_rev} onChange={e => setForm({ ...form, artwork_rev: e.target.value })} />
            </Field>
            <Field label="Expected approval by" hint="Drives the Overdue tile">
              <Input type="date" value={form.expected_approval_date}
                onChange={e => setForm({ ...form, expected_approval_date: e.target.value })} />
            </Field>
            <Field label="Card made on" hint="Starts the 365-day age clock">
              <Input type="date" value={form.creation_date}
                onChange={e => setForm({ ...form, creation_date: e.target.value })} />
            </Field>
            <Field label="Print reference" hint="Pantone refs / press notes carried onto the Job Card">
              <Input value={form.print_reference}
                onChange={e => setForm({ ...form, print_reference: e.target.value })} />
            </Field>
            <Field label="Physical location">
              <Input value={form.location} placeholder="QC Cabinet…"
                onChange={e => setForm({ ...form, location: e.target.value })} />
            </Field>
            <Field label="Colour details" className="sm:col-span-2">
              <Textarea value={form.colour_details}
                onChange={e => setForm({ ...form, colour_details: e.target.value })} />
            </Field>
            <Field label="Remarks" className="sm:col-span-2">
              <Textarea value={form.remarks} onChange={e => setForm({ ...form, remarks: e.target.value })} />
            </Field>
          </div>
        </section>
      </div>
    </Modal>
  );
}
```

The "no Output Code in the master" warning matters: with only 5 of 1594 products carrying one, most cards will be created without it, and the operator should learn *why* the check will be quiet rather than assume it is protecting them.

- [ ] **Step 2: Verify in the real app**

Open `/shade-cards`, click **New Shade Card**, pick a sales order line. Confirm the "From the sales order" panel fills in immediately, the amber output-code note appears for a product without one, and creating opens the new card's drawer.

- [ ] **Step 3: Commit**

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && git add client/src/pages/shade-cards/ShadeCardForm.jsx && git commit -m "feat(shade): the create form is one sales-order picker

Customer, product, description, order quantity, artwork code, output code,
board and print specs arrive read-only. Seventeen inputs across three panels
become one picker plus the handful of facts that exist nowhere else.

Artwork revision stays typed and says so in its hint — the ERP has no revision
column to inherit from, and a blank read-only row would read as a bug."
```

---

## Task 13: The drawer — a progress rail and one button

**Files:**
- Create: `client/src/pages/shade-cards/ShadeCardDrawer.jsx`

- [ ] **Step 1: Write the component**

```jsx
// The card, as the seven steps of the real process. Exactly ONE primary action
// is offered at a time — nextAction() decides which — so nobody has to work out
// which of six buttons applies to the card in front of them.
import { useEffect, useState } from 'react';
import { api, fmt, auth } from '../../api.js';
import {
  Button, Checkbox, ConfirmDialog, Field, Input, Modal, Select, Textarea,
} from '../../components/ui.jsx';
import {
  BadgeCheck, Send, Printer, PackageCheck, XCircle, Paperclip, Download, Trash2,
  History, AlertTriangle, CheckCircle2, Link2, Pencil,
} from 'lucide-react';
import { STATUS_META, scLabel, STEPS, stepIndex, nextAction, today } from './lifecycle.js';

const DOC_MAX_BYTES = 4 * 1024 * 1024;          // mirrors DOC_MAX_BYTES on the server
const mb = b => (b / 1024 / 1024).toFixed(1);
const DOC_TYPES = [
  { value: 'shade_card_pdf', label: 'Shade card PDF' },
  { value: 'signed_scan', label: 'Scanned signed copy' },
  { value: 'approval_email', label: 'Approval email' },
  { value: 'whatsapp', label: 'WhatsApp screenshot' },
  { value: 'artwork', label: 'High-res artwork' },
  { value: 'note', label: 'Note' },
  { value: 'other', label: 'Other' },
];
const canManage = () => ['admin', 'planner', 'qc'].includes(auth.user?.role);
const canMove = () => ['admin', 'planner', 'production', 'qc'].includes(auth.user?.role);

async function openDoc(doc) {
  const res = await fetch(`/api/shade-cards/docs/${doc.id}`, {
    headers: auth.token ? { Authorization: `Bearer ${auth.token}` } : {},
  });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export default function ShadeCardDrawer({ id, meta, onClose, onChange, toast }) {
  const [d, setD] = useState(null);
  const [action, setAction] = useState(null);      // { key, form }
  const [docForm, setDocForm] = useState({ file: null, doc_type: 'shade_card_pdf' });
  const [confirmDel, setConfirmDel] = useState(false);

  const reload = () => api.get(`/shade-cards/${id}`).then(setD).catch(() => toast.error('Could not load the card'));
  useEffect(() => { reload(); }, [id]);

  const run = async (fn, msg) => {
    try {
      await fn();
      if (msg) toast.success(msg);
      setAction(null);
      await reload();
      await onChange();
    } catch (e) { toast.error(e.message || 'That did not work'); }
  };

  if (!d) return <Modal open onClose={onClose} title="Loading…" wide><div /></Modal>;

  const step = stepIndex(d);
  const act = nextAction(d);

  const openAction = key => {
    const base = { note: '' };
    if (key === 'sent') Object.assign(base, {
      sent_to_customer_date: today(), expected_approval_date: d.expected_approval_date || '' });
    if (key === 'approved') Object.assign(base, {
      approval_method: '', approval_received_date: today(),
      approval_received_by: auth.user?.name || '', customer_stamp: true, customer_signature: true,
      customer_contact_name: '', customer_designation: '', customer_company: d.customer_name || '' });
    if (key === 'issue') Object.assign(base, {
      issued_to: '', department: 'printing', job_card_id: '', remarks: '' });
    if (key === 'return') Object.assign(base, {
      returned_by: d.issued_to || '', received_by: auth.user?.name || '',
      condition: 'good', remarks: '' });
    if (key === 'rejected') Object.assign(base, { note: '' });
    setAction({ key, form: base });
  };
  const setAf = patch => setAction(a => ({ ...a, form: { ...a.form, ...patch } }));

  const submit = () => {
    const { key, form } = action;
    if (key === 'issue') return run(() => api.post(`/shade-cards/${d.id}/issue`, {
      ...form, job_card_id: form.job_card_id || undefined }), `${d.sc_number} issued to ${form.issued_to}`);
    if (key === 'return') return run(() => api.post(`/shade-cards/${d.id}/return`, form),
      `${d.sc_number} back in store`);
    return run(() => api.post(`/shade-cards/${d.id}/status`, {
      to: key, ...form,
      customer_stamp: form.customer_stamp ? 1 : 0,
      customer_signature: form.customer_signature ? 1 : 0,
    }), `${d.sc_number} → ${scLabel(key)}`);
  };

  const valid = !action ? false
    : action.key === 'approved' ? !!action.form.approval_method
        && (action.form.approval_method !== 'verbal' || !!action.form.note?.trim())
    : action.key === 'rejected' ? !!action.form.note?.trim()
    : action.key === 'issue' ? !!action.form.issued_to?.trim()
    : true;

  const Row = ({ label, value }) => value ? (
    <div className="flex justify-between gap-3 py-0.5 text-sm">
      <dt className="shrink-0 text-slate-400">{label}</dt>
      <dd className="text-right font-semibold text-slate-800">{value}</dd>
    </div>) : null;

  return (
    <>
      <Modal open onClose={onClose} wide title={`${d.sc_number} — ${d.title}`}
        footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
        <div className="space-y-4">
          {/* The seven steps. Where the card stands, at a glance. */}
          <ol className="flex flex-wrap items-center gap-1.5">
            {STEPS.map((s, i) => (
              <li key={s.key} className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold ${
                i < step ? 'bg-emerald-50 text-emerald-700'
                  : i === step ? 'bg-brand-600 text-white'
                    : 'bg-slate-100 text-slate-400'}`}>
                <span className="tabular-nums opacity-60">{i + 1}</span>{s.label}
              </li>))}
          </ol>

          {/* One verdict line. Never both a green and a red badge at once. */}
          <div className={`rounded-2xl px-4 py-3 text-sm font-semibold ${
            d.printing_eligible ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
            {d.printing_eligible
              ? <><CheckCircle2 size={14} className="mr-1.5 inline" />Cleared for printing</>
              : <><AlertTriangle size={14} className="mr-1.5 inline" />{d.printing_block_reason}</>}
            {d.with_printing && (
              <span className="mt-0.5 block text-xs font-medium opacity-80">
                Currently with {d.issued_to} · {fmt.title(d.department)} since {fmt.dt(d.issued_at)}
              </span>)}
          </div>

          {/* The code-mismatch warning: loud, but never a block. */}
          {!d.code_ok && (
            <div className="rounded-2xl border-2 border-red-300 bg-red-50 px-4 py-3">
              <p className="flex items-center gap-2 text-sm font-extrabold text-red-700">
                <AlertTriangle size={15} /> This card does not match the product master
              </p>
              <ul className="mt-1 space-y-0.5">
                {d.code_mismatches.map((m, i) => (
                  <li key={i} className="text-xs font-semibold text-red-700/90">
                    {m.field}: card says <b>{m.card}</b>, master now says <b>{m.order}</b>
                  </li>))}
              </ul>
              <p className="mt-1.5 text-xs font-medium text-red-600/80">
                Printing can still start, but a supervisor has to acknowledge it and the
                acknowledgement is recorded against this card.
              </p>
            </div>)}

          {/* The one action. */}
          <div className="flex flex-wrap items-center gap-1.5">
            {act && (canManage() || (act.key === 'return' && canMove())) && (
              <Button variant={act.variant} onClick={() => openAction(act.key)}>
                {act.key === 'sent' && <Send size={14} />}
                {act.key === 'approved' && <BadgeCheck size={14} />}
                {act.key === 'issue' && <Printer size={14} />}
                {act.key === 'return' && <PackageCheck size={14} />}
                {act.label}
              </Button>)}
            {d.status === 'sent' && canManage() && (
              <Button size="sm" variant="danger" onClick={() => openAction('rejected')}>
                <XCircle size={13} /> Customer Rejected
              </Button>)}
            <span className="ml-auto" />
            {canManage() && d.active === 1 && (
              <Button size="sm" variant="danger" onClick={() => setConfirmDel(true)}>
                <Trash2 size={13} /> Delete
              </Button>)}
          </div>

          {/* Inherited, read-only. Typed nowhere. */}
          <div className="grid gap-3 sm:grid-cols-2">
            <section className="ci-form-panel">
              <div className="ci-form-panel-title">From the sales order</div>
              <dl>
                <Row label="Sales order" value={d.po_number} />
                <Row label="Customer" value={d.customer_name} />
                <Row label="Product" value={d.product_name && `${d.product_name} · ${d.product_code || ''}`} />
                <Row label="Order quantity" value={d.order_qty != null && fmt.num(d.order_qty)} />
                <Row label="Artwork code" value={d.artwork_no} />
                <Row label="Output code" value={d.output_no} />
                <Row label="Board" value={[d.board_name, d.gsm && `${d.gsm} GSM`].filter(Boolean).join(' · ')} />
                <Row label="Print specs" value={[d.product_colour_system, d.product_colours && `${d.product_colours} colours`, d.coating].filter(Boolean).join(' · ')} />
              </dl>
            </section>
            <section className="ci-form-panel">
              <div className="ci-form-panel-title">Approval</div>
              <dl>
                <Row label="Status" value={scLabel(d.status)} />
                <Row label="Sent on" value={d.sent_to_customer_date && fmt.date(d.sent_to_customer_date)} />
                <Row label="Expected by" value={d.expected_approval_date && fmt.date(d.expected_approval_date)} />
                <Row label="Approved on" value={d.approval_received_date && fmt.date(d.approval_received_date)} />
                <Row label="How" value={d.approval_method && fmt.title(d.approval_method)} />
                <Row label="Signed / stamped" value={d.status === 'approved'
                  ? `${d.customer_signature ? 'Signed' : 'Not signed'} · ${d.customer_stamp ? 'Stamped' : 'No stamp'}` : null} />
                <Row label="Approved by" value={d.customer_contact_name &&
                  `${d.customer_contact_name}${d.customer_designation ? `, ${d.customer_designation}` : ''}`} />
                <Row label="Age" value={d.age_days != null && `${d.age_days} days of 365`} />
                <Row label="Remarks" value={d.approval_remarks} />
              </dl>
            </section>
          </div>

          {/* Custody history — every hand-off the card has been through. */}
          <section className="ci-form-panel">
            <div className="ci-form-panel-title"><Printer size={13} className="mr-1 inline" />Issue &amp; return history</div>
            {(d.issues || []).length === 0
              ? <p className="text-sm text-slate-400">Never issued — the card is in store.</p>
              : <div className="space-y-2">
                  {d.issues.map(i => (
                    <div key={i.id} className={`rounded-xl px-3 py-2 text-sm ${i.returned_at ? 'bg-slate-50' : 'bg-blue-50'}`}>
                      <p className="font-semibold text-slate-800">
                        {i.issued_to} <span className="text-slate-400">· {fmt.title(i.department)}</span>
                        {!i.returned_at && <span className="ml-2 rounded-full bg-blue-600 px-2 py-0.5 text-[10px] font-bold text-white">OUT NOW</span>}
                      </p>
                      <p className="text-xs text-slate-500">
                        Issued {fmt.dt(i.issued_at)} by {i.issued_by || '—'}
                        {i.jc_number && <> · {i.jc_number}</>}{i.machine_name && <> · {i.machine_name}</>}
                      </p>
                      {i.returned_at && (
                        <p className="text-xs text-slate-500">
                          Returned {fmt.dt(i.returned_at)} by {i.returned_by || '—'}, received by {i.received_by || '—'}
                          {i.condition && <> · condition <b>{fmt.title(i.condition)}</b></>}
                          {i.remarks && <> · {i.remarks}</>}
                        </p>)}
                    </div>))}
                </div>}
          </section>

          {/* Documents */}
          <section className="ci-form-panel">
            <div className="ci-form-panel-title"><Paperclip size={13} className="mr-1 inline" />Documents</div>
            <div className="space-y-2">
              {(d.docs || []).map(doc => (
                <div key={doc.id} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 text-sm">
                  <span className="min-w-0">
                    <button className="block truncate font-semibold text-brand-600 hover:underline"
                      onClick={() => openDoc(doc)}>{doc.title || doc.file_name}</button>
                    <span className="text-xs text-slate-400">
                      {DOC_TYPES.find(t => t.value === doc.doc_type)?.label || fmt.title(doc.doc_type)}
                      {' · '}{doc.uploaded_by} · {fmt.dt(doc.created_at)}
                    </span>
                  </span>
                  <span className="flex shrink-0 gap-1">
                    <Button size="sm" variant="ghost" onClick={() => openDoc(doc)}><Download size={13} /></Button>
                    {canManage() && (
                      <Button size="sm" variant="ghost"
                        onClick={() => run(() => api.del(`/shade-cards/docs/${doc.id}`), 'Document removed')}>
                        <Trash2 size={13} /></Button>)}
                  </span>
                </div>))}
              {canManage() && (
                <div className="grid gap-2 rounded-xl border border-dashed border-slate-200 p-3 sm:grid-cols-[1fr_auto_auto]">
                  {/* Checked on pick, not on send: a 9 MB scan over plant wifi
                      would otherwise upload for a minute and be refused at the
                      Vercel edge with an error nobody can read. */}
                  <input type="file" className="text-xs" onChange={e => {
                    const file = e.target.files?.[0] || null;
                    if (file && file.size > DOC_MAX_BYTES) {
                      toast.error(`${file.name} is ${mb(file.size)} MB — documents are capped at 4 MB. Compress the scan and try again.`);
                      e.target.value = '';
                      return setDocForm(f => ({ ...f, file: null }));
                    }
                    setDocForm(f => ({ ...f, file }));
                  }} />
                  <div className="w-44">
                    <Select value={docForm.doc_type} options={DOC_TYPES}
                      onChange={e => setDocForm(f => ({ ...f, doc_type: e.target.value }))} />
                  </div>
                  <Button size="sm" disabled={!docForm.file}
                    onClick={() => run(() => api.upload(`/shade-cards/${d.id}/docs`, docForm.file,
                      { doc_type: docForm.doc_type }), 'Document attached')
                      .then(() => setDocForm({ file: null, doc_type: 'shade_card_pdf' }))}>
                    <Paperclip size={13} /> Attach</Button>
                </div>)}
            </div>
          </section>

          {/* Audit trail */}
          <section className="ci-form-panel">
            <div className="ci-form-panel-title"><History size={13} className="mr-1 inline" />Audit trail</div>
            <div className="max-h-64 space-y-0.5 overflow-y-auto pr-1">
              {(d.events || []).map(ev => (
                <div key={ev.id} className="flex items-baseline gap-2 border-l-2 border-slate-100 py-1 pl-3 text-xs">
                  <span className="shrink-0 font-semibold text-slate-700">
                    {fmt.title(ev.action.replace('tooling:', 'Hub: '))}</span>
                  {(ev.from_status || ev.to_status) && (
                    <span className="text-slate-500">{scLabel(ev.from_status)} → {scLabel(ev.to_status)}</span>)}
                  {ev.note && <span className="truncate text-slate-400">{ev.note}</span>}
                  <span className="ml-auto shrink-0 text-slate-300">{ev.user_name} · {fmt.dt(ev.at)}</span>
                </div>))}
            </div>
          </section>
        </div>
      </Modal>

      {/* The action sheet. One per step, only the fields that step needs. */}
      <Modal open={!!action} onClose={() => setAction(null)}
        title={action ? `${nextActionTitle(action.key)} — ${d.sc_number}` : ''}
        footer={action && <>
          <Button variant="secondary" onClick={() => setAction(null)}>Cancel</Button>
          <Button variant={action.key === 'rejected' ? 'danger' : 'primary'}
            disabled={!valid} onClick={submit}>Confirm</Button>
        </>}>
        {action?.key === 'sent' && (
          <div className="space-y-3">
            <Field label="Sent on" required>
              <Input type="date" value={action.form.sent_to_customer_date}
                onChange={e => setAf({ sent_to_customer_date: e.target.value })} />
            </Field>
            <Field label="Expected approval by" hint="Drives the Overdue tile and the overdue alarm">
              <Input type="date" value={action.form.expected_approval_date}
                onChange={e => setAf({ expected_approval_date: e.target.value })} />
            </Field>
            {d.status === 'approved' && (
              <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">
                Sending this card again clears its current approval — the customer has to
                approve it afresh, and the 365-day age clock restarts when they do.
              </p>)}
          </div>)}

        {action?.key === 'approved' && meta && (
          <div className="space-y-3">
            <Field label="How did the approval arrive?" required>
              <Select value={action.form.approval_method}
                options={[{ value: '', label: 'Select…' },
                  ...meta.approval_methods.map(m => ({ value: m.key, label: m.label }))]}
                onChange={e => setAf({ approval_method: e.target.value })} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Received on">
                <Input type="date" value={action.form.approval_received_date}
                  onChange={e => setAf({ approval_received_date: e.target.value })} />
              </Field>
              <Field label="Received by (our side)">
                <Input value={action.form.approval_received_by}
                  onChange={e => setAf({ approval_received_by: e.target.value })} />
              </Field>
            </div>
            <div className="flex gap-5">
              <Checkbox label="Customer signed it" checked={!!action.form.customer_signature}
                onChange={e => setAf({ customer_signature: e.target.checked })} />
              <Checkbox label="Customer stamped it" checked={!!action.form.customer_stamp}
                onChange={e => setAf({ customer_stamp: e.target.checked })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Who approved it">
                <Input value={action.form.customer_contact_name}
                  onChange={e => setAf({ customer_contact_name: e.target.value })} />
              </Field>
              <Field label="Their designation">
                <Input value={action.form.customer_designation}
                  onChange={e => setAf({ customer_designation: e.target.value })} />
              </Field>
            </div>
            <Field label={action.form.approval_method === 'verbal' ? 'Remarks (mandatory for a verbal approval)' : 'Remarks'}
              required={action.form.approval_method === 'verbal'}>
              <Textarea value={action.form.note} onChange={e => setAf({ note: e.target.value })} />
            </Field>
            <p className="rounded-xl bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700">
              The card's 365-day life will run from the date you record here.
            </p>
          </div>)}

        {action?.key === 'rejected' && (
          <Field label="What did the customer object to?" required>
            <Textarea value={action.form.note} onChange={e => setAf({ note: e.target.value })} />
          </Field>)}

        {action?.key === 'issue' && meta && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Issued to" required>
                <Input value={action.form.issued_to} placeholder="Name of the person taking it"
                  onChange={e => setAf({ issued_to: e.target.value })} />
              </Field>
              <Field label="Department" required>
                <Select value={action.form.department}
                  options={meta.departments.map(x => ({ value: x.key, label: x.label }))}
                  onChange={e => setAf({ department: e.target.value })} />
              </Field>
            </div>
            <Field label="Remarks">
              <Input value={action.form.remarks} onChange={e => setAf({ remarks: e.target.value })} />
            </Field>
            <p className="rounded-xl bg-blue-50 px-3 py-2 text-xs font-medium text-blue-700">
              Issued by {auth.user?.name} at the moment you confirm. If the card is attached
              to a print job it comes back automatically when that job finishes printing.
            </p>
          </div>)}

        {action?.key === 'return' && meta && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Returned by">
                <Input value={action.form.returned_by} onChange={e => setAf({ returned_by: e.target.value })} />
              </Field>
              <Field label="Received by">
                <Input value={action.form.received_by} onChange={e => setAf({ received_by: e.target.value })} />
              </Field>
            </div>
            <Field label="Condition" required>
              <Select value={action.form.condition}
                options={meta.return_conditions.map(x => ({ value: x.key, label: x.label }))}
                onChange={e => setAf({ condition: e.target.value })} />
            </Field>
            <Field label="Remarks">
              <Textarea value={action.form.remarks} onChange={e => setAf({ remarks: e.target.value })} />
            </Field>
          </div>)}
      </Modal>

      <ConfirmDialog open={confirmDel} onClose={() => setConfirmDel(false)} danger
        title={`Delete ${d.sc_number}?`}
        message="The card leaves the register but nothing is destroyed — its history and audit trail are kept."
        confirmLabel="Delete"
        onConfirm={() => run(() => api.del(`/shade-cards/${d.id}`), 'Shade card deleted')
          .then(() => { setConfirmDel(false); onClose(); })} />
    </>
  );
}

const nextActionTitle = key => ({
  sent: 'Dispatch to customer', approved: 'Record the customer approval',
  rejected: 'Record the rejection', issue: 'Issue to a department',
  return: 'Record the return',
}[key] || 'Update');
```

- [ ] **Step 2: Verify the whole lifecycle by clicking through the real app**

Open a draft card and walk it: **Dispatch to Customer** → the rail advances to step 2 and the button becomes **Record Approval** → approve → the rail reaches step 5 and the button becomes **Issue to Printing** → issue → the banner reads "Currently with …", the history shows an OUT NOW row, and the button becomes **Record Return** → return → the row closes with its condition.

At every point there must be exactly one primary button. Screenshot the drawer mid-lifecycle.

- [ ] **Step 3: Commit**

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && git add client/src/pages/shade-cards/ShadeCardDrawer.jsx && git commit -m "feat(shade): the drawer shows seven steps and offers one button

The rail is the process on the shop floor, so where a card stands is a glance
rather than a status word to decode. nextAction() lights exactly one primary
button, replacing a row of up to six the operator had to choose between.

The code-mismatch panel names both values and says plainly that printing can
still start with a recorded acknowledgement — a warning that hides what happens
next is not a warning."
```

---

## Task 14: The retire zone screen

**Files:**
- Create: `client/src/pages/shade-cards/RetireZone.jsx`

- [ ] **Step 1: Write the component**

```jsx
// The retire zone for the free-text shade card numbers that used to be typed on
// the product master. Three lists, because the three situations need different
// answers:
//   Orphans     a number with no card behind it → promote it into a real card
//   Duplicates  a number that just repeats its card → retire the column
//   Retired     already moved out → restorable, always
import { useEffect, useState } from 'react';
import { api, fmt } from '../../api.js';
import { Button, DataTable, Checkbox } from '../../components/ui.jsx';
import { Archive, RotateCcw, Wand2, AlertTriangle } from 'lucide-react';

export default function RetireZone({ onChange, toast }) {
  const [zone, setZone] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const [busy, setBusy] = useState(false);

  const load = () => api.get('/shade-cards/legacy')
    .then(z => { setZone(z); setPicked(new Set()); })
    .catch(() => toast.error('Could not load the retire zone'));
  useEffect(() => { load(); }, []);

  const toggle = id => setPicked(s => {
    const n = new Set(s);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });

  const call = async (path, body, msg) => {
    setBusy(true);
    try {
      const r = await api.post(path, body);
      toast.success(msg(r));
      await load();
      await onChange();
    } catch (e) { toast.error(e.message || 'That did not work'); } finally { setBusy(false); }
  };

  if (!zone) return <p className="text-sm text-slate-400">Loading…</p>;

  const pickedIds = [...picked];
  const pickCol = rows => ({
    key: '_pick', label: '', sortable: false, width: '36px',
    render: r => <Checkbox checked={picked.has(r.product_id)} onChange={() => toggle(r.product_id)} />,
    export: () => '',
  });

  return (
    <div className="space-y-5">
      <div className="glass rounded-[22px] border border-amber-200/60 bg-amber-50/50 p-4">
        <p className="flex items-center gap-2 text-sm font-extrabold text-amber-800">
          <AlertTriangle size={15} /> Why this screen exists
        </p>
        <p className="mt-1 text-xs font-medium text-amber-800/85">
          A shade card number used to be typed by hand onto the product master, separately
          from the card itself — four places to type one number. That field is now read-only
          everywhere and filled in from this module. These are the old hand-typed values.
          Retiring one clears it from the product; nothing is destroyed and anything here can
          be restored.
        </p>
      </div>

      {/* Orphans first: these are the ones that need a decision, not just tidying. */}
      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-extrabold text-slate-800">
            Numbers with no card behind them
            <span className="ml-2 rounded-full bg-red-50 px-2 py-0.5 text-xs font-bold text-red-600">
              {zone.candidates.length}</span>
          </h3>
          <div className="flex gap-1.5">
            <Button size="sm" disabled={!pickedIds.length || busy}
              onClick={() => call('/shade-cards/legacy/promote', { product_ids: pickedIds },
                r => `${r.promoted} real shade card${r.promoted === 1 ? '' : 's'} created`)}>
              <Wand2 size={13} /> Create real cards ({pickedIds.length})
            </Button>
            <Button size="sm" variant="secondary" disabled={!pickedIds.length || busy}
              onClick={() => call('/shade-cards/legacy/retire', { product_ids: pickedIds },
                r => `${r.retired} number${r.retired === 1 ? '' : 's'} retired`)}>
              <Archive size={13} /> Retire without a card
            </Button>
          </div>
        </div>
        <p className="text-xs text-slate-500">
          A number here cannot be approved, issued or tracked — nothing in the ERP stands
          behind it. Creating a real card carries the number and its date across, so the age
          alarm starts telling the truth about it.
        </p>
        <DataTable exportName="shade-legacy-orphans" rows={zone.candidates}
          getRowId={r => r.product_id}
          columns={[pickCol(),
            { key: 'product_code', label: 'Product' },
            { key: 'product_name', label: 'Name' },
            { key: 'customer_name', label: 'Customer', render: r => r.customer_name || '—' },
            { key: 'shade_card_number', label: 'Typed number',
              render: r => <span className="font-mono text-xs font-semibold">{r.shade_card_number}</span> },
            { key: 'shade_card_date', label: 'Typed date', render: r => r.shade_card_date || '—' },
          ]}
          empty="Nothing orphaned — every typed number has a real card behind it" />
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-extrabold text-slate-800">
            Numbers that just repeat their card
            <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-bold text-slate-500">
              {zone.duplicates.length}</span>
          </h3>
          <Button size="sm" variant="secondary" disabled={!pickedIds.length || busy}
            onClick={() => call('/shade-cards/legacy/retire', { product_ids: pickedIds },
              r => `${r.retired} duplicate${r.retired === 1 ? '' : 's'} retired`)}>
            <Archive size={13} /> Retire ({pickedIds.length})
          </Button>
        </div>
        <DataTable exportName="shade-legacy-duplicates" rows={zone.duplicates}
          getRowId={r => r.product_id}
          columns={[pickCol(),
            { key: 'product_code', label: 'Product' },
            { key: 'product_name', label: 'Name' },
            { key: 'shade_card_number', label: 'Typed number',
              render: r => <span className="font-mono text-xs">{r.shade_card_number}</span> },
            { key: 'sc_number', label: 'Real card',
              render: r => <span className="font-mono text-xs font-semibold text-emerald-700">{r.sc_number}</span> },
          ]}
          empty="No duplicates" />
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-extrabold text-slate-800">
          Retired
          <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-bold text-slate-500">
            {zone.retired.length}</span>
        </h3>
        <DataTable exportName="shade-legacy-retired" rows={zone.retired}
          columns={[
            { key: 'product_code', label: 'Product' },
            { key: 'sc_number', label: 'Retired number',
              render: r => <span className="font-mono text-xs">{r.sc_number}</span> },
            { key: 'sc_date', label: 'Date', render: r => r.sc_date || '—' },
            { key: 'promoted_number', label: 'Became', render: r => r.promoted_number
                ? <span className="font-mono text-xs font-semibold text-emerald-700">{r.promoted_number}</span>
                : <span className="text-slate-300">—</span> },
            { key: 'retired_at', label: 'Retired', render: r => `${fmt.dt(r.retired_at)} · ${r.retired_by || '—'}` },
            { key: '_act', label: '', sortable: false, export: () => '',
              render: r => (
                <Button size="sm" variant="ghost" disabled={busy}
                  onClick={() => call(`/shade-cards/legacy/${r.id}/restore`, {}, () => 'Restored to the product master')}>
                  <RotateCcw size={13} /> Restore
                </Button>) },
          ]}
          empty="Nothing retired yet" />
      </section>
    </div>
  );
}
```

The selection set is keyed on `product_id`, which is shared between the orphan and duplicate tables. That is intentional: a product appears in only one of the two lists, so one selection set cannot mean two things.

- [ ] **Step 2: Verify in the real app**

Open `/shade-cards` → **Retired Numbers**. Select an orphan, click **Create real cards**, and confirm a card appears in the register carrying the old number. Then restore it from the Retired list and confirm the number is back on the product master.

- [ ] **Step 3: Commit**

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && git add client/src/pages/shade-cards/RetireZone.jsx && git commit -m "feat(shade): a retire zone that explains itself and undoes itself

Orphans are listed first because they need a decision rather than tidying: a
number with no card behind it cannot be approved, issued or tracked. Promoting
carries the number and date across so the age alarm starts telling the truth."
```

---

## Task 15: The four surfaces that used to ask for a typed number

**Files:**
- Modify: `client/src/pages/Masters.jsx`
- Modify: `client/src/pages/Planning.jsx`
- Modify: `client/src/pages/Artwork.jsx`
- Modify: `client/src/pages/Production.jsx`

- [ ] **Step 1: Masters — remove the two shade fields and the approval control**

In `client/src/pages/Masters.jsx`:
- Delete the `shade_card_number` and `shade_card_date` entries from the products field list (currently lines 80–81).
- Delete both `shade_approval_requirement` entries — the customers one (line 59) and the products one (line 111). Internal approval no longer exists, so a control that switches it is a lie.
- Keep the `shade_card` **column** in the products table (line 114) and its renderer: it now displays the module's number with its live age chip, read-only, which is the useful half.
- In the `shade_card` column renderer, wrap the number so it navigates to the module:

```jsx
          if (k === 'shade_card' && cfg.endpoint === '/products') {
            if (!r.shade_card_number && !r.shade_card_date) return <span className="text-gray-300">—</span>;
            return <span className="block leading-tight">
              <a href={`/shade-cards?q=${encodeURIComponent(r.shade_card_number || '')}`}
                 className="font-mono text-xs font-semibold text-brand-600 hover:underline"
                 onClick={e => e.stopPropagation()}>{r.shade_card_number || '—'}</a>
              {r.shade_card_date && <span className="mt-0.5 block"><ShadeAge date={r.shade_card_date} /></span>}
            </span>;
          }
```

- Delete the `if (f.key === 'shade_approval_requirement' …)` null-coercion line (line 700) — the field is gone.

- [ ] **Step 2: Planning — read-only, plus one-click Issue to Printing**

In `client/src/pages/Planning.jsx`:
- Replace the two `<Field label={<>Shade Card No…}>` / `Shade Card Date` inputs (lines 1278–1288) with a read-only display:

```jsx
                    <Field label="Shade Card">
                      {form.shade_card_number ? (
                        <div className="flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2">
                          <a href={`/shade-cards?q=${encodeURIComponent(form.shade_card_number)}`}
                             className="font-mono text-xs font-semibold text-brand-600 hover:underline">
                            {form.shade_card_number}</a>
                          {form.shade_card_date && <ShadeAge date={form.shade_card_date} />}
                        </div>
                      ) : (
                        <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">
                          No shade card registered for this product — create one in Shade Cards.
                        </p>)}
                    </Field>
```

- Delete `shade_card_number` and `shade_card_date` from the spec `form` state (lines 356–357), the `cmp(...)` diff calls (lines 388–393), the gang spec form (lines 733, 741), the label map (line 854), the two gang spec inputs (lines 2028–2031) and the master-sync prompt's field list (line 2363). Leave the `party_artwork_code` / `output_number` handling in all of those untouched — those stay editable.
- Update the shade banner (lines 1179–1202) to the four statuses: the `ctx.shade_card.status !== 'customer_approved'` test becomes `!== 'approved'`, and the third branch's `=== 'customer_approved'` becomes `=== 'approved'`.
- Add the Issue to Printing action to the planning row, next to the existing job actions:

```jsx
{l.shade_card_id && l.shade_status === 'approved' && !l.shade_with_printing && (
  <Button size="sm" variant="secondary" onClick={async () => {
    const to = window.prompt('Issue the shade card to whom?');
    if (!to?.trim()) return;
    try {
      await api.post(`/shade-cards/${l.shade_card_id}/issue`,
        { issued_to: to.trim(), department: 'printing', job_card_id: l.job_card_id || undefined });
      toast.success('Shade card issued to printing');
      load();
    } catch (e) { toast.error(e.message); }
  }}><Printer size={13} /> Issue Shade Card</Button>)}
```

This needs `shade_card_id`, `shade_status` and `shade_with_printing` on the planning row. Add them to the planning list query in `server/src/routes/orders.js` by extending the existing `shadeCardsFor` decoration at line 1140 to also return `id`, `status` and an open-issue flag — `shadeCardsFor` already returns `shade_card_id` and `status`, so only the open-issue flag is new:

```js
    const shadeOpen = await q(`SELECT shade_card_id FROM shade_card_issues
                               WHERE returned_at IS NULL`);
    const openSet = new Set(shadeOpen.map(x => x.shade_card_id));
```

then set `shade_with_printing: openSet.has(sc?.shade_card_id)` alongside the existing `shade_card` field.

- [ ] **Step 3: Artwork — read-only**

In `client/src/pages/Artwork.jsx`, replace the two shade inputs (lines 565–574) with the same read-only block as Planning, and remove `shade_card_number` / `shade_card_date` from the `form` state (line 178), the prefill (lines 296–297), the sync-diff loop (line 311) and the label map (lines 77–78). The `shade_card` entry in the push-to-tooling section list (line 93) stays: pushing artwork to shade-card triage is still a real action.

- [ ] **Step 4: Production — read-only**

In `client/src/pages/Production.jsx`, the Job Card spec editor already prefers the live card for display (line 536). Make it read-only in both branches: delete the `<Field label="Shade Card No">` and `<Field label="Shade Card Date">` inputs (lines 532–543) and keep only the `<Spec>` displays, then remove `shade_card_number` / `shade_card_date` from `jcSpec` state (lines 108–109) and the label map (lines 118–119). Update `Shade Approval` (line 537) and the gang member `sc_status` (line 505) to read the four-status labels via `scLabel` imported from `./shade-cards/lifecycle.js`.

- [ ] **Step 5: Verify all four surfaces**

In the running app, confirm on each of Masters (Products), Planning (spec drawer), Artwork (edit drawer) and Production (Job Card drawer) that the shade card number appears as a link with its age chip and **cannot be typed into**. Confirm the Planning row shows **Issue Shade Card** for an approved card and hides it once issued.

- [ ] **Step 6: Commit**

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && git add client/src/pages/Masters.jsx client/src/pages/Planning.jsx client/src/pages/Artwork.jsx client/src/pages/Production.jsx server/src/routes/orders.js && git commit -m "feat(shade): one number, typed in one place

The shade card number was an input on the Product Master, the Planning spec
editor, the Artwork queue and the Job Card spec editor — four places to type one
number, each with its own age chip. All four now display the module's card
read-only with a click-through.

The Shade Approval Control select is gone from both masters: internal approval
no longer exists, so a control that switched it was a lie.

Planning gains Issue Shade Card, which is step 5 of the process where it
actually happens."
```

---

## Task 16: The floor dialog and the two printed surfaces

**Files:**
- Modify: `client/src/pages/Section.jsx`
- Modify: `client/src/pages/JobCardPrint.jsx`
- Modify: `client/src/pages/Invoices.jsx`

- [ ] **Step 1: Section.jsx — the acknowledge dialog says what it now means**

The 409 code and the `ack_shade` flag are unchanged, so only the wording moves. Replace the `ConfirmDialog` at lines 950–954:

```jsx
      <ConfirmDialog open={!!shadeAlarm} onClose={() => setShadeAlarm(null)} danger
        title="Shade card does not match this job"
        message={shadeAlarm
          ? `${shadeAlarm.shade.reason}. Check you have the right card at the machine before you start. Proceeding is recorded against ${shadeAlarm.shade.sc_number} under your name.`
          : ''}
        confirmLabel="I have checked — start anyway"
        onConfirm={() => start(true)} />
```

- [ ] **Step 2: JobCardPrint.jsx — four-status labels on the traveler**

Replace the `scStatusText` computation (lines 28–29):

```jsx
  const scStatusText = shade ? scLabel(shade.status) : '—';
```

and import `scLabel` from `./shade-cards/lifecycle.js`. Delete the `· Rev N` suffix — the shade card revision counter is no longer maintained, so printing "Rev 0" on every traveler in the plant would be noise.

- [ ] **Step 3: Invoices.jsx — no change needed, but verify**

`Invoices.jsx` reads only `shade_expired`, `shade_age_days` and `shade_card_code`, all of which `shadeCardsFor` still returns. Confirm with a grep and leave it alone:

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && grep -n "shade" client/src/pages/Invoices.jsx
```

Expected: only `shade_expired`, `shade_age_days`, `shade_card_code` and display text. If any status string appears, update it to the four-status set.

- [ ] **Step 4: Sweep the whole client for dead status strings**

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && grep -rn "customer_approved\|internal_approved\|internal_review\|customer_reviewing\|revision_requested\|sent_to_customer'\|dock_zone\|on_press\|shade_approval_requirement" client/src server/src --include="*.js" --include="*.jsx" | grep -v "db.js"
```

Expected: **no output**. Any hit is a surface still speaking the old vocabulary. `sent_to_customer_date` and `approval_received_date` are column names and are excluded by the quote in the pattern.

- [ ] **Step 5: Commit**

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && git add client/src/pages/Section.jsx client/src/pages/JobCardPrint.jsx && git commit -m "feat(shade): the floor dialog says what the alarm now means

The structured-409 and the ack_shade flag are unchanged — only the words move,
from 'internal approval pending' to 'this card does not match this job', which
is the failure that actually reaches a press. The operator is told to check the
card at the machine, and that proceeding is recorded under their name.

The job card traveler drops the 'Rev 0' suffix it printed on every job."
```

---

## Task 17: Full verification, then the deploy decision

**Files:** none — this task only runs and reports.

- [ ] **Step 1: The full verification suite**

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && npm run verify 2>&1 | tail -30
```

Expected: baseline freshness, all server tests, and the client build all pass. If the baseline is stale, run `npm run db:baseline` and inspect the diff before accepting it.

If `verify` fails on a baseline that another session moved, follow the clean-worktree procedure in `CLAUDE.md`: commit only your files, then verify that commit in a detached worktree so a parallel session's uncommitted work cannot fail your run.

- [ ] **Step 2: Walk the seven steps once more in the real app, end to end**

With the dev server running, logged in, at a desktop breakpoint:

1. Create a card from a sales order line — confirm nothing had to be typed twice.
2. Dispatch it.
3. Record the approval with a stamp and a signature.
4. Confirm the register's **Approved** tile count went up by one.
5. Issue it to printing.
6. Confirm the **With Printing** tile count went up and the row's *Held by* names the person.
7. Record the return with a condition, and confirm the row reads *In store* again.

Screenshot the register and the drawer. These two images are the before/after evidence.

- [ ] **Step 3: Confirm the printing gate still refuses what it always refused**

This is the check that matters most — a simplification that quietly opens a gate is a regression, not a simplification.

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp/server" && cat > _gate.mjs <<'EOF'
import { printingEligibility, codeMatch } from './src/shade-flow.js';
const cases = [
  ['approved, in date',      { sc_number:'A', status:'approved', creation_date:'2026-07-01' }, true],
  ['approved, 400 days old', { sc_number:'B', status:'approved', creation_date:'2025-01-01' }, false],
  ['sent, not approved',     { sc_number:'C', status:'sent' },                                false],
  ['draft',                  { sc_number:'D', status:'draft' },                               false],
  ['rejected',               { sc_number:'E', status:'rejected' },                            false],
];
let bad = 0;
for (const [name, card, expect] of cases) {
  const got = printingEligibility(card, Date.parse('2026-07-30')).eligible;
  if (got !== expect) { console.log(`FAIL ${name}: expected ${expect}, got ${got}`); bad++; }
  else console.log(`ok   ${name} → ${got ? 'clears' : 'blocked'}`);
}
console.log(codeMatch({artwork_no:'AW1'},{party_artwork_code:'AW2'}).ok === false
  ? 'ok   mismatch detected' : 'FAIL mismatch missed');
process.exit(bad ? 1 : 0);
EOF
node _gate.mjs; rm -f _gate.mjs
```

Expected: every line `ok`, exit 0.

- [ ] **Step 4: Check the production schema before proposing any deploy**

Editing `db.js` does **not** migrate production. Compare first:

```bash
cd "/Users/anikdua/Documents/CI ERP FInal/ci-erp" && DATABASE_URL="<prod connection string>" npm run db:check 2>&1 | tail -40
```

Expected: drift reported for exactly the two new tables, the two new columns, their indexes and the status constraint — and nothing else. Any other reported difference means something outside this plan changed and must be understood before deploying.

- [ ] **Step 5: Stop and hand the deploy decision to the user**

Do **not** push. Report:
- the `npm run verify` result,
- the `db:check` drift list,
- the before/after screenshots,
- and that applying `0013_shade_card_simplification.sql` to production requires `npm run db:backup` first.

Pushing `main` auto-deploys `motionci.in`. Whether and when that happens is the user's call, not this plan's.

---

## Task 18: Work-queue pills — what needs doing, in the order it needs doing

Added 2026-07-31 at the user's request, after seeing the register live.

The eight tiles answer *"what is the state of everything?"*. They do not answer *"what should I do now?"* — and with 599 cards, that second question is the one that matters daily. This task adds a pill row that answers it, with the To Issue queue ranked by how close the job actually is to a press.

**Files:**
- Modify: `server/src/routes/shadecards.js` (`CARD_VIEW` + `decorate`)
- Modify: `client/src/pages/shade-cards/lifecycle.js` (urgency presentation)
- Modify: `client/src/pages/ShadeCards.jsx` (pill row + urgency column)

### 18.1 The urgency ladder

A card needs issuing when it is **approved, in date, not currently out, and its product has live production demand**. How urgent depends on how close that demand is to a press:

| rank | meaning | source |
|---|---|---|
| 4 | **Running now** — printing in progress on a named press | `job_stages.stage='printing' AND status='in_progress'` with a machine |
| 3 | **On press queue** — printing scheduled on a named press | same, `status='pending'`, machine assigned |
| 2 | **In print planning** — job card exists, no press yet | printing stage pending, no machine |
| 1 | **Ordered** — an open sales order line, no job card yet | `order_lines.status IN ('pending','planned','ready','in_production')` |
| 0 | nothing live — not in the queue at all | |

Ranks 4 and 3 are the ones the user called "highest priority — on printing lines schedule"; rank 2 is "printing plan triage".

Verified against the local production mirror: **28 of 599 approved cards sit at rank ≥ 1**, 572 at rank 0. Ranks 2–4 are empty locally only because no job cards exist on that database yet; the SQL is correct and populates as jobs are planned.

### 18.2 Server — add demand to `CARD_VIEW`

Two LATERALs, both keyed on the card's product:

```sql
  -- Live production demand, and how close it is to a press. This is what makes
  -- "which cards should I issue today?" a 28-row question instead of a 599-row
  -- one. Ranked so the register can put the press queue above the plan queue.
  LEFT JOIN LATERAL (
    SELECT COALESCE(MAX(CASE
             WHEN js.status = 'in_progress'
                  AND COALESCE(js.machine_id, jc.machine_id) IS NOT NULL THEN 4
             WHEN COALESCE(js.machine_id, jc.machine_id) IS NOT NULL THEN 3
             ELSE 2 END), 0) AS rank,
           (array_agg(m.name ORDER BY CASE WHEN js.status='in_progress' THEN 0 ELSE 1 END)
             FILTER (WHERE m.name IS NOT NULL))[1] AS press_name,
           (array_agg(jc.jc_number ORDER BY jc.id DESC))[1] AS jc_number
    FROM job_stages js
    JOIN job_cards jc ON jc.id = js.job_card_id
    LEFT JOIN machines m ON m.id = COALESCE(js.machine_id, jc.machine_id)
    WHERE jc.product_id = sc.product_id
      AND js.stage = 'printing' AND js.status IN ('pending','in_progress')) jobdem ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS n FROM order_lines ol3
    WHERE ol3.product_id = sc.product_id
      AND ol3.status IN ('pending','planned','ready','in_production')) linedem ON true
```

Add `jobdem.rank AS job_demand_rank`, `jobdem.press_name`, `jobdem.jc_number AS demand_jc_number`, `linedem.n AS open_order_lines` to the select list.

In `decorate`:

```js
  // Rank 0 means nothing live is waiting on this card. A job card outranks a
  // bare order line, because a job card means the work is already committed.
  const demandRank = card.job_demand_rank > 0 ? card.job_demand_rank
    : (card.open_order_lines > 0 ? 1 : 0);
  ...
    demand_rank: demandRank,
    // The whole point of the To Issue queue: approved, in date, in the plant's
    // hands, and something downstream is actually waiting for it.
    needs_issue: gate.eligible && !card.open_issue_id && demandRank > 0,
```

### 18.3 Client — presentation in `lifecycle.js`

```js
// How close the work waiting on this card is to a press. Drives the To Issue
// queue's ordering and its badge — an operator should be able to see at a
// glance which card to walk to the floor first.
export const DEMAND_META = {
  4: { label: 'Running now',      cls: 'bg-red-50 text-red-700' },
  3: { label: 'On press queue',   cls: 'bg-orange-50 text-orange-700' },
  2: { label: 'In print planning', cls: 'bg-amber-50 text-amber-700' },
  1: { label: 'Ordered',          cls: 'bg-slate-100 text-slate-600' },
  0: { label: '—',                cls: 'text-slate-300' },
};
```

### 18.4 Client — the pill row

Rendered under the sub-tabs, visible only on the Register view, styled like the existing `SubTabs` pills:

```
[ Everything 599 ]  [ Awaiting Customer 12 ]  [ To Issue 28 ]  [ With Printing 3 ]
```

- `Everything` → no filter
- `Awaiting Customer` → `status === 'sent'`
- `To Issue` → `needs_issue`, and **sorts by `demand_rank` descending by default**
- `With Printing` → `with_printing`

**One selection state, two affordances.** The pills and the eight tiles must drive the *same* `tile` state — clicking the "Pending Approval" tile lights the "Awaiting Customer" pill and vice versa. Two independent filter mechanisms on one table is exactly the kind of duplication this whole project is removing. Wire the pills to the existing `tile` state and add `to_issue` as a new key in `TILES`-adjacent config rather than a second state variable.

`To Issue` has no tile — the PRD fixes the dashboard at eight, and the grid is `xl:grid-cols-8`. It is a queue, not a status count, so it belongs with the pills.

### 18.5 Client — the urgency column

Add a column to the register, rendered only meaningfully when a rank exists:

```jsx
{ key: 'demand_rank', label: 'Waiting on it', sortValue: r => r.demand_rank ?? 0,
  render: r => {
    const m = DEMAND_META[r.demand_rank ?? 0];
    if (!r.demand_rank) return <span className="text-slate-300">—</span>;
    return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${m.cls}`}>
      {m.label}{r.press_name ? ` · ${r.press_name}` : ''}</span>;
  },
  export: r => DEMAND_META[r.demand_rank ?? 0].label },
```

### 18.6 Verification

- The three new pill counts match direct SQL against the same predicates.
- Selecting `To Issue` shows only approved, in-date, not-currently-out cards with live demand, ordered with rank 4 at the top.
- Clicking the `Pending Approval` tile lights the `Awaiting Customer` pill — one state, not two.
- On the local mirror, `To Issue` shows **28**.
- Verified in the real running app, logged in, desktop breakpoint, with a screenshot.

---

## Self-Review

**Spec coverage.** Every section of the spec maps to a task: lifecycle → 1; data model, retired columns and migration → 2; prefill and read API → 3; create/edit/status → 4; custody → 5; the free-text twin and retire zone → 6 and 14; alerts and reports → 7; the consumer list → 8, 9, 10, 15, 16; the register, form and drawer → 11, 12, 13; testing → 1, 8, 17. The checks table in §7 of the spec is implemented across Tasks 1 (pure rules), 9 (enforcement) and 13 (the warning panel).

**One requirement is deliberately not delivered as written.** "Revision" cannot be auto-populated: the ERP has no artwork revision column anywhere, so it stays a typed field with a hint saying why (Task 12). This is recorded in the spec rather than left to be discovered as a blank field.

**One requirement is deliberately softened,** on the user's decision: the AW/Output check warns and audits rather than blocking, because only 5 of 1594 products carry an output code.

**Type consistency.** `printingEligibility` returns `{ eligible, reason }` everywhere — Tasks 1, 8, 9, 17 and the `printing_eligible` / `printing_block_reason` decoration in Task 3. `codeMatch` returns `{ ok, mismatches[{field, card, order}] }` in Tasks 1, 3, 7, 9 and 13. `holderOf` returns `{ issued_to, department, since }` in Tasks 1 and 3. The four status strings are identical in `shade-flow.js`, `lifecycle.js`, the DB CHECK constraint and the migration. `nextAction` keys (`sent`, `approved`, `rejected`, `issue`, `return`) match the endpoints they call in Task 13.

**Scope.** One module plus its consumers, one coherent plan. The columns left in place are the only deferred work, and they are named in the spec's out-of-scope section.
