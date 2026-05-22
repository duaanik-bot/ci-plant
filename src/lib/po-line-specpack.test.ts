import { describe, it, expect } from 'vitest'
import { buildCartonSpecPack, type CartonForPack } from './carton-spec-pack'
import {
  seedLineFromSpecPack,
  applySpecOverrideEdit,
  EDITABLE_SPEC_FIELDS,
  type SpecSeedLine,
} from './po-line-specpack'

const carton: CartonForPack = {
  id: 'c1',
  cartonName: 'ACEBROBID',
  boardGrade: 'SBS (Solid Bleached Sulphate)',
  gsm: 350,
  paperType: 'Ivory',
  coatingType: 'Full UV Coating',
  embossingLeafing: 'Embossing',
  foilType: null,
  pastingStyle: 'BSO',
  backPrint: 'No',
  artworkCode: 'AW-001',
}

const pack = buildCartonSpecPack(carton)

function baseLine(over: Partial<SpecSeedLine> = {}): SpecSeedLine {
  return {
    boardGrade: '', gsm: '', paperType: '', coatingType: '',
    embossingLeafing: '', foilType: '', pastingStyle: '',
    backPrint: 'No', artworkCode: '',
    printingType: '', numberOfColours: '', sheetSizeL: '', sheetSizeW: '', ups: '',
    spotUv: '', braille: '', embossing: '', leafing: '',
    specOverrides: null, specProvenance: {},
    ...over,
  }
}

describe('EDITABLE_SPEC_FIELDS', () => {
  it('covers the editable spec fields including the carton-master Specifications set', () => {
    expect(Object.keys(EDITABLE_SPEC_FIELDS).sort()).toEqual(
      [
        'artworkCode', 'backPrint', 'boardGrade', 'braille', 'coatingType', 'embossing',
        'embossingLeafing', 'foilType', 'gsm', 'leafing', 'numberOfColours', 'pastingStyle',
        'paperType', 'printingType', 'sheetSizeL', 'sheetSizeW', 'spotUv', 'ups',
      ].sort(),
    )
  })
})

describe('seedLineFromSpecPack', () => {
  it('fills empty fields from a non-null spec leaf and tags provenance "spec"', () => {
    const { patch, provenance } = seedLineFromSpecPack(baseLine(), pack, null)
    expect(patch.boardGrade).toBe('SBS (Solid Bleached Sulphate)')
    expect(patch.gsm).toBe('350')
    expect(patch.paperType).toBe('Ivory')
    expect(provenance.boardGrade).toBe('spec')
    expect(provenance.gsm).toBe('spec')
  })

  it('leaves a null spec leaf for master fallback and tags "master"', () => {
    const { patch, provenance } = seedLineFromSpecPack(
      baseLine({ foilType: 'Gold Foil' }), pack, null,
    )
    expect(patch.foilType).toBeUndefined()
    expect(provenance.foilType).toBe('master')
  })

  it('gives no provenance for a blank field with no spec leaf and no master value', () => {
    // foilType is null in the fixture pack and empty on baseLine — neither spec
    // nor master, so there should be no provenance entry and no patch entry.
    const { patch, provenance } = seedLineFromSpecPack(baseLine(), pack, null)
    expect(provenance.foilType).toBeUndefined()
    expect(patch.foilType).toBeUndefined()
  })

  it('never overwrites a user-edited field', () => {
    const { patch } = seedLineFromSpecPack(
      baseLine({ boardGrade: 'FBB', specProvenance: { boardGrade: 'user' } }),
      pack, null,
    )
    expect(patch.boardGrade).toBeUndefined()
  })

  it('resolves an override leaf as "override"', () => {
    const ov = { specPack: { board: { boardGrade: 'FBB (Folding Box Board)' } } }
    const { patch, provenance } = seedLineFromSpecPack(baseLine(), pack, ov)
    expect(patch.boardGrade).toBe('FBB (Folding Box Board)')
    expect(provenance.boardGrade).toBe('override')
  })

  it('backfills a blank field from the last-PO pack and tags "history"', () => {
    const lastPo = buildCartonSpecPack({
      ...carton,
      printingType: 'Offset',
      numberOfColours: 4,
      ups: 6,
    })
    // printingType/numberOfColours/ups are absent from the primary `pack`
    // fixture, so the only source is the last-PO snapshot.
    const { patch, provenance } = seedLineFromSpecPack(baseLine(), pack, null, lastPo)
    expect(patch.printingType).toBe('Offset')
    expect(patch.numberOfColours).toBe('4')
    expect(patch.ups).toBe('6')
    expect(provenance.printingType).toBe('history')
    expect(provenance.ups).toBe('history')
  })

  it('prefers the spec leaf over the last-PO backfill', () => {
    const lastPo = buildCartonSpecPack({ ...carton, gsm: 999 })
    const { patch, provenance } = seedLineFromSpecPack(baseLine(), pack, null, lastPo)
    expect(patch.gsm).toBe('350')
    expect(provenance.gsm).toBe('spec')
  })

  it('does not backfill a field already carrying a master value', () => {
    const lastPo = buildCartonSpecPack({ ...carton, foilType: 'Silver Foil' })
    const { patch, provenance } = seedLineFromSpecPack(
      baseLine({ foilType: 'Gold Foil' }), pack, null, lastPo,
    )
    expect(patch.foilType).toBeUndefined()
    expect(provenance.foilType).toBe('master')
  })
})

describe('applySpecOverrideEdit', () => {
  it('writes the edit into specOverrides.specPack at the mapped path and tags "user"', () => {
    const r = applySpecOverrideEdit(baseLine(), 'paperType', 'Kraft')
    expect(r.specOverrides).toEqual({ specPack: { board: { paperType: 'Kraft' } } })
    expect(r.specProvenance.paperType).toBe('user')
  })

  it('merges into an existing override object without dropping other paths', () => {
    const start = baseLine({ specOverrides: { specPack: { board: { gsm: 300 } } } })
    const r = applySpecOverrideEdit(start, 'coatingType', 'Matt Lamination')
    expect(r.specOverrides).toEqual({
      specPack: { board: { gsm: 300 }, finishing: { coatingType: 'Matt Lamination' } },
    })
    expect(r.specProvenance.coatingType).toBe('user')
  })
})
