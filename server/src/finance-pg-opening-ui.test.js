import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { finBootPg } from './finance-pg-harness.js';
import { finGroupKinds } from './finance-vouchers.js';
import {
  finFindHeaderRow, finReadSheet, finSheetRows,
} from '../../client/src/lib/finance/tally.js';
import {
  finBillsRead, finBuiltImport, finChangedRows, finDefaultMonthEnd, finEditDecision, finMatchView, finMonthEnds, finOpeningAsAt, finOpeningOutcome,
  finParallelBody, finPartyGroupIds, finRefusedRowId, finResumeImport, finRowDecision, finStepOfImport, finUploadBody,
} from '../../client/src/lib/finance/opening.js';

// The Opening Balances wizard and the Tally upload against a real database (spec §11): the files the screens read are written here as real
// .xlsx workbooks (ExcelJS), read back with the very functions the browser uses (tally.js), turned into what the wizard sends (opening.js),
// and sent to the real routes. Nothing in the screens is exercised that is not also exercised here, short of the drawing itself: that is the
// browser check. Opt-in, because it boots its own throwaway Postgres:
//   cd server && FINANCE_PG=1 node --test src/finance-pg-opening-ui.test.js
// Every name, figure and GSTIN here is invented.
const ON = process.env.FINANCE_PG === '1';
const gate = { skip: ON ? false : 'set FINANCE_PG=1' };

const R = 100;
let h;
let CI, DP;
let ExcelJS;

before(async () => {
  if (!ON) return;
  ExcelJS = (await import('exceljs')).default;
  h = await finBootPg('opening-ui');
  ({ CI, DP } = Object.fromEntries((await h.db.q('SELECT id, code FROM fin_books')).map(b => [b.code, b.id])));
  await h.db.q(`INSERT INTO customers (name, gstin, city, active) VALUES ('Acme Pharma Ltd', '27AAAAA0000A1Z5', 'Pune', 1), ('Twin Traders', NULL, 'Surat', 1)`);
  await h.db.q(`INSERT INTO vendors (name, gstin, city, active) VALUES ('Beta Supplies', NULL, 'Surat', 1), ('Twin Traders', NULL, 'Surat', 1)`);
});

after(async () => { await h?.close(); });

// ── The files, as Tally writes them: a title block over the header, group subtotals among the ledgers, a Grand Total of formulas ──

async function workbook(build) {
  const wb = new ExcelJS.Workbook();
  build(wb.addWorksheet('Sheet1'));
  const saved = await wb.xlsx.writeBuffer();
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(saved);
  return back.worksheets[0];
}
const title = (ws, report) => { ws.addRow(['Colour Impressions']); ws.addRow(['Plot 1, Invented Industrial Area']); ws.addRow([report]); ws.addRow(['1-Apr-26 to 31-Dec-26']); ws.addRow([]); };

// What TallyUpload does with a file once it has the worksheet: the rows, the header, the rows under it.
function read(sheet, kind) {
  const rows = finSheetRows(sheet);
  const found = finFindHeaderRow(rows, kind);
  assert.ok(found, `a header row is found in the ${kind} sheet`);
  const out = finReadSheet(rows, kind, { mapping: found.mapping, first: found.index + 1 });
  assert.ok(out.rows, out.error ?? out.pending);
  return out.rows;
}

const ACCOUNTS = [
  ['Alpha Bank', 'Bank Accounts', ''], ['Cash', 'Cash-in-Hand', ''], ['Proprietor Capital A/c', 'Capital Account', ''], ['Sales @ 5%', 'Sales Accounts', ''],
  ['Output IGST', 'Duties & Taxes', ''], ['Profit & Loss A/c', 'Profit & Loss', ''], ['Acme Pharma Ltd', 'Sundry Debtors', '27aaaaa0000a1z5'],
  ['Beta Supplies', 'Sundry Creditors', ''], ['Mystery Expenses', 'Nowhere', ''],
];
const TB = [
  ['Current Assets', 679000, null], ['Alpha Bank', 500000, null], ['Cash', 20000, null], ['Acme Pharma Ltd', 159000, null],
  ['Current Liabilities', null, 95000], ['Beta Supplies', null, 80000], ['Output IGST', null, 15000],
  ['Proprietor Capital A/c', null, 300000], ['Sales @ 5%', null, 250000], ['Profit & Loss A/c', null, 34000],
];

