-- Manual "Ready to Run". A supervisor can declare a job runnable when the
-- computed readiness light is still amber — the plant knows things the ERP
-- does not. It is a SIGNAL, never a gate: no readiness fact is rewritten, the
-- checklist keeps showing the truth underneath, and every flip is audited with
-- its reason. It lives on the job card because a card is what an operator
-- runs — for a gang that is the parent, and overriding the parent is exactly
-- the statement "this press run may start".
ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS ready_override INTEGER NOT NULL DEFAULT 0;
ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS ready_override_by TEXT;
ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS ready_override_at TIMESTAMPTZ;
ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS ready_override_reason TEXT;
