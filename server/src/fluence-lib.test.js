import { test } from 'node:test';
import assert from 'node:assert/strict';
// Shared with the client (drawer, job card print) — the one formatter and
// validator for a Fluence prescription.
import {
  nameKey, qtyValue, qtyText, unitFor, timingParts, formatSchedule, formatRxLine,
  lineHasDose, rxHasContent, normaliseRxPayload, normaliseComponentsPayload,
  normaliseDims, formatDims, kitListPrice, partLabel, kitCartons, rxState, RX_SLOTS, FLUENCE_CONTEXTS, REVIEW_CONTEXTS,
  rxChangedAfterFinalise, RX_FROM_CUSTOMER_MASTER, rxLinesInStep, bareRxLine, componentsSignature, RX_LINE_KEYS, kitChangeSummary,
} from '../../client/src/lib/fluence.js';

test('nameKey: spacing, hyphens and case do not make two kits — a plus sign does', () => {
  assert.equal(nameKey('F1-O2'), 'F1O2');
  assert.equal(nameKey(' f1 o2 '), 'F1O2');
  assert.equal(nameKey('M9 - O2'), 'M9O2');
  assert.notEqual(nameKey('M9O2+'), nameKey('M9O2'));
  assert.equal(nameKey(null), '');
});

test('qtyValue: blank is "not entered", junk is NaN, numbers pass', () => {
  assert.equal(qtyValue(''), null);
  assert.equal(qtyValue('   '), null);
  assert.equal(qtyValue(null), null);
  assert.equal(qtyValue('2'), 2);
  assert.equal(qtyValue(0.5), 0.5);
  assert.ok(Number.isNaN(qtyValue('two')));
});

test('qtyText: no trailing zeros', () => {
  assert.equal(qtyText(1), '1');
  assert.equal(qtyText('0.50'), '0.5');
  assert.equal(qtyText(null), '');
});

test('unitFor: counts tablets, leaves ml alone, never invents a unit', () => {
  assert.equal(unitFor('Tablet', 1), 'tablet');
  assert.equal(unitFor('Tablet', 2), 'tablets');
  assert.equal(unitFor('Drops', 1), 'drop');
  assert.equal(unitFor('Drops', 3), 'drops');
  assert.equal(unitFor('ml', 5), 'ml');
  assert.equal(unitFor('', 1), '');
  assert.equal(unitFor(null, 2), '');
});

test('timingParts: day order, zero and blank slots are not doses', () => {
  const parts = timingParts({ night_qty: 2, morning_qty: '1', afternoon_qty: 0, evening_qty: '' });
  assert.deepEqual(parts, [{ label: 'Morning', qty: 1 }, { label: 'Night', qty: 2 }]);
  assert.deepEqual(timingParts({ other_timing: 'Before bed', other_qty: 1 }), [{ label: 'Before bed', qty: 1 }]);
  assert.deepEqual(timingParts({ other_timing: 'As needed' }), [{ label: 'As needed', qty: null }]);
  assert.deepEqual(timingParts(null), []);
});

test('formatSchedule: reads the way the brief writes it', () => {
  // "Morning — 1 tablet, Afternoon — 1 tablet, Night — 2 tablets"
  assert.equal(
    formatSchedule({ dose_form: 'Tablet', morning_qty: 1, afternoon_qty: 1, night_qty: 2 }),
    'Morning: 1 tablet + Afternoon: 1 tablet + Night: 2 tablets');
  // The gang table's compact form: "Morning: 1 + Night: 1"
  assert.equal(formatSchedule({ dose_form: 'Tablet', morning_qty: 1, night_qty: 1 }, { units: false }),
    'Morning: 1 + Night: 1');
  assert.equal(formatSchedule({}), '');
});

test('formatRxLine: item, dose, schedule, frequency, instructions — empty parts dropped', () => {
  assert.equal(
    formatRxLine({ dose_form: 'Capsule', morning_qty: 1, frequency: 'Once daily', instructions: 'After breakfast' }, 'F-TRICHO GOLD'),
    'F-TRICHO GOLD — Morning: 1 capsule · Once daily · After breakfast');
  assert.equal(formatRxLine({ item_label: 'Serum' }), 'Serum');
  assert.equal(formatRxLine({ dosage: 'Apply thin layer' }, ''), 'Apply thin layer');
});

