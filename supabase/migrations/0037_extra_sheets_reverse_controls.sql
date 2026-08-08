-- Extra Sheets reversal controls:
--   * Cutting can reverse its own start/counter entry before Printing receipt.
--   * Plant head can reverse an accidental approval across the flow.
--   * Older approved requests are landed into the new Cutting queue.

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
    'cancelled',
    'reversed'
  ));

ALTER TABLE extra_sheet_requests ADD COLUMN IF NOT EXISTS reversed_by TEXT;
ALTER TABLE extra_sheet_requests ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;
ALTER TABLE extra_sheet_requests ADD COLUMN IF NOT EXISTS reverse_reason TEXT;

WITH landed AS (
  UPDATE extra_sheet_requests x
  SET status = 'sent_to_cutting',
      sent_to_cutting_at = COALESCE(x.sent_to_cutting_at, x.approved_at, now()),
      board_material_id = COALESCE(
        x.board_material_id,
        (COALESCE(ol.spec_override, gol.spec_override)->>'board_material_id')::int,
        p.board_material_id
      ),
      cuts_per_parent = COALESCE(x.cuts_per_parent, jc.children_per_parent, 1)
  FROM job_cards jc
  JOIN products p ON p.id = jc.product_id
  LEFT JOIN order_lines ol ON ol.id = jc.order_line_id
  LEFT JOIN LATERAL (
    SELECT ol2.* FROM order_lines ol2
    WHERE ol2.gang_run_id = jc.gang_run_id
    ORDER BY ol2.id LIMIT 1
  ) gol ON jc.order_line_id IS NULL
  WHERE x.job_card_id = jc.id
    AND x.status = 'approved'
  RETURNING x.id, x.xs_number, x.job_card_id, x.qty
)
INSERT INTO audit_log (entity, entity_id, action, detail, user_name)
SELECT 'extra_sheet', id, 'approval_landed_to_cutting',
       xs_number || ' — existing approval landed in Cutting queue for ' || qty || ' parent sheets',
       'system migration'
FROM landed;
