# Daily Production Runs, Order Fulfilment & Warehouse Manual Stock — Design

Date: 2026-07-20
Status: Awaiting review

## Problem

Four requests from the floor, all rooted in one structural gap:

1. On a large order (e.g. 5 lakh) production runs for days — 1 lakh pasted per day. There is no way to record that.
2. After pasting, the operator needs a popup that tells them — from order qty — whether the order is fulfilled, shows the order context, and lets them confirm. Fulfilled → close out and surface wastages. Not fulfilled → mark pending, production continues.
3. In pasting and sorting, when a wastage count is entered, the **printing operator** and **dies operator** names must appear (read-only) for accountability.
4. Warehouse needs an "Add Stock" button to manually book FG stock and leftover stock.

Anik confirmed the multi-day pattern also occurs at **printing and coating**, not just pasting and die cutting.

## Root cause

Every station in ci-erp is single-shot. `job_stages` carries exactly one `started_at`/`completed_at` pair and one `qty_out`/`qty_scrap` pair. Output is recorded by one `complete` call; the only correction path is `reverse`, which **deletes** child rows (`pasting_rows`, `packing_lines`) and resets the stage.

Sort & Paste hardens this further: pasting rows must sum to *exactly* the sorted-good qty (`server/src/routes/production.js:1054`), 409 otherwise.

Nothing in the schema can express "1 lakh on the 14th, 1 lakh on the 15th".

## Design decisions

### D1 — One generic run log, not four bespoke implementations

Because this affects printing, coating, die cutting and pasting, the fix is a single child table applied to **all** stages, following the existing house pattern (child table keyed on `job_stage_id`, `ON DELETE CASCADE`, as used by `pasting_rows` and `packing_lines`).

### D2 — `stage_runs` is authoritative for every stage, including single-shot ones

A normal one-shot completion writes exactly **one** run. `job_stages.qty_out` / `qty_scrap` remain in place but become a cached rollup maintained by one helper.

Rejected alternative: leave `complete` untouched and add a parallel "partial mode". That gives every station two ways to produce output, forcing `adjust`, `reverse`, `stock_movements` and the gang-split to handle both. One code path is worth the wider migration.

Consequence: every downstream consumer (dashboards, `fulfilment_pct`, pendency, Status Sheet, exports) keeps reading `job_stages.qty_out` and never learns runs exist.

### D3 — Stage input becomes a running balance, not a fixed handoff

Today `qty_in` is fixed when the stage starts. Once upstream stages also produce daily, that is no longer true — pasting can only paste what die cutting has cumulatively produced so far.

The guard at `production.js:775` (`qty_out + qty_scrap <= qty_in`) is replaced by:

```
cumulative(good + scrap) at this stage  <=  upstreamAvailable(stage)
```

where `upstreamAvailable` = previous stage's current `qty_out` if a previous stage exists, else the stage's own `qty_in`. Cutting (first stage) keeps its existing over/under-cut variance behaviour untouched.

This completes the inline-start decoupling already in the codebase (every station startable any time; order enforced at COMPLETE).

### D3a — The ceiling must include CI-XS extra sheets (found during implementation)

D3 as first written was wrong, and it would have caused a production stoppage.

The CI-XS extra-sheets flow issues sheets directly to a running stage. Its only effect is to bump **that stage's own `qty_in`** (`extrasheets.js:199`); it never touches the previous stage's `qty_out`. A ceiling read purely from `prev.qty_out` therefore under-reports the real available input, and would reject a stage that had been legitimately topped up — exactly the scenario CI-XS exists to handle.

The ceiling is therefore:

```
cutting                → uncapped (null)
previous stage exists  → prev.qty_out (0 if it has produced nothing) + extra sheets issued to this stage
no previous stage      → max(own qty_in, extra sheets issued)
```

The `max` in the last line matters: for a *first* stage, CI-XS has already bumped `qty_in`, so adding the extras again would double-count. A first stage whose `qty_in` is still null (deferred by the inline-start decoupling) with no extras is uncapped, not a ceiling of zero.

This lives in the pure `availableCeiling()` in `stage-runs.js`; `upstreamAvailable()` is a thin DB wrapper over it.