test('rxHasContent: a copied item list is not yet a prescription', () => {
  assert.equal(rxHasContent({ lines: [{ item_label: 'F-CAL D3' }] }), false);
  assert.equal(rxHasContent({ lines: [{ item_label: 'F-CAL D3', night_qty: 1 }] }), true);
  assert.equal(rxHasContent({ lines: [], general_instructions: 'Take with water' }), true);
  assert.equal(rxHasContent(null), false);
  assert.equal(lineHasDose({ frequency: 'Once daily' }), true);
});

test('normaliseRxPayload: tidy lines, renumber, keep blanks as null', () => {
  const { errors, value } = normaliseRxPayload({
    general_instructions: '  Take after food ',
    lines: [
      { inner_product_id: '12', dose_form: 'Tablet', morning_qty: '1', night_qty: '', sr: 9 },
      { item_label: ' Hair serum ', other_timing: 'Night, on scalp' },
    ],
  });
  assert.deepEqual(errors, []);
  assert.equal(value.general_instructions, 'Take after food');
  assert.equal(value.lines[0].sr, 1);
  assert.equal(value.lines[0].inner_product_id, 12);
  assert.equal(value.lines[0].morning_qty, 1);
  assert.equal(value.lines[0].night_qty, null);
  assert.equal(value.lines[1].sr, 2);
  assert.equal(value.lines[1].item_label, 'Hair serum');
  assert.equal(value.lines[1].inner_product_id, null);
});

test('normaliseRxPayload: names the line and the field it refuses', () => {
  const { errors } = normaliseRxPayload({
    lines: [
      { morning_qty: 1 },                                  // no item
      { item_label: 'X', night_qty: 'two' },               // not a number
      { item_label: 'Y', afternoon_qty: -1 },              // negative
      { inner_product_id: 5, night_qty: 1 }, { inner_product_id: 5, night_qty: 2 }, // same item, same time
    ],
  });
  assert.ok(errors.some(e => e.startsWith('Line 1:') && /kit item/.test(e)), errors.join('\n'));
  assert.ok(errors.some(e => e.startsWith('Line 2:') && /night quantity must be a number/.test(e)), errors.join('\n'));
  assert.ok(errors.some(e => e.startsWith('Line 3:') && /afternoon quantity cannot be negative/.test(e)), errors.join('\n'));
  assert.ok(errors.some(e => /more than one line/.test(e)), errors.join('\n'));
});

test('normaliseRxPayload: one item on two different days is two lines — the same timing twice is not', () => {
  // SKIN FACT MELA - GOLD prints F-Glutasurge C as 1 lozenge Mon/Wed/Fri AND 2 on Sunday.
  const ok = normaliseRxPayload({ lines: [
    { inner_product_id: 7, other_timing: 'Monday, Wednesday & Friday', other_qty: 1, dose_form: 'Lozenge' },
    { inner_product_id: 7, other_timing: 'Sunday', other_qty: 2, dose_form: 'Lozenge' },
  ] });
  assert.deepEqual(ok.errors, []);
  const twice = normaliseRxPayload({ lines: [
    { inner_product_id: 7, other_timing: 'Sunday', other_qty: 1 },
    { inner_product_id: 7, other_timing: ' sunday ', other_qty: 2 },
  ] });
  assert.ok(twice.errors.some(e => /more than one line/.test(e)), twice.errors.join('\n'));
});

test('normaliseRxPayload: a product the customer master lists twice keeps both bare lines, in SR order', () => {
  // SKINFACT TIMELESS, Kit Lines SR 7 and SR 10: F-GLUTASURGE-C (id 7) — two units, no schedule.
  const master = normaliseRxPayload({ lines: [
    { inner_product_id: 3 }, { inner_product_id: 7 }, { inner_product_id: 4 }, { inner_product_id: 7 },
  ] });
  assert.deepEqual(master.errors, []);
  assert.deepEqual(master.value.lines.map(l => [l.sr, l.inner_product_id]), [[1, 3], [2, 7], [3, 4], [4, 7]]);
  // Once a schedule is written, the same product at the same time twice is still a duplicate…
  const sameTime = normaliseRxPayload({ lines: [{ inner_product_id: 7, morning_qty: 1 }, { inner_product_id: 7, morning_qty: 1 }] });
  assert.ok(sameTime.errors.some(e => /more than one line/.test(e)), sameTime.errors.join('\n'));
  // …while one timed line beside the master's bare line, or two different times, is not.
  assert.deepEqual(normaliseRxPayload({ lines: [{ inner_product_id: 7, morning_qty: 1 }, { inner_product_id: 7 }] }).errors, []);
  assert.deepEqual(normaliseRxPayload({ lines: [{ inner_product_id: 7, morning_qty: 1 }, { inner_product_id: 7, night_qty: 1 }] }).errors, []);
});

