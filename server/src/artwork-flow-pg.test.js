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
});
