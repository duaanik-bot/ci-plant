// Costing screens — the pure parts: money on screen, which earlier costing is the fair comparison,
// reading rows pasted from Excel, and the export layouts. No React, no fetch, so the server suite
// tests it (server/src/costing-ui.test.js).
import { computeCosting, compareCostings, parseSize, num, CURRENT_FORMULA, INPUTS } from './costing.js';

// ₹ per carton to three decimals (3.142, 0.618 — the trade quotes to a tenth of a paisa); totals whole.
export const perUnit = n => (n == null || !Number.isFinite(+n) ? '—' : `₹${(+n).toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 })}`);
export const rupees = n => (n == null || !Number.isFinite(+n) ? '—' : `₹${Math.round(+n).toLocaleString('en-IN')}`);
export const pct = (n, dp = 1) => (n == null || !Number.isFinite(+n) ? '—' : `${n > 0 ? '+' : ''}${(+n).toFixed(dp)}%`);
export const plain = (n, dp = 2) => (n == null || !Number.isFinite(+n) ? '—' : (+n).toLocaleString('en-IN', { maximumFractionDigits: dp }));

// A coating factor in words a new joiner can check: factor 6 → "₹1 per 600 sq in".
export const coatingWords = factor => (num(factor) > 0 ? `₹1 per ${plain(num(factor) * 100, 0)} sq in` : 'No coating');
export function coatingLabel(c) {
  const words = coatingWords(c.factor);
  return c.name ? `${c.name} — ${words}` : `${words} (factor ${plain(c.factor)})`;
}

// The inputs a new costing starts with: the Rates tab's defaults, nothing job-specific.
export function startingInputs(defaults = {}) {
  const out = {};
  for (const { key } of INPUTS) out[key] = defaults[key] ?? '';
  for (const k of ['qty', 'sheet_l', 'sheet_w', 'ups', 'gsm', 'board_rate', 'target_price']) out[k] = '';
  // Coating is a choice every costing makes — "No coating" included — so it never starts filled.
  out.coat_factor = '';
  return out;
}

// What the form still needs, the engine's list plus the coating choice (blank coating would quietly
// cost a coated carton as uncoated).
export function stillNeeded(value) {
  const r = computeCosting(value?.inputs || {});
  const list = r.ok ? [] : r.missing.map(m => m.label);
  if (!value?.product_name?.trim()) list.unshift('Product name');
  if (!parseSize(value?.size_text)) list.push('Carton size');
  if (value?.coat_choice == null || value.coat_choice === '') list.push('Coating');
  return list;
}

// Earlier costings of the same size, best comparison first. "Comparable" = same pasting (or one side
// not recorded) and GSM within 10 — a different carton style or board is shown, never compared.
// Among comparable ones the newest wins; on the same day, the nearest quantity.
export function rankHistory(current, history = []) {
  const style = current?.style || null;
  const gsm = num(current?.inputs?.gsm);
  const qty = num(current?.inputs?.qty);
  const rows = history.filter(h => h.result?.ok).map(h => {
    const sameStyle = !style || !h.style || h.style === style;
    const sameBoard = gsm == null || h.gsm == null || Math.abs(h.gsm - gsm) <= 10;
    const qtyGap = qty > 0 && h.qty > 0 ? Math.abs(Math.log(h.qty / qty)) : 0;
    return { ...h, comparable: sameStyle && sameBoard, why: !sameStyle ? 'different pasting' : !sameBoard ? 'different GSM' : null, qtyGap };
  });
  rows.sort((a, b) => (b.comparable - a.comparable)
    || String(b.costed_on || '').localeCompare(String(a.costed_on || ''))
    || a.qtyGap - b.qtyGap);
  return rows;
}

// The closest earlier costing against the current one, or null.
export function closestComparison(current, currentResult, history, alertPct = 15) {
  if (!currentResult?.ok) return null;
  const best = rankHistory(current, history).find(h => h.comparable);
  if (!best) return null;
  const cmp = compareCostings({ inputs: current.inputs, result: currentResult }, { inputs: best.inputs, result: best.result }, { threshold: alertPct });
  return cmp && { ...cmp, against: best };
}

