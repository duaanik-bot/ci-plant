// HR ledger routes (routes/hr-ledgers.js: loans, advances, adjustments and the load from the salary workbook)
// through the REAL app over HTTP, against a real Postgres.
//
// Boots its OWN throwaway Postgres in a temp dir on a free port, with PG_POOL_MAX=1 (the Vercel geometry: a pool
// call inside a transaction would hang, and each test has a timeout so a hang fails), runs init() (which replays
// the hr migration) and mounts the real app on a free port. Five logins are made by hand: an ERP admin with NO HR
// access, and an HR viewer, operator, approver and admin. The tests share one story and run in order. Every name,
// code and figure is synthetic, and the salary workbook is built here with exceljs in the July layout.
//
//   HR_PG=1 node --test src/hr-ledgers-routes-pg.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { plantDateStr } from './plant-calendar.js';
import { nextMonth } from './hr/loans.js';

const ENABLED = process.env.HR_PG === '1';
const T = { timeout: 30_000 };

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.unref();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// ── The salary workbook, in the July layout, built here ──
// FINAL SHEET only: MONTH and DAYS above a header on row 4, one row per person below it. Every header is the
// real workbook's spelling (it is structure, not personal data); every value is made up.
const HEAD = ['PERSON', 'CODE NO.', 'FIRM', 'DEPARTMENT', 'TRANS MODE', 'C STAT', 'BASE 2026', 'HP', 'OT', 'AB', 'ANIK',
  'FINAL PAYMENT', 'ADV', 'INST', 'OS', 'OT CRT', 'BASIC', 'MISC.', 'HOLIDAY', 'TOTAL SAL'];
const colOf = (header) => String.fromCharCode(65 + HEAD.indexOf(header));

function finalSheet(ws, people, { top = [['MONTH ', 'July', 2026], ['DAYS ', 31]] } = {}) {
  top.forEach((cells, r) => cells.forEach((value, c) => { ws.getCell(r + 1, c + 1).value = value; }));
  HEAD.forEach((h, c) => { ws.getCell(4, c + 1).value = h; });
  people.forEach((p, i) => {
    const row = 5 + i;
    const base = `${colOf('BASE 2026')}${row}`;
    const absent = `${colOf('AB')}${row}`;
    const cells = {
      PERSON: p.name, 'CODE NO.': p.code, FIRM: p.firm, DEPARTMENT: p.dept, 'TRANS MODE': p.channel, 'BASE 2026': p.base,
      'OT CRT': p.otCrt ?? 8, OT: 0, AB: 0, ANIK: 0, ADV: 0, INST: p.inst ?? 0, OS: p.os ?? 0, 'MISC.': 0,
      BASIC: { formula: `${base}/31*(31-${absent})`, result: p.base },
      HOLIDAY: p.holiday ? { formula: `${base}/30.5*1.5`, result: (p.base / 30.5) * 1.5 } : 0,
      'TOTAL SAL': p.base,
      'FINAL PAYMENT': p.final ?? p.base,
    };
    HEAD.forEach((h, c) => { if (cells[h] !== undefined) ws.getCell(row, c + 1).value = cells[h]; });
  });
}

