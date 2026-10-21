import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { finBootPg } from './finance-pg-harness.js';
import { inspect } from 'node:util';
import { finMapDbError, FIN_SENTENCES } from './finance-errors.js';
import finance from './routes/finance.js';

// finMapDbError on the real thing. finance-errors.test.js feeds it errors shaped the way we believe pg
// shapes them; this file makes the database raise them, so the names it maps on (the unique indexes, the two
// CHECKs, the foreign keys), the SQLSTATEs, and the words that tell a foreign key breaking on a delete from
// one breaking on a write, are the ones Postgres really reports. Opt-in, because it boots its own throwaway
// Postgres:
//   cd server && FINANCE_PG=1 node --test src/finance-pg-errors.test.js
const ON = process.env.FINANCE_PG === '1';
const gate = { skip: ON ? false : 'set FINANCE_PG=1' };

let h;
const BOOK = {};                 // book code -> id
let JAN, DEC;                    // CI's Jan 2027 (open) and Dec 2026 (before the books begin)
let RENT, FREIGHT, DP_CASH;      // ledger ids
const GROUP = {};                // CI group name -> id
let DP_GROUP;                    // a DP group id

const insert = (table, row) => {
  const cols = Object.keys(row);
  return [`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    Object.values(row)];
};
// A voucher of CI, a draft journal unless `extra` says otherwise.
const voucher = (oc, extra = {}) => oc(...insert('fin_vouchers',
  { book_id: BOOK.CI, voucher_type: 'journal', voucher_date: '2027-01-10', ...extra }));
// The columns of a voucher that is posted: a number, a month and a time (fin_vouchers_posted_shape).
const posted = (n, extra = {}) => ({
  status: 'posted', number: `ERR-${n}`, period_id: DEC, voucher_date: '2026-12-31', posted_at: new Date(), ...extra,
});
const line = (qc, voucherId, lineNo, ledgerId, debit, credit) =>
  qc(...insert('fin_voucher_lines', { voucher_id: voucherId, book_id: BOOK.CI, line_no: lineNo, ledger_id: ledgerId, debit, credit }));

const WENT_THROUGH = new Error('the write went through (rolled back)');

// Runs `write` in a transaction that is always rolled back, so nothing a test attempts can be left behind, and
// returns what a route would pass on from the error it raised. The database's checks that wait for COMMIT
// never run in a transaction that rolls back; those go through refusedAtCommit.
async function refused(write) {
  let raw;
  try { await h.db.tx(async (qc, oc) => { await write(qc, oc); throw WENT_THROUGH; }); } catch (e) { raw = e; }
  assert.notEqual(raw, WENT_THROUGH, 'the write went through: nothing refused it');
  return finMapDbError(raw);
}
// Runs `write` in a transaction that commits; the refusal is at COMMIT, which leaves nothing behind.
async function refusedAtCommit(write) {
  let raw;
  try { await h.db.tx(write); } catch (e) { raw = e; }
  assert.ok(raw, 'the transaction committed: nothing refused it');
  return finMapDbError(raw);
}
const describe = e => `${e.message} [${e.code ?? ''} ${e.constraint ?? ''} ${e.detail ?? ''}]`;
// The write is refused as `status code`, in the code's own sentence.
async function expectRefusal(write, status, code, run = refused) {
  const e = await run(write);
  assert.deepEqual([e.status, e.body?.code], [status, code], describe(e));
  assert.equal(e.message, FIN_SENTENCES[code]);
  return e;
}

before(async () => {
  if (!ON) return;
  h = await finBootPg('errors');
  for (const b of await h.db.q('SELECT id, code FROM fin_books')) BOOK[b.code] = b.id;
  const months = await h.db.q('SELECT id, start_date FROM fin_periods WHERE book_id = $1', [BOOK.CI]);
  JAN = months.find(p => p.start_date === '2027-01-01').id;
  DEC = months.find(p => p.start_date === '2026-12-01').id;
  for (const g of await h.db.q('SELECT id, name FROM fin_groups WHERE book_id = $1', [BOOK.CI])) GROUP[g.name] = g.id;
  DP_GROUP = (await h.db.one(`SELECT id FROM fin_groups WHERE book_id = $1 AND name = 'Cash-in-Hand'`, [BOOK.DP])).id;
  DP_CASH = (await h.db.one(`SELECT id FROM fin_ledgers WHERE book_id = $1 AND name = 'Cash'`, [BOOK.DP])).id;
  const ledger = async (name, group) => (await h.db.one(...insert('fin_ledgers', { book_id: BOOK.CI, group_id: GROUP[group], name }))).id;
  RENT = await ledger('Rent', 'Indirect Expenses');
  FREIGHT = await ledger('Freight', 'Direct Expenses');
  probe();                       // the router stays live for the rest of the process; the probe is used by the last tests
});

after(async () => { await h?.close(); });

test('unique indexes: the one live opening, one reversal per voucher, one live posting per document', gate, async () => {
  const opening = await expectRefusal(async (qc, oc) => {
    await voucher(oc, posted(1, { voucher_type: 'opening' }));
    await voucher(oc, posted(2, { voucher_type: 'opening' }));
  }, 409, 'FIN_OPENING_EXISTS');
  assert.equal(opening.cause.constraint, 'fin_vouchers_one_live_opening', 'the database error rides along');

  await expectRefusal(async (qc, oc) => {                       // two reversals of one voucher
    const original = await voucher(oc);
    await voucher(oc, { reversal_of_id: original.id });
    await voucher(oc, { reversal_of_id: original.id });
  }, 409, 'FIN_ALREADY_REVERSED');

  const twice = await expectRefusal(async (qc, oc) => {         // two vouchers marked reversed by the same one (only a posted one is marked)
    const reversal = await voucher(oc);
    await voucher(oc, posted(3, { reversed_by_id: reversal.id }));
    await voucher(oc, posted(4, { reversed_by_id: reversal.id }));
  }, 409, 'FIN_ALREADY_REVERSED');
  assert.equal(twice.cause.constraint, 'fin_vouchers_reversed_by_id_key', 'the UNIQUE on the column has Postgres\' default name');

  await expectRefusal(async (qc, oc) => {                       // one document posted to the books twice
    await voucher(oc, { status: 'submitted', source_type: 'sales_invoice', source_id: 7 });
    await voucher(oc, { status: 'submitted', source_type: 'sales_invoice', source_id: 7 });
  }, 409, 'FIN_SOURCE_POSTED');
});

test('unique indexes: names compared without capitals, one code, one party link per book', gate, async () => {
  await expectRefusal(qc => qc(`INSERT INTO fin_groups (book_id, name, nature) VALUES ($1, 'BANK accounts', 'asset')`, [BOOK.CI]),
    409, 'FIN_DUPLICATE_NAME');
  await expectRefusal(qc => qc(`INSERT INTO fin_ledgers (book_id, group_id, name) VALUES ($1, $2, 'cash')`, [BOOK.CI, GROUP['Cash-in-Hand']]),
    409, 'FIN_DUPLICATE_NAME');
  await expectRefusal(async qc => {
    for (const name of ['Test Alpha', 'Test Beta']) {
      await qc(`INSERT INTO fin_ledgers (book_id, group_id, name, code) VALUES ($1, $2, $3, 'T-1')`, [BOOK.CI, GROUP['Sundry Debtors'], name]);
    }
  }, 409, 'FIN_DUPLICATE_CODE');
  await expectRefusal(async qc => {
    for (const name of ['Test Gamma', 'Test Delta']) {
      await qc(`INSERT INTO fin_ledgers (book_id, group_id, name, party_type, party_id) VALUES ($1, $2, $3, 'customer', 4242)`,
        [BOOK.CI, GROUP['Sundry Debtors'], name]);
    }
  }, 409, 'FIN_PARTY_LINKED');
});

test('check constraints: a line is one side, and a NaN is no amount', gate, async () => {
  const bad = (debit, credit) => async (qc, oc) => { await line(qc, (await voucher(oc)).id, 1, RENT, debit, credit); };
  await expectRefusal(bad(5, 5), 409, 'FIN_BAD_LINE');
  await expectRefusal(bad(0, 0), 409, 'FIN_BAD_LINE');
  await expectRefusal(bad('NaN', 0), 409, 'FIN_BAD_LINE');
  await expectRefusal((qc, oc) => voucher(oc, { total: 'NaN' }), 400, 'FIN_BAD_AMOUNT');
  // nor is an approval rule's limit (final wave item 3)
  const nanLimit = await expectRefusal(qc => qc(`UPDATE fin_approval_rules SET limit_amount = 'NaN' WHERE book_id = $1 AND rule_key = 'payment'`, [BOOK.CI]),
    400, 'FIN_BAD_AMOUNT');
  assert.equal(nanLimit.cause.constraint, 'fin_approval_rules_limit_not_nan');
});

// The two CHECKs the app never meets (it marks only a posted voucher reversed, and makes every reversal a journal): a write that
// breaks one is a bug in its writer, and leaves as the one fixed 500, as fin_vouchers_posted_shape does, never in the database's words.
test('check constraints the app never meets: a draft marked reversed, a reversal that is not a journal', gate, async () => {
  const fixed = async (write, constraint) => {
    const e = await refused(write);
    assert.deepEqual([e.status, e.body, e.message], [500, { code: 'FIN_SERVER_ERROR' }, FIN_SENTENCES.FIN_SERVER_ERROR]);
    assert.deepEqual([e.cause.code, e.cause.constraint], ['23514', constraint]);
  };
  await fixed(async (qc, oc) => { const r = await voucher(oc); await voucher(oc, { reversed_by_id: r.id }); }, 'fin_vouchers_reversed_only_posted');
  await fixed(async (qc, oc) => { const o = await voucher(oc); await voucher(oc, { voucher_type: 'payment', reversal_of_id: o.id }); }, 'fin_vouchers_reversal_is_journal');
});

test('foreign keys: written across books is FIN_WRONG_BOOK, deleted while in use is FIN_IN_USE', gate, async () => {
  await expectRefusal(async (qc, oc) => { await line(qc, (await voucher(oc)).id, 1, DP_CASH, 5, 0); }, 409, 'FIN_WRONG_BOOK');
  await expectRefusal(qc => qc(`INSERT INTO fin_ledgers (book_id, group_id, name) VALUES ($1, $2, 'Crossed')`, [BOOK.CI, DP_GROUP]),
    409, 'FIN_WRONG_BOOK');

  // fin_ledgers_group_book_fk is the same constraint in both directions, and the answer differs.
  const groupInUse = await expectRefusal(qc => qc('DELETE FROM fin_groups WHERE id = $1', [GROUP['Cash-in-Hand']]), 409, 'FIN_IN_USE');
  assert.equal(groupInUse.cause.constraint, 'fin_ledgers_group_book_fk');
  await expectRefusal(qc => qc('DELETE FROM fin_groups WHERE id = $1', [GROUP['Current Assets']]), 409, 'FIN_IN_USE');   // sub-groups under it
  await expectRefusal(async (qc, oc) => {                       // a ledger a line uses
    const used = await oc(...insert('fin_ledgers', { book_id: BOOK.CI, group_id: GROUP['Indirect Expenses'], name: 'Used Once' }));
    await line(qc, (await voucher(oc)).id, 1, used.id, 1, 0);
    await qc('DELETE FROM fin_ledgers WHERE id = $1', [used.id]);
  }, 409, 'FIN_IN_USE');

  // A foreign key written wrong in some other way has no word of Finance's: the screen is told the one fixed
  // sentence, never the constraint's name, and the original is kept as cause.
  const stray = await refused((qc, oc) => voucher(oc, { period_id: 999999 }));
  assert.deepEqual([stray.status, stray.body, stray.message], [500, { code: 'FIN_SERVER_ERROR' }, FIN_SENTENCES.FIN_SERVER_ERROR]);
  assert.deepEqual([stray.cause.code, stray.cause.constraint], ['23503', 'fin_vouchers_period_id_fkey']);
});

test('the hard stops arrive with their code in DETAIL, at the statement or at COMMIT, and come out as 409s', gate, async () => {
  // At COMMIT: a voucher posted unbalanced. The error comes out of tx() after its ROLLBACK, still carrying DETAIL.
  const unbalanced = await expectRefusal(async (qc, oc) => {
    const v = await voucher(oc, { total: 100 });
    await line(qc, v.id, 1, RENT, 100, 0);
    await line(qc, v.id, 2, FREIGHT, 0, 90);
    await qc(`UPDATE fin_vouchers SET status = 'posted', number = 'ERR-U', period_id = $2, posted_at = now() WHERE id = $1`, [v.id, JAN]);
  }, 409, 'FIN_UNBALANCED', refusedAtCommit);
  assert.equal(unbalanced.cause.code, 'P0001');
  assert.equal((await h.db.one(`SELECT COUNT(*)::int AS n FROM fin_vouchers WHERE number = 'ERR-U'`)).n, 0, 'nothing of it was kept');

  // At the statement: a posted voucher is deleted.
  const id = await h.db.tx(async (qc, oc) => {
    const v = await voucher(oc, { total: 50 });
    await line(qc, v.id, 1, RENT, 50, 0);
    await line(qc, v.id, 2, FREIGHT, 0, 50);
    await qc(`UPDATE fin_vouchers SET status = 'posted', number = 'ERR-OK', period_id = $2, posted_at = now() WHERE id = $1`, [v.id, JAN]);
    return v.id;
  });
  await expectRefusal(qc => qc('DELETE FROM fin_vouchers WHERE id = $1', [id]), 409, 'FIN_POSTED_IMMUTABLE');

  await expectRefusal(qc => qc(`UPDATE fin_audit_log SET reason = 'edited' WHERE id = (SELECT MIN(id) FROM fin_audit_log)`), 409, 'FIN_AUDIT_APPEND_ONLY');
  await expectRefusal(qc => qc('TRUNCATE fin_audit_log'), 409, 'FIN_NO_TRUNCATE');
});

// The whole way: a database refusal inside a route's transaction, through the route's catch and the real
// central handler in app.js, to the response a browser reads. There is no Finance write route yet to send
// one through, so the test adds a probe to the finance router, which app.js has mounted and which stays live.
const probe = () => finance.get('/finance/__probe/:what', async (req, res, next) => {
  try {
    await h.db.tx(async qc => {
      switch (req.params.what) {
        case 'duplicate':        // a refusal Finance has a word for
          for (let i = 0; i < 2; i++) await qc(`INSERT INTO fin_ledgers (book_id, group_id, name) VALUES ($1, $2, 'Probe')`, [BOOK.CI, GROUP['Sundry Debtors']]);
          break;
        case 'not-null':         // and four it has not
          await qc(`INSERT INTO fin_ledgers (book_id, name) VALUES ($1, 'Probe')`, [BOOK.CI]);
          break;
        case 'unique':
          for (let i = 0; i < 2; i++) await qc(`INSERT INTO fin_vouchers (book_id, voucher_type, voucher_date, number) VALUES ($1, 'journal', '2027-01-10', 'PROBE-1')`, [BOOK.CI]);
          break;
        case 'division':
          await qc('SELECT 1 / 0');
          break;
        case 'connection':
          throw Object.assign(new Error('password authentication failed for user "postgres"'), { code: '28P01' });
        case 'bug': {
          const nothing = null;
          return nothing.id;
        }
      }
    });
    res.json({ ok: true });
  } catch (e) { next(finMapDbError(e)); }
});

// Runs a request with console.error held, so what the central handler logs can be read instead of printed.
async function callLogged(url) {
  const logged = [];
  const real = console.error;
  console.error = (...args) => logged.push(args);
  try { return { res: await h.call('GET', url), logged }; } finally { console.error = real; }
}

test('through the real app: a database refusal reaches the browser as { error, code }', gate, async () => {
  const dup = await h.call('GET', '/finance/__probe/duplicate');
  assert.equal(dup.status, 409);
  assert.deepEqual(dup.body, { error: FIN_SENTENCES.FIN_DUPLICATE_NAME, code: 'FIN_DUPLICATE_NAME' });
  assert.equal((await h.db.one(`SELECT COUNT(*)::int AS n FROM fin_ledgers WHERE name = 'Probe'`)).n, 0, 'the refused write left nothing');
});

// The central handler writes err.message to the browser, so what reaches the browser from a fault nobody
// planned for must be a sentence of ours: the database's own words name its columns, constraints and users.
test('through the real app: anything unplanned reaches the browser as one fixed 500, and the log gets the original', gate, async () => {
  const faults = [
    // [probe, SQLSTATE of the original (or its class), words of the original that must stay out of the response]
    ['not-null', '23502', ['group_id', 'fin_ledgers', 'null value', 'violates']],
    ['unique', '23505', ['fin_vouchers_number_key', 'duplicate key', 'violates']],
    ['division', '22012', ['division by zero']],
    ['connection', '28P01', ['password authentication failed', 'postgres']],
    ['bug', TypeError, ['Cannot read properties of null']],
  ];
  for (const [what, original, words] of faults) {
    const { res, logged } = await callLogged(`/finance/__probe/${what}`);
    assert.equal(res.status, 500, what);
    assert.deepEqual(res.body, { error: FIN_SENTENCES.FIN_SERVER_ERROR, code: 'FIN_SERVER_ERROR' }, `${what}: the sentence and the code, nothing else`);
    for (const word of words) assert.ok(!JSON.stringify(res.body).includes(word), `${what}: "${word}" reached the browser`);

    assert.equal(logged.length, 1, `${what}: the central handler logs it once`);
    const [err] = logged[0];
    if (typeof original === 'string') assert.equal(err.cause.code, original, what);
    else assert.ok(err.cause instanceof original, what);
    assert.ok(inspect(err).includes(words[0]), `${what}: what the log prints carries the original`);
  }
});

// The fault the reviewers reproduced was in the real read routes themselves. A table that is gone makes the
// first query of each one fail with the database's own wording ('relation "fin_books" does not exist').
test('a fault inside a real read route answers the one fixed 500 too', gate, async () => {
  for (const [table, url] of [
    ['fin_books', '/finance/me'],
    ['fin_books', '/finance/books'],
    ['fin_groups', `/finance/books/${BOOK.CI}/groups`],
    ['fin_ledgers', `/finance/books/${BOOK.CI}/ledgers`],
    ['fin_years', `/finance/books/${BOOK.CI}/years`],
  ]) {
    await h.db.q(`ALTER TABLE ${table} RENAME TO ${table}_away`);
    let outcome;
    try { outcome = await callLogged(url); } finally { await h.db.q(`ALTER TABLE ${table}_away RENAME TO ${table}`); }
    const { res, logged } = outcome;
    assert.equal(res.status, 500, url);
    assert.deepEqual(res.body, { error: FIN_SENTENCES.FIN_SERVER_ERROR, code: 'FIN_SERVER_ERROR' }, url);
    assert.ok(!JSON.stringify(res.body).includes(table), `${url}: the table's name reached the browser`);
    assert.equal(logged.length, 1, url);
    assert.equal(logged[0][0].cause.code, '42P01', `${url}: the original is the database's undefined_table`);
    assert.equal((await h.call('GET', url)).status, 200, `${url}: and the table is back`);
  }
});
