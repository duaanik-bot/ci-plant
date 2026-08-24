// The "Ordered For" column has exactly one rule to get wrong: deciding when a
// purchase is committed to a job and when it is an open order. Both registers
// and both exports read that decision from poCommitment.js, so it is pinned
// here rather than re-derived per screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OPEN_ORDER, isLiveClaim, commitmentSummary, commitmentText, commitmentCustomers,
} from '../../client/src/lib/poCommitment.js';

const job = (over = {}) => ({
  order_line_id: 1, product_id: 9, product_code: 'SW-290', product_name: 'GLYCOMET TRIO FORTE',
  customer_name: 'Swiss Garnier Life Sciences', sales_po: '01879', status: 'planned',
  sheets: 2500, order_qty: 40000, gang_number: null, pr_number: 'CI-PR-0029', on_board: true,
  ...over,
});

test('no commitment is an OPEN ORDER, not an empty cell', () => {
  for (const empty of [[], null, undefined]) {
    const s = commitmentSummary(empty);
    assert.equal(s.kind, 'open');
    assert.equal(s.label, OPEN_ORDER);
    assert.equal(s.count, 0);
    assert.deepEqual(s.jobs, []);
    assert.equal(commitmentText(empty), OPEN_ORDER);
  }
});

test('one job names itself by product code', () => {
  const s = commitmentSummary([job()]);
  assert.equal(s.kind, 'committed');
  assert.deepEqual(s.names.map(n => n.name), ['SW-290']);
  assert.equal(s.label, 'SW-290');
  assert.equal(s.count, 1);
});

test('a job with no code falls back to its name, then to its line', () => {
  assert.equal(commitmentSummary([job({ product_code: null })]).label, 'GLYCOMET TRIO FORTE');
  assert.equal(
    commitmentSummary([job({ product_code: null, product_name: null, order_line_id: 243 })]).label,
    'Line 243',
  );
});

// The rule Anik asked for in as many words: reading the cell must be enough to
// know what the order is against. A count says an answer exists without saying
// what it is, which sends the buyer into the panel for the one fact the column
// was added to carry.
test('several jobs are ALL named — a count never replaces the names', () => {
  const s = commitmentSummary([job(), job({ order_line_id: 2, product_code: 'SW-291' })]);
  assert.deepEqual(s.names.map(n => n.name), ['SW-290', 'SW-291']);
  assert.equal(s.label, 'SW-290 · SW-291');
  assert.equal(s.count, 2);
  assert.doesNotMatch(s.label, /\d+ products/, 'no "N products" collapse, at any length');
});

test('a long list stays a list — nothing is dropped behind a tail count', () => {
  const many = Array.from({ length: 6 }, (_, i) => job({ order_line_id: i + 1, product_code: `SW-${100 + i}` }));
  const s = commitmentSummary(many);
  assert.equal(s.names.length, 6);
  assert.deepEqual(s.names.map(n => n.name), ['SW-100', 'SW-101', 'SW-102', 'SW-103', 'SW-104', 'SW-105']);
});

test('a job re-anchored off this board is named LAST and marked, never dropped', () => {
  const s = commitmentSummary([
    job({ order_line_id: 2, product_code: 'SW-291', on_board: false }),
    job(),
  ]);
  assert.equal(s.kind, 'committed');
  assert.deepEqual(s.names.map(n => n.name), ['SW-290', 'SW-291'], 'live claims lead');
  assert.deepEqual(s.names.map(n => n.on_board), [true, false]);
  assert.equal(s.moved, 1);
  assert.equal(s.count, 2, 'both are still carried — the buy really was raised for both');
});

test('every claim moved off leaves the purchase committed in name only', () => {
  const s = commitmentSummary([job({ on_board: false })]);
  assert.equal(s.kind, 'moved');
  assert.equal(s.moved, 1);
  assert.deepEqual(s.names.map(n => n.name), ['SW-290'],
    'still named — dropping it would read as Open Order, which is a different fact');
});

test('on_board unknown counts as on the board — only a proven move demotes a claim', () => {
  assert.equal(isLiveClaim(job({ on_board: undefined })), true);
  assert.equal(isLiveClaim(job({ on_board: null })), true);
  assert.equal(isLiveClaim(job({ on_board: false })), false);
});

test('the export/search string carries product, customer and sales PO', () => {
  const text = commitmentText([job(), job({ order_line_id: 2, product_code: 'SW-291', sales_po: '01975' })]);
  assert.match(text, /SW-290/);
  assert.match(text, /SW-291/);
  assert.match(text, /Swiss Garnier Life Sciences/);
  assert.match(text, /01879/);
  assert.match(text, /01975/);
});

test('customers are deduped and blanks dropped', () => {
  assert.deepEqual(
    commitmentCustomers([job(), job({ order_line_id: 2 }), job({ order_line_id: 3, customer_name: null })]),
    ['Swiss Garnier Life Sciences'],
  );
  assert.deepEqual(commitmentCustomers([]), []);
});

test('a null in the array cannot crash a register', () => {
  const s = commitmentSummary([null, job()]);
  assert.equal(s.count, 1);
  assert.equal(s.label, 'SW-290');
});

test('an open order has no names to render', () => {
  assert.deepEqual(commitmentSummary([]).names, []);
  assert.equal(commitmentSummary([]).label, OPEN_ORDER);
});
