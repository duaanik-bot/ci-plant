# Job Card — inherited, finalisable manufacturing document

**Date:** 2026-07-08
**Status:** Approved (design)

## Objective

Turn the Job Card into the single source of truth for production: it auto-inherits
finalised/locked information from the Planning Engine, Artwork Module (via the
Tooling Hub) and Product Master, presents it **read-only** with per-source
traceability, and gives the operator a simple form to **finalise** the card and
**push it to the next stages**. It also prints a clean, single-page PDF that
carries only the spec — **no process stages**.

The operator never re-enters approved upstream data. Any change must be made in
the source module and re-approved; the Job Card only reflects the latest approved
state.

## Decisions (locked with user)

1. **Artwork fields — add a few light fields.** No versioning engine. The Job Card
   reads the product's linked Tooling Hub records (die / plate / block / shade
   card). We add two text fields so numbers have a home. Once the tooling is
   filled and linked, the Job Card populates automatically.
2. **Inheritance — live read-only join.** Nothing is copied/snapshotted. The Job
   Card always reflects the latest approved masters via joins.
3. **Finalise — explicit action.** A distinct Finalise step locks the editable
   fields and unlocks push-to-next-stage from within the form.
4. **PDF — keep a compact Material Issued strip** (traceability), drop all stage
   tables and per-stage sign-off grids.

## Data model changes

Additive migrations only (idempotent `ALTER … ADD COLUMN IF NOT EXISTS`, matching
the existing `db.js` pattern):

- `job_cards.finalised_at TIMESTAMPTZ` — nullable. Finalised ⇔ timestamp set.
- `tools.output_no TEXT` — output/positive number (artwork).
- `tools.cylinder_no TEXT` — dye/cylinder number (artwork, where applicable).

No new tables. No change to the `job_cards.status` enum (finalisation is a
separate flag, not a status).

Existing fields reused for the "artwork" source:
- **Shade card number** → shade-card tool `code`
- **Block number** → block tool `code`
- **Plate/output** → plate tool `code`, new `output_no`
- **Shade ref / emboss** → existing `shade_ref`, `emboss_type`
- **Colours / special finish** → `products.colors`, `products.special`
- **Approvals / lock** → `order_lines.artwork_customer_ok / _qa_ok / _locked`

## Inherited data, grouped by source (read-only)

**Planning Engine** — ordered qty (`order_lines.qty`), planned qty
(`job_cards.qty_planned`), sheets issued (`job_cards.sheets_issued`), sheets
required (`order_lines.sheets_required`), parent sheets required, print
sheets/parent yield (`children_per_parent`), press (`machines.name`), planned
date (`order_lines.planned_date`), delivery date (`orders.delivery_date`).

**Artwork Module** — customer ✓ / QA ✓ / lock status; linked shade card, block,
plate, die codes; shade ref; output no; cylinder no; colours (CMYK vs N-colour
spot); special finish.

**Product Master** — product code, board name · GSM, parent sheet size
(`materials.sheet_l/w`), print sheet size (`products.child_l/w`), carton/finished
size (`products.size`), coating/lamination (`products.coating`), die number ·
location, UPS.

Each source block carries a small caption for traceability, e.g.
`Product Master #<id>`, `Artwork locked <date>` / `Awaiting approval`,
`Plan <planned_date>`.

## Server changes (`server/src/routes/production.js`, `tooling.js`)

1. **Expand `JC_VIEW`** to also select: `p.gsm, p.coating, p.special`,
   `ol.sheets_required, ol.parent_sheets_required, ol.planned_date`,
   `ol.artwork_customer_ok, ol.artwork_qa_ok, ol.artwork_locked`,
   `jc.finalised_at`. (child_l/w, die, board, sheet size already present.)
2. **Detail endpoints** (`GET /job-cards/:id`, `GET /finished-goods/:jobCardId`)
   attach `jc.tools` — all active tools for the product grouped/returned by
   family with code, title, shade_ref, output_no, cylinder_no, emboss_type,
   colors. (Same shape as the existing `jc.issues` / `jc.stages` attachments.)
3. **`POST /job-cards/:id/finalise`** (`canPlan`): requires `artwork_locked` and
   status ≠ closed; rejects if already finalised. Sets `finalised_at = now()`,
   audits `job_card / finalised`. Tooling-not-ready does **not** block (soft).
4. **`POST /job-cards/:id/reopen`** (`canPlan`): only if no stage has started and
   not closed. Clears `finalised_at`, audits `job_card / reopened`.
5. **Guard `PUT /job-cards/:id`**: reject with 409 when `finalised_at` is set
   (in addition to the existing started-stage guard). Message directs the user to
   Reopen first.
6. **Tooling** (`tooling.js`): add `output_no`, `cylinder_no` to the writable
   `FIELDS` list and to the `INSERT`/`UPDATE` in `POST /tools` and `PUT /tools/:id`.

## Client changes

### `client/src/pages/Production.jsx` — Job Card Form modal
- **Remove** the "Stage rail" section from the modal.
- Add three **read-only inherited panels** (Planning / Artwork / Product Master)
  using existing `ci-form-panel` styling, each with a source/lock caption chip.
- Keep the **editable panel** (planned qty, sheets issued, press) — editable only
  when `canEditJobCard && !closed && !started && !finalised`.
- Footer:
  - Not finalised → **Finalise** button (disabled unless `artwork_locked`),
    plus Save Changes for the editable fields.
  - Finalised → show `Finalised <date>` chip, render `<WorkflowControls
    jobCard={jc} context="jobcard">` (Route → Cutting / Print Planning + Reverse)
    **inside the form**, and a **Reopen** button (planner/admin, not started).
- A soft amber note when finalising is blocked by unlocked artwork, and a soft
  note when tooling is not ready.

### `client/src/pages/JobCardPrint.jsx` — clean PDF
- Header: `Production Job Card`, JC number, product; right column COLOUR
  IMPRESSIONS, customer, PO, released date, status + **Finalised** chip.
- Body: the same **3 source-grouped spec blocks** as the modal, laid out as a
  print-friendly grid.
- Compact **Material Issued** strip (existing `jc.issues`) — kept for traceability.
- Footer sign-off: **Planned By / Finalised By / QA Release** (3 lines).
- **Removed:** the production-stages table and the per-stage sign-off grid.

### `client/src/pages/Tooling.jsx` — capture the new fields
- Add `Output No` and `Cylinder No` inputs to the tool create/edit form, shown for
  the plate / block / shade-card families (and die where relevant). Wire into the
  existing tool form state and PUT/POST payloads.

## Data integrity / traceability

- All inherited fields render read-only in both the modal and the PDF. There is no
  control that writes back to planning/artwork/product/tooling from the Job Card.
- Editing a master requires going to its module and re-approving; the live join
  means the Job Card reflects it on next load.
- Finalisation + audit log provide the "who finalised, when" trail; per-source
  captions provide the "which version/approval" trail.

## Out of scope (YAGNI)

- Artwork revision/version history engine (v1/v2 supersede).
- Frozen snapshot of specs onto the job card.
- Any change to the stage/production execution flow (start/complete/reverse stay
  as-is; they are simply no longer shown in the *form*).

## Non-standard workflow note

Per project convention, **work stays local — no git commits** for this change.
