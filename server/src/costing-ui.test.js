import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCosting } from './costing-engine.js';
import {
  parsePaste, rankHistory, closestComparison, batchExportSpec, valueFromSaved, blankValue, stillNeeded, coatingWords, coatingLabel, coatingChoices, perUnit,
  recommend, markEdited, layoutOptions, gradeFor, pastingFromProduct, newLibraryEntry, libraryKey, libraryDeclined, savePayload,
  bulkRowPatch, mergeBulkRow, savedTicks, rowWithTicks, answeredNo,
} from '../../client/src/lib/costingUi.js';
import { newDieDefault, chargeGrades } from '../../client/src/lib/costingRules.js';
import { quantityBreaks } from '../../client/src/lib/costing.js';
import { costingValueFromEnquiry } from '../../client/src/lib/enquiryUi.js';

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

test('a coating choice names its sheet factor beside the rate', () => {
  assert.equal(coatingLabel({ factor: 2.5, name: '' }), '₹0.40 per 100 sq in · factor 2.5');
  assert.equal(coatingLabel({ factor: 6, name: 'Test varnish' }), 'Test varnish — ₹0.17 per 100 sq in · factor 6');
});

test('coating buttons run cheapest first, and a factor off the list still shows', () => {
  const list = [{ factor: 2, name: '' }, { factor: 6, name: '' }, { factor: 0.5, name: '' }, { factor: 2.5, name: '' }];
  assert.deepEqual(coatingChoices(list).map(c => c.factor), [6, 2.5, 2, 0.5]);
  // An old costing's factor 7 is not a button: it gets one while it is the choice in force.
  assert.deepEqual(coatingChoices(list, '7').map(c => c.factor), [7, 6, 2.5, 2, 0.5]);
  for (const choice of ['', 'none', 'rate', '2.5', undefined]) {
    assert.deepEqual(coatingChoices(list, choice).map(c => c.factor), [6, 2.5, 2, 0.5]);
  }
  assert.deepEqual(list.map(c => c.factor), [2, 6, 0.5, 2.5], 'the Rates tab list is not reordered');
});

test('every factor on the buttons costs as area ÷ factor ÷ 100 × sheets', () => {
  const sheets = 10000 / 8 + 250;
  for (const f of [6, 5, 4, 3, 2.5, 2, 1, 0.5]) {
    assert.ok(Math.abs(computeCosting({ ...JOB, coat_factor: f }).parts.coat - (18 * 24 / f / 100) * sheets) < 1e-9, `factor ${f}`);
  }
});

// A form's size + pasting + layout, against the Size Library.
const FORM = { size_text: '70 x 47 x 74', style: 'LOCK', inputs: { sheet_l: 20, sheet_w: 28, ups: 8 } };
const ENTRY = { style: 'LOCK', sheet_l: 20, sheet_w: 28, ups: 8 };

test('a new size is raised at once, and can be saved once its sheet and ups are in', () => {
  const early = newLibraryEntry({ ...FORM, inputs: {} });
  assert.equal(early.new_size, true);
  assert.equal(early.ready, false);
  const entry = newLibraryEntry(FORM);
  assert.equal(entry.new_size, true);
  assert.equal(entry.ready, true);
  assert.equal(entry.text, '70 × 47 × 74 mm · Lock bottom · 20 × 28 in · 8 ups');
  assert.equal(newLibraryEntry({ ...FORM, size_text: '' }), null, 'no size, nothing to ask');
});

test('a new layout of a known size is asked about; a known entry is not', () => {
  assert.equal(newLibraryEntry(FORM, [ENTRY]), null);
  assert.equal(newLibraryEntry({ ...FORM, inputs: { sheet_l: '20', sheet_w: '28.0', ups: '8' } }, [ENTRY]), null, 'typed text matches too');
  assert.equal(newLibraryEntry({ ...FORM, style: 'SIDE' }, [ENTRY]).new_size, false);
  assert.equal(newLibraryEntry({ ...FORM, inputs: { ...FORM.inputs, ups: 6 } }, [ENTRY]).new_size, false);
  assert.equal(newLibraryEntry({ ...FORM, inputs: {} }, [ENTRY]), null, 'a known size with no sheet yet: its layouts are on screen');
});

