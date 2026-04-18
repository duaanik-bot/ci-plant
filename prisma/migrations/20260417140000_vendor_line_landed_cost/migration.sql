-- AlterTable
ALTER TABLE "vendor_material_po_lines" ADD COLUMN "freight_total_inr" DECIMAL(16,2) NOT NULL DEFAULT 0;
ALTER TABLE "vendor_material_po_lines" ADD COLUMN "unloading_charges_inr" DECIMAL(16,2) NOT NULL DEFAULT 0;
ALTER TABLE "vendor_material_po_lines" ADD COLUMN "insurance_misc_inr" DECIMAL(16,2) NOT NULL DEFAULT 0;
ALTER TABLE "vendor_material_po_lines" ADD COLUMN "landed_rate_per_kg" DECIMAL(14,4);
