import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCosting } from './costing-engine.js';
import {
  parsePaste, rankHistory, closestComparison, batchExportSpec, valueFromSaved, blankValue, stillNeeded, coatingWords, perUnit,
  recommend, markEdited, layoutOptions, gradeFor, pastingFromProduct,
} from '../../client/src/lib/costingUi.js';

// Invented figures, not a customer's.
const JOB = { qty: 10000, sheet_l: 18, sheet_w: 24, ups: 8, gsm: 300, board_rate: 95, wastage: 250, colours: 4, print_rate: 400, print_min: 1600, coat_factor: 6, dp_rate: 0.3, process: 2000, pf_pct: 5, margin: 0.05 };
const past = (id, over = {}, meta = {}) => {
  const inputs = { ...JOB, ...over };
  const result = computeCosting(inputs);
  return { id, costing_no: `T-${id}`, style: 'LOCK', gsm: inputs.gsm, qty: inputs.qty, costed_on: '2025-01-01', inputs, result, cost_per_unit: result.cost_per_unit, ...meta };
};

test('parsePaste: rows from Excel — header skipped, size found by its shape, quantity read with commas', () => {
  const rows = parsePaste('Product\tSize\tQty\nCarton one\t100x48x48\t10,000\n60X15X40\tCarton two\t5000 pcs\nCarton three\t\t\n');
  assert.deepEqual(rows, [
    { product_name: 'Carton one', size_text: '100x48x48', qty: 10000 },
    { product_name: 'Carton two', size_text: '60X15X40', qty: 5000 },
    { product_name: 'Carton three', size_text: '', qty: null },
  ]);
  assert.deepEqual(parsePaste(''), []);
});

test('rankHistory: same pasting and GSM within 10 come first, newest first; others shown, never compared', () => {
  const now = { style: 'LOCK', inputs: JOB };
  const ranked = rankHistory(now, [
    past(1, {}, { costed_on: '2024-05-01' }),
    past(2, {}, { costed_on: '2025-06-01' }),
    past(3, {}, { style: 'SIDE', costed_on: '2026-01-01' }),
    past(4, { gsm: 350 }, { costed_on: '2026-02-01' }),
  ]);
  assert.deepEqual(ranked.map(r => r.id), [2, 1, 4, 3]);
  assert.deepEqual(ranked.map(r => r.why), [null, null, 'different GSM', 'different pasting']);
});

test('rankHistory: a similar quantity beats a newer costing of a very different quantity', () => {
  const now = { style: 'LOCK', inputs: JOB };
  const ranked = rankHistory(now, [past(1, { qty: 1000 }, { costed_on: '2026-03-01' }), past(2, { qty: 8000 }, { costed_on: '2024-01-01' })]);
  assert.deepEqual(ranked.map(r => r.id), [2, 1]);
});

test('closestComparison: at a different quantity, judged like for like — the quantity alone is no alarm', () => {
  const now = { style: 'LOCK', inputs: JOB };
  const smallOld = past(1, { qty: 1000 });
  const cmp = closestComparison(now, computeCosting(JOB), [smallOld], 15);
  assert.ok(cmp.delta_pct < -15, 'a big drop a carton at 10x the quantity');
  assert.ok(Math.abs(cmp.like_for_like.delta_pct) < 1e-9, 'same rates: nothing changed at their quantity');
  assert.equal(cmp.significant, false);
  const dearer = { style: 'LOCK', inputs: { ...JOB, board_rate: 140 } };
  const c2 = closestComparison(dearer, computeCosting(dearer.inputs), [smallOld], 15);
  assert.equal(c2.significant, true);
  assert.match(c2.like_for_like.reasons[0].text, /board rate ₹95 → ₹140/);
  assert.ok(!/quantity/.test(c2.like_for_like.reasons[0].text), 'like for like, the quantity is not a reason');
});

test('closestComparison: flags a difference over the alert %, with the reason', () => {
  const now = { style: 'LOCK', inputs: { ...JOB, board_rate: 130 } };
  const cmp = closestComparison(now, computeCosting(now.inputs), [past(1)], 15);
  assert.equal(cmp.against.id, 1);
  assert.ok(cmp.delta_pct > 15);
  assert.equal(cmp.significant, true);
  assert.match(cmp.reasons[0].text, /^Board up .* board rate ₹95 → ₹130/);
  assert.equal(closestComparison(now, computeCosting(now.inputs), [past(2, {}, { style: 'SIDE' })]), null, 'nothing comparable, nothing compared');
});

