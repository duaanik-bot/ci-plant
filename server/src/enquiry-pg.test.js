import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { quantityBreaks } from './costing-engine.js';

// The enquiry desk through the REAL app against a real Postgres: Claude's side through the robot routes
// with the AVS robot key (fetch, file, draft — never a send), the person's side through the desk (push to single and
// bulk costing, final prices, Management-right finalise, one quotation per customer, the trial mailbox
// replying only to itself), and nothing internal or priced leaving the Costing tick.
//
// Opt-in: boots its OWN throwaway Postgres in a temp dir on a free port, PG_POOL_MAX=1.
//
//   ENQUIRY_PG=1 node --test src/enquiry-pg.test.js

const ENABLED = process.env.ENQUIRY_PG === '1';
const ROBOT_KEY = 'test-robot-key-0000';

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.unref();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

// Invented figures, not a customer's. board_rate and process are marked so a leak is easy to see.
const JOB = {
  qty: 10000, sheet_l: 20, sheet_w: 30, ups: 6, gsm: 300, board_rate: 98.7654, wastage: 250, colours: 4,
  print_rate: 450, print_min: 1600, coat_factor: 3, dp_rate: 0.3, process: 4321.98, pf_pct: 5, margin: 0.05,
};
const MAILS = [
  {
    gmail_message_id: 'm-001', gmail_thread_id: 't-001', subject: 'Rates for two cartons', from_name: 'Ravi Kumar',
    from_email: 'Buyer@Example-Pharma.test', received_at: '2026-11-02T09:00:00Z', body_text: 'Please quote …',
    view_url: 'https://mail.google.com/mail/u/0/#all/m-001', customer_name: 'example pharma ltd', summary: 'Two cartons',
    attachments: [{ name: 'spec.pdf', mime: 'application/pdf', size: 1200 }],
    items: [
      { product_name: 'TEST TAB 10 CARTON', size_text: '120 x 40 x 90', style: 'lock', gsm: 300, colours: 4, quantities: ['10,000', '25k'] },
      { product_name: 'TEST TAB 30 CARTON', size_text: '140 x 50 x 95 mm', style: 'SIDE', quantities: [5000] },
    ],
  },
  {
    gmail_message_id: 'm-002', gmail_thread_id: 't-002', subject: 'Quote needed', from_email: 'purchase@other.test',
    received_at: '2026-11-02T11:00:00Z', customer_name: 'Other Labs', items: [{ product_name: 'OTHER SYRUP CARTON', size_text: '60x60x140', quantities: [3000] }],
  },
];

