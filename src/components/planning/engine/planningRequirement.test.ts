import { describe, expect, it } from 'vitest'
import { getPlanningRequirement } from './planningRequirement'
import type { PlanningEngineLine } from './types'

describe('getPlanningRequirement', () => {
  it('calculates total sheets as ceil(PO qty / units per sheet) + wastage', () => {
    const line = {
      quantity: 40000,
      specOverrides: { meta: { selectedCutsPerSheet: 2, wastageSheets: 150 } },
    } as unknown as PlanningEngineLine

    expect(getPlanningRequirement(line)).toMatchObject({
      totalPoQty: 40000,
      unitsPerSheet: 2,
      baseSheets: 20000,
      wastageSheets: 150,
      totalRequired: 20150,
    })
  })

  it('prefers engine-selected cut yield over stale product UPS when UPS is auto', () => {
    const line = {
      quantity: 40000,
      upsAndSpec: { ups: 12 },
      specOverrides: {
        meta: {
          selectedCutsPerSheet: 2,
          cutsPerSheet: 2,
          ups: 12,
          upsEdited: false,
          wastageSheets: 150,
        },
      },
    } as unknown as PlanningEngineLine

    expect(getPlanningRequirement(line)).toMatchObject({
      unitsPerSheet: 2,
      baseSheets: 20000,
      totalRequired: 20150,
    })
  })

  it('keeps manually edited UPS as the selected calculation basis', () => {
    const line = {
      quantity: 40000,
      upsAndSpec: { ups: 2 },
      specOverrides: {
        meta: {
          selectedCutsPerSheet: 2,
          ups: 4,
          upsEdited: true,
          wastageSheets: 150,
        },
      },
    } as unknown as PlanningEngineLine

    expect(getPlanningRequirement(line)).toMatchObject({
      unitsPerSheet: 4,
      baseSheets: 10000,
      totalRequired: 10150,
    })
  })
})
