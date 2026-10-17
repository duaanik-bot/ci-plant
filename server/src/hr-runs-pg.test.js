// Payroll runs on a real Postgres (hr/runs.js, hr/ledger.js): recalculation, finalising, and the advance
// and loan ledgers posted exactly once.
//
// Boots its OWN throwaway Postgres in a temp dir on a free port, with PG_POOL_MAX=1 (the Vercel geometry:
// a pool call inside a transaction would hang, and each test has a timeout so a hang fails), and runs
// init(), which replays the hr migration. Every runs.js call goes through db.tx(), as the routes will.
// The tests share one story and run in order: August is recalculated, refused for every reason, then
// finalised; September then carries August's balances. Every name and figure is synthetic.
//
//   HR_PG=1 node --test src/hr-runs-pg.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const ENABLED = process.env.HR_PG === '1';
const T = { timeout: 30_000 };

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.unref();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

// Every amount on a line, read as exact text.
const MONEY = ['daily_rate', 'basic', 'ot_amount', 'holiday_amount', 'misc_earning', 'bonus', 'adj_earnings', 'gross',
  'misc_deduction', 'adj_deductions', 'loan_recovery', 'advance_recovery', 'total_deductions', 'paid_separately',
  'net_before_cap', 'net', 'payable', 'rounding', 'advance_given', 'carried_advance'];

