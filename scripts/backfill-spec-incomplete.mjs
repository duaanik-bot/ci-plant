// One-off correction: clear products.spec_incomplete on products that are
// demonstrably specified.
//
//   DATABASE_URL=… node scripts/backfill-spec-incomplete.mjs           # dry run
//   DATABASE_URL=… node scripts/backfill-spec-incomplete.mjs --apply   # writes
//
// WHY THIS EXISTS. spec_incomplete is set by the PO import and by the order
// desk's quick-create, and until main@aaabaab NOTHING cleared it — the Masters
// hint asked for a manual step nobody performs. So the flag accumulated on
// products that were later planned properly, and any UI keyed on it misfires.
//
// THE DISCRIMINATOR IS THE CHILD SHEET, NOT THE BOARD. The obvious test —
// "is it still on the placeholder board?" — is wrong twice over: 613 of the
// flagged products park on a purpose-built row literally named "Unspecified
// board" (id 278), NOT on the "lowest-id non-leftover board" that import.js and
// routes/masters.js resolve, so a board-id test clears exactly the rows it
// should keep. Measured on prod 2026-08-05:
//     flagged   : child sheet  16/629 , ups>1  20/629
//     unflagged : child sheet 966/967 , ups>1 946/967
// A child sheet (child_l + child_w) is what planning stamps once the cut layout
// is real, so it separates the two populations almost perfectly. A real board is
// required as well: a child sheet on the Unspecified board is still a job whose
// board nobody has chosen.
import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const url = process.env.DATABASE_URL;
if (!url) { console.error('Set DATABASE_URL.'); process.exit(2); }
const isRemote = !/@(localhost|127\.0\.0\.1)[:/]/.test(url);

const WHERE = `
  spec_incomplete = 1
  AND child_l IS NOT NULL AND child_w IS NOT NULL
  AND board_material_id IS NOT NULL
  AND board_material_id NOT IN (SELECT id FROM materials WHERE name ILIKE '%unspecified%')`;

const c = new pg.Client({ connectionString: url, ssl: isRemote ? { rejectUnauthorized: false } : undefined });
await c.connect();
try {
  await c.query('BEGIN');

  const { rows: [before] } = await c.query(
    `SELECT COUNT(*) FILTER (WHERE spec_incomplete = 1)::int AS flagged, COUNT(*)::int AS total FROM products`);
  const { rows: hits } = await c.query(
    `SELECT id, code, name, ups FROM products WHERE ${WHERE} ORDER BY code`);

  console.log(`products: ${before.total} total, ${before.flagged} flagged`);
  console.log(`would clear: ${hits.length}`);
  for (const h of hits) console.log(`  ${String(h.code).padEnd(10)} ups=${String(h.ups).padEnd(3)} ${h.name.slice(0, 52)}`);

  // Refuse a runaway. This correction is meant to touch tens of rows, not
  // hundreds; if it ever matches most of the flagged set, the discriminator has
  // stopped discriminating and a human should look before anything is written.
  if (hits.length > before.flagged * 0.25) {
    console.error(`\nREFUSING: ${hits.length} is more than a quarter of the ${before.flagged} flagged rows.`);
    await c.query('ROLLBACK');
    process.exit(1);
  }

  if (!APPLY) {
    await c.query('ROLLBACK');
    console.log('\ndry run — nothing written. Re-run with --apply.');
  } else {
    const { rowCount } = await c.query(`UPDATE products SET spec_incomplete = 0 WHERE ${WHERE}`);
    const { rows: [after] } = await c.query(
      `SELECT COUNT(*) FILTER (WHERE spec_incomplete = 1)::int AS flagged FROM products`);
    if (rowCount !== hits.length) {
      console.error(`\nREFUSING: updated ${rowCount} but expected ${hits.length}.`);
      await c.query('ROLLBACK');
      process.exit(1);
    }
    await c.query('COMMIT');
    console.log(`\napplied: ${rowCount} products cleared. flagged ${before.flagged} → ${after.flagged}`);
  }
} catch (e) {
  console.error('FAILED:', e.message);
  try { await c.query('ROLLBACK'); } catch {}
  process.exitCode = 1;
} finally {
  await c.end();
}
