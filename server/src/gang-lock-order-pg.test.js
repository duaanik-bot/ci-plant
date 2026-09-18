import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// Gang lock order, run for real: two transactions on two connections against a
// real Postgres, with the tables and foreign keys whose row locks decide it
// (gang_runs ← order_lines ← job_cards ← job_stages, requisitions). Every case
// plays a FIXED interleaving twice: once in an order that deadlocks (Postgres
// kills one side, 40P01) and once in the order the code now takes through the
// real helpers.js lockLineGangFirst / lockGangsFirst, where both sides finish —
// and where the case says so, one side is shown to have really waited on the
// other, so "both finished" is not two transactions that never met.
//
// Opt-in, like doc-number-race-pg.test.js: it boots its OWN throwaway embedded
// Postgres in a temp dir on a free port and deletes it afterwards. It never
// reads DATABASE_URL and never touches a shared or production database.
//
//   GANG_LOCK_PG=1 node --test src/gang-lock-order-pg.test.js

const ENABLED = process.env.GANG_LOCK_PG === '1';

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.unref();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

describe('gang lock order under real concurrency', {
  skip: ENABLED ? false : 'set GANG_LOCK_PG=1 to boot a throwaway Postgres',
  timeout: 180_000,
}, () => {
  let epg, dir, port, pg, H;
  const clients = new Set();

  async function connect() {
    const c = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', password: 'postgres', database: 'postgres' });
    await c.connect();
    // Fast deadlock detection, and no wait can hang the suite.
    await c.query("SET deadlock_timeout = '200ms'; SET lock_timeout = '5s'");
    clients.add(c);
    const pid = (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const qc = (sql, params) => c.query(sql, params).then(r => r.rows);
    const oc = (sql, params) => c.query(sql, params).then(r => r.rows[0] || null);
    return { c, pid, qc, oc, end: async () => { clients.delete(c); await c.end(); } };
  }

  before(async () => {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    ({ default: pg } = await import('pg'));
    H = await import('./helpers.js');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gang-lock-order-'));
    port = await freePort();
    epg = new EmbeddedPostgres({ databaseDir: dir, port, user: 'postgres', password: 'postgres', persistent: false, onLog: () => {}, onError: () => {} });
    await epg.initialise();
    await epg.start();
    const s = await connect();
    await s.c.query(`
      CREATE TABLE gang_runs (id serial PRIMARY KEY, gang_number text UNIQUE);
      CREATE TABLE orders (id serial PRIMARY KEY, status text);
      CREATE TABLE order_lines (id int PRIMARY KEY, order_id int REFERENCES orders(id),
                                gang_run_id int REFERENCES gang_runs(id), status text, machine_id int);
      CREATE TABLE job_cards (id serial PRIMARY KEY, order_line_id int REFERENCES order_lines(id),
                              gang_run_id int REFERENCES gang_runs(id), parent_job_card_id int REFERENCES job_cards(id));
      CREATE TABLE job_stages (id serial PRIMARY KEY, job_card_id int REFERENCES job_cards(id), status text);
      CREATE TABLE requisitions (id serial PRIMARY KEY, order_line_id int REFERENCES order_lines(id));`);
    await s.end();
  });

  // Cleanup can never hang the suite or leave the cluster directory behind,
  // even when Postgres failed to start.
  after(async () => {
    const within = (p, ms) => Promise.race([p.catch(() => {}), new Promise(r => setTimeout(r, ms).unref())]);
    for (const c of clients) await within(c.end(), 2000);
    if (epg) await within(epg.stop(), 10_000);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  let seq = 0;
  // A gang of the given member ids (fresh ids each call) and, optionally, its
  // run card P with one stage S.
  async function gang(n = 2, { card = false } = {}) {
    const s = await connect();
    const g = (await s.oc('INSERT INTO gang_runs (gang_number) VALUES ($1) RETURNING id', [`G-${++seq}`])).id;
    const ids = Array.from({ length: n }, (_, i) => seq * 100 + i * 4 + 1);
    for (const id of ids) await s.qc("INSERT INTO order_lines (id, gang_run_id, status) VALUES ($1,$2,'ready')", [id, g]);
    let P = null, S = null;
    if (card) {
      P = (await s.oc('INSERT INTO job_cards (gang_run_id) VALUES ($1) RETURNING id', [g])).id;
      S = (await s.oc("INSERT INTO job_stages (job_card_id, status) VALUES ($1,'pending') RETURNING id", [P])).id;
    }
    await s.end();
    return { g, ids, P, S };
  }

  // Plays `schedule` — [['a', i], ['b', j], …] — over two transactions whose
  // step lists are `tx.a` and `tx.b`. Each step starts after that side's
  // previous step, and the next entry starts only once this one has finished
  // or is parked on a lock. A side's COMMIT follows its last scheduled step.
  // Returns { a, b } = 'ok' or the SQLSTATE it died with, and who waited.
  async function play(tx, schedule) {
    const watch = await connect();
    const side = {};
    for (const k of Object.keys(tx)) {
      const t = await connect();
      await t.c.query('BEGIN');
      side[k] = { t, chain: Promise.resolve(), dead: null, waited: false, last: Math.max(...schedule.filter(([s]) => s === k).map(([, i]) => i)) };
    }
    const waiting = async pid => (await watch.oc("SELECT wait_event_type = 'Lock' AS w FROM pg_stat_activity WHERE pid=$1", [pid]))?.w;
    for (const [k, i] of schedule) {
      const s = side[k];
      let done = false;
      s.chain = s.chain.then(async () => {
        if (s.dead) return;
        try {
          await tx[k][i](s.t);
          if (i === s.last) await s.t.c.query('COMMIT');
        } catch (e) { s.dead = e.code || e.message; await s.t.c.query('ROLLBACK').catch(() => {}); }
      }).finally(() => { done = true; });
      let parked = false;
      for (let n = 0; n < 500 && !done; n++) {
        if (await waiting(s.t.pid)) { s.waited = parked = true; break; }
        await new Promise(r => setTimeout(r, 10));
      }
      // Neither finished nor parked on a lock within 5 s: the interleaving is
      // not what the case says — fail rather than play on silently.
      if (!done && !parked) throw new Error(`step ${k}${i} neither finished nor waited on a lock`);
    }
    await Promise.all(Object.values(side).map(s => s.chain));
    const out = {};
    for (const [k, s] of Object.entries(side)) { out[k] = s.dead || 'ok'; out[`${k}Waited`] = s.waited; await s.t.end(); }
    await watch.end();
    return out;
  }
  const deadlocked = r => r.a === '40P01' || r.b === '40P01';

  // ── Push against push ────────────────────────────────────────────────────
  test('push on B against push on A', async () => {
    const oldPush = (g, clicked) => [
      t => t.oc('SELECT * FROM order_lines WHERE id=$1 FOR UPDATE', [clicked]),
      t => t.qc('SELECT id FROM order_lines WHERE gang_run_id=$1 ORDER BY id FOR UPDATE', [g]),
      t => t.qc('INSERT INTO job_cards (gang_run_id) VALUES ($1)', [g]),
    ];
    const newPush = (g, clicked) => [
      t => H.lockLineGangFirst(clicked, t.qc, t.oc, H.PUSH_LOCKS),
      t => t.qc('SELECT id FROM order_lines WHERE gang_run_id=$1 ORDER BY id FOR NO KEY UPDATE', [g]),
      t => t.qc('INSERT INTO job_cards (gang_run_id) SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM job_cards WHERE gang_run_id=$1)', [g]),
    ];
    const plan = [['a', 0], ['b', 0], ['a', 1], ['b', 1], ['a', 2], ['b', 2]];
    const x = await gang();
    assert.ok(deadlocked(await play({ a: oldPush(x.g, x.ids[1]), b: oldPush(x.g, x.ids[0]) }, plan)), 'the old order should deadlock');
    const y = await gang();
    const r = await play({ a: newPush(y.g, y.ids[1]), b: newPush(y.g, y.ids[0]) }, plan);
    assert.deepEqual([r.a, r.b], ['ok', 'ok']);
    assert.ok(r.bWaited, 'the second push must have queued on the first');
  });

  // ── Push against a gang edit (gangs.js: run FOR UPDATE, then a member) ──
  test('push against a gang edit', async () => {
    const edit = (g, member) => [
      t => t.oc('SELECT id FROM gang_runs WHERE id=$1 FOR UPDATE', [g]),
      t => t.qc("UPDATE order_lines SET status='planned' WHERE id=$1", [member]),
    ];
    const x = await gang();
    const oldPush = [
      async t => { await t.oc('SELECT * FROM order_lines WHERE id=$1 FOR UPDATE', [x.ids[1]]);
                   await t.qc('SELECT id FROM order_lines WHERE gang_run_id=$1 ORDER BY id FOR UPDATE', [x.g]); },
      t => t.qc('INSERT INTO job_cards (gang_run_id) VALUES ($1)', [x.g]),
    ];
    assert.ok(deadlocked(await play({ a: oldPush, b: edit(x.g, x.ids[0]) }, [['a', 0], ['b', 0], ['b', 1], ['a', 1]])), 'the old order should deadlock');
    const y = await gang();
    const newPush = [
      async t => { await H.lockLineGangFirst(y.ids[1], t.qc, t.oc, H.PUSH_LOCKS);
                   await t.qc('SELECT id FROM order_lines WHERE gang_run_id=$1 ORDER BY id FOR NO KEY UPDATE', [y.g]); },
      t => t.qc('INSERT INTO job_cards (gang_run_id) VALUES ($1)', [y.g]),
    ];
    const r = await play({ a: newPush, b: edit(y.g, y.ids[0]) }, [['a', 0], ['b', 0], ['b', 1], ['a', 1]]);
    assert.deepEqual([r.a, r.b], ['ok', 'ok']);
    assert.ok(r.bWaited, 'the gang edit must have queued on the push');
  });

  // ── Push against a PR on member B mirrored onto mate A (FK share-locks) ──
  test('push against a PR that share-locks B then A', async () => {
    const pr = (A, B) => [
      t => t.qc('INSERT INTO requisitions (order_line_id) VALUES ($1)', [B]),
      t => t.qc('INSERT INTO requisitions (order_line_id) VALUES ($1)', [A]),
    ];
    const x = await gang();
    const oldPush = [
      t => t.oc('SELECT * FROM order_lines WHERE id=$1 FOR UPDATE', [x.ids[0]]),
      t => t.qc('SELECT id FROM order_lines WHERE gang_run_id=$1 ORDER BY id FOR UPDATE', [x.g]),
    ];
    assert.ok(deadlocked(await play({ a: pr(x.ids[0], x.ids[1]), b: oldPush }, [['a', 0], ['b', 0], ['b', 1], ['a', 1]])), 'the old order should deadlock');
    const y = await gang();
    const newPush = [
      t => H.lockLineGangFirst(y.ids[0], t.qc, t.oc, H.PUSH_LOCKS),
      t => t.qc('SELECT id FROM order_lines WHERE gang_run_id=$1 ORDER BY id FOR NO KEY UPDATE', [y.g]),
    ];
    const r = await play({ a: pr(y.ids[0], y.ids[1]), b: newPush }, [['a', 0], ['b', 0], ['b', 1], ['a', 1]]);
    assert.deepEqual([r.a, r.b], ['ok', 'ok'], 'NO KEY UPDATE on the members lets the PR insert alongside');
  });

  // ── A save that updates a ganged line TWICE (artwork lock, consume-FG) ──
  // Its second UPDATE re-runs the gang foreign key and share-locks the run. A
  // rollback / plan save / reverse holding the run FOR UPDATE deadlocks it; the
  // NO KEY UPDATE they now take lets it through.
  test('a line updated twice against rollback / plan save on the same line', async () => {
    const twice = L => [
      t => t.qc("UPDATE order_lines SET status='a' WHERE id=$1", [L]),
      t => t.qc("UPDATE order_lines SET status='b' WHERE id=$1", [L]),
    ];
    const x = await gang();
    const strong = [async t => { await t.oc('SELECT id FROM gang_runs WHERE id=$1 FOR UPDATE', [x.g]);
                                 await t.oc('SELECT * FROM order_lines WHERE id=$1 FOR UPDATE', [x.ids[0]]); }];
    assert.ok(deadlocked(await play({ a: twice(x.ids[0]), b: strong }, [['a', 0], ['b', 0], ['a', 1]])), 'a gang FOR UPDATE should deadlock');
    const y = await gang();
    const rollback = [t => H.lockLineGangFirst(y.ids[0], t.qc, t.oc, { gang: 'NO KEY UPDATE', line: 'UPDATE' })];
    const r = await play({ a: twice(y.ids[0]), b: rollback }, [['a', 0], ['b', 0], ['a', 1]]);
    assert.deepEqual([r.a, r.b], ['ok', 'ok']);
    assert.ok(r.bWaited, 'the rollback must have queued on the line');
  });

  // ── Stage start (stage, then card) against a reverse of the gang's job ──
  // Stage start / complete lock the stage, then the card. A reverse that
  // pre-locked the card before deleting its stages deadlocked them; the reverse
  // now reaches stages before the card, as they do.
  test('stage start against reverse_job_card on a member', async () => {
    const start = (S, P) => [
      t => t.oc('SELECT id FROM job_stages WHERE id=$1 FOR UPDATE', [S]),
      t => t.oc('SELECT id FROM job_cards WHERE id=$1 FOR UPDATE', [P]),
    ];
    const reverse = (x, locks) => [
      t => H.lockLineGangFirst(x.ids[0], t.qc, t.oc, locks),
      t => t.qc('DELETE FROM job_stages WHERE job_card_id=$1', [x.P]),
      t => t.qc('DELETE FROM job_cards WHERE id=$1', [x.P]),
    ];
    const plan = [['a', 0], ['b', 0], ['b', 1], ['a', 1], ['b', 2]];
    const x = await gang(2, { card: true });
    assert.ok(deadlocked(await play({ a: start(x.S, x.P), b: reverse(x, { gang: 'NO KEY UPDATE', card: 'UPDATE', line: 'UPDATE' }) }, plan)),
      'a card pre-lock should deadlock');
    const y = await gang(2, { card: true });
    const r = await play({ a: start(y.S, y.P), b: reverse(y, { gang: 'NO KEY UPDATE', line: 'UPDATE' }) }, plan);
    assert.deepEqual([r.a, r.b], ['ok', 'ok']);
    assert.ok(r.bWaited, 'the reverse must have queued on the stage');
  });

  // ── Two orders deleted at once, their lines across the same two gangs ──
  test('two order deletes across the same gangs', async () => {
    const g1 = await gang(3), g2 = await gang(3);
    const A = [g1.ids[0], g2.ids[0]], B = [g2.ids[1], g1.ids[1]];
    const perLine = ids => ids.map(id => t => H.lockLineGangFirst(id, t.qc, t.oc, { gang: 'NO KEY UPDATE', line: 'UPDATE' }));
    assert.ok(deadlocked(await play({ a: perLine(A), b: perLine(B) }, [['a', 0], ['b', 0], ['a', 1], ['b', 1]])),
      'gangs taken line by line should deadlock');
    const h1 = await gang(3), h2 = await gang(3);
    const A2 = [h1.ids[0], h2.ids[0]], B2 = [h2.ids[1], h1.ids[1]];
    const deleteOrder = ids => [
      t => H.lockGangsFirst([...ids.map(id => (id === h1.ids[0] || id === h1.ids[1]) ? h1.g : h2.g)], t.qc),
      ...perLine(ids),
    ];
    const r = await play({ a: deleteOrder(A2), b: deleteOrder(B2) }, [['a', 0], ['b', 0], ['a', 1], ['b', 1], ['a', 2], ['b', 2]]);
    assert.deepEqual([r.a, r.b], ['ok', 'ok']);
    assert.ok(r.bWaited, 'the second delete must have queued on the first');
  });

  // ── Pull-back on a split gang against a push on a member ─────────────────
  // A push on a run that already has its card locks the card before the line.
  // Pull-back used to walk card, line, card, line in no set order; it now takes
  // every card (parent first) and then the lines.
  test('pull-back on a split gang against a push on a member', async () => {
    const split = async () => {
      const x = await gang(2, { card: true });
      const s = await connect();
      const kids = [];
      for (const id of x.ids) kids.push((await s.oc('INSERT INTO job_cards (order_line_id, gang_run_id, parent_job_card_id) VALUES ($1,$2,$3) RETURNING id', [id, x.g, x.P])).id);
      await s.end();
      return { ...x, kids };
    };
    const push = x => [t => H.lockLineGangFirst(x.ids[0], t.qc, t.oc, H.PUSH_LOCKS)];
    // A non-key UPDATE of a card / a line: the row locks pull-back's writes take.
    const card = id => t => t.qc('UPDATE job_cards SET parent_job_card_id = parent_job_card_id WHERE id=$1', [id]);
    const line = id => t => t.qc('UPDATE order_lines SET machine_id = NULL WHERE id=$1', [id]);
    const x = await split();
    const oldPull = [card(x.kids[0]), line(x.ids[0]), card(x.P)];
    assert.ok(deadlocked(await play({ a: oldPull, b: push(x) }, [['a', 0], ['a', 1], ['b', 0], ['a', 2]])), 'card, line, card should deadlock');
    const y = await split();
    const newPull = [card(y.P), card(y.kids[0]), line(y.ids[0])];   // pullBackToJobCard: cards ORDER BY id (parent first), then lines
    const r = await play({ a: newPull, b: push(y) }, [['a', 0], ['a', 1], ['b', 0], ['a', 2]]);
    assert.deepEqual([r.a, r.b], ['ok', 'ok']);
    assert.ok(r.bWaited, 'the push must have queued on the card');
  });

  // ── Deleting an order against a plan save on one of its ganged lines ─────
  // The plan save holds the gang, then updates its line twice — the second
  // UPDATE share-locks the order row. The delete used to hold the order row and
  // then wait for the gang; it now takes the gang first.
  test('deleting an order against a plan save on its ganged line', async () => {
    const withOrder = async () => {
      const x = await gang();
      const s = await connect();
      const o = (await s.oc("INSERT INTO orders (status) VALUES ('pending') RETURNING id")).id;
      await s.qc('UPDATE order_lines SET order_id=$1 WHERE id=$2', [o, x.ids[0]]);
      await s.end();
      return { ...x, o };
    };
    const planSave = x => [
      t => t.oc('SELECT id FROM gang_runs WHERE id=$1 FOR NO KEY UPDATE', [x.g]),
      t => t.qc("UPDATE order_lines SET status='planned' WHERE id=$1", [x.ids[0]]),
      t => t.qc("UPDATE order_lines SET status='ready' WHERE id=$1", [x.ids[0]]),
    ];
    const x = await withOrder();
    const oldDelete = [
      t => t.oc('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [x.o]),
      t => H.lockGangsFirst([x.g], t.qc),
    ];
    assert.ok(deadlocked(await play({ a: planSave(x), b: oldDelete }, [['a', 0], ['b', 0], ['b', 1], ['a', 1], ['a', 2]])),
      'order row, then gang, should deadlock');
    const y = await withOrder();
    const newDelete = [
      t => H.lockGangsFirst([y.g], t.qc),
      t => t.oc('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [y.o]),
    ];
    const r = await play({ a: planSave(y), b: newDelete }, [['a', 0], ['b', 0], ['b', 1], ['a', 1], ['a', 2]]);
    assert.deepEqual([r.a, r.b], ['ok', 'ok']);
    assert.ok(r.bWaited, 'the delete must have queued on the gang');
  });

  // ── The unlocked peek ────────────────────────────────────────────────────
  test('a line that joins a gang between the peek and the lock is refused', async () => {
    const { g } = await gang();
    const s = await connect();
    const loner = 99_999;
    await s.qc("INSERT INTO order_lines (id, status) VALUES ($1, 'ready')", [loner]);
    const t = await connect();
    await t.c.query('BEGIN');
    const oc = async (sql, params) => {
      const row = await t.oc(sql, params);
      if (/^SELECT gang_run_id FROM order_lines/.test(sql)) await s.qc('UPDATE order_lines SET gang_run_id=$1 WHERE id=$2', [g, loner]);
      return row;
    };
    await assert.rejects(H.lockLineGangFirst(loner, t.qc, oc, H.PUSH_LOCKS), e => e.status === 409 && /gang changed just now/.test(e.message));
    await t.c.query('ROLLBACK');
    await t.end(); await s.end();
  });
});
