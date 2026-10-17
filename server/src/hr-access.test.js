// The HR access wall (hr/access.js) and the HR audit writer (hr/audit.js) — no database.
//
// Every /api/hr route sits behind hrGuard (a row in hr.access, read fresh from the database,
// never from the JWT) and a per-route requireHr(level). Both fail closed: no row, an unknown
// level, a missing user or a failed read never reach the route. The database side of the
// guard is proven in hr-schema-pg.test.js (HR_PG=1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { HR_LEVELS, levelAtLeast, hrAccessFor, hrGuard, hrGuardWith, requireHr } from './hr/access.js';
import { hrAudit } from './hr/audit.js';

const fakeRes = () => ({
  statusCode: 0, body: null,
  status(c) { this.statusCode = c; return this; },
  json(b) { this.body = b; return this; },
});
const NO_ACCESS = { error: 'You do not have access to HR & Payroll', code: 'HR_NO_ACCESS' };

// ── The brief's checks ─────────────────────────────────────────────────

test('brief: levels and requireHr', () => {
  assert.equal(levelAtLeast('approver', 'operator'), true); assert.equal(levelAtLeast('viewer', 'operator'), false);
  assert.equal(levelAtLeast(null, 'viewer'), false);
  const res = { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  requireHr('approver')({ hr: { level: 'operator' } }, res, () => assert.fail('must not pass'));
  assert.equal(res.statusCode, 403); assert.equal(res.body.code, 'HR_LEVEL');
  let passed = false; requireHr('operator')({ hr: { level: 'admin' } }, res, () => { passed = true; }); assert.ok(passed);
});

// ── Levels ─────────────────────────────────────────────────────────────

test('HR_LEVELS is the ladder, lowest first, and cannot be changed', () => {
  assert.deepEqual(HR_LEVELS, ['viewer', 'operator', 'approver', 'admin']);
  assert.ok(Object.isFrozen(HR_LEVELS));
});

test('levelAtLeast: each level includes the ones before it', () => {
  for (const [i, have] of HR_LEVELS.entries()) {
    for (const [j, need] of HR_LEVELS.entries()) assert.equal(levelAtLeast(have, need), i >= j, `${have} ≥ ${need}`);
  }
});

test('levelAtLeast: anything that is not a level is no access', () => {
  for (const bad of [undefined, null, '', 'ADMIN', 'Admin', ' admin', 'superadmin', 'root', 'toString', 'constructor', 3, {}, ['admin']]) {
    assert.equal(levelAtLeast(bad, 'viewer'), false, String(bad));
  }
  assert.equal(levelAtLeast('admin', 'owner'), false, 'an unknown minimum is never met');
  assert.equal(levelAtLeast('admin', undefined), false);
});

// ── requireHr ──────────────────────────────────────────────────────────

test('requireHr refuses with the exact error shape, and passes at or above the minimum', () => {
  const res = fakeRes();
  requireHr('approver')({ hr: { level: 'viewer' } }, res, () => assert.fail('must not pass'));
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Needs HR approver access', code: 'HR_LEVEL' });
  for (const min of HR_LEVELS) {
    let passed = 0;
    requireHr(min)({ hr: { level: min } }, fakeRes(), () => { passed++; });
    assert.equal(passed, 1, `${min} passes requireHr('${min}')`);
  }
});

test('requireHr fails closed when the guard never ran', () => {
  for (const req of [{}, { hr: null }, { hr: {} }, { hr: { level: 'god' } }]) {
    const res = fakeRes();
    requireHr('viewer')(req, res, () => assert.fail('must not pass'));
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { error: 'Needs HR viewer access', code: 'HR_LEVEL' });
  }
});

test('requireHr with a misspelt level throws when the route is defined, not when it is called', () => {
  assert.throws(() => requireHr('aprover'), TypeError);
  assert.throws(() => requireHr(), TypeError);
});

// ── hrGuard ────────────────────────────────────────────────────────────

// Runs a guard to completion: resolves once it has answered or called next (a guard that
// does neither would leave the request hanging — that is a failure too).
const runGuard = (guard, req) => new Promise((resolve, reject) => {
  const res = fakeRes();
  const json = res.json.bind(res);
  const timer = setTimeout(() => reject(new Error('the guard neither answered nor called next')), 2000);
  const done = (out) => { clearTimeout(timer); resolve(out); };
  res.json = (b) => { json(b); done({ res, nextCalls: [] }); return res; };
  guard(req, res, (...args) => done({ res, nextCalls: [args] }));
});

