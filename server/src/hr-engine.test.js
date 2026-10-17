// The payroll calculation engine (hr/engine.js, spec §8).
//
// It has to reproduce the factory's Excel workbook to within half a paisa, so every
// expected value below is hand-derived (and cross-checked with exact fractions outside
// this repo), never copied from the engine's own output. Everything here is synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ENGINE_VERSION, daysInMonthOf, effectiveSetup, computeLine } from './hr/engine.js';

const base = (o = {}) => ({ month:'2026-07', daysInMonth:31, setup:{pay_basis:'monthly', base:'36000',
  absence_basis:'calendar_days', ot_hours_per_day:'6', ot_multiplier:'1', holiday_mode:'none'},
  person:{status:'active', pay_channel_kind:'cash', has_bank_details:false},
  inputs:{}, balances:{advance:'0', loans:[]}, adjustments:[], previous:null,
  policy:{rounding:'paise', ot_high_hours:'150', deduction_warn_pct:'50', variance_warn_pct:'25'}, ...o });

// ── The task brief's tests, verbatim ──────────────────────────────────
test('days in month follows the month', () => {
  assert.equal(daysInMonthOf('2026-02'), 28); assert.equal(daysInMonthOf('2028-02'), 29);
  assert.equal(daysInMonthOf('2026-09'), 30); assert.equal(daysInMonthOf('2026-07'), 31); });
test('calendar basic', () => {
  assert.equal(computeLine(base()).basic, '36000.00');
  assert.equal(computeLine(base({ inputs:{absent_days:'2'} })).basic, '33677.42'); });
test('February divides by 28', () => {
  assert.equal(computeLine(base({ month:'2026-02', daysInMonth:28, inputs:{absent_days:'1'} })).basic, '34714.29'); });
test('overtime at 6 h/day', () => {
  const r = computeLine(base({ setup:{...base().setup, base:'20150'}, inputs:{ot_hours:'71.55'} }));
  assert.equal(r.ot_amount, '7751.25'); });
test('OT hours with no OT rate pay 0 and warn', () => {
  const r = computeLine(base({ setup:{...base().setup, ot_hours_per_day:'0'}, inputs:{ot_hours:'10'} }));
  assert.equal(r.ot_amount, '0.00'); assert.ok(r.flags.some(f => f.code === 'OT_NO_RATE')); });
test('holiday formula ×1.5 and ×1', () => {
  const s = {...base().setup, base:'20150', holiday_mode:'formula', holiday_divisor:'30.5'};
  assert.equal(computeLine(base({ setup:{...s, holiday_multiplier:'1.5'} })).holiday_amount, '990.98');
  assert.equal(computeLine(base({ setup:{...s, holiday_multiplier:'1'} })).holiday_amount, '660.66'); });
test('the prompt\'s worked example', () => {
  const r = computeLine(base({ month:'2026-06', daysInMonth:30,
    setup:{...base().setup, base:'30000', absence_basis:'fixed_divisor', absence_divisor:'30', ot_fixed_rate:'150'},
    inputs:{absent_days:'2', ot_hours:'10', misc_deduction:'500'},
    balances:{advance:'2000', loans:[{loan_id:1, loan_no:'CI-LN-0001', due:'3000', outstanding:'9000'}]} }));
  assert.equal(r.basic,'28000.00'); assert.equal(r.ot_amount,'1500.00'); assert.equal(r.gross,'29500.00');
  assert.equal(r.total_deductions,'5500.00'); assert.equal(r.net,'24000.00'); assert.equal(r.payable,'24000.00'); });
test('workbook equivalence row', () => {
  const r = computeLine(base({ setup:{...base().setup, base:'14300', holiday_mode:'formula',
      holiday_divisor:'30.5', holiday_multiplier:'1'},
    inputs:{absent_days:'2.5', ot_hours:'30.48', misc_earning:'210', advance_given:'9000'} }));
  assert.equal(r.gross, '16168.97'); assert.equal(r.net_before_cap, '7168.97');
  assert.match(r.exact.gross, /^16168\.981491/); });
test('contract pays the bill, blocks without it', () => {
  const c = {...base().setup, pay_basis:'contract'};
  assert.equal(computeLine(base({ setup:c, inputs:{bill_amount:'50000'} })).basic, '50000.00');
  assert.ok(computeLine(base({ setup:c })).flags.some(f => f.code==='BILL_AMOUNT_MISSING' && f.level==='block')); });
test('cap: advance shrinks first, loan still recovered', () => {
  const r = computeLine(base({ month:'2026-09', daysInMonth:30, setup:{...base().setup, base:'10000'},
    balances:{advance:'12000', loans:[{loan_id:7, loan_no:'CI-LN-0007', due:'3000', outstanding:'20000'}]} }));
  assert.equal(r.net_before_cap, '-5000.00'); assert.equal(r.advance_recovery, '7000.00');
  assert.equal(r.loan_recovery, '3000.00'); assert.equal(r.net, '0.00'); assert.equal(r.payable, '0.00');
  assert.equal(r.unrecovered.advance, '5000.00'); assert.equal(r.carried_advance, '5000.00');
  assert.ok(r.flags.some(f => f.code === 'INSUFFICIENT_PAY')); });
test('cap reaches loans when advance is gone', () => {
  const r = computeLine(base({ month:'2026-09', daysInMonth:30, setup:{...base().setup, base:'2000'},
    balances:{advance:'0', loans:[{loan_id:7, loan_no:'X', due:'3000', outstanding:'20000'}]} }));
  assert.equal(r.loan_recovery, '2000.00'); assert.equal(r.unrecovered.loans[0].amount, '1000.00'); });
test('rounding to the rupee shows a rounding line', () => {
  const p = base({ setup:{...base().setup, base:'32550'}, policy:{...base().policy, rounding:'rupee'},
    inputs:{misc_earning:'0.49'} });
  const r = computeLine(p); assert.equal(r.payable, '32550.00'); assert.equal(r.rounding, '-0.49');
  assert.equal(computeLine({...p, inputs:{misc_earning:'0.50'}}).payable, '32551.00'); });
test('absent above month length blocks', () => {
  assert.ok(computeLine(base({ inputs:{absent_days:'32'} })).flags.some(f => f.code==='ABSENT_EXCEEDS_DAYS' && f.level==='block')); });
test('paid separately reduces payable, blocks when above pay', () => {
  assert.equal(computeLine(base({ setup:{...base().setup, base:'32550'}, inputs:{paid_separately:'5500'} })).payable, '27050.00');
  assert.ok(computeLine(base({ setup:{...base().setup, base:'3255'}, inputs:{paid_separately:'5500'} })).flags
    .some(f => f.code==='PAID_SEPARATELY_EXCEEDS')); });
