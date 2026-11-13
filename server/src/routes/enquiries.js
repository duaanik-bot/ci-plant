// Enquiry desk — customer enquiries from the mailbox, pushed into Costing, priced by a person, quoted and
// answered in the customer's own thread (docs/superpowers/specs/2026-11-03-enquiry-desk-design.md).
// Under the Costing tick (it shows prices); Finalise and Mark as sent need the Management right; Settings, an admin.
// CI Plant never sends a mail (owner, 3 Nov 2026): a reply is only ever saved as a Gmail draft in the customer's
// thread, and a person checks it and sends it from Gmail.
// The mailbox itself is read and written by Claude — the enquiry-desk skill, run by the Claude that has the
// mailbox's Gmail — through the robot routes (routes/enquiry-robot.js). CI Plant only queues the job and waits: it
// never starts the AVS cloud routine, which by AVS's own mailbox rule never reads dua.anik@gmail.com and reads
// mppchd@gmail.com only in Chrome on the office computer (owner's rule, 30 Sep 2026).
//
//   GET  /costing/enquiry-desk                 mailboxes, settings, rights, counts, the latest jobs
//   PUT  /costing/enquiry-desk/settings        mailbox in use, who a mailbox replies to, terms, words (admin)
//   POST /costing/enquiry-desk/fetch           queue a Fetch for the mailbox in use and start Claude
//   GET  /costing/enquiry-jobs/:id · POST /costing/enquiry-jobs/:id/cancel
//   GET  /costing/enquiries?stage=&search=     the desk's rows     GET /costing/enquiries/:id  one, with its mail and history
//   POST /costing/enquiries                    one typed in by hand        PUT /costing/enquiries/:id  its details
//   POST /costing/enquiries/ready              Inbox → Costing ("Send to costing")
//   POST /costing/enquiries/to-price           Costing → Final price, for a row whose costing is complete
//   POST /costing/enquiries/back               one tab back: Costing → Inbox, Final price → Costing, Quotations → Final price
//   POST /costing/enquiries/drop · /restore    (Bring back: to where it was dropped from)    /push (old links)
//   POST /costing/enquiries/undo               undo one press (its group), only on rows nothing has changed since
//   PUT  /costing/enquiries/prices             final prices        POST /costing/enquiries/finalise · /reopen
//   PUT  /costing/enquiries/counter            the customer's counter-offer → the Counter tab; Send quotation then makes
//                                              the REVISED quotation (same party, the counter mail's thread), the old one superseded
// Every change on the desk is kept with what the rows were before it (enquiry_events.detail.undo), and the
// answer carries its undo group. A costing saved for an enquiry — on the desk or anywhere else — moves it
// on in the costing's own transaction (linkEnquiry, called by routes/costing.js).
//   POST /costing/quotations                   one quotation per customer from Quotation-ready enquiries
//   GET  /costing/quotations · GET /costing/quotations/:id · PUT /costing/quotations/:id · GET /costing/quotations/:id/pdf
//   POST /costing/quotations/:id/draft (a Gmail draft, never a send) · /mark-sent · /cancel
//   POST /costing/enquiry-desk/gmail/:key/connect · DELETE /costing/enquiry-desk/gmail/:key   (admin)
//   POST /costing/enquiries/order-preview      the Order finalised panel: each line pre-filled (or with the person's edits)
//   POST /costing/enquiries/order              Order finalised (Management): the order kept, rows → 'ordered', the order
//                                              sheet sent to the COMPANY mailbox (the one send — gmail.js sendToCompany)
//   GET  /costing/enquiry-orders · POST /costing/enquiry-orders/:id/mail (Management: Send again)
// A mailbox whose Gmail is connected (gmail_links, server/src/gmail.js) gets its draft from the SERVER, in the same
// press — no robot. Not connected: the robot job, as before. Opening the desk notices drafts sent from Gmail.
//
// The plant-wide audit log (read by every login) gets numbers and actions only; prices and addresses go
// to enquiry_events, read here only.
import { Router } from 'express';
import crypto from 'node:crypto';
import { q, one, tx } from '../db.js';
import { audit, nextNumber, lockDocNumber } from '../helpers.js';
import { mayCost, mayApproveCosting } from '../costing-match.js';
import {
  STAGE_SQL, STATUS_LABEL, stageOf, cleanItem, priceRows, quotationLines, groupByCustomer,
  composeReply, replySubject, replyRecipient, BACK_TO, broughtBack, UNDO_COLS,
} from '../enquiry-desk.js';
import { quotationPdf } from '../quotation-pdf.js';
import { num } from '../costing-engine.js';
import {
  gmailConfigured, consentUrl, accessToken, forgetToken, replyHeaders, buildMime, rawOf, saveDraft, draftSent, openToken, revoke, replyAll,
  sendToCompany,
} from '../gmail.js';
import { orderLine, orderTotals, orderMail } from '../order-finalise.js';
import { kldPdf } from '../kld-pdf.js';
import { redirectUri, signState } from './gmail-link.js';
import { startFetch, cloudLink, cloudView, saveCloudLink } from '../enquiry-cloud.js';

const r = Router();
const fail = (status, error, extra = {}) => Object.assign(new Error(error), { status, body: extra });
const intOrNull = v => (Number.isInteger(+v) && +v > 0 ? +v : null);
const ids = body => [...new Set((Array.isArray(body?.ids) ? body.ids : []).map(intOrNull).filter(Boolean))].slice(0, 200);
const text = (v, max = 300) => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max) : null; };

// The Costing tick, read fresh (the costing router does the same for its own routes).
const loginOf = id => one('SELECT id, name, role, active, modules, is_management FROM users WHERE id = $1 AND active = 1', [id]);
r.use(['/costing/enquiry-desk', '/costing/enquiries', '/costing/enquiry-jobs', '/costing/quotations', '/costing/enquiry-orders'], async (req, res, next) => {
  try {
    const u = req.costingUser || await loginOf(req.user?.id);
    if (!mayCost(u)) return res.status(403).json({ error: 'Costing is not ticked for this login — ask an admin to tick it in Masters → Users.', code: 'COSTING_REFUSED' });
    req.costingUser = u;
    next();
  } catch (e) { next(e); }
});
const needMgmt = u => { if (!mayApproveCosting(u)) throw fail(403, 'This needs the Management right.'); };
const needAdmin = u => { if (u.role !== 'admin') throw fail(403, 'Only an admin changes the enquiry desk settings.'); };

export async function enquiryEvent(qc, { enquiryId = null, quotationId = null, action, detail = null }, user) {
  await qc(`INSERT INTO enquiry_events (enquiry_id, quotation_id, action, detail, by_name) VALUES ($1, $2, $3, $4, $5)`,
    [enquiryId, quotationId, action, detail, user?.name || null]);
}

// ── every change is kept, so it can be undone ────────────────────────────────────────────────────
// One press is one group. Each row's event keeps the row's desk columns as they were and the moment it
// was changed; Undo puts the row back exactly as it was, but only when nothing has changed it since — a
// later change is never overwritten. An undo is itself a change, so it can be undone too (redo).
export const newGroup = () => crypto.randomUUID();
const GROUP_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const pickUndo = snap => Object.fromEntries(UNDO_COLS.map(k => [k, snap?.[k] ?? null]));
const UNDO_SET = UNDO_COLS.map(k => `${k} = r.${k}`).join(', ');

// Change one locked row (`cur` carries `snap`, its row as it was) and keep the change for Undo. `set` is
// SQL assignments numbered from $3; `args` fill them.
async function changeRow(qc, cur, set, args, user, { action, group, detail = null, logged = true }) {
  const [row] = await qc(`UPDATE enquiries SET ${set}, updated_at = now(), updated_by_name = $2 WHERE id = $1
                          RETURNING id, enquiry_no, status, updated_at::text AS stamp`, [cur.id, user.name, ...args]);
  await enquiryEvent(qc, { enquiryId: cur.id, action, detail: { ...(detail || {}), undo: { group, before: pickUndo(cur.snap), after: row.stamp } } }, user);
  if (logged) await audit('enquiry', cur.id, action, cur.enquiry_no, qc, user.name);
  return row;
}

// The ticked rows, locked in id order, each with its stage read against its costing.
export async function lockRows(qc, list) {
  if (!list.length) return [];
  const rows = await qc(`
    SELECT e.id, e.enquiry_no, e.status, e.costing_id, e.batch_id, e.quotation_id, e.final_prices, e.counter, e.counter_round,
           e.quantities::float8[] AS quantities, to_jsonb(e) AS snap,
           c.id AS c_id, c.complete AS c_complete, c.archived AS c_archived, c.inputs AS costing_inputs, c.costing_no,
           qt.status AS quotation_status, qt.quotation_no
      FROM enquiries e LEFT JOIN costings c ON c.id = e.costing_id LEFT JOIN quotations qt ON qt.id = e.quotation_id
     WHERE e.id = ANY($1::int[]) ORDER BY e.id FOR UPDATE OF e`, [list]);
  return rows.map(e => {
    const live = !!e.c_id && !e.c_archived;
    const complete = live && !!e.c_complete;
    return { ...e, live, complete, stage: stageOf(e.status, complete, live) };
  });
}
const stageText = stage => (STATUS_LABEL[stage] || stage).toLowerCase();

// A move on ticked rows. `decide(row)` answers { set, args, to } for a row that can move, or { why } for one
// that cannot: those are listed with the reason, never forced. One press = one undo group.
async function moveRows(list, user, action, decide) {
  const group = newGroup();
  const out = await tx(async (qc) => {
    const moved = [], skipped = [];
    const locked = await lockRows(qc, list);
    for (const cur of locked) {
      const d = await decide(cur, qc);
      if (!d?.set) { skipped.push({ id: cur.id, enquiry_no: cur.enquiry_no, why: d?.why || 'cannot move from here' }); continue; }
      const row = await changeRow(qc, cur, d.set, d.args || [], user, { action, group, detail: d.detail ?? null });
      moved.push({ id: row.id, enquiry_no: row.enquiry_no, to: d.to || row.status });
    }
    for (const id of list) if (!locked.some(e => e.id === id)) skipped.push({ id, enquiry_no: `#${id}`, why: 'was not found' });
    return { moved, skipped };
  });
  return { ...out, undo: out.moved.length ? group : null };
}

// A costing saved for an enquiry — from the desk, New costing or a bulk costing — is linked to it here, in
// the costing's own transaction (routes/costing.js), and the enquiry moves on: to Costing, and on to Final
// price once the costing is complete. A finalised, quoted, sent or dropped enquiry keeps the costing it has.
// Nothing is written when nothing changes (a revision of the same costing). Returns { group, id, enquiry_no }
// when the enquiry changed, so the desk can offer to undo it.
export async function linkEnquiry(qc, enquiryId, costing, batchId, user, group = null) {
  const id = intOrNull(enquiryId);
  if (!id) return null;
  const [cur] = await qc(`SELECT e.id, e.enquiry_no, e.status, e.costing_id, e.batch_id, to_jsonb(e) AS snap FROM enquiries e WHERE e.id = $1 FOR UPDATE`, [id]);
  if (!cur || ['quote_ready', 'sent', 'dropped'].includes(cur.status)) return null;
  // The batch is the costing's own (a single costing has none), so the enquiry always opens the right screen.
  const [own] = await qc('SELECT batch_id FROM costings WHERE id = $1', [costing.id]);
  const batch = own?.batch_id ?? batchId ?? null;
  const status = ['new', 'ready', 'costing'].includes(cur.status) ? 'costing' : cur.status;
  if (cur.costing_id === costing.id && cur.status === status && (cur.batch_id ?? null) === batch) return null;
  const replaced = cur.costing_id && cur.costing_id !== costing.id
    ? (await qc('SELECT costing_no FROM costings WHERE id = $1', [cur.costing_id]))[0]?.costing_no || null : null;
  const g = group || newGroup();
  await changeRow(qc, cur, 'costing_id = $3, batch_id = $4, status = $5', [costing.id, batch, status], user,
    { action: 'costing', group: g, detail: { costing_no: costing.costing_no, ...(replaced ? { replaced } : {}) }, logged: false });
  return { group: g, id, enquiry_no: cur.enquiry_no };
}

