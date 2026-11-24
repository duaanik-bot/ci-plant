import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { finBootPg, FIN_TEST_USERS } from './finance-pg-harness.js';

// Two proofs about the edges of Finance (spec §12 and §14), on a real database. Opt-in, because each boots its own
// throwaway Postgres:
//   cd server && FINANCE_PG=1 node --test src/finance-pg-isolation.test.js
//
//   1. Nothing in the rest of the ERP schema depends on Finance. The snapshot lists every column, constraint, index and
//      trigger of every table that is NOT a fin_ table. No such object may name a fin_ thing, and, the stronger half,
//      dropping every fin_ table and function from a bare schema must leave that snapshot exactly as it was. So the
//      ERP's schema neither refers to Finance nor hangs on it, and Finance could be taken out without changing it. This
//      does NOT prove that Finance added nothing to the ERP's tables: a plain new column on customers would pass both
//      halves. That is the static pin's job (finance-migration-pins.test.js reads the migration for every ALTER TABLE,
//      REFERENCES, index and trigger target).
//   2. Every route in routes/finance.js is gated, and the gate refuses in the one way it should. The gates are not all one:
//        • finRequire on the book a route names (in its path, its body or ?book), or on the book of the row it names by id
//          (a group, a ledger, a month, a rule, a grant, a voucher line, a cash count, an HR exception; or the ledger in ?ledger= or
//          a body's ledger_id: the row is looked up first, and a row that is not there gets the same 403 as a book the caller does
//          not hold);
//        • for a route that lists across books with no ?book (the vouchers, the activity log, the access list), the books
//          finBookIdsFor gives the caller: a login with none is refused (403), as the access list is for one that
//          administers none;
//        • for a route that names a voucher, an import or an activity row by its id (the parallel run names its import as
//          ?import=), whether the caller may SEE that row (finSeenBookOf; finVoucherView for a voucher's own read): 404 to
//          anyone with no view on its book, the same answer as for a row that is not there. For eight of them, the writes on a voucher or an import, that is the
//          first of two stages, and finRequire then refuses (403) a caller who sees the row but lacks the right to act.
//      So two logins are swept, each aimed at the gate it can reach:
//        • plant: an admin of the plant with no Finance grant. It is stopped at the FIRST gate of every route, and a route
//          that names a row it cannot see answers exactly 404 FIN_NOT_FOUND: a 403 there would tell it the row exists.
//        • viewer: a view-only login on CI. It sees CI's rows, so it gets past the first gate and meets the second, on
//          every route that asks for more than the right to view: every write, and the admin's access list. A missing
//          finRequire on one of the eight two-stage routes is invisible to plant (the first gate answers before it is
//          reached) and plain to viewer.
//      Both sweeps run against REAL rows (a draft voucher, two imports, an activity row, and one row of every other kind a
//      route names by its id), and a refusal is a status AND its code. Against ids that name nothing, a voucher or import
//      route answers 404 to anyone, md included, so a route that forgot its gate would still pass; and against a status
//      alone, a route that forgot its gate could still answer 403 FIN_NOT_MAKER from the code behind it and pass. The
//      list of routes is read from the router itself, so a route added later is swept without anyone remembering to
//      add it here.
const ON = process.env.FINANCE_PG === '1';
const gate = { skip: ON ? false : 'set FINANCE_PG=1' };

const SNAP = `
  SELECT 'col' k, table_name t, column_name n, data_type d FROM information_schema.columns
   WHERE table_schema='public' AND table_name NOT LIKE 'fin\\_%'
  UNION ALL SELECT 'con', conrelid::regclass::text, conname, pg_get_constraintdef(oid) FROM pg_constraint
   WHERE connamespace='public'::regnamespace AND conrelid <> 0 AND conrelid::regclass::text NOT LIKE 'fin\\_%'
  UNION ALL SELECT 'idx', tablename, indexname, indexdef FROM pg_indexes
   WHERE schemaname='public' AND tablename NOT LIKE 'fin\\_%'
  UNION ALL SELECT 'trg', tgrelid::regclass::text, tgname, pg_get_triggerdef(oid) FROM pg_trigger
   WHERE NOT tgisinternal AND tgrelid::regclass::text NOT LIKE 'fin\\_%'
  ORDER BY 1, 2, 3`;