test('joined mid-month', () => {
  const r = computeLine(base({ setup:{...base().setup, base:'32550'}, person:{...base().person, joined_on:'2026-07-10'} }));
  assert.equal(r.days_not_employed, '9'); assert.equal(r.basic, '23100.00');
  assert.ok(r.flags.some(f => f.code === 'JOINED_MID_MONTH')); });
test('left mid-month and exited', () => {
  const r = computeLine(base({ setup:{...base().setup, base:'32550'}, person:{...base().person, exited_on:'2026-07-21'} }));
  assert.equal(r.days_not_employed, '10'); assert.equal(r.basic, '22050.00');
  assert.ok(computeLine(base({ person:{...base().person, status:'exited', exited_on:'2026-06-30'} })).flags
    .some(f => f.code === 'PERSON_EXITED')); });
test('overrides replace and clamp', () => {
  const r = computeLine(base({ balances:{advance:'10000', loans:[]}, inputs:{advance_recovery_override:'4000'} }));
  assert.equal(r.advance_recovery, '4000.00'); assert.equal(r.carried_advance, '6000.00');
  const c = computeLine(base({ balances:{advance:'10000', loans:[]}, inputs:{advance_recovery_override:'15000'} }));
  assert.equal(c.advance_recovery, '10000.00'); assert.ok(c.flags.some(f => f.code === 'OVERRIDE_CLAMPED'));
  const l = computeLine(base({ balances:{advance:'0', loans:[{loan_id:1, loan_no:'A', due:'2000', outstanding:'2500'},
    {loan_id:2, loan_no:'B', due:'3000', outstanding:'9000'}]}, inputs:{loan_recovery_override:'4000'} }));
  assert.deepEqual(l.loan_recoveries, [{loan_id:1, amount:'2500.00'}, {loan_id:2, amount:'1500.00'}]); });
test('warnings: deductions %, high OT, bank details, variance', () => {
  assert.ok(computeLine(base({ setup:{...base().setup, base:'10000'}, balances:{advance:'0',
    loans:[{loan_id:1, loan_no:'A', due:'6000', outstanding:'9000'}]} })).flags.some(f => f.code==='DEDUCTIONS_OVER_PCT'));
  assert.ok(computeLine(base({ inputs:{ot_hours:'151'} })).flags.some(f => f.code==='HIGH_OT'));
  assert.ok(computeLine(base({ person:{status:'active', pay_channel_kind:'bank', has_bank_details:false} })).flags
    .some(f => f.code==='NO_BANK_DETAILS'));
  const v = computeLine(base({ setup:{...base().setup, base:'26000'}, previous:{gross:'20000', components:{}} }));
  assert.ok(v.flags.some(f => f.code==='VARIANCE' && /30%/.test(f.message))); });
test('effectiveSetup picks the latest revision not after the month', () => {
  const s = [{effective_from:'2026-04-01', base:'1'}, {effective_from:'2026-08-01', base:'2'}];
  assert.equal(effectiveSetup(s, '2026-07').base, '1'); assert.equal(effectiveSetup(s, '2026-08').base, '2');
  assert.equal(effectiveSetup(s, '2026-03'), null); });
test('every component explains itself', () => {
  const r = computeLine(base({ inputs:{absent_days:'1', ot_hours:'12'} }));
  for (const c of r.components) assert.ok(c.formula && c.label && c.amount, c.code);
  assert.match(r.components.find(c => c.code==='BASIC').formula, /31/); });

