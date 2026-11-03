// The enquiry desk's screen helpers (server rules: server/src/enquiry-desk.js).
import { num } from './costing.js';
import { blankValue } from './costingUi.js';

// The desk's tabs and the statuses each shows. "Costing completed" (costed) waits for a final price.
export const DESK_TABS = [
  { key: 'inbox', label: 'Inbox', stages: ['new', 'ready'] },
  { key: 'costing', label: 'Costing', stages: ['costing'] },
  { key: 'price', label: 'Final price', stages: ['costed', 'price_pending'] },
  { key: 'quote', label: 'Quotations', stages: ['quote_ready'] },
  { key: 'sent', label: 'Sent', stages: ['sent'] },
  { key: 'dropped', label: 'Dropped', stages: ['dropped'] },
];

export const STAGE_TONE = {
  new: 'bg-sky-100 text-sky-800',
  ready: 'bg-indigo-100 text-indigo-800',
  costing: 'bg-amber-100 text-amber-800',
  costed: 'bg-teal-100 text-teal-800',
  price_pending: 'bg-orange-100 text-orange-800',
  quote_ready: 'bg-emerald-100 text-emerald-800',
  sent: 'bg-slate-200 text-slate-700',
  dropped: 'bg-slate-100 text-slate-500',
};

export const QUOTE_TONE = {
  ready: 'bg-emerald-100 text-emerald-800', queued: 'bg-sky-100 text-sky-800', drafted: 'bg-indigo-100 text-indigo-800',
  sent: 'bg-slate-200 text-slate-700', cancelled: 'bg-slate-100 text-slate-500',
};
export const QUOTE_LABEL = { ready: 'Ready for a draft', queued: 'With Claude', drafted: 'Draft in Gmail — send it from Gmail', sent: 'Sent', cancelled: 'Cancelled' };

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
  v.enquiry_id = e.id;
  v.enquiry_no = e.enquiry_no;
  return v;
}

// What a bulk costing row starts from, for each enquiry pushed.
export const bulkSeedFromEnquiry = e => ({
  product_name: e.product_name || '', size_text: e.size_key || e.size_text || '', qty: (e.quantities || [])[0] ?? null,
  style: e.style || null, gsm: e.gsm ?? null, colours: e.colours ?? null, enquiry_id: e.id, enquiry_no: e.enquiry_no,
});

// Bulk price changes on ticked rows: from each row's final (or suggested) price.
export function adjustPrice(base, { mode, amount }) {
  const b = num(base);
  if (!(b > 0)) return null;
  if (mode === 'add') return Math.round((b + (num(amount) || 0)) * 100) / 100;
  if (mode === 'pct') return Math.ceil(b * (1 + (num(amount) || 0) / 100) * 100 - 1e-6) / 100;
  if (mode === 'round') return Math.ceil(b / 0.05 - 1e-6) * 0.05 > 0 ? Math.round(Math.ceil(b / 0.05 - 1e-6) * 5) / 100 : null;
  return b;
}
