// The Customer-WIP list matcher. These cases ARE the confirm dialog's
// behaviour: which rows count as products, which date rides each row, and
// which verdicts arrive ticked (matched) versus for-the-eye (suggested).
import test from 'node:test';
import assert from 'node:assert/strict';
import { usableRow, rowDate, matchWipRows } from './wip-match.js';

const PRODUCTS = [
  { id: 1, name: 'OVERZYME SYRUP 200ML CARTON', code: 'SW-101', party_item_code: 'OVZ-200' },
  { id: 2, name: 'BISOJOY 5 TABLET INNER CARTON', code: 'SW-102', party_item_code: null },
];

test('headings, totals and furniture are not products', () => {
  for (const t of ['', '   ', 'PENDING WIP LIST AS ON 02/08/2026', 'S.NO PARTICULARS QTY',
                   'TOTAL 45,000', 'Page 2', '1 2 3 4']) {
    assert.equal(usableRow(t), false, JSON.stringify(t));
  }
  assert.equal(usableRow('OVERZYME SYRUP 200ML 12000 05/08/2026'), true);
});

test('the row date is the customer\'s own WIP date, ISO, null when absent', () => {
  assert.equal(rowDate('OVERZYME SYRUP 05/08/2026 12000'), '2026-08-05');
  assert.equal(rowDate('BISOJOY 5 TABLET 3-8-26'), '2026-08-03');
  assert.equal(rowDate('BISOJOY 5 TABLET 12000'), null);
});

test('an exact-ish name matches confidently and carries its date', () => {
  const out = matchWipRows(['OVERZYME SYRUP 200ML CARTON 12000 05/08/2026'], PRODUCTS, []);
  assert.equal(out.length, 1);
  assert.equal(out[0].status, 'matched');
  assert.equal(out[0].product_id, 1);
  assert.equal(out[0].date, '2026-08-05');
});

test('the customer\'s own item code is the surest signal', () => {
  const out = matchWipRows(['OVZ-200 urgent please expedite'], PRODUCTS, []);
  assert.equal(out[0].status, 'matched');
  assert.equal(out[0].product_id, 1);
});

test('a vague row is suggested, not silently marked', () => {
  const out = matchWipRows(['SYRUP CARTON pending'], PRODUCTS, []);
  assert.ok(out.length === 0 || out[0].status !== 'matched',
    'a two-word fragment must never auto-match');
});

test('a serial and a quantity around the name must not sink the match', () => {
  // The exact shape a real WIP row takes once its cells are joined — this
  // scored 0.82 (suggested, not matched) before bare numbers were stripped.
  const out = matchWipRows(['1   OVERZYME SYRUP 200ML CARTON   12000   05/08/2026'], PRODUCTS, []);
  assert.equal(out[0].status, 'matched');
  assert.equal(out[0].product_id, 1);
  assert.equal(out[0].date, '2026-08-05');
});

test('gibberish maps to nothing and headings are skipped entirely', () => {
  const out = matchWipRows(['ZZZZ QQQQ 9999', 'TOTAL 45,000'], PRODUCTS, []);
  assert.ok(out.every(v => v.status === 'none'));
  assert.equal(out.length, 1, 'the TOTAL row must not even reach matching');
});