async function opening({ tb = TB } = {}) {
  const accounts = read(await workbook(ws => { title(ws, 'List of Accounts'); ws.addRow(['Name of Ledger', 'Under', 'GSTIN/UIN']); ACCOUNTS.forEach(r => ws.addRow(r)); }), 'accounts');
  const trial = read(await workbook(ws => {
    title(ws, 'Trial Balance'); ws.addRow(['Particulars', 'Debit', 'Credit']); tb.forEach(r => ws.addRow(r));
    ws.addRow(['Grand Total', { formula: 'SUM(B7:B16)', result: 679000 }, { formula: 'SUM(C7:C16)', result: 679000 }]);
  }), 'tb');
  const receivable = read(await workbook(ws => {
    title(ws, 'Bills Receivable'); ws.addRow(['Date', 'Ref. No.', "Party's Name", 'Pending Amount', 'Due on', 'Overdue by days']);
    ws.addRow([new Date(Date.UTC(2026, 10, 14)), 'INV-11', 'Acme Pharma Ltd', 100000, new Date(Date.UTC(2026, 11, 14)), 17]);
    ws.addRow(['1-Dec-26', 'INV-12', 'Acme Pharma Ltd', '59,000.00 Dr', '31-Dec-26', 0]);
  }), 'bills');
  const payable = read(await workbook(ws => {
    title(ws, 'Bills Payable'); ws.addRow(['Date', 'Ref. No.', "Party's Name", 'Pending Amount', 'Due on', 'Overdue by days']);
    ws.addRow(['3-Nov-26', 'PB-7', 'Beta Supplies', '50,000.00 Cr', '3-Jan-27', 0]);
    ws.addRow(['15-Nov-26', 'PB-8', 'Beta Supplies', '30,000.00 Cr', '15-Jan-27', 0]);
  }), 'bills');
  return finUploadBody({
    bookId: CI, asAt: finOpeningAsAt('2027-01-01'),
    accounts: { rows: accounts, fileName: 'List of Accounts.xlsx' }, tb: { rows: trial, fileName: 'Trial Balance.xlsx' },
    bills: finBillsRead({ 1: { rows: receivable, fileName: 'Receivable.xlsx' }, 2: { rows: payable, fileName: 'Payable.xlsx' } }, [1, 2]),
  });
}

const groupsOf = async book => (await h.call('GET', `/finance/books/${book}/groups`, null, 'acct')).body.groups;
const ledgersOf = async book => (await h.call('GET', `/finance/books/${book}/ledgers?include_inactive=1`, null, 'acct')).body.ledgers;
const idOf = (groups, name) => groups.find(g => g.name === name).id;

// ── The opening, as the wizard drives it ─────────────────────────────────────────────────────

