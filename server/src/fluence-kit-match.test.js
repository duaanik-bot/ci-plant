import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchKits, aggregateKitLines, parseDmy, wordKey, zeroForOKey, charKey } from './fluence-kit-match.js';

const P = (id, code, name) => ({ id, code, name });
const K = (ref, kit_name, items = ['A'], valid_from = null) => ({ ref, kit_name, items, valid_from });

test('exact name (spacing/hyphens ignored) links; a plus sign is a different kit', () => {
  const products = [P(1, 'FP-013', 'F1O2'), P(2, 'FP-074', 'M9O2'), P(3, 'FP-247', 'M9O2+')];
  const r = matchKits([K('k1', 'F1-O2'), K('k2', 'M9 - O2'), K('k3', 'M9 - O2+')], products);
  assert.deepEqual(r.links.sort((a, b) => a.ref.localeCompare(b.ref)),
    [{ ref: 'k1', product_id: 1 }, { ref: 'k2', product_id: 2 }, { ref: 'k3', product_id: 3 }]);
  assert.deepEqual(r.suggestions, []);
  assert.deepEqual(r.conflicts, []);
});

test('two ERP products with one name: nothing is linked, the conflict is named', () => {
  const r = matchKits([K('k1', 'F AGA')], [P(1, 'FP-026', 'F AGA'), P(2, 'FP-900', 'F-AGA')]);
  assert.deepEqual(r.links, []);
  assert.equal(r.conflicts.length, 1);
  assert.match(r.conflicts[0].reason, /FP-026, FP-900/);
});

test('a re-listed kit with the same items: newest listing links, older is superseded', () => {
  const items = ['F-MELATON', 'F-TRICHOGROW'];
  const r = matchKits(
    [K('sl195', 'POST M -V2', items, '2022-10-11'), K('sl353', 'POST M - V2', [...items].reverse(), '2025-11-28')],
    [P(9, 'FP-104', 'POST M V2')]);
  assert.deepEqual(r.links, [{ ref: 'sl353', product_id: 9 }]);
  assert.deepEqual(r.superseded, [{ ref: 'sl195', by_ref: 'sl353' }]);
});

test('a re-listed name with DIFFERENT items is two kits — neither is linked', () => {
  const r = matchKits(
    [K('a', 'POST M -V2', ['X'], '2022-01-01'), K('b', 'POST M - V2', ['Y'], '2025-01-01')],
    [P(9, 'FP-104', 'POST M V2')]);
  assert.deepEqual(r.links, []);
  assert.equal(r.conflicts.length, 2);
});

test('weaker rules only SUGGEST, and only with exactly one candidate', () => {
  const products = [
    P(1, 'FP-234', 'SKIN FACT PSORIASIS 2 IMMU BOOSTER'),
    P(2, 'FP-063', 'M2O2'),
    P(3, 'FP-338', 'F NEO 1D3'),
  ];
  const r = matchKits([
    K('a', 'SKINFACT PSORIASIS IMMU BOOSTER 2'),
    K('b', 'M2-02'),
    K('c', 'F 1 NEO D3 '),
    K('d', 'HAIRFACT ANAGEN EXTENSION'),
  ], products);
  assert.deepEqual(r.links, []);
  const by = Object.fromEntries(r.suggestions.map(s => [s.ref, s]));
  assert.equal(by.a.product_id, 1);
  assert.equal(by.a.reason, 'same words, different order');
  assert.equal(by.b.product_id, 2);
  assert.equal(by.b.reason, 'zero typed for the letter O');
  assert.equal(by.c.product_id, 3);
  assert.equal(by.d, undefined);
});

test('an ambiguous weak match suggests nothing — and a weaker rule cannot win after it', () => {
  // Word order finds TWO candidates for "M2 02"; the zero-for-O rule alone
  // would find exactly one (M2O2). Ambiguity at the stronger rule must stop the
  // search, or the weaker rule quietly picks a winner the evidence never chose.
  const products = [P(1, 'X1', '02 M2'), P(2, 'X2', '02-M2 '), P(3, 'X3', 'M2O2')];
  const r = matchKits([K('a', 'M2 02')], products);
  assert.deepEqual(r.suggestions, []);
  assert.deepEqual(r.links, []);
});

test('a product already linked by an exact match is never suggested for another kit', () => {
  const r = matchKits([K('a', 'M2O2'), K('b', 'M2-02')], [P(2, 'FP-063', 'M2O2')]);
  assert.deepEqual(r.links, [{ ref: 'a', product_id: 2 }]);
  assert.deepEqual(r.suggestions, []);
});

test('keys: brand words split, zero-for-O only at the kit suffix', () => {
  assert.equal(wordKey('SKINFACT TIMELESS'), wordKey('SKIN FACT TIMELESS'));
  assert.equal(zeroForOKey('M2-02'), 'M2O2');
  assert.equal(zeroForOKey('F10 - O2'), 'F10O2');
  assert.equal(zeroForOKey('1020'), '1020');
  assert.equal(charKey('F 1 NEO D3'), charKey('F NEO 1D3'));
});

test('aggregateKitLines: a repeated item is one component with a quantity', () => {
  const out = aggregateKitLines([
    { product_name: 'F-GLUTASURGE-C', mrp: 1250 },
    { product_name: 'F-SOLSHINE TABLETS', mrp: 300 },
    { product_name: 'F-GLUTASURGE-C ', mrp: 1250 },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(c => [c.name, c.sr, c.qty_per_kit, c.mrp_in_kit, c.mrp_varies]),
    [['F-GLUTASURGE-C', 1, 2, 1250, false], ['F-SOLSHINE TABLETS', 2, 1, 300, false]]);
  const varied = aggregateKitLines([{ product_name: 'A', mrp: 1 }, { product_name: 'A', mrp: 2 }]);
  assert.equal(varied[0].mrp_varies, true);
});

test('parseDmy: customer dates, never a guess', () => {
  assert.equal(parseDmy('16/04/3035'), '3035-04-16');
  assert.equal(parseDmy('1/12/2015'), '2015-12-01');
  assert.equal(parseDmy('2015-12-01'), null);
  assert.equal(parseDmy('31/13/2020'), null);
  assert.equal(parseDmy(null), null);
});
