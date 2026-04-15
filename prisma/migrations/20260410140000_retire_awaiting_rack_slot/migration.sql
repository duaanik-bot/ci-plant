-- Legacy: stock_available + awaiting_rack_slot was a hub "pending reservation" lane.
-- Move those requirements to custody floor so they remain visible after UI removal.
UPDATE "plate_requirements"
SET
  "status" = 'READY_ON_FLOOR',
  "reserved_rack_slot" = NULL,
  "last_status_updated_at" = CURRENT_TIMESTAMP
WHERE "triage_channel" = 'stock_available'
  AND "status" = 'awaiting_rack_slot';
