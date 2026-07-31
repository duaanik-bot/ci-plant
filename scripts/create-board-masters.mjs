// Create board masters from a list, with the same guards the Boards form applies.
//
//   node scripts/create-board-masters.mjs                 dry run against $DATABASE_URL (default local)
//   node scripts/create-board-masters.mjs --apply         write it
//   node scripts/create-board-masters.mjs path/to.json    a different list
//
// WHY THIS IS SEPARATE FROM THE IMPORTERS. import-boards.mjs creates a master AND
// books opening stock in one transaction, which is right for an intake sheet. A
// board that is about to be RECEIVED must not arrive with an opening balance —
// its quantity has to come in through a GRN so there is a supplier, a batch and a
// QC decision behind it. So this script only creates the master, and the GRN
// import books the stock afterwards.
//
// Guards carried over from import-boards.mjs, because materials has no UNIQUE on
// name and none on grade+GSM+size — the client form is what normally prevents a
// duplicate, so a bulk writer has to prevent it itself:
//   · refuses a grade+GSM+size that already exists (that IS the duplicate rule)
//   · refuses a name that already exists on a different board
//   · refuses a grade with no known packing
//   · refuses if this database packs that grade differently from the map
//   · issues codes from every code already taken, leftovers excluded
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
  || path.join(root, 'scripts/data/new-board-masters-2026-07-31.json');

// Matches Masters.jsx CONFIGS.boards.defaults and import-boards.mjs. hsn_code,
// std_rate and last_rate stay absent: ₹/kg resolves per grade from board_rates,
// so a new board prices correctly the moment it exists, and a guess written here
// would compete with it.
const NEW_BOARD_DEFAULTS = {
  category: 'board', unit: 'sheets', gst_rate: 18,
  reorder_level: 0, min_stock: 0, max_stock: 0, active: 1, leftover: 0,
};

const norm = s => String(s ?? '').trim().toLowerCase();
const k4 = (g, gsm, l, w) => [norm(g), +gsm, +l, +w].join('|');
const data = JSON.parse(fs.readFileSync(file, 'utf8'));

const client = new pg.Client({
  connectionString: url,
  ssl: /supabase|amazonaws|neon/.test(url) ? { rejectUnauthorized: false } : undefined,
});
await client.connect();

const mats = (await client.query(
  `SELECT id, name, spec, grade, gsm, sheet_l, sheet_w, leftover, sheets_per_packet
   FROM materials WHERE category='board' ORDER BY id`)).rows;
const live = mats.filter(m => !m.leftover);
const byK4 = new Set(live.map(m => k4(m.grade, m.gsm, m.sheet_l, m.sheet_w)));
const taken = takenCodesFor(mats, null);

const packing = new Map();
for (const m of live) {
  if (!(+m.sheets_per_packet > 0)) continue;
  const g = norm(m.grade);
  if (!packing.has(g)) packing.set(g, new Map());
  const c = packing.get(g);
  c.set(+m.sheets_per_packet, (c.get(+m.sheets_per_packet) || 0) + 1);
}
const dominantPacking = g => {
  const c = packing.get(norm(g));
  return c ? [...c.entries()].sort((a, b) => b[1] - a[1])[0][0] : null;
};

const plan = [], problems = [];
for (const e of data.boards) {
  const tag = `${e.grade} ${e.gsm} GSM ${e.sheet_l}x${e.sheet_w}`;
  if (byK4.has(k4(e.grade, e.gsm, e.sheet_l, e.sheet_w))) {
    problems.push(`ALREADY EXISTS ${tag} — a board with this grade, GSM and size is already in the master`);
    continue;
  }
  const name = boardName({ grade: e.grade, gsm: e.gsm, sheet_l: e.sheet_l, sheet_w: e.sheet_w });
  if (!name) { problems.push(`UNNAMEABLE     ${tag}`); continue; }
  const clash = live.find(x => norm(x.name) === norm(name));
  if (clash) { problems.push(`NAME CLASH     ${tag} → “${name}” is already board id ${clash.id} (${clash.spec})`); continue; }
  const spp = SHEETS_PER_PACKET[e.grade] ?? null;
  if (!(spp > 0)) { problems.push(`NO PACK SIZE   ${tag} — grade “${e.grade}” has no known packing`); continue; }
  const dom = dominantPacking(e.grade);
  if (dom != null && dom !== spp) {
    problems.push(`PACKING MISMATCH ${tag} — would pack at ${spp}/packet, neighbours here use ${dom}`);
    continue;
  }
  const spec = boardCode({ grade: e.grade, gsm: e.gsm, sheet_l: e.sheet_l, sheet_w: e.sheet_w }, taken);
  if (!spec) { problems.push(`NO CODE        ${tag}`); continue; }
  taken.add(spec);
  byK4.add(k4(e.grade, e.gsm, e.sheet_l, e.sheet_w));
  plan.push({
    ...NEW_BOARD_DEFAULTS, name, spec,
    grade: e.grade, gsm: e.gsm, sheet_l: e.sheet_l, sheet_w: e.sheet_w,
    sheets_per_packet: spp, why: e.why || null,
  });
}

console.log(`\nSource   ${path.relative(root, file)}`);
console.log(`Database ${url.replace(/:[^:@/]+@/, ':***@')}`);
console.log(`Mode     ${APPLY ? 'APPLY — writing' : 'DRY RUN — nothing is written'}\n`);
console.log(`  ${'CODE'.padEnd(14)} ${'BOARD'.padEnd(34)} ${'PACK'.padStart(5)}  GST`);
for (const p of plan)
  console.log(`  ${String(p.spec).padEnd(14)} ${String(p.name).padEnd(34)} ${String(p.sheets_per_packet).padStart(5)}  ${p.gst_rate}%`);
if (problems.length) {
  console.log(`\n${problems.length} not created:`);
  for (const p of problems) console.log('  ' + p);
}
console.log(`\n${data.boards.length} requested · ${plan.length} to create · ${problems.length} refused`);

if (!APPLY) { console.log(`\nNothing written. Re-run with --apply to create them.\n`); await client.end(); process.exit(problems.length ? 1 : 0); }
if (problems.length) { console.log(`\nRefusing to apply while ${problems.length} cannot be resolved.\n`); await client.end(); process.exit(1); }

await client.query('BEGIN');
try {
  for (const c of plan) {
    const [row] = (await client.query(
      `INSERT INTO materials
         (name, category, spec, unit, sheet_l, sheet_w, grade, gsm, sheets_per_packet,
          gst_rate, reorder_level, min_stock, max_stock, active, leftover)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [c.name, c.category, c.spec, c.unit, c.sheet_l, c.sheet_w, c.grade, c.gsm,
        c.sheets_per_packet, c.gst_rate, c.reorder_level, c.min_stock, c.max_stock,
        c.active, c.leftover])).rows;
    // Same shape the masters CRUD writes on a create (routes/masters.js).
    await client.query(
      `INSERT INTO audit_log (entity, entity_id, action, detail, user_name)
       VALUES ('materials',$1,'create',$2,$3)`,
      [row.id, `${c.name} (${c.spec})${c.why ? ' — ' + c.why : ''}`, data.created_by || 'Board master import']);
    console.log(`  created id ${row.id}  ${c.spec}  ${c.name}`);
  }
  await client.query('COMMIT');
  console.log(`\nApplied. ${plan.length} board master(s) created.\n`);
} catch (e) {
  await client.query('ROLLBACK');
  console.error('\nRolled back — nothing was written.\n', e.message);
  process.exitCode = 1;
}
await client.end();
