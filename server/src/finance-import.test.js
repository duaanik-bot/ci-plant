import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { finDetectColumns, finRowsFromSheet, finTallyDate } from '../../client/src/lib/finance/tally.js';
import {
  finCellShown, finCellValue, finColumnLetter, finFindHeaderRow, finGuessLayout, finReadSheet, finSheetRows, finTallyColumns, finTallyFileProblem,
} from '../../client/src/lib/finance/tally.js';
import { finNormName, finProposeMatches, finTieOut } from './finance-import.js';

// The pure half of the Tally import (spec §11): reading Tally's sheets in the browser (client/src/lib/finance/tally.js),
// and on the server, matching each Tally ledger to a Finance ledger and tying the figures out before an Opening voucher
// is built (finance-import.js). The database half is finance-pg-import.test.js (FINANCE_PG=1).
// The first four tests are the brief's, verbatim.

test('Tally headers are found by their own names', () => {
  assert.deepEqual(finDetectColumns(['Particulars', 'Debit', 'Credit'], 'tb'), { name: 0, debit: 1, credit: 2 });
  assert.deepEqual(finDetectColumns(['Date', 'Ref. No.', "Party's Name", 'Pending Amount', 'Due on', 'Overdue by days'], 'bills'),
    { date: 0, ref: 1, party: 2, amount: 3, due: 4 });
  assert.equal(finDetectColumns(['Item', 'Qty'], 'tb'), null);
});

test('sheet rows become paise, Tally dates become ISO, the total row is skipped', () => {
  const m = { name: 0, debit: 1, credit: 2 };
  assert.deepEqual(finRowsFromSheet([['Alpha Bank', '1,00,000.00', ''], ['Grand Total', '1,00,000.00', '1,00,000.00'], ['', '', '']], 'tb', m),
    [{ tally_name: 'Alpha Bank', debit_paise: 10000000, credit_paise: 0 }]);
  const b = finRowsFromSheet([['1-Dec-26', 'INV-12', 'Acme Pharma Ltd', '59,000.00 Dr', '31-Dec-26']], 'bills', { date: 0, ref: 1, party: 2, amount: 3, due: 4 });
  assert.deepEqual(b, [{ tally_ledger_name: 'Acme Pharma Ltd', bill_ref: 'INV-12', bill_date: '2026-12-01', due_date: '2026-12-31', amount_paise: 5900000, side: 'dr' }]);
  assert.equal(finTallyDate(new Date(Date.UTC(2026, 11, 1))), '2026-12-01');
  assert.equal(finTallyDate('01-12-2026'), '2026-12-01');
  assert.equal(finTallyDate('31-Feb-27'), null);
});

test('matching prefers the Tally name, then the normalised name, then proposes a ledger under the Tally group', () => {
  const out = finProposeMatches({
    rows: [{ tally_name: 'Cash', tally_group: 'Cash-in-Hand' }, { tally_name: 'Alpha Bank.', tally_group: 'Bank Accounts' },
           { tally_name: 'Acme  Pharma Ltd', tally_group: 'Sundry Debtors' }, { tally_name: 'Mystery', tally_group: 'Nowhere' }],
    ledgers: [{ id: 1, name: 'Cash', tally_name: null }],
    groups: [{ id: 10, name: 'Bank Accounts', is_party: false }, { id: 11, name: 'Sundry Debtors', is_party: true }, { id: 12, name: 'Cash-in-Hand', is_party: false }],
    parties: [{ party_type: 'customer', id: 7, name: 'Acme Pharma Ltd' }],
  });
  assert.deepEqual(out.map(o => [o.action, o.ledger_id ?? o.group_id ?? null]), [['match', 1], ['create', 10], ['create', 11], ['unmatched', null]]);
  assert.deepEqual([out[2].party_type, out[2].party_id], ['customer', 7]);
  assert.equal(finNormName('  Alpha   Bank. '), 'alpha bank');
});

test('tie-out: balanced, unmatched, and a party whose bills disagree with its balance', () => {
  const ok = finTieOut({ ledgers: [{ tally_name: 'A', debit_paise: 500, credit_paise: 0, action: 'match', is_party: false },
                                   { tally_name: 'B', debit_paise: 0, credit_paise: 500, action: 'create', is_party: true }],
                         bills: [{ tally_ledger_name: 'B', amount_paise: -500, side: 'cr' }] });
  assert.equal(ok.ok, true);
  const bad = finTieOut({ ledgers: [{ tally_name: 'A', debit_paise: 500, credit_paise: 0, action: 'unmatched', is_party: false },
                                    { tally_name: 'B', debit_paise: 0, credit_paise: 400, action: 'create', is_party: true }],
                          bills: [{ tally_ledger_name: 'B', amount_paise: -300, side: 'cr' }] });
  assert.deepEqual(bad.problems.map(p => p.code).sort(), ['BILLS_MISMATCH', 'TB_UNBALANCED', 'UNMATCHED']);
  assert.match(bad.problems.find(p => p.code === 'BILLS_MISMATCH').message, /^B: bills ₹3\.00 Cr, trial balance ₹4\.00 Cr\.$/);
});

// ── Beyond the brief: the headers ────────────────────────────────────────────────────────────

test('headers: capitals, surrounding spaces and line breaks inside a header make no difference; only the sheet\'s own columns come back', () => {
  assert.deepEqual(finDetectColumns(['  PARTICULARS ', 'debit', 'CREDIT', 'Group'], 'tb'), { name: 0, debit: 1, credit: 2 });
  assert.deepEqual(finDetectColumns(['Name of  Ledger', 'Closing Balance\nDebit', 'Closing Balance Credit'], 'tb'), { name: 0, debit: 1, credit: 2 });
  assert.deepEqual(finDetectColumns([null, 'Ledger', 7, 'Dr', 'Cr'], 'tb'), { name: 1, debit: 3, credit: 4 });
  assert.equal(finDetectColumns('Particulars', 'tb'), null, 'a header is a row of cells');
  assert.throws(() => finDetectColumns(['Particulars'], 'stock'), /sheet/);
  assert.throws(() => finDetectColumns(['Particulars'], 'constructor'), /sheet/);
});

test('headers: the List of Accounts may carry a GSTIN column (ruling R32); every bills column is needed', () => {
  assert.deepEqual(finDetectColumns(['Name of Ledger', 'Under'], 'accounts'), { name: 0, group: 1 });
  assert.deepEqual(finDetectColumns(['Name of Ledger', 'Under', 'GSTIN/UIN'], 'accounts'), { name: 0, group: 1, gstin: 2 });
  assert.deepEqual(finDetectColumns(['GSTIN', 'Ledger', 'Parent'], 'accounts'), { name: 1, group: 2, gstin: 0 });
  assert.equal(finDetectColumns(['Name of Ledger', 'GSTIN'], 'accounts'), null, 'no group column');
  assert.equal(finDetectColumns(['Date', 'Ref. No.', "Party's Name", 'Pending Amount'], 'bills'), null, 'no due date column');
  assert.equal(finDetectColumns(['Date', "Party's Name", 'Pending Amount', 'Due on'], 'bills'), null, 'no bill reference column');
});

test('headers: the first alias that names one column wins, and a column named twice is not guessed at', () => {
  // A bills sheet with an Amount column and a Pending Amount column: what is still owed is the pending amount.
  assert.equal(finDetectColumns(['Date', 'Ref No', 'Party Name', 'Amount', 'Pending Amount', 'Due Date'], 'bills').amount, 4);
  // Debit twice (an opening balance pair and a closing pair, say): which is the closing balance is for a person to say.
  assert.equal(finDetectColumns(['Particulars', 'Debit', 'Credit', 'Debit', 'Credit'], 'tb'), null);
  assert.equal(finDetectColumns(['Name of Ledger', 'Under', 'GSTIN', 'gstin'], 'accounts'), null);
});

// ── Beyond the brief: the rows ───────────────────────────────────────────────────────────────

const TB_COLS = { name: 0, debit: 1, credit: 2 };