async function bookOf(people, opts) {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  finalSheet(wb.addWorksheet('FINAL SHEET'), people, opts);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// Three made-up people. ALPHA: a loan with an instalment. BRAVO: a formula holiday, a negative final (an
// advance owed back), the same pay channel as ALPHA spelt in another case. CHARLIE: a loan with no instalment.
const ALPHA = { name: 'TEST ALPHA', code: 901, firm: 'TEST FIRM', dept: 'TESTING', channel: 'Cash', base: 24000, inst: 1500, os: 6000 };
const BRAVO = { name: 'TEST BRAVO', code: 902, firm: 'TEST FIRM', dept: 'PASTING', channel: 'CASH', base: 30000, holiday: true, final: -2500 };
const CHARLIE = { name: 'TEST CHARLIE', code: 903, firm: 'TEST FIRM', dept: 'TESTING', channel: 'Test Bank', base: 18000, os: 3000, inst: 0 };
const DELTA = { name: 'TEST DELTA', code: 904, firm: 'TEST FIRM', dept: 'TESTING', channel: 'Cash', base: 15000 };

describe('HR ledger routes through the real app', {
  skip: ENABLED ? false : 'set HR_PG=1 to boot a throwaway Postgres',
}, () => {
  let epg, dir, db, pool, server, base;
  const ids = {};       // user ids by key
  const tokens = {};    // signed JWTs by key
  let publicAuditBefore;
  let p1, p2, p3;       // people
  let loan1, loan2, loanC, loanD, loanF;
  const NOW = plantDateStr().slice(0, 7);
  const NEXT = nextMonth(NOW);
  const LATER = nextMonth(nextMonth(nextMonth(NEXT)));

  before(async () => {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-ledgers-'));
    const port = await freePort();
    epg = new EmbeddedPostgres({
      databaseDir: dir, port, user: 'postgres', password: 'postgres',
      persistent: false, onLog: () => {}, onError: () => {},
    });
    await epg.initialise();
    await epg.start();
    process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
    process.env.PG_POOL_MAX = '1';
    db = await import('./db.js');
    pool = await db.connect();
    await db.init();
    const { setKnownTables } = await import('./data-tables.js');
    const known = await db.q(`
      SELECT tablename AS name, 'table' AS kind FROM pg_tables WHERE schemaname = 'public'
      UNION ALL SELECT viewname, 'opaque' FROM pg_views WHERE schemaname = 'public'
      UNION ALL SELECT matviewname, 'opaque' FROM pg_matviews WHERE schemaname = 'public'
      UNION ALL SELECT p.proname, 'opaque' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'`);
    setKnownTables(known.filter((t) => t.kind === 'table').map((t) => t.name),
      known.filter((t) => t.kind === 'opaque').map((t) => t.name));

    const { default: jwt } = await import('jsonwebtoken');
    const { JWT_SECRET } = await import('./auth.js');
    const login = async (key, name, role, level) => {
      const u = await db.one(
        `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, 'x', $3) RETURNING id, name, role`,
        [name, `${key}@test.local`, role]);
      ids[key] = u.id;
      tokens[key] = jwt.sign({ id: u.id, name: u.name, role: u.role }, JWT_SECRET);
      if (level) await db.q(`INSERT INTO hr.access (user_id, level, granted_by) VALUES ($1, $2, $1)`, [u.id, level]);
    };
    await login('plain', 'Plain Admin', 'admin', null);          // an ERP admin; HR gives it nothing
    await login('viewer', 'HR Viewer', 'planner', 'viewer');
    await login('operator', 'HR Operator', 'viewer', 'operator');
    await login('approver', 'HR Approver', 'qc', 'approver');
    await login('admin', 'HR Admin', 'viewer', 'admin');

    const person = async (code, name) => (await db.one(`INSERT INTO hr.people (code, name) VALUES ($1, $2) RETURNING id`, [code, name])).id;
    p1 = await person('T-1', 'Test Person One');
    p2 = await person('T-2', 'Test Person Two');
    p3 = await person('T-3', 'Test Person Three');

    const { default: app } = await import('./app.js');
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}/api`;
    publicAuditBefore = (await db.one(`SELECT count(*)::int AS n FROM audit_log`)).n;
  });

  after(async () => {
    try { server?.closeAllConnections?.(); server?.close(); } catch {}
    try { await pool?.end(); } catch {}
    try { await epg?.stop(); } catch {}
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── Helpers ──
  const authOf = (who) => (who ? { authorization: `Bearer ${tokens[who]}` } : {});
  const read = async (res) => {
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, text, headers: res.headers };
  };
  const call = async (who, method, url, body) => read(await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...authOf(who) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  // A multipart POST: the workbook in field `file`, and `decisions` (an object, or text as it is) when given.
  const upload = async (who, url, buffer, decisions, name = 'workbook.xlsx') => {
    const fd = new FormData();
    if (buffer) fd.append('file', new Blob([buffer], { type: XLSX_TYPE }), name);
    if (decisions !== undefined) fd.append('decisions', typeof decisions === 'string' ? decisions : JSON.stringify(decisions));
    return read(await fetch(base + url, { method: 'POST', headers: authOf(who), body: fd }));
  };
  const auditCount = async () => (await db.one(`SELECT count(*)::int AS n FROM hr.audit_log`)).n;
  const lastAudit = (entity, id, action) => db.one(
    `SELECT user_id, user_name, entity, entity_id, action, detail FROM hr.audit_log
      WHERE entity = $1 AND entity_id = $2 AND ($3::text IS NULL OR action = $3) ORDER BY id DESC LIMIT 1`,
    [entity, String(id), action ?? null]);
  const count = async (table, where = 'true') => (await db.one(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)).n;
  // A refusal: the status, and the code when it has one (a plain 400 / 404 has none).
  const refused = (res, status, code) => {
    assert.equal(res.status, status, res.text);
    assert.equal(res.body?.code, code, res.text);
    assert.equal(typeof res.body?.error, 'string', res.text);
    assert.ok(res.body.error.length > 0, res.text);
  };
  // A write that is refused changes nothing and audits nothing.
  const refusedWrite = async (who, method, url, body, status, code) => {
    const before = await auditCount();
    const res = await call(who, method, url, body);
    refused(res, status, code);
    assert.equal(await auditCount(), before, `${method} ${url} was refused but left an audit row`);
    return res;
  };
  // A write that succeeds leaves at least one audit row, in the same breath.
  const audited = async (who, method, url, body) => {
    const before = await auditCount();
    const res = await call(who, method, url, body);
    assert.equal(res.status, 200, `${method} ${url}: ${res.text}`);
    assert.ok((await auditCount()) > before, `${method} ${url} left no audit row`);
    return res;
  };
  const newLoan = (over) => ({
    person_id: p1, principal: 12000, issued_on: `${NOW}-05`, purpose: 'Test purpose', instalment: 3000,
    first_due_month: NEXT, paid_via: 'cash', is_opening: false, ...over,
  });

  // ── The wall ──

  test('no HR access gets 403 HR_NO_ACCESS; a viewer reads but every write is 403 HR_LEVEL; levels above gate their routes', T, async () => {
    const audits = await auditCount();
    for (const url of ['/hr/loans', '/hr/loans/1', '/hr/advances', `/hr/advances/${p1}`, '/hr/adjustments']) {
      refused(await call('plain', 'GET', url), 403, 'HR_NO_ACCESS');
    }
    refused(await call('plain', 'POST', '/hr/loans', newLoan()), 403, 'HR_NO_ACCESS');
    refused(await upload('plain', '/hr/loader/preview', await bookOf([ALPHA])), 403, 'HR_NO_ACCESS');
    assert.equal((await call(null, 'GET', '/hr/loans')).status, 401, 'no token at all is the ERP\'s own 401');

    // The viewer reads (empty so far) ...
    for (const url of ['/hr/loans', '/hr/advances', '/hr/adjustments']) {
      const res = await call('viewer', 'GET', url);
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(res.body, []);
    }
    // ... and cannot write anything.
    const writes = [
      ['POST', '/hr/loans', newLoan()], ['POST', '/hr/loans/1/prepay', { amount: 1 }], ['POST', '/hr/loans/1/holiday', { month: LATER }],
      ['POST', '/hr/loans/1/cancel', {}], ['PUT', '/hr/loans/1/instalment', { instalment: 1, from_month: LATER }],
      ['POST', '/hr/advances', { person_id: p1, amount: 1 }], ['POST', `/hr/advances/${p1}/waive`, { amount: 1 }],
      ['POST', '/hr/adjustments', { person_id: p1, kind: 'earning', amount: 1, start_month: NOW }],
      ['POST', '/hr/adjustments/1/approve', {}], ['POST', '/hr/adjustments/1/cancel', {}],
    ];
    for (const [method, url, body] of writes) refused(await call('viewer', method, url, body), 403, 'HR_LEVEL');
    refused(await upload('viewer', '/hr/loader/preview', await bookOf([ALPHA])), 403, 'HR_LEVEL');
    refused(await upload('viewer', '/hr/loader/apply', await bookOf([ALPHA])), 403, 'HR_LEVEL');

    // Approver-only and admin-only routes refuse the levels below.
    refused(await call('operator', 'POST', `/hr/advances/${p1}/waive`, { amount: 1 }), 403, 'HR_LEVEL');
    refused(await call('operator', 'POST', '/hr/adjustments/1/approve', {}), 403, 'HR_LEVEL');
    refused(await upload('operator', '/hr/loader/preview', await bookOf([ALPHA])), 403, 'HR_LEVEL');
    refused(await upload('approver', '/hr/loader/apply', await bookOf([ALPHA])), 403, 'HR_LEVEL');

    assert.equal(await auditCount(), audits, 'nothing was audited: nothing was written');
    for (const table of ['hr.loans', 'hr.loan_txns', 'hr.advance_txns', 'hr.adjustments', 'hr.pay_channels']) {
      assert.equal(await count(table), 0, `${table} is still empty`);
    }
  });

  // ── Loans ──

  test('a loan is minted CI-LN-0001 with its disbursed row, and the answers are no-store', T, async () => {
    const res = await audited('operator', 'POST', '/hr/loans', newLoan({ interest_rate: 0 }));
    const loan = res.body;
    loan1 = loan.id;
    assert.equal(loan.loan_no, 'CI-LN-0001');
    assert.equal(loan.status, 'active');
    assert.equal(loan.person_id, p1);
    assert.equal(loan.person_code, 'T-1');
    assert.equal(loan.principal, 12000);
    assert.equal(loan.instalment, 3000);
    assert.equal(loan.first_due_month, NEXT);
    assert.equal(loan.issued_on, `${NOW}-05`);
    assert.equal(loan.is_opening, false);
    assert.equal(loan.outstanding, '12000.00');
    assert.equal(loan.due_this_month, '0.00', 'its first month has not come');
    assert.equal(loan.next_due_month, NEXT);
    assert.equal(loan.next_due, '3000.00');

    const txns = await db.q(`SELECT kind, principal_amount::text AS amount, txn_date::text AS txn_date, created_by FROM hr.loan_txns WHERE loan_id = $1`, [loan1]);
    assert.deepEqual(txns, [{ kind: 'disbursed', amount: '12000.00', txn_date: `${NOW}-05`, created_by: ids.operator }]);
    const audit = await lastAudit('loan', loan1, 'create');
    assert.equal(audit.user_id, ids.operator);
    assert.equal(audit.detail.loan_no, 'CI-LN-0001');
    assert.equal(audit.detail.person_id, p1);

    const second = await audited('operator', 'POST', '/hr/loans', newLoan({
      person_id: p2, principal: 6000, instalment: 2000, issued_on: `${NOW}-06`, is_opening: undefined, paid_via: undefined,
    }));
    loan2 = second.body.id;
    assert.equal(second.body.loan_no, 'CI-LN-0002', 'the next number');

    const list = await call('viewer', 'GET', '/hr/loans');
    assert.equal(list.status, 200, list.text);
    assert.deepEqual(list.body.map((l) => l.loan_no).sort(), ['CI-LN-0001', 'CI-LN-0002']);
    assert.equal(list.headers.get('cache-control'), 'no-store');
    assert.equal(list.headers.get('x-data-tables'), null, 'a loan list is never offered to the response cache');
    assert.equal(list.body.find((l) => l.id === loan2).outstanding, '6000.00');
  });

  test('a loan is refused for interest above zero (INTEREST_NOT_YET) and for every bad field; nothing is minted or written', T, async () => {
    const loans = await count('hr.loans');
    refused(await call('operator', 'POST', '/hr/loans', newLoan({ interest_rate: 5 })), 400, 'INTEREST_NOT_YET');
    refused(await call('operator', 'POST', '/hr/loans', newLoan({ interest_rate: '2.5' })), 400, 'INTEREST_NOT_YET');
    refused(await call('operator', 'POST', '/hr/loans', newLoan({ interest: 1 })), 400, 'INTEREST_NOT_YET');
    await refusedWrite('operator', 'POST', '/hr/loans', newLoan({ interest_rate: 'lots' }), 400);
    await refusedWrite('operator', 'POST', '/hr/loans', newLoan({ principal: 0 }), 400);
    await refusedWrite('operator', 'POST', '/hr/loans', newLoan({ principal: 'abc' }), 400);
    await refusedWrite('operator', 'POST', '/hr/loans', newLoan({ principal: 1000.123 }), 400);
    await refusedWrite('operator', 'POST', '/hr/loans', newLoan({ instalment: 0 }), 400);
    await refusedWrite('operator', 'POST', '/hr/loans', newLoan({ instalment: undefined }), 400);
    await refusedWrite('operator', 'POST', '/hr/loans', newLoan({ issued_on: undefined }), 400);
    await refusedWrite('operator', 'POST', '/hr/loans', newLoan({ issued_on: '2026-02-30' }), 400);
    await refusedWrite('operator', 'POST', '/hr/loans', newLoan({ first_due_month: undefined }), 400);
    await refusedWrite('operator', 'POST', '/hr/loans', newLoan({ first_due_month: '2026-13' }), 400);
    await refusedWrite('operator', 'POST', '/hr/loans', newLoan({ first_due_month: '2001-01' }), 400);
    await refusedWrite('operator', 'POST', '/hr/loans', newLoan({ is_opening: 'yes' }), 400);
    await refusedWrite('operator', 'POST', '/hr/loans', newLoan({ person_id: undefined }), 400);
    await refusedWrite('operator', 'POST', '/hr/loans', newLoan({ person_id: 999999 }), 400);
    assert.equal(await count('hr.loans'), loans, 'no loan was saved');
  });

  test('prepaying more than is outstanding is refused; a part prepayment lowers it; prepaying the rest closes the loan', T, async () => {
    await refusedWrite('operator', 'POST', `/hr/loans/${loan1}/prepay`, { amount: 12000.01 }, 400);
    await refusedWrite('operator', 'POST', `/hr/loans/${loan1}/prepay`, { amount: 0 }, 400);
    await refusedWrite('operator', 'POST', `/hr/loans/${loan1}/prepay`, { amount: '-5' }, 400);
    await refusedWrite('operator', 'POST', `/hr/loans/${loan1}/prepay`, { amount: 100, date: 'tomorrow' }, 400);
    await refusedWrite('operator', 'POST', '/hr/loans/999999/prepay', { amount: 1 }, 404);

    const part = await audited('operator', 'POST', `/hr/loans/${loan1}/prepay`, { amount: 2000, date: `${NOW}-07`, note: 'Cash back' });
    assert.equal(part.body.outstanding, '10000.00');
    assert.equal(part.body.status, 'active');
    const audit = await lastAudit('loan', loan1, 'prepay');
    assert.equal(audit.detail.outstanding_before, '12000.00');
    assert.equal(audit.detail.outstanding_after, '10000.00');
    assert.equal(audit.detail.date, `${NOW}-07`);

    const detail = await call('viewer', 'GET', `/hr/loans/${loan1}`);
    assert.equal(detail.status, 200, detail.text);
    assert.deepEqual(detail.body.txns.map((t) => [t.kind, t.principal_amount, t.balance]),
      [['disbursed', '12000.00', '12000.00'], ['prepayment', '2000.00', '10000.00']]);

    const rest = await audited('operator', 'POST', `/hr/loans/${loan1}/prepay`, { amount: '10000' });
    assert.equal(rest.body.outstanding, '0.00');
    assert.equal(rest.body.status, 'closed', 'a prepayment that reaches 0 closes the loan');
    assert.equal((await db.one(`SELECT status FROM hr.loans WHERE id = $1`, [loan1])).status, 'closed');
    assert.equal((await lastAudit('loan', loan1, 'close')).detail.reason, 'prepaid in full');
    refused(await call('operator', 'POST', `/hr/loans/${loan1}/prepay`, { amount: 1 }), 409, 'LOAN_NOT_ACTIVE');
    refused(await call('operator', 'POST', `/hr/loans/${loan1}/holiday`, { month: LATER }), 409, 'LOAN_NOT_ACTIVE');
    refused(await call('operator', 'PUT', `/hr/loans/${loan1}/instalment`, { instalment: 100, from_month: LATER }), 409, 'LOAN_NOT_ACTIVE');
    refused(await call('operator', 'POST', `/hr/loans/${loan1}/cancel`, {}), 409, 'LOAN_NOT_ACTIVE');

    const closed = await call('viewer', 'GET', '/hr/loans?status=closed');
    assert.deepEqual(closed.body.map((l) => l.loan_no), ['CI-LN-0001']);
    assert.equal(closed.body[0].next_due_month, null, 'a closed loan has no next instalment');
    refused(await call('viewer', 'GET', '/hr/loans?status=bogus'), 400);
  });

  test('a repayment holiday in the past is refused; this month or later is kept, shown in the schedule, and asking again is harmless', T, async () => {
    await refusedWrite('operator', 'POST', `/hr/loans/${loan2}/holiday`, { month: '2020-01' }, 400);
    await refusedWrite('operator', 'POST', `/hr/loans/${loan2}/holiday`, { month: nextMonth('2020-01') }, 400);
    await refusedWrite('operator', 'POST', `/hr/loans/${loan2}/holiday`, { month: '2026-8' }, 400);
    await refusedWrite('operator', 'POST', `/hr/loans/${loan2}/holiday`, {}, 400);
    assert.equal(await count('hr.loan_holidays'), 0);

    const made = await audited('operator', 'POST', `/hr/loans/${loan2}/holiday`, { month: NEXT });
    assert.equal(made.body.status, 'active');
    assert.equal((await lastAudit('loan', loan2, 'holiday')).detail.month, NEXT);

    const before = await auditCount();
    const again = await call('operator', 'POST', `/hr/loans/${loan2}/holiday`, { month: NEXT });
    assert.equal(again.status, 200, again.text);
    assert.equal(await auditCount(), before, 'the same holiday twice is one holiday, one audit row');
    assert.equal(await count('hr.loan_holidays'), 1);
    await audited('operator', 'POST', `/hr/loans/${loan2}/holiday`, { month: NOW });
    assert.equal(await count('hr.loan_holidays'), 2, 'the current month is allowed');
    await db.q(`DELETE FROM hr.loan_holidays WHERE loan_id = $1 AND month = $2`, [loan2, NOW]);

    const detail = await call('viewer', 'GET', `/hr/loans/${loan2}`);
    assert.deepEqual(detail.body.holidays, [NEXT]);
    // 6000 at 2000 a month from NEXT, with NEXT a holiday: nothing that month, then three instalments.
    assert.deepEqual(detail.body.schedule.map((s) => s.status), ['holiday', 'projected', 'projected', 'projected']);
    assert.deepEqual(detail.body.schedule.map((s) => s.due), ['0.00', '2000.00', '2000.00', '2000.00']);
    assert.equal(detail.body.schedule[0].month, NEXT);
    assert.equal(detail.body.schedule.at(-1).closing, '0.00');
    assert.equal(detail.body.loan.next_due_month, nextMonth(NEXT), 'the holiday month is not the next instalment');
  });

  test('an instalment change is audited with the old value, applies to the loan, and warns when it is dated later than a payroll can use it', T, async () => {
    await refusedWrite('operator', 'PUT', `/hr/loans/${loan2}/instalment`, { instalment: 0, from_month: NEXT }, 400);
    await refusedWrite('operator', 'PUT', `/hr/loans/${loan2}/instalment`, { instalment: 1500 }, 400);
    await refusedWrite('operator', 'PUT', `/hr/loans/${loan2}/instalment`, { instalment: 1500, from_month: 'next' }, 400);

    const changed = await audited('operator', 'PUT', `/hr/loans/${loan2}/instalment`, { instalment: 1500, from_month: NEXT });
    assert.equal(changed.body.instalment, 1500);
    assert.equal(changed.body.warning, undefined, 'it starts with the first payroll that can take it');
    const audit = await lastAudit('loan', loan2, 'instalment');
    assert.deepEqual([audit.detail.from_month, audit.detail.from, audit.detail.to], [NEXT, '2000.00', '1500.00']);
    assert.equal(audit.user_id, ids.operator);

    const later = await audited('operator', 'PUT', `/hr/loans/${loan2}/instalment`, { instalment: 1000, from_month: LATER });
    assert.equal(later.body.instalment, 1000);
    assert.match(later.body.warning, new RegExp(`${NEXT}.*${LATER}`), 'the warning says which month it really starts');
    const audit2 = await lastAudit('loan', loan2, 'instalment');
    assert.deepEqual([audit2.detail.from_month, audit2.detail.from, audit2.detail.to], [LATER, '1500.00', '1000.00']);

    const before = await auditCount();
    assert.equal((await call('operator', 'PUT', `/hr/loans/${loan2}/instalment`, { instalment: '1000.00', from_month: NEXT })).status, 200);
    assert.equal(await auditCount(), before, 'the same instalment again changes nothing');
    assert.equal((await db.one(`SELECT instalment::text AS i FROM hr.loans WHERE id = $1`, [loan2])).i, '1000.00');
    await db.q(`UPDATE hr.loans SET instalment = 2000 WHERE id = $1`, [loan2]);
  });

  test('cancel is refused after a recovery or a prepayment; a loan with neither is cancelled and reads 0; the schedule is projectSchedule', T, async () => {
    // Loan C: lent in May, first instalment June, and payroll for June (finalised) took 1000 of it.
    const c = await audited('operator', 'POST', '/hr/loans', newLoan({
      person_id: p3, principal: 5000, instalment: 1000, issued_on: '2026-05-15', first_due_month: '2026-06',
    }));
    loanC = c.body.id;
    const june = await db.one(`INSERT INTO hr.runs (month, status, days_in_month, finalised_at) VALUES ('2026-06', 'finalised', 30, now()) RETURNING id`);
    await db.q(`INSERT INTO hr.loan_txns (loan_id, txn_date, kind, principal_amount, run_id) VALUES ($1, '2026-06-30', 'payroll_recovery', 1000, $2)`, [loanC, june.id]);

    const detail = await call('viewer', 'GET', `/hr/loans/${loanC}`);
    assert.equal(detail.status, 200, detail.text);
    assert.equal(detail.body.loan.outstanding, '4000.00');
    assert.equal(detail.body.loan.due_this_month, '1000.00');
    assert.equal(detail.body.loan.next_due_month, '2026-07', 'June is recovered; July is next');
    assert.deepEqual(detail.body.txns.map((t) => [t.kind, t.run_month, t.balance]),
      [['disbursed', null, '5000.00'], ['payroll_recovery', '2026-06', '4000.00']]);
    assert.deepEqual(detail.body.schedule, [
      { month: '2026-06', opening: '5000.00', due: '1000.00', recovered: '1000.00', closing: '4000.00', status: 'recovered' },
      { month: '2026-07', opening: '4000.00', due: '1000.00', recovered: '0.00', closing: '3000.00', status: 'projected' },
      { month: '2026-08', opening: '3000.00', due: '1000.00', recovered: '0.00', closing: '2000.00', status: 'projected' },
      { month: '2026-09', opening: '2000.00', due: '1000.00', recovered: '0.00', closing: '1000.00', status: 'projected' },
      { month: '2026-10', opening: '1000.00', due: '1000.00', recovered: '0.00', closing: '0.00', status: 'projected' },
    ]);

    await refusedWrite('operator', 'POST', `/hr/loans/${loanC}/cancel`, {}, 409, 'LOAN_HAS_RECOVERIES');
    assert.equal((await db.one(`SELECT status FROM hr.loans WHERE id = $1`, [loanC])).status, 'active');

    // A prepayment is money taken back too.
    const f = await audited('operator', 'POST', '/hr/loans', newLoan({ person_id: p3, principal: 2000, instalment: 500 }));
    loanF = f.body.id;
    await audited('operator', 'POST', `/hr/loans/${loanF}/prepay`, { amount: 100 });
    await refusedWrite('operator', 'POST', `/hr/loans/${loanF}/cancel`, {}, 409, 'LOAN_HAS_RECOVERIES');

    // Nothing taken back: it is cancelled, and its balance is reversed so it reads 0 everywhere.
    const d = await audited('operator', 'POST', '/hr/loans', newLoan({ person_id: p3, principal: 3000, instalment: 500, issued_on: `${NOW}-01` }));
    loanD = d.body.id;
    const cancelled = await audited('operator', 'POST', `/hr/loans/${loanD}/cancel`, {});
    assert.equal(cancelled.body.status, 'cancelled');
    assert.equal(cancelled.body.outstanding, '0.00');
    assert.equal(cancelled.body.next_due_month, null);
    assert.equal((await lastAudit('loan', loanD, 'cancel')).detail.reversed, '3000.00');
    const ledger = await call('viewer', 'GET', `/hr/loans/${loanD}`);
    assert.deepEqual(ledger.body.txns.map((t) => [t.kind, t.principal_amount, t.balance]),
      [['disbursed', '3000.00', '3000.00'], ['adjustment', '-3000.00', '0.00']]);
    refused(await call('operator', 'POST', `/hr/loans/${loanD}/cancel`, {}), 409, 'LOAN_NOT_ACTIVE');
    refused(await call('viewer', 'GET', '/hr/loans/999999'), 404);
    refused(await call('viewer', 'GET', '/hr/loans/abc'), 404);

    const person = await call('viewer', 'GET', `/hr/loans?person_id=${p3}`);
    assert.equal(person.body.length, 3);
    assert.ok(person.body.every((l) => l.person_id === p3));
  });

  // ── Advances ──

  test('"Give advance" posts given / source manual straight away; the statement runs a balance; payroll counts it', T, async () => {
    const first = await audited('operator', 'POST', '/hr/advances', { person_id: p1, amount: 3000, txn_date: `${NOW}-01`, note: 'Test advance' });
    assert.equal(first.body.kind, 'given');
    assert.equal(first.body.source, 'manual');
    assert.equal(first.body.amount, '3000.00');
    assert.equal(first.body.txn_date, `${NOW}-01`);
    assert.equal(first.body.balance, '3000.00');
    const row = await db.one(`SELECT kind, source, amount::text AS amount, created_by, run_id FROM hr.advance_txns WHERE id = $1`, [first.body.id]);
    assert.deepEqual(row, { kind: 'given', source: 'manual', amount: '3000.00', created_by: ids.operator, run_id: null });
    const audit = await lastAudit('advance', p1, 'give');
    assert.equal(audit.detail.txn_id, first.body.id);

    const second = await audited('operator', 'POST', '/hr/advances', { person_id: p1, amount: 1500.5 });
    assert.equal(second.body.balance, '4500.50');
    assert.equal(second.body.txn_date, plantDateStr(), 'no date means the plant\'s today');
    const other = await audited('operator', 'POST', '/hr/advances', { person_id: String(p2), amount: '800' });
    assert.equal(other.body.balance, '800.00');

    // What payroll counts as given in the app this month: exactly the 'manual' rows.
    const { inAppAdvancesInMonth } = await import('./hr/ledger.js');
    const inApp = await inAppAdvancesInMonth(db.q, [p1, p2], NOW);
    assert.equal(inApp.get(p1), '4500.50');
    assert.equal(inApp.get(p2), '800.00');

    for (const [body, why] of [
      [{ person_id: p1, amount: 0 }, 'zero'], [{ person_id: p1, amount: -5 }, 'negative'], [{ person_id: p1 }, 'no amount'],
      [{ person_id: p1, amount: 1.005 }, 'three decimals'], [{ person_id: 999999, amount: 5 }, 'no such person'],
      [{ amount: 5 }, 'no person'], [{ person_id: p1, amount: 5, txn_date: '31/12/2026' }, 'a bad date'],
    ]) await refusedWrite('operator', 'POST', '/hr/advances', body, 400);

    const list = await call('viewer', 'GET', '/hr/advances');
    assert.equal(list.status, 200, list.text);
    assert.deepEqual(list.body.map((a) => [a.person_code, a.balance, a.txn_count]), [['T-1', '4500.50', 2], ['T-2', '800.00', 1]]);
    assert.equal(list.headers.get('cache-control'), 'no-store');
    assert.equal(list.headers.get('x-data-tables'), null);

    const statement = await call('viewer', 'GET', `/hr/advances/${p1}`);
    assert.equal(statement.status, 200, statement.text);
    assert.equal(statement.body.person.code, 'T-1');
    assert.equal(statement.body.balance, '4500.50');
    assert.deepEqual(statement.body.txns.map((t) => [t.kind, t.source, t.amount, t.balance]),
      [['given', 'manual', '3000.00', '3000.00'], ['given', 'manual', '1500.50', '4500.50']]);
    refused(await call('viewer', 'GET', '/hr/advances/999999'), 404);
  });

  test('a waiver needs an approver, is at most the balance, and is read under the person\'s locks', T, async () => {
    refused(await call('operator', 'POST', `/hr/advances/${p1}/waive`, { amount: 10 }), 403, 'HR_LEVEL');
    await refusedWrite('approver', 'POST', `/hr/advances/${p1}/waive`, { amount: 4500.51 }, 400);
    await refusedWrite('approver', 'POST', `/hr/advances/${p1}/waive`, { amount: 0 }, 400);
    await refusedWrite('approver', 'POST', `/hr/advances/${p3}/waive`, { amount: 1 }, 400);     // owes nothing
    await refusedWrite('approver', 'POST', '/hr/advances/999999/waive', { amount: 1 }, 404);

    const waived = await audited('approver', 'POST', `/hr/advances/${p1}/waive`, { amount: 500.5, note: 'Goodwill' });
    assert.equal(waived.body.kind, 'waived');
    assert.equal(waived.body.source, 'waiver');
    assert.equal(waived.body.amount, '500.50');
    assert.equal(waived.body.balance, '4000.00');
    const audit = await lastAudit('advance', p1, 'waive');
    assert.equal(audit.user_id, ids.approver);
    assert.deepEqual([audit.detail.balance_before, audit.detail.balance_after], ['4500.50', '4000.00']);
    const statement = await call('viewer', 'GET', `/hr/advances/${p1}`);
    assert.deepEqual(statement.body.txns.map((t) => t.balance), ['3000.00', '4500.50', '4000.00']);
  });

  // ── Adjustments ──

  test('adjustments: recurring needs both months, one-time a single month; approve is the approver\'s; approve and cancel are audited', T, async () => {
    const one = await audited('operator', 'POST', '/hr/adjustments', {
      person_id: p1, kind: 'earning', category: ' arrears ', amount: 2500, description: 'Back pay', reference: 'Run 2026-06',
      start_month: NOW,
    });
    assert.equal(one.body.status, 'pending');
    assert.equal(one.body.recurrence, 'one_time');
    assert.equal(one.body.end_month, null, 'a one-time adjustment never repeats');
    assert.equal(one.body.category, 'arrears');
    assert.equal(one.body.person_code, 'T-1');
    assert.equal(one.body.amount, 2500);
    const oneId = one.body.id;
    const sameMonth = await audited('operator', 'POST', '/hr/adjustments', {
      person_id: p1, kind: 'deduction', amount: 100, recurrence: 'one_time', start_month: NOW, end_month: NOW,
    });
    assert.equal(sameMonth.body.end_month, null, 'an end month equal to the start is still one month');

    const recurring = await audited('operator', 'POST', '/hr/adjustments', {
      person_id: p2, kind: 'deduction', category: 'recovery', amount: 500, recurrence: 'recurring', start_month: NOW, end_month: LATER,
    });
    assert.equal(recurring.body.recurrence, 'recurring');
    assert.equal(recurring.body.end_month, LATER);
    const recurringId = recurring.body.id;
    assert.equal((await lastAudit('adjustment', recurringId, 'create')).detail.end_month, LATER);

    const good = { person_id: p1, kind: 'earning', amount: 100, start_month: NOW };
    await refusedWrite('operator', 'POST', '/hr/adjustments', { ...good, recurrence: 'recurring' }, 400);                          // no end month
    await refusedWrite('operator', 'POST', '/hr/adjustments', { ...good, recurrence: 'recurring', end_month: '' }, 400);
    await refusedWrite('operator', 'POST', '/hr/adjustments', { ...good, recurrence: 'recurring', end_month: '2020-01' }, 400);     // before the start
    await refusedWrite('operator', 'POST', '/hr/adjustments', { ...good, end_month: LATER }, 400);                                  // one-time over two months
    await refusedWrite('operator', 'POST', '/hr/adjustments', { ...good, start_month: undefined }, 400);
    await refusedWrite('operator', 'POST', '/hr/adjustments', { ...good, start_month: '2026-7' }, 400);
    await refusedWrite('operator', 'POST', '/hr/adjustments', { ...good, recurrence: 'weekly' }, 400);
    await refusedWrite('operator', 'POST', '/hr/adjustments', { ...good, kind: 'bonus' }, 400);
    await refusedWrite('operator', 'POST', '/hr/adjustments', { ...good, amount: 0 }, 400);
    await refusedWrite('operator', 'POST', '/hr/adjustments', { ...good, person_id: 999999 }, 400);

    refused(await call('operator', 'POST', `/hr/adjustments/${oneId}/approve`, {}), 403, 'HR_LEVEL');
    const approved = await audited('approver', 'POST', `/hr/adjustments/${oneId}/approve`, {});
    assert.equal(approved.body.status, 'approved');
    assert.equal(approved.body.approved_by, ids.approver);
    assert.ok(approved.body.approved_at);
    assert.equal((await lastAudit('adjustment', oneId, 'approve')).user_id, ids.approver);
    await refusedWrite('approver', 'POST', `/hr/adjustments/${oneId}/approve`, {}, 409, 'ADJUSTMENT_STATE');
    await refusedWrite('approver', 'POST', '/hr/adjustments/999999/approve', {}, 404);

    const cancelled = await audited('operator', 'POST', `/hr/adjustments/${recurringId}/cancel`, {});
    assert.equal(cancelled.body.status, 'cancelled');
    const audit = await lastAudit('adjustment', recurringId, 'cancel');
    assert.deepEqual([audit.user_id, audit.detail.was], [ids.operator, 'pending']);
    await refusedWrite('operator', 'POST', `/hr/adjustments/${recurringId}/cancel`, {}, 409, 'ADJUSTMENT_STATE');
    await refusedWrite('approver', 'POST', `/hr/adjustments/${recurringId}/approve`, {}, 409, 'ADJUSTMENT_STATE');

    // The list: by month (those covering it), by status, by person.
    const inNow = await call('viewer', 'GET', `/hr/adjustments?month=${NOW}`);
    assert.equal(inNow.status, 200, inNow.text);
    assert.deepEqual(inNow.body.map((a) => a.id).sort((a, b) => a - b), [oneId, sameMonth.body.id, recurringId].sort((a, b) => a - b));
    const inLater = await call('viewer', 'GET', `/hr/adjustments?month=${LATER}`);
    assert.deepEqual(inLater.body.map((a) => a.id), [recurringId], 'only the recurring one still covers that month');
    const approvedOnly = await call('viewer', 'GET', '/hr/adjustments?status=approved');
    assert.deepEqual(approvedOnly.body.map((a) => a.id), [oneId]);
    assert.equal((await call('viewer', 'GET', `/hr/adjustments?person_id=${p2}`)).body.length, 1);
    refused(await call('viewer', 'GET', '/hr/adjustments?month=soon'), 400);
    assert.equal((await call('viewer', 'GET', '/hr/adjustments')).headers.get('cache-control'), 'no-store');
  });

  test('once payroll for every month an adjustment covers is finalised, it can no longer be approved or (once approved) cancelled', T, async () => {
    // June 2026 is finalised (the cancel test made it).
    const old = await audited('operator', 'POST', '/hr/adjustments', { person_id: p1, kind: 'earning', amount: 50, start_month: '2026-06' });
    await refusedWrite('approver', 'POST', `/hr/adjustments/${old.body.id}/approve`, {}, 409, 'ADJUSTMENT_FINALISED');
    const cancelled = await audited('operator', 'POST', `/hr/adjustments/${old.body.id}/cancel`, {});
    assert.equal(cancelled.body.status, 'cancelled', 'a pending one never applied, so it may be dropped');

    const used = (await db.one(
      `INSERT INTO hr.adjustments (person_id, kind, amount, recurrence, start_month, status, approved_by, approved_at)
       VALUES ($1, 'earning', 75, 'one_time', '2026-06', 'approved', $2, now()) RETURNING id`, [p1, ids.approver])).id;
    await refusedWrite('operator', 'POST', `/hr/adjustments/${used}/cancel`, {}, 409, 'ADJUSTMENT_FINALISED');
    assert.equal((await db.one(`SELECT status FROM hr.adjustments WHERE id = $1`, [used])).status, 'approved');
  });

  // ── The lock a payroll finalise takes ──

  test('prepay, an instalment change and a waiver all wait for the lock finalise takes on the person; another person is not held up', T, async () => {
    const { default: pg } = await import('pg');
    // Another session holds the person's row FOR UPDATE, as finalise does, and lets go when told to.
    const holding = async (personId, during) => {
      const other = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await other.connect();
      try {
        await other.query('BEGIN');
        await other.query('SELECT id FROM hr.people WHERE id = $1 FOR UPDATE', [personId]);
        return await during(other);
      } finally {
        try { await other.query('ROLLBACK'); } catch {}
        await other.end();
      }
    };
    const waiting = async (other) => (await other.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND pid <> pg_backend_pid()`)).rows[0].n;
    const blocked = (who, method, url, body) => holding(p2, async (other) => {
      let done = false;
      const pending = call(who, method, url, body).then((res) => { done = true; return res; });
      for (let i = 0; i < 200 && (await waiting(other)) === 0; i++) await new Promise((r) => setTimeout(r, 25));
      assert.equal(await waiting(other), 1, `${method} ${url} is waiting on the person's row`);
      assert.equal(done, false, `${method} ${url} must not finish while the lock is held`);
      await other.query('COMMIT');
      return pending;
    });

    const prepaid = await blocked('operator', 'POST', `/hr/loans/${loan2}/prepay`, { amount: 100 });
    assert.equal(prepaid.status, 200, prepaid.text);
    assert.equal(prepaid.body.outstanding, '5900.00');
    const changed = await blocked('operator', 'PUT', `/hr/loans/${loan2}/instalment`, { instalment: 900, from_month: NEXT });
    assert.equal(changed.status, 200, changed.text);
    assert.equal(changed.body.instalment, 900);
    const waived = await blocked('approver', 'POST', `/hr/advances/${p2}/waive`, { amount: 100 });
    assert.equal(waived.status, 200, waived.text);
    assert.equal(waived.body.balance, '700.00');

    // The control: with P2's row held, a prepayment on P3's loan goes straight through.
    const free = await holding(p2, () => call('operator', 'POST', `/hr/loans/${loanC}/prepay`, { amount: 100 }));
    assert.equal(free.status, 200, free.text);
    assert.equal(free.body.outstanding, '3900.00');
  });

  // ── Loading from the salary workbook ──

  test('the preview (admin) reads the workbook, writes nothing, sends no bank number, and diffs the people by code', T, async () => {
    const book = await bookOf([ALPHA, BRAVO, CHARLIE]);
    const res = await upload('admin', '/hr/loader/preview', book);
    assert.equal(res.status, 200, res.text);
    const p = res.body;
    assert.equal(p.month, '2026-07');
    assert.equal(p.daysInMonth, 31);
    assert.deepEqual(p.people.map((x) => x.code), ['901', '902', '903']);
    assert.deepEqual(p.people.map((x) => x.pay_channel_label), ['Cash', 'CASH', 'Test Bank']);
    assert.deepEqual(p.people[0], {
      code: '901', name: 'TEST ALPHA', display_name: 'TEST ALPHA', firm: 'TEST FIRM', department: 'TESTING',
      worker_type: 'employee', pay_channel_label: 'Cash', bank_last4: null, esi_applicable: false,
    });
    for (const key of ['bank', 'monthInputs', 'expected']) assert.ok(!(key in p) && !p.people.some((x) => key in x), `${key} stays on the server`);
    assert.deepEqual(p.setups.map((s) => [s.code, s.pay_basis, s.base, s.ot_hours_per_day, s.holiday_mode]),
      [['901', 'monthly', '24000.00', '8', 'none'], ['902', 'monthly', '30000.00', '8', 'formula'], ['903', 'monthly', '18000.00', '8', 'none']]);
    assert.deepEqual(p.setups[1].review, []);
    assert.deepEqual(p.openingLoans, [
      { code: '901', outstanding: '6000.00', instalment: '1500.00', review: [] },
      { code: '903', outstanding: '3000.00', instalment: null, review: ['no instalment found'] },
    ]);
    assert.deepEqual(p.openingAdvances, [{ code: '902', amount: '2500.00' }]);
    assert.ok(!p.issues.some((i) => i.level === 'error'), JSON.stringify(p.issues));
    assert.deepEqual(p.diff, { new: ['901', '902', '903'], changed: [], same: [] });

    // Nothing was written, and the answer is no-store.
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(await count('hr.people'), 3, 'only the three made by hand');
    assert.equal(await count('hr.pay_channels'), 0);
    assert.equal(await count('hr.pay_setups'), 0);
    assert.equal(await count('hr.loans', `is_opening`), 0);

    // A bad upload is a 400 with a message, not a crash.
    refused(await upload('admin', '/hr/loader/preview', null), 400);
    refused(await upload('admin', '/hr/loader/preview', Buffer.from('this is not a workbook'), undefined, 'notes.xlsx'), 400);
    refused(await upload('admin', '/hr/loader/preview', Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 1)])), 400);
    refused(await upload('admin', '/hr/loader/preview', Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(5 * 1024 * 1024)])), 400);
  });

  test('apply is refused while the workbook has an error issue, no month, a bad decision, or an opening loan with no instalment; nothing is written', T, async () => {
    const audits = await auditCount();
    const untouched = async () => {
      assert.equal(await count('hr.people'), 3);
      assert.equal(await count('hr.pay_channels'), 0);
      assert.equal(await count('hr.pay_setups'), 0);
      assert.equal(await count('hr.loans', 'is_opening'), 0);
      assert.equal(await count('hr.advance_txns', `kind = 'opening'`), 0);
      assert.equal(await auditCount(), audits, 'a refused load leaves no audit row');
    };
    const book = await bookOf([ALPHA, BRAVO, CHARLIE]);

    // An opening loan with no instalment above 0: the message names the person and the code.
    const noInstalment = await upload('admin', '/hr/loader/apply', book);
    refused(noInstalment, 400, 'INSTALMENT_NEEDED');
    assert.match(noInstalment.body.error, /TEST CHARLIE \(903\)/);
    refused(await upload('admin', '/hr/loader/apply', book, { edits: { 903: { instalment: '0' } } }), 400, 'INSTALMENT_NEEDED');
    refused(await upload('admin', '/hr/loader/apply', book, { skip: ['902'] }), 400, 'INSTALMENT_NEEDED');
    await untouched();

    // An error issue in the parse: a payroll code used twice. The preview still answers, with the issue.
    const twice = await bookOf([ALPHA, { ...BRAVO, code: 901 }]);
    const preview = await upload('admin', '/hr/loader/preview', twice);
    assert.equal(preview.status, 200, preview.text);
    assert.ok(preview.body.issues.some((i) => i.level === 'error' && /901/.test(i.message)), JSON.stringify(preview.body.issues));
    const broken = await upload('admin', '/hr/loader/apply', twice, { skip: [] });
    refused(broken, 400, 'WORKBOOK_ERRORS');
    assert.match(broken.body.error, /901/);

    // No month at all.
    const noMonth = await bookOf([ALPHA], { top: [] });
    assert.equal((await upload('admin', '/hr/loader/preview', noMonth)).body.month, null);
    refused(await upload('admin', '/hr/loader/apply', noMonth), 400, 'WORKBOOK_ERRORS');

    // Decisions that make no sense.
    for (const decisions of ['{not json', '[]', '"skip"', { skip: 'all' }, { skip: ['999'] }, { edits: { 999: { firm: 'X' } } },
      { edits: { 901: { salary: '1' } } }, { edits: { 901: { worker_type: 'boss' } } }, { edits: { 901: { instalment: '-5' } } },
      { edits: { 902: { instalment: '500' } } }, { edits: { 901: 'x' } }, { whatever: true }]) {
      refused(await upload('admin', '/hr/loader/apply', book, decisions), 400);
    }
    await untouched();
  });

  test('apply creates the channels, people, setups, opening loan and opening advance in one go; Cash and CASH are one channel', T, async () => {
    const book = await bookOf([ALPHA, BRAVO, CHARLIE]);
    const loansBefore = await count('hr.loans');
    const before = await auditCount();
    const res = await upload('admin', '/hr/loader/apply', book, { skip: ['903'], edits: {} });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body, { created: 2, updated: 0, opening_loans: 1, opening_advances: 1 });
    assert.equal(await auditCount(), before + 1, 'one audit row for the whole load');

    const channels = await db.q(`SELECT code, label, kind, active FROM hr.pay_channels ORDER BY code`);
    assert.deepEqual(channels, [{ code: 'CASH', label: 'Cash', kind: 'cash', active: true }]);
    const people = await db.q(`SELECT code, name, firm, department, worker_type, status, pay_channel FROM hr.people WHERE code LIKE '90%' ORDER BY code`);
    assert.deepEqual(people, [
      { code: '901', name: 'TEST ALPHA', firm: 'TEST FIRM', department: 'TESTING', worker_type: 'employee', status: 'active', pay_channel: 'CASH' },
      { code: '902', name: 'TEST BRAVO', firm: 'TEST FIRM', department: 'PASTING', worker_type: 'employee', status: 'active', pay_channel: 'CASH' },
    ]);

    // Pay setups take effect the month after the workbook's.
    const setups = await db.q(
      `SELECT p.code, s.effective_from::text AS effective_from, s.pay_basis, s.base::text AS base, s.ot_hours_per_day::text AS ot,
              s.holiday_mode, s.holiday_divisor::text AS divisor, s.holiday_multiplier::text AS multiplier, s.holiday_fixed
         FROM hr.pay_setups s JOIN hr.people p ON p.id = s.person_id ORDER BY p.code`);
    assert.deepEqual(setups, [
      { code: '901', effective_from: '2026-08-01', pay_basis: 'monthly', base: '24000.00', ot: '8.0000', holiday_mode: 'none', divisor: null, multiplier: null, holiday_fixed: null },
      { code: '902', effective_from: '2026-08-01', pay_basis: 'monthly', base: '30000.00', ot: '8.0000', holiday_mode: 'formula', divisor: '30.5000', multiplier: '1.5000', holiday_fixed: null },
    ]);

    // The opening loan: numbered, flagged opening, dated the workbook month's last day, first due the month after.
    const [loan, ...rest] = await db.q(
      `SELECT l.id, l.loan_no, l.principal::text AS principal, l.instalment::text AS instalment, l.issued_on::text AS issued_on,
              l.first_due_month, l.is_opening, l.status, l.interest_rate::text AS interest, p.code
         FROM hr.loans l JOIN hr.people p ON p.id = l.person_id WHERE l.is_opening`);
    assert.equal(rest.length, 0);
    assert.match(loan.loan_no, /^CI-LN-\d{4}$/);
    assert.equal(loan.loan_no, `CI-LN-${String(loansBefore + 1).padStart(4, '0')}`, 'the next number in the sequence');
    assert.deepEqual([loan.code, loan.principal, loan.instalment, loan.issued_on, loan.first_due_month, loan.status],
      ['901', '6000.00', '1500.00', '2026-07-31', '2026-08', 'active']);
    assert.equal(Number(loan.interest), 0);
    const txns = await db.q(`SELECT kind, principal_amount::text AS amount, txn_date::text AS txn_date FROM hr.loan_txns WHERE loan_id = $1`, [loan.id]);
    assert.deepEqual(txns, [{ kind: 'opening', amount: '6000.00', txn_date: '2026-07-31' }]);
    const view = await call('viewer', 'GET', `/hr/loans/${loan.id}`);
    assert.equal(view.body.loan.outstanding, '6000.00');
    assert.equal(view.body.schedule[0].month, '2026-08', 'recovery starts with the month after the workbook');

    // The opening advance, dated the month's last day.
    const advances = await db.q(
      `SELECT p.code, a.kind, a.amount::text AS amount, a.txn_date::text AS txn_date, a.source FROM hr.advance_txns a
         JOIN hr.people p ON p.id = a.person_id WHERE a.kind = 'opening'`);
    assert.deepEqual(advances, [{ code: '902', kind: 'opening', amount: '2500.00', txn_date: '2026-07-31', source: 'loader' }]);

    const audit = await db.one(`SELECT user_id, entity, entity_id, action, detail FROM hr.audit_log WHERE entity = 'loader' ORDER BY id DESC LIMIT 1`);
    assert.deepEqual([audit.user_id, audit.entity, audit.entity_id, audit.action], [ids.admin, 'loader', '2026-07', 'apply']);
    assert.equal(audit.detail.people_created, 2);
    assert.equal(audit.detail.pay_channels_created, 1);
    assert.equal(audit.detail.pay_setups_created, 2);
    assert.equal(audit.detail.opening_loans, 1);
    assert.equal(audit.detail.opening_advances, 1);
    assert.ok(!JSON.stringify(audit.detail).includes('TEST'), 'no names in the audit detail');
  });

  test('loading the same workbook again changes nothing: no second person, setup, loan or advance; the preview says so', T, async () => {
    const book = await bookOf([ALPHA, BRAVO, CHARLIE]);
    const counts = async () => [await count('hr.people'), await count('hr.pay_setups'), await count('hr.loans'),
      await count('hr.loan_txns'), await count('hr.advance_txns'), await count('hr.pay_channels')];
    const before = await counts();

    const preview = await upload('admin', '/hr/loader/preview', book);
    assert.deepEqual(preview.body.diff, { new: ['903'], changed: [], same: ['901', '902'] });
    assert.ok(preview.body.openingLoans.find((l) => l.code === '901').review.some((m) => /already has a loan/.test(m)));
    assert.ok(preview.body.openingAdvances.find((a) => a.code === '902').review.some((m) => /already has advance/.test(m)));

    const again = await upload('admin', '/hr/loader/apply', book, { skip: ['903'] });
    assert.equal(again.status, 200, again.text);
    assert.deepEqual(again.body, { created: 0, updated: 0, opening_loans: 0, opening_advances: 0 });
    assert.deepEqual(await counts(), before);
    const audit = await db.one(`SELECT detail FROM hr.audit_log WHERE entity = 'loader' ORDER BY id DESC LIMIT 1`);
    assert.equal(audit.detail.people_unchanged, 2);
    assert.equal(audit.detail.opening_loans_kept, 1);
    assert.equal(audit.detail.opening_advances_kept, 1);
    assert.equal(audit.detail.pay_setups_unchanged, 2);
  });

  test('a changed person is listed with the field names; edits fix the missing instalment; a person already loaded is updated, not doubled', T, async () => {
    await db.q(`UPDATE hr.people SET firm = 'ANOTHER FIRM' WHERE code = '901'`);
    const book = await bookOf([ALPHA, BRAVO, CHARLIE]);
    const preview = await upload('admin', '/hr/loader/preview', book);
    assert.deepEqual(preview.body.diff, { new: ['903'], changed: [{ code: '901', fields: ['firm'] }], same: ['902'] });

    const res = await upload('admin', '/hr/loader/apply', book, { skip: [], edits: { 903: { instalment: '1000', base: '18500', name: 'TEST CHARLIE EDITED' } } });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body, { created: 1, updated: 1, opening_loans: 1, opening_advances: 0 });

    assert.equal((await db.one(`SELECT firm FROM hr.people WHERE code = '901'`)).firm, 'TEST FIRM', 'the changed field was written back');
    const charlie = await db.one(`SELECT name, pay_channel FROM hr.people WHERE code = '903'`);
    assert.deepEqual(charlie, { name: 'TEST CHARLIE EDITED', pay_channel: 'TEST BANK' });
    const channels = await db.q(`SELECT code, label, kind FROM hr.pay_channels ORDER BY code`);
    assert.deepEqual(channels, [{ code: 'CASH', label: 'Cash', kind: 'cash' }, { code: 'TEST BANK', label: 'Test Bank', kind: 'bank' }]);
    const loan = await db.one(
      `SELECT l.principal::text AS principal, l.instalment::text AS instalment, l.is_opening FROM hr.loans l
         JOIN hr.people p ON p.id = l.person_id WHERE p.code = '903'`);
    assert.deepEqual(loan, { principal: '3000.00', instalment: '1000.00', is_opening: true });
    assert.equal((await db.one(`SELECT base::text AS base FROM hr.pay_setups s JOIN hr.people p ON p.id = s.person_id WHERE p.code = '903'`)).base, '18500.00');
    assert.equal(await count('hr.loans', `person_id = (SELECT id FROM hr.people WHERE code = '901')`), 1, '901 still has its one loan');
    const audit = await db.one(`SELECT detail FROM hr.audit_log WHERE entity = 'loader' ORDER BY id DESC LIMIT 1`);
    assert.equal(audit.detail.people_edited, 1);
    assert.equal(audit.detail.people_updated, 1);
  });

  test('a loaded name that is another person\'s approved alias is refused (NAME_IS_AN_ALIAS) and the whole load is rolled back', T, async () => {
    await db.q(`INSERT INTO hr.person_aliases (person_id, alias_norm) VALUES ($1, 'TEST DELTA')`, [p1]);
    const people = await count('hr.people');
    const audits = await auditCount();
    const res = await upload('admin', '/hr/loader/apply', await bookOf([ALPHA, DELTA]));
    refused(res, 409, 'NAME_IS_AN_ALIAS');
    assert.equal(await count('hr.people'), people, 'nothing of the load was kept');
    assert.equal(await count('hr.people', `code = '904'`), 0);
    assert.equal(await auditCount(), audits);
  });

  // ── Pay staff: POST /hr/staff-payments and GET /hr/people/:id/ledger ──

  let pS;
  test('pay staff: an advance is a given row with source manual straight away, counted by payroll for its month', T, async () => {
    pS = (await db.one(`INSERT INTO hr.people (code, name) VALUES ('T-9', 'Test Person Nine') RETURNING id`)).id;
    await db.q(`INSERT INTO hr.pay_channels (code, label, kind) VALUES ('TPAY', 'Test pay', 'bank')`);
    refused(await call('viewer', 'POST', '/hr/staff-payments', { person_id: pS, kind: 'advance', amount: 10 }), 403, 'HR_LEVEL');

    const res = await audited('operator', 'POST', '/hr/staff-payments',
      { person_id: pS, kind: 'advance', amount: 2500, paid_on: `${NOW}-03`, paid_via: 'Cash', note: 'Test advance' });
    assert.equal(res.body.kind, 'advance');
    assert.equal(res.body.loan, null);
    assert.deepEqual(res.body.warnings, []);
    const row = await db.one(
      `SELECT kind, source, amount::text AS amount, txn_date::text AS txn_date, run_id, note FROM hr.advance_txns WHERE person_id = $1`, [pS]);
    assert.deepEqual(row, { kind: 'given', source: 'manual', amount: '2500.00', txn_date: `${NOW}-03`, run_id: null,
      note: 'Paid via Cash · Test advance' });
    assert.equal(res.body.advance.amount, '2500.00');
    assert.equal(res.body.ledger.totals.advance_balance, '2500.00');
    const audit = await lastAudit('advance', pS, 'give');
    assert.equal(audit.detail.via, 'staff_payment');
    assert.equal(audit.detail.paid_via, 'cash');
    const { inAppAdvancesInMonth } = await import('./hr/ledger.js');
    assert.equal((await inAppAdvancesInMonth(db.q, [pS], NOW)).get(pS), '2500.00', 'payroll nets it against the month');

    // An advance dated in a month payroll has closed is still taken, with a warning naming where it is recovered.
    const closed = (await db.one(`SELECT max(month) AS m FROM hr.runs WHERE status = 'finalised'`)).m;
    assert.ok(closed && closed >= '2026-06', 'June 2026 was finalised earlier in the story');
    const late = await audited('operator', 'POST', '/hr/staff-payments',
      { person_id: pS, kind: 'advance', amount: 400, paid_on: '2026-06-10', paid_via: 'TPAY' });
    assert.equal(late.body.warnings.length, 1);
    assert.match(late.body.warnings[0], new RegExp(`recovered from ${nextMonth(closed)}`));
  });

  test('pay staff: a loan mints the next CI-LN number, rounds the instalment UP to the rupee, and defaults the first due month', T, async () => {
    const before = (await db.one(`SELECT max(loan_no) AS n FROM hr.loans`)).n;
    const res = await audited('operator', 'POST', '/hr/staff-payments',
      { person_id: pS, kind: 'loan', amount: 10000, instalments: 3, paid_on: `${NOW}-04`, paid_via: 'TPAY', note: 'Test loan' });
    assert.equal(res.body.kind, 'loan');
    const loan = res.body.loan;
    assert.match(loan.loan_no, /^CI-LN-\d{4}$/);
    assert.equal(Number(loan.loan_no.slice(6)), Number(before.slice(6)) + 1, 'the next number');
    assert.equal(loan.instalment, 3334, '10000 / 3 = 3333.33, rounded up so it never under-recovers');
    assert.equal(loan.first_due_month, NOW, 'the month it was given, which payroll has not closed');
    assert.equal(loan.paid_via, 'TPAY');
    assert.equal(loan.outstanding, '10000.00');
    const txns = await db.q(`SELECT kind, principal_amount::text AS amount, txn_date::text AS d, note FROM hr.loan_txns WHERE loan_id = $1`, [loan.id]);
    assert.deepEqual(txns, [{ kind: 'disbursed', amount: '10000.00', d: `${NOW}-04`, note: 'Paid out via Test pay' }]);
    const detail = await call('viewer', 'GET', `/hr/loans/${loan.id}`);
    assert.deepEqual(detail.body.schedule.map((s) => s.due), ['3334.00', '3334.00', '3332.00'], 'the last month takes what is left');
    const audit = await lastAudit('loan', loan.id, 'create');
    assert.equal(audit.detail.via, 'staff_payment');
    assert.equal(audit.detail.instalments, 3);
    assert.equal(audit.detail.instalment, '3334.00');

    // An even split stays exact; a loan given in a closed month falls due in the next open one.
    const closed = (await db.one(`SELECT max(month) AS m FROM hr.runs WHERE status = 'finalised'`)).m;
    const even = await audited('operator', 'POST', '/hr/staff-payments',
      { person_id: pS, kind: 'loan', amount: '1200', instalments: '12', paid_on: '2026-06-10', paid_via: 'cash' });
    assert.equal(even.body.loan.instalment, 100);
    assert.equal(even.body.loan.first_due_month, nextMonth(closed));
    assert.equal(even.body.loan.paid_via, 'cash');
    assert.deepEqual(even.body.warnings, []);
    const typed = await audited('operator', 'POST', '/hr/staff-payments',
      { person_id: pS, kind: 'loan', amount: 500, instalments: 1, paid_on: `${NOW}-05`, first_due_month: NEXT });
    assert.equal(typed.body.loan.first_due_month, NEXT);
    assert.equal(typed.body.loan.instalment, 500);
    assert.equal(typed.body.loan.paid_via, 'cash', 'no channel named means cash');
  });

  test('pay staff refuses only what cannot be stored, and a refusal mints nothing and writes nothing', T, async () => {
    const loans = await count('hr.loans');
    const advances = await count('hr.advance_txns');
    const ok = { person_id: pS, kind: 'loan', amount: 900, instalments: 3, paid_on: `${NOW}-05`, paid_via: 'cash' };
    for (const [body, code] of [
      [{ ...ok, instalments: undefined }], [{ ...ok, instalments: 0 }], [{ ...ok, instalments: 1.5 }],
      [{ ...ok, first_due_month: '2026-01' }], [{ ...ok, amount: 0 }], [{ ...ok, kind: 'gift' }], [{ ...ok, person_id: 999999 }],
      [{ ...ok, paid_on: '05/10/2026' }], [{ ...ok, interest_rate: 2 }, 'INTEREST_NOT_YET'],
      [{ ...ok, paid_via: 'NOPE' }, 'UNKNOWN_PAY_CHANNEL'], [{ ...ok, kind: 'advance', paid_via: 'NOPE' }, 'UNKNOWN_PAY_CHANNEL'],
    ]) await refusedWrite('operator', 'POST', '/hr/staff-payments', body, 400, code);
    assert.equal(await count('hr.loans'), loans, 'nothing minted');
    assert.equal(await count('hr.advance_txns'), advances);
  });

  test('a person\'s ledger lists every advance and loan movement by date, newest first, with running balances', T, async () => {
    refused(await call('viewer', 'GET', '/hr/people/999999/ledger'), 404);
    refused(await call('plain', 'GET', `/hr/people/${pS}/ledger`), 403, 'HR_NO_ACCESS');
    const res = await call('viewer', 'GET', `/hr/people/${pS}/ledger`);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.body.person.code, 'T-9');
    const rows = res.body.rows.map((x) => [x.date, x.ledger, x.kind, x.amount, x.advance_balance, x.loan_outstanding]);
    assert.deepEqual(rows, [
      [`${NOW}-05`, 'loan', 'disbursed', '500.00', '2900.00', '500.00'],
      [`${NOW}-04`, 'loan', 'disbursed', '10000.00', '2900.00', '10000.00'],
      [`${NOW}-03`, 'advance', 'given', '2500.00', '2900.00', null],
      ['2026-06-10', 'loan', 'disbursed', '1200.00', '400.00', '1200.00'],
      ['2026-06-10', 'advance', 'given', '400.00', '400.00', null],
    ]);
    assert.ok(res.body.rows.every((x) => x.effect === 'owes_more' && x.created_by_name === 'HR Operator'));
    assert.ok(res.body.rows.filter((x) => x.ledger === 'loan').every((x) => /^CI-LN-\d{4}$/.test(x.loan_no)));
    assert.equal(res.body.totals.advance_balance, '2900.00');
    assert.equal(res.body.totals.loans_outstanding, '11700.00');
    assert.equal(res.body.totals.owed, '14600.00');
    assert.deepEqual(res.body.totals.loans.map((l) => [l.outstanding, l.instalment]).sort(),
      [['10000.00', '3334.00'], ['1200.00', '100.00'], ['500.00', '500.00']].sort());

    // A recovery reads as owing less, and moves the running balances after it.
    await db.q(`INSERT INTO hr.advance_txns (person_id, txn_date, kind, amount, source) VALUES ($1, $2, 'recovered', 900, 'payroll')`,
      [pS, `${NOW}-06`]);
    const again = await call('viewer', 'GET', `/hr/people/${pS}/ledger`);
    assert.deepEqual([again.body.rows[0].kind, again.body.rows[0].effect, again.body.rows[0].advance_balance], ['recovered', 'owes_less', '2000.00']);
    assert.equal(again.body.totals.advance_balance, '2000.00');
  });

  // ── The trail ──

  test('every write left audit rows in hr.audit_log, and none in the plant\'s audit_log', T, async () => {
    const seen = new Set((await db.q(`SELECT DISTINCT entity || ':' || action AS k FROM hr.audit_log`)).map((r) => r.k));
    for (const key of ['loan:create', 'loan:prepay', 'loan:close', 'loan:holiday', 'loan:instalment', 'loan:cancel',
      'advance:give', 'advance:waive', 'adjustment:create', 'adjustment:approve', 'adjustment:cancel', 'loader:apply']) {
      assert.ok(seen.has(key), `no audit row for ${key}`);
    }
    const lost = await db.q(`SELECT entity, action FROM hr.audit_log WHERE user_id IS NULL OR user_name IS NULL`);
    assert.deepEqual(lost, [], 'every row names who did it');
    assert.equal((await db.one(`SELECT count(*)::int AS n FROM audit_log`)).n, publicAuditBefore, 'the plant\'s audit_log was not touched');
  });
});
