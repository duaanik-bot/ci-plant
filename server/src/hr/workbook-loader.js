// Reads the owner's monthly salary workbook (the "July layout", spec sections 2 and 15) into people, pay setups,
// opening loan and advance balances, the month's inputs and the workbook's own results. It seeds the HR module at
// go-live and is what the acceptance test checks the engine against. Server side only. Apart from reading the buffer it
// is handed there is no I/O: no database, no files, no logging.
//
// The workbook has one sheet per purpose. FINAL SHEET and BANK DETAILS are found by what their header row holds, not by
// what they are called; GENERAL DATA and New data (the month's inputs) are found by name, ignoring case and stray
// spaces.
//   FINAL SHEET   header row with PERSON, CODE NO. and OT CRT. One row per person; the pay is worked out in its
//                 formulas, so most of what is read is the cached result of a formula.
//   BANK DETAILS  header row with NAME, IFSC and A/C NUMBER. Joined to FINAL SHEET by name.
//   GENERAL DATA, New data   only the REMARKS (an instalment is sometimes written there) and, when FINAL SHEET does not
//                 say, the firm and department.
//
// Nothing here guesses. What cannot be read safely is an issue or a review note, never a silent default:
//   - issues are {level, message}. 'error' means the load cannot be trusted as it is (the caller must not apply it while
//     any error stands): the month or a money column cannot be found, a code is used twice, a figure is not a number.
//     'warn' means look at it: DAYS disagrees with the calendar, a bank row is not used. Nothing here is 'info'.
//   - review notes sit on the pay setup or opening loan they are about, for the person doing the preview.
//
// Rules (the controller's rulings, binding):
//   - Columns are found by normalised header text on FINAL SHEET's header row: case, NBSP, runs of spaces and a trailing
//     '.' do not matter. BASE is the 'BASE <year>' column with the highest year. A header that appears twice is its
//     leftmost column.
//   - month and daysInMonth come from the cells right of the MONTH and DAYS labels above the header ('July', 2026; 31). A
//     DAYS that disagrees with the calendar is a warning and the workbook's own DAYS is what daysInMonth carries, because
//     the workbook's figures were worked out with it.
//   - Holiday: the HOLIDAY formula, spaces and $ removed, must read <this row's BASE cell>/<divisor>[*<multiplier>] to
//     be a formula rule. Any other formula keeps its cached value as a fixed amount, for review. A typed amount above
//     0 is a fixed amount, for review. 0 or blank is none.
//   - A BASIC that is typed (not a formula) and not blank is a contractor's bill: pay_basis 'contract', and the value is
//     the month's bill_amount. Every such detection puts the review note 'typed BASIC read as a contractor bill — check'
//     on the setup.
//   - Opening loans: OS above 0. The instalment is INST when above 0, else the second number of 'count x amount' in the
//     person's remark (GENERAL DATA first, then New data; a row is the person's when it has the same code or the same
//     normalised name), with a review note naming the remark. The amount may carry grouping commas (4X5,000 is 5000).
//     None found: null, with the note 'no instalment found'.
//   - Opening advances: a negative FINAL PAYMENT, sign dropped.
//   - Bank details: rows join to FINAL SHEET people by normName(NAME) === normName(PERSON). A row that matches nobody, or
//     that names two people, or a person who has two rows, is a warning and none of those rows is used. The account number
//     is kept as the text in the cell, never through a number: leading zeros matter.
//   - Codes go through normCode; a code used twice is an error naming both rows.
//   - Firm and department are FINAL SHEET's FIRM and DEPARTMENT columns (a blank is filled from the person's first
//     non-blank row on GENERAL DATA, then New data). The pay channel is TRANS MODE, else the person's BANK DETAILS
//     'Bank Allocation'. C STAT and HP go to `legacy`.
//   - Amounts come out as 2-dp strings (rounded half away from zero), quantities as exact decimal strings, names trimmed
//     as typed. A blank figure is 0, as it is to the workbook's own formulas. `expected` also carries gross_exact and
//     final_exact: the cached TOTAL SAL and FINAL PAYMENT as exact decimals, never rounded, for the acceptance test.
//
// Limits, so one odd file cannot hurt the server: a list of rows in a message is cut after six, and after 200 issues the
// rest are only counted (one closing issue says how many, at the highest level among them). Every pass over the sheets
// is linear: rows are grouped and indexed once, never searched per person.
//
// A row of FINAL SHEET is a person when it has both a name and a code. A row with neither (blank, a title, a sums row)
// is skipped, and so is a 'TOTAL' row; a row with only one of them is skipped with a warning if it carries any figure.
//
// readWorkbook turns every cell into text (a formula cell into its cached result) and, asked for formulas, says which
// cells are formulas: that is the only way to tell a typed BASIC or HOLIDAY from a calculated one.

