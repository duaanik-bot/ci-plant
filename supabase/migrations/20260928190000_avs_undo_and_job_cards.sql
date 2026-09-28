-- AVS: undo a QA decision, and one photo set for several job cards.
--
-- PRODUCTION ONLY, like 20260926140100_avs_photo_sets.sql: init() never builds
-- the schema `avs`. This file is the record of what was applied. APPLIED
-- 2026-09-28 as the named migration `avs_undo_and_job_cards`.
--
-- Undo (owner's request, 28 Sep 2026). A decision is never edited or deleted:
-- undoing one adds a row with decision 'UNDO' that names the decision it undoes
-- (undoes_id), who undid it, when and why (remark). The decision in force is
-- the newest one that is not an artwork-alert sign-off, not an UNDO row, and not
-- undone — so an undo brings back the decision before it, if any. One undo per
-- decision.
--
-- Several job cards (owner's request, 28 Sep 2026). The same product often runs
-- as several orders or batches, or in a gang: one photo set may name several job
-- cards. avs.check_requests.job_cards holds all of them, in the order chosen,
-- as [{ "id": 446, "jc_number": "CI-JC-0446", "product_name": "..." }, ...];
-- job_card_id / jc_number stay the first one, as before. The report's job_card
-- then lists every number, comma-separated, and CI Plant's printing lock and
-- QA stamp read each number in it.
ALTER TABLE avs.decisions DROP CONSTRAINT IF EXISTS decisions_decision_check;
ALTER TABLE avs.decisions ADD CONSTRAINT decisions_decision_check
  CHECK (decision = ANY (ARRAY['RELEASE', 'KEEP ON HOLD', 'REJECT', 'ARTWORK ALERT OK', 'UNDO']));
ALTER TABLE avs.decisions ADD COLUMN IF NOT EXISTS undoes_id bigint REFERENCES avs.decisions(id);
DO $$ BEGIN
  ALTER TABLE avs.decisions ADD CONSTRAINT decisions_undo_check
    CHECK ((decision = 'UNDO') = (undoes_id IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS decisions_one_undo ON avs.decisions (undoes_id) WHERE undoes_id IS NOT NULL;

ALTER TABLE avs.check_requests ADD COLUMN IF NOT EXISTS job_cards jsonb;
