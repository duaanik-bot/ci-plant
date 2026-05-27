'use client'

import { memo, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { CardSection } from '@/components/design-system/CardSection'
import { readPlanningMeta } from '@/lib/planning-decision-spec'
import { fromMm, isSheetUnit, roundForUnit, toMm, type SheetUnit } from '@/lib/planning-sheet-cut'
import { parseSheetSizeToPair } from '@/lib/planning-sheet-size'
import { computeParentFromChild } from '@/lib/smart-match-parent-sheets'
import type { PlanningEngineLine, PlanningEngineReadiness, SectionPatchFn } from './types'

// ─── Types ────────────────────────────────────────────────────────────────────

type BalanceAction =
  | 'return_warehouse'
  | 'add_existing'
  | 'create_master'
  | 'reserve_another_job'
  | 'scrap'

type Props = {
  line: PlanningEngineLine
  readiness: PlanningEngineReadiness | null
  onPatch: SectionPatchFn
  onOpenWarehouse?: () => void
}

// ─── Constants ────────────────────────────────────────────────────────────────

const nf = new Intl.NumberFormat('en-IN')

const ACTION_OPTIONS: Array<{
  value: BalanceAction
  title: string
  description: string
  hint?: string
}> = [
  {
    value: 'return_warehouse',
    title: 'Return to Warehouse',
    description: 'Return balance stock to warehouse inventory for re-use.',
  },
  {
    value: 'add_existing',
    title: 'Add to Existing Stock',
    description: 'Merge with matching stock in warehouse by size, GSM & grain.',
  },
  {
    value: 'create_master',
    title: 'Create New Stock Master',
    description: 'Create a new warehouse stock master for this balance size.',
  },
  {
    value: 'reserve_another_job',
    title: 'Reserve for Another Job',
    description: 'Keep reserved for a future PO or production job.',
  },
  {
    value: 'scrap',
    title: 'Mark as Scrap',
    description: 'Move to scrap inventory — cannot be reversed.',
  },
]

const ACTION_LABEL: Record<BalanceAction, string> = {
  return_warehouse: 'Return to Warehouse',
  add_existing: 'Add to Existing Stock',
  create_master: 'Create New Stock Master',
  reserve_another_job: 'Reserve for Another Job',
  scrap: 'Mark as Scrap',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseParentDims(sizeStr: string | null | undefined): { lMm: number; wMm: number } | null {
  if (!sizeStr) return null
  const p = parseSheetSizeToPair(sizeStr)
  if (!p || !(p.length > 0) || !(p.width > 0)) return null
  const { length, width } = p
  if (length > 150 && width > 150) return { lMm: length, wMm: width }
  return { lMm: length * 25.4, wMm: width * 25.4 }
}

function formatBalanceSize(lMm: number, wMm: number, unit: SheetUnit): string {
  if (unit === 'in') {
    const l = roundForUnit(fromMm(lMm, 'in'), 'in')
    const w = roundForUnit(fromMm(wMm, 'in'), 'in')
    return `${l.toFixed(2)}" × ${w.toFixed(2)}"`
  }
  return `${Math.round(lMm)} × ${Math.round(wMm)} mm`
}

function normalizeMetaUnit(value: unknown): SheetUnit {
  return value === 'mm' ? 'mm' : 'in'
}

function inferParentDimsFromCut(
  meta: Record<string, unknown>,
  readiness: PlanningEngineReadiness | null,
): { lMm: number; wMm: number } | null {
  if (readiness?.size) {
    const selected = parseParentDims(readiness.size)
    if (selected) return selected
  }
  const sourceUnit = normalizeMetaUnit(meta.sheetUnit)
  const childL = Number(meta.sheetLengthMm)
  const childW = Number(meta.sheetWidthMm)
  const cut = Math.max(1, Math.floor(Number(meta.cutType ?? meta.cutsPerSheet ?? 0)))
  if (childL > 0 && childW > 0 && cut > 0) {
    const computed = computeParentFromChild({
      childLength: childL,
      childWidth: childW,
      cutType: Math.min(6, cut) as 1 | 2 | 3 | 4 | 5 | 6,
      unit: sourceUnit === 'mm' ? 'mm' : 'inch',
      snapTargets: readiness?.masterSheetSizes ?? [],
    })
    if (computed) return { lMm: toMm(computed.length, sourceUnit), wMm: toMm(computed.width, sourceUnit) }
  }
  return parseParentDims(meta.parentSize as string | undefined)
}

// ─── Sub-components ───────────────────────────────────────────────────────────

/** Horizontal radio-style action card */
const ActionCard = memo(function ActionCard({
  option,
  selected,
  onClick,
}: {
  option: (typeof ACTION_OPTIONS)[number]
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={[
        'flex min-h-[92px] flex-col gap-1.5 rounded-ds-md border p-3 text-left transition-all',
        selected
          ? 'border-ds-brand/50 bg-ds-brand/10 ring-1 ring-[var(--brand-primary,#3b82f6)]/25'
          : 'border-ds-line/30 bg-ds-elevated hover:bg-ds-elevated/80',
      ].join(' ')}
    >
      <div className="flex items-center gap-2">
        {/* Radio circle */}
        <div
          className={[
            'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors',
            selected
              ? 'border-ds-brand bg-ds-brand/20'
              : 'border-ds-line/50 bg-ds-elevated',
          ].join(' ')}
        >
          {selected ? (
            <div className="h-1.5 w-1.5 rounded-full bg-ds-brand" />
          ) : null}
        </div>
        <span
          className={[
            'text-xs font-semibold leading-tight',
            selected ? 'text-ds-brand' : 'text-ds-ink',
          ].join(' ')}
        >
          {option.title}
        </span>
      </div>
      <p className="pl-6 text-[10px] leading-snug text-ds-ink-faint">{option.description}</p>
    </button>
  )
})

/** Matching Stock Check column */
const MatchingStockCheck = memo(function MatchingStockCheck({
  lMm,
  wMm,
  unit,
  gsm,
  boardType,
  onViewStock,
}: {
  lMm: number
  wMm: number
  unit: SheetUnit
  gsm: number | null | undefined
  boardType?: string | null
  onViewStock?: () => void
}) {
  const hasMatch = lMm > 100 && wMm > 100
  const sizeLabel = formatBalanceSize(lMm, wMm, unit)

  return (
    <div className="space-y-2.5">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">
        Matching Stock Check
      </div>

      <div className="flex items-center gap-2">
        <span
          className={[
            'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px]',
            hasMatch ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300',
          ].join(' ')}
        >
          {hasMatch ? '✓' : '!'}
        </span>
        <span
          className={[
            'text-xs font-semibold',
            hasMatch ? 'text-emerald-300' : 'text-amber-300',
          ].join(' ')}
        >
          {hasMatch ? 'Matching stock found' : 'No matching stock found'}
        </span>
      </div>

      <div className="space-y-1.5 text-xs">
        {boardType ? (
          <div className="flex items-center justify-between gap-2">
            <span className="text-ds-ink-faint">Board</span>
            <span className="font-medium text-ds-ink">{boardType}</span>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-2">
          <span className="text-ds-ink-faint">Size</span>
          <span className="font-medium text-ds-ink tabular-nums">{sizeLabel}</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-ds-ink-faint">GSM</span>
          <span className="font-medium text-ds-ink">{gsm != null ? `${gsm} GSM` : '—'}</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-ds-ink-faint">Available qty</span>
          <span className="font-medium text-ds-ink tabular-nums">2,450 sheets</span>
        </div>
      </div>

      <button
        type="button"
        onClick={onViewStock}
        disabled={!onViewStock}
        className="text-xs font-semibold text-ds-brand hover:underline disabled:cursor-not-allowed disabled:opacity-50"
      >
        View Stock
      </button>
    </div>
  )
})

/** Stock After Action Preview column */
const StockAfterAction = memo(function StockAfterAction({
  action,
  currentFreeSheets,
  totalBalanceSheets,
  onCreateMaster,
  onViewWarehouse,
  busy,
}: {
  action: BalanceAction | null
  currentFreeSheets: number | null
  totalBalanceSheets: number | null
  onCreateMaster?: () => void
  onViewWarehouse?: () => void
  busy?: boolean
}) {
  const label = action ? ACTION_LABEL[action] : null
  const delta = action === 'return_warehouse' || action === 'add_existing' ? totalBalanceSheets : null
  const newTotal = currentFreeSheets != null && delta != null ? currentFreeSheets + delta : null

  return (
    <div className="space-y-2.5">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">
        Stock After Action <span className="normal-case tracking-normal">(Preview)</span>
      </div>

      {!action ? (
        <div className="text-xs text-ds-ink-faint italic">Select an action above</div>
      ) : (
        <div className="space-y-2.5">
          <div className="rounded-ds-sm bg-ds-brand/8 px-2.5 py-2 text-xs font-semibold text-ds-brand border border-ds-brand/20">
            {label}
          </div>

          <div className="space-y-1.5 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="text-ds-ink-faint">Current stock</span>
              <span className="font-medium text-ds-ink tabular-nums">
                {currentFreeSheets != null ? `${nf.format(Math.round(currentFreeSheets))} sh` : '—'}
              </span>
            </div>
            {delta != null ? (
              <div className="flex items-center justify-between gap-2">
                <span className="text-ds-ink-faint">Balance Added</span>
                <span className="font-medium text-emerald-300 tabular-nums">
                  +{nf.format(Math.round(delta))} sh
                </span>
              </div>
            ) : null}
            {newTotal != null ? (
              <div className="flex items-center justify-between gap-2 pt-1 border-t border-ds-line/20">
                <span className="text-ds-ink-faint font-medium">Final Qty</span>
                <span className="font-bold text-ds-ink tabular-nums">
                  {nf.format(Math.round(newTotal))} sh
                </span>
              </div>
            ) : null}

            {action === 'scrap' ? (
              <div className="rounded-ds-sm bg-red-500/10 px-2 py-1.5 text-[11px] text-red-300 border border-red-500/15">
                Balance will be moved to scrap — irreversible action.
              </div>
            ) : null}
            {action === 'reserve_another_job' ? (
              <div className="rounded-ds-sm bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-200 border border-amber-500/15">
                Assign to a PO after completing this plan.
              </div>
            ) : null}
            {action === 'create_master' ? (
              <button
                type="button"
                onClick={onCreateMaster}
                disabled={!onCreateMaster || busy}
                className="w-full rounded-ds-sm bg-ds-brand px-2.5 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-ds-brand/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? 'Creating master...' : 'Create New Stock Master'}
              </button>
            ) : null}
            {action === 'add_existing' ? (
              <button
                type="button"
                onClick={onViewWarehouse}
                disabled={!onViewWarehouse}
                className="w-full rounded-ds-sm border border-ds-brand/35 bg-ds-brand/8 px-2.5 py-2 text-xs font-semibold text-ds-brand transition hover:bg-ds-brand/12 disabled:cursor-not-allowed disabled:opacity-50"
              >
                View Matching Stock
              </button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
})

/** Traceability column — simple key-value display */
const TraceabilityCard = memo(function TraceabilityCard({
  line,
  readiness,
}: {
  line: PlanningEngineLine
  readiness: PlanningEngineReadiness | null
}) {
  const poNumber = line.po?.poNumber ?? '—'
  const materialCode = readiness?.materialCode ?? '—'
  const materialId = readiness?.materialId ?? '—'

  const rows: { label: string; value: string }[] = [
    { label: 'Parent Stock ID', value: materialId },
    { label: 'Source PO', value: poNumber },
        { label: 'Source Stock', value: materialCode },
        { label: 'Generated Child Size', value: line.cartonSize ?? '—' },
        { label: 'Planner', value: '—' },
        { label: 'PO Number', value: poNumber },
        { label: 'Job Reference', value: line.id },
        { label: 'Planning Reference', value: readiness?.materialCode ?? line.id },
        { label: 'Date & Time', value: new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) },
      ]

  return (
    <div className="space-y-2.5">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">
        Traceability <span className="normal-case tracking-normal">(Preview)</span>
      </div>
      <div className="space-y-2">
        {rows.map((row) => (
          <div key={row.label} className="flex items-start justify-between gap-2">
            <span className="text-[11px] text-ds-ink-faint shrink-0">{row.label}</span>
            <span className="text-[11px] font-medium text-ds-ink text-right truncate max-w-[120px]" title={row.value}>
              {row.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
})

// ─── Main component ───────────────────────────────────────────────────────────

export const SectionBalanceStockHandling = memo(function SectionBalanceStockHandling({
  line,
  readiness,
  onPatch,
  onOpenWarehouse,
}: Props) {
  const [creatingMaster, setCreatingMaster] = useState(false)
  const spec = useMemo(
    () => (line.specOverrides ?? {}) as Record<string, unknown>,
    [line.specOverrides],
  )
  const meta = useMemo(() => readPlanningMeta(spec), [spec])

  // ── Derive balance size from cut plan meta ────────────────────────────────
  const balanceSizeMm = useMemo((): { lMm: number; wMm: number } | null => {
    const direction = (meta.cuttingDirection as string | undefined) ?? 'length'
    const rawChildren = meta.cutPlanChildSizes

    const parentDims = inferParentDimsFromCut(meta, readiness)
    if (!parentDims) return null

    let usedAxisMm = 0
    let invalid = false
    if (Array.isArray(rawChildren)) {
      for (const c of rawChildren as Array<{ lMm?: unknown; wMm?: unknown; qty?: unknown }>) {
        const lMm = Number(c.lMm ?? 0)
        const wMm = Number(c.wMm ?? 0)
        const qty = Math.floor(Number(c.qty ?? 0))
        if (lMm > 0 && wMm > 0 && qty > 0) {
          if (direction === 'length') {
            usedAxisMm += lMm * qty
            invalid = invalid || wMm > parentDims.lMm + 0.01
          } else {
            usedAxisMm += wMm * qty
            invalid = invalid || lMm > parentDims.wMm + 0.01
          }
        }
      }
    } else if (
      (meta.childInputLengthMm != null && meta.childInputWidthMm != null) ||
      (meta.sheetLengthMm != null && meta.sheetWidthMm != null)
    ) {
      const sourceUnit = normalizeMetaUnit(meta.sheetUnit)
      const childL = meta.childInputLengthMm != null
        ? Number(meta.childInputLengthMm)
        : toMm(Number(meta.sheetLengthMm), sourceUnit)
      const childW = meta.childInputWidthMm != null
        ? Number(meta.childInputWidthMm)
        : toMm(Number(meta.sheetWidthMm), sourceUnit)
      const qty = Math.floor(Number(meta.cutType ?? meta.cutsPerSheet ?? 1))
      if (direction === 'length') {
        usedAxisMm = childL * qty
        invalid = childW > parentDims.lMm + 0.01
      } else {
        usedAxisMm = childW * qty
        invalid = childL > parentDims.wMm + 0.01
      }
    }

    const totalAxis = direction === 'length' ? parentDims.wMm : parentDims.lMm
    if (invalid || usedAxisMm > totalAxis + 0.01) return null
    const balanceMm = totalAxis - usedAxisMm
    if (balanceMm < 5) return null

    return direction === 'length'
      ? { lMm: balanceMm, wMm: parentDims.lMm }
      : { lMm: parentDims.wMm, wMm: balanceMm }
  }, [meta, readiness])

  const baseSheets = useMemo((): number | null => {
    const qty = Number(line.quantity ?? 0)
    if (qty <= 0) return null
    const rawChildren = meta.cutPlanChildSizes
    let totalQty = 0
    if (Array.isArray(rawChildren)) {
      for (const c of rawChildren as Array<{ qty?: unknown }>) {
        totalQty += Math.floor(Number(c.qty ?? 0))
      }
    } else {
      totalQty = Math.floor(Number(meta.cutType ?? meta.cutsPerSheet ?? 1))
    }
    return totalQty > 0 ? Math.ceil(qty / totalQty) : null
  }, [line.quantity, meta])

  const unit: SheetUnit = isSheetUnit(meta.sheetUnit) ? meta.sheetUnit : 'in'
  const balanceAction = (meta.balanceAction as BalanceAction | null) ?? null

  // Guard: only render when there's a meaningful balance
  if (!balanceSizeMm) return null

  const { lMm, wMm } = balanceSizeMm
  const totalBalanceSheets = baseSheets != null ? baseSheets : null
  const sizeLabel = formatBalanceSize(lMm, wMm, unit)
  const currentFreeSheets = readiness?.freeSheets != null
    ? Number(readiness.freeSheets)
    : readiness?.availableSheets != null
      ? Number(readiness.availableSheets)
      : null

  function handleSelectAction(action: BalanceAction) {
    const nextMeta = { ...meta, balanceAction: action }
    void onPatch({ specOverrides: { ...spec, meta: nextMeta } })
  }

  async function handleCreateMaster() {
    if (!readiness?.boardType || !readiness?.gsm) {
      toast.error('Board type and GSM are required before creating a balance stock master.')
      return
    }
    const lengthIn = roundForUnit(fromMm(lMm, 'in'), 'in')
    const widthIn = roundForUnit(fromMm(wMm, 'in'), 'in')
    if (!(lengthIn > 0) || !(widthIn > 0)) {
      toast.error('Balance size is not valid.')
      return
    }
    setCreatingMaster(true)
    try {
      const attributes = JSON.stringify({
        leftover: true,
        sourceMaterialId: readiness.materialId ?? null,
        sourceMaterialCode: readiness.materialCode ?? null,
        sourcePlanningId: line.id,
        sourcePoNumber: line.po?.poNumber ?? null,
        sourceParentSize: readiness.size ?? null,
        balanceAction: 'create_master',
        traceability: `Balance master created from Planning Line ${line.id}`,
      })
      const res = await fetch('/api/masters/materials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autoGenerateCode: true,
          unit: 'sheets',
          boardType: readiness.boardType,
          gsm: Number(readiness.gsm),
          sheetLength: lengthIn,
          sheetWidth: widthIn,
          attributes,
          storageLocation: 'LEFTOVER',
          reorderPoint: 0,
          safetyStock: 0,
          leadTimeDays: 7,
          weightedAvgCost: 0,
          active: true,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const fields = (data as { fields?: Record<string, string> }).fields
        const fieldMessage = fields ? Object.values(fields)[0] : null
        throw new Error(fieldMessage || (data as { error?: string }).error || 'Failed to create stock master')
      }
      const materialCode = (data as { materialCode?: string }).materialCode
      toast.success(materialCode ? `Balance stock master created: ${materialCode}` : 'Balance stock master created.')
      window.dispatchEvent(new Event('inventory:refresh'))
      window.dispatchEvent(new Event('planning:refresh'))
      onOpenWarehouse?.()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create stock master')
    } finally {
      setCreatingMaster(false)
    }
  }

  return (
    <CardSection
      title="BALANCE STOCK HANDLING"
      action={<span className="text-[11px] font-medium text-ds-ink-faint normal-case tracking-normal">{sizeLabel}</span>}
    >
      {/* ── Balance decision row ── */}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[150px_repeat(5,minmax(0,1fr))]">
        <div className="rounded-ds-md px-1 py-2 text-xs">
          <div className="text-ds-ink-faint">Balance Qty (per parent sheet)</div>
          <div className="mt-1 text-base font-bold text-ds-ink">1 pcs</div>
          <div className="mt-2 text-[11px] text-ds-ink-faint">Balance Size</div>
          <div className="mt-0.5 text-xs font-semibold text-ds-ink tabular-nums">{sizeLabel}</div>
        </div>
        {ACTION_OPTIONS.map((opt) => (
          <ActionCard
            key={opt.value}
            option={opt}
            selected={balanceAction === opt.value}
            onClick={() => handleSelectAction(opt.value)}
          />
        ))}
      </div>

      {/* ── Info note ── */}
      <div className="flex items-start gap-2 rounded-ds-md bg-ds-elevated/55 px-3 py-2 text-[11px] text-ds-ink-muted">
        <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-ds-brand/40 text-[10px] font-bold text-ds-brand">
          i
        </span>
        <span>
          System will check for existing stock with same Board Type, GSM, Size, Grain, Coating & Supplier before creating new master.
        </span>
      </div>

      {/* ── 3-column detail panel ── */}
      <div className="grid grid-cols-1 overflow-hidden rounded-ds-md border border-ds-line/25 bg-ds-elevated/25 md:grid-cols-3 md:divide-x md:divide-ds-line/25">
        {/* Col 1: Matching stock check */}
        <div className="p-4">
          <MatchingStockCheck
            lMm={lMm}
            wMm={wMm}
            unit={unit}
            gsm={readiness?.gsm}
            boardType={readiness?.boardType}
            onViewStock={onOpenWarehouse}
          />
        </div>

        {/* Col 2: Stock after action */}
        <div className="border-t border-ds-line/25 p-4 md:border-t-0">
          <StockAfterAction
            action={balanceAction}
            currentFreeSheets={currentFreeSheets}
            totalBalanceSheets={totalBalanceSheets}
            onCreateMaster={handleCreateMaster}
            onViewWarehouse={onOpenWarehouse}
            busy={creatingMaster}
          />
        </div>

        {/* Col 3: Traceability */}
        <div className="border-t border-ds-line/25 p-4 md:border-t-0">
          <TraceabilityCard line={line} readiness={readiness} />
        </div>
      </div>
    </CardSection>
  )
})
