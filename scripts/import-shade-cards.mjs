// Shade card import — stamps the approved card number + date onto every product
// that has one, and registers each distinct physical card in the Shade Card
// module.
//
//   node scripts/import-shade-cards.mjs            dry run against $DATABASE_URL (default local)
//   node scripts/import-shade-cards.mjs --apply    write it
//   node scripts/import-shade-cards.mjs path/to.json   a different export
//   node scripts/import-shade-cards.mjs --refresh [--apply]
//                                                  re-derive every card's primary
//                                                  product, title and remarks from
//                                                  the products table as it stands
//
// --refresh exists because a card's title and remarks name the products it
// serves, and product codes move: dedupe-products.mjs renumbers the master, so
// after it runs those names point at codes that no longer exist. Refresh reads
// only the database — never the sheet — so it works whatever the codes are now,
// and it is the right tool any time products are added to or removed from a card.
//
// TWO WRITES, ONE SOURCE. products.shade_card_number / shade_card_date is what
// Planning, Artwork, the Job Card and the Masters age column read — that is the
// per-product fact. shade_cards is the module: one row per real card, with the
// approval lifecycle and the dock loop. The sheet carries 906 products but only
// 599 distinct cards, because one physical card routinely serves several
// products (112 of them serve more than one CUSTOMER, so a card cannot be keyed
// per customer either). Both writes come from the same file so they cannot drift.
//
// WHY THE EXPIRED CARDS IMPORT SOFT. Today prod has no cards at all, and
// productionEligibility() treats "no card" as nothing to enforce — so the gate
// is effectively off and the floor prints freely. Registering 599 real cards
// switches it on. 306 of them are past the 365-day life, which under the default
// 'customer' requirement is a HARD block: 462 products could not start printing
// the morning after this import. So an expired card lands with
// approval_requirement='internal', which downgrades the same expiry to an
// ack-able amber alarm (see shade-flow.js productionEligibility: hard is
// requirement === 'customer'). The 293 in-date cards enforce normally. Nothing
// about the expiry is hidden — the age shows everywhere it did before; only the
// consequence is staged. Flip a card to 'customer' as it is re-approved.
//
// This is why the card column is the lever and not products.shade_approval_
// requirement or customers.shade_approval_requirement: both are NULL across the
// whole database, and effectiveRequirement() falls through product → customer →
// card. Setting either of the first two would write a policy nobody asked for
// onto 462 products; the card column touches only the cards that are actually
// expired, and reads correctly in the module.
//
// Idempotent. Products match on code and are set to the sheet's value, cards
// upsert on sc_number. A re-run writes the same values. Reverse it by clearing
// products.shade_card_number / shade_card_date and deleting the CI-numbered
// cards — no other table has been touched.
//
// RUN THIS BEFORE dedupe-products.mjs. The sheet keys on the product codes as
// they stood on 2026-07-28; the renumber wave invalidates them.
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { fileURLToPath } from 'url';
import { SHADE_CARD_LIFE_DAYS } from '../server/src/shade-flow.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_LOCAL = 'postgresql://postgres:postgres@localhost:5439/cierp';
const APPLY = process.argv.includes('--apply');
const REFRESH = process.argv.includes('--refresh');
const url = process.env.DATABASE_URL || DEFAULT_LOCAL;
const file = process.argv.find(a => a.endsWith('.json'))
  || path.join(root, 'scripts/data/shade-cards-2026-07-28.json');
const isRemote = !/@(localhost|127\.0\.0\.1)[:/]/.test(url);

const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
const entries = doc.entries || [];

// A card is only as old as its most recent approval, so where the sheet carries
// different dates for the same card the latest wins. A card with no date at all
// has no age, so isExpiredByAge() cannot call it expired — it enforces normally.
const cards = new Map();
for (const e of entries) {
  const c = cards.get(e.sc_number) || { sc_number: e.sc_number, date: null, products: [] };
  if (e.sc_date && (!c.date || e.sc_date > c.date)) c.date = e.sc_date;
  c.products.push(e.product_code);
  cards.set(e.sc_number, c);
}
for (const c of cards.values()) c.products.sort();