Known duplication: `upstreamAvailable` repeats the `children_per_parent` unit conversion from `extrasheets.js:199` rather than importing a shared helper. If that rule ever changes, both must change together.

### D4 — Runs do not write stock movements; completion still does

Blast-radius control. A run records production only. The aggregate wastage `stock_movements` row is written at stage completion, exactly as today. Waste therefore lands in the inventory ledger at close, which matches current behaviour.

### D5 — The fulfilment popup only fires on carton-unit stages

`job_stages.unit` is `sheets` or `cartons`. Order qty is in pieces/cartons. Comparing a printing run (sheets) against order qty is meaningless.

Rule: the fulfilment popup fires only when the stage's `unit = 'cartons'` **and** it is the last non-QC stage of the job card. In practice this is pasting. Sheet-unit stages get the run log only.

### D6 — Manual FG stock lands as `pending_verification`

The schema is already shaped for manual entry — `fg_lots.source` has a `'manual'` value and `fg_movements.movement_type` has `'manual_adjustment'` — but **no route ever writes them**. Manual lots enter at `pending_verification` so a second person must verify, preventing phantom stock from a typo.

## Schema changes

```sql
CREATE TABLE IF NOT EXISTS stage_runs (
  id            SERIAL PRIMARY KEY,
  job_stage_id  INTEGER NOT NULL REFERENCES job_stages(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  run_date      DATE NOT NULL DEFAULT CURRENT_DATE,
  shift         TEXT,
  qty_good      INTEGER NOT NULL DEFAULT 0,
  qty_scrap     INTEGER NOT NULL DEFAULT 0,
  scrap_reason  TEXT,
  machine_id    INTEGER REFERENCES machines(id),
  operator      TEXT,
  -- snapshots taken when qty_scrap > 0, so history survives upstream adjustment
  up_printing_operator TEXT,
  up_die_operator      TEXT,
  note          TEXT,
  created_by    TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_stage_runs_stage ON stage_runs(job_stage_id);
CREATE INDEX idx_stage_runs_date  ON stage_runs(run_date);
```

Also:

- `job_stages_status_check` (`db.js:557`) gains `'partially_completed'`.
- `order_lines` gains `production_fulfilled_at TIMESTAMPTZ`, `production_fulfilled_by TEXT`, `short_close_reason TEXT`.

**Backfill migration** (idempotent, in the dated `ALTER` style of `db.js`): for every `job_stages` row with `status='completed'`, `qty_out IS NOT NULL` and no existing runs, insert one run — `run_date = completed_at::date`, `qty_good = qty_out`, `qty_scrap = qty_scrap`, carrying `machine_id` and `operator`, `note = 'backfill'`.

## Server changes

New helper in `helpers.js`:

- `recalcStageFromRuns(qc, oc, stageId)` — sums runs into `job_stages.qty_out` / `qty_scrap`. No-op when the stage has no runs.
- `upstreamAvailable(qc, stageId)` — resolves the running-balance ceiling described in D3.

New routes (`production.js`, existing `tx(qc, oc)` + `next(e)` style):

| Route | Purpose |
|---|---|
| `GET /api/job-stages/:id/runs` | list runs for a stage |
| `POST /api/job-stages/:id/runs` | record a day's output; recalc; may return the structured 409 |
| `PUT /api/job-stages/:id/runs/:runId` | correct a run; recalc |
| `DELETE /api/job-stages/:id/runs/:runId` | remove a run; recalc |

Modified:

- `POST /job-stages/:id/complete` — writes its single run through the same path instead of setting `qty_out` directly.
- `POST /sort-paste/:id/complete` — the exact-match reconciliation at `production.js:1054` becomes a *cumulative* check against the sorted-good pool, so a partial day is legal.
- `STAGE_VIEW` (`floor.js:71-113`) — add lateral subqueries exposing `printing_operator` and `die_operator` from sibling `job_stages` rows.

## The fulfilment popup

On `POST /runs`, after recalc, when D5's conditions hold and cumulative good has reached or crossed the ordered qty, the route throws a structured 409 — the same pattern as `TOLERANCE_EXCEEDED` (`dispatch.js:135`) and `PRODUCT_STRENGTH_COLLISION`:

