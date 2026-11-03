// Enquiry desk — customer enquiries from the mailbox, pushed into Costing, priced by a person, quoted and
// answered in the customer's own thread (docs/superpowers/specs/2026-11-03-enquiry-desk-design.md).
// Under the Costing tick (it shows prices); Finalise and Mark as sent need the Management right; Settings, an admin.
// CI Plant never sends a mail (owner, 3 Nov 2026): a reply is only ever saved as a Gmail draft in the customer's
// thread, and a person checks it and sends it from Gmail.
// The mailbox itself is read and written by Claude through the AVS robot (routes/enquiry-robot.js).
//
//   GET  /costing/enquiry-desk                 mailboxes, settings, rights, counts, the latest jobs
//   PUT  /costing/enquiry-desk/settings        mailbox in use, who a mailbox replies to, terms, words (admin)
//   POST /costing/enquiry-desk/fetch           queue a Fetch for the mailbox in use and start Claude
//   GET  /costing/enquiry-jobs/:id · POST /costing/enquiry-jobs/:id/cancel
//   GET  /costing/enquiries?stage=&search=     the desk's rows     GET /costing/enquiries/:id  one, with its mail and history
//   POST /costing/enquiries                    one typed in by hand        PUT /costing/enquiries/:id  its details
//   POST /costing/enquiries/ready · /drop · /restore · /push   (ids)
//   PUT  /costing/enquiries/prices             final prices        POST /costing/enquiries/finalise · /reopen
//   POST /costing/quotations                   one quotation per customer from Quotation-ready enquiries
//   GET  /costing/quotations · GET /costing/quotations/:id · PUT /costing/quotations/:id · GET /costing/quotations/:id/pdf
//   POST /costing/quotations/:id/draft (a Gmail draft, never a send) · /mark-sent · /cancel
//
// The plant-wide audit log (read by every login) gets numbers and actions only; prices and addresses go
// to enquiry_events, read here only.
import { Router } from 'express';
import crypto from 'node:crypto';
import { q, one, tx } from '../db.js';
import { audit, nextNumber, lockDocNumber } from '../helpers.js';
import { mayCost, mayApproveCosting } from '../costing-match.js';
import { avsSettings, fireRoutine, linked } from './avs-intake.js';
import {
  STAGE_SQL, STATUS_LABEL, stageOf, cleanItem, priceRows, ceilPaise, quotationLines, groupByCustomer,
  composeReply, replySubject, replyRecipient,
} from '../enquiry-desk.js';
import { quotationPdf } from '../quotation-pdf.js';
import { num } from '../costing-engine.js';
import { plantDateStr } from '../plant-calendar.js';

const r = Router();
const fail = (status, error, extra = {}) => Object.assign(new Error(error), { status, body: extra });
const intOrNull = v => (Number.isInteger(+v) && +v > 0 ? +v : null);
const ids = body => [...new Set((Array.isArray(body?.ids) ? body.ids : []).map(intOrNull).filter(Boolean))].slice(0, 200);
const text = (v, max = 300) => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max) : null; };

