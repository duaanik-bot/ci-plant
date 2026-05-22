import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { SectionBoardAllocation } from './SectionBoardAllocation'
import type { PlanningEngineLine, PlanningEngineReadiness } from './types'

const baseLine = {
  id: 'L1',
  cartonId: null,
  cartonName: 'Test carton',
  cartonSize: '340×240 mm',
  quantity: 18000,
  artworkCode: null,
  coatingType: null,
  otherCoating: null,
  embossingLeafing: null,
  paperType: 'FBB',
  gsm: 100,
  remarks: null,
  planningStatus: 'planning',
  specOverrides: null,
  po: { id: 'PO1', poNumber: 'PO-2024-0842', poDate: '2026-05-10', customer: { id: 'C1', name: 'Pureflix' } },
  materialQueue: { boardType: 'FBB', sheetLengthMm: 720, sheetWidthMm: 1020, ups: 4 },
} as unknown as PlanningEngineLine

const readinessWithShortage: PlanningEngineReadiness = {
  materialId: 'm1', materialCode: 'ITC-FBB-100',
  boardType: 'FBB', boardClassification: null, size: '720×1020 mm', gsm: 100,
  requiredSheets: 4800, availableSheets: 1240, reservedSheets: 3100,
  incomingSheets: 0, shortageSheets: 3560,
  prId: 'PR-2024-1143', prStatus: 'on_order', grnEta: '2026-05-18',
  status: 'red',
}

