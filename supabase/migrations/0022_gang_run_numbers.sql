-- 0022: a gang run gets its OWN output number and die number.
--
-- A gang of mixed products is a new layout every time it is planned: the
-- plate set and the die are made for THAT run and exist for no other job, so
-- neither number can come from any product master. The planner types them in
-- the Planning engine (or Artwork, or the job card), and from then on they
-- travel with the gang number and the product names to every station the run
-- passes through — press, die cutting, the traveler, the floor.
--
-- Gangs only. A COMBINED RUN (kind='merge') is ONE product printed from its
-- own master plate and die; it keeps reading the master and these columns stay
-- NULL for it. That rule lives in the route, not in a CHECK, so a gang that is
-- later converted to a merge keeps its history instead of failing to update.
--
-- Purely additive (two nullable TEXT columns), so applying this out of order
-- relative to 0017-0021 is harmless and no existing row changes meaning.
--
-- Apply through the Supabase SQL editor. Take a backup first (npm run db:backup).
BEGIN;

ALTER TABLE gang_runs ADD COLUMN IF NOT EXISTS output_number TEXT;
ALTER TABLE gang_runs ADD COLUMN IF NOT EXISTS die_number TEXT;

COMMIT;
