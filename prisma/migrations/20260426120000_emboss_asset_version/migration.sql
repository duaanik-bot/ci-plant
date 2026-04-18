-- Optional human-readable asset revision for Emboss Hub identity line.
ALTER TABLE "emboss_blocks" ADD COLUMN IF NOT EXISTS "asset_version_id" VARCHAR(40);
