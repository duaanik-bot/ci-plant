import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { computeCosting } from './costing-engine.js';

// The Costing module through the REAL app against a real Postgres: who may open it, a costing saved
// and revised (only a changed input is a new revision), a bulk batch where changing one row leaves
// every other row as it was, the Size Library growing from costings, and old cost-sheet records
// refusing to be edited.
//
// Opt-in: boots its OWN throwaway Postgres in a temp dir on a free port, PG_POOL_MAX=1 (Vercel's
// geometry — a pool call inside a transaction hangs).
//
//   COSTING_PG=1 node --test src/costing-pg.test.js

const ENABLED = process.env.COSTING_PG === '1';

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.unref();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

// Invented figures, not a customer's.
const JOB = {
  qty: 12000, sheet_l: 20, sheet_w: 30, ups: 6, gsm: 280, board_rate: 90, wastage: 200, colours: 4,
  print_rate: 450, print_min: 1600, coat_factor: 4, dp_rate: 0.25, emb_rate: 0.1, process: 1800, pf_pct: 5, margin: 0.05,
};

describe('Costing — through the real app', {
  skip: ENABLED ? false : 'set COSTING_PG=1 to boot a throwaway Postgres',
}, () => {
  let epg, dir, db, server, base;
  const tokens = {};

  before(async () => {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'costing-pg-'));
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
    const mk = async (key, role, modules) => {
      const u = await db.one(`INSERT INTO users (name, email, password_hash, role, modules) VALUES ($1, $2, 'x', $3, $4) RETURNING id, name, role`,
        [`Costing ${key}`, `costing-${key}@test.local`, role, modules && JSON.stringify(modules)]);
      tokens[key] = jwt.sign({ id: u.id, name: u.name, role: u.role }, secret);
    };
    await mk('admin', 'admin', null);
    await mk('clerk', 'planner', ['costing']);
    await mk('plain', 'planner', null);
    await mk('orders', 'planner', ['orders']);

    // One die of a size, in the Die Master (the Tooling Hub's die family).
    await db.q(`INSERT INTO tools (family, code, title, ups, carton_size, zone, condition, active)
                VALUES ('die', 'DIE-T001', 'Test die', 6, '120 x 40 x 90 mm', 'in_rack', 'Good', 1)`);

    const { default: app } = await import('./app.js');
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

  test('only admins and logins with the Costing tick open it — no ticks is not enough', async () => {
    assert.equal((await call('admin', 'GET', '/costing/bootstrap')).status, 200);
    assert.equal((await call('clerk', 'GET', '/costing/bootstrap')).status, 200);
    const plain = await call('plain', 'GET', '/costing/bootstrap');
    assert.equal(plain.status, 403);
    assert.equal(plain.body.code, 'COSTING_REFUSED');
    assert.equal((await call('orders', 'GET', '/costing/costings')).status, 403);
    assert.equal((await call('plain', 'POST', '/costing/costings', { product_name: 'x', inputs: JOB })).status, 403);
  });

  let first;
  test('a costing is worked out on the server, numbered, and its size joins the library', async () => {
    const r = await call('clerk', 'POST', '/costing/costings', {
      customer_name: 'Test Pharma', product_name: 'Test carton A', size_text: '120 X 40 X 90', style: 'lock ',
      // the browser's figures are never trusted: a cost_per_unit in the body is ignored
      inputs: { ...JOB, cost_per_unit: 0.01 },
    });
    assert.equal(r.status, 201);
    first = r.body;
    assert.match(first.costing_no, /^CI-CST-\d{4}$/);
    assert.equal(first.size_key, '120x40x90');
    assert.equal(first.style, 'LOCK');
    assert.equal(first.complete, true);
    assert.ok(Math.abs(first.cost_per_unit - computeCosting(JOB).cost_per_unit) < 1e-4);
    assert.equal(first.versions.length, 1);
    assert.ok(first.size_id, 'the size + pasting + layout is now a library entry');

    const check = await call('clerk', 'GET', '/costing/size-check?size=120x40x90');
    assert.equal(check.body.library.exact.length, 1);
    assert.equal(check.body.library.exact[0].times_costed, 1);
    assert.deepEqual(check.body.dies.exact.map(d => d.code), ['DIE-T001']);
    assert.equal(check.body.history.length, 1);
    const near = await call('clerk', 'GET', '/costing/size-check?size=121x40x89');
    assert.equal(near.body.library.near[0].size_key, '120x40x90', 'a size 1 mm off asks "did you mean"');
    assert.equal(near.body.dies.near.length, 1);
  });

  test('a revision is kept only when an input changes; the earlier figures stay on record', async () => {
    const same = await call('clerk', 'PUT', `/costing/costings/${first.id}`, {
      customer_name: 'Test Pharma Ltd', product_name: 'Test carton A', size_text: '120x40x90', style: 'LOCK', inputs: JOB,
    });
    assert.equal(same.status, 200);
    assert.equal(same.body.version, 1, 'a new customer name is not a new price');
    assert.equal(same.body.customer_name, 'Test Pharma Ltd');
    const changed = await call('clerk', 'PUT', `/costing/costings/${first.id}`, {
      customer_name: 'Test Pharma Ltd', product_name: 'Test carton A', size_text: '120x40x90', style: 'LOCK',
      inputs: { ...JOB, board_rate: 100 }, note: 'Board rate up',
    });
    assert.equal(changed.body.version, 2);
    assert.deepEqual(changed.body.versions.map(v => [v.version, v.note]), [[2, 'Board rate up'], [1, 'First costing']]);
    assert.ok(changed.body.cost_per_unit > first.cost_per_unit);
    // the list column is rounded to 4 places; the revision keeps the figures at full precision
    assert.equal(changed.body.versions[1].result.cost_per_unit, first.result.cost_per_unit);
  });

  test('a bulk batch: changing one row leaves every other row as it was', async () => {
    const rows = [1, 2, 3, 4, 5].map(i => ({ product_name: `Test carton B${i}`, size_text: `${100 + i}x40x60`, style: 'SIDE', inputs: { ...JOB, qty: 1000 * i } }));
    const made = await call('clerk', 'POST', '/costing/batches', { title: 'Test RFQ', customer_name: 'Test Pharma', common: JOB, rows });
    assert.equal(made.status, 201);
    assert.match(made.body.batch_no, /^CI-CSB-\d{4}$/);
    assert.equal(made.body.rows.length, 5);
    const before = made.body.rows;
    const edited = before.map(r => ({ id: r.id, product_name: r.product_name, size_text: r.size_text, style: r.style,
      inputs: r.product_name === 'Test carton B3' ? { ...r.inputs, gsm: 330 } : r.inputs }));
    edited.splice(4, 1);                                           // B5 taken out
    edited.push({ product_name: 'Test carton B6', size_text: '160x40x60', style: 'SIDE', inputs: { ...JOB } });
    const saved = await call('clerk', 'POST', `/costing/batches/${made.body.id}/save`, { title: 'Test RFQ', customer_name: 'Test Pharma', common: JOB, rows: edited });
    assert.equal(saved.status, 200);
    const byName = Object.fromEntries(saved.body.rows.map(r => [r.product_name, r]));
    assert.deepEqual(Object.keys(byName), ['Test carton B1', 'Test carton B2', 'Test carton B3', 'Test carton B4', 'Test carton B6']);
    for (const b of before.filter(r => !['Test carton B3', 'Test carton B5'].includes(r.product_name))) {
      assert.equal(byName[b.product_name].version, 1, `${b.product_name} untouched`);
      assert.equal(byName[b.product_name].cost_per_unit, b.cost_per_unit);
    }
    assert.equal(byName['Test carton B3'].version, 2);
    assert.notEqual(byName['Test carton B3'].cost_per_unit, before[2].cost_per_unit);
    const hidden = await call('clerk', 'GET', `/costing/costings?archived=1&batch=${made.body.id}`);
    assert.deepEqual(hidden.body.rows.map(r => r.product_name), ['Test carton B5'], 'a row taken out is kept, hidden');
  });

  test('an old cost-sheet record cannot be edited, only costed again', async () => {
    const old = await db.one(`INSERT INTO costings (costing_no, source, source_row, product_name, size_key, formula, inputs, complete)
                              VALUES ('OLD-9', 'sheet', 9, 'Old row', '120x40x90', 'CI-1', $1, true) RETURNING id`, [JOB]);
    const r = await call('clerk', 'PUT', `/costing/costings/${old.id}`, { product_name: 'x', inputs: JOB });
    assert.equal(r.status, 409);
  });

  test('a size, pasting and layout already in the library cannot be entered twice', async () => {
    const add = body => call('clerk', 'POST', '/costing/sizes', body);
    assert.equal((await add({ size_text: '90x30x60', style: 'SIDE', sheet_l: 18, sheet_w: 23, ups: 8 })).status, 201);
    assert.equal((await add({ size_text: '90 X 30 X 60', style: 'side ', sheet_l: 18, sheet_w: 23, ups: 8 })).status, 409);
    assert.equal((await add({ size_text: '90x30x60', style: 'LOCK', sheet_l: 18, sheet_w: 23, ups: 8 })).status, 201, 'another pasting is another entry');
  });

  test('only an admin changes the rates', async () => {
    const body = { defaults: { wastage: 300 }, coatings: [{ factor: 6, name: 'Test varnish' }], alert_pct: 20 };
    assert.equal((await call('clerk', 'PUT', '/costing/settings', body)).status, 403);
    assert.equal((await call('admin', 'PUT', '/costing/settings', body)).status, 200);
    const boot = await call('clerk', 'GET', '/costing/bootstrap');
    assert.equal(boot.body.settings.alert_pct, 20);
    assert.deepEqual(boot.body.settings.coatings, [{ factor: 6, name: 'Test varnish' }]);
  });
});
