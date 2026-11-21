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

import { batchesOf, customersOf } from '../../client/src/lib/enquiryUi.js';

test('batchesOf: one batch per mail, typed-in rows by customer and day; counts and money at the first quantity', () => {
  const rows = [
    row(1, 'new', { mail_id: 7, customer_name: 'Acme', mail_received_at: '2026-11-20T10:00:00Z', mail_items: 3 }),
    row(2, 'costed', { mail_id: 7, customer_name: 'Acme', mail_received_at: '2026-11-20T10:00:00Z', mail_items: 3,
      prices: [{ qty: 1000, final: 11, cost: 10 }, { qty: 5000, final: 9, cost: 8 }] }),
    row(3, 'countered', { mail_id: 7, customer_name: 'Acme', mail_received_at: '2026-11-20T10:00:00Z', mail_items: 3,
      prices: [{ qty: 2000, final: 5, cost: 4, theirs: 4.5 }] }),
    row(4, 'sent', { customer_name: 'Bolt', created_at: '2026-11-21T09:00:00Z', prices: [{ qty: 100, final: 2, cost: 1 }] }),
    row(5, 'new', { customer_name: 'Bolt', created_at: '2026-11-21T11:00:00Z' }),
  ];
  const [bolt, acme] = batchesOf(rows);
  assert.equal(bolt.key, 'tbolt|2026-11-21');
  assert.deepEqual(bolt.rows.map(r => r.id), [4, 5]);
  assert.equal(bolt.counts.mailed, 1);
  assert.equal(bolt.counts.to_cost, 1);
  assert.equal(acme.mail_id, 7);
  assert.deepEqual(acme.counts, { to_cost: 1, to_price: 1, counter: 1, quoted: 0, mailed: 0, won: 0, lost: 0 });
  assert.equal(acme.pending, 3);
  assert.equal(acme.value, 11000 + 10000);
  assert.equal(acme.cost, 10000 + 8000);
  assert.equal(acme.profit, 3000);
  assert.equal(acme.pct, (3000 / 18000) * 100);
  assert.equal(acme.asked_pct, -10, 'they ask 4.5 against our 5');
  assert.deepEqual(customersOf(rows), [{ name: 'Acme', n: 3 }, { name: 'Bolt', n: 2 }]);
});

import { composeOrderConfirmation } from './enquiry-desk.js';

test('composeOrderConfirmation: a reply in the thread — items, quantity, rate agreed; never cost, margin or a total', () => {
  const o = { order_no: 'CI-OF-0001', lines: [
    { enquiry_id: 1, product: 'Alpha carton', size: '120 x 40 x 90', qty: 5000, rate: 3.6, cost: 3.1, margin: 0.5, margin_total: 2500, value: 18000 },
    { enquiry_id: 2, product: 'Beta carton', size: null, qty: 2000, rate: 4, cost: 4.2, margin: -0.2, margin_total: -400, value: 8000 },
  ] };
  const r = composeOrderConfirmation(o, { subject: 'Need best rate', sender: 'A Person', specs: { 1: 'FBB 300 gsm, 4 colours' } });
  assert.equal(r.subject, 'Re: Need best rate');
  assert.match(r.text, /^Dear Sir\/Madam,/);
  assert.match(r.text, /confirm/);
  assert.match(r.text, /1\. Alpha carton — 120 x 40 x 90 mm \(FBB 300 gsm, 4 colours\)\n {3}5,000 cartons at Rs\. 3\.60 a carton/);
  assert.match(r.text, /2\. Beta carton\n {3}2,000 cartons at Rs\. 4\.00 a carton/);
  assert.match(r.text, /Regards,\nA Person\nColour Impressions$/);
  for (const body of [r.text, r.html]) {
    assert.doesNotMatch(body, /3\.10|4\.20|2,500|18,000|26,000|margin|loss|total/i, 'nothing internal, no total');
  }
  assert.equal(composeOrderConfirmation(o).subject, 'Order CI-OF-0001 — Colour Impressions', 'no mail: a subject of its own');
});
