'use client'

import { memo, useMemo } from 'react'
import { CardSection } from '@/components/design-system/CardSection'
import { Badge } from '@/components/design-system/Badge'
import { readPlanningMeta, readPlanningCore } from '@/lib/planning-decision-spec'
import { fromMm, isSheetUnit, roundForUnit, type SheetUnit } from '@/lib/planning-sheet-cut'
import { parseSheetSizeToPair } from '@/lib/planning-sheet-size'
import type { PlanningEngineLine, PlanningEngineReadiness } from './types'

// ─── Types ────────────────────────────────────────────────────────────────────

type Props = {
  line: PlanningEngineLine
  readiness: PlanningEngineReadiness | null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const nf = new Intl.NumberFormat('en-IN')

function fmt(n: number | null | undefined, suffix = ''): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return '—'
  return `${nf.format(Math.round(n))}${suffix}`
}

function fmtDim(mm: number, unit: SheetUnit): string {
  if (!(mm > 0)) return '—'
  const v = roundForUnit(fromMm(mm, unit), unit)
  return unit === 'in' ? `${v}"` : `${Math.round(mm)} mm`
}

function parseDims(sizeStr: string | null | undefined): { lMm: number; wMm: number } | null {
  if (!sizeStr) return null
  const pair = parseSheetSizeToPair(sizeStr)
  if (!pair || !(pair.length > 0) || !(pair.width > 0)) return null
  const lMm = pair.length > 150 ? pair.length : pair.length * 25.4
  const wMm = pair.width > 150 ? pair.width : pair.width * 25.4
  return { lMm, wMm }
}

// ─── Sub-component ────────────────────────────────────────────────────────────

const Row = memo(function Row({
  label,
  value,
  valueClass,
  mono,
}: {
  label: string
  value: React.ReactNode
  valueClass?: string
  mono?: boolean
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-1">
      <span className="text-xs text-ds-ink-faint shrink-0 w-36">{label}</span>
      <span
        className={`text-xs font-semibold text-right ${mono ? 'font-mono tabular-nums' : ''} ${valueClass ?? 'text-ds-ink'}`}
      >
        {value ?? '—'}
      </span>
    </div>
  )
})

const SummaryBlock = memo(function SummaryBlock({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-ds-md bg-ds-elevated/50 p-3 space-y-0.5">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint pb-1.5 mb-1">
        {title}
      </div>
      {children}
    </div>
  )
})

// ─── Main component ───────────────────────────────────────────────────────────

/**
 * Read-only consolidated summary of all planning decisions for this line.
 * Renders only when the line has meaningful data (board + cut plan).
 * Intended to sit just above Batch Decision as a pre-lock review card.
 */
