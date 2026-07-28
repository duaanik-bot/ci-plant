// One-shot, idempotent backfill: gives the existing 303 board masters their
// structured grade / GSM / sheets-per-packet, generates a spec code for the 60
// blank-coded boards that parse (61 are blank, but id 278 does not parse and is
// skipped), and seeds the base ₹/kg rates from the plant spreadsheet.
//
// GUARANTEE — this script ONLY EVER FILLS BLANKS; it NEVER overwrites an
// existing value. Each of grade / gsm / sheets_per_packet / spec is written only
// when that column is currently NULL. So a board whose packing was corrected by
// hand (Task 6 makes sheets_per_packet editable) survives any number of re-runs.
// Re-deriving a row's fields after a rename is deliberately NOT supported — that
// would silently revert hand corrections, which is the hazard this rule exists
// to prevent.
//
// Updates rows in place matched by id — no inserts into materials, so it cannot
// create duplicate masters.
//
// Run: node src/backfill-boards.js         (dry run — prints what it would do)
//      node src/backfill-boards.js --apply (writes)

import { init, q, tx } from './db.js';
import { parseBoardName, boardCode } from './board-code.js';

// From the plant spreadsheet: Duplex packs 144 sheets, FBB/Saffire/SBS 100.
// Exported because a board created by an intake import must pack the same way a
// backfilled one does — two copies of this table would drift the day a grade's
// packing changes.
export const SHEETS_PER_PACKET = {
  'Duplex GB': 144, 'Duplex WB': 144,
  'FBB': 100, 'Saffire': 100, 'SBS': 100,
  'Chromo Paper': 150,
  // 'Paper' deliberately absent — unknown packing, left NULL.
};

// Base ₹/kg, exclusive of GST. Paper and Chromo Paper show "—" in the
// spreadsheet and stay unrated until the buyer sets a rate.
const BASE_RATES = { 'Duplex GB': 45, 'Duplex WB': 51, 'Saffire': 81, 'FBB': 79 };

// Pure: current rows in → planned writes out. Kept free of the DB so the
// fill-if-blank guarantee can be exercised without touching master data.
//
// `taken` is seeded with EVERY existing code up front rather than grown from
// empty, so a generated code can never collide with one belonging to a row
// further down the list. Rows are processed id ASC and `taken` grows as it goes
// — the ordering precondition boardCode() documents.
export function planBoardUpdates(rows) {
  const taken = new Set(rows.map(r => r.spec).filter(Boolean));
  const updates = [], skipped = [];

  for (const m of rows) {
    const p = parseBoardName(m.name);
    if (!p) { skipped.push({ id: m.id, name: m.name, why: 'name does not parse' }); continue; }

    let spec = m.spec || null;          // '' counts as blank, as before
    if (!spec) {
      spec = boardCode(p, taken);
      if (spec) taken.add(spec);
    }
    // `??` keeps whatever is already stored — the fill-if-blank guarantee.
    const u = {
      id: m.id,
      grade: m.grade ?? p.grade,
      gsm: m.gsm ?? p.gsm,
      sheets_per_packet: m.sheets_per_packet ?? (SHEETS_PER_PACKET[p.grade] ?? null),
      spec,
    };
    // Nothing blank → no UPDATE is issued at all, so a re-run is a true no-op
    // rather than a value-identical rewrite. (A grade with no known packing,
    // e.g. Paper, is not "needing a fill" — there is nothing to write.)
    u.needsWrite = m.grade == null || m.gsm == null || !m.spec
      || (m.sheets_per_packet == null && u.sheets_per_packet != null);
    updates.push(u);
  }
  return { updates, skipped };
}

export async function backfillBoards({ apply = false } = {}) {
  // init() rather than connect(): it opens the pool AND runs the migrations that
  // create materials.grade / gsm / sheets_per_packet and the board_rates table.
  // Against a fresh clone or a wiped .pgdata, connect() alone would fail with
  // "column does not exist". Idempotent and cheap — seed.js does the same.
  await init();

  const rows = await q(
    `SELECT id, name, spec, grade, gsm, sheets_per_packet, sheet_l, sheet_w
       FROM materials WHERE category='board' ORDER BY id`);
  const { updates, skipped } = planBoardUpdates(rows);
  const writes = updates.filter(u => u.needsWrite);

  if (apply) {
    await tx(async (qc) => {
      for (const u of writes) {
        await qc(
          `UPDATE materials SET grade=$1, gsm=$2, sheets_per_packet=$3, spec=$4 WHERE id=$5`,
          [u.grade, u.gsm, u.sheets_per_packet, u.spec, u.id]);
      }
      for (const [grade, rate] of Object.entries(BASE_RATES)) {
        // Idempotent: re-running does not clobber a rate the buyer has since edited.
        await qc(
          `INSERT INTO board_rates (grade, vendor_id, rate_per_kg, active)
           VALUES ($1, NULL, $2, 1)
           ON CONFLICT (grade, COALESCE(vendor_id, -1)) DO NOTHING`, [grade, rate]);
      }
    });
  }

  return { total: rows.length, updated: updates.length, filled: writes.length, skipped };
}

// Run directly (not when imported by a test).
if (process.argv[1]?.endsWith('backfill-boards.js')) {
  const apply = process.argv.includes('--apply');
  backfillBoards({ apply }).then(r => {
    console.log(`${apply ? 'APPLIED' : 'DRY RUN'} — ${r.updated}/${r.total} boards`);
    console.log(`rows needing a fill: ${r.filled} (0 = everything already populated)`);
    if (r.skipped.length) console.log('skipped:', r.skipped);
    process.exit(0);
  }).catch(e => { console.error(e); process.exit(1); });
}
