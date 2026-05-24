-- AlterTable
ALTER TABLE "purchase_requisitions" ADD COLUMN "required_sheets" INTEGER;
ALTER TABLE "purchase_requisitions" ADD COLUMN "customer_po_number" VARCHAR(60);
ALTER TABLE "purchase_requisitions" ADD COLUMN "product_name" VARCHAR(160);

-- AlterTable
ALTER TABLE "stock_movements" ADD COLUMN "reserved_by_name" VARCHAR(160);