describe('SectionBoardAllocation', () => {
  it('renders board, GSM, UPS and the structured sheet/cut fields plus required sheets', () => {
    render(<SectionBoardAllocation line={baseLine} readiness={readinessWithShortage} readinessLoading={false} onPatch={async () => true} />)
    expect(screen.getByLabelText('Board type')).toHaveValue('FBB')
    expect(screen.getByLabelText('GSM')).toHaveValue(100)
    expect(screen.getByLabelText('Units per sheet')).toHaveValue(4)
    // Sheet size is now structured length/width inputs (inches by default).
    expect(screen.getByLabelText('Sheet length (in)')).toBeInTheDocument()
    expect(screen.getByLabelText('Sheet width (in)')).toBeInTheDocument()
    expect(screen.getByLabelText('Cut type')).toBeInTheDocument()
    expect(screen.getAllByText('4,800 sh').length).toBeGreaterThanOrEqual(1)
  })

  it('shows the shortage banner with net/reserved/shortfall when shortageSheets > 0', () => {
    render(<SectionBoardAllocation line={baseLine} readiness={readinessWithShortage} readinessLoading={false} onPatch={async () => true} />)
    expect(screen.getByText(/Paper warehouse — shortage/i)).toBeInTheDocument()
    // Net stock + reserved also appear in the warehouse strip, so match ≥1.
    expect(screen.getAllByText('1,240 sh').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('3,100 sh').length).toBeGreaterThanOrEqual(1)
    // Shortfall only renders in the banner.
    expect(screen.getByText('3,560 sh')).toBeInTheDocument()
  })

  it('renders the PR row with ETA when prId present', () => {
    render(<SectionBoardAllocation line={baseLine} readiness={readinessWithShortage} readinessLoading={false} onPatch={async () => true} />)
    expect(screen.getByText('PR-2024-1143')).toBeInTheDocument()
    expect(screen.getByText(/ETA 18 May/)).toBeInTheDocument()
  })

  it('renders a green stock banner when shortageSheets is zero', () => {
    const noShortage: PlanningEngineReadiness = { ...readinessWithShortage, shortageSheets: 0, prId: null, status: 'green' }
    render(<SectionBoardAllocation line={baseLine} readiness={noShortage} readinessLoading={false} onPatch={async () => true} />)
    expect(screen.queryByText(/Paper warehouse — shortage/i)).toBeNull()
    expect(screen.getByText(/stock covers required sheets/i)).toBeInTheDocument()
  })

  it('shows a loading state while readiness is fetching', () => {
    render(<SectionBoardAllocation line={baseLine} readiness={null} readinessLoading={true} onPatch={async () => true} />)
    expect(screen.getByText(/Checking material…/)).toBeInTheDocument()
  })

  it('renders spec-incomplete warning when specComplete is false', () => {
    const lineWithIncomplete = {
      ...baseLine,
      planningLedger: {
        boardStockInsight: {
          specComplete: false,
          specIncompleteReason: 'Missing UPS in spec pack',
        },
      },
    } as unknown as PlanningEngineLine
    render(<SectionBoardAllocation line={lineWithIncomplete} readiness={null} readinessLoading={false} onPatch={async () => true} />)
    expect(screen.getByText(/missing ups in spec pack/i)).toBeInTheDocument()
  })

  it('shows "reason unavailable" fallback when specComplete is false and specIncompleteReason is null', () => {
    const lineNullReason = {
      ...baseLine,
      planningLedger: {
        boardStockInsight: {
          specComplete: false,
          specIncompleteReason: null,
        },
      },
    } as unknown as PlanningEngineLine
    render(<SectionBoardAllocation line={lineNullReason} readiness={null} readinessLoading={false} onPatch={async () => true} />)
    expect(screen.getByText(/spec incomplete/i)).toBeInTheDocument()
    expect(screen.getByText(/reason unavailable/i)).toBeInTheDocument()
  })

  it('does NOT render spec-incomplete warning for a legacy line without specComplete', () => {
    const legacyLine = {
      ...baseLine,
      planningLedger: {
        boardStockInsight: {
          boardWanted: 'FBB',
          gsmWanted: 100,
          suggestedBoardOptions: [],
          availableMainSheets: 5000,
          availableLeftoverSheets: 0,
          availableTotalSheets: 5000,
          reservedSheets: 0,
          requiredSheets: 4800,
          stockSignal: 'green' as const,
          // specComplete intentionally omitted — legacy shape
        },
      },
    } as unknown as PlanningEngineLine
    render(<SectionBoardAllocation line={legacyLine} readiness={null} readinessLoading={false} onPatch={async () => true} />)
    expect(screen.queryByText(/spec incomplete/i)).toBeNull()
  })

  it('commits an edited board type via onPatch on blur', () => {
    const onPatch = vi.fn().mockResolvedValue(true)
    render(<SectionBoardAllocation line={baseLine} readiness={readinessWithShortage} readinessLoading={false} onPatch={onPatch} />)
    const input = screen.getByLabelText('Board type')
    fireEvent.change(input, { target: { value: 'SBS' } })
    fireEvent.blur(input)
    expect(onPatch).toHaveBeenCalledWith(expect.objectContaining({ paperType: 'SBS' }))
  })

  it('links board type + GSM from the carton master', () => {
    const onPatch = vi.fn().mockResolvedValue(true)
    const lineWithCarton = {
      ...baseLine,
      paperType: null,
      gsm: null,
      materialQueue: null,
      carton: { paperType: 'SBS', gsm: 300 },
    } as unknown as PlanningEngineLine
    render(<SectionBoardAllocation line={lineWithCarton} readiness={null} readinessLoading={false} onPatch={onPatch} />)
    fireEvent.click(screen.getByRole('button', { name: /Carton master/ }))
    expect(onPatch).toHaveBeenCalledWith(expect.objectContaining({ paperType: 'SBS', gsm: 300 }))
  })

  it('offers board-master options that call onSelectBoard', () => {
    const onSelectBoard = vi.fn().mockResolvedValue(undefined)
    const readinessWithOptions: PlanningEngineReadiness = {
      ...readinessWithShortage,
      suggestedBoardOptions: [
        {
          materialId: 'opt1', materialCode: 'ITC-FBB-100', boardType: 'FBB', gsm: 100,
          size: '720×1020', freeSheets: 1240, availableSheets: 1240, requiredParentSheets: 4800,
          shortageParentSheets: 3560, wastagePct: 12, yieldPct: 78, cutsPerSheet: 6,
          matchType: 'Direct Size', status: 'Partial', tags: [], gsmDelta: 0,
        },
      ],
    }
    render(
      <SectionBoardAllocation
        line={baseLine}
        readiness={readinessWithOptions}
        readinessLoading={false}
        onPatch={async () => true}
        onSelectBoard={onSelectBoard}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Board master/ }))
    fireEvent.click(screen.getByText(/FBB · 100 gsm · 720×1020/))
    expect(onSelectBoard).toHaveBeenCalledWith('opt1')
  })

  it('renders procurement suggestion suggestedSheets when shortageSheets > 0 and procurementSuggestion present', () => {
    const lineWithProcurement = {
      ...baseLine,
      planningLedger: {
        boardStockInsight: {
          procurementSuggestion: { boardGrade: 'SBS', gsm: 350, paperType: 'White', suggestedSheets: 1200 },
        },
      },
    } as unknown as PlanningEngineLine
    render(<SectionBoardAllocation line={lineWithProcurement} readiness={readinessWithShortage} readinessLoading={false} onPatch={async () => true} />)
    expect(screen.getByText(/1,200/)).toBeInTheDocument()
  })
})
