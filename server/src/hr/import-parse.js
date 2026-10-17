// Reads the factory's monthly Excel sheet (spec §9) into typed, validated rows. Server side only (exceljs).
// Apart from reading the buffer it is handed there is no I/O: no database, no files, no logging.
//
// Nothing here guesses:
//   - A header matches a synonym by its exact normalised text only (a trailing '.' on either side is ignored).
//     No prefix, no likeness: 'CODE NO. 2' is not 'CODE NO.'. A header that appears twice (one real sheet has a
//     second header block further right) maps its LEFTMOST column; the later ones are left unmapped.
//   - A cell is a number only if it reads as one. Text with commas must be grouped like 1,00,000 or 1,000,000:
//     '2,5' is an error, never 25. Nothing may sit inside the number either: '2 5' and '1 000' are errors, never
//     25 and 1000. Spaces around the number are fine, and a currency (₹ or Rs) may stand before or after it, with
//     spaces between. A typed exponent ('1e3', '2E5') is not a number either. Unreadable text is NOT_A_NUMBER and
//     its value is null, never 0. A value beyond 9999999999.99 either way is TOO_LARGE (an error), and more decimal
//     places than the column behind the field stores (2 for money, 4 for quantities) is a warning,
//     MORE_DECIMALS_THAN_STORED, with the value kept exact.
//   - A blank is null. It is '0' only in a column the caller ticked "blank counts as 0", and only when that
//     column is in the file at all.
//   - A row with figures but no name and no code is not dropped: it comes back with a NO_NAME_OR_CODE error, so the
//     operator must decide what to do with it. A code cell that is only a dash is no code. A row with nothing but
//     blanks and text is skipped.
//   - Numbers are kept exactly, as fmtDecimal text: no float, nothing truncated.
//
// Limits, so one odd file cannot hurt the server (and so importing this module costs nothing):
//   - Number text longer than 64 characters is NOT_A_NUMBER without being read: rat()'s regex is slow on a long
//     run of digits, and a file can hold thousands of such cells.
//   - readWorkbook rejects a sheet whose padded grid would pass 2,000,000 cells (rows x width) instead of building
//     it. It also rejects a buffer that is not a workbook.
//   - pickSheet returns null when no sheet has a header row.
//   - exceljs is loaded by readWorkbook, when a workbook is read, not when this module is imported: app.js imports
//     every route eagerly, and a top-level import would add exceljs's load time to every cold start of the ERP.
//
// readWorkbook turns every cell into text, so everything after it works on plain strings and a column keeps its
// index from header to last row:
//   number                  String(n), in plain digits     boolean       'TRUE' / 'FALSE'
//   formula, shared formula its cached result, flattened   error         '#ERR'
//   rich text               the runs joined                date          'YYYY-MM-DD' from the UTC parts, so the
//   link                    the text it shows                            server's time zone cannot move it a day
//   merged range            its top-left cell only         empty         ''
// A formula's result is read from cell.result: exceljs's cell.value leaves out a result of 0, FALSE or '', and a
// formula that calculates to 0 is an override of 0, not a blank. A number that String() would print with an
// exponent (below 1e-6, from 1e21) is written out in plain digits, so a real numeric cell is read where typed
// exponent text is refused.
// NBSP becomes a space. Every row of a sheet's grid is padded to the same width; the grid starts at Excel row 1,
// so a grid index is always an Excel row number minus one.
// readWorkbook(buffer, {formulas: true}) also gives each sheet `formulas`: the text of each formula cell's formula
// (no leading '='), '' for every other cell, in exactly the grid's rows and width. A caller that must tell a typed
// number from a formula, or read what a formula does, asks for it.

// exceljs is deliberately not imported here: readWorkbook loads it when a workbook is read (ruling T4-g).
import { rat, mul, cmp, neg, isNeg, isZero, fmtDecimal } from './money.js';
import { normName } from './match.js';

// ── The fields a sheet can carry ──────────────────────────────────────

