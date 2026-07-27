// Opening RM stock import — physical warehouse count, counted in PACKETS.
//
//   node scripts/import-rm-stock.mjs                 dry run against $DATABASE_URL (default local)
//   node scripts/import-rm-stock.mjs --apply         write it
//
// The plant counts board in packets, never loose sheets, so the count sheet the
// warehouse hands over is a packet figure. The ledger transacts in SHEETS —
// cutting, planning and every consumption entry are sheet-denominated — so the
// import converts once, here, using each board's own sheets_per_packet. Nothing
// downstream has to know the count arrived in packets.
//
// Matching is on grade + GSM + sheet size, NOT on the board code printed in the
// export. Codes were re-schemed (2336DPGB296 → 2336296GB) after that file was
// generated, and the physical attributes are what actually identify a board.
//
// Idempotent: each material is moved to its counted level by booking the DELTA
// against what is on hand right now. Re-running after a successful apply books
// nothing, because every delta is then zero.
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_LOCAL = 'postgresql://postgres:postgres@localhost:5439/cierp';
const APPLY = process.argv.includes('--apply');
const url = process.env.DATABASE_URL || DEFAULT_LOCAL;
const file = process.argv.find(a => a.endsWith('.json'))
  || path.join(root, 'scripts/data/rm-opening-stock-2026-07-27.json');

const key = (g, gsm, l, w) => [String(g ?? '').trim().toLowerCase(), +gsm, +l, +w].join('|');
const num = n => Number(n).toLocaleString('en-IN');

const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const BATCH_NO = `OPEN-${String(data.counted_on).replace(/-/g, '')}`;
const NOTE = `Opening stock — physical count ${data.counted_on} (counted in packets)`;

const client = new pg.Client({
  connectionString: url,
  ssl: /supabase|amazonaws|neon/.test(url) ? { rejectUnauthorized: false } : undefined,
});
await client.connect();

const mats = (await client.query(`
  SELECT m.id, m.name, m.spec, m.grade, m.gsm, m.sheet_l, m.sheet_w, m.unit,
         m.sheets_per_packet, COALESCE(av.q, 0) AS available
  FROM materials m
  LEFT JOIN (SELECT material_id, SUM(qty) q FROM stock_batches
             WHERE status='available' GROUP BY material_id) av ON av.material_id = m.id
  WHERE m.category = 'board'`)).rows;

const byKey = new Map();
for (const m of mats) {
  const k = key(m.grade, m.gsm, m.sheet_l, m.sheet_w);
  if (!byKey.has(k)) byKey.set(k, []);
  byKey.get(k).push(m);
}

const plan = [], problems = [];
for (const e of data.entries) {
  const hits = byKey.get(key(e.grade, e.gsm, e.sheet_l, e.sheet_w)) || [];
  if (hits.length === 0) { problems.push(`NO MATCH   ${e.label}`); continue; }
  if (hits.length > 1) { problems.push(`AMBIGUOUS  ${e.label} → ${hits.map(h => h.spec).join(', ')}`); continue; }
  const m = hits[0];
  if (!(+m.sheets_per_packet > 0)) { problems.push(`NO PACK SIZE  ${e.label} (${m.spec}) — set sheets_per_packet on the master first`); continue; }
  const target = e.packets * +m.sheets_per_packet;
  plan.push({ m, packets: e.packets, target, current: +m.available, delta: target - +m.available });
}

console.log(`\nSource   ${path.relative(root, file)}`);
console.log(`Database ${url.replace(/:[^:@/]+@/, ':***@')}`);
console.log(`Mode     ${APPLY ? 'APPLY — writing' : 'DRY RUN — nothing is written'}\n`);

for (const p of plan) {
  const flag = p.delta === 0 ? '  (already at level)' : '';
  console.log(`${p.m.spec.padEnd(14)} ${p.m.name.padEnd(34)} ${String(p.packets).padStart(4)} pkt × ${String(p.m.sheets_per_packet).padStart(3)} = ${num(p.target).padStart(8)} sheets   on hand ${num(p.current).padStart(8)}   Δ ${num(p.delta).padStart(9)}${flag}`);
}

if (problems.length) {
  console.log(`\n${problems.length} problem row(s) — these are NOT imported:`);
  for (const p of problems) console.log('  ' + p);
}

const totalPackets = plan.reduce((s, p) => s + p.packets, 0);
const totalSheets = plan.reduce((s, p) => s + p.target, 0);
const moving = plan.filter(p => p.delta !== 0);
console.log(`\n${plan.length} materials · ${num(totalPackets)} packets · ${num(totalSheets)} sheets · ${moving.length} need a ledger entry`);

if (!APPLY) {
  console.log(`\nNothing written. Re-run with --apply to book it.\n`);
  await client.end();
  process.exit(problems.length ? 1 : 0);
}

if (problems.length) {
  console.log(`\nRefusing to apply while ${problems.length} row(s) cannot be resolved. Fix the masters (or the source file) and re-run.\n`);
  await client.end();
  process.exit(1);
}

// One transaction: either the whole count lands or none of it does. Mirrors the
// batch + movement pair that POST /inventory/adjust writes, so an imported
// opening balance is indistinguishable from a hand adjustment in the ledger.
await client.query('BEGIN');
try {
  let booked = 0;
  for (const p of plan) {
    if (p.delta === 0) continue;
    const [b] = (await client.query(
      `INSERT INTO stock_batches (material_id, batch_no, qty, initial_qty, unit, status)
       VALUES ($1,$2,$3,$3,$4,'available') RETURNING id`,
      [p.m.id, BATCH_NO, p.delta, p.m.unit || 'sheets'])).rows;
    await client.query(
      `INSERT INTO stock_movements (material_id, batch_id, type, qty, note)
       VALUES ($1,$2,'adjustment',$3,$4)`,
      [p.m.id, b.id, p.delta, `${NOTE} — ${p.packets} packets`]);
    await client.query(
      `INSERT INTO audit_log (entity, entity_id, action, detail, user_name)
       VALUES ('inventory',$1,'opening-stock',$2,'Opening stock import')`,
      [p.m.id, `${p.packets} packets = ${p.target} sheets`]);
    booked++;
  }
  await client.query('COMMIT');
  console.log(`\nApplied. ${booked} ledger entries written under batch ${BATCH_NO}.\n`);
} catch (e) {
  await client.query('ROLLBACK');
  console.error('\nRolled back — nothing was written.\n', e.message);
  process.exitCode = 1;
}
await client.end();
