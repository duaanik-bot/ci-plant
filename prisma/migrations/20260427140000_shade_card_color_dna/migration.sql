-- Shade card Color DNA: substrate, CIE Lab, ink notes, spectro log
ALTER TABLE "shade_cards" ADD COLUMN "substrate_type" VARCHAR(32);
ALTER TABLE "shade_cards" ADD COLUMN "lab_l" DECIMAL(10,4);
ALTER TABLE "shade_cards" ADD COLUMN "lab_a" DECIMAL(10,4);
ALTER TABLE "shade_cards" ADD COLUMN "lab_b" DECIMAL(10,4);
ALTER TABLE "shade_cards" ADD COLUMN "ink_recipe_notes" TEXT;
ALTER TABLE "shade_cards" ADD COLUMN "spectro_scan_log" JSONB;
