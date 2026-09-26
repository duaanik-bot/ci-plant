-- AVS before printing can be completed — Planning's per-job switch.
--
-- Off by default. When Planning switches it on for a job, the PRINTING stage of
-- that job's card cannot be completed until QA has released the job in
-- Artwork Verification: every AVS report carrying the card's number released
-- (server/src/avs-gate.js, checked by POST /job-stages/:id/complete).
--
--   order_lines.avs_mandatory  a single job's switch.
--   gang_runs.avs_mandatory    a gang's or combined run's switch; the run's value
--                              is also stamped onto every member line, and the
--                              run card needs AVS when the run or any member has it.
--
-- Additive only: two INTEGER columns with a constant default (no table rewrite).
-- Mirrored in server/src/db.js init() next to stock_booking, and so in the
-- baseline. APPLIED to colour-impressions-prod 2026-09-26 as the named
-- migration `avs_mandatory`.
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS avs_mandatory INTEGER NOT NULL DEFAULT 0;
ALTER TABLE gang_runs ADD COLUMN IF NOT EXISTS avs_mandatory INTEGER NOT NULL DEFAULT 0;