test('nothing in the rest of the ERP schema depends on Finance', gate, async () => {
  const h = await finBootPg('isolation', { setup: false });
  try {
    const withFinance = await h.db.q(SNAP);
    assert.ok(withFinance.length > 500, `non-vacuous: ${withFinance.length}`);
    assert.deepEqual(withFinance.filter(r => /\bfin_/.test(r.n) || /\bfin_/.test(r.d)), [], 'a fin_ object sits on a non-finance table');
    await h.db.tx(async qc => {
      const tables = (await qc(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'fin\\_%'`)).map(r => r.tablename);
      await qc(`DROP TABLE ${tables.join(', ')} CASCADE`);
      for (const { f } of await qc(`SELECT oid::regprocedure::text f FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'fin\\_%'`))
        await qc(`DROP FUNCTION ${f} CASCADE`);
      assert.deepEqual(await qc(SNAP), withFinance, 'dropping Finance changed the rest of the schema');
      throw Object.assign(new Error('rollback'), { rollback: true });
    }).catch(e => { if (!e.rollback) throw e; });
  } finally { await h.close(); }
});

// A refusal is a status AND its code, and only these two count. A route that forgot its gate can still answer 403 or 400
// from the code behind it (403 FIN_NOT_MAKER, a body it could not read), and neither is the gate speaking. A row the code
// behind could not find answers 404 FIN_NOT_FOUND, the very pair the first gate answers, which is why every id the sweep
// sends names a real row: then only a gate can answer 404.
const FORBIDDEN = [403, 'FIN_FORBIDDEN'];       // finRequire: you may not
const NOT_FOUND = [404, 'FIN_NOT_FOUND'];       // finSeenBookOf / finVoucherView: you cannot see it
const refusedWith = (r, ...allowed) => allowed.some(([status, code]) => r.status === status && r.body?.code === code);
const said = r => `${r.status} ${r.body?.code ?? '(no code)'}`;

// The three routes the plant sweep leaves out: they are for ANY login. Two answer 200 with the caller's own books, an empty
// list for a login with no grant; the third with the day the ERP's own receipt doors hand over to Finance (Cash & Bank spec
// §11), which is no book's figure. They are asserted, not swept.
const OPEN_TO_ANY_LOGIN = ['/finance/me', '/finance/books', '/finance/cash/switch'];
const OPEN_ANSWER = { '/finance/cash/switch': { date: '2027-01-01' } };
// The one read that asks for more than the right to view: the access list is the admin's.
const ADMIN_ONLY_READS = ['/finance/access'];
// The one read sent as a POST, because a Pick's ticks are a list (Cash & Bank spec §6.4): a preview, which writes nothing and asks
// only the right to view. The viewer sweep holds it to that: a view-only login may ask it.
const READS_BY_POST = ['/finance/allocations/preview'];
// The routes there are as this is written (59), less the three above, plus the two lists that are also asked with no ?book
// (NO_BOOK_LISTS). More is fine; fewer means the sweep lost routes.
const SWEPT_FLOOR = 58;
// ...and the routes of those that ask for more than the right to view: twenty-nine writes and the access list.
const ASKS_MORE_FLOOR = 30;
// Routes the sweep must hold by name, each added with the task that made it: a ?book read and a book_id write, which the sweep's
// own query and body reach as they are (Cash & Bank Task 8, the opening corrections; Task 9, the HR & payroll setup, whose two
// writes are the admin's; Task 13, HR's entries: the header line's counts and the exceptions, two reads, and Bring-in and an
// exception's retry, two writes of an accountant's).
const NAMED_ROUTES = [
  'GET /finance/opening-corrections', 'POST /finance/opening-corrections',
  'GET /finance/hr-setup', 'PUT /finance/hr-setup', 'POST /finance/hr-setup/ledgers',
  'GET /finance/hr/status', 'POST /finance/hr/bring-in', 'GET /finance/hr/exceptions', 'POST /finance/hr/exceptions/:id/retry',
];

// Which row a route's :id names, by the start of its path, the first that fits. A route with a parameter this table cannot place
// fails the sweep outright: guessing an id would turn "no right" back into "no such row". A party's open items name a ledger that is
// a party's, so that md can read them at the very URL the sweep sends.
const ID_KIND = [
  ['/finance/groups/', 'group'], ['/finance/ledgers/:id/open-items', 'party'], ['/finance/ledgers/', 'ledger'], ['/finance/periods/', 'period'],
  ['/finance/vouchers/', 'voucher'], ['/finance/approval-rules/', 'rule'], ['/finance/access/', 'access'],
  ['/finance/imports/', 'import'], ['/finance/activity/', 'activity'], ['/finance/lines/', 'line'], ['/finance/cash/counts/', 'count'],
  ['/finance/hr/exceptions/', 'exception'],
];
// The ledger a route's ?ledger= names, where the rest's (a plain ledger) will not do: an account's book is a bank or cash account's,
// a party's statement a party's.
const LEDGER_FOR = { '/finance/cash/book': 'cash', '/finance/cash/counts': 'cash', '/finance/reports/party': 'party' };
// The body a POST is sent, where the rest's ({ book_id }) will not do: a preview names its party's ledger, whose book is the one its
// gate asks about (without one it could only answer 400, gate or no gate).
const BODY_FOR = { '/finance/allocations/preview': ids => ({ ledger_id: ids.party, side: 'credit', amount_paise: 100, mode: 'auto' }) };
// The routes gated first by whether the caller may SEE the row they name (finSeenBookOf): seven on a voucher, three on an
// import, the parallel run (its ?import=) and one activity row. To a login that cannot see the row, exactly 404 FIN_NOT_FOUND.
const SEEN_FIRST = path => /^\/finance\/(vouchers|imports|activity)\/:id(\/|$)/.test(path) || path === '/finance/reports/parallel-run';
const SEEN_FIRST_COUNT = 12;
// The two lists that may be asked with no ?book, across the books a login holds: to a login that holds none, exactly 403.
const NO_BOOK_LISTS = ['/finance/vouchers', '/finance/activity'];

describe('the Finance routes are gated', () => {
  let h, PLAN;

  before(async () => {
    if (!ON) return;
    h = await finBootPg('sweep');
    const CI = (await h.db.one(`SELECT id FROM fin_books WHERE code='CI'`)).id;

    // ── Real rows, made as the accountant through the API, as a person would ──
    const made = async (call, what) => {
      const r = await call;
      assert.equal(r.status, 200, `the sweep could not make ${what}: ${JSON.stringify(r.body)}`);
      return r.body;
    };
    const groups = (await made(h.call('GET', `/finance/books/${CI}/groups`, null, 'acct'), 'a look at the groups')).groups;
    const ledger = async (group, name) => {
      const g = groups.find(x => x.name === group);
      assert.ok(g, `CI has no group called ${group}`);
      return (await made(h.call('POST', '/finance/ledgers', { book_id: CI, group_id: g.id, name }, 'acct'), `the ${name} ledger`)).ledger.id;
    };
    const RENT = await ledger('Indirect Expenses', 'Rent');
    const FREIGHT = await ledger('Direct Expenses', 'Freight');
    const PARTY = await ledger('Sundry Debtors', 'Sweep Test Customer');
    const draft = (await made(h.call('POST', '/finance/vouchers', {
      book_id: CI, voucher_type: 'journal', voucher_date: '2027-01-10', client_key: randomUUID(), narration: 'sweep',
      lines: [{ ledger_id: RENT, debit_paise: 100, credit_paise: 0 }, { ledger_id: FREIGHT, debit_paise: 0, credit_paise: 100 }],
    }, 'acct'), 'a draft voucher')).voucher;
    // An opening import for the routes that name an import, and a month-end one for the parallel run, which takes no other kind.
    const opening = (await made(h.call('POST', '/finance/imports', {
      book_id: CI, purpose: 'opening', as_at: '2026-12-31', file_names: ['tb.xlsx'],
      accounts: [{ tally_name: 'Alpha Bank', tally_group: 'Bank Accounts' }],
      tb: [{ tally_name: 'Alpha Bank', debit_paise: 100000, credit_paise: 0 }],
    }, 'acct'), 'an opening import')).import;
    const monthEnd = (await made(h.call('POST', '/finance/imports', {
      book_id: CI, purpose: 'parallel_tb', as_at: '2027-01-31', file_names: ['tb.xlsx'],
      tb: [{ tally_name: 'Alpha Bank', debit_paise: 100000, credit_paise: 0 }],
    }, 'acct'), 'a month-end import')).import;
    const first = async (what, sql, ...params) => {
      const row = await h.db.one(sql, params);
      assert.ok(row, `CI has no ${what} for the sweep to name`);
      return row.id;
    };
    // A cash count, made as the accountant through the route, for the routes that name one.
    const counted = (await made(h.call('POST', '/finance/cash/counts', {
      book_id: CI, ledger_id: (await h.db.one(`SELECT id FROM fin_ledgers WHERE book_id = $1 AND name = 'Cash'`, [CI])).id,
      count_date: '2027-01-10', counted_paise: 100,
    }, 'acct'), 'a cash count')).count;
    // An HR exception of CI's, for the route that retries one: written as the HR feed writes it (finance-hr-feed.js), for an HR
    // row that is not there, so md's own retry of it could only ever close it.
    const exception = await h.db.one(
      `INSERT INTO fin_hr_exceptions (source_type, source_id, book_id, reason_code, reason, last_tried_at)
       VALUES ('hr_advance', 987654, $1, 'FIN_UNMAPPED_CHANNEL', 'Map this HR pay channel to an account in Finance Setup first.', now())
       RETURNING id`, [CI]);
    const IDS = {
      exception: exception.id,
      count: counted.id,
      group: await first('group', 'SELECT id FROM fin_groups WHERE book_id = $1 ORDER BY id LIMIT 1', CI),
      ledger: RENT,
      period: await first('month', 'SELECT id FROM fin_periods WHERE book_id = $1 ORDER BY start_date DESC LIMIT 1', CI),
      rule: await first('approval rule', 'SELECT id FROM fin_approval_rules WHERE book_id = $1 ORDER BY id LIMIT 1', CI),
      access: await first('grant', 'SELECT a.id FROM fin_access a JOIN users u ON u.id = a.user_id WHERE a.book_id = $1 AND u.email = $2', CI, FIN_TEST_USERS.md.email),
      voucher: draft.id,
      import: opening.id,
      activity: await first('activity row', `SELECT id FROM fin_audit_log WHERE entity = 'voucher' AND action = 'create' AND entity_id = $1`, draft.id),
      line: await first('voucher line', 'SELECT id FROM fin_voucher_lines WHERE voucher_id = $1 ORDER BY line_no LIMIT 1', draft.id),
      party: PARTY,
      cash: await first('cash ledger', `SELECT id FROM fin_ledgers WHERE book_id = $1 AND name = 'Cash'`, CI),
    };
    // Every query parameter any route reads, each a real id or a real date. The dates are there so that a report's own
    // checks pass: a trial balance with no `to` answers 400 to everyone, whatever its gate.
    const queryFor = path => `?book=${CI}&ledger=${IDS[LEDGER_FOR[path]] ?? RENT}&import=${monthEnd.id}&from=2027-01-01&to=2027-01-31`;

    // ── The routes, read from the router ──
    const { default: router } = await import('./routes/finance.js');
    const routes = router.stack.filter(l => l.route).flatMap(l => Object.keys(l.route.methods).map(m => ({ method: m.toUpperCase(), path: l.route.path })));
    for (const path of [...OPEN_TO_ANY_LOGIN, ...ADMIN_ONLY_READS]) {
      assert.ok(routes.some(r => r.method === 'GET' && r.path === path), `GET ${path} is no longer a route; update the lists at the top of this file`);
    }
    for (const path of [...READS_BY_POST, ...Object.keys(BODY_FOR)]) {
      assert.ok(routes.some(r => r.method === 'POST' && r.path === path), `POST ${path} is no longer a route; update the lists at the top of this file`);
    }
    for (const path of Object.keys(LEDGER_FOR)) {
      assert.ok(routes.some(r => r.method === 'GET' && r.path === path), `GET ${path} is no longer a route; update LEDGER_FOR`);
    }
    for (const key of NAMED_ROUTES) {
      assert.ok(routes.some(r => `${r.method} ${r.path}` === key), `${key} is no longer a route; update NAMED_ROUTES`);
    }
    const fill = path => path.replace(/:(\w+)/g, (_, name) => {
      if (name === 'bookId') return String(CI);
      const kind = ID_KIND.find(([prefix]) => path.startsWith(prefix))?.[1];
      assert.ok(name === 'id' && kind, `the sweep cannot tell which row :${name} names in ${path}; add its path to ID_KIND`);
      return String(IDS[kind]);
    });
    const bodyFor = r => (r.method === 'GET' ? null : Object.hasOwn(BODY_FOR, r.path) ? { book_id: CI, ...BODY_FOR[r.path](IDS) } : { book_id: CI });
    PLAN = routes.filter(r => !OPEN_TO_ANY_LOGIN.includes(r.path)).map(r => ({
      ...r, url: fill(r.path) + queryFor(r.path), body: bodyFor(r), seenFirst: SEEN_FIRST(r.path),
    }));
    for (const path of NO_BOOK_LISTS) {
      assert.ok(routes.some(r => r.method === 'GET' && r.path === path), `GET ${path} is no longer a route; update NO_BOOK_LISTS`);
      PLAN.push({ method: 'GET', path: `${path} (no book)`, url: path, body: null, noBook: true });
    }
  });

  after(async () => { await h?.close(); });

  test('every Finance route refuses a plant admin with no Finance grant', gate, async () => {
    // Controls first: the sweep means nothing if the logins or the rows are not what it assumes.
    const me = await h.call('GET', '/finance/me', null, 'md');
    assert.equal(me.status, 200);
    assert.equal(me.body.books.length, 2, 'md holds both books');
    for (const path of OPEN_TO_ANY_LOGIN) {
      const r = await h.call('GET', path, null, 'plant');
      assert.equal(r.status, 200, `${path} answers a login with no grant`);
      if (Object.hasOwn(OPEN_ANSWER, path)) assert.deepEqual(r.body, OPEN_ANSWER[path], `${path} answers plant with that and nothing more`);
      else assert.deepEqual(r.body.books, [], `${path} lists nothing for plant`);
    }
    // And the rows are real: every GET the sweep sends to plant, md can make, at the very same URL. A 404 or a 403 to
    // plant is therefore a refusal of plant, not an id that names nothing.
    const unreadable = [];
    for (const { method, path, url } of PLAN.filter(p => p.method === 'GET')) {
      const r = await h.call(method, url, null, 'md');
      if (r.status !== 200) unreadable.push(`${method} ${path} → ${said(r)}`);
    }
    assert.deepEqual(unreadable, [], 'the sweep must be aimed at rows md can read');

    // A route that names a row it cannot see answers exactly 404, the answer for a row that is not there; a list asked across the
    // books it holds, of which it holds none, answers exactly 403; every other route answers 403 or 404 from its gate.
    assert.equal(PLAN.filter(p => p.seenFirst).length, SEEN_FIRST_COUNT, 'the routes that name a voucher, an import or an activity row');
    const allowed = p => (p.seenFirst ? [NOT_FOUND] : p.noBook ? [FORBIDDEN] : [FORBIDDEN, NOT_FOUND]);
    const bad = [];
    let swept = 0;
    for (const p of PLAN) {
      const r = await h.call(p.method, p.url, p.body, 'plant');
      swept += 1;
      if (!refusedWith(r, ...allowed(p))) bad.push(`${p.method} ${p.path} → ${said(r)}`);
    }
    assert.ok(swept >= SWEPT_FLOOR, `non-vacuous: only ${swept} routes were swept`);
    assert.deepEqual(bad, []);
  });

  test('a view-only login is refused every route that needs more than the right to view', gate, async () => {
    // The control: viewer is a real login that sees CI's voucher and import, so a 403 on a write is the second gate
    // speaking, not a login with no grant at all.
    const own = new Map(PLAN.map(p => [`${p.method} ${p.path}`, p]));
    for (const key of ['GET /finance/vouchers/:id', 'GET /finance/imports/:id', 'GET /finance/activity/:id']) {
      assert.ok(own.has(key), `${key} is no longer a route`);
      const r = await h.call('GET', own.get(key).url, null, 'viewer');
      assert.equal(r.status, 200, `viewer reads ${key}: ${said(r)}`);
    }

    // A read asks only for the right to view, which viewer has: the reads are swept for plant above, and the one read that asks
    // for more is the access list. The preview is a read sent as a POST: viewer may ask it, and it is no write to refuse.
    for (const path of READS_BY_POST) {
      const p = own.get(`POST ${path}`);
      const r = await h.call('POST', p.url, p.body, 'viewer');
      assert.equal(r.status, 200, `viewer may ask POST ${path}, a read: ${said(r)}`);
    }
    const asksMore = PLAN.filter(p => (p.method !== 'GET' && !READS_BY_POST.includes(p.path)) || ADMIN_ONLY_READS.includes(p.path));
    const bad = [];
    for (const { method, path, url, body } of asksMore) {
      const r = await h.call(method, url, body, 'viewer');
      if (!refusedWith(r, FORBIDDEN)) bad.push(`${method} ${path} → ${said(r)}`);
    }
    assert.ok(asksMore.length >= ASKS_MORE_FLOOR, `non-vacuous: only ${asksMore.length} routes ask for more than the right to view`);
    assert.deepEqual(bad, []);
  });
});
