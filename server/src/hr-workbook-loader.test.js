// The salary-workbook loader (hr/workbook-loader.js).
//
// At go-live the owner's existing monthly salary workbook seeds the HR module: who is paid, how, what each person
// owes at month end, and (for the acceptance test) the workbook's own results. The loader reads four sheets in the
// "July layout" (FINAL SHEET, GENERAL DATA, New data, BANK DETAILS) and guesses nothing: a rule it cannot apply is an
// issue or a review note, never a silent default.
//
// The fixtures spell every header exactly as the real workbook does (trailing spaces, NBSPs, mixed case, the blank
// headers over two New data columns, the second block on GENERAL DATA), so the tests prove the column lookup. The column
// names are structure, not personal data. The values are not: every name, code and account number here is synthetic
// (the repo is public).
// Expected values below are hand-derived from the fixtures, never copied from the module's output.
// NBSP is built with String.fromCharCode(0xa0): an editor may silently turn a typed one into a plain space.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSalaryWorkbook } from './hr/workbook-loader.js';

const NBSP = String.fromCharCode(0xa0);
const CONTRACTOR_NOTE = 'typed BASIC read as a contractor bill — check';
const HOLIDAY_TYPED_NOTE = 'typed holiday amount — monthly or one-off?';

// ── Fixture helpers ───────────────────────────────────────────────────

async function bookOf(build) {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  build(wb);
  return wb.xlsx.writeBuffer();
}

// Puts rows of cell values on a sheet from Excel row `from`; an undefined value leaves that cell empty.
function put(ws, rows, from = 1) {
  rows.forEach((cells, r) => cells.forEach((value, c) => {
    if (value !== undefined) ws.getCell(from + r, c + 1).value = value;
  }));
}

// A formula cell with the result Excel cached for it.
const calc = (formula, result) => ({ formula, result });

// Excel column letters: 0 is A, 25 is Z, 26 is AA (the real FINAL SHEET runs to AF).
function letters(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}
const refsOf = (layout) => (header, row) => `${letters(layout.indexOf(header))}${row}`;

// FINAL SHEET as the real workbook lays it out, left to right: [the key the tests use, the header cell's text]. The text is
// the real spelling, trailing spaces and mixed case included ('Anik ', 'Final Payment ', 'Misc. '). 'INC ' is there twice
// (as 'INC ' and 'Inc'); 'ADV2', 'OT AMT', 'PRESENT ', 'WAGES', 'BAL SAL ' and the rest are look-alikes the loader must
// not mistake for the columns it reads. BASE 2026, the highest base year, is column G, so a holiday formula for row 5
// reads G5/30.5*1.5.
const REAL_FINAL = [
  ['PERSON', 'PERSON '], ['CODE NO.', 'Code No. '], ['FIRM', 'FIRM '], ['DEPARTMENT', 'DEPARTMENT '],
  ['TRANS MODE', 'TRANS MODE '], ['C STAT', 'C STAT '], ['BASE 2026', 'BASE 2026'], ['BASE 2025', 'BASE 2025'],
  ['INC', 'INC '], ['BASE 2024', 'BASE 2024'], ['INC 2', 'Inc'], ['Column1', 'Column1'], ['HP', 'HP'], ['OT', 'OT'], ['AB', 'AB'],
  ['ANIK', 'Anik '], ['FINAL PAYMENT', 'Final Payment '], ['STATUS', 'STATUS '], ['ADV', 'ADV'], ['LOAN', 'LOAN'],
  ['INST', 'Inst'], ['OS', 'OS '], ['OT CRT', 'OT CRT'], ['PRESENT', 'PRESENT '], ['WAGES', 'WAGES'], ['BASIC', 'BASIC'],
  ['OT AMT', 'OT AMT'], ['MISC.', 'Misc. '], ['HOLIDAY', 'HOLIDAY '], ['TOTAL SAL', 'TOTAL SAL'], ['ADV2', 'ADV2'],
  ['BAL SAL', 'BAL SAL '],
];
const LAYOUT = REAL_FINAL.map(([key]) => key);
const HEADER_TEXT = Object.fromEntries(REAL_FINAL);
const ref = refsOf(LAYOUT);

// `people` are objects keyed by the keys above; a function value is called with the Excel row, to write a formula that
// names its own row. An undefined value leaves the cell empty. MONTH and DAYS sit in rows 1-2 and the header on row 4.
function finalSheet(ws, people, opts = {}) {
  const { layout = LAYOUT, headerRow = 4, head = (h) => HEADER_TEXT[h] ?? h, top = [['MONTH ', 'July', 2026], ['DAYS ', 31]] } = opts;
  put(ws, top);
  layout.forEach((h, c) => { ws.getCell(headerRow, c + 1).value = head(h); });
  people.forEach((p, i) => {
    const row = headerRow + 1 + i;
    layout.forEach((h, c) => {
      const v = typeof p[h] === 'function' ? p[h](row) : p[h];
      if (v !== undefined) ws.getCell(row, c + 1).value = v;
    });
  });
}

// One ordinary salaried person; each test overrides what it is about.
const staff = (over = {}) => ({
  PERSON: 'TEST ONE', 'CODE NO.': 1, 'BASE 2026': 30000, 'OT CRT': 8, OT: 0, AB: 0, 'MISC.': 0,
  BASIC: (r) => calc(`${ref('BASE 2026', r)}/31*(31-${ref('AB', r)})`, 30000),
  'TOTAL SAL': 30000, ADV: 0, INST: 0, OS: 0, ANIK: 0, 'FINAL PAYMENT': 30000,
  ...over,
});

// The three input sheets, headed as the real workbook heads them. Each row helper takes an object and lays it out in the
// sheet's columns.
//   GENERAL DATA (header on row 1): NBSPs and trailing spaces as in the workbook. A second block, 'PERSONS NOT FOUND IN
//   GENERAL DATA', starts in column N with its header on row 2.
const GENERAL_HEAD = ['PERSON' + NBSP, 'Code No. ', 'FIRM ', 'DEPT', 'CODE NO. 2', 'STATUS', 'OT', 'AB', 'MISC.' + NBSP,
  'ADVANCE' + NBSP, 'BILL AMOUNT ', 'REMARKS' + NBSP];
const generalRow = (r) => [r.name, r.code, r.firm, r.dept, r.code2, r.status, r.ot, r.ab, r.misc, r.adv, r.bill, r.remark];
//   New data (header on row 1): the headers over D (the department values) and F (the pay-channel values) are blank.
const NEW_HEAD = ['NAME' + NBSP, 'CODE NO', 'FIRM', undefined, 'CODE 2', undefined, 'OT', 'AB', 'MISC.' + NBSP,
  'ADVANCE' + NBSP, 'BILL AMOUNT' + NBSP, 'REMARKS' + NBSP];
const newRow = (r) => [r.name, r.code, r.firm, r.dept, r.code2, r.channel, r.ot, r.ab, r.misc, r.adv, r.bill, r.remark];
//   BANK DETAILS (header on row 1). BANK NAME holds the account holder's name.
const BANK_HEAD = ['NAME', 'Code No. ', 'FIRM ', 'DEPARTMENT ', 'C STAT ', 'BANK NAME ', 'A/c Number ', 'IFSC ', 'Bank Allocation ',
  'Mode ', 'ESI payable ', 'Form !', 'Type ', 'ESI Listing '];
const bankRow = (r) => [r.name, r.code, r.firm, r.dept, r.cstat, r.holder, r.account, r.ifsc, r.allocation, r.mode, r.esi, r.form, r.type, r.listing];

const addGeneral = (wb, rows) => put(wb.addWorksheet('GENERAL DATA '), [GENERAL_HEAD, ...rows.map(generalRow)]);
const addNewData = (wb, rows) => put(wb.addWorksheet('New data '), [NEW_HEAD, ...rows.map(newRow)]);
const addBank = (wb, rows, name = 'BANK DETAILS') => put(wb.addWorksheet(name), [BANK_HEAD, ...rows.map(bankRow)]);

