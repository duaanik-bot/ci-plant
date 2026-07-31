# GRN as a multi-line priced document

**Date:** 2026-07-31
**Status:** Approved, not yet implemented
**Scope:** Procurement → GRN

## Problem

The Create GRN modal's **Direct — No PO** tab receives exactly one board, one
quantity, one batch. A truck that arrives with four boards has to be entered
four times, and none of those entries carries a price.

That last part is the deeper problem. The `grns` table has no money columns at
all. Rate and value live only on `po_lines`. Three consequences:

- The Accounts purchase register reads `purchase_orders` + `po_lines` only. Board
  bought without a PO — a sample lot, an urgent buy, a stock correction — is
  **invisible as a purchase**. Spend ₹40,000 on an urgent lot and Accounts shows
  nothing.
- A receipt cannot be reconciled against a supplier invoice, because it holds no
  rate, no tax, no freight and no total.
- The Warehouse "Stock Value" column derives from the board rate master
  (grade base ₹/kg → ₹/sheet), never from what was actually paid.

A PO is a document: one header, many priced lines. A GRN should be the same
document on the receiving side. Today it is a row.

## Decisions taken

| Question | Decision |
|---|---|
| Record shape | Full restructure — `grn_headers` + `grn_lines` |
| What the values do | Purchase register **and** GRN record **and** batch valuation |
| Against-Open-PO tab | Shows rates, and they are **editable** at receipt time |
| Stock Value column | Actual batch cost, master rate as fallback |
| Printable receipt | Yes — a `GrnPrint` page modelled on `POPrint` |
| QC granularity | **Per line**, plus an Accept All shortcut on the GRN |

The restructure was chosen over a lighter "receipt header above unchanged GRN
rows" design for one reason: under the lighter design a single truck carrying
four boards produces four GRN numbers plus a receipt number. Under this design
it produces **one GRN number with four lines**, exactly as one PO number covers
many lines. That is what the plant means by a goods receipt.

## Data model

`grns` is **renamed in place** to `grn_headers`. This is the load-bearing choice
of the whole migration: ids are preserved, so every `conversations` thread,
`audit` entry and notification already pointing at a GRN id still resolves to the
right document. Nothing that references a GRN needs remapping.

### `grn_headers` (renamed from `grns`)

Kept: `id`, `grn_number`, `purchase_order_id`, `vendor_id`, `source`,
`vehicle_no`, `supplier_invoice_no`, `supplier_invoice_date`, `received_by`,
`remarks`, `received_at`.

Added: `tax_kind TEXT NOT NULL DEFAULT 'intra'` (`intra`|`inter`),
`freight DOUBLE PRECISION NOT NULL DEFAULT 0`,
`round_off DOUBLE PRECISION`.

Dropped (they move to lines): `po_line_id`, `material_id`, `qty`, `batch_no`,
`status`, `qc_at`, `qc_note`.

### `grn_lines` (new)

```
id                INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY
grn_header_id     INTEGER NOT NULL REFERENCES grn_headers(id)
po_line_id        INTEGER REFERENCES po_lines(id)      -- null on a direct receipt
material_id       INTEGER NOT NULL REFERENCES materials(id)
qty               DOUBLE PRECISION NOT NULL
unit              TEXT
rate              DOUBLE PRECISION NOT NULL DEFAULT 0
discount_pct      DOUBLE PRECISION NOT NULL DEFAULT 0
gst_rate          DOUBLE PRECISION NOT NULL DEFAULT 0
hsn_code          TEXT
batch_no          TEXT NOT NULL
status            TEXT NOT NULL DEFAULT 'quarantine'
                  CHECK (status IN ('quarantine','accepted','rejected'))
qc_at             TIMESTAMPTZ
qc_note           TEXT
```

### Header status is derived, never stored

Computed from the line statuses, the same rule the rest of this ERP follows for
Received:

| Lines | Header reads |
|---|---|
| all `quarantine` | In QC |
| all `accepted` | Accepted |
| all `rejected` | Rejected |
| some decided, some still `quarantine` | Part QC'd |
| all decided, mixed accept/reject | Partly Accepted |

The last two are deliberately distinct: "Part QC'd" means work is still owed,
"Partly Accepted" means the receipt is settled and some of it was refused. A
single label for both would hide an outstanding QC decision.

Storing it would let it drift from the lines that produce it.

### `stock_batches`

