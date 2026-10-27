import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { finBootPg, FIN_TEST_GRANTS, FIN_TEST_USERS } from './finance-pg-harness.js';
import { finSetupBooks, finCreateYear, finSetupGrants, FIN_SETUP_ACCOUNTANT, FIN_SETUP_BOOKS, FIN_SETUP_GRANTS } from './finance-setup.js';
import { finAudit } from './finance-audit.js';
import { FIN_GROUP_TEMPLATE } from './finance-groups.js';

// Opt-in: boots its own throwaway Postgres.
//   cd server && FINANCE_PG=1 node --test src/finance-pg-setup.test.js
// The last three tests need no database, so they always run.
const gate = { skip: process.env.FINANCE_PG === '1' ? false : 'set FINANCE_PG=1' };

const SCRIPT = fileURLToPath(new URL('../../scripts/finance-setup.mjs', import.meta.url));

// The URL the harness gave this boot. The script's own default is the developer's local database (port 5439),
// which no test may touch, so a test only ever names a URL it has checked is the throwaway one.
function throwawayUrl() {
  const url = process.env.DATABASE_URL;
  assert.match(url ?? '', /^postgresql:\/\/postgres:postgres@127\.0\.0\.1:\d+\/postgres$/, 'not the harness database');
  assert.notEqual(new URL(url).port, '5439', 'that is the developer database');
  return url;
}

// The Accounts login's email is not kept in this repository (ruling R68: the repository is public). Tests use an invented one.
const ACCOUNTS_EMAIL = 'accounts@fin.test';

// Runs the script as a child process against ONE database, named by the caller. There is deliberately no default. The child gets
// the Accounts login's email only when the test hands it one (`env`), whatever the shell running the tests holds.
function runScript(url, args = [], env = {}) {
  assert.ok(url, 'a test must name the database the script runs against');
  const { NODE_TEST_CONTEXT, FIN_SETUP_ACCOUNTANT_EMAIL, ...inherited } = process.env;   // the runner's marker has no business in a child
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...inherited, DATABASE_URL: url, ...env }, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('setup creates both books once, and a second run creates nothing', gate, async () => {
  const h = await finBootPg('setup', { setup: false });
  try {
    const { finSetupBooks } = await import('./finance-setup.js');
    const { FIN_TEST_GRANTS } = await import('./finance-pg-harness.js');
    const grants = [...FIN_TEST_GRANTS, { email: 'nobody@fin.test', roles: ['viewer'], books: ['CI'] }];
    const run = () => h.db.tx((qc, oc) => finSetupBooks(qc, oc, { grants }));
    const first = await run();
    assert.deepEqual(first.books.map(b => [b.code, b.created]), [['CI', true], ['DP', true]]);
    assert.deepEqual(first.grants.find(g => g.email === 'nobody@fin.test'), { email: 'nobody@fin.test', found: false });
    const count = async () => h.db.one(`SELECT
      (SELECT COUNT(*)::int FROM fin_books) books, (SELECT COUNT(*)::int FROM fin_groups) groups,
      (SELECT COUNT(*)::int FROM fin_ledgers) ledgers, (SELECT COUNT(*)::int FROM fin_approval_rules) rules,
      (SELECT COUNT(*)::int FROM fin_periods) periods, (SELECT COUNT(*)::int FROM fin_access) access,
      (SELECT COUNT(*)::int FROM fin_audit_log) audit`);
    const c1 = await count();
    const grantRows = FIN_TEST_GRANTS.reduce((n, g) => n + g.books.length, 0);   // the unknown email adds none
    assert.deepEqual([c1.books, c1.groups, c1.ledgers, c1.rules, c1.periods, c1.access], [2, 58, 4, 20, 24, grantRows]);
    assert.ok(c1.audit >= 2 + grantRows, 'one setup row per book and one per grant');
    const be = await h.db.q(`SELECT b.code, e.name FROM fin_books b JOIN billing_entities e ON e.id = b.billing_entity_id ORDER BY b.code`);
    assert.deepEqual(be.map(r => [r.code, r.name]), [['CI', 'Colour Impressions'], ['DP', 'Darbi Print Pack']]);
    const st = await h.db.q(`SELECT p.status, COUNT(*)::int n FROM fin_periods p JOIN fin_books b ON b.id=p.book_id
                             WHERE b.code='CI' GROUP BY 1 ORDER BY 1`);
    assert.deepEqual(st.map(r => [r.status, r.n]), [['before_books', 9], ['open', 3]]);
    const second = await run();
    assert.deepEqual(second.books.map(b => b.created), [false, false]);
    assert.deepEqual(await count(), c1);
  } finally { await h.close(); }
});

test('the script dry-runs by default and writes nothing', gate, async () => {
  const h = await finBootPg('setup-script', { setup: false });
  try {
    const { FIN_SETUP_ACCOUNTANT_EMAIL, ...env } = process.env;
    const out = execFileSync(process.execPath, [SCRIPT], { env: { ...env, DATABASE_URL: throwawayUrl() }, encoding: 'utf8' });
    assert.match(out, /DRY RUN — nothing written/);
    assert.equal((await h.db.one('SELECT COUNT(*)::int n FROM fin_books')).n, 0);
  } finally { await h.close(); }
});

// ── Beyond the brief ─────────────────────────────────────────────────────────────────────────

