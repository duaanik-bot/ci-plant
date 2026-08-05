// Direct goods receipt from a purchase sheet — creates one GRN per line without
// a purchase order, then puts each through QC.
//
//   node scripts/import-grn.mjs                  dry run against $DATABASE_URL (default local)
//   node scripts/import-grn.mjs --apply          write it
//   node scripts/import-grn.mjs path/to.json     a different receipt
//
// This replicates POST /procurement/grns/direct followed by POST
// /procurement/grns/:id/qc, statement for statement, because a receipt booked by
// hand has to be indistinguishable from one typed into the app: same GRN
// numbering, same quarantine-then-release batch lifecycle, same movement rows,
// same audit trail. Board that appears in stock with no GRN behind it cannot be
// reconciled against a supplier invoice later.
//
// WHY DIRECT AND NOT AGAINST A PO. These lines arrived on a purchase the ERP
// never carried a PO for. /grns/direct exists for exactly that case — it leaves
// purchase_order_id and po_line_id NULL, records the vendor, and QC then touches
// no PO line, no PO status and no board allocation.
//
// Quantities on the sheet are PACKETS; the ledger is sheet-denominated, so each
// line converts through its own master's sheets_per_packet. A line whose board
// has no master is refused outright rather than guessed onto a near-miss size —
// 25x32 and 26x32 are two real boards in this master.
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_LOCAL = 'postgresql://postgres:postgres@localhost:5439/cierp';
const APPLY = process.argv.includes('--apply');
const url = process.env.DATABASE_URL || DEFAULT_LOCAL;
const file = process.argv.find(a => a.endsWith('.json'))
  || path.join(root, 'scripts/data/grn-kalra-2026-07-31.json');

const norm = s => String(s ?? '').trim().toLowerCase();
const num = n => Number(n).toLocaleString('en-IN');
const data = JSON.parse(fs.readFileSync(file, 'utf8'));

const client = new pg.Client({
  connectionString: url,
  ssl: /supabase|amazonaws|neon/.test(url) ? { rejectUnauthorized: false } : undefined,
});
await client.connect();

const [vendor] = (await client.query(`SELECT id, name, active FROM vendors WHERE id=$1`, [data.vendor_id])).rows;
if (!vendor) { console.error(`\nNo vendor with id ${data.vendor_id}.\n`); await client.end(); process.exit(1); }
if (norm(vendor.name) !== norm(data.vendor_name)) {
  console.error(`\nVendor id ${data.vendor_id} is “${vendor.name}”, but the file names “${data.vendor_name}”.\n`);
  await client.end(); process.exit(1);
}

const mats = (await client.query(`
  SELECT id, spec, name, grade, gsm, sheet_l, sheet_w, unit, leftover, sheets_per_packet
  FROM materials WHERE category='board' AND COALESCE(leftover,0)=0`)).rows;
const k4 = (g, gsm, l, w) => [norm(g), +gsm, +l, +w].join('|');
const byK4 = new Map();
for (const m of mats) {
  const k = k4(m.grade, m.gsm, m.sheet_l, m.sheet_w);
  if (!byK4.has(k)) byK4.set(k, []);
  byK4.get(k).push(m);
}

const plan = [], problems = [];
for (const l of data.lines) {
  const tag = `line ${String(l.line).padStart(2)}  ${l.grade} ${l.gsm} GSM ${l.sheet_l}x${l.sheet_w}`;
  const hits = byK4.get(k4(l.grade, l.gsm, l.sheet_l, l.sheet_w)) || [];
  if (hits.length > 1) { problems.push(`AMBIGUOUS    ${tag} → ${hits.map(h => h.spec).join(', ')}`); continue; }
  if (!hits.length) { problems.push(`NO MASTER    ${tag} — ${l.packets} packets cannot be received`); continue; }
  const m = hits[0];
  if (!(+m.sheets_per_packet > 0)) { problems.push(`NO PACK SIZE ${tag} (${m.spec})`); continue; }
  if (!(+l.packets > 0)) { problems.push(`BAD QTY      ${tag} — packets must be positive`); continue; }
  plan.push({ l, m, sheets: +(l.packets * +m.sheets_per_packet).toFixed(4) });
}

console.log(`\nSource   ${path.relative(root, file)}`);
console.log(`Database ${url.replace(/:[^:@/]+@/, ':***@')}`);
console.log(`Mode     ${APPLY ? 'APPLY — writing' : 'DRY RUN — nothing is written'}`);
console.log(`Vendor   ${vendor.name} (id ${vendor.id})${vendor.active ? '' : '  ** INACTIVE **'}`);
console.log(`Purchase ${data.purchase_date}   ·   Received ${data.received_on}\n`);

const W = { code: 14, name: 34 };
console.log(`  ${'CODE'.padEnd(W.code)} ${'BOARD'.padEnd(W.name)} ${'PACKETS'.padStart(8)} ${'SHEETS'.padStart(9)}`);
for (const p of plan)
  console.log(`  ${String(p.m.spec).padEnd(W.code)} ${String(p.m.name).padEnd(W.name)} ${String(p.l.packets).padStart(8)} ${num(p.sheets).padStart(9)}`);

