-- Preventive maintenance scheduler: usage counters, schedule config, PM logs, planned downtime

ALTER TABLE "machines" ADD COLUMN "usage_run_hours_since_pm" DECIMAL(14,4) NOT NULL DEFAULT 0;
ALTER TABLE "machines" ADD COLUMN "usage_impressions_since_pm" BIGINT NOT NULL DEFAULT 0;

CREATE TABLE "machine_pm_schedules" (
    "id" TEXT NOT NULL,
    "machine_id" TEXT NOT NULL,
    "interval_run_hours" DECIMAL(12,4) NOT NULL,
    "interval_impressions" BIGINT NOT NULL,
    "task_checklist_json" JSONB,
    "spare_parts_placeholder" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "machine_pm_schedules_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "machine_pm_schedules_machine_id_key" ON "machine_pm_schedules"("machine_id");

ALTER TABLE "machine_pm_schedules" ADD CONSTRAINT "machine_pm_schedules_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "preventive_maintenance_logs" (
    "id" TEXT NOT NULL,
    "machine_id" TEXT NOT NULL,
    "verified_at" TIMESTAMP(3) NOT NULL,
    "verified_by_user_id" TEXT,
    "signed_off_note" VARCHAR(220) NOT NULL,
    "run_hours_before_reset" DECIMAL(14,4) NOT NULL,
    "impressions_before_reset" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "preventive_maintenance_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "preventive_maintenance_logs_machine_id_idx" ON "preventive_maintenance_logs"("machine_id");
CREATE INDEX "preventive_maintenance_logs_verified_at_idx" ON "preventive_maintenance_logs"("verified_at");

ALTER TABLE "preventive_maintenance_logs" ADD CONSTRAINT "preventive_maintenance_logs_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "preventive_maintenance_logs" ADD CONSTRAINT "preventive_maintenance_logs_verified_by_user_id_fkey" FOREIGN KEY ("verified_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "pm_planned_downtime" (
    "id" TEXT NOT NULL,
    "machine_id" TEXT NOT NULL,
    "planned_start" TIMESTAMP(3) NOT NULL,
    "planned_end" TIMESTAMP(3) NOT NULL,
    "note" VARCHAR(200),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pm_planned_downtime_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "pm_planned_downtime_planned_start_planned_end_idx" ON "pm_planned_downtime"("planned_start", "planned_end");

ALTER TABLE "pm_planned_downtime" ADD CONSTRAINT "pm_planned_downtime_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
