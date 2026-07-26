// Read-only backup of a ci-erp database to a timestamped JSON file.
//
//   npm run db:backup            # backs up $DATABASE_URL
//
// Replaces the old backup-ci-prod-supabase.mjs, which read the pre-ci-erp table
// list over the anon REST API — those tables no longer exist and anon no longer
// has access, so it could not work.
//
// Writes to backups/ (gitignored). Run this before ANY destructive production
// work; the deploy runbook in DEPLOYMENT.md requires it.
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Set DATABASE_URL to the database you want to back up.');
  console.error('  Production:  vercel env pull --environment production');
  process.exit(2);
}

const host = url.replace(/^[^@]*@/, '').replace(/[:/].*$/, '');
const isRemote = !/@(localhost|127\.0\.0\.1)[:/]/.test(url);
console.log(`Backing up ${host}${isRemote ? '' : ' (local)'}…`);

const c = new pg.Client({ connectionString: url, ssl: isRemote ? { rejectUnauthorized: false } : undefined });
await c.connect();

const { rows: tables } = await c.query(
  `select tablename from pg_tables where schemaname='public' order by tablename`);

const out = {};
let grand = 0;
for (const { tablename } of tables) {
  const { rows } = await c.query(`SELECT * FROM public."${tablename}"`);
  out[tablename] = rows;
  grand += rows.length;
  if (rows.length) console.log(`  ${tablename}: ${rows.length}`);
}
await c.end();

fs.mkdirSync(path.join(root, 'backups'), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const file = path.join(root, 'backups', `ci-erp-backup-${host.split('.')[0]}-${stamp}.json`);
fs.writeFileSync(file, JSON.stringify(
  { backed_up_at: new Date().toISOString(), host, tables: tables.length, total_rows: grand, data: out }));

console.log(`\n${grand} rows across ${tables.length} tables`);
console.log(`saved -> ${path.relative(root, file)} (${(fs.statSync(file).size / 1048576).toFixed(2)} MB)`);
