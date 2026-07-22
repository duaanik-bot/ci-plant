# Leftover Stock Management + Warehouse Aging — Design

Date: 2026-07-07 · Status: approved by Anik (planning-time capture, merged masters, materials+stock_batches reuse, warehouse-wide 30/60/90 aging)

## Problem

Cutting a child sheet (e.g. 18×23") out of an odd parent size (e.g. 25×30") leaves usable
rectangular offcut strips. Today those strips vanish — there is no way to bank them as stock,
offer them to future jobs, or see how long they have been lying in the plant. Separately, the
warehouse has no aging control: nothing shows how stale any batch or FG lot is.

## Decisions (locked)

1. **Capture point:** planning time, committed upfront. The Planning Engine shows the expected
   leftover when the board is picked; the planner decides push-to-warehouse there. Booking
   happens automatically when the cutting stage completes, from actual quantities.
2. **Master identity:** one leftover master per unique (source board, strip L×W), coded
   `LO-<sourceMaterialId>-<L>X<W>`. Stock from different jobs merges into that master; every
   job contributes its own dated batch, so per-lot aging, FIFO, and job traceability survive.
3. **Data model:** reuse `materials` + `stock_batches`. A leftover is a board material with a
   `leftover` flag. FIFO issue at cutting, WarehousePicker, Smart Match, childFit, the stock
   ledger and PR shortage math all work unchanged.
4. **Aging scope:** all warehouse stock — raw-material batches AND finished-goods lots —
   bucketed 0–30 / 31–60 / 61–90 / 90+ days (green / amber / orange / red).

## A — Data model

`server/src/db.js` migrations section:

- `ALTER TABLE materials ADD COLUMN IF NOT EXISTS code TEXT` + unique index where not null.
  Existing materials keep `code = NULL`; only leftover masters get codes for now.
- `ALTER TABLE materials ADD COLUMN IF NOT EXISTS leftover INTEGER NOT NULL DEFAULT 0`.
- `ALTER TABLE materials ADD COLUMN IF NOT EXISTS source_material_id INTEGER REFERENCES materials(id)`.
  Ties the leftover to its parent board — Smart Match treats it as the same family/GSM.
- `ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS leftover_plan JSONB`.
  Shape: `{ push: bool, strip: { l, w }, strips_per_parent: int, est_sheets: int, decided_by, decided_at }`.
  Null = no decision / no usable strip.
- Extend `stock_movements.type` CHECK to add `'leftover_in'` (drop + re-add constraint, same
  pattern as previous CHECK migrations).

**Master find-or-create rule** (server helper `findOrCreateLeftoverMaster`): match existing
`materials` row with `leftover=1`, same `source_material_id`, and `sheet_l/sheet_w` within 0.01"
(both orientations — a 7×30 strip equals a 30×7 strip). Otherwise insert:
`name = "Leftover — <parent name> <L>×<W>"`, `category='board'`, `unit='sheets'`,
`sheet_l/sheet_w` = strip dims, `spec` copied from parent, `code = LO-<parentId>-<L>X<W>`
(dims formatted trimmed, e.g. `LO-42-7X30`), `reorder_level=0`.

**Batches:** `stock_batches` row per booking — `batch_no = 'LO-' + jc_number`, status
`'available'` immediately (internal offcut, no GRN quarantine), plus a `leftover_in` ledger
movement referencing the job stage and an audit entry.

## B — Planning Engine "Leftover" card

**Server:** `GET /planning/:lineId/context` (and its `?board_material_id=` preview) gains a
`leftover` object computed from the effective board + product child dims. Guillotine remainder
for the winning childFit orientation with `nL = floor(PL/cl)`, `nW = floor(PW/cw)`:

- strip 1: `(PL − nL·cl) × PW`
- strip 2: `(nL·cl) × (PW − nW·cw)`

Each strip reports dims, strips-per-parent (1 each), `usable` flag (both dims ≥ 3", else
greyed as waste), and `est_sheets = sheets_required` (one strip of each kind per parent cut).
Zero-width strips are omitted. `leftover: null` when the board fits with no usable remainder.

