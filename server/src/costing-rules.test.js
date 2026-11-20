// House rules for a new costing (owner, 11 Nov 2026) and leafing in the engine. Invented products and figures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCosting } from './costing-engine.js';
import { computeCosting as clientCompute } from '../../client/src/lib/costing.js';
import { HOUSE_RULES, coatingFromText, finishFromEnquiry, dpFor, processFor, houseRuleValues, ruleInputsForRow, newDieDefault, masterDieOf,
  isCfbbBoard, customerBoardRate, cleanCustomerRates, chargeRateOf, chargeGrades, withRunWastage, assumedValues } from '../../client/src/lib/costingRules.js';
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
  assert.equal(dpFor('LOCK'), 0.4);
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
  assert.equal(r.inputs.dp_rate, 0.4);
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

test('Met Saffire: its own ₹120, coated at 1.5 whatever the finish words say', async () => {
  const { isMetSaffire, chargeGrades } = await import('../../client/src/lib/costingRules.js');
  assert.ok(isMetSaffire('Met Saffire'));
  assert.ok(isMetSaffire('MET SAPPHIRE 300'));
  assert.ok(isMetSaffire('metallic saffire'));
  assert.ok(!isMetSaffire('Saffire'));
  assert.ok(!isMetSaffire('ITC Cyber XL'));
  assert.equal(chargeGrades([{ grade: 'Met Saffire', rate_per_kg: 100 }])[0].rate_per_kg, 120);
  const asMap = xs => Object.fromEntries(xs.map(([k, v]) => [k, v]));
  const byGrade = asMap(houseRuleValues({ style: 'LOCK', board_grade: 'Met Saffire' }, { finish: finishFromEnquiry({ coating: 'Spot UV + drip off' }) }));
  assert.equal(byGrade.coat_factor, 1.5);
  assert.equal(byGrade.coat_choice, '1.5');
  assert.equal(asMap(houseRuleValues({}, { finish: finishFromEnquiry({ board: 'Met Saffire', coating: 'UV' }) })).coat_factor, 1.5);
  assert.equal(asMap(houseRuleValues({}, { productGrade: 'MET' })).coat_factor, undefined, 'the master alias "MET" alone is not read as Met Saffire here');
  assert.equal(ruleInputsForRow({ style: 'LOCK' }, null, null, 'Met Saffire').coat_choice, '1.5');
  // recommend: picking the grade refills the coating from the rule.
  const v = recommend({ product_name: 'X', size_text: '', style: 'LOCK', board_grade: 'Met Saffire', inputs: {}, sources: { board_grade: { kind: 'manual' } } }, {});
  assert.equal(v.coat_choice, '1.5');
  assert.equal(v.inputs.coat_factor, 1.5);
});

// Owner, 17 Nov 2026 ("Die Master only"): a Die Master die of exactly this size means no new die; a die only on the
// die list (2024 list, Drive drawings) does not — nobody has confirmed it is still in the rack. A hand-set tick wins.
test('New die: off by itself for a Die Master die of this size, never for a die-list die; a hand-set tick wins', () => {
  assert.equal(newDieDefault({}), true);
  assert.equal(newDieDefault({}, { masterDie: 'D-1' }), false);
  assert.equal(newDieDefault({ new_die: true }, { masterDie: 'D-1' }), true);
  assert.equal(newDieDefault({ product_id: 7 }), false);
  const asMap = xs => Object.fromEntries(xs.map(([k, v, note]) => [k, [v, note]]));
  assert.deepEqual(asMap(houseRuleValues({ style: 'LOCK' }, { masterDie: 'D-1' })).process, [2000, 'existing die (Die Master D-1) — ₹2,000']);
  assert.deepEqual(asMap(houseRuleValues({ style: 'LOCK', new_die: true }, { masterDie: 'D-1' })).process, [3000, 'new die — ₹3,000']);
  assert.equal(asMap(houseRuleValues({ style: 'LOCK' })).process[0], 3000);

  const v = { style: 'LOCK', size_text: '92x80x66', inputs: {}, sources: {} };
  const lib = { exact: [] };
  assert.equal(recommend(v, { check: { library: lib, dies: { exact: [{ code: 'D-1' }], near: [] } } }).inputs.process, 2000);
  assert.equal(recommend(v, { check: { library: lib, dies: { exact: [] }, register: { exact: [{ die_no: 'J1', job_no: '1' }] } } }).inputs.process, 3000);
  assert.equal(recommend(v, { check: { library: lib, dies: { exact: [], near: [{ code: 'D-2' }] } } }).inputs.process, 3000);
  assert.equal(recommend({ ...v, new_die: true }, { check: { library: lib, dies: { exact: [{ code: 'D-1' }] } } }).inputs.process, 3000);
});

