// The server half of "answer a repeat GET without asking": which tables a
// response was built from, and whether it is safe to reuse at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  setKnownTables, analyseSql, newLedger, recordStatement, markFailed,
  ledgerHeaders, instrumentQuery, dataTablesMiddleware, currentLedger,
} from './data-tables.js';

setKnownTables(['job_cards', 'job_stages', 'orders', 'order_lines', 'audit_log', 'users', 'stock_movements', 'conversation_members']);

test('tables are whole words — job_card is not job_cards, a literal is not a reference', () => {
  assert.deepEqual(analyseSql(`SELECT * FROM job_stages js JOIN job_cards jc ON jc.id = js.job_card_id`).tables,
    ['job_cards', 'job_stages']);
  assert.deepEqual(analyseSql(`SELECT sm.qty FROM stock_movements sm WHERE sm.ref_type='job_card'`).tables,
    ['stock_movements']);
  assert.deepEqual(analyseSql(`SELECT 'orders' AS label FROM job_cards`).tables, ['job_cards']);
});

test('a plain read is a read; anything that can change or lock something is not', () => {
  const read = sql => analyseSql(sql).read;
  assert.equal(read('SELECT id, updated_at FROM orders'), true, 'updated_at is not UPDATE');
  assert.equal(read(`WITH d AS (SELECT 1) SELECT * FROM d JOIN orders o ON true`), true);
  assert.equal(read(`SELECT * FROM orders WHERE note = 'delete me'`), true, 'a literal is not a statement');
  assert.equal(read(`SELECT 1 -- then update everything\nFROM orders`), true, 'a comment is not a statement');
  assert.equal(read('SELECT * FROM orders FOR UPDATE'), false);
  assert.equal(read('SELECT * FROM orders FOR SHARE'), false);
  assert.equal(read(`WITH x AS (UPDATE orders SET status='x' RETURNING id) SELECT * FROM x`), false);
  assert.equal(read('SELECT * INTO scratch FROM orders'), false);
  assert.equal(read(`SELECT nextval('jc_seq')`), false);
  assert.equal(read(`SELECT realtime.send('{}'::jsonb, 'e', 't', false)`), false);
  assert.equal(read(`SELECT pg_advisory_xact_lock(1)`), false);
  assert.equal(read('UPDATE users SET last_active_at=now() WHERE id=$1'), false);
  assert.equal(read('INSERT INTO audit_log (action) VALUES ($1)'), false);
  for (const s of ['BEGIN', 'COMMIT', 'ROLLBACK']) assert.equal(read(s), false, s);
  assert.equal(read(''), false);
  assert.equal(read(undefined), false);
});

test('a write spoils the response and names what it touched', () => {
  const l = newLedger();
  recordStatement(l, 'SELECT * FROM job_cards');
  assert.deepEqual(ledgerHeaders(l, { method: 'GET', status: 200 }), { 'X-Data-Tables': 'job_cards' });
  recordStatement(l, 'UPDATE conversation_members SET last_seen_at=now() WHERE user_id=$1');
  assert.deepEqual(ledgerHeaders(l, { method: 'GET', status: 200 }), { 'X-Data-Wrote': 'conversation_members' });
});

test('no header for a failed statement, a non-200, a non-GET, or a response that read nothing', () => {
  const failed = newLedger(); recordStatement(failed, 'SELECT * FROM orders'); markFailed(failed);
  assert.deepEqual(ledgerHeaders(failed, { method: 'GET', status: 200 }), {});
  const ok = newLedger(); recordStatement(ok, 'SELECT * FROM orders');
  assert.deepEqual(ledgerHeaders(ok, { method: 'GET', status: 404 }), {});
  assert.deepEqual(ledgerHeaders(ok, { method: 'GET', status: 304 }), { 'X-Data-Tables': 'orders' }, 'a 304 is the same body');
  assert.deepEqual(ledgerHeaders(ok, { method: 'POST', status: 200 }), {});
  assert.deepEqual(ledgerHeaders(newLedger(), { method: 'GET', status: 200 }), {});
  assert.deepEqual(ledgerHeaders(null), {});
});

test('a statement we cannot read at all spoils the response', () => {
  const l = newLedger(); recordStatement(l, { name: 'no text here' });
  assert.equal(l.cacheable, false);
});

