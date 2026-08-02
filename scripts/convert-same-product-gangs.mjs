// Convert legacy SAME-PRODUCT gangs into Combined Runs.
//
// A gang means DIFFERENT products sharing one sheet, split apart after die
// cutting. A gang whose members are all the SAME carton is not that: it is
// repeat orders of one product, and running it as a gang makes sorting,
// pasting and QC happen once per sales order over an identical stack.
//
// Those runs exist because Combined Runs came later — the code now refuses to
// create one (POST /gang-runs re-routes a single-product selection), so this is
// a BACKFILL for what predates that rule, not an ongoing repair.
//
// Each converted run gets kind='merge', a fresh CI-MRG- number, and an audit
// row linking the old number to the new. Product masters are never touched.
//
// A run that has really started — a stage begun, board consumed, or children
// already split — is LEFT ALONE and reported: the floor is mid-run and its
// paperwork must not change under it.
//
//   node scripts/convert-same-product-gangs.mjs                 # dry run
//   node scripts/convert-same-product-gangs.mjs --apply         # writes
//   DATABASE_URL=... node scripts/convert-same-product-gangs.mjs --apply
import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const url = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5439/cierp';
const isRemote = !/@(localhost|127\.0\.0\.1)[:/]/.test(url);
const c = new pg.Client({ connectionString: url, ssl: isRemote ? { rejectUnauthorized: false } : undefined });
await c.connect();
console.log(`${APPLY ? 'APPLYING to' : 'DRY RUN against'} ${url.replace(/^[^@]*@/, '')}\n`);

// Combined Runs arrive with migration 0020 (gang_runs.kind). Before it lands
// every run is a gang by definition, so the survey still works — and this is
// exactly when you want it: to see what production holds BEFORE deploying.
// Writing, though, needs the column, so --apply refuses until then.
const { rows: [{ has_kind }] } = await c.query(`
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='gang_runs' AND column_name='kind'
  ) AS has_kind`);
if (!has_kind) {
  console.log('NOTE  gang_runs.kind is not on this database yet — migration 0020 has not been applied.');
  console.log('      Surveying anyway (every run is a gang before it lands).');
  if (APPLY) {
    console.log('\nREFUSING to write: apply migrations 0020 + 0021 first, then re-run with --apply.');
    await c.end();
    process.exit(1);
  }
  console.log('');
}

const { rows: runs } = await c.query(`
  SELECT gr.id, gr.gang_number,
         COUNT(ol.id)::int              AS members,
         COUNT(DISTINCT ol.product_id)::int AS products,
         MIN(p.code)                    AS product_code,
         MIN(p.name)                    AS product_name
  FROM gang_runs gr
  JOIN order_lines ol ON ol.gang_run_id = gr.id
  JOIN products p ON p.id = ol.product_id
  ${has_kind ? `WHERE gr.kind = 'gang'` : ''}
  GROUP BY gr.id, gr.gang_number
  HAVING COUNT(DISTINCT ol.product_id) = 1 AND COUNT(ol.id) >= 2
  ORDER BY gr.id`);

if (!runs.length) { console.log('No legacy same-product gangs — nothing to do.'); await c.end(); process.exit(0); }

// The same "has it really started?" test the convert endpoint uses. Status is
// NOT the test: createJobCardForGang flips every member to in_production the
// moment a card is minted, so a run whose card has never been touched still
// reads in_production while nothing has physically happened.
const progressOf = async runId => {
  const { rows: [card] } = await c.query(
    `SELECT id, jc_number FROM job_cards WHERE gang_run_id=$1 AND parent_job_card_id IS NULL`, [runId]);
  if (!card) return null;
  const { rows: [started] } = await c.query(
    `SELECT stage FROM job_stages WHERE job_card_id=$1 AND status <> 'pending' LIMIT 1`, [card.id]);
  if (started) return `${card.jc_number} has started ${started.stage.replace('_', ' ')}`;
  const { rows: [used] } = await c.query(
    `SELECT 1 FROM stock_movements WHERE ref_type='job_card' AND ref_id=$1 AND type='consumption' LIMIT 1`, [card.id]);
  if (used) return `board already issued to ${card.jc_number}`;
  const { rows: [kid] } = await c.query('SELECT 1 FROM job_cards WHERE parent_job_card_id=$1 LIMIT 1', [card.id]);
  if (kid) return `${card.jc_number} has already split`;
  return { card };   // a card exists but nothing has happened — convertible
};

// On a dry run nothing is written, so MAX() never advances and every row would
// preview the same number. Track the last one handed out so the preview reads
// exactly like the real thing.
let previewed = 0;
const nextMrg = async () => {
  const { rows: [r] } = await c.query(
    `SELECT COALESCE(MAX((substring(gang_number FROM '\\d+$'))::int), 0) AS n
     FROM gang_runs WHERE gang_number LIKE 'CI-MRG-%'`);
  const next = Math.max(+r.n || 0, previewed) + 1;
  previewed = next;
  return `CI-MRG-${String(next).padStart(4, '0')}`;
};

let converted = 0, skipped = 0;
for (const r of runs) {
  const blocked = await progressOf(r.id);
  if (typeof blocked === 'string') {
    console.log(`  SKIP  ${r.gang_number}  ${r.product_code} × ${r.members} POs — ${blocked}`);
    skipped++;
    continue;
  }
  const card = blocked?.card || null;
  const num = await nextMrg();
  console.log(`  ${APPLY ? 'CONVERT' : 'would convert'}  ${r.gang_number} → ${num}  ${r.product_code} × ${r.members} POs`
    + (card ? `  (dissolving unstarted ${card.jc_number}, members back to planned)` : ''));
  if (!APPLY) { converted++; continue; }

  try {
    await c.query('BEGIN');
    if (card) {
      await c.query('DELETE FROM job_stages WHERE job_card_id=$1', [card.id]);
      await c.query('DELETE FROM job_cards WHERE id=$1', [card.id]);
      await c.query(
        `UPDATE order_lines SET status='planned' WHERE gang_run_id=$1 AND status IN ('ready','in_production')`, [r.id]);
    }
    await c.query(
      `UPDATE gang_runs SET kind='merge', gang_number=$1,
              product_id=(SELECT product_id FROM order_lines WHERE gang_run_id=$2 LIMIT 1)
       WHERE id=$2`, [num, r.id]);
    await c.query(
      `INSERT INTO audit_log (entity, entity_id, action, detail, user_name)
       VALUES ('gang_run',$1,'convert_to_merge',$2,'backfill script')`,
      [r.id, `${r.gang_number} → ${num}: ${r.members} sales orders of ${r.product_name} become one combined run — no split. Product masters untouched.`]);
    await c.query('COMMIT');
    converted++;
  } catch (e) {
    await c.query('ROLLBACK');
    console.log(`  FAILED ${r.gang_number}: ${e.message}`);
    skipped++;
  }
}

console.log(`\n${APPLY ? 'Converted' : 'Would convert'} ${converted} · left alone ${skipped}`);
if (!APPLY) console.log('Re-run with --apply to write.');
await c.end();
