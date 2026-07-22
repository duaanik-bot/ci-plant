# Station Rollback/Delete + Sales-Order Lifecycle — Design

**Date:** 2026-07-10
**Project:** ci-erp (Colour Impressions Packaging Plant ERP)
**Status:** Approved for planning

## Problem

A job flows Sales Order → Planning → Artwork → Tooling/PR → Job Card → Print
Planning → Production. Today a mistake at any station can only be nudged back one
step (`WorkflowControls` reverse actions), and once production starts it is hard
blocked. The plant owner wants, at every station, the ability to **roll the whole
job back to the sales order** or **delete it entirely from everywhere** — with
clear guardrails — plus a clean **status lifecycle on the sales order itself**.

## Decisions (locked with user)

1. **Two buttons** at each station: *Rollback to Sales Order* (line survives,
   reset to Pending) and *Delete Entirely* (order line removed everywhere).
2. **Block & explain** guardrails: refuse when real downstream activity exists
   (started/held/completed stages, GRN received, FG produced, dispatched) and
   name the exact blocker. No force mode.
3. **Order statuses are five distinct states**: Pending, Hold, Completed,
   Closed, Cancelled — Close ≠ Cancel.
4. **"PO" = the customer PO = the sales order line.** The two buttons act on the
   order line. The material/procurement PO keeps its own existing delete and is
   not a new station here (a requisition *raised from this line* is still cleaned
   up as derived work — see §2).

## 1. Sales-order status model + tabs

### Statuses (`orders.status`)

| Status | Meaning | Terminal? |
|---|---|---|
| `pending` | Active order, work in progress (replaces legacy `open`) | no |
| `hold` | Paused — lines frozen, cannot advance | no |
| `completed` | Every line fully produced & dispatched | soft |
| `closed` | Finished & archived/locked — done, **not** a cancellation | yes* |
| `cancelled` | Killed before completion | yes* |

\* Admin can reopen a `closed`/`cancelled`/`completed` order back to `pending`.

### DB migration
- Extend the `orders.status` CHECK to
  `('pending','hold','completed','closed','cancelled')`.
- One-time data migration: `UPDATE orders SET status='pending' WHERE status='open'`.
  (Pre-delivery wipe already truncated orders, so this affects little/no data.)
- Keep `order_lines.status` untouched. Order status is derived-but-manual: users
  set it explicitly; the existing auto "order → completed when all lines
  dispatched" behaviour stays.

### Transitions (order level)
```
pending  → hold, completed, closed, cancelled
hold     → pending, cancelled, closed
completed→ pending (admin reopen), closed
closed   → pending (admin reopen)
cancelled→ pending (admin reopen)
```
- `hold` freezes advancement: while an order is `hold`, its lines' station
  actions (plan/artwork/job-card/print-planning pushes) are refused with
  "Order is on hold — resume it first". Rollback/Delete are still allowed on a
  held order (you may want to clean up while paused).

### API
- `POST /orders/:id/status` `{ status, note? }` — validates the transition,
  applies it, writes `audit('order', id, 'status:<to>', note)`. Non-admin roles
  limited to `canPlan`; reopening a terminal order requires `admin`.
- `GET /orders` already returns status; no shape change.

### UI (`client/src/pages/Orders.jsx`)
- Replace the current `open/completed/closed` tabs with:
  **Pending · Hold · Completed · Closed · Cancelled**.
- Rename the existing owed-items "Pending" tab to **Pendency** (frees the word
  "Pending" for the order-status tab). The pendency data source is unchanged.
- Order-detail modal gains a status action row: **Set Pending / Hold / Complete
  / Close / Cancel**, each disabled when the transition is invalid, each with a
  confirm on the terminal ones (Close/Cancel). `StatusBadge` learns the new
  statuses (colour map: pending=blue, hold=amber, completed=green,
  closed=slate, cancelled=red).

## 2. Station Rollback / Delete Entirely

### One backend endpoint
`POST /order-lines/:id/rollback` with body `{ mode: 'rollback' | 'delete', note? }`
(role `canPlan`). Runs in a single `tx`:

1. **Load** the line + any job card + stages + line-raised requisition.
2. **Compute blockers** (see §3). If any and not overridable → `409` with
   `{ error, blockers: [...] }`.
