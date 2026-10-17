// Exact money arithmetic for the HR & Payroll module (hr/money.js).
//
// The payroll engine has to land within half a paisa of the workbook it replaces,
// so amounts are BigInt rationals and the only rounding is toPaise(), done once
// per component. Expected values below are hand-derived literals. Rationals are
// compared with cmp(), or as lowest-terms 'n/d' strings — never with deepEqual.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rat, add, sub, mul, div, neg, cmp, isZero, isNeg, min, max,
  toPaise, fromPaise, fmtPaise, fmtExact, fmtDecimal, roundRupee,
} from './hr/money.js';

// A Rat as 'n/d' — independent of money.js's own formatters.
const frac = (r) => `${r.n}/${r.d}`;
const ratio = (n, d) => div(rat(n), rat(d));

// ── The worked examples from the task brief ───────────────────────────
test('brief examples: parsing, arithmetic, paise rounding, formatting', () => {
  assert.equal(cmp(rat('86.37'), div(rat(8637), rat(100))), 0);
  assert.equal(fmtDecimal(rat('10,000')), '10000'); assert.equal(fmtDecimal(rat('86.370')), '86.37');
  assert.equal(fmtDecimal(rat('0.1')), '0.1');
  assert.equal(toPaise(div(rat('36000'), rat('31'))), 116129n);               // 1161.2903… → 1161.29
  assert.equal(toPaise(rat('0.005')), 1n);
  assert.equal(toPaise(rat('0.0049')), 0n);
  assert.equal(toPaise(rat('-0.005')), -1n);
  assert.equal(cmp(add(rat(0.1), rat(0.2)), rat('0.3')), 0);
  assert.throws(() => div(rat(1), rat(0)), RangeError);
  assert.equal(fmtPaise(-150n), '-1.50');
  assert.equal(fmtPaise(5n), '0.05');
  assert.equal(cmp(rat(1e-7), div(rat(1), rat(10000000))), 0);
  assert.equal(cmp(rat('₹ 10,000'), rat(10000)), 0);
  assert.throws(() => rat('abc'), TypeError);
  assert.equal(roundRupee(2400049n), 2400000n);
  assert.equal(roundRupee(2400050n), 2400100n);
});

// ── rat(): parsing ────────────────────────────────────────────────────
test('rat: decimals parse exactly, in lowest terms, with a positive denominator', () => {
  const rows = [
    ['86.37', '8637/100'], ['0.1', '1/10'], ['0.50', '1/2'], ['-0.5', '-1/2'], ['12', '12/1'],
    ['0', '0/1'], ['-0', '0/1'], ['-0.0', '0/1'], ['.5', '1/2'], ['5.', '5/1'], ['+7.25', '29/4'],
    ['007.500', '15/2'], ['123456789.125', '987654313/8'],
  ];
  for (const [input, want] of rows) assert.equal(frac(rat(input)), want, `rat(${input})`);
});

test('rat: a JS number goes through its shortest round-trip decimal, so 0.1 is exactly 1/10', () => {
  const rows = [
    [0.1, '1/10'], [0.2, '1/5'], [1161.29, '116129/100'], [100, '100/1'], [-2.5, '-5/2'], [-0, '0/1'],
    [1e-7, '1/10000000'], [1.5e-7, '3/20000000'], [1e21, '1000000000000000000000/1'],   // String() gives '1e-7', '1e+21'
  ];
  for (const [input, want] of rows) assert.equal(frac(rat(input)), want, `rat(${input})`);
});

test('rat: bigint and Rat inputs are accepted', () => {
  assert.equal(frac(rat(5n)), '5/1');
  assert.equal(frac(rat(-3n)), '-3/1');
  assert.equal(frac(rat(rat('2.5'))), '5/2');
});

test('rat: strips commas, ₹, Rs and spaces', () => {
  const rows = [
    ['10,000', '10000/1'], ['₹ 10,000', '10000/1'], ['₹10,00,000.50', '2000001/2'],   // lakh grouping
    ['Rs 10,000', '10000/1'], ['Rs. 10,000', '10000/1'], ['RS. 1,250.5', '2501/2'],
    ['-₹ 500', '-500/1'], ['₹ -500', '-500/1'], [' 1 234 ', '1234/1'],            // NBSP, as pasted from a PDF
    ['Rs.10,000.25', '40001/4'], ['rs.5', '5/1'],                // the dot after Rs is not a decimal point
  ];
  for (const [input, want] of rows) assert.equal(frac(rat(input)), want, `rat(${input})`);
});