// A row taken out of a bulk costing: its enquiry loses that costing and waits in Costing again
// (final prices kept). Returns how many enquiries changed.
export async function unlinkCosting(qc, costingId, user, group, why) {
  const rows = await qc(`SELECT e.id, e.enquiry_no, e.status, to_jsonb(e) AS snap FROM enquiries e
                          WHERE e.costing_id = $1 AND e.status IN ('new', 'ready', 'costing', 'price_pending') ORDER BY e.id FOR UPDATE`, [costingId]);
  for (const cur of rows) {
    const to = ['costing', 'price_pending'].includes(cur.status) ? 'ready' : cur.status;
    await changeRow(qc, cur, 'costing_id = NULL, batch_id = NULL, status = $3', [to], user, { action: 'unlink', group, detail: { why }, logged: false });
  }
  return rows.length;
}

// ── the desk ─────────────────────────────────────────────────────────────────────────────────────
const MAILBOX_COLS = `key, email, label, send_to, in_use`;
const mailboxes = () => q(`SELECT ${MAILBOX_COLS} FROM enquiry_mailboxes ORDER BY key DESC`);
const inUse = async () => (await one(`SELECT ${MAILBOX_COLS} FROM enquiry_mailboxes WHERE in_use`)) || null;
const settings = () => one('SELECT terms, opening, closing, fetch_days FROM enquiry_settings WHERE id = 1');

// The cloud start as the desk shows it — never the pass (brief.pass_sha256 stays on the server).
const JOB_COLS = `j.id, j.kind, j.mailbox, j.mailbox_email, j.quotation_id, j.status, j.error, j.result, j.fire_status,
  j.queued_by_name, j.claimed_by, j.queued_at, j.claimed_at, j.finished_at,
  j.brief->>'fired_at' AS fired_at, j.brief->>'session_url' AS session_url, j.brief->>'fire_error' AS fire_error`;

// A mailbox's Gmail link as the desk shows it (never the token).
const linkOf = key => one('SELECT * FROM gmail_links WHERE mailbox = $1', [key]);
const LINK_VIEW = `mailbox, email, connected_at, connected_by_name, last_used_at, last_error, last_error_at`;

// Drafts the person has since sent from Gmail → Sent. At most once a minute per server, a few seconds at most, and
// never in the way of the desk: any trouble is only noted on the link.
let sentCheckedAt = 0;
export async function syncSentDrafts() {
  const every = process.env.GMAIL_SENT_CHECK_MS != null ? Number(process.env.GMAIL_SENT_CHECK_MS) : 60_000; // the test sets 0
  if (!gmailConfigured() || Date.now() - sentCheckedAt < every) return;
  sentCheckedAt = Date.now();
  const who = { name: 'Sent from Gmail' };
  for (const link of await q('SELECT * FROM gmail_links ORDER BY mailbox')) {
    try {
      const rows = await q(`SELECT qt.id, qt.gmail_draft_id, j.finished_at, COALESCE(j.result->>'thread_id', m.gmail_thread_id) AS thread_id
                              FROM quotations qt LEFT JOIN enquiry_jobs j ON j.id = qt.job_id LEFT JOIN enquiry_mails m ON m.id = qt.reply_mail_id
                             WHERE qt.status = 'drafted' AND qt.mailbox = $1 AND qt.gmail_draft_id IS NOT NULL ORDER BY qt.id DESC LIMIT 25`, [link.mailbox]);
      if (!rows.length) continue;
      const token = await accessToken(link);
      for (const r0 of rows) {
        const s = await draftSent(token, { draftId: r0.gmail_draft_id, threadId: r0.thread_id, since: r0.finished_at });
        if (!s.sent) continue;
        await tx(async (qc, oc) => {
          const qt = await oc(`UPDATE quotations SET status = 'sent', sent_to = contact_email, sent_at = $2, sent_by_name = 'Sent from Gmail', updated_at = now()
                                WHERE id = $1 AND status = 'drafted' RETURNING id, quotation_no`, [r0.id, s.at]);
          if (!qt) return;
          await markEnquiriesSent(qc, qt.id, who);
          await enquiryEvent(qc, { quotationId: qt.id, action: 'sent_from_gmail', detail: { by: 'server' } }, who);
          await audit('quotation', qt.id, 'sent', `${qt.quotation_no} — sent from Gmail`, qc, who.name);
        });
      }
      await q('UPDATE gmail_links SET sent_checked_at = now() WHERE mailbox = $1', [link.mailbox]);
    } catch (e) {
      if (e.expired) forgetToken(link.mailbox);
      await q('UPDATE gmail_links SET last_error = $2, last_error_at = now() WHERE mailbox = $1', [link.mailbox, String(e.message).slice(0, 500)]).catch(() => {});
    }
  }
}
const withinSeconds = (p, s) => Promise.race([p, new Promise(res => setTimeout(res, s * 1000))]);

r.get('/costing/enquiry-desk', async (req, res, next) => {
  try {
    await withinSeconds(syncSentDrafts().catch(e => console.error('[gmail] sent check:', e.message)), 6);
    const [boxes, s, counts, jobs, links, cloud] = await Promise.all([
      mailboxes(), settings(),
      q(`SELECT ${STAGE_SQL} AS stage, count(*)::int AS n FROM enquiries e LEFT JOIN costings c ON c.id = e.costing_id GROUP BY 1`),
      q(`SELECT ${JOB_COLS} FROM enquiry_jobs j ORDER BY j.id DESC LIMIT 10`),
      q(`SELECT ${LINK_VIEW} FROM gmail_links`),
      cloudLink(),
    ]);
    for (const b of boxes) b.gmail = links.find(l => l.mailbox === b.key) || null;
    const quotes = await q(`SELECT status, count(*)::int AS n FROM quotations GROUP BY status`);
    res.json({
      mailboxes: boxes, in_use: boxes.find(b => b.in_use) || null, settings: s,
      counts: Object.fromEntries(counts.map(x => [x.stage, x.n])),
      quotation_counts: Object.fromEntries(quotes.map(x => [x.status, x.n])),
      jobs,
      can_finalise: mayApproveCosting(req.costingUser), can_admin: req.costingUser.role === 'admin',
      statuses: STATUS_LABEL, gmail_ready: gmailConfigured(),
      // Claude in the cloud: Fetch and the 11 am / 3 pm timer start it (enquiry-cloud.js).
      cloud: cloudView(cloud, req.costingUser.role === 'admin'),
    });
  } catch (e) { next(e); }
});

// Connect a mailbox's Gmail: Google's consent page (the browser goes there), back at /api/gmail/callback.
r.post('/costing/enquiry-desk/gmail/:key/connect', async (req, res, next) => {
  try {
    const u = req.costingUser;
    needAdmin(u);
    const box = await one(`SELECT ${MAILBOX_COLS} FROM enquiry_mailboxes WHERE key = $1`, [req.params.key]);
    if (!box) throw fail(404, 'No such mailbox.');
    if (!gmailConfigured()) throw fail(503, 'Gmail is not set up on the server yet.');
    res.json({ url: consentUrl({ redirectUri: redirectUri(req), state: signState(box.key, u.id), loginHint: box.email }) });
  } catch (e) { next(e); }
});

