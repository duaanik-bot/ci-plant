// Artwork mails from the company mailbox, filed by the office AVS (Artwork Manager P1; owner's brief of 14 Nov 2026:
// "identify new artwork and revisions received by email … record the client, job or order, date, version, and relevant
// email thread … keep revisions linked to the original job and avoid losing earlier versions").
//
// The office AVS reads the business mailbox four times a day and, by its own rules, writes nothing but avs tables. So
// it writes each artwork mail into avs.artwork_intake (skills/avs-artwork/SKILL.md), and CI Plant copies it into the
// artwork register here — started by the database the moment the row lands (pg_net → POST
// /api/avs/robot/artwork-notify, migration 20261115100100_avs_artwork_intake), and by the two-minute /drafts/summary
// poll of any open CI Plant if that call was lost. The same shape as the enquiry intake (enquiry-intake.js).
//
// What a mail becomes: one artwork_mails row, and for each item in it a job (one per customer and item code) and a
// version under it — or, when the very same files are already a version, one more line in that version's history
// (artwork-register.js holds the rules). A mail AVS could not classify is filed "to sort", never dropped.
//
// P1 registers and files. It checks nothing, drafts nothing and touches no order line. What the designer already did
// (their copy of a file, their reply in the thread) is recorded as AVS saw it (17 Nov 2026), and artwork-notice.js tells
// the two company mailboxes what the system did.
import { one, tx } from './db.js';
import { audit, notify, nextNumber } from './helpers.js';
import { canAccess } from '../../client/src/modules.js';
import { resolveCustomer } from './routes/enquiries.js';
import { artworkNoticeSoft, noticeWorkWaiting } from './artwork-notice.js';
import { parseItemCode, productFromFileName, sourcePrint, placeVersion, versionLabel, jobKey } from './artwork-register.js';

export const AVS_RUNNER = 'AVS (office)';
export const JOB_PREFIX = 'CI-AW-';
export const mayArtwork = u => !!u && canAccess(u, 'artwork');
const MISSING = new Set(['42P01', '3F000']);

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const who = m => m.customer || 'a customer';
const list = v => (Array.isArray(v) ? v : []);
const text = v => String(v ?? '').trim();

// The alert's words for the mails being announced: [{ mail_id, customer, rows: [{ job_no, label, product_name, fresh }] }]
// — fresh = the job's first version. Pure, so it is tested. No file name, no customer address in the words.
export function newArtworkAlert(mails) {
  if (mails.length === 1) {
    const m = mails[0];
    const names = m.rows.slice(0, 3).map(r => `${[r.job_no, r.product_name].filter(Boolean).join(' ')} (${r.label})`).join(', ');
    const more = m.rows.length > 3 ? ` +${m.rows.length - 3} more` : '';
    return {
      title: `${m.rows.some(r => r.fresh) ? 'New artwork' : 'Revised artwork'}: ${who(m)} — ${plural(m.rows.length, 'item')}`,
      body: `${names}${more}. Open the Artwork register.`,
      link: '/artwork?tab=register',
      refTable: 'artwork_mails', refId: m.mail_id,
    };
  }
  return {
    title: `${mails.length} artwork mails in the register`,
    body: `${mails.map(m => `${who(m)} (${plural(m.rows.length, 'item')})`).join(', ')}.`,
    link: '/artwork?tab=register',
    // A distinct key per batch, so a later batch never replaces this one on a lock screen.
    refTable: 'artwork_mails', refId: Math.max(...mails.map(m => m.mail_id)),
  };
}