test('rat: exponent notation shifts the scale', () => {
  const rows = [
    ['1e3', '1000/1'], ['1E3', '1000/1'], ['2.5e+2', '250/1'], ['1.5e-3', '3/2000'],
    ['-4.5E-1', '-9/20'], ['12e0', '12/1'], ['1.25e2', '125/1'], ['0.001e3', '1/1'], ['5e-1', '1/2'],
  ];
  for (const [input, want] of rows) assert.equal(frac(rat(input)), want, `rat(${input})`);
});

test('rat: anything that is not a number is a TypeError', () => {
  const bad = [
    '', '   ', '₹', 'Rs.', 'abc', '12abc', '1.2.3', '1e', 'e5', '.', '-', '+', '--5', '0x10', 'NaN', 'Infinity',
    NaN, Infinity, -Infinity, null, undefined, true, {}, [], { n: 1, d: 2 },     // a Rat's fields must be bigint
  ];
  for (const input of bad) assert.throws(() => rat(input), TypeError, `rat(${String(input)})`);
});

test('rat: an exponent too big to be a payroll figure is refused before it can stall the server', () => {
  // A 12-character text cell, '1e999999999', used to block the thread for ~12 s and then throw RangeError.
  const absurd = ['1e1001', '1e-1001', '1e5000', '1e999999999', '1e-999999999', '1.5e1002', '0.001e1004'];
  for (const input of absurd) assert.throws(() => rat(input), TypeError, `rat(${input})`);
});

test('rat: 10^1000 either way is still accepted, and so is every JS number', () => {
  assert.equal(rat('1e1000').n, 10n ** 1000n);
  assert.equal(rat('1e-1000').d, 10n ** 1000n);
  assert.equal(rat('1.5e1001').n, 15n * 10n ** 1000n);
  assert.equal(cmp(rat(Number.MAX_VALUE), mul(rat('17976931348623157'), rat('1e292'))), 0);   // 1.7976931348623157e+308
  assert.equal(cmp(rat(Number.MIN_VALUE), div(rat(5), rat('1e324'))), 0);                      // 5e-324
});

test('every Rat is frozen, so no caller can corrupt a shared amount', () => {
  for (const r of [rat('1.5'), add(rat(1), rat(2)), neg(rat(1)), fromPaise(150n)]) {
    assert.ok(Object.isFrozen(r));
    assert.throws(() => { r.n = 0n; }, TypeError);
  }
});

// ── Arithmetic ────────────────────────────────────────────────────────
test('add, sub, mul, div are exact and stay in lowest terms', () => {
  assert.equal(frac(add(ratio(1, 3), ratio(1, 6))), '1/2');
  assert.equal(frac(add(rat('0.1'), rat('0.2'))), '3/10');
  assert.equal(frac(add(rat('-1.5'), rat('1.5'))), '0/1');
  assert.equal(frac(sub(rat('0.3'), rat('0.1'))), '1/5');
  assert.equal(frac(sub(rat(1), rat('2.5'))), '-3/2');
  assert.equal(frac(mul(rat('0.1'), rat('0.1'))), '1/100');
  assert.equal(frac(mul(rat(-2), rat('-0.5'))), '1/1');
  assert.equal(frac(mul(rat(0), rat(-7))), '0/1');
  assert.equal(frac(mul(ratio(1, 3), rat(3))), '1/1');
  assert.equal(frac(div(rat(1), rat(3))), '1/3');
  assert.equal(frac(div(rat('0.5'), rat('0.25'))), '2/1');
});

test('div keeps the denominator positive by moving the sign to the numerator', () => {
  assert.equal(frac(div(rat(1), rat(-2))), '-1/2');
  assert.equal(frac(div(rat(-3), rat(-6))), '1/2');
  assert.equal(frac(div(rat(0), rat(-5))), '0/1');
});

test('neg flips the sign and leaves zero as 0/1', () => {
  assert.equal(frac(neg(rat('2.5'))), '-5/2');
  assert.equal(frac(neg(rat('-2.5'))), '5/2');
  assert.equal(frac(neg(rat(0))), '0/1');
});

test('summing ten ₹0.10 items is exactly ₹1 (a float sum gives 0.9999999999999999)', () => {
  let total = rat(0);
  for (let i = 0; i < 10; i++) total = add(total, rat('0.1'));
  assert.equal(frac(total), '1/1');
});

