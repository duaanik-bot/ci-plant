import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PlanningDecisionReversal } from './PlanningDecisionReversal'
import type { PlanningEngineLine, PlanningEngineReadiness } from './types'

const baseLine = {
  id: 'L1',
  cartonId: null,
  cartonName: 'Test carton',
  cartonSize: null,
  quantity: 1000,
  artworkCode: null,
  coatingType: null,
  otherCoating: null,
  embossingLeafing: null,
  paperType: 'FBB',
  gsm: 300,
  remarks: null,
  planningStatus: 'pending',
  specOverrides: null,
  po: { id: 'PO1', poNumber: 'PO1', poDate: '2026-05-10', customer: { id: 'C1', name: 'X' } },
} as unknown as PlanningEngineLine

const readiness = {
  materialId: 'MAT-1',
  materialCode: 'FBB-300-23X36',
  boardType: 'FBB',
  gsm: 300,
  size: '23 x 36',
  requiredSheets: 100,
  availableSheets: 100,
  reservedSheets: 0,
  freeSheets: 100,
  incomingSheets: 0,
  shortageSheets: 0,
  status: 'green',
} as unknown as PlanningEngineReadiness

describe('PlanningDecisionReversal', () => {
  it('does not show Deselect Board when no board is actually selected', () => {
    render(
      <PlanningDecisionReversal
        line={baseLine}
        readiness={readiness}
        onPatch={async () => true}
        onDeselectBoard={vi.fn()}
        onUnreserve={vi.fn()}
        onSendBackToArtwork={vi.fn()}
      />,
    )

    expect(screen.queryByRole('button', { name: /Deselect Board/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /Unreserve/i })).toBeNull()
    expect(screen.getByRole('button', { name: /Reset Cut Plan/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Push to AW/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Clear Balance Action/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /Reset Batch/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /Reverse Lock/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /Send Back to AW/i })).toBeNull()
  })

  it('shows only the four reversal actions and blocks them while locked', () => {
    const line = {
      ...baseLine,
      specOverrides: {
        planningMaterialId: 'MAT-1',
        meta: {
          cutPlanChildSizes: [{ lMm: 100, wMm: 200, qty: 2 }],
          balanceAction: 'reserve_future',
        },
        planningCore: { status: 'Ready', layoutType: 'gang', setNumber: 'SET-1', lockedAt: '2026-06-11T00:00:00.000Z' },
      },
    } as unknown as PlanningEngineLine

    render(
      <PlanningDecisionReversal
        line={line}
        readiness={{ ...readiness, reservedSheets: 25, reservedByMaterial: { 'MAT-1': 25 } } as unknown as PlanningEngineReadiness}
        onPatch={async () => true}
        onDeselectBoard={vi.fn()}
        onUnreserve={vi.fn()}
        onSendBackToArtwork={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: /Deselect Board/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Unreserve/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Reset Cut Plan/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Push to AW/i })).toBeDisabled()
    expect(screen.queryByRole('button', { name: /Clear Balance Action/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /Reset Batch/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /Reverse Lock/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /Send Back to AW/i })).toBeNull()
  })
})
