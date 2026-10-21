// The Reports screen's pure half (spec §9.2, §10): the trial balance tree, the period, the links between reports, the export gate and
// the parallel run's small rules. The components draw what these functions say.
//
// The browser is wherever the accountant is, and a day is a calendar day. Pinned to a zone WEST of Greenwich, so a day read through a
// Date at UTC midnight shows up as the day before and the date tests below fail on it. Must run before the first Date is built.
process.env.TZ = 'Pacific/Honolulu';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { finTbRows } from '../../client/src/lib/finance/tb.js';
import * as T from '../../client/src/lib/finance/tb.js';
import * as R from '../../client/src/lib/finance/reports.js';
import * as P from '../../client/src/lib/finance/page.js';

const tb = {
  groups: [{ id: 1, parent_id: null, name: 'Current Assets', sort_order: 8, closing_paise: 100 },
           { id: 2, parent_id: 1, name: 'Bank Accounts', sort_order: 1, closing_paise: 100 },
           { id: 3, parent_id: null, name: 'Capital Account', sort_order: 1, closing_paise: -100 }],
  ledgers: [{ id: 9, group_id: 2, name: 'Alpha Bank', closing_paise: 100 }, { id: 8, group_id: 3, name: 'Capital', closing_paise: -100 }],
};
test('collapsed shows the roots in template order; expanding opens one level at a time', () => {
  assert.deepEqual(finTbRows(tb, new Set()).map(r => r.name), ['Capital Account', 'Current Assets']);
  assert.deepEqual(finTbRows(tb, new Set([1])).map(r => [r.name, r.depth]), [['Capital Account', 0], ['Current Assets', 0], ['Bank Accounts', 1]]);
  assert.deepEqual(finTbRows(tb, new Set([1, 2, 3])).map(r => r.name), ['Capital Account', 'Capital', 'Current Assets', 'Bank Accounts', 'Alpha Bank']);
});

// ── Beyond the brief ──────────────────────────────────────────────────────────────────────────────────────────────
// Read off the namespace (T.) so a helper that is missing fails its own test, by name, while red.

const fig = (opening, debit, credit) => ({ opening_paise: opening, debit_paise: debit, credit_paise: credit, closing_paise: opening + debit - credit });
const G = (id, parent_id, name, sort_order, f = fig(0, 0, 0)) => ({ id, parent_id, name, sort_order, ...f });
const L = (id, group_id, name, f = fig(0, 0, 0)) => ({ id, group_id, name, ...f });

test('every level is indented one step deeper, and a row carries the four figures of the group or ledger it stands for', () => {
  const deep = {
    groups: [G(1, null, 'Assets', 1, fig(10, 20, 5)), G(2, 1, 'Current', 2, fig(10, 20, 5)), G(3, 2, 'Bank', 3, fig(10, 20, 5))],
    ledgers: [L(7, 3, 'Alpha Bank', fig(10, 20, 5))],
  };
  const rows = finTbRows(deep, new Set([1, 2, 3]));
  assert.deepEqual(rows.map(r => [r.kind, r.id, r.name, r.depth]), [
    ['group', 1, 'Assets', 0], ['group', 2, 'Current', 1], ['group', 3, 'Bank', 2], ['ledger', 7, 'Alpha Bank', 3]]);
  assert.deepEqual(rows.map(r => [r.opening_paise, r.debit_paise, r.credit_paise, r.closing_paise]), Array(4).fill([10, 20, 5, 25]));
  assert.deepEqual(Object.keys(rows[3]).sort(), ['closing_paise', 'credit_paise', 'debit_paise', 'depth', 'id', 'kind', 'name', 'opening_paise']);
});

test('sub-groups come before the group\'s own ledgers; groups go by sort_order then id, ledgers by name without regard to capitals', () => {
  const t = {
    groups: [G(1, null, 'Root', 1), G(5, 1, 'Later sub', 9), G(4, 1, 'Tied sub B', 3), G(3, 1, 'Tied sub A', 3), G(9, null, 'Second root', 1)],
    ledgers: [L(30, 1, 'beta'), L(31, 1, 'Alpha'), L(32, 1, 'alpha'), L(33, 1, 'Bank 10'), L(34, 1, 'Bank 2')],
  };
  assert.deepEqual(finTbRows(t, new Set([1])).map(r => r.name), [
    'Root', 'Tied sub A', 'Tied sub B', 'Later sub', 'Alpha', 'alpha', 'Bank 2', 'Bank 10', 'beta', 'Second root']);
  assert.deepEqual(finTbRows(t, new Set()).map(r => r.name), ['Root', 'Second root'], 'roots tie on sort_order too: the lower id first');
});

test('an open group whose children are all hidden stays a plain row; ids that are not groups open nothing', () => {
  assert.deepEqual(finTbRows(tb, new Set([2])).map(r => r.name), ['Capital Account', 'Current Assets'], 'group 2 is under a closed group');
  assert.deepEqual(finTbRows(tb, new Set([99, 8, 9])).map(r => r.name), ['Capital Account', 'Current Assets']);
  assert.deepEqual(finTbRows(tb, [1, 2]).map(r => r.name), ['Capital Account', 'Current Assets', 'Bank Accounts', 'Alpha Bank'], 'any list of ids will do');
  assert.deepEqual(finTbRows(tb, undefined).map(r => r.name), ['Capital Account', 'Current Assets']);
});

test('the input is not touched, and nothing is read from an answer that has no groups', () => {
  const before = JSON.stringify(tb);
  finTbRows(tb, new Set([1, 2, 3]));
  assert.equal(JSON.stringify(tb), before);
  for (const empty of [undefined, null, {}, { groups: [] }, { groups: [], ledgers: [L(1, 1, 'x')] }]) {
    assert.ok(Array.isArray(finTbRows(empty, new Set([1]))));
  }
  assert.deepEqual(finTbRows({ groups: [], ledgers: [] }, new Set()), []);
});

test('nothing is lost: a group whose parent is missing is a top group, a loop is listed last, and a ledger with no group stays on view', () => {
  const odd = {
    groups: [G(1, null, 'Normal', 1), G(2, 77, 'Parent missing', 2), G(3, 4, 'Loop one', 3), G(4, 3, 'Loop two', 4)],
    ledgers: [L(10, 2, 'In an orphan'), L(11, 3, 'In a loop'), L(12, 555, 'No such group'), L(13, null, 'No group at all')],
  };
  const closed = finTbRows(odd, new Set());
  assert.deepEqual(closed.map(r => [r.kind, r.name, r.depth]), [
    ['group', 'Normal', 0], ['group', 'Parent missing', 0], ['group', 'Loop one', 0], ['ledger', 'No group at all', 0], ['ledger', 'No such group', 0]]);
  const open = finTbRows(odd, new Set([1, 2, 3, 4]));
  assert.deepEqual(open.map(r => r.name), ['Normal', 'Parent missing', 'In an orphan', 'Loop one', 'Loop two', 'In a loop', 'No group at all', 'No such group']);
  assert.equal(new Set(open.map(r => `${r.kind}${r.id}`)).size, open.length, 'each row once');
});

