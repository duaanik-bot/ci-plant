// Product master dedup + company-wise renumber.
//
//   node scripts/dedupe-products.mjs            dry run against $DATABASE_URL (default local)
//   node scripts/dedupe-products.mjs --apply    write it
//
// Two passes over the products master, in this order and one transaction:
//
//   1. DEDUP — delete rows that are 100% the same product as another row.
//   2. RENUMBER — reissue every code so each COMPANY owns one prefix and its
//      numbers run 1..N with no holes.
//
// WHY internal_carton_code IS NOT PART OF THE MATCH. It equals code on all 1610
// rows — the import seeded it from the product's own code. Leave it in the
// comparison and every row is unique by construction, which is exactly why a
// naive "find identical rows" check reports zero duplicates on a master that
// visibly contains pairs. The same goes for id, code and the shade card columns:
// all are per-ROW facts, not per-PRODUCT facts.
//
// WHAT COUNTS AS THE SAME PRODUCT. Customer + name + board + gsm + size + ups +
// coating + rate + child/parent dimensions + colours. Name is squashed to
// alphanumerics before comparing, because the duplicates in this master are
// data-entry twins — ": F-CAL D3 ... 1X8\s'" against "F-CAL D3 ... 1X8's" is one
// product typed twice. Everything else is compared EXACTLY. That matters: of the
// 75 pairs sharing a squashed name, only 16 are the same product. SW-001 and
// SW-103 have the same name but Saffire against FBB board, and SW-001 and SW-104
// differ on rate — a rate is a commercial fact, and merging two of them silently
// picks a price for the plant. Those stay as separate rows.
//
// SURVIVOR is the lowest existing code in the group, which is stable across
// re-runs. Before a victim is deleted, any field the survivor has left blank is
// filled from it, so merging never loses a party code, a die number or a shade
// card the survivor happened not to carry. Then every foreign key pointing at
// the victim is repointed at the survivor. Referencing tables are discovered
// from information_schema at run time rather than listed here, so a table added
// later cannot be silently skipped.
//
// RENUMBER. SW- currently covers two different companies — Swiss Garniers
// Biotech holds SW-001..347 and Swiss Garnier Life Sciences SW-348..1118 — so
// the prefix tells you nothing about whose product it is. Biotech moves to SGB-,
// keeping its numbers (SW-001 → SGB-001). Life Sciences keeps SW- and closes up
// from 348 to 1. Every other company keeps its prefix and closes its dedup gaps.
// Order within a company is the current numeric order, so nothing is reshuffled
// beyond what closing the holes requires.
//
// Renaming is safe because no table stores a product CODE — all 12 referencing
// tables key on products.id, and every report joins the code live. product_aliases
// (PO text → product) keys on product_id too, so PO matching is unaffected. The
// rename runs in two phases through a temporary code, because 'code' is UNIQUE
// and SGLS's target numbers overlap the numbers Biotech is vacating.
//
// The paperwork already on the floor still carries the old codes, so an
// old → new CSV is written next to the backup.
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_LOCAL = 'postgresql://postgres:postgres@localhost:5439/cierp';
const APPLY = process.argv.includes('--apply');
const url = process.env.DATABASE_URL || DEFAULT_LOCAL;
const isRemote = !/@(localhost|127\.0\.0\.1)[:/]/.test(url);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

// One prefix per company. Derived from the codes already in use, except Biotech,
// which is the whole point of the split.
const PREFIX_OVERRIDE = { 'Swiss Garniers Biotech Private Limited': 'SGB' };

// Compared exactly. Anything not here is either a per-row fact (id, code,
// internal_carton_code, shade card) or free text that does not define identity.
const IDENTITY = ['customer_id', 'board_material_id', 'gsm', 'size', 'ups',
  'coating', 'rate', 'child_l', 'child_w', 'parent_l', 'parent_w', 'colors'];

