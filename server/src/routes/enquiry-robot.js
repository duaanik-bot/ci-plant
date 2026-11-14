// The enquiry desk's way in for Claude: the AVS robot key (x-avs-robot-key, avs.settings robot_key), not
// a login. Claude reads the mailbox and saves replies as Gmail drafts through its own Gmail connector; here it
// claims the desk's jobs, files the enquiries it read, fetches the quotation PDF it attaches, and reports back.
// There is no send: CI Plant never sends a mail (owner, 3 Nov 2026) — a person sends the draft from Gmail.
//
//   GET  /api/avs/robot/enquiry-desk/procedure       the procedure (skills/enquiry-desk/SKILL.md)
//   GET  /api/avs/robot/enquiry-jobs                 the jobs waiting
//   POST /api/avs/robot/enquiry-jobs/:id/claim       queued → working: the job's whole brief
//   POST /api/avs/robot/enquiry-jobs/:id/mails       a Fetch files mails and their items (a mail filed before is skipped)
//   GET  /api/avs/robot/enquiry-jobs/:id/attachment  the PDF of a Draft job, as queued
//   POST /api/avs/robot/enquiry-jobs/:id/sent-drafts a Fetch reports drafts the person has since sent from Gmail
//   POST /api/avs/robot/enquiry-jobs/:id/counters    a Fetch files a customer's counter-offer (their prices) against quoted rows
//   POST /api/avs/robot/enquiry-jobs/:id/done        { ok: true, result } or { ok: false, error }
//   GET  /api/cron/enquiry-fetch                     Vercel Cron, 11:00 and 15:00 India: a Fetch, started in the cloud
//   GET  /api/enquiry-desk/waiting?mailbox=          the office computer's watcher: is a fetch waiting? (yes or no, no key)
//   POST /api/avs/robot/enquiries-notify             the database, when the office AVS has filed mails into avs.enquiry_intake:
//                                                    copy them onto the desk and tell the desk (enquiry-intake.js)
//
// A job stopped half-way is handed out again after an hour. Mounted before requireAuth (app.js).
// The desk's cloud routine (enquiry-cloud.js) comes in with a one-time pass (x-enquiry-job-token) instead of the robot
// key: it opens its own fetch job only, and the procedure and helper to work it.
import { Router } from 'express';
import { readFileSync } from 'node:fs';
import { q, one, tx } from '../db.js';
import { audit, lockDocNumber } from '../helpers.js';
import { markUncacheable } from '../data-tables.js';
import { keyOk } from './avs-robot.js';
import { cleanMail, unreadItem } from '../enquiry-desk.js';
import { num } from '../costing-engine.js';
import { plantDateStr } from '../plant-calendar.js';
import { enquiryEvent, insertEnquiry, resolveCustomer, markEnquiriesSent, lockRows, recordCounter, newGroup, askedAgain } from './enquiries.js';
import { jobOfPass, startFetch, CLOUD_RUNNER, TIMER_NAME } from '../enquiry-cloud.js';
import { syncIntakeEnquiries, notifyNewEnquiriesSoft, sameMailOnDesk } from '../enquiry-intake.js';

const r = Router();
const ROBOT = 'Claude (AVS robot)';
const MISSING = new Set(['42P01', '3F000']);
const fail = (status, error) => Object.assign(new Error(error), { status });
const intOrNull = v => (Number.isInteger(+v) && +v > 0 ? +v : null);
// Read by a literal path (vercel.json includeFiles puts the folder in the function).
const PROCEDURE = new URL('../../../skills/enquiry-desk/SKILL.md', import.meta.url);
const HELPER = new URL('../../../skills/enquiry-desk/scripts/desk.py', import.meta.url);

r.use(['/avs/robot/enquiry-jobs', '/avs/robot/enquiry-desk'], async (req, res, next) => {
  try {
    markUncacheable();
    res.set('Cache-Control', 'no-store');
    const pass = req.get('x-enquiry-job-token');
    if (pass) {
      // The cloud routine: its one fetch job, for a few hours (enquiry-cloud.js).
      req.passJob = await jobOfPass(pass);
      if (!req.passJob) return res.status(401).json({ error: 'This pass is wrong or has run out — press Fetch again in CI Plant.' });
      req.robotName = String(req.get('x-avs-runner') || CLOUD_RUNNER).replace(/[^\w .@()-]/g, '').slice(0, 60) || CLOUD_RUNNER;
      return next();
    }
    if (!await keyOk(req)) return res.status(401).json({ error: 'Wrong or missing robot key (avs.settings robot_key).' });
    req.robotName = String(req.get('x-avs-runner') || ROBOT).replace(/[^\w .@()-]/g, '').slice(0, 60) || ROBOT;
    next();
  } catch (e) {
    if (MISSING.has(e?.code)) return res.status(404).json({ error: 'AVS is not set up on this database.' });
    next(e);
  }
});