// A workbook with FINAL SHEET and whatever else `extra` adds; `extra(wb)` runs after FINAL SHEET is written.
const parseStaff = async (people, opts, extra) => parseSalaryWorkbook(await bookOf((wb) => {
  finalSheet(wb.addWorksheet('FINAL SHEET'), people, opts);
  if (extra) extra(wb);
}));

const mentioning = (parsed, pattern) => parsed.issues.filter((i) => pattern.test(i.message));
const codesOf = (parsed) => parsed.people.map((p) => p.code);

// ── The brief's workbook: three people, a bank sheet, GENERAL DATA and New data ──

// ALPHA ONE: monthly, base 31000 (31 days, 2 absent, 16 OT hours at 8 a day), holiday 31000 / 30.5 x 1.5, a loan with a
// standing instalment. Cached results carry the float noise a real workbook has: gross 33024.59016393443 shows as 33024.59.
// The look-alike columns (INC, ADV2, OT AMT, PRESENT, WAGES, BAL SAL ...) hold values that would show if they were read.
const ALPHA = {
  PERSON: 'ALPHA ONE', 'CODE NO.': '011', FIRM: 'ALPHA WORKS', DEPARTMENT: 'PRINTING', 'TRANS MODE': 'BANK A', 'C STAT': 'S',
  'BASE 2026': 31000, 'BASE 2025': 29000, INC: 1500, 'BASE 2024': 27000, 'INC 2': 777, Column1: 'x', HP: 'H1',
  OT: 16, AB: 2, STATUS: 'ACTIVE', ADV: 1000, LOAN: 12000, INST: 2000, OS: 10000, 'OT CRT': 8, PRESENT: 29,
  WAGES: (r) => calc(`${ref('BASIC', r)}`, 29000),
  BASIC: (r) => calc(`${ref('BASE 2026', r)}/31*(31-${ref('AB', r)})`, 29000),
  'OT AMT': (r) => calc(`${ref('BASE 2026', r)}/31/${ref('OT CRT', r)}*${ref('OT', r)}`, 2000),
  'MISC.': 500,
  HOLIDAY: (r) => calc(`${ref('BASE 2026', r)}/30.5*1.5`, 1524.5901639344262),
  'TOTAL SAL': (r) => calc(`${ref('BASIC', r)}+${ref('OT AMT', r)}+${ref('HOLIDAY', r)}+${ref('MISC.', r)}`, 33024.59016393443),
  ADV2: 999, 'BAL SAL': 30000.5,
  'FINAL PAYMENT': (r) => calc(`${ref('TOTAL SAL', r)}-${ref('ADV', r)}-${ref('INST', r)}`, 30024.59016393443),
};
// BRAVO TWO: a contractor. BASIC is typed (the bill), not a formula; WAGES, beside it, is a formula. TRANS MODE is blank,
// so the pay channel comes from the bank sheet's Bank Allocation.
const BRAVO = {
  PERSON: 'BRAVO TWO', 'CODE NO.': 12, FIRM: 'BRAVO TRADERS', DEPARTMENT: 'CUTTING',
  'OT CRT': 0, OT: 0, AB: 0, 'MISC.': 0, STATUS: 'ACTIVE', PRESENT: 31, ADV2: 777,
  WAGES: (r) => calc(`${ref('BASIC', r)}`, 45000), BASIC: 45000,
  'TOTAL SAL': (r) => calc(`${ref('BASIC', r)}`, 45000), ANIK: 5000,
  'FINAL PAYMENT': (r) => calc(`${ref('TOTAL SAL', r)}-${ref('ANIK', r)}`, 40000),
};
// CHARLIE THREE: a typed holiday amount, a negative final (24150 - 25000), a loan with no instalment but a remark.
const CHARLIE = {
  PERSON: 'CHARLIE THREE', 'CODE NO.': 'ci13', FIRM: 'ALPHA WORKS', DEPARTMENT: 'PASTING', 'TRANS MODE': 'CASH', 'C STAT': 'R',
  'BASE 2026': 20150, 'OT CRT': 6, OT: 0, AB: 0, 'MISC.': 0, STATUS: 'ACTIVE', PRESENT: 31,
  BASIC: (r) => calc(`${ref('BASE 2026', r)}/31*31`, 20150), HOLIDAY: 4000,
  'TOTAL SAL': (r) => calc(`${ref('BASIC', r)}+${ref('HOLIDAY', r)}`, 24150),
  ADV: 25000, LOAN: 20000, INST: 0, OS: 20000,
  'FINAL PAYMENT': (r) => calc(`${ref('TOTAL SAL', r)}-${ref('ADV', r)}`, -850),
};
const TOTALS = {
  PERSON: 'TOTAL', 'TOTAL SAL': (r) => calc(`SUM(${ref('TOTAL SAL', 5)}:${ref('TOTAL SAL', r - 2)})`, 102174.59016393442),
  ADV: 26000, OS: 30000,
  'FINAL PAYMENT': (r) => calc(`SUM(${ref('FINAL PAYMENT', 5)}:${ref('FINAL PAYMENT', r - 2)})`, 68924.59016393443),
};

function mainBook() {
  return bookOf((wb) => {
    // Rows 5-7 are the people, row 8 is blank, row 9 is the totals row.
    finalSheet(wb.addWorksheet('FINAL SHEET'), [ALPHA, BRAVO, CHARLIE, {}, TOTALS]);
    const general = wb.addWorksheet('GENERAL DATA ');
    put(general, [
      GENERAL_HEAD,
      // The firm and department here differ from FINAL SHEET's: FINAL SHEET's are the ones that count.
      generalRow({ name: 'ALPHA ONE', code: '011', firm: 'OTHER FIRM', dept: 'OTHER DEPT', status: 'ACTIVE', ot: 16, ab: 2, misc: 500, adv: 1000 }),
      generalRow({ name: 'BRAVO TWO', code: 12, ot: 0, ab: 0, misc: 0, adv: 0, bill: 45000 }),
      generalRow({ name: 'CHARLIE', code: 'CI13', ot: 0, ab: 0, misc: 0, adv: 25000, remark: '4X5000 FROM NEXT MONTH' }),   // the code agrees, the name is a short form
    ]);
    general.getCell('N2').value = 'PERSONS NOT FOUND IN GENERAL DATA';        // the second block: its header is on row 2
    general.getCell('N3').value = 'GHOST PERSON';
    addNewData(wb, [
      { name: 'ALPHA ONE', code: 11, firm: 'ALPHA WORKS', dept: 'PRINTING', code2: 'B1', channel: 'BANK A', ot: 16, ab: 2, misc: 500, adv: 1000 },
      { name: 'CHARLIE', code: 'CI13', firm: 'ALPHA WORKS', dept: 'PASTING', code2: 'C1', channel: 'CASH', adv: 25000 },
    ]);
    addBank(wb, [
      // The bank sheet's own firm, department, C STAT, Mode, Form and ESI Listing are look-alikes, and so is ALPHA's
      // Bank Allocation: TRANS MODE (BANK A) is the pay channel.
      { name: 'ALPHA ONE', code: '007', firm: 'BANK FIRM', dept: 'BANK DEPT', cstat: 'Q', holder: 'ALPHA ONE SURNAME', account: '000012345678',
        ifsc: 'TEST0000001', allocation: 'OTHER BANK', mode: 'NEFT', esi: 'Yes', form: 'F1', type: 'Employee', listing: 'L1' },
      // BRAVO's TRANS MODE is blank: the Bank Allocation says BANK B. The name has stray case and spacing.
      { name: 'Bravo  Two ', code: 'b2', holder: 'BRAVO TWO TRADERS', account: 9876543210, ifsc: 'TEST0000002', allocation: 'BANK B',
        esi: 'No', type: 'Contractor' },
      { name: 'UNKNOWN ONE', code: '009', holder: 'UNKNOWN ONE SURNAME', account: '000099999999', ifsc: 'TEST0000003', esi: 'Yes', type: 'Employee' },
    ]);
  });
}
let mainRun;
const main = () => (mainRun ??= mainBook().then(parseSalaryWorkbook));