test('hideEmpty leaves out the groups with nothing in them, but never one that holds a ledger with figures', () => {
  const t = {
    groups: [G(1, null, 'Busy', 1, fig(0, 500, 0)), G(2, null, 'Empty root', 2), G(3, null, 'Nets to nothing', 3), G(4, 1, 'Empty sub', 4), G(5, 1, 'Busy sub', 5, fig(0, 500, 0)),
      G(6, null, 'Parent of empties', 6), G(7, 6, 'Empty child', 7)],
    ledgers: [L(10, 5, 'Cash', fig(0, 500, 0)), L(11, 3, 'Dr party', fig(100, 0, 0)), L(12, 3, 'Cr party', fig(-100, 0, 0)), L(13, 4, 'Zero ledger'), L(14, 5, 'Quiet')],
  };
  const names = (expanded, options) => finTbRows(t, new Set(expanded), options).map(r => r.name);
  assert.deepEqual(names([], undefined), ['Busy', 'Empty root', 'Nets to nothing', 'Parent of empties'], 'everything is listed unless asked');
  assert.deepEqual(names([1, 5]), ['Busy', 'Empty sub', 'Busy sub', 'Cash', 'Quiet', 'Empty root', 'Nets to nothing', 'Parent of empties']);
  assert.deepEqual(names([], { hideEmpty: true }), ['Busy', 'Nets to nothing'], 'a group with no ledger and no figures is hidden, children and all');
  assert.deepEqual(names([1, 3], { hideEmpty: true }), ['Busy', 'Busy sub', 'Nets to nothing', 'Cr party', 'Dr party'],
    'two ledgers that net to nothing are still on view; an empty sub-group is not');
  assert.deepEqual(names([1, 5], { hideEmpty: true }), ['Busy', 'Busy sub', 'Cash', 'Nets to nothing'], 'and a ledger with no figures is left out of an open group');
});

test('which groups can be opened: those with a sub-group or a ledger', () => {
  assert.deepEqual([...T.finTbExpandable(tb)].sort(), [1, 2, 3]);
  assert.deepEqual([...T.finTbExpandable({ groups: [G(1, null, 'Lonely', 1)], ledgers: [] })], []);
  assert.deepEqual([...T.finTbExpandable(undefined)], []);
  assert.ok(T.finTbExpandable(tb) instanceof Set);
  const all = T.finTbExpandable(tb);
  assert.deepEqual(finTbRows(tb, all).map(r => r.name), ['Capital Account', 'Capital', 'Current Assets', 'Bank Accounts', 'Alpha Bank']);
});

test('the four cells of a trial balance row: balances with Dr or Cr, amounts without, nothing where there is nothing', () => {
  const row = (opening, debit, credit) => ({ opening_paise: opening, debit_paise: debit, credit_paise: credit, closing_paise: opening + debit - credit });
  assert.deepEqual(T.finTbCells(row(0, 123456, 0)), { opening: '', debit: '₹1,234.56', credit: '', closing: '₹1,234.56 Dr' });
  assert.deepEqual(T.finTbCells(row(0, 0, 5000000)), { opening: '', debit: '', credit: '₹50,000.00', closing: '₹50,000.00 Cr' });
  assert.deepEqual(T.finTbCells(row(-250000, 100000, 0)), { opening: '₹2,500.00 Cr', debit: '₹1,000.00', credit: '', closing: '₹1,500.00 Cr' });
  // A debtor who paid in full: the closing is nil, and says so, because the row has figures. A row with none is blank all through.
  assert.deepEqual(T.finTbCells(row(0, 100000, 100000)), { opening: '', debit: '₹1,000.00', credit: '₹1,000.00', closing: '₹0.00' });
  assert.deepEqual(T.finTbCells(row(100000, 0, 100000)), { opening: '₹1,000.00 Dr', debit: '', credit: '₹1,000.00', closing: '₹0.00' });
  assert.deepEqual(T.finTbCells(row(0, 0, 0)), { opening: '', debit: '', credit: '', closing: '' });
  assert.deepEqual(T.finTbCells({}), { opening: '', debit: '', credit: '', closing: '' }, 'figures the answer left out are nothing');
});

test('the foot of the trial balance: three pairs that must agree, and the amount by which they do not', () => {
  const ok = { opening_dr: 900, opening_cr: 900, debit: 400, credit: 400, closing_dr: 1100, closing_cr: 1100 };
  assert.deepEqual(T.finTbBalance(ok), { opening: 0, movement: 0, closing: 0, tallies: true });
  const out = T.finTbBalance({ ...ok, closing_cr: 1000 });
  assert.deepEqual(out, { opening: 0, movement: 0, closing: 100, tallies: false });
  assert.equal(T.finTbBalance({ ...ok, debit: 401 }).movement, 1);
  assert.equal(T.finTbBalance({ ...ok, opening_dr: 899 }).opening, -1);
  assert.equal(T.finTbBalance(undefined).tallies, true, 'no totals is nothing to disagree about');
});

// ── The period, the tabs and the links ────────────────────────────────────────────────────────────────────────────

test('five tabs, in the order of the spec, each named by the report\'s own route', () => {
  assert.deepEqual(R.FIN_REPORT_TABS.map(t => [t.key, t.label]), [
    ['trial-balance', 'Trial Balance'], ['ledger', 'Ledger'], ['journal-register', 'Journal Register'], ['parallel-run', 'Parallel Run'], ['self-approved', 'Self-approved']]);
  assert.ok(Object.isFrozen(R.FIN_REPORT_TABS));
});

test('the tab is what follows /finance/reports/, and anything else is the trial balance', () => {
  assert.equal(R.finReportTab('ledger'), 'ledger');
  assert.equal(R.finReportTab('parallel-run'), 'parallel-run');
  assert.equal(R.finReportTab('ledger/'), 'ledger', 'a trailing slash');
  assert.equal(R.finReportTab('/self-approved'), 'self-approved');
  for (const none of ['', undefined, null, 'nonsense', 'Ledger', 'constructor', '__proto__', 'toString', '/', '//']) {
    assert.equal(R.finReportTab(none), 'trial-balance', String(none));
  }
  assert.equal(R.finReportTab('ledger/12'), 'ledger', 'the first part names it');
  assert.equal(R.finReportTab('trial-balance/extra/path'), 'trial-balance');
});

test('the period opens on the financial year to date, and a link may name either end', () => {
  const p = query => new URLSearchParams(query);
  assert.deepEqual(R.finReportRange(p(''), '2026-10-18'), { from: '2026-04-01', to: '2026-10-18' });
  assert.deepEqual(R.finReportRange(p(''), '2027-02-03'), { from: '2026-04-01', to: '2027-02-03' }, 'January to March belong to the year that began the April before');
  assert.deepEqual(R.finReportRange(p(''), '2027-04-01'), { from: '2027-04-01', to: '2027-04-01' }, 'the first day of a new year');
  assert.deepEqual(R.finReportRange(p('from=2026-12-31&to=2027-01-31'), '2026-10-18'), { from: '2026-12-31', to: '2027-01-31' });
  assert.deepEqual(R.finReportRange(p('from=2026-12-31'), '2026-10-18'), { from: '2026-12-31', to: '2026-10-18' }, 'only the end is today');
  assert.deepEqual(R.finReportRange(p('to=2026-09-30'), '2026-10-18'), { from: '2026-04-01', to: '2026-09-30' }, 'only the start is the year\'s');
  assert.deepEqual(R.finReportRange(undefined, '2026-10-18'), { from: '2026-04-01', to: '2026-10-18' });
});

test('a date in a link that is not a real day is never sent on: it is the default', () => {
  const p = query => new URLSearchParams(query);
  for (const bad of ['abc', '2026-13-01', '2026-02-30', '26-10-18', '2026-1-5', '', '2026-10-18T10:00', ' 2026-10-18', '2026-10-18; DROP']) {
    assert.deepEqual(R.finReportRange(p({ from: bad, to: bad }), '2026-10-18'), { from: '2026-04-01', to: '2026-10-18' }, JSON.stringify(bad));
  }
  assert.deepEqual(R.finReportRange(p('from=2028-02-29'), '2028-03-10'), { from: '2028-02-29', to: '2028-03-10' }, 'a leap day is a day');
});

