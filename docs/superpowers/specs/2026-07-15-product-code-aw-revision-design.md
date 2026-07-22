# Auto Product Code + AW-Revision Governance — Design

**Date:** 2026-07-15
**Module:** Product Master (ci-erp)
**Status:** Approved design, pending implementation plan

## Problem

Two governance gaps in the Product Master:

1. **Product codes are typed by hand.** The plant-unique `products.code` is entered
   manually in the Masters form, so it is error-prone and has no client-aligned
   structure. Codes should be generated automatically, be uneditable, follow a
   per-client sequence, and never conflict.

2. **Pharma artwork revisions create duplicate masters.** When a customer revises an
   artwork, a new product master is added while the old one still exists and is
   still active. Both then compete during PO matching / manual entry. There is no
   mechanism to retire the superseded master, so future POs can bind to the wrong
   (old) product.

## Decisions (locked with the user)

| Topic | Decision |
|---|---|
| Code scheme | Per-customer prefix + number: `<CUSTCODE>-NNNN` |
| Customer short code | Auto-suggested from name, editable, enforced unique |
| Revision match key | Same customer AND (`party_artwork_code` OR `party_item_code`), non-empty |
| Existing ~1372 codes | Left untouched; auto-generation applies to new products only |
| Code lock scope | Lock everything — all product codes read-only in UI + API |
| Deactivate popup | Matching old products listed with row checkboxes, **pre-ticked**, optional |
| Trigger points | Master create form **and** PO quick-create wizard |

## Data-model changes (`server/src/db.js`)

- **`customers.code TEXT`** — new short-code column (the per-customer prefix).
  Partial unique index where `code IS NOT NULL`.
- **Indexes:** add `idx_products_party_item_code`; keep existing
  `idx_products_artwork_code`; add composite `(customer_id, code)` for sequence reads.
- **No new `products` columns** — `code`, `party_artwork_code`, `party_item_code`,
  `active` already exist.
- Existing product codes are not migrated or renamed.

## Part A — Customer short code (the prefix)

- **`deriveCustomerCode(name)`** (server helper): uppercase alphanumerics of the
  name, first 5 chars (e.g. *Cipla Ltd* → `CIPLA`). On collision append `2`, `3`, …
  until unique.
- **Customers form** (`client/src/pages/Masters.jsx`, `CONFIGS.customers`): add a
  `code` field that auto-suggests from the name as the user types, remains editable,
  and is validated unique on save (server returns 409 on clash).
- **`ensureCustomerCode(customerId, tx)`** (server safety net): if a customer has no
  code at the moment their first product is created, derive + persist one on the
  spot so product creation never blocks on a missing prefix.

## Part B — Auto internal product code

- **Scheme:** `<CUSTCODE>-NNNN`, 4-digit zero-padded, sequenced **per customer**.
- **`nextCustomerProductCode(custCode, customerId, tx)`** (server helper):
  `MAX(trailing number)` among that customer's codes matching `^<CUSTCODE>-\d+$`,
  `+1`. The regex filter excludes arbitrary legacy/imported codes so they never
  collide with or perturb the series.
- **Generation point:** server-side, inside the create transaction on
  `POST /products`. Client sends no `code` for new products.
- **Conflict-free:** rely on the existing `products.code UNIQUE` constraint; on the
  rare race, retry generation once.
- **PO quick-create:** `server/src/routes/import.js` (currently `NEW-####` via
  `MAX(id)+1`) switches to `nextCustomerProductCode`, so imported new masters also
  get proper client-sequenced codes.
- **Uneditable (lock everything):**
  - Product form `code` field is read-only for both new (placeholder
    "Auto-generated on save") and existing rows.
  - Server strips `code` from the product **update** path in the masters CRUD
    factory (`server/src/routes/masters.js`) so it can never be changed via API.
  - Generation still writes `code` on insert only.

## Part C — AW-revision detection + deactivate popup

- **Match rule:** `customer_id` equal AND (`party_artwork_code` equal — non-empty — OR
  `party_item_code` equal — non-empty). Only `active=1` products are considered.
  Empty/null artwork and item codes are never matched on. If the new product has
  both fields empty, the check is skipped.
- **Mechanism — structured 409** (the existing Yes/No-gate pattern in this codebase,
  e.g. the strength mix-up alarm): on `POST /products`, if matches exist and the
  request carries no acknowledgement, respond
  `409 { code: 'REVISION_CONFLICT', matches: [ { id, code, name, party_artwork_code, party_item_code } ] }`.
- **Client popup:** lists each matching old product with a row checkbox
  **pre-ticked**. User may untick any to keep it active, then confirms. Client
  re-submits the create with `deactivate_ids: [...]` and an acknowledgement flag.
- **Atomic apply:** in one transaction the server creates the new product (auto
  code) *and* sets `active=0` on the chosen old ids; each deactivation is written to
  the audit log.
- **Trigger points:** the Master create form and the PO quick-create wizard
  (`client/src/components/QuickCreateMasters.jsx`) both run the check and render the
  popup.
- **Net effect:** the PO matcher (`server/src/routes/import.js` candidate query) and
  its client mirror (`ImportPOWizard.jsx`) already filter `active=1`, so deactivated
  old masters silently drop out of all future PO matching and manual-entry lookups.
  No matcher changes required.

### Note on `spec_incomplete` placeholders

Products auto-created by a prior PO without full specs are `active=1` and will appear
in the revision popup. This is intended: a stub from an earlier PO is exactly the
kind of "old AW" the user wants to retire in favour of the real new master. They are
listed like any other match (pre-ticked).

## Implementation phasing

1. **Slice 1 — Part A + Part B:** customer short code, auto product code, UI/API
   lock. Independently testable; a hard prerequisite for Part C.
2. **Slice 2 — Part C:** revision detection, structured-409, deactivate popup on both
   trigger points.

## Verification plan

- Test in the **real running app** (login `admin@motionci.com` / `admin123`, desktop
  breakpoint), not a mock.
- Server edits may not hot-reload the running instance — verify via a **temporary
  server on a spare port reusing the embedded PG at :5439**.
- All test rows tagged `UAT-*`. **No unscoped deletes**; cleanup scoped strictly to
  those markers. **No git commits** (per standing project rule).

### Verification scenarios

- Create a customer → short code auto-suggests, editable, saves unique.
- Create a product → code auto-generates as `<CUST>-0001`, field read-only.
- Create a second product for same customer → `<CUST>-0002`.
- Attempt to edit an existing product's code → blocked (read-only + API strip).
- Create a product with an artwork/item code matching an active master → popup lists
  the old master pre-ticked → confirm → old goes `active=0`, new created atomically.
- Re-run PO import for that item → matcher no longer returns the deactivated old
  master.