// Synonyms are written already normalised. `blankZero` is the default for the saved map's "blank counts as 0"
// tick (spec §9.3); extractRows takes the ticks it is given and never falls back to these. `info` fields are
// read for cross-checking only.
export const FIELDS = [
  { key: 'name', kind: 'text', synonyms: ['PERSON', 'NAME', 'EMPLOYEE NAME', 'EMPLOYEE'], blankZero: false },
  { key: 'code', kind: 'code', synonyms: ['CODE NO.', 'CODE NO', 'CODE', 'EMPLOYEE ID', 'EMP CODE', 'EMP ID'], blankZero: false },
  { key: 'ot_hours', kind: 'number', synonyms: ['OT', 'OT HOURS', 'OVERTIME', 'OVERTIME HOURS'], blankZero: true },
  { key: 'absent_days', kind: 'number', synonyms: ['AB', 'ABSENT', 'ABSENT DAYS', 'ABSENCE DAYS'], blankZero: true },
  { key: 'paid_leave_days', kind: 'number', synonyms: ['PAID LEAVE', 'PAID LEAVE DAYS', 'PL'], blankZero: false },
  { key: 'hours_worked', kind: 'number', synonyms: ['HOURS WORKED', 'HOURS'], blankZero: false },
  { key: 'misc_earning', kind: 'number', synonyms: ['MISC.', 'MISC', 'MISCELLANEOUS', 'MISC EARNING'], blankZero: true },
  { key: 'misc_deduction', kind: 'number', synonyms: ['MISC DEDUCTION', 'OTHER DEDUCTION', 'DEDUCTION'], blankZero: false },
  { key: 'bonus', kind: 'number', synonyms: ['BONUS', 'INCENTIVE', 'BONUS/INCENTIVE'], blankZero: false },
  { key: 'advance_given', kind: 'number', synonyms: ['ADVANCE', 'ADV', 'ADVANCE TAKEN'], blankZero: true },
  { key: 'bill_amount', kind: 'number', synonyms: ['BILL AMOUNT', 'BILL'], blankZero: true },
  { key: 'holiday_override', kind: 'number', synonyms: ['HOLIDAY', 'HOLIDAY PAY'], blankZero: false },
  { key: 'loan_recovery_override', kind: 'number', synonyms: ['LOAN REPAYMENT', 'LOAN INST', 'INST'], blankZero: false },
  { key: 'advance_recovery_override', kind: 'number', synonyms: ['ADVANCE RECOVERY', 'ADV RECOVERY'], blankZero: false },
  { key: 'paid_separately', kind: 'number', synonyms: ['PAID SEPARATELY', 'ANIK'], blankZero: false },
  { key: 'remarks', kind: 'text', synonyms: ['REMARKS', 'REMARK', 'NOTES'], blankZero: false },
  { key: 'department', kind: 'text', synonyms: ['DEPT', 'DEPARTMENT'], blankZero: false, info: true },
  { key: 'firm', kind: 'text', synonyms: ['FIRM'], blankZero: false, info: true },
  { key: 'pay_channel', kind: 'text', synonyms: ['CODE 2', 'TRANS MODE', 'BANK ALLOCATION', 'MODE'], blankZero: false, info: true },
];
for (const f of FIELDS) { Object.freeze(f.synonyms); Object.freeze(f); }
Object.freeze(FIELDS);

// ── Headers ───────────────────────────────────────────────────────────

// normName: NBSP to space, runs of whitespace collapsed, trimmed, upper-cased. The trailing dot is kept here
// (it is part of the saved-map signature) and ignored only when matching.
export function normHeader(s) {
  return normName(s);
}

const stripDot = (s) => (s.endsWith('.') ? s.slice(0, -1) : s);

// Dot-less normalised synonym to the field that lists it. FIELDS order breaks a tie: the first list to claim a
// synonym keeps it. (No synonym is listed twice today; the tests pin that.)
const OWNER = new Map();
for (const f of FIELDS) {
  for (const synonym of f.synonyms) {
    const key = stripDot(normHeader(synonym));
    if (!OWNER.has(key)) OWNER.set(key, f.key);
  }
}

// The key of the field a header cell names, or undefined. Exact text only.
const fieldOf = (cell) => OWNER.get(stripDot(normHeader(cell)));

// Cell values may be anything in a hand-made grid; the parser works on text.
const cellStr = (v) => (v === null || v === undefined ? '' : String(v));

// ── Reading the file ──────────────────────────────────────────────────

const NBSP = String.fromCharCode(0xa0);
const ERR = '#ERR';

// A number is never longer than this once typed by a person. rat() runs a regex that is quadratic on a very long
// digit run (seconds at Excel's 32,767-character cell limit), and a file can hold thousands of such cells.
const MAX_NUMBER_CHARS = 64;

