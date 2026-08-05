-- Planning set-type triage — Single / Gang / Hold zones on the planning queue.
-- The planner tags each order line with how it will print: alone (single), on
-- a shared sheet (gang), or parked with a reason (hold). The stored value is
-- INTENT only; a line actually sitting in a gang_run reads as gang regardless,
-- and hold outranks both, so the queue's zones can never contradict the
-- physical run. Nothing here gates anything: readiness, planning and job
-- cards are untouched (physics hard, paperwork soft).

ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS set_type TEXT NOT NULL DEFAULT 'single';
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS hold_reason TEXT;
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS set_type_by TEXT;
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS set_type_at TIMESTAMPTZ;

ALTER TABLE order_lines DROP CONSTRAINT IF EXISTS order_lines_set_type_check;
ALTER TABLE order_lines ADD CONSTRAINT order_lines_set_type_check
  CHECK (set_type IN ('single','gang','hold'));
