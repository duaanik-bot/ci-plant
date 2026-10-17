// Payroll calculation engine (spec §8). Pure: no I/O, no database, no clock.
//
// computeLine() turns one person's pay setup and the month's inputs into earnings, deductions and
// pay, with the formula behind every rupee. All arithmetic is exact (money.js rationals). A figure
// is rounded to paise, half away from zero, once: when it becomes a component. Gross is the sum of
// the rounded earnings; exact.gross and exact.net_before_cap keep the unrounded values, so the July
// workbook can be matched to within half a paisa.
//
// The totals, in the order they are reached:
//   gross             the rounded earnings added up
//   net_before_cap    gross − every deduction wanted − paid_separately: the workbook's "Final
//                     Payment", which can be negative
//   total_deductions  what is actually taken, once the cap has trimmed the recoveries
//   net               gross − total_deductions (before paid_separately)
//   payable           net − paid_separately, never below 0, then rounded as the policy says
//
// Flags ({level, code, message}), returned blockers first:
//   block  NO_SETUP, ABSENT_EXCEEDS_DAYS, BILL_AMOUNT_MISSING, HOURS_WORKED_MISSING, PAID_SEPARATELY_EXCEEDS
//   warn   INSUFFICIENT_PAY, DEDUCTIONS_OVER_PCT, HIGH_OT, OT_NO_RATE, NO_BANK_DETAILS, OVERRIDE_CLAMPED,
//          PERSON_EXITED, NOT_EMPLOYED_THIS_MONTH
//   info   JOINED_MID_MONTH, LEFT_MID_MONTH, VARIANCE
//
// Days before joined_on and after exited_on are days not employed: unpaid, and the computed holiday
// (formula or fixed) shrinks to days employed ÷ days in the month. Absences do not touch holiday. A
// person employed no day at all earns nothing from the setup (basic and computed holiday are 0) and
// gets NOT_EMPLOYED_THIS_MONTH; only typed amounts (OT hours, misc, bonus, adjustments, a typed
// holiday, a bill amount) are still paid.
//
// Money comes back as 2-dp strings, quantities as plain decimals. Input that is wrong (a negative
// figure, an unknown pay basis, a malformed date) throws: a quietly wrong payslip is worse than a
// stopped run. What is merely missing for one person (no pay setup, no bill amount) is a flag.
// paid_leave_days is not read: paid leave is paid, so only absent_days reduce pay.

import {
  rat, add, sub, mul, div, neg, cmp, isZero, isNeg, min, max,
  toPaise, fromPaise, fmtPaise, fmtExact, fmtDecimal, roundRupee,
} from './money.js';

export const ENGINE_VERSION = 'hr-engine-1';

const ZERO = rat(0);
const ONE = rat(1);
const HUNDRED = rat(100);
const LEVEL_RANK = { block: 0, warn: 1, info: 2 };
const MONEY_FIELDS = [
  'daily_rate', 'basic', 'ot_amount', 'holiday_amount', 'misc_earning', 'bonus', 'adj_earnings', 'gross',
  'misc_deduction', 'adj_deductions', 'loan_recovery', 'advance_recovery', 'total_deductions',
  'paid_separately', 'net_before_cap', 'net', 'payable', 'rounding', 'advance_given', 'carried_advance',
];
// What a VARIANCE flag can name: the previous.components key, its label, and today's field.
const VARIANCE_PARTS = [
  ['BASIC', 'Basic', 'basic'], ['OT', 'Overtime', 'ot_amount'],
  ['HOLIDAY', 'Holiday', 'holiday_amount'], ['MISC', 'Misc', 'misc_earning'],
];

// ── Small helpers ─────────────────────────────────────────────────────

const given = (v) => v !== null && v !== undefined && !(typeof v === 'string' && v.trim() === '');
const opt = (v) => (given(v) ? rat(v) : ZERO);                  // an optional figure: not given counts as 0
const abs = (r) => (isNeg(r) ? neg(r) : r);
const sumRats = (rs) => rs.reduce((t, r) => add(t, r), ZERO);
const sumPaise = (ps) => ps.reduce((t, p) => t + p, 0n);

function nonNeg(r, name) {
  if (isNeg(r)) throw new RangeError(`engine: ${name} must not be negative`);
  return r;
}
const amountIn = (inputs, key) => nonNeg(opt(inputs[key]), `inputs.${key}`);

