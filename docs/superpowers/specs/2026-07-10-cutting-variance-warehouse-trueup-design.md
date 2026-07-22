# Cutting Variance & Warehouse True-Up — Design

**Date:** 2026-07-10
**Status:** Approved design, ready for implementation plan
**Module:** Production (cutting station) + Warehouse/Inventory

## Problem

A job card plans a fixed number of parent (mother) sheets — e.g. 1400. In practice the
cutting section often cuts a **different** number: a sealed packet is intact and the operator
is bound to cut the whole bundle (say 1500), or a packet comes up short (1300). Today the
system:

- consumes board from the warehouse at cutting **start**, based on the *planned* `sheets_issued`
  (see `server/src/routes/production.js:236-247`), and
- **hard-blocks** completion with a 409 when child output + scrap exceeds
  `qty_in × children_per_parent` (`server/src/routes/production.js:573-579`).

So the true quantity cut is never recorded, the warehouse stock does not reflect what was
physically consumed, and the legitimate "I had to cut the full packet" case is blocked.

## Goal

When cutting cuts more (or fewer) sheets than the job card:

1. **No hard blocker** — the operator can always record the true numbers.
2. An **alarming popup** at the cutting station when the entered quantity differs from the job
   card, requiring a short **explanation** (preset reason + optional note).
3. The **warehouse is trued-up in real time** by the derived parent-sheet delta — consuming
   extra board on over-cut, refunding board on under-cut.
4. The **next station is issued the true child-sheet count** (already handled by the existing
   completion path — the full `qty_out` propagates forward).
5. Every variance is **recorded** in a reviewable register for reporting.

## Model (confirmed with user)

- The **operator types the child print-sheets** (`qty_out`, plus any `qty_scrap`) at cutting
  **Complete** — the existing fields. **The system derives the parent count** and effects the
  warehouse accordingly.
- Warehouse stock is held in **parent (mother) sheets**. `children_per_parent` (`cpp`) is the
  conversion.
- **No blocking at all** — if the derived board exceeds what is on hand, stock is allowed to go
  negative/short and surfaces as a warehouse reconcile alarm. Cutting still proceeds.
- **Symmetric true-up** — under-cutting refunds the difference back to warehouse stock.
- **Reason capture** — preset dropdown + optional free-text note.

## The calculation

On completing a `cutting` job stage, in the **same transaction** as the completion:

```
cpp             = max(1, children_per_parent)
plannedParents  = sheets_issued            // job-card figure (= cutting qty_in today)
childrenHandled = qty_out + qty_scrap       // both counted in child print-sheets
actualParents   = round(childrenHandled / cpp)   // derived, shown to operator for transparency
parentDelta     = actualParents - plannedParents
```

- `parentDelta > 0` (**over-cut**): consume `parentDelta` additional parent sheets of the
  **effective** board material (line `spec_override.board_material_id` → product
  `board_material_id`) via FIFO, **allowing the final batch to go negative** — never blocks on
  insufficient stock.
- `parentDelta < 0` (**under-cut**): refund `-parentDelta` parent sheets back to warehouse
  stock (newest available batch of the same board material).
- `parentDelta != 0`: a **reason is required**; backend returns 400 if missing. This gates the
  *record*, not the cut. Then:
  - set job-card `sheets_issued = actualParents`, and cutting stage `qty_in = actualParents`, so
    every downstream count, the leftover-offcut booking, and all reports read the true number.
  - write a `cutting_discrepancies` row + `audit` + universal-timeline milestone.
- `parentDelta == 0`: normal completion, no popup, no record.

**Ordering note:** the true-up (which rewrites `qty_in`/`sheets_issued` to `actualParents`) must
run **before** the existing planned-leftover offcut booking at
`server/src/routes/production.js:622-658`, whose comment already intends to bank "from the ACTUAL
parents cut (qty_in)". After this change that intent becomes literally true.

