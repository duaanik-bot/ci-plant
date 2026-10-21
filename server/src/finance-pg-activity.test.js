import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { finBootPg } from './finance-pg-harness.js';

// The activity log's two reads (spec §8.3, ruling R71). Every Finance write appends a row with the record before and after,
// and a voucher's record carries every line: the Opening voucher of a real book has hundreds, and each of its reversals and
// rebuilds adds more such rows. So the LIST sends summaries only (who, when, what, which, why, and a short label), and ONE row's
// before and after come from GET /finance/activity/:id when a person opens it, for a login that reads that row's book; anyone
// else gets 404, as for every route that names a row by its id. The ERP runs on Vercel's Hobby plan, whose response cap is
// 4.5 MB: a list of snapshots measured 1.5 MB with a 1,501-line opening, and 3.5 MB after one reversal and rebuild.
//
// Opt-in, because it boots its own throwaway Postgres:
//   cd server && FINANCE_PG=1 node --test src/finance-pg-activity.test.js
//
// One boot; the tests run in order on what the first one builds. Every name and figure here is invented.
const ON = process.env.FINANCE_PG === '1';
const gate = { skip: ON ? false : 'set FINANCE_PG=1' };

const ACCOUNTS = 480;             // deposit ledgers in the opening, plus one capital account: enough for 500 rows of log
const KB = 1024;

let h, CI, DP;
const OB = {};                    // the first and second Opening vouchers, and the reversal between them

const ok = async call => {
  const r = await call;
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 400));
  return r.body;
};
// A response as the browser receives it: the status, the body's size in bytes, and the body.
async function rawGet(path, who = 'md') {
  const res = await fetch(h.base + path, { headers: { authorization: `Bearer ${h.users[who].token}` } });
  const text = await res.text();
  return { status: res.status, bytes: Buffer.byteLength(text), body: JSON.parse(text) };
}

// Tally's opening balances for CI: ACCOUNTS deposits, Dr, and the capital account that balances them, Cr.
const deposit = i => `Security Deposit ${String(i + 1).padStart(3, '0')}`;
const openingUpload = () => {
  const accounts = [...Array.from({ length: ACCOUNTS }, (_, i) => ({ tally_name: deposit(i), tally_group: 'Deposits (Asset)' })),
    { tally_name: 'Partner Capital A/c', tally_group: 'Capital Account' }];
  const debits = Array.from({ length: ACCOUNTS }, (_, i) => ({ tally_name: deposit(i), debit_paise: 100000 + i, credit_paise: 0 }));
  const total = debits.reduce((sum, r) => sum + r.debit_paise, 0);
  return { book_id: CI, purpose: 'opening', as_at: '2026-12-31', file_names: ['tb.xlsx'], accounts,
    tb: [...debits, { tally_name: 'Partner Capital A/c', debit_paise: 0, credit_paise: total }] };
};
// Upload, confirm every row as the server proposes it, build: the Opening voucher as the build left it.
async function buildOpening() {
  const up = await ok(h.call('POST', '/finance/imports', openingUpload(), 'acct'));
  const matches = up.ledgers.map(r => ({ row_id: r.id, action: r.match_status === 'matched' ? 'match' : r.match_status,
    ledger_id: r.ledger_id, group_id: r.group_id, party_type: r.party_type, party_id: r.party_id }));
  await ok(h.call('PUT', `/finance/imports/${up.import.id}/matches`, { matches }, 'acct'));
  return (await ok(h.call('POST', `/finance/imports/${up.import.id}/build-opening`, null, 'acct'))).voucher;
}

before(async () => {
  if (!ON) return;
  h = await finBootPg('activity');
  ({ CI, DP } = Object.fromEntries((await h.db.q('SELECT id, code FROM fin_books')).map(b => [b.code, b.id])));
  // The Opening voucher built, approved, reversed (as at its own date) and built again: the log's heaviest rows, twice over.
  const first = await buildOpening();
  OB.first = (await ok(h.call('POST', `/finance/vouchers/${first.id}/approve`, null, 'md'))).voucher;
  OB.reversal = (await ok(h.call('POST', `/finance/vouchers/${OB.first.id}/reverse`, { reason: 'rebuilt from Tally' }, 'md'))).voucher;
  const second = await buildOpening();
  OB.second = (await ok(h.call('POST', `/finance/vouchers/${second.id}/approve`, null, 'md'))).voucher;
  // DP's one row of its own, for the book a login cannot read.
  const dpGroup = (await h.db.one(`SELECT id FROM fin_groups WHERE book_id = $1 AND name = 'Indirect Expenses'`, [DP])).id;
  await ok(h.call('POST', '/finance/ledgers', { book_id: DP, group_id: dpGroup, name: 'DP Rent' }, 'dpOnly'));
});

after(async () => { await h?.close(); });

const auditRow = (entity, action, entityId) => h.db.one(
  'SELECT id FROM fin_audit_log WHERE entity = $1 AND action = $2 AND entity_id = $3 ORDER BY id DESC LIMIT 1', [entity, action, entityId]);