// One throwaway database, walked through in order: each step starts from what the one before left.
test('setup in detail: what it writes, what it refuses, and what a re-run leaves alone', gate, async t => {
  const h = await finBootPg('setup-detail', { setup: false });
  try {
    const run = opts => h.db.tx((qc, oc) => finSetupBooks(qc, oc, opts));
    const q = (sql, params) => h.db.q(sql, params);
    const n = async from => (await h.db.one(`SELECT COUNT(*)::int AS n FROM ${from}`)).n;
    const bookId = async code => (await h.db.one('SELECT id FROM fin_books WHERE code = $1', [code])).id;
    const userId = async email => (await h.db.one('SELECT id FROM users WHERE email = $1', [email])).id;
    const EVERYTHING = ['fin_books', 'fin_years', 'fin_periods', 'fin_groups', 'fin_ledgers', 'fin_approval_rules', 'fin_access', 'fin_audit_log'];

    await t.test('a billing entity that does not exist stops the whole run, and leaves nothing behind', async () => {
      await assert.rejects(
        run({ books: [...FIN_SETUP_BOOKS, { code: 'ZZ', name: 'Zed Works', entity_name: 'No Such Business' }], grants: [] }),
        { message: 'Billing entity "No Such Business" not found' });
      for (const table of EVERYTHING) assert.equal(await n(table), 0, table);
    });

    await t.test('a name that fits two billing entities is refused, not guessed', async () => {
      await q(`INSERT INTO billing_entities (name) VALUES ('Twin Co'), ('twin co')`);
      await assert.rejects(run({ books: [{ code: 'TW', name: 'Twin', entity_name: 'TWIN CO' }], grants: [] }),
        /Billing entity "TWIN CO" matches 2 rows/);
      await q(`DELETE FROM billing_entities WHERE lower(name) = 'twin co'`);
      assert.equal(await n('fin_books'), 0);
    });

    await t.test('the billing entity is matched by name however it is cased, and both books are made', async () => {
      const shouting = FIN_SETUP_BOOKS.map(b => ({ ...b, entity_name: b.entity_name.toUpperCase() }));
      const out = await run({ books: shouting, grants: FIN_TEST_GRANTS });
      assert.deepEqual(out.books.map(b => [b.code, b.created]), [['CI', true], ['DP', true]]);
      assert.ok(out.books.every(b => Number.isInteger(b.id)));
      const rows = await q(`SELECT b.id, b.code, b.name, e.name AS entity, b.books_begin, b.created_by, b.active
                              FROM fin_books b JOIN billing_entities e ON e.id = b.billing_entity_id ORDER BY b.code`);
      assert.deepEqual(rows.map(r => [r.id, r.code, r.name, r.entity, r.books_begin, r.created_by, r.active]), [
        [out.books[0].id, 'CI', 'Colour Impressions', 'Colour Impressions', '2027-01-01', 'system (go-live)', true],
        [out.books[1].id, 'DP', 'Darbi Print Pack', 'Darbi Print Pack', '2027-01-01', 'system (go-live)', true],
      ]);
    });

    await t.test('every book gets Tally\'s group tree: all system, each sub-group under its own book\'s parent', async () => {
      for (const code of ['CI', 'DP']) {
        const rows = await q(`SELECT g.name, p.name AS parent, g.nature, g.affects_gross_profit AS gp, g.sort_order, g.is_system
                                FROM fin_groups g JOIN fin_books b ON b.id = g.book_id
                                LEFT JOIN fin_groups p ON p.id = g.parent_id AND p.book_id = g.book_id
                               WHERE b.code = $1 ORDER BY g.sort_order`, [code]);
        assert.deepEqual(rows.map(r => [r.name, r.parent, r.nature, r.gp, r.sort_order, r.is_system]),
          FIN_GROUP_TEMPLATE.map(g => [g.name, g.parent, g.nature, g.affects_gross_profit, g.sort_order, true]), code);
      }
    });

    await t.test('the two system ledgers: Cash takes hand-typed entries, Profit & Loss A/c does not', async () => {
      for (const code of ['CI', 'DP']) {
        const rows = await q(`SELECT l.name, g.name AS grp, l.manual_entry, l.is_system, l.active, l.code, l.tally_name, l.party_type, l.created_by
                                FROM fin_ledgers l JOIN fin_books b ON b.id = l.book_id
                                JOIN fin_groups g ON g.id = l.group_id AND g.book_id = l.book_id
                               WHERE b.code = $1 ORDER BY l.name`, [code]);
        assert.deepEqual(rows.map(r => [r.name, r.grp, r.manual_entry, r.is_system, r.active]), [
          ['Cash', 'Cash-in-Hand', true, true, true],
          ['Profit & Loss A/c', 'Profit & Loss', false, true, true],
        ], code);
        assert.ok(rows.every(r => r.code === null && r.tally_name === null && r.party_type === null && r.created_by === 'system (go-live)'));
      }
    });

    await t.test('the default approval rules: one lakh on payment and contra, no limit anywhere else', async () => {
      const lakh = ['above_limit', '100000.00'];
      const expected = {
        journal: ['always', null], opening: ['always', null], reversal: ['always', null], credit_note: ['always', null],
        debit_note: ['always', null], payment: lakh, contra: lakh, receipt: ['never', null], sales: ['never', null], purchase: ['never', null],
      };
      for (const code of ['CI', 'DP']) {
        const rows = await q(`SELECT r.rule_key, r.mode, r.limit_amount::text AS lim, r.updated_by FROM fin_approval_rules r
                                JOIN fin_books b ON b.id = r.book_id WHERE b.code = $1`, [code]);
        assert.deepEqual(Object.fromEntries(rows.map(r => [r.rule_key, [r.mode, r.lim]])), expected, code);
        assert.equal(rows.length, 10);
        assert.ok(rows.every(r => r.updated_by === 'system (go-live)'));
      }
    });

    await t.test('FY 2026-27 for each book: April to December before the books, January to March open', async () => {
      const months = [
        [1, 'Apr 2026', '2026-04-01', '2026-04-30', 'before_books'], [2, 'May 2026', '2026-05-01', '2026-05-31', 'before_books'],
        [3, 'Jun 2026', '2026-06-01', '2026-06-30', 'before_books'], [4, 'Jul 2026', '2026-07-01', '2026-07-31', 'before_books'],
        [5, 'Aug 2026', '2026-08-01', '2026-08-31', 'before_books'], [6, 'Sep 2026', '2026-09-01', '2026-09-30', 'before_books'],
        [7, 'Oct 2026', '2026-10-01', '2026-10-31', 'before_books'], [8, 'Nov 2026', '2026-11-01', '2026-11-30', 'before_books'],
        [9, 'Dec 2026', '2026-12-01', '2026-12-31', 'before_books'], [10, 'Jan 2027', '2027-01-01', '2027-01-31', 'open'],
        [11, 'Feb 2027', '2027-02-01', '2027-02-28', 'open'], [12, 'Mar 2027', '2027-03-01', '2027-03-31', 'open'],
      ];
      for (const code of ['CI', 'DP']) {
        const years = await q(`SELECT y.label, y.short, y.start_date, y.end_date FROM fin_years y JOIN fin_books b ON b.id = y.book_id WHERE b.code = $1`, [code]);
        assert.deepEqual(years.map(y => [y.label, y.short, y.start_date, y.end_date]), [['2026-27', '2627', '2026-04-01', '2027-03-31']], code);
        const rows = await q(`SELECT p.month_no, p.label, p.start_date, p.end_date, p.status, p.status_changed_by, p.status_changed_at, y.label AS year
                                FROM fin_periods p JOIN fin_books b ON b.id = p.book_id JOIN fin_years y ON y.id = p.year_id AND y.book_id = p.book_id
                               WHERE b.code = $1 ORDER BY p.start_date`, [code]);
        assert.deepEqual(rows.map(p => [p.month_no, p.label, p.start_date, p.end_date, p.status]), months, code);
        assert.ok(rows.every(p => p.year === '2026-27' && p.status_changed_by === null && p.status_changed_at === null));
      }
    });

    await t.test('access rows carry the roles and the export flag of each grant', async () => {
      const rows = await q(`SELECT u.email, b.code, a.roles, a.can_export, a.granted_by FROM fin_access a
                              JOIN users u ON u.id = a.user_id JOIN fin_books b ON b.id = a.book_id ORDER BY u.email, b.code`);
      const by = 'system (go-live)';
      assert.deepEqual(rows.map(r => [r.email, r.code, r.roles, r.can_export, r.granted_by]), [
        ['acct@fin.test', 'CI', ['accountant'], true, by], ['acct@fin.test', 'DP', ['accountant'], true, by],
        ['appr2@fin.test', 'CI', ['approver'], true, by],
        ['dp@fin.test', 'DP', ['accountant'], true, by],
        ['md@fin.test', 'CI', ['approver', 'admin'], true, by], ['md@fin.test', 'DP', ['approver', 'admin'], true, by],
        ['viewer@fin.test', 'CI', ['viewer'], false, by],
      ]);
    });

    await t.test('the audit trail: a setup row and a year row per book, a grant row per grant, all by the system', async () => {
      const rows = await q(`SELECT a.entity, a.action, a.entity_id, a.user_id, a.user_name, a.reason, a.before, a.after, b.code
                              FROM fin_audit_log a JOIN fin_books b ON b.id = a.book_id ORDER BY a.id`);
      const tally = {};
      for (const r of rows) tally[`${r.entity}/${r.action}`] = (tally[`${r.entity}/${r.action}`] ?? 0) + 1;
      assert.deepEqual(tally, { 'book/setup': 2, 'year/create': 2, 'access/grant': 7 });
      assert.ok(rows.every(r => r.user_id === null && r.user_name === 'system (go-live)' && r.reason === null && r.before === null));

      const ci = await bookId('CI');
      const entity = (await h.db.one(`SELECT id FROM billing_entities WHERE name = 'Colour Impressions'`)).id;
      const setup = rows.find(r => r.entity === 'book' && r.code === 'CI');
      assert.equal(setup.entity_id, ci);
      assert.deepEqual(setup.after, {
        code: 'CI', name: 'Colour Impressions', billing_entity_id: entity, books_begin: '2027-01-01',
        groups: 29, ledgers: 2, rules: 10, year: '2026-27', periods: 12,
      });
      const year = rows.find(r => r.entity === 'year' && r.code === 'CI');
      assert.deepEqual(year.after, { label: '2026-27', short: '2627', start_date: '2026-04-01', end_date: '2027-03-31', before_books: 9, open: 3 });

      const grant = rows.find(r => r.entity === 'access' && r.after.email === 'viewer@fin.test');
      assert.equal(grant.code, 'CI');
      assert.deepEqual(grant.after, { user_id: await userId('viewer@fin.test'), email: 'viewer@fin.test', roles: ['viewer'], can_export: false });
      const access = await h.db.one(`SELECT id FROM fin_access WHERE user_id = $1`, [await userId('viewer@fin.test')]);
      assert.equal(grant.entity_id, access.id);
    });

    await t.test('a grant on a row that exists adds roles, never removes one, and can only tighten export', async () => {
      const acct = FIN_TEST_USERS.acct.email;
      const row = () => h.db.one(`SELECT a.id, a.roles, a.can_export, a.updated_at FROM fin_access a
                                    JOIN users u ON u.id = a.user_id JOIN fin_books b ON b.id = a.book_id WHERE u.email = $1 AND b.code = 'CI'`, [acct]);
      const accessAudits = () => n(`fin_audit_log WHERE entity = 'access'`);
      const was = await accessAudits();

      const out = await run({ grants: [{ email: acct, roles: ['viewer'], books: ['CI'], can_export: false }] });
      assert.deepEqual(out.grants, [{ email: acct, found: true, books: [
        { code: 'CI', outcome: 'changed', changed: { roles_added: ['viewer'], can_export: { from: true, to: false } } },
      ] }]);
      const merged = await row();
      assert.deepEqual([merged.roles, merged.can_export], [['viewer', 'accountant'], false]);   // the union, in the order of FIN_ROLES
      assert.equal(await accessAudits(), was + 1);
      const last = await h.db.one(`SELECT entity_id, before, after FROM fin_audit_log WHERE entity = 'access' ORDER BY id DESC LIMIT 1`);
      const id = await userId(acct);
      assert.equal(last.entity_id, merged.id);
      assert.deepEqual(last.before, { user_id: id, email: acct, roles: ['accountant'], can_export: true });
      assert.deepEqual(last.after, { user_id: id, email: acct, roles: ['viewer', 'accountant'], can_export: false });

      // The same grant again, and one that asks for export ON and for a role already held: nothing to change.
      const again2 = await run({ grants: [{ email: acct, roles: ['viewer'], books: ['CI'], can_export: false }, { email: acct, roles: ['accountant'], books: ['CI'] }] });
      assert.deepEqual(again2.grants.map(g => g.books), [[{ code: 'CI', outcome: 'unchanged' }], [{ code: 'CI', outcome: 'unchanged' }]]);
      assert.equal(await accessAudits(), was + 1, 'an unchanged grant writes no audit row');
      const again = await row();
      assert.deepEqual([again.roles, again.can_export, again.updated_at], [merged.roles, merged.can_export, merged.updated_at]);
      const dp = await h.db.one(`SELECT a.roles, a.can_export FROM fin_access a JOIN users u ON u.id = a.user_id JOIN fin_books b ON b.id = a.book_id
                                  WHERE u.email = $1 AND b.code = 'DP'`, [acct]);
      assert.deepEqual([dp.roles, dp.can_export], [['accountant'], true], 'the other book was not named, so it is untouched');
    });

    await t.test('an email nobody has, or only a switched-off login has, is reported and skipped; case does not matter', async () => {
      await q(`UPDATE users SET active = 0 WHERE email = $1`, [FIN_TEST_USERS.plant.email]);
      const out = await run({ grants: [
        { email: 'nobody@fin.test', roles: ['viewer'], books: ['CI'] },
        { email: FIN_TEST_USERS.plant.email, roles: ['viewer'], books: ['CI'] },
        { email: FIN_TEST_USERS.md.email.toUpperCase(), roles: ['approver'], books: ['CI'] },
      ] });
      assert.deepEqual(out.grants.map(g => [g.email, g.found]),
        [['nobody@fin.test', false], [FIN_TEST_USERS.plant.email, false], [FIN_TEST_USERS.md.email.toUpperCase(), true]]);
      assert.equal(await n(`fin_access a JOIN users u ON u.id = a.user_id WHERE u.email = '${FIN_TEST_USERS.plant.email}'`), 0);
    });

    await t.test('two logins whose emails differ only by case are not guessed between', async () => {
      const md = FIN_TEST_USERS.md.email;
      const was = await n('fin_audit_log');
      await q(`INSERT INTO users (name, email, password_hash, role) VALUES ('Case Twin', $1, 'x', 'viewer')`, [md.toUpperCase()]);
      await assert.rejects(run({ grants: [{ email: md, roles: ['viewer'], books: ['CI'] }] }), /More than one login has the email md@fin\.test/);
      await q(`DELETE FROM users WHERE email = $1`, [md.toUpperCase()]);
      assert.equal(await n('fin_audit_log'), was);
    });

    await t.test('a grant with a role or a book that does not exist stops the run before it writes anything', async () => {
      const was = await n('fin_audit_log');
      const md = FIN_TEST_USERS.md.email;
      await assert.rejects(run({ grants: [{ email: md, roles: ['owner'], books: ['CI'] }] }),
        /Grant for md@fin\.test: roles must be one or more of viewer, accountant, approver, admin \(got: owner\)/);
      await assert.rejects(run({ grants: [{ email: md, roles: [], books: ['CI'] }] }), /Grant for md@fin\.test: roles must be one or more of/);
      await assert.rejects(run({ grants: [{ email: md, roles: ['viewer'], books: ['CI', 'XX'] }] }),
        /Grant for md@fin\.test names XX, which is not a book being set up/);
      await assert.rejects(run({ grants: [{ roles: ['viewer'], books: ['CI'] }] }), /A grant needs an email/);
      assert.equal(await n('fin_audit_log'), was);
    });

    await t.test('a book that exists is left exactly as it is: renames, edited rules and a month moved to closing all survive a re-run', async () => {
      const ci = await bookId('CI');
      await q(`UPDATE billing_entities SET name = 'Colour Impressions Pvt Ltd' WHERE name = 'Colour Impressions'`);   // so it can no longer be found by name
      await q(`UPDATE fin_groups SET name = 'Trade Receivables' WHERE book_id = $1 AND name = 'Sundry Debtors'`, [ci]);
      await q(`UPDATE fin_ledgers SET name = 'Cash Box' WHERE book_id = $1 AND name = 'Cash'`, [ci]);
      await q(`UPDATE fin_approval_rules SET mode = 'never', limit_amount = NULL WHERE book_id = $1 AND rule_key = 'payment'`, [ci]);
      await q(`UPDATE fin_periods SET status = 'closing', status_changed_by = 'someone' WHERE book_id = $1 AND start_date = '2027-01-01'`, [ci]);
      const dump = async () => Object.fromEntries(await Promise.all(EVERYTHING.map(async tbl => [tbl, await q(`SELECT * FROM ${tbl} ORDER BY id`)])));
      const before = await dump();

      const out = await run();                       // the defaults: both books, and the MD's grant, to a login this database does not have
      assert.deepEqual(out.books.map(b => [b.code, b.created]), [['CI', false], ['DP', false]]);
      assert.deepEqual(out.grants, FIN_SETUP_GRANTS.map(g => ({ email: g.email, found: false })));
      assert.deepEqual(await dump(), before);
      assert.equal(await n(`fin_groups WHERE book_id = ${ci} AND name = 'Sundry Debtors'`), 0, 'a renamed group is not made again');
      assert.equal(await n(`fin_ledgers WHERE book_id = ${ci} AND name = 'Cash'`), 0, 'a renamed system ledger is not made again');
    });

    await t.test('finCreateYear: a later year is all open, an earlier one all before the books, a mid-month start splits at a month end', async () => {
      const ci = await bookId('CI');
      const md = h.users.md;
      const make = (label, booksBegin, actor = { id: md.id, name: 'Test MD' }) =>
        h.db.tx((qc, oc) => finCreateYear(qc, oc, { bookId: ci, label, booksBegin, actor }));

      const next = await make('2027-28', '2027-01-01');
      assert.equal(next.created, true);
      assert.deepEqual([next.year.label, next.year.short, next.year.start_date, next.year.end_date], ['2027-28', '2728', '2027-04-01', '2028-03-31']);
      assert.deepEqual(next.year.periods.map(p => p.month_no), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      assert.deepEqual(next.year.periods.map(p => p.start_date).slice(0, 2), ['2027-04-01', '2027-05-01']);
      assert.ok(next.year.periods.every(p => p.status === 'open' && p.year_id === next.year.id && p.book_id === ci));
      const audit = await q(`SELECT action, user_id, user_name, book_id, after FROM fin_audit_log WHERE entity = 'year' AND entity_id = $1`, [next.year.id]);
      assert.deepEqual(audit.map(a => [a.action, a.user_id, a.user_name, a.book_id]), [['create', md.id, 'Test MD', ci]]);
      assert.deepEqual(audit[0].after.open, 12);

      const again = await make('2027-28', '2027-01-01');
      assert.deepEqual([again.created, again.year.id, again.year.periods.length], [false, next.year.id, 12]);
      assert.equal(await n(`fin_audit_log WHERE entity = 'year' AND entity_id = ${next.year.id}`), 1);
      assert.equal(await n(`fin_periods WHERE year_id = ${next.year.id}`), 12);

      const earlier = await make('2025-26', '2027-01-01');
      assert.ok(earlier.year.periods.every(p => p.status === 'before_books'));
      // A month is before the books only if it ENDS before they begin: six months of each, whichever day of October it is.
      const sixAndSix = [...Array(6).fill('before_books'), ...Array(6).fill('open')];
      for (const [label, begin] of [['2030-31', '2030-10-15'], ['2033-34', '2033-10-01'], ['2032-33', '2032-10-31']]) {
        const y = await make(label, begin);
        assert.deepEqual(y.year.periods.map(p => p.status), sixAndSix, `${label} with the books beginning ${begin}`);
      }

      await assert.rejects(make('2027-29', '2027-01-01'), /not a financial year/);
      await assert.rejects(make('2031-32', '2027-1-1'), /not a date/);
      await assert.rejects(make('2031-32', '2027-01-01', null), /Setup needs to know who is acting/);
      assert.equal(await n(`fin_years WHERE label = '2031-32'`), 0);
    });

    await t.test('finAudit stores objects and arrays as JSON and an absent value as NULL', async () => {
      const ci = await bookId('CI');
      const md = h.users.md;
      await h.db.tx(qc => finAudit(qc, { bookId: ci, entity: 'sample', entityId: 7, action: 'edit', userId: md.id, userName: 'Test MD',
        reason: 'typo', before: { lines: [1, 2] }, after: [{ a: 1 }] }));
      await h.db.tx(qc => finAudit(qc, { bookId: ci, entity: 'sample', action: 'bare', userName: 'system' }));
      const rows = await q(`SELECT action, entity_id, user_id, user_name, reason, before, after, jsonb_typeof(before) AS bt, jsonb_typeof(after) AS at
                              FROM fin_audit_log WHERE entity = 'sample' ORDER BY id`);
      assert.deepEqual(rows.map(r => [r.action, r.entity_id, r.user_id, r.user_name, r.reason, r.before, r.bt, r.after, r.at]), [
        ['edit', 7, md.id, 'Test MD', 'typo', { lines: [1, 2] }, 'object', [{ a: 1 }], 'array'],
        ['bare', null, null, 'system', null, null, null, null, null],
      ]);
    });
  } finally { await h.close(); }
});

test('the script writes with --apply, then adds nothing on a re-run, and grants the MD and the Accounts login', gate, async () => {
  const h = await finBootPg('setup-script-apply', { setup: false });
  try {
    const MD = FIN_SETUP_GRANTS[0].email;          // the MD's login, as the defaults name it (already public in the repository)
    for (const [name, email] of [['Test MD Login', MD], ['Test Accounts Login', ACCOUNTS_EMAIL]]) {
      await h.db.q(`INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, 'x', 'admin')`, [name, email]);
    }
    const escaped = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const url = throwawayUrl();
    const accounts = { FIN_SETUP_ACCOUNTANT_EMAIL: ACCOUNTS_EMAIL };
    const counts = () => h.db.one(`SELECT
      (SELECT COUNT(*)::int FROM fin_books) books, (SELECT COUNT(*)::int FROM fin_groups) groups,
      (SELECT COUNT(*)::int FROM fin_ledgers) ledgers, (SELECT COUNT(*)::int FROM fin_approval_rules) rules,
      (SELECT COUNT(*)::int FROM fin_periods) periods, (SELECT COUNT(*)::int FROM fin_access) access,
      (SELECT COUNT(*)::int FROM fin_audit_log) audit`);
    const none = { books: 0, groups: 0, ledgers: 0, rules: 0, periods: 0, access: 0, audit: 0 };

    // A book whose billing entity has gone stops the run, and --apply commits none of it: not even the book before it.
    await h.db.q(`UPDATE billing_entities SET name = 'Darbi Print Pack (renamed)' WHERE name = 'Darbi Print Pack'`);
    const failed = runScript(url, ['--apply'], accounts);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /Rolled back — nothing was written\./);
    assert.match(failed.stderr, /Billing entity "Darbi Print Pack" not found/);
    assert.deepEqual({ ...(await counts()) }, none);
    await h.db.q(`UPDATE billing_entities SET name = 'Darbi Print Pack' WHERE name = 'Darbi Print Pack (renamed)'`);

    const dry = runScript(url, [], accounts);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /DRY RUN — nothing written\. Re-run with --apply to write it\./);
    assert.match(dry.stdout, /CI\s+Colour Impressions\s+would be created/);
    assert.match(dry.stdout, new RegExp(`Accounts\\s+${escaped(ACCOUNTS_EMAIL)}, from FIN_SETUP_ACCOUNTANT_EMAIL`), 'the dry run says whom it would grant');
    assert.match(dry.stdout, new RegExp(`${escaped(ACCOUNTS_EMAIL)}\\s+CI\\s+accountant\\s+would be added`));
    assert.deepEqual({ ...(await counts()) }, none);

    const applied = runScript(url, ['--apply'], accounts);
    assert.equal(applied.status, 0, applied.stderr);
    assert.doesNotMatch(applied.stdout, /DRY RUN/);
    assert.match(applied.stdout, /Database\s+postgresql:\/\/postgres:\*\*\*@127\.0\.0\.1:\d+\/postgres/, 'the password is masked');
    assert.match(applied.stdout, /CI\s+Colour Impressions\s+created/);
    assert.match(applied.stdout, /DP\s+Darbi Print Pack\s+created/);
    for (const code of ['CI', 'DP']) {
      assert.match(applied.stdout, new RegExp(`${escaped(MD)}\\s+${code}\\s+approver, admin\\s+added`));
      assert.match(applied.stdout, new RegExp(`${escaped(ACCOUNTS_EMAIL)}\\s+${code}\\s+accountant\\s+added`));
    }
    const c1 = await counts();
    const every = finSetupGrants(ACCOUNTS_EMAIL);
    const grantRows = every.reduce((n, g) => n + g.books.length, 0);
    assert.deepEqual({ ...c1 }, { books: 2, groups: 58, ledgers: 4, rules: 20, periods: 24, access: grantRows, audit: c1.audit });
    const grants = await h.db.q(`SELECT u.email, b.code, a.roles, a.can_export, a.granted_by FROM fin_access a
                                   JOIN users u ON u.id = a.user_id JOIN fin_books b ON b.id = a.book_id`);
    const byKey = (a, b) => `${a[0]} ${a[1]}`.localeCompare(`${b[0]} ${b[1]}`);
    assert.deepEqual(grants.map(g => [g.email, g.code, g.roles, g.can_export, g.granted_by]).sort(byKey),
      every.flatMap(g => g.books.map(code => [g.email, code, [...g.roles], true, 'system (go-live)'])).sort(byKey));

    const again = runScript(url, ['--apply'], accounts);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /CI\s+Colour Impressions\s+already set up/);
    assert.match(again.stdout, new RegExp(`${escaped(MD)}\\s+DP\\s+approver, admin\\s+unchanged`), 'a re-run says it changed nothing');
    assert.deepEqual({ ...(await counts()) }, c1);

    // A revoked default grant comes back on a re-run, and the run says so (the runbook note in the script's header).
    await h.db.q(`DELETE FROM fin_access WHERE user_id = (SELECT id FROM users WHERE email = $1) AND book_id = (SELECT id FROM fin_books WHERE code = 'DP')`, [ACCOUNTS_EMAIL]);
    const restored = runScript(url, ['--apply'], accounts);
    assert.equal(restored.status, 0, restored.stderr);
    assert.match(restored.stdout, new RegExp(`${escaped(ACCOUNTS_EMAIL)}\\s+DP\\s+accountant\\s+added`));
    assert.match(restored.stdout, new RegExp(`${escaped(ACCOUNTS_EMAIL)}\\s+CI\\s+accountant\\s+unchanged`));
  } finally { await h.close(); }
});

