-- Threads on every record --------------------------------------------------
-- A conversation was addressable only as a job card, which is the sole reason
-- Job Cards had a Discuss button and no other module did. Addressing it as
-- (entity, entity_id) lets any record in the ERP carry a thread and inherit
-- everything the messenger already does — attachments, voice notes, read
-- pointers, tombstones, bell notifications — with no new plumbing.
--
-- job_card_id STAYS, but only so its FK cascade keeps deleting a job's thread
-- with the job. It must never be a second way to ADDRESS a thread: a job
-- thread created through the generic path without it set would be invisible to
-- the legacy lookup, which would then create a second thread for the same job.
-- The resolver always writes both, and record-threads.test.js asserts one
-- record can never hold two conversations.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS entity TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS entity_id INTEGER;
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_kind_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_kind_check
  CHECK (kind IN ('dm','group','job','record'));
-- The job threads that already exist move into the new addressing. 'job' is
-- kept as a legacy synonym of 'record' — same access rule, so a synonym can
-- never disagree with the word it stands for.
UPDATE conversations SET entity='job_card', entity_id=job_card_id
WHERE job_card_id IS NOT NULL AND entity IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_entity
  ON conversations (entity, entity_id) WHERE entity IS NOT NULL;

-- @mentions. Users and teams share one namespace so the composer's picker and
-- the fan-out do not need two code paths.
--
-- user_id is SET NULL with handle/label denormalized beside it — the same
-- choice messages.sender_id makes, and for the same reason: an employee
-- leaving must not erase every mention that ever named them.
CREATE TABLE IF NOT EXISTS mention_targets (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('user','team')),
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  handle TEXT NOT NULL UNIQUE,        -- 'anik', 'planning'
  label TEXT NOT NULL,                -- 'Anik Dua (MD)', 'Planning Team'
  member_ids JSONB,                   -- teams: the truth, editable; NOT derived at read time
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS message_mentions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  target_id INTEGER REFERENCES mention_targets(id) ON DELETE SET NULL,
  handle TEXT NOT NULL,               -- survives the target being deleted
  user_id INTEGER,                    -- expanded recipient; a team fans out to many rows
  PRIMARY KEY (message_id, handle, user_id)
);
-- The unread-mention check filters by VIEWER, so user_id must lead the index.
CREATE INDEX IF NOT EXISTS idx_message_mentions_user ON message_mentions (user_id, message_id);

-- "Delivered" needs a signal that is not "opened this thread" — that is the
-- same act as reading, so the two ticks would collapse into one. Written at
-- most once every two minutes (see requireAuth): a write per request would be
-- a continuous UPDATE stream on a table every request already reads.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;

-- Teams seeded from the grants that ACTUALLY exist. There is no 'procurement'
-- or 'accounts' role, so those teams are not invented here — an admin creates
-- them with explicit membership if the plant wants them.
INSERT INTO mention_targets (kind, handle, label, member_ids)
SELECT 'team', t.handle, t.label,
       (SELECT COALESCE(json_agg(u.id), '[]'::json) FROM users u
        WHERE u.active=1 AND (
          (t.handle='planning'   AND u.role='planner') OR
          (t.handle='production' AND u.role='production') OR
          (t.handle='quality'    AND u.role='qc') OR
          (t.handle='dispatch'   AND u.role='dispatch') OR
          (t.handle='management' AND u.is_management=1)))::jsonb
FROM (VALUES ('planning','Planning Team'), ('production','Production Team'),
             ('quality','Quality Team'), ('dispatch','Dispatch Team'),
             ('management','Management')) AS t(handle, label)
WHERE NOT EXISTS (SELECT 1 FROM mention_targets m WHERE m.handle = t.handle);
-- One mention target per active user, handle derived from the email local part.
INSERT INTO mention_targets (kind, user_id, handle, label)
SELECT 'user', u.id, split_part(u.email, '@', 1), u.name
FROM users u
WHERE u.active=1
  AND NOT EXISTS (SELECT 1 FROM mention_targets m WHERE m.handle = split_part(u.email, '@', 1));