import { readWorkbook, detectHeader, autoMap } from './import-parse.js';
import { normName, normCode } from './match.js';
import { rat, neg, isZero, toPaise, fmtPaise, fmtDecimal } from './money.js';

const ZERO = rat(0);

// How far down a sheet its header row may be.
const SCAN_ROWS = 30;
const FINAL_HEADERS = ['PERSON', 'CODE NO', 'OT CRT'];
const BANK_HEADERS = ['NAME', 'IFSC', 'A/C NUMBER'];

const MONTH_NAMES = [
  'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER',
];

const PLAIN_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
// count x amount: 4X5000, 3 x 1500, 12×800, and an amount with grouping commas (4X5,000, 2X1,50,000). The first
// alternative needs a comma group (`+`): with `*` it would stop after three digits and read 3x5000 as 500.
const REMARK_INSTALMENT = /(\d+)\s*[xX×]\s*(\d{1,3}(?:,\d{2,3})+|\d+)/;
const TOTALS_LABEL = /^(?:GRAND )?TOTALS?$/;

const MAX_ISSUES = 200;

const HOLIDAY_TYPED = 'typed holiday amount — monthly or one-off?';
const HOLIDAY_UNRECOGNISED = 'unrecognised holiday formula';
const CONTRACTOR_NOTE = 'typed BASIC read as a contractor bill — check';

// ── Small helpers ─────────────────────────────────────────────────────

// The trimmed text of a cell; '' for a column the sheet does not have.
const text = (row, col) => (col === undefined ? '' : String(row[col] ?? '').trim());
const orNull = (s) => (s === '' ? null : s);
const squash = (s) => s.replace(/\s+/g, ' ');
const clip = (s, max = 60) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const money = (r) => fmtPaise(toPaise(r));
// More than nothing once shown in paise: the float noise a formula leaves where it means 0 (1e-12) is not a balance.
const positive = (r) => toPaise(r) > 0n;
// 'a', 'a and b', 'a, b and c'; after six, 'a, b, c, d, e, f and 9 more'.
function andList(items, max = 6) {
  const shown = items.slice(0, max).map(String);
  if (items.length > max) return `${shown.join(', ')} and ${items.length - max} more`;
  return shown.length < 2 ? shown.join('') : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}
