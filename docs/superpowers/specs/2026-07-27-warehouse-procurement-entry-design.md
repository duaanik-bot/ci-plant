# Warehouse as a procurement entry point — design

**Date:** 2026-07-27
**Status:** approved, not yet implemented

## Problem

The Warehouse RM Stock list is a viewing screen with a redundant per-row
`Adjust…` button in the last column. The row is already clickable, so the button
duplicates the row click and adds visual noise across ~300 board rows.

More importantly, seeing that a board is short is where the screen stops. The
storekeeper has to leave Warehouse, open Procurement, and retype materials they
were just looking at. Not every purchase is job-driven — plenty of buying is
plain replenishment against a reorder level — and that path has no natural
entry point today.

## Goal

Warehouse becomes an operational procurement dashboard: monitor stock, identify
what needs replenishing, select one or many materials, and raise a Purchase
Requisition that continues through the **existing** procurement lifecycle. One
procurement system, multiple entry points — no parallel process.

```
Warehouse / Planning / Production
  → Purchase Requisition (PR)
  → Approval
  → Purchase Order (PO)
  → Goods Receipt (GRN)
  → Inventory update
```

## What already exists

Established before designing, so the work stays additive:

- `DataTable` (`client/src/components/ui.jsx`) already supports `selectable`,
  `selectedIds`, `onToggleRow`, `onToggleAll`, and already guards row-click
  bubbling from checkbox cells.
- `MasterHistory` (`client/src/components/MasterHistory.jsx`) already renders a
  360° drawer for `kind='materials'`: ledger, purchases, GRNs, committed-demand
  breakdown, audit. It is wired into Masters but never into Warehouse.
- `PrLineEditor` (`client/src/components/ProcurementForms.jsx`) is already
  multi-line, with a duplicate-PR alert and an injected `rateFor` resolver.
- `requisitions.order_line_id` is **nullable**, so a PR with no order/product
  linkage is already legal. Nothing structural blocks reorder-stock buying.
- `assertPurchasable` (`server/src/routes/procurement.js`) already rejects
  leftover offcuts on any PR/PO line — they are not purchasable.

## Design

### 1. Schema

Three columns, all defaulted so existing rows stay valid:

```sql
ALTER TABLE materials     ADD COLUMN IF NOT EXISTS min_stock DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE materials     ADD COLUMN IF NOT EXISTS max_stock DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE requisitions  ADD COLUMN IF NOT EXISTS purpose   TEXT NOT NULL DEFAULT 'production';
```

`purpose` ∈ `production` | `stock_replenishment` | `reorder_level` |
`general_inventory`. It records *why* a PR was raised so reorder buying can be
told apart from job-driven buying in the register and in reports. It does not
gate anything.

Both `min_stock` and `max_stock` read `0` as "not set" — the UI shows `—`, never
a confident zero.

Applied through `server/src/db.js` → `init()` (idempotent, ordered after the
tables exist), then `npm run db:baseline` to regenerate
`supabase/migrations/0001_baseline_schema.sql`, then a new named migration
`supabase/migrations/0005_warehouse_pr.sql` for production. Editing `init()`
does not migrate production — the Vercel function never calls it.

### 2. `/inventory/stock` gains three derived fields

| Field       | Definition |
|-------------|------------|
| `reserved`  | Existing committed demand — `SUM(COALESCE(parent_sheets_required, sheets_required))` over `order_lines` in `planned`/`ready`, with the job-level board override winning over the product master. The existing `demand` key is kept in the response for back-compat. |
| `incoming`  | `SUM(po_lines.qty − po_lines.received_qty)` over POs with status `open` or `partially_received`. Never negative. |
| `suggested` | `max(0, reserved + reorder_level − available − incoming)`, then capped at `max_stock` when `max_stock > 0`, then rounded **up** to the next whole packet when `sheets_per_packet` is known. |

All three are computed server-side so the stock table, the 360° drawer and the
PR form can never disagree about the same number.

The packet round-up reflects how board is actually bought: 1,300 sheets of a
144-per-packet board becomes 1,440. A material with no `sheets_per_packet`
returns the raw figure.

### 3. Warehouse page (`client/src/pages/Inventory.jsx`)

**Adjust column removed** from RM Stock → *In Stock* and RM Stock → *Leftover*.

**Row click opens the Material 360 drawer** (`MasterHistory`, `kind='materials'`)
instead of the Adjust modal. `MasterHistory` gains one optional `actions` prop —
a node rendered in its header — so Warehouse injects an **Adjust Stock** button
that opens the existing adjustment modal with the material locked. The component
stays generic; Masters passes nothing and is unchanged.

The header `+ Adjustment` button (pick-material-from-list) stays, demoted to
secondary. Removing it would strand the only path for adjusting a material that
is not currently visible in the filtered list.

**Checkboxes and Select All** on RM Stock → *In Stock* only. Deliberately **not**
on *Leftover*: `assertPurchasable` rejects leftover offcuts server-side, so a
checkbox there could only ever produce a 409.

**Selection bar** appears when anything is ticked, following the existing
FG-leftover pattern already on this page:

```
3 selected · 4,320 sheets suggested   [Raise Purchase Requisition]  [Clear]
```

