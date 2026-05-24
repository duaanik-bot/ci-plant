import { describe, it, expect } from 'vitest'
import { buildEngineLine } from './buildEngineLine'
import type { PlanningGridLine } from '@/components/planning/PlanningDecisionGrid'
import type { PlanningEngineReadiness, PlanningEngineLine } from './types'

const gridLine = {
  id: 'L1', cartonId: 'C1', cartonName: 'Pizza Box 12in', cartonSize: '300x300x40',
  quantity: 20000, artworkCode: 'AW-991', coatingType: 'Gloss', otherCoating: null,
  embossingLeafing: null, paperType: 'FBB', gsm: 300, remarks: null,
  planningStatus: 'pending',
  specOverrides: {
    planningMaterialId: 'MAT-1',
    meta: { ups: 4, parentSize: '760x1020', cutsPerSheet: 2 },
    planningCore: { status: 'Ready', layoutType: 'gang', setNumber: 'SET-007' },
  },
  po: { id: 'PO1', poNumber: 'PO-555', poDate: '2026-05-01', customer: { id: 'CU1', name: 'Domino' } },
} as unknown as PlanningGridLine

const readiness = {
  materialId: 'MAT-1', materialCode: 'FBB-300-760x1020', boardType: 'FBB', boardClassification: null,
  size: '760x1020', gsm: 300, requiredSheets: 5150, availableSheets: 6000, reservedSheets: 0,
  freeSheets: 6000, incomingSheets: 0, shortageSheets: 0, prStatus: 'not_created', grnEta: null,
  status: 'green',
  suggestedBoardOptions: [
    { materialId: 'MAT-1', materialCode: 'FBB-300-760x1020', boardType: 'FBB', gsm: 300, size: '760x1020',
      freeSheets: 6000, availableSheets: 6000, requiredParentSheets: 2575, shortageParentSheets: 0,
      wastagePct: 8, yieldPct: 92, cutsPerSheet: 2, matchType: 'Direct Size', status: 'Ready',
      tags: ['Best Yield'], gsmDelta: 0 },
  ],
  closestAvailableOptions: [],
} as unknown as PlanningEngineReadiness

describe('buildEngineLine', () => {
  it('populates upsAndSpec.ups from spec meta', () => {
    const out = buildEngineLine(gridLine, readiness, {})
    expect(out.upsAndSpec?.ups).toBe(4)
  })

  it('populates batchDecision from planningCore', () => {
    const out = buildEngineLine(gridLine, readiness, {})
    expect(out.batchDecision?.status).toBe('Ready')
    expect(out.batchDecision?.layoutType).toBe('Gang')
    expect(out.batchDecision?.setNumber).toBe('SET-007')
  })

  it('enables lock when all gates pass (material selected, no shortage)', () => {
    const out = buildEngineLine(gridLine, readiness, {})
    expect(out.batchDecision?.readinessFive?.allReady).toBe(true)
  })

  it('blocks lock when no material selected', () => {
    const noMat = { ...gridLine, specOverrides: { ...(gridLine.specOverrides as object), planningMaterialId: null } } as unknown as PlanningGridLine
    const out = buildEngineLine(noMat, { ...readiness, materialId: null }, {})
    expect(out.batchDecision?.readinessFive?.allReady).toBe(false)
    expect(out.batchDecision?.readinessFive?.blockers).toContain('No board allocated')
  })

  it('passes through designer + press options from extras', () => {
    const out = buildEngineLine(gridLine, readiness, {
      designerOptions: [{ id: 'd1', name: 'Avneet' }],
      pressAssignment: { code: 'CI-02', deckLabel: '6-col', size: '1020x760', loadPct: 40, runHours: 5, smartPicked: true },
    })
    expect(out.batchDecision?.designerOptions).toHaveLength(1)
    expect(out.batchDecision?.pressAssignment?.code).toBe('CI-02')
  })

  it('sets smartMatch confidence from the top board option fit', () => {
    const out = buildEngineLine(gridLine, readiness, {})
    expect(out.smartMatch?.materialCode).toBe('FBB-300-760x1020')
    expect(out.smartMatch?.suggestions).toEqual([])
  })

  it('populates sheetSpec from meta + readiness child size', () => {
    const line = {
      ...gridLine,
      specOverrides: { ...(gridLine.specOverrides as object), meta: { ups: 4, parentSize: '760x1020', cutsPerSheet: 2, sheetLengthMm: 760, sheetWidthMm: 1020, sheetUnit: 'mm', cutType: 2 } },
    } as unknown as PlanningGridLine
    const r = { ...readiness, requiredFinalSize: '300x400' } as unknown as PlanningEngineReadiness
    const out = buildEngineLine(line, r, {})
    expect(out.sheetSpec?.lengthMm).toBe(760)
    expect(out.sheetSpec?.widthMm).toBe(1020)
    expect(out.sheetSpec?.cutType).toBe(2)
    expect(out.sheetSpec?.childSize).toBe('300x400')
  })

  it('populates make-ready, expected yield and balance', () => {
    const line = {
      ...gridLine,
      specOverrides: { ...(gridLine.specOverrides as object), meta: { ups: 4, parentSize: '760x1020', makeReadySheets: 200 } },
    } as unknown as PlanningGridLine
    // readiness: freeSheets 6000, requiredSheets 5150, ups 4
    const out = buildEngineLine(line, readiness, {})
    expect(out.upsAndSpec?.makeReady?.total).toBe(200)
    expect(out.upsAndSpec?.expectedYieldUnits).toBe(6000 * 4) // allocated(free) × ups
    expect(out.upsAndSpec?.balanceAfterAllocation).toBe(6000 - 5150)
  })
})
