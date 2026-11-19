import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseReading, matchKit, namedKits, innerFor, mrpDropTooBig, mrpRiseTooBig, holdsFor, contentsDiffer, payloadFor } from './fluence-mail-rules.js';
import { mrpText } from '../../client/src/lib/fluence.js';

// The rules for Fluence readings (18 Nov 2026). Invented kits and items.
const raw = {
  kit_name: ' Zeta Glow Kit-Q ', kit_code: 'fp-901',
  prescription: { general_instructions: ' Take after food. ', lines: [
    { item: 'F-ZETA CAPS', dosage: '1 cap', morning: '1', night: 1, instructions: 'with water' },
    { item: 'F-GLOW GEL', other_timing: 'at bedtime', other_qty: '1', instructions: 'apply thin layer' },
    { item: '', dosage: '' },
  ] },
  mrp: { kit_total: '₹ 1,250.00', items: [{ item: 'F-ZETA CAPS', qty: '1', mrp: '850' }, { item: 'F-GLOW GEL', mrp: 400 }] },
  sure: true, unsure: [],
};

test('a reading is cleaned: names trimmed, money and counts made numbers, empty lines dropped, unsure by default', () => {
  const r = normaliseReading(raw);
  assert.equal(r.kit_name, 'Zeta Glow Kit-Q');
  assert.equal(r.kit_code, 'FP-901');
  assert.equal(r.prescription.general_instructions, 'Take after food.');
  assert.equal(r.prescription.lines.length, 2);
  assert.deepEqual([r.prescription.lines[0].morning_qty, r.prescription.lines[0].night_qty], [1, 1]);
  assert.equal(r.prescription.lines[1].other_qty, 1);
  assert.equal(r.mrp.kit_total, 1250);
  assert.deepEqual(r.mrp.items.map(i => [i.item, i.qty, i.mrp]), [['F-ZETA CAPS', 1, 850], ['F-GLOW GEL', null, 400]]);
  assert.equal(r.sure, true);
  assert.equal(normaliseReading({ kit_name: 'x' }).sure, false, 'a reading that does not say it is sure is not');
  assert.equal(normaliseReading({ ...raw, mrp: { kit_total: 'abc' } }).sure, false, 'a money figure that cannot be read makes it unsure');
});

test('the kit: by FP code first, then the artwork job\'s product, then one kit of that exact name — never a guess', () => {
  const kits = [
    { id: 1, kit_name: 'ZETA GLOW KIT Q', product_id: 10, product_code: 'FP-901' },
    { id: 2, kit_name: 'Beta Kit', product_id: 11, product_code: 'FP-902' },
    { id: 3, kit_name: 'Beta Kit', product_id: 12, product_code: 'FP-903' },
    { id: 4, kit_name: 'Old Kit', product_id: 13, product_code: 'FP-904', superseded_by_kit_id: 9 },
  ];
  assert.equal(matchKit({ kit_code: 'FP-902', kit_name: 'anything' }, { kits }).id, 2);
  assert.equal(matchKit({ kit_name: 'zeta glow kit-q' }, { kits }).id, 1);
  assert.equal(matchKit({ kit_name: 'Beta Kit' }, { kits }), null, 'two kits of one name: no guess');
  assert.equal(namedKits({ kit_name: 'beta kit' }, kits).length, 2, 'and it can be told apart from "none"');
  assert.equal(namedKits({ kit_name: 'Nothing like it' }, kits).length, 0);
  assert.equal(matchKit({ kit_name: 'Beta Kit' }, { kits, productKitId: 3 }).id, 3, 'the kit the artwork job\'s product reads decides');
  assert.equal(matchKit({ kit_name: 'Old Kit' }, { kits }), null, 'a superseded kit is not matched by name');
  assert.equal(matchKit({ kit_name: 'Nothing like it' }, { kits }), null);
});

test('an item by its name to the inner product list; unknown → null', () => {
  const inners = [{ id: 7, name: 'F-ZETA CAPS' }, { id: 8, name: 'F GLOW GEL' }];
  assert.equal(innerFor('f-zeta caps', inners), 7);
  assert.equal(innerFor('F-GLOW-GEL', inners), 8);
  assert.equal(innerFor('F-NEW ITEM', inners), null);
});