`grn_id` → `grn_line_id INTEGER REFERENCES grn_lines(id)`. A batch belongs to a
line now, because a line is what has one material and one quantity.

Add `rate DOUBLE PRECISION` — the landed ₹/unit for this batch, copied from its
line at receipt. Null means "cost not recorded", which is what every pre-existing
direct batch honestly is.

### `stock_movements` stay pointed at the header

Movement rows carry `ref_type='grn', ref_id=<grn id>`. Those ids are header ids
after the rename, so **every existing movement row remains correct and is not
migrated**. New movements keep referencing the header. Line identity is always
recoverable through `batch_id`, so nothing is lost.

## Migration `0014_grn_multi_line.sql`

Ordered, idempotent, one transaction:

1. `ALTER TABLE grns RENAME TO grn_headers`
2. `CREATE TABLE IF NOT EXISTS grn_lines (…)`
3. Extract exactly one line per existing header:
   ```sql
   INSERT INTO grn_lines (grn_header_id, po_line_id, material_id, qty, unit,
                          rate, gst_rate, hsn_code, batch_no, status, qc_at, qc_note)
   SELECT h.id, h.po_line_id, h.material_id, h.qty, m.unit,
          COALESCE(pl.rate, 0), COALESCE(m.gst_rate, 0), m.hsn_code,
          h.batch_no, h.status, h.qc_at, h.qc_note
   FROM grn_headers h
   JOIN materials m ON m.id = h.material_id
   LEFT JOIN po_lines pl ON pl.id = h.po_line_id;
   ```
   The `LEFT JOIN po_lines` is deliberate: **every historic PO-backed receipt
   inherits its PO rate and gains a value retroactively.** Direct receipts land
   at rate 0 — unknown, not falsely free.
4. `ALTER TABLE stock_batches ADD COLUMN IF NOT EXISTS grn_line_id INTEGER REFERENCES grn_lines(id)`,
   then backfill through the 1:1 mapping that step 3 just created:
   ```sql
   UPDATE stock_batches sb SET grn_line_id = gl.id
   FROM grn_lines gl WHERE gl.grn_header_id = sb.grn_id;
   ```
5. `ALTER TABLE stock_batches ADD COLUMN IF NOT EXISTS rate DOUBLE PRECISION`,
   backfilled from the line rate where non-zero.
6. `ALTER TABLE stock_batches DROP COLUMN IF EXISTS grn_id`
7. Add the three new `grn_headers` columns; drop the seven moved ones.
8. Indexes on `grn_lines(grn_header_id)`, `grn_lines(material_id)`,
   `grn_lines(po_line_id)`, `stock_batches(grn_line_id)`.

`server/src/db.js` `init()` is updated to create the final shape directly for
fresh databases, and `npm run db:baseline` regenerated — `npm run verify` fails
on a stale baseline. Production is migrated by the named migration, never by
`init()`, per `DEPLOYMENT.md` §3. `npm run db:backup` runs first.

## Server

All paths live in `server/src/routes/procurement.js` unless noted. There are 25
existing `grns` call sites in that file; every one is touched.

### Write paths

`POST /grns/direct` — body becomes
`{ vendor_id?, tax_kind, freight, round_off, lines: [{ material_id, qty, unit, rate, discount_pct, gst_rate, hsn_code, batch_no? }], vehicle_no?, supplier_invoice_no?, supplier_invoice_date?, received_by?, remarks? }`.
Creates one header, N lines, N quarantine batches, N movements. The existing
leftover-material guard applies per line.

`POST /grns/bulk` — same, plus `purchase_order_id` and a `po_line_id` per line.
Each line carries an editable `rate`, defaulted client-side from its PO line.

`POST /grns` (single PO line) — kept for compatibility, reimplemented as a
one-line `bulk` so there is a single write path underneath.

Batch numbering keeps today's rule, made line-aware: `batch_no` when supplied,
otherwise `{grn_number}-B{lineIndex}`. Two lines of one GRN can no longer collide
on `-B1`.

### QC — now per line

`POST /grn-lines/:id/qc` — body `{ accept, note }`. Body of the current
`/grns/:id/qc` moved down a level, with `g.material_id`/`g.qty`/`g.po_line_id`
read from the line and `g.purchase_order_id` from its header. Everything it does
today is already per-material and therefore already per-line:

