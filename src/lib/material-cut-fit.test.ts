import { describe, it, expect } from 'vitest'
import { buildMaterialCutFitOptions } from './material-cut-fit'

const baseMaterial = {
  materialId: 'm1', materialCode: 'C-1', boardType: 'CYBER', boardClassification: null,
  gsm: 280, availableParentSheets: 9000, reservedParentSheets: 0,
  parentLength: 36, parentWidth: 24,
}

describe('buildMaterialCutFitOptions', () => {
  it('exposes balance fields from geometry', () => {
    const [opt] = buildMaterialCutFitOptions({
      requiredLength: 18, requiredWidth: 12, requiredFinalSheets: 100, requiredGsm: 280,
      config: { allowRotation: true },
      materials: [baseMaterial],
    })
    expect(opt).toBeTruthy()
    expect(opt.balanceSize).toBeDefined()
    expect(typeof opt.balanceReusable).toBe('boolean')
  })

  it('adds make-ready to required parent sheets', () => {
    const [withMr] = buildMaterialCutFitOptions({
      requiredLength: 18, requiredWidth: 12, requiredFinalSheets: 100, requiredGsm: 280,
      makeReadySheets: 50, materials: [baseMaterial],
    })
    const [withoutMr] = buildMaterialCutFitOptions({
      requiredLength: 18, requiredWidth: 12, requiredFinalSheets: 100, requiredGsm: 280,
      makeReadySheets: 0, materials: [baseMaterial],
    })
    expect(withMr.requiredParentSheets).toBe(withoutMr.requiredParentSheets + 50)
  })

  it('direct-size match reports single-cut yield, not multi-up geo yield', () => {
    const [opt] = buildMaterialCutFitOptions({
      requiredLength: 36, requiredWidth: 24, requiredFinalSheets: 100, requiredGsm: 280,
      materials: [{ ...baseMaterial, parentLength: 36, parentWidth: 24 }],
    })
    expect(opt.cutsPerSheet).toBe(1)
    expect(opt.yieldPct).toBe(100)
    expect(opt.balanceSize).toBeNull()
  })

  it('special-cut on a slightly-undersized sheet still yields ~100% (single cut)', () => {
    const [opt] = buildMaterialCutFitOptions({
      requiredLength: 25, requiredWidth: 24, requiredFinalSheets: 100, requiredGsm: 280,
      config: { directSizeTolerancePct: 20 },
      materials: [{ ...baseMaterial, parentLength: 24, parentWidth: 24 }],
    })
    expect(opt).toBeTruthy()
    expect(opt.cutsPerSheet).toBe(1)
    expect(opt.yieldPct).toBe(100)
  })
})
