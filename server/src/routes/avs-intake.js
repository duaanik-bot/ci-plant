// AVS photo sets — carton photos uploaded in CI Plant for Claude to check.
//
//   1. Someone at the press or in QA opens Artwork Verification (or the pop-up
//      at printing start), names the job card and adds photos. Each photo goes
//      straight to Google Drive, into the AVS folder under
//      "AVS CHECK/<date>/Set 0012 <job card>", through the Drive link (a Google
//      Apps Script web app the owner deployed from that Drive; its source is in
//      client/src/lib/avsRobot.js). Nothing but the photo's details is kept here.
//   2. Verify queues the set and fires the AVS routine at claude.ai — Claude's
//      own cloud session, so it runs with the owner's Mac and Claude app closed.
//      One run checks every set waiting in the queue, so a run already under way
//      is not fired again.
//   3. Claude writes the report to avs.reports / avs.problems (it shows on this
//      page) and marks the set done (runbook section 3). QA then decides here.
//
// This router writes avs.check_requests, avs.check_photos and avs.settings only.
// The two links live in avs.settings (admin only; the token is never sent back).
import { Router } from 'express';
import crypto from 'node:crypto';
import multer from 'multer';
import { q, one } from '../db.js';
import { optionalText } from '../helpers.js';
import { requireRole } from '../auth.js';
import { markUncacheable } from '../data-tables.js';
import { avsMandatorySql } from '../avs-gate.js';
import {
  AVS_PHOTO_MAX_BYTES, AVS_SET_MAX_PHOTOS, AVS_REMARK_MAX, avsSetFolder, photoProblem, setLabel, setupProblem,
} from '../../../client/src/lib/avs.js';

const r = Router();

const fail = (status, message) => Object.assign(new Error(message), { status });
const toId = v => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const MISSING = new Set(['42P01', '3F000']); // the avs schema exists only on production

// Who may add photos and press Verify: the press, QA and Planning (admin passes).
const canUpload = requireRole('qc', 'production', 'planner');
// Who may fire Claude again for a stuck or failed set.
const canRetry = requireRole('qc', 'planner');
// The two links: admin only.
const isAdmin = requireRole();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: AVS_PHOTO_MAX_BYTES }, defParamCharset: 'utf8' });
const uploadOne = (req, res, next) => upload.single('file')(req, res, err => {
  if (!err) return next();
  res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'The photo is over 4 MB. Shrink it and try again.' : err.message });
});

// ── Settings: the Drive link and the Claude link ────────────────────────────
const SETTING_KEYS = ['drive_bridge_url', 'drive_bridge_secret', 'routine_fire_url', 'routine_token'];

async function settings() {
  const rows = await q('SELECT key, value FROM avs.settings WHERE key = ANY($1)', [SETTING_KEYS]);
  return Object.fromEntries(rows.map(x => [x.key, x.value || '']));
}

async function saveSetting(key, value, note) {
  await q(`INSERT INTO avs.settings (key, value, note) VALUES ($1, $2, $3)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, note = EXCLUDED.note`, [key, value, note]);
}

// The shared secret the Drive link checks on every call. Made once, here; the
// setup panel writes it into the script the owner pastes into Apps Script.
async function driveSecret(user) {
  const cfg = await settings();
  if (cfg.drive_bridge_secret) return cfg.drive_bridge_secret;
  const secret = crypto.randomBytes(24).toString('base64url');
  await saveSetting('drive_bridge_secret', secret, `made by ${user || 'CI Plant'} ${new Date().toISOString()}`);
  return secret;
}

const linked = cfg => ({
  drive: !!(cfg.drive_bridge_url && cfg.drive_bridge_secret),
  claude: !!(cfg.routine_fire_url && cfg.routine_token),
});

// ── The Drive link ───────────────────────────────────────────────────────────
// One POST per call; Apps Script answers through a redirect, which fetch follows.
export async function callDrive(cfg, payload, { timeoutMs = 25000 } = {}) {
  if (!cfg.drive_bridge_url || !cfg.drive_bridge_secret) {
    throw fail(503, 'The Google Drive link for AVS is not set up yet. An admin sets it up in Artwork Verification → Setup.');
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(cfg.drive_bridge_url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ secret: cfg.drive_bridge_secret, ...payload }),
      redirect: 'follow',
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch {
      throw fail(502, 'Google Drive did not answer as expected. Check the Drive link is deployed as a Web app with access "Anyone".');
    }
    if (!data.ok) throw fail(502, `Google Drive refused: ${data.error || 'no reason given'}`);
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw fail(504, 'Google Drive took too long to answer. Try again.');
    throw e;
  } finally { clearTimeout(timer); }
}