// pg-pool runs a queued query from inside whichever request released a client —
// so the ledger must be the one current when the query was CALLED.
test('instrumentQuery records into the caller\'s ledger even when it settles elsewhere', async () => {
  const fired = [];
  const fakeQuery = function (text) { fired.push(text); return new Promise(r => setTimeout(() => r({ rows: [] }), 5)); };
  const q = instrumentQuery(fakeQuery, null);
  const req = (sql, delay) => new Promise(resolve => {
    const res = { headersSent: false, statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end() { resolve(this.headers); } };
    dataTablesMiddleware({ method: 'GET' }, res, async () => {
      await new Promise(r => setTimeout(r, delay));
      await q(sql);
      res.end('{}');
    });
  });
  const [a, b] = await Promise.all([req('SELECT * FROM orders', 3), req('SELECT * FROM job_stages', 1)]);
  assert.equal(a['X-Data-Tables'], 'orders');
  assert.equal(b['X-Data-Tables'], 'job_stages');
  assert.equal(currentLedger(), null, 'no ledger leaks outside a request');
});

test('a rejected query spoils the ledger without swallowing the rejection', async () => {
  const q = instrumentQuery(() => Promise.reject(new Error('boom')), null);
  const l = await new Promise(resolve => {
    const res = { headersSent: false, statusCode: 200, setHeader() {}, end() {} };
    dataTablesMiddleware({ method: 'GET' }, res, async () => {
      const ledger = currentLedger();
      await assert.rejects(q('SELECT * FROM orders'), /boom/);
      resolve(ledger);
    });
  });
  assert.equal(l.cacheable, false);
});

test('a callback-style query error spoils the ledger and still reaches the callback', async () => {
  const q = instrumentQuery((text, values, cb) => cb(new Error('bad')), null);
  const l = await new Promise(resolve => {
    const res = { headersSent: false, statusCode: 200, setHeader() {}, end() {} };
    dataTablesMiddleware({ method: 'GET' }, res, () => {
      const ledger = currentLedger();
      q('SELECT * FROM orders', [], err => { assert.match(err.message, /bad/); resolve(ledger); });
    });
  });
  assert.equal(l.cacheable, false);
});

// "typing…" is typing_at > now() - 6 seconds, and the database deliberately does not
// announce typing_at / last_seen_at / last_active_at changes — so nothing the feed says
// can prove such a response fresh. It must never carry X-Data-Tables.
test('a response that reads an unannounced presence column is never cacheable', () => {
  for (const col of ['typing_at', 'last_seen_at', 'last_active_at']) {
    const l = newLedger();
    recordStatement(l, 'SELECT id FROM conversation_members');
    assert.ok(ledgerHeaders(l, { method: 'GET', status: 200 })['X-Data-Tables'], 'plain read is cacheable');
    recordStatement(l, `SELECT user_id, (cm.${col} > now() - interval '6 seconds') AS live FROM conversation_members cm`);
    assert.deepEqual(ledgerHeaders(l, { method: 'GET', status: 200 }), {}, `${col} makes it uncacheable`);
  }
  const l = newLedger();
  recordStatement(l, `SELECT 'last_seen_at' AS label FROM conversation_members`);
  assert.ok(ledgerHeaders(l, { method: 'GET', status: 200 })['X-Data-Tables'], 'a literal naming the column is not a read of it');
});

