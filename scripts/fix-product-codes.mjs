// Product-code cleanup — the data half of the three-codes design
// (docs/superpowers/specs/2026-08-01-product-master-codes-design.md).
//
//   node scripts/fix-product-codes.mjs            dry run (pure SELECT — safe anywhere)
//   node scripts/fix-product-codes.mjs --apply    write, one transaction, backup first
//
// CHANGES (apply mode):
//   1. internal_carton_code := code where NULL, '' or drifted — closes the FG
//      cross-match: helpers.js fgMatchPredicate gates on IS NOT NULL, so the
//      three ''-rows (SGB-325/327/328, three different ZIKDUCE cartons)
//      currently match each other's finished-goods lots.
//   2. party_artwork_code := NULL on the rows holding a DATE — an old import
//      sliced "SALE - 11/25" off the product name into the artwork field. The
//      name still carries it; nothing is lost.
//
// REPORTED, NEVER CHANGED:
//   - within-customer artwork duplicates (CSV) — a data call for Anik;
//   - codes outside every series (PCSG493) — legal now the field is editable;
//   - R0–R5 revision markers (Anik, 2026-08-01: leave them; they go inert for
//     FG matching once every row's internal_carton_code = code).
//
// INVARIANT asserted after apply, transaction refuses to commit without it:
//   every product has internal_carton_code = code, none NULL, none ''.
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_LOCAL = 'postgresql://postgres:postgres@localhost:5439/cierp';
const APPLY = process.argv.includes('--apply');
const url = process.env.DATABASE_URL || DEFAULT_LOCAL;
const c = new pg.Client({ connectionString: url });
await c.connect();
// Writing to prod needs a second, deliberate flag. The point is that no
// muscle-memory `--apply` can ever reach live plant data by accident.
const PROD_OK = process.argv.includes('--prod-i-mean-it');
const where = /supabase|pooler|amazonaws/.test(url) ? 'REMOTE/PROD' : 'local mirror';
console.log(`fix-product-codes — ${APPLY ? 'APPLY' : 'dry run'} against ${where}`);
if (APPLY && where !== 'local mirror' && !PROD_OK) {
  console.error('Refusing to --apply against a remote database without --prod-i-mean-it.');
  process.exit(1);
}
if (APPLY && where !== 'local mirror') console.log('*** WRITING TO PRODUCTION ***');

const mirrorBad = (await c.query(`SELECT id, code, internal_carton_code, name FROM products
  WHERE internal_carton_code IS NULL OR trim(internal_carton_code) = '' OR internal_carton_code <> code ORDER BY id`)).rows;
const dateJunk = (await c.query(`SELECT id, code, name, party_artwork_code FROM products
  WHERE party_artwork_code ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' ORDER BY id`)).rows;
const artworkDups = (await c.query(`SELECT p.customer_id, cu.name AS customer, upper(trim(p.party_artwork_code)) AS artwork_code,
    count(*) AS n, string_agg(p.code, ', ' ORDER BY p.code) AS codes
  FROM products p LEFT JOIN customers cu ON cu.id = p.customer_id
  WHERE p.party_artwork_code IS NOT NULL AND trim(p.party_artwork_code) <> ''
    AND p.party_artwork_code !~* '^R[0-9]+$' AND p.party_artwork_code !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
  GROUP BY 1, 2, 3 HAVING count(*) > 1 ORDER BY n DESC, 1`)).rows;
const offSeries = (await c.query(`SELECT id, code, name FROM products WHERE code !~ '^[A-Z]+-[0-9]+$' ORDER BY id`)).rows;

console.log(`\nmirror fix (internal_carton_code := code): ${mirrorBad.length} rows`);
for (const r of mirrorBad) console.log(`  #${r.id} ${r.code}  icc=${JSON.stringify(r.internal_carton_code)}  ${r.name}`);
console.log(`\nartwork date-junk → NULL: ${dateJunk.length} rows`);
for (const r of dateJunk) console.log(`  #${r.id} ${r.code}  "${r.party_artwork_code}"  ${r.name}`);
console.log(`\nREPORT ONLY — within-customer artwork duplicates: ${artworkDups.length} groups`);
for (const g of artworkDups.slice(0, 30)) console.log(`  ${g.customer}: "${g.artwork_code}" ×${g.n} → ${g.codes}`);
console.log(`REPORT ONLY — codes outside every series: ${offSeries.map(r => `${r.code} (#${r.id})`).join(', ') || 'none'}`);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const csv = ['customer,artwork_code,n,codes',
  ...artworkDups.map(g => `"${g.customer}","${g.artwork_code}",${g.n},"${g.codes}"`)].join('\n');
const csvPath = path.join(root, `artwork-dup-report-${stamp}.csv`);
fs.writeFileSync(csvPath, csv);
console.log(`\nartwork duplicate CSV → ${csvPath}`);

if (!APPLY) {
  console.log('\nDry run — nothing written. Re-run with --apply.');
  await c.end();
  process.exit(0);
}

const backup = { when: new Date().toISOString(), url: 'local mirror', mirrorBad, dateJunk };
const bpath = path.join(root, `PRODUCT-CODES-BACKUP-${stamp}.json`);
fs.writeFileSync(bpath, JSON.stringify(backup, null, 2));
console.log(`backup → ${bpath}`);

try {
  await c.query('BEGIN');
  const m = await c.query(`UPDATE products SET internal_carton_code = code
    WHERE internal_carton_code IS NULL OR trim(internal_carton_code) = '' OR internal_carton_code <> code`);
  const d = await c.query(`UPDATE products SET party_artwork_code = NULL
    WHERE party_artwork_code ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'`);
  const bad = await c.query(`SELECT count(*)::int AS n FROM products
    WHERE internal_carton_code IS DISTINCT FROM code OR internal_carton_code IS NULL OR trim(internal_carton_code) = ''`);
  if (bad.rows[0].n !== 0) throw new Error(`invariant failed: ${bad.rows[0].n} rows where internal_carton_code != code`);
  await c.query('COMMIT');
  console.log(`\nAPPLIED: mirror fixed on ${m.rowCount}, dates cleared on ${d.rowCount}. Invariant holds on every row.`);
} catch (e) {
  await c.query('ROLLBACK');
  console.error('ROLLED BACK:', e.message);
  process.exit(1);
} finally {
  await c.end();
}
