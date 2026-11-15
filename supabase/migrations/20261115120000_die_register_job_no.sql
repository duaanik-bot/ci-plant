-- The die list's job numbers (owner, 15 Nov 2026). The 2024 register's die numbers (1-2122) are not written on the
-- dies; the studio knows a die by the job it was first made for. job_no is that job:
-- for the 2024 register's dies, the job the studio's 2021 die sheet gives the same row; for dies found in the studio's
-- Drive drawings (die_no J<job>[/n]), their own job. The numbers are the plant's own data and are filled on production
-- by a one-off script kept outside this repo; this migration only adds the column. Idempotent.
ALTER TABLE die_register ADD COLUMN IF NOT EXISTS job_no text;