// Ruling R68: the Accounts login's email is not in the repository. --apply needs it from FIN_SETUP_ACCOUNTANT_EMAIL, and refuses
// without it before it connects; a dry run says it is not set and grants the MD alone; an email that is no email is refused either way.
test('the Accounts login comes from FIN_SETUP_ACCOUNTANT_EMAIL: --apply refuses without it, and the dry run says it is unset', gate, async () => {
  const h = await finBootPg('setup-script-accounts', { setup: false });
  try {
    const url = throwawayUrl();
    const n = async () => (await h.db.one('SELECT COUNT(*)::int AS n FROM fin_books')).n;
    for (const env of [{}, { FIN_SETUP_ACCOUNTANT_EMAIL: '' }, { FIN_SETUP_ACCOUNTANT_EMAIL: '   ' }]) {
      const r = runScript(url, ['--apply'], env);
      assert.equal(r.status, 1, JSON.stringify(env));
      assert.match(r.stderr, /Refusing --apply: FIN_SETUP_ACCOUNTANT_EMAIL is not set\./, JSON.stringify(env));
      assert.doesNotMatch(r.stdout + r.stderr, /Database\s/, 'refused before it connects');
    }
    const dry = runScript(url, []);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /Accounts\s+not set: FIN_SETUP_ACCOUNTANT_EMAIL is empty, so this dry run grants the MD alone, and --apply will refuse until it is set\./);
    for (const bad of ['accounts', 'two words@fin.test', 'a@b@c']) {
      for (const args of [[], ['--apply']]) {
        const r = runScript(url, args, { FIN_SETUP_ACCOUNTANT_EMAIL: bad });
        assert.equal(r.status, 1, `${bad} ${args}`);
        assert.match(r.stderr, /FIN_SETUP_ACCOUNTANT_EMAIL is not an email address/, `${bad} ${args}`);
      }
    }
    assert.equal(await n(), 0, 'nothing was written');
  } finally { await h.close(); }
});

