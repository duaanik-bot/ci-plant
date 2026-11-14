// Enquiries from the company mailbox, filed by the office AVS (owner, 13 Nov 2026: "take the costings in its run from
// mppchd mail, put them into the ERP system, and also give the notification"; asked how the two mailboxes work
// together, "Both, each mail once").
//
// The office AVS (the company Mac) reads the business mailbox four times a day and, by its own rules, writes nothing
// but avs tables. So it writes each price request or counter-offer it finds into avs.enquiry_intake (the skill
// skills/avs-enquiries/SKILL.md), and CI Plant copies it onto the Enquiry desk here — started by the database the
// moment the row lands (pg_net → POST /api/avs/robot/enquiries-notify, migration 20261113180100_avs_enquiry_intake),
// and by the two-minute /drafts/summary poll of any open CI Plant if that call was lost.
//
// Each mail once: CI Plant refuses a mail it already holds from the other mailbox (sameMailOnDesk), both ways. Since 14
// Nov the company mailbox is the desk's mailbox ("just keep it on MPP only"): AVS files everything that reaches it, and
// the trial mailbox is fetched only on "Fetch from dua.anik". An item a customer only asks for again while it is open
// marks that row instead of adding one (routes/enquiries.js askedAgain).
//
// The alert: every mail filed on the desk — a new enquiry or a counter-offer, from either mailbox — is announced once
// (enquiry_mails.alerted_at) to every login with Costing ticked, in one bell row and phone push per batch. No price, no
// customer figure, no customer address in the words.
import { one, tx } from './db.js';
import { audit, notify, lockDocNumber } from './helpers.js';
import { cleanMail, unreadItem } from './enquiry-desk.js';
import { num } from './costing-engine.js';
import { mayCost } from './costing-match.js';
import { insertEnquiry, resolveCustomer, enquiryEvent, lockRows, recordCounter, newGroup, askedAgain } from './routes/enquiries.js';

export const AVS_RUNNER = 'AVS (office)';
const MISSING = new Set(['42P01', '3F000']);
const PRINT_CHARS = 1500;

// A mail's text as compared across mailboxes: case and spacing do not count. An empty mail has no print, and an empty
// print matches nothing (two attachment-only mails are not the same mail).
export function bodyPrint(text) {
  return String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, PRINT_CHARS);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const who = m => m.customer || 'a customer';

// The alert's words for the mails being announced: [{ mail_id, kind: 'enquiry'|'counter'|'again', customer,
// mailbox_email, rows: [{ id, product_name, enquiry_no }] }]. Pure, so it is tested.
export function newEnquiryAlert(mails) {
  if (mails.length === 1) {
    const m = mails[0];
    const names = m.rows.slice(0, 3).map(r => r.product_name).filter(Boolean).join(', ');
    const more = m.rows.length > 3 ? ` +${m.rows.length - 3} more` : '';
    const counter = m.kind === 'counter';
    const again = m.kind === 'again';
    return {
      title: `${counter ? 'Counter-offer' : again ? 'Asked again' : 'New enquiry'}: ${who(m)} — ${plural(m.rows.length, 'item')}`,
      body: counter
        ? `Their own prices for ${names}${more} · to ${m.mailbox_email}. Revise them on the Enquiry desk's Counter tab.`
        : again
          ? `${names}${more} · already on the desk as ${m.rows.map(r => r.enquiry_no).filter(Boolean).join(', ')}. Answer it there.`
          : `${names}${more} · to ${m.mailbox_email}. Cost it on the Enquiry desk.`,
      link: `/costing?tab=enquiries${m.rows[0] ? `&enquiry=${m.rows[0].id}` : ''}`,
      refTable: 'enquiry_mails', refId: m.mail_id,
    };
  }
  const list = kind => mails.filter(m => m.kind === kind).map(m => `${who(m)} (${plural(m.rows.length, 'item')})`).join(', ');
  const fresh = list('enquiry');
  const counters = list('counter');
  const again = list('again');
  return {
    title: `${mails.length} mails on the Enquiry desk`,
    body: [fresh && `New: ${fresh}.`, counters && `Counter-offer: ${counters}.`, again && `Asked again: ${again}.`].filter(Boolean).join(' '),
    link: '/costing?tab=enquiries',
    // A distinct key per batch, so a later batch never replaces this one on a lock screen.
    refTable: 'enquiry_mails', refId: Math.max(...mails.map(m => m.mail_id)),
  };
}