test('unitFor: lozenges are counted', () => {
  assert.equal(unitFor('Lozenge', 1), 'lozenge');
  assert.equal(unitFor('Lozenge', 2), 'lozenges');
});

test('normaliseRxPayload: every time slot is validated, not just the first', () => {
  for (const s of RX_SLOTS) {
    const { errors } = normaliseRxPayload({ lines: [{ item_label: 'X', [s.key]: 'abc' }] });
    assert.equal(errors.length, 1, `${s.key} was not validated`);
  }
});

test('normaliseComponentsPayload: quantity per kit is required and positive; no item twice', () => {
  assert.deepEqual(normaliseComponentsPayload({ components: [{ inner_product_id: 3, qty_per_kit: '2', mrp_in_kit: '109' }] }).errors, []);
  const bad = normaliseComponentsPayload({ components: [
    { inner_product_id: 3, qty_per_kit: 0 },
    { inner_product_id: 'x', qty_per_kit: 1 },
    { inner_product_id: 4 },
    { inner_product_id: 3, qty_per_kit: 1 },
  ] }).errors;
  assert.ok(bad.some(e => e.startsWith('Item 1:') && /more than zero/.test(e)), bad.join('\n'));
  assert.ok(bad.some(e => e.startsWith('Item 2:') && /inner product/.test(e)), bad.join('\n'));
  assert.ok(bad.some(e => e.startsWith('Item 3:') && /quantity per kit/.test(e)), bad.join('\n'));
  assert.ok(bad.some(e => /listed twice/.test(e)), bad.join('\n'));
  assert.deepEqual(normaliseComponentsPayload({}).errors, ['Components must be a list.']);
});

test('normaliseDims: unknown stays blank — never zero, never a guess', () => {
  assert.deepEqual(normaliseDims({ carton_l: '', carton_w: null }).value, { carton_l: null, carton_w: null, carton_h: null });
  assert.deepEqual(normaliseDims({ carton_l: '118', carton_w: 58, carton_h: '93' }).value, { carton_l: 118, carton_w: 58, carton_h: 93 });
  assert.equal(normaliseDims({ carton_l: 0 }).errors.length, 1);
  assert.equal(normaliseDims({ carton_h: 'tall' }).errors.length, 1);
});

test('formatDims: prints only when all three sides are known', () => {
  assert.equal(formatDims({ carton_l: 118, carton_w: 58, carton_h: 93 }), '118 × 58 × 93 mm');
  assert.equal(formatDims({ carton_l: 118, carton_w: 58, carton_h: null }), '');
  assert.equal(formatDims({}), '');
});

test('kitListPrice: an itemised kit shows its total; a flat-priced kit shows its line price, never a sum', () => {
  assert.deepEqual(kitListPrice({ kit_type: 'Itemised', kit_total_mrp: '3405' }, ['284', '205']), { kind: 'total', amount: 3405 });
  // Topico Mild to Moderate Melasma: ₹4,710 on each of 6 lines is the carton's
  // own MRP — the 6 × 4,710 = ₹28,260 "total" is not a price anywhere.
  const topico = { kit_type: 'Flat-priced', kit_total_mrp: '28260' };
  assert.deepEqual(kitListPrice(topico, Array(6).fill('4710.00')), { kind: 'per_line', amount: 4710 });
  // Lines that no longer agree (edited) → nothing, rather than a wrong figure.
  assert.equal(kitListPrice(topico, ['4710', '4000']), null);
  assert.equal(kitListPrice(topico, []), null);
  assert.equal(kitListPrice({ kit_type: 'Itemised', kit_total_mrp: null }, []), null);
  assert.equal(kitListPrice(null, ['1']), null);
});

test('partLabel: a part carton names what it is and its outer carton; any other carton says nothing', () => {
  assert.equal(partLabel({ part: 'leaflet', outer_code: 'FP-263' }), 'Leaflet of FP-263');
  assert.equal(partLabel({ part: 'inner box', outer_code: 'FP-263' }), 'Inner box of FP-263');
  assert.equal(partLabel({ part: 'tray' }), 'Tray');
  assert.equal(partLabel(null), '');
  assert.equal(partLabel({}), '');
});