r.get('/avs/robot/enquiry-desk/procedure', (_req, res, next) => {
  try {
    res.set('Content-Type', 'text/markdown; charset=utf-8');
    res.send(readFileSync(PROCEDURE, 'utf8'));
  } catch (e) { next(e); }
});
// Its helper, for a run that has only the procedure (the cloud routine).
r.get('/avs/robot/enquiry-desk/desk.py', (_req, res, next) => {
  try {
    res.set('Content-Type', 'text/x-python; charset=utf-8');
    res.send(readFileSync(HELPER, 'utf8'));
  } catch (e) { next(e); }
});

const OPEN = `status = 'queued' OR (status = 'working' AND claimed_at < now() - interval '1 hour')`;
// A pass opens its own job and no other.
const ownJob = (req, id) => {
  if (req.passJob && req.passJob !== id) throw fail(403, `This pass is for job ${req.passJob} only.`);
};

r.get('/avs/robot/enquiry-jobs', async (req, res, next) => {
  try {
    res.json(await q(`SELECT id, kind, mailbox, mailbox_email, status, queued_at FROM enquiry_jobs
                       WHERE (${OPEN}) AND ($1::int IS NULL OR id = $1) ORDER BY id`, [req.passJob ?? null]));
  } catch (e) { next(e); }
});

// What Claude needs for one job. A Fetch: the mailbox, since when, the Gmail ids already filed, the customer
// masters' names (to write a company as we know it) and the drafts waiting in Gmail (has the person sent any?).
// A Draft: the exact reply.
async function briefOf(jobRow, base) {
  let job = jobRow;
  const mailbox = await one(`SELECT key, email, label, send_to FROM enquiry_mailboxes WHERE key = $1`, [job.mailbox]);
  const { pass_sha256: _p, pass_until: _u, ...brief } = job.brief || {};
  job = { ...job, brief };
  const out = { job: { id: job.id, kind: job.kind, status: job.status }, mailbox: mailbox || { key: job.mailbox, email: job.mailbox_email } };
  if (job.kind === 'fetch') {
    const since = job.brief?.since || plantDateStr(new Date(), -7);
    const known = await q(`SELECT gmail_message_id FROM enquiry_mails WHERE mailbox_email = $1 AND created_at > now() - interval '90 days'
                           ORDER BY id DESC LIMIT 3000`, [job.mailbox_email]);
    const customers = await q(`SELECT name FROM customers WHERE active = 1 ORDER BY name LIMIT 2000`);
    const drafts = await q(`SELECT qt.id AS quotation_id, qt.quotation_no, qt.gmail_draft_id AS draft_id, m.gmail_thread_id AS thread_id
                              FROM quotations qt LEFT JOIN enquiry_mails m ON m.id = qt.reply_mail_id
                             WHERE qt.status = 'drafted' AND qt.mailbox = $1 AND qt.gmail_draft_id IS NOT NULL ORDER BY qt.id LIMIT 200`, [job.mailbox]);
    // Rows we have priced or quoted, by thread: a reply there with the customer's own prices is a COUNTER, not an enquiry.
    const quoted = await q(`SELECT e.enquiry_no, e.product_name, e.quantities::float8[] AS quantities, e.final_prices, e.status,
                                   m.gmail_thread_id AS thread_id, m.subject
                              FROM enquiries e JOIN enquiry_mails m ON m.id = e.mail_id
                             WHERE e.mailbox = $1 AND e.status IN ('price_pending', 'quote_ready', 'sent', 'countered')
                               AND e.updated_at > now() - interval '120 days' ORDER BY e.id LIMIT 500`, [job.mailbox]);
    return {
      ...out, since,
      quoted_rows: quoted.map(x => ({ enquiry_no: x.enquiry_no, product_name: x.product_name, quantities: x.quantities, thread_id: x.thread_id,
        subject: x.subject, status: x.status, our_prices: (x.final_prices || []).map(p => ({ qty: p.qty, ours: p.final })) })),
      counters_url: `${base}/api/avs/robot/enquiry-jobs/${job.id}/counters`,
      gmail_query: `in:inbox -from:me after:${since.replace(/-/g, '/')} -category:promotions -category:social`,
      known_message_ids: known.map(k => k.gmail_message_id),
      customers: customers.map(c => c.name),
      drafts_to_check: drafts,
      file_url: `${base}/api/avs/robot/enquiry-jobs/${job.id}/mails`,
      done_url: `${base}/api/avs/robot/enquiry-jobs/${job.id}/done`,
    };
  }
  return {
    ...out,
    reply: job.brief,
    attachment: { name: job.attachment_name, mime: 'application/pdf', sha256: job.attachment_sha256,
      url: `${base}/api/avs/robot/enquiry-jobs/${job.id}/attachment` },
    done_url: `${base}/api/avs/robot/enquiry-jobs/${job.id}/done`,
  };
}
const baseOf = req => `${req.protocol}://${req.get('host')}`;

