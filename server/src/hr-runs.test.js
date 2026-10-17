// Payroll runs (hr/runs.js) and ledger reads (hr/ledger.js): what can be proven without a database.
//
// linesHash() is pure. The refusals are proven against a stand-in for the transaction's query function,
// so they show the error shape (status, code, and the code in err.body, which is all app.js's error
// handler sends) and that nothing is read or written after a refusal. Recalculation, finalising and the
// ledgers posted once are proven on a real Postgres in hr-runs-pg.test.js (HR_PG=1).
// Every figure is synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { linesHash, ensureRun, recalcRun, finaliseRun } from './hr/runs.js';
import { advanceBalances, loanPositions, inAppAdvancesInMonth } from './hr/ledger.js';

// ── The task brief's test, verbatim ───────────────────────────────────
test('brief: linesHash is stable for equal inputs and changes with absent_days', () => {
  const a = linesHash({ setup:{base:'1'}, inputs:{absent_days:'1'} }), b = linesHash({ inputs:{absent_days:'1'}, setup:{base:'1'} });
  assert.equal(a, b); assert.notEqual(a, linesHash({ setup:{base:'1'}, inputs:{absent_days:'2'} }));
});

// ── linesHash ─────────────────────────────────────────────────────────

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

test('linesHash is the sha256 of canonical JSON: keys sorted at every depth, no spaces', () => {
  const h = linesHash({ b: { y: 1, x: [2, { q: 'a', p: null }] }, a: true });
  assert.equal(h, sha256('{"a":true,"b":{"x":[2,{"p":null,"q":"a"}],"y":1}}'));
  assert.equal(h, linesHash({ a: true, b: { x: [2, { p: null, q: 'a' }], y: 1 } }));
  assert.match(h, /^[0-9a-f]{64}$/);
});

test('linesHash: order inside an array counts (loans run oldest first), and so do types', () => {
  assert.notEqual(linesHash({ loans: [1, 2] }), linesHash({ loans: [2, 1] }));
  assert.notEqual(linesHash({ base: '1' }), linesHash({ base: 1 }));
  assert.notEqual(linesHash({ v: null }), linesHash({ v: '' }));
  assert.notEqual(linesHash({ v: null }), linesHash({}), 'a null figure is not a missing one');
  assert.equal(linesHash({ v: undefined, w: 1 }), linesHash({ w: 1 }), 'undefined drops out, as in JSON');
});

test('linesHash refuses what has no single JSON spelling instead of hashing it as {}', () => {
  for (const bad of [{ d: new Date(0) }, { n: 1n }, { n: NaN }, { n: Infinity }, { m: new Map() },
    { f: () => 1 }, { s: Symbol('x') }, [undefined]]) {
    assert.throws(() => linesHash(bad), TypeError, JSON.stringify(Object.keys(bad)));
  }
  assert.throws(() => linesHash(undefined), TypeError);
});

// ── Refusals, against a stand-in qc ───────────────────────────────────

// Answers each statement with the rows of the first pattern that matches it, records every call, and
// fails the test on a statement it was not told about (so "nothing else ran" is checked for free).
function fakeQc(answers) {
  const calls = [];
  const qc = async (sql, params = []) => {
    calls.push({ sql, params });
    for (const [pattern, rows] of answers) if (pattern.test(sql)) return rows;
    throw new Error(`unexpected SQL: ${sql}`);
  };
  qc.calls = calls;
  return qc;
}
const run = (status, month = '2026-08') => ({ id: 3, month, status, days_in_month: 31, policy: {}, totals: {} });
const refused = (status, code, message) => (e) => {
  assert.equal(e.status, status);
  assert.equal(e.code, code);
  assert.deepEqual(e.body?.code, code, 'the code rides in err.body, the only part app.js sends');
  if (message) assert.equal(e.message, message);
  return true;
};