function positive(v, name) {
  const r = opt(v);
  if (cmp(r, ZERO) <= 0) throw new RangeError(`engine: ${name} must be more than 0`);
  return r;
}

function oneOf(v, allowed, fallback, name) {
  const x = given(v) ? v : fallback;
  if (!allowed.includes(x)) {
    throw new TypeError(`engine: ${name} must be ${allowed.join(' or ')}, got ${JSON.stringify(v)}`);
  }
  return x;
}

// ── Calendar ──────────────────────────────────────────────────────────

const MONTH_LENGTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const lengthOf = (year, month) => (month === 2 && isLeap(year) ? 29 : MONTH_LENGTH[month - 1]);
const dayKey = ([y, m, d]) => y * 10000 + m * 100 + d;

function parseMonth(month) {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!m) throw new TypeError(`engine: month must look like 2026-07, got ${JSON.stringify(month)}`);
  return [Number(m[1]), Number(m[2])];
}

// 'YYYY-MM-DD' (an ISO timestamp is read by its date) → [year, month, day]; not given → null.
function parseDay(value) {
  if (!given(value)) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(String(value));
  const ymd = m && m.slice(1).map(Number);
  if (!ymd || ymd[1] < 1 || ymd[1] > 12 || ymd[2] < 1 || ymd[2] > lengthOf(ymd[0], ymd[1])) {
    throw new TypeError(`engine: not a date (YYYY-MM-DD): ${JSON.stringify(value)}`);
  }
  return ymd;
}

export function daysInMonthOf(month) {
  const [year, m] = parseMonth(month);
  return lengthOf(year, m);
}

// The pay setup in force for a month: the latest effective_from on or before its 1st.
export function effectiveSetup(setups, month) {
  const [year, m] = parseMonth(month);
  const cutoff = dayKey([year, m, 1]);
  let best = null;
  let bestKey = -1;
  for (const s of setups || []) {
    const from = parseDay(s.effective_from);
    if (!from) throw new TypeError('engine: a pay setup needs effective_from');
    const key = dayKey(from);
    if (key <= cutoff && key > bestKey) { best = s; bestKey = key; }
  }
  return best;
}

// Which days of the month the person was employed (joined_on and exited_on are both inclusive).
// The dates decide; only a status of 'exited' with no exit date at all means the whole month.
function employment(person, year, mon, dim) {
  const here = year * 12 + mon;
  const at = ([y, m]) => y * 12 + m;
  const joined = parseDay(person.joined_on);
  const exited = parseDay(person.exited_on);
  let first = 1;
  let last = dim;
  if (joined) first = at(joined) < here ? 1 : at(joined) === here ? joined[2] : dim + 1;
  if (exited) last = at(exited) < here ? 0 : at(exited) === here ? exited[2] : dim;
  else if (person.status === 'exited') last = 0;
  const employed = Math.max(0, Math.min(last, dim) - first + 1);
  return {
    employed,
    notEmployed: dim - employed,
    joinedDay: joined && at(joined) === here && first > 1 ? first : 0,
    leftDay: exited && at(exited) === here && last < dim ? last : 0,
    exitedBefore: Boolean(exited) && at(exited) < here,
  };
}

// ── Text ──────────────────────────────────────────────────────────────

const INDIAN = new Intl.NumberFormat('en-IN');
// '1234567.50' → '12,34,567.50'. The whole part goes through Intl as a BigInt, so it stays exact.
const group = (text) => {
  const [whole, fraction] = text.split('.');
  return `${INDIAN.format(BigInt(whole))}${fraction === undefined ? '' : `.${fraction}`}`;
};
// An exact figure as rupees: ₹20,150, or ₹20,150.50 when it has paise.
function inr(r) {
  let text = fmtDecimal(abs(r));
  if (/\.\d$/.test(text)) text += '0';
  return `${isNeg(r) ? '-' : ''}₹${group(text)}`;
}
const inrP = (paise) => inr(fromPaise(paise));
const dayN = (r) => `${fmtDecimal(r)} ${cmp(r, ONE) === 0 ? 'day' : 'days'}`;
// A rate for display: exact when it ends within 4 places, else cut at 4 (the formula holds the exact sum).
const rateText = (r) => {
  const text = fmtDecimal(r);
  return text.includes('.') && text.length - text.indexOf('.') - 1 > 4 ? fmtExact(r, 4) : text;
};
const component = (code, label, kind, qty, rate, formula, paise) => (
  { code, label, kind, qty, rate, formula, amount: fmtPaise(paise) }
);