```
{
  code: 'ORDER_QTY_REACHED',
  line: { order_no, customer, product, artwork, ordered_qty, tolerance_pct,
          allowed_max, produced_good_cum, produced_scrap_cum, this_run,
          balance, suggestion: 'fulfilled' | 'pending' },
  wastage: { total, by_stage: [{ stage, qty_scrap, reason, operator }] }
}
```

`suggestion` is the system's read: `'fulfilled'` when `produced_good_cum >= ordered_qty`, else `'pending'`. It is a suggestion — the operator decides.

The client suppresses the global toast (`api.js:31` already does this for any response carrying `code`) and opens a `<Modal>` showing the order context and the suggestion. The operator re-POSTs the same run with:

- `fulfilment: 'fulfilled'` → stage moves to `completed`, `order_lines.production_fulfilled_at/by` set, downstream unlocked, and the **wastage summary** is returned for display and export.
- `fulfilment: 'pending'` → run is saved, stage stays `partially_completed`, production continues.

Short-closing below ordered qty is permitted but requires `short_close_reason`.

The wastage summary reuses the existing export engine (`exporter.js`) for PDF/XLSX.

## Operator name display

When a wastage count is entered (`qty_scrap > 0`), the run form reveals two **read-only** chips — "Printing operator" and "Dies operator" — sourced from the sibling `job_stages` rows (`stage='printing'` / `'die_cutting'`), which `GET /print-planning` already exposes as `printing_operator`.

Applies to the Sort & Paste wastage panel (`SortPaste.jsx:617-644`) and the Section wastage form (`Section.jsx:1000-1006`). On save the two names are snapshotted onto the run so the record stays stable if the upstream stage is later adjusted.

## Warehouse manual stock

Two new endpoints, both role-gated by the existing `canAdjust`:

- `POST /api/fg-lots/manual` — `{ product_id, qty, box_count, qty_per_box, loose_qty, location, reason, note }`. Creates an `fg_lots` row with `source='manual'`, `status='pending_verification'`; increments `fg_stock`; writes `fgMove(movement_type='manual_adjustment', source_module='warehouse')`.
- `POST /api/inventory/leftovers/add` — `{ source_material_id, width, length, qty, note }`. Calls the existing `findOrCreateLeftoverMaster()` (`helpers.js:124`), creates a `stock_batches` row numbered `LO-MANUAL-######`, writes a `stock_movements` row of type `'leftover_in'`.

UI: an "+ Add Stock" button on Inventory → RM Stock → Leftover (`Inventory.jsx:162`) and on Finished Goods → Lots (`FinishedGoods.jsx`), each opening a `<Modal>` with the existing `<Field>`/`<Input>`/`<Select>` primitives.

## Phasing

| Phase | Scope | Depends on |
|---|---|---|
| 1 | `stage_runs` table, backfill, `recalcStageFromRuns`, `upstreamAvailable`, run CRUD routes, `complete` rewired, running-balance guard | — |
| 2 | Fulfilment popup, `ORDER_QTY_REACHED` 409, wastage summary + export | 1 |
| 3 | Upstream operator reveal on wastage entry | 1 |
| 4 | Warehouse manual FG + leftover add-stock | none (independent) |

Phase 4 is independent and can ship at any point.

## Risks

- **Phase 1 touches every station's completion path.** Mitigation: `stage_runs` is additive, the backfill is idempotent, and `job_stages.qty_out` keeps its meaning, so every read path is unchanged.
- **D3 relaxes a guard that currently prevents over-production at every stage.** The running-balance ceiling must be verified against a real multi-stage job card before it is trusted.
- **`pasting_rows.waste_qty` is not trustworthy per-row today** — the client lumps all derived paste waste onto row 0 (`SortPaste.jsx:232-239`) purely to satisfy server reconciliation. Waste-by-method reporting is not real data and should not be built on until that is fixed. Out of scope here; noted so it is not assumed.

## Verification

Per the project convention, server changes are verified against a temporary server on a spare port reusing live PG `:5439` — the running instance may be plain `node` and not hot-reload. UI changes are verified in the real running app at a desktop breakpoint, logged in, never against a mock.

Test job card: a seeded UAT-* order large enough to require three runs across three dates, carried through die cutting and pasting, then reversed and deleted. All cleanup scoped to `UAT-*` markers — never an unscoped DELETE on the shared database.
