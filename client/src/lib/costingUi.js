// Costing screens — the pure parts: money on screen, which earlier costing is the fair comparison,
// reading rows pasted from Excel, and the export layouts. No React, no fetch, so the server suite
// tests it (server/src/costing-ui.test.js).
import { computeCosting, compareCostings, parseSize, num, styleLabel, quantityBreaks, CURRENT_FORMULA, INPUTS } from './costing.js';

// ₹ per carton to three decimals (3.142, 0.618 — the trade quotes to a tenth of a paisa); totals whole.
export const perUnit = n => (n == null || !Number.isFinite(+n) ? '—' : `₹${(+n).toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 })}`);
export const rupees = n => (n == null || !Number.isFinite(+n) ? '—' : `₹${Math.round(+n).toLocaleString('en-IN')}`);
export const pct = (n, dp = 1) => (n == null || !Number.isFinite(+n) ? '—' : `${n > 0 ? '+' : ''}${(+n).toFixed(dp)}%`);
export const plain = (n, dp = 2) => (n == null || !Number.isFinite(+n) ? '—' : (+n).toLocaleString('en-IN', { maximumFractionDigits: dp }));

// A coating factor in words a new joiner can check: factor 6 → "₹1 per 600 sq in".
// A coating factor in words a new joiner can check: factor 6 → "₹0.17 per 100 sq in".
export const coatingWords = factor => (num(factor) > 0 ? `₹${plain(1 / num(factor), 2)} per 100 sq in` : 'No coating');
export function coatingLabel(c) {
  const words = coatingWords(c.factor);
  return c.name ? `${c.name} — ${words}` : words;
}

// The inputs a new costing starts with: the Rates tab's defaults, nothing job-specific.
export function startingInputs(defaults = {}) {
  const out = {};
  for (const { key } of INPUTS) out[key] = defaults[key] ?? '';
  for (const k of ['qty', 'sheet_l', 'sheet_w', 'ups', 'gsm', 'board_rate', 'target_price']) out[k] = '';
  // Coating is a choice every costing makes — "No coating" included — so it never starts filled.
  out.coat_factor = '';
  out.coat_rate = '';
  out.coat_sheets = '';
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
  else if (value.coat_choice === 'rate' && !(num(value.inputs?.coat_rate) > 0)) list.push('Coating rate');
  return list;
}

// Earlier costings of the same size, best comparison first. "Comparable" = same pasting (or one side
// not recorded) and GSM within 10 — a different carton style or board is shown, never compared.
// Among comparable ones, a quantity within half to double of this one comes first (set-up spreads
// differently over 1,000 and 10,000 cartons), then the newest, then the nearest quantity.
export function rankHistory(current, history = []) {
  const style = current?.style || null;
  const gsm = num(current?.inputs?.gsm);
  const qty = num(current?.inputs?.qty);
  const rows = history.filter(h => h.result?.ok).map(h => {
    const sameStyle = !style || !h.style || h.style === style;
    const sameBoard = gsm == null || h.gsm == null || Math.abs(h.gsm - gsm) <= 10;
    const qtyGap = qty > 0 && h.qty > 0 ? Math.abs(Math.log(h.qty / qty)) : 0;
    return { ...h, comparable: sameStyle && sameBoard, why: !sameStyle ? 'different pasting' : !sameBoard ? 'different GSM' : null, qtyGap,
      similarQty: qtyGap <= Math.log(2) + 1e-9 };
  });
  rows.sort((a, b) => (b.comparable - a.comparable)
    || (b.similarQty - a.similarQty)
    || String(b.costed_on || '').localeCompare(String(a.costed_on || ''))
    || a.qtyGap - b.qtyGap);
  return rows;
}

