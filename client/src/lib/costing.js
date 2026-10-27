// Carton costing — the arithmetic of the plant's own cost sheet ("Cost Sheet Anik Final", tab
// "Multi costing sheet"), one product at a time. Every costing the Costing module shows, saves or
// compares is worked out here.
//
// The sheet, decoded (row = one product):
//   sheets   = quantity ÷ ups + wastage sheets
//   board    = L × W × GSM ÷ 3100 ÷ 5 × board ₹/kg ÷ 100 × sheets      (L, W = print sheet in inches)
//   printing = print ₹ (per 1,000 sheets, per colour) × colours × sheets ÷ 1000,
//              but never less than the minimum printing charge (₹1,600 on the sheet)
//   coating  = L × W ÷ coating factor ÷ 100 × sheets                    (factor 2, 3, 6 …; blank = none)
//   die & pasting = ₹ per carton × quantity
//   process  = a fixed ₹ for the job
//   subtotal = board + printing + coating + die & pasting + process
//   P&F      = P&F % × subtotal
//   misc     = misc % × (subtotal + P&F)
//   cost per carton  = (subtotal + P&F + misc) ÷ quantity + embossing ₹ per carton
//   quote per carton = cost per carton + ₹0.05
//
// `L × W × GSM ÷ 3100 ÷ 5 ÷ 100` is the sheet's weight of one sheet in kg (÷ 15,50,000 — the exact
// inch-to-metre figure is 15,50,003, so the sheet is 0.0002% light). Kept as the sheet has it, so a
// costing here and on the sheet agree to the paisa.
//
// FORMULAS keeps every version the sheet has used. A saved costing records its version with its
// inputs, so it reworks to the same figures forever; a rule that changes becomes a NEW version here,
// and the old ones are never edited.
//
// Client twin of server/src/costing-engine.js — the form works out the figures as you type, before
// anything is saved; the server works them out again on save. costing-engine.test.js asserts the two
// twins agree — change one, change both.
//
// Pure: no database, no clock. Amounts are plain JS numbers at full precision; rounding is for the
// screen only.

export const CURRENT_FORMULA = 'CI-1';

export const FORMULAS = Object.freeze({
  'SHEET-A': Object.freeze({
    label: 'Old cost sheet, 2022 — no embossing, no minimum printing charge',
    emb: false, printMin: false,
  }),
  'SHEET-B': Object.freeze({
    label: 'Old cost sheet, 2023 — embossing added per carton',
    emb: true, printMin: false,
  }),
  'CI-1': Object.freeze({
    label: 'Cost sheet (2024 on) — embossing per carton, minimum printing charge',
    emb: true, printMin: true,
  }),
});

// Every input, in form order, with the words a new joiner sees. `need` = the costing cannot be
// worked out without it.
export const INPUTS = Object.freeze([
  { key: 'qty',            label: 'Quantity',                 unit: 'cartons',                          need: true },
  { key: 'sheet_l',        label: 'Sheet length',             unit: 'inch',                             need: true },
  { key: 'sheet_w',        label: 'Sheet width',              unit: 'inch',                             need: true },
  { key: 'ups',            label: 'Ups',                      unit: 'cartons per sheet',                need: true },
  { key: 'gsm',            label: 'Board GSM',                unit: 'gsm',                              need: true },
  { key: 'board_rate',     label: 'Board rate',               unit: '₹ per kg',                         need: true },
  { key: 'wastage',        label: 'Wastage sheets',           unit: 'sheets' },
  { key: 'colours',        label: 'Colours',                  unit: 'colours' },
  { key: 'print_rate',     label: 'Printing rate',            unit: '₹ per 1,000 sheets, per colour' },
  { key: 'print_min',      label: 'Minimum printing charge',  unit: '₹' },
  { key: 'coat_factor',    label: 'Coating factor',           unit: 'blank = no coating' },
  { key: 'dp_rate',        label: 'Die & pasting',            unit: '₹ per carton' },
  { key: 'emb_rate',       label: 'Embossing',                unit: '₹ per carton' },
  { key: 'process',        label: 'Process charge',           unit: '₹ for the job' },
  { key: 'pf_pct',         label: 'P&F',                      unit: '%' },
  { key: 'misc_pct',       label: 'Misc',                     unit: '%' },
  { key: 'margin',         label: 'Quote margin',             unit: '₹ per carton' },
  { key: 'target_price',   label: "Customer's target price",  unit: '₹ per carton' },
]);

