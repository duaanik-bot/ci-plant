import { describe, expect, it } from 'vitest'
import { calculateCutsPerSheet } from '@/lib/material-cut-fit'
import {
  IN_TO_MM,
  deriveChildSizeMm,
  formatSizeDisplay,
  formatSizeMm,
  fromMm,
  roundForUnit,
  toMm,
} from '@/lib/planning-sheet-cut'

describe('unit conversion', () => {
  it('converts inches to mm', () => {
    expect(toMm(1, 'in')).toBe(IN_TO_MM)
    expect(toMm(10, 'in')).toBeCloseTo(254, 6)
  })
  it('passes mm through unchanged', () => {
    expect(toMm(720, 'mm')).toBe(720)
  })
  it('round-trips mm → in → mm', () => {
    const mm = 1020
    expect(toMm(fromMm(mm, 'in'), 'in')).toBeCloseTo(mm, 6)
  })
  it('clamps non-positive input to 0', () => {
    expect(toMm(0, 'in')).toBe(0)
    expect(toMm(-5, 'mm')).toBe(0)
    expect(fromMm(Number.NaN, 'mm')).toBe(0)
  })
})

describe('roundForUnit', () => {
  it('rounds mm to whole numbers', () => {
    expect(roundForUnit(719.6, 'mm')).toBe(720)
  })
  it('rounds inches to 2 decimals', () => {
    expect(roundForUnit(28.346, 'in')).toBe(28.35)
  })
})

describe('deriveChildSizeMm (locked strip cutting)', () => {
  it('1-cut returns the parent unchanged', () => {
    expect(deriveChildSizeMm(1000, 700, 1)).toEqual({ lengthMm: 1000, widthMm: 700 })
  })
  it('2-cut halves the longer edge', () => {
    expect(deriveChildSizeMm(1000, 700, 2)).toEqual({ lengthMm: 500, widthMm: 700 })
  })
  it('treats width as the long edge when larger', () => {
    expect(deriveChildSizeMm(700, 1000, 2)).toEqual({ lengthMm: 500, widthMm: 700 })
  })
  it('rejects invalid inputs', () => {
    expect(deriveChildSizeMm(0, 700, 2)).toBeNull()
    expect(deriveChildSizeMm(1000, 700, 0)).toBeNull()
  })

  // The derivation must be self-consistent with the engine's grid cut math.
  it.each([1, 2, 3, 4, 5, 6, 7, 8])('cut count %i round-trips through calculateCutsPerSheet', (cut) => {
    const parentLength = 1000
    const parentWidth = 700
    const child = deriveChildSizeMm(parentLength, parentWidth, cut)!
    const cuts = calculateCutsPerSheet({
      parentLength,
      parentWidth,
      reqLength: child.lengthMm,
      reqWidth: child.widthMm,
    })
    expect(cuts).toBe(cut)
  })
})

describe('size formatting', () => {
  it('formats canonical mm string for the backend', () => {
    expect(formatSizeMm(720, 1020)).toBe('720x1020')
    expect(formatSizeMm(0, 1020)).toBe('')
  })
  it('formats a human display string per unit', () => {
    expect(formatSizeDisplay(720, 1020, 'mm')).toBe('720 × 1020 mm')
    expect(formatSizeDisplay(0, 0, 'in')).toBe('—')
  })
})
