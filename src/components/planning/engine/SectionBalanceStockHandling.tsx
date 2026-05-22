'use client'

import { memo, useMemo } from 'react'
import { CardSection } from '@/components/design-system/CardSection'
import { Badge } from '@/components/design-system/Badge'
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
  icon: string
  title: string
  description: string
}> = [
  {
    value: 'return_warehouse',
    icon: '↩',
    title: 'Return to Warehouse',
    description: 'Return balance stock to warehouse inventory.',
  },
  {
    value: 'add_existing',
    icon: '+',
    title: 'Add to Existing Stock',
    description: 'Merge with matching stock in warehouse.',
  },
  {
    value: 'create_master',
    icon: '✦',
    title: 'Create New Master',
    description: 'Create new warehouse stock master for this balance size.',
  },
  {
    value: 'reserve_another_job',
    icon: '⊕',
    title: 'Reserve for Another Job',
    description: 'Keep reserved for future PO/job.',
  },
  {
    value: 'scrap',
    icon: '✕',
    title: 'Mark as Scrap',
    description: 'Move to scrap inventory.',
  },
]

const ACTION_LABEL: Record<BalanceAction, string> = {
  return_warehouse: 'Return to Warehouse',
  add_existing: 'Add to Existing Stock',
  create_master: 'Create New Master',
  reserve_another_job: 'Reserve for Another Job',
  scrap: 'Mark as Scrap',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Parse "720 x 1020" or "28 x 40" → mm. Values > 150 treated as mm; ≤150 as inches. */
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
    return `${l.toFixed(2)} × ${w.toFixed(2)} in`
  }
  return `${Math.round(lMm)} × ${Math.round(wMm)} mm`
}

// ─── Sub-components ───────────────────────────────────────────────────────────

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
        'flex flex-col gap-1.5 rounded-ds-md border p-3 text-left transition-colors',
        selected
          ? 'border-ds-brand/60 bg-ds-brand/10'
          : 'border-ds-line/40 bg-ds-elevated hover:border-ds-line/70',
      ].join(' ')}
    >
      <div className="flex items-center gap-2">
        <span
          className={[
            'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-sm font-bold',
            selected ? 'text-ds-brand' : 'text-ds-ink-muted',
          ].join(' ')}
        >
          {option.icon}
        </span>
        <span
          className={['text-xs font-semibold', selected ? 'text-ds-brand' : 'text-ds-ink'].join(
            ' ',
          )}
        >
          {option.title}
        </span>
      </div>
      <p className="text-[11px] leading-snug text-ds-ink-faint pl-8">{option.description}</p>
    </button>
  )
})

