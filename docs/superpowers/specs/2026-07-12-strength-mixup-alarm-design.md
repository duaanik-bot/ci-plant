# Strength Mix-up Alarm — Design Spec

**Date:** 2026-07-12
**Module scope:** Print Planning + Accounts (Invoicing)
**Type:** Soft warning (no hard block anywhere)

## Problem

Products that share a brand name but differ only in strength — e.g. **Nicostar 5**
vs **Nicostar 10** — get mixed up. The two failure points are:

1. **Print Planning** — the same brand at two strengths is in production close
   together and the wrong-strength carton gets swapped.
2. **Dispatch / Invoicing** — two strengths of the same brand ship on the same
   vehicle and get swapped in transit / on the bill.

The owner wants a **soft alarm** at both points: a simple *"you're planning /
billing this product and its sibling strength is also here — are you sure?
Yes / No"*. **No hard block** — "Yes" always proceeds.

## Detection: the family matcher

New shared module: `server/src/product-family.js`.

Derives from a product name:

- **`base`** — the brand prefix: the alphabetic tokens **before the first
  number-leading token**, uppercased and space-collapsed.
- **`strength`** — that first number-leading token, normalized (uppercased,
  punctuation stripped). E.g. `5`, `10`, `25`, `500MG`.

### Clash rule

Two products **clash** when **all** hold:

- same `customer_id`,
- same non-empty `base` (length ≥ 3),
- both have a `strength`,
- the `strength` values **differ**,
- different `product_id`.

### Why "first number, must differ"

Keying on the **first** number-token and requiring it to **differ** means:

- genuine strength differences fire (5 vs 10, 25 vs 50),
- mere revisions / pack-size duplicates of the *same* strength stay quiet
  (both resolve to the same first number),
- products with no number (no strength) never clash.

### Worked examples (real product names)

| Name | base | strength | Result |
|---|---|---|---|
| `NICOSTAR 5` | `NICOSTAR` | `5` | ⚠️ clashes with `NICOSTAR 10` |
| `NICOSTAR 10` | `NICOSTAR` | `10` | ⚠️ |
| `AIMET XR 25 TABLET CARTON SALE-R2` | `AIMET XR` | `25` | ⚠️ clashes with `AIMET XR 50 …` |
| `AIMET XR 50 TABLET CARTON SALES R1` | `AIMET XR` | `50` | ⚠️ |
| `AIMET XR 25 TABLET-R2` vs `AIMET XR 25 TABLETS-R1` | `AIMET XR` | `25` = `25` | ✅ no alarm (revisions, same strength) |
| `ACICHECK 20 …` vs `ACELODON GEL …` | different base | — | ✅ no alarm |
| `AL5ZYME DROPS-15ML` vs `AL5ZYME LIQUID 100ML` | `AL5ZYME DROPS` / `AL5ZYME LIQUID` | — | ✅ no alarm (base differs — different form) |
| `1 KG MITHAI BOX` (leading number) | empty base | — | ✅ excluded (base < 3 chars) |

### Parsing rules (precise)

- Uppercase, trim, collapse whitespace.
- Tokenize on `/[\s\-\/(),]+/`.
- A **number-token** is one that **starts with a digit** (`^\d`) — covers
  `25`, `500MG`, `10X10`, `30'S`, `1`.
- Walk tokens left→right, accumulating into `base` until the first number-token.
  That number-token is `strength` (normalized = its digits+letters, uppercased,
  other punctuation removed).
- `base` = accumulated tokens joined by single space.
- If `base` is empty or `< 3` chars (name starts with a number) → the product is
  **non-classifiable**: it has no usable base and never participates in a clash.
- If no number-token exists → `strength` is null → never clashes.

### Exported API

```js
// server/src/product-family.js
export function familyKey(name)            // → { base: string, strength: string|null }
export function clashes(a, b)              // a,b = { customer_id, product_id, name } → boolean
export function findClashes(target, pool)  // target vs array → array of clashing pool members
```

Pure functions, no DB — unit-testable in isolation.

## Feature 1 — Print Planning alarm (any machine, any date)

### Trigger

When a job card is placed on a press:

- `POST /print-planning/assign` (drag onto a lane), and
- `PUT /print-planning/:jobCardId` when `machine_id` changes to a non-null press.

Not triggered when moving a card **to** Triage (`machine_id = null`).

### Server logic

Inside the assign transaction, before committing, load the **candidate pool**:
every active print-plan card —

```
job_cards jc JOIN job_stages js (stage='printing', status != 'completed')
WHERE jc.status IN ('open','in_progress')
  AND jc.id != <this card>
```

with `product_id`, product `name`, `customer_id`, `jc_number`, `machine_id`
(→ press name or "Triage"), and the card's `planned_date`.

Run `findClashes(thisCard, pool)`. If non-empty **and** the request body lacks
`confirm_collision: true` → **do not commit**; return structured 409:

```json
{
  "error": "Strength mix-up check",
  "code": "PRODUCT_STRENGTH_COLLISION",
  "collision": {
    "this":  { "product_name": "NICOSTAR 5", "strength": "5", "jc_number": "..." },
    "others": [
      { "product_name": "NICOSTAR 10", "strength": "10",
        "jc_number": "...", "location": "CI-2", "planned_date": "2026-07-12" }
    ]
  }
}
```

