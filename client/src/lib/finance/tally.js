// Tally's Excel exports, read in the browser (spec §11.1, §11.2 step 1): which column of a sheet is which, the rows
// under the header as the import takes them, and the days Tally writes. Three sheets:
//   tb        the Trial Balance with ledgers shown          → { tally_name, debit_paise, credit_paise }
//   accounts  the List of Accounts, each ledger and its group → { tally_name, tally_group } (+ gstin, when mapped)
//   bills     Bills Receivable / Payable, bill by bill        → { tally_ledger_name, bill_ref, bill_date, due_date, amount_paise, side }
// The server checks every row again (finance-import.js): this is where a cell is read, and a cell that cannot be read
// is refused with a sentence that names its ledger and what it holds, never guessed at.
//
// The steps of reading an upload, for the screen that does it (components/finance/TallyUpload.jsx), in the order they run:
//   finTallyFileProblem   is it an .xlsx at all
//   finSheetRows          the first worksheet as arrays of cell values (the one place that touches an ExcelJS worksheet)
//   finFindHeaderRow      which row is the header, below Tally's title block, and so which column is which
//   finGuessLayout        when there is no header to find: the best guess, for a person to correct (finTallyColumns names the columns)
//   finReadSheet          the rows under a layout, as the import takes them (finRowsFromSheet), or the sentence that says why not
//
// Pure ESM, no React, no DOM, no bare imports: the server tests import this file by relative path and the browser
// bundles it as written. Own-property checks are Object.prototype.hasOwnProperty.call, never Object.hasOwn: the browser
// baseline in this ERP predates it and Vite does not polyfill it (finance-wiring.test.js holds all client code to that).

import { finParseTallyAmount } from './money.js';
import { finIsValidDate } from './fy.js';

// The header names each column goes by in Tally's exports. A header cell matches an alias ignoring capitals, the spaces
// around it and how the spaces inside it run ('Closing Balance' over 'Debit' on two lines is 'Closing Balance Debit').
// Aliases are tried in order and the first that names exactly one column wins, so 'Pending Amount' is taken before a
// plain 'Amount'. This table is a starting point: when the accountant's real exports arrive (spec §11.1), a header they
// use that it misses is added here, test first.
const FIN_TALLY_ALIASES = Object.freeze({
  name: ['Particulars', 'Ledger', 'Name of Ledger', 'Account'],
  group: ['Group', 'Under', 'Parent'],
  gstin: ['GSTIN/UIN', 'GSTIN'],
  debit: ['Debit', 'Dr', 'Closing Balance Debit'],
  credit: ['Credit', 'Cr', 'Closing Balance Credit'],
  date: ['Date'],
  ref: ['Ref. No.', 'Ref No', 'Reference', 'Bill No'],
  party: ["Party's Name", 'Party Name'],
  amount: ['Pending Amount', 'Pending', 'Amount', 'Balance'],
  due: ['Due on', 'Due Date'],
});

// The columns each sheet needs, and the ones it may have (ruling R32: the List of Accounts may carry each ledger's GSTIN).
// `rows` is what a row cannot do without, when a person maps the columns by hand: a bills sheet with no due date column
// still has bills, and its due dates are nothing. Found by its headers, every column in `needs` must be there, so a
// header the aliases miss ('Bill Date') sends the sheet to a person rather than losing its dates without a word.
const FIN_TALLY_SHEETS = Object.freeze({
  tb: { needs: ['name', 'debit', 'credit'], may: [], rows: ['name', 'debit', 'credit'] },
  accounts: { needs: ['name', 'group'], may: ['gstin'], rows: ['name', 'group'] },
  bills: { needs: ['date', 'ref', 'party', 'amount', 'due'], may: [], rows: ['party', 'amount'] },
});

const finSheetOf = kind => {
  if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(FIN_TALLY_SHEETS, kind)) throw new Error(`Unknown Tally sheet "${kind}"`);
  return FIN_TALLY_SHEETS[kind];
};

// The code of the refusal below, so a caller that has a reason to step over a cell (finFindHeaderRow) can tell it from any other.
const FIN_NO_SAVED_VALUE = 'FIN_FORMULA_NO_VALUE';

// What a person does about a cell that cannot be read as a figure or as text: Excel stores a formula's result when it saves, and a column
// pasted as values holds nothing but results.
const FIN_WAYS_OUT = 'Open the file in Excel, save it, and upload the saved file, or copy the column and paste it as values.';

