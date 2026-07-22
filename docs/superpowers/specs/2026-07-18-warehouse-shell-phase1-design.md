# Phase 1 — Warehouse Shell & RM-Leftover-at-Planning

**Date:** 2026-07-18
**Status:** Approved (design) — pending implementation plan
**Scope:** First of four phases in the Finished-Goods / Leftover / Dispatch program.

---

## Program context (the 4 phases)

This spec is **Phase 1 only**. The full program, agreed with the user, is:

1. **Phase 1 — Warehouse shell** *(this doc)*: two leftover tabs (RM + FG), inline aging in the RM/FG list views (remove the standalone Aging tab), split the aging distribution bar per RM/FG, and bank the RM board offcut at **planning-save** time.
2. **Phase 2 — Unified QC + Finished Goods module**: merged module, one-step inspector stamp + audit, Leftover-FG **box** create (auto `CI-BOX-####`, editable), Planning consumption of leftover boxes via the existing carton→artwork→product mapping.
3. **Phase 3 — FG movement + tolerance engine**: FG-list checkboxes with three controls (*Keep in FG* / *Move to Dispatch* / *Move to Leftover*), single-order tolerance, then multi-order cascade allocation across sales orders for the same product.
4. **Phase 4 — Documents**: Sort & Paste box narration carried onto the **Challan** and **Invoice**; invoice inline editing (delete item / push back to FG / push to Leftover).

Each phase gets its own spec → plan → implementation cycle. **No git commits** are made in ci-erp (per standing user rule); the running instance may not hot-reload, so verification uses a temp server on a spare port against live Postgres.

---

## Phase 1 goals

- Make the Warehouse page clearly separate the **two kinds of leftover**: raw-material board offcuts vs finished-goods excess.
- Put **stock age** where it is actually read — inline in the RM and FG stock lists — instead of a separate tab/button, with a per-list distribution bar.
- Reflect a planned board **offcut in the warehouse the moment the cut is locked in Planning**, robustly (no double-count, no orphaned stock).

## Non-goals (Phase 1)

- No box numbers / `CI-BOX-` scheme yet (Phase 2). The Leftover FG tab in Phase 1 simply renders existing `fg_lots`.
- No changes to QC, dispatch, tolerance, challan, or invoice (Phases 2–4).
- No change to how the parent board itself is consumed (still FIFO at cutting-start).

---

## Current-state facts (verified)

- Warehouse UI: `client/src/pages/Inventory.jsx`. Tabs at `Inventory.jsx:60-67` = RM Stock, FG Stock, RM Batches, Leftovers, Aging, Movement Ledger.
- Aging tab (`Inventory.jsx:157-196`) shows 4 bucket cards that **combine** raw+fg counts (`Inventory.jsx:163`) + a filter + a table. Backed by `GET /inventory/aging` (`server/src/routes/inventory.js:173-199`) returning `{ raw[], fg[], summary:{raw,fg} }`. `fg` aging is derived from **`fg_lots`**, not plain `fg_stock`.
- Leftovers tab (`Inventory.jsx:127-155`) = board offcuts: `LO-` masters + dated lots, from `GET /inventory/leftovers` (`inventory.js:202-219`, `materials.leftover=1`).
- FG Stock list (`Inventory.jsx:93-109`) from `GET /inventory/fg` (`inventory.js:50-58`): `fg_stock (product_id, qty)` — **no date column**, so no intrinsic age.
- RM Stock list (`Inventory.jsx:69-91`) from `GET /inventory/stock` (`inventory.js:10-28`): per-material aggregate of `stock_batches`.
- `AgeChip` component already exists (imported `Inventory.jsx:4`).
- **Planning cut-save**: `POST /order-lines/:id/plan` (`server/src/routes/orders.js:821`), called from `savePlan()` (`client/src/pages/Planning.jsx:418-419`). Writes `sheets_required`, `parent_sheets_required`, `spec_override`, `leftover_plan`, moves `pending→planned` (`orders.js:955`). **Writes zero stock movements.**
- `order_lines.leftover_plan` JSONB (`db.js:641`), shape `{push, strip:{l,w}, strips_per_parent, est_sheets, decided_by, decided_at}` (`orders.js:915-916`); UI card `Planning.jsx:1291-1322`; server validation `orders.js:908-920`.
- **Board consumed** at cutting **stage-start** via `consumeFifo` (`production.js:359-371`, type `consumption`).
- **Leftover currently banked** at cutting **stage-complete** (`production.js:871-907`): `findOrCreateLeftoverMaster` (`helpers.js:127-146`, code `LO-<srcId>-<L>X<W>`), qty `strips_per_parent × actual-parents-cut`, `stock_batches batch_no LO-<jc_number>` + `stock_movements type='leftover_in'` `ref_type='job_stage'`. Idempotency guard on `batch_no` (`production.js:889-891`). Gang-parent cards skipped (`production.js:876-881`).
- Reverse/rollback/delete of leftovers: `reverse_plan` nulls `leftover_plan` (`workflow.js:120-124`); force-delete reverses `leftover_in` by `ref_type='job_stage'` (`helpers.js:866-881`); `rollbackLine` nulls `leftover_plan` (`helpers.js:1003`).
- `leftoverStrips(parent, child)` (`helpers.js:106-122`); cut-variance true-up at complete uses `adjustBoardStock(..., parentDelta, ...)` (`production.js:849`, helper `helpers.js:190-237`).

