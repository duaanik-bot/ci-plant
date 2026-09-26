// The AVS check's own way in to CI Plant: a key instead of an ERP login.
//
// A photo uploaded while the Google Drive link is not set up (or when Drive
// refused it) is kept in CI Plant, in avs.check_photo_bytes (avs-intake.js).
// The AVS check — the routine at claude.ai, or Claude in Cowork — fetches it
// here, checks it, files it in the AVS folder, and then marks it filed in
// Supabase (stored = 'drive'), which drops the kept copy.
//
//   GET /api/avs/robot/photos/:id      header  x-avs-robot-key: <avs.settings robot_key>
//
// Read-only. The key is made by CI Plant with the first kept photo and lives
// only in avs.settings, which the check reads through the Supabase connector;
// it is never sent to a browser. Mounted before requireAuth (app.js).
import { Router } from 'express';
import crypto from 'node:crypto';
import { one } from '../db.js';
import { markUncacheable } from '../data-tables.js';

const r = Router();
const MISSING = new Set(['42P01', '3F000']); // the avs schema exists only on production

// Compared as digests, so the time taken says nothing about the key.
const sameKey = (given, real) => {
  if (!given || !real) return false;
  const digest = v => crypto.createHash('sha256').update(String(v)).digest();
  return crypto.timingSafeEqual(digest(given), digest(real));
};

r.get('/avs/robot/photos/:id', async (req, res, next) => {
  try {
    markUncacheable();
    res.set('Cache-Control', 'no-store');
    const key = await one(`SELECT value FROM avs.settings WHERE key = 'robot_key'`);
    if (!sameKey(req.get('x-avs-robot-key'), key?.value)) {
      return res.status(401).json({ error: 'Wrong or missing robot key (avs.settings robot_key).' });
    }
    const id = Number(req.params.id);
    const photo = Number.isInteger(id) && id > 0 && await one(`
      SELECT p.id, p.file_name, p.mime, p.sha256, p.stored, p.drive_url, p.filed_path, b.bytes
        FROM avs.check_photos p LEFT JOIN avs.check_photo_bytes b ON b.photo_id = p.id
       WHERE p.id = $1`, [id]);
    if (!photo) return res.status(404).json({ error: 'No such photo.' });
    if (!photo.bytes) {
      return res.status(410).json({
        error: 'This photo is no longer kept in CI Plant: it is in the AVS folder in Google Drive.',
        stored: photo.stored, drive_url: photo.drive_url, filed_path: photo.filed_path,
      });
    }
    res.set({
      'Content-Type': photo.mime || 'application/octet-stream',
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(photo.file_name)}`,
      'X-Photo-Sha256': photo.sha256 || '',
    });
    res.end(photo.bytes);
  } catch (e) {
    if (MISSING.has(e?.code)) return res.status(404).json({ error: 'AVS is not set up on this database.' });
    next(e);
  }
});

export default r;