**Rounding assumption:** `qty_out` and `qty_scrap` at cutting are both counted in child
print-sheets (the stage's output unit); a cut parent yields `cpp` children whether or not all are
kept, so `actualParents = round(childrenHandled / cpp)`. This is stated explicitly so it can be
revisited if the plant counts scrap in parent sheets instead.

## Hard cap → soft alarm

The `qty_out + qty_scrap > qty_in × cpp` **409 block at `server/src/routes/production.js:573-579`
is removed for the `cutting` stage only.** All other stages keep the cap unchanged — their
overages route through the existing approval-based extra-sheet flow (`routes/extrasheets.js`).
Cutting instead alarms + records via the flow above.

The same relaxation is applied to the **stage-adjustment** cap for cutting
(`server/src/routes/production.js:706-708`) so a post-hoc correction of a completed cutting stage
can also record a variance rather than being blocked; the adjust path reuses the same derive +
true-up + record logic.

## Station UI — the popup

When the entered numbers imply `parentDelta != 0`, before the Complete request is sent, the
cutting station shows a confirmation popup:

```
⚠  Cutting more than the job card
    Job card:      1400 parents
    You're cutting: 1500 parents   (+100)
    Board on hand:  60             ⚠ exceeds board on hand
    Reason ▾  [ Packet intact – full bundle cut ]
    Note      [ optional … ]
    [ Confirm & record ]     [ Cancel ]
```

- Shows the **derived parent count** and signed delta so the operator understands the warehouse
  effect.
- If derived board exceeds board on hand, an extra inline warning appears — still confirmable
  (no block).
- Handles under-cut symmetrically (shows `-100`, "returning to stock").
- **Never hard-blocks** — the only requirement is choosing a reason.

**Preset reasons:** Packet intact – full bundle cut · Board damaged · Extra for wastage buffer ·
Short board / packet short · Miscount / recount · Other. `Other` reveals/relies on the note.

## The record — `cutting_discrepancies`

New table:

| column                  | notes                                                     |
|-------------------------|-----------------------------------------------------------|
| id                      | pk                                                        |
| job_card_id             | fk                                                        |
| job_stage_id            | fk (the cutting stage)                                    |
| cpp                     | children_per_parent at the time                           |
| planned_parents         | sheets_issued before true-up                              |
| actual_parents          | derived                                                   |
| parent_delta            | actual − planned (signed)                                 |
| planned_children        | plannedParents × cpp                                      |
| actual_children         | qty_out + qty_scrap                                       |
| board_material_id       | effective board material trued-up                         |
| board_available_before  | stock on hand at capture (for shortage reporting)         |
| reason_code             | preset reason                                             |
| note                    | optional free text                                        |
| created_by              | user name                                                 |
| created_at              | timestamp                                                 |

Surfaced as a **Cutting Variances** register: filter + export via the existing export engine
(`exporter.js` / DataTable `exportName`), plus an `audit` entry and a **universal-timeline**
milestone so the variance appears on the job card and in warehouse history. A future roll-up
(variance by reason / by product / by month) is enabled by this table but out of scope here.

## Real-time warehouse impact

The board consume/refund writes `stock_movements` rows against the effective board material in
the same transaction, so the inventory views (which already sum `stock_batches`) reflect the true
stock immediately. Negative stock is permitted and should render as a **reconcile alarm** in the
warehouse view (visual affordance; exact styling follows existing warehouse alarm conventions).

## Out of scope (YAGNI)

- Any approval/gating workflow (explicitly rejected — this is inline, no-blocker).
- Variance analytics dashboards / roll-up reports (the table enables them later).
- Changes to non-cutting stages' caps or the extra-sheet request flow.
- Reconciliation tooling for negative stock beyond surfacing the alarm.

## Files touched (anticipated)

- `server/src/db.js` — `cutting_discrepancies` table DDL.
- `server/src/helpers.js` — a board-adjust helper that consumes FIFO allowing negative, and a
  refund helper (or extend `consumeFifo`); derive + record helper.
- `server/src/routes/production.js` — cutting Complete: remove cutting hard cap, derive parents,
  true-up warehouse, rewrite `sheets_issued`/`qty_in`, record; mirror in stage-adjust path.
- `server/src/routes/inventory.js` (or wherever the register is served) — Cutting Variances list
  endpoint.
- `server/src/routes/timeline.js` — variance milestone lookup (if needed).
- `client/src/pages/*` — cutting station Complete popup; Cutting Variances register page/tab;
  negative-stock alarm affordance in the warehouse view.

## Verification

- Server change verified via a temp server on a spare port reusing live PG :5439 (running
  instance may be plain `node`, not hot-reloading).
- UI verified in the real running app at desktop breakpoint (login, cutting station, warehouse),
  scoped to UAT-* markers only — never an unscoped mutation on shared data.