// Ruling R5's "re-run safe", made visible (final review I-5): each grant on each book says what the run did to it. A grant that
// gains a role keeps who granted it first; a revoked one (its row deleted) is added again, and says so.
test('setup says what it did to each grant on each book: added, changed and how, or unchanged; granted_by stays its first', gate, async () => {
  const h = await finBootPg('setup-outcomes', { setup: false });
  try {
    const run = (grants, actor) => h.db.tx((qc, oc) => finSetupBooks(qc, oc, { grants, ...(actor ? { actor } : {}) }));
    const row = code => h.db.one(`SELECT a.roles, a.can_export, a.granted_by FROM fin_access a JOIN users u ON u.id = a.user_id
                                   JOIN fin_books b ON b.id = a.book_id WHERE u.email = $1 AND b.code = $2`, [FIN_TEST_USERS.acct.email, code]);
    const acct = FIN_TEST_USERS.acct.email;                  // a login the harness made, with no grant yet (setup is off)

    const first = await run([{ email: acct, roles: ['accountant'], books: ['CI', 'DP'] }]);
    assert.deepEqual(first.grants, [{ email: acct, found: true, books: [{ code: 'CI', outcome: 'added' }, { code: 'DP', outcome: 'added' }] }]);

    const same = await run([{ email: acct, roles: ['accountant'], books: ['CI', 'DP'] }], 'someone else');
    assert.deepEqual(same.grants[0].books, [{ code: 'CI', outcome: 'unchanged' }, { code: 'DP', outcome: 'unchanged' }]);

    const more = await run([{ email: acct, roles: ['viewer', 'approver'], books: ['CI'] }], 'a later run');
    assert.deepEqual(more.grants[0].books, [{ code: 'CI', outcome: 'changed', changed: { roles_added: ['viewer', 'approver'] } }]);
    assert.deepEqual(await row('CI'), { roles: ['viewer', 'accountant', 'approver'], can_export: true, granted_by: 'system (go-live)' },
      'roles added, and the grant is still the one the first run gave');

    const tighter = await run([{ email: acct, roles: ['accountant'], books: ['DP'], can_export: false }], 'a later run');
    assert.deepEqual(tighter.grants[0].books, [{ code: 'DP', outcome: 'changed', changed: { can_export: { from: true, to: false } } }]);
    assert.equal((await row('DP')).granted_by, 'system (go-live)');

    await h.db.q(`DELETE FROM fin_access WHERE book_id = (SELECT id FROM fin_books WHERE code = 'CI')`);   // revoked, as the app revokes
    const back = await run([{ email: acct, roles: ['accountant'], books: ['CI', 'DP'] }], 'a later run');
    assert.deepEqual(back.grants[0].books, [{ code: 'CI', outcome: 'added' }, { code: 'DP', outcome: 'unchanged' }]);
    assert.deepEqual(await row('CI'), { roles: ['accountant'], can_export: true, granted_by: 'a later run' }, 'a grant made again is the run\'s own');
    const audit = await h.db.q(`SELECT a.action, b.code, a.user_name FROM fin_audit_log a JOIN fin_books b ON b.id = a.book_id
                                 WHERE a.entity = 'access' ORDER BY a.id`);
    assert.deepEqual(audit.map(a => [a.code, a.user_name]), [['CI', 'system (go-live)'], ['DP', 'system (go-live)'], ['CI', 'a later run'],
      ['DP', 'a later run'], ['CI', 'a later run']], 'every grant added or changed is in the log, in the name of the run that did it');
  } finally { await h.close(); }
});

