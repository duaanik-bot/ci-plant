// Schema drift checker. Exits non-zero when schemas disagree, so it can gate CI
// and a deploy.
//
//   npm run db:check                 local cierp  ↔  $DATABASE_URL (e.g. Supabase prod)
//   npm run db:check -- --baseline   a scratch DB built from the committed
//                                    baseline .sql  ↔  local cierp
//
// The --baseline mode is the reproducibility proof: it replays
// supabase/migrations/0001_baseline_schema.sql into an empty database and shows
// that the result matches the database the app actually runs on.
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL = 'postgresql://postgres:postgres@localhost:5439/cierp';
const ADMIN = 'postgresql://postgres:postgres@localhost:5439/postgres';
const SCRATCH = 'cierp_baseline_verify';

const SIG_SQL = `
  select table_name,
         count(*)::int as cols,
         md5(string_agg(column_name||':'||data_type, ',' order by column_name)) as sig
  from information_schema.columns
  where table_schema='public'
  group by table_name order by table_name`;

const isRemote = u => !/@(localhost|127\.0\.0\.1)[:/]/.test(u);

async function signature(url, label) {
  const c = new pg.Client({
    connectionString: url,
    ssl: isRemote(url) ? { rejectUnauthorized: false } : undefined,
  });
  await c.connect();
  const { rows } = await c.query(SIG_SQL);
  await c.end();
  const m = new Map(rows.map(r => [r.table_name, { cols: r.cols, sig: r.sig }]));
  console.log(`  ${label}: ${m.size} tables`);
  return m;
}

async function buildScratch() {
  const sqlFile = path.join(root, 'supabase/migrations/0001_baseline_schema.sql');
  if (!fs.existsSync(sqlFile)) throw new Error(`missing ${sqlFile} — run: npm run db:baseline`);
  const sql = fs.readFileSync(sqlFile, 'utf8');

  await dropScratch();
  const admin = new pg.Client(ADMIN);
  await admin.connect();
  await admin.query(`CREATE DATABASE ${SCRATCH}`);
  await admin.end();

  // Replay the blocks in the same order, and as separate statements, exactly
  // the way init() executes them. The header match must stay in step with
  // build-baseline.mjs ("-- ─── block 01 ───…"); an unmatched split replays
  // ZERO blocks and reports every table missing, which reads like total drift.
  const blocks = sql.split(/^-- ─── block \d+.*$/m).slice(1).map(b => b.trim()).filter(Boolean);
  if (!blocks.length) throw new Error('no baseline blocks matched the header pattern — db-check.mjs is out of step with build-baseline.mjs');
  const c = new pg.Client(`postgresql://postgres:postgres@localhost:5439/${SCRATCH}`);
  await c.connect();
  try {
    for (const [i, b] of blocks.entries()) {
      try { await c.query(b); }
      catch (e) { throw new Error(`baseline block ${i + 1} failed: ${e.message}`); }
    }
  } finally {
    await c.end();   // always release, or the scratch DB cannot be dropped
  }
  console.log(`  replayed ${blocks.length} baseline blocks into a fresh database`);
}

async function dropScratch() {
  const admin = new pg.Client(ADMIN);
  await admin.connect();
  // Evict any session left behind by an earlier failed run, else DROP errors out
  // and masks the real problem.
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()`, [SCRATCH]);
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH}`);
  await admin.end();
}

function diff(a, aLabel, b, bLabel) {
  const names = [...new Set([...a.keys(), ...b.keys()])].sort();
  const onlyA = [], onlyB = [], differs = [];
  for (const n of names) {
    const x = a.get(n), y = b.get(n);
    if (!y) onlyA.push(n);
    else if (!x) onlyB.push(n);
    else if (x.sig !== y.sig) differs.push(`${n} (${aLabel}=${x.cols} cols, ${bLabel}=${y.cols} cols)`);
  }
  return { onlyA, onlyB, differs };
}

const baselineMode = process.argv.includes('--baseline');
let failed = false;

if (baselineMode) {
  console.log('Reproducibility check — baseline .sql replayed into an empty DB vs the live local DB\n');
  try {
    await buildScratch();
    const fresh = await signature(`postgresql://postgres:postgres@localhost:5439/${SCRATCH}`, 'from baseline .sql');
    const live = await signature(LOCAL, 'local cierp     ');
    const { onlyA, onlyB, differs } = diff(fresh, 'baseline', live, 'local');
    console.log('');
    if (onlyA.length) { failed = true; console.log('  only in baseline:', onlyA.join(', ')); }
    if (onlyB.length) { failed = true; console.log('  only in local   :', onlyB.join(', ')); }
    if (differs.length) { failed = true; differs.forEach(d => console.log('  differs:', d)); }
  } finally {
    // Never let cleanup failure mask the real error above.
    try { await dropScratch(); }
    catch (e) { console.error('  (warning: could not drop scratch DB —', e.message + ')'); }
  }
} else {
  const target = process.env.DATABASE_URL;
  if (!target) {
    console.error('Set DATABASE_URL to the database you want to compare local against.');
    process.exit(2);
  }
  if (!isRemote(target)) {
    console.error('DATABASE_URL points at localhost — nothing to compare. Use --baseline instead.');
    process.exit(2);
  }
  console.log('Drift check — local cierp vs DATABASE_URL\n');
  const local = await signature(LOCAL, 'local cierp');
  const remote = await signature(target, 'remote     ');
  const { onlyA, onlyB, differs } = diff(local, 'local', remote, 'remote');
  console.log('');
  if (onlyA.length) { failed = true; console.log('  only in local :', onlyA.join(', ')); }
  if (onlyB.length) { console.log('  only in remote:', onlyB.join(', '), '(informational — remote-only tables do not fail the check)'); }
  if (differs.length) { failed = true; differs.forEach(d => console.log('  differs:', d)); }
}

console.log(failed ? '\nFAIL — schemas disagree.' : '\nOK — schemas match.');
process.exit(failed ? 1 : 0);
