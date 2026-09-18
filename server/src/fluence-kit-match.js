// Matching the customer's kit list to the ERP's Fluence products — pure, so the
// rules are unit-tested rather than trusted.
//
// The customer spells a kit "F1-O2"; the ERP carries the carton as "F1O2"
// (FP-013). The two lists were never keyed to each other, so the only honest
// join is the name — and a name join is exactly where a confident wrong link
// hides. Hence two tiers, and only the first one ever writes a link:
//
//   LINK      the kit's nameKey equals exactly ONE Fluence product's nameKey,
//             and no other kit claims that product.
//   SUGGEST   a weaker rule finds exactly one candidate: the same words in a
//             different order ("PSORIASIS IMMU BOOSTER 2" / "PSORIASIS 2 IMMU
//             BOOSTER"), a zero typed for the letter O ("M2-02" / "M2O2"), or
//             the same characters rearranged ("F 1 NEO D3" / "F NEO 1D3").
//             Stored as a suggestion; a person confirms it with one click.
//
// The customer list also re-lists a kit under a new party serial ("POST M -V2"
// in 2022, "POST M - V2" in 2025) with the same items. Those collapse onto the
// newest listing; the older one is marked superseded. If the items DIFFER the
// listings are different kits wearing one name, and none of them is linked.
import { nameKey } from '../../client/src/lib/fluence.js';

// "SKINFACT" and "SKIN FACT" are the same brand word — split the joined
// spellings before comparing words.
const BRAND_SPLITS = [['SKINFACT', 'SKIN FACT'], ['HAIRFACT', 'HAIR FACT'], ['PROFACT', 'PRO FACT'], ['AYURFACT', 'AYUR FACT'], ['ORTHOFACT', 'ORTHO FACT']];

export function wordKey(name) {
  let s = String(name ?? '').toUpperCase();
  for (const [joined, split] of BRAND_SPLITS) s = s.split(joined).join(split);
  return (s.match(/[A-Z0-9+]+/g) || []).sort().join(' ');
}

export function charKey(name) {
  return nameKey(name).split('').sort().join('');
}

// The customer types "02" where the ERP has the letter "O2" (oxygen kits:
// F1-O2, M2-02). Only the kit-suffix position is rewritten.
export function zeroForOKey(name) {
  return nameKey(name).replace(/(^|[A-Z])02$/, '$1O2').replace(/(\d)02$/, '$1O2');
}

const itemsSignature = items => [...items].map(i => nameKey(i)).sort().join('|');

// kits:     [{ ref, kit_name, valid_from (Date|string|null), items: [name, …] }]
// products: [{ id, code, name }]   — Fluence products that are NOT already linked
// Returns { links: [{ref, product_id}], superseded: [{ref, by_ref}],
//           suggestions: [{ref, product_id, reason}], conflicts: [{ref, reason}] }
export function matchKits(kits, products) {
  const byKey = new Map();
  for (const p of products) {
    const k = nameKey(p.name);
    if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(p);
  }

  const links = [];
  const superseded = [];
  const suggestions = [];
  const conflicts = [];

  // Group kits by key: re-listings share a key.
  const groups = new Map();
  for (const kit of kits) {
    const k = nameKey(kit.kit_name);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(kit);
  }

  const unmatched = [];
  const claimed = new Set();
  for (const [key, group] of groups) {
    const candidates = byKey.get(key) || [];
    if (candidates.length === 0) { unmatched.push(...group); continue; }
    if (candidates.length > 1) {
      for (const kit of group) conflicts.push({ ref: kit.ref, reason: `${candidates.length} ERP products share this name: ${candidates.map(p => p.code).join(', ')}` });
      continue;
    }
    let winner = group[0];
    if (group.length > 1) {
      const sigs = new Set(group.map(g => itemsSignature(g.items || [])));
      if (sigs.size > 1) {
        for (const kit of group) conflicts.push({ ref: kit.ref, reason: `listed ${group.length} times under this name with DIFFERENT items` });
        continue;
      }
      const t = v => (v ? new Date(v).getTime() : -Infinity);
      winner = [...group].sort((a, b) => t(b.valid_from) - t(a.valid_from) || String(b.ref).localeCompare(String(a.ref)))[0];
      for (const kit of group) if (kit !== winner) superseded.push({ ref: kit.ref, by_ref: winner.ref });
    }
    links.push({ ref: winner.ref, product_id: candidates[0].id });
    claimed.add(candidates[0].id);
  }

  const free = products.filter(p => !claimed.has(p.id));
  const rules = [
    ['same words, different order', wordKey],
    ['zero typed for the letter O', zeroForOKey],
    ['same characters, different spacing', charKey],
  ];
  for (const kit of unmatched) {
    let found = null;
    for (const [reason, fn] of rules) {
      const want = fn(kit.kit_name);
      if (!want) continue;
      const hits = free.filter(p => fn(p.name) === want);
      if (hits.length === 1) { found = { ref: kit.ref, product_id: hits[0].id, reason }; break; }
      if (hits.length > 1) break;   // ambiguous under this rule — a weaker rule must not win
    }
    if (found) suggestions.push(found);
  }
  return { links, superseded, suggestions, conflicts };
}

// The customer's kit list repeats an item on two lines when the kit holds two of
// it (Σ line MRPs equals the kit total on all 297 itemised kits, so each line is
// ONE unit). Collapse repeats into one component with a quantity.
export function aggregateKitLines(lines) {
  const out = [];
  const byKey = new Map();
  for (const l of lines) {
    const key = nameKey(l.product_name);
    if (!key) continue;
    const mrp = l.mrp == null || l.mrp === '' ? null : Number(l.mrp);
    if (byKey.has(key)) {
      const c = byKey.get(key);
      c.qty_per_kit += 1;
      if (mrp != null && c.mrp_in_kit != null && mrp !== c.mrp_in_kit) c.mrp_varies = true;
      continue;
    }
    const c = { name: String(l.product_name).trim(), key, sr: out.length + 1, qty_per_kit: 1, mrp_in_kit: Number.isFinite(mrp) ? mrp : null, mrp_varies: false };
    byKey.set(key, c);
    out.push(c);
  }
  return out;
}

// "16/04/3035" → "3035-04-16"; anything else → null (never a guessed date).
export function parseDmy(s) {
  const m = String(s ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return null;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}
