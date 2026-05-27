'use client'

import { memo, useMemo, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { readPlanningMeta } from '@/lib/planning-decision-spec'
import type { PlanningEngineLine, PlanningEngineReadiness, SectionPatchFn } from './types'

type Props = {
  line: PlanningEngineLine
  readiness: PlanningEngineReadiness | null
  onPatch: SectionPatchFn
  onDeselectBoard?: () => Promise<void>
  onUnreserve?: (qty?: number) => Promise<void>
  onReverseLock?: () => Promise<void>
}

type ActionKey = 'board' | 'reservation' | 'cut' | 'balance' | 'batch' | 'lock'

const RESET_META_KEYS = [
  'cuttingDirection',
  'cutPlanChildSizes',
  'cutPlanEdited',
  'childInputLengthMm',
  'childInputWidthMm',
  'makeReadySheets',
  'balanceAction',
  'balanceFutureJobId',
  'balanceFuturePoNumber',
  'balanceFutureJobReference',
  'balanceTargetReservationQty',
] as const

const RESET_CORE_KEYS = [
  'status',
  'layoutType',
  'setNumber',
  'designerKey',
  'lockedAt',
] as const

function cleanMeta(spec: Record<string, unknown>) {
  const meta = { ...readPlanningMeta(spec) } as Record<string, unknown>
  RESET_META_KEYS.forEach((key) => delete meta[key])
  return { ...spec, meta }
}

function cleanBatch(spec: Record<string, unknown>) {
  const planningCore = {
    ...(typeof spec.planningCore === 'object' && spec.planningCore
      ? (spec.planningCore as Record<string, unknown>)
      : {}),
  }
  RESET_CORE_KEYS.forEach((key) => delete planningCore[key])
  planningCore.status = 'Draft'
  planningCore.layoutType = 'single'
  return { ...spec, planningCore }
}

export const PlanningDecisionReversal = memo(function PlanningDecisionReversal({
  line,
  readiness,
  onPatch,
  onDeselectBoard,
  onUnreserve,
  onReverseLock,
}: Props) {
  const [busy, setBusy] = useState<ActionKey | null>(null)
  const spec = useMemo(() => (line.specOverrides ?? {}) as Record<string, unknown>, [line.specOverrides])
  const meta = useMemo(() => readPlanningMeta(spec), [spec])
  const core = useMemo(
    () => (typeof spec.planningCore === 'object' && spec.planningCore ? (spec.planningCore as Record<string, unknown>) : {}),
    [spec],
  )

  const reservedSheets = Math.max(0, Number(readiness?.reservedSheets ?? 0))
  const boardSelected = !!readiness?.materialId
  const hasCutDecision = Array.isArray(meta.cutPlanChildSizes) && meta.cutPlanChildSizes.length > 0
  const hasBalanceDecision = typeof meta.balanceAction === 'string' && meta.balanceAction.trim().length > 0
  const hasBatchDecision =
    typeof core.status === 'string' ||
    !!core.layoutType ||
    typeof core.setNumber === 'string' ||
    !!core.designerKey ||
    !!line.batchDecision?.designerId ||
    !!line.batchDecision?.setNumber
  const locked = !!core.lockedAt || !!line.batchDecision?.lockedAt || line.batchDecision?.status === 'Locked'

  const actions: Array<{
    key: ActionKey
    label: string
    hint: string
    enabled: boolean
    onClick: () => Promise<void>
    danger?: boolean
  }> = [
    {
      key: 'board',
      label: 'Deselect Board',
      hint: reservedSheets > 0 ? 'Release reserved stock first' : 'Clear selected parent sheet',
      enabled: boardSelected && reservedSheets <= 0 && !!onDeselectBoard,
      onClick: async () => { await onDeselectBoard?.() },
    },
    {
      key: 'reservation',
      label: 'Unreserve',
      hint: reservedSheets > 0 ? `Release ${reservedSheets.toLocaleString('en-IN')} sh` : 'No active reservation',
      enabled: reservedSheets > 0 && !!onUnreserve,
      onClick: async () => { await onUnreserve?.() },
      danger: true,
    },
    {
      key: 'cut',
      label: 'Reset Cut Plan',
      hint: hasCutDecision ? 'Revert child sizes and balance logic' : 'No manual cut plan',
      enabled: hasCutDecision,
      onClick: async () => { await onPatch({ specOverrides: cleanMeta(spec) }) },
    },
    {
      key: 'balance',
      label: 'Clear Balance Action',
      hint: hasBalanceDecision ? 'Remove leftover-stock decision' : 'No balance action',
      enabled: hasBalanceDecision,
      onClick: async () => {
        const nextMeta = { ...meta } as Record<string, unknown>
        delete nextMeta.balanceAction
        delete nextMeta.balanceFutureJobId
        delete nextMeta.balanceFuturePoNumber
        delete nextMeta.balanceFutureJobReference
        delete nextMeta.balanceTargetReservationQty
        await onPatch({ specOverrides: { ...spec, meta: nextMeta } })
      },
    },
    {
      key: 'batch',
      label: 'Reset Batch',
      hint: hasBatchDecision ? 'Return batch decision to Draft / Single' : 'No batch decision',
      enabled: hasBatchDecision && !locked,
      onClick: async () => { await onPatch({ specOverrides: cleanBatch(spec) }) },
    },
    {
      key: 'lock',
      label: 'Reverse Lock',
      hint: locked ? 'Recall from downstream planning release' : 'Not locked',
      enabled: locked && !!onReverseLock,
      onClick: async () => { await onReverseLock?.() },
      danger: true,
    },
  ]

  async function run(action: (typeof actions)[number]) {
    if (!action.enabled || busy) return
    setBusy(action.key)
    try {
      await action.onClick()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="rounded-ds-card border border-ds-line/25 bg-[var(--bg-card)] p-3 shadow-ds-depth">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-widest text-ds-ink-faint">
            Decision Reversal
          </div>
          <div className="mt-0.5 text-[11px] text-ds-ink-muted">
            Reverse each planning decision from here. Stock-affecting actions update warehouse inventory.
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {actions.map((action) => (
            <button
              key={action.key}
              type="button"
              disabled={!action.enabled || !!busy}
              onClick={() => { void run(action) }}
              title={action.hint}
              className={[
                'inline-flex h-8 items-center gap-1.5 rounded-ds-sm border px-2.5 text-[11px] font-semibold transition-colors',
                action.danger
                  ? 'border-ds-danger/35 bg-ds-danger/10 text-ds-danger hover:bg-ds-danger/15'
                  : 'border-ds-line/35 bg-ds-elevated/55 text-ds-ink hover:bg-ds-brand/10 hover:text-ds-brand',
                !action.enabled || busy ? 'cursor-not-allowed opacity-45' : '',
              ].join(' ')}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {busy === action.key ? 'Reversing...' : action.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
})
