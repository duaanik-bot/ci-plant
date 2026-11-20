// The enquiry desk's screen helpers (server rules: server/src/enquiry-desk.js).
import { num } from './costing.js';
import { blankValue } from './costingUi.js';
import { finishFromEnquiry } from './costingRules.js';

// The desk's tabs and the stages each shows, left to right (5 Nov 2026). A row moves right when its work is
// done — Send to costing, a costing saved for it, prices finalised — and "Send back" moves it one tab left,
// keeping its costing and prices. "Costing completed" (costed) waits in Final price for a final price.
export const DESK_TABS = [
  // Four working tabs instead of eight (owner, 14 Nov 2026: "consolidation required here also").
  // Everything still to be costed: new enquiries — orange until someone starts on them — and those ready for or in
  // costing.
  { key: 'cost', label: 'To cost', stages: ['new', 'ready', 'costing'] },
  // Costed, waiting for the final price; and a customer's counter-offer, waiting for our revised price (11 Nov 2026).
  { key: 'price', label: 'To price', stages: ['costed', 'price_pending', 'countered'] },
  // Finalised (the quotation to make) and sent (waiting for the customer).
  { key: 'quoted', label: 'Quoted', stages: ['quote_ready', 'sent'] },
  // the customer agreed: the order is kept with its rate and any loss, and the team is told (13 Nov 2026)
  { key: 'orders', label: 'Orders', stages: ['ordered'] },
  // off to the side, with Settings
  { key: 'dropped', label: 'Dropped', stages: ['dropped'], side: true },
];
export const tabOfStage = stage => DESK_TABS.find(t => t.stages.includes(stage))?.key || null;
// What "Send back" says on each tab (server: BACK_TO in server/src/enquiry-desk.js).
export const BACK_LABEL = { price: 'Send back to To cost', quoted: 'Send back to To price' };
const TAB_LABEL = Object.fromEntries(DESK_TABS.map(t => [t.key, t.label]));
// "CI-ENQ-0003 → Final price": where a stage sits on the desk, for the undo bar.
export const whereText = stage => TAB_LABEL[tabOfStage(stage)] || stage;
export const STAGE_BACKWARD = { ready: 'new', costing: 'new', costed: 'ready', price_pending: 'ready', quote_ready: 'price_pending' };

export const STAGE_TONE = {
  new: 'bg-sky-100 text-sky-800',
  ready: 'bg-indigo-100 text-indigo-800',
  costing: 'bg-amber-100 text-amber-800',
  costed: 'bg-teal-100 text-teal-800',
  price_pending: 'bg-orange-100 text-orange-800',
  quote_ready: 'bg-emerald-100 text-emerald-800',
  sent: 'bg-slate-200 text-slate-700',
  dropped: 'bg-slate-100 text-slate-500',
  countered: 'bg-amber-200 text-amber-900',
  ordered: 'bg-emerald-200 text-emerald-900',
};

export const QUOTE_TONE = {
  ready: 'bg-emerald-100 text-emerald-800', queued: 'bg-sky-100 text-sky-800', drafted: 'bg-indigo-100 text-indigo-800',
  sent: 'bg-slate-200 text-slate-700', cancelled: 'bg-slate-100 text-slate-500', superseded: 'bg-slate-100 text-slate-500 line-through',
};
export const QUOTE_LABEL = { ready: 'Ready for a draft', queued: 'With Claude', drafted: 'Draft in Gmail — send it from Gmail', sent: 'Sent', cancelled: 'Cancelled', superseded: 'Replaced by a revised quotation' };

export const JOB_LABEL = { fetch: 'Fetch from mail', draft: 'Draft in Gmail' };

// A mailbox as the desk shows it (owner, 12–13 Nov 2026: "Get rid of this also: this trial thing" → "Address customers
// too"): by its address. "Trial" only describes a mailbox whose replies go back to itself (send_to 'own'), never the
// mailbox's name — the desk's mailbox in use answers customers and is not a trial.
export function mailboxTag(box) {
  if (!box) return { text: 'No mailbox in use', tone: 'bg-red-100 text-red-800', title: '' };
  const own = box.send_to !== 'customers';
  return {
    text: own ? `TRIAL · ${box.email} · replies go only to itself` : box.email,
    tone: own ? 'bg-amber-100 text-amber-900' : 'bg-emerald-100 text-emerald-900',
    title: own ? 'Replies from this mailbox go only to its own address' : 'Replies go to the customer',
  };
}