function isoDate(d) {
  if (Number.isNaN(d.getTime())) return ERR;
  const year = String(d.getUTCFullYear()).padStart(4, '0');
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// String(n), but never in exponent notation. String switches to an exponent below 1e-6 and from 1e21, and a typed
// exponent is refused as text (ruling T4-h), so a real numeric cell that prints with one (the float noise a formula
// leaves where it means 0, say 2.7e-17) must reach the grid as plain digits or it would be refused as well. A number
// whose plain form would pass MAX_NUMBER_CHARS is left as it prints: it is nonsense in a payroll sheet, and is refused.
function plainNumber(n) {
  const text = String(n);
  const m = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (!m) return text;
  const [, sign, whole, fraction = '', exponent] = m;
  const digits = whole + fraction;
  const point = whole.length + Number(exponent);                  // where the decimal point falls within the digits
  let length;
  if (point <= 0) length = 2 - point + digits.length;             // 0.000ddd
  else if (point >= digits.length) length = point;                // ddd000
  else length = digits.length + 1;                                // dd.dd
  if (sign.length + length > MAX_NUMBER_CHARS) return text;
  let plain;
  if (point <= 0) plain = `0.${'0'.repeat(-point)}${digits}`;
  else if (point >= digits.length) plain = digits + '0'.repeat(point - digits.length);
  else plain = `${digits.slice(0, point)}.${digits.slice(point)}`;
  return sign + plain;
}

// The text of one exceljs cell value (a formula cell is read through its result: see cellText). A link's `text` can
// be any kind of value itself (a date, an error, rich text), so that is flattened again.
function flatten(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return plainNumber(v);
  if (typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return isoDate(v);
  if (typeof v !== 'object') return '';
  if ('error' in v) return ERR;
  if (Array.isArray(v.richText)) return v.richText.map((run) => flatten(run?.text)).join('');
  if ('hyperlink' in v || 'text' in v) return flatten(v.text);
  return '';
}

function cellText(cell, ValueType) {
  // exceljs gives every cell of a merged range the master's value. Excel keeps it in the top-left cell only, so
  // the others are empty: a value must not be read twice.
  if (cell.type === ValueType.Merge) return '';
  // A formula is read through `cell.result`, never `cell.value`: exceljs copies only truthy fields into `value`, so a
  // cached 0, FALSE or '' has no `result` there. A formula that calculates to 0 must read 0 (an override of 0), not
  // blank (no override), and the engine treats the two differently.
  const value = cell.type === ValueType.Formula ? cell.result : cell.value;
  return flatten(value).split(NBSP).join(' ');
}

// The formula of a formula cell without its leading '=', or ''. exceljs gives a cell that shares a formula its own
// translated text (the master's references slid to that cell, so `cell.formula` is what to read); if a version
// does not, the master's text is the best there is.
function formulaText(cell, ValueType) {
  if (cell.type !== ValueType.Formula) return '';
  let text = cell.formula;
  if (typeof text !== 'string' || text === '') {
    const master = cell.value?.sharedFormula ? cell.worksheet.findCell(cell.value.sharedFormula) : undefined;
    text = master?.formula;
  }
  return typeof text === 'string' ? text.replace(/^=/, '') : '';
}

// A stray value typed far from the data (row 1,000,000, or column XFD) would make the padded grid enormous, and
// the upload size cap does not bound that: a file records only the cells that hold something. No payroll sheet
// comes near this many cells, so a bigger one is refused rather than left to exhaust the server.
const MAX_GRID_CELLS = 2_000_000;

// One sheet as {name, grid}: a dense grid whose rows are padded to the widest cell that holds anything, with
// empty rows between data kept (so grid index + 1 is the Excel row) and empty rows after the last data row
// dropped. With `withFormulas` the sheet also has `formulas`, cut to exactly the grid's rows and width, so a
// formula that shows nothing past the last text cell or row is not reported: the grid itself is the same either way.
function readSheet(ws, ValueType, withFormulas) {
  const lines = [];
  const formulaLines = [];
  let width = 0;
  ws.eachRow((row, rowNumber) => {
    const line = [];
    const formulaLine = [];
    row.eachCell((cell, colNumber) => {
      const formula = withFormulas ? formulaText(cell, ValueType) : '';
      if (formula !== '') formulaLine[colNumber - 1] = formula;
      const text = cellText(cell, ValueType);
      if (text === '') return;
      line[colNumber - 1] = text;
      if (colNumber > width) width = colNumber;
    });
    lines[rowNumber - 1] = line;
    formulaLines[rowNumber - 1] = formulaLine;
  });
  if (lines.length * width > MAX_GRID_CELLS) {
    throw new Error(`Sheet "${ws.name}" is too large to read (${lines.length} rows by ${width} columns).`);
  }
  const grid = [];
  for (let r = 0; r < lines.length; r++) {
    const line = lines[r] ?? [];
    grid.push(Array.from({ length: width }, (_, c) => line[c] ?? ''));
  }
  while (grid.length > 0 && grid[grid.length - 1].every((text) => text === '')) grid.pop();
  const sheet = { name: ws.name, grid };
  if (withFormulas) {
    sheet.formulas = grid.map((_, r) => Array.from({ length: width }, (__, c) => formulaLines[r]?.[c] ?? ''));
  }
  return sheet;
}

// {sheets:[{name, grid}]}, sheets in workbook order, names exactly as the workbook has them. With {formulas: true}
// each sheet is {name, grid, formulas}. A buffer that is not a readable workbook rejects (exceljs's own error);
// the upload route checks the magic bytes first.
export async function readWorkbook(buffer, { formulas = false } = {}) {
  // exceljs is loaded here, when a workbook is read, and not at the top of the module: app.js imports every route
  // eagerly, so a top-level import would add exceljs's load time to every cold start of the whole ERP. A literal
  // specifier, as routes/orders.js does, so that the Vercel bundler keeps it.
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return { sheets: wb.worksheets.map((ws) => readSheet(ws, ExcelJS.ValueType, formulas)) };
}

// ── Finding the header and mapping columns ────────────────────────────

const HEADER_SCAN_ROWS = 15;
const HEADER_MIN_KNOWN = 3;

// How many cells of a row are a known header.
const knownIn = (row) => (row ?? []).reduce((n, cell) => n + (fieldOf(cell) === undefined ? 0 : 1), 0);

// The first of the first 15 rows with three or more known headers, or null.
export function detectHeader(grid) {
  const rows = grid ?? [];
  const last = Math.min(HEADER_SCAN_ROWS, rows.length);
  for (let r = 0; r < last; r++) {
    if (knownIn(rows[r]) >= HEADER_MIN_KNOWN) return { headerRow: r, headers: Array.from(rows[r], cellStr) };
  }
  return null;
}

// The sheet whose header row knows the most columns; the earlier sheet wins a tie. Null when no sheet has a
// header row.
export function pickSheet(sheets) {
  let best = null;
  let bestKnown = 0;
  for (const sheet of sheets ?? []) {
    const found = detectHeader(sheet?.grid ?? []);
    if (!found) continue;
    const known = knownIn(found.headers);
    if (known > bestKnown) { best = { name: sheet.name, ...found }; bestKnown = known; }
  }
  return best;
}

// header cells to {map: {field key: column index}, unmapped: [column index], signature}.
//   - Each column maps to at most one field (the first field in FIELDS order that lists its header), and each
//     field to at most one column: the leftmost.
//   - unmapped is every column with a header that did not map: unrecognised, or a repeat of a field already
//     mapped further left. A blank header has nothing to recognise and is not listed.
//   - signature is the normalised headers joined by '|', blank columns after the last header dropped: every
//     row is padded to the sheet's width, so a note typed far right in one month must not change it.
export function autoMap(headers) {
  const norm = Array.from(headers ?? [], (header) => normHeader(header));         // a hole in the array is a blank header
  const map = {};
  const unmapped = [];
  norm.forEach((header, col) => {
    if (header === '') return;
    const key = fieldOf(header);
    if (key !== undefined && map[key] === undefined) map[key] = col;
    else unmapped.push(col);
  });
  let end = norm.length;
  while (end > 0 && norm[end - 1] === '') end--;
  return { map, unmapped, signature: norm.slice(0, end).join('|') };
}

// ── Reading numbers ───────────────────────────────────────────────────

const INDIAN_GROUPS = /^\d{1,2}(,\d{2})*,\d{3}(\.\d+)?$/;      // 1,00,000   12,34,567.89
const WESTERN_GROUPS = /^\d{1,3}(,\d{3})+(\.\d+)?$/;           // 100,000    1,234,567.5
const LEADING_CURRENCY = /^([+-]?)\s*(?:₹|rs\.?)\s*/i;          // ₹ 5,000   Rs. 5,000   -₹ 5,000   - Rs 5
const TRAILING_CURRENCY = /\s*(?:₹|rs\.?)$/i;                   // 5,000 Rs
const INSIDE_NUMBER = /\s|₹|rs|e/i;                              // whitespace, a currency, or an exponent marker
const TWO = rat(2);

// The Rat a cell's text means, or null when it is not a number. rat() is lenient: it strips spaces, commas, ₹
// and Rs wherever they are, so '2 5' and '2,5' would both be 25, and it takes an exponent, so '1e999' would be a
// thousand-digit number. Here the currency is set aside first (it may stand before or after the number, with spaces
// between, and a sign may precede it), and then what is left must be one unbroken run: no space inside it, no
// currency inside it, no exponent (ruling T4-h: a typed '1e3' is refused; a real numeric cell never arrives with one,
// readWorkbook writes it out in plain digits), and no comma except in valid digit grouping. `text` is already trimmed.
function parseNumber(text) {
  if (text.length > MAX_NUMBER_CHARS) return null;
  const number = text.replace(LEADING_CURRENCY, '$1').replace(TRAILING_CURRENCY, '');
  if (INSIDE_NUMBER.test(number)) return null;
  if (number.includes(',')) {
    const digits = number.replace(/^[+-]/, '');
    if (!INDIAN_GROUPS.test(digits) && !WESTERN_GROUPS.test(digits)) return null;
  }
  try {
    return rat(number);
  } catch {
    return null;                                               // rat() throws TypeError for anything not a number
  }
}

// The days in the month as a Rat; null when none was given (or it is not a positive number), and then there is
// nothing to compare absent days against.
function daysLimit(daysInMonth) {
  if (daysInMonth === undefined || daysInMonth === null) return null;
  try {
    const days = rat(daysInMonth);
    return isNeg(days) || isZero(days) ? null : days;
  } catch {
    return null;
  }
}

// A cell quoted inside a message: a long cell is shown in part.
const clip = (s, max = 40) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const issue = (level, code, field, message) => ({ level, code, field, message });
// A map entry is a column only if it is a whole number from 0. A saved map can hold null for a field the user
// cleared; that means "not in the file", and must not read column 0 or turn into a blank-as-zero.
const isColumn = (c) => Number.isInteger(c) && c >= 0;

// ── Rows ──────────────────────────────────────────────────────────────

// A dash typed in the code column where a code would go means "no code".
const PLACEHOLDER_CODES = new Set(['-', '—']);

// The most a NUMERIC(12,2) column holds; a value of either sign beyond it is an error (ruling T4-h).
const LARGEST_TEXT = '9999999999.99';
const LARGEST = rat(LARGEST_TEXT);

// How many decimal places the column behind each number field stores (ruling T4-i): 2 for money, 4 for quantities.
// Keyed by field because FIELDS stays as the brief lists it. More places than this is a warning.
const STORED_PLACES = {
  ot_hours: 4, absent_days: 4, paid_leave_days: 4, hours_worked: 4,
  misc_earning: 2, misc_deduction: 2, bonus: 2, advance_given: 2, bill_amount: 2,
  holiday_override: 2, loan_recovery_override: 2, advance_recovery_override: 2, paid_separately: 2,
};
const NO_NAME_OR_CODE = 'This row has figures but no name or code. Ignore it, or add the name or code.';

// Rows below the header as [{row_no, raw, fields, issues}].
//   row_no   the 1-based Excel row.
//   raw      a copy of the whole row, every column, as text: stored with the row, it lets a re-map or an error
//            report work without the file.
//   fields   one entry per MAPPED field, never for a column that is not in the file. Text and code fields are
//            the trimmed text (a code that is only '-' or '—' is null). A number is a fmtDecimal string. A blank
//            is null, or '0' for a number field ticked in `blankZero`. Unreadable text is null (with an issue).
//   issues   {level, code, field, message}. First, for a row with no name and no code, NO_NAME_OR_CODE (error,
//            field null). Then, in FIELDS order, for each number cell one of: NOT_A_NUMBER (error); TOO_LARGE
//            (error, beyond 9999999999.99 either way); NEGATIVE (error); or, for a value that passes those,
//            ABSENT_EXCEEDS_DAYS (error), ABSENT_NOT_HALF (warn) and MORE_DECIMALS_THAN_STORED (warn).
//            An error that is already the whole story stops the checks after it: a number that is too large or
//            negative is not also warned about.
// A row with no name and no code is skipped only when it has no figure: no non-blank cell in any mapped number
// column (a blank that "counts as 0" is not a figure). One that has a figure is returned with NO_NAME_OR_CODE, so
// the operator must decide about it and nothing is dropped silently. Messages name a column by the header the
// sheet gave it.
export function extractRows(grid, headerRow, map, options = {}) {
  const { blankZero, daysInMonth } = options ?? {};
  const ticked = blankZero ?? {};
  const limit = daysLimit(daysInMonth);
  const head = grid[headerRow] ?? [];
  const cols = {};
  for (const f of FIELDS) if (isColumn(map?.[f.key])) cols[f.key] = map[f.key];
  const numberCols = FIELDS.filter((f) => f.kind === 'number' && cols[f.key] !== undefined).map((f) => cols[f.key]);
  const label = (f) => {
    const header = cellStr(head[cols[f.key]]).trim();
    return header === '' ? f.key : clip(header);
  };

  const rows = [];
  for (let r = headerRow + 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const textAt = (col) => cellStr(row[col]).trim();
    const codeAt = (col) => {
      const text = textAt(col);
      return PLACEHOLDER_CODES.has(text) ? '' : text;
    };
    const unidentified = (cols.name === undefined || textAt(cols.name) === '')
      && (cols.code === undefined || codeAt(cols.code) === '');
    if (unidentified && !numberCols.some((col) => textAt(col) !== '')) continue;

    const fields = {};
    const issues = [];
    if (unidentified) {
      issues.push(issue('error', 'NO_NAME_OR_CODE', null, NO_NAME_OR_CODE));
    }
    for (const f of FIELDS) {
      const col = cols[f.key];
      if (col === undefined) continue;
      const text = f.kind === 'code' ? codeAt(col) : textAt(col);
      if (f.kind !== 'number') {
        fields[f.key] = text === '' ? null : text;
        continue;
      }
      if (text === '') {
        fields[f.key] = ticked[f.key] ? '0' : null;
        continue;
      }
      const value = parseNumber(text);
      if (value === null) {
        fields[f.key] = null;
        issues.push(issue('error', 'NOT_A_NUMBER', f.key, `${label(f)}: "${clip(text)}" is not a number.`));
        continue;
      }
      const shown = fmtDecimal(value);
      fields[f.key] = shown;
      if (cmp(isNeg(value) ? neg(value) : value, LARGEST) > 0) {
        issues.push(issue('error', 'TOO_LARGE', f.key, `${label(f)}: ${clip(shown)} is too large; the most that can be stored is ${LARGEST_TEXT}.`));
        continue;
      }
      if (isNeg(value)) {
        issues.push(issue('error', 'NEGATIVE', f.key, `${label(f)}: ${shown} is below zero; it cannot be negative.`));
        continue;
      }
      if (f.key === 'absent_days') {
        if (limit !== null && cmp(value, limit) > 0) {
          const message = `${label(f)}: ${shown} is more than the ${fmtDecimal(limit)} days in the month.`;
          issues.push(issue('error', 'ABSENT_EXCEEDS_DAYS', f.key, message));
        }
        if (mul(value, TWO).d !== 1n) {                       // a multiple of 0.5 doubles to a whole number
          issues.push(issue('warn', 'ABSENT_NOT_HALF', f.key, `${label(f)}: ${shown} is not a whole or half day.`));
        }
      }
      const places = shown.includes('.') ? shown.length - shown.indexOf('.') - 1 : 0;      // on the exact value: 100.500 is 100.5
      if (places > STORED_PLACES[f.key]) {
        const message = `${label(f)}: ${clip(shown)} has more than ${STORED_PLACES[f.key]} decimal places; it will be rounded when it is stored.`;
        issues.push(issue('warn', 'MORE_DECIMALS_THAN_STORED', f.key, message));
      }
    }
    rows.push({ row_no: r + 1, raw: Array.from(row, cellStr), fields, issues });
  }
  return rows;
}
