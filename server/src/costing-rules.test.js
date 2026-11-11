// House rules for a new costing (owner, 11 Nov 2026) and leafing in the engine. Invented products and figures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCosting } from './costing-engine.js';
import { computeCosting as clientCompute } from '../../client/src/lib/costing.js';
import { HOUSE_RULES, coatingFromText, finishFromEnquiry, dpFor, processFor, houseRuleValues, ruleInputsForRow } from '../../client/src/lib/costingRules.js';
import { recommend, valueFromSaved } from '../../client/src/lib/costingUi.js';
import { costingValueFromEnquiry, bulkSeedFromEnquiry } from '../../client/src/lib/enquiryUi.js';

const JOB = { qty: 4000, sheet_l: 15, sheet_w: 25, ups: 8, gsm: 300, board_rate: 120, wastage: 250, colours: 4, print_rate: 500, print_min: 1600,
  coat_factor: 2, dp_rate: 0.2, process: 2000, pf_pct: 5, misc_pct: 0, emb_rate: 0.15, margin: 0.05 };

test('coating words map to the house factors', () => {
  assert.equal(coatingFromText('Aqueous varnish').factor, 6);
  assert.equal(coatingFromText('AQ varnish').factor, 6);
  assert.equal(coatingFromText('aqua varnish').factor, 6);
  assert.equal(coatingFromText('Full UV').factor, 3);
  assert.equal(coatingFromText('Drip off with UV').factor, 2);
  assert.equal(coatingFromText('Spot UV, full drip-off').factor, 2);
  assert.equal(coatingFromText('Full drip-off + design spot UV').label, 'Spot UV + drip-off');
  assert.equal(coatingFromText(''), null);
  assert.equal(coatingFromText('lamination'), null);
});

test('the enquiry finish: embossing and leafing from its words', () => {
  const f = finishFromEnquiry({ enquiry_no: 'CI-ENQ-9001', coating: 'Spot UV, full drip-off', specs: 'Name & logo embossed; tuck-in' });
  assert.equal(f.coat.factor, 2);
  assert.equal(f.emboss, true);
  assert.equal(f.leaf, false);
  assert.equal(finishFromEnquiry({ specs: 'no embossing' }).emboss, false);
  const leaf = finishFromEnquiry({ specs: 'gold foil on 2 panels' });
  assert.equal(leaf.leaf, true);
  assert.equal(leaf.leaf_panels, 2);
  assert.equal(finishFromEnquiry({ specs: 'hot stamping' }).leaf_panels, 1);
});

test('die & pasting and process follow the rules', () => {
  assert.equal(dpFor('SIDE'), 0.2);
  assert.equal(dpFor('LOCK'), 0.3);
  assert.equal(dpFor('LOCK', true), 0.41);
  assert.equal(dpFor('LIT'), null);
  assert.equal(processFor(false), 2000);
  assert.equal(processFor(true), 3000);
});

test('rule values: a new product needs a new die; existing does not', () => {
  const asMap = xs => Object.fromEntries(xs.map(([k, v]) => [k, v]));
  assert.equal(asMap(houseRuleValues({ style: 'LOCK' })).process, 3000);
  assert.equal(asMap(houseRuleValues({ style: 'LOCK', product_id: 7 })).process, 2000);
  assert.equal(asMap(houseRuleValues({ style: 'LOCK', product_id: 7, new_die: true })).process, 3000);
  assert.equal(asMap(houseRuleValues({ style: 'SIDE', big_box: true })).dp_rate, 0.41);
  assert.equal(asMap(houseRuleValues({}, { finish: { emboss: false } })).emb_rate, 0);
  assert.equal(asMap(houseRuleValues({}, { productEmboss: 1 })).emb_rate, 0.15);
});

test('recommend: the rules come before past costings, after the Product Master grade', () => {
  const e = { id: 1, enquiry_no: 'CI-ENQ-9002', customer_name: 'Acme Pharma', product_name: 'TESTO 10 TAB CARTON', size_key: '85x37x50', style: 'SIDE',
    gsm: 300, colours: 5, coating: 'Full drip-off + design spot UV', specs: 'logo embossed', quantities: [4100] };
  const v = costingValueFromEnquiry(e, { print_rate: 500, wastage: 250 });
  const history = [{ costing_no: 'CI-CST-0001', style: 'SIDE', gsm: 300, qty: 4000, costed_on: '2026-10-01',
    inputs: { ...JOB, dp_rate: 0.35, emb_rate: 0, coat_factor: 6, board_rate: 98, process: 4000 }, result: computeCosting({ ...JOB, dp_rate: 0.35 }) }];
  const r = recommend(v, { check: { history, library: { exact: [] } }, defaults: { print_rate: 500, wastage: 250, process: 2000 } });
  assert.equal(r.inputs.colours, 5, 'colours as the enquiry says');
  assert.equal(r.inputs.dp_rate, 0.2);
  assert.equal(r.inputs.emb_rate, 0.15);
  assert.equal(r.inputs.coat_factor, 2);
  assert.equal(r.coat_choice, '2');
  assert.equal(r.inputs.board_rate, 120);
  assert.equal(r.inputs.process, 3000);
  assert.equal(r.inputs.print_rate, 500);
  assert.equal(r.sources.dp_rate.kind, 'rule');
  // A grade on the Product Master keeps its own rate.
  const p = { id: 9, name: 'TESTO 10 TAB CARTON', board_grade: 'Saffire', emboss: 0, gsm: 300 };
  const withP = recommend({ ...v, product: p, product_id: 9 }, { product: p, grades: [{ grade: 'Saffire', rate_per_kg: 104 }], check: { history, library: { exact: [] } } });
  assert.equal(withP.inputs.board_rate, 104);
  assert.equal(withP.inputs.emb_rate, 0, 'the master says not embossed');
  assert.equal(withP.inputs.process, 2000, 'an existing product, existing die');
});

