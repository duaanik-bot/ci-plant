// Board intake import — creates the board masters a counted intake sheet needs,
// then books the count as opening stock.
//
//   node scripts/import-boards.mjs                 dry run against $DATABASE_URL (default local)
//   node scripts/import-boards.mjs --apply         write it
//   node scripts/import-boards.mjs path/to.json    a different intake sheet
//
// WHY THIS EXISTS ALONGSIDE import-rm-stock.mjs. That script books a physical
// count against masters that already exist, and refuses any row it cannot match
// — correct for a stocktake of the known warehouse. An intake sheet is the other
// case: most of its rows are board the master has never carried, so the missing
// master IS the work. Creating the master by hand first and then running the
// stocktake would be the same two steps with a gap in the middle where a board
// exists with no stock and a wrong code could be typed in.
//
// Matching is on grade + GSM + sheet size, NOT on any code printed on the sheet.
// Codes have been re-schemed twice (2336DPGB296 → 2336296GB) and names closed up
// (23 x 36 → 23x36); the physical attributes are what actually identify a board.
// The match is EXACT — 21.5x35.5 and 21.6x35.6 are two real boards in this
// master, so "close enough" would merge stock into the wrong one.
//
// Idempotent both halves. A board is created only when nothing matches it, and
// the count is booked as the DELTA against what is on hand right now, so a
// re-run after a successful apply creates nothing and books nothing. Reverse an
// import by deleting its OPEN-<date> batch and that batch's movements; the
// masters can then be deleted if nothing else has picked them up.
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
  || path.join(root, 'scripts/data/board-intake-2026-07-28.json');

const key = (g, gsm, l, w) => [String(g ?? '').trim().toLowerCase(), +gsm, +l, +w].join('|');
const num = n => Number(n).toLocaleString('en-IN');
const size = (l, w) => `${+(+l).toFixed(2)}x${+(+w).toFixed(2)}`;

// Every field the Boards master form fills for a new board. Kept here as one
// literal rather than spread through the INSERT so what a created board carries
// is readable in one place, and matches Masters.jsx CONFIGS.boards.defaults.
//
// hsn_code, std_rate and last_rate are deliberately absent: no board in this
// master carries them, ₹/kg is resolved per GRADE from board_rates (so a new
// board prices correctly the moment it exists), and last_rate is written by
// procurement from a real PO. Writing a guess into any of them would create a
// second, competing price. min/max/reorder stay 0 — the warehouse reads 0 as
// "not set" and shows a dash.
const NEW_BOARD_DEFAULTS = {
  category: 'board',
  unit: 'sheets',
  gst_rate: 18,        // plant default for board
  reorder_level: 0,
  min_stock: 0,
  max_stock: 0,
  active: 1,
  leftover: 0,
};

const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const BATCH_NO = `OPEN-${String(data.counted_on).replace(/-/g, '')}`;
const NOTE = `Board intake — physical count ${data.counted_on} (counted in packets)`;

const client = new pg.Client({
  connectionString: url,
  ssl: /supabase|amazonaws|neon/.test(url) ? { rejectUnauthorized: false } : undefined,
});
await client.connect();

// Pre-flight. This script writes columns added by later migrations than the
// original materials table, and the production database is migrated separately
// from init(). Failing here names the missing column; failing inside the
// transaction would only say "column does not exist" halfway through a plan the
// operator has already read and approved.
const REQUIRED = ['name', 'category', 'spec', 'unit', 'sheet_l', 'sheet_w', 'grade', 'gsm',
  'sheets_per_packet', 'gst_rate', 'reorder_level', 'min_stock', 'max_stock', 'active', 'leftover'];
const present = new Set((await client.query(
  `SELECT column_name FROM information_schema.columns WHERE table_name='materials'`)).rows.map(r => r.column_name));
const missing = REQUIRED.filter(c => !present.has(c));
if (missing.length) {
  console.error(`\nmaterials is missing ${missing.length} column(s) this import writes: ${missing.join(', ')}`);
  console.error(`Migrate the target database before importing.\n`);
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

// Leftovers are excluded from matching AND from the taken-code set. An offcut is
// created carrying its parent's exact code (helpers.js createLeftover), so
// counting one as "taken" would push a genuinely new board onto a -1 suffix it
// has not earned. takenCodesFor is the helper that already encodes both rules.
const live = mats.filter(m => !m.leftover);
const byKey = new Map();
for (const m of live) {
  const k = key(m.grade, m.gsm, m.sheet_l, m.sheet_w);
  if (!byKey.has(k)) byKey.set(k, []);
  byKey.get(k).push(m);
}
const taken = takenCodesFor(mats, null);

// How this database actually packs each grade, by weight of numbers. The map is
// the plant spreadsheet's authority, but a target database that disagrees means
// the spreadsheet is stale THERE, and a new board would then pack differently
// from every one of its neighbours — silently, since packing only shows up once
// someone converts packets to sheets. Cheap to check, so check.
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
  if (!c) return null;
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0][0];
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
    // The board master has no UNIQUE constraint on name; the client form guards
    // it instead (Masters.jsx validate). A bulk writer has to carry that guard
    // itself, or an intake sheet could seed the duplicate the form prevents.
    const clash = live.find(x => String(x.name ?? '').trim().toLowerCase() === name.trim().toLowerCase());
    if (clash) {
      problems.push(`NAME CLASH  ${tag} → “${name}” is already board id ${clash.id} (${clash.spec}) with a different grade/GSM/size`);
      continue;
    }
    const spp = SHEETS_PER_PACKET[e.grade] ?? null;
    if (!(spp > 0)) {
      problems.push(`NO PACK SIZE ${tag} — grade “${e.grade}” has no known packing; set it on the master first`);
      continue;
    }
    const dom = dominantPacking(e.grade);
    if (dom != null && dom !== spp) {
      problems.push(`PACKING MISMATCH ${tag} — this import would pack ${e.grade} at ${spp}/packet, but the ${dom}/packet used by its neighbours here disagrees`);
      continue;
    }
    // Codes are generated in sheet order with `taken` growing as it goes — the
    // ordering precondition boardCode() documents. Seeded from every existing
    // code up front, so a new board can never take one already issued.
    const spec = boardCode({ grade: e.grade, gsm: e.gsm, sheet_l: e.sheet_l, sheet_w: e.sheet_w }, taken);
    if (!spec) { problems.push(`NO CODE     ${tag}`); continue; }
    taken.add(spec);
    creating = {
      ...NEW_BOARD_DEFAULTS,
      name, spec,
      grade: e.grade, gsm: e.gsm,
      sheet_l: e.sheet_l, sheet_w: e.sheet_w,
      sheets_per_packet: spp,
    };
    m = { id: null, name, spec, unit: creating.unit, sheets_per_packet: spp, available: 0 };
  }

  if (!(+m.sheets_per_packet > 0)) {
    problems.push(`NO PACK SIZE ${tag} (${m.spec}) — set sheets_per_packet on the master first`);
    continue;
  }
  const target = e.packets * +m.sheets_per_packet;
  plan.push({
    e, m, creating,
    packets: e.packets,
    target,
    current: +m.available,
    delta: target - +m.available,
  });
}

