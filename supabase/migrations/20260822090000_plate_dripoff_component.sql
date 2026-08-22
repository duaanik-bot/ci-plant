-- The DRIP OFF plate.
--
-- A carton whose coating is Drip Off needs one plate that is not an ink: the
-- varnish mask the coating line prints the drip-off pattern with. It joins the
-- plate module as its own component type — 'dripoff', labelled DRIP OFF — so it
-- can never be mistaken for a Pantone, and it brings one new asset status:
-- 'issued_to_coating'. The mask is issued when COATING starts (never printing)
-- and is consumed at coating completion — single use, no return to the rack —
-- so no other status is needed for it.
--
-- Replay-safe on purpose: db.js init() replays this file on every boot of a
-- local/embedded database, so every change is DROP-then-ADD or guarded.

ALTER TABLE plate_assets DROP CONSTRAINT IF EXISTS plate_assets_component_type_check;
ALTER TABLE plate_assets ADD CONSTRAINT plate_assets_component_type_check
  CHECK (component_type IN ('cyan','magenta','yellow','black','pantone','dripoff'));

ALTER TABLE plate_request_components DROP CONSTRAINT IF EXISTS plate_request_components_component_type_check;
ALTER TABLE plate_request_components ADD CONSTRAINT plate_request_components_component_type_check
  CHECK (component_type IN ('cyan','magenta','yellow','black','pantone','dripoff'));

ALTER TABLE plate_assets DROP CONSTRAINT IF EXISTS plate_assets_status_check;
ALTER TABLE plate_assets ADD CONSTRAINT plate_assets_status_check CHECK (status IN (
  'available','awaiting_verification','reserved','issued_to_printing','issued_to_coating',
  'returned_pending_verification','damaged','scrapped','lost'
));

-- Both controlled sizes may cut a drip mask — its DEFAULT is 560 x 670, but a
-- job may size it 600 x 730, and the approve gate reads this array.
UPDATE plate_masters SET allowed_components = allowed_components || ARRAY['dripoff']::text[]
WHERE NOT ('dripoff' = ANY(allowed_components));

ALTER TABLE plate_masters ALTER COLUMN allowed_components
  SET DEFAULT ARRAY['cyan','magenta','yellow','black','pantone','dripoff']::text[];