test('trial balance rows: each side is that side\'s amount, whether or not the cell says Dr or Cr', () => {
  assert.deepEqual(finRowsFromSheet([
    ['  Alpha Bank  ', '5,00,000.00 Dr', null],
    ['Proprietor Capital A/c', '', '3,00,000.00 Cr'],
    ['Output IGST', 0, 15000],
    ['GRAND  TOTAL', '5,00,000.00', '3,15,000.00'],
    [null, '1.00', ''],
    ['Cash'],
  ], 'tb', TB_COLS), [
    { tally_name: 'Alpha Bank', debit_paise: 50000000, credit_paise: 0 },
    { tally_name: 'Proprietor Capital A/c', debit_paise: 0, credit_paise: 30000000 },
    { tally_name: 'Output IGST', debit_paise: 0, credit_paise: 1500000 },
    { tally_name: 'Cash', debit_paise: 0, credit_paise: 0 },
  ]);
});

test('trial balance rows: a cell that says the other side, or a minus, is refused with the ledger\'s name, never flipped', () => {
  for (const [debit, credit] of [['5.00 Cr', ''], ['-5.00', ''], ['(5.00)', ''], ['', '5.00 Dr'], ['', '-5.00'], ['', '(5.00)'], ['', -5]]) {
    assert.throws(() => finRowsFromSheet([['Alpha Bank', debit, credit]], 'tb', TB_COLS), /^Error: Alpha Bank: /,
      `should refuse ${JSON.stringify([debit, credit])}`);
  }
  assert.throws(() => finRowsFromSheet([['Alpha Bank', '1250,50', '']], 'tb', TB_COLS), /Alpha Bank.*1250,50/, 'a stray comma (ruling R11)');
  assert.throws(() => finRowsFromSheet([['Alpha Bank', 'lots', '']], 'tb', TB_COLS), /Alpha Bank.*lots/);
  assert.throws(() => finRowsFromSheet([['Alpha Bank']], 'tb', { name: 0, debit: 1 }), /credit/, 'a mapping without a needed column');
});

test('List of Accounts rows carry the GSTIN only when that column is mapped (ruling R32)', () => {
  const sheet = [['Acme Pharma Ltd', 'Sundry Debtors', ' 27AAAAA0000A1Z5 '], ['Alpha Bank', '', ''], ['Grand Total', '', '']];
  assert.deepEqual(finRowsFromSheet(sheet, 'accounts', { name: 0, group: 1 }), [
    { tally_name: 'Acme Pharma Ltd', tally_group: 'Sundry Debtors' },
    { tally_name: 'Alpha Bank', tally_group: null },
  ]);
  assert.deepEqual(finRowsFromSheet(sheet, 'accounts', { name: 0, group: 1, gstin: 2 }), [
    { tally_name: 'Acme Pharma Ltd', tally_group: 'Sundry Debtors', gstin: '27AAAAA0000A1Z5' },
    { tally_name: 'Alpha Bank', tally_group: null, gstin: null },
  ]);
});

test('bill rows: signed paise with the side they say, ExcelJS dates, and a date that cannot be read is refused', () => {
  const B = { date: 0, ref: 1, party: 2, amount: 3, due: 4 };
  assert.deepEqual(finRowsFromSheet([
    [new Date(Date.UTC(2026, 10, 3)), 'PB-7', 'Beta Supplies', '12,000.00 Cr', null],
    ['', 1042, 'Acme Pharma Ltd', 0, ''],
  ], 'bills', B), [
    { tally_ledger_name: 'Beta Supplies', bill_ref: 'PB-7', bill_date: '2026-11-03', due_date: null, amount_paise: -1200000, side: 'cr' },
    { tally_ledger_name: 'Acme Pharma Ltd', bill_ref: '1042', bill_date: null, due_date: null, amount_paise: 0, side: null },
  ]);
  assert.throws(() => finRowsFromSheet([['31-Feb-27', 'INV-1', 'Acme Pharma Ltd', '10.00 Dr', '']], 'bills', B), /Acme Pharma Ltd.*31-Feb-27/);
  assert.throws(() => finRowsFromSheet([['1-Dec-26', 'INV-1', 'Acme Pharma Ltd', '10.00 Dr', 'soon']], 'bills', B), /Acme Pharma Ltd.*soon/);
  // Mapped by hand, a sheet with no due date column: its bills are still read, their due dates nothing.
  assert.deepEqual(finRowsFromSheet([['1-Dec-26', 'INV-1', 'Acme Pharma Ltd', '10.00 Dr']], 'bills', { date: 0, ref: 1, party: 2, amount: 3 }),
    [{ tally_ledger_name: 'Acme Pharma Ltd', bill_ref: 'INV-1', bill_date: '2026-12-01', due_date: null, amount_paise: 1000, side: 'dr' }]);
  assert.throws(() => finRowsFromSheet([['Acme Pharma Ltd']], 'bills', { party: 0 }), /amount/, 'a bill needs its amount');
});

// ExcelJS hands a cell over as an object when it is more than a value: rich text, a hyperlink, a formula with its result.
test('cells as ExcelJS hands them over: rich text, a hyperlink and a formula are read for what they show, everywhere', () => {
  assert.equal(finCellValue({ richText: [{ text: 'Acme ' }, { font: { bold: true }, text: 'Pharma Ltd' }] }), 'Acme Pharma Ltd');
  assert.equal(finCellValue({ text: 'Alpha Bank', hyperlink: 'mailto:accounts@example.com' }), 'Alpha Bank');
  assert.equal(finCellValue({ text: { richText: [{ text: 'Beta' }, { text: ' Bank' }] }, hyperlink: '#Sheet2!A1' }), 'Beta Bank');
  assert.equal(finCellValue({ formula: 'B2+B3', result: 1500.5 }), 1500.5);
  assert.equal(finCellValue({ sharedFormula: 'D2', result: '59,000.00 Dr' }), '59,000.00 Dr');
  const day = new Date(Date.UTC(2026, 11, 1));
  assert.equal(finCellValue({ formula: 'DATE(2026,12,1)', result: day }), day);
  assert.equal(finCellValue(day), day);
  for (const plain of ['Cash', 3, 0, null, undefined, '']) assert.equal(finCellValue(plain), plain);
  // …and wherever a cell is read: headers, names, amounts, dates
  assert.deepEqual(finDetectColumns([{ richText: [{ text: 'Particulars' }] }, { formula: 'A1', result: 'Debit' }, 'Credit'], 'tb'),
    { name: 0, debit: 1, credit: 2 });
  assert.deepEqual(finRowsFromSheet([[{ text: 'Alpha Bank', hyperlink: '#A1' }, { formula: 'SUM(B2:B3)', result: 150000 }, null]], 'tb', TB_COLS),
    [{ tally_name: 'Alpha Bank', debit_paise: 15000000, credit_paise: 0 }]);
  assert.deepEqual(finRowsFromSheet([[{ formula: 'A9', result: day }, { richText: [{ text: 'INV-' }, { text: '12' }] }, 'Acme Pharma Ltd',
    { formula: 'D9', result: '59,000.00 Dr' }, { formula: 'E9', result: '31-Dec-26' }]], 'bills', { date: 0, ref: 1, party: 2, amount: 3, due: 4 }),
  [{ tally_ledger_name: 'Acme Pharma Ltd', bill_ref: 'INV-12', bill_date: '2026-12-01', due_date: '2026-12-31', amount_paise: 5900000, side: 'dr' }]);
  assert.equal(finTallyDate({ formula: 'A1', result: '1-Dec-26' }), '2026-12-01');
});

