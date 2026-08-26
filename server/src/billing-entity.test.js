import { test } from 'node:test';
import assert from 'node:assert/strict';
import { billingEntity, isIntraState, HOUSE_FALLBACK } from './billing-entity.js';

const HOUSE = { id: 1, name: 'Colour Impressions', state: 'Punjab', state_code: '03',
  gstin: '03AABCC1234D1Z5', address: 'Focal Point, Patiala, Punjab 147004', city: 'Patiala',
  hsn: '48192010', gst_rate: 18, tagline: 'House tagline', jurisdiction: 'Patiala', is_default: 1 };
const DARBI = { id: 2, name: 'Darbi Print Pack', state: null, state_code: null,
  gstin: null, address: null, city: null, hsn: '48192010', gst_rate: 18, is_default: 0 };

// A stub `one()` that answers the three shapes billingEntity asks for.
const stub = ({ house = HOUSE, byId = {}, byCustomer = {} }) => async (sql, args) => {
  if (/is_default=1/.test(sql)) return house;
  if (/billing_entities WHERE id=/.test(sql)) return byId[args[0]] ?? null;
  if (/JOIN billing_entities/.test(sql)) return byCustomer[args[0]] ?? null;
  throw new Error(`unexpected query: ${sql}`);
};

test('billingEntity: a customer with no mapping bills as the house entity', async () => {
  const e = await billingEntity({ customer_id: 1 }, stub({}));
  assert.equal(e.name, 'Colour Impressions');
  assert.equal(e.gstin, '03AABCC1234D1Z5');
});
test('billingEntity: Galpha bills as Darbi Print Pack', async () => {
  const e = await billingEntity({ customer_id: 6 }, stub({ byCustomer: { 6: DARBI } }));
  assert.equal(e.name, 'Darbi Print Pack');
});
test('billingEntity: an entity with no GSTIN yet borrows the house tax identity and SAYS SO', async () => {
  // A blank GSTIN on a tax invoice is worse than a wrong name. The document
  // stays valid and the UI is told what is still missing.
  const e = await billingEntity({ customer_id: 6 }, stub({ byCustomer: { 6: DARBI } }));
  assert.equal(e.name, 'Darbi Print Pack');
  assert.equal(e.gstin, '03AABCC1234D1Z5');
  assert.equal(e.address, 'Focal Point, Patiala, Punjab 147004');
  assert.deepEqual(e.incomplete, ['gstin', 'address', 'state']);
});
test('billingEntity: once Darbi has its own details, nothing is borrowed', async () => {
  const filled = { ...DARBI, gstin: '02AAACD1111A1Z0', address: 'Baddi, HP', state: 'Himachal Pradesh', state_code: '02' };
  const e = await billingEntity({ customer_id: 6 }, stub({ byCustomer: { 6: filled } }));
  assert.equal(e.gstin, '02AAACD1111A1Z0');
  assert.equal(e.state, 'Himachal Pradesh');
  assert.equal(e.incomplete, undefined);
});
test('billingEntity: a frozen entity_id wins over the customer mapping', async () => {
  // An invoice raised under the house entity must keep printing it even after
  // the customer is repointed at Darbi.
  const e = await billingEntity({ entity_id: 1, customer_id: 6 },
    stub({ byId: { 1: HOUSE }, byCustomer: { 6: DARBI } }));
  assert.equal(e.name, 'Colour Impressions');
});
test('billingEntity: an empty billing_entities table still prints a letterhead', async () => {
  const e = await billingEntity({ customer_id: 1 }, stub({ house: null }));
  assert.equal(e.name, HOUSE_FALLBACK.name);
  assert.equal(e.gstin, HOUSE_FALLBACK.gstin);
});

test('isIntraState: the SELLER state decides, not a hardcoded Punjab', async () => {
  const darbiHp = { state: 'Himachal Pradesh' };
  assert.equal(isIntraState(darbiHp, { state: 'Himachal Pradesh' }), true);   // CGST+SGST
  assert.equal(isIntraState(darbiHp, { state: 'Punjab' }), false);            // IGST
  assert.equal(isIntraState({ state: 'Punjab' }, { state: 'punjab  ' }), true);
});
test('isIntraState: an unknown state on either side is NOT intra-state', async () => {
  // Guessing "same state" would under-charge tax; IGST is the safe default.
  assert.equal(isIntraState({ state: null }, { state: 'Punjab' }), false);
  assert.equal(isIntraState({ state: 'Punjab' }, { state: null }), false);
  assert.equal(isIntraState({ state: '' }, { state: '' }), false);
});

// ── isValidGstin ──────────────────────────────────────────────────────
import { isValidGstin } from './billing-entity.js';
import { readFileSync } from 'node:fs';

test('isValidGstin: the plant’s own registrations pass their check digit', () => {
  assert.equal(isValidGstin('03BCMPD4475P1Z7'), true);   // Colour Impressions
  assert.equal(isValidGstin('03AXRPD1246K2ZI'), true);   // Darbi Print Pack
  assert.equal(isValidGstin('02AABCG2175Q1ZI'), true);   // Galpha, already live
});
test('isValidGstin: the placeholder this codebase shipped does NOT', () => {
  // It printed on live tax invoices and sat in the PO importer as the GSTIN it
  // must never mistake for a customer — where it matched nothing at all.
  assert.equal(isValidGstin('03AABCC1234D1Z5'), false);
});
test('isValidGstin: a single transposed character is caught', () => {
  assert.equal(isValidGstin('03BCMPD4457P1Z7'), false);
  assert.equal(isValidGstin('03BCMPD4475P1Z8'), false);
});
test('isValidGstin: malformed input is refused, not thrown on', () => {
  for (const bad of [null, undefined, '', '   ', '03BCMPD4475P1Z', 'not a gstin',
                     '99BCMPD4475P1Z7', '03bcmpd4475p1z7 x']) {
    assert.equal(isValidGstin(bad), false, `expected ${JSON.stringify(bad)} to be invalid`);
  }
  assert.equal(isValidGstin('  03bcmpd4475p1z7  '), true);  // trimmed + upper-cased
});
test('every GSTIN seeded into the schema is a real one', () => {
  // A source guard: the baseline is generated from init(), so this fails if
  // anyone re-seeds a made-up number into either.
  const sql = readFileSync(new URL('../../supabase/migrations/0001_baseline_schema.sql', import.meta.url), 'utf8');
  const found = sql.match(/\b[0-3][0-9][A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]\b/g) || [];
  assert.equal(found.length > 0, true, 'no GSTIN found in the baseline — has the seed moved?');
  assert.deepEqual(found.filter(g => !isValidGstin(g)), []);
});
