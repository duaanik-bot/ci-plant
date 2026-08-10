// Board-hold invariant checker. Exits non-zero when a hold has outlived its
// reason, so it can gate a deploy or be run on demand against prod.
//
//   node scripts/check-board-holds.mjs                 # $DATABASE_URL
//   node scripts/check-board-holds.mjs --url <conn>    # an explicit database
//
// THE INVARIANT
//
//   A board_allocations row with status='active' and source='stock' reserves
//   sheets that are still ON THE SHELF for a job that has not yet taken them.
//   Once the job DRAWS that board the sheets leave the warehouse and leave
//   `available` with it, so the hold must be retired in the same transaction.
//   A hold that survives its own draw subtracts the same sheets twice: once
//   because they are physically gone, once because they are still reserved.
//
// WHY THIS SCRIPT EXISTS
//
//   FBB · 280 GSM · 25x36, 8 Aug 2026. FOLEE-1 (line 118) drew 6,500 parent
//   sheets. Its 4,008-sheet hold stayed 'active' because cutting start retired
//   holds by TAG — three allow-lists (mix id / GRN cover reason / plan_lock
//   origin) — and that row, written by the Commit button with origin NULL,
//   matched none of them. GLYKIND (line 229) then read
//       free = 4,400 − 4,008 = 392   against   1,492 needed   →   Short 1,100
//   for board standing in the racks, while the Planning Engine panel beside it
//   read "stock OK" because its committed figure nets drawn jobs off. Two
//   screens, one board, opposite verdicts, for two days.
//
//   consumeDrawnHolds() now retires every stock hold on a drawn board whatever
//   wrote it, at both draw sites (cutting start, extra sheets). This script is
//   the belt to that braces: prevention lives in code that a future change can
//   still get wrong, and the failure is SILENT — nothing errors, a number is
//   just quietly too small. So the state stays detectable in one command.
//
//   `drawn` is the same predicate helpers.js BOARD_DRAWN_EXISTS uses, with the
//   gang rule (a run's board is consumed against the parent card, which carries
//   no order line of its own) and scoped to the hold's own material.
import pg from 'pg';

const argUrl = process.argv.includes('--url')
  ? process.argv[process.argv.indexOf('--url') + 1]
  : null;
// A prod .env value can end in a LITERAL backslash-n; trim that as well as real
// whitespace, or the connection string is silently malformed.
const raw = argUrl || process.env.DATABASE_URL || '';
const url = raw.replace(/\\n/g, '').trim();
if (!url) {
  console.error('No database. Pass --url <conn> or set DATABASE_URL.');
  process.exit(2);
}

const isRemote = u => !/@(localhost|127\.0\.0\.1)[:/]/.test(u);

const GHOSTS = `
  SELECT a.id, a.order_line_id, a.qty::int, a.origin, a.reason,
         m.name AS board, o.po_number, p.name AS product, ol.status AS line_status
  FROM board_allocations a
  JOIN order_lines ol ON ol.id = a.order_line_id
  JOIN orders     o  ON o.id  = ol.order_id
  JOIN products   p  ON p.id  = ol.product_id
  JOIN materials  m  ON m.id  = a.material_id
  WHERE a.status='active' AND a.source='stock'
    AND EXISTS (
      SELECT 1 FROM stock_movements sm
      JOIN job_cards jc ON jc.id = sm.ref_id AND sm.ref_type='job_card'
      WHERE sm.type='consumption' AND sm.material_id = a.material_id
        AND (jc.order_line_id = ol.id
             OR (ol.gang_run_id IS NOT NULL AND jc.order_line_id IS NULL
                 AND jc.gang_run_id = ol.gang_run_id)))
  ORDER BY a.qty DESC`;

const c = new pg.Client({
  connectionString: url,
  ssl: isRemote(url) ? { rejectUnauthorized: false } : undefined,
});
await c.connect();
const { rows } = await c.query(GHOSTS);
await c.end();

if (!rows.length) {
  console.log('✓ board holds clean — no hold outlives a board its job has already drawn');
  process.exit(0);
}

const total = rows.reduce((s, r) => s + r.qty, 0);
console.error(`✗ ${rows.length} hold(s) outlived their board — ${total.toLocaleString('en-IN')} parent sheets`);
console.error('  These sheets are subtracted TWICE: gone from the shelf, and still reserved.');
console.error('  Every other job on these boards is reading less free stock than the warehouse holds.\n');
for (const r of rows) {
  console.error(`  #${r.id}  ${r.qty.toLocaleString('en-IN')} sh  ${r.board}`);
  console.error(`        line ${r.order_line_id} (${r.line_status}) · PO ${r.po_number} · ${r.product}`);
  console.error(`        origin=${r.origin ?? 'NULL'} · "${r.reason}"`);
}
console.error('\n  Retire them with the same rule consumeDrawnHolds() applies:');
console.error("    UPDATE board_allocations SET status='consumed' WHERE id = ANY(ARRAY["
  + rows.map(r => r.id).join(',') + ']);');
process.exit(1);
