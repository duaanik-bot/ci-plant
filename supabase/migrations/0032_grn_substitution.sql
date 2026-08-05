-- Receiving the board that actually arrived.
--
-- A paper mill delivers 290 GSM against a purchase order for 300 GSM: same
-- grade, same 23x36 sheet, one step down the ladder. Until now the storekeeper
-- had two bad options — book 100 packets of a board that is not in the building,
-- or take it as a direct receipt and leave the 300 GSM order open forever with
-- the job it was bought for still reading short.
--
-- The receipt now carries BOTH facts. `material_id` is what physically landed
-- and owns the stock batch, the ledger row and every Available column.
-- `substituted_for_material_id` is what the purchase order asked for, so the GRN
-- register reads truthfully from either side and the substitution is auditable
-- long after the fact.
--
-- NULL on every ordinary receipt, and deliberately no DEFAULT: a defaulted
-- ADD COLUMN rewrites every existing row, and there is nothing to say about the
-- receipts already on file.
ALTER TABLE grns ADD COLUMN IF NOT EXISTS
  substituted_for_material_id INTEGER REFERENCES materials(id);

CREATE INDEX IF NOT EXISTS idx_fk_grns_substituted_for_material_id
  ON grns (substituted_for_material_id);