test('Tally dates: the three ways Tally writes a day, and nothing else', () => {
  assert.equal(finTallyDate('1-Dec-26'), '2026-12-01');
  assert.equal(finTallyDate(' 01-DEC-2026 '), '2026-12-01');
  assert.equal(finTallyDate('2026-12-01'), '2026-12-01');
  assert.equal(finTallyDate('1-12-2026'), '2026-12-01');
  assert.equal(finTallyDate('29-Feb-28'), '2028-02-29');
  assert.equal(finTallyDate(new Date(Date.UTC(2027, 0, 31, 18, 30))), '2027-01-31', 'an instant is read by its UTC day');
  for (const bad of ['29-Feb-27', '1-Dex-26', '12/01/2026', '01-12-26', '2026-13-01', '', '  ', null, undefined, 46357, new Date(NaN), {}]) {
    assert.equal(finTallyDate(bad), null, `should not read ${String(bad)}`);
  }
});

// ── Beyond the brief: matching ───────────────────────────────────────────────────────────────

const DEBTORS = { id: 11, name: 'Sundry Debtors', is_party: true, party_type: 'customer' };
const CREDITORS = { id: 13, name: 'Sundry Creditors', is_party: true, party_type: 'vendor' };
const BANKS = { id: 10, name: 'Bank Accounts', is_party: false };
const GSTIN = '27AAAAA0000A1Z5';
const propose = input => finProposeMatches({ ledgers: [], groups: [DEBTORS, CREDITORS, BANKS], parties: [], ...input });
const pick = o => [o.action, o.ledger_id, o.group_id, o.party_type, o.party_id];

test('normalised names: capitals, runs of spaces and trailing dots make no difference', () => {
  assert.equal(finNormName('ACME  Pharma   LTD..'), 'acme pharma ltd');
  assert.equal(finNormName('Ltd. . '), 'ltd');
  assert.equal(finNormName(null), '');
  assert.equal(finNormName(42), '');
});

test('matching: a Tally name a ledger keeps wins over a ledger of that name; one ledger is never proposed for two rows', () => {
  const ledgers = [{ id: 1, name: 'Bank One', tally_name: 'Alpha Bank' }, { id: 2, name: 'Alpha Bank', tally_name: null }];
  assert.deepEqual(pick(propose({ rows: [{ tally_name: 'alpha bank', tally_group: 'Bank Accounts' }], ledgers })[0]), ['match', 1, null, null, null]);
  // 'Alpha Bank Ltd' is ledger 3's Tally name and 'Alpha Bank' is its name: the Tally name keeps it, and the other row is
  // left for the accountant. It is not proposed as a new ledger either, because one of that name is already in the book.
  const both = propose({
    rows: [{ tally_name: 'Alpha Bank', tally_group: 'Bank Accounts' }, { tally_name: 'Alpha Bank Ltd', tally_group: 'Bank Accounts' }],
    ledgers: [{ id: 3, name: 'Alpha Bank', tally_name: 'Alpha Bank Ltd' }],
  });
  assert.deepEqual(both.map(pick), [['unmatched', null, null, null, null], ['match', 3, null, null, null]]);
});

test('matching: two ledgers that answer to one name are not guessed between, and no ledger is proposed beside them', () => {
  const out = propose({
    rows: [{ tally_name: 'Alpha Bank', tally_group: 'Bank Accounts' }, { tally_name: 'Beta Bank', tally_group: 'Bank Accounts' }],
    ledgers: [{ id: 1, name: 'Alpha Bank', tally_name: null }, { id: 2, name: 'Alpha Bank.', tally_name: null },
              { id: 3, name: 'B1', tally_name: 'Beta Bank' }, { id: 4, name: 'B2', tally_name: 'beta  bank' }],
  });
  assert.deepEqual(out.map(o => o.action), ['unmatched', 'unmatched']);
});

test('parties: a GSTIN goes first, then the name; capitals and spaces in a GSTIN make no difference (ruling R32)', () => {
  const parties = [{ party_type: 'customer', id: 7, name: 'Acme Pharma Ltd', gstin: GSTIN }, { party_type: 'customer', id: 8, name: 'Acme Pharma', gstin: null }];
  const [byGstin] = propose({ rows: [{ tally_name: 'Acme Pharma', tally_group: 'Sundry Debtors', gstin: ' 27aaaaa 0000a1z5 ' }], parties });
  assert.deepEqual(pick(byGstin), ['create', null, 11, 'customer', 7]);
  const [byName] = propose({ rows: [{ tally_name: 'Acme Pharma', tally_group: 'Sundry Debtors' }], parties });
  assert.deepEqual(pick(byName), ['create', null, 11, 'customer', 8]);
  const [unknownGstin] = propose({ rows: [{ tally_name: 'Acme Pharma', tally_group: 'Sundry Debtors', gstin: '06BBBBB1111B1Z1' }], parties });
  assert.deepEqual(pick(unknownGstin), ['create', null, 11, 'customer', 8], 'a GSTIN nobody has: the name decides');
});

test('parties: several hits are no proposal, and a GSTIN that is ambiguous does not fall back to the name', () => {
  const twins = [{ party_type: 'customer', id: 7, name: 'Acme Unit 1', gstin: GSTIN }, { party_type: 'customer', id: 8, name: 'Acme Pharma Ltd', gstin: GSTIN }];
  const [one] = propose({ rows: [{ tally_name: 'Acme Pharma Ltd', tally_group: 'Sundry Debtors', gstin: GSTIN }], parties: twins });
  assert.deepEqual(pick(one), ['create', null, 11, null, null]);
  const names = [{ party_type: 'customer', id: 7, name: 'Acme Pharma Ltd' }, { party_type: 'customer', id: 9, name: 'ACME PHARMA LTD.' }];
  assert.deepEqual(pick(propose({ rows: [{ tally_name: 'Acme Pharma Ltd', tally_group: 'Sundry Debtors' }], parties: names })[0]),
    ['create', null, 11, null, null]);
});

test('parties: a name that is a customer and a vendor is the customer under Sundry Debtors and the vendor under Sundry Creditors', () => {
  const parties = [{ party_type: 'vendor', id: 4, name: 'Zeta Traders' }, { party_type: 'customer', id: 3, name: 'Zeta Traders' }];
  const subDebtors = { id: 14, name: 'Debtors - Export', is_party: true, party_type: 'customer' };
  const out = finProposeMatches({
    rows: [{ tally_name: 'Zeta Traders', tally_group: 'Sundry Creditors' }, { tally_name: 'zeta traders.', tally_group: 'Debtors - Export' }],
    ledgers: [], groups: [DEBTORS, CREDITORS, subDebtors], parties,
  });
  // Two rows of one name cannot come in one upload; each is asked here as if alone, and the two parties differ.
  assert.deepEqual(out.map(o => [o.party_type, o.party_id]), [['vendor', 4], ['customer', 3]]);
  // Only a vendor of that name: under Sundry Debtors it is still the one hit.
  const [only] = propose({ rows: [{ tally_name: 'Zeta Traders', tally_group: 'Sundry Debtors' }], parties: [parties[0]] });
  assert.deepEqual([only.party_type, only.party_id], ['vendor', 4]);
});

test('parties: one already linked in the book is never proposed, and one party is never proposed for two rows', () => {
  const acme = { party_type: 'customer', id: 7, name: 'Acme Pharma Ltd', gstin: GSTIN };
  const [linked] = propose({ rows: [{ tally_name: 'Acme Pharma Ltd', tally_group: 'Sundry Debtors' }], parties: [acme],
    ledgers: [{ id: 5, name: 'Acme (old)', tally_name: null, party_type: 'customer', party_id: 7 }] });
  assert.deepEqual(pick(linked), ['create', null, 11, null, null]);
  // One company, two Tally ledgers with its GSTIN, and the ERP knows it only as a customer: the debtor ledger takes the
  // customer and the creditor ledger is left unlinked, whichever comes first.
  const debtor = { tally_name: 'Acme Pharma Ltd', tally_group: 'Sundry Debtors', gstin: GSTIN };
  const creditor = { tally_name: 'Acme Pharma (Purchases)', tally_group: 'Sundry Creditors', gstin: GSTIN };
  for (const rows of [[debtor, creditor], [creditor, debtor]]) {
    const out = propose({ rows, parties: [acme] });
    const of = name => out[rows.findIndex(r => r.tally_name === name)];
    assert.deepEqual([of('Acme Pharma Ltd').party_id, of('Acme Pharma (Purchases)').party_id], [7, null]);
  }
  // Two debtor ledgers with one GSTIN and nothing to choose between them: neither is linked.
  const twin = { tally_name: 'Acme Pharma Unit 2', tally_group: 'Sundry Debtors', gstin: GSTIN };
  assert.deepEqual(propose({ rows: [debtor, twin], parties: [acme] }).map(o => o.party_id), [null, null]);
});