// The closest earlier costing against the current one, or null. When the quantities differ, the
// current costing is also worked out at THAT costing's quantity (like_for_like): the gap left is what
// rates and specification changed, and the alert is judged on it — a smaller order costing more a
// carton is not, by itself, a pricing problem.
export function closestComparison(current, currentResult, history, alertPct = 15) {
  if (!currentResult?.ok) return null;
  const best = rankHistory(current, history).find(h => h.comparable);
  if (!best) return null;
  const opts = { threshold: alertPct };
  const cmp = compareCostings({ inputs: current.inputs, result: currentResult }, { inputs: best.inputs, result: best.result }, opts);
  if (!cmp) return null;
  let lfl = null;
  if (num(best.qty) > 0 && num(best.qty) !== num(current.inputs?.qty)) {
    const atTheirs = { ...current.inputs, qty: num(best.qty) };
    lfl = compareCostings({ inputs: atTheirs, result: computeCosting(atTheirs) }, { inputs: best.inputs, result: best.result }, opts);
  }
  return { ...cmp, against: best, like_for_like: lfl, significant: (lfl || cmp).significant };
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
// price — no board, rates, margins or internal cost. `quantities` adds a price column for each (the
// same engine, quantityBreaks). `draft` stamps the sheet when any priced row is not approved.
export function batchExportSpec(batch, rows, { customer = false, quantities = [], draft = false } = {}) {
  const base = { title: `${customer ? 'Quotation' : 'Bulk costing'} ${batch.batch_no || ''}`.trim(), subtitle: [batch.customer_name, batch.title].filter(Boolean).join(' · ') };
  const qs = [...new Set(quantities.map(num).filter(q => q > 0))].sort((a, b) => a - b);
  const priced = rows.map((row, i) => ({ ...row, n: i + 1, r: computeCosting(row.inputs || {}), breaks: qs.length ? quantityBreaks(row.inputs || {}, qs) : [] }));
  const at = (x, q) => x.breaks.find(b => b.qty === q);
  const n3 = v => (v == null ? '' : Math.round(v * 1000) / 1000);
  if (customer) {
    return {
      ...base, name: `quotation-${batch.batch_no || 'draft'}`,
      ...(draft ? { watermark: { text: 'DRAFT — NOT APPROVED', line: 'These prices have not been approved yet.' } } : {}),
      columns: [
        { key: 'n', label: '#' }, { key: 'product_name', label: 'Product' }, { key: 'size_text', label: 'Size (mm)' },
        ...(qs.length
          ? qs.map(q => ({ key: `q${q}`, label: `₹ a carton @ ${plain(q, 0)}`, align: 'right', export: x => (at(x, q)?.ok ? n3(at(x, q).quote_per_unit) : '') }))
          : [
            { key: 'qty', label: 'Quantity', align: 'right', export: x => num(x.inputs?.qty) ?? '' },
            { key: 'quote', label: 'Price per carton ₹', align: 'right', export: x => (x.r.ok ? n3(x.r.quote_per_unit) : '') },
            { key: 'value', label: 'Value ₹', align: 'right', export: x => (x.r.ok ? Math.round(x.r.quote_value) : '') },
          ]),
      ],
      rows: priced.filter(x => x.r.ok),
    };
  }
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
      { key: 'setup', label: 'Set-up ₹', align: 'right', export: x => (x.r.ok ? Math.round(x.r.split.fixed) : '') },
      { key: 'running', label: 'Running ₹ a carton', align: 'right', export: x => (x.r.ok ? n3(x.r.split.running_per_unit) : '') },
      { key: 'cost', label: 'Cost per carton ₹', align: 'right', export: x => (x.r.ok ? n3(x.r.cost_per_unit) : '') },
      { key: 'quote', label: 'Quote per carton ₹', align: 'right', export: x => (x.r.ok ? n3(x.r.quote_per_unit) : '') },
      { key: 'value', label: 'Order value ₹', align: 'right', export: x => (x.r.ok ? Math.round(x.r.cost_value) : '') },
      ...qs.map(q => ({ key: `q${q}`, label: `Cost a carton @ ${plain(q, 0)}`, align: 'right', export: x => (at(x, q)?.ok ? n3(at(x, q).cost_per_unit) : '') })),
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
  const rate = num(inputs.coat_rate);
  return {
    customer_id: c?.customer_id ?? null,
    customer_name: c?.customer_name || '',
    product_id: c?.product_id ?? null,
    product_name: c?.product_name && !/^\(no product name/.test(c.product_name) ? c.product_name : '',
    size_text: c?.size_key || c?.size_text || '',
    style: c?.style || null,
    inputs,
    coat_choice: rate > 0 ? 'rate' : f > 0 ? String(f) : 'none',
    remarks: asNew ? '' : (c?.remarks || ''),
    sources: {},
  };
}

// A blank costing for a new product, or one started from a Size Library entry.
export function blankValue(defaults = {}, entry = null) {
  const v = { customer_id: null, customer_name: '', product_id: null, product_name: '', size_text: '', style: null,
    inputs: startingInputs(defaults), coat_choice: '', remarks: '', sources: {} };
  // The Rates defaults it starts from are marked as defaults, so they can be told from typed values.
  for (const k of Object.keys(defaults)) if (!blank(v.inputs[k]) && k in v.inputs) v.sources[k] = { kind: 'default' };
  if (entry) {
    v.size_text = entry.size_key || '';
    v.style = entry.style || null;
    v.inputs = { ...v.inputs, sheet_l: entry.sheet_l ?? '', sheet_w: entry.sheet_w ?? '', ups: entry.ups ?? '' };
    for (const k of ['sheet_l', 'sheet_w', 'ups', 'style']) v.sources[k] = { kind: 'library', note: 'chosen in the Size Library' };
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

// ── Recommendations ──────────────────────────────────────────────────────────────────────────────
// Where a value in the form came from. Shown beside every box, so a new joiner can see what the system
// suggested and what somebody typed.
export const SOURCES = Object.freeze({
  product: { label: 'Product Master', short: 'Product', tone: 'auto' },
  library: { label: 'Size Library', short: 'Size Library', tone: 'auto' },
  rates: { label: 'Board Rates', short: 'Board Rates', tone: 'auto' },
  history: { label: 'A past costing', short: 'Past costing', tone: 'auto' },
  typical: { label: 'Typical in your costings', short: 'Typical', tone: 'typical' },
  default: { label: 'Rates & method default', short: 'Default', tone: 'default' },
  manual: { label: 'Typed here', short: 'Edited', tone: 'manual' },
});

// The Product Master's pasting words in the cost sheet's codes. BSO (both sides open) cartons are
// side-pasted; anything else is left for a person to choose.
export function pastingFromProduct(p) {
  const s = String(p ?? '').trim();
  if (/lock/i.test(s)) return 'LOCK';
  if (/^bso$/i.test(s)) return 'SIDE';
  return null;
}

// A Product Master board grade to a Board Rates grade. Case and the usual misspellings aside; a grade
// that could be two rates ("Duplex": WB or GB) is not guessed.
const GRADE_ALIASES = { sapphire: 'saffire', met: 'met saffire', chromo: 'chromo paper' };
export function gradeFor(productGrade, grades = []) {
  const k = String(productGrade ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!k) return null;
  const want = GRADE_ALIASES[k] || k;
  return grades.find(g => g.grade.trim().toLowerCase() === want) || null;
}

const blank = x => x == null || String(x).trim() === '';
const sameName = (a, b) => String(a ?? '').trim().toLowerCase().replace(/\s+/g, ' ') === String(b ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const TOP_FIELDS = new Set(['customer_name', 'customer_id', 'size_text', 'style', 'board_grade', 'coat_choice']);
const AUTO = new Set(['product', 'library', 'rates', 'history', 'typical', 'default']);
const when = h => `${h.costing_no}${h.costed_on ? `, ${h.costed_on}` : ''}`;

// Fill a costing from what the ERP knows. `ctx`: the Product Master entry picked (product), the size
// check (library layouts + earlier costings of the size), the typical figures, the Rates defaults and
// today's board grades. Each field takes the first source that has a value:
//   size, pasting, sheet & ups, GSM, colours, board, embossing on/off ← Product Master
//   sheet & ups, pasting                                             ← Size Library (most used)
//   coating, die & pasting, embossing (and GSM / board rate if no product) ← the same product's last
//                                                                       costing, else the newest
//                                                                       comparable one of the size
//   die & pasting by pasting style, embossing, process per colour     ← typical in your costings
//   everything else                                                   ← Rates & method defaults
// A field somebody typed (source manual) is never touched; one filled from an earlier suggestion is
// refilled from the new context; a saved value with no recorded source is kept unless it is blank.
export function recommend(value, ctx = {}) {
  const { product: p = null, check = null, typical = {}, defaults = {}, grades = [] } = ctx;
  const v = { ...value, inputs: { ...(value.inputs || {}) }, sources: { ...(value.sources || {}) } };
  const get = f => (TOP_FIELDS.has(f) ? v[f] : v.inputs[f]);
  const write = (f, x) => { if (TOP_FIELDS.has(f)) v[f] = x; else v.inputs[f] = x; };
  // Suggestions from the last context are cleared first, so nothing stale survives a new product or size.
  for (const [f, s] of Object.entries(v.sources)) {
    if (s && AUTO.has(s.kind)) { write(f, f === 'customer_id' ? null : ''); delete v.sources[f]; }
  }
  const taken = new Set();
  const put = (f, x, kind, note) => {
    if (blank(x) || taken.has(f)) return false;
    const s = v.sources[f];
    if (s?.kind === 'manual' || (!s && !blank(get(f)))) { taken.add(f); return false; }
    write(f, x);
    v.sources[f] = note ? { kind, note } : { kind };
    taken.add(f);
    return true;
  };

  const lib = check?.library?.exact || [];
  const top = lib[0] || null;
  if (p) {
    const pk = p.code ? `${p.code}` : p.name;
    if (put('customer_name', p.customer_name, 'product', pk)) put('customer_id', p.customer_id, 'product', pk);
    put('size_text', parseSize(p.size)?.key, 'product', pk);
    put('style', pastingFromProduct(p.pasting_type), 'product', p.pasting_type);
    // ups 1 on the master is usually "never filled in"; a library layout of the size knows better.
    if (num(p.sheet_l) > 0 && num(p.sheet_w) > 0 && (num(p.ups) > 1 || !top)) {
      put('sheet_l', num(p.sheet_l), 'product', pk);
      put('sheet_w', num(p.sheet_w), 'product', pk);
      put('ups', num(p.ups), 'product', pk);
    }
    put('gsm', num(p.gsm), 'product', pk);
    put('colours', num(p.colours), 'product', pk);
    const g = gradeFor(p.board_grade, grades);
    if (g) {
      put('board_grade', g.grade, 'product', p.board_grade);
      put('board_rate', g.rate_per_kg, 'rates', `${g.grade}, today's rate`);
    }
    if (+p.emboss !== 1) put('emb_rate', 0, 'product', 'no embossing on the Product Master');
  }
  if (top) {
    const note = `${top.times_costed ? `used ${top.times_costed}×` : 'in the library'}${lib.length > 1 ? ` · ${lib.length - 1} other layout${lib.length > 2 ? 's' : ''}` : ''}`;
    put('sheet_l', top.sheet_l, 'library', note);
    put('sheet_w', top.sheet_w, 'library', note);
    put('ups', top.ups, 'library', note);
    put('style', top.style, 'library', note);
  }

  // History: the same product's last costing says it all; otherwise what is MOST USED across the
  // recent comparable costings of the size (one odd costing does not set the rate), and for the board
  // rate the newest (prices move).
  const hist = check?.history || [];
  const same = p && hist.find(h => sameName(h.product_name, p.name) && h.result?.ok);
  const comparable = same ? [same] : rankHistory({ style: v.style, inputs: v.inputs }, hist).filter(h => h.comparable).slice(0, 20);
  if (comparable.length) {
    const pick = get1 => {
      const counts = new Map();
      for (const h of comparable) { const x = get1(h.inputs || {}); if (x != null) counts.set(x, (counts.get(x) || 0) + 1); }
      if (!counts.size) return null;
      const [x, n] = [...counts].sort((a, b) => b[1] - a[1])[0];   // ties: the newer (rankHistory order, Map keeps first seen)
      return { x, note: same ? when(same) : `${n} of ${comparable.length} recent costings of this size` };
    };
    const coat = pick(i => (num(i.coat_rate) > 0 ? `r${num(i.coat_rate)}` : num(i.coat_factor) > 0 ? `f${num(i.coat_factor)}` : 'none'));
    if (coat) {
      if (coat.x.startsWith('r')) { put('coat_rate', +coat.x.slice(1), 'history', coat.note); put('coat_choice', 'rate', 'history', coat.note); }
      else if (coat.x.startsWith('f')) { put('coat_factor', +coat.x.slice(1), 'history', coat.note); put('coat_choice', coat.x.slice(1), 'history', coat.note); }
      else put('coat_choice', 'none', 'history', coat.note);
    }
    const dp = pick(i => num(i.dp_rate));
    if (dp) put('dp_rate', dp.x, 'history', dp.note);
    if (!p || +p.emboss === 1) {
      const emb = pick(i => (num(i.emb_rate) > 0 ? num(i.emb_rate) : null));
      if (emb) put('emb_rate', emb.x, 'history', emb.note);
    }
    const gsm = pick(i => num(i.gsm));
    if (gsm) put('gsm', gsm.x, 'history', gsm.note);
    const newest = comparable.find(h => num(h.inputs?.board_rate) > 0);
    if (newest) put('board_rate', num(newest.inputs.board_rate), 'history', `${when(newest)} — check today's rate`);
  }

  const style = v.style;
  const dpTypical = style && typical?.dp_by_style?.[style];
  if (dpTypical) put('dp_rate', dpTypical.value, 'typical', `${styleLabel(style)}, ${dpTypical.n} costings`);
  if (p && +p.emboss === 1 && typical?.emb) put('emb_rate', typical.emb.value, 'typical', `embossed cartons, ${typical.emb.n} costings`);
  const colours = num(get('colours')) ?? num(defaults.colours);
  if (colours > 0 && typical?.process_per_colour) {
    const ppc = typical.process_per_colour.value;
    put('process', Math.round(ppc * colours / 50) * 50, 'typical', `₹${plain(ppc, 0)} a colour × ${plain(colours)}`);
  }
  for (const k of ['wastage', 'colours', 'print_rate', 'print_min', 'process', 'dp_rate', 'emb_rate', 'pf_pct', 'misc_pct', 'margin']) {
    put(k, defaults[k], 'default');
  }
  return v;
}

// A typed value takes the box over from the suggestions.
export function markEdited(value, fields) {
  const sources = { ...(value.sources || {}) };
  for (const f of fields) sources[f] = { kind: 'manual' };
  return { ...value, sources };
}

// Each sheet layout the library holds for the size, priced with everything else as entered:
// most used first; the cheapest is flagged.
export function layoutOptions(value, entries = []) {
  const rows = entries.map((e, i) => {
    const r = computeCosting({ ...value.inputs, sheet_l: e.sheet_l, sheet_w: e.sheet_w, ups: e.ups });
    return { ...e, rank: i, cost_per_unit: r.ok ? r.cost_per_unit : null };
  });
  const priced = rows.filter(r => r.cost_per_unit != null);
  const cheapest = priced.length > 1 ? priced.reduce((a, b) => (b.cost_per_unit < a.cost_per_unit ? b : a)) : null;
  return rows.map(r => ({ ...r, cheapest: cheapest && r.id === cheapest.id }));
}

// The coating choices offered as buttons: the Rates tab's list, each as its plain rate.
export const coatingRate = factor => (num(factor) > 0 ? 1 / num(factor) : null);
