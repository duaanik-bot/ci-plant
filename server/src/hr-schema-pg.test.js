// The HR & Payroll schema against a real Postgres.
//
// Boots its OWN throwaway Postgres in a temp dir on a free port, with PG_POOL_MAX=1 (the
// Vercel geometry: a pool call inside a transaction would hang), and runs init() — which
// replays supabase/migrations/20261016120000_hr_payroll.sql. Then it replays the file again
// and proves that changes nothing, and that the wall holds: RLS on every hr table, no
// foreign key in or out of hr, nothing reachable for PUBLIC / anon / authenticated even
// after an accidental grant, an append-only audit log, the CHECKs and partial uniques, an
// access bootstrap that grants only the MD's login, and hrGuard reading hr.access fresh.
// Every name and figure here is synthetic.
//
//   HR_PG=1 node --test src/hr-schema-pg.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENABLED = process.env.HR_PG === '1';
const MIGRATION = fileURLToPath(new URL('../../supabase/migrations/20261016120000_hr_payroll.sql', import.meta.url));
const HOLD = fileURLToPath(new URL('../../supabase/migrations/20261018120000_hr_payment_hold.sql', import.meta.url));

// Every hr table, in catalogue (C collation) order.
const TABLES = ['access', 'adjustments', 'advance_txns', 'audit_log', 'column_maps', 'import_batches', 'import_rows',
  'loan_holidays', 'loan_txns', 'loans', 'pay_channels', 'pay_setups', 'payment_batches', 'people', 'person_aliases',
  'run_inputs', 'run_lines', 'runs', 'settings'];

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.unref();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

