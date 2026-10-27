// Reading the plant's cost sheet workbook ("Cost Sheet Anik Final … .xlsx") into the Costing module:
// the "Size chart" tab becomes the Size Library, each "Multi costing sheet" row a costing on record.
//
// Pure: the caller hands in each row as a getter, col → { v, f } (cached value, formula text or
// undefined), so this file never touches exceljs or a database and is tested on invented rows.
//
// Nothing is tidied into a better answer. A row keeps the figures the sheet worked out — that is what
// was quoted — and every place the sheet broke its own rule is written down on the row, so the old
// record stays honest and the break is visible. Kinds of break found in the real workbook:
//   dp_not_charged     die & pasting rate typed, but the cell that charges it was empty
//   part_differs       one cost cell does not follow the row's own inputs (a formula pointing at
//                      another row or column, or a typed amount)
//   emb_is_dp          the per-carton cell added die & pasting where embossing belongs
//   lookup_failed      the Size chart had no such size, so sheet size / ups are blank
//   party_is_number    the Party column holds a number, not a customer name

import { computeCosting, num, parseSize, normStyle } from './costing-engine.js';

const plain = f => String(f ?? '').replace(/\$/g, '').replace(/\s+/g, '');

// Size chart: B size, C sheet L (in), D sheet W (in), E ups, F pasting.
export function readSizeChartRow(get, row) {
  const raw = get('B')?.v;
  if (raw == null || String(raw).trim() === '') return null;
  return {
    row,
    raw: String(raw).trim(),
    size: parseSize(raw),
    style: normStyle(get('F')?.v),
    sheet_l: num(get('C')?.v),
    sheet_w: num(get('D')?.v),
    ups: num(get('E')?.v),
  };
}

// "DD-MM-YYYY" / "DD-MM-YY" text or a Date → 'YYYY-MM-DD' (local parts — never toISOString, which
// moves an IST midnight to the day before).
export function sheetDate(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const p = n => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  const m = String(v ?? '').trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/);
  if (!m) return null;
  const d = +m[1], mo = +m[2], y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Multi costing sheet columns.
const C = {
  party: 'B', date: 'C', product: 'D', panel: 'E', style: 'F', qty: 'G', counter: 'J',
  sheet_l: 'M', sheet_w: 'N', ups: 'O', gsm: 'P', board_rate: 'Q', wastage: 'R', print_rate: 'S',
  colours: 'T', process: 'U', coat_factor: 'V', emb_rate: 'W', dp_rate: 'X', pf: 'Y', misc: 'Z',
  board: 'AB', print: 'AD', coat: 'AE', dp: 'AF', proc: 'AG', cost: 'AL', quote: 'AM', value: 'AN',
};

const near = (a, b) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

export function readCostingRow(get, row) {
  const g = k => get(C[k]) || {};
  const product = g('product').v, panel = g('panel').v, qty = num(g('qty').v);
  if ((product == null || String(product).trim() === '') && panel == null && qty == null) return null;

  const notes = [];
  const partyRaw = g('party').v;
  let party = partyRaw == null ? null : String(partyRaw).trim() || null;
  if (typeof partyRaw === 'number') {
    notes.push({ kind: 'party_is_number', text: `Party column holds the number ${partyRaw}, not a customer name.` });
    party = null;
  }

  const style = normStyle(g('style').v);
  const pct = v => { const n = num(v); return n == null ? null : n * 100; };
  const inputs = {
    qty,
    sheet_l: num(g('sheet_l').v), sheet_w: num(g('sheet_w').v), ups: num(g('ups').v),
    gsm: num(g('gsm').v), board_rate: num(g('board_rate').v), wastage: num(g('wastage').v),
    print_rate: num(g('print_rate').v), colours: num(g('colours').v), process: num(g('process').v),
    coat_factor: num(g('coat_factor').v), emb_rate: num(g('emb_rate').v), dp_rate: num(g('dp_rate').v),
    pf_pct: pct(g('pf').v), misc_pct: pct(g('misc').v),
  };
  if (/VLOOKUP/i.test(String(g('sheet_l').f ?? '')) && inputs.sheet_l == null) {
    notes.push({ kind: 'lookup_failed', text: 'The Size chart had no such size, so the sheet size and ups are blank.' });
  }

  // Which version of the sheet's rules this row ran under, read off its own formulas.
  const alF = plain(g('cost').f), adF = plain(g('print').f);
  const emb = /\+W\d/.test(alF);
  if (/\+X\d/.test(alF)) notes.push({ kind: 'emb_is_dp', text: 'The per-carton cell added the die & pasting rate where embossing belongs.' });
  const minM = adF.match(/>(\d+(?:\.\d+)?),[^,]+,"?(\d+(?:\.\d+)?)"?\)/);
  if (minM) { inputs.print_min = +minM[1]; if (+minM[2] !== +minM[1]) inputs.print_min_floor = +minM[2]; }
  const adTyped = !g('print').f && num(g('print').v) != null;
  if (adTyped) inputs.print_fixed = num(g('print').v);
  const formula = minM ? 'CI-1' : emb ? 'SHEET-B' : 'SHEET-A';

  // The die & pasting cell left empty although a rate is typed: the sheet charged nothing.
  if (inputs.dp_rate > 0 && !g('dp').f && num(g('dp').v) == null) {
    notes.push({ kind: 'dp_not_charged', text: `Die & pasting ₹${inputs.dp_rate} a carton was typed but not charged on the sheet.` });
    inputs.dp_rate_typed = inputs.dp_rate;
    inputs.dp_rate = 0;
  }

  const quoteF = plain(g('quote').f);
  const mM = quoteF.match(/^IFERROR\(AL\d+\+(\d+(?:\.\d+)?),""\)$|^AL\d+\+(\d+(?:\.\d+)?)$/i);
  if (mM) inputs.margin = +(mM[1] ?? mM[2]);
  const counter = num(g('counter').v);
  if (counter > 0) inputs.target_price = counter;

  const sheetResult = {
    cost_per_unit: num(g('cost').v),
    quote_per_unit: num(g('quote').v),
    cost_value: num(g('value').v),
    parts: { board: num(g('board').v), print: num(g('print').v), coat: num(g('coat').v), dp: num(g('dp').v), process: num(g('proc').v) },
  };

  const result = computeCosting(inputs, formula);
  let reproduced = false;
  if (result.ok && sheetResult.cost_per_unit != null) {
    reproduced = near(result.cost_per_unit, sheetResult.cost_per_unit);
    if (!reproduced) {
      for (const [k, label] of [['board', 'Board'], ['print', 'Printing'], ['coat', 'Coating'], ['dp', 'Die & pasting'], ['process', 'Process']]) {
        const s = sheetResult.parts[k] ?? 0, e = result.parts[k] ?? 0;
        if (!near(s, e)) notes.push({ kind: 'part_differs', text: `${label} on the sheet is ₹${s.toFixed(2)}; the row's own inputs give ₹${e.toFixed(2)}.` });
      }
    }
  }

  return {
    row,
    party,
    date: sheetDate(g('date').v),
    product: product == null ? null : String(product).trim(),
    size_text: panel == null ? null : String(panel).trim(),
    size: parseSize(panel),
    style,
    formula,
    inputs,
    result,
    sheet_result: sheetResult,
    reproduced,
    notes,
  };
}

