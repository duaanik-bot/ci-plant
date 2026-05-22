import { describe, expect, it } from 'vitest'
import { type PlanningValidationInput, validatePlanningLine } from '@/lib/planning-validation'

function input(over: Partial<PlanningValidationInput> = {}): PlanningValidationInput {
  return {
    boardType: 'FBB',
    gsm: 300,
    ups: 6,
    sheetLengthMm: 1016,
    sheetWidthMm: 711,
    shortageSheets: 0,
    hasPurchaseRequest: false,
    status: 'Draft',
    ...over,
  }
}

describe('validatePlanningLine', () => {
  it('passes when all mandatory inputs are present', () => {
    const v = validatePlanningLine(input())
    expect(v.missingMandatory).toEqual([])
    expect(v.canCalc).toBe(true)
    expect(v.canLock).toBe(true)
  })

  it('lists each missing mandatory field', () => {
    const v = validatePlanningLine(
      input({ boardType: '', gsm: null, ups: null, sheetLengthMm: 0, sheetWidthMm: null }),
    )
    expect(v.missingMandatory).toEqual(['Board type', 'GSM', 'UPS', 'Sheet length', 'Sheet width'])
    expect(v.canCalc).toBe(false)
    expect(v.canLock).toBe(false)
  })

  it('rejects a non-integer UPS', () => {
    expect(validatePlanningLine(input({ ups: 2.5 })).missingMandatory).toContain('UPS')
  })

  it('blocks Release when a shortage has no PR and is not approved', () => {
    const v = validatePlanningLine(input({ shortageSheets: 400 }))
    expect(v.releaseBlocked).toBe(true)
    expect(v.releaseReason).toMatch(/PR|approval/i)
  })

  it('allows Release once a PR exists', () => {
    expect(validatePlanningLine(input({ shortageSheets: 400, hasPurchaseRequest: true })).releaseBlocked).toBe(false)
  })

  it('allows Release when approved for artwork despite a shortage', () => {
    expect(validatePlanningLine(input({ shortageSheets: 400, status: 'ApprovedAW' })).releaseBlocked).toBe(false)
  })

  it('does not block Release when there is no shortage', () => {
    expect(validatePlanningLine(input({ shortageSheets: 0 })).releaseBlocked).toBe(false)
  })
})
