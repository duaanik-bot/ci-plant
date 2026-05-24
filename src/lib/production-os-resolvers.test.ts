import { describe, it, expect } from 'vitest'
import { resolveRequirementFromLine } from './production-os-resolvers'

describe('resolveRequirementFromLine make-ready', () => {
  const base = { quantity: 20000, specOverrides: { meta: { ups: 4 } } }

  it('defaults make-ready to 0 → total = base + wastage (unchanged)', () => {
    const r = resolveRequirementFromLine({ line: base, wastageOverride: 150 })
    expect(r.baseSheets).toBe(5000)
    expect(r.makeReadySheets).toBe(0)
    expect(r.requiredSheets).toBe(5150)
  })

  it('adds make-ready when present in spec', () => {
    const r = resolveRequirementFromLine({
      line: { quantity: 20000, specOverrides: { meta: { ups: 4, makeReadySheets: 200 } } },
      wastageOverride: 150,
    })
    expect(r.makeReadySheets).toBe(200)
    expect(r.requiredSheets).toBe(5350)
  })

  it('honors makeReadyOverride', () => {
    const r = resolveRequirementFromLine({ line: base, wastageOverride: 100, makeReadyOverride: 50 })
    expect(r.requiredSheets).toBe(5150) // 5000 + 50 + 100
  })
})
