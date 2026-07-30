-- 0013 Shade Card simplification.
-- Safe to re-run: every statement is IF NOT EXISTS or idempotent by predicate.
-- Run `npm run db:backup` before applying this to production.
--
-- Collapses the module from twelve statuses + three dock zones to four
-- statuses (draft/sent/approved/rejected) + a repeating custody loop. Adds the
-- card's Sales Order link (order_line_id) and Output Code (output_no), the
-- shade_card_issues custody register, and the shade_card_legacy_numbers retire
-- zone for the free-text numbers that used to live on the product master.
--
-- No column or table is dropped. Thirteen columns (internal_qc_stamp,
-- internal_signatory, internal_approval_date, approval_requirement,
-- superseded_by, dock_zone, dock_since, issued_machine_id, issued_operator,
-- issued_job_card_id, issued_at, verified, verified_at), the
-- shade_card_revisions table, and customers/products.shade_approval_requirement
-- all stay in place, deprecated but intact — dropping on the live plant DB is
-- irreversible, and keeping them makes this whole change revertible in code
-- alone. See server/src/db.js for the matching fresh-database schema.
BEGIN;

-- The card's Sales Order link and Output Code. order_line_id (not order_id) is
-- the anchor because every field the form auto-populates — order quantity,
-- product, board, print specs, artwork code, output code — is line-level. The
-- order is reached by join, so navigation works in both directions.
-- Nullable: the 599 cards bulk-imported in July 2026 predate any SO link.
ALTER TABLE shade_cards ADD COLUMN IF NOT EXISTS order_line_id INTEGER REFERENCES order_lines(id);
ALTER TABLE shade_cards ADD COLUMN IF NOT EXISTS output_no TEXT;
CREATE INDEX IF NOT EXISTS idx_fk_shade_cards_order_line_id ON shade_cards (order_line_id);

-- The custody register: who physically holds the card, and every hand-off it
-- has ever been through. Deliberately NOT a column on shade_cards — a card is
-- issued and returned many times over its 365-day life while its approval
-- state never moves, so custody is a log, not a flag.
CREATE TABLE IF NOT EXISTS shade_card_issues (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shade_card_id INTEGER NOT NULL REFERENCES shade_cards(id) ON DELETE CASCADE,
  issued_to     TEXT NOT NULL,
  department    TEXT NOT NULL DEFAULT 'printing',
  issued_by     TEXT,
  issued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  job_card_id   INTEGER REFERENCES job_cards(id),
  machine_id    INTEGER REFERENCES machines(id),
  returned_by   TEXT,
  received_by   TEXT,
  returned_at   TIMESTAMPTZ,
  condition     TEXT CHECK (condition IN ('good','soiled','damaged','lost')),
  remarks       TEXT
);
-- One open issue per card, enforced by the database rather than by a code check
-- somebody can forget. This is what makes "where is this card?" a single row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sc_issues_open
  ON shade_card_issues (shade_card_id) WHERE returned_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sc_issues_card ON shade_card_issues (shade_card_id, id);
CREATE INDEX IF NOT EXISTS idx_fk_sc_issues_job_card_id ON shade_card_issues (job_card_id);
CREATE INDEX IF NOT EXISTS idx_fk_sc_issues_machine_id ON shade_card_issues (machine_id);