test('"Not now" holds for that layout only, and reaches the server', () => {
  assert.equal(savePayload(FORM).save_size, true);
  const no = { ...FORM, skip_library: libraryKey(FORM) };
  assert.equal(libraryDeclined(no), true);
  assert.equal(savePayload(no).save_size, false);
  const other = { ...no, inputs: { ...no.inputs, ups: 6 } };
  assert.equal(libraryDeclined(other), false, 'a different layout is a new question');
  assert.equal(savePayload(other).save_size, true);
});

test('a complete saved costing with no library entry was answered no; others were not', () => {
  const c = { id: 1, complete: true, size_id: null, size_key: '70x47x74', style: 'LOCK', inputs: FORM.inputs };
  assert.equal(libraryDeclined(valueFromSaved(c)), true);
  assert.equal(libraryDeclined(valueFromSaved(c, { asNew: true })), false, 'costing it again is a new question');
  assert.equal(libraryDeclined(valueFromSaved({ ...c, complete: false })), false, 'never got as far as asking');
  assert.equal(libraryDeclined(valueFromSaved({ ...c, size_id: 5 })), false);
});

test('an auto-costing with no size entry is still asked about', () => {
  // CI Plant never adds a size to the Size Library, so its costing says nothing of what a person would answer.
  assert.equal(answeredNo({ complete: true, size_id: null, auto_costed: true }), false);
  assert.equal(answeredNo({ complete: true, size_id: null, auto_costed: false }), true);
  const c = { id: 2, complete: true, size_id: null, auto_costed: true, size_key: '70x47x74', style: 'LOCK', inputs: FORM.inputs };
  assert.equal(libraryDeclined(valueFromSaved(c)), false, 'opening it asks "save this size?"');
});

test('money and coating in words', () => {
  assert.equal(coatingWords(6), '₹0.17 per 100 sq in');
  assert.equal(coatingWords(2), '₹0.50 per 100 sq in');
  assert.equal(coatingWords(0.5), '₹2.00 per 100 sq in');
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
  assert.equal(v.inputs.dp_rate, 0.4);
  assert.equal(v.sources.dp_rate.kind, 'rule', 'house rule (11 Nov 2026): lock bottom ₹0.40');
  assert.equal(v.inputs.process, 2000, 'house rule: an existing product, its die exists — ₹2,000');
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
  assert.equal(v.sources.coat_choice.kind, 'history');
  assert.match(v.sources.coat_choice.note, /^T-2, 2025-02-01/);
  // Die & pasting: the house rule comes before past costings (owner, 11 Nov 2026).
  assert.equal(v.inputs.dp_rate, 0.4);
  assert.equal(v.sources.dp_rate.kind, 'rule');
});

test('recommend: with no product, the newest comparable costing of the size fills the gaps', () => {
  const history = [HIST(4, 'Old', { ...JOB, coat_factor: 3, gsm: 300, board_rate: 92 }), HIST(5, 'Other style', { ...JOB, coat_factor: 2 }, { style: 'SIDE' })];
  const v = recommend({ ...blankValue(DEFAULTS), size_text: '120x40x90', style: 'LOCK', sources: { ...blankValue(DEFAULTS).sources, style: { kind: 'manual' } } },
    { check: { library: { exact: [LAYOUT(1, 15, 25, 6, 9)] }, history }, typical: TYPICAL, defaults: DEFAULTS, grades: GRADES });
  assert.equal(v.coat_choice, '3', 'the SIDE costing is not comparable');
  assert.equal(v.inputs.gsm, 300);
  assert.equal(v.inputs.board_rate, 120, 'house rule ₹120/kg ahead of the last costing\'s ₹92');
  assert.equal(v.sources.board_rate.kind, 'rule');
  assert.equal(v.inputs.ups, 6);
});