r.post('/avs/robot/enquiry-jobs/:id/claim', async (req, res, next) => {
  try {
    const id = intOrNull(req.params.id) || 0;
    ownJob(req, id);
    const job = await one(`UPDATE enquiry_jobs SET status = 'working', claimed_by = $2, claimed_at = now()
                            WHERE id = $1 AND (${OPEN}) RETURNING id, kind, mailbox, mailbox_email, status, brief, quotation_id,
                                  attachment_name, attachment_sha256`, [id, req.robotName]);
    if (!job) {
      const cur = await one(`SELECT id, status, kind, claimed_by FROM enquiry_jobs WHERE id = $1`, [id]);
      if (!cur) throw fail(404, 'No such job.');
      throw fail(409, `Job ${id} is ${cur.status}${cur.claimed_by ? ` (${cur.claimed_by})` : ''} — not for this run.`);
    }
    res.json(await briefOf(job, baseOf(req)));
  } catch (e) { next(e); }
});

// A Fetch files what it read: [{ gmail_message_id, gmail_thread_id, subject, from_name, from_email, received_at,
// body_text, attachments: [{ name, mime, size }], view_url, summary, customer_name, contact_name, contact_email,
// items: [{ product_name, size_text, style, board, gsm, colours, coating, specs, quantities, target_price, notes }] }]
r.post('/avs/robot/enquiry-jobs/:id/mails', async (req, res, next) => {
  try {
    const id = intOrNull(req.params.id) || 0;
    ownJob(req, id);
    const raw = Array.isArray(req.body?.mails) ? req.body.mails : [];
    if (!raw.length) throw fail(400, 'Send { mails: [...] } — at least one.');
    if (raw.length > 25) throw fail(400, 'Up to 25 mails a call — send the rest in another.');
    const out = await tx(async (qc, oc) => {
      const job = await oc(`SELECT id, kind, status, mailbox, mailbox_email FROM enquiry_jobs WHERE id = $1 FOR UPDATE`, [id]);
      if (!job) throw fail(404, 'No such job.');
      if (job.kind !== 'fetch' || job.status !== 'working') throw fail(409, `Job ${id} is a ${job.kind} job, ${job.status} — mails are filed only by a Fetch being worked on.`);
      await lockDocNumber('CI-ENQ-', oc);
      const filed = [], skipped = [], refused = [], sameMail = [];
      for (const m of raw.map(cleanMail)) {
        if (m.error) { refused.push(m.error); continue; }
        // The same mail already on the desk from the other mailbox (a customer who writes to both): filed once.
        const same = await sameMailOnDesk(qc, m, job.mailbox_email);
        if (same) {
          skipped.push(m.gmail_message_id);
          sameMail.push({ gmail_message_id: m.gmail_message_id, mailbox: same.mailbox_email, enquiries: same.enquiry_nos });
          continue;
        }
        const mail = await oc(`
          INSERT INTO enquiry_mails (mailbox, mailbox_email, gmail_message_id, gmail_thread_id, subject, from_name, from_email, to_text,
                                     received_at, body_text, attachments, view_url, summary, job_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
          ON CONFLICT (mailbox_email, gmail_message_id) DO NOTHING RETURNING id`,
        [job.mailbox, job.mailbox_email, m.gmail_message_id, m.gmail_thread_id, m.subject, m.from_name, m.from_email, m.to_text,
          m.received_at, m.body_text, JSON.stringify(m.attachments), m.view_url, m.summary, id]);
        if (!mail) { skipped.push(m.gmail_message_id); continue; }
        const who = {
          ...(await resolveCustomer(oc, { customer_name: m.customer_name, contact_email: m.contact_email })),
          mail_id: mail.id, mailbox: job.mailbox, contact_name: m.contact_name, contact_email: m.contact_email, source: 'robot', by: req.robotName,
        };
        // A mail read as an enquiry with no item made out still lands on the desk, to be read by a person.
        const items = m.items.length ? m.items : [unreadItem(m.subject)];
        const made = [], again = [];
        for (const item of items) {
          // Asked again for an item still open on the desk: that row is marked, no new row (14 Nov 2026).
          const prior = m.items.length ? await askedAgain(qc, item, who, mail.id, req.robotName) : null;
          if (prior) { again.push(prior.enquiry_no); continue; }
          const e = await insertEnquiry(qc, oc, item, who, null);
          await enquiryEvent(qc, { enquiryId: e.id, action: 'fetched', detail: { job: id } }, { name: req.robotName });
          made.push(e.enquiry_no);
        }
        filed.push({ gmail_message_id: m.gmail_message_id, enquiries: made, asked_again: again });
      }
      if (filed.length) await audit('enquiry_job', id, 'file', `Job ${id} — ${filed.length} mail${filed.length === 1 ? '' : 's'} filed`, qc, req.robotName);
      return { filed, skipped, refused, same_mail: sameMail };
    });
    // The desk hears of it at once (bell + phone, the Costing logins) — never failing the filing.
    if (out.filed.length) await notifyNewEnquiriesSoft();
    res.json(out);
  } catch (e) { next(e); }
});

