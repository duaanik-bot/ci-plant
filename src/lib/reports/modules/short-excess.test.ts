import { describe, it, expect } from 'vitest'
import { computeShortExcess, type SeInput } from './short-excess'

const input: SeInput[] = [
  { po: 'PO1', customer: 'Acme', carton: 'C1', poQty: 1000, deliveredQty: 1050,
    tolerancePct: 2, unitRate: 10 },
  { po: 'PO2', customer: 'Beta', carton: 'C2', poQty: 1000, deliveredQty: 980,
    tolerancePct: 2, unitRate: 10 },
]

describe('computeShortExcess', () => {
  const r = computeShortExcess(input)
  it('computes variance and tolerance flag', () => {
    const a = r.rows.find((x) => x.po === 'PO1')!
    expect(a.excessQty).toBe(50)
    expect(a.withinTolerance).toBe('No')
    const b = r.rows.find((x) => x.po === 'PO2')!
    expect(b.shortQty).toBe(20)
    expect(b.withinTolerance).toBe('Yes')
  })
  it('summarises totals and S&E value', () => {
    expect(r.summary.find((s) => s.label === 'Total Excess')!.value).toBe('50')
    expect(r.summary.find((s) => s.label === 'Total Short')!.value).toBe('20')
    expect(r.summary.find((s) => s.label === 'Outside Tolerance')!.value).toBe('1')
    expect(r.summary.find((s) => s.label === 'S&E Value')!.value).toContain('700')
  })
})
