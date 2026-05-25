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
  materialId: null,
  materialCode: null,
  boardType: 'FBB',
  gsm: 300,
  size: null,
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

    const posProductRequirement = html.indexOf('PRODUCT REQUIREMENT')
    const posBoardAllocation = html.indexOf('BOARD ALLOCATION')
    const posWarehouseAvailability = html.indexOf('WAREHOUSE AVAILABILITY')
    const posSmartMatch = html.indexOf('SMART MATCH')
    const posSheetMetrics = html.indexOf('SHEET METRICS')

    expect(posProductRequirement).toBeGreaterThan(-1)
    expect(posBoardAllocation).toBeGreaterThan(-1)
    expect(posWarehouseAvailability).toBeGreaterThan(-1)
    expect(posSmartMatch).toBeGreaterThan(-1)
    expect(posSheetMetrics).toBeGreaterThan(-1)

    // Order: Product Requirement → Board Allocation → Smart Match → Warehouse Availability → Sheet Metrics
    expect(posProductRequirement).toBeLessThan(posBoardAllocation)
    expect(posBoardAllocation).toBeLessThan(posSmartMatch)
    expect(posSmartMatch).toBeLessThan(posWarehouseAvailability)
    expect(posWarehouseAvailability).toBeLessThan(posSheetMetrics)
  })
})
