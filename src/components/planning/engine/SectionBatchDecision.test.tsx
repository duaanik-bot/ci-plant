import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { SectionBatchDecision } from './SectionBatchDecision'
import type { PlanningEngineLine } from './types'

const baseLine = {
  id: 'L1', cartonId: null, cartonName: 'X', cartonSize: null, quantity: 1,
  artworkCode: null, coatingType: null, otherCoating: null, embossingLeafing: null,
  // Mandatory engine inputs present so the lock tests isolate the readinessFive gate.
  paperType: 'FBB', gsm: 300, remarks: null, planningStatus: 'planning',
  specOverrides: { meta: { ups: 6, sheetLengthMm: 1016, sheetWidthMm: 711 } },
  po: { id: 'PO1', poNumber: 'PO1', poDate: '2026-05-10', customer: { id: 'C1', name: 'X' } },
  batchDecision: {
    status: 'Ready' as const,
    layoutType: 'Gang' as const,
    setNumber: 'SET-007',
    setNumberAuto: true,
    designerOptions: [
      { id: 'u1', name: 'Avneet Singh' },
      { id: 'u2', name: 'Shamsher Inder' },
    ],
    designerId: 'u2',
    pressAssignment: { code: 'PRN-02', deckLabel: '6-colour bed', size: '1020×760 mm', loadPct: 48, runHours: 5.2, smartPicked: true },
    readinessFive: { allReady: false, blockers: ['PA shortage'] },
  },
} as unknown as PlanningEngineLine

