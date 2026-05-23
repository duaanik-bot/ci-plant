-- AlterTable: add materialId FK to vendor_material_purchase_orders
ALTER TABLE "vendor_material_purchase_orders" ADD COLUMN "material_id" TEXT;

-- AddForeignKey
ALTER TABLE "vendor_material_purchase_orders"
  ADD CONSTRAINT "vendor_material_purchase_orders_material_id_fkey"
  FOREIGN KEY ("material_id") REFERENCES "inventory"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "vendor_material_purchase_orders_material_id_idx"
  ON "vendor_material_purchase_orders"("material_id");
