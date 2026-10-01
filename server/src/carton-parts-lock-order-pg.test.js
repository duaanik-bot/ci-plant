import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// A carton made in parts, locked the right way round — run for real. The app's
// OWN code (rollbackLine, closePartCard, maybeCreateAssemblyCard) runs in one
// transaction per side, exactly as a route runs it, against another save, on a
// real Postgres with the app's schema and the foreign keys whose row locks
// decide it:
//
//   order_lines.part_of_line_id → order_lines (the carton)
//   order_lines.order_id        → orders
//   order_lines.product_id      → products
//
// A row a transaction has ALREADY updated re-checks its foreign keys on its next
// update, and that re-check KEY SHAREs every row it points at. So whoever holds
// one of those rows FOR UPDATE and then waits on the updater deadlocks it. A
// carton is therefore locked NO KEY UPDATE (which KEY SHARE passes), and the
// pasting card takes the order and the outer product before the carton, the
// order an order edit and a parts save take them in. The same carton lock is
// what lets two parts finish at once and still make exactly one pasting card.
//
// Each case plays ONE fixed interleaving and proves both sides finish, and that
// one really queued behind the other where the case says — so "both finished"
// is never two transactions that simply never met. Case (vii) proves the
// opposite on purpose: an edit that writes no part must never queue on one. Every side, and the watcher,
// runs on a connection of its own outside the app's pool, so the cases hold
// under any pool size (PG_POOL_MAX=1 included). Put the old code back and each
// case fails (proved by mutation on a scratch copy of the tree, never here):
//   (i)          rollbackLine locking the carton FOR UPDATE — 40P01;
//   (ii), (iii)  maybeCreateAssemblyCard without its order / product KEY SHARE — 40P01;
//   (iv)         maybeCreateAssemblyCard without its carton lock — no pasting card;
//   (v), (vi)    syncPartLines reading its parts unlocked — a qty written onto a
//                part on the floor; a list swapped under a part on the floor;
//   (vii)        syncPartLines locking its parts on EVERY sync — 40P01;
//   (viii)       syncPartLines locking parts already past planning — 40P01.
//
// Opt-in, with the flow test's flag. It boots its OWN throwaway embedded
// Postgres in a temp dir on a free port and deletes it afterwards; it never
// touches a shared or remote database.
//
//   CARTON_PARTS_PG=1 node --test src/carton-parts-lock-order-pg.test.js

const ENABLED = process.env.CARTON_PARTS_PG === '1';

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.unref();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