**`Raise Purchase Requisition`** is the primary header action, always enabled.
With rows selected it seeds them; with none it opens blank.

Selection is held as a set of material ids, so it survives searching, sorting
and the *Show zero & negative stock* toggle — a storekeeper can search "2038",
tick it, clear the search, find the next board and tick that too. `Select All`
follows `DataTable`'s existing contract and applies to the **currently visible
(filtered and sorted) rows only**, not the whole master.

### 4. One PR form, two doors

The New-PR modal moves out of `Procurement.jsx` into a self-contained
`client/src/components/NewRequisitionModal.jsx`. It owns its own data loading
(`/materials`, `/board-po-rates`, `/requisitions` for the duplicate check,
`/inventory/stock`), the duplicate-PR confirmation, quick-create of a missing
board, and the `POST /requisitions` submit.

Props: `open`, `onClose`, `onRaised`, `seedMaterialIds`, `defaults`.

`Procurement.jsx` replaces its inline modal with this component. `Inventory.jsx`
renders the same one.

This is required by the permission decision below: a storekeeper on
`production`/`qc` has no `procurement` module access, so routing them to
`/procurement` to finish the PR would dead-end. The form must come to them.

Warehouse opens it with `department: 'Stores'` and
`purpose: 'stock_replenishment'`. Procurement opens it with
`purpose: 'production'`.

### 5. Live inventory on every PR line

`PrLineEditor` gains an optional `stockFor(materialId)` prop. When supplied,
each line renders a compact strip under the material picker:

```
Available 4,200 sh (29 pkt) · Reserved 6,000 · Incoming 2,000 · Reorder 1,500
Min — · Max — · Suggested 1,440  [Use]
```

`[Use]` fills the line quantity. Unset masters render `—`.

Seeded lines arrive with:

- `material_id`, and the picker label showing **name · code · grade·GSM**
  (board name already encodes grade, GSM and sheet size; `spec` carries the code)
- `unit` from the material
- `qty` pre-filled from `suggested`
- `est_rate` resolved through the existing injected `rateFor` (boards → vendor
  ₹/sheet from the rate master, else `std_rate` → `last_rate`)

The user reviews and confirms. Nothing is typed twice.

When `stockFor` is not supplied the editor renders exactly as it does today, so
every other caller is unaffected.

### 6. Permission

`POST /requisitions` widens from `requireRole('planner')` to
`requireRole('planner', 'production', 'qc')`. `admin` passes everything already.

`viewer` stays excluded — it is the read-only role by definition.

Everything downstream is untouched: approve, reject, edit, close, delete and
convert-to-PO remain `planner` + `admin`. Widening who can *ask* does not widen
who can *approve*, so the control gate is intact.

The Warehouse `Raise Purchase Requisition` button and the row checkboxes are
hidden for roles that cannot raise, so nobody clicks a button that 403s.

### 7. Masters

`min_stock` and `max_stock` are added to the Boards master form
(`client/src/pages/Masters.jsx`) beside `reorder_level`, as plain number fields.
Both default to 0.

## Error handling

- **Leftover selected via a stale list** — server returns 409 from
  `assertPurchasable`; the modal surfaces the message naming the board.
- **Duplicate PR** — the existing per-item duplicate alert and reason-gated
  re-raise flow move into the shared component unchanged.
- **403 on submit** — surfaced as a toast with the role message the server
  already returns. Should be unreachable, since the button is role-gated.
- **`/inventory/stock` fails to load in the PR modal** — the inventory strip
  renders `—` throughout and the form still works. Live stock is decoration on
  a form that must stay usable.
- **Negative available** — a count corrected below zero is real in this plant.
  `suggested` treats it as-is, so the suggestion grows accordingly; it is not
  clamped to 0 before the formula.

## Testing

- **Server (`npm test -w server`)** — `incoming` excludes `received`/`closed`
  POs and never goes negative; `suggested` respects the `max_stock` cap, the
  packet round-up, and returns 0 when stock covers demand; `POST /requisitions`
  accepts `production` and `qc`, rejects `viewer`; `purpose` persists and
  defaults to `production`; a leftover material is still rejected.
- **Baseline replay (`npm run db:check -- --baseline`)** — proves the three new
  columns replay into an empty database in the right order.
- **Client build (`npm run build -w client`)**.
- **Live verification** — log into the running app at the desktop breakpoint and
  walk it: RM Stock has no Adjust column, row click opens the 360° drawer,
  Adjust Stock works from inside it, tick three short boards, raise a PR, confirm
  the inventory strip shows real numbers and the PR lands in the Procurement
  register with `purpose = stock_replenishment`.

## Out of scope

- Auto-raising PRs when stock crosses the reorder level. Every PR here is a
  deliberate human action.
- Vendor selection or rate negotiation at PR stage — that stays a PO concern.
- Backfilling `min_stock` / `max_stock` for the ~300 existing boards. They start
  unset and read as `—`.
- FG Stock, RM Batches and Movement Ledger tabs — unchanged.

## Known risk

`client/src/pages/Inventory.jsx` was being edited by a concurrent session at the
time of writing (adding board-spec columns: grade, GSM, sheet size, kg/sheet,
₹/kg, stock value), touching the same columns array this work modifies. Re-read
the file immediately before editing and use exact-string edits.