describe('Enquiry desk — through the real app', {
  skip: ENABLED ? false : 'set ENQUIRY_PG=1 to boot a throwaway Postgres',
}, () => {
  let epg, dir, db, server, base;
  const tokens = {};

  before(async () => {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enquiry-pg-'));
    const port = await freePort();
    epg = new EmbeddedPostgres({ databaseDir: dir, port, user: 'postgres', password: 'postgres', persistent: false, onLog: () => {}, onError: () => {} });
    await epg.initialise();
    await epg.start();
    process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
    process.env.PG_POOL_MAX = '1';
    db = await import('./db.js');
    await db.connect();
    await db.init();
    const { seedIfEmpty } = await import('./seed.js');
    await seedIfEmpty();
    // AVS's settings live only on production; here, just the robot key.
    await db.q(`CREATE SCHEMA IF NOT EXISTS avs`);
    await db.q(`CREATE TABLE IF NOT EXISTS avs.settings (key text PRIMARY KEY, value text, note text)`);
    await db.q(`INSERT INTO avs.settings (key, value) VALUES ('robot_key', $1)`, [ROBOT_KEY]);
    await db.q(`INSERT INTO customers (name, segment) VALUES ('Example Pharma Ltd', 'pharma')`);

    const { default: jwt } = await import('jsonwebtoken');
    const { JWT_SECRET: secret } = await import('./auth.js');
    const mk = async (key, role, modules, mgmt = 0) => {
      const u = await db.one(`INSERT INTO users (name, email, password_hash, role, modules, is_management) VALUES ($1, $2, 'x', $3, $4, $5) RETURNING id, name, role`,
        [`Desk ${key}`, `desk-${key}@test.local`, role, modules && JSON.stringify(modules), mgmt]);
      tokens[key] = jwt.sign({ id: u.id, name: u.name, role: u.role }, secret);
    };
    await mk('admin', 'admin', null);
    await mk('clerk', 'planner', ['costing']);
    await mk('plain', 'planner', null);
    await mk('md', 'planner', ['costing'], 1);

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
  const robot = async (method, url, body, key = ROBOT_KEY) => {
    const res = await fetch(base + '/avs/robot' + url, {
      method, headers: { 'content-type': 'application/json', ...(key ? { 'x-avs-robot-key': key } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const type = res.headers.get('content-type') || '';
    if (/json/.test(type)) return { status: res.status, body: await res.json(), headers: res.headers };
    return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()), headers: res.headers };
  };

  test('the desk is behind the Costing tick; the robot routes behind the robot key', async () => {
    const desk = await call('clerk', 'GET', '/costing/enquiry-desk');
    assert.equal(desk.status, 200);
    assert.equal(desk.body.in_use.key, 'trial');
    assert.equal(desk.body.in_use.send_to, 'own');
    // The standard terms name no validity period (owner, 3 Nov 2026).
    assert.doesNotMatch(desk.body.settings.terms, /valid|days/i);
    assert.equal(desk.body.can_finalise, false);
    assert.equal((await call('md', 'GET', '/costing/enquiry-desk')).body.can_finalise, true);
    assert.equal((await call('plain', 'GET', '/costing/enquiries')).status, 403);
    assert.equal((await robot('GET', '/enquiry-jobs', null, null)).status, 401);
    assert.equal((await robot('GET', '/enquiry-jobs', null, 'wrong')).status, 401);
    const proc = await robot('GET', '/enquiry-desk/procedure');
    assert.equal(proc.status, 200);
    assert.match(proc.bytes.toString(), /Rules that never change/);
    assert.match((await robot('GET', '/enquiry-desk/desk.py')).bytes.toString(), /def main/);
  });

  let fetchJob;
  test('Fetch queues one job (pressing again does not queue a second); Claude claims it once', async () => {
    const f = await call('clerk', 'POST', '/costing/enquiry-desk/fetch');
    assert.equal(f.status, 201);
    fetchJob = f.body.job;
    assert.equal(fetchJob.status, 'queued');
    // CI Plant never starts the AVS cloud routine for an enquiry job: the job waits for the desk robot.
    assert.equal(fetchJob.fire_status, 'waiting');
    const again = await call('clerk', 'POST', '/costing/enquiry-desk/fetch');
    assert.equal(again.body.already, true);
    assert.equal(again.body.job.id, fetchJob.id);
    const list = await robot('GET', '/enquiry-jobs');
    assert.deepEqual(list.body.map(j => j.id), [fetchJob.id]);
    const claim = await robot('POST', `/enquiry-jobs/${fetchJob.id}/claim`, {});
    assert.equal(claim.status, 200);
    assert.equal(claim.body.mailbox.email, 'dua.anik@gmail.com');
    assert.match(claim.body.gmail_query, /^in:inbox -from:me after:\d{4}\/\d{2}\/\d{2}/);
    assert.deepEqual(claim.body.known_message_ids, []);
    assert.ok(claim.body.customers.includes('Example Pharma Ltd'));
    assert.equal((await robot('POST', `/enquiry-jobs/${fetchJob.id}/claim`, {})).status, 409);
  });

  let rows;
  test('filing: one row per item, the customer matched by name, a mail filed twice is skipped', async () => {
    const filed = await robot('POST', `/enquiry-jobs/${fetchJob.id}/mails`, { mails: MAILS });
    assert.equal(filed.status, 200);
    assert.deepEqual(filed.body.filed.map(f => f.enquiries.length), [2, 1]);
    const again = await robot('POST', `/enquiry-jobs/${fetchJob.id}/mails`, { mails: [MAILS[0]] });
    assert.deepEqual(again.body.skipped, ['m-001']);
    assert.equal((await robot('POST', `/enquiry-jobs/${fetchJob.id}/done`, { ok: true, result: { filed: 2 } })).status, 200);
    const list = await call('clerk', 'GET', '/costing/enquiries?stage=new');
    rows = list.body.sort((a, b) => a.id - b.id);
    assert.deepEqual(rows.map(r => r.enquiry_no), ['CI-ENQ-0001', 'CI-ENQ-0002', 'CI-ENQ-0003']);
    assert.equal(rows[0].customer_name, 'Example Pharma Ltd');
    assert.ok(rows[0].customer_id > 0);
    assert.equal(rows[0].contact_email, 'buyer@example-pharma.test');
    assert.deepEqual(rows[0].quantities, [10000, 25000]);
    assert.equal(rows[0].style, 'LOCK');
    assert.equal(rows[2].customer_id, null);
    assert.equal(rows[0].mail_subject, 'Rates for two cartons');
    // A second fetch claims the first's mail ids as known.
    const f2 = await call('clerk', 'POST', '/costing/enquiry-desk/fetch');
    const c2 = await robot('POST', `/enquiry-jobs/${f2.body.job.id}/claim`, {});
    assert.deepEqual(c2.body.known_message_ids.sort(), ['m-001', 'm-002']);
    await robot('POST', `/enquiry-jobs/${f2.body.job.id}/done`, { ok: true, result: { filed: 0 } });
  });

  test('a costing saved for an enquiry links it and moves it on — no push first; the link can be undone and redone', async () => {
    const e = rows[0];
    const c = await call('clerk', 'POST', '/costing/costings', {
      enquiry_id: e.id, customer_id: e.customer_id, customer_name: e.customer_name, product_name: e.product_name,
      size_text: e.size_text, style: e.style, inputs: JOB,
    });
    assert.equal(c.status, 201);
    assert.equal(c.body.desk.enquiry_no, e.enquiry_no);
    // The costing knows the enquiry it answers.
    assert.deepEqual(c.body.enquiries.map(x => x.enquiry_no), [e.enquiry_no]);
    const back = await call('clerk', 'GET', `/costing/enquiries/${e.id}`);
    assert.equal(back.body.costing_no, c.body.costing_no);
    assert.equal(back.body.stage, 'costed');
    const breaks = quantityBreaks(JOB, [10000, 25000]);
    assert.deepEqual(back.body.prices.map(p => p.proposed), breaks.map(b => b.quote_per_unit));
    assert.equal(back.body.costing_inputs, undefined);
    // A revision of the same costing changes nothing on the enquiry, so nothing is written.
    const rev = await call('clerk', 'PUT', `/costing/costings/${c.body.id}`, { enquiry_id: e.id, product_name: e.product_name, size_text: e.size_text, style: e.style, inputs: JOB });
    assert.equal(rev.body.desk, null);
    // Undo takes the costing off the enquiry (the costing stays saved); redo puts it back.
    const undo = await call('clerk', 'POST', '/costing/enquiries/undo', { group: c.body.desk.group });
    assert.deepEqual(undo.body.moved.map(m => m.enquiry_no), [e.enquiry_no]);
    const undone = (await call('clerk', 'GET', `/costing/enquiries/${e.id}`)).body;
    assert.equal(undone.stage, 'new');
    assert.equal(undone.costing_id, null);
    assert.equal((await call('clerk', 'GET', `/costing/costings/${c.body.id}`)).status, 200);
    const redo = await call('clerk', 'POST', '/costing/enquiries/undo', { group: undo.body.undo });
    assert.equal(redo.body.moved.length, 1);
    const again = (await call('clerk', 'GET', `/costing/enquiries/${e.id}`)).body;
    assert.equal(again.stage, 'costed');
    assert.equal(again.costing_no, c.body.costing_no);
  });

  test('a bulk costing links every row to its enquiry; its rows carry the enquiry back', async () => {
    const [, a, b] = rows;
    const batch = await call('clerk', 'POST', '/costing/batches', {
      title: 'From the desk', rows: [a, b].map(x => ({ enquiry_id: x.id, product_name: x.product_name, size_text: x.size_text, inputs: { ...JOB, qty: x.quantities[0] } })),
    });
    assert.equal(batch.status, 201);
    assert.equal(batch.body.desk.moved, 2);
    assert.deepEqual(batch.body.rows.map(r => r.enquiry_no), [a.enquiry_no, b.enquiry_no]);
    for (const x of [a, b]) {
      const back = await call('clerk', 'GET', `/costing/enquiries/${x.id}`);
      assert.equal(back.body.batch_id, batch.body.id);
      assert.equal(back.body.batch_no, batch.body.batch_no);
      assert.equal(back.body.stage, 'costed');
    }
    // Saving the batch again unchanged moves nothing.
    const same = await call('clerk', 'POST', `/costing/batches/${batch.body.id}/save`, {
      title: 'From the desk', rows: batch.body.rows.map(r => ({ id: r.id, enquiry_id: r.enquiry_id, product_name: r.product_name, size_text: r.size_text, inputs: r.inputs })),
    });
    assert.equal(same.status, 200);
    assert.equal(same.body.desk, null);
  });

  const typed = async (name, extra = {}) => (await call('clerk', 'POST', '/costing/enquiries', {
    customer_name: 'Hand Typed Co', contact_email: 'hand@typed.test', product_name: name, size_text: '100x40x40', quantities: '5000', ...extra,
  })).body;
  const enquiry = async id => (await call('clerk', 'GET', `/costing/enquiries/${id}`)).body;

  test('a costing screen left without saving strands nothing: "in costing" with no costing waits in Costing', async () => {
    const x = await typed('LEFT UNSAVED CARTON');
    // The old Push marked a row "in costing" before any costing existed (the 5 Nov trial). With nothing saved,
    // it reads Ready for costing, cannot go on to Final price, and goes back to the Inbox.
    await call('clerk', 'POST', '/costing/enquiries/push', { ids: [x.id] });
    assert.equal((await enquiry(x.id)).stage, 'ready');
    const fwd = await call('clerk', 'POST', '/costing/enquiries/to-price', { ids: [x.id] });
    assert.deepEqual(fwd.body.moved, []);
    assert.match(fwd.body.skipped[0].why, /no costing yet/);
    const back = await call('clerk', 'POST', '/costing/enquiries/back', { ids: [x.id] });
    assert.deepEqual(back.body.moved.map(m => m.to), ['new']);
    assert.equal((await enquiry(x.id)).stage, 'new');
    const counts = (await call('clerk', 'GET', '/costing/enquiry-desk')).body.counts;
    assert.ok(counts.new >= 1);
  });

  test('Send back walks one tab left; every move can be undone; a later change is never overwritten', async () => {
    const x = await typed('SEND BACK CARTON', { quantities: [5000, 10000] });
    // Inbox → Costing, and undo / redo of that.
    const ready = await call('clerk', 'POST', '/costing/enquiries/ready', { ids: [x.id] });
    assert.equal((await enquiry(x.id)).stage, 'ready');
    const undo = await call('clerk', 'POST', '/costing/enquiries/undo', { group: ready.body.undo });
    assert.equal((await enquiry(x.id)).stage, 'new');
    await call('clerk', 'POST', '/costing/enquiries/undo', { group: undo.body.undo });
    assert.equal((await enquiry(x.id)).stage, 'ready');
    // Costed: Final price. Back to Costing keeps the costing; it goes forward again without a new costing.
    const c = await call('clerk', 'POST', '/costing/costings', { enquiry_id: x.id, product_name: x.product_name, size_text: x.size_text, inputs: { ...JOB, qty: 5000 } });
    assert.equal((await enquiry(x.id)).stage, 'costed');
    const b1 = await call('clerk', 'POST', '/costing/enquiries/back', { ids: [x.id] });
    assert.deepEqual(b1.body.moved.map(m => m.to), ['ready']);
    let now = await enquiry(x.id);
    assert.equal(now.stage, 'ready');
    assert.equal(now.costing_no, c.body.costing_no);
    await call('clerk', 'POST', '/costing/enquiries/to-price', { ids: [x.id] });
    assert.equal((await enquiry(x.id)).stage, 'costed');
    // Prices saved, then sent back to Costing: the prices stay with it.
    await call('clerk', 'PUT', '/costing/enquiries/prices', { items: [{ id: x.id, prices: [{ qty: 5000, final: 3.3 }, { qty: 10000, final: 3 }] }] });
    const b2 = await call('clerk', 'POST', '/costing/enquiries/back', { ids: [x.id] });
    now = await enquiry(x.id);
    assert.equal(now.stage, 'ready');
    assert.deepEqual(now.prices.map(p => p.final), [3.3, 3]);
    // A later change (the details) blocks undoing the send back; undoing the later change is fine.
    const det = await call('clerk', 'PUT', `/costing/enquiries/${x.id}`, { ...now, quantities: [5000, 10000], notes: 'checked on the phone' });
    assert.equal(det.status, 200);
    const stale = await call('clerk', 'POST', '/costing/enquiries/undo', { group: b2.body.undo });
    assert.deepEqual(stale.body.moved, []);
    assert.match(stale.body.skipped[0].why, /changed after/);
    assert.equal((await call('clerk', 'POST', '/costing/enquiries/undo', { group: det.body.undo })).body.moved.length, 1);
    assert.equal((await enquiry(x.id)).notes, null);
    // History: only the latest change can be undone from the row.
    const events = (await enquiry(x.id)).events;
    assert.equal(events[0].action, 'undo');
    assert.equal(events[0].undoable, true);
    assert.ok(events.slice(1).every(ev => !ev.undoable));
    assert.ok(events.every(ev => ev.detail?.undo === undefined));
    // Dropped from Costing, brought back to Costing (where it was), not to the Inbox.
    await call('clerk', 'POST', '/costing/enquiries/drop', { ids: [x.id], reason: 'test' });
    assert.equal((await enquiry(x.id)).stage, 'dropped');
    const brought = await call('clerk', 'POST', '/costing/enquiries/restore', { ids: [x.id] });
    assert.deepEqual(brought.body.moved.map(m => m.to), ['ready']);
    // Nothing to undo for a made-up group; a bad group is refused.
    assert.equal((await call('clerk', 'POST', '/costing/enquiries/undo', { group: '00000000-0000-4000-8000-000000000000' })).status, 404);
    assert.equal((await call('clerk', 'POST', '/costing/enquiries/undo', { group: 'drop table' })).status, 400);
  });

  test('a row taken out of a bulk costing goes back to waiting in Costing', async () => {
    const y = await typed('BATCH OUT CARTON');
    const z = await typed('BATCH STAYS CARTON');
    const made = await call('clerk', 'POST', '/costing/batches', {
      title: 'Two typed', rows: [y, z].map(x => ({ enquiry_id: x.id, product_name: x.product_name, size_text: x.size_text, inputs: { ...JOB, qty: 5000 } })),
    });
    assert.equal((await enquiry(y.id)).stage, 'costed');
    const keep = made.body.rows.find(r => r.enquiry_id === z.id);
    const saved = await call('clerk', 'POST', `/costing/batches/${made.body.id}/save`, {
      title: 'Two typed', rows: [{ id: keep.id, enquiry_id: z.id, product_name: keep.product_name, size_text: keep.size_text, inputs: keep.inputs }],
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.desk.moved, 1);
    const out = await enquiry(y.id);
    assert.equal(out.stage, 'ready');
    assert.equal(out.costing_id, null);
    assert.equal(out.events[0].action, 'unlink');
    assert.equal((await enquiry(z.id)).stage, 'costed');
    // The register shows which enquiry a costing answers.
    const reg = (await call('clerk', 'GET', `/costing/costings?search=${encodeURIComponent('BATCH STAYS')}`)).body.rows;
    assert.equal(reg[0].enquiry_no, z.enquiry_no);
  });

  test('final prices: saved by anyone with the tick, finalised only with the Management right', async () => {
    const [e1, e2, e3] = rows;
    const save = await call('clerk', 'PUT', '/costing/enquiries/prices', { items: [
      { id: e1.id, prices: [{ qty: 10000, final: 2.5 }, { qty: 25000, final: 2.2 }] },
      { id: e2.id, prices: [{ qty: 5000, final: 3.1 }] },
      { id: e3.id, prices: [{ qty: 3000, final: 4 }] },
    ] });
    assert.equal(save.status, 200, JSON.stringify(save.body));
    assert.equal((await call('clerk', 'PUT', '/costing/enquiries/prices', { items: [{ id: e1.id, prices: [{ qty: 10000, final: 0 }] }] })).status, 400);
    assert.equal((await call('clerk', 'POST', '/costing/enquiries/finalise', { ids: [e1.id] })).status, 403);
    const fin = await call('md', 'POST', '/costing/enquiries/finalise', { ids: [e1.id, e2.id, e3.id] });
    assert.deepEqual(fin.body.done.sort(), ['CI-ENQ-0001', 'CI-ENQ-0002', 'CI-ENQ-0003']);
    const back = await call('clerk', 'GET', `/costing/enquiries/${e1.id}`);
    assert.equal(back.body.status, 'quote_ready');
    assert.deepEqual(back.body.prices.map(p => p.final), [2.5, 2.2]);
    assert.ok(back.body.events.some(ev => ev.action === 'price'));
  });

  let quotes;
  test('one quotation per customer; its lines are the whitelist only', async () => {
    const made = await call('clerk', 'POST', '/costing/quotations', { ids: rows.map(r => r.id) });
    assert.equal(made.status, 201);
    quotes = made.body.quotations;
    assert.equal(quotes.length, 2);
    const qt = (await call('clerk', 'GET', `/costing/quotations/${quotes[0].id}`)).body;
    assert.equal(qt.customer_name, 'Example Pharma Ltd');
    assert.equal(qt.lines.length, 3);
    for (const l of qt.lines) assert.deepEqual(Object.keys(l).sort(), ['amount', 'enquiry_id', 'enquiry_no', 'option', 'product', 'qty', 'rate', 'size', 'specs']);
    assert.equal(qt.total, 2.5 * 10000 + 3.1 * 5000);
    assert.equal(qt.email_subject, 'Re: Rates for two cartons', 'no [TRIAL] tag — the trial is kept safe by the address alone');
    assert.deepEqual(qt.recipient, { to: 'dua.anik@gmail.com', trial: true, would_go_to: 'buyer@example-pharma.test' });
    const raw = JSON.stringify(qt);
    for (const leak of ['98.7654', '4321.98', 'board_rate', 'cost_per_unit', 'proposed']) assert.ok(!raw.includes(leak), leak);
    assert.equal((await call('clerk', 'POST', '/costing/quotations', { ids: [rows[0].id] })).status, 409);
    const pdf = await fetch(`${base}/costing/quotations/${quotes[0].id}/pdf`, { headers: { authorization: `Bearer ${tokens.clerk}` } });
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.ok((await pdf.arrayBuffer()).byteLength > 1500);
  });

  test('Send back from Quotations waits for the quotation to be cancelled', async () => {
    const r = await call('clerk', 'POST', '/costing/enquiries/back', { ids: [rows[0].id] });
    assert.deepEqual(r.body.moved, []);
    assert.match(r.body.skipped[0].why, /cancel that quotation first/);
    assert.equal(r.body.undo, null);
  });

  test('a price cannot change under a live quotation', async () => {
    const r = await call('clerk', 'PUT', '/costing/enquiries/prices', { items: [{ id: rows[0].id, prices: [{ qty: 10000, final: 2.4 }] }] });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /cancel that quotation/);
  });

  test('nothing is ever sent: the send route is gone, a send job cannot be stored, a draft is the only way out', async () => {
    const id = quotes[0].id;
    assert.equal((await call('md', 'POST', `/costing/quotations/${id}/send`, { mode: 'send' })).status, 404);
    await assert.rejects(db.q(`INSERT INTO enquiry_jobs (kind, mailbox, mailbox_email) VALUES ('send', 'trial', 'x@example.com')`), /check/i);
    const d = await call('clerk', 'POST', `/costing/quotations/${id}/draft`, {});
    assert.equal(d.status, 201);
    assert.equal(d.body.job.kind, 'draft');
    assert.equal(d.body.quotation.status, 'queued');
    const claim = await robot('POST', `/enquiry-jobs/${d.body.job.id}/claim`, {});
    assert.deepEqual(claim.body.reply.to, ['dua.anik@gmail.com']);
    assert.equal(claim.body.reply.trial, true);
    assert.equal(claim.body.reply.reply_to_message_id, 'm-001');
    assert.equal(claim.body.reply.thread_id, 't-001');
    assert.doesNotMatch(claim.body.reply.text, /TRIAL/, 'no trial words in the mail');
    assert.equal(claim.body.reply.would_go_to, 'buyer@example-pharma.test', 'the robot is still told whom it would go to');
    const pdf = await robot('GET', `/enquiry-jobs/${d.body.job.id}/attachment`);
    assert.equal(crypto.createHash('sha256').update(pdf.bytes).digest('hex'), claim.body.attachment.sha256);
    assert.equal(pdf.headers.get('x-attachment-sha256'), claim.body.attachment.sha256);
    await robot('POST', `/enquiry-jobs/${d.body.job.id}/done`, { ok: true, result: { draft_id: 'r-0', view_url: 'https://mail.google.com/mail/u/0/#drafts/r-0' } });
    const qt = (await call('clerk', 'GET', `/costing/quotations/${id}`)).body;
    assert.equal(qt.status, 'drafted');
    assert.equal(qt.sent_at, null);
    // A draft is not a send: the enquiries stay Quotation ready until the person sends it from Gmail.
    assert.equal((await call('clerk', 'GET', `/costing/enquiries/${rows[0].id}`)).body.status, 'quote_ready');
  });

  test('a failed draft puts the quotation back; drafting again makes a fresh draft', async () => {
    const id = quotes[1].id;
    const d = await call('clerk', 'POST', `/costing/quotations/${id}/draft`, {});
    assert.equal(d.status, 201);
    await robot('POST', `/enquiry-jobs/${d.body.job.id}/claim`, {});
    await robot('POST', `/enquiry-jobs/${d.body.job.id}/done`, { ok: false, error: "This Claude's Gmail is not dua.anik@gmail.com" });
    assert.equal((await call('clerk', 'GET', `/costing/quotations/${id}`)).body.status, 'ready');
    for (const draft of ['r-1', 'r-2']) {
      const again = await call('clerk', 'POST', `/costing/quotations/${id}/draft`, {});
      assert.equal(again.status, 201);
      await robot('POST', `/enquiry-jobs/${again.body.job.id}/claim`, {});
      await robot('POST', `/enquiry-jobs/${again.body.job.id}/done`, { ok: true, result: { draft_id: draft, view_url: `https://mail.google.com/mail/u/0/#drafts/${draft}` } });
    }
    const qt = (await call('clerk', 'GET', `/costing/quotations/${id}`)).body;
    assert.equal(qt.status, 'drafted');
    assert.equal(qt.gmail_draft_id, 'r-2');
    assert.ok(qt.events.some(ev => ev.action === 'draft' && ev.detail?.replaces_draft === 'r-1'));
  });

  test('a Fetch sees a draft the person sent from Gmail and marks it sent; Mark as sent needs the Management right', async () => {
    const f = await call('clerk', 'POST', '/costing/enquiry-desk/fetch');
    const claim = await robot('POST', `/enquiry-jobs/${f.body.job.id}/claim`, {});
    assert.deepEqual(claim.body.drafts_to_check.map(x => [x.quotation_id, x.draft_id, x.thread_id]).sort(),
      [[quotes[0].id, 'r-0', 't-001'], [quotes[1].id, 'r-2', 't-002']].sort());
    const seen = await robot('POST', `/enquiry-jobs/${f.body.job.id}/sent-drafts`, { sent: [{ quotation_id: quotes[0].id, gmail_message_id: 'g-1' }] });
    assert.deepEqual(seen.body.marked, [quotes[0].quotation_no]);
    await robot('POST', `/enquiry-jobs/${f.body.job.id}/done`, { ok: true, result: { sent_seen: 1 } });
    assert.equal((await robot('POST', `/enquiry-jobs/${f.body.job.id}/sent-drafts`, { sent: [] })).status, 409);
    const qt = (await call('clerk', 'GET', `/costing/quotations/${quotes[0].id}`)).body;
    assert.equal(qt.status, 'sent');
    assert.equal(qt.sent_by_name, 'Sent from Gmail');
    assert.equal(qt.gmail_message_id, 'g-1');
    assert.equal((await call('clerk', 'GET', `/costing/enquiries/${rows[0].id}`)).body.status, 'sent');
    const other = quotes[1].id;
    assert.equal((await call('clerk', 'POST', `/costing/quotations/${other}/mark-sent`)).status, 403);
    assert.equal((await call('md', 'POST', `/costing/quotations/${other}/mark-sent`)).body.status, 'sent');
  });

  test('a cancelled quotation frees its enquiries: their history says so, and Send back works again', async () => {
    const x = await typed('QUOTE THEN CANCEL CARTON');
    await call('clerk', 'POST', '/costing/costings', { enquiry_id: x.id, product_name: x.product_name, size_text: x.size_text, inputs: { ...JOB, qty: 5000 } });
    await call('clerk', 'PUT', '/costing/enquiries/prices', { items: [{ id: x.id, prices: [{ qty: 5000, final: 3.5 }] }] });
    await call('md', 'POST', '/costing/enquiries/finalise', { ids: [x.id] });
    const made = await call('clerk', 'POST', '/costing/quotations', { ids: [x.id] });
    const qid = made.body.quotations[0].id;
    assert.match((await call('clerk', 'POST', '/costing/enquiries/back', { ids: [x.id] })).body.skipped[0].why, /cancel that quotation first/);
    assert.equal((await call('clerk', 'POST', `/costing/quotations/${qid}/cancel`, {})).status, 200);
    const now = await enquiry(x.id);
    assert.equal(now.events[0].action, 'unquoted');
    assert.equal(now.events[0].detail.quotation_no, made.body.quotations[0].quotation_no);
    const back = await call('clerk', 'POST', '/costing/enquiries/back', { ids: [x.id] });
    assert.deepEqual(back.body.moved.map(m => m.to), ['price_pending']);
    assert.equal((await enquiry(x.id)).finalised_by_name, null);
  });

  test('send in one step: locked prices → finalised → quotation → reply draft queued; it names what it skipped', async () => {
    const a = await typed('SEND ONE STEP CARTON A');
    const b = await typed('SEND ONE STEP CARTON B');
    const c = await typed('SEND ONE STEP CARTON C');
    for (const x of [a, b, c]) await call('clerk', 'POST', '/costing/costings', { enquiry_id: x.id, product_name: x.product_name, size_text: x.size_text, inputs: { ...JOB, qty: 5000 } });
    await call('clerk', 'PUT', '/costing/enquiries/prices', { items: [{ id: a.id, prices: [{ qty: 5000, final: 3.5 }] }, { id: b.id, prices: [{ qty: 5000, final: 3.6 }] }] });
    // c has no locked price yet.
    assert.equal((await call('clerk', 'POST', '/costing/quotations/send', { ids: [a.id] })).status, 403, 'needs the Management right');
    const r = await call('md', 'POST', '/costing/quotations/send', { ids: [a.id, b.id, c.id] });
    assert.equal(r.status, 201);
    assert.equal(r.body.quotations.length, 1, 'one quotation for the one customer');
    assert.equal(r.body.drafted.length, 1);
    assert.deepEqual(r.body.failed, []);
    assert.deepEqual(r.body.skipped.map(s => s.enquiry_no), [c.enquiry_no]);
    assert.match(r.body.skipped[0].why, /locked final price|no complete costing|is /);
    const qid = r.body.quotations[0].id;
    const job = await db.one(`SELECT kind, status, quotation_id FROM enquiry_jobs WHERE id = $1`, [r.body.drafted[0].job]);
    assert.deepEqual([job.kind, job.status, job.quotation_id], ['draft', 'queued', qid]);
    assert.equal((await enquiry(a.id)).status, 'quote_ready');
    // Pressing again does nothing twice: both are on a queued quotation now.
    const again = await call('md', 'POST', '/costing/quotations/send', { ids: [a.id, b.id] });
    assert.equal(again.body.quotations.length, 0);
    assert.equal(again.body.drafted.length, 0);
    assert.equal(again.body.skipped.length, 2);
    assert.match(again.body.skipped[0].why, /queued/);
    await call('clerk', 'POST', `/costing/quotations/${qid}/cancel`, {});
  });

  test('Gmail connected: CI Plant saves the draft itself in the press, updates it on a second press, shows a Gmail refusal, and notices a send', async () => {
    // A fake Google on a free port: token, profile, message headers, drafts, threads.
    const http = await import('node:http');
    const G = { drafts: new Map(), threads: new Map(), n: 0, refuse: false, raws: [], calls: [] };
    const google = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
        const u = new URL(req.url, 'http://x');
        G.calls.push(`${req.method} ${u.pathname}`);
        if (u.pathname === '/token') return G.refuse ? send(400, { error: 'invalid_grant' }) : send(200, { access_token: 'at-1', expires_in: 3600 });
        if (req.headers.authorization !== 'Bearer at-1') return send(401, { error: { message: 'bad token' } });
        const p = u.pathname.replace('/gmail/v1/users/me', '');
        let m;
        if ((m = /^\/messages\/([^/]+)$/.exec(p))) return send(200, { id: m[1], threadId: 't-hand', payload: { headers: [{ name: 'Message-Id', value: `<${m[1]}@customer.test>` }] } });
        if (p === '/drafts' && req.method === 'POST') {
          const id = `d-${++G.n}`; const raw = JSON.parse(body).message.raw; G.raws.push(raw);
          G.drafts.set(id, { id, message: { id: `msg-${G.n}`, threadId: JSON.parse(body).message.threadId || `t-new-${G.n}` } });
          return send(200, G.drafts.get(id));
        }
        if ((m = /^\/drafts\/([^/]+)$/.exec(p))) {
          const d = G.drafts.get(m[1]);
          if (!d) return send(404, { error: { message: 'Requested entity was not found.' } });
          if (req.method === 'PUT') { G.raws.push(JSON.parse(body).message.raw); d.message = { ...d.message, id: `${d.message.id}-v2` }; }
          return send(200, { ...d, message: { labelIds: ['DRAFT'], ...d.message } });
        }
        if ((m = /^\/threads\/([^/]+)$/.exec(p))) return G.threads.has(m[1]) ? send(200, { id: m[1], messages: G.threads.get(m[1]) }) : send(404, { error: { message: 'not found' } });
        return send(404, { error: { message: `no fake for ${req.method} ${p}` } });
      });
    });
    await new Promise(res => google.listen(0, '127.0.0.1', res));
    const gbase = `http://127.0.0.1:${google.address().port}`;
    Object.assign(process.env, {
      GOOGLE_CLIENT_ID: 'fake-client', GOOGLE_CLIENT_SECRET: 'fake-secret', GMAIL_TOKEN_KEY: 'ef'.repeat(32),
      GMAIL_SENT_CHECK_MS: '0', GMAIL_API_BASE: `${gbase}/gmail/v1/users/me`, GOOGLE_TOKEN_URL: `${gbase}/token`, GOOGLE_REVOKE_URL: `${gbase}/revoke`,
    });
    const { sealToken } = await import('./gmail.js');
    try {
      const box = await db.one(`SELECT key, email FROM enquiry_mailboxes WHERE in_use`);
      // Not connected yet: the desk says so; only an admin may start the connect.
      let desk = await call('md', 'GET', '/costing/enquiry-desk');
      assert.equal(desk.body.gmail_ready, true);
      assert.equal(desk.body.mailboxes.find(b => b.key === box.key).gmail, null);
      assert.equal((await call('md', 'POST', `/costing/enquiry-desk/gmail/${box.key}/connect`, {})).status, 403);
      const start = await call('admin', 'POST', `/costing/enquiry-desk/gmail/${box.key}/connect`, {});
      assert.equal(new URL(start.body.url).searchParams.get('login_hint'), box.email);
      // A stale or forged state is sent back to the desk, never stored.
      const bad = await fetch(`${base}/gmail/callback?code=x&state=forged`, { redirect: 'manual' });
      assert.equal(bad.status, 303);
      assert.match(bad.headers.get('location'), /gmail=expired/);
      await db.q(`INSERT INTO gmail_links (mailbox, email, refresh_token_enc, connected_by_name) VALUES ($1, $2, $3, 'Desk admin')`,
        [box.key, box.email, sealToken('1//fake-refresh')]);
      desk = await call('md', 'GET', '/costing/enquiry-desk');
      const shown = desk.body.mailboxes.find(b => b.key === box.key).gmail;
      assert.equal(shown.email, box.email);
      assert.equal(shown.refresh_token_enc, undefined, 'the token never leaves the server');

      // 1. Send quotation → the draft is in Gmail in the same press.
      const x = await typed('GMAIL SERVER DRAFT CARTON');
      await call('clerk', 'POST', '/costing/costings', { enquiry_id: x.id, product_name: x.product_name, size_text: x.size_text, inputs: { ...JOB, qty: 5000 } });
      await call('clerk', 'PUT', '/costing/enquiries/prices', { items: [{ id: x.id, prices: [{ qty: 5000, final: 3.75 }] }] });
      const sent = await call('md', 'POST', '/costing/quotations/send', { ids: [x.id] });
      assert.equal(sent.status, 201);
      assert.equal(sent.body.drafted.length, 1);
      assert.equal(sent.body.drafted[0].now, true);
      assert.match(sent.body.drafted[0].view_url, /^https:\/\/mail\.google\.com\/mail\/\?authuser=.+#drafts\?compose=msg-1$/);
      const qid = sent.body.drafted[0].id;
      let qt = (await call('clerk', 'GET', `/costing/quotations/${qid}`)).body;
      assert.equal(qt.status, 'drafted');
      assert.equal(qt.gmail_draft_id, 'd-1');
      assert.equal(qt.mailbox, box.key);
      const job = await db.one(`SELECT status, fire_status, claimed_by, result FROM enquiry_jobs WHERE id = $1`, [sent.body.drafted[0].job]);
      assert.deepEqual([job.status, job.fire_status, job.claimed_by, job.result.by], ['done', 'server', 'CI Plant (server)', 'server']);
      assert.equal((await robot('GET', '/enquiry-jobs')).body.jobs?.some?.(j => j.id === sent.body.drafted[0].job) ?? false, false, 'the robot is not given it');
      // The e-mail itself: to the trial mailbox only, the approved words + PDF, nothing internal.
      const mime = Buffer.from(G.raws[0], 'base64url').toString('utf8');
      assert.match(mime, new RegExp(`^To: ${box.email.replace('.', '\\.')}$`, 'm'), 'the trial mailbox replies only to itself');
      assert.doesNotMatch(mime, /Content-Disposition: attachment/, 'no PDF on the draft — the rates are in the mail (11 Nov 2026)');
      const decoded = mime.split(/\r\n\r\n/).map(part => { try { return Buffer.from(part.replace(/\r\n/g, ''), 'base64').toString('utf8'); } catch { return ''; } }).join('\n');
      assert.match(decoded, /3\.75/);
      assert.doesNotMatch(decoded, /98\.7654|4321\.98|4,321/, 'no internal board rate or process cost');

      // 2. Pressed again (Save as Gmail draft): the same draft changes; no second copy.
      const again = await call('clerk', 'POST', `/costing/quotations/${qid}/draft`, {});
      assert.equal(again.status, 201);
      assert.equal(G.drafts.size, 1);
      assert.ok(G.calls.includes('PUT /gmail/v1/users/me/drafts/d-1'));
      qt = (await call('clerk', 'GET', `/costing/quotations/${qid}`)).body;
      assert.equal(qt.gmail_draft_id, 'd-1');
      assert.ok(qt.events.some(ev => ev.action === 'drafted' && ev.detail?.replaced === true));

      // 3. Google refuses (connection withdrawn): the reason is shown, the quotation stays drafted, the link says so.
      G.refuse = true;
      const { forgetToken } = await import('./gmail.js');
      forgetToken(box.key);
      const refused = await call('clerk', 'POST', `/costing/quotations/${qid}/draft`, {});
      assert.equal(refused.status, 409);
      assert.match(refused.body.error, /Connect Gmail again/);
      assert.equal((await call('clerk', 'GET', `/costing/quotations/${qid}`)).body.status, 'drafted');
      assert.match((await db.one(`SELECT last_error FROM gmail_links WHERE mailbox = $1`, [box.key])).last_error, /Connect Gmail again/);
      G.refuse = false;

      // 4. The person sends it from Gmail: the draft is gone, a SENT message is in its thread → Sent on opening the desk.
      const tid = G.drafts.get('d-1').message.threadId;
      G.drafts.delete('d-1');
      G.threads.set(tid, [{ id: 'cust-1', labelIds: ['INBOX'], internalDate: String(Date.now() - 86400000) },
        { id: 'msg-1', labelIds: ['SENT'], internalDate: String(Date.now()) }]);
      await call('md', 'GET', '/costing/enquiry-desk');
      qt = (await call('clerk', 'GET', `/costing/quotations/${qid}`)).body;
      assert.equal(qt.status, 'sent');
      assert.equal(qt.sent_by_name, 'Sent from Gmail');
      assert.equal((await enquiry(x.id)).status, 'sent');
      assert.ok(!G.calls.some(c => /\/send$/.test(c)), 'CI Plant never called send');

      // Gmail's web app may keep the draft id and point it at the SENT message (seen live 11 Nov): that is sent too.
      const y = await typed('GMAIL KEPT DRAFT ID CARTON');
      await call('clerk', 'POST', '/costing/costings', { enquiry_id: y.id, product_name: y.product_name, size_text: y.size_text, inputs: { ...JOB, qty: 5000 } });
      await call('clerk', 'PUT', '/costing/enquiries/prices', { items: [{ id: y.id, prices: [{ qty: 5000, final: 3.9 }] }] });
      const s2 = await call('md', 'POST', '/costing/quotations/send', { ids: [y.id] });
      const d2 = (await call('clerk', 'GET', `/costing/quotations/${s2.body.drafted[0].id}`)).body.gmail_draft_id;
      G.drafts.set(d2, { id: d2, message: { id: 'sent-77', threadId: 't-x', labelIds: ['SENT', 'INBOX'], internalDate: String(Date.now()) } });
      await call('md', 'GET', '/costing/enquiry-desk');
      assert.equal((await call('clerk', 'GET', `/costing/quotations/${s2.body.drafted[0].id}`)).body.status, 'sent', 'a SENT message behind the draft id = sent');

      // Disconnect: admin only; the link is gone.
      assert.equal((await call('md', 'DELETE', `/costing/enquiry-desk/gmail/${box.key}`)).status, 403);
      assert.equal((await call('admin', 'DELETE', `/costing/enquiry-desk/gmail/${box.key}`)).status, 200);
      assert.equal(await db.one(`SELECT 1 AS x FROM gmail_links`), null);
    } finally {
      await db.q('DELETE FROM gmail_links');
      for (const k of ['GMAIL_SENT_CHECK_MS', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GMAIL_TOKEN_KEY', 'GMAIL_API_BASE', 'GOOGLE_TOKEN_URL', 'GOOGLE_REVOKE_URL']) delete process.env[k];
      google.close();
    }
  });

  test('customer counter: the row goes to Counter with their price, ours and our cost; the revised quotation supersedes the first', async () => {
    const x = await typed('COUNTER OFFER CARTON');
    await call('clerk', 'POST', '/costing/costings', { enquiry_id: x.id, product_name: x.product_name, size_text: x.size_text, inputs: { ...JOB, qty: 5000 } });
    await call('clerk', 'PUT', '/costing/enquiries/prices', { items: [{ id: x.id, prices: [{ qty: 5000, final: 3.75 }] }] });
    const first = await call('md', 'POST', '/costing/quotations/send', { ids: [x.id] });
    const q1 = first.body.quotations[0];
    assert.equal(q1.revision, 0);
    // An Inbox row has nothing to counter.
    const fresh = await typed('NOT PRICED YET CARTON');
    const refused = await call('clerk', 'PUT', '/costing/enquiries/counter', { items: [{ id: fresh.id, prices: [{ qty: 5000, theirs: 1 }] }] });
    assert.deepEqual(refused.body.saved, []);
    assert.match(refused.body.skipped[0].why, /a counter answers a priced or quoted row/);
    // Their price: 3.20.
    const c = await call('clerk', 'PUT', '/costing/enquiries/counter', { items: [{ id: x.id, prices: [{ qty: 5000, theirs: 3.2 }] }] });
    assert.deepEqual(c.body.saved, [x.enquiry_no]);
    // A counter recorded by mistake is undone at once: back to Quotations, then recorded again.
    const oops = await call('clerk', 'POST', '/costing/enquiries/undo', { group: c.body.undo });
    assert.deepEqual(oops.body.moved.map(m => m.to), ['quote_ready']);
    const again = await call('clerk', 'PUT', '/costing/enquiries/counter', { items: [{ id: x.id, prices: [{ qty: 5000, theirs: 3.2 }] }] });
    c.body.undo = again.body.undo;
    let e = await enquiry(x.id);
    assert.equal(e.status, 'countered');
    assert.equal(e.stage, 'countered');
    assert.equal(e.counter_round, 1);
    assert.deepEqual([e.prices[0].theirs, e.prices[0].ours], [3.2, 3.75]);
    assert.ok(e.prices[0].cost > 0 && e.prices[0].cost < e.prices[0].proposed, 'our cost a carton, under the quote');
    assert.ok((await call('clerk', 'GET', '/costing/enquiries?stage=countered')).body.some(r => r.id === x.id), 'on the Counter tab');
    // The revised price is typed over the live quotation (only a Counter row may), then sent: a revision in its place.
    assert.equal((await call('clerk', 'PUT', '/costing/enquiries/prices', { items: [{ id: x.id, prices: [{ qty: 5000, final: 3.5 }] }] })).status, 200);
    assert.equal((await enquiry(x.id)).status, 'countered', 'still on Counter until sent');
    const rev = await call('md', 'POST', '/costing/quotations/send', { ids: [x.id] });
    assert.equal(rev.status, 201);
    assert.equal(rev.body.quotations.length, 1);
    const q2 = rev.body.quotations[0];
    assert.equal(q2.revision, 1);
    const old = (await call('clerk', 'GET', `/costing/quotations/${q1.id}`)).body;
    assert.equal(old.status, 'superseded');
    assert.equal(old.job?.status, 'cancelled', 'the first draft job, still waiting, is cancelled');
    const nq = (await call('clerk', 'GET', `/costing/quotations/${q2.id}`)).body;
    assert.equal(nq.supersedes_id, q1.id);
    assert.equal(nq.lines[0].rate, 3.5);
    assert.match(nq.reply.text, /revised rates/);
    // The history the owner wants the buyer to see on the row: our first quote, their counter, the revised rate — and
    // still nothing internal.
    assert.match(nq.reply.text, /our first quote Rs\. 3\.75 · your counter Rs\. 3\.20 · our revised rate Rs\. 3\.50/);
    assert.doesNotMatch(nq.reply.text + nq.reply.html, /cost|discount|loss|margin|TRIAL/i, 'no internal word, no trial word');
    const pdf = await fetch(`${base}/costing/quotations/${q2.id}/pdf`, { headers: { authorization: `Bearer ${tokens.clerk}` } });
    assert.equal(pdf.status, 200);
    e = await enquiry(x.id);
    assert.equal(e.status, 'quote_ready');
    assert.equal(e.quotation_id, q2.id);
    assert.ok(e.events.some(ev => ev.action === 'counter' && ev.detail?.counter?.[0]?.theirs === 3.2));
    assert.ok(rev.body.undo, 'the send answers its undo group');
    // Undo the revised quotation: it is cancelled, the first comes back, the row is on Counter again with its prices.
    assert.equal((await call('clerk', 'POST', `/costing/quotations/${q2.id}/unrevise`)).status, 403, 'needs the Management right');
    assert.equal((await call('md', 'POST', `/costing/quotations/${q1.id}/unrevise`)).status, 409, 'the first quotation is not a revision');
    const un = await call('md', 'POST', `/costing/quotations/${q2.id}/unrevise`);
    assert.equal(un.status, 200);
    assert.equal(un.body.restored, q1.quotation_no);
    assert.equal((await call('clerk', 'GET', `/costing/quotations/${q2.id}`)).body.status, 'cancelled');
    assert.equal((await call('clerk', 'GET', `/costing/quotations/${q1.id}`)).body.status, 'ready', 'back as it was (its draft job had been cancelled)');
    e = await enquiry(x.id);
    assert.deepEqual([e.status, e.quotation_id], ['countered', q1.id]);
    assert.deepEqual([e.prices[0].theirs, e.prices[0].final], [3.2, 3.5], 'their price and our revised price kept');
    // The counter itself undone (the desk's group undo): back to Quotations as before the counter.
    assert.ok(c.body.undo, 'recording a counter answers its undo group');
    const back = await call('clerk', 'POST', '/costing/enquiries/undo', { group: c.body.undo });
    assert.equal(back.status, 200);
    assert.match(back.body.skipped[0]?.why || '', /changed after/, 'a counter worked on since is not undone over that work');
    await call('clerk', 'POST', `/costing/quotations/${q1.id}/cancel`, {});
  });

  test('the robot files a counter from mail: quoted rows in its brief, the mail kept, the row on Counter', async () => {
    const target = await db.one(`SELECT id, enquiry_no, quantities::float8[] AS quantities FROM enquiries WHERE status = 'sent' AND mail_id IS NOT NULL ORDER BY id LIMIT 1`);
    assert.ok(target, 'an earlier test sent a quotation from a filed mail');
    const f = await call('clerk', 'POST', '/costing/enquiry-desk/fetch');
    const claim = await robot('POST', `/enquiry-jobs/${f.body.job.id}/claim`, {});
    assert.ok(claim.body.quoted_rows.some(r => r.enquiry_no === target.enquiry_no && r.thread_id), 'the brief names quoted rows and their thread');
    assert.match(claim.body.counters_url, /\/counters$/);
    const put = await robot('POST', `/enquiry-jobs/${f.body.job.id}/counters`, {
      mail: { gmail_message_id: 'm-counter-1', gmail_thread_id: 't-001', subject: 'Re: Rates for two cartons', from_email: 'buyer@example-pharma.test',
        received_at: '2026-11-11T11:35:00Z', body_text: 'Our rate …' },
      counters: [{ enquiry_no: target.enquiry_no, qty: target.quantities[0], theirs: 1.11 }, { enquiry_no: 'CI-ENQ-NOPE', qty: 1, theirs: 1 }],
    });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body.filed, [target.enquiry_no]);
    assert.equal(put.body.refused[0].enquiry_no, 'CI-ENQ-NOPE');
    const e = await enquiry(target.id);
    assert.equal(e.status, 'countered');
    assert.equal(e.counter_subject, 'Re: Rates for two cartons', 'the counter mail is kept — the revised quotation replies in its thread');
    assert.equal(e.prices.find(p => p.qty === target.quantities[0]).theirs, 1.11);
    await robot('POST', `/enquiry-jobs/${f.body.job.id}/done`, { ok: true, result: { counters: 1 } });
  });

  test('Claude in the cloud: Fetch starts the routine with a one-time pass for its own job; the timer starts it at 11 and 3', async () => {
    // A stand-in for claude.ai's routine API: it records each start.
    const fires = [];
    let answer = { status: 200, body: { type: 'routine_fire', claude_code_session_id: 'session_test', claude_code_session_url: 'https://claude.ai/code/session_test' } };
    const fake = http.createServer((req, res) => {
      let b = '';
      req.on('data', d => { b += d; });
      req.on('end', () => {
        fires.push({ url: req.url, headers: req.headers, body: JSON.parse(b || '{}') });
        res.writeHead(answer.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer.body));
      });
    });
    await new Promise(r => fake.listen(0, '127.0.0.1', r));
    const fireUrl = `http://127.0.0.1:${fake.address().port}/v1/claude_code/routines/trig_test01/fire`;
    const done = id => db.q(`UPDATE enquiry_jobs SET status = 'done', finished_at = now() WHERE id = $1`, [id]);
    try {
      await db.q(`UPDATE enquiry_jobs SET status = 'done', finished_at = now() WHERE status IN ('queued', 'working')`);
      // The AVS routine's link is never the desk's: with only that one saved, Fetch starts nothing (AVS mailbox rule).
      await db.q(`INSERT INTO avs.settings (key, value) VALUES ('routine_fire_url', $1), ('routine_token', 'sk-ant-oat01-avsroutine99')`,
        [fireUrl.replace('trig_test01', 'trig_avs01')]);
      // Not linked: Fetch queues for the robot on the Mac, as before.
      const plain = await call('clerk', 'POST', '/costing/enquiry-desk/fetch');
      assert.equal(plain.status, 201);
      assert.equal(plain.body.cloud.status, 'not_linked');
      assert.equal(plain.body.job.fire_status, 'waiting');
      assert.equal(fires.length, 0);
      await done(plain.body.job.id);

      // The link: an admin saves it; only claude.ai's routine API is taken; the token never comes back.
      const link = { fire_url: 'https://api.anthropic.com/v1/claude_code/routines/trig_x1y2z3/fire', token: 'sk-ant-oat01-testtoken123' };
      assert.equal((await call('clerk', 'PUT', '/costing/enquiry-desk/cloud', link)).status, 403);
      assert.equal((await call('admin', 'PUT', '/costing/enquiry-desk/cloud', { ...link, fire_url: 'https://evil.example/fire' })).status, 400);
      const saved = await call('admin', 'PUT', '/costing/enquiry-desk/cloud', link);
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.deepEqual(saved.body.cloud, { linked: true, fire_url: link.fire_url, token_hint: '…n123' });
      assert.ok(!JSON.stringify((await call('admin', 'GET', '/costing/enquiry-desk')).body).includes('testtoken'));
      assert.deepEqual((await call('clerk', 'GET', '/costing/enquiry-desk')).body.cloud, { linked: true });
      // A blank token keeps the saved one.
      assert.equal((await call('admin', 'PUT', '/costing/enquiry-desk/cloud', { ...link, token: '' })).body.cloud.token_hint, '…n123');
      // The test points the saved link at the stand-in (the route takes claude.ai's address only).
      await db.q(`UPDATE avs.settings SET value = $1 WHERE key = 'enquiry_routine_fire_url'`, [fireUrl]);

      // Fetch: queued and started at once; the start note carries the job and its pass.
      const f = await call('clerk', 'POST', '/costing/enquiry-desk/fetch');
      assert.equal(f.status, 201);
      assert.equal(f.body.cloud.ok, true);
      assert.equal(f.body.job.fire_status, 'cloud');
      assert.equal(f.body.job.session_url, 'https://claude.ai/code/session_test');
      assert.equal(fires.length, 1);
      assert.equal(fires[0].headers.authorization, 'Bearer sk-ant-oat01-testtoken123');
      assert.equal(fires[0].headers['anthropic-beta'], 'experimental-cc-routine-2026-04-01');
      const note = fires[0].body.text;
      assert.match(note, new RegExp(`^JOB=${f.body.job.id}$`, 'm'));
      const pass = note.match(/^CI_JOB_TOKEN=(\S+)$/m)[1];
      // The job keeps only the pass's hash, and the desk never shows even that.
      const kept = (await db.one(`SELECT brief FROM enquiry_jobs WHERE id = $1`, [f.body.job.id])).brief;
      assert.ok(kept.pass_sha256 && !JSON.stringify(kept).includes(pass));
      assert.ok(!JSON.stringify((await call('clerk', 'GET', '/costing/enquiry-desk')).body).includes('pass_sha256'));

      // The pass opens its own job — no robot key — and nothing else.
      const cloud = async (method, url, body, token = pass) => {
        const res = await fetch(base + '/avs/robot' + url, {
          method, headers: { 'content-type': 'application/json', 'x-enquiry-job-token': token }, body: body ? JSON.stringify(body) : undefined,
        });
        const type = res.headers.get('content-type') || '';
        return { status: res.status, body: /json/.test(type) ? await res.json() : await res.text() };
      };
      const other = await db.one(`INSERT INTO enquiry_jobs (kind, mailbox, mailbox_email, status) VALUES ('fetch', 'trial', 'other@example.test', 'queued') RETURNING id`);
      assert.deepEqual((await cloud('GET', '/enquiry-jobs')).body.map(j => j.id), [f.body.job.id]);
      assert.equal((await cloud('POST', `/enquiry-jobs/${other.id}/claim`, {})).status, 403);
      assert.match((await cloud('GET', '/enquiry-desk/procedure')).body, /Rules that never change/);
      assert.match((await cloud('GET', '/enquiry-desk/desk.py')).body, /CI_JOB_TOKEN/);
      const claim = await cloud('POST', `/enquiry-jobs/${f.body.job.id}/claim`, {});
      assert.equal(claim.status, 200);
      assert.equal(claim.body.job.kind, 'fetch');
      assert.ok(!JSON.stringify(claim.body).includes('pass_sha256'));
      const filed = await cloud('POST', `/enquiry-jobs/${f.body.job.id}/mails`, { mails: [{
        gmail_message_id: 'cloud-001', gmail_thread_id: 'tc-1', subject: 'Rate for a carton', from_email: 'buyer@cloud.test',
        received_at: '2026-11-12T05:00:00Z', items: [{ product_name: 'CLOUD TEST CARTON', size_text: '100x50x50', quantities: [5000] }],
      }] });
      assert.equal(filed.status, 200, JSON.stringify(filed.body));
      assert.equal(filed.body.filed.length, 1);
      assert.equal((await cloud('POST', `/enquiry-jobs/${f.body.job.id}/done`, { ok: true, result: { read: 1, filed: 1 } })).status, 200);
      const job = (await call('clerk', 'GET', `/costing/enquiry-jobs/${f.body.job.id}`)).body;
      assert.equal(job.status, 'done');
      assert.equal(job.claimed_by, 'Claude (cloud)');
      // A wrong pass, or one that has run out, opens nothing.
      assert.equal((await cloud('GET', '/enquiry-jobs', null, 'x'.repeat(32))).status, 401);
      await db.q(`UPDATE enquiry_jobs SET brief = brief || '{"pass_until": "2020-01-01T00:00:00Z"}'::jsonb WHERE id = $1`, [f.body.job.id]);
      assert.equal((await cloud('GET', '/enquiry-desk/procedure')).status, 401);
      await db.q(`DELETE FROM enquiry_jobs WHERE id = $1`, [other.id]);

      // A start that fails is shown, and the next press starts it again; a fresh start is not repeated.
      answer = { status: 429, body: { error: { message: 'rate limited' } } };
      const g = await call('clerk', 'POST', '/costing/enquiry-desk/fetch');
      assert.equal(g.body.cloud.ok, false);
      assert.equal(g.body.job.fire_status, 'cloud_failed');
      assert.match(g.body.job.fire_error, /rate limited/);
      answer = { status: 200, body: { type: 'routine_fire', claude_code_session_url: 'https://claude.ai/code/session_2' } };
      const again = await call('clerk', 'POST', '/costing/enquiry-desk/fetch');
      assert.equal(again.body.already, true);
      assert.equal(again.body.job.id, g.body.job.id);
      assert.equal(again.body.job.fire_status, 'cloud');
      const n = fires.length;
      await call('clerk', 'POST', '/costing/enquiry-desk/fetch');
      assert.equal(fires.length, n);
      await done(g.body.job.id);

      // The timer (Vercel Cron at 11:00 and 15:00 India): only Vercel's cron agent, and nothing within half an hour of a fetch.
      const timer = async ua => {
        const res = await fetch(base + '/cron/enquiry-fetch', { headers: ua ? { 'user-agent': ua } : {} });
        return { status: res.status, body: await res.json() };
      };
      assert.equal((await timer()).status, 401);
      assert.equal((await timer('curl/8.4')).status, 401);
      assert.match((await timer('vercel-cron/1.0')).body.skipped, /last 30 minutes/);
      await db.q(`UPDATE enquiry_jobs SET queued_at = now() - interval '2 hours' WHERE kind = 'fetch'`);
      const auto = await timer('vercel-cron/1.0');
      assert.equal(auto.status, 200, JSON.stringify(auto.body));
      assert.equal(auto.body.cloud.ok, true);
      assert.equal((await call('clerk', 'GET', `/costing/enquiry-jobs/${auto.body.job.id}`)).body.queued_by_name, 'CI Plant timer (11 am / 3 pm)');
      await done(auto.body.job.id);
      assert.ok(fires.every(x => x.url.includes('trig_test01') && x.headers.authorization === 'Bearer sk-ant-oat01-testtoken123'));
    } finally {
      fake.close();
      await db.q(`DELETE FROM avs.settings WHERE key LIKE 'enquiry_routine_%' OR key IN ('routine_fire_url', 'routine_token')`);
    }
  });

  test('order finalised: Management only; every line kept with its loss; the order sheet goes to the company mailbox alone', async () => {
    // A fake Google: token and messages/send only (a draft is never part of this). `refuse` makes Gmail say no.
    const http = await import('node:http');
    const G = { sends: [], refuse: false };
    const google = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
        const u = new URL(req.url, 'http://x');
        if (u.pathname === '/token') return G.refuse ? send(400, { error: 'invalid_grant' }) : send(200, { access_token: 'at-1', expires_in: 3600 });
        if (req.headers.authorization !== 'Bearer at-1') return send(401, { error: { message: 'bad token' } });
        const p = u.pathname.replace('/gmail/v1/users/me', '');
        if (p === '/messages/send' && req.method === 'POST') {
          if (G.refuse) return send(403, { error: { message: 'Insufficient Permission' } });
          G.sends.push(JSON.parse(body).raw);
          return send(200, { id: `sent-${G.sends.length}`, threadId: `t-sent-${G.sends.length}` });
        }
        return send(404, { error: { message: `no fake for ${req.method} ${p}` } });
      });
    });
    await new Promise(res => google.listen(0, '127.0.0.1', res));
    const gbase = `http://127.0.0.1:${google.address().port}`;
    Object.assign(process.env, {
      GOOGLE_CLIENT_ID: 'fake-client', GOOGLE_CLIENT_SECRET: 'fake-secret', GMAIL_TOKEN_KEY: 'ef'.repeat(32),
      GMAIL_API_BASE: `${gbase}/gmail/v1/users/me`, GOOGLE_TOKEN_URL: `${gbase}/token`, GOOGLE_REVOKE_URL: `${gbase}/revoke`,
    });
    const { sealToken } = await import('./gmail.js');
    const mimeText = raw => {
      const mime = Buffer.from(raw, 'base64url').toString('utf8');
      const parts = [...mime.matchAll(/Content-Type: text\/(plain|html); charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/g)]
        .map(m => Buffer.from(m[2].replace(/\r\n/g, ''), 'base64').toString('utf8'));
      return { mime, body: parts.join('\n') };
    };
    try {
      const box = await db.one(`SELECT key, email FROM enquiry_mailboxes WHERE in_use`);
      const company = (await db.one(`SELECT email FROM enquiry_mailboxes WHERE key = 'business'`)).email;
      await db.q(`INSERT INTO gmail_links (mailbox, email, refresh_token_enc, connected_by_name) VALUES ($1, $2, $3, 'Desk admin')`,
        [box.key, box.email, sealToken('1//fake-refresh')]);

      // Two items of one customer, priced, finalised and on one quotation; A costed with the new-die process charge.
      const a = await typed('ORDER NEW DIE CARTON');
      // its own size: a KLD lives on the Size Library entry (size + style + sheet + ups), so a shared layout shares it
      const b = await typed('ORDER OLD DIE CARTON', { size_text: '90x30x60' });
      const ca = await call('clerk', 'POST', '/costing/costings', { enquiry_id: a.id, product_name: a.product_name, size_text: a.size_text, inputs: { ...JOB, qty: 5000, process: 3000 } });
      await call('clerk', 'POST', '/costing/costings', { enquiry_id: b.id, product_name: b.product_name, size_text: b.size_text, inputs: { ...JOB, qty: 5000, process: 2000 } });
      await call('clerk', 'PUT', '/costing/enquiries/prices', { items: [{ id: a.id, prices: [{ qty: 5000, final: 3.75 }] }, { id: b.id, prices: [{ qty: 5000, final: 3.6 }] }] });
      assert.equal((await call('md', 'POST', '/costing/enquiries/finalise', { ids: [a.id, b.id] })).status, 200);
      const qt = await call('clerk', 'POST', '/costing/quotations', { ids: [a.id, b.id] });
      assert.equal(qt.status, 201);
      // A's KLD is drawn (on its costing's Size Library entry): the die lines go with the mail.
      const sizeId = (await db.one('SELECT size_id FROM costings WHERE id = $1', [ca.body.id ?? ca.body.costing?.id])).size_id;
      await db.q(`UPDATE costing_sizes SET kld = $2 WHERE id = $1`, [sizeId, JSON.stringify({ v: 1, rev: 1, construction: 'RTE', reading: 'side-open', tube: 100, face: 40, w: 40,
        layout: { sheet_long: 30, sheet_short: 20, ups: 6, m: 2, n: 3, across_on: 'short' }, drawn_at: '2026-11-13T05:00:00Z', drawn_by: 'Desk clerk', drive: [] })]);

      // The panel: pre-filled from the quotation; the Costing tick may look.
      const pv = await call('clerk', 'POST', '/costing/enquiries/order-preview', { ids: [a.id, b.id] });
      assert.equal(pv.status, 200, JSON.stringify(pv.body));
      const la = pv.body.lines.find(l => l.enquiry_id === a.id), lb = pv.body.lines.find(l => l.enquiry_id === b.id);
      assert.deepEqual([la.qty, la.rate, la.new_die, !!la.kld], [5000, 3.75, true, true]);
      assert.deepEqual([lb.qty, lb.rate, lb.new_die, !!lb.kld], [5000, 3.6, false, false]);
      assert.ok(lb.cost > 0);
      assert.equal(pv.body.company, company);
      assert.equal(pv.body.mail_default, true, 'a new die: the sheet goes to the team by default');
      assert.equal(pv.body.can_send, true);
      // the preview recosts an edited quantity
      const pv2 = await call('clerk', 'POST', '/costing/enquiries/order-preview', { ids: [b.id], items: [{ id: b.id, qty: 6000, rate: 3.1 }] });
      assert.equal(pv2.body.lines[0].qty, 6000);
      assert.equal(pv2.body.lines[0].rate, 3.1);

      // The Costing tick alone cannot finalise; a line without a rate is refused and nothing is written.
      assert.equal((await call('clerk', 'POST', '/costing/enquiries/order', { items: [{ id: a.id, qty: 5000, rate: 3.75 }], mail: true })).status, 403);
      const noRate = await call('md', 'POST', '/costing/enquiries/order', { items: [{ id: a.id, qty: 5000, rate: 0 }], mail: true });
      assert.equal(noRate.status, 400);
      assert.equal((await db.one('SELECT count(*)::int AS n FROM enquiry_orders')).n, 0);

      // Finalise: B at 6,000 below our cost.
      const rateA = Math.ceil((la.cost + 0.5) * 100) / 100;   // A above our cost
      const rateB = Math.floor((lb.cost - 0.2) * 100) / 100;  // B below it
      const r = await call('md', 'POST', '/costing/enquiries/order', { items: [{ id: a.id, qty: 5000, rate: rateA }, { id: b.id, qty: 6000, rate: rateB, new_die: false }], mail: true });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.match(r.body.order.order_no, /^CI-OF-\d{4}$/);
      assert.deepEqual(r.body.done.sort(), [a.enquiry_no, b.enquiry_no].sort());
      assert.equal(r.body.mail.status, 'sent');
      const o = await db.one('SELECT * FROM enquiry_orders WHERE id = $1', [r.body.order.id]);
      const ob = o.lines.find(l => l.enquiry_id === b.id);
      assert.equal(ob.qty, 6000);
      assert.equal(ob.rate, rateB);
      assert.ok(ob.margin_total < 0, 'B is booked below cost');
      assert.equal(Number(o.loss), Math.round(-ob.margin_total * 100) / 100);
      assert.deepEqual([o.items_at_loss, o.new_dies, o.mail_status, o.mail_to], [1, 1, 'sent', company]);
      assert.equal(o.quotation_id, qt.body.quotations[0].id);
      for (const x of [a, b]) {
        const e = await enquiry(x.id);
        assert.equal(e.status, 'ordered');
        assert.equal(e.order_no, o.order_no);
      }
      // exactly one mail, to the company alone, with the table and the KLD, and no cost
      assert.equal(G.sends.length, 1);
      const m1 = mimeText(G.sends[0]);
      assert.match(m1.mime, new RegExp(`^To: ${company.replace(/[.]/g, '\\.')}$`, 'm'));
      assert.doesNotMatch(m1.mime, /^(Cc|Bcc):/mi);
      assert.match(m1.mime, /filename="KLD [^"]+\.pdf"/);
      for (const s of ['ORDER NEW DIE CARTON', 'ORDER OLD DIE CARTON', '6,000', `₹${rateB.toFixed(2)}`, '20 × 30 in', 'NEW DIE', o.order_no]) assert.ok(m1.body.includes(s), `mail has ${s}`);
      assert.doesNotMatch(m1.body, /loss|margin|cost/i);
      assert.ok(!m1.body.includes(lb.cost.toFixed(2)), 'no cost figure in the mail');

      // A second press on the same rows is refused (they are on an order now).
      assert.equal((await call('md', 'POST', '/costing/enquiries/order', { items: [{ id: a.id, qty: 5000, rate: rateA }], mail: false })).status, 409);

      // Gmail saying no never undoes the order: it is kept, the mail marked failed; Send again sends it once.
      const c = await typed('ORDER MAIL FAILS CARTON');
      await call('clerk', 'POST', '/costing/costings', { enquiry_id: c.id, product_name: c.product_name, size_text: c.size_text, inputs: { ...JOB, qty: 5000 } });
      G.refuse = true;
      const f = await call('md', 'POST', '/costing/enquiries/order', { items: [{ id: c.id, qty: 5000, rate: 4.2 }], mail: true });
      assert.equal(f.status, 201, JSON.stringify(f.body));
      assert.equal(f.body.mail.status, 'failed');
      assert.ok(f.body.mail.error);
      assert.equal((await enquiry(c.id)).status, 'ordered');
      G.refuse = false;
      const again = await call('md', 'POST', `/costing/enquiry-orders/${f.body.order.id}/mail`);
      assert.equal(again.status, 200, JSON.stringify(again.body));
      assert.equal(again.body.mail_status, 'sent');
      assert.equal((await call('md', 'POST', `/costing/enquiry-orders/${f.body.order.id}/mail`)).status, 409, 'sent once, never twice');
      assert.equal((await call('clerk', 'POST', `/costing/enquiry-orders/${f.body.order.id}/mail`)).status, 403);
      assert.equal(G.sends.length, 2);

      // The Orders list, under the Costing tick.
      const list = await call('clerk', 'GET', '/costing/enquiry-orders');
      assert.equal(list.status, 200);
      assert.deepEqual(list.body.map(x => x.order_no).sort(), [o.order_no, f.body.order.order_no].sort());
      assert.equal((await call('plain', 'GET', '/costing/enquiry-orders')).status, 403);
      // The plant-wide audit log: the order number, no rate.
      const aud = await db.q(`SELECT detail FROM audit_log WHERE entity = 'enquiry_order'`);
      assert.ok(aud.length >= 2);
      for (const x of aud) assert.ok(!String(x.detail).includes(String(rateB)) && !/₹/.test(String(x.detail)), x.detail);
    } finally {
      await db.q('DELETE FROM gmail_links');
      for (const k of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GMAIL_TOKEN_KEY', 'GMAIL_API_BASE', 'GOOGLE_TOKEN_URL', 'GOOGLE_REVOKE_URL']) delete process.env[k];
      google.close();
    }
  });

  // ── The office AVS files the business mailbox (owner, 13 Nov 2026: "take the costings in its run from mppchd mail,
  // put them into the ERP system, and also give the notification" — "Both, each mail once"). The avs schema lives only
  // on production: here the table is built from its own migration, and the database's pg_net call is made by hand.
  const BIZ = 'mppchd@gmail.com';
  const intakeSql = fs.readFileSync(new URL('../../supabase/migrations/20261113180100_avs_enquiry_intake.sql', import.meta.url), 'utf8');
  const fileMails = async list => (await db.one('SELECT avs.file_enquiry_mails($1::jsonb) AS out', [JSON.stringify(list)])).out;
  const intake = id => db.one('SELECT * FROM avs.enquiry_intake WHERE gmail_message_id = $1', [id]);
  const deskRows = id => db.q(`SELECT e.id, e.enquiry_no, e.mailbox, e.source, e.created_by_name, e.contact_email, e.product_name,
                                      e.quantities::float8[] AS quantities, m.mailbox AS mail_box, m.job_id
                                 FROM enquiries e JOIN enquiry_mails m ON m.id = e.mail_id
                                WHERE m.gmail_message_id = $1 ORDER BY e.id`, [id]);
  const alertsSince = t => db.q(`SELECT n.user_id, u.name, n.title, n.body, n.link FROM notifications n JOIN users u ON u.id = n.user_id
                                  WHERE n.kind = 'new_enquiry' AND n.created_at >= $1 ORDER BY n.id`, [t]);
  const nowIs = async () => (await db.one('SELECT now() AS t')).t;

  test('AVS intake: each business mail filed once by AVS (office); a mail from the other mailbox, a stray mailbox and odd items handled', async () => {
    await db.q(intakeSql);
    await db.q(intakeSql); // a replay changes nothing
    const prior = await deskRows('m-001'); // filed from the trial mailbox by the robot, earlier in this file
    assert.ok(prior.length >= 1);
    const out = await fileMails([
      { mailbox_email: 'MPPCHD@gmail.com', gmail_message_id: 'avs-001', gmail_thread_id: 'avs-t1', subject: 'Best rate please',
        from_name: 'Asha', from_email: 'Buyer@Sample-Labs.test', received_at: '2026-11-13T05:00:00Z',
        body_text: 'Kindly share your best rate for the two cartons below.', customer_name: 'Sample Labs', summary: 'Rates for 2 cartons',
        view_url: 'https://mail.google.com/mail/u/?authuser=mppchd@gmail.com#all/avs-001',
        items: [{ product_name: 'SAMPLE TAB 10 CARTON', size_text: '100 x 30 x 80', style: 'side', quantities: [5000] },
          { product_name: 'SAMPLE TAB 20 CARTON', quantities: ['10k', 'lots'] }] },
      // The very mail the trial mailbox already put on the desk: the same sender and words, only case and spacing differ.
      { mailbox_email: BIZ, gmail_message_id: 'avs-002', subject: 'Rates for two cartons', from_email: 'buyer@example-pharma.test',
        received_at: '2026-11-02T09:01:10Z', body_text: 'Please    QUOTE …', attachments: [{ name: 'spec.pdf', mime: 'application/pdf', size: 1200 }],
        items: [{ product_name: 'TEST TAB 10 CARTON' }] },
      // The same short words to the same sender but another subject: another request, filed.
      { mailbox_email: BIZ, gmail_message_id: 'avs-002b', subject: 'Rates for a label', from_email: 'buyer@example-pharma.test',
        received_at: '2026-11-02T09:02:00Z', body_text: 'Please quote …', attachments: [{ name: 'spec.pdf' }],
        customer_name: 'Example Pharma Ltd', items: [{ product_name: 'TEST LABEL' }] },
      // Not the business mailbox: refused, never filed.
      { mailbox_email: 'dua.anik@gmail.com', gmail_message_id: 'avs-003', from_email: 'x@stray.test', body_text: 'Rate?', items: [] },
      // Two attachment-only mails from one sender are two mails, each a row for a person to read.
      { mailbox_email: BIZ, gmail_message_id: 'avs-004', subject: 'Rates', from_email: 'buyer@sample-labs.test', received_at: '2026-11-13T05:10:00Z' },
      { mailbox_email: BIZ, gmail_message_id: 'avs-005', subject: 'Rates', from_email: 'buyer@sample-labs.test', received_at: '2026-11-13T05:11:00Z' },
    ]);
    assert.deepEqual(out.map(x => x.filed), [true, true, true, true, true, true]);
    assert.deepEqual((await fileMails({ mailbox_email: BIZ, gmail_message_id: 'avs-001' })).map(x => x.filed), [false], 'filed before: left alone');

    assert.equal((await robot('POST', '/enquiries-notify', {}, null)).status, 401);
    assert.equal((await robot('POST', '/enquiries-notify', {}, 'wrong')).status, 401);
    const since = await nowIs();
    const run = await robot('POST', '/enquiries-notify', {});
    assert.equal(run.status, 200, JSON.stringify(run.body));

    const a = await intake('avs-001');
    assert.equal(a.status, 'filed');
    const rows = await deskRows('avs-001');
    assert.deepEqual(a.result.enquiries, rows.map(r => r.enquiry_no));
    assert.deepEqual(rows.map(r => [r.mailbox, r.mail_box, r.source, r.created_by_name, r.job_id]),
      [['business', 'business', 'robot', 'AVS (office)', null], ['business', 'business', 'robot', 'AVS (office)', null]]);
    assert.equal(rows[0].contact_email, 'buyer@sample-labs.test');
    assert.deepEqual(rows.map(r => r.quantities), [[5000], [10000]], '"10k" read as 10,000; "lots" is no quantity');

    const b = await intake('avs-002');
    assert.equal(b.status, 'skipped');
    assert.match(b.result.why, new RegExp(prior[0].enquiry_no), 'it names the row the trial mailbox filed');
    assert.equal((await deskRows('avs-002')).length, 0);
    assert.equal((await intake('avs-003')).status, 'refused');
    assert.match((await intake('avs-003')).result.why, /business mailbox/);
    for (const id of ['avs-004', 'avs-005']) {
      const r = await deskRows(id);
      assert.equal(r.length, 1, `${id}: one row for a person to read`);
      assert.equal(r[0].product_name, 'Rates');
    }
    // The run's own words come back to the run.
    assert.deepEqual(run.body.filed.map(f => f.gmail_message_id).sort(), ['avs-001', 'avs-002b', 'avs-004', 'avs-005']);
    assert.equal((await deskRows('avs-002b')).length, 1, 'the same short words under another subject is another request');

    // The desk is told once, in one alert for the batch, and only the logins that can open the desk hear it.
    const alerts = await alertsSince(since);
    const costing = (await db.q(`SELECT id, name, role, modules FROM users WHERE active = 1`))
      .filter(u => u.role === 'admin' || (Array.isArray(u.modules) && u.modules.includes('costing')));
    assert.deepEqual([...new Set(alerts.map(x => x.user_id))].sort(), costing.map(u => u.id).sort());
    assert.equal(alerts.length, costing.length, 'one alert each, for the whole batch');
    assert.ok(!alerts.some(x => x.name === 'Desk plain'), 'no Costing tick, no alert');
    assert.equal(alerts[0].title, '4 mails on the Enquiry desk');
    // The two attachment-only mails name no company: "a customer", never the sender's address.
    assert.match(alerts[0].body, /New: Sample Labs \(2 items\), Example Pharma Ltd \(1 item\), a customer \(1 item\), a customer \(1 item\)\./);
    for (const x of alerts) assert.doesNotMatch(`${x.title} ${x.body}`, /sample-labs\.test|Rs\.|₹|\d\.\d/);
    // A second start finds nothing: nothing filed twice, nobody told twice.
    const again = await robot('POST', '/enquiries-notify', {});
    assert.deepEqual([again.body.filed.length, again.body.skipped.length, again.body.refused.length], [0, 0, 0]);
    assert.equal((await alertsSince(since)).length, costing.length);
  });

  test('AVS intake: a burst in one statement and two starts at once — every mail filed exactly once', async () => {
    await db.q(`INSERT INTO avs.enquiry_intake (mailbox_email, gmail_message_id, from_email, body_text, received_at, customer_name, items) VALUES
      ($1, 'avs-006', 'one@bulk.test', 'first', now(), 'Bulk One', '[{"product_name":"BULK A"}]'),
      ($1, 'avs-007', 'two@bulk.test', 'second', now(), 'Bulk Two', '[{"product_name":"BULK B"}]'),
      ($1, 'avs-008', 'three@bulk.test', 'third', now(), 'Bulk Three', '[{"product_name":"BULK C"}]')`, [BIZ]);
    const both = await Promise.all([robot('POST', '/enquiries-notify', {}), robot('POST', '/enquiries-notify', {})]);
    assert.deepEqual(both.map(r => r.status), [200, 200]);
    assert.equal(both[0].body.filed.length + both[1].body.filed.length, 3);
    for (const id of ['avs-006', 'avs-007', 'avs-008']) {
      assert.equal((await deskRows(id)).length, 1, `${id} once`);
      assert.equal((await intake(id)).status, 'filed');
    }
  });

  test('AVS intake: a mail the Mac robot is filing at that very moment is not filed again (the numbering lock comes first)', async () => {
    const { default: pg } = await import('pg');
    const robotTx = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await robotTx.connect();
    try {
      const mail = { from_email: 'race@both.test', subject: 'Rate for race carton', body_text: 'Please quote the race carton.', received_at: '2026-11-13T06:00:00Z' };
      await fileMails([{ mailbox_email: BIZ, gmail_message_id: 'avs-race', ...mail, customer_name: 'Race Co', items: [{ product_name: 'RACE CARTON' }] }]);
      // The Mac robot's filing, as routes/enquiry-robot.js does it: the numbering lock, then its copy — not committed yet.
      await robotTx.query('BEGIN');
      await robotTx.query('SELECT pg_advisory_xact_lock(764002, hashtext($1))', ['CI-ENQ-']);
      await robotTx.query(`INSERT INTO enquiry_mails (mailbox, mailbox_email, gmail_message_id, subject, from_email, received_at, body_text, attachments)
                           VALUES ('trial', 'dua.anik@gmail.com', 'm-race', $1, $2, $3, $4, '[]')`, [mail.subject, mail.from_email, mail.received_at, mail.body_text]);
      const started = robot('POST', '/enquiries-notify', {});
      await new Promise(r => setTimeout(r, 700));
      await robotTx.query('COMMIT');
      assert.equal((await started).status, 200);
      const r = await intake('avs-race');
      assert.equal(r.status, 'skipped', JSON.stringify(r.result));
      assert.match(r.result.why, /already on the desk from dua\.anik@gmail\.com/);
      assert.equal((await deskRows('avs-race')).length, 0);
    } finally {
      await robotTx.query('ROLLBACK').catch(() => {});
      await robotTx.end();
    }
  });

  test('AVS intake: an open CI Plant files what the database call missed (the two-minute poll)', async () => {
    await fileMails([{ mailbox_email: BIZ, gmail_message_id: 'avs-009', from_email: 'late@poll.test', body_text: 'Rate for labels?',
      customer_name: 'Poll Co', items: [{ product_name: 'POLL LABEL' }] }]);
    assert.equal((await intake('avs-009')).status, 'new');
    assert.equal((await call('clerk', 'GET', '/drafts/summary')).status, 200);
    assert.equal((await intake('avs-009')).status, 'filed');
    assert.equal((await deskRows('avs-009')).length, 1);
  });

  test('AVS intake: a counter-offer on a business row goes to Counter; the robot never files a mail AVS already filed', async () => {
    const [x] = await deskRows('avs-001');
    await call('clerk', 'POST', '/costing/costings', { enquiry_id: x.id, product_name: x.product_name, size_text: '100 x 30 x 80', inputs: { ...JOB, qty: 5000 } });
    assert.equal((await call('clerk', 'PUT', '/costing/enquiries/prices', { items: [{ id: x.id, prices: [{ qty: 5000, final: 3.75 }] }] })).status, 200);
    const [t] = await deskRows('m-001'); // a trial-mailbox row: its number is refused in a business counter
    const since = await nowIs();
    await fileMails([{ kind: 'counter', mailbox_email: BIZ, gmail_message_id: 'avs-c1', gmail_thread_id: 'avs-t1', subject: 'Re: Best rate please',
      from_email: 'buyer@sample-labs.test', received_at: '2026-11-13T09:00:00Z', body_text: 'We can pay as below.', customer_name: 'Sample Labs',
      counters: [{ enquiry_no: x.enquiry_no, qty: 5000, theirs: 3.2 }, { enquiry_no: t.enquiry_no, qty: 10000, theirs: 1 }, { enquiry_no: 'CI-ENQ-NOPE', qty: 1, theirs: 1 }] }]);
    const run = await robot('POST', '/enquiries-notify', {});
    assert.equal(run.status, 200);
    const c = await intake('avs-c1');
    assert.equal(c.status, 'filed');
    assert.deepEqual(c.result.counters, [x.enquiry_no]);
    assert.deepEqual(c.result.refused.map(r => r.enquiry_no).sort(), ['CI-ENQ-NOPE', t.enquiry_no].sort());
    const e = await enquiry(x.id);
    assert.equal(e.status, 'countered');
    assert.equal(e.prices.find(p => p.qty === 5000).theirs, 3.2);
    const told = await alertsSince(since);
    assert.ok(told.length > 0);
    assert.equal(told[0].title, 'Counter-offer: Sample Labs — 1 item');
    assert.doesNotMatch(told[0].body, /3\.2|3\.75/, 'their figures stay on the desk');

    // The Mac robot reads the trial mailbox; a Bcc copy of a mail AVS already filed is skipped, and the answer says so.
    const f = await call('clerk', 'POST', '/costing/enquiry-desk/fetch');
    await robot('POST', `/enquiry-jobs/${f.body.job.id}/claim`, {});
    const dup = await robot('POST', `/enquiry-jobs/${f.body.job.id}/mails`, { mails: [
      { gmail_message_id: 'm-bcc-1', gmail_thread_id: 't-bcc', subject: 'Best rate please', from_email: 'buyer@sample-labs.test',
        received_at: '2026-11-13T05:00:30Z', body_text: 'Kindly share your best rate for the two   cartons below.',
        items: [{ product_name: 'SAMPLE TAB 10 CARTON' }] }] });
    assert.equal(dup.status, 200);
    assert.deepEqual(dup.body.filed, []);
    assert.deepEqual(dup.body.skipped, ['m-bcc-1']);
    assert.equal(dup.body.same_mail[0].gmail_message_id, 'm-bcc-1');
    assert.deepEqual(dup.body.same_mail[0].enquiries, (await deskRows('avs-001')).map(r => r.enquiry_no));
    assert.equal((await deskRows('m-bcc-1')).length, 0);
    await robot('POST', `/enquiry-jobs/${f.body.job.id}/done`, { ok: true, result: {} });
  });

  test('a business-mailbox reply with no Gmail link says what to do, and queues no job no robot takes', async () => {
    const [, y] = await deskRows('avs-001');
    await call('clerk', 'POST', '/costing/costings', { enquiry_id: y.id, product_name: y.product_name, size_text: '100 x 30 x 80', inputs: { ...JOB, qty: 10000 } });
    assert.equal((await call('clerk', 'PUT', '/costing/enquiries/prices', { items: [{ id: y.id, prices: [{ qty: 10000, final: 3.1 }] }] })).status, 200);
    const jobsBefore = (await db.one(`SELECT count(*)::int AS n FROM enquiry_jobs WHERE kind = 'draft' AND mailbox = 'business'`)).n;
    const sent = await call('md', 'POST', '/costing/quotations/send', { ids: [y.id] });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    assert.equal(sent.body.quotations.length, 1);
    assert.equal(sent.body.drafted.length, 0);
    assert.match(sent.body.failed[0].why, /Connect the business mailbox's Gmail in the desk Settings/);
    assert.equal((await db.one(`SELECT count(*)::int AS n FROM enquiry_jobs WHERE kind = 'draft' AND mailbox = 'business'`)).n, jobsBefore);
    assert.equal((await db.one(`SELECT status FROM quotations WHERE id = $1`, [sent.body.quotations[0].id])).status, 'ready');
  });

  // ── Fetch per mailbox, the office computer, repeats, the badge (owner, 14 Nov 2026: "keep it on MPP only … it should
  // trigger the AVS on my office PC … a small button, Fetch from dua.anik … deduplication … highlighted").
  const fetchSql = fs.readFileSync(new URL('../../supabase/migrations/20261114120100_avs_enquiry_fetch.sql', import.meta.url), 'utf8');
  const boxEmail = async key => (await db.one('SELECT email FROM enquiry_mailboxes WHERE key = $1', [key])).email;
  const waiting = async box => {
    const res = await fetch(`${base}/enquiry-desk/waiting?mailbox=${box}`);
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const closeOpenFetches = () => db.q(`UPDATE enquiry_jobs SET status = 'done', finished_at = now() WHERE kind = 'fetch' AND status IN ('queued', 'working')`);

  test('Fetch from mail waits for the office computer; Fetch from the trial mailbox for the Mac; the office takes and closes its job', async () => {
    await db.q(fetchSql);
    await db.q(fetchSql); // a replay changes nothing
    await closeOpenFetches();
    const TRIAL = await boxEmail('trial');
    assert.deepEqual((await waiting('business')).body, { waiting: false });
    assert.equal((await waiting('nonsense')).status, 400);
    assert.equal((await call('clerk', 'POST', '/costing/enquiry-desk/fetch', { mailbox: 'nonsense' })).status, 400);

    const biz = await call('clerk', 'POST', '/costing/enquiry-desk/fetch', { mailbox: 'business' });
    assert.equal(biz.status, 201, JSON.stringify(biz.body));
    assert.equal(biz.body.job.mailbox_email, BIZ);
    assert.equal(biz.body.job.fire_status, 'office', 'waiting for the office computer, never the trial mailbox\'s cloud routine');
    assert.deepEqual((await waiting('business')).body, { waiting: true }, 'the office watcher\'s question: yes, and nothing more');
    assert.equal((await call('clerk', 'POST', '/costing/enquiry-desk/fetch', { mailbox: 'business' })).body.already, true);

    const trial = await call('clerk', 'POST', '/costing/enquiry-desk/fetch', { mailbox: 'trial' });
    assert.equal(trial.status, 201);
    assert.equal(trial.body.job.mailbox_email, TRIAL);
    assert.notEqual(trial.body.job.id, biz.body.job.id, 'one open fetch per mailbox, each its own');
    assert.deepEqual((await robot('GET', '/enquiry-jobs')).body.filter(j => j.kind === 'fetch').map(j => j.mailbox_email).sort(), [TRIAL, BIZ].sort());

    // The office run: take the job, file, close it.
    const took = (await db.one('SELECT avs.take_enquiry_fetch() AS t')).t;
    assert.equal(took.job_id, biz.body.job.id);
    assert.ok(took.since);
    assert.equal((await db.one('SELECT avs.take_enquiry_fetch() AS t')).t, null, 'taken once');
    assert.deepEqual((await waiting('business')).body, { waiting: false });
    assert.equal((await db.one(`SELECT avs.finish_enquiry_fetch($1, '{"read": 9, "filed": 2}'::jsonb) AS r`, [took.job_id])).r, 'done');
    assert.equal((await db.one(`SELECT avs.finish_enquiry_fetch($1, '{}'::jsonb) AS r`, [took.job_id])).r, 'not open: nothing changed');
    const j = (await call('clerk', 'GET', `/costing/enquiry-jobs/${biz.body.job.id}`)).body;
    assert.deepEqual([j.status, j.claimed_by, j.result.filed], ['done', 'AVS (office)', 2]);
    // The office takes only business jobs: the trial job is still the Mac's.
    assert.equal((await db.one('SELECT avs.take_enquiry_fetch() AS t')).t, null);
    await closeOpenFetches();
  });

  test('with the company mailbox in use the timer fetches nothing: the office AVS keeps its own hours', async () => {
    assert.equal((await call('admin', 'PUT', '/costing/enquiry-desk/settings', { in_use: 'business' })).status, 200);
    try {
      const before = (await db.one(`SELECT count(*)::int AS n FROM enquiry_jobs`)).n;
      const res = await fetch(`${base}/cron/enquiry-fetch`, { headers: { 'user-agent': 'vercel-cron/1.0' } });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.match(body.skipped, /office AVS/);
      assert.equal((await db.one(`SELECT count(*)::int AS n FROM enquiry_jobs`)).n, before, 'no job queued');
      // The desk's own Fetch now means the company mailbox.
      const f = await call('clerk', 'POST', '/costing/enquiry-desk/fetch', {});
      assert.equal(f.body.job.mailbox_email, BIZ);
      assert.equal(f.body.job.fire_status, 'office');
    } finally {
      await closeOpenFetches();
      await call('admin', 'PUT', '/costing/enquiry-desk/settings', { in_use: 'trial' });
    }
  });

  test('a customer asking again for an open item marks that row — no new row — and the desk is told once', async () => {
    await closeOpenFetches();
    const f = await call('clerk', 'POST', '/costing/enquiry-desk/fetch', { mailbox: 'trial' });
    await robot('POST', `/enquiry-jobs/${f.body.job.id}/claim`, {});
    const file = mails => robot('POST', `/enquiry-jobs/${f.body.job.id}/mails`, { mails });
    const first = await file([{ gmail_message_id: 'm-rep-1', gmail_thread_id: 't-rep', subject: 'Rate for repeat carton', from_email: 'buyer@example-pharma.test',
      customer_name: 'Example Pharma Ltd', received_at: '2026-11-14T04:00:00Z', body_text: 'Please quote 4,000 repeat cartons.',
      items: [{ product_name: 'REPEAT CARTON', quantities: [4000] }] }]);
    const [no] = first.body.filed[0].enquiries;
    const since = await nowIs();
    const again = await file([{ gmail_message_id: 'm-rep-2', gmail_thread_id: 't-rep', subject: 'RE: Rate for repeat carton', from_email: 'buyer@example-pharma.test',
      customer_name: 'Example Pharma Ltd', received_at: '2026-11-14T06:00:00Z', body_text: 'Reminder — the rate for the repeat carton please.',
      items: [{ product_name: 'Repeat  Carton.', quantities: ['4,000'] }] }]);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual(again.body.filed[0].enquiries, [], 'no new row');
    assert.deepEqual(again.body.filed[0].asked_again, [no]);
    const row = await db.one(`SELECT asked_again_count, asked_again_at, asked_again_mail_id FROM enquiries WHERE enquiry_no = $1`, [no]);
    assert.equal(row.asked_again_count, 1);
    assert.ok(row.asked_again_at);
    assert.equal(row.asked_again_mail_id, (await db.one(`SELECT id FROM enquiry_mails WHERE gmail_message_id = 'm-rep-2'`)).id, 'the mail is kept');
    const told = await alertsSince(since);
    assert.ok(told.length > 0);
    assert.equal(told[0].title, 'Asked again: Example Pharma Ltd — 1 item');
    assert.match(told[0].body, new RegExp(no));
    // A new quantity is a new request.
    const more = await file([{ gmail_message_id: 'm-rep-3', subject: 'More', from_email: 'buyer@example-pharma.test', customer_name: 'Example Pharma Ltd',
      received_at: '2026-11-14T07:00:00Z', body_text: 'And 8,000 too.', items: [{ product_name: 'REPEAT CARTON', quantities: [4000, 8000] }] }]);
    assert.equal(more.body.filed[0].enquiries.length, 1);
    assert.deepEqual(more.body.filed[0].asked_again || [], []);
    await robot('POST', `/enquiry-jobs/${f.body.job.id}/done`, { ok: true, result: {} });

    // AVS from the company mailbox: the same rule.
    await fileMails([{ mailbox_email: BIZ, gmail_message_id: 'avs-rep-1', from_email: 'buyer@sample-labs.test', customer_name: 'Sample Labs',
      subject: 'Rates', received_at: '2026-11-14T05:00:00Z', body_text: 'Rate for omega label 2,000.', items: [{ product_name: 'OMEGA LABEL', quantities: [2000] }] }]);
    await robot('POST', '/enquiries-notify', {});
    const [omega] = (await deskRows('avs-rep-1')).map(r => r.enquiry_no);
    await fileMails([{ mailbox_email: BIZ, gmail_message_id: 'avs-rep-2', from_email: 'buyer@sample-labs.test', customer_name: 'Sample Labs',
      subject: 'Re: Rates', received_at: '2026-11-14T08:00:00Z', body_text: 'Any update on the omega label rate?', items: [{ product_name: 'Omega label' }] }]);
    await robot('POST', '/enquiries-notify', {});
    const i2 = await intake('avs-rep-2');
    assert.equal(i2.status, 'filed');
    assert.deepEqual([i2.result.enquiries, i2.result.asked_again], [[], [omega]]);
  });

  test('the badge: how many new enquiries wait, for Costing logins only', async () => {
    const s = await call('clerk', 'GET', '/costing/enquiry-desk/summary');
    assert.equal(s.status, 200);
    const n = (await db.one(`SELECT count(*)::int AS n FROM enquiries WHERE status = 'new'`)).n;
    assert.equal(s.body.new, n);
    assert.ok(n > 0);
    assert.equal((await call('plain', 'GET', '/costing/enquiry-desk/summary')).status, 403);
  });

  test('settings: an admin only; the plant-wide audit log carries no price and no address', async () => {
    assert.equal((await call('clerk', 'PUT', '/costing/enquiry-desk/settings', { in_use: 'business' })).status, 403);
    const s = await call('admin', 'PUT', '/costing/enquiry-desk/settings', { in_use: 'business' });
    assert.equal(s.status, 200);
    assert.equal(s.body.mailboxes.find(m => m.in_use).key, 'business');
    const lines = await db.q(`SELECT detail FROM audit_log WHERE entity IN ('enquiry', 'quotation', 'enquiry_job', 'enquiry_desk', 'enquiry_intake')`);
    assert.ok(lines.length >= 8);
    for (const { detail } of lines) assert.doesNotMatch(String(detail), /@|2\.5|3\.1|Rs\.|₹/);
  });
});