// The harness's own path: finBootPg with setup on calls finSetupBooks with FIN_TEST_GRANTS (Task 3 calls Task 4).
test('a harness boot with setup on has both books and every test grant, the viewer unable to export', gate, async () => {
  const h = await finBootPg('setup-on');
  try {
    const rows = await h.db.q(`SELECT u.email, b.code, a.roles, a.can_export FROM fin_access a
                                 JOIN users u ON u.id = a.user_id JOIN fin_books b ON b.id = a.book_id`);
    const byKey = (a, b) => `${a[0]} ${a[1]}`.localeCompare(`${b[0]} ${b[1]}`);
    const want = FIN_TEST_GRANTS.flatMap(g => g.books.map(code => [g.email, code, g.roles, g.can_export ?? true])).sort(byKey);
    assert.equal(want.length, 7);
    assert.deepEqual(rows.map(r => [r.email, r.code, r.roles, r.can_export]).sort(byKey), want);
    assert.equal(want.find(w => w[0] === FIN_TEST_USERS.viewer.email)[3], false);
    assert.deepEqual((await h.db.q('SELECT code FROM fin_books ORDER BY code')).map(b => b.code), ['CI', 'DP']);
  } finally { await h.close(); }
});

// ── No database needed ───────────────────────────────────────────────────────────────────────

