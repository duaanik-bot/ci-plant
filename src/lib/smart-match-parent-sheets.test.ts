import { describe, it, expect } from 'vitest'
import {
  parseSheetDims,
  factorPairs,
  computeEqualDivisionFit,
  rankParentSheetMatches,
  pickPreferredParentSheetMatch,
  computeParentFromChild,
  type ParentSheetCandidate,
} from './smart-match-parent-sheets'

describe('parseSheetDims', () => {
  it('parses common separators', () => {
    expect(parseSheetDims('23 x 36')).toEqual({ length: 23, width: 36 })
    expect(parseSheetDims('720×1020')).toEqual({ length: 720, width: 1020 })
    expect(parseSheetDims('23*36')).toEqual({ length: 23, width: 36 })
    expect(parseSheetDims('23 X 36 in')).toEqual({ length: 23, width: 36 })
    expect(parseSheetDims('12.5 x 23')).toEqual({ length: 12.5, width: 23 })
  })
  it('rejects garbage', () => {
    expect(parseSheetDims(null)).toBeNull()
    expect(parseSheetDims('23')).toBeNull()
    expect(parseSheetDims('')).toBeNull()
  })
})

describe('factorPairs', () => {
  it('enumerates integer factor pairs', () => {
    expect(factorPairs(2)).toEqual([[1, 2], [2, 1]])
    expect(factorPairs(4)).toEqual([[1, 4], [2, 2], [4, 1]])
    expect(factorPairs(6)).toEqual([[1, 6], [2, 3], [3, 2], [6, 1]])
  })
})

describe('computeEqualDivisionFit', () => {
  it('fits child 12×23 into a 2-cut 23×36 parent (2 pieces)', () => {
    const fit = computeEqualDivisionFit({
      parentLength: 23,
      parentWidth: 36,
      childLength: 12,
      childWidth: 23,
      cutType: 2,
    })
    expect(fit.qualifies).toBe(true)
    expect(fit.piecesPerSheet).toBe(2)
    expect(fit.utilizationPct).toBeCloseTo(66.7, 0)
  })

  it('rejects a parent too small for the cut (20×30, 2-cut, child 12×23)', () => {
    const fit = computeEqualDivisionFit({
      parentLength: 20,
      parentWidth: 30,
      childLength: 12,
      childWidth: 23,
      cutType: 2,
    })
    expect(fit.qualifies).toBe(false)
    expect(fit.piecesPerSheet).toBe(0)
  })

  it('1-cut leaves the whole parent as one division', () => {
    const fit = computeEqualDivisionFit({
      parentLength: 23,
      parentWidth: 36,
      childLength: 12,
      childWidth: 23,
      cutType: 1,
    })
    expect(fit.qualifies).toBe(true)
    // 23×36 fits 12×23 → floor(36/12)=3 in one strip → 3 pieces
    expect(fit.piecesPerSheet).toBeGreaterThanOrEqual(2)
  })
})

