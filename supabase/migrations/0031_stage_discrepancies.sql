-- Soft quantity discrepancies at Sort & Paste.
--
-- The plant rule here is deliberately NOT a gate: when the bench counts more
-- than the paperwork predicted (die cutting yields 14,200 where the sheet maths
-- said 13,900), or the hand step reports more than the machine step did (2,200
-- locked against 2,000 side-pasted, so the machine count was the miscount), the
-- station records the truth and carries on. Blocking would only teach the floor
-- to type the expected figure, which destroys the very signal this table exists
-- to collect.
--
-- The register is what makes the softness affordable: every absorbed difference
-- is kept with its percentage so the discrepancies can be totalled per product,
-- per operator and per machine later, and a systematic miscount found.
--
-- Sibling of cutting_discrepancies, which does the same job for the cutting
-- variance gate. Kept separate because that one is reason-coded and trues up
-- board stock; this one is observational.
CREATE TABLE IF NOT EXISTS stage_discrepancies (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_card_id INTEGER NOT NULL REFERENCES job_cards(id),
  job_stage_id INTEGER NOT NULL REFERENCES job_stages(id),
  stage TEXT NOT NULL,
  -- over_receipt   : the station handled more than the pool it was given
  -- step_correction: a sequential row's machine count raised to its hand count
  kind TEXT NOT NULL CHECK (kind IN ('over_receipt','step_correction')),
  expected_qty INTEGER NOT NULL,
  actual_qty INTEGER NOT NULL,
  delta_qty INTEGER NOT NULL,
  -- Stored rather than derived so a report never has to guard against a zero
  -- expected figure, and so the number in the register is the number the
  -- operator was shown on screen.
  delta_pct DOUBLE PRECISION,
  operator TEXT,
  machine_id INTEGER REFERENCES machines(id),
  note TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stage_discrepancies_stage ON stage_discrepancies(job_stage_id);
CREATE INDEX IF NOT EXISTS idx_fk_stage_discrepancies_job_card_id ON stage_discrepancies(job_card_id);
CREATE INDEX IF NOT EXISTS idx_fk_stage_discrepancies_machine_id ON stage_discrepancies(machine_id);
