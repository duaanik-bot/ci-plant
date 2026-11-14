// Correcting a loan instalment in a FINALISED month (hr/correction.js, PUT /hr/loans/:id/month-instalment with a
// finalised month) through the real app over HTTP, against a throwaway Postgres. Every name and figure is made up.
//
//   Short  pay short in August: the loan instalment is taken off; the advance recovery takes the freed money and
//          the advance carried forward shrinks by as much. Nothing is paid either way.
//   Paid   paid in August: a smaller instalment means they were short-paid; the difference is an approved arrears
//          earning in September, and the line says so.
//
//   HR_PG=1 node --test src/hr-correction-pg.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const ENABLED = process.env.HR_PG === '1';
const T = { timeout: 30_000 };
const AUG = '2026-08';

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.unref();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

describe('HR: correcting a finalised month\'s loan instalment', {
  skip: ENABLED ? false : 'set HR_PG=1 to boot a throwaway Postgres',
}, () => {
  let epg, dir, db, pool, server, base;
  const tokens = {};
  let S, D, loanS, loanD;

  before(async () => {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-correction-'));
    const port = await freePort();
    epg = new EmbeddedPostgres({ databaseDir: dir, port, user: 'postgres', password: 'postgres', persistent: false, onLog: () => {}, onError: () => {} });
    await epg.initialise();
    await epg.start();
    process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
    process.env.PG_POOL_MAX = '1';
    db = await import('./db.js');
    pool = await db.connect();
    await db.init();
    const { default: jwt } = await import('jsonwebtoken');
    const { JWT_SECRET } = await import('./auth.js');
    for (const [key, level] of [['operator', 'operator'], ['approver', 'approver'], ['accounts', 'accounts']]) {
      const u = await db.one(`INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, 'x', 'viewer') RETURNING id, name, role`,
        [`HR ${key}`, `${key}@test.local`]);
      tokens[key] = jwt.sign({ id: u.id, name: u.name, role: u.role }, JWT_SECRET);
      await db.q(`INSERT INTO hr.access (user_id, level, granted_by) VALUES ($1, $2, $1)`, [u.id, level]);
    }
    await db.q(`INSERT INTO hr.pay_channels (code, label, kind) VALUES ('TCASH', 'Test cash', 'cash')`);
    S = (await db.one(`INSERT INTO hr.people (code, name, pay_channel) VALUES ('T-501', 'Test Short Person', 'TCASH') RETURNING id`)).id;
    D = (await db.one(`INSERT INTO hr.people (code, name, pay_channel) VALUES ('T-502', 'Test Paid Person', 'TCASH') RETURNING id`)).id;
    for (const [id, pay] of [[S, 30000], [D, 20000]]) {
      await db.q(`INSERT INTO hr.pay_setups (person_id, effective_from, pay_basis, base, holiday_mode) VALUES ($1, '2026-04-01', 'monthly', $2, 'none')`, [id, pay]);
    }
    const { default: app } = await import('./app.js');
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}/api`;
  });

  after(async () => {
    try { server?.closeAllConnections?.(); server?.close(); } catch {}
    try { await pool?.end(); } catch {}
    try { await epg?.stop(); } catch {}
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const call = async (who, method, url, body) => {
    const res = await fetch(base + url, {
      method, headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, text };
  };
  const ok = (res) => { assert.equal(res.status, 200, res.text); return res; };
  const line = (pid) => db.one(
    `SELECT l.loan_recovery::text AS loan, l.advance_recovery::text AS adv, l.carried_advance::text AS carried, l.payable::text AS payable,
            l.net_before_cap::text AS nbc, l.status_note FROM hr.run_lines l JOIN hr.runs r ON r.id = l.run_id WHERE r.month = $1 AND l.person_id = $2`, [AUG, pid]);
  const loanTaken = async (loanId) => (await db.q(
    `SELECT principal_amount::text AS a FROM hr.loan_txns WHERE loan_id = $1 AND kind = 'payroll_recovery'`, [loanId])).map((x) => x.a);

  test('August is worked out (one short, one paid), approved, finalised and paid', T, async () => {
    loanS = ok(await call('operator', 'POST', '/hr/loans', { person_id: S, principal: 20000, issued_on: '2026-07-10', purpose: 'Test', instalment: 5000, first_due_month: AUG, paid_via: 'cash', is_opening: false })).body.id;
    loanD = ok(await call('operator', 'POST', '/hr/loans', { person_id: D, principal: 10000, issued_on: '2026-07-10', purpose: 'Test', instalment: 2000, first_due_month: AUG, paid_via: 'cash', is_opening: false })).body.id;
    ok(await call('operator', 'PUT', `/hr/runs/${AUG}/inputs/${S}`, { absent_days: 0, advance_given: 40000, reason: 'Test' }));
    ok(await call('operator', 'PUT', `/hr/runs/${AUG}/inputs/${D}`, { absent_days: 0, reason: 'Test' }));
    ok(await call('operator', 'POST', `/hr/runs/${AUG}/submit`, {}));
    ok(await call('approver', 'POST', `/hr/runs/${AUG}/approve`, {}));
    ok(await call('approver', 'POST', `/hr/runs/${AUG}/lines/approval`, { person_ids: [S, D], action: 'approve' }));
    ok(await call('approver', 'POST', `/hr/runs/${AUG}/finalise`, {}));
    ok(await call('accounts', 'POST', `/hr/runs/${AUG}/lines/status`, { person_ids: [D], status: 'paid' }));
    assert.deepEqual(await line(S), { loan: '5000.00', adv: '25000.00', carried: '15000.00', payable: '0.00', nbc: '-15000.00', status_note: null });
    assert.equal((await line(D)).payable, '18000.00');
    assert.deepEqual(await loanTaken(loanS), ['5000.00']);
  });

  test('a finalised month asks for confirmation first, with what would move, and changes nothing', T, async () => {
    const asked = await call('accounts', 'PUT', `/hr/loans/${loanS}/month-instalment`, { month: AUG, amount: 0, scope: 'month' });
    assert.equal(asked.status, 409, asked.text);
    assert.equal(asked.body.code, 'FINALISED_NEEDS_CONFIRM');
    const p = asked.body.preview;
    assert.deepEqual([p.loan.from, p.loan.to, p.advance_recovered.from, p.advance_recovered.to, p.advance_carried.to, p.payable.to, p.arrears],
      ['5000.00', '0.00', '25000.00', '30000.00', '10000.00', '0.00', null]);
    assert.equal((await line(S)).loan, '5000.00', 'nothing changed');
  });

  test('confirmed: short pay — the loan takes nothing, the advance takes the money, the carry shrinks; ledgers follow', T, async () => {
    const done = ok(await call('accounts', 'PUT', `/hr/loans/${loanS}/month-instalment`, { month: AUG, amount: 0, scope: 'month', confirm_finalised: true }));
    assert.equal(done.body.change.loan.to, '0.00');
    assert.deepEqual(await line(S), { loan: '0.00', adv: '30000.00', carried: '10000.00', payable: '0.00', nbc: '-10000.00', status_note: null });
    assert.deepEqual(await loanTaken(loanS), [], 'the loan\'s August recovery is gone');
    assert.equal(done.body.outstanding, '20000.00', 'the loan owes all of it again');
    const adv = await db.one(`SELECT amount::text AS a FROM hr.advance_txns WHERE person_id = $1 AND kind = 'recovered'`, [S]);
    assert.equal(adv.a, '30000.00');
    const audit = await db.one(`SELECT detail FROM hr.audit_log WHERE action = 'finalised_correction' ORDER BY id DESC LIMIT 1`);
    assert.equal(audit.detail.loan.to, '0.00');
  });

  test('confirmed: a paid line — a smaller instalment is paid as arrears in September', T, async () => {
    const asked = await call('accounts', 'PUT', `/hr/loans/${loanD}/month-instalment`, { month: AUG, amount: 1000, scope: 'onward' });
    assert.equal(asked.body.code, 'FINALISED_NEEDS_CONFIRM');
    assert.deepEqual(asked.body.preview.arrears, { month: '2026-09', kind: 'earning', amount: '1000.00' });
    const done = ok(await call('accounts', 'PUT', `/hr/loans/${loanD}/month-instalment`, { month: AUG, amount: 1000, scope: 'onward', confirm_finalised: true }));
    assert.equal(done.body.instalment, 1000, 'onward: the loan\'s instalment is 1000 from September');
    const l = await line(D);
    assert.deepEqual([l.loan, l.payable], ['1000.00', '19000.00']);
    assert.match(l.status_note, /paid as arrears in 2026-09/);
    const adj = await db.one(`SELECT kind, amount::text AS a, start_month, status FROM hr.adjustments WHERE person_id = $1`, [D]);
    assert.deepEqual(adj, { kind: 'earning', a: '1000.00', start_month: '2026-09', status: 'approved' });
    assert.deepEqual(await loanTaken(loanD), ['1000.00']);
    // September's line carries the arrears and the new instalment.
    ok(await call('operator', 'PUT', `/hr/runs/2026-09/inputs/${D}`, { absent_days: 0, reason: 'Test' }));
    const sept = await db.one(`SELECT l.adj_earnings::text AS arrears, l.loan_recovery::text AS loan FROM hr.run_lines l
      JOIN hr.runs r ON r.id = l.run_id WHERE r.month = '2026-09' AND l.person_id = $1`, [D]);
    assert.deepEqual(sept, { arrears: '1000.00', loan: '1000.00' });
  });
});
