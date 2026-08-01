// Close the numbering holes in a customer's internal code series.
//
//   node scripts/close-series-gaps.mjs                        report holes in every series
//   node scripts/close-series-gaps.mjs --series SGB           dry run for one series
//   node scripts/close-series-gaps.mjs --series SGB --apply [--prod-i-mean-it]
//
// The internal series is OURS (Anik, 2026-08-01: "that is our series… you can
// reorder the internal series, but no fuck ups with my client's item code or
// artwork code"). This script therefore touches products.code and its mirror
// internal_carton_code, and NOTHING else — party_item_code and
// party_artwork_code are never read for writing, never altered.
//
// Holes appear when a product leaves a series — e.g. three ZIKDUCE cartons
// re-filed from SGB- to SW- left Biotech running 332 products across 335
// numbers. Closing them slides every product above each hole down.
//
// --series IS REQUIRED to act. Hole-closing is the one operation here that
// renames products which are otherwise perfectly fine, so it never runs across
// the whole master by default; you name the one series you mean.
//
// TWO-PHASE RENAME. products.code is UNIQUE, so moving SGB-329 down to SGB-326
// can collide with a code that has not been vacated yet. Every row is first
// parked on a temporary code, then landed on its final one — which makes the
// result independent of ordering rather than relying on "descending happens to
// work".
//
// THE PAPERWORK IS THE REAL COST. Job bags, travelers and POs already on the
// floor carry the old codes, and unlike a re-file these products did nothing
// wrong — they just sat above a hole. The old → new CSV is the deliverable
// that makes this safe to live with; blast radius (orders, job cards, shade
// cards per product) is printed before anything is written.
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_LOCAL = 'postgresql://postgres:postgres@localhost:5439/cierp';
const APPLY = process.argv.includes('--apply');
const PROD_OK = process.argv.includes('--prod-i-mean-it');
const seriesArg = (process.argv[process.argv.indexOf('--series') + 1] || '').toUpperCase();
const url = process.env.DATABASE_URL || DEFAULT_LOCAL;

const c = new pg.Client({ connectionString: url });
await c.connect();
const where = /supabase|pooler|amazonaws/.test(url) ? 'REMOTE/PROD' : 'local mirror';
console.log(`close-series-gaps — ${APPLY ? 'APPLY' : 'dry run'} against ${where}`);
if (APPLY && where !== 'local mirror' && !PROD_OK) {
  console.error('Refusing to --apply against a remote database without --prod-i-mean-it.');
  process.exit(1);
}
if (APPLY && where !== 'local mirror') console.log('*** WRITING TO PRODUCTION ***');

const rows = (await c.query(`SELECT p.id, p.code, p.name, p.active, cu.name AS customer,
    split_part(p.code,'-',1) AS series, split_part(p.code,'-',2)::int AS num
  FROM products p LEFT JOIN customers cu ON cu.id = p.customer_id
  WHERE p.code ~ '^[A-Z]+-[0-9]+$' ORDER BY 6, 7`)).rows;

const bySeries = new Map();
for (const r of rows) {
  if (!bySeries.has(r.series)) bySeries.set(r.series, []);
  bySeries.get(r.series).push(r);
}
console.log('\n== series density ==');
for (const [s, list] of [...bySeries].sort((a, b) => b[1].length - a[1].length)) {
  const highest = Math.max(...list.map(r => r.num));
  console.log(`  ${s.padEnd(4)} ${String(list.length).padStart(4)} products, highest ${highest}, holes ${highest - list.length}`);
}
if (!seriesArg) {
  console.log('\nReport only. Pass --series <PREFIX> to close one series\' holes.');
  await c.end(); process.exit(0);
}
const list = bySeries.get(seriesArg);
if (!list) { console.error(`\nNo such series: ${seriesArg}`); process.exit(1); }

// Slide everything down so the series runs 1..N with no holes, keeping the
// existing order. A product already sitting on its target number is untouched.
const pad = n => `${seriesArg}-${String(n).padStart(3, '0')}`;
const plan = list
  .sort((a, b) => a.num - b.num)
  .map((r, i) => ({ ...r, to: pad(i + 1) }))
  .filter(r => r.to !== r.code);

console.log(`\n== ${seriesArg}: ${plan.length} product(s) move to close ${Math.max(...list.map(r => r.num)) - list.length} hole(s) ==`);
if (!plan.length) { console.log('  already dense — nothing to do.'); await c.end(); process.exit(0); }

console.log('\n== blast radius: what already references these ==');
const ids = plan.map(p => p.id);
const refs = (await c.query(`SELECT p.id,
    (SELECT count(*) FROM order_lines  ol WHERE ol.product_id = p.id)::int orders,
    (SELECT count(*) FROM job_cards    jc WHERE jc.product_id = p.id)::int job_cards,
    (SELECT count(*) FROM shade_cards  sc WHERE sc.product_id = p.id)::int shade_cards
  FROM products p WHERE p.id = ANY($1)`, [ids])).rows;
