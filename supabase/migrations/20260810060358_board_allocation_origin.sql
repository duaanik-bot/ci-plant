-- Telling a machine-placed freeze from a planner's hand-placed hold.
--
-- A board_allocations row with source='stock' and job_board_mix_id NULL means
-- "a planner pressed Commit on this board while deciding". Locking a plan is
-- about to write a row of exactly that shape for a different reason — the
-- engine reserving what the shelf can cover — and the two must not be confused.
--
-- They must not be confused because replaceMixPlan ABSORBS the first kind: it
-- releases this line's hand-placed holds on any board the new mix names, so
-- committing 500 by hand and then locking a 2,000-sheet mix row leaves 2,000
-- held rather than 2,500. That absorb is correct and stays. But it matches on
-- `source='stock' AND job_board_mix_id IS NULL`, so without a marker here it
-- would swallow an engine freeze on every mix save.
--
-- Why not a new `source` value: source is CHECK-constrained to ('stock',
-- 'requisition') and twelve filters test source='stock' — including
-- issuableFor(), the gate that stops one job drawing another job's board. A
-- new value would make frozen sheets read as FREE on the cutting floor.
--
-- Why not a `reason` tag: reason is free text typed by the user on both
-- /board/move and /board/commit. It is forgeable and it is not a key.
--
-- NULL means every row written before this migration, and every hand-placed or
-- mix-mirrored row written after it. Deliberately no DEFAULT: a defaulted ADD
-- COLUMN rewrites every existing row, and there is nothing to say about holds
-- already on file.
ALTER TABLE board_allocations ADD COLUMN IF NOT EXISTS origin TEXT;
ALTER TABLE board_allocations DROP CONSTRAINT IF EXISTS board_allocations_origin_check;
ALTER TABLE board_allocations ADD CONSTRAINT board_allocations_origin_check
  CHECK (origin IS NULL OR origin IN ('plan_lock'));

-- Phase 2 reads "this line's engine freeze on this board" on every lock,
-- re-lock and release. Partial: plan_lock rows are the minority and the index
-- stays small.
CREATE INDEX IF NOT EXISTS idx_alloc_origin_active
  ON board_allocations (order_line_id, material_id)
  WHERE status = 'active' AND origin = 'plan_lock';
