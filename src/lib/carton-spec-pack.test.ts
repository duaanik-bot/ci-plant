import { describe, it, expect } from 'vitest'
import { buildCartonSpecPack, readCartonSpecPack, emptySpecPack, computePackSheetMath, mergeSpecPackUps, type CartonForPack } from './carton-spec-pack'

const fullCarton: CartonForPack = {
  id: 'c1',
  cartonName: 'APEG ORAL SOLUTION 200ML',
  boardGrade: 'SBS (Solid Bleached Sulphate)',
  gsm: 350,
  paperType: 'White',
  caliperMicrons: 450,
  plyCount: 1,
  finishedLength: 59,
  finishedWidth: 59,
  finishedHeight: 175,
  blankLength: 210,
  blankWidth: 297,
  dimensionTol: 0.5,
  sheetSizeL: 720,
  sheetSizeW: 510,
  ups: 6,
  printingType: 'Offset',
  numberOfColours: 4,
  backPrint: 'No',
  artworkCode: 'AGSSLLCA001/01',
  coatingType: 'Full UV Coating',
  laminateType: null,
  foilType: null,
  embossingLeafing: 'Embossing',
  drugSchedule: 'H',
  scheduleMRequired: true,
  dieMasterId: 'd1',
  pastingStyle: 'STRAIGHT_TUCK_END',
  shadeCardId: 's1',
  specialInstructions: JSON.stringify({ notes: 'x', spotUvEnabled: true, brailleEnabled: false }),
}

describe('buildCartonSpecPack', () => {
  it('maps a full carton into a v1 pack', () => {
    const p = buildCartonSpecPack(fullCarton)
    expect(p.v).toBe(1)
    expect(p.source.cartonId).toBe('c1')
    expect(p.board).toEqual({
      boardGrade: 'SBS (Solid Bleached Sulphate)', gsm: 350,
      paperType: 'White', caliperMicrons: 450, plyCount: 1,
    })
    expect(p.sheet).toEqual({ sheetSizeL: 720, sheetSizeW: 510, ups: 6 })
    expect(p.finishing.spotUv).toBe(true)
    expect(p.finishing.braille).toBe(false)
    expect(p.pharma).toEqual({ drugSchedule: 'H', scheduleMRequired: true })
    expect(p.dimensions).toEqual({
      finishedL: 59, finishedW: 59, finishedH: 175,
      blankL: 210, blankW: 297, dimensionTol: 0.5,
    })
    expect(p.print).toEqual({
      printingType: 'Offset', numberOfColours: 4,
      backPrint: 'No', artworkCode: 'AGSSLLCA001/01',
    })
    expect(p.tooling).toEqual({ dieMasterId: 'd1', pastingStyle: 'STRAIGHT_TUCK_END' })
    expect(p.linkage).toEqual({ shadeCardId: 's1' })
    expect(typeof p.source.snapshotAt).toBe('string')
  })

  it('produces nulls (never throws) for a sparse carton', () => {
    const p = buildCartonSpecPack({ id: 'c2', cartonName: 'X' } as CartonForPack)
    expect(p.sheet).toEqual({ sheetSizeL: null, sheetSizeW: null, ups: null })
    expect(p.finishing.spotUv).toBe(false)
    expect(p.board.gsm).toBeNull()
  })
})

