-- ENQUIRY DESK: CI PLANT SAVES THE GMAIL DRAFT ITSELF (owner, 11 Nov 2026: "I want things to happen in the backend …
-- all the controls, everything should be at the backend").
--
--   gmail_links  one row per enquiry-desk mailbox (trial / business) whose Gmail an admin has connected: Google's
--                refresh token, ENCRYPTED with GMAIL_TOKEN_KEY (kept in Vercel, never in the database), the address
--                Google confirmed, the permission granted, and the last error. Disconnect deletes the row.
-- With a link, Send quotation saves the reply draft in the customer's thread at once (server/src/gmail.js); without
-- one, the robot job as before. Permission asked: gmail.compose (drafts) + gmail.metadata (headers, to thread the
-- reply and notice a sent draft) — never a send from CI Plant, never a mail body read.
-- No foreign key (as the rest of the enquiry desk). Replayed by db.js init(): idempotent.
set local lock_timeout = '1s';

CREATE TABLE IF NOT EXISTS gmail_links (
  mailbox           text PRIMARY KEY CHECK (mailbox IN ('trial', 'business')),
  email             text NOT NULL,
  refresh_token_enc text NOT NULL,
  scope             text,
  connected_at      timestamptz NOT NULL DEFAULT now(),
  connected_by_name text,
  last_used_at      timestamptz,
  last_error        text,
  last_error_at     timestamptz,
  sent_checked_at   timestamptz
);
