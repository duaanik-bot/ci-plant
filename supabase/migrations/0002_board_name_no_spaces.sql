-- Board sizes written closed up: 'Duplex GB · 296 GSM · 20x38', not '… 20 x 38'.
--
-- The size is one spoken token on the plant floor, and the name composer
-- (server/src/board-code.js boardName) now emits it that way. This brings the
-- stored master into line so the composer and the data cannot disagree.
--
-- Delta counterpart of the same two statements in server/src/db.js init().
-- Data-only: no schema change, so db:check still reports matching schemas.
--
-- ── Why both columns move together ──────────────────────────────────────────
-- products.board_name is a denormalised copy of materials.name, and gang
-- compatibility buckets jobs by that string (server/src/routes/gangs.js,
-- uniq(m => m.board_name)). Migrating one column and not the other would split a
-- single board into two gangs. Applying the SAME expression to both is what
-- guarantees safety: any product↔board pair that resolved before still resolves
-- after, and any pair that did not, still does not.
--
-- ── Why an alternation and not '[xX×]' ─────────────────────────────────────
-- Load bearing. '×' (U+00D7) is two bytes in UTF-8. Under a SQL_ASCII database a
-- bracket expression is a set of single BYTES, so '[xX×]' matches only half of
-- '×' and the surrounding pattern never completes — the statement silently
-- no-ops. An alternation branch matches the whole byte sequence literally and so
-- behaves identically under SQL_ASCII (local) and UTF8 (Supabase).
-- products.board_name stores '20 × 38' almost exclusively, so this is the
-- difference between migrating every row and migrating none.
--
-- ── Why global and not end-anchored ────────────────────────────────────────
-- A leftover offcut's name embeds its parent's
-- ('Leftover — Duplex GB · 296 GSM · 20 x 38 · 12×20"'), so an end-anchored
-- rewrite would leave the embedded copy spaced and drifting from the parent.
-- Scoped to boards, where a digit-separator-digit pair is always a sheet size.
--
-- Idempotent: re-running rewrites an already-closed name to itself, and the WHERE
-- means a second run updates no rows at all.

BEGIN;

UPDATE materials
   SET name = regexp_replace(name, '([0-9.]+)[[:space:]]*(?:x|X|×|\*)[[:space:]]*([0-9.]+)', '\1x\2', 'g')
 WHERE category = 'board'
   AND name IS NOT NULL
   AND name <> regexp_replace(name, '([0-9.]+)[[:space:]]*(?:x|X|×|\*)[[:space:]]*([0-9.]+)', '\1x\2', 'g');

UPDATE products
   SET board_name = regexp_replace(board_name, '([0-9.]+)[[:space:]]*(?:x|X|×|\*)[[:space:]]*([0-9.]+)', '\1x\2', 'g')
 WHERE board_name IS NOT NULL
   AND board_name <> regexp_replace(board_name, '([0-9.]+)[[:space:]]*(?:x|X|×|\*)[[:space:]]*([0-9.]+)', '\1x\2', 'g');

COMMIT;