// The Costing tick, read fresh (the costing router does the same for its own routes).
const loginOf = id => one('SELECT id, name, role, active, modules, is_management FROM users WHERE id = $1 AND active = 1', [id]);
r.use(['/costing/enquiry-desk', '/costing/enquiries', '/costing/enquiry-jobs', '/costing/quotations'], async (req, res, next) => {
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

// A costing saved from the desk (Push to costing) is linked to its enquiry here, in the costing's own
// transaction (routes/costing.js). A finalised or quoted enquiry keeps its costing.
export async function linkEnquiry(qc, enquiryId, costing, batchId, user) {
  const id = intOrNull(enquiryId);
  if (!id) return;
  const rows = await qc(`
    UPDATE enquiries SET costing_id = $2, batch_id = COALESCE($3::int, batch_id),
           status = CASE WHEN status IN ('new', 'ready', 'costing') THEN 'costing' ELSE status END,
           updated_at = now(), updated_by_name = $4
     WHERE id = $1 AND status NOT IN ('quote_ready', 'sent', 'dropped') RETURNING id, enquiry_no`,
  [id, costing.id, batchId ?? null, user.name]);
  if (rows[0]) await enquiryEvent(qc, { enquiryId: id, action: 'costing', detail: { costing_no: costing.costing_no } }, user);
}

// ── the desk ─────────────────────────────────────────────────────────────────────────────────────
const MAILBOX_COLS = `key, email, label, send_to, in_use`;
const mailboxes = () => q(`SELECT ${MAILBOX_COLS} FROM enquiry_mailboxes ORDER BY key DESC`);
const inUse = async () => (await one(`SELECT ${MAILBOX_COLS} FROM enquiry_mailboxes WHERE in_use`)) || null;
const settings = () => one('SELECT terms, opening, closing, fetch_days FROM enquiry_settings WHERE id = 1');
// AVS's own keys, when this database has AVS (every local one does not).
async function avsCfg() {
  try { return await avsSettings(); } catch { return {}; }
}

const JOB_COLS = `j.id, j.kind, j.mailbox, j.mailbox_email, j.quotation_id, j.status, j.error, j.result, j.fire_status,
  j.queued_by_name, j.claimed_by, j.queued_at, j.claimed_at, j.finished_at`;

r.get('/costing/enquiry-desk', async (req, res, next) => {
  try {
    const [boxes, s, counts, jobs, cfg] = await Promise.all([
      mailboxes(), settings(),
      q(`SELECT ${STAGE_SQL} AS stage, count(*)::int AS n FROM enquiries e LEFT JOIN costings c ON c.id = e.costing_id GROUP BY 1`),
      q(`SELECT ${JOB_COLS} FROM enquiry_jobs j ORDER BY j.id DESC LIMIT 10`),
      avsCfg(),
    ]);
    const quotes = await q(`SELECT status, count(*)::int AS n FROM quotations GROUP BY status`);
    res.json({
      mailboxes: boxes, in_use: boxes.find(b => b.in_use) || null, settings: s,
      counts: Object.fromEntries(counts.map(x => [x.stage, x.n])),
      quotation_counts: Object.fromEntries(quotes.map(x => [x.status, x.n])),
      jobs, claude_linked: linked(cfg).claude,
      can_finalise: mayApproveCosting(req.costingUser), can_admin: req.costingUser.role === 'admin',
      statuses: STATUS_LABEL,
    });
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
// Claude is started with a pointer only; it reads the job from CI Plant with the robot key.
async function startClaude(jobId, kind, mailboxEmail) {
  const cfg = await avsCfg();
  const out = await fireRoutine(cfg, `CI Plant enquiry job ${jobId} (${kind}, ${mailboxEmail}). Follow the enquiry desk procedure.`);
  await q(`UPDATE enquiry_jobs SET fire_status = $2 WHERE id = $1`, [jobId, out.status]);
  return out;
}
const jobById = id => one(`SELECT ${JOB_COLS} FROM enquiry_jobs j WHERE j.id = $1`, [id]);

r.post('/costing/enquiry-desk/fetch', async (req, res, next) => {
  try {
    const u = req.costingUser;
    const box = await inUse();
    if (!box) throw fail(409, 'No mailbox is in use — an admin chooses one in the desk settings.');
    // One open fetch per mailbox: pressing again while Claude has it does not queue a second.
    const open = await one(`SELECT id FROM enquiry_jobs WHERE kind = 'fetch' AND mailbox_email = $1 AND status IN ('queued', 'working') ORDER BY id LIMIT 1`, [box.email]);
    if (open) return res.json({ job: await jobById(open.id), already: true });
    const s = await settings();
    // From the last finished fetch of this mailbox (a day's overlap; a mail filed twice is refused), else fetch_days back.
    const last = await one(`SELECT finished_at FROM enquiry_jobs WHERE kind = 'fetch' AND mailbox_email = $1 AND status = 'done' ORDER BY id DESC LIMIT 1`, [box.email]);
    const since = new Date((last?.finished_at ? new Date(last.finished_at).getTime() : Date.now() - (s?.fetch_days || 7) * 864e5) - 864e5);
    const job = await one(`INSERT INTO enquiry_jobs (kind, mailbox, mailbox_email, brief, queued_by, queued_by_name)
                           VALUES ('fetch', $1, $2, $3, $4, $5) RETURNING id`,
    [box.key, box.email, { since: plantDateStr(since) }, u.id, u.name]);
    await audit('enquiry_job', job.id, 'fetch', `Fetch enquiries — job ${job.id}`, q, u.name);
    const fired = await startClaude(job.id, 'fetch', box.email);
    res.status(201).json({ job: await jobById(job.id), fired });
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
  m.subject AS mail_subject, m.from_name AS mail_from_name, m.from_email AS mail_from_email, m.received_at AS mail_received_at,
  m.view_url AS mail_view_url, jsonb_array_length(COALESCE(m.attachments, '[]')) AS mail_attachments,
  qt.quotation_no, qt.status AS quotation_status`;
const ENQ_FROM = `enquiries e LEFT JOIN costings c ON c.id = e.costing_id LEFT JOIN enquiry_mails m ON m.id = e.mail_id
                  LEFT JOIN quotations qt ON qt.id = e.quotation_id`;
// A row as the desk shows it: the proposals are worked out here; the costing's inputs stay on the server.
const present = row => {
  const { costing_inputs, ...e } = row;
  return { ...e, stage: stageOf(e.status, e.costing_complete), prices: priceRows(e, e.costing_complete ? costing_inputs : null) };
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
  e.events = await q(`SELECT action, detail, by_name, at FROM enquiry_events WHERE enquiry_id = $1 ORDER BY id DESC LIMIT 100`, [id]);
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
    await tx(async (qc, oc) => {
      const cur = await oc('SELECT id, enquiry_no, status, final_prices FROM enquiries WHERE id = $1 FOR UPDATE', [id]);
      if (!cur) throw fail(404, 'No such enquiry.');
      if (['quote_ready', 'sent'].includes(cur.status)) throw fail(409, `${cur.enquiry_no} is ${STATUS_LABEL[cur.status].toLowerCase()} — reopen its prices before changing what was asked.`);
      const who = await resolveCustomer(oc, { customer_id: req.body?.customer_id, customer_name: text(req.body?.customer_name, 160), contact_email: contactEmail });
      // A quantity no longer asked about loses its final price.
      const finals = (cur.final_prices || []).filter(f => item.quantities.includes(Number(f.qty)));
      await qc(`UPDATE enquiries SET customer_id = $2, customer_name = $3, contact_name = $4, contact_email = $5, product_id = $6, product_name = $7,
                       size_text = $8, size_key = $9, style = $10, board = $11, gsm = $12, colours = $13, coating = $14, specs = $15,
                       quantities = $16, target_price = $17, notes = $18, final_prices = $19, updated_at = now(), updated_by_name = $20
                 WHERE id = $1`,
      [id, who.customer_id, who.customer_name, text(req.body?.contact_name, 160), contactEmail,
        intOrNull(req.body?.product_id) || await resolveProduct(qc, item.product_name, who.customer_id), item.product_name,
        item.size_text, item.size_key, item.style, item.board, item.gsm, item.colours, item.coating, item.specs, item.quantities,
        item.target_price, item.notes, JSON.stringify(finals), u.name]);
      // The address is remembered against the customer master for the next mail from it.
      if (contactEmail && who.customer_id) {
        await qc(`INSERT INTO enquiry_contacts (email, customer_id, customer_name) VALUES ($1, $2, $3)
                  ON CONFLICT (email) DO UPDATE SET customer_id = EXCLUDED.customer_id, customer_name = EXCLUDED.customer_name, updated_at = now()`,
        [contactEmail, who.customer_id, who.customer_name]);
      }
      await enquiryEvent(qc, { enquiryId: id, action: 'details' }, u);
    });
    res.json(await enquiryById(id));
  } catch (e) { next(e); }
});

// A status change on ticked rows, each checked on its own: rows that cannot move are listed, never forced.
async function move(list, user, { from, to, action, reason = null, extra = '' }) {
  return tx(async (qc) => {
    const moved = await qc(`UPDATE enquiries SET status = $2, dropped_reason = CASE WHEN $2 = 'dropped' THEN $4 ELSE dropped_reason END,
                                   updated_at = now(), updated_by_name = $3 ${extra}
                             WHERE id = ANY($1::int[]) AND status = ANY($5::text[]) RETURNING id, enquiry_no`,
    [list, to, user.name, reason, from]);
    for (const m of moved) {
      await enquiryEvent(qc, { enquiryId: m.id, action, detail: reason ? { reason } : null }, user);
      await audit('enquiry', m.id, action, m.enquiry_no, qc, user.name);
    }
    return moved;
  });
}
const skippedOf = async (list, moved) => {
  const done = new Set(moved.map(m => m.id));
  const left = list.filter(id => !done.has(id));
  return left.length ? q(`SELECT id, enquiry_no, status FROM enquiries WHERE id = ANY($1::int[]) ORDER BY id`, [left]) : [];
};

r.post('/costing/enquiries/ready', async (req, res, next) => {
  try {
    const list = ids(req.body);
    const moved = await move(list, req.costingUser, { from: ['new'], to: 'ready', action: 'ready' });
    res.json({ moved, skipped: await skippedOf(list, moved) });
  } catch (e) { next(e); }
});
r.post('/costing/enquiries/drop', async (req, res, next) => {
  try {
    const list = ids(req.body);
    const moved = await move(list, req.costingUser, { from: ['new', 'ready', 'costing', 'price_pending'], to: 'dropped', action: 'drop', reason: text(req.body?.reason, 300) || 'Not to be quoted' });
    res.json({ moved, skipped: await skippedOf(list, moved) });
  } catch (e) { next(e); }
});
r.post('/costing/enquiries/restore', async (req, res, next) => {
  try {
    const list = ids(req.body);
    const moved = await tx(async (qc) => {
      const back = await qc(`UPDATE enquiries SET status = CASE WHEN costing_id IS NOT NULL THEN 'costing' ELSE 'new' END,
                                    dropped_reason = NULL, updated_at = now(), updated_by_name = $2
                              WHERE id = ANY($1::int[]) AND status = 'dropped' RETURNING id, enquiry_no`, [list, req.costingUser.name]);
      for (const m of back) await enquiryEvent(qc, { enquiryId: m.id, action: 'restore' }, req.costingUser);
      return back;
    });
    res.json({ moved, skipped: await skippedOf(list, moved) });
  } catch (e) { next(e); }
});

// Push to costing: the rows are marked Costing in progress and handed back for the costing screen to fill
// itself from (New costing for one, Bulk costing for several). Saving there links each costing.
r.post('/costing/enquiries/push', async (req, res, next) => {
  try {
    const list = ids(req.body);
    if (!list.length) throw fail(400, 'Tick the enquiries to push to costing.');
    const moved = await move(list, req.costingUser, { from: ['new', 'ready', 'costing'], to: 'costing', action: 'push' });
    const rows = moved.length ? await q(`SELECT ${ENQ_COLS} FROM ${ENQ_FROM} WHERE e.id = ANY($1::int[]) ORDER BY e.id`, [moved.map(m => m.id)]) : [];
    res.json({ rows: rows.map(present), skipped: await skippedOf(list, moved) });
  } catch (e) { next(e); }
});

// Final prices: [{ id, prices: [{ qty, final }] }]. Each is kept with the proposal it was set against.
r.put('/costing/enquiries/prices', async (req, res, next) => {
  try {
    const u = req.costingUser;
    const items = (Array.isArray(req.body?.items) ? req.body.items : []).slice(0, 200);
    const saved = [];
    await tx(async (qc, oc) => {
      for (const it of items) {
        const id = intOrNull(it?.id);
        if (!id) continue;
        const e = await oc(`SELECT e.id, e.enquiry_no, e.status, e.quantities::float8[] AS quantities, e.final_prices, e.quotation_id,
                                   c.complete AS costing_complete, c.inputs AS costing_inputs, qt.status AS quotation_status, qt.quotation_no
                              FROM enquiries e LEFT JOIN costings c ON c.id = e.costing_id LEFT JOIN quotations qt ON qt.id = e.quotation_id
                             WHERE e.id = $1 FOR UPDATE OF e`, [id]);
        if (!e) throw fail(404, 'No such enquiry.');
        if (!e.costing_complete) throw fail(409, `${e.enquiry_no} has no complete costing yet — finish its costing first.`);
        if (e.quotation_id && e.quotation_status !== 'cancelled') throw fail(409, `${e.enquiry_no} is on quotation ${e.quotation_no} — cancel that quotation before changing its price.`);
        if (['sent', 'dropped'].includes(e.status)) throw fail(409, `${e.enquiry_no} is ${STATUS_LABEL[e.status].toLowerCase()}.`);
        const rows = priceRows(e, e.costing_inputs);
        const kept = rows.map(row => {
          const given = (Array.isArray(it.prices) ? it.prices : []).find(p => Number(p?.qty) === row.qty);
          const final = given ? num(given.final) : row.final;
          if (given && !(final > 0)) throw fail(400, `${e.enquiry_no}: the final price for ${row.qty.toLocaleString('en-IN')} must be more than zero.`);
          const changedNow = given && final !== row.final;
          return final > 0 ? { qty: row.qty, final: Math.round(final * 1000) / 1000, proposed: changedNow ? row.proposed : (row.set_against ?? row.proposed) } : null;
        }).filter(Boolean);
        await qc(`UPDATE enquiries SET final_prices = $2, status = 'price_pending', finalised_by = NULL, finalised_by_name = NULL, finalised_at = NULL,
                         updated_at = now(), updated_by_name = $3 WHERE id = $1`, [id, JSON.stringify(kept), u.name]);
        await enquiryEvent(qc, { enquiryId: id, action: 'price', detail: { prices: kept } }, u);
        saved.push(e.enquiry_no);
      }
    });
    res.json({ saved });
  } catch (e) { next(e); }
});

// Finalise (Management right): every quantity has a final price, on a complete costing.
r.post('/costing/enquiries/finalise', async (req, res, next) => {
  try {
    const u = req.costingUser;
    needMgmt(u);
    const list = ids(req.body);
    const out = await tx(async (qc) => {
      const rows = await qc(`SELECT e.id, e.enquiry_no, e.status, e.quantities::float8[] AS quantities, e.final_prices, c.complete AS costing_complete, c.inputs AS costing_inputs
                               FROM enquiries e LEFT JOIN costings c ON c.id = e.costing_id WHERE e.id = ANY($1::int[]) FOR UPDATE OF e`, [list]);
      const done = [], refused = [];
      for (const e of rows) {
        const prices = priceRows(e, e.costing_complete ? e.costing_inputs : null);
        const why = e.status !== 'price_pending' ? `is ${STATUS_LABEL[stageOf(e.status, e.costing_complete)].toLowerCase()}`
          : !e.costing_complete ? 'has no complete costing'
            : !prices.length || prices.some(p => !(p.final > 0)) ? 'has a quantity without a final price' : null;
        if (why) { refused.push({ id: e.id, enquiry_no: e.enquiry_no, why }); continue; }
        await qc(`UPDATE enquiries SET status = 'quote_ready', finalised_by = $2, finalised_by_name = $3, finalised_at = now(), updated_at = now(), updated_by_name = $3
                   WHERE id = $1`, [e.id, u.id, u.name]);
        await enquiryEvent(qc, { enquiryId: e.id, action: 'finalise', detail: { prices: prices.map(p => ({ qty: p.qty, final: p.final, proposed: p.proposed })) } }, u);
        await audit('enquiry', e.id, 'finalise', e.enquiry_no, qc, u.name);
        done.push(e.enquiry_no);
      }
      return { done, refused };
    });
    res.json(out);
  } catch (e) { next(e); }
});

r.post('/costing/enquiries/reopen', async (req, res, next) => {
  try {
    const list = ids(req.body);
    const moved = await move(list, req.costingUser, {
      from: ['quote_ready'], to: 'price_pending', action: 'reopen',
      extra: `, finalised_by = NULL, finalised_by_name = NULL, finalised_at = NULL`,
    });
    // A row on a live quotation is not reopened (the quotation is cancelled first).
    res.json({ moved, skipped: await skippedOf(list, moved) });
  } catch (e) { next(e); }
});

// ── quotations ───────────────────────────────────────────────────────────────────────────────────
const QT_COLS = `qt.id, qt.quotation_no, qt.mailbox, qt.customer_id, qt.customer_name, qt.contact_name, qt.contact_email, qt.reply_mail_id,
  qt.lines, qt.total::float8 AS total, qt.terms, qt.email_subject, qt.email_opening, qt.email_closing, qt.status, qt.job_id,
  qt.gmail_draft_id, qt.gmail_draft_url, qt.gmail_message_id, qt.sent_to, qt.sent_at, qt.sent_by_name, qt.created_by_name, qt.created_at,
  qt.updated_by_name, qt.updated_at`;

// One quotation per customer, from Quotation-ready rows not already on a live quotation.
r.post('/costing/quotations', async (req, res, next) => {
  try {
    const u = req.costingUser;
    const list = ids(req.body);
    if (!list.length) throw fail(400, 'Tick the Quotation-ready enquiries to quote.');
    const made = await tx(async (qc, oc) => {
      await lockDocNumber('CI-QTN-', oc);
      const rows = await qc(`SELECT e.*, e.quantities::float8[] AS quantities, m.subject AS mail_subject, m.received_at AS mail_received_at
                               FROM enquiries e LEFT JOIN enquiry_mails m ON m.id = e.mail_id
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
        // The reply goes into the newest enquiry mail's thread of this customer.
        const mail = group.filter(e => e.mail_id).sort((a, b) => new Date(b.mail_received_at || 0) - new Date(a.mail_received_at || 0))[0];
        const trial = (await oc('SELECT send_to FROM enquiry_mailboxes WHERE key = $1', [mail?.mailbox || head.mailbox || 'trial']))?.send_to !== 'customers';
        const row = await oc(`
          INSERT INTO quotations (quotation_no, mailbox, customer_id, customer_name, contact_name, contact_email, reply_mail_id, lines, total,
                                  terms, email_subject, email_opening, email_closing, created_by, created_by_name, updated_by_name)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15) RETURNING id, quotation_no`,
        [no, mail?.mailbox || head.mailbox || null, head.customer_id, head.customer_name, head.contact_name, head.contact_email, mail?.mail_id ?? null,
          JSON.stringify(lines), total, s.terms, replySubject(mail?.mail_subject, no, trial), s.opening, s.closing, u.id, u.name]);
        await qc(`UPDATE enquiries SET quotation_id = $2, updated_at = now(), updated_by_name = $3 WHERE id = ANY($1::int[])`, [group.map(e => e.id), row.id, u.name]);
        for (const e of group) await enquiryEvent(qc, { enquiryId: e.id, quotationId: row.id, action: 'quotation', detail: { quotation_no: no } }, u);
        await enquiryEvent(qc, { quotationId: row.id, action: 'created', detail: { enquiries: group.map(e => e.enquiry_no), total } }, u);
        await audit('quotation', row.id, 'create', `${no} — ${group.length} item${group.length === 1 ? '' : 's'}`, qc, u.name);
        out.push(row);
      }
      return out;
    });
    res.status(201).json({ quotations: made });
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
r.post('/costing/quotations/:id/draft', async (req, res, next) => {
  try {
    const u = req.costingUser;
    const id = intOrNull(req.params.id) || 0;
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
    const job = await tx(async (qc, oc) => {
      const cur = await oc(`SELECT status FROM quotations WHERE id = $1 FOR UPDATE`, [id]);
      if (!['ready', 'drafted'].includes(cur?.status)) throw fail(409, `${qt.quotation_no} changed meanwhile — open it again.`);
      const j = await oc(`INSERT INTO enquiry_jobs (kind, mailbox, mailbox_email, quotation_id, brief, attachment, attachment_name, attachment_sha256, queued_by, queued_by_name)
                          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      ['draft', box.key, box.email, id, brief, pdf, `${qt.quotation_no}.pdf`, sha, u.id, u.name]);
      await qc(`UPDATE quotations SET status = 'queued', job_id = $2, updated_at = now(), updated_by_name = $3 WHERE id = $1`, [id, j.id, u.name]);
      await enquiryEvent(qc, { quotationId: id, action: 'draft', detail: { job: j.id, to: brief.to, trial: brief.trial, replaces_draft: qt.gmail_draft_id || null } }, u);
      await audit('quotation', id, 'draft', `${qt.quotation_no} — job ${j.id}`, qc, u.name);
      return j;
    });
    const fired = await startClaude(job.id, 'draft', box.email);
    res.status(201).json({ job: await jobById(job.id), fired, quotation: await quotationById(id) });
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

r.post('/costing/quotations/:id/cancel', async (req, res, next) => {
  try {
    const u = req.costingUser;
    const id = intOrNull(req.params.id) || 0;
    await tx(async (qc, oc) => {
      const qt = await oc(`UPDATE quotations SET status = 'cancelled', updated_at = now(), updated_by_name = $2
                            WHERE id = $1 AND status IN ('ready', 'drafted') RETURNING id, quotation_no, gmail_draft_id`, [id, u.name]);
      if (!qt) throw fail(409, 'Only a quotation not yet sent (or queued to send) can be cancelled.');
      await qc(`UPDATE enquiries SET quotation_id = NULL, updated_at = now(), updated_by_name = $2 WHERE quotation_id = $1`, [id, u.name]);
      await enquiryEvent(qc, { quotationId: id, action: 'cancelled', detail: qt.gmail_draft_id ? { note: 'The draft left in Gmail can be discarded there.' } : null }, u);
      await audit('quotation', id, 'cancel', qt.quotation_no, qc, u.name);
    });
    res.json(await quotationById(id));
  } catch (e) { next(e); }
});

export default r;