test('div: a zero divisor is a RangeError, including a zero that came out of arithmetic', () => {
  assert.throws(() => div(rat(1), rat(0)), RangeError);
  assert.throws(() => div(rat(0), rat(0)), RangeError);
  assert.throws(() => div(rat(5), sub(rat('0.3'), add(rat('0.1'), rat('0.2')))), RangeError);
});

// ── Comparison ────────────────────────────────────────────────────────
test('cmp orders rationals, including negatives and unlike denominators', () => {
  assert.equal(cmp(rat(1), rat(2)), -1);
  assert.equal(cmp(rat(2), rat(1)), 1);
  assert.equal(cmp(rat(-1), rat(-2)), 1);
  assert.equal(cmp(rat(-2), rat(-1)), -1);
  assert.equal(cmp(rat(-1), rat(1)), -1);
  assert.equal(cmp(rat(3), rat(3)), 0);
  assert.equal(cmp(ratio(3, 7), ratio(4, 9)), -1);          // 27 < 28
  assert.equal(cmp(ratio(1, -3), ratio(1, -2)), 1);         // -1/3 > -1/2
  assert.equal(cmp(ratio(1, 3), rat('0.333')), 1);
  assert.equal(cmp(ratio(1, 3), rat('0.334')), -1);
  assert.equal(cmp(rat('0.50'), ratio(1, 2)), 0);
  assert.equal(cmp(rat('0'), rat('-0')), 0);
});

test('isZero and isNeg', () => {
  assert.equal(isZero(rat(0)), true);
  assert.equal(isZero(rat('0.0')), true);
  assert.equal(isZero(rat('0.001')), false);
  assert.equal(isZero(sub(rat('0.3'), add(rat('0.1'), rat('0.2')))), true);   // as floats: -5.55e-17
  assert.equal(isNeg(rat('-0.001')), true);
  assert.equal(isNeg(neg(rat('5'))), true);
  assert.equal(isNeg(rat('5')), false);
  assert.equal(isNeg(rat(0)), false);
  assert.equal(isNeg(rat('-0')), false);
});

test('min and max pick by value, whichever side the answer is on', () => {
  assert.equal(frac(min(rat(2), rat(-3))), '-3/1');
  assert.equal(frac(min(rat(-3), rat(2))), '-3/1');
  assert.equal(frac(max(rat(2), rat(-3))), '2/1');
  assert.equal(frac(max(rat(-3), rat(2))), '2/1');
  assert.equal(frac(min(ratio(1, 3), rat('0.33'))), '33/100');
  assert.equal(frac(max(ratio(1, 3), rat('0.33'))), '1/3');
  assert.equal(frac(min(rat('0.50'), ratio(1, 2))), '1/2');   // equal values: either operand is the answer
  assert.equal(frac(max(rat('0.50'), ratio(1, 2))), '1/2');
});

// ── Paise ─────────────────────────────────────────────────────────────
test('toPaise rounds half away from zero, not half-even and not floor', () => {
  const rows = [
    ['0.005', 1n], ['0.0049', 0n], ['-0.005', -1n], ['-0.0049', 0n],
    ['1.005', 101n], ['-1.005', -101n],         // as a float, 1.005 × 100 = 100.49999999999999
    ['2.675', 268n], ['0.015', 2n], ['0.035', 4n],
    ['0.025', 3n], ['-0.025', -3n],             // half-even would give 2
    ['0.995', 100n], ['0.01', 1n], ['0.004', 0n], ['1161.29', 116129n], ['0', 0n], ['5', 500n], ['-5', -500n],
    ['12345678901234567890.125', 1234567890123456789013n],     // beyond 2^53: no float anywhere
  ];
  for (const [input, want] of rows) assert.equal(toPaise(rat(input)), want, `toPaise(${input})`);
  assert.equal(toPaise(ratio(100, 3)), 3333n);        // 3333.33
  assert.equal(toPaise(ratio(200, 3)), 6667n);        // 6666.67
  assert.equal(toPaise(ratio(-200, 3)), -6667n);
  assert.equal(toPaise(ratio(1, 6)), 17n);            // 16.67
  assert.equal(toPaise(ratio(1, 3)), 33n);            // 33.33
});