**Client (Planning.jsx engine modal):** new "Leftover" card in the right column under Board
Position. Shows the strip options as size chips with estimated sheets; a toggle **"Push to
warehouse after cutting"** and a strip selector (single choice; unusable strips disabled).
This is the ask-the-planner step — decided once per line at planning. Choice is included in
the plan POST and stored in `order_lines.leftover_plan`. Re-saving the plan with a different
board recomputes and overwrites the decision; the card reflects the saved state on reopen.
Amber "edited" chip conventions and glass styling follow the existing engine cards.

## C — Auto-booking at cutting + reuse

**Booking:** in the cutting branch of `POST /job-stages/:id/complete` (production.js), inside
the same transaction: if the job card's order line has `leftover_plan.push`:

1. qty = `strips_per_parent × parents actually cut` where parents = `st.qty_in` (received
   parent sheets), not the planned figure.
2. `findOrCreateLeftoverMaster` → insert batch → `leftover_in` movement → audit
   (`job_stage` ref, note names the JC and strip size).
3. **Idempotency:** skip if a batch with this `batch_no` already exists (stage adjustment or
   retry cannot double-book). Stage adjustments to cutting qty do NOT retro-adjust the booked
   leftover — corrections go through the normal inventory adjustment screen (documented
   limitation, keeps history honest).

**Reuse:** because leftover masters are `category='board'` materials with real stock:

- `GET /warehouse/paper` (WarehousePicker) includes them automatically; add a "Leftover"
  badge (from the flag) and a leftover-only filter toggle.
- Smart Match (`server/src/smartmatch.js`): leftovers join candidate boards via
  `source_material_id` inheriting the parent's family/GSM identity; when a leftover fits
  (childFit count ≥ 1) it ranks **above** fresh parent sheets so offcuts get consumed first.
- Cutting consumes leftover stock FIFO via the untouched `consumeFifo` path.

## D — Leftover view + warehouse aging

**Server:** `GET /inventory/aging` returns, in one payload:

- `raw`: available `stock_batches` joined to materials — per batch: material, code, leftover
  flag, source JC (parsed from batch_no for leftovers), qty, `age_days = now − created_at`,
  bucket.
- `fg`: `fg_lots` with remaining qty (`qty − consumed_qty`, status `verified` or
  `pending_verification`) — per lot: product, lot number, qty, age_days, bucket.
- `summary`: per-bucket totals (batch count + sheet/pc qty) for raw and FG.

Buckets: 0–30 green, 31–60 amber, 61–90 orange, 90+ red.

**Client (Inventory.jsx):** two new tabs using the existing segmented-control Tabs:

- **Leftovers** — leftover masters with code, size, source board, total available, and
  expandable per-lot rows (source JC, qty, age chip). Row actions: adjust / write-off via the
  existing `/inventory/adjust` flow.
- **Aging** — four summary cards (one per bucket) over a combined oldest-first table with a
  Raw / FG / Leftover filter. Age chips coloured by bucket.

Inline age chips also appear on the existing Inventory stock table (per batch) and on the
Finished Goods page (per lot). Print views unaffected.

## Error handling

- Booking is transactional with the stage completion — both commit or neither.
- Idempotent batch_no guard prevents double-booking on retry/adjustment.
- Dedup tolerance 0.01" on both orientations prevents near-duplicate masters.
- Declined push (`leftover_plan.push=false` or null) = no-op at cutting.
- Leftover masters are excluded from PR/procurement suggestion flows (you cannot purchase an
  offcut) — guard by `leftover=0` in procurement queries.

## Testing

New scratchpad suite `uat-leftover.mjs` against real migrated data, following the uat-*.mjs
pattern (login, self-provision stock, assert steps):

1. Plan a line on an odd board → context returns strips; save plan with push=true.
2. Complete cutting → master auto-created with code, batch credited with actual qty,
   `leftover_in` movement present; re-complete/adjust does not double-book.
3. Second job, same board + strip → same master, second batch (merge rule).
4. Leftover appears in `/warehouse/paper` and in smart-match results ranked first when it fits.
5. Plan a new line onto the leftover → cutting consumes it FIFO.
6. `/inventory/aging` buckets a backdated batch correctly; FG lots included.
7. Declined push books nothing; procurement suggestions exclude leftover masters.
