// Fluence kit list import — the customer's own kit master ("Master from
// Customer.xlsx": Kits (Master), Kit Lines (Link), Products (Master)) into the
// Fluence prescription & kit master.
//
//   node scripts/import-fluence-kits.mjs --xlsx "<path>/Master from Customer.xlsx"          dry run
//   node scripts/import-fluence-kits.mjs --xlsx "<path>/Master from Customer.xlsx" --apply  write it
//   node scripts/import-fluence-kits.mjs --json scripts/data/<snapshot>.json [--apply]
//   add --snapshot scripts/data/<name>.json to write the parsed list out as JSON
//
// Target: $DATABASE_URL — local by default. A remote database is refused unless
// the run says --production AND the URL is Supabase colour-impressions-prod
// (ylbfeptgefzimcqnwphy); any other remote is refused outright. Production runs
// go through the SESSION pooler (5432), never the transaction pooler.
//
// WHAT IT WRITES (and never overwrites):
//   • inner products — one per item name, with the customer's standard MRP.
//     An item already in the master keeps every value a person entered; only
//     a missing MRP is filled.
//   • kits — one per customer kit (keyed on its party serial), with validity,
//     type and kit total. Re-running refreshes those customer fields only.
//   • components — a kit's items with quantities, written ONLY when the kit has
//     none yet. A list somebody has edited is left exactly as it is.
//   • links — a kit is linked to an ERP product only on an exact name match
//     (fluence-kit-match.js). Weaker matches are stored as SUGGESTIONS that a
//     person confirms in Fluence Master; they never become links here …
//   • … unless a person has ALREADY confirmed them: scripts/data/
//     fluence-kit-links-confirmed-*.json records each confirmed pair (party
//     serial + kit name → product code + product name), so a fresh database —
//     a refreshed review copy, or production — gets the same links. Each pair
//     is re-checked: if the kit list or the product master no longer says what
//     was confirmed, it is reported and NOT linked. A file whose pairs were
//     matched by hand (no suggestion behind them) says "link_method": "manual";
//     its "not_linked" list names kits deliberately left unlinked, and why.
//   • part cartons — scripts/data/fluence-part-cartons-*.json: a kit's other
//     printed cartons (Topico filler, inner box, leaflet, tray, separator). Each
//     reads the kit of its OUTER carton. Re-checked like the links: both names,
//     no kit of its own, the outer not itself a part, the outer still carrying
//     the kit the file names.
//   • prescriptions — from this same customer master, the one source of truth:
//     each kit's Kit Lines, LINE FOR LINE in SR order — a product the master
//     lists twice (two units in the kit) is two lines. The master carries no
//     day-wise schedule, so none is written. Through the app's own validator:
//     a kit with no prescription gets revision 1 "from customer master"; one
//     still exactly as the master gave it (bare lines, last saved from the
//     customer master) that no longer matches the master line for line is
//     re-synced as its next revision. Anything a person has entered is never
//     touched.
//
//   --links <file>   a confirmed-links file (default: every
//                    scripts/data/fluence-kit-links-confirmed-*.json)
//
// WHAT IT NEVER TOUCHES: carton dimensions (not in any file — they stay blank,
// never estimated), and every existing ERP table.
//
// Quantity per kit: each kit line is ONE unit — Σ line MRPs equals the kit
// total on all 297 itemised kits — so an item listed twice is quantity 2.
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import ExcelJS from 'exceljs';
import { fileURLToPath } from 'url';
import { nameKey, normaliseRxPayload, lineHasDose, RX_FROM_CUSTOMER_MASTER } from '../client/src/lib/fluence.js';
import { matchKits, aggregateKitLines, parseDmy } from '../server/src/fluence-kit-match.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = f => args.includes(f);
const opt = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const APPLY = flag('--apply');
const SOURCE = 'customer-master-2026-08-22';
const WHO = 'Fluence kit import';

const PROD_REF = 'ylbfeptgefzimcqnwphy';
let url = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5439/cierp';
const LOCAL = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
if (!LOCAL) {
  if (!flag('--production') || !url.includes(PROD_REF)) {
    console.error(`Refusing: a remote database needs --production, and only Supabase colour-impressions-prod (${PROD_REF}) is allowed.`);
    process.exit(2);
  }
  // Session pooler: one backend for the whole run, reset on release.
  const u = new URL(url);
  if (u.port === '6543') u.port = '5432';
  for (const k of ['pgbouncer', 'connection_limit']) u.searchParams.delete(k);
  url = u.toString();
}

// ── Read the customer file ───────────────────────────────────────────────────
const cellValue = v => {
  if (v == null) return null;
  if (typeof v === 'object') {
    if ('result' in v) return v.result ?? null;
    if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join('');
    if ('text' in v) return v.text;
    if ('formula' in v || 'sharedFormula' in v) return null;
  }
  return v;
};
const str = v => { const x = cellValue(v); return x == null ? null : String(x).trim() || null; };
const numOrNull = v => { const x = cellValue(v); if (x == null || x === '') return null; const n = Number(x); return Number.isFinite(n) ? n : null; };

