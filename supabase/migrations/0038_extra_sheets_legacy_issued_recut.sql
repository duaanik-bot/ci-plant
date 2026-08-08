-- Legacy repair for requests completed by the old approval-only flow.
-- These rows were marked issued before the Cutting execution loop existed, so
-- they must be landed in the Extra Sheets Cutting queue instead of remaining
-- falsely closed.

WITH legacy AS (
  UPDATE extra_sheet_requests x
  SET status = 'sent_to_cutting',
      sent_to_cutting_at = COALESCE(x.sent_to_cutting_at, x.approved_at, x.issued_at, now()),
      board_material_id = COALESCE(
        x.board_material_id,
        (COALESCE(ol.spec_override, gol.spec_override)->>'board_material_id')::int,
        p.board_material_id
      ),
      cuts_per_parent = COALESCE(x.cuts_per_parent, jc.children_per_parent, 1),
      issued_by = NULL,
      issued_at = NULL
  FROM job_cards jc
  JOIN products p ON p.id = jc.product_id
  LEFT JOIN order_lines ol ON ol.id = jc.order_line_id
  LEFT JOIN LATERAL (
    SELECT ol2.* FROM order_lines ol2
    WHERE ol2.gang_run_id = jc.gang_run_id
    ORDER BY ol2.id LIMIT 1
  ) gol ON jc.order_line_id IS NULL
  WHERE x.job_card_id = jc.id
    AND x.status = 'issued'
    AND x.sent_to_cutting_at IS NULL
    AND x.cutting_started_at IS NULL
    AND x.cutting_completed_at IS NULL
    AND x.cutting_actual_qty IS NULL
    AND x.issued_stage_qty IS NULL
  RETURNING x.id, x.xs_number, x.job_card_id, x.qty
)
INSERT INTO audit_log (entity, entity_id, action, detail, user_name)
SELECT 'extra_sheet', id, 'legacy_issued_landed_to_cutting',
       xs_number || ' - legacy issued request reopened in Cutting queue for ' || qty || ' parent sheets',
       'system migration'
FROM legacy;