test('a period that ends before it starts is said in the server\'s words and not asked for', () => {
  assert.equal(R.finRangeProblem('2026-04-01', '2026-10-18'), '');
  assert.equal(R.finRangeProblem('2026-10-18', '2026-10-18'), '', 'one day is a period');
  assert.equal(R.finRangeProblem('2026-10-19', '2026-10-18'), 'The start date comes after the end date.');
  assert.equal(R.finRangeProblem('2027-01-01', '2026-12-31'), 'The start date comes after the end date.');
});

test('the period in words, read from the text and never through a Date', () => {
  assert.equal(R.finPeriodText('2026-04-01', '2026-10-18'), '01 Apr 2026 to 18 Oct 2026');
  assert.equal(R.finPeriodText('2027-01-01', '2027-01-01'), '01 Jan 2027');
  assert.equal(R.finPeriodText('2026-12-31', '2027-01-31'), '31 Dec 2026 to 31 Jan 2027');
});

test('a ledger link names the ledger and the period in the query, and a tab link carries the period only when it was chosen', () => {
  assert.equal(R.finLedgerPath(9, '2026-04-01', '2026-10-18'), '/finance/reports/ledger?ledger=9&from=2026-04-01&to=2026-10-18');
  assert.equal(R.finLedgerPath('12', '2027-01-01', '2027-01-31'), '/finance/reports/ledger?ledger=12&from=2027-01-01&to=2027-01-31');
  const p = query => new URLSearchParams(query);
  assert.equal(R.finTabPath('journal-register', p('')), '/finance/reports/journal-register');
  assert.equal(R.finTabPath('trial-balance', p('from=2026-12-31&to=2027-01-31&ledger=9&voucher=4&type=journal')), '/finance/reports/trial-balance?from=2026-12-31&to=2027-01-31');
  assert.equal(R.finTabPath('self-approved', p('to=2027-01-31&ledger=9')), '/finance/reports/self-approved?to=2027-01-31');
  assert.equal(R.finTabPath('ledger', p('from=junk&to=2027-01-31')), '/finance/reports/ledger?to=2027-01-31', 'a date that is not a day is not carried');
});

// ── Export: only a login whose grant lets it ──────────────────────────────────────────────────────────────────────

test('export is offered only when the book says so, and every export prop goes through that one gate', () => {
  const spec = { name: 'Trial Balance', subtitle: 'Colour Impressions · 01 Apr 2026 to 18 Oct 2026', meta: ['x'], summary: [{ label: 'a', value: 'b' }], columns: [{ key: 'k' }] };
  assert.deepEqual(R.finExportProps({ can_export: true }, spec), {
    exportName: spec.name, exportSubtitle: spec.subtitle, exportMeta: spec.meta, exportSummary: spec.summary, exportColumns: spec.columns });
  assert.deepEqual(R.finExportProps({ can_export: true }, { name: 'A', subtitle: 'B' }), { exportName: 'A', exportSubtitle: 'B' }, 'only what was given');
  for (const book of [{ can_export: false }, {}, null, undefined, { can_export: 'true' }, { can_export: 1 }, { can_export: 'yes' }]) {
    assert.deepEqual(R.finExportProps(book, spec), {}, `no export for ${JSON.stringify(book)}`);
  }
});

// ── Running-balance tables never sort ─────────────────────────────────────────────────────────────────────────────

test('finUnsorted makes every column of a table unsortable, and leaves the rest of each column alone', () => {
  const cols = [{ key: 'a', label: 'A' }, { key: 'b', label: 'B', sortable: true, align: 'right', card: 'metric' }, { key: 'c', label: 'C', sortable: false, render: () => 'x' }];
  const out = R.finUnsorted(cols);
  assert.deepEqual(out.map(c => c.sortable), [false, false, false]);
  assert.deepEqual(out.map(c => c.key), ['a', 'b', 'c']);
  assert.equal(out[1].align, 'right');
  assert.equal(out[1].card, 'metric');
  assert.equal(out[2].render(), 'x');
  assert.equal(cols[1].sortable, true, 'the columns handed in are not changed');
  assert.deepEqual(R.finUnsorted([]), []);
});

// ── The statement, the register and the parallel run ──────────────────────────────────────────────────────────────

test('what a ledger statement\'s export says above its rows: the four figures, signed the ledger way', () => {
  const summary = R.finStatementSummary({ opening_paise: 150000, total_debit_paise: 20000, total_credit_paise: 45000, closing_paise: 125000 });
  assert.deepEqual(summary, [
    { label: 'Opening', value: '₹1,500.00 Dr' }, { label: 'Debits', value: '₹200.00' }, { label: 'Credits', value: '₹450.00' }, { label: 'Closing', value: '₹1,250.00 Dr' }]);
  const cr = R.finStatementSummary({ opening_paise: -5000, total_debit_paise: 0, total_credit_paise: 0, closing_paise: -5000 });
  assert.equal(cr[0].value, '₹50.00 Cr');
  assert.equal(R.finStatementSummary({ opening_paise: 0, total_debit_paise: 0, total_credit_paise: 0, closing_paise: 0 })[3].value, '₹0.00', 'nil carries neither Dr nor Cr');
});

test('what a trial balance\'s export says above its rows: each side of each pair in a tile of its own, in the words the cards use', () => {
  const summary = R.finTbSummary({ opening_dr: 900, opening_cr: 800, debit: 400, credit: 300, closing_dr: 1100, closing_cr: 1000 });
  assert.deepEqual(summary.map(s => [s.label, s.value]), [
    ['Opening Dr', '₹9.00'], ['Opening Cr', '₹8.00'],
    ['This period Debit', '₹4.00'], ['This period Credit', '₹3.00'],
    ['Closing Dr', '₹11.00'], ['Closing Cr', '₹10.00'],
  ]);
});

// Final wave item 13 (PRIORITY): the PDF's summary tiles. exporter.js (shared, and so not changed here) draws at most five tiles to a
// row, each (page width - 2 x 14 mm - 3 mm between) / n wide, its label at 6.4 pt and its value at 10.5 pt, both Helvetica bold, 3.4 mm
// in from the tile's left edge. Both sides of a pair in one tile ran to 68 mm in a 59 mm tile. Measured here with jsPDF itself on the
// exporter's own geometry, which the first lines pin from its source, so a change there is noticed here.
test('the trial balance\'s PDF tiles: every label and every value, to ₹9,99,99,999.99 a side, fits inside its tile', async () => {
  const exporter = source('lib/exporter.js');
  for (const piece of ['for (let start = 0; start < items.length; start += 5) {', 'const gap = 3;', 'const bw = (W - 2 * M - gap * (n - 1)) / n;',
    "doc.setFont('helvetica', 'bold').setFontSize(6.4)", 'doc.text(pdfText(chunk[i].label).toUpperCase(), bx + 3.4, yy + 4.6);',
    'doc.setFontSize(10.5)', 'doc.text(pdfText(chunk[i].value), bx + 3.4, yy + 10);', 'const M = 14;', String.raw`.replace(/₹\s?/g, 'Rs ')`]) {
    assert.ok(exporter.includes(piece), `the exporter still draws its tiles this way: ${piece}`);
  }
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });   // five columns: the exporter prints it portrait
  const W = doc.internal.pageSize.getWidth();
  const pdfText = v => String(v ?? '').replace(/₹\s?/g, 'Rs ');
  const fits = (items, what) => {
    for (let start = 0; start < items.length; start += 5) {
      const chunk = items.slice(start, start + 5);
      const width = (W - 2 * 14 - 3 * (chunk.length - 1)) / chunk.length;
      for (const tile of chunk) {
        doc.setFont('helvetica', 'bold').setFontSize(6.4);
        const label = 3.4 + doc.getTextWidth(pdfText(tile.label).toUpperCase());
        doc.setFontSize(10.5);
        const value = 3.4 + doc.getTextWidth(pdfText(tile.value));
        if (label > width || value > width) return `${what}: ${tile.label} ${tile.value} needs ${Math.max(label, value).toFixed(1)} mm of ${width.toFixed(1)}`;
      }
    }
    return '';
  };
  const most = 99999999 * 100 + 99;
  const totals = { opening_dr: most, opening_cr: most, debit: most, credit: most, closing_dr: most, closing_cr: most };
  assert.equal(fits(R.finTbSummary(totals), 'one side to a tile'), '');
  // the pair in one tile, as the summary used to be drawn, did not fit even at ₹13 lakh a side
  const lakhs = 1300000 * 100;
  const pair = [T.FIN_TB_FOOT.opening, T.FIN_TB_FOOT.period, T.FIN_TB_FOOT.closing].map(label => ({ label, value: `Dr ₹13,00,000.00 · Cr ₹13,00,000.00` }));
  assert.match(fits(pair, 'a pair to a tile'), /needs/, 'non-vacuous: the measure does catch the overflow that was reported');
  assert.equal(fits(R.finTbSummary({ ...totals, opening_dr: lakhs }), 'one side to a tile'), '');
});