// A customer's counter-offer, read by a Fetch: { mail: { gmail_message_id, gmail_thread_id, subject, from_email, received_at,
// view_url, … }, counters: [{ enquiry_no, qty?, theirs }] }. The mail is kept (the revised quotation replies in its thread);
// each row named moves to the desk's Counter tab with their price beside ours. Rows not priced or quoted are refused.
r.post('/avs/robot/enquiry-jobs/:id/counters', async (req, res, next) => {
  try {
    const id = intOrNull(req.params.id) || 0;
    ownJob(req, id);
    const m = cleanMail(req.body?.mail || {});
    const list = (Array.isArray(req.body?.counters) ? req.body.counters : []).slice(0, 100);
    if (m.error) throw fail(400, `mail: ${m.error}`);
    if (!list.length) throw fail(400, 'Send { mail, counters: [{ enquiry_no, qty, theirs }] }.');
    const robot = { name: req.robotName };
    const out = await tx(async (qc, oc) => {
      const job = await oc(`SELECT id, kind, status, mailbox, mailbox_email FROM enquiry_jobs WHERE id = $1 FOR UPDATE`, [id]);
      if (!job) throw fail(404, 'No such job.');
      if (job.kind !== 'fetch' || job.status !== 'working') throw fail(409, `Job ${id} is not a Fetch being worked on.`);
      const mail = (await oc(`
          INSERT INTO enquiry_mails (mailbox, mailbox_email, gmail_message_id, gmail_thread_id, subject, from_name, from_email, to_text,
                                     received_at, body_text, attachments, view_url, summary, job_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
          ON CONFLICT (mailbox_email, gmail_message_id) DO NOTHING RETURNING id`,
      [job.mailbox, job.mailbox_email, m.gmail_message_id, m.gmail_thread_id, m.subject, m.from_name, m.from_email, m.to_text,
        m.received_at, m.body_text, JSON.stringify(m.attachments), m.view_url, m.summary || 'Customer counter-offer', id]))
        || await oc(`SELECT id FROM enquiry_mails WHERE mailbox_email = $1 AND gmail_message_id = $2`, [job.mailbox_email, m.gmail_message_id]);
      const nos = [...new Set(list.map(c => String(c?.enquiry_no || '').trim()).filter(Boolean))];
      const found = await oc(`SELECT array_agg(id) AS ids FROM enquiries WHERE enquiry_no = ANY($1::text[]) AND mailbox = $2`, [nos, job.mailbox]);
      const rows = await lockRows(qc, found?.ids || []);
      const group = newGroup();
      const filed = [], refused = [];
      for (const no of nos) {
        const e = rows.find(x => x.enquiry_no === no);
        if (!e) { refused.push({ enquiry_no: no, why: 'no such enquiry in this mailbox' }); continue; }
        const prices = list.filter(c => String(c?.enquiry_no).trim() === no).map(c => ({ qty: num(c.qty), theirs: c.theirs }));
        const r0 = await recordCounter(qc, e, prices, { mailId: mail.id, user: robot, group, source: 'robot' });
        if (r0.why) refused.push({ enquiry_no: no, why: r0.why }); else filed.push(no);
      }
      if (filed.length) await audit('enquiry_job', id, 'counter', `Job ${id} — counter filed for ${filed.length} enquir${filed.length === 1 ? 'y' : 'ies'}`, qc, req.robotName);
      return { mail_id: mail.id, filed, refused };
    });
    if (out.filed.length) await notifyNewEnquiriesSoft();
    res.json(out);
  } catch (e) { next(e); }
});

