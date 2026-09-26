-- AVS photos kept in CI Plant until the AVS check files them in the AVS folder.
--
-- PRODUCTION ONLY, like 20260926140100_avs_photo_sets.sql: init() never builds
-- the schema `avs`. This file is the record of what was applied. APPLIED
-- 2026-09-26 as the named migration `avs_photos_kept_in_ci_plant`.
--
-- An upload no longer depends on the Google Drive link. While the link is not
-- set up — or when Drive refuses a photo — CI Plant keeps the photo itself:
--
--   avs.check_photos.stored      'drive'     the photo is in the AVS folder in Google Drive
--                                'ci_plant'  kept in avs.check_photo_bytes until the
--                                            AVS check files it in the AVS folder
--   avs.check_photos.filed_at    when the check put the photo in its case folder
--   avs.check_photos.filed_path  where, inside the AVS folder
--   avs.check_photo_bytes        the kept photo, one row per kept photo. A table of
--                                its own, so a SELECT * on check_photos never drags
--                                megabytes along.
--
-- The check fetches a kept photo from CI Plant (GET /api/avs/robot/photos/:id with
-- the avs.settings robot_key), files it, and then sets stored = 'drive': the
-- trigger below drops the kept copy the moment it does.
ALTER TABLE avs.check_photos
  ADD COLUMN IF NOT EXISTS stored text NOT NULL DEFAULT 'drive',
  ADD COLUMN IF NOT EXISTS filed_at timestamptz,
  ADD COLUMN IF NOT EXISTS filed_path text;
DO $$ BEGIN
  ALTER TABLE avs.check_photos ADD CONSTRAINT check_photos_stored_check CHECK (stored IN ('drive', 'ci_plant'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS avs.check_photo_bytes (
  photo_id bigint PRIMARY KEY REFERENCES avs.check_photos(id) ON DELETE CASCADE,
  bytes    bytea NOT NULL,
  kept_at  timestamptz NOT NULL DEFAULT now()
);
-- JPEG, PNG, WebP and HEIC are compressed already: kept as they are, out of line.
ALTER TABLE avs.check_photo_bytes ALTER COLUMN bytes SET STORAGE EXTERNAL;

-- Filed in the AVS folder → the copy kept here goes.
CREATE OR REPLACE FUNCTION avs.drop_filed_photo_bytes() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  DELETE FROM avs.check_photo_bytes WHERE photo_id = NEW.id;
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS check_photos_filed ON avs.check_photos;
CREATE TRIGGER check_photos_filed AFTER UPDATE OF stored ON avs.check_photos
  FOR EACH ROW WHEN (NEW.stored = 'drive') EXECUTE FUNCTION avs.drop_filed_photo_bytes();

-- Same lock-down as the rest of the schema.
ALTER TABLE avs.check_photo_bytes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON avs.check_photo_bytes FROM anon, authenticated;
REVOKE ALL ON FUNCTION avs.drop_filed_photo_bytes() FROM PUBLIC, anon, authenticated;

-- Set 0001 used up its photo numbers on uploads refused for want of the Drive
-- link. A set still open with no photo in it starts again from 01.
UPDATE avs.check_requests r SET next_seq = 0, updated_at = now()
 WHERE r.status = 'uploading' AND r.next_seq > 0
   AND NOT EXISTS (SELECT 1 FROM avs.check_photos p WHERE p.request_id = r.id);