test('July layout: month 2026-07, 31 days, and exactly the brief\'s keys', async () => {
  const parsed = await main();
  assert.deepEqual(Object.keys(parsed),
    ['month', 'daysInMonth', 'people', 'setups', 'openingLoans', 'openingAdvances', 'monthInputs', 'expected', 'issues']);
  assert.equal(parsed.month, '2026-07');
  assert.equal(parsed.daysInMonth, 31);
});

test('July layout: three people, joined to BANK DETAILS by name; the totals row and the blank row are not people', async () => {
  const { people } = await main();
  assert.deepEqual(people, [
    {
      code: '11', name: 'ALPHA ONE SURNAME', display_name: 'ALPHA ONE', firm: 'ALPHA WORKS', department: 'PRINTING',
      worker_type: 'employee', pay_channel_label: 'BANK A', legacy: { c_stat: 'S', hp: 'H1', bank_code: '7' },
      bank: { holder: 'ALPHA ONE SURNAME', account: '000012345678', ifsc: 'TEST0000001' }, esi_applicable: true,
    },
    {
      code: '12', name: 'BRAVO TWO TRADERS', display_name: 'BRAVO TWO', firm: 'BRAVO TRADERS', department: 'CUTTING',
      worker_type: 'contractor', pay_channel_label: 'BANK B', legacy: { c_stat: null, hp: null, bank_code: 'B2' },
      bank: { holder: 'BRAVO TWO TRADERS', account: '9876543210', ifsc: 'TEST0000002' }, esi_applicable: false,
    },
    {
      code: 'CI13', name: 'CHARLIE THREE', display_name: 'CHARLIE THREE', firm: 'ALPHA WORKS', department: 'PASTING',
      worker_type: 'employee', pay_channel_label: 'CASH', legacy: { c_stat: 'R', hp: null, bank_code: null },
      bank: null, esi_applicable: false,
    },
  ]);
});

test('July layout: pay setups: the contractor, the holiday modes and the review notes', async () => {
  const { setups } = await main();
  assert.deepEqual(setups, [
    {
      code: '11', pay_basis: 'monthly', base: '31000.00', ot_hours_per_day: '8',
      holiday_mode: 'formula', holiday_divisor: '30.5', holiday_multiplier: '1.5', holiday_fixed: null, review: [],
    },
    {
      code: '12', pay_basis: 'contract', base: '0.00', ot_hours_per_day: '0',
      holiday_mode: 'none', holiday_divisor: null, holiday_multiplier: null, holiday_fixed: null, review: [CONTRACTOR_NOTE],
    },
    {
      code: 'CI13', pay_basis: 'monthly', base: '20150.00', ot_hours_per_day: '6',
      holiday_mode: 'fixed', holiday_divisor: null, holiday_multiplier: null, holiday_fixed: '4000.00',
      review: [HOLIDAY_TYPED_NOTE],
    },
  ]);
});

test('July layout: opening loans (instalment from INST, and from the remark with a review note) and the opening advance', async () => {
  const { openingLoans, openingAdvances } = await main();
  assert.equal(openingLoans.length, 2);
  assert.deepEqual(openingLoans[0], { code: '11', outstanding: '10000.00', instalment: '2000.00', review: [] });
  const [fromRemark] = openingLoans.slice(1);
  assert.equal(fromRemark.code, 'CI13');
  assert.equal(fromRemark.outstanding, '20000.00');
  assert.equal(fromRemark.instalment, '5000.00');                              // '4X5000': the second number
  assert.equal(fromRemark.review.length, 1);
  assert.match(fromRemark.review[0], /4X5000 FROM NEXT MONTH/);               // the note names the remark
  assert.match(fromRemark.review[0], /GENERAL DATA/);                          // and where it was read
  assert.deepEqual(openingAdvances, [{ code: 'CI13', amount: '850.00' }]);    // the negative final, sign dropped
});

test('July layout: month inputs are the cached values; expected carries them rounded and exact', async () => {
  const { monthInputs, expected } = await main();
  assert.deepEqual(monthInputs, [
    { code: '11', name: 'ALPHA ONE', ot_hours: '16', absent_days: '2', misc_earning: '500.00', advance_given: '1000.00',
      bill_amount: null, paid_separately: '0.00', loan_instalment: '2000.00' },
    { code: '12', name: 'BRAVO TWO', ot_hours: '0', absent_days: '0', misc_earning: '0.00', advance_given: '0.00',
      bill_amount: '45000.00', paid_separately: '5000.00', loan_instalment: '0.00' },
    { code: 'CI13', name: 'CHARLIE THREE', ot_hours: '0', absent_days: '0', misc_earning: '0.00', advance_given: '25000.00',
      bill_amount: null, paid_separately: '0.00', loan_instalment: '0.00' },
  ]);
  assert.deepEqual(expected, [
    { code: '11', gross: '33024.59', final: '30024.59', gross_exact: '33024.59016393443', final_exact: '30024.59016393443' },
    { code: '12', gross: '45000.00', final: '40000.00', gross_exact: '45000', final_exact: '40000' },
    { code: 'CI13', gross: '24150.00', final: '-850.00', gross_exact: '24150', final_exact: '-850' },
  ]);
});

test('July layout: the only issue is the BANK DETAILS row that matches nobody', async () => {
  const { issues } = await main();
  assert.equal(issues.length, 1);
  assert.equal(issues[0].level, 'warn');
  assert.deepEqual(Object.keys(issues[0]), ['level', 'message']);
  assert.match(issues[0].message, /UNKNOWN ONE/);
  assert.match(issues[0].message, /row 4/);                                    // BANK DETAILS Excel row 4
});

// ── The real header spellings ─────────────────────────────────────────

test('real headers: each column the loader reads is found by its real spelling, and the look-alike columns are not mistaken for it', async () => {
  // Every column the loader reads holds its own number, so a swap between any two would show. The look-alikes (ADV2, OT AMT,
  // PRESENT, WAGES, BAL SAL, INC twice, LOAN, STATUS, Column1) hold numbers that would show too.
  const parsed = await parseStaff([staff({
    PERSON: 'SENTINEL', 'CODE NO.': 21, FIRM: 'FIRM-S', DEPARTMENT: 'DEPT-S', 'TRANS MODE': 'MODE-S', 'C STAT': 'STAT-S', HP: 'HP-S',
    'BASE 2026': 2600, 'BASE 2025': 2500, INC: 94, 'BASE 2024': 2400, 'INC 2': 93, Column1: 'C1',
    'OT CRT': 11, OT: 1, AB: 2, 'MISC.': 3, ADV: 4, INST: 5, OS: 6, ANIK: 7, 'TOTAL SAL': 8, 'FINAL PAYMENT': 9, HOLIDAY: 12.5,
    STATUS: 'STATUS-S', PRESENT: 97, WAGES: 96, 'OT AMT': 98, ADV2: 99, 'BAL SAL': 95, LOAN: 92,
  })]);
  const [person] = parsed.people;
  assert.deepEqual([person.firm, person.department, person.pay_channel_label], ['FIRM-S', 'DEPT-S', 'MODE-S']);
  assert.deepEqual(person.legacy, { c_stat: 'STAT-S', hp: 'HP-S', bank_code: null });
  assert.deepEqual(parsed.setups[0], {
    code: '21', pay_basis: 'monthly', base: '2600.00', ot_hours_per_day: '11',
    holiday_mode: 'fixed', holiday_divisor: null, holiday_multiplier: null, holiday_fixed: '12.50', review: [HOLIDAY_TYPED_NOTE],
  });
  assert.deepEqual(parsed.monthInputs[0], {
    code: '21', name: 'SENTINEL', ot_hours: '1', absent_days: '2', misc_earning: '3.00', advance_given: '4.00',
    bill_amount: null, paid_separately: '7.00', loan_instalment: '5.00',
  });
  assert.deepEqual(parsed.openingLoans, [{ code: '21', outstanding: '6.00', instalment: '5.00', review: [] }]);
  assert.deepEqual(parsed.expected, [{ code: '21', gross: '8.00', final: '9.00', gross_exact: '8', final_exact: '9' }]);
  assert.deepEqual(mentioning(parsed, /FINAL SHEET has no/), []);             // every column the loader needs was found
});

