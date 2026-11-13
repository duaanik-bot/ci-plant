// The enquiry desk's rules, kept apart from the routes so they are tested on their own
// (docs/superpowers/specs/2026-11-03-enquiry-desk-design.md).
//
//   stages        the brief's seven statuses (+ Dropped); "Costing completed" is read from the costing
//   cleanItem     one item as the robot or a person gives it, checked and trimmed
//   cleanMail     one filed mail and its items
//   priceRows     per quantity: the costing's proposed price per carton and the person's final price
//   customerLine  THE ONLY way a quotation line is made: a whitelist of customer-facing fields. The PDF and
//                 the e-mail are made from quotation rows and never read a costing (strict separation).
//   composeReply  the reply's subject, text and HTML, from a quotation row
import { num, parseSize, normStyle, quantityBreaks, STYLES } from './costing-engine.js';

export const STATUS_LABEL = Object.freeze({
  new: 'New enquiry',
  ready: 'Ready for costing',
  costing: 'Costing in progress',
  costed: 'Costing completed',
  price_pending: 'Final price pending',
  quote_ready: 'Quotation ready',
  sent: 'Quotation sent',
  dropped: 'Dropped',
  countered: 'Counter received',
  // the customer agreed: the order is recorded with its rate and any loss, and the team is told (13 Nov 2026)
  ordered: 'Order finalised',
});
// The stored status, read against the linked costing (5 Nov 2026): an enquiry in costing whose costing is
// complete reads "Costing completed"; one in costing with no costing behind it — none was saved, or it was
// hidden — reads "Ready for costing". So a costing screen left without saving never strands a row as if
// it were being costed. `hasCosting` = a costing is linked and not hidden.
export const stageOf = (status, costingComplete, hasCosting = true) => {
  if (status !== 'costing') return status;
  if (!hasCosting) return 'ready';
  return costingComplete ? 'costed' : 'costing';
};
// SQL twin of stageOf, for filters: e = enquiries, c = the linked costing.
export const STAGE_SQL = `CASE WHEN e.status <> 'costing' THEN e.status
  WHEN c.id IS NULL OR c.archived THEN 'ready' WHEN c.complete THEN 'costed' ELSE 'costing' END`;

// The desk's tabs, left to right: Inbox (new) · Costing (ready, costing) · Final price (costed, price_pending) ·
// Quotations (quote_ready) · Sent. "Send back" moves a row one tab to the left; the costing and any final
// prices stay with it, so nothing is lost and it can go forward again.
export const BACK_TO = Object.freeze({ ready: 'new', costing: 'new', costed: 'ready', price_pending: 'ready', quote_ready: 'price_pending' });
// "Bring back" from Dropped: to where the row was when it was dropped (an older drop kept no record:
// Costing if it has a costing, else the Inbox).
export const broughtBack = (was, costingId) => (['new', 'ready', 'costing', 'price_pending'].includes(was) ? was : costingId ? 'costing' : 'new');

// The columns a desk change can touch. Each change keeps them as they were, so it can be undone.
export const UNDO_COLS = Object.freeze([
  'status', 'dropped_reason', 'costing_id', 'batch_id', 'final_prices', 'finalised_by', 'finalised_by_name', 'finalised_at',
  'quotation_id', 'customer_id', 'customer_name', 'contact_name', 'contact_email', 'product_id', 'product_name', 'size_text',
  'size_key', 'style', 'board', 'gsm', 'colours', 'coating', 'specs', 'quantities', 'target_price', 'notes',
  'counter', 'counter_mail_id', 'counter_at', 'counter_by_name', 'counter_round',
]);

const MAX = { text: 300, specs: 1000, body: 20000, items: 30, attachments: 30, quantities: 6 };
const text = (v, max = MAX.text) => {
  if (v == null) return null;
  const s = String(v).replace(/\u0000/g, '').trim();
  return s ? s.slice(0, max) : null;
};
const email = v => {
  const s = text(v, 200)?.toLowerCase();
  return s && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s) ? s : null;
};

// "10,000", "10000 nos", "1,00,000", "10k", "1 lakh", "1.5 lac", "25K pcs" → a number of cartons.
export function parseQuantity(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
  const s = String(v ?? '').toLowerCase().replace(/,/g, '').trim();
  const m = s.match(/(\d+(?:\.\d+)?)\s*(lakhs?|lacs?|l\b|k\b|thousand)?/);
  if (!m) return null;
  const mult = !m[2] ? 1 : /^l/.test(m[2]) ? 100000 : 1000;
  const n = Math.round(Number(m[1]) * mult);
  return n > 0 ? n : null;
}
export function cleanQuantities(list) {
  const arr = Array.isArray(list) ? list : list == null ? [] : [list];
  return [...new Set(arr.map(parseQuantity).filter(Boolean))].sort((a, b) => a - b).slice(0, MAX.quantities);
}

