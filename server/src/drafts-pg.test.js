import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// Draft sales orders from the AVS intake (owner's request, 6 Oct 2026), proved
// through the REAL app against a real Postgres with the app's own schema:
//   • a line booked under a draft order is a draft line (the database trigger),
//     whether the intake inserts it by SQL or an edit adds it;
//   • a draft shows on Sales Orders, Sales Pendency and the Status Sheet, takes
//     no FG cover, and never reaches the Planning queue;
//   • Confirm turns the order and every line pending (Planning sees them) and
//     confirms the draft masters on it — once; a second confirm is refused;
//   • a draft can be cancelled, and its lines go with it.
//
//   DRAFTS_PG=1 node --test src/drafts-pg.test.js

const ENABLED = process.env.DRAFTS_PG === '1';

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.unref();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

// Every { id, order_id } row anywhere in a response (the planning answer's shape varies by scope).
const lineIdsIn = body => {
  const out = new Set();
  const walk = v => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      if (v.order_id != null && v.id != null) out.add(+v.id);
      Object.values(v).forEach(walk);
    }
  };
  walk(body);
  return out;
};

describe('draft sales orders from the AVS intake — through the real app', {
  skip: ENABLED ? false : 'set DRAFTS_PG=1 to boot a throwaway Postgres',
}, () => {
  let epg, dir, db, server, base, token;
  let customerId, productId, newProductId, orderId, lineIds;

  before(async () => {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drafts-'));
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
       VALUES ('Draft checker', 'drafts@test.local', 'x', 'admin') RETURNING id, name, role`);
    token = jwt.sign({ id: u.id, name: u.name, role: u.role }, JWT_SECRET);

    const { default: app } = await import('./app.js');
    server = await new Promise(res => { const s = app.listen(0, () => res(s)); });
    base = `http://127.0.0.1:${server.address().port}/api`;

    // An existing product, and the customer it belongs to.
    const p = await db.one(`SELECT id, customer_id, board_material_id FROM products
                             WHERE board_material_id IS NOT NULL ORDER BY id LIMIT 1`);
    productId = p.id;
    customerId = p.customer_id;
    // What the intake does by SQL: a new draft master, a draft order, its lines.
    newProductId = (await db.one(
      `INSERT INTO products (customer_id, name, code, board_material_id, is_draft, draft_source, draft_note)
       VALUES ($1, 'Intake New Carton 10 mg', 'DRAFT-T-001', $2, 1, 'avs_intake', 'New item on PO 9001')
       RETURNING id`, [customerId, p.board_material_id])).id;
    orderId = (await db.one(
      `INSERT INTO orders (po_number, customer_id, po_date, delivery_date, status, draft_source, draft_note)
       VALUES ('9001', $1, '2026-10-06', '2026-10-30', 'draft', 'avs_intake', 'Keyed in from the PO mail of 6 Oct')
       RETURNING id`, [customerId])).id;
    lineIds = [];
    for (const [pid, qty] of [[productId, 1000], [newProductId, 2500]]) {
      lineIds.push((await db.one(
        `INSERT INTO order_lines (order_id, product_id, qty, rate) VALUES ($1,$2,$3,1.5) RETURNING id`,
        [orderId, pid, qty])).id);
    }
    // FG on the shelf for the existing product: a draft must never take it.
    await db.q(`INSERT INTO fg_stock (product_id, qty) VALUES ($1, 5000)
                ON CONFLICT (product_id) DO UPDATE SET qty = EXCLUDED.qty`, [productId]);
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

  test('a line inserted under a draft order is a draft line', async () => {
    const rows = await db.q('SELECT status FROM order_lines WHERE id = ANY($1::int[])', [lineIds]);
    assert.deepEqual(rows.map(r => r.status), ['draft', 'draft']);
  });

  test('the Drafts chip counts the order, its lines and the new master', async () => {
    const r = await call('GET', '/drafts/summary');
    assert.equal(r.status, 200);
    assert.equal(r.body.orders, 1);
    assert.equal(r.body.lines, 2);
    assert.equal(r.body.products, 1);
    const d = await call('GET', '/drafts');
    assert.equal(d.status, 200);
    assert.equal(d.body.orders[0].id, orderId);
    assert.equal(d.body.orders[0].new_products, 1);
    assert.equal(d.body.products[0].id, newProductId);
  });

  test('the team is told once: a bell row per active login, stamped, never repeated', async () => {
    // The summary read above ran the sweep (notifyNewDraftOrdersSoft).
    const o = await db.one('SELECT draft_notified_at FROM orders WHERE id=$1', [orderId]);
    assert.ok(o.draft_notified_at, 'stamped when announced');
    const users = await db.one(`SELECT COUNT(*)::int AS n FROM users WHERE active = 1`);
    const bells = await db.q(`SELECT user_id, title, body, link FROM notifications WHERE kind = 'new_po'`);
    assert.ok(users.n > 0);
    assert.equal(bells.length, users.n, 'every active login hears it once');
    assert.match(bells[0].title, /New PO received: PO 9001/);
    assert.match(bells[0].body, /2 items/);
    assert.equal(bells[0].link, `/orders?tab=draft&order=${orderId}`);
    // Asked again (another open app, a repeated database call): nothing new.
    const { notifyNewDraftOrders } = await import('./routes/drafts.js');
    assert.equal((await notifyNewDraftOrders()).announced, 0);
    await call('GET', '/drafts/summary');
    const again = await db.one(`SELECT COUNT(*)::int AS n FROM notifications WHERE kind = 'new_po'`);
    assert.equal(again.n, users.n);
  });

  test('several new POs at once are one alert naming them', async () => {
    const { newPoAlert } = await import('./routes/drafts.js');
    const a = newPoAlert([
      { id: 5, po_number: '02679', customer_name: 'Swiss Garnier Life Sciences', lines: 3 },
      { id: 6, po_number: '14', customer_name: 'Fluence Pharma', lines: 1 },
    ]);
    assert.equal(a.title, '2 new purchase orders received');
    assert.match(a.body, /PO 02679 \(SGLS\), PO 14/);
    assert.equal(a.link, '/orders?tab=draft');
    assert.deepEqual([a.refTable, a.refId], ['draft_pos', 6]);
  });

  test('shown on Sales Orders, Pendency and the Status Sheet; never in Planning; no FG cover', async () => {
    const orders = await call('GET', '/orders');
    assert.equal(orders.body.find(o => o.id === orderId)?.status, 'draft');
    const pend = await call('GET', '/sales/pendency');
    const mine = pend.body.lines.filter(l => l.order_id === orderId);
    assert.equal(mine.length, 2);
    assert.ok(mine.every(l => l.order_status === 'draft'));
    const existing = mine.find(l => l.product_id === productId);
    assert.equal(existing.fg_allocated_qty, 0, 'a draft takes no FG cover');
    assert.equal(existing.production_required_qty, 1000);
    const sheet = await call('GET', '/status-sheet');
    assert.equal(sheet.status, 200);
    const onSheet = JSON.stringify(sheet.body);
    assert.ok(lineIds.every(id => onSheet.includes(`"line_id":${id}`)), 'both lines on the sheet');
    const plan = await call('GET', '/planning');
    assert.equal(plan.status, 200);
    const planned = lineIdsIn(plan.body);
    assert.ok(lineIds.every(id => !planned.has(id)), 'no draft line in the Planning queue');
  });

  test('an edit that adds a line to a draft keeps it a draft', async () => {
    const detail = (await call('GET', `/orders/${orderId}`)).body;
    const lines = detail.lines.map(l => ({ id: l.id, product_id: l.product_id, qty: l.qty, rate: l.rate }));
    lines.push({ product_id: productId, qty: 300, rate: 2 });
    const r = await call('PUT', `/orders/${orderId}`, {
      po_number: detail.po_number, customer_id: detail.customer_id, po_date: '2026-10-06',
      delivery_date: '2026-10-30', notes: null, lines,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.lines.every(l => l.status === 'draft'));
    assert.equal(r.body.status, 'draft');
    lineIds = r.body.lines.map(l => l.id);
  });

  test('Confirm: the order and every line go pending, the new master is confirmed, Planning sees them', async () => {
    const r = await call('POST', `/orders/${orderId}/confirm`, { note: 'Checked against the PO' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.lines, 3);
    assert.deepEqual(r.body.products.map(p => p.id), [newProductId]);
    const o = await db.one('SELECT status, confirmed_by FROM orders WHERE id=$1', [orderId]);
    assert.equal(o.status, 'pending');
    assert.equal(o.confirmed_by, 'Draft checker');
    const ls = await db.q('SELECT status FROM order_lines WHERE order_id=$1', [orderId]);
    assert.ok(ls.every(l => l.status === 'pending'));
    const p = await db.one('SELECT is_draft, confirmed_at FROM products WHERE id=$1', [newProductId]);
    assert.equal(p.is_draft, 0);
    assert.ok(p.confirmed_at);
    const planned = lineIdsIn((await call('GET', '/planning')).body);
    assert.ok(lineIds.some(id => planned.has(id)), 'confirmed lines reach the Planning queue');
    const again = await call('POST', `/orders/${orderId}/confirm`, {});
    assert.equal(again.status, 409);
    const s = await call('GET', '/drafts/summary');
    assert.equal(s.body.orders, 0);
    assert.equal(s.body.products, 0);
  });

  test('a draft can be cancelled; its lines go with it', async () => {
    const id = (await db.one(
      `INSERT INTO orders (po_number, customer_id, po_date, status, draft_source)
       VALUES ('9002', $1, '2026-10-06', 'draft', 'avs_intake') RETURNING id`, [customerId])).id;
    await db.q('INSERT INTO order_lines (order_id, product_id, qty, rate) VALUES ($1,$2,100,1)', [id, productId]);
    const r = await call('POST', `/orders/${id}/status`, { status: 'cancelled', note: 'Duplicate mail' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ls = await db.q('SELECT status FROM order_lines WHERE order_id=$1', [id]);
    assert.deepEqual(ls.map(l => l.status), ['cancelled']);
  });

  test('a draft cannot jump straight to hold or completed', async () => {
    const id = (await db.one(
      `INSERT INTO orders (po_number, customer_id, po_date, status) VALUES ('9003', $1, '2026-10-06', 'draft') RETURNING id`,
      [customerId])).id;
    await db.q('INSERT INTO order_lines (order_id, product_id, qty, rate) VALUES ($1,$2,100,1)', [id, productId]);
    for (const to of ['hold', 'completed']) {
      const r = await call('POST', `/orders/${id}/status`, { status: to });
      assert.equal(r.status, 409, to);
    }
    // …and pending through the status route is the same confirm.
    const ok = await call('POST', `/orders/${id}/status`, { status: 'pending' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const l = await db.one('SELECT status FROM order_lines WHERE order_id=$1', [id]);
    assert.equal(l.status, 'pending');
  });
});
