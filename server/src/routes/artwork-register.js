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
//   GET  /api/artwork/register/:jobId/thread              the job's whole mail trail, read live from mppchd's Gmail
//   GET  /api/artwork/register/:jobId/new-product         what "Create it" would make, and any master that looks the same
//   POST /api/artwork/register/:jobId/create-product      a product not in our masters → a DRAFT master, linked (Masters rights)
//   GET  /api/artwork/register/thread-attachment?message=&attachment=&name=   one file from an artwork thread
//
// Behind the Artwork tick. The office AVS fills the register (artwork-intake.js); nothing here sends mail, checks
// artwork or touches an order line — that is the next stage. Search is done here in JavaScript, not in SQL: the plant
// database's SQL_ASCII encoding lower-cases and splits spaces byte by byte.
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { audit } from '../helpers.js';
import { createDraftProduct, fluenceKitFor } from '../artwork-masters.js';
import { requireRole } from '../auth.js';
import { mayArtwork } from '../artwork-intake.js';
import { resendGaveUp, artworkNoticeSoft } from '../artwork-notice.js';
import { actionsFor } from '../artwork-flow.js';
import { tickIfApproved } from '../artwork-approval.js';
import { cancelDraftsOf } from '../artwork-settle.js';
import { gmailConfigured, accessToken, readAllowed, readThread, messageThread, readAttachment } from '../gmail.js';
import { threadMessages } from '../artwork-thread.js';

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
             v.id AS v_id, v.label, v.status, v.variant, COALESCE(v.received_at, v.created_at) AS received_at,
             v.stage, v.stage_at, v.deleted_at, m.gmail_thread_id,
             (SELECT pm.id FROM artwork_proof_mails pm WHERE v.id = ANY(pm.version_ids) AND pm.status IN ('draft', 'sending') ORDER BY pm.id DESC LIMIT 1) AS draft_id
        FROM artwork_jobs j
        -- the newest live version; a job whose every version is deleted shows its newest one (under the Deleted chip)
        JOIN artwork_versions v ON v.id = COALESCE((SELECT max(x.id) FROM artwork_versions x WHERE x.job_id = j.id AND x.deleted_at IS NULL),
                                                   (SELECT max(x.id) FROM artwork_versions x WHERE x.job_id = j.id))
        LEFT JOIN artwork_mails m ON m.id = v.first_mail_id
       ORDER BY v.id DESC`);
    const status = String(req.query.status ?? '');
    const customer = flat(req.query.customer);
    const words = flat(req.query.q).split(' ').filter(Boolean);
    const now = Date.now();
    const jobs = rows
      .filter(j => (status === 'deleted' ? !!j.deleted_at : !j.deleted_at))
      .filter(j => (status === 'to_sort' ? j.to_sort : status === 'file_to_fetch' ? j.status === 'file_to_fetch'
        : status.startsWith('stage:') ? j.stage === status.slice(6) : true))
      .filter(j => !customer || flat(j.customer_name).includes(customer))
      .filter(j => {
        const hay = flat(`${j.job_no} ${j.customer_name} ${j.client_item_code} ${j.product_name}`);
        return words.every(w => hay.includes(w));
      })
      .map(j => ({
        id: j.id, job_no: j.job_no, customer_name: j.customer_name, client_item_code: j.client_item_code,
        product_id: j.product_id, product_name: j.product_name, pack_type: j.pack_type, to_sort: j.to_sort, versions: j.versions,
        latest: { id: j.v_id, label: j.label, status: j.status, variant: j.variant, received_at: j.received_at, stage: j.stage, stage_at: j.stage_at,
          actions: actionsFor({ stage: j.stage, status: j.status, deleted_at: j.deleted_at }), draft_id: j.draft_id, gmail_thread_id: j.gmail_thread_id,
          deleted_at: j.deleted_at },
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
    // Designers' exports the system could not put on a job: a person picks the job.
    const unmatched = await q(`SELECT id, file_name, by_name, match_note, drive_url, created_at FROM artwork_exports WHERE version_id IS NULL AND dismissed_at IS NULL ORDER BY id DESC LIMIT 50`);
    res.json({ jobs, notice: notice ? { ...notice, ...counts } : null, unmatched_exports: unmatched });
  } catch (e) { next(e); }
});

r.get('/artwork/register/:jobId', async (req, res, next) => {
  if (!/^\d+$/.test(req.params.jobId)) return next();   // /artwork/register/keys and the like belong to other routes
  try {
    const job = idOf(req.params.jobId) && await one('SELECT * FROM artwork_jobs WHERE id = $1', [idOf(req.params.jobId)]);
    if (!job) return res.status(404).json({ error: 'No such artwork job.' });
    const versions = await q(`SELECT id, label, client_rev, receipt_no, variant, status, COALESCE(received_at, created_at) AS received_at,
                                     designer_reply_at, stage, stage_at, decided_note, deleted_at, deleted_reason, deleted_by
                                FROM artwork_versions WHERE job_id = $1 ORDER BY id DESC`, [job.id]);
    const vIds = versions.map(v => v.id);
    const exportsOf = await q(`SELECT id, version_id, by_name, file_name, size_bytes, page_w_mm::float8 AS page_w_mm, page_h_mm::float8 AS page_h_mm, colours,
                                      drive_url, created_at FROM artwork_exports WHERE version_id = ANY($1::int[]) ORDER BY id DESC`, [vIds]);
    const proofsOf = await q(`SELECT id, proof_no, version_id, proof_mail_id, file_name, drive_url, by_hand, created_at FROM artwork_proofs
                               WHERE version_id = ANY($1::int[]) ORDER BY id DESC`, [vIds]);
    const proofMails = await q(`SELECT id, version_ids, to_text, cc_text, subject, body_text, draft_url, status, error, created_by, created_at, sent_by, sent_at
                                  FROM artwork_proof_mails WHERE version_ids && $1::int[] ORDER BY id DESC`, [vIds]);
    // (none before the Fluence-mail migration is applied: the window opens all the same)
    const readingsOf = await q(`SELECT id, artwork_version_id, status, hold_reason, kit_name, read_from, changes, saved_at, created_product_id
                                  FROM fluence_mail_readings WHERE artwork_version_id = ANY($1::int[]) ORDER BY id DESC`, [vIds])
      .catch(e => (e?.code === '42P01' ? [] : Promise.reject(e)));
    const kld = job.product_id ? await one(`SELECT cs.id, cs.size_key FROM costings c JOIN costing_sizes cs ON cs.id = c.size_id AND cs.kld IS NOT NULL
                                             WHERE c.product_id = $1 ORDER BY c.id DESC LIMIT 1`, [job.product_id]).catch(() => null) : null;
    const files = await q(`SELECT f.id, f.version_id, f.role, f.file_name, f.ext, f.size_bytes, f.sha256, f.drive_file_id, f.drive_url, f.link_url, f.saved_by
                             FROM artwork_files f JOIN artwork_versions v ON v.id = f.version_id WHERE v.job_id = $1 ORDER BY f.id`, [job.id]);
    const events = await q(`SELECT id, version_id, mail_id, action, detail, by_name, at FROM artwork_events WHERE job_id = $1 ORDER BY id`, [job.id]);
    const mails = await q(`SELECT id, subject, from_name, from_email, received_at, view_url, gmail_thread_id, body_text, summary FROM artwork_mails
                            WHERE id = ANY($1::int[]) ORDER BY received_at NULLS LAST, id`, [[...new Set(events.map(e => e.mail_id).filter(Boolean))]]);
    for (const v of versions) {
      v.files = files.filter(f => f.version_id === v.id);
      const mine = new Set(events.filter(e => e.version_id === v.id && e.mail_id).map(e => e.mail_id));
      v.mails = mails.filter(m => mine.has(m.id));
      v.superseded = versions.some(x => x.id > v.id && !x.deleted_at && x.status !== 'not_artwork');
      v.actions = actionsFor(v);
      v.exports = exportsOf.filter(e => e.version_id === v.id);
      v.proofs = proofsOf.filter(p => p.version_id === v.id);
      v.fluence = readingsOf.filter(x => x.artwork_version_id === v.id);
      v.proof_mails = proofMails.filter(pm => pm.version_ids.includes(v.id)).map(pm => ({ ...pm, attachments: proofsOf.filter(p => p.proof_mail_id === pm.id).map(p => ({ name: p.file_name, drive_url: p.drive_url })) }));
    }
    res.json({ job, versions, events, kld: kld ? { size_id: kld.id, size_key: kld.size_key, pdf: `/api/costing/sizes/${kld.id}/kld.pdf` } : null });
  } catch (e) { next(e); }
});

// ── the mail trail (owner, 18 Nov 2026: "This whole mail, the whole trail, the thread, should all be visible") ─────
// Read live from the business mailbox (mppchd) each time the window asks: every message of the job's threads, ours and
// the client's. Only threads of artwork jobs are ever read here. Without a connection allowed to read mail, the window
// says what to do and shows the text the office AVS filed.
async function businessRead() {
  if (!gmailConfigured()) return { why: 'Gmail is not set up on the server yet.' };
  const link = await one(`SELECT * FROM gmail_links WHERE mailbox = 'business'`);
  if (!link) return { why: "mppchd's Gmail is not connected to CI Plant yet — an admin presses Connect Gmail for the business mailbox (Enquiry desk › Settings) and allows reading mail." };
  if (!readAllowed(link)) return { why: "mppchd's Gmail was connected before CI Plant could read mail — an admin presses Connect Gmail again for the business mailbox (Enquiry desk › Settings) and allows reading mail." };
  return { link, token: await accessToken(link) };
}
const threadsOfJob = jobId => q(`
  SELECT DISTINCT t FROM (
    SELECT m.gmail_thread_id AS t FROM artwork_mails m JOIN artwork_events e ON e.mail_id = m.id JOIN artwork_versions v ON v.id = e.version_id WHERE v.job_id = $1
    UNION SELECT pm.gmail_thread_id FROM artwork_proof_mails pm JOIN artwork_versions v ON v.id = ANY(pm.version_ids) WHERE v.job_id = $1
  ) x WHERE t IS NOT NULL LIMIT 5`, [jobId]);

r.get('/artwork/register/:jobId/thread', async (req, res, next) => {
  try {
    const jobId = idOf(req.params.jobId);
    if (!jobId || !await one('SELECT id FROM artwork_jobs WHERE id = $1', [jobId])) return res.status(404).json({ error: 'No such artwork job.' });
    const threads = (await threadsOfJob(jobId)).map(x => x.t);
    if (!threads.length) return res.json({ available: true, threads: [], messages: [] });
    const g = await businessRead();
    if (!g.link) return res.json({ available: false, why: g.why });
    let messages = [];
    for (const t of threads) {
      const th = await readThread(g.token, { threadId: t });
      if (th) messages.push(...threadMessages(th, { own: g.link.email }).map(m => ({ ...m, thread_id: t })));
    }
    messages = [...new Map(messages.map(m => [m.id, m])).values()].sort((a, b) => String(a.at).localeCompare(String(b.at)));
    res.json({ available: true, threads, messages, mailbox: g.link.email });
  } catch (e) {
    if (e.gmail) return res.json({ available: false, why: e.message });
    next(e);
  }
});

// One attachment of an artwork thread. The message's thread is asked of Gmail and must be an artwork thread, so no other
// mail can be opened through CI Plant. A request carries at most ~4.5 MB back: a bigger file opens in Gmail.
const ID = /^[A-Za-z0-9_-]{1,200}$/;
const MIME = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', txt: 'text/plain' };
r.get('/artwork/register/thread-attachment', async (req, res, next) => {
  try {
    const messageId = String(req.query.message || ''), attachmentId = String(req.query.attachment || '');
    if (!ID.test(messageId) || !ID.test(attachmentId)) return res.status(400).json({ error: 'Which file?' });
    const g = await businessRead();
    if (!g.link) return res.status(409).json({ error: g.why });
    const thread = await messageThread(g.token, { messageId });
    const ours = thread && await one(`SELECT 1 AS y FROM artwork_mails WHERE gmail_thread_id = $1
                                      UNION ALL SELECT 1 FROM artwork_proof_mails WHERE gmail_thread_id = $1 LIMIT 1`, [thread]);
    if (!ours) return res.status(404).json({ error: 'No such file in an artwork mail.' });
    const bytes = await readAttachment(g.token, { messageId, attachmentId });
    if (bytes.length > 4 * 1024 * 1024) return res.status(413).json({ error: 'This file is too big to open here — open the mail in Gmail.' });
    const name = String(req.query.name || 'attachment').replace(/[\r\n"\\/]+/g, ' ').slice(0, 150) || 'attachment';
    const ext = (/\.([a-z0-9]{1,5})$/i.exec(name)?.[1] || '').toLowerCase();
    res.set('Content-Type', MIME[ext] || 'application/octet-stream');
    res.set('Content-Disposition', `${MIME[ext] ? 'inline' : 'attachment'}; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Content-Type-Options', 'nosniff');           // a client's file is never taken for a page of CI Plant's
    res.send(bytes);
  } catch (e) {
    if (e.gmail) return res.status(e.status || 502).json({ error: e.message });
    next(e);
  }
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
      // artwork approved before the job was linked: the product's open lines are ticked now
      const lines = await tickIfApproved(qc, p.id, req.user.name);
      return { status: 200, ok: true, order_lines: lines };
    });
    res.status(out.status).json(out.error ? { error: out.error } : { ok: true });
  } catch (e) { next(e); }
});