describe('rankParentSheetMatches', () => {
  const candidates: ParentSheetCandidate[] = [
    { materialId: 'a', materialCode: 'P-23x36', boardType: 'Duplex GB', gsm: 350, size: '23 x 36', freeSheets: 5000, availableSheets: 5000, gsmDelta: 0 },
    { materialId: 'b', materialCode: 'P-24x36', boardType: 'Duplex GB', gsm: 350, size: '24 x 36', freeSheets: 5000, availableSheets: 5000, gsmDelta: 0 },
    { materialId: 'c', materialCode: 'P-25x38', boardType: 'Duplex GB', gsm: 350, size: '25 x 38', freeSheets: 5000, availableSheets: 5000, gsmDelta: 0 },
    { materialId: 'd', materialCode: 'P-20x30', boardType: 'Duplex GB', gsm: 350, size: '20 x 30', freeSheets: 5000, availableSheets: 5000, gsmDelta: 0 },
  ]

  it('returns only parents that can produce the child and rejects the rest', () => {
    const out = rankParentSheetMatches({
      childLength: 12,
      childWidth: 23,
      cutType: 2,
      requiredQty: 1000,
      unit: 'inch',
      boardType: 'Duplex GB',
      gsm: 350,
      candidates,
    })
    const codes = out.map((m) => m.materialCode)
    expect(codes).toContain('P-23x36')
    expect(codes).toContain('P-24x36')
    expect(codes).toContain('P-25x38')
    expect(codes).not.toContain('P-20x30')
  })

  it('ranks higher utilization first (23×36 best)', () => {
    const out = rankParentSheetMatches({
      childLength: 12,
      childWidth: 23,
      cutType: 2,
      requiredQty: 1000,
      unit: 'inch',
      boardType: 'Duplex GB',
      gsm: 350,
      candidates,
    })
    expect(out[0]!.materialCode).toBe('P-23x36')
    expect(out[0]!.label).toBe('Best Parent Sheet')
    expect(out[0]!.utilizationPct).toBeGreaterThan(out[1]!.utilizationPct)
  })

  it('computes required parent sheets from pieces per sheet', () => {
    const out = rankParentSheetMatches({
      childLength: 12,
      childWidth: 23,
      cutType: 2,
      requiredQty: 1000,
      unit: 'inch',
      boardType: 'Duplex GB',
      gsm: 350,
      candidates,
    })
    const best = out.find((m) => m.materialCode === 'P-23x36')!
    expect(best.piecesPerSheet).toBe(2)
    expect(best.requiredParentSheets).toBe(500)
  })

  it('flags insufficient stock as Manual Review with a shortage', () => {
    const out = rankParentSheetMatches({
      childLength: 12,
      childWidth: 23,
      cutType: 2,
      requiredQty: 100000,
      unit: 'inch',
      boardType: 'Duplex GB',
      gsm: 350,
      candidates: [{ ...candidates[0]!, freeSheets: 10, availableSheets: 10 }],
    })
    expect(out[0]!.label).toBe('Manual Review')
    expect(out[0]!.shortageParentSheets).toBeGreaterThan(0)
    expect(out[0]!.sufficientStock).toBe(false)
  })

  it('never emits negative metrics', () => {
    const out = rankParentSheetMatches({
      childLength: 12,
      childWidth: 23,
      cutType: 2,
      requiredQty: 1000,
      unit: 'inch',
      candidates,
    })
    for (const m of out) {
      expect(m.utilizationPct).toBeGreaterThanOrEqual(0)
      expect(m.wastePct).toBeGreaterThanOrEqual(0)
      expect(m.requiredParentSheets).toBeGreaterThan(0)
      expect(m.shortageParentSheets).toBeGreaterThanOrEqual(0)
      expect(m.matchScore).toBeGreaterThanOrEqual(0)
      expect(m.matchScore).toBeLessThanOrEqual(100)
    }
  })

  it('returns empty when no candidate can produce the child', () => {
    const out = rankParentSheetMatches({
      childLength: 40,
      childWidth: 50,
      cutType: 2,
      requiredQty: 1000,
      unit: 'inch',
      candidates,
    })
    expect(out).toEqual([])
  })

  it('handles mm parents (720×1020) with an mm child', () => {
    const out = rankParentSheetMatches({
      childLength: 350,
      childWidth: 500,
      cutType: 2,
      requiredQty: 1000,
      unit: 'mm',
      candidates: [{ materialId: 'm', materialCode: 'SRA', boardType: 'FBB', gsm: 300, size: '720×1020', freeSheets: 4000, availableSheets: 4000 }],
    })
    expect(out.length).toBe(1)
    expect(out[0]!.unit).toBe('mm')
    expect(out[0]!.parentSize).toContain('mm')
  })

  it('chooses the first preferred cut type that maps to an inventory candidate', () => {
    const out = pickPreferredParentSheetMatch({
      childLength: 19,
      childWidth: 20,
      requiredQty: 40000,
      unit: 'inch',
      candidates: [
        { materialId: 'too-small', materialCode: 'P-19x20', boardType: 'FBB', gsm: 280, size: '19 x 20', freeSheets: 1000, availableSheets: 1000 },
        { materialId: 'two-cut', materialCode: 'P-20x39', boardType: 'FBB', gsm: 280, size: '20 x 39', freeSheets: 1000, availableSheets: 1000 },
        { materialId: 'four-cut', materialCode: 'P-40x39', boardType: 'FBB', gsm: 280, size: '40 x 39', freeSheets: 1000, availableSheets: 1000 },
      ],
    })

    expect(out?.cutType).toBe(2)
    expect(out?.piecesPerSheet).toBeGreaterThanOrEqual(2)
  })
})