test('parties: only an active customer or vendor is proposed, so a closed duplicate never makes a clean hit ambiguous', () => {
  const open = { party_type: 'customer', id: 7, name: 'Acme Pharma Ltd', gstin: GSTIN, active: true };
  const closed = { party_type: 'customer', id: 9, name: 'Acme Pharma Ltd', gstin: GSTIN, active: false };
  const acme = gstin => propose({ rows: [{ tally_name: 'Acme Pharma Ltd', tally_group: 'Sundry Debtors', gstin }], parties: [open, closed] })[0].party_id;
  assert.deepEqual([acme(GSTIN), acme(null)], [7, 7], 'by GSTIN and by name');
  assert.equal(propose({ rows: [{ tally_name: 'Acme Pharma Ltd', tally_group: 'Sundry Debtors' }], parties: [closed] })[0].party_id, null,
    'a closed one alone is no proposal');
});

test('parties: only a GSTIN-shaped value decides; "NA", "URP" or anything not 15 characters of its shape falls through to the name', () => {
  const parties = [{ party_type: 'customer', id: 7, name: 'Acme Pharma Ltd', gstin: 'NA' }, { party_type: 'customer', id: 8, name: 'Zeta Traders', gstin: 'NA' }];
  for (const gstin of ['NA', ' n a ', 'URP', '27AAAAA0000A1Z', '27AAAAA0000A1Z55', 'AB1234567890123', '']) {
    const [o] = propose({ rows: [{ tally_name: 'Acme Pharma Ltd', tally_group: 'Sundry Debtors', gstin }], parties });
    assert.deepEqual([o.party_type, o.party_id], ['customer', 7], JSON.stringify(gstin));
  }
});

test('parties: only a new ledger under a party group is linked; a match or a ledger elsewhere is not', () => {
  const parties = [{ party_type: 'customer', id: 7, name: 'Acme Pharma Ltd' }, { party_type: 'vendor', id: 4, name: 'Alpha Bank' }];
  const out = propose({
    rows: [{ tally_name: 'Acme Pharma Ltd', tally_group: 'Sundry Debtors' }, { tally_name: 'Alpha Bank', tally_group: 'Bank Accounts' }],
    ledgers: [{ id: 1, name: 'Acme Pharma Ltd', tally_name: null }], parties,
  });
  assert.deepEqual(out.map(pick), [['match', 1, null, null, null], ['create', null, 10, null, null]]);
});

// ── Beyond the brief: the tie-out ────────────────────────────────────────────────────────────

const row = (tally_name, debit_paise, credit_paise, extra = {}) => ({ tally_name, debit_paise, credit_paise, action: 'match', is_party: false, ...extra });

test('tie-out: the totals, and the sentence that names an unbalanced trial balance', () => {
  const out = finTieOut({ ledgers: [row('Alpha Bank', 50000, 0), row('Capital', 0, 49900)], bills: [] });
  assert.deepEqual(out.totals, { dr: 50000, cr: 49900 });
  assert.deepEqual(out.problems, [{ code: 'TB_UNBALANCED',
    message: "The trial balance doesn't balance: debits ₹500.00, credits ₹499.00 — a difference of ₹1.00." }]);
  assert.equal(out.ok, false);
  assert.deepEqual(finTieOut({ ledgers: [], bills: [] }), { ok: true, problems: [], warnings: [], totals: { dr: 0, cr: 0 } });
});

test('tie-out: bills join their ledger by normalised name; a party with no bills, or bills on a non-party ledger, is a warning', () => {
  const out = finTieOut({
    ledgers: [row('Acme Pharma Ltd', 15900, 0, { is_party: true }), row('Beta Supplies', 0, 1200, { is_party: true }),
              row('Alpha Bank', 0, 14700, { is_party: false }), row('Gamma Traders', 0, 0, { is_party: true })],
    bills: [{ tally_ledger_name: 'ACME PHARMA LTD.', amount_paise: 10000, side: 'dr' }, { tally_ledger_name: 'acme pharma ltd', amount_paise: 5900, side: 'dr' },
            { tally_ledger_name: 'Alpha Bank', amount_paise: -14700, side: 'cr' }],
  });
  assert.deepEqual(out.problems, []);
  assert.equal(out.ok, true);
  assert.deepEqual(out.warnings, [
    'Beta Supplies has no bills, so its balance of ₹12.00 Cr goes in as one line.',
    "Alpha Bank isn't a party's ledger, so its 1 bill is left out and it goes in as one line of ₹147.00 Cr.",
  ]);
  const nothing = finTieOut({ ledgers: [row('Petty Cash', 0, 0)], bills: [{ tally_ledger_name: 'Petty Cash', amount_paise: 50, side: 'dr' }, { tally_ledger_name: 'Petty Cash', amount_paise: -50, side: 'cr' }] });
  assert.deepEqual(nothing.warnings, ["Petty Cash isn't a party's ledger, so its 2 bills are left out and it goes in with no line: it has no balance."]);
});

test('tie-out: a bill that names no row of the import is a problem, never dropped (ruling R38)', () => {
  const out = finTieOut({ ledgers: [row('Acme Pharma Ltd', 100, 0, { is_party: true }), row('Capital', 0, 100)],
    bills: [{ tally_ledger_name: 'Acme Pharma Ltd', amount_paise: 100, side: 'dr' },
            { tally_ledger_name: 'Ghost Traders', amount_paise: 700, side: 'dr' }, { tally_ledger_name: 'ghost traders', amount_paise: -200, side: 'cr' }] });
  assert.deepEqual(out.problems, [{ code: 'BILLS_NO_LEDGER',
    message: "Ghost Traders: 2 bills of ₹5.00 Dr, but Ghost Traders isn't a ledger in this import." }]);
});

test('tie-out: the Opening voucher\'s 5,000-line limit is foreseen, counting the lines the build would write', () => {
  // A line per bill for a party with bills, one line for any other balance, none for a zero balance.
  const opening = billCount => finTieOut({
    ledgers: [row('Acme Pharma Ltd', billCount, 0, { is_party: true }), row('Capital', 0, billCount), row('Dormant', 0, 0)],
    bills: Array.from({ length: billCount }, () => ({ tally_ledger_name: 'Acme Pharma Ltd', amount_paise: 1, side: 'dr' })),
  });
  assert.deepEqual(opening(4999).problems, [], '5,000 lines is the limit, and allowed');
  assert.deepEqual(opening(5000).problems, [{ code: 'TOO_MANY_LINES', message: 'The Opening voucher would have 5,001 lines, and it can have 5,000 at most.' }]);
});

test('tie-out: rows read as groups\' totals that carried an amount are named when the trial balance does not balance (ruling R43)', () => {
  const ignored = [{ tally_name: 'Current Assets', debit_paise: 50000, credit_paise: 0 }, { tally_name: 'Grand Total', debit_paise: 50000, credit_paise: 49900 }];
  const off = finTieOut({ ledgers: [row('Alpha Bank', 50000, 0), row('Capital', 0, 49900)], bills: [], ignored });
  assert.deepEqual(off.problems.map(p => p.code), ['TB_UNBALANCED']);
  assert.deepEqual(off.warnings, ["These rows were read as groups' totals and left out of the trial balance: Current Assets ₹500.00 Dr; "
    + 'Grand Total debits ₹500.00, credits ₹499.00. If one of them is a ledger, its figure is what is missing.']);
  assert.deepEqual(finTieOut({ ledgers: [row('Alpha Bank', 50000, 0), row('Capital', 0, 50000)], bills: [], ignored }).warnings, [],
    'a trial balance that balances needs no such note');
});

