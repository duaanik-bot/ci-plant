-- Shade card live custody: optional job link + remark edit audit
ALTER TABLE "shade_cards" ADD COLUMN IF NOT EXISTS "remarks_edited_at" TIMESTAMP(3);
ALTER TABLE "shade_cards" ADD COLUMN IF NOT EXISTS "remarks_edited_by_name" VARCHAR(120);
ALTER TABLE "shade_cards" ADD COLUMN IF NOT EXISTS "issued_job_card_id" TEXT;

CREATE INDEX IF NOT EXISTS "shade_cards_issued_job_card_id_idx" ON "shade_cards"("issued_job_card_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'shade_cards_issued_job_card_id_fkey'
  ) THEN
    ALTER TABLE "shade_cards"
      ADD CONSTRAINT "shade_cards_issued_job_card_id_fkey"
      FOREIGN KEY ("issued_job_card_id") REFERENCES "production_job_cards"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
