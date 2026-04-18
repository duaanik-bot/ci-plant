-- Shade card inventory: MFG date, active flag, Product Master (carton) link
ALTER TABLE "shade_cards" ADD COLUMN "mfg_date" DATE;
ALTER TABLE "shade_cards" ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "shade_cards" ADD COLUMN "product_id" TEXT;

CREATE INDEX "shade_cards_product_id_idx" ON "shade_cards"("product_id");

ALTER TABLE "shade_cards" ADD CONSTRAINT "shade_cards_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "cartons"("id") ON DELETE SET NULL ON UPDATE CASCADE;