// ── Ruling 1: the holiday rule comes from the HOLIDAY formula ─────────

test('holiday: BASE / divisor [* multiplier] against THIS row\'s BASE cell is a formula; anything else keeps its value', async () => {
  const base = (r) => ref('BASE 2026', r);
  // [label, HOLIDAY cell, [mode, divisor, multiplier, fixed, review]]
  const rule = (divisor, multiplier) => ['formula', divisor, multiplier, null, []];
  const kept = (amount) => ['fixed', null, null, amount, ['unrecognised holiday formula']];
  const typed = (amount) => ['fixed', null, null, amount, [HOLIDAY_TYPED_NOTE]];
  const none = ['none', null, null, null, []];
  const cases = [
    ['base / 30.5 * 1.5', (r) => calc(`${base(r)}/30.5*1.5`, 1524.59), rule('30.5', '1.5')],
    ['base / 30.5 alone is x 1', (r) => calc(`${base(r)}/30.5`, 1016.39), rule('30.5', '1')],
    ['spaces inside are ignored', (r) => calc(` ${base(r)} / 30.5 * 1.5 `, 1524.59), rule('30.5', '1.5')],
    ['$ anchors name the same cell', (r) => calc(`$G$${r}/30.5*1.5`, 1524.59), rule('30.5', '1.5')],
    ['any divisor', (r) => calc(`${base(r)}/31`, 1000), rule('31', '1')],
    ['a formula that calculates to 0 is still the formula', (r) => calc(`${base(r)}/30.5*1.5`, 0), rule('30.5', '1.5')],
    ["another row's base", (r) => calc(`G${r + 1}/30.5*1.5`, 1500), kept('1500.00')],
    ['a term added', (r) => calc(`${base(r)}/30.5*1.5+500`, 2024.59), kept('2024.59')],
    ['wrapped in a function', (r) => calc(`ROUND(${base(r)}/30.5*1.5,0)`, 1525), kept('1525.00')],
    ['a typed amount', 1234.5, typed('1234.50')],
    ['typed 0', 0, none],
    ['blank', undefined, none],
  ];
  const parsed = await parseStaff(cases.map(([name, cell], i) => staff({ PERSON: name, 'CODE NO.': i + 1, HOLIDAY: cell })));
  assert.equal(parsed.setups.length, cases.length);
  cases.forEach(([name, , want], i) => {
    const s = parsed.setups[i];
    assert.deepEqual([s.holiday_mode, s.holiday_divisor, s.holiday_multiplier, s.holiday_fixed, s.review], want, name);
  });
});

// ── Ruling 2: a typed BASIC is a contractor's bill ────────────────────

test('contractor: only a typed, non-blank BASIC is a contract, and each one is flagged for review; a formula or a blank is monthly', async () => {
  const parsed = await parseStaff([
    staff({ PERSON: 'TYPED', 'CODE NO.': 1, BASIC: 45000.5 }),
    staff({ PERSON: 'FORMULA', 'CODE NO.': 2 }),
    staff({ PERSON: 'BLANK', 'CODE NO.': 3, BASIC: undefined }),
    staff({ PERSON: 'TYPED ZERO', 'CODE NO.': 4, BASIC: 0 }),                       // a typed 0 is still a typed BASIC
  ]);
  assert.deepEqual(parsed.setups.map((s) => s.pay_basis), ['contract', 'monthly', 'monthly', 'contract']);
  assert.deepEqual(parsed.monthInputs.map((m) => m.bill_amount), ['45000.50', null, null, '0.00']);
  assert.deepEqual(parsed.setups.map((s) => s.review), [[CONTRACTOR_NOTE], [], [], [CONTRACTOR_NOTE]]);
});

// ── Ruling 3: columns are found by normalised header text ─────────────

test('columns: stray spaces, NBSP, case and trailing dots are tolerated; BASE is the highest year wherever it sits; a repeated header is its leftmost', async () => {
  // BASE 2027 is in the middle of the three base columns, so neither "first" nor "last" finds it. The last column is a
  // second OT block that must be ignored.
  const ODD = ['PERSON', 'CODE NO.', 'BASE 2026', 'BASE 2027', 'BASE 2025', 'OT CRT', 'OT', 'AB', 'MISC.', 'BASIC', 'HOLIDAY',
    'TOTAL SAL', 'ADV', 'LOAN', 'INST', 'OS', 'ANIK', 'FINAL PAYMENT', 'OT'];
  const oddRef = refsOf(ODD);
  const HEAD = {
    PERSON: ' person ', 'CODE NO.': 'Code No', 'BASE 2027': 'Base' + NBSP + NBSP + '2027.', 'OT CRT': 'OT  CRT',
    'MISC.': 'misc', 'TOTAL SAL': 'TOTAL SAL.', 'FINAL PAYMENT': 'Final Payment ',
  };
  const person = {
    PERSON: 'ODD ONE', 'CODE NO.': 5, 'BASE 2026': 26000, 'BASE 2027': 27000, 'BASE 2025': 25000,
    'OT CRT': 6, OT: 10, AB: 1, 'MISC.': 100,
    BASIC: (r) => calc(`${oddRef('BASE 2027', r)}/31*30`, 26129.03),
    HOLIDAY: (r) => calc(`${oddRef('BASE 2027', r)}/30.5*1.5`, 1327.87),
    'TOTAL SAL': 30000, ADV: 0, INST: 0, OS: 0, ANIK: 0, 'FINAL PAYMENT': 30000,
  };
  const parsed = await parseSalaryWorkbook(await bookOf((wb) => {
    const ws = wb.addWorksheet('FINAL SHEET');
    finalSheet(ws, [person], { layout: ODD, head: (h) => HEAD[h] ?? h });
    ws.getCell(5, ODD.length).value = 99;                                    // the second OT block
  }));
  assert.deepEqual(codesOf(parsed), ['5']);
  assert.equal(parsed.setups[0].base, '27000.00');                           // BASE 2027
  assert.equal(parsed.setups[0].holiday_mode, 'formula');                    // D5/30.5*1.5: D is BASE 2027's column
  assert.equal(parsed.setups[0].ot_hours_per_day, '6');
  assert.equal(parsed.monthInputs[0].ot_hours, '10');                        // the leftmost OT, not 99
  assert.equal(parsed.monthInputs[0].misc_earning, '100.00');
  assert.deepEqual(parsed.expected, [{ code: '5', gross: '30000.00', final: '30000.00', gross_exact: '30000', final_exact: '30000' }]);
  assert.deepEqual(parsed.issues.filter((i) => i.level !== 'warn'), []);
});

test('columns: FINAL SHEET is the sheet whose header row has PERSON, CODE NO. and OT CRT, whatever it is called or where it sits', async () => {
  const parsed = await parseSalaryWorkbook(await bookOf((wb) => {
    put(wb.addWorksheet('FINAL SHEET'), [['NOTES'], ['not the salary sheet']]);   // named like it, but no such header row
    finalSheet(wb.addWorksheet('Salary July'), [staff()], { headerRow: 9 });
  }));
  assert.deepEqual(codesOf(parsed), ['1']);
  assert.equal(parsed.month, '2026-07');
});

