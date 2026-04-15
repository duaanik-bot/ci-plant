-- Die Hub + Emboss Block Hub append-only event logs
CREATE TABLE "die_hub_events" (
    "id" TEXT NOT NULL,
    "dye_id" TEXT NOT NULL,
    "action_type" VARCHAR(64) NOT NULL,
    "from_zone" VARCHAR(128),
    "to_zone" VARCHAR(128),
    "details" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "die_hub_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "die_hub_events_dye_id_idx" ON "die_hub_events"("dye_id");
CREATE INDEX "die_hub_events_created_at_idx" ON "die_hub_events"("created_at" DESC);

ALTER TABLE "die_hub_events" ADD CONSTRAINT "die_hub_events_dye_id_fkey" FOREIGN KEY ("dye_id") REFERENCES "dyes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "emboss_hub_events" (
    "id" TEXT NOT NULL,
    "block_id" TEXT NOT NULL,
    "action_type" VARCHAR(64) NOT NULL,
    "from_zone" VARCHAR(128),
    "to_zone" VARCHAR(128),
    "details" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "emboss_hub_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "emboss_hub_events_block_id_idx" ON "emboss_hub_events"("block_id");
CREATE INDEX "emboss_hub_events_created_at_idx" ON "emboss_hub_events"("created_at" DESC);

ALTER TABLE "emboss_hub_events" ADD CONSTRAINT "emboss_hub_events_block_id_fkey" FOREIGN KEY ("block_id") REFERENCES "emboss_blocks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
