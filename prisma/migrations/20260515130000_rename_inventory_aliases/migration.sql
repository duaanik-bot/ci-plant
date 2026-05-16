-- Rename inventory columns to match domain language.
-- max_daily_usage was being aliased to packet_weight in the API layer;
-- max_storage_qty was being aliased to sheets_per_packet.
-- The schema now matches the API/domain names directly.

ALTER TABLE "inventory"
  RENAME COLUMN "max_daily_usage" TO "packet_weight";

ALTER TABLE "inventory"
  RENAME COLUMN "max_storage_qty" TO "sheets_per_packet";

-- Paper-quality fields that were previously surfaced as null in the API.
ALTER TABLE "inventory"
  ADD COLUMN "brightness_pct" DOUBLE PRECISION,
  ADD COLUMN "moisture_pct"   DOUBLE PRECISION;
