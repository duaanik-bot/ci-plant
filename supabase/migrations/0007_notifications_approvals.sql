-- In-app notifications -----------------------------------------------------
-- One row = one message for one signed-in user, surfaced by the bell in the
-- app shell. Producers write through notify() in helpers.js; the bell polls
-- /notifications and lists unread first. read_at is the only mutable field.
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,            -- xs_request | xs_decision | mgt_request | mgt_decision
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,                     -- in-app route the row navigates to
  ref_table TEXT, ref_id INTEGER,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications (user_id) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications (user_id, created_at DESC);

-- Management approval requests ---------------------------------------------
-- A planner flags a planned job for management sign-off — advisory, for the
-- selective job where something looks off (rate, quantity, board, date…).
-- NOTHING downstream is blocked by a pending or rejected request: it is a
-- question to management, not a gate on production.
CREATE TABLE IF NOT EXISTS approval_requests (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ar_number TEXT NOT NULL UNIQUE,             -- CI-MA-0001
  kind TEXT NOT NULL DEFAULT 'planning' CHECK (kind IN ('planning')),
  order_line_id INTEGER NOT NULL REFERENCES order_lines(id) ON DELETE CASCADE,
  note TEXT NOT NULL,                         -- what should management look at
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','cancelled')),
  requested_by TEXT, requested_by_id INTEGER,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by TEXT, decided_at TIMESTAMPTZ, decision_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_fk_approval_requests_order_line_id ON approval_requests (order_line_id);
CREATE INDEX IF NOT EXISTS idx_approval_requests_pending ON approval_requests (status) WHERE status = 'pending';

-- Who may act on what. xs_approver: ONLY these users can approve or reject an
-- extra-sheet request (the plant head — Dharminder, on the Plant login). A
-- per-user flag, deliberately NOT a role: several plant logins carry
-- role=admin, and a role-admin bypass would hand the approval back to all of
-- them. is_management: receives "management approval" asks from Planning and
-- may decide them. Both flags are edited in Masters → Users.
ALTER TABLE users ADD COLUMN IF NOT EXISTS xs_approver INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_management INTEGER NOT NULL DEFAULT 0;
-- Route the approve/reject decision back to the requester's bell. The display
-- name column stays (it prints on the request card); the id targets the
-- notification.
ALTER TABLE extra_sheet_requests ADD COLUMN IF NOT EXISTS requested_by_id INTEGER;

-- Seed once, never override a later choice made in Masters → Users: the Plant
-- login (operated by the plant head) starts as the extra-sheet approver; MD
-- and Plant start as management.
UPDATE users SET xs_approver = 1
WHERE email = 'plant@motionci.com'
  AND NOT EXISTS (SELECT 1 FROM users WHERE xs_approver = 1);
UPDATE users SET is_management = 1
WHERE email IN ('md@motionci.com', 'plant@motionci.com')
  AND NOT EXISTS (SELECT 1 FROM users WHERE is_management = 1);
