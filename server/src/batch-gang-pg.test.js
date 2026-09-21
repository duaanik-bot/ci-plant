import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// A BATCH SPLIT ganged through the REAL app against a real Postgres.
//
// Swiss Garnier books one PO as several lines, one per pharma BATCH, and the
// batch number is PRINTED AT PRESS. PO 01718 arrived as twelve lines of one
// carton (SW-114 CARVEDILOL) under twelve batch numbers; the planner sized a
// 10-up die into slots of 2/2/2/1/3 so every batch finished in one press run
// of ~525 sheets — and the queue would only offer Combine, whose mergeCompat
// then refused the very ups overrides that made it a gang (2026-09-21).
//
// POST /gang-runs used to short-circuit on the PRODUCT CODE alone, so a run
// of one carton could only ever be a combined pile. It reads runKindFor now:
// two batch numbers are two cartons and mint a real CI-GANG-.
//
// Opt-in: boots its OWN throwaway Postgres in a temp dir on a free port, with
// PG_POOL_MAX=1 (the Vercel geometry — a pool call inside a transaction hangs).
//
//   BATCH_GANG_PG=1 node --test src/batch-gang-pg.test.js

const ENABLED = process.env.BATCH_GANG_PG === '1';

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.unref();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

describe('a batch split gangs — through the real app', {
  skip: ENABLED ? false : 'set BATCH_GANG_PG=1 to boot a throwaway Postgres',
}, () => {
  let epg, dir, db, server, base, token, orderId;

  // PO 01718's real shape: one carton, five batches, the planner's 2/2/2/1/3.
  const BATCHES = [
    { batch: '54TCR008', qty: 1050, ups: 2 },
    { batch: '54TCR014', qty: 1050, ups: 2 },
    { batch: '54TCR015', qty: 1050, ups: 2 },
    { batch: '54TCR016', qty: 450, ups: 1 },
    { batch: '54TCR018', qty: 1530, ups: 3 },
  ];

  before(async () => {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-gang-'));
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
    const { JWT_SECRET: secret } = await import('./auth.js');
    const u = await db.one(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ('Batch planner', 'batch-planner@test.local', 'x', 'planner') RETURNING id, name, role`);
    token = jwt.sign({ id: u.id, name: u.name, role: u.role }, secret);

    const { default: app } = await import('./app.js');
    server = await new Promise(res => { const s = app.listen(0, () => res(s)); });
    base = `http://127.0.0.1:${server.address().port}/api`;

    orderId = (await db.one(
      `INSERT INTO orders (po_number, customer_id, po_date, delivery_date, status)
       VALUES ('01718', 1, CURRENT_DATE::text, CURRENT_DATE::text, 'pending') RETURNING id`)).id;
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

  // One carton (product 1), N lines, each its own batch remark and ups.
  const mkLines = async rows => Promise.all(rows.map(async r => (await db.one(
    `INSERT INTO order_lines (order_id, product_id, qty, rate, status, line_remark, spec_override)
     VALUES ($1, 1, $2, 1, 'pending', $3, $4) RETURNING id`,
    [orderId, r.qty, r.batch == null ? null : `BATCH NO ${r.batch}`,
     r.ups == null ? null : JSON.stringify({ ups: r.ups })])).id));

  test('five batches of ONE carton mint a CI-GANG-, not a combined pile', async () => {
    // THE DISCRIMINATING CASE. No ups overrides, so mergeCompat has nothing to
    // object to — the OLD route saw one product code, found the merge verdict
    // clean and minted CI-MRG-0030 over five different batch numbers. This is
    // the path that actually bit on 2026-09-21.
    const ids = await mkLines(BATCHES.map(b => ({ ...b, ups: null })));
    const r = await call('POST', '/gang-runs', { line_ids: ids });

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.gang_number, /^CI-GANG-/,
      `five batch numbers are five cartons and must GANG — got ${r.body.gang_number}`);
    assert.equal(r.body.kind ?? 'gang', 'gang');
    assert.equal(r.body.members.length, 5);
    assert.deepEqual([...new Set(r.body.members.map(m => m.product_id))], [1],
      'all five members are the same carton');
  });

  test('a remembered die must not flatten the batch slots', async () => {
    // The die memory is keyed on the PRODUCT SET, so a template for product 1
    // matches a five-member run of product 1 and slots.find() hands EVERY
    // member that one slot's ups — wiping the 2/2/2/1/3 the planner sized
    // against the order quantities. Recognition is skipped for a repeat.
    const tpl = await db.one(
      `INSERT INTO gang_templates (name, child_l, child_w, active, created_by)
       VALUES ('SW-114 solo die', 99, 88, 1, 'test') RETURNING id`);
    await db.q(`INSERT INTO gang_template_slots (template_id, product_id, ups) VALUES ($1, 1, 7)`, [tpl.id]);

    const ids = await mkLines(BATCHES);
    const r = await call('POST', '/gang-runs', { line_ids: ids });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.gang_number, /^CI-GANG-/);

    assert.deepEqual(r.body.members.map(m => m.ups), [2, 2, 2, 1, 3],
      'every batch keeps the slot the planner sized for it');
    assert.ok(!r.body.members.some(m => +m.ups === 7),
      "the solo die's ups must not be stamped over the split");
    assert.ok(!r.body.members.some(m => +m.child_l === 99 || +m.child_w === 88),
      "the solo die's child size must not be stamped over the split");
    // 2+2+2+1+3 = the 10-up die, sliced five ways.
    assert.equal(r.body.members.reduce((s, m) => s + +m.ups, 0), 10);

    await db.q('DELETE FROM gang_template_slots WHERE template_id=$1', [tpl.id]);
    await db.q('DELETE FROM gang_templates WHERE id=$1', [tpl.id]);
  });

  test('repeat orders of ONE batch still combine into a CI-MRG-', async () => {
    const ids = await mkLines([
      { batch: '54TCR020', qty: 5000, ups: null },
      { batch: '54TCR020', qty: 3000, ups: null },
    ]);
    const r = await call('POST', '/gang-runs', { line_ids: ids });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.gang_number, /^CI-MRG-/,
      'one carton, one batch, two sales orders — still a combined run');
  });

  test('a batch split can still be combined deliberately — warn, never refuse', async () => {
    const ids = await mkLines([
      { batch: '54TCR021', qty: 4000, ups: null },
      { batch: '54TCR022', qty: 4000, ups: null },
    ]);
    const r = await call('POST', '/merge-runs', { line_ids: ids });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.gang_number, /^CI-MRG-/, 'the planner may still combine batches');
    assert.deepEqual(r.body.compat?.warnings?.find(w => w.field === 'batches')?.values,
      ['54TCR021', '54TCR022'], 'and the run says which batches it just merged');
  });
});
