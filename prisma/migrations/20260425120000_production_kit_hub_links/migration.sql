-- Emboss block ↔ die link, artwork PDF, explicit material/relief, cumulative strike counter
ALTER TABLE "emboss_blocks" ADD COLUMN IF NOT EXISTS "linked_die_id" UUID;
ALTER TABLE "emboss_blocks" ADD COLUMN IF NOT EXISTS "artwork_ref_link" VARCHAR(600);
ALTER TABLE "emboss_blocks" ADD COLUMN IF NOT EXISTS "material_type" VARCHAR(32);
ALTER TABLE "emboss_blocks" ADD COLUMN IF NOT EXISTS "relief_depth_mm" DECIMAL(4,2);
ALTER TABLE "emboss_blocks" ADD COLUMN IF NOT EXISTS "cumulative_strikes" INTEGER NOT NULL DEFAULT 0;

UPDATE "emboss_blocks" SET "cumulative_strikes" = "impression_count" WHERE "cumulative_strikes" = 0 AND "impression_count" > 0;
UPDATE "emboss_blocks" SET "relief_depth_mm" = "emboss_depth" WHERE "relief_depth_mm" IS NULL AND "emboss_depth" IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'emboss_blocks_linked_die_id_fkey'
  ) THEN
    ALTER TABLE "emboss_blocks"
      ADD CONSTRAINT "emboss_blocks_linked_die_id_fkey"
      FOREIGN KEY ("linked_die_id") REFERENCES "dyes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "emboss_blocks_linked_die_id_idx" ON "emboss_blocks"("linked_die_id");

-- Carton ↔ shade card (production kit)
ALTER TABLE "cartons" ADD COLUMN IF NOT EXISTS "shade_card_id" UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'cartons_shade_card_id_fkey'
  ) THEN
    ALTER TABLE "cartons"
      ADD CONSTRAINT "cartons_shade_card_id_fkey"
      FOREIGN KEY ("shade_card_id") REFERENCES "shade_cards"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "cartons_shade_card_id_idx" ON "cartons"("shade_card_id");

-- PO line shade override
ALTER TABLE "po_line_items" ADD COLUMN IF NOT EXISTS "shade_card_id" UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'po_line_items_shade_card_id_fkey'
  ) THEN
    ALTER TABLE "po_line_items"
      ADD CONSTRAINT "po_line_items_shade_card_id_fkey"
      FOREIGN KEY ("shade_card_id") REFERENCES "shade_cards"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "po_line_items_shade_card_id_idx" ON "po_line_items"("shade_card_id");

-- Shade card: ink kitchen link, customer scan, precomputed valid-until (last verify + 180d)
ALTER TABLE "shade_cards" ADD COLUMN IF NOT EXISTS "ink_recipe_link" VARCHAR(600);
ALTER TABLE "shade_cards" ADD COLUMN IF NOT EXISTS "customer_approval_doc" VARCHAR(600);
ALTER TABLE "shade_cards" ADD COLUMN IF NOT EXISTS "valid_until" DATE;

UPDATE "shade_cards" SET "customer_approval_doc" = "approval_attachment_url"
  WHERE "customer_approval_doc" IS NULL AND "approval_attachment_url" IS NOT NULL;

UPDATE "shade_cards" SET "valid_until" = ("last_verified_at" + INTERVAL '180 days')::date
  WHERE "valid_until" IS NULL AND "last_verified_at" IS NOT NULL;