test('tie-out: a trial balance row that is in no list of accounts is a problem when it carries an amount (ruling R36)', () => {
  const out = finTieOut({ ledgers: [row('Alpha Bank', 100, 0), row('Capital', 0, 100)], bills: [],
    unknown: [{ tally_name: 'Old Suspense', debit_paise: 0, credit_paise: 300 }, { tally_name: 'Dormant', debit_paise: 0, credit_paise: 0 }] });
  assert.deepEqual(out.problems, [{ code: 'TB_NOT_IN_ACCOUNTS',
    message: "Old Suspense is in the trial balance with ₹3.00 Cr, but it isn't in the List of Accounts." }]);
});

// ── Task 18: the header row of a real Tally export ───────────────────────────────────────────

// The brief's test, verbatim. Tally puts the company, the report and the period above the header.
test('the header row is found below Tally\'s title block', () => {
  const rows = [['Colour Impressions'], ['Trial Balance'], ['1-Apr-26 to 31-Dec-26'], ['Particulars', 'Debit', 'Credit'], ['Alpha Bank', '1,000.00', '']];
  assert.deepEqual(finFindHeaderRow(rows, 'tb'), { index: 3, mapping: { name: 0, debit: 1, credit: 2 } });
  assert.equal(finFindHeaderRow([['nothing here']], 'tb'), null);
});

test('the header row: the first that places every column wins, whatever sheet it is', () => {
  // A second header further down (a repeated page header, say) is not looked at once the first is found.
  const tbRows = [['Colour Impressions'], [], ['Particulars', 'Debit', 'Credit'], ['Particulars', 'Dr', 'Cr']];
  assert.deepEqual(finFindHeaderRow(tbRows, 'tb'), { index: 2, mapping: { name: 0, debit: 1, credit: 2 } });
  const accounts = [['Colour Impressions'], ['List of Accounts'], ['Name of Ledger', 'Under', 'GSTIN/UIN']];
  assert.deepEqual(finFindHeaderRow(accounts, 'accounts'), { index: 2, mapping: { name: 0, group: 1, gstin: 2 } });
  const bills = [['Bills Receivable'], ['As on 31-Dec-26'], ['Date', 'Ref. No.', "Party's Name", 'Pending Amount', 'Due on', 'Overdue by days']];
  assert.deepEqual(finFindHeaderRow(bills, 'bills'), { index: 2, mapping: { date: 0, ref: 1, party: 2, amount: 3, due: 4 } });
  assert.deepEqual(finFindHeaderRow([['Particulars', 'Debit', 'Credit']], 'tb'), { index: 0, mapping: { name: 0, debit: 1, credit: 2 } }, 'a sheet with no title block');
});

test('the header row: only the top rows are looked at, 15 unless told otherwise', () => {
  const below = n => [...Array(n).fill(['Colour Impressions']), ['Particulars', 'Debit', 'Credit']];
  assert.equal(finFindHeaderRow(below(14), 'tb').index, 14, 'the fifteenth row is within the 15');
  assert.equal(finFindHeaderRow(below(15), 'tb'), null, 'the sixteenth is not');
  assert.equal(finFindHeaderRow(below(15), 'tb', { scan: 16 }).index, 15);
  assert.equal(finFindHeaderRow(below(3), 'tb', { scan: 3 }), null);
  assert.equal(finFindHeaderRow(below(0), 'tb', { scan: 0 }), null, 'scan 0 looks at nothing');
  assert.equal(finFindHeaderRow(below(0), 'tb', { scan: 'many' }), null, 'and so does a scan that is no number');
});

test('the header row: a row two cells answer to for one column is not the header, and the search goes on', () => {
  // An opening and a closing pair of Debit and Credit: which is which is for a person to say, so this row places nothing.
  const rows = [['Particulars', 'Debit', 'Credit', 'Debit', 'Credit'], ['Particulars', 'Closing Balance Debit', 'Closing Balance Credit']];
  assert.deepEqual(finFindHeaderRow(rows, 'tb'), { index: 1, mapping: { name: 0, debit: 1, credit: 2 } });
  assert.equal(finFindHeaderRow(rows.slice(0, 1), 'tb'), null);
});

test('the header row: no rows, rows that are not rows, and a sheet that does not exist', () => {
  for (const nothing of [[], null, undefined, 'Particulars', {}]) assert.equal(finFindHeaderRow(nothing, 'tb'), null);
  assert.equal(finFindHeaderRow([null, 'Particulars', [undefined], ['Particulars', 'Debit', 'Credit']], 'tb').index, 3, 'a row that is no list of cells is no header');
  assert.throws(() => finFindHeaderRow([], 'stock'), /sheet/, 'refused even when there is nothing to look at');
  assert.throws(() => finFindHeaderRow([['Particulars', 'Debit', 'Credit']], 'constructor'), /sheet/);
});

// ── Task 18: a formula the file never calculated ─────────────────────────────────────────────
// ExcelJS hands a formula cell over as { formula, result }. A file written by a script or a converter can hold the formula and no result,
// and a cell read as blank or 0 would drop an opening balance without a word. The cell is refused, with the way out.

test('a formula with no saved value is refused, never read as blank or 0', () => {
  for (const cell of [{ formula: 'SUM(B2:B3)' }, { sharedFormula: 'D2' }, { formula: 'B2+B3', result: undefined }, { formula: 'B2+B3', result: null },
    { formula: 'SUM(B2:B3)', ref: 'B4' }]) {
    assert.throws(() => finCellValue(cell), /formula.* with no saved value/, JSON.stringify(cell));
    assert.throws(() => finCellValue(cell), /Open the file in Excel, save it, and upload the saved file, or copy the column and paste it as values\.$/,
      'and says what to do: save it in Excel, or paste the column as values');
  }
  assert.throws(() => finCellValue({ formula: 'SUM(B2:B3)' }), /\(=SUM\(B2:B3\)\)/, 'naming the formula, to find it by');
  // A cell handed over WITH a result of nothing has one, and 0 and '' are read as themselves. Only a hand-built cell is handed over so: a real
  // read of a file cannot do it. ExcelJS keeps a saved result only when it is truthy (`if (value)` in lib/doc/cell.js), so a formula that saved 0 or
  // '' arrives as { formula } alone and is refused like one that saved nothing (the real-file test below holds that).
  assert.equal(finCellValue({ formula: 'B2-B2', result: 0 }), 0);
  assert.equal(finCellValue({ formula: 'IF(A1="","",A1)', result: '' }), '');
  assert.equal(finCellValue({ sharedFormula: 'D2', result: 0 }), 0);
  const long = finCellValue.bind(null, { formula: 'X'.repeat(300) });
  assert.throws(long, error => error.message.length < 300 && /…/.test(error.message), 'a long formula is cut');
});