// Who reads a waiting Fetch, and when (14 Nov 2026, "Cloud trigger instead"). The company mailbox: its own cloud routine
// at once when linked, else the office computer's AVS at its hours — the office computer is Windows, with no watcher, so
// nothing there starts "within a minute". The trial mailbox: the owner's Mac, within a minute. `cloud` = the desk's
// { trial, business } links.
export const OFFICE_RUNS = '7:30 am, 1 pm, 3:30 pm or 5:30 pm';
const officeRun = `the office computer's next AVS run reads it (${OFFICE_RUNS})`;
export function fetchWaitText(job, cloud = {}) {
  if (job.fire_status === 'office') return `Waiting for the office computer's next AVS run (${OFFICE_RUNS}).`;
  if (job.fire_status === 'cloud') return `Claude was started in the cloud ${dateText(job.fired_at)} — the enquiries land here in a few minutes.`;
  if (job.fire_status === 'cloud_failed') {
    const linked = !!cloud?.[job.mailbox]?.linked;
    return `Claude in the cloud did not start: ${job.fire_error || 'no answer'}. Press Fetch again${linked ? '' : ', or link Claude in Settings'}`
      + (job.mailbox === 'business' ? ` — otherwise ${officeRun}.` : '.');
  }
  return 'Waiting for the Mac — its Claude starts within a minute when the Mac is on.';
}
export const fetchQueuedText = (mailbox, id) => (mailbox === 'business'
  ? `Fetch queued (job ${id}) — ${officeRun}`
  : `Fetch queued (job ${id}) — the Mac starts within a minute when it is on; the enquiries land here as they are filed`);

// A row whose mail came to a mailbox other than the one in use (13 Nov 2026: the office AVS files the business
// mailbox) names that mailbox, so a person knows where its reply goes from. A row typed in by hand has none.
export function mailboxNote(e, desk) {
  if (!e?.mailbox || !desk || e.mailbox === desk.in_use?.key) return null;
  const box = (desk.mailboxes || []).find(b => b.key === e.mailbox);
  return box?.email ? `to ${box.email}` : null;
}

export const rupees = (n, dp = 2) => (n == null || Number.isNaN(Number(n)) ? '—'
  : `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`);
export const qtyText = n => (n == null ? '—' : Number(n).toLocaleString('en-IN'));
export const quantitiesText = qs => (qs?.length ? qs.map(qtyText).join(' · ') : '—');
export const dateText = d => (d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

// "10,000, 25k" typed in a box → numbers (the server reads "1 lakh" and the rest the same way).
export function parseQuantities(textValue) {
  return String(textValue || '').split(/[,;/\n]|\s+and\s+/i).map(s => {
    const m = s.toLowerCase().replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(lakhs?|lacs?|k)?/);
    if (!m) return null;
    const n = Math.round(Number(m[1]) * (!m[2] ? 1 : m[2].startsWith('l') ? 100000 : 1000));
    return n > 0 ? n : null;
  }).filter(Boolean);
}

// New costing, started from an enquiry: what the customer asked is kept as typed; the costing's
// auto-fill (Product Master, Size Library, history, Rates) fills the rest.
export function costingValueFromEnquiry(e, defaults = {}) {
  const v = blankValue(defaults);
  const from = { kind: 'manual', note: `from ${e.enquiry_no}` };
  v.customer_id = e.customer_id ?? null;
  v.customer_name = e.customer_name || '';
  v.product_id = e.product_id ?? null;
  v.product_name = e.product_name || '';
  v.size_text = e.size_key || e.size_text || '';
  v.style = e.style || null;
  v.opening = e.opening ?? null;
  const qs = e.quantities || [];
  for (const [k, x] of [['qty', qs[0]], ['gsm', e.gsm], ['colours', e.colours]]) {
    if (num(x) > 0) { v.inputs[k] = num(x); v.sources[k] = from; }
  }
  if (num(e.target_price) > 0) { v.inputs.target_price = num(e.target_price); v.sources.target_price = from; }
  for (const k of ['size_text', 'style', 'customer_name']) if (v[k]) v.sources[k] = from;
  if (qs.length > 1) v.quantities = qs.slice(1);
  v.remarks = [`From enquiry ${e.enquiry_no}`, e.board && `board ${e.board}`, e.coating && `coating ${e.coating}`, e.specs].filter(Boolean).join(' — ');
  // The finish the customer asked for (coating, embossing, leafing) — the house rules turn it into rates.
  v.finish = finishFromEnquiry(e);
  v.enquiry_id = e.id;
  v.enquiry_no = e.enquiry_no;
  return v;
}

