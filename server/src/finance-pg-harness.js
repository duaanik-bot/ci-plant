// Real-database harness for the Finance tests that opt in with FINANCE_PG=1.
//
//   const h = await finBootPg('vouchers');                    // books, years, groups, rules and grants all set up
//   const h = await finBootPg('schema', { setup: false });    // the bare schema: no books, no grants
//   try {
//     await h.db.q('SELECT ...');                              // the app's own db.js
//     const r = await h.call('POST', '/finance/vouchers', body, 'acct');   // → { status, body }
//   } finally { await h.close(); }
//
// Each boot is its own throwaway Postgres (a temp dir, a free port, never kept) that runs the app's real
// init() and demo seed, gets the six logins of FIN_TEST_USERS, and is served by the real Express app on a
// free port. Modelled on direct-invoice-pg.test.js. PG_POOL_MAX=1 is the Vercel geometry: a pool call made
// inside a transaction hangs, so the tests must use the tx() client, as production code does.
//
// Not a *.test.js, so `npm test` never runs it, and no app code imports it. The files that use it gate
// themselves on FINANCE_PG=1.
//
// db.js keeps ONE pool for the whole process, so:
//   • boots in one process run one after another; a second finBootPg() while one is open throws;
//   • a later boot points that same pool at its own new Postgres (the previous close() destroyed the pool's
//     client), and checks it got there;
//   • whatever the app keeps in module memory survives from one boot to the next. Prefer one boot per file.
//     (close() clears Finance's own, the 10 s hold of who-may-do-what in finance-access.js, because user ids
//     start again from 1 in every new database. Anything else the app holds is the test's to clear.)
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.unref();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

const deepFreeze = v => {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); Object.values(v).forEach(deepFreeze); }
  return v;
};

// Six logins. Only the plant role is set here; what each may do in Finance is FIN_TEST_GRANTS.
export const FIN_TEST_USERS = deepFreeze({
  md:     { email: 'md@fin.test',     role: 'admin' },
  acct:   { email: 'acct@fin.test',   role: 'admin' },
  appr2:  { email: 'appr2@fin.test',  role: 'planner' },
  viewer: { email: 'viewer@fin.test', role: 'viewer' },
  dpOnly: { email: 'dp@fin.test',     role: 'admin' },
  plant:  { email: 'plant@fin.test',  role: 'admin' },    // a plant admin with no Finance grant at all
});
const DISPLAY_NAMES = {
  md: 'Test MD', acct: 'Test Accountant', appr2: 'Test Second Approver',
  viewer: 'Test Viewer', dpOnly: 'Test DP Accountant', plant: 'Test Plant Admin',
};

// The shape finSetupBooks takes: grants keyed by email, books by code.
export const FIN_TEST_GRANTS = deepFreeze([
  { email: FIN_TEST_USERS.md.email,     roles: ['approver', 'admin'], books: ['CI', 'DP'] },
  { email: FIN_TEST_USERS.acct.email,   roles: ['accountant'],        books: ['CI', 'DP'] },
  { email: FIN_TEST_USERS.appr2.email,  roles: ['approver'],          books: ['CI'] },
  { email: FIN_TEST_USERS.viewer.email, roles: ['viewer'],            books: ['CI'], can_export: false },
  { email: FIN_TEST_USERS.dpOnly.email, roles: ['accountant'],        books: ['DP'] },
]);

let openLabel = null;            // the boot that is open in this process
const quietPools = new WeakSet(); // pools that already carry the no-op 'error' listener

export async function finBootPg(label, { setup = true } = {}) {
  if (openLabel) {
    throw new Error(`finBootPg('${label}'): '${openLabel}' is still open. Close it first; db.js keeps one pool per process.`);
  }
  openLabel = label;
  const saved = { url: process.env.DATABASE_URL, poolMax: process.env.PG_POOL_MAX };
  let epg, dir, pool, server, closed = false;

  const close = async () => {
    if (closed) return;
    closed = true;
    // Finance holds who-may-do-what for 10 s per process (finance-access.js), and user ids repeat from one
    // boot to the next, so a grant held for a user of THIS boot would be served to the next boot's user of
    // the same id. Best-effort: a boot may close before that module exists, or before it ever loaded.
    try { (await import('./finance-access.js')).finForgetAccess(); } catch {}
    try {
      if (server) await new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections?.(); });
    } catch {}
    // The pool keeps one client. Destroy it now, while its Postgres is still up, so db.js's pool is empty
    // for the next boot and never sees a dead idle connection.
    try { if (pool) (await pool.connect()).release(true); } catch {}
    try { await epg?.stop(); } catch {}      // persistent:false, so this removes the data directory too
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of [['DATABASE_URL', saved.url], ['PG_POOL_MAX', saved.poolMax]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    openLabel = null;
  };

  try {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), `fin-${String(label).replace(/[^\w-]/g, '_')}-`));
    const port = await freePort();
    epg = new EmbeddedPostgres({
      databaseDir: dir, port, user: 'postgres', password: 'postgres',
      persistent: false, onLog: () => {}, onError: () => {},
    });
    await epg.initialise();
    await epg.start();

    const dbUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
    process.env.DATABASE_URL = dbUrl;
    process.env.PG_POOL_MAX = '1';
    const db = await import('./db.js');
    pool = await db.connect();
    // First boot in this process: the pool was just built for this URL. Later boots: it is the pool the last
    // boot left behind, so aim its next connection at this Postgres.
    pool.options.connectionString = dbUrl;
    if (!quietPools.has(pool)) { quietPools.add(pool); pool.on('error', () => {}); }
    const at = await db.one('SELECT inet_server_port()::int AS port');
    if (at?.port !== port) {
      throw new Error(`finBootPg('${label}'): the pool is attached to Postgres port ${at?.port}, not ${port}`);
    }

    await db.init();
    const { seedIfEmpty } = await import('./seed.js');
    await seedIfEmpty();

    const { default: jwt } = await import('jsonwebtoken');
    const { JWT_SECRET } = await import('./auth.js');
    const users = {};
    for (const [key, u] of Object.entries(FIN_TEST_USERS)) {
      const row = await db.one(
        `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, 'x', $3) RETURNING id, name, role`,
        [DISPLAY_NAMES[key], u.email, u.role]);
      users[key] = { id: row.id, token: jwt.sign({ id: row.id, name: row.name, role: row.role }, JWT_SECRET) };
    }

    if (setup) {
      // Task 4's module, loaded only here so a bare-schema boot (setup:false) needs nothing but the migration.
      const { finSetupBooks } = await import('./finance-setup.js');
      await db.tx((qc, oc) => finSetupBooks(qc, oc, { grants: FIN_TEST_GRANTS }));
    }

    const { default: app } = await import('./app.js');
    server = await new Promise((resolve, reject) => {
      const s = app.listen(0, () => resolve(s));
      s.once('error', reject);
    });
    const base = `http://127.0.0.1:${server.address().port}/api`;

    const call = async (method, url, body = null, who = 'md') => {
      if (!users[who]) throw new Error(`finBootPg call(): no login called '${who}'; the logins are ${Object.keys(users).join(', ')}`);
      const res = await fetch(base + url, {
        method,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${users[who].token}` },
        body: body == null ? undefined : JSON.stringify(body),
      });
      let json = null; try { json = await res.json(); } catch {}
      return { status: res.status, body: json };
    };

    return { db, base, users, call, close };
  } catch (e) {
    await close();
    throw e;
  }
}
