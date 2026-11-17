// The artwork register, as the Artwork page's Register tab reads it (Artwork Manager P1; owner's brief of 14 Nov
// 2026: "a register of new artwork and revisions, show their status and history, connect each job to its Drive files
// and email thread, and make files easy to find and download").
//
//   GET  /api/artwork/register?status=&customer=&q=       the jobs, newest activity first, each with its latest version
//   GET  /api/artwork/register/:jobId                     one job: every version, its files, the mails that carried it
//   POST /api/artwork/register/:jobId/map                 { product_id } — a person says which product a job is
//   POST /api/artwork/register/versions/:id/not-artwork   { reason } — filed by mistake; kept, hidden from the work
//   POST /api/artwork/register/versions/:id/restore       put it back
//   POST /api/artwork/register/notices/resend             the "done by the system" mails that gave up: send again
//
// Behind the Artwork tick. The office AVS fills the register (artwork-intake.js); nothing here sends mail, checks
// artwork or touches an order line — that is the next stage. Search is done here in JavaScript, not in SQL: the plant
// database's SQL_ASCII encoding lower-cases and splits spaces byte by byte.
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { audit } from '../helpers.js';
import { mayArtwork } from '../artwork-intake.js';
import { resendGaveUp, artworkNoticeSoft } from '../artwork-notice.js';

