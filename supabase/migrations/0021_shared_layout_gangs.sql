-- 0021: Shared-layout gangs + fixed gang templates.
--
-- gang_runs.layout_mode:
--   'separate' — today's model, the default: each member has its own child
--                sheets; the run's total is the SUM of member sheets.
--   'shared'   — a CO-PRINTED layout: every member nests on ONE child sheet,
--                the run's sheets are the MAX any member needs, and each
--                member's stored figures are its proportional share of that
--                one count. Until the final child size is entered the gang is
--                LAYOUT PENDING (derived, never stored).
--
-- gang_templates / gang_template_slots: the plant's permanent co-printed
-- layouts ("Niko Standard": 19x20 sheet, Niko 1 = 8 ups, Niko 2 = 4 ups).
-- A template is its OWN master — stamped onto a new run's spec_override at
-- creation; it never writes the Product Master, and editing it never reaches
-- back into runs already created from it.
--
-- Purely additive; DEFAULT 'separate' leaves every existing gang untouched.
-- Safe to apply out of order relative to 0017-0020.
--
-- Apply through the Supabase SQL editor. Take a backup first (npm run db:backup).
BEGIN;

ALTER TABLE gang_runs ADD COLUMN IF NOT EXISTS layout_mode TEXT NOT NULL DEFAULT 'separate';
ALTER TABLE gang_runs DROP CONSTRAINT IF EXISTS gang_runs_layout_mode_check;
ALTER TABLE gang_runs ADD CONSTRAINT gang_runs_layout_mode_check CHECK (layout_mode IN ('separate','shared'));

CREATE TABLE IF NOT EXISTS gang_templates (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  child_l DOUBLE PRECISION NOT NULL,
  child_w DOUBLE PRECISION NOT NULL,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS gang_template_slots (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  template_id INTEGER NOT NULL REFERENCES gang_templates(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  ups INTEGER NOT NULL CHECK (ups > 0)
);
CREATE INDEX IF NOT EXISTS idx_gang_template_slots_template ON gang_template_slots(template_id);
CREATE INDEX IF NOT EXISTS idx_fk_gang_template_slots_product ON gang_template_slots(product_id);

-- Recognition + learning: a template is found by its product-set fingerprint
-- when a gang is created, and written back when a layout is locked at plan.
ALTER TABLE gang_templates ADD COLUMN IF NOT EXISTS fingerprint TEXT;
ALTER TABLE gang_templates ADD COLUMN IF NOT EXISTS last_gang_number TEXT;
ALTER TABLE gang_templates ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS idx_gang_templates_fingerprint ON gang_templates(fingerprint) WHERE fingerprint IS NOT NULL AND active = 1;

COMMIT;
