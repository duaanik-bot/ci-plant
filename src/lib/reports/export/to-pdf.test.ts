import { describe, it, expect } from 'vitest'
import { reportToPdf } from './to-pdf'
import type { ReportResult } from '../types'

const sample: ReportResult = {
  columns: [
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'spend', label: 'Spend', type: 'inr', total: true },
  ],
  rows: [{ name: 'Vendor A', spend: 1000 }],
  summary: [{ label: 'Total Spend', value: '₹1,000', tone: 'neutral' }],
  meta: { generatedAt: '2026-05-18T00:00:00.000Z', filtersApplied: { from: '2026-05-01' } },
}

describe('reportToPdf', () => {
  it('produces a non-empty PDF buffer', async () => {
    const buf = await reportToPdf('Purchase Price Variance', sample)
    expect(buf.byteLength).toBeGreaterThan(1000)
    expect(buf.subarray(0, 4).toString()).toBe('%PDF')
  })
})
