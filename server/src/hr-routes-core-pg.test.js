// HR core routes (routes/hr.js: people, pay setups, aliases, settings, pay channels, access, audit,
// dashboard, ERP operators) through the REAL app over HTTP, against a real Postgres.
//
// Boots its OWN throwaway Postgres in a temp dir on a free port, with PG_POOL_MAX=1 (the Vercel geometry:
// a pool call inside a transaction would hang, and each test has a timeout so a hang fails), runs init()
// (which replays the hr migration) and mounts the real app on a free port. Five logins are made by hand:
// an ERP admin with NO HR access, and an HR viewer, operator, approver and admin (none of them gets an ERP
// role that matters). The tests share one story and run in order. Every name, code and figure is synthetic.
//
//   HR_PG=1 node --test src/hr-routes-core-pg.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { plantDateStr } from './plant-calendar.js';

const ENABLED = process.env.HR_PG === '1';
const T = { timeout: 30_000 };

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.unref();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

// The account numbers below are made up. They are what the leak checks look for in every response.
const ACCOUNT = '123456789012';
const ACCOUNT_2 = '999900001111';
const CHANNEL_ACCOUNT = '000111222333';
// Identity numbers, made up. A viewer must only ever be given the end of these (T9-c).
const PAN = 'ABCDE1234F';
const PAN_2 = 'FGHIJ5678K';
const UAN = '100200300400';
const ESI_NO = '5566 7788 99';      // stored as typed, spaces and all
const ESI_DIGITS = '5566778899';