const today = new Date();
const ageOf = d => d ? Math.floor((today - Date.parse(d)) / 86400000) : null;
const expired = c => { const a = ageOf(c.date); return a != null && a >= SHADE_CARD_LIFE_DAYS; };

const client = new pg.Client({ connectionString: url, ssl: isRemote ? { rejectUnauthorized: false } : undefined });
await client.connect();
const q = async (s, p) => (await client.query(s, p)).rows;

console.log(`\nShade card ${REFRESH ? 'refresh' : 'import'}`);
console.log(`Source   ${REFRESH ? 'the products table as it stands' : path.relative(root, file)}`);
console.log(`Target   ${url.replace(/^[^@]*@/, '').replace(/[:/].*$/, '')}${isRemote ? '' : ' (local)'}`);
console.log(`Mode     ${APPLY ? 'APPLY — writing' : 'DRY RUN — nothing is written'}\n`);

// ── Refresh: re-derive each card from the products that carry its number ─────
if (REFRESH) {
  const live = await q(
    `SELECT shade_card_number                   AS sc_number,
            count(*)::int                       AS products,
            min(code)                           AS primary_code,
            string_agg(code, ', ' ORDER BY code) AS codes
       FROM products WHERE shade_card_number IS NOT NULL
      GROUP BY shade_card_number`);

  const cardRows = await q(`SELECT id, sc_number, title, product_id, remarks FROM shade_cards`);
  const have = new Map(cardRows.map(c => [c.sc_number, c]));
  const orphan = live.filter(l => !have.has(l.sc_number));
  const empty = cardRows.filter(c => !live.some(l => l.sc_number === c.sc_number));

  console.log(`Cards in the module        ${cardRows.length}`);
  console.log(`Card numbers on products   ${live.length}`);
  if (orphan.length) console.log(`  on a product but NOT registered: ${orphan.length} (${orphan.slice(0, 4).map(o => o.sc_number).join(', ')})`);
  if (empty.length) console.log(`  registered but on no product:    ${empty.length} (${empty.slice(0, 4).map(o => o.sc_number).join(', ')})`);

  let changed = 0;
  for (const l of live) {
    const card = have.get(l.sc_number);
    if (!card) continue;
    const [p] = await q(`SELECT id, name FROM products WHERE code=$1`, [l.primary_code]);
    const title = l.products > 1 ? `${p.name} (+${l.products - 1} more)` : p.name;
    const remarks = `Serves ${l.products} product(s): ${l.codes}`;
    if (card.title === title && card.product_id === p.id && card.remarks === remarks) continue;
    changed++;
    if (APPLY) {
      await client.query(
        `UPDATE shade_cards SET title=$2, product_id=$3, remarks=$4, updated_at=now() WHERE id=$1`,
        [card.id, title, p.id, remarks]);
    }
  }
  console.log(`\n${APPLY ? `Refreshed ${changed} card(s).` : `${changed} card(s) would be refreshed. Re-run with --apply.`}\n`);
  await client.end();
  process.exit(0);
}

// ── Resolve every product code up front ──────────────────────────────────────
// A code in the sheet that no longer exists is a hard stop, not a skip: it means
// the sheet was exported against a different master (or the renumber already
// ran) and every downstream count would be quietly wrong.
const byCode = new Map((await q(
  `SELECT id, code, name, customer_id, shade_card_number, shade_card_date FROM products`
)).map(p => [p.code, p]));

const missing = entries.filter(e => !byCode.has(e.product_code));
if (missing.length) {
  console.error(`${missing.length} product code(s) in the sheet do not exist here, e.g. ${missing.slice(0, 5).map(m => m.product_code).join(', ')}`);
  console.error(`This sheet keys on the codes as of ${doc.exported_on}. If the renumber has already run, re-export first.\n`);
  await client.end();
  process.exit(1);
}

const exp = [...cards.values()].filter(expired);
const live = [...cards.values()].filter(c => !expired(c));
const blocked = exp.reduce((n, c) => n + c.products.length, 0);

