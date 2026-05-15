-- Dispatch + Billing + Short & Excess Module
-- All additive: NULL-safe columns, new indexes, new FKs.
-- Safe to apply on a populated database; no destructive operations.

-- ─────────────────────────────────────────
-- DISPATCH: add PO-line link, packing config, tolerance snapshot, billing handshake, transport.
-- ─────────────────────────────────────────
ALTER TABLE "dispatches"
  ADD COLUMN "po_line_item_id" TEXT,
  ADD COLUMN "po_qty_snapshot" INTEGER,
  ADD COLUMN "tolerance_pct_snapshot" DECIMAL(5, 2),
  ADD COLUMN "allowed_qty" INTEGER,
  ADD COLUMN "excess_qty" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "packing_config" JSONB,
  ADD COLUMN "total_packed_qty" INTEGER,
  ADD COLUMN "transport_mode" VARCHAR(8),
  ADD COLUMN "transporter_name" VARCHAR(120),
  ADD COLUMN "distance_km" DECIMAL(8, 2),
  ADD COLUMN "billing_status" VARCHAR(20) NOT NULL DEFAULT 'not_sent',
  ADD COLUMN "bill_id" TEXT,
  ADD COLUMN "short_excess_record_id" TEXT;

CREATE INDEX "dispatches_po_line_item_id_idx" ON "dispatches"("po_line_item_id");
CREATE INDEX "dispatches_billing_status_idx" ON "dispatches"("billing_status");
CREATE INDEX "dispatches_bill_id_idx" ON "dispatches"("bill_id");

ALTER TABLE "dispatches"
  ADD CONSTRAINT "dispatches_po_line_item_id_fkey"
  FOREIGN KEY ("po_line_item_id") REFERENCES "po_line_items"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Bill FK added after the bills table extensions below (forward-declared because the FK is set during the same migration).

-- ─────────────────────────────────────────
-- CUSTOMER: GST invoicing fields (state code drives CGST/SGST vs IGST).
-- ─────────────────────────────────────────
ALTER TABLE "customers"
  ADD COLUMN "pan" VARCHAR(10),
  ADD COLUMN "state_code" VARCHAR(2),
  ADD COLUMN "billing_address" TEXT,
  ADD COLUMN "shipping_address" TEXT;

-- ─────────────────────────────────────────
-- CARTON MASTER: HSN code per SKU.
-- ─────────────────────────────────────────
ALTER TABLE "cartons"
  ADD COLUMN "hsn_code" VARCHAR(8);

-- ─────────────────────────────────────────
-- PO LINE: HSN snapshot (locked at PO entry for the order's lifetime).
-- ─────────────────────────────────────────
ALTER TABLE "po_line_items"
  ADD COLUMN "hsn_code" VARCHAR(8);

-- ─────────────────────────────────────────
-- BILLS: full Indian GST split + place-of-supply + transport/e-way.
-- Existing rows keep gst_amount; cgst/sgst/igst default to 0.
-- ─────────────────────────────────────────
ALTER TABLE "bills"
  ADD COLUMN "financial_year" VARCHAR(8),
  ADD COLUMN "place_of_supply_state_code" VARCHAR(2),
  ADD COLUMN "tax_split" VARCHAR(8) NOT NULL DEFAULT 'intra',
  ADD COLUMN "cgst_amount" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN "sgst_amount" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN "igst_amount" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN "hsn_summary" JSONB,
  ADD COLUMN "transport_mode" VARCHAR(8),
  ADD COLUMN "transporter_name" VARCHAR(120),
  ADD COLUMN "vehicle_number" VARCHAR(30),
  ADD COLUMN "distance_km" DECIMAL(8, 2),
  ADD COLUMN "eway_bill_number" VARCHAR(30),
  ADD COLUMN "eway_bill_expiry" DATE,
  ADD COLUMN "eway_applicable" BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX "bills_financial_year_idx" ON "bills"("financial_year");
CREATE INDEX "bills_customer_id_idx" ON "bills"("customer_id");

-- ─────────────────────────────────────────
-- BILL LINE ITEMS: per-line GST split + dispatch backlink + HSN snapshot.
-- ─────────────────────────────────────────
ALTER TABLE "bill_line_items"
  ADD COLUMN "dispatch_id" TEXT,
  ADD COLUMN "hsn_code" VARCHAR(8),
  ADD COLUMN "taxable_amount" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN "cgst_amount" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN "sgst_amount" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN "igst_amount" DECIMAL(12, 2) NOT NULL DEFAULT 0;

CREATE INDEX "bill_line_items_dispatch_id_idx" ON "bill_line_items"("dispatch_id");

-- Now wire Dispatch.bill_id -> Bills.id.
ALTER TABLE "dispatches"
  ADD CONSTRAINT "dispatches_bill_id_fkey"
  FOREIGN KEY ("bill_id") REFERENCES "bills"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