test('recommend: from the size\'s history, the most used rate — one odd recent costing does not set it', () => {
  const history = [
    HIST(9, 'A', { ...JOB, dp_rate: 0.5, coat_factor: 2 }),
    HIST(8, 'B', { ...JOB, dp_rate: 0.2, coat_factor: 6 }),
    HIST(7, 'C', { ...JOB, dp_rate: 0.2, coat_factor: 6 }),
  ];
  const v = recommend({ ...blankValue(DEFAULTS), size_text: '120x40x90', style: 'LOCK' }, { check: { library: { exact: [] }, history }, typical: TYPICAL, defaults: DEFAULTS, grades: GRADES });
  assert.equal(v.coat_choice, '6');
  assert.match(v.sources.coat_choice.note, /^2 of 3 recent costings of this size/);
  assert.equal(v.inputs.dp_rate, 0.4, 'house rule for lock bottom, not the history');
  assert.equal(v.inputs.board_rate, 120, 'house rule');
  // A pasting the rules do not price still follows the most used rate of the size.
  const cup = recommend({ ...blankValue(DEFAULTS), size_text: '120x40x90', style: 'CUP' },
    { check: { library: { exact: [] }, history: history.map(h => ({ ...h, style: 'CUP' })) }, typical: TYPICAL, defaults: DEFAULTS, grades: GRADES });
  assert.equal(cup.inputs.dp_rate, 0.2);
  assert.match(cup.sources.dp_rate.note, /^2 of 3 recent costings of this size/);
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

// ── the shared fill: picker, customer rates, run wastage, assumed values (owner, 20 Nov 2026) ──────
const BOARDS = [{ sheet_l: 23, sheet_w: 36 }];
const ENQ = (o = {}) => ({ id: 41, enquiry_no: 'ENQ-41', customer_name: 'Bluefin Labs', product_name: 'Test Tablets', size_text: '60x40x100', style: 'LOCK', quantities: [20000], board: 'Saffire', ...o });
const ENQ_GRADES = [{ grade: 'CFBB', rate_per_kg: 95 }, { grade: 'Met Saffire', rate_per_kg: 120 }];
const fillEnquiry = (e, ctx = {}) => recommend(costingValueFromEnquiry(e, DEFAULTS), { check: { library: { exact: [] }, history: [] }, typical: TYPICAL, defaults: DEFAULTS, grades: ENQ_GRADES, boards: BOARDS, ...ctx });

test("the fill takes the old die's layout and says so", () => {
  const check = { library: { exact: [LAYOUT(1, 19, 25, 8, 5, 'LOCK')] }, dies: { exact: [{ id: 1, code: 'D-1', ups: 6, sheet_size: '17.5X22.5', condition: 'Good' }] }, history: [] };
  const v = fillEnquiry(ENQ(), { check });
  assert.equal(v.sources.ups.kind, 'die');
  assert.deepEqual([v.inputs.sheet_l, v.inputs.sheet_w, v.inputs.ups], [18, 23, 6]);
  assert.match(v.sources.ups.note, /Die Master D-1/);
  assert.equal(v.layout_pick.kind, 'die');
});

test('the fill records why no layout was picked', () => {
  const v = fillEnquiry(ENQ({ style: null }));
  assert.equal(v.layout_pick.none, true);
  assert.match(v.layout_pick.why, /needs pasting/);
  assert.equal(v.inputs.ups, '');
  assert.equal(recommend(blankValue(DEFAULTS), { defaults: DEFAULTS }).layout_pick, undefined, 'no boards given: no picker, no record');
});

test('a pasting nobody gave is the one most used by the past costings of the size, taken before the layout', () => {
  const history = [HIST(1, 'A', JOB), HIST(2, 'B', JOB), HIST(3, 'C', JOB), HIST(4, 'D', JOB, { style: 'SIDE' })];
  const v = fillEnquiry(ENQ({ style: null }), { check: { library: { exact: [] }, history } });
  assert.equal(v.style, 'LOCK');
  assert.equal(v.sources.style.kind, 'history');
  assert.match(v.sources.style.note, /^3 of 4 recent costings of this size/);
  assert.notEqual(v.layout_pick.none, true, 'the picker drew the carton in that pasting');
  assert.equal(v.inputs.dp_rate, 0.4, 'and the house rate for it');
  // The Size Library's pasting comes first.
  const lib = fillEnquiry(ENQ({ style: null }), { check: { library: { exact: [LAYOUT(1, 19, 25, 6, 5, 'SIDE')] }, history } });
  assert.deepEqual([lib.style, lib.sources.style.kind], ['SIDE', 'library']);
  // With no past costing either, the picker asks.
  assert.equal(fillEnquiry(ENQ({ style: null }), { check: { library: { exact: [] }, history: [] } }).layout_pick.why, 'needs pasting: side or lock?');
});

test("the fill charges the customer's rate on CFBB and notes it", () => {
  const grades = chargeGrades(ENQ_GRADES, 107);
  const v = fillEnquiry(ENQ(), { grades, customerRate: { word: 'bluefin', rate: 107 } });
  assert.equal(v.board_grade, 'CFBB');
  assert.equal(v.inputs.board_rate, 107);
  assert.equal(v.sources.board_rate.kind, 'rule');
  assert.match(v.sources.board_rate.note, /bluefin/);
});

test('the fill sets wastage by the run', () => {
  const v = fillEnquiry(ENQ(), { check: { library: { exact: [LAYOUT(1, 19, 25, 6, 5, 'LOCK')] }, history: [] } });
  assert.equal(v.inputs.ups, 6);
  assert.equal(v.inputs.wastage, 300, '20,000 ÷ 6 up = 3,334 sheets');
  assert.equal(v.inputs.wastage_by_run, 1);
  assert.equal(v.sources.wastage.kind, 'rule');
});

test('a typed wastage is kept and does not follow the run; typed ups still drive the rule wastage', () => {
  const check = { library: { exact: [LAYOUT(1, 19, 25, 6, 5, 'LOCK')] }, history: [] };
  const base = costingValueFromEnquiry(ENQ(), DEFAULTS);
  const typed = markEdited({ ...base, inputs: { ...base.inputs, wastage: 250, wastage_by_run: 1 } }, ['wastage']);
  const v = recommend(typed, { check, typical: TYPICAL, defaults: DEFAULTS, grades: ENQ_GRADES, boards: BOARDS });
  assert.equal(v.inputs.wastage, 250);
  assert.equal(v.sources.wastage.kind, 'manual');
  assert.notEqual(v.inputs.wastage_by_run, 1);
  const full = { ...v.inputs, coat_factor: 3 };
  for (const b of quantityBreaks(full, [10000, 50000])) assert.equal(b.cost_per_unit, computeCosting({ ...full, qty: b.qty }).cost_per_unit, 'the typed 250 at both breaks');
  // typed ups 8, no typed wastage: 20,000 / 8 = 2,500 sheets -> 200, and it follows the run
  const u = markEdited({ ...base, inputs: { ...base.inputs, ups: 8 } }, ['ups']);
  const w = recommend(u, { check, typical: TYPICAL, defaults: DEFAULTS, grades: ENQ_GRADES, boards: BOARDS });
  assert.equal(w.inputs.ups, 8);
  assert.equal(w.inputs.wastage, 200);
  assert.equal(w.inputs.wastage_by_run, 1);
});

test('an enquiry with no coating or GSM is filled as assumed, a typed one is kept', () => {
  const v = fillEnquiry(ENQ());
  assert.equal(v.inputs.coat_factor, 3);
  assert.equal(v.inputs.gsm, 300);
  assert.equal(v.sources.coat_factor.kind, 'assumed');
  assert.equal(v.sources.gsm.kind, 'assumed');
  const typed = costingValueFromEnquiry(ENQ({ gsm: 350 }), DEFAULTS);
  const k = recommend(typed, { check: { library: { exact: [] }, history: [] }, typical: TYPICAL, defaults: DEFAULTS, grades: ENQ_GRADES, boards: BOARDS });
  assert.equal(k.inputs.gsm, 350);
  assert.equal(k.sources.gsm.kind, 'manual');
});

test('a past coating of the size and a Met Saffire board beat the assumed coating', () => {
  const hist = [HIST(4, 'Old', { ...JOB, coat_factor: 2 })];
  assert.equal(fillEnquiry(ENQ(), { check: { library: { exact: [] }, history: hist } }).sources.coat_factor.kind, 'history');
  const met = fillEnquiry(ENQ({ board: 'Met Saffire' }));
  assert.equal(met.inputs.coat_factor, 1.5);
  assert.equal(met.sources.coat_factor.kind, 'rule');
});

test('a New costing with no enquiry gets no assumed values', () => {
  const v = recommend({ ...blankValue(DEFAULTS), size_text: '120x40x90', style: 'LOCK' }, { check: { library: { exact: [] }, history: [] }, typical: TYPICAL, defaults: DEFAULTS, grades: GRADES, boards: BOARDS });
  assert.equal(v.inputs.gsm, '');
  assert.equal(v.coat_choice, '');
});

test('costingValueFromEnquiry carries the opening', () => {
  assert.equal(costingValueFromEnquiry(ENQ({ opening: 'top' }), DEFAULTS).opening, 'top');
  assert.equal(costingValueFromEnquiry(ENQ(), DEFAULTS).opening, null);
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

// Bulk costing's row editor (owner, 18 Nov 2026, "fix bulk too"). The full editor of a bulk row hands its value back after
// every change. A New die or Big box tick empties the charge it governs for the editor to refill; the row must come
// back with the house rule's charge, never a blank box priced at ₹0. Invented figures.
const bulkRow = (over = {}) => ({
  key: 'r1', id: null, product_name: 'Carton one', size_text: '100x48x48', style: 'SIDE', autofill: false, dp_auto: true,
  inputs: { ...JOB, dp_rate: 0.2, process: 3000 }, ...over,
});
// What CostingEditor's tick() hands back: the flag set, the box it governs emptied, that box's source dropped.
const ticked = (row, flag, on, field) => ({ ...row, [flag]: on, inputs: { ...row.inputs, [field]: '' }, sources: {}, autofill: true });
const styleRate = style => ({ SIDE: 0.2, LOCK: 0.3 })[style] ?? '';

test("bulk row editor: New die ticked off charges ₹2,000 and on again ₹3,000 — the box is never left blank", () => {
  const row = bulkRow();
  const off = mergeBulkRow(row, bulkRowPatch(row, ticked(row, 'new_die', false, 'process')), styleRate);
  assert.equal(off.inputs.process, 2000);
  assert.equal(off.new_die, false);
  const on = mergeBulkRow(off, bulkRowPatch(off, ticked(off, 'new_die', true, 'process')), styleRate);
  assert.equal(on.inputs.process, 3000);
  assert.equal(on.new_die, true);
  const processLine = inputs => computeCosting(inputs).lines.find(l => l.key === 'process').amount;
  assert.equal(processLine(on.inputs), 3000);
  assert.equal(processLine(off.inputs), 2000);
});

test("bulk row editor: Big box gives the row ₹0.41 of its own; off again, the batch's die & pasting", () => {
  const row = bulkRow();
  const on = mergeBulkRow(row, bulkRowPatch(row, ticked(row, 'big_box', true, 'dp_rate'), { back: 0.2, follows: true }), styleRate);
  assert.equal(on.inputs.dp_rate, 0.41);
  assert.equal(on.big_box, true);
  assert.equal(on.dp_auto, false);
  // a later edit in the editor (here the quantity) keeps the big box's figure
  const later = mergeBulkRow(on, bulkRowPatch(on, { ...on, inputs: { ...on.inputs, qty: 5000 }, autofill: true }), styleRate);
  assert.equal(later.inputs.dp_rate, 0.41);
  // off again under a blank common box: back to following the pasting style
  const off = mergeBulkRow(later, bulkRowPatch(later, ticked(later, 'big_box', false, 'dp_rate'), { back: 0.2, follows: true }), styleRate);
  assert.equal(off.inputs.dp_rate, 0.2);
  assert.equal(off.big_box, false);
  assert.equal(off.dp_auto, true);
  // off again in a batch with its own die & pasting: that figure, and the row does not follow the style
  const own = mergeBulkRow(later, bulkRowPatch(later, ticked(later, 'big_box', false, 'dp_rate'), { back: 0.25, follows: false }), styleRate);
  assert.equal(own.inputs.dp_rate, 0.25);
  assert.equal(own.dp_auto, false);
});

test('bulk row editor: a die & pasting typed in a style-following row is kept, not reset to the style rate', () => {
  const row = bulkRow();
  const typed = { ...row, inputs: { ...row.inputs, dp_rate: '0.25' }, sources: { dp_rate: { kind: 'manual' } }, autofill: true };
  const next = mergeBulkRow(row, bulkRowPatch(row, typed), styleRate);
  assert.equal(next.inputs.dp_rate, '0.25');
  assert.equal(next.dp_auto, false);
});

test('bulk row editor: an edit that is not a tick keeps the charges as the editor has them', () => {
  const row = bulkRow({ new_die: true });
  const typed = { ...row, inputs: { ...row.inputs, process: '2500', qty: 5000 }, sources: { process: { kind: 'manual' } }, autofill: true };
  const p = bulkRowPatch(row, typed);
  assert.equal(p.inputs.process, '2500');
  assert.equal(p.inputs.qty, 5000);
  assert.equal(p.new_die, true);
  // a new pasting style on a style-following row still takes that style's figure
  const styled = mergeBulkRow(row, bulkRowPatch(row, { ...row, style: 'LOCK', autofill: true }), styleRate);
  assert.equal(styled.inputs.dp_rate, 0.3);
});

test('savedTicks: a saved row reopens with the ticks its charges say', () => {
  assert.deepEqual(savedTicks({ process: 3000, dp_rate: 0.41 }), { new_die: true, big_box: true });
  assert.deepEqual(savedTicks({ process: '2000', dp_rate: '0.2' }), { new_die: false, big_box: false });
  assert.deepEqual(savedTicks({}), { new_die: false, big_box: false });
});

test('rowWithTicks: a bulk row shows the ticks its charges say until somebody ticks one', () => {
  const typed = bulkRow({ inputs: { ...JOB, process: 2000, dp_rate: 0.2 } });   // typed into the table: the common ₹2,000
  assert.equal(newDieDefault(typed), true);                                  // the editor showed New die ticked over ₹2,000
  assert.equal(newDieDefault(rowWithTicks(typed)), false);
  assert.equal(rowWithTicks(bulkRow()).new_die, true);                       // pasted, no product: the house rule's ₹3,000
  assert.equal(rowWithTicks(bulkRow({ new_die: false })).new_die, false);    // a tick somebody set stays as set
  assert.equal(rowWithTicks(bulkRow({ inputs: { ...JOB, dp_rate: 0.41 } })).big_box, true);
  assert.equal(rowWithTicks(bulkRow({ big_box: false, inputs: { ...JOB, dp_rate: 0.41 } })).big_box, false);
});

test('bulk row editor: on a typed row a size proposal charges the new die, and other edits leave its ₹2,000 alone', () => {
  const base = rowWithTicks(bulkRow({ inputs: { ...JOB, process: 2000, dp_rate: 0.2 } }));
  const qty = bulkRowPatch(base, { ...base, inputs: { ...base.inputs, qty: 5000 }, autofill: true });
  assert.equal(qty.inputs.process, 2000);
  // "Use this layout" on a proposal: the editor sets New die and empties the process box
  const picked = bulkRowPatch(base, { ...base, new_die: true, inputs: { ...base.inputs, sheet_l: 20, sheet_w: 28, ups: 6, process: '' }, autofill: true });
  assert.equal(picked.inputs.process, 3000);
});

// ---- Task 11: the form's input edits and a bulk row's grade (invented figures) ----
import { inputsAfterEdit, rowBoardGrade } from '../../client/src/lib/costingUi.js';

test('inputsAfterEdit: a typed wastage stops following the run; qty and ups rework a rule wastage', () => {
  const base = { qty: 10000, ups: 4, wastage: 300, wastage_by_run: 1 };
  assert.equal(inputsAfterEdit(base, 'wastage', 150).wastage, 150);
  assert.equal(inputsAfterEdit(base, 'wastage', 150).wastage_by_run, '');
  assert.equal(inputsAfterEdit(inputsAfterEdit(base, 'wastage', 150), 'qty', 40000).wastage, 150);
  assert.equal(inputsAfterEdit(base, 'qty', 40000).wastage, 400);          // 10,000 sheets
  assert.equal(inputsAfterEdit(base, 'ups', 8).wastage, 200);              // 1,250 sheets
  assert.equal(inputsAfterEdit({ ...base, wastage_by_run: '' }, 'qty', 40000).wastage, 300); // typed: left
  assert.equal(inputsAfterEdit(base, 'gsm', 280).gsm, 280);
});

test('rowBoardGrade: the rule fills a row with no grade of its own, never over a picked one', () => {
  assert.equal(rowBoardGrade({ board_grade: '' }, 'CFBB'), 'CFBB');
  assert.equal(rowBoardGrade({}, 'CFBB'), 'CFBB');
  assert.equal(rowBoardGrade({ board_grade: 'Duplex' }, 'CFBB'), 'Duplex');
  assert.equal(rowBoardGrade({ board_grade: '' }, null), '');
});

// ---- Task 11 fix round 1: R28 (typed common board rate wins) and R29 (why a customer-rate row is not saved) ----
import { rowBoardRate } from '../../client/src/lib/costingUi.js';
import { customerRateProblems, cleanCustomerRates } from '../../client/src/lib/costingRules.js';

// Final review I4 (revises R28b): a common board rate a person typed wins over the RULE's rate only — the customer's rate,
// the house ₹120, the ₹120 prefill — never over a matched Product Master grade's rate, nor a rate typed on the row itself.
// `from` says where the row's rate came from: 'rule' | 'common' | 'product' | 'row'; a row with none (an old batch) is its own.
test("rowBoardRate: a typed common rate wins over the rule's rate only", () => {
  const typed = { commonTyped: true, commonRate: 130 };
  assert.deepEqual(rowBoardRate({ from: 'rule', rate: 107, ...typed }), { board_rate: 130, board_from: 'common' }, 'a rule-rated CFBB row takes 130');
  assert.deepEqual(rowBoardRate({ from: 'rule', rate: 120, ...typed }), { board_rate: 130, board_from: 'common' }, 'the ₹120 prefill is the rule too');
  assert.deepEqual(rowBoardRate({ from: 'common', rate: 125, ...typed }), { board_rate: 130, board_from: 'common' }, 'a row on an earlier common rate follows it');
  assert.deepEqual(rowBoardRate({ from: 'product', rate: 51, ...typed }), { board_rate: 51, board_from: 'product' }, 'a product row (grade ₹51) keeps 51');
  assert.deepEqual(rowBoardRate({ from: 'row', rate: 99, ...typed }), { board_rate: 99, board_from: 'row' }, 'a row typed by hand keeps its figure');
  assert.deepEqual(rowBoardRate({ from: undefined, rate: 125, ...typed }), { board_rate: 125, board_from: undefined }, 'an old row with no marker is left alone');
  assert.deepEqual(rowBoardRate({ from: null, rate: 125, ...typed }), { board_rate: 125, board_from: null });
  // nothing typed in common: the rule's rate; a rule that gives none takes the common box (the prefill)
  assert.deepEqual(rowBoardRate({ from: 'rule', rate: 107, commonTyped: false, commonRate: 120 }), { board_rate: 107, board_from: 'rule' });
  assert.deepEqual(rowBoardRate({ from: 'rule', rate: null, commonTyped: false, commonRate: 120 }), { board_rate: 120, board_from: 'rule' });
  assert.deepEqual(rowBoardRate({ from: 'rule', rate: '', commonTyped: true, commonRate: 130 }), { board_rate: 130, board_from: 'common' });
  // the common box blanked (not typed any more): every row keeps what it has
  assert.deepEqual(rowBoardRate({ from: 'common', rate: 130, commonTyped: false, commonRate: '' }), { board_rate: 130, board_from: 'common' });
});

test("bulk row editor: a board rate changed in a row's full editor is the row's own", () => {
  const row = bulkRow({ board_from: 'rule' });
  const p = bulkRowPatch(row, { ...row, inputs: { ...row.inputs, board_rate: 99 }, sources: { board_rate: { kind: 'manual' } }, autofill: true });
  assert.equal(p.board_from, 'row');
  assert.equal(mergeBulkRow(row, p, styleRate).board_from, 'row');
  const q = bulkRowPatch(row, { ...row, inputs: { ...row.inputs, qty: 5000 }, autofill: true });
  assert.equal('board_from' in q, false, 'another edit leaves where the rate came from');
  assert.equal(mergeBulkRow(row, q, styleRate).board_from, 'rule');
});

test('customerRateProblems: one reason per row that a save would drop, none for the rest', () => {
  const rows = [
    { word: 'a', board_rate: 100 }, { word: 'alpha', board_rate: 0 }, { word: 'beta', board_rate: 1001 },
    { word: 'gamma', board_rate: 90 }, { word: 'GAMMA', board_rate: 95 }, { word: 'delta', board_rate: 110 },
  ];
  const p = customerRateProblems(rows);
  assert.match(p[0], /2 to 40 characters/);
  assert.match(p[1], /above 0/);
  assert.match(p[2], /1,000/);
  assert.equal(p[3], null);
  assert.match(p[4], /already/);
  assert.equal(p[5], null);
  assert.equal(cleanCustomerRates(rows).length, rows.filter((_, i) => p[i] == null).length);
});

import { commonToSave, commonFromSaved, boardFromSaved } from '../../client/src/lib/costingUi.js';

test('the common board_typed flag survives save and reopen, and is never inferred from the value', () => {
  const common = { inputs: { board_rate: 130, colours: 4 }, quantities: [5000], board_typed: true };
  const back = commonFromSaved(JSON.parse(JSON.stringify(commonToSave(common))));
  assert.equal(back.board_typed, true);
  assert.equal(back.inputs.board_rate, 130);
  assert.deepEqual(back.quantities, [5000]);
  assert.equal('board_typed' in back.inputs, false);
  assert.equal(commonFromSaved({ board_rate: 130 }).board_typed, false);   // an old batch: 130 is not read as typed
  assert.equal(commonToSave({ inputs: { board_rate: 120 }, quantities: [] }).board_typed, false);
  // the rows' board-rate markers ride on the saved common too (I4, by row position): never read back as an input
  const marked = commonFromSaved({ board_rate: 130, board_typed: true, board_from: ['rule', 'product'] });
  assert.equal('board_from' in marked.inputs, false);
});

// Final review I4: each row's marker is sent with the row and comes back with it, so a reopened batch knows which rows a
// typed common rate may carry into. An old row has none (null): its own.
test('boardFromSaved: a known marker comes back as it was, anything else as none', () => {
  for (const m of ['rule', 'common', 'product', 'row']) assert.equal(boardFromSaved(m), m);
  for (const m of [null, undefined, '', 'typed', 7]) assert.equal(boardFromSaved(m), undefined, String(m));
});

test('customerRateProblems: only the first 50 rows are kept', () => {
  const rows = Array.from({ length: 52 }, (_, i) => ({ word: `word${i}`, board_rate: 100 }));
  const p = customerRateProblems(rows);
  assert.equal(p.filter(x => x == null).length, 50);
  assert.match(p[50], /first 50/);
  assert.equal(cleanCustomerRates(rows).length, 50);
});
