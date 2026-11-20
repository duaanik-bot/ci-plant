// The "done by the system" notice (owner, 17 Nov 2026: "If the system has already done it, my designer should get an
// intimation that this work has already been done … The intimation should be sent by the mppchd email to both
// the owner's mailbox and mppchd email." Design: plans/2026-11-17-artwork-dedup-notice-design.md).
//
// After the office AVS's mails are filed into the register (artwork-intake.js), the mails nobody has been told about
// are claimed into ONE notice (artwork_notices; each mail in one notice only, SKIP LOCKED), and the notice is sent from
// the business mailbox (mppchd, through its Gmail link) to the desk's two mailboxes — business and trial — read from
// enquiry_mailboxes, never from a mail. It lists what the system did (filed, files saved to the CI AVS library, links
// to fetch), what it did NOT repeat because the designer had already done it (their copy of a file, their reply in the
// thread), and what was only sent again. Client mail is never sent from here: the notice is the one send, through
// gmail.js sendToOwnMailboxes, which reaches company addresses only.
//
// A notice that cannot go yet waits: mppchd's Gmail not connected, its connection expired, or a desk address not plain →
// 'waiting' (no try counted, tried on every filing and poll); Google trouble → 'failed', tried again after 10 minutes,
// 'gave_up' after 5 tries; a send started and never confirmed → 'gave_up' at once (it may have gone: never sent blind
// twice). The register shows every notice not sent, and a person can press Send again.
//
// Fluence (owner, 20 Nov 2026: "Yes, add it"; design 2026-11-18 §4.3): the same notice also says what the system did with
// Fluence's mails (fluence-mail.js) — saved to the Fluence master (do not enter it again), held for a person and why,
// not matched, a PO whose MRPs differ, already the same — in the words of Fluence › From Fluence mail. A reading is told
// once (fluence_mail_readings.notice_id), when nothing of its mail is still being saved; an artwork's, when the client's
// approval saves it. A run of only Fluence is a notice of its own.
import { q, one, tx } from './db.js';
import { gmailConfigured, accessToken, sendToOwnMailboxes } from './gmail.js';
import { SETTLED } from './fluence-mail-rules.js';
import { readingOutcome, poNotCompared } from '../../client/src/lib/fluence.js';

export const MAX_TRIES = 5;
const RETRY_MIN = 10;
const text = v => String(v ?? '').trim();
const list = v => (Array.isArray(v) ? v : []);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const base = () => (process.env.CI_PLANT_URL || 'https://motionci.in').replace(/\/+$/, '');

const when = (iso, withTime = true) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: withTime ? 'numeric' : undefined,
    ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}) }).format(new Date(t));
};
const jobName = it => [it.job_no, it.client_item_code, it.product_name].filter(Boolean).join(' ');

// ── the Fluence part ──────────────────────────────────────────────────────────────────────────────────────────────
const FLUENCE_CAP = 40;          // lines in a group; the rest are in the tab
const SAME_CAP = 20;             // names on the "already the same" line
const SOURCE_WORD = { artwork: 'artwork', mrp_sheet: 'MRP sheet', po: 'PO' };
// the kit as the office knows it: the master's name (else what the mail called it) and its carton code — a new kit's
// draft code is said once, in what it did
const kitLabel = r => {
  const name = text(r.kit) || text(r.kit_name) || 'a kit';
  const code = r.created_product_code ? '' : text(r.product_code);
  return code ? `${name} (${code})` : name;
};
const fromMail = r => [SOURCE_WORD[r.source] || 'mail', r.received_at ? `of ${when(r.received_at, false)}` : ''].filter(Boolean).join(' ');

