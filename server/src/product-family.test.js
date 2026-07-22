import { test } from 'node:test';
import assert from 'node:assert/strict';
import { familyKey, clashes, findClashes } from './product-family.js';

// ── familyKey ─────────────────────────────────────────────────────────
test('familyKey: brand + trailing strength', () => {
  assert.deepEqual(familyKey('NICOSTAR 5'), { base: 'NICOSTAR', strength: '5' });
  assert.deepEqual(familyKey('Nicostar 10'), { base: 'NICOSTAR', strength: '10' });
});
test('familyKey: strength buried mid-string, brand is the prefix', () => {
  assert.deepEqual(familyKey('AIMET XR 25 TABLET CARTON SALE-R2'), { base: 'AIMET XR', strength: '25' });
  assert.deepEqual(familyKey('AIMET XR 50 TABLET CARTON SALES R1'), { base: 'AIMET XR', strength: '50' });
});
test('familyKey: unit-suffixed strength normalizes to A-Z0-9', () => {
  assert.equal(familyKey('ADMAG HEAVY 500MG CAPSULES').strength, '500MG');
});
test('familyKey: decimal strength is preserved (2.5 != 25)', () => {
  assert.equal(familyKey('BLOCPRO AM 2.5 TABLET CARTON 3X10 SALE-R0').strength, '2.5');
  assert.equal(clashes({ product_id: 1, customer_id: 1, name: 'BLOCPRO AM 2.5 TABLET' },
                       { product_id: 2, customer_id: 1, name: 'BLOCPRO AM 25 TABLET' }), true);
  assert.equal(clashes({ product_id: 1, customer_id: 1, name: 'BLOCPRO AM 2.5 TABLET 3X10' },
                       { product_id: 2, customer_id: 1, name: 'BLOCPRO AM 2.5 TABLET 1X2' }), false);
});
test('familyKey: no number → no strength', () => {
  assert.deepEqual(familyKey('ACELODON GEL EXPORT CARTON'), { base: 'ACELODON GEL EXPORT CARTON', strength: null });
});
test('familyKey: a name starting with a number has an empty base', () => {
  assert.equal(familyKey('1 KG MITHAI BOX').base, '');
});
test('familyKey: an internal digit does not split the token', () => {
  assert.equal(familyKey('AL5ZYME DROPS-15ML').base, 'AL5ZYME DROPS');
  assert.equal(familyKey('AL5ZYME DROPS-15ML').strength, '15ML');
});

// ── clashes ───────────────────────────────────────────────────────────
const P = (id, name, customer_id = 1) => ({ product_id: id, name, customer_id });

test('clashes: same brand, different strength, same customer → true', () => {
  assert.equal(clashes(P(1, 'NICOSTAR 5'), P(2, 'NICOSTAR 10')), true);
  assert.equal(clashes(P(1, 'AIMET XR 25 TABLET-R2'), P(2, 'AIMET XR 50 TABLETS-R1')), true);
});
test('clashes: same brand, SAME strength (revisions) → false', () => {
  assert.equal(clashes(P(1, 'AIMET XR 25 TABLET-R2'), P(2, 'AIMET XR 25 TABLETS-R1')), false);
});
test('clashes: different brand → false', () => {
  assert.equal(clashes(P(1, 'ACICHECK 20 TABLETS'), P(2, 'ACELODON GEL 30GM')), false);
});
test('clashes: same brand but different customer → false', () => {
  assert.equal(clashes(P(1, 'NICOSTAR 5', 1), P(2, 'NICOSTAR 10', 2)), false);
});
test('clashes: a null customer never clashes', () => {
  assert.equal(clashes(P(1, 'NICOSTAR 5', null), P(2, 'NICOSTAR 10', 1)), false);
});
test('clashes: same form/no-strength product → false', () => {
  assert.equal(clashes(P(1, 'ACELODON GEL'), P(2, 'ACELODON CREAM')), false);
});
test('clashes: leading-number box (empty base) never clashes', () => {
  assert.equal(clashes(P(1, '250 GM MITHAI BOX'), P(2, '500 GM MITHAI BOX')), false);
});
test('clashes: same-form different pack, no strength → false', () => {
  assert.equal(clashes(P(1, 'AL5ZYME DROPS-15ML'), P(2, 'AL5ZYME LIQUID 100ML')), false); // base differs
});

// ── findClashes ───────────────────────────────────────────────────────
test('findClashes: returns only genuine siblings, skips self and non-matches', () => {
  const target = P(1, 'NICOSTAR 5');
  const pool = [
    P(1, 'NICOSTAR 5'),        // self (same product_id) — excluded
    P(2, 'NICOSTAR 10'),       // sibling — match
    P(3, 'NICOSTAR 5'),        // same strength — no match
    P(4, 'ACICHECK 20'),       // other brand — no match
    P(5, 'NICOSTAR 20', 9),    // other customer — no match
  ];
  const hits = findClashes(target, pool);
  assert.deepEqual(hits.map((h) => h.product_id), [2]);
});
test('findClashes: empty pool → empty', () => {
  assert.deepEqual(findClashes(P(1, 'NICOSTAR 5'), []), []);
});