describe('the hr schema on a real Postgres', {
  skip: ENABLED ? false : 'set HR_PG=1 to boot a throwaway Postgres',
}, () => {
  let epg, dir, db, pool, sql, access, audit;

  before(async () => {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-schema-'));
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
    // Supabase's API roles, so the migration's guarded revokes really run.
    await pool.query('create role anon nologin; create role authenticated nologin;');
    await db.init();
    sql = fs.readFileSync(MIGRATION, 'utf8');
    access = await import('./hr/access.js');
    audit = await import('./hr/audit.js');
  });

  after(async () => {
    try { await pool?.end(); } catch {}
    try { await epg?.stop(); } catch {}
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  // The replay exactly as init() runs it: the whole file, one simple-protocol query.
  const replay = () => pool.query(sql);
  // A statement's SQLSTATE, or 'ok'.
  const codeOf = async (text, params = []) => {
    try { await db.q(text, params); return 'ok'; } catch (e) { return e.code; }
  };

  const snapshot = async () => ({
    relations: await db.q(`
      SELECT c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity, coalesce(c.relacl::text, '') AS acl
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'hr' ORDER BY c.relname`),
    columns: await db.q(`
      SELECT table_name, column_name, data_type, numeric_precision, numeric_scale, is_nullable, column_default
        FROM information_schema.columns WHERE table_schema = 'hr' ORDER BY table_name, ordinal_position`),
    constraints: await db.q(`
      SELECT c.conrelid::regclass::text AS rel, c.conname, pg_get_constraintdef(c.oid) AS def
        FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE n.nspname = 'hr' ORDER BY 1, 2`),
    indexes: await db.q(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'hr' ORDER BY indexname`),
    triggers: await db.q(`
      SELECT t.tgname, pg_get_triggerdef(t.oid) AS def
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'hr' AND NOT t.tgisinternal ORDER BY 1`),
    functions: await db.q(`
      SELECT p.proname, pg_get_functiondef(p.oid) AS def, coalesce(p.proacl::text, '') AS acl
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'hr' ORDER BY 1`),
    schema: await db.q(`SELECT coalesce(nspacl::text, '') AS acl FROM pg_namespace WHERE nspname = 'hr'`),
    policies: await db.q(`SELECT policyname FROM pg_policies WHERE schemaname = 'hr'`),
    settings: await db.q(`SELECT key, value FROM hr.settings ORDER BY key`),
    access: await db.q(`SELECT user_id, level, granted_by, note FROM hr.access ORDER BY user_id`),
  });

  // Synthetic people and a July run, made once, shared by the integrity tests.
  let fixturesMade = null;
  const fixtures = () => (fixturesMade ??= (async () => {
    const person = (await db.one(`INSERT INTO hr.people (code, name) VALUES ('T-1', 'Test Person One') RETURNING id`)).id;
    const other = (await db.one(`INSERT INTO hr.people (code, name) VALUES ('T-2', 'Test Person Two') RETURNING id`)).id;
    const july = await db.one(`INSERT INTO hr.runs (month, days_in_month) VALUES ('2026-07', 31) RETURNING id, status`);
    return { person, other, july };
  })());

  // ── Built, and replay-safe ───────────────────────────────────────────

  test('init() built every hr table, with RLS on (never forced) and no policy', async () => {
    const rels = await db.q(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'hr' AND c.relkind = 'r' ORDER BY c.relname`);
    assert.deepEqual(rels.map(r => r.relname), TABLES);
    for (const r of rels) {
      assert.equal(r.relrowsecurity, true, `RLS on hr.${r.relname}`);
      assert.equal(r.relforcerowsecurity, false, `hr.${r.relname} is not forced: its owner, the server, reads it`);
    }
    assert.deepEqual(await db.q(`SELECT policyname FROM pg_policies WHERE schemaname = 'hr'`), []);
  });

  test('replaying the migration again changes nothing, and its lock timeout ends with it', async () => {
    const first = await snapshot();
    assert.equal(first.relations.filter(r => r.relkind === 'r').length, TABLES.length);
    await replay();
    await replay();
    assert.deepEqual(await snapshot(), first);
    // PG_POOL_MAX=1: the same connection that ran the replay. A plain SET would still be here.
    assert.equal((await db.one('SHOW lock_timeout')).lock_timeout, '0');
  });

  test('the payment-hold migration: on_hold under the same CHECK name, four columns, and a replay alters nothing', async () => {
    const def = await db.one(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'hr.run_lines'::regclass AND conname = 'run_lines_payment_status_check'`);
    for (const s of ['pending', 'paid', 'on_hold', 'failed', 'reversed']) assert.ok(def.def.includes(`'${s}'`), def.def);
    assert.equal((await db.one(
      `SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'hr.run_lines'::regclass AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%payment_status%'`)).n, 1, 'one CHECK on payment_status, not two');
    const cols = await db.q(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = 'hr' AND table_name = 'run_lines'
          AND column_name IN ('hold_reason', 'held_by', 'held_at', 'status_note') ORDER BY column_name`);
    assert.deepEqual(cols, [
      { column_name: 'held_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
      { column_name: 'held_by', data_type: 'integer', is_nullable: 'YES' },
      { column_name: 'hold_reason', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'status_note', data_type: 'text', is_nullable: 'YES' },
    ]);
    const hold = fs.readFileSync(HOLD, 'utf8');
    const conOid = async () => (await db.one(
      `SELECT oid::text AS oid FROM pg_constraint WHERE conrelid = 'hr.run_lines'::regclass AND conname = 'run_lines_payment_status_check'`)).oid;
    const first = await snapshot();
    const oid = await conOid();
    await pool.query(hold);
    await pool.query(sql);
    await pool.query(hold);
    assert.deepEqual(await snapshot(), first);
    assert.equal(await conOid(), oid, 'the CHECK was not dropped and re-made on a replay');
    assert.equal((await db.one('SHOW lock_timeout')).lock_timeout, '0');
  });

  test('settings carry the policy defaults, and a replay never overwrites a change', async () => {
    const read = async () => Object.fromEntries((await db.q('SELECT key, value FROM hr.settings')).map(r => [r.key, r.value]));
    assert.deepEqual(await read(), {
      rounding: 'rupee', ot_high_hours: 150, deduction_warn_pct: 50, variance_warn_pct: 25,
      holiday_divisor_default: 30.5, strict_separation: false,
      blank_zero: { ot_hours: true, absent_days: true, misc_earning: true, advance_given: true, bill_amount: true },
    });
    await db.q(`UPDATE hr.settings SET value = '"paise"' WHERE key = 'rounding'`);
    await replay();
    assert.equal((await read()).rounding, 'paise');
    await db.q(`UPDATE hr.settings SET value = '"rupee"' WHERE key = 'rounding'`);
    assert.deepEqual(await db.q('SELECT code FROM hr.pay_channels'), [], 'pay channels are never seeded');
  });

  // ── The wall ─────────────────────────────────────────────────────────

  test('no foreign key leaves schema hr, and none comes into it', async () => {
    const out = await db.q(`
      SELECT c.conrelid::regclass::text AS from_table, c.confrelid::regclass::text AS to_table
        FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE n.nspname = 'hr' AND c.contype = 'f'`);
    assert.ok(out.length >= 15, `found only ${out.length} foreign keys`);
    for (const fk of out) assert.match(fk.to_table, /^hr\./, `${fk.from_table} → ${fk.to_table}`);
    const into = await db.q(`
      SELECT c.conrelid::regclass::text AS from_table
        FROM pg_constraint c JOIN pg_class t ON t.oid = c.confrelid JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE c.contype = 'f' AND n.nspname = 'hr' AND c.connamespace <> n.oid`);
    assert.deepEqual(into, []);
  });

  test('money, quantities, months and dates have their types; no float column', async () => {
    const cols = await db.q(`
      SELECT table_name || '.' || column_name AS col, data_type, numeric_precision AS p, numeric_scale AS s
        FROM information_schema.columns WHERE table_schema = 'hr'`);
    const by = Object.fromEntries(cols.map(c => [c.col, c]));
    assert.deepEqual(cols.filter(c => ['double precision', 'real', 'money'].includes(c.data_type)), []);
    for (const c of cols.filter(x => x.data_type === 'numeric')) assert.ok(['12,2', '14,4'].includes(`${c.p},${c.s}`), c.col);
    for (const c of ['run_lines.payable', 'run_lines.net_before_cap', 'run_inputs.advance_given', 'loans.principal', 'advance_txns.amount']) {
      assert.deepEqual([by[c].data_type, by[c].p, by[c].s], ['numeric', 12, 2], c);
    }
    for (const c of ['run_inputs.ot_hours', 'run_inputs.absent_days', 'run_lines.present_days', 'pay_setups.ot_hours_per_day']) {
      assert.deepEqual([by[c].data_type, by[c].p, by[c].s], ['numeric', 14, 4], c);
    }
    for (const c of ['runs.month', 'import_batches.month', 'adjustments.start_month', 'adjustments.end_month',
      'loans.first_due_month', 'loan_holidays.month']) assert.equal(by[c].data_type, 'text', c);
    for (const c of ['people.joined_on', 'people.exited_on', 'loans.issued_on', 'advance_txns.txn_date',
      'loan_txns.txn_date', 'pay_setups.effective_from', 'run_lines.paid_on', 'payment_batches.paid_on']) {
      assert.equal(by[c].data_type, 'date', c);
    }
  });

  test('PUBLIC, anon and authenticated reach nothing in hr, even after an accidental grant', async () => {
    const reach = () => db.q(`
      SELECT r.role,
             has_schema_privilege(r.role, 'hr', 'USAGE') AS usage,
             has_schema_privilege(r.role, 'hr', 'CREATE') AS can_create,
             (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'hr' AND c.relkind = 'r'
                 AND has_table_privilege(r.role, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) AS tables,
             (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'hr' AND c.relkind = 'S'
                 AND has_sequence_privilege(r.role, c.oid, 'USAGE,SELECT,UPDATE')) AS sequences,
             has_function_privilege(r.role, 'hr.audit_log_immutable()', 'EXECUTE') AS fn
        FROM (VALUES ('public'), ('anon'), ('authenticated')) AS r(role) ORDER BY r.role`);
    const closed = ['anon', 'authenticated', 'public'].map(role => ({ role, usage: false, can_create: false, tables: 0, sequences: 0, fn: false }));
    assert.deepEqual(await reach(), closed);

    // Someone grants too much (Supabase-style defaults, or by hand)…
    await pool.query(`
      GRANT USAGE, CREATE ON SCHEMA hr TO PUBLIC, anon, authenticated;
      GRANT ALL ON ALL TABLES IN SCHEMA hr TO PUBLIC, anon, authenticated;
      GRANT ALL ON ALL SEQUENCES IN SCHEMA hr TO PUBLIC, anon, authenticated;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA hr TO PUBLIC, anon, authenticated;`);
    const open = await reach();
    assert.ok(open.every(r => r.usage && r.tables === TABLES.length && r.fn), 'the grant took (the probe can see it)');

    // …and RLS still shows such a role no row and takes no row from it.
    const seen = await db.tx(async (qc) => {
      await qc('SET LOCAL ROLE anon');
      return qc('SELECT count(*)::int AS n FROM hr.settings');
    });
    assert.deepEqual(seen, [{ n: 0 }], 'seven settings rows exist; anon sees none');
    await assert.rejects(db.tx(async (qc) => {
      await qc('SET LOCAL ROLE authenticated');
      await qc(`INSERT INTO hr.access (user_id, level) VALUES (424242, 'admin')`);
    }), (e) => e.code === '42501');

    // The next replay takes it all back.
    await replay();
    assert.deepEqual(await reach(), closed);
  });

  // ── The audit log ────────────────────────────────────────────────────

  test('hrAudit writes in the transaction; the log refuses UPDATE, DELETE and TRUNCATE', async () => {
    const req = { user: { id: 41, name: 'Synthetic Operator', role: 'planner' } };
    const row = await db.tx(qc => audit.hrAudit(qc, req, 'run', 7, 'finalise', [{ lines: 2 }]));
    assert.ok(row?.id && row?.at);
    assert.deepEqual(
      await db.one('SELECT user_id, user_name, entity, entity_id, action, detail FROM hr.audit_log WHERE id = $1', [row.id]),
      { user_id: 41, user_name: 'Synthetic Operator', entity: 'run', entity_id: '7', action: 'finalise', detail: [{ lines: 2 }] });

    // A write that fails takes its audit row with it.
    await assert.rejects(db.tx(async (qc) => {
      await audit.hrAudit(qc, req, 'run', 7, 'approve');
      throw new Error('the write failed');
    }), /the write failed/);
    assert.equal((await db.one(`SELECT count(*)::int AS n FROM hr.audit_log WHERE action = 'approve'`)).n, 0);

    for (const [text, params] of [
      ['UPDATE hr.audit_log SET action = $1 WHERE id = $2', ['tampered', row.id]],
      ['UPDATE hr.audit_log SET detail = NULL', []],
      ['DELETE FROM hr.audit_log WHERE id = $1', [row.id]],
      ['DELETE FROM hr.audit_log', []],
      ['TRUNCATE hr.audit_log', []],
    ]) {
      await assert.rejects(db.q(text, params), (e) => {
        assert.equal(e.code, 'P0001', text);
        assert.match(e.message, /hr\.audit_log is append-only/, text);
        return true;
      }, text);
    }
    assert.deepEqual(await db.q('SELECT id, action FROM hr.audit_log'), [{ id: row.id, action: 'finalise' }]);
  });

  // ── The CHECKs and the partial uniques ───────────────────────────────

  test('months, days in the month, the 1st of the month, run states', async () => {
    const { person, july } = await fixtures();
    assert.equal(july.status, 'draft');
    const run = (month, days, status = 'draft') =>
      codeOf('INSERT INTO hr.runs (month, days_in_month, status) VALUES ($1, $2, $3)', [month, days, status]);
    assert.equal(await run('2026-13', 31), '23514');
    assert.equal(await run('2026-7', 31), '23514');
    assert.equal(await run('2026-00', 31), '23514');
    assert.equal(await run('2026-09', 31), '23514', 'September has 30');
    assert.equal(await run('2028-02', 28), '23514', 'a leap February has 29');
    assert.equal(await run('2026-08', 31, 'finalized'), '23514', "the spelling is 'finalised'");
    assert.equal(await run('2026-02', 28), 'ok');
    assert.equal(await run('2028-02', 29), 'ok');
    assert.equal(await run('2026-09', 30, 'finalised'), 'ok');
    assert.equal(await run('2026-07', 31), '23505', 'one run per month');

    const setup = (from, basis = 'monthly', base = 1000) => codeOf(
      'INSERT INTO hr.pay_setups (person_id, effective_from, pay_basis, base) VALUES ($1, $2, $3, $4)', [person, from, basis, base]);
    assert.equal(await setup('2026-07-02'), '23514', 'a revision starts on the 1st');
    assert.equal(await setup('2026-07-01', 'monthly', null), '23514', 'a monthly setup needs its base');
    assert.equal(await setup('2026-07-01', 'weekly'), '23514');
    assert.equal(await setup('2026-07-01'), 'ok');
    assert.equal(await setup('2026-07-01'), '23505', 'one revision per person per month');
    assert.equal(await setup('2026-08-01', 'contract', null), 'ok', 'a contract is paid its bill amount');
  });

  test('inputs and lines: their defaults and states', async () => {
    const { person, other, july } = await fixtures();
    assert.deepEqual(await db.one(
      `INSERT INTO hr.run_inputs (run_id, person_id, source) VALUES ($1, $2, 'import') RETURNING advance_mode, include`,
      [july.id, person]), { advance_mode: 'total', include: true });
    assert.equal(await codeOf('INSERT INTO hr.run_inputs (run_id, person_id) VALUES ($1, $2)', [july.id, other]), '23502',
      'an input row says where it came from');
    assert.equal(await codeOf(`INSERT INTO hr.run_inputs (run_id, person_id, source, advance_mode) VALUES ($1, $2, 'manual', 'both')`,
      [july.id, other]), '23514');
    assert.equal(await codeOf(`INSERT INTO hr.run_inputs (run_id, person_id, source, ot_hours) VALUES ($1, $2, 'manual', -1)`,
      [july.id, other]), '23514');

    assert.deepEqual(await db.one(
      'INSERT INTO hr.run_lines (run_id, person_id, payable, net_before_cap) VALUES ($1, $2, 1000, -250.5) RETURNING payment_status, payable, net_before_cap',
      [july.id, person]), { payment_status: 'pending', payable: 1000, net_before_cap: -250.5 });
    for (const s of ['paid', 'on_hold', 'failed', 'reversed', 'pending']) {
      assert.equal(await codeOf('UPDATE hr.run_lines SET payment_status = $2 WHERE run_id = $1', [july.id, s]), 'ok', s);
    }
    assert.equal(await codeOf(`UPDATE hr.run_lines SET payment_status = 'refunded' WHERE run_id = $1`, [july.id]), '23514');
    assert.equal(await codeOf('INSERT INTO hr.run_lines (run_id, person_id) VALUES ($1, $2)', [july.id, person]), '23505');
  });

  test('import: the same file twice is caught; a row names a person only on a certain match', async () => {
    const { person } = await fixtures();
    const sha = 'a'.repeat(64);
    const batch = (await db.one(`INSERT INTO hr.import_batches (month, file_sha256) VALUES ('2026-07', $1) RETURNING id`, [sha])).id;
    assert.equal(await codeOf(`INSERT INTO hr.import_batches (month, file_sha256) VALUES ('2026-07', $1)`, [sha]), '23505');
    assert.equal(await codeOf(`INSERT INTO hr.import_batches (month, file_sha256) VALUES ('2026-08', $1)`, [sha]), 'ok',
      'the same file for another month is that month’s business');
    await db.q(`UPDATE hr.import_batches SET status = 'superseded' WHERE id = $1`, [batch]);
    assert.equal(await codeOf(`INSERT INTO hr.import_batches (month, file_sha256) VALUES ('2026-07', $1)`, [sha]), '23505',
      'a superseded copy still counts');
    await db.q(`UPDATE hr.import_batches SET status = 'discarded' WHERE id = $1`, [batch]);
    const live = (await db.one(`INSERT INTO hr.import_batches (month, file_sha256) VALUES ('2026-07', $1) RETURNING id`, [sha])).id;
    assert.equal(await codeOf(`INSERT INTO hr.import_batches (month, file_sha256) VALUES ('2026-07', 'not-a-sha')`), '23514');
    assert.equal(await codeOf(`INSERT INTO hr.import_batches (month, file_sha256) VALUES ('July', $1)`, ['b'.repeat(64)]), '23514');

    let rowNo = 0;
    const row = (match, personId, decision = null) => codeOf(
      `INSERT INTO hr.import_rows (batch_id, row_no, raw, match, person_id, decision) VALUES ($1, $2, '[]', $3, $4, $5)`,
      [live, ++rowNo, match, personId, decision]);
    for (const m of ['code', 'exact_name', 'alias', 'manual']) assert.equal(await row(m, person), 'ok', m);
    for (const m of ['unmatched', 'ambiguous', 'conflict', 'unknown_code']) assert.equal(await row(m, null), 'ok', m);
    assert.equal(await row('fuzzy', null), '23514');
    assert.equal(await row('prefix', person), '23514');
    for (const m of ['conflict', 'ambiguous', 'unmatched', 'unknown_code']) {
      assert.equal(await row(m, person), '23514', `${m} never names a person`);
    }
    assert.equal(await row('code', null), '23514');
    assert.equal(await row('unmatched', null, 'include'), '23514', 'include needs a person');
    assert.equal(await row('unmatched', null, 'ignore'), 'ok', 'ignored, as instructed');
    assert.equal(await row('code', person, 'include'), 'ok');
    assert.equal(await codeOf(`INSERT INTO hr.import_rows (batch_id, row_no, raw) VALUES ($1, 1, '[]')`, [live]), '23505');
    assert.equal(await codeOf(`INSERT INTO hr.import_rows (batch_id, row_no, raw) VALUES ($1, 0, '[]')`, [live]), '23514');
  });

  test('ledgers: an advance kind and a loan recovery post once per run', async () => {
    const { person, july } = await fixtures();
    const adv = (kind, run, amount = 100, source = 'payroll') => codeOf(
      `INSERT INTO hr.advance_txns (person_id, txn_date, kind, amount, run_id, source) VALUES ($1, '2026-07-31', $2, $3, $4, $5)`,
      [person, kind, amount, run, source]);
    assert.equal(await adv('given', july.id), 'ok');
    assert.equal(await adv('recovered', july.id), 'ok');
    assert.equal(await adv('given', july.id), '23505', 'a second finalise cannot post twice');
    assert.equal(await adv('recovered', july.id), '23505');
    assert.equal(await adv('given', null, 500, 'manual'), 'ok');
    assert.equal(await adv('given', null, 500, 'manual'), 'ok', 'in-app advances carry no run');
    assert.equal(await adv('given', null, 0, 'manual'), '23514', 'amounts are positive');
    assert.equal(await adv('repaid', null), '23514');
    assert.equal(await adv('given', null, 5, null), '23502', 'a row says where it came from');

    const loan = (no, rate = 0, due = '2026-08') => codeOf(
      `INSERT INTO hr.loans (loan_no, person_id, principal, issued_on, instalment, first_due_month, interest_rate)
       VALUES ($1, $2, 20000, '2026-07-05', 5000, $3, $4)`, [no, person, due, rate]);
    assert.equal(await loan('CI-LN0001'), '23514', 'the number is CI-LN-0001');
    assert.equal(await loan('CI-LN-0001', 1), '23514', 'interest-free in Phase 1');
    assert.equal(await loan('CI-LN-0001', 0, '2026-8'), '23514');
    assert.equal(await loan('CI-LN-0001'), 'ok');
    assert.equal(await loan('CI-LN-0001'), '23505');
    const loanId = (await db.one(`SELECT id FROM hr.loans WHERE loan_no = 'CI-LN-0001'`)).id;
    const ltx = (kind, run, amount = 5000) => codeOf(
      `INSERT INTO hr.loan_txns (loan_id, txn_date, kind, principal_amount, run_id) VALUES ($1, '2026-07-31', $2, $3, $4)`,
      [loanId, kind, amount, run]);
    assert.equal(await ltx('disbursed', null, 20000), 'ok');
    assert.equal(await ltx('payroll_recovery', july.id), 'ok');
    assert.equal(await ltx('payroll_recovery', july.id), '23505', 'recovered once per loan per run');
    assert.equal(await ltx('payroll_recovery', null), '23514', 'a payroll recovery names its run');
    assert.equal(await ltx('prepayment', july.id), 'ok');
    assert.equal(await ltx('prepayment', july.id), 'ok', 'only payroll recoveries are once per run');
    assert.equal(await ltx('waiver', null, -5), '23514', 'the kind gives the direction');
    assert.equal(await ltx('adjustment', null, -5), 'ok', 'an adjustment is signed');
    assert.equal(await ltx('adjustment', null, 0), '23514');
    const holiday = month => codeOf('INSERT INTO hr.loan_holidays (loan_id, month) VALUES ($1, $2)', [loanId, month]);
    assert.equal(await holiday('2026-09'), 'ok');
    assert.equal(await holiday('2026-09'), '23505');
    assert.equal(await holiday('2026-9'), '23514');
  });

  test('adjustments, people and access levels', async () => {
    const { person, other } = await fixtures();
    const adj = (recurrence, start, end) => codeOf(
      `INSERT INTO hr.adjustments (person_id, kind, amount, recurrence, start_month, end_month)
       VALUES ($1, 'earning', 500, $2, $3, $4)`, [person, recurrence, start, end]);
    assert.equal(await adj('recurring', '2026-08', null), '23514', 'recurring needs both ends');
    assert.equal(await adj('recurring', '2026-08', '2026-07'), '23514', 'in order');
    assert.equal(await adj('recurring', '2026-08', '2026-12'), 'ok');
    assert.equal(await adj('one_time', '2026-08', '2026-09'), '23514', 'one-time never repeats');
    assert.equal(await adj('one_time', '2026-08', null), 'ok');
    assert.equal(await adj('one_time', '2026-13', null), '23514');

    assert.equal(await codeOf('UPDATE hr.people SET employee_id = 77 WHERE id = $1', [person]), 'ok');
    assert.equal(await codeOf('UPDATE hr.people SET employee_id = 77 WHERE id = $1', [other]), '23505', 'one HR person per ERP operator');
    assert.equal(await codeOf(`INSERT INTO hr.people (code, name) VALUES ('T-1', 'Someone Else')`), '23505', 'codes are unique');
    assert.equal(await codeOf(`INSERT INTO hr.people (code, name, status) VALUES ('T-3', 'Test Three', 'left')`), '23514');
    assert.equal(await codeOf(`INSERT INTO hr.people (code, name, pay_channel) VALUES ('T-4', 'Test Four', 'NO-SUCH')`), '23503',
      'a pay channel must exist');
    assert.equal(await codeOf(`INSERT INTO hr.people (code, name, joined_on, exited_on) VALUES ('T-5', 'Test Five', '2026-07-10', '2026-07-01')`), '23514');
    assert.equal(await codeOf(`INSERT INTO hr.access (user_id, level) VALUES (999999, 'owner')`), '23514');
  });

  // ── Access ───────────────────────────────────────────────────────────

  test('bootstrap: nobody without the MD login; the MD login, in any case, becomes HR admin once', async () => {
    assert.deepEqual(await db.q('SELECT * FROM hr.access'), [], 'no users at all: nobody has HR access');
    await db.q(`INSERT INTO users (name, email, password_hash, role) VALUES ('Plant', 'plant@test.local', 'x', 'admin')`);
    await replay();
    assert.deepEqual(await db.q('SELECT * FROM hr.access'), [], 'an ERP admin is not an HR admin');

    const md = (await db.one(
      `INSERT INTO users (name, email, password_hash, role) VALUES ('MD', 'MD@MotionCI.com', 'x', 'admin') RETURNING id`)).id;
    await replay();
    await replay();
    assert.deepEqual(await db.q('SELECT user_id, level, granted_by, note FROM hr.access'),
      [{ user_id: md, level: 'admin', granted_by: md, note: 'bootstrap' }]);

    await db.q(`UPDATE hr.access SET level = 'viewer' WHERE user_id = $1`, [md]);
    await replay();
    assert.equal((await db.one('SELECT level FROM hr.access WHERE user_id = $1', [md])).level, 'viewer',
      'a level set since is never put back');
    await db.q(`UPDATE hr.access SET level = 'admin' WHERE user_id = $1`, [md]);
  });

  test('hrGuard reads hr.access fresh, once per request, for a switched-on login only', async () => {
    const login = async (name, email, active = 1) => (await db.one(
      `INSERT INTO users (name, email, password_hash, role, active) VALUES ($1, $2, 'x', 'admin', $3) RETURNING id`,
      [name, email, active])).id;
    const op = await login('Synthetic Op', 'hr-op@test.local');
    const none = await login('No Access', 'hr-none@test.local');
    const off = await login('Switched Off', 'hr-off@test.local', 0);
    await db.q(`INSERT INTO hr.access (user_id, level, granted_by, note) VALUES ($1, 'operator', $1, 'test'), ($2, 'approver', $2, 'test')`,
      [op, off]);

    const guard = req => new Promise((resolve, reject) => {
      const res = {
        statusCode: 0, body: null,
        status(c) { this.statusCode = c; return this; },
        json(b) { this.body = b; resolve({ passed: false, res: this }); return this; },
      };
      access.hrGuard(req, res, err => (err ? reject(err) : resolve({ passed: true, res })));
    });
    const NO_ACCESS = { error: 'You do not have access to HR & Payroll', code: 'HR_NO_ACCESS' };

    const realQuery = pool.query;
    let reads = 0;
    pool.query = function counted(text, ...rest) {
      if (/\bhr\.access\b/.test(typeof text === 'string' ? text : text?.text ?? '')) reads++;
      return realQuery.call(this, text, ...rest);
    };
    try {
      const req = { user: { id: op, name: 'Synthetic Op', role: 'admin' } };
      for (let i = 0; i < 3; i++) assert.equal((await guard(req)).passed, true);
      assert.deepEqual(req.hr, { level: 'operator' });
      assert.equal(reads, 1, 'three routers, one read');

      for (const id of [none, off, 987654]) {
        const { passed, res } = await guard({ user: { id, name: 'x', role: 'admin' } });
        assert.equal(passed, false, `user ${id}`);
        assert.equal(res.statusCode, 403);
        assert.deepEqual(res.body, NO_ACCESS);
      }

      // A change takes effect on the very next request — nothing is cached.
      await db.q(`UPDATE hr.access SET level = 'viewer' WHERE user_id = $1`, [op]);
      const next = { user: { id: op } };
      assert.equal((await guard(next)).passed, true);
      assert.equal(next.hr.level, 'viewer');
      await db.q('DELETE FROM hr.access WHERE user_id = $1', [op]);
      assert.equal((await guard({ user: { id: op } })).passed, false, 'revoked: refused at once');
    } finally {
      pool.query = realQuery;
    }
  });

  test('a plant TRUNCATE … CASCADE never reaches hr; a vanished login has no HR access', async () => {
    const md = (await db.one(`SELECT id FROM users WHERE lower(email) = 'md@motionci.com'`)).id;
    assert.equal(await access.hrAccessFor(md), 'admin');
    const counts = () => db.q(`
      SELECT (SELECT count(*)::int FROM hr.people) AS people, (SELECT count(*)::int FROM hr.access) AS access,
             (SELECT count(*)::int FROM hr.audit_log) AS audit`);
    const before = await counts();
    await db.q('TRUNCATE users RESTART IDENTITY CASCADE');
    assert.deepEqual(await counts(), before, 'no foreign key carried the TRUNCATE into hr');
    assert.equal(await access.hrAccessFor(md), null, 'the hr.access row stays, but no login stands behind it');
  });
});