// Filled on the survivor from the victim when the survivor left it blank.
const CARRY_OVER = ['shade_card_number', 'shade_card_date', 'party_item_code',
  'party_artwork_code', 'output_number', 'die_number', 'block_number',
  'board_name', 'board_grade', 'product_type', 'hsn_code', 'gst_pct'];

const squash = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const numOf = code => { const m = String(code).match(/(\d+)/); return m ? +m[1] : 0; };
const blank = v => v == null || v === '';

const client = new pg.Client({ connectionString: url, ssl: isRemote ? { rejectUnauthorized: false } : undefined });
await client.connect();
const q = async (s, p) => (await client.query(s, p)).rows;

console.log(`\nProduct dedup + renumber`);
console.log(`Target   ${url.replace(/^[^@]*@/, '').replace(/[:/].*$/, '')}${isRemote ? '' : ' (local)'}`);
console.log(`Mode     ${APPLY ? 'APPLY — writing' : 'DRY RUN — nothing is written'}\n`);

const products = await q(`SELECT p.*, c.name AS customer_name FROM products p
                          JOIN customers c ON c.id = p.customer_id
                          ORDER BY p.customer_id, p.code`);
const refs = await q(
  `SELECT tc.table_name AS t, kcu.column_name AS c
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
     JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND ccu.table_name = 'products' AND ccu.column_name = 'id'
    ORDER BY 1`);
console.log(`${products.length} products, ${refs.length} referencing tables\n`);

// ── Pass 1: find the duplicate groups ────────────────────────────────────────
const groups = new Map();
for (const p of products) {
  const key = [squash(p.name), ...IDENTITY.map(f => `${p[f] ?? ''}`)].join('|');
  (groups.get(key) || groups.set(key, []).get(key)).push(p);
}
const dupes = [...groups.values()].filter(g => g.length > 1)
  .map(g => [...g].sort((a, b) => numOf(a.code) - numOf(b.code)));
const victims = dupes.flatMap(g => g.slice(1));

console.log(`── Dedup ──`);
console.log(`Duplicate groups   ${dupes.length}`);
console.log(`Rows to delete     ${victims.length}\n`);
for (const g of dupes) {
  const [keep, ...drop] = g;
  console.log(`  keep ${keep.code.padEnd(9)} ${keep.name.slice(0, 46)}`);
  for (const d of drop) console.log(`  drop ${d.code.padEnd(9)} ${d.name.slice(0, 46)}`);
}

// What actually points at the rows we are about to delete.
const victimIds = victims.map(v => v.id);
const attachments = [];
if (victimIds.length) {
  for (const { t, c } of refs) {
    const [{ n }] = await q(`SELECT count(*)::int n FROM ${t} WHERE ${c} = ANY($1::int[])`, [victimIds]);
    if (n > 0) attachments.push({ t, c, n });
  }
}
console.log(attachments.length
  ? `\nRows attached to a victim (repointed to the survivor): ${attachments.map(a => `${a.t}=${a.n}`).join(', ')}`
  : `\nNothing is attached to any victim — no repointing needed.`);

// ── Pass 2: work out the new codes ───────────────────────────────────────────
const survivors = products.filter(p => !victimIds.includes(p.id));
const byCustomer = new Map();
for (const p of survivors) (byCustomer.get(p.customer_name) || byCustomer.set(p.customer_name, []).get(p.customer_name)).push(p);