// A formula cell that holds no result. A program that writes a workbook without calculating it (a script, a converter) leaves the
// formula and not the figure Excel would have stored, and ExcelJS can only hand over what is stored. Reading that as blank or 0 would
// drop a balance without a word, so the cell is refused, naming the formula to find it by and what to do.
//
// A formula whose saved result is 0, '' or FALSE is refused the same way, and it is not a mistake: ExcelJS keeps a saved result only when
// it is truthy (`if (value)` in its lib/doc/cell.js), so those arrive as { formula } alone, the cell of a formula that never saved
// anything, and the two cannot be told apart. Pasting the column as values is the way out for a 0 that is real.
function finNoSavedValue(cell) {
  const formula = typeof cell.formula === 'string' ? cell.formula.trim() : '';
  const shown = formula.length > 40 ? `${formula.slice(0, 40)}…` : formula;
  return Object.assign(
    new Error(`This file has a formula${shown ? ` (=${shown})` : ''} with no saved value, so the figure it should show can't be read. ${FIN_WAYS_OUT}`),
    { code: FIN_NO_SAVED_VALUE });
}

// A value finCellValue has read and left as an object that is not a day: not text, not a number. ExcelJS hands over {} for the child of
// a shared formula whose first cell is missing from the file. Printed, it would put '[object Object]' into a ledger's name or a bill's
// reference, so it is refused, naming the cell (`where`, 'C14') and the ledger on its row, when there is one.
const finIsLeftover = value => value !== null && typeof value === 'object' && !(value instanceof Date);

function finLeftover(name, where) {
  return new Error(`${name ? `${name}: ` : ''}${where ? `cell ${where}` : 'a cell'} holds something that isn't text or a number, so it can't be read. ${FIN_WAYS_OUT}`);
}

// A cell as ExcelJS hands it over, as the value it shows. Rich text is its runs' text, joined; a hyperlink is its text; a
// formula, or a shared one, is its saved result (a formula with none is refused: finNoSavedValue); an error cell ('#N/A') is its
// text. A Date, a number, text and an empty cell are themselves. Every read of a cell in this file goes through here first.
export function finCellValue(cell) {
  if (cell === null || typeof cell !== 'object' || cell instanceof Date) return cell;
  if (Array.isArray(cell.richText)) return cell.richText.map(run => (typeof run?.text === 'string' ? run.text : '')).join('');
  if ('formula' in cell || 'sharedFormula' in cell) {
    if (cell.result === undefined || cell.result === null) throw finNoSavedValue(cell);
    return finCellValue(cell.result);
  }
  if ('text' in cell) return finCellValue(cell.text);
  if (typeof cell.error === 'string') return cell.error;
  return cell;
}

// A cell read for the row of a ledger or a party, so a refusal says whose row it is: 'Alpha Bank: This file has a formula…'. `where` is the
// cell's place on the sheet, for the refusal of a cell that is nothing to read (finLeftover). A day passes: it is a value.
function finRead(cell, name, where) {
  let value;
  try { value = finCellValue(cell); } catch (e) { throw new Error(`${name}: ${e.message}`); }
  if (finIsLeftover(value)) throw finLeftover(name, where);
  return value;
}

const finHeaderText = cell => {
  const value = finCellValue(cell);
  return (value == null ? '' : String(value)).replace(/\s+/g, ' ').trim().toLowerCase();
};

// Where a header row puts each of a sheet's columns, as { column: index }, or null when a column the sheet needs is
// missing. A column two cells answer to (two 'Debit' columns: an opening and a closing pair, say) is not guessed
// between: that is null too, and a person maps the columns by hand.
export function finDetectColumns(headerCells, kind) {
  const sheet = finSheetOf(kind);
  if (!Array.isArray(headerCells)) return null;
  const cells = headerCells.map(finHeaderText);
  const mapping = {};
  for (const column of [...sheet.needs, ...sheet.may]) {
    let at = null;
    for (const alias of FIN_TALLY_ALIASES[column]) {
      const hits = cells.flatMap((text, i) => (text === finHeaderText(alias) ? [i] : []));
      if (hits.length > 1) return null;
      if (hits.length === 1) { at = hits[0]; break; }
    }
    if (at !== null) mapping[column] = at;
    else if (sheet.needs.includes(column)) return null;
  }
  return mapping;
}

