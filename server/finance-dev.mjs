// A local server to walk the Finance module through in a browser (plan Task 19, step 5). It is NOT part of the app:
// nothing imports it, no test runs it, and the Vercel function (api/index.js) never reaches it. It lives in server/,
// not server/src/, because `embedded-postgres` has to resolve from this script's folder.
//
//   node server/finance-dev.mjs [--cash-demo] [--books-begin=YYYY-MM-DD]
//
//   --cash-demo       also seeds the Cash & Bank walkthrough's invented data (Cash & Bank plan, Task 17; below)
//   --books-begin=…   the day both books begin, the 1st of a month. Default: with --cash-demo, the 1st of the plant's
//                     current month (so the walkthrough's entries, dated today, fall inside the books, and the ERP's
//                     after-the-date doors show); without it, 2027-01-01, the go-live.
//
//   FIN_DEV_DIR   where it keeps everything it makes        default  $TMPDIR/ci-erp-finance-dev
//                                                                    ($TMPDIR/ci-erp-finance-cash-demo with --cash-demo)
//   FIN_DEV_PORT  the API's port                            default  4931
//
// FIN_DEV_DIR holds pgdata/ (the database), postgres.log (the last run's), jwt-secret, tokens.json and server.pid.
//
// What it does, in order:
//   1. starts an embedded Postgres of its own, kept in FIN_DEV_DIR/pgdata, on a free port;
//   2. runs the app's own init() (the schema and the Finance migration) and the demo seed;
//   3. makes three logins if they are not there: md@fin.dev, acct@fin.dev and plant@fin.dev, all plant admins;
//   4. sets up both books with finSetupBooks, beginning on the books-begin day: md is approver + admin on CI and DP,
//      acct is accountant on both, and plant holds no Finance grant at all. Books already there that begin on another
//      day stop the run: they are kept as they are, so the day cannot be changed under them;
//   5. writes FIN_DEV_DIR/tokens.json, { md: { token, user }, acct: {…}, plant: {…} }: the pair a browser keeps as
//      `ci_token` and `ci_user`, so the walkthrough signs in by writing those two keys and reloading;
//   6. serves the real Express app on FIN_DEV_PORT, on the loopback addresses only (127.0.0.1 and ::1), never on the
//      network;
//   7. with --cash-demo, seeds the walkthrough (seedCashDemo, below) through that very server's routes, as the two
//      logins would in a browser, and HR's rows with SQL, as HR writes them (finance-hr-fixtures.js).
//
// Run it twice and nothing is doubled: the logins, the books, the years, the grants and the demo are all found again,
// and what the walkthrough posted last time is still there. To start from nothing, stop it and delete FIN_DEV_DIR.
//
// The cash demo (every name and figure invented), in the CI book, with B the day the books begin, O the day before
// (the Opening) and E the last day of B's month (the salary day):
//   • the Opening, through the Tally import, as at O: Office cash (the built-in Cash ledger, renamed) ₹2,00,000,
//     Bank – current ₹15,00,000, Acme Pharma owing ₹95,000 (an opening lump of ₹20,000 with no bill, bill 0091
//     ₹35,000 of O's month's 2nd and bill 0104 ₹40,000 of its 18th: the spec's §5.1 sketch, so Receive ₹80,000 with
//     TDS ₹1,600 by Auto settles the lump and 0091 and leaves ₹13,400 of 0104), Juno Test Packaging owed ₹1,80,000
//     (bill V-11), and Capital A/c; built by acct and approved by md;
//   • Cash with Holder A (held by "Holder A", float ₹50,000), given ₹10,000 from Office cash on B (§9.2), so Top up
//     offers ₹40,000; Test Freight, an expense to pay; TDS Receivable and TDS Payable; Cash Short & Excess; Rounding
//     Off, Staff Deductions and Advance Waivers, with their roles;
//   • the staff ledgers (finEnsureStaffLedgers), and HR's two pay channels mapped: CASH to Office cash, COLOUR to
//     Bank – current; md is HR admin and acct HR accounts;
//   • in HR, five people, Test Person A–E, all Colour's (A–C paid in cash, D and E by the Colour bank): an advance to A
//     by Pay staff on B+4; advance sheet CI-ADV-0001 paid in cash on B+13 to B, C and D; B's month's payroll, approved
//     and finalised by md on E; and its two payment batches, CI-PAY-0001 (cash: A, B, C) and CI-PAY-0002 (bank: D, E),
//     paid on E. None of HR's money is posted: it all waits for the walkthrough's Bring in from HR (five entries).
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
import { createHash, randomBytes } from 'node:crypto';

