import { describe, it, expect } from 'vitest'
import { computeCutGeometry } from './sheet-cut-geometry'

describe('computeCutGeometry', () => {
  it('perfect fit, no allowances → 100% yield, no balance', () => {
    const g = computeCutGeometry({
      parentLength: 36, parentWidth: 24, reqLength: 18, reqWidth: 12,
      allowances: { gripper: 0, edgeTrim: 0, gutter: 0 },
    })
    expect(g.cutsPerSheet).toBe(4)
    expect(g.orientation).toBe('LxW')
    expect(g.yieldPct).toBe(100)
    expect(g.wastePct).toBe(0)
    expect(g.balanceSize).toBeNull()
    expect(g.balanceReusable).toBe(false)
  })

  it('gripper lowers yield but a reusable balance is excluded from waste', () => {
    const g = computeCutGeometry({
      parentLength: 36, parentWidth: 24, reqLength: 18, reqWidth: 12,
      allowances: { gripper: 0.5, edgeTrim: 0, gutter: 0 },
    })
    expect(g.cutsPerSheet).toBe(2)
    expect(g.yieldPct).toBe(50)
    expect(g.balanceReusable).toBe(true)
    expect(g.balanceSize).toBe('24 x 17.5')
    expect(g.wastePct).toBe(1.39) // (864-432-420)/864*100
  })

  it('a thin sliver is NOT reusable and counts as waste', () => {
    const g = computeCutGeometry({
      parentLength: 38, parentWidth: 25, reqLength: 18, reqWidth: 12,
      allowances: { gripper: 0, edgeTrim: 0, gutter: 0 },
    })
    expect(g.cutsPerSheet).toBe(4)
    expect(g.yieldPct).toBe(90.95)
    expect(g.balanceSize).toBe('25 x 2')
    expect(g.balanceReusable).toBe(false)
    expect(g.wastePct).toBe(9.05)
  })

  it('no fit → zero geometry', () => {
    const g = computeCutGeometry({ parentLength: 10, parentWidth: 10, reqLength: 12, reqWidth: 12 })
    expect(g.cutsPerSheet).toBe(0)
    expect(g.balanceSize).toBeNull()
  })

  it('gripper larger than parent → zero geometry', () => {
    const g = computeCutGeometry({
      parentLength: 0.4, parentWidth: 10, reqLength: 0.2, reqWidth: 0.2,
      allowances: { gripper: 0.5, edgeTrim: 0, gutter: 0 },
    })
    expect(g.cutsPerSheet).toBe(0)
  })

  it('picks the rotated orientation when it yields more cuts', () => {
    const g = computeCutGeometry({
      parentLength: 24, parentWidth: 36, reqLength: 36, reqWidth: 10,
      allowances: { gripper: 0, edgeTrim: 0, gutter: 0 },
    })
    expect(g.orientation).toBe('WxL')
    expect(g.cutsPerSheet).toBe(2)
    expect(g.yieldPct).toBe(83.33)
    expect(g.balanceSize).toBe('36 x 4')
    expect(g.balanceReusable).toBe(false)
    expect(g.wastePct).toBe(16.67)
  })

  it('accounts for a gutter between ups', () => {
    const g = computeCutGeometry({
      parentLength: 36, parentWidth: 24, reqLength: 10, reqWidth: 10,
      allowances: { gripper: 0, edgeTrim: 0, gutter: 1 },
    })
    expect(g.cutsPerSheet).toBe(6)
    expect(g.orientation).toBe('LxW')
    expect(g.yieldPct).toBe(69.44)
    expect(g.balanceSize).toBe('36 x 3')
    expect(g.balanceReusable).toBe(false)
    expect(g.wastePct).toBe(30.56)
  })
})
