-- Web-push subscriptions — one row per DEVICE that agreed to be buzzed.
--
-- A notification row in `notifications` reaches the reader only while the app
-- is open in front of them. The plant's approvers are not sitting in front of
-- it: an extra-sheet request raised at the press at 3pm waits until somebody
-- happens to open the bell. This table is what lets the server reach the phone
-- in the reader's pocket instead.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The push service's URL for this browser install. UNIQUE on its own, NOT
  -- (user_id, endpoint): the endpoint identifies the DEVICE, so when a second
  -- person signs in on the same phone the subscription must MOVE to them, not
  -- fork into two rows that would both get buzzed for the other's approvals.
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_ok_at TIMESTAMPTZ,
  -- Consecutive send failures. A push service answers 404/410 for a
  -- subscription the user revoked or a browser they uninstalled; those are
  -- deleted on the spot. This counts the OTHER failures (timeouts, 5xx) so a
  -- device that has been unreachable for a long time can be retired without
  -- guessing.
  failures INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions(user_id);