// The header row of a sheet: the first of its top `scan` rows for which finDetectColumns finds the sheet's columns, as { index, mapping }
// (index counts from 0, in `rows`), or null when none does. Tally prints the company, the report and the period above the header, so
// the header is not the first row. A row that finDetectColumns cannot place, because two of its cells answer to one column or a needed
// column is missing, is not the header and the search goes on: a sheet with no header it can place is for a person to map by hand.
export function finFindHeaderRow(rows, kind, { scan = 15 } = {}) {
  finSheetOf(kind);   // an unknown sheet is refused whatever the rows are
  const list = Array.isArray(rows) ? rows : [];
  const last = Math.min(list.length, Math.max(0, Math.floor(Number(scan)) || 0));
  for (let index = 0; index < last; index += 1) {
    let mapping;
    try {
      mapping = finDetectColumns(list[index], kind);
    } catch (e) {
      // A row holding a formula the file never calculated names nothing, so it is not a header; a title block may hold one, and it is
      // no reason to refuse the file. Any figure that IS read is refused for the same cell (finCellValue); this only keeps looking.
      if (e?.code === FIN_NO_SAVED_VALUE) continue;
      throw e;
    }
    if (mapping) return { index, mapping };
  }
  return null;
}

// A column's place on the sheet in the words of Excel: 0 is A, 25 is Z, 26 is AA. For a person choosing columns by hand.
export function finColumnLetter(index) {
  let letters = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  return letters;
}

// The words a person is shown for each column a sheet may have.
const FIN_TALLY_LABELS = Object.freeze({
  name: 'Ledger name', group: 'Group (Under)', gstin: 'GSTIN', debit: 'Debit', credit: 'Credit',
  date: 'Bill date', ref: 'Bill reference', party: 'Party name', amount: 'Pending amount', due: 'Due date',
});

// The columns of a sheet, for choosing by hand: [{ key, label, required }] in the order the sheet lists them. `required` is what a row
// cannot do without (the same list finRowsFromSheet refuses to go on without); the rest are read when chosen and are nothing when not.
export function finTallyColumns(kind) {
  const sheet = finSheetOf(kind);
  return [...sheet.needs, ...sheet.may].map(key => ({ key, label: FIN_TALLY_LABELS[key], required: sheet.rows.includes(key) }));
}

// Whether a file's name says it is an Excel .xlsx: null if so, else the sentence to give back. An .xls is the old format and the
// reader here does not take it; the way out is a save away in Excel (or in Tally's own export dialog).
export function finTallyFileProblem(name) {
  const text = typeof name === 'string' ? name.trim().toLowerCase() : '';
  if (text.endsWith('.xlsx')) return null;
  if (text.endsWith('.xls')) return 'Save the Tally export as .xlsx and upload that.';
  return "That isn't an Excel .xlsx file. Save the Tally export as .xlsx and upload that.";
}

// A worksheet that runs further than this is not a Tally report: it is a sheet formatted to the end of the world, which would be read
// into a million empty rows.
const FIN_MAX_SHEET_ROWS = 100000;
const finWithCommas = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// A worksheet (ExcelJS: eachRow and rowCount) as arrays of cell values, one array to each sheet row, so that a row's place in the
// array is its row number less one. A row the sheet does not hold is an empty array, and the asking is for the empty ones too, or
// their places would be lost. A cell is the value it shows: rich text is its text, a formula its saved result, a date stays a Date
// (finCellValue). A formula that was never calculated cannot be, so it stays as it came, and the first read of it refuses it.
export function finSheetRows(sheet) {
  if (sheet.rowCount > FIN_MAX_SHEET_ROWS) {
    throw new Error(`The sheet runs to ${finWithCommas(sheet.rowCount)} rows, which is not a Tally report. Delete the empty rows below the figures, save the file, and upload it again.`);
  }
  const rows = [];
  sheet.eachRow({ includeEmpty: true }, (row, number) => {
    const cells = Array.isArray(row.values) ? row.values.slice(1) : [];   // ExcelJS counts a row's cells from 1
    rows[number - 1] = cells.map(cell => { try { return finCellValue(cell); } catch { return cell; } });
  });
  for (let i = 0; i < rows.length; i += 1) rows[i] ??= [];
  return rows;
}

