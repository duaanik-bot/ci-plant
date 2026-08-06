-- Boxes belong to the day they were packed, not only to the finished stage.
--
-- A packing line was keyed to the job_stage alone, so the manifest could only be
-- filled in at completion. A stage that runs for four days is packed on four
-- days, and forcing the whole manifest to the last one loses which boxes were
-- made when — and leaves the operator retyping at the end what he already knew
-- on the day.
--
-- NULL stage_run_id keeps its old meaning: a line belonging to the stage's final
-- manifest. A line raised on a day count carries that run's id, so deleting the
-- day count takes its boxes with it (ON DELETE CASCADE) rather than leaving
-- boxes behind for production that no longer exists.
ALTER TABLE packing_lines
  ADD COLUMN IF NOT EXISTS stage_run_id INTEGER REFERENCES stage_runs(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_packing_lines_run ON packing_lines(stage_run_id);