3. **Cleanup (both modes)** — unwind derived work, newest-first:
   - delete `job_stages` (all pending) then the `job_card` for the line;
   - clear print-queue slot: `job_cards.queue_pos` is gone with the card; if the
     line held a machine/date only, clear `order_lines.machine_id`,
     `planned_date`;
   - delete a requisition **raised from this line** (`raise-pr`) *only if* it has
     no linked purchase order and no GRN — matched via reason text / a stored
     `order_line_id` link (add `requisitions.order_line_id` column to make this
     precise; backfill NULL);
   - if the line is in a gang, remove it from the gang (reuse existing gang
     dissolve logic when <2 remain);
   - reset flags: `tooling_ok=0`, `artwork_customer_ok=0`, `artwork_qa_ok=0`,
     `artwork_locked=0`; clear `spec_override`, `sheets_required`,
     `parent_sheets_required`, `wastage_sheets`, `leftover_plan`.
4. **Mode branch:**
   - `rollback`: `forceLineStatus(line, 'pending', ...)`. Line stays on the
     sales order, ready to re-plan.
   - `delete`: after cleanup, `DELETE FROM order_lines WHERE id=$1`. If it was
     the order's last line, the order stays but is now empty (owner can Cancel/
     Close it from §1). Do **not** auto-cancel — leave that to the user.
5. **Audit** every action: `workflow:rollback_to_sales_order` /
   `workflow:deleted_entirely` on the line (and on the job card if one existed),
   so the universal Timeline shows who removed what and when.

Response: `{ ok, mode, message, line? }` (line present for rollback, absent for
delete) so the caller can update or drop the row.

### Why one endpoint, not per-station
The cleanup is identical regardless of which page you press it from — the line's
state determines what exists to unwind. A single, well-guarded transaction is
safer than five partial ones and keeps the audit trail uniform.

## 3. Guardrails (block & explain)

Blockers computed from the line's downstream state; endpoint returns them all at
once so the user sees the full picture:

| Condition | Message |
|---|---|
| any `job_stages.status != 'pending'` | `"<Stage> stage is <status> — reverse it first"` |
| line-raised PR has a linked PO or GRN | `"Board already ordered/received against this line's requisition"` |
| `fg_movements`/`fg_lots` produced for the line's job card | `"Finished goods already produced for this job"` |
| `order_lines.dispatched_qty > 0` | `"<n> pcs already dispatched — cannot delete"` |

If **no** blockers → proceed. This mirrors the existing reverse-guard in
`workflow.js` (`job_stages WHERE status != 'pending'`) so behaviour is
consistent with what the app already enforces.

## 4. Frontend wiring

- Extend `client/src/components/WorkflowControls.jsx` (already rendered on the
  station pages) with a **Danger zone**: two buttons — *Rollback to Sales Order*
  and *Delete Entirely* — each opening a confirm dialog. On `409` the dialog
  shows the returned `blockers` list instead of a generic error.
- Surface the same control on Planning, Artwork, Job Card (Production /
  JobCardPrint), and Print Planning rows/detail. Where `WorkflowControls` is not
  already present on a page, add it.
- After success: rollback → refetch the row (now Pending); delete → remove the
  row from the list and toast `"Item deleted from all stations"`.

## Out of scope (YAGNI)
- No force/override delete (explicitly declined).
- No unwinding of received GRNs, produced FG, or dispatches — those block.
- No change to the procurement PO delete flow (already exists).
- No bulk multi-line rollback in v1 (single line at a time).

## Files touched (anticipated)
- `server/src/db.js` — orders.status CHECK, `requisitions.order_line_id` column.
- `server/src/routes/orders.js` — `POST /orders/:id/status`,
  `POST /order-lines/:id/rollback`; tag `order_line_id` in `raise-pr`.
- `server/src/helpers.js` — small rollback-blocker helper (reuse readiness/tx).
- `client/src/pages/Orders.jsx` — tabs, status action row, StatusBadge statuses.
- `client/src/components/WorkflowControls.jsx` — danger-zone buttons + blocker dialog.
- Station pages (`Planning.jsx`, `Artwork.jsx`, `Production.jsx`/`JobCardPrint.jsx`,
  `PrintPlanning.jsx`) — ensure the control is shown.

## Verification
Per project rule, verify in the **real running app** (login, desktop breakpoint):
seed a line, walk it to Print Planning, roll it back (assert it returns to
Pending and derived rows are gone), re-advance and Delete Entirely (assert gone
from every page), then start a stage and confirm both buttons are blocked with
the right message. Exercise all five order-status tabs/transitions.
