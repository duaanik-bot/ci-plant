-- Reverse approver ----------------------------------------------------------
-- The stage send-back lets a station hand work back to the station before it.
-- That is ordinary floor traffic and is NOT gated. Two cases are not ordinary,
-- and both need the plant head: a reverse that RETURNS STOCK to the warehouse
-- (board, banked offcuts, issued extra sheets), and one that takes a job off
-- the floor entirely, back to Print Planning. Both change what the rest of the
-- plant is planning against.
--
-- A per-user flag, deliberately NOT a role — the same reasoning as xs_approver:
-- several plant logins carry role=admin, and a role check would hand this
-- decision to all of them. Edited in Masters -> Users.
--
-- The API function only calls connect(), never init(), so nothing in db.js
-- reaches production on its own. This file is how the column gets there.
ALTER TABLE users ADD COLUMN IF NOT EXISTS reverse_approver INTEGER NOT NULL DEFAULT 0;

-- Nobody holds the grant until it is given deliberately in Masters -> Users.
-- Seeding it onto existing admins would silently hand stock-moving reversals
-- to every admin login, which is exactly what the flag exists to prevent.