test('kitCartons: the outer carton first, then its parts in order; a kit without parts lists none', () => {
  const parts = [{ product_id: 2, code: 'FP-264', part: 'filler' }, { product_id: 3, code: 'FP-266', part: 'leaflet' }];
  assert.deepEqual(kitCartons({ product_id: 1, code: 'FP-263' }, parts), [
    { product_id: 1, code: 'FP-263', part: 'outer carton' },
    { product_id: 2, code: 'FP-264', part: 'filler' },
    { product_id: 3, code: 'FP-266', part: 'leaflet' },
  ]);
  assert.deepEqual(kitCartons({ product_id: 1, code: 'FP-013' }, []), []);
  assert.deepEqual(kitCartons({ product_id: 1, code: 'FP-013' }, undefined), []);
  assert.deepEqual(kitCartons(null, parts), []);
});

test('rxState: nothing, the kit\'s products without a schedule, or a real prescription', () => {
  assert.equal(rxState(null), 'none');
  assert.equal(rxState({ lines: [] }), 'none');
  // The kit's products, put in from the kit list, days not on file.
  assert.equal(rxState({ lines: [{ item_name: 'F-CAL D3' }, { item_name: 'F-TRICHOGROW' }] }), 'items');
  assert.equal(rxState({ lines: [{ item_name: 'F-CAL D3', other_timing: 'Monday & Thursday', other_qty: 1 }] }), 'full');
  assert.equal(rxState({ lines: [], general_instructions: 'Take with water' }), 'full');
});

test('contexts: every review-first module is a known module', () => {
  for (const c of REVIEW_CONTEXTS) assert.ok(FLUENCE_CONTEXTS[c], `${c} is not a Fluence context`);
  for (const m of ['planning', 'artwork', 'job_card', 'print_planning', 'printing', 'sort_paste', 'invoice', 'dispatch', 'accounts', 'warehouse'])
    assert.ok(FLUENCE_CONTEXTS[m], `${m} missing`);
});

test('rxChangedAfterFinalise: only a person\'s save after finalising warns — never the customer master\'s list', () => {
  const card = '2026-09-15T12:06:33Z';
  const later = '2026-09-19T08:00:00Z';
  // Filled from the master (revision 1) or re-synced with it line for line (revision 2): no warning.
  assert.equal(rxChangedAfterFinalise({ revision: 1, updated_at: later, updated_from: RX_FROM_CUSTOMER_MASTER }, card), false);
  assert.equal(rxChangedAfterFinalise({ revision: 2, updated_at: later, updated_from: RX_FROM_CUSTOMER_MASTER }, card), false);
  // A person's save from a module, after the card was finalised: warns.
  assert.equal(rxChangedAfterFinalise({ revision: 3, updated_at: later, updated_from: 'artwork' }, card), true);
  // …but not when it came before the card was finalised, or the card is not finalised.
  assert.equal(rxChangedAfterFinalise({ revision: 3, updated_at: '2026-09-01T00:00:00Z', updated_from: 'artwork' }, card), false);
  assert.equal(rxChangedAfterFinalise({ revision: 3, updated_at: later, updated_from: 'artwork' }, null), false);
  assert.equal(rxChangedAfterFinalise(null, card), false);
  // No module can be named "customer master": a screen can never claim the master's source.
  assert.ok(!Object.keys(FLUENCE_CONTEXTS).includes(RX_FROM_CUSTOMER_MASTER));
});

test('rxLinesInStep: a new item gets a bare line at the end; an item that left the box loses its lines', () => {
  const lines = [
    { inner_product_id: 3, morning_qty: 1 },
    { inner_product_id: 9, night_qty: 1 },          // 9 has left the box
    { inner_product_id: null, item_label: 'Leaflet reading', instructions: 'Read first' },
    { inner_product_id: 3, night_qty: 2 },          // one item, two times: both lines stay
  ];
  const step = rxLinesInStep([{ inner_product_id: 3 }, { inner_product_id: 5 }], lines);
  assert.deepEqual(step.lines.map(l => [l.sr, l.inner_product_id, l.item_label ?? null]),
    [[1, 3, null], [2, null, 'Leaflet reading'], [3, 3, null], [4, 5, null]]);
  assert.deepEqual(step.removed.map(l => l.inner_product_id), [9]);
  assert.deepEqual(step.added.map(l => l.inner_product_id), [5]);
  // The added line is bare: the item alone, every other field empty.
  assert.deepEqual(step.added[0], bareRxLine(5));
  for (const k of RX_LINE_KEYS) if (k !== 'inner_product_id') assert.equal(step.added[0][k], null, k);
  // Ids that arrive as strings (a form) and numbers (the database) are one item.
  assert.deepEqual(rxLinesInStep([{ inner_product_id: '3' }], [{ inner_product_id: 3 }]).added, []);
});