test('fromPaise builds the exact rupee value', () => {
  assert.equal(frac(fromPaise(12345n)), '2469/20');   // 123.45
  assert.equal(frac(fromPaise(-150n)), '-3/2');
  assert.equal(frac(fromPaise(100n)), '1/1');
  assert.equal(frac(fromPaise(1n)), '1/100');
  assert.equal(frac(fromPaise(0n)), '0/1');
});

test('fromPaise and toPaise are inverses', () => {
  for (const p of [0n, 1n, -1n, 49n, 50n, 99n, 100n, 116129n, -116129n, 10n ** 30n + 7n]) {
    assert.equal(toPaise(fromPaise(p)), p, `paise ${p}`);
  }
});

test('paise are BigInt: a Number of paise is refused', () => {
  assert.throws(() => fromPaise(150), TypeError);
  assert.throws(() => fromPaise(1.5), TypeError);
  assert.throws(() => fmtPaise(150), TypeError);
  assert.throws(() => roundRupee(150), TypeError);
});

test('roundRupee: nearest rupee, ties away from zero, result still in paise', () => {
  const rows = [
    [2400049n, 2400000n], [2400050n, 2400100n], [0n, 0n], [49n, 0n], [50n, 100n], [99n, 100n], [100n, 100n],
    [149n, 100n], [150n, 200n], [250n, 300n],                 // half-even would give 200 for 250
    [-49n, 0n], [-50n, -100n], [-51n, -100n], [-149n, -100n], [-150n, -200n],   // a negative mirrors its positive
    [-2400049n, -2400000n], [-2400050n, -2400100n],
    [10n ** 24n + 50n, 10n ** 24n + 100n],
  ];
  for (const [paise, want] of rows) assert.equal(roundRupee(paise), want, `roundRupee(${paise})`);
});

// ── Formatting ────────────────────────────────────────────────────────
test('fmtPaise: two decimals, zero-padded, sign in front', () => {
  const rows = [
    [-150n, '-1.50'], [5n, '0.05'], [0n, '0.00'], [1n, '0.01'], [99n, '0.99'], [100n, '1.00'],
    [12345n, '123.45'], [116129n, '1161.29'], [-5n, '-0.05'], [-99n, '-0.99'],
    [10n ** 20n, '1000000000000000000.00'],
  ];
  for (const [paise, want] of rows) assert.equal(fmtPaise(paise), want, `fmtPaise(${paise})`);
});

test('fmtExact truncates toward zero and pads to the requested places (default 6)', () => {
  assert.equal(fmtExact(ratio(2, 3), 2), '0.66');                  // not 0.67
  assert.equal(fmtExact(ratio(-2, 3), 2), '-0.66');
  assert.equal(fmtExact(ratio(1, 3)), '0.333333');
  assert.equal(fmtExact(ratio(1, 7)), '0.142857');
  assert.equal(fmtExact(rat('0.9999999')), '0.999999');            // no carry into the whole part
  assert.equal(fmtExact(rat('1.5'), 4), '1.5000');
  assert.equal(fmtExact(rat('0'), 3), '0.000');
  assert.equal(fmtExact(rat('0.05'), 2), '0.05');
  assert.equal(fmtExact(rat('1234.5'), 1), '1234.5');
  assert.equal(fmtExact(rat('-100.999'), 2), '-100.99');
  assert.equal(fmtExact(rat('7.9'), 0), '7');
  assert.equal(fmtExact(rat('-7.9'), 0), '-7');
  assert.equal(fmtExact(rat('100'), 0), '100');
  assert.equal(fmtExact(rat('-0.001'), 2), '0.00');                // never "-0.00"
  assert.equal(fmtExact(rat('12345678901234567890.123456789'), 9), '12345678901234567890.123456789');
});

test('fmtDecimal prints the shortest exact decimal', () => {
  const rows = [
    ['10,000', '10000'], ['86.370', '86.37'], ['0.1', '0.1'], ['-1.50', '-1.5'], ['0.0', '0'], ['-0', '0'],
    ['100', '100'], ['1200.50', '1200.5'], ['0.0125', '0.0125'], ['-0.05', '-0.05'],
    ['1e-7', '0.0000001'], ['2.50e3', '2500'],
    ['0.0000000001', '0.0000000001'], ['0.1234567891', '0.1234567891'],       // ten places
    ['123456789012345678901234567890.1234567890', '123456789012345678901234567890.123456789'],
  ];
  for (const [input, want] of rows) assert.equal(fmtDecimal(rat(input)), want, `fmtDecimal(${input})`);
});