const refOf = new Map(refs.map(r => [r.id, r]));
for (const p of plan) {
  const r = refOf.get(p.id) || {};
  console.log(`  ${p.code} → ${p.to}  orders=${r.orders} job_cards=${r.job_cards} shade_cards=${r.shade_cards}${p.active ? '' : '  [inactive]'}`);
  console.log(`      ${String(p.name).slice(0, 64)}`);
}
const totals = refs.reduce((a, r) => ({ o: a.o + r.orders, j: a.j + r.job_cards, s: a.s + r.shade_cards }), { o: 0, j: 0, s: 0 });
console.log(`  TOTAL referencing rows — order_lines ${totals.o}, job_cards ${totals.j}, shade_cards ${totals.s}`);
console.log('  (all key on products.id, so they follow the rename automatically)');

// Display strings that name a product by code, and so must be rewritten.
const remarks = (await c.query(`SELECT id, product_id, remarks FROM shade_cards
  WHERE remarks LIKE ANY($1)`, [plan.map(p => `%${p.code}%`)])).rows;
console.log(`\n== shade_cards.remarks naming a moved code: ${remarks.length} ==`);
for (const s of remarks) console.log(`  card #${s.id}: "${s.remarks}"`);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const csv = ['old_code,new_code,product_id,customer,active,orders,job_cards,product_name',
  ...plan.map(p => { const r = refOf.get(p.id) || {};
    return `${p.code},${p.to},${p.id},"${p.customer}",${p.active},${r.orders},${r.job_cards},"${String(p.name).replace(/"/g, '""')}"`; })].join('\n');
const csvPath = path.join(root, `series-gap-close-${seriesArg}-${stamp}.csv`);
fs.writeFileSync(csvPath, csv);
console.log(`\nold → new CSV (the floor still carries the old codes) → ${csvPath}`);

if (!APPLY) { console.log('\nDry run — nothing written. Re-run with --apply.'); await c.end(); process.exit(0); }

const bpath = path.join(root, `SERIES-GAP-BACKUP-${seriesArg}-${stamp}.json`);
fs.writeFileSync(bpath, JSON.stringify({ when: new Date().toISOString(), series: seriesArg, plan, remarks }, null, 2));
console.log(`backup → ${bpath}`);

try {
  await c.query('BEGIN');
  // Phase 1 — park every mover on a code nothing can collide with.
  for (const p of plan) {
    await c.query('UPDATE products SET code=$1, internal_carton_code=$1 WHERE id=$2', [`TMP~${p.id}`, p.id]);
  }
  // Phase 2 — land them on their final numbers.
  for (const p of plan) {
    await c.query('UPDATE products SET code=$1, internal_carton_code=$1 WHERE id=$2', [p.to, p.id]);
    await c.query(
      `INSERT INTO audit_log (entity, entity_id, action, detail, user_name, created_at)
       VALUES ('products', $1, 'update', $2, 'close-series-gaps script', now())`,
      [p.id, `code: ${p.code} → ${p.to}; internal_carton_code: ${p.code} → ${p.to} (closed a gap in the ${seriesArg}- series)`]);
  }
  for (const s of remarks) {
    let text = s.remarks;
    for (const p of plan) text = text.split(p.code).join(p.to);
    await c.query('UPDATE shade_cards SET remarks=$1 WHERE id=$2', [text, s.id]);
  }
  const dup = await c.query(`SELECT count(*)::int n FROM (
    SELECT upper(trim(code)) k FROM products WHERE code IS NOT NULL GROUP BY 1 HAVING count(*) > 1) d`);
  if (dup.rows[0].n !== 0) throw new Error(`invariant failed: ${dup.rows[0].n} duplicate code(s)`);
  const stray = await c.query(`SELECT count(*)::int n FROM products WHERE code LIKE 'TMP~%'`);
  if (stray.rows[0].n !== 0) throw new Error(`invariant failed: ${stray.rows[0].n} row(s) stranded on a temporary code`);
  const mirror = await c.query(`SELECT count(*)::int n FROM products
    WHERE internal_carton_code IS DISTINCT FROM code OR internal_carton_code IS NULL OR trim(internal_carton_code) = ''`);
  if (mirror.rows[0].n !== 0) throw new Error(`invariant failed: ${mirror.rows[0].n} row(s) where internal_carton_code != code`);
  const dense = await c.query(
    `SELECT count(*)::int have, max(split_part(code,'-',2)::int) highest FROM products WHERE code LIKE $1 || '-%'`, [seriesArg]);
  if (dense.rows[0].have !== dense.rows[0].highest) throw new Error(`invariant failed: ${seriesArg} still has holes`);
  await c.query('COMMIT');
  console.log(`\nAPPLIED: ${plan.length} product(s) renumbered, ${remarks.length} shade-card remark(s) rewritten.`);
  console.log(`${seriesArg} now runs 1..${dense.rows[0].highest} with no holes; every code unique, every mirror equal to its code.`);
} catch (e) {
  await c.query('ROLLBACK');
  console.error('ROLLED BACK:', e.message);
  process.exit(1);
} finally {
  await c.end();
}
