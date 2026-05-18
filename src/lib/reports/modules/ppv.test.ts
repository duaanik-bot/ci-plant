import { describe, it, expect } from 'vitest'
import { computePpv } from './ppv'
import { fmtInr } from '../format'

const base = {
  vendor: 'Vendor A',
  material: 'Duplex Board',
  boardGrade: '300gsm',
  qtyKg: 1000,
  basicRate: 45,
  standardRate: 40,
  freightPerKg: 2,
  unloadingPerKg: 0.5,
  insurancePerKg: 0.5,
}

describe('computePpv', () => {
  it('computes all variance components when baseline present', () => {
    const { rows } = computePpv([base])
    const r = rows[0]
    expect(r.priceVar).toBe(5000)   // (45-40)*1000
    expect(r.freightVar).toBe(2000) // 2*1000
    expect(r.unloadingVar).toBe(500)
    expect(r.insuranceVar).toBe(500)
    expect(r.totalVar).toBe(8000)
    expect(r.baseline).toBe('ok')
  })

  it('no-baseline row: all variance components are 0, baseline=missing', () => {
    const noBase = { ...base, standardRate: null }
    const { rows } = computePpv([noBase])
    const r = rows[0]
    expect(r.priceVar).toBe(0)
    expect(r.freightVar).toBe(0)
    expect(r.unloadingVar).toBe(0)
    expect(r.insuranceVar).toBe(0)
    expect(r.totalVar).toBe(0)
    expect(r.baseline).toBe('missing')
  })

  it('no-baseline rows excluded from counted and totals', () => {
    const noBase = { ...base, standardRate: null }
    const { rows, counted, totalLandedVar } = computePpv([base, noBase])
    expect(rows).toHaveLength(2)
    expect(counted).toHaveLength(1)
    expect(totalLandedVar).toBe(8000)
  })

  it('summary Total Landed PPV value is exact when variance is 10,000', () => {
    // zero landing costs so totalVar = priceVar alone = (50-40)*1000 = 10000
    const simple = { ...base, basicRate: 50, standardRate: 40, qtyKg: 1000, freightPerKg: 0, unloadingPerKg: 0, insurancePerKg: 0 }
    const { totalLandedVar } = computePpv([simple])
    // Build a summary card the same way the query function does
    const summary = [
      { label: 'Total Landed PPV', value: fmtInr(totalLandedVar) },
    ]
    const total = summary.find((s) => s.label === 'Total Landed PPV')!
    expect(total.value).toBe('₹10,000')
  })
})
