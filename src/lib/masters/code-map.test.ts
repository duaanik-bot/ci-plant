import { describe, it, expect } from 'vitest'
import { normalizeCode, LEGACY_UNIT_CODE, legacyToCode } from './code-map'

describe('normalizeCode', () => {
  it('uppercases and snake-cases', () => {
    expect(normalizeCode('Board Type')).toBe('BOARD_TYPE')
    expect(normalizeCode('  duplex-gb ')).toBe('DUPLEX_GB')
    expect(normalizeCode('NOS')).toBe('NOS')
  })
  it('strips unsafe chars', () => {
    expect(normalizeCode('Kraft (brown)!')).toBe('KRAFT_BROWN')
  })
})

describe('legacy unit mapping', () => {
  it('maps known legacy stored unit labels to codes', () => {
    expect(LEGACY_UNIT_CODE['sheets']).toBe('SHT')
    expect(LEGACY_UNIT_CODE['kg']).toBe('KG')
    expect(LEGACY_UNIT_CODE['Pcs']).toBe('NOS')
    expect(LEGACY_UNIT_CODE['cartons']).toBe('CTN')
  })
  it('legacyToCode falls back to normalizeCode for unknowns', () => {
    expect(legacyToCode('sheets')).toBe('SHT')
    expect(legacyToCode('weird-unit')).toBe('WEIRD_UNIT')
  })
})