test('columns: a missing money column is an error, a missing descriptive column a warning, and the rest still loads', async () => {
  const layout = LAYOUT.filter((h) => h !== 'ANIK' && h !== 'HP' && !h.startsWith('BASE'));
  const parsed = await parseStaff([staff()], { layout });
  assert.deepEqual(codesOf(parsed), ['1']);
  const levelOf = (pattern) => mentioning(parsed, pattern).map((i) => i.level);
  assert.deepEqual(levelOf(/\bANIK\b/), ['error']);
  assert.deepEqual(levelOf(/\bBASE\b/), ['error']);
  assert.deepEqual(levelOf(/\bHP\b/), ['warn']);
  assert.equal(parsed.setups[0].base, '0.00');
  assert.equal(parsed.monthInputs[0].paid_separately, '0.00');
});

test('columns: no FINAL SHEET at all is one error and nothing else', async () => {
  const parsed = await parseSalaryWorkbook(await bookOf((wb) => put(wb.addWorksheet('Sheet1'), [['A', 'B'], [1, 2]])));
  assert.equal(parsed.month, null);
  assert.equal(parsed.daysInMonth, null);
  for (const key of ['people', 'setups', 'openingLoans', 'openingAdvances', 'monthInputs', 'expected']) {
    assert.deepEqual(parsed[key], [], key);
  }
  assert.equal(parsed.issues.length, 1);
  assert.equal(parsed.issues[0].level, 'error');
  assert.match(parsed.issues[0].message, /FINAL SHEET/);
});

// ── Ruling 4: the month, from the cells right of MONTH and DAYS ───────

const NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December',
];
const LENGTHS_2026 = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const periodIssues = (parsed) => mentioning(parsed, /\b(MONTH|DAYS)\b/);

test('month: every month name maps to 01-12 and, with a DAYS cell that agrees with the calendar, there is nothing to say', async () => {
  for (const [i, name] of NAMES.entries()) {
    const parsed = await parseStaff([staff()], { top: [['MONTH', name, 2026], ['DAYS', LENGTHS_2026[i]]] });
    assert.equal(parsed.month, `2026-${String(i + 1).padStart(2, '0')}`, name);
    assert.equal(parsed.daysInMonth, LENGTHS_2026[i], name);
    assert.deepEqual(periodIssues(parsed), [], name);
  }
});

test('month: abbreviations, a number, a date cell, and MONTH and DAYS on one row', async () => {
  // [the MONTH row, the month it means, the calendar's days for it in 2026]
  const cases = [
    [['MONTH', 'jan', 2026], '2026-01', 31], [['MONTH', ' July ', 2026], '2026-07', 31], [['MONTH', 'SEPT', 2026], '2026-09', 30],
    [['MONTH', 'Dec.', 2026], '2026-12', 31], [['MONTH', 7, 2026], '2026-07', 31],
    [['MONTH', new Date(Date.UTC(2026, 6, 1))], '2026-07', 31],
    [['MONTH', 'August', 2026, 'DAYS', 31], '2026-08', 31],                    // both labels on the one row
  ];
  for (const [monthRow, want, days] of cases) {
    const top = monthRow.includes('DAYS') ? [monthRow] : [monthRow, ['DAYS', days]];
    const parsed = await parseStaff([staff()], { top });
    assert.equal(parsed.month, want, JSON.stringify(monthRow));
    assert.equal(parsed.daysInMonth, days, JSON.stringify(monthRow));
    assert.deepEqual(periodIssues(parsed), [], JSON.stringify(monthRow));
  }
});

test('month: a DAYS cell that disagrees with the calendar is a warning, and the workbook\'s own number is kept', async () => {
  const july30 = await parseStaff([staff()], { top: [['MONTH', 'July', 2026], ['DAYS', 30]] });
  assert.equal(july30.month, '2026-07');
  assert.equal(july30.daysInMonth, 30);                                      // the figures were worked out with 30
  assert.deepEqual(periodIssues(july30).map((i) => i.level), ['warn']);
  // The calendar knows leap years.
  const leap = await parseStaff([staff()], { top: [['MONTH', 'February', 2028], ['DAYS', 29]] });
  assert.deepEqual([leap.month, leap.daysInMonth, periodIssues(leap)], ['2028-02', 29, []]);
  const notLeap = await parseStaff([staff()], { top: [['MONTH', 'February', 2027], ['DAYS', 29]] });
  assert.deepEqual([notLeap.month, notLeap.daysInMonth, periodIssues(notLeap).map((i) => i.level)], ['2027-02', 29, ['warn']]);
});

test('month: what cannot be read is reported, never guessed', async () => {
  const noDays = await parseStaff([staff()], { top: [['MONTH', 'July', 2026]] });
  assert.deepEqual([noDays.month, noDays.daysInMonth], ['2026-07', 31]);     // the calendar's, with a warning
  assert.deepEqual(periodIssues(noDays).map((i) => i.level), ['warn']);

  const badDays = await parseStaff([staff()], { top: [['MONTH', 'July', 2026], ['DAYS', 'abc']] });
  assert.deepEqual([badDays.month, badDays.daysInMonth], ['2026-07', 31]);
  assert.deepEqual(periodIssues(badDays).map((i) => i.level), ['error']);

  for (const top of [[['DAYS', 31]], [['MONTH', 'Julyy', 2026], ['DAYS', 31]], [['MONTH', 'July'], ['DAYS', 31]]]) {
    const parsed = await parseStaff([staff()], { top });
    assert.equal(parsed.month, null, JSON.stringify(top));
    assert.equal(parsed.daysInMonth, 31, JSON.stringify(top));              // the sheet's own, with no calendar to check
    assert.deepEqual(periodIssues(parsed).map((i) => i.level), ['error'], JSON.stringify(top));
    assert.deepEqual(codesOf(parsed), ['1'], JSON.stringify(top));         // the people still load
  }
});

// ── Ruling 5: opening loans ───────────────────────────────────────────

