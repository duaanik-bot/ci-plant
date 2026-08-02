// Cover Board — the suggested split a fresh receipt opens with. The dialog's
// numbers come straight from coverSuggestions(), so these cases ARE the
// dialog's behaviour: PR-order walk, budget = min(free, landed), nothing
// suggested beyond what a job can still hold.
import test from 'node:test';
import assert from 'node:assert/strict';
import { coverSuggestions } from './board-allocation.js';

const c = (id, coverable) => ({ order_line_id: id, coverable });
const picks = list => list.map(x => x.suggested);

test('walks in the given order and exhausts the budget', () => {
  const out = coverSuggestions([c(1, 3000), c(2, 4000), c(3, 2000)], 10000, 5000);
  assert.deepEqual(picks(out), [3000, 2000, 0]); // budget 5000: 3000 then the 2000 left
});

test('budget is the smaller of free stock and what landed', () => {
  // Plenty landed, little free — free is the ceiling.
  assert.deepEqual(picks(coverSuggestions([c(1, 9000)], 1500, 8000)), [1500]);
  // Plenty free, small receipt — the receipt is the ceiling.
  assert.deepEqual(picks(coverSuggestions([c(1, 9000)], 8000, 1500)), [1500]);
});

test('a fully covered job (coverable 0) is suggested nothing and costs no budget', () => {
  const out = coverSuggestions([c(1, 0), c(2, 500)], 1000, 1000);
  assert.deepEqual(picks(out), [0, 500]);
});

test('negative or zero free stock suggests nothing at all', () => {
  assert.deepEqual(picks(coverSuggestions([c(1, 100), c(2, 100)], -250, 5000)), [0, 0]);
  assert.deepEqual(picks(coverSuggestions([c(1, 100)], 0, 5000)), [0]);
});

test('defensive: negative coverable is treated as zero, not as credit', () => {
  const out = coverSuggestions([c(1, -400), c(2, 300)], 1000, 1000);
  assert.deepEqual(picks(out), [0, 300]);
});

test('empty candidates return empty; inputs are not mutated', () => {
  assert.deepEqual(coverSuggestions([], 100, 100), []);
  const input = [c(1, 50)];
  coverSuggestions(input, 100, 100);
  assert.equal(input[0].suggested, undefined);
});

test('string numerics from pg are handled', () => {
  const out = coverSuggestions([{ order_line_id: 1, coverable: '2500' }], '4000', '3000');
  assert.deepEqual(picks(out), [2500]);
});
