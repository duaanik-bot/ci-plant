// Full-master board stocktake — sets every board to the level a count sheet
// gives, absolutely.
//
//   node scripts/import-rm-stocktake.mjs                  dry run against $DATABASE_URL (default local)
//   node scripts/import-rm-stocktake.mjs --apply          write it
//   node scripts/import-rm-stocktake.mjs path/to.json     a different stocktake
//
// WHY THIS EXISTS ALONGSIDE THE OTHER TWO. import-boards.mjs is an INTAKE (rows
// are new board arriving, a missing master is the work). import-board-recount.mjs
// is a PARTIAL recount of named lots, with transfers for re-grades. This one is a
// WHOLE-WAREHOUSE stocktake: the sheet lists every live board master and its
// figure wins outright, so a board absent from the sheet is a fault in the sheet,
// not a board to zero. That asymmetry is the point — silently zeroing an unlisted
// board would empty the warehouse on a truncated export.
//
// Matching is on the board CODE, unlike the other two, because this sheet is an
// export OF the master and carries the code the master issued. The code is still
// verified against grade + GSM + sheet size, and any disagreement is a problem
// row rather than a guess — codes have been re-schemed twice historically, so a
// code that no longer describes its board is exactly the case worth catching.
//
// Reductions mirror POST /inventory/adjust — FIFO across available batches, each
// marked exhausted as it empties, one movement per batch touched. That rewrites
// existing batch rows and CANNOT be undone by deleting a batch: back up first.
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_LOCAL = 'postgresql://postgres:postgres@localhost:5439/cierp';
const APPLY = process.argv.includes('--apply');
const url = process.env.DATABASE_URL || DEFAULT_LOCAL;
const file = process.argv.find(a => a.endsWith('.json'))
  || path.join(root, 'scripts/data/rm-stocktake-2026-07-31.json');

// A whole sheet under one sheet is not a discrepancy — the sheet stores packets
// to two decimals, so a board holding 19,400 sheets of a 144-pack reads back as
// 134.72 pkt = 19,399.68. Writing that difference would book float dust.
const MIN_SHEETS = 1;
const norm = s => String(s ?? '').trim().toLowerCase();
const num = n => Number(n).toLocaleString('en-IN');
const k4 = (g, gsm, l, w) => [norm(g), +gsm, +l, +w].join('|');
const pk = (sheets, spp) => (+spp > 0 ? +(sheets / +spp).toFixed(2) : '?');

const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const BATCH_NO = data.batch_no || `STK-${String(data.counted_on).replace(/-/g, '')}`;
const NOTE = `Board stocktake ${data.counted_on} (counted in packets)`;
const HOLD = new Set((data.hold ?? []).map(norm));
const IGNORE = new Set((data.ignore ?? []).map(norm));

const client = new pg.Client({
  connectionString: url,
  ssl: /supabase|amazonaws|neon/.test(url) ? { rejectUnauthorized: false } : undefined,
});
await client.connect();

const mats = (await client.query(`
  SELECT m.id, m.spec, m.name, m.grade, m.gsm, m.sheet_l, m.sheet_w, m.unit, m.leftover,
         m.sheets_per_packet, COALESCE(av.q,0) AS available
  FROM materials m
  LEFT JOIN (SELECT material_id, SUM(qty) q FROM stock_batches WHERE status='available' GROUP BY material_id) av
         ON av.material_id = m.id
  WHERE m.category='board' ORDER BY m.id`)).rows;
const live = mats.filter(m => !m.leftover);
const bySpec = new Map(live.filter(m => m.spec).map(m => [norm(m.spec), m]));
const byK4 = new Map();
for (const m of live) {
  const k = k4(m.grade, m.gsm, m.sheet_l, m.sheet_w);
  if (!byK4.has(k)) byK4.set(k, []);
  byK4.get(k).push(m);
}

