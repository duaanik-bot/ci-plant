-- AVS redo: verify a product again with new photos, as the next check of the
-- same report number.
--
-- PRODUCTION ONLY, like 20260926140100_avs_photo_sets.sql: init() never builds
-- the schema `avs`. This file is the record of what was applied. APPLIED
-- 2026-09-28 as the named migration `avs_redo_verification`.
--
-- A report that is ready can be verified again from CI Plant (Artwork
-- Verification > Redo verification). The redo is a new photo set whose check
-- is issued as the next check of the SAME report number (Check 2, Check 3 ...,
-- runbook rule 21): the register and the report show the latest check, and
-- every earlier check, its photos, its PDF and QA's decisions on it stay on
-- record.
--
--   redo_report_no   the report this set checks again
--   redo_of_set_id   the photo set of the check being redone (none when the
--                    earlier check came from photos in the AVS folder)
--   redo_reason      why, in the words of the person who asked (required)
--
-- One redo of a report at a time: a second one is refused while the first is
-- still taking photos, waiting or being checked.
ALTER TABLE avs.check_requests
  ADD COLUMN IF NOT EXISTS redo_report_no text,
  ADD COLUMN IF NOT EXISTS redo_of_set_id bigint REFERENCES avs.check_requests(id),
  ADD COLUMN IF NOT EXISTS redo_reason text;
DO $$ BEGIN
  ALTER TABLE avs.check_requests ADD CONSTRAINT check_requests_redo_reason_check
    CHECK (redo_report_no IS NULL OR length(btrim(coalesce(redo_reason, ''))) > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS check_requests_report_idx ON avs.check_requests (report_no);
CREATE INDEX IF NOT EXISTS check_requests_redo_idx ON avs.check_requests (redo_report_no) WHERE redo_report_no IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS check_requests_one_open_redo ON avs.check_requests (redo_report_no)
  WHERE redo_report_no IS NOT NULL AND status IN ('uploading', 'queued', 'checking');