test('a voucher\'s lines in the register: the first few, then how many more', () => {
  const lines = n => Array.from({ length: n }, (_, i) => ({ ledger_name: `Ledger ${i + 1}`, debit_paise: i === 0 ? 5000 : 0, credit_paise: i === 0 ? 0 : 5000 }));
  assert.deepEqual(R.finRegisterLines(lines(2)), { shown: lines(2), more: 0 });
  const many = R.finRegisterLines(lines(R.FIN_REGISTER_LINES_SHOWN + 4));
  assert.equal(many.shown.length, R.FIN_REGISTER_LINES_SHOWN);
  assert.equal(many.more, 4);
  assert.deepEqual(R.finRegisterLines([]), { shown: [], more: 0 });
  assert.deepEqual(R.finRegisterLines(undefined), { shown: [], more: 0 });
  assert.ok(R.FIN_REGISTER_LINES_SHOWN >= 4, 'a typical voucher is shown whole');
});

test('a line reads Dr or Cr, the ledger and the amount', () => {
  assert.equal(R.finLineText({ ledger_name: 'Alpha Bank', debit_paise: 123456, credit_paise: 0 }), 'Dr Alpha Bank ₹1,234.56');
  assert.equal(R.finLineText({ ledger_name: 'Capital', debit_paise: 0, credit_paise: 5000000 }), 'Cr Capital ₹50,000.00');
});

test('a row of the parallel run is red when Finance and Tally differ by even a paisa, and only then', () => {
  assert.equal(R.finParallelRowClass({ difference_paise: 100000 }), 'ci-row-alarm');
  assert.equal(R.finParallelRowClass({ difference_paise: -1 }), 'ci-row-alarm');
  assert.equal(R.finParallelRowClass({ difference_paise: 0 }), '');
  assert.equal(R.finParallelRowClass({ difference_paise: undefined }), 'ci-row-alarm', 'a row with no verdict is not passed over as agreeing');
});

test('under a ledger\'s name the parallel run says what Tally called it, or that Tally has no row for it', () => {
  assert.equal(R.finLedgerNameNote({ ledger_name: 'Alpha Bank', tally_name: 'Alpha Bank' }), '');
  assert.equal(R.finLedgerNameNote({ ledger_name: 'Alpha Bank', tally_name: 'ALPHA  BANK ' }), '', 'capitals and spaces are not a difference');
  assert.equal(R.finLedgerNameNote({ ledger_name: 'Alpha Bank', tally_name: 'Alpha Bank - Current A/c' }), 'Tally: Alpha Bank - Current A/c');
  assert.equal(R.finLedgerNameNote({ ledger_name: 'Alpha Bank', tally_name: null }), 'Not in the Tally file');
});

test('an upload is named for the month end it covers, who sent it and when', () => {
  const imp = { id: 4, as_at: '2027-01-31', uploaded_by: 'Test Accountant', uploaded_at: '2027-02-03T03:00:00.000Z' };
  // 03:00 UTC is still the 2nd in Honolulu: the day is the browser\'s own.
  assert.equal(R.finImportLabel(imp), 'As at 31 Jan 2027 · uploaded by Test Accountant on 02 Feb 2027');
  assert.equal(R.finImportLabel({ id: 5, as_at: '2027-02-28' }), 'As at 28 Feb 2027');
  assert.equal(R.finImportLabel({ id: 6, as_at: '2027-02-28', uploaded_by: 'Test Accountant' }), 'As at 28 Feb 2027 · uploaded by Test Accountant');
  assert.equal(R.finImportLabel({ id: 7, as_at: '2027-02-28', uploaded_at: '2027-03-02T20:00:00.000Z' }), 'As at 28 Feb 2027 · uploaded on 02 Mar 2027');
});

test('the empty line under a table: loading, could not load, or what there really is nothing of', () => {
  assert.equal(R.finReportEmpty({ known: false, failed: false, none: 'Nothing posted' }), 'Loading…');
  assert.equal(R.finReportEmpty({ known: false, failed: true, none: 'Nothing posted' }), 'The report couldn’t load');
  assert.equal(R.finReportEmpty({ known: true, failed: false, none: 'Nothing posted' }), 'Nothing posted');
  assert.equal(R.finReportEmpty({ known: true, failed: true, none: 'Nothing posted' }), 'Nothing posted', 'figures that came earlier are not an unheard answer');
  // Nothing is being asked for (a period that ends before it starts, no ledger chosen yet): that is not "loading" and not "could not load".
  assert.equal(R.finReportEmpty({ known: false, failed: false, none: 'Nothing posted', blocked: 'Choose a ledger' }), 'Choose a ledger');
  assert.equal(R.finReportEmpty({ known: true, failed: false, none: 'Nothing posted', blocked: 'Choose a ledger' }), 'Nothing posted', 'an answer on screen wins');
});

// ── What is on screen is what was asked for ───────────────────────────────────────────────────────────────────────

test('an answer is shown only for the request it answered, and a failure only for the request that failed', () => {
  const u1 = '/finance/reports/trial-balance?book=1&from=2026-04-01&to=2026-10-18';
  const u2 = '/finance/reports/trial-balance?book=1&from=2026-10-01&to=2026-10-18';
  const heard = { answer: { url: u1, data: { groups: [] } }, failedUrl: null };
  assert.deepEqual(R.finReportShown(heard, u1), { data: { groups: [] }, failed: false });
  assert.deepEqual(R.finReportShown(heard, u2), { data: null, failed: false }, 'figures of another period are not shown under this one');
  const failedNew = { answer: heard.answer, failedUrl: u2 };
  assert.deepEqual(R.finReportShown(failedNew, u2), { data: null, failed: true }, 'the new period failed and there is nothing of it to show');
  assert.deepEqual(R.finReportShown(failedNew, u1), { data: { groups: [] }, failed: false }, 'back on the period that was heard, its figures are fine');
  const failedRefresh = { answer: heard.answer, failedUrl: u1 };
  assert.deepEqual(R.finReportShown(failedRefresh, u1), { data: { groups: [] }, failed: true }, 'a refresh that failed keeps the last figures and says so');
  assert.deepEqual(R.finReportShown(heard, null), { data: null, failed: false }, 'nothing is being asked for: nothing is shown');
  assert.deepEqual(R.finReportShown({ answer: { url: null, data: null }, failedUrl: null }, null), { data: null, failed: false });
  assert.deepEqual(R.finReportShown({ answer: { url: null, data: null }, failedUrl: null }, u1), { data: null, failed: false }, 'not heard yet');
});

