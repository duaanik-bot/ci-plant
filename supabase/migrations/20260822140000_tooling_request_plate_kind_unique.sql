-- One job card may now hold TWO plate requirements: the ink set and the
-- drip-off mask.
--
-- UNIQUE (job_card_id, product_id, family) physically forbade that — the second
-- INSERT died on tooling_requests_job_card_id_product_id_family_key. The rule it
-- encodes is still wanted ("do not raise the same tooling twice for the same job
-- and product"); it is only the definition of "the same" that has changed, so
-- the constraint is replaced by an expression index carrying the plate kind.
--
-- NOTHING IS LOOSENED FOR ANYONE ELSE. Every non-plate family stores no
-- plate_kind, so the COALESCE resolves to 'ink' for all of them and
-- (job, product, 'die') stays exactly as unique as it was. Plates gain exactly
-- one extra slot: one 'ink' PR and one 'dripoff' PR per job and product.
--
-- Replay-safe: the DROP is IF EXISTS and the CREATE is IF NOT EXISTS, so
-- init() may run this on every boot of a local database.

ALTER TABLE tooling_requests
  DROP CONSTRAINT IF EXISTS tooling_requests_job_card_id_product_id_family_key;

CREATE UNIQUE INDEX IF NOT EXISTS tooling_requests_job_product_family_kind_key
  ON tooling_requests (
    job_card_id, product_id, family,
    (COALESCE(specification->>'plate_kind', 'ink'))
  );