const plan = [], held = [], skipped = [], problems = [];
const seen = new Map();
for (const e of data.entries) {
  const tag = `${String(e.code ?? '?').padEnd(14)} ${e.grade ?? ''} ${e.gsm ?? ''} ${e.sheet_l ?? ''}x${e.sheet_w ?? ''}`.trim();
  if (IGNORE.has(norm(e.code))) { skipped.push(`IGNORED   ${tag} (${e.packets} pkt) — listed in the file's ignore set`); continue; }

  let m = bySpec.get(norm(e.code)) ?? null;
  if (!m) {
    const hits = byK4.get(k4(e.grade, e.gsm, e.sheet_l, e.sheet_w)) || [];
    if (hits.length === 1) m = hits[0];
    else if (hits.length > 1) { problems.push(`AMBIGUOUS   ${tag} → ${hits.map(h => h.spec).join(', ')}`); continue; }
  }
  if (!m) { problems.push(`NO BOARD    ${tag} — no live board carries that code or those attributes`); continue; }

  // The code is the match key, so a code that no longer describes its board is
  // the one failure this import must not absorb silently.
  if (k4(e.grade, e.gsm, e.sheet_l, e.sheet_w) !== k4(m.grade, m.gsm, m.sheet_l, m.sheet_w)) {
    problems.push(`ATTR DRIFT  ${tag} → code ${m.spec} is ${m.grade} ${m.gsm} ${m.sheet_l}x${m.sheet_w} in the master`);
    continue;
  }
  if (seen.has(m.id)) { problems.push(`DOUBLE HIT  ${tag} — board ${m.spec} is already claimed by another row`); continue; }
  seen.set(m.id, e);

  if (HOLD.has(norm(e.code))) {
    held.push({ e, m, target: e.packets * +m.sheets_per_packet });
    continue;
  }
  if (!(+m.sheets_per_packet > 0)) {
    if (+e.packets === 0 && Math.abs(+m.available) < MIN_SHEETS) { skipped.push(`NO PACK   ${tag} — grade has no packing, but sheet and stock are both 0`); continue; }
    problems.push(`NO PACK SIZE ${tag} (${m.spec}) — cannot convert ${e.packets} packets; set sheets_per_packet first`);
    continue;
  }

  const target = e.packets * +m.sheets_per_packet;
  const delta = target - +m.available;
  if (Math.abs(delta) < MIN_SHEETS) continue;
  plan.push({ e, m, target, delta, current: +m.available });
}

// A board the sheet never mentions is left alone — see the header note.
const unlisted = live.filter(m => !seen.has(m.id) && Math.abs(+m.available) >= MIN_SHEETS);

console.log(`\nSource   ${path.relative(root, file)}`);
console.log(`Database ${url.replace(/:[^:@/]+@/, ':***@')}`);
console.log(`Mode     ${APPLY ? 'APPLY — writing' : 'DRY RUN — nothing is written'}`);
console.log(`Batch    ${BATCH_NO} (positive corrections only)\n`);

plan.sort((a, b) => a.delta - b.delta);
const W = { code: 14, name: 34 };
console.log(`  ${'CODE'.padEnd(W.code)} ${'BOARD'.padEnd(W.name)} ${'NOW pkt'.padStart(9)} ${'SHEET pkt'.padStart(10)} ${'Δ SHEETS'.padStart(10)}`);
for (const p of plan)
  console.log(`  ${String(p.m.spec).padEnd(W.code)} ${String(p.m.name).padEnd(W.name)} ${String(pk(p.current, p.m.sheets_per_packet)).padStart(9)} ${String(p.e.packets).padStart(10)} ${num(Math.round(p.delta)).padStart(10)}`);

if (held.length) {
  console.log(`\nHELD — not written, awaiting a decision:`);
  for (const h of held)
    console.log(`  ${String(h.m.spec).padEnd(W.code)} ${String(h.m.name).padEnd(W.name)} holds ${pk(+h.m.available, h.m.sheets_per_packet)} pkt, sheet says ${h.e.packets} pkt`);
}
if (unlisted.length) {
  console.log(`\nBoards holding stock that the sheet does not list — LEFT ALONE:`);
  for (const m of unlisted)
    console.log(`  ${String(m.spec ?? '(no code)').padEnd(W.code)} ${String(m.name).padEnd(W.name)} ${pk(+m.available, m.sheets_per_packet)} pkt`);
}
if (skipped.length) {
  console.log(`\n${skipped.length} row(s) skipped:`);
  for (const s of skipped) console.log('  ' + s);
}
if (problems.length) {
  console.log(`\n${problems.length} problem row(s) — these are NOT imported:`);
  for (const p of problems) console.log('  ' + p);
}