r.get('/avs/robot/enquiry-jobs/:id/attachment', async (req, res, next) => {
  try {
    ownJob(req, intOrNull(req.params.id) || 0);
    const job = await one(`SELECT kind, status, attachment, attachment_name, attachment_sha256 FROM enquiry_jobs WHERE id = $1`, [intOrNull(req.params.id) || 0]);
    if (!job || !job.attachment) throw fail(404, 'This job has no attachment.');
    if (job.status !== 'working') throw fail(409, 'Claim the job first.');
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${job.attachment_name}"`, 'X-Attachment-Sha256': job.attachment_sha256 || '' });
    res.end(job.attachment);
  } catch (e) { next(e); }
});

// Drafts the person has sent from Gmail since, seen by a Fetch: [{ quotation_id, gmail_message_id }]. Each
// quotation must be one this mailbox drafted; it is recorded as sent, by the person, from Gmail.
r.post('/avs/robot/enquiry-jobs/:id/sent-drafts', async (req, res, next) => {
  try {
    const id = intOrNull(req.params.id) || 0;
    ownJob(req, id);
    const list = (Array.isArray(req.body?.sent) ? req.body.sent : []).slice(0, 200);
    const robot = { name: req.robotName };
    const marked = await tx(async (qc, oc) => {
      const job = await oc(`SELECT id, kind, status, mailbox FROM enquiry_jobs WHERE id = $1`, [id]);
      if (!job) throw fail(404, 'No such job.');
      if (job.kind !== 'fetch' || job.status !== 'working') throw fail(409, `Job ${id} is not a Fetch being worked on.`);
      const out = [];
      for (const s of list) {
        const qt = await oc(`UPDATE quotations SET status = 'sent', gmail_message_id = $3, sent_to = contact_email, sent_at = now(),
                                    sent_by_name = 'Sent from Gmail', updated_at = now()
                              WHERE id = $1 AND mailbox = $2 AND status = 'drafted' RETURNING id, quotation_no`,
        [intOrNull(s?.quotation_id) || 0, job.mailbox, String(s?.gmail_message_id || '').slice(0, 200) || null]);
        if (!qt) continue;
        await markEnquiriesSent(qc, qt.id, robot);
        await enquiryEvent(qc, { quotationId: qt.id, action: 'sent_from_gmail', detail: { job: id } }, robot);
        await audit('quotation', qt.id, 'sent', `${qt.quotation_no} — sent from Gmail`, qc, robot.name);
        out.push(qt.quotation_no);
      }
      return out;
    });
    res.json({ marked });
  } catch (e) { next(e); }
});

