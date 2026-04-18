-- Quality-based debit notes + penalty snapshots on GRN receipts
ALTER TABLE "vendor_material_receipts" ALTER COLUMN "qc_status" TYPE VARCHAR(32);

ALTER TABLE "vendor_material_receipts" ADD COLUMN IF NOT EXISTS "qc_penalty_recommended_inr" DECIMAL(16,2);
ALTER TABLE "vendor_material_receipts" ADD COLUMN IF NOT EXISTS "qc_invoice_rate_per_kg" DECIMAL(14,4);
ALTER TABLE "vendor_material_receipts" ADD COLUMN IF NOT EXISTS "qc_technical_shortfall_pct" DECIMAL(10,4);

CREATE TABLE IF NOT EXISTS "vendor_quality_debit_notes" (
    "id" TEXT NOT NULL,
    "receipt_id" TEXT NOT NULL,
    "vendor_po_id" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "ordered_gsm" DECIMAL(8,2) NOT NULL,
    "actual_gsm" DECIMAL(8,2) NOT NULL,
    "technical_shortfall_pct" DECIMAL(10,4) NOT NULL,
    "invoice_rate_per_kg" DECIMAL(14,4) NOT NULL,
    "received_qty_kg" DECIMAL(16,6) NOT NULL,
    "amount_inr" DECIMAL(16,2) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'draft_pending_finance',
    "formula_proof" TEXT,
    "authorized_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_quality_debit_notes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "vendor_quality_debit_notes_receipt_id_key" ON "vendor_quality_debit_notes"("receipt_id");
CREATE INDEX IF NOT EXISTS "vendor_quality_debit_notes_vendor_po_id_idx" ON "vendor_quality_debit_notes"("vendor_po_id");
CREATE INDEX IF NOT EXISTS "vendor_quality_debit_notes_supplier_id_idx" ON "vendor_quality_debit_notes"("supplier_id");

ALTER TABLE "vendor_quality_debit_notes" DROP CONSTRAINT IF EXISTS "vendor_quality_debit_notes_receipt_id_fkey";
ALTER TABLE "vendor_quality_debit_notes" DROP CONSTRAINT IF EXISTS "vendor_quality_debit_notes_vendor_po_id_fkey";
ALTER TABLE "vendor_quality_debit_notes" DROP CONSTRAINT IF EXISTS "vendor_quality_debit_notes_supplier_id_fkey";

ALTER TABLE "vendor_quality_debit_notes" ADD CONSTRAINT "vendor_quality_debit_notes_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "vendor_material_receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "vendor_quality_debit_notes" ADD CONSTRAINT "vendor_quality_debit_notes_vendor_po_id_fkey" FOREIGN KEY ("vendor_po_id") REFERENCES "vendor_material_purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "vendor_quality_debit_notes" ADD CONSTRAINT "vendor_quality_debit_notes_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
