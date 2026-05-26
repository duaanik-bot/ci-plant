import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SectionCutPlanBalance } from './SectionCutPlanBalance'
import type { PlanningEngineLine, PlanningEngineReadiness } from './types'

const baseLine = {
  id: 'L1',
  cartonName: 'Test carton',
  quantity: 8500,
  specOverrides: {
    meta: {
      cuttingDirection: 'length',
      cutPlanChildSizes: [
        { lMm: 12 * 25.4, wMm: 23 * 25.4, qty: 16 },
        { lMm: 10 * 25.4, wMm: 23 * 25.4, qty: 1 },
      ],
      makeReadySheets: 0,
      wastageSheets: 150,
    },
  },
  po: { poNumber: 'PO1', customer: { name: 'Customer' } },
} as unknown as PlanningEngineLine

const readiness = {
  materialId: 'MAT-1',
  materialCode: 'MAT-1',
  boardType: 'Duplex GB',
  gsm: 350,
  size: '16 x 26',
} as unknown as PlanningEngineReadiness

describe('SectionCutPlanBalance', () => {
  it('invalidates impossible child quantities instead of showing impossible utilization', () => {
    render(
      <SectionCutPlanBalance
        line={baseLine}
        readiness={readiness}
        onPatch={async () => true}
      />,
    )

    expect(screen.getAllByText(/Invalid/i).length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toContain('1117')
  })
})
