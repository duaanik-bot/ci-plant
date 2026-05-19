import type { ColumnType } from './types'

const inrGroup = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })

export function fmtNum(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '—'
  return inrGroup.format(v)
}

export function fmtInr(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '—'
  const neg = v < 0
  return `${neg ? '-' : ''}₹${inrGroup.format(Math.abs(Math.round(v)))}`
}

export function fmtPct(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '—'
  return `${v.toFixed(2)}%`
}

const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
export function fmtDate(v: Date | string | null | undefined): string {
  if (!v) return '—'
  const d = typeof v === 'string' ? new Date(v) : v
  if (Number.isNaN(d.getTime())) return '—'
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${dd}-${MON[d.getUTCMonth()]}-${String(d.getUTCFullYear()).slice(-2)}`
}

export function fmtCell(v: unknown, type: ColumnType): string {
  if (v == null || v === '') return '—'
  switch (type) {
    case 'inr': return fmtInr(Number(v))
    case 'pct': return fmtPct(Number(v))
    case 'num': return fmtNum(Number(v))
    case 'date': return fmtDate(v as Date | string)
    default: return String(v)
  }
}