describe('readCartonSpecPack', () => {
  it('flags a legacy line (null specPack) and returns an all-null pack', () => {
    const r = readCartonSpecPack({ specPack: null, specOverrides: null })
    expect(r.legacy).toBe(true)
    expect(r.pack.sheet.ups).toBeNull()
    expect(r.pack.v).toBe(1)
  })

  it('returns the stored pack and is not legacy', () => {
    const stored = emptySpecPack('c9', 'CARTON 9')
    stored.sheet.ups = 8
    const r = readCartonSpecPack({ specPack: stored, specOverrides: null })
    expect(r.legacy).toBe(false)
    expect(r.pack.sheet.ups).toBe(8)
  })

  it('deep-merges specOverrides.specPack over the stored pack', () => {
    const stored = emptySpecPack('c9', 'CARTON 9')
    stored.board.gsm = 300
    stored.sheet.ups = 6
    const r = readCartonSpecPack({
      specPack: stored,
      specOverrides: { specPack: { board: { gsm: 350 } } },
    })
    expect(r.pack.board.gsm).toBe(350) // override wins
    expect(r.pack.sheet.ups).toBe(6)   // untouched
  })

  it('replaces (does not merge) array override values and ignores __proto__', () => {
    const stored = emptySpecPack('c1', 'X')
    const r = readCartonSpecPack({
      specPack: stored,
      specOverrides: { specPack: { board: { gsm: 350 } }, ['__proto__' as any]: { polluted: true } },
    })
    expect(r.pack.board.gsm).toBe(350)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('treats a non-v1 stored pack as legacy', () => {
    const r = readCartonSpecPack({ specPack: { v: 2, board: {} }, specOverrides: null })
    expect(r.legacy).toBe(true)
    expect(r.pack.v).toBe(1)
  })

  it('does not mutate the input specPack when overrides applied', () => {
    const stored = emptySpecPack('c1', 'X')
    stored.board.gsm = 300
    const r = readCartonSpecPack({ specPack: stored, specOverrides: { specPack: { board: { gsm: 350 } } } })
    expect(r.pack.board.gsm).toBe(350)
    expect(stored.board.gsm).toBe(300) // original untouched
  })
})

describe('computePackSheetMath', () => {
  it('computes ceil(qty/ups) * (1 + wastage) ceiled', () => {
    const r = computePackSheetMath({ ups: 6 }, 18000, 2)
    // ceil(18000/6)=3000; *1.02=3060
    expect(r.specComplete).toBe(true)
    expect(r.sheetsRequired).toBe(3060)
  })

  it('flags incomplete when ups missing', () => {
    const r = computePackSheetMath({ ups: null }, 18000, 2)
    expect(r.specComplete).toBe(false)
    expect(r.sheetsRequired).toBeNull()
    expect(r.reason).toMatch(/ups/i)
  })

  it('flags incomplete on non-positive quantity', () => {
    const r = computePackSheetMath({ ups: 6 }, 0, 2)
    expect(r.specComplete).toBe(false)
    expect(r.sheetsRequired).toBeNull()
  })

  it('returns base sheets with zero wastage', () => {
    const r = computePackSheetMath({ ups: 6 }, 18000, 0)
    expect(r.specComplete).toBe(true)
    expect(r.sheetsRequired).toBe(3000)
  })

  it('does not off-by-one on exact division with zero wastage', () => {
    const r = computePackSheetMath({ ups: 6 }, 12000, 0)
    expect(r.sheetsRequired).toBe(2000)
  })
})

describe('mergeSpecPackUps', () => {
  it('writes ups into specPack.sheet without disturbing other keys', () => {
    const spec = { meta: { ups: 4 }, specPack: { sheet: { sheetSizeL: 720 } } }
    const next = mergeSpecPackUps(spec, 4) as { meta: unknown; specPack: { sheet: Record<string, unknown> } }
    expect(next.specPack.sheet.ups).toBe(4)
    expect(next.specPack.sheet.sheetSizeL).toBe(720)
    expect(next.meta).toEqual({ ups: 4 }) // unrelated keys preserved
  })

  it('floors a fractional ups and clears on null/invalid', () => {
    expect((mergeSpecPackUps({}, 4.9) as { specPack: { sheet: { ups?: number } } }).specPack.sheet.ups).toBe(4)
    expect((mergeSpecPackUps({ specPack: { sheet: { ups: 4 } } }, null) as { specPack: { sheet: { ups?: number } } }).specPack.sheet.ups).toBeUndefined()
  })

  it('is non-mutating', () => {
    const spec = { specPack: { sheet: { ups: 2 } } }
    const next = mergeSpecPackUps(spec, 6)
    expect((spec.specPack.sheet as { ups: number }).ups).toBe(2)
    expect(next).not.toBe(spec)
  })

  // The whole point: the override must flip the spec-complete gate.
  it('clears the spec-complete gate end-to-end via readCartonSpecPack', () => {
    const incompleteOverrides = {} // no UPS anywhere
    const before = readCartonSpecPack({ specPack: null, specOverrides: incompleteOverrides })
    expect(computePackSheetMath(before.pack.sheet, 18000, 2).specComplete).toBe(false)

    const withUps = mergeSpecPackUps(incompleteOverrides, 6)
    const after = readCartonSpecPack({ specPack: null, specOverrides: withUps })
    const math = computePackSheetMath(after.pack.sheet, 18000, 2)
    expect(math.specComplete).toBe(true)
    expect(math.sheetsRequired).toBe(3060) // ceil(18000/6) * 1.02
  })
})