const LABEL = Object.fromEntries(INPUTS.map(i => [i.key, i.label]));

// Number or null. '' / null / undefined / junk → null, so "not entered" never reads as a real 0.
export function num(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/,/g, '').trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const z = v => num(v) ?? 0;

// Indian grouping for the "how it was worked out" lines. dp = decimals.
export function fmt(n, dp = 0) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
// Up to `dp` decimals, trailing zeros dropped (4, 4.5, 0.35 — never 4.000).
export function fmtFlex(n, dp = 3) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-IN', { maximumFractionDigits: dp });
}
const rs = (n, dp = 0) => `₹${fmt(n, dp)}`;

// Work out one costing. `input` holds the INPUTS keys (numbers or numeric strings; percentages as
// percent, 5 = 5%). History rows imported from the sheet may also carry:
//   print_min_floor — the charge used when printing comes in at or under print_min (one block of the
//                     sheet charged ₹3,000 under a ₹5,000 threshold); defaults to print_min
//   print_fixed     — a printing ₹ typed straight into the sheet, used as-is
export function computeCosting(input = {}, formula = CURRENT_FORMULA) {
  const f = FORMULAS[formula];
  if (!f) throw new Error(`Unknown costing formula "${formula}"`);

  const v = {};
  for (const { key } of INPUTS) v[key] = num(input[key]);
  const missing = INPUTS.filter(i => i.need && !(v[i.key] > 0)).map(i => ({ key: i.key, label: i.label }));
  if (missing.length) return { formula, ok: false, missing, warnings: [], lines: [] };

  const qty = v.qty, ups = v.ups, L = v.sheet_l, W = v.sheet_w;
  const wastage = z(v.wastage), colours = z(v.colours), printRate = z(v.print_rate);
  const coatFactor = z(v.coat_factor), dpRate = z(v.dp_rate), embRate = z(v.emb_rate);
  const processCharge = z(v.process), pfPct = z(v.pf_pct), miscPct = z(v.misc_pct), margin = z(v.margin);

  const sheets = qty / ups + wastage;
  const sheetKg = L * W * v.gsm / 3100 / 5 / 100;
  const board = sheetKg * v.board_rate * sheets;

  const printCalc = printRate * colours * sheets / 1000;
  const printMin = f.printMin ? z(v.print_min) : 0;
  const printFloor = num(input.print_min_floor) ?? printMin;
  const printFixed = num(input.print_fixed);
  let print = printCalc, printAtMin = false;
  if (printFixed != null) print = printFixed;
  else if (printMin > 0 && !(printCalc > printMin)) { print = printFloor; printAtMin = true; }

  const coatPerSheet = coatFactor > 0 ? L * W / coatFactor / 100 : 0;
  const coat = coatPerSheet * sheets;
  const dp = dpRate * qty;
  const subtotal = board + print + coat + dp + processCharge;
  const pf = pfPct / 100 * subtotal;
  const misc = miscPct / 100 * (subtotal + pf);
  const net = subtotal + pf + misc;
  const emb = f.emb ? embRate : 0;
  const costPerUnit = net / qty + emb;
  const quotePerUnit = costPerUnit + margin;

  const per = x => x / qty;
  const lines = [
    { key: 'sheets', label: 'Sheets needed', amount: null, per_unit: null,
      how: `${fmt(qty)} cartons ÷ ${fmtFlex(ups)} ups + ${fmt(wastage)} wastage = ${fmtFlex(sheets, 1)} sheets` },
    { key: 'board', label: 'Board', amount: board, per_unit: per(board),
      how: `${fmtFlex(sheets, 1)} sheets × ${fmtFlex(sheetKg, 4)} kg a sheet (${fmtFlex(L, 2)} × ${fmtFlex(W, 2)} in, ${fmt(v.gsm)} gsm) × ₹${fmtFlex(v.board_rate, 2)} a kg` },
    { key: 'print', label: 'Printing', amount: print, per_unit: per(print),
      how: printFixed != null
        ? `₹${fmt(printFixed)} as typed on the sheet`
        : printAtMin
          ? `${fmtFlex(sheets, 1)} sheets × ${fmtFlex(colours)} colours × ₹${fmtFlex(printRate, 2)} ÷ 1,000 = ${rs(printCalc)} — under the minimum, so ${rs(printFloor)}`
          : `${fmtFlex(sheets, 1)} sheets × ${fmtFlex(colours)} colours × ₹${fmtFlex(printRate, 2)} ÷ 1,000` },
    { key: 'coat', label: 'Coating', amount: coat, per_unit: per(coat),
      how: coatFactor > 0
        ? `${fmtFlex(sheets, 1)} sheets × ₹${fmtFlex(coatPerSheet, 4)} a sheet (${fmtFlex(L, 2)} × ${fmtFlex(W, 2)} sq in ÷ ${fmtFlex(coatFactor, 2)} ÷ 100)`
        : 'No coating' },
    { key: 'dp', label: 'Die & pasting', amount: dp, per_unit: per(dp),
      how: `${fmt(qty)} cartons × ₹${fmtFlex(dpRate, 3)}` },
    { key: 'process', label: 'Process charge', amount: processCharge, per_unit: per(processCharge),
      how: `₹${fmt(processCharge)} for the job, spread over ${fmt(qty)} cartons` },
    { key: 'subtotal', label: 'Subtotal', amount: subtotal, per_unit: per(subtotal), total: true,
      how: 'Board + printing + coating + die & pasting + process' },
    { key: 'pf', label: 'P&F', amount: pf, per_unit: per(pf),
      how: `${fmtFlex(pfPct, 2)}% of the subtotal` },
    { key: 'misc', label: 'Misc', amount: misc, per_unit: per(misc),
      how: `${fmtFlex(miscPct, 2)}% of (subtotal + P&F)` },
  ];
  if (f.emb) lines.push({ key: 'emb', label: 'Embossing', amount: emb * qty, per_unit: emb,
    how: `₹${fmtFlex(embRate, 3)} a carton, added after P&F and misc` });
  lines.push(
    { key: 'cost', label: 'Cost per carton', amount: costPerUnit * qty, per_unit: costPerUnit, total: true,
      how: f.emb ? '(subtotal + P&F + misc) ÷ quantity + embossing' : '(subtotal + P&F + misc) ÷ quantity' },
    { key: 'quote', label: 'Quote price', amount: quotePerUnit * qty, per_unit: quotePerUnit, total: true,
      how: `Cost per carton + ₹${fmtFlex(margin, 3)} margin` },
  );

  const target = v.target_price > 0
    ? { price: v.target_price, margin_per_unit: v.target_price - costPerUnit,
        margin_pct: (v.target_price - costPerUnit) / v.target_price * 100 }
    : null;

  const warnings = [];
  if (v.wastage == null) warnings.push({ key: 'wastage', text: 'No wastage sheets entered. Most costings add 250–300.' });
  if (colours > 0 && !(printRate > 0)) warnings.push({ key: 'print_rate', text: 'Colours are entered but the printing rate is blank, so printing costs nothing.' });
  if (printRate > 0 && !(colours > 0)) warnings.push({ key: 'colours', text: 'A printing rate is entered but colours are blank, so printing costs nothing.' });
  if (printAtMin) warnings.push({ key: 'print_min', text: `Small run: printing is charged at the minimum, ${rs(printFloor)}.` });
  if (wastage > 0 && wastage > qty / ups) warnings.push({ key: 'wastage', text: 'Wastage is more than the sheets the cartons need. Check the quantity, ups and wastage.' });
  if (target && target.margin_per_unit < 0) warnings.push({ key: 'target_price', text: `The customer's target price is ₹${fmtFlex(-target.margin_per_unit, 3)} a carton BELOW our cost.` });

  return {
    formula, ok: true, missing: [], warnings, lines,
    qty, sheets, sheet_kg: sheetKg,
    parts: { board, print, print_calc: printCalc, print_at_min: printAtMin, coat, dp, process: processCharge,
             subtotal, pf, misc, net, emb_total: emb * qty },
    cost_per_unit: costPerUnit, quote_per_unit: quotePerUnit,
    cost_value: costPerUnit * qty, quote_value: quotePerUnit * qty,
    target,
  };
}

