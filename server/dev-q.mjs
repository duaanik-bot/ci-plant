// Dev-only query helper. psql is not installed and embedded-postgres ships no
// client binary, so verification steps use this instead.
//   node dev-q.mjs "SELECT 1"
import pg from 'pg';

const sql = process.argv.slice(2).join(' ');
if (!sql) { console.error('usage: node dev-q.mjs "<SQL>"'); process.exit(1); }

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5439/cierp',
});
await client.connect();
try {
  const res = await client.query(sql);
  if (res.rows?.length) console.table(res.rows);
  else console.log(`${res.command} — ${res.rowCount} row(s)`);
} finally {
  await client.end();
}