describe('HR core routes through the real app', {
  skip: ENABLED ? false : 'set HR_PG=1 to boot a throwaway Postgres',
}, () => {
  let epg, dir, db, pool, server, base;
  const ids = {};       // user ids by key
  const tokens = {};    // signed JWTs by key
  let publicAuditBefore;
  let p1, p2, p3, p4, operatorId;

  before(async () => {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-routes-core-'));
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
    // connect() lists the tables the response cache tracks, but on a fresh database it runs before init() has
    // made any, so the list would be empty and no GET could ever carry X-Data-Tables. List them now, with the
    // same query connect() uses, so the "not cacheable" checks below can fail.
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
  const call = async (who, method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, text, headers: res.headers };
  };
  const hrAuditCount = async () => (await db.one(`SELECT count(*)::int AS n FROM hr.audit_log`)).n;
  const lastAudit = (entity, id) => db.one(
    `SELECT user_id, user_name, entity, entity_id, action, detail FROM hr.audit_log
      WHERE entity = $1 AND entity_id = $2 ORDER BY id DESC LIMIT 1`, [entity, String(id)]);
  // A refusal: the status, and the code when it has one (a plain 400 / 404 has none).
  const refused = (res, status, code) => {
    assert.equal(res.status, status, res.text);
    assert.equal(res.body?.code, code, res.text);
    assert.equal(typeof res.body?.error, 'string', res.text);
    assert.ok(res.body.error.length > 0, res.text);
  };
  // A write that is refused changes nothing and audits nothing.
  const refusedWrite = async (who, method, url, body, status, code) => {
    const before = await hrAuditCount();
    const res = await call(who, method, url, body);
    refused(res, status, code);
    assert.equal(await hrAuditCount(), before, `${method} ${url} was refused but left an audit row`);
    return res;
  };

  // ── The wall ──

  test('an ERP admin with no HR access gets 403 HR_NO_ACCESS on reads and writes alike', T, async () => {
    refused(await call('plain', 'GET', '/hr/people'), 403, 'HR_NO_ACCESS');
    refused(await call('plain', 'POST', '/hr/people', { code: 'A-1', name: 'Nobody Special' }), 403, 'HR_NO_ACCESS');
    refused(await call('plain', 'GET', '/hr/me'), 403, 'HR_NO_ACCESS');
    refused(await call('plain', 'GET', '/hr/dashboard'), 403, 'HR_NO_ACCESS');
    refused(await call('plain', 'GET', '/hr/nothing-here'), 403, 'HR_NO_ACCESS');
    assert.equal((await call(null, 'GET', '/hr/people')).status, 401, 'no token at all is the ERP\'s own 401');
    assert.equal((await db.one(`SELECT count(*)::int AS n FROM hr.people`)).n, 0, 'nothing was written');
  });

  test('a viewer reads (me, lists) but every write is 403 HR_LEVEL', T, async () => {
    const me = await call('viewer', 'GET', '/hr/me');
    assert.equal(me.status, 200, me.text);
    assert.deepEqual(me.body, { level: 'viewer', user: { id: ids.viewer, name: 'HR Viewer' } });
    const list = await call('viewer', 'GET', '/hr/people');
    assert.equal(list.status, 200, list.text);
    assert.deepEqual(list.body, []);
    refused(await call('viewer', 'POST', '/hr/people', { code: 'V-1', name: 'Viewer Made' }), 403, 'HR_LEVEL');
    refused(await call('viewer', 'PUT', '/hr/people/1', { phone: '1' }), 403, 'HR_LEVEL');
    refused(await call('viewer', 'POST', '/hr/people/1/setups', { effective_from: '2026-08-01' }), 403, 'HR_LEVEL');
    refused(await call('viewer', 'POST', '/hr/people/1/aliases', { alias: 'X' }), 403, 'HR_LEVEL');
    refused(await call('viewer', 'DELETE', '/hr/aliases/1'), 403, 'HR_LEVEL');
    refused(await call('viewer', 'GET', '/hr/erp-operators'), 403, 'HR_LEVEL');
  });

  test('settings, pay channels and access are admin only; the audit trail is approver and above', T, async () => {
    refused(await call('operator', 'PUT', '/hr/settings', { rounding: 'paise' }), 403, 'HR_LEVEL');
    refused(await call('operator', 'POST', '/hr/pay-channels', { code: 'X', label: 'X', kind: 'cash' }), 403, 'HR_LEVEL');
    refused(await call('operator', 'PUT', '/hr/pay-channels/X', { label: 'Y' }), 403, 'HR_LEVEL');
    refused(await call('operator', 'GET', '/hr/access'), 403, 'HR_LEVEL');
    refused(await call('operator', 'PUT', `/hr/access/${ids.viewer}`, { level: 'admin' }), 403, 'HR_LEVEL');
    refused(await call('approver', 'PUT', '/hr/settings', { rounding: 'paise' }), 403, 'HR_LEVEL');
    refused(await call('operator', 'GET', '/hr/audit'), 403, 'HR_LEVEL');
    refused(await call('viewer', 'GET', '/hr/audit'), 403, 'HR_LEVEL');
    assert.equal((await call('approver', 'GET', '/hr/audit')).status, 200);
    assert.equal((await call('viewer', 'GET', '/hr/settings')).status, 200, 'a viewer may read the settings');
    assert.equal((await call('viewer', 'GET', '/hr/pay-channels')).status, 200, 'and the pay channels');
  });

  // ── Pay channels (admin) ──

  test('the admin creates pay channels; the account is masked in every answer and the code is normalised', T, async () => {
    const bank = await call('admin', 'POST', '/hr/pay-channels', {
      code: 'bank1', label: '  Test   Bank One ', kind: 'bank', bank_name: 'Test Bank', account: CHANNEL_ACCOUNT,
    });
    assert.equal(bank.status, 200, bank.text);
    assert.equal(bank.body.code, 'BANK1');
    assert.equal(bank.body.label, 'Test Bank One');
    assert.equal(bank.body.kind, 'bank');
    assert.equal(bank.body.account, '••••2333');
    assert.equal(bank.body.active, true);
    assert.ok(!bank.text.includes(CHANNEL_ACCOUNT), 'the full account is not in the answer');
    assert.equal((await db.one(`SELECT account FROM hr.pay_channels WHERE code = 'BANK1'`)).account, CHANNEL_ACCOUNT, 'it is stored in full');

    const cash = await call('admin', 'POST', '/hr/pay-channels', { code: 'Cash', label: 'Cash', kind: 'cash' });
    assert.equal(cash.status, 200, cash.text);
    assert.equal(cash.body.code, 'CASH');
    assert.equal(cash.body.account, null);

    await refusedWrite('admin', 'POST', '/hr/pay-channels', { code: ' bank1 ', label: 'Again', kind: 'bank' }, 409, 'CODE_EXISTS');
    await refusedWrite('admin', 'POST', '/hr/pay-channels', { code: 'CASH', label: 'Again', kind: 'cash' }, 409, 'CODE_EXISTS');
    await refusedWrite('admin', 'POST', '/hr/pay-channels', { code: 'Z', kind: 'bank' }, 400);
    await refusedWrite('admin', 'POST', '/hr/pay-channels', { label: 'No code', kind: 'bank' }, 400);
    await refusedWrite('admin', 'POST', '/hr/pay-channels', { code: 'Z', label: 'Z', kind: 'upi' }, 400);
    await refusedWrite('admin', 'POST', '/hr/pay-channels', { code: 'Z', label: 'Z', kind: 'cash', account: '123' }, 400);

    const list = await call('viewer', 'GET', '/hr/pay-channels');
    assert.equal(list.status, 200, list.text);
    assert.deepEqual(list.body.map((c) => c.code), ['BANK1', 'CASH']);
    assert.equal(list.body[0].account, '••••2333');
    assert.ok(!list.text.includes(CHANNEL_ACCOUNT), 'the list masks the account');
  });

  test('editing a pay channel keeps the stored account unless a new one (or null) is sent', T, async () => {
    const stored = async () => (await db.one(`SELECT label, bank_name, account, active FROM hr.pay_channels WHERE code = 'BANK1'`));
    const renamed = await call('admin', 'PUT', '/hr/pay-channels/bank1', { label: 'Test Bank One (renamed)', bank_name: 'Test Bank' });
    assert.equal(renamed.status, 200, renamed.text);
    assert.equal(renamed.body.label, 'Test Bank One (renamed)');
    assert.equal(renamed.body.account, '••••2333');
    assert.equal((await stored()).account, CHANNEL_ACCOUNT, 'account left out: the stored one is kept');

    assert.equal((await call('admin', 'PUT', '/hr/pay-channels/BANK1', { account: '' })).status, 200);
    assert.equal((await stored()).account, CHANNEL_ACCOUNT, 'a blank account also keeps it');

    const replaced = await call('admin', 'PUT', '/hr/pay-channels/BANK1', { account: '555566667777' });
    assert.equal(replaced.status, 200, replaced.text);
    assert.equal(replaced.body.account, '••••7777');
    assert.equal((await stored()).account, '555566667777');

    const cleared = await call('admin', 'PUT', '/hr/pay-channels/BANK1', { account: null });
    assert.equal(cleared.status, 200, cleared.text);
    assert.equal(cleared.body.account, null);
    assert.equal((await stored()).account, null);
    await call('admin', 'PUT', '/hr/pay-channels/BANK1', { account: CHANNEL_ACCOUNT });

    const audit = await lastAudit('pay_channel', 'BANK1');
    assert.equal(audit.action, 'update');
    assert.ok(audit.detail.fields.includes('account'));
    assert.ok(!JSON.stringify(audit.detail).includes('555566667777'), 'the audit row never carries an account number');

    await refusedWrite('admin', 'PUT', '/hr/pay-channels/NOPE', { label: 'x' }, 404);
    const off = await call('admin', 'PUT', '/hr/pay-channels/CASH', { active: false });
    assert.equal(off.body.active, false);
    await call('admin', 'PUT', '/hr/pay-channels/CASH', { active: true });

    // Switching a channel to cash drops the bank details it cannot have, and a cash channel takes no account.
    const temp = await call('admin', 'POST', '/hr/pay-channels', {
      code: 'tmp', label: 'Temp', kind: 'bank', bank_name: 'Temp Bank', account: '777788889999',
    });
    assert.equal(temp.status, 200, temp.text);
    await refusedWrite('admin', 'PUT', '/hr/pay-channels/TMP', { kind: 'cash', account: '123' }, 400);
    await refusedWrite('admin', 'PUT', '/hr/pay-channels/TMP', { kind: 'upi' }, 400);
    const switched = await call('admin', 'PUT', '/hr/pay-channels/TMP', { kind: 'cash' });
    assert.equal(switched.status, 200, switched.text);
    assert.deepEqual([switched.body.kind, switched.body.bank_name, switched.body.account], ['cash', null, null]);
    assert.deepEqual(await db.one(`SELECT bank_name, account FROM hr.pay_channels WHERE code = 'TMP'`), { bank_name: null, account: null });
  });

  // ── People ──

  test('the operator adds a person: the code is normalised, the name tidied, bank details stored in full', T, async () => {
    const res = await call('operator', 'POST', '/hr/people', {
      code: ' 0042 ', name: '  Test   Person One ', department: 'Packing', designation: 'Packer',
      pay_channel: 'bank1', bank_holder: 'Test Person One', bank_name: 'Test Bank',
      bank_account: '1234 5678 9012', bank_ifsc: 'test0000001', joined_on: '2025-04-01',
      pan: 'abcde1234f', pf_uan: '1002 0030 0400', esi_no: ESI_NO, esi_applicable: true,
      phone: '0000000000', address: '1 Test Lane, Testville',
    });
    assert.equal(res.status, 200, res.text);
    p1 = res.body.id;
    assert.equal(res.body.code, '42', 'codes go through normCode');
    assert.equal(res.body.name, 'Test Person One');
    assert.equal(res.body.pay_channel, 'BANK1');
    assert.equal(res.body.bank_account, ACCOUNT, 'the operator gets the full account back, spaces removed');
    assert.equal(res.body.bank_last4, '9012');
    assert.equal(res.body.bank_ifsc, 'TEST0000001');
    assert.deepEqual([res.body.pan, res.body.pf_uan, res.body.esi_no], [PAN, UAN, ESI_NO], 'the operator gets the identity numbers whole');
    assert.equal(res.body.esi_applicable, true);
    assert.equal(res.body.worker_type, 'employee');
    assert.equal(res.body.status, 'active');
    assert.equal(res.body.joined_on, '2025-04-01');
    assert.deepEqual(res.body.setups, []);
    assert.deepEqual(res.body.aliases, []);
    assert.deepEqual(res.body.loans, []);
    assert.deepEqual(res.body.recent_lines, []);
    assert.equal(res.body.advance_balance, '0.00');
    assert.equal(res.body.current_setup, null);
    const audit = await lastAudit('person', p1);
    assert.equal(audit.action, 'create');
    assert.equal(audit.user_id, ids.operator);
    assert.equal(audit.user_name, 'HR Operator');
    assert.ok(!JSON.stringify(audit.detail).includes(ACCOUNT));
    for (const secret of [PAN, UAN, ESI_NO, ESI_DIGITS]) assert.ok(!JSON.stringify(audit.detail).includes(secret), 'no identity number in the audit row');

    const two = await call('operator', 'POST', '/hr/people', {
      code: 'T-7', name: 'Test Person Two', display_name: 'TP Two', pay_channel: 'CASH',
    });
    assert.equal(two.status, 200, two.text);
    p2 = two.body.id;
    assert.equal(two.body.code, 'T-7');
    assert.equal(two.body.bank_last4, null);

    const three = await call('operator', 'POST', '/hr/people', { code: 'x-1', name: 'Test Person Three', joined_on: '2025-01-01' });
    assert.equal(three.status, 200, three.text);
    p3 = three.body.id;
    assert.equal(three.body.code, 'X-1', 'a text code is upper-cased');
  });

  test('a duplicate code is 409 CODE_EXISTS however it is spelled; bad input is a plain 400', T, async () => {
    await refusedWrite('operator', 'POST', '/hr/people', { code: '42', name: 'Dup One' }, 409, 'CODE_EXISTS');
    await refusedWrite('operator', 'POST', '/hr/people', { code: '0042', name: 'Dup Two' }, 409, 'CODE_EXISTS');
    await refusedWrite('operator', 'POST', '/hr/people', { code: 't-7', name: 'Dup Three' }, 409, 'CODE_EXISTS');
    await refusedWrite('operator', 'POST', '/hr/people', { name: 'No Code' }, 400);
    await refusedWrite('operator', 'POST', '/hr/people', { code: 'N-1' }, 400);
    await refusedWrite('operator', 'POST', '/hr/people', { code: 'N-1', name: 'Bad Channel', pay_channel: 'NOSUCH' }, 400);
    await refusedWrite('operator', 'POST', '/hr/people', { code: 'N-1', name: 'Bad Date', joined_on: '2026-02-30' }, 400);
    await refusedWrite('operator', 'POST', '/hr/people', { code: 'N-1', name: 'Bad Dates', joined_on: '2026-03-01', exited_on: '2026-02-01' }, 400);
    await refusedWrite('operator', 'POST', '/hr/people', { code: 'N-1', name: 'Bad Type', worker_type: 'robot' }, 400);
    await refusedWrite('operator', 'POST', '/hr/people', { code: 'N-1', name: 'Bad Status', status: 'gone' }, 400);
    await refusedWrite('operator', 'POST', '/hr/people', { code: 'N-1', name: 'Bad Flag', esi_applicable: 'yes' }, 400);
    await refusedWrite('operator', 'POST', '/hr/people', { code: 'N-1', name: 'Bad Link', employee_id: 987654 }, 400);
    await refusedWrite('operator', 'POST', '/hr/people', { code: 'N-1', name: 'Bad Text', phone: 12345 }, 400);
    await refusedWrite('operator', 'POST', '/hr/people', [1, 2], 400);
    assert.equal((await db.one(`SELECT count(*)::int AS n FROM hr.people`)).n, 3, 'none of the refused ones was saved');
    refused(await call('operator', 'GET', '/hr/people/9999'), 404);
    refused(await call('operator', 'GET', '/hr/people/abc'), 404);
  });

  // ── Pay setups ──

  test('a pay setup is added from the 1st of a month; there is one per person per month (SETUP_EXISTS)', T, async () => {
    const body = {
      effective_from: '2020-01-01', pay_basis: 'monthly', base: 20000, absence_basis: 'calendar_days',
      ot_hours_per_day: 8, ot_multiplier: 1.5, holiday_mode: 'formula', holiday_divisor: '30.5', holiday_multiplier: 1.5,
      note: 'First setup',
    };
    const first = await call('operator', 'POST', `/hr/people/${p1}/setups`, body);
    assert.equal(first.status, 200, first.text);
    assert.equal(first.body.person_id, p1);
    assert.equal(first.body.effective_from, '2020-01-01', 'dates leave as text');
    assert.equal(first.body.base, 20000);
    assert.equal(first.body.ot_multiplier, 1.5);
    assert.equal(first.body.holiday_divisor, 30.5);
    assert.equal(first.body.absence_divisor, null);
    assert.equal(first.body.ot_fixed_rate, null);
    assert.equal(first.body.created_by, ids.operator);
    assert.ok(!('warning' in first.body), 'no run is finalised yet, so no month is locked');
    const audit = await lastAudit('pay_setup', first.body.id);
    assert.equal(audit.action, 'create');
    assert.equal(audit.detail.person_id, p1);

    const again = await refusedWrite('operator', 'POST', `/hr/people/${p1}/setups`, { ...body, base: 21000 }, 409, 'SETUP_EXISTS');
    assert.match(again.body.error, /2020-01/);
    assert.equal((await db.one(`SELECT base::float8 AS base FROM hr.pay_setups WHERE id = $1`, [first.body.id])).base, 20000, 'the first setup is untouched');

    const later = await call('operator', 'POST', `/hr/people/${p1}/setups`, {
      effective_from: '2099-01-01', pay_basis: 'monthly', base: '25000.50', holiday_mode: 'fixed', holiday_fixed: 1000,
      ot_fixed_rate: 75, absence_basis: 'fixed_divisor', absence_divisor: 26,
    });
    assert.equal(later.status, 200, later.text);
    assert.equal(later.body.base, 25000.5);
    assert.equal(later.body.holiday_fixed, 1000);
    assert.equal(later.body.holiday_divisor, null, 'what a mode does not use is stored as null');
    assert.equal(later.body.absence_divisor, 26);
    assert.equal(later.body.ot_hours_per_day, 0, 'the column defaults apply');
    assert.equal(later.body.ot_multiplier, 1);
    assert.ok(!('warning' in later.body));

    const contract = await call('operator', 'POST', `/hr/people/${p2}/setups`, { effective_from: '2020-01-01', pay_basis: 'contract' });
    assert.equal(contract.status, 200, contract.text);
    assert.equal(contract.body.base, null, 'a contract needs no base');

    refused(await call('operator', 'POST', '/hr/people/9999/setups', body), 404);
  });

  test('a pay setup is refused for a bad month, a negative figure or a missing field its basis needs', T, async () => {
    const ok = { effective_from: '2030-01-01', pay_basis: 'monthly', base: 20000 };
    const url = `/hr/people/${p1}/setups`;
    for (const month of ['2030-01-15', '2030-1-01', '2030-13-01', '2030-00-01', '203001', '', null, 20300101]) {
      await refusedWrite('operator', 'POST', url, { ...ok, effective_from: month }, 400);
    }
    // Every numeric field refuses a negative, whatever the mode it would sit in.
    for (const field of ['base', 'absence_divisor', 'ot_hours_per_day', 'ot_multiplier', 'ot_fixed_rate',
      'holiday_divisor', 'holiday_multiplier', 'holiday_fixed']) {
      await refusedWrite('operator', 'POST', url, { ...ok, [field]: -1 }, 400);
      await refusedWrite('operator', 'POST', url, { ...ok, [field]: '-0.5' }, 400);
    }
    await refusedWrite('operator', 'POST', url, { ...ok, ot_multiplier: -1 }, 400);
    await refusedWrite('operator', 'POST', url, { ...ok, holiday_mode: 'formula', holiday_divisor: 30.5, holiday_multiplier: -2 }, 400);
    // What each basis and mode needs.
    for (const pay_basis of ['monthly', 'daily', 'hourly']) {
      await refusedWrite('operator', 'POST', url, { effective_from: '2030-01-01', pay_basis }, 400);
    }
    await refusedWrite('operator', 'POST', url, { ...ok, pay_basis: 'weekly' }, 400);
    await refusedWrite('operator', 'POST', url, { ...ok, pay_basis: undefined }, 400);
    await refusedWrite('operator', 'POST', url, { ...ok, holiday_mode: 'formula', holiday_multiplier: 1.5 }, 400);
    await refusedWrite('operator', 'POST', url, { ...ok, holiday_mode: 'formula', holiday_divisor: 30.5 }, 400);
    await refusedWrite('operator', 'POST', url, { ...ok, holiday_mode: 'fixed' }, 400);
    await refusedWrite('operator', 'POST', url, { ...ok, holiday_mode: 'sometimes' }, 400);
    await refusedWrite('operator', 'POST', url, { ...ok, absence_basis: 'fixed_divisor' }, 400);
    await refusedWrite('operator', 'POST', url, { ...ok, absence_basis: 'fixed_divisor', absence_divisor: 0 }, 400);
    await refusedWrite('operator', 'POST', url, { ...ok, holiday_mode: 'formula', holiday_divisor: 0, holiday_multiplier: 1 }, 400);
    await refusedWrite('operator', 'POST', url, { ...ok, ot_hours_per_day: 25 }, 400);
    // Not stored quietly rounded, not read as something else.
    await refusedWrite('operator', 'POST', url, { ...ok, base: 20000.505 }, 400);
    await refusedWrite('operator', 'POST', url, { ...ok, ot_multiplier: 1.00001 }, 400);
    await refusedWrite('operator', 'POST', url, { ...ok, base: '1,000' }, 400);
    await refusedWrite('operator', 'POST', url, { ...ok, base: 'abc' }, 400);
    await refusedWrite('operator', 'POST', url, { ...ok, base: 99999999999 }, 400);
    await refusedWrite('operator', 'POST', url, { ...ok, base: true }, 400);
    assert.equal((await db.one(`SELECT count(*)::int AS n FROM hr.pay_setups WHERE person_id = $1`, [p1])).n, 2, 'no refused setup was saved');
  });

  // ── Reading people ──

  test('a list carries bank_last4 and never the full account or an identity number; current_setup is the one in force', T, async () => {
    const res = await call('viewer', 'GET', '/hr/people');
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body.map((p) => p.code), ['42', 'X-1', 'T-7'], 'by name: One, Three, Two');
    const one = res.body.find((p) => p.id === p1);
    assert.equal(one.bank_last4, '9012');
    assert.equal(one.name, 'Test Person One');
    assert.equal(one.pay_channel, 'BANK1');
    assert.equal(one.joined_on, '2025-04-01');
    for (const row of res.body) {
      for (const key of ['bank_account', 'pan', 'pf_uan', 'esi_no']) assert.ok(!(key in row), `no list row has ${key}`);
    }
    assert.ok(!res.text.includes(ACCOUNT), 'the full account is nowhere in a list');
    for (const secret of [PAN, UAN, ESI_NO, ESI_DIGITS]) assert.ok(!res.text.includes(secret), 'and no identity number is');
    assert.equal(one.current_setup.effective_from, '2020-01-01', 'the 2099 revision is scheduled, not in force');
    assert.equal(one.current_setup.base, 20000);
    assert.equal(res.body.find((p) => p.id === p2).current_setup.pay_basis, 'contract');
    assert.equal(res.body.find((p) => p.id === p3).current_setup, null);
    assert.equal(res.body.find((p) => p.id === p2).bank_last4, null);
  });

  test('the viewer\'s detail has no full account and only the end of each identity number; the operator\'s has them whole', T, async () => {
    const viewer = await call('viewer', 'GET', `/hr/people/${p1}`);
    assert.equal(viewer.status, 200, viewer.text);
    assert.ok(!('bank_account' in viewer.body), 'a viewer\'s detail has no account key');
    assert.ok(!viewer.text.includes(ACCOUNT), 'and the number is nowhere in it');
    assert.equal(viewer.body.bank_last4, '9012');
    assert.equal(viewer.body.bank_holder, 'Test Person One');
    // T9-c: pan, pf_uan and esi_no are '••••' and their last four characters (spaces ignored) for a viewer.
    assert.equal(viewer.body.pan, '••••234F');
    assert.equal(viewer.body.pf_uan, '••••0400');
    assert.equal(viewer.body.esi_no, '••••8899');
    for (const whole of [PAN, UAN, ESI_NO, ESI_DIGITS]) assert.ok(!viewer.text.includes(whole), `${whole} is nowhere in a viewer\'s detail`);
    // Phone and address stay visible to a viewer.
    assert.equal(viewer.body.phone, '0000000000');
    assert.equal(viewer.body.address, '1 Test Lane, Testville');
    // Nothing on file is null, not a mask of nothing.
    const bare = await call('viewer', 'GET', `/hr/people/${p2}`);
    assert.deepEqual([bare.body.pan, bare.body.pf_uan, bare.body.esi_no], [null, null, null]);

    const operator = await call('operator', 'GET', `/hr/people/${p1}`);
    assert.equal(operator.status, 200, operator.text);
    assert.equal(operator.body.bank_account, ACCOUNT);
    assert.deepEqual([operator.body.pan, operator.body.pf_uan, operator.body.esi_no], [PAN, UAN, ESI_NO]);
    const approver = await call('approver', 'GET', `/hr/people/${p1}`);
    assert.equal(approver.body.bank_account, ACCOUNT, 'approver is above operator');
    assert.deepEqual([approver.body.pan, approver.body.pf_uan, approver.body.esi_no], [PAN, UAN, ESI_NO]);

    assert.deepEqual(operator.body.setups.map((s) => s.effective_from), ['2099-01-01', '2020-01-01']);
    assert.equal(operator.body.current_setup.effective_from, '2020-01-01');
    assert.equal(operator.body.id, p1);
    assert.deepEqual(operator.body.legacy, {});
  });

  // ── Changing people ──

  test('a save with only some fields leaves the rest alone; sending the record back unchanged is a no-op', T, async () => {
    const was = (await call('operator', 'GET', `/hr/people/${p1}`)).body;
    const one = await call('operator', 'PUT', `/hr/people/${p1}`, { phone: '0000000001', department: '  Packing   Hall ' });
    assert.equal(one.status, 200, one.text);
    assert.equal(one.body.phone, '0000000001');
    assert.equal(one.body.department, 'Packing Hall');
    assert.equal(one.body.bank_account, ACCOUNT, 'untouched');
    assert.equal(one.body.name, was.name);
    const audit = await lastAudit('person', p1);
    assert.equal(audit.action, 'update');
    assert.deepEqual(audit.detail.fields.sort(), ['department', 'phone']);
    assert.deepEqual(audit.detail.changes.phone, { from: '0000000000', to: '0000000001' });

    // The drawer sends the WHOLE record back, with the read-only keys it was given.
    const detail = (await call('operator', 'GET', `/hr/people/${p1}`)).body;
    const before = await hrAuditCount();
    const echo = await call('operator', 'PUT', `/hr/people/${p1}`, detail);
    assert.equal(echo.status, 200, echo.text);
    assert.equal(await hrAuditCount(), before, 'nothing changed, so nothing is audited');
    assert.equal(echo.body.bank_account, ACCOUNT);
    assert.equal(echo.body.code, '42');
    assert.deepEqual(echo.body.setups.map((s) => s.id), detail.setups.map((s) => s.id));

    // A secret changes, and its value stays out of the audit row.
    const moved = await call('operator', 'PUT', `/hr/people/${p1}`, { bank_account: ACCOUNT_2, pan: PAN_2.toLowerCase() });
    assert.equal(moved.status, 200, moved.text);
    assert.equal(moved.body.bank_account, ACCOUNT_2);
    assert.equal(moved.body.bank_last4, '1111');
    assert.equal(moved.body.pan, PAN_2);
    const secret = await lastAudit('person', p1);
    assert.deepEqual(secret.detail.fields.sort(), ['bank_account', 'pan']);
    assert.deepEqual(secret.detail.changes, {});
    for (const value of [ACCOUNT, ACCOUNT_2, PAN, PAN_2]) assert.ok(!JSON.stringify(secret.detail).includes(value), 'no secret in the audit row');
    assert.equal((await call('viewer', 'GET', `/hr/people/${p1}`)).body.pan, '••••678K', 'a viewer sees the end of the new one');
    await call('operator', 'PUT', `/hr/people/${p1}`, { bank_account: ACCOUNT, pan: PAN });

    await refusedWrite('operator', 'PUT', `/hr/people/${p1}`, { name: '' }, 400);
    await refusedWrite('operator', 'PUT', `/hr/people/${p1}`, { code: ' ' }, 400);
    await refusedWrite('operator', 'PUT', `/hr/people/${p1}`, { status: '' }, 400);
    await refusedWrite('operator', 'PUT', `/hr/people/${p1}`, { pay_channel: 'NOSUCH' }, 400);
    await refusedWrite('operator', 'PUT', `/hr/people/${p1}`, { code: 'T-7' }, 409, 'CODE_EXISTS');
    await refusedWrite('operator', 'PUT', `/hr/people/${p1}`, { exited_on: '2025-01-01' }, 400);
    refused(await call('operator', 'PUT', '/hr/people/9999', { phone: '1' }), 404);
    const cleared = await call('operator', 'PUT', `/hr/people/${p1}`, { phone: null, pay_channel: null });
    assert.equal(cleared.body.phone, null);
    assert.equal(cleared.body.pay_channel, null);
    await call('operator', 'PUT', `/hr/people/${p1}`, { pay_channel: 'BANK1' });
  });

  test('GET /hr/people with no status returns every status, an exited person included', T, async () => {
    const gone = await call('operator', 'PUT', `/hr/people/${p3}`, { status: 'exited', exited_on: '2026-08-20' });
    assert.equal(gone.status, 200, gone.text);
    assert.equal(gone.body.status, 'exited');
    assert.equal(gone.body.exited_on, '2026-08-20');

    const all = await call('viewer', 'GET', '/hr/people');
    assert.deepEqual(all.body.map((p) => p.status).sort(), ['active', 'active', 'exited']);
    assert.ok(all.body.some((p) => p.id === p3 && p.exited_on === '2026-08-20'));
    const active = await call('viewer', 'GET', '/hr/people?status=active');
    assert.deepEqual(active.body.map((p) => p.id).sort(), [p1, p2].sort());
    const exited = await call('viewer', 'GET', '/hr/people?status=exited');
    assert.deepEqual(exited.body.map((p) => p.id), [p3]);
    const two = await call('viewer', 'GET', '/hr/people?status=exited,on_leave');
    assert.deepEqual(two.body.map((p) => p.id), [p3]);
    assert.equal((await call('viewer', 'GET', '/hr/people?status=')).body.length, 3, 'an empty status is every status');
    refused(await call('viewer', 'GET', '/hr/people?status=bogus'), 400);
    // No row is ever deleted: there is no DELETE for a person.
    assert.notEqual((await call('admin', 'DELETE', `/hr/people/${p3}`)).status, 200);
    assert.equal((await db.one(`SELECT count(*)::int AS n FROM hr.people`)).n, 3);
  });

  // ── Aliases and the name guards (Ruling T3-e) ──

  test('an alias is stored normalised and unique, and can never equal a person\'s name or display name', T, async () => {
    const made = await call('operator', 'POST', `/hr/people/${p1}/aliases`, { alias: '  t   p   One ' });
    assert.equal(made.status, 200, made.text);
    assert.equal(made.body.alias_norm, 'T P ONE');
    assert.equal(made.body.person_id, p1);
    assert.equal(made.body.source, 'manual');
    assert.equal(made.body.approved_by, ids.operator);
    const aliasId = made.body.id;
    assert.equal((await lastAudit('alias', aliasId)).action, 'create');

    // The same spelling again, by anyone: unique.
    const dup = await refusedWrite('operator', 'POST', `/hr/people/${p2}/aliases`, { alias: 'T P one' }, 409, 'ALIAS_EXISTS');
    assert.match(dup.body.error, /Test Person One/);
    // ALIAS_IS_A_NAME: a name, in any case or spacing; and a display name.
    await refusedWrite('operator', 'POST', `/hr/people/${p2}/aliases`, { alias: 'test person one' }, 409, 'ALIAS_IS_A_NAME');
    await refusedWrite('operator', 'POST', `/hr/people/${p1}/aliases`, { alias: ' TEST   PERSON  ONE ' }, 409, 'ALIAS_IS_A_NAME');
    await refusedWrite('operator', 'POST', `/hr/people/${p1}/aliases`, { alias: 'tp two' }, 409, 'ALIAS_IS_A_NAME');
    await refusedWrite('operator', 'POST', `/hr/people/${p1}/aliases`, { alias: '   ' }, 400);
    await refusedWrite('operator', 'POST', `/hr/people/${p1}/aliases`, { alias: 7 }, 400);
    await refusedWrite('operator', 'POST', `/hr/people/${p1}/aliases`, {}, 400);
    refused(await call('operator', 'POST', '/hr/people/9999/aliases', { alias: 'Ghost' }), 404);

    // NAME_IS_AN_ALIAS: a new person, or a renamed one, whose name or display name is somebody's alias.
    await refusedWrite('operator', 'POST', '/hr/people', { code: 'N-2', name: 't p one' }, 409, 'NAME_IS_AN_ALIAS');
    await refusedWrite('operator', 'POST', '/hr/people', { code: 'N-2', name: 'Fresh Name', display_name: 'T  P  One' }, 409, 'NAME_IS_AN_ALIAS');
    await refusedWrite('operator', 'PUT', `/hr/people/${p2}`, { name: 'T P One' }, 409, 'NAME_IS_AN_ALIAS');
    await refusedWrite('operator', 'PUT', `/hr/people/${p2}`, { display_name: 't p one' }, 409, 'NAME_IS_AN_ALIAS');
    assert.equal((await db.one(`SELECT name FROM hr.people WHERE id = $1`, [p2])).name, 'Test Person Two', 'the refused rename changed nothing');
    // The guard is about somebody else's alias: a person's own does not count against their name.
    assert.equal((await call('operator', 'PUT', `/hr/people/${p1}`, { name: 'T P One' })).status, 200);
    assert.equal((await call('operator', 'PUT', `/hr/people/${p1}`, { name: 'Test Person One' })).status, 200);

    // The detail lists it; removing it lifts the guard.
    const detail = (await call('viewer', 'GET', `/hr/people/${p1}`)).body;
    assert.deepEqual(detail.aliases.map((a) => a.alias_norm), ['T P ONE']);
    const gone = await call('operator', 'DELETE', `/hr/aliases/${aliasId}`);
    assert.equal(gone.status, 200, gone.text);
    assert.deepEqual(gone.body, { ok: true });
    assert.equal((await lastAudit('alias', aliasId)).action, 'delete');
    refused(await call('operator', 'DELETE', `/hr/aliases/${aliasId}`), 404);
    const fresh = await call('operator', 'POST', '/hr/people', { code: 'N-2', name: 'T P One' });
    assert.equal(fresh.status, 200, fresh.text);
    p4 = fresh.body.id;
    // ...and now that spelling is a name, so it cannot be an alias again.
    await refusedWrite('operator', 'POST', `/hr/people/${p1}/aliases`, { alias: 't p one' }, 409, 'ALIAS_IS_A_NAME');
  });

  test('a person links to one ERP operator at most', T, async () => {
    operatorId = (await db.one(
      `INSERT INTO employees (name, role, section) VALUES ('Test Floor Operator', 'operator', 'printing') RETURNING id`)).id;
    await db.q(`INSERT INTO employees (name, role, section, active) VALUES ('Test Retired Operator', 'helper', 'cutting', 0)`);

    const linked = await call('operator', 'PUT', `/hr/people/${p2}`, { employee_id: operatorId });
    assert.equal(linked.status, 200, linked.text);
    assert.equal(linked.body.employee_id, operatorId);
    const taken = await refusedWrite('operator', 'PUT', `/hr/people/${p1}`, { employee_id: operatorId }, 409, 'EMPLOYEE_LINKED');
    assert.match(taken.body.error, /Test Person Two/);
    await refusedWrite('operator', 'PUT', `/hr/people/${p1}`, { employee_id: 987654 }, 400);
    await refusedWrite('operator', 'PUT', `/hr/people/${p1}`, { employee_id: 'abc' }, 400);

    const list = await call('operator', 'GET', '/hr/erp-operators');
    assert.equal(list.status, 200, list.text);
    assert.deepEqual(list.body.map((o) => o.name), ['Test Floor Operator', 'Test Retired Operator']);
    assert.deepEqual(Object.keys(list.body[0]).sort(), ['active', 'id', 'name', 'section']);
    assert.equal(list.body[0].active, 1);
    assert.equal(list.body[1].active, 0, 'inactive operators are listed, flagged');
    assert.equal(list.body[0].section, 'printing');

    const unlinked = await call('operator', 'PUT', `/hr/people/${p2}`, { employee_id: null });
    assert.equal(unlinked.body.employee_id, null);
    assert.equal((await call('operator', 'PUT', `/hr/people/${p1}`, { employee_id: operatorId })).status, 200, 'free once unlinked');
    await call('operator', 'PUT', `/hr/people/${p1}`, { employee_id: null });
  });

  // ── Settings ──

  test('settings: the seeded policy reads back flat; only known keys with valid values are saved', T, async () => {
    const read = await call('viewer', 'GET', '/hr/settings');
    assert.equal(read.status, 200, read.text);
    assert.equal(read.body.rounding, 'rupee');
    assert.equal(read.body.ot_high_hours, 150);
    assert.equal(read.body.deduction_warn_pct, 50);
    assert.equal(read.body.variance_warn_pct, 25);
    assert.equal(read.body.holiday_divisor_default, 30.5);
    assert.equal(read.body.strict_separation, false);
    assert.deepEqual(read.body.blank_zero, { ot_hours: true, absent_days: true, misc_earning: true, advance_given: true, bill_amount: true });

    const bad = [
      {}, { nope: 1 }, { rounding: 'ceil' }, { rounding: 1 }, { ot_high_hours: -1 }, { ot_high_hours: 'lots' },
      { ot_high_hours: null }, { deduction_warn_pct: 101 }, { variance_warn_pct: -5 }, { holiday_divisor_default: 0 },
      { holiday_divisor_default: -30 }, { strict_separation: 'true' }, { strict_separation: 1 },
      { blank_zero: 'all' }, { blank_zero: [true] }, { blank_zero: { ot_hours: 'yes' } }, { blank_zero: { not_a_column: true } },
      { rounding: 'paise', ot_high_hours: -1 },
    ];
    for (const body of bad) await refusedWrite('admin', 'PUT', '/hr/settings', body, 400);
    const after = (await call('admin', 'GET', '/hr/settings')).body;
    assert.deepEqual(after, read.body, 'a request with one bad key saves none of its keys');

    const saved = await call('admin', 'PUT', '/hr/settings', {
      ot_high_hours: 160, rounding: 'paise', strict_separation: true, holiday_divisor_default: '30.25',
      blank_zero: { ot_hours: false, absent_days: true },
    });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.body.ot_high_hours, 160);
    assert.equal(saved.body.rounding, 'paise');
    assert.equal(saved.body.strict_separation, true);
    assert.equal(saved.body.holiday_divisor_default, 30.25);
    assert.deepEqual(saved.body.blank_zero, { ot_hours: false, absent_days: true }, 'blank_zero is replaced as a whole');
    assert.equal(saved.body.deduction_warn_pct, 50, 'keys not sent are left alone');
    assert.deepEqual((await lastAudit('setting', 'ot_high_hours')).detail, { from: 150, to: 160 });
    assert.equal((await lastAudit('setting', 'rounding')).action, 'update');
    const row = await db.one(`SELECT updated_by FROM hr.settings WHERE key = 'ot_high_hours'`);
    assert.equal(row.updated_by, ids.admin);

    // The same values again change nothing and audit nothing.
    const before = await hrAuditCount();
    const same = await call('admin', 'PUT', '/hr/settings', { ot_high_hours: 160, rounding: 'paise' });
    assert.equal(same.status, 200, same.text);
    assert.equal(await hrAuditCount(), before);
    // Put the policy back as it was.
    await call('admin', 'PUT', '/hr/settings', {
      ot_high_hours: 150, rounding: 'rupee', strict_separation: false, holiday_divisor_default: 30.5,
      blank_zero: read.body.blank_zero,
    });
    assert.deepEqual((await call('viewer', 'GET', '/hr/settings')).body, read.body);
  });

  // ── Dashboard ──

  test('the dashboard reports headcount, the month\'s run and payments, loans, advances and exceptions', T, async () => {
    // Joined this month, and an empty month with no run.
    await call('operator', 'PUT', `/hr/people/${p1}`, { joined_on: '2026-08-10' });
    const empty = await call('viewer', 'GET', '/hr/dashboard?month=2026-05');
    assert.equal(empty.status, 200, empty.text);
    assert.equal(empty.body.month, '2026-05');
    assert.equal(empty.body.run, null);
    assert.equal(empty.body.payments, null);
    assert.deepEqual(empty.body.loans, { count: 0, outstanding: '0.00' });
    assert.deepEqual(empty.body.advances, { count: 0, outstanding: '0.00' });
    assert.deepEqual(empty.body.exceptions, {
      lines: 0, blocked: 0, warned: 0, by_code: [], people_without_setup: 1, unresolved_import_rows: 0,
    }, 'only p4: p3 has left, and p1 and p2 have setups from 2020');
    assert.deepEqual(empty.body.headcount, { active: 3, on_leave: 0, exited: 1, joined_this_month: 0, exited_this_month: 0 });

    // The ledgers: p1 owes 2000.00 in advance and 12000.00 on one loan (a second loan is closed).
    await db.q(
      `INSERT INTO hr.advance_txns (person_id, txn_date, kind, amount, source) VALUES
         ($1, '2026-07-31', 'opening', 2500, 'loader'), ($1, '2026-08-05', 'given', 500, 'manual'),
         ($1, '2026-08-31', 'recovered', 1000, 'payroll')`, [p1]);
    const open = await db.one(
      `INSERT INTO hr.loans (loan_no, person_id, principal, issued_on, instalment, first_due_month, is_opening)
       VALUES ('CI-LN-0001', $1, 12000, '2026-07-31', 3000, '2026-08', true) RETURNING id`, [p1]);
    await db.q(`INSERT INTO hr.loan_txns (loan_id, txn_date, kind, principal_amount) VALUES ($1, '2026-07-31', 'opening', 12000)`, [open.id]);
    const closed = await db.one(
      `INSERT INTO hr.loans (loan_no, person_id, principal, issued_on, instalment, first_due_month, status)
       VALUES ('CI-LN-0002', $1, 1000, '2026-01-10', 500, '2026-02', 'closed') RETURNING id`, [p1]);
    await db.q(
      `INSERT INTO hr.loan_txns (loan_id, txn_date, kind, principal_amount) VALUES
         ($1, '2026-01-10', 'disbursed', 1000), ($1, '2026-03-01', 'prepayment', 1000)`, [closed.id]);
    // A finalised August run: p1's line is paid and carries warnings; p2's is pending and blocked.
    const run = await db.one(
      `INSERT INTO hr.runs (month, days_in_month, status, totals, finalised_at)
       VALUES ('2026-08', 31, 'finalised', $1::jsonb, now()) RETURNING id`,
      [JSON.stringify({ lines: 2, blocked: 1, gross: '8000.00', payable: '8000.00', by_channel: [{ pay_channel: 'BANK1', lines: 1, payable: '5000.00', carried_advance: '0.00' }] })]);
    await db.q(
      `INSERT INTO hr.run_lines (run_id, person_id, gross, payable, payment_status, flags, pay_channel) VALUES
         ($1, $2, 5000, 5000, 'paid', $3::jsonb, 'BANK1'), ($1, $4, 3000, 3000, 'pending', $5::jsonb, 'CASH')`,
      [run.id, p1,
        JSON.stringify([{ level: 'warn', code: 'INSUFFICIENT_PAY', message: 'm' }, { level: 'info', code: 'VARIANCE', message: 'm' }]),
        p2, JSON.stringify([{ level: 'block', code: 'NO_SETUP', message: 'm' }])]);
    // An import for August still waiting: three rows to decide (a fourth is ignored, a fifth is matched).
    const batch = await db.one(
      `INSERT INTO hr.import_batches (month, file_name, file_sha256, status) VALUES ('2026-08', 'a.xlsx', repeat('a', 64), 'parsed') RETURNING id`);
    await db.q(
      `INSERT INTO hr.import_rows (batch_id, row_no, raw, match, decision) VALUES
         ($1, 1, '{}'::jsonb, 'unmatched', NULL), ($1, 2, '{}'::jsonb, 'conflict', NULL), ($1, 3, '{}'::jsonb, 'unknown_code', NULL),
         ($1, 4, '{}'::jsonb, 'unmatched', 'ignore')`, [batch.id]);
    await db.q(`INSERT INTO hr.import_rows (batch_id, row_no, raw, match, person_id) VALUES ($1, 5, '{}'::jsonb, 'code', $2)`, [batch.id, p1]);

    const res = await call('viewer', 'GET', '/hr/dashboard?month=2026-08');
    assert.equal(res.status, 200, res.text);
    const d = res.body;
    assert.equal(d.month, '2026-08');
    assert.deepEqual(d.headcount, { active: 3, on_leave: 0, exited: 1, joined_this_month: 1, exited_this_month: 1 });
    assert.equal(d.run.status, 'finalised');
    assert.equal(d.run.month, '2026-08');
    assert.equal(d.run.days_in_month, 31);
    assert.equal(d.run.totals.gross, '8000.00', 'the run\'s stored totals pass through as they are');
    assert.equal(d.run.totals.by_channel[0].pay_channel, 'BANK1');
    assert.deepEqual(d.payments, {
      paid_lines: 1, paid_amount: '5000.00', pending_lines: 1, pending_amount: '3000.00', on_hold_lines: 0, on_hold_amount: '0.00',
      final: true,
    });
    assert.deepEqual(d.loans, { count: 1, outstanding: '12000.00' });
    assert.deepEqual(d.advances, { count: 1, outstanding: '2000.00' });
    assert.deepEqual(d.exceptions, {
      lines: 2, blocked: 1, warned: 1,
      by_code: [
        { level: 'block', code: 'NO_SETUP', people: 1 },
        { level: 'warn', code: 'INSUFFICIENT_PAY', people: 1 },
        { level: 'info', code: 'VARIANCE', people: 1 },
      ],
      people_without_setup: 1,
      unresolved_import_rows: 3,
    });

    // Read only, and the default month is the plant's current one.
    const now = await call('viewer', 'GET', '/hr/dashboard');
    assert.equal(now.status, 200, now.text);
    assert.equal(now.body.month, plantDateStr().slice(0, 7));
    for (const month of ['2026-8', '2026-13', 'August', '2026-08-01']) refused(await call('viewer', 'GET', `/hr/dashboard?month=${month}`), 400);
    assert.equal((await db.one(`SELECT count(*)::int AS n FROM hr.advance_txns`)).n, 3, 'a dashboard moves no balance');
  });

  test('the person detail carries the ledgers: advance balance, every loan with what it owes, the last paid months', T, async () => {
    const res = await call('viewer', 'GET', `/hr/people/${p1}`);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.advance_balance, '2000.00', 'opening + given - recovered, an exact string');
    assert.deepEqual(res.body.loans.map((l) => l.loan_no), ['CI-LN-0001', 'CI-LN-0002'], 'newest issue first');
    const open = res.body.loans.find((l) => l.loan_no === 'CI-LN-0001');
    assert.equal(open.status, 'active');
    assert.equal(open.is_opening, true);
    assert.equal(open.principal, 12000);
    assert.equal(open.instalment, 3000);
    assert.equal(open.first_due_month, '2026-08');
    assert.equal(open.outstanding, '12000.00');
    assert.match(open.due_this_month, /^\d+\.\d{2}$/);
    const closed = res.body.loans.find((l) => l.loan_no === 'CI-LN-0002');
    assert.equal(closed.status, 'closed');
    assert.equal(closed.outstanding, '0.00');
    assert.equal(closed.due_this_month, '0.00');
    assert.equal(closed.issued_on, '2026-01-10');
    assert.deepEqual(res.body.recent_lines, [{ month: '2026-08', gross: 5000, payable: 5000, payment_status: 'paid' }]);
    // An open (not finalised) run is not a payslip month.
    await db.q(`INSERT INTO hr.runs (month, days_in_month) VALUES ('2026-09', 30)`);
    const run9 = await db.one(`SELECT id FROM hr.runs WHERE month = '2026-09'`);
    await db.q(`INSERT INTO hr.run_lines (run_id, person_id, gross, payable) VALUES ($1, $2, 100, 100)`, [run9.id, p1]);
    assert.equal((await call('viewer', 'GET', `/hr/people/${p1}`)).body.recent_lines.length, 1);
  });

  // ── A revision into a locked month (T9-d) ──

  test('a pay revision dated on or before the latest finalised month is saved with a warning; a later one has none', T, async () => {
    // August 2026 is the latest FINALISED run (the dashboard test made it); the September draft does not count.
    const WARNING = 'This revision starts on or before August 2026, which is locked; locked months are not changed — add an arrears adjustment if needed.';
    const revision = (effective_from) => ({ effective_from, pay_basis: 'daily', base: 500, note: 'Test revision' });
    const url = `/hr/people/${p4}/setups`;
    const lines = async () => (await db.q(`SELECT person_id, gross::text AS gross FROM hr.run_lines ORDER BY id`));
    const lockedBefore = await lines();

    const earlier = await call('operator', 'POST', url, revision('2026-07-01'));
    assert.equal(earlier.status, 200, earlier.text);
    assert.equal(earlier.body.warning, WARNING, 'a month before the locked one');
    assert.equal(earlier.body.effective_from, '2026-07-01', 'it is saved as asked');
    assert.equal(earlier.body.base, 500);
    assert.equal(earlier.body.person_id, p4);
    const onIt = await call('operator', 'POST', url, revision('2026-08-01'));
    assert.equal(onIt.status, 200, onIt.text);
    assert.equal(onIt.body.warning, WARNING, 'the locked month itself');
    const after = await call('operator', 'POST', url, revision('2026-09-01'));
    assert.equal(after.status, 200, after.text);
    assert.ok(!('warning' in after.body), 'the month after the locked one is open: no warning');
    assert.equal(after.body.effective_from, '2026-09-01');

    // Saved, audited (the warning is not an error), and the locked month itself is untouched.
    assert.deepEqual((await call('viewer', 'GET', `/hr/people/${p4}`)).body.setups.map((x) => x.effective_from),
      ['2026-09-01', '2026-08-01', '2026-07-01']);
    assert.equal((await lastAudit('pay_setup', earlier.body.id)).detail.locked_through, '2026-08');
    assert.ok(!('locked_through' in (await lastAudit('pay_setup', after.body.id)).detail));
    assert.deepEqual(await lines(), lockedBefore, 'the finalised run\'s lines are not changed');
    // The warning belongs to the save: it is not repeated on a read, and a refused revision has none.
    assert.ok(!('warning' in (await call('viewer', 'GET', `/hr/people/${p4}`)).body.setups[2]));
    const dup = await refusedWrite('operator', 'POST', url, revision('2026-07-01'), 409, 'SETUP_EXISTS');
    assert.ok(!('warning' in dup.body));
  });

  // ── Nothing is cached ──

  test('every HR answer is no-store, and a GET that reads ERP tables is not offered to the response cache', T, async () => {
    // Control: a plant GET over the same table IS announced to the response cache.
    const plant = await call('operator', 'GET', '/employees');
    assert.equal(plant.status, 200, plant.text);
    assert.match(plant.headers.get('x-data-tables') ?? '', /employees/, 'the control: this header is what HR must not send');

    for (const [who, url] of [['operator', '/hr/erp-operators'], ['admin', '/hr/access'], ['viewer', '/hr/people'],
      ['viewer', `/hr/people/${p1}`], ['viewer', '/hr/settings'], ['viewer', '/hr/pay-channels'],
      ['viewer', '/hr/dashboard'], ['approver', '/hr/audit'], ['viewer', '/hr/me']]) {
      const res = await call(who, 'GET', url);
      assert.equal(res.status, 200, `${url}: ${res.text}`);
      assert.equal(res.headers.get('x-data-tables'), null, `${url} must not be cacheable`);
      assert.equal(res.headers.get('cache-control'), 'no-store', `${url} must be no-store`);
    }
    const write = await call('operator', 'PUT', `/hr/people/${p2}`, { notes: 'a note' });
    assert.equal(write.headers.get('cache-control'), 'no-store');
  });

  // ── Access ──

  test('access: the list shows every login with its level; a level is granted and removed live', T, async () => {
    const list = await call('admin', 'GET', '/hr/access');
    assert.equal(list.status, 200, list.text);
    const byName = Object.fromEntries(list.body.map((u) => [u.name, u]));
    assert.equal(byName['Plain Admin'].level, null, 'an ERP admin has no HR level of its own');
    assert.equal(byName['Plain Admin'].role, 'admin');
    assert.equal(byName['HR Viewer'].level, 'viewer');
    assert.equal(byName['HR Operator'].level, 'operator');
    assert.equal(byName['HR Approver'].level, 'approver');
    assert.equal(byName['HR Admin'].level, 'admin');
    assert.equal(byName['HR Admin'].user_id, ids.admin);
    assert.equal(byName['HR Admin'].id, ids.admin);
    assert.equal(byName['HR Admin'].email, 'admin@test.local');
    assert.equal(byName['HR Admin'].active, 1);
    assert.ok(!list.text.includes('password_hash'));

    // Granted: the very next request is let in (the guard reads hr.access afresh).
    refused(await call('plain', 'GET', '/hr/people'), 403, 'HR_NO_ACCESS');
    const granted = await call('admin', 'PUT', `/hr/access/${ids.plain}`, { level: 'viewer', note: 'trial' });
    assert.equal(granted.status, 200, granted.text);
    assert.equal(granted.body.find((u) => u.user_id === ids.plain).level, 'viewer');
    assert.equal((await call('plain', 'GET', '/hr/people')).status, 200);
    refused(await call('plain', 'POST', '/hr/people', { code: 'P-1', name: 'Plain Made' }), 403, 'HR_LEVEL');
    const grant = await lastAudit('access', ids.plain);
    assert.equal(grant.action, 'grant');
    assert.deepEqual(grant.detail, { user: 'Plain Admin', from: null, to: 'viewer' });
    assert.deepEqual(await db.one(`SELECT level, granted_by, note FROM hr.access WHERE user_id = $1`, [ids.plain]),
      { level: 'viewer', granted_by: ids.admin, note: 'trial' });

    // Changed, then removed.
    assert.equal((await call('admin', 'PUT', `/hr/access/${ids.plain}`, { level: 'operator' })).status, 200);
    assert.equal((await lastAudit('access', ids.plain)).action, 'change');
    const before = await hrAuditCount();
    assert.equal((await call('admin', 'PUT', `/hr/access/${ids.plain}`, { level: 'operator' })).status, 200);
    assert.equal(await hrAuditCount(), before, 'the same level again is not a change');
    const removed = await call('admin', 'PUT', `/hr/access/${ids.plain}`, { level: null });
    assert.equal(removed.status, 200, removed.text);
    assert.equal(removed.body.find((u) => u.user_id === ids.plain).level, null);
    assert.equal((await lastAudit('access', ids.plain)).action, 'revoke');
    refused(await call('plain', 'GET', '/hr/people'), 403, 'HR_NO_ACCESS');

    await refusedWrite('admin', 'PUT', `/hr/access/${ids.plain}`, { level: 'owner' }, 400);
    await refusedWrite('admin', 'PUT', `/hr/access/${ids.plain}`, {}, 400);
    await refusedWrite('admin', 'PUT', '/hr/access/987654', { level: 'viewer' }, 404);
    await refusedWrite('admin', 'PUT', '/hr/access/abc', { level: 'viewer' }, 404);
  });

  test('the last admin who can sign in cannot be removed or demoted (LAST_ADMIN), logins that are switched off do not count', T, async () => {
    const level = async (id) => (await db.one(`SELECT level FROM hr.access WHERE user_id = $1`, [id]))?.level ?? null;
    // One admin: neither a demotion nor a removal.
    await refusedWrite('admin', 'PUT', `/hr/access/${ids.admin}`, { level: 'operator' }, 409, 'LAST_ADMIN');
    await refusedWrite('admin', 'PUT', `/hr/access/${ids.admin}`, { level: null }, 409, 'LAST_ADMIN');
    assert.equal(await level(ids.admin), 'admin');

    // A second admin whose ERP login is then switched off is not an admin who can sign in.
    const { default: jwt } = await import('jsonwebtoken');
    const { JWT_SECRET } = await import('./auth.js');
    const two = await db.one(`INSERT INTO users (name, email, password_hash, role) VALUES ('HR Admin Two', 'admin2@test.local', 'x', 'viewer') RETURNING id, name, role`);
    tokens.admin2 = jwt.sign({ id: two.id, name: two.name, role: two.role }, JWT_SECRET);
    const granted = await call('admin', 'PUT', `/hr/access/${two.id}`, { level: 'admin' });
    assert.equal(granted.status, 200, granted.text);
    await db.q(`UPDATE users SET active = 0 WHERE id = $1`, [two.id]);
    const listed = (await call('admin', 'GET', '/hr/access')).body.find((u) => u.user_id === two.id);
    assert.equal(listed.active, 0, 'a switched-off login is listed, flagged');
    assert.equal(listed.level, 'admin');
    await refusedWrite('admin', 'PUT', `/hr/access/${ids.admin}`, { level: 'viewer' }, 409, 'LAST_ADMIN');
    await refusedWrite('admin', 'PUT', `/hr/access/${ids.admin}`, { level: null }, 409, 'LAST_ADMIN');
    assert.equal(await level(ids.admin), 'admin');

    // Switched on again, the other can take over: the first may step down, and the second restores it.
    await db.q(`UPDATE users SET active = 1 WHERE id = $1`, [two.id]);
    const down = await call('admin', 'PUT', `/hr/access/${ids.admin}`, { level: 'operator' });
    assert.equal(down.status, 200, down.text);
    assert.equal(await level(ids.admin), 'operator');
    refused(await call('admin', 'PUT', '/hr/settings', { rounding: 'rupee' }), 403, 'HR_LEVEL');   // and the demotion is live
    // The remaining admin is now the last one.
    await refusedWrite('admin2', 'PUT', `/hr/access/${two.id}`, { level: null }, 409, 'LAST_ADMIN');
    const back = await call('admin2', 'PUT', `/hr/access/${ids.admin}`, { level: 'admin' });
    assert.equal(back.status, 200, back.text);
    assert.equal(await level(ids.admin), 'admin');
    // With two admins, either may go.
    assert.equal((await call('admin', 'PUT', `/hr/access/${two.id}`, { level: null })).status, 200);
    assert.equal(await level(two.id), null);
  });

  // ── Audit ──

  test('the audit trail: filtered, newest first, approver and above, and never a secret', T, async () => {
    const all = await call('approver', 'GET', '/hr/audit?limit=1000');
    assert.equal(all.status, 200, all.text);
    assert.ok(all.body.length > 20);
    for (let i = 1; i < all.body.length; i++) assert.ok(all.body[i - 1].id > all.body[i].id, 'newest first');
    assert.deepEqual(Object.keys(all.body[0]).sort(), ['action', 'at', 'detail', 'entity', 'entity_id', 'id', 'user_id', 'user_name']);
    for (const secret of [ACCOUNT, ACCOUNT_2, CHANNEL_ACCOUNT, '555566667777', '777788889999', PAN, PAN_2, UAN, ESI_NO, ESI_DIGITS]) {
      assert.ok(!all.text.includes(secret), `the audit trail never carries ${secret.slice(0, 4)}…`);
    }

    const person = await call('approver', 'GET', `/hr/audit?entity=person&entity_id=${p1}`);
    assert.ok(person.body.length >= 4);
    assert.ok(person.body.every((row) => row.entity === 'person' && row.entity_id === String(p1)));
    assert.equal(person.body.at(-1).action, 'create');
    const limited = await call('approver', 'GET', '/hr/audit?limit=2');
    assert.equal(limited.body.length, 2);
    refused(await call('approver', 'GET', '/hr/audit?limit=0'), 400);
    refused(await call('approver', 'GET', '/hr/audit?limit=abc'), 400);

    // Every kind of write above left its row.
    const seen = (await db.q(`SELECT DISTINCT entity || ':' || action AS k FROM hr.audit_log ORDER BY 1`)).map((r) => r.k);
    for (const want of ['person:create', 'person:update', 'pay_setup:create', 'alias:create', 'alias:delete', 'setting:update',
      'pay_channel:create', 'pay_channel:update', 'access:grant', 'access:change', 'access:revoke']) {
      assert.ok(seen.includes(want), `no audit row for ${want}; saw ${seen.join(', ')}`);
    }
    // The signer is whoever made the call.
    const who = await db.one(`SELECT user_id, user_name FROM hr.audit_log WHERE entity = 'setting' AND entity_id = 'rounding' ORDER BY id LIMIT 1`);
    assert.deepEqual(who, { user_id: ids.admin, user_name: 'HR Admin' });
  });

  test('HR writes never touch the plant audit_log, which /timeline shows to every login', T, async () => {
    assert.equal((await db.one(`SELECT count(*)::int AS n FROM audit_log`)).n, publicAuditBefore);
    const timeline = await call('plain', 'GET', '/timeline');
    assert.equal(timeline.status, 200, timeline.text);
    assert.ok(!timeline.text.includes('Test Person'), 'no HR name reaches the timeline');
  });

  test('the constraints the route maps to 409s still exist under those names', T, async () => {
    const found = (await db.q(
      `SELECT conname AS name FROM pg_constraint WHERE connamespace = 'hr'::regnamespace
        UNION SELECT indexname FROM pg_indexes WHERE schemaname = 'hr'`)).map((r) => r.name);
    for (const name of ['people_code_key', 'people_employee_id_uq', 'pay_setups_person_id_effective_from_key',
      'person_aliases_alias_norm_key', 'pay_channels_pkey']) {
      assert.ok(found.includes(name), `${name} is gone: routes/hr.js maps its unique violation to a 409`);
    }
  });
});