-- The retire zone for the free-text shade card numbers that used to be typed
-- onto the product master. Retiring moves the value here and clears the product
-- columns; restoring puts it back. Nothing is ever deleted, and an orphan
-- number can be promoted into a real card (promoted_to).
CREATE TABLE IF NOT EXISTS shade_card_legacy_numbers (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id  INTEGER NOT NULL REFERENCES products(id),
  sc_number   TEXT,
  sc_date     TEXT,
  promoted_to INTEGER REFERENCES shade_cards(id),
  retired_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_by  TEXT,
  restored_at TIMESTAMPTZ,
  restored_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_fk_sc_legacy_product_id ON shade_card_legacy_numbers (product_id);
CREATE INDEX IF NOT EXISTS idx_fk_sc_legacy_promoted_to ON shade_card_legacy_numbers (promoted_to);

-- Existing databases carry the twelve-value constraint. Remap the rows FROM THE
-- DATES ON THEM, then swap the constraint — in this statement order so the new
-- constraint never sees an old value.
--
-- The goal is to PRESERVE today's gate behaviour while never inventing an
-- approval that was never asserted. Those are two different requirements, and
-- an earlier draft of this migration satisfied the second while violating the
-- first, in a plant-stopping way.
--
-- Three old statuses ARE the plant's record of a customer verdict, so they
-- carry across directly. This is not "trusting a name": 'customer_approved'
-- means the customer approved, and such a card clears the printing gate TODAY.
-- Sending it anywhere else would change behaviour, not preserve it.
--   Every one of the 599 live cards on production is 'customer_approved' with
--   a NULL approval_received_date — the bulk import never populated the dates.
--   A purely date-derived remap therefore sent all 599 to 'draft', which under
--   the new one-rule gate hard-blocks printing on every shade-carded product
--   in the plant. Verified against prod, not assumed.
--
-- 'expired' is the mapping that genuinely needs care, because it asserts a
-- LAPSED approval rather than a live one. Carrying it to 'approved' is safe
-- only when creation_date exists, because isExpiredByAge() then blocks it
-- independently — the gate tests status AND age. With no date there is nothing
-- to expire against, so it would clear for ever; fall back to 'draft'.
--
-- internal_review, internal_approved and revised assert no customer approval
-- at all, so they get an explicit 'draft' arm rather than falling through to
-- the date checks below — a stray approval_received_date on one of these rows
-- must never promote it. internal_approved tightening is intended: internal
-- approval is being removed as a concept. draft and any other unrecognised
-- value still fall through to the date checks and default to 'draft'.
ALTER TABLE shade_cards DROP CONSTRAINT IF EXISTS shade_cards_status_check;
UPDATE shade_cards SET active = 0 WHERE status IN ('superseded','archived');
UPDATE shade_cards SET status = CASE
    WHEN status = 'customer_approved'                            THEN 'approved'
    WHEN status IN ('rejected','revision_requested')             THEN 'rejected'
    WHEN status IN ('sent_to_customer','customer_reviewing')     THEN 'sent'
    -- Explicit, not left to the date fallback: these three assert no customer
    -- verdict at all, so a stray approval_received_date must never promote them.
    WHEN status IN ('internal_review','internal_approved','revised') THEN 'draft'
    WHEN status = 'expired' AND COALESCE(creation_date,'') <> '' THEN 'approved'
    WHEN COALESCE(approval_received_date,'') <> ''               THEN 'approved'
    WHEN COALESCE(sent_to_customer_date,'')  <> ''               THEN 'sent'
    ELSE 'draft'
  END
  WHERE status NOT IN ('draft','sent','approved','rejected');
ALTER TABLE shade_cards ADD CONSTRAINT shade_cards_status_check
  CHECK (status IN ('draft','sent','approved','rejected'));

-- Any card physically out on press becomes an OPEN issue row so custody
-- survives the change. issued_operator is nullable and issued_to is NOT NULL,
-- so the COALESCE is load-bearing: a null would abort this statement.
INSERT INTO shade_card_issues (shade_card_id, issued_to, department, issued_by,
                               issued_at, job_card_id, machine_id)
SELECT sc.id, COALESCE(NULLIF(TRIM(sc.issued_operator), ''), 'unknown (migrated)'),
       'printing', 'migration', COALESCE(sc.issued_at, sc.dock_since, now()),
       sc.issued_job_card_id, sc.issued_machine_id
FROM shade_cards sc
WHERE sc.dock_zone = 'on_press'
  -- "never had ANY issue row", not "has no OPEN row". dock_zone is deprecated
  -- and never cleared, so it stays 'on_press' for ever; an open-row guard
  -- re-arms the moment the card is legitimately returned, and the next restart
  -- would insert a second open row claiming it is still out.
  AND NOT EXISTS (SELECT 1 FROM shade_card_issues i WHERE i.shade_card_id = sc.id);

-- products.shade_card_number/date become a DERIVED cache of the module, never a
-- source. Back-filling from the newest active card fixes the 12 products whose
-- hand-typed date disagreed with the card's.
UPDATE products p SET shade_card_number = s.sc_number,
                      shade_card_date   = COALESCE(s.creation_date, p.shade_card_date)
FROM (SELECT DISTINCT ON (product_id) product_id, sc_number, creation_date
      FROM shade_cards WHERE active = 1 ORDER BY product_id, id DESC) s
WHERE s.product_id = p.id
  -- A retired number must STAY retired. Without this, every server restart
  -- re-derives the product's mirrored columns from the still-active card and
  -- silently undoes the retire — no error, just quiet reversion on next boot.
  AND NOT EXISTS (SELECT 1 FROM shade_card_legacy_numbers l
                  WHERE l.product_id = p.id AND l.restored_at IS NULL)
  AND (COALESCE(p.shade_card_number,'') <> COALESCE(s.sc_number,'')
    OR COALESCE(p.shade_card_date,'')   <> COALESCE(s.creation_date, p.shade_card_date, ''));

-- Seed the card's own Output Code from the product master where it is blank.
UPDATE shade_cards sc SET output_no = p.output_number
FROM products p
WHERE p.id = sc.product_id
  AND COALESCE(sc.output_no,'') = '' AND COALESCE(p.output_number,'') <> '';

COMMIT;