// ---------------------------------------------------------------------------------------------------
// Sizes. The sheet keys a carton by "LxWxH" in mm (165x58x73), a leaflet or label by "LxW". Typed
// many ways over the years: 165X58X73, 165 x 58 x 73, 165*58*73, 165×58×73MM, "62XX38X117", a trailing
// artwork revision ("212X95X95R0"). parseSize reads them all to one key, and keeps the order: L, W, H
// are not interchangeable (L × W is the face, H the depth), so 58x165x73 is a DIFFERENT key — flagged as
// a possible duplicate elsewhere, never merged here.
export function parseSize(text) {
  if (text == null) return null;
  const raw = String(text).replace(/ /g, ' ').trim();
  if (!raw) return null;
  const s = raw.toLowerCase()
    .replace(/[×*]/g, 'x')
    .replace(/\s+/g, '')
    .replace(/mm/g, '')
    .replace(/x{2,}/g, 'x');
  const m = s.match(/^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)(?:x(\d+(?:\.\d+)?))?(?:r\d+)?$/);
  if (!m) return { kind: 'other', key: s.toUpperCase(), label: raw.toUpperCase(), l: null, w: null, h: null };
  const [l, w, h] = [m[1], m[2], m[3]].map(x => (x == null ? null : Number(x)));
  if (!(l > 0) || !(w > 0) || (h != null && !(h > 0))) return { kind: 'other', key: s.toUpperCase(), label: raw.toUpperCase(), l: null, w: null, h: null };
  const key = h == null ? `${l}x${w}` : `${l}x${w}x${h}`;
  return { kind: h == null ? 'flat' : 'carton', key, label: key.replace(/x/g, ' × '), l, w, h };
}

