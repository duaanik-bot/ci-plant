-- Customer dispatch tolerance gains a "no limit" spelling.
--
-- Galpha, Fluence and Pureflix accept whatever comes off the press, over or
-- short. Until now the only way to say that was a big percentage — both Fluence
-- and Pureflix sat at 100%, which is NOT the same thing: it caps at twice the
-- order and the plant hits that cap. -1 means there is no ceiling at all.
--
-- The sentinel lives in the existing column on purpose: every query resolves
-- the effective tolerance with COALESCE(ol.tolerance_pct, c.tolerance_pct, 0),
-- and a parallel boolean would have to be threaded through every one of those
-- sites — the one that got missed would be a gate that silently still blocks.
-- See server/src/tolerance.js.
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_tolerance_pct_check;
ALTER TABLE customers ADD CONSTRAINT customers_tolerance_pct_check
  CHECK (tolerance_pct >= 0 OR tolerance_pct = -1);

ALTER TABLE order_lines DROP CONSTRAINT IF EXISTS order_lines_tolerance_pct_check;
ALTER TABLE order_lines ADD CONSTRAINT order_lines_tolerance_pct_check
  CHECK (tolerance_pct IS NULL OR tolerance_pct >= 0 OR tolerance_pct = -1);
