// The sales order against the order finalised (owner, 21 Nov 2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { customerWord, matchSalesOrder, orderLine, productKey, withActuals } from './order-finalise.js';

test('productKey and customerWord ignore spacing, case and punctuation', () => {
  assert.equal(productKey('BONVERA-XT TABLETS PTD CARTON(10X15)SALES-R0'), productKey('Bonvera-XT Tablets PTD Carton (10X15) Sales-R0'));
  assert.equal(customerWord('Swiss Garnier'), 'SWISS');
  assert.equal(customerWord('  galpha laboratories ltd'), 'GALPHA');
});

test('matchSalesOrder: by product name, newest sales order first, each sales-order line used once', () => {
  const lines = [
    { enquiry_id: 1, enquiry_no: 'E1', product: 'ALPHA TABLETS CARTON(10X10)', qty: 2000, rate: 7.5 },
    { enquiry_id: 2, enquiry_no: 'E2', product: 'BETA CARTON', qty: 1000, rate: 3 },
    { enquiry_id: 3, enquiry_no: 'E3', product: 'GAMMA CARTON', qty: 500, rate: 2 },
  ];
  const so = [
    { order_id: 10, po_number: 'P-OLD', po_date: '2026-11-01', line_id: 100, product: 'Alpha Tablets Carton (10x10)', qty: 2000, rate: 7.2, customer: 'A', created_at: '2026-11-01' },
    { order_id: 11, po_number: 'P-NEW', po_date: '2026-11-22', line_id: 110, product: 'ALPHA TABLETS CARTON (10X10)', qty: 2100, rate: 7.4, customer: 'A', created_at: '2026-11-22' },
    { order_id: 11, po_number: 'P-NEW', po_date: '2026-11-22', line_id: 111, product: 'BETA CARTON', qty: 1000, rate: 3, customer: 'A', created_at: '2026-11-22' },
  ];
  const m = matchSalesOrder(lines, so);
  assert.equal(m[0].so.po_number, 'P-NEW', 'the newest');
  assert.equal(m[0].rate_diff, -0.1);
  assert.equal(m[0].qty_diff, 100);
  assert.equal(m[1].so.line_id, 111);
  assert.equal(m[1].rate_diff, 0);
  assert.equal(m[2].so, null, 'no sales order yet');
  // actuals ride beside the finalised rate, which stays
  const withA = withActuals([{ ...lines[0], cost: 7 }, lines[1], { ...lines[2], cost: 1.5 }], m);
  assert.equal(withA[0].rate, 7.5, 'still finalised at its rate');
  assert.equal(withA[0].actual_rate, 7.4);
  assert.equal(withA[0].actual_qty, 2100);
  assert.equal(withA[0].actual_po, 'P-NEW');
  assert.equal(withA[0].actual_margin_total, 840);
  assert.equal(withA[2].actual_rate, undefined, 'unmatched: unchanged');
});

test('orderLine starts at our final given rate, before the quotation\'s', () => {
  const e = { id: 1, enquiry_no: 'E1', product_name: 'X', quantities: [1000], final_prices: [{ qty: 1000, final: 7.2 }] };
  assert.equal(orderLine(e, { quotationLine: { qty: 1000, rate: 7.5 } }).rate, 7.2);
  assert.equal(orderLine(e, { quotationLine: { qty: 1000, rate: 7.5 } }).final, 7.2);
  assert.equal(orderLine({ ...e, final_prices: [] }, { quotationLine: { qty: 1000, rate: 7.5 } }).rate, 7.5);
});

import { autoPick } from './order-finalise.js';

test('row by row: pick takes only those lines; autoPick finds marked lines whose sales order is in', () => {
  const lines = [
    { enquiry_id: 1, product: 'ALPHA CARTON', qty: 100, rate: 5, cost: 4, rate_from_so: true },
    { enquiry_id: 2, product: 'BETA CARTON', qty: 100, rate: 3, cost: 2 },
    { enquiry_id: 3, product: 'GAMMA CARTON', qty: 100, rate: 2, cost: 1, rate_from_so: true },
  ];
  const so = [
    { order_id: 1, po_number: 'P1', line_id: 1, product: 'ALPHA CARTON', qty: 100, rate: 4.8, created_at: '2026-11-22' },
    { order_id: 1, po_number: 'P1', line_id: 2, product: 'BETA CARTON', qty: 100, rate: 2.9, created_at: '2026-11-22' },
  ];
  const m = matchSalesOrder(lines, so);
  assert.deepEqual(autoPick(lines, m), [0], 'GAMMA is marked but its sales order is not in yet');
  const one = withActuals(lines, m, { pick: [1] });
  assert.equal(one[0].actual_rate, undefined);
  assert.equal(one[1].actual_rate, 2.9);
  const all = withActuals(lines, m);
  assert.deepEqual(all.map(l => l.actual_rate), [4.8, 2.9, undefined], 'the whole batch: every line found');
  assert.deepEqual(autoPick(all, m), [], 'taken once');
  const e = { id: 9, enquiry_no: 'E9', product_name: 'X', quantities: [1000], final_prices: [{ qty: 1000, final: 2 }] };
  assert.equal(orderLine(e, { edits: { so_auto: true } }).rate_from_so, true);
  assert.equal(orderLine(e, { edits: { qty: 1000, rate: 2 } }).rate_from_so, undefined);
});

import { orderMail } from './order-finalise.js';

test('orderMail: sent again says so; a line taken from its sales order shows that rate beside the finalised one', () => {
  const lines = [
    { enquiry_no: 'E1', product: 'ALPHA CARTON', size: '100 × 40 × 40', qty: 1000, rate: 7.5, value: 7500, ups: 2, sheet: { l: 15, w: 20 }, new_die: false, actual_rate: 7.1, actual_qty: 1200, actual_po: 'P-1', cost: 6 },
    { enquiry_no: 'E2', product: 'BETA CARTON', qty: 500, rate: 3, value: 1500, new_die: true, cost: 2 },
  ];
  const m = orderMail({ order_no: 'CI-OF-0009', customer: 'Acme', lines, by: 'A Person', at: '2026-11-21T10:00:00Z', again: true });
  assert.match(m.subject, /CI-OF-0009 \(sent again\)$/);
  assert.match(m.text, /Sales order P-1: 1,200 at .*7\.10 a carton/);
  assert.match(m.html, /Sales order<\/th>/);
  assert.match(m.html, /1,200 @ .*7\.10 \(P-1\)/);
  assert.doesNotMatch(m.text + m.html, /6\.00|cost|margin/i, 'the team sees rates, never our cost');
  const first = orderMail({ order_no: 'CI-OF-0009', customer: 'Acme', lines: [lines[1]], by: 'A', at: '2026-11-21T10:00:00Z' });
  assert.doesNotMatch(first.subject, /again/);
  assert.doesNotMatch(first.html, /Sales order<\/th>/, 'no column when no line has one');
});
