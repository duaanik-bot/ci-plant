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
  const total = Math.max(0, Number(readiness?.availableSheets ?? 0))
  const reserved = Math.max(0, Number(readiness?.reservedSheets ?? 0))
  const free = Math.max(0, Number(readiness?.freeSheets ?? Math.max(0, total - reserved)))
  const required = Math.max(0, Number(readiness?.requiredSheets ?? 0))
  const shortage = Math.max(0, Number(readiness?.shortageSheets ?? 0))

  const fillPct = total > 0 ? Math.min(100, Math.round((free / total) * 100)) : 0
  const covered = shortage <= 0 && required > 0

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
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint">Total Stock</div>
          <div className="mt-1 text-sm font-bold text-ds-ink tabular-nums">{fmt(total)} sh</div>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint">Reserved</div>
          <div className="mt-1 text-sm font-bold text-ds-ink tabular-nums">{fmt(reserved)} sh</div>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint">Free Stock</div>
          <div className="mt-1 text-sm font-bold text-ds-ink tabular-nums">{fmt(free)} sh</div>
        </div>
      </div>

      <div className="mt-3">
        <div className="h-2 w-full overflow-hidden rounded-full bg-ds-elevated">
          <div
            className="h-full rounded-full transition-all duration-300"
            style={{
              width: `${total > 0 ? fillPct : 0}%`,
              background: covered ? 'rgba(34,197,94,0.85)' : 'rgba(251,191,36,0.85)',
            }}
          />
        </div>
        <div className={['mt-2 text-[11px]', covered ? 'text-emerald-300' : 'text-amber-300'].join(' ')}>
          {covered
            ? 'Covers required sheets.'
            : required > 0
              ? `Required: ${fmt(required)} sh${shortage > 0 ? ` · Shortage: ${fmt(shortage)} sh` : ''}`
              : 'No material selected.'}
        </div>
      </div>

      {/* Incoming / PR */}
      {readiness?.prId ? (
        <div className="mt-3 rounded-ds-sm bg-amber-500/8 px-2.5 py-2 text-[11px] text-amber-200/80 border border-amber-500/15">
          <span className="font-mono">{readiness.prId}</span>
          {readiness.grnEta ? (
            <span className="ml-2 text-amber-200/60">
              ETA {new Date(readiness.grnEta).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
})
