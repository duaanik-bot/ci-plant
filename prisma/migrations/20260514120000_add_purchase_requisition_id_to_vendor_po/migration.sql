-- Link converted POs back to their source PR.

ALTER TABLE "vendor_material_purchase_orders"
    ADD COLUMN "purchase_requisition_id" TEXT;

CREATE INDEX "vendor_material_purchase_orders_purchase_requisition_id_idx"
    ON "vendor_material_purchase_orders" ("purchase_requisition_id");

ALTER TABLE "vendor_material_purchase_orders"
    ADD CONSTRAINT "vendor_material_purchase_orders_purchase_requisition_id_fkey"
    FOREIGN KEY ("purchase_requisition_id")
    REFERENCES "purchase_requisitions" ("id")
    ON DELETE SET NULL
    ON UPDATE CASCADE;
