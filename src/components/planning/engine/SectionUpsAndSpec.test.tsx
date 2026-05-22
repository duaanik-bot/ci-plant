import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { SectionUpsAndSpec } from './SectionUpsAndSpec'
import type { PlanningEngineLine } from './types'

const baseLine = {
  id: 'L1',
  cartonId: null,
  cartonName: 'Test',
  cartonSize: null,
  quantity: 18000,
  artworkCode: null, coatingType: null, otherCoating: null, embossingLeafing: null,
  paperType: null, gsm: null, remarks: null, planningStatus: 'planning', specOverrides: null,
  po: { id: 'PO1', poNumber: 'PO1', poDate: '2026-05-10', customer: { id: 'C1', name: 'X' } },
  materialQueue: { ups: 4 },
  planningLedger: { boardStockInsight: { requiredSheets: 4800 } },
  upsAndSpec: {
    ups: 4,
    upsSource: 'auto' as const,
    sheetYieldPct: 74.3,
    makeReady: { total: 180, base: 50, colours: { count: 4, perColour: 20 }, uv: 30 },
    bpi: { status: 'Optimal' as const, marginInr: 36000, setupInr: 25800 },
  },
} as unknown as PlanningEngineLine

describe('SectionUpsAndSpec', () => {
  it('shows UPS read-only (edited in Board Allocation) and sheet yield', () => {
    render(<SectionUpsAndSpec line={baseLine} onPatch={async () => true} />)
    // UPS is now a read-only metric here — the editable input lives in Board Allocation.
    expect(screen.getByText('Units per sheet')).toBeInTheDocument()
    expect(screen.getByText('Edit in Board Allocation')).toBeInTheDocument()
    expect(screen.getByText('74.3%')).toBeInTheDocument()
  })

  it('renders make-ready total + breakdown', () => {
    render(<SectionUpsAndSpec line={baseLine} onPatch={async () => true} />)
    expect(screen.getByText('180 sh')).toBeInTheDocument()
    expect(screen.getByText(/50 base \+ 4×20c \+ 30 UV/)).toBeInTheDocument()
  })

  it('renders BPI status + margin vs setup hint', () => {
    render(<SectionUpsAndSpec line={baseLine} onPatch={async () => true} />)
    expect(screen.getByText('Optimal')).toBeInTheDocument()
    expect(screen.getByText(/₹36,000 margin vs ₹25,800 setup/)).toBeInTheDocument()
  })
})
