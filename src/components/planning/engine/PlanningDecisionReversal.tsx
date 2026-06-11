'use client'

import { memo, useMemo, useState } from 'react'
import { RotateCcw, Undo2 } from 'lucide-react'
import { readPlanningMeta } from '@/lib/planning-decision-spec'
import type { PlanningEngineLine, PlanningEngineReadiness, SectionPatchFn } from './types'

type Props = {
  line: PlanningEngineLine
  readiness: PlanningEngineReadiness | null
  onPatch: SectionPatchFn
  onDeselectBoard?: () => Promise<void>
  onUnreserve?: (qty?: number) => Promise<void>
  onReverseLock?: () => Promise<void>
  onSendBackToArtwork?: () => Promise<void>
}

type ActionKey = 'board' | 'reservation' | 'cut' | 'pushaw'
type ReversalAction = {
  key: ActionKey
  label: string
  hint: string
  enabled: boolean
  visible: boolean
  onClick: () => Promise<void>
  danger?: boolean
}

const RESET_META_KEYS = [
  'ups',
  'upsEdited',
  'upsSource',
  'cutType',
  'cutsPerSheet',
  'selectedCutsPerSheet',
  'cutPlanAutoSignature',
  'cuttingDirection',
  'cutPlanChildSizes',
  'cutPlanEdited',
  'childInputLengthMm',
  'childInputWidthMm',
  'parentSize',
  'requiredParentSheets',
  'reserveBaseSheets',
  'sheetLengthMm',
  'sheetWidthMm',
  'sheetUnit',
  'makeReadySheets',
  'makeReadyEdited',
  'wastageSheets',
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
  'masterSetId',
  'mixSetMemberIds',
  'batchStatus',
  'designerKey',
  'lockedAt',
  'lockedBy',
  'lockedByName',
] as const

const RESET_SPEC_KEYS = [
  'ups',
  'wastageSheets',
  'planningDesignerDisplayName',
] as const

function resetCutPlanFromScratch(spec: Record<string, unknown>) {
  const nextSpec = { ...spec }
  RESET_SPEC_KEYS.forEach((key) => delete nextSpec[key])
  const meta = { ...readPlanningMeta(spec) } as Record<string, unknown>
  RESET_META_KEYS.forEach((key) => delete meta[key])
  const planningCore = {
    ...(typeof spec.planningCore === 'object' && spec.planningCore
      ? (spec.planningCore as Record<string, unknown>)
      : {}),
  }
  RESET_CORE_KEYS.forEach((key) => delete planningCore[key])
  planningCore.status = 'Draft'
  planningCore.layoutType = 'single'
  return { ...nextSpec, meta, planningCore }
}

export const PlanningDecisionReversal = memo(function PlanningDecisionReversal({
  line,
  readiness,
  onPatch,
  onDeselectBoard,
  onUnreserve,
  onSendBackToArtwork,
}: Props) {
  const [busy, setBusy] = useState<ActionKey | null>(null)
  const spec = useMemo(() => (line.specOverrides ?? {}) as Record<string, unknown>, [line.specOverrides])
  const meta = useMemo(() => readPlanningMeta(spec), [spec])
  const core = useMemo(
    () => (typeof spec.planningCore === 'object' && spec.planningCore ? (spec.planningCore as Record<string, unknown>) : {}),
    [spec],
  )

  const boardSelected = typeof spec.planningMaterialId === 'string' && spec.planningMaterialId.trim().length > 0
  const reservedForSelected = Math.max(
    0,
    Number(
      readiness?.materialId
        ? readiness?.reservedByMaterial?.[readiness.materialId] ?? readiness?.reservedForLine ?? 0
        : readiness?.reservedForLine ?? 0,
    ),
  )
  const reservedSheets = Math.max(0, Number(readiness?.reservedSheets ?? reservedForSelected))
  const hasCutDecision =
    (Array.isArray(meta.cutPlanChildSizes) && meta.cutPlanChildSizes.length > 0) ||
    Number.isFinite(Number(meta.cutType)) ||
    Number.isFinite(Number(meta.cutsPerSheet)) ||
    Number.isFinite(Number(meta.selectedCutsPerSheet)) ||
    typeof meta.cutPlanAutoSignature === 'string' ||
    typeof meta.balanceAction === 'string' ||
    typeof meta.parentSize === 'string' ||
    Number.isFinite(Number(meta.wastageSheets ?? spec.wastageSheets)) ||
    Number.isFinite(Number(meta.makeReadySheets))
  const hasBatchDecision =
    typeof core.status === 'string' ||
    !!core.layoutType ||
    typeof core.setNumber === 'string' ||
    !!core.designerKey ||
    !!line.batchDecision?.designerId ||
    !!line.batchDecision?.setNumber
  const locked = !!core.lockedAt || !!line.batchDecision?.lockedAt || line.batchDecision?.status === 'Locked'

  const allActions: ReversalAction[] = [
    {
      key: 'board',
      label: 'Deselect Board',
      hint: locked
        ? 'Unlock plan before changing board allocation'
        : reservedForSelected > 0
          ? 'Release reserved stock first'
          : 'Clear selected parent sheet',
      enabled: !locked && boardSelected && reservedForSelected <= 0 && !!onDeselectBoard,
      visible: boardSelected,
      onClick: async () => { await onDeselectBoard?.() },
    },
    {
      key: 'reservation',
      label: 'Unreserve',
      hint: locked
        ? 'Unlock plan before changing reservation'
        : reservedSheets > 0
          ? `Release ${reservedSheets.toLocaleString('en-IN')} sh`
          : 'No active reservation',
      enabled: !locked && reservedSheets > 0 && !!onUnreserve,
      visible: reservedSheets > 0,
      onClick: async () => { await onUnreserve?.() },
      danger: true,
    },
    {
      key: 'cut',
      label: 'Reset Cut Plan',
      hint: locked
        ? 'Unlock plan before resetting the cut plan'
        : hasCutDecision || hasBatchDecision
          ? 'Clear cut, balance, batch, and lock decisions'
          : 'No cut plan to reset',
      enabled: !locked && (hasCutDecision || hasBatchDecision),
      visible: true,
      onClick: async () => { await onPatch({ specOverrides: resetCutPlanFromScratch(spec) }) },
    },
    {
      key: 'pushaw',
      label: 'Push to AW',
      hint: locked
        ? 'Unlock plan before sending back to artwork'
        : onSendBackToArtwork
          ? 'Return this line to the artwork queue'
          : 'Send-back is unavailable',
      enabled: !locked && !!onSendBackToArtwork,
      visible: true,
      onClick: async () => { await onSendBackToArtwork?.() },
      danger: true,
    },
  ]
  const actions = allActions.filter((action) => action.visible)

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
              {action.key === 'pushaw' ? <Undo2 className="h-3.5 w-3.5" /> : <RotateCcw className="h-3.5 w-3.5" />}
              {busy === action.key ? (action.key === 'pushaw' ? 'Pushing...' : 'Reversing...') : action.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
})
