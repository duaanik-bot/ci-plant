-- AlterTable: Excel-import + warehouse verification fields
ALTER TABLE "cartons" ADD COLUMN "sheet_size_l" DECIMAL(8,2);
ALTER TABLE "cartons" ADD COLUMN "sheet_size_w" DECIMAL(8,2);
ALTER TABLE "cartons" ADD COLUMN "ups" INTEGER;
ALTER TABLE "cartons" ADD COLUMN "physical_l" DECIMAL(8,2);
ALTER TABLE "cartons" ADD COLUMN "physical_w" DECIMAL(8,2);
ALTER TABLE "cartons" ADD COLUMN "physical_h" DECIMAL(8,2);
ALTER TABLE "cartons" ADD COLUMN "size_verified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "cartons" ADD COLUMN "size_verified_at" TIMESTAMP(3);
ALTER TABLE "cartons" ADD COLUMN "size_verified_by" TEXT;
ALTER TABLE "cartons" ADD COLUMN "size_variance_notes" TEXT;

-- CreateIndex: smart-search / planning filters
CREATE INDEX "cartons_size_verified_idx" ON "cartons"("size_verified");
CREATE INDEX "cartons_customer_id_carton_name_idx" ON "cartons"("customer_id", "carton_name");
