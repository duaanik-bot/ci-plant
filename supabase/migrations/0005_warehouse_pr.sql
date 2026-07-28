-- Warehouse as a procurement entry point — three additive columns.
--
-- materials.min_stock / max_stock: the replenishment band a stock-replenishment
-- PR aims to restore. Both default to 0, which the app reads as "not set" and
-- renders as "—", so all ~300 existing boards stay valid with no backfill. They
-- are NOT the same as reorder_level, which stays the trigger point.
--
-- requisitions.purpose: why a PR was raised. Defaults to 'production', which is
-- correct for every row that already exists (all of them were job-driven), so
-- no UPDATE is needed. Reporting only — it gates nothing, and the server
-- normalises any unknown value back to 'production'.
--
-- Fully idempotent. Replaying this file is a no-op.

ALTER TABLE materials ADD COLUMN IF NOT EXISTS min_stock DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE materials ADD COLUMN IF NOT EXISTS max_stock DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'production';