test('a formula with no saved value is refused wherever a cell is read, with its ledger\'s name where there is one', () => {
  const gap = { formula: 'SUM(B6:B7)' };
  assert.throws(() => finRowsFromSheet([['Alpha Bank', gap, '']], 'tb', TB_COLS), /^Error: Alpha Bank: .*formula.* with no saved value/, 'the Debit cell');
  assert.throws(() => finRowsFromSheet([['Alpha Bank', '', gap]], 'tb', TB_COLS), /^Error: Alpha Bank: .*no saved value/, 'the Credit cell');
  assert.throws(() => finRowsFromSheet([[gap, '1.00', '']], 'tb', TB_COLS), /no saved value/, 'the name cell');
  assert.throws(() => finRowsFromSheet([['Acme Pharma Ltd', 'Sundry Debtors', gap]], 'accounts', { name: 0, group: 1, gstin: 2 }), /^Error: Acme Pharma Ltd: .*no saved value/, 'a GSTIN');
  assert.throws(() => finRowsFromSheet([['Acme Pharma Ltd', gap]], 'accounts', { name: 0, group: 1 }), /^Error: Acme Pharma Ltd: .*no saved value/, 'a group');
  const B = { date: 0, ref: 1, party: 2, amount: 3, due: 4 };
  for (const at of [0, 1, 3, 4]) {
    const row = ['1-Dec-26', 'INV-1', 'Acme Pharma Ltd', '10.00 Dr', '31-Dec-26'];
    row[at] = gap;
    assert.throws(() => finRowsFromSheet([row], 'bills', B), /^Error: Acme Pharma Ltd: .*no saved value/, `bills column ${at}`);
  }
  assert.throws(() => finTallyDate(gap), /no saved value/, 'a date');
  assert.throws(() => finDetectColumns([gap, 'Debit', 'Credit'], 'tb'), /no saved value/, 'a header');
  // A column nobody asked for is not read, and a row with no name carries nothing: neither is a reason to refuse the file.
  assert.deepEqual(finRowsFromSheet([['Alpha Bank', '1.00', '', gap], [null, gap, gap, gap], ['Grand Total', gap, gap]], 'tb', TB_COLS),
    [{ tally_name: 'Alpha Bank', debit_paise: 100, credit_paise: 0 }]);
});

test('the header row: a row holding a formula with no saved value cannot be the header, and is stepped over', () => {
  const gap = { formula: 'TEXT(TODAY(),"d-mmm-yy")' };   // a title-block cell the writer never calculated
  const rows = [['Colour Impressions'], [gap], ['Particulars', 'Debit', 'Credit']];
  assert.deepEqual(finFindHeaderRow(rows, 'tb'), { index: 2, mapping: { name: 0, debit: 1, credit: 2 } });
  assert.equal(finFindHeaderRow([['Particulars', gap, 'Credit']], 'tb'), null, 'a header whose own cell is a gap is for a person to map');
});

// ── Task 18 fix round: a saved 0, and a cell nothing can be read from ───────────────────────────────────────
// A saved workbook with its first sheet's XML changed, for the shapes ExcelJS will not write: a formula with a stored 0, a shared formula
// whose first cell is gone. The zip library is the one ExcelJS itself reads with, found from ExcelJS, not from this directory.
async function patchedSheet(buffer, patch) {
  const JSZip = createRequire(createRequire(import.meta.url).resolve('exceljs'))('jszip');
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  const patched = patch(xml);
  assert.notEqual(patched, xml, 'the patch changed the sheet');
  zip.file('xl/worksheets/sheet1.xml', patched);
  return zip.generateAsync({ type: 'nodebuffer' });
}

const WAYS_OUT = 'Open the file in Excel, save it, and upload the saved file, or copy the column and paste it as values.';

// ExcelJS keeps a formula's saved result only when it is truthy, so a formula that saved 0 (or '' or FALSE) arrives as { formula } and
// nothing more: the cell of a formula that never saved anything. It is refused all the same, since a 0 and a missing figure cannot be told
// apart and reading both as 0 would drop a balance without a word; the sentence gives the other way out, for the person whose 0 is real.
test('a real .xlsx whose formula saved 0 reads like one that saved nothing, and is refused with both ways out; pasted as values it reads', async () => {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('TB');
  ws.addRow(['Particulars', 'Debit', 'Credit']);
  ws.addRow(['Alpha Bank', { formula: 'B3-B3' }, null]);     // saved below with its result patched in as <v>0</v>
  ws.addRow(['Beta Traders', 500, null]);
  const saved = await patchedSheet(await wb.xlsx.writeBuffer(), xml => xml.replace(/(<c r="B2"[^>]*>)(<f>B3-B3<\/f>)(<\/c>)/, '$1$2<v>0</v>$3'));
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(saved);
  assert.deepEqual(back.worksheets[0].getCell('B2').value, { formula: 'B3-B3' },
    'ExcelJS drops the 0 it read (if this fails, ExcelJS keeps a saved 0 now: the refusal of a zero, and its sentence, can go)');
  const rows = finSheetRows(back.worksheets[0]);
  assert.throws(() => finRowsFromSheet(rows.slice(1), 'tb', TB_COLS), {
    message: `Alpha Bank: This file has a formula (=B3-B3) with no saved value, so the figure it should show can't be read. ${WAYS_OUT}`,
  });
  assert.equal(finReadSheet(rows, 'tb', { mapping: TB_COLS, first: 1 }).error,
    `Alpha Bank: This file has a formula (=B3-B3) with no saved value, so the figure it should show can't be read. ${WAYS_OUT}`, 'and the screen gets the same sentence');
  // The second way out: the column pasted as values. The same sheet with a real 0 in the cell reads.
  const pasted = new ExcelJS.Workbook();
  const sheet = pasted.addWorksheet('TB');
  sheet.addRow(['Particulars', 'Debit', 'Credit']);
  sheet.addRow(['Alpha Bank', 0, null]);
  sheet.addRow(['Beta Traders', 500, null]);
  const again = new ExcelJS.Workbook();
  await again.xlsx.load(await pasted.xlsx.writeBuffer());
  assert.deepEqual(finRowsFromSheet(finSheetRows(again.worksheets[0]).slice(1), 'tb', TB_COLS), [
    { tally_name: 'Alpha Bank', debit_paise: 0, credit_paise: 0 },
    { tally_name: 'Beta Traders', debit_paise: 50000, credit_paise: 0 },
  ]);
});

// A cell that is an object still once finCellValue has read it is not text and not a number. ExcelJS hands over {} for the child of a shared
// formula whose first cell is missing from the file; printed, it would put "[object Object]" into a ledger's name or a bill's reference.
test('a cell left as an object once read is refused wherever it is read, naming its cell and the ledger on its row, never printed', () => {
  const lost = {};
  const refused = (where, name) => ({ message: `${name ? `${name}: ` : ''}cell ${where} holds something that isn't text or a number, so it can't be read. ${WAYS_OUT}` });
  // the name of a ledger, where there is no ledger to name yet: the cell alone, counted from the first row of the rows it is given
  assert.throws(() => finRowsFromSheet([[lost, '1.00', '']], 'tb', TB_COLS), refused('A1'));
  assert.throws(() => finRowsFromSheet([['Alpha Bank', '1.00', ''], [lost, '1.00', '']], 'tb', TB_COLS, { firstRow: 12 }), refused('A13'), 'and from the row they start on');
  assert.throws(() => finRowsFromSheet([[lost, 'Bank Accounts']], 'accounts', { name: 0, group: 1 }), refused('A1'));
  assert.throws(() => finRowsFromSheet([['1-Dec-26', 'INV-1', lost, '1.00 Dr', '']], 'bills', { date: 0, ref: 1, party: 2, amount: 3, due: 4 }), refused('C1'), 'a party');
  // everything else on the row, with the ledger's name in front
  assert.throws(() => finRowsFromSheet([['Alpha Bank', lost, '']], 'tb', TB_COLS), refused('B1', 'Alpha Bank'), 'a Debit');
  assert.throws(() => finRowsFromSheet([['Alpha Bank', '', lost]], 'tb', TB_COLS), refused('C1', 'Alpha Bank'), 'a Credit');
  assert.throws(() => finRowsFromSheet([['Acme Pharma Ltd', lost]], 'accounts', { name: 0, group: 1 }), refused('B1', 'Acme Pharma Ltd'), 'a group');
  assert.throws(() => finRowsFromSheet([['Acme Pharma Ltd', 'Sundry Debtors', lost]], 'accounts', { name: 0, group: 1, gstin: 2 }), refused('C1', 'Acme Pharma Ltd'), 'a GSTIN');
  const B = { date: 0, ref: 1, party: 2, amount: 3, due: 4 };
  const billsAt = { A: 0, B: 1, D: 3, E: 4 };
  for (const [letter, at] of Object.entries(billsAt)) {
    const row = ['1-Dec-26', 'INV-1', 'Acme Pharma Ltd', '10.00 Dr', '31-Dec-26'];
    row[at] = lost;
    assert.throws(() => finRowsFromSheet([row], 'bills', B), refused(`${letter}1`, 'Acme Pharma Ltd'), `bills column ${letter}`);
  }
  // a column far along the sheet is named as Excel names it
  assert.throws(() => finRowsFromSheet([['Alpha Bank', ...Array(26).fill(''), lost]], 'accounts', { name: 0, group: 27 }), refused('AB1', 'Alpha Bank'));
  // the screen reads a sheet from the row its figures start on, and that row's number is the sheet's own
  const sheet = [['Colour Impressions'], ['Particulars', 'Debit', 'Credit'], ['Alpha Bank', 500, null], ['Beta Traders', lost, null]];
  assert.deepEqual(finReadSheet(sheet, 'tb', { mapping: TB_COLS, first: 2 }), { error: refused('B4', 'Beta Traders').message });
  assert.deepEqual(finReadSheet([...sheet.slice(0, 3), [lost, 1, null]], 'tb', { mapping: TB_COLS, first: 2 }), { error: refused('A4').message });
  // a row that names no ledger, the Grand Total row and a column nobody mapped are not read, so they are no reason to refuse the file
  assert.deepEqual(finRowsFromSheet([['Alpha Bank', '1.00', '', lost], [null, lost, lost, lost], ['Grand Total', lost, lost]], 'tb', TB_COLS),
    [{ tally_name: 'Alpha Bank', debit_paise: 100, credit_paise: 0 }]);
  // a day is a value, not a leftover
  assert.deepEqual(finRowsFromSheet([[new Date(Date.UTC(2026, 11, 1)), 'INV-1', 'Acme Pharma Ltd', '10.00 Dr', new Date(Date.UTC(2026, 11, 31))]], 'bills', B),
    [{ tally_ledger_name: 'Acme Pharma Ltd', bill_ref: 'INV-1', bill_date: '2026-12-01', due_date: '2026-12-31', amount_paise: 1000, side: 'dr' }]);
  // and the cell reads as a note, not as "[object Object]", on the screen's preview
  assert.equal(finCellShown(lost), '(unreadable cell)');
  assert.doesNotMatch(finCellShown(['a']), /object/);
});

