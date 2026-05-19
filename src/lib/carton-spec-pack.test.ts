import { describe, it, expect } from 'vitest'
import { buildCartonSpecPack, type CartonForPack } from './carton-spec-pack'

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
    expect(typeof p.source.snapshotAt).toBe('string')
  })

  it('produces nulls (never throws) for a sparse carton', () => {
    const p = buildCartonSpecPack({ id: 'c2', cartonName: 'X' } as CartonForPack)
    expect(p.sheet).toEqual({ sheetSizeL: null, sheetSizeW: null, ups: null })
    expect(p.finishing.spotUv).toBe(false)
    expect(p.board.gsm).toBeNull()
  })
})