// A desk row whose costing is CI Plant's own draft it could not finish (an incomplete auto-costing: held for "needs
// pasting" and the like) holds the Rates defaults no rule could replace. The desk opens it in the form as a FRESH fill from
// the enquiry, never as that saved draft; saving links the new costing and hides the draft (server: linkEnquiry). Final
// review C1. Any other costing opens as it was saved.
export const startsFresh = e => !!(e?.costing_live && e.costing_id && e.costing_auto && !e.costing_complete);

// A saved costing opened for an enquiry. `fresh` (copied from an earlier costing to cost this enquiry): the
// enquiry's customer, product and first quantity, the copy's size, layout and rates. Either way the other
// quantities asked show under "Price at other quantities" — the prices Final price will propose.
export function withEnquiry(v, e, { fresh = false, copiedFrom = null } = {}) {
  const out = { ...v, enquiry_id: e.id, enquiry_no: e.enquiry_no, sources: { ...(v.sources || {}) } };
  const qs = (e.quantities || []).map(Number).filter(q => q > 0);
  if (fresh) {
    const from = { kind: 'manual', note: `from ${e.enquiry_no}` };
    out.customer_id = e.customer_id ?? null;
    out.customer_name = e.customer_name || '';
    out.product_id = e.product_id ?? null;
    out.product = null;
    out.product_name = e.product_name || v.product_name || '';
    if (qs[0]) { out.inputs = { ...out.inputs, qty: qs[0] }; out.sources.qty = from; }
    out.remarks = [`From enquiry ${e.enquiry_no}`, copiedFrom && `started from ${copiedFrom}`].filter(Boolean).join(' — ');
    out.finish = finishFromEnquiry(e);
  }
  const own = num(out.inputs?.qty);
  const others = qs.filter(q => q !== own);
  if (others.length) out.quantities = [...new Set([...(out.quantities || []), ...others])].sort((a, b) => a - b);
  return out;
}

// What a bulk costing row starts from, for each enquiry costed together.
export const bulkSeedFromEnquiry = e => ({
  product_name: e.product_name || '', size_text: e.size_key || e.size_text || '', qty: (e.quantities || [])[0] ?? null,
  style: e.style || null, gsm: e.gsm ?? null, colours: e.colours ?? null, enquiry_id: e.id, enquiry_no: e.enquiry_no,
  finish: finishFromEnquiry(e),
});
// The quantities a bulk costing of these enquiries also prices at: every one asked beyond each row's own (up to six).
export const extraQuantities = es => [...new Set(es.flatMap(e => (e.quantities || []).slice(1).map(Number)).filter(q => q > 0))]
  .sort((a, b) => a - b).slice(0, 6);

// Bulk price changes on ticked rows: from each row's final (or suggested) price.
export function adjustPrice(base, { mode, amount }) {
  const b = num(base);
  if (!(b > 0)) return null;
  if (mode === 'add') return Math.round((b + (num(amount) || 0)) * 100) / 100;
  if (mode === 'pct') return Math.ceil(b * (1 + (num(amount) || 0) / 100) * 100 - 1e-6) / 100;
  if (mode === 'round') return Math.ceil(b / 0.05 - 1e-6) * 0.05 > 0 ? Math.round(Math.ceil(b / 0.05 - 1e-6) * 5) / 100 : null;
  return b;
}

// ── Auto costing on the desk (owner, 20 Nov 2026) ───────────────────────────────────────────────
// What the To price row says of its costing: a draft waits for a manager's Approve (auto, or revised by a person — the
// revision makes it theirs but it still needs approval); an approved one says by whom.
export function autoPill(e) {
  if (!e || e.stage === undefined || !['costed', 'price_pending'].includes(e.stage)) return null;
  if (e.costing_status === 'approved') return { text: `Approved by ${e.costing_approved_by || 'Management'}`, tone: 'green' };
  if (e.costing_status === 'draft') return { text: e.costing_auto ? 'Auto · waiting for approval' : 'Waiting for approval', tone: 'amber' };
  return null;
}
export const PILL_TONE = { amber: 'bg-amber-100 text-amber-900 ring-amber-200', green: 'bg-emerald-100 text-emerald-900 ring-emerald-200' };

// What a mail's one reply waits on, as mailReplyState (server/src/enquiry-desk.js) reports it, in that order.
export function replyLine(e) {
  const r = e?.reply;
  if (!r) return null;
  if (r.quoted?.length) return `Part of this mail went on ${r.quoted.join(', ')} — send these from here`;
  // Approve is offered on To price only; the Quoted tab's Send quotation finishes a cut-off reply (final review I1).
  if (r.resume) return 'Finalised, reply not finished — press Send quotation';
  if (r.waiting?.length) {
    const [w, ...rest] = r.waiting;
    return `Reply waits on ${w.enquiry_no}: ${w.why}${rest.length ? ` and ${rest.length} more` : ''}`;
  }
  if (r.ready) return "Ready to reply — a manager's Approve makes it";
  return null;
}

