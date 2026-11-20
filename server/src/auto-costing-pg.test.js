import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { answeredNo, recommend, markEdited, savePayload } from '../../client/src/lib/costingUi.js';
import { startsFresh, costingValueFromEnquiry } from '../../client/src/lib/enquiryUi.js';
import { chargeGrades, customerBoardRate, masterDieOf } from '../../client/src/lib/costingRules.js';

// The enquiry desk costs a filed item by itself (owner, 20 Nov 2026), through the REAL app against a real Postgres:
// the robot files mails through its routes with the AVS robot key, CI Plant costs them as Auto drafts linked to their
// enquiries, "Cost it for me" costs the ticked rows, and two callers never cost one row twice.
// Filing now costs by itself (the robot routes and the poll call autoCostPending before they announce), so a test that
// needs rows left pending files with the desk's switch off, then back on — and calls autoCostPending() itself.
//
// Opt-in: boots its OWN throwaway Postgres in a temp dir on a free port, PG_POOL_MAX=1 (Vercel's geometry — a pool
// call inside a transaction hangs).
//
//   AUTOCOST_PG=1 node --test src/auto-costing-pg.test.js

const ENABLED = process.env.AUTOCOST_PG === '1';
const ROBOT_KEY = 'test-robot-key-0000';

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.unref();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

// Invented customers and rates, not a customer's (public repo): Northwind ₹131/kg, Bluefin ₹107/kg; buying CFBB at ₹95.
const RATES = [{ word: 'northwind', board_rate: 131 }, { word: 'bluefin', board_rate: 107 }];
const BLUEFIN = { customer_name: 'Bluefin Labs', from_email: 'purchase@bluefin-labs.test' };
const NORTHWIND = { customer_name: 'Northwind Pharma', from_email: 'buyer@northwind-pharma.test' };
const ITEM = (name, o = {}) => ({
  product_name: name, size_text: '120 x 40 x 90', style: 'lock', board: 'FBB', gsm: 300, colours: 4, coating: 'UV', quantities: ['10,000', '25k'], ...o,
});

