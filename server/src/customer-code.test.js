import { test } from 'node:test';
import assert from 'node:assert/strict';
// Client-only helper (a display abbreviation the server never computes), tested
// here because this is where the repo runs its unit tests.
import { customerInitials, customerSearchText } from '../../client/src/lib/customerCode.js';

test('customerInitials: the plant convention — one letter per significant word', () => {
  assert.equal(customerInitials('Swiss Garnier Life Sciences'), 'SGLS');
  assert.equal(customerInitials('Galpha Laboratories'), 'GL');
});

test('customerInitials: the legal tail is dropped, so it never pads the code', () => {
  // The plant already codes this company SGB — Private/Limited add nothing.
  assert.equal(customerInitials('Swiss Garniers Biotech Private Limited'), 'SGB');
  assert.equal(customerInitials('Fluence Pharamceuticals Pvt. Ltd.'), 'FP');
  assert.equal(customerInitials('Galpha Laboratories Ltd'), 'GL');
});

test('customerInitials: a single-word name keeps letters, not one initial', () => {
  assert.equal(customerInitials('Herboveda'), 'HERB');
  assert.equal(customerInitials('Pureflix'), 'PURE');
  // A short single word is not padded.
  assert.equal(customerInitials('Cip'), 'CIP');
});

test('customerInitials: punctuation between words does not create empty initials', () => {
  assert.equal(customerInitials('Sun-Pharma Laboratories'), 'SL');
  assert.equal(customerInitials('  Zydus   Wellness  '), 'ZW');
});

test('customerInitials: runs long enough to be unreadable are capped', () => {
  assert.equal(customerInitials('Alpha Beta Gamma Delta Epsilon Zeta'), 'ABGDE');
});

test('customerInitials: an all-noise name still renders something', () => {
  assert.equal(customerInitials('The Company'), 'TC');
});

test('customerInitials: nothing in, nothing out — the caller renders the dash', () => {
  assert.equal(customerInitials(''), '');
  assert.equal(customerInitials(null), '');
  assert.equal(customerInitials(undefined), '');
});

test('customerSearchText: typing the full name still finds a cell showing initials', () => {
  const hay = customerSearchText('Swiss Garnier Life Sciences').toLowerCase();
  assert.ok(hay.includes('swiss'));
  assert.ok(hay.includes('sgls'));
});

test('customerSearchText: no duplication when the name is already its own code', () => {
  assert.equal(customerSearchText('CIP'), 'CIP');
  assert.equal(customerSearchText(''), '');
});
