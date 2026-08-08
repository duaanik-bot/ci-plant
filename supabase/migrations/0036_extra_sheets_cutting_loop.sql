-- Extra Sheets continuation after approval:
-- approval sends the linked request to Cutting, Cutting prepares the extra
-- sheets on a separate counter, and only the final handoff refills Printing.

ALTER TABLE extra_sheet_requests DROP CONSTRAINT IF EXISTS extra_sheet_requests_status_check;
ALTER TABLE extra_sheet_requests ADD CONSTRAINT extra_sheet_requests_status_check
  CHECK (status IN (
    'pending',
    'approved',
    'sent_to_cutting',
    'cutting_in_progress',
    'cutting_completed',
    'ready_for_printing',
    'issued',
    'rejected',
    'cancelled'
  ));

ALTER TABLE extra_sheet_requests ADD COLUMN IF NOT EXISTS board_material_id INTEGER REFERENCES materials(id);
ALTER TABLE extra_sheet_requests ADD COLUMN IF NOT EXISTS cuts_per_parent INTEGER;
ALTER TABLE extra_sheet_requests ADD COLUMN IF NOT EXISTS sent_to_cutting_at TIMESTAMPTZ;
ALTER TABLE extra_sheet_requests ADD COLUMN IF NOT EXISTS cutting_started_by TEXT;
ALTER TABLE extra_sheet_requests ADD COLUMN IF NOT EXISTS cutting_started_at TIMESTAMPTZ;
ALTER TABLE extra_sheet_requests ADD COLUMN IF NOT EXISTS cutting_completed_by TEXT;
ALTER TABLE extra_sheet_requests ADD COLUMN IF NOT EXISTS cutting_completed_at TIMESTAMPTZ;
ALTER TABLE extra_sheet_requests ADD COLUMN IF NOT EXISTS cutting_actual_qty INTEGER;
ALTER TABLE extra_sheet_requests ADD COLUMN IF NOT EXISTS cutting_wastage_qty INTEGER;
ALTER TABLE extra_sheet_requests ADD COLUMN IF NOT EXISTS cutting_good_qty INTEGER;
ALTER TABLE extra_sheet_requests ADD COLUMN IF NOT EXISTS cutting_machine_id INTEGER REFERENCES machines(id);
ALTER TABLE extra_sheet_requests ADD COLUMN IF NOT EXISTS cutting_note TEXT;
ALTER TABLE extra_sheet_requests ADD COLUMN IF NOT EXISTS issued_stage_qty INTEGER;
ALTER TABLE extra_sheet_requests ADD COLUMN IF NOT EXISTS stock_movement_ids JSONB;

CREATE INDEX IF NOT EXISTS idx_extra_sheet_requests_cutting_queue
  ON extra_sheet_requests (status, approved_at DESC)
  WHERE status IN (
    'approved',
    'sent_to_cutting',
    'cutting_in_progress',
    'cutting_completed',
    'ready_for_printing'
  );