console.log(`Products carrying a card   ${entries.length}`);
console.log(`  with a date              ${entries.filter(e => e.sc_date).length}`);
console.log(`  number only              ${entries.filter(e => !e.sc_date).length}`);
console.log(`Distinct cards             ${cards.size}`);
console.log(`  in date (enforce)        ${live.length}  → approval_requirement = customer`);
console.log(`  expired >${SHADE_CARD_LIFE_DAYS}d (soft)     ${exp.length}  → approval_requirement = internal, covering ${blocked} products`);

const already = entries.filter(e => byCode.get(e.product_code).shade_card_number);
if (already.length) console.log(`\n${already.length} product(s) already carry a number — they will be overwritten with the sheet's value.`);
const existingCards = +(await q(`SELECT count(*)::int n FROM shade_cards`))[0].n;
console.log(`Cards already in the module ${existingCards}`);

if (!APPLY) {
  console.log(`\nFirst 5 cards as they would land:`);
  for (const c of [...cards.values()].slice(0, 5)) {
    const p = byCode.get(c.products[0]);
    console.log(`  ${c.sc_number}  ${c.date || 'no date'}  ${expired(c) ? 'EXPIRED→internal' : 'in date→customer'}  ${c.products.length} product(s)  primary ${p.code} ${p.name.slice(0, 40)}`);
  }
  console.log(`\nNothing written. Re-run with --apply to import.\n`);
  await client.end();
  process.exit(0);
}

// ── Write ────────────────────────────────────────────────────────────────────
// One transaction: a half-imported master where products point at cards that do
// not exist would make the module lie about coverage.
await client.query('BEGIN');
try {
  let products = 0;
  for (const e of entries) {
    await client.query(
      `UPDATE products SET shade_card_number=$2, shade_card_date=$3 WHERE id=$1`,
      [byCode.get(e.product_code).id, e.sc_number, e.sc_date],
    );
    products++;
  }

  let created = 0, updated = 0;
  for (const c of cards.values()) {
    // Primary product = the lowest code sharing the card. Arbitrary but stable,
    // so a re-run picks the same one and the module does not churn.
    const p = byCode.get(c.products[0]);
    const req = expired(c) ? 'internal' : 'customer';
    const title = c.products.length > 1
      ? `${p.name} (+${c.products.length - 1} more)`
      : p.name;
    const before = await q(`SELECT id FROM shade_cards WHERE sc_number=$1`, [c.sc_number]);
    const [row] = await q(
      `INSERT INTO shade_cards (sc_number, title, product_id, customer_id, status,
                                creation_date, approval_requirement, dock_zone, remarks, created_by)
       VALUES ($1,$2,$3,$4,'customer_approved',$5,$6,'triage',$7,'import')
       ON CONFLICT (sc_number) DO UPDATE SET
         title=EXCLUDED.title, product_id=EXCLUDED.product_id, customer_id=EXCLUDED.customer_id,
         creation_date=EXCLUDED.creation_date, approval_requirement=EXCLUDED.approval_requirement,
         remarks=EXCLUDED.remarks, updated_at=now()
       RETURNING id`,
      [c.sc_number, title, p.id, p.customer_id, c.date, req,
       `Imported ${doc.exported_on} from the products master. Serves ${c.products.length} product(s): ${c.products.join(', ')}`],
    );
    before.length ? updated++ : created++;
    await client.query(
      `INSERT INTO shade_card_events (shade_card_id, action, to_status, note, user_name)
       VALUES ($1,'import','customer_approved',$2,'import')`,
      [row.id, `Imported from the products master (${doc.exported_on})${expired(c) ? ` — past the ${SHADE_CARD_LIFE_DAYS}-day life, registered as a soft alarm` : ''}`],
    );
  }

  await client.query('COMMIT');
  console.log(`\nWritten.`);
  console.log(`  products stamped   ${products}`);
  console.log(`  cards created      ${created}`);
  console.log(`  cards updated      ${updated}\n`);
} catch (e) {
  await client.query('ROLLBACK');
  console.error(`\nRolled back — nothing written. ${e.message}\n`);
  await client.end();
  process.exit(1);
}
await client.end();