// A Die Master die the Tooling Hub would not release (Poor: lost or damaged; Scrapped) is no reason to skip a new die.
test('New die: only a usable Die Master die counts; a reopened costing keeps what it was saved with', () => {
  assert.equal(masterDieOf({ dies: { exact: [{ code: 'D-1', condition: 'Poor' }, { code: 'D-2', condition: 'Good' }] } }), 'D-2');
  assert.equal(masterDieOf({ dies: { exact: [{ code: 'D-1', condition: 'Scrapped' }, { code: 'D-3', condition: ' poor ' }] } }), null);
  assert.equal(masterDieOf({ dies: { exact: [{ code: 'D-4', condition: null }, { code: 'D-5', condition: 'Fair' }] } }), 'D-4');
  assert.equal(masterDieOf(null), null);
  const v = { style: 'LOCK', size_text: '92x80x66', inputs: {}, sources: {} };
  assert.equal(recommend(v, { check: { library: { exact: [] }, dies: { exact: [{ code: 'D-1', condition: 'Scrapped' }] } } }).inputs.process, 3000);
  const reopened = valueFromSaved({ size_key: '92x80x66', style: 'LOCK', inputs: { process: 3000 } });
  assert.equal(newDieDefault(reopened, { masterDie: 'D-2' }), true);
});

// The editor says which Die Master die counts (none in the bulk row editor), so the tick and the process never disagree.
test('recommend: the Die Master die the editor passes wins over the check', () => {
  const v = { style: 'LOCK', size_text: '92x80x66', inputs: {}, sources: {} };
  const check = { library: { exact: [] }, dies: { exact: [{ code: 'D-1', condition: 'Good' }] } };
  assert.equal(recommend(v, { check, masterDie: null }).inputs.process, 3000);
  assert.equal(recommend(v, { check }).inputs.process, 2000);
});

// Owner, 20 Nov 2026: the enquiry desk costs by itself, so the house figures moved and the CFBB family got customer rates.
const mapOf = xs => Object.fromEntries(xs.map(([k, v]) => [k, v]));
const RATES = [{ word: 'northwind', board_rate: 131 }, { word: 'pharma', board_rate: 99 }];

test('lock bottom is ₹0.40, side ₹0.20, big box ₹0.41', () => {
  assert.equal(dpFor('LOCK'), 0.4);
  assert.equal(dpFor('SIDE'), 0.2);
  assert.equal(dpFor('SIDE', true), 0.41);
});

test('spot UV with AQ is factor 2', () => {
  assert.deepEqual(coatingFromText('Spot UV + AQ varnish'), { factor: 2, label: 'Spot UV + AQ' });
  assert.equal(coatingFromText('spot uv on aqueous').factor, 2);
  assert.equal(coatingFromText('UV').factor, 3);
  assert.equal(coatingFromText('aqueous varnish').factor, 6);
  assert.equal(coatingFromText('drip off').factor, 2);
  assert.equal(coatingFromText('spot UV + drip off').factor, 2);
});

test('Met Saffire: its own ₹120, coated at 1.5', () => {
  assert.equal(chargeGrades([{ grade: 'Met Saffire', rate_per_kg: 100 }], 107)[0].rate_per_kg, 120);
  assert.equal(mapOf(houseRuleValues({}, { productGrade: 'Met Saffire' })).coat_factor, 1.5);
});

test('Saffire, ITC Cyber and FBB are costed as CFBB; metallic, duplex and SBS are not', () => {
  const grade = board => mapOf(houseRuleValues({}, { finish: { board } })).board_grade;
  assert.equal(grade('ITC Cyber XL'), 'CFBB');
  assert.equal(grade('SAPPHIRE 300'), 'CFBB');
  assert.equal(grade('FBB'), 'CFBB');
  for (const b of ['Met Saffire', 'Duplex WB', 'SBS']) assert.equal(grade(b), undefined, b);
  assert.equal(mapOf(houseRuleValues({}, { finish: { board: 'FBB' }, productGrade: 'Saffire' })).board_grade, undefined);
  assert.ok(isCfbbBoard('ITC Cyber XL') && !isCfbbBoard('Met Saffire', 'FBB'));
});

test('customerBoardRate: first word wins, blank name has none', () => {
  assert.deepEqual(customerBoardRate('NORTHWIND Pharma Ltd', RATES), { word: 'northwind', rate: 131 });
  assert.equal(customerBoardRate('', RATES), null);
  assert.equal(customerBoardRate('Northwind', null), null);
  assert.equal(customerBoardRate('Bluefin Labs', RATES), null);
});

