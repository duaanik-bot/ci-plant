-- AlterTable
ALTER TABLE "material_reservations" ADD COLUMN "is_released" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "material_reservations" ADD COLUMN "released_at" TIMESTAMP(3);
ALTER TABLE "material_reservations" ADD COLUMN "released_reason" VARCHAR(120);
ALTER TABLE "material_reservations" ADD COLUMN "confirmed_qty" INTEGER;

-- CreateIndex
CREATE INDEX "material_reservations_material_id_is_released_idx" ON "material_reservations"("material_id", "is_released");

-- AlterTable
ALTER TABLE "purchase_requisitions" ALTER COLUMN "raised_by" DROP NOT NULL;
