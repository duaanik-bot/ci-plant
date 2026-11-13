// Order finalised (owner, 12 Nov 2026: "Once the order is finalised with the customer, we need a button to finalise
// the order … If that is the new die then we will be [mailing] our company, mppchd@gmail.com, saying that these orders
// have been finalised at these and these rates … these are the prices that have been given for these output sizes and
// these are the die lines … in the form of a table … the price … pre-filled but still editable … it needs to be
// mentioned what the loss is where we have booked this order"). Spec: docs/superpowers/specs/2026-11-13-order-finalised-design.md
//
//   orderLine    one item of the order: the enquiry, its costing and the quotation it was quoted on, with the person's
//                edits (quantity, rate, new die) — the margin or loss a carton and on the order, the output sheet, ups,
//                board, art details and KLD
//   orderTotals  the order's value, its loss (the lines below cost) and how many new dies
//   orderMail    the order sheet for the team at the company mailbox: rates, never a cost, margin or loss (those stay
//                in CI Plant, as everywhere on the desk)
// Pure: no database, no clock (the date comes in).
import { num, quantityBreaks, STYLES } from './costing-engine.js';
import { HOUSE_RULES } from '../../client/src/lib/costingRules.js';
import { ceilPaise, sizeText } from './enquiry-desk.js';

// A saved costing keeps its figures, not the New die tick: the new-die process charge is how it shows.
export const NEW_DIE_PROCESS = HOUSE_RULES.process_new_die;
export const newDieFromInputs = inputs => num(inputs?.process) >= NEW_DIE_PROCESS;

const r2 = x => Math.round(x * 100) / 100;
const r4 = x => Math.round(x * 10000) / 10000;
const why = text => Object.assign(new Error(text), { why: text, status: 400 });
const artOf = e => [
  num(e.colours) > 0 ? `${num(e.colours)} colour${num(e.colours) === 1 ? '' : 's'}` : null, e.coating || null, e.specs || null,
].filter(Boolean).join(', ') || null;

// `quotationLine` = the item's line on the customer's quotation ({ qty, rate }), when it was quoted.
// `edits` = { qty, rate, new_die } as the person left them in the panel; a missing quantity or rate is refused.
export function orderLine(e, { inputs = null, quotationLine = null, kld = null, edits = null } = {}) {
  const asked = (e.quantities || []).map(Number).filter(q => q > 0);
  let qty = num(quotationLine?.qty) > 0 ? num(quotationLine.qty) : asked[0] || (num(inputs?.qty) > 0 ? num(inputs.qty) : null);
  if (edits && edits.qty !== undefined && edits.qty !== null) {
    const q = Math.round(num(edits.qty));
    if (!(q > 0)) throw why('a quantity is needed');
    qty = q;
  }
  const b = inputs && qty ? quantityBreaks(inputs, [qty])[0] : null;
  // the costing's own cost a carton (before its margin): the line under which this rate loses money
  const rawCost = b?.ok ? b.cost_per_unit : null;
  const finals = Array.isArray(e.final_prices) ? e.final_prices : [];
  const f = finals.find(x => Number(x.qty) === qty);
  let rate = num(quotationLine?.rate) > 0 ? num(quotationLine.rate)
    : num(f?.final) > 0 ? num(f.final)
      : b?.ok ? ceilPaise(b.quote_per_unit) : null;
  if (edits && edits.rate !== undefined && edits.rate !== null) {
    const v = r2(num(edits.rate) || 0);
    if (!(v > 0)) throw why('a rate a carton is needed');
    rate = v;
  }
  const counter = (Array.isArray(e.counter) ? e.counter : []).find(x => Number(x.qty) === qty);
  const gap = rawCost != null && rate != null ? rate - rawCost : null;
  return {
    enquiry_id: e.id ?? null,
    enquiry_no: e.enquiry_no || null,
    product: e.product_name || '',
    size: e.size_text ? sizeText(e.size_text) : null,
    style: e.style ? (STYLES[e.style] || e.style) : null,
    art: artOf(e),
    board: e.board || null,
    gsm: num(inputs?.gsm) > 0 ? num(inputs.gsm) : num(e.gsm) > 0 ? num(e.gsm) : null,
    qty,
    rate,
    value: rate != null && qty ? r2(rate * qty) : null,
    cost: rawCost != null ? r4(rawCost) : null,
    margin: gap != null ? r4(gap) : null,
    margin_total: gap != null && qty ? r2(gap * qty) : null,
    sheet: num(inputs?.sheet_l) > 0 && num(inputs?.sheet_w) > 0 ? { l: num(inputs.sheet_l), w: num(inputs.sheet_w) } : null,
    ups: num(inputs?.ups) > 0 ? num(inputs.ups) : null,
    new_die: edits && typeof edits.new_die === 'boolean' ? edits.new_die : newDieFromInputs(inputs),
    kld: num(kld?.rev) > 0 ? { rev: num(kld.rev), size_id: kld.size_id ?? null } : null,
    quoted: num(quotationLine?.rate) > 0 ? num(quotationLine.rate) : null,
    counter: num(counter?.theirs) > 0 ? num(counter.theirs) : null,
  };
}