test('opening loans: OS > 0; the instalment is INST, else the remark\'s count x amount, else null with a review note', async () => {
  const people = [
    staff({ PERSON: 'ONE PERSON', 'CODE NO.': 1, OS: 10000, INST: 2000 }),         // INST wins over any remark
    staff({ PERSON: 'TWO PERSON', 'CODE NO.': 2, OS: 5000, INST: undefined }),     // remark by code, blank INST
    staff({ PERSON: 'THREE PERSON', 'CODE NO.': 3, OS: 7000, INST: 0 }),           // remark on New data, by name, with the x sign
    staff({ PERSON: 'FOUR PERSON', 'CODE NO.': 4, OS: 3000, INST: 0 }),            // only a longer name starts like theirs
    staff({ PERSON: 'FIVE PERSON', 'CODE NO.': 5, OS: 4000, INST: 0 }),            // a remark with no count x amount in it
    staff({ PERSON: 'SIX PERSON', 'CODE NO.': 6, OS: 0 }),                         // nothing outstanding
    staff({ PERSON: 'SEVEN PERSON', 'CODE NO.': 7, OS: undefined }),
    staff({ PERSON: 'EIGHT PERSON', 'CODE NO.': 8, OS: 6000, INST: 0 }),           // same name, another code: still theirs
    staff({ PERSON: 'NINE PERSON', 'CODE NO.': 9, OS: 2500, INST: 0 }),            // both sheets have a remark: GENERAL DATA first
    staff({ PERSON: 'TEN PERSON', 'CODE NO.': 10, OS: 0.004, INST: 0 }),           // float noise that shows as 0.00
  ];
  const parsed = await parseStaff(people, undefined, (wb) => {
    addGeneral(wb, [
      { name: 'ONE', code: 1, remark: '3X9999' },
      { name: 'TWO (SHORT NAME)', code: '002', remark: '3 x 1500 monthly' },
      { name: 'FOUR PERSON LONGER NAME', code: 44, remark: '9X9999' },            // the old workbook's trap
      { name: 'FIVE PERSON', code: 5, remark: 'PAY BACK SOON' },
      { name: 'EIGHT PERSON', code: 99, remark: '2X3000' },
      { name: 'NINE PERSON', code: 9, remark: '5X500' },
    ]);
    addNewData(wb, [
      { name: 'three  person', remark: 'RS 12×800 FROM SEPTEMBER' },
      { name: 'NINE PERSON', code: 9, remark: '2X1250' },
    ]);
  });
  const byCode = Object.fromEntries(parsed.openingLoans.map((l) => [l.code, l]));
  assert.deepEqual(Object.keys(byCode), ['1', '2', '3', '4', '5', '8', '9']);   // 6, 7 and 10 owe nothing
  assert.deepEqual(byCode['1'], { code: '1', outstanding: '10000.00', instalment: '2000.00', review: [] });

  assert.equal(byCode['2'].instalment, '1500.00');
  assert.equal(byCode['2'].review.length, 1);
  assert.match(byCode['2'].review[0], /3 x 1500 monthly/);
  assert.match(byCode['2'].review[0], /GENERAL DATA/);

  assert.equal(byCode['3'].instalment, '800.00');
  assert.equal(byCode['3'].review.length, 1);
  assert.match(byCode['3'].review[0], /12×800/);
  assert.match(byCode['3'].review[0], /New data/);

  for (const code of ['4', '5']) {                                                   // 4: nobody's row is theirs; 5: no count x amount
    assert.equal(byCode[code].instalment, null, code);
    assert.deepEqual(byCode[code].review, ['no instalment found'], code);
  }

  assert.equal(byCode['8'].instalment, '3000.00');                                    // the row's code differs, its name is the same
  assert.match(byCode['8'].review[0], /2X3000/);

  assert.equal(byCode['9'].instalment, '500.00');
  assert.match(byCode['9'].review[0], /GENERAL DATA/);
});

test('opening loans: a remark amount may carry grouping commas, and plain digits are taken whole; the note quotes the remark', async () => {
  // [remark, the instalment it means]
  const remarks = [
    ['4X5,000 FROM NEXT MONTH', '5000.00'],
    ['3x5000', '5000.00'],                                                            // four plain digits, not 500
    ['3 x 1500 monthly', '1500.00'],                                                  // not 150
    ['12×800', '800.00'],
    ['2X1,50,000 (INDIAN GROUPING)', '150000.00'],
    ['10x2,000,000', '2000000.00'],
    ['RS 6 X 25,000 PER MONTH', '25000.00'],
  ];
  const parsed = await parseStaff(
    remarks.map((_, i) => staff({ PERSON: `PERSON ${i + 1}`, 'CODE NO.': i + 1, OS: 3000000, INST: 0 })),
    undefined,
    (wb) => addGeneral(wb, remarks.map(([remark], i) => ({ name: `PERSON ${i + 1}`, code: i + 1, remark }))),
  );
  assert.equal(parsed.openingLoans.length, remarks.length);
  remarks.forEach(([remark, want], i) => {
    const loan = parsed.openingLoans[i];
    assert.equal(loan.instalment, want, remark);
    assert.equal(loan.review.length, 1, remark);
    assert.ok(loan.review[0].includes(`"${remark}"`), `${remark}: the note quotes it, got ${loan.review[0]}`);
  });
});

// ── Ruling 6: opening advances ────────────────────────────────────────

test('opening advances: a negative FINAL PAYMENT becomes an advance of the same size', async () => {
  const parsed = await parseStaff([
    staff({ PERSON: 'ONE PERSON', 'CODE NO.': 1, 'FINAL PAYMENT': -2300 }),
    staff({ PERSON: 'TWO PERSON', 'CODE NO.': 2, 'FINAL PAYMENT': 0 }),
    staff({ PERSON: 'THREE PERSON', 'CODE NO.': 3, 'FINAL PAYMENT': 500 }),
    staff({ PERSON: 'FOUR PERSON', 'CODE NO.': 4, 'FINAL PAYMENT': (r) => calc(`${ref('TOTAL SAL', r)}-30000`, -1234.5) }),
    staff({ PERSON: 'FIVE PERSON', 'CODE NO.': 5, 'FINAL PAYMENT': -0.004 }),               // shows as 0.00: no advance
    staff({ PERSON: 'SIX PERSON', 'CODE NO.': 6, 'FINAL PAYMENT': -0.005 }),                // rounds away from zero to 0.01
    staff({ PERSON: 'SEVEN PERSON', 'CODE NO.': 7, 'FINAL PAYMENT': undefined }),
  ]);
  assert.deepEqual(parsed.openingAdvances, [
    { code: '1', amount: '2300.00' },
    { code: '4', amount: '1234.50' },
    { code: '6', amount: '0.01' },
  ]);
});

// ── Ruling 7: BANK DETAILS, matched by name ───────────────────────────

test('bank: account kept as text (leading zeros, inner spaces), holder from BANK NAME, TYPE and ESI flags, second code', async () => {
  const parsed = await parseStaff([
    staff({ PERSON: 'ONE PERSON', 'CODE NO.': 1 }),
    staff({ PERSON: 'TWO PERSON', 'CODE NO.': 2 }),
    staff({ PERSON: 'THREE PERSON', 'CODE NO.': 3 }),
    staff({ PERSON: 'FOUR PERSON', 'CODE NO.': 4 }),
  ], undefined, (wb) => {
    put(wb.addWorksheet('BANK DETAILS'), [
      ['SALARY BANK LIST'],                                                            // a title above the header
      BANK_HEAD,
      bankRow({ name: 'one person', holder: ' ONE HOLDER ', account: '  000000123456  ', ifsc: ' TEST0000001', code: '0101', type: 'CONTRACTOR ', esi: 'YES' }),
      bankRow({ name: 'TWO PERSON', holder: 'TWO HOLDER', account: 123456789012345, ifsc: 'TEST0000002', type: 'Employee', esi: 'No' }),
      bankRow({ name: 'THREE' + NBSP + 'PERSON', holder: 'THREE HOLDER', account: '1234 5678 9012', ifsc: 'TEST0000003', code: 'x7' }),
    ]);
  });
  const [one, two, three, four] = parsed.people;
  assert.deepEqual(one.bank, { holder: 'ONE HOLDER', account: '000000123456', ifsc: 'TEST0000001' });
  assert.equal(one.name, 'ONE HOLDER');
  assert.equal(one.display_name, 'ONE PERSON');
  assert.equal(one.worker_type, 'contractor');
  assert.equal(one.esi_applicable, true);
  assert.equal(one.legacy.bank_code, '101');
  assert.deepEqual(two.bank, { holder: 'TWO HOLDER', account: '123456789012345', ifsc: 'TEST0000002' });
  assert.equal(two.worker_type, 'employee');
  assert.equal(two.esi_applicable, false);
  assert.equal(two.legacy.bank_code, null);
  assert.equal(three.bank.account, '1234 5678 9012');                                  // exactly as typed
  assert.equal(three.legacy.bank_code, 'X7');
  assert.equal(three.esi_applicable, false);
  assert.equal(four.bank, null);                                                       // not on the sheet
  assert.equal(four.name, 'FOUR PERSON');                                              // so the PERSON text is the name
  assert.equal(four.worker_type, 'employee');
  assert.deepEqual(parsed.issues, []);
});