describe('SectionBatchDecision', () => {
  it('renders status pills with Release selected', () => {
    render(<SectionBatchDecision line={baseLine} onPatch={async () => true} onLock={async () => {}} />)
    expect(screen.getByRole('button', { name: 'Release' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('shows press assignment with Smart pick chip', () => {
    render(<SectionBatchDecision line={baseLine} onPatch={async () => true} onLock={async () => {}} />)
    expect(screen.getByText('PRN-02')).toBeInTheDocument()
    expect(screen.getByText('Smart pick')).toBeInTheDocument()
    expect(screen.getByText('~5.2h run')).toBeInTheDocument()
    expect(screen.getByText('48%')).toBeInTheDocument()
  })

  it('disables Save & lock when readinessFive.allReady is false', () => {
    render(<SectionBatchDecision line={baseLine} onPatch={async () => true} onLock={async () => {}} />)
    expect(screen.getByRole('button', { name: 'Save & lock' })).toBeDisabled()
    expect(screen.getByText(/Blockers: PA shortage/)).toBeInTheDocument()
  })

  it('enables Save & lock when readinessFive.allReady is true and calls onLock', async () => {
    const lineReady = {
      ...baseLine,
      batchDecision: { ...baseLine.batchDecision!, readinessFive: { allReady: true, blockers: [] } },
    }
    const onLock = vi.fn().mockResolvedValue(undefined)
    render(<SectionBatchDecision line={lineReady} onPatch={async () => true} onLock={onLock} />)
    const btn = screen.getByRole('button', { name: 'Save & lock' })
    expect(btn).not.toBeDisabled()
    fireEvent.click(btn)
    await Promise.resolve()
    expect(onLock).toHaveBeenCalled()
  })

  it('renders an empty press assignment state when none provided', () => {
    const line = { ...baseLine, batchDecision: { ...baseLine.batchDecision!, pressAssignment: null } }
    render(<SectionBatchDecision line={line} onPatch={async () => true} onLock={async () => {}} />)
    expect(screen.getByText(/No press assigned yet/i)).toBeInTheDocument()
  })

  it('defaults layout to Single for a standalone line', () => {
    const line = { ...baseLine, batchDecision: undefined, specOverrides: null } as unknown as PlanningEngineLine
    render(<SectionBatchDecision line={line} onPatch={async () => true} onLock={async () => {}} />)
    expect(screen.getByRole('button', { name: 'Single' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Gang' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('defaults layout to Gang for a multi-line mix-set', () => {
    const line = {
      ...baseLine,
      batchDecision: undefined,
      specOverrides: { planningCore: { masterSetId: 'MIX-1', mixSetMemberIds: ['a', 'b'] } },
    } as unknown as PlanningEngineLine
    render(<SectionBatchDecision line={line} onPatch={async () => true} onLock={async () => {}} />)
    expect(screen.getByRole('button', { name: 'Gang' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('persists layoutType to planningCore when toggled', () => {
    const onPatch = vi.fn().mockResolvedValue(true)
    const line = { ...baseLine, batchDecision: undefined, specOverrides: null } as unknown as PlanningEngineLine
    render(<SectionBatchDecision line={line} onPatch={onPatch} onLock={async () => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Gang' }))
    expect(onPatch).toHaveBeenCalledWith({ specOverrides: { planningCore: { layoutType: 'gang' } } })
  })

  it('blocks Release status when releaseGuard.canRelease is false and shows reason', () => {
    const onPatch = vi.fn().mockResolvedValue(true)
    const line = {
      ...baseLine,
      batchDecision: {
        ...baseLine.batchDecision!,
        status: 'Hold' as const,
        releaseGuard: { canRelease: false, reason: 'Shortage open with no PR/approval' },
      },
    } as unknown as PlanningEngineLine
    render(<SectionBatchDecision line={line} onPatch={onPatch} onLock={async () => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Release' }))
    expect(onPatch).not.toHaveBeenCalled()
    expect(screen.getByText('Shortage open with no PR/approval')).toBeInTheDocument()
  })

  it('allows Release status when releaseGuard.canRelease is true', () => {
    const onPatch = vi.fn().mockResolvedValue(true)
    const line = {
      ...baseLine,
      batchDecision: {
        ...baseLine.batchDecision!,
        status: 'Hold' as const,
        releaseGuard: { canRelease: true, reason: null },
      },
    } as unknown as PlanningEngineLine
    render(<SectionBatchDecision line={line} onPatch={onPatch} onLock={async () => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Release' }))
    expect(onPatch).toHaveBeenCalledWith(
      expect.objectContaining({ specOverrides: expect.objectContaining({ planningCore: expect.objectContaining({ status: 'Released' }) }) })
    )
  })

  it('renders Generate job card when locked and onGenerateJobCard is provided, and calls it on click', async () => {
    const lineLocked = {
      ...baseLine,
      batchDecision: {
        ...baseLine.batchDecision!,
        status: 'Locked' as const,
        lockedAt: '2026-05-24T10:00:00.000Z',
      },
    } as unknown as PlanningEngineLine
    const onGenerateJobCard = vi.fn().mockResolvedValue(undefined)
    render(
      <SectionBatchDecision
        line={lineLocked}
        onPatch={async () => true}
        onLock={async () => {}}
        onGenerateJobCard={onGenerateJobCard}
      />,
    )
    const btn = screen.getByRole('button', { name: 'Generate job card' })
    expect(btn).toBeInTheDocument()
    fireEvent.click(btn)
    await Promise.resolve()
    expect(onGenerateJobCard).toHaveBeenCalled()
  })

  it('uses the lock button as Unlock when locked', async () => {
    const lineLocked = {
      ...baseLine,
      batchDecision: {
        ...baseLine.batchDecision!,
        status: 'Locked' as const,
        lockedAt: '2026-05-24T10:00:00.000Z',
      },
    } as unknown as PlanningEngineLine
    const onUnlock = vi.fn().mockResolvedValue(undefined)
    render(
      <SectionBatchDecision
        line={lineLocked}
        onPatch={async () => true}
        onLock={async () => {}}
        onUnlock={onUnlock}
      />,
    )
    const btn = screen.getByRole('button', { name: 'Unlock planning' })
    expect(btn).not.toBeDisabled()
    expect(btn).toHaveTextContent('Unlock')
    fireEvent.click(btn)
    await Promise.resolve()
    expect(onUnlock).toHaveBeenCalled()
  })

  it('hides Generate job card when the line is not locked', () => {
    const lineReady = {
      ...baseLine,
      batchDecision: { ...baseLine.batchDecision!, status: 'Ready' as const, lockedAt: undefined },
    } as unknown as PlanningEngineLine
    render(
      <SectionBatchDecision
        line={lineReady}
        onPatch={async () => true}
        onLock={async () => {}}
        onGenerateJobCard={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Generate job card' })).not.toBeInTheDocument()
  })

  it('allows Release status when no releaseGuard is present', () => {
    const onPatch = vi.fn().mockResolvedValue(true)
    const line = {
      ...baseLine,
      batchDecision: {
        ...baseLine.batchDecision!,
        status: 'Hold' as const,
        releaseGuard: undefined,
      },
    } as unknown as PlanningEngineLine
    render(<SectionBatchDecision line={line} onPatch={onPatch} onLock={async () => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Release' }))
    expect(onPatch).toHaveBeenCalled()
  })
})
