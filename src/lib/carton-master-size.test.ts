import { describe, it, expect } from 'vitest'
import {
  cartonMasterSizeLabel,
  dieMasterDimsLabel,
  sizeFromFinishedDims,
} from './die-hub-dimensions'

describe('sizeFromFinishedDims', () => {
  it('formats 3D finished dims as L×W×H', () => {
    expect(sizeFromFinishedDims({ finishedLength: 80, finishedWidth: 18, finishedHeight: 79 })).toBe(
      '80×18×79',
    )
  })

  it('formats 2D finished dims (no height) as L×W', () => {
    expect(sizeFromFinishedDims({ finishedLength: 160, finishedWidth: 200, finishedHeight: null })).toBe(
      '160×200',
    )
  })

  it('returns empty string when no usable dims', () => {
    expect(sizeFromFinishedDims({ finishedLength: null, finishedWidth: null, finishedHeight: null })).toBe('')
  })
})

describe('dieMasterDimsLabel', () => {
  it('prefers DB dimension columns', () => {
    expect(
      dieMasterDimsLabel({ dimLengthMm: 80, dimWidthMm: 18, dimHeightMm: 79, cartonSize: 'ignored' }),
    ).toBe('80×18×79')
  })

  it('falls back to parsing the cartonSize text when DB dims are absent', () => {
    expect(
      dieMasterDimsLabel({ dimLengthMm: null, dimWidthMm: null, dimHeightMm: null, cartonSize: '80x18x79' }),
    ).toBe('80×18×79')
  })

  it('returns empty for a null die', () => {
    expect(dieMasterDimsLabel(null)).toBe('')
  })
})

describe('cartonMasterSizeLabel', () => {
  const carton = { finishedLength: 100, finishedWidth: 60, finishedHeight: 40 }

  it('uses die-master dims over the carton finished dims', () => {
    const die = { dimLengthMm: 80, dimWidthMm: 18, dimHeightMm: 79, cartonSize: '' }
    expect(cartonMasterSizeLabel(carton, die)).toBe('80×18×79')
  })

  it('falls back to carton finished dims when there is no die', () => {
    expect(cartonMasterSizeLabel(carton, null)).toBe('100×60×40')
  })

  it('falls back to finished dims when the die has no usable dims', () => {
    const die = { dimLengthMm: null, dimWidthMm: null, dimHeightMm: null, cartonSize: '' }
    expect(cartonMasterSizeLabel(carton, die)).toBe('100×60×40')
  })

  it('returns empty when neither source has dims', () => {
    expect(
      cartonMasterSizeLabel({ finishedLength: null, finishedWidth: null, finishedHeight: null }, null),
    ).toBe('')
  })
})
