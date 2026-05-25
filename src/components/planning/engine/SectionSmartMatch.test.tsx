import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { SectionSmartMatch } from './SectionSmartMatch'
import type { PlanningEngineLine, PlanningEngineReadiness } from './types'

const readiness: PlanningEngineReadiness = {
  materialId: 'm1', materialCode: 'ITC-FBB-100',
  boardType: 'FBB', boardClassification: null, size: '720×1020', gsm: 100,
  requiredSheets: 4800, availableSheets: 1240, reservedSheets: 3100,
  incomingSheets: 0, shortageSheets: 3560, prStatus: 'not_created', grnEta: null,
}

const baseLine = {
  id: 'L1', cartonId: null, cartonName: 'X', cartonSize: null, quantity: 18000,
  artworkCode: null, coatingType: null, otherCoating: null, embossingLeafing: null,
  paperType: null, gsm: null, remarks: null, planningStatus: 'planning', specOverrides: null,
  po: { id: 'PO1', poNumber: 'PO1', poDate: '2026-05-10', customer: { id: 'C1', name: 'X' } },
  smartMatch: {
    boardMatchConfidence: 0.94,
    materialCode: 'ITC-FBB-100',
    matchedOn: 'FBB / 100g / 4C UV',
    suggestions: [
      { label: 'A', tier: 'High' as const, composite: 82.4, sizeScore: 81, wasteScore: 79, urgencyScore: 72, toolScore: 80,
        poRefs: ['PO-2024-0829', 'PO-2024-0831'], linesIncluded: 3, totalPcs: 52000, avgYieldPct: 77.1, totalSheets: 340 },
      { label: 'B', tier: 'Medium' as const, composite: 58.1, sizeScore: 60, wasteScore: 55, urgencyScore: 50, toolScore: 65,
        poRefs: ['PO-2024-0801'], linesIncluded: 2, totalPcs: 31000, avgYieldPct: 64.8, totalSheets: 220 },
    ],
  },
} as unknown as PlanningEngineLine

