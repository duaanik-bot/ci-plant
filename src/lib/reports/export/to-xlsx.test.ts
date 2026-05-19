import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { reportToXlsx } from './to-xlsx'
import type { ReportResult } from '../types'

const sample: ReportResult = {
  columns: [
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'spend', label: 'Spend', type: 'inr', total: true },
  ],
  rows: [{ name: 'Vendor A', spend: 1000 }, { name: 'Vendor B', spend: 2500 }],
  summary: [{ label: 'Total', value: '₹3,500' }],
  meta: { generatedAt: '2026-05-18T00:00:00.000Z', filtersApplied: { from: '2026-05-01' } },
}

describe('reportToXlsx', () => {
  it('produces a non-empty workbook with a Report sheet and totals row', () => {
    const buf = reportToXlsx('ppv', sample)
    expect(buf.byteLength).toBeGreaterThan(0)
    const wb = XLSX.read(buf, { type: 'buffer' })
    expect(wb.SheetNames).toContain('Report')
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets['Report'])
    expect(csv).toContain('Vendor A')
    expect(csv).toContain('3500') // totals row sums spend
  })
  it('creates one sheet per view when views are present', () => {
    const multi: ReportResult = {
      ...sample,
      views: [{ id: 'matrix', label: 'Matrix' }, { id: 'overall', label: 'Overall' }],
    }
    const wb = XLSX.read(reportToXlsx('wastage', multi), { type: 'buffer' })
    expect(wb.SheetNames).toContain('Report')
  })
})
