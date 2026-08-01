// Re-file products that carry ANOTHER customer's code series.
//
//   node scripts/reassign-product-series.mjs            dry run (pure SELECT — safe anywhere)
//   node scripts/reassign-product-series.mjs --apply    write, one transaction, backup first
//
// WHY THIS EXISTS. A product moved between sister entities (SGBT ↔ SGLS is the
// everyday case) must land in the new owner's series. `POST /products/:id/
// migrate-customer` has always done that, but the plain Masters form PUT did
// not — and the audit trail shows three ZIKDUCE cartons moved that way:
//
//     products #488  update  "customer_id: 4 → 5; internal_carton_code: SGB-327 → "
//
// so they sit under Swiss Garnier Life Sciences still wearing Biotech's SGB-.
// (That same edit blanked internal_carton_code, which is what let three
// different cartons cross-match each other's FG stock — see
// fix-product-codes.mjs. The form PUT now regenerates the code and keeps the
// mirror, so this cannot recur; this script cleans up what already happened.)
//
// WHAT IT DOES. Finds every product whose code prefix differs from its
// customer's own dominant series, and issues each the next free code in the
// series it should have been in. Nothing is hardcoded — the series is read off
// the data by the SAME module the app uses (client/src/lib/productCode.js), so
// the script and the running ERP can never disagree about what "next" means.
//
// SAFETY.
//   - A customer whose series is NOT held by a clear majority (>50%) of their
//     own products is skipped, not guessed at. Reassigning against a weak
//     majority could stampede a whole catalogue onto the wrong prefix.
//   - Numbers are taken over EVERY code sharing the target prefix (products.code
//     is globally UNIQUE), and incremented across the run, so a batch cannot
//     collide with itself. The final state is asserted unique before COMMIT.
//   - Renaming is safe because no table stores a product CODE as a key: all
//     references are products.id, and product_aliases (PO text → product) keys
//     on product_id too, so PO matching is unaffected. This was verified by
//     scanning all 345 text/json columns; the only textual carriers are
//     shade_cards.remarks (rewritten here, it is a display string) and
//     audit_log.detail (LEFT ALONE — rewriting history would be a lie).
//   - internal_carton_code is the mirror of code and moves with it.
//
// The paperwork already on the floor still carries the old codes, so an
// old → new CSV is written next to the backup.
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { fileURLToPath } from 'url';
import { dominantPrefix, nextNumber, formatCode } from '../client/src/lib/productCode.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_LOCAL = 'postgresql://postgres:postgres@localhost:5439/cierp';
const APPLY = process.argv.includes('--apply');
const url = process.env.DATABASE_URL || DEFAULT_LOCAL;
const MAJORITY = 0.5;

const c = new pg.Client({ connectionString: url });
await c.connect();
// Writing to prod needs a second, deliberate flag. The point is that no
// muscle-memory `--apply` can ever reach live plant data by accident.
const PROD_OK = process.argv.includes('--prod-i-mean-it');
const where = /supabase|pooler|amazonaws/.test(url) ? 'REMOTE/PROD' : 'local mirror';
console.log(`reassign-product-series — ${APPLY ? 'APPLY' : 'dry run'} against ${where}`);
if (APPLY && where !== 'local mirror' && !PROD_OK) {
  console.error('Refusing to --apply against a remote database without --prod-i-mean-it.');
  process.exit(1);
}
if (APPLY && where !== 'local mirror') console.log('*** WRITING TO PRODUCTION ***');

const rows = (await c.query(`SELECT p.id, p.code, p.internal_carton_code, p.customer_id, p.active,
    p.name, cu.name AS customer
  FROM products p LEFT JOIN customers cu ON cu.id = p.customer_id
  WHERE p.code IS NOT NULL ORDER BY p.id`)).rows;
const allCodes = rows.map(r => r.code);
const prefixOf = code => /^([A-Za-z]+)-/.exec(String(code || ''))?.[1]?.toUpperCase() || null;

// Each customer's own series, plus how firmly they hold it.
const byCust = new Map();
for (const r of rows) {
  if (!byCust.has(r.customer_id)) byCust.set(r.customer_id, []);
  byCust.get(r.customer_id).push(r);
}
const plan = [];
const skipped = [];
// Codes already spoken for: everything live, plus everything this run issues.
const taken = new Set(allCodes.map(x => String(x).toUpperCase()));

