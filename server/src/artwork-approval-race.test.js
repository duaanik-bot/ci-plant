import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPROVAL_UPDATE, ARTWORK_LOCK, approvalParams, approvalChanges } from './routes/orders.js';

// The Artwork queue's two approval toggles (Customer, QA shade/text) used to
// send BOTH flags, taking the other one from the row as drawn, and the server
// read both and wrote both back. Customer ✓ then QA ✓ in quick succession — or
// two people, one flag each — saved QA ✓ and Customer ✗. Now a toggle sends
// only its own flag and the server changes only the sent flags, in one
// statement against the row as it is when the write lands (APPROVAL_UPDATE).

const SRC = path.dirname(fileURLToPath(import.meta.url));
const read = rel => fs.readFileSync(path.join(SRC, rel), 'utf8');

test('an unsent flag is null — left as the row holds it; a sent one is 1 or 0', () => {
  assert.deepEqual(approvalParams(7, true, undefined), [7, 1, null]);
  assert.deepEqual(approvalParams(7, undefined, false), [7, null, 0]);
  assert.deepEqual(approvalParams(7, 0, 1), [7, 0, 1]);
  assert.match(APPROVAL_UPDATE, /artwork_customer_ok = COALESCE\(\$2::int, artwork_customer_ok\)/);
  assert.match(APPROVAL_UPDATE, /artwork_qa_ok\s+= COALESCE\(\$3::int, artwork_qa_ok\)/);
  assert.match(APPROVAL_UPDATE, /WHERE id = \$1 AND artwork_locked = 0/);
});

test('both approval routes write through it, never a read-then-write of both flags', () => {
  const orders = read('routes/orders.js');
  assert.match(orders, /await qc\(APPROVAL_UPDATE, approvalParams\(line\.id, customer_ok, qa_ok\)\)/, 'POST (the toggle)');
  // PUT (the form) writes only the flags that differ from the row.
  assert.match(orders, /await qc\(APPROVAL_UPDATE, approvalParams\(line\.id, cust, qa\)\)/, 'PUT (the form)');
  assert.match(orders, /const cust = changes\.some\(c => c\.startsWith\('Customer'\)\) \? customer_ok : undefined;/);
  assert.doesNotMatch(orders, /customer_ok \?\? line\.artwork_customer_ok/, 'no value read earlier is written back');
});