describe('SectionSmartMatch', () => {
  it('renders top suggestion with composite, tier and sub-score bars', () => {
    render(<SectionSmartMatch line={baseLine} readiness={readiness} onPatch={async () => true} />)
    expect(screen.getByText('Suggestion A')).toBeInTheDocument()
    expect(screen.getByText('82.4')).toBeInTheDocument()
    expect(screen.getByText(/High \·/)).toBeInTheDocument()
    expect(screen.getByLabelText('Size sub-score 81')).toBeInTheDocument()
    expect(screen.getByLabelText('Waste sub-score 79')).toBeInTheDocument()
    expect(screen.getByLabelText('Urgency sub-score 72')).toBeInTheDocument()
    expect(screen.getByLabelText('Tool sub-score 80')).toBeInTheDocument()
  })

  it('renders board-match confidence + material code', () => {
    render(<SectionSmartMatch line={baseLine} readiness={readiness} onPatch={async () => true} />)
    expect(screen.getByText('94%')).toBeInTheDocument()
    expect(screen.getByText(/material code ITC-FBB-100/)).toBeInTheDocument()
  })

  it('renders no-stock empty state when material linked but no options', () => {
    const empty = { ...baseLine, smartMatch: undefined } as unknown as PlanningEngineLine
    render(<SectionSmartMatch line={empty} readiness={readiness} onPatch={async () => true} />)
    expect(screen.getByText(/No matching board in current stock/i)).toBeInTheDocument()
    expect(screen.getAllByText(/Suggested procurement/i).length).toBeGreaterThan(0)
  })

  it('renders spec-incomplete empty state when spec pack is missing fields', () => {
    const empty = {
      ...baseLine,
      smartMatch: undefined,
      planningLedger: {
        boardStockInsight: {
          specComplete: false,
          specIncompleteReason: 'Missing UPS in spec pack',
        },
      },
    } as unknown as PlanningEngineLine
    render(<SectionSmartMatch line={empty} readiness={readiness} onPatch={async () => true} />)
    expect(screen.getByText(/Spec incomplete/i)).toBeInTheDocument()
    expect(screen.getByText(/Missing UPS in spec pack/i)).toBeInTheDocument()
  })

  it('falls back to readiness board options when no scored suggestions', () => {
    const empty = { ...baseLine, smartMatch: undefined } as unknown as PlanningEngineLine
    const withOptions: PlanningEngineReadiness = {
      ...readiness,
      suggestedBoardOptions: [
        {
          materialId: 'opt1', materialCode: 'ITC-FBB-100', boardType: 'FBB', gsm: 100,
          size: '720×1020', freeSheets: 1240, availableSheets: 1240, requiredParentSheets: 4800,
          shortageParentSheets: 3560, wastagePct: 12, yieldPct: 78, cutsPerSheet: 6,
          matchType: 'Direct Size', status: 'Partial', tags: ['Best Yield'], gsmDelta: 0,
        },
      ],
    }
    render(<SectionSmartMatch line={empty} readiness={withOptions} onPatch={async () => true} />)
    expect(screen.getByText(/#1 · FBB · 100 gsm/)).toBeInTheDocument()
    expect(screen.getByText('Best Yield')).toBeInTheDocument()
    expect(screen.getByLabelText('Yield sub-score 78')).toBeInTheDocument()
  })

  it('calls onSelectBoard when a board option card is clicked', () => {
    const onSelectBoard = vi.fn().mockResolvedValue(undefined)
    const empty = { ...baseLine, smartMatch: undefined } as unknown as PlanningEngineLine
    const withOptions: PlanningEngineReadiness = {
      ...readiness,
      materialId: null,
      suggestedBoardOptions: [
        {
          materialId: 'opt1', materialCode: 'ITC-FBB-100', boardType: 'FBB', gsm: 100,
          size: '720×1020', freeSheets: 1240, availableSheets: 1240, requiredParentSheets: 4800,
          shortageParentSheets: 3560, wastagePct: 12, yieldPct: 78, cutsPerSheet: 6,
          matchType: 'Direct Size', status: 'Partial', tags: ['Best Yield'], gsmDelta: 0,
        },
      ],
    }
    render(<SectionSmartMatch line={empty} readiness={withOptions} onPatch={async () => true} onSelectBoard={onSelectBoard} />)
    fireEvent.click(screen.getByRole('button', { name: /Select board FBB/ }))
    expect(onSelectBoard).toHaveBeenCalledWith('opt1')
  })

  it('renders balance, match score and reason on a board option', () => {
    const r = {
      ...readiness,
      suggestedBoardOptions: [
        {
          materialId: 'b1', materialCode: 'C-1', boardType: 'CYBER', gsm: 280, size: '36 x 24',
          matchType: 'Direct Size', status: 'Ready', freeSheets: 9200, requiredParentSheets: 8650,
          shortageParentSheets: 0, cutsPerSheet: 6, yieldPct: 97, wastagePct: 3, tags: [],
          gsmDelta: 0, balanceSize: '11 x 25', balanceReusable: true, matchScore: 95,
          recommendationReason: 'In stock · yield 97% · reusable 11 x 25 balance',
        },
      ],
    } as unknown as PlanningEngineReadiness
    const noScored = { ...baseLine, smartMatch: undefined } as unknown as PlanningEngineLine
    render(<SectionSmartMatch line={noScored} readiness={r} onPatch={async () => true} />)
    expect(screen.getByText('95')).toBeInTheDocument()
    expect(screen.getByText(/reusable 11 x 25 balance/)).toBeInTheDocument()
    expect(screen.getByText('11 x 25')).toBeInTheDocument()
  })

  it('renders compatible alternatives in a separate labelled block', () => {
    const r = {
      ...readiness,
      suggestedBoardOptions: [],
      closestAvailableOptions: [
        {
          materialId: 'alt1', materialCode: 'ALT-1', boardType: 'FBB', gsm: 300, size: '24 x 36',
          matchType: 'Compatible Size', status: 'Ready', freeSheets: 5200, requiredParentSheets: 8650,
          shortageParentSheets: 0, cutsPerSheet: 6, yieldPct: 95, wastagePct: 5, tags: [], gsmDelta: 20,
        },
      ],
    } as unknown as PlanningEngineReadiness
    const noScored = { ...baseLine, smartMatch: undefined } as unknown as PlanningEngineLine
    render(<SectionSmartMatch line={noScored} readiness={r} onPatch={async () => true} />)
    expect(screen.getByText(/Compatible alternatives/i)).toBeInTheDocument()
    expect(screen.getByText('ALT-1')).toBeInTheDocument()
  })
})
