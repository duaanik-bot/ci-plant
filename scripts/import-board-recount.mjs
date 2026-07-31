// Board recount import — sets the warehouse to a count sheet's figures, creating
// the masters the sheet needs, and MOVES a lot the ERP holds under the wrong
// grade instead of booking it a second time.
//
//   node scripts/import-board-recount.mjs                  dry run against $DATABASE_URL (default local)
//   node scripts/import-board-recount.mjs --apply          write it
//   node scripts/import-board-recount.mjs path/to.json     a different sheet
//
// WHY THIS EXISTS ALONGSIDE import-boards.mjs. That script is for an intake:
// every row is new board arriving, and a row that matches nothing becomes a new
// master holding new stock. That is exactly wrong for a RECOUNT of board the
// warehouse already has. When a recount re-grades a lot — the same GSM and sheet
// size, Duplex WB where the master says Duplex GB — the exact-match rule
// correctly finds no master, and the intake script would then create one and
// book the count onto it while the original master keeps the same physical
// board. One lot, two masters, twice the tonnage.
//
// So this script takes a `transfers` list: lots the operator has confirmed are
// the same physical board under the other grade. Each transfer names the master
// to empty and the exact sheet count it must be holding to prove it is that lot.
// The count is booked onto the grade the sheet gives, the named master is
// reduced to zero, and the board stays on the books once.
//
// Everything else follows import-boards.mjs: exact grade + GSM + length + width
// matching (never a code, never "close enough"), packets converted by the
// master's own sheets_per_packet, and the whole run in one transaction.
//
// Reductions mirror POST /inventory/adjust exactly — FIFO across available
// batches, each batch marked exhausted as it empties, one movement per batch
// touched — so an imported correction is indistinguishable from a hand
// adjustment. That means a reduction rewrites existing batch rows and CANNOT be
// reversed by deleting a batch. Back the database up before applying.
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { fileURLToPath } from 'url';
import { boardName, boardCode, takenCodesFor } from '../server/src/board-code.js';
import { SHEETS_PER_PACKET } from '../server/src/backfill-boards.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_LOCAL = 'postgresql://postgres:postgres@localhost:5439/cierp';
const APPLY = process.argv.includes('--apply');
const url = process.env.DATABASE_URL || DEFAULT_LOCAL;
const file = process.argv.find(a => a.endsWith('.json'))
  || path.join(root, 'scripts/data/board-recount-2026-07-31.json');

// Sheet quantities are DOUBLE PRECISION. Compare with a tolerance, never ==.
const EPS = 1e-6;
const key = (g, gsm, l, w) => [String(g ?? '').trim().toLowerCase(), +gsm, +l, +w].join('|');
const num = n => Number(n).toLocaleString('en-IN');
const pkt = (sheets, spp) => (+spp > 0 ? +(sheets / +spp).toFixed(2) : '?');

// Same literal as import-boards.mjs — what a board created here carries, matching
// Masters.jsx CONFIGS.boards.defaults. hsn_code/std_rate/last_rate stay absent:
// ₹/kg resolves per grade from board_rates, and a guess would compete with it.
const NEW_BOARD_DEFAULTS = {
  category: 'board', unit: 'sheets', gst_rate: 18,
  reorder_level: 0, min_stock: 0, max_stock: 0, active: 1, leftover: 0,
};

const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const BATCH_NO = `OPEN-${String(data.counted_on).replace(/-/g, '')}`;
const NOTE = `Board recount — physical count ${data.counted_on} (counted in packets)`;

const client = new pg.Client({
  connectionString: url,
  ssl: /supabase|amazonaws|neon/.test(url) ? { rejectUnauthorized: false } : undefined,
});
await client.connect();

const REQUIRED = ['name', 'category', 'spec', 'unit', 'sheet_l', 'sheet_w', 'grade', 'gsm',
  'sheets_per_packet', 'gst_rate', 'reorder_level', 'min_stock', 'max_stock', 'active', 'leftover'];
const present = new Set((await client.query(
  `SELECT column_name FROM information_schema.columns WHERE table_name='materials'`)).rows.map(r => r.column_name));
const missing = REQUIRED.filter(c => !present.has(c));
if (missing.length) {
  console.error(`\nmaterials is missing ${missing.length} column(s) this import writes: ${missing.join(', ')}`);
  await client.end();
  process.exit(1);
}

