import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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

  test('push to single costing: saving the costing links it, and "Costing completed" follows the costing', async () => {
    const e = rows[0];
    const push = await call('clerk', 'POST', '/costing/enquiries/push', { ids: [e.id] });
    assert.equal(push.body.rows[0].status, 'costing');
    const c = await call('clerk', 'POST', '/costing/costings', {
      enquiry_id: e.id, customer_id: e.customer_id, customer_name: e.customer_name, product_name: e.product_name,
      size_text: e.size_text, style: e.style, inputs: JOB,
    });
    assert.equal(c.status, 201);
    const back = await call('clerk', 'GET', `/costing/enquiries/${e.id}`);
    assert.equal(back.body.costing_no, c.body.costing_no);
    assert.equal(back.body.stage, 'costed');
    const breaks = quantityBreaks(JOB, [10000, 25000]);
    assert.deepEqual(back.body.prices.map(p => p.proposed), breaks.map(b => b.quote_per_unit));
    assert.equal(back.body.costing_inputs, undefined);
  });

  test('push to bulk costing: the batch links every row to its enquiry', async () => {
    const [, a, b] = rows;
    await call('clerk', 'POST', '/costing/enquiries/push', { ids: [a.id, b.id] });
    const batch = await call('clerk', 'POST', '/costing/batches', {
      title: 'From the desk', rows: [a, b].map(x => ({ enquiry_id: x.id, product_name: x.product_name, size_text: x.size_text, inputs: { ...JOB, qty: x.quantities[0] } })),
    });
    assert.equal(batch.status, 201);
    for (const x of [a, b]) {
      const back = await call('clerk', 'GET', `/costing/enquiries/${x.id}`);
      assert.equal(back.body.batch_id, batch.body.id);
      assert.equal(back.body.stage, 'costed');
    }
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
    assert.equal(qt.email_subject, '[TRIAL] Re: Rates for two cartons');
    assert.deepEqual(qt.recipient, { to: 'dua.anik@gmail.com', trial: true, would_go_to: 'buyer@example-pharma.test' });
    const raw = JSON.stringify(qt);
    for (const leak of ['98.7654', '4321.98', 'board_rate', 'cost_per_unit', 'proposed']) assert.ok(!raw.includes(leak), leak);
    assert.equal((await call('clerk', 'POST', '/costing/quotations', { ids: [rows[0].id] })).status, 409);
    const pdf = await fetch(`${base}/costing/quotations/${quotes[0].id}/pdf`, { headers: { authorization: `Bearer ${tokens.clerk}` } });
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.ok((await pdf.arrayBuffer()).byteLength > 1500);
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
    assert.match(claim.body.reply.text, /TRIAL — in business use this reply would go to buyer@example-pharma\.test/);
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

  test('settings: an admin only; the plant-wide audit log carries no price and no address', async () => {
    assert.equal((await call('clerk', 'PUT', '/costing/enquiry-desk/settings', { in_use: 'business' })).status, 403);
    const s = await call('admin', 'PUT', '/costing/enquiry-desk/settings', { in_use: 'business' });
    assert.equal(s.status, 200);
    assert.equal(s.body.mailboxes.find(m => m.in_use).key, 'business');
    const lines = await db.q(`SELECT detail FROM audit_log WHERE entity IN ('enquiry', 'quotation', 'enquiry_job', 'enquiry_desk')`);
    assert.ok(lines.length >= 8);
    for (const { detail } of lines) assert.doesNotMatch(String(detail), /@|2\.5|3\.1|Rs\.|₹/);
  });
});
