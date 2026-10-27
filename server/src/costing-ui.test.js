import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCosting } from './costing-engine.js';
import {
  parsePaste, rankHistory, closestComparison, batchExportSpec, valueFromSaved, blankValue, stillNeeded, coatingWords, perUnit,
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
  assert.equal(coatingWords(6), '₹1 per 600 sq in');
  assert.equal(coatingWords(''), 'No coating');
  assert.equal(perUnit(3.1415926), '₹3.142');
  assert.equal(perUnit(null), '—');
});