test('rxLinesInStep: a kit already in step comes back unchanged; an empty kit keeps only its typed lines', () => {
  const lines = [{ inner_product_id: 3 }, { inner_product_id: 4, morning_qty: 1 }];
  const same = rxLinesInStep([{ inner_product_id: 3 }, { inner_product_id: 4 }], lines);
  assert.deepEqual([same.added, same.removed], [[], []]);
  assert.deepEqual(same.lines.map(l => l.inner_product_id), [3, 4]);
  const empty = rxLinesInStep([], [...lines, { item_label: 'Diet chart' }]);
  assert.deepEqual(empty.lines.map(l => l.item_label), ['Diet chart']);
  assert.equal(empty.removed.length, 2);
  assert.deepEqual(rxLinesInStep(null, null), { lines: [], removed: [], added: [] });
});

test('componentsSignature: the database\'s "1.00" is the editor\'s 1; order, quantity, MRP and remarks all count', () => {
  const db = [{ inner_product_id: 3, qty_per_kit: '1.00', mrp_in_kit: '109.00', remarks: null }, { inner_product_id: 4, qty_per_kit: '2.000', mrp_in_kit: null, remarks: '' }];
  const typed = [{ inner_product_id: '3', qty_per_kit: '1', mrp_in_kit: 109, remarks: '' }, { inner_product_id: 4, qty_per_kit: 2, mrp_in_kit: '', remarks: null }];
  assert.equal(componentsSignature(db), componentsSignature(typed));
  assert.notEqual(componentsSignature(db), componentsSignature([...typed].reverse()));
  assert.notEqual(componentsSignature(db), componentsSignature([{ ...typed[0], qty_per_kit: 2 }, typed[1]]));
  assert.notEqual(componentsSignature(db), componentsSignature([{ ...typed[0], mrp_in_kit: 110 }, typed[1]]));
  assert.notEqual(componentsSignature(db), componentsSignature([{ ...typed[0], remarks: 'Free sample' }, typed[1]]));
  assert.equal(componentsSignature([]), componentsSignature(null));
});

test('contexts: Kit Studio and Masters are places a save can come from', () => {
  assert.equal(FLUENCE_CONTEXTS.kit_studio, 'Kit Studio');
  assert.equal(FLUENCE_CONTEXTS.masters, 'Masters');
});

test('kitChangeSummary: what a notification to management says a customer changed', () => {
  const before = {
    components: [{ inner_product_id: 1, name: 'F-EASME', qty_per_kit: 1, mrp_in_kit: 365 }, { inner_product_id: 2, name: 'F-ONGLE', qty_per_kit: 1, mrp_in_kit: 446 }],
    rx: { lines: [{ inner_product_id: 1, item_name: 'F-EASME' }, { inner_product_id: 2, item_name: 'F-ONGLE' }] },
  };
  const after = {
    components: [{ inner_product_id: 1, name: 'F-EASME', qty_per_kit: 2, mrp_in_kit: 365 }, { inner_product_id: 3, name: 'F-CAL D3', qty_per_kit: 1, mrp_in_kit: 221 }],
    rx: { general_instructions: 'Take for 30 days', lines: [{ inner_product_id: 1, item_name: 'F-EASME', morning_qty: 1, dose_form: 'Tablet' }, { inner_product_id: 3, item_name: 'F-CAL D3' }] },
  };
  assert.equal(kitChangeSummary(before, after),
    'added F-CAL D3 × 1; took out F-ONGLE; F-EASME 1 → 2 per kit; F-EASME: Morning: 1 tablet; instructions: Take for 30 days');
  // Prices and order, and a dose taken off again.
  const priced = { ...before, components: [{ ...before.components[1] }, { ...before.components[0], mrp_in_kit: 399 }] };
  assert.equal(kitChangeSummary(before, priced), 'F-EASME MRP ₹365 → ₹399; items in a new order');
  assert.equal(kitChangeSummary(after, { ...after, rx: { ...after.rx, lines: after.rx.lines.map(l => ({ ...l, morning_qty: null })) } }), 'F-EASME: dose cleared');
  assert.equal(kitChangeSummary(before, before), 'saved with no change to the items or doses');
  // Long changes are cut, never the notification.
  const many = { components: Array.from({ length: 60 }, (_, i) => ({ inner_product_id: i + 10, name: `ITEM NUMBER ${i}`, qty_per_kit: 1 })) };
  const long = kitChangeSummary({ components: [] }, many);
  assert.ok(long.length <= 480 && long.endsWith('…'), long.length);
});