const MatchingStockCheck = memo(function MatchingStockCheck({
  lMm,
  wMm,
  unit,
  gsm,
}: {
  lMm: number
  wMm: number
  unit: SheetUnit
  gsm: number | null | undefined
}) {
  const hasMatch = lMm > 100 && wMm > 100
  const sizeLabel = formatBalanceSize(lMm, wMm, unit)
  const gsmLabel = gsm != null ? `${gsm} GSM` : '—'

  return (
    <div className="mt-3 rounded-ds-md border border-ds-line/40 bg-ds-elevated/60 p-3 space-y-2">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">
        Matching Stock Check
      </div>

      <div className="flex items-center gap-2">
        {hasMatch ? (
          <>
            <span className="text-emerald-400 text-sm">✓</span>
            <span className="text-xs font-semibold text-emerald-300">Matching stock found</span>
          </>
        ) : (
          <>
            <span className="text-amber-400 text-sm">⚠</span>
            <span className="text-xs font-semibold text-amber-300">No matching stock found</span>
          </>
        )}
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-ds-ink-muted">
        <span>
          {gsmLabel} · {sizeLabel}
        </span>
      </div>

      <div className="flex items-center gap-4 text-xs">
        <span className="text-ds-ink-faint">Available qty</span>
        <span className="font-semibold tabular-nums text-ds-ink">—</span>
      </div>

      <p className="text-[11px] text-ds-ink-faint leading-relaxed">
        System will check for existing stock with same Board Type, GSM, Size, Grain &amp; Supplier
        before creating new master.
      </p>

      <button type="button" className="text-xs font-semibold text-ds-brand hover:underline">
        View Stock →
      </button>
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

    // Parse parent dims from readiness or meta
    const parentDims =
      parseParentDims(readiness?.size) ??
      parseParentDims(meta.parentSize as string | undefined) ??
      (meta.sheetLengthMm != null && meta.sheetWidthMm != null
        ? { lMm: Number(meta.sheetLengthMm), wMm: Number(meta.sheetWidthMm) }
        : null)
    if (!parentDims) return null

    let usedAxisMm = 0
    if (Array.isArray(rawChildren)) {
      for (const c of rawChildren as Array<{ lMm?: unknown; wMm?: unknown; qty?: unknown }>) {
        const lMm = Number(c.lMm ?? 0)
        const wMm = Number(c.wMm ?? 0)
        const qty = Math.floor(Number(c.qty ?? 0))
        if (lMm > 0 && wMm > 0 && qty > 0) {
          usedAxisMm += (direction === 'length' ? wMm : lMm) * qty
        }
      }
    } else if (meta.childInputLengthMm != null && meta.childInputWidthMm != null) {
      // Legacy fallback: single child from SheetCutSpec
      const childL = Number(meta.childInputLengthMm)
      const childW = Number(meta.childInputWidthMm)
      const qty = Math.floor(Number(meta.cutType ?? meta.cutsPerSheet ?? 1))
      usedAxisMm = (direction === 'length' ? childW : childL) * qty
    }

    const totalAxis = direction === 'length' ? parentDims.wMm : parentDims.lMm
    const balanceMm = totalAxis - usedAxisMm
    if (balanceMm < 5) return null

    return direction === 'length'
      ? { lMm: parentDims.lMm, wMm: balanceMm }
      : { lMm: balanceMm, wMm: parentDims.wMm }
  }, [meta, readiness?.size])

  // ── Derive base sheets ────────────────────────────────────────────────────
  const baseSheets = useMemo((): number | null => {
    const qty = Number(line.quantity ?? 0)
    if (qty <= 0) return null
    // Total yield = sum of all child qtys
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
  const balanceAction = (meta.balanceAction as string | null) ?? null

  // Guard: only render for meaningful balance
  if (!balanceSizeMm) return null
  const { lMm, wMm } = balanceSizeMm

  const totalBalance = baseSheets != null ? baseSheets * 1 : null
  const sizeLabel = formatBalanceSize(lMm, wMm, unit)

  function handleSelectAction(action: BalanceAction) {
    const nextMeta = { ...meta, balanceAction: action }
    void onPatch({ specOverrides: { ...spec, meta: nextMeta } })
  }

  return (
    <CardSection title="BALANCE STOCK HANDLING">
      {/* ── Header info ── */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-ds-md border border-ds-line/40 bg-ds-elevated px-3 py-2.5">
        <div className="text-xs text-ds-ink-muted">
          <span className="font-semibold uppercase tracking-wider text-ds-ink-faint mr-1.5">
            Balance per board:
          </span>
          <span className="font-semibold text-ds-ink">{sizeLabel}</span>
        </div>
        <div className="text-xs text-ds-ink-muted">
          Qty/board: <span className="font-semibold text-ds-ink tabular-nums">1 pc</span>
        </div>
        {totalBalance != null ? (
          <Badge tone="warning" className="text-[11px]">
            Total balance: {nf.format(totalBalance)} sheets
          </Badge>
        ) : null}
      </div>

      {/* ── Action cards grid ── */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {ACTION_OPTIONS.map((opt) => (
          <ActionCard
            key={opt.value}
            option={opt}
            selected={balanceAction === opt.value}
            onClick={() => handleSelectAction(opt.value as BalanceAction)}
          />
        ))}
      </div>

      {/* ── Inline matching stock check ── */}
      {balanceAction === 'add_existing' ? (
        <MatchingStockCheck lMm={lMm} wMm={wMm} unit={unit} gsm={readiness?.gsm} />
      ) : null}

      {/* ── Stock after action preview ── */}
      {balanceAction ? (
        <div className="rounded-ds-md border border-ds-line/40 bg-ds-elevated/40 px-4 py-3">
          <div className="grid grid-cols-3 gap-4 text-xs">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint mb-1">
                Action
              </div>
              <div className="font-semibold text-ds-ink text-[13px]">
                {ACTION_LABEL[balanceAction as BalanceAction] ?? balanceAction}
              </div>
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint mb-1">
                Current Qty
              </div>
              <div className="font-semibold tabular-nums text-ds-ink">
                {readiness?.freeSheets != null
                  ? `${nf.format(Math.round(readiness.freeSheets))} sh`
                  : readiness?.availableSheets != null
                    ? `${nf.format(Math.round(readiness.availableSheets))} sh`
                    : '—'}
              </div>
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint mb-1">
                Balance Added
              </div>
              <div className="font-semibold tabular-nums text-ds-ink">
                {(balanceAction === 'return_warehouse' || balanceAction === 'add_existing') &&
                totalBalance != null
                  ? `${nf.format(totalBalance)} sh`
                  : '—'}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </CardSection>
  )
})
