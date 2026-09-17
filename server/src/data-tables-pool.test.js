// The ledger through a REAL pg-pool with one client — the serverless shape — driven
// by a fake connection whose callbacks fire from outside any request, the way a
// socket's data events do.
//
// pg-pool hands a queued query to whichever request releases the client, and runs
// the queued query's own callback inside that releaser's async context. Without
// binding, the releaser's ledger records the waiting request's SQL: a request that
// read nothing of its own could then be stamped as cacheable against tables it
// never read.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import pg from 'pg';
import { setKnownTables, instrumentPool, withLedger, newLedger, currentLedger } from './data-tables.js';

setKnownTables(['job_cards', 'orders', 'customers', 'users']);

// Replies are delivered by a timer created here, at module scope, outside every
// request — so a reply callback runs with no ledger unless something bound it.
const replies = [];
const pump = setInterval(() => { while (replies.length) replies.shift()(); }, 2);
after(() => clearInterval(pump));

class FakeClient extends EventEmitter {
  connect(cb) { replies.push(() => cb(null)); }
  query(text, values, cb) {
    if (typeof values === 'function') { cb = values; values = undefined; }
    const result = { rows: [{ text: typeof text === 'string' ? text : text?.text }] };
    if (cb) { replies.push(() => cb(null, result)); return undefined; }
    return new Promise(resolve => replies.push(() => resolve(result)));
  }
  end(cb) { if (cb) cb(); return Promise.resolve(); }
}

const makePool = () => { const p = new pg.Pool({ Client: FakeClient, max: 1 }); instrumentPool(p); return p; };

test('a query queued behind another request is recorded only against its own request', async () => {
  const pool = makePool();
  const holder = newLedger();
  const waiter = newLedger();
  // The holder releases from INSIDE its own request, as tx() does in its finally.
  let go; const signal = new Promise(r => { go = r; });
  let acquired; const ready = new Promise(r => { acquired = r; });
  const held = withLedger(holder, async () => {
    const client = await pool.connect();
    await client.query('SELECT id FROM users');
    acquired();
    await signal;
    client.release();
  });
  await ready;
  const queued = withLedger(waiter, () => pool.query('SELECT * FROM job_cards'));
  go();
  await Promise.all([held, queued]);
  assert.deepEqual([...holder.read].sort(), ['users'], 'the releaser never records the waiter\'s statement');
  assert.deepEqual([...waiter.read].sort(), ['job_cards']);
  assert.equal(currentLedger(), null);
});

test('callback-style queries keep their request, however the reply arrives', async () => {
  const pool = makePool();
  const ledger = newLedger();
  await withLedger(ledger, () => new Promise((resolve, reject) => {
    pool.query('SELECT id FROM orders', [], err => {
      if (err) return reject(err);
      pool.query('SELECT id FROM customers', [], err2 => (err2 ? reject(err2) : resolve()));
    });
  }));
  assert.deepEqual([...ledger.read].sort(), ['customers', 'orders']);
});

test('instrumenting a pool twice is a no-op, and its clients still query', async () => {
  const pool = makePool();
  instrumentPool(pool);
  const ledger = newLedger();
  await withLedger(ledger, async () => {
    const c = await pool.connect();
    try { await c.query('SELECT 1 FROM orders'); } finally { c.release(); }
  });
  assert.deepEqual([...ledger.read], ['orders']);
});
