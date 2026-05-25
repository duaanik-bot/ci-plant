import { describe, it, expect } from 'vitest'
import { resolveRequirementFromLine } from './production-os-resolvers'

describe('resolveRequirementFromLine makeReadySheets', () => {
  it('defaults makeReadySheets to 0', () => {
    const r = resolveRequirementFromLine({ line: { quantity: 1000, spec: { ups: 2 } } })
    expect(r.makeReadySheets).toBe(0)
  })

  it('reads makeReadySheets from planningCore', () => {
    const r = resolveRequirementFromLine({
      line: { quantity: 1000, specOverrides: { planningCore: { ups: 2, makeReadySheets: 120 } } },
    })
    expect(r.makeReadySheets).toBe(120)
  })
})
