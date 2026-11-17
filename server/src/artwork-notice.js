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
import { q, one, tx } from './db.js';
import { gmailConfigured, accessToken, sendToOwnMailboxes } from './gmail.js';

export const MAX_TRIES = 5;
const RETRY_MIN = 10;
const text = v => String(v ?? '').trim();
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const base = () => (process.env.CI_PLANT_URL || 'https://motionci.in').replace(/\/+$/, '');

const when = (iso, withTime = true) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: withTime ? 'numeric' : undefined,
    ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}) }).format(new Date(t));
};
const jobName = it => [it.job_no, it.client_item_code, it.product_name].filter(Boolean).join(' ');

// The mail's words. items: [{ action: 'received' | 'received_again', job_no, client_item_code, product_name, customer,
// label, fresh, to_sort, designer_reply_at, view_url, files: [{ file_name, drive_url, link_url, saved_by }] }]. Pure.
export function noticeMail({ items, at = new Date().toISOString(), link = `${base()}/artwork?tab=register` }) {
  const did = items.filter(i => i.action === 'received');
  const again = items.filter(i => i.action === 'received_again');
  const designer = did.filter(i => i.designer_reply_at || i.files.some(f => f.saved_by === 'designer'));
  const L = [];
  L.push('Artwork the system has already handled — please do not do these again.', '');
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
  L.push(`Open the register: ${link}`, '',
    'CI Plant never sends mail to clients: anything for a client is left as a draft in Drafts for a person to check and send.',
    'This notice goes only to the two company mailboxes.');
  const n = did.length + again.length;
  const subject = `Artwork done by the system — ${plural(n, 'item')}${designer.length ? `, ${designer.length} already done by the designer` : ''} (${when(at)})`;
  const textBody = L.join('\n');
  const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;white-space:pre-wrap">${esc(textBody)
    .replace(/https?:\/\/[^\s<]+/g, u => `<a href="${u}">${u}</a>`)
    .replace(/^(DONE BY THE SYSTEM|ALREADY DONE BY THE DESIGNER[^\n]*|SENT AGAIN[^\n]*)$/gm, '<b>$1</b>')}</div>`;
  return { subject, text: textBody, html };
}

// Claims the mails nobody has been told about into one notice. → the notice id, or null when there is nothing.
export async function claimNotice() {
  return tx(async (qc) => {
    const mails = await qc(`SELECT id, view_url FROM artwork_mails WHERE notice_id IS NULL ORDER BY id LIMIT 200 FOR UPDATE SKIP LOCKED`);
    if (!mails.length) return null;
    const ids = mails.map(m => m.id);
    const rows = await qc(`
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
    const n = items.length ? noticeMail({ items }) : null;
    const notice = await qc(`INSERT INTO artwork_notices (status, mail_ids, subject, text_body, html_body, error) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [n ? 'waiting' : 'skipped', ids, n?.subject ?? null, n?.text ?? null, n?.html ?? null, n ? null : 'nothing to tell']);
    await qc('UPDATE artwork_mails SET notice_id = $2 WHERE id = ANY($1::int[])', [ids, notice[0].id]);
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
    || await one(`SELECT 1 AS y FROM artwork_notices WHERE status IN ('waiting', 'failed', 'sending') LIMIT 1`));
}
