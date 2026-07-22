// Box math — split a quantity into whole boxes + a loose remainder given a
// per-box size. Pure + deterministic. Mirrored on the client at
// client/src/lib/boxes.js (keep the two in sync).
//
// per <= 0 (no known box size) → everything is loose (one box holds it all).
export function boxBreakdown(qty, qtyPerBox) {
  const q = Math.max(0, Math.floor(+qty || 0));
  const per = Math.floor(+qtyPerBox || 0);
  if (per <= 0) return { boxes: 0, loose: q, per: 0, total: q };
  return { boxes: Math.floor(q / per), loose: q % per, per, total: q };
}