// One item asked about. Nothing is required but a product name or a size: the person completes the rest.
export function cleanItem(raw = {}) {
  const size = parseSize(text(raw.size_text ?? raw.size, 60));
  const item = {
    product_name: text(raw.product_name ?? raw.product, 200),
    size_text: size ? (size.kind === 'other' ? size.label : size.key) : null,
    size_key: size?.key ?? null,
    style: normStyle(raw.style ?? raw.pasting) || null,
    board: text(raw.board, 80),
    gsm: num(raw.gsm) > 0 ? num(raw.gsm) : null,
    colours: num(raw.colours ?? raw.colors) > 0 ? num(raw.colours ?? raw.colors) : null,
    coating: text(raw.coating, 80),
    specs: text(raw.specs, MAX.specs),
    quantities: cleanQuantities(raw.quantities ?? raw.quantity ?? raw.qty),
    target_price: num(raw.target_price) > 0 ? num(raw.target_price) : null,
    notes: text(raw.notes, MAX.specs),
  };
  if (item.style && !STYLES[item.style]) item.style = null;
  return item.product_name || item.size_text ? item : null;
}

// A mail the robot files: the Gmail ids are required; everything else is kept as given, trimmed.
export function cleanMail(raw = {}) {
  const id = text(raw.gmail_message_id, 100);
  if (!id) return { error: 'gmail_message_id is missing' };
  const received = raw.received_at ? new Date(raw.received_at) : null;
  const attachments = (Array.isArray(raw.attachments) ? raw.attachments : []).slice(0, MAX.attachments)
    .map(a => ({ name: text(a?.name ?? a?.filename, 200), mime: text(a?.mime ?? a?.mimeType, 100), size: num(a?.size) ?? null }))
    .filter(a => a.name);
  const items = (Array.isArray(raw.items) ? raw.items : []).slice(0, MAX.items).map(cleanItem).filter(Boolean);
  return {
    gmail_message_id: id,
    gmail_thread_id: text(raw.gmail_thread_id, 100),
    subject: text(raw.subject, 300),
    from_name: text(raw.from_name, 160),
    from_email: email(raw.from_email),
    to_text: text(raw.to_text ?? raw.to, 500),
    received_at: received && !Number.isNaN(received.getTime()) ? received.toISOString() : null,
    body_text: text(raw.body_text, MAX.body),
    attachments,
    view_url: /^https:\/\/mail\.google\.com\//.test(String(raw.view_url || '')) ? String(raw.view_url).slice(0, 500) : null,
    summary: text(raw.summary, 300),
    customer_name: text(raw.customer_name ?? raw.company_name, 160),
    contact_name: text(raw.contact_name, 160) || text(raw.from_name, 160),
    contact_email: email(raw.contact_email) || email(raw.from_email),
    items,
  };
}

// Up to the paisa, never below the proposal.
export const ceilPaise = x => (num(x) > 0 ? Math.ceil(num(x) * 100 - 1e-6) / 100 : null);
const round2 = x => Math.round(x * 100) / 100;

// Per quantity asked about (the costing's own quantity when none was): the proposed price per carton —
// the costing's quote price at that quantity (CI-1) — and the final price the person set, with the
// proposal it was set against. Proposed is null while the costing is incomplete.
export function priceRows(enquiry, costingInputs) {
  const asked = (enquiry.quantities || []).map(Number).filter(q => q > 0);
  const qs = asked.length ? asked : [num(costingInputs?.qty)].filter(q => q > 0);
  const breaks = costingInputs ? quantityBreaks(costingInputs, qs) : [];
  const finals = Array.isArray(enquiry.final_prices) ? enquiry.final_prices : [];
  const counter = Array.isArray(enquiry.counter) ? enquiry.counter : [];
  return qs.map(qty => {
    const b = breaks.find(x => x.qty === qty);
    const proposed = b?.ok ? b.quote_per_unit : null;
    const f = finals.find(x => Number(x.qty) === qty);
    const final = num(f?.final) > 0 ? num(f.final) : null;
    const k = counter.find(x => Number(x.qty) === qty);
    return {
      qty, proposed,
      // our cost a carton (the costing, before its margin) — the line under which a price loses money
      cost: b?.ok ? b.cost_per_unit : null,
      // the customer's counter for this quantity, and our price it answered (11 Nov 2026)
      theirs: num(k?.theirs) > 0 ? num(k.theirs) : null,
      ours: num(k?.ours) > 0 ? num(k.ours) : null,
      final,
      suggested: ceilPaise(proposed),
      set_against: num(f?.proposed) ?? null,
      // the costing moved after the final price was set
      changed: final != null && proposed != null && num(f?.proposed) != null && Math.abs(num(f.proposed) - proposed) > 1e-6,
    };
  });
}

