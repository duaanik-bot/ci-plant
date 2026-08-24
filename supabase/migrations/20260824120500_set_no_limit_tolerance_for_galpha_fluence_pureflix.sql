-- Anik, 2026-08-24: customer-wise dispatch tolerance.
--   Swiss Garnier group (SGLS id 5, Biotech id 4) — 10%   [already 10, untouched]
--   Galpha Laboratories Ltd (id 6)                 — no limit, both ways
--   Fluence Pharmaceuticals (id 43)                — no limit, both ways
--   Pureflix (id 2)                                — no limit, both ways
--
-- APPLIED TO PRODUCTION 2026-08-24 — do NOT re-run against a database that
-- already has it; re-running is harmless (the writes are idempotent) but the
-- audit rows would double.
--
-- BEFORE (to undo, restore these):
--   customers:  id 2 = 100, id 6 = 10, id 43 = 100
--   order_lines: every OPEN line of those three carried the same figure —
--                Pureflix 3 lines @100, Galpha 13 @10, Fluence 97 @100.
--   Galpha's 10 already-dispatched lines keep their 10% and are NOT touched:
--   a shipped line's tolerance is history, not policy.
--
-- 100 was never "no limit" — it caps at twice the order, and the plant hit it.

UPDATE customers SET tolerance_pct = -1 WHERE id IN (2, 6, 43);

-- The per-line snapshot exists so a later master edit cannot rewrite the
-- commercial terms of an order already accepted. Loosening a limit to NONE is
-- the case where that protection has nothing left to protect, and leaving 113
-- open lines on the old ceiling would mean the master said "no limit" while
-- Dispatch went on refusing. Open lines only.
UPDATE order_lines ol SET tolerance_pct = -1
FROM orders o
WHERE o.id = ol.order_id
  AND o.customer_id IN (2, 6, 43)
  AND ol.status NOT IN ('dispatched', 'cancelled')
  AND ol.tolerance_pct IS DISTINCT FROM -1;

INSERT INTO audit_log (entity, entity_id, action, detail, user_name)
SELECT 'customer', id, 'tolerance_changed',
       'dispatch tolerance set to No limit (-1) — customer accepts any quantity, over or short',
       'Anik'
FROM customers WHERE id IN (2, 6, 43);
