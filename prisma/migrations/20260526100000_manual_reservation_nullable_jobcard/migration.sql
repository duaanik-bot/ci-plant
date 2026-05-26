-- Allow manual material reservations (block stock with no job attached).
-- Makes job_card_id nullable; the FK and (material_id, job_card_id) unique
-- constraint are unaffected (Postgres treats NULLs as distinct, so multiple
-- manual reservations per material are permitted).
ALTER TABLE "material_reservations" ALTER COLUMN "job_card_id" DROP NOT NULL;
