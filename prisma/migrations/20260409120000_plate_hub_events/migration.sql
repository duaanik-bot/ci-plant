-- CreateTable
CREATE TABLE "plate_hub_events" (
    "id" TEXT NOT NULL,
    "plate_requirement_id" TEXT,
    "plate_store_id" TEXT,
    "action_type" VARCHAR(64) NOT NULL,
    "from_zone" VARCHAR(128),
    "to_zone" VARCHAR(128),
    "details" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plate_hub_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "plate_hub_events_plate_requirement_id_idx" ON "plate_hub_events"("plate_requirement_id");

CREATE INDEX "plate_hub_events_plate_store_id_idx" ON "plate_hub_events"("plate_store_id");

CREATE INDEX "plate_hub_events_created_at_idx" ON "plate_hub_events"("created_at" DESC);

ALTER TABLE "plate_hub_events" ADD CONSTRAINT "plate_hub_events_plate_requirement_id_fkey" FOREIGN KEY ("plate_requirement_id") REFERENCES "plate_requirements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "plate_hub_events" ADD CONSTRAINT "plate_hub_events_plate_store_id_fkey" FOREIGN KEY ("plate_store_id") REFERENCES "plate_store"("id") ON DELETE SET NULL ON UPDATE CASCADE;
