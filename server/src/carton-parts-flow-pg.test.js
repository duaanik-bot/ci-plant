import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// A carton made in parts, end to end on a real Postgres with the app's schema,
// through the real routes (carton-parts.js holds every rule, contract C1–C9):
// PO → hidden part lines → each part on its own board → part cards end at die
// cutting → a pasting card sized to the scarcer part → FG only ever the carton.
// Beside the flow: the guards, the doors that refuse a carton or a part, the PO
// import, the order warnings, the sales views that list the carton once, a
// master that changes its parts list under open orders, the cartons that must
// NOT convert, and pieces per carton above one.
//
// ORDER MATTERS. The tests share one database and run in file order:
//   • The first nine walk ONE order, PO 02545 (carton SW-715), through the whole
//     flow, each continuing from the one before: booked, then converted when
//     SW-715's two parts are saved → edited → Planning → guards → Part 1
//     die-cut → pendency mid-flight → Part 2 die-cut and the pasting card →
//     pendency after it → completed. None of them runs alone.
//   • Every later test that books SW-715 relies on the two parts the first one
//     saved on its master (the pasting-card test clears them and puts them back).
//   • The PO import and order-warnings tests expect SW-716 (GM1) to carry the
//     same two parts; the conversion test just before them gives it them.
//   • "the whole list cleared" continues the carton "a part taken off the
//     master" leaves.
//   • Otherwise each test books its own PO — on a carton of its own wherever it
//     edits a master — and asserts only on what it made, or on invariants that
//     hold whatever ran before it. The Task 13a tests at the end also make any
//     product they add INSIDE the test (newProduct), never in `before`: a new
//     name there would join the PO import's candidates for every test.
//
// Opt-in: it boots its OWN throwaway embedded Postgres in a temp dir on a free
// port and deletes it afterwards. It never touches a shared or remote database.
// The lock-order races live beside it in carton-parts-lock-order-pg.test.js.
//
//   CARTON_PARTS_PG=1 node --test src/carton-parts-flow-pg.test.js

const ENABLED = process.env.CARTON_PARTS_PG === '1';

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.unref();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