// An item's code, revision, pack and product name: what AVS read, else what its file names say. The subject names the
// job only when the mail carries ONE item — in a mail of several, or a reply whose subject still carries an old code,
// an item with no code of its own would otherwise be filed as a version of the wrong job. A code AVS read that is not
// in the usual pattern (another customer's numbering) is kept as written.
export function itemIdentity(item, subject, alone = true) {
  const it = item && typeof item === 'object' ? item : {};
  const given = parseItemCode(`${text(it.client_item_code)} ${text(it.client_rev)}`);
  const named = parseItemCode(list(it.files).map(f => text(f?.file_name)).join(' | '));
  const subj = alone ? parseItemCode(subject) : { code: null, rev: null, pack: null };
  const from = given.code ? given : named.code ? named : subj;
  const rev = text(it.client_rev).toUpperCase();
  return {
    code: given.code || text(it.client_item_code).toUpperCase() || from.code,
    rev: /^R\d{1,2}$/.test(rev) ? rev : (from.rev || ''),
    pack: text(it.pack_type).toLowerCase() || from.pack || null,
    product: text(it.product_name) || list(it.files).map(f => productFromFileName(f?.file_name)).find(Boolean) || '',
  };
}

// A web address worth keeping as a link. These come from customers' mail: anything that is not http(s) is dropped, so
// nothing else can ever be rendered as a link.
export const safeUrl = v => (/^https?:\/\//i.test(text(v)) ? text(v) : null);
const wholeNumber = v => (Number.isFinite(Number(v)) && text(v) !== '' ? Math.round(Number(v)) : null);

// A time AVS wrote, or nothing: a value Postgres would refuse never stops the mail being filed.
const whenOf = v => { const t = Date.parse(text(v)); return Number.isFinite(t) ? new Date(t).toISOString() : null; };

const extOf = name => (/\.([a-z0-9]{1,5})$/i.exec(text(name))?.[1] ?? '').toLowerCase() || null;

// Our product for a customer's item code, when the AVS intake has mapped that code to exactly one product
// (avs.artwork_codes). None, several, or no such table: left for a person. Compared in JavaScript (SQL_ASCII).
async function productForCode(qc, code) {
  if (!code) return null;
  let rows;
  try {
    await qc('SAVEPOINT artwork_codes');
    rows = await qc(`SELECT a.product_id, a.item_code, p.name FROM avs.artwork_codes a JOIN products p ON p.id = a.product_id
                      WHERE a.item_code IS NOT NULL`);
    await qc('RELEASE SAVEPOINT artwork_codes');
  } catch (e) {
    if (!MISSING.has(e?.code)) throw e;
    await qc('ROLLBACK TO SAVEPOINT artwork_codes');
    return null;
  }
  const want = code.toLowerCase();
  const hits = new Map(rows.filter(r => text(r.item_code).toLowerCase() === want).map(r => [r.product_id, r.name]));
  if (hits.size !== 1) return null;
  const [[product_id, product_name]] = hits;
  return { product_id, product_name };
}

const answer = (status, result) => ({ status, result });

// One avs.artwork_intake row → the register. Runs inside the caller's transaction and savepoint.
async function fileIntakeRow(qc, oc, row) {
  const mail = await oc(`
    INSERT INTO artwork_mails (mailbox_email, gmail_message_id, gmail_thread_id, subject, from_name, from_email, to_text,
                               received_at, body_text, attachments, view_url, summary)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    ON CONFLICT (mailbox_email, gmail_message_id) DO NOTHING RETURNING id`,
  [row.mailbox_email, row.gmail_message_id, row.gmail_thread_id, row.subject, row.from_name, row.from_email, row.to_text,
    row.received_at, row.body_text, JSON.stringify(list(row.attachments)), safeUrl(row.view_url), row.summary]);
  if (!mail) return answer('skipped', { why: 'filed before' });

  const cust = await resolveCustomer(oc, { customer_name: row.customer_name, contact_email: row.from_email });
  const items = (list(row.items).length ? list(row.items) : [{}]).map(i => (i && typeof i === 'object' && !Array.isArray(i) ? i : {}));
  // One job per customer in the master (by id, so a renamed customer keeps its jobs); by name where the master has none.
  const custKey = cust.customer_id ? `#${cust.customer_id}` : cust.customer_name;
  const jobs = [], versions = [];
  let again = 0;

  for (const [index, item] of items.entries()) {
    const id = itemIdentity(item, row.subject, items.length === 1);
    const unsorted = row.kind === 'to_sort' || (!id.code && !id.product);
    const key = unsorted
      ? `${jobKey(custKey, null, '')}sort:${row.mailbox_email}:${row.gmail_message_id}:${index}`
      : jobKey(custKey, id.code, id.product);

    let job = await oc('SELECT id, job_no FROM artwork_jobs WHERE job_key = $1 FOR UPDATE', [key]);
    if (!job) {
      const mapped = unsorted ? null : await productForCode(qc, id.code);
      const no = await nextNumber(JOB_PREFIX, 'artwork_jobs', 'job_no', oc);
      // taken again under the numbering lock: two callers filing the same new job at once make it once
      job = await oc('SELECT id, job_no FROM artwork_jobs WHERE job_key = $1 FOR UPDATE', [key])
        ?? await oc(`INSERT INTO artwork_jobs (job_no, job_key, customer_id, customer_name, client_item_code, product_id, product_name, pack_type, to_sort)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, job_no`,
        [no, key, cust.customer_id, cust.customer_name, id.code, mapped?.product_id ?? null,
          mapped?.product_name ?? (id.product || (unsorted ? text(row.subject) : '')) ?? null, id.pack, unsorted]);
    }
    jobs.push(job.job_no);

    const files = list(item.files).filter(f => f && typeof f === 'object'), links = list(item.links).map(safeUrl).filter(Boolean);
    const print = sourcePrint(files);
    const have = await qc('SELECT id, client_rev, receipt_no, source_print FROM artwork_versions WHERE job_id = $1 ORDER BY id', [job.id]);
    const place = placeVersion(have, { client_rev: id.rev, source_print: print });

    if (place.sameAs) {
      again += 1;
      await qc(`INSERT INTO artwork_events (job_id, version_id, mail_id, action, detail, by_name) VALUES ($1, $2, $3, 'received_again', $4, $5)`,
        [job.id, place.sameAs, mail.id, JSON.stringify({ intake: Number(row.id) }), AVS_RUNNER]);
      continue;
    }
    const label = versionLabel(id.rev, place.receipt_no);
    const saved = files.some(f => text(f?.drive_file_id));
    const v = await oc(`
      INSERT INTO artwork_versions (job_id, client_rev, receipt_no, label, variant, source_print, status, first_mail_id, received_at, designer_reply_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [job.id, id.rev, place.receipt_no, label, text(item.variant) || null, print, saved ? 'received' : 'file_to_fetch', mail.id, row.received_at,
      whenOf(item.designer_reply_at)]);
    for (const f of files) {
      // saved_by 'designer': AVS found the designer's own copy on Drive and saved no second one (drive_url = their copy)
      await qc(`INSERT INTO artwork_files (version_id, file_name, ext, size_bytes, sha256, drive_file_id, drive_url, saved_by)
                VALUES ($1, $2, $3, $4::bigint, $5, $6, $7, $8)`,
      [v.id, text(f.file_name) || null, extOf(f.file_name), wholeNumber(f.size_bytes), text(f.sha256).toLowerCase() || null,
        text(f.drive_file_id) || null, safeUrl(f.drive_url), text(f.saved_by).toLowerCase() === 'designer' ? 'designer' : 'system']);
    }
    for (const url of links) await qc('INSERT INTO artwork_files (version_id, link_url) VALUES ($1, $2)', [v.id, url]);
    await qc(`INSERT INTO artwork_events (job_id, version_id, mail_id, action, detail, by_name) VALUES ($1, $2, $3, 'received', $4, $5)`,
      [job.id, v.id, mail.id, JSON.stringify({ intake: Number(row.id), files: files.length, links: links.length }), AVS_RUNNER]);
    versions.push(label);
  }
  await audit('artwork_intake', row.id, 'file',
    `AVS intake ${row.id} — ${plural(versions.length, 'version')} filed${again ? `, ${again} received again` : ''} (${[...new Set(jobs)].join(', ')})`, qc, AVS_RUNNER);
  return answer('filed', { jobs: [...new Set(jobs)], versions, received_again: again, mail_id: mail.id });
}

// A mail whose items could not be written is not left where nobody sees it: the mail itself is put in the register
// "to sort", with what went wrong, so a person opens it. (The intake row's result carries the same words.)
async function fileBareMail(qc, oc, row, problem) {
  const mail = await oc(`
    INSERT INTO artwork_mails (mailbox_email, gmail_message_id, gmail_thread_id, subject, from_name, from_email, to_text,
                               received_at, body_text, attachments, view_url, summary)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '[]'::jsonb, $10, $11)
    ON CONFLICT (mailbox_email, gmail_message_id) DO NOTHING RETURNING id`,
  [row.mailbox_email, row.gmail_message_id, row.gmail_thread_id, row.subject, row.from_name, row.from_email, row.to_text,
    row.received_at, row.body_text, safeUrl(row.view_url), row.summary]);
  if (!mail) return answer('skipped', { why: 'filed before' });
  const no = await nextNumber(JOB_PREFIX, 'artwork_jobs', 'job_no', oc);
  const job = await oc(`INSERT INTO artwork_jobs (job_no, job_key, customer_name, product_name, to_sort) VALUES ($1, $2, $3, $4, true) RETURNING id, job_no`,
    [no, `|sort:${row.mailbox_email}:${row.gmail_message_id}:problem`, text(row.customer_name) || null, text(row.subject) || '(no subject)']);
  const v = await oc(`INSERT INTO artwork_versions (job_id, client_rev, receipt_no, label, status, first_mail_id, received_at)
                      VALUES ($1, '', 1, 'v1', 'file_to_fetch', $2, $3) RETURNING id`, [job.id, mail.id, row.received_at]);
  await qc(`INSERT INTO artwork_events (job_id, version_id, mail_id, action, detail, by_name) VALUES ($1, $2, $3, 'received', $4, $5)`,
    [job.id, v.id, mail.id, JSON.stringify({ intake: Number(row.id), problem }), AVS_RUNNER]);
  await audit('artwork_intake', row.id, 'file', `AVS intake ${row.id} — filed to sort as ${job.job_no}; its items could not be written: ${problem}`, qc, AVS_RUNNER);
  return answer('filed', { jobs: [job.job_no], versions: ['v1'], received_again: 0, mail_id: mail.id, problem });
}

// Copies the waiting rows, each in its own transaction, so one bad row never holds the rest: a row two callers reach
// at once is taken by one (SKIP LOCKED); a row whose items fail is filed as the bare mail "to sort" (and refused with the
// reason only if even that fails), never retried in a loop; a
// passing database trouble (a deadlock, a lock wait, a cancelled statement) leaves the row waiting for the next call.
export const MAX_PER_CALL = 100;
const PASSING = new Set(['40001', '40P01', '55P03', '57014']);
export async function syncIntakeArtwork({ max = MAX_PER_CALL } = {}) {
  const out = { filed: [], skipped: [], refused: [] };
  for (let n = 0; n < max; n++) {
    let done;
    try {
      done = await tx(async (qc, oc) => {
        const row = await oc(`SELECT * FROM avs.artwork_intake WHERE status = 'new' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`);
        if (!row) return null;
        await qc('SAVEPOINT intake_row');
        let a;
        try {
          a = await fileIntakeRow(qc, oc, row);
        } catch (e) {
          if (PASSING.has(e?.code)) throw e;
          await qc('ROLLBACK TO SAVEPOINT intake_row');
          const why = String(e?.message || e).slice(0, 300);
          try {
            a = await fileBareMail(qc, oc, row, why);
          } catch (e2) {
            if (PASSING.has(e2?.code)) throw e2;
            await qc('ROLLBACK TO SAVEPOINT intake_row');
            a = answer('refused', { why });
          }
        }
        await qc('UPDATE avs.artwork_intake SET status = $2, handled_at = now(), result = $3 WHERE id = $1', [row.id, a.status, a.result]);
        return { id: Number(row.id), gmail_message_id: row.gmail_message_id, kind: row.kind, ...a };
      });
    } catch (e) {
      if (PASSING.has(e?.code)) { console.warn(`[artwork-intake] left for the next call: ${e.message}`); break; }
      throw e;
    }
    if (!done) break;
    out[done.status].push(done);
  }
  return out;
}

// For readers (the two-minute /drafts/summary poll): copy only when something waits, a few rows at a time, and never
// fail the read.
const SOFT_MAX = 10;
export async function syncIntakeArtworkSoft() {
  const none = { filed: [], skipped: [], refused: [] };
  try {
    if (!await one(`SELECT 1 AS y FROM avs.artwork_intake WHERE status = 'new' LIMIT 1`)) {
      // nothing new to file — but a notice may still be waiting for mppchd's Gmail, or due a retry
      if (await noticeWorkWaiting()) await artworkNoticeSoft();
      return none;
    }
    const out = await syncIntakeArtwork({ max: SOFT_MAX });
    await notifyNewArtworkSoft();
    await artworkNoticeSoft();
    return out;
  } catch (e) {
    if (!MISSING.has(e?.code)) console.warn(`[artwork-intake] ${e.message}`);
    return none;
  }
}

// ── the alert ────────────────────────────────────────────────────────────────────────────────────────────────────
// The mails nobody has been told about yet are claimed (artwork_mails.alerted_at, SKIP LOCKED), so however many callers
// race, each mail is announced once. A mail that only re-sent files the register already holds is stamped and not
// announced: it is not news. Who hears it: every active login with Artwork ticked.
export async function notifyNewArtwork() {
  return tx(async (qc) => {
    const mails = await qc(`SELECT id FROM artwork_mails WHERE alerted_at IS NULL ORDER BY id LIMIT 200 FOR UPDATE SKIP LOCKED`);
    if (!mails.length) return { announced: 0 };
    const ids = mails.map(m => m.id);
    await qc('UPDATE artwork_mails SET alerted_at = now() WHERE id = ANY($1::int[])', [ids]);
    const rows = await qc(`
      SELECT e.mail_id, j.job_no, j.customer_name, j.product_name, v.label,
             v.id = (SELECT min(x.id) FROM artwork_versions x WHERE x.job_id = j.id) AS fresh
        FROM artwork_events e JOIN artwork_versions v ON v.id = e.version_id JOIN artwork_jobs j ON j.id = v.job_id
       WHERE e.mail_id = ANY($1::int[]) AND e.action = 'received' ORDER BY e.id`, [ids]);
    const told = [];
    for (const m of mails) {
      const mine = rows.filter(r => r.mail_id === m.id);
      if (mine.length) told.push({ mail_id: m.id, customer: mine[0].customer_name, rows: mine });
    }
    if (!told.length) return { announced: 0 };
    const users = (await qc('SELECT id, role, modules FROM users WHERE active = 1')).filter(u => mayArtwork(u));
    await notify(users.map(u => u.id), { kind: 'new_artwork', ...newArtworkAlert(told) }, qc);
    return { announced: told.length, users: users.length };
  });
}

// Never lets an alert problem fail the filing that called it.
export async function notifyNewArtworkSoft() {
  try {
    return await notifyNewArtwork();
  } catch (e) {
    console.warn(`[artwork-intake] alert: ${e.message}`);
    return { announced: 0 };
  }
}
