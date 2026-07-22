# Print-Planning Completion System — Design

**Date:** 2026-07-10
**Module:** Print Planning kanban (`client/src/pages/PrintPlanning.jsx`, `server/src/routes/production.js`)
**Status:** Approved — proceeding to implementation plan

## Problem

Today a job card **vanishes** from the Print Planning board the instant its `printing`
stage hits `completed` — the board query filters `js.status != 'completed'`. There is
no visible "this run printed" moment, no record of finished runs on the board, and no
way to pull a printed run back to correct it.

The planner wants: printed runs to turn **green** and stay briefly, then live in a
**Completed** tab (classified per machine), be **reversible** back to Triage for edits,
and every card to be **clickable** into a chooser (view job card vs edit the queue entry).

## Non-goals (YAGNI)

- No schema changes.
- No change to how the Floor completes the printing stage.
- No bulk operations, no per-card date scheduling engine.
- No new permission roles — all mutations stay `canPlan` (admin/planner); operators view only.

## Data model

No new tables or columns. Everything keys off existing state:

- Printing state = the `job_stages` row where `stage='printing'`: `status`
  (`pending` | `in_progress` | `hold` | `completed`), `completed_at`, `operator`, `qty_out`.
- Card placement = `job_cards.machine_id` (press) + `job_cards.queue_pos` (lane order).
- Editable quantities = `job_cards.qty_planned`, `job_cards.sheets_issued`.
- Dates = `order_lines.planned_date` (per line), `orders.delivery_date` (per order).
- Gang membership = `job_cards.gang_run_id` / `order_lines.gang_run_id`.

## Server changes (`server/src/routes/production.js`)

### 3.1 Extend `GET /print-planning`

Response becomes `{ cards, presses, completed }`.

- `cards` — **unchanged**: printing stage not completed (active lanes: queued / printing / hold).
- `completed` — **new**: job cards whose printing stage IS `completed`, printed within
  the last **60 days**, carrying `machine_id` (press printed on), `completed_at`,
  `printing_operator`, printed sheets (`qty_out`), plus the same product/customer/gang
  joins the board cards already use. Ordered by `machine_id`, then `completed_at DESC`.

Both the board's green-window cards and the Completed tab read from this single
`completed` array, so they can never diverge.

### 3.2 New `POST /print-planning/reverse` (`canPlan`)

Body: `{ job_card_id, reason }` (reason required).

Reuses the downstream guards from the existing `/job-stages/:id/reverse`:

- Load the printing stage `FOR UPDATE`. Must be `completed`, else 409.
- Job must not be `closed`/`split`, else 409.
- If any downstream stage (`seq > printing.seq`) is non-`pending`, throw
  `{status:409, blockers:[...]}` — "Cannot reverse: <stage> is already <status>".

On success (single transaction):

- Set printing stage → `status='pending'`, clear `qty_out`, `qty_scrap`, `scrap_reason`,
  `completed_at`, `operator`.
- Clear `job_cards.machine_id` and `job_cards.queue_pos` → card returns to **Triage**.
- Also clear `order_lines.machine_id` for the line (mirror of assign's triage move).
- **Gang runs reverse together**: apply to every not-closed member of the gang (same
  member-resolution as `/print-planning/assign`).
- Audit `job_card` / `print_reverse` with the reason.

Distinct from `rollbackLine` (full order-line teardown) — this only un-completes printing
and unassigns; it never deletes the job card.

### 3.3 New `PUT /print-planning/:jobCardId` (`canPlan`) — consolidated queue edit

Body may include any of: `qty_planned`, `sheets_issued`, `operator`, `planned_date`,
`delivery_date`, `machine_id`, `ordered_ids`.

**Guard (same rule as `PUT /job-cards/:id`):** the printing stage must **not** be
`in_progress` / `hold` / `completed`, and the job not `closed` / `finalised`. If printing
has started or printed, reject with 409 "Reverse this run to edit." (The client disables
the fields and surfaces this.)

Writes each field to its real table in one transaction:

- `qty_planned`, `sheets_issued` → `job_cards` (same validation as `PUT /job-cards`:
  qty > 0, sheets ≥ 0).
- `operator` → the printing `job_stages` row.
- `planned_date` → `order_lines`.
- `delivery_date` → `orders` (affects the whole order — client shows a caution note).
- `machine_id` + `ordered_ids` → reuse the existing assign/re-sequence logic (press
  reassignment carries the gang and re-numbers `queue_pos`).

Audit `job_card` / `print_queue_edited` summarizing changed fields.

## Client changes (`client/src/pages/PrintPlanning.jsx`)

### 4.1 Tabs

Local `tab` state → **Board** | **Completed**. Board renders today's kanban unchanged.

### 4.2 Green "PRINTED" treatment

Printed cards render as a **solid green card** (emerald-600 fill, white text, `CheckCircle2`
icon + "PRINTED" label, settled/muted). This is a *filled* card — deliberately distinct
from a queued card on the emerald press (white card, thin emerald left edge), resolving
the emerald-hue collision. Printed cards are **non-draggable**.

### 4.3 Board green window

A printed card (from `completed`) whose `completed_at` is **today** is pinned at the
**bottom of its press lane**, below the live queue, as a green PRINTED card. After the day
rolls over it drops off the board automatically. Permanent home is the Completed tab.
(Window is a single constant — trivially tunable to e.g. "last 10 minutes" if desired.)

### 4.4 Completed tab

Same per-press lane layout as the board, read-only, green cards, newest first. Each card
shows job card, product, customer, **printed sheets** (`qty_out`), operator, completed time.
Gang runs render as a stack (reuse `groupLane`). Export support via the existing
`ExportMenu` (sections per press). Each completed card supports the click chooser +
**Reverse to Triage**.

### 4.5 Click chooser modal

Clicking a card opens a small modal. Drag is preserved — a real drag sets a flag that
suppresses the subsequent click, so drag-to-reorder and click-to-open don't conflict.

- **View Job Card** → navigate to `/production/jobcard/:id`.
- **Printing Queue (edit)** → open the edit form (4.6).
- On a **Completed** card, also **Reverse to Triage** (prompts for a reason).

The existing per-card `DangerZone` menu stays.

### 4.6 Edit form ("Printing Queue")

Modal form → `PUT /print-planning/:jobCardId`. Fields: quantity/sheets, operator,
press (dropdown) + queue position, planned date, delivery date. When printing has started
or printed, fields are disabled with the hint "Reverse this run to edit." Delivery-date
field carries a note that it changes the whole order. On save, reload the board.

## Interaction & permissions

All mutations (`assign`, `reverse`, `PUT /print-planning/:id`) require `canPlan`
(admin/planner). Operators see the board and Completed tab read-only.

## Testing

- Server unit tests (mirroring `order-lifecycle.test.js` / existing reverse guards):
  - reverse blocked when a downstream stage is non-pending;
  - reverse of a gang moves every member back to Triage;
  - edit blocked when printing is `in_progress`/`completed`;
  - edit writes each field to the correct table.
- Manual verification via the spare-port pattern against live PG :5439 (per project
  convention): print a run → green in lane → appears in Completed under its press →
  reverse → back in Triage editable → edit qty/operator/date → re-queue.

## Edge cases

- **Gang runs**: printed gang shows as a stack in Completed; reverse reverses all members.
- **Reverse blocked**: downstream stage already started → 409 blocker message shown inline.
- **Divergence**: board green-window and Completed both source from the one `completed`
  array — no separate query to drift.
- **Delivery-date edit**: shared across the order's sibling lines — flagged in the UI.
