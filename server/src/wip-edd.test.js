// Reading the customer's EDD out of their WIP list.
//
// Every test here guards the same failure: taking the WRONG date and writing it
// onto orders.delivery_date, which is what the plant schedules against.
import test from 'node:test';
import assert from 'node:assert/strict';
import { findEddColumn, eddPlan, eddForRow, datesIn, EDD_HEADER_RE, WIP_HEADER_RE } from './wip-edd.js';

const row = (cells, text) => ({ cells, text: text ?? cells.filter(Boolean).join(' ') });

// ── Finding the column ───────────────────────────────────────────────────────

test('a named delivery column is found', () => {
  const rows = [row(['S.No', 'Item', 'Qty', 'Delivery Date'])];
  const f = findEddColumn(rows);
  assert.equal(f.eddCol, 3);
  assert.equal(f.headerIndex, 0);
});

test('EDD in its many spellings', () => {
  for (const h of ['EDD', 'E.D.D.', 'E D D', 'Expected Delivery', 'Due Date',
                   'Dispatch Date', 'Target Date', 'Required By', 'Delivery']) {
    assert.ok(EDD_HEADER_RE.test(h), `${h} should read as a delivery column`);
  }
});

test('the WIP date column is NOT mistaken for the EDD', () => {
  // The whole hazard: two date columns, and taking the wrong one moves every
  // delivery date to the day the customer wrote their list.
  for (const h of ['WIP Date', 'W.I.P', 'AS ON', 'Pending Since', 'Marked']) {
    assert.ok(WIP_HEADER_RE.test(h), `${h} is the WIP date`);
  }
  const rows = [row(['Item', 'WIP Date', 'Delivery Date'])];
  assert.equal(findEddColumn(rows).eddCol, 2, 'must pick delivery, not WIP');
});

test('a sheet with only a bare "Date" column names neither', () => {
  assert.equal(findEddColumn([row(['S.No', 'Item', 'Date'])]), null);
});

test('a product called "Delivery Tablets" far down the sheet is not a header', () => {
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push(row(['1', `ITEM ${i}`, '100']));
  rows.push(row(['21', 'DELIVERY TABLETS 10s', '500']));
  assert.equal(findEddColumn(rows), null, 'only the first rows are scanned');
});

test('a single-cell row is never a header', () => {
  assert.equal(findEddColumn([row(['Delivery Date'])]), null);
});

// ── The plan ─────────────────────────────────────────────────────────────────

test('a headed sheet reads the EDD from its column', () => {
  const rows = [
    row(['S.No', 'Item', 'WIP Date', 'Delivery Date']),
    row(['1', 'NICODUCE 5 TAB', '05/07/2026', '20/08/2026']),
  ];
  const plan = eddPlan(rows);
  assert.equal(plan.mode, 'header');
  assert.equal(eddForRow(rows[1], plan), '2026-08-20', 'the delivery date, not the WIP date');
});

test('a blank cell must not slide the column left', () => {
  // The reason the parser keeps empty cells. With them dropped, the EDD index
  // would land on the quantity and a delivery date would be read off a number.
  const rows = [
    row(['S.No', 'Item', 'WIP Date', 'Delivery Date']),
    { cells: ['1', 'ITEM A', '', '20/08/2026'], text: '1 ITEM A 20/08/2026' },
  ];
  const plan = eddPlan(rows);
  assert.equal(eddForRow(rows[1], plan), '2026-08-20');
});

test('no heading but a consistent second date — offered positionally', () => {
  const rows = [
    row([], '1 ITEM A 1000 05/07/2026 20/08/2026'),
    row([], '2 ITEM B 2000 06/07/2026 21/08/2026'),
    row([], '3 ITEM C 3000 07/07/2026 22/08/2026'),
  ];
  const plan = eddPlan(rows);
  assert.equal(plan.mode, 'positional');
  assert.equal(eddForRow(rows[0], plan), '2026-08-20');
  assert.equal(eddForRow(rows[2], plan), '2026-08-22');
});

test('one stray second date in a one-date file is a typo, not a column', () => {
  // Reading it as an EDD would move a delivery date on the strength of a smudge.
  const rows = [
    row([], '1 ITEM A 05/07/2026'),
    row([], '2 ITEM B 06/07/2026'),
    row([], '3 ITEM C 07/07/2026 08/07/2026'),
    row([], '4 ITEM D 09/07/2026'),
  ];
  assert.equal(eddPlan(rows).mode, 'none');
});

test('a file with no dates at all asks for nothing', () => {
  const rows = [row([], '1 ITEM A 1000'), row([], '2 ITEM B 2000')];
  assert.equal(eddPlan(rows).mode, 'none');
  assert.equal(eddForRow(rows[0], eddPlan(rows)), null);
});

test('an absent EDD is null, never today and never a blank string', () => {
  // Null is what leaves the order's existing delivery date alone.
  const plan = { mode: 'header', eddCol: 3 };
  assert.equal(eddForRow({ cells: ['1', 'A', 'x', ''] }, plan), null);
  assert.equal(eddForRow({ cells: ['1', 'A'] }, plan), null);
  assert.equal(eddForRow({ cells: ['1', 'A', 'x', 'not a date'] }, plan), null);
  assert.equal(eddForRow({ cells: [] }, { mode: 'none' }), null);
});

test('the header rule beats the positional one', () => {
  const rows = [
    row(['Item', 'WIP Date', 'Delivery Date']),
    row(['A', '05/07/2026', '20/08/2026']),
    row(['B', '06/07/2026', '21/08/2026']),
  ];
  assert.equal(eddPlan(rows).mode, 'header');
});

// ── Dates in order ───────────────────────────────────────────────────────────

test('datesIn returns every date, in order, as ISO', () => {
  assert.deepEqual(datesIn('1 ITEM 05/07/2026 and 20-08-2026'), ['2026-07-05', '2026-08-20']);
  assert.deepEqual(datesIn('nothing here'), []);
  // Two-digit years expand, day first — every Indian customer sheet.
  assert.deepEqual(datesIn('01/02/26'), ['2026-02-01']);
});