test("a customer's rate never goes below the buying rate", () => {
  assert.equal(chargeRateOf({ grade: 'CFBB', rate_per_kg: 100 }, 107), 107);
  assert.equal(chargeRateOf({ grade: 'CFBB', rate_per_kg: 112 }, 107), 112);
  assert.equal(chargeRateOf({ grade: 'Saffire', rate_per_kg: 81.5 }, 107), 107);
  assert.equal(chargeRateOf({ grade: 'Duplex WB', rate_per_kg: 51 }, 107), 51);
  assert.equal(chargeRateOf({ grade: 'CFBB', rate_per_kg: 100 }), 120);
  const gs = chargeGrades([{ grade: 'CFBB', rate_per_kg: 100 }], 107);
  assert.deepEqual([gs[0].rate_per_kg, gs[0].buy_rate], [107, 100]);
});

test('houseRuleValues: the CFBB board rate comes from the charged grade, with its note', () => {
  const grades = chargeGrades([{ grade: 'CFBB', rate_per_kg: 100 }], 131);
  const rate = houseRuleValues({}, { finish: { board: 'Saffire' }, grades, customerRate: { word: 'northwind', rate: 131 } }).find(x => x[0] === 'board_rate');
  assert.deepEqual(rate, ['board_rate', 131, '₹131/kg — the "northwind" customer rate']);
  const house = houseRuleValues({}, { finish: { board: 'Saffire' }, grades: chargeGrades([{ grade: 'CFBB', rate_per_kg: 100 }]) }).find(x => x[0] === 'board_rate');
  assert.deepEqual(house, ['board_rate', 120, 'house rate ₹120/kg']);
  // no CFBB grade given: the customer's rate, else the house rate
  assert.equal(mapOf(houseRuleValues({}, { finish: { board: 'FBB' }, customerRate: { word: 'bluefin', rate: 107 } })).board_rate, 107);
  assert.equal(mapOf(houseRuleValues({}, { finish: { board: 'FBB' } })).board_rate, 120);
  const met = houseRuleValues({}, { finish: { board: 'Met Saffire' }, grades: chargeGrades([{ grade: 'Met Saffire', rate_per_kg: 100 }], 107) }).find(x => x[0] === 'board_rate');
  assert.deepEqual(met, ['board_rate', 120, 'Met Saffire — its own rate']);
});

test('cleanCustomerRates keeps good rows only', () => {
  const out = cleanCustomerRates([
    { word: '  Northwind ', board_rate: 131 }, { word: '', board_rate: 100 }, { word: 'zero', board_rate: 0 },
    { word: 'huge', board_rate: 5000 }, { word: 'NORTHWIND', board_rate: 90 }, { word: 'x', board_rate: 90 }, { word: 'bluefin', board_rate: '107' },
  ]);
  assert.deepEqual(out, [{ word: 'Northwind', board_rate: 131 }, { word: 'bluefin', board_rate: 107 }]);
  assert.equal(cleanCustomerRates(Array.from({ length: 80 }, (_, i) => ({ word: `word${i}`, board_rate: 100 }))).length, 50);
  assert.deepEqual(cleanCustomerRates(null), []);
});

test('wastage follows the run when asked', () => {
  const on = mapOf(houseRuleValues({ inputs: { qty: 20000, ups: 6 } }, { byRun: true }));
  assert.equal(on.wastage, 300, '3,334 sheets');
  assert.equal(on.wastage_by_run, 1);
  assert.ok(!houseRuleValues({ inputs: { qty: 20000, ups: 6 } }, {}).some(x => x[0] === 'wastage'));
});

test('withRunWastage refreshes only a run-following wastage', () => {
  assert.equal(withRunWastage({ qty: 40000, ups: 6, wastage: 300, wastage_by_run: 1 }).wastage, 400);
  const typed = { qty: 40000, ups: 6, wastage: 300, wastage_by_run: '' };
  assert.deepEqual(withRunWastage(typed), typed);
});

test('assumed coating, GSM and colours are only for enquiry costings', () => {
  const a = assumedValues({ enquiry_id: 5, inputs: {}, coat_choice: '' }, { defaults: { colours: 4 } });
  assert.deepEqual(a, [
    ['coat_factor', 3, 'coating not given — UV, the most used'], ['coat_choice', '3', 'coating not given — UV, the most used'],
    ['gsm', 300, 'GSM not given — 300, the most used'], ['colours', 4, 'colours not given — the Rates default']]);
  assert.deepEqual(assumedValues({ inputs: {} }), []);
});

test('ruleInputsForRow hands the CFBB board grade back beside coat_choice, never inside inputs', () => {
  const r = ruleInputsForRow({ style: 'LOCK' }, { board: 'Saffire' });
  assert.equal(r.inputs.board_grade, undefined);
  assert.equal(r.board_grade, 'CFBB');
  assert.equal(ruleInputsForRow({ style: 'LOCK' }, { board: 'Duplex WB' }).board_grade, null);
  assert.equal(ruleInputsForRow({ style: 'LOCK' }, null).board_grade, null);
});
