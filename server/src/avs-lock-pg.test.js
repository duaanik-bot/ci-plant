import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// The AVS printing lock through the REAL app against a real Postgres.
//
// Planning switches AVS on for a job; the press then cannot complete PRINTING
// until QA has released every AVS report carrying the job card's number. The
// reports live in the schema `avs`, which only production has — so this test
// first proves the lock holds with no schema at all, then builds a minimal
// `avs` schema (reports, decisions, latest_reports: the columns the lock reads)
// and walks HOLD → QA release → printing completes.
//
// Opt-in: boots its OWN throwaway Postgres in a temp dir on a free port, with
// PG_POOL_MAX=1 (the Vercel geometry — a pool call inside a transaction hangs).
//
//   AVS_LOCK_PG=1 node --test src/avs-lock-pg.test.js

const ENABLED = process.env.AVS_LOCK_PG === '1';

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.unref();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

describe('the AVS printing lock — through the real app', {
  skip: ENABLED ? false : 'set AVS_LOCK_PG=1 to boot a throwaway Postgres',
}, () => {
  let epg, dir, db, server, base;
  const tokens = {};

  before(async () => {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avs-lock-'));
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
    for (const role of ['planner', 'production', 'qc', 'admin']) {
      const u = await db.one(`INSERT INTO users (name, email, password_hash, role)
        VALUES ($1, $2, 'x', $3) RETURNING id, name, role`, [`AVS ${role}`, `avs-${role}@test.local`, role]);
      tokens[role] = jwt.sign({ id: u.id, name: u.name, role: u.role }, secret);
    }
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

  const call = async (role, method, url, body) => {
    const res = await fetch(base + url, {
      method, headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[role]}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, body: json };
  };

  // The photo tables as production has them: both AVS photo migrations, minus
  // the grants to Supabase's roles, which a plain Postgres does not have.
  const applyAvsPhotoSchema = async () => {
    await db.q('CREATE SCHEMA IF NOT EXISTS avs');
    for (const f of ['20260926140100_avs_photo_sets.sql', '20260926170000_avs_photos_kept_in_ci_plant.sql']) {
      await db.q(fs.readFileSync(new URL(`../../supabase/migrations/${f}`, import.meta.url), 'utf8')
        .replace(/REVOKE ALL[^;]*;/g, ''));
    }
    await db.q('CREATE TABLE IF NOT EXISTS avs.settings (key text PRIMARY KEY, value text, note text)');
  };
  const setSettings = pairs => db.q(`INSERT INTO avs.settings (key, value)
      SELECT k, v FROM unnest($1::text[], $2::text[]) AS x(k, v)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [Object.keys(pairs), Object.values(pairs)]);

  // A job whose cutting is done and whose printing is running.
  let n = 0;
  async function printingJob() {
    n += 1;
    const orderId = (await db.one(`INSERT INTO orders (po_number, customer_id, po_date, delivery_date, status)
      VALUES ($1, 1, CURRENT_DATE::text, CURRENT_DATE::text, 'pending') RETURNING id`, [`AVS-T${n}`])).id;
    const lineId = (await db.one(`INSERT INTO order_lines (order_id, product_id, qty, rate, status)
      VALUES ($1, 1, 1000, 1, 'in_production') RETURNING id`, [orderId])).id;
    const card = await db.one(`INSERT INTO job_cards (jc_number, order_line_id, product_id, qty_planned, sheets_issued, status)
      VALUES ($1, $2, 1, 1000, 1000, 'in_progress') RETURNING id, jc_number`, [`CI-JC-9${String(n).padStart(3, '0')}`, lineId]);
    await db.q(`INSERT INTO job_stages (job_card_id, seq, stage, status, unit, qty_in, qty_out, started_at, completed_at)
      VALUES ($1, 1, 'cutting', 'completed', 'sheets', 1000, 1000, now(), now())`, [card.id]);
    const printing = await db.one(`INSERT INTO job_stages (job_card_id, seq, stage, status, unit, qty_in)
      VALUES ($1, 2, 'printing', 'pending', 'sheets', 1000) RETURNING id`, [card.id]);
    await db.q(`INSERT INTO job_stages (job_card_id, seq, stage, status, unit) VALUES ($1, 3, 'die_cutting', 'pending', 'sheets')`, [card.id]);
    return { lineId, cardId: card.id, jc: card.jc_number, printingId: printing.id };
  }
  // The press starts printing (what POST /start leaves behind).
  const startPrinting = job => db.q(`UPDATE job_stages SET status='in_progress', started_at=now() WHERE id=$1`, [job.printingId]);
  const completePrinting = job => call('production', 'POST', `/job-stages/${job.printingId}/complete`, { qty_out: 950, qty_scrap: 50 });

  test('AVS off (the default): printing completes as it always did', async () => {
    const job = await printingJob();
    await startPrinting(job);
    const gate = await call('production', 'GET', `/avs/gate/${job.cardId}`);
    assert.equal(gate.status, 200);
    assert.equal(gate.body.mandatory, false);
    const out = await completePrinting(job);
    assert.equal(out.status, 200, JSON.stringify(out.body));
  });

  test('only Planning switches it; the press cannot', async () => {
    const job = await printingJob();
    const press = await call('production', 'POST', '/avs/switch', { line_id: job.lineId, on: false, reason: 'let me finish' });
    assert.equal(press.status, 403);
    const qc = await call('qc', 'POST', '/avs/switch', { line_id: job.lineId, on: true });
    assert.equal(qc.status, 403);
    const on = await call('planner', 'POST', '/avs/switch', { line_id: job.lineId, on: true });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal((await db.one('SELECT avs_mandatory FROM order_lines WHERE id=$1', [job.lineId])).avs_mandatory, 1);
    const audit = await db.one(`SELECT detail, user_name FROM audit_log WHERE entity='order_line' AND entity_id=$1 AND action='avs_mandatory'`, [job.lineId]);
    assert.match(audit.detail, /AVS mandatory ON \(CI-JC-9\d{3}, printing pending\)/);
    assert.equal(audit.user_name, 'AVS planner');
  });

  test('a job already on the press is not disturbed: AVS cannot be switched on for it', async () => {
    const job = await printingJob();
    await startPrinting(job);
    const on = await call('planner', 'POST', '/avs/switch', { line_id: job.lineId, on: true });
    assert.equal(on.status, 409);
    assert.match(on.body.error, /already started/);
    assert.equal((await db.one('SELECT avs_mandatory FROM order_lines WHERE id=$1', [job.lineId])).avs_mandatory, 0);
    assert.equal((await completePrinting(job)).status, 200);
  });

  test('switched on, with no AVS schema at all: the lock holds and says why', async () => {
    const job = await printingJob();
    await call('planner', 'POST', '/avs/switch', { line_id: job.lineId, on: true });
    await startPrinting(job);
    const floor = await call('production', 'GET', '/floor/printing');
    assert.equal(floor.status, 200);
    const find = x => (Array.isArray(x) ? x.map(find).find(Boolean)
      : x && typeof x === 'object' ? (x.jc_number === job.jc && 'avs_mandatory' in x ? x : Object.values(x).map(find).find(Boolean)) : null);
    const row = find(floor.body);
    assert.ok(row, 'the job is on the printing queue');
    assert.equal(row.avs_mandatory, true, 'the queue row carries the AVS flag for the pop-ups');
    const out = await completePrinting(job);
    assert.equal(out.status, 409);
    assert.equal(out.body.code, 'AVS_NOT_RELEASED');
    assert.match(out.body.avs.reason, /not set up on this database/);
    assert.equal((await db.one('SELECT status FROM job_stages WHERE id=$1', [job.printingId])).status, 'in_progress',
      'nothing was recorded');
  });

  test('HOLD report → locked; a release on an older issue → still locked; QA releases → printing completes', async () => {
    // The columns the lock reads, as production has them.
    await db.q(`CREATE SCHEMA IF NOT EXISTS avs;
      CREATE TABLE IF NOT EXISTS avs.reports (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, report_no text NOT NULL,
        report_rev integer NOT NULL DEFAULT 0, check_no integer NOT NULL DEFAULT 1, row_type text NOT NULL DEFAULT 'REPORT',
        status text, product_name text, job_card text, issued_at timestamptz DEFAULT now());
      CREATE TABLE IF NOT EXISTS avs.decisions (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, report_no text NOT NULL,
        report_rev integer, check_no integer, decision text NOT NULL, decided_by text, remark text,
        decided_at timestamptz NOT NULL DEFAULT now());
      CREATE OR REPLACE VIEW avs.latest_reports AS SELECT DISTINCT ON (report_no) * FROM avs.reports
        WHERE row_type = 'REPORT' ORDER BY report_no, check_no DESC, report_rev DESC;`);
    const job = await printingJob();
    await call('planner', 'POST', '/avs/switch', { line_id: job.lineId, on: true });
    await startPrinting(job);

    let out = await completePrinting(job);
    assert.equal(out.status, 409);
    assert.match(out.body.avs.reason, /No AVS report yet/);

    await db.q(`INSERT INTO avs.reports (report_no, report_rev, status, product_name, job_card) VALUES
      ('AVS-2026-0901', 0, 'HOLD', 'Test carton', $1), ('AVS-2026-0901', 1, 'HOLD', 'Test carton', lower($1))`, [job.jc]);
    out = await completePrinting(job);
    assert.equal(out.status, 409);
    assert.match(out.body.avs.reason, /AVS-2026-0901 Rev 1 is HOLD/);

    // Released on Rev 0 — but Rev 1 is the issue that counts.
    await db.q(`INSERT INTO avs.decisions (report_no, report_rev, check_no, decision, decided_by, remark)
      VALUES ('AVS-2026-0901', 0, 1, 'RELEASE', 'QA', 'old issue')`);
    out = await completePrinting(job);
    assert.equal(out.status, 409);

    // Released on Rev 1, then an artwork-alert sign-off after it: still released.
    await db.q(`INSERT INTO avs.decisions (report_no, report_rev, check_no, decision, decided_by, remark, decided_at)
      VALUES ('AVS-2026-0901', 1, 1, 'RELEASE', 'QA', 'points cleared', now() + interval '1 second'),
             ('AVS-2026-0901', 1, 1, 'ARTWORK ALERT OK', 'Prepress', 'flap ok', now() + interval '2 seconds')`);
    const gate = await call('production', 'GET', `/avs/gate/${job.cardId}`);
    assert.equal(gate.body.released, true, JSON.stringify(gate.body));
    out = await completePrinting(job);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal((await db.one('SELECT status FROM job_stages WHERE id=$1', [job.printingId])).status, 'completed');
  });

  test('Planning switches it off mid-printing only with a reason, saved with the name', async () => {
    const job = await printingJob();
    await call('planner', 'POST', '/avs/switch', { line_id: job.lineId, on: true });
    await startPrinting(job);
    const bare = await call('planner', 'POST', '/avs/switch', { line_id: job.lineId, on: false });
    assert.equal(bare.status, 409);
    assert.equal(bare.body.code, 'AVS_REASON_REQUIRED');
    const ok = await call('planner', 'POST', '/avs/switch', { job_card_id: job.cardId, on: false, reason: 'customer approved the proof by e-mail' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const audit = await db.one(`SELECT detail FROM audit_log WHERE entity='order_line' AND entity_id=$1 AND action='avs_mandatory'
      ORDER BY id DESC LIMIT 1`, [job.lineId]);
    assert.match(audit.detail, /OFF .* reason: customer approved the proof by e-mail/);
    assert.equal((await completePrinting(job)).status, 200);
    // Once printing is done the switch no longer applies.
    const late = await call('planner', 'POST', '/avs/switch', { line_id: job.lineId, on: true });
    assert.equal(late.status, 409);
  });

  // ── Photo sets: CI Plant → the Drive link → Verify → the Claude routine ────
  // Both far ends are stood in for by local servers that answer the way the
  // real ones do: the Drive link through a redirect (Apps Script's way), the
  // routine with its session URL. What is checked is the contract CI Plant
  // keeps with each: what it sends, what it stores, what it shows.
  test('a photo goes to the Drive link intact, and Verify fires Claude once per run', async () => {
    const http = await import('node:http');
    const got = { drive: [], fires: [] };
    const results = new Map();
    const drive = http.createServer((req, res) => {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
          const j = JSON.parse(body);
          got.drive.push(j);
          const key = String(results.size + 1);
          results.set(key, j.secret !== 'test-secret' ? { ok: false, error: 'Wrong secret' }
            : { ok: true, created: true, id: `f${key}`, name: j.name, size: Buffer.from(j.base64 || '', 'base64').length,
                url: `https://drive.test/f${key}`, parent: { id: 'folder1', name: j.path.split('/').pop(), url: 'https://drive.test/folder1' } });
          res.writeHead(302, { Location: `http://127.0.0.1:${drive.address().port}/echo?k=${key}` });
          res.end();
        });
      } else {
        const key = new URL(req.url, 'http://x').searchParams.get('k');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(results.get(key)));
      }
    });
    const routine = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        got.fires.push({ auth: req.headers.authorization, beta: req.headers['anthropic-beta'], version: req.headers['anthropic-version'], body: JSON.parse(body) });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'routine_fire', claude_code_session_id: 'session_test', claude_code_session_url: 'https://claude.ai/code/session_test' }));
      });
    });
    await new Promise(r => drive.listen(0, '127.0.0.1', r));
    await new Promise(r => routine.listen(0, '127.0.0.1', r));
    try {
      await applyAvsPhotoSchema();
      await setSettings({
        drive_bridge_url: `http://127.0.0.1:${drive.address().port}/exec`, drive_bridge_secret: 'test-secret',
        routine_fire_url: `http://127.0.0.1:${routine.address().port}/fire`, routine_token: 'sk-ant-test-token',
      });

      const job = await printingJob();
      const made = await call('production', 'POST', '/avs/uploads', { job_card_id: job.cardId, note: 'first sheets' });
      assert.equal(made.status, 201, JSON.stringify(made.body));
      assert.equal(made.body.status, 'uploading');
      assert.equal(made.body.jc_number, job.jc);

      const photo = Buffer.from([0xff, 0xd8, 0xff, 0xe1, ...Array.from({ length: 5000 }, (_, i) => i % 251)]);
      const fd = new FormData();
      fd.append('file', new Blob([photo], { type: 'image/jpeg' }), 'IMG_0001.JPG');
      fd.append('captured_at', '2026-09-26T05:10:00.000Z');
      const up = await fetch(`${base}/avs/uploads/${made.body.id}/photos`, {
        method: 'POST', headers: { authorization: `Bearer ${tokens.production}` }, body: fd });
      const upBody = await up.json();
      assert.equal(up.status, 201, JSON.stringify(upBody));
      const sent = got.drive.at(-1);
      assert.equal(sent.op, 'put');
      assert.match(sent.path, new RegExp(`^AVS CHECK/\\d{2}-\\d{2}-\\d{4}/Set ${String(made.body.id).padStart(4, '0')} ${job.jc}$`));
      assert.equal(sent.name, '01 IMG_0001.JPG');
      assert.deepEqual(Buffer.from(sent.base64, 'base64'), photo, 'the bytes reach Drive exactly');
      const row = await db.one('SELECT * FROM avs.check_photos WHERE request_id=$1', [made.body.id]);
      assert.equal(row.drive_file_id, 'f1');
      assert.equal(row.stored, 'drive');
      assert.equal(upBody.last_photo.stored, 'drive');
      assert.equal((await db.one('SELECT count(*)::int AS n FROM avs.check_photo_bytes')).n, 0, 'nothing kept when Drive took it');
      assert.equal(row.size_bytes, photo.length);
      assert.equal(row.captured_at.toISOString(), '2026-09-26T05:10:00.000Z');

      // A PDF is not a photo.
      const bad = new FormData();
      bad.append('file', new Blob([Buffer.from('%PDF')], { type: 'application/pdf' }), 'x.pdf');
      const refused = await fetch(`${base}/avs/uploads/${made.body.id}/photos`, {
        method: 'POST', headers: { authorization: `Bearer ${tokens.production}` }, body: bad });
      assert.equal(refused.status, 400);

      const v = await call('production', 'POST', `/avs/uploads/${made.body.id}/verify`);
      assert.equal(v.status, 200, JSON.stringify(v.body));
      assert.equal(v.body.fire.status, 'fired');
      assert.equal(v.body.set.status, 'queued');
      assert.equal(v.body.set.session_url, 'https://claude.ai/code/session_test');
      const fire = got.fires.at(-1);
      assert.equal(fire.auth, 'Bearer sk-ant-test-token');
      assert.equal(fire.beta, 'experimental-cc-routine-2026-04-01');
      assert.equal(fire.version, '2023-06-01');
      assert.match(fire.body.text, /Set \d{4} \(job card CI-JC-9\d{3}\) is waiting/);

      // A second set moments later joins the run already fired: no second run.
      const second = await call('qc', 'POST', '/avs/uploads', { product_hint: 'Old stock carton' });
      const fd2 = new FormData();
      fd2.append('file', new Blob([photo], { type: 'image/jpeg' }), 'b.jpg');
      await fetch(`${base}/avs/uploads/${second.body.id}/photos`, { method: 'POST', headers: { authorization: `Bearer ${tokens.qc}` }, body: fd2 });
      const v2 = await call('qc', 'POST', `/avs/uploads/${second.body.id}/verify`);
      assert.equal(v2.body.fire.status, 'joined');
      assert.equal(got.fires.length, 1);
      // Try again fires regardless.
      const retry = await call('qc', 'POST', `/avs/uploads/${second.body.id}/retry`);
      assert.equal(retry.body.fire.status, 'fired');
      assert.equal(got.fires.length, 2);

      // Verify twice is refused; Cancel works only before Claude takes it.
      assert.equal((await call('production', 'POST', `/avs/uploads/${made.body.id}/verify`)).status, 409);
      await db.q(`UPDATE avs.check_requests SET status='checking', claimed_at=now() WHERE id=$1`, [made.body.id]);
      assert.equal((await call('production', 'POST', `/avs/uploads/${made.body.id}/cancel`)).status, 409);

      const list = await call('production', 'GET', '/avs/uploads');
      assert.equal(list.status, 200);
      assert.equal(list.body.linked.drive, true);
      assert.equal(list.body.linked.claude, true);
      assert.ok(list.body.sets.some(x => x.id === made.body.id && x.photos.length === 1));
      assert.ok(!JSON.stringify(list.body).includes('sk-ant-test-token'), 'the token never goes to a browser');
      // Viewers cannot upload; only admin sees the setup.
      assert.equal((await call('production', 'GET', '/avs/setup')).status, 403);
    } finally {
      drive.close(); routine.close();
    }
  });

  // ── Without the Drive link: the photo is kept in CI Plant ─────────────────
  // The owner has not set up the Drive link (or Drive refuses): the upload still
  // works, the photo waits in avs.check_photo_bytes, the AVS check fetches it
  // with the robot key, and marking it filed drops the copy kept here.
  test('without the Drive link a photo is kept in CI Plant, and the check fetches it with its key', async () => {
    const http = await import('node:http');
    await applyAvsPhotoSchema();
    await setSettings({ drive_bridge_url: '', routine_fire_url: '', routine_token: '' });
    const job = await printingJob();
    const made = await call('production', 'POST', '/avs/uploads', { job_card_id: job.cardId });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const photo = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 20000 }, (_, i) => (i * 7) % 256)]);
    const send = async name => {
      const fd = new FormData();
      fd.append('file', new Blob([photo], { type: 'image/jpeg' }), name);
      const res = await fetch(`${base}/avs/uploads/${made.body.id}/photos`, {
        method: 'POST', headers: { authorization: `Bearer ${tokens.production}` }, body: fd });
      return { status: res.status, body: await res.json() };
    };

    const up = await send('IMG-20260926-WA0001.jpg');
    assert.equal(up.status, 201, JSON.stringify(up.body));
    assert.equal(up.body.last_photo.stored, 'ci_plant');
    assert.equal(up.body.last_photo.drive_error, null, 'nothing was tried: the link is not set up');
    assert.equal(up.body.photos[0].stored, 'ci_plant');
    assert.equal(up.body.photos[0].file_name, '01 IMG-20260926-WA0001.jpg');
    const row = await db.one(`SELECT p.id, p.drive_file_id, b.bytes FROM avs.check_photos p
      JOIN avs.check_photo_bytes b ON b.photo_id = p.id WHERE p.request_id = $1`, [made.body.id]);
    assert.equal(row.drive_file_id, null);
    assert.deepEqual(row.bytes, photo, 'kept byte for byte');

    // The check fetches it with the key in avs.settings — and only with that.
    const key = (await db.one(`SELECT value FROM avs.settings WHERE key = 'robot_key'`)).value;
    assert.match(key, /^[0-9a-f]{48}$/);
    const fetchPhoto = headers => fetch(`${base}/avs/robot/photos/${row.id}`, { headers });
    assert.equal((await fetchPhoto({})).status, 401);
    assert.equal((await fetchPhoto({ 'x-avs-robot-key': 'nope' })).status, 401);
    assert.equal((await fetchPhoto({ authorization: `Bearer ${tokens.qc}` })).status, 401, 'an ERP login does not open it');
    const got = await fetchPhoto({ 'x-avs-robot-key': key });
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'image/jpeg');
    assert.equal(got.headers.get('cache-control'), 'no-store');
    assert.equal(got.headers.get('x-photo-sha256'), crypto.createHash('sha256').update(photo).digest('hex'));
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), photo, 'the check gets the photo byte for byte');
    assert.equal((await fetch(`${base}/avs/robot/photos/999999`, { headers: { 'x-avs-robot-key': key } })).status, 404);

    // The list says where each photo is — never the photo, never the key.
    const list = await call('production', 'GET', '/avs/uploads');
    assert.equal(list.body.linked.drive, false);
    assert.ok(!JSON.stringify(list.body).includes(key), 'the robot key never goes to a browser');

    // Drive set up but refusing: the photo is still kept, with the reason.
    const refusing = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Wrong secret' }));
      });
    });
    await new Promise(r => refusing.listen(0, '127.0.0.1', r));
    try {
      await setSettings({ drive_bridge_url: `http://127.0.0.1:${refusing.address().port}/exec`, drive_bridge_secret: 'stale' });
      const second = await send('IMG-20260926-WA0002.jpg');
      assert.equal(second.status, 201, JSON.stringify(second.body));
      assert.equal(second.body.last_photo.stored, 'ci_plant');
      assert.match(second.body.last_photo.drive_error, /Wrong secret/);
      assert.equal(second.body.photos[1].file_name, '02 IMG-20260926-WA0002.jpg');

      // At the ceiling the upload is refused, says why, and gives its number back.
      process.env.AVS_KEPT_MAX_MB = '0.04';
      const full = await send('IMG-20260926-WA0003.jpg');
      delete process.env.AVS_KEPT_MAX_MB;
      assert.equal(full.status, 503);
      assert.match(full.body.error, /waiting to be filed|wait to be filed/);
      const third = await send('IMG-20260926-WA0003.jpg');
      assert.equal(third.status, 201, JSON.stringify(third.body));
      assert.equal(third.body.photos.at(-1).file_name, '03 IMG-20260926-WA0003.jpg', 'the refused photo gave its number back');
    } finally {
      delete process.env.AVS_KEPT_MAX_MB;
      refusing.close();
    }

    // Verify with Claude not linked (and no run under way to join): queued,
    // waiting for a check run from Cowork.
    await db.q(`UPDATE avs.check_requests SET status = 'done', finished_at = now()
      WHERE status IN ('checking', 'queued') AND id <> $1`, [made.body.id]);
    const v = await call('production', 'POST', `/avs/uploads/${made.body.id}/verify`);
    assert.equal(v.status, 200, JSON.stringify(v.body));
    assert.equal(v.body.set.status, 'queued');
    assert.equal(v.body.fire.status, 'not_linked');

    // Filed by the check: the copy kept here goes, and the fetch says where it is.
    await db.q(`UPDATE avs.check_photos SET stored = 'drive', filed_at = now(), filed_path = $2 WHERE id = $1`,
      [row.id, '2026-09 SEPTEMBER/26-09-2026/X/Photos AVS-2026-0901 Check 1/01 IMG-20260926-WA0001.jpg']);
    assert.equal((await db.one('SELECT count(*)::int AS n FROM avs.check_photo_bytes WHERE photo_id = $1', [row.id])).n, 0);
    const gone = await fetchPhoto({ 'x-avs-robot-key': key });
    assert.equal(gone.status, 410);
    assert.match((await gone.json()).filed_path, /Photos AVS-2026-0901 Check 1/);
    assert.equal((await db.one('SELECT count(*)::int AS n FROM avs.check_photo_bytes')).n, 2, 'the other two wait to be filed');

    // Claude linked but no Drive link: no cloud run is spent on a check that could
    // not reach the AVS folder; the set waits for a check started in Cowork.
    const fires = [];
    const routine = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => { fires.push(1); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
    });
    await new Promise(r => routine.listen(0, '127.0.0.1', r));
    try {
      await setSettings({ drive_bridge_url: '', routine_fire_url: `http://127.0.0.1:${routine.address().port}/fire`, routine_token: 'sk-ant-test-token' });
      const other = await call('qc', 'POST', '/avs/uploads', { product_hint: 'Sample carton' });
      const fd = new FormData();
      fd.append('file', new Blob([photo], { type: 'image/jpeg' }), 'x.jpg');
      const kept = await fetch(`${base}/avs/uploads/${other.body.id}/photos`, {
        method: 'POST', headers: { authorization: `Bearer ${tokens.qc}` }, body: fd });
      assert.equal(kept.status, 201);
      const v2 = await call('qc', 'POST', `/avs/uploads/${other.body.id}/verify`);
      assert.equal(v2.body.set.status, 'queued');
      assert.equal(v2.body.fire.status, 'not_linked');
      assert.match(v2.body.fire.error, /Drive link is not set up/);
      assert.equal(fires.length, 0, 'no routine run spent');
    } finally {
      routine.close();
    }

    // The list the chips are drawn from: every set in progress, the newest
    // finished ones of each status, and counts of all of them.
    const all = await call('production', 'GET', '/avs/uploads');
    assert.equal(all.body.counts.done, 2);
    assert.equal(all.body.counts.queued, 2);
    const newest = await call('production', 'GET', '/avs/uploads?per_status=1');
    assert.equal(newest.body.sets.filter(x => x.status === 'done').length, 1, 'only the newest finished set of each status');
    assert.equal(newest.body.sets.filter(x => x.status === 'queued').length, 2, 'every set still in progress');
    assert.equal(newest.body.counts.done, 2, 'the chip still counts them all');
  });

  // ── Setup: CI Plant pairs with the Drive link ──────────────────────────────
  // The stand-in pairs and rotates the way drive-link.gs does, and answers
  // through a redirect like Apps Script.
  test('the Drive link pairs with CI Plant: no secret is copied by hand, none reaches a browser', async () => {
    const http = await import('node:http');
    await applyAvsPhotoSchema();
    let secret = null;
    const results = new Map();
    const link = http.createServer((req, res) => {
      if (req.method !== 'POST') {
        const key = new URL(req.url, 'http://x').searchParams.get('k');
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(results.get(key)));
      }
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const j = JSON.parse(body);
        let out;
        if (j.op === 'pair') {
          if (secret) out = { ok: false, error: 'Already paired. To pair again: Project Settings > Script Properties > delete AVS_SECRET.' };
          else { secret = 'a'.repeat(64); out = { ok: true, paired: true, secret, root: { name: 'AVS', id: 'root1' } }; }
        } else if (!secret) out = { ok: false, error: 'Not paired yet' };
        else if (j.secret !== secret) out = { ok: false, error: 'Wrong secret' };
        else if (j.op === 'rotate') { secret = 'b'.repeat(64); out = { ok: true, secret }; }
        else out = { ok: true, root: { name: 'AVS', id: 'root1' } };
        const key = String(results.size + 1);
        results.set(key, out);
        res.writeHead(302, { Location: `http://127.0.0.1:${link.address().port}/echo?k=${key}` });
        res.end();
      });
    });
    await new Promise(r => link.listen(0, '127.0.0.1', r));
    const saved = async key => (await db.one('SELECT value FROM avs.settings WHERE key = $1', [key]))?.value;
    try {
      // Only a real Apps Script Web app URL is accepted in Setup.
      const bad = await call('admin', 'PUT', '/avs/setup', { drive_bridge_url: 'https://evil.example.com/exec' });
      assert.equal(bad.status, 400);
      // A saved link with no secret yet: Pair makes the link hand over its own.
      await setSettings({ drive_bridge_url: `http://127.0.0.1:${link.address().port}/exec`, drive_bridge_secret: '' });
      const before = await call('admin', 'GET', '/avs/setup');
      assert.equal(before.status, 200);
      assert.equal(before.body.linked.drive, false);
      const paired = await call('admin', 'POST', '/avs/setup/pair-drive');
      assert.equal(paired.status, 200, JSON.stringify(paired.body));
      assert.equal(paired.body.root.name, 'AVS');
      assert.equal(paired.body.linked.drive, true);
      assert.equal(await saved('drive_bridge_secret'), 'a'.repeat(64));
      // Linked: pairing again is refused and the working secret is kept.
      assert.equal((await call('admin', 'POST', '/avs/setup/pair-drive')).status, 409);
      assert.equal(await saved('drive_bridge_secret'), 'a'.repeat(64));
      assert.equal((await call('admin', 'POST', '/avs/setup/test-drive')).status, 200);
      // A new secret comes from the link and is saved here; the old one stops working.
      assert.equal((await call('admin', 'POST', '/avs/setup/new-secret')).status, 200);
      assert.equal(await saved('drive_bridge_secret'), 'b'.repeat(64));
      assert.equal((await call('admin', 'POST', '/avs/setup/test-drive')).status, 200);
      // A link paired with someone else: CI Plant says how to free it.
      await setSettings({ drive_bridge_secret: '' });
      const taken = await call('admin', 'POST', '/avs/setup/pair-drive');
      assert.equal(taken.status, 409);
      assert.match(taken.body.error, /delete AVS_SECRET/);
      // The secret never goes to a browser, not even an admin's.
      await setSettings({ drive_bridge_secret: 'b'.repeat(64) });
      const setup = await call('admin', 'GET', '/avs/setup');
      assert.ok(!JSON.stringify(setup.body).includes('b'.repeat(64)));
      assert.equal('drive_bridge_secret' in setup.body, false);
      // Only admin sees the setup.
      assert.equal((await call('qc', 'POST', '/avs/setup/pair-drive')).status, 403);
    } finally {
      link.close();
    }
  });
});