---

## Design

### A. Two leftover tabs

- **Rename** the `leftovers` tab label from "Leftovers" → **"Leftover RM"** (`Inventory.jsx:64`). Data, endpoint (`/inventory/leftovers`) and rendering unchanged.
- **Add** a `leftovers_fg` tab → **"Leftover FG"**. New endpoint `GET /inventory/leftover-fg` returning `fg_lots` (join products/customers), columns: lot/box no · product · customer · qty (`qty - consumed_qty`) · source · `age_days` · status. Reuse the FG-lot query already in `inventory.js:182-188` (the `fg` half of `/inventory/aging`), filtered to `status IN ('pending_verification','verified','consumed')` with remaining shown.
  - Phase 2 will add `box_number` / `kind` columns; the Phase 1 tab renders `lot_number` in the "Box / Lot" column so the UI needs no change when Phase 2 lands.

### B. Inline aging — remove the Aging tab

- **Remove** the `aging` tab (`Inventory.jsx:65`) and its panel (`Inventory.jsx:157-196`), plus the `agingFilter` state (`Inventory.jsx:16`).
- **RM Stock** (`GET /inventory/stock`): add per-row `age_days` = age of the **oldest `available` batch with qty > 0** for that material (`MIN(created_at)` over available batches → days). Add a `buckets` object (0-30/31-60/61-90/90+ counts) to the response payload (as a sibling of the rows, e.g. `{ rows, buckets }`, or a second lightweight endpoint — implementation plan decides). UI:
  - New column **"Age in stock"** rendering `<AgeChip days={m.age_days} />` (null when 0 stock).
  - A slim 4-bucket distribution bar above the RM Stock table.
- **FG Stock** (`GET /inventory/fg`): plain `fg_stock` has no date, so derive **FIFO age** = age of the earliest `fg_receipt` movement (`stock_movements type='fg_receipt'`, positive) for the product whose cumulative qty is still un-dispatched. Simplest honest approximation: age of the **oldest `fg_receipt` still covered by current on-hand qty** (walk receipts oldest-first, subtract dispatched). Add per-row `age_days` + a `buckets` summary.
  - New column **"Age in stock"** + its own 4-bucket bar → this is the **split** of the previously-combined RM+FG bar.
- Leftover RM / Leftover FG lists keep their existing per-row age chips.
- The `/inventory/aging` endpoint may be retained purely for the Export menu, or removed if unused after the tab goes — implementation plan decides (prefer removing to avoid dead code).

### C. RM board offcut banked at planning-save

**Trigger:** inside `POST /order-lines/:id/plan` (`orders.js:821`), in the same `tx`, after the plan validation block (`orders.js:908-933`), when the resolved `leftover_plan.push === true` and a valid `strip` is present.

**On bank:**
1. Resolve source board (effective `board_material_id`), call `findOrCreateLeftoverMaster(srcBoard, strip, qc, oc)` (`helpers.js:127`).
2. Compute **planned** qty = `strips_per_parent × parent_sheets_required`.
3. Upsert an idempotent leftover batch keyed **per line**: `batch_no = 'LO-PLAN-' + line.id`.
   - If it exists (re-plan), **deplete/rewrite** it to the new master + new planned qty (and write a compensating `leftover_in` delta movement).
   - Else insert `stock_batches (…, batch_no='LO-PLAN-<id>', status='available')` + `stock_movements (type='leftover_in', ref_type='order_line', ref_id=line.id, qty=+planned)`.
