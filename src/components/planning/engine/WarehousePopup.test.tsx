import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WarehousePopup } from './WarehousePopup'
import type { PlanningEngineReadiness } from './types'

// ─── Mock data ───────────────────────────────────────────────────────────────
const MOCK_ROWS = [
  {
    material_id: 'mat-001',
    material_code: 'ITC-FBB-300',
    board_type_id: 'FBB',
    board_classification_id: 'Premium',
    gsm: 300,
    size_display: '760 x 1020',
    available_sheets: 8000,
    reserved_sheets: 2000,
    incoming_sheets: 0,
    shortage_sheets: 0,
    status: 'available',
    est_value_inr: 160000,
    age_days: 10,
    ageing_risk: 'low',
    daysOfCover: 30,
  },
  {
    material_id: 'mat-002',
    material_code: 'SBS-250-STD',
    board_type_id: 'SBS',
    board_classification_id: 'Standard',
    gsm: 250,
    size_display: '720 x 1020',
    available_sheets: 3000,
    reserved_sheets: 3000,
    incoming_sheets: 500,
    shortage_sheets: 0,
    status: 'reserved',
    est_value_inr: 90000,
    age_days: 45,
    ageing_risk: 'medium',
    daysOfCover: null,
  },
  {
    material_id: 'mat-003',
    material_code: 'FBB-310-A',
    board_type_id: 'FBB',
    board_classification_id: null,
    gsm: 310,
    size_display: '800 x 1100',
    available_sheets: 0,
    reserved_sheets: 0,
    incoming_sheets: 1000,
    shortage_sheets: 0,
    status: 'incoming',
    est_value_inr: 0,
    age_days: 5,
    ageing_risk: 'low',
    daysOfCover: null,
  },
]

const MOCK_RESPONSE = {
  rows: MOCK_ROWS,
  kpi: {
    totalPhysical: 17500,
    available: 11000,
    reserved: 5000,
    incoming: 1500,
    shortage: 0,
    value: 250000,
    freeStock: 6000,
    incomingRequiredMismatch: 0,
  },
}

// ─── Readiness with one suggested board option ───────────────────────────────
const readiness: PlanningEngineReadiness = {
  materialId: 'mat-001',
  materialCode: 'ITC-FBB-300',
  boardType: 'FBB',
  boardClassification: null,
  size: '760x1020',
  gsm: 300,
  requiredSheets: 5000,
  availableSheets: 8000,
  reservedSheets: 2000,
  freeSheets: 6000,
  incomingSheets: 0,
  shortageSheets: 0,
  prStatus: 'not_created',
  grnEta: null,
  status: 'green',
  suggestedBoardOptions: [
    {
      materialId: 'mat-001',
      materialCode: 'ITC-FBB-300',
      boardType: 'FBB',
      gsm: 300,
      size: '760x1020',
      freeSheets: 6000,
      availableSheets: 8000,
      requiredParentSheets: 5000,
      shortageParentSheets: 0,
      wastagePct: 12,
      yieldPct: 88,
      cutsPerSheet: 4,
      matchType: 'exact',
      status: 'Ready',
      tags: [],
      gsmDelta: 0,
      matchScorePct: 95,
      reason: null,
    },
  ],
}

