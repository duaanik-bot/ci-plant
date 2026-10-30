-- COSTING APPROVAL — a costing is Draft until a login with the Management right approves it; the
-- quotation of a Draft costing is stamped DRAFT. Changing an approved costing's figures (a new
-- revision) sends it back to Draft; the revision it was approved at keeps the stamp, so the history
-- shows which figures were approved, by whom and when. Written 2026-10-30.
--
-- APPLIED to colour-impressions-prod 2026-10-30 as the named migration `costing_approval` (owner's
-- go-ahead: "Yes, ship it" — commit, push and deploy the upgrade, and add the approval columns).
--
-- Old cost-sheet rows (source 'sheet') stay Draft: approval is for costings made here.
set local lock_timeout = '1s';

ALTER TABLE costings ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'draft';
ALTER TABLE costings ADD COLUMN IF NOT EXISTS approved_by integer;
ALTER TABLE costings ADD COLUMN IF NOT EXISTS approved_by_name text;
ALTER TABLE costings ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE costings ADD COLUMN IF NOT EXISTS approved_version integer;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'costings_status_check') THEN
    ALTER TABLE costings ADD CONSTRAINT costings_status_check CHECK (status IN ('draft', 'approved'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS costings_status ON costings (status) WHERE source = 'erp';

ALTER TABLE costing_versions ADD COLUMN IF NOT EXISTS approved_by_name text;
ALTER TABLE costing_versions ADD COLUMN IF NOT EXISTS approved_at timestamptz;
