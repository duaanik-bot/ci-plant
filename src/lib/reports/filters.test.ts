import { describe, it, expect } from 'vitest'
import { dateRangeSchema, optionalId } from './filters'

describe('reports/filters', () => {
  it('parses from/to into Date and defaults to current month when absent', () => {
    const r = dateRangeSchema.parse({ from: '2026-04-01', to: '2026-04-30' })
    expect(r.from.getUTCFullYear()).toBe(2026)
    expect(r.to.getUTCMonth()).toBe(3)
    const def = dateRangeSchema.parse({})
    expect(def.from instanceof Date).toBe(true)
    expect(def.to instanceof Date).toBe(true)
    expect(def.from.getTime()).toBeLessThanOrEqual(def.to.getTime())
  })
  it('rejects from after to', () => {
    expect(() => dateRangeSchema.parse({ from: '2026-05-10', to: '2026-05-01' })).toThrow()
  })
  it('optionalId coerces empty string to undefined', () => {
    expect(optionalId.parse('')).toBeUndefined()
    expect(optionalId.parse('abc')).toBe('abc')
    expect(optionalId.parse(undefined)).toBeUndefined()
  })
})
