import { describe, it, expect } from 'vitest'
import { computeVariance } from './variance'

describe('computeVariance', () => {
  const spec = { l: 138, w: 50, h: 108 }
  it('exact match → no mismatch, zero variance', () => {
    const r = computeVariance(spec, { l: 138, w: 50, h: 108 }, 2)
    expect(r.variance).toEqual({ l: 0, w: 0, h: 0 })
    expect(r.sizeMismatch).toBe(false)
    expect(r.maxAbsVariance).toBe(0)
  })
  it('<=2mm on all axes → not a mismatch', () => {
    const r = computeVariance(spec, { l: 139, w: 48, h: 110 }, 2)
    expect(r.sizeMismatch).toBe(false)
  })
  it('>2mm on one axis → mismatch', () => {
    const r = computeVariance(spec, { l: 145, w: 50, h: 108 }, 2)
    expect(r.variance.l).toBe(7)
    expect(r.sizeMismatch).toBe(true)
    expect(r.maxAbsVariance).toBe(7)
  })
  it('missing physical value → that axis variance null, not a mismatch by itself', () => {
    const r = computeVariance(spec, { l: null, w: 50, h: 108 }, 2)
    expect(r.variance.l).toBeNull()
    expect(r.sizeMismatch).toBe(false)
  })
})
