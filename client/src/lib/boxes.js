// Box math — split a quantity into whole boxes + a loose remainder given a
// per-box size. Pure. Mirror of server/src/box-math.js (keep the two in sync).
//
// per <= 0 (no known box size) → everything is loose (one box holds it all).
export function boxBreakdown(qty, qtyPerBox) {
  const q = Math.max(0, Math.floor(+qty || 0));
  const per = Math.floor(+qtyPerBox || 0);
  if (per <= 0) return { boxes: 0, loose: q, per: 0, total: q };
  return { boxes: Math.floor(q / per), loose: q % per, per, total: q };
}

// A one-line human label, e.g. "100 boxes × 2,000 + 1,000 loose".
export function boxLabel(qty, qtyPerBox, fmtNum = n => (n ?? 0).toLocaleString('en-IN')) {
  const b = boxBreakdown(qty, qtyPerBox);
  if (b.total <= 0) return '—';
  if (b.per <= 0) return `${fmtNum(b.total)} loose (no box size on record)`;
  const parts = [];
  if (b.boxes > 0) parts.push(`${fmtNum(b.boxes)} box${b.boxes === 1 ? '' : 'es'} × ${fmtNum(b.per)}`);
  if (b.loose > 0) parts.push(`${fmtNum(b.loose)} loose`);
  return parts.join(' + ') || '—';
}