test('hrGuard is the guard over hrAccessFor, and hrAccessFor never reads without a user id', async () => {
  assert.equal(typeof hrGuard, 'function');
  assert.equal(hrGuard.length, 3, 'hrGuard(req, res, next)');
  // No pool is connected in this test: any of these reaching the database would throw.
  for (const id of [undefined, null, '', 'abc', 0, -1, 1.5, NaN, Infinity, '7; drop', ' 7 ', '1e1', '0x10', '-3',
    true, {}, [7], 2 ** 53]) {
    assert.equal(await hrAccessFor(id), null, String(id));
  }
  const { res, nextCalls } = await runGuard(hrGuard, {});
  assert.equal(nextCalls.length, 0);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, NO_ACCESS);
});

test('hrGuard: no row is a 403 with the exact error shape', async () => {
  const { res, nextCalls } = await runGuard(hrGuardWith(async () => null), { user: { id: 7, name: 'Op', role: 'admin' } });
  assert.equal(nextCalls.length, 0, 'an ERP admin without an HR row is refused');
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, NO_ACCESS);
});

test('hrGuard: a row passes with req.hr = {level}, frozen', async () => {
  const seen = [];
  const req = { user: { id: 7, name: 'Op', role: 'viewer' } };
  const { nextCalls } = await runGuard(hrGuardWith(async (id) => { seen.push(id); return 'operator'; }), req);
  assert.deepEqual(nextCalls, [[]], 'next() with no error');
  assert.deepEqual(seen, [7]);
  assert.deepEqual(req.hr, { level: 'operator' });
  assert.ok(Object.isFrozen(req.hr), 'a route cannot raise its own level');
});

test('hrGuard: a level the ladder does not know is no access', async () => {
  for (const level of ['owner', 'ADMIN', '', 0, undefined]) {
    const req = { user: { id: 7 } };
    const { res, nextCalls } = await runGuard(hrGuardWith(async () => level), req);
    assert.equal(nextCalls.length, 0, String(level));
    assert.equal(res.statusCode, 403);
    assert.equal(req.hr, undefined);
  }
});

test('hrGuard: a failed read never reaches the route', async () => {
  const boom = new Error('connection reset');
  const req = { user: { id: 7 } };
  const { res, nextCalls } = await runGuard(hrGuardWith(async () => { throw boom; }), req);
  assert.deepEqual(nextCalls, [[boom]], 'the error goes to the error handler');
  assert.equal(res.statusCode, 0, 'nothing answered as if allowed');
  assert.equal(req.hr, undefined);
});

test('hrGuard: a missing or unusable user id is refused without a lookup', async () => {
  for (const user of [undefined, null, {}, { id: null }, { id: 'x' }, { id: 0 }, { id: -3 }, { id: 2.5 }, { id: true },
    { id: ' 7' }]) {
    let looked = 0;
    const { res, nextCalls } = await runGuard(hrGuardWith(async () => { looked++; return 'admin'; }), { user });
    assert.equal(looked, 0, JSON.stringify(user));
    assert.equal(nextCalls.length, 0);
    assert.deepEqual(res.body, NO_ACCESS);
  }
  // A digit string is the same login as its number.
  const seen = [];
  await runGuard(hrGuardWith(async (id) => { seen.push(id); return 'viewer'; }), { user: { id: '7' } });
  assert.deepEqual(seen, [7]);
});

test('hrGuard memoises: several guards on one request read hr.access once', async () => {
  let looked = 0;
  const guard = hrGuardWith(async () => { looked++; return 'approver'; });
  const req = { user: { id: 9 } };
  for (let i = 0; i < 3; i++) {
    const { nextCalls } = await runGuard(guard, req);
    assert.deepEqual(nextCalls, [[]]);
  }
  assert.equal(looked, 1);
  assert.equal(req.hr.level, 'approver');
});

test('hrGuard re-reads when req.hr does not hold a level it set', async () => {
  let looked = 0;
  const req = { user: { id: 9 }, hr: { level: 'god' } };
  const { res, nextCalls } = await runGuard(hrGuardWith(async () => { looked++; return null; }), req);
  assert.equal(looked, 1);
  assert.equal(nextCalls.length, 0);
  assert.deepEqual(res.body, NO_ACCESS);
});

// ── Mounted the way the HR routers mount it ────────────────────────────