// What the customer is told about an item's make-up: what THEY asked for, as the enquiry recorded it.
export function customerSpecs(e) {
  return [
    e.style && STYLES[e.style] ? STYLES[e.style] : null,
    e.board,
    num(e.gsm) > 0 ? `${num(e.gsm)} GSM` : null,
    num(e.colours) > 0 ? `${num(e.colours)} colour${num(e.colours) === 1 ? '' : 's'}` : null,
    e.coating,
    e.specs,
  ].filter(Boolean).join(', ');
}

// A quotation line. Built from the enquiry's customer-facing fields and the final price only: a costing,
// a proposed price or an internal note can never reach it, because nothing else is read here.
// "120x62x70" → "120 × 62 × 70", as a customer reads a size.
export const sizeText = s => String(s || '').replace(/(\d)\s*[x×*]\s*(?=\d)/gi, '$1 × ');
export function customerLine(e, { qty, rate, first = null, counter = null }, option = false) {
  const q = Math.round(num(qty));
  const r = round2(num(rate));
  return {
    // a revised quotation after the customer's counter: our first quote and their counter for this quantity, so the
    // reader sees the whole history in one table (owner, 11 Nov 2026)
    ...(num(counter) > 0 ? { first: num(first) > 0 ? round2(num(first)) : null, counter: round2(num(counter)) } : {}),
    enquiry_id: e.id,
    enquiry_no: e.enquiry_no,
    product: e.product_name || '',
    size: sizeText(e.size_text),
    specs: customerSpecs(e),
    qty: q,
    rate: r,
    amount: round2(q * r),
    option,
  };
}
export const LINE_KEYS = Object.freeze(['enquiry_id', 'enquiry_no', 'product', 'size', 'specs', 'qty', 'rate', 'amount', 'option']);
// on a revised quotation's line only: our first quote and their counter (both customer-facing by the owner's choice)
export const LINE_HISTORY_KEYS = Object.freeze(['first', 'counter']);

// Quotation lines for one customer's enquiries: every quantity asked about, the first one counted in
// the total and the others listed as options.
export function quotationLines(enquiries) {
  const lines = [];
  for (const e of enquiries) {
    const finals = (e.final_prices || []).filter(f => num(f.final) > 0).sort((a, b) => num(a.qty) - num(b.qty));
    const counter = Number(e.counter_round) > 0 && Array.isArray(e.counter) ? e.counter : [];
    finals.forEach((f, i) => {
      const k = counter.find(c => num(c.qty) === num(f.qty));
      lines.push(customerLine(e, { qty: f.qty, rate: f.final, first: k?.ours, counter: k?.theirs }, i > 0));
    });
  }
  const total = round2(lines.filter(l => !l.option).reduce((s, l) => s + l.amount, 0));
  return { lines, total, has_options: lines.some(l => l.option) };
}

