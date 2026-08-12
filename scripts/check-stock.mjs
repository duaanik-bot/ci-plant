// Stock-ledger invariant checker. The sibling of check-board-holds.mjs, and for
// the same reason: these failures are SILENT. Nothing errors, no screen turns
// red — a number is just quietly wrong, and the plant finds out when a job stops
// or a rack is emptier than the book.
//
//   node scripts/check-stock.mjs                 # $DATABASE_URL
//   node scripts/check-stock.mjs --url <conn>    # an explicit database
//
// WHY THIS EXISTS
//
//   11 Aug 2026. A 33-agent audit turned up, in one afternoon: 4,500 PHANTOM
//   sheets minted on a board that had never had a sheet issued (a cutting adjust
//   refunded to the product master's board instead of the substitute mix board
//   actually cut); two batches whose loose count contradicted their own pile
//   (12 loose on a 20-sheet pile asserts 8 sheets inside a sealed 144-packet);
//   nine over-received PO lines, one of them 3,650 against a 50-sheet order; and
//   four boards that have never had a GRN at all, between them cutting 15,088
//   sheets that were never counted in.
//
//   Every one of those was found by hand, by asking the right question. This
//   asks all of them in one command, so the next one surfaces the same day.
//
// Each check is INDEPENDENT and reports on its own. Exit 1 if any fails, so this
// can gate a deploy or run on a schedule.
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
const n = v => Number(v || 0).toLocaleString('en-IN');

const CHECKS = [
  {
    key: 'ledger',
    title: 'the movement ledger agrees with the batch levels',
    why: 'SUM(stock_movements) per material must equal SUM(stock_batches.qty). A gap means '
       + 'sheets appeared or vanished without a movement — the ledger is no longer the record.',
    sql: `
      SELECT m.id, m.name,
             COALESCE(mv.q,0)::int AS ledger,
             COALESCE(bt.q,0)::int AS batches,
             (COALESCE(mv.q,0) - COALESCE(bt.q,0))::int AS gap
      FROM materials m
      LEFT JOIN (SELECT material_id, SUM(qty) q FROM stock_movements
                  WHERE material_id IS NOT NULL GROUP BY 1) mv ON mv.material_id = m.id
      LEFT JOIN (SELECT material_id, SUM(qty) q FROM stock_batches GROUP BY 1) bt ON bt.material_id = m.id
      WHERE COALESCE(mv.q,0) <> COALESCE(bt.q,0)
      ORDER BY ABS(COALESCE(mv.q,0) - COALESCE(bt.q,0)) DESC`,
    line: r => `${r.name}: ledger ${n(r.ledger)} vs batches ${n(r.batches)} — gap ${n(r.gap)}`,
  },
  {
    key: 'loose',
    title: 'every pile obeys loose ≡ qty (mod packet)',
    why: 'A pile of N sheets holds N mod P loose and the rest in sealed packets. Anything else '
       + 'asserts sheets inside a sealed packet that cannot be there, and packet advice reads '
       + 'an explicit figure as a COUNT, never a guess.',
    sql: `
      SELECT sb.id, sb.batch_no, m.name, sb.qty::int AS qty, sb.loose_sheets,
             (sb.qty::int % m.sheets_per_packet) AS should_be
      FROM stock_batches sb JOIN materials m ON m.id = sb.material_id
      WHERE sb.status='available' AND sb.loose_sheets IS NOT NULL
        AND COALESCE(m.sheets_per_packet,0) > 0
        AND (sb.loose_sheets <> (sb.qty::int % m.sheets_per_packet) OR sb.loose_sheets > sb.qty)
      ORDER BY sb.id`,
    line: r => `batch ${r.id} ${r.batch_no} (${r.name}): ${n(r.qty)} sheets reads ${n(r.loose_sheets)} loose, must be ${n(r.should_be)}`,
  },
  {
    key: 'phantom',
    title: 'no board holds stock it never received',
    why: 'A material with stock on the books but no GRN and no opening count did not get it from '
       + 'anywhere. This is how a cutting adjust refunding to the WRONG board shows up: 4,500 '
       + 'sheets on a board of which not one had ever been issued.\n'
       + '    Legitimate inbound is a GRN or an OPENING COUNT (an adjustment with no ref). A ref\'d '
       + 'adjustment is a refund or a write-on against a job — counting it as arrival would let the '
       + 'phantom vouch for itself, which is exactly how batch 171 was created.',
    sql: `
      SELECT m.id, m.name,
             (SELECT COALESCE(SUM(qty),0)::int FROM stock_batches sb
               WHERE sb.material_id=m.id AND sb.status='available') AS on_book,
             (SELECT COALESCE(SUM(qty),0)::int FROM stock_movements sm
               WHERE sm.material_id=m.id AND sm.type='grn') AS received,
             (SELECT COALESCE(SUM(-qty),0)::int FROM stock_movements sm
               WHERE sm.material_id=m.id AND sm.type='consumption') AS ever_consumed
      FROM materials m
      WHERE (SELECT COALESCE(SUM(qty),0) FROM stock_batches sb
              WHERE sb.material_id=m.id AND sb.status='available') > 0
        AND (SELECT COALESCE(SUM(qty),0) FROM stock_movements sm
              WHERE sm.material_id=m.id
                AND (sm.type='grn' OR (sm.type='adjustment' AND sm.ref_type IS NULL))) <= 0
      ORDER BY 3 DESC`,
    line: r => `${r.name}: ${n(r.on_book)} sheets on the book, ${n(r.received)} ever received, ${n(r.ever_consumed)} ever consumed`,
  },
  {
    key: 'uncounted',
    title: 'no board is cutting more than was ever counted in',
    why: 'A board that has never had a GRN runs entirely on its opening count. Cutting more than '
       + 'that means either the count was low or board is arriving unbooked — both are receiving '
       + 'questions, and the difference is being plugged by write-ons.',
    sql: `
      SELECT m.id, m.name,
             COALESCE(SUM(sm.qty) FILTER (WHERE sm.type='adjustment' AND sm.ref_type IS NULL),0)::int AS counted_in,
             COALESCE(SUM(-sm.qty) FILTER (WHERE sm.type='consumption'),0)::int AS consumed,
             (COALESCE(SUM(-sm.qty) FILTER (WHERE sm.type='consumption'),0)
              - COALESCE(SUM(sm.qty) FILTER (WHERE sm.type='adjustment' AND sm.ref_type IS NULL),0))::int AS beyond
      FROM materials m JOIN stock_movements sm ON sm.material_id = m.id
      WHERE m.category='board'
      GROUP BY m.id, m.name
      HAVING COALESCE(SUM(sm.qty) FILTER (WHERE sm.type='grn'),0) = 0
         AND COALESCE(SUM(-sm.qty) FILTER (WHERE sm.type='consumption'),0)
             > COALESCE(SUM(sm.qty) FILTER (WHERE sm.type='adjustment' AND sm.ref_type IS NULL),0)
      ORDER BY 5 DESC`,
    line: r => `${r.name}: counted in ${n(r.counted_in)}, cut ${n(r.consumed)} — ${n(r.beyond)} beyond, never a GRN`,
    warnOnly: true,
  },
  {
    key: 'recounts',
    title: 'no write-on is left unreconciled',
    why: 'A write-on holds the book at nil when the floor took more than it held, and RAISES A '
       + 'RECOUNT. Left open, the board is only half-fixed. Closing one with a script instead of '
       + 'a count leaves the same hole with the alarm switched off.',
    sql: `
      SELECT w.id, w.qty::int, m.name, w.book_before::int, w.issued_qty::int,
             w.ref_type||'#'||w.ref_id AS ref, w.created_at::date AS raised
      FROM stock_writeons w LEFT JOIN materials m ON m.id = w.material_id
      WHERE w.reconciled_at IS NULL ORDER BY w.id`,
    line: r => `write-on #${r.id} ${n(r.qty)} sh on ${r.name} — book held ${n(r.book_before)}, floor took ${n(r.issued_qty)} (${r.ref}, raised ${r.raised})`,
    warnOnly: true,
  },
  {
    key: 'overreceipt',
    title: 'no PO line is received beyond its order',
    why: 'Board that arrived is on the shelf and is never refused — but an over-receipt means the '
       + 'vendor invoice cannot three-way match, and a large one is the shape of a receipt booked '
       + 'against whichever PO was on screen.',
    sql: `
      SELECT pl.id, po.po_number, m.name, pl.qty::int AS ordered, pl.received_qty::int AS received,
             (pl.received_qty - pl.qty)::int AS excess
      FROM po_lines pl
      JOIN purchase_orders po ON po.id = pl.purchase_order_id
      LEFT JOIN materials m ON m.id = pl.material_id
      WHERE pl.received_qty > pl.qty
      ORDER BY (pl.received_qty - pl.qty) DESC`,
    line: r => `${r.po_number} ${r.name}: ordered ${n(r.ordered)}, received ${n(r.received)} — ${n(r.excess)} over`,
    warnOnly: true,
  },
];