// The sheet's PASTING column: LOCK, SIDE, LIT … typed with stray spaces and case ('LOCK ', 'lOCK').
export const STYLES = Object.freeze({
  LOCK: 'Lock bottom',
  SIDE: 'Side pasting',
  LIT: 'Leaflet (LIT)',
  CUP: 'Cup',
  'DBL PAS': 'Double pasting',
  'DIE CUT': 'Die cut only',
  NONE: 'No pasting',
});
export function normStyle(s) {
  const k = String(s ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
  return k || null;
}
export const styleLabel = s => (s ? STYLES[s] || s : 'Not recorded');

// ---------------------------------------------------------------------------------------------------
// Size helper — the sheet's "Sizer" tab. From a carton's L × W × H (mm) it proposes the smallest print
// sheet for a layout of `l_ups` across × `w_ups` down, each block holding two cartons nested head to
// tail (so ups = l_ups × w_ups × 2). Pasting flap 10 mm and closing 12 mm are the sheet's own figures.
//
// A GUIDE, not a check: tested against the 980 layouts in the Size chart, half the real layouts are
// larger than this proposes and a sixth smaller (side-pasted cartons, other conventions). So it fills
// in a starting point for a brand-new size and never warns about a layout already chosen.
export const SIZER_LAYOUTS = Object.freeze([[1, 1], [1, 2], [2, 1], [2, 2], [1, 3], [3, 1], [2, 3], [3, 2], [3, 3], [2, 4], [4, 2]]);
export function sizerProposals(size, { pasting = 10, closing = 12 } = {}) {
  const l = num(size?.l), w = num(size?.w), h = num(size?.h);
  if (!(l > 0) || !(w > 0) || !(h > 0)) return [];
  return SIZER_LAYOUTS.map(([lu, wu]) => ({
    l_ups: lu, w_ups: wu, ups: lu * wu * 2,
    sheet_l: (((l + w) * 2) + pasting) / 25.4 * lu,
    sheet_w: ((((w / 2 + 10) + h + w + closing) * 2) - w - closing) / 25.4 * wu,
  }));
}

// ---------------------------------------------------------------------------------------------------
// Comparing a costing with an earlier one. Both sides are { inputs, result } with result from
// computeCosting under each side's own formula. The answer says by how much the cost per carton moved
// and which parts of the cost moved it, in words — only parts that moved, biggest first, each with the
// inputs that changed underneath it. Nothing is guessed: a reason is given only when an input differs.
const PARTS = [
  { key: 'board', label: 'Board', drivers: ['board_rate', 'gsm', 'sheet_l', 'sheet_w', 'ups', 'wastage', 'qty'] },
  { key: 'print', label: 'Printing', drivers: ['print_rate', 'colours', 'print_min', 'ups', 'wastage', 'qty'] },
  { key: 'coat', label: 'Coating', drivers: ['coat_factor', 'sheet_l', 'sheet_w', 'ups', 'wastage', 'qty'] },
  { key: 'dp', label: 'Die & pasting', drivers: ['dp_rate'] },
  { key: 'process', label: 'Process charge', drivers: ['process', 'qty'] },
  { key: 'markup', label: 'P&F and misc', drivers: ['pf_pct', 'misc_pct'] },
  { key: 'emb', label: 'Embossing', drivers: ['emb_rate'] },
];
const MONEY_INPUTS = new Set(['board_rate', 'print_rate', 'print_min', 'dp_rate', 'emb_rate', 'process']);

function partsPerUnit(r) {
  const q = r.qty, p = r.parts;
  return {
    board: p.board / q, print: p.print / q, coat: p.coat / q, dp: p.dp / q, process: p.process / q,
    markup: (p.pf + p.misc) / q, emb: p.emb_total / q,
  };
}

function describeInput(key, a, b) {
  const pre = MONEY_INPUTS.has(key) ? '₹' : '';
  const suf = key.endsWith('_pct') ? '%' : '';
  const show = x => (x == null ? 'blank' : `${pre}${fmtFlex(x, 3)}${suf}`);
  return `${LABEL[key].toLowerCase()} ${show(a)} → ${show(b)}`;
}

export function compareCostings(now, then, { threshold = 15 } = {}) {
  const a = then?.result, b = now?.result;
  if (!a?.ok || !b?.ok) return null;
  const delta = b.cost_per_unit - a.cost_per_unit;
  const deltaPct = a.cost_per_unit ? delta / a.cost_per_unit * 100 : null;
  const pa = partsPerUnit(a), pb = partsPerUnit(b);
  const ia = then.inputs || {}, ib = now.inputs || {};
  const reasons = PARTS
    .map(part => ({ part, d: pb[part.key] - pa[part.key] }))
    .filter(({ d }) => Math.abs(d) >= 0.0005)
    .sort((x, y) => Math.abs(y.d) - Math.abs(x.d))
    .map(({ part, d }) => {
      const changed = part.drivers.filter(k => (num(ia[k]) ?? null) !== (num(ib[k]) ?? null));
      return {
        part: part.key,
        delta: d,
        text: `${part.label} ${d > 0 ? 'up' : 'down'} ₹${fmtFlex(Math.abs(d), 3)} a carton`
          + (changed.length ? ` — ${changed.map(k => describeInput(k, num(ia[k]), num(ib[k]))).join('; ')}` : ''),
      };
    });
  return {
    then: a.cost_per_unit, now: b.cost_per_unit, delta, delta_pct: deltaPct,
    significant: deltaPct != null && Math.abs(deltaPct) >= threshold,
    reasons,
  };
}
