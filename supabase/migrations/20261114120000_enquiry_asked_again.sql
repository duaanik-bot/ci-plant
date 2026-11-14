-- A customer asking again (owner, 14 Nov 2026: "If an inquiry has already been downloaded into the system, it should
-- not be coming up again … If work has already been done, then those inquiries should not be coming up again").
--
-- When a mail asks again for an item still open on the desk (the same customer and product, no new quantity), no new
-- row is made: the open row is marked instead — when, how many times, and the latest mail that asked
-- (server/src/routes/enquiries.js askedAgain). The desk shows "Asked again" and the alert says so. Replayed by init().
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS asked_again_at timestamptz;
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS asked_again_count integer NOT NULL DEFAULT 0;
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS asked_again_mail_id integer;
CREATE INDEX IF NOT EXISTS enquiries_asked_again_mail_idx ON enquiries (asked_again_mail_id) WHERE asked_again_mail_id IS NOT NULL;