// Rows pasted from Excel: Product · Size · Quantity, tab-separated (a header row is skipped). The size
// is found by its shape, so the columns may come in another order; a row without a size or a quantity
// is still added, to be filled in on screen.
export function parsePaste(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').map(l => l.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    const cells = line.split(/\t|\s{2,}|;/).map(c => c.trim()).filter(Boolean);
    if (!cells.length) continue;
    let size = null, qty = null;
    const rest = [];
    for (const c of cells) {
      const s = parseSize(c);
      if (!size && s && s.kind !== 'other') { size = c; continue; }
      const n = num(c.replace(/\s*(pcs|nos|cartons?)\.?$/i, ''));
      if (qty == null && n != null && n > 0) { qty = n; continue; }
      rest.push(c);
    }
    const name = rest.join(' ');
    if (!size && qty == null && /product|item|size|qty|quantity/i.test(name)) continue;   // a header row
    out.push({ product_name: name, size_text: size || '', qty });
  }
  return out;
}

// ── Exports ───────────────────────────────────────────────────────────────────────────────────────
// One costing, with every line of the working (internal).
export function costingExportSpec(c) {
  const r = c.result?.ok ? c.result : computeCosting(c.inputs || {}, c.formula || CURRENT_FORMULA);
  const inputs = INPUTS.filter(i => num(c.inputs?.[i.key]) != null).map(i => ({ item: i.label, value: plain(num(c.inputs[i.key]), 4), unit: i.unit }));
  return {
    name: `costing-${c.costing_no || 'draft'}`,
    title: `Costing ${c.costing_no || '(not saved)'}`,
    subtitle: [c.customer_name, c.product_name].filter(Boolean).join(' · '),
    meta: [c.size_text && `Size ${c.size_text}`, c.style && `Pasting ${c.style}`, c.costed_on && `Costed ${c.costed_on}`, `Formula ${c.formula || CURRENT_FORMULA}`].filter(Boolean),
    summary: r.ok ? [
      { label: 'Cost per carton', value: perUnit(r.cost_per_unit) },
      { label: 'Quote per carton', value: perUnit(r.quote_per_unit) },
      { label: 'Order value (cost)', value: rupees(r.cost_value) },
    ] : [{ label: 'Status', value: 'Incomplete' }],
    sections: [
      { heading: 'What was entered', columns: [{ key: 'item', label: 'Input' }, { key: 'value', label: 'Value', align: 'right' }, { key: 'unit', label: 'Unit' }], rows: inputs },
      { heading: 'How it was worked out', columns: [
        { key: 'label', label: 'Item' }, { key: 'how', label: 'Working' },
        { key: 'amount', label: 'Amount ₹', align: 'right', export: x => (x.amount == null ? '' : Math.round(x.amount * 100) / 100) },
        { key: 'per_unit', label: '₹ per carton', align: 'right', export: x => (x.per_unit == null ? '' : Math.round(x.per_unit * 10000) / 10000) },
      ], rows: r.lines || [] },
    ],
  };
}

