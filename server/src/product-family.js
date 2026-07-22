// Detects "same brand, different strength" product pairs — e.g. NICOSTAR 5 vs
// NICOSTAR 10 — so Print Planning and Invoicing can raise a SOFT mix-up alarm
// (never a hard block). Pure and DB-free: the family key is derived straight
// from the product name, no schema changes and no data entry.
//
// A token that starts with a digit is a strength/pack token (25, 500MG, 10X10,
// 30'S, 1). The FIRST such token is the strength; everything before it is the
// brand base. Keying on the first number and requiring it to DIFFER means real
// strength changes fire (5 vs 10) while mere revisions / pack duplicates of the
// same strength stay quiet.

const isNumberToken = (t) => /^\d/.test(t);

// name → { base, strength }. base is uppercased & space-collapsed; strength is
// the first number-token stripped to A–Z0–9, or null when the name carries no
// number (no strength → never clashes).
export function familyKey(name) {
  const tokens = String(name || '')
    .toUpperCase()
    .split(/[\s\-/(),]+/)
    .filter(Boolean);
  const base = [];
  let strength = null;
  for (const t of tokens) {
    // Keep the decimal point — 2.5 mg and 25 mg are very different strengths.
    if (isNumberToken(t)) { strength = t.replace(/[^A-Z0-9.]/g, '').replace(/\.+$/, ''); break; }
    base.push(t);
  }
  return { base: base.join(' '), strength: strength || null };
}

// Two products clash when: same customer, same non-trivial base (≥3 chars),
// both have a strength, and the strengths differ. A name that starts with a
// number (empty/too-short base — e.g. "1 KG MITHAI BOX") is non-classifiable
// and never clashes.
export function clashes(a, b) {
  if (!a || !b) return false;
  if (a.customer_id == null || b.customer_id == null) return false;
  if (a.customer_id !== b.customer_id) return false;
  const fa = familyKey(a.name);
  const fb = familyKey(b.name);
  if (!fa.base || fa.base.length < 3) return false;
  if (fa.base !== fb.base) return false;
  if (!fa.strength || !fb.strength) return false;
  return fa.strength !== fb.strength;
}

// target vs a pool → the pool members that clash with target (a different
// product id, same-brand different-strength). Callers shape the rows for display.
export function findClashes(target, pool) {
  return (pool || []).filter(
    (p) => p && p.product_id !== target.product_id && clashes(target, p),
  );
}
