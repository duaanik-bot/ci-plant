import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { SectionProductRequirement } from './SectionProductRequirement'
import type { PlanningEngineLine, PlanningEngineReadiness } from './types'

const line = {
  id: 'L1', cartonName: 'Pizza Box 12in', cartonSize: '300x300x40', quantity: 20000,
  artworkCode: 'AW-991', paperType: 'FBB', gsm: 300, planningStatus: 'pending',
  specOverrides: null, po: { id: 'PO1', poNumber: 'PO-555', poDate: '2026-05-01', customer: { id: 'CU1', name: 'Domino' } },
} as unknown as PlanningEngineLine
const readiness = { boardType: 'FBB', gsm: 300 } as unknown as PlanningEngineReadiness

describe('SectionProductRequirement', () => {
  it('shows PO, product, AW code, customer, board, gsm, carton size, qty, status', () => {
    render(<SectionProductRequirement line={line} readiness={readiness} />)
    expect(screen.getByText('PO-555')).toBeInTheDocument()
    expect(screen.getByText('Pizza Box 12in')).toBeInTheDocument()
    expect(screen.getByText('AW-991')).toBeInTheDocument()
    expect(screen.getByText('Domino')).toBeInTheDocument()
    expect(screen.getByText('FBB')).toBeInTheDocument()
    expect(screen.getByText('300x300x40')).toBeInTheDocument()
    expect(screen.getByText('20,000 pcs')).toBeInTheDocument()
  })

  it('falls back to line.paperType/line.gsm when readiness is null', () => {
    render(<SectionProductRequirement line={line} readiness={null} />)
    expect(screen.getByText('Pizza Box 12in')).toBeInTheDocument()
  })

  it('shows required qty from the calculation summary total when provided', () => {
    render(<SectionProductRequirement line={line} readiness={readiness} requiredSheetsOverride={16817} />)
    expect(screen.getByText('16,817 sheets')).toBeInTheDocument()
  })

  it('shows a saved planning designer even when the current designer options are empty', () => {
    const assignedLine = {
      ...line,
      specOverrides: {
        planningCore: { designerKey: 'avneet_singh' },
        planningDesignerDisplayName: 'Avneet Singh',
      },
      batchDecision: {
        status: 'Ready',
        layoutType: 'Single',
        setNumber: null,
        setNumberAuto: true,
        designerOptions: [],
        designerId: null,
      },
    } as unknown as PlanningEngineLine

    render(<SectionProductRequirement line={assignedLine} readiness={readiness} />)

    expect(screen.getByText('Avneet Singh')).toBeInTheDocument()
    expect(screen.queryByText('Not assigned')).not.toBeInTheDocument()
  })
})