const c = new pg.Client({
  connectionString: url,
  ssl: isRemote(url) ? { rejectUnauthorized: false } : undefined,
});
await c.connect();

let failed = 0;
let warned = 0;
for (const chk of CHECKS) {
  let rows;
  try {
    ({ rows } = await c.query(chk.sql));
  } catch (e) {
    console.error(`? ${chk.title} — check could not run: ${e.message}`);
    failed++;
    continue;
  }
  if (!rows.length) {
    console.log(`✓ ${chk.title}`);
    continue;
  }
  // warnOnly findings are real states of the plant that need a HUMAN, not a
  // code fix — an unbooked delivery, an open recount, a vendor over-ship. They
  // are reported loudly and do not fail the run, or the check would be
  // permanently red and stop being read.
  const mark = chk.warnOnly ? '!' : '✗';
  const out = chk.warnOnly ? console.warn : console.error;
  out(`${mark} ${chk.title} — ${rows.length} finding(s)`);
  out(`    ${chk.why}`);
  for (const r of rows) out(`    · ${chk.line(r)}`);
  out('');
  if (chk.warnOnly) warned++; else failed++;
}

await c.end();

if (failed) {
  console.error(`\n${failed} invariant(s) BROKEN — the books contradict themselves.`);
  process.exit(1);
}
if (warned) {
  console.warn(`\n${warned} area(s) need a person, not a patch — count a rack, close a recount, or reconcile a PO.`);
}
console.log('\nStock ledger consistent.');
process.exit(0);
