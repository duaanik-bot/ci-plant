// hr/payment-status.js: every line in exactly one of paid / unpaid / on hold, with exact totals. Synthetic figures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NO_CHANNEL, approvalOf, bucketOf, lineAmount, paymentTotals } from './hr/payment-status.js';

test('buckets: paid, on hold, and everything else is unpaid', () => {
  assert.deepEqual(['pending', 'paid', 'on_hold', 'failed', 'reversed', undefined].map(bucketOf),
    ['unpaid', 'paid', 'on_hold', 'unpaid', 'unpaid', 'unpaid']);
});

test('a paid line counts what was paid; the others what is payable; blank is zero', () => {
  assert.equal(lineAmount({ payment_status: 'paid', payable: '100.00', paid_amount: '100.00' }), 10000n);
  assert.equal(lineAmount({ payment_status: 'paid', payable: '100.00', paid_amount: null }), 10000n);
  assert.equal(lineAmount({ payment_status: 'on_hold', payable: 0.1 }), 10n);
  assert.equal(lineAmount({ payment_status: 'pending', payable: null }), 0n);
});

test('totals are exact strings, add up to the run, and split by channel (no channel last)', () => {
  const t = paymentTotals([
    { payment_status: 'paid', pay_channel: 'CASH', payable: '0.10', paid_amount: '0.10' },
    { payment_status: 'pending', pay_channel: 'CASH', payable: '0.20' },
    { payment_status: 'failed', pay_channel: 'BANK', payable: 1000.01 },
    { payment_status: 'on_hold', pay_channel: null, payable: '12345678.99' },
  ]);
  assert.deepEqual(t.paid, { count: 1, amount: '0.10' });
  assert.deepEqual(t.unpaid, { count: 2, amount: '1000.21' });
  assert.deepEqual(t.on_hold, { count: 1, amount: '12345678.99' });
  assert.deepEqual(Object.keys(t.by_channel), ['BANK', 'CASH', NO_CHANNEL]);
  assert.deepEqual(t.by_channel.CASH, {
    paid: { count: 1, amount: '0.10' }, unpaid: { count: 1, amount: '0.20' }, on_hold: { count: 0, amount: '0.00' },
    approved: { count: 0, amount: '0.00' }, unapproved: { count: 2, amount: '0.30' },
  });
  const zero = { count: 0, amount: '0.00' };
  assert.deepEqual(paymentTotals([]), {
    paid: zero, unpaid: zero, on_hold: zero, approved: zero, unapproved: zero,
    reconciliation: { approved: zero, approved_paid: zero, approved_unpaid: zero, approved_on_hold: zero, paid_unapproved: zero, balanced: true },
    by_channel: {},
  });
});

test('approval: anything but approved is unapproved', () => {
  assert.deepEqual(['approved', 'unapproved', null, undefined, 'APPROVED'].map((a) => approvalOf({ approval_status: a })),
    ['approved', 'unapproved', 'unapproved', 'unapproved', 'unapproved']);
  assert.equal(approvalOf(null), 'unapproved');
});

test('the approved lines reconcile: approved = paid + unpaid + on hold among them', () => {
  const t = paymentTotals([
    { approval_status: 'approved', payment_status: 'paid', pay_channel: 'BANK', payable: '100.00', paid_amount: '100.00' },
    { approval_status: 'approved', payment_status: 'pending', pay_channel: 'BANK', payable: '0.05' },
    { approval_status: 'approved', payment_status: 'on_hold', pay_channel: 'CASH', payable: '20.10' },
    { approval_status: 'unapproved', payment_status: 'on_hold', pay_channel: 'CASH', payable: '7.00' },
    { approval_status: 'unapproved', payment_status: 'pending', pay_channel: 'CASH', payable: '3.00' },
  ]);
  assert.deepEqual(t.approved, { count: 3, amount: '120.15' });
  assert.deepEqual(t.unapproved, { count: 2, amount: '10.00' });
  assert.deepEqual(t.reconciliation, {
    approved: { count: 3, amount: '120.15' },
    approved_paid: { count: 1, amount: '100.00' },
    approved_unpaid: { count: 1, amount: '0.05' },
    approved_on_hold: { count: 1, amount: '20.10' },
    paid_unapproved: { count: 0, amount: '0.00' },
    balanced: true,
  });
  assert.deepEqual(t.by_channel.BANK.approved, { count: 2, amount: '100.05' });
  // A paid line that is not approved is reported and the reconciliation is not balanced.
  const off = paymentTotals([{ approval_status: 'unapproved', payment_status: 'paid', payable: '5.00', paid_amount: '5.00' }]);
  assert.deepEqual(off.reconciliation.paid_unapproved, { count: 1, amount: '5.00' });
  assert.equal(off.reconciliation.balanced, false);
});