describe('carton made in parts — lock order under real concurrency', {
  skip: ENABLED ? false : 'set CARTON_PARTS_PG=1 to boot a throwaway Postgres',
  timeout: 180_000,
}, () => {
  let epg, dir, port, pg, db, pool, H, cpdb, watch;
  const clients = new Set();
  const ids = {};

  before(async () => {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    ({ default: pg } = await import('pg'));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carton-parts-locks-'));
    port = await freePort();
    // A deadlock is found in 200 ms, so the old lock order fails fast; and no
    // lock wait, on either side, can hang the suite.
    epg = new EmbeddedPostgres({
      databaseDir: dir, port, user: 'postgres', password: 'postgres', persistent: false,
      postgresFlags: ['-c', 'deadlock_timeout=200ms', '-c', 'lock_timeout=10s'],
      onLog: () => {}, onError: () => {},
    });
    await epg.initialise();
    await epg.start();
    process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
    db = await import('./db.js');
    pool = await db.connect();
    pool.on('error', () => {});   // a stopped server must never crash the cleanup
    await db.init();
    H = await import('./helpers.js');
    cpdb = await import('./carton-parts-db.js');

    const one = db.one;
    ids.cust = (await one(`INSERT INTO customers (name) VALUES ('Swiss Garnier Life Sciences') RETURNING id`)).id;
    const board = async (name, l, w) => {
      const { id } = await one(`INSERT INTO materials (name, category, sheet_l, sheet_w) VALUES ($1,'board',$2,$3) RETURNING id`, [name, l, w]);
      await db.q(`INSERT INTO stock_batches (material_id, batch_no, qty, initial_qty, unit, status)
                  VALUES ($1,'T-1',50000,50000,'sheets','available')`, [id]);
      return id;
    };
    const boardA = await board('Saffire 290 20x38', 20, 38);
    const boardB = await board('Saffire 290 12x18', 12, 18);
    const prod = async (code, name, boardId, ups, l, w) => (await one(
      `INSERT INTO products (customer_id, name, code, board_material_id, ups, child_l, child_w, parent_l, parent_w)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$6,$7) RETURNING id`, [ids.cust, name, code, boardId, ups, l, w])).id;
    ids.outer = await prod('SW-715', 'VOGEAB GM2 OUTER', boardA, 2, 12, 18);
    ids.p1 = await prod('SW-770', 'VOGEAB GM2 OUTER PART 1', boardA, 4, 20, 38);
    ids.p2 = await prod('SW-771', 'VOGEAB GM2 OUTER PART 2', boardB, 2, 12, 18);
    await db.q(`INSERT INTO product_parts (outer_product_id, part_product_id, label, per_carton, seq)
                VALUES ($1,$2,'Part 1',1,1), ($1,$3,'Part 2',1,2)`, [ids.outer, ids.p1, ids.p2]);
    // A carton of its own for case (vi), which edits its master's parts list —
    // the same two parts (C1: a part may sit under several cartons), and the
    // product that case swaps in for Part 2.
    ids.outerL = await prod('SW-716', 'VOGEAB GM1 OUTER', boardA, 2, 12, 18);
    ids.p3 = await prod('SW-772', 'VOGEAB GM1 OUTER BASE', boardB, 2, 12, 18);
    await db.q(`INSERT INTO product_parts (outer_product_id, part_product_id, label, per_carton, seq)
                VALUES ($1,$2,'Part 1',1,1), ($1,$3,'Part 2',1,2)`, [ids.outerL, ids.p1, ids.p2]);
    watch = await connect();
  });

  // Cleanup can never hang the suite or leave the cluster directory behind.
  after(async () => {
    const within = (p, ms) => Promise.race([Promise.resolve(p).catch(() => {}), new Promise(r => setTimeout(r, ms).unref())]);
    for (const c of clients) await within(c.end(), 2000);
    if (pool) await within(pool.end(), 5000);
    if (epg) await within(epg.stop(), 10_000);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  // A connection of the test's own, outside the app's pool: the watcher, the
  // other side of each race and every app transaction each run on one, so no
  // case ever waits for a pool slot.
  async function connect() {
    const c = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', password: 'postgres', database: 'postgres' });
    await c.connect();
    c.on('error', () => {});
    clients.add(c);
    const pid = (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    return {
      c, pid,
      qc: async (sql, params = []) => (await c.query(sql, params)).rows,
      oc: async (sql, params = []) => (await c.query(sql, params)).rows[0] ?? null,
      end: async () => { clients.delete(c); await c.end(); },
    };
  }

  // The app's side: its real code in ONE transaction, run exactly as db.tx runs
  // a route's — BEGIN, the code, COMMIT; ROLLBACK on any error — on a connection
  // of its own, whose backend the watcher follows by pid.
  async function inApp(fn) {
    const t = await connect();
    const done = (async () => {
      await t.c.query('BEGIN');
      try {
        const v = await fn(t.qc, t.oc);
        await t.c.query('COMMIT');
        return v;
      } catch (e) {
        await t.c.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        await t.end().catch(() => {});
      }
    })();
    done.catch(() => {});   // observed through outcome()
    return { pid: t.pid, done };
  }
  const outcome = p => p.then(v => ({ ok: 'ok', v }), e => ({ ok: `${e.code ?? ''} ${e.message}`.trim() }));

  // Returns once the app's backend is parked on a lock, with the statement it is
  // parked in. Finishing first, or never queuing within 5 s, means the
  // interleaving is not the one the case describes: fail, never play on.
  async function untilQueued(app) {
    let settled = null;
    app.done.then(() => { settled = 'finished'; }, e => { settled = `failed (${e.message})`; });
    for (let i = 0; i < 500; i++) {
      if (settled) throw new Error(`the app ${settled} without ever queuing on a lock`);
      const row = await watch.oc('SELECT wait_event_type, query FROM pg_stat_activity WHERE pid=$1', [app.pid]);
      if (row?.wait_event_type === 'Lock') return row;
      await new Promise(r => setTimeout(r, 10));
    }
    throw new Error('the app never queued on a lock within 5 s');
  }

  // Where the app stands once it stops moving — 'finished', 'failed (…)', or
  // the statement it is parked on a lock in — for a case whose point is that
  // the app must NOT queue. Never waits past 5 s.
  async function settles(app) {
    let settled = null;
    app.done.then(() => { settled = 'finished'; }, e => { settled = `failed (${e.message})`; });
    for (let i = 0; i < 500; i++) {
      if (settled) return settled;
      const row = await watch.oc('SELECT wait_event_type, query FROM pg_stat_activity WHERE pid=$1', [app.pid]);
      if (row?.wait_event_type === 'Lock') return `queued in: ${row.query}`;
      await new Promise(r => setTimeout(r, 10));
    }
    return 'still running after 5 s';
  }

  // syncPartLines' lock on a carton's part lines, before it reads their statuses.
  const PART_LOCK = 'SELECT id FROM order_lines WHERE id = ANY($1::int[]) ORDER BY id FOR NO KEY UPDATE';

  // A carton line with its two part lines (pending), made by syncPartLines as
  // order entry makes them — Part 1 first, so Part 1 has the LOWER id.
  let seq = 0;
  async function cartonWithParts(outer = ids.outer) {
    const { id: order } = await db.one(
      `INSERT INTO orders (po_number, customer_id, po_date) VALUES ($1,$2,'2026-09-30') RETURNING id`, [`LOCK-${++seq}`, ids.cust]);
    const { id: carton } = await db.one(
      'INSERT INTO order_lines (order_id, product_id, qty, rate) VALUES ($1,$2,1000,0) RETURNING id', [order, outer]);
    const made = await db.tx((qc, oc) => cpdb.syncPartLines(carton, qc, oc, 'fixture'));
    assert.equal(made.inserted, 2);
    const parts = await db.q('SELECT id, product_id, status FROM order_lines WHERE part_of_line_id=$1 ORDER BY id', [carton]);
    assert.deepEqual(parts.map(p => [p.product_id, p.status]), [[ids.p1, 'pending'], [ids.p2, 'pending']], 'Part 1 has the lower id');
    return { order, carton, part1: parts[0].id, part2: parts[1].id };
  }

  // Both part lines pushed to cards of their own (open), as Planning pushes them.
  async function pushParts(x) {
    const cards = [];
    for (const id of [x.part1, x.part2]) {
      await db.q(`UPDATE order_lines SET status='ready', artwork_locked=1, sheets_required=300, parent_sheets_required=300
                   WHERE id=$1`, [id]);
      const cardId = await db.tx((qc, oc) => H.createJobCardForLine(id, qc, oc, 'fixture'));
      cards.push(await db.one('SELECT * FROM job_cards WHERE id=$1', [cardId]));
    }
    return cards;
  }

  // Both part cards die-cut ('split'), no pasting card yet: the instant before
  // the last die cut's maybeCreateAssemblyCard. 250 sheets each: Part 1 makes
  // 1,000 pieces (4 ups), Part 2 500 (2 ups) — a pasting card for 500.
  async function bothPartsDieCut(x) {
    for (const card of await pushParts(x)) await db.tx((qc, oc) => cpdb.closePartCard(card, 250, qc, oc, 'fixture'));
    const cards = await db.q(`SELECT jc.status FROM job_cards jc JOIN order_lines ol ON ol.id = jc.order_line_id
                               WHERE ol.part_of_line_id=$1 ORDER BY jc.id`, [x.carton]);
    assert.deepEqual(cards.map(c => c.status), ['split', 'split']);
    assert.equal(await db.one('SELECT id FROM job_cards WHERE order_line_id=$1', [x.carton]), null);
  }

  // ── (i) Rollback of a part against a second update of its sibling ────────────
  // A part cannot be rolled back alone: rolling back Part 2 rolls back its whole
  // carton, which locks the carton and then each part in id order. Meanwhile
  // another save writes Part 1 twice — as an artwork lock does: the lock, then
  // 'ready' — and its second update KEY SHAREs the carton.
  test('(i) a part rolled back while its sibling part is updated twice: the carton is locked NO KEY UPDATE', async () => {
    const x = await cartonWithParts();
    const a = await connect();
    let app, queued, second;
    try {
      await a.c.query('BEGIN');
      // A's first write of Part 1 holds its row …
      await a.c.query(`UPDATE order_lines SET status='planned' WHERE id=$1`, [x.part1]);
      // … while the app rolls back Part 2: its whole carton. It locks the carton,
      // and the cascade reaches Part 1 first and queues on A.
      app = await inApp((qc, oc) => H.rollbackLine({ lineId: x.part2, mode: 'rollback' }, qc, oc, 'lock test'));
      queued = await untilQueued(app);
      // A writes Part 1 AGAIN: this second update re-checks part_of_line_id and
      // KEY SHAREs the carton, which the app holds (NO KEY UPDATE lets it pass).
      second = await outcome(a.c.query(`UPDATE order_lines SET status='pending' WHERE id=$1`, [x.part1]));
    } finally {
      await a.c.query(second?.ok === 'ok' ? 'COMMIT' : 'ROLLBACK').catch(() => {});
      await a.end();
    }
    const rolled = await outcome(app.done);
    assert.deepEqual({ a: second.ok, app: rolled.ok }, { a: 'ok', app: 'ok' }, `no 40P01 on either side — the app queued in: ${queued.query}`);
    assert.equal(queued.query, 'SELECT * FROM order_lines WHERE id=$1 FOR UPDATE', 'the cascade queued on Part 1');
    assert.equal(rolled.v.carton_line_id, x.carton, 'rolling back a part rolled back its carton');
    const lines = await db.q(`SELECT status, sheets_required, parent_sheets_required FROM order_lines
                               WHERE id = ANY($1::int[]) ORDER BY id`, [[x.carton, x.part1, x.part2]]);
    assert.deepEqual(lines.map(l => [l.status, l.sheets_required, l.parent_sheets_required]),
      [['pending', 0, 0], ['pending', null, null], ['pending', null, null]]);
  });

  // ── (ii) An order edit against the last die cut ───────────────────────────
  // An order edit holds its order FOR UPDATE, then writes its lines. The pasting
  // card walks the carton's status — a second update of the carton, whose
  // re-check KEY SHAREs the order. Taken only then, while holding the carton,
  // it would wait on the edit while the edit waits on the carton.
  test('(ii) an order edit against the last die cut: the pasting card share-locks the order before the carton', async () => {
    const x = await cartonWithParts();
    await bothPartsDieCut(x);
    const a = await connect();
    let app, queued, write;
    try {
      await a.c.query('BEGIN');
      await a.c.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [x.order]);      // the edit holds its order …
      app = await inApp((qc, oc) => cpdb.maybeCreateAssemblyCard(x.carton, qc, oc, 'lock test'));   // … the last part is die-cut …
      queued = await untilQueued(app);
      write = await outcome(a.c.query('UPDATE order_lines SET qty=qty WHERE id=$1', [x.carton]));   // … and the edit writes the carton
    } finally {
      await a.c.query(write?.ok === 'ok' ? 'COMMIT' : 'ROLLBACK').catch(() => {});
      await a.end();
    }
    const made = await outcome(app.done);
    assert.deepEqual({ a: write.ok, app: made.ok }, { a: 'ok', app: 'ok' }, `no 40P01 on either side — the app queued in: ${queued.query}`);
    assert.equal(queued.query, 'SELECT id FROM orders WHERE id=$1 FOR KEY SHARE', 'the app queued on the order, before the carton');
    const card = await db.one('SELECT id, is_assembly, qty_planned FROM job_cards WHERE order_line_id=$1', [x.carton]);
    assert.deepEqual([card?.id, card?.is_assembly, card?.qty_planned], [made.v, true, 500]);
    assert.equal((await db.one('SELECT status FROM order_lines WHERE id=$1', [x.carton])).status, 'in_production');
  });

  // ── (iii) A parts save against the last die cut ───────────────────────────
  // The same shape with the outer PRODUCT: the old parts save locked it FOR
  // UPDATE and then wrote the product's carton lines; the carton's second update
  // KEY SHAREs its product.
  test('(iii) a parts save against the last die cut: the pasting card share-locks the product before the carton', async () => {
    const x = await cartonWithParts();
    await bothPartsDieCut(x);
    const a = await connect();
    let app, queued, write;
    try {
      await a.c.query('BEGIN');
      await a.c.query('SELECT id FROM products WHERE id=$1 FOR UPDATE', [ids.outer]);   // the save holds the product …
      app = await inApp((qc, oc) => cpdb.maybeCreateAssemblyCard(x.carton, qc, oc, 'lock test'));   // … the last part is die-cut …
      queued = await untilQueued(app);
      write = await outcome(a.c.query('UPDATE order_lines SET qty=qty WHERE id=$1', [x.carton]));   // … and the save writes the carton
    } finally {
      await a.c.query(write?.ok === 'ok' ? 'COMMIT' : 'ROLLBACK').catch(() => {});
      await a.end();
    }
    const made = await outcome(app.done);
    assert.deepEqual({ a: write.ok, app: made.ok }, { a: 'ok', app: 'ok' }, `no 40P01 on either side — the app queued in: ${queued.query}`);
    assert.equal(queued.query, 'SELECT id FROM products WHERE id=$1 FOR KEY SHARE', 'the app queued on the product, before the carton');
    const card = await db.one('SELECT id, is_assembly, qty_planned FROM job_cards WHERE order_line_id=$1', [x.carton]);
    assert.deepEqual([card?.id, card?.is_assembly, card?.qty_planned], [made.v, true, 500]);
    assert.equal((await db.one('SELECT status FROM order_lines WHERE id=$1', [x.carton])).status, 'in_production');
  });

  // ── (iv) Both parts die-cut at the same moment ────────────────────────────
  // A part's last die cut closes its card and asks for the pasting card, in one
  // transaction (production.js). Two parts finishing together each close their
  // own card, then ask. The carton lock serialises the asking: the second waits
  // until the first COMMITs, then — READ COMMITTED, a fresh statement — sees
  // both cards split and makes the card. Without that lock, each would read the
  // other's card as still open (neither has committed) and neither would make it.
  test('(iv) both parts die-cut at the same moment: exactly one pasting card, and no error', async () => {
    const x = await cartonWithParts();
    const [card1, card2] = await pushParts(x);
    let letGo, askedFirst;
    const held = new Promise(r => { letGo = r; });
    const asked = new Promise(r => { askedFirst = r; });
    let first, second, queued;
    try {
      // Part 1's die cut closes its card and asks — Part 2 is not cut yet, so no
      // card — and its completion is still in flight: it holds the carton.
      first = await inApp(async (qc, oc) => {
        await cpdb.closePartCard(card1, 250, qc, oc, 'lock test');
        const made = await cpdb.maybeCreateAssemblyCard(x.carton, qc, oc, 'lock test');
        askedFirst();
        await held;
        return made;
      });
      await Promise.race([asked, first.done]);
      // Part 2's die cut, at that same moment: it closes its card and asks too.
      second = await inApp(async (qc, oc) => {
        await cpdb.closePartCard(card2, 250, qc, oc, 'lock test');
        return cpdb.maybeCreateAssemblyCard(x.carton, qc, oc, 'lock test');
      });
      queued = await untilQueued(second).catch(e => ({ query: `(it never queued: ${e.message})` }));
    } finally {
      letGo();
    }
    const [r1, r2] = [await outcome(first.done), await outcome(second.done)];
    const cards = await db.q('SELECT id, is_assembly, qty_planned FROM job_cards WHERE order_line_id=$1', [x.carton]);
    assert.deepEqual({ first: r1.ok, second: r2.ok }, { first: 'ok', second: 'ok' }, 'no error on either side');
    assert.equal(cards.length, 1, `exactly one pasting card — Part 2's question queued in: ${queued.query}`);
    assert.deepEqual([r1.v, r2.v], [null, cards[0].id], 'Part 1 found Part 2 still on the floor; Part 2, asking second, made the card');
    assert.equal(queued.query, 'SELECT * FROM order_lines WHERE id=$1 FOR NO KEY UPDATE', 'Part 2 queued on the carton Part 1 held');
    assert.deepEqual([cards[0].is_assembly, cards[0].qty_planned], [true, 500]);
    const partCards = await db.q('SELECT status FROM job_cards WHERE id = ANY($1::int[]) ORDER BY id', [[card1.id, card2.id]]);
    assert.deepEqual(partCards.map(c => c.status), ['split', 'split']);
  });

  // ── (v) A carton's qty edited while one of its parts goes under way ───────
  // A push commits a part's card without touching the carton, so the carton
  // lock alone never saw it: the sync read Part 1 as still in planning, then
  // its qty write queued behind the push and landed on a part already on the
  // floor. The sync now locks the part lines before it reads their statuses.
  test('(v) a carton qty edit against a part going under way: that part keeps its qty, the one still in planning follows', async () => {
    const x = await cartonWithParts();
    await db.q(`UPDATE order_lines SET status='planned' WHERE id = ANY($1::int[])`, [[x.part1, x.part2]]);
    const a = await connect();
    let app, queued, pushed;
    try {
      await a.c.query('BEGIN');
      // A holds Part 1 and moves it to the floor — what a push does …
      await a.c.query('SELECT id FROM order_lines WHERE id=$1 FOR UPDATE', [x.part1]);
      await a.c.query(`UPDATE order_lines SET status='in_production' WHERE id=$1`, [x.part1]);
      // … while the carton's qty is edited 1,000 → 1,200 and its parts follow.
      app = await inApp(async (qc, oc) => {
        await qc('UPDATE order_lines SET qty=1200 WHERE id=$1', [x.carton]);
        return cpdb.syncPartLines(x.carton, qc, oc, 'lock test');
      });
      queued = await untilQueued(app);
    } finally {
      pushed = await outcome(a.c.query('COMMIT'));
      await a.end();
    }
    const synced = await outcome(app.done);
    assert.deepEqual({ a: pushed.ok, app: synced.ok }, { a: 'ok', app: 'ok' }, `the sync queued in: ${queued.query}`);
    assert.equal(queued.query, PART_LOCK, 'the sync queued on the part lines, before reading their statuses');
    assert.deepEqual(synced.v, { inserted: 0, updated: 1, removed: 0, warnings: [
      'Part 1 is already in production, so its quantity stays at 1,000 — to change it, roll the carton back in Planning and save this order again',
    ] });
    const parts = await db.q('SELECT id, status, qty FROM order_lines WHERE part_of_line_id=$1 ORDER BY id', [x.carton]);
    assert.deepEqual(parts.map(p => [p.id, p.status, p.qty]), [[x.part1, 'in_production', 1000], [x.part2, 'planned', 1200]]);
  });

  // ── (vi) A parts-list change while one of its parts goes under way ───────
  // The same race on the LIST (C9): read unlocked, the carton looked unfrozen,
  // so a parts save swapped Part 2 out from under a carton whose Part 1 had just
  // gone to the floor. Under the part locks it sees the carton frozen.
  test('(vi) a parts-list change against a part going under way: the carton is seen frozen, and nothing changes', async () => {
    const x = await cartonWithParts(ids.outerL);
    const a = await connect();
    let app, queued, pushed;
    try {
      await a.c.query('BEGIN');
      await a.c.query('SELECT id FROM order_lines WHERE id=$1 FOR UPDATE', [x.part1]);
      await a.c.query(`UPDATE order_lines SET status='in_production' WHERE id=$1`, [x.part1]);
      // … while a parts save swaps Part 2 for another product and re-syncs the carton.
      app = await inApp(async (qc, oc) => {
        await qc('DELETE FROM product_parts WHERE outer_product_id=$1', [ids.outerL]);
        await qc(`INSERT INTO product_parts (outer_product_id, part_product_id, label, per_carton, seq)
                  VALUES ($1,$2,'Part 1',1,1), ($1,$3,'Part 2',1,2)`, [ids.outerL, ids.p1, ids.p3]);
        return cpdb.syncPartLines(x.carton, qc, oc, 'lock test');
      });
      queued = await untilQueued(app);
    } finally {
      pushed = await outcome(a.c.query('COMMIT'));
      await a.end();
    }
    const synced = await outcome(app.done);
    assert.deepEqual({ a: pushed.ok, app: synced.ok }, { a: 'ok', app: 'ok' }, `the sync queued in: ${queued.query}`);
    assert.equal(queued.query, PART_LOCK, 'the sync queued on the part lines, before reading their statuses');
    assert.deepEqual(synced.v, { inserted: 0, updated: 0, removed: 0, warnings: [
      'This carton is already under way as Part 1 + Part 2 — a changed parts list applies from the next order, or to this one once the carton is rolled back in Planning and this order saved again',
    ] });
    const parts = await db.q('SELECT id, product_id, status FROM order_lines WHERE part_of_line_id=$1 ORDER BY id', [x.carton]);
    assert.deepEqual(parts.map(p => [p.id, p.product_id, p.status]), [[x.part1, ids.p1, 'in_production'], [x.part2, ids.p2, 'pending']]);
  });

  // ── (vii) An order edit that leaves the carton alone ─────────────────────
  // PUT /orders holds its ORDER row FOR UPDATE before it syncs any carton. A
  // save that writes a part line twice (a plan save; a push from planned) holds
  // that part, and its second write re-checks the part's foreign keys, which
  // KEY SHAREs the order — so the sync must never wait on a part it will not
  // write, or every edit of such an order deadlocks against it. It locks the
  // parts only when it is about to write one or change the list.
  test('(vii) an order edit that leaves the carton alone never waits on its parts: a save writing a part twice goes through', async () => {
    const x = await cartonWithParts();
    const a = await connect();
    let app, raced, second;
    try {
      await a.c.query('BEGIN');
      // A holds Part 1 and writes it once (a plan save: pending → planned) …
      await a.c.query('SELECT id FROM order_lines WHERE id=$1 FOR NO KEY UPDATE', [x.part1]);
      await a.c.query(`UPDATE order_lines SET status='planned' WHERE id=$1`, [x.part1]);
      // … while the order is edited as PUT /orders edits it: its order row FOR
      // UPDATE, the carton written unchanged, the carton's parts synced …
      app = await inApp(async (qc, oc) => {
        await oc('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [x.order]);
        await qc('UPDATE order_lines SET qty=qty WHERE id=$1', [x.carton]);
        return cpdb.syncPartLines(x.carton, qc, oc, 'lock test');
      });
      raced = await settles(app);
      // … and A writes Part 1 again: its foreign-key re-check KEY SHAREs the order.
      second = await outcome(a.c.query(`UPDATE order_lines SET status='ready' WHERE id=$1`, [x.part1]));
    } finally {
      await a.c.query(second?.ok === 'ok' ? 'COMMIT' : 'ROLLBACK').catch(() => {});
      await a.end();
    }
    const edited = await outcome(app.done);
    assert.deepEqual({ a: second.ok, app: edited.ok }, { a: 'ok', app: 'ok' }, `no 40P01 on either side — the edit ${raced}`);
    assert.equal(raced, 'finished', 'the edit never waited on a part it does not write');
    assert.deepEqual(edited.v, { inserted: 0, updated: 0, removed: 0, warnings: [] });
    assert.equal((await db.one('SELECT status FROM order_lines WHERE id=$1', [x.part1])).status, 'ready');
  });

  // (viii) A carton qty edit while a part ALREADY PAST PLANNING is written twice
  // by another save — T: a reverse of Part 1's card to Planning (the line FOR
  // UPDATE, the artwork reset, then back to 'planned'), or a plan save / artwork
  // unlock on a ready part. T's second write re-checks the part's foreign keys
  // and KEY SHAREs the order; S (PUT /orders) holds that order FOR UPDATE and
  // syncs the carton's parts. The sync never writes Part 1 (past planning: a
  // warning only), so it must never wait on it — or the two deadlock.
  for (const [name, status] of [['in production (a reverse to Planning)', 'in_production'], ['ready (a plan save or artwork unlock)', 'ready']]) {
    test(`(viii) a carton qty edit against a double write on a part already ${name}: the edit never waits on that part`, async () => {
      const x = await cartonWithParts();
      await db.q('UPDATE order_lines SET status=$2 WHERE id=$1', [x.part1, status]);
      await db.q(`UPDATE order_lines SET status='planned' WHERE id=$1`, [x.part2]);
      const a = await connect();
      let app, raced, second;
      try {
        await a.c.query('BEGIN');
        await a.c.query('SELECT * FROM order_lines WHERE id=$1 FOR UPDATE', [x.part1]);
        await a.c.query('UPDATE order_lines SET artwork_locked=0 WHERE id=$1', [x.part1]);   // T's first write
        app = await inApp(async (qc, oc) => {
          await oc('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [x.order]);
          await qc('UPDATE order_lines SET qty=1200 WHERE id=$1', [x.carton]);
          return cpdb.syncPartLines(x.carton, qc, oc, 'edit');
        });
        raced = await settles(app);
        second = await outcome(a.c.query(`UPDATE order_lines SET status='planned' WHERE id=$1`, [x.part1]));   // T's second write
      } finally {
        await a.c.query(second?.ok === 'ok' ? 'COMMIT' : 'ROLLBACK').catch(() => {});
        await a.end();
      }
      const edited = await outcome(app.done);
      assert.deepEqual({ t: second.ok, edit: edited.ok }, { t: 'ok', edit: 'ok' }, `the edit ${raced}`);
      assert.equal(raced, 'finished', 'the edit never waited on a part it does not write');
    });
  }
});
