// HR payroll routes (routes/hr-payroll.js: the monthly import, the run's lifecycle, payments, payslips, variance)
// through the REAL app over HTTP, against a real Postgres.
//
// Boots its OWN throwaway Postgres in a temp dir on a free port, with PG_POOL_MAX=1 (the Vercel geometry: a pool
// call inside a transaction would hang, and each test has a timeout so a hang fails), runs init() (which replays the
// hr migration) and mounts the real app on a free port. The sheets are built in the test with exceljs. The tests
// share one story and run in order: August 2026 is imported, corrected, submitted, sent back, approved, finalised and
// paid. Every name, code and figure is synthetic.
//
//   HR_PG=1 node --test src/hr-payroll-routes-pg.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const ENABLED = process.env.HR_PG === '1';
const T = { timeout: 60_000 };
const MONTH = '2026-08';

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.unref();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

const HEADERS = ['NAME', 'CODE NO', 'OT', 'AB', 'MISC', 'ADVANCE', 'REMARKS'];

async function sheet(rows) {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('New data');
  ws.addRow(HEADERS);
  for (const row of rows) ws.addRow(row);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('HR payroll routes through the real app', {
  skip: ENABLED ? false : 'set HR_PG=1 to boot a throwaway Postgres',
}, () => {
  let epg, dir, db, pool, server, base;
  const ids = {};
  const tokens = {};
  let A, B, G, E, loanA, batch1, batch2, leftover;

  before(async () => {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-payroll-routes-'));
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

    const { default: jwt } = await import('jsonwebtoken');
    const { JWT_SECRET } = await import('./auth.js');
    const login = async (key, name, level) => {
      const u = await db.one(
        `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, 'x', 'viewer') RETURNING id, name, role`,
        [name, `${key}@test.local`]);
      ids[key] = u.id;
      tokens[key] = jwt.sign({ id: u.id, name: u.name, role: u.role }, JWT_SECRET);
      if (level) await db.q(`INSERT INTO hr.access (user_id, level, granted_by) VALUES ($1, $2, $1)`, [u.id, level]);
    };
    await login('viewer', 'Test Viewer', 'viewer');
    await login('operator', 'Test Operator', 'operator');
    await login('approver', 'Test Approver', 'approver');

    // A: monthly 31000 (1000 a day in August), OT at 8 h a day, an opening loan of 6000 at 2000 a month.
    // B: daily 900. G: left in July, still on file.
    await db.q(`INSERT INTO hr.pay_channels (code, label, kind) VALUES ('TCASH', 'Test cash', 'cash')`);
    A = (await db.one(`INSERT INTO hr.people (code, name, pay_channel) VALUES ('T-201', 'Test Person Alpha', 'TCASH') RETURNING id`)).id;
    B = (await db.one(`INSERT INTO hr.people (code, name, pay_channel) VALUES ('T-202', 'Test Person Beta', 'TCASH') RETURNING id`)).id;
    G = (await db.one(`INSERT INTO hr.people (code, name, pay_channel, status, exited_on)
                       VALUES ('T-203', 'Test Person Gamma', 'TCASH', 'exited', '2026-07-20') RETURNING id`)).id;
    await db.q(`INSERT INTO hr.pay_setups (person_id, effective_from, pay_basis, base, ot_hours_per_day) VALUES ($1, '2026-04-01', 'monthly', 31000, 8)`, [A]);
    await db.q(`INSERT INTO hr.pay_setups (person_id, effective_from, pay_basis, base) VALUES ($1, '2026-04-01', 'daily', 900)`, [B]);
    await db.q(`INSERT INTO hr.pay_setups (person_id, effective_from, pay_basis, base) VALUES ($1, '2026-04-01', 'monthly', 20000)`, [G]);
    loanA = (await db.one(`INSERT INTO hr.loans (loan_no, person_id, principal, issued_on, instalment, first_due_month, is_opening)
                           VALUES ('CI-LN-0001', $1, 6000, '2026-07-31', 2000, '2026-08', true) RETURNING id`, [A])).id;
    await db.q(`INSERT INTO hr.loan_txns (loan_id, txn_date, kind, principal_amount) VALUES ($1, '2026-07-31', 'opening', 6000)`, [loanA]);

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

  // ── Helpers ──
  const parse = async (res) => {
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, text };
  };
  const call = async (who, method, url, body) => parse(await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const uploadAs = async (who, buf, month = MONTH) => {
    const fd = new FormData();
    fd.append('file', new Blob([buf]), 'august.xlsx');
    fd.append('month', month);
    return parse(await fetch(`${base}/hr/imports`, { method: 'POST', headers: { authorization: `Bearer ${tokens[who]}` }, body: fd }));
  };
  const refused = (res, status, code) => {
    assert.equal(res.status, status, res.text);
    assert.equal(res.body?.code, code, res.text);
    assert.ok(typeof res.body?.error === 'string' && res.body.error.length > 0, res.text);
  };
  const runRow = () => db.one(`SELECT * FROM hr.runs WHERE month = $1`, [MONTH]);
  const inputOf = (personId) => db.one(
    `SELECT i.ot_hours::text AS ot_hours, i.source FROM hr.run_inputs i JOIN hr.runs r ON r.id = i.run_id
      WHERE r.month = $1 AND i.person_id = $2`, [MONTH, personId]);
  const lineOf = (personId) => db.one(
    `SELECT l.gross::text AS gross, l.payable::text AS payable, l.payment_status FROM hr.run_lines l
       JOIN hr.runs r ON r.id = l.run_id WHERE r.month = $1 AND l.person_id = $2`, [MONTH, personId]);
  const ledgerCounts = async () => ({
    advance: (await db.one(`SELECT count(*)::int AS n FROM hr.advance_txns`)).n,
    loan: (await db.one(`SELECT count(*)::int AS n FROM hr.loan_txns`)).n,
  });
  const rowOf = (payload, code) => payload.rows.find((r) => r.fields.code === code);
  // Per-person payment approval (approver), needed before a line can be marked paid.
  const approveLines = async (month, personIds, reason) => {
    const res = await call('approver', 'POST', `/hr/runs/${month}/lines/approval`,
      { person_ids: personIds, action: 'approve', ...(reason ? { reason } : {}) });
    assert.equal(res.status, 200, res.text);
    return res;
  };

  // ── The import ──

  test('a viewer can neither upload nor write to a run', T, async () => {
    refused(await uploadAs('viewer', await sheet([['Test Person Alpha', 'T-201', 4, 1]])), 403, 'HR_LEVEL');
    refused(await call('viewer', 'POST', `/hr/runs/${MONTH}/recalc`, {}), 403, 'HR_LEVEL');
    refused(await call('viewer', 'PUT', `/hr/runs/${MONTH}/inputs/${A}`, { ot_hours: 1, reason: 'x' }), 403, 'HR_LEVEL');
    assert.equal((await db.one(`SELECT count(*)::int AS n FROM hr.import_batches`)).n, 0);
  });

  test('a GET for a month with no run answers run: null and creates nothing', T, async () => {
    const res = await call('viewer', 'GET', `/hr/runs/${MONTH}`);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.run, null);
    assert.deepEqual(res.body.missing.map((p) => p.person_id).sort(), [A, B].sort());
    assert.equal(await runRow(), null);
  });

  test('import → apply → lines', T, async () => {
    const up = await uploadAs('operator', await sheet([
      ['Test Person Alpha', 'T-201', 4, 1],
      ['Test Person Beta', 'T-202', null, 2],
    ]));
    assert.equal(up.status, 200, up.text);
    batch1 = up.body.batch.id;
    assert.equal(up.body.rows.length, 2);
    assert.ok(up.body.rows.every((r) => r.match === 'code' && r.person_id));
    assert.deepEqual(up.body.missing, [], 'G has left, so is not missing');
    assert.deepEqual(up.body.duplicates, []);
    assert.ok(up.body.batch.headers.some((h) => h.text === 'OT' && h.field === 'ot_hours'));
    assert.equal(await runRow(), null, 'an upload creates no run');

    const applied = await call('operator', 'POST', `/hr/imports/${batch1}/apply`, {});
    assert.equal(applied.status, 200, applied.text);
    assert.equal(applied.body.applied, 2);
    assert.equal(applied.body.run.status, 'draft');
    const run = await call('viewer', 'GET', `/hr/runs/${MONTH}`);
    assert.equal(run.status, 200, run.text);
    assert.equal(run.body.lines.length, 2);
    // A: 1000 × 30 present + 4 h ÷ 8 × 1000; B: 900 × 29 present.
    assert.equal((await lineOf(A)).gross, '30500.00');
    assert.equal((await lineOf(B)).gross, '26100.00');
    assert.equal((await inputOf(A)).source, 'import');
  });

  test('the same file twice is 409 DUPLICATE_FILE with the batch to reopen', T, async () => {
    const res = await uploadAs('operator', await sheet([
      ['Test Person Alpha', 'T-201', 4, 1],
      ['Test Person Beta', 'T-202', null, 2],
    ]));
    refused(res, 409, 'DUPLICATE_FILE');
    assert.equal(res.body.batch_id, batch1);
    assert.ok(res.body.uploaded_at);
  });

  test('a corrected sheet: exited person flagged, a no-name row blocks apply, the map can be redone', T, async () => {
    const up = await uploadAs('operator', await sheet([
      ['Test Person Alpha', 'T-201', 6, 1],
      ['Test Person Beta', 'T-202', null, 2, null, 1500],
      ['Test Person Gamma', 'T-203', 2],
      [null, null, 5],
    ]));
    assert.equal(up.status, 200, up.text);
    batch2 = up.body.batch.id;
    assert.ok(rowOf(up.body, 'T-203').issues.some((i) => i.code === 'PERSON_EXITED' && i.level === 'warn'));
    const noName = up.body.rows.find((r) => r.issues.some((i) => i.code === 'NO_NAME_OR_CODE'));
    assert.ok(noName, 'the no-name row is kept, with its error');

    // One column for two fields is refused; the automatic map saved again is remembered by signature.
    const map = up.body.batch.column_map;
    refused(await call('operator', 'PUT', `/hr/imports/${batch2}/map`, { column_map: { ...map, bonus: map.ot_hours } }), 400, undefined);
    const remapped = await call('operator', 'PUT', `/hr/imports/${batch2}/map`, { column_map: map, blank_as_zero: up.body.batch.blank_zero });
    assert.equal(remapped.status, 200, remapped.text);
    assert.equal(remapped.body.rows.length, 4);
    const maps = await call('viewer', 'GET', '/hr/column-maps');
    assert.equal(maps.status, 200, maps.text);
    assert.equal(maps.body.length, 1);
    assert.equal(maps.body[0].signature, HEADERS.join('|'));

    const rows = remapped.body.rows;
    const blocked = await call('operator', 'POST', `/hr/imports/${batch2}/apply`, {});
    refused(blocked, 409, 'IMPORT_UNRESOLVED');
    assert.ok(blocked.body.rows.includes(rows.find((r) => r.issues.some((i) => i.code === 'NO_NAME_OR_CODE')).row_no));

    for (const row of rows.filter((r) => r.fields.code === 'T-203' || r.issues.some((i) => i.code === 'NO_NAME_OR_CODE'))) {
      const decided = await call('operator', 'PUT', `/hr/imports/${batch2}/rows/${row.id}`, { decision: 'ignore' });
      assert.equal(decided.status, 200, decided.text);
      assert.equal(decided.body.decision, 'ignore');
    }
  });

  test('GET run names who acted, names each line, and carries the month\'s pending upload', T, async () => {
    const res = await call('viewer', 'GET', `/hr/runs/${MONTH}`);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.run.prepared_by_name, 'Test Operator');
    for (const k of ['submitted_by_name', 'approved_by_name', 'finalised_by_name']) assert.ok(k in res.body.run, k);
    const a = res.body.lines.find((l) => l.person_id === A);
    assert.deepEqual([a.name, a.code, 'department' in a], ['Test Person Alpha', 'T-201', true]);
    assert.deepEqual(res.body.pending_import, {
      batch_id: batch2, file_name: 'august.xlsx', uploaded_at: res.body.pending_import.uploaded_at, uploaded_by: ids.operator,
      uploaded_by_name: 'Test Operator', unresolved: 0, parsed_uploads: 1,
    });
    assert.ok(res.body.pending_import.uploaded_at);
  });

  test('discard sets an unused upload aside (audited); it stops being pending and the same file can come again', T, async () => {
    const file = await sheet([['Test Person Alpha', 'T-201', 1, 0], ['Nobody Known Here', null, 1]]);
    const up = await uploadAs('operator', file);
    assert.equal(up.status, 200, up.text);
    const batch3 = up.body.batch.id;
    let run = await call('viewer', 'GET', `/hr/runs/${MONTH}`);
    assert.deepEqual([run.body.pending_import.batch_id, run.body.pending_import.unresolved, run.body.pending_import.parsed_uploads],
      [batch3, 1, 2]);

    refused(await call('viewer', 'POST', `/hr/imports/${batch3}/discard`, {}), 403, 'HR_LEVEL');
    const gone = await call('operator', 'POST', `/hr/imports/${batch3}/discard`, { reason: 'Wrong file' });
    assert.equal(gone.status, 200, gone.text);
    assert.equal(gone.body.batch.status, 'discarded');
    const audit = await db.one(`SELECT detail FROM hr.audit_log WHERE entity = 'import' AND entity_id = $1 AND action = 'discard'`, [String(batch3)]);
    assert.equal(audit.detail.reason, 'Wrong file');
    run = await call('viewer', 'GET', `/hr/runs/${MONTH}`);
    assert.equal(run.body.pending_import.batch_id, batch2, 'the discarded upload is no longer the pending one');
    assert.equal(run.body.pending_import.parsed_uploads, 1);

    const audits = (await db.one(`SELECT count(*)::int AS n FROM hr.audit_log`)).n;
    assert.equal((await call('operator', 'POST', `/hr/imports/${batch3}/discard`, {})).status, 200, 'again: harmless');
    assert.equal((await db.one(`SELECT count(*)::int AS n FROM hr.audit_log`)).n, audits, 'and audits nothing');
    refused(await call('operator', 'POST', `/hr/imports/${batch1}/discard`, {}), 409, 'IMPORT_STATE');
    refused(await call('operator', 'POST', `/hr/imports/${batch3}/apply`, {}), 409, 'IMPORT_STATE');

    const again = await uploadAs('operator', file);
    assert.equal(again.status, 200, again.text);
    assert.notEqual(again.body.batch.id, batch3);
    leftover = again.body.batch.id;                       // left parsed: discarding it after submit is refused below
  });

  test('a manual edit survives a corrected sheet, and overwrite_manual replaces it', T, async () => {
    refused(await call('operator', 'PUT', `/hr/runs/${MONTH}/inputs/${A}`, { ot_hours: 9 }), 400, undefined);
    const edit = await call('operator', 'PUT', `/hr/runs/${MONTH}/inputs/${A}`, { ot_hours: 9, reason: 'Checked against the gate register' });
    assert.equal(edit.status, 200, edit.text);
    assert.equal(edit.body.line.person_id, A);
    assert.equal((await inputOf(A)).source, 'manual');

    const first = await call('operator', 'POST', `/hr/imports/${batch2}/apply`, {});
    assert.equal(first.status, 200, first.text);
    assert.deepEqual(first.body.manual_edits_kept.map((e) => e.person_id), [A]);
    assert.equal(Number((await inputOf(A)).ot_hours), 9, 'the hand edit is kept');
    assert.equal((await db.one(`SELECT status FROM hr.import_batches WHERE id = $1`, [batch1])).status, 'superseded');

    const second = await call('operator', 'POST', `/hr/imports/${batch2}/apply`, { overwrite_manual: [A] });
    assert.equal(second.status, 200, second.text);
    assert.deepEqual(second.body.manual_edits_kept, []);
    const a = await inputOf(A);
    assert.equal(Number(a.ot_hours), 6);
    assert.equal(a.source, 'import');
    assert.equal((await lineOf(A)).gross, '30750.00');
    assert.equal((await lineOf(B)).payable, '24600.00', 'B: 26100 less the 1500 advance');
  });

  // ── The run ──

  let amounts;
  test('submit notifies approvers with no amount in the words; imports are refused after submit', T, async () => {
    const res = await call('operator', 'POST', `/hr/runs/${MONTH}/submit`, {});
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.status, 'submitted');
    const notes = await db.q(`SELECT user_id, kind, title, body, link FROM notifications WHERE kind = 'hr_run_submitted'`);
    assert.deepEqual(notes.map((n) => n.user_id), [ids.approver]);
    assert.equal(notes[0].title, 'Payroll August 2026 submitted for approval');
    assert.equal(notes[0].link, `/hr?tab=payroll&month=${MONTH}`);
    amounts = (await db.q(`SELECT gross::text AS a FROM hr.run_lines UNION SELECT payable::text FROM hr.run_lines
                           UNION SELECT loan_recovery::text FROM hr.run_lines UNION SELECT advance_recovery::text FROM hr.run_lines`))
      .map((x) => x.a.split('.')[0]).filter((x) => x !== '0');
    for (const n of notes) for (const a of amounts) assert.ok(!`${n.title} ${n.body}`.includes(a), `${a} is in a notification`);

    refused(await uploadAs('operator', await sheet([['Test Person Alpha', 'T-201', 7, 0]])), 409, 'RUN_LOCKED');
    refused(await call('operator', 'POST', `/hr/imports/${batch2}/apply`, {}), 409, 'RUN_LOCKED');
  });

  test('an upload of a month that is no longer a draft cannot be discarded (RUN_LOCKED)', T, async () => {
    refused(await call('operator', 'POST', `/hr/imports/${leftover}/discard`, {}), 409, 'RUN_LOCKED');
    assert.equal((await db.one(`SELECT status FROM hr.import_batches WHERE id = $1`, [leftover])).status, 'parsed');
  });

  test('send-back needs a reason and tells the preparer, again without amounts', T, async () => {
    refused(await call('operator', 'POST', `/hr/runs/${MONTH}/send-back`, { reason: 'x' }), 403, 'HR_LEVEL');
    refused(await call('approver', 'POST', `/hr/runs/${MONTH}/send-back`, {}), 400, undefined);
    const res = await call('approver', 'POST', `/hr/runs/${MONTH}/send-back`, { reason: 'Recheck the OT for 30750 rupees' });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.status, 'draft');
    const notes = await db.q(`SELECT user_id, title, body FROM notifications WHERE kind = 'hr_run_sent_back'`);
    assert.deepEqual(notes.map((n) => n.user_id), [ids.operator]);
    for (const n of notes) {
      for (const a of [...amounts, '30750']) assert.ok(!`${n.title} ${n.body}`.includes(a), `${a} is in a notification`);
    }
  });

  test('approving your own submission: 409 SAME_PERSON when strict, a warning otherwise', T, async () => {
    const sub = await call('approver', 'POST', `/hr/runs/${MONTH}/submit`, {});
    assert.equal(sub.status, 200, sub.text);
    await db.q(`UPDATE hr.settings SET value = 'true' WHERE key = 'strict_separation'`);
    refused(await call('approver', 'POST', `/hr/runs/${MONTH}/approve`, {}), 409, 'SAME_PERSON');
    await db.q(`UPDATE hr.settings SET value = 'false' WHERE key = 'strict_separation'`);
    const ok = await call('approver', 'POST', `/hr/runs/${MONTH}/approve`, {});
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.status, 'approved');
    assert.equal(ok.body.warning, 'approved by the person who submitted');
  });

  test('finalise posts once; payments are separate from finalise', T, async () => {
    refused(await call('operator', 'POST', `/hr/runs/${MONTH}/finalise`, {}), 403, 'HR_LEVEL');
    // Paying is open from submit on (2026-11-06); nobody is approved yet, so the batch has nothing to pay.
    refused(await call('operator', 'POST', `/hr/runs/${MONTH}/payments`, { pay_channel: 'TCASH' }), 409, 'NOTHING_TO_PAY');
    const before = await ledgerCounts();
    const fin = await call('approver', 'POST', `/hr/runs/${MONTH}/finalise`, {});
    assert.equal(fin.status, 200, fin.text);
    assert.equal(fin.body.status, 'finalised');
    const after1 = await ledgerCounts();
    assert.equal(after1.loan - before.loan, 1, 'one instalment for the one loan');
    assert.equal(after1.advance - before.advance, 2, "B's advance given and recovered");
    refused(await call('approver', 'POST', `/hr/runs/${MONTH}/finalise`, {}), 409, 'RUN_STATE');
    assert.deepEqual(await ledgerCounts(), after1, 'a second finalise posts nothing');

    assert.equal((await lineOf(A)).payment_status, 'pending', 'finalised is not paid');
    assert.equal((await lineOf(B)).payment_status, 'pending');
    // Nobody is approved for payment yet, so the batch has nothing to pay and says who is waiting.
    const early = await call('operator', 'POST', `/hr/runs/${MONTH}/payments`, { pay_channel: 'TCASH', reference: 'CASH-AUG' });
    refused(early, 409, 'NOTHING_TO_PAY');
    assert.deepEqual(early.body.unapproved.map((u) => u.person_id).sort((x, y) => x - y), [A, B].sort((x, y) => x - y));
    assert.equal((await db.one(`SELECT count(*)::int AS n FROM hr.payment_batches`)).n, 0, 'a refused batch is never written');
    await approveLines(MONTH, [A, B]);
    const paid = await call('operator', 'POST', `/hr/runs/${MONTH}/payments`, { pay_channel: 'TCASH', reference: 'CASH-AUG' });
    assert.equal(paid.status, 200, paid.text);
    assert.equal(paid.body.count, 2);
    assert.equal(paid.body.batch_no, 'CI-PAY-0001', 'the first payment batch is CI-PAY-0001');
    assert.equal((await lineOf(A)).payment_status, 'paid');
    refused(await call('operator', 'POST', `/hr/runs/${MONTH}/payments`, { pay_channel: 'TCASH' }), 409, 'NOTHING_TO_PAY');
    refused(await call('operator', 'PUT', `/hr/runs/${MONTH}/lines/${A}/payment`, { status: 'reversed' }), 403, 'HR_LEVEL');
    const reversed = await call('approver', 'PUT', `/hr/runs/${MONTH}/lines/${A}/payment`, { status: 'reversed', reference: 'wrong slip' });
    assert.equal(reversed.status, 200, reversed.text);
    assert.equal(reversed.body.payment_status, 'reversed');
  });

  test('payslips carry the letterhead, the loan left after the run and the advance balance', T, async () => {
    const res = await call('viewer', 'GET', `/hr/runs/${MONTH}/payslips?person_ids=${A},${B}&channel=TCASH`);
    assert.equal(res.status, 200, res.text);
    assert.ok(res.body.company.name);
    assert.ok(res.body.company.gstin);
    assert.equal(res.body.slips.length, 2);
    const a = res.body.slips.find((s) => s.person.id === A);
    assert.deepEqual(a.loans.map((l) => [l.loan_no, l.instalment, l.recovered, l.outstanding_after]),
      [['CI-LN-0001', '2000.00', '2000.00', '4000.00']]);
    assert.equal(a.totals.payable, '28750.00');
    const b = res.body.slips.find((s) => s.person.id === B);
    assert.equal(b.advance.balance_after, '0.00');
    const one = await call('viewer', 'GET', `/hr/runs/${MONTH}/payslips?person_ids=${B}`);
    assert.deepEqual(one.body.slips.map((s) => s.person.id), [B]);
  });

  test('variance: no earlier finalised month, so nothing to compare', T, async () => {
    const res = await call('viewer', 'GET', `/hr/runs/${MONTH}/variance`);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.length, 2);
    assert.ok(res.body.every((v) => v.previous_month === null && v.parts === null));
  });

  // ── September: someone leaves during the month; a line with nothing to pay ──

  const SEPT = '2026-09';
  const septLine = (personId) => db.one(
    `SELECT l.payable::text AS payable, l.payment_status, l.paid_amount::text AS paid_amount FROM hr.run_lines l
       JOIN hr.runs r ON r.id = l.run_id WHERE r.month = $1 AND l.person_id = $2`, [SEPT, personId]);

  test('missing and the submit check include a person whose last day falls inside the month', T, async () => {
    E = (await db.one(`INSERT INTO hr.people (code, name, pay_channel, status, exited_on)
                       VALUES ('T-204', 'Test Person Epsilon', 'TCASH', 'exited', '2026-09-12') RETURNING id`)).id;
    await db.q(`INSERT INTO hr.pay_setups (person_id, effective_from, pay_basis, base) VALUES ($1, '2026-04-01', 'monthly', 30000)`, [E]);
    const empty = await call('viewer', 'GET', `/hr/runs/${SEPT}`);
    assert.equal(empty.status, 200, empty.text);
    assert.deepEqual(empty.body.missing.map((p) => p.person_id).sort((x, y) => x - y), [A, B, E].sort((x, y) => x - y),
      'E left on 12 September, so September still owes them; G left in July and does not');

    const typed = await call('operator', 'PUT', `/hr/runs/${SEPT}/inputs/${A}`, { ot_hours: 0, reason: 'Test: start the month' });
    assert.equal(typed.status, 200, typed.text);
    const sub = await call('operator', 'POST', `/hr/runs/${SEPT}/submit`, {});
    refused(sub, 409, 'RUN_BLOCKED');
    assert.ok(sub.body.missing.includes(E), sub.text);

    const up = await uploadAs('operator', await sheet([['Test Person Alpha', 'T-201', 0, 0], ['Test Person Beta', 'T-202', null, 0]]), SEPT);
    assert.equal(up.status, 200, up.text);
    assert.deepEqual(up.body.missing.map((p) => p.person_id), [E]);
    assert.equal(up.body.missing[0].exited_on, '2026-09-12');
    const blocked = await call('operator', 'POST', `/hr/imports/${up.body.batch.id}/apply`, { overwrite_manual: [A] });
    refused(blocked, 409, 'IMPORT_UNRESOLVED');
    assert.deepEqual(blocked.body.missing, [E]);

    // B owes far more advance than a month's pay, so the line is capped at nothing to pay.
    await db.q(`INSERT INTO hr.advance_txns (person_id, txn_date, kind, amount, source) VALUES ($1, '2026-08-31', 'opening', 500000, 'test')`, [B]);
    const applied = await call('operator', 'POST', `/hr/imports/${up.body.batch.id}/apply`,
      { missing: [{ person_id: E, choice: 'include' }], overwrite_manual: [A] });
    assert.equal(applied.status, 200, applied.text);
    assert.ok(Number((await septLine(E)).payable) > 0, 'E is paid for the days before leaving');
    assert.equal((await septLine(B)).payable, '0.00');
  });

  test('a payment batch marks a line with nothing to pay as paid at 0.00, so the channel can be closed', T, async () => {
    const sub = await call('operator', 'POST', `/hr/runs/${SEPT}/submit`, {});
    assert.equal(sub.status, 200, sub.text);
    assert.equal((await call('approver', 'POST', `/hr/runs/${SEPT}/approve`, {})).status, 200);
    const fin = await call('approver', 'POST', `/hr/runs/${SEPT}/finalise`, {});
    assert.equal(fin.status, 200, fin.text);
    await approveLines(SEPT, [A, B, E]);
    const paid = await call('operator', 'POST', `/hr/runs/${SEPT}/payments`, { pay_channel: 'TCASH', reference: 'CASH-SEP' });
    assert.equal(paid.status, 200, paid.text);
    assert.equal(paid.body.count, 3);
    assert.equal(paid.body.batch_no, 'CI-PAY-0002');
    assert.deepEqual(paid.body.person_ids.sort((x, y) => x - y), [A, B, E].sort((x, y) => x - y));
    assert.deepEqual(await septLine(B), { payable: '0.00', payment_status: 'paid', paid_amount: '0.00' });
    refused(await call('operator', 'POST', `/hr/runs/${SEPT}/payments`, { pay_channel: 'TCASH' }), 409, 'NOTHING_TO_PAY');
  });

  test('the single-line payment marks a zero-payable line paid at 0.00 too, as the batch does', T, async () => {
    const failed = await call('operator', 'PUT', `/hr/runs/${SEPT}/lines/${B}/payment`, { status: 'failed', reference: 'Test: retry' });
    assert.equal(failed.status, 200, failed.text);
    assert.deepEqual(await septLine(B), { payable: '0.00', payment_status: 'failed', paid_amount: null });
    const paid = await call('operator', 'PUT', `/hr/runs/${SEPT}/lines/${B}/payment`, { status: 'paid', reference: 'CASH-SEP-B' });
    assert.equal(paid.status, 200, paid.text);
    assert.equal(paid.body.payment_status, 'paid');
    assert.deepEqual(await septLine(B), { payable: '0.00', payment_status: 'paid', paid_amount: '0.00' });
  });

  // ── October: paid / unpaid / on hold (POST /hr/runs/:month/lines/status) ──

  const OCT = '2026-10';
  let H;
  const octLine = (personId) => db.one(
    `SELECT l.id, l.payable::text AS payable, l.payment_status, l.paid_amount::text AS paid_amount, l.paid_on::text AS paid_on,
            l.paid_ref, l.payment_batch_id, l.hold_reason, l.held_by, l.held_at, l.status_note
       FROM hr.run_lines l JOIN hr.runs r ON r.id = l.run_id WHERE r.month = $1 AND l.person_id = $2`, [OCT, personId]);
  const setStatus = (who, body) => call(who, 'POST', `/hr/runs/${OCT}/lines/status`, body);
  const cents = (v) => Math.round(Number(v) * 100);
  const addsUp = (t, lines, payable) => {
    assert.equal(t.paid.count + t.unpaid.count + t.on_hold.count, lines, 'every line in one bucket');
    assert.equal(cents(t.paid.amount) + cents(t.unpaid.amount) + cents(t.on_hold.amount), cents(payable), 'the buckets add up to the run');
    for (const [code, ch] of Object.entries(t.by_channel)) {
      for (const b of ['paid', 'unpaid', 'on_hold']) assert.match(ch[b].amount, /^\d+\.\d{2}$/, `${code}.${b}`);
    }
    for (const b of ['paid', 'unpaid', 'on_hold']) {
      assert.equal(Object.values(t.by_channel).reduce((n, ch) => n + ch[b].count, 0), t[b].count, `by_channel ${b} counts`);
      assert.equal(Object.values(t.by_channel).reduce((n, ch) => n + cents(ch[b].amount), 0), cents(t[b].amount), `by_channel ${b} amounts`);
    }
  };

  test('October starts as a draft with a bank-paid person too', T, async () => {
    await db.q(`INSERT INTO hr.pay_channels (code, label, kind) VALUES ('TBANK', 'Test bank', 'bank')`);
    H = (await db.one(`INSERT INTO hr.people (code, name, pay_channel) VALUES ('T-205', 'Test Person Eta', 'TBANK') RETURNING id`)).id;
    await db.q(`INSERT INTO hr.pay_setups (person_id, effective_from, pay_basis, base) VALUES ($1, '2026-04-01', 'monthly', 31000)`, [H]);
    const up = await uploadAs('operator', await sheet([
      ['Test Person Alpha', 'T-201', 0, 0], ['Test Person Beta', 'T-202', null, 0], ['Test Person Eta', 'T-205', null, 0],
    ]), OCT);
    assert.equal(up.status, 200, up.text);
    const applied = await call('operator', 'POST', `/hr/imports/${up.body.batch.id}/apply`, {});
    assert.equal(applied.status, 200, applied.text);
    assert.equal(applied.body.run.status, 'draft');
    assert.equal((await octLine(H)).payable, '31000.00');
  });

  test('a hold needs a reason; a viewer cannot set a status; bad bodies are 400', T, async () => {
    refused(await setStatus('operator', { person_ids: [A], status: 'on_hold' }), 400, undefined);
    refused(await setStatus('operator', { person_ids: [A], status: 'on_hold', reason: '   ' }), 400, undefined);
    refused(await setStatus('viewer', { person_ids: [A], status: 'on_hold', reason: 'x' }), 403, 'HR_LEVEL');
    refused(await setStatus('operator', { person_ids: [], status: 'on_hold', reason: 'x' }), 400, undefined);
    refused(await setStatus('operator', { person_ids: [A], status: 'refunded' }), 400, undefined);
    assert.equal((await octLine(A)).payment_status, 'pending');
  });

  test('a hold is allowed on a draft run, survives a recalculation; the same reason again is unchanged, a new reason re-holds', T, async () => {
    const res = await setStatus('operator', { person_ids: [A], status: 'on_hold', reason: 'Test: bank details being checked' });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body.changed, [A]);
    assert.deepEqual(res.body.unchanged, []);
    assert.deepEqual(res.body.skipped, []);
    const a = await octLine(A);
    assert.deepEqual([a.payment_status, a.hold_reason, a.held_by], ['on_hold', 'Test: bank details being checked', ids.operator]);
    assert.ok(a.held_at);
    const audit = await db.one(`SELECT detail FROM hr.audit_log WHERE entity = 'run_line' AND entity_id = $1 AND action = 'payment_status'`, [String(a.id)]);
    assert.deepEqual([audit.detail.from, audit.detail.to, audit.detail.reason], ['pending', 'on_hold', 'Test: bank details being checked']);

    assert.equal((await call('operator', 'POST', `/hr/runs/${OCT}/recalc`, {})).status, 200);
    assert.equal((await octLine(A)).payment_status, 'on_hold', 'a recalculation never touches the payment columns');

    const audits = async () => (await db.one(
      `SELECT count(*)::int AS n FROM hr.audit_log WHERE entity = 'run_line' AND action = 'payment_status'`)).n;
    const before = await audits();
    const again = await setStatus('operator', { person_ids: [A], status: 'on_hold', reason: 'Test: bank details being checked' });
    assert.equal(again.status, 200, again.text);
    assert.deepEqual([again.body.changed, again.body.unchanged], [[], [A]], 'the same reason: unchanged');
    assert.equal(await audits(), before, 'and nothing audited');
    assert.equal((await octLine(A)).held_at.getTime(), a.held_at.getTime(), 'unchanged means untouched');

    // A different reason re-holds the line: new reason, who and when; the old reason is in the audit row.
    const rehold = await setStatus('approver', { person_ids: [A], status: 'on_hold', reason: 'Test: waiting for a signed form' });
    assert.equal(rehold.status, 200, rehold.text);
    assert.deepEqual([rehold.body.changed, rehold.body.unchanged], [[A], []]);
    const a2 = await octLine(A);
    assert.deepEqual([a2.payment_status, a2.hold_reason, a2.held_by], ['on_hold', 'Test: waiting for a signed form', ids.approver]);
    assert.ok(a2.held_at.getTime() >= a.held_at.getTime());
    const last = await db.one(
      `SELECT detail FROM hr.audit_log WHERE entity = 'run_line' AND entity_id = $1 AND action = 'payment_status' ORDER BY id DESC LIMIT 1`,
      [String(a.id)]);
    assert.deepEqual([last.detail.from, last.detail.to, last.detail.reason, last.detail.was_hold_reason],
      ['on_hold', 'on_hold', 'Test: waiting for a signed form', 'Test: bank details being checked']);
    // Back to the first reason, so the rest of the story reads the same.
    const back = await setStatus('operator', { person_ids: [A], status: 'on_hold', reason: 'Test: bank details being checked' });
    assert.deepEqual(back.body.changed, [A]);

    const run = await call('viewer', 'GET', `/hr/runs/${OCT}`);
    assert.equal(run.status, 200, run.text);
    const line = run.body.lines.find((l) => l.person_id === A);
    assert.deepEqual([line.payment_status, line.hold_reason, line.held_by_name], ['on_hold', 'Test: bank details being checked', 'Test Operator']);
    assert.equal(run.body.payment_totals.on_hold.count, 1);
    assert.equal(run.body.payment_totals.paid.count, 0);
    addsUp(run.body.payment_totals, run.body.lines.length, run.body.run.totals.payable);
  });

  test('paid is refused on a DRAFT run (409 RUN_NOT_FINAL), and nothing changes', T, async () => {
    const res = await setStatus('operator', { person_ids: [B, H], status: 'paid', reference: 'TOO-SOON' });
    refused(res, 409, 'RUN_NOT_FINAL');
    assert.match(res.body.error, /submitted/);
    assert.equal((await octLine(H)).payment_status, 'pending');
    assert.equal((await db.one(`SELECT count(*)::int AS n FROM hr.payment_batches WHERE reference = 'TOO-SOON'`)).n, 0);
  });

  test('a channel batch skips a held line and reports it', T, async () => {
    assert.equal((await call('operator', 'POST', `/hr/runs/${OCT}/submit`, {})).status, 200);
    assert.equal((await call('approver', 'POST', `/hr/runs/${OCT}/approve`, {})).status, 200);
    const fin = await call('approver', 'POST', `/hr/runs/${OCT}/finalise`, {});
    assert.equal(fin.status, 200, fin.text);
    assert.equal((await octLine(A)).payment_status, 'on_hold', 'finalising keeps the hold');
    // A held line can be approved; the hold still stops the money.
    const ok = await approveLines(OCT, [A, B, H]);
    assert.deepEqual(ok.body.on_hold, [A]);

    const paid = await call('operator', 'POST', `/hr/runs/${OCT}/payments`, { pay_channel: 'TCASH', reference: 'CASH-OCT' });
    assert.equal(paid.status, 200, paid.text);
    assert.deepEqual(paid.body.person_ids, [B]);
    assert.equal(paid.body.count, 1);
    assert.deepEqual(paid.body.held, [{ person_id: A, reason: 'Test: bank details being checked' }]);
    assert.equal((await octLine(A)).payment_status, 'on_hold');
    const again = await call('operator', 'POST', `/hr/runs/${OCT}/payments`, { pay_channel: 'TCASH' });
    refused(again, 409, 'NOTHING_TO_PAY');
    assert.deepEqual(again.body.held.map((h) => h.person_id), [A]);
    // The single-line route treats a held line as not payable too.
    refused(await call('operator', 'PUT', `/hr/runs/${OCT}/lines/${A}/payment`, { status: 'paid' }), 409, 'PAYMENT_STATE');
  });

  test('bulk paid after finalise: paid_amount = payable, one batch per channel; unchanged and skipped are reported', T, async () => {
    // Paying a held line is skipped, not refused.
    const held = await setStatus('operator', { person_ids: [A], status: 'paid' });
    assert.equal(held.status, 200, held.text);
    assert.deepEqual(held.body.changed, []);
    assert.deepEqual(held.body.skipped.map((x) => x.person_id), [A]);
    assert.match(held.body.skipped[0].reason, /hold/i);

    const release = await setStatus('operator', { person_ids: [A], status: 'pending' });
    assert.equal(release.status, 200, release.text);
    assert.deepEqual(release.body.changed, [A]);
    const a0 = await octLine(A);
    assert.deepEqual([a0.payment_status, a0.hold_reason, a0.held_by, a0.held_at], ['pending', null, null, null]);

    const res = await setStatus('operator', { person_ids: [A, B, H, G], status: 'paid', reference: 'BULK-OCT', paid_on: '2026-10-16' });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body.changed, [A, H].sort((x, y) => x - y));
    assert.deepEqual(res.body.unchanged, [B]);
    assert.deepEqual(res.body.skipped.map((x) => x.person_id), [G], 'G has no October line');
    assert.deepEqual(res.body.batches.map((b) => [b.pay_channel, b.count, b.batch_no]),
      [['TBANK', 1, 'CI-PAY-0004'], ['TCASH', 1, 'CI-PAY-0005']], 'one numbered batch per channel, in sequence');
    for (const id of [A, H]) {
      const l = await octLine(id);
      assert.deepEqual([l.payment_status, l.paid_amount, l.paid_on, l.paid_ref], ['paid', l.payable, '2026-10-16', 'BULK-OCT']);
      assert.ok(l.payment_batch_id);
    }
    const batches = await db.q(
      `SELECT b.pay_channel, b.count, b.total::text AS total, b.reference, b.paid_on::text AS paid_on FROM hr.payment_batches b
         JOIN hr.runs r ON r.id = b.run_id WHERE r.month = $1 AND b.reference = 'BULK-OCT' ORDER BY b.pay_channel`, [OCT]);
    assert.deepEqual(batches, [
      { pay_channel: 'TBANK', count: 1, total: '31000.00', reference: 'BULK-OCT', paid_on: '2026-10-16' },
      { pay_channel: 'TCASH', count: 1, total: (await octLine(A)).payable, reference: 'BULK-OCT', paid_on: '2026-10-16' },
    ]);
    refused(await setStatus('operator', { person_ids: [A], status: 'paid', paid_on: '2999-01-01' }), 400, undefined);
    // A paid line cannot be put on hold without being marked unpaid first: skipped, with the reason.
    const hold = await setStatus('operator', { person_ids: [H], status: 'on_hold', reason: 'Test: late query' });
    assert.equal(hold.status, 200, hold.text);
    assert.deepEqual(hold.body.skipped.map((x) => x.person_id), [H]);
    assert.equal((await octLine(H)).payment_status, 'paid');
  });

  test('unpaid of a paid line: an operator gets 403, an approver needs a reason and clears the payment (audited)', T, async () => {
    const before = await octLine(H);
    refused(await setStatus('operator', { person_ids: [H], status: 'pending', reason: 'Test: bounced' }), 403, 'HR_LEVEL');
    assert.deepEqual(await octLine(H), before, 'nothing changed');
    refused(await setStatus('approver', { person_ids: [H], status: 'pending' }), 400, undefined);
    assert.equal((await octLine(H)).payment_status, 'paid');

    const res = await setStatus('approver', { person_ids: [H], status: 'pending', reason: 'Test: transfer bounced' });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body.changed, [H]);
    const h = await octLine(H);
    assert.deepEqual([h.payment_status, h.paid_amount, h.paid_on, h.paid_ref, h.payment_batch_id, h.status_note],
      ['pending', null, null, null, null, 'Test: transfer bounced']);
    const audit = await db.one(
      `SELECT detail FROM hr.audit_log WHERE entity = 'run_line' AND entity_id = $1 AND action = 'payment_status'
        ORDER BY id DESC LIMIT 1`, [String(h.id)]);
    assert.deepEqual([audit.detail.from, audit.detail.to, audit.detail.reason], ['paid', 'pending', 'Test: transfer bounced']);
    assert.deepEqual(audit.detail.was, {
      paid_amount: before.paid_amount, paid_on: before.paid_on, paid_ref: before.paid_ref, payment_batch_id: before.payment_batch_id,
    });
  });

  test('payment_totals add up after paying, and payslips carry each slip\'s payment status', T, async () => {
    const hold = await setStatus('operator', { person_ids: [H], status: 'on_hold', reason: 'Test: waiting for new account' });
    assert.deepEqual(hold.body.changed, [H]);
    const run = await call('viewer', 'GET', `/hr/runs/${OCT}`);
    assert.equal(run.status, 200, run.text);
    const t = run.body.payment_totals;
    assert.deepEqual([t.paid.count, t.unpaid.count, t.on_hold.count], [2, 0, 1]);
    assert.equal(t.on_hold.amount, '31000.00');
    assert.deepEqual(t.by_channel.TBANK.on_hold, { count: 1, amount: '31000.00' });
    assert.equal(t.by_channel.TCASH.paid.count, 2);
    addsUp(t, run.body.lines.length, run.body.run.totals.payable);

    const slips = await call('viewer', 'GET', `/hr/runs/${OCT}/payslips?person_ids=${A},${H}`);
    assert.equal(slips.status, 200, slips.text);
    const byId = new Map(slips.body.slips.map((x) => [x.person.id, x.payment]));
    assert.deepEqual([byId.get(A).status, byId.get(A).paid_on, byId.get(A).reference], ['paid', '2026-10-16', 'BULK-OCT']);
    assert.equal(byId.get(H).status, 'on_hold');
    const dash = await call('viewer', 'GET', `/hr/dashboard?month=${OCT}`);
    assert.equal(dash.status, 200, dash.text);
    assert.deepEqual([dash.body.payments.paid_lines, dash.body.payments.on_hold_lines, dash.body.payments.on_hold_amount],
      [2, 1, '31000.00']);
  });

  // ── November: per-person payment approval (POST /hr/runs/:month/lines/approval) ──

  const NOV = '2026-11';
  const novLine = (personId) => db.one(
    `SELECT l.id, l.payable::text AS payable, l.payment_status, l.approval_status, l.approved_by, l.approved_at, l.approval_note,
            l.payment_batch_id
       FROM hr.run_lines l JOIN hr.runs r ON r.id = l.run_id WHERE r.month = $1 AND l.person_id = $2`, [NOV, personId]);
  const approval = (who, body) => call(who, 'POST', `/hr/runs/${NOV}/lines/approval`, body);
  const novStatus = (who, body) => call(who, 'POST', `/hr/runs/${NOV}/lines/status`, body);
  const lineAudits = async (personId, actions) => db.q(
    `SELECT action, user_id, detail FROM hr.audit_log
      WHERE entity = 'run_line' AND entity_id = $1 AND action = ANY($2::text[]) ORDER BY id`,
    [String((await novLine(personId)).id), actions]);

  test('approval is refused on a draft run (409 RUN_NOT_APPROVED), allowed once submitted; an operator cannot approve at all', T, async () => {
    const up = await uploadAs('operator', await sheet([
      ['Test Person Alpha', 'T-201', 0, 0], ['Test Person Beta', 'T-202', null, 0], ['Test Person Eta', 'T-205', null, 0],
    ]), NOV);
    assert.equal(up.status, 200, up.text);
    assert.equal((await call('operator', 'POST', `/hr/imports/${up.body.batch.id}/apply`, {})).status, 200);
    const draft = await approval('approver', { person_ids: [A], action: 'approve' });
    refused(draft, 409, 'RUN_NOT_APPROVED');
    assert.match(draft.body.error, /submit it first/);
    refused(await approval('operator', { person_ids: [A], action: 'approve' }), 403, 'HR_LEVEL');
    refused(await approval('viewer', { person_ids: [A], action: 'approve' }), 403, 'HR_LEVEL');
    refused(await approval('approver', { person_ids: [A], action: 'sign' }), 400, undefined);
    refused(await approval('approver', { person_ids: [], action: 'approve' }), 400, undefined);
    assert.equal((await novLine(A)).approval_status, 'unapproved', 'a new line starts unapproved');

    assert.equal((await call('operator', 'POST', `/hr/runs/${NOV}/submit`, {})).status, 200);
    // Submitted: the amounts are fixed, so a person can be approved while the month waits for its own approval.
    const early = await approval('approver', { person_ids: [A], action: 'approve' });
    assert.equal(early.status, 200, early.text);
    assert.deepEqual(early.body.changed, [A]);
    assert.equal((await novLine(A)).approval_status, 'approved');
    assert.equal((await approval('approver', { person_ids: [A], action: 'unapprove', reason: 'Test: undo' })).status, 200);

    // Submitted: one person's inputs can still be typed again (2026-11-04). Only their line is worked out again, the
    // month stays submitted, and their approval for payment is undone (audited, via input-edit).
    const before = await novLine(A);
    assert.equal((await approval('approver', { person_ids: [A], action: 'approve' })).status, 200);
    const edit = await call('operator', 'PUT', `/hr/runs/${NOV}/inputs/${A}`, { misc_earning: 100, reason: 'Test: late misc' });
    assert.equal(edit.status, 200, edit.text);
    const after = await novLine(A);
    assert.equal(Number(after.payable), Number(before.payable) + 100, 'the line is worked out again');
    assert.deepEqual([after.approval_status, after.approved_by], ['unapproved', null], 'its approval is undone');
    assert.equal((await db.one(`SELECT status FROM hr.runs WHERE month = $1`, [NOV])).status, 'submitted');
    const undone = (await lineAudits(A, ['unapprove'])).at(-1);
    assert.deepEqual([undone.detail.via, undone.detail.reason], ['input-edit', 'Inputs changed after approval: Test: late misc']);
    assert.equal((await call('operator', 'PUT', `/hr/runs/${NOV}/inputs/${A}`, { misc_earning: null, reason: 'Test: back' })).status, 200);
    assert.equal((await novLine(A)).payable, before.payable);

    assert.equal((await call('approver', 'POST', `/hr/runs/${NOV}/approve`, {})).status, 200);
    // Approved (and finalised) months stay locked: a change there needs the month sent back.
    refused(await call('operator', 'PUT', `/hr/runs/${NOV}/inputs/${A}`, { ot_hours: 1, reason: 'late' }), 409, 'RUN_LOCKED');
  });

  test('approve and unapprove on an approved run: audited, unchanged reported, the undo needs a reason', T, async () => {
    const res = await approval('approver', { person_ids: [A, B, G], action: 'approve', reason: 'Test: checked against the register' });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body.changed, [A, B].sort((x, y) => x - y));
    assert.deepEqual(res.body.skipped.map((x) => x.person_id), [G], 'G has no November line');
    const a = await novLine(A);
    assert.deepEqual([a.approval_status, a.approved_by, a.approval_note], ['approved', ids.approver, 'Test: checked against the register']);
    assert.ok(a.approved_at);
    const [, , audit] = await lineAudits(A, ['approve']); // the first two are approvals while the run was submitted
    assert.deepEqual([audit.user_id, audit.detail.from, audit.detail.to, audit.detail.reason, audit.detail.payable],
      [ids.approver, 'unapproved', 'approved', 'Test: checked against the register', a.payable]);

    const again = await approval('approver', { person_ids: [A], action: 'approve' });
    assert.deepEqual([again.body.changed, again.body.unchanged], [[], [A]], 'already approved: unchanged');
    assert.equal((await lineAudits(A, ['approve'])).length, 3, 'and nothing audited');

    refused(await approval('approver', { person_ids: [B], action: 'unapprove' }), 400, undefined);
    refused(await approval('approver', { person_ids: [B], action: 'unapprove', reason: '  ' }), 400, undefined);
    assert.equal((await novLine(B)).approval_status, 'approved');
    const undo = await approval('approver', { person_ids: [B, H], action: 'unapprove', reason: 'Test: attendance query' });
    assert.equal(undo.status, 200, undo.text);
    assert.deepEqual([undo.body.changed, undo.body.unchanged], [[B], [H]]);
    const b = await novLine(B);
    assert.deepEqual([b.approval_status, b.approved_by, b.approved_at, b.approval_note], ['unapproved', null, null, 'Test: attendance query']);
    const [u] = await lineAudits(B, ['unapprove']);
    assert.deepEqual([u.detail.from, u.detail.to, u.detail.reason, u.detail.was.approved_by], ['approved', 'unapproved', 'Test: attendance query', ids.approver]);
  });

  test('sending the run back to draft undoes every line approval (audited); re-approving the run starts afresh', T, async () => {
    await approveLines(NOV, [H]);
    const back = await call('approver', 'POST', `/hr/runs/${NOV}/send-back`, { reason: 'Test: one more look' });
    assert.equal(back.status, 200, back.text);
    for (const id of [A, H]) assert.equal((await novLine(id)).approval_status, 'unapproved', `${id} unapproved by the send-back`);
    const [u] = await lineAudits(H, ['unapprove']);
    assert.deepEqual([u.detail.via, u.detail.reason], ['send-back', 'Run sent back to draft: Test: one more look']);
    assert.equal((await call('operator', 'POST', `/hr/runs/${NOV}/submit`, {})).status, 200);
    assert.equal((await call('approver', 'POST', `/hr/runs/${NOV}/approve`, {})).status, 200);
    await approveLines(NOV, [A, B, H]);
  });

  test('paid needs an approved line on a finalised run; a held line is not paid; batch numbers run on', T, async () => {
    // B on hold (any time, whatever the approval); H's approval undone again.
    assert.deepEqual((await novStatus('operator', { person_ids: [B], status: 'on_hold', reason: 'Test: bank details' })).body.changed, [B]);
    assert.equal((await approval('approver', { person_ids: [H], action: 'unapprove', reason: 'Test: account to confirm' })).status, 200);
    // (Paying before finalise is allowed from 2026-11-06 — see the SUBMITTED-run test below.)
    const fin = await call('approver', 'POST', `/hr/runs/${NOV}/finalise`, {});
    assert.equal(fin.status, 200, fin.text);
    assert.equal((await novLine(A)).approval_status, 'approved', 'finalising keeps the approvals');

    const res = await novStatus('operator', { person_ids: [A, B, H], status: 'paid', reference: 'NOV-PAY' });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body.changed, [A]);
    const why = new Map(res.body.skipped.map((x) => [x.person_id, x.reason]));
    assert.match(why.get(B), /hold/i);
    assert.match(why.get(H), /not approved/i);
    assert.deepEqual(res.body.batches.map((x) => [x.pay_channel, x.batch_no]), [['TCASH', 'CI-PAY-0006']]);
    assert.equal((await novLine(A)).payment_status, 'paid');
    assert.equal((await novLine(H)).payment_status, 'pending');

    // The channel batch and the single-line route refuse an unapproved line too, and a held one.
    const bank = await call('operator', 'POST', `/hr/runs/${NOV}/payments`, { pay_channel: 'TBANK', reference: 'NOV-BANK' });
    refused(bank, 409, 'NOTHING_TO_PAY');
    assert.deepEqual(bank.body.unapproved.map((u) => u.person_id), [H]);
    refused(await call('operator', 'PUT', `/hr/runs/${NOV}/lines/${H}/payment`, { status: 'paid' }), 409, 'NOT_APPROVED');
    refused(await call('operator', 'PUT', `/hr/runs/${NOV}/lines/${B}/payment`, { status: 'paid' }), 409, 'PAYMENT_STATE');
    assert.equal((await db.one(`SELECT count(*)::int AS n FROM hr.payment_batches WHERE reference = 'NOV-BANK'`)).n, 0);

    // Approved after all: now it pays, as the next number.
    await approveLines(NOV, [H]);
    const paid = await call('operator', 'POST', `/hr/runs/${NOV}/payments`, { pay_channel: 'TBANK', reference: 'NOV-BANK' });
    assert.equal(paid.status, 200, paid.text);
    assert.deepEqual([paid.body.person_ids, paid.body.batch_no], [[H], 'CI-PAY-0007']);
    const nos = (await db.q(`SELECT batch_no FROM hr.payment_batches ORDER BY id`)).map((x) => x.batch_no);
    assert.deepEqual(nos, ['CI-PAY-0001', 'CI-PAY-0002', 'CI-PAY-0003', 'CI-PAY-0004', 'CI-PAY-0005', 'CI-PAY-0006', 'CI-PAY-0007']);
  });

  test('undoing the approval of a PAID line is 409 ALREADY_PAID and changes nothing; after mark-unpaid it can be undone', T, async () => {
    const before = await novLine(A);
    const res = await approval('approver', { person_ids: [A, B], action: 'unapprove', reason: 'Test: wrong person' });
    refused(res, 409, 'ALREADY_PAID');
    assert.deepEqual(res.body.person_ids, [A]);
    assert.deepEqual(await novLine(A), before);
    assert.equal((await novLine(B)).approval_status, 'approved', 'nothing in the request changed');

    assert.equal((await novStatus('approver', { person_ids: [A], status: 'pending', reason: 'Test: cash not handed over' })).status, 200);
    const undo = await approval('approver', { person_ids: [A], action: 'unapprove', reason: 'Test: wrong person' });
    assert.deepEqual(undo.body.changed, [A]);
    // Approve and pay A again, so the month closes.
    await approveLines(NOV, [A]);
    assert.deepEqual((await novStatus('operator', { person_ids: [A], status: 'paid', reference: 'NOV-PAY-2' })).body.changed, [A]);
  });

  test('a line\'s history lists every decision with who, when and why', T, async () => {
    const res = await call('viewer', 'GET', `/hr/runs/${NOV}/lines/${A}/history`);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body.map((h) => [h.action, h.to]).slice(4), [ // first four: approved, undone, approved, undone by an input edit while submitted
      ['approve', 'approved'], ['unapprove', 'unapproved'], ['approve', 'approved'], ['payment_status', 'paid'],
      ['payment_status', 'pending'], ['unapprove', 'unapproved'], ['approve', 'approved'], ['payment_status', 'paid'],
    ]);
    assert.deepEqual(res.body.slice(0, 4).map((h) => [h.action, h.reason]), [['approve', null], ['unapprove', 'Test: undo'],
      ['approve', null], ['unapprove', 'Inputs changed after approval: Test: late misc']]);
    const first = res.body[4];
    assert.equal(first.by, 'Test Approver');
    assert.ok(first.at);
    assert.equal(first.reason, 'Test: checked against the register');
    assert.equal(res.body[7].batch_no, 'CI-PAY-0006');
    assert.equal(res.body[7].reference, 'NOV-PAY');
    assert.equal(res.body[8].reason, 'Test: cash not handed over');

    const h = await call('viewer', 'GET', `/hr/runs/${NOV}/lines/${H}/history`);
    assert.equal(h.status, 200, h.text);
    const last = h.body[h.body.length - 1];
    assert.deepEqual([last.action, last.to, last.batch_no, last.reference, last.pay_channel], ['batch', 'paid', 'CI-PAY-0007', 'NOV-BANK', 'TBANK']);
    refused(await call('viewer', 'GET', `/hr/runs/${NOV}/lines/${G}/history`), 404, undefined);
  });

  test('payment_totals reconcile: approved = paid + approved-unpaid + approved-held; the lines carry who approved and the batch', T, async () => {
    const run = await call('viewer', 'GET', `/hr/runs/${NOV}`);
    assert.equal(run.status, 200, run.text);
    const t = run.body.payment_totals;
    addsUp(t, run.body.lines.length, run.body.run.totals.payable);
    assert.equal(t.approved.count + t.unapproved.count, run.body.lines.length);
    assert.equal(cents(t.approved.amount) + cents(t.unapproved.amount), cents(run.body.run.totals.payable));
    const r = t.reconciliation;
    assert.equal(r.balanced, true);
    assert.equal(r.paid_unapproved.count, 0);
    assert.equal(r.approved.count, r.approved_paid.count + r.approved_unpaid.count + r.approved_on_hold.count);
    assert.equal(cents(r.approved.amount), cents(r.approved_paid.amount) + cents(r.approved_unpaid.amount) + cents(r.approved_on_hold.amount));
    assert.deepEqual([r.approved.count, r.approved_paid.count, r.approved_on_hold.count], [3, 2, 1]);
    assert.equal(r.approved_on_hold.amount, (await novLine(B)).payable);

    const a = run.body.lines.find((l) => l.person_id === A);
    assert.deepEqual([a.approval_status, a.approved_by_name, a.payment_batch_no, a.paid_by_name], ['approved', 'Test Approver', 'CI-PAY-0008', 'Test Operator']);
    const dash = await call('viewer', 'GET', `/hr/dashboard?month=${NOV}`);
    assert.equal(dash.status, 200, dash.text);
    assert.deepEqual([dash.body.payments.approved_lines, dash.body.payments.unapproved_lines, dash.body.payments.approved_on_hold_lines,
      dash.body.payments.reconciled], [3, 0, 1, true]);
  });

  test('the monthly schedule reads every month live and adds up to each run\'s own totals', T, async () => {
    const res = await call('viewer', 'GET', '/hr/reports/monthly');
    assert.equal(res.status, 200, res.text);
    const months = res.body.map((m) => m.month);
    assert.deepEqual(months, [...months].sort().reverse(), 'newest first');
    for (const m of res.body.filter((x) => x.run)) {
      const run = await call('viewer', 'GET', `/hr/runs/${m.month}`);
      const t = run.body.payment_totals;
      assert.equal(m.run.people, run.body.lines.length, `${m.month} people`);
      assert.equal(cents(m.run.payable), cents(run.body.run.totals.payable), `${m.month} payable`);
      assert.equal(m.run.paid.count, t.paid.count, `${m.month} paid count`);
      assert.equal(cents(m.run.paid.amount), cents(t.paid.amount), `${m.month} paid amount`);
      assert.equal(m.run.on_hold.count, t.on_hold.count, `${m.month} held`);
      assert.equal(cents(m.run.channels.cash.payable) + cents(m.run.channels.bank.payable) + cents(m.run.channels.none.payable),
        cents(m.run.payable), `${m.month} cash + bank + none = payable`);
    }
  });

  test('a SUBMITTED run: an approved line can be marked paid; while paid, send-back and an input edit are refused', T, async () => {
    const DEC = '2026-12';
    const decLine = (personId) => db.one(
      `SELECT l.payable::text AS payable, l.payment_status, l.paid_amount::text AS paid_amount
         FROM hr.run_lines l JOIN hr.runs r ON r.id = l.run_id WHERE r.month = $1 AND l.person_id = $2`, [DEC, personId]);
    const up = await uploadAs('operator', await sheet([
      ['Test Person Alpha', 'T-201', 0, 0], ['Test Person Beta', 'T-202', null, 0], ['Test Person Eta', 'T-205', null, 0],
    ]), DEC);
    assert.equal(up.status, 200, up.text);
    const applied = await call('operator', 'POST', `/hr/imports/${up.body.batch.id}/apply`, {});
    assert.equal(applied.status, 200, applied.text);
    const sub = await call('operator', 'POST', `/hr/runs/${DEC}/submit`, {});
    assert.equal(sub.status, 200, sub.text);
    await approveLines(DEC, [B]);
    const paid = await call('operator', 'POST', `/hr/runs/${DEC}/lines/status`, { person_ids: [B], status: 'paid', reference: 'EARLY-DEC' });
    assert.equal(paid.status, 200, paid.text);
    const line = await decLine(B);
    assert.equal(line.payment_status, 'paid');
    assert.equal(line.paid_amount, line.payable, 'paid the approved payable');
    refused(await call('approver', 'POST', `/hr/runs/${DEC}/send-back`, { reason: 'Test' }), 409, 'RUN_HAS_PAID_LINES');
    refused(await call('operator', 'PUT', `/hr/runs/${DEC}/inputs/${B}`, { absent_days: 3, reason: 'Test' }), 409, 'LINE_PAID');
    assert.equal((await decLine(B)).payable, line.payable, 'the paid amount did not move');
    const back = await call('approver', 'POST', `/hr/runs/${DEC}/lines/status`, { person_ids: [B], status: 'pending', reason: 'Test: paid too early' });
    assert.equal(back.status, 200, back.text);
    assert.equal((await decLine(B)).payment_status, 'pending');
    assert.equal((await call('approver', 'POST', `/hr/runs/${DEC}/send-back`, { reason: 'Test' })).status, 200, 'unpaid again, it can go back');
  });

  test('pending salary: unpaid lines of submitted months over the last N months, per person, months counted', T, async () => {
    const res = await call('viewer', 'GET', '/hr/reports/pending-pay?months=2&to=2026-12');
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.from, '2026-11');
    assert.equal(res.body.to, '2026-12');
    for (const l of res.body.lines) {
      assert.ok(['2026-11', '2026-12'].includes(l.month), 'only the two months asked for');
      assert.notEqual(l.payment_status, 'paid');
      assert.ok(Number(l.payable) > 0);
    }
    assert.ok(!res.body.lines.some((l) => l.month === '2026-12'), 'December went back to draft: its amounts are not fixed, so it is left out');
    const want = await db.one(
      `SELECT count(*)::int AS n, coalesce(sum(l.payable), 0)::text AS total FROM hr.run_lines l JOIN hr.runs r ON r.id = l.run_id
        WHERE r.month BETWEEN '2026-11' AND '2026-12' AND r.status <> 'draft' AND l.payment_status <> 'paid' AND l.payable > 0`);
    assert.equal(res.body.lines.length, want.n, 'every unpaid line of those months, none other');
    assert.equal(Math.round(Number(res.body.total) * 100), Math.round(Number(want.total) * 100));
    for (const p of res.body.people) assert.equal(p.month_count, p.months.length);
    const sum = res.body.people.reduce((t, p) => t + Math.round(Number(p.total) * 100), 0);
    assert.equal(sum, Math.round(Number(res.body.total) * 100), 'the people add up to the total');
    refused(await call('viewer', 'GET', '/hr/reports/pending-pay?months=0'), 400, undefined);
    const every = await call('viewer', 'GET', '/hr/reports/pending-pay?months=all&to=2026-12');
    assert.equal(every.status, 200, every.text);
    assert.equal(every.body.from, null);
    assert.ok(every.body.lines.length >= res.body.lines.length);
  });

  test('every write left its hr.audit_log row, and none went to the plant audit_log', T, async () => {
    const actions = new Set((await db.q(`SELECT entity || ':' || action AS a FROM hr.audit_log`)).map((x) => x.a));
    for (const a of ['import:upload', 'import:map', 'import_row:decide', 'import:apply', 'import:discard', 'run_input:edit', 'run:submit',
      'run:send_back', 'run:approve', 'run:finalise', 'payment_batch:create', 'run_line:payment', 'run_line:payment_status',
      'run_line:approve', 'run_line:unapprove']) {
      assert.ok(actions.has(a), `no audit row for ${a}`);
    }
    const plant = await db.one(`SELECT count(*)::int AS n FROM audit_log WHERE entity ILIKE 'hr%' OR entity IN ('run', 'import')`)
      .catch(() => ({ n: 0 }));
    assert.equal(plant.n, 0);
  });
});