test('a real .xlsx with a shared formula whose first cell is missing is refused naming the cell, and the preview shows a note', async () => {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('TB');
  ws.addRow(['Particulars', 'Debit', 'Credit']);
  ws.addRow(['Alpha Bank', 100, null]);
  ws.addRow(['Beta Traders', 5, null]);
  // the name in row 2 and the debit in row 3 become children of a shared formula whose first cell (si 7) is not in the file
  const saved = await patchedSheet(await wb.xlsx.writeBuffer(), xml => xml
    .replace(/<c r="A2"[^>]*>.*?<\/c>/, '<c r="A2"><f t="shared" si="7"/></c>')
    .replace(/<c r="B3"[^>]*>.*?<\/c>/, '<c r="B3"><f t="shared" si="7"/></c>'));
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(saved);
  const rows = finSheetRows(back.worksheets[0]);
  assert.deepEqual([rows[1][0], rows[2][1]], [{}, {}], 'ExcelJS hands over an empty object for each');
  assert.equal(finCellShown(rows[1][0]), '(unreadable cell)');
  const tail = `holds something that isn't text or a number, so it can't be read. ${WAYS_OUT}`;
  assert.equal(finReadSheet(rows, 'tb', { mapping: TB_COLS, first: 1 }).error, `cell A2 ${tail}`, 'the name, found first');
  rows[1][0] = 'Alpha Bank';
  assert.equal(finReadSheet(rows, 'tb', { mapping: TB_COLS, first: 1 }).error, `Beta Traders: cell B3 ${tail}`, 'then the figure under a name');
});

// ── Task 18: reading the workbook, and a sheet whose header cannot be found ──────────────────

test('a file that is not an .xlsx is turned back with the way out; an .xls says to save it as .xlsx', () => {
  const xls = 'Save the Tally export as .xlsx and upload that.';
  for (const name of ['TB.xls', 'tb.XLS', 'Trial Balance 31-Dec-26.xls']) assert.equal(finTallyFileProblem(name), xls, name);
  for (const name of ['TB.xlsx', 'tb.XLSX', 'Trial Balance (1).xlsx']) assert.equal(finTallyFileProblem(name), null, name);
  for (const name of ['TB.csv', 'TB.pdf', 'TB.xlsm', 'TB.xlsx.xls.txt', 'TB', '', null, undefined]) {
    assert.match(finTallyFileProblem(name), /Excel \.xlsx file/, String(name));
  }
});

