import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PlanningStepNav } from './PlanningStepNav'
import type { PlanningEngineLine, PlanningEngineReadiness } from './types'

const readiness = {
  materialId: 'mat-1',
} as unknown as PlanningEngineReadiness

const lockedLine = {
  specOverrides: {
    meta: {
      cutPlanChildSizes: [{ qty: 1, lMm: 100 }],
    },
  },
  batchDecision: {
    status: 'Locked',
    lockedAt: '2026-06-11T00:00:00.000Z',
  },
} as unknown as PlanningEngineLine

describe('PlanningStepNav', () => {
  it('renders Review & Lock as complete when the plan is locked', () => {
    render(<PlanningStepNav line={lockedLine} readiness={readiness} />)

    const label = screen.getByText('Review & Lock')
    const button = label.closest('button')
    expect(button?.textContent).toContain('Review & Lock')
    expect(button?.innerHTML).toContain('border-emerald')
  })

  it('keeps every step complete for a locked plan even before readiness reloads', () => {
    render(<PlanningStepNav line={lockedLine} readiness={null} />)

    for (const labelText of ['Board Allocation', 'Cut Plan & Balance', 'Smart Match', 'Batch Decision', 'Review & Lock']) {
      const button = screen.getByText(labelText).closest('button')
      expect(button?.innerHTML).toContain('border-emerald')
    }
  })
})
