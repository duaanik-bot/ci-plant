// Where a discrepancy keeps coming from.
//
// The Sort & Paste register is a log, and a log cannot answer the only question
// worth asking of it: is this the plant, or is it the counting? One job counting
// 300 over is a shift. The SAME operator, or the same carton, doing it week after
// week is a habit — and that is the thing a supervisor can actually act on. So
// the screen groups the log, and this is the grouping.
//
// Ranked by how OFTEN a source appears, not by how big the numbers are: a single
// enormous miscount is an incident, while a small bias repeated twenty times is
// the systematic error the register was built to surface. Net pieces break the
// tie, so between two equally frequent sources the costlier one leads.
export function repeatSources(rows, key, limit = 5) {
  if (!Array.isArray(rows) || !rows.length) return [];
  const byName = new Map();
  for (const r of rows) {
    // A discrepancy that names nobody is still real, but it belongs to no one —
    // bucketing it as '' would put a phantom source at the top of the table.
    const name = String(r?.[key] ?? '').trim();
    if (!name) continue;
    const cur = byName.get(name) || { name, count: 0, net: 0, worstPct: null };
    cur.count += 1;
    cur.net += Math.round(+r.delta_qty || 0);
    const pct = r.delta_pct == null ? null : +r.delta_pct;
    // null is "not measured", which must never read as 0% — the worst case has
    // to come from the rows that actually carry a percentage.
    if (pct != null && Number.isFinite(pct) && (cur.worstPct == null || pct > cur.worstPct)) cur.worstPct = pct;
    byName.set(name, cur);
  }
  return [...byName.values()]
    .sort((a, b) => b.count - a.count || b.net - a.net || a.name.localeCompare(b.name))
    .slice(0, limit);
}
