// What the die/block requirement register says about the warehouse.
//
// It printed FIVE figures for one fact: a chip reading "10 in warehouse" and
// then "Available 10 · Reserved 0 · Free 0" underneath, so Available was said
// twice and two of the three qualifiers were zero on most rows.
//
// The real defect underneath the clutter: the chip's NUMBER was `available`
// while its COLOUR was keyed on `free`. Ten dies all reserved for other jobs
// painted an amber chip reading "10 in warehouse" — and "10 in warehouse" is
// exactly the reading that stops a buyer ordering the one this job needs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stockPosition } from '../../client/src/lib/toolingStock.js';

test('the chip counts what this job can actually TAKE', () => {
  // Stock that exists but is spoken for is not stock this requirement has.
  const held = stockPosition({ stock_available: 10, stock_reserved: 10, stock_free: 0 });
  assert.equal(held.headline, '0 free of 10');
  assert.equal(held.state, 'spoken_for', 'ten reserved dies must not read as ten available ones');
});

test('the number on the chip and the colour of the chip agree', () => {
  // The old pair disagreed, which is the whole bug.
  const free = stockPosition({ stock_available: 4, stock_reserved: 1, stock_free: 3 });
  assert.equal(free.headline, '3 free of 4');
  assert.equal(free.state, 'free');

  const none = stockPosition({ stock_available: 2, stock_reserved: 2, stock_free: 0 });
  assert.equal(none.state, 'spoken_for');
  assert.notEqual(free.state, none.state, 'some free and none free cannot paint the same');
});

test('an empty warehouse says so, rather than doing sums', () => {
  const empty = stockPosition({ stock_available: 0, stock_reserved: 0, stock_free: 0 });
  assert.equal(empty.headline, 'None in warehouse', '"0 free of 0" is a sum nobody needs to read');
  assert.equal(empty.state, 'none');
  assert.deepEqual(empty.qualifiers, [], 'nothing to qualify');
});

test('a zero qualifier is not printed', () => {
  // "Reserved 0 · Free 0" on every untouched row was most of the noise.
  const plain = stockPosition({ stock_available: 5, stock_reserved: 0, stock_free: 5 });
  assert.deepEqual(plain.qualifiers, []);
});

test('a non-zero qualifier IS printed, because it is the exception', () => {
  const busy = stockPosition({ stock_available: 5, stock_reserved: 2, stock_free: 3, stock_ordered: 4 });
  assert.deepEqual(busy.qualifiers.map(q => q.label), ['Reserved 2', 'On order 4']);
  // Each tone must be one the register can actually paint.
  for (const q of busy.qualifiers) assert.ok(['amber', 'sky'].includes(q.tone), `${q.tone} has no colour`);
});

test('the full breakdown survives on hover', () => {
  // Collapsing must not lose a figure, only stop shouting it.
  const s = stockPosition({ stock_available: 5, stock_reserved: 2, stock_free: 3, stock_ordered: 4 });
  assert.equal(s.title, 'Available 5 · Reserved 2 · Free 3 · On order 4');
  const quiet = stockPosition({ stock_available: 5, stock_reserved: 0, stock_free: 5 });
  assert.equal(quiet.title, 'Available 5 · Reserved 0 · Free 5', 'zeros still readable on hover');
});

test('missing figures are zero, not NaN', () => {
  // The row comes off a LEFT JOIN; a die master nobody has stocked has nulls.
  const s = stockPosition({});
  assert.equal(s.headline, 'None in warehouse');
  assert.equal(s.state, 'none');
  assert.equal(stockPosition().state, 'none', 'no row at all must not throw');
});

test('the three states are exactly the three the register paints', () => {
  const states = new Set([
    stockPosition({ stock_available: 5, stock_free: 5 }).state,
    stockPosition({ stock_available: 5, stock_free: 0, stock_reserved: 5 }).state,
    stockPosition({ stock_available: 0 }).state,
  ]);
  assert.deepEqual([...states].sort(), ['free', 'none', 'spoken_for']);
});