// Grouped by what the office must do with it. readings: [{ source, status, kit, kit_name, product_code,
// created_product_code, created_kit_id, hold_reason, changes, reading: { mrp: { kit_total } }, sure, unsure,
// received_at }]. → { lines, summary }. Pure.
// A PO's MRPs are only compared, never saved (design §7.1): a PO line is "already the same" only when its kit MRP was
// read, sure, and found the same; any other PO line — it differs, it names no kit we have, nothing was compared — is
// one to check on the PO, never one to put in by hand.
function fluencePart(readings, link) {
  const poToCheck = r => r.status === 'compared' && (list(r.changes?.differs).length > 0 || !!r.hold_reason || poNotCompared(r));
  const g = {
    saved: readings.filter(r => r.status === 'saved'),
    held: readings.filter(r => r.status === 'held'),
    notMatched: readings.filter(r => r.status === 'not_matched'),
    po: readings.filter(poToCheck),
    same: readings.filter(r => r.status === 'same' || (r.status === 'compared' && !poToCheck(r))),
  };
  const L = [];
  const group = (xs, head) => {
    if (!xs.length) return;
    L.push(head, ...xs.slice(0, FLUENCE_CAP).map(r => `• ${kitLabel(r)} — ${readingOutcome(r)} — ${fromMail(r)}`));
    if (xs.length > FLUENCE_CAP) L.push(`…and ${xs.length - FLUENCE_CAP} more — all in Fluence › From Fluence mail`);
    L.push('');
  };
  group(g.saved, "FLUENCE MASTER — SAVED FROM FLUENCE'S MAIL — do not enter these again");
  group(g.held, 'FLUENCE MASTER — HELD, NOT SAVED — a person decides: Apply, or Keep the master');
  group(g.notMatched, 'FLUENCE MASTER — NOT MATCHED — no kit of that name or code: put it in by hand, or Keep the master');
  group(g.po, "FLUENCE MASTER — PO LINES TO CHECK — a PO's MRPs are only compared, never saved: check these on the PO");
  if (g.same.length) {
    const more = g.same.length > SAME_CAP ? ` and ${g.same.length - SAME_CAP} more` : '';
    L.push('FLUENCE MASTER — CHECKED, ALREADY THE SAME AS THE MASTER — nothing to do',
      `• ${plural(g.same.length, 'kit')} — ${g.same.slice(0, SAME_CAP).map(kitLabel).join(', ')}${more}`, '');
  }
  if (L.length) L.push(`Fluence › From Fluence mail (management acknowledges what was saved): ${link}`, '');
  const made = g.saved.filter(r => r.created_kit_id || r.created_product_code).length;
  const summary = [
    g.saved.length && `${g.saved.length} saved${made ? ` (${plural(made, 'new kit')})` : ''}`,
    g.held.length && `${g.held.length} held`,
    g.notMatched.length && `${g.notMatched.length} not matched`,
    g.po.length && `${plural(g.po.length, 'PO line')} to check`,
    g.same.length && `${g.same.length} already the same`,
  ].filter(Boolean).join(', ');
  return { lines: L, summary };
}

