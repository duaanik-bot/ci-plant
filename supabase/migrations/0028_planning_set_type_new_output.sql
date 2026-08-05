-- Planning set-type gains a fourth zone: New Output — the job needs a fresh
-- plate set made before it can be scheduled at all, as opposed to a repeat
-- that runs on an output number the plant already holds. It sits beside
-- Single (a solo job) rather than inside it, because the two piles are worked
-- by different people: plate-making has to finish before the job is even
-- schedulable.
--
-- Widening a CHECK only: every existing row stays valid, so this is additive
-- exactly as 0027 was.

ALTER TABLE order_lines DROP CONSTRAINT IF EXISTS order_lines_set_type_check;
ALTER TABLE order_lines ADD CONSTRAINT order_lines_set_type_check
  CHECK (set_type IN ('single','gang','new_output','hold'));
