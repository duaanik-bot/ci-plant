-- Optional customer logo for master / queue avatars
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "logo_url" VARCHAR(500);