// The mail's words. items: [{ action: 'received' | 'received_again', job_no, client_item_code, product_name, customer,
// label, fresh, to_sort, designer_reply_at, view_url, files: [{ file_name, drive_url, link_url, saved_by }] }];
// fluence: the Fluence readings told with it (fluencePart). Pure.
export function noticeMail({ items, fluence = [], at = new Date().toISOString(), link = `${base()}/artwork?tab=register`,
  fluenceLink = `${base()}/fluence?tab=mail` }) {
  const did = items.filter(i => i.action === 'received');
  const again = items.filter(i => i.action === 'received_again');
  const designer = did.filter(i => i.designer_reply_at || i.files.some(f => f.saved_by === 'designer'));
  const fl = fluencePart(fluence, fluenceLink);
  const n = did.length + again.length;
  const L = [];
  L.push(`${[n && 'Artwork', fl.lines.length && 'Fluence masters'].filter(Boolean).join(' and ') || 'Artwork'} the system has already handled — please do not do these again.`, '');
  if (did.length) {
    L.push('DONE BY THE SYSTEM');
    for (const i of did) {
      L.push(`• ${jobName(i)} — ${i.label}${i.fresh ? ' (new job)' : ' (new version)'}${i.to_sort ? ' — TO SORT: a person must say which product' : ''} — ${i.customer || 'customer not known'}`);
      L.push('    Filed in the Artwork register.');
      for (const f of i.files) {
        if (f.link_url) L.push(`    Link to fetch by hand (not downloaded): ${f.link_url}`);
        else if (f.saved_by === 'designer') L.push(`    ${f.file_name} — the designer's copy, not saved again${f.drive_url ? `: ${f.drive_url}` : ''}`);
        else if (f.drive_url) L.push(`    ${f.file_name} — saved to CI AVS › ARTWORK LIBRARY: ${f.drive_url}`);
        else L.push(`    ${f.file_name} — NOT saved to Drive (file to fetch)`);
      }
      if (i.view_url) L.push(`    Mail: ${i.view_url}`);
    }
    L.push('');
  }
  if (designer.length) {
    L.push('ALREADY DONE BY THE DESIGNER — the system did not repeat it');
    for (const i of designer) {
      const mine = i.files.filter(f => f.saved_by === 'designer');
      if (mine.length) L.push(`• ${jobName(i)} ${i.label} — ${plural(mine.length, 'file')} already in the designer's folders: ${mine.map(f => f.file_name).join(', ')}`);
      if (i.designer_reply_at) L.push(`• ${jobName(i)} ${i.label} — mppchd had already replied in the thread (${when(i.designer_reply_at)})`);
    }
    L.push('');
  }
  if (again.length) {
    L.push('SENT AGAIN — already in the register, nothing new');
    for (const i of again) L.push(`• ${jobName(i)} ${i.label} — ${i.customer || ''}`.replace(/ — $/, ''));
    L.push('');
  }
  if (n || !fl.lines.length) L.push(`Open the register: ${link}`, '');
  L.push(...fl.lines,
    'CI Plant never sends mail to clients: anything for a client is left as a draft in Drafts for a person to check and send.',
    'This notice goes only to the two company mailboxes.');
  const parts = [];
  if (n || !fl.summary) parts.push(`Artwork done by the system — ${plural(n, 'item')}${designer.length ? `, ${designer.length} already done by the designer` : ''}`);
  if (fl.summary) parts.push(`${n ? 'Fluence masters' : 'Fluence masters done by the system'} — ${fl.summary}`);
  const subject = `${parts.join('; ')} (${when(at)})`;
  const textBody = L.join('\n');
  const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;white-space:pre-wrap">${esc(textBody)
    .replace(/https?:\/\/[^\s<]+/g, u => `<a href="${u}">${u}</a>`)
    .replace(/^(DONE BY THE SYSTEM|ALREADY DONE BY THE DESIGNER[^\n]*|SENT AGAIN[^\n]*|FLUENCE MASTER — [^\n]*)$/gm, '<b>$1</b>')}</div>`;
  return { subject, text: textBody, html };
}

// Fluence readings join the notice once their table has its notice column (20261120100000_fluence_mail_notice.sql);
// until then the notice is the artwork's alone, as before — never stopped by a migration not yet applied.
let fluenceReady = false;
const fluenceOn = async get => {
  if (!fluenceReady) {
    fluenceReady = !!(await get(`SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.fluence_mail_readings')
                                   AND attname = 'notice_id' AND NOT attisdropped) AS ok`))?.ok;
  }
  return fluenceReady;
};
// a settled reading nobody has been told about, none of whose mail is still being saved (a sheet is told whole)
const FLUENCE_UNTOLD = `r.notice_id IS NULL AND r.status = ANY($1::text[])
   AND NOT EXISTS (SELECT 1 FROM fluence_mail_readings x WHERE x.intake_id = r.intake_id AND x.status = 'queued')`;

// Claims the mails and Fluence readings nobody has been told about into one notice. → the notice id, or null when
// there is nothing.
export async function claimNotice() {
  return tx(async (qc, oc) => {
    const mails = await qc(`SELECT id, view_url FROM artwork_mails WHERE notice_id IS NULL ORDER BY id LIMIT 200 FOR UPDATE SKIP LOCKED`);
    const readings = await fluenceOn(oc) ? await qc(`
      SELECT r.id, r.source, r.status, r.kit_name, r.hold_reason, r.changes, r.received_at, r.created_kit_id, r.sure, r.unsure,
             jsonb_build_object('mrp', jsonb_build_object('kit_total', r.reading->'mrp'->'kit_total')) AS reading,
             k.kit_name AS kit, p.code AS product_code, cp.code AS created_product_code
        FROM fluence_mail_readings r LEFT JOIN fluence_kits k ON k.id = r.kit_id LEFT JOIN products p ON p.id = r.product_id
        LEFT JOIN products cp ON cp.id = r.created_product_id
       WHERE ${FLUENCE_UNTOLD}
       ORDER BY r.id LIMIT 3000 FOR UPDATE OF r SKIP LOCKED`, [SETTLED]) : [];
    if (!mails.length && !readings.length) return null;
    const ids = mails.map(m => m.id);
    const rows = !ids.length ? [] : await qc(`
      SELECT e.id AS event_id, e.mail_id, e.action, v.id AS version_id, v.label, v.designer_reply_at, j.job_no, j.client_item_code,
             j.product_name, j.customer_name, j.to_sort, v.id = (SELECT min(x.id) FROM artwork_versions x WHERE x.job_id = j.id) AS fresh
        FROM artwork_events e JOIN artwork_versions v ON v.id = e.version_id JOIN artwork_jobs j ON j.id = v.job_id
       WHERE e.mail_id = ANY($1::int[]) AND e.action IN ('received', 'received_again') ORDER BY e.id`, [ids]);
    const files = rows.length ? await qc(`SELECT version_id, file_name, drive_url, link_url, saved_by FROM artwork_files
                                           WHERE version_id = ANY($1::int[]) ORDER BY id`, [[...new Set(rows.map(r => r.version_id))]]) : [];
    const view = new Map(mails.map(m => [m.id, m.view_url]));
    const items = rows.map(r => ({
      action: r.action, job_no: r.job_no, client_item_code: r.client_item_code, product_name: r.product_name, customer: r.customer_name,
      label: r.label, fresh: r.fresh && r.action === 'received', to_sort: r.to_sort, designer_reply_at: r.designer_reply_at,
      view_url: view.get(r.mail_id) || null, files: r.action === 'received' ? files.filter(f => f.version_id === r.version_id) : [],
    }));
    const n = items.length || readings.length ? noticeMail({ items, fluence: readings }) : null;
    const notice = await qc(`INSERT INTO artwork_notices (status, mail_ids, subject, text_body, html_body, error) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [n ? 'waiting' : 'skipped', ids, n?.subject ?? null, n?.text ?? null, n?.html ?? null, n ? null : 'nothing to tell']);
    if (ids.length) await qc('UPDATE artwork_mails SET notice_id = $2 WHERE id = ANY($1::int[])', [ids, notice[0].id]);
    if (readings.length) await qc('UPDATE fluence_mail_readings SET notice_id = $2 WHERE id = ANY($1::int[])', [readings.map(r => r.id), notice[0].id]);
    return notice[0].id;
  });
}

