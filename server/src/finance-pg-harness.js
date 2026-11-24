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
// A boot talks to its own Postgres and its own app, and to nothing else on the machine (Cash & Bank build, Task 17:
// under parallel boots, another local program sometimes answered a file's first request, a bare 404 or a body that
// was not JSON). A server listening on every address shares its port with a program that later listens on
// 127.0.0.1 alone, and connections to 127.0.0.1 then reach that program; so:
//   • the app is served on 127.0.0.1 alone (finServeOwn), on the port the kernel picks (listen(0), read back), behind
//     a front door that stamps every answer with a nonce of the boot's own (FIN_BOOT_HEADER). The boot proves the
//     nonce before any test runs (finProveOwn), and call() refuses an answer without it (finCaller): a stranger's
//     answer fails loudly, by name, and is never handed to a test as the app's;
//   • Postgres listens on 127.0.0.1 alone, the address the pool dials, so a port taken from under it stops it
//     starting (it is then started on another port) instead of leaving the pool to reach the taker; and the pool
//     checks it reached this boot's own cluster, by its data directory.
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
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

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

// ── The boot's own address ───────────────────────────────────────────────────────────────────

// Every answer of a boot's server carries this header, holding the boot's nonce; the front door answers FIN_BOOT_PATH itself,
// with the nonce as its body, before the app sees anything.
export const FIN_BOOT_HEADER = 'x-fin-boot';
const FIN_BOOT_PATH = '/__fin-boot';

const listenOn = (server, port, host) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, host, () => { server.off('error', reject); resolve(); });
});
const closeServer = server => new Promise(resolve => {
  if (!server?.listening) return resolve();
  server.close(() => resolve());
  server.closeAllConnections?.();
});

// What answered instead of the boot's app, in a few words: the status, the content type and the start of the body.
async function finWhatAnswered(res) {
  const text = await res.text().catch(() => '');
  const type = res.headers.get('content-type');
  return `status ${res.status}${type ? `, ${type}` : ''}, body ${JSON.stringify(text.slice(0, 120))}`;
}

// Serve `app` on 127.0.0.1 alone, on `port` (0, the default: the kernel picks one, read back), behind a front door that stamps
// every answer with a new nonce, and prove the address answers with that nonce before handing it back. A port another program holds
// on 127.0.0.1 is refused (EADDRINUSE), never shared. Answers { server, origin, base (origin + /api), nonce }.
export async function finServeOwn(app, { port = 0 } = {}) {
  const nonce = randomBytes(16).toString('hex');
  const server = http.createServer((req, res) => {
    res.setHeader(FIN_BOOT_HEADER, nonce);
    if (req.url === FIN_BOOT_PATH) {
      res.setHeader('content-type', 'text/plain');
      res.end(nonce);
      return;
    }
    app(req, res);
  });
  await listenOn(server, port, '127.0.0.1');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await finProveOwn(origin, nonce);
  } catch (e) {
    await closeServer(server);
    throw e;
  }
  return { server, origin, base: `${origin}/api`, nonce };
}

// That `origin` is the server holding `nonce`: its front door echoes the nonce, in its body and in its header. Throws, saying what
// answered, when anything else does.
export async function finProveOwn(origin, nonce) {
  let res;
  try {
    res = await fetch(origin + FIN_BOOT_PATH);
  } catch (e) {
    throw new Error(`${origin} did not answer the boot's own probe (${e?.cause?.code ?? e?.message ?? e})`);
  }
  const header = res.headers.get(FIN_BOOT_HEADER);
  if (res.status === 200 && header === nonce && (await res.clone().text()) === nonce) return;
  throw new Error(`${origin} was answered by another program, not this boot's app (${await finWhatAnswered(res)})`);
}