test('the Artwork page sends only the pressed flag and takes the saved row', () => {
  const page = read('../../client/src/pages/Artwork.jsx');
  assert.match(page, /setApproval\(l, \{ customer_ok: !l\.artwork_customer_ok \}\)/);
  assert.match(page, /setApproval\(l, \{ qa_ok: !l\.artwork_qa_ok \}\)/);
  assert.doesNotMatch(page, /setApproval\(l, \{ customer_ok: [^}]*qa_ok/, 'a toggle must not send the other flag');
  assert.match(page, /takeApproval\(await api\.post\(`\/order-lines\/\$\{l\.id\}\/artwork`, patch\)\)/);
  assert.match(page, /key === 'customer' \? \{ customer_ok: val \} : \{ qa_ok: val \}/, 'the gang toggle sends one flag per carton');
  assert.match(page, /form\.customer_ok !== !!editing\.artwork_customer_ok \? \{ customer_ok: form\.customer_ok \} : \{\}/,
    'the form sends an approval only when it was changed there');
  assert.match(page, /form\.qa_ok !== !!editing\.artwork_qa_ok \? \{ qa_ok: form\.qa_ok \} : \{\}/);
});

test('a save reports only the flags it changes; a resend of the same values is a no-op', () => {
  const line = { artwork_customer_ok: 0, artwork_qa_ok: 1 };
  assert.deepEqual(approvalChanges(line, true, undefined), ['Customer approved']);
  assert.deepEqual(approvalChanges(line, undefined, false), ['QA shade/text cleared']);
  assert.deepEqual(approvalChanges(line, false, true), [], 'an older form sending both, unchanged');
});

test('the routes around it: an out-of-date screen, a form on a locked line, a lock re-checking approvals', () => {
  const orders = read('routes/orders.js');
  // A toggle sends one flag; a body with both is a pre-change Artwork screen.
  assert.match(orders, /if \(customer_ok !== undefined && qa_ok !== undefined\) \{\s*return res\.status\(409\)\.json\(\{ error: 'This Artwork screen is out of date/);
  // The form: an approval CHANGE that cannot land is refused, not dropped.
  assert.match(orders, /if \(changes\.length && !done\) \{\s*throw Object\.assign\(new Error\('Artwork is locked — its approvals cannot change/);
  // A form sending approval flags must say they are only its changes.
  assert.match(orders, /if \(\(customer_ok !== undefined \|\| qa_ok !== undefined\) && approvals !== 'changed'\) \{\s*return res\.status\(409\)/);
  assert.match(read('../../client/src/pages/Artwork.jsx'), /approvals: 'changed',/);
  // The lock re-checks both approvals in the same statement it locks with.
  assert.match(ARTWORK_LOCK, /WHERE id=\$1 AND artwork_locked=0 AND artwork_customer_ok<>0 AND artwork_qa_ok<>0/);
  assert.match(orders, /const \[locked\] = await qc\(ARTWORK_LOCK, \[line\.id\]\);/);
  assert.doesNotMatch(orders, /await qc\('UPDATE order_lines SET artwork_locked=1 WHERE id=\$1', \[line\.id\]\)/);
});

test('the page paints only its newest load, and Codes fills the form from that carton', () => {
  const page = read('../../client/src/pages/Artwork.jsx');
  assert.match(page, /const n = \+\+loadSeq\.current;\s*return api\.get\('\/artwork'\)\.then\(ls => \{\s*if \(n !== loadSeq\.current\) return;/);
  assert.match(page, /onClick=\{\(\) => openForm\(m\)\}><Pencil size=\{12\} \/> Codes/);
  assert.doesNotMatch(page, /onClick=\{\(\) => setEditing\(m\)\}/, 'no door into the form that skips filling it');
  assert.match(page, /finally \{\s*takeApproval\(saved\);/, 'the gang toggle repaints once, and refreshes even after a refusal');
});

// ── For real: two transactions, one flag each ────────────────────────────────
// Opt-in, like the other *-pg tests: its OWN throwaway embedded Postgres, never
// DATABASE_URL.   ARTWORK_RACE_PG=1 node --test src/artwork-approval-race.test.js
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer(); srv.unref(); srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

describe('two approvals at once, against Postgres', {
  skip: process.env.ARTWORK_RACE_PG === '1' ? false : 'set ARTWORK_RACE_PG=1 to boot a throwaway Postgres',
  timeout: 120_000,
}, () => {
  let epg, dir, port, pg;
  const clients = new Set();
  const connect = async () => {
    const c = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', password: 'postgres', database: 'postgres' });
    await c.connect(); await c.query("SET lock_timeout = '5s'"); clients.add(c); return c;
  };
  before(async () => {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    ({ default: pg } = await import('pg'));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artwork-race-'));
    port = await freePort();
    epg = new EmbeddedPostgres({ databaseDir: dir, port, user: 'postgres', password: 'postgres', persistent: false, onLog: () => {}, onError: () => {} });
    await epg.initialise(); await epg.start();
    const c = await connect();
    await c.query(`CREATE TABLE order_lines (id int PRIMARY KEY, artwork_customer_ok int NOT NULL DEFAULT 0,
                   artwork_qa_ok int NOT NULL DEFAULT 0, artwork_locked int NOT NULL DEFAULT 0)`);
  });
  after(async () => {
    const within = (p, ms) => Promise.race([p.catch(() => {}), new Promise(r => setTimeout(r, ms).unref())]);
    for (const c of clients) await within(c.end(), 2000);
    if (epg) await within(epg.stop(), 10_000);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });
  const row = async (c, id) => (await c.query('SELECT artwork_customer_ok AS c, artwork_qa_ok AS q FROM order_lines WHERE id=$1', [id])).rows[0];

  test('the old read-both, write-both loses the first flag', async () => {
    const s = await connect();
    await s.query('INSERT INTO order_lines (id) VALUES (1)');
    const a = await connect(), b = await connect();
    await a.query('BEGIN'); await b.query('BEGIN');
    const ra = (await a.query('SELECT * FROM order_lines WHERE id=1')).rows[0];   // Customer toggle reads
    const rb = (await b.query('SELECT * FROM order_lines WHERE id=1')).rows[0];   // QA toggle reads
    await a.query('UPDATE order_lines SET artwork_customer_ok=$1, artwork_qa_ok=$2 WHERE id=1', [1, ra.artwork_qa_ok]);
    await a.query('COMMIT');
    await b.query('UPDATE order_lines SET artwork_customer_ok=$1, artwork_qa_ok=$2 WHERE id=1', [rb.artwork_customer_ok, 1]);
    await b.query('COMMIT');
    assert.deepEqual(await row(s, 1), { c: 0, q: 1 }, 'the race this fixes: Customer ✓ was lost');
  });

  test('each flag changed on its own keeps both, even with the second waiting on the first', async () => {
    const s = await connect();
    await s.query('INSERT INTO order_lines (id) VALUES (2)');
    const a = await connect(), b = await connect();
    await a.query('BEGIN'); await b.query('BEGIN');
    await a.query(APPROVAL_UPDATE, approvalParams(2, true, undefined));      // Customer ✓ — holds the row
    const bDone = b.query(APPROVAL_UPDATE, approvalParams(2, undefined, true)); // QA ✓ — waits on it
    await new Promise(r => setTimeout(r, 200));
    await a.query('COMMIT');
    assert.equal((await bDone).rowCount, 1);
    await b.query('COMMIT');
    assert.deepEqual(await row(s, 2), { c: 1, q: 1 }, 'both approvals stand');
  });

  test('an approval cleared while a lock waits keeps the line unlocked (the route answers 409)', async () => {
    const s = await connect();
    await s.query('INSERT INTO order_lines (id, artwork_customer_ok, artwork_qa_ok) VALUES (4, 1, 1)');
    const a = await connect(), b = await connect();
    await a.query('BEGIN'); await b.query('BEGIN');
    await a.query(APPROVAL_UPDATE, approvalParams(4, undefined, false));     // QA cleared — holds the row
    const lock = b.query(ARTWORK_LOCK, [4]);                                  // the lock route's statement
    await new Promise(r => setTimeout(r, 200));
    await a.query('COMMIT');
    assert.equal((await lock).rowCount, 0, 'the lock sees the cleared approval and does not land');
    await b.query('COMMIT');
    const r = (await s.query('SELECT artwork_locked, artwork_qa_ok FROM order_lines WHERE id=4')).rows[0];
    assert.deepEqual(r, { artwork_locked: 0, artwork_qa_ok: 0 });
  });

  test('two locks at once: the second finds the line locked and the route returns as already done', async () => {
    const s = await connect();
    await s.query('INSERT INTO order_lines (id, artwork_customer_ok, artwork_qa_ok) VALUES (5, 1, 1)');
    const a = await connect(), b = await connect();
    await a.query('BEGIN'); await b.query('BEGIN');
    assert.equal((await a.query(ARTWORK_LOCK, [5])).rowCount, 1);
    const second = b.query(ARTWORK_LOCK, [5]);
    await new Promise(r => setTimeout(r, 200));
    await a.query('COMMIT');
    assert.equal((await second).rowCount, 0, 'no second lock');
    const now = (await b.query('SELECT artwork_locked FROM order_lines WHERE id=5')).rows[0];
    assert.equal(now.artwork_locked, 1, 'the route\'s fallback read sees it locked → idempotent, no 409');
    await b.query('COMMIT');
  });

  test('a line locked while a toggle waits is left alone (the route answers 409)', async () => {
    const s = await connect();
    await s.query('INSERT INTO order_lines (id, artwork_customer_ok, artwork_qa_ok) VALUES (3, 1, 1)');
    const a = await connect(), b = await connect();
    await a.query('BEGIN'); await b.query('BEGIN');
    await a.query('UPDATE order_lines SET artwork_locked=1 WHERE id=3');
    const bDone = b.query(APPROVAL_UPDATE, approvalParams(3, false, undefined));
    await new Promise(r => setTimeout(r, 200));
    await a.query('COMMIT');
    assert.equal((await bDone).rowCount, 0, 'no row — the route turns that into a 409');
    await b.query('COMMIT');
    assert.deepEqual(await row(s, 3), { c: 1, q: 1 }, 'a locked line keeps its approvals');
  });
});
