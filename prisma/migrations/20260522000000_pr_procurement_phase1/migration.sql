-- AlterTable
ALTER TABLE "purchase_requisitions" ADD COLUMN "remarks" TEXT;
ALTER TABLE "purchase_requisitions" ADD COLUMN "required_by_date" DATE;

-- AlterTable
ALTER TABLE "vendor_material_purchase_orders" ADD COLUMN "payment_terms" VARCHAR(200);
ALTER TABLE "vendor_material_purchase_orders" ADD COLUMN "transport_terms" VARCHAR(200);

-- CreateTable
CREATE TABLE "vendor_po_requisition_links" (
    "id" TEXT NOT NULL,
    "vendor_po_id" TEXT NOT NULL,
    "purchase_requisition_id" TEXT NOT NULL,
    "allocated_qty" DECIMAL(12,3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "vendor_po_requisition_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vendor_po_requisition_links_vendor_po_id_purchase_requisiti_key" ON "vendor_po_requisition_links"("vendor_po_id", "purchase_requisition_id");

-- CreateIndex
CREATE INDEX "vendor_po_requisition_links_purchase_requisition_id_idx" ON "vendor_po_requisition_links"("purchase_requisition_id");

-- AddForeignKey
ALTER TABLE "vendor_po_requisition_links" ADD CONSTRAINT "vendor_po_requisition_links_vendor_po_id_fkey" FOREIGN KEY ("vendor_po_id") REFERENCES "vendor_material_purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "vendor_po_requisition_links" ADD CONSTRAINT "vendor_po_requisition_links_purchase_requisition_id_fkey" FOREIGN KEY ("purchase_requisition_id") REFERENCES "purchase_requisitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
