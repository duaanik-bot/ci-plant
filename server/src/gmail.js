// CI Plant's own line to a mailbox's Gmail (owner, 11 Nov 2026: "I want things to happen in the backend … all the
// controls, everything should be at the backend"). An admin connects a desk mailbox once (Google's consent page); from
// then on the server saves a quotation's reply as a Gmail DRAFT in the customer's thread the moment Send quotation is
// pressed — no robot, no Mac, no schedule.
//
// It never sends to a customer. Google's compose permission would allow a send, so the rule lives in the code: the
// writes here are drafts.create and drafts.update, and ONE send — sendToOwnMailboxes, to the company's own mailboxes
// only: the order sheet (owner, 12 Nov 2026: it "will directly shoot to mppchd@gmail.com", not a draft) and the artwork
// "done by the system" notice (17 Nov 2026). It builds that mail itself, to one or two company addresses read from the
// database (no Cc, no Bcc). gmail-link.test.js fails the build on any other send.
// A person checks every customer draft and presses Send in Gmail.
// Permission: gmail.compose (make, change and send drafts) + gmail.readonly. Until 18 Nov 2026 the second was
// gmail.metadata (headers only); the owner then asked to see the whole artwork mail trail in CI Plant ("the whole mail,
// the whole trail, the thread, should all be visible"), so a NEW connection asks to read mail. It is used for exactly
// that: the threads of artwork jobs, read when a person opens the job's window (routes/artwork-register.js) — no other
// mail is read. (Google refuses full reads while "metadata only" is granted too, so the new consent does not ask for it;
// an older connection keeps working for what it did and the window asks for Connect Gmail again.)
// Since 12 Nov 2026 the consent also asks for drive.file, for KLDs (gdrive.js): files CI Plant makes, nothing else.
// It is optional — a link without it keeps working for drafts; only Save to Drive asks for a new connection.
//
// Google's refresh token is stored ENCRYPTED (AES-256-GCM, key GMAIL_TOKEN_KEY in the server's environment — never in
// the database). Env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GMAIL_TOKEN_KEY (64 hex characters).
// GMAIL_API_BASE / GMAIL_UPLOAD_BASE / GOOGLE_OAUTH_BASE / GOOGLE_TOKEN_URL exist only so the tests can point at a fake Google.
import crypto from 'node:crypto';
import { DRIVE_SCOPE } from './gdrive.js';

export const READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const METADATA_SCOPE = 'https://www.googleapis.com/auth/gmail.metadata';
export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.compose', READ_SCOPE];
// May this connection read a whole message? Read granted, and not "metadata only" (with which Google refuses full reads).
export const readAllowed = link => {
  const granted = String(link?.scope || '').split(/\s+/);
  return granted.includes(READ_SCOPE) && !granted.includes(METADATA_SCOPE);
};
const api = () => process.env.GMAIL_API_BASE || 'https://gmail.googleapis.com/gmail/v1/users/me';
const uploadApi = () => process.env.GMAIL_UPLOAD_BASE || 'https://gmail.googleapis.com/upload/gmail/v1/users/me';
const authBase = () => process.env.GOOGLE_OAUTH_BASE || 'https://accounts.google.com/o/oauth2/v2/auth';
const tokenUrl = () => process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const revokeUrl = () => process.env.GOOGLE_REVOKE_URL || 'https://oauth2.googleapis.com/revoke';

// Is the server set up to talk to Google at all (the three settings present)?
export function gmailConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && /^[0-9a-f]{64}$/i.test(process.env.GMAIL_TOKEN_KEY || ''));
}
const need = () => { if (!gmailConfigured()) throw gmailError('Gmail is not set up on the server yet (Google client and token key missing).', 503); };

export function gmailError(message, status = 502, extra = {}) {
  return Object.assign(new Error(message), { status, gmail: true, ...extra });
}

