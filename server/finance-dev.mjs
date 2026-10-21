// A local server to walk the Finance module through in a browser (plan Task 19, step 5). It is NOT part of the app:
// nothing imports it, no test runs it, and the Vercel function (api/index.js) never reaches it. It lives in server/,
// not server/src/, because `embedded-postgres` has to resolve from this script's folder.
//
//   node server/finance-dev.mjs
//
//   FIN_DEV_DIR   where it keeps everything it makes        default  $TMPDIR/ci-erp-finance-dev
//   FIN_DEV_PORT  the API's port                            default  4931
//
// FIN_DEV_DIR holds pgdata/ (the database), postgres.log (the last run's), jwt-secret, tokens.json and server.pid.
//
// What it does, in order:
//   1. starts an embedded Postgres of its own, kept in FIN_DEV_DIR/pgdata, on a free port;
//   2. runs the app's own init() (the schema and the Finance migration) and the demo seed;
//   3. makes three logins if they are not there: md@fin.dev, acct@fin.dev and plant@fin.dev, all plant admins;
//   4. sets up both books with finSetupBooks: md is approver + admin on CI and DP, acct is accountant on both, and
//      plant holds no Finance grant at all;
//   5. writes FIN_DEV_DIR/tokens.json, { md: { token, user }, acct: {…}, plant: {…} }: the pair a browser keeps as
//      `ci_token` and `ci_user`, so the walkthrough signs in by writing those two keys and reloading;
//   6. serves the real Express app on FIN_DEV_PORT, on the loopback addresses only (127.0.0.1 and ::1), never on the
//      network.
//
// Run it twice and nothing is doubled: the logins, the books, the years and the grants are all found again, and what
// the walkthrough posted last time is still there. To start from nothing, stop it and delete FIN_DEV_DIR.
//
// Local by construction. DATABASE_URL is SET here, over whatever the shell holds, to the embedded Postgres on
// 127.0.0.1, and the escape hatch for remote schema work is deleted, so this can never reach the plant's database.
// The passwords are random and thrown away (the way in is the token, not the form), and the tokens are signed with
// a secret of its own, made once and kept in FIN_DEV_DIR/jwt-secret, never with a JWT_SECRET the shell holds: a token
// signed with a real secret would be a real token. tokens.json and jwt-secret are mode 0600 and stay outside the repo.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const dir = path.resolve(process.env.FIN_DEV_DIR || path.join(os.tmpdir(), 'ci-erp-finance-dev'));
const apiPort = Number(process.env.FIN_DEV_PORT) || 4931;
const pgdata = path.join(dir, 'pgdata');
const tokensFile = path.join(dir, 'tokens.json');
const logFile = path.join(dir, 'postgres.log');
const pidFile = path.join(dir, 'server.pid');
const say = (...a) => console.log('[finance-dev]', ...a);
// What to do when Postgres will not start on the data directory (a lock file it cannot clear, or a folder a clean-up has
// half emptied). The directory holds the walkthrough's throwaway data and nothing else, so the way out is always this.
const RESET = `Stop any finance-dev that is running, delete ${dir} (it holds only the walkthrough's throwaway data), and run this again.`;

// Three invented logins. All are plant admins, as the test harness has them: the plant `role` plays no part in Finance
// (finance-access.js), and plant@, an admin with no grant, is the login that shows it.
const LOGINS = Object.freeze({
  md:    { email: 'md@fin.dev',    name: 'Dev MD',          role: 'admin' },
  acct:  { email: 'acct@fin.dev',  name: 'Dev Accountant',  role: 'admin' },
  plant: { email: 'plant@fin.dev', name: 'Dev Plant Admin', role: 'admin' },
});
const GRANTS = [
  { email: LOGINS.md.email,   roles: ['approver', 'admin'], books: ['CI', 'DP'] },
  { email: LOGINS.acct.email, roles: ['accountant'],        books: ['CI', 'DP'] },
];

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.unref();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// The command line of a process, or '' when there is no such process.
const commandOf = pid => {
  try { return execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' }); } catch { return ''; }
};
// The pid on the first line of a file, or 0.
const pidIn = file => {
  try { const n = Number(fs.readFileSync(file, 'utf8').split('\n')[0]); return Number.isInteger(n) && n > 1 ? n : 0; } catch { return 0; }
};

// A Postgres of ours that outlived a run (the run was killed hard, so its exit hook never stopped the cluster)
// still holds the data directory, and a second one cannot start on it. Stop it, but only if the pid in OUR data
// directory's postmaster.pid is a postgres running on OUR data directory (`-D <pgdata>`). A lock file whose pid now
// belongs to some other program, another cluster included, is left alone: Postgres clears a lock whose pid is dead, but
// it refuses to start while that pid is alive, whatever the program is, and this script will not delete a lock it cannot
// prove is stale. Postgres then does not start, and the message says to delete the data directory (RESET).
async function stopLeftoverPostgres() {
  const pid = pidIn(path.join(pgdata, 'postmaster.pid'));
  if (!pid || !commandOf(pid).includes(`-D ${pgdata}`)) return;
  say(`a Postgres from the last run (pid ${pid}) is still up on this data directory; stopping it`);
  process.kill(pid, 'SIGINT');
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch { return; }
    await sleep(100);
  }
  throw new Error(`Postgres pid ${pid} did not stop. ${RESET}`);
}

fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
// Two servers on one data directory would fight over one Postgres, and the second would stop the first's. If server.pid
// names a live finance-dev, say so and leave it alone; a dead pid, or one that is now some other program, is a leftover.
const owner = pidIn(pidFile);
if (owner && owner !== process.pid && commandOf(owner).includes('finance-dev.mjs')) {
  console.error(`[finance-dev] already running (pid ${owner}) on ${dir}. Stop it first, or set FIN_DEV_DIR to another folder.`);
  process.exit(1);
}
fs.writeFileSync(pidFile, `${process.pid}\n`);
process.on('exit', () => { if (pidIn(pidFile) === process.pid) fs.rmSync(pidFile, { force: true }); });
fs.rmSync(tokensFile, { force: true });        // a tokens.json that is there belongs to THIS run, never to one that is gone
await stopLeftoverPostgres().catch(e => { console.error('[finance-dev] could not start:', e.message); process.exit(1); });

// ── 1. Postgres ──────────────────────────────────────────────────────────────────────────────────
const { default: EmbeddedPostgres } = await import('embedded-postgres');
const pgLog = fs.createWriteStream(logFile, { flags: 'w' });
const port = await freePort();
const epg = new EmbeddedPostgres({
  databaseDir: pgdata, port, user: 'postgres', password: 'postgres', persistent: true,
  postgresFlags: ['-c', 'listen_addresses=127.0.0.1'],
  onLog: text => pgLog.write(text), onError: text => pgLog.write(String(text?.message ?? text ?? '')),
});
// Stops the cluster, if there is one to stop. Postgres that refused to start has already exited, and embedded-postgres'
// stop() waits for an exit it will never see again, so a dead child is not waited for.
const stopPostgres = async () => {
  const child = epg.process;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try { await epg.stop(); } catch {}
};
const fail = async e => { console.error('[finance-dev] could not start:', e?.message ?? e ?? '(no message; see the Postgres log)'); await stopPostgres(); process.exit(1); };

try {
  // No PG_VERSION means no cluster: either the first run, or one that died inside initdb, which leaves a
  // directory initdb will not use again.
  if (!fs.existsSync(path.join(pgdata, 'PG_VERSION'))) {
    fs.rmSync(pgdata, { recursive: true, force: true });
    await epg.initialise();
  }
  await epg.start();
} catch (e) { await fail(new Error(`Postgres did not start${e ? ` (${e.message ?? e})` : ''}. See ${logFile}. ${RESET}`)); }

// ── 2. The app's own database setup, against that Postgres and no other ───────────────────────────────
let secret = '';
const secretFile = path.join(dir, 'jwt-secret');
try { secret = fs.readFileSync(secretFile, 'utf8').trim(); } catch {}
if (secret.length < 32) { secret = randomBytes(32).toString('hex'); fs.writeFileSync(secretFile, `${secret}\n`, { mode: 0o600 }); }

process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
process.env.JWT_SECRET = secret;
delete process.env.ALLOW_REMOTE_SCHEMA_SYNC;
delete process.env.LIVE_DB_ENV_FILE;