test('r.use("/hr", hrGuard) guards /hr only, once per request across routers', async () => {
  const looked = [];
  const guard = hrGuardWith(async (id) => { looked.push(id); return id === 1 ? 'viewer' : null; });
  const people = express.Router();
  people.use('/hr', guard);
  people.get('/hr/people', requireHr('viewer'), (req, res) => res.json({ router: 'people', level: req.hr.level }));
  people.get('/hr', (req, res) => res.json({ router: 'people', root: true }));
  const payroll = express.Router();
  payroll.use('/hr', guard);
  payroll.get('/hr/runs', requireHr('viewer'), (req, res) => res.json({ router: 'payroll', level: req.hr.level }));
  payroll.post('/hr/runs/:month/finalise', requireHr('approver'), (req, res) => res.json({ finalised: true }));
  const plant = express.Router();
  plant.get('/orders', (req, res) => res.json({ router: 'plant' }));
  plant.get('/hrx', (req, res) => res.json({ router: 'plant', path: 'hrx' }));

  const app = express();
  app.use((req, _res, next) => { req.user = { id: Number(req.get('x-user')), name: 'T', role: 'admin' }; next(); });
  app.use('/api', people);
  app.use('/api', payroll);
  app.use('/api', plant);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, user, method = 'GET') => {
    const r = await fetch(base + path, { method, headers: { 'x-user': String(user) } });
    return { status: r.status, body: await r.json() };
  };
  try {
    // The second router's route: two guards ran, one read.
    looked.length = 0;
    assert.deepEqual(await call('/hr/runs', 1), { status: 200, body: { router: 'payroll', level: 'viewer' } });
    assert.deepEqual(looked, [1]);

    looked.length = 0;
    assert.deepEqual(await call('/hr', 1), { status: 200, body: { router: 'people', root: true } });
    assert.deepEqual(looked, [1], 'the bare /hr path is guarded too');

    looked.length = 0;
    assert.deepEqual(await call('/hr/people', 2), { status: 403, body: NO_ACCESS });
    assert.deepEqual(await call('/hr/runs/2026-08/finalise', 2, 'POST'), { status: 403, body: NO_ACCESS });
    assert.deepEqual(await call('/hr/nothing-here', 2), { status: 403, body: NO_ACCESS },
      'an unknown /hr path is refused before it can 404');
    assert.deepEqual(looked, [2, 2, 2]);

    assert.deepEqual(await call('/hr/runs/2026-08/finalise', 1, 'POST'),
      { status: 403, body: { error: 'Needs HR approver access', code: 'HR_LEVEL' } });

    // Plant routes on the same app never meet the guard.
    looked.length = 0;
    assert.deepEqual(await call('/orders', 2), { status: 200, body: { router: 'plant' } });
    assert.deepEqual(await call('/hrx', 2), { status: 200, body: { router: 'plant', path: 'hrx' } });
    assert.deepEqual(looked, []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ── hrAudit ────────────────────────────────────────────────────────────

const recorder = () => {
  const calls = [];
  const qc = async (text, params) => { calls.push({ text, params }); return [{ id: 1, at: new Date(0) }]; };
  return { calls, qc };
};

test('hrAudit writes one hr.audit_log row through the transaction, signed from req.user', async () => {
  const { calls, qc } = recorder();
  const req = { user: { id: 5, name: 'Op One', role: 'planner' } };
  await hrAudit(qc, req, 'run', 12, 'finalise', { lines: 2, note: 'ok' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /^\s*insert into hr\.audit_log \(user_id, user_name, entity, entity_id, action, detail\)/i);
  assert.doesNotMatch(calls[0].text.replace(/hr\.audit_log/gi, ''), /audit_log|public\./i,
    'never the plant audit_log that /timeline shows to everyone');
  assert.deepEqual(calls[0].params, [5, 'Op One', 'run', '12', 'finalise', '{"lines":2,"note":"ok"}']);
});

test('hrAudit: detail is stored as JSON whatever its shape; nothing becomes "undefined"', async () => {
  const { calls, qc } = recorder();
  await hrAudit(qc, { user: { id: 5, name: 'Op' } }, 'setting', 'rounding', 'update', [1, 'two']);
  await hrAudit(qc, { user: { id: 5, name: 'Op' } }, 'person', 3, 'create');
  await hrAudit(qc, { user: { id: 5, name: 'Op' } }, 'person', null, 'list', 0);
  await hrAudit(qc, {}, 'access', 4, 'grant', { level: 'viewer' });
  assert.equal(calls[0].params[5], '[1,"two"]', 'an array stays a JSON array, not a Postgres array literal');
  assert.equal(calls[0].params[3], 'rounding');
  assert.equal(calls[1].params[5], null);
  assert.equal(calls[2].params[3], null);
  assert.equal(calls[2].params[5], '0');
  assert.deepEqual(calls[3].params.slice(0, 2), [null, null], 'no user: NULL, never the string "undefined"');
  for (const { params } of calls) for (const p of params) assert.notEqual(p, 'undefined');
});

test('hrAudit refuses to be called wrongly', async () => {
  const { calls, qc } = recorder();
  const req = { user: { id: 5, name: 'Op' } };
  await assert.rejects(hrAudit(undefined, req, 'run', 1, 'approve'), TypeError, 'a qc is required');
  await assert.rejects(hrAudit(qc, req, '', 1, 'approve'), TypeError);
  await assert.rejects(hrAudit(qc, req, 'run', 1, ''), TypeError);
  await assert.rejects(hrAudit(qc, req, undefined, 1, 'approve'), TypeError);
  assert.equal(calls.length, 0);
});
