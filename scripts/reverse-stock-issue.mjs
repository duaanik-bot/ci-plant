// Back out a stock issue that was applied in error, putting the sheets back on
// the batch each was taken from.
//
//   node scripts/reverse-stock-issue.mjs                 dry run against $DATABASE_URL (default local)
//   node scripts/reverse-stock-issue.mjs --apply         write it
//   node scripts/reverse-stock-issue.mjs path/to.json    a different reversal
//
// WHY THE ORIGINAL BATCH AND NOT A NEW ONE. A positive adjustment through
// POST /inventory/adjust opens a fresh batch, which is right for board that has
// genuinely arrived. Board that was never really issued has not arrived — it has
// been sitting in its own lot the whole time. Booking it into a new batch would
// give it today's date, so FIFO would consume it last and the ageing report would
// show old stock as new. Restoring the original batch is what actually happened.
//
// The 30 Jul movement rows are NOT deleted. A reversing movement is written
// beside each, so the ledger reads "issued, then backed out" rather than
// pretending the issue never happened.
//
// Every reversal is guarded three ways and the run is one transaction: the
// movement must exist with exactly the qty claimed, the batch must still hold
// exactly what that movement left it holding, and nothing may have touched the
// batch since. Any drift means someone has worked on that stock in the meantime
// and the reversal is no longer safe to apply blind.
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_LOCAL = 'postgresql://postgres:postgres@localhost:5439/cierp';
const APPLY = process.argv.includes('--apply');
const url = process.env.DATABASE_URL || DEFAULT_LOCAL;
const file = process.argv.find(a => a.endsWith('.json'))
  || path.join(root, 'scripts/data/reverse-issue-2026-07-30.json');

const EPS = 1e-6;
const num = n => Number(n).toLocaleString('en-IN');
const data = JSON.parse(fs.readFileSync(file, 'utf8'));

const client = new pg.Client({
  connectionString: url,
  ssl: /supabase|amazonaws|neon/.test(url) ? { rejectUnauthorized: false } : undefined,
});
await client.connect();

const plan = [], problems = [];
for (const r of data.reversals) {
  const tag = `batch ${String(r.batch_id).padStart(4)}  ${String(r.spec).padEnd(14)}`;

  const [b] = (await client.query(
    `SELECT b.id, b.material_id, b.batch_no, b.qty, b.initial_qty, b.status, b.unit,
            m.spec, m.name, m.sheets_per_packet
     FROM stock_batches b JOIN materials m ON m.id = b.material_id WHERE b.id = $1`,
    [r.batch_id])).rows;
  if (!b) { problems.push(`NO BATCH     ${tag} — batch ${r.batch_id} does not exist`); continue; }
  if (b.material_id !== r.material_id || String(b.spec) !== String(r.spec)) {
    problems.push(`WRONG BOARD  ${tag} — batch ${r.batch_id} belongs to ${b.spec} (id ${b.material_id}), not ${r.spec} (id ${r.material_id})`);
    continue;
  }

  // The issue movement this reversal claims to undo has to be there, for exactly
  // this batch and exactly this quantity.
  const mvs = (await client.query(
    `SELECT id, qty, created_at FROM stock_movements
     WHERE batch_id = $1 AND note ILIKE $2 AND qty < 0 ORDER BY id`,
    [r.batch_id, `%${data.note}%`])).rows;
  if (mvs.length !== 1) {
    problems.push(`MOVEMENT     ${tag} — expected exactly 1 issue movement on this batch, found ${mvs.length}`);
    continue;
  }
  const mv = mvs[0];
  if (Math.abs(-(+mv.qty) - r.sheets) > EPS) {
    problems.push(`QTY MISMATCH ${tag} — the issue took ${num(-(+mv.qty))} sheets, this reversal claims ${num(r.sheets)}`);
    continue;
  }

  // Nothing may have touched the batch since the issue — otherwise restoring it
  // would overwrite whatever that later work did.
  const [{ n }] = (await client.query(
    `SELECT COUNT(*)::int n FROM stock_movements WHERE batch_id = $1 AND id > $2`,
    [r.batch_id, mv.id])).rows;
  if (n > 0) {
    problems.push(`TOUCHED      ${tag} — ${n} movement(s) on this batch since the issue; reverse it by hand`);
    continue;
  }

  const restored = +b.qty + r.sheets;
  if (Math.abs(restored - +b.initial_qty) > EPS) {
    problems.push(`WOULD NOT RESTORE ${tag} — ${num(+b.qty)} + ${num(r.sheets)} = ${num(restored)}, but the batch started at ${num(+b.initial_qty)}`);
    continue;
  }
  plan.push({ r, b, mv, from: +b.qty, to: restored });
}

console.log(`\nSource   ${path.relative(root, file)}`);
console.log(`Database ${url.replace(/:[^:@/]+@/, ':***@')}`);
console.log(`Mode     ${APPLY ? 'APPLY — writing' : 'DRY RUN — nothing is written'}`);
console.log(`Undoing  ${data.note}\n`);

const W = { code: 14, name: 32 };
console.log(`  ${'BATCH'.padStart(5)} ${'CODE'.padEnd(W.code)} ${'BOARD'.padEnd(W.name)} ${'PACKETS'.padStart(8)}  ${'NOW'.padStart(9)}  ${'RESTORED TO'.padStart(11)}`);
for (const p of plan)
  console.log(`  ${String(p.b.id).padStart(5)} ${String(p.b.spec).padEnd(W.code)} ${String(p.b.name).padEnd(W.name)} ${String(p.r.packets).padStart(8)}  ${num(p.from).padStart(9)}  ${num(p.to).padStart(11)}`);

if (problems.length) {
  console.log(`\n${problems.length} problem row(s) — these are NOT reversed:`);
  for (const p of problems) console.log('  ' + p);
}

console.log(`\n${plan.length} of ${data.reversals.length} reversals · ${num(plan.reduce((s, p) => s + p.r.packets, 0))} packets · ${num(plan.reduce((s, p) => s + p.r.sheets, 0))} sheets put back`);

if (!APPLY) {
  console.log(`\nNothing written. Re-run with --apply to book it.\n`);
  await client.end();
  process.exit(problems.length ? 1 : 0);
}
if (problems.length) {
  console.log(`\nRefusing to apply while ${problems.length} reversal(s) cannot be resolved.\n`);
  await client.end();
  process.exit(1);
}

await client.query('BEGIN');
try {
  for (const p of plan) {
    await client.query(`UPDATE stock_batches SET qty=$1, status='available' WHERE id=$2`, [p.to, p.b.id]);
    await client.query(
      `INSERT INTO stock_movements (material_id, batch_id, type, qty, note) VALUES ($1,$2,'adjustment',$3,$4)`,
      [p.b.material_id, p.b.id, p.r.sheets,
        `Reversal of ${data.note} — ${p.r.packets} packets put back (issue sheet withdrawn ${data.reversed_on}, to be re-mapped)`]);
    await client.query(
      `INSERT INTO audit_log (entity, entity_id, action, detail, user_name)
       VALUES ('inventory',$1,'issue-reversal',$2,'Stock issue reversal')`,
      [p.b.material_id, `${p.r.packets} packets = ${p.r.sheets} sheets restored to batch ${p.b.batch_no} (id ${p.b.id})`]);
  }
  await client.query('COMMIT');
  console.log(`\nApplied. ${plan.length} batches restored.\n`);
} catch (e) {
  await client.query('ROLLBACK');
  console.error('\nRolled back — nothing was written.\n', e.message);
  process.exitCode = 1;
}
await client.end();