// Dynamic imports, after the environment is set: auth.js reads JWT_SECRET the moment it loads.
const db = await import('./src/db.js');
try {
  const pool = await db.connect();
  pool.on('error', () => {});                    // a Postgres that stops under an idle client is not news
  const at = await db.one('SELECT inet_server_port()::int AS port');
  if (at?.port !== port) throw new Error(`the pool is attached to Postgres port ${at?.port}, not the embedded one on ${port}`);
  await db.init();
  const { seedIfEmpty } = await import('./src/seed.js');
  await seedIfEmpty();

  // ── 3. Logins ──────────────────────────────────────────────────────────────────────────────────
  const { default: bcrypt } = await import('bcryptjs');
  const ids = {};
  for (const [key, l] of Object.entries(LOGINS)) {
    const have = await db.one('SELECT id FROM users WHERE lower(email) = lower($1)', [l.email]);
    ids[key] = have ? have.id : (await db.one(
      `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id`,
      [l.name, l.email, bcrypt.hashSync(randomBytes(18).toString('base64url'), 10), l.role])).id;
  }

  // ── 4. The books and the grants ────────────────────────────────────────────────────────────────
  const { finSetupBooks } = await import('./src/finance-setup.js');
  const setup = await db.tx((qc, oc) => finSetupBooks(qc, oc, { grants: GRANTS, actor: 'system (finance-dev)' }));
  for (const b of setup.books) say(`book ${b.code}: ${b.created ? 'set up' : 'already there'}`);

  // ── 5. Tokens ──────────────────────────────────────────────────────────────────────────────────
  // Signed as /auth/login signs a "keep me signed in" session: { id, name, role }, no expiry. `user` is the shape
  // /auth/me answers (userView in auth.js); the app shell fetches the real one on load anyway.
  const { default: jwt } = await import('jsonwebtoken');
  const { JWT_SECRET } = await import('./src/auth.js');
  if (JWT_SECRET !== secret) throw new Error('auth.js signed with a secret other than this one');
  const out = {};
  for (const [key, l] of Object.entries(LOGINS)) {
    const u = await db.one(
      `SELECT id, name, email, role, modules, sections, fluence_tabs, machine_ids, landing_path,
              xs_approver, is_management, reverse_approver, avs_approver FROM users WHERE id = $1`, [ids[key]]);
    out[key] = {
      token: jwt.sign({ id: u.id, name: u.name, role: u.role }, JWT_SECRET),
      user: {
        id: u.id, name: u.name, email: u.email, role: u.role,
        modules: u.modules ?? null, sections: u.sections ?? null, fluence_tabs: u.fluence_tabs ?? null,
        machine_ids: u.machine_ids ?? null, landing_path: u.landing_path ?? null,
        xs_approver: +(u.xs_approver ?? 0), is_management: +(u.is_management ?? 0),
        reverse_approver: +(u.reverse_approver ?? 0), avs_approver: +(u.avs_approver ?? 0),
      },
    };
  }
  fs.writeFileSync(`${tokensFile}.tmp`, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(`${tokensFile}.tmp`, tokensFile);

  // ── 6. Serve ───────────────────────────────────────────────────────────────────────────────────
  const { default: app } = await import('./src/app.js');
  // Loopback only: this is a one-machine walkthrough server with admin logins, and nothing on the network should reach it.
  // Vite listens on ::1 here and a browser or a proxy may resolve `localhost` to either loopback address, so both are
  // bound; a machine without IPv6 has the one.
  const listen = host => new Promise((resolve, reject) => {
    const server = app.listen(apiPort, host, resolve);
    server.once('error', reject);
  });
  await listen('127.0.0.1');
  await listen('::1').catch(e => { if (!['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(e?.code)) throw e; });

  // The tokens must be ones this very server accepts. What each login may do is not checked: a walkthrough changes
  // grants, and the next start must not refuse to run because of it.
  for (const [key, { token }] of Object.entries(out)) {
    const res = await fetch(`http://127.0.0.1:${apiPort}/api/finance/me`, { headers: { authorization: `Bearer ${token}` } });
    if (res.status !== 200) throw new Error(`GET /api/finance/me as ${key} answered ${res.status}: the token was not accepted`);
  }
} catch (e) {
  if (e?.code === 'EADDRINUSE') await fail(new Error(`port ${apiPort} is in use; set FIN_DEV_PORT to another`));
  await fail(e);
}

say(`data     ${dir}`);
say(`postgres 127.0.0.1:${port} (its own, kept between runs)`);
say(`logins   ${Object.values(LOGINS).map(l => l.email).join(', ')}   (tokens: ${tokensFile})`);
say(`ready    http://localhost:${apiPort}/api`);
