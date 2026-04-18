-- Partial GRN ledger + cumulative received kg on vendor material PO
ALTER TABLE "vendor_material_purchase_orders" ADD COLUMN IF NOT EXISTS "total_received_kg" DECIMAL(16,6) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "vendor_material_receipts" (
    "id" TEXT NOT NULL,
    "vendor_po_id" TEXT NOT NULL,
    "receipt_date" TIMESTAMP(3) NOT NULL,
    "received_qty" DECIMAL(16,6) NOT NULL,
    "vehicle_number" VARCHAR(64) NOT NULL,
    "scale_slip_id" VARCHAR(120) NOT NULL,
    "received_by_user_id" TEXT,
    "received_by_name" VARCHAR(120) NOT NULL DEFAULT 'Anik Dua',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_material_receipts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "vendor_material_receipts_vendor_po_id_idx" ON "vendor_material_receipts"("vendor_po_id");

ALTER TABLE "vendor_material_receipts" DROP CONSTRAINT IF EXISTS "vendor_material_receipts_vendor_po_id_fkey";
ALTER TABLE "vendor_material_receipts" ADD CONSTRAINT "vendor_material_receipts_vendor_po_id_fkey" FOREIGN KEY ("vendor_po_id") REFERENCES "vendor_material_purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