// ── The Claude link ──────────────────────────────────────────────────────────
// POST to the routine's API trigger. The text is only a pointer: the routine
// reads the queue itself from avs.check_requests, and treats fire text as data.
export async function fireRoutine(cfg, text, { timeoutMs = 15000 } = {}) {
  if (!cfg.routine_fire_url || !cfg.routine_token) return { ok: false, status: 'not_linked', error: 'Claude is not linked yet' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(cfg.routine_fire_url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.routine_token}`,
        'anthropic-beta': 'experimental-cc-routine-2026-04-01',
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: String(text).slice(0, 2000) }),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const why = data?.error?.message || data?.error || `answer ${res.status}`;
      const hint = res.status === 429 ? ' (too many runs for now; Claude will pick the set up on the next run)' : '';
      return { ok: false, status: 'failed', error: `Claude did not start: ${why}${hint}` };
    }
    return { ok: true, status: 'fired', session_url: data.claude_code_session_url || null };
  } catch (e) {
    return { ok: false, status: 'failed', error: e.name === 'AbortError' ? 'Claude took too long to answer' : `Claude could not be reached: ${e.message}` };
  } finally { clearTimeout(timer); }
}

// One Claude run checks every set in the queue, so a run already checking (or
// fired a moment ago and not yet started) is joined, not fired again.
async function fireUnlessRunning(cfg, set, { force = false } = {}) {
  if (!force) {
    const busy = await one(`SELECT id FROM avs.check_requests
      WHERE (status = 'checking' AND claimed_at > now() - interval '3 hours')
         OR (status = 'queued' AND fire_status = 'fired' AND fired_at > now() - interval '20 minutes' AND id <> $1)
      LIMIT 1`, [set.id]);
    if (busy) {
      await q(`UPDATE avs.check_requests SET fire_status = 'joined', fire_error = NULL, updated_at = now() WHERE id = $1`, [set.id]);
      return { ok: true, status: 'joined' };
    }
  }
  const out = await fireRoutine(cfg,
    `CI Plant: AVS ${setLabel(set.id)}${set.jc_number ? ` (job card ${set.jc_number})` : ''} is waiting in avs.check_requests.`);
  await q(`UPDATE avs.check_requests SET fired_at = now(), fire_status = $2, fire_error = $3,
                  session_url = COALESCE($4, session_url), updated_at = now() WHERE id = $1`,
    [set.id, out.status, out.ok ? null : out.error, out.session_url || null]);
  return out;
}

// ── Reading sets ─────────────────────────────────────────────────────────────
const SET_COLS = `s.id, s.status, s.job_card_id, s.jc_number, s.product_hint, s.note, s.created_by, s.created_by_user_id,
  s.created_at, s.drive_folder_path, s.drive_folder_url, s.queued_at, s.queued_by, s.fired_at, s.fire_status,
  s.fire_error, s.session_url, s.claimed_at, s.progress, s.finished_at, s.report_no, s.report_rev, s.check_no,
  s.result, s.robot_note, s.cancelled_at, s.cancelled_by, s.updated_at`;

async function readSets({ id = null, limit = 40 } = {}) {
  const sets = await q(`SELECT ${SET_COLS} FROM avs.check_requests s
     WHERE ($1::bigint IS NULL OR s.id = $1) ORDER BY s.id DESC LIMIT $2`, [id, limit]);
  if (!sets.length) return [];
  const photos = await q(`SELECT id, request_id, seq, file_name, mime, size_bytes, captured_at, drive_url, uploaded_at
     FROM avs.check_photos WHERE request_id = ANY($1) ORDER BY request_id, seq`, [sets.map(s => s.id)]);
  return sets.map(s => ({ ...s, label: setLabel(s.id), photos: photos.filter(p => +p.request_id === +s.id) }));
}

const mayManage = (user, set) => user?.role === 'admin' || user?.role === 'qc' || +set.created_by_user_id === +user?.id;

const offWhenMissing = (res, next, empty) => e => (MISSING.has(e?.code) ? res.json(empty) : next(e));

r.get('/avs/uploads', async (req, res, next) => {
  try {
    markUncacheable();
    const [cfg, sets] = await Promise.all([settings(), readSets({ limit: Math.min(100, toId(req.query.limit) || 40) })]);
    const role = req.user?.role;
    res.json({
      enabled: true,
      linked: linked(cfg),
      can_upload: ['admin', 'qc', 'production', 'planner'].includes(role),
      can_retry: ['admin', 'qc', 'planner'].includes(role),
      is_admin: role === 'admin',
      sets,
    });
  } catch (e) {
    offWhenMissing(res, next, { enabled: false, linked: { drive: false, claude: false }, can_upload: false, sets: [] })(e);
  }
});

// Open job cards to pick from — printing ones first, the rest newest first.
r.get('/avs/job-cards', async (req, res, next) => {
  try {
    markUncacheable();
    const text = String(req.query.q ?? '').trim().slice(0, 60);
    const rows = await q(`
      SELECT jc.id, jc.jc_number, jc.status, p.name AS product_name, p.code AS product_code,
             gr.gang_number, pst.status AS printing_status,
             ${avsMandatorySql('jc')} AS avs_mandatory
        FROM job_cards jc
        LEFT JOIN products p ON p.id = jc.product_id
        LEFT JOIN gang_runs gr ON gr.id = jc.gang_run_id
        LEFT JOIN LATERAL (SELECT js.status FROM job_stages js
                            WHERE js.job_card_id = jc.id AND js.stage = 'printing' ORDER BY js.seq LIMIT 1) pst ON true
       WHERE jc.status IN ('open', 'in_progress')
         AND ($1 = '' OR jc.jc_number ILIKE '%' || $1 || '%' OR p.name ILIKE '%' || $1 || '%'
              OR p.code ILIKE '%' || $1 || '%' OR gr.gang_number ILIKE '%' || $1 || '%')
       ORDER BY (pst.status IN ('in_progress', 'partially_completed', 'hold')) DESC NULLS LAST, jc.id DESC
       LIMIT 30`, [text]);
    res.json(rows);
  } catch (e) { next(e); }
});

// ── Making a set ─────────────────────────────────────────────────────────────
r.post('/avs/uploads', canUpload, async (req, res, next) => {
  try {
    const note = optionalText(req.body?.note);
    if (note && note.length > AVS_REMARK_MAX) throw fail(400, `Keep the note under ${AVS_REMARK_MAX} characters.`);
    let jc = null;
    const jcId = toId(req.body?.job_card_id);
    if (jcId) {
      jc = await one(`SELECT jc.id, jc.jc_number, p.name AS product_name FROM job_cards jc
                        LEFT JOIN products p ON p.id = jc.product_id WHERE jc.id = $1`, [jcId]);
      if (!jc) throw fail(404, 'Job card not found');
    }
    const product = optionalText(req.body?.product_hint) || jc?.product_name || null;
    if (!jc && !product) throw fail(400, 'Pick the job card, or write the product name when there is none.');
    const set = await one(`INSERT INTO avs.check_requests
        (status, job_card_id, jc_number, product_hint, note, created_by, created_by_user_id, created_by_role)
      VALUES ('uploading', $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [jc?.id ?? null, jc?.jc_number ?? null, product ? product.slice(0, 200) : null, note,
        req.user.name ?? null, req.user.id ?? null, req.user.role ?? null]);
    const [out] = await readSets({ id: set.id });
    res.status(201).json(out);
  } catch (e) { next(e); }
});