describe('payroll runs on a real Postgres', {
  skip: ENABLED ? false : 'set HR_PG=1 to boot a throwaway Postgres',
}, () => {
  let epg, dir, db, pool, runs, ledger, engine;
  let A, B, C, setupA, loanA, august, stale;
  const req = { user: { id: 1, name: 'Test Approver' } };

  before(async () => {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-runs-'));
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
    runs = await import('./hr/runs.js');
    ledger = await import('./hr/ledger.js');
    engine = await import('./hr/engine.js');

    // A: monthly, a formula holiday with no divisor of its own, an opening loan. B: daily, an opening
    // advance and one given in the app in August. C: a joining date the engine cannot read.
    await db.q(`INSERT INTO hr.pay_channels (code, label, kind) VALUES ('TBANK', 'Test bank', 'bank'), ('TCASH', 'Test cash', 'cash')`);
    A = (await db.one(`INSERT INTO hr.people (code, name, pay_channel, bank_account, bank_ifsc, joined_on)
                       VALUES ('T-101', 'Test Worker Alpha', 'TBANK', 'TEST-ACCOUNT-1', 'TEST0000001', '2025-04-01') RETURNING id`)).id;
    B = (await db.one(`INSERT INTO hr.people (code, name, pay_channel) VALUES ('T-102', 'Test Worker Beta', 'TCASH') RETURNING id`)).id;
    C = (await db.one(`INSERT INTO hr.people (code, name, pay_channel, joined_on)
                       VALUES ('T-103', 'Test Worker Gamma', 'TCASH', '10000-01-01') RETURNING id`)).id;
    setupA = (await db.one(`INSERT INTO hr.pay_setups (person_id, effective_from, pay_basis, base, ot_hours_per_day, ot_multiplier, holiday_mode)
                            VALUES ($1, '2026-04-01', 'monthly', 30000, 8, 1, 'formula') RETURNING id`, [A])).id;
    await db.q(`INSERT INTO hr.pay_setups (person_id, effective_from, pay_basis, base) VALUES ($1, '2026-04-01', 'daily', 800)`, [B]);
    await db.q(`INSERT INTO hr.pay_setups (person_id, effective_from, pay_basis, base) VALUES ($1, '2026-04-01', 'monthly', 20000)`, [C]);
    loanA = (await db.one(`INSERT INTO hr.loans (loan_no, person_id, principal, issued_on, instalment, first_due_month, is_opening)
                           VALUES ('CI-LN-0001', $1, 12000, '2026-07-31', 3000, '2026-08', true) RETURNING id`, [A])).id;
    await db.q(`INSERT INTO hr.loan_txns (loan_id, txn_date, kind, principal_amount) VALUES ($1, '2026-07-31', 'opening', 12000)`, [loanA]);
    await db.q(`INSERT INTO hr.advance_txns (person_id, txn_date, kind, amount, source)
                VALUES ($1, '2026-07-31', 'opening', 2100, 'loader'), ($1, '2026-08-05', 'given', 1500, 'manual')`, [B]);

    august = await db.tx((qc) => runs.ensureRun(qc, '2026-08', 1));
    await db.q(`INSERT INTO hr.run_inputs (run_id, person_id, ot_hours, absent_days, source) VALUES ($1, $2, 10, 2, 'manual')`, [august.id, A]);
    await db.q(`INSERT INTO hr.run_inputs (run_id, person_id, absent_days, advance_given, source) VALUES ($1, $2, 1, 2500, 'manual')`, [august.id, B]);
    await db.q(`INSERT INTO hr.run_inputs (run_id, person_id, absent_days, source) VALUES ($1, $2, 0, 'manual')`, [august.id, C]);
  });

  after(async () => {
    try { await pool?.end(); } catch {}
    try { await epg?.stop(); } catch {}
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── Helpers ──
  const recalc = (run, opts) => db.tx((qc) => runs.recalcRun(qc, run, opts));
  const finalise = (run) => db.tx((qc) => runs.finaliseRun(qc, run, req));
  const status = (run, s) => db.q('UPDATE hr.runs SET status = $2 WHERE id = $1', [run.id, s]);
  const lineOf = (run, personId) => db.one(
    `SELECT person_id, pay_setup_id, inputs_hash, flags, breakdown, loan_recoveries, pay_channel, computed_at,
            ${MONEY.map((c) => `${c}::text AS ${c}`).join(', ')}
       FROM hr.run_lines WHERE run_id = $1 AND person_id = $2`, [run.id, personId]);
  const hashes = async (run) => (await db.q(
    'SELECT person_id, inputs_hash FROM hr.run_lines WHERE run_id = $1 ORDER BY person_id', [run.id]));
  const ledgers = async () => ({
    advance: (await db.q('SELECT id, person_id, kind, amount::text AS amount, run_id FROM hr.advance_txns ORDER BY id')),
    loan: (await db.q('SELECT id, loan_id, kind, principal_amount::text AS amount, run_id FROM hr.loan_txns ORDER BY id')),
  });
  const posted = async (run) => ({
    advance: await db.q(`SELECT person_id, kind, amount::text AS amount, source, txn_date::text AS txn_date, created_by
                           FROM hr.advance_txns WHERE run_id = $1 ORDER BY id`, [run.id]),
    loan: await db.q(`SELECT loan_id, kind, principal_amount::text AS amount, txn_date::text AS txn_date, created_by
                        FROM hr.loan_txns WHERE run_id = $1 ORDER BY id`, [run.id]),
  });
  const runRow = (run) => db.one('SELECT * FROM hr.runs WHERE id = $1', [run.id]);
  const refused = (status, code) => (e) => {
    assert.equal(e.status, status, e.message);
    assert.equal(e.code, code);
    assert.equal(e.body?.code, code);
    return true;
  };
  const plantToday = async () => (await db.one(`SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`)).d;

  // The same inputs the run holds, handed to the engine directly.
  const engineA = (loan = { due: '3000', outstanding: '12000' }) => engine.computeLine({
    month: '2026-08', daysInMonth: 31,
    person: { status: 'active', joined_on: '2025-04-01', exited_on: null, pay_channel_kind: 'bank', has_bank_details: true },
    setup: { pay_basis: 'monthly', base: '30000', absence_basis: 'calendar_days', ot_hours_per_day: '8', ot_multiplier: '1',
      holiday_mode: 'formula', holiday_divisor: '30.5' },
    inputs: { ot_hours: '10', absent_days: '2' },
    balances: { advance: '0', loans: [{ loan_id: loanA, loan_no: 'CI-LN-0001', ...loan }] },
    policy: { rounding: 'rupee' },
  });
  const engineB = () => engine.computeLine({
    month: '2026-08', daysInMonth: 31,
    person: { status: 'active', joined_on: null, exited_on: null, pay_channel_kind: 'cash', has_bank_details: false },
    setup: { pay_basis: 'daily', base: '800', absence_basis: 'calendar_days', ot_hours_per_day: '0', ot_multiplier: '1', holiday_mode: 'none' },
    inputs: { absent_days: '1', advance_given: '1000' },
    balances: { advance: '3600', loans: [] },
    policy: { rounding: 'rupee' },
  });

  // ── ensureRun ──

  test('ensureRun makes one draft per month, with the month\'s length and the policy from settings', T, async () => {
    assert.equal(august.status, 'draft');
    assert.equal(august.days_in_month, 31);
    assert.equal(august.engine_version, engine.ENGINE_VERSION);
    assert.equal(august.prepared_by, 1);
    assert.deepEqual(august.policy, {
      rounding: 'rupee', ot_high_hours: 150, deduction_warn_pct: 50, variance_warn_pct: 25, holiday_divisor_default: 30.5,
    });
    const again = await db.tx((qc) => runs.ensureRun(qc, '2026-08', 2));
    assert.equal(again.id, august.id);
    assert.equal(again.prepared_by, 1, 'an existing run is returned as it is');
    assert.equal((await db.one(`SELECT count(*)::int AS n FROM hr.runs WHERE month = '2026-08'`)).n, 1);
  });

  // ── recalcRun ──

  test('recalc stores a line per included person: computeLine on the same inputs, and the hand-worked figures', T, async () => {
    const before = await ledgers();
    const { lines, totals, run } = await recalc(august);
    assert.deepEqual(lines.map((l) => l.person_id), [A, B, C].sort((x, y) => x - y));

    // A by hand: ₹30,000 a month, 31 days, 2 absent → 30000 × 29 ÷ 31 = 28064.516… → 28064.52. OT: 10 h ÷ 8 h a day
    // × 30000 ÷ 31 = 1209.677… → 1209.68. Holiday: no divisor on the setup, so the default 30.5: 30000 ÷ 30.5
    // = 983.606… → 983.61. Gross 30257.81; the loan's 3000 instalment leaves 27257.81, paid as 27258.
    const a = await lineOf(august, A);
    assert.deepEqual([a.basic, a.ot_amount, a.holiday_amount, a.gross, a.loan_recovery, a.payable, a.rounding],
      ['28064.52', '1209.68', '983.61', '30257.81', '3000.00', '27258.00', '0.19']);
    const ea = engineA();
    for (const k of MONEY) assert.equal(a[k], ea[k], `A ${k}`);
    assert.deepEqual(a.breakdown, ea.components);
    assert.deepEqual(a.flags, ea.flags);
    assert.deepEqual(a.loan_recoveries, [{ loan_id: loanA, amount: '3000.00' }]);
    assert.match(a.inputs_hash, /^[0-9a-f]{64}$/);
    assert.equal(a.pay_setup_id, setupA);
    assert.equal(a.pay_channel, 'TBANK');

    // B by hand: ₹800 a day × 30 days present = 24000. Advance owed: the balance 3600 (opening 2100 + 1500
    // given in the app) + the sheet's 2500 less the 1500 the app already recorded = 4600, all recovered.
    const b = await lineOf(august, B);
    assert.deepEqual([b.gross, b.advance_given, b.advance_recovery, b.payable, b.carried_advance],
      ['24000.00', '1000.00', '4600.00', '19400.00', '0.00']);
    const eb = engineB();
    for (const k of MONEY) assert.equal(b[k], eb[k], `B ${k}`);
    assert.deepEqual(b.breakdown, eb.components);

    // C: the engine refuses a joining date it cannot read; only C's line stops, blocked, with zero amounts.
    const c = await lineOf(august, C);
    assert.equal(c.flags.length, 1);
    assert.deepEqual([c.flags[0].level, c.flags[0].code], ['block', 'ENGINE_ERROR']);
    assert.match(c.flags[0].message, /not a date/);
    for (const k of MONEY) assert.equal(c[k], '0.00', `C ${k}`);
    assert.deepEqual(c.breakdown, []);

    const expected = {
      lines: 3, blocked: 1,
      gross: '54257.81', total_deductions: '7600.00', net: '46657.81', paid_separately: '0.00', payable: '46658.00',
      rounding: '0.19', advance_given: '1000.00', advance_recovery: '4600.00', loan_recovery: '3000.00', carried_advance: '0.00',
      by_channel: [
        { pay_channel: 'TBANK', lines: 1, payable: '27258.00', carried_advance: '0.00' },
        { pay_channel: 'TCASH', lines: 2, payable: '19400.00', carried_advance: '0.00' },
      ],
    };
    assert.deepEqual(totals, expected);
    assert.deepEqual(run.totals, expected);
    assert.deepEqual((await runRow(august)).totals, expected);
    assert.deepEqual(await ledgers(), before, 'a recalculation posts nothing');
  });

  test('two more recalculations leave both ledgers and every hash exactly as they were', T, async () => {
    const before = { ledgers: await ledgers(), hashes: await hashes(august) };
    await recalc(august);
    await recalc(august);
    assert.deepEqual({ ledgers: await ledgers(), hashes: await hashes(august) }, before);
    const balances = await db.tx((qc) => ledger.advanceBalances(qc, [A, B]));
    assert.deepEqual(balances, new Map([[A, '0.00'], [B, '3600.00']]));
  });

  test('the sheet\'s advance: total mode adds what the app has not recorded, extra adds it all, below recorded warns', T, async () => {
    const setB = (advance, mode) => db.q('UPDATE hr.run_inputs SET advance_given = $3, advance_mode = $4 WHERE run_id = $1 AND person_id = $2',
      [august.id, B, advance, mode]);

    await setB(1000, 'total');                          // the sheet says 1000; the app recorded 1500
    await recalc(august);
    let b = await lineOf(august, B);
    assert.deepEqual([b.advance_given, b.advance_recovery, b.payable], ['0.00', '3600.00', '20400.00']);
    const warn = b.flags.find((f) => f.code === 'ADVANCE_BELOW_RECORDED');
    assert.equal(warn?.level, 'warn');
    assert.match(warn.message, /₹1,000\.00 is less than the ₹1,500\.00 already given in the app/);

    await setB(2500, 'extra');                          // all of the sheet's 2500 is new
    await recalc(august);
    b = await lineOf(august, B);
    assert.deepEqual([b.advance_given, b.advance_recovery, b.payable], ['2500.00', '6100.00', '17900.00']);
    assert.equal(b.flags.some((f) => f.code === 'ADVANCE_BELOW_RECORDED'), false);

    await setB(2500, 'total');
    await recalc(august);
    b = await lineOf(august, B);
    assert.deepEqual([b.advance_given, b.advance_recovery, b.payable], ['1000.00', '4600.00', '19400.00']);
  });

  test('a person left out loses their line; a scoped recalculation touches only the people named', T, async () => {
    await db.q('UPDATE hr.run_inputs SET include = false WHERE run_id = $1 AND person_id = $2', [august.id, C]);
    let { lines, totals } = await recalc(august);
    assert.deepEqual(lines.map((l) => l.person_id).sort(), [A, B].sort());
    assert.equal(await lineOf(august, C), null);
    assert.deepEqual([totals.lines, totals.blocked, totals.payable], [2, 0, '46658.00']);

    const aBefore = await lineOf(august, A);
    await db.q('UPDATE hr.run_inputs SET absent_days = 2 WHERE run_id = $1 AND person_id = $2', [august.id, B]);
    ({ lines, totals } = await recalc(august, { personIds: [B] }));
    assert.deepEqual(lines.map((l) => l.person_id), [B]);
    assert.equal((await lineOf(august, B)).payable, '18600.00', '800 × 29 − 4600');
    assert.deepEqual((await lineOf(august, A)).computed_at, aBefore.computed_at, 'A was not recomputed');
    assert.deepEqual([totals.lines, totals.gross], [2, '53457.81'], 'the totals still cover every line');

    // A settings change since the last recalculation widens a scoped one to every line.
    await db.q(`UPDATE hr.settings SET value = '30' WHERE key = 'variance_warn_pct'`);
    await recalc(august, { personIds: [B] });
    assert.notDeepEqual((await lineOf(august, A)).computed_at, aBefore.computed_at, 'A was recomputed under the new policy');
    assert.equal((await runRow(august)).policy.variance_warn_pct, 30);
    await db.q(`UPDATE hr.settings SET value = '25' WHERE key = 'variance_warn_pct'`);
    await db.q('UPDATE hr.run_inputs SET absent_days = 1 WHERE run_id = $1 AND person_id = $2', [august.id, B]);
    await recalc(august);
    assert.equal((await lineOf(august, B)).payable, '19400.00');
    assert.equal((await runRow(august)).policy.variance_warn_pct, 25);
  });

  test('recalc refuses a run that is no longer a draft (409 RUN_LOCKED) and changes nothing', T, async () => {
    const before = await hashes(august);
    for (const s of ['submitted', 'approved']) {
      await status(august, s);
      await assert.rejects(recalc(august), refused(409, 'RUN_LOCKED'));
    }
    assert.deepEqual(await hashes(august), before);
    await status(august, 'draft');
  });

  // ── finaliseRun: every refusal posts nothing ──

  test('finalise refuses a run that is not approved (409 RUN_STATE)', T, async () => {
    const before = await ledgers();
    for (const s of ['draft', 'submitted']) {
      await status(august, s);
      await assert.rejects(finalise(august), refused(409, 'RUN_STATE'));
    }
    assert.deepEqual(await ledgers(), before);
    assert.equal((await runRow(august)).status, 'submitted');
  });

  test('finalise refuses while an earlier month is still a draft (409 PREVIOUS_MONTH_OPEN)', T, async () => {
    const july = await db.tx((qc) => runs.ensureRun(qc, '2026-07', 1));
    await status(august, 'approved');
    const before = await ledgers();
    await assert.rejects(finalise(august), (e) => refused(409, 'PREVIOUS_MONTH_OPEN')(e) && e.body.month === '2026-07');
    assert.deepEqual(await ledgers(), before);
    assert.equal((await runRow(august)).status, 'approved');
    await db.q('DELETE FROM hr.runs WHERE id = $1', [july.id]);   // an empty draft, made for this test only
  });

  test('finalise refuses when a balance moved after approval (409 RUN_CHANGED_SINCE_APPROVAL)', T, async () => {
    const extra = (await db.one(`INSERT INTO hr.advance_txns (person_id, txn_date, kind, amount, source)
                                 VALUES ($1, '2026-08-20', 'given', 100, 'manual') RETURNING id`, [B])).id;
    const before = await ledgers();
    await assert.rejects(finalise(august),
      (e) => refused(409, 'RUN_CHANGED_SINCE_APPROVAL')(e) && JSON.stringify(e.body.person_ids) === JSON.stringify([B]));
    assert.deepEqual(await ledgers(), before);
    assert.equal((await runRow(august)).status, 'approved');
    await db.q('DELETE FROM hr.advance_txns WHERE id = $1', [extra]);
  });

  test('finalise refuses while a line is blocked (409 RUN_BLOCKED)', T, async () => {
    await status(august, 'draft');
    await db.q('UPDATE hr.run_inputs SET include = true WHERE run_id = $1 AND person_id = $2', [august.id, C]);
    await recalc(august);
    await status(august, 'approved');
    const before = await ledgers();
    await assert.rejects(finalise(august),
      (e) => refused(409, 'RUN_BLOCKED')(e) && JSON.stringify(e.body.person_ids) === JSON.stringify([C]));
    assert.deepEqual(await ledgers(), before);

    await status(august, 'draft');
    await db.q('UPDATE hr.run_inputs SET include = false WHERE run_id = $1 AND person_id = $2', [august.id, C]);
    await recalc(august);
  });

  test('finalise waits for a waive already under way, then sees it and refuses: never recovers a waived balance', T, async () => {
    // Another session waives B's whole 3600 balance and has not committed. Its insert holds a KEY SHARE lock
    // on B's people row; finalise's FOR UPDATE on that row must wait for it, and then recompute with the
    // waive in. Without the lock, finalise would recover the approved 4600 and the balance would end −3600.
    await status(august, 'approved');
    const { default: pg } = await import('pg');
    const other = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await other.connect();
    let waive;
    try {
      await other.query('BEGIN');
      waive = (await other.query(`INSERT INTO hr.advance_txns (person_id, txn_date, kind, amount, source)
                                  VALUES ($1, '2026-08-25', 'waived', 3600, 'manual') RETURNING id`, [B])).rows[0].id;
      const settled = finalise(august).then(() => 'finalised', (e) => e);
      const waiting = async () => (await other.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND pid <> pg_backend_pid()`)).rows[0].n;
      for (let i = 0; i < 200 && (await waiting()) === 0; i++) await new Promise((r) => setTimeout(r, 25));
      assert.equal(await waiting(), 1, 'finalise is waiting on the lock');
      await other.query('COMMIT');
      const outcome = await settled;
      assert.ok(outcome instanceof Error, `finalise should have refused, got ${outcome}`);
      refused(409, 'RUN_CHANGED_SINCE_APPROVAL')(outcome);
      assert.deepEqual(outcome.body.person_ids, [B]);
    } finally {
      try { await other.query('ROLLBACK'); } catch {}
      await other.end();
    }
    assert.deepEqual(await posted(august), { advance: [], loan: [] });
    await db.q('DELETE FROM hr.advance_txns WHERE id = $1', [waive]);
    await status(august, 'draft');
  });

  test('a failure part-way through finalising rolls everything back: no advance row, still approved', T, async () => {
    // A payroll_recovery already sitting on A's loan for this run. Recalculated with it, so the approved line
    // matches; finalise then posts B's advance rows and fails on the loan's once-per-run key.
    const planted = (await db.one(`INSERT INTO hr.loan_txns (loan_id, txn_date, kind, principal_amount, run_id)
                                   VALUES ($1, '2026-08-31', 'payroll_recovery', 1, $2) RETURNING id`, [loanA, august.id])).id;
    await recalc(august);
    assert.equal((await lineOf(august, A)).loan_recovery, '3000.00', 'min(3000, 11999)');
    await status(august, 'approved');
    const before = await ledgers();
    await assert.rejects(finalise(august), refused(409, 'ALREADY_POSTED'));
    assert.deepEqual(await ledgers(), before);
    assert.deepEqual((await posted(august)).advance, []);
    const run = await runRow(august);
    assert.deepEqual([run.status, run.finalised_by, run.finalised_at], ['approved', null, null]);
    assert.equal((await db.one(`SELECT count(*)::int AS n FROM hr.audit_log WHERE entity = 'run' AND action = 'finalise'`)).n, 0);

    await db.q('DELETE FROM hr.loan_txns WHERE id = $1', [planted]);
    await status(august, 'draft');
    await recalc(august);
    await status(august, 'approved');
  });

  // ── finaliseRun: posting ──

  test('finalise posts each movement exactly once, stamps the run and writes the audit row', T, async () => {
    const linesBefore = await db.q('SELECT * FROM hr.run_lines WHERE run_id = $1 ORDER BY person_id', [august.id]);
    const done = await finalise(august);
    assert.equal(done.status, 'finalised');
    assert.equal(done.finalised_by, 1);
    assert.ok(done.finalised_at instanceof Date);

    // Postings: the month's new advance on the month's last day; recoveries on the day of finalising.
    const today = await plantToday();
    const { advance, loan } = await posted(august);
    assert.deepEqual(advance, [
      { person_id: B, kind: 'given', amount: '1000.00', source: 'payroll', txn_date: today < '2026-08-31' ? today : '2026-08-31', created_by: 1 },
      { person_id: B, kind: 'recovered', amount: '4600.00', source: 'payroll', txn_date: today, created_by: 1 },
    ]);
    assert.deepEqual(loan, [{ loan_id: loanA, kind: 'payroll_recovery', amount: '3000.00', txn_date: today, created_by: 1 }]);

    // The balances are the ledgers' sums: B owes nothing; A's loan stands at 9000.
    const after = await db.tx(async (qc) => ({
      advance: await ledger.advanceBalances(qc, [A, B]),
      loans: await ledger.loanPositions(qc, [A], '2026-09'),
    }));
    assert.deepEqual(after.advance, new Map([[A, '0.00'], [B, '0.00']]));
    assert.deepEqual(after.loans.get(A), [{ loan_id: loanA, loan_no: 'CI-LN-0001', due: '3000.00', outstanding: '9000.00' }]);

    assert.deepEqual(await db.q('SELECT * FROM hr.run_lines WHERE run_id = $1 ORDER BY person_id', [august.id]), linesBefore,
      'the approved lines are left exactly as they were');
    const audit = await db.q(`SELECT user_id, user_name, entity_id, detail FROM hr.audit_log WHERE entity = 'run' AND action = 'finalise'`);
    assert.deepEqual(audit, [{
      user_id: 1, user_name: 'Test Approver', entity_id: String(august.id),
      detail: { month: '2026-08', lines: 2, advance_given: '1000.00', advance_recovered: '4600.00', loan_recovered: '3000.00',
        advance_txns: 2, loan_txns: 1, loans_closed: [] },
    }]);
  });

  test('a second finalise is refused (409 RUN_STATE) and posts nothing; the run cannot be recalculated', T, async () => {
    const before = await ledgers();
    await assert.rejects(finalise(august), refused(409, 'RUN_STATE'));
    await assert.rejects(recalc(august), refused(409, 'RUN_LOCKED'));
    assert.deepEqual(await ledgers(), before);
  });

  // ── The next month ──

  test('September carries August\'s balances and compares with August\'s line', T, async () => {
    const september = await db.tx((qc) => runs.ensureRun(qc, '2026-09', 1));
    assert.equal(september.days_in_month, 30);
    await db.q(`INSERT INTO hr.run_inputs (run_id, person_id, ot_hours, absent_days, source) VALUES ($1, $2, 10, 2, 'manual')`, [september.id, A]);
    await db.q(`INSERT INTO hr.run_inputs (run_id, person_id, absent_days, source) VALUES ($1, $2, 20, 'manual')`, [september.id, B]);
    await recalc(september);

    const a = await lineOf(september, A);
    assert.deepEqual(a.loan_recoveries, [{ loan_id: loanA, amount: '3000.00' }], 'the instalment, from the 9000 left');
    const b = await lineOf(september, B);
    // ₹800 × 10 days present = 8000 against August's 24000: −67%, beyond the 25% band, so VARIANCE (info).
    assert.deepEqual([b.gross, b.advance_recovery, b.advance_given], ['8000.00', '0.00', '0.00']);
    const variance = b.flags.find((f) => f.code === 'VARIANCE');
    assert.equal(variance?.level, 'info');
    assert.match(variance.message, /^-67% vs last month/);

    await status(september, 'approved');
    await finalise(september);
    const { advance, loan } = await posted(september);
    assert.deepEqual(advance, [], 'no advance owed, none given: nothing posted');
    assert.deepEqual(loan.map((r) => [r.loan_id, r.amount]), [[loanA, '3000.00']]);
    const left = await db.tx((qc) => ledger.loanPositions(qc, [A], '2026-10'));
    assert.equal(left.get(A)[0].outstanding, '6000.00');
  });

  // ── Months go forward only (Ruling T7-c) ──

  test('with 2026-09 finalised, an earlier month cannot be started, nor finalised if made by hand (409 MONTH_BEFORE_FINALISED)', T, async () => {
    const runsBefore = await db.q('SELECT id, month, status FROM hr.runs ORDER BY month');
    assert.deepEqual(runsBefore.map((r) => [r.month, r.status]), [['2026-08', 'finalised'], ['2026-09', 'finalised']]);
    // 2026-07 has no run (2026-08 does, already finalised): starting it is refused and inserts nothing.
    await assert.rejects(db.tx((qc) => runs.ensureRun(qc, '2026-07', 1)),
      (e) => refused(409, 'MONTH_BEFORE_FINALISED')(e) && e.body.month === '2026-09');
    assert.deepEqual(await db.q('SELECT id, month, status FROM hr.runs ORDER BY month'), runsBefore, 'nothing was inserted');
    assert.equal((await db.tx((qc) => runs.ensureRun(qc, '2026-08', 1))).id, august.id, 'an existing month comes back as it is');

    // A July run made by hand (as if from before this guard), with an input. As a draft it is refused like any
    // draft; approved, it is refused for its month. Nothing is posted either time.
    stale = await db.one(`INSERT INTO hr.runs (month, days_in_month) VALUES ('2026-07', 31) RETURNING *`);
    await db.q(`INSERT INTO hr.run_inputs (run_id, person_id, absent_days, source) VALUES ($1, $2, 0, 'manual')`, [stale.id, A]);
    const before = await ledgers();
    await assert.rejects(finalise(stale), refused(409, 'RUN_STATE'));
    await status(stale, 'approved');
    await assert.rejects(finalise(stale), (e) => refused(409, 'MONTH_BEFORE_FINALISED')(e) && e.body.month === '2026-09');
    assert.deepEqual(await ledgers(), before);
    assert.equal((await runRow(stale)).status, 'approved');
  });

  // ── Loans paid off close (Ruling T7-d) ──

  test('finalising closes the loan its recovery pays off and keeps one with a balance left active; the stale July does not hold it back', T, async () => {
    const loanB = (await db.one(`INSERT INTO hr.loans (loan_no, person_id, principal, issued_on, instalment, first_due_month)
                                 VALUES ('CI-LN-0002', $1, 1000, '2026-09-30', 1000, '2026-10') RETURNING id`, [B])).id;
    await db.q(`INSERT INTO hr.loan_txns (loan_id, txn_date, kind, principal_amount) VALUES ($1, '2026-09-30', 'disbursed', 1000)`, [loanB]);
    const october = await db.tx((qc) => runs.ensureRun(qc, '2026-10', 1));
    await db.q(`INSERT INTO hr.run_inputs (run_id, person_id, absent_days, source) VALUES ($1, $2, 0, 'manual'), ($1, $3, 0, 'manual')`,
      [october.id, A, B]);
    await recalc(october);
    assert.deepEqual((await lineOf(october, A)).loan_recoveries, [{ loan_id: loanA, amount: '3000.00' }], '3000 of the 6000 left');
    assert.deepEqual((await lineOf(october, B)).loan_recoveries, [{ loan_id: loanB, amount: '1000.00' }], 'all of it');
    await status(october, 'approved');

    // The approved, unfinalisable July is earlier than October but older than the latest finalised month
    // (2026-09), so it is not an open earlier month.
    assert.equal((await runRow(stale)).status, 'approved');
    assert.equal((await finalise(october)).status, 'finalised');

    assert.deepEqual(await db.q('SELECT id, status FROM hr.loans ORDER BY id'),
      [{ id: loanA, status: 'active' }, { id: loanB, status: 'closed' }]);
    assert.deepEqual(await db.tx((qc) => ledger.loanPositions(qc, [A, B], '2026-11')), new Map([
      [A, [{ loan_id: loanA, loan_no: 'CI-LN-0001', due: '3000.00', outstanding: '3000.00' }]],
      [B, []],
    ]), 'a closed loan is no longer a position; the active one has 3000 left');
    const runAudit = await db.one(`SELECT detail FROM hr.audit_log WHERE entity = 'run' AND entity_id = $1 AND action = 'finalise'`,
      [String(october.id)]);
    assert.deepEqual(runAudit.detail.loans_closed, ['CI-LN-0002']);
    assert.deepEqual(await db.q(`SELECT entity_id, user_id, detail FROM hr.audit_log WHERE entity = 'loan' AND action = 'close'`), [{
      entity_id: String(loanB), user_id: 1,
      detail: { loan_no: 'CI-LN-0002', run_id: october.id, month: '2026-10', reason: 'paid off by payroll recovery' },
    }]);
  });

  // ── Balances as at the month's end (final review I-1) ──
  // November is approved; then money is handed to B in DECEMBER (an advance given in the app and a loan issued, as
  // POST /hr/staff-payments writes them). November's run reads balances as at 30 November, so it neither changes
  // (no RUN_CHANGED_SINCE_APPROVAL) nor takes either; December recovers both. (The months follow this file's story,
  // which has finalised August to October already; the case is the review's July → August one, a month later.)
  // Reductions are never filtered by date: August's recovery rows are dated the day they were posted, after
  // August and September ended, and September above still read A's loan at 9000.

  test('money handed over after an approved month does not move it: it finalises, posts neither, and the next month recovers both', T, async () => {
    const november = await db.tx((qc) => runs.ensureRun(qc, '2026-11', 1));
    await db.q(`INSERT INTO hr.run_inputs (run_id, person_id, absent_days, source) VALUES ($1, $2, 0, 'manual'), ($1, $3, 0, 'manual')`,
      [november.id, A, B]);
    await recalc(november);
    await status(november, 'approved');
    const approved = await hashes(november);

    const advanceDec = (await db.one(`INSERT INTO hr.advance_txns (person_id, txn_date, kind, amount, source, note)
                                      VALUES ($1, '2026-12-04', 'given', 700, 'manual', 'Test: paid via cash') RETURNING id`, [B])).id;
    const loanDec = (await db.one(`INSERT INTO hr.loans (loan_no, person_id, principal, issued_on, instalment, first_due_month)
                                   VALUES ('CI-LN-0003', $1, 1200, '2026-12-04', 400, '2026-12') RETURNING id`, [B])).id;
    await db.q(`INSERT INTO hr.loan_txns (loan_id, txn_date, kind, principal_amount) VALUES ($1, '2026-12-04', 'disbursed', 1200)`, [loanDec]);

    // As at November's end B owes nothing; the balance now (no month: person detail, Pay staff) has both.
    const views = await db.tx(async (qc) => ({
      asAt: await ledger.advanceBalances(qc, [B], '2026-11'),
      now: await ledger.advanceBalances(qc, [B]),
      loansAsAt: await ledger.loanPositions(qc, [B], '2026-11', '2026-11'),
      loansNow: await ledger.loanPositions(qc, [B], '2026-12'),
    }));
    assert.equal(views.asAt.get(B), '0.00');
    assert.equal(views.now.get(B), '700.00');
    assert.deepEqual(views.loansAsAt.get(B), [], 'a loan issued in December is not in November');
    assert.deepEqual(views.loansNow.get(B), [{ loan_id: loanDec, loan_no: 'CI-LN-0003', due: '400.00', outstanding: '1200.00' }]);

    const done = await finalise(november);
    assert.equal(done.status, 'finalised', 'no RUN_CHANGED_SINCE_APPROVAL');
    assert.deepEqual(await hashes(november), approved);
    const { advance, loan } = await posted(november);
    assert.deepEqual(advance.filter((r) => r.person_id === B), [], 'nothing recovered from B in November');
    assert.deepEqual(loan.map((r) => r.loan_id), [loanA], "only A's instalment; nothing from the December loan");
    assert.deepEqual(await db.q('SELECT kind, amount::text AS amount, run_id FROM hr.advance_txns WHERE id = $1', [advanceDec]),
      [{ kind: 'given', amount: '700.00', run_id: null }]);

    const december = await db.tx((qc) => runs.ensureRun(qc, '2026-12', 1));
    await db.q(`INSERT INTO hr.run_inputs (run_id, person_id, absent_days, source) VALUES ($1, $2, 0, 'manual')`, [december.id, B]);
    await recalc(december);
    const b = await lineOf(december, B);
    assert.equal(b.advance_recovery, '700.00', "December recovers the advance given in December");
    assert.deepEqual(b.loan_recoveries, [{ loan_id: loanDec, amount: '400.00' }], "and the loan's first instalment");
  });
});
