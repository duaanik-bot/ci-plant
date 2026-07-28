-- CI Messenger ------------------------------------------------------------
-- In-app chat: DMs, group rooms, and one thread per job card, so plant talk
-- about a job lives NEXT TO the job. Attachments (photos, files, voice notes)
-- are BYTEA in Postgres — zero extra infrastructure, identical on the local
-- embedded PG and Supabase prod; the client compresses images before upload
-- so blobs stay small. Access rule enforced on every chat endpoint:
-- job threads are open to every signed-in user; dm/group need a member row.
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('dm','group','job')),
  name TEXT,                          -- groups & job threads; a DM's label is the other user
  dm_key TEXT UNIQUE,                 -- 'dm:<lowId>:<highId>' — one DM per user pair
  job_card_id INTEGER UNIQUE REFERENCES job_cards(id) ON DELETE CASCADE,
  auto_add INTEGER NOT NULL DEFAULT 0, -- new users join automatically (Plant Floor)
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin')),
  last_read_message_id INTEGER,       -- read pointer: unread counts + "Seen"
  last_seen_at TIMESTAMPTZ,           -- last thread fetch: a watcher's bell stays quiet
  typing_at TIMESTAMPTZ,
  muted INTEGER NOT NULL DEFAULT 0,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  -- SET NULL, not CASCADE and not bare: deleting a user must neither erase a
  -- thread's history nor 500 the existing Delete User flow. sender_name is
  -- denormalized right beside it, so the words keep their author's name.
  sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sender_name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','voice','file','system')),
  body TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at TIMESTAMPTZ              -- tombstone: senders may remove within 10 minutes
);
-- Heal databases created before sender_id became nullable SET NULL.
ALTER TABLE messages ALTER COLUMN sender_id DROP NOT NULL;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_sender_id_fkey;
ALTER TABLE messages ADD CONSTRAINT messages_sender_id_fkey
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_messages_conv_id ON messages (conversation_id, id);
CREATE TABLE IF NOT EXISTS message_attachments (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  duration_secs DOUBLE PRECISION,     -- voice notes only
  data BYTEA NOT NULL                 -- never selected in list queries
);
CREATE INDEX IF NOT EXISTS idx_fk_message_attachments_message_id ON message_attachments (message_id);
CREATE TABLE IF NOT EXISTS message_job_tags (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  job_card_id INTEGER NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, job_card_id)
);
CREATE INDEX IF NOT EXISTS idx_fk_message_job_tags_job_card_id ON message_job_tags (job_card_id);

-- Seed the two standing rooms once. Plant Floor takes every active user and
-- auto-adds future ones; Management mirrors the is_management grant. Member
-- INSERTs are idempotent, so a local restart heals membership drift without
-- ever re-creating a room the plant renamed or reorganised.
INSERT INTO conversations (kind, name, auto_add)
SELECT 'group', 'Plant Floor', 1
WHERE NOT EXISTS (SELECT 1 FROM conversations WHERE kind='group' AND name='Plant Floor');
INSERT INTO conversation_members (conversation_id, user_id, role)
SELECT c.id, u.id, CASE WHEN u.role='admin' THEN 'admin' ELSE 'member' END
FROM conversations c, users u
WHERE c.kind='group' AND c.name='Plant Floor' AND u.active=1
ON CONFLICT DO NOTHING;
INSERT INTO conversations (kind, name, auto_add)
SELECT 'group', 'Management', 0
WHERE NOT EXISTS (SELECT 1 FROM conversations WHERE kind='group' AND name='Management');
INSERT INTO conversation_members (conversation_id, user_id, role)
SELECT c.id, u.id, 'admin'
FROM conversations c, users u
WHERE c.kind='group' AND c.name='Management' AND u.active=1 AND u.is_management=1
ON CONFLICT DO NOTHING;
