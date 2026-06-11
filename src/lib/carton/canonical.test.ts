import { describe, it, expect } from 'vitest'
import {
  canonicalBoardGrade,
  canonicalCoating,
  canonicalPrintingType,
} from './canonical'
import {
  MASTER_BOARD_GRADES,
  MASTER_COATINGS_AND_VARNISHES,
} from '@/lib/master-enums'

describe('canonicalBoardGrade', () => {
  it('FBB / FBB coated → canonical FBB', () => {
    expect(canonicalBoardGrade('FBB')).toBe('FBB')
    expect(canonicalBoardGrade('FBB coated')).toBe('FBB')
  })
  it('Saffire → Saffire', () => {
    expect(canonicalBoardGrade('Saffire')).toBe('Saffire')
  })
  it('Duplex → Duplex GB', () => {
    expect(canonicalBoardGrade('Duplex')).toBe('Duplex GB')
  })
  it('legacy paper-type labels map to canonical', () => {
    expect(canonicalBoardGrade('SBS')).toBe('Saffire')
    expect(canonicalBoardGrade('GD2 Grey Back')).toBe('Duplex GB')
    expect(canonicalBoardGrade('Art Card')).toBe('FBB')
    expect(canonicalBoardGrade('DARBI ART CARD')).toBe('FBB')
    expect(canonicalBoardGrade('Kraft')).toBe('Kraft Board')
    expect(canonicalBoardGrade('COLOUR WHITE BACK')).toBe('Duplex WB')
  })
  it('result is always a valid master grade or the preserved raw', () => {
    expect((MASTER_BOARD_GRADES as readonly string[]).includes(canonicalBoardGrade('FBB')!)).toBe(true)
  })
  it('unknown preserved, null passthrough', () => {
    expect(canonicalBoardGrade('CUP STOCK')).toBe('CUP STOCK')
    expect(canonicalBoardGrade(null)).toBeNull()
  })
})

describe('canonicalCoating', () => {
  it('maps the real plant coatings to canonical', () => {
    expect(canonicalCoating('Aqueous Varnish')).toBe('Aqueous Varnish (Gloss)')
    expect(canonicalCoating('Matt Varnish')).toBe('Aqueous Varnish (Matte)')
    expect(canonicalCoating('Full UV')).toBe('Full UV Coating')
    expect(canonicalCoating('Drip off')).toBe('Drip-Off Coating')
    expect(canonicalCoating('Drip off + UV')).toBe('Drip-Off Coating')
    expect(canonicalCoating('Drip off + Metallic')).toBe('Drip-Off Coating')
    expect(canonicalCoating('Plain')).toBe('None')
    expect(canonicalCoating('Gloss Lamination')).toBe('Thermal Lamination (Gloss)')
    expect(canonicalCoating('Matt Lamination')).toBe('Thermal Lamination (Matte)')
  })
  it('case-insensitive', () => {
    expect(canonicalCoating('aqueous varnish')).toBe('Aqueous Varnish (Gloss)')
  })
  it('every mapped value is a valid master coating', () => {
    for (const v of ['Aqueous Varnish', 'Full UV', 'Drip off', 'Plain']) {
      expect(
        (MASTER_COATINGS_AND_VARNISHES as readonly string[]).includes(
          canonicalCoating(v)!,
        ),
      ).toBe(true)
    }
  })
  it('null/blank → null, unknown preserved', () => {
    expect(canonicalCoating(null)).toBeNull()
    expect(canonicalCoating('')).toBeNull()
    expect(canonicalCoating('Some New Coating')).toBe('Some New Coating')
  })
})

describe('canonicalPrintingType', () => {
  it('firm categories → Offset', () => {
    expect(canonicalPrintingType('COLOUR')).toBe('Offset')
    expect(canonicalPrintingType('DARBI')).toBe('Offset')
    expect(canonicalPrintingType('PURE FLIX')).toBe('Offset')
  })
  it('metallic detected', () => {
    expect(canonicalPrintingType('METALLIC')).toBe('Metallic')
  })
  it('null passthrough', () => {
    expect(canonicalPrintingType(null)).toBeNull()
  })
})
