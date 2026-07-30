-- Comms shell ---------------------------------------------------------------
-- Archiving is PERSONAL filing, so it lives on the membership row, not the
-- conversation: one person tidying their inbox must never take a live
-- discussion off everyone else's board.
ALTER TABLE conversation_members ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_members_archived
  ON conversation_members (user_id) WHERE archived_at IS NOT NULL;