test('a ledger statement is asked for only once the ledger is known to be in this book', () => {
  const ledgers = [{ id: 5 }, { id: 9 }];
  assert.equal(R.finLedgerStatus(null, ledgers, false), 'none', 'no ledger chosen');
  assert.equal(R.finLedgerStatus(undefined, ledgers, false), 'none');
  assert.equal(R.finLedgerStatus(5, null, false), 'loading', 'the book\'s ledgers have not come yet');
  assert.equal(R.finLedgerStatus(5, ledgers, false), 'in');
  assert.equal(R.finLedgerStatus(77, ledgers, false), 'elsewhere', 'not one of this book\'s ledgers: a pasted link, or the other book');
  assert.equal(R.finLedgerStatus(5, [], false), 'elsewhere', 'a book with no ledgers has not this one');
  assert.equal(R.finLedgerStatus(5, [], true), 'in', 'when the list could not be read the answer\'s own book is what is checked');
  assert.equal(R.finLedgerStatus(5, null, true), 'in');
});

test('an answer for a ledger of another book is never drawn, whatever was asked', () => {
  assert.equal(R.finStatementBelongs({ ledger: { id: 5, book_id: 1 } }, 1), true);
  assert.equal(R.finStatementBelongs({ ledger: { id: 84, book_id: 2 } }, 1), false);
  assert.equal(R.finStatementBelongs(null, 1), false, 'no answer is no statement');
  assert.equal(R.finStatementBelongs(undefined, 1), false);
  assert.equal(R.finStatementBelongs({ ledger: { id: 5, book_id: '1' } }, 1), false, 'a book id is a number; text is not trusted');
});

test('the parallel run opens on the newest upload, and a pick that is not in the list falls back to it', () => {
  const imports = [{ id: 9 }, { id: 4 }, { id: 2 }];
  assert.equal(R.finPickImport(imports, null).id, 9, 'the list is newest first');
  assert.equal(R.finPickImport(imports, 4).id, 4);
  assert.equal(R.finPickImport(imports, 77).id, 9, 'an upload that is not this book\'s, or is gone');
  assert.equal(R.finPickImport([], null), null);
  assert.equal(R.finPickImport(undefined, 4), null);
});

// ── Fix round 1 (review of Task 16) ───────────────────────────────────────────────────────────────────────────────

// R57: the trial balance's cards total each LEDGER's balance on its own side, which is not what a group row shows (its net), so a
// Closing card of Dr 13,00,000 beside a Current Assets row of Dr 12,00,000 reads as a mistake unless it says what it adds up.
test('R57: the cards and the export say they add up ledger balances by side, in the same words, and say why they can exceed a group row', () => {
  assert.equal(T.FIN_TB_FOOT.opening, 'Opening · ledger balances by side');
  assert.equal(T.FIN_TB_FOOT.closing, 'Closing · ledger balances by side');
  assert.equal(T.FIN_TB_FOOT.period, 'This period · debits and credits');
  assert.ok(Object.isFrozen(T.FIN_TB_FOOT));
  assert.match(T.FIN_TB_FOOT_NOTE, /ledger/);
  assert.match(T.FIN_TB_FOOT_NOTE, /own side/);
  assert.match(T.FIN_TB_FOOT_NOTE, /net/, 'and a group row shows its net');
  const labels = R.finTbSummary({ opening_dr: 1, opening_cr: 1, debit: 1, credit: 1, closing_dr: 1, closing_cr: 1 }).map(s => s.label);
  const heading = key => T.FIN_TB_FOOT[key].split(' · ')[0];
  assert.deepEqual(labels, [`${heading('opening')} Dr`, `${heading('opening')} Cr`, `${heading('period')} Debit`, `${heading('period')} Credit`,
    `${heading('closing')} Dr`, `${heading('closing')} Cr`], 'one set of words, on screen and in the file: each card\'s heading and its sides');
});

// R58: the default period opens on the later of the financial year's start and the day the books begin. In FY 2026-27 the books begin
// 2027-01-01 and the Opening voucher is dated 2026-12-31: from 1 April it is MOVEMENT (Opening nil, Debit and Credit carrying the whole
// opening), from the day the books begin it is the OPENING, as in Tally. No closing moves either way.
test('R58: the default start is the later of the year\'s start and the day the books begin; a first year is clamped and a later one is not', () => {
  assert.equal(R.finPeriodStart('2027-02-03', '2027-01-01'), '2027-01-01', 'the first year is clamped');
  assert.equal(R.finPeriodStart('2027-03-31', '2027-01-01'), '2027-01-01', 'to its last day');
  assert.equal(R.finPeriodStart('2027-01-01', '2027-01-01'), '2027-01-01', 'and on the day the books begin');
  assert.equal(R.finPeriodStart('2027-04-01', '2027-01-01'), '2027-04-01', 'the second year is not');
  assert.equal(R.finPeriodStart('2027-10-18', '2027-01-01'), '2027-04-01');
  assert.equal(R.finPeriodStart('2028-02-29', '2027-01-01'), '2027-04-01', 'nor is any later one');
  assert.equal(R.finPeriodStart('2026-10-18', '2026-04-01'), '2026-04-01', 'books that begin with the year change nothing');
  assert.equal(R.finPeriodStart('2027-02-03', '2025-01-01'), '2026-04-01', 'nor do books that began long before');
  // Books that have not begun: there is nothing to clamp to, and the default must still be a period that starts before it ends.
  assert.equal(R.finPeriodStart('2026-10-18', '2027-01-01'), '2026-04-01');
  for (const none of [undefined, null, '', 'soon', '2027-13-01', 20270101]) assert.equal(R.finPeriodStart('2027-02-03', none), '2026-04-01', String(none));
});

test('R58: the page\'s default period uses it, a period that was chosen is never moved, and the start follows the end that was chosen', () => {
  const p = query => new URLSearchParams(query);
  assert.deepEqual(R.finReportRange(p(''), '2027-02-03', '2027-01-01'), { from: '2027-01-01', to: '2027-02-03' });
  assert.deepEqual(R.finReportRange(p(''), '2027-05-10', '2027-01-01'), { from: '2027-04-01', to: '2027-05-10' });
  assert.deepEqual(R.finReportRange(p(''), '2026-10-18', '2027-01-01'), { from: '2026-04-01', to: '2026-10-18' }, 'books not begun: the plain year to date');
  assert.deepEqual(R.finReportRange(p(''), '2027-02-03'), { from: '2026-04-01', to: '2027-02-03' }, 'without the day the books begin: as before');
  assert.deepEqual(R.finReportRange(p('from=2026-12-31'), '2027-02-03', '2027-01-01'), { from: '2026-12-31', to: '2027-02-03' }, 'a chosen start stays');
  assert.deepEqual(R.finReportRange(p('from=2026-04-01&to=2027-02-03'), '2027-02-03', '2027-01-01'), { from: '2026-04-01', to: '2027-02-03' });
  assert.deepEqual(R.finReportRange(p('to=2027-03-31'), '2027-10-18', '2027-01-01'), { from: '2027-01-01', to: '2027-03-31' }, 'the default start is the year the chosen end is in');
  assert.deepEqual(R.finReportRange(p('to=2026-12-31'), '2027-02-03', '2027-01-01'), { from: '2026-04-01', to: '2026-12-31' }, 'an end before the books began has nothing to clamp to');
  assert.equal(R.finRangeProblem(...Object.values(R.finReportRange(p(''), '2027-02-03', '2027-01-01'))), '', 'the default is always a period');
  assert.equal(R.finRangeProblem(...Object.values(R.finReportRange(p(''), '2026-10-18', '2027-01-01'))), '');
});

