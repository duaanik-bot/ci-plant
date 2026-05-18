import { describe, it, expect } from 'vitest'
import { REPORTS, getReport, listReports } from './registry'

describe('reports/registry', () => {
  it('every module id matches its map key and is unique', () => {
    const ids = Object.values(REPORTS).map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const [key, mod] of Object.entries(REPORTS)) expect(mod.id).toBe(key)
  })
  it('getReport returns module or undefined', () => {
    expect(getReport('___nope___')).toBeUndefined()
  })
  it('listReports returns metadata array', () => {
    expect(Array.isArray(listReports())).toBe(true)
  })
})