// Adds value to the list kept under key; a blank key is never indexed.
function group(map, key, value) {
  if (key === null || key === '') return;
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
// A dash typed where a code would go means "no code" (as in import-parse).
const codeOf = (s) => (s === '-' || s === '—' ? null : normCode(s));
const lengthOf = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();    // month is 1 to 12

// 0 = A, 25 = Z, 26 = AA
function letters(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

// ── Headers and sheets ────────────────────────────────────────────────

// A header's comparison key: normName (NBSP, runs of spaces, case), then trailing dots, colons and spaces dropped, so
// 'Misc. ' and 'MISC' are one column and 'CODE NO.' is 'CODE NO'.
const hkey = (cell) => normName(cell).replace(/[.:\s]+$/, '');

// A row's header keys as key to column. A key that appears twice keeps its leftmost column.
function keysOf(row) {
  const keys = new Map();
  (row ?? []).forEach((cell, col) => {
    const key = hkey(cell);
    if (key !== '' && !keys.has(key)) keys.set(key, col);
  });
  return keys;
}

// {row, keys} for the first of the first SCAN_ROWS rows whose headers include every key in `required`, or null.
function findHeader(grid, required) {
  const last = Math.min(SCAN_ROWS, grid.length);
  for (let row = 0; row < last; row++) {
    const keys = keysOf(grid[row]);
    if (required.every((key) => keys.has(key))) return { row, keys };
  }
  return null;
}

// The sheet whose header row has every key in `required`, as {sheet, header}; the one called `preferred` if several do.
function locate(sheets, required, preferred, skip) {
  const hits = [];
  for (const sheet of sheets) {
    if (sheet === skip) continue;
    const header = findHeader(sheet.grid, required);
    if (header) hits.push({ sheet, header });
  }
  return hits.find((hit) => normName(hit.sheet.name) === preferred) ?? hits[0] ?? null;
}

// ── The month ─────────────────────────────────────────────────────────

// The non-blank cells to the right of a label in the rows above the header, up to the next label. {found, values}.
function rightOf(grid, headerRow, label) {
  for (let r = 0; r < headerRow; r++) {
    const row = grid[r] ?? [];
    for (let c = 0; c < row.length; c++) {
      if (hkey(row[c]) !== label) continue;
      const values = [];
      for (let k = c + 1; k < row.length; k++) {
        const key = hkey(row[k]);
        if (key === 'MONTH' || key === 'DAYS') break;
        const cell = String(row[k] ?? '').trim();
        if (cell !== '') values.push(cell);
      }
      return { found: true, values };
    }
  }
  return { found: false, values: [] };
}

// {year, month} from the cells right of MONTH: a month name (or its first three or more letters), a number 1 to 12, or
// a date; then the year. Null when it cannot be read.
function whenOf(values) {
  const [first, second] = values;
  if (first === undefined) return null;
  const date = /^(20\d{2})-(\d{2})-\d{2}$/.exec(first);
  if (date) {
    const month = Number(date[2]);
    return month >= 1 && month <= 12 ? { year: Number(date[1]), month } : null;
  }
  const named = normName(first).replace(/\.$/, '');
  const month = /^\d{1,2}$/.test(named)
    ? Number(named)
    : MONTH_NAMES.findIndex((name) => named.length >= 3 && name.startsWith(named)) + 1;
  if (month < 1 || month > 12 || second === undefined || !/^20\d{2}$/.test(second)) return null;
  return { year: Number(second), month };
}

function readPeriod(grid, headerRow, say) {
  const monthCell = rightOf(grid, headerRow, 'MONTH');
  const daysCell = rightOf(grid, headerRow, 'DAYS');

  let when = null;
  if (!monthCell.found) {
    say.error('MONTH not found: no cell above the header row says MONTH, so the month is unknown.');
  } else {
    when = whenOf(monthCell.values);
    if (!when) {
      const held = clip(monthCell.values.join(' '));
      say.error(`The month could not be read: the cells right of MONTH hold "${held}", not a month and a year.`);
    }
  }
  const month = when ? `${when.year}-${String(when.month).padStart(2, '0')}` : null;
  const calendar = when ? lengthOf(when.year, when.month) : null;

  let days = null;
  if (!daysCell.found) {
    if (calendar !== null) say.warn(`DAYS not found above the header row, so the calendar's ${calendar} days for ${month} are used.`);
  } else {
    const cell = daysCell.values[0] ?? '';
    if (/^\d+(?:\.0+)?$/.test(cell) && Number(cell) >= 1 && Number(cell) <= 31) days = Number(cell);
    else say.error(`The days in the month could not be read: the cell right of DAYS holds "${clip(cell)}".`);
  }
  if (days !== null && calendar !== null && days !== calendar) {
    say.warn(`DAYS says ${days} but ${month} has ${calendar} days. ${days} is used, `
      + "because the workbook's own figures were worked out with it.");
  }
  return { month, days: days ?? calendar };
}

// ── FINAL SHEET ───────────────────────────────────────────────────────

// Every FINAL SHEET column the loader reads, by header key. `level` is how serious it is when the column is missing
// (none: it is optional), and `lost` says what then goes unread.
const FINAL_COLUMNS = [
  { prop: 'person', keys: ['PERSON'] },
  { prop: 'code', keys: ['CODE NO'] },
  { prop: 'otCrt', keys: ['OT CRT'] },
  { prop: 'ot', label: 'OT', keys: ['OT'], level: 'error', lost: 'overtime hours load as 0' },
  { prop: 'ab', label: 'AB', keys: ['AB'], level: 'error', lost: 'absent days load as 0' },
  { prop: 'misc', label: 'MISC.', keys: ['MISC'], level: 'error', lost: 'misc earnings load as 0' },
  { prop: 'basic', label: 'BASIC', keys: ['BASIC'], level: 'error', lost: 'contractors cannot be told from salaried people' },
  { prop: 'holiday', label: 'HOLIDAY', keys: ['HOLIDAY'], level: 'error', lost: 'no holiday rule is loaded' },
  { prop: 'total', label: 'TOTAL SAL', keys: ['TOTAL SAL'], level: 'error', lost: 'the expected gross is 0' },
  { prop: 'adv', label: 'ADV', keys: ['ADV'], level: 'error', lost: 'advances given load as 0' },
  { prop: 'inst', label: 'INST', keys: ['INST'], level: 'error', lost: 'loan instalments load as 0' },
  { prop: 'os', label: 'OS', keys: ['OS'], level: 'error', lost: 'no opening loans are loaded' },
  { prop: 'anik', label: 'ANIK', keys: ['ANIK'], level: 'error', lost: 'amounts paid separately load as 0' },
  {
    prop: 'final', label: 'FINAL PAYMENT', keys: ['FINAL PAYMENT'], level: 'error',
    lost: 'the expected final payment is 0 and no opening advances are loaded',
  },
  { prop: 'transMode', label: 'TRANS MODE', keys: ['TRANS MODE'], level: 'warn', lost: 'pay channels are not loaded' },
  { prop: 'cStat', label: 'C STAT', keys: ['C STAT'], level: 'warn', lost: 'the legacy C STAT is not loaded' },
  { prop: 'hp', label: 'HP', keys: ['HP'], level: 'warn', lost: 'the legacy HP is not loaded' },
  { prop: 'firm', keys: ['FIRM'] },                                    // GENERAL DATA / New data can say, if this does not
  { prop: 'dept', keys: ['DEPARTMENT'] },
];

// property to column index, and the BASE column ({col, label}: the highest 'BASE <year>'), or null.
function finalColumns(keys, say) {
  const cols = {};
  for (const spec of FINAL_COLUMNS) {
    const key = spec.keys.find((k) => keys.has(k));
    cols[spec.prop] = key === undefined ? undefined : keys.get(key);
    if (cols[spec.prop] === undefined && spec.level) say[spec.level](`FINAL SHEET has no ${spec.label} column, so ${spec.lost}.`);
  }
  let base = null;
  for (const [key, col] of keys) {
    const m = /^BASE\s*(\d{4})$/.exec(key);
    if (m && (base === null || Number(m[1]) > base.year)) base = { year: Number(m[1]), col, label: key };
  }
  if (base === null) say.error('FINAL SHEET has no "BASE <year>" column (for example BASE 2026), so base pay loads as 0.');
  return { cols, base };
}

// The pay setup's holiday rule. `formula` is the HOLIDAY cell's formula ('' when typed) and `value` its value.
function holidayRule(formula, value, baseRef) {
  const rule = (mode, divisor, multiplier, fixed, review) => ({ mode, divisor, multiplier, fixed, review });
  if (formula !== '') {
    const pattern = baseRef === null ? null : new RegExp(`^${baseRef}/(\\d+(?:\\.\\d+)?)(?:\\*(\\d+(?:\\.\\d+)?))?$`, 'i');
    const m = pattern?.exec(formula.replace(/[\s$]+/g, ''));
    if (m && !isZero(rat(m[1]))) {
      return rule('formula', fmtDecimal(rat(m[1])), m[2] === undefined ? '1' : fmtDecimal(rat(m[2])), null, []);
    }
    return rule('fixed', null, null, money(value), [HOLIDAY_UNRECOGNISED]);
  }
  if (positive(value)) return rule('fixed', null, null, money(value), [HOLIDAY_TYPED]);
  return rule('none', null, null, null, []);
}

// One entry per person row of FINAL SHEET, in sheet order, with every figure as a Rat.
function readPeople(sheet, headerRow, cols, base, say) {
  const { grid, formulas } = sheet;
  const figureCols = [
    base?.col, cols.ot, cols.ab, cols.misc, cols.basic, cols.holiday, cols.total, cols.adv, cols.inst, cols.os, cols.anik, cols.final,
  ];
  const entries = [];
  for (let r = headerRow + 1; r < grid.length; r++) {
    const row = grid[r];
    const at = (col) => text(row, col);
    const display = at(cols.person);
    const code = codeOf(at(cols.code));
    if (display === '' && code === null) continue;                           // blank, a title, a sums row
    if (code === null && TOTALS_LABEL.test(normName(display))) continue;
    if (display === '' || code === null) {
      if (figureCols.some((col) => at(col) !== '')) {
        const what = display === '' ? `the code ${code} but no name` : `the name "${clip(display)}" but no code`;
        say.warn(`FINAL SHEET row ${r + 1} has ${what}, so it was not loaded.`);
      }
      continue;
    }

    const where = `FINAL SHEET row ${r + 1} (${clip(display)})`;
    const num = (col, label) => {
      const cell = at(col);
      if (cell === '') return ZERO;
      if (!PLAIN_NUMBER.test(cell)) {
        say.error(`${where}: ${label} holds "${clip(cell)}", which is not a number, so it was read as 0.`);
        return ZERO;
      }
      return rat(cell);
    };
    const formulaAt = (col) => (col === undefined ? '' : (formulas[r]?.[col] ?? ''));

    const baseValue = num(base?.col, base?.label ?? 'BASE');
    const otCrt = num(cols.otCrt, 'OT CRT');
    const ot = num(cols.ot, 'OT');
    const ab = num(cols.ab, 'AB');
    const misc = num(cols.misc, 'MISC.');
    const basic = num(cols.basic, 'BASIC');
    const holidayValue = num(cols.holiday, 'HOLIDAY');
    const adv = num(cols.adv, 'ADV');
    const inst = num(cols.inst, 'INST');
    const os = num(cols.os, 'OS');
    const anik = num(cols.anik, 'ANIK');
    const total = num(cols.total, 'TOTAL SAL');
    const final = num(cols.final, 'FINAL PAYMENT');
    const contract = at(cols.basic) !== '' && formulaAt(cols.basic) === '';   // a typed BASIC is a contractor's bill
    entries.push({
      row: r + 1,
      display,
      nameKey: normName(display),
      code,
      firm: orNull(at(cols.firm)),
      dept: orNull(at(cols.dept)),
      channel: orNull(squash(at(cols.transMode))),
      cStat: orNull(at(cols.cStat)),
      hp: orNull(at(cols.hp)),
      contract,
      base: baseValue,
      otCrt,
      holiday: holidayRule(formulaAt(cols.holiday), holidayValue, base ? `${letters(base.col)}${r + 1}` : null),
      figures: { ot, ab, misc, adv, anik, inst, bill: contract ? basic : null },
      os,
      total,
      final,
    });
  }
  return entries;
}

function flagDuplicateCodes(entries, say) {
  const byCode = new Map();
  for (const entry of entries) group(byCode, entry.code, entry);
  for (const [code, sharing] of byCode) {
    if (sharing.length < 2) continue;
    const rows = andList(sharing.map((e) => e.row));
    const names = andList(sharing.map((e) => `"${clip(e.display, 30)}"`), 3);
    say.error(`FINAL SHEET rows ${rows} all have the code ${code} (${names}). A code belongs to one person.`);
  }
}

// ── BANK DETAILS ──────────────────────────────────────────────────────

const BANK_COLUMNS = [
  { prop: 'name', label: 'NAME', keys: ['NAME'] },
  { prop: 'account', label: 'A/C NUMBER', keys: ['A/C NUMBER'] },
  { prop: 'ifsc', label: 'IFSC', keys: ['IFSC'] },
  { prop: 'holder', label: 'BANK NAME', keys: ['BANK NAME'], lost: 'account holders are not loaded' },
  { prop: 'code', label: 'CODE NO.', keys: ['CODE NO'], lost: 'the second code series is not loaded' },
  { prop: 'type', label: 'TYPE', keys: ['TYPE'], lost: 'contractors cannot be told from salaried people' },
  { prop: 'esi', label: 'ESI PAYABLE', keys: ['ESI PAYABLE'], lost: 'ESI flags are not loaded' },
  { prop: 'allocation', label: 'Bank Allocation', keys: ['BANK ALLOCATION'] },     // only a fallback for TRANS MODE: no warning
];

// A Map of entry to its bank row, for the people whose row is clear: {holder, account, ifsc, code, contractor, esi, allocation}.
function readBankDetails(sheets, finalSheet, entries, say) {
  const banks = new Map();
  const found = locate(sheets, BANK_HEADERS, 'BANK DETAILS', finalSheet);
  if (!found) {
    say.warn('BANK DETAILS sheet not found (it needs NAME, A/C NUMBER and IFSC headers), '
      + 'so bank accounts, ESI flags and contractors were not loaded.');
    return banks;
  }
  const { sheet, header } = found;
  const cols = {};
  for (const spec of BANK_COLUMNS) {
    const key = spec.keys.find((k) => header.keys.has(k));
    cols[spec.prop] = key === undefined ? undefined : header.keys.get(key);
    if (cols[spec.prop] === undefined && spec.lost) say.warn(`BANK DETAILS has no ${spec.label} column, so ${spec.lost}.`);
  }

  const byName = new Map();
  for (const entry of entries) group(byName, entry.nameKey, entry);

  const claims = new Map();                                                 // entry to the bank rows that name it
  for (let r = header.row + 1; r < sheet.grid.length; r++) {
    const row = sheet.grid[r];
    if (row.every((cell) => String(cell).trim() === '')) continue;
    const where = `BANK DETAILS row ${r + 1}`;
    const name = text(row, cols.name);
    if (name === '') {
      say.warn(`${where} has no NAME, so it was not used.`);
      continue;
    }
    const people = byName.get(normName(name)) ?? [];
    if (people.length === 0) {
      say.warn(`${where} (${clip(name)}) matches nobody on FINAL SHEET by name, so it was not used.`);
      continue;
    }
    if (people.length > 1) {
      const rows = andList(people.map((p) => p.row));
      say.warn(`${where} (${clip(name)}) matches more than one person on FINAL SHEET (rows ${rows}), so it was not used.`);
      continue;
    }
    const bank = {
      row: r + 1,
      holder: orNull(text(row, cols.holder)),
      account: orNull(text(row, cols.account)),                             // text, exactly: leading zeros matter
      ifsc: orNull(text(row, cols.ifsc)),
      code: normCode(text(row, cols.code)),
      contractor: normName(text(row, cols.type)) === 'CONTRACTOR',
      esi: normName(text(row, cols.esi)) === 'YES',
      allocation: orNull(squash(text(row, cols.allocation))),
    };
    if (claims.has(people[0])) claims.get(people[0]).push(bank);
    else claims.set(people[0], [bank]);
  }
  for (const [entry, rows] of claims) {
    if (rows.length > 1) {
      say.warn(`BANK DETAILS rows ${andList(rows.map((b) => b.row))} all name ${clip(entry.display)}, so none of them was used.`);
    } else {
      banks.set(entry, rows[0]);
    }
  }
  return banks;
}

// ── GENERAL DATA and New data ─────────────────────────────────────────

// [{label, byCode, byName}] for whichever of the two input sheets there is, in the order they are consulted: each index
// maps a code, or a normalised name, to the rows [{i, remark, firm, dept}] that carry it. The headers are the
// monthly-input format import-parse already reads.
function readInputSheets(sheets) {
  const found = [];
  for (const wanted of ['GENERAL DATA', 'NEW DATA']) {
    const sheet = sheets.find((s) => normName(s.name) === wanted);
    const head = sheet && detectHeader(sheet.grid);
    if (!head) continue;
    const { map } = autoMap(head.headers);
    const byCode = new Map();
    const byName = new Map();
    for (let r = head.headerRow + 1; r < sheet.grid.length; r++) {
      const row = sheet.grid[r];
      const entry = { i: r, remark: text(row, map.remarks), firm: text(row, map.firm), dept: text(row, map.department) };
      group(byCode, codeOf(text(row, map.code)), entry);
      group(byName, normName(text(row, map.name)), entry);
    }
    found.push({ label: sheet.name.trim(), byCode, byName });
  }
  return found;
}

// The rows of an input sheet that are this person's, top to bottom: the same code or the same normalised name (the
// workbook's own join between its sheets is by name).
function rowsOf(sheet, entry) {
  const mine = new Set([...(sheet.byCode.get(entry.code) ?? []), ...(sheet.byName.get(entry.nameKey) ?? [])]);
  return [...mine].sort((a, b) => a.i - b.i);
}

// The first non-blank firm / department among the person's input-sheet rows, or null.
function fromInputs(inputs, entry, prop) {
  for (const sheet of inputs) {
    for (const row of rowsOf(sheet, entry)) if (row[prop] !== '') return row[prop];
  }
  return null;
}

// {amount: Rat, remark, label} from the first remark of the person's that says 'count x amount', or null.
function instalmentFromRemarks(inputs, entry) {
  for (const sheet of inputs) {
    for (const row of rowsOf(sheet, entry)) {
      const m = REMARK_INSTALMENT.exec(row.remark);
      const amount = m && rat(m[2].replace(/,/g, ''));                       // 5,000 is 5000
      if (amount && positive(amount)) return { amount, remark: row.remark, label: sheet.label };
    }
  }
  return null;
}

// ── The loader ────────────────────────────────────────────────────────

// async parseSalaryWorkbook(buffer) to {month, daysInMonth, people, setups, openingLoans, openingAdvances, monthInputs,
// expected, issues}. month is 'YYYY-MM' and daysInMonth a number, both null when the sheet does not say. A buffer that is
// not a workbook rejects with exceljs's own error; everything else about the content comes back in `issues`.
export async function parseSalaryWorkbook(buffer) {
  const { sheets } = await readWorkbook(buffer, { formulas: true });
  const issues = [];
  const dropped = { warn: 0, error: 0 };
  const report = (level) => (message) => {
    if (issues.length < MAX_ISSUES) issues.push({ level, message });
    else dropped[level]++;
  };
  const say = { warn: report('warn'), error: report('error') };
  const parsed = {
    month: null, daysInMonth: null, people: [], setups: [], openingLoans: [], openingAdvances: [],
    monthInputs: [], expected: [], issues,
  };

  const found = locate(sheets, FINAL_HEADERS, 'FINAL SHEET');
  if (!found) {
    say.error('FINAL SHEET not found: no sheet has a header row with PERSON, CODE NO. and OT CRT.');
    return parsed;
  }
  const { sheet, header } = found;

  const period = readPeriod(sheet.grid, header.row, say);
  parsed.month = period.month;
  parsed.daysInMonth = period.days;

  const { cols, base } = finalColumns(header.keys, say);
  const entries = readPeople(sheet, header.row, cols, base, say);
  if (entries.length === 0) say.error('FINAL SHEET has no people: no row below the header has both a name and a code.');
  flagDuplicateCodes(entries, say);

  const banks = readBankDetails(sheets, sheet, entries, say);
  const inputs = readInputSheets(sheets);

  for (const e of entries) {
    const bank = banks.get(e);
    const hasBank = bank !== undefined && [bank.holder, bank.account, bank.ifsc].some((v) => v !== null);
    parsed.people.push({
      code: e.code,
      name: bank?.holder ?? e.display,
      display_name: e.display,
      firm: e.firm ?? fromInputs(inputs, e, 'firm'),
      department: e.dept ?? fromInputs(inputs, e, 'dept'),
      worker_type: bank?.contractor ? 'contractor' : 'employee',
      pay_channel_label: e.channel ?? bank?.allocation ?? null,
      legacy: { c_stat: e.cStat, hp: e.hp, bank_code: bank?.code ?? null },
      bank: hasBank ? { holder: bank.holder, account: bank.account, ifsc: bank.ifsc } : null,
      esi_applicable: bank?.esi ?? false,
    });

    const review = [];
    if (e.contract) review.push(CONTRACTOR_NOTE);
    else if (!positive(e.base)) review.push('no base amount found');
    review.push(...e.holiday.review);
    parsed.setups.push({
      code: e.code,
      pay_basis: e.contract ? 'contract' : 'monthly',
      base: money(e.base),
      ot_hours_per_day: fmtDecimal(e.otCrt),
      holiday_mode: e.holiday.mode,
      holiday_divisor: e.holiday.divisor,
      holiday_multiplier: e.holiday.multiplier,
      holiday_fixed: e.holiday.fixed,
      review,
    });

    if (positive(e.os)) {
      const loanReview = [];
      let instalment = null;
      if (positive(e.figures.inst)) {
        instalment = money(e.figures.inst);
      } else {
        const fromRemark = instalmentFromRemarks(inputs, e);
        if (fromRemark) {
          instalment = money(fromRemark.amount);
          loanReview.push(`instalment ${instalment} read from the remark "${clip(fromRemark.remark, 80)}" in ${fromRemark.label}`);
        } else {
          loanReview.push('no instalment found');
        }
      }
      parsed.openingLoans.push({ code: e.code, outstanding: money(e.os), instalment, review: loanReview });
    }

    const owed = toPaise(neg(e.final));
    if (owed > 0n) parsed.openingAdvances.push({ code: e.code, amount: fmtPaise(owed) });

    parsed.monthInputs.push({
      code: e.code,
      name: e.display,
      ot_hours: fmtDecimal(e.figures.ot),
      absent_days: fmtDecimal(e.figures.ab),
      misc_earning: money(e.figures.misc),
      advance_given: money(e.figures.adv),
      bill_amount: e.figures.bill === null ? null : money(e.figures.bill),
      paid_separately: money(e.figures.anik),
      loan_instalment: money(e.figures.inst),
    });
    parsed.expected.push({
      code: e.code,
      gross: money(e.total),
      final: money(e.final),
      gross_exact: fmtDecimal(e.total),
      final_exact: fmtDecimal(e.final),
    });
  }
  const more = dropped.warn + dropped.error;
  if (more > 0) {
    const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const message = `${count(more, 'more issue')} not shown (${count(dropped.error, 'error')} and ${count(dropped.warn, 'warning')}).`;
    issues.push({ level: dropped.error > 0 ? 'error' : 'warn', message });
  }
  return parsed;
}
