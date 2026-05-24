import { describe, it, expect } from 'vitest'
import { readPlanningMeta, mergePlanningMetaSheetSpec } from './planning-decision-spec'

describe('sheet spec meta', () => {
  it('round-trips length/width/unit/cutType', () => {
    const spec = mergePlanningMetaSheetSpec({}, { lengthMm: 760, widthMm: 1020, unit: 'mm', cutType: 2 })
    const meta = readPlanningMeta(spec)
    expect(meta.sheetLengthMm).toBe(760)
    expect(meta.sheetWidthMm).toBe(1020)
    expect(meta.sheetUnit).toBe('mm')
    expect(meta.cutType).toBe(2)
  })

  it('keeps parentSize string in sync when both dims provided', () => {
    const spec = mergePlanningMetaSheetSpec({}, { lengthMm: 500, widthMm: 700 })
    expect(readPlanningMeta(spec).parentSize).toBe('500x700')
  })

  it('only patches provided keys (undefined left untouched)', () => {
    const spec = mergePlanningMetaSheetSpec({ meta: { sheetUnit: 'inch', cutType: 3 } }, { lengthMm: 100 })
    const meta = readPlanningMeta(spec)
    expect(meta.sheetLengthMm).toBe(100)
    expect(meta.sheetUnit).toBe('inch')
    expect(meta.cutType).toBe(3)
  })

  it('persists makeReadySheets when provided', () => {
    const spec = mergePlanningMetaSheetSpec({}, { makeReadySheets: 200 })
    expect(readPlanningMeta(spec).makeReadySheets).toBe(200)
  })
})
