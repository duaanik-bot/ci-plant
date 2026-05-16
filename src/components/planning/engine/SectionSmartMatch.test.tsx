import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { SectionSmartMatch } from './SectionSmartMatch'
import type { PlanningEngineBoardOption, PlanningEngineLine, PlanningEngineReadiness } from './types'

const baseLine = {
  id: 'L1', cartonId: null, cartonName: 'X', cartonSize: null, quantity: 18000,
  artworkCode: null, coatingType: null, otherCoating: null, embossingLeafing: null,
  paperType: null, gsm: null, remarks: null, planningStatus: 'planning', specOverrides: null,
  po: { id: 'PO1', poNumber: 'PO1', poDate: '2026-05-10', customer: { id: 'C1', name: 'X' } },
} as unknown as PlanningEngineLine

function opt(over: Partial<PlanningEngineBoardOption>): PlanningEngineBoardOption {
  return {
    materialId: 'm1', materialCode: 'ITC-FBB-100', boardType: 'FBB', boardClassification: null,
    gsm: 100, size: '720×1020', availableSheets: 4200, reservedSheets: 1000, freeSheets: 3200,
    cutsPerSheet: 2, requiredParentSheets: 340, shortageParentSheets: 0, wastagePct: 7.4,
    sizeDeviationPct: 0, fitScore: 82, yieldPct: 77.1, orientation: 'LxW',
    matchType: 'Direct Size', status: 'Ready', tags: [], gsmDelta: 0, matchRank: 1,
    ...over,
  }
}

const readiness: PlanningEngineReadiness = {
  materialId: 'm1', materialCode: 'ITC-FBB-100', boardType: 'FBB', boardClassification: null,
  size: '720×1020', gsm: 100, requiredSheets: 4800, availableSheets: 4200, reservedSheets: 1000,
  incomingSheets: 0, shortageSheets: 0, prStatus: 'not_created', grnEta: null, status: 'green',
  suggestedBoardOptions: [
    opt({ materialId: 'm1', materialCode: 'ITC-FBB-100', fitScore: 82, status: 'Ready' }),
    opt({ materialId: 'm2', materialCode: 'ITC-FBB-100B', fitScore: 61, status: 'Partial', matchRank: 2, requiredParentSheets: 420, wastagePct: 9.2, matchType: 'Cut Fit' }),
  ],
  closestAvailableOptions: [
    opt({ materialId: 'm3', materialCode: 'WLC-90', gsm: 90, gsmDelta: -10, fitScore: 44, status: 'Shortage', matchType: 'GSM Tolerance', matchRank: 1 }),
  ],
}

describe('SectionSmartMatch', () => {
  it('renders strict board options with size + requirement + fit + wastage', () => {
    render(<SectionSmartMatch line={baseLine} readiness={readiness} onPatch={async () => true} />)
    expect(screen.getByText('ITC-FBB-100')).toBeInTheDocument()
    expect(screen.getByText('Fit 82')).toBeInTheDocument()
    expect(screen.getByText('340 sh')).toBeInTheDocument()
    expect(screen.getByText('7.4%')).toBeInTheDocument()
    expect(screen.getByText('Direct Size')).toBeInTheDocument()
    expect(screen.getAllByText('Ready').length).toBeGreaterThan(0)
  })

  it('shows the strict-count chip and a toggle for compatible alternatives', () => {
    render(<SectionSmartMatch line={baseLine} readiness={readiness} onPatch={async () => true} />)
    expect(screen.getByText('2 strict')).toBeInTheDocument()
    const toggle = screen.getByText(/compatible alternative/i)
    expect(toggle).toBeInTheDocument()
    fireEvent.click(toggle)
    expect(screen.getByText('WLC-90')).toBeInTheDocument()
  })

  it('patches the selected board onto the line spec when "Use board" is clicked', async () => {
    const onPatch = vi.fn().mockResolvedValue(true)
    render(<SectionSmartMatch line={baseLine} readiness={readiness} onPatch={onPatch} />)
    fireEvent.click(screen.getAllByRole('button', { name: /Use board/i })[0])
    await Promise.resolve()
    expect(onPatch).toHaveBeenCalledTimes(1)
    const arg = onPatch.mock.calls[0][0] as { specOverrides: Record<string, unknown> }
    expect(arg.specOverrides.selectedBoardMaterialId).toBe('m1')
  })

  it('renders an empty state when there are no options', () => {
    const empty = { ...readiness, suggestedBoardOptions: [], closestAvailableOptions: [] }
    render(<SectionSmartMatch line={baseLine} readiness={empty} onPatch={async () => true} />)
    expect(screen.getByText(/No board options matched/i)).toBeInTheDocument()
  })

  it('falls back to closest options when no strict matches', () => {
    const fallback = { ...readiness, suggestedBoardOptions: [] }
    render(<SectionSmartMatch line={baseLine} readiness={fallback} onPatch={async () => true} />)
    expect(screen.getByText('WLC-90')).toBeInTheDocument()
    expect(screen.getByText('1 compatible')).toBeInTheDocument()
  })
})