test('recommend never overwrites a typed box', () => {
  const v = { product_name: 'X', size_text: '', style: 'LOCK', inputs: { dp_rate: 0.5 }, sources: { dp_rate: { kind: 'manual' } } };
  assert.equal(recommend(v, {}).inputs.dp_rate, 0.5);
});

test('bulk rows from an enquiry take the coating, embossing and process rules', () => {
  const seed = bulkSeedFromEnquiry({ id: 2, enquiry_no: 'CI-ENQ-9003', product_name: 'A', size_key: '120x62x70', style: 'LOCK', coating: 'AQ varnish', specs: 'embossed', quantities: [2000] });
  const r = ruleInputsForRow({ style: seed.style }, seed.finish);
  assert.equal(r.coat_choice, '6');
  assert.equal(r.inputs.coat_factor, 6);
  assert.equal(r.inputs.emb_rate, 0.15);
  assert.equal(r.inputs.process, 3000);
  assert.equal(r.inputs.dp_rate, 0.3);
});

test('leafing: per panel per carton after P&F, set-up into the subtotal', () => {
  const base = computeCosting(JOB);
  const leafed = computeCosting({ ...JOB, leaf_panels: 2, leaf_rate: HOUSE_RULES.leaf_rate, leaf_process: HOUSE_RULES.leaf_process });
  const setup = 5000 * 1.05 / JOB.qty;
  assert.ok(Math.abs(leafed.cost_per_unit - (base.cost_per_unit + 0.4 + setup)) < 1e-9);
  assert.ok(leafed.lines.some(l => l.key === 'leaf'));
  assert.ok(leafed.lines.some(l => l.key === 'leaf_process'));
  assert.ok(Math.abs(leafed.split.fixed - base.split.fixed - 5000 * 1.05) < 1e-6, 'leafing set-up is set-up cost');
  // No panels: no leafing, whatever the rate boxes hold.
  assert.equal(computeCosting({ ...JOB, leaf_rate: 0.2, leaf_process: 5000 }).cost_per_unit, base.cost_per_unit);
  assert.deepEqual(clientCompute({ ...JOB, leaf_panels: 2, leaf_rate: 0.2, leaf_process: 5000 }), leafed);
});

test('an old costing without leafing reworks to the same lines', () => {
  const r = computeCosting(JOB);
  assert.ok(!r.lines.some(l => l.key.startsWith('leaf')));
  assert.equal(r.parts.leaf_total, undefined);
});

test('the New die / Big box ticks read back from a saved costing', () => {
  const v = valueFromSaved({ inputs: { ...JOB, process: 3000, dp_rate: 0.41 } });
  assert.equal(v.new_die, true);
  assert.equal(v.big_box, true);
  const w = valueFromSaved({ inputs: JOB });
  assert.equal(w.new_die, false);
  assert.equal(w.big_box, false);
});

test('a costing charges FBB-type grades ₹120; the buying rate is kept beside it, other grades unchanged', async () => {
  const { chargeGrades, chargeRateOf, gradeLabel } = await import('../../client/src/lib/costingRules.js');
  const gs = chargeGrades([{ grade: 'CFBB', rate_per_kg: 100 }, { grade: 'Duplex GB', rate_per_kg: 44 }, { grade: 'Chromo Paper', rate_per_kg: 80 }, { grade: 'Saffire', rate_per_kg: 130 }]);
  assert.deepEqual(gs.map(g => g.rate_per_kg), [120, 44, 80, 130], 'a buying rate above ₹120 is charged as bought');
  assert.equal(gs[0].buy_rate, 100);
  assert.equal(gradeLabel(gs[0]), 'CFBB — ₹120/kg charged (buy ₹100)');
  assert.equal(gradeLabel(gs[1]), 'Duplex GB — ₹44/kg');
  assert.equal(chargeRateOf({ grade: 'Cupstock', rate_per_kg: 110 }), 110);
  assert.deepEqual(chargeGrades(gs).map(g => g.rate_per_kg), [120, 44, 80, 130], 'mapping twice changes nothing');
});