// The boot's call(method, url, body, who) → { status, body }, as `who` (a key of `users`). An answer that does not carry the boot's
// nonce came from another program: it throws, saying what answered, rather than hand the test a stranger's 404 as the app's.
export function finCaller(label, base, nonce, users) {
  return async (method, url, body = null, who = 'md') => {
    if (!users[who]) throw new Error(`finBootPg call(): no login called '${who}'; the logins are ${Object.keys(users).join(', ')}`);
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${users[who].token}` },
      body: body == null ? undefined : JSON.stringify(body),
    });
    if (res.headers.get(FIN_BOOT_HEADER) !== nonce) {
      throw new Error(`finBootPg('${label}') call(): ${method} ${url} was answered by another program on ${base}, not this boot's app `
        + `(${await finWhatAnswered(res)})`);
    }
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, body: json };
  };
}

// ── The boot's own Postgres ──────────────────────────────────────────────────────────────────

// Starts are tried on this many free ports: a port taken between freePort()'s probe and Postgres' own bind stops that start.
const FIN_PG_STARTS = 3;

// Initialise `dir` and start a Postgres on it, listening on 127.0.0.1 alone (not on ::1 too, as it would by default): a port another
// program took meanwhile then stops Postgres at once, as it cannot make its one socket, and it is started again on another port.
// `nextPort` gives each try's port (a test hands it a taken one first). Answers { epg, port }.
export async function finStartPg(EmbeddedPostgres, dir, { nextPort = freePort } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    const port = await nextPort();
    const said = [];
    const epg = new EmbeddedPostgres({
      databaseDir: dir, port, user: 'postgres', password: 'postgres', persistent: false,
      postgresFlags: ['-c', 'listen_addresses=127.0.0.1'],
      onLog: text => { said.push(String(text)); if (said.length > 5) said.shift(); },
      onError: () => {},
    });
    if (attempt === 1) await epg.initialise();
    try {
      await epg.start();
      return { epg, port };
    } catch {
      // A Postgres that never started has exited. embedded-postgres' stop() waits for an exit it has already seen, at close() and
      // again when this process ends (it stops every cluster it made), so it is told there is nothing to stop.
      epg.process = undefined;
      if (attempt >= FIN_PG_STARTS) {
        throw new Error(`Postgres did not start on any of ${FIN_PG_STARTS} free ports; it last said: ${said.join('').trim().slice(-400)}`);
      }
    }
  }
}

// The same directory, however the path is spelt (the temp dir sits behind a symlink on macOS).
const finSameDir = (a, b) => {
  const real = p => { try { return fs.realpathSync(p); } catch { return p; } };
  return typeof a === 'string' && typeof b === 'string' && real(a) === real(b);
};

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
    try { await closeServer(server); } catch {}
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
    let port;
    ({ epg, port } = await finStartPg(EmbeddedPostgres, dir));

    const dbUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
    process.env.DATABASE_URL = dbUrl;
    process.env.PG_POOL_MAX = '1';
    const db = await import('./db.js');
    pool = await db.connect();
    // First boot in this process: the pool was just built for this URL. Later boots: it is the pool the last
    // boot left behind, so aim its next connection at this Postgres.
    pool.options.connectionString = dbUrl;
    if (!quietPools.has(pool)) { quietPools.add(pool); pool.on('error', () => {}); }
    // This boot's own cluster: its port, and its data directory, which no other Postgres can have.
    const at = await db.one(`SELECT inet_server_port()::int AS port, current_setting('data_directory') AS dir`);
    if (at?.port !== port || !finSameDir(at?.dir, dir)) {
      throw new Error(`finBootPg('${label}'): the pool is attached to the Postgres of ${at?.dir} on port ${at?.port}, not this boot's `
        + `(${dir}, port ${port})`);
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

    // The app on 127.0.0.1 alone, its nonce proved before any test runs (see the top).
    const { default: app } = await import('./app.js');
    const own = await finServeOwn(app);
    server = own.server;
    const { base } = own;
    const call = finCaller(label, base, own.nonce, users);

    return { db, base, users, call, close };
  } catch (e) {
    await close();
    throw e;
  }
}
