// READ-ONLY preview of the LIVE plant database.
//
// Anik regularly asks to "see the local UI against live data". This is the
// sanctioned way, and it is NOT `server/src/index.js` — that boots with init()
// plus the demo seed, which would push DDL and invented rows into the running
// plant. This mirrors `api/index.js`, the Vercel entry: connect() and nothing
// else.
//
// Three independent guards, because one is a promise and three is a mechanism:
//
//   1. connect() ONLY — no init(), no seedAdminIfMissing(), no seedIfEmpty(),
//      and ALLOW_REMOTE_SCHEMA_SYNC is deleted so the schema-sync escape hatch
//      is unavailable even if something below reached for it.
//   2. The SESSION pooler (5432), never the transaction pooler (6543) — see
//      the long note below. This is what stops guard 3 leaking onto the live app.
//   3. Every pooled connection is put in `default_transaction_read_only`, so
//      Postgres itself refuses any INSERT/UPDATE/DELETE that reaches it. The UI
//      stays fully browsable; a write errors instead of changing the plant.
//
// Credentials come from ~/.config/ci-erp/live-db.env (0600) and are never
// written anywhere else. That role is the `postgres` SUPERUSER — it is NOT a
// read-only login, whatever older notes claimed. Guard 3 is the only thing
// making this session read-only, which is exactly why guard 2 matters.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const envPath = `${homedir()}/.config/ci-erp/live-db.env`;
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (!process.env.DATABASE_URL) throw new Error(`No DATABASE_URL in ${envPath}`);
if (/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL)) {
  throw new Error('That DATABASE_URL is local — use the normal dev server instead.');
}
delete process.env.ALLOW_REMOTE_SCHEMA_SYNC;

// ── Guard 2: the SESSION pooler, or the read-only flag escapes ───────────────
// The env file points at Supavisor in TRANSACTION mode (`:6543`,
// `pgbouncer=true`), where a client gets a different backend per transaction.
// A session-level SET therefore belongs to the BACKEND, not to the client that
// issued it, and the pooler hands that backend to whoever connects next.
//
// This is not hypothetical. On 2026-08-02 this script left three backends stuck
// read-only; unrelated writes later died with "cannot execute SELECT FOR UPDATE
// in a read-only transaction", and six of eight succeeded before a poisoned
// backend rotated back in. pg_stat_activity shows the live Vercel app using the
// SAME `postgres` role through the SAME pool — so a poisoned backend can be
// handed to motionci.in and break production writes.
//
// Session mode gives one client its own backend for the connection's lifetime
// and resets it on release, so the flag cannot travel. Rewrite with URL(), never
// a regex: stripping `?pgbouncer=true` textually leaves `&connection_limit=1`
// glued to the database name and Postgres reports
// `database "postgres&connection_limit=1" does not exist`.
{
  const u = new URL(process.env.DATABASE_URL);
  u.port = '5432';
  u.searchParams.delete('pgbouncer');
  process.env.DATABASE_URL = u.toString();
}

// ── The price of guard 2: session mode caps CLIENTS, not just backends ───────
// db.js sizes the pool at 20 because the dashboard alone fans out ~19 concurrent
// queries — a figure chosen for the TRANSACTION pooler, which multiplexes them
// onto few backends. Session mode dedicates a backend per client and Supavisor
// caps that at pool_size 15, so the unaltered 20 made the dashboard's own fan-out
// exceed the cap: every load logged
//   (EMAXCONNSESSION) max clients reached in session mode
// as FATAL XX000 and the Command Centre came up empty on live data.
//
// Capped below 15 rather than raised: pg-pool QUEUES past its max, so the same
// 19 queries still run, just through 10 connections. A slightly slower dashboard
// is the correct trade for a guard that cannot leak onto motionci.in.
process.env.PG_POOL_MAX = process.env.PG_POOL_MAX || '10';

const { default: app } = await import('./server/src/app.js');
const { connect } = await import('./server/src/db.js');

const pool = await connect();
// Fires for every new physical client the pool opens, including ones it opens
// later under load — so there is no window where a connection is writable.
pool.on('connect', c => { c.query('SET default_transaction_read_only = on').catch(() => {}); });
await pool.query('SET default_transaction_read_only = on').catch(() => {});

// Prove the guard is live before serving one request. A preview that silently
// allows writes is worse than no preview at all.
try {
  await pool.query('CREATE TEMP TABLE _rw_probe(x int)');
  throw new Error('READ-ONLY GUARD FAILED — the connection accepted a write. Refusing to start.');
} catch (e) {
  if (!/read-only|cannot execute/i.test(e.message)) throw e;
  console.log('read-only guard verified —', e.message.split('\n')[0]);
}

// ── Guard 3a: the one write a read-only session legitimately needs ───────────
// Signing in is a read that ends in a write. auth.js checks the password, mints
// the token, and only then records a `login` row in audit_log — so under guard 3
// Postgres refuses with 25006, the error reaches the error handler, and a
// CORRECT password comes back as a 500. Nobody can open the preview at all.
//
// Swallow exactly that statement: INSERT INTO audit_log becomes a no-op that
// resolves like an empty write. Everything else still meets the read-only wall,
// so the plant stays untouchable and a real edit still fails loudly — which is
// the honest signal, since this preview must never change production. An audit
// row saying someone browsed a read-only mirror is noise nobody wants anyway.
//
// Wrapping pool.query covers db.js's q()/one(), which is the path login uses.
// tx() runs on its own client and is deliberately left alone: a transaction only
// reaches its audit call after a business write, and that write must still fail.
const AUDIT_INSERT = /^\s*insert\s+into\s+audit_log\b/i;
const realQuery = pool.query.bind(pool);
pool.query = (text, ...rest) => {
  const sql = typeof text === 'string' ? text : text?.text;
  if (sql && AUDIT_INSERT.test(sql)) {
    const result = { rows: [], rowCount: 0, command: 'INSERT', fields: [] };
    const cb = rest.find(a => typeof a === 'function');
    if (cb) return void cb(null, result);
    return Promise.resolve(result);
  }
  return realQuery(text, ...rest);
};

const host = process.env.DATABASE_URL.replace(/^[^@]*@/, '').split('/')[0];
console.log(`⚠️  LIVE DATABASE (read-only) — ${host}`);
console.log('login audit writes are dropped, not sent — every other write still fails');

const PORT = process.env.PORT || 4900;
app.listen(PORT, () => console.log(`CI ERP (LIVE DB, read-only) → http://localhost:${PORT}`));