// A bulk costing. `customer` = the sheet a customer may see: product, size, quantity and the quote
// price — no board, rates, margins or internal cost.
export function batchExportSpec(batch, rows, { customer = false } = {}) {
  const base = { title: `${customer ? 'Quotation' : 'Bulk costing'} ${batch.batch_no || ''}`.trim(), subtitle: [batch.customer_name, batch.title].filter(Boolean).join(' · ') };
  const priced = rows.map((row, i) => ({ ...row, n: i + 1, r: computeCosting(row.inputs || {}) }));
  if (customer) {
    return {
      ...base, name: `quotation-${batch.batch_no || 'draft'}`,
      columns: [
        { key: 'n', label: '#' }, { key: 'product_name', label: 'Product' }, { key: 'size_text', label: 'Size (mm)' },
        { key: 'qty', label: 'Quantity', align: 'right', export: x => num(x.inputs?.qty) ?? '' },
        { key: 'quote', label: 'Price per carton ₹', align: 'right', export: x => (x.r.ok ? Math.round(x.r.quote_per_unit * 1000) / 1000 : '') },
        { key: 'value', label: 'Value ₹', align: 'right', export: x => (x.r.ok ? Math.round(x.r.quote_value) : '') },
      ],
      rows: priced.filter(x => x.r.ok),
    };
  }
  const n3 = v => (v == null ? '' : Math.round(v * 1000) / 1000);
  return {
    ...base, name: `bulk-costing-${batch.batch_no || 'draft'}`, orientation: 'landscape',
    columns: [
      { key: 'n', label: '#' }, { key: 'product_name', label: 'Product' }, { key: 'size_text', label: 'Size (mm)' }, { key: 'style', label: 'Pasting' },
      { key: 'qty', label: 'Qty', align: 'right', export: x => num(x.inputs?.qty) ?? '' },
      { key: 'sheet', label: 'Sheet (in)', export: x => (num(x.inputs?.sheet_l) && num(x.inputs?.sheet_w) ? `${plain(num(x.inputs.sheet_l))} × ${plain(num(x.inputs.sheet_w))}` : '') },
      { key: 'ups', label: 'Ups', align: 'right', export: x => num(x.inputs?.ups) ?? '' },
      { key: 'gsm', label: 'GSM', align: 'right', export: x => num(x.inputs?.gsm) ?? '' },
      { key: 'board_rate', label: 'Board ₹/kg', align: 'right', export: x => num(x.inputs?.board_rate) ?? '' },
      { key: 'sheets', label: 'Sheets', align: 'right', export: x => (x.r.ok ? Math.ceil(x.r.sheets) : '') },
      { key: 'board', label: 'Board ₹', align: 'right', export: x => (x.r.ok ? Math.round(x.r.parts.board) : '') },
      { key: 'print', label: 'Printing ₹', align: 'right', export: x => (x.r.ok ? Math.round(x.r.parts.print) : '') },
      { key: 'coat', label: 'Coating ₹', align: 'right', export: x => (x.r.ok ? Math.round(x.r.parts.coat) : '') },
      { key: 'dp', label: 'Die & pasting ₹', align: 'right', export: x => (x.r.ok ? Math.round(x.r.parts.dp) : '') },
      { key: 'process', label: 'Process ₹', align: 'right', export: x => (x.r.ok ? Math.round(x.r.parts.process) : '') },
      { key: 'cost', label: 'Cost per carton ₹', align: 'right', export: x => (x.r.ok ? n3(x.r.cost_per_unit) : '') },
      { key: 'quote', label: 'Quote per carton ₹', align: 'right', export: x => (x.r.ok ? n3(x.r.quote_per_unit) : '') },
      { key: 'value', label: 'Order value ₹', align: 'right', export: x => (x.r.ok ? Math.round(x.r.cost_value) : '') },
      { key: 'status', label: 'Status', export: x => (x.r.ok ? 'Ready' : `Needs ${x.r.missing.map(m => m.label.toLowerCase()).join(', ')}`) },
    ],
    rows: priced,
  };
}

// A saved costing back into the form's shape. History-only inputs (a printing amount typed on the old
// sheet, a floor under a higher threshold) are dropped: a new costing is worked out by today's rules.
// A saved costing made its coating choice, so a blank factor reads back as "No coating".
export function valueFromSaved(c, { asNew = false } = {}) {
  const inputs = {};
  for (const { key } of INPUTS) inputs[key] = c?.inputs?.[key] ?? '';
  const f = num(inputs.coat_factor);
  return {
    customer_id: c?.customer_id ?? null,
    customer_name: c?.customer_name || '',
    product_id: c?.product_id ?? null,
    product_name: c?.product_name && !/^\(no product name/.test(c.product_name) ? c.product_name : '',
    size_text: c?.size_key || c?.size_text || '',
    style: c?.style || null,
    inputs,
    coat_choice: f > 0 ? String(f) : 'none',
    remarks: asNew ? '' : (c?.remarks || ''),
  };
}

// A blank costing for a new product, or one started from a Size Library entry.
export function blankValue(defaults = {}, entry = null) {
  const v = { customer_id: null, customer_name: '', product_id: null, product_name: '', size_text: '', style: null,
    inputs: startingInputs(defaults), coat_choice: '', remarks: '' };
  if (entry) {
    v.size_text = entry.size_key || '';
    v.style = entry.style || null;
    v.inputs = { ...v.inputs, sheet_l: entry.sheet_l ?? '', sheet_w: entry.sheet_w ?? '', ups: entry.ups ?? '' };
  }
  return v;
}

// What the server takes for a costing (it works out the figures itself).
export function savePayload(v, note) {
  return {
    customer_id: v.customer_id, customer_name: v.customer_name, product_id: v.product_id, product_name: v.product_name,
    size_text: v.size_text, style: v.style, inputs: v.inputs, remarks: v.remarks, note: note || undefined,
  };
}
