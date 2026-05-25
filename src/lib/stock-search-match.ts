export type StockSearchRow = {
  materialCode: string
  boardType: string | null
  gsm: number | null
  sheetLength: number | null
  sheetWidth: number | null
  storageLocation: string | null
  supplierName: string | null
  lot: string | null
}

function normSize(l: number | null, w: number | null): string[] {
  if (!l || !w) return []
  const a = String(Number(l))
  const b = String(Number(w))
  return [`${a}x${b}`, `${b}x${a}`]
}

export function stockRowMatchesTerm(row: StockSearchRow, term: string): boolean {
  const t = term.trim().toLowerCase().replace(/\s+/g, '')
  if (!t) return true
  const sizeForms = normSize(row.sheetLength, row.sheetWidth)
  const haystack = [
    row.materialCode,
    row.boardType,
    row.gsm != null ? String(row.gsm) : '',
    row.storageLocation,
    row.supplierName,
    row.lot,
    ...sizeForms,
  ]
    .filter(Boolean)
    .map((s) => String(s).toLowerCase().replace(/\s+/g, ''))
  return haystack.some((h) => h.includes(t))
}
