/**
 * Normalise a free-form carton dimension string to the canonical Carton master
 * format used in the dashboard: `L×W×H` (3D) or `L×W` (2D leaflet) — no spaces,
 * multiplication sign as separator, no trailing unit (mm is implicit).
 *
 * Strips L/W/H/D axis prefixes, unit suffixes (mm, cm, etc.), normalises any
 * x / X / × / "by" separator, and collapses internal whitespace. Idempotent —
 * passing the canonical form back through is a no-op.
 *
 * Examples:
 *   "L120 x H210 mm"   → "120×210"
 *   "80 x 18 x 79 mm"  → "80×18×79"
 *   "80×18×79"         → "80×18×79"  (no change)
 *   "L300×W200×H80mm"  → "300×200×80"
 */
export function normalizeCartonSizeString(
  input: string | null | undefined,
): string | null {
  if (input == null) return null
  let s = input.trim()
  if (!s) return null
  // Strip axis prefixes BEFORE numbers: "L120" → "120", "H80mm" → "80mm".
  s = s.replace(/\b[LWHDlwhd](?=\d)/g, '')
  // Strip common unit suffixes (with or without a preceding space, e.g. "80mm" or "80 mm").
  s = s.replace(/\s*(?:mm|cm|in|inch|inches)\b/gi, '')
  // Normalise separators (x, X, "by") to the multiplication sign.
  s = s.replace(/\s*(?:×|x|X|\bby\b)\s*/g, '×')
  // Collapse whitespace, drop trailing junk.
  s = s.replace(/\s+/g, '').trim()
  // If nothing usable came through, return null rather than empty string.
  if (!s || !/\d/.test(s)) return null
  return s
}
