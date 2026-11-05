// The accounts level and the per-login hide list (hr/privacy.js, routes/hr.js /hr/access/:userId/people) through the
// REAL app over HTTP, against a throwaway Postgres (the same harness as hr-routes-core-pg.test.js).
//
// Three made-up people: Shown, PayHidden (mode 'pay') and Gone (mode 'all') from an accounts login. Every response
// the accounts login can get is checked: Gone's name and code never appear; neither of the two hidden people's
// amounts ever appear; every total is Shown's alone. Every name, code and figure is synthetic.
//
//   HR_PG=1 node --test src/hr-privacy-pg.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const ENABLED = process.env.HR_PG === '1';
const T = { timeout: 30_000 };
const MONTH = '2026-08';

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.unref();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

describe('HR accounts level and hide list', {
  skip: ENABLED ? false : 'set HR_PG=1 to boot a throwaway Postgres',
}, () => {
  let epg, dir, db, pool, server, base;
  const ids = {};
  const tokens = {};
  let S, P, G;                       // Shown, PayHidden, Gone
  const secret = new Set();          // amounts of P and G that must never reach the accounts login

  before(async () => {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-privacy-'));
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
    const login = async (key, level) => {
      const u = await db.one(`INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, 'x', 'viewer') RETURNING id, name, role`,
        [`HR ${key}`, `${key}@test.local`]);
      ids[key] = u.id;
      tokens[key] = jwt.sign({ id: u.id, name: u.name, role: u.role }, JWT_SECRET);
      if (level) await db.q(`INSERT INTO hr.access (user_id, level, granted_by) VALUES ($1, $2, $1)`, [u.id, level]);
    };
    await login('admin', 'admin');
    await login('operator', 'operator');
    await login('approver', 'approver');
    await login('accounts', 'accounts');
    await login('viewer', 'viewer');
    await login('newcomer', null);

    await db.q(`INSERT INTO hr.pay_channels (code, label, kind) VALUES ('TCASH', 'Test cash', 'cash')`);
    S = (await db.one(`INSERT INTO hr.people (code, name, pay_channel) VALUES ('T-301', 'Test Shown Person', 'TCASH') RETURNING id`)).id;
    P = (await db.one(`INSERT INTO hr.people (code, name, pay_channel) VALUES ('T-302', 'Test Payhidden Person', 'TCASH') RETURNING id`)).id;
    G = (await db.one(`INSERT INTO hr.people (code, name, pay_channel) VALUES ('T-303', 'Test Gone Zebedee', 'TCASH') RETURNING id`)).id;
    for (const [id, base] of [[S, 21111], [P, 37373], [G, 48484]]) {
      await db.q(`INSERT INTO hr.pay_setups (person_id, effective_from, pay_basis, base, holiday_mode) VALUES ($1, '2026-04-01', 'monthly', $2, 'none')`, [id, base]);
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
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, text };
  };
  const ok = (res) => { assert.equal(res.status, 200, res.text); return res; };
  // Nothing of G by name or code, and none of P's or G's amounts (integer part, as any format would show it).
  const clean = (res, url) => {
    for (const w of ['Zebedee', 'T-303']) assert.ok(!res.text.includes(w), `${url} names the hidden person: ${w}`);
    for (const a of secret) {
      const whole = a.split('.')[0];
      for (const form of [whole, Number(whole).toLocaleString('en-IN')]) {
        assert.ok(!res.text.includes(form), `${url} carries a hidden amount ${form}`);
      }
    }
  };

  test('the month is worked out, approved and finalised; advances and a loan are given to the hidden two', T, async () => {
    for (const id of [S, P, G]) ok(await call('operator', 'PUT', `/hr/runs/${MONTH}/inputs/${id}`, { absent_days: 0, reason: 'Test' }));
    ok(await call('operator', 'POST', `/hr/runs/${MONTH}/submit`, {}));
    ok(await call('approver', 'POST', `/hr/runs/${MONTH}/approve`, {}));
    ok(await call('approver', 'POST', `/hr/runs/${MONTH}/lines/approval`, { person_ids: [S, P, G], action: 'approve' }));
    ok(await call('approver', 'POST', `/hr/runs/${MONTH}/finalise`, {}));
    ok(await call('operator', 'POST', '/hr/advances', { person_id: P, amount: 7171 }));
    ok(await call('operator', 'POST', '/hr/advances', { person_id: G, amount: 8282 }));
    ok(await call('operator', 'POST', '/hr/staff-payments', { person_id: G, kind: 'loan', amount: 9393, instalments: 3 }));
    for (const l of await db.q(`SELECT gross::text AS gross, payable::text AS payable FROM hr.run_lines WHERE person_id = ANY($1::int[])`, [[P, G]])) {
      secret.add(l.gross); secret.add(l.payable);
    }
    for (const a of ['37373', '48484', '7171', '8282', '9393']) secret.add(a);
  });

  test('admin sets who the accounts login sees: show, pay, all; audited; own login and unknown modes refused', T, async () => {
    refused(await call('accounts', 'GET', `/hr/access/${ids.accounts}/people`), 403);
    const put = await call('admin', 'PUT', `/hr/access/${ids.accounts}/people`, { changes: [{ person_id: P, mode: 'pay' }, { person_id: G, mode: 'all' }] });
    ok(put);
    assert.equal(put.body.applies, true);
    const modes = Object.fromEntries(put.body.people.map((p) => [p.code, p.mode]));
    assert.deepEqual(modes, { 'T-301': 'show', 'T-302': 'pay', 'T-303': 'all' });
    assert.equal((await db.one(`SELECT count(*)::int AS n FROM hr.audit_log WHERE entity = 'access_hidden'`)).n, 2);
    assert.equal((await call('admin', 'PUT', `/hr/access/${ids.admin}/people`, { changes: [{ person_id: P, mode: 'pay' }] })).status, 400);
    assert.equal((await call('admin', 'PUT', `/hr/access/${ids.accounts}/people`, { changes: [{ person_id: P, mode: 'some' }] })).status, 400);
  });

  test('every read the accounts login can make leaves the hidden people out — names, amounts and totals', T, async () => {
    const urls = ['/hr/me', '/hr/people', `/hr/people/${S}`, `/hr/people/${P}`, '/hr/pay-channels', '/hr/settings', `/hr/dashboard?month=${MONTH}`,
      '/hr/runs', `/hr/runs/${MONTH}`, `/hr/runs/${MONTH}/payslips`, `/hr/runs/${MONTH}/lines/${S}/history`, '/hr/reports/monthly',
      '/hr/loans', '/hr/advances', `/hr/advances/${S}`, `/hr/people/${S}/ledger`];
    for (const url of urls) clean(ok(await call('accounts', 'GET', url)), url);

    const people = (await call('accounts', 'GET', '/hr/people')).body;
    assert.deepEqual(people.map((p) => p.code).sort(), ['T-301', 'T-302']);
    const payHidden = people.find((p) => p.code === 'T-302');
    assert.equal(payHidden.pay_hidden, true);
    assert.equal(payHidden.current_setup, undefined);
    const detail = (await call('accounts', 'GET', `/hr/people/${P}`)).body;
    assert.deepEqual([detail.pay_hidden, detail.setups, detail.loans], [true, undefined, undefined]);

    const run = (await call('accounts', 'GET', `/hr/runs/${MONTH}`)).body;
    assert.deepEqual(run.lines.map((l) => l.person_id), [S]);
    assert.deepEqual(run.inputs.map((l) => l.person_id), [S]);
    assert.deepEqual(run.pay_hidden_people.map((p) => p.code), ['T-302'], 'the pay-hidden person is named, Gone is not');
    assert.deepEqual(run.imports, []);
    const shown = run.lines[0];
    assert.equal(Number(run.run.totals.payable), Number(shown.payable), 'the run total is the shown person alone');
    assert.equal(run.run.totals.lines, 1);
    const monthly = (await call('accounts', 'GET', '/hr/reports/monthly')).body;
    const aug = monthly.find((m) => m.month === MONTH);
    assert.equal(aug.run.people, 1);
    assert.equal(Number(aug.run.payable), Number(shown.payable));
    const slips = (await call('accounts', 'GET', `/hr/runs/${MONTH}/payslips`)).body.slips;
    assert.deepEqual(slips.map((s) => s.person.code), ['T-301']);
  });

  test('a hidden person is "not found" on every person route; other routes are 403 HR_RESTRICTED', T, async () => {
    for (const url of [`/hr/people/${G}`, `/hr/advances/${P}`, `/hr/people/${P}/ledger`, `/hr/runs/${MONTH}/lines/${P}/history`]) {
      assert.equal((await call('accounts', 'GET', url)).status, 404, url);
    }
    const loan = await db.one(`SELECT id FROM hr.loans WHERE person_id = $1`, [G]);
    assert.equal((await call('accounts', 'GET', `/hr/loans/${loan.id}`)).status, 404);
    for (const [m, url] of [['GET', `/hr/runs/${MONTH}/variance`], ['GET', '/hr/audit'], ['GET', '/hr/column-maps'], ['GET', '/hr/loan-holds'],
      ['GET', '/hr/adjustments'], ['PUT', `/hr/runs/${MONTH}/inputs/${S}`], ['POST', '/hr/people'], ['GET', '/hr/anything-new']]) {
      refused(await call('accounts', m, url, m === 'GET' ? undefined : {}), 403, 'HR_RESTRICTED');
    }
  });

  test('accounts pays: one line, a batch of only what it sees, staff advances — never a hidden person', T, async () => {
    assert.equal((await call('accounts', 'PUT', `/hr/runs/${MONTH}/lines/${P}/payment`, { status: 'paid' })).status, 404);
    assert.equal((await call('accounts', 'POST', `/hr/runs/${MONTH}/lines/status`, { person_ids: [S, G], status: 'on_hold', reason: 'x' })).status, 404);
    assert.equal((await call('accounts', 'POST', '/hr/staff-payments', { person_id: G, kind: 'advance', amount: 10 })).status, 404);
    const batch = ok(await call('accounts', 'POST', `/hr/runs/${MONTH}/payments`, { pay_channel: 'TCASH', reference: 'AUG-CASH' }));
    clean(batch, 'payments');
    assert.deepEqual(batch.body.person_ids, [S]);
    const status = Object.fromEntries((await db.q(`SELECT person_id, payment_status FROM hr.run_lines`)).map((l) => [l.person_id, l.payment_status]));
    assert.deepEqual([status[S], status[P], status[G]], ['paid', 'pending', 'pending'], 'the hidden two stay for the owner to pay');
    ok(await call('accounts', 'POST', '/hr/staff-payments', { person_id: S, kind: 'advance', amount: 500 }));
    assert.equal((await call('accounts', 'POST', '/hr/runs/2026-08/approve', {})).status, 403);
  });

  test('a plain viewer with nobody hidden reads as before; operators and up ignore any list', T, async () => {
    ok(await call('viewer', 'GET', `/hr/runs/${MONTH}/variance`));
    assert.equal((await call('viewer', 'GET', '/hr/me')).body.restricted, false);
    ok(await call('admin', 'PUT', `/hr/access/${ids.operator}/people`, { changes: [{ person_id: G, mode: 'all' }] }));
    const run = (await call('operator', 'GET', `/hr/runs/${MONTH}`)).body;
    assert.equal(run.lines.length, 3);
    // A viewer with someone hidden becomes restricted.
    ok(await call('admin', 'PUT', `/hr/access/${ids.viewer}/people`, { changes: [{ person_id: G, mode: 'all' }] }));
    refused(await call('viewer', 'GET', `/hr/runs/${MONTH}/variance`), 403, 'HR_RESTRICTED');
    assert.deepEqual((await call('viewer', 'GET', `/hr/runs/${MONTH}`)).body.lines.map((l) => l.person_id).sort(), [S, P].sort());
  });

  test('show again brings the person back', T, async () => {
    ok(await call('admin', 'PUT', `/hr/access/${ids.accounts}/people`, { changes: [{ person_id: G, mode: 'show' }] }));
    assert.ok((await call('accounts', 'GET', '/hr/people')).body.some((p) => p.code === 'T-303'));
  });

  test('salary ledger: every month of a person, oldest first; 404 for a hidden person on a restricted login', T, async () => {
    const mine = ok(await call('admin', 'GET', `/hr/people/${P}/salary-ledger`)).body;
    assert.equal(mine.person.code, 'T-302');
    assert.deepEqual(mine.months.map((m) => [m.month, m.run_status]), [[MONTH, 'finalised']]);
    assert.ok(Number(mine.months[0].gross) > 0 && Array.isArray(mine.months[0].breakdown));
    const seen = ok(await call('accounts', 'GET', `/hr/people/${S}/salary-ledger`));
    clean(seen, 'salary-ledger');
    assert.equal(seen.body.months.length, 1);
    assert.equal((await call('accounts', 'GET', `/hr/people/${P}/salary-ledger`)).status, 404);
  });

  test('a person short last month is listed in the next month as carried forward, before any run or upload', T, async () => {
    const C = (await db.one(`INSERT INTO hr.people (code, name, pay_channel) VALUES ('T-304', 'Test Carry Person', 'TCASH') RETURNING id`)).id;
    await db.q(`INSERT INTO hr.pay_setups (person_id, effective_from, pay_basis, base, holiday_mode) VALUES ($1, '2026-04-01', 'monthly', 30000, 'none')`, [C]);
    ok(await call('operator', 'PUT', `/hr/runs/2026-09/inputs/${C}`, { absent_days: 0, advance_given: 50000, reason: 'Test' }));
    const sept = (await call('admin', 'GET', '/hr/runs/2026-09')).body.lines.find((l) => l.person_id === C);
    assert.equal(Number(sept.payable), 0, 'pay is capped at zero');
    const oct = ok(await call('admin', 'GET', '/hr/runs/2026-10')).body;
    assert.equal(oct.run, null, 'October has no run yet');
    const c = oct.carried_forward.find((x) => x.person_id === C);
    assert.deepEqual([c.from_month, c.from_status, c.final, c.advance, c.amount], ['2026-09', 'draft', false, '20000.00', '20000.00']);
    // Hidden from a restricted login: not listed there.
    ok(await call('admin', 'PUT', `/hr/access/${ids.accounts}/people`, { changes: [{ person_id: C, mode: 'pay' }] }));
    assert.ok(!(await call('accounts', 'GET', '/hr/runs/2026-10')).body.carried_forward.some((x) => x.person_id === C));
  });

  function refused(res, status, code) {
    assert.equal(res.status, status, res.text);
    if (code) assert.equal(res.body?.code, code, res.text);
  }
});