test('R71: the list sends summaries, never the records: with a 480-line opening reversed and rebuilt, 500 rows stay under 100 KB', gate, async t => {
  for (const v of [OB.first, OB.reversal, OB.second]) assert.equal(v.status, 'posted');
  assert.equal((await h.db.one('SELECT COUNT(*)::int AS n FROM fin_voucher_lines WHERE voucher_id = $1', [OB.second.id])).n, ACCOUNTS + 1);

  const list = await rawGet(`/finance/activity?book=${CI}`);
  assert.equal(list.status, 200);
  assert.equal(list.body.rows.length, 500, 'a full page of the log: the newest 500 rows');
  assert.ok(list.bytes < 100 * KB, `the list is ${(list.bytes / KB).toFixed(1)} KB`);
  for (const row of list.body.rows) {
    assert.deepEqual(Object.keys(row).sort(), ['action', 'at', 'book_id', 'entity', 'entity_id', 'id', 'label', 'reason', 'user_name'],
      'who, when, what, which, why, and a label: no record before or after');
  }
  // The heavy rows are in it, as summaries with a label a person can read.
  const posted = list.body.rows.find(r => r.entity === 'voucher' && r.action === 'post' && r.entity_id === OB.second.id);
  assert.deepEqual([posted.label, posted.user_name], [OB.second.number, 'Test MD']);
  const reversed = list.body.rows.find(r => r.entity === 'voucher' && r.action === 'reverse' && r.entity_id === OB.first.id);
  assert.deepEqual([reversed.label, reversed.reason], [OB.first.number, 'rebuilt from Tally']);
  const ledger = list.body.rows.find(r => r.entity === 'ledger' && r.action === 'create');
  assert.match(ledger.label, /^(Security Deposit \d{3}|Partner Capital A\/c)$/);

  // …and they are heavy: one of them alone, opened, is more than the whole list.
  const one = await rawGet(`/finance/activity/${(await auditRow('voucher', 'post', OB.second.id)).id}`);
  assert.equal(one.status, 200);
  assert.ok(one.bytes > list.bytes, `one opened row is ${(one.bytes / KB).toFixed(1)} KB, the list ${(list.bytes / KB).toFixed(1)} KB`);
  t.diagnostic(`the list of 500 rows is ${(list.bytes / KB).toFixed(1)} KB; one opened row, the rebuilt opening's post, is ${(one.bytes / KB).toFixed(1)} KB`);
});

test('R71: one row\'s record before and after, for a login that reads its book; 404 for anyone else, as every id route answers', gate, async () => {
  const id = (await auditRow('voucher', 'post', OB.second.id)).id;
  const detail = await ok(h.call('GET', `/finance/activity/${id}`));
  const { row } = detail;
  assert.deepEqual([row.id, row.book_id, row.entity, row.entity_id, row.action, row.user_name, row.label],
    [id, CI, 'voucher', OB.second.id, 'post', 'Test MD', OB.second.number]);
  assert.deepEqual([row.before.status, row.after.status, row.after.number], ['submitted', 'posted', OB.second.number]);
  assert.equal(row.after.lines.length, ACCOUNTS + 1, 'every line, as the log keeps it');
  // The list row and the opened row are the same row.
  const listed = (await ok(h.call('GET', `/finance/activity?book=${CI}`))).rows.find(r => r.id === id);
  const { before: _b, after: _a, ...summary } = row;
  assert.deepEqual(summary, listed);

  // Anyone who reads CI may open it: the viewer too. Nobody else learns the row is there.
  assert.equal((await h.call('GET', `/finance/activity/${id}`, null, 'viewer')).status, 200);
  for (const who of ['dpOnly', 'plant']) {
    const r = await h.call('GET', `/finance/activity/${id}`, null, who);
    assert.deepEqual([r.status, r.body?.code], [404, 'FIN_NOT_FOUND'], who);
  }
  for (const bad of ['999999999', '0', '-1', 'abc', '1e3', '99999999999']) {
    const r = await h.call('GET', `/finance/activity/${bad}`);
    assert.deepEqual([r.status, r.body?.code], [404, 'FIN_NOT_FOUND'], bad);
  }
  // A row of DP's: its own accountant opens it; the CI viewer gets the same 404 as for a row that is not there.
  const dpRow = await h.db.one(`SELECT id FROM fin_audit_log WHERE book_id = $1 AND entity = 'ledger' ORDER BY id DESC LIMIT 1`, [DP]);
  assert.equal((await ok(h.call('GET', `/finance/activity/${dpRow.id}`, null, 'dpOnly'))).row.label, 'DP Rent');
  const hidden = await h.call('GET', `/finance/activity/${dpRow.id}`, null, 'viewer');
  assert.deepEqual([hidden.status, hidden.body?.code], [404, 'FIN_NOT_FOUND']);
  // A row with nothing recorded before or after is still a row: both are null.
  const bare = await h.db.one(`INSERT INTO fin_audit_log (book_id, entity, entity_id, action, user_name) VALUES ($1, 'ledger', 7, 'probe', 'Probe') RETURNING id`, [CI]);
  const probe = (await ok(h.call('GET', `/finance/activity/${bare.id}`))).row;
  assert.deepEqual([probe.before, probe.after, probe.label], [null, null, '#7']);
});