test('bank: a row that matches nobody, two people with one name, or two rows for one person are listed, and none of them is used', async () => {
  const parsed = await parseStaff([
    staff({ PERSON: 'ONE PERSON', 'CODE NO.': 1 }),
    staff({ PERSON: 'SHARED NAME', 'CODE NO.': 2 }),
    staff({ PERSON: 'Shared  Name', 'CODE NO.': 3 }),
    staff({ PERSON: 'FOUR PERSON', 'CODE NO.': 4 }),
    staff({ PERSON: 'FIVE PERSON', 'CODE NO.': 5 }),
  ], undefined, (wb) => {
    const row = (name, holder, account, ifsc) => ({ name, holder, account, ifsc, allocation: 'BANK Z', type: 'Employee', esi: 'Yes' });
    addBank(wb, [
      row('ONE PERSON', 'ONE HOLDER', '1111', 'TEST0000001'),                           // fine
      row('NOBODY HERE', 'NOBODY HOLDER', '2222', 'TEST0000002'),                       // row 3: matches nobody
      row('SHARED NAME', 'SHARED HOLDER', '3333', 'TEST0000003'),                       // row 4: two people have this name
      row('FOUR PERSON', 'FOUR HOLDER A', '4444', 'TEST0000004'),                       // rows 5 and 6: one person, two rows
      row('Four Person', 'FOUR HOLDER B', '5555', 'TEST0000005'),
      row(undefined, 'HOLDER WITH NO NAME', '6666', 'TEST0000006'),                     // row 7: no NAME at all
    ]);
  });
  const [one, shared1, shared2, four, five] = parsed.people;
  assert.equal(one.bank.account, '1111');
  assert.equal(shared1.bank, null);
  assert.equal(shared2.bank, null);
  assert.equal(four.bank, null);
  assert.equal(four.esi_applicable, false);
  assert.equal(five.bank, null);
  assert.deepEqual(parsed.people.map((p) => p.pay_channel_label), ['BANK Z', null, null, null, null]);   // an unused row names no channel
  assert.deepEqual(parsed.issues.map((i) => i.level), ['warn', 'warn', 'warn', 'warn']);
  assert.match(parsed.issues[0].message, /row 3.*NOBODY HERE/);
  assert.match(parsed.issues[1].message, /row 4.*SHARED NAME/);
  assert.match(parsed.issues[2].message, /row 7/);
  assert.match(parsed.issues[3].message, /rows 5 and 6.*FOUR PERSON/);
});

test('bank: the sheet is found by its NAME / IFSC / A/C NUMBER header, and its absence is one warning', async () => {
  const people = [staff({ PERSON: 'ONE PERSON', 'CODE NO.': 1 })];
  const renamed = await parseSalaryWorkbook(await bookOf((wb) => {
    addBank(wb, [{ name: 'ONE PERSON', holder: 'ONE HOLDER', account: '1111', ifsc: 'TEST0000001', code: '1', type: 'Employee', esi: 'Yes' }], 'Accounts');
    finalSheet(wb.addWorksheet('FINAL SHEET'), people);
  }));
  assert.equal(renamed.people[0].bank.account, '1111');
  assert.deepEqual(renamed.issues, []);

  const missing = await parseStaff(people);
  assert.equal(missing.people[0].bank, null);
  assert.deepEqual(mentioning(missing, /BANK DETAILS/).map((i) => i.level), ['warn']);
});

// ── Ruling 8: codes go through normCode; duplicates are an error ──────

test('codes: normCode (leading zeros, trailing .0, case, spaces) in people, setups, inputs and expected alike', async () => {
  const parsed = await parseStaff([
    staff({ PERSON: 'ONE PERSON', 'CODE NO.': '030' }),
    staff({ PERSON: 'TWO PERSON', 'CODE NO.': 'ci13' }),
    staff({ PERSON: 'THREE PERSON', 'CODE NO.': 31 }),
    staff({ PERSON: 'FOUR PERSON', 'CODE NO.': ' 7.0 ' }),
  ]);
  const want = ['30', 'CI13', '31', '7'];
  assert.deepEqual(codesOf(parsed), want);
  assert.deepEqual(parsed.setups.map((s) => s.code), want);
  assert.deepEqual(parsed.monthInputs.map((m) => m.code), want);
  assert.deepEqual(parsed.expected.map((e) => e.code), want);
});

test('codes: a code used twice (after normCode) is an error that names both rows and both people', async () => {
  const parsed = await parseStaff([
    staff({ PERSON: 'ONE PERSON', 'CODE NO.': '030' }),
    staff({ PERSON: 'OTHER PERSON', 'CODE NO.': 5 }),
    staff({ PERSON: 'TWO PERSON', 'CODE NO.': 30 }),
  ]);
  const errors = parsed.issues.filter((i) => i.level === 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /rows 5 and 7/);
  assert.match(errors[0].message, /ONE PERSON/);
  assert.match(errors[0].message, /TWO PERSON/);
  assert.match(errors[0].message, /\b30\b/);
  assert.equal(parsed.people.length, 3);                                              // all three are still shown for review
});

// ── Ruling 9: strings out ─────────────────────────────────────────────

test('strings out: amounts are 2-dp strings rounded half away from zero, quantities are exact, names are trimmed as typed', async () => {
  const parsed = await parseStaff([
    staff({
      PERSON: '  Test' + NBSP + 'Name  Two ', 'CODE NO.': 1, 'BASE 2026': 30000.005, OT: 12.5, AB: 2.5, 'MISC.': -0.005, 'OT CRT': 7.5,
      ADV: 0.125, ANIK: 1e-7, 'TOTAL SAL': 1234.565,
    }),
    staff({ PERSON: 'QUANTITIES', 'CODE NO.': 2, OT: 0.125, AB: 0.5, 'OT CRT': 0 }),
  ]);
  assert.equal(parsed.people[0].display_name, 'Test Name  Two');                       // NBSP read as a space, ends trimmed, the rest as typed
  assert.equal(parsed.people[0].name, 'Test Name  Two');
  assert.equal(parsed.monthInputs[0].name, 'Test Name  Two');
  assert.equal(parsed.setups[0].base, '30000.01');                                     // .005 up
  assert.equal(parsed.setups[0].ot_hours_per_day, '7.5');
  assert.equal(parsed.monthInputs[0].ot_hours, '12.5');
  assert.equal(parsed.monthInputs[0].absent_days, '2.5');
  assert.equal(parsed.monthInputs[0].misc_earning, '-0.01');                           // away from zero
  assert.equal(parsed.monthInputs[0].advance_given, '0.13');                           // 0.125 up
  assert.equal(parsed.monthInputs[0].paid_separately, '0.00');                         // never "-0.00" / exponent text
  assert.equal(parsed.expected[0].gross, '1234.57');
  assert.equal(parsed.monthInputs[1].ot_hours, '0.125');
  assert.equal(parsed.monthInputs[1].absent_days, '0.5');
  assert.equal(parsed.setups[1].ot_hours_per_day, '0');
});

test('expected: gross_exact and final_exact are the cached cells as exact decimals, never rounded', async () => {
  // ONE PERSON's cached figure is 877500/31 as a double (17 significant digits): the staff base of 30000 over 31 days,
  // 28 days present and 10 OT hours at 8 a day, 30000 × 28 ÷ 31 + 10 ÷ 8 × 30000 ÷ 31 = 28306.4516129032258…
  const parsed = await parseStaff([
    staff({
      PERSON: 'ONE PERSON', 'CODE NO.': 1,
      'TOTAL SAL': (r) => calc(`${ref('BASIC', r)}*1`, 28306.451612903227),
      'FINAL PAYMENT': (r) => calc(`${ref('TOTAL SAL', r)}-0`, 28306.451612903227),
    }),
    staff({ PERSON: 'TWO PERSON', 'CODE NO.': 2, 'TOTAL SAL': 100, 'FINAL PAYMENT': -0.005 }),
    staff({ PERSON: 'THREE PERSON', 'CODE NO.': 3, 'TOTAL SAL': undefined, 'FINAL PAYMENT': undefined }),
    staff({ PERSON: 'FOUR PERSON', 'CODE NO.': 4, 'TOTAL SAL': 1234.565, 'FINAL PAYMENT': 1e-7 }),
  ]);
  assert.deepEqual(parsed.expected, [
    { code: '1', gross: '28306.45', final: '28306.45', gross_exact: '28306.451612903227', final_exact: '28306.451612903227' },
    { code: '2', gross: '100.00', final: '-0.01', gross_exact: '100', final_exact: '-0.005' },       // the 2-dp one rounds away from zero; the exact one does not round
    { code: '3', gross: '0.00', final: '0.00', gross_exact: '0', final_exact: '0' },                  // blank is 0
    { code: '4', gross: '1234.57', final: '0.00', gross_exact: '1234.565', final_exact: '0.0000001' },
  ]);
});