// ── the same mail through the other mailbox ──────────────────────────────────────────────────────────────────────
// A customer who writes to both mailboxes sends one mail to each. AVS leaves such a mail to the trial mailbox's robot
// (it sees the address in To/Cc); a Bcc it cannot see, so CI Plant checks both ways. The same mail = the same sender,
// subject, words and attachments, arriving within two hours of each other. Anything less is two mails: a short "PFA,
// kindly quote" sent twice with other files is two requests, and a mail lost is worse than one shown twice (review,
// 13 Nov 2026). Compared here in JavaScript, not in SQL: the plant database's SQL_ASCII encoding lower-cases and splits
// spaces byte by byte.
export const SAME_MAIL_HOURS = 2;
const flat = v => String(v ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const fileNames = list => (Array.isArray(list) ? list : []).map(a => flat(a?.name ?? a)).filter(Boolean).sort().join('|');
const timeOf = v => (v ? new Date(v).getTime() : NaN);
export function sameMail(a, b) {
  const print = bodyPrint(a?.body_text);
  if (!print || print !== bodyPrint(b?.body_text)) return false;
  if (!flat(a.from_email) || flat(a.from_email) !== flat(b.from_email)) return false;
  if (flat(a.subject) !== flat(b.subject) || fileNames(a.attachments) !== fileNames(b.attachments)) return false;
  const ta = timeOf(a.received_at), tb = timeOf(b.received_at);
  return Number.isFinite(ta) && Number.isFinite(tb) && Math.abs(ta - tb) <= SAME_MAIL_HOURS * 3600e3;
}

// The mail already on the desk from ANOTHER mailbox that is this one, or null. Run it under the CI-ENQ- numbering lock
// (both filers take it first), so a copy being filed at that moment is seen once it is committed.
export async function sameMailOnDesk(qc, m, mailboxEmail) {
  const at = timeOf(m.received_at);
  if (!bodyPrint(m.body_text) || !m.from_email || !Number.isFinite(at)) return null;
  const near = await qc(`
    SELECT m.id, m.mailbox, m.mailbox_email, m.subject, m.from_email, m.received_at, m.body_text, m.attachments,
           (SELECT array_agg(e.enquiry_no ORDER BY e.id) FROM enquiries e WHERE e.mail_id = m.id) AS nos
      FROM enquiry_mails m
     WHERE m.mailbox_email <> $1 AND lower(m.from_email) = lower($2)
       AND m.received_at BETWEEN $3::timestamptz - make_interval(hours => $4) AND $3::timestamptz + make_interval(hours => $4)
     ORDER BY m.id DESC LIMIT 50`, [mailboxEmail, m.from_email, new Date(at).toISOString(), SAME_MAIL_HOURS]);
  const hit = near.find(x => sameMail(x, m));
  return hit ? { mail_id: hit.id, mailbox: hit.mailbox, mailbox_email: hit.mailbox_email, enquiry_nos: hit.nos || [] } : null;
}
export const sameMailWhy = s => `already on the desk from ${s.mailbox_email}${s.enquiry_nos.length ? ` as ${s.enquiry_nos.join(', ')}` : ''}`;

// ── the copier: avs.enquiry_intake → the Enquiry desk ────────────────────────────────────────────────────────────
const MAIL_INSERT = `
  INSERT INTO enquiry_mails (mailbox, mailbox_email, gmail_message_id, gmail_thread_id, subject, from_name, from_email, to_text,
                             received_at, body_text, attachments, view_url, summary, job_id)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NULL)
  ON CONFLICT (mailbox_email, gmail_message_id) DO NOTHING RETURNING id`;
const mailArgs = (box, m, summary) => [box.key, box.email, m.gmail_message_id, m.gmail_thread_id, m.subject, m.from_name, m.from_email,
  m.to_text, m.received_at, m.body_text, JSON.stringify(m.attachments), m.view_url, summary ?? m.summary];
const answer = (status, result) => ({ status, result });

async function fileEnquiry(qc, oc, row, box, m) {
  const mail = await oc(MAIL_INSERT, mailArgs(box, m));
  if (!mail) return answer('skipped', { why: 'filed before' });
  const who = {
    ...(await resolveCustomer(oc, { customer_name: m.customer_name, contact_email: m.contact_email })),
    mail_id: mail.id, mailbox: box.key, contact_name: m.contact_name, contact_email: m.contact_email, source: 'robot', by: AVS_RUNNER,
  };
  const made = [], again = [];
  for (const item of m.items.length ? m.items : [unreadItem(m.subject, 'AVS')]) {
    // Asked again for an item still open on the desk: that row is marked, no new row (14 Nov 2026).
    const prior = m.items.length ? await askedAgain(qc, item, who, mail.id, AVS_RUNNER) : null;
    if (prior) { again.push(prior.enquiry_no); continue; }
    const e = await insertEnquiry(qc, oc, item, who, null);
    await enquiryEvent(qc, { enquiryId: e.id, action: 'fetched', detail: { intake: Number(row.id) } }, { name: AVS_RUNNER });
    made.push(e.enquiry_no);
  }
  await audit('enquiry_intake', row.id, 'file', `AVS intake ${row.id} — ${made.length} enquir${made.length === 1 ? 'y' : 'ies'} filed`
    + `${again.length ? `, ${again.length} asked again` : ''}`, qc, AVS_RUNNER);
  return answer('filed', { enquiries: made, asked_again: again, mail_id: mail.id });
}

// One row's prices from a counter-offer, read as the robot route reads them ("5,000" is 5000).
export const counterPrices = (list, no) => list.filter(c => String(c?.enquiry_no ?? '').trim() === no)
  .map(c => ({ qty: num(c.qty), theirs: c.theirs }));

// A counter-offer: their prices on rows of the business mailbox we priced or quoted (the robot route's rules).
async function fileCounter(qc, oc, row, box, m) {
  const list = (Array.isArray(row.counters) ? row.counters : []).slice(0, 100);
  const nos = [...new Set(list.map(c => String(c?.enquiry_no || '').trim()).filter(Boolean))];
  if (!nos.length) return answer('refused', { why: 'a counter-offer names no enquiry' });
  const mail = (await oc(MAIL_INSERT, mailArgs(box, m, m.summary || 'Customer counter-offer')))
    || await oc('SELECT id FROM enquiry_mails WHERE mailbox_email = $1 AND gmail_message_id = $2', [box.email, m.gmail_message_id]);
  const found = await oc('SELECT array_agg(id) AS ids FROM enquiries WHERE enquiry_no = ANY($1::text[]) AND mailbox = $2', [nos, box.key]);
  const rows = await lockRows(qc, found?.ids || []);
  const user = { name: AVS_RUNNER };
  const group = newGroup();
  const counters = [], refused = [];
  for (const no of nos) {
    const e = rows.find(x => x.enquiry_no === no);
    if (!e) { refused.push({ enquiry_no: no, why: 'no such enquiry in the business mailbox' }); continue; }
    const prices = counterPrices(list, no);
    const r = await recordCounter(qc, e, prices, { mailId: mail.id, user, group, source: 'avs' });
    if (r.why) refused.push({ enquiry_no: no, why: r.why }); else counters.push(no);
  }
  if (counters.length) await audit('enquiry_intake', row.id, 'counter', `AVS intake ${row.id} — counter for ${counters.length} enquir${counters.length === 1 ? 'y' : 'ies'}`, qc, AVS_RUNNER);
  return answer(counters.length ? 'filed' : 'refused', { counters, refused, mail_id: mail.id });
}

async function fileIntakeRow(qc, oc, row, box) {
  if (!box?.email) return answer('refused', { why: 'the desk has no business mailbox' });
  // The numbering lock FIRST, as the robot route takes it before its checks: a copy of this mail the Mac robot is
  // filing right now is committed (and seen below) before this row is looked at (review, 13 Nov 2026).
  await lockDocNumber('CI-ENQ-', oc);
  if (String(row.mailbox_email || '').trim().toLowerCase() !== box.email.toLowerCase()) {
    return answer('refused', { why: `only the business mailbox (${box.email}) is filed this way` });
  }
  const m = cleanMail({ ...row, attachments: row.attachments || [], items: row.items || [] });
  if (m.error) return answer('refused', { why: m.error });
  if (await oc('SELECT 1 AS y FROM enquiry_mails WHERE mailbox_email = $1 AND gmail_message_id = $2', [box.email, m.gmail_message_id])) {
    return answer('skipped', { why: 'filed before' });
  }
  const same = await sameMailOnDesk(qc, m, box.email);
  if (same) return answer('skipped', { why: sameMailWhy(same), mail_id: same.mail_id, enquiries: same.enquiry_nos });
  return row.kind === 'counter' ? fileCounter(qc, oc, row, box, m) : fileEnquiry(qc, oc, row, box, m);
}

// Copies the waiting rows, each in its own transaction, so one bad row never holds the rest: a row two callers reach
// at once is taken by one (SKIP LOCKED); a row that fails is refused with the reason and never retried in a loop; a
// passing database trouble (a deadlock, a lock wait, a cancelled statement) leaves the row waiting for the next call.
export const MAX_PER_CALL = 100;
const PASSING = new Set(['40001', '40P01', '55P03', '57014']);
export async function syncIntakeEnquiries({ max = MAX_PER_CALL } = {}) {
  const out = { filed: [], skipped: [], refused: [] };
  const box = await one(`SELECT key, email FROM enquiry_mailboxes WHERE key = 'business'`);
  for (let n = 0; n < max; n++) {
    let done;
    try {
      done = await tx(async (qc, oc) => {
        const row = await oc(`SELECT * FROM avs.enquiry_intake WHERE status = 'new' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`);
        if (!row) return null;
        await qc('SAVEPOINT intake_row');
        let a;
        try {
          a = await fileIntakeRow(qc, oc, row, box);
        } catch (e) {
          if (PASSING.has(e?.code)) throw e;
          await qc('ROLLBACK TO SAVEPOINT intake_row');
          a = answer('refused', { why: String(e?.message || e).slice(0, 300) });
        }
        await qc('UPDATE avs.enquiry_intake SET status = $2, handled_at = now(), result = $3 WHERE id = $1', [row.id, a.status, a.result]);
        return { id: Number(row.id), gmail_message_id: row.gmail_message_id, kind: row.kind, ...a };
      });
    } catch (e) {
      if (PASSING.has(e?.code)) { console.warn(`[enquiry-intake] left for the next call: ${e.message}`); break; }
      throw e;
    }
    if (!done) break;
    out[done.status === 'filed' ? 'filed' : done.status].push(done);
  }
  return out;
}

// For readers (the two-minute /drafts/summary poll): copy only when something waits, a few rows at a time (the poll's
// answer is not held up for long; the database's own call takes the rest), and never fail the read.
const SOFT_MAX = 10;
export async function syncIntakeEnquiriesSoft() {
  const none = { filed: [], skipped: [], refused: [] };
  try {
    if (!await one(`SELECT 1 AS y FROM avs.enquiry_intake WHERE status = 'new' LIMIT 1`)) return none;
    const out = await syncIntakeEnquiries({ max: SOFT_MAX });
    await notifyNewEnquiriesSoft();
    return out;
  } catch (e) {
    if (!MISSING.has(e?.code)) console.warn(`[enquiry-intake] ${e.message}`);
    return none;
  }
}

// ── the alert ────────────────────────────────────────────────────────────────────────────────────────────────────
// The mails nobody has been told about yet are claimed (enquiry_mails.alerted_at, SKIP LOCKED), so however many callers
// race, each mail is announced once; a mail that put nothing on the desk (a counter whose rows were all refused) is
// stamped too, and never looked at again. Who hears it: every active login with Costing ticked.
export async function notifyNewEnquiries() {
  return tx(async (qc) => {
    const mails = await qc(`SELECT id, mailbox_email FROM enquiry_mails WHERE alerted_at IS NULL
                             ORDER BY id LIMIT 200 FOR UPDATE SKIP LOCKED`);
    if (!mails.length) return { announced: 0 };
    const ids = mails.map(m => m.id);
    await qc('UPDATE enquiry_mails SET alerted_at = now() WHERE id = ANY($1::int[])', [ids]);
    const rows = await qc(`SELECT id, enquiry_no, product_name, customer_name, mail_id, counter_mail_id, asked_again_mail_id FROM enquiries
                            WHERE mail_id = ANY($1::int[]) OR counter_mail_id = ANY($1::int[]) OR asked_again_mail_id = ANY($1::int[])
                            ORDER BY id`, [ids]);
    const told = [];
    for (const m of mails) {
      const fresh = rows.filter(e => e.mail_id === m.id);
      const countered = rows.filter(e => e.counter_mail_id === m.id && e.mail_id !== m.id);
      const again = rows.filter(e => e.asked_again_mail_id === m.id && e.mail_id !== m.id);
      const [kind, list] = fresh.length ? ['enquiry', fresh] : countered.length ? ['counter', countered] : ['again', again];
      if (!list.length) continue;
      told.push({ mail_id: m.id, kind, customer: list[0].customer_name, mailbox_email: m.mailbox_email, rows: list });
    }
    if (!told.length) return { announced: 0 };
    const users = (await qc('SELECT id, role, modules FROM users WHERE active = 1')).filter(u => mayCost(u));
    await notify(users.map(u => u.id), { kind: 'new_enquiry', ...newEnquiryAlert(told) }, qc);
    return { announced: told.length, users: users.length };
  });
}

// Never lets an alert problem fail the filing that called it.
export async function notifyNewEnquiriesSoft() {
  try {
    return await notifyNewEnquiries();
  } catch (e) {
    console.warn(`[enquiry-intake] alert: ${e.message}`);
    return { announced: 0 };
  }
}