// ── a product not in our masters (owner, 18 Nov 2026: "give me the information that this product is not in our
// masters. Do you want to create it? We should be able to create that master") ──────────────────────────────────
// "Create it" makes a DRAFT product master from what the artwork mail says — the customer, the product's name, the
// customer's item code, the kind of pack — with the next code in that customer's series, the board on the placeholder
// and the spec marked incomplete, exactly as a product raised from a PO is (routes/drafts.js: it shows among the draft
// masters, and Masters finishes board, size and print spec). The job is linked to it at once. For a Fluence customer the
// Fluence kit record is made too, the way the Fluence module makes one for a product (source erp-product:<id>), so its
// prescription and MRPs have a home. Only those who keep the product master may do it (Masters: planner, admin).
const PACK_TYPE = { carton: 'carton', label: 'label', insert: 'leaflet', leaflet: 'leaflet' };
const flatName = v => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
async function newProductOf(jobId, qc = q) {
  const [job] = await qc(`SELECT j.*, c.name AS customer_master_name, (fc.customer_id IS NOT NULL) AS fluence
                            FROM artwork_jobs j LEFT JOIN customers c ON c.id = j.customer_id
                            LEFT JOIN fluence_customers fc ON fc.customer_id = j.customer_id WHERE j.id = $1`, [jobId]);
  if (!job) return null;
  const name = String(job.product_name || job.client_item_code || `Artwork ${job.job_no}`).trim().slice(0, 200);
  // what already exists for this customer under the same item code or name (compared here: SQL_ASCII lower-cases bytes)
  const same = job.customer_id ? (await qc(`SELECT id, code, name, party_item_code, is_draft FROM products WHERE customer_id = $1`, [job.customer_id]))
    .filter(p => (job.client_item_code && String(p.party_item_code || '').toUpperCase() === String(job.client_item_code).toUpperCase())
      || flatName(p.name) === flatName(name)) : [];
  return { job, preview: { customer_id: job.customer_id, customer_name: job.customer_master_name || job.customer_name, name,
    party_item_code: job.client_item_code || null, product_type: PACK_TYPE[String(job.pack_type || '').toLowerCase()] || null,
    fluence: !!job.fluence, linked: job.product_id || null, existing: same.map(p => ({ id: p.id, code: p.code, name: p.name, draft: !!p.is_draft })) } };
}