4. Audit `('order_line', line.id, 'leftover_planned', …)`.
5. Add a discriminator so the UI can distinguish planned vs confirmed leftover — store `origin` on the batch. Since `stock_batches` has no free column, encode via the `batch_no` prefix (`LO-PLAN-` = planned, `LO-<jc>` = confirmed) and expose a derived `origin` field in `/inventory/leftovers` (`inventory.js:211-217`). Leftover RM tab shows a **"planned" / "confirmed"** badge.

**Gate cutting-complete** (`production.js:871-907`): before banking, check for an existing `LO-PLAN-<order_line_id>` batch for this card's line.
- If present: **do not insert a new `LO-<jc>` batch.** Instead **true up** the planning batch to actuals: delta = `strips_per_parent × (actual_parents_cut − planned_parents)`; apply `adjustBoardStock`-style delta to the `LO-PLAN-` batch and, if you want the confirmed provenance, rename its `batch_no` to `LO-<jc_number>` (or keep `LO-PLAN-` and flip `origin` to confirmed via a marker). Implementation plan picks one; **must remain idempotent**.
- If absent (planner didn't opt in at planning, but opts in later / legacy): keep today's behavior (bank `LO-<jc>` at complete).

**Reverse / rollback / delete — un-bank the planning batch:**
- `reverse_plan` (`workflow.js:120-124`): also reverse the `order_line`-keyed `leftover_in` and deplete `LO-PLAN-<id>`.
- `rollbackLine` (`helpers.js:933`, `:1003`): same.
- Force-delete (`helpers.js:866-881`): extend the reversal to also match `ref_type='order_line'` leftover rows, not just `job_stage`.

**Exclusions:** gang-parent cards keep the existing carve-out (`production.js:876-881`); planning-save banking applies only to direct order-line cuts. Gang-run plan-save (`Planning.jsx:586`, `/gang-runs/:id/plan`) does **not** bank leftover in Phase 1.

**Accepted trade-off (user-confirmed):** the offcut appears in Leftover RM before the parent board is physically consumed at cutting-start; the "planned" badge signals this.

### D. Verification

Unit tests:
- planning-save banking creates one `LO-PLAN-<id>` batch + `leftover_in`; a second lock (re-plan) rewrites rather than duplicates.
- cutting-complete with an existing planning batch trues up by variance and does **not** create a second batch (over-cut and under-cut cases).
- reverse_plan / rollback / force-delete remove the planning leftover (no orphan).

End-to-end: temp server on a spare port against live Postgres (`:5439`), seed a UAT order, plan a cut with a pushed strip, confirm Leftover RM shows a **planned** lot; complete cutting, confirm it flips to **confirmed** with trued-up qty; reverse and confirm it disappears. Confirm inline aging renders in RM and FG lists and the split bars show. Verify in the real running app at desktop breakpoint.

---

## Data / API summary

- **No new tables.** New batch_no convention `LO-PLAN-<order_line_id>`; new movement provenance `leftover_in` with `ref_type='order_line'`.
- **New endpoint:** `GET /inventory/leftover-fg`.
- **Changed endpoints:** `GET /inventory/stock` (+`age_days`, `buckets`), `GET /inventory/fg` (+`age_days`, `buckets`), `GET /inventory/leftovers` (+`origin` planned/confirmed), `POST /order-lines/:id/plan` (bank leftover), `POST` cutting stage-complete (gate + true-up), `reverse_plan`, `rollbackLine`, force-delete (un-bank).
- **Removed:** Aging tab UI; possibly `GET /inventory/aging` if unused.
- **UI:** `Inventory.jsx` tab rename + new tab + two inline age columns + two distribution bars − Aging panel; Leftover RM planned/confirmed badge; `Planning.jsx` leftover card copy tweak ("banked on lock" vs "after cutting").

## Open items for the implementation plan

- Exact response shape for `buckets` (inline in stock/fg payload vs a tiny separate endpoint).
- Whether cutting-complete renames `LO-PLAN-` → `LO-<jc>` or keeps the plan key and flips a marker.
- Whether `/inventory/aging` is deleted or retained for export only.
