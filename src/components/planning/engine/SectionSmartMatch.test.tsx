import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { SectionSmartMatch } from './SectionSmartMatch'
import type { PlanningEngineBoardOption, PlanningEngineLine, PlanningEngineReadiness } from './types'

function boardOption(over: Partial<PlanningEngineBoardOption>): PlanningEngineBoardOption {
  return {
    materialId: 'opt1',
    materialCode: 'P-23x36',
    boardType: 'Duplex GB',
    boardClassification: null,
    gsm: 350,
    size: '23 x 36',
    freeSheets: 5000,
    availableSheets: 5000,
    reservedSheets: 0,
    requiredParentSheets: 0,
    shortageParentSheets: 0,
    wastagePct: 0,
    yieldPct: 0,
    cutsPerSheet: 0,
    orientation: 'LxW',
    matchType: 'Cut Fit',
    status: 'Ready',
    tags: [],
    gsmDelta: 0,
    ...over,
  }
}

const readiness: PlanningEngineReadiness = {
  materialId: 'opt1',
  materialCode: 'P-23x36',
  boardType: 'Duplex GB',
  boardClassification: null,
  size: '23 x 36',
  gsm: 350,
  requiredSheets: 1000,
  availableSheets: 5000,
  reservedSheets: 0,
  incomingSheets: 0,
  shortageSheets: 0,
  prStatus: 'not_created',
  grnEta: null,
  suggestedBoardOptions: [
    boardOption({ materialId: 'opt1', materialCode: 'P-23x36', size: '23 x 36' }),
    boardOption({ materialId: 'opt2', materialCode: 'P-24x36', size: '24 x 36' }),
    boardOption({ materialId: 'opt3', materialCode: 'P-20x30', size: '20 x 30' }),
  ],
}

const baseLine = {
  id: 'L1',
  cartonId: null,
  cartonName: 'X',
  cartonSize: '12x23',
  quantity: 1000,
  artworkCode: null,
  coatingType: null,
  otherCoating: null,
  embossingLeafing: null,
  paperType: null,
  gsm: null,
  remarks: null,
  planningStatus: 'planning',
  specOverrides: null,
  po: { id: 'PO1', poNumber: 'PO1', poDate: '2026-05-10', customer: { id: 'C1', name: 'X' } },
} as unknown as PlanningEngineLine

describe('SectionSmartMatch', () => {
  it('renders warehouse parent-sheet matches with a business label, not "Suggestion #N"', () => {
    render(<SectionSmartMatch line={baseLine} readiness={readiness} onPatch={async () => true} />)
    // Default cut type is 1-cut; bump to 2-cut to match the spec example.
    fireEvent.change(screen.getByLabelText('Cut type'), { target: { value: '2' } })
    expect(screen.getByText(/Best Parent Sheet/)).toBeInTheDocument()
    expect(screen.queryByText(/Suggestion #/)).not.toBeInTheDocument()
    // The 23×36 parent ranks first.
    expect(screen.getByText(/#1 · 23 × 36 in/)).toBeInTheDocument()
  })

  it('rejects parents that cannot produce the child under the cut type (20×30)', () => {
    render(<SectionSmartMatch line={baseLine} readiness={readiness} onPatch={async () => true} />)
    fireEvent.change(screen.getByLabelText('Cut type'), { target: { value: '2' } })
    expect(screen.queryByText(/20 × 30/)).not.toBeInTheDocument()
  })

  it('shows the no-match empty state with actions when the child cannot be cut', () => {
    const line = { ...baseLine, cartonSize: '99x99' } as unknown as PlanningEngineLine
    render(<SectionSmartMatch line={line} readiness={readiness} onPatch={async () => true} />)
    fireEvent.change(screen.getByLabelText('Cut type'), { target: { value: '2' } })
    expect(screen.getByText(/No matching parent sheet available/i)).toBeInTheDocument()
    expect(screen.getByText(/Raise Purchase Request/i)).toBeInTheDocument()
    expect(screen.getByText(/Try a different cut type/i)).toBeInTheDocument()
  })

  it('blocks with a Board Allocation prompt when no child size is resolvable', () => {
    const line = { ...baseLine, cartonSize: null } as unknown as PlanningEngineLine
    render(<SectionSmartMatch line={line} readiness={readiness} onPatch={async () => true} />)
    expect(screen.getByText(/Set the carton size in Board Allocation/i)).toBeInTheDocument()
  })

  it('pre-fills an editable Parent field from the child size and cut count', () => {
    const line = { ...baseLine, cartonSize: '18x23' } as unknown as PlanningEngineLine
    render(<SectionSmartMatch line={line} readiness={readiness} onPatch={async () => true} />)
    fireEvent.change(screen.getByLabelText('Cut type'), { target: { value: '2' } })
    const parentL = screen.getByLabelText('Parent L') as HTMLInputElement
    const parentW = screen.getByLabelText('Parent W') as HTMLInputElement
    expect(parentL.value).toBe('23')
    expect(parentW.value).toBe('36')
    expect(screen.getByText(/Child 18 × 23/i)).toBeInTheDocument()
  })

  it('shows spec-incomplete empty state when the spec pack is missing fields', () => {
    const line = {
      ...baseLine,
      planningLedger: {
        boardStockInsight: { specComplete: false, specIncompleteReason: 'Missing UPS in spec pack' },
      },
    } as unknown as PlanningEngineLine
    render(<SectionSmartMatch line={line} readiness={readiness} onPatch={async () => true} />)
    expect(screen.getByText(/Spec incomplete/i)).toBeInTheDocument()
    expect(screen.getByText(/Missing UPS in spec pack/i)).toBeInTheDocument()
  })

  it('shows no-board empty state when nothing is linked and pool is empty', () => {
    const empty: PlanningEngineReadiness = {
      ...readiness,
      materialId: null,
      materialCode: null,
      suggestedBoardOptions: [],
      closestAvailableOptions: [],
    }
    render(<SectionSmartMatch line={baseLine} readiness={empty} onPatch={async () => true} />)
    expect(screen.getByText(/No board linked/i)).toBeInTheDocument()
  })

  it('calls onSelectBoard when the Select button is clicked', () => {
    const onSelectBoard = vi.fn().mockResolvedValue(undefined)
    render(
      <SectionSmartMatch
        line={baseLine}
        readiness={readiness}
        onPatch={async () => true}
        onSelectBoard={onSelectBoard}
      />,
    )
    fireEvent.change(screen.getByLabelText('Cut type'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: /Select parent sheet 23 × 36 in P-23x36/ }))
    expect(onSelectBoard).toHaveBeenCalledWith('opt1')
  })
})
