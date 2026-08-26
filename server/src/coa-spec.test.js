import { test } from 'node:test';
import assert from 'node:assert/strict';
import { declaredGsm, withDeclaredGsm, applyGsmToParams, coaSpecRows, COA_GSM_RUNGS, COA_GSM_FLOOR } from './coa-spec.js';

// ── declaredGsm ───────────────────────────────────────────────────────
// Anik's ladder, stated case by case. These ARE the specification.
test('declaredGsm: a stock GSM certifies as itself', () => {
  assert.equal(declaredGsm(300), 300);
  assert.equal(declaredGsm(320), 320);
  assert.equal(declaredGsm(350), 350);
  assert.equal(declaredGsm(360), 360);
});
test('declaredGsm: a mill tolerance rounds UP to the grade it can claim', () => {
  assert.equal(declaredGsm(280), 300);
  assert.equal(declaredGsm(296), 300);
  assert.equal(declaredGsm(310), 320);
  assert.equal(declaredGsm(330), 350);
  assert.equal(declaredGsm(340), 350);
  assert.equal(declaredGsm(380), 400);
});
test('declaredGsm: the rungs in between follow the same rule', () => {
  assert.equal(declaredGsm(290), 300);  // 20 live products
  assert.equal(declaredGsm(315), 320);  // 5
  assert.equal(declaredGsm(325), 350);  // 1
  assert.equal(declaredGsm(400), 400);  // 3
});
test('declaredGsm: below the floor nothing is rounded — a 70 GSM label is not a carton', () => {
  // Rounding light stock up would be a misdeclaration, not a courtesy.
  assert.equal(declaredGsm(70), 70);
  assert.equal(declaredGsm(205), 205);
  assert.equal(declaredGsm(250), 250);
  assert.equal(declaredGsm(275), 275);
  assert.equal(declaredGsm(279), 279);
  assert.equal(declaredGsm(COA_GSM_FLOOR), COA_GSM_RUNGS[0]);
});
test('declaredGsm: above the top rung the real figure stands', () => {
  assert.equal(declaredGsm(450), 450);
  assert.equal(declaredGsm(401), 401);
});
test('declaredGsm: no GSM on the master yields no claim, never a zero', () => {
  assert.equal(declaredGsm(null), null);
  assert.equal(declaredGsm(undefined), null);
  assert.equal(declaredGsm(''), null);
  assert.equal(declaredGsm(0), null);
  assert.equal(declaredGsm('not a number'), null);
});
test('declaredGsm: a numeric string from a form field is read as a number', () => {
  assert.equal(declaredGsm('296'), 300);
  assert.equal(declaredGsm(' 340 '), 350);
});

// ── withDeclaredGsm ───────────────────────────────────────────────────
// The board name carries its own GSM ("Duplex WB · 296 GSM · 31.5x41.5").
// Printed verbatim beside a declared 300, the certificate contradicts itself.
test('withDeclaredGsm: the GSM inside a board name is rewritten to the declared one', () => {
  assert.equal(withDeclaredGsm('Duplex WB · 296 GSM · 31.5x41.5', 300),
    'Duplex WB · 300 GSM · 31.5x41.5');
  assert.equal(withDeclaredGsm('Duplex GB 296 GSM 25x30', 300),
    'Duplex GB 300 GSM 25x30');
});
test('withDeclaredGsm: lower-case and no-space spellings are caught too', () => {
  assert.equal(withDeclaredGsm('Duplex 330 gsm 22x28', 350), 'Duplex 350 gsm 22x28');
  assert.equal(withDeclaredGsm('FBB 340GSM', 350), 'FBB 350GSM');
});
test('withDeclaredGsm: a sheet size is not a grammage — 31.5x41.5 survives', () => {
  assert.equal(withDeclaredGsm('Duplex WB · 296 GSM · 31.5x41.5', 300),
    'Duplex WB · 300 GSM · 31.5x41.5');
  assert.equal(withDeclaredGsm('Board 23x36', 300), 'Board 23x36');
});
test('withDeclaredGsm: nothing to declare leaves the text alone', () => {
  assert.equal(withDeclaredGsm('Duplex WB · 296 GSM', null), 'Duplex WB · 296 GSM');
  assert.equal(withDeclaredGsm(null, 300), null);
});

// ── applyGsmToParams ──────────────────────────────────────────────────
test('applyGsmToParams: every standard on the grid moves to the declared GSM together', () => {
  const rows = [
    { parameter: 'Board substrate', standard: 'Duplex WB · 296 GSM · 25x30', observed: 'Complies', result: 'Pass' },
    { parameter: 'Grammage', standard: '296 GSM ± 5%', observed: 'Complies', result: 'Pass' },
    { parameter: 'Cleanliness', standard: 'Free from dust', observed: 'Complies', result: 'Pass' },
  ];
  const out = applyGsmToParams(rows, 300);
  assert.equal(out[0].standard, 'Duplex WB · 300 GSM · 25x30');
  assert.equal(out[1].standard, '300 GSM ± 5%');
  assert.equal(out[2].standard, 'Free from dust');
  // the caller's rows are not mutated
  assert.equal(rows[1].standard, '296 GSM ± 5%');
});
test('applyGsmToParams: an observed reading is a MEASUREMENT — never rewritten', () => {
  // QC may have written the real caliper figure there. Silently "correcting" a
  // measurement to the sales grade is falsifying the record.
  const rows = [{ parameter: 'Grammage', standard: '296 GSM ± 5%', observed: '297 GSM', result: 'Pass' }];
  assert.equal(applyGsmToParams(rows, 300)[0].observed, '297 GSM');
});
test('applyGsmToParams: a non-array is handled, not thrown on', () => {
  assert.deepEqual(applyGsmToParams(null, 300), []);
});