const mats = (await client.query(`
  SELECT m.id, m.name, m.spec, m.grade, m.gsm, m.sheet_l, m.sheet_w, m.unit, m.leftover,
         m.sheets_per_packet, COALESCE(av.q, 0) AS available
  FROM materials m
  LEFT JOIN (SELECT material_id, SUM(qty) q FROM stock_batches
             WHERE status='available' GROUP BY material_id) av ON av.material_id = m.id
  WHERE m.category = 'board' ORDER BY m.id`)).rows;

// Leftovers are excluded from matching AND from the taken-code set — an offcut
// carries its parent's exact code, so counting one as taken would push a new
// board onto a -1 suffix it has not earned.
const live = mats.filter(m => !m.leftover);
const byKey = new Map();
for (const m of live) {
  const k = key(m.grade, m.gsm, m.sheet_l, m.sheet_w);
  if (!byKey.has(k)) byKey.set(k, []);
  byKey.get(k).push(m);
}
const bySpec = new Map(live.map(m => [String(m.spec ?? '').trim().toLowerCase(), m]));
const taken = takenCodesFor(mats, null);

const packing = new Map();
for (const m of live) {
  if (!(+m.sheets_per_packet > 0)) continue;
  const g = String(m.grade ?? '').trim().toLowerCase();
  if (!packing.has(g)) packing.set(g, new Map());
  const c = packing.get(g);
  c.set(+m.sheets_per_packet, (c.get(+m.sheets_per_packet) || 0) + 1);
}
const dominantPacking = (grade) => {
  const c = packing.get(String(grade ?? '').trim().toLowerCase());
  return c ? [...c.entries()].sort((a, b) => b[1] - a[1])[0][0] : null;
};

const plan = [], problems = [];
for (const e of data.entries) {
  const tag = `row ${String(e.row ?? '?').padStart(2)}  ${e.label ?? ''}`.trim();
  const hits = byKey.get(key(e.grade, e.gsm, e.sheet_l, e.sheet_w)) || [];
  if (hits.length > 1) {
    problems.push(`AMBIGUOUS   ${tag} → ${hits.map(h => `${h.spec} (id ${h.id})`).join(', ')}`);
    continue;
  }

  let m = hits[0] ?? null;
  let creating = null;

  if (!m) {
    const name = boardName({ grade: e.grade, gsm: e.gsm, sheet_l: e.sheet_l, sheet_w: e.sheet_w });
    if (!name) { problems.push(`UNNAMEABLE  ${tag} — needs grade, GSM and both sheet sizes`); continue; }
    // materials has no UNIQUE on name; the client form guards it, so a bulk
    // writer has to carry that guard itself.
    const clash = live.find(x => String(x.name ?? '').trim().toLowerCase() === name.trim().toLowerCase());
    if (clash) {
      problems.push(`NAME CLASH  ${tag} → “${name}” is already board id ${clash.id} (${clash.spec})`);
      continue;
    }
    const spp = SHEETS_PER_PACKET[e.grade] ?? null;
    if (!(spp > 0)) { problems.push(`NO PACK SIZE ${tag} — grade “${e.grade}” has no known packing`); continue; }
    const dom = dominantPacking(e.grade);
    if (dom != null && dom !== spp) {
      problems.push(`PACKING MISMATCH ${tag} — would pack at ${spp}/packet, neighbours here use ${dom}`);
      continue;
    }
    const spec = boardCode({ grade: e.grade, gsm: e.gsm, sheet_l: e.sheet_l, sheet_w: e.sheet_w }, taken);
    if (!spec) { problems.push(`NO CODE     ${tag}`); continue; }
    taken.add(spec);
    creating = {
      ...NEW_BOARD_DEFAULTS, name, spec,
      grade: e.grade, gsm: e.gsm, sheet_l: e.sheet_l, sheet_w: e.sheet_w, sheets_per_packet: spp,
    };
    m = { id: null, name, spec, unit: creating.unit, sheets_per_packet: spp, available: 0 };
  }

  if (!(+m.sheets_per_packet > 0)) {
    problems.push(`NO PACK SIZE ${tag} (${m.spec}) — set sheets_per_packet on the master first`);
    continue;
  }
  const target = e.packets * +m.sheets_per_packet;
  plan.push({ e, m, creating, packets: e.packets, target, current: +m.available, delta: target - +m.available });
}