async function readWorkbook(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const sheet = name => {
    const ws = wb.getWorksheet(name);
    if (!ws) throw new Error(`Sheet "${name}" not found in ${path.basename(file)}`);
    return ws;
  };
  // The header row is row 5 on all three sheets; the tool refuses to guess if
  // the customer moves a column.
  const expectHeader = (ws, cols) => {
    const row = ws.getRow(5).values;
    for (const [idx, label] of Object.entries(cols)) {
      if (str(row[idx]) !== label) throw new Error(`"${ws.name}" column ${idx} should be "${label}", found "${str(row[idx])}"`);
    }
  };

  const products = [];
  const pws = sheet('Products (Master)');
  expectHeader(pws, { 3: 'PRODUCT NAME', 4: 'STANDARD MRP (₹)', 5: 'STATUS' });
  pws.eachRow((row, n) => {
    if (n <= 5) return;
    const name = str(row.values[3]);
    if (name) products.push({ name, standard_mrp: numOrNull(row.values[4]), status: str(row.values[5]) });
  });

  const kits = [];
  const kws = sheet('Kits (Master)');
  expectHeader(kws, { 3: 'KIT NAME', 4: 'STATUS', 5: 'PARTY SL.NO', 6: 'VALID FROM', 7: 'VALID TO', 10: 'TYPE' });
  kws.eachRow((row, n) => {
    if (n <= 5) return;
    const kit_name = str(row.values[3]);
    if (!kit_name) return;
    kits.push({
      kit_name, status: str(row.values[4]), party_sl_no: numOrNull(row.values[5]),
      valid_from: str(row.values[6]), valid_to: str(row.values[7]), kit_type: str(row.values[10]),
    });
  });

  const lines = [];
  const lws = sheet('Kit Lines (Link)');
  expectHeader(lws, { 2: 'KIT NAME', 3: 'SR', 4: 'PRODUCT NAME', 5: 'STANDARD MRP (₹)', 6: 'OVERRIDE MRP (₹)' });
  const stdMrp = new Map(products.map(p => [nameKey(p.name), p.standard_mrp]));
  lws.eachRow((row, n) => {
    if (n <= 5) return;
    const kit_name = str(row.values[2]);
    const product_name = str(row.values[4]);
    if (!kit_name || !product_name) return;
    const override = numOrNull(row.values[6]);
    const standard = numOrNull(row.values[5]) ?? stdMrp.get(nameKey(product_name)) ?? null;
    lines.push({ kit_name, sr: numOrNull(row.values[3]), product_name, mrp: override ?? standard });
  });
  return { source_file: path.basename(file), products, kits, lines };
}

let data;
if (opt('--xlsx')) data = await readWorkbook(opt('--xlsx'));
else {
  const file = opt('--json') || path.join(root, 'scripts/data/fluence-customer-kits-2026-08-22.json');
  data = JSON.parse(fs.readFileSync(file, 'utf8'));
}
if (opt('--snapshot')) {
  fs.writeFileSync(path.resolve(opt('--snapshot')), JSON.stringify(data, null, 1));
  console.log(`snapshot → ${opt('--snapshot')}`);
}

// Links a person has confirmed (see header).
const confirmedFiles = opt('--links')
  ? [path.resolve(opt('--links'))]
  : fs.readdirSync(path.join(root, 'scripts/data'))
      .filter(f => /^fluence-kit-links-confirmed-.*\.json$/.test(f)).sort()
      .map(f => path.join(root, 'scripts/data', f));
const confirmedDocs = confirmedFiles.map(file => {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!doc.confirmed_by || !doc.confirmed_on || !Array.isArray(doc.links)) throw new Error(`${path.basename(file)}: needs confirmed_by, confirmed_on and links`);
  const link_method = doc.link_method ?? 'confirmed_suggestion';
  if (!['confirmed_suggestion', 'manual'].includes(link_method)) throw new Error(`${path.basename(file)}: link_method must be confirmed_suggestion or manual`);
  return { ...doc, link_method, file: path.basename(file) };
});
const confirmedLinks = confirmedDocs.flatMap(doc =>
  doc.links.map(l => ({ ...l, confirmed_by: doc.confirmed_by, confirmed_on: doc.confirmed_on, link_method: doc.link_method, file: doc.file })));
const heldBack = confirmedDocs.flatMap(doc => (doc.not_linked || []).map(h => ({ ...h, file: doc.file })));

// Part cartons a person has confirmed (see header).
const PART_KINDS = new Set(['filler', 'inner box', 'leaflet', 'tray', 'separator']);
const partDocs = fs.readdirSync(path.join(root, 'scripts/data'))
  .filter(f => /^fluence-part-cartons-.*\.json$/.test(f)).sort()
  .map(f => {
    const doc = JSON.parse(fs.readFileSync(path.join(root, 'scripts/data', f), 'utf8'));
    if (!doc.confirmed_by || !doc.confirmed_on || !Array.isArray(doc.parts)) throw new Error(`${f}: needs confirmed_by, confirmed_on and parts`);
    return { ...doc, file: f };
  });