console.log(`\nSource   ${path.relative(root, file)}`);
console.log(`Database ${url.replace(/:[^:@/]+@/, ':***@')}`);
console.log(`Mode     ${APPLY ? 'APPLY — writing' : 'DRY RUN — nothing is written'}`);
console.log(`Batch    ${BATCH_NO}\n`);

const W = { code: 14, name: 34 };
console.log(`     ${'CODE'.padEnd(W.code)} ${'BOARD'.padEnd(W.name)} ${'PACKETS'.padStart(8)}  ${'= SHEETS'.padStart(9)}  ${'ON HAND'.padStart(9)}  ${'BOOKING'.padStart(10)}`);
for (const p of plan) {
  const mark = p.creating ? 'NEW ' : '    ';
  const flag = p.delta === 0 ? '   (already at level)' : '';
  console.log(`${mark} ${String(p.m.spec).padEnd(W.code)} ${String(p.m.name).padEnd(W.name)} ${String(p.packets).padStart(8)}  ${num(p.target).padStart(9)}  ${num(p.current).padStart(9)}  ${num(p.delta).padStart(10)}${flag}`);
}

if (problems.length) {
  console.log(`\n${problems.length} problem row(s) — these are NOT imported:`);
  for (const p of problems) console.log('  ' + p);
}

const creates = plan.filter(p => p.creating);
const totalPackets = plan.reduce((s, p) => s + p.packets, 0);
const totalSheets = plan.reduce((s, p) => s + p.target, 0);
const booking = plan.filter(p => p.delta !== 0);
console.log(`\n${plan.length} rows · ${creates.length} new board masters · ${plan.length - creates.length} already in the master`);
console.log(`${num(totalPackets)} packets · ${num(totalSheets)} sheets counted · ${booking.length} need a ledger entry · ${num(booking.reduce((s, p) => s + p.delta, 0))} sheets booked`);

if (creates.length) {
  console.log(`\nNew boards and the codes they will be given:`);
  for (const p of creates) {
    console.log(`  ${String(p.creating.spec).padEnd(W.code)} ${String(p.creating.name).padEnd(W.name)} ${String(p.creating.sheets_per_packet).padStart(3)} sheets/packet · GST ${p.creating.gst_rate}% · ${size(p.creating.sheet_l, p.creating.sheet_w)} in`);
  }
}

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

// One transaction: a created master and the stock it was created to hold either
// both land or neither does. A board that exists with no stock reads on the
// floor as "we have none of that", which is a worse state than not having the
// board at all.
await client.query('BEGIN');
try {
  let created = 0, booked = 0;
  for (const p of plan) {
    if (p.creating) {
      const c = p.creating;
      const [row] = (await client.query(
        `INSERT INTO materials
           (name, category, spec, unit, sheet_l, sheet_w, grade, gsm, sheets_per_packet,
            gst_rate, reorder_level, min_stock, max_stock, active, leftover)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [c.name, c.category, c.spec, c.unit, c.sheet_l, c.sheet_w, c.grade, c.gsm,
          c.sheets_per_packet, c.gst_rate, c.reorder_level, c.min_stock, c.max_stock,
          c.active, c.leftover])).rows;
      p.m.id = row.id;
      // Same shape the masters CRUD writes on a create (routes/masters.js), so a
      // board born here has the same history as one typed into the form.
      await client.query(
        `INSERT INTO audit_log (entity, entity_id, action, detail, user_name)
         VALUES ('materials',$1,'create',$2,'Board intake import')`,
        [row.id, `${c.name} (${c.spec}) — intake ${data.counted_on}`]);
      created++;
    }

    if (p.delta === 0) continue;
    // Mirrors the batch + movement pair POST /inventory/adjust writes, so an
    // imported opening balance is indistinguishable from a hand adjustment.
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
       VALUES ('inventory',$1,'opening-stock',$2,'Board intake import')`,
      [p.m.id, `${p.packets} packets = ${p.target} sheets`]);
    booked++;
  }
  await client.query('COMMIT');
  console.log(`\nApplied. ${created} board masters created, ${booked} ledger entries written under batch ${BATCH_NO}.\n`);
} catch (e) {
  await client.query('ROLLBACK');
  console.error('\nRolled back — nothing was written.\n', e.message);
  process.exitCode = 1;
}
await client.end();
