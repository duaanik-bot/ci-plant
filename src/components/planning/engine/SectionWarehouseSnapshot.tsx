'use client'

import { memo } from 'react'
import type { PlanningEngineReadiness } from './types'

// ─── Types ────────────────────────────────────────────────────────────────────

type Props = { readiness: PlanningEngineReadiness | null }

// ─── Helpers ──────────────────────────────────────────────────────────────────

const nf = new Intl.NumberFormat('en-IN')

function fmt(n: number): string {
  return nf.format(Math.round(n))
}

// ─── Component ────────────────────────────────────────────────────────────────

export const SectionWarehouseSnapshot = memo(function SectionWarehouseSnapshot({ readiness }: Props) {
  const required = Math.max(0, Number(readiness?.requiredSheets ?? 0))
  const reserved = Math.max(
    0,
    Number(readiness?.reservedForLine ?? readiness?.reservedSheets ?? 0),
  )
  const netRequirement = Math.max(
    0,
    Number(readiness?.netRequirement ?? Math.max(0, required - reserved)),
  )
  const prQty = Math.max(0, Number(readiness?.prQty ?? 0))

  return (
    <div className="rounded-ds-card bg-[var(--bg-card)] p-4 shadow-ds-depth">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[11px] font-semibold text-ds-brand">
          Warehouse Snapshot
        </div>
        <span className="text-[11px] font-semibold text-ds-brand">View warehouse</span>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint">Net Required</div>
          <div className="mt-1 text-sm font-bold text-ds-ink tabular-nums">{fmt(netRequirement)} sh</div>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint">Reserved</div>
          <div className="mt-1 text-sm font-bold text-ds-ink tabular-nums">{fmt(reserved)} sh</div>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint">PR Raised</div>
          <div className="mt-1 text-sm font-bold text-ds-ink tabular-nums">{fmt(prQty)} sh</div>
        </div>
      </div>
    </div>
  )
})