const up = plan.filter(p => p.delta > 0), down = plan.filter(p => p.delta < 0);
const net = plan.reduce((s, p) => s + p.delta, 0);
const totNow = live.reduce((s, m) => s + +m.available, 0);
console.log(`\n${data.entries.length} sheet rows · ${seen.size} matched · ${plan.length} to change (${up.length} up, ${down.length} down) · ${held.length} held · ${problems.length} problems`);
console.log(`Net movement ${num(Math.round(net))} sheets · warehouse ${num(Math.round(totNow))} → ${num(Math.round(totNow + net))} sheets`);

if (!APPLY) {
  console.log(`\nNothing written. Re-run with --apply to book it.\n`);
  await client.end();
  process.exit(problems.length ? 1 : 0);
}
if (problems.length) {
  console.log(`\nRefusing to apply while ${problems.length} row(s) cannot be resolved.\n`);
  await client.end();
  process.exit(1);
}

async function reduce(materialId, unit, amount, note) {
  let remaining = amount;
  const batches = (await client.query(
    `SELECT id, qty FROM stock_batches WHERE material_id=$1 AND status='available' AND qty>0 ORDER BY created_at, id`,
    [materialId])).rows;
  for (const b of batches) {
    if (remaining <= 0) break;
    const take = Math.min(+b.qty, remaining);
    const newQty = +b.qty - take;
    await client.query(`UPDATE stock_batches SET qty=$1, status=$2 WHERE id=$3`,
      [newQty, newQty <= 0 ? 'exhausted' : 'available', b.id]);
    await client.query(
      `INSERT INTO stock_movements (material_id, batch_id, type, qty, note) VALUES ($1,$2,'adjustment',$3,$4)`,
      [materialId, b.id, -take, note]);
    remaining -= take;
  }
  if (remaining > 0) {
    const [nb] = (await client.query(
      `INSERT INTO stock_batches (material_id, batch_no, qty, initial_qty, unit, status)
       VALUES ($1,$2,$3,$3,$4,'available') RETURNING id`,
      [materialId, `${BATCH_NO}-NEG`, -remaining, unit || 'sheets'])).rows;
    await client.query(
      `INSERT INTO stock_movements (material_id, batch_id, type, qty, note) VALUES ($1,$2,'adjustment',$3,$4)`,
      [materialId, nb.id, -remaining, `${note} (below zero)`]);
  }
}

await client.query('BEGIN');
try {
  for (const p of plan) {
    if (p.delta > 0) {
      const [b] = (await client.query(
        `INSERT INTO stock_batches (material_id, batch_no, qty, initial_qty, unit, status)
         VALUES ($1,$2,$3,$3,$4,'available') RETURNING id`,
        [p.m.id, BATCH_NO, p.delta, p.m.unit || 'sheets'])).rows;
      await client.query(
        `INSERT INTO stock_movements (material_id, batch_id, type, qty, note) VALUES ($1,$2,'adjustment',$3,$4)`,
        [p.m.id, b.id, p.delta, `${NOTE} — counted ${p.e.packets} packets`]);
    } else {
      await reduce(p.m.id, p.m.unit, -p.delta, `${NOTE} — counted ${p.e.packets} packets`);
    }
    await client.query(
      `INSERT INTO audit_log (entity, entity_id, action, detail, user_name)
       VALUES ('inventory',$1,'stocktake',$2,'RM board stocktake')`,
      [p.m.id, `${p.e.packets} packets = ${Math.round(p.target)} sheets (was ${Math.round(p.current)})`]);
  }
  await client.query('COMMIT');
  console.log(`\nApplied. ${plan.length} boards set to the sheet's level under ${BATCH_NO}.\n`);
} catch (e) {
  await client.query('ROLLBACK');
  console.error('\nRolled back — nothing was written.\n', e.message);
  process.exitCode = 1;
}
await client.end();
