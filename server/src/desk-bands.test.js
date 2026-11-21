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