describe('Enquiry auto-costing — through the real app', {
  skip: ENABLED ? false : 'set AUTOCOST_PG=1 to boot a throwaway Postgres',
}, () => {
  let epg, dir, db, server, base, auto, notifyDesk, pollHasWork, soft, clerkId;
  const tokens = {};

  before(async () => {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autocost-pg-'));
    const port = await freePort();
    epg = new EmbeddedPostgres({ databaseDir: dir, port, user: 'postgres', password: 'postgres', persistent: false, onLog: () => {}, onError: () => {} });
    await epg.initialise();
    await epg.start();
    process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
    process.env.PG_POOL_MAX = '1';
    db = await import('./db.js');
    await db.connect();
    await db.init();
    const { seedIfEmpty } = await import('./seed.js');
    await seedIfEmpty();
    // AVS's settings live only on production; here, just the robot key.
    await db.q(`CREATE SCHEMA IF NOT EXISTS avs`);
    await db.q(`CREATE TABLE IF NOT EXISTS avs.settings (key text PRIMARY KEY, value text, note text)`);
    await db.q(`INSERT INTO avs.settings (key, value) VALUES ('robot_key', $1)`, [ROBOT_KEY]);
    await db.q(`INSERT INTO customers (name, segment) VALUES ('Northwind Pharma', 'pharma'), ('Bluefin Labs', 'pharma')`);
    await db.q(`UPDATE costing_settings SET customer_rates = $1 WHERE id = 1`, [JSON.stringify(RATES)]);
    await db.q(`INSERT INTO board_rates (grade, rate_per_kg, active) VALUES ('CFBB', 95, 1)`);
    await db.q(`INSERT INTO materials (name, category, unit, sheet_l, sheet_w, grade, gsm, active) VALUES ('TEST BOARD 23x36', 'board', 'sheets', 23, 36, 'FBB', 300, 1)`);

    const { default: jwt } = await import('jsonwebtoken');
    const { JWT_SECRET: secret } = await import('./auth.js');
    const mk = async (key, role, modules, mgmt = 0) => {
      const u = await db.one(`INSERT INTO users (name, email, password_hash, role, modules, is_management) VALUES ($1, $2, 'x', $3, $4, $5) RETURNING id, name, role`,
        [`Auto ${key}`, `auto-${key}@test.local`, role, modules && JSON.stringify(modules), mgmt]);
      tokens[key] = jwt.sign({ id: u.id, name: u.name, role: u.role }, secret);
    };
    await mk('admin', 'admin', null);
    await mk('clerk', 'planner', ['costing']);
    clerkId = (await db.one(`SELECT id FROM users WHERE email = 'auto-clerk@test.local'`)).id;
    await mk('plain', 'planner', null);
    await mk('md', 'planner', ['costing'], 1);

    const { default: app } = await import('./app.js');
    auto = await import('./auto-costing.js');
    ({ notifyNewEnquiries: notifyDesk, pollHasWork, syncIntakeEnquiriesSoft: soft } = await import('./enquiry-intake.js'));
    server = await new Promise(res => { const s = app.listen(0, () => res(s)); });
    base = `http://127.0.0.1:${server.address().port}/api`;
  });

  after(async () => {
    server?.close();
    try { await (await db?.connect())?.end(); } catch {}
    try { await epg?.stop(); } catch {}
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const call = async (who, method, url, body) => {
    const res = await fetch(base + url, {
      method, headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, body: json };
  };
  const robot = async (method, url, body) => {
    const res = await fetch(base + '/avs/robot' + url, {
      method, headers: { 'content-type': 'application/json', 'x-avs-robot-key': ROBOT_KEY }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  // One mail filed by the robot as a Fetch does it (queue, claim, file, done); its enquiry numbers. By default the desk's
  // "cost by itself" switch is off while it is filed, so the rows stay pending for the test's own autoCostPending();
  // { cost: true } files it as it really is filed: costed, then announced. { unannounced: true } puts the mail back
  // to "nobody told yet", for the tests of the alert's wait.
  let mails = 0;
  const fileMail = async (who, items, { cost = false, unannounced = false } = {}) => {
    const was = (await db.one('SELECT auto_cost FROM enquiry_settings WHERE id = 1')).auto_cost;
    await db.q('UPDATE enquiry_settings SET auto_cost = $1 WHERE id = 1', [cost ? true : false]);
    try { return await fileMailNow(who, items, unannounced); } finally {
      await db.q('UPDATE enquiry_settings SET auto_cost = $1 WHERE id = 1', [was]);
    }
  };
  const fileMailNow = async (who, items, unannounced) => {
    const f = await call('clerk', 'POST', '/costing/enquiry-desk/fetch');
    const job = f.body.job;
    assert.equal((await robot('POST', `/enquiry-jobs/${job.id}/claim`, {})).status, 200);
    const id = `m-auto-${++mails}`;
    const filed = await robot('POST', `/enquiry-jobs/${job.id}/mails`, { mails: [{
      gmail_message_id: id, gmail_thread_id: `t-${id}`, subject: 'Rates please', received_at: new Date().toISOString(), ...who, items,
    }] });
    assert.equal(filed.status, 200, JSON.stringify(filed.body));
    assert.equal((await robot('POST', `/enquiry-jobs/${job.id}/done`, { ok: true, result: { filed: 1 } })).status, 200);
    const nos = filed.body.filed[0].enquiries;
    if (unannounced) await db.q(`UPDATE enquiry_mails SET alerted_at = NULL WHERE id = (SELECT mail_id FROM enquiries WHERE enquiry_no = $1)`, [nos[0]]);
    return nos;
  };
  const alerts = () => db.q(`SELECT title, body FROM notifications WHERE kind = 'new_enquiry' AND user_id = $1 ORDER BY id`, [clerkId]);
  const rowOf = no => db.one(`SELECT id, enquiry_no, status, costing_id, auto_cost_at, auto_cost_why FROM enquiries WHERE enquiry_no = $1`, [no]);
  const costingOf = async no => (await call('clerk', 'GET', `/costing/costings/${(await rowOf(no)).costing_id}`)).body;

  test('a filed item is costed by itself, saved as Auto, and its row goes to To price', async () => {
    const [no] = await fileMail(BLUEFIN, [ITEM('BL AUTO TAB CARTON')]);
    const out = await auto.autoCostPending();
    assert.deepEqual(out.costed, [no]);
    assert.deepEqual([out.held, out.failed, out.left], [[], [], 0]);

    const e = await rowOf(no);
    const desk = (await call('clerk', 'GET', `/costing/enquiries/${e.id}`)).body;
    assert.equal(desk.stage, 'costed', 'a complete costing: To price');
    assert.equal(desk.auto_cost_why, null);
    assert.ok(desk.auto_cost_at);
    assert.equal(desk.costing_auto, true);

    const c = await costingOf(no);
    assert.equal(c.auto_costed, true);
    assert.equal(c.status, 'draft');
    assert.equal(c.complete, true);
    assert.equal(c.created_by_name, 'CI Plant (auto)');
    assert.equal(c.inputs.board_rate, 107, "Bluefin's own rate");
    assert.equal(c.inputs.qty, 10000);
    assert.equal(c.inputs.wastage_by_run, 1, 'each quantity asked is priced with its own run');
    assert.match(c.remarks, new RegExp(`^Auto-costed from ${no} — `));
    assert.match(c.remarks, /bluefin/);
    assert.deepEqual(c.enquiries.map(x => x.enquiry_no), [no]);

    const ev = await db.q(`SELECT detail, by_name FROM enquiry_events WHERE enquiry_id = $1 AND action = 'auto_cost'`, [e.id]);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].by_name, 'CI Plant (auto)');
    assert.equal(ev[0].detail.costing_no, c.costing_no);
    assert.equal(ev[0].detail.complete, true);
    assert.equal(ev[0].detail.why, null);
    assert.ok(ev[0].detail.notes.some(n => /planning:/.test(n)));
    // Costed once by itself: a second run finds nothing to do.
    assert.deepEqual((await auto.autoCostPending()).costed, []);
  });

  let held;
  test('an item with no pasting stays in To cost with the reason', async () => {
    [held] = await fileMail(NORTHWIND, [ITEM('NW HELD CARTON', { size_text: '140x50x95', style: null, quantities: [5000] })]);
    const out = await auto.autoCostPending();
    assert.deepEqual(out.held, [{ enquiry_no: held, why: 'needs pasting: side or lock?' }]);
    assert.deepEqual(out.costed, []);
    const e = await rowOf(held);
    const desk = (await call('clerk', 'GET', `/costing/enquiries/${e.id}`)).body;
    assert.equal(desk.stage, 'costing', 'an incomplete costing waits in To cost');
    assert.equal(desk.auto_cost_why, 'needs pasting: side or lock?');
    const c = await costingOf(held);
    assert.equal(c.auto_costed, true);
    assert.equal(c.complete, false);
    assert.equal(c.version, 1);
  });

  test('auto-cost is claimed once when two callers race', async () => {
    const nos = await fileMail(BLUEFIN, ['ONE', 'TWO', 'THREE', 'FOUR'].map(n => ITEM(`BL RACE ${n} CARTON`)));
    assert.equal(nos.length, 4);
    const before = (await db.one(`SELECT count(*)::int AS n FROM costings WHERE auto_costed`)).n;
    const [a, b] = await Promise.all([auto.autoCostPending(), auto.autoCostPending()]);
    assert.deepEqual([...a.costed, ...b.costed].sort(), [...nos].sort(), 'each row costed by exactly one of the two');
    assert.equal((await db.one(`SELECT count(*)::int AS n FROM costings WHERE auto_costed`)).n - before, nos.length, 'one costing per enquiry');
    const rows = await Promise.all(nos.map(rowOf));
    assert.equal(new Set(rows.map(r => r.costing_id)).size, nos.length);
    const versions = await db.q(`SELECT costing_id, count(*)::int AS n FROM costing_versions WHERE costing_id = ANY($1::int[]) GROUP BY 1`, [rows.map(r => r.costing_id)]);
    assert.deepEqual(versions.map(v => v.n), [1, 1, 1, 1]);
    assert.equal(a.left + b.left, 0);
  });

  test('auto-cost off: nothing is costed by itself, Cost it for me still works', async () => {
    await db.q(`UPDATE enquiry_settings SET auto_cost = false WHERE id = 1`);
    try {
      const [no] = await fileMail(NORTHWIND, [ITEM('NW SWITCHED OFF CARTON')]);
      const off = await auto.autoCostPending();
      assert.deepEqual([off.costed, off.held, off.failed, off.left], [[], [], [], 0]);
      const e = await rowOf(no);
      assert.equal(e.costing_id, null);
      assert.equal(e.auto_cost_at, null);
      assert.equal((await call('plain', 'POST', '/costing/enquiries/auto-cost', { ids: [e.id] })).status, 403, 'the Costing tick');
      const r = await call('clerk', 'POST', '/costing/enquiries/auto-cost', { ids: [e.id] });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.costed, [no]);
      const c = await costingOf(no);
      assert.equal(c.auto_costed, true);
      assert.equal(c.complete, true);
      assert.equal(c.inputs.board_rate, 131, "Northwind's own rate");
    } finally {
      await db.q(`UPDATE enquiry_settings SET auto_cost = true WHERE id = 1`);
    }
  });

  test('Cost it for me re-costs a held row after its pasting is set', async () => {
    const e = await rowOf(held);
    const first = await costingOf(held);
    const desk = (await call('clerk', 'GET', `/costing/enquiries/${e.id}`)).body;
    const put = await call('clerk', 'PUT', `/costing/enquiries/${e.id}`, {
      customer_id: desk.customer_id, customer_name: desk.customer_name, product_name: desk.product_name, size_text: desk.size_text,
      style: 'SIDE', board: desk.board, gsm: desk.gsm, colours: desk.colours, coating: desk.coating, quantities: desk.quantities,
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    const r = await call('clerk', 'POST', '/costing/enquiries/auto-cost', { ids: [e.id] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.costed, [held]);
    const c = await costingOf(held);
    assert.equal(c.costing_no, first.costing_no, 'the same costing, revised in place');
    assert.equal(c.complete, true);
    assert.equal(c.version, 2);
    assert.equal(c.auto_costed, true, "CI Plant's own revision keeps it Auto");
    assert.equal(c.style, 'SIDE');
    assert.match(c.remarks, /opening assumed: side-open/);
    const after = (await call('clerk', 'GET', `/costing/enquiries/${e.id}`)).body;
    assert.equal(after.stage, 'costed');
    assert.equal(after.auto_cost_why, null);
    // A complete auto-costing is not costed again, even by the button.
    const again = await call('clerk', 'POST', '/costing/enquiries/auto-cost', { ids: [e.id] });
    assert.deepEqual(again.body.costed, []);
    assert.equal((await costingOf(held)).version, 2);
  });

  test('an auto-costing never adds a size to the Size Library', async () => {
    const sizes = (await db.one(`SELECT count(*)::int AS n FROM costing_sizes`)).n;
    const [no] = await fileMail(BLUEFIN, [ITEM('BL NEW SIZE CARTON', { size_text: '150x60x100' })]);
    assert.deepEqual((await auto.autoCostPending()).costed, [no]);
    const c = await costingOf(no);
    assert.equal(c.complete, true);
    assert.equal(c.size_id, null);
    assert.equal((await db.one(`SELECT count(*)::int AS n FROM costing_sizes`)).n, sizes);
    assert.equal(answeredNo(c), false, 'a person opening it is still asked "save this size?"');
  });

  test('a person\'s costing is never touched; an item linked to the Product Master is costed from it', async () => {
    // A person costed this one first: Cost it for me leaves it alone and says why.
    const [mine] = await fileMail(BLUEFIN, [ITEM('BL COSTED BY HAND CARTON')]);
    const e = await rowOf(mine);
    const made = await call('clerk', 'POST', '/costing/costings', {
      enquiry_id: e.id, customer_name: 'Bluefin Labs', product_name: 'BL COSTED BY HAND CARTON', size_text: '120x40x90', style: 'LOCK',
      inputs: { qty: 10000, sheet_l: 18, sheet_w: 23, ups: 4, gsm: 300, board_rate: 100, wastage: 250, colours: 4, print_rate: 500, process: 2000 },
    });
    assert.equal(made.status, 201);
    const r = await call('clerk', 'POST', '/costing/enquiries/auto-cost', { ids: [e.id] });
    assert.deepEqual(r.body.costed, []);
    assert.deepEqual(r.body.skipped, [{ enquiry_no: mine, why: 'already has a costing' }]);
    assert.equal((await rowOf(mine)).costing_id, made.body.id);
    assert.equal((await costingOf(mine)).auto_costed, false);

    // The Product Master's sheet, ups, pasting and GSM; a known product needs no new die.
    const board = await db.one(`SELECT id FROM materials WHERE name = 'TEST BOARD 23x36'`);
    const cust = await db.one(`SELECT id FROM customers WHERE name = 'Northwind Pharma'`);
    await db.q(`INSERT INTO products (customer_id, name, code, board_material_id, gsm, size, child_l, child_w, ups, colors, pasting_type, board_grade)
                VALUES ($1, 'NW MASTER CARTON', 'NW-T001', $2, 280, '100x40x80', 18, 24, 6, 5, 'Lock Bottom', 'FBB')`, [cust.id, board.id]);
    const [no] = await fileMail(NORTHWIND, [{ product_name: 'NW MASTER CARTON', size_text: '100x40x80', quantities: [6000] }]);
    assert.deepEqual((await auto.autoCostPending()).costed, [no]);
    const c = await costingOf(no);
    assert.deepEqual([c.inputs.sheet_l, c.inputs.sheet_w, c.inputs.ups, c.inputs.gsm, c.inputs.colours], [18, 24, 6, 280, 5]);
    assert.equal(c.style, 'LOCK');
    assert.equal(c.inputs.process, 2000);
    assert.equal(c.inputs.board_rate, 131);
  });

  test('a costing a person revises becomes theirs: Cost it for me leaves it as they saved it', async () => {
    const [no] = await fileMail(BLUEFIN, [ITEM('BL TAKEN OVER CARTON', { size_text: '130x45x95', style: null, quantities: [5000] })]);
    assert.deepEqual((await auto.autoCostPending()).held.map(h => h.enquiry_no), [no]);
    const e = await rowOf(no);
    const held = await costingOf(no);
    assert.deepEqual([held.auto_costed, held.complete], [true, false]);
    // A person sets the pasting and the sheet, not the ups yet: still incomplete, and now theirs.
    const put = await call('clerk', 'PUT', `/costing/costings/${held.id}`, {
      enquiry_id: e.id, customer_name: held.customer_name, product_name: held.product_name, size_text: held.size_text, style: 'LOCK',
      inputs: { ...held.inputs, sheet_l: 20, sheet_w: 25, ups: null },
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.deepEqual([put.body.auto_costed, put.body.complete, put.body.version], [false, false, 2]);
    assert.equal((await rowOf(no)).auto_cost_why, null, 'the row no longer says what CI Plant could not do: a person has it');
    const r = await call('clerk', 'POST', '/costing/enquiries/auto-cost', { ids: [e.id] });
    assert.deepEqual(r.body.costed, []);
    assert.deepEqual(r.body.skipped, [{ enquiry_no: no, why: 'already has a costing' }]);
    const after = await costingOf(no);
    assert.deepEqual(after.inputs, put.body.inputs, 'what the person typed is left as they saved it');
    assert.deepEqual([after.version, after.auto_costed], [2, false]);

    // A bulk costing's save takes a revised row over the same way (the row is marked Auto here by hand: no Auto costing
    // sits in a batch today).
    const batch = { title: 'Taken over', customer_name: 'Bluefin Labs', common: {} };
    const made = await call('clerk', 'POST', '/costing/batches', { ...batch, rows: [{ product_name: 'BL BATCH ROW CARTON', size_text: '110x40x80',
      style: 'LOCK', inputs: { qty: 5000, sheet_l: 18, sheet_w: 23, ups: 4, gsm: 300, board_rate: 107, colours: 4, print_rate: 500 } }] });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const row = made.body.rows[0];
    await db.q(`UPDATE costings SET auto_costed = true WHERE id = $1`, [row.id]);
    const saved = await call('clerk', 'POST', `/costing/batches/${made.body.id}/save`, { ...batch,
      rows: [{ id: row.id, product_name: row.product_name, size_text: row.size_text, style: row.style, inputs: { ...row.inputs, gsm: 330 } }] });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal((await db.one(`SELECT auto_costed FROM costings WHERE id = $1`, [row.id])).auto_costed, false);
  });

  test("a person's new costing for a held row clears the reason it was held", async () => {
    const [no] = await fileMail(NORTHWIND, [ITEM('NW HELD THEN TYPED CARTON', { size_text: '135x45x95', style: null, quantities: [5000] })]);
    await auto.autoCostPending();
    const e = await rowOf(no);
    assert.equal(e.auto_cost_why, 'needs pasting: side or lock?');
    const made = await call('clerk', 'POST', '/costing/costings', {
      enquiry_id: e.id, customer_name: 'Northwind Pharma', product_name: 'NW HELD THEN TYPED CARTON', size_text: '135x45x95', style: 'SIDE',
      inputs: { qty: 5000, sheet_l: 18, sheet_w: 23, ups: 4, gsm: 300, board_rate: 131, wastage: 250, colours: 4, print_rate: 500, process: 2000 },
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const after = await rowOf(no);
    assert.equal(after.costing_id, made.body.id);
    assert.equal(after.auto_cost_why, null);
  });

  // Final review C1: a held item's auto-costing keeps the Rates defaults no rule could replace without the pasting. On the
  // desk it opens as a fresh fill from the enquiry (startsFresh); the person sets the pasting and saves. That costing is
  // linked in its place and CI Plant's draft is hidden, its remarks saying what replaced it. A person's costing never is.
  test("a person's costing for a held item is filled as Cost it for me fills it, and hides CI Plant's draft", async () => {
    const [no] = await fileMail(BLUEFIN, [ITEM('BL HELD FRESH CARTON', { size_text: '177x71x121', style: null, quantities: [20000] })], { cost: true });
    const e = await rowOf(no);
    const draft = await costingOf(no);
    assert.deepEqual([draft.auto_costed, draft.complete, e.auto_cost_why], [true, false, 'needs pasting: side or lock?']);
    const desk = (await call('clerk', 'GET', `/costing/enquiries/${e.id}`)).body;
    assert.equal(startsFresh(desk), true, 'the desk opens it fresh, not as the saved draft');
    // The form's own fill (SingleCosting, then CostingEditor's recommend): what was asked, the module's context, then LOCK.
    const boot = (await call('clerk', 'GET', '/costing/bootstrap')).body;
    const check = (await call('clerk', 'GET', `/costing/size-check?size=${encodeURIComponent(desk.size_key)}`)).body;
    const customerRate = customerBoardRate(desk.customer_name, boot.settings.customer_rates);
    const ctx = { check, typical: boot.typical, defaults: boot.settings.defaults, grades: chargeGrades(boot.board_grades, customerRate?.rate),
      masterDie: masterDieOf(check), boards: check.sheets, customerRate };
    let v = recommend(costingValueFromEnquiry(desk, boot.settings.defaults), ctx);
    v = recommend(markEdited({ ...v, style: 'LOCK', autofill: true }, ['style']), ctx);
    // "No, only the costing" to the Size Library question
    const made = await call('clerk', 'POST', '/costing/costings', { ...savePayload(v), save_size: false });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const sheets = Math.ceil(20000 / made.body.inputs.ups);
    assert.deepEqual([made.body.complete, made.body.auto_costed, made.body.inputs.dp_rate, made.body.inputs.wastage_by_run], [true, false, 0.4, 1]);
    assert.equal(made.body.inputs.wastage, sheets <= 2500 ? 200 : sheets <= 5000 ? 300 : 400, "the run's wastage, not the flat 250");
    assert.equal(made.body.inputs.board_rate, 107, "Bluefin's own rate");
    assert.equal((await rowOf(no)).costing_id, made.body.id, 'linked in its place');
    const old = await db.one('SELECT archived, remarks, auto_costed FROM costings WHERE id = $1', [draft.id]);
    assert.equal(old.archived, true, "CI Plant's incomplete draft is hidden");
    assert.ok(old.remarks.startsWith(`[Replaced by ${made.body.costing_no}] Auto-costed from ${no}`), old.remarks);
    assert.equal((await call('clerk', 'GET', `/costing/enquiries/${e.id}`)).body.stage, 'costed');

    // A person's own incomplete costing, replaced by another person's save: left as it is.
    const [mine] = await fileMail(NORTHWIND, [ITEM('NW HELD MINE CARTON', { size_text: '179x73x123', style: null, quantities: [5000] })], { cost: true });
    const m = await rowOf(mine);
    const body = (inputs, style) => ({ enquiry_id: m.id, customer_name: 'Northwind Pharma', product_name: 'NW HELD MINE CARTON', size_text: '179x73x123', style, inputs, save_size: false });
    const first = await call('clerk', 'POST', '/costing/costings', body({ qty: 5000, gsm: 300 }, 'SIDE'));
    assert.deepEqual([first.status, first.body.complete, first.body.auto_costed], [201, false, false]);
    assert.equal((await db.one('SELECT archived FROM costings WHERE id = $1', [m.costing_id])).archived, true, 'its auto draft went');
    const second = await call('clerk', 'POST', '/costing/costings', body({ qty: 5000, sheet_l: 18, sheet_w: 23, ups: 4, gsm: 300, board_rate: 131,
      wastage: 300, colours: 4, print_rate: 500, process: 2000 }, 'SIDE'));
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.equal((await rowOf(mine)).costing_id, second.body.id);
    const kept = await db.one('SELECT archived, remarks FROM costings WHERE id = $1', [first.body.id]);
    assert.deepEqual([kept.archived, /Replaced by/.test(kept.remarks || '')], [false, false], "a person's costing is never hidden by another save");
  });

  test('a call that stopped after its claim does not hold the row: the claim lapses after five minutes', async () => {
    const [stale, fresh] = await fileMail(NORTHWIND, [ITEM('NW STALE CLAIM CARTON'), ITEM('NW FRESH CLAIM CARTON')]);
    const s = await rowOf(stale), f = await rowOf(fresh);
    // One call claimed a row 10 minutes ago and stopped (Vercel gives a call 30 s); another claimed one a minute ago.
    const claimed = (id, ago) => db.q(`UPDATE enquiries SET auto_cost_at = now() - $2::interval, auto_cost_why = 'being costed' WHERE id = $1`, [id, ago]);
    await claimed(s.id, '10 minutes');
    await claimed(f.id, '1 minute');
    const out = await auto.autoCostPending();
    assert.deepEqual(out.costed, [stale]);
    assert.equal(out.left, 0, 'a claim still within its five minutes is not pending');
    const after = await rowOf(stale);
    assert.ok(after.costing_id);
    assert.equal(after.auto_cost_why, null);
    assert.deepEqual(Object.values(await db.one(`SELECT costing_id, auto_cost_why FROM enquiries WHERE id = $1`, [f.id])), [null, 'being costed']);
    assert.equal((await auto.autoCostEnquiry(f.id)).why, 'already being costed');
    // A forced re-cost that stopped on a row with an incomplete auto-costing: the run says so; Cost it for me takes it again.
    const [held] = await fileMail(NORTHWIND, [ITEM('NW STOPPED RECOST CARTON', { size_text: '145x50x95', style: null, quantities: [5000] })]);
    await auto.autoCostPending();
    const h = await rowOf(held);
    await claimed(h.id, '10 minutes');
    assert.deepEqual(await auto.autoCostEnquiry(h.id).then(x => [x.skipped, x.why]), [true, 'stopped while it was being costed — press Cost it for me']);
    const r = await call('clerk', 'POST', '/costing/enquiries/auto-cost', { ids: [h.id] });
    assert.deepEqual(r.body.held, [{ enquiry_no: held, why: 'needs pasting: side or lock?' }]);
    assert.equal((await rowOf(held)).auto_cost_why, 'needs pasting: side or lock?');
  });

  test('a hidden costing counts as none: Cost it for me makes a new one, shown and linked', async () => {
    const [done, held] = await fileMail(BLUEFIN, [ITEM('BL HIDDEN DONE CARTON'), ITEM('BL HIDDEN HELD CARTON', { size_text: '125x45x95', style: null })]);
    await auto.autoCostPending();
    for (const no of [done, held]) {
      const e = await rowOf(no);
      const old = await costingOf(no);
      assert.equal((await call('clerk', 'POST', `/costing/costings/${old.id}/archive`, { archived: true })).status, 200);
      assert.equal((await call('clerk', 'GET', `/costing/enquiries/${e.id}`)).body.stage, 'ready', 'the desk counts a hidden costing as none');
      const r = await call('clerk', 'POST', '/costing/enquiries/auto-cost', { ids: [e.id] });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.skipped, []);
      const now = await costingOf(no);
      assert.notEqual(now.id, old.id, `${no}: a new costing`);
      assert.deepEqual([now.archived, now.auto_costed, now.version], [false, true, 1]);
      assert.equal((await rowOf(no)).costing_id, now.id);
      const hidden = await db.one(`SELECT archived, version FROM costings WHERE id = $1`, [old.id]);
      assert.deepEqual([hidden.archived, hidden.version], [true, 1], `${no}: the hidden one is left as it was`);
    }
  });

  test('a costing that cannot be saved leaves the reason on the row and fails nothing', async () => {
    // An item with a size and no product name: the costing store will not save a costing without a name.
    const [no] = await fileMail(NORTHWIND, [{ size_text: '90x30x60', style: 'LOCK', quantities: [3000] }]);
    const out = await auto.autoCostPending();
    assert.equal(out.failed.length, 1);
    assert.equal(out.failed[0].enquiry_no, no);
    assert.match(out.failed[0].why, /^Could not cost it by itself: Give the product a name/);
    const e = await rowOf(no);
    assert.equal(e.costing_id, null);
    assert.equal(e.status, 'new');
    assert.equal(e.auto_cost_why, out.failed[0].why);
    assert.ok(e.auto_cost_at, 'tried once by itself — not again on every call');
    const ev = await db.q(`SELECT detail FROM enquiry_events WHERE enquiry_id = $1 AND action = 'auto_cost'`, [e.id]);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].detail.why, out.failed[0].why);
    assert.deepEqual((await auto.autoCostPending()).failed, []);
    assert.deepEqual(await auto.autoCostPendingSoft({ ids: [e.id], force: true }).then(x => x.failed.map(f => f.enquiry_no)), [no],
      'Cost it for me tries again, and still answers rather than throws');
  });

  test('a never-tried row is costed before a stale claim, whatever their ages', async () => {
    const [stale, fresh] = await fileMail(NORTHWIND, [ITEM('NW OLD STALE CARTON'), ITEM('NW NEVER TRIED CARTON')]);
    await db.q(`UPDATE enquiries SET auto_cost_at = now() - interval '10 minutes', auto_cost_why = 'being costed' WHERE enquiry_no = $1`, [stale]);
    const first = await auto.autoCostPending({ budgetMs: 1 });
    assert.deepEqual(first.costed, [fresh], 'the row never tried goes first');
    assert.equal(first.left, 1);
    assert.deepEqual((await auto.autoCostPending()).costed, [stale]);
  });

  test('the alert waits for the costing and goes once', async () => {
    await notifyDesk();
    const before = (await alerts()).length;
    const nos = await fileMail(BLUEFIN, [ITEM('BL ALERT ONE CARTON'), ITEM('BL ALERT TWO CARTON', { size_text: '130x45x95', style: null })], { cost: true });
    const rows = await Promise.all(nos.map(rowOf));
    assert.ok(rows.every(r => r.auto_cost_at), 'filing costed both before announcing');
    await notifyDesk();
    const told = (await alerts()).slice(before);
    assert.equal(told.length, 1, 'one bell row for the mail');
    assert.match(told[0].title, /^New enquiry: Bluefin Labs — 1 item costed, waiting for your approval · 1 needs a person$/);
    assert.match(told[0].body, /Check and approve on the Enquiry desk\.$/);
  });

  test('a mail over the time budget is finished by the next call and announced once', async () => {
    await notifyDesk();
    const items = Array.from({ length: 20 }, (_, i) => ITEM(`BL BUDGET ${String.fromCharCode(65 + i)} CARTON`));
    const nos = await fileMail(BLUEFIN, items, { unannounced: true });
    assert.equal(nos.length, 20);
    // (filed with the switch off, the mail was told at once; it is put back to untold, so count from here)
    const before = (await alerts()).length;
    const part = await auto.autoCostPending({ budgetMs: 1 });
    assert.ok(part.left > 0, 'the budget stopped it with rows still waiting');
    assert.equal((await notifyDesk()).announced, 0, 'a mail with rows still to cost is not announced');
    let guard = 0, last;
    do { last = await auto.autoCostPending({ budgetMs: 1 }); } while (last.left > 0 && ++guard < 40);
    assert.equal(last.left, 0);
    assert.equal((await notifyDesk()).announced, 1);
    assert.equal((await notifyDesk()).announced, 0, 'once');
    const told = (await alerts()).slice(before);
    assert.equal(told.length, 1);
    assert.match(told[0].title, /20 items costed, waiting for your approval/);
  });

  // Final review M2: a route that files first passes its request's start as the deadline. A call already past it costs
  // nothing — not even the one row a spent budget still allows — and leaves the rows to the next call.
  test("a call past its request's deadline costs nothing; the next call does", async () => {
    const nos = await fileMail(NORTHWIND, [ITEM('NW DEADLINE ONE CARTON'), ITEM('NW DEADLINE TWO CARTON')]);
    const late = await auto.autoCostPending({ deadline: Date.now() - 1 });
    assert.deepEqual([late.costed, late.held, late.failed], [[], [], []]);
    assert.ok(late.left >= 2, String(late.left));
    assert.equal((await rowOf(nos[0])).auto_cost_at, null, 'not even claimed');
    const first = await auto.autoCostPending({ budgetMs: 1, deadline: Date.now() + 25_000 });
    assert.equal(first.costed.length, 1, 'a deadline still ahead: the first row, then the budget');
    assert.deepEqual((await auto.autoCostPending({ deadline: Date.now() + 25_000 })).costed.length, 1);
    for (const no of nos) assert.ok((await rowOf(no)).costing_id, no);
  });

  test('asked again and counter mails cost nothing', async () => {
    const [no] = await fileMail(BLUEFIN, [ITEM('BL ASKED TWICE CARTON')], { cost: true });
    const costings = () => db.one(`SELECT count(*)::int AS n FROM costings`).then(r => r.n);
    const base = await costings();
    const e = await rowOf(no);
    // The same item asked again while it is open marks that row; no new row, no new costing.
    const rows = await fileMail(BLUEFIN, [ITEM('BL ASKED TWICE CARTON')], { cost: true });
    assert.deepEqual(rows, [], 'no new row');
    assert.equal(await costings(), base);
    assert.equal((await rowOf(no)).auto_cost_at.getTime(), e.auto_cost_at.getTime(), 'the row is not costed again');
    // A counter mail for that row (not priced yet, so refused) files a mail and costs nothing.
    const f = await call('clerk', 'POST', '/costing/enquiry-desk/fetch');
    assert.equal((await robot('POST', `/enquiry-jobs/${f.body.job.id}/claim`, {})).status, 200);
    const put = await robot('POST', `/enquiry-jobs/${f.body.job.id}/counters`, {
      mail: { gmail_message_id: 'm-auto-counter', gmail_thread_id: 't-auto-counter', subject: 'Re: Rates', from_email: BLUEFIN.from_email, received_at: new Date().toISOString(), body_text: 'Our rate' },
      counters: [{ enquiry_no: no, qty: 10000, theirs: 1.1 }],
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    await robot('POST', `/enquiry-jobs/${f.body.job.id}/done`, { ok: true, result: { counters: 0 } });
    assert.equal(await costings(), base, 'a counter mail makes no costing');
  });

  test('an unannounced mail is told after five minutes even if its costing stalls', async () => {
    await notifyDesk();
    const [no] = await fileMail(BLUEFIN, [ITEM('BL STALLED CARTON')], { unannounced: true });
    assert.equal((await notifyDesk()).announced, 0, 'a pending row holds the alert');
    await db.q(`UPDATE enquiry_mails SET created_at = now() - interval '6 minutes' WHERE id = (SELECT mail_id FROM enquiries WHERE enquiry_no = $1)`, [no]);
    assert.equal((await rowOf(no)).costing_id, null, 'its costing never ran');
    assert.equal((await notifyDesk()).announced, 1);
    const last = (await alerts()).pop();
    assert.doesNotMatch(last.title, /costed/, 'nothing was costed, so the words are the plain ones');
    assert.deepEqual((await auto.autoCostPending()).costed, [no], 'and the costing still follows');
  });

  test('the switch off: a mail is announced at once with the plain words', async () => {
    await notifyDesk();
    const [no] = await fileMail(NORTHWIND, [ITEM('NW OFF ALERT CARTON')], { unannounced: true });
    await db.q(`UPDATE enquiry_settings SET auto_cost = false WHERE id = 1`);
    try {
      assert.equal((await notifyDesk()).announced, 1);
    } finally { await db.q(`UPDATE enquiry_settings SET auto_cost = true WHERE id = 1`); }
    assert.ok(no);
  });

  test('a mail whose row is freshly being costed is not announced; a stale claim on an old mail is', async () => {
    await notifyDesk();
    const [no] = await fileMail(BLUEFIN, [ITEM('BL CLAIMED CARTON')], { unannounced: true });
    const mailOf = `(SELECT mail_id FROM enquiries WHERE enquiry_no = $1)`;
    await db.q(`UPDATE enquiries SET auto_cost_at = now(), auto_cost_why = 'being costed' WHERE enquiry_no = $1`, [no]);
    assert.equal((await notifyDesk()).announced, 0, 'a call is costing its last row');
    await db.q(`UPDATE enquiries SET auto_cost_at = now() - interval '6 minutes' WHERE enquiry_no = $1`, [no]);
    await db.q(`UPDATE enquiry_mails SET created_at = now() - interval '6 minutes' WHERE id = ${mailOf}`, [no]);
    assert.equal((await notifyDesk()).announced, 1);
  });

  test('the poll does nothing while the switch is off and nothing waits to be announced', async () => {
    await notifyDesk();
    const [no] = await fileMail(NORTHWIND, [ITEM('NW OFF POLL CARTON')]);
    await db.q(`UPDATE enquiry_settings SET auto_cost = false WHERE id = 1`);
    try {
      assert.equal((await rowOf(no)).costing_id, null, 'a robot row sits in the Inbox with no costing');
      assert.equal(await db.one(`SELECT 1 AS y FROM enquiry_mails WHERE alerted_at IS NULL`), null, 'every mail is announced');
      const n = (await alerts()).length;
      assert.equal(await pollHasWork(), false, 'no work: no costing call, no alert transaction');
      assert.deepEqual(await soft(), { filed: [], skipped: [], refused: [] });
      assert.equal((await alerts()).length, n);
      await db.q(`UPDATE enquiry_settings SET auto_cost = true WHERE id = 1`);
      assert.equal(await pollHasWork(), true, 'switched on, the row waits to be costed');
    } finally { await db.q(`UPDATE enquiry_settings SET auto_cost = true WHERE id = 1`); }
    assert.ok((await auto.autoCostPending()).costed.includes(no), 'and it is costed once the switch is on');
  });

  // ── Approve → price → one reply per mail (owner, 20 Nov 2026: approval fixes the price, makes the quotation and saves
  // the Gmail draft; nothing is sent) ──────────────────────────────────────────────────────────────────────────────────
  const approve = (who, list) => call(who, 'POST', '/costing/enquiries/approve', { ids: list });
  const deskRow = async id => (await call('clerk', 'GET', `/costing/enquiries?ids=${id}`)).body[0];
  const mailOf = async id => (await db.one('SELECT mail_id FROM enquiries WHERE id = $1', [id])).mail_id;
  const quotesOf = mailId => db.q(`SELECT DISTINCT qt.id, qt.quotation_no FROM quotations qt JOIN enquiries e ON e.quotation_id = qt.id
                                    WHERE e.mail_id = $1 ORDER BY qt.id`, [mailId]);
  const enquiryNos = lines => [...new Set(lines.map(l => l.enquiry_no))].sort();

  test('approve fixes the price at the suggested quote and makes one reply for the mail', async () => {
    const [one, two] = await fileMail(BLUEFIN, [ITEM('BL APPROVE ONE CARTON'), ITEM('BL APPROVE TWO CARTON')], { cost: true });
    const a = await rowOf(one), b = await rowOf(two);
    const mail = await mailOf(a.id);
    for (const r of [a, b]) assert.equal((await deskRow(r.id)).stage, 'costed', 'both costed by themselves, in To price');

    const first = await approve('md', [a.id]);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body.approved.map(x => x.enquiry_no), [one]);
    assert.deepEqual(first.body.skipped, []);
    assert.deepEqual(first.body.replies, [], 'no reply while item 2 waits');
    assert.deepEqual(first.body.waiting, [{ mail_id: mail, waiting: [{ enquiry_no: two, why: 'waiting for approval' }], quoted: [] }]);
    assert.ok(first.body.undo);
    const ra = await deskRow(a.id);
    assert.equal(ra.quotation_id, null, 'no quotation yet');
    assert.deepEqual(ra.reply, { ready: false, waiting: [{ enquiry_no: two, why: 'waiting for approval' }], quoted: [], resume: null });
    assert.deepEqual([ra.stage, ra.costing_status, ra.costing_approved_by], ['price_pending', 'approved', 'Auto md']);
    assert.ok(ra.prices.length === 2 && ra.prices.every(p => p.suggested > 0));
    assert.deepEqual(ra.prices.map(p => p.final), ra.prices.map(p => p.suggested), 'the final price is the costed quote, up to the paisa');

    const second = await approve('md', [b.id]);
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.deepEqual(second.body.waiting, []);
    assert.equal(second.body.undo, null, 'a press that made the reply has nothing to undo from its toast');
    assert.equal(second.body.replies.length, 1);
    const [reply] = second.body.replies;
    assert.equal(reply.mail_id, mail);
    assert.equal(reply.quotations.length, 1, 'one quotation for the mail');
    assert.deepEqual(reply.failed, []);
    const qt = await db.one(`SELECT id, quotation_no, status, lines, job_id FROM quotations WHERE id = $1`, [reply.quotations[0].id]);
    assert.deepEqual(enquiryNos(qt.lines), [one, two].sort(), 'both items on it');
    assert.deepEqual(reply.drafted.map(d => d.quotation_no), [qt.quotation_no]);
    assert.equal(qt.status, 'queued');
    const job = await db.one(`SELECT kind, status, mailbox FROM enquiry_jobs WHERE id = $1`, [qt.job_id]);
    assert.deepEqual([job.kind, job.status, job.mailbox], ['draft', 'queued', 'trial'], 'the trial mailbox: a robot job, never a send');
    for (const r of [a, b]) {
      const e = (await call('clerk', 'GET', `/costing/enquiries/${r.id}`)).body;
      assert.deepEqual([e.status, e.quotation_no], ['quote_ready', qt.quotation_no]);
      assert.deepEqual(e.final_prices.map(f => f.final), e.prices.map(p => p.suggested), `${e.enquiry_no}: final_prices = suggested`);
    }
  });

  test('approve takes only the rows in To price, and says why for the rest', async () => {
    // A held row needs a size no costing here has had: a past costing of the size would give it its pasting.
    const [done, held, gone, hidden] = await fileMail(NORTHWIND, [ITEM('NW SKIP DONE CARTON'),
      ITEM('NW SKIP HELD CARTON', { size_text: '171x63x113', style: null, quantities: [5000] }), ITEM('NW SKIP GONE CARTON'), ITEM('NW SKIP HIDDEN CARTON')], { cost: true });
    const [d, h, g, x] = await Promise.all([done, held, gone, hidden].map(rowOf));
    assert.equal((await call('clerk', 'POST', '/costing/enquiries/drop', { ids: [g.id] })).status, 200);
    // In To price with its prices, then its costing hidden: a hidden costing is no costing.
    const px = (await deskRow(x.id)).prices.map(p => ({ qty: p.qty, final: p.suggested }));
    assert.equal((await call('clerk', 'PUT', '/costing/enquiries/prices', { items: [{ id: x.id, prices: px }] })).status, 200);
    assert.equal((await call('clerk', 'POST', `/costing/costings/${x.costing_id}/archive`, { archived: true })).status, 200);
    const r = await approve('md', [d.id, h.id, g.id, x.id, 999999]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.approved.map(a => a.enquiry_no), [done]);
    assert.deepEqual(r.body.skipped.map(s => [s.enquiry_no, s.why]), [
      [held, 'is in To cost — finish its costing first'], [gone, 'is dropped — bring it back first'],
      [hidden, 'has no complete costing'], ['#999999', 'was not found']]);
    assert.deepEqual(r.body.waiting, [{ mail_id: await mailOf(d.id), quoted: [],
      waiting: [{ enquiry_no: held, why: 'needs pasting: side or lock?' }, { enquiry_no: hidden, why: 'not costed yet' }] }]);
    for (const c of [h, g]) assert.equal((await db.one('SELECT status FROM costings WHERE id = $1', [c.costing_id])).status, 'draft');
  });

  test("a refusal from the costing's approval is that row's skip; the rest of the press goes on", async () => {
    const [old, fine] = await fileMail(BLUEFIN, [ITEM('BL SHEET COSTING CARTON'), ITEM('BL FINE COSTING CARTON')], { cost: true });
    const o = await rowOf(old), f = await rowOf(fine);
    // A costing the old cost sheet made is never approved here (costing-store.js approveCosting).
    await db.q(`UPDATE costings SET source = 'sheet' WHERE id = $1`, [o.costing_id]);
    const r = await approve('md', [o.id, f.id]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.skipped.map(s => [s.enquiry_no, s.why]), [[old, 'Old cost-sheet records are not approved — cost it again to make a costing that can be.']]);
    assert.deepEqual(r.body.approved.map(a => a.enquiry_no), [fine], 'approved after the refusal, in the same transaction');
    assert.equal((await deskRow(f.id)).costing_status, 'approved');
    assert.deepEqual((await deskRow(o.id)).final_prices, [], 'the refused row is left as it was');
  });

  test('a business mail without its Gmail link gets the quotation and the reason, not a draft', async () => {
    // The office intake that files the business mailbox runs on production only: here the mail and its row go in by SQL.
    // Its own subject: a later trial mail from the same sender with the same subject would read as its Bcc copy.
    const { nextNumber } = await import('./helpers.js');
    const box = await db.one(`SELECT email FROM enquiry_mailboxes WHERE key = 'business'`);
    const cust = await db.one(`SELECT id FROM customers WHERE name = 'Northwind Pharma'`);
    const row = await db.tx(async (qc, oc) => {
      const no = await nextNumber('CI-ENQ-', 'enquiries', 'enquiry_no', oc);
      const m = await oc(`INSERT INTO enquiry_mails (mailbox, mailbox_email, gmail_message_id, gmail_thread_id, subject, from_email, received_at, alerted_at)
                          VALUES ('business', $1, 'm-auto-business', 't-auto-business', 'Business carton rates', $2, now(), now()) RETURNING id`,
      [box.email, NORTHWIND.from_email]);
      return oc(`INSERT INTO enquiries (enquiry_no, mail_id, mailbox, customer_id, customer_name, contact_email, product_name, size_text, size_key,
                                        style, board, gsm, colours, coating, quantities, source, created_by_name)
                 VALUES ($1, $2, 'business', $3, 'Northwind Pharma', $4, 'NW BUSINESS CARTON', '120x40x90', '120x40x90',
                         'LOCK', 'FBB', 300, 4, 'UV', '{10000}', 'robot', 'AVS (office)') RETURNING id, enquiry_no, mail_id`,
      [no, m.id, cust.id, NORTHWIND.from_email]);
    });
    assert.deepEqual((await auto.autoCostPending({ ids: [row.id] })).costed, [row.enquiry_no]);
    const jobs = async () => (await db.one(`SELECT count(*)::int AS n FROM enquiry_jobs WHERE kind = 'draft' AND mailbox = 'business'`)).n;
    const before = await jobs();
    const r = await approve('md', [row.id]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.replies.length, 1);
    const [reply] = r.body.replies;
    assert.equal(reply.mail_id, row.mail_id);
    assert.equal(reply.quotations.length, 1, 'the quotation is made');
    assert.deepEqual(reply.drafted, []);
    assert.match(reply.failed[0].why, /Connect the business mailbox/);
    assert.equal(await jobs(), before, 'no job that no robot would ever take');
    assert.equal((await db.one(`SELECT status FROM quotations WHERE id = $1`, [reply.quotations[0].id])).status, 'ready');
    // On its quotation the claim's mark has gone (final review I1): the row reads as on that quotation — Send quotation in
    // Quoted drafts it once the Gmail is connected — never as a reply to make again.
    assert.equal((await db.one(`SELECT reply_claim_at FROM enquiries WHERE id = $1`, [row.id])).reply_claim_at, null);
    const qno = reply.quotations[0].quotation_no;
    assert.deepEqual((await deskRow(row.id)).reply, { ready: false, waiting: [], quoted: [qno], resume: null });
  });

  test('part of a mail sent by hand stops the automatic reply', async () => {
    const [one, two] = await fileMail(NORTHWIND, [ITEM('NW BY HAND ONE CARTON'), ITEM('NW BY HAND TWO CARTON')], { cost: true });
    const a = await rowOf(one), b = await rowOf(two);
    const mail = await mailOf(a.id);
    // Item 1 goes the old way: its final prices, then Send quotation.
    const prices = (await deskRow(a.id)).prices.map(p => ({ qty: p.qty, final: p.suggested }));
    assert.equal((await call('clerk', 'PUT', '/costing/enquiries/prices', { items: [{ id: a.id, prices }] })).status, 200);
    const sent = await call('md', 'POST', '/costing/quotations/send', { ids: [a.id] });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    const qno = sent.body.quotations[0].quotation_no;
    // Approving item 2 makes no second reply: it waits in To price, named against the first quotation.
    const r = await approve('md', [b.id]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.approved.map(x => x.enquiry_no), [two]);
    assert.deepEqual(r.body.replies, []);
    assert.deepEqual(r.body.waiting, [{ mail_id: mail, waiting: [], quoted: [qno] }]);
    assert.deepEqual((await quotesOf(mail)).map(x => x.quotation_no), [qno], 'no new quotation');
    const rb = await deskRow(b.id);
    assert.deepEqual([rb.stage, rb.quotation_id], ['price_pending', null]);
    assert.deepEqual(rb.reply, { ready: false, waiting: [], quoted: [qno], resume: null });
  });

  test("dropping the last waiting item lets a manager's drop make the reply", async () => {
    const [one, two, three] = await fileMail(BLUEFIN, ['ONE', 'TWO', 'THREE'].map(n => ITEM(`BL DROP ${n} CARTON`)), { cost: true });
    const [a, b, c] = await Promise.all([one, two, three].map(rowOf));
    const mail = await mailOf(a.id);
    assert.deepEqual((await approve('md', [a.id])).body.replies, []);
    // A manager deletes item 2: item 3 still waits, so no reply yet.
    const del = await call('md', 'POST', '/costing/enquiries/delete', { ids: [b.id], reason: 'Asked twice' });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.deepEqual(del.body.moved.map(m => m.to), ['deleted']);
    assert.deepEqual(del.body.replies, []);
    assert.ok(del.body.undo, 'no reply made: the delete can be undone');
    assert.deepEqual(del.body.waiting, [{ mail_id: mail, waiting: [{ enquiry_no: three, why: 'waiting for approval' }], quoted: [] }]);
    // Dropping item 3 leaves nothing waiting: the drop makes the reply, with item 1 alone.
    const drop = await call('md', 'POST', '/costing/enquiries/drop', { ids: [c.id], reason: 'Not to be quoted' });
    assert.equal(drop.status, 200, JSON.stringify(drop.body));
    assert.deepEqual(drop.body.moved.map(m => m.to), ['dropped']);
    assert.equal(drop.body.replies.length, 1);
    assert.equal(drop.body.replies[0].mail_id, mail);
    assert.equal(drop.body.undo, null, 'the drop made the reply');
    const qt = await db.one(`SELECT lines, status FROM quotations WHERE id = $1`, [drop.body.replies[0].quotations[0].id]);
    assert.deepEqual(enquiryNos(qt.lines), [one]);
    assert.equal(qt.status, 'queued');
    assert.equal((await rowOf(one)).status, 'quote_ready');
  });

  test("a drop without the Management right leaves the reply to a manager's next press", async () => {
    const [one, two] = await fileMail(NORTHWIND, [ITEM('NW CLERK DROP ONE CARTON'), ITEM('NW CLERK DROP TWO CARTON')], { cost: true });
    const a = await rowOf(one), b = await rowOf(two);
    const mail = await mailOf(a.id);
    assert.deepEqual((await approve('md', [a.id])).body.replies, []);
    const drop = await call('clerk', 'POST', '/costing/enquiries/drop', { ids: [b.id] });
    assert.equal(drop.status, 200, JSON.stringify(drop.body));
    assert.deepEqual(drop.body.moved.map(m => m.to), ['dropped']);
    assert.equal(drop.body.replies, undefined, 'a Costing-tick login makes no quotation');
    assert.deepEqual(await quotesOf(mail), []);
    assert.equal((await deskRow(a.id)).reply.ready, true, 'nothing of the mail waits now');
    // Approve again on the approved row: nothing on it changes, and the reply is made.
    const again = await approve('md', [a.id]);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual(again.body.approved.map(x => x.enquiry_no), [one]);
    assert.equal(again.body.undo, null, 'nothing changed on the row');
    assert.equal(again.body.replies.length, 1);
    assert.deepEqual(enquiryNos((await db.one(`SELECT lines FROM quotations WHERE id = $1`, [again.body.replies[0].quotations[0].id])).lines), [one]);
  });

  test('an enquiry typed in by hand is quoted on its own approval', async () => {
    const typed = async name => (await call('clerk', 'POST', '/costing/enquiries', { customer_name: 'Northwind Pharma', contact_email: NORTHWIND.from_email, ...ITEM(name) })).body;
    const x = await typed('NW TYPED ONE CARTON');
    const y = await typed('NW TYPED TWO CARTON');
    assert.deepEqual([x.mail_id, y.mail_id], [null, null]);
    assert.deepEqual((await call('clerk', 'POST', '/costing/enquiries/auto-cost', { ids: [x.id] })).body.costed, [x.enquiry_no]);
    assert.equal((await deskRow(x.id)).reply, undefined, 'no mail: no reply line');
    // y (the same customer, never costed) does not hold x: a row with no mail is a mail of one.
    const r = await approve('md', [x.id]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.waiting, []);
    assert.equal(r.body.replies.length, 1);
    const [reply] = r.body.replies;
    assert.deepEqual([reply.mail_id, reply.enquiry_id], [null, x.id]);
    assert.equal(reply.quotations.length, 1);
    assert.equal(reply.drafted.length, 1);
    assert.deepEqual(enquiryNos((await db.one(`SELECT lines FROM quotations WHERE id = $1`, [reply.quotations[0].id])).lines), [x.enquiry_no]);
    assert.equal((await rowOf(y.enquiry_no)).status, 'new');
  });

  test('approve needs the Management right', async () => {
    const [no] = await fileMail(BLUEFIN, [ITEM('BL NOT MINE TO APPROVE CARTON')], { cost: true });
    const e = await rowOf(no);
    const r = await approve('clerk', [e.id]);
    assert.equal(r.status, 403);
    assert.match(r.body.error, /Management right/);
    assert.equal((await approve('plain', [e.id])).status, 403, 'and the Costing tick before it');
    const row = await deskRow(e.id);
    assert.deepEqual([row.costing_status, row.stage, row.final_prices], ['draft', 'costed', []]);
  });

  test("Undo of a person's costing for a held row brings back why it was held", async () => {
    const [no] = await fileMail(BLUEFIN, [ITEM('BL HELD UNDO CARTON', { size_text: '173x67x117', style: null, quantities: [5000] })], { cost: true });
    const e = await rowOf(no);
    assert.equal(e.auto_cost_why, 'needs pasting: side or lock?');
    const made = await call('clerk', 'POST', '/costing/costings', {
      enquiry_id: e.id, customer_name: 'Bluefin Labs', product_name: 'BL HELD UNDO CARTON', size_text: '173x67x117', style: 'SIDE',
      inputs: { qty: 5000, sheet_l: 18, sheet_w: 23, ups: 4, gsm: 300, board_rate: 107, wastage: 250, colours: 4, print_rate: 500, process: 2000 },
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal((await rowOf(no)).auto_cost_why, null);
    const undo = await call('clerk', 'POST', '/costing/enquiries/undo', { group: made.body.desk.group });
    assert.equal(undo.status, 200, JSON.stringify(undo.body));
    const back = await rowOf(no);
    assert.deepEqual([back.costing_id, back.auto_cost_why], [e.costing_id, 'needs pasting: side or lock?']);
  });

  // ── Fix round 1: two presses, a cut-off reply, a corrected costing, the reply step's time ─────────────────────────────
  test('two presses at once make one reply: the other reads the mail as quoted', async () => {
    const [one, two] = await fileMail(BLUEFIN, [ITEM('BL TWO PRESSES ONE CARTON'), ITEM('BL TWO PRESSES TWO CARTON')], { cost: true });
    const a = await rowOf(one), b = await rowOf(two);
    const mail = await mailOf(a.id);
    // "Approve this mail", pressed by two managers at the same moment.
    const both = await Promise.all([approve('md', [a.id, b.id]), approve('md', [a.id, b.id])]);
    for (const r of both) assert.equal(r.status, 200, JSON.stringify(r.body));
    const made = both.filter(r => r.body.replies.length);
    assert.equal(made.length, 1, 'one press made the reply');
    assert.equal(made[0].body.replies[0].quotations.length, 1);
    assert.deepEqual(made[0].body.replies[0].failed, []);
    const other = both.find(r => !r.body.replies.length).body;
    assert.deepEqual(other.waiting.map(w => [w.mail_id, w.waiting]), [[mail, []]]);
    assert.ok(other.waiting[0].quoted.length > 0, 'the other press reads the mail as quoted — not failed');
    const quotes = await quotesOf(mail);
    assert.equal(quotes.length, 1, 'one quotation');
    assert.equal((await db.q(`SELECT id FROM enquiry_jobs WHERE kind = 'draft' AND quotation_id = $1`, [quotes[0].id])).length, 1, 'one draft job');
  });

  test("a reply the claim cut off part-way is finished by the next press on its mail", async () => {
    const [one, two] = await fileMail(NORTHWIND, [ITEM('NW CUT OFF ONE CARTON'), ITEM('NW CUT OFF TWO CARTON')], { cost: true });
    const a = await rowOf(one), b = await rowOf(two);
    const mail = await mailOf(a.id);
    for (const r of [a, b]) {
      const prices = (await deskRow(r.id)).prices.map(p => ({ qty: p.qty, final: p.suggested }));
      assert.equal((await call('clerk', 'PUT', '/costing/enquiries/prices', { items: [{ id: r.id, prices }] })).status, 200);
    }
    // The press that finalised the mail stopped before its quotation (a call has 30 s): finalised by the claim — its mark on
    // the rows (reply_claim_at) — and no quotation.
    const finalise = ago => db.q(`UPDATE enquiries SET status = 'quote_ready', finalised_by_name = 'Auto md', finalised_at = now() - $2::interval,
                                         reply_claim_at = now() - $2::interval WHERE id = ANY($1::int[])`, [[a.id, b.id], ago]);
    await finalise('0 seconds');
    assert.deepEqual((await deskRow(a.id)).reply, { ready: false, waiting: [], quoted: [one, two], resume: null },
      'finalised just now: another press may still be sending it');
    await finalise('10 minutes');
    assert.deepEqual((await deskRow(a.id)).reply.resume, { ids: [a.id, b.id], why: 'Finalised, reply not finished — press Send quotation' });
    const r = await approve('md', [a.id]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.approved, r.body.skipped], [[], []]);
    assert.equal(r.body.replies.length, 1);
    const [reply] = r.body.replies;
    assert.deepEqual([reply.mail_id, reply.resumed, reply.quotations.length, reply.drafted.length, reply.failed], [mail, true, 1, 1, []]);
    const quotes = await quotesOf(mail);
    assert.equal(quotes.length, 1);
    const qt = await db.one(`SELECT lines, status, job_id FROM quotations WHERE id = $1`, [quotes[0].id]);
    assert.deepEqual(enquiryNos(qt.lines), [one, two].sort(), 'one quotation for the whole mail');
    assert.equal(qt.status, 'queued');
    assert.deepEqual(Object.values(await db.one(`SELECT kind, status FROM enquiry_jobs WHERE id = $1`, [qt.job_id])), ['draft', 'queued']);
    assert.deepEqual((await db.q(`SELECT reply_claim_at FROM enquiries WHERE id = ANY($1::int[])`, [[a.id, b.id]])).map(x => x.reply_claim_at), [null, null],
      'on its quotation: the claim\'s mark has gone');
  });

  // Final review I1: what the desk says of a cut-off reply is where to finish it — Send quotation on the Quoted tab.
  test("Send quotation in Quoted finishes a reply the claim cut off; a row finalised by hand is never sent again", async () => {
    const [one, two] = await fileMail(BLUEFIN, [ITEM('BL CUT SEND ONE CARTON'), ITEM('BL CUT SEND TWO CARTON')], { cost: true });
    const a = await rowOf(one), b = await rowOf(two);
    const mail = await mailOf(a.id);
    for (const r of [a, b]) {
      const prices = (await deskRow(r.id)).prices.map(p => ({ qty: p.qty, final: p.suggested }));
      assert.equal((await call('clerk', 'PUT', '/costing/enquiries/prices', { items: [{ id: r.id, prices }] })).status, 200);
    }
    // Finalised ten minutes ago, the old way (no claim mark): it went out by hand, so it is quoted — Approve sends nothing.
    await db.q(`UPDATE enquiries SET status = 'quote_ready', finalised_by_name = 'Auto md', finalised_at = now() - interval '10 minutes'
                 WHERE id = ANY($1::int[])`, [[a.id, b.id]]);
    assert.deepEqual((await deskRow(a.id)).reply, { ready: false, waiting: [], quoted: [one, two], resume: null });
    const r = await approve('md', [a.id]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.replies, []);
    assert.deepEqual(r.body.skipped.map(x => x.enquiry_no), [one], 'a finalised row is not in To price');
    assert.deepEqual(await quotesOf(mail), []);
    // The same rows as a claim leaves them: the desk says to press Send quotation, and Send quotation makes the one reply.
    await db.q(`UPDATE enquiries SET reply_claim_at = now() - interval '10 minutes' WHERE id = ANY($1::int[])`, [[a.id, b.id]]);
    assert.deepEqual((await deskRow(b.id)).reply.resume, { ids: [a.id, b.id], why: 'Finalised, reply not finished — press Send quotation' });
    const sent = await call('md', 'POST', '/costing/quotations/send', { ids: [a.id, b.id] });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    assert.equal(sent.body.quotations.length, 1);
    assert.deepEqual(enquiryNos((await db.one(`SELECT lines FROM quotations WHERE id = $1`, [sent.body.quotations[0].id])).lines), [one, two].sort());
    assert.deepEqual((await deskRow(a.id)).reply, { ready: false, waiting: [], quoted: [sent.body.quotations[0].quotation_no], resume: null });
  });

  // Final review I1 (the reviewer's case): a person cancelled the quotation of a finalised item — it waits in Quoted, on no
  // quotation. Approving its sibling must not quote it again: it went the old way, so the mail is part-quoted.
  test("a quotation a person cancelled is never made again by a sibling's Approve", async () => {
    const [one, two] = await fileMail(BLUEFIN, [ITEM('BL CANCELLED ONE CARTON'), ITEM('BL CANCELLED TWO CARTON')], { cost: true });
    const a = await rowOf(one), b = await rowOf(two);
    const mail = await mailOf(a.id);
    const prices = (await deskRow(a.id)).prices.map(p => ({ qty: p.qty, final: p.suggested }));
    assert.equal((await call('clerk', 'PUT', '/costing/enquiries/prices', { items: [{ id: a.id, prices }] })).status, 200);
    const sent = await call('md', 'POST', '/costing/quotations/send', { ids: [a.id] });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    const qt = sent.body.quotations[0];
    const job = (await db.one('SELECT job_id FROM quotations WHERE id = $1', [qt.id])).job_id;
    assert.equal((await call('clerk', 'POST', `/costing/enquiry-jobs/${job}/cancel`)).status, 200, 'its draft job first');
    const cancel = await call('clerk', 'POST', `/costing/quotations/${qt.id}/cancel`);
    assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
    await db.q(`UPDATE enquiries SET finalised_at = now() - interval '4 days' WHERE id = $1`, [a.id]);
    assert.deepEqual(Object.values(await db.one('SELECT status, quotation_id FROM enquiries WHERE id = $1', [a.id])), ['quote_ready', null]);
    const r = await approve('md', [b.id]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.approved.map(x => x.enquiry_no), [two]);
    assert.deepEqual(r.body.replies, [], 'no reply: part of the mail went the old way');
    assert.deepEqual(r.body.waiting, [{ mail_id: mail, waiting: [], quoted: [one] }]);
    const onA = await db.q(`SELECT id, status FROM quotations WHERE lines @> $1::jsonb ORDER BY id`, [JSON.stringify([{ enquiry_no: one }])]);
    assert.deepEqual(onA.map(x => [x.id, x.status]), [[qt.id, 'cancelled']], 'item 1 is not quoted again');
    assert.deepEqual((await deskRow(b.id)).reply, { ready: false, waiting: [], quoted: [one], resume: null });
  });

  // Final review I2: approval fixes the price. A price a login changes after it — with or without the Management right —
  // is not the approved one: the mail's reply waits until a manager presses Approve again, which keeps that figure.
  test("a price changed after approval holds the mail's reply until Approve again, which keeps the new figure", async () => {
    const [one, two] = await fileMail(NORTHWIND, [ITEM('NW REAPPROVE ONE CARTON'), ITEM('NW REAPPROVE TWO CARTON')], { cost: true });
    const a = await rowOf(one), b = await rowOf(two);
    const mail = await mailOf(a.id);
    const stamps = async id => (await db.one('SELECT final_prices FROM enquiries WHERE id = $1', [id])).final_prices.map(f => [f.qty, f.final, f.ok ?? null]);
    assert.deepEqual((await approve('md', [a.id])).body.replies, [], 'item 2 still waits');
    const [q1, q2] = (await deskRow(a.id)).prices;
    assert.deepEqual(await stamps(a.id), [[q1.qty, q1.suggested, true], [q2.qty, q2.suggested, true]], "Approve's prices carry its stamp");
    // A clerk changes the first price; a manager, typing a price, is no Approve either.
    const mine = Math.round((q1.suggested + 0.4) * 100) / 100;
    const theirs = Math.round((q2.suggested + 0.2) * 100) / 100;
    assert.equal((await call('clerk', 'PUT', '/costing/enquiries/prices', { items: [{ id: a.id, prices: [{ qty: q1.qty, final: mine }] }] })).status, 200);
    assert.deepEqual(await stamps(a.id), [[q1.qty, mine, null], [q2.qty, q2.suggested, true]], 'the quantity left out keeps its stamp');
    assert.equal((await call('md', 'PUT', '/costing/enquiries/prices', { items: [{ id: a.id, prices: [{ qty: q2.qty, final: theirs }] }] })).status, 200);
    assert.deepEqual(await stamps(a.id), [[q1.qty, mine, null], [q2.qty, theirs, null]]);
    // Approving item 2 makes no reply: item 1's prices changed after its approval.
    const r = await approve('md', [b.id]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.replies, []);
    assert.deepEqual(r.body.waiting, [{ mail_id: mail, waiting: [{ enquiry_no: one, why: 'price changed after approval — Approve again' }], quoted: [] }]);
    assert.deepEqual(await quotesOf(mail), []);
    assert.equal((await deskRow(b.id)).reply.waiting[0].why, 'price changed after approval — Approve again');
    // Approve again on item 1: the typed figures are kept and stamped, and the mail's one reply goes out at them.
    const again = await approve('md', [a.id]);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual(await stamps(a.id), [[q1.qty, mine, true], [q2.qty, theirs, true]]);
    assert.equal(again.body.replies.length, 1);
    const qt = await db.one('SELECT lines FROM quotations WHERE id = $1', [again.body.replies[0].quotations[0].id]);
    assert.deepEqual(qt.lines.filter(l => l.enquiry_no === one).map(l => [l.qty, l.rate]), [[q1.qty, mine], [q2.qty, theirs]]);
    assert.ok(qt.lines.every(l => !('ok' in l) && !('by' in l)), 'neither mark reaches a quotation line');
  });

  test("after a costing correction, Approve prices again what it priced itself, never a person's price", async () => {
    // The second item is held (no pasting, a size no costing here has had): the mail's reply waits, the first stays in To price.
    const [one] = await fileMail(NORTHWIND, [ITEM('NW REPRICE CARTON'), ITEM('NW REPRICE HELD CARTON', { size_text: '175x69x119', style: null, quantities: [5000] })], { cost: true });
    const a = await rowOf(one);
    const stored = async () => (await db.one('SELECT final_prices FROM enquiries WHERE id = $1', [a.id])).final_prices.map(f => [f.qty, f.final, f.by ?? null]);
    assert.equal((await approve('md', [a.id])).status, 200);
    const [q1, q2] = (await deskRow(a.id)).prices;
    assert.deepEqual(await stored(), [[q1.qty, q1.suggested, 'approve'], [q2.qty, q2.suggested, 'approve']], "Approve's own prices are marked");
    // A person sets the first quantity's price: it is theirs, unmarked; the quantity they left stays Approve's.
    const mine = Math.round((q1.suggested + 0.37) * 100) / 100;
    assert.equal((await call('clerk', 'PUT', '/costing/enquiries/prices', { items: [{ id: a.id, prices: [{ qty: q1.qty, final: mine }] }] })).status, 200);
    assert.deepEqual(await stored(), [[q1.qty, mine, null], [q2.qty, q2.suggested, 'approve']]);
    // The costing is corrected: the quote moves, the costing is Draft again, the row keeps its prices (flagged as changed).
    const c = (await call('clerk', 'GET', `/costing/costings/${a.costing_id}`)).body;
    const put = await call('clerk', 'PUT', `/costing/costings/${c.id}`, { enquiry_id: a.id, customer_name: c.customer_name, product_name: c.product_name,
      size_text: c.size_text, style: c.style, inputs: { ...c.inputs, board_rate: c.inputs.board_rate + 20 } });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    const moved = await deskRow(a.id);
    assert.deepEqual([moved.stage, moved.costing_status], ['price_pending', 'draft']);
    assert.ok(moved.prices.every(p => p.changed), 'both prices were set against the old costing');
    assert.ok(moved.prices[1].suggested > q2.suggested, 'the corrected costing quotes more');
    // Approve again: its own price follows the corrected quote; the person's stands.
    const again = await approve('md', [a.id]);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.ok(again.body.undo, 'the new price can be undone');
    assert.deepEqual(await stored(), [[q1.qty, mine, null], [q2.qty, moved.prices[1].suggested, 'approve']]);
    assert.equal((await deskRow(a.id)).prices[1].changed, false);
  });

  test("a person's price for one quantity stands, and Approve fills the other", async () => {
    const [one] = await fileMail(BLUEFIN, [ITEM('BL PERSON AND APPROVE CARTON')], { cost: true });
    const a = await rowOf(one);
    const [q1, q2] = (await deskRow(a.id)).prices;
    const mine = Math.round((q1.suggested + 0.25) * 100) / 100;
    assert.equal((await call('clerk', 'PUT', '/costing/enquiries/prices', { items: [{ id: a.id, prices: [{ qty: q1.qty, final: mine }] }] })).status, 200);
    const r = await approve('md', [a.id]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const e = (await call('clerk', 'GET', `/costing/enquiries/${a.id}`)).body;
    assert.deepEqual(e.final_prices.map(f => [f.qty, f.final, f.by ?? null]), [[q1.qty, mine, null], [q2.qty, q2.suggested, 'approve']]);
    // The mail's one item: its reply is made at those prices, and the mark never reaches a quotation line.
    const qt = await db.one(`SELECT lines FROM quotations WHERE id = $1`, [r.body.replies[0].quotations[0].id]);
    assert.deepEqual(qt.lines.map(l => [l.qty, l.rate]), [[q1.qty, mine], [q2.qty, q2.suggested]]);
    assert.ok(qt.lines.every(l => !('by' in l) && !('ok' in l)));
  });

  test('a press that runs out of time leaves the next mail to Approve again, and says so', async () => {
    const [one] = await fileMail(BLUEFIN, [ITEM('BL LATER ONE CARTON')], { cost: true });
    const [two] = await fileMail(NORTHWIND, [ITEM('NW LATER TWO CARTON')], { cost: true });
    const a = await rowOf(one), b = await rowOf(two);
    const ma = await mailOf(a.id), mb = await mailOf(b.id);
    // The reply step's budget (15 s on the plant) set to nothing: it still always takes one mail.
    process.env.ENQUIRY_REPLY_BUDGET_MS = '0';
    let r;
    try { r = await approve('md', [a.id, b.id]); } finally { delete process.env.ENQUIRY_REPLY_BUDGET_MS; }
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.approved.map(x => x.enquiry_no), [one, two], 'both approved');
    assert.deepEqual(r.body.replies.map(x => x.mail_id), [ma]);
    assert.deepEqual(r.body.later, [{ mail_id: mb, why: 'reply not made yet — press Approve again' }]);
    assert.deepEqual(await quotesOf(mb), []);
    const again = await approve('md', [b.id]);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual([again.body.replies.map(x => x.mail_id), again.body.later], [[mb], []]);
    assert.equal((await quotesOf(mb)).length, 1);
  });
});