test('recalcRun refuses a run that is not a draft (409 RUN_LOCKED) after locking it, and reads nothing more', async () => {
  for (const status of ['submitted', 'approved', 'finalised']) {
    const qc = fakeQc([[/FOR UPDATE/, [run(status)]]]);
    await assert.rejects(recalcRun(qc, { id: 3 }), refused(409, 'RUN_LOCKED', 'Run is not a draft'));
    assert.equal(qc.calls.length, 1);
    assert.match(qc.calls[0].sql, /FROM hr\.runs[\s\S]*FOR UPDATE/);
    assert.deepEqual(qc.calls[0].params, [3]);
  }
});

test('finaliseRun refuses anything but an approved run (409 RUN_STATE), and posts nothing', async () => {
  for (const status of ['draft', 'submitted', 'finalised']) {
    const qc = fakeQc([[/FOR UPDATE/, [run(status)]]]);
    await assert.rejects(finaliseRun(qc, { id: 3 }, { user: { id: 1 } }), refused(409, 'RUN_STATE'));
    assert.equal(qc.calls.length, 1);
  }
});

test('finaliseRun refuses while an earlier month is not finalised (409 PREVIOUS_MONTH_OPEN)', async () => {
  const qc = fakeQc([
    [/FOR UPDATE/, [run('approved', '2026-09')]],
    [/month > \$1/, []],                                   // no later month finalised
    [/month < \$1/, [{ month: '2026-08', status: 'draft' }]],
  ]);
  await assert.rejects(finaliseRun(qc, { id: 3 }, { user: { id: 1 } }),
    (e) => refused(409, 'PREVIOUS_MONTH_OPEN')(e) && e.body.month === '2026-08');
  assert.equal(qc.calls.length, 3);
  assert.deepEqual(qc.calls[2].params, ['2026-09']);
  assert.match(qc.calls[2].sql, /max\(f\.month\)/, 'only runs after the latest finalised month count as open');
});

test('T7-c: finaliseRun refuses a month before the latest finalised one (409 MONTH_BEFORE_FINALISED), first', async () => {
  const qc = fakeQc([
    [/FOR UPDATE/, [run('approved', '2026-08')]],
    [/month > \$1/, [{ month: '2026-09' }]],
    [/month < \$1/, [{ month: '2026-07', status: 'draft' }]],
  ]);
  await assert.rejects(finaliseRun(qc, { id: 3 }, { user: { id: 1 } }),
    (e) => refused(409, 'MONTH_BEFORE_FINALISED')(e) && e.body.month === '2026-09');
  assert.equal(qc.calls.length, 2, 'refused before the earlier months are even looked at');
  assert.match(qc.calls[1].sql, /status = 'finalised' AND month > \$1/);
  assert.deepEqual(qc.calls[1].params, ['2026-08']);
});

test('T7-c: ensureRun will not start a month before the latest finalised one (409 MONTH_BEFORE_FINALISED), inserting nothing', async () => {
  const qc = fakeQc([
    [/FROM hr\.runs WHERE month = \$1/, []],
    [/month > \$1/, [{ month: '2026-09' }]],
  ]);
  await assert.rejects(ensureRun(qc, '2026-08', 1),
    (e) => refused(409, 'MONTH_BEFORE_FINALISED')(e) && e.body.month === '2026-09');
  assert.equal(qc.calls.length, 2);
  assert.equal(qc.calls.some((c) => /INSERT/i.test(c.sql)), false);
});

test('a run that is not there is 404 RUN_NOT_FOUND; a run that is not a run id throws', async () => {
  await assert.rejects(recalcRun(fakeQc([[/FOR UPDATE/, []]]), { id: 9 }), refused(404, 'RUN_NOT_FOUND'));
  await assert.rejects(finaliseRun(fakeQc([[/FOR UPDATE/, []]]), 9, {}), refused(404, 'RUN_NOT_FOUND'));
  for (const bad of [null, {}, { id: 0 }, { id: -1 }, { id: 1.5 }, { id: '1e1' }, { id: 2 ** 31 }]) {
    await assert.rejects(recalcRun(fakeQc([]), bad), TypeError);
  }
});

