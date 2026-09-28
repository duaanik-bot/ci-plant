import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// Rolling a line back must take back the loose cartons that consuming a
// LEFTOVER box put into fg_stock — through the REAL app against a real Postgres
// with the app's own schema and demo seed.
//
// A leftover box (fg_lots.kind='leftover') is physical stock held OUT of loose
// fg_stock. consume-fg allocating it to a line pushes the pieces into fg_stock
// (fgReceipt 'leftover_consume') so the order can dispatch them. The two ways
// back must both undo that push:
//   • POST /order-lines/:id/release-fg → releaseFgConsumption — always did.
//   • POST /order-lines/:id/rollback  → rollbackLine → releaseFgReservation —
//     restored the box but left the pieces loose, so the same cartons existed
//     twice: back in the box AND in fg_stock.
//
// Opt-in: boots its OWN throwaway Postgres in a temp dir on a free port, with
// PG_POOL_MAX=1 (the Vercel geometry — a pool call inside a transaction hangs).
//
//   FG_RELEASE_PG=1 node --test src/fg-release-leftover-pg.test.js

const ENABLED = process.env.FG_RELEASE_PG === '1';

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.unref();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

describe('a leftover box consumed against a line, then given back — through the real app', {
  skip: ENABLED ? false : 'set FG_RELEASE_PG=1 to boot a throwaway Postgres',
}, () => {
  let epg, dir, db, server, base, token;
  const PRODUCT = 1;
  const LOOSE = 500; // loose cartons already on the shelf before anything happens

  before(async () => {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-release-leftover-'));
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

    const { default: jwt } = await import('jsonwebtoken');
    const { JWT_SECRET } = await import('./auth.js');
    const u = await db.one(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ('FG release', 'fg-release@test.local', 'x', 'admin') RETURNING id, name, role`);
    token = jwt.sign({ id: u.id, name: u.name, role: u.role }, JWT_SECRET);

    const { default: app } = await import('./app.js');
    server = await new Promise(res => { const s = app.listen(0, () => res(s)); });
    base = `http://127.0.0.1:${server.address().port}/api`;

    await db.q(`INSERT INTO fg_stock (product_id, qty) VALUES ($1,$2)
                ON CONFLICT (product_id) DO UPDATE SET qty=EXCLUDED.qty`, [PRODUCT, LOOSE]);
  });

  after(async () => {
    server?.close();
    try { await (await db?.connect())?.end(); } catch {}
    try { await epg?.stop(); } catch {}
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, body: json };
  };
  const loose = async () => +((await db.one('SELECT qty FROM fg_stock WHERE product_id=$1', [PRODUCT]))?.qty ?? 0);
  const lotOf = id => db.one('SELECT status, qty, consumed_qty FROM fg_lots WHERE id=$1', [id]);

  let seq = 0;
  // A pending line of 1,000 and a verified box of `boxQty` of the same carton.
  const fixture = async (kind, boxQty = 300) => {
    const n = ++seq;
    const order = await db.one(
      `INSERT INTO orders (po_number, customer_id, po_date, delivery_date, status)
       VALUES ($1, 1, CURRENT_DATE::text, CURRENT_DATE::text, 'pending') RETURNING id`, [`FGREL-${n}`]);
    const line = (await db.one(
      `INSERT INTO order_lines (order_id, product_id, qty, rate, status)
       VALUES ($1,$2,1000,1,'pending') RETURNING id`, [order.id, PRODUCT])).id;
    const lot = (await db.one(
      `INSERT INTO fg_lots (lot_number, product_id, qty, source, status, kind)
       VALUES ($1,$2,$3,'manual','verified',$4) RETURNING id`,
      [`FGREL-LOT-${n}`, PRODUCT, boxQty, kind])).id;
    return { line, lot };
  };

  test('consuming a leftover box moves its pieces into loose FG (the push the rollback must undo)', async () => {
    const f = await fixture('leftover');
    const before = await loose();
    const r = await call('POST', `/order-lines/${f.line}/consume-fg`, { lot_id: f.lot, qty: 300 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await loose(), before + 300, 'the precondition this guard stands on');
  });

  test('rollback of a line holding a WHOLE leftover box: box restored, loose FG back where it was', async () => {
    const f = await fixture('leftover');
    const before = await loose();
    assert.equal((await call('POST', `/order-lines/${f.line}/consume-fg`, { lot_id: f.lot, qty: 300 })).status, 200);
    assert.equal((await lotOf(f.lot)).status, 'consumed');

    const r = await call('POST', `/order-lines/${f.line}/rollback`, { mode: 'rollback' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await lotOf(f.lot), { status: 'verified', qty: 300, consumed_qty: 0 }, 'the box is whole again');
    assert.equal(await loose(), before,
      'the 300 pieces are back in the box — they must not ALSO still be loose (counted twice)');
  });

  test('rollback of a PARTIAL leftover consumption takes back only what was consumed', async () => {
    const f = await fixture('leftover', 400);
    const before = await loose();
    assert.equal((await call('POST', `/order-lines/${f.line}/consume-fg`, { lot_id: f.lot, qty: 150 })).status, 200);
    assert.equal(await loose(), before + 150);

    const r = await call('POST', `/order-lines/${f.line}/rollback`, { mode: 'rollback' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await lotOf(f.lot), { status: 'verified', qty: 400, consumed_qty: 0 });
    assert.equal(await loose(), before);
  });

  test('delete mode goes through the same release — loose FG back where it was', async () => {
    const f = await fixture('leftover');
    const before = await loose();
    assert.equal((await call('POST', `/order-lines/${f.line}/consume-fg`, { lot_id: f.lot, qty: 300 })).status, 200);
    const r = await call('POST', `/order-lines/${f.line}/rollback`, { mode: 'delete' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await loose(), before);
    assert.equal((await lotOf(f.lot)).consumed_qty, 0);
  });

  test('a NON-leftover lot never touched loose FG, so its rollback must not either', async () => {
    const f = await fixture('fg_excess');
    const before = await loose();
    assert.equal((await call('POST', `/order-lines/${f.line}/consume-fg`, { lot_id: f.lot, qty: 300 })).status, 200);
    assert.equal(await loose(), before, 'an fg_excess lot is a reservation only');
    const r = await call('POST', `/order-lines/${f.line}/rollback`, { mode: 'rollback' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await loose(), before);
    assert.equal((await lotOf(f.lot)).consumed_qty, 0);
  });

  test('the sibling door (release-fg) agrees with rollback — both leave loose FG where it began', async () => {
    const f = await fixture('leftover');
    const before = await loose();
    assert.equal((await call('POST', `/order-lines/${f.line}/consume-fg`, { lot_id: f.lot, qty: 300 })).status, 200);
    const r = await call('POST', `/order-lines/${f.line}/release-fg`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await loose(), before);
  });

  test('the stock ledger nets to zero for every leftover box given back', async () => {
    // fg_stock is a level; stock_movements is its trail. Each leftover push
    // ('leftover_consume') must be matched by a take-back ('fg_release').
    const rows = await db.q(
      `SELECT ref_id, SUM(qty)::int AS net FROM stock_movements
       WHERE product_id=$1 AND type='fg_receipt' AND ref_type IN ('leftover_consume','fg_release')
       GROUP BY ref_id`, [PRODUCT]);
    assert.ok(rows.length >= 4, `non-vacuity: expected every leftover lot above in the trail, got ${rows.length}`);
    // The first test's box was consumed and never given back — the only one allowed a net.
    const open = rows.filter(r => r.net !== 0);
    assert.equal(open.length, 1, `only the never-released box may carry a net: ${JSON.stringify(rows)}`);
    assert.equal(open[0].net, 300);
  });
});