test('fmtDecimal prints a terminating value exactly, however many places it needs', () => {
  const rows = [
    [rat('0.00048828125'), '0.00048828125'],                 // 1/2048: eleven places
    [rat('-0.00048828125'), '-0.00048828125'],
    [rat(1161.2903225806451), '1161.2903225806451'],         // the double nearest 36000/31, as a workbook stores it: thirteen places
    [rat('0.1234567890123'), '0.1234567890123'],             // thirteen places
    [rat('-1161.2903225806452'), '-1161.2903225806452'],     // thirteen places, negative
    [rat(0.30000000000000004), '0.30000000000000004'],       // seventeen places: the shortest exact form, not '0.3000000000'
    [rat('0.30'), '0.3'], [rat(0.3), '0.3'], [rat('1.50000000000000'), '1.5'],     // trailing zeros still go
    [rat(1e-12), '0.000000000001'],
    [ratio(1, 1048576), '0.00000095367431640625'],           // 2^20: twenty places
    [ratio(1, 244140625), '0.000000004096'],                 // 5^12: only fives in the denominator, twelve places
    [ratio(1, 625000), '0.0000016'],                         // 2^3 × 5^7: as many places as the larger exponent, 7
    [ratio(1, 6400), '0.00015625'],                          // 2^8 × 5^2: 8
    [rat(5e-324), `0.${'0'.repeat(323)}5`],                  // the smallest double needs 324 places: no cap anywhere
  ];
  for (const [r, want] of rows) assert.equal(fmtDecimal(r), want, want);
});

test('fmtDecimal cuts at ten places only when the value never terminates', () => {
  assert.equal(fmtDecimal(ratio(1, 3)), '0.3333333333');
  assert.equal(fmtDecimal(ratio(-2, 3)), '-0.6666666666');         // truncated, not rounded up to ...67
  assert.equal(fmtDecimal(ratio(22, 7)), '3.1428571428');
  assert.equal(fmtDecimal(ratio(1, 6)), '0.1666666666');           // a factor of 2 does not make it terminate
  assert.equal(fmtDecimal(ratio(1, 6144)), '0.0001627604');        // 2^11 × 3: long, and the 3 means it never ends
  assert.equal(fmtDecimal(ratio(36000, 31)), '1161.2903225806');   // exactly 36000/31 never ends, unlike its double
});

test('fmtDecimal then rat gives the value back, so stored strings lose nothing', () => {
  const texts = [
    '0', '1', '-1', '0.1', '86.37', '-1161.29', '0.0000000001',                          // up to ten places
    '0.00048828125', '1161.2903225806451', '-1161.2903225806452', '0.30000000000000004', // eleven to seventeen
    '0.000000000000000000000001', '123456789012345678901234567890.123456789012345',
  ];
  for (const s of texts) assert.equal(cmp(rat(fmtDecimal(rat(s))), rat(s)), 0, s);
  // pg and exceljs hand numbers over as JS doubles, which String() writes with up to 17 digits
  const doubles = [1161.2903225806451, 0.30000000000000004, 0.3333333333333333, 0.6666666666666666, -123.45678901234568, 1e-12, 5e-324];
  for (const x of doubles) assert.equal(cmp(rat(fmtDecimal(rat(x))), rat(x)), 0, String(x));
});

// ── Misuse fails loudly ───────────────────────────────────────────────
test('raw JS numbers are refused instead of turning into NaN rationals', () => {
  const slips = [
    () => add(0.1, 0.2), () => add(rat(1), 2), () => sub(0.3, 0.1), () => mul(2, 3), () => div(1, 3), () => neg(0.5),
    () => cmp(0.1, 0.2), () => min(1, 2), () => max(1, 2), () => isZero(0), () => isNeg(-5),
    () => toPaise(1.5), () => fmtExact(1.5), () => fmtDecimal(1.5),
  ];
  for (const slip of slips) assert.throws(slip, TypeError, String(slip));
});

// ── Composition ───────────────────────────────────────────────────────
test('a salary line composes exactly: 36000 over 31 days, 2.5 days absent', () => {
  const earned = mul(div(rat('36000'), rat('31')), sub(rat(31), rat('2.5')));
  assert.equal(frac(earned), '1026000/31');        // 36000 × 28.5 / 31
  assert.equal(toPaise(earned), 3309677n);         // 33096.774193… → 33096.77
  assert.equal(fmtPaise(toPaise(earned)), '33096.77');
});
