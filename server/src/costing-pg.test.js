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
    const mk = async (key, role, modules, mgmt = 0) => {
      const u = await db.one(`INSERT INTO users (name, email, password_hash, role, modules, is_management) VALUES ($1, $2, 'x', $3, $4, $5) RETURNING id, name, role`,
        [`Costing ${key}`, `costing-${key}@test.local`, role, modules && JSON.stringify(modules), mgmt]);
      tokens[key] = jwt.sign({ id: u.id, name: u.name, role: u.role }, secret);
    };
    await mk('admin', 'admin', null);
    await mk('clerk', 'planner', ['costing']);
    await mk('plain', 'planner', null);
    await mk('orders', 'planner', ['orders']);
    await mk('md', 'planner', ['costing'], 1);

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

  test('the library joins on a yes: "no" saves the costing alone, and an entry already there still links', async () => {
    const size = { size_text: '71x48x75', style: 'LOCK' };
    const no = await call('clerk', 'POST', '/costing/costings', { ...size, product_name: 'Test carton N', inputs: JOB, save_size: false });
    assert.equal(no.status, 201);
    assert.equal(no.body.complete, true);
    assert.equal(no.body.size_id, null);
    assert.equal((await call('clerk', 'GET', '/costing/size-check?size=71x48x75')).body.library.exact.length, 0);

    assert.equal((await call('clerk', 'POST', '/costing/sizes', { ...size, sheet_l: JOB.sheet_l, sheet_w: JOB.sheet_w, ups: JOB.ups })).status, 201);
    const linked = await call('clerk', 'POST', '/costing/costings', { ...size, product_name: 'Test carton L', inputs: JOB, save_size: false });
    assert.ok(linked.body.size_id, 'a "no" only stops a new entry being made');
  });

  test('a bulk costing keeps each row\'s answer: only the yes joins the library', async () => {
    const r = await call('clerk', 'POST', '/costing/batches', { title: 'Library answers', common: {}, rows: [
      { product_name: 'Test row yes', size_text: '72x49x76', style: 'LOCK', inputs: JOB, save_size: true },
      { product_name: 'Test row no', size_text: '73x50x77', style: 'LOCK', inputs: JOB, save_size: false },
    ] });
    assert.equal(r.status, 201);
    assert.equal((await call('clerk', 'GET', '/costing/size-check?size=72x49x76')).body.library.exact.length, 1);
    assert.equal((await call('clerk', 'GET', '/costing/size-check?size=73x50x77')).body.library.exact.length, 0);
    const saved = (await call('clerk', 'GET', `/costing/batches/${r.body.id}`)).body;
    const no = saved.rows.find(x => x.product_name === 'Test row no');
    assert.equal(no.complete, true);
    assert.equal(no.size_id, null, 'the row comes back marked as answered no');
  });

  test('only an admin changes the rates', async () => {
    const body = { defaults: { wastage: 300 }, coatings: [{ factor: 6, name: 'Test varnish' }], alert_pct: 20 };
    assert.equal((await call('clerk', 'PUT', '/costing/settings', body)).status, 403);
    assert.equal((await call('admin', 'PUT', '/costing/settings', body)).status, 200);
    const boot = await call('clerk', 'GET', '/costing/bootstrap');
    assert.equal(boot.body.settings.alert_pct, 20);
    assert.deepEqual(boot.body.settings.coatings, [{ factor: 6, name: 'Test varnish' }]);
  });

  test('approval: only the Management right approves; a new revision goes back to Draft, the approved one keeps its stamp', async () => {
    const made = await call('clerk', 'POST', '/costing/costings', { product_name: 'Test carton C', size_text: '110x40x80', style: 'SIDE', inputs: JOB });
    const id = made.body.id;
    assert.equal(made.body.status, 'draft');
    assert.equal((await call('clerk', 'POST', `/costing/costings/${id}/approve`, {})).status, 403);
    assert.equal((await call('admin', 'POST', `/costing/costings/${id}/approve`, {})).status, 403, 'an admin without the Management right does not approve');
    const ok = await call('md', 'POST', `/costing/costings/${id}/approve`, {});
    assert.equal(ok.status, 200);
    assert.equal(ok.body.status, 'approved');
    assert.equal(ok.body.approved_by_name, 'Costing md');
    assert.equal(ok.body.approved_version, 1);
    const boot = await call('md', 'GET', '/costing/bootstrap');
    assert.equal(boot.body.can_approve, true);
    assert.equal((await call('clerk', 'GET', '/costing/bootstrap')).body.can_approve, false);
    // a remark is not a new price: still approved
    const remark = await call('clerk', 'PUT', `/costing/costings/${id}`, { product_name: 'Test carton C', size_text: '110x40x80', style: 'SIDE', inputs: JOB, remarks: 'checked' });
    assert.equal(remark.body.status, 'approved');
    // new figures: back to Draft; revision 1 keeps who approved it
    const rev = await call('clerk', 'PUT', `/costing/costings/${id}`, { product_name: 'Test carton C', size_text: '110x40x80', style: 'SIDE', inputs: { ...JOB, gsm: 320 } });
    assert.equal(rev.body.status, 'draft');
    assert.equal(rev.body.approved_by_name, null);
    const v1 = rev.body.versions.find(v => v.version === 1);
    assert.equal(v1.approved_by_name, 'Costing md');
    assert.ok(v1.approved_at);
    assert.equal(rev.body.versions.find(v => v.version === 2).approved_by_name, null);
    const awaiting = await call('clerk', 'GET', '/costing/costings?flag=awaiting');
    assert.ok(awaiting.body.rows.some(r => r.id === id));
    // incomplete costings and old sheet records are not approved
    const half = await call('clerk', 'POST', '/costing/costings', { product_name: 'Half', inputs: { qty: 10 } });
    assert.equal((await call('md', 'POST', `/costing/costings/${half.body.id}/approve`, {})).status, 409);
  });

  test('a batch keeps its extra quantities, and approving it approves every complete row only', async () => {
    const rows = [
      { product_name: 'Test carton D1', size_text: '90x40x60', style: 'SIDE', inputs: { ...JOB } },
      { product_name: 'Test carton D2', size_text: '95x40x60', style: 'LOCK', inputs: { ...JOB, qty: 3000 } },
      { product_name: 'Test carton D3', size_text: '99x40x60', style: 'LOCK', inputs: { qty: 500 } },
    ];
    const made = await call('clerk', 'POST', '/costing/batches', { title: 'Test RFQ 2', common: { ...JOB, quantities: [20000, '5,000', 0, 'x'] }, rows });
    assert.deepEqual(made.body.common.quantities, [5000, 20000]);
    assert.equal((await call('clerk', 'POST', `/costing/batches/${made.body.id}/approve`, {})).status, 403);
    const r = await call('md', 'POST', `/costing/batches/${made.body.id}/approve`, {});
    assert.equal(r.body.approved, 2);
    assert.deepEqual(r.body.batch.rows.map(x => x.status), ['approved', 'approved', 'draft']);
  });

  test('pasted product names are matched to ONE Product Master entry by exact name or code', async () => {
    const p = await db.one(`SELECT name, code FROM products WHERE active = 1 ORDER BY id LIMIT 1`);
    const m = await call('clerk', 'POST', '/costing/products/match', { names: [`  ${p.name.toUpperCase()}  `, p.code, 'No such carton'] });
    assert.equal(m.status, 200);
    const nameKey = p.name.toLowerCase().replace(/\s+/g, ' ');
    assert.equal(m.body[nameKey]?.code, p.code);
    assert.equal(m.body[p.code.toLowerCase()]?.name, p.name);
    assert.equal(m.body['no such carton'], undefined);
  });
});
