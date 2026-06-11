export type Dims3 = { l: number | null; w: number | null; h: number | null }
export type Dims2 = { l: number | null; w: number | null }

function num(s: string): number | null {
  const n = Number(s.trim())
  return Number.isFinite(n) ? n : null
}

export function parseDims(raw: string | null | undefined): Dims3 {
  if (!raw || !String(raw).trim()) return { l: null, w: null, h: null }
  const parts = String(raw)
    .trim()
    .split(/\s*[xX]\s*/)
    .filter((p) => p.length > 0)
  return {
    l: parts[0] != null ? num(parts[0]) : null,
    w: parts[1] != null ? num(parts[1]) : null,
    h: parts[2] != null ? num(parts[2]) : null,
  }
}

export function parseSheetSize(raw: string | null | undefined): Dims2 {
  const d = parseDims(raw)
  return { l: d.l, w: d.w }
}

export function parseColours(raw: string | null | undefined): number | null {
  if (raw == null) return null
  const v = String(raw).trim().toUpperCase()
  if (!v) return null
  if (v === 'CMYK') return 4
  if (v === 'CMYKP') return 5
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 ? n : null
}

const PASTING_MAP: Record<string, 'LOCK_BOTTOM' | 'BSO' | 'SPECIAL'> = {
  'LOCK BOTTOM': 'LOCK_BOTTOM',
  LOCKBOTTOM: 'LOCK_BOTTOM',
  LOCK_BOTTOM: 'LOCK_BOTTOM',
  BSO: 'BSO',
  SPECIAL: 'SPECIAL',
}

export function mapPastingStyle(
  raw: string | null | undefined,
): 'LOCK_BOTTOM' | 'BSO' | 'SPECIAL' | null {
  if (raw == null) return null
  const v = String(raw).trim().toUpperCase()
  return PASTING_MAP[v] ?? null
}

export type BoardMapping = {
  boardGrade: string | null
  paperType: string | null
}

/**
 * Excel "Board Type" encodes legacy family terms + actual board grade. The Colour/Darbi
 * prefix is the firm (kept in Category, not used here). Order matters:
 * FBB COATED (distinct new master) and FBB PLAIN are checked before the
 * generic shade keywords.
 */
export function mapBoardType(raw: string | null | undefined): BoardMapping {
  if (raw == null) return { boardGrade: null, paperType: null }
  const original = String(raw).trim()
  if (!original) return { boardGrade: null, paperType: null }
  const v = original.toUpperCase().replace(/\s+/g, ' ')

  if (v.includes('FBB COATED')) return { boardGrade: 'FBB coated', paperType: null }
  if (v.includes('FBB PLAIN')) return { boardGrade: 'FBB', paperType: 'FBB' }
  if (v.includes('WHITE')) return { boardGrade: 'Saffire', paperType: 'Saffire' }
  if (v.includes('YELLOW')) return { boardGrade: 'FBB', paperType: 'FBB' }
  if (v.includes('WB')) return { boardGrade: 'Duplex', paperType: 'WB' }
  if (v.includes('GB')) return { boardGrade: 'Duplex', paperType: 'GB' }

  return { boardGrade: original, paperType: null }
}

export function parseRate(raw: string | null | undefined): number | null {
  if (raw == null) return null
  const cleaned = String(raw).replace(/[^0-9.]/g, '')
  if (!cleaned) return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

export function parseGsm(raw: string | null | undefined): number | null {
  if (raw == null) return null
  const n = parseInt(String(raw).trim(), 10)
  return Number.isInteger(n) ? n : null
}
