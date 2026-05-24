import { describe, it, expect } from 'vitest'
import { computeSuggestion } from './procurement-suggestions'

const base = {
  shortage_sheets: 0,
  incoming_sheets: 0,
  reorder_level: 1000,
  daysOfCover: 30,
  packet_weight: 0.5,
}

describe('computeSuggestion', () => {
  it('returns null when no shortage', () => {
    expect(computeSuggestion({ ...base, shortage_sheets: 0 })).toBeNull()
  })

  it('uses reorder_level when it exceeds shortage', () => {
    const result = computeSuggestion({ ...base, shortage_sheets: 400, reorder_level: 1000 })
    expect(result).not.toBeNull()
    expect(result!.suggestedKg).toBeCloseTo(1000 * 0.5)
    expect(result!.basis).toBe('reorder_level')
  })

  it('uses shortage_sheets when it exceeds reorder_level', () => {
    const result = computeSuggestion({ ...base, shortage_sheets: 2000, reorder_level: 500 })
    expect(result).not.toBeNull()
    expect(result!.suggestedKg).toBeCloseTo(2000 * 0.5)
    expect(result!.basis).toBe('consumption')
  })

  it('subtracts incoming_sheets from net shortage', () => {
    // shortage=1000, incoming=600 → net=400; reorder_level=1000 > net → uses reorder_level
    const result = computeSuggestion({ ...base, shortage_sheets: 1000, incoming_sheets: 600, reorder_level: 1000 })
    expect(result).not.toBeNull()
    expect(result!.suggestedKg).toBeCloseTo(1000 * 0.5) // reorder_level wins
  })
})