// ── Beyond the brief: one behaviour per test ──────────────────────────
const loan = (id, due, outstanding) => ({ loan_id:id, loan_no:`L${id}`, due, outstanding });
const month9 = (o) => base({ month:'2026-09', daysInMonth:30, ...o });          // a 30-day month
const paise = (s) => BigInt(s.replace('.', ''));                                // '12.50' → 1250n, '-0.49' → -49n
const deepFreeze = (o) => { if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
const flagCodes = (r) => r.flags.map(f => f.code);

test('the engine says which version computed a line', () => {
  assert.equal(ENGINE_VERSION, 'hr-engine-1'); assert.equal(computeLine(base()).engine_version, 'hr-engine-1'); });

test('each earning is rounded to paise on its own: gross adds the rounded figures, exact.gross does not', () => {
  // 0.005 rounds up to 0.01 twice, so the paise total is 0.02 while the true total is 0.01
  const r = computeLine(base({ setup:{...base().setup, base:'0'}, inputs:{misc_earning:'0.005', bonus:'0.005'} }));
  assert.equal(r.misc_earning, '0.01'); assert.equal(r.bonus, '0.01'); assert.equal(r.gross, '0.02');
  assert.equal(r.exact.gross, '0.010000'); });

test('the workbook row, component by component', () => {
  const r = computeLine(base({ setup:{...base().setup, base:'14300', holiday_mode:'formula',
      holiday_divisor:'30.5', holiday_multiplier:'1'},
    inputs:{absent_days:'2.5', ot_hours:'30.48', misc_earning:'210', advance_given:'9000'} }));
  assert.deepEqual(r.components.map(c => [c.code, c.kind, c.amount]), [
    ['BASIC','earning','13146.77'], ['OT','earning','2343.35'], ['HOLIDAY','earning','468.85'],
    ['MISC','earning','210.00'], ['ADVANCE','deduction','9000.00']]);
  assert.equal(r.present_days, '28.5'); assert.equal(r.daily_rate, '461.29'); assert.equal(r.advance_given, '9000.00');
  assert.equal(r.carried_advance, '0.00'); assert.equal(r.exact.net_before_cap, '7168.981491'); });

test('BASIC and OT carry the quantity and rate behind the amount', () => {
  const r = computeLine(base({ setup:{...base().setup, base:'20150'}, inputs:{absent_days:'1', ot_hours:'71.55'} }));
  const basic = r.components.find(c => c.code === 'BASIC'); const ot = r.components.find(c => c.code === 'OT');
  assert.deepEqual([basic.qty, basic.rate, basic.amount], ['30', '650', '19500.00']);
  assert.deepEqual([ot.qty, ot.rate, ot.amount], ['71.55', '108.3333', '7751.25']); });

test('cap: loans are cut newest first and the older loan keeps its instalment', () => {
  // pay 4000 against misc 1500 + loans 2000 + 3000: 2500 has to come off
  const r = computeLine(month9({ setup:{...base().setup, base:'4000'}, inputs:{misc_deduction:'1500'},
    balances:{advance:'0', loans:[loan(1,'2000','5000'), loan(2,'3000','5000')]} }));
  assert.equal(r.net_before_cap, '-2500.00');
  assert.deepEqual(r.loan_recoveries, [{loan_id:1, amount:'2000.00'}, {loan_id:2, amount:'500.00'}]);
  assert.deepEqual(r.unrecovered.loans, [{loan_id:2, amount:'2500.00'}]);
  assert.equal(r.misc_deduction, '1500.00'); assert.equal(r.total_deductions, '4000.00'); assert.equal(r.net, '0.00'); });

test('cap: with the loans gone it cuts the other deductions, last listed first', () => {
  // pay 400 against loan 1000 + misc 500 + adjustment 300: 1400 has to come off
  const r = computeLine(month9({ setup:{...base().setup, base:'400'}, inputs:{misc_deduction:'500'},
    adjustments:[{id:5, kind:'deduction', label:'Canteen', amount:'300'}],
    balances:{advance:'0', loans:[loan(1,'1000','5000')]} }));
  assert.equal(r.net_before_cap, '-1400.00');
  assert.equal(r.loan_recovery, '0.00'); assert.deepEqual(r.loan_recoveries, []);
  assert.deepEqual(r.unrecovered.loans, [{loan_id:1, amount:'1000.00'}]);
  assert.equal(r.adj_deductions, '0.00'); assert.equal(r.misc_deduction, '400.00'); assert.equal(r.unrecovered.other, '400.00');
  assert.equal(r.net, '0.00'); assert.equal(r.payable, '0.00'); });

test('carried advance counts what was given this month', () => {
  // owes 2000 + 12000 given against pay of 10000
  const r = computeLine(month9({ setup:{...base().setup, base:'10000'}, balances:{advance:'2000', loans:[]},
    inputs:{advance_given:'12000'} }));
  assert.equal(r.net_before_cap, '-4000.00'); assert.equal(r.advance_recovery, '10000.00');
  assert.equal(r.unrecovered.advance, '4000.00'); assert.equal(r.carried_advance, '4000.00'); });

test('pay that exactly covers everything is not short', () => {
  const r = computeLine(month9({ setup:{...base().setup, base:'10000'}, balances:{advance:'10000', loans:[]} }));
  assert.equal(r.net_before_cap, '0.00'); assert.equal(r.payable, '0.00'); assert.equal(r.unrecovered.advance, '0.00');
  assert.ok(!flagCodes(r).includes('INSUFFICIENT_PAY')); });

test('paid separately counts against the cap, and blocks only when no recovery is left to cut', () => {
  const s = {...base().setup, base:'10000'};
  const a = computeLine(month9({ setup:s, balances:{advance:'3000', loans:[]}, inputs:{paid_separately:'9000'} }));
  assert.equal(a.net_before_cap, '-2000.00'); assert.equal(a.advance_recovery, '1000.00');
  assert.equal(a.net, '9000.00'); assert.equal(a.payable, '0.00'); assert.equal(a.unrecovered.advance, '2000.00');
  assert.ok(!flagCodes(a).includes('PAID_SEPARATELY_EXCEEDS'));
  const b = computeLine(month9({ setup:s, balances:{advance:'3000', loans:[]}, inputs:{paid_separately:'12000'} }));
  assert.equal(b.advance_recovery, '0.00'); assert.equal(b.net, '10000.00'); assert.equal(b.payable, '0.00');
  assert.equal(b.unrecovered.advance, '3000.00');
  assert.ok(b.flags.some(f => f.code === 'PAID_SEPARATELY_EXCEEDS' && f.level === 'block')); });

test('no pay setup: every amount is 0.00 and the line is blocked', () => {
  const r = computeLine(base({ setup:null, inputs:{ot_hours:'10', absent_days:'1', advance_given:'500'},
    balances:{advance:'5000', loans:[loan(1,'1000','4000')]} }));
  for (const k of ['daily_rate','basic','ot_amount','gross','total_deductions','loan_recovery','advance_recovery',
    'net_before_cap','net','payable','rounding','advance_given','carried_advance']) assert.equal(r[k], '0.00', k);
  assert.deepEqual(r.components, []); assert.deepEqual(r.loan_recoveries, []);
  assert.deepEqual(r.flags.map(f => [f.level, f.code]), [['block', 'NO_SETUP']]);
  assert.equal(r.exact.gross, '0.000000'); assert.equal(r.exact.net_before_cap, '0.000000'); });

test('OT rate: a fixed rate wins, a zero one falls back, the multiplier applies', () => {
  const s = {...base().setup, base:'20150'};
  const ot = (setup, hours = '6') => computeLine(base({ setup, inputs:{ot_hours:hours} })).ot_amount;
  assert.equal(ot({...s, ot_fixed_rate:'150'}), '900.00');
  assert.equal(ot({...s, ot_fixed_rate:'0'}), '650.00');                       // 6 h ÷ 6 × 20150/31
  assert.equal(ot({...s, ot_multiplier:'1.5'}), '975.00');
  assert.equal(ot({...s, ot_multiplier:undefined}), '650.00');                 // multiplier defaults to 1
  assert.equal(ot({...s, ot_fixed_rate:'150'}, '0'), '0.00');
  assert.ok(!flagCodes(computeLine(base({ setup:s }))).includes('OT_NO_RATE')); });

test('daily, fixed-divisor and hourly pay', () => {
  const d = computeLine(base({ setup:{pay_basis:'daily', base:'800', ot_hours_per_day:'8', holiday_mode:'none'},
    inputs:{absent_days:'2.5', ot_hours:'4'} }));
  assert.equal(d.basic, '22800.00'); assert.equal(d.ot_amount, '400.00'); assert.equal(d.daily_rate, '800.00');
  assert.equal(d.present_days, '28.5');
  const f = computeLine(base({ setup:{...base().setup, base:'30000', absence_basis:'fixed_divisor', absence_divisor:'30'},
    inputs:{absent_days:'2', ot_hours:'12'} }));                               // 31-day month, 30-day divisor
  assert.equal(f.basic, '28000.00'); assert.equal(f.ot_amount, '2000.00'); assert.equal(f.daily_rate, '1000.00');
  const h = {pay_basis:'hourly', base:'120', ot_hours_per_day:'8', ot_multiplier:'1.5', holiday_mode:'none'};
  const paid = computeLine(base({ setup:h, inputs:{hours_worked:'160', ot_hours:'10'} }));
  assert.equal(paid.basic, '19200.00'); assert.equal(paid.ot_amount, '1800.00');
  const none = computeLine(base({ setup:h }));
  assert.equal(none.basic, '0.00');
  assert.ok(none.flags.some(x => x.code === 'HOURS_WORKED_MISSING' && x.level === 'block')); });

test('contract: the component is BILL, and a blank or zero bill amount counts as missing', () => {
  const c = {...base().setup, pay_basis:'contract'};
  const r = computeLine(base({ setup:c, inputs:{bill_amount:'50000'} }));
  assert.deepEqual([r.components[0].code, r.components[0].kind, r.components[0].amount], ['BILL', 'earning', '50000.00']);
  assert.ok(!flagCodes(r).includes('BILL_AMOUNT_MISSING'));
  for (const bill of [undefined, null, '', '0', 0]) {
    assert.ok(flagCodes(computeLine(base({ setup:c, inputs:{bill_amount:bill} }))).includes('BILL_AMOUNT_MISSING'), String(bill)); } });

test('holiday: a typed amount wins even when zero, a fixed amount is paid as it is', () => {
  const s = {...base().setup, base:'20150', holiday_divisor:'30.5', holiday_multiplier:'1.5'};
  const hol = (setup, inputs = {}) => computeLine(base({ setup, inputs })).holiday_amount;
  assert.equal(hol({...s, holiday_mode:'none'}, {holiday_override:'1500'}), '1500.00');
  assert.equal(hol({...s, holiday_mode:'formula'}, {holiday_override:'0'}), '0.00');
  assert.equal(hol({...s, holiday_mode:'formula'}), '990.98');
  assert.equal(hol({...s, holiday_mode:'fixed', holiday_fixed:'1200'}), '1200.00');
  assert.equal(hol({...s, holiday_mode:'none'}), '0.00'); });

test('employment dates: joined later, joined and left in the month, first and last day', () => {
  const s = {...base().setup, base:'32550'};
  const who = (person) => computeLine(base({ setup:s, person:{...base().person, ...person} }));
  const later = who({ joined_on:'2026-08-05' });
  assert.deepEqual([later.days_not_employed, later.present_days, later.basic], ['31', '0', '0.00']);
  const both = who({ joined_on:'2026-07-10', exited_on:'2026-07-20' });                     // 11 days worked
  assert.deepEqual([both.days_not_employed, both.present_days, both.basic], ['20', '11', '11550.00']);
  const lastDay = who({ exited_on:'2026-07-31' });
  assert.equal(lastDay.days_not_employed, '0'); assert.ok(!flagCodes(lastDay).includes('LEFT_MID_MONTH'));
  const firstDay = who({ joined_on:'2026-07-01' });
  assert.equal(firstDay.days_not_employed, '0'); assert.ok(!flagCodes(firstDay).includes('JOINED_MID_MONTH'));
  assert.ok(flagCodes(who({ exited_on:'2026-07-21' })).includes('LEFT_MID_MONTH'));
  // absent days on top of days not employed can use up the whole month, and pay never goes below 0
  assert.equal(who({ joined_on:'2026-07-10' }).basic, '23100.00');
  const used = computeLine(base({ setup:s, inputs:{absent_days:'25'}, person:{...base().person, joined_on:'2026-07-10'} }));
  assert.deepEqual([used.present_days, used.basic], ['0', '0.00']); });

test('exit rules: the dates decide; a status with no date means the whole month', () => {
  const s = {...base().setup, base:'32550'};
  const who = (person) => computeLine(base({ setup:s, person:{...base().person, ...person} }));
  // left on the 21st and already marked exited when July is run: the 21 days worked are still paid
  const leaver = who({ status:'exited', exited_on:'2026-07-21' });
  assert.equal(leaver.basic, '22050.00');
  assert.ok(leaver.flags.some(f => f.code === 'PERSON_EXITED' && f.level === 'warn'));
  assert.ok(flagCodes(leaver).includes('LEFT_MID_MONTH'));
  const gone = who({ status:'exited', exited_on:'2026-06-30' });
  assert.deepEqual([gone.days_not_employed, gone.present_days, gone.basic], ['31', '0', '0.00']);
  assert.ok(flagCodes(gone).includes('PERSON_EXITED'));
  const nodate = who({ status:'exited' });
  assert.deepEqual([nodate.days_not_employed, nodate.basic], ['31', '0.00']);
  assert.ok(flagCodes(nodate).includes('PERSON_EXITED'));
  const stale = who({ status:'active', exited_on:'2026-05-15' });                         // status never updated
  assert.equal(stale.basic, '0.00'); assert.ok(flagCodes(stale).includes('PERSON_EXITED'));
  assert.ok(!flagCodes(who({})).includes('PERSON_EXITED')); });

test('employed no day this month: nothing comes from the setup, typed amounts still pay, and it is flagged', () => {
  const hol = {...base().setup, base:'20150', holiday_mode:'formula', holiday_divisor:'30.5', holiday_multiplier:'1.5'};
  const who = (person, inputs = {}, extra = {}) => computeLine(base({ setup:hol, person:{...base().person, ...person}, inputs, ...extra }));
  const nobody = [{ joined_on:'2026-08-05' }, { status:'exited', exited_on:'2026-06-30' }, { status:'exited' },
    { exited_on:'2026-06-15' }, { joined_on:'2026-07-20', exited_on:'2026-07-10' }];
  for (const person of nobody) {
    const r = who(person);
    assert.deepEqual([r.days_not_employed, r.present_days, r.basic, r.holiday_amount, r.gross, r.payable],
      ['31', '0', '0.00', '0.00', '0.00', '0.00'], JSON.stringify(person));
    const f = r.flags.find(x => x.code === 'NOT_EMPLOYED_THIS_MONTH');
    assert.ok(f, JSON.stringify(person)); assert.equal(f.level, 'warn');
    assert.match(f.message, /not employed any day this month/i); assert.match(f.message, /only typed amounts are paid/); }
  // typed amounts still compute exactly as they always did: OT hours, misc, bonus, a typed holiday, adjustments
  const typed = who({ joined_on:'2026-08-05' }, { ot_hours:'6', misc_earning:'500', bonus:'100', holiday_override:'700' });
  assert.deepEqual([typed.ot_amount, typed.misc_earning, typed.bonus, typed.holiday_amount, typed.gross],
    ['650.00', '500.00', '100.00', '700.00', '1950.00']);
  const arrears = who({ joined_on:'2026-08-05' }, {}, { adjustments:[{id:1, kind:'earning', label:'Arrears', amount:'250'}] });
  assert.deepEqual([arrears.adj_earnings, arrears.gross], ['250.00', '250.00']);
  // one day employed is enough: the warning is for a month with no day at all
  for (const person of [{}, { joined_on:'2026-07-31' }, { exited_on:'2026-07-01' }]) {
    assert.ok(!flagCodes(who(person)).includes('NOT_EMPLOYED_THIS_MONTH'), JSON.stringify(person)); }
  // without a pay setup there is nothing else to say
  assert.deepEqual(flagCodes(computeLine(base({ setup:null, person:{...base().person, joined_on:'2026-08-05'} }))), ['NO_SETUP']); });

test('PERSON_EXITED says what the line really pays', () => {
  const who = (person, inputs = {}) => computeLine(base({ setup:{...base().setup, base:'32550'},
    person:{...base().person, ...person}, inputs }));
  const said = (r) => r.flags.find(f => f.code === 'PERSON_EXITED').message;
  const typed = who({ status:'exited', exited_on:'2026-06-30' }, { misc_earning:'500' });
  assert.equal(typed.gross, '500.00');
  assert.match(said(typed), /500/); assert.match(said(typed), /typed amounts/); assert.match(said(typed), /check/);
  assert.ok(!/nothing is earned/.test(said(typed)));
  const none = who({ status:'exited', exited_on:'2026-06-30' });
  assert.equal(none.gross, '0.00'); assert.match(said(none), /nothing is earned this month/);
  const undated = who({ status:'exited' }, { bonus:'1250' });
  assert.match(said(undated), /1,250/); assert.match(said(undated), /no exit date/);
  assert.match(said(who({ status:'exited' })), /nothing is earned this month/);
  const leaver = who({ status:'exited', exited_on:'2026-07-21' });             // worked 21 days, so the dates pay him
  assert.equal(leaver.gross, '22050.00');
  assert.match(said(leaver), /22,050/); assert.match(said(leaver), /follows the dates/);
  assert.ok(!/nothing is earned/.test(said(leaver))); });

test('the computed holiday is cut to the days employed; absences and typed amounts are not', () => {
  const formula = {...base().setup, base:'20150', holiday_mode:'formula', holiday_divisor:'30.5', holiday_multiplier:'1.5'};
  const fixed = {...base().setup, base:'20150', holiday_mode:'fixed', holiday_fixed:'1200'};
  const who = (person, inputs = {}, setup = formula) => computeLine(base({ setup, person:{...base().person, ...person}, inputs }));
  assert.equal(who({}).holiday_amount, '990.98');                                  // the whole month, as before
  const joined = who({ joined_on:'2026-07-10' });                                  // 22 of 31 days: 20150 ÷ 30.5 × 1.5 × 22 ÷ 31
  assert.deepEqual([joined.holiday_amount, joined.basic, joined.gross], ['703.28', '14300.00', '15003.28']);
  assert.equal(joined.components.find(c => c.code === 'HOLIDAY').formula, '₹20,150 ÷ 30.5 × 1.5 × 22 ÷ 31 days employed');
  assert.equal(who({ exited_on:'2026-07-22' }).holiday_amount, '703.28');          // the same 22 days, counted from the other end
  assert.equal(who({ joined_on:'2026-07-10', exited_on:'2026-07-20' }).holiday_amount, '351.64');     // 11 days
  assert.equal(who({ joined_on:'2026-07-31' }).holiday_amount, '31.97');           // one day
  assert.equal(who({ joined_on:'2026-07-10' }, {}, fixed).holiday_amount, '851.61');   // 1200 × 22 ÷ 31
  assert.equal(who({}, {}, fixed).holiday_amount, '1200.00');
  // absences do not cut it (the workbook's rule), and a typed holiday is paid as typed
  assert.equal(who({}, { absent_days:'5' }).holiday_amount, '990.98');
  assert.equal(who({ joined_on:'2026-07-10' }, { absent_days:'5' }).holiday_amount, '703.28');
  assert.equal(who({ joined_on:'2026-07-10' }, { holiday_override:'700' }).holiday_amount, '700.00'); });

test('a fixed divisor longer than the month does not pay someone employed no day', () => {
  // 30000 ÷ 30 is 1000 a day, and February has 28: 28 unpaid days alone would still leave 2000
  const feb = (person) => computeLine(base({ month:'2026-02', daysInMonth:28, person:{...base().person, ...person},
    setup:{...base().setup, base:'30000', absence_basis:'fixed_divisor', absence_divisor:'30'} }));
  for (const person of [{ joined_on:'2026-03-05' }, { exited_on:'2026-01-20' }, { status:'exited' }]) {
    const r = feb(person);
    assert.deepEqual([r.basic, r.gross, r.payable], ['0.00', '0.00', '0.00'], JSON.stringify(person));
    assert.ok(flagCodes(r).includes('NOT_EMPLOYED_THIS_MONTH'), JSON.stringify(person));
    const basic = r.components.find(c => c.code === 'BASIC');                    // and the line explains that 0.00
    assert.deepEqual([basic.qty, basic.amount], ['0', '0.00'], JSON.stringify(person));
    assert.match(basic.formula, /× 0 days present/, JSON.stringify(person)); }
  assert.equal(feb({ joined_on:'2026-02-15' }).basic, '16000.00'); });             // 14 days employed: the fixed-divisor rule applies

test('the engine header lists every flag code the engine can raise, at its level, and nothing it cannot', () => {
  const source = readFileSync(fileURLToPath(new URL('./hr/engine.js', import.meta.url)), 'utf8');
  const lines = source.split('\nimport ')[0].split('// Flags')[1].split('\n//\n')[0].split('\n').slice(1);
  const documented = {};
  let level;
  for (const line of lines) {
    level = /^\/\/\s+(block|warn|info)\b/.exec(line)?.[1] ?? level;           // wrapped lines keep the level above
    for (const code of line.match(/\b[A-Z][A-Z_]{2,}\b/g) ?? []) documented[code] = level;
  }
  const raised = Object.fromEntries([...source.matchAll(/flag\('(block|warn|info)', '([A-Z_]+)'/g)].map(m => [m[2], m[1]]));
  assert.equal(raised.NOT_EMPLOYED_THIS_MONTH, 'warn'); assert.ok(Object.keys(raised).length >= 16);
  assert.deepEqual(documented, raised); });

test('absent days: all of them is allowed, one more than the month is not', () => {
  const all = computeLine(base({ inputs:{absent_days:'31'} }));
  assert.equal(all.basic, '0.00'); assert.equal(all.present_days, '0'); assert.ok(!flagCodes(all).includes('ABSENT_EXCEEDS_DAYS'));
  const more = computeLine(base({ inputs:{absent_days:'31.5'} }));
  assert.equal(more.basic, '0.00'); assert.ok(flagCodes(more).includes('ABSENT_EXCEEDS_DAYS')); });

test('formulas use Indian digit grouping and show what was divided by what', () => {
  const basic = (b, inputs) => computeLine(base({ setup:{...base().setup, base:b}, inputs })).components
    .find(c => c.code === 'BASIC').formula;
  assert.equal(basic('20150', {absent_days:'1'}), '₹20,150 ÷ 31 days × 30 days present');
  assert.equal(basic('1234567', {}), '₹12,34,567 ÷ 31 days × 31 days present');           // lakh grouping
  assert.equal(basic('20150.5', {}), '₹20,150.50 ÷ 31 days × 31 days present');
  assert.equal(basic('20150', {absent_days:'30'}), '₹20,150 ÷ 31 days × 1 day present');
  const fixed = computeLine(base({ setup:{...base().setup, base:'30000', absence_basis:'fixed_divisor', absence_divisor:'30'},
    inputs:{absent_days:'2'} })).components[0].formula;
  assert.equal(fixed, '₹30,000 − ₹30,000 ÷ 30 days × 2 days absent'); });

test('rounding line: only when rounding changes the pay, and it is information', () => {
  const rupee = {...base().policy, rounding:'rupee'}; const s = {...base().setup, base:'32550'};
  const r = computeLine(base({ setup:s, policy:rupee, inputs:{misc_earning:'0.49'} }));
  const line = r.components.find(c => c.code === 'ROUNDING');
  assert.deepEqual([line.kind, line.amount], ['info', '-0.49']);
  assert.equal(r.net, '32550.49');                                    // net is as computed; payable is rounded
  const whole = computeLine(base({ setup:s, policy:rupee }));
  assert.equal(whole.rounding, '0.00'); assert.ok(!whole.components.some(c => c.code === 'ROUNDING'));
  const exact = computeLine(base({ setup:s, inputs:{misc_earning:'0.49'} }));               // paise mode
  assert.deepEqual([exact.payable, exact.rounding], ['32550.49', '0.00']);
  assert.ok(!exact.components.some(c => c.code === 'ROUNDING')); });

test('components add up: earnings to gross, deductions to the total, info lines in neither', () => {
  const r = computeLine(base({
    setup:{...base().setup, base:'20150', holiday_mode:'formula', holiday_divisor:'30.5', holiday_multiplier:'1.5'},
    policy:{...base().policy, rounding:'rupee'},
    inputs:{absent_days:'1.5', ot_hours:'12', misc_earning:'250.5', bonus:'1000', misc_deduction:'300',
      paid_separately:'2000', advance_given:'1500'},
    adjustments:[{id:3, kind:'earning', label:'Arrears', amount:'700'}, {id:4, kind:'deduction', label:'Damage', amount:'125.25'}],
    balances:{advance:'500', loans:[loan(9,'1000','4000')]} }));
  assert.equal(r.gross, '23416.48'); assert.equal(r.total_deductions, '3425.25'); assert.equal(r.net, '19991.23');
  assert.equal(r.net_before_cap, '17991.23'); assert.equal(r.payable, '17991.00'); assert.equal(r.rounding, '-0.23');
  assert.deepEqual([r.misc_earning, r.bonus, r.adj_earnings, r.adj_deductions], ['250.50', '1000.00', '700.00', '125.25']);
  assert.deepEqual(r.components.map(c => c.code), ['BASIC', 'OT', 'HOLIDAY', 'MISC', 'BONUS', 'ADJ:3', 'MISC_DED',
    'ADJ:4', 'LOAN:9', 'ADVANCE', 'PAID_SEPARATELY', 'ROUNDING']);
  const total = (kind) => r.components.filter(c => c.kind === kind).reduce((t, c) => t + paise(c.amount), 0n);
  assert.equal(total('earning'), paise(r.gross)); assert.equal(total('deduction'), paise(r.total_deductions));
  assert.equal(paise(r.net) - paise(r.paid_separately) + paise(r.rounding), paise(r.payable));
  assert.equal(r.components.find(c => c.code === 'ADJ:3').label, 'Arrears');
  for (const c of r.components) {
    assert.ok(c.label && c.formula && c.amount && c.qty && c.rate, c.code);
    assert.ok(['earning', 'deduction', 'info'].includes(c.kind), c.code); } });

test('every component explains itself, whatever the pay basis and whichever branch made it', () => {
  const s = base().setup;
  const fixedDiv = {...s, absence_basis:'fixed_divisor', absence_divisor:'30'};
  const hourly = {pay_basis:'hourly', base:'120', ot_hours_per_day:'8', ot_multiplier:'1.5', holiday_mode:'none'};
  const daily = {pay_basis:'daily', base:'800', ot_hours_per_day:'8', holiday_mode:'fixed', holiday_fixed:'500'};
  const contract = {...s, pay_basis:'contract', base:'0'};
  const rows = [
    [s, {}], [s, {absent_days:'31'}], [fixedDiv, {}], [fixedDiv, {absent_days:'2'}], [fixedDiv, {absent_days:'40'}],
    [{...s, ot_fixed_rate:'150'}, {ot_hours:'5'}], [{...s, ot_hours_per_day:'0'}, {ot_hours:'5'}],
    [{...s, holiday_mode:'formula', holiday_divisor:'30.5', holiday_multiplier:'1.5'}, {}], [s, {holiday_override:'700'}],
    [hourly, {}], [hourly, {hours_worked:'10', ot_hours:'2'}], [daily, {absent_days:'1', ot_hours:'4'}],
    [contract, {}], [contract, {bill_amount:'9000'}],
    [{...s, holiday_mode:'fixed', holiday_fixed:'500'}, {}],
  ];
  const people = [{}, { joined_on:'2026-07-10' }, { exited_on:'2026-07-22' }, { joined_on:'2026-08-05' }, { status:'exited' }];
  for (const person of people) for (const [setup, inputs] of rows) {
    const r = computeLine(base({ setup, person:{...base().person, ...person},
      inputs:{...inputs, misc_earning:'10', bonus:'20', misc_deduction:'5', paid_separately:'1',
        advance_given:'30', holiday_override: inputs.holiday_override },
      adjustments:[{id:1, kind:'earning', label:'E', amount:'2'}, {id:2, kind:'deduction', label:'D', amount:'3'}],
      balances:{advance:'4', loans:[loan(1,'6','50')]} }));
    for (const c of r.components) {
      for (const key of ['code', 'label', 'formula', 'amount', 'qty', 'rate']) {
        assert.equal(typeof c[key], 'string', `${c.code}.${key}`);
        assert.ok(c[key].length > 0, `${c.code}.${key} for ${JSON.stringify([setup, person])}`); } } } });

test('a deduction that the cap trimmed says so', () => {
  const r = computeLine(month9({ setup:{...base().setup, base:'10000'},
    balances:{advance:'12000', loans:[loan(7,'3000','20000')]} }));
  const adv = r.components.find(c => c.code === 'ADVANCE');
  assert.equal(adv.amount, '7000.00'); assert.match(adv.formula, /₹12,000/); assert.match(adv.formula, /₹7,000/);
  assert.match(adv.formula, /short/);
  assert.ok(!/short/.test(r.components.find(c => c.code === 'LOAN:7').formula)); });

test('overrides: clamped to what is outstanding or owed; in-range ones raise no flag', () => {
  const two = [loan(1,'2000','2500'), loan(2,'3000','500')];
  const run = (inputs, loans = two) => computeLine(base({ balances:{advance:'1000', loans}, inputs }));
  const over = run({ loan_recovery_override:'4000' });                  // 3000 is all that is outstanding
  assert.deepEqual(over.loan_recoveries, [{loan_id:1, amount:'2500.00'}, {loan_id:2, amount:'500.00'}]);
  assert.ok(flagCodes(over).includes('OVERRIDE_CLAMPED'));
  const exact = run({ loan_recovery_override:'3000' });
  assert.equal(exact.loan_recovery, '3000.00'); assert.ok(!flagCodes(exact).includes('OVERRIDE_CLAMPED'));
  const zero = run({ loan_recovery_override:'0' });
  assert.deepEqual(zero.loan_recoveries, []); assert.ok(!flagCodes(zero).includes('OVERRIDE_CLAMPED'));
  assert.equal(run({}, [loan(1,'3000','1200')]).loan_recovery, '1200.00');   // never more than outstanding
  assert.equal(run({ advance_recovery_override:'-5' }).advance_recovery, '0.00');
  assert.ok(flagCodes(run({ advance_recovery_override:'-5' })).includes('OVERRIDE_CLAMPED'));
  const full = run({ advance_recovery_override:'1000' });
  assert.equal(full.advance_recovery, '1000.00'); assert.ok(!flagCodes(full).includes('OVERRIDE_CLAMPED')); });

test('a loan that is paid off, or has nothing due, is not recovered', () => {
  const r = computeLine(base({ balances:{advance:'0', loans:[loan(1,'0','4000'), loan(2,'500','0')]} }));
  assert.equal(r.loan_recovery, '0.00'); assert.deepEqual(r.loan_recoveries, []);
  assert.ok(!r.components.some(c => c.code.startsWith('LOAN:'))); });

test('deductions warning: strictly above the limit, advances left out', () => {
  const s = {...base().setup, base:'10000'};
  const warn = (o) => flagCodes(computeLine(base({ setup:s, ...o }))).includes('DEDUCTIONS_OVER_PCT');
  assert.equal(warn({ balances:{advance:'0', loans:[loan(1,'5000','9000')]} }), false);       // exactly 50%
  assert.equal(warn({ balances:{advance:'0', loans:[loan(1,'5000.01','9000')]} }), true);
  assert.equal(warn({ balances:{advance:'6000', loans:[]} }), false);                         // advances don't count
  assert.equal(warn({ inputs:{misc_deduction:'3000'}, balances:{advance:'0', loans:[loan(1,'2500.01','9000')]} }), true);
  assert.equal(warn({ setup:{...s, base:'0'}, inputs:{misc_deduction:'100'} }), false);       // no gross, nothing to compare
  // 6000 is wanted (60%) but paid-separately pay leaves room for only 3000 (30%), and that is what counts
  assert.equal(warn({ inputs:{paid_separately:'7000'}, balances:{advance:'0', loans:[loan(1,'6000','9000')]} }), false); });

test('high OT is strictly above the threshold', () => {
  const high = (h) => flagCodes(computeLine(base({ inputs:{ot_hours:h} }))).includes('HIGH_OT');
  assert.equal(high('150'), false); assert.equal(high('150.01'), true); });

test('variance: signed integer percent, strictly above the limit, with what moved', () => {
  const v = (gross, previous) => computeLine(base({ setup:{...base().setup, base:gross}, previous })).flags
    .find(f => f.code === 'VARIANCE');
  const last = {gross:'20000', components:{}};
  assert.equal(v('26000', last).message, '+30% vs last month');
  assert.equal(v('26000', last).level, 'info');
  assert.equal(v('14000', last).message, '-30% vs last month');
  assert.equal(v('26510', last).message, '+33% vs last month');             // 32.55% rounds half away from zero
  assert.equal(v('25000', last), undefined); assert.equal(v('15000', last), undefined);      // exactly ±25%
  assert.equal(v('26000', {gross:'0', components:{}}), undefined);
  assert.equal(v('26000', null), undefined);
  assert.equal(v('26000', {gross:'20000', components:{BASIC:'20000', OT:'0'}}).message, '+30% vs last month (Basic +₹6,000)');
  assert.equal(v('14000', {gross:'20000', components:{BASIC:'20000'}}).message, '-30% vs last month (Basic -₹6,000)'); });

test('flags come blockers first, then warnings, then information', () => {
  const r = computeLine(base({ setup:{...base().setup, pay_basis:'contract'},
    person:{status:'active', pay_channel_kind:'bank', has_bank_details:false, joined_on:'2026-07-10'} }));
  assert.deepEqual(r.flags.map(f => [f.level, f.code]), [
    ['block', 'BILL_AMOUNT_MISSING'], ['warn', 'NO_BANK_DETAILS'], ['info', 'JOINED_MID_MONTH']]);
  for (const f of r.flags) assert.ok(f.message, f.code);
  // found warn-first (OT_NO_RATE), block second (PAID_SEPARATELY_EXCEEDS), reported block-first
  const mixed = computeLine(base({ setup:{...base().setup, base:'3255', ot_hours_per_day:'0'},
    inputs:{ot_hours:'5', paid_separately:'5500'} }));
  assert.deepEqual(mixed.flags.map(f => [f.level, f.code]), [['block', 'PAID_SEPARATELY_EXCEEDS'], ['warn', 'OT_NO_RATE']]); });

test('blank and missing inputs count as not given', () => {
  const r = computeLine(base({ inputs:{ot_hours:'', absent_days:null, misc_earning:undefined, bonus:'  '} }));
  assert.equal(r.gross, '36000.00'); assert.deepEqual(r.components.map(c => c.code), ['BASIC']); });

test('numbers from the database (JS numbers) are read exactly', () => {
  const r = computeLine(base({ setup:{...base().setup, base:36000}, inputs:{absent_days:2, misc_earning:0.1}, balances:{advance:0, loans:[]} }));
  assert.equal(r.basic, '33677.42'); assert.equal(r.misc_earning, '0.10'); });

test('without a policy the defaults apply: whole rupees, 150 OT hours, 50% deductions, 25% variance', () => {
  const bare = (o, policy) => computeLine({ ...base(o), policy });
  for (const policy of [undefined, null, {}]) {
    const r = bare({ setup:{...base().setup, base:'32550'}, inputs:{misc_earning:'0.49'} }, policy);
    assert.deepEqual([r.payable, r.rounding], ['32550.00', '-0.49'], JSON.stringify(policy));
    assert.ok(flagCodes(bare({ inputs:{ot_hours:'151'} }, policy)).includes('HIGH_OT'));
    assert.ok(!flagCodes(bare({ inputs:{ot_hours:'150'} }, policy)).includes('HIGH_OT'));
    const loanOf = (due) => ({ setup:{...base().setup, base:'10000'}, balances:{advance:'0', loans:[loan(1, due, '9000')]} });
    assert.ok(flagCodes(bare(loanOf('5001'), policy)).includes('DEDUCTIONS_OVER_PCT'));
    assert.ok(!flagCodes(bare(loanOf('5000'), policy)).includes('DEDUCTIONS_OVER_PCT'));
    const moved = (gross) => flagCodes(bare({ setup:{...base().setup, base:gross}, previous:{gross:'20000', components:{}} }, policy));
    assert.ok(moved('25001').includes('VARIANCE')); assert.ok(!moved('25000').includes('VARIANCE')); }
  const partial = computeLine(base({ setup:{...base().setup, base:'32550'}, policy:{rounding:'paise'}, inputs:{misc_earning:'0.49'} }));
  assert.equal(partial.payable, '32550.49'); });

test('the engine divides by the daysInMonth it is given, or works it out from the month', () => {
  const basic = (o) => computeLine({ ...base({ setup:{...base().setup, base:'30000'}, inputs:{absent_days:'1'} }), ...o }).basic;
  assert.equal(basic({ daysInMonth:30 }), '29000.00');                  // 30000 − 30000/30
  assert.equal(basic({ daysInMonth:'30' }), '29000.00');
  assert.equal(basic({ daysInMonth:undefined }), '29032.26');           // July: 30000 − 30000/31
  assert.equal(basic({ daysInMonth:null }), '29032.26'); });

test('labels: a loan is named by its number, an adjustment without a label by its id', () => {
  const r = computeLine(base({ adjustments:[{id:8, kind:'earning', amount:'10'}, {id:9, kind:'deduction', label:' ', amount:'5'}],
    balances:{advance:'0', loans:[loan(9, '1000', '4000'), {loan_id:12, due:'100', outstanding:'500'}]} }));
  const label = (code) => r.components.find(c => c.code === code).label;
  assert.deepEqual([label('LOAN:9'), label('LOAN:12'), label('ADJ:8'), label('ADJ:9')],
    ['Loan L9', 'Loan 12', 'Adjustment 8', 'Adjustment 9']); });

test('bad input throws instead of computing nonsense', () => {
  assert.throws(() => computeLine(base({ setup:{...base().setup, base:'-1'} })), RangeError);
  assert.throws(() => computeLine(base({ inputs:{absent_days:'-1'} })), RangeError);
  assert.throws(() => computeLine(base({ inputs:{misc_earning:'-5'} })), RangeError);
  assert.throws(() => computeLine(base({ adjustments:[{id:1, kind:'earning', label:'x', amount:'-5'}] })), RangeError);
  assert.throws(() => computeLine(base({ adjustments:[{id:1, kind:'bonus', label:'x', amount:'5'}] })), TypeError);
  assert.throws(() => computeLine(base({ inputs:{ot_hours:'abc'} })), TypeError);
  assert.throws(() => computeLine(base({ setup:{...base().setup, pay_basis:'weekly'} })), TypeError);
  assert.throws(() => computeLine(base({ setup:{...base().setup, absence_basis:'fixed_divisor'} })), RangeError);
  assert.throws(() => computeLine(base({ setup:{...base().setup, holiday_mode:'formula'} })), RangeError);
  assert.throws(() => computeLine(base({ month:'2026-7' })), TypeError);
  assert.throws(() => computeLine(base({ daysInMonth:0 })), RangeError);
  assert.throws(() => computeLine(base({ person:{...base().person, joined_on:'10/07/2026'} })), TypeError);
  assert.throws(() => computeLine(base({ person:{...base().person, joined_on:'2026-02-30'} })), TypeError);
  assert.throws(() => computeLine(base({ policy:{...base().policy, rounding:'nearest'} })), TypeError); });

test('computeLine leaves its input alone and answers the same twice', () => {
  const p = deepFreeze(base({ balances:{advance:'100', loans:[loan(1,'50','500')]}, inputs:{ot_hours:'3', absent_days:'1'},
    adjustments:[{id:1, kind:'earning', label:'A', amount:'10'}, {id:2, kind:'deduction', label:'B', amount:'5'}],
    previous:{gross:'30000', components:{BASIC:'30000'}} }));
  assert.deepEqual(computeLine(p), computeLine(p)); });

test('daysInMonthOf: leap centuries, every month length, and a bad month throws', () => {
  assert.equal(daysInMonthOf('2100-02'), 28); assert.equal(daysInMonthOf('2000-02'), 29);
  assert.deepEqual(['01','02','03','04','05','06','07','08','09','10','11','12'].map(m => daysInMonthOf(`2026-${m}`)),
    [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
  for (const bad of ['2026-13', '2026-00', '2026-7', '26-07', 'July', '', null, undefined, 202607]) {
    assert.throws(() => daysInMonthOf(bad), TypeError, String(bad)); } });

test('effectiveSetup: any array order, the 1st of the month counts, nothing yet gives null', () => {
  const s = [{effective_from:'2026-08-01', base:'3'}, {effective_from:'2026-04-01', base:'1'}, {effective_from:'2026-06-15', base:'2'}];
  assert.equal(effectiveSetup(s, '2026-07').base, '2');                       // 15 June is not after 1 July...
  assert.equal(effectiveSetup(s, '2026-06').base, '1');                       // ...but it is after 1 June
  assert.equal(effectiveSetup(s, '2026-05').base, '1'); assert.equal(effectiveSetup(s, '2026-08').base, '3');
  assert.equal(effectiveSetup(s, '2026-04').base, '1'); assert.equal(effectiveSetup(s, '2026-03'), null);
  assert.equal(effectiveSetup([], '2026-07'), null); assert.equal(effectiveSetup(undefined, '2026-07'), null);
  assert.throws(() => effectiveSetup(s, '2026-7'), TypeError); });
