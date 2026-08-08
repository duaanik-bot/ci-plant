-- Cover the foreign keys added by the Extra Sheets cutting loop. These are
-- used by floor queue joins and must remain cheap as movement history grows.

CREATE INDEX IF NOT EXISTS idx_extra_sheet_requests_board_material
  ON extra_sheet_requests (board_material_id);

CREATE INDEX IF NOT EXISTS idx_extra_sheet_requests_cutting_machine
  ON extra_sheet_requests (cutting_machine_id);
