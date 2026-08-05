-- 0025: the plan learns WHOSE stock it runs on — book the shelf, or buy fresh.
--
-- Until now a plan always BOOKED the warehouse: free stock counted toward the
-- job and a PR was raised only for the balance. The planner had no way to say
-- "leave those sheets for another product — buy this job's board in full."
-- stock_booking is that choice, taken in the Planning Engine per plan:
--   'book'     — today's behaviour and the default: free shelf stock counts
--                toward this plan; a PR covers only the balance.
--   'fresh_pr' — the plan IGNORES the shelf: a PR is raised for the FULL
--                requirement, and this line's claim on the shelf is fenced to
--                its own incoming PR (claim = need − own undelivered PR qty),
--                so the shelf's free figure stays free for other jobs. When
--                the PR lands, the mirror allocation is consumed at the same
--                moment the board enters available — the claim returns and
--                covers the landed board. available − committed = free holds
--                at every instant.
-- A run (gang or CI-MRG- merge) draws from ONE pile, so the choice lives on
-- the run and is stamped onto every member line — the demand engine only ever
-- reads order_lines.
--
-- Purely additive (TEXT NOT NULL DEFAULT 'book' + recreated CHECKs); every
-- existing row keeps today's book-the-shelf behaviour. 0017-0019 stay
-- reserved (0017 taken on the grn-multi-line branch) and 0024 went to the
-- cutting write-on register in the same release window — this is 0025.
--
-- Apply through the Supabase SQL editor. Take a backup first (npm run db:backup).
BEGIN;

ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS stock_booking TEXT NOT NULL DEFAULT 'book';
ALTER TABLE order_lines DROP CONSTRAINT IF EXISTS order_lines_stock_booking_check;
ALTER TABLE order_lines ADD CONSTRAINT order_lines_stock_booking_check CHECK (stock_booking IN ('book','fresh_pr'));

ALTER TABLE gang_runs ADD COLUMN IF NOT EXISTS stock_booking TEXT NOT NULL DEFAULT 'book';
ALTER TABLE gang_runs DROP CONSTRAINT IF EXISTS gang_runs_stock_booking_check;
ALTER TABLE gang_runs ADD CONSTRAINT gang_runs_stock_booking_check CHECK (stock_booking IN ('book','fresh_pr'));

COMMIT;