// Why a To cost row was not costed by itself. `auto_cost_stopped` comes from the server (one stale-claim threshold).
export function heldLine(e) {
  if (!e || !['new', 'ready', 'costing'].includes(e.stage) || !e.auto_cost_why) return null;
  if (e.auto_cost_why === 'being costed') return e.auto_cost_stopped ? 'Costing stopped part-way — press Cost it for me' : 'Being costed by CI Plant now';
  return /^could not/i.test(e.auto_cost_why) ? e.auto_cost_why : `Could not cost it by itself: ${e.auto_cost_why}`;
}

const mails = n => `${n} more mail${n === 1 ? '' : 's'}`;
// The reply step's answer in words, one line each — Approve's, and a Management drop's or delete's (a mail left with
// nothing waiting gets its reply then): each reply, the mails not reached in the press's time, what still waits.
export function replyLines(r) {
  const lines = [];
  for (const rep of r?.replies || []) {
    const failed = new Map((rep.failed || []).map(f => [f.id, f.why]));
    const drafted = new Set((rep.drafted || []).map(d => d.id));
    for (const q of rep.quotations || []) {
      lines.push(`Quotation ${q.quotation_no} made · ${drafted.has(q.id) ? 'draft saved' : `draft not made: ${failed.get(q.id) || 'no reason given'}`}`);
    }
    // a failure with no quotation of its own (the reply itself stopped)
    for (const [id, why] of failed) if (!(rep.quotations || []).some(q => q.id === id)) lines.push(`Reply not made: ${why}`);
  }
  if ((r?.later || []).length) lines.push(`${mails(r.later.length)}: reply not made yet — press Approve again`);
  for (const w of r?.waiting || []) {
    if (w.waiting?.length) lines.push(`M${w.mail_id} still waits on ${w.waiting.map(x => `${x.enquiry_no}: ${x.why}`).join('; ')}`);
    if (w.quoted?.length) lines.push(`M${w.mail_id}: part of it went on ${w.quoted.join(', ')} — send the rest from here`);
  }
  return lines;
}
const replyFailed = r => (r?.replies || []).some(x => (x.failed || []).length);

// The Approve answer in words, one line each: what was approved, each reply, what still waits, what was not approved.
export function approveSummary(r) {
  const lines = [`Approved ${(r.approved || []).length}`, ...replyLines(r)];
  if ((r.skipped || []).length) lines.push(`Not approved: ${r.skipped.map(s => `${s.enquiry_no} ${s.why}`).join('; ')}`);
  return lines;
}

// A move's answer in words (final review I5): what moved (`said`), then what the reply step did — a Management drop or
// delete may have made a mail's reply. `moveTone`: Approve's tone when there is a reply line, else null (the bar alone, as
// for any move).
export const moveSummary = (r, said = null) => [said, ...replyLines(r)].filter(Boolean);
export const moveTone = r => (!replyLines(r).length ? null : replyFailed(r) ? 'error' : 'info');

// "Cost it for me": what was costed, and the rows a person must do (held, or failed); then the rows it left as they are,
// with why, and how many it did not reach in the call's time (M1).
export function autoCostSummary(r) {
  const costed = Array.isArray(r.costed) ? r.costed.length : Number(r.costed) || 0;
  return `Costed ${costed} · ${(r.held || []).length + (r.failed || []).length} need a person`;
}
export function autoCostLines(r) {
  const lines = [autoCostSummary(r)];
  if (r.held?.length) lines.push(`Needs a person: ${r.held.map(h => `${h.enquiry_no} ${h.why}`).join('; ')}`);
  if (r.failed?.length) lines.push(`Not costed, it failed: ${r.failed.map(f => `${f.enquiry_no} ${f.why}`).join('; ')}`);
  if (r.skipped?.length) lines.push(`Not costed: ${r.skipped.map(s => `${s.enquiry_no} ${s.why}`).join('; ')}`);
  if (Number(r.left) > 0) lines.push(`${Number(r.left)} not reached — press Cost it for me again`);
  return lines;
}
// The toast's tone: error when anything failed, info when there is more to read, else success.
export const autoCostTone = r => (r.failed?.length ? 'error' : r.held?.length || r.skipped?.length || Number(r.left) > 0 ? 'info' : 'success');
export const approveTone = r => (replyFailed(r) ? 'error' : approveSummary(r).length > 1 ? 'info' : 'success');