test('the customer quotation sheet carries no internal cost — only product, size, quantity and price', () => {
  const rows = [{ product_name: 'Carton one', size_text: '100x48x48', inputs: JOB }, { product_name: 'Unfinished', size_text: '', inputs: { qty: 5 } }];
  const spec = batchExportSpec({ batch_no: 'CI-CSB-0001' }, rows, { customer: true });
  assert.deepEqual(spec.columns.map(c => c.label), ['#', 'Product', 'Size (mm)', 'Quantity', 'Price per carton ₹', 'Value ₹']);
  assert.equal(spec.rows.length, 1, 'an unfinished row is not quoted');
  const price = spec.columns.find(c => c.key === 'quote').export(spec.rows[0]);
  assert.equal(price, Math.round(computeCosting(JOB).quote_per_unit * 1000) / 1000);
  const internal = batchExportSpec({ batch_no: 'CI-CSB-0001' }, rows);
  assert.ok(internal.columns.some(c => c.label === 'Board ₹'));
  assert.equal(internal.columns.find(c => c.key === 'status').export({ ...rows[1], r: computeCosting(rows[1].inputs) }).startsWith('Needs'), true);
});

test('valueFromSaved / blankValue: a saved costing reopens with its coating choice; a new one must choose', () => {
  const v = valueFromSaved({ product_name: 'Carton', size_key: '100x48x48', style: 'LOCK', inputs: { ...JOB, print_fixed: 999 } });
  assert.equal(v.coat_choice, '6');
  assert.equal(v.inputs.print_fixed, undefined, 'history-only inputs are not carried into a new costing');
  assert.equal(valueFromSaved({ inputs: { ...JOB, coat_factor: null } }).coat_choice, 'none');
  const b = blankValue({ wastage: 250, print_rate: 400, coat_factor: 6 });
  assert.equal(b.inputs.wastage, 250);
  assert.equal(b.inputs.coat_factor, '', 'coating never starts filled');
  assert.ok(stillNeeded(b).includes('Coating'));
  assert.ok(stillNeeded(b).includes('Product name'));
});

test('money and coating in words', () => {
  assert.equal(coatingWords(6), '₹0.17 per 100 sq in');
  assert.equal(coatingWords(2), '₹0.5 per 100 sq in');
  assert.equal(coatingWords(''), 'No coating');
  assert.equal(perUnit(3.1415926), '₹3.142');
  assert.equal(perUnit(null), '—');
});

// ── recommendations ───────────────────────────────────────────────────────────────────────────────
// An invented product, rates and history.
const GRADES = [{ grade: 'Saffire', rate_per_kg: 81.5 }, { grade: 'Duplex WB', rate_per_kg: 51 }, { grade: 'Met Saffire', rate_per_kg: 100 }];
const TYPICAL = { dp_by_style: { LOCK: { value: 0.3, n: 40 }, SIDE: { value: 0.2, n: 30 } }, emb: { value: 0.15, n: 20 }, process_per_colour: { value: 500, n: 50 } };
const DEFAULTS = { wastage: 250, colours: 4, print_rate: 400, print_min: 1600, process: 2000, dp_rate: 0.3, emb_rate: 0, pf_pct: 5, misc_pct: 0, margin: 0.05 };
const PRODUCT = { id: 7, code: 'TS-001', name: 'Test Tablets 10x10 Carton', customer_id: 3, customer_name: 'Test Pharma', size: '120X40X90 MM',
  pasting_type: 'LOCK BOTTOM', sheet_l: 18, sheet_w: 24, ups: 8, gsm: 300, colours: 5, board_grade: 'SAPPHIRE', emboss: 0 };
const LAYOUT = (id, sheet_l, sheet_w, ups, times, style = 'LOCK') => ({ id, size_key: '120x40x90', style, sheet_l, sheet_w, ups, times_costed: times });
const HIST = (id, product_name, inputs, extra = {}) => past(id, inputs, { product_name, style: 'LOCK', costed_on: `2025-0${id}-01`, ...extra });