const renames = [];
console.log(`\n── Renumber ──`);
for (const [customer, list] of [...byCustomer].sort((a, b) => b[1].length - a[1].length)) {
  list.sort((a, b) => numOf(a.code) - numOf(b.code));
  const current = list[0].code.split('-')[0];
  const prefix = PREFIX_OVERRIDE[customer] || current;
  const width = Math.max(3, String(list.length).length);
  let changed = 0;
  for (const [i, p] of list.entries()) {
    const code = `${prefix}-${String(i + 1).padStart(width, '0')}`;
    if (code !== p.code) { renames.push({ id: p.id, from: p.code, to: code, customer }); changed++; }
  }
  console.log(`  ${customer.padEnd(42)} ${current}- → ${prefix}-   ${list.length} products, ${changed} recoded  (${list[0].code} → ${prefix}-${'1'.padStart(width, '0')} … ${prefix}-${String(list.length).padStart(width, '0')})`);
}
console.log(`\nTotal codes changing  ${renames.length} of ${survivors.length}`);

if (!APPLY) {
  console.log(`\nNothing written. Re-run with --apply.\n`);
  await client.end();
  process.exit(0);
}

// ── Write ────────────────────────────────────────────────────────────────────
fs.mkdirSync(path.join(root, 'backups'), { recursive: true });
const backup = path.join(root, `backups/PRODUCT-DEDUPE-BACKUP-${stamp}.json`);
fs.writeFileSync(backup, JSON.stringify({
  ran_at: new Date().toISOString(), target: url.replace(/:[^:@]*@/, ':***@'),
  deleted: victims, groups: dupes.map(g => ({ keep: g[0].code, drop: g.slice(1).map(d => d.code) })),
  renames,
}, null, 2) + '\n');
console.log(`\nBackup of every deleted row → ${path.relative(root, backup)}`);

await client.query('BEGIN');
try {
  // Dedup. Carry-over first, then repoint, then delete — in that order, so a
  // failure anywhere leaves the victim still holding its own data.
  for (const g of dupes) {
    const [keep, ...drop] = g;
    for (const v of drop) {
      const fill = CARRY_OVER.filter(f => blank(keep[f]) && !blank(v[f]));
      if (fill.length) {
        await client.query(
          `UPDATE products SET ${fill.map((f, i) => `${f}=$${i + 2}`).join(', ')} WHERE id=$1`,
          [keep.id, ...fill.map(f => v[f])]);
        // Keep the in-memory survivor in step, so a third row in the same group
        // does not re-fill a field the second one just supplied.
        for (const f of fill) keep[f] = v[f];
      }
      for (const { t, c } of refs) {
        await client.query(`UPDATE ${t} SET ${c}=$1 WHERE ${c}=$2`, [keep.id, v.id]);
      }
      await client.query(`DELETE FROM products WHERE id=$1`, [v.id]);
    }
  }

  // Renumber, two phases: code is UNIQUE and the target numbers overlap the ones
  // being vacated, so every row parks on a temporary code first.
  for (const r of renames) {
    await client.query(`UPDATE products SET code=$2 WHERE id=$1`, [r.id, `TMP~${r.id}`]);
  }
  for (const r of renames) {
    await client.query(
      `UPDATE products SET code=$2,
              internal_carton_code = CASE WHEN internal_carton_code=$3 THEN $2 ELSE internal_carton_code END
        WHERE id=$1`, [r.id, r.to, r.from]);
  }

  const [{ n: left }] = await q(`SELECT count(*)::int n FROM products WHERE code LIKE 'TMP~%'`);
  if (left) throw new Error(`${left} product(s) still on a temporary code`);

  await client.query('COMMIT');

  const csv = path.join(root, `backups/PRODUCT-CODE-MAP-${stamp}.csv`);
  fs.writeFileSync(csv, 'customer,old_code,new_code\n' +
    renames.map(r => `"${r.customer}",${r.from},${r.to}`).join('\n') + '\n');
  console.log(`Old → new code map    → ${path.relative(root, csv)}`);
  console.log(`\nWritten.`);
  console.log(`  rows deleted        ${victims.length}`);
  console.log(`  codes reissued      ${renames.length}\n`);
} catch (e) {
  await client.query('ROLLBACK');
  console.error(`\nRolled back — nothing written. ${e.message}\n`);
  await client.end();
  process.exit(1);
}
await client.end();
