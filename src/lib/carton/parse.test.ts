import { describe, it, expect } from 'vitest'
import {
  parseDims,
  parseSheetSize,
  parseColours,
  mapPastingStyle,
  mapBoardType,
  parseRate,
  parseGsm,
} from './parse'

describe('parseDims', () => {
  it('splits LxWxH', () => {
    expect(parseDims('138X50X108')).toEqual({ l: 138, w: 50, h: 108 })
  })
  it('lowercase x and spaces', () => {
    expect(parseDims(' 10 x 10 x 10 ')).toEqual({ l: 10, w: 10, h: 10 })
  })
  it('null/blank → all null', () => {
    expect(parseDims(null)).toEqual({ l: null, w: null, h: null })
    expect(parseDims('')).toEqual({ l: null, w: null, h: null })
  })
  it('two-part is treated as L x W only', () => {
    expect(parseDims('138X50')).toEqual({ l: 138, w: 50, h: null })
  })
})

describe('parseSheetSize', () => {
  it('parses LxW', () => {
    expect(parseSheetSize('138X50')).toEqual({ l: 138, w: 50 })
  })
  it('null → nulls', () => {
    expect(parseSheetSize(null)).toEqual({ l: null, w: null })
  })
})

describe('parseColours', () => {
  it('CMYK → 4', () => expect(parseColours('CMYK')).toBe(4))
  it('CMYKP → 5', () => expect(parseColours('CMYKP')).toBe(5))
  it('blank → null', () => {
    expect(parseColours(null)).toBeNull()
    expect(parseColours('')).toBeNull()
  })
  it('explicit number string', () => expect(parseColours('3')).toBe(3))
})

describe('mapPastingStyle', () => {
  it('maps known values case-insensitively', () => {
    expect(mapPastingStyle('lock bottom')).toBe('LOCK_BOTTOM')
    expect(mapPastingStyle('BSO')).toBe('BSO')
    expect(mapPastingStyle('special')).toBe('SPECIAL')
  })
  it('unknown/blank → null', () => {
    expect(mapPastingStyle(null)).toBeNull()
    expect(mapPastingStyle('straight tuck')).toBeNull()
  })
})

describe('mapBoardType', () => {
  it('Colour/Darbi White → Saffire / Saffire', () => {
    expect(mapBoardType('COLOUR WHITE')).toEqual({ boardGrade: 'Saffire', paperType: 'Saffire' })
    expect(mapBoardType('Darbi White')).toEqual({ boardGrade: 'Saffire', paperType: 'Saffire' })
  })
  it('Colour/Darbi Yellow → FBB / FBB', () => {
    expect(mapBoardType('COLOUR YELLOW')).toEqual({ boardGrade: 'FBB', paperType: 'FBB' })
    expect(mapBoardType('Darbi Yellow')).toEqual({ boardGrade: 'FBB', paperType: 'FBB' })
  })
  it('Colour/Darbi GB → Duplex / GB', () => {
    expect(mapBoardType('COLOUR GB')).toEqual({ boardGrade: 'Duplex', paperType: 'GB' })
    expect(mapBoardType('Darbi GB')).toEqual({ boardGrade: 'Duplex', paperType: 'GB' })
  })
  it('Colour/Darbi WB → Duplex / WB', () => {
    expect(mapBoardType('COLOUR WB')).toEqual({ boardGrade: 'Duplex', paperType: 'WB' })
    expect(mapBoardType('Darbi WB')).toEqual({ boardGrade: 'Duplex', paperType: 'WB' })
  })
  it('FBB Plain → FBB / FBB', () => {
    expect(mapBoardType('FBB PLAIN')).toEqual({ boardGrade: 'FBB', paperType: 'FBB' })
  })
  it('FBB coated → distinct master, no shade', () => {
    expect(mapBoardType('FBB COATED')).toEqual({ boardGrade: 'FBB coated', paperType: null })
  })
  it('unknown → raw kept in boardGrade, no shade', () => {
    expect(mapBoardType('SOME NEW BOARD')).toEqual({
      boardGrade: 'SOME NEW BOARD',
      paperType: null,
    })
  })
  it('blank → both null', () => {
    expect(mapBoardType(null)).toEqual({ boardGrade: null, paperType: null })
    expect(mapBoardType('')).toEqual({ boardGrade: null, paperType: null })
  })
})

describe('parseRate / parseGsm', () => {
  it('parseRate strips currency', () => expect(parseRate('23.20')).toBe(23.2))
  it('parseRate null', () => expect(parseRate(null)).toBeNull())
  it('parseGsm int', () => expect(parseGsm('350')).toBe(350))
  it('parseGsm bad → null', () => expect(parseGsm('abc')).toBeNull())
})
