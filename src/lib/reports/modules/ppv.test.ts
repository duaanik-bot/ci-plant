import { describe, it, expect } from 'vitest'
import { computePpv, type PpvInput } from './ppv'

const input: PpvInput[] = [
  { vendor: 'V1', boardGrade: 'SBS', gsm: 300, qtyKg: 1000,
    basicRate: 55, landedRate: 60, freightPerKg: 3, unloadingPerKg: 1, insurancePerKg: 1,
    stdRate: 50 },
  { vendor: 'V2', boardGrade: 'FBB', gsm: 250, qtyKg: 500,
    basicRate: 48, landedRate: 52, freightPerKg: 2, unloadingPerKg: 1, insurancePerKg: 1,
    stdRate: null },
]

describe('computePpv', () => {
  const r = computePpv(input)
  it('computes basic and landed PPV per line', () => {
    const row = r.rows.find((x) => x.vendor === 'V1')!
    expect(row.basicPpv).toBe((55 - 50) * 1000)
    expect(row.landedPpv).toBe((60 - 50) * 1000)
  })
  it('decomposes landed variance into components', () => {
    const row = r.rows.find((x) => x.vendor === 'V1')!
    expect(row.freightVar).toBe(3 * 1000)
    expect(row.unloadingVar).toBe(1 * 1000)
    expect(row.insuranceVar).toBe(1 * 1000)
    expect(row.priceVar).toBe((55 - 50) * 1000)
  })
  it('flags no-baseline rows and excludes them from totals', () => {
    const v2 = r.rows.find((x) => x.vendor === 'V2')!
    expect(v2.baseline).toBe('no baseline')
    const total = r.summary.find((s) => s.label === 'Total Landed PPV')!
    expect(total.value).toBe('₹10,000')
  })
  it('marks adverse total tone bad', () => {
    expect(r.summary.find((s) => s.label === 'Total Landed PPV')!.tone).toBe('bad')
  })
})