test('an MRP more than 25 % lower is too big a drop; a rise, or no old figure, is not', () => {
  assert.equal(mrpDropTooBig(1000, 749), true);
  assert.equal(mrpDropTooBig(1000, 750), false);
  assert.equal(mrpDropTooBig(1000, 1200), false);
  assert.equal(mrpDropTooBig(null, 10), false);
});

test('holds: unsure fields, a big MRP drop (kit total or item), a person\'s later change — each said in words', () => {
  const r = normaliseReading(raw);
  const master = { kit_total_mrp: 1300, components: [{ inner_product_id: 7, name: 'F-ZETA CAPS', mrp_in_kit: 1200 }, { inner_product_id: 8, name: 'F GLOW GEL', mrp_in_kit: 380 }] };
  const h = holdsFor({ reading: r, master, innerIdOf: n => ({ 'F-ZETA CAPS': 7, 'F-GLOW GEL': 8 }[n]), personChangedAfterMail: null });
  assert.deepEqual(h, ['F-ZETA CAPS MRP 1200 → 850 is more than 25 % lower']);
  const unsure = holdsFor({ reading: normaliseReading({ ...raw, sure: false, unsure: ['prescription.lines.1.dosage'] }), master: { components: [] }, innerIdOf: () => null });
  assert.match(unsure[0], /not sure of: prescription\.lines\.1\.dosage/);
  const later = holdsFor({ reading: r, master: { components: [] }, innerIdOf: () => null, personChangedAfterMail: { by: 'Anik', at: '2026-11-02T06:00:00Z' } });
  assert.match(later.at(-1), /changed by Anik after this mail/);
  assert.match(holdsFor({ reading: normaliseReading({ ...raw, mrp: { kit_total: 900, items: [] } }), master: { kit_total_mrp: 1300, components: [] }, innerIdOf: () => null })[0], /kit MRP 1300 → 900/);
});

test('the save: an artwork reading sets the kit\'s items and prescription; an MRP-only reading keeps the prescription as it is', () => {
  const r = normaliseReading(raw);
  const masterRx = { general_instructions: 'Old', lines: [{ inner_product_id: 7, dosage: '2 caps', morning_qty: 2 }] };
  const masterComps = [{ inner_product_id: 7, qty_per_kit: 2, mrp_in_kit: 800 }];
  const p = payloadFor(r, { masterComponents: masterComps, masterRx, innerIdOf: n => ({ 'F-ZETA CAPS': 7, 'F-GLOW GEL': 8 }[n]) });
  assert.deepEqual(p.components.map(c => [c.inner_product_id, c.qty_per_kit, c.mrp_in_kit]), [[7, 2, 850], [8, 1, 400]], 'the master\'s quantity is kept');
  assert.equal(p.general_instructions, 'Take after food.');
  assert.deepEqual(p.lines.map(l => [l.inner_product_id, l.dosage, l.morning_qty]), [[7, '1 cap', 1], [8, null, null]]);
  const sheet = normaliseReading({ kit_name: 'Zeta', mrp: { kit_total: 1300, items: [{ item: 'F-ZETA CAPS', mrp: 900 }] }, sure: true });
  const q = payloadFor(sheet, { masterComponents: masterComps, masterRx, innerIdOf: n => ({ 'F-ZETA CAPS': 7 }[n]) });
  assert.deepEqual(q.components.map(c => [c.inner_product_id, c.qty_per_kit, c.mrp_in_kit]), [[7, 2, 900]]);
  assert.equal(q.general_instructions, 'Old');
  assert.deepEqual(q.lines.map(l => [l.inner_product_id, l.dosage]), [[7, '2 caps']]);
});

test('cleaning a reading twice changes nothing (it is stored clean and read back)', () => {
  const once = normaliseReading(raw);
  assert.deepEqual(normaliseReading(once), once);
});

// ── the review of 18 Nov 2026 ───────────────────────────────────────────────────────────────────────────────────
test('money as Indian price lists write it: "Rs. 450/-" is 450', () => {
  const r = normaliseReading({ kit_name: 'K', sure: true, mrp: { kit_total: 'Rs. 1,250/-', items: [{ item: 'A', mrp: '₹ 450/-' }] } });
  assert.equal(r.mrp.kit_total, 1250);
  assert.equal(r.mrp.items[0].mrp, 450);
  assert.equal(r.sure, true);
});

