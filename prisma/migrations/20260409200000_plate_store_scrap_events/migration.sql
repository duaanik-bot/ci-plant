-- Granular plate channel scrap audit (Plate Hub)
CREATE TABLE IF NOT EXISTS "plate_store_scrap_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "plate_store_id" UUID NOT NULL,
    "scrapped_names" JSONB NOT NULL,
    "reason_code" TEXT NOT NULL,
    "reason_label" TEXT NOT NULL,
    "performed_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plate_store_scrap_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "plate_store_scrap_events_plate_store_id_idx" ON "plate_store_scrap_events"("plate_store_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'plate_store_scrap_events_plate_store_id_fkey'
  ) THEN
    ALTER TABLE "plate_store_scrap_events"
      ADD CONSTRAINT "plate_store_scrap_events_plate_store_id_fkey"
      FOREIGN KEY ("plate_store_id") REFERENCES "plate_store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