// M6: the tab you are on is not a place to go. Today it dropped the chosen ledger and pushed a history entry.
test('M6: a click on the tab you are already on goes nowhere; another tab carries the chosen period', () => {
  const p = query => new URLSearchParams(query);
  assert.equal(R.finTabMove('ledger', 'ledger', p('ledger=9&from=2026-04-01&to=2026-10-18')), null);
  assert.equal(R.finTabMove('trial-balance', 'trial-balance', p('')), null);
  assert.equal(R.finTabMove('self-approved', 'self-approved', p('voucher=4')), null);
  assert.equal(R.finTabMove('ledger', 'journal-register', p('ledger=9&from=2026-04-01&to=2026-10-18')), '/finance/reports/journal-register?from=2026-04-01&to=2026-10-18');
  assert.equal(R.finTabMove('trial-balance', 'ledger', p('')), '/finance/reports/ledger');
  assert.equal(R.finTabMove('parallel-run', 'trial-balance', p('to=2027-01-31&voucher=3')), '/finance/reports/trial-balance?to=2027-01-31');
});

// M7: a group shown because its ledgers carry figures, whose figures net to nothing, printed blank in all four columns and looked empty.
test('M7: which groups hold ledgers with figures', () => {
  const t = {
    groups: [G(1, null, 'Debtors', 1), G(2, 1, 'Region A', 2), G(3, null, 'Quiet', 3), G(4, null, 'Parent', 4), G(5, 4, 'Child', 5), G(6, null, 'Own figures only', 6, fig(0, 50, 0))],
    ledgers: [L(10, 2, 'Owes', fig(100, 0, 0)), L(11, 2, 'In credit', fig(-100, 0, 0)), L(12, 3, 'Zero'), L(13, 5, 'Child owes', fig(5, 0, 0)), L(14, 777, 'Stray', fig(9, 0, 0))],
  };
  assert.deepEqual([...T.finTbHolding(t)].sort((a, b) => a - b), [1, 2, 4, 5], 'a group holds what its ledgers and its sub-groups\' ledgers carry');
  assert.deepEqual([...T.finTbHolding(undefined)], []);
  assert.ok(T.finTbHolding(t) instanceof Set);
});

test('M7: a group that nets to nothing but holds figures says so in both balances; nothing else about the cells changes', () => {
  const row = (opening, debit, credit) => ({ opening_paise: opening, debit_paise: debit, credit_paise: credit, closing_paise: opening + debit - credit });
  assert.deepEqual(T.finTbCells(row(0, 0, 0), true), { opening: '₹0.00', debit: '', credit: '', closing: '₹0.00' }, 'it nets to nil, and nothing moved');
  assert.deepEqual(T.finTbCells(row(0, 0, 0), false), { opening: '', debit: '', credit: '', closing: '' }, 'a row that holds nothing stays blank');
  assert.deepEqual(T.finTbCells(row(0, 0, 0)), { opening: '', debit: '', credit: '', closing: '' }, 'and holding is no by default');
  assert.deepEqual(T.finTbCells(row(0, 100000, 0), true), T.finTbCells(row(0, 100000, 0), false), 'a row with figures of its own reads as it always did');
  assert.deepEqual(T.finTbCells(row(0, 100000, 100000), true), { opening: '', debit: '₹1,000.00', credit: '₹1,000.00', closing: '₹0.00' });
  assert.deepEqual(T.finTbCells(row(-250000, 100000, 0), true), { opening: '₹2,500.00 Cr', debit: '₹1,000.00', credit: '', closing: '₹1,500.00 Cr' });
});

// M9: the URL-state helper was written twice (Reports and Vouchers).
test('M9: one helper makes the next query string: a value sets it, nothing or blank removes it, the rest stays, the old one is not touched', () => {
  const before = new URLSearchParams('tab=drafts&voucher=4&from=2026-04-01');
  const next = P.finQueryWith(before, { voucher: 9, tab: null, to: '2026-10-18', from: '' });
  assert.equal(next.toString(), 'voucher=9&to=2026-10-18');
  assert.equal(before.toString(), 'tab=drafts&voucher=4&from=2026-04-01', 'the old one is not touched');
  assert.equal(P.finQueryWith(new URLSearchParams(''), { voucher: 0 }).get('voucher'), '0', 'a zero is a value');
  assert.equal(P.finQueryWith(before, { voucher: undefined }).has('voucher'), false);
  assert.equal(P.finQueryWith(before, {}).toString(), before.toString());
  assert.equal(P.finQueryWith('a=1', { b: 2 }).toString(), 'a=1&b=2', 'text will do as the old one');
  assert.ok(P.finQueryWith(before, { voucher: 9 }) instanceof URLSearchParams);
});

// M4: "No vouchers were posted in this period" is false assurance when it is a search that hid every row.
test('M4: an empty list says no row matches the search when a search is what emptied it, and its own sentence otherwise', () => {
  const ask = (searching, total) => P.finSearchEmpty({ searching, total, none: 'No vouchers were posted in this period.', noun: 'vouchers' });
  assert.equal(ask(true, 5), 'No vouchers match this search.');
  assert.equal(ask(false, 5), 'No vouchers were posted in this period.', 'no search typed');
  assert.equal(ask(true, 0), 'No vouchers were posted in this period.', 'a search cannot be what emptied a list that had nothing in it');
  assert.equal(ask(false, 0), 'No vouchers were posted in this period.');
  assert.equal(P.finSearchEmpty({ searching: true, total: 2, none: 'You have no drafts', noun: 'drafts' }), 'No drafts match this search.');
});

// M3: the exporter prints through a whitelist (lib/exporter.js pdfText) and DROPS what is not on it, silently. A minus sign (U+2212) in
// a column heading printed "DIFFERENCE (TALLY  FINANCE)".
const exporterKeeps = text => !/[^\x20-\x7E\n -ÿ–—·₹→←✓✔✕✗×…‘’“”]/.test(text);
test('M3: what the exporter prints survives its whitelist: the words and figures of every report, and the column headings of every table', () => {
  assert.ok(source('lib/exporter.js').includes(String.raw`.replace(/[^\x20-\x7E\n -ÿ–—·]/g, '')`), 'the whitelist copied above is still the exporter\'s own');
  assert.equal(exporterKeeps('Difference (Tally − Finance)'), false, 'the check does catch the minus sign it was written for');
  assert.equal(exporterKeeps('Difference (Tally minus Finance)'), true);
  const texts = [
    ...Object.values(T.FIN_TB_FOOT), T.FIN_TB_FOOT_NOTE,
    ...R.finTbSummary({ opening_dr: 1, opening_cr: 2, debit: 3, credit: 4, closing_dr: 5, closing_cr: 6 }).flatMap(x => [x.label, x.value]),
    ...R.finStatementSummary({ opening_paise: -150000, total_debit_paise: 20000, total_credit_paise: 45000, closing_paise: 125000 }).flatMap(x => [x.label, x.value]),
    R.finLineText({ ledger_name: 'Alpha Bank', debit_paise: 5, credit_paise: 0 }), R.finPeriodText('2026-04-01', '2026-10-18'),
    R.finLedgerNameNote({ ledger_name: 'A', tally_name: 'B' }), R.finLedgerNameNote({ ledger_name: 'A', tally_name: null }),
    ...Object.values(T.finTbCells({ opening_paise: -5, debit_paise: 1, credit_paise: 2, closing_paise: -6 })),
  ];
  for (const text of texts) assert.ok(exporterKeeps(text), `the exporter would drop a character of: ${text}`);
  for (const f of Object.values(parts)) {
    const text = code(f);
    for (const [, heading] of text.matchAll(/\blabel:\s*'([^']*)'/g)) assert.ok(exporterKeeps(heading), `${f}: the column heading "${heading}" has a character the exporter drops`);
    for (const [, name] of text.matchAll(/\bname:\s*'([^']*)'/g)) assert.ok(exporterKeeps(name), `${f}: the export name "${name}" has a character the exporter drops`);
  }
});

