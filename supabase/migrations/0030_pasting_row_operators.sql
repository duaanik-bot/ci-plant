-- Per-stream pasting operators.
--
-- One job routinely has two people on it: a machine operator on staff and a
-- manual contractor working the other half of the same batch (Shankar on the
-- automatic lock-bottom, Jieut hand-pasting the rest of a one-lakh order). The
-- station carried a single operator for the whole stage, so only one of them was
-- ever recorded and the contractor's half was attributed to the machine man.
--
-- Nullable and unbacked: a stream with no pieces carries no name, and every
-- existing row keeps the stage-level operator it already had.
ALTER TABLE pasting_rows ADD COLUMN IF NOT EXISTS auto_operator TEXT;
ALTER TABLE pasting_rows ADD COLUMN IF NOT EXISTS manual_operator TEXT;