// ── the token, encrypted at rest ────────────────────────────────────────────────────────────────
const key = () => Buffer.from(process.env.GMAIL_TOKEN_KEY, 'hex');
export function sealToken(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), body.toString('base64')].join('.');
}
export function openToken(sealed) {
  const [v, iv, tag, body] = String(sealed || '').split('.');
  if (v !== 'v1' || !iv || !tag || !body) throw gmailError('The stored Gmail connection cannot be read — connect Gmail again.', 409, { expired: true });
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8');
  } catch {
    throw gmailError('The stored Gmail connection cannot be read (the server key changed) — connect Gmail again.', 409, { expired: true });
  }
}

// ── connecting ──────────────────────────────────────────────────────────────────────────────────
export function consentUrl({ redirectUri, state, loginHint }) {
  need();
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri, response_type: 'code',
    scope: [...GMAIL_SCOPES, DRIVE_SCOPE].join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false', state,
  });
  if (loginHint) p.set('login_hint', loginHint);
  return `${authBase()}?${p}`;
}

async function tokenCall(params) {
  const res = await fetch(tokenUrl(), {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, ...params }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const expired = j.error === 'invalid_grant';
    throw gmailError(expired ? 'The Gmail connection has expired or was removed in Google — an admin presses Connect Gmail again.'
      : `Google refused the sign-in (${j.error_description || j.error || res.status}).`, expired ? 409 : 502, { expired });
  }
  return j;
}