test('the defaults are spec §16 step 6: the two books, the MD\'s grant, the Accounts grant without its email, all of it frozen', () => {
  assert.deepEqual(FIN_SETUP_BOOKS, [
    { code: 'CI', name: 'Colour Impressions', entity_name: 'Colour Impressions' },
    { code: 'DP', name: 'Darbi Print Pack', entity_name: 'Darbi Print Pack' },
  ]);
  // Ruling R68: the MD's address is already public in tracked files; the Accounts login's is not, and comes from the environment.
  assert.deepEqual(FIN_SETUP_GRANTS, [{ email: 'md@motionci.com', roles: ['approver', 'admin'], books: ['CI', 'DP'] }]);
  assert.deepEqual(FIN_SETUP_ACCOUNTANT, { roles: ['accountant'], books: ['CI', 'DP'] });
  assert.ok(!('email' in FIN_SETUP_ACCOUNTANT));
  assert.deepEqual(finSetupGrants(` ${ACCOUNTS_EMAIL} `), [...FIN_SETUP_GRANTS, { email: ACCOUNTS_EMAIL, roles: ['accountant'], books: ['CI', 'DP'] }]);
  for (const none of [undefined, null, '', '   ']) assert.deepEqual(finSetupGrants(none), [...FIN_SETUP_GRANTS], String(none));
  for (const v of [FIN_SETUP_BOOKS, FIN_SETUP_GRANTS, FIN_SETUP_ACCOUNTANT, FIN_SETUP_ACCOUNTANT.roles, FIN_SETUP_ACCOUNTANT.books,
    ...FIN_SETUP_BOOKS, ...FIN_SETUP_GRANTS, ...FIN_SETUP_GRANTS.flatMap(g => [g.roles, g.books])]) {
    assert.ok(Object.isFrozen(v), JSON.stringify(v));
  }
  // and neither file spells the Accounts login's real address (built here in two halves, so this file does not spell it either)
  const real = new RegExp(['accounts', 'motionci'].join('@'), 'i');
  for (const rel of ['./finance-setup.js', '../../scripts/finance-setup.mjs']) {
    assert.doesNotMatch(fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8'), real, rel);
  }
});

// Ruling R74: the books begin on the 1st of a month. The Opening voucher is dated the day before, the last day of the month before,
// and that month ends before the books begin, so it is always before_books (finCreateYear). A day part-way through a month would
// put the opening in a month of the books, and is refused before anything is asked of the database.
test('R74: the books begin on the 1st of a month; any other day is refused before the database is asked anything', async () => {
  const untouched = () => { throw new Error('the database was asked something'); };
  for (const day of ['2027-01-15', '2027-01-02', '2026-12-31', '2027-02-28']) {
    await assert.rejects(finSetupBooks(untouched, untouched, { booksBegin: day, grants: [] }),
      e => e.message === `The books begin on the 1st of a month, and ${day} is not: the Opening voucher is dated the day before they begin, `
        + 'and that day must be the last of a month that comes before the books.', day);
  }
  for (const notADay of ['2027-02-29', '2027-1-1', 'x']) {
    await assert.rejects(finSetupBooks(untouched, untouched, { booksBegin: notADay, grants: [] }), e => !/the database was asked/.test(e.message), notADay);
  }
  // the 1st itself passes the check, and setup goes on to the database
  for (const day of ['2027-01-01', '2027-04-01']) {
    await assert.rejects(finSetupBooks(untouched, untouched, { booksBegin: day, grants: [] }), /the database was asked something/, day);
  }
});

test('setup runs on the qc and oc it is given: neither module nor the script imports db.js or calls the pool', () => {
  const code = rel => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');   // comments may talk about db.js
  for (const rel of ['./finance-setup.js', './finance-audit.js', '../../scripts/finance-setup.mjs']) {
    const src = code(rel);
    assert.doesNotMatch(src, /(?:from|import\s*\()\s*['"`][^'"`]*\bdb\.js['"`]/, `${rel} imports db.js`);
    assert.doesNotMatch(src, /(?<![\w.$])(?:q|one|tx)\s*\(/, `${rel} calls the pool instead of the transaction's qc / oc`);
  }
});

test('the script refuses a database that is not local unless --prod is passed, before it connects', () => {
  for (const url of [
    'postgresql://postgres:password@db.example.invalid:5432/postgres',
    'postgresql://localhost:password@db.example.invalid:5432/postgres',          // "localhost" is the user name here, not the host
    'postgresql://postgres:password@localhost.example.invalid:5432/postgres',    // starts with "localhost" and is not
    'postgresql://postgres:password@0.0.0.0:1/postgres',                         // not on the list, whatever it happens to reach
    'postgresql://postgres:password@localhost:1/cierp?host=db.remote.example.invalid',   // pg connects to ?host=, not to the URL's host
    'postgresql://postgres:password@127.0.0.1:1/cierp?host=10.0.0.9',
    'not a url at all',
  ]) {
    const r = runScript(url, ['--apply'], { FIN_SETUP_ACCOUNTANT_EMAIL: 'accounts@fin.test' });
    assert.equal(r.status, 1, url);
    assert.match(r.stderr, /Refusing a non-local database without --prod/, url);
    assert.doesNotMatch(r.stdout + r.stderr, /password/, 'the password is never echoed');
  }
  // the host it names is the one pg would really use
  assert.match(runScript('postgresql://postgres:password@localhost:1/cierp?host=db.remote.example.invalid', ['--apply']).stderr,
    /host: db\.remote\.example\.invalid/);
  // Past the guard, each of these stops at the connection: nothing listens on port 1, so no database is reached.
  // Local addresses pass on their own, in any case; --prod is what lets the last one through.
  for (const [url, args] of [
    ['postgresql://postgres:password@127.0.0.1:1/postgres', []],
    ['postgresql://postgres:password@LOCALHOST:1/postgres', []],
    ['postgresql://postgres:password@0.0.0.0:1/postgres', ['--prod']],
    ['postgresql://postgres:password@localhost:1/cierp?host=127.0.0.1', []],       // a local ?host= is local
  ]) {
    const r = runScript(url, args);
    assert.equal(r.status, 1, url);
    assert.doesNotMatch(r.stderr, /Refusing/, url);
    assert.match(r.stderr, /Could not connect/, url);
    assert.doesNotMatch(r.stdout + r.stderr, /password/);
  }
});
