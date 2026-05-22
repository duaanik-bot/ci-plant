import { describe, expect, it } from 'vitest'
import { calculateCutsPerSheet } from '@/lib/material-cut-fit'
import {
  IN_TO_MM,
  deriveChildSizeMm,
  deriveParentSizeMm,
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

describe('deriveParentSizeMm (inverse strip cutting)', () => {
  it('1-cut returns the child unchanged (parent === child)', () => {
    expect(deriveParentSizeMm(1000, 700, 1)).toEqual({ lengthMm: 1000, widthMm: 700 })
  })
  it('2-cut doubles the longer child edge', () => {
    expect(deriveParentSizeMm(500, 700, 2)).toEqual({ lengthMm: 1400, widthMm: 500 })
  })
  it('treats width as the long edge when larger', () => {
    // child 500×1000, 2-cut → parent 2000×500
    expect(deriveParentSizeMm(500, 1000, 2)).toEqual({ lengthMm: 2000, widthMm: 500 })
  })
  it('rejects invalid inputs', () => {
    expect(deriveParentSizeMm(0, 700, 2)).toBeNull()
    expect(deriveParentSizeMm(500, 700, 0)).toBeNull()
  })

  // deriveParentSizeMm must be the inverse of deriveChildSizeMm:
  // deriveChildSizeMm(derivedParent, cutType) === original child in normalized form
  // (deriveChildSizeMm always returns {lengthMm: longer, widthMm: shorter}).
  it.each([1, 2, 3, 4, 5, 6, 7, 8])('round-trips with deriveChildSizeMm for %i-cut', (cut) => {
    const childLength = 360
    const childWidth = 700
    const parent = deriveParentSizeMm(childLength, childWidth, cut)!
    const childBack = deriveChildSizeMm(parent.lengthMm, parent.widthMm, cut)!
    // deriveChildSizeMm normalises to {longer, shorter} regardless of input orientation.
    const expectedLong = Math.max(childLength, childWidth)
    const expectedShort = Math.min(childLength, childWidth)
    expect(childBack.lengthMm).toBe(expectedLong)
    expect(childBack.widthMm).toBe(expectedShort)
  })

  // Derived parent must yield the correct cut count via calculateCutsPerSheet.
  it.each([1, 2, 3, 4, 5, 6, 7, 8])('derived parent yields correct cutsPerSheet for %i-cut', (cut) => {
    const childLength = 360
    const childWidth = 700
    const parent = deriveParentSizeMm(childLength, childWidth, cut)!
    const cuts = calculateCutsPerSheet({
      parentLength: parent.lengthMm,
      parentWidth: parent.widthMm,
      reqLength: childLength,
      reqWidth: childWidth,
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
