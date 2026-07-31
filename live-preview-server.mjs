// Local dev server wired to the LIVE Supabase plant database.
//
// Mirrors api/index.js (the Vercel entry), NOT server/src/index.js:
//   • connect() only — never init(), so no DDL is ever sent to production.
//   • no seedAdminIfMissing() / seedIfEmpty() — no rows are invented on live.
//
// Reads DATABASE_URL from the caller's environment. Writes made through this
// server hit the real plant data. Delete this file when the experiment is over.
import fs from 'node:fs';
import app from './server/src/app.js';
import { connect } from './server/src/db.js';

// The connection string lives outside the repo so it can never be committed.
// LIVE_DB_ENV_FILE overrides the path; the file holds one DATABASE_URL= line.
if (!process.env.DATABASE_URL && process.env.LIVE_DB_ENV_FILE) {
  const line = fs.readFileSync(process.env.LIVE_DB_ENV_FILE, 'utf8')
    .split('\n').find(l => l.startsWith('DATABASE_URL='));
  if (line) process.env.DATABASE_URL = line.slice('DATABASE_URL='.length).trim().replace(/^"|"$/g, '');
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set — refusing to start (would boot embedded PG).');
  process.exit(1);
}
if (/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
  console.error('DATABASE_URL points at localhost — use the normal dev server instead.');
  process.exit(1);
}

await connect();
const host = url.replace(/:\/\/[^@]*@/, '://<redacted>@').split('/').slice(0, 3).join('/');
console.log(`⚠️  LIVE DATABASE — ${host}`);

const PORT = process.env.PORT || 4900;
app.listen(PORT, () => console.log(`CI ERP (LIVE DB) → http://localhost:${PORT}`));