// Who one quotation is for: the customer master, else the sender's address, else the typed name.
export function customerKey(e) {
  if (e.customer_id) return `c:${e.customer_id}`;
  if (e.contact_email) return `e:${e.contact_email.toLowerCase()}`;
  return `n:${(e.customer_name || '').trim().toLowerCase() || `enquiry-${e.id}`}`;
}
export function groupByCustomer(enquiries) {
  const groups = new Map();
  for (const e of enquiries) {
    const k = customerKey(e);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  return [...groups.values()];
}

// ── the reply ────────────────────────────────────────────────────────────────────────────────────
const inr = n => `Rs. ${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qtyText = n => Number(n).toLocaleString('en-IN');
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function replySubject(original, quotationNo, trial = false) {
  const base = original ? (/^re:/i.test(original.trim()) ? original.trim() : `Re: ${original.trim()}`) : `Quotation ${quotationNo} — Colour Impressions`;
  // No "[TRIAL]" tag (owner, 11 Nov 2026: replies went out to the customer from the trial mailbox with it): a trial
  // mailbox is kept safe by WHO the draft is addressed to, never by words the customer could see.
  return base.slice(0, 300);
}

// The reply: greeting, the person's opening words, the rates, the closing words, the signature. Made from
// the quotation row alone. The customer sees each item's rate a carton at each quantity — no amount column and
// no total (owner, 3 Nov 2026); the total stays inside, on the quotation row. Always "Dear Sir/Madam", never a name.
export function composeReply(qt, { sender = null, trialFor = null } = {}) {
  // Signed by the person who sends it, then the company (the company once when there is no name).
  const signature = [...new Set([sender, 'Colour Impressions'].filter(Boolean))];
  const greet = 'Dear Sir/Madam,';
  const lines = qt.lines || [];
  // After a counter: our first quote and their counter beside the revised rate, on every row that has them.
  const history = lines.some(l => l.counter != null);
  const rows = lines.map((l, i) => ({
    n: i + 1,
    what: [l.product, l.size ? `${l.size} mm` : null].filter(Boolean).join(' — '),
    specs: l.specs,
    qty: qtyText(l.qty),
    rate: inr(l.rate),
    first: l.first != null ? inr(l.first) : '—',
    counter: l.counter != null ? inr(l.counter) : '—',
  }));
  // No trial line and no "attached" line in what the customer reads (owner, 11 Nov 2026); `trialFor` is kept in the
  // signature for the callers but writes nothing.
  void trialFor;
  const textBody = [
    greet, '',
    qt.email_opening || '', '',
    ...rows.map(r => `${r.n}. ${r.what}${r.specs ? ` (${r.specs})` : ''}\n   ${r.qty} cartons — ${history
      ? `our first quote ${r.first} · your counter ${r.counter} · our revised rate ${r.rate} a carton`
      : `at ${r.rate} a carton`}`.replace(' — at ', ' at ')),
    qt.terms ? `\n${qt.terms}` : null,
    '', qt.email_closing || '', '',
    'Regards,', ...signature,
  ].filter(x => x != null).join('\n').replace(/\n{3,}/g, '\n\n');
  const td = 'style="border:1px solid #d0d5dd;padding:6px 8px;font-size:13px"';
  const th = 'style="border:1px solid #d0d5dd;padding:6px 8px;font-size:12px;background:#f2f4f7;text-align:left"';
  const html = [
    `<p>${esc(greet)}</p>`,
    qt.email_opening ? `<p>${esc(qt.email_opening).replace(/\n/g, '<br>')}</p>` : '',
    `<table cellspacing="0" style="border-collapse:collapse"><thead><tr><th ${th}>#</th><th ${th}>Item</th><th ${th}>Specification</th><th ${th}>Quantity</th>${history
      ? `<th ${th}>Our first quote</th><th ${th}>Your counter</th><th ${th}>Our revised rate a carton</th>` : `<th ${th}>Rate a carton</th>`}</tr></thead><tbody>`,
    ...rows.map(r => `<tr><td ${td}>${r.n}</td><td ${td}>${esc(r.what)}</td><td ${td}>${esc(r.specs)}</td><td ${td} align="right">${esc(r.qty)}</td>${history
      ? `<td ${td} align="right">${esc(r.first)}</td><td ${td} align="right">${esc(r.counter)}</td><td ${td} align="right"><b>${esc(r.rate)}</b></td>`
      : `<td ${td} align="right">${esc(r.rate)}</td>`}</tr>`),
    `</tbody></table>`,
    qt.terms ? `<p style="font-size:12px;color:#475467">${esc(qt.terms).replace(/\n/g, '<br>')}</p>` : '',
    qt.email_closing ? `<p>${esc(qt.email_closing).replace(/\n/g, '<br>')}</p>` : '',
    `<p>Regards,<br>${signature.map(esc).join('<br>')}</p>`,
  ].join('');
  return { subject: qt.email_subject, text: textBody, html };
}

// Who a reply goes to. A mailbox that sends to its own address only (the trial) gets its own address,
// whoever asked; a business mailbox answers the customer.
export function replyRecipient(mailbox, contactEmail) {
  if (!mailbox) return { error: 'No mailbox is set for this quotation.' };
  if (mailbox.send_to !== 'customers') return { to: mailbox.email, trial: true, would_go_to: contactEmail || null };
  if (!email(contactEmail)) return { error: 'The customer has no e-mail address — type it on the quotation.' };
  return { to: email(contactEmail), trial: false };
}
