import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// Send back, pull back and the job-card reverses on a SPLIT gang child, through
// the REAL app against a real Postgres with the app's own schema and demo seed.
//
// After die cutting a gang run splits into one CHILD card per member line
// (helpers.js splitGangParentJob). A child carries its own order_line_id AND the
// run's gang_run_id. Each child is its own pile from then on — the same rule
// lineIdsClosedBy() applies to the dispatched gates: a card with an order line
// of its own stands alone; only a RUN card (order_line_id NULL: an unsplit gang
// parent or a combined run) speaks for the whole run.
//
// The reverses used to widen any card with a gang_run_id to every card on the
// run, so a child's Send back was refused over a partner's state (or dragged a
// running partner back with it), a child's pull-back rewrote the split parent,
// and reversing a child's line to Planning sent EVERY member line to planned
// while deleting one child card — the CI-JC-0317 orphan (2026-09-10).
//
// Opt-in: boots its OWN throwaway Postgres in a temp dir on a free port, with
// PG_POOL_MAX=1 (the Vercel geometry — a pool call inside a transaction hangs).
//
//   GANG_CHILD_PG=1 node --test src/gang-child-send-back-pg.test.js

const ENABLED = process.env.GANG_CHILD_PG === '1';

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.unref();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

describe('a split gang child sent back, pulled back and reversed — through the real app', {
  skip: ENABLED ? false : 'set GANG_CHILD_PG=1 to boot a throwaway Postgres',
}, () => {
  let epg, dir, db, server, base, jwt, secret;
  const tokens = {};
  // One split gang, three children — the shape of CI-GANG-0090 plus one.
  const G = {};

  before(async () => {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gang-child-send-back-'));
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
    await db.connect();
    await db.init();
    const { seedIfEmpty } = await import('./seed.js');
    await seedIfEmpty();

    ({ default: jwt } = await import('jsonwebtoken'));
    ({ JWT_SECRET: secret } = await import('./auth.js'));
    for (const [key, approver] of [['floor', 0], ['head', 1]]) {
      const u = await db.one(
        `INSERT INTO users (name, email, password_hash, role, reverse_approver)
         VALUES ($1, $2, 'x', 'admin', $3) RETURNING id, name, role`,
        [`Send-back ${key}`, `send-back-${key}@test.local`, approver]);
      tokens[key] = jwt.sign({ id: u.id, name: u.name, role: u.role }, secret);
    }

    const { default: app } = await import('./app.js');
    server = await new Promise(res => { const s = app.listen(0, () => res(s)); });
    base = `http://127.0.0.1:${server.address().port}/api`;

    // A 3-member gang whose parent has cut and printed, die cutting running.
    const order = await db.one(
      `INSERT INTO orders (po_number, customer_id, po_date, delivery_date, status)
       VALUES ('SB-GANG', 1, CURRENT_DATE::text, CURRENT_DATE::text, 'pending') RETURNING id`);
    const run = await db.one(
      `INSERT INTO gang_runs (gang_number, kind, created_by) VALUES ('CI-GANG-SB01', 'gang', 'test') RETURNING id`);
    G.run = run.id;
    const mkLine = async (productId, qty) => (await db.one(
      `INSERT INTO order_lines (order_id, product_id, qty, rate, status, gang_run_id,
                               artwork_customer_ok, artwork_qa_ok, artwork_locked)
       VALUES ($1,$2,$3,1,'in_production',$4,1,1,1) RETURNING id`, [order.id, productId, qty, run.id])).id;
    G.LA = await mkLine(1, 1000);
    G.LB = await mkLine(4, 800);
    G.LC = await mkLine(2, 1200);
    G.parent = (await db.one(
      `INSERT INTO job_cards (jc_number, order_line_id, gang_run_id, product_id, qty_planned, sheets_issued,
                              children_per_parent, status, machine_id, finalised_at)
       VALUES ('CI-GANG-JC-SB01', NULL, $1, 1, 3000, 100, 1, 'in_progress',
               (SELECT id FROM machines ORDER BY id LIMIT 1), now()) RETURNING id`, [run.id])).id;
    const mkStage = (seq, stage, status) => db.q(
      `INSERT INTO job_stages (job_card_id, seq, stage, unit, status, qty_in, qty_out, operator, started_at, completed_at)
       VALUES ($1,$2,$3,'sheets',$4,100,CASE WHEN $4='completed' THEN 100 END,'test', now(),
               CASE WHEN $4='completed' THEN now() END)`, [G.parent, seq, stage, status]);
    await mkStage(1, 'cutting', 'completed');
    await mkStage(2, 'printing', 'completed');
    await mkStage(3, 'die_cutting', 'in_progress');
  });

  after(async () => {
    server?.close();
    try { await (await db?.connect())?.end(); } catch {}
    try { await epg?.stop(); } catch {}
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const call = async (method, url, body, who = 'floor') => {
    const res = await fetch(base + url, {
      method, headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, body: json };
  };
  const stageOf = (jcId, stage) => db.one('SELECT * FROM job_stages WHERE job_card_id=$1 AND stage=$2', [jcId, stage]);
  const cardOf = id => db.one('SELECT id, jc_number, status, finalised_at, machine_id, queue_pos FROM job_cards WHERE id=$1', [id]);
  const lineOf = id => db.one('SELECT id, status, machine_id, artwork_locked FROM order_lines WHERE id=$1', [id]);
  const runsOf = async stageId => (await db.one('SELECT COUNT(*)::int AS n FROM stage_runs WHERE job_stage_id=$1', [stageId])).n;
  const startSorting = async jcId => call('POST', `/job-stages/${(await stageOf(jcId, 'sorting')).id}/start`,
    { line_clearance: ['Machine clean', 'Previous job removed'], operator: 'test' });
  const addRun = async stageId => db.q(
    `INSERT INTO stage_runs (job_stage_id, seq, qty_good, qty_scrap, created_by)
     VALUES ($1, COALESCE((SELECT MAX(seq) FROM stage_runs WHERE job_stage_id=$1), 0) + 1, 100, 0, 'test')`, [stageId]);
  // Everything a child's move must NOT touch, read in one go.
  const snapshot = async ids => Promise.all([
    cardOf(G.parent),
    ...ids.map(async id => ({ card: await cardOf(id), sorting: await stageOf(id, 'sorting'), runs: await runsOf((await stageOf(id, 'sorting')).id) })),
  ]);

  test('die cutting completes and the gang splits into one child per line (the real split)', async () => {
    const die = await stageOf(G.parent, 'die_cutting');
    const r = await call('POST', `/job-stages/${die.id}/complete`, { qty_out: 100, qty_scrap: 0 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const kids = await db.q('SELECT id, order_line_id FROM job_cards WHERE parent_job_card_id=$1 ORDER BY order_line_id', [G.parent]);
    assert.equal(kids.length, 3);
    for (const k of kids) G[{ [G.LA]: 'CA', [G.LB]: 'CB', [G.LC]: 'CC' }[k.order_line_id]] = k.id;
    assert.equal((await cardOf(G.parent)).status, 'split');
  });

  test("a child's Send back from sorting stays with the child — a partner not started does not refuse it", async () => {
    assert.equal((await startSorting(G.CA)).status, 200);
    const sort = await stageOf(G.CA, 'sorting');
    await addRun(sort.id);
    const plan = await call('GET', `/job-stages/${sort.id}/reverse-plan`);
    assert.equal(plan.status, 200, JSON.stringify(plan.body));
    assert.equal(plan.body.target, 'sorting', 'back into its own Sort & Paste queue — not Print Planning');
    assert.equal(plan.body.gang, false);
    assert.equal(plan.body.cards, 1);
    assert.equal(plan.body.pull_back, false, 'a child has no Job Card step to be pulled back to');
    assert.equal(plan.body.child_of, 'CI-GANG-JC-SB01');
  });

  test('…and the floor (no plant-head flag) can do it: only the child is un-started', async () => {
    const before = await snapshot([G.CB, G.CC]);
    const sort = await stageOf(G.CA, 'sorting');
    const r = await call('POST', `/job-stages/${sort.id}/send-back`, { reason: 'wrong stack started' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.target, r.body.cards, r.body.gang], ['sorting', 1, false]);
    const after = await stageOf(G.CA, 'sorting');
    assert.equal(after.status, 'pending');
    assert.equal(await runsOf(after.id), 0);
    assert.equal((await cardOf(G.CA)).status, 'open');
    assert.equal((await lineOf(G.LA)).status, 'in_production');
    assert.deepEqual(await snapshot([G.CB, G.CC]), before, 'the split parent and the partners are untouched');
  });

  test('partners running alongside are left exactly as they are', async () => {
    for (const jc of [G.CA, G.CB, G.CC]) assert.equal((await startSorting(jc)).status, 200);
    for (const jc of [G.CB, G.CC]) await addRun((await stageOf(jc, 'sorting')).id);
    const before = await snapshot([G.CB, G.CC]);
    const r = await call('POST', `/job-stages/${(await stageOf(G.CA, 'sorting')).id}/send-back`, { reason: 'recount' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await snapshot([G.CB, G.CC]), before, "a partner's running sorting and its day counts survive");
  });

  test('pull-back is refused on a child — before anything is written', async () => {
    assert.equal((await startSorting(G.CA)).status, 200);
    const before = await snapshot([G.CA, G.CB, G.CC]);
    const lines = await Promise.all([G.LA, G.LB, G.LC].map(lineOf));
    const r = await call('POST', `/job-stages/${(await stageOf(G.CA, 'sorting')).id}/pull-back`, { reason: 'try' }, 'head');
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.match(r.body.error, /CI-GANG-JC-SB01/);
    assert.deepEqual(await snapshot([G.CA, G.CB, G.CC]), before);
    assert.deepEqual(await Promise.all([G.LA, G.LB, G.LC].map(lineOf)), lines);
  });

  test('a partner that has CLOSED no longer refuses the child', async () => {
    const cc = await stageOf(G.CC, 'sorting');
    const done = await call('POST', `/sort-paste/${G.CC}/complete`, {
      sorted_waste: 0, packing_lines: [],
      rows: [{ method: 'machine', input_qty: cc.qty_in, auto_qty: cc.qty_in, manual_qty: 0, waste_qty: 0 }],
    });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal((await cardOf(G.CC)).status, 'closed');
    const r = await call('POST', `/job-stages/${(await stageOf(G.CA, 'sorting')).id}/send-back`, { reason: 'again' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await cardOf(G.CC)).status, 'closed');
  });

  test("the reverse preview for a child's line says it cannot go back on its own", async () => {
    const r = await call('GET', `/workflow/order-lines/${G.LA}/reverse-preview`);
    assert.equal(r.status, 200);
    assert.equal(r.body.gang, false);
    assert.equal(r.body.jobs, 1);
    assert.match(r.body.blocked || '', /CI-GANG-JC-SB01/);
  });

  test("reversing a child's line to Planning / the Job Card / To Plan is refused — nothing moves (the CI-JC-0317 orphan)", async () => {
    const before = {
      cards: await db.q('SELECT id, status FROM job_cards WHERE gang_run_id=$1 ORDER BY id', [G.run]),
      lines: await db.q('SELECT id, status, artwork_locked, gang_run_id FROM order_lines WHERE gang_run_id=$1 ORDER BY id', [G.run]),
    };
    for (const action of ['reverse_job_card', 'reverse_to_planning', 'reverse_plan']) {
      const r = await call('POST', `/workflow/order-lines/${G.LA}`, { action, force: true, note: 'test' });
      assert.equal(r.status, 409, `${action}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, 'SPLIT_GANG_CHILD', action);
    }
    assert.deepEqual(await db.q('SELECT id, status FROM job_cards WHERE gang_run_id=$1 ORDER BY id', [G.run]), before.cards);
    assert.deepEqual(await db.q('SELECT id, status, artwork_locked, gang_run_id FROM order_lines WHERE gang_run_id=$1 ORDER BY id', [G.run]), before.lines);
    assert.ok(await db.one('SELECT id FROM gang_runs WHERE id=$1', [G.run]), 'the gang row is intact');
  });

  test("rolling a child's line back to the sales order (or deleting it) is refused — even once its sorting is un-started", async () => {
    // The in-place send-back leaves the child all-pending, which is exactly
    // what rollbackLine's own guard used to accept before deleting the card.
    const sort = await stageOf(G.CA, 'sorting');
    if (sort.status !== 'pending') {
      const back = await call('POST', `/job-stages/${sort.id}/send-back`, { reason: 'before rollback' });
      assert.equal(back.status, 200, JSON.stringify(back.body));
    }
    const before = { card: await cardOf(G.CA), line: await lineOf(G.LA),
      gang: (await db.one('SELECT gang_run_id FROM order_lines WHERE id=$1', [G.LA])).gang_run_id };
    for (const mode of ['rollback', 'delete']) {
      const r = await call('POST', `/order-lines/${G.LA}/rollback`, { mode, note: 'test' });
      assert.equal(r.status, 409, `${mode}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, 'SPLIT_GANG_CHILD', mode);
      assert.match(r.body.error, /CI-GANG-JC-SB01/);
    }
    assert.deepEqual(await cardOf(G.CA), before.card, 'the child card is still there');
    assert.deepEqual(await lineOf(G.LA), before.line);
    assert.equal((await db.one('SELECT gang_run_id FROM order_lines WHERE id=$1', [G.LA])).gang_run_id, before.gang, 'still in its gang');
  });

  test('a line whose child card is already gone falls to the split parent — refused, not unwound', async () => {
    // The CI-JC-0317 aftermath: line 662's child was deleted by the old reverse.
    await db.q('DELETE FROM job_stages WHERE job_card_id=$1', [G.CB]);
    await db.q('DELETE FROM job_cards WHERE id=$1', [G.CB]);
    const r = await call('POST', `/workflow/order-lines/${G.LB}`, { action: 'reverse_to_planning', force: true, note: 'test' });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, 'SPLIT_GANG_CHILD');
    assert.match(r.body.error, /split/);
    assert.equal((await lineOf(G.LB)).status, 'in_production');
    assert.equal((await cardOf(G.parent)).status, 'split');
    const rb = await call('POST', `/order-lines/${G.LB}/rollback`, { mode: 'rollback', note: 'test' });
    assert.equal(rb.status, 409, JSON.stringify(rb.body));
    assert.match(rb.body.error, /repair by the admin/);
    assert.equal((await lineOf(G.LB)).status, 'in_production');
  });

  // ── Regressions: a RUN card still moves as one ───────────────────────────────
  test('an unsplit gang at cutting still goes back to Print Planning as a whole gang, behind the flag', async () => {
    const order = await db.one(
      `INSERT INTO orders (po_number, customer_id, po_date, delivery_date, status)
       VALUES ('SB-GANG2', 1, CURRENT_DATE::text, CURRENT_DATE::text, 'pending') RETURNING id`);
    const run = await db.one(`INSERT INTO gang_runs (gang_number, kind, created_by) VALUES ('CI-GANG-SB02', 'gang', 'test') RETURNING id`);
    for (const p of [1, 4]) await db.q(
      `INSERT INTO order_lines (order_id, product_id, qty, rate, status, gang_run_id) VALUES ($1,$2,500,1,'in_production',$3)`,
      [order.id, p, run.id]);
    const card = await db.one(
      `INSERT INTO job_cards (jc_number, gang_run_id, product_id, qty_planned, sheets_issued, children_per_parent, status)
       VALUES ('CI-GANG-JC-SB02', $1, 1, 1000, 50, 1, 'in_progress') RETURNING id`, [run.id]);
    const cut = await db.one(
      `INSERT INTO job_stages (job_card_id, seq, stage, unit, status, qty_in, operator, started_at)
       VALUES ($1, 1, 'cutting', 'sheets', 'in_progress', 50, 'test', now()) RETURNING id`, [card.id]);
    const plan = await call('GET', `/job-stages/${cut.id}/reverse-plan`);
    assert.equal(plan.status, 200, JSON.stringify(plan.body));
    assert.deepEqual([plan.body.target, plan.body.gang], ['print_planning', true]);
    assert.notEqual(plan.body.pull_back, false, 'a run card can still be pulled out to the Job Card');
    assert.equal((await call('POST', `/job-stages/${cut.id}/send-back`, { reason: 'x' })).status, 403, 'still needs the plant head');
    const r = await call('POST', `/job-stages/${cut.id}/send-back`, { reason: 'x' }, 'head');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.target, 'print_planning');
  });

  test('reversing an unsplit gang member still brings the whole run back — every line planned, the run card gone', async () => {
    const order = await db.one(
      `INSERT INTO orders (po_number, customer_id, po_date, delivery_date, status)
       VALUES ('SB-GANG3', 1, CURRENT_DATE::text, CURRENT_DATE::text, 'pending') RETURNING id`);
    const run = await db.one(`INSERT INTO gang_runs (gang_number, kind, created_by) VALUES ('CI-GANG-SB03', 'gang', 'test') RETURNING id`);
    const lines = [];
    for (const p of [1, 4]) lines.push((await db.one(
      `INSERT INTO order_lines (order_id, product_id, qty, rate, status, gang_run_id) VALUES ($1,$2,500,1,'in_production',$3) RETURNING id`,
      [order.id, p, run.id])).id);
    const card = await db.one(
      `INSERT INTO job_cards (jc_number, gang_run_id, product_id, qty_planned, sheets_issued, children_per_parent, status)
       VALUES ('CI-GANG-JC-SB03', $1, 1, 1000, 50, 1, 'open') RETURNING id`, [run.id]);
    await db.q(`INSERT INTO job_stages (job_card_id, seq, stage, unit, status) VALUES ($1, 1, 'cutting', 'sheets', 'pending')`, [card.id]);
    const r = await call('POST', `/workflow/order-lines/${lines[0]}`, { action: 'reverse_job_card', note: 'test' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await db.one('SELECT id FROM job_cards WHERE id=$1', [card.id]), null, 'the run card is gone');
    assert.deepEqual((await db.q('SELECT status FROM order_lines WHERE id = ANY($1::int[]) ORDER BY id', [lines])).map(l => l.status),
      ['planned', 'planned'], 'both members came back');
  });

  test('a combined run still sends its sorting back to die cutting', async () => {
    const order = await db.one(
      `INSERT INTO orders (po_number, customer_id, po_date, delivery_date, status)
       VALUES ('SB-MRG', 1, CURRENT_DATE::text, CURRENT_DATE::text, 'pending') RETURNING id`);
    const run = await db.one(`INSERT INTO gang_runs (gang_number, kind, product_id, created_by) VALUES ('CI-MRG-SB01', 'merge', 6, 'test') RETURNING id`);
    for (let i = 0; i < 2; i++) await db.q(
      `INSERT INTO order_lines (order_id, product_id, qty, rate, status, gang_run_id) VALUES ($1,6,500,1,'in_production',$2)`,
      [order.id, run.id]);
    const card = await db.one(
      `INSERT INTO job_cards (jc_number, gang_run_id, product_id, qty_planned, sheets_issued, children_per_parent, status)
       VALUES ('CI-JC-SB-M', $1, 6, 1000, 46, 1, 'in_progress') RETURNING id`, [run.id]);
    await db.q(`INSERT INTO job_stages (job_card_id, seq, stage, unit, status, qty_in, qty_out, operator, started_at, completed_at)
                VALUES ($1, 1, 'die_cutting', 'sheets', 'completed', 46, 46, 'test', now(), now())`, [card.id]);
    const sort = await db.one(`INSERT INTO job_stages (job_card_id, seq, stage, unit, status, qty_in, operator, started_at)
                VALUES ($1, 2, 'sorting', 'cartons', 'in_progress', 1000, 'test', now()) RETURNING id`, [card.id]);
    const r = await call('POST', `/job-stages/${sort.id}/send-back`, { reason: 'x' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.target, 'die_cutting');
  });
});
