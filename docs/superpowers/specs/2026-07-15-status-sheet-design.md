# Status Sheet module — design

**Date:** 2026-07-15
**Status:** approved (pending final spec review)

## Purpose

A live, editable coordination sheet listing every **pending order-line** still owed
to a customer, so the sales/coordination team can track supply progress and set
customer-facing status (revised delivery date, WIP, priority) at a glance. It sits
next to Tracking and complements — does not replace — the existing Sales-Orders
Pendency tab (which stays a read-only analytics roll-up).

## Placement

- **Sidebar / registry:** new module `Status Sheet`, key `status_sheet`, path
  `/status-sheet`, inserted directly after `track` in `client/src/modules.js`.
- **Route:** `<Route path="/status-sheet" element={<StatusSheet />} />` after the
  `/track` route in `client/src/App.jsx`.
- **Access scoping:** the `status_sheet` key participates in per-user module access
  like every other module (admins always see it).

## Row grain & filter

One row **per pending order-line** (order × product). Reuses the pendency demand
filter:

```
orders.status IN ('pending','hold')
AND order_lines.status NOT IN ('cancelled','dispatched')
AND order_lines.qty > order_lines.dispatched_qty
AND order_lines.completed_at IS NULL
```

Sorted overdue-first, then delivery date ascending (NULLs last), then line id —
mirroring `/sales/pendency`.

## Columns

| Col | Source | Behaviour |
|---|---|---|
| Order # | `orders.po_number` | read-only |
| Date | `orders.po_date` | read-only |
| Company | `customers.name` | read-only |
| Product | `products.name` (+ code) | read-only |
| Order Qty | `order_lines.qty` | read-only |
| Supplied | `order_lines.dispatched_qty` | read-only |
| Pending | `qty − dispatched_qty` | read-only, bold |
| Printed | derived: printing stage `completed` on the line's job card | **Auto / Yes / No** dropdown; Auto follows production, Yes/No overrides |
| EDD | `orders.delivery_date` | **inline date edit**, saves on change; overdue flagged red but **never blocked** |
| WIP | `order_lines.wip` (manual — the **customer's** WIP status, not our floor) | **Yes / No** dropdown |
| P1 | `orders.is_p1` (order-level) | manual toggle (star); all lines of a P1 order light up together |

## New persistent fields

Added in `server/src/db.js` via the existing `ALTER TABLE … ADD COLUMN IF NOT
EXISTS` migration block:

- `orders.is_p1 INTEGER NOT NULL DEFAULT 0` — manual P1 flag (order-level).
- `order_lines.wip BOOLEAN` — manual customer-WIP flag (NULL/false = No).
- `order_lines.printed_override BOOLEAN` — NULL = follow derived; true/false = override.

Only **Printed** is derived-with-override. **WIP** is purely manual (it describes the
customer's side). Resolved printed = `COALESCE(printed_override, printed_derived)`.

### Derivation of `printed_derived`

For the line's job card (resolved via the same LATERAL join `/sales/pendency`
uses, including gang-parent cards): true when a `job_stages` row with
`stage='printing'` and `status='completed'` exists.

## Server endpoints (in `server/src/routes/orders.js`, beside `/sales/pendency`)

- `GET /status-sheet` — flat list of pending lines with every column plus
  `printed_derived`, `printed_resolved`, `wip`, `is_p1`, `delivery_date`,
  `overdue_days`. No guard (any authed user), matching `/sales/pendency`.
- `PATCH /status-sheet/line/:id` — body `{ printed_override?, wip? }`, guarded by
  `canPlan`. Updates `order_lines`.
- `PATCH /status-sheet/order/:id` — body `{ delivery_date?, is_p1? }`, guarded by
  `canPlan`. Updates `orders`. Writes an audit entry (mirrors other order edits).

`delivery_date` accepts any date — no overdue validation. Setting an override
dropdown back to "Auto" sends `printed_override: null`.

## Client page (`client/src/pages/StatusSheet.jsx`)

Follows the register pattern (see `CuttingVariances.jsx`):

- `PageHeader`, KPI cards (Pending lines / Overdue / P1 / WIP counts), `SearchInput`
  with `rowMatches`, `DataTable` with `exportName` for branded export.
- 20s polling `load()`.
- Editable cells (Printed dropdown, EDD date input, WIP dropdown, P1 toggle) call
  the PATCH endpoints and update local state optimistically; the next poll
  reconciles. Overdue rows (delivery_date < today) get a red EDD cell; never
  blocked.

## Deferred (per decision, not built now)

Customer-master `priority` flag that auto-marks P1 on new orders. A one-line code
comment marks the hook point in the `GET /status-sheet` P1 resolution and in the
order-create path so it's a small future addition with no rework.

## Out of scope

- No change to the existing Sales-Orders Pendency tab.
- No customer-facing PDF/share of the sheet (export via the existing engine covers
  XLSX/PDF if needed).

## Verification

Per project rules: verify in the real running app (login `admin@motionci.com` /
`admin123`, desktop breakpoint), not a mock. Server edits may not hot-reload — the
running instance can be plain `node`; verify server changes via a temp server on a
spare port reusing live PG `:5439`, or restart `:4000`. Scope any seeded test data
with a `UAT-` marker and clean it up (never an unscoped DELETE on the shared DB).
