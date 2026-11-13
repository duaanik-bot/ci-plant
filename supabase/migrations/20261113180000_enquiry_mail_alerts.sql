-- The Enquiry desk's alert (owner, 13 Nov 2026: "… put them into the ERP system, and also give the notification").
--
-- Each mail filed on the desk — a new enquiry or a customer's counter-offer, from either mailbox, by the Mac robot or
-- the office AVS — is announced once to every login with Costing ticked: one bell row and one phone push per batch
-- (server/src/enquiry-intake.js notifyNewEnquiries). alerted_at is the claim: NULL = not announced yet.
--
-- The mails already on the desk are stamped when the column is first made, so nothing old is announced the day this
-- ships; a replay (init() runs this on every start) changes nothing.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = current_schema() AND table_name = 'enquiry_mails' AND column_name = 'alerted_at') THEN
    ALTER TABLE enquiry_mails ADD COLUMN alerted_at timestamptz;
    UPDATE enquiry_mails SET alerted_at = created_at;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS enquiry_mails_unalerted_idx ON enquiry_mails (id) WHERE alerted_at IS NULL;
