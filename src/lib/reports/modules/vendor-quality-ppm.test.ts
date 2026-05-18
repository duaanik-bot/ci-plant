import { describe, it, expect } from 'vitest'
import { computeVendorPpm, type VpInput } from './vendor-quality-ppm'

const input: VpInput[] = [
  { vendor: 'V1', receipts: 4, qtyReceived: 100000, qtyRejected: 500, debitNoteInr: 12000 },
  { vendor: 'V2', receipts: 2, qtyReceived: 50000, qtyRejected: 0, debitNoteInr: 0 },
]

describe('computeVendorPpm', () => {
  const r = computeVendorPpm(input)
  it('computes reject PPM per vendor', () => {
    expect(r.rows.find((x) => x.vendor === 'V1')!.ppm).toBe(5000)
    expect(r.rows.find((x) => x.vendor === 'V2')!.ppm).toBe(0)
  })
  it('summary reports overall PPM and worst vendor', () => {
    expect(r.summary.find((s) => s.label === 'Overall PPM')!.value).toBe('3333');
    expect(r.summary.find((s) => s.label === 'Worst Vendor')!.value).toContain('V1')
    expect(r.summary.find((s) => s.label === 'Total Debit Notes')!.value).toContain('12,000')
  })
})