export function orderTotals(lines) {
  let total = 0, loss = 0, atLoss = 0, newDies = 0;
  for (const l of lines || []) {
    total += num(l.value) || 0;
    if (num(l.margin_total) < 0) { loss += -num(l.margin_total); atLoss++; }
    if (l.new_die) newDies++;
  }
  return { total: r2(total), loss: r2(loss), items_at_loss: atLoss, new_dies: newDies };
}

// ── the order sheet for the team ──────────────────────────────────────────────────────────────────
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plain = n => Math.round(num(n) || 0).toLocaleString('en-IN');
const rate2 = n => `₹${(num(n) || 0).toFixed(2)}`;
const sheetText = l => (l.sheet ? `${l.sheet.l} × ${l.sheet.w} in` : '—');
const boardText = l => [l.board, l.gsm ? `${l.gsm} GSM` : null].filter(Boolean).join(', ') || '—';
const dieText = l => (l.new_die ? 'NEW DIE' : 'Existing die');
const kldText = l => (l.kld ? `KLD rev ${l.kld.rev} attached` : 'KLD not drawn yet');
const istDate = d => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(d));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function orderMail({ order_no, customer, quotation_no = null, lines, by, at }) {
  const n = lines.length;
  const dies = lines.filter(l => l.new_die).length;
  const subject = `Order finalised — ${customer || 'customer'} — ${plural(n, 'item')}${dies ? `, ${plural(dies, 'new die')}` : ''} — ${order_no}`;
  const head = [`Customer: ${customer || '—'}`, quotation_no ? `Quotation: ${quotation_no}` : null, `Finalised by ${by || '—'} on ${istDate(at)}`]
    .filter(Boolean).join(' · ');
  const ask = dies
    ? 'Please arrange the dies accordingly: the new dies are marked NEW DIE, and their KLDs (die lines) are attached where drawn.'
    : 'For your planning: these items run on existing dies.';
  const intro = `The orders below have been finalised with ${customer || 'the customer'} at these rates. ${ask}`;

  const text = [
    `Order finalised — ${order_no}`, head, '', intro, '',
    ...lines.flatMap((l, i) => [
      `${i + 1}. ${l.product}${l.size ? ` — ${l.size} mm` : ''}${l.style ? `, ${l.style}` : ''}`,
      `   Art: ${l.art || '—'}`,
      `   Quantity ${plain(l.qty)} · Rate ${rate2(l.rate)} a carton · Value ₹${plain(l.value)}`,
      `   Output sheet ${sheetText(l)} · ${l.ups ? `${l.ups} ups` : 'ups —'} · Board ${boardText(l)}`,
      `   ${dieText(l)} · ${kldText(l)}`,
      '',
    ]),
    `— ${by || 'CI Plant'}, via CI Plant`,
  ].join('\n');

  const th = s => `<th style="border:1px solid #94a3b8;padding:5px 7px;background:#eef2f7;text-align:left;white-space:nowrap">${esc(s)}</th>`;
  const td = (s, extra = '') => `<td style="border:1px solid #cbd5e1;padding:5px 7px;vertical-align:top${extra}">${esc(s)}</td>`;
  const right = ';text-align:right;white-space:nowrap';
  const rows = lines.map((l, i) => `<tr>${[
    td(i + 1),
    `<td style="border:1px solid #cbd5e1;padding:5px 7px;vertical-align:top"><b>${esc(l.product)}</b>${l.enquiry_no ? `<br><span style="color:#64748b">${esc(l.enquiry_no)}</span>` : ''}</td>`,
    td([l.size ? `${l.size} mm` : null, l.style].filter(Boolean).join(', ') || '—'),
    td(l.art || '—'),
    td(plain(l.qty), right),
    td(rate2(l.rate), right),
    td(`₹${plain(l.value)}`, right),
    td(sheetText(l), ';white-space:nowrap'),
    td(l.ups ?? '—', right),
    td(boardText(l)),
    l.new_die ? `<td style="border:1px solid #cbd5e1;padding:5px 7px;vertical-align:top;font-weight:bold;color:#b91c1c">NEW DIE</td>` : td('Existing die'),
    td(kldText(l)),
  ].join('')}</tr>`).join('');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#0f172a">
<p style="font-size:15px"><b>Order finalised — ${esc(order_no)}</b><br><span style="color:#475569">${esc(head)}</span></p>
<p>${esc(intro)}</p>
<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-size:12px">
<tr>${['#', 'Product', 'Size', 'Art details', 'Quantity', 'Rate a carton', 'Value', 'Output sheet', 'Ups', 'Board', 'Die', 'KLD'].map(th).join('')}</tr>
${rows}
</table>
<p style="color:#475569">— ${esc(by || 'CI Plant')}, via CI Plant</p>
</div>`;
  return { subject, text, html };
}
