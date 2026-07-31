// Product code series — pure derivation, no DB. Every customer's codes run one
// dense, 3-digit-padded series (SW-001..767, SGB-001..335, HRB-001..003 on the
// live data), so "the next code in this customer's series" is readable straight
// off the rows: dominant prefix from the customer's own codes, next number from
// every code sharing that prefix (products.code is globally unique, so counting
// globally makes a collision impossible by construction).
//
// This exists for customer migration — the same physical carton moving between
// sister entities (SGBT ↔ SGLS is the everyday case). The product row keeps its
// id (history stays attached); only customer_id and code change.
import { customerInitials } from '../../client/src/lib/customerCode.js';

// The series a customer already runs: most frequent prefix among their codes.
// NEW- is quick-create's placeholder, not a series — never elect it.
export function dominantPrefix(codes) {
  const counts = new Map();
  for (const c of codes || []) {
    const m = /^([A-Za-z]+)-/.exec(String(c || ''));
    if (!m || m[1].toUpperCase() === 'NEW') continue;
    const p = m[1].toUpperCase();
    counts.set(p, (counts.get(p) || 0) + 1);
  }
  let best = null;
  for (const [p, n] of counts) if (!best || n > counts.get(best)) best = p;
  return best;
}

// Highest numeric suffix carried by the given prefix, plus one.
export function nextNumber(codes, prefix) {
  let max = 0;
  const head = `${prefix.toUpperCase()}-`;
  for (const c of codes || []) {
    const s = String(c || '').toUpperCase();
    if (!s.startsWith(head)) continue;
    const n = parseInt(s.slice(head.length).replace(/\D/g, ''), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

export function formatCode(prefix, n) {
  return `${prefix}-${String(n).padStart(3, '0')}`;
}

export function nextCodeFrom({ customerCodes, allCodesInPrefix, customerName }) {
  const prefix = dominantPrefix(customerCodes) || customerInitials(customerName);
  return formatCode(prefix, nextNumber(allCodesInPrefix, prefix));
}
