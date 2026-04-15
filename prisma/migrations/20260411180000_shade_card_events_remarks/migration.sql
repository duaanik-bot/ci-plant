-- Shade card ledger: remarks + append-only events (after shade_cards table exists)
ALTER TABLE "shade_cards" ADD COLUMN IF NOT EXISTS "remarks" TEXT;

CREATE TABLE "shade_card_events" (
    "id" TEXT NOT NULL,
    "shade_card_id" TEXT NOT NULL,
    "action_type" VARCHAR(64) NOT NULL,
    "details" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shade_card_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "shade_card_events_shade_card_id_idx" ON "shade_card_events"("shade_card_id");
CREATE INDEX "shade_card_events_created_at_idx" ON "shade_card_events"("created_at" DESC);

ALTER TABLE "shade_card_events" ADD CONSTRAINT "shade_card_events_shade_card_id_fkey"
  FOREIGN KEY ("shade_card_id") REFERENCES "shade_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