Scope is **any machine, any date** — the pool is the whole board, not filtered
by press or date (per owner's explicit choice).

**Ask once, then stay quiet.** The check runs only when the card's *press
actually changes* (`machine_id !== jc.machine_id`) — a same-press reorder never
prompts — and only if this card has no prior `strength_collision_ack` in the
audit trail. So a clashing card prompts once, on first placement; after "Plan
Anyway" it never re-prompts (reorders, or later moves to another press). No
per-drag nagging, no schema change (the ack is read straight from `audit_log`).

### Client (`client/src/pages/PrintPlanning.jsx`)

- `moveGroup` already optimistically moves the card, POSTs assign, and on error
  calls `load()` (revert). Change: in the `catch`, if `err.data.code ===
  'PRODUCT_STRENGTH_COLLISION'`, **hold** — open a Yes/No modal (no revert yet).
  - **Yes** → re-POST the same assign with `confirm_collision: true`, then `load()`.
  - **No** → `load()` (reverts the optimistic move).
- Same handling in the QuickEdit save path (`PUT`).
- Modal copy:
  > ⚠️ Strength mix-up check — You're planning **NICOSTAR 5**. **NICOSTAR 10**
  > is already in the plan (CI-2 · planned 12 Jul). Same brand, different
  > strength. Go ahead?  **[Yes] [No]**

### Audit

On a confirmed override, write `audit('job_card', id, 'strength_collision_ack',
'Planned despite strength clash with <names>', ...)` — a trail of who waved it
through, consistent with the system's audit-heavy design.

## Feature 2 — Invoicing alarm (same vehicle)

### Trigger

`POST /invoices` (cut an invoice from selected dispatch/challan lines).

### Server logic

After resolving the selected `dispatch_line_ids` (already scoped to one
customer), fetch each line's `product_id`, product `name`, and its challan
`vehicle` (`dispatches.vehicle`). Group lines by **non-null `vehicle`**. Within
each vehicle group, run pairwise `clashes(...)`. Lines with a null vehicle are
skipped (can't assert "same vehicle").

If any clashing pair exists **and** no `confirm_collision: true` → return
structured 409:

```json
{
  "error": "Same-vehicle strength check",
  "code": "PRODUCT_STRENGTH_COLLISION",
  "collision": {
    "vehicle": "RJ14-GA-1234",
    "challans": ["CI-CH-0042"],
    "pair": [
      { "product_name": "NICOSTAR 5",  "strength": "5"  },
      { "product_name": "NICOSTAR 10", "strength": "10" }
    ]
  }
}
```

### Client (`client/src/pages/Invoices.jsx`)

Invoice-create submit: catch `err.data.code === 'PRODUCT_STRENGTH_COLLISION'`,
show Yes/No modal, on Yes re-submit with `confirm_collision: true`.
Modal copy:
> ⚠️ Same-vehicle strength check — This invoice bills **NICOSTAR 5** and
> **NICOSTAR 10** that went out on the **same vehicle (RJ14-GA-1234, challan
> CI-CH-0042)**. Sure they weren't swapped?  **[Yes] [No]**

### Audit

On confirmed override, note it on the invoice audit trail
(`strength_collision_ack`).

## Guardrails

- **No hard blocks** — every path completes on "Yes".
- **No schema changes, no data entry** — detection is derived entirely from
  existing product `name` + `customer_id`.
- Reuses the existing structured-409 → confirm-modal convention (api.js already
  suppresses the toast when `data.code` is present and attaches `err.data`).

## Testing

- `server/src/product-family.test.js` — 17 unit tests for `familyKey` /
  `clashes` / `findClashes` covering every row of the worked-examples table
  (clash, no-alarm-revision, no-alarm-different-base, non-classifiable
  leading-number, decimal-strength `2.5 != 25`). All green.
- Matcher validated read-only against the live catalog: it flags the real pharma
  pairs (AIMET XR 25/50, BETAONE XL 25/50, BIOVAL 200/300) and finds 165
  colliding brand-groups in total — no writes.
- Routes verified LIVE end-to-end (the repo has no DB/route test harness; its
  `*.test.js` files are pure-unit). On a throwaway verify server against live PG,
  with a UAT-marked seed that was deleted afterwards:
  - Print Planning: `assign` without confirm → HTTP 409 `PRODUCT_STRENGTH_COLLISION`
    with the correct `this`/`others`; with `confirm_collision` → 200 and a
    `strength_collision_ack` audit row.
  - Invoicing: same-vehicle clash → 409 with `vehicle`/`challans`/`pair`; confirm
    → 200, invoice created, `strength_collision_ack` audited.
  - The alarm modal was confirmed rendering in the real running UI (drag/edit →
    "Strength mix-up check" → Plan Anyway lands the card).

## Ask-once behaviour (owner follow-up)

Per owner: the prompt must NOT reappear on each drag. Resolved — the check fires
only on an actual press change and only until the card's clash is acknowledged
once (see the "Ask once, then stay quiet" note under Feature 1). Verified live:
first placement → 409; after Plan Anyway, a same-press reorder and a move to a
different press both proceed with no prompt.
