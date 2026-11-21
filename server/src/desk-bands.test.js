// The desk's one list (owner, 21 Nov 2026): Pending · Sent · All tabs, and the status band on every row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bandOf, rowsOfTab, whereText } from '../../client/src/lib/enquiryUi.js';

const row = (id, stage, o = {}) => ({ id, stage, ...o });

test('bandOf: every live stage has a band', () => {
  for (const s of ['new', 'ready', 'costing', 'costed', 'price_pending']) assert.equal(bandOf(row(1, s)), 'pending', s);
  // finalised, but no quotation yet (or still with Claude): still with us
  assert.equal(bandOf(row(1, 'quote_ready')), 'pending');
  assert.equal(bandOf(row(1, 'quote_ready', { quotation_id: 4, quotation_status: 'queued' })), 'pending');
  // its reply a draft in Gmail
  assert.equal(bandOf(row(1, 'quote_ready', { quotation_id: 4, quotation_status: 'drafted' })), 'sent');
  // a cancelled quotation is no quotation
  assert.equal(bandOf(row(1, 'quote_ready', { quotation_id: 4, quotation_status: 'cancelled' })), 'pending');
  assert.equal(bandOf(row(1, 'sent')), 'mailed');
  assert.equal(bandOf(row(1, 'countered')), 'counter');
  assert.equal(bandOf(row(1, 'ordered')), 'finalised');
  assert.equal(bandOf(row(1, 'dropped')), null);
});

test('rowsOfTab: Pending holds counters, Sent holds drafts and mailed, All everything but dropped', () => {
  const rows = [row(1, 'new'), row(2, 'countered'), row(3, 'quote_ready', { quotation_id: 9, quotation_status: 'drafted' }),
    row(4, 'sent'), row(5, 'ordered'), row(6, 'dropped'), row(7, 'price_pending')];
  const ids = t => rowsOfTab(t, rows).map(r => r.id);
  assert.deepEqual(ids('pending'), [1, 2, 7]);
  assert.deepEqual(ids('sent'), [3, 4]);
  assert.deepEqual(ids('all'), [1, 2, 3, 4, 5, 7]);
  assert.deepEqual(ids('dropped'), [6]);
  assert.deepEqual(rowsOfTab('pending', null), []);
});

test('whereText names the band', () => {
  assert.equal(whereText('costed'), 'Pending');
  assert.equal(whereText('sent'), 'Mailed');
  assert.equal(whereText('dropped'), 'Dropped');
});

import { bookedPL, decisionOf, decisionSummary } from '../../client/src/lib/enquiryUi.js';
import { shownLine, shownTotals } from '../../client/src/lib/orderUi.js';

test('lost: its own band, red; won and lost are the decisions', () => {
  assert.equal(bandOf(row(1, 'lost')), 'lost');
  assert.equal(decisionOf(row(1, 'ordered')), 'won');
  assert.equal(decisionOf(row(1, 'lost')), 'lost');
  assert.equal(decisionOf(row(1, 'sent')), 'open');
  assert.deepEqual(rowsOfTab('all', [row(1, 'lost'), row(2, 'dropped')]).map(r => r.id), [1]);
  assert.deepEqual(rowsOfTab('sent', [row(1, 'lost')]).map(r => r.id), []);
});

test('bookedPL: the rate agreed against our cost — a carton, on the order, % of cost', () => {
  const won = row(1, 'ordered', { order_line: { qty: 1000, rate: 11, cost: 10 } });
  const p = bookedPL(won);
  assert.equal(p.unit, 1);
  assert.equal(p.total, 1000);
  assert.equal(p.value, 11000);
  assert.equal(p.pct, 10);
  const loss = bookedPL(row(2, 'ordered', { order_line: { qty: 500, rate: 9, cost: 10 } }));
  assert.equal(loss.total, -500);
  assert.equal(loss.pct, -10);
  assert.equal(bookedPL(row(3, 'sent')), null);
});

test('decisionSummary: win rate of the decided, won value and profit booked on cost, lost at the first quantity', () => {
  const rows = [
    row(1, 'ordered', { order_line: { qty: 1000, rate: 11, cost: 10 } }),
    row(2, 'ordered', { order_line: { qty: 500, rate: 9, cost: 10 } }),
    row(3, 'lost', { prices: [{ qty: 2000, final: 5 }, { qty: 5000, final: 4 }] }),
    row(4, 'sent'),
    row(5, 'new'),
  ];
  const d = decisionSummary(rows);
  assert.equal(d.quoted, 4);
  assert.equal(d.open, 1);
  assert.equal(d.won, 2);
  assert.equal(d.lost, 1);
  assert.equal(Math.round(d.win_rate), 67);
  assert.equal(d.won_value, 11000 + 4500);
  assert.equal(d.lost_value, 10000);
  assert.equal(d.booked, 500);
  assert.equal(d.booked_pct, (500 / 15000) * 100);
  assert.equal(d.at_loss, 1);
});

test('the Order finalised panel: profit or loss as a % of cost, line and order', () => {
  const a = shownLine({ qty: 1000, rate: 11, cost: 10 });
  assert.equal(a.margin_pct, 10);
  const b = shownLine({ qty: 1000, rate: 11, cost: 10 }, { rate: '9' });
  assert.equal(b.margin_pct, -10);
  const t = shownTotals([a, shownLine({ qty: 500, rate: 9, cost: 10 })]);
  assert.equal(t.net, 500);
  assert.equal(t.net_pct, (500 / 15000) * 100);
});
