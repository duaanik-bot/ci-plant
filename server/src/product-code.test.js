// Product code series — the pure arithmetic behind moving a product to another
// customer ("migration", SGBT ↔ SGLS being the everyday case). Every customer's
// codes run one dense 3-digit-padded series (SW-001..767, SGB-001..335,
// HRB-001..003 — verified against the live warehouse mirror), so the next code
// in a customer's series is derivable from data: no config table, no hardcoded
// prefixes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dominantPrefix, nextNumber, formatCode, nextCodeFrom } from './product-code.js';

test('dominantPrefix reads the series a customer already runs', () => {
  assert.equal(dominantPrefix(['SW-001', 'SW-002', 'SW-767']), 'SW');
});

test('dominantPrefix picks the majority when history left strays', () => {
  assert.equal(dominantPrefix(['SGB-001', 'SGB-002', 'SGB-003', 'OLD-9']), 'SGB');
});

test('dominantPrefix never elects NEW — quick-create placeholders are not a series', () => {
  assert.equal(dominantPrefix(['NEW-0001', 'NEW-0002', 'SW-001']), 'SW');
  assert.equal(dominantPrefix(['NEW-0001', 'NEW-0002']), null);
});

test('dominantPrefix with nothing to read', () => {
  assert.equal(dominantPrefix([]), null);
  assert.equal(dominantPrefix([null, undefined, '', 'NOHYPHEN']), null);
});

test('nextNumber continues the series past its highest member', () => {
  assert.equal(nextNumber(['SW-001', 'SW-767', 'SW-090'], 'SW'), 768);
});

test('nextNumber only counts the given prefix, and ignores junk suffixes', () => {
  // SGB-ABC has no number; SW-999 is another series entirely.
  assert.equal(nextNumber(['SGB-002', 'SGB-ABC', 'SW-999'], 'SGB'), 3);
});

test('nextNumber starts a fresh series at 1', () => {
  assert.equal(nextNumber([], 'SGLS'), 1);
  assert.equal(nextNumber(['SW-005'], 'SGLS'), 1);
});

test('formatCode pads to the plant convention', () => {
  assert.equal(formatCode('SW', 768), 'SW-768');
  assert.equal(formatCode('SGB', 7), 'SGB-007');
  assert.equal(formatCode('HRB', 4), 'HRB-004');
});

test('formatCode does not truncate a series that outgrew three digits', () => {
  assert.equal(formatCode('SW', 1042), 'SW-1042');
});

test('nextCodeFrom: the composed rule — customer series first', () => {
  // customerCodes derive the prefix; allCodesInPrefix (globally unique code
  // column) derive the number, so a collision with an inactive or foreign row
  // is impossible by construction.
  assert.equal(
    nextCodeFrom({ customerCodes: ['SGB-001', 'SGB-335'], allCodesInPrefix: ['SGB-001', 'SGB-335'], customerName: 'Swiss Garniers Biotech Private Limited' }),
    'SGB-336',
  );
});

test('nextCodeFrom: a customer with no series yet falls back to their initials', () => {
  // customerInitials('Swiss Garnier Life Sciences') = SGLS — same helper the
  // plant's lists already abbreviate with.
  assert.equal(
    nextCodeFrom({ customerCodes: [], allCodesInPrefix: [], customerName: 'Swiss Garnier Life Sciences' }),
    'SGLS-001',
  );
});

test('nextCodeFrom: quick-create leftovers do not hijack the fallback', () => {
  assert.equal(
    nextCodeFrom({ customerCodes: ['NEW-0007'], allCodesInPrefix: [], customerName: 'Galpha Laboratories Ltd' }),
    'GL-001',
  );
});