r.delete('/costing/enquiry-desk/gmail/:key', async (req, res, next) => {
  try {
    const u = req.costingUser;
    needAdmin(u);
    const gone = await one('DELETE FROM gmail_links WHERE mailbox = $1 RETURNING mailbox, refresh_token_enc', [req.params.key]);
    if (gone) {
      forgetToken(gone.mailbox);
      try { if (gmailConfigured()) await revoke(openToken(gone.refresh_token_enc)); } catch { /* the row is gone either way */ }
      await audit('enquiry_desk', 1, 'gmail_disconnect', `Gmail disconnected for the ${gone.mailbox} mailbox`, q, u.name);
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

r.put('/costing/enquiry-desk/settings', async (req, res, next) => {
  try {
    const u = req.costingUser;
    needAdmin(u);
    const b = req.body || {};
    await tx(async (qc) => {
      for (const box of Array.isArray(b.mailboxes) ? b.mailboxes : []) {
        if (!['trial', 'business'].includes(box?.key)) continue;
        const email = text(box.email, 200)?.toLowerCase();
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail(400, `The ${box.key} mailbox needs an e-mail address.`);
        const sendTo = box.send_to === 'customers' ? 'customers' : 'own';
        await qc(`UPDATE enquiry_mailboxes SET email = $2, send_to = $3, updated_at = now(), updated_by_name = $4 WHERE key = $1`,
          [box.key, email, sendTo, u.name]);
      }
      if (['trial', 'business'].includes(b.in_use)) {
        await qc(`UPDATE enquiry_mailboxes SET in_use = false WHERE in_use AND key <> $1`, [b.in_use]);
        await qc(`UPDATE enquiry_mailboxes SET in_use = true, updated_at = now(), updated_by_name = $2 WHERE key = $1`, [b.in_use, u.name]);
      }
      if (b.settings) {
        const days = intOrNull(b.settings.fetch_days);
        await qc(`UPDATE enquiry_settings SET terms = COALESCE($1, terms), opening = COALESCE($2, opening), closing = COALESCE($3, closing),
                         fetch_days = COALESCE($4, fetch_days), updated_at = now(), updated_by_name = $5 WHERE id = 1`,
        [text(b.settings.terms, 2000), text(b.settings.opening, 2000), text(b.settings.closing, 2000), days && Math.min(days, 60), u.name]);
      }
      await audit('enquiry_desk', 1, 'settings', 'Enquiry desk settings changed', qc, u.name);
    });
    res.json({ mailboxes: await mailboxes(), settings: await settings() });
  } catch (e) { next(e); }
});

// ── jobs: what Claude is asked to do ─────────────────────────────────────────────────────────────
// A job waits for the enquiry desk robot — Claude with this mailbox's Gmail — to claim it with the robot key.
const jobById = id => one(`SELECT ${JOB_COLS} FROM enquiry_jobs j WHERE j.id = $1`, [id]);

// Fetch: one open fetch per mailbox (pressing again while Claude has it does not queue a second), and Claude is started
// in the cloud at once when the desk is linked — a fetch still waiting is started again (enquiry-cloud.js startFetch).
r.post('/costing/enquiry-desk/fetch', async (req, res, next) => {
  try {
    const u = req.costingUser;
    const out = await startFetch({ user: u, by: u.name });
    if (out.error) throw fail(out.status || 409, out.error);
    res.status(out.already ? 200 : 201).json({ job: await jobById(out.job.id), already: out.already, cloud: out.cloud });
  } catch (e) { next(e); }
});

// Claude in the cloud (admin): the desk routine's API URL and token, as claude.ai shows them once. An empty token keeps
// the one saved; the token never comes back.
r.put('/costing/enquiry-desk/cloud', async (req, res, next) => {
  try {
    const u = req.costingUser;
    needAdmin(u);
    const out = await saveCloudLink({ fire_url: req.body?.fire_url, token: req.body?.token }, u);
    if (out.problem) throw fail(400, out.problem);
    await audit('enquiry_desk', 1, 'cloud_link', 'Claude in the cloud linked to the enquiry desk', q, u.name);
    res.json({ cloud: cloudView(out.cfg, true) });
  } catch (e) { next(e); }
});

r.get('/costing/enquiry-jobs/:id', async (req, res, next) => {
  try {
    const job = await jobById(intOrNull(req.params.id) || 0);
    if (!job) throw fail(404, 'No such job.');
    res.json(job);
  } catch (e) { next(e); }
});

r.post('/costing/enquiry-jobs/:id/cancel', async (req, res, next) => {
  try {
    const u = req.costingUser;
    const id = intOrNull(req.params.id) || 0;
    await tx(async (qc, oc) => {
      const job = await oc(`UPDATE enquiry_jobs SET status = 'cancelled', finished_at = now(), error = $2
                             WHERE id = $1 AND status = 'queued' RETURNING id, kind, quotation_id`, [id, `Cancelled by ${u.name}`]);
      if (!job) throw fail(409, 'Only a job Claude has not started can be cancelled.');
      if (job.quotation_id) {
        await qc(`UPDATE quotations SET status = CASE WHEN gmail_draft_id IS NOT NULL THEN 'drafted' ELSE 'ready' END, updated_at = now()
                   WHERE id = $1 AND status = 'queued' AND job_id = $2`, [job.quotation_id, id]);
      }
    });
    res.json(await jobById(id));
  } catch (e) { next(e); }
});

// ── enquiries ────────────────────────────────────────────────────────────────────────────────────
const ENQ_COLS = `
  e.id, e.enquiry_no, e.mail_id, e.mailbox, e.customer_id, e.customer_name, e.contact_name, e.contact_email,
  e.product_id, e.product_name, e.size_text, e.size_key, e.style, e.board, e.gsm::float8 AS gsm, e.colours::float8 AS colours,
  e.coating, e.specs, e.quantities::float8[] AS quantities, e.target_price::float8 AS target_price, e.notes, e.status,
  ${STAGE_SQL} AS stage, e.dropped_reason, e.costing_id, e.batch_id, e.final_prices, e.finalised_by_name, e.finalised_at,
  e.quotation_id, e.source, e.created_by_name, e.created_at, e.updated_by_name, e.updated_at,
  c.costing_no, c.complete AS costing_complete, c.status AS costing_status, c.inputs AS costing_inputs,
  c.archived AS costing_archived, c.version AS costing_version, c.batch_id AS costing_batch_id, c.approved_by_name AS costing_approved_by,
  c.qty::float8 AS costing_qty, c.quote_per_unit::float8 AS costing_quote, b.batch_no,
  m.subject AS mail_subject, m.from_name AS mail_from_name, m.from_email AS mail_from_email, m.received_at AS mail_received_at,
  m.view_url AS mail_view_url, jsonb_array_length(COALESCE(m.attachments, '[]')) AS mail_attachments,
  (SELECT count(*) FROM enquiries x WHERE x.mail_id = e.mail_id)::int AS mail_items,
  (SELECT count(*) FROM enquiries x WHERE x.mail_id = e.mail_id AND x.id <= e.id)::int AS mail_pos,
  qt.quotation_no, qt.status AS quotation_status, qt.gmail_draft_url AS quotation_draft_url, qt.revision AS quotation_revision,
  e.counter, e.counter_mail_id, e.counter_at, e.counter_by_name, e.counter_round,
  cm.subject AS counter_subject, cm.received_at AS counter_received_at, cm.view_url AS counter_view_url,
  e.order_id, eo.order_no, eo.mail_status AS order_mail_status`;
const ENQ_FROM = `enquiries e LEFT JOIN costings c ON c.id = e.costing_id LEFT JOIN costing_batches b ON b.id = c.batch_id
                  LEFT JOIN enquiry_mails m ON m.id = e.mail_id LEFT JOIN quotations qt ON qt.id = e.quotation_id
                  LEFT JOIN enquiry_mails cm ON cm.id = e.counter_mail_id LEFT JOIN enquiry_orders eo ON eo.id = e.order_id`;
// A row as the desk shows it: the proposals are worked out here; the costing's inputs stay on the server.
// A hidden costing counts as none (the row waits in Costing until it is costed again or the costing is shown).
const present = row => {
  const { costing_inputs, costing_archived, ...e } = row;
  const live = !!e.costing_no && !costing_archived;
  const complete = live && !!e.costing_complete;
  return {
    ...e, costing_live: live, costing_hidden: !!e.costing_no && !!costing_archived, costing_complete: complete,
    stage: stageOf(e.status, complete, live), prices: priceRows(e, complete ? costing_inputs : null),
  };
};

r.get('/costing/enquiries', async (req, res, next) => {
  try {
    const where = [], args = [];
    const add = (sql, v) => { args.push(v); where.push(sql.replace('?', `$${args.length}`)); };
    const stages = String(req.query.stage || '').split(',').filter(s => STATUS_LABEL[s]);
    if (stages.length) add(`${STAGE_SQL} = ANY(?::text[])`, stages);
    const only = String(req.query.ids || '').split(',').map(intOrNull).filter(Boolean).slice(0, 200);
    if (only.length) add('e.id = ANY(?::int[])', only);
    const s = text(req.query.search, 80);
    if (s) {
      args.push(`%${s}%`);
      const p = `$${args.length}`;
      where.push(`(e.enquiry_no ILIKE ${p} OR e.product_name ILIKE ${p} OR e.customer_name ILIKE ${p} OR e.contact_email ILIKE ${p}
                   OR e.size_text ILIKE ${p} OR m.subject ILIKE ${p} OR qt.quotation_no ILIKE ${p})`);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '')) add(`COALESCE(m.received_at, e.created_at) >= ?::date`, req.query.from);
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')) add(`COALESCE(m.received_at, e.created_at) < (?::date + 1)`, req.query.to);
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = await q(`SELECT ${ENQ_COLS} FROM ${ENQ_FROM} ${w}
                          ORDER BY COALESCE(m.received_at, e.created_at) DESC, e.id DESC LIMIT 500`, args);
    res.json(rows.map(present));
  } catch (e) { next(e); }
});

async function enquiryById(id) {
  const row = await one(`SELECT ${ENQ_COLS} FROM ${ENQ_FROM} WHERE e.id = $1`, [id]);
  if (!row) return null;
  const e = present(row);
  e.mail = e.mail_id ? await one(`SELECT id, mailbox, mailbox_email, gmail_message_id, gmail_thread_id, subject, from_name, from_email, to_text,
                                         received_at, body_text, attachments, view_url, summary FROM enquiry_mails WHERE id = $1`, [e.mail_id]) : null;
  e.siblings = e.mail_id ? await q(`SELECT id, enquiry_no, product_name, size_text, status FROM enquiries WHERE mail_id = $1 AND id <> $2 ORDER BY id`, [e.mail_id, id]) : [];
  // History: what was before each change stays on the server; a change can be undone while it is the
  // row's latest one.
  e.events = await q(`SELECT ev.id, ev.action, ev.detail - 'undo' AS detail, ev.by_name, ev.at, ev.detail->'undo'->>'group' AS undo_group,
                             COALESCE((ev.detail->'undo'->>'after')::timestamptz = x.updated_at, false) AS undoable
                        FROM enquiry_events ev JOIN enquiries x ON x.id = ev.enquiry_id
                       WHERE ev.enquiry_id = $1 ORDER BY ev.id DESC LIMIT 100`, [id]);
  return e;
}

r.get('/costing/enquiries/:id(\\d+)', async (req, res, next) => {
  try {
    const e = await enquiryById(intOrNull(req.params.id) || 0);
    if (!e) throw fail(404, 'No such enquiry.');
    res.json(e);
  } catch (e) { next(e); }
});

// The customer: the sender's address remembered against a master, else a master of exactly this name.
export async function resolveCustomer(oc, { customer_id, customer_name, contact_email }) {
  if (intOrNull(customer_id)) {
    const c = await oc('SELECT id, name FROM customers WHERE id = $1', [intOrNull(customer_id)]);
    if (c) return { customer_id: c.id, customer_name: c.name };
  }
  if (contact_email) {
    const known = await oc('SELECT customer_id, customer_name FROM enquiry_contacts WHERE email = $1', [contact_email]);
    if (known?.customer_id) return { customer_id: known.customer_id, customer_name: known.customer_name };
  }
  if (customer_name) {
    const c = await oc(`SELECT id, name FROM customers WHERE active = 1 AND lower(trim(name)) = lower(trim($1)) LIMIT 2`, [customer_name]);
    if (c) return { customer_id: c.id, customer_name: c.name };
  }
  return { customer_id: null, customer_name: customer_name || null };
}
// One active Product Master entry of exactly this name or code (two would be a guess).
export async function resolveProduct(qc, name, customerId) {
  if (!name) return null;
  const hits = await qc(`SELECT id FROM products WHERE active = 1 AND (lower(trim(name)) = lower(trim($1)) OR lower(code) = lower(trim($1)))
                          AND ($2::int IS NULL OR customer_id = $2 OR customer_id IS NULL) LIMIT 2`, [name, customerId ?? null]);
  return hits.length === 1 ? hits[0].id : null;
}

// An enquiry row, minted in the caller's transaction (the CI-ENQ- lock is taken first by the caller).
export async function insertEnquiry(qc, oc, item, who, user) {
  const no = await nextNumber('CI-ENQ-', 'enquiries', 'enquiry_no', oc);
  const productId = item.product_id || await resolveProduct(qc, item.product_name, who.customer_id);
  const row = await oc(`
    INSERT INTO enquiries (enquiry_no, mail_id, mailbox, customer_id, customer_name, contact_name, contact_email, product_id, product_name,
                           size_text, size_key, style, board, gsm, colours, coating, specs, quantities, target_price, notes, source,
                           created_by, created_by_name, updated_by_name)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $23)
    RETURNING id, enquiry_no`,
  [no, who.mail_id ?? null, who.mailbox ?? null, who.customer_id, who.customer_name, who.contact_name ?? null, who.contact_email ?? null,
    productId, item.product_name, item.size_text, item.size_key, item.style, item.board, item.gsm, item.colours, item.coating, item.specs,
    item.quantities, item.target_price, item.notes, who.source, user?.id ?? null, user?.name ?? who.by]);
  return row;
}

r.post('/costing/enquiries', async (req, res, next) => {
  try {
    const u = req.costingUser;
    const item = cleanItem(req.body);
    if (!item) throw fail(400, 'Give the product a name or a size.');
    const contactEmail = text(req.body?.contact_email, 200)?.toLowerCase() || null;
    const row = await tx(async (qc, oc) => {
      await lockDocNumber('CI-ENQ-', oc);
      const who = { ...(await resolveCustomer(oc, { customer_id: req.body?.customer_id, customer_name: text(req.body?.customer_name, 160), contact_email: contactEmail })),
        contact_name: text(req.body?.contact_name, 160), contact_email: contactEmail, source: 'person' };
      const made = await insertEnquiry(qc, oc, item, who, u);
      await enquiryEvent(qc, { enquiryId: made.id, action: 'added', detail: { by: 'hand' } }, u);
      await audit('enquiry', made.id, 'create', made.enquiry_no, qc, u.name);
      return made;
    });
    res.status(201).json(await enquiryById(row.id));
  } catch (e) { next(e); }
});

// Details: what was asked (a person corrects what the robot read). A finalised or quoted enquiry is
// reopened first, so a quotation never shows details it was not priced on.
r.put('/costing/enquiries/:id(\\d+)', async (req, res, next) => {
  try {
    const u = req.costingUser;
    const id = intOrNull(req.params.id) || 0;
    const item = cleanItem(req.body);
    if (!item) throw fail(400, 'Give the product a name or a size.');
    const contactEmail = text(req.body?.contact_email, 200)?.toLowerCase() || null;
    const group = newGroup();
    await tx(async (qc, oc) => {
      const [cur] = await lockRows(qc, [id]);
      if (!cur) throw fail(404, 'No such enquiry.');
      if (['quote_ready', 'sent'].includes(cur.status)) throw fail(409, `${cur.enquiry_no} is ${STATUS_LABEL[cur.status].toLowerCase()} — send it back to Final price before changing what was asked.`);
      const who = await resolveCustomer(oc, { customer_id: req.body?.customer_id, customer_name: text(req.body?.customer_name, 160), contact_email: contactEmail });
      // A quantity no longer asked about loses its final price.
      const finals = (cur.final_prices || []).filter(f => item.quantities.includes(Number(f.qty)));
      await changeRow(qc, cur, `customer_id = $3, customer_name = $4, contact_name = $5, contact_email = $6, product_id = $7, product_name = $8,
                       size_text = $9, size_key = $10, style = $11, board = $12, gsm = $13, colours = $14, coating = $15, specs = $16,
                       quantities = $17, target_price = $18, notes = $19, final_prices = $20`,
      [who.customer_id, who.customer_name, text(req.body?.contact_name, 160), contactEmail,
        intOrNull(req.body?.product_id) || await resolveProduct(qc, item.product_name, who.customer_id), item.product_name,
        item.size_text, item.size_key, item.style, item.board, item.gsm, item.colours, item.coating, item.specs, item.quantities,
        item.target_price, item.notes, JSON.stringify(finals)], u, { action: 'details', group, logged: false });
      // The address is remembered against the customer master for the next mail from it.
      if (contactEmail && who.customer_id) {
        await qc(`INSERT INTO enquiry_contacts (email, customer_id, customer_name) VALUES ($1, $2, $3)
                  ON CONFLICT (email) DO UPDATE SET customer_id = EXCLUDED.customer_id, customer_name = EXCLUDED.customer_name, updated_at = now()`,
        [contactEmail, who.customer_id, who.customer_name]);
      }
    });
    res.json({ ...(await enquiryById(id)), undo: group });
  } catch (e) { next(e); }
});

// ── moves ────────────────────────────────────────────────────────────────────────────────────────
// Each ticked row is checked on its own: a row that cannot move is listed with the reason, never forced.
const DROPPABLE = ['new', 'ready', 'costing', 'costed', 'price_pending'];
const FINALISED_OFF = 'finalised_by = NULL, finalised_by_name = NULL, finalised_at = NULL';

// Inbox → Costing.
r.post('/costing/enquiries/ready', async (req, res, next) => {
  try {
    res.json(await moveRows(ids(req.body), req.costingUser, 'ready', e => (e.stage === 'new'
      ? { set: "status = 'ready'", to: 'ready' } : { why: `is ${stageText(e.stage)}` })));
  } catch (e) { next(e); }
});

// Costing → Final price, for a row whose costing is complete (a costing saved for it moves it by itself).
r.post('/costing/enquiries/to-price', async (req, res, next) => {
  try {
    res.json(await moveRows(ids(req.body), req.costingUser, 'to_price', (e) => {
      if (!['ready', 'costing'].includes(e.stage)) return { why: `is ${stageText(e.stage)}` };
      if (!e.complete) return { why: e.live ? `its costing ${e.costing_no} is not finished` : 'has no costing yet' };
      return { set: "status = 'costing'", to: 'costed' };
    }));
  } catch (e) { next(e); }
});

// Send back, one tab to the left. The costing and any final prices stay with the row.
r.post('/costing/enquiries/back', async (req, res, next) => {
  try {
    res.json(await moveRows(ids(req.body), req.costingUser, 'back', (e) => {
      const to = BACK_TO[e.stage];
      if (!to) return { why: e.stage === 'new' ? 'is in the Inbox already' : `is ${stageText(e.stage)}` };
      if (e.stage === 'quote_ready' && e.quotation_id && e.quotation_status !== 'cancelled') {
        return { why: `is on quotation ${e.quotation_no} — cancel that quotation first` };
      }
      return { set: `status = $3${to === 'price_pending' ? `, ${FINALISED_OFF}` : ''}`, args: [to], to, detail: { from: e.stage, to } };
    }));
  } catch (e) { next(e); }
});

r.post('/costing/enquiries/drop', async (req, res, next) => {
  try {
    const reason = text(req.body?.reason, 300) || 'Not to be quoted';
    res.json(await moveRows(ids(req.body), req.costingUser, 'drop', e => (DROPPABLE.includes(e.stage)
      ? { set: "status = 'dropped', dropped_reason = $3", args: [reason], to: 'dropped', detail: { reason } }
      : { why: `is ${stageText(e.stage)}` })));
  } catch (e) { next(e); }
});

// Bring back: to where the row was when it was dropped.
r.post('/costing/enquiries/restore', async (req, res, next) => {
  try {
    res.json(await moveRows(ids(req.body), req.costingUser, 'restore', async (e, qc) => {
      if (e.status !== 'dropped') return { why: 'is not dropped' };
      const [ev] = await qc(`SELECT detail->'undo'->'before'->>'status' AS was FROM enquiry_events
                              WHERE enquiry_id = $1 AND action = 'drop' ORDER BY id DESC LIMIT 1`, [e.id]);
      const to = broughtBack(ev?.was, e.costing_id);
      return { set: 'status = $3, dropped_reason = NULL', args: [to], to };
    }));
  } catch (e) { next(e); }
});

// Old screens' "Push to costing" (the desk now costs in place): marks the rows as in costing. A row with no
// costing saved still reads "Ready for costing", so nothing is stranded.
r.post('/costing/enquiries/push', async (req, res, next) => {
  try {
    const list = ids(req.body);
    if (!list.length) throw fail(400, 'Tick the enquiries to push to costing.');
    const out = await moveRows(list, req.costingUser, 'push', e => (['new', 'ready', 'costing'].includes(e.stage)
      ? { set: "status = 'costing'" } : { why: `is ${stageText(e.stage)}` }));
    const rows = out.moved.length ? await q(`SELECT ${ENQ_COLS} FROM ${ENQ_FROM} WHERE e.id = ANY($1::int[]) ORDER BY e.id`, [out.moved.map(m => m.id)]) : [];
    res.json({ rows: rows.map(present), skipped: out.skipped, undo: out.undo });
  } catch (e) { next(e); }
});

// Undo one press: every row of its group goes back to exactly how it was before, if nothing has changed
// it since (that row is listed, not forced). `ids` undoes only those rows of the group. The answer's
// `undo` is the group that redoes it.
r.post('/costing/enquiries/undo', async (req, res, next) => {
  try {
    const u = req.costingUser;
    const group = String(req.body?.group || '');
    if (!GROUP_RE.test(group)) throw fail(400, 'Nothing to undo.');
    const only = ids(req.body);
    const redo = newGroup();
    const out = await tx(async (qc) => {
      const evs = await qc(`SELECT DISTINCT ON (enquiry_id) id, enquiry_id, action, detail->'undo' AS undo FROM enquiry_events
                             WHERE enquiry_id IS NOT NULL AND detail->'undo'->>'group' = $1 ORDER BY enquiry_id, id DESC`, [group]);
      if (!evs.length) throw fail(404, 'Nothing to undo.');
      const list = evs.map(ev => ev.enquiry_id).filter(id => !only.length || only.includes(id));
      const moved = [], skipped = [];
      for (const cur of await lockRows(qc, list)) {
        const ev = evs.find(x => x.enquiry_id === cur.id);
        const [row] = await qc(`UPDATE enquiries e SET ${UNDO_SET}, updated_at = now(), updated_by_name = $3
                                  FROM jsonb_populate_record(NULL::enquiries, $2::jsonb) r
                                 WHERE e.id = $1 AND e.updated_at = $4::timestamptz
                             RETURNING e.id, e.enquiry_no, e.status, e.updated_at::text AS stamp`,
        [cur.id, JSON.stringify(ev.undo.before), u.name, ev.undo.after]);
        if (!row) { skipped.push({ id: cur.id, enquiry_no: cur.enquiry_no, why: 'was changed after that' }); continue; }
        await enquiryEvent(qc, { enquiryId: cur.id, action: 'undo',
          detail: { undid: ev.action, undo: { group: redo, before: pickUndo(cur.snap), after: row.stamp } } }, u);
        await audit('enquiry', cur.id, 'undo', cur.enquiry_no, qc, u.name);
        moved.push({ id: row.id, enquiry_no: row.enquiry_no, to: row.status, undid: ev.action });
      }
      return { moved, skipped };
    });
    res.json({ ...out, undo: out.moved.length ? redo : null });
  } catch (e) { next(e); }
});

// Final prices: [{ id, prices: [{ qty, final }] }]. Each is kept with the proposal it was set against.
r.put('/costing/enquiries/prices', async (req, res, next) => {
  try {
    const u = req.costingUser;
    const items = (Array.isArray(req.body?.items) ? req.body.items : []).slice(0, 200);
    const group = newGroup();
    const saved = [];
    await tx(async (qc) => {
      const locked = await lockRows(qc, [...new Set(items.map(it => intOrNull(it?.id)).filter(Boolean))]);
      for (const it of items) {
        const id = intOrNull(it?.id);
        if (!id) continue;
        const e = locked.find(x => x.id === id);
        if (!e) throw fail(404, 'No such enquiry.');
        if (!e.complete) throw fail(409, `${e.enquiry_no} has no complete costing yet — finish its costing first.`);
        // A row with the customer's counter is re-priced over its quotation: the revised one replaces it.
        if (e.quotation_id && e.quotation_status !== 'cancelled' && e.status !== 'countered') throw fail(409, `${e.enquiry_no} is on quotation ${e.quotation_no} — cancel that quotation before changing its price.`);
        if (['sent', 'dropped'].includes(e.status)) throw fail(409, `${e.enquiry_no} is ${STATUS_LABEL[e.status].toLowerCase()}.`);
        const rows = priceRows(e, e.costing_inputs);
        const kept = rows.map(row => {
          const given = (Array.isArray(it.prices) ? it.prices : []).find(p => Number(p?.qty) === row.qty);
          const final = given ? num(given.final) : row.final;
          if (given && !(final > 0)) throw fail(400, `${e.enquiry_no}: the final price for ${row.qty.toLocaleString('en-IN')} must be more than zero.`);
          const changedNow = given && final !== row.final;
          return final > 0 ? { qty: row.qty, final: Math.round(final * 1000) / 1000, proposed: changedNow ? row.proposed : (row.set_against ?? row.proposed) } : null;
        }).filter(Boolean);
        await changeRow(qc, e, `final_prices = $3, status = CASE WHEN status = 'countered' THEN 'countered' ELSE 'price_pending' END, ${FINALISED_OFF}`, [JSON.stringify(kept)], u,
          { action: 'price', group, detail: { prices: kept }, logged: false });
        saved.push(e.enquiry_no);
      }
    });
    res.json({ saved, undo: saved.length ? group : null });
  } catch (e) { next(e); }
});

// The customer's counter-offer (owner, 11 Nov 2026). For each quantity their price, kept beside our price it answered;
// the row goes to the Counter tab with its costing, prices and quotation kept — the revised price is set there and Send
// quotation makes the revised quotation. A counter can be corrected (same round) until the revised quotation is made.
// `prices`: [{ qty, theirs }] (a quantity left out keeps what it had). `mailId`: the mail it came in, when known.
const COUNTER_FROM = ['costed', 'price_pending', 'quote_ready', 'sent', 'countered'];
export async function recordCounter(qc, e, prices, { mailId = null, user, group, source = 'desk' }) {
  if (!COUNTER_FROM.includes(e.stage)) return { why: `is ${stageText(e.stage)} — a counter answers a priced or quoted row` };
  if (!e.complete) return { why: 'has no complete costing' };
  const rows = priceRows(e, e.costing_inputs);
  if (!rows.length) return { why: 'has no quantity' };
  const again = e.status === 'countered';
  const counter = rows.map(r => {
    const given = (Array.isArray(prices) ? prices : []).find(p => Number(p?.qty) === r.qty) || (rows.length === 1 && prices?.length === 1 ? prices[0] : null);
    const theirs = given && given.theirs !== '' && given.theirs != null ? num(given.theirs) : r.theirs;
    if (theirs != null && !(theirs > 0)) throw fail(400, `${e.enquiry_no}: the customer's price for ${r.qty.toLocaleString('en-IN')} must be more than zero.`);
    return { qty: r.qty, theirs: theirs != null ? Math.round(theirs * 10000) / 10000 : null, ours: again ? (r.ours ?? r.final) : r.final };
  });
  const round = again ? Math.max(1, Number(e.counter_round) || 0) : (Number(e.counter_round) || 0) + 1;
  await changeRow(qc, e, `status = 'countered', counter = $3, counter_mail_id = COALESCE($4, counter_mail_id), counter_at = now(),
                          counter_by_name = $5, counter_round = $6, ${FINALISED_OFF}`,
  [JSON.stringify(counter), mailId, user.name, round], user, { action: 'counter', group, detail: { counter, round, source, mail_id: mailId } });
  return { counter, round };
}

r.put('/costing/enquiries/counter', async (req, res, next) => {
  try {
    const u = req.costingUser;
    const items = (Array.isArray(req.body?.items) ? req.body.items : []).slice(0, 200);
    const mailId = intOrNull(req.body?.mail_id);
    const group = newGroup();
    const out = await tx(async (qc) => {
      const locked = await lockRows(qc, [...new Set(items.map(it => intOrNull(it?.id)).filter(Boolean))]);
      const saved = [], skipped = [];
      for (const it of items) {
        const e = locked.find(x => x.id === intOrNull(it?.id));
        if (!e) continue;
        const r0 = await recordCounter(qc, e, it.prices, { mailId: intOrNull(it.mail_id) || mailId, user: u, group });
        if (r0.why) skipped.push({ enquiry_no: e.enquiry_no, why: r0.why }); else saved.push(e.enquiry_no);
      }
      return { saved, skipped };
    });
    res.json({ ...out, undo: out.saved.length ? group : null });
  } catch (e) { next(e); }
});

// Finalise (Management right): every quantity has a final price, on a complete costing.
r.post('/costing/enquiries/finalise', async (req, res, next) => {
  try {
    const u = req.costingUser;
    needMgmt(u);
    const list = ids(req.body);
    const group = newGroup();
    const out = await tx(async (qc) => {
      const done = [], refused = [];
      for (const e of await lockRows(qc, list)) {
        const prices = priceRows(e, e.complete ? e.costing_inputs : null);
        const why = e.status !== 'price_pending' ? `is ${stageText(e.stage)}`
          : !e.complete ? 'has no complete costing'
            : !prices.length || prices.some(p => !(p.final > 0)) ? 'has a quantity without a final price' : null;
        if (why) { refused.push({ id: e.id, enquiry_no: e.enquiry_no, why }); continue; }
        await changeRow(qc, e, "status = 'quote_ready', finalised_by = $3, finalised_by_name = $4, finalised_at = now()", [u.id, u.name], u,
          { action: 'finalise', group, detail: { prices: prices.map(p => ({ qty: p.qty, final: p.final, proposed: p.proposed })) } });
        done.push(e.enquiry_no);
      }
      return { done, refused };
    });
    res.json({ ...out, undo: out.done.length ? group : null });
  } catch (e) { next(e); }
});

// Quotations → Final price (the same as Send back from the Quotations tab).
r.post('/costing/enquiries/reopen', async (req, res, next) => {
  try {
    res.json(await moveRows(ids(req.body), req.costingUser, 'reopen', (e) => {
      if (e.status !== 'quote_ready') return { why: `is ${stageText(e.stage)}` };
      if (e.quotation_id && e.quotation_status !== 'cancelled') return { why: `is on quotation ${e.quotation_no} — cancel that quotation first` };
      return { set: `status = 'price_pending', ${FINALISED_OFF}`, to: 'price_pending' };
    }));
  } catch (e) { next(e); }
});

// ── order finalised (owner, 12 Nov 2026) ─────────────────────────────────────────────────────────
// docs/superpowers/specs/2026-11-13-order-finalised-design.md. The button sits on a row with a complete costing, from Final
// price on; the panel pre-fills each line (orderLine) and the person edits quantity, rate and New die. Finalise
// (Management right) keeps ONE order for one customer — every line as finalised, with its margin or loss — and moves the
// rows to 'ordered'. Then the order sheet goes to the company mailbox (sendToCompany): mail trouble never undoes the
// order, it is kept with the reason and Send again retries. Cost and loss stay in CI Plant; the mail carries rates only.
const ORDER_FROM = new Set(['costed', 'price_pending', 'quote_ready', 'sent', 'countered']);
const ORDER_PREFIX = 'CI-OF-';

// The rows as an order needs them: the stage, the costing's inputs, the line the item was quoted on, a drawn KLD.
// `why` says why a row cannot go on an order. Locked (FOR UPDATE) when finalising.
async function orderRows(qc, list, lock = false) {
  if (!list.length) return [];
  const rows = await qc(`
    SELECT e.id, e.enquiry_no, e.status, e.mailbox, e.customer_id, e.customer_name, e.product_name, e.size_text, e.size_key, e.style,
           e.board, e.gsm::float8 AS gsm, e.colours::float8 AS colours, e.coating, e.specs, e.quantities::float8[] AS quantities,
           e.final_prices, e.counter, e.quotation_id, e.order_id,
           c.id AS c_id, c.complete AS c_complete, c.archived AS c_archived, c.inputs AS costing_inputs, c.size_id,
           qt.quotation_no, qt.status AS quotation_status, qt.lines AS quotation_lines, cs.kld->>'rev' AS kld_rev
      FROM enquiries e LEFT JOIN costings c ON c.id = e.costing_id LEFT JOIN quotations qt ON qt.id = e.quotation_id
      LEFT JOIN costing_sizes cs ON cs.id = c.size_id AND cs.kld IS NOT NULL
     WHERE e.id = ANY($1::int[]) ORDER BY e.id${lock ? ' FOR UPDATE OF e' : ''}`, [list]);
  return rows.map(e => {
    const live = !!e.c_id && !e.c_archived;
    const complete = live && !!e.c_complete;
    const stage = stageOf(e.status, complete, live);
    const why = e.order_id || e.status === 'ordered' ? 'is on an order already'
      : !complete ? 'has no complete costing'
        : !ORDER_FROM.has(stage) ? `is ${stageText(stage)}` : null;
    const quoted = Array.isArray(e.quotation_lines) && !['cancelled', 'superseded'].includes(e.quotation_status) ? e.quotation_lines : [];
    const ql = quoted.find(l => l.enquiry_id === e.id && !l.option) || quoted.find(l => l.enquiry_id === e.id) || null;
    return { ...e, stage, why, quotationLine: ql, kld: e.kld_rev ? { rev: Number(e.kld_rev), size_id: e.size_id } : null };
  });
}
const editsOf = it => (it ? { qty: it.qty, rate: it.rate, new_die: typeof it.new_die === 'boolean' ? it.new_die : undefined } : null);
const lineFor = (e, edits) => ({
  ...orderLine(e, { inputs: e.costing_inputs, quotationLine: e.quotationLine, kld: e.kld, edits }),
  quotation_no: e.quotationLine ? e.quotation_no : null,
});

// Who the order sheet goes to (the business mailbox's address) and from (the mailbox in use, through its Gmail link).
async function orderMailState() {
  const box = await one('SELECT key, email FROM enquiry_mailboxes WHERE in_use');
  const biz = await one(`SELECT email FROM enquiry_mailboxes WHERE key = 'business'`);
  const link = box && gmailConfigured() ? await linkOf(box.key) : null;
  const company = biz?.email ? String(biz.email).trim().toLowerCase() : null;
  return { box, link, company, sender: link?.email || box?.email || null, can_send: !!(link && company) };
}

const ORDER_COLS = `o.id, o.order_no, o.mailbox, o.customer_id, o.customer_name, o.quotation_id, qt.quotation_no, o.lines, o.total::float8 AS total,
  o.loss::float8 AS loss, o.items_at_loss, o.new_dies, o.mail_wanted, o.mail_status, o.mail_to, o.mail_subject, o.mail_error, o.mail_sent_at,
  o.created_by_name, o.created_at`;
const orderById = id => one(`SELECT ${ORDER_COLS} FROM enquiry_orders o LEFT JOIN quotations qt ON qt.id = o.quotation_id WHERE o.id = $1`, [id]);

// Send the order sheet (the table, and each drawn KLD as its PDF) to the company mailbox. Never throws: the answer and
// the order say 'sent', or 'failed' with the reason.
async function mailOrder(id, u) {
  const o = await one('SELECT * FROM enquiry_orders WHERE id = $1', [id]);
  const st = await orderMailState();
  try {
    if (!st.company) throw fail(409, 'No company mailbox address — set the business mailbox in the desk settings, then Send again.');
    if (!st.link) throw fail(409, `The mailbox in use (${st.sender || '—'}) has no Gmail connected — an admin presses Connect Gmail in the desk settings, then Send again.`);
    const qtNo = o.quotation_id ? (await one('SELECT quotation_no FROM quotations WHERE id = $1', [o.quotation_id]))?.quotation_no : null;
    const mail = orderMail({ order_no: o.order_no, customer: o.customer_name, quotation_no: qtNo, lines: o.lines, by: u.name, at: o.created_at });
    const attachments = [];
    for (const l of o.lines.filter(x => x.kld?.size_id)) {
      const row = await one('SELECT id, size_key, style, kld FROM costing_sizes WHERE id = $1 AND kld IS NOT NULL', [l.kld.size_id]);
      if (!row) continue;
      const bytes = await kldPdf({ kld: row.kld, title: [l.product, l.size].filter(Boolean).join(' ') });
      attachments.push({ name: `KLD ${row.size_key} ${row.style || ''} rev ${row.kld.rev || 1}.pdf`.replace(/\s+/g, ' '), mime: 'application/pdf', bytes: Buffer.from(bytes) });
    }
    const token = await accessToken(st.link);
    const sent = await sendToCompany(token, { from: st.link.email, company: st.company, subject: mail.subject, text: mail.text, html: mail.html, attachments });
    await q(`UPDATE enquiry_orders SET mail_status = 'sent', mail_to = $2, mail_subject = $3, mail_message_id = $4, mail_error = NULL, mail_sent_at = now()
              WHERE id = $1`, [id, st.company, mail.subject, sent.message_id]);
    await q('UPDATE gmail_links SET last_used_at = now(), last_error = NULL, last_error_at = NULL WHERE mailbox = $1', [st.box.key]);
    await enquiryEvent(q, { action: 'order_mail', detail: { order_no: o.order_no, to: st.company, klds: attachments.length } }, u);
    await audit('enquiry_order', id, 'mail', `${o.order_no} — order sheet sent to the company mailbox`, q, u.name);
    return { status: 'sent', to: st.company };
  } catch (e) {
    const why = String(e?.message || e).slice(0, 500);
    const fromGmail = e?.gmailStatus != null || e?.expired;
    if (e?.expired && st.box) forgetToken(st.box.key);
    if (fromGmail && st.box) await q('UPDATE gmail_links SET last_error = $2, last_error_at = now() WHERE mailbox = $1', [st.box.key, why]);
    await q(`UPDATE enquiry_orders SET mail_status = 'failed', mail_error = $2 WHERE id = $1`, [id, why]);
    await audit('enquiry_order', id, 'mail_failed', `${o.order_no} — order sheet not sent`, q, u.name);
    return { status: 'failed', error: why };
  }
}

r.post('/costing/enquiries/order-preview', async (req, res, next) => {
  try {
    const list = ids(req.body);
    if (!list.length) throw fail(400, 'Tick the enquiries the customer has ordered.');
    const edits = new Map((Array.isArray(req.body?.items) ? req.body.items : []).map(it => [intOrNull(it?.id), it]));
    const lines = [], refused = [];
    for (const e of await orderRows(q, list)) {
      if (e.why) { refused.push({ id: e.id, enquiry_no: e.enquiry_no, why: e.why }); continue; }
      let line;
      try { line = lineFor(e, editsOf(edits.get(e.id))); } catch (x) { line = { ...lineFor(e, null), error: x.why || x.message }; }
      lines.push({ ...line, customer_name: e.customer_name });
    }
    const st = await orderMailState();
    res.json({
      lines, refused, totals: orderTotals(lines), mail_default: lines.some(l => l.new_die),
      company: st.company, sender: st.sender, can_send: st.can_send, can_finalise: mayApproveCosting(req.costingUser),
    });
  } catch (e) { next(e); }
});

r.post('/costing/enquiries/order', async (req, res, next) => {
  try {
    const u = req.costingUser;
    needMgmt(u);
    const items = (Array.isArray(req.body?.items) ? req.body.items : []).slice(0, 60);
    const list = [...new Set(items.map(it => intOrNull(it?.id)).filter(Boolean))];
    if (!list.length) throw fail(400, 'Tick the enquiries the customer has ordered.');
    const byId = new Map(items.map(it => [intOrNull(it?.id), it]));
    const mailWanted = req.body?.mail === true;
    const out = await tx(async (qc, oc) => {
      const rows = await orderRows(qc, list, true);
      const ok = rows.filter(e => !e.why);
      const refused = rows.filter(e => e.why).map(e => ({ id: e.id, enquiry_no: e.enquiry_no, why: e.why }));
      for (const id of list) if (!rows.some(e => e.id === id)) refused.push({ id, enquiry_no: `#${id}`, why: 'was not found' });
      if (!ok.length) throw fail(409, `Nothing to finalise: ${refused.map(x => `${x.enquiry_no} ${x.why}`).join('; ')}.`, { refused });
      if (new Set(ok.map(e => String(e.customer_name || '').trim().toLowerCase())).size > 1) {
        throw fail(409, 'One order is for one customer — finalise each customer\'s items on their own.');
      }
      const lines = ok.map(e => {
        try { return lineFor(e, editsOf(byId.get(e.id)) || {}); } catch (x) { throw fail(400, `${e.enquiry_no}: ${x.why || x.message}.`); }
      });
      for (const [i, l] of lines.entries()) if (!(l.rate > 0) || !(l.qty > 0)) throw fail(400, `${ok[i].enquiry_no}: a quantity and a rate a carton are needed.`);
      const totals = orderTotals(lines);
      const quoted = [...new Set(ok.map(e => (e.quotationLine ? e.quotation_id : null)).filter(Boolean))];
      const no = await nextNumber(ORDER_PREFIX, 'enquiry_orders', 'order_no', oc);
      const order = await oc(`INSERT INTO enquiry_orders (order_no, mailbox, customer_id, customer_name, quotation_id, lines, total, loss, items_at_loss,
                                     new_dies, mail_wanted, created_by, created_by_name)
                              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id, order_no`,
      [no, ok[0].mailbox, ok[0].customer_id, ok[0].customer_name, quoted.length === 1 ? quoted[0] : null, JSON.stringify(lines),
        totals.total, totals.loss, totals.items_at_loss, totals.new_dies, mailWanted, u.id, u.name]);
      for (const [i, e] of ok.entries()) {
        const l = lines[i];
        await qc(`UPDATE enquiries SET status = 'ordered', order_id = $2, updated_at = now(), updated_by_name = $3 WHERE id = $1`, [e.id, order.id, u.name]);
        await enquiryEvent(qc, { enquiryId: e.id, quotationId: e.quotation_id || null, action: 'order',
          detail: { order_no: no, qty: l.qty, rate: l.rate, cost: l.cost, margin_total: l.margin_total, new_die: l.new_die } }, u);
        await audit('enquiry', e.id, 'order', `${e.enquiry_no} — ${no}`, qc, u.name);
      }
      const n = ok.length;
      await audit('enquiry_order', order.id, 'finalise',
        `${no} — ${n} item${n === 1 ? '' : 's'}${totals.new_dies ? `, ${totals.new_dies} new die${totals.new_dies === 1 ? '' : 's'}` : ''}`, qc, u.name);
      return { order, done: ok.map(e => e.enquiry_no), refused };
    });
    const mail = mailWanted ? await mailOrder(out.order.id, u) : { status: 'none' };
    res.status(201).json({ order: await orderById(out.order.id), done: out.done, refused: out.refused, mail });
  } catch (e) { next(e); }
});

r.get('/costing/enquiry-orders', async (req, res, next) => {
  try {
    res.json(await q(`SELECT ${ORDER_COLS} FROM enquiry_orders o LEFT JOIN quotations qt ON qt.id = o.quotation_id
                       ORDER BY o.created_at DESC, o.id DESC LIMIT 200`));
  } catch (e) { next(e); }
});

// Send again (Management): an order sheet not sent yet. Once sent it is never sent twice.
r.post('/costing/enquiry-orders/:id(\\d+)/mail', async (req, res, next) => {
  try {
    const u = req.costingUser;
    needMgmt(u);
    const id = intOrNull(req.params.id) || 0;
    const o = await orderById(id);
    if (!o) throw fail(404, 'No such order.');
    if (o.mail_status === 'sent') throw fail(409, `${o.order_no}: the order sheet went to ${o.mail_to} already.`);
    const mail = await mailOrder(id, u);
    res.json({ ...(await orderById(id)), mail });
  } catch (e) { next(e); }
});

// ── quotations ───────────────────────────────────────────────────────────────────────────────────
const QT_COLS = `qt.id, qt.quotation_no, qt.mailbox, qt.customer_id, qt.customer_name, qt.contact_name, qt.contact_email, qt.reply_mail_id,
  qt.lines, qt.total::float8 AS total, qt.terms, qt.email_subject, qt.email_opening, qt.email_closing, qt.status, qt.job_id,
  qt.gmail_draft_id, qt.gmail_draft_url, qt.gmail_message_id, qt.sent_to, qt.sent_at, qt.sent_by_name, qt.created_by_name, qt.created_at,
  qt.updated_by_name, qt.updated_at, qt.revision, qt.supersedes_id`;

// One quotation per customer, from Quotation-ready rows not already on a live quotation.
// One quotation per customer from Quotation-ready enquiries (used by the route below and by /send).
// A row that carried the customer's counter gets a REVISED quotation: revision n+1 of the one it answered (that one is
// marked superseded and its waiting draft job cancelled), replying in the counter mail's thread, opening with the
// revised words. Customer-facing content is the same approved template: product, details asked, rate.
const REVISED_OPENING = 'Thank you for your reply. Please find our revised rates below.';
async function makeQuotations(list, u, { supersedes = {} } = {}) {
    return tx(async (qc, oc) => {
      await lockDocNumber('CI-QTN-', oc);
      const rows = await qc(`SELECT e.*, e.quantities::float8[] AS quantities, m.subject AS mail_subject, m.received_at AS mail_received_at,
                                    cm.subject AS counter_subject, cm.received_at AS counter_received_at, cm.mailbox AS counter_mailbox
                               FROM enquiries e LEFT JOIN enquiry_mails m ON m.id = e.mail_id LEFT JOIN enquiry_mails cm ON cm.id = e.counter_mail_id
                              WHERE e.id = ANY($1::int[]) ORDER BY e.id FOR UPDATE OF e`, [list]);
      const bad = rows.filter(e => e.status !== 'quote_ready' || e.quotation_id);
      if (bad.length) throw fail(409, `Only finalised enquiries not yet on a quotation can be quoted: ${bad.map(e => e.enquiry_no).join(', ')}.`);
      if (rows.length !== list.length) throw fail(404, 'An enquiry was not found.');
      const s = await oc('SELECT terms, opening, closing FROM enquiry_settings WHERE id = 1');
      const out = [];
      for (const group of groupByCustomer(rows)) {
        const no = await nextNumber('CI-QTN-', 'quotations', 'quotation_no', oc);
        const { lines, total } = quotationLines(group);
        const head = group[0];
        // The reply goes into the newest mail of this customer's — a counter mail before the enquiry mail it answered.
        const mails = [
          ...group.filter(e => e.counter_mail_id).map(e => ({ mail_id: e.counter_mail_id, mail_subject: e.counter_subject, at: e.counter_received_at, mailbox: e.counter_mailbox || e.mailbox })),
          ...group.filter(e => e.mail_id).map(e => ({ mail_id: e.mail_id, mail_subject: e.mail_subject, at: e.mail_received_at, mailbox: e.mailbox })),
        ];
        const mail = mails.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0))[0];
        const trial = (await oc('SELECT send_to FROM enquiry_mailboxes WHERE key = $1', [mail?.mailbox || head.mailbox || 'trial']))?.send_to !== 'customers';
        // A revision: of the quotation(s) these rows' counter answered, else the first revised one (a counter to a
        // quotation made outside CI Plant).
        const oldIds = [...new Set(group.map(e => supersedes[e.id]).filter(Boolean))];
        const olds = oldIds.length ? await oc(`SELECT max(revision)::int AS rev FROM quotations WHERE id = ANY($1::int[])`, [oldIds]) : null;
        const revision = oldIds.length ? (olds?.rev ?? 0) + 1 : group.some(e => Number(e.counter_round) > 0) ? 1 : 0;
        const row = await oc(`
          INSERT INTO quotations (quotation_no, mailbox, customer_id, customer_name, contact_name, contact_email, reply_mail_id, lines, total,
                                  terms, email_subject, email_opening, email_closing, created_by, created_by_name, updated_by_name, revision, supersedes_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15, $16, $17) RETURNING id, quotation_no, revision`,
        [no, mail?.mailbox || head.mailbox || null, head.customer_id, head.customer_name, head.contact_name, head.contact_email, mail?.mail_id ?? null,
          JSON.stringify(lines), total, s.terms, replySubject(mail?.mail_subject, no, trial), revision > 0 ? REVISED_OPENING : s.opening, s.closing,
          u.id, u.name, revision, oldIds[0] ?? null]);
        for (const oldId of oldIds) {
          const old = await oc(`UPDATE quotations SET status = 'superseded', updated_at = now(), updated_by_name = $2
                                 WHERE id = $1 AND status IN ('ready', 'queued', 'drafted') RETURNING id, quotation_no, gmail_draft_id`, [oldId, u.name]);
          await qc(`UPDATE enquiry_jobs SET status = 'cancelled', finished_at = now(), error = 'Superseded by a revised quotation'
                     WHERE quotation_id = $1 AND status = 'queued'`, [oldId]);
          await enquiryEvent(qc, { quotationId: oldId, action: 'superseded', detail: { by: no, ...(old?.gmail_draft_id ? { note: 'Its Gmail draft can be discarded there.' } : {}) } }, u);
        }
        await qc(`UPDATE enquiries SET quotation_id = $2, updated_at = now(), updated_by_name = $3 WHERE id = ANY($1::int[])`, [group.map(e => e.id), row.id, u.name]);
        for (const e of group) await enquiryEvent(qc, { enquiryId: e.id, quotationId: row.id, action: 'quotation', detail: { quotation_no: no } }, u);
        await enquiryEvent(qc, { quotationId: row.id, action: 'created', detail: { enquiries: group.map(e => e.enquiry_no), total, ...(revision ? { revision, supersedes: oldIds } : {}) } }, u);
        await audit('quotation', row.id, 'create', `${no} — ${group.length} item${group.length === 1 ? '' : 's'}`, qc, u.name);
        out.push(row);
      }
      return out;
    });
}

r.post('/costing/quotations', async (req, res, next) => {
  try {
    const list = ids(req.body);
    if (!list.length) throw fail(400, 'Tick the Quotation-ready enquiries to quote.');
    res.status(201).json({ quotations: await makeQuotations(list, req.costingUser) });
  } catch (e) { next(e); }
});

// Send the quotation, in one step (owner, 11 Nov 2026: "once we push to the quotation, it has to be the reply to the same
// mail saved in the drafts … make this whole process very seamless"). For the enquiries given: those with every final price
// saved are finalised (Management), every finalised one not yet quoted gets its quotation (one per customer, the approved
// template), and each quotation is queued to Claude as a Gmail reply draft in the customer's own thread. Never sends.
// The answer says what happened to every enquiry — nothing is skipped silently.
r.post('/costing/quotations/send', async (req, res, next) => {
  try {
    const u = req.costingUser;
    needMgmt(u);
    const list = ids(req.body);
    if (!list.length) throw fail(400, 'Choose the enquiries to send.');
    const skipped = [];
    const supersedes = {}; // enquiry id → the quotation its counter answered (a revised one replaces it)
    // 1. Finalise what has its prices but is not finalised yet (a row with the customer's counter: its revised prices).
    const group = newGroup();
    await tx(async (qc) => {
      for (const e of await lockRows(qc, list)) {
        if (e.status === 'quote_ready' || e.status === 'sent') continue;
        const prices = priceRows(e, e.complete ? e.costing_inputs : null);
        const why = !['costed', 'price_pending', 'countered'].includes(e.stage) ? `is ${stageText(e.stage)}`
          : !e.complete ? 'has no complete costing'
            : !prices.length || prices.some(p => !(p.final > 0)) ? 'has no locked final price' : null;
        if (why) { skipped.push({ enquiry_no: e.enquiry_no, why }); continue; }
        const answered = e.status === 'countered' && e.quotation_id && e.quotation_status !== 'cancelled' ? e.quotation_id : null;
        if (answered) supersedes[e.id] = answered;
        await changeRow(qc, e, `status = 'quote_ready', finalised_by = $3, finalised_by_name = $4, finalised_at = now()${answered ? ', quotation_id = NULL' : ''}`, [u.id, u.name], u,
          { action: 'finalise', group, detail: { prices: prices.map(p => ({ qty: p.qty, final: p.final, proposed: p.proposed, theirs: p.theirs })), ...(answered ? { revises: answered } : {}) } });
      }
    });
    // 2. Quotations for the finalised ones not yet on a live quotation.
    const rows = await q(`SELECT e.id, e.enquiry_no, e.status, e.quotation_id, qt.status AS q_status, qt.quotation_no
                            FROM enquiries e LEFT JOIN quotations qt ON qt.id = e.quotation_id
                           WHERE e.id = ANY($1::int[]) ORDER BY e.id`, [list]);
    const toQuote = rows.filter(e => e.status === 'quote_ready' && (!e.quotation_id || e.q_status === 'cancelled')).map(e => e.id);
    const made = toQuote.length ? await makeQuotations(toQuote, u, { supersedes }) : [];
    // 3. A Gmail draft for each new quotation, and for an earlier quotation of these enquiries still without one.
    const quoteIds = [...new Set([...made.map(x => x.id), ...rows.filter(e => e.quotation_id && ['ready'].includes(e.q_status)).map(e => e.quotation_id)])];
    const drafted = [], failed = [];
    for (const id of quoteIds) {
      try { const j = await queueDraft(id, u); drafted.push({ id, quotation_no: j.quotation_no, job: j.job_id, now: !!j.drafted_now, view_url: j.view_url || null }); }
      catch (e) { failed.push({ id, why: e.message }); }
    }
    for (const e of rows) {
      if (e.quotation_id && ['queued', 'drafted', 'sent'].includes(e.q_status)) skipped.push({ enquiry_no: e.enquiry_no, why: `is on ${e.quotation_no} (${e.q_status})` });
    }
    res.status(201).json({ quotations: made, drafted, failed, skipped, undo: group });
  } catch (e) { next(e); }
});

r.get('/costing/quotations', async (req, res, next) => {
  try {
    const st = String(req.query.status || '').split(',').filter(x => ['ready', 'queued', 'drafted', 'sent', 'cancelled'].includes(x));
    const rows = await q(`SELECT ${QT_COLS} FROM quotations qt ${st.length ? 'WHERE qt.status = ANY($1::text[])' : ''}
                          ORDER BY qt.id DESC LIMIT 300`, st.length ? [st] : []);
    res.json(rows);
  } catch (e) { next(e); }
});

const letterhead = () => one(`SELECT name, tagline, address, city, state, gstin FROM billing_entities WHERE active = 1
                              ORDER BY is_default DESC, id LIMIT 1`).then(x => x || {});
async function quotationById(id, sender = null) {
  const qt = await one(`SELECT ${QT_COLS} FROM quotations qt WHERE qt.id = $1`, [id]);
  if (!qt) return null;
  const box = qt.mailbox ? await one(`SELECT ${MAILBOX_COLS} FROM enquiry_mailboxes WHERE key = $1`, [qt.mailbox]) : await inUse();
  qt.mailbox_row = box;
  qt.recipient = replyRecipient(box, qt.contact_email);
  qt.reply = composeReply(qt, { sender, trialFor: qt.recipient.trial ? qt.contact_email || '(no address)' : null });
  qt.mail = qt.reply_mail_id ? await one(`SELECT id, subject, from_email, received_at, view_url, gmail_thread_id FROM enquiry_mails WHERE id = $1`, [qt.reply_mail_id]) : null;
  qt.job = qt.job_id ? await jobById(qt.job_id) : null;
  qt.events = await q(`SELECT action, detail, by_name, at FROM enquiry_events WHERE quotation_id = $1 ORDER BY id DESC LIMIT 100`, [id]);
  return qt;
}

r.get('/costing/quotations/:id(\\d+)', async (req, res, next) => {
  try {
    const qt = await quotationById(intOrNull(req.params.id) || 0, req.costingUser.name);
    if (!qt) throw fail(404, 'No such quotation.');
    res.json(qt);
  } catch (e) { next(e); }
});

r.put('/costing/quotations/:id(\\d+)', async (req, res, next) => {
  try {
    const u = req.costingUser;
    const id = intOrNull(req.params.id) || 0;
    const b = req.body || {};
    const contact = b.contact_email === undefined ? undefined : (text(b.contact_email, 200)?.toLowerCase() || null);
    if (contact && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) throw fail(400, 'That e-mail address does not look right.');
    const row = await one(`UPDATE quotations SET terms = COALESCE($2, terms), email_subject = COALESCE($3, email_subject),
                                  email_opening = COALESCE($4, email_opening), email_closing = COALESCE($5, email_closing),
                                  contact_email = CASE WHEN $6::boolean THEN $7 ELSE contact_email END,
                                  contact_name = COALESCE($8, contact_name), updated_at = now(), updated_by_name = $9
                            WHERE id = $1 AND status IN ('ready', 'drafted') RETURNING id`,
    [id, text(b.terms, 2000), text(b.email_subject, 300), text(b.email_opening, 2000), text(b.email_closing, 2000),
      contact !== undefined, contact ?? null, text(b.contact_name, 160), u.name]);
    if (!row) throw fail(409, 'Only a quotation not yet sent (or queued to send) can be changed.');
    await enquiryEvent(q, { quotationId: id, action: 'edited' }, u);
    res.json(await quotationById(id));
  } catch (e) { next(e); }
});

async function pdfFor(qt) {
  return Buffer.from(await quotationPdf(qt, await letterhead(), { trialFor: qt.recipient?.trial ? qt.contact_email || '(no address)' : null }));
}

r.get('/costing/quotations/:id/pdf', async (req, res, next) => {
  try {
    const qt = await quotationById(intOrNull(req.params.id) || 0);
    if (!qt) throw fail(404, 'No such quotation.');
    const pdf = await pdfFor(qt);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${qt.quotation_no}.pdf"`, 'Cache-Control': 'no-store' });
    res.end(pdf);
  } catch (e) { next(e); }
});

// Save the reply as a Gmail draft: the job carries exactly this reply and this PDF, and Claude saves them as a
// draft in the customer's thread. Nothing is ever sent from here — the person sends the draft from Gmail.
// Drafting again after a change makes a fresh draft; the old one is left in Gmail for the person to delete.
// A trial mailbox's draft is addressed to its own address only.
// Queue one quotation to Claude as a Gmail draft (a reply in the customer's thread). Returns { job_id, quotation_no }.
async function queueDraft(id, u) {
    // Signed by the person who presses it.
    const qt = await quotationById(id, u.name);
    if (!qt) throw fail(404, 'No such quotation.');
    if (!['ready', 'drafted'].includes(qt.status)) throw fail(409, `${qt.quotation_no} is ${qt.status} — no draft to make.`);
    if (qt.recipient.error) throw fail(409, qt.recipient.error);
    const box = qt.mailbox_row;
    const pdf = await pdfFor(qt);
    const sha = crypto.createHash('sha256').update(pdf).digest('hex');
    const mail = qt.reply_mail_id ? await one('SELECT gmail_message_id, gmail_thread_id FROM enquiry_mails WHERE id = $1', [qt.reply_mail_id]) : null;
    const brief = {
      quotation_no: qt.quotation_no,
      to: [qt.recipient.to], trial: qt.recipient.trial, would_go_to: qt.recipient.would_go_to || null,
      subject: qt.reply.subject, text: qt.reply.text, html: qt.reply.html,
      reply_to_message_id: mail?.gmail_message_id || null, thread_id: mail?.gmail_thread_id || null,
    };
    // This mailbox's Gmail is connected: the server saves the draft now, no robot.
    const link = gmailConfigured() ? await linkOf(box.key) : null;
    if (link) return draftOnServer({ qt, box, link, brief, pdf, sha, mail, u });
    const job = await tx(async (qc, oc) => {
      const cur = await oc(`SELECT status FROM quotations WHERE id = $1 FOR UPDATE`, [id]);
      if (!['ready', 'drafted'].includes(cur?.status)) throw fail(409, `${qt.quotation_no} changed meanwhile — open it again.`);
      const j = await oc(`INSERT INTO enquiry_jobs (kind, mailbox, mailbox_email, quotation_id, brief, attachment, attachment_name, attachment_sha256, queued_by, queued_by_name, fire_status)
                          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'waiting') RETURNING id`,
      ['draft', box.key, box.email, id, brief, pdf, `${qt.quotation_no}.pdf`, sha, u.id, u.name]);
      await qc(`UPDATE quotations SET status = 'queued', job_id = $2, updated_at = now(), updated_by_name = $3 WHERE id = $1`, [id, j.id, u.name]);
      await enquiryEvent(qc, { quotationId: id, action: 'draft', detail: { job: j.id, to: brief.to, trial: brief.trial, replaces_draft: qt.gmail_draft_id || null } }, u);
      await audit('quotation', id, 'draft', `${qt.quotation_no} — job ${j.id}`, qc, u.name);
      return j;
    });
    return { job_id: job.id, quotation_no: qt.quotation_no };
}

// The draft saved by CI Plant itself in the mailbox's Gmail — the same subject, words and PDF the robot would get.
// Pressing again changes that same draft (a second copy is never left). Gmail trouble: the quotation stays as it was
// and the reason is shown; nothing is half-done.
async function draftOnServer({ qt, box, link, brief, pdf, sha, mail, u }) {
  let d;
  try {
    const token = await accessToken(link);
    const hdr = await replyHeaders(token, mail?.gmail_message_id);
    // A mailbox that answers customers replies to EVERYONE on the customer's mail; a trial mailbox only to itself.
    const all = !brief.trial && (hdr.from || hdr.replyTo) ? replyAll(hdr, link.email) : null;
    if (all?.to.length) { brief.to = all.to; brief.cc = all.cc; }
    // No PDF on the draft (owner, 11 Nov 2026: the rates are in the mail itself); the PDF stays in CI Plant.
    void pdf;
    const raw = rawOf(buildMime({ from: link.email, to: brief.to, cc: brief.cc || [], subject: brief.subject, text: brief.text, html: brief.html,
      inReplyTo: hdr.inReplyTo, references: hdr.references }));
    d = await saveDraft(token, { email: link.email, raw, threadId: hdr.threadId || mail?.gmail_thread_id || null, draftId: qt.gmail_draft_id });
  } catch (e) {
    if (e.expired) forgetToken(box.key);
    await q('UPDATE gmail_links SET last_error = $2, last_error_at = now() WHERE mailbox = $1', [box.key, String(e.message).slice(0, 500)]);
    throw fail(e.status && e.status < 500 ? 409 : 502, `${qt.quotation_no}: ${e.message}`);
  }
  const result = { by: 'server', draft_id: d.draft_id, message_id: d.message_id, thread_id: d.thread_id, view_url: d.view_url, replaced: d.replaced,
    to: brief.to, cc: brief.cc || [] };
  const job = await tx(async (qc, oc) => {
    const cur = await oc(`SELECT status FROM quotations WHERE id = $1 FOR UPDATE`, [qt.id]);
    if (!['ready', 'drafted'].includes(cur?.status)) throw fail(409, `${qt.quotation_no} changed meanwhile — the draft is in Gmail; open the quotation again.`);
    const j = await oc(`INSERT INTO enquiry_jobs (kind, mailbox, mailbox_email, quotation_id, brief, attachment, attachment_name, attachment_sha256,
                               queued_by, queued_by_name, fire_status, status, claimed_by, claimed_at, finished_at, result)
                        VALUES ('draft', $1, $2, $3, $4, $5, $6, $7, $8, $9, 'server', 'done', 'CI Plant (server)', now(), now(), $10) RETURNING id`,
    [box.key, box.email, qt.id, brief, pdf, `${qt.quotation_no}.pdf`, sha, u.id, u.name, result]);
    await qc(`UPDATE quotations SET status = 'drafted', job_id = $2, gmail_draft_id = $3, gmail_draft_url = $4, gmail_message_id = $5,
                     mailbox = COALESCE(mailbox, $7), updated_at = now(), updated_by_name = $6 WHERE id = $1`,
    [qt.id, j.id, d.draft_id, d.view_url, d.message_id, u.name, box.key]);
    await enquiryEvent(qc, { quotationId: qt.id, action: 'drafted', detail: { job: j.id, by: 'server', to: brief.to, trial: brief.trial, replaced: d.replaced } }, u);
    await audit('quotation', qt.id, 'draft', `${qt.quotation_no} — Gmail draft saved by CI Plant (job ${j.id})`, qc, u.name);
    return j;
  });
  await q('UPDATE gmail_links SET last_used_at = now(), last_error = NULL, last_error_at = NULL WHERE mailbox = $1', [box.key]);
  return { job_id: job.id, quotation_no: qt.quotation_no, drafted_now: true, view_url: d.view_url, replaced: d.replaced };
}

r.post('/costing/quotations/:id/draft', async (req, res, next) => {
  try {
    const u = req.costingUser;
    const id = intOrNull(req.params.id) || 0;
    const j = await queueDraft(id, u);
    res.status(201).json({ job: await jobById(j.job_id), quotation: await quotationById(id) });
  } catch (e) { next(e); }
});

// Sent from Gmail by the person (after a draft): recorded here (Management right). A Fetch also notices a draft
// that has gone and records it (routes/enquiry-robot.js, sent-drafts).
r.post('/costing/quotations/:id/mark-sent', async (req, res, next) => {
  try {
    const u = req.costingUser;
    needMgmt(u);
    const id = intOrNull(req.params.id) || 0;
    await tx(async (qc, oc) => {
      const qt = await oc(`UPDATE quotations SET status = 'sent', sent_at = now(), sent_by_name = $2, updated_at = now(), updated_by_name = $2
                            WHERE id = $1 AND status IN ('drafted', 'ready') RETURNING id, quotation_no, contact_email, mailbox`, [id, u.name]);
      if (!qt) throw fail(409, 'Only a quotation not yet sent can be marked sent.');
      await markEnquiriesSent(qc, id, u);
      await enquiryEvent(qc, { quotationId: id, action: 'marked_sent' }, u);
      await audit('quotation', id, 'sent', qt.quotation_no, qc, u.name);
    });
    res.json(await quotationById(id));
  } catch (e) { next(e); }
});

export async function markEnquiriesSent(qc, quotationId, user) {
  const rows = await qc(`UPDATE enquiries SET status = 'sent', updated_at = now(), updated_by_name = $2
                          WHERE quotation_id = $1 AND status = 'quote_ready' RETURNING id`, [quotationId, user?.name || 'Claude']);
  for (const e of rows) await enquiryEvent(qc, { enquiryId: e.id, quotationId, action: 'sent' }, user);
}

// Undo a revised quotation (owner, 11 Nov 2026: "give an option to undo it"): the revision is cancelled (its waiting draft
// job too), the quotation it replaced comes back as it was, and its enquiries go back to the Counter tab with their
// counter and revised prices kept — ready to change and send again. A revision already sent cannot be taken back here.
r.post('/costing/quotations/:id/unrevise', async (req, res, next) => {
  try {
    const u = req.costingUser;
    needMgmt(u);
    const id = intOrNull(req.params.id) || 0;
    const out = await tx(async (qc, oc) => {
      const qt = await oc(`SELECT id, quotation_no, status, revision, supersedes_id, gmail_draft_id FROM quotations WHERE id = $1 FOR UPDATE`, [id]);
      if (!qt) throw fail(404, 'No such quotation.');
      if (!(qt.revision > 0)) throw fail(409, `${qt.quotation_no} is not a revised quotation.`);
      if (!['ready', 'queued', 'drafted'].includes(qt.status)) throw fail(409, `${qt.quotation_no} is ${qt.status} — only a revision not yet sent can be undone.`);
      await qc(`UPDATE quotations SET status = 'cancelled', updated_at = now(), updated_by_name = $2 WHERE id = $1`, [id, u.name]);
      await qc(`UPDATE enquiry_jobs SET status = 'cancelled', finished_at = now(), error = 'Revision undone' WHERE quotation_id = $1 AND status = 'queued'`, [id]);
      let back = null;
      if (qt.supersedes_id) {
        back = await oc(`UPDATE quotations SET status = CASE WHEN gmail_draft_id IS NOT NULL THEN 'drafted' ELSE 'ready' END, updated_at = now(), updated_by_name = $2
                          WHERE id = $1 AND status = 'superseded' RETURNING id, quotation_no, status`, [qt.supersedes_id, u.name]);
        if (back) await enquiryEvent(qc, { quotationId: back.id, action: 'restored', detail: { revision_undone: qt.quotation_no } }, u);
      }
      const rows = await qc(`SELECT e.id, e.enquiry_no, to_jsonb(e) AS snap FROM enquiries e WHERE e.quotation_id = $1 ORDER BY e.id FOR UPDATE`, [id]);
      const group = newGroup();
      for (const e of rows) {
        await changeRow(qc, e, `status = 'countered', quotation_id = $3, ${FINALISED_OFF}`, [back?.id ?? null], u,
          { action: 'revision_undone', group, detail: { quotation_no: qt.quotation_no, back_to: back?.quotation_no ?? null } });
      }
      await enquiryEvent(qc, { quotationId: id, action: 'revision_undone', detail: { restored: back?.quotation_no ?? null,
        ...(qt.gmail_draft_id ? { note: 'Its Gmail draft can be discarded there.' } : {}) } }, u);
      await audit('quotation', id, 'unrevise', qt.quotation_no, qc, u.name);
      return { quotation_no: qt.quotation_no, restored: back?.quotation_no ?? null, enquiries: rows.map(e => e.enquiry_no), had_draft: !!qt.gmail_draft_id };
    });
    res.json(out);
  } catch (e) { next(e); }
});

r.post('/costing/quotations/:id/cancel', async (req, res, next) => {
  try {
    const u = req.costingUser;
    const id = intOrNull(req.params.id) || 0;
    await tx(async (qc, oc) => {
      const qt = await oc(`UPDATE quotations SET status = 'cancelled', updated_at = now(), updated_by_name = $2
                            WHERE id = $1 AND status IN ('ready', 'drafted') RETURNING id, quotation_no, gmail_draft_id`, [id, u.name]);
      if (!qt) throw fail(409, 'Only a quotation not yet sent (or queued to send) can be cancelled.');
      const freed = await qc(`UPDATE enquiries SET quotation_id = NULL, updated_at = now(), updated_by_name = $2 WHERE quotation_id = $1 RETURNING id`, [id, u.name]);
      // Each enquiry's own history says so: they wait in Quotations, ready to quote again.
      for (const e of freed) await enquiryEvent(qc, { enquiryId: e.id, quotationId: id, action: 'unquoted', detail: { quotation_no: qt.quotation_no } }, u);
      await enquiryEvent(qc, { quotationId: id, action: 'cancelled', detail: qt.gmail_draft_id ? { note: 'The draft left in Gmail can be discarded there.' } : null }, u);
      await audit('quotation', id, 'cancel', qt.quotation_no, qc, u.name);
    });
    res.json(await quotationById(id));
  } catch (e) { next(e); }
});

export default r;