// ── Wiring pins ───────────────────────────────────────────────────────────────────────────────────────────────────
// The screens are JSX and cannot be run here, so the rules that live in them are pinned by reading their source, with the comments
// stripped first so a sentence in a comment never satisfies a pin. Each was shown failing on its own reinstated bug (see the report).

const source = f => readFileSync(new URL(`../../client/src/${f}`, import.meta.url), 'utf8');
const code = f => source(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const PAGE = 'pages/finance/Reports.jsx';
const parts = { tb: 'components/finance/TrialBalance.jsx', ledger: 'components/finance/LedgerStatement.jsx', register: 'components/finance/JournalRegister.jsx',
  parallel: 'components/finance/ParallelRun.jsx' };
const ALL = [PAGE, ...Object.values(parts), 'components/finance/ReportParts.jsx', 'components/finance/useReport.js', 'lib/finance/tb.js', 'lib/finance/reports.js'];
const count = (text, pattern) => (text.match(pattern) || []).length;

test('the pins read real files: every report source exists and says something', () => {
  for (const f of ALL) assert.ok(code(f).length > 400, `${f} was not found, or is empty`);
});

test('nothing in the Reports files loads the exporter or ExcelJS up front, reaches storage, or reads the clock for a day by itself', () => {
  for (const f of ALL) {
    const text = code(f);
    assert.doesNotMatch(text, /from\s+['"][^'"]*(exporter|exceljs)[^'"]*['"]/i, `${f} imports the exporter statically`);
    assert.doesNotMatch(text, /\b(localStorage|sessionStorage)\b/, `${f} reaches storage`);
    assert.doesNotMatch(text, /toISOString\(\)\.slice\(0,\s*10\)/, `${f} makes a day from the clock`);
    assert.doesNotMatch(text, /\bObject\.hasOwn\b/, `${f} uses Object.hasOwn`);
  }
});

test('the page is read in the browser\'s own day, through the shared helper', () => {
  const page = code(PAGE);
  assert.match(page, /import \{ dayOf \} from '\.\.\/\.\.\/lib\/dayOf\.js';/);
  assert.match(page, /finReportRange\(query, dayOf\(new Date\(\)\), book\.books_begin\)/, 'and the default start knows when the books begin (R58)');
});

test('an export is offered through one gate: every report table spreads finExportProps and none names an export prop itself', () => {
  let tables = 0;
  for (const f of Object.values(parts)) {
    const text = code(f);
    tables += count(text, /<DataTable\b/g);
    assert.equal(count(text, /<DataTable\b/g), count(text, /\{\.\.\.(?:\(statement \? )?finExportProps\(book, /g), `${f}: each DataTable gets its export props from finExportProps`);
    assert.doesNotMatch(text, /\bexport(Name|Subtitle|Spec|Gate|Meta|Summary|Columns)=/, `${f} sets an export prop directly, around the gate`);
  }
  assert.equal(tables, 5, 'non-vacuous: the trial balance, the statement, the register and the parallel run\'s two tables');
});

test('the trial balance and the statement never sort, and the Tally rows with no ledger keep the order they came in', () => {
  for (const f of [parts.tb, parts.ledger]) {
    const text = code(f);
    assert.match(text, /const columns = finUnsorted\(\[/, `${f}: its columns go through finUnsorted`);
    assert.doesNotMatch(text, /sortable:\s*true/, `${f} turns a sort on`);
  }
  assert.match(code(parts.parallel), /const unmatchedColumns = finUnsorted\(\[/);
  // The two that ARE worth sorting are left sortable: the register by date, number, type and amount, the parallel run by name and the size of the gap.
  assert.doesNotMatch(code(parts.register), /finUnsorted/);
  assert.match(code(parts.parallel), /sortValue: r => Math\.abs\(r\.difference_paise\)/);
});

test('a period that ends before it starts is never asked for', () => {
  assert.match(code(parts.tb), /const url = problem \? null : /);
  assert.match(code(parts.register), /const url = problem \? null : /);
  assert.match(code(parts.ledger), /const url = status === 'in' && !problem\s*\?/);
  for (const f of [parts.tb, parts.ledger, parts.register]) assert.match(code(f), /const problem = finRangeProblem\(from, to\);/, f);
});

test('every report reads through useReport, which keeps the newest answer for the very request, refreshes on a Finance change, and says when it did not come', () => {
  const hook = code('components/finance/useReport.js');
  assert.match(hook, /useRealtimeRefresh\(load, FINANCE_TABLES, /);
  assert.match(hook, /newestAnswerGate\(\)/);
  assert.match(hook, /const seq = gate\.current\.begin\(\);/, 'every request takes a number');
  assert.match(hook, /if \(!gate\.current\.accept\(seq\)\) return;/, 'an older answer never lands over a newer one');
  assert.match(hook, /finReportShown\(\{ answer, failedUrl \}, url\)/);
  assert.match(hook, /api\.get\(url\)/);
  assert.match(hook, /useEffect\(\(\) => \{ load\(\); \}, \[load, version\]\);/, 'asks again when the page says something changed');
  assert.match(hook, /setFailedUrl\(failed => \(failed === url \? null : failed\)\)/, 'a late success clears only its own failure');
  for (const [name, f] of Object.entries(parts)) {
    assert.ok(count(code(f), /useReport\(/g) >= (name === 'parallel' ? 2 : 1), `${name} reads through useReport`);
    assert.match(code(f), /<LoadNotice failed=\{[^}]+\} shown=\{[^}]+\} what=(?:"[^"]+"|\{[^}]+\}) onRetry=\{[^}]+\}/, `${name} says a report did not come, with a Retry`);
    assert.doesNotMatch(code(f), /api\.get\(/, `${name} asks the server on its own, around the hook`);
  }
  assert.match(code('components/finance/ReportParts.jsx'), /<Button [^>]*onClick=\{onRetry\}[^>]*>Retry<\/Button>/);
  assert.match(code('components/finance/ReportParts.jsx'), /showing the last figures loaded/);
});

test('the Ledger tab asks only for a ledger of this book, and never draws an answer that is of another', () => {
  const text = code(parts.ledger);
  assert.match(text, /finLedgerStatus\(ledgerId, ledgers, listFailed\)/);
  assert.match(text, /finStatementBelongs\(data, book\.id\) \? data : null/);
  assert.match(text, /isn't in \$\{book\.name\}/);
  assert.match(text, /<LedgerPicker bookId=\{book\.id\} ledgers=\{pickable\}/);
  assert.match(text, /active: true/, 'a switched-off ledger can still be looked at');
});

test('the parallel run: red rows held at the top, a way into the ledger, the Tally rows with no ledger listed, and a spot for the upload button', () => {
  const text = code(parts.parallel);
  assert.match(text, /rowClass=\{finParallelRowClass\}/);
  assert.match(text, /pinTop=\{r => r\.difference_paise !== 0\}/);
  assert.match(text, /onLedger\(r\.ledger_id, \{ from: finPeriodStart\(asAt, book\.books_begin\), to: asAt \}\)/);
  assert.match(text, /Tally rows with no Finance ledger/);
  // Task 18 made the button real: a login that may import (capability `import`) is offered ParallelUpload, beside the picker and in the
  // empty state, and a new upload is opened as soon as the list has it. The finance-opening-ui.test.js pins say the rest of it.
  assert.match(text, /import ParallelUpload from '\.\/ParallelUpload\.jsx';/);
  assert.match(text, /const mayImport = finCan\(book\.roles, 'import'\);/, 'the import capability, from the book\'s roles');
  assert.match(text, /const uploadButton = mayImport\s*\?\s*<ParallelUpload book=\{book\} onUploaded=\{async id => \{ await uploads\.reload\(\); setPick\(id\); \}\} \/>\s*:\s*null;/,
    'the new upload is picked once the list has it');
  assert.equal(count(text, /\{uploadButton\}/g), 2, 'drawn where the upload is offered beside the picker and in the empty state');
  assert.doesNotMatch(source(parts.parallel), /Task 18 puts/, 'the comment that said whose the button was has gone with the spot');
  assert.match(text, /No Tally trial balance has been uploaded for \{book\.name\} yet\./);
  assert.match(text, /Upload each month-end Tally trial balance here/, 'with nothing uploaded, a login that may import is told where the upload is');
  assert.match(text, /The accountant uploads each month-end Tally trial balance here/, 'and one that may not is told who does it');
  assert.doesNotMatch(text, /Opening\s+Balances step in Setup/, 'the pointer to the Opening Balances step is gone: the upload is here');
  assert.match(text, /finPickImport\(imports, pick\)/);
  assert.match(text, /columns: exportColumns/);
});

test('the trial balance: a row opens its group or its ledger, the open groups live in the page, and the export is what is on screen', () => {
  const text = code(parts.tb);
  assert.match(text, /finTbRows\(tb, expanded, \{ hideEmpty: !showEmpty \}\)/);
  assert.match(text, /onClick=\{\(\) => onLedger\(row\.id\)\}/);
  assert.match(text, /aria-expanded=\{open\}/);
  assert.match(text, /const holding = useMemo\(\(\) => \(tb \? finTbHolding\(tb\) : new Set\(\)\), \[tb\]\);/);
  assert.match(text, /const cells = r => finTbCells\(r, r\.kind === 'group' && holding\.has\(r\.id\)\);/, 'a group that holds figures but nets to nothing does not look empty (M7)');
  for (const cell of ['opening', 'debit', 'credit', 'closing']) assert.match(text, new RegExp(`render: r => cells\\(r\\)\\.${cell}\\b`), `the ${cell} cell is the pure helper's`);
  assert.match(text, /if \(row\.kind === 'ledger'\) onLedger\(row\.id\);\s*else if \(openable\.has\(row\.id\)\) toggle\(row\.id\);/);
  assert.doesNotMatch(text, /useState\(/, 'what is open belongs to the page, so Back from a ledger finds it open');
  assert.match(code(PAGE), /const \[expanded, setExpanded\] = useState\(\(\) => new Set\(\)\);/);
});

test('the Reports page: five tabs by path, the period and the ledger in the URL, drill-downs that add history and filters that replace it', () => {
  const page = code(PAGE);
  assert.match(page, /export default function Reports\(\{ me, book, setBook \}\)/);
  assert.match(page, /const tab = finReportTab\(useParams\(\)\['\*'\]\);/);
  assert.match(page, /<Tabs tabs=\{FIN_REPORT_TABS\} active=\{tab\} onChange=\{goTab\} \/>/);
  assert.match(page, /const goTab = key => \{\s*const path = finTabMove\(tab, key, query\);\s*if \(path\) navigate\(path\);\s*\};/, 'the tab you are on is not a place to go (M6)');
  for (const key of ['trial-balance', 'ledger', 'journal-register', 'parallel-run', 'self-approved']) assert.match(page, new RegExp(`tab === '${key}'`), key);
  for (const element of ['<TrialBalance', '<LedgerStatement', '<JournalRegister', '<ParallelRun', '<SelfApproved']) assert.ok(page.includes(element), element);
  assert.match(page, /navigate\(finLedgerPath\(id, period\.from, period\.to\)\)/, 'a drill-down is a new place to go Back from');
  assert.match(page, /const change = updates => setQuery\(previous => finQueryWith\(previous, updates\), \{ replace: true \}\);/, 'changing the period or the ledger does not pile up history, through the one helper (M9)');
  assert.doesNotMatch(page, /new URLSearchParams\(previous\)/, 'and the page makes no query string of its own');
  assert.match(page, /const ledgerId = idOf\('ledger'\);/);
  assert.match(page, /\^\\d\+\$/, 'an id in the URL is whole digits or nothing');
});

test('a voucher opens over the report from its URL, in the one detail the Vouchers page uses, and a change made there reloads every report', () => {
  const page = code(PAGE);
  assert.match(page, /<VoucherDetail id=\{voucherId\} me=\{me\} book=\{book\} setBook=\{setBook\}/);
  assert.match(page, /onChanged=\{\(\) => setVersion\(n => n \+ 1\)\}/);
  assert.match(page, /onOpen=\{id => change\(\{ voucher: id \}\)\}/);
  assert.doesNotMatch(page, /onEdit=/, 'a report has no draft to edit');
  assert.match(page, /const shared = \{ book, from, to, onPeriod: change, onVoucher: id => change\(\{ voucher: id \}\), version \};/);
  assert.match(page, /<ParallelRun book=\{book\} onLedger=\{openLedger\} version=\{version\} \/>/);
  for (const f of [parts.tb, parts.ledger, parts.register]) assert.match(code(f), /useReport\(url, version\)/, `${f} asks again when version moves`);
  assert.equal(count(code(parts.parallel), /, version\)/g), 2, 'both of the parallel run\'s reads');
});

test('R57: the trial balance\'s cards and its export use the one set of words, with the note on the cards and in the file', () => {
  const text = code(parts.tb);
  for (const word of ['opening', 'period', 'closing']) assert.match(text, new RegExp(`pair\\(FIN_TB_FOOT\\.${word}, `), `the ${word} card is named by FIN_TB_FOOT`);
  assert.doesNotMatch(text, /pair\('/, 'no card is named by a word of its own');
  assert.match(text, /title=\{FIN_TB_FOOT_NOTE\}/, 'the note is on each card');
  assert.match(text, /meta: \[FIN_TB_FOOT_NOTE\]/, 'and in the file');
  // the export's tiles are named by the same words: each card's heading, then its side (final wave item 13)
  const reports = code('lib/finance/reports.js');
  assert.match(reports, /const heading = key => FIN_TB_FOOT\[key\]\.split\(' · '\)\[0\];/);
  for (const [key, side] of [['opening', 'Dr'], ['opening', 'Cr'], ['period', 'Debit'], ['period', 'Credit'], ['closing', 'Dr'], ['closing', 'Cr']]) {
    assert.match(reports, new RegExp(`tile\\('${key}', '${side}', `), `${key} ${side}`);
  }
});

test('the Ledger tab says when the book\'s ledgers did not load, with a Retry that asks again', () => {
  const text = code(parts.ledger);
  assert.match(text, /const \{ ledgers, failed: listFailed, reload: reloadLedgers \} = useBookLedgers\(book\.id\);/);
  assert.match(text, /<LoadNotice failed=\{listFailed\} shown=\{false\} what="[^"]*ledgers[^"]*" onRetry=\{reloadLedgers\} \/>/);
});

test('M4: the register and the self-approved list hold their search, so the empty line knows when the search emptied them', () => {
  const text = code(parts.register);
  assert.match(text, /const \[search, setSearch\] = useState\(''\);/);
  assert.match(text, /rows\.filter\(r => rowMatches\(r, search\)\)/);
  assert.match(text, /searchValue=\{search\} onSearchChange=\{setSearch\}/);
  assert.doesNotMatch(text, /\bsearchable\b/, 'the table\'s own search would hide rows without saying so');
  assert.match(text, /finSearchEmpty\(\{ searching: search\.trim\(\) !== '', total: rows\.length, none: /);
  assert.match(text, /noun: selfApproved \? 'self-approved vouchers' : 'vouchers'/);
});