- release or reject the line's batch, write the `qc_release` / `qc_reject` movement
- credit `po_lines.received_qty` and re-derive PO status (PO-backed lines only)
- shrink matching `board_allocations` by the landed qty — **this must stay
  per-line**, since it is keyed on `material_id` and would over-consume if a
  multi-board GRN credited allocations once for the whole header

`POST /grns/:id/qc-all` — body `{ accept, note }`. Loops the header's
`quarantine` lines through the same routine in one transaction. This is the
Accept All shortcut; it is a convenience over the per-line path, not a second
implementation of it.

### Edit / delete / rollback — header-scoped

`PUT /grns/:id` — header meta plus per-line `qty`, `rate`, `discount_pct`,
`gst_rate`, `hsn_code` and `batch_no`. **Lines cannot be added or removed on
edit** — that is a different receipt; delete and re-enter. Allowed only while
**every** line is still `quarantine`; keeps each line's batch and movement in
step, as today.

`DELETE /grns/:id` — refuses if any line is `accepted` (message points at
rollback, as today) or if any batch has been consumed. Deletes lines, batches,
movements, header.

`POST /grns/:id/rollback` — refuses unless **every** line is decided and at
least one is `accepted`. A header still holding a `quarantine` line is refused
with "finish QC on this receipt before rolling it back", because rollback
deletes the header and would silently discard an undecided line. It then
reverses each accepted line's `received_qty`, removes its untouched released
batch, re-derives PO status once at the end, and deletes the header. The
existing "stock already used" guard runs per line.

### Read paths

`GET /grns` — returns **one row per line**, joined to its header, so the register
can render lines and group them. Each row carries `grn_number`, `po_number`,
`vendor_name`, `material_name`, `qty`, `unit`, `rate`, `amount`, line `status`,
and the header's derived `header_status`.

Four call sites elsewhere read the old shape and change with it:

| File | Change |
|---|---|
| `routes/procurement.js:479,486,545,575,634,905` | PO qty/count/quarantine sub-selects join through `grn_lines` |
| `routes/master-history.js:289,314` | `material_id` now lives on the line; audit join goes `grn_lines → grn_headers` |
| `routes/timeline.js:71` | header has no `material_id`; aggregate line materials |
| `seed.js:352` | seeds a header + one line + batch |

### Purchase register

`routes/billing.js` `/accounts/registers` — the `purchases` query gains a UNION
of direct receipts:

```sql
-- direct GRNs only; PO-backed receipts are already counted via their PO,
-- so nothing double-counts
FROM grn_headers h
JOIN grn_lines gl ON gl.grn_header_id = h.id
WHERE h.source = 'direct' AND gl.status <> 'rejected'
```

**Rejected lines are excluded.** Board that failed QC goes back to the supplier
and is not a purchase; counting it would inflate spend by exactly the lots the
plant refused. Quarantine lines *are* counted — they have arrived and been
invoiced, and the register is about what was bought, not what has cleared QC.

Value is `SUM(gl.qty * gl.rate)` — gross of discount and tax, matching the
existing `SUM(pl.qty * pl.rate)` convention for POs so the two halves of the
register are comparable. The period filter uses `h.received_at`, mirroring
`po.created_at` for POs. `purchaseMonthly` gets the same treatment. Rows are
labelled so a direct receipt is visibly not a PO.

## Client

### `GrnLineEditor` — new, in `client/src/components/GrnForms.jsx`

A new file rather than growing `ProcurementForms.jsx`, which is 429 lines and
under concurrent edit by other sessions. It imports the shared line-card
primitives (`LineNo`, `NumField`, `IconBtn`, `BoardSpec`, `RateProvenance`,
`StockStrip`, `miniInput`, `fillFromMaterial`) from `ProcurementForms.jsx`, which
gains exports for them — an additive change to that file, nothing rewritten.

Built from `PoLineEditor`'s two-tier card so the two forms read identically:

- **Direct mode** — full `MaterialPicker`, then HSN / Qty / UOM / Rate / Disc % /
  GST % under their own labels, plus Batch No. Add line, Clone, Remove. The
  derived packets / kg-per-sheet / total-kg strip appears exactly as it does on a
  PO line.
- **PO mode** — board is fixed from the PO line and not pickable. Shows Ordered
  and Balance read-only, `Receive Now` in place of Qty, the PO's rate pre-filled
  and **editable**, plus Disc % / GST % / Batch No. When the typed rate differs
  from the PO rate by more than ₹0.005, an amber chip reads
  `PO rate ₹X.XX` — the same tolerance and treatment `RateProvenance` already
  uses for an overridden master rate.

