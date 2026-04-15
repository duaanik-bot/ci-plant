-- Per-channel usage cycle counts for Plate Hub star ledger (legacy rows default to {})
ALTER TABLE "plate_store" ADD COLUMN "cycle_data" JSONB NOT NULL DEFAULT '{}'::jsonb;
