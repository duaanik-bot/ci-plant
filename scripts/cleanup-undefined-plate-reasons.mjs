// One-off repair for the plates retired with no reason on 22 Aug 2026.
//
// /plates/assets/retire read its optional reason as String(req.body.reason),
// and JSON.stringify drops a key whose value is undefined — so the client's
// ordinary `reason: typed.trim() || undefined` sent NO key and the server
// stringified the absence into the nine-character word 'undefined'. That value
// is not null, so it beat COALESCE and overwrote the plate's remark, and it
// interpolated into the movement note and the audit line as a trailing
// '— undefined'. Fixed in routes/plates.js via helpers.js optionalText().
//
// The repair writes what the FIXED code would have written, and nothing more:
//   plate_assets.remarks            'undefined'                  -> NULL
//   plate_asset_movements.note      'Retired after 1 run(s) — undefined' -> 'Retired after 1 run(s)'
//   audit_log.detail                '… retired after 1 run(s) — undefined' -> '… retired after 1 run(s)'
//
// No reason is invented. The remark that COALESCE overwrote is NOT recoverable
// from any table, and "no reason recorded" is the truth; 'undefined' is a lie
// that reads like a real remark on the Plates Warehouse tab.
//
// Matching is suffix-anchored on ' — undefined' and exact on the remark, so a
// genuine reason that merely contains the word ("undefined edge on the cyan")
// can never be touched. Trailing text is removed by left(note, length-12) —
// ' — undefined' is 12 CHARACTERS — rather than a regex, because this database
// is SQL_ASCII and a multibyte em-dash inside a regex is its own trap.
//
//   node scripts/cleanup-undefined-plate-reasons.mjs            # dry run, prints the plan
//   node scripts/cleanup-undefined-plate-reasons.mjs --apply    # writes
import { q, connect, tx } from '../server/src/db.js';

// connect() only — never init(). No DDL is ever sent to the plant database.
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(1); }
if (/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL)) console.log('(local database)');
await connect();

const APPLY = process.argv.includes('--apply');
const SUFFIX = ' — undefined';          // 12 characters
const CUT = SUFFIX.length;

const plates = await q(
  `SELECT id, asset_number, remarks, status, product_id FROM plate_assets
   WHERE btrim(remarks) IN ('undefined','null') ORDER BY id`);
const moves = await q(
  `SELECT id, plate_asset_id, note FROM plate_asset_movements
   WHERE action='scrapped' AND note LIKE $1 ORDER BY id`, ['%' + SUFFIX]);
const audits = await q(
  `SELECT id, entity_id, detail FROM audit_log
   WHERE entity='plate_asset' AND action='retire' AND detail LIKE $1 ORDER BY id`, ['%' + SUFFIX]);

console.log(`\nplate_assets.remarks     ${plates.length} row(s)`);
for (const row of plates) console.log(`  #${row.id} ${row.asset_number} (product ${row.product_id}) remarks '${row.remarks}' -> NULL`);
console.log(`\nplate_asset_movements    ${moves.length} row(s)`);
for (const row of moves) console.log(`  #${row.id} '${row.note}' -> '${row.note.slice(0, -CUT)}'`);
console.log(`\naudit_log.detail         ${audits.length} row(s)`);
for (const row of audits) console.log(`  #${row.id} '${row.detail}' -> '${row.detail.slice(0, -CUT)}'`);

const total = plates.length + moves.length + audits.length;
if (!APPLY) {
  console.log(`\nDRY RUN — ${total} row(s) would change. Re-run with --apply to write.`);
  process.exit(0);
}

await tx(async (qc) => {
  const a = await qc(
    `UPDATE plate_assets SET remarks=NULL, updated_at=now()
     WHERE btrim(remarks) IN ('undefined','null') RETURNING id`);
  const b = await qc(
    `UPDATE plate_asset_movements SET note = left(note, length(note) - $2)
     WHERE action='scrapped' AND note LIKE $1 RETURNING id`, ['%' + SUFFIX, CUT]);
  const c = await qc(
    `UPDATE audit_log SET detail = left(detail, length(detail) - $2)
     WHERE entity='plate_asset' AND action='retire' AND detail LIKE $1 RETURNING id`, ['%' + SUFFIX, CUT]);
  console.log(`\nAPPLIED — remarks ${a.length}, movement notes ${b.length}, audit details ${c.length}`);
});

const left = await q(
  `SELECT (SELECT count(*) FROM plate_assets WHERE btrim(remarks) IN ('undefined','null'))
        + (SELECT count(*) FROM plate_asset_movements WHERE note LIKE $1)
        + (SELECT count(*) FROM audit_log WHERE detail LIKE $1) AS remaining`, ['%' + SUFFIX]);
console.log(`verification — rows still carrying the junk: ${left[0].remaining}`);
process.exit(0);
