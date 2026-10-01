// AVS photo sets — carton photos uploaded in CI Plant for Claude to check.
//
//   1. Someone at the press or in QA opens Artwork Verification (or the pop-up
//      at printing start), names the job card and adds photos. Each photo goes
//      straight to Google Drive, into the AVS folder under
//      "AVS CHECK/<date>/Set 0012 <job card>", through the Drive link (a Google
//      Apps Script web app the owner deployed from that Drive; its source is
//      client/src/lib/avs-robot/drive-link.gs). While the Drive link is not set
//      up — or when Drive refuses — CI Plant keeps the photo itself
//      (avs.check_photo_bytes) until the check files it in the AVS folder: an
//      upload never fails for want of the Drive link. The check fetches such a
//      photo through routes/avs-robot.js with the robot key, and marking it
//      filed (stored = 'drive') drops the kept copy.
//   2. Verify queues the set and fires the AVS routine at claude.ai — Claude's
//      own cloud session, so it runs with the owner's Mac and Claude app closed.
//      One run checks every set waiting in the queue, so a run already under way
//      is not fired again.
//   3. Claude writes the report to avs.reports / avs.problems (it shows on this
//      page) and marks the set done (runbook section 3). QA then decides here.
//
// This router writes avs.check_requests, avs.check_photos, avs.check_photo_bytes
// and avs.settings only, and deletes nothing.
// The two links live in avs.settings (admin only; the token is never sent back).
import { Router } from 'express';
import crypto from 'node:crypto';
import multer from 'multer';
import { q, one, tx } from '../db.js';
import { optionalText } from '../helpers.js';
import { requireRole } from '../auth.js';
import { markUncacheable } from '../data-tables.js';
import { avsMandatorySql } from '../avs-gate.js';
import { postDrive } from '../avs-drive.js';
import {
  AVS_PHOTO_MAX_BYTES, AVS_REPORT_NO, AVS_SET_MAX_PHOTOS, AVS_REMARK_MAX, avsSetFolder, jobCardNumbers, photoProblem, redoProblem,
  setLabel, setupProblem,
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

// A ceiling on the photos CI Plant keeps while they wait to be filed in Google
// Drive, so a check that never runs cannot fill the database.
const keptMaxBytes = () => (Number(process.env.AVS_KEPT_MAX_MB) > 0 ? Number(process.env.AVS_KEPT_MAX_MB) : 1024) * 1024 * 1024;
const sizeText = n => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1024 ** 2))} MB`);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: AVS_PHOTO_MAX_BYTES }, defParamCharset: 'utf8' });
const uploadOne = (req, res, next) => upload.single('file')(req, res, err => {
  if (!err) return next();
  res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'The photo is over 4 MB. Shrink it and try again.' : err.message });
});

// ── Settings: the Drive link and the Claude link ────────────────────────────
const SETTING_KEYS = ['drive_bridge_url', 'drive_bridge_secret', 'routine_fire_url', 'routine_token', 'robot_key'];

export async function avsSettings() { return settings(); }

async function settings() {
  const rows = await q('SELECT key, value FROM avs.settings WHERE key = ANY($1)', [SETTING_KEYS]);
  return Object.fromEntries(rows.map(x => [x.key, x.value || '']));
}

async function saveSetting(key, value, note) {
  await q(`INSERT INTO avs.settings (key, value, note) VALUES ($1, $2, $3)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, note = EXCLUDED.note`, [key, value, note]);
}

// The key the AVS check uses to fetch a photo kept in CI Plant (avs-robot.js).
// Made with the first such photo; read by the check from avs.settings; never
// sent to a browser.
async function ensureRobotKey(cfg) {
  if (cfg.robot_key) return;
  // Never replaces a key already made (two first uploads at once make one key).
  await q(`INSERT INTO avs.settings AS s (key, value, note) VALUES ('robot_key', $1, $2)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, note = EXCLUDED.note
           WHERE COALESCE(s.value, '') = ''`,
    [crypto.randomBytes(24).toString('hex'), 'made by CI Plant: the AVS check fetches photos kept in CI Plant with it']);
}

const linked = cfg => ({
  drive: !!(cfg.drive_bridge_url && cfg.drive_bridge_secret),
  claude: !!(cfg.routine_fire_url && cfg.routine_token),
});

// ── The Drive link ───────────────────────────────────────────────────────────
// One POST per call (avs-drive.js: an answer Google lost on the way is never
// taken as the answer, and the call is tried again while there is time).
// The secret it checks is made by the link itself when CI Plant pairs with it
// (pairDrive below), so nobody ever copies a secret by hand.
export async function callDrive(cfg, payload, opts = {}) {
  if (!cfg.drive_bridge_url || !cfg.drive_bridge_secret) {
    throw fail(503, 'The Google Drive link for AVS is not set up yet. An admin sets it up in Artwork Verification → Setup.');
  }
  return postDrive(cfg.drive_bridge_url, { secret: cfg.drive_bridge_secret, ...payload }, opts);
}

// Pair with a freshly deployed link: its first "pair" answer carries the secret
// it made, and it refuses to pair again (so pairing is never tried twice).
async function pairDrive(url, user) {
  let out;
  try {
    out = await postDrive(url, { op: 'pair' }, { tries: 1 });
  } catch (e) {
    if (/Already paired/.test(e.message)) {
      throw fail(409, 'This Drive link is already paired with something else. In Apps Script: Project Settings > Script Properties > '
        + 'delete AVS_SECRET, then press Save here again.');
    }
    throw e;
  }
  if (!/^[0-9a-f]{32,128}$/.test(String(out.secret || ''))) throw fail(502, 'Google Drive paired but sent no usable secret.');
  await saveSetting('drive_bridge_secret', out.secret, `paired by ${user || 'admin'} ${new Date().toISOString()}`);
  return out;
}

// ── The Claude link ──────────────────────────────────────────────────────────
// POST to the routine's API trigger. The text is only a pointer: the routine
// reads the queue itself from avs.check_requests, and treats fire text as data.
export async function fireRoutine(cfg, text, { timeoutMs = 15000 } = {}) {
  if (!cfg.routine_fire_url || !cfg.routine_token) return { ok: false, status: 'not_linked', error: 'Claude is not linked to CI Plant yet' };
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

// ── The office runner ────────────────────────────────────────────────────────
// A small program on an office Mac (CARTON PC MAIN; CI AVS/_SYSTEM/setup/
// local-runner) asks GET /api/avs/robot/queue every few seconds
// (routes/avs-robot.js) and starts Claude on that Mac within seconds, on the
// same company plan — no cloud start-up wait. While it has asked within
// RUNNER_ALIVE_S, Verify leaves the set to it (fire_status 'local') and spends
// no cloud run. If the set is still not claimed RUNNER_GRACE_MIN after that and
// nothing else is being checked, the cloud routine is fired after all
// (cloudFallback, run whenever the page or the runner asks).
export const RUNNER_ALIVE_S = 45;
export const RUNNER_GRACE_MIN = 3;

export async function runnerAlive() {
  const row = await one(`SELECT value FROM avs.settings WHERE key = 'local_runner_seen_at'`);
  const t = Date.parse(row?.value || '');
  return Number.isFinite(t) && Date.now() - t < RUNNER_ALIVE_S * 1000;
}

// Sets the office runner did not start in time go to the cloud routine. The
// sets are marked 'fallback' first, so two pages asking at once fire only once.
export async function cloudFallback() {
  const late = await q(`UPDATE avs.check_requests s SET fire_status = 'fallback', updated_at = now()
     WHERE s.status = 'queued' AND s.fire_status = 'local' AND s.fired_at < now() - make_interval(mins => $1)
       AND NOT EXISTS (SELECT 1 FROM avs.check_requests c WHERE c.status = 'checking' AND c.claimed_at > now() - interval '3 hours')
     RETURNING s.*`, [RUNNER_GRACE_MIN]);
  if (!late.length) return null;
  const cfg = await settings();
  let out = null;
  for (const set of late) out = await fireUnlessRunning(cfg, set, { cloud: true });
  return out;
}

// Every set gets its own run (since 1 Oct 2026): sets sent together are checked
// side by side instead of waiting in line behind one run. Each run claims its
// own set first (routine-prompt.md step 0) and takes the Drive lock only while
// it numbers and files its report (runbook 2C.2). A set whose run did not start
// (the daily run cap, a network error) is picked up by the next run that ends
// (runbook 2C.6 step 1). The cloud run reaches the AVS folder only through the
// Drive link: without it no run is spent, and the set waits for a check started
// in Cowork (runbook 2C.7).
async function fireUnlessRunning(cfg, set, { cloud = false } = {}) {
  const links = linked(cfg);
  if (links.claude && !links.drive) {
    const error = 'The Drive link is not set up, so Claude cannot reach the AVS folder from the cloud';
    await q(`UPDATE avs.check_requests SET fire_status = 'not_linked', fire_error = $2, updated_at = now() WHERE id = $1`,
      [set.id, error]);
    return { ok: false, status: 'not_linked', error };
  }
  if (!cloud && links.drive && await runnerAlive()) {
    await q(`UPDATE avs.check_requests SET fire_status = 'local', fired_at = now(), fire_error = NULL, updated_at = now()
      WHERE id = $1`, [set.id]);
    return { ok: true, status: 'local' };
  }
  const out = await fireRoutine(cfg,
    `CI Plant: AVS ${setLabel(set.id)}${set.jc_number ? ` (job card ${(Array.isArray(set.job_cards) && set.job_cards.length > 1
      ? set.job_cards.map(c => c.jc_number) : [set.jc_number]).join(', ')})` : ''}`
    + `${set.redo_report_no ? `, a redo of ${set.redo_report_no},` : ''} is waiting in avs.check_requests (set id ${set.id}).`);
  await q(`UPDATE avs.check_requests SET fired_at = now(), fire_status = $2, fire_error = $3,
                  session_url = COALESCE($4, session_url), updated_at = now() WHERE id = $1`,
    [set.id, out.status, out.ok ? null : out.error, out.session_url || null]);
  return out;
}

// ── Reading sets ─────────────────────────────────────────────────────────────
const SET_COLS = `s.id, s.status, s.job_card_id, s.jc_number, s.product_hint, s.note, s.created_by, s.created_by_user_id,
  s.created_at, s.drive_folder_path, s.drive_folder_url, s.queued_at, s.queued_by, s.fired_at, s.fire_status,
  s.fire_error, s.session_url, s.claimed_at, s.progress, s.finished_at, s.report_no, s.report_rev, s.check_no,
  s.result, s.robot_note, s.cancelled_at, s.cancelled_by, s.updated_at, s.redo_report_no, s.redo_of_set_id, s.redo_reason,
  s.job_cards, s.progress_log`;

// One set, or the list: every set still in progress, and the newest
// `perStatus` of each finished status (the page shows them by status, with
// chips counting all of them).
async function readSets({ id = null, perStatus = 25 } = {}) {
  const sets = id
    ? await q(`SELECT ${SET_COLS} FROM avs.check_requests s WHERE s.id = $1`, [id])
    : await q(`SELECT ${SET_COLS} FROM (
          SELECT *, row_number() OVER (PARTITION BY status ORDER BY id DESC) AS nth FROM avs.check_requests) s
        WHERE s.status IN ('uploading', 'queued', 'checking') OR s.nth <= $1 ORDER BY s.id DESC`, [perStatus]);
  if (!sets.length) return [];
  const photos = await q(`SELECT id, request_id, seq, file_name, mime, size_bytes, captured_at, drive_url, uploaded_at,
            stored, filed_at, filed_path
     FROM avs.check_photos WHERE request_id = ANY($1) ORDER BY request_id, seq`, [sets.map(s => s.id)]);
  return sets.map(s => ({ ...s, label: setLabel(s.id), photos: photos.filter(p => +p.request_id === +s.id) }));
}

const mayManage = (user, set) => user?.role === 'admin' || user?.role === 'qc' || +set.created_by_user_id === +user?.id;

const offWhenMissing = (res, next, empty) => e => (MISSING.has(e?.code) ? res.json(empty) : next(e));

r.get('/avs/uploads', async (req, res, next) => {
  try {
    markUncacheable();
    // A set the office runner did not start in time goes to the cloud now.
    await cloudFallback().catch(e => console.warn('[avs] cloud fallback:', e.message));
    const [cfg, sets, counts] = await Promise.all([
      settings(),
      readSets({ perStatus: Math.min(100, toId(req.query.per_status) || 25) }),
      q('SELECT status, count(*)::int AS n FROM avs.check_requests GROUP BY status'),
    ]);
    const role = req.user?.role;
    res.json({
      enabled: true,
      linked: linked(cfg),
      counts: Object.fromEntries(counts.map(x => [x.status, x.n])),
      can_upload: ['admin', 'qc', 'production', 'planner'].includes(role),
      can_retry: ['admin', 'qc', 'planner'].includes(role),
      is_admin: role === 'admin',
      sets,
    });
  } catch (e) {
    offWhenMissing(res, next, { enabled: false, linked: { drive: false, claude: false }, can_upload: false, counts: {}, sets: [] })(e);
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
       LIMIT 50`, [text]);
    res.json(rows);
  } catch (e) { next(e); }
});

