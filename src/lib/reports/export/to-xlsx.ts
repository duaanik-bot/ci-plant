import * as XLSX from 'xlsx'
import type { ReportResult } from '../types'

export function reportToXlsx(reportId: string, result: ReportResult): Buffer {
  const wb = XLSX.utils.book_new()

  const header = result.columns.map((c) => c.label)
  const body = result.rows.map((r) => result.columns.map((c) => r[c.key] ?? ''))

  const totalsRow = result.columns.map((c) => {
    if (!c.total) return ''
    return result.rows.reduce((s, r) => s + (Number(r[c.key]) || 0), 0)
  })
  const hasTotals = result.columns.some((c) => c.total)

  const meta = [
    [`Report: ${reportId}`],
    [`Generated: ${result.meta.generatedAt}`],
    [`Filters: ${Object.entries(result.meta.filtersApplied).map(([k, v]) => `${k}=${v}`).join('  ')}`],
    [],
  ]
  const aoa = [...meta, header, ...body, ...(hasTotals ? [totalsRow] : [])]
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  XLSX.utils.book_append_sheet(wb, ws, 'Report')

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}