const istDay = d => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' })
  .format(new Date(d)).replace(/\//g, '-');
// Some browsers send a HEIC photo with no type; its name still says what it is.
const BY_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' };
const photoMime = file => {
  const t = String(file.mimetype || '').toLowerCase();
  if (t && t !== 'application/octet-stream') return t;
  return BY_EXT[String(file.originalname || '').split('.').pop().toLowerCase()] || t;
};
const cleanName = name => String(name || 'photo.jpg').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(-80) || 'photo.jpg';

// One photo per call, straight on to Google Drive.
r.post('/avs/uploads/:id/photos', canUpload, uploadOne, async (req, res, next) => {
  try {
    const id = toId(req.params.id);
    const set = id && await one('SELECT * FROM avs.check_requests WHERE id = $1', [id]);
    if (!set) throw fail(404, 'Photo set not found');
    // Anyone who may upload may add to an open set: a press tablet is shared.
    if (set.status !== 'uploading') throw fail(409, `${setLabel(set.id)} was already sent for checking. Start a new set for more photos.`);
    const file = req.file;
    if (!file) throw fail(400, 'No photo received.');
    const mime = photoMime(file);
    const problem = photoProblem({ size: file.size, type: mime });
    if (problem) throw fail(400, problem);

    // Reserve the photo's number first: two phones adding to one set never
    // collide, and the count is read from the photos themselves.
    const seqRow = await one(`UPDATE avs.check_requests SET next_seq = next_seq + 1, updated_at = now()
      WHERE id = $1 AND status = 'uploading' RETURNING next_seq`, [set.id]);
    if (!seqRow) throw fail(409, `${setLabel(set.id)} was already sent for checking.`);
    const count = await one('SELECT count(*)::int AS n FROM avs.check_photos WHERE request_id = $1', [set.id]);
    if (count.n >= AVS_SET_MAX_PHOTOS) throw fail(409, `A set holds at most ${AVS_SET_MAX_PHOTOS} photos. Start a new set for more.`);

    const seq = +seqRow.next_seq;
    const folder = set.drive_folder_path || avsSetFolder({ id: set.id, day: istDay(set.created_at), jc_number: set.jc_number });
    const name = `${String(seq).padStart(2, '0')} ${cleanName(file.originalname)}`;
    const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
    const cfg = await settings();
    const put = await callDrive(cfg, {
      op: 'put', path: folder, name, mime, base64: file.buffer.toString('base64'),
    });
    const capturedAt = Number.isFinite(Date.parse(req.body?.captured_at)) ? new Date(req.body.captured_at).toISOString() : null;
    await q(`INSERT INTO avs.check_photos (request_id, seq, file_name, original_name, mime, size_bytes, sha256,
                                           captured_at, drive_file_id, drive_url, uploaded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [set.id, seq, name, String(file.originalname || '').slice(0, 200), mime, file.size, sha256,
        capturedAt, put.id || null, put.url || null, req.user.name ?? null]);
    await q(`UPDATE avs.check_requests SET drive_folder_path = $2,
                    drive_folder_id = COALESCE($3, drive_folder_id), drive_folder_url = COALESCE($4, drive_folder_url),
                    updated_at = now() WHERE id = $1`,
      [set.id, folder, put.parent?.id || null, put.parent?.url || null]);
    const [out] = await readSets({ id: set.id });
    res.status(201).json(out);
  } catch (e) { next(e); }
});

// ── Verify: queue the set and fire Claude ────────────────────────────────────
r.post('/avs/uploads/:id/verify', canUpload, async (req, res, next) => {
  try {
    const id = toId(req.params.id);
    const set = id && await one('SELECT * FROM avs.check_requests WHERE id = $1', [id]);
    if (!set) throw fail(404, 'Photo set not found');
    if (set.status !== 'uploading') throw fail(409, `${setLabel(set.id)} was already sent for checking.`);
    const count = await one('SELECT count(*)::int AS n FROM avs.check_photos WHERE request_id = $1', [set.id]);
    if (!count.n) throw fail(400, 'Add at least one photo before pressing Verify.');
    const queued = await one(`UPDATE avs.check_requests SET status = 'queued', queued_at = now(), queued_by = $2, updated_at = now()
      WHERE id = $1 AND status = 'uploading' RETURNING *`, [set.id, req.user.name ?? null]);
    if (!queued) throw fail(409, `${setLabel(set.id)} was already sent for checking.`);
    const fire = await fireUnlessRunning(await settings(), queued);
    const [out] = await readSets({ id: set.id });
    res.json({ set: out, fire });
  } catch (e) { next(e); }
});

// Fire Claude again for a set that is still waiting, or put a failed one back.
r.post('/avs/uploads/:id/retry', canRetry, async (req, res, next) => {
  try {
    const id = toId(req.params.id);
    const set = id && await one(`UPDATE avs.check_requests
        SET status = 'queued', queued_at = COALESCE(queued_at, now()), queued_by = COALESCE(queued_by, $2),
            robot_note = CASE WHEN status = 'failed' THEN NULL ELSE robot_note END, updated_at = now()
      WHERE id = $1 AND status IN ('queued', 'failed') RETURNING *`, [id, req.user.name ?? null]);
    if (!set) throw fail(409, 'Only a set that is waiting for Claude, or whose check failed, can be sent again.');
    const fire = await fireUnlessRunning(await settings(), set, { force: true });
    const [out] = await readSets({ id: set.id });
    res.json({ set: out, fire });
  } catch (e) { next(e); }
});

r.post('/avs/uploads/:id/cancel', canUpload, async (req, res, next) => {
  try {
    const id = toId(req.params.id);
    const set = id && await one('SELECT * FROM avs.check_requests WHERE id = $1', [id]);
    if (!set) throw fail(404, 'Photo set not found');
    if (!mayManage(req.user, set)) throw fail(403, 'Only the person who started this set, QA or an admin can cancel it.');
    const done = await one(`UPDATE avs.check_requests SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2,
        updated_at = now() WHERE id = $1 AND status IN ('uploading', 'queued') RETURNING id`, [set.id, req.user.name ?? null]);
    if (!done) throw fail(409, 'Claude has already started on this set, so it can no longer be cancelled.');
    const [out] = await readSets({ id: set.id });
    res.json(out);
  } catch (e) { next(e); }
});

// ── Setup (admin) ────────────────────────────────────────────────────────────
const tokenHint = t => (t ? `…${t.slice(-4)}` : '');

r.get('/avs/setup', isAdmin, async (req, res, next) => {
  try {
    markUncacheable();
    const secret = await driveSecret(req.user.name);
    const cfg = await settings();
    res.json({
      drive_bridge_url: cfg.drive_bridge_url || '',
      drive_bridge_secret: secret,
      routine_fire_url: cfg.routine_fire_url || '',
      routine_token_hint: tokenHint(cfg.routine_token),
      linked: linked(cfg),
    });
  } catch (e) { next(e); }
});

r.put('/avs/setup', isAdmin, async (req, res, next) => {
  try {
    const body = req.body || {};
    const pick = k => (k in body ? String(body[k] ?? '').trim() : null);
    const next_ = { drive_bridge_url: pick('drive_bridge_url'), routine_fire_url: pick('routine_fire_url'), routine_token: pick('routine_token') };
    const problem = setupProblem(next_);
    if (problem) throw fail(400, problem);
    const stamp = `set by ${req.user.name || 'admin'} ${new Date().toISOString()}`;
    for (const [key, value] of Object.entries(next_)) {
      // An empty token field means "keep the one saved" — it is never sent back.
      if (value == null || (key === 'routine_token' && value === '')) continue;
      await saveSetting(key, value, stamp);
    }
    const cfg = await settings();
    res.json({ ok: true, linked: linked(cfg), routine_token_hint: tokenHint(cfg.routine_token) });
  } catch (e) { next(e); }
});

// A new secret invalidates the deployed script until it is pasted in again.
r.post('/avs/setup/new-secret', isAdmin, async (req, res, next) => {
  try {
    const secret = crypto.randomBytes(24).toString('base64url');
    await saveSetting('drive_bridge_secret', secret, `made by ${req.user.name || 'admin'} ${new Date().toISOString()}`);
    res.json({ ok: true, drive_bridge_secret: secret });
  } catch (e) { next(e); }
});

r.post('/avs/setup/test-drive', isAdmin, async (req, res, next) => {
  try {
    const out = await callDrive(await settings(), { op: 'ping' });
    res.json({ ok: true, root: out.root || null });
  } catch (e) { next(e); }
});

// Starts one Claude run that only checks its connections (runbook 3.0). It
// counts as one routine run of the day.
r.post('/avs/setup/test-claude', isAdmin, async (req, res, next) => {
  try {
    const out = await fireRoutine(await settings(),
      'CI Plant setup test: check the connections only (runbook 2C.0), then stop. No photo set is waiting.');
    if (!out.ok) throw fail(502, out.error);
    res.json(out);
  } catch (e) { next(e); }
});

export default r;
