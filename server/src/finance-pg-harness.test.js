import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';

// The Finance PG harness talks to its own app and its own Postgres, and to nothing else (Cash & Bank build, Task 17: under parallel
// boots another local program sometimes answered a test file's first request, a bare 404 or a body that was not JSON). On this
// machine a server listening on every address (`app.listen(0)`, as the harness did) shares its port with any program that later
// listens on 127.0.0.1 alone, and the connections the harness makes to 127.0.0.1 then reach that program. So the harness serves the
// app on 127.0.0.1 alone, stamps every answer with a nonce of the boot's own, proves the nonce before any test runs, and refuses an
// answer that does not carry it.
//
// The first four tests need no Postgres and run in `npm test`. The last two start one, so they are opt-in:
//   cd server && FINANCE_PG=1 node --test src/finance-pg-harness.test.js
const ON = process.env.FINANCE_PG === '1';
const gate = { skip: ON ? false : 'set FINANCE_PG=1' };

// Loaded softly, so that a harness without one of these fails each test on its own assertion and not the whole file on the import.
const harness = await import('./finance-pg-harness.js');
const { finBootPg, finServeOwn, finProveOwn, finCaller, finStartPg } = harness;

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.unref();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

const listening = (server, port, host) => new Promise(resolve => {
  server.once('error', e => resolve(e.code));
  server.listen(port, host, () => resolve('listening'));
});
const closing = server => new Promise(resolve => {
  if (!server?.listening) return resolve();
  server.close(() => resolve());
  server.closeAllConnections?.();
});
// Another program on this machine: it answers everything with a bare 404, as the flake's stranger did.
const decoyOn = async (port = 0) => {
  const decoy = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
  assert.equal(await listening(decoy, port, '127.0.0.1'), 'listening');
  return decoy;
};
// A stand-in for the Express app: what an app answers.
const app = (req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ app: true, url: req.url })); };

test('finServeOwn serves on 127.0.0.1 alone, on the port the kernel picked, proves its nonce, and stamps every answer with it', async () => {
  assert.equal(typeof finServeOwn, 'function', 'the harness exports finServeOwn');
  const own = await finServeOwn(app);
  try {
    const at = own.server.address();
    assert.equal(at.address, '127.0.0.1', 'never every address: a program on 127.0.0.1 alone would win the harness\'s connections');
    assert.ok(Number.isInteger(at.port) && at.port > 0, 'listen(0): the port is the kernel\'s, read back');
    assert.equal(own.base, `http://127.0.0.1:${at.port}/api`);
    assert.match(own.nonce, /^[0-9a-f]{32}$/);
    const res = await fetch(`${own.base}/finance/me`);
    assert.equal(res.headers.get('x-fin-boot'), own.nonce, 'the app\'s answers carry the boot\'s nonce');
    assert.deepEqual(await res.json(), { app: true, url: '/api/finance/me' }, 'and are the app\'s own');
  } finally { await closing(own.server); }
});

test('a port another program holds on 127.0.0.1 is never shared: finServeOwn on it refuses', async () => {
  assert.equal(typeof finServeOwn, 'function', 'the harness exports finServeOwn');
  const decoy = await decoyOn();
  try {
    await assert.rejects(finServeOwn(app, { port: decoy.address().port }), e => e.code === 'EADDRINUSE');
  } finally { await closing(decoy); }
});

test('finProveOwn refuses an address another program answers, saying what answered', async () => {
  assert.equal(typeof finProveOwn, 'function', 'the harness exports finProveOwn');
  const decoy = await decoyOn();
  try {
    await assert.rejects(finProveOwn(`http://127.0.0.1:${decoy.address().port}`, 'a'.repeat(32)),
      /answered by another program.*404/s);
  } finally { await closing(decoy); }
});

test('a call that another program answers throws, naming it, and never hands back that program\'s 404 as the app\'s answer', async () => {
  assert.equal(typeof finCaller, 'function', 'the harness exports finCaller');
  const decoy = await decoyOn();
  try {
    const call = finCaller('decoy', `http://127.0.0.1:${decoy.address().port}/api`, 'b'.repeat(32), { md: { token: 'x' } });
    await assert.rejects(call('GET', '/finance/me', null, 'md'), /GET \/finance\/me was answered by another program.*404/s);
    await assert.rejects(call('GET', '/finance/me', null, 'nobody'), /no login called 'nobody'/);
  } finally { await closing(decoy); }
});

test('a boot\'s app and Postgres are its own: nothing else can listen on the app\'s address, and Postgres listens on 127.0.0.1 alone', gate, async () => {
  const h = await finBootPg('harness-own', { setup: false });
  try {
    const port = Number(new URL(h.base).port);
    const decoy = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
    const took = await listening(decoy, port, '127.0.0.1');
    try {
      assert.equal(took, 'EADDRINUSE', 'another program could listen on the boot\'s own address, and would win its connections');
    } finally { await closing(decoy); }
    const me = await h.call('GET', '/finance/me', null, 'md');
    assert.equal(me.status, 200, JSON.stringify(me.body));
    const at = await h.db.one(`SELECT current_setting('listen_addresses') AS listen, host(inet_server_addr()) AS addr`);
    assert.deepEqual(at, { listen: '127.0.0.1', addr: '127.0.0.1' }, 'Postgres on the one address the pool dials');
  } finally { await h.close(); }
});

test('a Postgres whose port another program took is started again on another port, never left on ::1 with 127.0.0.1 the taker\'s', gate, async () => {
  assert.equal(typeof finStartPg, 'function', 'the harness exports finStartPg');
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const decoy = await decoyOn();
  const taken = decoy.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fin-harness-start-'));
  const tried = [];
  let started;
  try {
    // The first try is handed the decoy's port, as a port taken between freePort()'s probe and Postgres' bind would be.
    started = await finStartPg(EmbeddedPostgres, dir, { nextPort: async () => { const p = tried.length ? await freePort() : taken; tried.push(p); return p; } });
    assert.equal(tried[0], taken);
    assert.equal(tried.length, 2, 'the taken port was given up, and the next one used');
    assert.equal(started.port, tried[1]);
    const client = new pg.Client({ host: '127.0.0.1', port: started.port, user: 'postgres', password: 'postgres', database: 'postgres' });
    await client.connect();
    try {
      const { rows: [row] } = await client.query(`SELECT current_setting('data_directory') AS dir`);
      assert.equal(fs.realpathSync(row.dir), fs.realpathSync(dir), 'the pool\'s address reaches this cluster');
    } finally { await client.end(); }
    assert.equal((await fetch(`http://127.0.0.1:${taken}/`)).status, 404, 'and the decoy still has its own port');
  } finally {
    await started?.epg.stop();
    await closing(decoy);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
