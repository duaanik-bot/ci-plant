import { render } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { PlanningEngineBody } from './PlanningEngineBody'
import type { PlanningEngineLine, PlanningEngineReadiness } from './types'

const line = {
  id: 'L1',
  cartonId: null,
  cartonName: 'X',
  cartonSize: null,
  quantity: 1000,
  artworkCode: null,
  coatingType: null,
  otherCoating: null,
  embossingLeafing: null,
  paperType: 'FBB',
  gsm: 300,
  remarks: null,
  planningStatus: 'pending',
  specOverrides: null,
  po: { id: 'PO1', poNumber: 'PO1', poDate: '2026-05-10', customer: { id: 'C1', name: 'X' } },
  upsAndSpec: {
    ups: 4,
    upsSource: 'auto',
    sheetYieldPct: 90,
    makeReady: null,
    bpi: null,
  },
  batchDecision: {
    status: 'Draft',
    layoutType: 'Single',
    setNumber: null,
    setNumberAuto: true,
    designerOptions: [],
    designerId: null,
    pressAssignment: null,
    readinessFive: { allReady: false, blockers: [] },
  },
} as unknown as PlanningEngineLine

const readiness = {
  materialId: 'MAT-1',
  materialCode: 'FBB-300-23X36',
  boardType: 'FBB',
  gsm: 300,
  size: '23 x 36',
  requiredSheets: 0,
  availableSheets: 0,
  reservedSheets: 0,
  freeSheets: 0,
  incomingSheets: 0,
  shortageSheets: 0,
  prStatus: 'not_created',
  status: 'grey',
} as unknown as PlanningEngineReadiness

describe('PlanningEngineBody', () => {
  it('renders the five sections in spec order', () => {
    render(
      <PlanningEngineBody
        line={line}
        readiness={readiness}
        readinessLoading={false}
        onPatch={async () => true}
        onLock={async () => {}}
      />,
    )

    const html = document.body.innerHTML

    const posProductRequirement = html.indexOf('PRODUCT / JOB INFO')
    const posSelectedParentSheet = html.indexOf('Selected Parent Sheet')
    const posCutPlan = html.indexOf('CUT PLAN &amp; LAYOUT')
    const posSmartMatch = html.indexOf('SMART MATCH')
    const posWarehouseSnapshot = html.indexOf('Warehouse Snapshot')
    const posWarehouseAvailability = html.indexOf('WAREHOUSE AVAILABILITY')
    const posBatchDecision = html.indexOf('BATCH DECISION')

    expect(posProductRequirement).toBeGreaterThan(-1)
    expect(html.indexOf('BOARD ALLOCATION')).toBe(-1)
    expect(posSelectedParentSheet).toBeGreaterThan(-1)
    expect(posCutPlan).toBeGreaterThan(-1)
    expect(posWarehouseAvailability).toBeGreaterThan(-1)
    expect(posSmartMatch).toBeGreaterThan(-1)
    expect(posWarehouseSnapshot).toBeGreaterThan(-1)
    expect(posBatchDecision).toBeGreaterThan(-1)

    // Order: Product Header → Parent Sheet → Cut Plan → Warehouse → Batch.
    // The detailed BOARD ALLOCATION controls are hidden once a parent sheet is active.
    expect(posProductRequirement).toBeLessThan(posSelectedParentSheet)
    expect(posSelectedParentSheet).toBeLessThan(posCutPlan)
    expect(posCutPlan).toBeLessThan(posWarehouseAvailability)
    expect(posWarehouseAvailability).toBeLessThan(posBatchDecision)
  })
})