r.get('/artwork/register/:jobId/new-product', async (req, res, next) => {
  try {
    const it = await newProductOf(idOf(req.params.jobId));
    if (!it) return res.status(404).json({ error: 'No such artwork job.' });
    res.json(it.preview);
  } catch (e) { next(e); }
});

r.post('/artwork/register/:jobId/create-product', requireRole('planner'), async (req, res, next) => {
  try {
    const jobId = idOf(req.params.jobId);
    const out = await tx(async (qc, oc) => {
      const locked = jobId && await oc('SELECT id FROM artwork_jobs WHERE id = $1 FOR UPDATE', [jobId]);
      if (!locked) return { status: 404, error: 'No such artwork job.' };
      const { job, preview } = await newProductOf(jobId, qc);
      if (job.product_id) return { status: 409, error: 'This job is linked to a product already — use Change product to pick another.' };
      if (!job.customer_id) return { status: 409, error: `${job.customer_name || 'The customer'} is not in the customer master — add the customer first, then create the product.` };
      if (preview.existing.length) {
        const e = preview.existing[0];
        return { status: 409, error: `${e.code} ${e.name} is already in the masters${e.draft ? ' (a draft)' : ''} — pick it under Match to a product.` };
      }
      const p = await createDraftProduct(qc, oc, { customerId: job.customer_id, name: preview.name, partyItemCode: preview.party_item_code,
        productType: preview.product_type, draftSource: 'artwork', by: req.user.name, note: `made from artwork ${job.job_no}` });
      await qc('UPDATE artwork_jobs SET product_id = $2, product_name = $3, to_sort = false WHERE id = $1', [job.id, p.id, p.name]);
      await qc(`INSERT INTO artwork_events (job_id, action, detail, by_name) VALUES ($1, 'product_created', $2, $3)`,
        [job.id, JSON.stringify({ product_id: p.id, code: p.code, product_name: p.name }), req.user.name]);
      await audit('artwork_job', job.id, 'map', `${job.job_no} is ${p.code} ${p.name} (new draft master)`, qc, req.user.name);
      const kitId = preview.fluence ? (await fluenceKitFor(qc, oc, p, req.user.name)).id : null;
      // artwork approved before the job had a product: its open lines (none yet for a new master) — kept for symmetry
      await tickIfApproved(qc, p.id, req.user.name);
      return { status: 200, product: p, fluence_kit_id: kitId };
    });
    if (out.error) return res.status(out.status).json({ error: out.error });
    res.json(out);
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
      // an approval mail for something that is not artwork must not go (the Gmail draft is deleted by the next settle)
      if (toNotArtwork) await cancelDraftsOf(qc, [v.id], `marked not artwork by ${req.user.name}`, req.user.name);
      return { status: 200 };
    });
    res.status(out.status).json(out.error ? { error: out.error } : { ok: true });
  } catch (e) { next(e); }
};
r.post('/artwork/register/versions/:id/not-artwork', setStatus(true));
r.post('/artwork/register/versions/:id/restore', setStatus(false));

export default r;