test('recommend: a picked product fills the form, each value with its source', () => {
  const v = recommend(blankValue(DEFAULTS), { product: PRODUCT, check: { library: { exact: [] }, history: [] }, typical: TYPICAL, defaults: DEFAULTS, grades: GRADES });
  assert.equal(v.size_text, '120x40x90');
  assert.equal(v.style, 'LOCK');
  assert.deepEqual([v.inputs.sheet_l, v.inputs.sheet_w, v.inputs.ups, v.inputs.gsm, v.inputs.colours], [18, 24, 8, 300, 5]);
  assert.equal(v.board_grade, 'Saffire');
  assert.equal(v.inputs.board_rate, 81.5);
  assert.equal(v.sources.board_rate.kind, 'rates');
  assert.equal(v.sources.gsm.kind, 'product');
  assert.equal(v.customer_name, 'Test Pharma');
  assert.equal(v.inputs.emb_rate, 0, 'not embossed on the master');
  assert.equal(v.inputs.dp_rate, 0.3);
  assert.equal(v.sources.dp_rate.kind, 'typical');
  assert.equal(v.inputs.process, 2500, '₹500 a colour × 5');
  assert.equal(v.sources.wastage.kind, 'default');
  assert.equal(v.coat_choice, '', 'no costing to take the coating from, so it is left to choose');
});

test('recommend: ups 1 on the master gives way to the most used library layout', () => {
  const v = recommend(blankValue(DEFAULTS), { product: { ...PRODUCT, ups: 1 }, check: { library: { exact: [LAYOUT(1, 15, 25, 6, 40), LAYOUT(2, 19, 25, 8, 3)] }, history: [] }, typical: TYPICAL, defaults: DEFAULTS, grades: GRADES });
  assert.deepEqual([v.inputs.sheet_l, v.inputs.sheet_w, v.inputs.ups], [15, 25, 6]);
  assert.equal(v.sources.ups.kind, 'library');
  assert.match(v.sources.ups.note, /used 40× · 1 other layout/);
});

test("recommend: coating and die & pasting come from the same product's last costing first", () => {
  const history = [
    HIST(3, 'Another carton', { ...JOB, coat_factor: 2, dp_rate: 0.5 }),
    HIST(2, 'test tablets 10x10  carton', { ...JOB, coat_factor: 6, dp_rate: 0.28 }),
  ];
  const v = recommend(blankValue(DEFAULTS), { product: PRODUCT, check: { library: { exact: [] }, history }, typical: TYPICAL, defaults: DEFAULTS, grades: GRADES });
  assert.equal(v.coat_choice, '6');
  assert.equal(v.inputs.coat_factor, 6);
  assert.equal(v.inputs.dp_rate, 0.28);
  assert.equal(v.sources.dp_rate.kind, 'history');
  assert.match(v.sources.dp_rate.note, /^T-2, 2025-02-01/);
});