describe('parent-unit inference (magnitude heuristic)', () => {
  it('infers inch for small dimensions (23 × 36)', () => {
    const out = rankParentSheetMatches({
      childLength: 12,
      childWidth: 23,
      cutType: 2,
      requiredQty: 100,
      unit: 'inch',
      candidates: [{ materialId: 'i', materialCode: 'INCH', boardType: 'Duplex GB', gsm: 350, size: '23 × 36', freeSheets: 1000, availableSheets: 1000 }],
    })
    expect(out.length).toBe(1)
    expect(out[0]!.unit).toBe('inch')
    expect(out[0]!.parentSize).toBe('23 × 36 in')
  })

  it('infers mm for large dimensions (720 × 1020)', () => {
    const out = rankParentSheetMatches({
      childLength: 350,
      childWidth: 500,
      cutType: 2,
      requiredQty: 100,
      unit: 'mm',
      candidates: [{ materialId: 'm', materialCode: 'MM', boardType: 'FBB', gsm: 300, size: '720 × 1020', freeSheets: 1000, availableSheets: 1000 }],
    })
    expect(out.length).toBe(1)
    expect(out[0]!.unit).toBe('mm')
    expect(out[0]!.parentSize).toBe('720 × 1020 mm')
  })

  it('converts an inch-entered child against an mm parent before fitting', () => {
    // Child 14×20 inch ≈ 356×508 mm fits a 720×1020 mm parent under 2-cut.
    const out = rankParentSheetMatches({
      childLength: 14,
      childWidth: 20,
      cutType: 2,
      requiredQty: 100,
      unit: 'inch',
      candidates: [{ materialId: 'm', materialCode: 'MM', boardType: 'FBB', gsm: 300, size: '720 × 1020', freeSheets: 1000, availableSheets: 1000 }],
    })
    expect(out.length).toBe(1)
    expect(out[0]!.unit).toBe('mm')
    expect(out[0]!.piecesPerSheet).toBeGreaterThanOrEqual(2)
  })
})

describe('computeParentFromChild', () => {
  it('computes the squarest 2-cut parent (18×23 → 23×36) and snaps to a master size', () => {
    const r = computeParentFromChild({
      childLength: 18,
      childWidth: 23,
      cutType: 2,
      unit: 'inch',
      snapTargets: ['23 x 36', '25 x 38', '20 x 30'],
    })
    expect(r).not.toBeNull()
    expect([r!.rawLength, r!.rawWidth]).toEqual([23, 36])
    expect([r!.length, r!.width]).toEqual([23, 36])
    expect(r!.snappedTo).toBe('master')
  })

  it('falls back to the raw size when no master size is large enough', () => {
    const r = computeParentFromChild({
      childLength: 18,
      childWidth: 23,
      cutType: 2,
      unit: 'inch',
      snapTargets: ['20 x 30'],
    })
    expect([r!.rawLength, r!.rawWidth]).toEqual([23, 36])
    expect([r!.length, r!.width]).toEqual([23, 36])
    expect(r!.snappedTo).toBeNull()
  })

  it('picks the squarest grid for 4-cut (36×46) and 6-cut (46×54)', () => {
    const four = computeParentFromChild({ childLength: 18, childWidth: 23, cutType: 4, unit: 'inch' })
    expect([four!.rawLength, four!.rawWidth]).toEqual([36, 46])
    const six = computeParentFromChild({ childLength: 18, childWidth: 23, cutType: 6, unit: 'inch' })
    expect([six!.rawLength, six!.rawWidth]).toEqual([46, 54])
  })

  it('1-cut returns the child size itself', () => {
    const r = computeParentFromChild({ childLength: 18, childWidth: 23, cutType: 1, unit: 'inch' })
    expect([r!.rawLength, r!.rawWidth]).toEqual([18, 23])
    expect(r!.grid).toEqual([1, 1])
  })

  it('snaps against mm master sizes when the child is in inch', () => {
    const r = computeParentFromChild({
      childLength: 18,
      childWidth: 23,
      cutType: 2,
      unit: 'inch',
      snapTargets: ['600 x 950'],
    })
    expect(r!.snappedTo).toBe('master')
    expect(r!.length).toBeCloseTo(23.6, 1)
    expect(r!.width).toBeCloseTo(37.4, 1)
  })

  it('returns null for non-positive child dims', () => {
    expect(computeParentFromChild({ childLength: 0, childWidth: 23, cutType: 2, unit: 'inch' })).toBeNull()
  })
})
