export const SBS_BOARD_TYPES = ['FBB', 'Saffire'] as const
export const DUPLEX_BOARD_TYPES = ['WB', 'GB'] as const
export const CANONICAL_BOARD_TYPES = ['FBB', 'Saffire', 'Duplex WB', 'Duplex GB'] as const

function cleanBoardLabel(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

function compact(value: string): string {
  return cleanBoardLabel(value).toLowerCase().replace(/[^a-z0-9]+/g, '')
}

export function normalizeBoardTypeLabel(value: string | null | undefined): string | null {
  if (value == null) return null
  const raw = cleanBoardLabel(String(value))
  if (!raw) return null
  const key = compact(raw)

  if (key === 'yellow' || key === 'colouryellow' || key === 'coloryellow' || key === 'darbiyellow' || key === 'fbbplain') {
    return 'FBB'
  }
  if (key === 'white' || key === 'colourwhite' || key === 'colorwhite' || key === 'darbiwhite') {
    return 'Saffire'
  }
  if (key === 'fbb' || key === 'fbbfoldingboxboard') return 'FBB'
  if (key === 'saffire' || key === 'sbssolidbleachedsulphate') return 'Saffire'
  if (key === 'wb') return 'WB'
  if (key === 'gb') return 'GB'
  if (key === 'duplexwb' || key === 'whiteback' || key === 'whitebackboard' || key === 'duplexboardwhiteback') return 'Duplex WB'
  if (key === 'duplexgb' || key === 'greyback' || key === 'grayback' || key === 'greybackboard' || key === 'duplexboardgreyback' || key === 'duplexboardgrayback') return 'Duplex GB'
  return raw
}

export function normalizeBoardTypeForStorage(value: string | null | undefined): string | null {
  const normalized = normalizeBoardTypeLabel(value)
  if (!normalized) return null
  if (normalized === 'WB') return 'Duplex WB'
  if (normalized === 'GB') return 'Duplex GB'
  return normalized
}

export function normalizeBoardTypeKey(value: string | null | undefined): string {
  return (normalizeBoardTypeForStorage(value) ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function boardTypeLabelsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const ak = normalizeBoardTypeKey(a)
  const bk = normalizeBoardTypeKey(b)
  return !!ak && !!bk && (ak === bk || ak.includes(bk) || bk.includes(ak))
}

export function normalizeBoardTypeOptions(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const normalized = normalizeBoardTypeForStorage(value)
    if (!normalized) continue
    const key = normalizeBoardTypeKey(normalized)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(normalized)
  }
  return out
}