// Who it goes to and through which link: from the business mailbox's Gmail link, to the business and trial mailboxes'
// addresses (the two company mailboxes). Anything that a person must put right first — no address, a malformed address,
// no Gmail link — is "not ready": the notice waits, no try is counted, nothing is sent. → { ready, why, link, to }
const PLAIN_ADDRESS = /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[^\s@<>,;"']+$/;
async function noticeRoute() {
  const boxes = await q(`SELECT key, email FROM enquiry_mailboxes WHERE key IN ('business', 'trial')`);
  const addr = k => text(boxes.find(b => b.key === k)?.email).toLowerCase();
  const biz = addr('business'), trial = addr('trial');
  if (!biz) return { ready: false, why: 'No business mailbox address in the desk settings.' };
  const bad = [biz, trial].filter(a => a && !PLAIN_ADDRESS.test(a));
  if (bad.length) return { ready: false, why: `A desk mailbox address is not a plain e-mail address (${bad.join(', ')}) — correct it in Enquiry desk › Settings.` };
  if (!gmailConfigured()) return { ready: false, why: 'Gmail is not set up on the server yet; then an admin presses Connect Gmail for the business mailbox (Enquiry desk › Settings).' };
  const link = await one(`SELECT * FROM gmail_links WHERE mailbox = 'business'`);
  if (!link) return { ready: false, why: `The business mailbox (${biz}) has no Gmail connected — an admin presses Connect Gmail for it in Enquiry desk › Settings.` };
  return { ready: true, link, to: [...new Set([biz, trial].filter(Boolean))] };
}

const STALE = `The send was started but never confirmed (the server stopped mid-send). It may have gone — look in mppchd's Sent folder; if it is not there, press Send again on the register.`;

// Sends what waits, one notice at a time. A notice is taken under SKIP LOCKED and marked 'sending' before Gmail is
// called, and only a 'sending' row is ever marked sent or failed — so two callers never send one twice. A send that was
// started and never confirmed is NOT tried again by itself (it may have gone): it is shown to a person instead.
export async function sendNotices({ max = 10 } = {}) {
  const out = { sent: 0, failed: 0, waiting: 0 };
  // a send that never came back: stop, and say so — never send it blind a second time
  await q(`UPDATE artwork_notices SET status = 'gave_up', error = $1
            WHERE status = 'sending' AND claimed_at < now() - interval '${RETRY_MIN} minutes'`, [STALE]);
  const route = await noticeRoute();
  if (!route.ready) {
    // Nothing is tried; the waiting notices say why (written only when the reason changed — the poll comes often).
    const w = await q(`UPDATE artwork_notices SET status = 'waiting', error = $1
                        WHERE status IN ('waiting', 'failed') AND error IS DISTINCT FROM $1 RETURNING id`, [route.why]);
    out.waiting = w.length;
    return out;
  }
  for (let k = 0; k < max; k++) {
    const n = await tx(async (qc, oc) => {
      const row = await oc(`
        SELECT id, subject, text_body, html_body, tries FROM artwork_notices
         WHERE (status = 'waiting' AND (next_try_at IS NULL OR next_try_at <= now()))
            OR (status = 'failed' AND next_try_at <= now())
         ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`);
      if (!row) return null;
      await qc(`UPDATE artwork_notices SET status = 'sending', claimed_at = now(), tries = tries + 1 WHERE id = $1`, [row.id]);
      return { ...row, tries: row.tries + 1 };
    });
    if (!n) break;
    let sent = null, err = null;
    try {
      const token = await accessToken(route.link);
      sent = await sendToOwnMailboxes(token, { from: route.link.email, to: route.to, subject: n.subject, text: n.text_body, html: n.html_body, what: 'the artwork notice' });
    } catch (e) { err = e; }
    if (sent) {
      // Gmail has it: from here on, nothing may turn this notice back into one to send.
      try {
        await q(`UPDATE artwork_notices SET status = 'sent', message_id = $2, to_text = $3, sent_at = now(), error = NULL
                  WHERE id = $1 AND status = 'sending'`, [n.id, sent.message_id, route.to.join(', ')]);
        await q(`UPDATE gmail_links SET last_used_at = now() WHERE mailbox = 'business'`);
      } catch (e) { console.warn(`[artwork-notice] notice ${n.id} sent, but not marked: ${e.message}`); }
      out.sent += 1;
      continue;
    }
    const why = String(err?.message || err).slice(0, 300);
    if (err?.expired || err?.status === 409) {
      // the connection or an address needs a person: wait, and give the try back
      await q(`UPDATE artwork_notices SET status = 'waiting', tries = tries - 1, error = $2 WHERE id = $1 AND status = 'sending'`, [n.id, why]);
      out.waiting += 1;
      break;
    }
    await q(`UPDATE artwork_notices SET status = $2, error = $3, next_try_at = now() + interval '${RETRY_MIN} minutes' WHERE id = $1 AND status = 'sending'`,
      [n.id, n.tries >= MAX_TRIES ? 'gave_up' : 'failed', why]);
    out.failed += 1;
  }
  return out;
}

// A person, after looking: put the notices that gave up back in the queue, with their tries reset. → how many
export async function resendGaveUp() {
  return (await q(`UPDATE artwork_notices SET status = 'waiting', tries = 0, next_try_at = NULL, error = NULL
                    WHERE status = 'gave_up' RETURNING id`)).length;
}

// For callers that must never fail because of the notice (the robot's call, the two-minute poll).
export async function artworkNoticeSoft() {
  try {
    let claimed = 0;
    for (let k = 0; k < 5 && await claimNotice(); k++) claimed += 1;
    return { claimed, ...await sendNotices() };
  } catch (e) {
    console.warn(`[artwork-notice] ${e.message}`);
    return { claimed: 0, sent: 0, failed: 0, waiting: 0, error: true };
  }
}

// The poll's cheap check: anything to claim or to send?
export async function noticeWorkWaiting() {
  return !!(await one(`SELECT 1 AS y FROM artwork_mails WHERE notice_id IS NULL LIMIT 1`)
    || await one(`SELECT 1 AS y FROM artwork_notices WHERE status IN ('waiting', 'failed', 'sending') LIMIT 1`)
    || (await fluenceOn(one) && await one(`SELECT 1 AS y FROM fluence_mail_readings r WHERE ${FLUENCE_UNTOLD} LIMIT 1`, [SETTLED])));
}