test('a column is named by its letter, the way Excel shows it', () => {
  assert.deepEqual([0, 1, 25, 26, 27, 51, 52, 701, 702].map(finColumnLetter), ['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
});

test('the columns a person maps by hand: the sheet\'s own, with the ones a row cannot do without marked', () => {
  const view = kind => finTallyColumns(kind).map(c => [c.key, c.label, c.required]);
  assert.deepEqual(view('tb'), [['name', 'Ledger name', true], ['debit', 'Debit', true], ['credit', 'Credit', true]]);
  assert.deepEqual(view('accounts'), [['name', 'Ledger name', true], ['group', 'Group (Under)', true], ['gstin', 'GSTIN', false]]);
  assert.deepEqual(view('bills'), [['date', 'Bill date', false], ['ref', 'Bill reference', false], ['party', 'Party name', true],
    ['amount', 'Pending amount', true], ['due', 'Due date', false]]);
  assert.throws(() => finTallyColumns('stock'), /sheet/);
});

test('a guess at the layout of a sheet with no header row: the columns that can be told, and the row the figures start on', () => {
  // Tally's two-row header: the report's name for the figures above, Debit and Credit below.
  const twoRows = [['Colour Impressions'], ['Trial Balance'], ['Particulars', 'Closing Balance', null], [null, 'Debit', 'Credit'], ['Alpha Bank', '1,000.00', '']];
  assert.deepEqual(finGuessLayout(twoRows, 'tb'), { mapping: { name: 0, debit: 1, credit: 2 }, first: 4 });
  // A column two cells answer to is left for the person; the others are filled in.
  assert.deepEqual(finGuessLayout([['Particulars', 'Debit', 'Credit', 'Debit', 'Credit'], ['Alpha Bank']], 'tb'), { mapping: { name: 0 }, first: 1 });
  // Nothing in it names a column: the figures may start on the first row.
  assert.deepEqual(finGuessLayout([['Alpha Bank', 1, 2]], 'tb'), { mapping: {}, first: 0 });
  assert.deepEqual(finGuessLayout([], 'tb'), { mapping: {}, first: 0 });
  // A header the aliases miss ('Bill Date') leaves its column to the person.
  assert.deepEqual(finGuessLayout([['Bill Date', 'Ref No', 'Party Name', 'Pending Amount', 'Due Date'], ['1-Dec-26']], 'bills'),
    { mapping: { ref: 1, party: 2, amount: 3, due: 4 }, first: 1 });
  // Where the header IS found, the guess is the header's own answer, and the figures start under it.
  const found = [['Colour Impressions'], ['Name of Ledger', 'Under', 'GSTIN/UIN'], ['Alpha Bank', 'Bank Accounts', '']];
  assert.deepEqual(finGuessLayout(found, 'accounts'), { mapping: { name: 0, group: 1, gstin: 2 }, first: 2 });
  // Only the top rows are looked at, and a cell the file never calculated names nothing.
  assert.deepEqual(finGuessLayout([...Array(15).fill(['x']), ['Particulars', 'Debit', 'Credit']], 'tb'), { mapping: {}, first: 0 });
  assert.deepEqual(finGuessLayout([[{ formula: 'A1' }, 'Debit', 'Credit']], 'tb'), { mapping: { debit: 1, credit: 2 }, first: 1 });
  assert.throws(() => finGuessLayout([], 'stock'), /sheet/);
});

test('a sheet read with the layout a person chose: the rows under it, a sentence for what cannot be read, and what is still to choose', () => {
  const sheet = [['Colour Impressions'], ['Particulars', 'Debit', 'Credit'], ['Alpha Bank', '1,000.00', ''], ['Grand Total', '1,000.00', '1,000.00']];
  assert.deepEqual(finReadSheet(sheet, 'tb', { mapping: TB_COLS, first: 2 }), { rows: [{ tally_name: 'Alpha Bank', debit_paise: 100000, credit_paise: 0 }] });
  // The title block is read as ledgers when the figures are said to start too high: a refusal, not a guess.
  assert.match(finReadSheet(sheet, 'tb', { mapping: TB_COLS, first: 1 }).error, /^Particulars: /);
  assert.match(finReadSheet([['Alpha Bank', { formula: 'A1' }, '']], 'tb', { mapping: TB_COLS, first: 0 }).error, /^Alpha Bank: .*no saved value/);
  assert.deepEqual(finReadSheet(sheet, 'tb', { mapping: { name: 0 }, first: 2 }), { pending: 'Choose the Debit and Credit columns.' });
  assert.deepEqual(finReadSheet(sheet, 'tb', { mapping: { name: 0, debit: 1 }, first: 2 }), { pending: 'Choose the Credit column.' });
  assert.deepEqual(finReadSheet(sheet, 'accounts', { mapping: {}, first: 0 }), { pending: 'Choose the Ledger name and Group (Under) columns.' });
  // A column mapped to a place that is not a column is no choice.
  for (const bad of [-1, 1.5, NaN, '1', null]) assert.ok(finReadSheet(sheet, 'tb', { mapping: { name: 0, debit: bad, credit: 2 }, first: 2 }).pending, String(bad));
  // The figures may not start before the sheet does.
  assert.deepEqual(finReadSheet(sheet, 'tb', { mapping: TB_COLS, first: 99 }), { rows: [] });
  assert.match(finReadSheet(sheet, 'tb', { mapping: TB_COLS, first: -4 }).error, /^Particulars: /, 'a start before the sheet is the top of it, where the header row is refused as a ledger');
  assert.match(finReadSheet(sheet, 'tb', { mapping: TB_COLS, first: NaN }).error, /^Particulars: /, 'and so is one that is no number');
});

test('a worksheet becomes arrays of cell values, one array to a sheet row, a blank row kept as an empty one', () => {
  const day = new Date(Date.UTC(2026, 11, 31));
  const gap = { formula: 'SUM(B6:B7)' };
  const made = [
    [1, [null, 'Colour Impressions', 'Colour Impressions']],
    [2, [null, { richText: [{ text: 'Trial ' }, { text: 'Balance' }] }]],
    [4, [null, 'Particulars', { formula: 'B1', result: 'Debit' }, day]],
    [5, [null, gap, { sharedFormula: 'C5', result: 7 }]],
  ];
  const sheet = { rowCount: 5, eachRow: (options, visit) => made.forEach(([number, values]) => visit({ values }, number)) };
  const rows = finSheetRows(sheet);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[0], ['Colour Impressions', 'Colour Impressions']);
  assert.deepEqual(rows[1], ['Trial Balance'], 'rich text is its text');
  assert.deepEqual(rows[2], [], 'row 3 is not in the sheet and keeps its place');
  assert.deepEqual(rows[3], ['Particulars', 'Debit', day], 'a formula is its result and a date stays a Date');
  assert.equal(rows[3][2], day);
  assert.deepEqual(rows[4], [gap, 7], 'a formula that was never calculated stays as it is, for the first read of it to refuse');
  assert.throws(() => finCellValue(rows[4][0]), /no saved value/);
  assert.deepEqual(finSheetRows({ rowCount: 0, eachRow: () => {} }), []);
  const asked = [];
  finSheetRows({ rowCount: 1, eachRow: (options, visit) => { asked.push(options); visit({ values: [null, 'a'] }, 1); } });
  assert.deepEqual(asked, [{ includeEmpty: true }], 'blank rows are asked for, or their places are lost');
  assert.throws(() => finSheetRows({ rowCount: 1048576, eachRow: () => {} }), /1,048,576 rows/, 'a sheet formatted to the end of the world is refused, not read');
});

// The real thing: a workbook written by ExcelJS, saved, and read back the way the browser reads an upload.
test('an .xlsx saved by ExcelJS is read to the ledgers on it: title block, header, rich text, a calculated total, a merged heading', async () => {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Trial Balance');
  ws.addRow(['Colour Impressions']);
  ws.mergeCells('A1:C1');
  ws.addRow(['Trial Balance']);
  ws.addRow(['1-Apr-26 to 31-Dec-26']);
  ws.addRow(['Particulars', 'Debit', 'Credit']);
  ws.addRow(['Alpha Bank', 500000, null]);
  ws.addRow([{ richText: [{ text: 'Acme ' }, { text: 'Pharma Ltd', font: { bold: true } }] }, '1,59,000.00 Dr', null]);
  ws.addRow(['Proprietor Capital A/c', null, 300000]);
  ws.addRow(['Grand Total', { formula: 'SUM(B5:B7)', result: 659000 }, { formula: 'SUM(C5:C7)', result: 300000 }]);
  const saved = await wb.xlsx.writeBuffer();

  const back = new ExcelJS.Workbook();
  await back.xlsx.load(saved);
  const rows = finSheetRows(back.worksheets[0]);
  assert.equal(rows.length, 8);
  const header = finFindHeaderRow(rows, 'tb');
  assert.deepEqual(header, { index: 3, mapping: { name: 0, debit: 1, credit: 2 } });
  assert.deepEqual(finRowsFromSheet(rows.slice(header.index + 1), 'tb', header.mapping), [
    { tally_name: 'Alpha Bank', debit_paise: 50000000, credit_paise: 0 },
    { tally_name: 'Acme Pharma Ltd', debit_paise: 15900000, credit_paise: 0 },
    { tally_name: 'Proprietor Capital A/c', debit_paise: 0, credit_paise: 30000000 },
  ]);
  // The same sheet written by a program that did not calculate its total: the total row is the Grand Total and is not read, but a total
  // under a name that is read is refused.
  const bare = new ExcelJS.Workbook();
  const sheet = bare.addWorksheet('TB');
  sheet.addRow(['Particulars', 'Debit', 'Credit']);
  sheet.addRow(['Alpha Bank', 100, null]);
  sheet.addRow(['Total', { formula: 'SUM(B2:B2)' }, null]);
  const again = new ExcelJS.Workbook();
  await again.xlsx.load(await bare.xlsx.writeBuffer());
  const rows2 = finSheetRows(again.worksheets[0]);
  assert.throws(() => finRowsFromSheet(rows2.slice(1), 'tb', { name: 0, debit: 1, credit: 2 }), /^Error: Total: .*formula \(=SUM\(B2:B2\)\) with no saved value/);
});

test('a cell as the preview shows it: its text, a day as a day, nothing for a blank, and a short note for a formula with no value', () => {
  assert.equal(finCellShown('  Alpha Bank '), 'Alpha Bank');
  assert.equal(finCellShown(1500.5), '1500.5');
  assert.equal(finCellShown(0), '0');
  assert.equal(finCellShown({ richText: [{ text: 'Acme ' }, { text: 'Pharma' }] }), 'Acme Pharma');
  assert.equal(finCellShown({ formula: 'A1+1', result: 7 }), '7');
  assert.equal(finCellShown(new Date(Date.UTC(2026, 11, 31))), '2026-12-31');
  assert.equal(finCellShown(new Date(NaN)), '');
  for (const blank of [null, undefined, '', '   ']) assert.equal(finCellShown(blank), '');
  assert.equal(finCellShown({ formula: 'SUM(B2:B3)' }), '(formula, no saved value)');
  assert.equal(finCellShown({ error: '#DIV/0!' }), '#DIV/0!');
  assert.equal(finCellShown('x'.repeat(60)), `${'x'.repeat(40)}…`, 'a long text is cut');
  assert.equal(finCellShown(true), 'true');
});