test('a prescription read with no lines, or a line with no item, is unsure — never "the kit is empty"', () => {
  const empty = normaliseReading({ kit_name: 'K', sure: true, prescription: { lines: [] } });
  assert.equal(empty.sure, false);
  assert.ok(empty.unsure.includes('prescription.lines'));
  const noItem = normaliseReading({ kit_name: 'K', sure: true, prescription: { lines: [{ item: 'A', dosage: '1' }, { name: 'B', dosage: '2 caps' }] } });
  assert.equal(noItem.sure, false);
  assert.ok(noItem.unsure.includes('prescription.lines.1.item'));
  const priceNoItem = normaliseReading({ kit_name: 'K', sure: true, mrp: { items: [{ mrp: 400 }] } });
  assert.ok(priceNoItem.unsure.includes('mrp.items.0.item'));
});

test('an MRP more than double is too big a rise (a misread decimal point); no old figure is not', () => {
  assert.equal(mrpRiseTooBig(1183.5, 118350), true);
  assert.equal(mrpRiseTooBig(1000, 2000), false);
  assert.equal(mrpRiseTooBig(1000, 2001), true);
  assert.equal(mrpRiseTooBig(null, 5000), false);
});

test('holds read the carton\'s own MRP too: a drop against it, a master that disagrees with itself, a rise past double', () => {
  const r = total => normaliseReading({ kit_name: 'K', sure: true, mrp: { kit_total: total, items: [] } });
  const none = () => null;
  assert.match(holdsFor({ reading: r(850), master: { kit_total_mrp: 1000, carton_mrp: 1200, components: [] }, innerIdOf: none })[0],
    /carton MRP 1200 → 850 is more than 25 % lower/);
  assert.match(holdsFor({ reading: r(1100), master: { kit_total_mrp: 1000, carton_mrp: 1200, components: [] }, innerIdOf: none }).join(' '),
    /carton MRP 1200 and the kit total 1000 already disagree/);
  assert.deepEqual(holdsFor({ reading: r(1200), master: { kit_total_mrp: 1000, carton_mrp: 1200, components: [] }, innerIdOf: none }), [],
    'a reading that says what the carton says settles the kit total');
  assert.match(holdsFor({ reading: r(2500), master: { kit_total_mrp: 1000, carton_mrp: 1000, components: [] }, innerIdOf: none })[0],
    /kit MRP 1000 → 2500 is more than double/);
  const item = normaliseReading({ kit_name: 'K', sure: true, mrp: { items: [{ item: 'A', mrp: 990 }] } });
  assert.match(holdsFor({ reading: item, master: { components: [{ inner_product_id: 7, mrp_in_kit: 99 }] }, innerIdOf: () => 7 })[0], /A MRP 99 → 990 is more than double/);
});

test('an artwork for a kit we have: a printed item not in the kit, or a kit item not printed, holds it — packaging is never printed', () => {
  const kit = [{ inner_product_id: 7, name: 'F-ZETA CAPS', kind: 'item' }, { inner_product_id: 8, name: 'F GLOW GEL', kind: 'item' }, { inner_product_id: 9, name: 'INNER BOX', kind: 'packaging' }];
  const ids = { 'F-ZETA CAPS': 7, 'F-GLOW GEL': 8, 'F-ZETA CAPSULES': 70 };
  const art = lines => normaliseReading({ kit_name: 'Zeta', sure: true, prescription: { lines } });
  assert.deepEqual(contentsDiffer(art([{ item: 'F-ZETA CAPS' }, { item: 'F-GLOW GEL' }]), { masterComponents: kit, innerIdOf: n => ids[n] ?? null }), [],
    'every item printed, the inner box need not be');
  const swapped = contentsDiffer(art([{ item: 'F-ZETA CAPSULES' }, { item: 'F-GLOW GEL' }]), { masterComponents: kit, innerIdOf: n => ids[n] ?? null });
  assert.match(swapped.join(' '), /printed F-ZETA CAPSULES, which is not in this kit/);
  assert.match(swapped.join(' '), /the kit has F-ZETA CAPS, which the artwork does not print/);
  assert.deepEqual(contentsDiffer(normaliseReading({ kit_name: 'Zeta', sure: true, mrp: { kit_total: 900, items: [] } }), { masterComponents: kit, innerIdOf: () => null }), [],
    'an MRP-only reading says nothing of the contents');
});