// Transfers. Each has to name a real board that is NOT itself a row target (a
// master cannot both receive the count and be emptied), and has to be holding
// exactly what the sheet says that lot is — the proof that it IS that lot and
// that nothing has moved since the operator read it.
const targetIds = new Set(plan.map(p => p.m.id).filter(Boolean));
const transfers = [];
for (const t of data.transfers ?? []) {
  const tag = `transfer row ${String(t.row ?? '?').padStart(2)}  ${t.from_spec}`;
  const src = bySpec.get(String(t.from_spec ?? '').trim().toLowerCase());
  if (!src) { problems.push(`NO SUCH BOARD  ${tag} — no live board carries that code`); continue; }
  const row = plan.find(p => p.e.row === t.row);
  if (!row) { problems.push(`ORPHAN         ${tag} — row ${t.row} is not in the plan`); continue; }
  if (targetIds.has(src.id)) {
    problems.push(`SELF-TRANSFER  ${tag} — id ${src.id} is also a row target; it cannot be emptied and filled`);
    continue;
  }
  if (Math.abs(+src.available - +t.expect_sheets) > EPS) {
    problems.push(`MOVED          ${tag} — expected ${num(t.expect_sheets)} sheets on id ${src.id}, found ${num(+src.available)}. Re-check before moving it.`);
    continue;
  }
  transfers.push({ t, src, row, out: +src.available });
}

console.log(`\nSource   ${path.relative(root, file)}`);
console.log(`Database ${url.replace(/:[^:@/]+@/, ':***@')}`);
console.log(`Mode     ${APPLY ? 'APPLY — writing' : 'DRY RUN — nothing is written'}`);
console.log(`Batch    ${BATCH_NO}\n`);

const W = { code: 14, name: 32 };
console.log(`     ${'CODE'.padEnd(W.code)} ${'BOARD'.padEnd(W.name)} ${'PACKETS'.padStart(8)}  ${'= SHEETS'.padStart(9)}  ${'ON HAND'.padStart(9)}  ${'BOOKING'.padStart(10)}`);
for (const p of plan) {
  const mark = p.creating ? 'NEW ' : '    ';
  const flag = Math.abs(p.delta) < EPS ? '   (already at level)' : '';
  console.log(`${mark} ${String(p.m.spec).padEnd(W.code)} ${String(p.m.name).padEnd(W.name)} ${String(p.packets).padStart(8)}  ${num(p.target).padStart(9)}  ${num(p.current).padStart(9)}  ${num(p.delta).padStart(10)}${flag}`);
}

if (transfers.length) {
  console.log(`\nRe-graded lots — emptied so the board is not counted twice:`);
  for (const x of transfers)
    console.log(`  row ${String(x.t.row).padStart(2)}  ${String(x.src.spec).padEnd(W.code)} ${String(x.src.name).padEnd(W.name)} ${num(x.out).padStart(9)} sheets → 0   (onto ${x.row.m.spec})`);
}

if (problems.length) {
  console.log(`\n${problems.length} problem row(s) — these are NOT imported:`);
  for (const p of problems) console.log('  ' + p);
}

const creates = plan.filter(p => p.creating);
const booking = plan.filter(p => Math.abs(p.delta) > EPS);
const movedOut = transfers.reduce((s, x) => s + x.out, 0);
console.log(`\n${plan.length} rows · ${creates.length} new board masters · ${plan.length - creates.length} already in the master`);
console.log(`${num(plan.reduce((s, p) => s + p.packets, 0))} packets · ${num(plan.reduce((s, p) => s + p.target, 0))} sheets counted`);
console.log(`${booking.length} ledger entries · ${num(booking.reduce((s, p) => s + p.delta, 0))} sheets booked · ${transfers.length} lots moved off ${num(movedOut)} sheets`);
console.log(`net change to the warehouse: ${num(booking.reduce((s, p) => s + p.delta, 0) - movedOut)} sheets`);

if (creates.length) {
  console.log(`\nNew boards and the codes they will be given:`);
  for (const p of creates)
    console.log(`  ${String(p.creating.spec).padEnd(W.code)} ${String(p.creating.name).padEnd(W.name)} ${String(p.creating.sheets_per_packet).padStart(3)} sheets/packet · GST ${p.creating.gst_rate}%`);
}

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

