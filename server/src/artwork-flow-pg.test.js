import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// The artwork workflow through the REAL app against a real Postgres and a fake Google (Gmail + Drive): the designer's
// export → Send for approval (proof, draft, Drive) → Send email → the client's reply → approved, order lines ticked →
// Send to plates. Invented names, codes and addresses throughout.
//
//   ARTWORK_PG=1 node --test src/artwork-flow-pg.test.js

const ENABLED = process.env.ARTWORK_PG === '1';
const ROBOT_KEY = 'test-robot-key-0000';
const BIZ = 'office@plant.test', OWNER = 'owner@plant.test', CLIENT = 'artwork@example-pharma.test';

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer(); srv.unref(); srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

describe('Artwork workflow — through the real app', { skip: ENABLED ? false : 'set ARTWORK_PG=1 to boot a throwaway Postgres' }, () => {
  let epg, dir, db, server, base, google, pdfLib;
  const tokens = {};
  // the fake Google
  const G = { drafts: new Map(), files: new Map(), sent: [], perms: [], n: 0, refuseSend: false, threads: new Map(), deleted: [], draftCreates: 0, sendCalls: 0, threadOf: new Map(), fullThreads: new Map(), attachments: new Map() };

  before(async () => {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artwork-flow-pg-'));
    const port = await freePort();
    epg = new EmbeddedPostgres({ databaseDir: dir, port, user: 'postgres', password: 'postgres', persistent: false, onLog: () => {}, onError: () => {} });
    await epg.initialise(); await epg.start();
    process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
    process.env.PG_POOL_MAX = '1';
    db = await import('./db.js');
    await db.connect(); await db.init();
    const { seedIfEmpty } = await import('./seed.js');
    await seedIfEmpty();
    await db.q(`CREATE SCHEMA IF NOT EXISTS avs`);
    await db.q(`CREATE TABLE IF NOT EXISTS avs.settings (key text PRIMARY KEY, value text, note text)`);
    await db.q(`INSERT INTO avs.settings (key, value) VALUES ('robot_key', $1)`, [ROBOT_KEY]);
    await db.q(fs.readFileSync(new URL('../../supabase/migrations/20261115100100_avs_artwork_intake.sql', import.meta.url), 'utf8'));
    await db.q(fs.readFileSync(new URL('../../supabase/migrations/20261118100100_avs_artwork_replies.sql', import.meta.url), 'utf8'));
    await db.q(fs.readFileSync(new URL('../../supabase/migrations/20261118120100_avs_fluence_readings.sql', import.meta.url), 'utf8'));
    await db.q(`INSERT INTO customers (name, segment) VALUES ('Example Pharma Ltd', 'pharma')`);
    await db.q(`UPDATE enquiry_mailboxes SET email = $1 WHERE key = 'business'`, [BIZ]);
    await db.q(`UPDATE enquiry_mailboxes SET email = $1 WHERE key = 'trial'`, [OWNER]);

    google = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const send = (code, obj, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
        const u = new URL(req.url, 'http://x');
        const p = u.pathname;
        if (p === '/token') return send(200, { access_token: 'at-1', expires_in: 3600 });
        if (req.headers.authorization !== 'Bearer at-1') return send(401, { error: { message: 'bad token' } });
        let m;
        // Gmail
        if ((m = /\/gmail\/v1\/users\/me\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(p))) {
          const bytes = G.attachments.get(`${m[1]}/${m[2]}`);
          return bytes ? send(200, { size: bytes.length, data: bytes.toString('base64url') }) : send(404, { error: { message: 'not found' } });
        }
        if ((m = /\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(p))) {
          return send(200, { id: m[1], threadId: G.threadOf.get(m[1]) || `t-${m[1]}`, payload: { headers: [{ name: 'Message-Id', value: `<${m[1]}@client.test>` },
            { name: 'From', value: `Asha Rao <${CLIENT}>` }, { name: 'To', value: BIZ }, { name: 'Cc', value: 'qa@example-pharma.test' }] } });
        }
        // a draft made through Gmail's upload door: JSON (the thread) + the whole message (message/rfc822)
        if (p === '/upload/gmail/v1/users/me/drafts' && req.method === 'POST') {
          const b = /boundary="?([^";]+)"?/.exec(req.headers['content-type'] || '')?.[1];
          const parts = body.toString('utf8').split(`--${b}`).slice(1, -1).map(x => x.replace(/^\r\n/, '').replace(/\r\n$/, ''));
          const meta = JSON.parse(parts[0].split('\r\n\r\n').slice(1).join('\r\n\r\n'));
          const mime = parts[1].split('\r\n\r\n').slice(1).join('\r\n\r\n');
          const id = `d-${++G.n}`, threadId = meta.message?.threadId || `t-new-${G.n}`;
          G.draftCreates += 1;
          G.drafts.set(id, { id, raw: Buffer.from(mime).toString('base64url'), threadId, created: Date.now(), message: { id: `dm-${G.n}`, threadId, labelIds: ['DRAFT'] } });
          return send(200, { id, message: { id: `dm-${G.n}`, threadId } });
        }
        if (p.endsWith('/drafts') && req.method === 'POST') return send(400, { error: { message: 'artwork drafts must use the upload door' } });
        if (p.endsWith('/drafts/send')) {
          G.sendCalls += 1;
          if (G.refuseSend) return send(500, { error: { message: 'backend error' } });
          const { id } = JSON.parse(body); const d = G.drafts.get(id);
          if (!d) return send(404, { error: { message: 'Requested entity was not found.' } });
          G.drafts.delete(id); G.sent.push(d);
          const marker = (/^X-CIPlant-Approval: (.*)$/mi.exec(Buffer.from(d.raw, 'base64url').toString('utf8')) || [])[1]?.trim();
          const t = G.threads.get(d.threadId) || [];
          t.push({ id: `sent-${G.sent.length}`, labelIds: ['SENT'], internalDate: String(Date.now()), payload: { headers: marker ? [{ name: 'X-CIPlant-Approval', value: marker }] : [] } });
          G.threads.set(d.threadId, t);
          return send(200, { id: `sent-${G.sent.length}`, threadId: d.threadId });
        }
        if ((m = /\/drafts\/([^/]+)$/.exec(p))) {
          const d = G.drafts.get(m[1]);
          if (req.method === 'DELETE') { if (!d) return send(404, { error: { message: 'Requested entity was not found.' } }); G.drafts.delete(m[1]); G.deleted.push(m[1]); res.writeHead(204); return res.end(); }
          if (!d) return send(404, { error: { message: 'Requested entity was not found.' } });
          const mime = Buffer.from(d.raw, 'base64url').toString('utf8');
          const h = n => (new RegExp(`^${n}: (.*)$`, 'mi').exec(mime) || [])[1] || '';
          return send(200, { id: d.id, message: { id: d.message.id, labelIds: d.message.labelIds, internalDate: d.message.internalDate || String(d.created),
            payload: { headers: [{ name: 'To', value: h('To') }, { name: 'Cc', value: h('Cc') }, { name: 'Subject', value: h('Subject') }] } } });
        }
        if ((m = /\/threads\/([^/]+)$/.exec(p)) && u.searchParams.get('format') === 'full') {
          return G.fullThreads.has(m[1]) ? send(200, G.fullThreads.get(m[1])) : send(404, { error: { message: 'not found' } });
        }
        if ((m = /\/threads\/([^/]+)$/.exec(p))) {
          return G.threads.has(m[1]) ? send(200, { id: m[1], messages: G.threads.get(m[1]) }) : send(404, { error: { message: 'not found' } });
        }
        // Drive
        if (p === '/drive/v3/files' && req.method === 'GET') return send(200, { files: G.folder ? [{ id: 'fold-1' }] : [] });
        if (p === '/drive/v3/files' && req.method === 'POST') { G.folder = true; return send(200, { id: 'fold-1' }); }
        if (p === '/upload/drive/v3/files' && req.method === 'POST') {
          const meta = JSON.parse(body); const id = `f-${++G.n}`; G.files.set(id, { name: meta.name, bytes: null });
          return send(200, {}, { location: `http://127.0.0.1:${google.address().port}/up/${id}` });
        }
        if ((m = /^\/up\/(.+)$/.exec(p))) { G.files.get(m[1]).bytes = body; return send(200, { id: m[1], webViewLink: `https://drive.test/${m[1]}` }); }
        if ((m = /^\/drive\/v3\/files\/([^/]+)\/permissions$/.exec(p))) { G.perms.push({ file: m[1], ...JSON.parse(body) }); return send(200, { id: 'perm' }); }
        if ((m = /^\/drive\/v3\/files\/([^/]+)$/.exec(p)) && u.searchParams.get('alt') === 'media') {
          const f = G.files.get(m[1]);
          if (!f) return send(404, { error: { message: 'not found' } });
          res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end(f.bytes);
        }
        return send(404, { error: { message: `no fake for ${req.method} ${p}` } });
      });
    });
    await new Promise(res => google.listen(0, '127.0.0.1', res));
    const gb = `http://127.0.0.1:${google.address().port}`;
    Object.assign(process.env, { GOOGLE_CLIENT_ID: 'fake-client', GOOGLE_CLIENT_SECRET: 'fake-secret', GMAIL_TOKEN_KEY: 'ef'.repeat(32),
      GMAIL_API_BASE: `${gb}/gmail/v1/users/me`, GMAIL_UPLOAD_BASE: `${gb}/upload/gmail/v1/users/me`, GOOGLE_TOKEN_URL: `${gb}/token`, GOOGLE_REVOKE_URL: `${gb}/revoke`,
      GDRIVE_API_BASE: `${gb}/drive/v3`, GDRIVE_UPLOAD_BASE: `${gb}/upload/drive/v3` });
    const { sealToken, GMAIL_SCOPES } = await import('./gmail.js');
    const { DRIVE_SCOPE } = await import('./gdrive.js');
    await db.q(`INSERT INTO gmail_links (mailbox, email, refresh_token_enc, scope, connected_by_name) VALUES ('business', $1, $2, $3, 'Admin')`,
      [BIZ, sealToken('1//b'), [...GMAIL_SCOPES, DRIVE_SCOPE].join(' ')]);

    const { default: jwt } = await import('jsonwebtoken');
    const { JWT_SECRET: secret } = await import('./auth.js');
    const mk = async (key, role, modules) => {
      const u = await db.one(`INSERT INTO users (name, email, password_hash, role, modules) VALUES ($1, $2, 'x', $3, $4) RETURNING id, name, role`,
        [`Art ${key}`, `art-${key}@test.local`, role, modules && JSON.stringify(modules)]);
      tokens[key] = jwt.sign({ id: u.id, name: u.name, role: u.role }, secret);
    };
    await mk('admin', 'admin', null);
    await mk('artist', 'planner', ['artwork']);
    await mk('plain', 'dispatch', ['dispatch']);
    const { default: app } = await import('./app.js');
    server = await new Promise(res => { const s = app.listen(0, () => res(s)); });
    base = `http://127.0.0.1:${server.address().port}/api`;
    pdfLib = await import('pdf-lib');
  });

  after(async () => {
    server?.close(); google?.close();
    try { await (await db?.connect())?.end(); } catch {}
    try { await epg?.stop(); } catch {}
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const call = async (who, method, url, body, headers = {}) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}), ...headers },
      body: body == null ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, body: json };
  };
  const fileMails = list => db.one('SELECT avs.file_artwork_mails($1::jsonb) AS out', [JSON.stringify(list)]);
  const sync = async () => (await import('./artwork-intake.js')).syncIntakeArtwork();
  const mailOf = (id, items, over = {}) => ({ mailbox_email: BIZ, gmail_message_id: id, gmail_thread_id: `t-${id}`, subject: `Artwork ${id}`,
    from_name: 'Asha Rao', from_email: CLIENT, received_at: '2026-11-17T05:00:00Z', customer_name: 'example pharma ltd', items, ...over });
  const f = (name, sha) => ({ file_name: name, size_bytes: 1000, sha256: sha, drive_file_id: `drv-${sha}`, drive_url: `https://drive.test/${sha}` });
  const version = code => db.one(`SELECT v.* FROM artwork_versions v JOIN artwork_jobs j ON j.id = v.job_id WHERE j.client_item_code = $1 ORDER BY v.id DESC LIMIT 1`, [code]);
  const exportPdf = async (w = 138, h = 96.5) => {
    const d = await pdfLib.PDFDocument.create(); d.addPage([w * 72 / 25.4, h * 72 / 25.4]); return Buffer.from(await d.save());
  };
  // the CorelDRAW button: start → chunks → finish, with a PC's key
  let pcKey;
  const upload = async ({ name, bytes, key = pcKey, chunk = 3 * 1024 * 1024, colours = ['Cyan', 'PANTONE 286 C'] }) => {
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    const h = { 'x-artwork-key': key };
    const start = await call(null, 'POST', '/artwork/export/start', { file_name: name, size_bytes: bytes.length, sha256: sha, page_w_mm: 138, page_h_mm: 96.5, colours }, h);
    if (start.status !== 200) return start;
    for (let i = 0; i * chunk < bytes.length; i++) {
      const put = await call(null, 'PUT', `/artwork/export/${start.body.upload}/chunk/${i}`, bytes.subarray(i * chunk, (i + 1) * chunk), { ...h, 'content-type': 'application/octet-stream' });
      assert.equal(put.status, 200, JSON.stringify(put.body));
    }
    return call(null, 'POST', `/artwork/export/${start.body.upload}/finish`, {}, h);
  };

  test('the tables and the new stage exist; a new version starts "new"; replies may be filed by AVS', async () => {
    for (const t of ['artwork_export_keys', 'artwork_uploads', 'artwork_upload_chunks', 'artwork_exports', 'artwork_proof_mails', 'artwork_proofs']) {
      assert.ok((await db.one(`SELECT to_regclass($1) AS r`, [`public.${t}`])).r, t);
    }
    await fileMails([mailOf('w-001', [{ client_item_code: 'PCS-W001', client_rev: 'R0', product_name: 'ALPHA CARTON', files: [f('PCS-W001-R0.cdr', 'w001')] }])]);
    await sync();
    assert.equal((await version('PCS-W001')).stage, 'new');
    const r = await fileMails([{ mailbox_email: BIZ, gmail_message_id: 'w-r0', kind: 'reply' }]);
    assert.equal(r.out[0].filed, true);
  });

  test('designer PC keys: only an admin makes one, it is shown once, and a switched-off key is refused', async () => {
    assert.equal((await call('artist', 'POST', '/artwork/register/keys', { name: 'Designer 1' })).status, 403);
    assert.equal((await call('plain', 'GET', '/artwork/register/keys')).status, 403);
    const made = await call('admin', 'POST', '/artwork/register/keys', { name: 'Designer 1 — office PC' });
    assert.equal(made.status, 200);
    pcKey = made.body.key;
    assert.match(pcKey, /^ciaw_/);
    const list = (await call('admin', 'GET', '/artwork/register/keys')).body.keys;
    assert.equal(list[0].key, undefined, 'the key itself is never listed');
    const spare = (await call('admin', 'POST', '/artwork/register/keys', { name: 'spare' })).body;
    await call('admin', 'POST', `/artwork/register/keys/${spare.id}/off`);
    assert.equal((await upload({ name: 'PCS-W001-R0.cdr', bytes: await exportPdf(), key: spare.key })).status, 401);
    assert.equal((await upload({ name: 'PCS-W001-R0.cdr', bytes: await exportPdf(), key: 'nonsense' })).status, 401);
  });

  test('the CorelDRAW button: the export arrives in pieces, goes to Drive, finds its job by code and revision, and lights Send for approval', async () => {
    const bytes = await exportPdf();
    const out = await upload({ name: 'PCS-W001-R0 - ALPHA CARTON.cdr', bytes, chunk: 700 });       // several pieces
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.matched, true);
    const v = await version('PCS-W001');
    assert.equal(v.stage, 'designer_file');
    const e = await db.one(`SELECT * FROM artwork_exports WHERE version_id = $1`, [v.id]);
    assert.equal(e.by_name, 'Designer 1 — office PC');
    assert.deepEqual(e.colours, ['Cyan', 'PANTONE 286 C']);
    assert.ok(G.files.get(e.drive_file_id).bytes.equals(bytes), 'the same bytes on Drive');
    assert.ok(G.perms.some(p => p.file === e.drive_file_id && p.emailAddress === OWNER), 'shared with the other company mailbox');
    assert.equal((await db.one(`SELECT count(*)::int AS n FROM artwork_upload_chunks`)).n, 0, 'pieces deleted');
    const reg = (await call('artist', 'GET', '/artwork/register')).body.jobs.find(j => j.client_item_code === 'PCS-W001');
    assert.deepEqual(reg.latest.actions, ['send_for_approval']);
  });

  test('a damaged upload is refused; an export with no code waits for a person, who puts it on its job', async () => {
    const bytes = await exportPdf();
    const sha = crypto.createHash('sha256').update(Buffer.from('other')).digest('hex');
    const h = { 'x-artwork-key': pcKey };
    const start = await call(null, 'POST', '/artwork/export/start', { file_name: 'PCS-W001-R0.cdr', size_bytes: bytes.length, sha256: sha }, h);
    await call(null, 'PUT', `/artwork/export/${start.body.upload}/chunk/0`, bytes, { ...h, 'content-type': 'application/octet-stream' });
    const fin = await call(null, 'POST', `/artwork/export/${start.body.upload}/finish`, {}, h);
    assert.equal(fin.status, 422);
    assert.match(fin.body.error, /damaged/);

    await fileMails([mailOf('w-002', [{ product_name: 'NEO KIT 7 OUTER', files: [f('kit.cdr', 'w002')] }])]);
    await sync();
    const loose = await upload({ name: 'NEO KIT 7 OUTER.cdr', bytes: await exportPdf(120, 80) });
    assert.equal(loose.body.matched, false);
    assert.match(loose.body.why, /no item code/);
    const list = (await call('artist', 'GET', '/artwork/register')).body;
    assert.ok(list.unmatched_exports.some(x => x.file_name === 'NEO KIT 7 OUTER.cdr'));
    const kit = await db.one(`SELECT v.id FROM artwork_versions v JOIN artwork_jobs j ON j.id = v.job_id WHERE j.product_name = 'NEO KIT 7 OUTER'`);
    assert.equal((await call('artist', 'POST', `/artwork/register/exports/${loose.body.export_id}/match`, { version_id: kit.id })).status, 200);
    assert.equal((await db.one('SELECT stage FROM artwork_versions WHERE id = $1', [kit.id])).stage, 'designer_file');
  });

  let mailId;
  test('Send for approval builds the stamped proof, a reply-all draft in the client\'s thread with it attached, and a Drive copy — nothing is sent', async () => {
    const v = await version('PCS-W001');
    const newOne = await db.one(`SELECT v.id FROM artwork_versions v JOIN artwork_jobs j ON j.id = v.job_id WHERE j.product_name = 'NEO KIT 7 OUTER'`);
    assert.equal((await call('plain', 'POST', '/artwork/register/send-for-approval', { version_ids: [v.id] })).status, 403);
    const res = await call('artist', 'POST', '/artwork/register/send-for-approval', { version_ids: [v.id, newOne.id, 99999] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.drafts.length, 2, 'two client threads → two drafts');
    const d = res.body.drafts.find(x => x.versions.includes(v.id));
    mailId = d.proof_mail_id;
    assert.deepEqual(d.proofs, [`PRF-${(await db.one('SELECT job_no FROM artwork_jobs WHERE id = $1', [v.job_id])).job_no}-R0.1-1`]);
    assert.deepEqual(d.to, [CLIENT]);
    assert.deepEqual(d.cc, ['qa@example-pharma.test']);
    assert.equal(G.sent.length, 0, 'nothing sent');
    const draft = [...G.drafts.values()].find(x => x.threadId === 't-w-001');
    const mime = Buffer.from(draft.raw, 'base64url').toString('utf8');
    assert.match(mime, /^Subject: Re: Artwork w-001$/m);
    assert.match(mime, /^In-Reply-To: <w-001@client\.test>$/m);
    assert.match(mime, /filename="PRF-CI-AW-\d{4}-R0\.1-1\.pdf"/);
    assert.match(Buffer.from(mime.split('Content-Type: text/plain; charset=UTF-8')[1].split('\r\n\r\n')[1].split('--')[0].replace(/\r\n/g, ''), 'base64').toString(), /Please Provide Approval,/);
    const proof = await db.one('SELECT * FROM artwork_proofs WHERE version_id = $1', [v.id]);
    const onDrive = await pdfLib.PDFDocument.load(G.files.get(proof.drive_file_id).bytes);
    assert.ok(onDrive.getPage(0).getHeight() > 96.5 * 72 / 25.4 + 100, 'the proof strip is below the artwork');
    assert.equal((await version('PCS-W001')).stage, 'proof_ready');
    // the window shows the mail exactly as it will go
    const win = (await call('artist', 'GET', `/artwork/register/${v.job_id}`)).body.versions[0];
    assert.deepEqual(win.actions, ['send_email', 'cancel_draft']);
    assert.equal(win.proof_mails[0].to_text, CLIENT);
    assert.equal(win.proof_mails[0].attachments[0].name, `${proof.proof_no}.pdf`);
    // pressing again does nothing for a version already drafted
    const again = await call('artist', 'POST', '/artwork/register/send-for-approval', { version_ids: [v.id] });
    assert.equal(again.body.drafts.length, 0);
    assert.match(again.body.skipped[0].why, /proof_ready/);
  });

  test('Send email sends the reviewed draft once; a Gmail failure leaves it a draft with the reason', async () => {
    G.refuseSend = true;
    const bad = await call('artist', 'POST', '/artwork/register/send-email', { proof_mail_ids: [mailId] });
    assert.match(bad.body.skipped[0].why, /backend error/);
    assert.equal((await db.one('SELECT status FROM artwork_proof_mails WHERE id = $1', [mailId])).status, 'draft');
    G.refuseSend = false;
    const ok = await call('artist', 'POST', '/artwork/register/send-email', { proof_mail_ids: [mailId] });
    assert.equal(ok.body.sent.length, 1);
    assert.equal(G.sent.length, 1);
    const pm = await db.one('SELECT status, sent_by, to_text FROM artwork_proof_mails WHERE id = $1', [mailId]);
    assert.deepEqual([pm.status, pm.sent_by, pm.to_text], ['sent', 'Art artist', CLIENT]);
    assert.equal((await version('PCS-W001')).stage, 'approval_sent');
    const twice = await call('artist', 'POST', '/artwork/register/send-email', { proof_mail_ids: [mailId] });
    assert.equal(twice.body.sent.length, 0);
    assert.equal(G.sent.length, 1, 'never twice');
  });

  test('the client\'s approval moves the version, ticks the product\'s open order lines, and new lines start approved', async () => {
    const v = await version('PCS-W001');
    const product = await db.one(`SELECT id FROM products ORDER BY id LIMIT 1`);
    await db.q('UPDATE artwork_jobs SET product_id = $1 WHERE id = $2', [product.id, v.job_id]);
    const cust = await db.one(`SELECT id FROM customers ORDER BY id LIMIT 1`);
    const order = await db.one(`INSERT INTO orders (po_number, customer_id, po_date, status) VALUES ('PO-W1', $1, '2026-11-17', 'pending') RETURNING id`, [cust.id]);
    const line = await db.one(`INSERT INTO order_lines (order_id, product_id, qty, rate) VALUES ($1, $2, 1000, 1) RETURNING id, artwork_customer_ok`, [order.id, product.id]);
    assert.equal(line.artwork_customer_ok, 0);
    const proof = await db.one('SELECT proof_no FROM artwork_proofs WHERE version_id = $1', [v.id]);
    await fileMails([mailOf('w-r1', [{ proof_nos: [proof.proof_no], verdict: 'approval', remarks: 'Approved, please go ahead' }], { kind: 'reply', gmail_thread_id: 't-w-001', received_at: new Date().toISOString() })]);
    await sync();
    assert.equal((await version('PCS-W001')).stage, 'approved');
    assert.equal((await db.one('SELECT artwork_customer_ok FROM order_lines WHERE id = $1', [line.id])).artwork_customer_ok, 1);
    const later = await db.one(`INSERT INTO order_lines (order_id, product_id, qty, rate) VALUES ($1, $2, 500, 1) RETURNING artwork_customer_ok`, [order.id, product.id]);
    assert.equal(later.artwork_customer_ok, 1, 'a line raised later starts approved');
    // Send to plates lights up, and records who
    const reg = (await call('artist', 'GET', '/artwork/register')).body.jobs.find(j => j.client_item_code === 'PCS-W001');
    assert.deepEqual(reg.latest.actions, ['release']);
    assert.deepEqual((await call('artist', 'POST', '/artwork/register/release', { version_ids: [v.id] })).body.moved, [v.id]);
    assert.equal((await version('PCS-W001')).stage, 'released');
  });

  test('a reply that names no proof in a mail of several goes to a person; a person decides only with a note', async () => {
    // two versions in one thread → one mail with two proofs
    await fileMails([mailOf('w-003', [
      { client_item_code: 'PCS-W003', client_rev: 'R0', files: [f('PCS-W003-R0.cdr', 'w003')] },
      { client_item_code: 'PML-W004', client_rev: 'R0', files: [f('PML-W004-R0.cdr', 'w004')] }])]);
    await sync();
    await upload({ name: 'PCS-W003-R0.cdr', bytes: await exportPdf() });
    await upload({ name: 'PML-W004-R0.cdr', bytes: await exportPdf(80, 40) });
    const a = await version('PCS-W003'), b = await version('PML-W004');
    const sfa = await call('artist', 'POST', '/artwork/register/send-for-approval', { version_ids: [a.id, b.id] });
    assert.equal(sfa.body.drafts.length, 1, 'one thread → one mail');
    assert.equal(sfa.body.drafts[0].proofs.length, 2);
    await call('artist', 'POST', '/artwork/register/send-email', { proof_mail_ids: [sfa.body.drafts[0].proof_mail_id] });
    await fileMails([mailOf('w-r3', [{ proof_nos: [], verdict: 'approval', remarks: 'ok' }], { kind: 'reply', gmail_thread_id: 't-w-003', received_at: new Date().toISOString() })]);
    await sync();
    assert.deepEqual([(await version('PCS-W003')).stage, (await version('PML-W004')).stage], ['to_confirm', 'to_confirm']);
    assert.equal((await call('artist', 'POST', '/artwork/register/decide', { version_ids: [a.id], verdict: 'approved', note: ' ' })).status, 400);
    const d = await call('artist', 'POST', '/artwork/register/decide', { version_ids: [a.id], verdict: 'approved', note: 'Approved on WhatsApp by the client, 17 Nov' });
    assert.deepEqual(d.body.moved, [a.id]);
    await call('artist', 'POST', '/artwork/register/decide', { version_ids: [b.id], verdict: 'changes', note: 'Asked for a bigger logo on the phone' });
    assert.deepEqual([(await version('PCS-W003')).stage, (await version('PML-W004')).stage], ['approved', 'changes']);
  });

  test('a newer file from the client puts the version out for approval to "changes asked"', async () => {
    await fileMails([mailOf('w-005', [{ client_item_code: 'PCS-W005', client_rev: 'R0', files: [f('PCS-W005-R0.cdr', 'w005')] }])]);
    await sync();
    await upload({ name: 'PCS-W005-R0.cdr', bytes: await exportPdf() });
    const v1 = await version('PCS-W005');
    const sfa = await call('artist', 'POST', '/artwork/register/send-for-approval', { version_ids: [v1.id] });
    await call('artist', 'POST', '/artwork/register/send-email', { proof_mail_ids: [sfa.body.drafts[0].proof_mail_id] });
    await fileMails([mailOf('w-006', [{ client_item_code: 'PCS-W005', client_rev: 'R1', files: [f('PCS-W005-R1.cdr', 'w006')] }], { gmail_thread_id: 't-w-005' })]);
    await sync();
    assert.equal((await db.one('SELECT stage FROM artwork_versions WHERE id = $1', [v1.id])).stage, 'changes');
    assert.equal((await version('PCS-W005')).stage, 'new');
  });

  test('a proof the designer sent by hand from Gmail counts: the version is out for approval, and the client\'s answer lands on it', async () => {
    await fileMails([mailOf('w-007', [{ client_item_code: 'PCS-W007', client_rev: 'R0', files: [f('PCS-W007-R0.cdr', 'w007')] }])]);
    await sync();
    await fileMails([mailOf('w-007h', [{ files: [f('PCS-W007-R0.pdf', 'w007h')] }], { kind: 'proof_by_hand', gmail_thread_id: 't-w-007', from_email: BIZ })]);
    await sync();
    assert.equal((await version('PCS-W007')).stage, 'approval_sent');
    await fileMails([mailOf('w-007r', [{ verdict: 'approval', proof_nos: [] }], { kind: 'reply', gmail_thread_id: 't-w-007' })]);
    await sync();
    assert.equal((await version('PCS-W007')).stage, 'approved');
  });

  test('delete hides a version with its reason and keeps it; restore puts it back', async () => {
    const v = await version('PCS-W005');
    assert.equal((await call('artist', 'POST', '/artwork/register/delete', { version_ids: [v.id], reason: '' })).status, 400);
    assert.deepEqual((await call('artist', 'POST', '/artwork/register/delete', { version_ids: [v.id], reason: 'Sent to us by mistake' })).body.deleted, [v.id]);
    const row = await db.one('SELECT deleted_reason, deleted_by FROM artwork_versions WHERE id = $1', [v.id]);
    assert.deepEqual([row.deleted_reason, row.deleted_by], ['Sent to us by mistake', 'Art artist']);
    assert.deepEqual((await call('artist', 'POST', '/artwork/register/restore', { version_ids: [v.id] })).body.restored, [v.id]);
  });

  // ── after the review (18 Nov): never twice, never stale, never lost ───────────────────────────────────────────
  const settle = async () => (await import('./artwork-settle.js')).settleProofMails({ max: 20 });
  const pmOf = id => db.one('SELECT * FROM artwork_proof_mails WHERE id = $1', [id]);
  const ready = async (id, code, rev = 'R0', over = {}) => {
    await fileMails([mailOf(id, [{ client_item_code: code, client_rev: rev, files: [f(`${code}-${rev}.cdr`, `${id}-src`)] }], over)]);
    await sync();
    const up = await upload({ name: `${code}-${rev} - ITEM.cdr`, bytes: await exportPdf() });
    assert.equal(up.body?.matched, true, JSON.stringify(up.body));
    return version(code);
  };
  const draftOf = async versionId => (await call('artist', 'POST', '/artwork/register/send-for-approval', { version_ids: [versionId] })).body.drafts[0];

  test('two presses of Send for approval at once make one proof and one draft', async () => {
    const v = await ready('w-101', 'PCS-W101');
    const before = G.draftCreates;
    const [a, b] = await Promise.all([
      call('artist', 'POST', '/artwork/register/send-for-approval', { version_ids: [v.id] }),
      call('artist', 'POST', '/artwork/register/send-for-approval', { version_ids: [v.id] }),
    ]);
    assert.equal(G.draftCreates - before, 1, 'one Gmail draft');
    assert.equal(a.body.drafts.length + b.body.drafts.length, 1);
    assert.match([...a.body.skipped, ...b.body.skipped][0].why, /being built|proof_ready/);
    assert.equal((await db.one('SELECT count(*)::int AS n FROM artwork_proofs WHERE version_id = $1', [v.id])).n, 1);
    assert.equal((await db.one('SELECT building_at FROM artwork_versions WHERE id = $1', [v.id])).building_at, null, 'the claim is let go');
  });

  test('Send email: a draft changed in Gmail is not sent from CI Plant; one already sent from Gmail is recorded, never sent twice', async () => {
    const v = await version('PCS-W101');
    const pm = await db.one(`SELECT * FROM artwork_proof_mails WHERE $1 = ANY(version_ids)`, [v.id]);
    const d = G.drafts.get(pm.gmail_draft_id);
    const was = d.message.id;
    d.message.id = 'dm-edited-in-gmail';
    const calls = G.sendCalls;
    const edited = await call('artist', 'POST', '/artwork/register/send-email', { proof_mail_ids: [pm.id] });
    assert.match(edited.body.skipped[0].why, /changed in Gmail/);
    assert.equal(G.sendCalls, calls, 'not sent');
    assert.equal((await pmOf(pm.id)).status, 'draft');
    d.message.id = was;
    // now it goes from Gmail by hand: Gmail keeps the draft's id and points it at the SENT message
    d.message.labelIds = ['SENT'];
    d.message.internalDate = String(Date.parse('2026-11-18T06:00:00Z'));
    const again = await call('artist', 'POST', '/artwork/register/send-email', { proof_mail_ids: [pm.id] });
    assert.equal(again.body.sent[0].already, true);
    assert.equal(G.sendCalls, calls, 'still never sent by CI Plant');
    assert.equal((await pmOf(pm.id)).status, 'sent');
    assert.equal((await version('PCS-W101')).stage, 'approval_sent');
    const pr = await db.one('SELECT sent_at FROM artwork_proofs WHERE proof_mail_id = $1', [pm.id]);
    assert.equal(new Date(pr.sent_at).toISOString(), '2026-11-18T06:00:00.000Z', 'the proof knows when it really went');
  });

  test('a send cut off midway is settled from Gmail: not gone → a draft again; gone → recorded as sent, not sent again', async () => {
    const v = await ready('w-102', 'PCS-W102');
    const dr = await draftOf(v.id);
    await db.q(`UPDATE artwork_proof_mails SET status = 'sending', claimed_at = now() - interval '5 minutes' WHERE id = $1`, [dr.proof_mail_id]);
    await settle();
    let pm = await pmOf(dr.proof_mail_id);
    assert.equal(pm.status, 'draft');
    assert.match(pm.error, /did not finish/);
    await db.q(`UPDATE artwork_proof_mails SET status = 'sending', claimed_at = now() - interval '5 minutes' WHERE id = $1`, [dr.proof_mail_id]);
    G.drafts.delete(pm.gmail_draft_id);                    // Gmail had taken it: the sent mail carries CI Plant's mark
    G.threads.set(pm.gmail_thread_id, [{ id: 'took-1', labelIds: ['SENT'], internalDate: String(Date.now()), payload: { headers: [{ name: 'X-CIPlant-Approval', value: pm.mail_token }] } }]);
    const calls = G.sendCalls;
    await settle();
    pm = await pmOf(dr.proof_mail_id);
    assert.equal(pm.status, 'sent');
    assert.equal((await version('PCS-W102')).stage, 'approval_sent');
    assert.equal(G.sendCalls, calls);
  });

  test('Send email refuses a proof whose version was replaced or deleted since; those drafts are cancelled and taken out of Gmail', async () => {
    const v = await ready('w-103', 'PCS-W103');
    const dr = await draftOf(v.id);
    await fileMails([mailOf('w-104', [{ client_item_code: 'PCS-W103', client_rev: 'R1', files: [f('PCS-W103-R1.cdr', 'w104')] }], { gmail_thread_id: 't-w-103' })]);
    await sync();
    assert.equal((await db.one('SELECT stage FROM artwork_versions WHERE id = $1', [v.id])).stage, 'changes');
    assert.equal((await pmOf(dr.proof_mail_id)).status, 'cancelled');
    const s1 = await call('artist', 'POST', '/artwork/register/send-email', { proof_mail_ids: [dr.proof_mail_id] });
    assert.equal(s1.body.sent.length, 0);
    await settle();
    const gid = (await pmOf(dr.proof_mail_id)).gmail_draft_id;
    assert.ok(G.deleted.includes(gid), 'the Gmail draft is removed');
    assert.ok((await pmOf(dr.proof_mail_id)).draft_deleted_at);
    // deleted version: its draft is cancelled and removed at once
    const w = await ready('w-105', 'PCS-W105');
    const d2 = await draftOf(w.id);
    await call('artist', 'POST', '/artwork/register/delete', { version_ids: [w.id], reason: 'wrong job' });
    assert.equal((await pmOf(d2.proof_mail_id)).status, 'cancelled');
    assert.ok(G.deleted.includes((await pmOf(d2.proof_mail_id)).gmail_draft_id));
    // a stale window: the claim itself refuses a version that is no longer the newest
    const x = await ready('w-106', 'PCS-W106');
    const d3 = await draftOf(x.id);
    await db.q(`INSERT INTO artwork_versions (job_id, client_rev, receipt_no, label) VALUES ($1, 'R9', 1, 'R9.1')`, [x.job_id]);
    const s3 = await call('artist', 'POST', '/artwork/register/send-email', { proof_mail_ids: [d3.proof_mail_id] });
    assert.match(s3.body.skipped[0].why, /newer version|replaced/);
    assert.equal((await pmOf(d3.proof_mail_id)).status, 'draft');
  });

  test('a client reply older than the proof out does not count; a reply filed before its hand proof in the same run still lands', async () => {
    const v = await version('PCS-W101');                  // approval_sent since the test above
    await fileMails([mailOf('w-101-old', [{ verdict: 'approval', proof_nos: [] }], { kind: 'reply', gmail_thread_id: (await db.one(`SELECT gmail_thread_id FROM artwork_proof_mails WHERE $1 = ANY(version_ids)`, [v.id])).gmail_thread_id, received_at: '2026-11-01T00:00:00Z' })]);
    await sync();
    assert.equal((await version('PCS-W101')).stage, 'approval_sent', 'an old reply answers an older proof, not this one');
    // reply and hand proof in one call, the reply first in the list but later in time
    await fileMails([mailOf('w-107', [{ client_item_code: 'PCS-W107', client_rev: 'R0', files: [f('PCS-W107-R0.cdr', 'w107')] }], { received_at: '2026-11-18T03:00:00Z' })]);
    await sync();
    await fileMails([
      mailOf('w-107r', [{ verdict: 'approval', proof_nos: [] }], { kind: 'reply', gmail_thread_id: 't-w-107', received_at: '2026-11-18T05:00:00Z' }),
      mailOf('w-107h', [{ files: [f('PCS-W107-R0.pdf', 'w107h')] }], { kind: 'proof_by_hand', gmail_thread_id: 't-w-107', from_email: BIZ, received_at: '2026-11-18T04:00:00Z' }),
    ]);
    await sync();
    assert.equal((await version('PCS-W107')).stage, 'approved');
  });

  test('order lines follow the product\'s newest artwork across all its jobs; matching an approved job to a product ticks its lines', async () => {
    const [, p2] = await db.q(`SELECT id FROM products ORDER BY id LIMIT 2`);
    const cust = await db.one(`SELECT id FROM customers ORDER BY id LIMIT 1`);
    const order = await db.one(`INSERT INTO orders (po_number, customer_id, po_date, status) VALUES ('PO-W2', $1, '2026-11-18', 'pending') RETURNING id`, [cust.id]);
    const line = await db.one(`INSERT INTO order_lines (order_id, product_id, qty, rate) VALUES ($1, $2, 100, 1) RETURNING id, artwork_customer_ok`, [order.id, p2.id]);
    assert.equal(line.artwork_customer_ok, 0);
    const a = await version('PCS-W107');                   // approved above, not yet linked to a product
    const res = await call('artist', 'POST', `/artwork/register/${a.job_id}/map`, { product_id: p2.id });
    assert.equal(res.status, 200);
    assert.equal((await db.one('SELECT artwork_customer_ok FROM order_lines WHERE id = $1', [line.id])).artwork_customer_ok, 1, 'mapping an approved job ticks the lines');
    // a newer artwork for the same product, on another job, not yet approved: new lines are not ticked
    await fileMails([mailOf('w-108', [{ client_item_code: 'PCS-W108', client_rev: 'R0', files: [f('PCS-W108-R0.cdr', 'w108')] }])]);
    await sync();
    const b = await version('PCS-W108');
    await call('artist', 'POST', `/artwork/register/${b.job_id}/map`, { product_id: p2.id });
    const later = await db.one(`INSERT INTO order_lines (order_id, product_id, qty, rate) VALUES ($1, $2, 100, 1) RETURNING artwork_customer_ok`, [order.id, p2.id]);
    assert.equal(later.artwork_customer_ok, 0, 'the product\'s newest artwork is not approved');
  });

  test('a job whose every version is deleted is under the Deleted chip and can be put back', async () => {
    await fileMails([mailOf('w-109', [{ client_item_code: 'PCS-W109', client_rev: 'R0', files: [f('PCS-W109-R0.cdr', 'w109')] }])]);
    await sync();
    const v = await version('PCS-W109');
    await call('artist', 'POST', '/artwork/register/delete', { version_ids: [v.id], reason: 'not ours' });
    const all = (await call('artist', 'GET', '/artwork/register')).body.jobs;
    assert.ok(!all.some(j => j.client_item_code === 'PCS-W109'), 'not in the everyday list');
    const del = (await call('artist', 'GET', '/artwork/register?status=deleted')).body.jobs;
    const j = del.find(x => x.client_item_code === 'PCS-W109');
    assert.ok(j?.latest.deleted_at);
    await call('artist', 'POST', '/artwork/register/restore', { version_ids: [v.id] });
    assert.ok((await call('artist', 'GET', '/artwork/register')).body.jobs.some(x => x.client_item_code === 'PCS-W109'));
  });

  test('an export cannot go onto a version out for approval or approved; uploads are capped; abandoned pieces are cleared', async () => {
    const v = await version('PCS-W101');                  // approval_sent
    const st = await call('artist', 'POST', `/artwork/register/versions/${v.id}/export/start`, { file_name: 'x.pdf', size_bytes: 10, sha256: 'a'.repeat(64) });
    assert.equal(st.status, 409);
    assert.match(st.body.error, /approval/);
    const big = await call(null, 'POST', '/artwork/export/start', { file_name: 'PCS-W109-R0.cdr', size_bytes: 18 * 1024 * 1024, sha256: 'b'.repeat(64) }, { 'x-artwork-key': pcKey });
    assert.equal(big.status, 400);
    assert.match(big.body.error, /17 MB/);
    const old = await call(null, 'POST', '/artwork/export/start', { file_name: 'PCS-W109-R0.cdr', size_bytes: 4, sha256: 'c'.repeat(64) }, { 'x-artwork-key': pcKey });
    await call(null, 'PUT', `/artwork/export/${old.body.upload}/chunk/0`, Buffer.from('abcd'), { 'x-artwork-key': pcKey, 'content-type': 'application/octet-stream' });
    await db.q(`UPDATE artwork_uploads SET created_at = now() - interval '2 days' WHERE token = $1`, [old.body.upload]);
    await call(null, 'POST', '/artwork/export/start', { file_name: 'PCS-W109-R0.cdr', size_bytes: 4, sha256: 'd'.repeat(64) }, { 'x-artwork-key': pcKey });
    const u = await db.one(`SELECT id, status FROM artwork_uploads WHERE token = $1`, [old.body.upload]);
    assert.equal(u.status, 'failed');
    assert.equal((await db.one(`SELECT count(*)::int AS n FROM artwork_upload_chunks WHERE upload_id = $1`, [u.id])).n, 0);
  });

  // ── second review (18 Nov): several items in one thread, Gmail's own sends, revisions ─────────────────────────
  const two = async (id, a, b) => {
    await fileMails([mailOf(id, [{ client_item_code: a, client_rev: 'R0', files: [f(`${a}-R0.cdr`, `${id}-a`)] },
      { client_item_code: b, client_rev: 'R0', files: [f(`${b}-R0.cdr`, `${id}-b`)] }], { received_at: new Date().toISOString() })]);
    await sync();
    for (const c of [a, b]) assert.equal((await upload({ name: `${c}-R0 - ITEM.cdr`, bytes: await exportPdf() })).body.matched, true);
    return [await version(a), await version(b)];
  };
  const sendNow = async pmId => (await call('artist', 'POST', '/artwork/register/send-email', { proof_mail_ids: [pmId] })).body;

  test('CI Plant\'s own sent approval mail is never taken for a hand proof; the other item in the thread keeps its place', async () => {
    const [carton, label] = await two('w-201', 'PCS-W201', 'PML-W202');
    const d1 = await draftOf(carton.id);
    assert.equal((await sendNow(d1.proof_mail_id)).sent.length, 1);
    const pm = await pmOf(d1.proof_mail_id);
    const proof = await db.one('SELECT proof_no FROM artwork_proofs WHERE proof_mail_id = $1', [pm.id]);
    // the robot sees mppchd's sent mail in the thread, with the proof attached, and files it as a proof sent by hand
    await fileMails([mailOf(pm.gmail_message_id, [{ files: [f(`${proof.proof_no}.pdf`, 'own-1')] }], { kind: 'proof_by_hand', gmail_thread_id: 't-w-201', from_email: BIZ, received_at: new Date().toISOString() })]);
    await sync();
    assert.equal((await version('PML-W202')).stage, 'designer_file', 'the label is still waiting for its own proof');
    assert.equal((await db.one('SELECT count(*)::int AS n FROM artwork_proofs WHERE by_hand AND version_id = ANY($1)', [[carton.id, label.id]])).n, 0);
    // the label's draft is edited and sent from Gmail itself (CI Plant never learns the message id): the robot's report of
    // that mail, carrying the proof file, records CI Plant's draft as sent — not a second "hand proof"
    const d2 = await draftOf(label.id);
    const p2 = await db.one('SELECT proof_no FROM artwork_proofs WHERE proof_mail_id = $1', [d2.proof_mail_id]);
    G.drafts.delete((await pmOf(d2.proof_mail_id)).gmail_draft_id);
    await fileMails([mailOf('gm-edited-1', [{ files: [f(`${p2.proof_no}.pdf`, 'own-2')] }], { kind: 'proof_by_hand', gmail_thread_id: 't-w-201', from_email: BIZ, received_at: new Date().toISOString() })]);
    await sync();
    assert.equal((await pmOf(d2.proof_mail_id)).status, 'sent');
    assert.equal((await version('PML-W202')).stage, 'approval_sent');
    assert.equal((await db.one('SELECT count(*)::int AS n FROM artwork_proofs WHERE by_hand AND version_id = $1', [label.id])).n, 0);
  });

  test('when one mail of several items is cancelled, the other items go back to "designer file in"; a put-back version too', async () => {
    const [a, b] = await two('w-203', 'PCS-W203', 'PML-W204');
    const d = (await call('artist', 'POST', '/artwork/register/send-for-approval', { version_ids: [a.id, b.id] })).body.drafts[0];
    assert.deepEqual(d.versions.sort(), [a.id, b.id].sort());
    await call('artist', 'POST', '/artwork/register/delete', { version_ids: [a.id], reason: 'sent to us twice' });
    assert.equal((await pmOf(d.proof_mail_id)).status, 'cancelled');
    assert.equal((await version('PML-W204')).stage, 'designer_file', 'not stuck at proof ready with no mail');
    await call('artist', 'POST', '/artwork/register/restore', { version_ids: [a.id] });
    assert.equal((await db.one('SELECT stage FROM artwork_versions WHERE id = $1', [a.id])).stage, 'designer_file');
  });

  test('a draft thrown away in Gmail is not taken for sent because some other mppchd mail is in the thread', async () => {
    const v = await ready('w-205', 'PCS-W205', 'R0', { received_at: new Date().toISOString() });
    const dr = await draftOf(v.id);
    const pm = await pmOf(dr.proof_mail_id);
    G.drafts.delete(pm.gmail_draft_id);                    // discarded in Gmail
    G.threads.set(pm.gmail_thread_id, [{ id: 'quote-1', labelIds: ['SENT'], internalDate: String(Date.now()), payload: { headers: [] } }]);
    await db.q(`UPDATE artwork_proof_mails SET created_at = now() - interval '5 minutes' WHERE id = $1`, [pm.id]);
    await settle();
    const after = await pmOf(pm.id);
    assert.equal(after.status, 'draft');
    assert.match(after.error, /no longer in Gmail and was not sent/);
    const res = await sendNow(pm.id);
    assert.equal(res.sent.length, 0);
    assert.match(res.skipped[0].why, /no longer in Gmail/);
  });

  test('a reply after a revision answers the newest version only; approval after "changes asked" goes to a person', async () => {
    const r0 = await ready('w-207', 'PCS-W207', 'R0', { received_at: new Date(Date.now() - 3600e3).toISOString() });
    await sendNow((await draftOf(r0.id)).proof_mail_id);
    G.threadOf.set('w-207b', 't-w-207');                   // Gmail keeps the client's revision in the same thread
    await fileMails([mailOf('w-207b', [{ client_item_code: 'PCS-W207', client_rev: 'R1', files: [f('PCS-W207-R1.cdr', 'w207b')] }], { gmail_thread_id: 't-w-207', received_at: new Date().toISOString() })]);
    await sync();
    assert.equal((await upload({ name: 'PCS-W207-R1 - ITEM.cdr', bytes: await exportPdf() })).body.matched, true);
    const r1 = await version('PCS-W207');
    assert.notEqual(r1.id, r0.id);
    await sendNow((await draftOf(r1.id)).proof_mail_id);
    await fileMails([mailOf('w-207r', [{ verdict: 'approval', proof_nos: [] }], { kind: 'reply', gmail_thread_id: 't-w-207', received_at: new Date(Date.now() + 1000).toISOString() })]);
    await sync();
    assert.equal((await db.one('SELECT stage FROM artwork_versions WHERE id = $1', [r1.id])).stage, 'approved', 'the newest version, the one waiting');
    assert.equal((await db.one('SELECT stage FROM artwork_versions WHERE id = $1', [r0.id])).stage, 'changes', 'the replaced one is not touched');
    // changes asked, then a bare "approved": a person decides
    const v = await ready('w-208', 'PCS-W208', 'R0', { received_at: new Date().toISOString() });
    const d = await draftOf(v.id);
    await sendNow(d.proof_mail_id);
    const no = (await db.one('SELECT proof_no FROM artwork_proofs WHERE proof_mail_id = $1', [d.proof_mail_id])).proof_no;
    await fileMails([mailOf('w-208r1', [{ verdict: 'changes', proof_nos: [no], remarks: 'logo bigger' }], { kind: 'reply', gmail_thread_id: 't-w-208', received_at: new Date(Date.now() + 1000).toISOString() })]);
    await sync();
    assert.equal((await version('PCS-W208')).stage, 'changes');
    await fileMails([mailOf('w-208r2', [{ verdict: 'approval', proof_nos: [] }], { kind: 'reply', gmail_thread_id: 't-w-208', received_at: new Date(Date.now() + 2000).toISOString() })]);
    await sync();
    assert.equal((await version('PCS-W208')).stage, 'to_confirm');
  });

  test('a newer version marked "not artwork" does not take the buttons from the real one; marking a version not artwork cancels its draft', async () => {
    const v = await ready('w-209', 'PCS-W209', 'R0', { received_at: new Date().toISOString() });
    await fileMails([mailOf('w-209b', [{ client_item_code: 'PCS-W209', client_rev: 'R1', files: [f('x.pdf', 'w209b')] }], { received_at: new Date().toISOString() })]);
    await sync();
    const junk = await version('PCS-W209');
    await call('artist', 'POST', `/artwork/register/versions/${junk.id}/not-artwork`, { reason: 'a PO, not artwork' });
    const win = (await call('artist', 'GET', `/artwork/register/${v.job_id}`)).body.versions.find(x => x.id === v.id);
    assert.deepEqual(win.actions, ['send_for_approval']);
    const d = await draftOf(v.id);
    assert.ok(d, 'Send for approval works on the real version');
    await call('artist', 'POST', `/artwork/register/versions/${v.id}/not-artwork`, { reason: 'filed by mistake' });
    assert.equal((await pmOf(d.proof_mail_id)).status, 'cancelled');
    assert.equal((await sendNow(d.proof_mail_id)).sent.length, 0);
  });

  test('the copier files one row at a time across callers, so a reply is never read before the proof it answers', async () => {
    const pg = await import('pg');
    const other = new pg.default.Client({ connectionString: process.env.DATABASE_URL });
    await other.connect();
    try {
      await fileMails([mailOf('w-210', [{ client_item_code: 'PCS-W210', client_rev: 'R0', files: [f('PCS-W210-R0.cdr', 'w210')] }], { received_at: new Date().toISOString() })]);
      await other.query('SELECT pg_advisory_lock(727100)');        // another caller is filing right now
      const busy = await sync();
      assert.equal(busy.filed.length, 0, 'waits for the other caller');
      await other.query('SELECT pg_advisory_unlock(727100)');
      const done = await sync();
      assert.equal(done.filed.length, 1);
    } finally { await other.end(); }
  });

  test('approval ticks lines of a draft PO too; a PDF upload whose version moved on before it finished is refused', async () => {
    const [, , p3] = await db.q(`SELECT id FROM products ORDER BY id LIMIT 3`);
    const v = await ready('w-211', 'PCS-W211', 'R0', { received_at: new Date().toISOString() });
    await call('artist', 'POST', `/artwork/register/${v.job_id}/map`, { product_id: p3.id });
    const cust = await db.one(`SELECT id FROM customers ORDER BY id LIMIT 1`);
    const order = await db.one(`INSERT INTO orders (po_number, customer_id, po_date, status) VALUES ('PO-W3', $1, '2026-11-18', 'draft') RETURNING id`, [cust.id]);
    const line = await db.one(`INSERT INTO order_lines (order_id, product_id, qty, rate, status) VALUES ($1, $2, 100, 1, 'draft') RETURNING id`, [order.id, p3.id]);
    await sendNow((await draftOf(v.id)).proof_mail_id);
    await call('artist', 'POST', '/artwork/register/decide', { version_ids: [v.id], verdict: 'approved', note: 'approved on the phone' });
    assert.equal((await db.one('SELECT artwork_customer_ok FROM order_lines WHERE id = $1', [line.id])).artwork_customer_ok, 1);
    // an upload started while the version was open, finished after it went for approval
    const w = await ready('w-212', 'PCS-W212', 'R0', { received_at: new Date().toISOString() });
    const bytes = await exportPdf();
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    const st = await call('artist', 'POST', `/artwork/register/versions/${w.id}/export/start`, { file_name: 'late.pdf', size_bytes: bytes.length, sha256: sha });
    assert.equal(st.status, 200);
    await call('artist', 'PUT', `/artwork/register/export/${st.body.upload}/chunk/0`, bytes, { 'content-type': 'application/octet-stream' });
    await draftOf(w.id);                                    // now proof ready
    const fin = await call('artist', 'POST', `/artwork/register/export/${st.body.upload}/finish`, {});
    assert.equal(fin.status, 409);
    assert.match(fin.body.error, /proof waiting|approval/);
  });

  // ── the whole mail thread in the window (owner, 18 Nov 2026: "the whole trail, the thread, should all be visible") ──
  test('the window shows the whole mail thread, read live from Gmail; files open only from artwork threads', async () => {
    const b64 = t => Buffer.from(t, 'utf8').toString('base64url');
    const msg = (id, at, from, text, extra = {}) => ({ id, internalDate: String(Date.parse(at)), labelIds: extra.labels || ['INBOX'],
      payload: { mimeType: extra.parts ? 'multipart/mixed' : 'text/plain', headers: [{ name: 'From', value: from }, { name: 'To', value: BIZ }, { name: 'Subject', value: 'RE: W301 KIT' }],
        ...(extra.parts ? { parts: [{ mimeType: 'text/plain', body: { data: b64(text) } }, ...extra.parts] } : { body: { data: b64(text) } }) } });
    await fileMails([mailOf('w-301', [{ client_item_code: 'PCS-W301', client_rev: 'R0', files: [f('PCS-W301-R0.cdr', 'w301')] }], { received_at: '2026-11-18T05:00:00Z', body_text: 'Please find the artwork.' })]);
    await sync();
    const v = await version('PCS-W301');
    G.fullThreads.set('t-w-301', { id: 't-w-301', messages: [
      msg('tm-3', '2026-11-18T05:42:00Z', `Care <care@example-pharma.test>`, 'Approved, please go ahead.'),
      msg('w-301', '2026-11-18T05:00:00Z', `Asha Rao <${CLIENT}>`, 'Please find the artwork.'),
      msg('tm-2', '2026-11-18T05:40:00Z', `Office <${BIZ}>`, 'Please Provide Approval,', { labels: ['SENT'],
        parts: [{ mimeType: 'application/pdf', filename: 'PRF-W301.pdf', body: { attachmentId: 'att-1', size: 15 } }] }),
    ] });
    G.attachments.set('tm-2/att-1', Buffer.from('%PDF-1.4 proof'));
    G.threadOf.set('tm-2', 't-w-301');
    const res = await call('artist', 'GET', `/artwork/register/${v.job_id}/thread`);
    assert.equal(res.status, 200);
    assert.equal(res.body.available, true);
    assert.deepEqual(res.body.messages.map(m => m.id), ['w-301', 'tm-2', 'tm-3'], 'the whole trail, oldest first');
    assert.deepEqual(res.body.messages.map(m => m.ours), [false, true, false]);
    assert.equal((await call('admin', 'GET', '/costing/enquiry-desk')).body.mailboxes.find(b => b.key === 'business').gmail.can_read, true);
    assert.equal(res.body.messages[2].text, 'Approved, please go ahead.');
    assert.equal(res.body.messages[1].attachments[0].name, 'PRF-W301.pdf');
    const open = (q, who = 'artist') => fetch(`${base}/artwork/register/thread-attachment?${q}`, { headers: { authorization: `Bearer ${tokens[who]}` } });
    const a = await open('message=tm-2&attachment=att-1&name=PRF-W301.pdf');
    assert.equal(a.status, 200);
    assert.match(a.headers.get('content-disposition'), /PRF-W301\.pdf/);
    assert.equal(a.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(Buffer.from(await a.arrayBuffer()).toString(), '%PDF-1.4 proof');
    // a message outside the artwork threads is never read through CI Plant
    G.threadOf.set('private-1', 't-private');
    G.attachments.set('private-1/att-2', Buffer.from('not artwork'));
    assert.equal((await open('message=private-1&attachment=att-2')).status, 404);
    assert.equal((await open('message=tm-2&attachment=att-1', 'plain')).status, 403);
    assert.equal((await call('plain', 'GET', `/artwork/register/${v.job_id}/thread`)).status, 403);
    // the job window carries the text the robot filed, for when Gmail cannot be read
    const win = (await call('artist', 'GET', `/artwork/register/${v.job_id}`)).body;
    assert.equal(win.versions[0].mails[0].body_text, 'Please find the artwork.');
    // a connection without the read permission: the window says what to do
    const scope = (await db.one(`SELECT scope FROM gmail_links WHERE mailbox = 'business'`)).scope;
    await db.q(`UPDATE gmail_links SET scope = $1 WHERE mailbox = 'business'`, ['https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.metadata https://www.googleapis.com/auth/drive.file']);
    const old = await call('artist', 'GET', `/artwork/register/${v.job_id}/thread`);
    assert.equal(old.body.available, false);
    assert.match(old.body.why, /Connect Gmail again/);
    // the desk settings say so too, so an admin can connect again (the scope list itself is not handed out)
    const desk = (await call('admin', 'GET', '/costing/enquiry-desk')).body.mailboxes.find(b => b.key === 'business').gmail;
    assert.equal(desk.can_read, false);
    assert.equal(desk.scope, undefined);
    await db.q(`UPDATE gmail_links SET scope = $1 WHERE mailbox = 'business'`, [scope]);
  });

  // ── a product not in our masters, made from the artwork window (owner, 18 Nov 2026) ────────────────────────────
  test('a product not in our masters is made from the artwork window as a draft master, and the job is linked to it; a Fluence job gets its kit', async () => {
    const { default: jwt } = await import('jsonwebtoken');
    const { JWT_SECRET: secret } = await import('./auth.js');
    const qa = await db.one(`INSERT INTO users (name, email, password_hash, role, modules) VALUES ('Art qa', 'art-qa@test.local', 'x', 'qc', $1) RETURNING id, name, role`, [JSON.stringify(['artwork'])]);
    tokens.qa = jwt.sign({ id: qa.id, name: qa.name, role: qa.role }, secret);

    await fileMails([mailOf('w-401', [{ client_item_code: 'PCS-W401', client_rev: 'R0', product_name: 'GAMMA 10 TAB CARTON', pack_type: 'carton', files: [f('PCS-W401-R0.cdr', 'w401')] }], { received_at: new Date().toISOString() })]);
    await sync();
    const v = await version('PCS-W401');
    const preview = await call('artist', 'GET', `/artwork/register/${v.job_id}/new-product`);
    assert.equal(preview.status, 200);
    assert.equal(preview.body.name, 'GAMMA 10 TAB CARTON');
    assert.equal(preview.body.party_item_code, 'PCS-W401');
    assert.equal(preview.body.customer_name, 'Example Pharma Ltd');
    assert.equal(preview.body.fluence, false);
    assert.equal((await call('qa', 'POST', `/artwork/register/${v.job_id}/create-product`)).status, 403, 'only those who keep the product master');
    const res = await call('artist', 'POST', `/artwork/register/${v.job_id}/create-product`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const p = await db.one('SELECT * FROM products WHERE id = $1', [res.body.product.id]);
    assert.deepEqual([p.name, p.party_item_code, p.is_draft, p.spec_incomplete, p.product_type, p.draft_source],
      ['GAMMA 10 TAB CARTON', 'PCS-W401', 1, 1, 'carton', 'artwork']);
    assert.equal(p.internal_carton_code, p.code);
    assert.ok(p.code, 'the next code in the customer\'s series');
    const job = await db.one('SELECT product_id, product_name, to_sort FROM artwork_jobs WHERE id = $1', [v.job_id]);
    assert.deepEqual([job.product_id, job.to_sort], [p.id, false]);
    assert.ok(await db.one(`SELECT 1 AS y FROM artwork_events WHERE job_id = $1 AND action = 'product_created'`, [v.job_id]));
    assert.equal((await call('artist', 'POST', `/artwork/register/${v.job_id}/create-product`)).status, 409, 'already linked');
    // the same item code for that customer again: refused, naming the master that exists
    await fileMails([mailOf('w-402', [{ client_item_code: 'PCS-W401', product_name: 'GAMMA 10 TAB CARTON NEW', files: [f('x402.cdr', 'w402')] }], { received_at: new Date().toISOString(), customer_name: 'Example Pharma Ltd' })]);
    await sync();
    const dupJob = await db.one(`SELECT id FROM artwork_jobs WHERE product_id IS NULL AND client_item_code = 'PCS-W401'`).catch(() => null);
    if (dupJob) {
      const dup = await call('artist', 'POST', `/artwork/register/${dupJob.id}/create-product`);
      assert.equal(dup.status, 409);
      assert.match(dup.body.error, new RegExp(p.code));
    }
    // a master that already has this name for the customer: refused, naming it
    const cust = await db.one(`SELECT id FROM customers WHERE name = 'Example Pharma Ltd'`);
    const board = await db.one(`SELECT id FROM materials WHERE category = 'board' ORDER BY id LIMIT 1`);
    const omega = await db.one(`INSERT INTO products (customer_id, name, code, board_material_id) VALUES ($1, 'OMEGA 5 CARTON', 'EPL-T905', $2) RETURNING code`, [cust.id, board.id]);
    await fileMails([mailOf('w-405', [{ client_item_code: 'PCS-W405', product_name: 'Omega 5 Carton', files: [f('x405.cdr', 'w405')] }], { received_at: new Date().toISOString() })]);
    await sync();
    const o = await version('PCS-W405');
    const pv = await call('artist', 'GET', `/artwork/register/${o.job_id}/new-product`);
    assert.deepEqual(pv.body.existing.map(x => x.code), [omega.code]);
    const od = await call('artist', 'POST', `/artwork/register/${o.job_id}/create-product`);
    assert.equal(od.status, 409);
    assert.match(od.body.error, /EPL-T905 OMEGA 5 CARTON is already in the masters/);
    // a customer not in the master: said, nothing made
    await fileMails([mailOf('w-403', [{ client_item_code: 'PCS-W403', product_name: 'DELTA', files: [f('x403.cdr', 'w403')] }], { received_at: new Date().toISOString(), customer_name: 'Nobody Pharma', from_email: 'x@nobody.test' })]);
    await sync();
    const nobody = await version('PCS-W403');
    const r403 = await call('artist', 'POST', `/artwork/register/${nobody.job_id}/create-product`);
    assert.equal(r403.status, 409);
    assert.match(r403.body.error, /not in the customer master/);
    // Fluence: the kit record too
    const fl = await db.one(`INSERT INTO customers (name, segment) VALUES ('Fluence Test Pharma', 'pharma') RETURNING id`);
    await db.q('INSERT INTO fluence_customers (customer_id) VALUES ($1) ON CONFLICT DO NOTHING', [fl.id]);
    await fileMails([mailOf('w-404', [{ product_name: 'Zeta Glow Kit-Q', pack_type: 'carton', files: [f('Zeta Glow Kit-Q.cdr', 'w404')] }], { received_at: new Date().toISOString(), customer_name: 'Fluence Test Pharma', from_email: 'graphics@fluence.test' })]);
    await sync();
    const z = await db.one(`SELECT id FROM artwork_jobs WHERE product_name = 'Zeta Glow Kit-Q'`);
    assert.equal((await call('artist', 'GET', `/artwork/register/${z.id}/new-product`)).body.fluence, true);
    const zr = await call('artist', 'POST', `/artwork/register/${z.id}/create-product`);
    assert.equal(zr.status, 200, JSON.stringify(zr.body));
    const kit = await db.one('SELECT * FROM fluence_kits WHERE product_id = $1', [zr.body.product.id]);
    assert.deepEqual([kit.kit_name, kit.source_ref, kit.link_method], ['Zeta Glow Kit-Q', `erp-product:${zr.body.product.id}`, 'created_from_product']);
    assert.equal(zr.body.fluence_kit_id, kit.id);
  });

  // ── Fluence: prescriptions, MRPs and new kits read from Fluence's mails (18 Nov 2026) ─────────────────────────
  const fx = {};
  const fluenceSetup = async () => {
    if (fx.kit) return fx;
    const { default: jwt } = await import('jsonwebtoken');
    const { JWT_SECRET: secret } = await import('./auth.js');
    const boss = await db.one(`INSERT INTO users (name, email, password_hash, role, is_management) VALUES ('Art boss', 'art-boss@test.local', 'x', 'planner', 1) RETURNING id, name, role`);
    tokens.boss = jwt.sign({ id: boss.id, name: boss.name, role: boss.role }, secret);
    const cust = await db.one(`SELECT id FROM customers WHERE name = 'Fluence Test Pharma'`).catch(() => null)
      || await db.one(`INSERT INTO customers (name, segment) VALUES ('Fluence Test Pharma', 'pharma') RETURNING id`);
    await db.q('INSERT INTO fluence_customers (customer_id) VALUES ($1) ON CONFLICT DO NOTHING', [cust.id]);
    const board = await db.one(`SELECT id FROM materials WHERE category = 'board' ORDER BY id LIMIT 1`);
    const prod = await db.one(`INSERT INTO products (customer_id, name, code, board_material_id, mrp) VALUES ($1, 'NOVA CALM KIT', 'FPT-501', $2, 1000) RETURNING id, code`, [cust.id, board.id]);
    const caps = await db.one(`INSERT INTO fluence_inner_products (name, name_key, kind) VALUES ('F-NOVA CAPS', 'FNOVACAPS', 'item') RETURNING id`);
    const syrup = await db.one(`INSERT INTO fluence_inner_products (name, name_key, kind) VALUES ('F-CALM SYRUP', 'FCALMSYRUP', 'item') RETURNING id`);
    const kit = await db.one(`INSERT INTO fluence_kits (kit_name, source_ref, product_id, kit_total_mrp) VALUES ('NOVA CALM KIT', 'test:nova', $1, 1000) RETURNING id`, [prod.id]);
    await db.q(`INSERT INTO fluence_kit_components (kit_id, inner_product_id, sr, qty_per_kit, mrp_in_kit) VALUES ($1, $2, 1, 2, 600), ($1, $3, 2, 1, 400)`, [kit.id, caps.id, syrup.id]);
    const rx = await db.one(`INSERT INTO fluence_prescriptions (kit_id, general_instructions, revision) VALUES ($1, 'Old advice', 1) RETURNING id`, [kit.id]);
    await db.q(`INSERT INTO fluence_prescription_lines (prescription_id, sr, inner_product_id, dosage, morning_qty) VALUES ($1, 1, $2, '1 cap', 1), ($1, 2, $3, '5 ml', NULL)`, [rx.id, caps.id, syrup.id]);
    Object.assign(fx, { cust: cust.id, prod: prod.id, kit: kit.id, caps: caps.id, syrup: syrup.id });
    return fx;
  };
  const fileFluence = (id, items, over = {}) => fileMails([{ mailbox_email: BIZ, kind: 'fluence', gmail_message_id: id, gmail_thread_id: `t-${id}`,
    subject: `Fluence ${id}`, from_email: 'dispatch@fluence.test', received_at: new Date().toISOString(), items, ...over }]);
  const reading = id => db.one(`SELECT r.* FROM fluence_mail_readings r WHERE r.gmail_message_id = $1 ORDER BY r.id DESC LIMIT 1`, [id]);
  const kitNow = async () => ({
    total: Number((await db.one('SELECT kit_total_mrp FROM fluence_kits WHERE id = $1', [fx.kit])).kit_total_mrp),
    carton: Number((await db.one('SELECT mrp FROM products WHERE id = $1', [fx.prod])).mrp),
    items: (await db.q('SELECT inner_product_id, mrp_in_kit::float8 AS mrp FROM fluence_kit_components WHERE kit_id = $1 ORDER BY sr', [fx.kit])).map(c => [c.inner_product_id, c.mrp]),
    rev: (await db.one('SELECT revision FROM fluence_prescriptions WHERE kit_id = $1', [fx.kit])).revision,
  });

  test('Fluence MRP sheet: new MRPs are saved to the kit and the carton, signed from the mail, and wait for management', async () => {
    await fluenceSetup();
    await fileFluence('fm-1', [{ source: 'mrp_sheet', kit_code: 'FPT-501', kit_name: 'NOVA CALM KIT', sure: true,
      mrp: { kit_total: 1100, items: [{ item: 'F-NOVA CAPS', mrp: 660 }, { item: 'F-CALM SYRUP', mrp: 440 }] } }]);
    await sync();
    const r = await reading('fm-1');
    assert.equal(r.status, 'saved', r.hold_reason || '');
    const k = await kitNow();
    assert.deepEqual([k.total, k.carton], [1100, 1100], 'kit total and the carton\'s yellow MRP');
    assert.deepEqual(k.items, [[fx.caps, 660], [fx.syrup, 440]]);
    assert.equal(k.rev, 1, 'a sheet never touches the prescription');
    const mc = await db.q(`SELECT subject, outside, ack_at, changed_from FROM fluence_mrp_changes WHERE kit_id = $1 ORDER BY id`, [fx.kit]);
    assert.ok(mc.length >= 3 && mc.every(x => x.outside === 1 && !x.ack_at && x.changed_from === 'fluence_mail'));
    assert.ok(mc.some(x => x.subject === 'kit_total'));
  });

  test('Fluence: an MRP more than 25 % lower is held; a PO is only compared; a sheet line with no kit is not matched; unsure is held', async () => {
    await fluenceSetup();
    await fileFluence('fm-2', [{ source: 'mrp_sheet', kit_code: 'FPT-501', sure: true, mrp: { kit_total: 700, items: [] } }]);
    await fileFluence('fm-3', [{ source: 'po', kit_code: 'FPT-501', sure: true, mrp: { kit_total: 1050, items: [] } }]);
    await fileFluence('fm-4', [{ source: 'mrp_sheet', kit_name: 'NO SUCH KIT', sure: true, mrp: { kit_total: 500, items: [] } }]);
    await fileFluence('fm-5', [{ source: 'mrp_sheet', kit_code: 'FPT-501', sure: false, unsure: ['mrp.kit_total'], mrp: { kit_total: 1150, items: [] } }]);
    await sync();
    const held = await reading('fm-2');
    assert.equal(held.status, 'held');
    assert.match(held.hold_reason, /kit MRP 1100 → 700 is more than 25 % lower/);
    assert.equal((await reading('fm-3')).status, 'compared');
    assert.equal((await reading('fm-4')).status, 'not_matched');
    assert.equal((await reading('fm-5')).status, 'held');
    assert.equal((await kitNow()).total, 1100, 'nothing of these reached the master');
    // a person applies the held one
    assert.equal((await call('plain', 'POST', `/fluence/mail-readings/${held.id}/apply`)).status, 403);
    const ap = await call('artist', 'POST', `/fluence/mail-readings/${held.id}/apply`);
    assert.equal(ap.status, 200, JSON.stringify(ap.body));
    assert.equal((await kitNow()).total, 700);
    assert.equal((await reading('fm-2')).status, 'saved');
  });

  test('Fluence: a mail never undoes a person\'s later change', async () => {
    await fluenceSetup();
    await db.q(`INSERT INTO fluence_master_revisions (kit_id, area, note, changed_by, changed_from, changed_at) VALUES ($1, 'components', 'fixed by hand', 'Anik', 'fluence_master', now())`, [fx.kit]);
    await fileFluence('fm-6', [{ source: 'mrp_sheet', kit_code: 'FPT-501', sure: true, mrp: { kit_total: 720, items: [] } }], { received_at: new Date(Date.now() - 86400e3).toISOString() });
    await sync();
    const r = await reading('fm-6');
    assert.equal(r.status, 'held');
    assert.match(r.hold_reason, /changed by Anik after this mail/);
  });

  test('Fluence artwork: the prescription is read with the version and saved only when the client approves it', async () => {
    await fluenceSetup();
    await fileMails([mailOf('fa-1', [{ product_name: 'NOVA CALM KIT', pack_type: 'carton', files: [f('NOVA CALM KIT.cdr', 'fa1')] }], { customer_name: 'Fluence Test Pharma', from_email: 'graphics@fluence.test', received_at: new Date().toISOString() })]);
    await sync();
    const job = await db.one(`SELECT id FROM artwork_jobs WHERE product_name = 'NOVA CALM KIT' ORDER BY id DESC LIMIT 1`);
    await call('artist', 'POST', `/artwork/register/${job.id}/map`, { product_id: fx.prod });
    await fileFluence('fa-1r', [{ source: 'artwork', kit_name: 'NOVA CALM KIT', read_from: 'NOVA CALM KIT proof.pdf', sure: true,
      prescription: { general_instructions: 'Take after breakfast.', lines: [{ item: 'F-NOVA CAPS', dosage: '2 caps', morning: 2 }, { item: 'F-CALM SYRUP', dosage: '10 ml', night: 1 }] },
      mrp: { kit_total: 720, items: [] } }], { gmail_thread_id: 't-fa-1', from_email: 'graphics@fluence.test' });
    await sync();
    const r = await reading('fa-1r');
    assert.equal(r.status, 'waiting_approval');
    assert.ok(r.artwork_version_id);
    const before = await kitNow();
    // approved (by hand here; a client's reply does the same)
    await db.q(`UPDATE artwork_versions SET stage = 'approval_sent' WHERE id = $1`, [r.artwork_version_id]);
    const d = await call('artist', 'POST', '/artwork/register/decide', { version_ids: [r.artwork_version_id], verdict: 'approved', note: 'approved on WhatsApp' });
    assert.deepEqual(d.body.moved, [r.artwork_version_id]);
    const after = await kitNow();
    assert.equal(after.rev, before.rev + 1, 'a new prescription revision');
    const rx = await db.one(`SELECT general_instructions, updated_from FROM fluence_prescriptions WHERE kit_id = $1`, [fx.kit]);
    assert.deepEqual([rx.general_instructions, rx.updated_from], ['Take after breakfast.', 'fluence_mail']);
    const lines = await db.q(`SELECT inner_product_id, dosage, morning_qty::float8 AS m, night_qty::float8 AS n FROM fluence_prescription_lines l JOIN fluence_prescriptions p ON p.id = l.prescription_id WHERE p.kit_id = $1 ORDER BY l.sr`, [fx.kit]);
    assert.deepEqual(lines.map(l => [l.inner_product_id, l.dosage, l.m, l.n]), [[fx.caps, '2 caps', 2, null], [fx.syrup, '10 ml', null, 1]]);
    assert.equal((await reading('fa-1r')).status, 'saved');
    // undo puts it back
    const u = await call('artist', 'POST', `/fluence/mail-readings/${r.id}/undo`);
    assert.equal(u.status, 200, JSON.stringify(u.body));
    assert.equal((await db.one(`SELECT general_instructions FROM fluence_prescriptions WHERE kit_id = $1`, [fx.kit])).general_instructions, 'Old advice');
    assert.equal((await kitNow()).total, before.total);
    assert.equal((await reading('fa-1r')).status, 'undone');
  });

  test('Fluence artwork for a kit not in our masters: on approval its masters are made by themselves; management acknowledges', async () => {
    await fluenceSetup();
    await fileMails([mailOf('fa-2', [{ product_name: 'ORBIT REST KIT-Q', pack_type: 'carton', files: [f('ORBIT REST KIT-Q.cdr', 'fa2')] }], { customer_name: 'Fluence Test Pharma', from_email: 'graphics@fluence.test', received_at: new Date().toISOString() })]);
    await sync();
    await fileFluence('fa-2r', [{ source: 'artwork', kit_name: 'ORBIT REST KIT-Q', sure: true,
      prescription: { general_instructions: 'Use daily.', lines: [{ item: 'F-NOVA CAPS', dosage: '1 cap', morning: 1 }, { item: 'F-ORBIT BALM', dosage: 'thin layer', night: 1 }] },
      mrp: { kit_total: 950, items: [{ item: 'F-NOVA CAPS', mrp: 500 }, { item: 'F-ORBIT BALM', mrp: 450 }] } }], { gmail_thread_id: 't-fa-2', from_email: 'graphics@fluence.test' });
    await sync();
    const r0 = await reading('fa-2r');
    assert.equal(r0.status, 'waiting_approval');
    await db.q(`UPDATE artwork_versions SET stage = 'approval_sent' WHERE id = $1`, [r0.artwork_version_id]);
    await call('artist', 'POST', '/artwork/register/decide', { version_ids: [r0.artwork_version_id], verdict: 'approved', note: 'approved in mail' });
    const r = await reading('fa-2r');
    assert.equal(r.status, 'saved', r.hold_reason || '');
    const p = await db.one('SELECT id, name, is_draft, draft_source, mrp::float8 AS mrp, customer_id FROM products WHERE id = $1', [r.created_product_id]);
    assert.deepEqual([p.name, p.is_draft, p.draft_source, p.mrp, p.customer_id], ['ORBIT REST KIT-Q', 1, 'fluence_mail', 950, fx.cust]);
    const kit = await db.one('SELECT id, product_id FROM fluence_kits WHERE id = $1', [r.created_kit_id]);
    assert.equal(kit.product_id, p.id);
    const comps = await db.q(`SELECT ip.name FROM fluence_kit_components c JOIN fluence_inner_products ip ON ip.id = c.inner_product_id WHERE c.kit_id = $1 ORDER BY c.sr`, [kit.id]);
    assert.deepEqual(comps.map(c => c.name), ['F-NOVA CAPS', 'F-ORBIT BALM'], 'a new item is added to the inner products');
    const job = await db.one(`SELECT product_id FROM artwork_jobs WHERE product_name = 'ORBIT REST KIT-Q'`);
    assert.equal(job.product_id, p.id, 'the artwork job is linked to its new master');
    // the tab: who may see and acknowledge
    const list = await call('boss', 'GET', '/fluence/mail-readings');
    assert.equal(list.status, 200);
    assert.ok(list.body.rows.some(x => x.id === r.id && x.created_product_code));
    assert.equal((await call('artist', 'POST', `/fluence/mail-readings/${r.id}/ack`)).status, 403, 'acknowledged by management');
    assert.equal((await call('boss', 'POST', `/fluence/mail-readings/${r.id}/ack`)).status, 200);
    assert.ok((await reading('fa-2r')).ack_at);
    assert.equal((await db.one(`SELECT count(*)::int AS n FROM fluence_mrp_changes WHERE kit_id = $1 AND ack_at IS NULL AND outside = 1`, [kit.id])).n, 0, 'its MRP updates acknowledged with it');
  });

  // ── Fluence mail: the review of 18 Nov 2026. Each test its own invented kit. ──────────────────────────────────
  let kitSeq = 0;
  const makeKit = async ({ name, total = 1000, carton = total, comps } = {}) => {
    await fluenceSetup();
    const { nameKey } = await import('../../client/src/lib/fluence.js');
    const n = ++kitSeq;
    const kitName = name || `REVIEW KIT ${n}`;
    const code = `RVK-${String(n).padStart(3, '0')}`;   // not the FP- series new kits are numbered in
    const board = await db.one(`SELECT id FROM materials WHERE category = 'board' ORDER BY id LIMIT 1`);
    const prod = await db.one(`INSERT INTO products (customer_id, name, code, board_material_id, mrp) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [fx.cust, kitName, code, board.id, carton]);
    const kit = await db.one(`INSERT INTO fluence_kits (kit_name, source_ref, product_id, kit_total_mrp) VALUES ($1, $2, $3, $4) RETURNING id`, [kitName, `test:review-${n}`, prod.id, total]);
    const inner = {};
    for (const [i, [nm, qty, mrp, kind]] of comps.entries()) {
      const ip = await db.one(`INSERT INTO fluence_inner_products (name, name_key, kind) VALUES ($1, $2, $3) RETURNING id`, [nm, nameKey(nm), kind]);
      inner[nm] = ip.id;
      await db.q(`INSERT INTO fluence_kit_components (kit_id, inner_product_id, sr, qty_per_kit, mrp_in_kit) VALUES ($1, $2, $3, $4, $5)`, [kit.id, ip.id, i + 1, qty, mrp]);
    }
    const rx = await db.one(`INSERT INTO fluence_prescriptions (kit_id, general_instructions, remarks, revision) VALUES ($1, 'Old advice', 'rx remark', 1) RETURNING id`, [kit.id]);
    let sr = 0;
    for (const [nm, , , kind] of comps) {
      await db.q(`INSERT INTO fluence_prescription_lines (prescription_id, sr, inner_product_id, dosage, dose_form, morning_qty) VALUES ($1, $2, $3, $4, $5, $6)`,
        [rx.id, ++sr, inner[nm], kind === 'item' ? '1 unit' : null, kind === 'item' ? 'tablet' : null, kind === 'item' ? 1 : null]);
    }
    const now = async () => ({
      total: Number((await db.one('SELECT kit_total_mrp FROM fluence_kits WHERE id = $1', [kit.id])).kit_total_mrp),
      carton: Number((await db.one('SELECT mrp FROM products WHERE id = $1', [prod.id])).mrp),
      items: (await db.q('SELECT inner_product_id, qty_per_kit::float8 AS qty, mrp_in_kit::float8 AS mrp FROM fluence_kit_components WHERE kit_id = $1 ORDER BY sr', [kit.id])).map(c => [c.inner_product_id, c.qty, c.mrp]),
      rev: (await db.one('SELECT revision FROM fluence_prescriptions WHERE kit_id = $1', [kit.id])).revision,
      rx: await db.one('SELECT general_instructions, remarks FROM fluence_prescriptions WHERE kit_id = $1', [kit.id]),
      lines: await db.q(`SELECT l.inner_product_id, l.dosage, l.dose_form, l.morning_qty::float8 AS m, l.night_qty::float8 AS n FROM fluence_prescription_lines l
                           JOIN fluence_prescriptions p ON p.id = l.prescription_id WHERE p.kit_id = $1 ORDER BY l.sr`, [kit.id]),
    });
    return { name: kitName, code, prod: prod.id, kit: kit.id, inner, now };
  };
  // an artwork mail for a kit, its job linked to `prod` (when given), and the robot's reading of it in the same thread
  const artworkFor = async (k, tag, item, { at = new Date().toISOString() } = {}) => {
    await fileMails([mailOf(tag, [{ product_name: k.name, pack_type: 'carton', files: [f(`${k.name}.cdr`, tag)] }], { customer_name: 'Fluence Test Pharma', from_email: 'graphics@fluence.test', received_at: at })]);
    await sync();
    const job = await db.one(`SELECT id, product_id FROM artwork_jobs WHERE product_name = $1 ORDER BY id DESC LIMIT 1`, [k.name]);
    if (k.prod && !job.product_id) {
      const m = await call('artist', 'POST', `/artwork/register/${job.id}/map`, { product_id: k.prod });
      assert.equal(m.status, 200, JSON.stringify(m.body));
    }
    await fileFluence(`${tag}r`, [{ source: 'artwork', kit_name: k.name, sure: true, ...item }], { gmail_thread_id: `t-${tag}`, from_email: 'graphics@fluence.test', received_at: at });
    await sync();
    return { job, r: await reading(`${tag}r`) };
  };
  const approve = async versionId => {
    await db.q(`UPDATE artwork_versions SET stage = 'approval_sent' WHERE id = $1`, [versionId]);
    const d = await call('artist', 'POST', '/artwork/register/decide', { version_ids: [versionId], verdict: 'approved', note: 'approved in a test' });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    return d;
  };
  const tokenFor = async (key, { role = 'planner', modules = null, fluence_tabs = null } = {}) => {
    const { default: jwt } = await import('jsonwebtoken');
    const { JWT_SECRET: secret } = await import('./auth.js');
    const u = await db.one(`INSERT INTO users (name, email, password_hash, role, modules, fluence_tabs) VALUES ($1, $2, 'x', $3, $4, $5) RETURNING id, name, role`,
      [`Art ${key}`, `art-${key}@test.local`, role, modules && JSON.stringify(modules), fluence_tabs && JSON.stringify(fluence_tabs)]);
    tokens[key] = jwt.sign({ id: u.id, name: u.name, role: u.role }, secret);
    return u;
  };

  test('review C3: an approved artwork never changes what is in a kit we have — a printed item it does not hold, or an item it does not print, holds it', async () => {
    const k = await makeKit({ comps: [['F-C3A CAPS', 2, 600, 'item'], ['F-C3B GEL', 1, 400, 'item'], ['C3 INNER BOX', 1, null, 'packaging']] });
    const before = await k.now();
    const a = await artworkFor(k, 'c3-1', { prescription: { lines: [{ item: 'F-C3A CAPSULES', dosage: '2 caps', morning: 2 }, { item: 'F-C3B GEL', dosage: 'thin', night: 1 }] },
      mrp: { kit_total: 1000, items: [{ item: 'F-C3A CAPSULES', mrp: 300 }] } });
    assert.equal(a.r.status, 'waiting_approval');
    await approve(a.r.artwork_version_id);
    const held = await reading('c3-1r');
    assert.equal(held.status, 'held');
    assert.match(held.hold_reason, /printed F-C3A CAPSULES, which is not in this kit/);
    assert.match(held.hold_reason, /the kit has F-C3A CAPS, which the artwork does not print/);
    assert.deepEqual(await k.now(), before, 'nothing of it reached the kit');
    assert.equal((await db.one(`SELECT count(*)::int AS n FROM fluence_inner_products WHERE name_key = 'FC3ACAPSULES'`)).n, 0, 'no item is made for a kit we have');
    const b = await artworkFor(k, 'c3-2', { prescription: { general_instructions: 'After food.', lines: [{ item: 'F-C3A CAPS', dosage: '2 caps', morning: 2 }, { item: 'F-C3B GEL', dosage: 'thin', night: 1 }] },
      mrp: { kit_total: 1050, items: [{ item: 'F-C3A CAPS', mrp: 650 }] } });
    await approve(b.r.artwork_version_id);
    const saved = await reading('c3-2r');
    assert.equal(saved.status, 'saved', saved.hold_reason || '');
    const after = await k.now();
    assert.deepEqual(after.items.map(([id, q]) => [id, q]), before.items.map(([id, q]) => [id, q]), 'the same items and quantities — the inner box too');
    assert.equal(after.items[0][2], 650);
    assert.deepEqual([after.rx.general_instructions, after.rx.remarks], ['After food.', 'rx remark'], 'the prescription\'s remarks are kept');
    assert.deepEqual(after.lines.filter(l => l.inner_product_id === k.inner['F-C3A CAPS']).map(l => [l.dosage, l.dose_form, l.m]), [['2 caps', 'tablet', 2]],
      'what the artwork does not print (the dose form) is kept');
  });

  test('review C1: Undo puts back only what the reading wrote, where it is still as it wrote it — a later prescription and a later MRP stay', async () => {
    const k = await makeKit({ comps: [['F-C1A CAPS', 2, 600, 'item'], ['F-C1B GEL', 1, 400, 'item']] });
    await fileFluence('c1-1', [{ source: 'mrp_sheet', kit_code: k.code, sure: true, mrp: { kit_total: 1100, items: [{ item: 'F-C1A CAPS', mrp: 660 }, { item: 'F-C1B GEL', mrp: 440 }] } }]);
    await sync();
    const sheet = await reading('c1-1');
    assert.equal(sheet.status, 'saved', sheet.hold_reason || '');
    const comps = await db.q(`SELECT inner_product_id, qty_per_kit::float8 AS qty_per_kit, mrp_in_kit::float8 AS mrp_in_kit FROM fluence_kit_components WHERE kit_id = $1 ORDER BY sr`, [k.kit]);
    const put = await call('admin', 'PUT', `/fluence/products/${k.prod}/kit`, {
      components: comps.map(c => (c.inner_product_id === k.inner['F-C1B GEL'] ? { ...c, mrp_in_kit: 450 } : c)), general_instructions: 'New advice from the doctor',
      lines: [{ inner_product_id: k.inner['F-C1A CAPS'], dosage: '3 caps', morning_qty: 3 }, { inner_product_id: k.inner['F-C1B GEL'], dosage: 'thin', night_qty: 1 }] });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    const mid = await k.now();
    const u = await call('artist', 'POST', `/fluence/mail-readings/${sheet.id}/undo`);
    assert.equal(u.status, 200, JSON.stringify(u.body));
    const end = await k.now();
    assert.equal(end.rev, mid.rev, 'the prescription a person wrote after the sheet is not touched');
    assert.equal(end.rx.general_instructions, 'New advice from the doctor');
    assert.deepEqual(end.items.map(([, , m]) => m), [600, 450], 'the sheet\'s own MRP put back; the one a person set since stays');
    assert.deepEqual([end.total, end.carton], [1000, 1000], 'the kit total and the carton back as they were');
    assert.match(JSON.stringify(u.body.left), /F-C1B GEL/, 'what it left as it is, it says');
    assert.equal((await reading('c1-1')).status, 'undone');
  });

  test('review C1: a kit the mail made is not removed once its carton is no longer a draft', async () => {
    const a = await artworkFor({ name: 'C1 NEW KIT-Q' }, 'c1-new', { prescription: { lines: [{ item: 'F-C1N CAPS', dosage: '1', morning: 1 }] }, mrp: { kit_total: 300, items: [{ item: 'F-C1N CAPS', mrp: 300 }] } });
    await approve(a.r.artwork_version_id);
    const r = await reading('c1-newr');
    assert.equal(r.status, 'saved', r.hold_reason || '');
    assert.ok(r.created_kit_id);
    await db.q('UPDATE products SET is_draft = 0 WHERE id = $1', [r.created_product_id]);
    const u = await call('artist', 'POST', `/fluence/mail-readings/${r.id}/undo`);
    assert.equal(u.status, 409, JSON.stringify(u.body));
    assert.match(u.body.error, /no longer a draft/);
    assert.ok(await db.one('SELECT id FROM fluence_kits WHERE id = $1', [r.created_kit_id]), 'the kit is kept');
    assert.equal((await reading('c1-newr')).status, 'saved');
  });

  test('review C2: filing a sheet only records it; it is saved afterwards in small steps, oldest first, within a time budget', async () => {
    const ks = [];
    for (const nm of ['F-C2A CAPS', 'F-C2B CAPS', 'F-C2C CAPS']) ks.push(await makeKit({ comps: [[nm, 1, 1000, 'item']] }));
    await fileFluence('c2-1', ks.map((k, i) => ({ source: 'mrp_sheet', kit_code: k.code, sure: true, mrp: { kit_total: 1100 + i * 10, items: [] } })));
    const { syncIntakeArtwork } = await import('./artwork-intake.js');
    await syncIntakeArtwork({ fluenceBudgetMs: 0 });
    const statuses = async () => (await db.q(`SELECT status FROM fluence_mail_readings WHERE gmail_message_id = 'c2-1' ORDER BY id`)).map(x => x.status);
    assert.deepEqual(await statuses(), ['queued', 'queued', 'queued'], 'filing the mail only records what was read');
    assert.equal((await db.one(`SELECT status FROM avs.artwork_intake WHERE gmail_message_id = 'c2-1'`)).status, 'filed');
    const { applyQueuedReadings } = await import('./fluence-mail.js');
    assert.equal((await applyQueuedReadings({ budgetMs: 60000, max: 1 })).applied, 1, 'one step at a time');
    assert.deepEqual(await statuses(), ['saved', 'queued', 'queued'], 'oldest first');
    await sync();
    assert.deepEqual(await statuses(), ['saved', 'saved', 'saved']);
    assert.deepEqual(await Promise.all(ks.map(async k => (await k.now()).total)), [1100, 1110, 1120]);
  });

  test('review C2: a reading that keeps failing to save is held after a few tries, never retried for ever', async () => {
    const k = await makeKit({ comps: [['F-C2D CAPS', 1, 1000, 'item']] });
    await fileFluence('c2-2', [{ source: 'mrp_sheet', kit_code: k.code, sure: true, mrp: { kit_total: 1200, items: [] } }]);
    const { syncIntakeArtwork } = await import('./artwork-intake.js');
    await syncIntakeArtwork({ fluenceBudgetMs: 0 });
    await db.q(`UPDATE fluence_mail_readings SET attempts = 5 WHERE gmail_message_id = 'c2-2'`);
    await sync();
    const h = await reading('c2-2');
    assert.equal(h.status, 'held');
    assert.match(h.hold_reason, /could not be saved after 5 tries/);
    assert.equal((await k.now()).total, 1000);
  });

  test('review: an older mail filed after a newer one was saved never undoes the newer one', async () => {
    const k = await makeKit({ comps: [['F-OLD CAPS', 1, 1000, 'item']] });
    await fileFluence('old-2', [{ source: 'mrp_sheet', kit_code: k.code, sure: true, mrp: { kit_total: 1150, items: [] } }]);
    await sync();
    assert.equal((await reading('old-2')).status, 'saved');
    await fileFluence('old-1', [{ source: 'mrp_sheet', kit_code: k.code, sure: true, mrp: { kit_total: 1100, items: [] } }], { received_at: new Date(Date.now() - 3 * 86400e3).toISOString() });
    await sync();
    const r = await reading('old-1');
    assert.equal(r.status, 'held');
    assert.match(r.hold_reason, /a newer mail/);
    assert.equal((await k.now()).total, 1150);
  });

  test('review I1: the carton\'s own MRP counts — an edit in Masters after the mail holds it, a drop against it holds it, a PO is compared with it', async () => {
    const k = await makeKit({ total: 1000, carton: 1000, comps: [['F-I1A CAPS', 1, 1000, 'item']] });
    const mailAt = new Date(Date.now() - 86400e3).toISOString();
    const ed = await call('admin', 'PUT', `/products/${k.prod}`, { mrp: 1200 });
    assert.equal(ed.status, 200, JSON.stringify(ed.body));
    await fileFluence('i1-1', [{ source: 'mrp_sheet', kit_code: k.code, sure: true, mrp: { kit_total: 850, items: [] } }], { received_at: mailAt });
    await sync();
    const r = await reading('i1-1');
    assert.equal(r.status, 'held');
    assert.match(r.hold_reason, /carton MRP 1200 → 850 is more than 25 % lower/);
    assert.match(r.hold_reason, /changed by Art admin after this mail/);
    assert.equal((await k.now()).carton, 1200);
    await fileFluence('i1-2', [{ source: 'po', kit_code: k.code, sure: true, mrp: { kit_total: 1000, items: [] } }]);
    await sync();
    assert.match(JSON.stringify((await reading('i1-2')).changes), /carton MRP: master 1200, PO 1000/);
  });

  test('review I2: a job linked to a carton with no kit gets that carton\'s kit; a part carton\'s job its outer kit; a name two kits share is held — no master is made', async () => {
    await fluenceSetup();
    const board = await db.one(`SELECT id FROM materials WHERE category = 'board' ORDER BY id LIMIT 1`);
    const bare = await db.one(`INSERT INTO products (customer_id, name, code, board_material_id, mrp) VALUES ($1, 'I2 BARE KIT', 'RVB-701', $2, 500) RETURNING id`, [fx.cust, board.id]);
    const products = async () => (await db.one('SELECT count(*)::int AS n FROM products')).n;
    const n0 = await products();
    const a = await artworkFor({ name: 'I2 BARE KIT', prod: bare.id }, 'i2-1', { prescription: { lines: [{ item: 'F-I2A CAPS', dosage: '1', morning: 1 }] }, mrp: { kit_total: 550, items: [{ item: 'F-I2A CAPS', mrp: 550 }] } });
    await approve(a.r.artwork_version_id);
    const r1 = await reading('i2-1r');
    assert.equal(r1.status, 'saved', r1.hold_reason || '');
    assert.equal(await products(), n0, 'no new carton master');
    assert.equal(r1.created_product_id, null);
    assert.equal(r1.kit_id, (await db.one('SELECT id FROM fluence_kits WHERE product_id = $1', [bare.id])).id, 'the kit was made for the carton the job is linked to');
    const outer = await makeKit({ comps: [['F-I2B CAPS', 1, 500, 'item']] });
    const part = await db.one(`INSERT INTO products (customer_id, name, code, board_material_id) VALUES ($1, 'I2 LEAFLET', 'RVB-702', $2) RETURNING id`, [fx.cust, board.id]);
    await db.q(`INSERT INTO fluence_part_cartons (product_id, outer_product_id, part) VALUES ($1, $2, 'leaflet')`, [part.id, outer.prod]);
    const n1 = await products();
    const b = await artworkFor({ name: 'I2 LEAFLET', prod: part.id }, 'i2-2', { prescription: { lines: [{ item: 'F-I2B CAPS', dosage: '2', morning: 2 }] }, mrp: { kit_total: 1020, items: [] } });
    await approve(b.r.artwork_version_id);
    const r2 = await reading('i2-2r');
    assert.equal(r2.status, 'saved', r2.hold_reason || '');
    assert.equal(r2.kit_id, outer.kit, 'the part carton reads its outer carton\'s kit');
    assert.equal(await products(), n1);
    await makeKit({ name: 'I2 TWIN KIT', comps: [['F-I2C CAPS', 1, 500, 'item']] });
    await makeKit({ name: 'I2 TWIN KIT', comps: [['F-I2D CAPS', 1, 500, 'item']] });
    const n2 = await products();
    const c = await artworkFor({ name: 'I2 TWIN KIT' }, 'i2-3', { prescription: { lines: [{ item: 'F-I2C CAPS', dosage: '1' }] }, mrp: { kit_total: 600, items: [] } });
    await approve(c.r.artwork_version_id);
    const r3 = await reading('i2-3r');
    assert.equal(r3.status, 'held');
    assert.match(r3.hold_reason, /two kits are named I2 TWIN KIT/);
    assert.equal(await products(), n2, 'nothing made on a guess');
  });

  test('review I3: Apply is not for a reading waiting for the client, one that matched no kit, or an artwork whose version is not approved', async () => {
    const k = await makeKit({ comps: [['F-I3A CAPS', 1, 1000, 'item']] });
    const a = await artworkFor(k, 'i3-1', { prescription: { lines: [{ item: 'F-I3A CAPS', dosage: '1' }] }, mrp: { kit_total: 1000, items: [] } });
    assert.equal(a.r.status, 'waiting_approval');
    const w = await call('artist', 'POST', `/fluence/mail-readings/${a.r.id}/apply`);
    assert.equal(w.status, 409);
    assert.match(w.body.error, /Approved by hand/);
    await fileFluence('i3-2', [{ source: 'mrp_sheet', kit_name: 'I3 NO SUCH KIT', sure: true, mrp: { kit_total: 100, items: [] } }]);
    await sync();
    const nm = await reading('i3-2');
    assert.equal(nm.status, 'not_matched');
    assert.equal((await call('artist', 'POST', `/fluence/mail-readings/${nm.id}/apply`)).status, 409);
    await db.q(`UPDATE fluence_mail_readings SET status = 'held', hold_reason = 'a test hold' WHERE id = $1`, [a.r.id]);
    const h = await call('artist', 'POST', `/fluence/mail-readings/${a.r.id}/apply`);
    assert.equal(h.status, 409);
    assert.match(h.body.error, /not approved/);
  });

  test('review I4/I5: one notice per mail — management always, Planning when something is held; held rows stay to look at until a person keeps or applies them', async () => {
    const ks = [await makeKit({ comps: [['F-I4A CAPS', 1, 1000, 'item']] }), await makeKit({ comps: [['F-I4B CAPS', 1, 1000, 'item']] })];
    const planner = await tokenFor('fplanner');
    const boss = await db.one(`SELECT id FROM users WHERE email = 'art-boss@test.local'`);
    await sync();   // what earlier tests left untold is told first, so only this mail is counted
    const mark = (await db.one('SELECT COALESCE(max(id), 0)::int AS m FROM notifications')).m;
    await fileFluence('i4-1', [
      { source: 'mrp_sheet', kit_code: ks[0].code, sure: true, mrp: { kit_total: 1100, items: [] } },
      { source: 'mrp_sheet', kit_code: ks[1].code, sure: true, mrp: { kit_total: 600, items: [] } },
    ]);
    await sync();
    const mine = async uid => db.q('SELECT kind, title FROM notifications WHERE user_id = $1 AND id > $2 ORDER BY id', [uid, mark]);
    const b = await mine(boss.id);
    assert.deepEqual(b.map(n => n.kind), ['fluence_mail'], 'management: one notice for the mail, no bell per kit');
    assert.match(b[0].title, /1 saved, 1 held/);
    assert.deepEqual((await mine(planner.id)).map(n => n.kind), ['fluence_mail'], 'Planning hears of what is held');
    const held = await reading('i4-1');
    assert.equal(held.status, 'held');
    const open = async () => (await call('boss', 'GET', '/fluence/mail-readings?view=open')).body.rows.map(x => x.id);
    assert.ok((await open()).includes(held.id));
    const all = await call('boss', 'POST', '/fluence/mail-readings/ack', { ids: await open() });
    assert.equal(all.status, 200, JSON.stringify(all.body));
    assert.ok((await open()).includes(held.id), 'acknowledging is not deciding: the held one stays');
    const keep = await call('artist', 'POST', `/fluence/mail-readings/${held.id}/keep`);
    assert.equal(keep.status, 200, JSON.stringify(keep.body));
    assert.equal((await reading('i4-1')).status, 'dismissed');
    assert.ok(!(await open()).includes(held.id));
    await sync();
    assert.equal((await mine(boss.id)).length, 1, 'told once');
  });

  test('review I6: before the Fluence table exists, a client\'s approval still lands and the artwork window still opens', async () => {
    await fileMails([mailOf('i6-1', [{ product_name: 'I6 KIT', pack_type: 'carton', files: [f('I6 KIT.cdr', 'i6')] }], { received_at: new Date().toISOString() })]);
    await sync();
    const v = await db.one(`SELECT v.id, v.job_id FROM artwork_versions v JOIN artwork_jobs j ON j.id = v.job_id WHERE j.product_name = 'I6 KIT'`);
    await db.q('ALTER TABLE fluence_mail_readings RENAME TO fluence_mail_readings_away');
    try {
      await approve(v.id);
      assert.equal((await db.one('SELECT stage FROM artwork_versions WHERE id = $1', [v.id])).stage, 'approved');
      const w = await call('artist', 'GET', `/artwork/register/${v.job_id}`);
      assert.equal(w.status, 200, JSON.stringify(w.body));
      await sync();
    } finally {
      await db.q('ALTER TABLE fluence_mail_readings_away RENAME TO fluence_mail_readings');
    }
  });

  test('review: a reading filed before its own artwork mail (the same time) still waits with that artwork', async () => {
    await fluenceSetup();
    const at = new Date().toISOString();
    await fileMails([
      { mailbox_email: BIZ, kind: 'fluence', gmail_message_id: 'm2-1#fluence', gmail_thread_id: 't-m2-1', subject: 'Artwork m2', from_email: 'graphics@fluence.test', received_at: at,
        items: [{ source: 'artwork', kit_name: 'M2 ORDER KIT', sure: true, prescription: { lines: [{ item: 'F-M2 CAPS', dosage: '1' }] } }] },
      mailOf('m2-1', [{ product_name: 'M2 ORDER KIT', pack_type: 'carton', files: [f('M2 ORDER KIT.cdr', 'm21')] }], { gmail_thread_id: 't-m2-1', customer_name: 'Fluence Test Pharma', from_email: 'graphics@fluence.test', received_at: at }),
    ]);
    await sync();
    const r = await reading('m2-1#fluence');
    assert.equal(r.status, 'waiting_approval', r.hold_reason || '');
    assert.ok(r.artwork_version_id);
  });

  test('review: Apply and Undo change a kit, so they need a Fluence tab a kit is edited from', async () => {
    await tokenFor('mailonly', { fluence_tabs: ['mail'] });
    const k = await makeKit({ comps: [['F-M7 CAPS', 1, 1000, 'item']] });
    await fileFluence('m7-1', [{ source: 'mrp_sheet', kit_code: k.code, sure: true, mrp: { kit_total: 600, items: [] } }]);
    await sync();
    const r = await reading('m7-1');
    assert.equal(r.status, 'held');
    const res = await call('mailonly', 'POST', `/fluence/mail-readings/${r.id}/apply`);
    assert.equal(res.status, 403);
    assert.match(res.body.error, /Kits/);
    assert.equal((await k.now()).total, 1000);
  });
});
