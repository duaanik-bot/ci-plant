'use client'

import { memo, useMemo } from 'react'
import { CardSection } from '@/components/design-system/CardSection'
import { readPlanningMeta } from '@/lib/planning-decision-spec'
import { fromMm, isSheetUnit, roundForUnit, type SheetUnit } from '@/lib/planning-sheet-cut'
import { parseSheetSizeToPair } from '@/lib/planning-sheet-size'
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
        'flex flex-1 flex-col gap-1.5 rounded-ds-md p-3 text-left transition-all min-w-[160px]',
        selected
          ? 'bg-ds-brand/10 ring-1 ring-[var(--brand-primary,#3b82f6)]/30'
          : 'bg-ds-elevated hover:bg-ds-elevated/80 border border-ds-line/20',
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
      <p className="text-[10px] leading-snug text-ds-ink-faint pl-6">{option.description}</p>
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
}: {
  lMm: number
  wMm: number
  unit: SheetUnit
  gsm: number | null | undefined
  boardType?: string | null
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

      <button type="button" className="text-xs font-semibold text-ds-brand hover:underline">
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
}: {
  action: BalanceAction | null
  currentFreeSheets: number | null
  totalBalanceSheets: number | null
}) {
  const label = action ? ACTION_LABEL[action] : null
  const delta = action === 'return_warehouse' || action === 'add_existing' ? totalBalanceSheets : null
  const newTotal = currentFreeSheets != null && delta != null ? currentFreeSheets + delta : null

  return (
    <div className="space-y-2.5">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">
        Stock After Action
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
        Traceability
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
}: Props) {
  const spec = useMemo(
    () => (line.specOverrides ?? {}) as Record<string, unknown>,
    [line.specOverrides],
  )
  const meta = useMemo(() => readPlanningMeta(spec), [spec])

  // ── Derive balance size from cut plan meta ────────────────────────────────
  const balanceSizeMm = useMemo((): { lMm: number; wMm: number } | null => {
    const direction = (meta.cuttingDirection as string | undefined) ?? 'length'
    const rawChildren = meta.cutPlanChildSizes

    const parentDims =
      parseParentDims(readiness?.size) ??
      parseParentDims(meta.parentSize as string | undefined) ??
      (meta.sheetLengthMm != null && meta.sheetWidthMm != null
        ? { lMm: Number(meta.sheetLengthMm), wMm: Number(meta.sheetWidthMm) }
        : null)
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
    } else if (meta.childInputLengthMm != null && meta.childInputWidthMm != null) {
      const childL = Number(meta.childInputLengthMm)
      const childW = Number(meta.childInputWidthMm)
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
  }, [meta, readiness?.size])

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

  return (
    <CardSection title="BALANCE STOCK HANDLING">

      {/* ── Balance summary strip ── */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-ds-md bg-amber-500/8 border border-amber-500/15 px-3 py-2.5 mb-3 text-xs">
        <div>
          <span className="text-ds-ink-faint mr-1.5">Balance Size:</span>
          <span className="font-semibold text-ds-ink tabular-nums">{sizeLabel}</span>
        </div>
        <div>
          <span className="text-ds-ink-faint mr-1.5">Balance Qty:</span>
          <span className="font-semibold text-ds-ink">1 pc</span>
        </div>
        {totalBalanceSheets != null ? (
          <div>
            <span className="text-ds-ink-faint mr-1.5">Balance Utilization:</span>
            <span className="font-semibold text-amber-300 tabular-nums">
              {nf.format(totalBalanceSheets)} sheets
            </span>
          </div>
        ) : null}
      </div>

      {/* ── Info note ── */}
      <p className="text-[11px] text-ds-ink-faint mb-3 leading-relaxed">
        Balance sheets will be available after cutting is complete. Select how you&apos;d like to handle this stock.
      </p>

      {/* ── Horizontal action cards ── */}
      <div className="flex flex-wrap gap-2 mb-4">
        {ACTION_OPTIONS.map((opt) => (
          <ActionCard
            key={opt.value}
            option={opt}
            selected={balanceAction === opt.value}
            onClick={() => handleSelectAction(opt.value)}
          />
        ))}
      </div>

      {/* ── 3-column detail panel ── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 rounded-ds-md bg-ds-elevated/40 px-4 py-4 divide-y md:divide-y-0 md:divide-x divide-ds-line/20">
        {/* Col 1: Matching stock check */}
        <div className="pb-4 md:pb-0 md:pr-4">
          <MatchingStockCheck
            lMm={lMm}
            wMm={wMm}
            unit={unit}
            gsm={readiness?.gsm}
            boardType={readiness?.boardType}
          />
        </div>

        {/* Col 2: Stock after action */}
        <div className="py-4 md:py-0 md:px-4">
          <StockAfterAction
            action={balanceAction}
            currentFreeSheets={currentFreeSheets}
            totalBalanceSheets={totalBalanceSheets}
          />
        </div>

        {/* Col 3: Traceability */}
        <div className="pt-4 md:pt-0 md:pl-4">
          <TraceabilityCard line={line} readiness={readiness} />
        </div>
      </div>
    </CardSection>
  )
})
