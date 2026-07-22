# Procurement forms → industry standard (multi-item PR + full-GST PO)

Date: 2026-07-12 · Module: Procurement (ci-erp)

## Goal
Refactor the **New Purchase Requisition** and **Direct Purchase Order** forms to
industry-standard depth and make both multi-item. Direct PO already supported
multiple lines; the PR was single-material — that is the core change.

Decisions (confirmed with Anik):
1. **PR = one document, many line items** (new `requisition_lines` table).
2. **PO carries full GST** — per-line HSN, discount, GST%; CGST/SGST or IGST;
   freight, round-off, grand total, amount-in-words.
3. **Enrich masters** — vendor GSTIN/address/state, material HSN/GST/last-rate,
   plus a seeded `company_profile` (our buyer block + intra/inter-state logic).

## Data model (db.js — all additive, IF NOT EXISTS; back-compat preserved)
- `requisition_lines(id, requisition_id, material_id, qty, est_rate, needed_by, remarks)`.
- `requisitions` becomes the **header**. Keep `material_id`/`qty` populated as a
  **primary-line mirror** (first line) so every existing query/join keeps working;
  `requisition_lines` is the source of truth for multi-line reads. Backfill one
  line per existing requisition.
- `vendors` + `gstin, address, state, state_code, email`.
- `materials` + `hsn_code, gst_rate, last_rate`.
- `po_lines` + `hsn_code, unit, discount_pct, gst_rate`.
- `purchase_orders` + `tax_kind ('intra'|'inter'), freight, round_off`.
- `company_profile` (single row) seeded with Colour Imp Production details.

## Backend (procurement.js, masters.js)
- `POST /requisitions`: accept `lines:[…]`; **back-compat** — a legacy
  `{material_id, qty}` body (Planning engine) becomes a one-line PR. Header +
  N lines in a tx; mirror first line onto the header columns.
- `PUT /requisitions/:id`: replace header + lines while pending/approved.
- `GET /requisitions` (+ `/:id`): attach `lines`, `item_count`, `est_value`.
- `convert` and `from-requisitions`: build one `po_line` per requisition line
  (group-by-material preserved for the bulk path); carry HSN/GST/discount.
- PO create/edit: persist per-line `hsn_code, unit, discount_pct, gst_rate`
  and header `tax_kind, freight, round_off`; update `materials.last_rate`.
- masters.js: add new vendor/material columns to the allow-list; add
  `GET/PUT /company-profile`.

## Frontend
- **Shared `PoLineEditor` + `PoTotals`** (GST-aware) reused across Direct PO,
  convert, bulk, edit — removes the duplicated line markup and keeps totals
  identical everywhere.
- **Shared `PrLineEditor`** for New Requisition + PR edit (material + qty + UOM
  + est-rate + remarks per line; live item-count + estimated value footer).
- New Requisition modal: header (Requested By / Department / Needed By /
  Priority) + line editor + Reason/Remarks; per-line duplicate-active-PR warning.
- Direct PO modal: vendor (+GSTIN/state chip) + expected date + intra/inter tax
  toggle (auto from states) + GST line editor + totals panel + terms.
- Masters: vendor & material new fields; a **Company** profile editor.
- **POPrint.jsx**: full GST tax-style PO — buyer + supplier blocks, HSN/qty/
  rate/disc/taxable/GST/amount columns, CGST-SGST or IGST summary, freight,
  round-off, grand total, `Rupees … Only`.

## Verification
Per project rules: verify in the REAL running app (login admin@ci.local /
admin123, desktop). Server edits may not hot-reload → verify via a temp server
on a spare port reusing live PG :5439. Any test data scoped with `UAT-` markers;
never an unscoped DELETE. No git commits.