// Size Library from the Size chart plus every costed size the chart lacks. One entry per carton
// reference = size + pasting + layout (sheet L × W, ups). Rows that agree on all four are ONE entry
// (every source row kept, for tracing); the same size with another pasting or another layout stays a
// separate entry, because it costs differently.
export function sizeEntryKey(sizeKey, style, sheetL, sheetW, ups) {
  const n = x => (x == null ? '' : String(+(+x).toFixed(3)));
  return [sizeKey, style || '', n(sheetL), n(sheetW), n(ups)].join('|');
}

export function buildSizeLibrary(chartRows, costingRows) {
  const byKey = new Map();
  const add = (sizeKeyed, style, sheetL, sheetW, ups, source, ref) => {
    if (!sizeKeyed) return;
    const k = sizeEntryKey(sizeKeyed.key, style, sheetL, sheetW, ups);
    let e = byKey.get(k);
    if (!e) {
      e = { key: k, size: sizeKeyed, style, sheet_l: sheetL, sheet_w: sheetW, ups, source, refs: [] };
      byKey.set(k, e);
    }
    e.refs.push(ref);
    return e;
  };
  for (const r of chartRows) add(r.size, r.style, r.sheet_l, r.sheet_w, r.ups, 'size_chart', { sheet: 'Size chart', row: r.row, raw: r.raw });
  for (const c of costingRows) {
    if (!c.size) continue;
    const k = sizeEntryKey(c.size.key, c.style, c.inputs.sheet_l, c.inputs.sheet_w, c.inputs.ups);
    if (byKey.has(k)) continue;
    add(c.size, c.style, c.inputs.sheet_l, c.inputs.sheet_w, c.inputs.ups, 'costing', { sheet: 'Multi costing sheet', row: c.row, raw: c.size_text });
  }
  return [...byKey.values()];
}

// Entries a person should look at, never merged automatically:
//   same size, more than one layout · same size, different pasting · L/W/H typed in another order
export function possibleDuplicates(entries) {
  const bySize = new Map();
  for (const e of entries) {
    if (e.size?.kind === 'other') continue;
    const list = bySize.get(e.size.key) || [];
    list.push(e);
    bySize.set(e.size.key, list);
  }
  const out = [];
  for (const [key, list] of bySize) {
    if (list.length < 2) continue;
    const styles = new Set(list.map(e => e.style || ''));
    out.push({ kind: styles.size > 1 ? 'style' : 'layout', size_key: key, entries: list });
  }
  const byDims = new Map();
  for (const key of bySize.keys()) {
    const sorted = key.split('x').map(Number).sort((a, b) => a - b).join('x');
    const list = byDims.get(sorted) || [];
    list.push(key);
    byDims.set(sorted, list);
  }
  for (const keys of byDims.values()) {
    if (keys.length > 1) out.push({ kind: 'order', size_keys: keys, entries: keys.flatMap(k => bySize.get(k)) });
  }
  return out;
}
