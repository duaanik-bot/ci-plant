// PO-line ↔ product-master matching. Pure functions — DB access stays in routes.
// Strategy: learned alias (exact, per customer) → product code in text →
// fuzzy token+bigram Dice score. Thresholds: ≥0.85 matched, ≥0.5 suggested.

const NOISE = /\b(NOS?|PCS?|PIECES?|UNITS?|QTY|CARTONS?|CTNS?|BOX(ES)?|PKTS?|X)\b/g;

// Noise the customer prints INSIDE the description cell of their PO: the
// per-line delivery date, and their own item code leading the line
// ("PCS-E243 EUGI SACHETS ... 05/06/2026"). Six such tokens against a
// five-token name drag a word-for-word match from ~1.0 to ~0.68 — under the
// auto-match bar, sometimes under the suggestion bar. Scrub them before any
// fuzzy work. The date is anywhere; the item code only ever leads, and must
// carry a digit — "F-TRICHONOURISH" leads with a hyphen but names the product.
const DATE_TOKEN = /\b\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}\b/g;
const LEAD_ITEM_CODE = /^[A-Za-z]{1,5}[-/][A-Za-z0-9][A-Za-z0-9\/.-]*$/;

export function scrub(raw) {
  const parts = String(raw || '').replace(DATE_TOKEN, ' ').trim().split(/\s+/);
  if (parts.length > 1 && LEAD_ITEM_CODE.test(parts[0]) && /\d/.test(parts[0])) parts.shift();
  return parts.join(' ');
}

export function normalize(s) {
  return String(s || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const tokens = s => new Set(normalize(s).split(' ').filter(Boolean));

function bigrams(s) {
  const t = normalize(s).replace(/ /g, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

function dice(a, b) {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const x of a) if (b.has(x)) hit++;
  return (2 * hit) / (a.size + b.size);
}

export function score(rawText, product) {
  // Name only. Our internal code ("SW-103") almost never appears on the
  // customer's PO, so gluing it onto the target diluted every real match — a
  // word-for-word name capped at ~0.87. When the code IS in the line, the
  // codeHit path below catches it at 0.95 before fuzzy scoring ever runs.
  const target = product.name;
  return 0.55 * dice(tokens(rawText), tokens(target)) + 0.45 * dice(bigrams(rawText), bigrams(target));
}

export function matchLine(rawText, products, aliases) {
  const norm = normalize(rawText);
  const cleanNorm = normalize(scrub(rawText));
  // Aliases saved since scrubbing landed are keyed on the scrubbed form; rows
  // learned before it carry the full line, date and all. Honour both.
  const alias = aliases.find(a => a.alias_norm === cleanNorm || a.alias_norm === norm);
  if (alias && products.some(p => p.id === alias.product_id)) {
    return { status: 'matched', best: { product_id: alias.product_id, confidence: 1 }, suggestions: [] };
  }
  // Party item code — the customer's own SKU carried on their PO. When a master
  // has one saved and it appears verbatim in the line, that's the surest signal
  // there is (padded so a short code can't hit inside a longer token).
  const padded = ` ${norm} `;
  const picHit = products.find(p => {
    const c = normalize(p.party_item_code);
    return c.length >= 2 && padded.includes(` ${c} `);
  });
  if (picHit) return { status: 'matched', best: { product_id: picHit.id, confidence: 0.98 }, suggestions: [] };

  // Padded substring, not words.includes: a hyphenated code normalizes to two
  // words ("SW-103" -> "SW 103"), which a single-word lookup can never contain.
  const codeHit = products.find(p => {
    const c = normalize(p.code);
    return c && padded.includes(` ${c} `);
  });
  if (codeHit) return { status: 'matched', best: { product_id: codeHit.id, confidence: 0.95 }, suggestions: [] };

  const cleaned = scrub(rawText);
  const ranked = products
    .map(p => ({ product_id: p.id, confidence: Math.round(score(cleaned, p) * 100) / 100 }))
    .sort((a, b) => b.confidence - a.confidence);
  const suggestions = ranked.filter(x => x.confidence >= 0.5).slice(0, 3);
  if (suggestions[0]?.confidence >= 0.85) return { status: 'matched', best: suggestions[0], suggestions };
  if (suggestions.length) return { status: 'suggested', best: null, suggestions };
  return { status: 'none', best: null, suggestions: [] };
}
