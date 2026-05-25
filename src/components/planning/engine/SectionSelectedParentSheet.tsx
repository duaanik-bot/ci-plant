'use client'

import { memo } from 'react'
import type { PlanningEngineReadiness } from './types'

// ─── Types ────────────────────────────────────────────────────────────────────

type Props = {
  readiness: PlanningEngineReadiness | null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const nf = new Intl.NumberFormat('en-IN')

function fmt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return nf.format(Math.round(n))
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Compact KPI strip shown between Board Allocation and Cut Plan & Layout
 * whenever a board material is linked. Gives the planner a clear "you are
 * cutting from this board" confirmation before configuring the cut plan.
 *
 * Returns null when no material is linked (readiness.materialId absent).
 */
export const SectionSelectedParentSheet = memo(function SectionSelectedParentSheet({
  readiness,
}: Props) {
  if (!readiness?.materialId) return null

  const boardLabel = [
    readiness.boardType ?? null,
    readiness.gsm != null ? `${readiness.gsm} GSM` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  const sizeLabel = readiness.size ?? '—'
  const freeSheets = Number(readiness.freeSheets ?? 0)
  const reservedSheets = Number(readiness.reservedSheets ?? 0)
  const requiredSheets = Number(readiness.requiredSheets ?? 0)
  const isCovered = freeSheets >= requiredSheets && requiredSheets > 0

  return (
    <div className="rounded-ds-md bg-emerald-500/[0.06] px-4 py-3">
      {/* Header row */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="inline-block h-2 w-2 shrink-0 rounded-full bg-emerald-400"
            aria-hidden="true"
          />
          <span className="text-[11px] font-semibold uppercase tracking-wider text-emerald-300">
            Selected Parent Sheet
          </span>
        </div>
        {readiness.materialCode ? (
          <span className="text-[11px] font-mono text-ds-ink-faint tabular-nums">
            {readiness.materialCode}
          </span>
        ) : null}
      </div>

      {/* Board + size */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 mb-2.5">
        <span className="text-sm font-semibold text-ds-ink">{boardLabel || '—'}</span>
        <span className="text-xs text-ds-ink-muted tabular-nums">{sizeLabel}</span>
      </div>

      {/* Stock KPIs */}
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs tabular-nums">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-emerald-500/70" />
          <span className="text-ds-ink-faint">Free</span>
          <span className="font-semibold text-emerald-300">{fmt(freeSheets)} sh</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-amber-500/70" />
          <span className="text-ds-ink-faint">Reserved</span>
          <span className="font-semibold text-ds-ink">{fmt(reservedSheets)} sh</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className={[
              'inline-block h-2 w-0.5',
              isCovered ? 'bg-emerald-400/70' : 'bg-red-400/70',
            ].join(' ')}
          />
          <span className="text-ds-ink-faint">Required</span>
          <span
            className={[
              'font-semibold',
              isCovered ? 'text-emerald-300' : 'text-red-300',
            ].join(' ')}
          >
            {fmt(requiredSheets)} sh
          </span>
        </span>
      </div>
    </div>
  )
})