test('recommend: with no product, the newest comparable costing of the size fills the gaps', () => {
  const history = [HIST(4, 'Old', { ...JOB, coat_factor: 3, gsm: 300, board_rate: 92 }), HIST(5, 'Other style', { ...JOB, coat_factor: 2 }, { style: 'SIDE' })];
  const v = recommend({ ...blankValue(DEFAULTS), size_text: '120x40x90', style: 'LOCK', sources: { ...blankValue(DEFAULTS).sources, style: { kind: 'manual' } } },
    { check: { library: { exact: [LAYOUT(1, 15, 25, 6, 9)] }, history }, typical: TYPICAL, defaults: DEFAULTS, grades: GRADES });
  assert.equal(v.coat_choice, '3', 'the SIDE costing is not comparable');
  assert.equal(v.inputs.gsm, 300);
  assert.equal(v.inputs.board_rate, 92);
  assert.match(v.sources.board_rate.note, /check today's rate/);
  assert.equal(v.inputs.ups, 6);
});

test('recommend: from the size\'s history, the most used rate — one odd recent costing does not set it', () => {
  const history = [
    HIST(9, 'A', { ...JOB, dp_rate: 0.5, coat_factor: 2 }),
    HIST(8, 'B', { ...JOB, dp_rate: 0.2, coat_factor: 6 }),
    HIST(7, 'C', { ...JOB, dp_rate: 0.2, coat_factor: 6 }),
  ];
  const v = recommend({ ...blankValue(DEFAULTS), size_text: '120x40x90', style: 'LOCK' }, { check: { library: { exact: [] }, history }, typical: TYPICAL, defaults: DEFAULTS, grades: GRADES });
  assert.equal(v.inputs.dp_rate, 0.2);
  assert.equal(v.coat_choice, '6');
  assert.match(v.sources.dp_rate.note, /^2 of 3 recent costings of this size/);
  assert.equal(v.inputs.board_rate, JOB.board_rate);
  assert.match(v.sources.board_rate.note, /^T-9/, 'the board rate is the newest');
});

test('recommend: a typed value is never overwritten; a new product clears the old suggestions', () => {
  let v = recommend(blankValue(DEFAULTS), { product: PRODUCT, check: { library: { exact: [] }, history: [] }, typical: TYPICAL, defaults: DEFAULTS, grades: GRADES });
  v = markEdited({ ...v, inputs: { ...v.inputs, gsm: 350 } }, ['gsm']);
  const other = { ...PRODUCT, id: 8, name: 'Other', gsm: 280, board_grade: 'Duplex', size: '90x30x60', colours: 4 };
  v = recommend(v, { product: other, check: { library: { exact: [] }, history: [] }, typical: TYPICAL, defaults: DEFAULTS, grades: GRADES });
  assert.equal(v.inputs.gsm, 350, 'typed, so kept — although the new product says 280');
  assert.equal(v.sources.gsm.kind, 'manual');
  assert.equal(v.size_text, '90x30x60');
  assert.equal(v.inputs.board_rate, '', '"Duplex" could be WB or GB — not guessed, and the old Saffire rate is not left behind');
  assert.equal(v.board_grade, '');
});

test('recommend: values reopened from a saved costing (no recorded source) are kept', () => {
  const saved = valueFromSaved({ product_name: 'Saved', size_key: '120x40x90', style: 'LOCK', inputs: { ...JOB, dp_rate: 0.45 } });
  const v = recommend(saved, { check: { library: { exact: [LAYOUT(1, 15, 25, 6, 9)] }, history: [] }, typical: TYPICAL, defaults: DEFAULTS, grades: GRADES });
  assert.equal(v.inputs.dp_rate, 0.45);
  assert.equal(v.inputs.ups, JOB.ups);
  assert.equal(v.sources.dp_rate, undefined);
});

test('layoutOptions: every library layout priced as entered, the cheapest flagged', () => {
  const opts = layoutOptions({ inputs: JOB }, [LAYOUT(1, 15, 25, 6, 40), LAYOUT(2, 18, 24, 8, 5), LAYOUT(3, 25, 36, 4, 1)]);
  assert.equal(opts.length, 3);
  for (const o of opts) assert.ok(Math.abs(o.cost_per_unit - computeCosting({ ...JOB, sheet_l: o.sheet_l, sheet_w: o.sheet_w, ups: o.ups }).cost_per_unit) < 1e-12);
  const cheapest = opts.filter(o => o.cheapest);
  assert.equal(cheapest.length, 1);
  assert.equal(cheapest[0].cost_per_unit, Math.min(...opts.map(o => o.cost_per_unit)));
});

test('gradeFor / pastingFromProduct: the Product Master words read to Board Rates and the sheet codes', () => {
  assert.equal(gradeFor('SAPPHIRE', GRADES).grade, 'Saffire');
  assert.equal(gradeFor(' met ', GRADES).grade, 'Met Saffire');
  assert.equal(gradeFor('Duplex', GRADES), null);
  assert.equal(gradeFor('', GRADES), null);
  assert.equal(pastingFromProduct('LOCK BOTTOM'), 'LOCK');
  assert.equal(pastingFromProduct('tuck in lock bottom'), 'LOCK');
  assert.equal(pastingFromProduct('BSO'), 'SIDE');
  assert.equal(pastingFromProduct(null), null);
});

test('the quotation with quantities prices each one, and is stamped DRAFT until approved', () => {
  const spec = batchExportSpec({ batch_no: 'B1' }, [{ product_name: 'One', size_text: '100x48x48', inputs: JOB }], { customer: true, quantities: [5000, 20000], draft: true });
  assert.deepEqual(spec.columns.map(c => c.label), ['#', 'Product', 'Size (mm)', '₹ a carton @ 5,000', '₹ a carton @ 20,000']);
  const q5 = spec.columns[3].export({ ...spec.rows[0] });
  assert.equal(q5, Math.round(computeCosting({ ...JOB, qty: 5000 }).quote_per_unit * 1000) / 1000);
  assert.equal(spec.watermark.text, 'DRAFT — NOT APPROVED');
  assert.equal(batchExportSpec({}, [{ product_name: 'One', inputs: JOB }], { customer: true }).watermark, undefined);
});