// ─── Setup ───────────────────────────────────────────────────────────────────
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => MOCK_RESPONSE,
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ─── Tests ───────────────────────────────────────────────────────────────────
describe('WarehousePopup', () => {
  it('renders all five tab buttons', async () => {
    render(
      <WarehousePopup
        open
        onClose={() => {}}
        lineBoardType="FBB"
        lineGsm={300}
        readiness={readiness}
      />,
    )

    expect(screen.getByRole('button', { name: 'Full stock' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Filtered matching' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Suggested only' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reserved' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Free' })).toBeInTheDocument()
  })

  it('shows a known material code after the fetch resolves', async () => {
    render(
      <WarehousePopup
        open
        onClose={() => {}}
        lineBoardType="FBB"
        lineGsm={300}
        readiness={readiness}
      />,
    )

    // Wait for fetch to resolve and material code to appear
    const cell = await screen.findByText('ITC-FBB-300')
    expect(cell).toBeInTheDocument()
  })

  it('switches to Suggested only tab and shows the suggested material code', async () => {
    render(
      <WarehousePopup
        open
        onClose={() => {}}
        lineBoardType="FBB"
        lineGsm={300}
        readiness={readiness}
      />,
    )

    // Wait for data
    await screen.findByText('ITC-FBB-300')

    // Switch to Suggested only
    fireEvent.click(screen.getByRole('button', { name: 'Suggested only' }))

    // The suggested material should still be visible
    expect(screen.getByText('ITC-FBB-300')).toBeInTheDocument()
    // The non-suggested material should not appear
    expect(screen.queryByText('SBS-250-STD')).not.toBeInTheDocument()
  })

  it('switches to Filtered matching tab and narrows by boardType + gsm', async () => {
    render(
      <WarehousePopup
        open
        onClose={() => {}}
        lineBoardType="FBB"
        lineGsm={300}
        readiness={readiness}
        gsmTolerance={10}
      />,
    )

    // Wait for data
    await screen.findByText('ITC-FBB-300')

    // Switch to Filtered matching — FBB + 300 ±10 → matches mat-001 (FBB/300) and mat-003 (FBB/310)
    fireEvent.click(screen.getByRole('button', { name: 'Filtered matching' }))

    // SBS-250-STD is board type SBS — should not appear
    expect(screen.queryByText('SBS-250-STD')).not.toBeInTheDocument()
    // ITC-FBB-300 matches exactly
    expect(screen.getByText('ITC-FBB-300')).toBeInTheDocument()
  })

  it('shows reserved tab only with rows that have reserved_sheets > 0', async () => {
    render(
      <WarehousePopup
        open
        onClose={() => {}}
        readiness={readiness}
      />,
    )

    await screen.findByText('ITC-FBB-300')

    fireEvent.click(screen.getByRole('button', { name: 'Reserved' }))

    // mat-001 has 2000 reserved, mat-002 has 3000 reserved — both should appear
    expect(screen.getByText('ITC-FBB-300')).toBeInTheDocument()
    expect(screen.getByText('SBS-250-STD')).toBeInTheDocument()
    // mat-003 has 0 reserved — should not appear
    expect(screen.queryByText('FBB-310-A')).not.toBeInTheDocument()
  })

  it('shows free tab only with rows that have free stock > 0', async () => {
    render(
      <WarehousePopup
        open
        onClose={() => {}}
        readiness={readiness}
      />,
    )

    await screen.findByText('ITC-FBB-300')

    fireEvent.click(screen.getByRole('button', { name: 'Free' }))

    // mat-001: 8000 - 2000 = 6000 free — should appear
    expect(screen.getByText('ITC-FBB-300')).toBeInTheDocument()
    // mat-002: 3000 - 3000 = 0 free — should not appear
    expect(screen.queryByText('SBS-250-STD')).not.toBeInTheDocument()
    // mat-003: 0 - 0 = 0 free — should not appear
    expect(screen.queryByText('FBB-310-A')).not.toBeInTheDocument()
  })

  it('does not render children when closed', () => {
    render(
      <WarehousePopup
        open={false}
        onClose={() => {}}
        readiness={readiness}
      />,
    )

    expect(screen.queryByRole('button', { name: 'Full stock' })).not.toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('handles empty suggestedBoardOptions gracefully', async () => {
    const noSuggestions: PlanningEngineReadiness = { ...readiness, suggestedBoardOptions: [] }
    render(
      <WarehousePopup
        open
        onClose={() => {}}
        readiness={noSuggestions}
      />,
    )

    await screen.findByText('ITC-FBB-300')

    fireEvent.click(screen.getByRole('button', { name: 'Suggested only' }))

    expect(screen.getByText('No rows to display.')).toBeInTheDocument()
  })
})
