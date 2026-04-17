/**
 * Tokenize a query for broader recall (e.g. "nico star" → ["nico star", "nico", "star"]).
 * Substring `contains` per token approximates light "fuzzy" behavior without pg_trgm.
 */
export function searchTokens(raw: string): string[] {
  const q = raw.trim().toLowerCase()
  if (q.length < 2) return []
  const parts = q
    .split(/[\s\-_./]+/g)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2)
  const out: string[] = []
  const seen = new Set<string>()
  const push = (s: string) => {
    if (!seen.has(s)) {
      seen.add(s)
      out.push(s)
    }
  }
  push(q)
  for (const p of parts) {
    if (p !== q) push(p)
  }
  return out
}