// A cell as the screen's preview shows it, a short text: a day as a day (the UTC day, as finTallyDate reads it), nothing for a blank,
// the saved value of a formula, and a note, not a fault, for a formula with none and for a cell that is nothing to read. The preview shows
// a sheet BEFORE anything in it is read as an amount, so it must never throw.
export function finCellShown(cell) {
  let value;
  try { value = finCellValue(cell); } catch { return '(formula, no saved value)'; }
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
  if (finIsLeftover(value)) return '(unreadable cell)';
  const text = String(value).trim();
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

// A guess at how a sheet is laid out when its header row cannot be found as one row (a two-row header, a column Tally names in a way
// the aliases miss), for the person who now maps it by hand to correct: { mapping, first }, `first` being the row the figures start on
// (counting from 0, in `rows`). Every header word in the top `scan` rows is looked for as finDetectColumns looks for it, the first
// alias that names exactly one cell winning; a column two cells answer to, or none, is left unmapped. The figures start under the
// lowest row that names a column, or on the first row if none does.
export function finGuessLayout(rows, kind, { scan = 15 } = {}) {
  const sheet = finSheetOf(kind);
  const cells = [];
  (Array.isArray(rows) ? rows : []).slice(0, Math.max(0, Math.floor(Number(scan)) || 0)).forEach((row, at) => {
    if (!Array.isArray(row)) return;
    row.forEach((cell, column) => {
      let text = '';
      try { text = finHeaderText(cell); } catch { /* a formula the file never calculated names nothing */ }
      if (text) cells.push({ row: at, column, text });
    });
  });
  const mapping = {};
  let first = 0;
  for (const key of [...sheet.needs, ...sheet.may]) {
    for (const alias of FIN_TALLY_ALIASES[key]) {
      const hits = cells.filter(c => c.text === finHeaderText(alias));
      if (hits.length === 0) continue;
      for (const hit of hits) first = Math.max(first, hit.row + 1);
      if (hits.length === 1) mapping[key] = hits[0].column;
      break;
    }
  }
  return { mapping, first };
}

const finJoinWords = words => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`);

// The rows of a sheet under the layout a person chose ({ mapping, first }), as the import takes them: { rows }. Or { error } with the
// sentence finRowsFromSheet refused them with (a cell it cannot read, naming the ledger), or { pending } when a column a row cannot do
// without has not been chosen yet, which is not a fault. `first` is the row the figures start on, counting from 0.
export function finReadSheet(rows, kind, layout) {
  const mapping = layout?.mapping ?? {};
  const missing = finTallyColumns(kind).filter(c => c.required && !(Number.isInteger(mapping[c.key]) && mapping[c.key] >= 0));
  if (missing.length) {
    return { pending: `Choose the ${finJoinWords(missing.map(c => c.label))} ${missing.length === 1 ? 'column' : 'columns'}.` };
  }
  const first = Number.isInteger(layout?.first) && layout.first > 0 ? layout.first : 0;
  try {
    return { rows: finRowsFromSheet((Array.isArray(rows) ? rows : []).slice(first), kind, mapping, { firstRow: first + 1 }) };
  } catch (e) {
    return { error: e.message };
  }
}

// A cell as text: trimmed, a number written as it reads, nothing for an empty cell. `name` is the ledger whose row it is, which a refusal
// begins with (none, for the cell that names the ledger), and `where` the cell's place on the sheet.
const finCellText = (cell, name, where) => {
  const value = name ? finRead(cell, name, where) : finCellValue(cell);
  if (value === null || value === undefined) return '';
  if (finIsLeftover(value)) throw finLeftover(name, where);
  return String(value).trim();
};

// A sheet's own total row, which Tally prints under the ledgers.
const finIsTotalRow = name => name.replace(/\s+/g, ' ').toLowerCase() === 'grand total';

// One side of a trial balance row, in paise, never below zero. A Debit cell holds a debit and a Credit cell a credit,
// whatever marks them: '5,00,000.00 Dr' under Debit and '3,00,000.00 Cr' under Credit are the plain amounts. A cell that
// says the other side ('5.00 Cr' under Debit), or carries a minus or brackets, is refused rather than flipped: under a
// Credit heading, '-5.00' may mean a credit of 5 or a debit of 5, and an opening balance is not a guess.
function finSideCell(cell, side, name, where) {
  const value = finRead(cell, name, where);
  const p = finAmountOf(value, name, where);
  if (p === 0) return 0;
  const marked = typeof value === 'string' ? /(dr|cr)\s*$/i.exec(value.trim())?.[1].toLowerCase() : undefined;
  if (side === 'debit' && p > 0) return p;
  if (side === 'credit' && p > 0 && marked === undefined) return p;
  if (side === 'credit' && p < 0 && marked === 'cr') return -p;
  const heading = side === 'debit' ? 'Debit' : 'Credit';
  throw new Error(`${name}: the ${heading} column holds "${String(value).trim()}", which isn't a ${side} amount. Fix the cell in the export.`);
}

// An amount cell to signed paise (finParseTallyAmount), refused with its ledger's name.
function finAmountOf(cell, name, where) {
  const value = finRead(cell, name, where);
  try { return finParseTallyAmount(value); } catch (e) { throw new Error(`${name}: ${e.message}`); }
}