// ── Cells that are not what they should be ────────────────────────────

test('a figure that is not a number is an error naming the cell, and reads as 0', async () => {
  const parsed = await parseStaff([staff({ PERSON: 'ONE PERSON', 'CODE NO.': 1, OT: 'abc', 'MISC.': '1,5' })]);
  const errors = parsed.issues.filter((i) => i.level === 'error');
  assert.equal(errors.length, 2);
  assert.match(errors[0].message, /row 5.*ONE PERSON.*OT.*abc/);
  assert.match(errors[1].message, /row 5.*ONE PERSON.*MISC.*1,5/);
  assert.equal(parsed.monthInputs[0].ot_hours, '0');
  assert.equal(parsed.monthInputs[0].misc_earning, '0.00');
});

test('rows: titles, totals and blank rows are skipped; a row with figures but no code (or no name) is a warning', async () => {
  const parsed = await parseStaff([
    { PERSON: 'SECTION: PRINTING' },                                                   // row 5: a title, no figures
    staff({ PERSON: 'ONE PERSON', 'CODE NO.': 1 }),                                    // row 6
    {},                                                                                // row 7: blank
    { PERSON: 'NO CODE PERSON', 'TOTAL SAL': 1000 },                                   // row 8: a name and a figure, no code
    { 'CODE NO.': 77, 'TOTAL SAL': 1000 },                                             // row 9: a code and a figure, no name
    { PERSON: 'Grand Total', 'TOTAL SAL': 5000 },                                      // row 10: totals
    { 'TOTAL SAL': 9999 },                                                             // row 11: sums with no label
  ]);
  assert.deepEqual(codesOf(parsed), ['1']);
  const rowIssues = mentioning(parsed, /^FINAL SHEET row/);
  assert.deepEqual(rowIssues.map((i) => i.level), ['warn', 'warn']);
  assert.match(rowIssues[0].message, /row 8.*NO CODE PERSON/);
  assert.match(rowIssues[1].message, /row 9/);
});

test('rows: a FINAL SHEET with no people at all is an error', async () => {
  const parsed = await parseStaff([]);
  assert.deepEqual(parsed.people, []);
  assert.deepEqual(mentioning(parsed, /FINAL SHEET/).map((i) => i.level), ['error']);
});

// ── Firm, department and pay channel ──────────────────────────────────

test('firm and department: FINAL SHEET\'s FIRM and DEPARTMENT win; a blank is filled from the first input sheet row for the person', async () => {
  const parsed = await parseStaff([
    staff({ PERSON: 'ONE PERSON', 'CODE NO.': 1, FIRM: 'OWN FIRM', DEPARTMENT: 'OWN DEPT' }),     // theirs: the input sheets differ
    staff({ PERSON: 'TWO PERSON', 'CODE NO.': 2 }),                                                // blank here, GENERAL DATA / New data say
    staff({ PERSON: 'THREE PERSON', 'CODE NO.': 3 }),                                              // blank, and on no input sheet
  ], undefined, (wb) => {
    addGeneral(wb, [
      { name: 'ONE PERSON', code: 1, firm: 'OTHER FIRM', dept: 'OTHER DEPT' },
      { name: 'TWO PERSON', code: 2, dept: 'CUTTING' },                                            // no firm here: New data has it
    ]);
    addNewData(wb, [
      { name: 'TWO PERSON', code: 2, firm: 'BRAVO TRADERS', dept: 'PASTING' },                     // its department header is blank: not read
    ]);
  });
  assert.deepEqual(parsed.people.map((p) => [p.firm, p.department]), [
    ['OWN FIRM', 'OWN DEPT'], ['BRAVO TRADERS', 'CUTTING'], [null, null],
  ]);
});

test('pay channel: TRANS MODE with its spaces tidied, else the person\'s BANK DETAILS Bank Allocation, else null', async () => {
  const parsed = await parseStaff([
    staff({ PERSON: 'ONE PERSON', 'CODE NO.': 1, 'TRANS MODE': ' BANK' + NBSP + ' A ' }),       // tidied
    staff({ PERSON: 'TWO PERSON', 'CODE NO.': 2 }),                                              // blank, and no bank row: null
    staff({ PERSON: 'THREE PERSON', 'CODE NO.': 3 }),                                            // blank: the bank row's allocation, tidied
    staff({ PERSON: 'FOUR PERSON', 'CODE NO.': 4, 'TRANS MODE': 'CASH' }),                       // TRANS MODE wins over the bank row's
  ], undefined, (wb) => addBank(wb, [
    { name: 'THREE PERSON', holder: 'THREE HOLDER', account: '3333', ifsc: 'TEST0000003', allocation: ' BANK ' + NBSP + 'C ' },
    { name: 'FOUR PERSON', holder: 'FOUR HOLDER', account: '4444', ifsc: 'TEST0000004', allocation: 'BANK D' },
  ]));
  assert.deepEqual(parsed.people.map((p) => p.pay_channel_label), ['BANK A', null, 'BANK C', 'CASH']);
});

test('setup review: a salaried person with no base amount is flagged; a contractor needs no base, only the contractor note', async () => {
  const parsed = await parseStaff([
    staff({ PERSON: 'ONE PERSON', 'CODE NO.': 1, 'BASE 2026': undefined }),
    staff({ PERSON: 'TWO PERSON', 'CODE NO.': 2, 'BASE 2026': undefined, BASIC: 45000 }),
  ]);
  assert.deepEqual(parsed.setups.map((s) => s.review), [['no base amount found'], [CONTRACTOR_NOTE]]);
});

// ── Limits ────────────────────────────────────────────────────────────

test('limits: past 200 issues the rest are only counted, at the highest level among them; the people still load', async () => {
  const people = Array.from({ length: 250 }, (_, i) => staff({ PERSON: `PERSON ${i}`, 'CODE NO.': i + 1, OT: 'abc' }));
  const parsed = await parseStaff(people);
  assert.equal(parsed.people.length, 250);
  assert.equal(parsed.issues.length, 201);                                            // 200 kept, then one saying how many were not
  const last = parsed.issues[200];
  assert.equal(last.level, 'error');
  // 250 errors (one per OT cell, raised first) and one warning (no BANK DETAILS sheet, raised last) make 251; the first
  // 200 are kept, all errors, so what is left to count is 50 errors and the warning.
  assert.equal(last.message, '51 more issues not shown (50 errors and 1 warning).');
});

test('limits: a code shared by many rows names a few of them and counts the rest', async () => {
  const people = Array.from({ length: 12 }, (_, i) => staff({ PERSON: `PERSON ${i}`, 'CODE NO.': 7 }));
  const parsed = await parseStaff(people);
  const errors = parsed.issues.filter((i) => i.level === 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /rows 5, 6, 7, 8, 9, 10 and 6 more all have the code 7/);
});

test('a buffer that is not a workbook rejects with the reader\'s own error (the upload route turns it into a plain message)', async () => {
  await assert.rejects(parseSalaryWorkbook(Buffer.from('this is not a workbook')));
});
