-- Size proposals and KLDs (owner, 12 Nov 2026). Idempotent: a replay changes nothing.
--
-- costing_sizes.kld   the KLD CI Plant drew for a Size Library entry (size + pasting + layout): construction,
--                     reading, the house rules it used, the layout, revision, who drew it, and every Drive copy.
-- materials.grain     which side of a board sheet the grain runs along ('long' | 'short'); NULL = not recorded.
-- die_register        the plant's 2024 die register (Drive sheet "DIE DATA"), loaded by scripts/load-die-register.mjs.
--                     A reference list only: it numbers dies differently from the Die Master (tools), so it is never
--                     merged into it until the two are reconciled.
ALTER TABLE costing_sizes ADD COLUMN IF NOT EXISTS kld jsonb;

ALTER TABLE materials ADD COLUMN IF NOT EXISTS grain text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'materials_grain_check') THEN
    ALTER TABLE materials ADD CONSTRAINT materials_grain_check CHECK (grain IS NULL OR grain IN ('long', 'short'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS die_register (
  die_no     text PRIMARY KEY,
  l_mm       numeric(10,2),
  w_mm       numeric(10,2),
  h_mm       numeric(10,2),
  style      text,
  ups        integer,
  size_text  text,
  source     text NOT NULL DEFAULT 'register',
  loaded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS die_register_dims ON die_register (l_mm, w_mm, h_mm);