// Done: a Fetch's counts; a Draft's draft id and Gmail link. Or an error, which puts a quotation back where it was.
r.post('/avs/robot/enquiry-jobs/:id/done', async (req, res, next) => {
  try {
    const id = intOrNull(req.params.id) || 0;
    ownJob(req, id);
    const ok = req.body?.ok !== false;
    const result = req.body?.result && typeof req.body.result === 'object' ? req.body.result : {};
    const error = ok ? null : String(req.body?.error || 'Claude reported a failure').slice(0, 1000);
    const robot = { name: req.robotName };
    await tx(async (qc, oc) => {
      const job = await oc(`SELECT id, kind, status, quotation_id FROM enquiry_jobs WHERE id = $1 FOR UPDATE`, [id]);
      if (!job) throw fail(404, 'No such job.');
      if (job.status !== 'working') throw fail(409, `Job ${id} is ${job.status}.`);
      await qc(`UPDATE enquiry_jobs SET status = $2, result = $3, error = $4, finished_at = now() WHERE id = $1`,
        [id, ok ? 'done' : 'failed', result, error]);
      if (!job.quotation_id) return;
      const qid = job.quotation_id;
      if (!ok) {
        await qc(`UPDATE quotations SET status = CASE WHEN gmail_draft_id IS NOT NULL THEN 'drafted' ELSE 'ready' END, updated_at = now()
                   WHERE id = $1 AND job_id = $2 AND status = 'queued'`, [qid, id]);
        await enquiryEvent(qc, { quotationId: qid, action: `${job.kind}_failed`, detail: { job: id, error } }, robot);
        return;
      }
      // A draft job: the quotation waits in Gmail for the person to check and send it.
      await qc(`UPDATE quotations SET status = 'drafted', gmail_draft_id = $3, gmail_draft_url = $4, updated_at = now()
                 WHERE id = $1 AND job_id = $2`, [qid, id, String(result.draft_id || '').slice(0, 200) || null, /^https:\/\/mail\.google\.com\//.test(result.view_url || '') ? result.view_url : null]);
      await enquiryEvent(qc, { quotationId: qid, action: 'drafted', detail: { job: id } }, robot);
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Is a fetch waiting for this mailbox? The office computer's watcher asks every minute (14 Nov 2026: "it should trigger
// the AVS on my office PC") and starts its Claude only on a yes. No key: the answer is yes or no, nothing more.
r.get('/enquiry-desk/waiting', async (req, res, next) => {
  try {
    markUncacheable();
    res.set('Cache-Control', 'no-store');
    const key = String(req.query.mailbox || '');
    if (!['business', 'trial'].includes(key)) return res.status(400).json({ error: 'Which mailbox — business or trial?' });
    res.json({ waiting: !!await one(`SELECT 1 AS y FROM enquiry_jobs WHERE kind = 'fetch' AND mailbox = $1 AND (${OPEN}) LIMIT 1`, [key]) });
  } catch (e) { next(e); }
});

// The office AVS has filed mails into avs.enquiry_intake (owner, 13 Nov 2026): copy them onto the desk and tell the desk.
// Called by the database (pg_net, migration 20261113180100_avs_enquiry_intake.sql) once per AVS call; safe to call any
// number of times — each row is filed once, each mail announced once.
r.post('/avs/robot/enquiries-notify', async (req, res, next) => {
  try {
    markUncacheable();
    res.set('Cache-Control', 'no-store');
    if (!await keyOk(req)) return res.status(401).json({ error: 'Wrong or missing robot key (avs.settings robot_key).' });
    const out = await syncIntakeEnquiries();
    res.json({ ...out, alert: await notifyNewEnquiriesSoft() });
  } catch (e) {
    if (MISSING.has(e?.code)) return res.status(404).json({ error: 'The enquiry intake is not set up on this database.' });
    next(e);
  }
});

// Vercel Cron (vercel.json), 05:30 and 09:30 UTC = 11:00 and 15:00 India: the desk's auto robot. A Fetch for the mailbox
// in use, started in the cloud, with the owner's Mac and Claude app off. Vercel sends CRON_SECRET as a bearer token
// when the project has one; without it only Vercel's cron agent is answered. Either way a timer start within
// TIMER_QUIET_MIN of the last fetch does nothing, so a repeated call costs nothing.
r.get('/cron/enquiry-fetch', async (req, res, next) => {
  try {
    markUncacheable();
    res.set('Cache-Control', 'no-store');
    const secret = process.env.CRON_SECRET;
    const ok = secret ? req.get('authorization') === `Bearer ${secret}` : /^vercel-cron\//i.test(req.get('user-agent') || '');
    if (!ok) return res.status(401).json({ error: 'Only the timer starts this.' });
    const out = await startFetch({ by: TIMER_NAME, auto: true });
    if (out.error) return res.status(out.status || 409).json({ error: out.error });
    res.json(out);
  } catch (e) {
    if (MISSING.has(e?.code)) return res.status(404).json({ error: 'The enquiry desk is not set up on this database.' });
    next(e);
  }
});

export default r;
