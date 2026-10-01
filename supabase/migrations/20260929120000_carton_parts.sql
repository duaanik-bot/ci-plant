-- A carton MADE IN PARTS: one saleable outer carton printed as separate pieces,
-- each on its own sheet and board, die-cut apart and pasted together into one
-- carton at Sort & Paste (VOGEAB GM1/GM2 outers, SW-712/715/716). The PO names
-- only the outer; its parts are ordinary Product Master rows listed here.
--
-- Mirrored locally by server/src/db.js init(), which replays this file — so it
-- must stay idempotent.
--
-- LOCKS: ADD COLUMN with a constant default is catalogue-only (no rewrite), but
-- it holds ACCESS EXCLUSIVE on order_lines and job_cards until commit, and the
-- new foreign keys take SHARE ROW EXCLUSIVE on products (blocks Product Master
-- saves, not order-line FK checks). The unique index build scans order_lines
-- (~1,100 rows: milliseconds). While this waits for job_cards it already holds
-- order_lines, freezing that table's readers — so the timeout is short, and a
-- timeout just rolls the whole file back to be re-run off-shift.
set local lock_timeout = '1s';

CREATE TABLE IF NOT EXISTS product_parts (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  outer_product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  part_product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  -- What the floor calls it: 'Part 1', 'Part 2', 'Top', 'Base'.
  label TEXT NOT NULL,
  -- Pieces of this part in one finished carton (almost always 1).
  per_carton INTEGER NOT NULL DEFAULT 1 CHECK (per_carton >= 1),
  seq INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT product_parts_not_itself CHECK (outer_product_id <> part_product_id),
  CONSTRAINT product_parts_once UNIQUE (outer_product_id, part_product_id)
);
CREATE INDEX IF NOT EXISTS product_parts_outer_idx ON product_parts (outer_product_id, seq);
CREATE INDEX IF NOT EXISTS product_parts_part_idx ON product_parts (part_product_id);

-- A PART LINE: the hidden order line one part of a carton is planned, covered,
-- printed and die-cut on. Points at the carton's own line on the same order.
-- No ON DELETE action, on purpose: a part line leaves only through rollbackLine,
-- called by its carton, so its board holds, PR and job card are undone exactly
-- as any line's are. A path that forgets fails loudly instead of dropping rows.
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS part_of_line_id INTEGER
  REFERENCES order_lines(id);
-- One line per part per carton. Its leading column also serves every
-- `part_of_line_id = $1` lookup and the foreign-key check on a carton delete.
CREATE UNIQUE INDEX IF NOT EXISTS order_lines_one_line_per_part
  ON order_lines (part_of_line_id, product_id) WHERE part_of_line_id IS NOT NULL;
-- What a part line IS, remembered on the line itself: its floor label and its
-- pieces per carton, copied from the master when the line is made. Once its
-- carton's parts are under way the master may change; the order's own lines
-- keep deciding the pasting card (carton-parts.js contract C9).
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS part_label TEXT;
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS part_per_carton INTEGER;

-- The PASTING CARD of a carton made in parts: sorting + pasting only, fed by
-- the part cards' die-cut pieces, never by board.
ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS is_assembly BOOLEAN NOT NULL DEFAULT false;

-- Realtime: same guarded block as 20260918120000_fluence_realtime_ping.sql.
do $$
begin
  if pg_catalog.to_regprocedure('public.ci_erp_realtime_ping()') is null then
    return;
  end if;
  execute 'create or replace trigger ci_erp_realtime_ping after insert or update or delete on public.product_parts for each row execute function public.ci_erp_realtime_ping()';
  execute 'create or replace trigger ci_erp_realtime_ping_truncate after truncate on public.product_parts for each statement execute function public.ci_erp_realtime_ping()';
end
$$;
