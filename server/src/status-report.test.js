// Status Sheet › Reports roll-up. Lives in server/src because node --test
// cannot import the .jsx page (same arrangement as wip-export.test.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deliveryOf, enrichLine, filterLines, totalsOf, groupLines, groupDelivery,
  buildReportExportSpec, sumRows, summaryOf,
} from '../../client/src/lib/statusReport.js';

const L = (id, extra = {}) => enrichLine({
  line_id: id, order_id: 1, po_number: '024', po_date: '2026-11-05',
  customer_id: 7, customer_name: 'Fluence', product_id: id, product_name: `P${id}`,
  qty: 250, rate: 10, dispatched_qty: 0, status: 'pending', ...extra,
});

test('delivery bucket is a cascade — one per line', () => {
  assert.equal(deliveryOf({ qty: 100, dispatched_qty: 0, status: 'pending' }), 'pending');
  assert.equal(deliveryOf({ qty: 100, dispatched_qty: 40, status: 'in_production' }), 'part');
  assert.equal(deliveryOf({ qty: 100, dispatched_qty: 100, status: 'produced' }), 'delivered');
  // Marked dispatched below its qty = closed short: delivered, owes nothing.
  assert.equal(deliveryOf({ qty: 100, dispatched_qty: 95, status: 'dispatched' }), 'delivered');
  // Cancelled wins even if something went out.
  assert.equal(deliveryOf({ qty: 100, dispatched_qty: 10, status: 'cancelled' }), 'cancelled');
});

test('pending qty is owed only on pending/part lines; short qty only on delivered', () => {
  assert.equal(L(1).pending_qty, 250);
  assert.equal(L(2, { dispatched_qty: 100, status: 'in_production' }).pending_qty, 150);
  const short = L(3, { dispatched_qty: 240, status: 'dispatched' });
  assert.equal(short.pending_qty, 0);
  assert.equal(short.short_qty, 10);
  const cx = L(4, { status: 'cancelled' });
  assert.equal(cx.pending_qty, 0);
  assert.equal(cx.value, 0);
  assert.equal(L(2, { dispatched_qty: 100, status: 'in_production' }).pending_value, 1500);
});

test('filters: company, delivery state and PO date range', () => {
  const lines = [
    L(1),
    L(2, { customer_id: 8, customer_name: 'Swiss', po_date: '2026-09-01' }),
    L(3, { dispatched_qty: 250, status: 'dispatched', po_date: '2026-10-01' }),
  ];
  assert.deepEqual(filterLines(lines, { customers: [7] }).map(l => l.line_id), [1, 3]);
  assert.deepEqual(filterLines(lines, { delivery: ['delivered'] }).map(l => l.line_id), [3]);
  assert.deepEqual(filterLines(lines, { from: '2026-10-01' }).map(l => l.line_id), [1, 3]);
  assert.deepEqual(filterLines(lines, { to: '2026-10-01' }).map(l => l.line_id), [2, 3]);
  assert.equal(filterLines(lines, {}).length, 3);
});

test('company view folds lines and counts orders once', () => {
  const lines = [
    L(1),
    L(2, { order_id: 2, po_number: '023', po_date: '2026-10-30', dispatched_qty: 250, status: 'dispatched' }),
    L(3, { status: 'cancelled' }),
    L(4, { customer_id: 8, customer_name: 'Swiss' }),
  ];
  const rows = groupLines(lines, 'company');
  assert.equal(rows.length, 2);
  const f = rows.find(r => r.customer_name === 'Fluence');
  assert.equal(f.orders, 2);
  assert.equal(f.lines, 3);
  assert.equal(f.qty, 500); // cancelled line excluded
  assert.equal(f.dispatched_qty, 250);
  assert.equal(f.pending_qty, 250);
  assert.equal(f.open_lines, 1);
  assert.equal(f.fulfil_pct, 50);
  assert.equal(f.oldest_open_po, '2026-11-05');
  assert.equal(f.delivery, 'part');
});

test('PO view: a fully dispatched PO reads Delivered, an untouched one Pending', () => {
  const lines = [
    L(1, { order_id: 1, dispatched_qty: 250, status: 'dispatched' }),
    L(2, { order_id: 1, dispatched_qty: 200, status: 'dispatched' }),
    L(3, { order_id: 2, po_number: '025' }),
  ];
  const rows = groupLines(lines, 'po');
  assert.equal(rows.find(r => r.order_id === 1).delivery, 'delivered');
  assert.equal(rows.find(r => r.order_id === 1).short_qty, 50);
  assert.equal(rows.find(r => r.order_id === 2).delivery, 'pending');
  assert.equal(groupDelivery({ lines: 2, cancelled: 2, pending: 0, part: 0, delivered: 0 }), 'cancelled');
});

test('product view keys on company + product, so two companies never merge', () => {
  const lines = [L(1, { product_id: 9 }), L(2, { product_id: 9, order_id: 2 }), L(3, { product_id: 9, customer_id: 8, customer_name: 'Swiss' })];
  const rows = groupLines(lines, 'product');
  assert.equal(rows.length, 2);
  assert.equal(rows.find(r => r.customer_id === 7).orders, 2);
  // Per-product order counts cannot be added into an order total.
  assert.equal(sumRows(rows, 'product').orders, null);
  assert.ok(!summaryOf(sumRows(rows, 'product')).some(s => s.label === 'Orders'));
});

test('totals over all lines', () => {
  const t = totalsOf([L(1), L(2, { order_id: 2, dispatched_qty: 50, status: 'in_production' })]);
  assert.equal(t.orders, 2);
  assert.equal(t.customers, 1);
  assert.equal(t.pending_qty, 450);
  assert.equal(t.pending_value, 4500);
});

test('export: one section per company outside the company view', () => {
  const cols = [{ key: 'customer_name', label: 'Company' }, { key: 'po_number', label: 'PO' }];
  const lines = [L(1), L(2, { customer_id: 8, customer_name: 'Swiss', order_id: 3 })];
  const po = buildReportExportSpec({ view: 'po', rows: groupLines(lines, 'po'), columns: cols, title: 'Status Report' });
  assert.equal(po.sections.length, 2);
  assert.deepEqual(po.sections.map(s => s.heading), ['Fluence', 'Swiss']);
  assert.ok(po.sections.every(s => !s.columns.some(c => c.key === 'customer_name')));
  assert.ok(po.summary.length > 0);
  const co = buildReportExportSpec({ view: 'company', rows: groupLines(lines, 'company'), columns: cols, title: 'Status Report' });
  assert.equal(co.sections, undefined);
  assert.equal(co.rows.length, 2);
  // A single company stays one plain table.
  const one = buildReportExportSpec({ view: 'lines', rows: groupLines([L(1)], 'lines'), columns: cols, title: 'Status Report' });
  assert.equal(one.sections, undefined);
});