test('the files a screen reads go through the wizard\'s own decisions to a posted Opening voucher that is Tally\'s, to the paisa', gate, async () => {
  const body = await opening();
  assert.equal(body.as_at, '2026-12-31', 'the day before the books begin, which the screen does not let anyone choose');
  assert.deepEqual(body.file_names, ['List of Accounts.xlsx', 'Trial Balance.xlsx', 'Receivable.xlsx', 'Payable.xlsx']);
  assert.equal(body.bills.length, 4, 'the bills of both files, together');
  const up = await h.call('POST', '/finance/imports', body, 'acct');
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.import.summary.ignored_rows, 2, 'the two group subtotals are left out');
  const groups = await groupsOf(CI);
  const ledgers = await ledgersOf(CI);
  const ledgerById = new Map(ledgers.map(l => [l.id, l]));

  // The Match step as first drawn: the server's proposals, every row decidable, one row undecided.
  let view = finMatchView(up.body.ledgers, {}, groups, { ledgerById });
  assert.equal(view.ready, true);
  assert.deepEqual(view.counts, { all: 9, match: 2, create: 6, attention: 1 });
  assert.equal(view.states.get(up.body.ledgers.find(r => r.tally_name === 'Mystery Expenses').id).note, 'Not decided yet');
  const acme = up.body.ledgers.find(r => r.tally_name === 'Acme Pharma Ltd');
  assert.deepEqual([acme.party_type, acme.is_party], ['customer', true], 'a lower-case GSTIN from the sheet found the ERP customer, and the server says the group is a party\'s');
  assert.equal(finRowDecision(acme).group_id, idOf(groups, 'Sundry Debtors'));

  // Confirmed as it stands: the undecided row is a problem on the Check step, not a refusal.
  const first = await h.call('PUT', `/finance/imports/${up.body.import.id}/matches`, { matches: view.matches }, 'acct');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.import.status, 'matched');
  assert.equal(first.body.tie_out.ok, false);
  assert.deepEqual(first.body.tie_out.problems.map(p => p.code), ['UNMATCHED']);
  const build = await h.call('POST', `/finance/imports/${up.body.import.id}/build-opening`, null, 'acct');
  assert.equal(build.status, 409, 'the button is off, and the server would refuse it anyway');
  assert.equal(build.body.code, 'FIN_TIE_OUT');

  // The person decides the row: create it under Indirect Expenses. The edit is what the screen holds above the step.
  const mystery = first.body.ledgers.find(r => r.tally_name === 'Mystery Expenses');
  const partyGroups = view.partyGroups;
  const asCreate = finEditDecision(mystery, finRowDecision(mystery), { action: 'create' }, partyGroups);
  assert.equal(finMatchView(first.body.ledgers, { [mystery.id]: asCreate }, groups).ready, false, 'a new ledger with no group yet stops the confirmation');
  const touched = { [mystery.id]: finEditDecision(mystery, asCreate, { group_id: idOf(groups, 'Indirect Expenses') }, partyGroups) };
  assert.deepEqual(finChangedRows(first.body.ledgers, touched, groups).map(r => r.tally_name), ['Mystery Expenses']);
  view = finMatchView(first.body.ledgers, touched, groups, { ledgerById });
  assert.equal(view.ready, true);
  assert.deepEqual(view.counts, { all: 9, match: 2, create: 7, attention: 0 });
  const second = await h.call('PUT', `/finance/imports/${up.body.import.id}/matches`, { matches: view.matches }, 'acct');
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.tie_out.ok, true, JSON.stringify(second.body.tie_out));
  assert.deepEqual(second.body.tie_out.totals, { dr: 679000 * R, cr: 679000 * R });
  assert.deepEqual(finChangedRows(second.body.ledgers, touched, groups), [], 'what the server now holds is what the screen showed: nothing is unconfirmed');

  // Resume: the wizard finds this import where it left it.
  const list = (await h.call('GET', `/finance/imports?book=${CI}&purpose=opening`, null, 'acct')).body.imports;
  assert.equal(finResumeImport(list).id, up.body.import.id);
  assert.equal(finStepOfImport(finResumeImport(list)), 'check');

  // Build: waits for the MD, and the screen's words for it are the voucher's own.
  const built = await h.call('POST', `/finance/imports/${up.body.import.id}/build-opening`, null, 'acct');
  assert.equal(built.status, 200, JSON.stringify(built.body));
  assert.deepEqual(finOpeningOutcome(built.body.voucher), { state: 'waiting', text: 'Waiting for MD approval' });
  const listed = (await h.call('GET', `/finance/imports?book=${CI}&purpose=opening`, null, 'acct')).body.imports;
  assert.equal(finResumeImport(listed), null, 'a used import is not continued');
  assert.equal(finBuiltImport(listed).opening_voucher_id, built.body.voucher.id);

  // The MD sends it back: the screen reports the reason, and the files can be uploaded again.
  const rejected = await h.call('POST', `/finance/vouchers/${built.body.voucher.id}/reject`, { reason: 'Alpha Bank is out by a lakh' }, 'md');
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
  const sentBack = (await h.call('GET', `/finance/vouchers/${built.body.voucher.id}`, null, 'acct')).body.voucher;
  assert.deepEqual(finOpeningOutcome(sentBack), { state: 'returned', text: 'The MD sent it back: Alpha Bank is out by a lakh' });

  // Uploaded again, matched at once (the ledgers the first build made are there), built again, and this time the MD posts it.
  const again = await h.call('POST', '/finance/imports', await opening(), 'acct');
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual(again.body.ledgers.map(r => r.match_status), Array(9).fill('matched'));
  const groups2 = await groupsOf(CI);
  const view2 = finMatchView(again.body.ledgers, {}, groups2, { ledgerById: new Map((await ledgersOf(CI)).map(l => [l.id, l])) });
  assert.equal((await h.call('PUT', `/finance/imports/${again.body.import.id}/matches`, { matches: view2.matches }, 'acct')).status, 200);
  const rebuilt = await h.call('POST', `/finance/imports/${again.body.import.id}/build-opening`, null, 'acct');
  assert.equal(rebuilt.status, 200, JSON.stringify(rebuilt.body));
  const posted = await h.call('POST', `/finance/vouchers/${rebuilt.body.voucher.id}/approve`, null, 'md');
  assert.deepEqual(finOpeningOutcome(posted.body.voucher), { state: 'posted', text: `Posted as ${posted.body.voucher.number}` });
  assert.match(posted.body.voucher.number, /^CI-OB-2627-\d{4}$/);

  // And the books are Tally's.
  const tb = (await h.call('GET', `/finance/reports/trial-balance?book=${CI}&to=2026-12-31`, null, 'acct')).body;
  const closing = Object.fromEntries(tb.ledgers.map(l => [l.name, l.closing_paise]));
  for (const [name, dr, cr] of TB.filter(([n]) => !/^Current /.test(n))) assert.equal(closing[name] ?? 0, ((dr ?? 0) - (cr ?? 0)) * R, name);
});

