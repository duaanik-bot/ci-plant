// HR · sub-accounts on a real Postgres (owner's request 2026-11-15: "Gangadhari is the sub account of Jiut").
// A sub-account keeps its own line; what its pay cannot cover (advance, loan instalment) is a deduction on its
// main account's line the same month, and finalise posts it to the sub-account's own ledgers. Invented people only.
// Run: HR_PG=1 node --test src/hr-subaccount-pg.test.js
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

describe('sub-accounts on a real Postgres', { skip: ENABLED ? false : 'set HR_PG=1 to boot a throwaway Postgres' }, () => {
  let epg, dir, db, pool, runs, ledger;
  let M, S, loanS, run, alone;
  const req = { user: { id: 1, name: 'Test Approver' } };

  before(async () => {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-sub-'));
    const port = await freePort();
    epg = new EmbeddedPostgres({ databaseDir: dir, port, user: 'postgres', password: 'postgres', persistent: false, onLog: () => {}, onError: () => {} });
    await epg.initialise();
    await epg.start();
    process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
    process.env.PG_POOL_MAX = '1';
    db = await import('./db.js');
    pool = await db.connect();
    await db.init();
    runs = await import('./hr/runs.js');
    ledger = await import('./hr/ledger.js');

    await db.q(`INSERT INTO hr.pay_channels (code, label, kind) VALUES ('TCASH', 'Test cash', 'cash')`);
    M = (await db.one(`INSERT INTO hr.people (code, name, pay_channel) VALUES ('T-901', 'Test Main Contractor', 'TCASH') RETURNING id`)).id;
    S = (await db.one(`INSERT INTO hr.people (code, name, display_name, pay_channel) VALUES ('T-902', 'Test Sub Contractor', 'Test Main Second', 'TCASH') RETURNING id`)).id;
    await db.q(`INSERT INTO hr.pay_setups (person_id, effective_from, pay_basis, base) VALUES ($1, '2026-04-01', 'monthly', 30000), ($2, '2026-04-01', 'monthly', 3000)`, [M, S]);
    // S owes an advance of 5000 and a loan instalment of 1000: more than its 3000 pay.
    await db.q(`INSERT INTO hr.advance_txns (person_id, txn_date, kind, amount, source) VALUES ($1, '2026-08-31', 'opening', 5000, 'loader')`, [S]);
    loanS = (await db.one(`INSERT INTO hr.loans (loan_no, person_id, principal, issued_on, instalment, first_due_month, is_opening)
                           VALUES ('CI-LN-0901', $1, 4000, '2026-08-31', 1000, '2026-09', true) RETURNING id`, [S])).id;
    await db.q(`INSERT INTO hr.loan_txns (loan_id, txn_date, kind, principal_amount) VALUES ($1, '2026-08-31', 'opening', 4000)`, [loanS]);
    run = await db.tx((qc) => runs.ensureRun(qc, '2026-09', 1));
    await db.q(`INSERT INTO hr.run_inputs (run_id, person_id, absent_days, source) VALUES ($1, $2, 0, 'manual'), ($1, $3, 0, 'manual')`, [run.id, M, S]);
  });

  after(async () => {
    try { await pool?.end(); } catch {}
    try { await epg?.stop(); } catch {}
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const lineOf = (personId) => db.one(
    `SELECT payable::text AS payable, adj_deductions::text AS adj_deductions, advance_recovery::text AS advance_recovery,
            loan_recoveries, unrecovered, breakdown, flags FROM hr.run_lines WHERE run_id = $1 AND person_id = $2`, [run.id, personId]);
  const subLines = (l) => l.breakdown.filter((b) => /^ADJ:SUB/.test(b.code)).map((b) => [b.code, b.amount]);

  test('alone, the sub-account leaves 3000 uncovered and the main account pays in full', T, async () => {
    await db.tx((qc) => runs.recalcRun(qc, run));
    const s = await lineOf(S);
    assert.equal(s.payable, '0.00');
    alone = s.unrecovered;
    const left = Number(s.unrecovered.advance) + s.unrecovered.loans.reduce((t, l) => t + Number(l.amount), 0);
    assert.equal(left, 3000, '6000 owed, 3000 of pay');
    assert.equal((await lineOf(M)).payable, '30000.00');
  });

  test('linked: the main account covers what the sub-account could not, under the sub-account\'s name', T, async () => {
    await db.q(`UPDATE hr.people SET parent_id = $1 WHERE id = $2`, [M, S]);
    // Recalculating only the sub-account works out its main account too.
    await db.tx((qc) => runs.recalcRun(qc, run, { personIds: [S] }));
    const s = await lineOf(S);
    const m = await lineOf(M);
    const wanted = [];
    if (Number(alone.advance) > 0) wanted.push([`ADJ:SUB${S}-ADV`, alone.advance]);
    for (const l of alone.loans) wanted.push([`ADJ:SUB${S}-LN${l.loan_id}`, l.amount]);
    assert.deepEqual(subLines(m).sort(), wanted.sort());
    assert.equal(m.payable, '27000.00', '30000 less the 3000 the sub-account could not cover');
    assert.match(m.breakdown.find((b) => /^ADJ:SUB/.test(b.code)).label, /Sub-account Test Main Second/);
    // Both lines say so (2026-11-15: "make this adjustment visible"): the sub-account is covered, not short.
    const cover = s.flags.find((f) => f.code === 'COVERED_BY_MAIN');
    assert.equal(cover?.amount, '3000.00');
    assert.equal(cover?.main_id, M);
    assert.match(cover.message, /Test Main Contractor's pay/);
    const covers = m.flags.find((f) => f.code === 'COVERS_SUB');
    assert.deepEqual([covers?.sub_id, covers?.amount], [S, '3000.00']);
    const carried = await db.one(`SELECT carried_advance::text AS c FROM hr.run_lines WHERE run_id = $1 AND person_id = $2`, [run.id, S]);
    assert.equal(carried.c, '0.00', 'what the main account covers is not carried forward on the sub-account');
    // Nor left as unrecovered / short, which next month's "carried forward" and the reports read (2026-11-17).
    assert.deepEqual([s.unrecovered.advance, s.unrecovered.loans], ['0.00', []]);
    const nb = await db.one(`SELECT net_before_cap::text AS n FROM hr.run_lines WHERE run_id = $1 AND person_id = $2`, [run.id, S]);
    assert.equal(nb.n, '0.00');
    const totals = await db.tx((qc) => runs.totalsOf(qc, run.id));
    assert.equal(totals.carried_advance, '0.00');
  });

  test('finalise posts the covered amounts to the sub-account\'s ledgers: its advance and loan are fully recovered', T, async () => {
    await db.q(`UPDATE hr.runs SET status = 'approved' WHERE id = $1`, [run.id]);
    const done = await db.tx((qc) => runs.finaliseRun(qc, run, req));
    assert.equal(done.status, 'finalised');
    const adv = await db.q(`SELECT kind, amount::text AS amount, note FROM hr.advance_txns WHERE run_id = $1 AND person_id = $2`, [run.id, S]);
    assert.equal(adv.length, 1, 'one recovered row for the sub-account (the run-once key)');
    assert.equal(adv[0].amount, '5000.00');
    assert.match(adv[0].note, /main account's pay/);
    const loan = await db.q(`SELECT principal_amount::text AS amount FROM hr.loan_txns WHERE run_id = $1 AND loan_id = $2`, [run.id, loanS]);
    assert.deepEqual(loan, [{ amount: '1000.00' }]);
    const balances = await db.tx(async (qc) => ({
      advance: (await ledger.advanceBalances(qc, [S])).get(S),
      loans: (await ledger.loanPositions(qc, [S], '2026-10')).get(S),
    }));
    assert.equal(balances.advance, '0.00');
    assert.equal(balances.loans[0].outstanding, '3000.00');
    assert.deepEqual(await db.q(`SELECT kind FROM hr.advance_txns WHERE run_id = $1 AND person_id = $2`, [run.id, M]), [],
      'nothing is posted to the main account: the money was the sub-account\'s debt');
  });
});
