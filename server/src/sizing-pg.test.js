import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// Size proposals and KLDs through the REAL app against a real Postgres (owner, 12 Nov 2026): the die check across the
// Die Master and the 2024 die register, proposals on the board master's sheets, the KLD saved on the Size Library
// entry (and redrawn as a new revision), its PDF, a board's grain, and the KLD saved to Drive and shared with the
// business mailbox only — through a fake Google. Invented sizes and boards; nothing is a customer's.
//
//   SIZING_PG=1 node --test src/sizing-pg.test.js
const ENABLED = process.env.SIZING_PG === '1';
const DRIVE = 'https://www.googleapis.com/auth/drive.file';
const GMAIL = 'https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.metadata';

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.unref();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

describe('Size proposals and KLDs — through the real app', { skip: ENABLED ? false : 'set SIZING_PG=1 to boot a throwaway Postgres' }, () => {
  let epg, dir, db, server, base, google, sealToken;
  const tokens = {};
  const seen = { uploads: [], permissions: [], folders: [] };

  before(async () => {
    // a fake Google: token refresh, folder search/create, multipart upload, permissions
    google = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
        const u = new URL(req.url, 'http://x');
        if (u.pathname === '/token') return send(200, { access_token: 'ya29.test', expires_in: 3600 });
        if (u.pathname === '/drive/v3/files' && req.method === 'GET') return send(200, { files: seen.folders.map(id => ({ id, name: 'CI Plant KLDs' })) });
        if (u.pathname === '/drive/v3/files' && req.method === 'POST') { seen.folders.push('folder-1'); return send(200, { id: 'folder-1' }); }
        if (u.pathname === '/upload/drive/v3/files' && req.method === 'POST') {
          const id = `file-${seen.uploads.length + 1}`;
          seen.uploads.push({ id, query: u.search, type: req.headers['content-type'], body });
          return send(200, { id, webViewLink: `https://drive.google.com/file/d/${id}/view` });
        }
        const perm = u.pathname.match(/^\/drive\/v3\/files\/([^/]+)\/permissions$/);
        if (perm && req.method === 'POST') { seen.permissions.push({ file: perm[1], ...JSON.parse(body || '{}') }); return send(200, { id: 'perm-1' }); }
        return send(404, { error: { message: `no ${req.method} ${u.pathname}` } });
      });
    });
    await new Promise(r => google.listen(0, '127.0.0.1', r));
    const g = `http://127.0.0.1:${google.address().port}`;
    Object.assign(process.env, {
      GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret', GMAIL_TOKEN_KEY: 'ab'.repeat(32),
      GOOGLE_TOKEN_URL: `${g}/token`, GDRIVE_API_BASE: `${g}/drive/v3`, GDRIVE_UPLOAD_BASE: `${g}/upload/drive/v3`,
    });

    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sizing-pg-'));
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
    ({ sealToken } = await import('./gmail.js'));

    await db.q(`UPDATE materials SET active = 0 WHERE category = 'board'`);
    for (const [l, w] of [[25, 30], [23, 36], [25, 36], [31.5, 41.5], [22, 28]]) {
      await db.q(`INSERT INTO materials (name, category, unit, sheet_l, sheet_w, grade, gsm, active) VALUES ($1, 'board', 'sheets', $2, $3, 'FBB', 300, 1)`,
        [`TEST FBB 300 ${l}x${w}`, l, w]);
    }
    await db.q(`INSERT INTO tools (family, code, title, carton_size, sheet_size, ups) VALUES ('die', 'T-901', 'Test die', '92X80X66', '15X25', 4)`);
    await db.q(`INSERT INTO die_register (die_no, l_mm, w_mm, h_mm, style, ups, size_text, source)
                VALUES ('R-55', 90, 80, 65, 'Lock', 3, '90X80X65', 'test register'), ('R-56', 140, 50, 60, 'RTF', 4, '140X50X60', 'test register')`);

    const { default: jwt } = await import('jsonwebtoken');
    const { JWT_SECRET: secret } = await import('./auth.js');
    const mk = async (key, role, modules) => {
      const u = await db.one(`INSERT INTO users (name, email, password_hash, role, modules) VALUES ($1, $2, 'x', $3, $4) RETURNING id, name, role`,
        [`Sizing ${key}`, `sizing-${key}@test.local`, role, modules && JSON.stringify(modules)]);
      tokens[key] = jwt.sign({ id: u.id, name: u.name, role: u.role }, secret);
    };
    await mk('admin', 'admin', null);
    await mk('clerk', 'planner', ['costing']);
    await mk('plain', 'planner', null);
    const { default: app } = await import('./app.js');
    server = await new Promise(res => { const s = app.listen(0, () => res(s)); });
    base = `http://127.0.0.1:${server.address().port}/api`;
  });

  after(async () => {
    server?.close();
    google?.close();
    try { await (await db?.connect())?.end(); } catch {}
    try { await epg?.stop(); } catch {}
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const call = async (who, method, url, body) => {
    const res = await fetch(base + url, {
      method, headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    const type = res.headers.get('content-type') || '';
    if (/json/.test(type)) return { status: res.status, body: await res.json(), headers: res.headers };
    return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()), headers: res.headers };
  };

  test('proposals check both die lists, then lay the carton on the board master\'s sheets', async () => {
    const r = await call('clerk', 'GET', '/costing/sizing/proposals?size=92x80x66&style=LOCK&gsm=300');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.dies.master.exact.map(d => d.code), ['T-901']);
    assert.deepEqual(r.body.dies.register.near.map(d => d.die_no), ['R-55']);
    const top = r.body.readings[0].options[0];
    assert.deepEqual([top.sheet.long, top.sheet.short, top.ups], [25, 15, 4]);
    assert.equal((await call('plain', 'GET', '/costing/sizing/proposals?size=92x80x66&style=LOCK')).status, 403);
    const lit = await call('clerk', 'GET', '/costing/sizing/proposals?size=150x240&style=LIT');
    assert.equal(lit.status, 200);
    assert.equal(lit.body.unsupported, true);
  });

  let sizeId;
  test('Make KLD saves the drawing on the Size Library entry; a redraw is the next revision', async () => {
    const body = { size_text: '92 x 80 x 66', style: 'LOCK', reading: 'lock', option: { sheet: { long: 25, short: 15 }, ups: 4, m: 1, n: 4, acrossOn: 'short' } };
    const a = await call('clerk', 'PUT', '/costing/sizing/kld', body);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    sizeId = a.body.size_id;
    assert.equal(a.body.kld.rev, 1);
    assert.equal(a.body.kld.construction, 'LOCK');
    const entry = await db.one(`SELECT size_key, style, sheet_l::float8 AS sheet_l, sheet_w::float8 AS sheet_w, ups::float8 AS ups FROM costing_sizes WHERE id = $1`, [sizeId]);
    assert.deepEqual(entry, { size_key: '92x80x66', style: 'LOCK', sheet_l: 15, sheet_w: 25, ups: 4 });
    const b = await call('clerk', 'PUT', '/costing/sizing/kld', body);
    assert.equal(b.body.size_id, sizeId);
    assert.equal(b.body.kld.rev, 2);
    const check = await call('clerk', 'GET', '/costing/size-check?size=92x80x66');
    assert.equal(check.body.library.exact.find(e => e.id === sizeId).kld_rev, 2);
    const bad = await call('clerk', 'PUT', '/costing/sizing/kld', { ...body, reading: 'side-open' });
    assert.equal(bad.status, 400);
  });

  test('the KLD comes as a PDF to Costing logins only', async () => {
    const pdf = await call('clerk', 'GET', `/costing/sizes/${sizeId}/kld.pdf`);
    assert.equal(pdf.status, 200);
    assert.match(pdf.headers.get('content-type'), /application\/pdf/);
    assert.equal(pdf.bytes.subarray(0, 5).toString(), '%PDF-');
    assert.equal((await call('plain', 'GET', `/costing/sizes/${sizeId}/kld.pdf`)).status, 403);
    assert.equal((await call('clerk', 'GET', '/costing/sizes/999999/kld.pdf')).status, 404);
  });

  test('a board keeps which side its grain runs along', async () => {
    const m = await db.one(`SELECT id FROM materials WHERE name = 'TEST FBB 300 23x36'`);
    assert.equal((await call('admin', 'PUT', `/materials/${m.id}`, { grain: 'long' })).status, 200);
    assert.equal((await db.one('SELECT grain FROM materials WHERE id = $1', [m.id])).grain, 'long');
    assert.equal((await call('admin', 'PUT', `/materials/${m.id}`, { grain: 'sideways' })).status, 400);
    assert.equal((await call('admin', 'PUT', `/materials/${m.id}`, { grain: '' })).status, 200);
    assert.equal((await db.one('SELECT grain FROM materials WHERE id = $1', [m.id])).grain, null);
  });

  test('Save to Drive needs the Drive permission on the trial mailbox\'s Google link', async () => {
    assert.equal((await call('clerk', 'POST', `/costing/sizes/${sizeId}/kld/drive`)).status, 409); // no link yet
    await db.q(`INSERT INTO gmail_links (mailbox, email, refresh_token_enc, scope, connected_by_name)
                VALUES ('trial', 'dua.anik@gmail.com', $1, $2, 'Test')`, [sealToken('refresh-1'), GMAIL]);
    const r = await call('clerk', 'POST', `/costing/sizes/${sizeId}/kld/drive`);
    assert.equal(r.status, 409);
    assert.match(r.body.error, /connect/i);
    assert.equal(seen.uploads.length, 0);
  });

  test('Save to Drive uploads into the KLD folder and shares it with the business mailbox only', async () => {
    await db.q(`UPDATE gmail_links SET scope = $1 WHERE mailbox = 'trial'`, [`${GMAIL} ${DRIVE}`]);
    const r = await call('clerk', 'POST', `/costing/sizes/${sizeId}/kld/drive`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.drive.file_id, 'file-1');
    assert.equal(r.body.drive.shared_with, 'mppchd@gmail.com');
    assert.equal(seen.uploads.length, 1);
    assert.match(seen.uploads[0].type, /multipart\/related/);
    assert.match(seen.uploads[0].body, /%PDF-/);
    assert.match(seen.uploads[0].body, /"parents":\["folder-1"\]/);
    assert.deepEqual(seen.permissions.map(p => [p.file, p.type, p.role, p.emailAddress]), [['file-1', 'user', 'reader', 'mppchd@gmail.com']]);
    const again = await call('clerk', 'POST', `/costing/sizes/${sizeId}/kld/drive`);
    assert.equal(again.body.drive.file_id, 'file-2', 'a second save is a new file, never an overwrite');
    assert.equal(seen.folders.length, 1, 'the folder is made once');
    const kld = (await call('clerk', 'GET', `/costing/sizes/${sizeId}/kld`)).body.kld;
    assert.deepEqual(kld.drive.map(d => d.file_id), ['file-1', 'file-2']);
    assert.equal((await call('plain', 'POST', `/costing/sizes/${sizeId}/kld/drive`)).status, 403);
  });
});