const r = Router();
const REFUSED = { error: 'Artwork is not ticked for this login — ask an admin to tick it in Masters → Users.', code: 'ARTWORK_REFUSED' };
const idOf = v => (/^\d{1,9}$/.test(String(v)) ? Number(v) : null);
const flat = v => String(v ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const DAY = 86400e3;

r.use('/artwork/register', async (req, res, next) => {
  try {
    const u = await one('SELECT id, name, role, modules, active FROM users WHERE id = $1', [idOf(req.user?.id)]);
    if (!u || !+u.active || !mayArtwork(u)) return res.status(403).json(REFUSED);
    next();
  } catch (e) { next(e); }
});

r.get('/artwork/register', async (req, res, next) => {
  try {
    const rows = await q(`
      SELECT j.id, j.job_no, j.customer_name, j.client_item_code, j.product_id, j.product_name, j.pack_type, j.to_sort,
             (SELECT count(*)::int FROM artwork_versions x WHERE x.job_id = j.id) AS versions,
             v.id AS v_id, v.label, v.status, v.variant, COALESCE(v.received_at, v.created_at) AS received_at
        FROM artwork_jobs j
        JOIN artwork_versions v ON v.id = (SELECT max(x.id) FROM artwork_versions x WHERE x.job_id = j.id)
       ORDER BY v.id DESC`);
    const status = String(req.query.status ?? '');
    const customer = flat(req.query.customer);
    const words = flat(req.query.q).split(' ').filter(Boolean);
    const now = Date.now();
    const jobs = rows
      .filter(j => (status === 'to_sort' ? j.to_sort : status === 'file_to_fetch' ? j.status === 'file_to_fetch' : true))
      .filter(j => !customer || flat(j.customer_name).includes(customer))
      .filter(j => {
        const hay = flat(`${j.job_no} ${j.customer_name} ${j.client_item_code} ${j.product_name}`);
        return words.every(w => hay.includes(w));
      })
      .map(j => ({
        id: j.id, job_no: j.job_no, customer_name: j.customer_name, client_item_code: j.client_item_code,
        product_id: j.product_id, product_name: j.product_name, pack_type: j.pack_type, to_sort: j.to_sort, versions: j.versions,
        latest: { id: j.v_id, label: j.label, status: j.status, variant: j.variant, received_at: j.received_at },
        waiting_days: Math.max(0, Math.floor((now - new Date(j.received_at).getTime()) / DAY)),
      }));
    // The last "done by the system" notice mail (artwork-notice.js): sent, waiting for mppchd's Gmail, or given up.
    // Every notice not sent is counted, so an older one that gave up is never hidden behind a newer one that went.
    const notice = await one(`SELECT id, status, to_text, error, tries, sent_at, created_at FROM artwork_notices
                               WHERE status <> 'skipped' ORDER BY id DESC LIMIT 1`);
    const counts = await one(`SELECT count(*) FILTER (WHERE status = 'gave_up')::int AS gave_up,
                                     count(*) FILTER (WHERE status IN ('waiting', 'failed', 'sending'))::int AS pending,
                                     (array_agg(error ORDER BY id DESC) FILTER (WHERE status = 'gave_up'))[1] AS gave_up_error
                                FROM artwork_notices`);
    res.json({ jobs, notice: notice ? { ...notice, ...counts } : null });
  } catch (e) { next(e); }
});

r.get('/artwork/register/:jobId', async (req, res, next) => {
  try {
    const job = idOf(req.params.jobId) && await one('SELECT * FROM artwork_jobs WHERE id = $1', [idOf(req.params.jobId)]);
    if (!job) return res.status(404).json({ error: 'No such artwork job.' });
    const versions = await q(`SELECT id, label, client_rev, receipt_no, variant, status, COALESCE(received_at, created_at) AS received_at,
                                     designer_reply_at FROM artwork_versions WHERE job_id = $1 ORDER BY id DESC`, [job.id]);
    const files = await q(`SELECT f.id, f.version_id, f.role, f.file_name, f.ext, f.size_bytes, f.sha256, f.drive_file_id, f.drive_url, f.link_url, f.saved_by
                             FROM artwork_files f JOIN artwork_versions v ON v.id = f.version_id WHERE v.job_id = $1 ORDER BY f.id`, [job.id]);
    const events = await q(`SELECT id, version_id, mail_id, action, detail, by_name, at FROM artwork_events WHERE job_id = $1 ORDER BY id`, [job.id]);
    const mails = await q(`SELECT id, subject, from_name, from_email, received_at, view_url, gmail_thread_id FROM artwork_mails
                            WHERE id = ANY($1::int[]) ORDER BY received_at NULLS LAST, id`, [[...new Set(events.map(e => e.mail_id).filter(Boolean))]]);
    for (const v of versions) {
      v.files = files.filter(f => f.version_id === v.id);
      const mine = new Set(events.filter(e => e.version_id === v.id && e.mail_id).map(e => e.mail_id));
      v.mails = mails.filter(m => mine.has(m.id));
    }
    res.json({ job, versions, events });
  } catch (e) { next(e); }
});

// Send again: the notices that gave up go back in the queue (a person has looked — e.g. in mppchd's Sent folder).
r.post('/artwork/register/notices/resend', async (req, res, next) => {
  try {
    const n = await resendGaveUp();
    if (n) await audit('artwork_notice', 0, 'resend', `${n} artwork notice(s) put back to send`, q, req.user?.name);
    const out = n ? await artworkNoticeSoft() : null;
    res.json({ requeued: n, ...(out || {}) });
  } catch (e) { next(e); }
});

r.post('/artwork/register/:jobId/map', async (req, res, next) => {
  try {
    const jobId = idOf(req.params.jobId), productId = idOf(req.body?.product_id);
    const out = await tx(async (qc, oc) => {
      const job = jobId && await oc('SELECT id, job_no FROM artwork_jobs WHERE id = $1 FOR UPDATE', [jobId]);
      if (!job) return { status: 404, error: 'No such artwork job.' };
      const p = productId && await oc('SELECT id, name FROM products WHERE id = $1', [productId]);
      if (!p) return { status: 400, error: 'Pick the product this artwork is for.' };
      await qc('UPDATE artwork_jobs SET product_id = $2, product_name = $3, to_sort = false WHERE id = $1', [job.id, p.id, p.name]);
      await qc(`INSERT INTO artwork_events (job_id, action, detail, by_name) VALUES ($1, 'mapped', $2, $3)`,
        [job.id, JSON.stringify({ product_id: p.id, product_name: p.name }), req.user.name]);
      await audit('artwork_job', job.id, 'map', `${job.job_no} is ${p.name}`, qc, req.user.name);
      return { status: 200, ok: true };
    });
    res.status(out.status).json(out.error ? { error: out.error } : { ok: true });
  } catch (e) { next(e); }
});

// Marking a version "not artwork" and putting it back. A version put back is 'received' when a file of it is saved in
// Drive, and waits for its file otherwise — the same rule the intake files it by.
const setStatus = (toNotArtwork) => async (req, res, next) => {
  try {
    const id = idOf(req.params.id);
    const reason = String(req.body?.reason ?? '').trim();
    if (toNotArtwork && !reason) return res.status(400).json({ error: 'Say why this is not artwork.' });
    const out = await tx(async (qc, oc) => {
      const v = id && await oc(`SELECT v.id, v.job_id, v.label, v.status, j.job_no FROM artwork_versions v JOIN artwork_jobs j ON j.id = v.job_id
                                 WHERE v.id = $1 FOR UPDATE OF v`, [id]);
      if (!v) return { status: 404, error: 'No such artwork version.' };
      let status = 'not_artwork';
      if (!toNotArtwork) {
        const saved = await oc('SELECT 1 AS y FROM artwork_files WHERE version_id = $1 AND drive_file_id IS NOT NULL LIMIT 1', [v.id]);
        status = saved ? 'received' : 'file_to_fetch';
      }
      await qc('UPDATE artwork_versions SET status = $2 WHERE id = $1', [v.id, status]);
      await qc(`INSERT INTO artwork_events (job_id, version_id, action, detail, by_name) VALUES ($1, $2, $3, $4, $5)`,
        [v.job_id, v.id, toNotArtwork ? 'not_artwork' : 'restored', JSON.stringify(toNotArtwork ? { reason } : {}), req.user.name]);
      await audit('artwork_version', v.id, toNotArtwork ? 'not_artwork' : 'restore',
        `${v.job_no} ${v.label} ${toNotArtwork ? `marked not artwork — ${reason}` : 'put back in the register'}`, qc, req.user.name);
      return { status: 200 };
    });
    res.status(out.status).json(out.error ? { error: out.error } : { ok: true });
  } catch (e) { next(e); }
};
r.post('/artwork/register/versions/:id/not-artwork', setStatus(true));
r.post('/artwork/register/versions/:id/restore', setStatus(false));

export default r;
