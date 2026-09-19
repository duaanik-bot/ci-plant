import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// Product Internal Codes (SW-769…) through the REAL routes — Masters create /
// edit / migrate and the PO-import quick-create — against a real Postgres with
// the app's own schema. doc-number-race-pg.test.js proves the helpers; this
// proves the routes wire them: each write queues on its series, on the
// transaction that writes the code, and a doubled move lands once.
//
// The overlaps are made deterministic, not hoped for: the test itself holds a
// series lock, fires the requests, waits until Postgres shows each of them
// queued behind it, then lets go.
//
// Opt-in with the same flag as the helper races; it boots its OWN throwaway
// Postgres in a temp dir on a free port and deletes it afterwards.
//
//   DOC_NUMBER_RACE_PG=1 node --test src/product-code-routes-pg.test.js

const ENABLED = process.env.DOC_NUMBER_RACE_PG === '1';

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.unref();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

describe('product codes through the real routes', {
  skip: ENABLED ? false : 'set DOC_NUMBER_RACE_PG=1 to boot a throwaway Postgres',
}, () => {
  let epg, dir, db, server, base, board;

  before(async () => {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'product-code-routes-'));
    const port = await freePort();
    epg = new EmbeddedPostgres({
      databaseDir: dir, port, user: 'postgres', password: 'postgres',
      persistent: false, onLog: () => {}, onError: () => {},
    });
    await epg.initialise();
    await epg.start();
    process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
    db = await import('./db.js');
    await db.connect();
    await db.init();
    ({ id: board } = await db.one(`INSERT INTO materials (name, category) VALUES ('FBB Board 300 GSM', 'board') RETURNING id`));

    const { default: express } = await import('express');
    const { default: masters } = await import('./routes/masters.js');
    const { default: importRoutes } = await import('./routes/import.js');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: 1, role: 'admin', name: 'race test' }; next(); });
    app.use('/api', masters);
    app.use('/api', importRoutes);
    app.use((e, _req, res, _next) => res.status(e.status || 500).json({ error: e.message }));
    server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}/api`;
  });

  after(async () => {
    server?.close();
    try { await (await db?.connect())?.end(); } catch {}
    try { await epg?.stop(); } catch {}
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const customer = async name => (await db.one(`INSERT INTO customers (name) VALUES ($1) RETURNING id`, [name])).id;
  const product = async (customerId, code) => (await db.one(
    `INSERT INTO products (customer_id, name, code, internal_carton_code, board_material_id) VALUES ($1, $2, $3, $3, $4) RETURNING id`,
    [customerId, `carton ${code}`, code, board])).id;

  // Hold a series lock the way a slow first save would; the routes queue on
  // it. `whileHeld` fires the saves and waits for them to queue; the lock is
  // let go whatever happens, so a save that never queued fails the test
  // instead of hanging it.
  async function queueBehind(prefix, whileHeld) {
    const letGo = await holdSeries(prefix);
    try { return await whileHeld(); } finally { await letGo(); }
  }
  async function holdSeries(prefix) {
    let release, held;
    const released = new Promise(r => { release = r; });
    const isHeld = new Promise(r => { held = r; });
    const done = db.tx(async (_qc, oc) => {
      await oc('SELECT pg_advisory_xact_lock(764002, hashtext($1))', [`product-code:${prefix}`]);
      held();
      await released;
    });
    await isHeld;
    return async () => { release(); await done; };
  }
  async function untilQueued(n) {
    for (let i = 0; i < 300; i++) {
      const { c } = await db.one(`SELECT count(*)::int AS c FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`);
      if (c >= n) return;
      await new Promise(r => setTimeout(r, 10));
    }
    throw new Error(`fewer than ${n} saves ever queued on the series lock`);
  }

  test('two blank-code Masters creates at once get consecutive codes — the lock is held to COMMIT', async () => {
    const sw = await customer('Swiss Garnier');
    await product(sw, 'SW-767');
    const saves = await queueBehind('SW', async () => {
      const fired = [1, 2].map(i => call('POST', '/products', { customer_id: sw, name: `new ${i}`, code: '', board_material_id: board }));
      await untilQueued(2);
      return fired;
    });
    const out = await Promise.all(saves);
    assert.deepEqual(out.map(o => o.status), [200, 200], JSON.stringify(out.map(o => o.body)));
    assert.deepEqual(out.map(o => o.body.code).sort(), ['SW-768', 'SW-769']);
  });

  test('a typed code queues with the minters, so a quick-create never loses its code to it', async () => {
    const hrb = await customer('Hindustan Rubber Belts');
    await product(hrb, 'HRB-003');
    const [typed, minted] = await queueBehind('HRB', async () => {
      const t = call('POST', '/products', { customer_id: hrb, name: 'typed', code: 'HRB-004', board_material_id: board });
      await untilQueued(1);
      const m = call('POST', '/orders/import/quick-product', { customer_id: hrb, name: 'minted', code: null, board_material_id: board });
      await untilQueued(2);
      return [t, m];
    });
    const [t, m] = await Promise.all([typed, minted]);
    assert.equal(m.status, 200, m.body.error);
    assert.ok(t.status === 200 || (t.status === 409 && /HRB-004 is already taken/.test(t.body.error)), JSON.stringify(t));
    if (t.status === 200) assert.notEqual(t.body.code, m.body.code);
  });

  test('a typed quick-create code and a retyped edit queue on their series too', async () => {
    const pf = await customer('Pharma First');
    const id = await product(pf, 'PF-010');
    const saves = await queueBehind('PF', async () => {
      const fired = [
        call('POST', '/orders/import/quick-product', { customer_id: pf, name: 'typed quick', code: 'PF-011', board_material_id: board }),
        call('PUT', `/products/${id}`, { code: 'PF-012', _loaded_customer_id: pf }),
      ];
      await untilQueued(2);
      return fired;
    });
    const [q, e] = await Promise.all(saves);
    assert.deepEqual([q.status, q.body.code, e.status, e.body.code], [200, 'PF-011', 200, 'PF-012']);
  });

  test('a customer with no Latin letter in its name: typed and minted codes share one queue', async () => {
    const odd = await customer('ਪੰਜਾਬ');
    // In an array: a bare promise returned from `whileHeld` would be awaited
    // while the lock it is queued on is still held.
    const [typed] = await queueBehind('', async () => {
      const fired = call('POST', '/products', { customer_id: odd, name: 'typed', code: '-001', board_material_id: board });
      await untilQueued(1);
      return [fired];
    });
    assert.equal((await typed).body.code, '-001');
    const minted = await call('POST', '/orders/import/quick-product', { customer_id: odd, name: 'minted', code: null, board_material_id: board });
    assert.deepEqual([minted.status, minted.body.code], [200, '-002']);
  });

  test('the same move saved twice at once moves it once, and the stale form is refused after', async () => {
    const a = await customer('Swiss Pharma');
    const b = await customer('Galpha Labs');
    await product(b, 'GL-020');
    const id = await product(a, 'SP-005');
    // What the edit form sends after the customer is changed: the OLD code.
    const move = { customer_id: b, name: 'carton SP-005', code: 'SP-005', _loaded_customer_id: a };
    const saves = await queueBehind('GL', async () => {
      const fired = [1, 2].map(() => call('PUT', `/products/${id}`, move));
      await untilQueued(2);
      return fired;
    });
    const out = await Promise.all(saves);
    assert.deepEqual(out.map(o => o.status).sort(), [200, 409], JSON.stringify(out.map(o => o.body)));
    const row = await db.one('SELECT customer_id, code, internal_carton_code FROM products WHERE id=$1', [id]);
    assert.deepEqual(row, { customer_id: b, code: 'GL-021', internal_carton_code: 'GL-021' });
    const audits = await db.q(`SELECT detail FROM audit_log WHERE entity='products' AND entity_id=$1 AND action='update'`, [id]);
    assert.equal(audits.length, 1, 'one move, one history row');

    // The loser presses Save again on the same form: refused, nothing written.
    const again = await call('PUT', `/products/${id}`, move);
    assert.equal(again.status, 409);
    assert.match(again.body.error, /moved to another customer since you opened it/);
    assert.deepEqual(await db.one('SELECT customer_id, code FROM products WHERE id=$1', [id]), { customer_id: b, code: 'GL-021' });
  });

  test('the same migrate sent twice at once moves it once, and both callers get the moved product', async () => {
    const a = await customer('Swiss Biotech');
    const b = await customer('Swiss Life Sciences');
    await product(b, 'SLS-100');
    const id = await product(a, 'SB-007');
    const moves = await queueBehind('SLS', async () => {
      const fired = [1, 2].map(() => call('POST', `/products/${id}/migrate-customer`, { customer_id: b }));
      await untilQueued(2);
      return fired;
    });
    const out = await Promise.all(moves);
    assert.deepEqual(out.map(o => [o.status, o.body.code]), [[200, 'SLS-101'], [200, 'SLS-101']], JSON.stringify(out.map(o => o.body)));
    const again = await call('POST', `/products/${id}/migrate-customer`, { customer_id: b });
    assert.deepEqual([again.status, again.body.code], [200, 'SLS-101'], 'a later retry takes it as it is');
    const audits = await db.q(`SELECT detail FROM audit_log WHERE entity='product' AND entity_id=$1 AND action='migrate'`, [id]);
    assert.equal(audits.length, 1, 'one move, one history row');
  });
});