// Every kit must be a party serial the file actually carries, once.
const seenSl = new Set();
for (const k of data.kits) {
  if (!Number.isInteger(k.party_sl_no)) throw new Error(`Kit "${k.kit_name}" has no party serial number`);
  if (seenSl.has(k.party_sl_no)) throw new Error(`Party serial ${k.party_sl_no} appears twice in the kit list`);
  seenSl.add(k.party_sl_no);
}
const linesByKit = new Map();
for (const l of data.lines) {
  if (!linesByKit.has(l.kit_name)) linesByKit.set(l.kit_name, []);
  linesByKit.get(l.kit_name).push(l);
}
const orphanLines = data.lines.filter(l => !data.kits.some(k => k.kit_name === l.kit_name));
if (orphanLines.length) throw new Error(`${orphanLines.length} kit line(s) name a kit that is not in the kit list, e.g. "${orphanLines[0].kit_name}"`);

// ── Write ────────────────────────────────────────────────────────────────────
const client = new pg.Client({ connectionString: url, ssl: LOCAL ? undefined : { rejectUnauthorized: false } });
await client.connect();
const q = async (sql, params = []) => (await client.query(sql, params)).rows;
const report = {
  mode: APPLY ? 'apply' : 'dry-run', source: data.source_file, database: url.replace(/\/\/[^@]*@/, '//'),
  inner_products: { created: 0, mrp_filled: 0, kept: 0 },
  kits: { created: 0, refreshed: 0 },
  components: { kits_written: 0, kits_kept: 0, items_written: 0, repeated_items: [] , mrp_varies: [] },
  links: { linked: [], confirmed: [], confirmed_already: 0, confirmed_refused: [], suggested: [], superseded: [], conflicts: [], held_back: [], still_unlinked: [] },
  parts: { linked: [], already: 0, refused: [], outer_without_kit: [], not_linked: partDocs.flatMap(d => (d.not_linked || []).map(n => `${n.product_code} ${n.product_name}: ${n.why}`)) },
  prescriptions: { filled: 0, resynced: [], kept: 0, kept_edited: [], skipped: [], refused: [] },
};

