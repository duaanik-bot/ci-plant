-- Hub priority: who last reordered a card (audit line on board cards)
ALTER TABLE "plate_requirements" ADD COLUMN IF NOT EXISTS "last_reordered_by" VARCHAR(120);
ALTER TABLE "plate_requirements" ADD COLUMN IF NOT EXISTS "last_reordered_at" TIMESTAMP(3);

ALTER TABLE "dyes" ADD COLUMN IF NOT EXISTS "last_reordered_by" VARCHAR(120);
ALTER TABLE "dyes" ADD COLUMN IF NOT EXISTS "last_reordered_at" TIMESTAMP(3);

ALTER TABLE "emboss_blocks" ADD COLUMN IF NOT EXISTS "last_reordered_by" VARCHAR(120);
ALTER TABLE "emboss_blocks" ADD COLUMN IF NOT EXISTS "last_reordered_at" TIMESTAMP(3);

ALTER TABLE "shade_cards" ADD COLUMN IF NOT EXISTS "last_reordered_by" VARCHAR(120);
ALTER TABLE "shade_cards" ADD COLUMN IF NOT EXISTS "last_reordered_at" TIMESTAMP(3);