// ── The command line ─────────────────────────────────────────────────────────────────────────────
const USAGE = 'node server/finance-dev.mjs [--cash-demo] [--books-begin=YYYY-MM-DD]';
let cashDemo = false;
let booksBeginArg = null;
for (const arg of process.argv.slice(2)) {
  if (arg === '--cash-demo') cashDemo = true;
  else if (arg.startsWith('--books-begin=')) booksBeginArg = arg.slice('--books-begin='.length);
  else { console.error(`[finance-dev] unknown argument ${arg}. Usage: ${USAGE}`); process.exit(2); }
}
const { plantDateStr } = await import('./src/plant-calendar.js');
const today = plantDateStr();
// The day the books begin: the 1st of a month (finSetupBooks' ruling R74), a real day.
const booksBegin = booksBeginArg ?? (cashDemo ? `${today.slice(0, 7)}-01` : '2027-01-01');
if (!/^\d{4}-\d{2}-01$/.test(booksBegin) || new Date(`${booksBegin}T00:00:00Z`).toISOString().slice(0, 10) !== booksBegin) {
  console.error(`[finance-dev] --books-begin=${booksBegin} is not the 1st of a month written YYYY-MM-DD. Usage: ${USAGE}`);
  process.exit(2);
}

const dir = path.resolve(process.env.FIN_DEV_DIR || path.join(os.tmpdir(), cashDemo ? 'ci-erp-finance-cash-demo' : 'ci-erp-finance-dev'));
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
// The cash demo's names (--cash-demo; seedCashDemo at the end), every one invented.
const DEMO = Object.freeze({
  office: 'Office cash', bank: 'Bank – current', customer: 'Acme Pharma', vendor: 'Juno Test Packaging', capital: 'Capital A/c',
  holderLedger: 'Cash with Holder A', holder: 'Holder A', freight: 'Test Freight',
  people: Object.freeze(['Test Person A', 'Test Person B', 'Test Person C', 'Test Person D', 'Test Person E']),
});
const R = 100;   // paise per rupee

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
  const setup = await db.tx((qc, oc) => finSetupBooks(qc, oc, { booksBegin, grants: GRANTS, actor: 'system (finance-dev)' }));
  for (const b of setup.books) say(`book ${b.code}: ${b.created ? 'set up' : 'already there'}`);
  // Books found again keep the day they were set up with, and a book's first day is never moved (finSetupBooks).
  const begins = await db.q('SELECT code, books_begin FROM fin_books ORDER BY code');
  const other = begins.find(b => b.books_begin !== booksBegin);
  if (other) {
    throw new Error(`the books in ${dir} begin on ${other.books_begin}, not ${booksBegin}. Run with --books-begin=${other.books_begin} `
      + `to keep them, or stop any finance-dev that is running, delete ${dir} and run this again.`);
  }
  // The Opening is dated the day before the books begin. When that day is in an earlier financial year (books that begin on 1 April),
  // each book needs that year as well, every month of it before the books, for the Opening to have a month.
  const { finFyOf } = await import('../client/src/lib/finance/fy.js');
  const openingYear = finFyOf(finDayBefore(booksBegin)).label;
  if (openingYear !== finFyOf(booksBegin).label) {
    const { finCreateYear } = await import('./src/finance-setup.js');
    await db.tx(async (qc, oc) => {
      for (const b of setup.books) await finCreateYear(qc, oc, { bookId: b.id, label: openingYear, booksBegin, actor: 'system (finance-dev)' });
    });
  }

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

  // ── 7. The cash demo ───────────────────────────────────────────────────────────────────────────
  if (cashDemo) {
    // A login's call to this server, as the browser makes it: anything but a 200 stops the run, saying what the route said.
    const api = async (who, method, url, body = null) => {
      const res = await fetch(`http://127.0.0.1:${apiPort}/api${url}`, {
        method,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${out[who].token}` },
        body: body == null ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch {}
      if (res.status !== 200) throw new Error(`${method} ${url} as ${who} answered ${res.status}: ${json?.error ?? text.slice(0, 300)}`);
      return json;
    };
    await seedCashDemo({ db, api, ids });
  }
} catch (e) {
  if (e?.code === 'EADDRINUSE') await fail(new Error(`port ${apiPort} is in use; set FIN_DEV_PORT to another`));
  await fail(e);
}

say(`data     ${dir}`);
say(`postgres 127.0.0.1:${port} (its own, kept between runs)`);
say(`books    begin ${booksBegin}; the Opening is dated ${finDayBefore(booksBegin)}; the plant's today is ${today}`);
say(`logins   ${Object.values(LOGINS).map(l => l.email).join(', ')}   (tokens: ${tokensFile})`);
say(`ready    http://localhost:${apiPort}/api`);

// ── The cash demo (Cash & Bank plan, Task 17; the header says what it seeds) ─────────────────────────────────

// The day before a 'YYYY-MM-DD' day, and the day `n` days after it.
function finDayAfter(day, n) { return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10); }
function finDayBefore(day) { return finDayAfter(day, -1); }

// The demo's days, all from the day the books begin (B): the Opening the day before, the Opening's bills in that month, HR's month
// B's own, its advances on B+4 and B+13, and its payroll finalised and paid on the month's last day, the salary day.
function finDemoDays(begin) {
  const [y, m] = begin.split('-').map(Number);
  const opening = finDayBefore(begin);
  const before = opening.slice(0, 7);
  return {
    begin, opening, month: begin.slice(0, 7), monthEnd: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10),
    bill0091: `${before}-02`, bill0104: `${before}-18`, billV11: `${before}-05`,
    advance: finDayAfter(begin, 4), sheet: finDayAfter(begin, 13),
  };
}

// A save key of the demo's own, the same on every run, so a second run's entry answers with the first run's voucher (ruling R11).
function finDemoKey(name) {
  const h = createHash('sha256').update(`ci-erp finance-dev cash demo: ${name}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// Seeds the walkthrough through this server's own routes, as md and acct, and HR's rows with SQL, as HR writes them. Each part is found
// again on a second run and left as it is: the Opening by its voucher, a ledger by its name, an entry by its save key, the HR rows by
// their people. `ids` are the logins' user ids.
async function seedCashDemo({ db, api, ids }) {
  const days = finDemoDays(booksBegin);
  const CI = (await db.one(`SELECT id FROM fin_books WHERE code = 'CI'`)).id;
  const groupId = async name => {
    const g = (await api('md', 'GET', `/finance/books/${CI}/groups`)).groups.find(x => x.name === name);
    if (!g) throw new Error(`the CI book has no group called ${name}`);
    return g.id;
  };
  const ledgerOf = name => db.one('SELECT id FROM fin_ledgers WHERE book_id = $1 AND lower(name) = lower($2)', [CI, name]);
  const made = [];

  // The Opening, through the Tally import: uploaded, confirmed and built by acct (it waits: the opening rule is always), approved by md.
  const opening = await db.one(
    `SELECT id, status FROM fin_vouchers WHERE book_id = $1 AND voucher_type = 'opening' AND status IN ('submitted', 'posted')
      ORDER BY id DESC LIMIT 1`, [CI]);
  if (!opening) {
    // The built-in Cash ledger is the office cash: named as the Tally row is, so the import matches it.
    const cash = await db.one(
      `SELECT l.id, l.name FROM fin_ledgers l JOIN fin_groups g ON g.id = l.group_id
        WHERE l.book_id = $1 AND l.is_system AND g.name = 'Cash-in-Hand' ORDER BY l.id LIMIT 1`, [CI]);
    if (cash.name !== DEMO.office) await api('acct', 'PUT', `/finance/ledgers/${cash.id}`, { name: DEMO.office });
    const tb = (tally_name, dr, cr) => ({ tally_name, debit_paise: dr * R, credit_paise: cr * R });
    const bill = (tally_ledger_name, bill_ref, bill_date, rupees) =>
      ({ tally_ledger_name, bill_ref, bill_date, due_date: null, amount_paise: rupees * R, side: rupees > 0 ? 'dr' : 'cr' });
    const up = await api('acct', 'POST', '/finance/imports', {
      book_id: CI, purpose: 'opening', as_at: days.opening, file_names: ['demo-tb.xlsx', 'demo-bills.xlsx'],
      accounts: [
        { tally_name: DEMO.office, tally_group: 'Cash-in-Hand' }, { tally_name: DEMO.bank, tally_group: 'Bank Accounts' },
        { tally_name: DEMO.customer, tally_group: 'Sundry Debtors' }, { tally_name: DEMO.vendor, tally_group: 'Sundry Creditors' },
        { tally_name: DEMO.capital, tally_group: 'Capital Account' },
      ],
      // Dr 2,00,000 + 15,00,000 + 95,000 = Cr 1,80,000 + 16,15,000 = 17,95,000
      tb: [tb(DEMO.office, 200000, 0), tb(DEMO.bank, 1500000, 0), tb(DEMO.customer, 95000, 0), tb(DEMO.vendor, 0, 180000),
        tb(DEMO.capital, 0, 1615000)],
      bills: [bill(DEMO.customer, null, null, 20000), bill(DEMO.customer, '0091', days.bill0091, 35000),
        bill(DEMO.customer, '0104', days.bill0104, 40000), bill(DEMO.vendor, 'V-11', days.billV11, -180000)],
    });
    const matches = up.ledgers.map(r => ({ row_id: r.id, action: r.match_status === 'matched' ? 'match' : r.match_status,
      ledger_id: r.ledger_id, group_id: r.group_id, party_type: r.party_type, party_id: r.party_id }));
    const unmatched = matches.filter(m => m.action === 'unmatched');
    if (unmatched.length) throw new Error(`the demo's Tally import left ${unmatched.length} row(s) unmatched`);
    await api('acct', 'PUT', `/finance/imports/${up.import.id}/matches`, { matches });
    const built = (await api('acct', 'POST', `/finance/imports/${up.import.id}/build-opening`)).voucher;
    await api('md', 'POST', `/finance/vouchers/${built.id}/approve`);
    made.push(`the Opening (${days.opening})`);
  } else if (opening.status === 'submitted') {
    await api('md', 'POST', `/finance/vouchers/${opening.id}/approve`);
    made.push('the Opening approved');
  }

  // The ledgers the walkthrough uses that the Opening does not carry.
  const ledgers = [
    { name: DEMO.holderLedger, group: 'Cash-in-Hand', holder_name: DEMO.holder, float_paise: 50000 * R },
    { name: DEMO.freight, group: 'Direct Expenses' },
    { name: 'TDS Receivable', group: 'Loans & Advances (Asset)' }, { name: 'TDS Payable', group: 'Duties & Taxes' },
    { name: 'Cash Short & Excess', group: 'Indirect Expenses' }, { name: 'Rounding Off', group: 'Indirect Expenses' },
    { name: 'Staff Deductions', group: 'Indirect Incomes' }, { name: 'Advance Waivers', group: 'Indirect Expenses' },
  ];
  for (const { name, group, ...holder } of ledgers) {
    if (await ledgerOf(name)) continue;
    await api('acct', 'POST', '/finance/ledgers', { book_id: CI, group_id: await groupId(group), name, ...holder });
    made.push(name);
  }
  const L = {};
  for (const name of [DEMO.office, DEMO.bank, DEMO.holderLedger, 'TDS Receivable', 'TDS Payable', 'Cash Short & Excess', 'Rounding Off',
    'Staff Deductions', 'Advance Waivers']) L[name] = (await ledgerOf(name)).id;

  // The staff ledgers, HR's two pay channels and the logins' HR levels; then the channel map and the roles, saved as Setup saves them.
  await api('md', 'POST', '/finance/hr-setup/ledgers', { book_id: CI });
  const { finHrFixtures } = await import('./src/finance-hr-fixtures.js');
  await db.q(`INSERT INTO hr.pay_channels (code, label, kind) VALUES ('CASH', 'Cash', 'cash'), ('COLOUR', 'Colour bank', 'bank')
              ON CONFLICT (code) DO NOTHING`);
  const fxPool = finHrFixtures(db);
  await fxPool.access(ids.md, 'admin');
  await fxPool.access(ids.acct, 'accounts');
  await api('md', 'PUT', '/finance/hr-setup', {
    book_id: CI,
    channels: [{ channel_code: 'CASH', ledger_id: L[DEMO.office] }, { channel_code: 'COLOUR', ledger_id: L[DEMO.bank] }],
    roles: {
      tds_receivable: L['TDS Receivable'], tds_payable: L['TDS Payable'], cash_difference: L['Cash Short & Excess'],
      rounding: L['Rounding Off'], other_deductions: L['Staff Deductions'], advance_waiver: L['Advance Waivers'],
    },
  });

  // Holder A's float as it starts (spec §9.2): a transfer from office cash on the books' first day.
  const float = await api('acct', 'POST', '/finance/cash/entries', {
    book_id: CI, entry_type: 'transfer', voucher_date: days.begin, account_ledger_id: L[DEMO.office], other_ledger_id: L[DEMO.holderLedger],
    amount_paise: 10000 * R, narration: 'Opening float', client_key: finDemoKey('holder A float'),
  });
  if (!float.replayed) made.push(`${DEMO.holder}'s ₹10,000 float (${days.begin})`);

  // HR's month, in one transaction: all of it or none of it. HR's own rows only; Finance is told nothing (Bring in posts it).
  if (!(await db.one('SELECT 1 AS one FROM hr.people WHERE name = $1', [DEMO.people[0]]))) {
    await db.tx(async (qc, oc) => {
      const fx = finHrFixtures({ q: qc, one: oc });
      const people = [];
      for (const [i, name] of DEMO.people.entries()) people.push(await fx.person({ name, firm: 'COLOUR', channel: i < 3 ? 'CASH' : 'COLOUR' }));
      const [A, B, C, D, E] = people;
      await fx.advance({ person: A, date: days.advance, rupees: 5000, paidVia: 'cash', door: 'pay_staff', by: ids.acct });
      const sheet = await fx.sheet({
        sheetNo: 'CI-ADV-0001', month: days.month, paidOn: days.sheet, paidVia: 'cash', by: ids.acct,
        lines: [{ person: B, rupees: 3000, decidedBy: ids.md }, { person: C, rupees: 2000, decidedBy: ids.md }, { person: D, rupees: 2500, decidedBy: ids.md }],
      });
      await fx.postRound(sheet.id, sheet.lineIds, { by: ids.md });
      const run = await fx.payroll({ month: days.month, approvedBy: ids.md, lines: [
        { person: A, gross: 15000, advanceRecovery: 2000 }, { person: B, gross: 12000, advanceRecovery: 1000 }, { person: C, gross: 11000 },
        { person: D, gross: 18000, advanceRecovery: 2500 }, { person: E, gross: 20000 },
      ] });
      await fx.finalise(run.id, { at: `${days.monthEnd}T10:00:00+05:30`, by: ids.md });
      await fx.payBatch({ lineIds: run.lineIds.slice(0, 3), channel: 'CASH', batchNo: 'CI-PAY-0001', paidOn: days.monthEnd, by: ids.md });
      await fx.payBatch({ lineIds: run.lineIds.slice(3), channel: 'COLOUR', batchNo: 'CI-PAY-0002', paidOn: days.monthEnd, by: ids.md });
    });
    made.push(`HR's ${days.month}: 5 people, an advance, sheet CI-ADV-0001, the payroll and batches CI-PAY-0001 and CI-PAY-0002`);
  }

  say(`cash demo: ${made.length ? `seeded ${made.join('; ')}` : 'found as it was seeded'}`);
  say(`cash demo: Opening ${days.opening}; Holder A's float ${days.begin}; HR's advances ${days.advance} and ${days.sheet}, its ${days.month} `
    + `payroll and batches ${days.monthEnd}`);
  say(today >= days.begin
    ? `cash demo: today, ${today}, is inside the books: the forms' own date (today) is the walkthrough's; an opening correction is dated ${days.opening}`
    : `cash demo: today, ${today}, is BEFORE the books begin (${days.begin}): date the walkthrough's entries ${days.begin} or later, and the ERP's `
      + 'after-the-date doors will not show');
}