try {
  await client.query('BEGIN');
  const fc = await q(`SELECT customer_id FROM fluence_customers`);
  if (!fc.length) throw new Error('No Fluence customer is enabled (fluence_customers is empty) — has the migration run?');

  // Inner products.
  const allItemNames = new Map();
  for (const p of data.products) allItemNames.set(nameKey(p.name), { name: p.name, standard_mrp: p.standard_mrp });
  for (const l of data.lines) if (!allItemNames.has(nameKey(l.product_name))) allItemNames.set(nameKey(l.product_name), { name: l.product_name, standard_mrp: null });
  const innerId = new Map();
  for (const [key, item] of allItemNames) {
    const existing = (await q('SELECT id, standard_mrp FROM fluence_inner_products WHERE name_key = $1', [key]))[0];
    if (existing) {
      innerId.set(key, existing.id);
      if (existing.standard_mrp == null && item.standard_mrp != null) {
        await q('UPDATE fluence_inner_products SET standard_mrp = $1, updated_at = now(), updated_by = $2 WHERE id = $3', [item.standard_mrp, WHO, existing.id]);
        report.inner_products.mrp_filled++;
      } else report.inner_products.kept++;
      continue;
    }
    const [row] = await q(`
      INSERT INTO fluence_inner_products (name, name_key, kind, standard_mrp, source, created_by, updated_by)
      VALUES ($1, $2, 'item', $3, $4, $5, $5) RETURNING id`, [item.name, key, item.standard_mrp, SOURCE, WHO]);
    innerId.set(key, row.id);
    report.inner_products.created++;
  }

  // Kits and their components.
  for (const k of data.kits) {
    const ref = `customer-master:party-sl:${k.party_sl_no}`;
    const kitLines = [...(linesByKit.get(k.kit_name) || [])].sort((a, b) => (a.sr ?? 0) - (b.sr ?? 0));
    const total = kitLines.reduce((s, l) => s + (Number(l.mrp) || 0), 0);
    const existing = (await q('SELECT id FROM fluence_kits WHERE source_ref = $1', [ref]))[0];
    let kitId;
    if (existing) {
      await q(`UPDATE fluence_kits SET kit_name = $1, party_sl_no = $2, valid_from = $3, valid_to = $4, kit_type = $5,
                 kit_total_mrp = $6, updated_at = now(), updated_by = $7 WHERE id = $8`,
      [k.kit_name, k.party_sl_no, parseDmy(k.valid_from), parseDmy(k.valid_to), k.kit_type, total || null, WHO, existing.id]);
      kitId = existing.id;
      report.kits.refreshed++;
    } else {
      const [row] = await q(`
        INSERT INTO fluence_kits (kit_name, source_ref, party_sl_no, valid_from, valid_to, kit_type, kit_total_mrp, created_by, updated_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING id`,
      [k.kit_name, ref, k.party_sl_no, parseDmy(k.valid_from), parseDmy(k.valid_to), k.kit_type, total || null, WHO]);
      kitId = row.id;
      report.kits.created++;
    }
    const [{ n }] = await q('SELECT COUNT(*)::int AS n FROM fluence_kit_components WHERE kit_id = $1', [kitId]);
    if (n > 0) { report.components.kits_kept++; continue; }
    const comps = aggregateKitLines(kitLines);
    for (const c of comps) {
      if (c.qty_per_kit > 1) report.components.repeated_items.push(`${k.kit_name}: ${c.name} ×${c.qty_per_kit}`);
      if (c.mrp_varies) report.components.mrp_varies.push(`${k.kit_name}: ${c.name}`);
      await q(`INSERT INTO fluence_kit_components (kit_id, inner_product_id, sr, qty_per_kit, mrp_in_kit, updated_by)
               VALUES ($1,$2,$3,$4,$5,$6)`, [kitId, innerId.get(c.key), c.sr, c.qty_per_kit, c.mrp_in_kit, WHO]);
      report.components.items_written++;
    }
    report.components.kits_written++;
  }

  // Confirmed links first, so a confirmed kit is never offered as a suggestion again.
  const norm = v => String(v ?? '').trim();
  for (const l of confirmedLinks) {
    const label = `${l.kit_name} → ${l.product_code} ${l.product_name}`;
    const kit = (await q(`SELECT id, kit_name, product_id FROM fluence_kits WHERE source_ref = $1`, [`customer-master:party-sl:${l.party_sl_no}`]))[0];
    if (!kit || norm(kit.kit_name) !== norm(l.kit_name)) {
      report.links.confirmed_refused.push(`${label}: the kit list no longer has "${l.kit_name}" at party serial ${l.party_sl_no}${kit ? ` (it says "${kit.kit_name}")` : ''}`);
      continue;
    }
    const product = (await q(`SELECT p.id, p.code, p.name FROM products p JOIN fluence_customers fc ON fc.customer_id = p.customer_id WHERE p.code = $1`, [l.product_code]))[0];
    if (!product || norm(product.name) !== norm(l.product_name)) {
      report.links.confirmed_refused.push(`${label}: the product master no longer has "${l.product_name}" as ${l.product_code}${product ? ` (it says "${product.name}")` : ''}`);
      continue;
    }
    if (kit.product_id === product.id) { report.links.confirmed_already++; continue; }
    if (kit.product_id) {
      report.links.confirmed_refused.push(`${label}: the kit is already linked to another product`);
      continue;
    }
    const holder = (await q(`SELECT kit_name, source_ref FROM fluence_kits WHERE product_id = $1`, [product.id]))[0];
    if (holder) {
      report.links.confirmed_refused.push(`${label}: ${product.code} already carries "${holder.kit_name}" — link it by hand in Fluence Master, which carries any records over`);
      continue;
    }
    const manual = l.link_method === 'manual';
    const by = manual ? `${l.confirmed_by} (linked by hand ${l.confirmed_on})` : `${l.confirmed_by} (confirmed ${l.confirmed_on})`;
    await q(`UPDATE fluence_kits SET product_id = $1, link_method = $5, linked_at = now(), linked_by = $2,
               suggested_product_id = NULL, suggestion_reason = NULL, updated_at = now(), updated_by = $3 WHERE id = $4`,
    [product.id, by, WHO, kit.id, l.link_method]);
    await q(`INSERT INTO fluence_master_revisions (kit_id, area, before, after, note, changed_by, changed_from)
             VALUES ($1, 'kit_link', $2::jsonb, $3::jsonb, $4, $5, 'fluence_master')`,
    [kit.id, JSON.stringify({ product_id: null }), JSON.stringify({ product_id: product.id, product_code: product.code, link_method: l.link_method }),
      `${manual ? `Linked by hand on the instruction of ${l.confirmed_by}, ${l.confirmed_on}` : `Suggested match confirmed by ${l.confirmed_by} on ${l.confirmed_on}`}${l.reason ? ` (${l.reason})` : ''} — ${l.file}`, by]);
    report.links.confirmed.push(label);
  }

  // Links: only kits nobody has linked, against Fluence products no kit holds.
  const openKits = await q(`
    SELECT id, kit_name, source_ref, valid_from FROM fluence_kits
    WHERE source_ref LIKE 'customer-master:%' AND product_id IS NULL AND superseded_by_kit_id IS NULL`);
  const freeProducts = await q(`
    SELECT p.id, p.code, p.name FROM products p
    JOIN fluence_customers fc ON fc.customer_id = p.customer_id
    WHERE NOT EXISTS (SELECT 1 FROM fluence_kits k WHERE k.product_id = p.id)`);
  const itemsOf = kitName => (linesByKit.get(kitName) || []).map(l => l.product_name);
  const result = matchKits(openKits.map(k => ({ ref: k.source_ref, kit_name: k.kit_name, valid_from: k.valid_from, items: itemsOf(k.kit_name) })), freeProducts);
  const kitByRef = new Map(openKits.map(k => [k.source_ref, k]));
  const productById = new Map(freeProducts.map(p => [p.id, p]));

  for (const s of result.superseded) {
    const kit = kitByRef.get(s.ref);
    const by = kitByRef.get(s.by_ref);
    await q('UPDATE fluence_kits SET superseded_by_kit_id = $1, updated_at = now(), updated_by = $2 WHERE id = $3', [by.id, WHO, kit.id]);
    report.links.superseded.push(`${kit.kit_name} (${s.ref}) → re-listed as ${by.kit_name} (${s.by_ref})`);
  }
  for (const l of result.links) {
    const kit = kitByRef.get(l.ref);
    const p = productById.get(l.product_id);
    await q(`UPDATE fluence_kits SET product_id = $1, link_method = 'exact_name', linked_at = now(), linked_by = $2,
               suggested_product_id = NULL, suggestion_reason = NULL, updated_at = now(), updated_by = $2 WHERE id = $3`, [p.id, WHO, kit.id]);
    await q(`INSERT INTO fluence_master_revisions (kit_id, area, before, after, note, changed_by, changed_from)
             VALUES ($1, 'kit_link', $2::jsonb, $3::jsonb, $4, $5, 'fluence_master')`,
    [kit.id, JSON.stringify({ product_id: null }), JSON.stringify({ product_id: p.id, product_code: p.code, link_method: 'exact_name' }),
      'Linked by the customer kit list import — exact name match', WHO]);
    report.links.linked.push(`${kit.kit_name} → ${p.code} ${p.name}`);
  }
  const suggestedRefs = new Set();
  for (const s of result.suggestions) {
    const kit = kitByRef.get(s.ref);
    const p = productById.get(s.product_id);
    await q('UPDATE fluence_kits SET suggested_product_id = $1, suggestion_reason = $2, updated_at = now(), updated_by = $3 WHERE id = $4', [p.id, s.reason, WHO, kit.id]);
    suggestedRefs.add(s.ref);
    report.links.suggested.push(`${kit.kit_name} ? ${p.code} ${p.name} (${s.reason})`);
  }
  for (const c of result.conflicts) report.links.conflicts.push(`${kitByRef.get(c.ref).kit_name}: ${c.reason}`);
  const linkedRefs = new Set(result.links.map(l => l.ref));
  const supersededRefs = new Set(result.superseded.map(s => s.ref));
  const heldBySl = new Map(heldBack.map(h => [`customer-master:party-sl:${h.party_sl_no}`, h]));
  for (const k of openKits) {
    if (linkedRefs.has(k.source_ref) || supersededRefs.has(k.source_ref) || suggestedRefs.has(k.source_ref)) continue;
    const held = heldBySl.get(k.source_ref);
    if (held) report.links.held_back.push(`${k.kit_name}: ${held.why} — ${held.file}`);
    else report.links.still_unlinked.push(k.kit_name);
  }

  // Part cartons, once every link is made: each reads its outer carton's kit.
  const fluenceProductByCode = async code => (await q(`
    SELECT p.id, p.code, p.name FROM products p JOIN fluence_customers fc ON fc.customer_id = p.customer_id WHERE p.code = $1`, [code]))[0];
  const partsByKit = new Map();
  for (const doc of partDocs) {
    for (const pt of doc.parts) {
      const label = `${pt.product_code} ${pt.product_name} → ${pt.part} of ${pt.outer_code}`;
      const refuse = why => report.parts.refused.push(`${label}: ${why}`);
      const product = await fluenceProductByCode(pt.product_code);
      const outer = await fluenceProductByCode(pt.outer_code);
      if (!PART_KINDS.has(pt.part)) { refuse(`"${pt.part}" is not a known part`); continue; }
      if (!product || norm(product.name) !== norm(pt.product_name)) { refuse(`the product master no longer has "${pt.product_name}" as ${pt.product_code}${product ? ` (it says "${product.name}")` : ''}`); continue; }
      if (!outer || norm(outer.name) !== norm(pt.outer_name)) { refuse(`the product master no longer has "${pt.outer_name}" as ${pt.outer_code}${outer ? ` (it says "${outer.name}")` : ''}`); continue; }
      if (product.id === outer.id) { refuse('a carton cannot be a part of itself'); continue; }
      if ((await q('SELECT 1 FROM fluence_kits WHERE product_id = $1', [product.id])).length) { refuse(`${product.code} carries a kit of its own`); continue; }
      if ((await q('SELECT 1 FROM fluence_part_cartons WHERE product_id = $1', [outer.id])).length) { refuse(`${outer.code} is itself a part carton`); continue; }
      const kit = (await q('SELECT id, kit_name, party_sl_no FROM fluence_kits WHERE product_id = $1', [outer.id]))[0];
      if (pt.kit && kit && (kit.party_sl_no !== pt.kit.party_sl_no || norm(kit.kit_name) !== norm(pt.kit.kit_name))) {
        refuse(`${outer.code} now carries "${kit.kit_name}", not "${pt.kit.kit_name}"`); continue;
      }
      const existing = (await q('SELECT outer_product_id FROM fluence_part_cartons WHERE product_id = $1', [product.id]))[0];
      if (existing?.outer_product_id === outer.id) { report.parts.already++; continue; }
      if (existing) { refuse(`${product.code} is already a part of another carton`); continue; }
      await q(`INSERT INTO fluence_part_cartons (product_id, outer_product_id, part, linked_by, source) VALUES ($1, $2, $3, $4, $5)`,
        [product.id, outer.id, pt.part, `${doc.confirmed_by} (confirmed ${doc.confirmed_on})`, doc.file]);
      report.parts.linked.push(label);
      if (!kit) { report.parts.outer_without_kit.push(label); continue; }
      if (!partsByKit.has(kit.id)) partsByKit.set(kit.id, { doc, outer, added: [] });
      partsByKit.get(kit.id).added.push(`${product.code} ${pt.part}`);
    }
  }
  for (const [kitId, g] of partsByKit) {
    const by = `${g.doc.confirmed_by} (confirmed ${g.doc.confirmed_on})`;
    await q(`INSERT INTO fluence_master_revisions (kit_id, area, before, after, note, changed_by, changed_from)
             VALUES ($1, 'kit_link', NULL, $2::jsonb, $3, $4, 'fluence_master')`,
    [kitId, JSON.stringify({ outer_code: g.outer.code, part_cartons_added: g.added }),
      `Part cartons now show this kit's prescription: ${g.added.join(', ')} (outer carton ${g.outer.code}) — confirmed by ${g.doc.confirmed_by} on ${g.doc.confirmed_on} — ${g.doc.file}`, by]);
  }

  // Prescriptions from the customer master — the one source of truth. A kit's
  // prescription is its Kit Lines, LINE FOR LINE in the master's SR order: a
  // product the master lists twice (two units in the kit) is two lines, where it
  // stands. The master carries no day-wise schedule, so none is written.
  //   • no prescription yet → revision 1 "from customer master";
  //   • still exactly as the master gave it — every line bare, no instructions,
  //     last saved from the customer master — but no longer line for line with
  //     the master → re-synced as its next revision, still "from customer master";
  //   • anything a person has entered or edited is never touched (listed instead).
  const RX_BY = 'Anik Dua (MD)';
  const LINE_COLS = 'sr, inner_product_id, item_label, dosage, dose_form, pack_count, frequency, morning_qty, afternoon_qty, evening_qty, night_qty, other_timing, other_qty, instructions, remarks';
  for (const k of data.kits) {
    const label = `${k.kit_name} (party serial ${k.party_sl_no})`;
    const kit = (await q(`SELECT id, kit_name, superseded_by_kit_id FROM fluence_kits WHERE source_ref = $1`, [`customer-master:party-sl:${k.party_sl_no}`]))[0];
    if (!kit) { report.prescriptions.refused.push(`${label}: kit not found`); continue; }
    if (kit.superseded_by_kit_id) { report.prescriptions.skipped.push(`${label}: a re-listing of another kit — that kit carries the prescription`); continue; }
    const products = [...(linesByKit.get(k.kit_name) || [])].sort((a, b) => (a.sr ?? 0) - (b.sr ?? 0)).map(l => l.product_name);
    if (!products.length) { report.prescriptions.skipped.push(`${label}: the master lists no products for this kit`); continue; }
    const items = await q(`
      SELECT ip.id, ip.name, ip.name_key FROM fluence_kit_components kc
      JOIN fluence_inner_products ip ON ip.id = kc.inner_product_id WHERE kc.kit_id = $1`, [kit.id]);
    const byKey = new Map(items.map(i => [i.name_key, i]));
    const missing = [...new Set(products.filter(p => !byKey.has(nameKey(p))))];
    if (missing.length) { report.prescriptions.refused.push(`${label}: not among the kit's items — ${missing.join(', ')}`); continue; }
    // Through the app's own validator, exactly as a save from the drawer.
    const { errors, value } = normaliseRxPayload({ lines: products.map(p => ({ inner_product_id: byKey.get(nameKey(p)).id })) });
    if (errors.length) { report.prescriptions.refused.push(`${label}: ${errors.join(' ')}`); continue; }
    const nameOf = new Map(items.map(i => [i.id, i.name]));
    const snapshot = (revision, lines) => ({ general_instructions: null, remarks: null, revision,
      lines: lines.map(l => ({ sr: l.sr, inner_product_id: l.inner_product_id, item_name: nameOf.get(l.inner_product_id) ?? null })) });
    const writeLines = async rxId => {
      for (const l of value.lines) {
        await q(`INSERT INTO fluence_prescription_lines (prescription_id, sr, inner_product_id) VALUES ($1, $2, $3)`, [rxId, l.sr, l.inner_product_id]);
      }
    };

    const current = (await q('SELECT id, revision, general_instructions, remarks, updated_by, updated_from FROM fluence_prescriptions WHERE kit_id = $1', [kit.id]))[0];
    if (!current) {
      const [rx] = await q(`
        INSERT INTO fluence_prescriptions (kit_id, general_instructions, remarks, revision, updated_at, updated_by, updated_from)
        VALUES ($1, NULL, NULL, 1, now(), $2, $3) RETURNING id`, [kit.id, RX_BY, RX_FROM_CUSTOMER_MASTER]);
      await writeLines(rx.id);
      await q(`INSERT INTO fluence_master_revisions (kit_id, area, revision, before, after, note, changed_by, changed_from)
               VALUES ($1, 'prescription', 1, NULL, $2::jsonb, $3, $4, $5)`,
      [kit.id, JSON.stringify(snapshot(1, value.lines)),
        `Products from ${data.source_file} (Kit Lines, line for line in SR order) — the customer master is the one source of truth and carries no day-wise schedule`,
        RX_BY, RX_FROM_CUSTOMER_MASTER]);
      report.prescriptions.filled++;
      continue;
    }

    const have = await q(`SELECT ${LINE_COLS} FROM fluence_prescription_lines WHERE prescription_id = $1 ORDER BY sr, id`, [current.id]);
    if (have.length === value.lines.length && have.every((l, i) => l.inner_product_id === value.lines[i].inner_product_id
      && !l.item_label && !lineHasDose(l))) { report.prescriptions.kept++; continue; }
    const mastersOwn = current.updated_from === RX_FROM_CUSTOMER_MASTER && !current.general_instructions && !current.remarks
      && have.every(l => l.inner_product_id != null && !l.item_label && !lineHasDose(l)
        && l.pack_count == null && !l.dose_form && !l.remarks);
    if (!mastersOwn) {
      report.prescriptions.kept_edited.push(`${label}: revision ${current.revision} by ${current.updated_by || 'someone'} from ${current.updated_from || 'a screen'} — differs from the master, left as entered`);
      continue;
    }
    const revision = current.revision + 1;
    await q(`UPDATE fluence_prescriptions SET revision = $2, updated_at = now(), updated_by = $3, updated_from = $4 WHERE id = $1`,
      [current.id, revision, RX_BY, RX_FROM_CUSTOMER_MASTER]);
    await q('DELETE FROM fluence_prescription_lines WHERE prescription_id = $1', [current.id]);
    await writeLines(current.id);
    await q(`INSERT INTO fluence_master_revisions (kit_id, area, revision, before, after, note, changed_by, changed_from)
             VALUES ($1, 'prescription', $2, $3::jsonb, $4::jsonb, $5, $6, $7)`,
    [kit.id, revision, JSON.stringify(snapshot(current.revision, have)), JSON.stringify(snapshot(revision, value.lines)),
      `Re-synced line for line with ${data.source_file} (Kit Lines, SR order): ${have.length} → ${value.lines.length} lines — a product the master lists twice is two lines, where the master puts it`,
      RX_BY, RX_FROM_CUSTOMER_MASTER]);
    report.prescriptions.resynced.push(`${label}: ${have.length} → ${value.lines.length} lines (revision ${revision})`);
  }

  await q(`INSERT INTO audit_log (entity, entity_id, action, detail, user_name) VALUES ('fluence_import', NULL, 'customer_kit_list_imported', $1, $2)`,
    [`${data.source_file}: ${report.kits.created} kits created, ${report.kits.refreshed} refreshed, ${report.components.items_written} items, ${report.links.linked.length} linked by exact name, ${report.links.confirmed.length} confirmed links applied, ${report.links.suggested.length} suggested, ${report.parts.linked.length} part cartons linked, ${report.prescriptions.filled} prescriptions filled from the customer master`, WHO]);

  const [{ kits, linked, items, inner, parts, rxs }] = await q(`
    SELECT (SELECT COUNT(*)::int FROM fluence_kits WHERE source_ref LIKE 'customer-master:%') AS kits,
           (SELECT COUNT(*)::int FROM fluence_kits WHERE product_id IS NOT NULL) AS linked,
           (SELECT COUNT(*)::int FROM fluence_kit_components) AS items,
           (SELECT COUNT(*)::int FROM fluence_inner_products) AS inner,
           (SELECT COUNT(*)::int FROM fluence_part_cartons) AS parts,
           (SELECT COUNT(*)::int FROM fluence_prescriptions) AS rxs`);
  report.totals_after = { customer_kits: kits, kits_linked_to_products: linked, kit_items: items, inner_products: inner, part_cartons: parts, prescriptions: rxs };

  await client.query(APPLY ? 'COMMIT' : 'ROLLBACK');
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  await client.end();
  console.error(`\nImport failed — nothing was written.\n${e.message}`);
  process.exit(1);
}
await client.end();