if (problems.length) {
  console.log(`\n${problems.length} line(s) NOT received:`);
  for (const p of problems) console.log('  ' + p);
}
console.log(`\n${data.lines.length} lines · ${plan.length} receivable · ${problems.length} refused`);
console.log(`${num(plan.reduce((s, p) => s + +p.l.packets, 0).toFixed(2))} packets · ${num(plan.reduce((s, p) => s + p.sheets, 0))} sheets`);

if (!APPLY) {
  console.log(`\nNothing written. Re-run with --apply to book it.\n`);
  await client.end();
  process.exit(0);
}
if (!plan.length) { console.log(`\nNothing to receive.\n`); await client.end(); process.exit(1); }

// Mirrors helpers.js nextNumber — the HIGHEST number already on the CI-GRN-
// prefix, never the newest row. Kept inline rather than imported so this script
// does not pull in server/src/db.js, whose module-level pg type parsers would
// change how every numeric in this import is read. Called per line inside the
// transaction so each GRN sees the one before it.
async function nextGrnNumber() {
  const [row] = (await client.query(
    `SELECT grn_number AS n FROM grns
      WHERE left(grn_number, length($1)) = $1
        AND substr(grn_number, length($1) + 1) ~ '^[0-9]+$'
      ORDER BY length(grn_number) DESC, grn_number DESC LIMIT 1`, ['CI-GRN-'])).rows;
  const seq = row?.n ? parseInt(String(row.n).slice('CI-GRN-'.length), 10) + 1 : 1;
  return `CI-GRN-${String(seq).padStart(4, '0')}`;
}

await client.query('BEGIN');
try {
  const made = [];
  for (const p of plan) {
    const grn_number = await nextGrnNumber();
    const bno = `${grn_number}-B1`;

    // ── POST /grns/direct ──
    const [g] = (await client.query(
      `INSERT INTO grns (grn_number, purchase_order_id, po_line_id, material_id, qty, batch_no,
                         vendor_id, source, vehicle_no, supplier_invoice_no, supplier_invoice_date,
                         received_by, remarks, received_at)
       VALUES ($1,NULL,NULL,$2,$3,$4,$5,'direct',$6,$7,$8,$9,$10,$11) RETURNING id`,
      [grn_number, p.m.id, p.sheets, bno, vendor.id, data.vehicle_no || null,
        data.supplier_invoice_no || null, data.purchase_date, data.received_by,
        `${data.remarks} — ${p.l.packets} packets`, data.received_on])).rows;
    const [b] = (await client.query(
      `INSERT INTO stock_batches (material_id, batch_no, qty, initial_qty, unit, status, grn_id)
       VALUES ($1,$2,$3,$3,$4,'quarantine',$5) RETURNING id`,
      [p.m.id, bno, p.sheets, p.m.unit || 'sheets', g.id])).rows;
    await client.query(
      `INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
       VALUES ($1,$2,'grn',$3,'grn',$4,$5)`,
      [p.m.id, b.id, p.sheets, g.id, `GRN ${grn_number} (direct, quarantine)`]);
    await client.query(
      `INSERT INTO audit_log (entity, entity_id, action, detail, user_name)
       VALUES ('grn',$1,'receive_direct',$2,$3)`,
      [g.id, `${grn_number} — ${p.sheets} received without a PO`, data.received_by]);

    // ── POST /grns/:id/qc { accept: true } ──
    // A direct receipt has no po_line_id and no purchase_order_id, so the PO
    // credit and the board-allocation shrink in that route are both skipped.
    await client.query(`UPDATE stock_batches SET status='available' WHERE id=$1`, [b.id]);
    await client.query(
      `INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
       VALUES ($1,$2,'qc_release',0,'grn',$3,$4)`,
      [p.m.id, b.id, g.id, data.qc_note]);
    await client.query(
      `UPDATE grns SET status='accepted', qc_at=$1, qc_note=$2 WHERE id=$3`,
      [data.received_on, data.qc_note, g.id]);
    await client.query(
      `INSERT INTO audit_log (entity, entity_id, action, detail, user_name)
       VALUES ('grn',$1,'qc_accept',$2,$3)`,
      [g.id, data.qc_note, data.qc_by]);

    made.push({ grn_number, spec: p.m.spec, name: p.m.name, packets: p.l.packets, sheets: p.sheets });
  }
  await client.query('COMMIT');
  console.log(`\nApplied. ${made.length} GRNs received from ${vendor.name} and QC-accepted:`);
  for (const m of made)
    console.log(`  ${m.grn_number}  ${String(m.spec).padEnd(W.code)} ${String(m.name).padEnd(W.name)} ${String(m.packets).padStart(8)} pkt = ${num(m.sheets)} sheets`);
  console.log();
} catch (e) {
  await client.query('ROLLBACK');
  console.error('\nRolled back — nothing was written.\n', e.message);
  process.exitCode = 1;
}
await client.end();