test('recalcRun checks its person ids before it touches the run', async () => {
  for (const personIds of ['1', [0], ['x'], [1.5]]) {
    const qc = fakeQc([]);
    await assert.rejects(recalcRun(qc, { id: 3 }, { personIds }), TypeError);
    assert.equal(qc.calls.length, 0);
  }
});

test('ensureRun refuses a month that is not YYYY-MM (400 BAD_MONTH) without a query', async () => {
  for (const month of ['2026-8', '2026-13', '2026-08-01', '', null, 202608]) {
    const qc = fakeQc([]);
    await assert.rejects(ensureRun(qc, month, 1), refused(400, 'BAD_MONTH'));
    assert.equal(qc.calls.length, 0);
  }
});

test('ensureRun returns the month\'s run when there is one, and creates nothing', async () => {
  const existing = run('approved');
  const qc = fakeQc([[/FROM hr\.runs WHERE month = \$1/, [existing]]]);
  assert.equal(await ensureRun(qc, '2026-08', 1), existing);
  assert.equal(qc.calls.length, 1);
});

// ── Ledger reads ──────────────────────────────────────────────────────

test('ledger reads: no people, no query; every id comes back, defaulting to nothing owed', async () => {
  const none = fakeQc([]);
  assert.deepEqual(await advanceBalances(none, []), new Map());
  assert.deepEqual(await loanPositions(none, [], '2026-08'), new Map());
  assert.deepEqual(await inAppAdvancesInMonth(none, [], '2026-08'), new Map());
  assert.equal(none.calls.length, 0);

  const empty = fakeQc([[/hr\.advance_txns/, []], [/hr\.loans/, []]]);
  assert.deepEqual(await advanceBalances(empty, [7, '5', 7]), new Map([[5, '0.00'], [7, '0.00']]));
  assert.deepEqual(await inAppAdvancesInMonth(empty, [7], '2026-08'), new Map([[7, '0.00']]));
  assert.deepEqual(await loanPositions(empty, [7], '2026-08'), new Map([[7, []]]));
});

test('ledger reads: an advance balance is opening + given + adjustment − recovered − waived, exactly', async () => {
  const qc = fakeQc([[/hr\.advance_txns/, [
    { person_id: 4, kind: 'opening', amount: '2000.00' }, { person_id: 4, kind: 'given', amount: '1500.10' },
    { person_id: 4, kind: 'adjustment', amount: '0.20' }, { person_id: 4, kind: 'recovered', amount: '3000.00' },
    { person_id: 4, kind: 'waived', amount: '0.10' }, { person_id: 6, kind: 'recovered', amount: '250.00' },
  ]]]);
  assert.deepEqual(await advanceBalances(qc, [4, 6]), new Map([[4, '500.20'], [6, '-250.00']]));
  assert.deepEqual(qc.calls[0].params, [[4, 6], null], 'no month given: no date filter (the balance now)');
});

test('ledger reads: as at month end, manual increases dated after the month are left out and reductions kept', async () => {
  const adv = fakeQc([[/hr\.advance_txns/, []]]);
  await advanceBalances(adv, [4], '2026-12');
  assert.deepEqual(adv.calls[0].params, [[4], '2027-01-01'], 'the first day after the month, the year rolling over');
  assert.match(adv.calls[0].sql, /run_id IS NULL\s+AND kind IN \('opening', 'given', 'adjustment'\) AND txn_date >= \$2::date/);
  const loans = fakeQc([[/FROM hr\.loans/, [
    { id: 11, loan_no: 'CI-LN-0011', person_id: 4, instalment: '1000.00', first_due_month: '2026-07', status: 'active' },
  ]], [/FROM hr\.loan_txns/, []], [/FROM hr\.loan_holidays/, []]]);
  await loanPositions(loans, [4], '2026-07', '2026-07');
  assert.deepEqual(loans.calls[0].params, [[4], '2026-08-01']);
  assert.match(loans.calls[0].sql, /issued_on < \$2::date/, 'a loan issued after the month is not in it');
  assert.deepEqual(loans.calls[1].params, [[11], '2026-08-01']);
  assert.match(loans.calls[1].sql, /t\.run_id IS NULL[\s\S]*'disbursed', 'opening'[\s\S]*principal_amount > 0/);
  assert.doesNotMatch(loans.calls[1].sql, /payroll_recovery|prepayment|waiver/, 'no reduction is ever filtered out');
  const now = fakeQc([[/FROM hr\.loans/, []]]);
  await loanPositions(now, [4], '2026-07');
  assert.deepEqual(now.calls[0].params, [[4], null], 'no as-at month: every loan');
});

