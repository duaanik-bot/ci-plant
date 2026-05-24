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
    expect(screen.getByText(/#1 · Best match · FBB · 100 gsm/)).toBeInTheDocument()
    expect(screen.getByText('Best Yield')).toBeInTheDocument()
    expect(screen.getByLabelText('Yield sub-score 78')).toBeInTheDocument()
  })

  it('renders matchScorePct%, reason text, and Best match rank label on rank-1 card', () => {
    const empty = { ...baseLine, smartMatch: undefined } as unknown as PlanningEngineLine
    const withOptions: PlanningEngineReadiness = {
      ...readiness,
      suggestedBoardOptions: [
        {
          materialId: 'opt1', materialCode: 'ITC-FBB-100', boardType: 'FBB', gsm: 100,
          size: '720×1020', freeSheets: 1240, availableSheets: 1240, requiredParentSheets: 4800,
          shortageParentSheets: 0, wastagePct: 8, yieldPct: 92, cutsPerSheet: 6,
          matchType: 'Direct Size', status: 'Ready', tags: [], gsmDelta: 0,
          matchScorePct: 87,
          reason: 'Direct Size · exact GSM · 92% yield · in stock',
        },
      ],
    }
    render(<SectionSmartMatch line={empty} readiness={withOptions} onPatch={async () => true} />)
    expect(screen.getByText('87%')).toBeInTheDocument()
    expect(screen.getByText('Direct Size · exact GSM · 92% yield · in stock')).toBeInTheDocument()
    expect(screen.getByText(/#1 · Best match · FBB · 100 gsm/)).toBeInTheDocument()
  })

  it('renders all 5 composite suggestions when 5 are provided', () => {
    const fiveSuggestions: NonNullable<PlanningEngineLine['smartMatch']>['suggestions'] = [
      { label: '#1', tier: 'High' as const, composite: 82.4, sizeScore: 81, wasteScore: 79, urgencyScore: 72, toolScore: 80,
        poRefs: ['PO-001'], linesIncluded: 2, totalPcs: 52000, avgYieldPct: 77.1, totalSheets: 340 },
      { label: '#2', tier: 'High' as const, composite: 75.0, sizeScore: 75, wasteScore: 70, urgencyScore: 80, toolScore: 75,
        poRefs: ['PO-002'], linesIncluded: 2, totalPcs: 40000, avgYieldPct: 75.0, totalSheets: 280 },
      { label: '#3', tier: 'Medium' as const, composite: 62.5, sizeScore: 60, wasteScore: 65, urgencyScore: 60, toolScore: 65,
        poRefs: ['PO-003'], linesIncluded: 2, totalPcs: 35000, avgYieldPct: 70.5, totalSheets: 250 },
      { label: '#4', tier: 'Medium' as const, composite: 55.0, sizeScore: 55, wasteScore: 58, urgencyScore: 50, toolScore: 55,
        poRefs: ['PO-004'], linesIncluded: 2, totalPcs: 30000, avgYieldPct: 66.0, totalSheets: 220 },
      { label: '#5', tier: 'Low' as const, composite: 42.0, sizeScore: 40, wasteScore: 45, urgencyScore: 40, toolScore: 42,
        poRefs: ['PO-005'], linesIncluded: 2, totalPcs: 25000, avgYieldPct: 60.0, totalSheets: 190 },
    ]
    const lineWith5 = {
      ...baseLine,
      smartMatch: { ...baseLine.smartMatch, suggestions: fiveSuggestions },
    } as unknown as PlanningEngineLine
    render(<SectionSmartMatch line={lineWith5} readiness={readiness} onPatch={async () => true} />)
    expect(screen.getByText('Suggestion #1')).toBeInTheDocument()
    expect(screen.getByText('Suggestion #2')).toBeInTheDocument()
    expect(screen.getByText('Suggestion #3')).toBeInTheDocument()
    expect(screen.getByText('Suggestion #4')).toBeInTheDocument()
    expect(screen.getByText('Suggestion #5')).toBeInTheDocument()
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
})
