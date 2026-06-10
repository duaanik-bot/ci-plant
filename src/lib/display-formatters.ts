const indianIntegerFormatter = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })
const indianNumberFormatter = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 })
const indianMoneyFormatter = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
const indianWholeMoneyFormatter = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })

export function formatIndianNumber(value: unknown): string {
  const n = Number(value)
  return indianNumberFormatter.format(Number.isFinite(n) ? n : 0)
}

export function formatIndianInteger(value: unknown): string {
  const n = Number(value)
  return indianIntegerFormatter.format(Number.isFinite(n) ? Math.round(n) : 0)
}

export function formatInr(value: unknown, opts?: { withSymbol?: boolean; whole?: boolean }): string {
  const n = Number(value)
  const amount = Number.isFinite(n) ? n : 0
  const formatted = opts?.whole ? indianWholeMoneyFormatter.format(amount) : indianMoneyFormatter.format(amount)
  return opts?.withSymbol === false ? formatted : `₹${formatted}`
}

export function formatInrLoose(value: unknown, opts?: { withSymbol?: boolean }): string {
  const n = Number(value)
  const formatted = indianNumberFormatter.format(Number.isFinite(n) ? n : 0)
  return opts?.withSymbol === false ? formatted : `₹${formatted}`
}

export function formatDateIn(dateLike: string | number | Date, opts?: Intl.DateTimeFormatOptions): string {
  const d = new Date(dateLike)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-IN', opts)
}

export function formatDateTimeIn(dateLike: string | number | Date, opts?: Intl.DateTimeFormatOptions): string {
  const d = new Date(dateLike)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-IN', opts)
}

export function statusText(value: string | null | undefined): string {
  return (value || '').replace(/_/g, ' ')
}

export function joinLabelParts(parts: Array<string | number | null | undefined>, separator = ' · '): string {
  return parts
    .map((part) => (part == null ? '' : String(part).trim()))
    .filter(Boolean)
    .join(separator)
}