test('the save for a kit we have: its items, quantities and packaging stay; printed lines take their item\'s place, keeping what was not printed', () => {
  const masterComponents = [
    { inner_product_id: 7, qty_per_kit: 2, mrp_in_kit: 600, remarks: 'strip', kind: 'item' },
    { inner_product_id: 8, qty_per_kit: 1, mrp_in_kit: 400, remarks: null, kind: 'item' },
    { inner_product_id: 9, qty_per_kit: 1, mrp_in_kit: null, remarks: null, kind: 'packaging' },
  ];
  const masterRx = { general_instructions: 'Old', remarks: 'keep me', lines: [
    { inner_product_id: 7, dosage: '1 cap', dose_form: 'capsule', pack_count: 10, morning_qty: 1, night_qty: 1, instructions: 'with water', remarks: 'r7' },
    { inner_product_id: 8, dosage: '5 ml', dose_form: 'gel', night_qty: 1 },
    { inner_product_id: 9 },
    { inner_product_id: null, item_label: 'Diet', instructions: 'no sugar' },
  ] };
  const ids = { 'F-ZETA CAPS': 7, 'F-GLOW GEL': 8 };
  const reading = normaliseReading({ kit_name: 'Zeta', sure: true,
    prescription: { general_instructions: 'Take after food.', lines: [{ item: 'F-ZETA CAPS', dosage: '2 caps', morning: 2 }, { item: 'F-GLOW GEL', instructions: 'thin layer' }] },
    mrp: { kit_total: 1100, items: [{ item: 'F-ZETA CAPS', mrp: 660 }] } });
  const p = payloadFor(reading, { masterComponents, masterRx, innerIdOf: n => ids[n] ?? null });
  assert.deepEqual(p.components.map(c => [c.inner_product_id, c.qty_per_kit, c.mrp_in_kit, c.remarks]), [[7, 2, 660, 'strip'], [8, 1, 400, null], [9, 1, null, null]]);
  assert.equal(p.general_instructions, 'Take after food.');
  assert.equal(p.remarks, 'keep me', 'the prescription\'s own remarks are never wiped');
  const l7 = p.lines.find(l => l.inner_product_id === 7);
  assert.deepEqual([l7.dosage, l7.morning_qty, l7.night_qty, l7.dose_form, l7.pack_count, l7.instructions, l7.remarks], ['2 caps', 2, null, 'capsule', 10, 'with water', 'r7'],
    'the printed timings are the whole dosing; what the artwork does not print is kept');
  const l8 = p.lines.find(l => l.inner_product_id === 8);
  assert.deepEqual([l8.dosage, l8.night_qty, l8.instructions, l8.dose_form], ['5 ml', 1, 'thin layer', 'gel'], 'no timing printed: the master\'s timing stays');
  assert.ok(p.lines.some(l => l.inner_product_id === 9), 'the inner box keeps its line');
  assert.ok(p.lines.some(l => l.item_label === 'Diet'), 'a line for no item stays');
  const sheet = payloadFor(normaliseReading({ kit_name: 'Zeta', sure: true, mrp: { items: [{ item: 'F-ZETA CAPS', mrp: 700 }] } }), { masterComponents, masterRx, innerIdOf: n => ids[n] ?? null });
  assert.equal(sheet.remarks, 'keep me');
  assert.deepEqual(sheet.lines, masterRx.lines.map(l => ({ ...l })));
});

test('the save for a kit the reading makes: the printed items, as printed', () => {
  const reading = normaliseReading({ kit_name: 'New', sure: true,
    prescription: { general_instructions: 'Daily.', lines: [{ item: 'A', dosage: '1', morning: 1 }, { item: 'B', night: 1 }] },
    mrp: { kit_total: 500, items: [{ item: 'A', qty: 2, mrp: 300 }, { item: 'B', mrp: 200 }] } });
  const p = payloadFor(reading, { masterComponents: [], masterRx: null, innerIdOf: n => ({ A: 1, B: 2 }[n]), creating: true });
  assert.deepEqual(p.components.map(c => [c.inner_product_id, c.qty_per_kit, c.mrp_in_kit]), [[1, 2, 300], [2, 1, 200]]);
  assert.deepEqual(p.lines.map(l => [l.inner_product_id, l.dosage, l.morning_qty, l.night_qty]), [[1, '1', 1, null], [2, null, null, 1]]);
});

test('MRPs on the screen keep their paise', () => {
  assert.equal(mrpText(188.64), '₹188.64');
  assert.equal(mrpText(1250), '₹1,250');
  assert.equal(mrpText(null), '—');
});