The PO keeps its ordered rate; the GRN records what was invoiced. Variance is
`grn_lines.rate − po_lines.rate`, computed for display and never stored.

### Create GRN modal — `client/src/pages/Procurement.jsx`

Both tabs become: line editor → `PoTotalsPanel` → `TaxKindToggle` →
`GrnMetaFields`. `PoTotalsPanel`, `TaxKindToggle` and `lib/poTotals.js` are used
**verbatim**, unmodified. The GST breakup, freight, round-off, grand total and
amount-in-words on a GRN are literally the PO form's code, so the two documents
cannot drift.

`tax_kind` defaults from `taxKindFor(company, vendor)` when a supplier is picked,
exactly as the PO forms do.

### GRN register

`DataTable` with `groupBy={g => g.grn_number}` — the gang-row pattern already in
`ui.jsx`. Line rows nest under their GRN. New Rate and Amount columns. The QC
Decision button sits on each `quarantine` line; **Accept All** and Print sit in
the GRN's `ActionMenu`. Thread column stays keyed on the header id, which is why
existing threads survive.

### Warehouse Stock Value — `client/src/pages/Inventory.jsx`

`stockValue()` currently returns `ratePerSheet(master) × available`. It becomes a
**per-batch sum**, not a blended rate:

```
Σ over the board's available batches:
    batch.qty × (batch.rate ?? ratePerSheet(master))
```

Each batch is valued at its own recorded cost; only batches with no recorded
cost fall back to the master rate. A board whose batches all predate the
migration therefore reads exactly as it does today.

This needs remaining batch quantities per material, which `/inventory/stock`
does not currently return — it returns the rolled-up `available`. The endpoint
gains a `stock_value` field computed server-side from `stock_batches`, and
`Inventory.jsx` renders that instead of computing it client-side. Null still
means unknown, never zero, and a board with no master rate *and* no batch cost
still reads "—".

### `GrnPrint.jsx` — new page, route `/grn/:id/print`

Modelled on `POPrint.jsx` (257 lines): company header, GRN number and date,
supplier and invoice reference, vehicle, line table with HSN / qty / rate /
disc / GST / amount, GST breakup, freight, round-off, grand total, amount in
words, received-by signature block. Uses the same A4 `@page` print CSS as the
other templates.

## Testing

New `server/src/grn-receipt.test.js`:

- a 3-line direct GRN creates 1 header, 3 lines, 3 quarantine batches, 3 movements
- batch numbers are `-B1 -B2 -B3`, never colliding
- derived header status across all four combinations, including Partly Accepted
- per-line accept releases only that line's batch and credits only its PO line
- per-line accept shrinks `board_allocations` once per line, not once per header
- Accept All decides every quarantine line and leaves already-decided lines alone
- delete refuses when one line is accepted; rollback refuses when none is
- a PO-tab receipt at an edited rate stores the received rate and leaves
  `po_lines.rate` untouched
- direct receipts appear in `/accounts/registers` purchases; PO-backed ones do
  not appear twice
- a rejected direct line is excluded from the register while a quarantine line
  on the same receipt is still counted
- `/inventory/stock` values a board with one costed and one uncosted batch as
  `costed.qty × batch.rate + uncosted.qty × masterRate`, and returns null when
  neither cost is known

Existing suites that must stay green: `record-entities.test.js` (the `grn` record
entity, unchanged because header ids are preserved), the seeder/live constraint
parity test, and `npm run db:check -- --baseline` replaying `0001` + `0014` into
an empty database.

Full gate before deploy: `npm run verify`, then `npm run db:check` against the
target environment.

## Risks

**`server/src/db.js` is already modified by another session** in this shared
tree, along with 12 other files on branch `shade-card-simplification`. This work
must touch `db.js`. Edit by exact string match only; never `git checkout --` a
file, which would destroy the other session's uncommitted work.

**This migration rewrites production data.** `npm run db:backup` first, confirm
the target project ref in the terminal output, and compare `grn_headers` and
`grn_lines` counts against the pre-migration `grns` count afterwards — lines must
equal the old row count exactly.

**`procurement.js` is 1035 lines with 25 GRN call sites.** The rename means the
compiler cannot help: `grns` simply stops existing, so a missed site fails at
runtime, not at build. The migration should be applied locally first and the
whole Procurement page exercised against it before anything is committed.
