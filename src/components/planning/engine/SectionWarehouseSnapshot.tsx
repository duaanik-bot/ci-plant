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
  if (!readiness?.materialId) return null

  const total = Math.max(0, Number(readiness.availableSheets ?? 0))
  const reserved = Math.max(0, Number(readiness.reservedSheets ?? 0))
  const free = Math.max(0, Number(readiness.freeSheets ?? Math.max(0, total - reserved)))
  const required = Math.max(0, Number(readiness.requiredSheets ?? 0))
  const shortage = Math.max(0, Number(readiness.shortageSheets ?? 0))

  const fillPct = total > 0 ? Math.min(100, Math.round((free / total) * 100)) : 0
  const covered = shortage <= 0 && required > 0

  return (
    <div className="rounded-ds-md bg-ds-elevated/50 p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-ds-ink-faint">
          Warehouse Snapshot
        </div>
        <span
          className={[
            'text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full',
            covered
              ? 'bg-emerald-500/10 text-emerald-300'
              : 'bg-red-500/10 text-red-300',
          ].join(' ')}
        >
          {covered ? 'Covered' : 'Shortage'}
        </span>
      </div>

      {/* KPI grid */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="flex items-center gap-1.5 text-ds-ink-faint">
            <span className="h-1.5 w-1.5 rounded-full bg-ds-ink-faint/50 shrink-0" />
            Total Stock
          </span>
          <span className="font-semibold text-ds-ink tabular-nums">{fmt(total)} sh</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="flex items-center gap-1.5 text-ds-ink-faint">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500/70 shrink-0" />
            Reserved
          </span>
          <span className="font-semibold text-amber-300 tabular-nums">{fmt(reserved)} sh</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="flex items-center gap-1.5 text-ds-ink-faint">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500/70 shrink-0" />
            Free Stock
          </span>
          <span className="font-semibold text-emerald-300 tabular-nums">{fmt(free)} sh</span>
        </div>
        {required > 0 ? (
          <div className="flex items-center justify-between text-xs border-t border-ds-line/20 pt-2 mt-2">
            <span className="flex items-center gap-1.5 text-ds-ink-faint">
              <span
                className={[
                  'h-1.5 w-0.5 shrink-0 rounded-full',
                  covered ? 'bg-emerald-400/70' : 'bg-red-400/70',
                ].join(' ')}
              />
              Required
            </span>
            <span
              className={[
                'font-semibold tabular-nums',
                covered ? 'text-emerald-300' : 'text-red-300',
              ].join(' ')}
            >
              {fmt(required)} sh
            </span>
          </div>
        ) : null}
      </div>

      {/* Progress bar */}
      {total > 0 ? (
        <div className="mt-3">
          <div className="flex items-center justify-between text-[10px] text-ds-ink-faint mb-1">
            <span>Free availability</span>
            <span className="tabular-nums">{fillPct}%</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-ds-elevated overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{
                width: `${fillPct}%`,
                background: fillPct >= 60
                  ? 'rgba(52,211,153,0.7)'
                  : fillPct >= 30
                    ? 'rgba(251,191,36,0.7)'
                    : 'rgba(248,113,113,0.7)',
              }}
            />
          </div>
          {/* Reserved segment overlay */}
          <div className="mt-1 flex items-center gap-3 text-[10px] text-ds-ink-faint">
            <span className="flex items-center gap-1">
              <span className="h-1 w-2 rounded-full bg-emerald-500/60" />
              Free
            </span>
            <span className="flex items-center gap-1">
              <span className="h-1 w-2 rounded-full bg-amber-500/60" />
              Reserved
            </span>
          </div>
        </div>
      ) : null}

      {/* Incoming / PR */}
      {readiness.prId ? (
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