test('ledger reads: an advance kind nobody knows throws instead of counting as nothing', async () => {
  for (const kind of ['refund', 'toString', '__proto__']) {
    const qc = fakeQc([[/hr\.advance_txns/, [{ person_id: 4, kind, amount: '1.00' }]]]);
    await assert.rejects(advanceBalances(qc, [4]), RangeError);
  }
});

test('ledger reads: in-app advances of a month are manual given rows dated inside it', async () => {
  const qc = fakeQc([[/hr\.advance_txns/, [{ person_id: 4, amount: '1500.00' }]]]);
  assert.deepEqual(await inAppAdvancesInMonth(qc, [4], '2026-12'), new Map([[4, '1500.00']]));
  const { sql, params } = qc.calls[0];
  assert.match(sql, /kind = 'given'/);
  assert.match(sql, /source = 'manual'/);
  assert.deepEqual(params, [[4], '2026-12-01', '2027-01-01'], 'a half-open month, the year rolling over');
});

test('ledger reads: loan positions are active loans oldest first, with dueForMonth over their txns and holidays', async () => {
  const qc = fakeQc([
    [/FROM hr\.loans/, [
      { id: 11, loan_no: 'CI-LN-0011', person_id: 4, instalment: '3000.00', first_due_month: '2026-08', status: 'active' },
      { id: 12, loan_no: 'CI-LN-0012', person_id: 4, instalment: '1000.00', first_due_month: '2026-08', status: 'active' },
    ]],
    [/FROM hr\.loan_txns/, [
      { loan_id: 11, kind: 'opening', principal_amount: '12000.00', run_month: null },
      { loan_id: 11, kind: 'payroll_recovery', principal_amount: '9500.00', run_month: '2026-07' },
      { loan_id: 12, kind: 'disbursed', principal_amount: '5000.00', run_month: null },
    ]],
    [/FROM hr\.loan_holidays/, [{ loan_id: 12, month: '2026-08' }]],
  ]);
  assert.deepEqual(await loanPositions(qc, [4, 5], '2026-08'), new Map([
    [4, [{ loan_id: 11, loan_no: 'CI-LN-0011', due: '2500.00', outstanding: '2500.00' },
      { loan_id: 12, loan_no: 'CI-LN-0012', due: '0.00', outstanding: '5000.00' }]],
    [5, []],
  ]));
  assert.match(qc.calls[0].sql, /status = 'active'/);
  assert.match(qc.calls[0].sql, /ORDER BY[\s\S]*issued_on, id/);
  assert.match(qc.calls[1].sql, /JOIN hr\.runs/, 'a payroll recovery carries its run\'s month');
});

test('ledger reads: ids and months are checked before any query', async () => {
  const qc = fakeQc([]);
  for (const ids of [[0], [-3], ['x'], [1.5], [2 ** 31], 'nope', null]) {
    await assert.rejects(advanceBalances(qc, ids), TypeError);
  }
  for (const month of ['2026-8', '2026-08-01', null]) {
    await assert.rejects(loanPositions(qc, [1], month), TypeError);
    await assert.rejects(inAppAdvancesInMonth(qc, [1], month), TypeError);
  }
  assert.equal(qc.calls.length, 0);
});
