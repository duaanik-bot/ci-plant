import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finToPaise, finToPaiseTyped, finFromPaise, finFormatINR, finParseTallyAmount } from '../../client/src/lib/finance/money.js';
import { finIsValidDate, finFyOf, finMonthsOfFy, finDayBefore } from '../../client/src/lib/finance/fy.js';

test('database floats become exact paise', () => {
  assert.equal(finToPaise(1234.56), 123456);
  assert.equal(finToPaise(0.1 + 0.2), 30);
  assert.equal(finToPaise('99999999.99'), 9999999999);
  assert.equal(finToPaise(-12.5), -1250);
  assert.equal(finToPaise(null), 0);
});

test('typed amounts: Indian or Western commas, at most two decimals, never negative', () => {
  assert.equal(finToPaiseTyped('1,20,000'), 12000000);
  assert.equal(finToPaiseTyped('1,20,000.50'), 12000050);
  assert.equal(finToPaiseTyped('120,000.5'), 12000050);
  assert.equal(finToPaiseTyped(' 75 '), 7500);
  assert.equal(finToPaiseTyped('0'), 0);
  for (const bad of ['', '  ', '10.005', '-50', 'abc', '1e5', '12..5', '100000000000000'])
    assert.throws(() => finToPaiseTyped(bad), /amount/i, `should refuse ${JSON.stringify(bad)}`);
});

test('paise back to NUMERIC text and to rupees on screen', () => {
  assert.equal(finFromPaise(123450), '1234.50');
  assert.equal(finFromPaise(-5), '-0.05');
  assert.equal(finFromPaise(0), '0.00');
  assert.equal(finFormatINR(12345600), '₹1,23,456.00');
  assert.equal(finFormatINR(1234567890123), '₹12,34,56,78,901.23');
  assert.equal(finFormatINR(-12345600, { drcr: true }), '₹1,23,456.00 Cr');
  assert.equal(finFormatINR(5, { drcr: true }), '₹0.05 Dr');
  assert.equal(finFormatINR(0, { drcr: true }), '₹0.00');
});

test('Tally cells parse to signed paise', () => {
  assert.equal(finParseTallyAmount('1,23,456.00 Dr'), 12345600);
  assert.equal(finParseTallyAmount('1,23,456.00 Cr'), -12345600);
  assert.equal(finParseTallyAmount('(1,234.00)'), -123400);
  assert.equal(finParseTallyAmount('-1,234.00'), -123400);
  assert.equal(finParseTallyAmount('₹ 12,000'), 1200000);
  assert.equal(finParseTallyAmount(1500.5), 150050);
  assert.equal(finParseTallyAmount(''), 0);
  assert.equal(finParseTallyAmount(null), 0);
  assert.throws(() => finParseTallyAmount('twelve'), /amount/i);
});

test('calendar dates and the Indian financial year', () => {
  assert.ok(finIsValidDate('2027-02-28'));
  assert.ok(finIsValidDate('2028-02-29'));
  for (const bad of ['2027-02-29', '2027-13-01', '27-01-05', '2027-1-5', '', null])
    assert.ok(!finIsValidDate(bad), String(bad));
  assert.deepEqual(finFyOf('2027-03-31'), { label: '2026-27', short: '2627', start: '2026-04-01', end: '2027-03-31' });
  assert.deepEqual(finFyOf('2027-04-01'), { label: '2027-28', short: '2728', start: '2027-04-01', end: '2028-03-31' });
  const m = finMonthsOfFy('2026-27');
  assert.equal(m.length, 12);
  assert.deepEqual(m[0], { month_no: 1, label: 'Apr 2026', start_date: '2026-04-01', end_date: '2026-04-30' });
  assert.deepEqual(m[10], { month_no: 11, label: 'Feb 2027', start_date: '2027-02-01', end_date: '2027-02-28' });
  assert.equal(finDayBefore('2027-01-01'), '2026-12-31');
  assert.equal(finDayBefore('2028-03-01'), '2028-02-29');
});

// Fix round 1: a stray comma used to be dropped silently, so a decimal comma ('1250,50') was stored as
// 100 times what was meant. A comma now passes only as Western (120,000) or Indian (1,20,000) grouping.
test('typed amounts: a comma outside a grouping place is refused, never dropped', () => {
  const sentence = { message: 'Enter an amount in rupees with at most two decimals' };
  for (const bad of ['1250,50', '12,5', '1,5', ',100', '100,', '1,,000', '12,34,5,678'])
    assert.throws(() => finToPaiseTyped(bad), sentence, `should refuse ${JSON.stringify(bad)}`);
  assert.equal(finToPaiseTyped('1,000'), 100000);
  assert.equal(finToPaiseTyped('12,34,56,789'), 12345678900); // 12,34,56,789 rupees
  assert.equal(finToPaiseTyped('1,234,567.89'), 123456789);
  // a decimal comma with two digits, grouping that is all one system, the fraction rules, and only the outside trimmed
  for (const bad of ['12,50', '0,50', '1,23,456,789', '1234,567', '123,45,678', '1,000.505', '1,000.', '1 000'])
    assert.throws(() => finToPaiseTyped(bad), sentence, `should refuse ${JSON.stringify(bad)}`);
  assert.equal(finToPaiseTyped(' 1,20,000.50 '), 12000050);
  assert.equal(finToPaiseTyped('1,000.5'), 100050);
});

// Ruling R11: a Tally cell keeps to the same comma rule as a typed amount. A stray comma used to be dropped here too,
// so '1250,50' became ₹1,25,050.00, a hundred times the balance it was; on an opening balance that is worse than a
// refused cell. A comma passes only in a Western (120,000) or Indian (1,20,000) grouping place, Dr/Cr and brackets or not.
test('Tally cells: a comma outside a grouping place is refused, never dropped (ruling R11)', () => {
  for (const bad of ['1250,50', '1250,50 Dr', '12,5 Cr', '(1,5)', '-100,', ',100', '1,,000', '12,34,5,678', '1,23,456,789.00 Dr', '₹ 12,50'])
    assert.throws(() => finParseTallyAmount(bad), /amount/i, `should refuse ${JSON.stringify(bad)}`);
  assert.equal(finParseTallyAmount('1,000.50 Cr'), -100050);
  assert.equal(finParseTallyAmount('12,34,56,789.00 Dr'), 12345678900);
  assert.equal(finParseTallyAmount('1,234,567.89'), 123456789);
  assert.equal(finParseTallyAmount('₹ 1,00,000'), 10000000);
  assert.equal(finParseTallyAmount('(59,000.00)'), -5900000);
  assert.equal(finParseTallyAmount('1250.50'), 125050, 'a decimal point is still a decimal point');
});
