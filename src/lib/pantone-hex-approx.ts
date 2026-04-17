/**
 * Approximate hex for Pantone Solid Coated codes (ink preview only — not official Pantone data).
 *
 * Base list: community sRGB hex pairs (e.g. brettapeters/pantones `pantone-coated.json`), merged with
 * local overrides. Keys match `normalizePantoneKey` (e.g. "185C", "REFLEXBLUEC", "WARMGRAY1C").
 */

import pantoneCoated from '@/data/pantone-coated.json'

export function normalizePantoneKey(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/^PANTONE\s*/i, '')
    .replace(/[\s_-]+/g, '')
}

/** Perceived brightness 0–1 */
function hexLuminance(hex: string): number {
  const h = hex.replace('#', '')
  if (h.length !== 6) return 0.5
  const r = parseInt(h.slice(0, 2), 16) / 255
  const g = parseInt(h.slice(2, 4), 16) / 255
  const b = parseInt(h.slice(4, 6), 16) / 255
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Foreground for text on approximate ink swatch */
export function pantoneContrastFg(hex: string | null): string {
  if (!hex) return ''
  return hexLuminance(hex) > 0.55 ? '#0a0a0a' : '#f8fafc'
}

type PantoneRow = { pantone: string; hex: string }

function buildCoatedMap(): Record<string, string> {
  const m: Record<string, string> = {}
  for (const row of pantoneCoated as PantoneRow[]) {
    const key = normalizePantoneKey(row.pantone)
    if (!key) continue
    const hex = row.hex.trim()
    m[key] = hex.startsWith('#') ? hex : `#${hex}`
  }
  return m
}

/** Local tweaks on top of bundled JSON (wins over file). */
const COATED_OVERRIDES: Record<string, string> = {
  // Align with common print UI labels
  BLACKC: '#2D2926',
  PROCESSBLUEC: '#0085CA',
  WARMREDC: '#F9423A',
}

const COATED: Record<string, string> = { ...buildCoatedMap(), ...COATED_OVERRIDES }

export function pantoneHexApprox(raw: string): string | null {
  const k = normalizePantoneKey(raw)
  if (!k) return null
  if (COATED[k]) return COATED[k]
  const m = k.match(/^(\d{1,4})([CUM])?$/)
  if (m) {
    const num = m[1]
    const coatedKey = `${num}C`
    if (COATED[coatedKey]) return COATED[coatedKey]
  }
  return null
}
