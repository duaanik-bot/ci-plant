// The enquiry desk's screen helpers (server rules: server/src/enquiry-desk.js).
import { num } from './costing.js';
import { blankValue } from './costingUi.js';
import { finishFromEnquiry } from './costingRules.js';

// The desk's tabs and the stages each shows, left to right (5 Nov 2026). A row moves right when its work is
// done — Send to costing, a costing saved for it, prices finalised — and "Send back" moves it one tab left,
// keeping its costing and prices. "Costing completed" (costed) waits in Final price for a final price.
export const DESK_TABS = [
  { key: 'inbox', label: 'Inbox', stages: ['new'] },
  { key: 'costing', label: 'Costing', stages: ['ready', 'costing'] },
  { key: 'price', label: 'Final price', stages: ['costed', 'price_pending'] },
  // the customer's counter-offer, waiting for our revised price (11 Nov 2026)
  { key: 'counter', label: 'Counter', stages: ['countered'] },
  { key: 'quote', label: 'Quotations', stages: ['quote_ready'] },
  { key: 'sent', label: 'Sent', stages: ['sent'] },
  { key: 'dropped', label: 'Dropped', stages: ['dropped'] },
];
export const tabOfStage = stage => DESK_TABS.find(t => t.stages.includes(stage))?.key || null;
// What "Send back" says on each tab (server: BACK_TO in server/src/enquiry-desk.js).
export const BACK_LABEL = { costing: 'Send back to Inbox', price: 'Send back to Costing', quote: 'Send back to Final price' };
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
};

export const QUOTE_TONE = {
  ready: 'bg-emerald-100 text-emerald-800', queued: 'bg-sky-100 text-sky-800', drafted: 'bg-indigo-100 text-indigo-800',
  sent: 'bg-slate-200 text-slate-700', cancelled: 'bg-slate-100 text-slate-500', superseded: 'bg-slate-100 text-slate-500 line-through',
};
export const QUOTE_LABEL = { ready: 'Ready for a draft', queued: 'With Claude', drafted: 'Draft in Gmail — send it from Gmail', sent: 'Sent', cancelled: 'Cancelled', superseded: 'Replaced by a revised quotation' };

export const JOB_LABEL = { fetch: 'Fetch from mail', draft: 'Draft in Gmail' };

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
