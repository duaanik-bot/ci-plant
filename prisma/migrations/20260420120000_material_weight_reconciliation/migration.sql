-- Smart weight reconciliation (procurement gate vs vendor invoice)

CREATE TABLE IF NOT EXISTS "material_weight_reconciliations" (
    "id" TEXT NOT NULL,
    "po_line_item_id" TEXT NOT NULL,
    "vendor_material_po_line_id" TEXT,
    "invoice_number" VARCHAR(64),
    "invoice_weight_kg" DECIMAL(16,6) NOT NULL,
    "scale_weight_kg" DECIMAL(16,6) NOT NULL,
    "core_weight_kg" DECIMAL(16,6) NOT NULL,
    "net_received_kg" DECIMAL(16,6) NOT NULL,
    "variance_kg" DECIMAL(16,6) NOT NULL,
    "variance_percent" DECIMAL(12,6),
    "rate_per_kg_inr" DECIMAL(14,4),
    "reconciliation_status" VARCHAR(40) NOT NULL DEFAULT 'ok',
    "debit_note_draft_text" TEXT,
    "debit_note_drafted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "material_weight_reconciliations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "material_weight_reconciliations_po_line_item_id_key" ON "material_weight_reconciliations"("po_line_item_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'material_weight_reconciliations_po_line_item_id_fkey'
  ) THEN
    ALTER TABLE "material_weight_reconciliations"
      ADD CONSTRAINT "material_weight_reconciliations_po_line_item_id_fkey"
      FOREIGN KEY ("po_line_item_id") REFERENCES "po_line_items"("id") ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;
END $$;