// ── coaSpecRows ───────────────────────────────────────────────────────
const MASTER = {
  size: '158 x 85 x 93', gsm: 296, board_name: 'Duplex WB · 296 GSM · 31.5x41.5',
  board_grade: 'Duplex', child_l: 25, child_w: 30, colors: 5, colour_type: 'CMYK + Pantone',
  coating: 'Aqueous Varnish', special: 'emboss', pasting_type: 'LOCK BOTTOM',
  shade_card_number: 'CI1374', party_artwork_code: 'R0',
};

test('coaSpecRows: the grid is built from the product master', () => {
  const rows = coaSpecRows(MASTER, { name: 'Duplex WB · 296 GSM · 31.5x41.5' });
  const find = p => rows.find(r => r.parameter === p);
  assert.equal(find('Product / carton size').standard, '158 x 85 x 93');
  assert.equal(find('Printing colours').standard, '5 colours · CMYK + Pantone');
  assert.equal(find('Coating / finish').standard, 'Aqueous Varnish');
  assert.equal(find('Special finish').standard, 'Embossing');
  assert.equal(find('Pasting / bonding').standard.startsWith('Lock bottom'), true);
  assert.equal(find('Shade matching').standard, 'As per approved shade card CI1374');
  assert.equal(find('Artwork reference').standard, 'R0');
  // The print (child) sheet size is a PRODUCTION figure — how the plant lays the
  // carton onto a press sheet. It says nothing to the customer about the goods
  // they received, so it is deliberately not on the certificate.
  assert.equal(rows.some(r => r.parameter === 'Print sheet size'), false);
});
test('coaSpecRows: the declared GSM reaches BOTH the substrate and the grammage row', () => {
  const rows = coaSpecRows(MASTER, { name: 'Duplex WB · 296 GSM · 31.5x41.5' });
  assert.equal(rows.find(r => r.parameter === 'Board substrate').standard,
    'Duplex WB · 300 GSM · 31.5x41.5');
  assert.equal(rows.find(r => r.parameter === 'Grammage').standard, '300 GSM ± 5%');
  // and nowhere on the sheet does the mill figure survive
  assert.equal(rows.some(r => String(r.standard).includes('296')), false);
});
test('coaSpecRows: the master board name wins over the material name', () => {
  // products.board_name is what the plant master states for THIS carton;
  // materials.name is the board the plan happened to draw.
  const rows = coaSpecRows({ ...MASTER, board_name: 'Duplex GB · 296 GSM · 25x30' },
    { name: 'Saffire · 300 GSM · 23x36' });
  assert.equal(rows.find(r => r.parameter === 'Board substrate').standard,
    'Duplex GB · 300 GSM · 25x30');
});
test('coaSpecRows: a master with nothing on it still yields a usable certificate', () => {
  const rows = coaSpecRows({}, null);
  assert.equal(rows.length > 0, true);
  assert.equal(rows.some(r => r.parameter === 'Product / carton size'), false);
  assert.equal(rows.some(r => r.parameter === 'Grammage'), false);
  assert.equal(rows.find(r => r.parameter === 'Board substrate').standard,
    'As per approved specification');
  for (const r of rows) {
    assert.equal(r.observed, 'Complies');
    assert.equal(r.result, 'Pass');
    assert.equal(String(r.standard).includes('undefined'), false);
    assert.equal(String(r.standard).includes('null'), false);
  }
});
test('coaSpecRows: a blank coating is no coating, and "none" is not a finish', () => {
  assert.equal(coaSpecRows({ ...MASTER, coating: null }, null).some(r => r.parameter === 'Coating / finish'), false);
  assert.equal(coaSpecRows({ ...MASTER, coating: '  ' }, null).some(r => r.parameter === 'Coating / finish'), false);
  assert.equal(coaSpecRows({ ...MASTER, special: 'none' }, null).some(r => r.parameter === 'Special finish'), false);
});
test('coaSpecRows: the master colour_type is filthy — casing and stray spaces are cleaned', () => {
  // live data holds 'pantone', ' Pantone', 'PANTONE ', 'CMYK '
  const g = ct => coaSpecRows({ ...MASTER, colour_type: ct }, null)
    .find(r => r.parameter === 'Printing colours').standard;
  assert.equal(g('pantone'), '5 colours · Pantone');
  assert.equal(g(' Pantone'), '5 colours · Pantone');
  assert.equal(g('PANTONE '), '5 colours · Pantone');
  assert.equal(g('CMYK '), '5 colours · CMYK');
  assert.equal(g('CMYK + Pantone'), '5 colours · CMYK + Pantone');
});
test('coaSpecRows: leafing and emboss flags from the master are stated', () => {
  const rows = coaSpecRows({ ...MASTER, special: 'none', emboss: 1, leafing: 1, leafing_colour: 'Gold' }, null);
  assert.equal(rows.find(r => r.parameter === 'Special finish').standard,
    'Embossing · Gold leafing');
});