// A table hidden from the scan is the one way this module can make a response
// STALE rather than merely uncacheable: the header would under-list what it read.
// Comments, strings and dollar quotes must be taken in the order they appear —
// an apostrophe inside a comment is not the start of a string.
test('an apostrophe in a comment or an escaped quote never hides the tables after it', () => {
  const tables = sql => analyseSql(sql).tables;
  assert.deepEqual(tables(`SELECT jc.id FROM job_cards jc -- don't show cancelled\nJOIN orders o ON o.id = jc.order_id WHERE o.status <> 'cancelled'`),
    ['job_cards', 'orders']);
  assert.deepEqual(tables(`SELECT jc.id /* the planner's view */ FROM job_cards jc JOIN orders o ON true WHERE o.note <> 'x'`),
    ['job_cards', 'orders']);
  assert.deepEqual(tables(`SELECT 1 FROM job_cards WHERE note = E'it\\'s' AND id IN (SELECT id FROM orders) AND 'a' = 'a'`),
    ['job_cards', 'orders']);
  assert.deepEqual(tables(`SELECT $q$don't$q$ AS t, id FROM orders WHERE x = 'y'`), ['orders']);
  assert.deepEqual(tables(`SELECT '--' AS dash, id FROM orders`), ['orders'], 'a string holding -- is not a comment');
  assert.deepEqual(tables(`SELECT 1 /* outer /* nested */ still comment 'x */ FROM orders`), ['orders'], 'block comments nest');
  assert.equal(analyseSql(`SELECT * FROM orders WHERE note = 'unterminated`).read, false, 'what cannot be lexed is not a read');
  assert.equal(analyseSql(`SELECT $1::int AS n FROM orders`).read, true, 'a $1 parameter is not a dollar quote');
});

// A view or a function reads tables whose names never appear in the statement,
// so its dependencies cannot be listed: a statement touching one is never cacheable.
test('a statement that goes through a view or a public function is never cacheable', () => {
  setKnownTables(['job_cards', 'orders'], ['open_orders_v', 'board_short_fn']);
  try {
    const l = newLedger(); recordStatement(l, 'SELECT * FROM open_orders_v v JOIN job_cards jc ON jc.id = v.id');
    assert.deepEqual(ledgerHeaders(l, { method: 'GET', status: 200 }), {});
    const f = newLedger(); recordStatement(f, 'SELECT id, board_short_fn(id) FROM orders');
    assert.deepEqual(ledgerHeaders(f, { method: 'GET', status: 200 }), {});
  } finally {
    setKnownTables(['job_cards', 'job_stages', 'orders', 'order_lines', 'audit_log', 'users', 'stock_movements', 'conversation_members']);
  }
});

// On Vercel, @vercel/node attaches its own res.send/res.json helpers as OWN properties
// of the response, shadowing Express's; its json() writes through an internal send()
// straight to res.end(). A hook on res.send never runs there — the headers must be
// stamped on the one call every path makes: res.end().
test('headers are stamped however the body is sent — Express send, Vercel helpers, or a bare end', async () => {
  const { default: express } = await import('express');
  const http = await import('node:http');
  const q = instrumentQuery(async () => ({ rows: [{ n: 1 }] }), null);
  const app = express();
  app.use(dataTablesMiddleware);
  app.get('/express', async (_req, res) => { await q('SELECT * FROM orders'); res.json({ ok: 1 }); });
  app.get('/vercel', async (_req, res) => { await q('SELECT * FROM orders'); res.json({ ok: 1 }); });
  app.get('/bare', async (_req, res) => { await q('SELECT * FROM job_cards'); res.setHeader('Content-Type', 'application/json'); res.end('{}'); });
  app.get('/stream', async (_req, res) => { await q('SELECT * FROM orders'); res.write('['); await q('SELECT * FROM job_cards'); res.end(']'); });
  const server = http.createServer((req, res) => {
    if (req.url === '/vercel') {
      // what @vercel/node's addHelpers does: own-property json that never calls res.send
      res.json = body => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body)); };
      res.send = body => { res.end(String(body)); };
    }
    app(req, res);
  });
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const h = async p => (await fetch(base + p)).headers.get('x-data-tables');
    assert.equal(await h('/express'), 'orders');
    assert.equal(await h('/vercel'), 'orders', 'Vercel helper path');
    assert.equal(await h('/bare'), 'job_cards');
    assert.equal(await h('/stream'), null, 'a streamed body sent its headers before every query ran: no claim');
    const etag = (await fetch(base + '/express')).headers.get('etag');
    // raw http, not fetch: fetch adds Cache-Control: no-cache to a conditional request,
    // which Express rightly answers with a full 200
    const revalidated = await new Promise((resolve, reject) => {
      http.get(base + '/express', { headers: { 'If-None-Match': etag } }, r => { r.resume(); resolve(r); }).on('error', reject);
    });
    assert.equal(revalidated.statusCode, 304);
    assert.equal(revalidated.headers['x-data-tables'], 'orders', 'a 304 refreshes the stored dependency list');
  } finally {
    server.close();
  }
});