// ── The party group is one definition: the server's ──────────────────────────────────────────

// Fix round, M5. The screen used to work out which groups are a party's from their names (a client walk), and this test held the walk to
// finGroupKinds. The walk is gone: the groups read carries the flag, and the screen takes it. What is held here is that what the screen
// takes IS finGroupKinds' answer, on a tree with user-made groups at every depth and names that only look like the two.
test('a group is a party group for the screen exactly when finGroupKinds says so, on a tree with user-made groups at every depth', gate, async () => {
  const make = async (name, parent_id) => {
    const made = await h.call('POST', '/finance/groups', { book_id: DP, name, parent_id }, 'md');
    assert.equal(made.status, 200, `${name}: ${JSON.stringify(made.body)}`);
    return made.body.group;
  };
  let groups = await groupsOf(DP);
  const debtors = idOf(groups, 'Sundry Debtors');
  const creditors = idOf(groups, 'Sundry Creditors');
  const north = await make('Debtors - North', debtors);
  const metro = await make('Debtors - North - Metro', north.id);
  const packaging = await make('Creditors - Packaging', creditors);
  const board = await make('Creditors - Packaging - Board', packaging.id);
  const lookAlike = await make('Debtors', idOf(groups, 'Current Assets'));                  // not the name
  await make('Sundry Debtors Reserve', idOf(groups, 'Current Assets'));                     // and another
  groups = await groupsOf(DP);
  const kinds = await finGroupKinds(h.db.q, DP);
  const party = finPartyGroupIds(groups);
  assert.ok(groups.length > 30, `non-vacuous: ${groups.length} groups`);
  for (const g of groups) assert.equal(party.has(g.id), kinds.get(g.id).is_party, `${g.name}: the screen takes finGroupKinds' answer`);
  for (const g of [debtors, creditors, north, metro, packaging, board]) assert.equal(party.has(g.id ?? g), true, String(g.name ?? g));
  assert.equal(party.has(lookAlike.id), false);
  assert.equal(party.size, 6, 'the two groups, and the four made beneath them');
});

// What the Match step starts from is the server's own proposal, and a name that is both a customer and a vendor goes to the group's own side
// however deep the group is. The screen no longer knows the side (the groups say only that they are a party's), so it offers both.
test('a name that is both a customer and a vendor is proposed as the one of the group\'s own side, however deep the group is', gate, async () => {
  const groups = await groupsOf(DP);
  const under = async (name, groupName) => {
    const up = await h.call('POST', '/finance/imports', {
      book_id: DP, purpose: 'opening', as_at: '2026-12-31',
      accounts: [{ tally_name: name, tally_group: groupName }], tb: [{ tally_name: name, debit_paise: 0, credit_paise: 0 }],
    }, 'acct');
    assert.equal(up.status, 200, JSON.stringify(up.body));
    return up.body.ledgers[0];
  };
  const below = await under('Twin Traders', 'Creditors - Packaging - Board');
  assert.equal(below.party_type, 'vendor', 'the server proposes the vendor below Sundry Creditors, however deep');
  assert.equal(below.is_party, true);
  assert.equal(finPartyGroupIds(groups).has(below.group_id), true, 'and the groups read says the group is a party\'s');
  const debtor = await under('Twin Traders', 'Debtors - North - Metro');
  assert.equal(debtor.party_type, 'customer');
  assert.equal(finPartyGroupIds(groups).has(debtor.group_id), true);
});

// ── What a refusal says ──────────────────────────────────────────────────────────────────────

