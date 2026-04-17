-- Customer PO: explicit delivery date for MRP
ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "delivery_required_by" DATE;

-- Line-level board procurement tracking
ALTER TABLE "po_line_items" ADD COLUMN IF NOT EXISTS "material_procurement_status" VARCHAR(32) NOT NULL DEFAULT 'pending';

-- Vendor material PO header
CREATE TABLE IF NOT EXISTS "vendor_material_purchase_orders" (
    "id" TEXT NOT NULL,
    "po_number" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'draft',
    "order_date" DATE NOT NULL DEFAULT CURRENT_DATE,
    "required_delivery_date" DATE,
    "signatory_name" VARCHAR(120) NOT NULL DEFAULT 'Anik Dua',
    "remarks" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_material_purchase_orders_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "vendor_material_purchase_orders_po_number_key" ON "vendor_material_purchase_orders"("po_number");

CREATE TABLE IF NOT EXISTS "vendor_material_po_lines" (
    "id" TEXT NOT NULL,
    "vendor_po_id" TEXT NOT NULL,
    "board_grade" TEXT NOT NULL,
    "gsm" INTEGER NOT NULL,
    "grain_direction" VARCHAR(64) NOT NULL DEFAULT 'Long grain',
    "total_sheets" INTEGER NOT NULL,
    "total_weight_kg" DECIMAL(16,6) NOT NULL,
    "rate_per_kg" DECIMAL(14,4),
    "linked_po_line_ids" JSONB NOT NULL,

    CONSTRAINT "vendor_material_po_lines_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'vendor_material_purchase_orders_supplier_id_fkey'
  ) THEN
    ALTER TABLE "vendor_material_purchase_orders"
      ADD CONSTRAINT "vendor_material_purchase_orders_supplier_id_fkey"
      FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'vendor_material_po_lines_vendor_po_id_fkey'
  ) THEN
    ALTER TABLE "vendor_material_po_lines"
      ADD CONSTRAINT "vendor_material_po_lines_vendor_po_id_fkey"
      FOREIGN KEY ("vendor_po_id") REFERENCES "vendor_material_purchase_orders"("id") ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "vendor_material_po_lines_vendor_po_id_idx" ON "vendor_material_po_lines"("vendor_po_id");