function readPolicy(raw) {
  const get = (key, fallback) => (given(raw?.[key]) ? raw[key] : fallback);
  return {
    rounding: oneOf(raw?.rounding, ['rupee', 'paise'], 'rupee', 'policy.rounding'),
    otHigh: rat(get('ot_high_hours', '150')),
    dedPct: rat(get('deduction_warn_pct', '50')),
    varPct: rat(get('variance_warn_pct', '25')),
  };
}

// `amt` holds every amount in paise, under its result field name; this is where they become strings.
function buildResult(amt, present, notEmployed, flags, rest) {
  return {
    engine_version: ENGINE_VERSION,
    present_days: fmtDecimal(present),
    days_not_employed: String(notEmployed),
    ...Object.fromEntries(Object.entries(amt).map(([k, v]) => [k, fmtPaise(v)])),
    ...rest,                                         // components, loan_recoveries, unrecovered, exact
    flags: [...flags].sort((x, y) => LEVEL_RANK[x.level] - LEVEL_RANK[y.level]),
  };
}

// ── The calculation ───────────────────────────────────────────────────

export function computeLine(p) {
  const [year, mon] = parseMonth(p.month);
  const dim = given(p.daysInMonth) ? Number(p.daysInMonth) : lengthOf(year, mon);
  if (!Number.isInteger(dim) || dim < 1 || dim > 31) {
    throw new RangeError(`engine: daysInMonth must be a whole number from 1 to 31, got ${JSON.stringify(p.daysInMonth)}`);
  }
  const person = p.person || {};
  const inputs = p.inputs || {};
  const balances = p.balances || {};
  const policy = readPolicy(p.policy);
  const flags = [];
  const flag = (level, code, message) => flags.push({ level, code, message });
  const amt = Object.fromEntries(MONEY_FIELDS.map((k) => [k, 0n]));

  const emp = employment(person, year, mon, dim);
  const absent = amountIn(inputs, 'absent_days');
  const unpaid = add(absent, rat(emp.notEmployed));
  const present = max(ZERO, sub(rat(dim), unpaid));
  const noDays = emp.employed === 0;                 // not employed any day: nothing is earned from the setup
  const finish = (rest) => buildResult(amt, present, emp.notEmployed, flags, rest);

  if (!p.setup) {
    flag('block', 'NO_SETUP', `No pay setup is in force for ${p.month}`);
    return finish({
      components: [],
      loan_recoveries: [],
      unrecovered: { advance: fmtPaise(0n), loans: [], other: fmtPaise(0n) },
      exact: { gross: fmtExact(ZERO, 6), net_before_cap: fmtExact(ZERO, 6) },
    });
  }
  const { setup } = p;
  const base = nonNeg(opt(setup.base), 'setup.base');
  const basis = oneOf(setup.pay_basis, ['monthly', 'daily', 'hourly', 'contract'], undefined, 'setup.pay_basis');

  // ── Earnings ──
  const earnings = [];                                // { exact, paise, component } for each earning
  const earn = (code, label, qty, rate, formula, exact) => {
    const paise = toPaise(exact);
    earnings.push({ exact, paise, component: component(code, label, 'earning', qty, rate, formula, paise) });
    return paise;
  };
  const earnFlat = (code, label, formula, exact) => earn(code, label, '1', fmtPaise(toPaise(exact)), formula, exact);

  if (cmp(absent, rat(dim)) > 0) {
    flag('block', 'ABSENT_EXCEEDS_DAYS', `${fmtDecimal(absent)} absent days is more than the ${dim} days in the month`);
  }
  const unpaidParts = [];
  if (!isZero(absent)) unpaidParts.push(`${dayN(absent)} absent`);
  if (emp.notEmployed > 0) unpaidParts.push(`${dayN(rat(emp.notEmployed))} not employed`);

  let daily = null;                                   // one day's pay, for the bases that have one
  let dailyText = '';                                 // how it is worked out, quoted in the OT formula
  let basic;
  if (basis === 'monthly') {
    const absenceBasis = oneOf(setup.absence_basis, ['calendar_days', 'fixed_divisor'], 'calendar_days', 'setup.absence_basis');
    const fixed = absenceBasis === 'fixed_divisor';
    const divisor = fixed ? positive(setup.absence_divisor, 'setup.absence_divisor') : rat(dim);
    daily = div(base, divisor);
    dailyText = `${inr(base)} ÷ ${fmtDecimal(divisor)} days`;
    const raw = sub(base, mul(daily, unpaid));
    // With no day employed there is no pay, even when a fixed divisor longer than the month would
    // leave a remainder (30 in February: 28 unpaid days of 30 still leave 2 days' pay).
    const paid = noDays ? ZERO : max(ZERO, sub(divisor, unpaid));
    let formula = `${dailyText} × ${dayN(paid)} present`;
    if (fixed && !noDays && unpaidParts.length) {
      formula = `${inr(base)} − ${dailyText} × ${unpaidParts.join(' + ')}${isNeg(raw) ? ', floored at ₹0' : ''}`;
    } else if (fixed && !noDays) {
      formula = `${inr(base)}, nothing taken off for absence`;
    }
    basic = { exact: noDays ? ZERO : max(ZERO, raw), qty: fmtDecimal(paid), rate: rateText(daily), formula };
  } else if (basis === 'daily') {
    daily = base;
    dailyText = `${inr(base)} per day`;
    basic = {
      exact: mul(base, present), qty: fmtDecimal(present), rate: rateText(base),
      formula: `${dailyText} × ${dayN(present)} present`,
    };
  } else if (basis === 'hourly') {
    const hours = amountIn(inputs, 'hours_worked');
    if (isZero(hours)) flag('block', 'HOURS_WORKED_MISSING', 'Hourly pay needs the hours worked this month');
    basic = {
      exact: mul(base, hours), qty: fmtDecimal(hours), rate: rateText(base),
      formula: isZero(hours) ? 'Hours worked not entered' : `${inr(base)} per hour × ${fmtDecimal(hours)} hours worked`,
    };
  } else {
    const bill = amountIn(inputs, 'bill_amount');
    if (isZero(bill)) flag('block', 'BILL_AMOUNT_MISSING', 'Contract pay needs the bill amount for this month');
    basic = {
      code: 'BILL', label: 'Contract bill', exact: bill, qty: '1', rate: rateText(bill),
      formula: isZero(bill) ? 'Bill amount not entered' : `Contract bill amount ${inr(bill)}`,
    };
  }
  amt.basic = earn(basic.code ?? 'BASIC', basic.label ?? 'Basic salary', basic.qty, basic.rate, basic.formula, basic.exact);
  if (daily) amt.daily_rate = toPaise(daily);

  const otHours = amountIn(inputs, 'ot_hours');
  if (!isZero(otHours)) {
    const perDay = opt(setup.ot_hours_per_day);
    const times = given(setup.ot_multiplier) ? rat(setup.ot_multiplier) : ONE;
    const fixedRate = opt(setup.ot_fixed_rate);
    const hours = `${fmtDecimal(otHours)} h`;
    const timesText = cmp(times, ONE) === 0 ? '' : ` × ${fmtDecimal(times)}`;
    let rate = ZERO;
    let formula = '';
    if (cmp(fixedRate, ZERO) > 0) {
      rate = fixedRate;
      formula = `${hours} × ${inr(fixedRate)} per hour (fixed OT rate)`;
    } else if (cmp(perDay, ZERO) > 0 && basis === 'hourly') {
      rate = mul(base, times);
      formula = `${hours} × ${inr(base)} per hour${timesText}`;
    } else if (cmp(perDay, ZERO) > 0 && daily) {
      rate = mul(div(daily, perDay), times);
      formula = `${hours} ÷ ${fmtDecimal(perDay)} h per day × (${dailyText})${timesText}`;
    }
    if (isZero(rate)) {
      formula = `${hours} entered but there is no OT rate`;
      flag('warn', 'OT_NO_RATE', `${fmtDecimal(otHours)} OT hours entered but there is no OT rate, so OT pays 0`);
    }
    amt.ot_amount = earn('OT', 'Overtime', fmtDecimal(otHours), rateText(rate), formula, mul(otHours, rate));
    if (cmp(otHours, policy.otHigh) > 0) {
      flag('warn', 'HIGH_OT', `${fmtDecimal(otHours)} OT hours is more than ${fmtDecimal(policy.otHigh)} in a month`);
    }
  }

  // The computed holiday is paid for the days employed (absences do not cut it, as in the workbook);
  // a typed holiday_override is paid exactly as typed, even for a month with no day employed.
  const holidayMode = oneOf(setup.holiday_mode, ['none', 'formula', 'fixed'], 'none', 'setup.holiday_mode');
  const share = div(rat(emp.employed), rat(dim));
  const shareText = emp.notEmployed > 0 ? ` × ${emp.employed} ÷ ${dim} days employed` : '';
  let holiday = ZERO;
  let holidayFormula = '';
  if (given(inputs.holiday_override)) {
    holiday = amountIn(inputs, 'holiday_override');
    holidayFormula = `Holiday pay typed for this month: ${inr(holiday)}`;
  } else if (holidayMode === 'formula') {
    const divisor = positive(setup.holiday_divisor, 'setup.holiday_divisor');
    const times = given(setup.holiday_multiplier) ? rat(setup.holiday_multiplier) : ONE;
    holiday = mul(mul(div(base, divisor), times), share);
    holidayFormula = `${inr(base)} ÷ ${fmtDecimal(divisor)} × ${fmtDecimal(times)}${shareText}`;
  } else if (holidayMode === 'fixed') {
    const monthly = nonNeg(opt(setup.holiday_fixed), 'setup.holiday_fixed');
    holiday = mul(monthly, share);
    holidayFormula = `Fixed holiday pay of ${inr(monthly)} a month${shareText}`;
  }
  if (!isZero(holiday)) amt.holiday_amount = earnFlat('HOLIDAY', 'Holiday pay', holidayFormula, holiday);

  const misc = amountIn(inputs, 'misc_earning');
  if (!isZero(misc)) amt.misc_earning = earnFlat('MISC', 'Misc earning', 'Entered for this month', misc);
  const bonus = amountIn(inputs, 'bonus');
  if (!isZero(bonus)) amt.bonus = earnFlat('BONUS', 'Bonus', 'Entered for this month', bonus);
  const adjustments = (p.adjustments || []).map((x, i) => ({
    id: x.id,
    kind: oneOf(x.kind, ['earning', 'deduction'], undefined, `adjustments[${i}].kind`),
    label: given(x.label) ? String(x.label) : `Adjustment ${x.id}`,
    exact: nonNeg(opt(x.amount), `adjustments[${i}].amount`),
  }));
  for (const x of adjustments.filter((y) => y.kind === 'earning')) {
    amt.adj_earnings += earnFlat(`ADJ:${x.id}`, x.label, 'Approved adjustment for this month', x.exact);
  }
  amt.gross = sumPaise(earnings.map((e) => e.paise));
  const exactGross = sumRats(earnings.map((e) => e.exact));

  // ── Deductions: what is wanted, then what the pay can bear ──
  // `wanted` is the amount before the cap, `kept` what survives it.
  const ded = (code, label, exact, more = {}) => {
    const wanted = toPaise(exact);
    return { code, label, exact, wanted, kept: wanted, ...more };
  };
  const advGiven = amountIn(inputs, 'advance_given');
  const advBalance = opt(balances.advance);
  const owed = max(ZERO, add(advBalance, advGiven));
  const advTyped = given(inputs.advance_recovery_override);
  let advWanted = owed;                              // the default: recover the whole advance
  if (advTyped) {                                    // a typed figure replaces it, between 0 and what is owed
    const typed = rat(inputs.advance_recovery_override);
    advWanted = max(ZERO, min(typed, owed));
    if (cmp(advWanted, typed) !== 0) {
      flag('warn', 'OVERRIDE_CLAMPED',
        `Advance recovery of ${inr(typed)} typed, ${inr(advWanted)} used: it must be between ₹0 and the ${inr(owed)} owed`);
    }
  }
  const advance = ded('ADVANCE', 'Advance recovery', advWanted);

  const loanRows = (balances.loans || []).map((l) => ({
    id: l.loan_id, no: l.loan_no ?? l.loan_id, due: opt(l.due), out: max(ZERO, opt(l.outstanding)),
  }));
  let loanWanted = loanRows.map((l) => max(ZERO, min(l.due, l.out)));      // never more than is outstanding
  const loansTyped = given(inputs.loan_recovery_override);
  if (loansTyped) {                                  // a typed total replaces the dues, allocated oldest loan first
    const typed = rat(inputs.loan_recovery_override);
    const outstanding = sumRats(loanRows.map((l) => l.out));
    let left = max(ZERO, min(typed, outstanding));
    if (cmp(left, typed) !== 0) {
      flag('warn', 'OVERRIDE_CLAMPED',
        `Loan recovery of ${inr(typed)} typed, ${inr(left)} used: it must be between ₹0 and the ${inr(outstanding)} outstanding`);
    }
    loanWanted = loanRows.map((l) => {
      const part = min(l.out, left);
      left = sub(left, part);
      return part;
    });
  }
  const loans = loanRows.map((l, i) => ded(`LOAN:${l.id}`, `Loan ${l.no}`, loanWanted[i], l));

  const miscDed = ded('MISC_DED', 'Misc deduction', amountIn(inputs, 'misc_deduction'));
  const adjDeds = adjustments.filter((x) => x.kind === 'deduction').map((x) => ded(`ADJ:${x.id}`, x.label, x.exact));
  const others = [miscDed, ...adjDeds];
  const everything = [advance, ...loans, ...others];

  const paidSeparately = amountIn(inputs, 'paid_separately');
  amt.paid_separately = toPaise(paidSeparately);
  amt.net_before_cap = amt.gross - sumPaise(everything.map((d) => d.wanted)) - amt.paid_separately;
  const exactNetBeforeCap = sub(sub(exactGross, sumRats(everything.map((d) => d.exact))), paidSeparately);

  // When pay falls short of zero: the advance recovery shrinks first, then the loans newest first
  // (balances.loans runs oldest to newest), then the other deductions, last listed first.
  let shortBy = -amt.net_before_cap;
  const trim = (d) => {
    const cut = shortBy > 0n ? (shortBy < d.kept ? shortBy : d.kept) : 0n;
    d.kept -= cut;
    shortBy -= cut;
  };
  trim(advance);
  [...loans].reverse().forEach(trim);
  [...others].reverse().forEach(trim);

  amt.misc_deduction = miscDed.kept;
  amt.adj_deductions = sumPaise(adjDeds.map((d) => d.kept));
  amt.loan_recovery = sumPaise(loans.map((d) => d.kept));
  amt.advance_recovery = advance.kept;
  amt.total_deductions = amt.misc_deduction + amt.adj_deductions + amt.loan_recovery + amt.advance_recovery;
  amt.net = amt.gross - amt.total_deductions;
  amt.advance_given = toPaise(advGiven);
  amt.carried_advance = toPaise(advBalance) + amt.advance_given - amt.advance_recovery;

  let payable = amt.net - amt.paid_separately;
  if (payable < 0n) {                                // more paid separately than the pay, even with no recoveries
    payable = 0n;
    flag('block', 'PAID_SEPARATELY_EXCEEDS',
      `Paid separately (${inrP(amt.paid_separately)}) is more than the pay after deductions (${inrP(amt.net)})`);
  }
  const beforeRounding = payable;
  if (policy.rounding === 'rupee') {
    payable = roundRupee(payable);
    amt.rounding = payable - beforeRounding;
  }
  amt.payable = payable;

  // ── Components: earnings, then deductions, then the information lines ──
  const lost = (d) => d.wanted - d.kept;
  const deductions = [];
  const deductionLine = (d, formula) => {
    const note = lost(d) > 0n ? `; cut to ${inrP(d.kept)} because pay was short` : '';
    deductions.push(component(d.code, d.label, 'deduction', '1', fmtPaise(d.kept), formula + note, d.kept));
  };
  if (!isZero(miscDed.exact)) deductionLine(miscDed, 'Entered for this month');
  adjDeds.forEach((d) => deductionLine(d, 'Approved adjustment for this month'));
  for (const l of loans.filter((x) => !isZero(x.exact))) {
    deductionLine(l, loansTyped
      ? `${inr(l.exact)} typed for this month, ${inr(l.out)} outstanding`
      : `Instalment ${inr(l.due)}, ${inr(l.out)} outstanding`);
  }
  if (!isZero(advance.exact)) {
    deductionLine(advance, `Advance owed ${inr(owed)}: balance ${inr(advBalance)} + given this month ${inr(advGiven)}`
      + (advTyped ? `; ${inr(advWanted)} to recover as typed` : ''));
  }
  const info = [];
  if (amt.paid_separately !== 0n) {
    info.push(component('PAID_SEPARATELY', 'Paid separately', 'info', '1', fmtPaise(amt.paid_separately),
      'Already paid outside this payroll; taken off the amount payable', amt.paid_separately));
  }
  if (amt.rounding !== 0n) {
    info.push(component('ROUNDING', 'Rounding', 'info', '1', fmtPaise(amt.rounding),
      `${inrP(beforeRounding)} rounded to the nearest rupee, ${inrP(amt.payable)}`, amt.rounding));
  }

  // ── Flags that need the results ──
  const loansLost = sumPaise(loans.map(lost));
  const othersLost = sumPaise(others.map(lost));
  if (lost(advance) + loansLost + othersLost > 0n) {
    const owing = [['advance', lost(advance)], ['loans', loansLost], ['other deductions', othersLost]]
      .filter(([, v]) => v > 0n).map(([k, v]) => `${k} ${inrP(v)}`);
    flag('warn', 'INSUFFICIENT_PAY', `Pay does not cover every recovery; left owing: ${owing.join(', ')}`);
  }
  const loanAndOther = amt.loan_recovery + amt.misc_deduction + amt.adj_deductions;   // advances are wages already paid
  if (amt.gross > 0n && cmp(mul(fromPaise(loanAndOther), HUNDRED), mul(fromPaise(amt.gross), policy.dedPct)) > 0) {
    const percent = toPaise(div(fromPaise(loanAndOther), fromPaise(amt.gross)));
    flag('warn', 'DEDUCTIONS_OVER_PCT',
      `Loans and other deductions are ${percent}% of gross, more than the ${fmtDecimal(policy.dedPct)}% limit`);
  }
  if (person.pay_channel_kind === 'bank' && !person.has_bank_details) {
    flag('warn', 'NO_BANK_DETAILS', 'Paid by bank but no bank details are on file');
  }
  if (noDays) {
    flag('warn', 'NOT_EMPLOYED_THIS_MONTH', 'Not employed any day this month: only typed amounts are paid');
  }
  const exitedOn = given(person.exited_on) ? String(person.exited_on).slice(0, 10) : null;
  if (emp.exitedBefore || person.status === 'exited') {
    // Say what this line really pays. With no day employed, only typed amounts can be in it.
    const marked = `Marked as left (${exitedOn ? `last day ${exitedOn}` : 'no exit date'})`;
    let said = `${marked}: pay follows the dates, gross ${inrP(amt.gross)}`;
    if (noDays) {
      said = amt.gross > 0n
        ? `${marked}, but this line still pays ${inrP(amt.gross)} from typed amounts: check it`
        : `${marked}: nothing is earned this month`;
    }
    flag('warn', 'PERSON_EXITED', said);
  }
  if (emp.joinedDay) {
    flag('info', 'JOINED_MID_MONTH',
      `Joined on ${String(person.joined_on).slice(0, 10)}: the ${emp.joinedDay - 1} days before that are not paid`);
  }
  if (emp.leftDay) {
    flag('info', 'LEFT_MID_MONTH', `Left on ${exitedOn}: the ${dim - emp.leftDay} days after that are not paid`);
  }
  const prevGross = p.previous && given(p.previous.gross) ? rat(p.previous.gross) : null;
  if (prevGross && cmp(prevGross, ZERO) > 0) {
    const change = sub(fromPaise(amt.gross), prevGross);
    if (cmp(mul(abs(change), HUNDRED), mul(prevGross, policy.varPct)) > 0) {
      const moved = [];
      for (const [key, label, field] of VARIANCE_PARTS) {
        const was = p.previous.components?.[key];
        const delta = given(was) ? amt[field] - toPaise(rat(was)) : 0n;
        if (delta !== 0n) moved.push(`${label} ${delta < 0n ? '-' : '+'}${inrP(delta < 0n ? -delta : delta)}`);
      }
      const percent = toPaise(div(change, prevGross));                    // 0.3255 → 33: whole percent, half away
      flag('info', 'VARIANCE', `${isNeg(change) ? '-' : '+'}${percent < 0n ? -percent : percent}% vs last month`
        + (moved.length ? ` (${moved.join(', ')})` : ''));
    }
  }

  return finish({
    components: [...earnings.map((e) => e.component), ...deductions, ...info],
    loan_recoveries: loans.filter((l) => l.kept > 0n).map((l) => ({ loan_id: l.id, amount: fmtPaise(l.kept) })),
    unrecovered: {
      advance: fmtPaise(lost(advance)),
      loans: loans.filter((l) => lost(l) > 0n).map((l) => ({ loan_id: l.id, amount: fmtPaise(lost(l)) })),
      other: fmtPaise(othersLost),
    },
    exact: { gross: fmtExact(exactGross, 6), net_before_cap: fmtExact(exactNetBeforeCap, 6) },
  });
}