for (const [cid, group] of [...byCust].sort((a, b) => a[0] - b[0])) {
  const series = dominantPrefix(group.map(r => r.code));
  if (!series) continue;
  // A row is in its owner's series only if it wears the canonical PREFIX-NUMBER
  // form of that series. Testing the FORM rather than just the prefix catches
  // both failure modes: another customer's prefix (SGB-327 under SGLS), and a
  // code carrying no series at all (PCSG493, which a prefix-only test skips
  // because it has no hyphen to split on).
  const inSeries = r => new RegExp(`^${series}-\\d+$`, 'i').test(String(r.code || ''));
  const held = group.filter(inSeries).length;
  const strays = group.filter(r => !inSeries(r));
  if (!strays.length) continue;
  if (held / group.length <= MAJORITY) {
    skipped.push({ cid, customer: group[0].customer, series, held, of: group.length, strays: strays.length });
    continue;
  }
  for (const r of strays.sort((a, b) => a.id - b.id)) {
    let n = nextNumber([...taken], series);
    let next = formatCode(series, n);
    while (taken.has(next.toUpperCase())) next = formatCode(series, ++n);
    taken.add(next.toUpperCase());
    plan.push({ ...r, from: r.code, to: next, series });
  }
}

console.log(`\n== products wearing another customer's series: ${plan.length} ==`);
for (const p of plan) {
  console.log(`  #${p.id}  ${p.from.padEnd(9)} → ${p.to.padEnd(9)}  ${p.customer}${p.active ? '' : '  [inactive]'}`);
  console.log(`      ${p.name}`);
}
if (skipped.length) {
  console.log(`\n== SKIPPED — series not held by a clear majority, needs a human ==`);
  for (const s of skipped) console.log(`  cust ${s.cid} ${s.customer}: ${s.held}/${s.of} on ${s.series}, ${s.strays} stray`);
}
if (!plan.length) { console.log('\nNothing to re-file.'); await c.end(); process.exit(0); }

// Shade-card remarks name products by code ("Serves 2 product(s): SGB-325, SGB-326").
const remarks = (await c.query(`SELECT id, product_id, remarks FROM shade_cards
  WHERE remarks LIKE ANY($1)`, [plan.map(p => `%${p.from}%`)])).rows;
console.log(`\n== shade_cards.remarks to rewrite: ${remarks.length} ==`);
for (const s of remarks) console.log(`  card #${s.id}: "${s.remarks}"`);
console.log('\naudit_log.detail also mentions these codes — LEFT ALONE, it is the history of the move.');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const csv = ['old_code,new_code,product_id,customer,product_name',
  ...plan.map(p => `${p.from},${p.to},${p.id},"${p.customer}","${String(p.name).replace(/"/g, '""')}"`)].join('\n');
const csvPath = path.join(root, `product-code-reassign-${stamp}.csv`);
fs.writeFileSync(csvPath, csv);
console.log(`\nold → new CSV (for the paperwork on the floor) → ${csvPath}`);

if (!APPLY) { console.log('\nDry run — nothing written. Re-run with --apply.'); await c.end(); process.exit(0); }

const bpath = path.join(root, `PRODUCT-SERIES-BACKUP-${stamp}.json`);
fs.writeFileSync(bpath, JSON.stringify({ when: new Date().toISOString(), plan, remarks }, null, 2));
console.log(`backup → ${bpath}`);

try {
  await c.query('BEGIN');
  for (const p of plan) {
    await c.query('UPDATE products SET code=$1, internal_carton_code=$1 WHERE id=$2', [p.to, p.id]);
    await c.query(
      `INSERT INTO audit_log (entity, entity_id, action, detail, user_name, created_at)
       VALUES ('products', $1, 'update', $2, 'reassign-product-series script', now())`,
      [p.id, `code: ${p.from} → ${p.to}; internal_carton_code: ${p.from} → ${p.to} (re-filed into ${p.customer}'s ${p.series}- series)`]);
  }
  for (const s of remarks) {
    let text = s.remarks;
    for (const p of plan) text = text.split(p.from).join(p.to);
    await c.query('UPDATE shade_cards SET remarks=$1 WHERE id=$2', [text, s.id]);
  }
  // Nothing may share a code, and the mirror must still equal it everywhere.
  const dup = await c.query(`SELECT count(*)::int n FROM (
    SELECT upper(trim(code)) k FROM products WHERE code IS NOT NULL GROUP BY 1 HAVING count(*) > 1) d`);
  if (dup.rows[0].n !== 0) throw new Error(`invariant failed: ${dup.rows[0].n} duplicate code(s)`);
  const mirror = await c.query(`SELECT count(*)::int n FROM products
    WHERE internal_carton_code IS DISTINCT FROM code OR internal_carton_code IS NULL OR trim(internal_carton_code) = ''`);
  if (mirror.rows[0].n !== 0) throw new Error(`invariant failed: ${mirror.rows[0].n} row(s) where internal_carton_code != code`);
  await c.query('COMMIT');
  console.log(`\nAPPLIED: ${plan.length} product(s) re-filed, ${remarks.length} shade-card remark(s) rewritten.`);
  console.log('Invariants hold: every code unique, every mirror equal to its code.');
} catch (e) {
  await c.query('ROLLBACK');
  console.error('ROLLED BACK:', e.message);
  process.exit(1);
} finally {
  await c.end();
}