describe('carton made in parts — the whole flow, through the real routes', {
  skip: ENABLED ? false : 'set CARTON_PARTS_PG=1 to boot a throwaway Postgres',
  timeout: 300_000,
}, () => {
  let epg, dir, db, pool, helpers, cpdb, server, base;
  const ids = {};

  before(async () => {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carton-parts-flow-'));
    const port = await freePort();
    epg = new EmbeddedPostgres({ databaseDir: dir, port, user: 'postgres', password: 'postgres',
      persistent: false, onLog: () => {}, onError: () => {} });
    await epg.initialise();
    await epg.start();
    process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
    db = await import('./db.js');
    pool = await db.connect();
    pool.on('error', () => {});   // a stopped server must never crash the cleanup
    await db.init();
    helpers = await import('./helpers.js');
    cpdb = await import('./carton-parts-db.js');

    const one = db.one;
    // A non-zero dispatch tolerance, so a part line that copies its carton's is
    // told apart from one left at the column's default.
    ids.cust = (await one(`INSERT INTO customers (name, tolerance_pct) VALUES ('Swiss Garnier Life Sciences', 5) RETURNING id`)).id;
    ids.boardA = (await one(`INSERT INTO materials (name, category, sheet_l, sheet_w) VALUES ('Saffire 290 20x38','board',20,38) RETURNING id`)).id;
    ids.boardB = (await one(`INSERT INTO materials (name, category, sheet_l, sheet_w) VALUES ('Saffire 290 12x18','board',12,18) RETURNING id`)).id;
    const prod = async (code, name, board, ups, l, w) => (await one(
      `INSERT INTO products (customer_id, name, code, board_material_id, ups, child_l, child_w, parent_l, parent_w)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$6,$7) RETURNING id`, [ids.cust, name, code, board, ups, l, w])).id;
    // Each part gets a code of its own. One that starts with its carton's
    // ("SW-715-P1") is read by the PO import as the carton itself — it finds a
    // code by its words, cartons first — so the import case could never reach
    // a part by its code.
    ids.outer = await prod('SW-715', 'VOGEAB GM2 OUTER', ids.boardA, 2, 12, 18);
    ids.p1 = await prod('SW-770', 'VOGEAB GM2 OUTER PART 1', ids.boardA, 4, 20, 38);
    ids.p2 = await prod('SW-771', 'VOGEAB GM2 OUTER PART 2', ids.boardB, 2, 12, 18);
    ids.outer2 = await prod('SW-716', 'VOGEAB GM1 OUTER', ids.boardA, 2, 12, 18);
    ids.plain = await prod('SW-100', 'VOGEAB GM2 INNER CARTON', ids.boardA, 2, 12, 18);
    // Cartons whose masters the list-change, non-conversion and pieces-per-carton
    // cases edit — one each, so no case moves another's parts — and a small pool
    // of part products they share (C1: a part may sit under several cartons).
    ids.o3 = await prod('SW-717', 'VOGEAB GM3 OUTER', ids.boardA, 2, 12, 18);
    ids.o4 = await prod('SW-718', 'VOGEAB GM4 OUTER', ids.boardA, 2, 12, 18);
    ids.o5 = await prod('SW-719', 'VOGEAB GM5 OUTER', ids.boardA, 2, 12, 18);
    ids.o6 = await prod('SW-720', 'VOGEAB GM6 OUTER', ids.boardA, 2, 12, 18);
    ids.k1 = await prod('SW-790', 'VOGEAB KIT PART A', ids.boardA, 4, 20, 38);
    ids.k2 = await prod('SW-791', 'VOGEAB KIT PART B', ids.boardB, 2, 12, 18);
    ids.k3 = await prod('SW-792', 'VOGEAB KIT PART C', ids.boardA, 2, 12, 18);
    ids.k4 = await prod('SW-793', 'VOGEAB KIT PART D', ids.boardB, 2, 12, 18);
    for (const m of [ids.boardA, ids.boardB]) {
      await db.q(`INSERT INTO stock_batches (material_id, batch_no, qty, initial_qty, unit, status)
                  VALUES ($1,'T-1',50000,50000,'sheets','available')`, [m]);
    }

    const { default: express } = await import('express');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: 1, role: 'admin', name: 'parts test' }; next(); });
    // Mounted in app.js's own order.
    for (const f of ['orders', 'import', 'production', 'floor', 'workflow', 'fg', 'gangs', 'product-parts']) {
      app.use('/api', (await import(`./routes/${f}.js`)).default);
    }
    app.use((e, _req, res, _next) => res.status(e.status || 500).json({ error: e.message, ...(e.body || {}) }));
    server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}/api`;
  });

  // Cleanup can never hang the suite or leave the cluster directory behind.
  after(async () => {
    const within = (p, ms) => Promise.race([Promise.resolve(p).catch(() => {}), new Promise(r => setTimeout(r, ms).unref())]);
    if (server) { server.closeAllConnections?.(); await within(new Promise(r => server.close(r)), 5000); }
    if (pool) await within(pool.end(), 5000);
    if (epg) await within(epg.stop(), 10_000);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  };
  const get = async url => {
    const r = await call('GET', url);
    assert.equal(r.status, 200, `GET ${url}: ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const newPo = async (po_number, lines) => {
    const r = await call('POST', '/orders', { po_number, customer_id: ids.cust, lines });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  // A product made inside a test, never in `before`: a new name there would sit
  // among the PO import's candidates for every test (its matcher reads names).
  const newProduct = async (code, name, board = ids.boardA) => (await db.one(
    `INSERT INTO products (customer_id, name, code, board_material_id, ups, child_l, child_w, parent_l, parent_w)
     VALUES ($1,$2,$3,$4,2,12,18,12,18) RETURNING id`, [ids.cust, name, code, board])).id;
  const partLines = (lineId = ids.line) =>
    db.q('SELECT * FROM order_lines WHERE part_of_line_id=$1 ORDER BY product_id', [lineId]);
  const lineOf = id => db.one('SELECT * FROM order_lines WHERE id=$1', [id]);
  const cartonOf = (orderId, productId = ids.outer) => db.one(
    'SELECT * FROM order_lines WHERE order_id=$1 AND product_id=$2 AND part_of_line_id IS NULL ORDER BY id LIMIT 1',
    [orderId, productId]);
  const byId = (a, b) => a - b;
  const BOTH_PARTS = () => ({ parts: [
    { part_product_id: ids.p1, label: 'Part 1', per_carton: 1 },
    { part_product_id: ids.p2, label: 'Part 2', per_carton: 1 },
  ] });
  // Stand in for Planning: lock a part line as a planner would, then push it to
  // its own card through the same helper the push route calls.
  const pushPart = async (lineId, sheets) => {
    await db.q(`UPDATE order_lines SET status='ready', artwork_locked=1, sheets_required=$2, parent_sheets_required=$2 WHERE id=$1`,
      [lineId, sheets]);
    const cardId = await db.tx((qc, oc) => helpers.createJobCardForLine(lineId, qc, oc, 'test'));
    return db.one('SELECT * FROM job_cards WHERE id=$1', [cardId]);
  };
  const auditOf = (entity, id, action) => db.q(
    'SELECT detail FROM audit_log WHERE entity=$1 AND entity_id=$2 AND action=$3 ORDER BY id', [entity, id, action]);
  // The one record of a hold given back by rollbackLine, exact.
  const holdReleased = async (materialId, lineId, qty) => (await auditOf('materials', materialId, 'board_hold_released'))
    .filter(r => r.detail === `${qty} sheets released from order line #${lineId} — held board freed when the plan was voided`).length;
  const FINISHED_PART = jc => `${jc} is a finished part — its pieces wait for, or are already on, the carton's pasting card, `
    + 'so it cannot be reversed to Planning, rolled back or deleted. If its die-cut count is wrong, ask an admin to correct it.';

  // ── The plan's flow: PO 02545, each test continuing the last ──────────────
  test('a PO booked BEFORE the parts exist converts when the parts are saved — each part copies its carton', async () => {
    const po = await newPo('02545', [{ product_id: ids.outer, qty: 11500, line_remark: 'B-7' }]);
    ids.order = po.id;
    ids.line = (await db.one('SELECT id FROM order_lines WHERE order_id=$1', [po.id])).id;
    assert.equal((await partLines()).length, 0);
    // The carton line's own delivery date (the Status Sheet's per-line EDD) and
    // its P1 star, set while it is still one carton.
    const edd = await call('PATCH', `/status-sheet/line/${ids.line}`, { delivery_date: '2026-10-15', is_p1: true });
    assert.equal(edd.status, 200, JSON.stringify(edd.body));

    const bad = await call('PUT', `/products/${ids.outer}/parts`, { parts: [{ part_product_id: ids.p1, label: 'Part 1' }] });
    assert.deepEqual([bad.status, bad.body.error], [400, 'A carton made in parts needs at least two parts — or none']);
    assert.equal((await partLines()).length, 0, 'a refused save writes nothing');

    const ok = await call('PUT', `/products/${ids.outer}/parts`, BOTH_PARTS());
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual([ok.body.synced, ok.body.warnings], [2, []]);
    const outer = await lineOf(ids.line);
    assert.deepEqual([outer.tolerance_pct, outer.delivery_date, outer.is_p1], [5, '2026-10-15', 1],
      'the carton: its customer\'s tolerance, its own EDD, its P1 star');
    // C3: rate 0, gst 0, qty = carton qty × per carton, the carton's batch,
    // tolerance, delivery date and P1 star — and the line remembers what it is.
    assert.deepEqual(
      (await partLines()).map(p => [p.order_id, p.product_id, p.qty, p.line_remark, +p.rate, +p.gst_pct, p.status,
        p.part_label, p.part_per_carton, p.tolerance_pct, p.delivery_date, p.is_p1]),
      [[ids.order, ids.p1, 11500, 'B-7', 0, 0, 'pending', 'Part 1', 1, 5, '2026-10-15', 1],
       [ids.order, ids.p2, 11500, 'B-7', 0, 0, 'pending', 'Part 2', 1, 5, '2026-10-15', 1]]);
    // C2: the carton line carries no board of its own.
    assert.deepEqual([outer.status, outer.sheets_required, outer.parent_sheets_required, outer.wastage_sheets],
      ['pending', 0, 0, 0]);
  });

  test('editing the carton qty moves both parts; a carton line added in an edit gets its parts, and taking it out takes them', async () => {
    const edit = lines => call('PUT', `/orders/${ids.order}`, { po_number: '02545', customer_id: ids.cust, lines });
    const main = { id: ids.line, product_id: ids.outer, qty: 12000, rate: 0, line_remark: 'B-7' };
    const res = await edit([main]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual((await partLines()).map(p => [p.qty, p.line_remark]), [[12000, 'B-7'], [12000, 'B-7']]);

    // A second batch of the same carton, added in the edit: its part lines are
    // made on the spot, and the order is warned that it now carries the carton
    // twice. Then dropped again: the carton leaves through rollbackLine and takes
    // its parts, on the record. (Both edits run before any check, so a failure
    // here never leaves a second carton behind for the tests that follow.)
    const two = await edit([main, { product_id: ids.outer, qty: 500, rate: 0, line_remark: 'B-8' }]);
    const added = two.body.lines?.find(l => !l.part_of_line_id && l.id !== ids.line);
    const addedParts = added ? await partLines(added.id) : [];
    const back = await edit([main]);

    assert.equal(two.status, 200, JSON.stringify(two.body));
    assert.deepEqual(two.body.warnings,
      ['SW-715 is made in parts and is on 2 lines of this order — order it once unless the customer really ordered it twice']);
    assert.deepEqual(addedParts.map(p => [p.product_id, p.qty, p.line_remark, p.part_label]),
      [[ids.p1, 500, 'B-8', 'Part 1'], [ids.p2, 500, 'B-8', 'Part 2']]);
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.equal(back.body.warnings, undefined);
    const goneIds = [added.id, ...addedParts.map(p => p.id)];
    assert.equal((await db.q('SELECT 1 FROM order_lines WHERE id = ANY($1::int[])', [goneIds])).length, 0);
    assert.deepEqual((await db.q('SELECT id FROM order_lines WHERE order_id=$1 ORDER BY id', [ids.order])).map(l => l.id),
      [ids.line, ...(await partLines()).map(p => p.id)].sort(byId));
    const gone = await db.q(`SELECT entity_id, detail FROM audit_log
                              WHERE entity='order_line' AND action='deleted_entirely' AND entity_id = ANY($1::int[])`, [goneIds]);
    assert.equal(gone.length, 3, 'the carton and each of its parts leave on the record');
    assert.equal(gone.find(g => g.entity_id === added.id).detail,
      'SW-715 VOGEAB GM2 OUTER · qty 500 — removed by order edit (was pending)');
  });

  test('Planning hides the carton and shows both parts, side by side, each on its own board', async () => {
    const list = await get('/planning');   // no scope: the legacy bare array, every row
    assert.ok(Array.isArray(list));
    assert.equal(list.some(r => r.id === ids.line), false);
    const mine = list.filter(r => r.part_of_line_id === ids.line);
    assert.deepEqual(mine.map(r => [r.product_id, r.board_material_id, r.part_label, r.outer_code]),
      [[ids.p1, ids.boardA, 'Part 1', 'SW-715'], [ids.p2, ids.boardB, 'Part 2', 'SW-715']]);
    assert.equal(list.indexOf(mine[1]) - list.indexOf(mine[0]), 1, 'the parts sit side by side');
  });

  test('parts cannot be cancelled alone; the carton cannot get a plain card', async () => {
    const [p1] = await partLines();
    const cancel = await call('POST', `/order-lines/${p1.id}/cancel`, {});
    assert.deepEqual([cancel.status, cancel.body.error],
      [409, 'This is one part of a carton made in parts — cancel or remove the carton, not its part']);
    const PLAIN_CARD = 'This carton is made in parts — push its parts; the pasting card is created by itself when every part is die-cut';
    await assert.rejects(() => db.tx((qc, oc) => helpers.createJobCardForLine(ids.line, qc, oc, 'test')),
      { status: 409, message: PLAIN_CARD });
    const card = await call('POST', `/order-lines/${ids.line}/job-card`, {});
    assert.deepEqual([card.status, card.body.error], [409, PLAIN_CARD]);
    assert.deepEqual([(await lineOf(ids.line)).status, ...(await partLines()).map(p => p.status)], ['pending', 'pending', 'pending']);
    assert.equal((await db.q('SELECT 1 FROM job_cards')).length, 0);
  });

  test('each part card ends at die cutting; one part die-cut is not yet a carton', async () => {
    const cards = [];
    for (const p of await partLines()) cards.push(await pushPart(p.id, Math.ceil(p.qty / (p.product_id === ids.p1 ? 4 : 2)) + 200));
    for (const c of cards) {
      assert.deepEqual((await db.q('SELECT stage FROM job_stages WHERE job_card_id=$1 ORDER BY seq', [c.id])).map(s => s.stage),
        ['cutting', 'printing', 'die_cutting']);
    }
    assert.deepEqual((await partLines()).map(p => p.status), ['in_production', 'in_production']);

    // Part 1: 3,050 sheets × 4 ups = 12,200 pieces. The carton waits for Part 2.
    assert.equal(await db.tx((qc, oc) => cpdb.closePartCard(cards[0], 3050, qc, oc, 'test')), 12200);
    assert.equal(await db.tx((qc, oc) => cpdb.maybeCreateAssemblyCard(ids.line, qc, oc, 'test')), null);
    assert.deepEqual(await db.one('SELECT status, qty_produced FROM job_cards WHERE id=$1', [cards[0].id]),
      { status: 'split', qty_produced: 12200 });
    assert.equal((await partLines())[0].status, 'in_production', 'C4: the part waits for its pasting card');
    ids.cards = cards;   // the tests that follow continue with these two cards
  });

  test('pendency mid-flight: the carton once, on the floor through its parts — never a part row', async () => {
    // The parts are in production, not pasted: only the part filter keeps their
    // rows out (a pasted part, 'dispatched', would drop out by its status alone).
    const parts = await partLines();
    assert.deepEqual(parts.map(p => p.status), ['in_production', 'in_production']);
    const { lines } = await get('/sales/pendency');
    assert.equal(lines.some(r => parts.some(p => p.id === r.line_id) || r.product_id === ids.p1 || r.product_id === ids.p2), false);
    const mine = lines.filter(r => r.order_id === ids.order);
    assert.deepEqual(mine.map(r => r.line_id), [ids.line]);
    // Every part has a card, so the carton reads in production (carton-status.js)
    // and is on the floor with its production-required qty — no card of its own yet.
    assert.deepEqual([mine[0].status, mine[0].jc_status, mine[0].on_floor, mine[0].wip_qty], ['in_production', null, true, 12000]);
    assert.deepEqual(mine[0].parts.map(p => [p.line_id, p.label, p.status, p.jc_status]),
      [[parts[0].id, 'Part 1', 'in_production', 'split'], [parts[1].id, 'Part 2', 'in_production', 'open']]);
  });

  test('the pasting card waits for BOTH parts — even with the master cleared mid-flight', async () => {
    const [jc1, jc2] = ids.cards;
    // The master's parts list is CLEARED while Part 2 is still on the floor: the
    // parts on this order are frozen, and they — not the master — decide pasting.
    // (It is put back in `finally`, so a failure here never strands the tests
    // that follow with a carton that has no parts on its master.)
    const cleared = await call('PUT', `/products/${ids.outer}/parts`, { parts: [] });
    let again;
    try {
      assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
      // Part 1 is already die-cut, so no rollback can take this carton back:
      // the warning offers none.
      assert.deepEqual([cleared.body.parts, cleared.body.synced, cleared.body.warnings], [[], 0, [
        'PO 02545 (12,000 · B-7): This carton is already under way as Part 1 + Part 2 — a changed parts list applies from the next order',
      ]]);
      assert.deepEqual((await partLines()).map(p => [p.product_id, p.status]), [[ids.p1, 'in_production'], [ids.p2, 'in_production']]);

      // Part 2: 6,020 sheets × 2 ups = 12,040 pieces → 12,040 cartons, 160 spare Part 1.
      assert.equal(await db.tx((qc, oc) => cpdb.closePartCard(jc2, 6020, qc, oc, 'test')), 12040);
      const asm = await db.tx((qc, oc) => cpdb.maybeCreateAssemblyCard(ids.line, qc, oc, 'test'));
      assert.ok(asm, 'both parts cut make the pasting card — decided by the order\'s own part lines, the master being empty');
      const card = await db.one('SELECT * FROM job_cards WHERE id=$1', [asm]);
      ids.pasting = card;   // the pendency test that follows reads it
      assert.deepEqual([card.is_assembly, card.qty_planned, card.sheets_issued, card.product_id, card.order_line_id, card.status],
        [true, 12040, 12040, ids.outer, ids.line, 'open']);
      assert.deepEqual((await db.q('SELECT stage, unit FROM job_stages WHERE job_card_id=$1 ORDER BY seq', [asm])).map(s => [s.stage, s.unit]),
        [['sorting', 'cartons'], ['pasting', 'cartons']]);
      // C5: each part walks to 'dispatched' with nothing dispatched — terminal, so
      // completion, pendency and dispatch never wait on it.
      assert.deepEqual((await partLines()).map(p => [p.status, p.dispatched_qty, p.completed_at]),
        [['dispatched', 0, null], ['dispatched', 0, null]]);
      const carton = await lineOf(ids.line);
      assert.deepEqual([carton.status, carton.sheets_required, carton.parent_sheets_required, carton.wastage_sheets, carton.artwork_locked],
        ['in_production', 0, 0, 0, 1]);
      // nothing but the carton may ever reach FG
      assert.equal((await db.q('SELECT 1 FROM fg_stock WHERE product_id = ANY($1::int[])', [[ids.p1, ids.p2]])).length, 0);
      // with the master cleared, each part still carries its own remembered label (C9)
      assert.deepEqual(await auditOf('job_card', asm, 'create_assembly'), [{ detail:
        `${card.jc_number} pastes Part 1 ${jc1.jc_number} (12200) + Part 2 ${jc2.jc_number} (12040) → 12040 cartons — spare Part 1 160` }]);
      // …and so does the printed card (its parts band): the pasting card names
      // each part card by the line's own label, and a part card names its carton.
      const pasting = await get(`/job-cards/${asm}`);
      assert.deepEqual([pasting.carton_parts.role, pasting.carton_parts.parts.map(p => [p.label, p.jc_number, p.qty_produced])],
        ['assembly', [['Part 1', jc1.jc_number, 12200], ['Part 2', jc2.jc_number, 12040]]]);
      const partCard = await get(`/job-cards/${jc2.id}`);
      assert.deepEqual(['role', 'label', 'outer_code', 'of_parts'].map(k => partCard.carton_parts[k]), ['part', 'Part 2', 'SW-715', 2]);
      assert.equal(await db.tx((qc, oc) => cpdb.maybeCreateAssemblyCard(ids.line, qc, oc, 'test')), asm, 'never a second pasting card');
    } finally {
      // Put the parts back for the tests that follow.
      again = await call('PUT', `/products/${ids.outer}/parts`, BOTH_PARTS());
    }
    // The carton is in production now: no open line is left for the save to follow.
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual([again.body.synced, again.body.warnings], [0, []]);
  });

  test('pendency after pasting: the carton rides its pasting card', async () => {
    // (Pasted, the part lines are 'dispatched' and drop out of pendency by their
    // status as well — the mid-flight test above is where the part filter itself
    // is proven.)
    const { lines } = await get('/sales/pendency');
    const mine = lines.filter(r => r.order_id === ids.order);
    assert.deepEqual(mine.map(r => r.line_id), [ids.line]);
    // With its pasting card the carton is its own line again: that card, open,
    // is what it has on the floor.
    assert.deepEqual([mine[0].status, mine[0].jc_number, mine[0].jc_status, mine[0].on_floor, mine[0].wip_qty],
      ['in_production', ids.pasting.jc_number, 'open', true, 12040]);
    assert.deepEqual(mine[0].parts.map(p => [p.product_id, p.label, p.status, p.jc_status]),
      [[ids.p1, 'Part 1', 'dispatched', 'split'], [ids.p2, 'Part 2', 'dispatched', 'split']]);
  });

  test('an order holding a pasted carton completes through both doors', async () => {
    // Stand in for Sort & Paste + dispatch: the carton shipped in full; its
    // parts were pasted (dispatched, dispatched_qty 0, completed_at NULL).
    await db.q(`UPDATE order_lines SET status='dispatched', dispatched_qty=qty WHERE id=$1`, [ids.line]);
    const lines = await call('POST', `/orders/${ids.order}/complete-lines`, { line_ids: [ids.line] });
    assert.equal(lines.status, 200, JSON.stringify(lines.body));
    assert.deepEqual(lines.body, { completed: [ids.line], order_completed: true });
    // The status door too: reopen (admin), then complete again.
    const reopen = await call('POST', `/orders/${ids.order}/status`, { status: 'pending' });
    assert.equal(reopen.status, 200, JSON.stringify(reopen.body));
    const done = await call('POST', `/orders/${ids.order}/status`, { status: 'completed' });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal((await db.one('SELECT status FROM orders WHERE id=$1', [ids.order])).status, 'completed');
  });

  // ── From here, each test books its own PO ─────────────────────────────────
  test('rolling back ONE part rolls back its whole carton — every part, the audited way', async () => {
    const po = await newPo('PO-RB-1', [{ product_id: ids.outer, qty: 300 }]);
    const carton = await cartonOf(po.id);
    const parts = await partLines(carton.id);
    await db.q(`UPDATE order_lines SET status='planned', sheets_required=200, parent_sheets_required=100
                WHERE id = ANY($1::int[])`, [parts.map(p => p.id)]);
    await db.q(`INSERT INTO board_allocations (material_id, order_line_id, qty, source) VALUES ($1,$2,50,'stock')`,
      [ids.boardB, parts[1].id]);
    const res = await call('POST', `/order-lines/${parts[0].id}/rollback`, { mode: 'rollback' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual([res.body.carton_line_id, res.body.message],
      [carton.id, 'Rolling back a part rolls back its whole carton — Part 1 + Part 2 returned to the sales order']);
    const after = await db.q('SELECT status, sheets_required, parent_sheets_required FROM order_lines WHERE id = ANY($1::int[]) ORDER BY id',
      [parts.map(p => p.id)]);
    assert.deepEqual(after.map(p => [p.status, p.sheets_required, p.parent_sheets_required]),
      [['pending', null, null], ['pending', null, null]]);
    assert.equal((await db.q(`SELECT 1 FROM board_allocations WHERE order_line_id=$1 AND status='active'`, [parts[1].id])).length, 0);
    assert.equal(await holdReleased(ids.boardB, parts[1].id, 50), 1, 'the hold is released on the record');
    // C8: a carton rolled back keeps 0/0/0, never NULL.
    const c = await lineOf(carton.id);
    assert.deepEqual([c.status, c.sheets_required, c.parent_sheets_required, c.wastage_sheets], ['pending', 0, 0, 0]);
  });

  test('deleting a carton undoes each part the one audited way — PR gone, hold released on record', async () => {
    const po = await newPo('PO-DEL-1', [{ product_id: ids.outer, qty: 500 }]);
    const carton = await cartonOf(po.id);
    const parts = await partLines(carton.id);
    assert.equal(parts.length, 2);
    // Raise PR has no status gate, so a PENDING part can carry a PR and a hold.
    await db.q(`INSERT INTO requisitions (pr_number, material_id, qty, order_line_id) VALUES ('PR-T-1',$1,300,$2)`, [ids.boardB, parts[1].id]);
    await db.q(`INSERT INTO board_allocations (material_id, order_line_id, qty, source) VALUES ($1,$2,120,'stock')`, [ids.boardA, parts[0].id]);

    const alone = await call('POST', `/order-lines/${parts[0].id}/rollback`, { mode: 'delete' });
    assert.deepEqual([alone.status, alone.body.error],
      [409, 'This is one part of a carton made in parts — cancel or remove the carton, not its part']);
    assert.equal((await db.q('SELECT 1 FROM order_lines WHERE id = ANY($1::int[])', [[carton.id, ...parts.map(p => p.id)]])).length, 3);

    const res = await call('POST', `/order-lines/${carton.id}/rollback`, { mode: 'delete' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await db.q('SELECT 1 FROM order_lines WHERE id = ANY($1::int[])', [[carton.id, ...parts.map(p => p.id)]])).length, 0);
    assert.equal((await db.q(`SELECT 1 FROM requisitions WHERE pr_number='PR-T-1'`)).length, 0);
    assert.equal(await holdReleased(ids.boardA, parts[0].id, 120), 1, 'the hold is released on the record');
    const deleted = await db.q(`SELECT entity_id FROM audit_log WHERE entity='order_line' AND action='deleted_entirely'
                                 AND entity_id = ANY($1::int[]) ORDER BY entity_id`, [[carton.id, ...parts.map(p => p.id)]]);
    assert.deepEqual(deleted.map(d => d.entity_id), [carton.id, ...parts.map(p => p.id)].sort(byId));
  });

  test('deleting a whole order that holds a carton takes each part through rollbackLine — its PR too', async () => {
    const po = await newPo('PO-DEL-2', [{ product_id: ids.outer, qty: 200 }]);
    const carton = await cartonOf(po.id);
    const parts = await partLines(carton.id);
    assert.equal(parts.length, 2);
    // A PR on Part 2: a raw DELETE of the part lines would trip its foreign key.
    await db.q(`INSERT INTO requisitions (pr_number, material_id, qty, order_line_id) VALUES ('PR-T-3',$1,100,$2)`, [ids.boardB, parts[1].id]);
    const del = await call('DELETE', `/orders/${po.id}`, {});
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.equal((await db.q('SELECT 1 FROM order_lines WHERE order_id=$1', [po.id])).length, 0);
    assert.equal((await db.q('SELECT 1 FROM orders WHERE id=$1', [po.id])).length, 0);
    assert.equal((await db.q(`SELECT 1 FROM requisitions WHERE pr_number='PR-T-3'`)).length, 0);
    // The rollbackLine path, on the record: the carton, then each part in its name.
    assert.deepEqual(await auditOf('order_line', carton.id, 'deleted_entirely'), [{ detail: 'Order PO-DEL-2 deleted' }]);
    for (const p of parts) {
      assert.deepEqual(await auditOf('order_line', p.id, 'deleted_entirely'),
        [{ detail: `its carton line #${carton.id} was deleted — Order PO-DEL-2 deleted` }]);
    }
    assert.deepEqual(await auditOf('order', po.id, 'deleted_entirely'), [{ detail: 'PO-DEL-2 — 1 line(s) removed' }],
      'the customer ordered one item');
  });

  test('a carton already planned as ONE job converts the one audited way when its parts are saved', async () => {
    const po = await newPo('PO-CONV', [{ product_id: ids.outer2, qty: 800 }]);
    const line = await db.one('SELECT * FROM order_lines WHERE order_id=$1', [po.id]);
    await db.q(`UPDATE order_lines SET status='planned', sheets_required=600, parent_sheets_required=300 WHERE id=$1`, [line.id]);
    await db.q(`INSERT INTO requisitions (pr_number, material_id, qty, order_line_id) VALUES ('PR-T-2',$1,300,$2)`, [ids.boardA, line.id]);
    // C1: the same part products may sit under several cartons (GM1 and GM2).
    const ok = await call('PUT', `/products/${ids.outer2}/parts`, { parts: [
      { part_product_id: ids.p1, label: 'Part 1' }, { part_product_id: ids.p2, label: 'Part 2' },
    ] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual([ok.body.synced, ok.body.warnings], [2, []]);
    const after = await lineOf(line.id);
    assert.deepEqual([after.status, after.sheets_required, after.parent_sheets_required, after.wastage_sheets], ['pending', 0, 0, 0]);
    assert.equal((await db.q(`SELECT 1 FROM requisitions WHERE pr_number='PR-T-2'`)).length, 0);
    assert.deepEqual((await partLines(line.id)).map(p => [p.product_id, p.qty, p.status]), [[ids.p1, 800, 'pending'], [ids.p2, 800, 'pending']]);
    // Rolled back the one audited way (C8), then made in parts.
    const trail = await db.q(`SELECT action, detail FROM audit_log WHERE entity='order_line' AND entity_id=$1 ORDER BY id`, [line.id]);
    assert.deepEqual(trail.slice(-2).map(t => [t.action, t.detail]), [
      ['rolled_back_to_sales_order', 'carton now made in parts — each part carries its own board'],
      ['made_in_parts', 'now made in parts — each part is planned and covered on its own board'],
    ]);
  });

  // ── Added cases (as built through the reviews) ────────────────────────────
  test('the PO import knows a part: its row suggests the carton, with a note — never an auto-match', async () => {
    const res = await call('POST', '/orders/import/rematch', { customer_id: ids.cust, lines: [
      { raw_text: 'VOGEAB GM2 OUTER CARTON', qty: 11500, rate: 12.5 },
      { raw_text: 'SW-770 VOGEAB GM2 OUTER PT-1', qty: 11500, rate: 7 },   // a part by its code
      { raw_text: 'VOGEAB GM2 OUTER PART 2', qty: 11500, rate: 5.5 },      // a part by its name
    ] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [carton, byCode, byName] = res.body.lines;
    assert.deepEqual([carton.match.status, carton.match.best?.product_id, carton.match.part_note], ['matched', ids.outer, undefined]);
    for (const [row, label] of [[byCode, 'Part 1'], [byName, 'Part 2']]) {
      assert.equal(row.match.status, 'suggested', row.raw_text);
      assert.equal(row.match.best, null, row.raw_text);
      // Both cartons that carry the part are offered (GM2 SW-715 and, since the
      // conversion test, GM1 SW-716) — and never the part itself.
      assert.deepEqual(row.match.suggestions.map(s => [s.product_id, s.code, s.part_label]),
        [[ids.outer, 'SW-715', label], [ids.outer2, 'SW-716', label]], row.raw_text);
      assert.equal(row.match.part_note, `${label} of SW-715, SW-716 — a carton made in parts is ordered once, as the carton`);
      assert.equal(row.rate, byCode === row ? 7 : 5.5, 'the row\'s own fields ride through untouched');
    }
  });

  test('a carton on two lines, or a part on a line of its own, is warned about — never refused', async () => {
    const twice = await newPo('PO-TWICE', [
      { product_id: ids.outer, qty: 100, line_remark: 'B-1' }, { product_id: ids.outer, qty: 200, line_remark: 'B-2' }]);
    assert.deepEqual(twice.warnings,
      ['SW-715 is made in parts and is on 2 lines of this order — order it once unless the customer really ordered it twice']);
    const cartons = await db.q('SELECT id, qty FROM order_lines WHERE order_id=$1 AND part_of_line_id IS NULL ORDER BY id', [twice.id]);
    assert.equal(cartons.length, 2);
    for (const c of cartons) assert.deepEqual((await partLines(c.id)).map(p => p.qty), [c.qty, c.qty]);

    const alone = await newPo('PO-PART-ALONE', [{ product_id: ids.p2, qty: 100 }]);
    assert.deepEqual(alone.warnings, ['SW-771 is a part of SW-715, SW-716 — order the carton']);
    const lines = await db.q('SELECT part_of_line_id FROM order_lines WHERE order_id=$1', [alone.id]);
    assert.deepEqual(lines, [{ part_of_line_id: null }], 'booked as the plain line it was typed as');

    const once = await newPo('PO-ONCE', [{ product_id: ids.outer, qty: 100 }]);
    assert.equal(once.warnings, undefined, 'one carton on one line is nothing to warn about');

    for (const o of [twice, alone, once]) {
      const del = await call('DELETE', `/orders/${o.id}`, {});
      assert.equal(del.status, 200, JSON.stringify(del.body));
    }
  });

  test('the single-line Planning and FG doors refuse the carton, the FG doors refuse a part, and no run takes either', async () => {
    const po = await newPo('PO-DOORS', [{ product_id: ids.outer, qty: 1000 }, { product_id: ids.plain, qty: 500 }]);
    const carton = await cartonOf(po.id);
    const [part1, part2] = await partLines(carton.id);
    const plain = await db.one('SELECT * FROM order_lines WHERE order_id=$1 AND product_id=$2', [po.id, ids.plain]);
    const CARTON = 'This carton is made in parts — plan, cover and fill its parts, not the carton itself';
    const PART = 'This is one part of a carton made in parts — its pieces come from its own job card, never from FG stock';
    const runs = async () => (await db.one('SELECT count(*)::int AS n FROM gang_runs')).n;
    const runsBefore = await runs();
    for (const [door, url, body, msg] of [
      ['plan', `/order-lines/${carton.id}/plan`, { draft: true }, CARTON],
      ['plan/discard', `/order-lines/${carton.id}/plan/discard`, {}, CARTON],
      ['raise-pr', `/order-lines/${carton.id}/raise-pr`, {}, CARTON],
      ['consume-fg', `/order-lines/${carton.id}/consume-fg`, { lot_id: 999, qty: 10 }, CARTON],
      ['fulfil-from-stock', `/order-lines/${carton.id}/fulfil-from-stock`, { picks: [{ lot_id: 999, qty: 10 }] }, CARTON],
      ['consume-fg on a part', `/order-lines/${part1.id}/consume-fg`, { lot_id: 999, qty: 10 }, PART],
      ['fulfil-from-stock on a part', `/order-lines/${part1.id}/fulfil-from-stock`, { picks: [{ lot_id: 999, qty: 10 }] }, PART],
    ]) {
      const r = await call('POST', url, body);
      assert.deepEqual([r.status, r.body.error], [409, msg], door);
    }
    for (const [door, url, lineIds, msg] of [
      ['gang: a part + an ordinary line', '/gang-runs', [part1.id, plain.id],
        'VOGEAB GM2 OUTER PART 1 is one part of a carton made in parts — it runs on its own job card, never in a gang or combined run'],
      ['gang: the carton + an ordinary line', '/gang-runs', [carton.id, plain.id],
        'VOGEAB GM2 OUTER is made in parts — its parts run on their own job cards, never in a gang or combined run'],
      ['combined run: a part + an ordinary line', '/merge-runs', [part2.id, plain.id],
        'VOGEAB GM2 OUTER PART 2 is one part of a carton made in parts — it runs on its own job card, never in a gang or combined run'],
    ]) {
      const r = await call('POST', url, { line_ids: lineIds });
      assert.deepEqual([r.status, r.body.error], [409, msg], door);
    }
    // Nothing moved: the carton is still pending at 0/0/0, nothing was bought or
    // held for it, and no line joined a run.
    const c = await lineOf(carton.id);
    assert.deepEqual([c.status, c.sheets_required, c.parent_sheets_required, c.wastage_sheets], ['pending', 0, 0, 0]);
    const touched = [carton.id, part1.id, part2.id, plain.id];
    assert.equal((await db.q('SELECT 1 FROM requisitions WHERE order_line_id = ANY($1::int[])', [touched])).length, 0);
    assert.equal((await db.q('SELECT 1 FROM board_allocations WHERE order_line_id = ANY($1::int[])', [touched])).length, 0);
    assert.equal((await db.q('SELECT 1 FROM order_lines WHERE id = ANY($1::int[]) AND gang_run_id IS NOT NULL', [touched])).length, 0);
    assert.equal(await runs(), runsBefore, 'no run was made');
    // …and the carton itself, its parts still in planning, cancels WITH its parts.
    const cancelled = await call('POST', `/order-lines/${carton.id}/cancel`, {});
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.deepEqual((await db.q('SELECT status FROM order_lines WHERE id = ANY($1::int[]) ORDER BY id', [touched])).map(l => l.status),
      ['cancelled', 'cancelled', 'cancelled', 'pending']);
  });

  test('the REAL die-cut completion makes the pasting card once BOTH parts are cut; its sorting draws no board; FG is only ever the carton', async () => {
    const fgOf = async id => (await db.one('SELECT qty FROM fg_stock WHERE product_id=$1', [id]))?.qty ?? 0;
    const partsFg = async () => (await db.q('SELECT 1 FROM fg_stock WHERE product_id = ANY($1::int[])', [[ids.p1, ids.p2]])).length;
    const outerFg0 = await fgOf(ids.outer);
    const po = await newPo('PO-DIECUT', [{ product_id: ids.outer, qty: 2000, line_remark: 'B-9' }]);
    const carton = await cartonOf(po.id);
    const parts = await partLines(carton.id);
    // Planning → Artwork → push, through the real routes, for each part.
    const cards = [];
    for (const p of parts) {
      for (const [step, url, body] of [
        ['plan', `/order-lines/${p.id}/plan`, {}],
        ['customer approval', `/order-lines/${p.id}/artwork`, { customer_ok: true }],
        ['QA approval', `/order-lines/${p.id}/artwork`, { qa_ok: true }],
        ['artwork lock', `/order-lines/${p.id}/artwork/lock`, {}],
        ['push', `/workflow/order-lines/${p.id}`, { action: 'push_to_job_card', destinations: ['cutting'] }],
      ]) {
        const r = await call('POST', url, body);
        assert.equal(r.status, 200, `${p.part_label} ${step}: ${JSON.stringify(r.body)}`);
        if (step === 'push') cards.push(await db.one('SELECT * FROM job_cards WHERE id=$1', [r.body.job_card_id]));
      }
    }
    const stagesOf = cardId => db.q('SELECT * FROM job_stages WHERE job_card_id=$1 ORDER BY seq', [cardId]);
    for (const c of cards) assert.deepEqual((await stagesOf(c.id)).map(s => s.stage), ['cutting', 'printing', 'die_cutting']);
    const pastingCard = () => db.one('SELECT * FROM job_cards WHERE order_line_id=$1', [carton.id]);
    // C7: with its parts on the floor, the carton can no longer be cancelled.
    const cancel = await call('POST', `/order-lines/${carton.id}/cancel`, {});
    assert.deepEqual([cancel.status, cancel.body.error],
      [409, 'Part 1 of this carton is already in production — roll the carton back in Planning first, then cancel it']);

    // Cutting and printing done (by SQL — not what is under test); die cutting
    // through the real start and complete routes, as the floor does it.
    const dieCut = async (cardId, sheets) => {
      await db.q(`UPDATE job_stages SET status='completed', qty_in=$2, qty_out=$2, started_at=now(), completed_at=now()
                   WHERE job_card_id=$1 AND stage IN ('cutting','printing')`, [cardId, sheets]);
      const die = (await stagesOf(cardId)).find(s => s.stage === 'die_cutting');
      const start = await call('POST', `/job-stages/${die.id}/start`, { line_clearance: ['Die and make-ready checked'] });
      assert.equal(start.status, 200, JSON.stringify(start.body));
      assert.deepEqual([start.body.status, start.body.qty_in], ['in_progress', sheets]);
      const done = await call('POST', `/job-stages/${die.id}/complete`, { qty_out: sheets, qty_scrap: 0 });
      assert.equal(done.status, 200, JSON.stringify(done.body));
      assert.deepEqual([done.body.status, done.body.qty_out], ['completed', sheets]);
    };

    // Part 1: 520 sheets × 4 ups = 2,080 pieces. Its card is finished — 'split',
    // no FG — and the carton waits for Part 2.
    await dieCut(cards[0].id, 520);
    assert.deepEqual(await db.one('SELECT status, qty_produced FROM job_cards WHERE id=$1', [cards[0].id]), { status: 'split', qty_produced: 2080 });
    assert.equal(await pastingCard(), null, 'one part cut is not a carton');
    assert.deepEqual((await partLines(carton.id)).map(p => p.status), ['in_production', 'in_production']);
    assert.equal((await lineOf(carton.id)).status, 'pending');
    // C7: a finished part card is never rolled back — nor, through it, its carton.
    const back = await call('POST', `/order-lines/${parts[0].id}/rollback`, { mode: 'rollback' });
    assert.deepEqual([back.status, back.body.error],
      [409, `Rolling back a part rolls back its whole carton — Part 1: ${FINISHED_PART(cards[0].jc_number)}`]);
    assert.deepEqual(await db.one('SELECT status, qty_produced FROM job_cards WHERE id=$1', [cards[0].id]), { status: 'split', qty_produced: 2080 });
    // …so the cancel refusal no longer offers a rollback: Part 1's card says die-cut.
    const cancelCut = await call('POST', `/order-lines/${carton.id}/cancel`, {});
    assert.deepEqual([cancelCut.status, cancelCut.body.error],
      [409, 'Part 1 of this carton is already die-cut — the carton can no longer be cancelled']);

    // Part 2: 1,010 sheets × 2 ups = 2,020 pieces — the scarcer part decides.
    await dieCut(cards[1].id, 1010);
    assert.deepEqual(await db.one('SELECT status, qty_produced FROM job_cards WHERE id=$1', [cards[1].id]), { status: 'split', qty_produced: 2020 });
    const card = await pastingCard();
    assert.ok(card, 'the second die cut made the pasting card');
    assert.deepEqual([card.is_assembly, card.product_id, card.qty_planned, card.sheets_issued, card.status],
      [true, ids.outer, 2020, 2020, 'open']);
    assert.deepEqual((await stagesOf(card.id)).map(s => [s.stage, s.status]), [['sorting', 'pending'], ['pasting', 'pending']]);
    assert.deepEqual((await partLines(carton.id)).map(p => p.status), ['dispatched', 'dispatched']);
    assert.equal((await lineOf(carton.id)).status, 'in_production');
    assert.deepEqual([await partsFg(), await fgOf(ids.outer)], [0, outerFg0], 'a die cut credits no FG');
    assert.deepEqual(await auditOf('job_card', card.id, 'create_assembly'), [{ detail:
      `${card.jc_number} pastes Part 1 ${cards[0].jc_number} (2080) + Part 2 ${cards[1].jc_number} (2020) → 2020 cartons — spare Part 1 60` }]);
    // C7: nor is the pasting card, by either door.
    const PASTING = `${card.jc_number} pastes parts made on other job cards — it cannot be reversed to Planning, rolled back or deleted. `
      + 'To redo its sorting or pasting, use Send back at Sort & Paste.';
    for (const [door, r] of [
      ['rollback', await call('POST', `/order-lines/${carton.id}/rollback`, { mode: 'rollback' })],
      ['reverse to Planning', await call('POST', `/workflow/order-lines/${carton.id}`, { action: 'reverse_to_planning' })],
    ]) {
      assert.deepEqual([r.status, r.body.error], [409, PASTING], door);
    }
    assert.equal((await pastingCard())?.id, card.id);

    // Waiting at Sort & Paste it shows the cartons it will paste — never 0:
    // nothing upstream on its own card counts toward it, and Start has not
    // stamped its input yet.
    const queued = async () => (await call('GET', '/floor/sort-paste')).body.queue.find(r => r.job_card_id === card.id);
    const waiting = await queued();
    assert.deepEqual([waiting.phase, waiting.qty_in, waiting.received, waiting.expected_qty, waiting.sorting_received],
      ['sort', null, 2020, 2020, 2020]);

    // Its sorting starts on the pieces: no board leaves the warehouse.
    const stock = () => db.q('SELECT material_id, SUM(qty)::int AS qty FROM stock_batches GROUP BY material_id ORDER BY material_id');
    const ledger = () => db.one('SELECT count(*)::int AS n, COALESCE(SUM(qty),0)::float AS sum FROM stock_movements');
    const [stock0, ledger0] = [await stock(), await ledger()];
    const sorting = (await stagesOf(card.id))[0];
    const start = await call('POST', `/job-stages/${sorting.id}/start`, { line_clearance: ['Pieces counted in'] });
    assert.equal(start.status, 200, JSON.stringify(start.body));
    assert.deepEqual([start.body.status, start.body.qty_in], ['in_progress', 2020]);
    assert.deepEqual([(await queued()).qty_in, (await queued()).received], [2020, 2020], 'started: the stamp speaks');
    assert.deepEqual(await stock(), stock0, 'no board stock moved');
    assert.deepEqual(await ledger(), ledger0, 'nothing booked to the stock ledger');

    // Sort & Paste closes it the ordinary way (C6): FG is the carton, only the carton.
    const paste = await call('POST', `/sort-paste/${card.id}/complete`, { rows: [{ method: 'manual', input_qty: 2020, manual_qty: 2020 }] });
    assert.equal(paste.status, 200, JSON.stringify(paste.body));
    assert.deepEqual(await db.one('SELECT status, qty_produced FROM job_cards WHERE id=$1', [card.id]), { status: 'closed', qty_produced: 2020 });
    assert.deepEqual([await partsFg(), await fgOf(ids.outer)], [0, outerFg0 + 2020]);
    assert.equal((await lineOf(carton.id)).status, 'produced');
    assert.deepEqual((await partLines(carton.id)).map(p => p.status), ['dispatched', 'dispatched']);
  });

  test('the sales views list the carton once and never a part — pendency, Status Sheet, Track, the orders list', async () => {
    const po = await newPo('PO-SALES', [{ product_id: ids.outer, qty: 5000, rate: 12 }, { product_id: ids.plain, qty: 3000, rate: 4 }]);
    const carton = await cartonOf(po.id);
    const plain = await db.one('SELECT id FROM order_lines WHERE order_id=$1 AND product_id=$2', [po.id, ids.plain]);
    const parts = await partLines(carton.id);
    assert.equal(parts.length, 2);
    const isPart = id => parts.some(p => p.id === id);
    const both = [carton.id, plain.id].sort(byId);

    const pend = await get('/sales/pendency');
    assert.equal(pend.lines.some(l => isPart(l.line_id) || l.product_id === ids.p1 || l.product_id === ids.p2), false);
    const pendMine = pend.lines.filter(l => l.order_id === po.id);
    assert.deepEqual(pendMine.map(l => l.line_id).sort(byId), both);
    const pendCarton = pendMine.find(l => l.line_id === carton.id);
    assert.deepEqual(pendCarton.parts.map(p => [p.line_id, p.label, p.qty, p.status, p.jc_status]),
      [[parts[0].id, 'Part 1', 5000, 'pending', null], [parts[1].id, 'Part 2', 5000, 'pending', null]]);
    assert.equal(pendCarton.status, 'pending', 'a carton whose parts wait to be planned waits with them');
    assert.equal(pendMine.find(l => l.line_id === plain.id).parts, null);
    assert.equal(pend.by_product.some(m => m.key === ids.p1 || m.key === ids.p2), false);

    const sheet = await get('/status-sheet');
    assert.equal(sheet.lines.some(l => isPart(l.line_id) || l.product_id === ids.p1 || l.product_id === ids.p2), false);
    assert.deepEqual(sheet.lines.filter(l => l.order_id === po.id).map(l => l.line_id).sort(byId), both);

    const track = await get('/track');
    assert.equal(track.some(r => isPart(r.id) || r.product_code === 'SW-770' || r.product_code === 'SW-771'), false);
    assert.deepEqual(track.filter(r => r.po_number === 'PO-SALES').map(r => r.id).sort(byId), both);

    const orders = await get('/orders');
    const mine = orders.find(o => o.id === po.id);
    assert.deepEqual([mine.line_count, mine.ordered_qty, +mine.value, mine.fulfilled_qty], [2, 8000, 5000 * 12 + 3000 * 4, 0]);
    // …and every order is counted the same way: its lines, never its part lines.
    const items = new Map((await db.q(`SELECT order_id, count(*)::int AS n FROM order_lines
                                        WHERE part_of_line_id IS NULL GROUP BY order_id`)).map(r => [r.order_id, r.n]));
    for (const o of orders) assert.equal(o.line_count, items.get(o.id) ?? 0, o.po_number);
  });

  // ── A master that changes under open orders; cartons that must not convert;
  //    pieces per carton above one ─────────────────────────────────────────
  test('C9: once a part is on the floor the list is frozen — yet the part still in planning follows the carton\'s qty', async () => {
    const po = await newPo('PO-FROZEN', [{ product_id: ids.outer, qty: 100, line_remark: 'B-3' }]);
    const carton = await cartonOf(po.id);
    const [part1] = await partLines(carton.id);
    await pushPart(part1.id, 250);   // Part 1 to the floor; Part 2 waits in planning
    const res = await call('PUT', `/orders/${po.id}`, { po_number: 'PO-FROZEN', customer_id: ids.cust,
      lines: [{ id: carton.id, product_id: ids.outer, qty: 150, rate: 0, line_remark: 'B-3' }] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.warnings,
      ['SW-715: Part 1 is already in production, so its quantity stays at 100 — to change it, roll the carton back in Planning and save this order again']);
    assert.deepEqual((await partLines(carton.id)).map(p => [p.part_label, p.status, p.qty]),
      [['Part 1', 'in_production', 100], ['Part 2', 'pending', 150]]);
  });

  test('C8: a part taken off the master while still in planning leaves through rollbackLine — PR gone, hold released on record', async () => {
    const save = parts => call('PUT', `/products/${ids.o3}/parts`, { parts });
    const three = await save([
      { part_product_id: ids.k1, label: 'Part 1' }, { part_product_id: ids.k2, label: 'Part 2' },
      { part_product_id: ids.k3, label: 'Part 3' }]);
    assert.equal(three.status, 200, JSON.stringify(three.body));
    const po = await newPo('PO-TAKEN-OFF', [{ product_id: ids.o3, qty: 400 }]);
    const carton = await cartonOf(po.id, ids.o3);
    const before = await partLines(carton.id);
    assert.deepEqual(before.map(p => [p.product_id, p.part_label, p.status]),
      [[ids.k1, 'Part 1', 'pending'], [ids.k2, 'Part 2', 'pending'], [ids.k3, 'Part 3', 'pending']]);
    const part3 = before[2];
    // Raise PR has no status gate: a part still pending can carry a PR and a hold.
    await db.q(`INSERT INTO requisitions (pr_number, material_id, qty, order_line_id) VALUES ('PR-T-4',$1,200,$2)`, [ids.boardA, part3.id]);
    await db.q(`INSERT INTO board_allocations (material_id, order_line_id, qty, source) VALUES ($1,$2,80,'stock')`, [ids.boardA, part3.id]);

    const two = await save([{ part_product_id: ids.k1, label: 'Part 1' }, { part_product_id: ids.k2, label: 'Part 2' }]);
    assert.equal(two.status, 200, JSON.stringify(two.body));
    assert.deepEqual([two.body.synced, two.body.warnings], [1, []]);
    // Part 3 left the one audited way: its PR deleted, its hold released on the
    // record, the line itself gone.
    assert.equal(await lineOf(part3.id), null);
    assert.equal((await db.q(`SELECT 1 FROM requisitions WHERE pr_number='PR-T-4'`)).length, 0);
    assert.equal(await holdReleased(ids.boardA, part3.id, 80), 1, 'the hold is released on the record');
    assert.deepEqual(await auditOf('order_line', part3.id, 'deleted_entirely'),
      [{ detail: `taken off carton line #${carton.id} in the Product Master` }]);
    // …and the other parts stand exactly as they were, the carton still in parts.
    const keep = p => [p.id, p.product_id, p.qty, p.status, p.part_label];
    assert.deepEqual((await partLines(carton.id)).map(keep), before.slice(0, 2).map(keep));
    const c = await lineOf(carton.id);
    assert.deepEqual([c.sheets_required, c.parent_sheets_required, c.wastage_sheets], [0, 0, 0]);
    ids.takenOff = carton.id;   // the next test clears this carton's list
  });

  test('C8: the whole list cleared, nothing blocked — every part leaves and the carton is one carton again, NULL sheets', async () => {
    const carton = ids.takenOff;
    const cleared = await call('PUT', `/products/${ids.o3}/parts`, { parts: [] });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.deepEqual([cleared.body.parts, cleared.body.synced, cleared.body.warnings], [[], 2, []]);
    assert.equal((await partLines(carton)).length, 0);
    const c = await lineOf(carton);
    assert.deepEqual([c.status, c.sheets_required, c.parent_sheets_required, c.wastage_sheets], ['pending', null, null, null]);
    assert.deepEqual(await auditOf('order_line', carton, 'no_longer_in_parts'),
      [{ detail: 'its parts were taken off the master — plan it as one carton' }]);
    // …so Planning lists it again, to be planned as one carton on its own board.
    const row = (await get('/planning')).find(r => r.id === carton);
    assert.deepEqual([row?.has_parts, row?.board_material_id], [false, ids.boardA]);
  });

  test('C8: a list change is all-or-nothing on each order — one part that cannot leave keeps the whole list, and the qty still follows', async () => {
    const save = parts => call('PUT', `/products/${ids.o4}/parts`, { parts });
    assert.equal((await save([{ part_product_id: ids.k1, label: 'Part 1' }, { part_product_id: ids.k2, label: 'Part 2' }])).status, 200);
    const po = await newPo('PO-BLOCKED', [{ product_id: ids.o4, qty: 100 }]);
    const carton = await cartonOf(po.id, ids.o4);
    const [part1, part2] = await partLines(carton.id);
    // Part 2's board is already bought: its PR sits on a purchase order.
    const { id: vendor } = await db.one(`INSERT INTO vendors (name) VALUES ('Board Mills') RETURNING id`);
    const { id: bought } = await db.one(`INSERT INTO purchase_orders (po_number, vendor_id) VALUES ('VPO-T-1',$1) RETURNING id`, [vendor]);
    await db.q(`INSERT INTO requisitions (pr_number, material_id, qty, order_line_id, purchase_order_id, status)
                VALUES ('PR-T-5',$1,200,$2,$3,'converted')`, [ids.boardB, part2.id, bought]);
    const KEPT = 'The parts list stays as it was on this order — Part 2: Board already ordered against this line’s requisition — cancel the purchase order first';
    const onOrder = async () => (await partLines(carton.id)).map(p => [p.id, p.product_id, p.qty, p.part_label]);

    // The master swaps Part 2 for another product. On this order the old Part 2
    // cannot leave, so the new one does not come either — never a half list.
    const swapped = await save([{ part_product_id: ids.k1, label: 'Part 1' }, { part_product_id: ids.k4, label: 'Part 2' }]);
    assert.equal(swapped.status, 200, JSON.stringify(swapped.body));
    assert.deepEqual([swapped.body.synced, swapped.body.warnings], [0, [`PO PO-BLOCKED (100): ${KEPT}`]]);
    assert.deepEqual(await onOrder(), [[part1.id, ids.k1, 100, 'Part 1'], [part2.id, ids.k2, 100, 'Part 2']]);

    // An edit of the carton's qty: the qty follows onto BOTH lines — the old
    // Part 2 too, which the master no longer lists (C9) — while the list change
    // is refused again, in one warning.
    const edit = await call('PUT', `/orders/${po.id}`, { po_number: 'PO-BLOCKED', customer_id: ids.cust,
      lines: [{ id: carton.id, product_id: ids.o4, qty: 150, rate: 0 }] });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    assert.deepEqual(edit.body.warnings, [`SW-718: ${KEPT}`]);
    assert.deepEqual(await onOrder(), [[part1.id, ids.k1, 150, 'Part 1'], [part2.id, ids.k2, 150, 'Part 2']]);
    assert.equal((await db.q(`SELECT 1 FROM requisitions WHERE pr_number='PR-T-5'`)).length, 1, 'the bought board stays on its line');
  });

  test('C2: a carton line in a gang, or already ready, is NOT converted when its parts are saved — the save warns instead', async () => {
    // One SW-719 line joins a gang with an ordinary line while it is still one carton …
    const ganged = await newPo('PO-GANGED', [{ product_id: ids.o5, qty: 500 }, { product_id: ids.plain, qty: 500 }]);
    const [gLine, gMate] = await db.q('SELECT * FROM order_lines WHERE order_id=$1 ORDER BY id', [ganged.id]);
    const gang = await call('POST', '/gang-runs', { line_ids: [gLine.id, gMate.id] });
    assert.equal(gang.status, 200, JSON.stringify(gang.body));
    // … and another is planned, artwork-locked and its tooling passed through the
    // real routes: ready (the fixture has no die, so tooling is passed by hand).
    const readyPo = await newPo('PO-READY', [{ product_id: ids.o5, qty: 4000, line_remark: 'B-7' }]);
    const rLine = await db.one('SELECT * FROM order_lines WHERE order_id=$1', [readyPo.id]);
    for (const [step, url, body] of [
      ['plan', `/order-lines/${rLine.id}/plan`, {}],
      ['customer approval', `/order-lines/${rLine.id}/artwork`, { customer_ok: true }],
      ['QA approval', `/order-lines/${rLine.id}/artwork`, { qa_ok: true }],
      ['artwork lock', `/order-lines/${rLine.id}/artwork/lock`, {}],
      ['tooling', `/order-lines/${rLine.id}/tooling`, { tooling_ok: true }],
    ]) {
      const r = await call('POST', url, body);
      assert.equal(r.status, 200, `${step}: ${JSON.stringify(r.body)}`);
    }
    const snap = async id => {
      const l = await lineOf(id);
      return [l.status, l.gang_run_id, l.sheets_required, l.parent_sheets_required, l.wastage_sheets];
    };
    const was = { [gLine.id]: await snap(gLine.id), [rLine.id]: await snap(rLine.id) };
    assert.ok(was[gLine.id][1], 'the first line is in a gang');
    assert.equal(was[rLine.id][0], 'ready');

    const saved = await call('PUT', `/products/${ids.o5}/parts`, { parts: [
      { part_product_id: ids.k1, label: 'Part 1' }, { part_product_id: ids.k2, label: 'Part 2' }] });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    // The ganged line is still in planning, so the save follows it: its sync
    // warns and the line stays one carton. The ready line is past planning — the
    // save never syncs it — and the save names it too, so no line it leaves as
    // one carton goes unsaid (routes/product-parts.js).
    assert.deepEqual([saved.body.synced, saved.body.warnings], [0, [
      'PO PO-GANGED (500): This line is in a gang — take it out of the gang to run it in parts',
      'PO PO-READY (4,000 · B-7): already cleared for its job card — it runs as one carton this time',
    ]]);
    // An edit of the ready line's order does reach it: its sync warns in turn —
    // said when the edit touches the line (here its qty), never on an edit that
    // leaves it as it was (13a E).
    const edit = qty => call('PUT', `/orders/${readyPo.id}`, { po_number: 'PO-READY', customer_id: ids.cust,
      lines: [{ id: rLine.id, product_id: ids.o5, qty, rate: 0, line_remark: 'B-7' }] });
    const untouched = await edit(4000);
    assert.equal(untouched.status, 200, JSON.stringify(untouched.body));
    assert.equal(untouched.body.warnings, undefined);
    const touched = await edit(4100);
    assert.equal(touched.status, 200, JSON.stringify(touched.body));
    assert.deepEqual(touched.body.warnings, ['SW-719: This line is already cleared for its job card — it runs as one carton this time']);
    // Clearing the list converts nothing, so it names nothing either.
    const cleared = await call('PUT', `/products/${ids.o5}/parts`, { parts: [] });
    assert.deepEqual([cleared.status, cleared.body.synced, cleared.body.warnings], [200, 0, []]);
    // Neither was converted: no part lines, and each keeps its status, its gang
    // and its own board figures, with no "made in parts" on its record.
    for (const id of [gLine.id, rLine.id]) {
      assert.equal((await partLines(id)).length, 0);
      assert.deepEqual(await snap(id), was[id]);
      assert.deepEqual(await auditOf('order_line', id, 'made_in_parts'), []);
    }
  });

  test('pieces per carton: a ×2 part is ordered ×2, and the pasting card counts by the line\'s own ×2 — 2,000 pieces make 1,000 cartons', async () => {
    const save = parts => call('PUT', `/products/${ids.o6}/parts`, { parts });
    assert.equal((await save([
      { part_product_id: ids.k1, label: 'Part 1', per_carton: 1 },
      { part_product_id: ids.k2, label: 'Part 2', per_carton: 2 }])).status, 200);
    const po = await newPo('PO-X2', [{ product_id: ids.o6, qty: 1000 }]);
    const carton = await cartonOf(po.id, ids.o6);
    const parts = await partLines(carton.id);
    assert.deepEqual(parts.map(p => [p.product_id, p.qty, p.part_per_carton]), [[ids.k1, 1000, 1], [ids.k2, 2000, 2]]);

    // Both parts to the floor and die-cut: Part 1 300 sheets × 4 ups = 1,200
    // pieces, 1,200 cartons' worth; Part 2 1,000 sheets × 2 ups = 2,000 pieces —
    // at 2 a carton, 1,000 cartons' worth. Part 2 decides.
    const cards = [await pushPart(parts[0].id, 1100), await pushPart(parts[1].id, 1100)];
    assert.equal(await db.tx((qc, oc) => cpdb.closePartCard(cards[0], 300, qc, oc, 'test')), 1200);
    assert.equal(await db.tx((qc, oc) => cpdb.closePartCard(cards[1], 1000, qc, oc, 'test')), 2000);
    // The master now says 3 of Part 2 a carton. This order's parts are on the
    // floor, so their own ×2 stands (C9) — on the lines and in the pasting card.
    const changed = await save([
      { part_product_id: ids.k1, label: 'Part 1', per_carton: 1 },
      { part_product_id: ids.k2, label: 'Part 2', per_carton: 3 }]);
    assert.deepEqual([changed.status, changed.body.warnings], [200, []]);
    assert.deepEqual((await partLines(carton.id)).map(p => [p.qty, p.part_per_carton]), [[1000, 1], [2000, 2]]);
    const asm = await db.tx((qc, oc) => cpdb.maybeCreateAssemblyCard(carton.id, qc, oc, 'test'));
    const card = await db.one('SELECT jc_number, qty_planned, sheets_issued FROM job_cards WHERE id=$1', [asm]);
    assert.deepEqual([card.qty_planned, card.sheets_issued], [1000, 1000]);
    assert.deepEqual(await auditOf('job_card', asm, 'create_assembly'), [{ detail:
      `${card.jc_number} pastes Part 1 ${cards[0].jc_number} (1200) + Part 2 ${cards[1].jc_number} (2000) → 1000 cartons — spare Part 1 200` }]);
  });

  // ── Task 13a: the final review's fixes — each books its own PO, and makes
  //    any product it edits or names inside the test ────────────────────────
  test('13a B: a shade card on one order\'s part keeps THAT order\'s list — the parts save goes through, the other order follows', async () => {
    const outer = await newProduct('SW-721', 'VOGEAB GM7 OUTER');
    const save = parts => call('PUT', `/products/${outer}/parts`, { parts });
    assert.equal((await save([{ part_product_id: ids.k1, label: 'Part 1' }, { part_product_id: ids.k2, label: 'Part 2' }])).status, 200);
    const one = await newPo('PO-SHADE-1', [{ product_id: outer, qty: 100 }]);
    const two = await newPo('PO-SHADE-2', [{ product_id: outer, qty: 200 }]);
    const [c1, c2] = [await cartonOf(one.id, outer), await cartonOf(two.id, outer)];
    const [part1] = await partLines(c1.id);   // k1 — ordered by product
    // A shade card raised against order 1's Part 1 (the shade card form offers part lines).
    await db.q(`INSERT INTO shade_cards (sc_number, title, product_id, customer_id, order_line_id)
                VALUES ('SC-T-1','GM7 Part 1',$1,$2,$3)`, [ids.k1, ids.cust, part1.id]);
    // What Postgres says when a part's row is deleted from under it — the
    // referencing table, which the sync names in its warning.
    const fk = await db.tx(qc => qc('DELETE FROM order_lines WHERE id=$1', [part1.id])).catch(e => e);
    assert.deepEqual([fk.code, fk.table, fk.constraint], ['23503', 'shade_cards', 'shade_cards_order_line_id_fkey']);

    // The master swaps Part 1 for another product.
    const swapped = await save([{ part_product_id: ids.k3, label: 'Part 1' }, { part_product_id: ids.k2, label: 'Part 2' }]);
    assert.equal(swapped.status, 200, JSON.stringify(swapped.body));
    assert.deepEqual([swapped.body.synced, swapped.body.warnings], [2, [
      'PO PO-SHADE-1 (100): The parts list stays as it was on this order — Part 1 has a shade card raised against it',
    ]]);
    const onOrder = async id => (await partLines(id)).map(p => [p.product_id, p.part_label, p.qty]);
    assert.deepEqual(await onOrder(c1.id), [[ids.k1, 'Part 1', 100], [ids.k2, 'Part 2', 100]], 'order 1 keeps its whole list');
    assert.deepEqual(await onOrder(c2.id), [[ids.k2, 'Part 2', 200], [ids.k3, 'Part 1', 200]], 'order 2 takes the new list');
    assert.equal((await db.one(`SELECT order_line_id FROM shade_cards WHERE sc_number='SC-T-1'`)).order_line_id, part1.id);
  });

  test('13a F: the cancel refusal names a way out that works — roll the carton back in Planning, then cancel it', async () => {
    const po = await newPo('PO-WAY-OUT', [{ product_id: ids.outer, qty: 250 }]);
    const carton = await cartonOf(po.id);
    const [part1, part2] = await partLines(carton.id);
    await pushPart(part1.id, 100);   // Part 1 has its card; nothing started on it
    const refused = await call('POST', `/order-lines/${carton.id}/cancel`, {});
    assert.deepEqual([refused.status, refused.body.error],
      [409, 'Part 1 of this carton is already in production — roll the carton back in Planning first, then cancel it']);
    const back = await call('POST', `/order-lines/${part2.id}/rollback`, { mode: 'rollback' });   // any part: the whole carton goes
    assert.equal(back.status, 200, JSON.stringify(back.body));
    const cancelled = await call('POST', `/order-lines/${carton.id}/cancel`, {});
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.deepEqual((await db.q('SELECT status FROM order_lines WHERE id = ANY($1::int[]) ORDER BY id', [[carton.id, part1.id, part2.id]]))
      .map(l => l.status), ['cancelled', 'cancelled', 'cancelled']);
  });

  test('13a D: a quantity sent for a PART in a plan save is kept as it was — on the record — and the plan still saves', async () => {
    const po = await newPo('PO-PART-QTY', [{ product_id: ids.outer, qty: 700 }]);
    const [part1] = await partLines((await cartonOf(po.id)).id);
    const sent = await call('POST', `/order-lines/${part1.id}/plan`, { draft: true, qty: 999 });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.deepEqual([sent.body.part_qty_kept, sent.body.qty], [true, 700]);
    assert.equal((await lineOf(part1.id)).qty, 700);
    assert.deepEqual(await auditOf('order_line', part1.id, 'part_qty_kept'),
      [{ detail: "planning engine sent qty 999 — kept 700: a part's quantity follows its carton" }]);
    assert.deepEqual(await auditOf('order_line', part1.id, 'qty_edit'), []);
    // its own quantity sent back, as the engine's read-only box sends it: nothing to say
    const same = await call('POST', `/order-lines/${part1.id}/plan`, { draft: true, qty: 700 });
    assert.deepEqual([same.status, same.body.part_qty_kept], [200, false]);
  });

  test('13a E: an order edit repeats no part warning for a carton it did not touch — and says it again when it does', async () => {
    const po = await newPo('PO-QUIET', [{ product_id: ids.outer, qty: 100, line_remark: 'B-5' }, { product_id: ids.plain, qty: 500 }]);
    const carton = await cartonOf(po.id);
    const plain = await db.one('SELECT id FROM order_lines WHERE order_id=$1 AND product_id=$2', [po.id, ids.plain]);
    const [part1] = await partLines(carton.id);
    await pushPart(part1.id, 250);   // Part 1 to the floor; Part 2 waits in planning
    const edit = (cartonQty, plainQty, remark = 'B-5') => call('PUT', `/orders/${po.id}`, { po_number: 'PO-QUIET', customer_id: ids.cust,
      lines: [{ id: carton.id, product_id: ids.outer, qty: cartonQty, rate: 0, line_remark: remark },
        { id: plain.id, product_id: ids.plain, qty: plainQty, rate: 0 }] });
    const QTY = 'SW-715: Part 1 is already in production, so its quantity stays at 100 — to change it, roll the carton back in Planning and save this order again';
    // The carton's qty is edited: Part 1 cannot follow, and the edit says so.
    const first = await edit(150, 500);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body.warnings, [QTY]);
    // Another line is edited. The carton still differs from Part 1, but this
    // save did not touch it — nothing about it is said again.
    const other = await edit(150, 600);
    assert.equal(other.status, 200, JSON.stringify(other.body));
    assert.equal(other.body.warnings, undefined);
    // The carton's batch is edited: this save touched the carton — all of its warnings are said.
    const batch = await edit(150, 600, 'B-6');
    assert.equal(batch.status, 200, JSON.stringify(batch.body));
    assert.deepEqual(batch.body.warnings, [QTY,
      'SW-715: Part 1 is already in production, so it keeps batch B-5, not B-6 — to change it, roll the carton back in Planning and save this order again']);
    // …while Part 2, still in planning, followed every change.
    assert.deepEqual((await partLines(carton.id)).map(p => [p.part_label, p.status, p.qty, p.line_remark]),
      [['Part 1', 'in_production', 100, 'B-5'], ['Part 2', 'pending', 150, 'B-6']]);
  });

  test('13a G1: saving a part\'s job card answers with its parts band, as reading it does', async () => {
    const po = await newPo('PO-JC-PUT', [{ product_id: ids.outer, qty: 300 }]);
    const [part1] = await partLines((await cartonOf(po.id)).id);
    const card = await pushPart(part1.id, 100);
    const saved = await call('PUT', `/job-cards/${card.id}`, { qty_planned: card.qty_planned });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(['role', 'label', 'outer_code', 'of_parts'].map(k => saved.body.carton_parts?.[k]), ['part', 'Part 1', 'SW-715', 2]);
  });

  test('13a I: the Status Sheet reads a carton-in-parts line\'s Print Status off its parts — an ordinary line is untouched', async () => {
    const po = await newPo('PO-PRINTED', [{ product_id: ids.outer, qty: 400 }, { product_id: ids.plain, qty: 100 }]);
    const carton = await cartonOf(po.id);
    const plain = await db.one('SELECT id FROM order_lines WHERE order_id=$1 AND product_id=$2', [po.id, ids.plain]);
    const sheet = async () => {
      const { lines } = await get('/status-sheet');
      const c = lines.find(l => l.line_id === carton.id);
      const o = lines.find(l => l.line_id === plain.id);
      return [c.print_state, c.stages.length, c.printed_derived, 'print_state' in o];
    };
    // neither part has a card: Not started
    assert.deepEqual(await sheet(), [null, 0, false, false]);
    const [p1, p2] = await partLines(carton.id);
    const [c1, c2] = [await pushPart(p1.id, 150), await pushPart(p2.id, 250)];
    // both carded, neither printing yet: Queued, as an ordinary line with a card reads
    assert.deepEqual(await sheet(), ['pending', 0, false, false]);
    const print = cardId => db.q(`UPDATE job_stages SET status='completed', completed_at=now()
                                   WHERE job_card_id=$1 AND stage IN ('cutting','printing')`, [cardId]);
    // Part 1 printed, Part 2 not: Partial
    await print(c1.id);
    assert.deepEqual(await sheet(), ['partially_completed', 0, false, false]);
    // both printed: Done — and the carton's own stages (none yet) are left alone
    await print(c2.id);
    assert.deepEqual(await sheet(), ['completed', 0, true, false]);
  });

  test('13a K: sibling parts of one carton on two presses raise no strength alarm; the same names NOT parts of one carton still do', async () => {
    const press = async name => (await db.one(`INSERT INTO machines (name, type) VALUES ($1,'printing') RETURNING id`, [name])).id;
    const [pressA, pressB] = [await press('Press A'), await press('Press B')];
    const assign = (card, machine) => call('POST', '/print-planning/assign', { job_card_id: card.id, machine_id: machine, ordered_ids: [card.id] });
    // Part 1 and Part 2 of SW-715: "VOGEAB GM2 OUTER PART 1" / "… PART 2" — to
    // the name matcher, strengths 1 and 2 of one brand.
    const po = await newPo('PO-PRESSES', [{ product_id: ids.outer, qty: 600 }]);
    const [p1, p2] = await partLines((await cartonOf(po.id)).id);
    const [c1, c2] = [await pushPart(p1.id, 200), await pushPart(p2.id, 350)];
    for (const [card, machine] of [[c1, pressA], [c2, pressB]]) {
      const r = await assign(card, machine);
      assert.deepEqual([r.status, r.body.code], [200, undefined], JSON.stringify(r.body));
    }
    // The same two names on products NOT registered as parts of one carton: a clash.
    const [x1, x2] = [await newProduct('SW-797', 'VOGEAB GM9 OUTER PART 1'), await newProduct('SW-798', 'VOGEAB GM9 OUTER PART 2')];
    const plainPo = await newPo('PO-PRESSES-2', [{ product_id: x1, qty: 600 }, { product_id: x2, qty: 600 }]);
    const [l1, l2] = await db.q('SELECT id FROM order_lines WHERE order_id=$1 ORDER BY product_id', [plainPo.id]);
    const [d1] = [await pushPart(l1.id, 200), await pushPart(l2.id, 200)];
    const clash = await assign(d1, pressA);
    assert.deepEqual([clash.status, clash.body.code], [409, 'PRODUCT_STRENGTH_COLLISION']);
    assert.deepEqual(clash.body.collision.others.map(o => o.product_name), ['VOGEAB GM9 OUTER PART 2']);
    // Registered parts of two DIFFERENT cartons are not siblings: a clash of
    // names between them still alarms — only one carton's own parts are let off.
    const [oa, ob] = [await newProduct('SW-781', 'ZETA OUTER A'), await newProduct('SW-782', 'ZETA OUTER B')];
    const [a1, a2] = [await newProduct('SW-783', 'ZETA 5 LID'), await newProduct('SW-784', 'ZETA TRAY A')];
    const [b1, b2] = [await newProduct('SW-785', 'ZETA 10 LID'), await newProduct('SW-786', 'ZETA TRAY B')];
    for (const [outer, first, second] of [[oa, a1, a2], [ob, b1, b2]]) {
      const saved = await call('PUT', `/products/${outer}/parts`, { parts: [
        { part_product_id: first, label: 'Part 1', per_carton: 1 },
        { part_product_id: second, label: 'Part 2', per_carton: 1 },
      ] });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
    }
    const lidOf = async (poNumber, outer) => {
      const po = await newPo(poNumber, [{ product_id: outer, qty: 600 }]);
      const carton = await cartonOf(po.id, outer);
      return (await db.one('SELECT id FROM order_lines WHERE part_of_line_id=$1 ORDER BY id LIMIT 1', [carton.id])).id;
    };
    const [lidA, lidB] = [await lidOf('PO-PRESSES-3', oa), await lidOf('PO-PRESSES-4', ob)];
    const [cardA] = [await pushPart(lidA, 200), await pushPart(lidB, 200)];
    const cross = await assign(cardA, pressA);
    assert.deepEqual([cross.status, cross.body.code], [409, 'PRODUCT_STRENGTH_COLLISION'], JSON.stringify(cross.body));
    assert.deepEqual(cross.body.collision.others.map(o => o.product_name), ['ZETA 10 LID']);
  });
});
