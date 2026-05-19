import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
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
  it('renders board, GSM, sheet size and required sheets', () => {
    render(<SectionBoardAllocation line={baseLine} readiness={readinessWithShortage} readinessLoading={false} onPatch={async () => true} />)
    expect(screen.getByText('FBB')).toBeInTheDocument()
    expect(screen.getByText('100 gsm')).toBeInTheDocument()
    expect(screen.getByText('720×1020 mm')).toBeInTheDocument()
    expect(screen.getByText('4,800 sh')).toBeInTheDocument()
  })

  it('shows the shortage banner with net/reserved/shortfall when shortageSheets > 0', () => {
    render(<SectionBoardAllocation line={baseLine} readiness={readinessWithShortage} readinessLoading={false} onPatch={async () => true} />)
    expect(screen.getByText(/Paper warehouse — shortage/i)).toBeInTheDocument()
    expect(screen.getByText('1,240 sh')).toBeInTheDocument()
    expect(screen.getByText('3,100 sh')).toBeInTheDocument()
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
