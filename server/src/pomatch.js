// PO-line ↔ product-master matching. Pure functions — DB access stays in routes.
// Strategy: learned alias (exact, per customer) → product code in text →
// fuzzy token+bigram Dice score. Thresholds: ≥0.85 matched, ≥0.5 suggested.

const NOISE = /\b(NOS?|PCS?|PIECES?|UNITS?|QTY|CARTONS?|CTNS?|BOX(ES)?|PKTS?|X)\b/g;

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
  const target = `${product.name} ${product.code || ''}`;
  return 0.55 * dice(tokens(rawText), tokens(target)) + 0.45 * dice(bigrams(rawText), bigrams(target));
}

export function matchLine(rawText, products, aliases) {
  const norm = normalize(rawText);
  const alias = aliases.find(a => a.alias_norm === norm);
  if (alias && products.some(p => p.id === alias.product_id)) {
    return { status: 'matched', best: { product_id: alias.product_id, confidence: 1 }, suggestions: [] };
  }
  const words = norm.split(' ');
  // Party item code — the customer's own SKU carried on their PO. When a master
  // has one saved and it appears verbatim in the line, that's the surest signal
  // there is (padded so a short code can't hit inside a longer token).
  const padded = ` ${norm} `;
  const picHit = products.find(p => {
    const c = normalize(p.party_item_code);
    return c.length >= 2 && padded.includes(` ${c} `);
  });
  if (picHit) return { status: 'matched', best: { product_id: picHit.id, confidence: 0.98 }, suggestions: [] };

  const codeHit = products.find(p => p.code && words.includes(normalize(p.code)));
  if (codeHit) return { status: 'matched', best: { product_id: codeHit.id, confidence: 0.95 }, suggestions: [] };

  const ranked = products
    .map(p => ({ product_id: p.id, confidence: Math.round(score(rawText, p) * 100) / 100 }))
    .sort((a, b) => b.confidence - a.confidence);
  const suggestions = ranked.filter(x => x.confidence >= 0.5).slice(0, 3);
  if (suggestions[0]?.confidence >= 0.85) return { status: 'matched', best: suggestions[0], suggestions };
  if (suggestions.length) return { status: 'suggested', best: null, suggestions };
  return { status: 'none', best: null, suggestions: [] };
}