export const SectionPlanningSummary = memo(function SectionPlanningSummary({
  line,
  readiness,
}: Props) {
  const spec = useMemo(
    () => (line.specOverrides ?? {}) as Record<string, unknown>,
    [line.specOverrides],
  )
  const meta = useMemo(() => readPlanningMeta(spec), [spec])
  const core = useMemo(() => readPlanningCore(spec), [spec])

  const unit: SheetUnit = isSheetUnit(meta.sheetUnit) ? meta.sheetUnit : 'in'

  // ── Board ─────────────────────────────────────────────────────────────────
  const boardType = (line.paperType ?? readiness?.boardType ?? '').trim() || null
  const gsm = line.gsm ?? readiness?.gsm ?? null
  const parentDims =
    parseDims(readiness?.size) ??
    parseDims(meta.parentSize as string | undefined) ??
    (Number(meta.sheetLengthMm) > 0 && Number(meta.sheetWidthMm) > 0
      ? { lMm: Number(meta.sheetLengthMm), wMm: Number(meta.sheetWidthMm) }
      : null)

  // ── Cut Plan ──────────────────────────────────────────────────────────────
  const direction = (meta.cuttingDirection as string | undefined) ?? 'length'
  const rawChildren = meta.cutPlanChildSizes
  const children = useMemo(() => {
    if (!Array.isArray(rawChildren)) return []
    return (rawChildren as Array<Record<string, unknown>>)
      .map((c) => ({
        lMm: Number(c.lMm ?? 0),
        wMm: Number(c.wMm ?? 0),
        qty: Math.floor(Number(c.qty ?? 0)),
      }))
      .filter((c) => c.lMm > 0 && c.wMm > 0 && c.qty > 0)
  }, [rawChildren])

  const totalQty = children.reduce((a, c) => a + c.qty, 0)
  const cutPlanInvalid = parentDims
    ? direction === 'length'
      ? children.some((c) => c.wMm > parentDims.lMm + 0.01) ||
        children.reduce((a, c) => a + c.lMm * c.qty, 0) > parentDims.wMm + 0.01
      : children.some((c) => c.lMm > parentDims.wMm + 0.01) ||
        children.reduce((a, c) => a + c.wMm * c.qty, 0) > parentDims.lMm + 0.01
    : false
  const makeReady = typeof meta.makeReadySheets === 'number' ? meta.makeReadySheets : 0
  const wastage = typeof meta.wastageSheets === 'number' ? meta.wastageSheets : 150
  const qty = Number(line.quantity ?? 0)
  const baseSheets = !cutPlanInvalid && totalQty > 0 && qty > 0 ? Math.ceil(qty / totalQty) : null
  const totalRequired = baseSheets != null ? baseSheets + makeReady + wastage : null

  // ── Balance ───────────────────────────────────────────────────────────────
  const balanceAction = (meta.balanceAction as string | undefined) ?? null
  const ACTION_LABEL: Record<string, string> = {
    return_warehouse: 'Return to Warehouse',
    add_existing: 'Add to Existing Stock',
    create_master: 'Create New Master',
    reserve_another_job: 'Reserve for Another Job',
    scrap: 'Mark as Scrap',
  }

  // ── Batch ─────────────────────────────────────────────────────────────────
  const batchStatus = (line.batchDecision?.status ?? core.batchStatus ?? null) as string | null
  const layoutType = line.batchDecision?.layoutType ?? (core.layoutType as string | undefined) ?? null
  const locked = !!line.batchDecision?.lockedAt

  // Guard — only render when there's meaningful data
  const hasBoard = !!(boardType || gsm)
  const hasCutPlan = children.length > 0 || totalQty > 0
  if (!hasBoard && !hasCutPlan) return null

  const statusTone = locked
    ? 'success'
    : batchStatus === 'Released'
      ? 'success'
      : batchStatus === 'Hold'
        ? 'danger'
        : 'neutral'

  return (
    <CardSection title="PLANNING SUMMARY">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* ── Board ── */}
        <SummaryBlock title="Board">
          <Row label="Board Type" value={boardType ?? '—'} />
          <Row label="GSM" value={gsm != null ? `${gsm} GSM` : '—'} mono />
          {parentDims ? (
            <Row
              label="Sheet Size"
              value={`${fmtDim(parentDims.lMm, unit)} × ${fmtDim(parentDims.wMm, unit)}`}
              mono
            />
          ) : (
            <Row label="Sheet Size" value="—" />
          )}
          <Row
            label="Stock Status"
            value={
              readiness?.materialId
                ? Number(readiness.shortageSheets ?? 0) > 0
                  ? <span className="text-red-300">Shortage</span>
                  : <span className="text-emerald-300">Covered</span>
                : '—'
            }
          />
        </SummaryBlock>

        {/* ── Cut Plan ── */}
        <SummaryBlock title="Cut Plan">
          <Row
            label="Direction"
            value={direction === 'length' ? 'Length-wise' : 'Width-wise'}
          />
          <Row
            label="Yield (UPS)"
            value={cutPlanInvalid ? <span className="text-red-300">Invalid cut plan</span> : totalQty > 0 ? `${totalQty} pcs / sheet` : '—'}
            mono
          />
          {children.map((c, i) => (
            <Row
              key={i}
              label={`Child ${i + 1}`}
              value={`${fmtDim(c.lMm, unit)} × ${fmtDim(c.wMm, unit)} × ${c.qty}`}
              mono
            />
          ))}
        </SummaryBlock>

        {/* ── Sheet Requirements ── */}
        <SummaryBlock title="Sheet Requirements">
          <Row label="PO Qty" value={qty > 0 ? fmt(qty, ' pcs') : '—'} mono />
          <Row label="Base Sheets" value={baseSheets != null ? fmt(baseSheets, ' sh') : '—'} mono />
          <Row label="Make-ready" value={fmt(makeReady, ' sh')} mono />
          <Row label="Wastage" value={fmt(wastage, ' sh')} mono />
          <Row
            label="Total Required"
            value={
              totalRequired != null ? (
                <span className="text-ds-brand font-bold">{fmt(totalRequired, ' sh')}</span>
              ) : '—'
            }
            mono
          />
        </SummaryBlock>

        {/* ── Balance & Batch ── */}
        <SummaryBlock title="Balance & Batch">
          <Row
            label="Balance Action"
            value={balanceAction ? ACTION_LABEL[balanceAction] ?? balanceAction : '—'}
          />
          <Row
            label="Layout"
            value={layoutType ? layoutType.charAt(0).toUpperCase() + layoutType.slice(1).toLowerCase() : '—'}
          />
          <Row
            label="Status"
            value={
              batchStatus ? (
                <span className="flex items-center justify-end gap-1.5">
                  <Badge tone={statusTone} className="text-[10px]">
                    {locked ? 'Locked' : batchStatus}
                  </Badge>
                </span>
              ) : '—'
            }
          />
          {line.batchDecision?.pressAssignment ? (
            <Row
              label="Press"
              value={line.batchDecision.pressAssignment.code}
              mono
            />
          ) : null}
        </SummaryBlock>
      </div>
    </CardSection>
  )
})