test('a refused confirmation names the row, and finRefusedRowId says which row of the screen it is', gate, async () => {
  const up = await h.call('POST', '/finance/imports', await opening(), 'acct');
  assert.equal(up.status, 200);
  const groups = await groupsOf(CI);
  const view = finMatchView(up.body.ledgers, {}, groups);
  // Alpha Bank is a ledger the book already has (an opening was built above), so making another of the name is refused.
  const alpha = up.body.ledgers.find(r => r.tally_name === 'Alpha Bank');
  const touched = { [alpha.id]: { action: 'create', ledger_id: null, group_id: idOf(groups, 'Bank Accounts'), party_type: null, party_id: null } };
  const sent = finMatchView(up.body.ledgers, touched, groups).matches;
  const refused = await h.call('PUT', `/finance/imports/${up.body.import.id}/matches`, { matches: sent }, 'acct');
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.match(refused.body.error, /Alpha Bank would make a ledger of the same name/);
  assert.equal(refused.body.field, `matches[${up.body.ledgers.indexOf(alpha)}].action`);
  assert.equal(finRefusedRowId({ status: 400, data: refused.body }, sent), alpha.id);
  assert.ok(view.matches.length === sent.length, 'every row is sent either way');
  // A refusal about the list as a whole names no row.
  const twice = { [alpha.id]: { action: 'match', ledger_id: up.body.ledgers.find(r => r.tally_name === 'Cash').ledger_id, group_id: null, party_type: null, party_id: null } };
  const clash = finMatchView(up.body.ledgers, twice, groups);
  assert.equal(clash.ready, false, 'the screen has already said so, before the server has to');
  assert.equal(clash.blocked, 2);
  const server = await h.call('PUT', `/finance/imports/${up.body.import.id}/matches`, {
    matches: up.body.ledgers.map(r => (r.id === alpha.id ? { row_id: r.id, action: 'match', ledger_id: twice[alpha.id].ledger_id } : { row_id: r.id, action: r.match_status === 'matched' ? 'match' : r.match_status, ledger_id: r.ledger_id, group_id: r.group_id, party_type: r.party_type, party_id: r.party_id })),
  }, 'acct');
  assert.equal(server.status, 400, 'and the server refuses what the screen blocked');
  assert.equal(finRefusedRowId({ status: 400, data: server.body }, []), null);
});

// ── The month-end trial balance ──────────────────────────────────────────────────────────────

test('the month ends the picker offers are the days the server accepts a trial balance for, and the day before the books begin is not one', gate, async () => {
  const years = (await h.call('GET', `/finance/books/${CI}/years`, null, 'acct')).body.years;
  const ends = finMonthEnds(years, '2027-01-01');
  assert.deepEqual(ends.map(e => e.value), ['2027-01-31', '2027-02-28', '2027-03-31']);
  assert.equal(finDefaultMonthEnd(ends, '2027-02-05'), '2027-01-31');
  const tb = read(await workbook(ws => { title(ws, 'Trial Balance'); ws.addRow(['Particulars', 'Debit', 'Credit']); ws.addRow(['Alpha Bank', 500000, null]); ws.addRow(['Beta Supplies', null, 80000]); }), 'tb');
  for (const end of ends) {
    const up = await h.call('POST', '/finance/imports', finParallelBody({ bookId: CI, asAt: end.value, tb: { rows: tb, fileName: 'TB.xlsx' } }), 'acct');
    assert.equal(up.status, 200, `${end.value}: ${JSON.stringify(up.body)}`);
    assert.equal(up.body.import.purpose, 'parallel_tb');
    assert.equal(up.body.tie_out, null, 'a month-end upload has no tie-out: it is compared, never built from');
  }
  const before = await h.call('POST', '/finance/imports', finParallelBody({ bookId: CI, asAt: '2026-12-31', tb: { rows: tb, fileName: 'TB.xlsx' } }), 'acct');
  assert.equal(before.status, 400);
  assert.equal(before.body.field, 'as_at');
  // The list the Parallel Run tab reads has them, newest first, and the report opens for the newest.
  const list = (await h.call('GET', `/finance/imports?book=${CI}&purpose=parallel_tb`, null, 'acct')).body.imports;
  assert.deepEqual(list.map(i => i.as_at), ['2027-03-31', '2027-02-28', '2027-01-31']);
  const report = await h.call('GET', `/finance/reports/parallel-run?import=${list[0].id}`, null, 'acct');
  assert.equal(report.status, 200);
  assert.equal(report.body.import.as_at, '2027-03-31');
});
