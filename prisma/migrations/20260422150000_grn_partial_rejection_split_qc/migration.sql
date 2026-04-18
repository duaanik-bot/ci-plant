-- Partial rejection: split QC quantities, rejection reason, return gate pass, PO accrued payable.

ALTER TABLE "vendor_material_purchase_orders"
  ADD COLUMN IF NOT EXISTS "accrued_receipt_payable_inr" DECIMAL(16, 2) NOT NULL DEFAULT 0;

ALTER TABLE "vendor_material_receipts"
  ADD COLUMN IF NOT EXISTS "qty_accepted_standard" DECIMAL(16, 6),
  ADD COLUMN IF NOT EXISTS "qty_accepted_penalty" DECIMAL(16, 6),
  ADD COLUMN IF NOT EXISTS "qty_rejected" DECIMAL(16, 6),
  ADD COLUMN IF NOT EXISTS "rejection_reason" VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "rejection_remarks" TEXT,
  ADD COLUMN IF NOT EXISTS "return_gate_pass_generated_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "qc_accrued_payable_inr" DECIMAL(16, 2);
