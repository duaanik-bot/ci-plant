import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finFormatINR } from '../../client/src/lib/finance/money.js';
import { FIN_CASH_LIMITS, finCashLines, finCashWarnings, finTopUpPaise } from '../../client/src/lib/finance/cash.js';

const A = 1, T = 2, P = 3, TO = 4, FROM = 5;
const L = (ledger_id, debit_paise, credit_paise) => ({ ledger_id, debit_paise, credit_paise });

test('receive with TDS: Dr account, Dr TDS, Cr party for the sum', () => {
  assert.deepEqual(
    finCashLines({ entry_type: 'receive', account_ledger_id: A, other_ledger_id: P, amount_paise: 8_000_000, tds_paise: 160_000, tds_ledger_id: T }),
    [L(A, 8_000_000, 0), L(T, 160_000, 0), L(P, 0, 8_160_000)],
  );
});

test('pay with TDS: Dr party for the sum, Cr account, Cr TDS', () => {
  assert.deepEqual(
    finCashLines({ entry_type: 'pay', account_ledger_id: A, other_ledger_id: P, amount_paise: 1_000_000, tds_paise: 20_000, tds_ledger_id: T }),
    [L(P, 1_020_000, 0), L(A, 0, 1_000_000), L(T, 0, 20_000)],
  );
});

test('transfer: Dr the to-account, Cr the from-account', () => {
  assert.deepEqual(
    finCashLines({ entry_type: 'transfer', account_ledger_id: FROM, other_ledger_id: TO, amount_paise: 25_000_000 }),
    [L(TO, 25_000_000, 0), L(FROM, 0, 25_000_000)],
  );
});

test('TDS 0 adds no line', () => {
  assert.deepEqual(
    finCashLines({ entry_type: 'receive', account_ledger_id: A, other_ledger_id: P, amount_paise: 500, tds_paise: 0, tds_ledger_id: T }),
    [L(A, 500, 0), L(P, 0, 500)],
  );
  assert.deepEqual(
    finCashLines({ entry_type: 'pay', account_ledger_id: A, other_ledger_id: P, amount_paise: 500 }),
    [L(P, 500, 0), L(A, 0, 500)],
  );
});

test('TDS without a ledger throws RangeError; so does TDS on a transfer', () => {
  assert.throws(() => finCashLines({ entry_type: 'receive', account_ledger_id: A, other_ledger_id: P, amount_paise: 500, tds_paise: 10 }), RangeError);
  assert.throws(() => finCashLines({ entry_type: 'transfer', account_ledger_id: FROM, other_ledger_id: TO, amount_paise: 500, tds_paise: 10, tds_ledger_id: T }), RangeError);
});

test('a bad amount or TDS throws RangeError', () => {
  const base = { entry_type: 'receive', account_ledger_id: A, other_ledger_id: P };
  for (const amount_paise of [0, -5, 1.5, NaN, '100', null]) {
    assert.throws(() => finCashLines({ ...base, amount_paise }), RangeError);
  }
  for (const tds_paise of [-1, 0.5, NaN]) {
    assert.throws(() => finCashLines({ ...base, amount_paise: 100, tds_paise, tds_ledger_id: T }), RangeError);
  }
});

const W = (o) => finCashWarnings({
  entry_type: 'receive', is_cash: true, is_holder: false, account_name: 'Cash in hand', amount_paise: 100,
  party_cash_today_paise: 0, balance_after_paise: 0, on_account_paise: 0, ...o,
});
const S269 = { code: 'S269ST', sentence: 'Cash received from this party today reaches ₹2,00,000 (Income-tax Act s.269ST).' };
const S40 = { code: 'S40A3', sentence: 'Cash paid to this party today is over ₹10,000 (Income-tax Act s.40A(3)).' };

test('limits are frozen constants', () => {
  assert.deepEqual({ ...FIN_CASH_LIMITS }, { s269stPaise: 20_000_000, s40a3Paise: 1_000_000 });
  assert.ok(Object.isFrozen(FIN_CASH_LIMITS));
});

test('S269ST: at 20_000_000, not at 19_999_999, not when not cash', () => {
  assert.deepEqual(W({ party_cash_today_paise: 20_000_000 }), [S269]);
  assert.deepEqual(W({ party_cash_today_paise: 19_999_999 }), []);
  assert.deepEqual(W({ party_cash_today_paise: 20_000_000, is_cash: false }), []);
  assert.deepEqual(W({ entry_type: 'pay', party_cash_today_paise: 20_000_000 }), [S40]);
});

test('S40A3: over 1_000_000 only, pay and cash only', () => {
  assert.deepEqual(W({ entry_type: 'pay', party_cash_today_paise: 1_000_001 }), [S40]);
  assert.deepEqual(W({ entry_type: 'pay', party_cash_today_paise: 1_000_000 }), []);
  assert.deepEqual(W({ entry_type: 'pay', party_cash_today_paise: 1_000_001, is_cash: false }), []);
  assert.deepEqual(W({ entry_type: 'receive', party_cash_today_paise: 1_000_001 }), []);
});

test('BELOW_ZERO for an account; a holder going below zero gives HOLDER_SHORT, not BELOW_ZERO', () => {
  assert.deepEqual(W({ entry_type: 'pay', balance_after_paise: -1 }), [
    { code: 'BELOW_ZERO', sentence: 'This takes Cash in hand below zero.' },
  ]);
  assert.deepEqual(W({ entry_type: 'pay', is_holder: true, account_name: 'Holder A', balance_after_paise: -1 }), [
    { code: 'HOLDER_SHORT', sentence: 'Holder A holds less than this.' },
  ]);
  assert.deepEqual(W({ entry_type: 'pay', balance_after_paise: 0 }), []);
});

test('ON_ACCOUNT names finFormatINR(on_account_paise)', () => {
  assert.deepEqual(W({ on_account_paise: 123_456 }), [
    { code: 'ON_ACCOUNT', sentence: `${finFormatINR(123_456)} stays on account.` },
  ]);
  assert.deepEqual(W({ on_account_paise: 0 }), []);
});

test('warnings come in a fixed order', () => {
  assert.deepEqual(
    W({ on_account_paise: 100, party_cash_today_paise: 20_000_000, balance_after_paise: -5 }).map(w => w.code),
    ['ON_ACCOUNT', 'S269ST', 'BELOW_ZERO'],
  );
});

test('finTopUpPaise', () => {
  assert.equal(finTopUpPaise({ float_paise: 5_000_000, holds_paise: 1_000_000 }), 4_000_000);
  assert.equal(finTopUpPaise({ float_paise: 5_000_000, holds_paise: 5_000_000 }), 0);
  assert.equal(finTopUpPaise({ float_paise: 5_000_000, holds_paise: 6_000_000 }), 0);
  assert.equal(finTopUpPaise({ float_paise: null, holds_paise: 1_000_000 }), 0);
});