// ── Making a set ─────────────────────────────────────────────────────────────
// One job card, or several (job_card_ids): the same product in several orders
// or batches, or the cards of a gang, checked from one set of photos. All are
// kept in job_cards, in the order chosen; job_card_id / jc_number are the first.
export const AVS_SET_MAX_CARDS = 20;
r.post('/avs/uploads', canUpload, async (req, res, next) => {
  try {
    const note = optionalText(req.body?.note);
    if (note && note.length > AVS_REMARK_MAX) throw fail(400, `Keep the note under ${AVS_REMARK_MAX} characters.`);
    const asked = [...new Set([...(Array.isArray(req.body?.job_card_ids) ? req.body.job_card_ids : []), req.body?.job_card_id]
      .map(toId).filter(Boolean))];
    if (asked.length > AVS_SET_MAX_CARDS) throw fail(400, `Pick at most ${AVS_SET_MAX_CARDS} job cards for one set.`);
    const found = asked.length ? await q(`SELECT jc.id, jc.jc_number, p.name AS product_name FROM job_cards jc
                        LEFT JOIN products p ON p.id = jc.product_id WHERE jc.id = ANY($1)`, [asked]) : [];
    if (found.length !== asked.length) throw fail(404, 'Job card not found');
    const cards = asked.map(id => found.find(c => +c.id === +id));
    const jc = cards[0] || null;
    const product = optionalText(req.body?.product_hint) || jc?.product_name || null;
    if (!jc && !product) throw fail(400, 'Pick the job card, or write the product name when there is none.');
    const set = await one(`INSERT INTO avs.check_requests
        (status, job_card_id, jc_number, product_hint, note, created_by, created_by_user_id, created_by_role, job_cards)
      VALUES ('uploading', $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [jc?.id ?? null, jc?.jc_number ?? null, product ? product.slice(0, 200) : null, note,
        req.user.name ?? null, req.user.id ?? null, req.user.role ?? null,
        cards.length ? JSON.stringify(cards.map(c => ({ id: +c.id, jc_number: c.jc_number, product_name: c.product_name ?? null }))) : null]);
    const [out] = await readSets({ id: set.id });
    res.status(201).json(out);
  } catch (e) { next(e); }
});

// ── Redo verification ────────────────────────────────────────────────────────
// Verify a report's product again with new photos. A new photo set is made for
// the same job card, marked as a redo of that report; the AVS check issues it
// as the report's next check (Check 2, Check 3 ..., runbook rule 21), so the
// register shows the latest check and every earlier one stays on record. The
// reason is required and kept with the set. One redo per report at a time: an
// open one still taking photos is handed back to go on with.
r.post('/avs/redo', canUpload, async (req, res, next) => {
  try {
    const reportNo = String(req.body?.report_no ?? '').trim();
    if (!AVS_REPORT_NO.test(reportNo)) throw fail(400, 'Not an AVS report number');
    const reason = optionalText(req.body?.reason);
    const problem = redoProblem({ reason });
    if (problem) throw fail(400, problem);
    const note = optionalText(req.body?.note);
    if (note && note.length > AVS_REMARK_MAX) throw fail(400, `Keep the note under ${AVS_REMARK_MAX} characters.`);

    const report = await one(`SELECT report_no, report_rev, check_no, status, product_name, product, job_card
      FROM avs.latest_reports WHERE report_no = $1`, [reportNo]);
    if (!report) throw fail(404, `${reportNo} not found`);
    const closed = await one(`SELECT 1 AS x FROM avs.reports WHERE report_no = $1 AND row_type = 'CLOSE' LIMIT 1`, [reportNo]);
    if (closed) throw fail(409, `${reportNo} was closed by the owner, so it cannot be checked again. Upload the photos as a new set.`);

    const open = await one(`SELECT id, status FROM avs.check_requests
      WHERE redo_report_no = $1 AND status IN ('uploading', 'queued', 'checking') ORDER BY id DESC LIMIT 1`, [reportNo]);
    if (open?.status === 'uploading') {
      const [out] = await readSets({ id: open.id });
      return res.json({ ...out, resumed: true });
    }
    if (open) throw fail(409, `${reportNo} is already being checked again (${setLabel(open.id)}). Wait for its report.`);

    // The check being redone: the set named, or the newest set that made this
    // report. None when the report came from photos put in the AVS folder.
    const fromId = toId(req.body?.set_id);
    const from = fromId
      ? await one('SELECT * FROM avs.check_requests WHERE id = $1 AND report_no = $2', [fromId, reportNo])
      : await one(`SELECT * FROM avs.check_requests WHERE report_no = $1 AND status = 'done' ORDER BY id DESC LIMIT 1`, [reportNo]);
    if (fromId && !from) throw fail(404, `${setLabel(fromId)} did not make ${reportNo}.`);

    // The job card: the earlier set's, else the one the report names.
    let jc = from?.job_card_id
      ? await one(`SELECT jc.id, jc.jc_number FROM job_cards jc WHERE jc.id = $1`, [from.job_card_id])
      : null;
    if (!jc && report.job_card) {
      const first = jobCardNumbers(report.job_card)[0];
      jc = first ? await one(`SELECT id, jc_number FROM job_cards WHERE upper(jc_number) = $1 ORDER BY id DESC LIMIT 1`, [first])
        : null;
    }
    const product = String(from?.product_hint || report.product_name || report.product || '').slice(0, 200) || null;

    let made;
    try {
      made = await one(`INSERT INTO avs.check_requests
          (status, job_card_id, jc_number, product_hint, note, created_by, created_by_user_id, created_by_role,
           redo_report_no, redo_of_set_id, redo_reason, job_cards)
        VALUES ('uploading', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [jc?.id ?? from?.job_card_id ?? null, jc?.jc_number ?? from?.jc_number ?? report.job_card ?? null, product, note,
          req.user.name ?? null, req.user.id ?? null, req.user.role ?? null,
          reportNo, from?.id ?? null, reason.slice(0, AVS_REMARK_MAX),
          Array.isArray(from?.job_cards) && from.job_cards.length ? JSON.stringify(from.job_cards) : null]);
    } catch (e) {
      // Two people pressed Redo at once: the unique index lets one through.
      if (e?.code === '23505') throw fail(409, `${reportNo} is already being checked again. Reload the page.`);
      throw e;
    }
    const [out] = await readSets({ id: made.id });
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

// One photo per call: on to Google Drive, or kept here until the check files it.
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

    const count = await one('SELECT count(*)::int AS n FROM avs.check_photos WHERE request_id = $1', [set.id]);
    if (count.n >= AVS_SET_MAX_PHOTOS) throw fail(409, `A set holds at most ${AVS_SET_MAX_PHOTOS} photos. Start a new set for more.`);
    // Reserve the photo's number first: two phones adding to one set never
    // collide. A photo that is not saved gives its number back (below).
    const seqRow = await one(`UPDATE avs.check_requests SET next_seq = next_seq + 1, updated_at = now()
      WHERE id = $1 AND status = 'uploading' RETURNING next_seq`, [set.id]);
    if (!seqRow) throw fail(409, `${setLabel(set.id)} was already sent for checking.`);
    const seq = +seqRow.next_seq;
    const giveBack = () => q(`UPDATE avs.check_requests SET next_seq = next_seq - 1
      WHERE id = $1 AND next_seq = $2`, [set.id, seq]).catch(() => {});

    const extra = Array.isArray(set.job_cards) && set.job_cards.length > 1 ? ` +${set.job_cards.length - 1}` : '';
    const folder = set.drive_folder_path
      || avsSetFolder({ id: set.id, day: istDay(set.created_at), jc_number: set.jc_number ? `${set.jc_number}${extra}` : null });
    const name = `${String(seq).padStart(2, '0')} ${cleanName(file.originalname)}`;
    const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
    const capturedAt = Number.isFinite(Date.parse(req.body?.captured_at)) ? new Date(req.body.captured_at).toISOString() : null;
    const cfg = await settings();

    // Google Drive when the Drive link is set up. Otherwise — or when Drive
    // refuses, or its answer is lost — CI Plant keeps the photo until the AVS
    // check files it in Drive. A second try (the first answer lost on the way)
    // takes the file the first one may have filed, only when it is this photo
    // by its size; a Drive file is recorded only with its id.
    let put = null;
    let driveError = null;
    if (linked(cfg).drive) {
      try {
        put = await callDrive(cfg, { op: 'put', path: folder, name, mime, base64: file.buffer.toString('base64') },
          { again: { ifExists: 'reuse' } });
        if (!put?.id) { driveError = 'Google Drive gave no file id'; put = null; }
        else if (Number(put.size) !== file.size) { driveError = `Google Drive already has a different file named ${name}`; put = null; }
      } catch (e) { driveError = e.reason || e.message; }
    }
    if (!put) {
      const kept = await one(`SELECT COALESCE(sum(size_bytes), 0)::bigint AS n FROM avs.check_photos WHERE stored = 'ci_plant'`);
      if (Number(kept.n) + file.size > keptMaxBytes()) {
        await giveBack();
        throw fail(503, `CI Plant is already holding ${sizeText(Number(kept.n))} of AVS photos that wait to be filed in Google Drive, `
          + 'its limit. Ask the admin to run the AVS check (it files them) or to set up the Drive link, then add this photo again.');
      }
    }
    try {
      await tx(async (qc, oc) => {
        const photo = await oc(`INSERT INTO avs.check_photos (request_id, seq, file_name, original_name, mime, size_bytes, sha256,
                                                              captured_at, drive_file_id, drive_url, uploaded_by, stored)
                                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
          [set.id, seq, name, String(file.originalname || '').slice(0, 200), mime, file.size, sha256,
            capturedAt, put?.id || null, put?.url || null, req.user.name ?? null, put ? 'drive' : 'ci_plant']);
        if (!put) await qc('INSERT INTO avs.check_photo_bytes (photo_id, bytes) VALUES ($1, $2)', [photo.id, file.buffer]);
      });
    } catch (e) { await giveBack(); throw e; }
    await q(`UPDATE avs.check_requests SET drive_folder_path = $2,
                    drive_folder_id = COALESCE($3, drive_folder_id), drive_folder_url = COALESCE($4, drive_folder_url),
                    updated_at = now() WHERE id = $1`,
      [set.id, folder, put?.parent?.id || null, put?.parent?.url || null]);
    if (!put) await ensureRobotKey(cfg);
    const [out] = await readSets({ id: set.id });
    res.status(201).json({ ...out, last_photo: { seq, stored: put ? 'drive' : 'ci_plant', drive_error: driveError } });
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
    const fire = await fireUnlessRunning(await settings(), set);
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
    const cfg = await settings();
    res.json({
      drive_bridge_url: cfg.drive_bridge_url || '',
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
    const before = await settings();
    for (const [key, value] of Object.entries(next_)) {
      // An empty token field means "keep the one saved" — it is never sent back.
      if (value == null || (key === 'routine_token' && value === '')) continue;
      await saveSetting(key, value, stamp);
    }
    // A new Drive link pairs at once, and an emptied one is unlinked: the old
    // secret belongs to the old link. The answer says whether pairing worked,
    // with the AVS folder the link found.
    let drive = null;
    const newLink = next_.drive_bridge_url != null && next_.drive_bridge_url !== (before.drive_bridge_url || '');
    if (newLink) await saveSetting('drive_bridge_secret', '', stamp);
    if (next_.drive_bridge_url && (newLink || !before.drive_bridge_secret)) {
      const out = await pairDrive(next_.drive_bridge_url, req.user.name);
      drive = { paired: true, root: out.root || null };
    }
    const cfg = await settings();
    res.json({ ok: true, linked: linked(cfg), drive, routine_token_hint: tokenHint(cfg.routine_token) });
  } catch (e) { next(e); }
});

// Pair again with the saved link (after AVS_SECRET was deleted in Apps Script).
// A link that is paired already is left alone.
r.post('/avs/setup/pair-drive', isAdmin, async (req, res, next) => {
  try {
    const cfg = await settings();
    if (!cfg.drive_bridge_url) throw fail(400, 'Save the Drive link\'s Web app URL first.');
    if (cfg.drive_bridge_secret) throw fail(409, 'The Drive link is paired already. Press Test to check it.');
    const out = await pairDrive(cfg.drive_bridge_url, req.user.name);
    res.json({ ok: true, root: out.root || null, linked: linked(await settings()) });
  } catch (e) { next(e); }
});

// A new secret, made by the link itself and saved here; nothing to paste.
// Tried once: a second try would carry the secret the first one replaced.
r.post('/avs/setup/new-secret', isAdmin, async (req, res, next) => {
  try {
    const cfg = await settings();
    let out = null;
    let problem = null;
    try { out = await callDrive(cfg, { op: 'rotate' }, { tries: 1 }); } catch (e) { problem = e; }
    if (/^[0-9a-f]{32,128}$/.test(String(out?.secret || ''))) {
      await saveSetting('drive_bridge_secret', out.secret, `rotated by ${req.user.name || 'admin'} ${new Date().toISOString()}`);
      return res.json({ ok: true });
    }
    // No new secret came back. If the link made one anyway (its answer lost on
    // the way), the saved secret no longer opens it: a ping tells which.
    let stillWorks = null;
    try { await callDrive(cfg, { op: 'ping' }); stillWorks = true; } catch (e) { if (/Wrong secret/.test(e.message)) stillWorks = false; }
    if (stillWorks === false) {
      await saveSetting('drive_bridge_secret', '', `new secret lost on the way ${new Date().toISOString()}`);
      throw fail(502, 'The Drive link made a new secret, but Google lost its answer on the way. In Apps Script: Project Settings > '
        + 'Script Properties > delete AVS_SECRET, then press Pair again here.');
    }
    const why = problem?.message || 'Google Drive sent no usable secret.';
    throw fail(problem?.status || 502, stillWorks ? `${why} Nothing changed: the saved secret still works. Try again.`
      : `${why} Press Test to see whether the Drive link still works.`);
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
