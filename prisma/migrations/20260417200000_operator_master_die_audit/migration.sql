-- Operator Master (Die Hub floor identity)
CREATE TABLE "operator_master" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(120) NOT NULL,
    "department" VARCHAR(64) NOT NULL DEFAULT 'Press',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "operator_master_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "operator_master_name_key" ON "operator_master"("name");

INSERT INTO "operator_master" ("id", "name", "department", "is_active", "created_at", "updated_at")
VALUES (gen_random_uuid(), 'Anik Dua', 'Press', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Die hub events: retrospective audit fields + non-destructive undo chain
ALTER TABLE "die_hub_events" ADD COLUMN "actor_name" VARCHAR(120);
ALTER TABLE "die_hub_events" ADD COLUMN "audit_action_type" VARCHAR(32);
ALTER TABLE "die_hub_events" ADD COLUMN "metadata" JSONB;
ALTER TABLE "die_hub_events" ADD COLUMN "superseded_by_undo_event_id" UUID;

ALTER TABLE "die_hub_events" ADD CONSTRAINT "die_hub_events_superseded_by_undo_event_id_fkey"
  FOREIGN KEY ("superseded_by_undo_event_id") REFERENCES "die_hub_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "die_hub_events_superseded_by_undo_event_id_idx" ON "die_hub_events"("superseded_by_undo_event_id");

UPDATE "die_hub_events" SET "actor_name" = "operator_name" WHERE "actor_name" IS NULL AND "operator_name" IS NOT NULL;