// The code Google hands back → { refresh_token, access_token, scope, email }.
export async function exchangeCode(code, redirectUri) {
  need();
  const t = await tokenCall({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  if (!t.refresh_token) throw gmailError('Google gave no lasting permission — remove CI Plant at myaccount.google.com/permissions and connect again.', 502);
  const granted = String(t.scope || '').split(/\s+/);
  const missing = GMAIL_SCOPES.filter(s => !granted.includes(s));
  if (missing.length) throw gmailError('Both Gmail permissions are needed — tick them on Google\'s page and connect again.', 400);
  const profile = await gmailCall(t.access_token, 'GET', '/profile');
  return { refresh_token: t.refresh_token, access_token: t.access_token, scope: t.scope, email: String(profile.emailAddress || '').toLowerCase() };
}

export async function revoke(refreshToken) {
  try { await fetch(`${revokeUrl()}?token=${encodeURIComponent(refreshToken)}`, { method: 'POST' }); } catch { /* best effort */ }
}

// An access token from the stored link, kept for its life in this server instance.
const cache = new Map(); // mailbox → { token, until, sealed }
export async function accessToken(link) {
  need();
  const hit = cache.get(link.mailbox);
  if (hit && hit.sealed === link.refresh_token_enc && hit.until > Date.now() + 60_000) return hit.token;
  const t = await tokenCall({ grant_type: 'refresh_token', refresh_token: openToken(link.refresh_token_enc) });
  cache.set(link.mailbox, { token: t.access_token, until: Date.now() + (Number(t.expires_in) || 3000) * 1000, sealed: link.refresh_token_enc });
  return t.access_token;
}
export const forgetToken = mailbox => cache.delete(mailbox);

async function gmailCall(token, method, path, body) {
  const res = await fetch(api() + path, {
    method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return {};
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why = j.error?.message || res.statusText || String(res.status);
    throw gmailError(res.status === 401 || res.status === 403 ? `Gmail refused (${why}) — an admin presses Connect Gmail again.` : `Gmail said: ${why}`,
      res.status === 404 ? 404 : 502, { gmailStatus: res.status, expired: res.status === 401 });
  }
  return j;
}

// ── the e-mail itself ───────────────────────────────────────────────────────────────────────────
const b64 = buf => Buffer.from(buf).toString('base64').replace(/.{76}(?=.)/g, '$&\r\n');
const header = s => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
const cleanAddr = a => String(a || '').replace(/[\r\n<>",;]/g, '').trim();
const cleanLine = s => String(s || '').replace(/[\r\n]+/g, ' ').trim();
const safeName = n => cleanLine(n).replace(/["\\]/g, '') || 'quotation.pdf';

// RFC 822 message: text + HTML alternatives, the PDF attached, threaded under the customer's mail when given.
export function buildMime({ from, to, cc = [], subject, text, html, inReplyTo, references, attachment, attachments = [], headers = {}, boundary = crypto.randomBytes(12).toString('hex') }) {
  const mix = `mix_${boundary}`, alt = `alt_${boundary}`;
  const L = [];
  if (from) L.push(`From: ${cleanAddr(from)}`);
  // CI Plant's own X- headers (e.g. the approval mail's mark); anything else is not a header CI Plant writes
  for (const [k, v] of Object.entries(headers || {})) if (/^X-[A-Za-z0-9-]{1,40}$/.test(k)) L.push(`${k}: ${cleanLine(v).replace(/[^\x20-\x7e]/g, '')}`);
  L.push(`To: ${(Array.isArray(to) ? to : [to]).map(cleanAddr).filter(Boolean).join(', ')}`);
  const ccs = (Array.isArray(cc) ? cc : [cc]).map(cleanAddr).filter(Boolean);
  if (ccs.length) L.push(`Cc: ${ccs.join(', ')}`);
  L.push(`Subject: ${header(cleanLine(subject))}`);
  if (inReplyTo) L.push(`In-Reply-To: ${cleanLine(inReplyTo)}`);
  if (references || inReplyTo) L.push(`References: ${cleanLine([references, inReplyTo].filter(Boolean).join(' '))}`);
  L.push('MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${mix}"`, '');
  L.push(`--${mix}`, `Content-Type: multipart/alternative; boundary="${alt}"`, '');
  L.push(`--${alt}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(text || ''));
  if (html) L.push(`--${alt}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(html));
  L.push(`--${alt}--`, '');
  for (const a of [attachment, ...(Array.isArray(attachments) ? attachments : [])]) {
    if (!a?.bytes) continue;
    const n = safeName(a.name);
    L.push(`--${mix}`, `Content-Type: ${a.mime || 'application/pdf'}; name="${n}"`, `Content-Disposition: attachment; filename="${n}"`,
      'Content-Transfer-Encoding: base64', '', b64(a.bytes));
  }
  L.push(`--${mix}--`, '');
  return L.join('\r\n');
}
export const rawOf = mime => Buffer.from(mime, 'utf8').toString('base64url');

// The customer's message's own Message-ID (to thread the reply) — headers only.
export async function replyHeaders(token, gmailMessageId) {
  if (!gmailMessageId) return {};
  try {
    const want = ['Message-ID', 'References', 'From', 'Reply-To', 'To', 'Cc'].map(x => `metadataHeaders=${x}`).join('&');
    const m = await gmailCall(token, 'GET', `/messages/${encodeURIComponent(gmailMessageId)}?format=metadata&${want}`);
    const h = name => (m.payload?.headers || []).filter(x => String(x.name).toLowerCase() === name).map(x => x.value).join(', ') || null;
    return { inReplyTo: h('message-id'), references: h('references'), threadId: m.threadId || null,
      from: h('from'), replyTo: h('reply-to'), to: h('to'), cc: h('cc') };
  } catch (e) {
    if (e.gmailStatus === 404) return {}; // the customer's mail is gone: a fresh draft, not threaded
    throw e;
  }
}

// The thread in THIS mailbox that holds a mail with this Message-ID (owner, 21 Nov 2026: a reply may go out from the
// other mailbox, "the reply to the same thread"). Gmail's thread ids belong to one mailbox, so the customer's mail is
// looked up by its own Message-ID. Not there, or this connection may not search: null — the draft still carries
// In-Reply-To/References, so the customer's mail program threads it.
export async function threadOfMessageId(token, rfcMessageId) {
  const id = String(rfcMessageId || '').trim();
  if (!id) return null;
  try {
    const r = await gmailCall(token, 'GET', `/messages?maxResults=1&includeSpamTrash=false&q=${encodeURIComponent(`rfc822msgid:${id.replace(/^<|>$/g, '')}`)}`);
    return r.messages?.[0]?.threadId || null;
  } catch (e) {
    if ([400, 403, 404].includes(e.gmailStatus)) return null;
    throw e;
  }
}

// Every address in a header ("Vanitha J <v@x.com>, p@x.com") — lower-cased, once each.
export const addressesOf = (...headers) => [...new Set(headers.filter(Boolean).join(',').match(/[^\s<>,;"'()]+@[^\s<>,;"'()]+\.[^\s<>,;"'()]+/g)?.map(a => a.toLowerCase()) || [])];

// Reply to everyone (owner, 11 Nov 2026): To = whom the customer's mail asks replies to go (Reply-To, else its sender);
// Cc = everyone else on it (To and Cc), never the mailbox itself. Still only a DRAFT.
export function replyAll(hdr, own) {
  const me = String(own || '').toLowerCase();
  const to = addressesOf(hdr.replyTo || hdr.from).filter(a => a !== me);
  const cc = addressesOf(hdr.to, hdr.cc).filter(a => a !== me && !to.includes(a));
  return { to, cc };
}

export const draftViewUrl = (email, messageId) => `https://mail.google.com/mail/?authuser=${encodeURIComponent(email)}#drafts?compose=${encodeURIComponent(messageId)}`;

// Save the draft: change the earlier draft of this quotation when it is still there, else make a new one.
// → { draft_id, message_id, thread_id, view_url, replaced }
export async function saveDraft(token, { email, raw, threadId, draftId }) {
  const message = { raw, ...(threadId ? { threadId } : {}) };
  let d = null, replaced = false;
  if (draftId) {
    try { d = await gmailCall(token, 'PUT', `/drafts/${encodeURIComponent(draftId)}`, { id: draftId, message }); replaced = true; }
    catch (e) { if (e.gmailStatus !== 404 && e.gmailStatus !== 400) throw e; }
  }
  if (!d) d = await gmailCall(token, 'POST', '/drafts', { message });
  const mid = d.message?.id;
  return { draft_id: d.id, message_id: mid, thread_id: d.message?.threadId || threadId || null, view_url: mid ? draftViewUrl(email, mid) : null, replaced };
}

// Has this draft been sent? The draft is gone AND a sent message sits in its thread from after it was made.
// → { sent: true, at } | { sent: false, gone: bool }
// Gmail's web app, sending a draft, can keep the draft's id and point it at the SENT message (seen live, 11 Nov 2026:
// drafts.get answered the sent message, labels SENT, no DRAFT) — so a SENT message behind the draft id counts as sent.
export async function draftSent(token, { draftId, threadId, since }) {
  try {
    const d = await gmailCall(token, 'GET', `/drafts/${encodeURIComponent(draftId)}?format=minimal`);
    const labels = d.message?.labelIds || [];
    if (labels.includes('SENT') && !labels.includes('DRAFT')) {
      const at = Number(d.message?.internalDate);
      return { sent: true, at: new Date(at > 0 ? at : Date.now()).toISOString(), message_id: d.message?.id || null };
    }
    return { sent: false, gone: false };
  } catch (e) { if (e.gmailStatus !== 404) throw e; }
  if (!threadId) return { sent: false, gone: true };
  let t;
  try { t = await gmailCall(token, 'GET', `/threads/${encodeURIComponent(threadId)}?format=metadata&metadataHeaders=Subject`); }
  catch (e) { if (e.gmailStatus === 404) return { sent: false, gone: true }; throw e; }
  const from = since ? new Date(since).getTime() - 60_000 : 0;
  const sent = (t.messages || []).filter(m => (m.labelIds || []).includes('SENT') && Number(m.internalDate) >= from)
    .sort((a, b) => Number(a.internalDate) - Number(b.internalDate))[0];
  return sent ? { sent: true, at: new Date(Number(sent.internalDate)).toISOString() } : { sent: false, gone: true };
}

// The ONE send, and only to the company's own mailboxes. Two callers: the order sheet (owner, 12 Nov 2026), to the
// business mailbox alone (sendToCompany), and the artwork "done by the system" notice (owner, 17 Nov 2026: "sent by the
// mppchd email to both [the owner's mailbox] and mppchd"), to the desk's business and trial mailboxes. The addresses are read from
// the database by the caller (enquiry_mailboxes), never from a mail or a request. One or two recipients, each a plain
// address, no Cc, no Bcc — so no caller can reach a customer. → { message_id, thread_id }
const COMPANY_ADDRESS = /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[^\s@<>,;"']+$/;
// The company's own mailboxes: the desk's business and trial addresses, read here from the database — so a caller
// cannot widen the list. (Tests pass their own reader; gmail-link.test.js fails the build if any other file does.)
async function deskMailboxes() {
  const { q } = await import('./db.js');
  return (await q(`SELECT email FROM enquiry_mailboxes WHERE key IN ('business', 'trial')`)).map(r => String(r.email ?? '').trim().toLowerCase());
}
export async function sendToOwnMailboxes(token, { from, to, subject, text, html, attachments = [], what = 'the mail', ownAddresses = deskMailboxes }) {
  const list = [...new Set((Array.isArray(to) ? to : [to]).map(a => String(a ?? '').trim().toLowerCase()))];
  if (!list.length || list.length > 2 || !list.every(a => COMPANY_ADDRESS.test(a))) {
    throw gmailError(`No company mailbox address to send ${what} to — set the business mailbox in the desk settings.`, 409);
  }
  const own = new Set((await ownAddresses()).filter(Boolean));
  const stranger = list.filter(a => !own.has(a));
  if (stranger.length) throw gmailError(`${what} may go only to the company's own mailboxes (desk settings) — not to ${stranger.join(', ')}.`, 409);
  const raw = rawOf(buildMime({ from, to: list, subject, text, html, attachments }));
  const m = await gmailCall(token, 'POST', '/messages/send', { raw });
  return { message_id: m.id || null, thread_id: m.threadId || null };
}
export async function sendToCompany(token, { from, company, subject, text, html, attachments = [], ownAddresses }) {
  if (Array.isArray(company)) throw gmailError('No company mailbox address to send the order sheet to — set the business mailbox in the desk settings.', 409);
  return sendToOwnMailboxes(token, { from, to: [company], subject, text, html, attachments, what: 'the order sheet', ...(ownAddresses ? { ownAddresses } : {}) });
}

// ── the client send (owner, 17 Nov 2026: "if we click Send Email, we should be able to send the email from here, from
// the ERP") ─ the ONE way a mail reaches a client: a person presses Send email on the artwork window, and the DRAFT CI
// Plant built and they reviewed is sent as it stands in Gmail (drafts.send) — never a mail made up at send time. Used
// only by routes/artwork-flow.js; gmail-link.test.js fails the build on any other caller.
export async function sendDraft(token, { draftId }) {
  if (!draftId) throw gmailError('No draft to send — press Send for approval first.', 409);
  const m = await gmailCall(token, 'POST', '/drafts/send', { id: draftId });
  return { message_id: m.id || null, thread_id: m.threadId || null };
}

// The draft as Gmail holds it now: who it goes to, its subject, its message id (it changes when someone edits the draft
// in Gmail) and its labels (SENT and no DRAFT = it was sent from Gmail). null = the draft is gone.
export async function draftHeaders(token, { draftId }) {
  try {
    const d = await gmailCall(token, 'GET', `/drafts/${encodeURIComponent(draftId)}?format=metadata&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject`);
    const h = n => (d.message?.payload?.headers || []).filter(x => String(x.name).toLowerCase() === n).map(x => x.value).join(', ') || '';
    const labels = d.message?.labelIds || [];
    const t = Number(d.message?.internalDate);
    return { to: h('to'), cc: h('cc'), subject: h('subject'), message_id: d.message?.id || null, labels,
      sent: labels.includes('SENT') && !labels.includes('DRAFT'), at: t > 0 ? new Date(t).toISOString() : null };
  } catch (e) { if (e.gmailStatus === 404) return null; throw e; }
}

// Was this approval mail sent? Strict, because a client must never be told twice nor told nothing: the draft itself
// answering SENT (Gmail's web app keeps the id when it sends a draft), or — the draft gone — a SENT message in the thread
// carrying CI Plant's own mark (header X-CIPlant-Approval). Any other mail from the mailbox in that thread is not it.
// → { sent: true, at, message_id } | { sent: false, gone }
export const APPROVAL_HEADER = 'X-CIPlant-Approval';
export async function approvalSent(token, { draftId, threadId, marker }) {
  const iso = ms => { const t = Number(ms); return new Date(t > 0 ? t : Date.now()).toISOString(); };
  try {
    const d = await gmailCall(token, 'GET', `/drafts/${encodeURIComponent(draftId)}?format=minimal`);
    const labels = d.message?.labelIds || [];
    if (labels.includes('SENT') && !labels.includes('DRAFT')) return { sent: true, at: iso(d.message?.internalDate), message_id: d.message?.id || null };
    return { sent: false, gone: false };
  } catch (e) { if (e.gmailStatus !== 404) throw e; }
  if (!threadId || !marker) return { sent: false, gone: true };
  let t;
  try { t = await gmailCall(token, 'GET', `/threads/${encodeURIComponent(threadId)}?format=metadata&metadataHeaders=${APPROVAL_HEADER}`); }
  catch (e) { if (e.gmailStatus === 404) return { sent: false, gone: true }; throw e; }
  const hit = (t.messages || []).find(m => (m.labelIds || []).includes('SENT')
    && (m.payload?.headers || []).some(h => String(h.name).toLowerCase() === APPROVAL_HEADER.toLowerCase() && String(h.value).trim() === marker));
  return hit ? { sent: true, at: iso(hit.internalDate), message_id: hit.id || null } : { sent: false, gone: true };
}

// A draft made through Gmail's upload door (multipart: the thread, then the whole message), so a proof of several MB
// fits — a plain JSON request carries only a few MB. Same answer as saveDraft. Never sends.
export async function saveDraftUpload(token, { email, mime, threadId }) {
  const boundary = `ciplant_${crypto.randomBytes(10).toString('hex')}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ message: threadId ? { threadId } : {} })}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n`), Buffer.from(mime, 'utf8'),
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const d = await gmailUpload(token, '/drafts?uploadType=multipart', body, `multipart/related; boundary=${boundary}`);
  const mid = d.message?.id;
  return { draft_id: d.id, message_id: mid, thread_id: d.message?.threadId || threadId || null, view_url: mid ? draftViewUrl(email, mid) : null };
}
async function gmailUpload(token, path, body, contentType) {
  const res = await fetch(uploadApi() + path, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': contentType }, body });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why = j.error?.message || res.statusText || String(res.status);
    throw gmailError(res.status === 401 || res.status === 403 ? `Gmail refused (${why}) — an admin presses Connect Gmail again.` : `Gmail said: ${why}`,
      res.status === 404 ? 404 : 502, { gmailStatus: res.status, expired: res.status === 401 });
  }
  return j;
}

// Take a draft out of Gmail's Drafts (a cancelled approval mail, so nobody sends it from Gmail by mistake). Gone already = fine.
export async function deleteDraft(token, { draftId }) {
  if (!draftId) return { deleted: false };
  try { await gmailCall(token, 'DELETE', `/drafts/${encodeURIComponent(draftId)}`); return { deleted: true }; }
  catch (e) { if (e.gmailStatus === 404) return { deleted: false, gone: true }; throw e; }
}

// ── reading an artwork thread (18 Nov 2026) ─ the caller has checked the thread belongs to an artwork job ───────────
export async function readThread(token, { threadId }) {
  try { return await gmailCall(token, 'GET', `/threads/${encodeURIComponent(threadId)}?format=full`); }
  catch (e) { if (e.gmailStatus === 404) return null; throw e; }
}
// Which thread a message is in (to check, before handing out its attachment, that it is an artwork thread).
export async function messageThread(token, { messageId }) {
  try { return (await gmailCall(token, 'GET', `/messages/${encodeURIComponent(messageId)}?format=minimal`)).threadId || null; }
  catch (e) { if (e.gmailStatus === 404) return null; throw e; }
}
export async function readAttachment(token, { messageId, attachmentId }) {
  const a = await gmailCall(token, 'GET', `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`);
  return Buffer.from(String(a.data || ''), 'base64url');
}
