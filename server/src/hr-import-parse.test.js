// Excel import parsing for the HR & Payroll module (hr/import-parse.js).
//
// Anik uploads one monthly sheet: names, codes, overtime hours, absent days, advances. The module finds the
// header row, maps columns by their header text, and turns every row into typed values. It never guesses: a
// header matches only by its exact text, a cell is a number only if it reads as one, and a blank stays blank
// (null) unless that column is ticked "blank counts as 0".
// Expected values below are hand-derived from the fixtures, never copied from the module's output.
// Every name here is synthetic. NBSP is built with String.fromCharCode(0xa0): an editor may silently turn a
// typed one into a plain space.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import * as parser from './hr/import-parse.js';
import { FIELDS, readWorkbook, normHeader, detectHeader, pickSheet, autoMap, extractRows } from './hr/import-parse.js';

const NBSP = String.fromCharCode(0xa0);

// ── Fixture helpers ───────────────────────────────────────────────────

async function bufferOf(build) {
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

// Extracts from a hand-made grid whose header is row 0.
const extract = (rows, map, opts = { blankZero: {}, daysInMonth: 31 }) => extractRows(rows, 0, map, opts);
// One advance cell: 'x' is the person, `text` the advance column.
const advance = (text) => extract([['NAME', 'ADVANCE'], ['x', text]], { name: 0, advance_given: 1 })[0];
const triples = (issues) => issues.map((i) => [i.level, i.code, i.field]);

// ── The task brief's workbook: title row, header on Excel row 2, one blank row, five people ──
// The header cells end in a non-breaking space at four places, exactly as the brief has them.
const HEADERS = ['PERSON' + NBSP, 'Code No. ', 'DEPT', 'OT', 'AB', 'MISC.' + NBSP, 'ADVANCE' + NBSP, 'BILL AMOUNT ', 'REMARKS' + NBSP, 'EXTRA'];

async function briefBook() {
  return bufferOf((wb) => {
    const ws = wb.addWorksheet('July');
    put(ws, [
      ['MONTH '],
      HEADERS,
      ['Alpha', 130, undefined, { formula: '40+46.37', result: 86.37 }, 3, 410, '11,000'],
      ['Beta', undefined, undefined, undefined, 'abc'],
      [],                                                                           // Excel row 5: fully blank
      ['Gamma', undefined, undefined, undefined, undefined, undefined, -5],
      ['Delta', undefined, undefined, ' 12.5 ', 2.25],
      ['Echo', undefined, undefined, undefined, 32, undefined, '₹ 5,000'],
    ]);
  });
}

// ── The module's surface ──────────────────────────────────────────────

test('exports exactly the seven names the later tasks import', () => {
  assert.deepEqual(Object.keys(parser).sort(),
    ['FIELDS', 'autoMap', 'detectHeader', 'extractRows', 'normHeader', 'pickSheet', 'readWorkbook']);
});

// ── FIELDS, exactly as the brief lists them ───────────────────────────

// [key, kind, synonyms, blankZero, info]
const TABLE = [
  ['name', 'text', ['PERSON', 'NAME', 'EMPLOYEE NAME', 'EMPLOYEE'], false, false],
  ['code', 'code', ['CODE NO.', 'CODE NO', 'CODE', 'EMPLOYEE ID', 'EMP CODE', 'EMP ID'], false, false],
  ['ot_hours', 'number', ['OT', 'OT HOURS', 'OVERTIME', 'OVERTIME HOURS'], true, false],
  ['absent_days', 'number', ['AB', 'ABSENT', 'ABSENT DAYS', 'ABSENCE DAYS'], true, false],
  ['paid_leave_days', 'number', ['PAID LEAVE', 'PAID LEAVE DAYS', 'PL'], false, false],
  ['hours_worked', 'number', ['HOURS WORKED', 'HOURS'], false, false],
  ['misc_earning', 'number', ['MISC.', 'MISC', 'MISCELLANEOUS', 'MISC EARNING'], true, false],
  ['misc_deduction', 'number', ['MISC DEDUCTION', 'OTHER DEDUCTION', 'DEDUCTION'], false, false],
  ['bonus', 'number', ['BONUS', 'INCENTIVE', 'BONUS/INCENTIVE'], false, false],
  ['advance_given', 'number', ['ADVANCE', 'ADV', 'ADVANCE TAKEN'], true, false],
  ['bill_amount', 'number', ['BILL AMOUNT', 'BILL'], true, false],
  ['holiday_override', 'number', ['HOLIDAY', 'HOLIDAY PAY'], false, false],
  ['loan_recovery_override', 'number', ['LOAN REPAYMENT', 'LOAN INST', 'INST'], false, false],
  ['advance_recovery_override', 'number', ['ADVANCE RECOVERY', 'ADV RECOVERY'], false, false],
  ['paid_separately', 'number', ['PAID SEPARATELY', 'ANIK'], false, false],
  ['remarks', 'text', ['REMARKS', 'REMARK', 'NOTES'], false, false],
  ['department', 'text', ['DEPT', 'DEPARTMENT'], false, true],
  ['firm', 'text', ['FIRM'], false, true],
  ['pay_channel', 'text', ['CODE 2', 'TRANS MODE', 'BANK ALLOCATION', 'MODE'], false, true],
];

test('FIELDS is the brief\'s table: keys, order, kinds, synonyms, blankZero, info', () => {
  assert.deepEqual(FIELDS, TABLE.map(([key, kind, synonyms, blankZero, info]) =>
    ({ key, kind, synonyms, blankZero, ...(info ? { info: true } : {}) })));
});

test('FIELDS is frozen: no caller can change what every upload is parsed against', () => {
  assert.ok(Object.isFrozen(FIELDS));
  for (const f of FIELDS) assert.ok(Object.isFrozen(f) && Object.isFrozen(f.synonyms), f.key);
  assert.throws(() => FIELDS.push({ key: 'x' }), TypeError);
  assert.throws(() => FIELDS[0].synonyms.push('X'), TypeError);
});

test('FIELDS: every synonym is stored normalised, and belongs to one field only', () => {
  assert.equal(FIELDS.length, TABLE.length);                         // so the loop below cannot pass by having nothing to check
  const owner = new Map();
  for (const f of FIELDS) {
    for (const syn of f.synonyms) {
      assert.equal(normHeader(syn), syn, `${syn} is not stored normalised`);
      const bare = syn.replace(/\.$/, '');
      assert.ok(!owner.has(bare) || owner.get(bare) === f.key, `${syn} belongs to ${owner.get(bare)} and ${f.key}`);
      owner.set(bare, f.key);
    }
  }
});

test('every synonym maps to its own field, in any case, with stray spaces, and with the trailing dot kept or dropped', () => {
  assert.equal(FIELDS.length, TABLE.length);
  for (const f of FIELDS) {
    for (const syn of f.synonyms) {
      const dotToggled = syn.endsWith('.') ? syn.slice(0, -1) : `${syn}.`;
      for (const header of [syn, dotToggled, `  ${syn.toLowerCase()}${NBSP}`, syn.replace(/ /g, '   ')]) {
        assert.equal(autoMap([header]).map[f.key], 0, `${JSON.stringify(header)} should map to ${f.key}`);
      }
    }
  }
});

// ── normHeader ────────────────────────────────────────────────────────

test('normHeader: trims, collapses spaces (NBSP too), upper-cases, keeps the dot, blank for nothing', () => {
  assert.equal(normHeader('  Code   No. '), 'CODE NO.');
  assert.equal(normHeader('bill' + NBSP + NBSP + 'amount'), 'BILL AMOUNT');
  assert.equal(normHeader('BILL\nAMOUNT'), 'BILL AMOUNT');
  assert.equal(normHeader('MISC.'), 'MISC.');
  assert.equal(normHeader(null), '');
  assert.equal(normHeader(undefined), '');
  assert.equal(normHeader(5), '5');
});

// ── The task brief's tests, verbatim ──────────────────────────────────

test('brief: file to header to column map to typed rows', async () => {
  const buf = await briefBook();
  const { sheets } = await readWorkbook(buf); const s = pickSheet(sheets);
  assert.equal(s.headerRow, 1);
  const { map, signature } = autoMap(s.headers);
  assert.deepEqual([map.name, map.code, map.department, map.ot_hours, map.absent_days, map.misc_earning,
    map.advance_given, map.bill_amount, map.remarks], [0,1,2,3,4,5,6,7,8]);
  assert.equal(autoMap(['person',' code no.','dept','ot','ab','misc.','advance','bill  amount','remarks','extra']).signature, signature);
  const rows = extractRows(sheets[0].grid, s.headerRow, map, { blankZero:{ot_hours:true, absent_days:true}, daysInMonth:31 });
  assert.equal(rows.length, 5);                                              // blank row skipped
  assert.equal(rows[0].fields.ot_hours, '86.37'); assert.equal(rows[0].fields.advance_given, '11000');
  assert.equal(rows[1].fields.ot_hours, '0');                                // blank-as-zero
  assert.ok(rows[1].issues.some(i => i.code==='NOT_A_NUMBER' && i.field==='absent_days'));
  assert.ok(rows[2].issues.some(i => i.code==='NEGATIVE'));
  assert.ok(rows[3].issues.some(i => i.code==='ABSENT_NOT_HALF' && i.level==='warn'));
  assert.equal(rows[3].fields.ot_hours, '12.5');                             // text number with spaces
  assert.equal(rows[4].fields.advance_given, '5000');
  assert.ok(rows[4].issues.some(i => i.code==='ABSENT_EXCEEDS_DAYS'));
  const noZero = extractRows(sheets[0].grid, s.headerRow, map, { blankZero:{}, daysInMonth:31 });
  assert.equal(noZero[1].fields.ot_hours, null);
  // columns re-ordered with an extra leading column still map by header
  assert.equal(autoMap(['SR','ADVANCE','PERSON','AB','OT']).map.name, 2);
});

test('brief fixture: the grid, row numbers, and exactly the issues each row should carry', async () => {
  const { sheets } = await readWorkbook(await briefBook());
  assert.equal(sheets.length, 1);
  assert.equal(sheets[0].name, 'July');
  // Eight Excel rows, every one ten cells wide; the NBSPs in the header are plain spaces now.
  assert.deepEqual(sheets[0].grid, [
    ['MONTH ', '', '', '', '', '', '', '', '', ''],
    ['PERSON ', 'Code No. ', 'DEPT', 'OT', 'AB', 'MISC. ', 'ADVANCE ', 'BILL AMOUNT ', 'REMARKS ', 'EXTRA'],
    ['Alpha', '130', '', '86.37', '3', '410', '11,000', '', '', ''],
    ['Beta', '', '', '', 'abc', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', ''],
    ['Gamma', '', '', '', '', '', '-5', '', '', ''],
    ['Delta', '', '', ' 12.5 ', '2.25', '', '', '', '', ''],
    ['Echo', '', '', '', '32', '', '₹ 5,000', '', '', ''],
  ]);
  const s = pickSheet(sheets);
  const { map, unmapped } = autoMap(s.headers);
  assert.deepEqual(unmapped, [9]);                                                // only EXTRA is left over
  const rows = extractRows(sheets[0].grid, s.headerRow, map, { blankZero: { ot_hours: true, absent_days: true }, daysInMonth: 31 });
  assert.deepEqual(rows.map((r) => r.row_no), [3, 4, 6, 7, 8]);                   // 1-based Excel rows; row 5 skipped
  assert.deepEqual(rows[0].fields, {
    name: 'Alpha', code: '130', department: null, ot_hours: '86.37', absent_days: '3', misc_earning: '410',
    advance_given: '11000', bill_amount: null, remarks: null,
  });
  assert.deepEqual(rows.map((r) => triples(r.issues)), [
    [],
    [['error', 'NOT_A_NUMBER', 'absent_days']],
    [['error', 'NEGATIVE', 'advance_given']],
    [['warn', 'ABSENT_NOT_HALF', 'absent_days']],
    [['error', 'ABSENT_EXCEEDS_DAYS', 'absent_days']],
  ]);
  assert.equal(rows[1].fields.absent_days, null);                                 // text never becomes a number...
  assert.equal(rows[1].fields.ot_hours, '0');                                     // ...but a blank can become 0
  assert.equal(rows[2].fields.advance_given, '-5');                               // the value is shown with its error
  assert.equal(rows[3].fields.absent_days, '2.25');                               // a warning does not change the value
});

// ── readWorkbook: every cell becomes text (ruling 3) ──────────────────

test('readWorkbook: numbers, formulas, rich text, links, errors, dates, booleans and NBSP all become text', async () => {
  const buf = await bufferOf((wb) => {
    const ws = wb.addWorksheet('Kinds');
    put(ws, [
      [42, 0.1, -5, { formula: '40+46.37', result: 86.37 }, { formula: '"a"&"b"', result: 'ab' },
        { richText: [{ text: 'Al' }, { text: 'pha', font: { bold: true } }] },
        { text: 'Link text', hyperlink: 'https://example.invalid/' }, { error: '#DIV/0!' },
        new Date(Date.UTC(2026, 6, 15, 20, 0, 0)), true, false, { formula: '1/0', result: { error: '#DIV/0!' } }],
      [5, { formula: 'A2*2', result: 10 }, 'a' + NBSP + 'b' + NBSP, undefined, { formula: '1+1' }],
      [undefined, { sharedFormula: 'B2', result: 12 }],
    ]);
  });
  const { grid } = (await readWorkbook(buf)).sheets[0];
  assert.deepEqual(grid, [
    // number, decimal, negative, formula result, formula text result, rich text, link text, error, date, TRUE, FALSE, formula error
    ['42', '0.1', '-5', '86.37', 'ab', 'Alpha', 'Link text', '#ERR', '2026-07-15', 'TRUE', 'FALSE', '#ERR'],
    ['5', '10', 'a b ', '', '', '', '', '', '', '', '', ''],       // NBSP becomes a space; a never-calculated formula is blank
    ['', '12', '', '', '', '', '', '', '', '', '', ''],            // a cell sharing a formula reads its cached result too
  ]);
});

// exceljs's cell.value for a formula copies only truthy fields, so a cached 0, FALSE or '' has no `result` key there;
// cell.result still holds it. Reading cell.value turned a formula that calculates to 0 into a blank, and "blank" and
// "0" are different inputs to the engine ("no override" against "an override of 0").
test('readWorkbook: a formula that calculates to 0 or FALSE reads 0 or FALSE, not blank', async () => {
  const buf = await bufferOf((wb) => {
    put(wb.addWorksheet('Zeros'), [[
      0,                                                             // a typed 0, for comparison
      { formula: 'A1*5', result: 0 },                                // calculates to 0
      { formula: 'A1=1', result: false },                            // calculates to FALSE
      { formula: 'A1=1', result: true },
      { formula: 'IF(A1,"x","")', result: '' },                      // calculates to nothing: still blank
      { formula: 'A1+5', result: 5 },                                // an ordinary result
      { formula: '1/0', result: { error: '#DIV/0!' } },
      { formula: 'A1*5', result: -0 },
    ]]);
  });
  assert.deepEqual((await readWorkbook(buf)).sheets[0].grid, [['0', '0', 'FALSE', 'TRUE', '', '5', '#ERR', '0']]);
});

test('readWorkbook: a cell that shares a formula and calculates to 0 reads 0', async () => {
  const buf = await bufferOf((wb) => {
    put(wb.addWorksheet('Shared zeros'), [
      [3, { formula: 'A1*0', result: 0 }],                           // the master, calculating to 0
      [4, { sharedFormula: 'B1', result: 0 }],                       // a clone calculating to 0
      [5, { sharedFormula: 'B1', result: 7 }],                       // and one that does not
    ]);
  });
  assert.deepEqual((await readWorkbook(buf)).sheets[0].grid, [['3', '0'], ['4', '0'], ['5', '7']]);
});

test('a formula that calculates to 0 imports as 0, not as "no value": holiday, loan repayment, bonus, absent days, advance', async () => {
  const zero = { formula: 'G9*0', result: 0 };
  const buf = await bufferOf((wb) => {
    put(wb.addWorksheet('Month'), [
      ['PERSON', 'HOLIDAY', 'INST', 'BONUS', 'AB', 'ADVANCE', 'BILL AMOUNT'],
      ['Alpha', zero, zero, zero, zero, zero],                                 // every one a formula that calculates to 0
      ['Beta', 0, 0, 0, 0, 0],                                                 // the same zeros, typed
      ['Gamma'],                                                               // nothing at all
    ]);
  });
  const { sheets } = await readWorkbook(buf);
  const picked = pickSheet(sheets);
  const { map } = autoMap(picked.headers);
  const rows = extractRows(sheets[0].grid, picked.headerRow, map, { blankZero: {}, daysInMonth: 31 });
  for (const key of ['holiday_override', 'loan_recovery_override', 'bonus', 'absent_days', 'advance_given']) {
    assert.equal(rows[0].fields[key], '0', `${key}: formula 0`);                  // an override of 0, which the engine treats differently from none
    assert.equal(rows[1].fields[key], '0', `${key}: typed 0`);
    assert.equal(rows[2].fields[key], null, `${key}: nothing`);
  }
  assert.equal(rows[0].fields.bill_amount, null);
  for (const row of rows) assert.deepEqual(row.issues, []);
});

test('readWorkbook: a date is read by its UTC parts, so the server\'s time zone cannot move it a day', async () => {
  // 20:00 UTC on the 15th is already the 16th in India; 01:00 UTC is still the 14th in California.
  const buf = await bufferOf((wb) => {
    put(wb.addWorksheet('Dates'), [[new Date(Date.UTC(2026, 6, 15, 20, 0, 0)), new Date(Date.UTC(2026, 6, 15, 1, 0, 0)),
      new Date(Date.UTC(2026, 11, 31, 23, 59, 0)), { formula: 'A1', result: new Date(Date.UTC(2026, 0, 31)) }, 1e12]]);
    wb.worksheets[0].getCell('D1').numFmt = 'yyyy-mm-dd';
    wb.worksheets[0].getCell('E1').numFmt = 'yyyy-mm-dd';                  // a date format on a number no date can hold
  });
  assert.deepEqual((await readWorkbook(buf)).sheets[0].grid, [['2026-07-15', '2026-07-15', '2026-12-31', '2026-01-31', '#ERR']]);
});

test('readWorkbook: a merged range keeps its value in its top-left cell only', async () => {
  const buf = await bufferOf((wb) => {
    const ws = wb.addWorksheet('Merged');
    put(ws, [['TITLE'], ['PERSON', 'OT', 'AB']]);
    ws.mergeCells('A1:C1');
    put(ws, [['Alpha', 5, 1], ['Alpha', 6, 2]], 3);
    ws.mergeCells('A3:A4');
  });
  assert.deepEqual((await readWorkbook(buf)).sheets[0].grid, [
    ['TITLE', '', ''],
    ['PERSON', 'OT', 'AB'],
    ['Alpha', '5', '1'],
    ['', '6', '2'],
  ]);
});

test('a group title merged across columns is one header, so it cannot pass for the header row', async () => {
  // Row 1 reads ADVANCE x3 and OT x3 if every merged cell repeated its master: six known headers, a "header row".
  const buf = await bufferOf((wb) => {
    const ws = wb.addWorksheet('Two tiers');
    put(ws, [['ADVANCE', undefined, undefined, 'OT'], ['PERSON', 'CODE NO.', 'OT', 'AB', 'ADVANCE', 'REMARKS'], ['Alpha', 130, 5, 1, 2000]]);
    ws.mergeCells('A1:C1');
    ws.mergeCells('D1:F1');
  });
  const { sheets } = await readWorkbook(buf);
  assert.deepEqual(sheets[0].grid[0], ['ADVANCE', '', '', 'OT', '', '']);
  const picked = pickSheet(sheets);
  assert.equal(picked.headerRow, 1);
  assert.deepEqual(autoMap(picked.headers).map, { name: 0, code: 1, ot_hours: 2, absent_days: 3, advance_given: 4, remarks: 5 });
});

test('readWorkbook: every row is padded to one width, columns never shift, and Excel row numbers are kept', async () => {
  const buf = await bufferOf((wb) => {
    const ws = wb.addWorksheet('Ragged');
    put(ws, [[undefined, undefined, undefined, 'D3']], 3);                  // rows 1-2 empty, row 3 starts in column D
    put(ws, [['A4']], 4);                                                   // a short row
    put(ws, [[undefined, undefined, undefined, undefined, 'E6']], 6);       // row 5 empty, row 6 reaches column E
    ws.getCell('B9').value = '';                                            // cells that show nothing, and rows after the data
    ws.getCell('H9').value = { formula: '""', result: '' };                 // (a formula that shows nothing, far to the right)
    ws.getCell('A10').numFmt = '0.00';
  });
  assert.deepEqual((await readWorkbook(buf)).sheets[0].grid, [
    ['', '', '', '', ''],
    ['', '', '', '', ''],
    ['', '', '', 'D3', ''],
    ['A4', '', '', '', ''],
    ['', '', '', '', ''],
    ['', '', '', '', 'E6'],
  ]);
});

test('readWorkbook: sheets come back in workbook order with their names exactly, trailing space and all', async () => {
  const buf = await bufferOf((wb) => {
    put(wb.addWorksheet('GENERAL DATA '), [['PERSON']]);
    wb.addWorksheet('Empty');
    put(wb.addWorksheet('New data '), [['x', 'y']]);
  });
  const { sheets } = await readWorkbook(buf);
  assert.deepEqual(sheets.map((s) => s.name), ['GENERAL DATA ', 'Empty', 'New data ']);
  assert.deepEqual(sheets.map((s) => s.grid), [[['PERSON']], [], [['x', 'y']]]);
});

// ── readWorkbook {formulas:true} (ruling T4-f) ────────────────────────

test('readWorkbook {formulas:true}: the formula text of each formula cell, "" elsewhere, in the grid\'s own shape', async () => {
  const buf = await bufferOf((wb) => {
    put(wb.addWorksheet('July'), [
      ['BASIC', 'HOLIDAY', 'NOTE', 'JOINED'],
      [20150, { formula: 'G5/30.5*1.5', result: 990.98 }, 'typed', { formula: '"a"&"b"', result: 'ab' }],
      [14300, 4000, undefined, { formula: '1+1' }],                       // a typed holiday; a formula nobody has calculated
      [5, { formula: '=A4*2', result: 10 }],                              // a formula written with its '='
    ]);
  });
  const plain = (await readWorkbook(buf)).sheets[0];
  const withFormulas = (await readWorkbook(buf, { formulas: true })).sheets[0];
  assert.deepEqual(Object.keys(plain), ['name', 'grid']);                                 // the default is unchanged: no formulas key
  assert.deepEqual(Object.keys((await readWorkbook(buf, { formulas: false })).sheets[0]), ['name', 'grid']);
  assert.deepEqual(Object.keys(withFormulas).sort(), ['formulas', 'grid', 'name']);
  assert.deepEqual(withFormulas.grid, plain.grid);                                        // asking for formulas does not change the grid
  assert.deepEqual(withFormulas.grid, [
    ['BASIC', 'HOLIDAY', 'NOTE', 'JOINED'],
    ['20150', '990.98', 'typed', 'ab'],
    ['14300', '4000', '', ''],
    ['5', '10', '', ''],
  ]);
  assert.deepEqual(withFormulas.formulas, [
    ['', '', '', ''],
    ['', 'G5/30.5*1.5', '', '"a"&"b"'],                                                  // no leading '='; a constant is ''
    ['', '', '', '1+1'],                                                                  // reported even with no cached result
    ['', 'A4*2', '', ''],                                                                 // one leading '=' dropped
  ]);
});

test('readWorkbook {formulas:true}: cells that share a formula each report their own translated formula', async () => {
  const buf = await bufferOf((wb) => {
    put(wb.addWorksheet('Shared'), [
      [5, { formula: 'A1*2', result: 10 }, { formula: '$A$1+A1', result: 10 }],
      [6, { sharedFormula: 'B1', result: 12 }, { sharedFormula: 'C1', result: 11 }],
      [7, { sharedFormula: 'B1', result: 14 }, { sharedFormula: 'C1', result: 12 }],
    ]);
  });
  const { grid, formulas } = (await readWorkbook(buf, { formulas: true })).sheets[0];
  assert.deepEqual(grid, [['5', '10', '10'], ['6', '12', '11'], ['7', '14', '12']]);        // cached results, as ever
  assert.deepEqual(formulas, [
    ['', 'A1*2', '$A$1+A1'],
    ['', 'A2*2', '$A$1+A2'],                                                                // the master's formula slid down a row; $A$1 stayed put
    ['', 'A3*2', '$A$1+A3'],
  ]);
});

test('readWorkbook {formulas:true}: formulas has exactly the grid\'s rows and width, however ragged the sheet', async () => {
  const buf = await bufferOf((wb) => {
    const ws = wb.addWorksheet('Ragged');
    put(ws, [[undefined, undefined, 'top'], [], [{ formula: 'C1', result: 'top' }]]);
    ws.getCell('H5').value = { formula: '1+1' };                  // shows nothing, past the last text cell and the last row
  });
  const { grid, formulas } = (await readWorkbook(buf, { formulas: true })).sheets[0];
  assert.deepEqual(grid, [['', '', 'top'], ['', '', ''], ['top', '', '']]);
  assert.deepEqual(formulas, [['', '', ''], ['', '', ''], ['C1', '', '']]);                  // same 3 x 3, so the H5 formula is not reported
  const empty = (await readWorkbook(await bufferOf((wb) => wb.addWorksheet('Empty')), { formulas: true })).sheets[0];
  assert.deepEqual([empty.grid, empty.formulas], [[], []]);
});

// ── Ruling T4-g: exceljs is loaded when a workbook is read, not when the module is imported ──
// app.js imports every route eagerly, so a top-level import here would add exceljs's load time to every cold start
// of the whole ERP. routes/orders.js loads it lazily with a literal specifier, which the Vercel bundler keeps.

test('import-parse.js imports exceljs lazily, with a literal specifier, and not at the top of the module', () => {
  const file = fileURLToPath(new URL('./hr/import-parse.js', import.meta.url));
  const code = fs.readFileSync(file, 'utf8').split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /^\s*import\b[^;]*['"]exceljs['"]/m, 'no static import of exceljs');
  assert.match(code, /await import\('exceljs'\)/, 'a dynamic import with a literal specifier');
});

// The method: a fresh child process, so nothing this test file has loaded can hide it. exceljs is CommonJS, and
// everything a CommonJS package loads lands in require.cache, which createRequire(...).cache exposes to ESM code.
// (process.moduleLoadList only lists Node's own internal modules, so it cannot show a package; the ESM loader keeps its
// module map private.) The child reports require.cache holding exceljs at four points; the last is the positive
// control, so a detection that saw nothing at all could not pass.
test('importing import-parse.js does not load exceljs, and the pure parts work without it; the first readWorkbook loads it', async () => {
  const moduleUrl = new URL('./hr/import-parse.js', import.meta.url).href;
  const script = `
    import { createRequire } from 'node:module';
    const cache = createRequire(import.meta.url).cache;
    const loaded = () => Object.keys(cache).some((file) => /[\\\\/]node_modules[\\\\/]exceljs[\\\\/]/.test(file));
    const seen = { atStart: loaded() };
    const m = await import(${JSON.stringify(moduleUrl)});
    seen.afterImport = loaded();
    const rows = m.extractRows([['PERSON', 'OT'], ['Alpha', '5']], 0, m.autoMap(['PERSON', 'OT']).map, { blankZero: {}, daysInMonth: 31 });
    seen.pureWorks = m.FIELDS.length === 19 && m.normHeader(' ot ') === 'OT' && rows.length === 1 && rows[0].fields.ot_hours === '5'
      && m.detectHeader([['PERSON', 'OT', 'AB']]).headerRow === 0 && m.pickSheet([]) === null;
    seen.afterPureParts = loaded();
    await m.readWorkbook(Buffer.from('not a workbook')).catch(() => {});
    seen.afterReadWorkbook = loaded();
    console.log(JSON.stringify(seen));
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 60000 });
  assert.deepEqual(JSON.parse(stdout), { atStart: false, afterImport: false, pureWorks: true, afterPureParts: false, afterReadWorkbook: true });
});

test('readWorkbook: something that is not a workbook is refused, not guessed at', async () => {
  await assert.rejects(readWorkbook(Buffer.from('this is not an xlsx file')));
});

test('readWorkbook: a stray value far from the data is refused, not turned into a grid that exhausts the server', async () => {
  const buf = await bufferOf((wb) => {
    const ws = wb.addWorksheet('Stray');
    put(ws, [['PERSON', 'OT'], ['Alpha', 5]]);
    ws.getCell('Z200000').value = 'x';                                      // 200,000 rows by 26 columns
  });
  await assert.rejects(readWorkbook(buf), /Sheet "Stray" is too large to read \(200000 rows by 26 columns\)/);
});

test('readWorkbook: a sheet of a few thousand rows is nowhere near the size limit', async () => {
  const buf = await bufferOf((wb) => {
    const ws = wb.addWorksheet('Big');
    put(ws, Array.from({ length: 1500 }, (_, r) => Array.from({ length: 40 }, (_, c) => `r${r + 1}c${c + 1}`)));
  });
  const { grid } = (await readWorkbook(buf)).sheets[0];
  assert.equal(grid.length, 1500);
  assert.ok(grid.every((row) => row.length === 40));
  assert.equal(grid[1499][39], 'r1500c40');
});

// ── detectHeader ──────────────────────────────────────────────────────

const HEAD3 = ['PERSON', 'CODE NO.', 'OT'];                        // three known headers
const filler = (n) => Array.from({ length: n }, () => ['', 'some note']);

test('detectHeader: the first row among the first 15 with three or more known headers', () => {
  assert.deepEqual(detectHeader([['MONTH'], HEAD3]), { headerRow: 1, headers: HEAD3 });
  assert.deepEqual(detectHeader([...filler(14), HEAD3]), { headerRow: 14, headers: HEAD3 });   // the 15th row counts
  assert.equal(detectHeader([...filler(15), HEAD3]), null);                                    // the 16th does not
});

test('detectHeader: fewer than three known headers is not a header row', () => {
  assert.equal(detectHeader([['PERSON', 'OT', 'something else']]), null);
  assert.equal(detectHeader([['PERSON', 'OT', 'AB']]).headerRow, 0);
});

test('detectHeader: the first qualifying row wins, even when a later one knows more headers', () => {
  const later = ['PERSON', 'CODE NO.', 'OT', 'AB', 'ADVANCE'];
  assert.equal(detectHeader([['PERSON', 'OT', 'AB'], later]).headerRow, 0);
});

test('detectHeader: case, spaces, NBSP and a trailing dot do not matter; a lookalike is not a header', () => {
  assert.equal(detectHeader([['  person' + NBSP, 'Code No', 'ot.']]).headerRow, 0);
  assert.equal(detectHeader([['NAME OF PERSON', 'OTHER', 'ABSENTEE', 'ADVANCE GIVEN']]), null);
});

test('detectHeader: headers is a copy, so editing it cannot change the grid', () => {
  const grid = [HEAD3.slice()];
  const found = detectHeader(grid);
  found.headers[0] = 'CHANGED';
  assert.equal(grid[0][0], 'PERSON');
});

test('detectHeader: nothing to read is null, not a crash', () => {
  assert.equal(detectHeader(undefined), null);
  assert.equal(detectHeader([]), null);
  assert.equal(detectHeader([[], ['']]), null);
  assert.equal(detectHeader([undefined, HEAD3]).headerRow, 1);       // a hole in a hand-made grid
});

// ── pickSheet ─────────────────────────────────────────────────────────

test('pickSheet: the sheet whose header knows the most columns; a tie goes to the earlier sheet', () => {
  const five = ['PERSON', 'CODE NO.', 'OT', 'AB', 'ADVANCE'];
  const picked = pickSheet([
    { name: 'Notes', grid: [['just a note']] },
    { name: 'Weak', grid: [HEAD3] },
    { name: 'Strong', grid: [['title'], five] },
    { name: 'Tie', grid: [five] },
  ]);
  assert.deepEqual(picked, { name: 'Strong', headerRow: 1, headers: five });
});

test('pickSheet: no sheet with a header row is null', () => {
  assert.equal(pickSheet([{ name: 'Notes', grid: [['hello', 'there']] }, { name: 'Empty', grid: [] }]), null);
  assert.equal(pickSheet([]), null);
});

// ── autoMap ───────────────────────────────────────────────────────────

test('autoMap: unmapped lists the columns with a header nobody recognised; blank headers are not listed', () => {
  const { map, unmapped } = autoMap(['SR', 'PERSON', '', 'OT', 'EXTRA']);
  assert.deepEqual(map, { name: 1, ot_hours: 3 });
  assert.deepEqual(unmapped, [0, 4]);
});

test('ruling T4-b: a header matches its exact text only, so CODE NO. 2 is not the code column', () => {
  const second = autoMap(['PERSON', 'CODE NO. 2', 'OT', 'AB']);
  assert.equal(second.map.code, undefined);
  assert.deepEqual(second.unmapped, [1]);
  // the real code column is found wherever it sits, with or without a CODE NO. 2 beside it
  assert.equal(autoMap(['PERSON', 'CODE NO. 2', 'CODE NO.']).map.code, 2);
  assert.equal(autoMap(['PERSON', 'CODE NO.', 'CODE NO. 2']).map.code, 1);
  // CODE 2 is the listed pay-channel header, which is a different thing
  assert.equal(autoMap(['PERSON', 'CODE 2']).map.pay_channel, 1);
});

test('ruling T4-b: no prefix or likeness matching for headers', () => {
  const { map, unmapped } = autoMap(['NAME OF PERSON', 'OTHER', 'ABSENTEE', 'ADVANCE GIVEN', 'OT HOURS WORKED', 'REMARKS ON PAY', 'HOUR']);
  assert.deepEqual(map, {});
  assert.deepEqual(unmapped, [0, 1, 2, 3, 4, 5, 6]);
});

test('ruling T4-b: a header repeated further right (a second block) maps its leftmost column only', () => {
  const headers = ['PERSON', 'CODE NO.', 'OT', 'AB', '', 'PERSON', 'CODE NO. 2', 'OT', 'AB'];
  const { map, unmapped, signature } = autoMap(headers);
  assert.deepEqual(map, { name: 0, code: 1, ot_hours: 2, absent_days: 3 });
  assert.deepEqual(unmapped, [5, 6, 7, 8]);                         // the second block is left unused, not guessed at
  assert.equal(signature, 'PERSON|CODE NO.|OT|AB||PERSON|CODE NO. 2|OT|AB');
  // and two synonyms of one field: whichever is leftmost
  assert.deepEqual(autoMap(['ADV', 'ADVANCE']).map, { advance_given: 0 });
  assert.deepEqual(autoMap(['ADVANCE', 'ADV']).unmapped, [1]);
});

test('autoMap: the signature is the normalised headers joined by |, and survives trailing blank columns', () => {
  assert.equal(autoMap(['Person ', ' ot', 'Ab.']).signature, 'PERSON|OT|AB.');
  assert.equal(autoMap(['PERSON', '', 'OT']).signature, 'PERSON||OT');               // a gap in the middle is part of the layout
  assert.equal(autoMap(['PERSON', 'OT', '', '']).signature, autoMap(['PERSON', 'OT']).signature);
  assert.notEqual(autoMap(['PERSON', 'OT']).signature, autoMap(['PERSON', 'AB']).signature);
  assert.equal(autoMap([]).signature, '');
  // a hand-made header array with holes: a hole is a blank header
  const sparse = autoMap(['PERSON', , 'OT', , ]);                                      // eslint-disable-line no-sparse-arrays
  assert.equal(sparse.signature, 'PERSON||OT');
  assert.deepEqual(sparse.map, { name: 0, ot_hours: 2 });
  assert.deepEqual(sparse.unmapped, []);
});

test('autoMap: a stray note typed far to the right in one month does not change the saved-map signature', async () => {
  const month = (extra) => bufferOf((wb) => {
    const ws = wb.addWorksheet('Month');
    put(ws, [['PERSON', 'OT', 'AB'], ['Alpha', 5, 1]]);
    if (extra) ws.getCell('H2').value = 'remember to check';
  });
  const sig = async (buf) => autoMap(pickSheet((await readWorkbook(buf)).sheets).headers).signature;
  const a = await readWorkbook(await month(false));
  const b = await readWorkbook(await month(true));
  assert.equal(a.sheets[0].grid[0].length, 3);
  assert.equal(b.sheets[0].grid[0].length, 8);                                       // the wider sheet pads the header row
  assert.equal(await sig(await month(true)), await sig(await month(false)));
  assert.equal(await sig(await month(false)), 'PERSON|OT|AB');
});

// ── extractRows: what a row is ────────────────────────────────────────

test('extractRows: row_no is the 1-based Excel row; a row with no name, no code and nothing else is skipped', () => {
  const grid = [['x'], ['NAME', 'CODE', 'OT'], ['', '', ''], ['Alpha', '', ''], ['  ', ' ', ''], ['', '31', ''], ['Beta', '32', '1']];
  const rows = extractRows(grid, 1, { name: 0, code: 1, ot_hours: 2 }, { blankZero: {}, daysInMonth: 31 });
  assert.deepEqual(rows.map((r) => r.row_no), [4, 6, 7]);                            // name only, code only, both
  assert.deepEqual(rows.map((r) => [r.fields.name, r.fields.code]), [['Alpha', null], [null, '31'], ['Beta', '32']]);
  assert.deepEqual(rows.map((r) => r.issues), [[], [], []]);                          // a name or a code is enough
});

test('extractRows: with no name or code column to identify anyone, every row with figures is flagged, none dropped', () => {
  const rows = extractRows([['OT'], ['5'], [''], ['7']], 0, { ot_hours: 0 }, { blankZero: {}, daysInMonth: 31 });
  assert.deepEqual(rows.map((r) => r.row_no), [2, 4]);
  for (const row of rows) assert.deepEqual(triples(row.issues), [['error', 'NO_NAME_OR_CODE', null]]);
  assert.deepEqual(extractRows([['NAME', 'OT']], 0, { name: 0, ot_hours: 1 }, { blankZero: {}, daysInMonth: 31 }), []);  // header only
});

// ── Ruling T4-d: a row with figures but nobody to give them to ────────

// Header NAME, CODE, OT, AB, REMARKS, DEPT; "blank counts as 0" is ticked for OT and AB.
const T4D_MAP = { name: 0, code: 1, ot_hours: 2, absent_days: 3, remarks: 4, department: 5 };
const T4D_OPTS = { blankZero: { ot_hours: true, absent_days: true }, daysInMonth: 31 };
const t4d = (...rows) => extractRows([['NAME', 'CODE', 'OT', 'AB', 'REMARKS', 'DEPT'], ...rows], 0, T4D_MAP, T4D_OPTS);

test('ruling T4-d: a row with figures but no name and no code is returned, with an error the operator must clear', () => {
  const rows = t4d(['', '', '5', '', 'check this', 'Cutting']);
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.row_no, 2);
  assert.deepEqual(row.fields, { name: null, code: null, ot_hours: '5', absent_days: '0', remarks: 'check this', department: 'Cutting' });
  assert.deepEqual(triples(row.issues), [['error', 'NO_NAME_OR_CODE', null]]);
  assert.deepEqual(Object.keys(row.issues[0]).sort(), ['code', 'field', 'level', 'message']);
  assert.equal(row.issues[0].field, null);
  assert.match(row.issues[0].message, /name or code/i);
});

test('ruling T4-d: any non-blank number cell counts as figures, even one that is not a number', () => {
  const [text] = t4d(['', '', '', 'abc', '', '']);
  assert.deepEqual(triples(text.issues), [['error', 'NO_NAME_OR_CODE', null], ['error', 'NOT_A_NUMBER', 'absent_days']]);  // the row's own error first
  assert.equal(text.fields.absent_days, null);
  const [negative] = t4d(['', '', '-1', '', '', '']);
  assert.deepEqual(triples(negative.issues), [['error', 'NO_NAME_OR_CODE', null], ['error', 'NEGATIVE', 'ot_hours']]);
  const [zero] = t4d(['', '', '0', '', '', '']);                                       // a typed 0 is a figure
  assert.deepEqual(triples(zero.issues), [['error', 'NO_NAME_OR_CODE', null]]);
});

test('ruling T4-d: a row with nothing to give anyone is still skipped: blank, text or info cells only, or a blank-as-0 column', () => {
  assert.deepEqual(t4d(
    ['', '', '', '', '', ''],                                  // fully blank (and OT and AB are ticked "blank counts as 0", which is not a figure)
    ['  ', ' ', ' ', '  ', '', ''],                            // spaces only
    ['', '', '', '', 'a note on its own', ''],                  // text only: remarks
    ['', '', '', '', '', 'Cutting'],                            // text only: an info column (department)
  ), []);
  const info = extractRows([['NAME', 'OT', 'FIRM', 'MODE'], ['', '', 'Firm One', 'Bank']], 0,
    { name: 0, ot_hours: 1, firm: 2, pay_channel: 3 }, T4D_OPTS);
  assert.deepEqual(info, []);                                                          // firm and pay channel are info cells too
  const unmapped = extractRows([['NAME', 'OT', 'EXTRA'], ['', '', '9']], 0, { name: 0, ot_hours: 1 }, T4D_OPTS);
  assert.deepEqual(unmapped, []);                                                      // a figure in a column nobody mapped is not read
});

test('ruling T4-d: a name or a code is enough to be a row, with no NO_NAME_OR_CODE', () => {
  const rows = t4d(['Alpha', '', '5', '', '', ''], ['', '31', '5', '', '', ''], ['Beta', '32', '', '', '', '']);
  assert.equal(rows.length, 3);
  for (const row of rows) assert.deepEqual(row.issues, []);
});

test('ruling T4-d: a code cell that is only a dash reads as no code', () => {
  const rows = t4d(
    ['Alpha', '-', '1', '', '', ''],                           // a name with a dash for a code: a row, code null
    ['Beta', ' — ', '2', '', '', ''],                          // an em dash, spaces around it
    ['', '-', '3', '', '', ''],                                // no name, no code, figures: flagged
    ['', '—', '', '', '', ''],                                 // no name, no code, no figures: skipped
    ['Gamma', '--', '4', '', '', ''],                          // only a single hyphen or em dash is a placeholder
    ['Delta', '0', '5', '', '', ''],                           // and 0 is a code like any other
    ['-', '31', '6', '', '', ''],                              // the rule is for the code column only
  );
  assert.deepEqual(rows.map((r) => r.row_no), [2, 3, 4, 6, 7, 8]);
  assert.deepEqual(rows.map((r) => [r.fields.name, r.fields.code]),
    [['Alpha', null], ['Beta', null], [null, null], ['Gamma', '--'], ['Delta', '0'], ['-', '31']]);
  assert.deepEqual(rows.map((r) => triples(r.issues)), [[], [], [['error', 'NO_NAME_OR_CODE', null]], [], [], []]);
});

test('extractRows: a map entry that is not a column index means the column is not in the file', () => {
  // A saved map (JSON) can hold null for a field the user cleared. That must not read column 0 or turn into a 0.
  const map = { name: 0, ot_hours: null, absent_days: -1, advance_given: undefined, misc_earning: 1.5, bonus: '1', bill_amount: NaN };
  const rows = extractRows([['NAME', 'OT'], ['Alpha', '7']], 0, map,
    { blankZero: { ot_hours: true, absent_days: true, advance_given: true, misc_earning: true, bonus: true, bill_amount: true }, daysInMonth: 31 });
  assert.deepEqual(rows[0].fields, { name: 'Alpha' });
  assert.deepEqual(rows[0].issues, []);
  assert.deepEqual(extractRows([['NAME'], ['Alpha']], 0, undefined, { blankZero: {}, daysInMonth: 31 }), []);
});

test('extractRows: raw is a copy of the whole row, every column, so a stored row can be re-mapped or exported', () => {
  const grid = [['NAME', 'OT', 'EXTRA'], ['Alpha', '5', 'note'], ['Beta', 'x']];
  const rows = extractRows(grid, 0, { name: 0, ot_hours: 1 }, { blankZero: {}, daysInMonth: 31 });
  assert.deepEqual(rows[0].raw, ['Alpha', '5', 'note']);
  assert.deepEqual(rows[1].raw, ['Beta', 'x']);                                      // as long as the row itself
  assert.notEqual(rows[0].raw, grid[1]);                                              // a copy: editing it leaves the grid alone
});

test('extractRows: fields holds the mapped columns only, so an absent column is never turned into a 0', () => {
  const rows = extractRows([['NAME', 'OT'], ['Alpha', '']], 0, { name: 0, ot_hours: 1 },
    { blankZero: { ot_hours: true, advance_given: true, absent_days: true }, daysInMonth: 31 });
  assert.deepEqual(rows[0].fields, { name: 'Alpha', ot_hours: '0' });                // no advance_given: that column is not in the file
});

test('extractRows: text and code fields keep the trimmed text; a blank is null whatever blankZero says', () => {
  const grid = [['NAME', 'CODE', 'REMARKS', 'DEPT'], [' Alpha  Kumar ', ' 030 ', '  ', 'Cutting'], ['Beta', 31, null, undefined]];
  const rows = extractRows(grid, 0, { name: 0, code: 1, remarks: 2, department: 3 },
    { blankZero: { name: true, code: true, remarks: true, department: true }, daysInMonth: 31 });
  assert.deepEqual(rows[0].fields, { name: 'Alpha  Kumar', code: '030', remarks: null, department: 'Cutting' });  // '030' stays as typed
  assert.deepEqual(rows[1].fields, { name: 'Beta', code: '31', remarks: null, department: null });
});

test('extractRows: every optional number column reads the same way, and info columns are read as text', () => {
  const keys = ['paid_leave_days', 'hours_worked', 'misc_deduction', 'bonus', 'holiday_override', 'loan_recovery_override',
    'advance_recovery_override', 'paid_separately'];
  const head = ['NAME', ...keys, 'FIRM', 'MODE'];
  const map = Object.fromEntries([['name', 0], ...keys.map((k, i) => [k, i + 1]), ['firm', keys.length + 1], ['pay_channel', keys.length + 2]]);
  const [row] = extractRows([head, ['Alpha', '1', '2.5', '3', '4', '5', '6', '7', '8', 'Firm One', 'Bank']], 0, map, { blankZero: {}, daysInMonth: 31 });
  assert.deepEqual(row.fields, {
    name: 'Alpha', paid_leave_days: '1', hours_worked: '2.5', misc_deduction: '3', bonus: '4', holiday_override: '5',
    loan_recovery_override: '6', advance_recovery_override: '7', paid_separately: '8', firm: 'Firm One', pay_channel: 'Bank',
  });
  assert.deepEqual(row.issues, []);
});

// ── extractRows: numbers ──────────────────────────────────────────────

test('numbers are kept exactly, as the shortest exact decimal text', () => {
  for (const [text, want] of [['86.370', '86.37'], ['0.1', '0.1'], ['12.5', '12.5'], ['0', '0'], ['00012', '12'], ['.5', '0.5'], ['100.500', '100.5']]) {
    const r = advance(text);
    assert.equal(r.fields.advance_given, want, text);
    assert.deepEqual(r.issues, [], text);
  }
  // More places than the column stores: the value is still kept exactly, and the cell is warned about (ruling T4-i).
  for (const [text, want] of [['7000.000000000001', '7000.000000000001'], ['0.30000000000000004', '0.30000000000000004'], ['100.555', '100.555']]) {
    const r = advance(text);
    assert.equal(r.fields.advance_given, want, text);
    assert.deepEqual(triples(r.issues), [['warn', 'MORE_DECIMALS_THAN_STORED', 'advance_given']], text);
  }
  const zero = advance('-0');
  assert.equal(zero.fields.advance_given, '0');                                      // never "-0", and not negative
  assert.deepEqual(zero.issues, []);
});

test('ruling T4-a: text with commas is a number only when it is grouped like one', () => {
  // Indian grouping (1,00,000) and Western grouping (1,000,000), with or without decimals, ₹, Rs, spaces or a sign.
  for (const [text, want] of [['1,00,000', '100000'], ['10,000', '10000'], ['1,000', '1000'], ['12,34,567.89', '1234567.89'],
    ['1,23,45,678', '12345678'], ['1,234,567', '1234567'], ['100,000', '100000'], ['1,000,000.5', '1000000.5'],
    ['₹ 1,00,000', '100000'], ['₹5,000', '5000'], ['Rs. 5,000', '5000'], ['rs 5,000.50', '5000.5'], [' 5,000 ', '5000'], ['+5,000', '5000']]) {
    const r = advance(text);
    assert.equal(r.fields.advance_given, want, text);
    assert.deepEqual(r.issues, [], text);
  }
});

test('ruling T4-a: a comma anywhere else is NOT_A_NUMBER, never a quiet 25', () => {
  for (const text of ['2,5', '1,0000', '12,3456', '1,23,456,789', '5,', ',5', '1,,000', '1,000,', '0,5', '25,5', '1,000.', '1,000e3',
    '1,00,0000', '₹ 2,5', '1.000,50', '1,000.5.5', '- ,500']) {
    const r = advance(text);
    assert.equal(r.fields.advance_given, null, text);
    assert.deepEqual(triples(r.issues), [['error', 'NOT_A_NUMBER', 'advance_given']], text);
  }
});

test('ruling T4-a: a grouped negative is still negative, with its value kept', () => {
  const r = advance('-1,00,000');
  assert.equal(r.fields.advance_given, '-100000');
  assert.deepEqual(triples(r.issues), [['error', 'NEGATIVE', 'advance_given']]);
});

test('ruling T4-c: whitespace between digits is NOT_A_NUMBER, never a quiet 25 or 1000', () => {
  for (const text of ['2 5', '1 000', '10 000.5', '1 ,000', '1,00 000', '5 .5', '5. 5', '1 e3', '1' + NBSP + '000', '₹ 1 000', 'Rs. 2 5']) {
    const r = advance(text);
    assert.equal(r.fields.advance_given, null, JSON.stringify(text));
    assert.deepEqual(triples(r.issues), [['error', 'NOT_A_NUMBER', 'advance_given']], JSON.stringify(text));
  }
});

test('ruling T4-c: nothing else may sit inside the number: not a space after the sign, not a currency between digits', () => {
  for (const text of ['- 5', '+ 5', '5Rs5', '5 Rs 5', '5₹5', '₹₹5', 'Rs. Rs. 5']) {
    const r = advance(text);
    assert.equal(r.fields.advance_given, null, JSON.stringify(text));
    assert.deepEqual(triples(r.issues), [['error', 'NOT_A_NUMBER', 'advance_given']], JSON.stringify(text));
  }
});

test('ruling T4-c: spaces around the number, or between the currency and the digits, are fine', () => {
  for (const [text, want] of [[' 86.37 ', '86.37'], ['₹ 5,000', '5000'], ['₹   5,000', '5000'], ['  ₹5,000  ', '5000'], ['Rs. 5,000', '5000'],
    ['Rs 5000', '5000'], ['rs. 1,00,000.50', '100000.5'], ['5,000 Rs', '5000'], ['5,000 ₹', '5000'], ['5000 Rs.', '5000']]) {
    const r = advance(text);
    assert.equal(r.fields.advance_given, want, JSON.stringify(text));
    assert.deepEqual(r.issues, [], JSON.stringify(text));
  }
  for (const text of ['-₹ 5,000', '- ₹5,000', '₹ -5,000', 'Rs. -5,000']) {                  // a sign and a currency together: still a negative
    const r = advance(text);
    assert.equal(r.fields.advance_given, '-5000', JSON.stringify(text));
    assert.deepEqual(triples(r.issues), [['error', 'NEGATIVE', 'advance_given']], JSON.stringify(text));
  }
});

test('anything that does not read as a number is NOT_A_NUMBER, and its value is null', () => {
  for (const text of ['abc', '12 hrs', '50%', '(500)', '1.2.3', '--5', '5-', 'Rs', '₹', '.', 'e5', '1e', 'NaN', 'Infinity', '0x10', '#ERR',
    'TRUE', '2026-02-05', '1e999999999', 'five', '1/2']) {
    const r = advance(text);
    assert.equal(r.fields.advance_given, null, text);
    assert.deepEqual(triples(r.issues), [['error', 'NOT_A_NUMBER', 'advance_given']], text);
  }
});

test('an unreadable cell never becomes 0, even in a column ticked "blank counts as 0"', () => {
  const [row] = extract([['NAME', 'OT', 'AB'], ['x', 'abc', '']], { name: 0, ot_hours: 1, absent_days: 2 }, { blankZero: { ot_hours: true, absent_days: true }, daysInMonth: 31 });
  assert.equal(row.fields.ot_hours, null);
  assert.equal(row.fields.absent_days, '0');
});

test('a very long run of digits is refused quickly instead of stalling the server', () => {
  const started = performance.now();
  const r = advance('1'.repeat(100000) + 'x');
  assert.deepEqual(triples(r.issues), [['error', 'NOT_A_NUMBER', 'advance_given']]);
  assert.ok(performance.now() - started < 1500, 'a 100,000-character cell must not be run through the number reader');
});

test('blank means null, or 0 only where blankZero ticks that field', () => {
  const grid = [['NAME', 'OT', 'AB', 'MISC.', 'ADVANCE'], ['x', '', ' ', null, undefined]];
  const map = { name: 0, ot_hours: 1, absent_days: 2, misc_earning: 3, advance_given: 4 };
  const [ticked] = extract(grid, map, { blankZero: { ot_hours: true, advance_given: true }, daysInMonth: 31 });
  assert.deepEqual(ticked.fields, { name: 'x', ot_hours: '0', absent_days: null, misc_earning: null, advance_given: '0' });
  assert.deepEqual(ticked.issues, []);
  const [none] = extract(grid, map, { blankZero: {}, daysInMonth: 31 });
  assert.deepEqual(none.fields, { name: 'x', ot_hours: null, absent_days: null, misc_earning: null, advance_given: null });
  const [omitted] = extractRows(grid, 0, map, {});                                  // no options at all: nothing is ticked
  assert.equal(omitted.fields.ot_hours, null);
  const [nothing] = extractRows(grid, 0, map);
  assert.equal(nothing.fields.advance_given, null);
});

// ── Ruling T4-h: magnitudes ───────────────────────────────────────────

test('ruling T4-h: a typed exponent is NOT_A_NUMBER, however small or large', () => {
  for (const text of ['1e999', '1e-3', '2E5', '1e-999', '1e3', '1.5e-7', '1E+3', '5e0', '.5e1', 'Rs. 1e3', '1e3 Rs', '1e-9999999999', '1e999999999', '1e']) {
    const r = advance(text);
    assert.equal(r.fields.advance_given, null, text);
    assert.deepEqual(triples(r.issues), [['error', 'NOT_A_NUMBER', 'advance_given']], text);
  }
});

test('ruling T4-h: a value above 9,999,999,999.99 is TOO_LARGE, either sign, and its value is kept', () => {
  for (const [text, kept] of [['10000000000', '10000000000'], ['9999999999.991', '9999999999.991'], ['12345678901.5', '12345678901.5'],
    ['-10000000000', '-10000000000'], ['99999999999999', '99999999999999'], ['10,00,00,00,000', '10000000000'], ['₹ 10,000,000,000', '10000000000']]) {
    const r = advance(text);
    assert.deepEqual(triples(r.issues), [['error', 'TOO_LARGE', 'advance_given']], text);   // that one error: a huge negative is not also NEGATIVE
    assert.equal(r.fields.advance_given, kept, text);
  }
  assert.match(advance('10000000000').issues[0].message, /too large/i);
  assert.match(advance('10000000000').issues[0].message, /ADVANCE/);
});

test('ruling T4-h: 9,999,999,999.99 itself is fine, and every number column has the same limit', () => {
  const top = advance('9999999999.99');
  assert.equal(top.fields.advance_given, '9999999999.99');
  assert.deepEqual(top.issues, []);
  assert.deepEqual(triples(advance('-9999999999.99').issues), [['error', 'NEGATIVE', 'advance_given']]);
  for (const key of ['ot_hours', 'absent_days', 'paid_leave_days', 'hours_worked', 'bonus', 'paid_separately']) {
    const [row] = extract([['NAME', 'X'], ['x', '10000000000']], { name: 0, [key]: 1 });
    assert.deepEqual(triples(row.issues), [['error', 'TOO_LARGE', key]], key);              // for absent days, not also ABSENT_EXCEEDS_DAYS
  }
});

test('ruling T4-h: real numeric cells keep exponent support, and are held to the same limit', async () => {
  // JavaScript prints 1.5e-7 and 1e+21 with an exponent. A numeric cell must reach the grid in plain digits, or it would be
  // refused as typed exponent text.
  const buf = await bufferOf((wb) => {
    put(wb.addWorksheet('Numbers'), [
      ['PERSON', 'ADVANCE'],
      ['a', 1e12],                               // a trillion: too large
      ['b', 1.5e-7],                             // printed with an exponent
      ['c', 1e21],                               // printed with an exponent, and too large
      ['d', 2.7755575615628914e-17],             // the float noise a formula leaves where it means 0
      ['e', 1e300],                              // its plain form would be 301 digits: left as it prints, and refused
      ['f', 9999999999.99],                      // the most that can be stored
      ['g', -1.5e-7],                            // the sign survives the expansion: a tiny negative is still negative
    ]);
  });
  const { sheets } = await readWorkbook(buf);
  assert.deepEqual(sheets[0].grid.map((row) => row[1]), ['ADVANCE', '1000000000000', '0.00000015', '1' + '0'.repeat(21),
    '0.' + '0'.repeat(16) + '27755575615628914', '1e+300', '9999999999.99', '-0.00000015']);
  const rows = extractRows(sheets[0].grid, 0, { name: 0, advance_given: 1 }, { blankZero: {}, daysInMonth: 31 });
  assert.deepEqual(rows.map((r) => triples(r.issues)), [
    [['error', 'TOO_LARGE', 'advance_given']],
    [['warn', 'MORE_DECIMALS_THAN_STORED', 'advance_given']],
    [['error', 'TOO_LARGE', 'advance_given']],
    [['warn', 'MORE_DECIMALS_THAN_STORED', 'advance_given']],
    [['error', 'NOT_A_NUMBER', 'advance_given']],
    [],
    [['error', 'NEGATIVE', 'advance_given']],
  ]);
  assert.equal(rows[6].fields.advance_given, '-0.00000015');
  assert.equal(rows[1].fields.advance_given, '0.00000015');
  assert.equal(rows[3].fields.advance_given, '0.' + '0'.repeat(16) + '27755575615628914');
  assert.equal(rows[5].fields.advance_given, '9999999999.99');
});

// ── Ruling T4-i: more decimals than the column stores ─────────────────

test('ruling T4-i: money columns store 2 decimals and quantity columns 4; more is a warning, with the value kept exact', () => {
  const money = ['misc_earning', 'misc_deduction', 'bonus', 'advance_given', 'bill_amount', 'holiday_override', 'loan_recovery_override',
    'advance_recovery_override', 'paid_separately'];
  const quantity = ['ot_hours', 'paid_leave_days', 'hours_worked'];                       // absent days has its own test below
  const read = (key, text) => extract([['NAME', 'X'], ['x', text]], { name: 0, [key]: 1 })[0];
  for (const key of money) {
    assert.deepEqual(read(key, '100.55').issues, [], `${key}: 2 places`);
    const row = read(key, '100.555');
    assert.deepEqual(triples(row.issues), [['warn', 'MORE_DECIMALS_THAN_STORED', key]], `${key}: 3 places`);
    assert.equal(row.fields[key], '100.555', key);
  }
  for (const key of quantity) {
    assert.deepEqual(read(key, '85.4166').issues, [], `${key}: 4 places`);
    const row = read(key, '85.41666');
    assert.deepEqual(triples(row.issues), [['warn', 'MORE_DECIMALS_THAN_STORED', key]], `${key}: 5 places`);
    assert.equal(row.fields[key], '85.41666', key);
  }
  assert.equal(money.length + quantity.length + 1, FIELDS.filter((f) => f.kind === 'number').length);   // every number column is in one list
  const warning = advance('100.555').issues[0];                                             // the sheet's own header names the column
  assert.equal(warning.level, 'warn');
  assert.match(warning.message, /decimal/i);
  assert.match(warning.message, /ADVANCE/);
});

test('ruling T4-i: decimals are counted on the exact value, and an error is not also warned about', () => {
  const read = (key, text) => extract([['NAME', 'X'], ['x', text]], { name: 0, [key]: 1 })[0];
  assert.deepEqual(read('advance_given', '100.500').issues, []);                          // 100.5: trailing zeros are not places
  assert.deepEqual(read('ot_hours', '85.416600').issues, []);                            // 85.4166
  assert.deepEqual(triples(read('advance_given', '-5.555').issues), [['error', 'NEGATIVE', 'advance_given']]);
  assert.deepEqual(triples(read('advance_given', '10000000000.555').issues), [['error', 'TOO_LARGE', 'advance_given']]);
  // absent days: half a day is the unit, so a fraction other than .5 is already a warning; beyond 4 places it is a second one
  assert.deepEqual(triples(read('absent_days', '2.1234').issues), [['warn', 'ABSENT_NOT_HALF', 'absent_days']]);
  assert.deepEqual(triples(read('absent_days', '2.12345').issues),
    [['warn', 'ABSENT_NOT_HALF', 'absent_days'], ['warn', 'MORE_DECIMALS_THAN_STORED', 'absent_days']]);
});

// ── extractRows: the checks on number columns ─────────────────────────

test('a negative number is an error in every number column, and its value is kept', () => {
  const keys = ['ot_hours', 'absent_days', 'paid_leave_days', 'hours_worked', 'misc_earning', 'misc_deduction', 'bonus', 'advance_given',
    'bill_amount', 'holiday_override', 'loan_recovery_override', 'advance_recovery_override', 'paid_separately'];
  const map = Object.fromEntries([['name', 0], ...keys.map((k, i) => [k, i + 1])]);
  const [row] = extract([['NAME', ...keys], ['x', ...keys.map(() => '-1')]], map);
  assert.deepEqual(triples(row.issues), keys.map((k) => ['error', 'NEGATIVE', k]));    // one per column, in FIELDS order
  for (const k of keys) assert.equal(row.fields[k], '-1', k);
});

test('absent days: above the month length is an error; not a multiple of 0.5 is a warning', () => {
  const absent = (text, days = 31) => triples(extract([['NAME', 'AB'], ['x', text]], { name: 0, absent_days: 1 }, { blankZero: {}, daysInMonth: days })[0].issues);
  assert.deepEqual(absent('0'), []);
  assert.deepEqual(absent('0.5'), []);
  assert.deepEqual(absent('1'), []);
  assert.deepEqual(absent('30.5'), []);
  assert.deepEqual(absent('31'), []);                                                 // absent the whole month is allowed
  assert.deepEqual(absent('31.5'), [['error', 'ABSENT_EXCEEDS_DAYS', 'absent_days']]);
  assert.deepEqual(absent('32'), [['error', 'ABSENT_EXCEEDS_DAYS', 'absent_days']]);
  assert.deepEqual(absent('2.25'), [['warn', 'ABSENT_NOT_HALF', 'absent_days']]);
  assert.deepEqual(absent('0.1'), [['warn', 'ABSENT_NOT_HALF', 'absent_days']]);
  assert.deepEqual(absent('2.50'), []);                                               // 2.50 is 2.5
  assert.deepEqual(absent('32.25'), [['error', 'ABSENT_EXCEEDS_DAYS', 'absent_days'], ['warn', 'ABSENT_NOT_HALF', 'absent_days']]);
  assert.deepEqual(absent('-1'), [['error', 'NEGATIVE', 'absent_days']]);             // negative: that one error, nothing else
  assert.deepEqual(absent('-0.25'), [['error', 'NEGATIVE', 'absent_days']]);
});

test('absent days follow the month: 28, 29, 30 and 31 days', () => {
  const over = (text, days) => extract([['NAME', 'AB'], ['x', text]], { name: 0, absent_days: 1 }, { blankZero: {}, daysInMonth: days })[0].issues.some((i) => i.code === 'ABSENT_EXCEEDS_DAYS');
  assert.equal(over('28', 28), false);
  assert.equal(over('29', 28), true);
  assert.equal(over('29', 29), false);
  assert.equal(over('30', 30), false);
  assert.equal(over('31', 30), true);
  assert.equal(over('31', 31), false);
  assert.equal(over('31', '30'), true);                                               // a text count is read as a number
});

test('absent days with no month length given: nothing to compare against, so no ABSENT_EXCEEDS_DAYS', () => {
  const grid = [['NAME', 'AB'], ['x', '99']];
  for (const opts of [{ blankZero: {} }, { blankZero: {}, daysInMonth: undefined }, { blankZero: {}, daysInMonth: null }, { blankZero: {}, daysInMonth: 0 },
    { blankZero: {}, daysInMonth: 'many' }, undefined]) {
    assert.deepEqual(extractRows(grid, 0, { name: 0, absent_days: 1 }, opts)[0].issues, []);
  }
});

test('the absent-days checks belong to absent days only', () => {
  const [row] = extract([['NAME', 'OT', 'PL'], ['x', '99.9', '45.25']], { name: 0, ot_hours: 1, paid_leave_days: 2 });
  assert.deepEqual(row.issues, []);
});

test('an issue is {level, code, field, message} with a message that says what and where', () => {
  const [row] = extract([['NAME', 'AB', 'ADVANCE'], ['x', '32.25', 'lots']], { name: 0, absent_days: 1, advance_given: 2 });
  assert.equal(row.issues.length, 3);
  for (const issue of row.issues) {
    assert.deepEqual(Object.keys(issue).sort(), ['code', 'field', 'level', 'message']);
    assert.equal(typeof issue.message, 'string');
  }
  const [exceeds, notHalf, nan] = row.issues;                                         // FIELDS order: absent days, then advance
  assert.match(exceeds.message, /AB/);
  assert.match(exceeds.message, /32\.25/);
  assert.match(exceeds.message, /31/);
  assert.match(notHalf.message, /half/);
  assert.match(nan.message, /ADVANCE/);
  assert.match(nan.message, /lots/);
});

test('a message quotes a long cell in part only', () => {
  const [row] = extract([['NAME', 'ADVANCE'], ['x', 'z'.repeat(500)]], { name: 0, advance_given: 1 });
  assert.ok(row.issues[0].message.length < 200, `message is ${row.issues[0].message.length} characters long`);
});

// ── The whole path on real files ──────────────────────────────────────

test('Task 4 review focus: numbers typed as text, columns re-ordered, extra columns, a second header block', async () => {
  const buf = await bufferOf((wb) => {
    const ws = wb.addWorksheet('GENERAL DATA ');
    put(ws, [
      ['JULY'],
      [],
      ['SR', 'ADVANCE', 'PERSON', 'CODE NO.', 'AB', 'OT', 'NOTES FOR ME', '', 'PERSON', 'CODE NO. 2', 'AB', 'OT', 'ADVANCE'],
      [1, '₹ 5,000', 'Alpha', 130, 2, ' 86.37 ', 'x', undefined, 'Alpha', 99, 9, 99, 99],
      [2, '1,00,000', 'Beta', undefined, '2,5', 3, undefined, undefined, 'Beta', 98, 8, 98, 98],
    ]);
  });
  const { sheets } = await readWorkbook(buf);
  const picked = pickSheet(sheets);
  assert.equal(picked.name, 'GENERAL DATA ');
  assert.equal(picked.headerRow, 2);
  const { map, unmapped } = autoMap(picked.headers);
  assert.deepEqual(map, { advance_given: 1, name: 2, code: 3, absent_days: 4, ot_hours: 5 });   // the left block, wherever its columns sit
  assert.deepEqual(unmapped, [0, 6, 8, 9, 10, 11, 12]);                                          // SR, a note column, and the whole second block
  const rows = extractRows(sheets[0].grid, picked.headerRow, map, { blankZero: { ot_hours: true, absent_days: true, advance_given: true }, daysInMonth: 31 });
  assert.deepEqual(rows.map((r) => r.row_no), [4, 5]);
  assert.deepEqual(rows[0].fields, { advance_given: '5000', name: 'Alpha', code: '130', absent_days: '2', ot_hours: '86.37' });
  assert.deepEqual(rows[0].issues, []);
  assert.deepEqual(rows[1].fields, { advance_given: '100000', name: 'Beta', code: null, absent_days: null, ot_hours: '3' });
  assert.deepEqual(triples(rows[1].issues), [['error', 'NOT_A_NUMBER', 'absent_days']]);            // '2,5' is not 25
});