// A day in a bills sheet: blank is none; anything else is a day Tally writes (finTallyDate) or the row is refused.
function finDateCell(cell, name, where) {
  const value = finRead(cell, name, where);
  if (finCellText(value) === '') return null;
  const day = finTallyDate(value);
  if (day === null) throw new Error(`${name}: cannot read "${finCellText(value)}" as a date.`);
  return day;
}

// The rows of a sheet under its header, as the import takes them. `rows` are arrays of cells (ExcelJS values: text,
// numbers, Dates), `mapping` is what finDetectColumns found (or a person chose; a column left out reads as nothing). A
// row with no name, and the Grand Total row, carry nothing and are skipped. Amounts are whole paise. A bill's amount is
// SIGNED, Dr positive and Cr negative, and its side says the same ('dr', 'cr', or null for a bill of nothing, which the
// server counts and leaves out). `firstRow` is the sheet's own number (counting from 1) for the first of `rows`, so that a cell
// that cannot be read is named as Excel names it, 'C14'; rows taken from the top of a sheet need not say.
export function finRowsFromSheet(rows, kind, mapping, { firstRow } = {}) {
  const sheet = finSheetOf(kind);
  for (const column of sheet.rows) {
    if (!Number.isInteger(mapping?.[column]) || mapping[column] < 0) throw new Error(`The ${kind} sheet has no ${column} column.`);
  }
  const top = Number.isInteger(firstRow) && firstRow > 0 ? firstRow : 1;
  const list = Array.isArray(rows) ? rows : [];
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const cells = Array.isArray(list[i]) ? list[i] : [];
    const at = key => `${finColumnLetter(mapping[key])}${top + i}`;
    const nameKey = kind === 'bills' ? 'party' : 'name';
    const name = finCellText(cells[mapping[nameKey]], '', at(nameKey));
    if (!name || finIsTotalRow(name)) continue;
    if (kind === 'tb') {
      out.push({
        tally_name: name,
        debit_paise: finSideCell(cells[mapping.debit], 'debit', name, at('debit')),
        credit_paise: finSideCell(cells[mapping.credit], 'credit', name, at('credit')),
      });
    } else if (kind === 'accounts') {
      const row = { tally_name: name, tally_group: finCellText(cells[mapping.group], name, at('group')) || null };
      if (Number.isInteger(mapping.gstin)) row.gstin = finCellText(cells[mapping.gstin], name, at('gstin')) || null;
      out.push(row);
    } else {
      const amount_paise = finAmountOf(cells[mapping.amount], name, at('amount'));
      out.push({
        tally_ledger_name: name,
        bill_ref: finCellText(cells[mapping.ref], name, at('ref')) || null,
        bill_date: finDateCell(cells[mapping.date], name, at('date')),
        due_date: finDateCell(cells[mapping.due], name, at('due')),
        amount_paise,
        side: amount_paise > 0 ? 'dr' : amount_paise < 0 ? 'cr' : null,
      });
    }
  }
  return out;
}

const FIN_MONTHS = Object.freeze({ jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 });
const pad = (n, width = 2) => String(n).padStart(width, '0');

// A day as Tally or ExcelJS hands it over, as 'YYYY-MM-DD', or null when it is not one. Accepted: a JS Date (an ExcelJS
// date cell, read by its UTC day, which is how ExcelJS builds it), '1-Dec-26' or '1-Dec-2026', '01-12-2026' (day, month,
// four-digit year) and '2026-12-01'. A day that is not on the calendar ('31-Feb-27') is null, as is any other spelling:
// '12/01/2026' could be either of two days.
export function finTallyDate(raw) {
  const cell = finCellValue(raw);
  let y, m, d;
  if (cell instanceof Date) {
    if (Number.isNaN(cell.getTime())) return null;
    [y, m, d] = [cell.getUTCFullYear(), cell.getUTCMonth() + 1, cell.getUTCDate()];
  } else if (typeof cell === 'string') {
    const s = cell.trim();
    let hit;
    if ((hit = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) [y, m, d] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
    else if ((hit = /^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})$/.exec(s)) && Object.prototype.hasOwnProperty.call(FIN_MONTHS, hit[2].toLowerCase())) {
      [d, m, y] = [Number(hit[1]), FIN_MONTHS[hit[2].toLowerCase()], hit[3].length === 2 ? 2000 + Number(hit[3]) : Number(hit[3])];
    } else if ((hit = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(s))) [d, m, y] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
    else return null;
  } else {
    return null;
  }
  const iso = `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
  return finIsValidDate(iso) ? iso : null;
}
