type SizeSource = {
  sheetSize?: unknown
  actualSheetSize?: unknown
  spec?: Record<string, unknown> | null
  specOverrides?: Record<string, unknown> | null
  product?: Record<string, unknown> | null
  carton?: Record<string, unknown> | null
  materialQueue?: Record<string, unknown> | null
}

function asNonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  return v ? v : null
}

function num(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

export function resolveSheetSize(line: SizeSource): string {
  const spec = (line.specOverrides || line.spec || {}) as Record<string, unknown>
  const planningCore = (spec.planningCore || {}) as Record<string, unknown>
  const nestedSpec = (spec.spec || {}) as Record<string, unknown>
  const product = (line.product || line.carton || {}) as Record<string, unknown>
  const directCandidates: unknown[] = [
    line.sheetSize,
    line.actualSheetSize,
    spec.actualSheetSize,
    spec.sheetSize,
    spec.sheet_size,
    nestedSpec.actualSheetSize,
    nestedSpec.sheetSize,
    planningCore.actualSheetSizeLabel,
    planningCore.sheetSize,
    planningCore.finalSheetSize,
    product.sheetSize,
    product.actualSheetSize,
    line.carton && (line.carton as Record<string, unknown>).sheetSize,
  ]
  for (const c of directCandidates) {
    const v = asNonEmpty(c)
    if (v) return v
  }

  const len = num(
    spec.sheetLengthMm ??
      spec.sheetLength ??
      nestedSpec.sheetLengthMm ??
      nestedSpec.sheetLength ??
      (line.materialQueue as Record<string, unknown> | null)?.sheetLengthMm ??
      product.blankLength,
  )
  const wid = num(
    spec.sheetWidthMm ??
      spec.sheetWidth ??
      nestedSpec.sheetWidthMm ??
      nestedSpec.sheetWidth ??
      (line.materialQueue as Record<string, unknown> | null)?.sheetWidthMm ??
      product.blankWidth,
  )
  if (len && wid) return `${len}x${wid}`
  return '-'
}

export function parseSheetSizeToPair(sheetSize: string): { length: number; width: number } | null {
  const raw = sheetSize.trim()
  if (!raw || raw === '-') return null
  const parts = raw
    .toLowerCase()
    .replace(/[×*]/g, 'x')
    .split('x')
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length < 2) return null
  const a = Number(parts[0])
  const b = Number(parts[1])
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null
  return { length: a, width: b }
}