const c = report.links;
console.log(`\nFluence kit list import — ${report.mode.toUpperCase()}${LOCAL ? '' : ' · PRODUCTION'} (${report.source} → ${report.database})`);
console.log(`  inner products: ${report.inner_products.created} created, ${report.inner_products.mrp_filled} MRP filled, ${report.inner_products.kept} kept as they were`);
console.log(`  kits:           ${report.kits.created} created, ${report.kits.refreshed} refreshed`);
console.log(`  components:     ${report.components.items_written} items written into ${report.components.kits_written} kits; ${report.components.kits_kept} kits kept their existing list`);
console.log(`                  ${report.components.repeated_items.length} item(s) appear more than once in a kit (quantity > 1)`);
console.log(`  links:          ${c.linked.length} linked (exact name) · ${c.confirmed.length} linked (confirmed by a person${c.confirmed_already ? `; ${c.confirmed_already} already linked` : ''}) · ${c.suggested.length} suggested · ${c.superseded.length} superseded re-listings · ${c.conflicts.length} conflicts · ${c.held_back.length} held back on purpose · ${c.still_unlinked.length} with no match`);
const pp = report.parts;
console.log(`  part cartons:   ${pp.linked.length} linked${pp.already ? ` · ${pp.already} already linked` : ''} · ${pp.refused.length} refused · ${pp.not_linked.length} left out on purpose${pp.outer_without_kit.length ? ` · ${pp.outer_without_kit.length} whose outer carton has no kit yet` : ''}`);
const rr = report.prescriptions;
console.log(`  prescriptions:  ${rr.filled} filled from the customer master (line for line, SR order) · ${rr.resynced.length} re-synced with it · ${rr.kept} already match it · ${rr.kept_edited.length} entered by a person (kept) · ${rr.skipped.length} skipped · ${rr.refused.length} refused`);
console.log(`  after:          ${JSON.stringify(report.totals_after)}`);
if (c.confirmed.length) console.log(`\n  CONFIRMED LINKS APPLIED:\n    ${c.confirmed.join('\n    ')}`);
if (c.confirmed_refused.length) console.log(`\n  CONFIRMED LINKS REFUSED (the data changed since they were confirmed):\n    ${c.confirmed_refused.join('\n    ')}`);
if (c.suggested.length) console.log(`\n  SUGGESTED (confirm in Fluence Master):\n    ${c.suggested.join('\n    ')}`);
if (c.conflicts.length) console.log(`\n  CONFLICTS (not linked):\n    ${c.conflicts.join('\n    ')}`);
if (c.held_back.length) console.log(`\n  HELD BACK ON PURPOSE (not linked — see the reason):\n    ${c.held_back.join('\n    ')}`);
if (c.still_unlinked.length) console.log(`\n  NO MATCH (link by hand in Fluence Master):\n    ${c.still_unlinked.join('\n    ')}`);
if (pp.linked.length) console.log(`\n  PART CARTONS LINKED:\n    ${pp.linked.join('\n    ')}`);
if (pp.refused.length) console.log(`\n  PART CARTONS REFUSED:\n    ${pp.refused.join('\n    ')}`);
if (pp.outer_without_kit.length) console.log(`\n  PART CARTONS WHOSE OUTER CARTON HAS NO KIT YET (they show nothing until it has one):\n    ${pp.outer_without_kit.join('\n    ')}`);
if (pp.not_linked.length) console.log(`\n  PART CARTONS LEFT OUT ON PURPOSE:\n    ${pp.not_linked.join('\n    ')}`);
if (rr.resynced.length) console.log(`\n  PRESCRIPTIONS RE-SYNCED LINE FOR LINE WITH THE MASTER:\n    ${rr.resynced.join('\n    ')}`);
if (rr.kept_edited.length) console.log(`\n  PRESCRIPTIONS ENTERED BY A PERSON — kept, and they differ from the master:\n    ${rr.kept_edited.join('\n    ')}`);
if (rr.skipped.length) console.log(`\n  PRESCRIPTIONS SKIPPED:\n    ${rr.skipped.join('\n    ')}`);
if (rr.refused.length) console.log(`\n  PRESCRIPTIONS REFUSED:\n    ${rr.refused.join('\n    ')}`);
fs.mkdirSync(path.join(root, 'backups'), { recursive: true });
const out = path.join(root, 'backups', `fluence-kit-import-${report.mode}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(out, JSON.stringify(report, null, 1));
console.log(`\n  report → ${path.relative(root, out)}${APPLY ? '' : '\n  (dry run — rolled back; re-run with --apply to write)'}`);