// Mirrors POST /inventory/adjust: FIFO across available batches, each marked
// exhausted as it empties, one movement per batch touched, and a negative batch
// for any shortfall so a reduction past zero shows up instead of being rejected.
async function reduce(materialId, unit, amount, note) {
  let remaining = amount;
  const batches = (await client.query(
    `SELECT id, qty FROM stock_batches WHERE material_id=$1 AND status='available' AND qty>0 ORDER BY created_at, id`,
    [materialId])).rows;
  for (const b of batches) {
    if (remaining <= EPS) break;
    const take = Math.min(+b.qty, remaining);
    const newQty = +b.qty - take;
    await client.query(`UPDATE stock_batches SET qty=$1, status=$2 WHERE id=$3`,
      [newQty, newQty <= EPS ? 'exhausted' : 'available', b.id]);
    await client.query(
      `INSERT INTO stock_movements (material_id, batch_id, type, qty, note) VALUES ($1,$2,'adjustment',$3,$4)`,
      [materialId, b.id, -take, note]);
    remaining -= take;
  }
  if (remaining > EPS) {
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
  let created = 0, booked = 0, moved = 0;

  // Empty the re-graded lots FIRST. If the same board somehow appears on both
  // sides of a move, the count lands last and wins rather than being wiped.
  for (const x of transfers) {
    await reduce(x.src.id, x.src.unit, x.out, `${NOTE} — re-graded to ${x.row.e.grade}, moved to ${x.row.m.spec}`);
    await client.query(
      `INSERT INTO audit_log (entity, entity_id, action, detail, user_name)
       VALUES ('inventory',$1,'recount-transfer',$2,'Board recount import')`,
      [x.src.id, `${x.out} sheets moved to ${x.row.m.spec} (${x.row.e.label}) — ${x.t.why}`]);
    moved++;
  }

  for (const p of plan) {
    if (p.creating) {
      const c = p.creating;
      const [row] = (await client.query(
        `INSERT INTO materials
           (name, category, spec, unit, sheet_l, sheet_w, grade, gsm, sheets_per_packet,
            gst_rate, reorder_level, min_stock, max_stock, active, leftover)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [c.name, c.category, c.spec, c.unit, c.sheet_l, c.sheet_w, c.grade, c.gsm,
          c.sheets_per_packet, c.gst_rate, c.reorder_level, c.min_stock, c.max_stock, c.active, c.leftover])).rows;
      p.m.id = row.id;
      await client.query(
        `INSERT INTO audit_log (entity, entity_id, action, detail, user_name)
         VALUES ('materials',$1,'create',$2,'Board recount import')`,
        [row.id, `${c.name} (${c.spec}) — recount ${data.counted_on}`]);
      created++;
    }

    if (Math.abs(p.delta) < EPS) continue;
    if (p.delta > 0) {
      const [b] = (await client.query(
        `INSERT INTO stock_batches (material_id, batch_no, qty, initial_qty, unit, status)
         VALUES ($1,$2,$3,$3,$4,'available') RETURNING id`,
        [p.m.id, BATCH_NO, p.delta, p.m.unit || 'sheets'])).rows;
      await client.query(
        `INSERT INTO stock_movements (material_id, batch_id, type, qty, note) VALUES ($1,$2,'adjustment',$3,$4)`,
        [p.m.id, b.id, p.delta, `${NOTE} — ${p.packets} packets`]);
    } else {
      await reduce(p.m.id, p.m.unit, -p.delta, `${NOTE} — count corrected to ${p.packets} packets`);
    }
    await client.query(
      `INSERT INTO audit_log (entity, entity_id, action, detail, user_name)
       VALUES ('inventory',$1,'opening-stock',$2,'Board recount import')`,
      [p.m.id, `${p.packets} packets = ${p.target} sheets (was ${p.current})`]);
    booked++;
  }

  await client.query('COMMIT');
  console.log(`\nApplied. ${created} masters created, ${booked} ledger entries under ${BATCH_NO}, ${moved} re-graded lots moved.\n`);
} catch (e) {
  await client.query('ROLLBACK');
  console.error('\nRolled back — nothing was written.\n', e.message);
  process.exitCode = 1;
}
await client.end();
