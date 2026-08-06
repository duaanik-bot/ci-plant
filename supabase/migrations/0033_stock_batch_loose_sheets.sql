-- Loose board stock, counted rather than inferred.
--
-- Board is bought, stored and handed over in PACKETS, but the ledger holds a
-- sheet count only. The packet suggestion panel therefore DERIVES loose stock:
-- loose = qty mod P, per batch, then summed.
--
-- That derivation is the smallest possible answer, not the true one. Loose
-- sheets are the ones NOT in a sealed packet, so qty - loose = intact * P and
-- therefore
--
--     loose = qty (mod P)
--
-- is definitional. The derivation returns the k = 0 root; the truth is
-- (qty mod P) + k*P. Every under-cut return credits loose without a break and
-- pushes k up — 13 of the 108 available board batches on this database have
-- already absorbed more than one such addition. This column stores k's effect
-- directly: the counted loose figure for that pile.
--
-- NULLABLE, and that is the whole point. NOT NULL DEFAULT 0 would have every
-- batch read ZERO loose from the moment this ran — worse than the derivation,
-- which finds 1,119 sheets across 23 batches, and it would read as counted.
-- NULL means "never counted": packetPlan keeps deriving for that pile and the
-- panel keeps saying so. Piles become counted when board is next issued off
-- them or when the warehouse recounts.
--
-- Deliberately NOT backfilled with the derived remainder. That would launder a
-- guess into a count, which is the thing this work exists to stop.
ALTER TABLE stock_batches ADD COLUMN IF NOT EXISTS loose_sheets DOUBLE PRECISION;

-- Deliberately NOT `loose_sheets <= qty`. A two-column CHECK looks tighter but
-- is a trap: consumeFifo issues a bare `UPDATE stock_batches SET qty=...`, so a
-- stale loose figure would abort that transaction and HARD-BLOCK A MACHINE
-- START over a bookkeeping number. That inverts the house rule — physics hard,
-- paperwork soft. The ceiling is clamped in code, where it can flag instead of
-- refuse.
ALTER TABLE stock_batches DROP CONSTRAINT IF EXISTS stock_batches_loose_sheets_check;
ALTER TABLE stock_batches ADD CONSTRAINT stock_batches_loose_sheets_check
  CHECK (loose_sheets IS NULL OR loose_sheets >= 0);
